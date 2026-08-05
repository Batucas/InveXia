// ============================================================
//  /api/portfolio-analyze  ·  POST   (premium)
//  Diagnostica la cartera del cliente y propone ajustes según
//  Markowitz, HRP y Core-Satellite, con métricas Sharpe/Sortino/Calmar.
//
//  - Solo para clientes con premium_portfolio = true (verificado en BD).
//  - Requiere perfil de riesgo completado.
//  - Descarga 3 años de históricos diarios (Twelve Data, cacheado).
//
//  Variables: TWELVEDATA_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const ANN = 252, RF = 0.04, YEARS = 3, MC = 25000;
const BAND_SIGMA = { 1: .05, 2: .08, 3: .11, 4: .15, 5: .19 };
const HIST_TTL = 12 * 60 * 60 * 1000;
const HCACHE = new Map(); // symbol -> {at, series:[{d,c}]}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });
  const { TWELVEDATA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!TWELVEDATA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de entorno." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const svc = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  try {
    // --- auth + premium + perfil ---
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();
    const [profile] = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role,premium_portfolio`, { headers: svc }).then(r => r.json());
    const isAdmin = profile?.role === "admin";
    if (!profile?.premium_portfolio && !isAdmin)
      return res.status(403).json({ ok: false, error: "premium", message: "Este servicio no está habilitado en tu cuenta." });
    const [ra] = await fetch(`${SUPABASE_URL}/rest/v1/risk_assessments?user_id=eq.${me.id}&select=final_band,band_label&order=created_at.desc&limit=1`, { headers: svc }).then(r => r.json());
    if (!ra) return res.status(400).json({ ok: false, error: "no_profile", message: "Completa primero tu perfil de riesgo." });

    // --- entrada ---
    const holdings = (req.body?.holdings || []).filter(h => h.symbol);
    const symbols = [...new Set(holdings.map(h => String(h.symbol).toUpperCase().trim()))];
    if (symbols.length < 2) return res.status(400).json({ ok: false, error: "Añade al menos 2 activos." });
    if (symbols.length > 20) return res.status(400).json({ ok: false, error: "Máximo 20 activos." });

    // --- históricos ---
    const series = {}, failed = [];
    await pool(symbols, 4, async (sym) => {
      try { series[sym] = await getHistory(sym, TWELVEDATA_API_KEY); }
      catch { failed.push(sym); }
    });
    const valid = symbols.filter(s => series[s] && series[s].length > 60);
    for (const s of symbols) if (!valid.includes(s) && !failed.includes(s)) failed.push(s);
    if (valid.length < 2)
      return res.status(400).json({ ok: false, error: "data", message: `No hay históricos suficientes. Revisa: ${failed.join(", ") || "símbolos"}.` });

    // --- Core-Satellite define el núcleo; si no lo tienen, traemos su histórico ---
    const cSat = coreSatellite(valid, ra.final_band);
    const coreSym = cSat.coreSym;
    let haveCore = valid.includes(coreSym);
    if (!haveCore) {
      try { series[coreSym] = await getHistory(coreSym, TWELVEDATA_API_KEY); haveCore = series[coreSym].length > 60; } catch { haveCore = false; }
    }
    // universo extendido (holdings + núcleo si se pudo traer)
    const uni = haveCore && !valid.includes(coreSym) ? [...valid, coreSym] : valid;

    // --- alinear por fechas comunes (sobre el universo extendido) ---
    const maps = uni.map(s => new Map(series[s].map(p => [p.d, p.c])));
    let common = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
    if (common.length > YEARS * ANN + 10) common = common.slice(-Math.round(YEARS * ANN));
    if (common.length < 60) return res.status(400).json({ ok: false, error: "data", message: "Muy poco histórico común entre los activos." });

    const pricesAll = uni.map((s, i) => common.map(d => maps[i].get(d)));
    const Rall = []; // T x M (universo)
    for (let t = 1; t < common.length; t++) Rall.push(pricesAll.map(p => p[t] / p[t - 1] - 1));

    // matriz solo de holdings (para actual/Markowitz/HRP)
    const hIdx = valid.map(s => uni.indexOf(s));
    const R = Rall.map(row => hIdx.map(i => row[i]));
    const { mu, C } = covMatrix(R);
    const muAnn = mu.map(m => m * ANN);
    const covAnn = C.map(row => row.map(v => v * ANN));

    // --- pesos actuales ---
    const valById = {}; holdings.forEach(h => { const s = String(h.symbol).toUpperCase().trim(); if (valid.includes(s)) valById[s] = (valById[s] || 0) + (Number(h.value) || 0); });
    const anyVal = Object.values(valById).some(v => v > 0);
    let current = valid.map(s => anyVal ? (valById[s] || 0) : 1);
    const csum = current.reduce((a, b) => a + b, 0); current = current.map(v => v / csum);

    // --- carteras ---
    const cur = portfolioMetrics(R, current);
    const mk = markowitz(muAnn, covAnn, RF, MC);
    const wHRP = hrp(C);
    // Core-Satellite sobre el universo (incluye el núcleo si se añadió)
    const csVec = uni.map(s => cSat.weights[s] || 0);
    const csSum = csVec.reduce((a, b) => a + b, 0) || 1;
    const csNorm = csVec.map(v => v / csSum);

    const pack = (w) => ({ weights: w, metrics: portfolioMetrics(R, w) });
    const band = ra.final_band, bandVol = BAND_SIGMA[band];

    return res.status(200).json({
      ok: true,
      symbols: valid, failed,
      band, bandLabel: ra.band_label, bandVol,
      current: { weights: current, metrics: cur },
      overRisk: cur.annVol > bandVol * 1.15,
      markowitz: { maxSharpe: pack(mk.maxSharpe), minVol: pack(mk.minVol), cloud: mk.cloud },
      hrp: pack(wHRP),
      coreSatellite: {
        symbols: uni, weights: csNorm,
        metrics: portfolioMetrics(Rall, csNorm),
        coreSym, extraCore: cSat.coreAdded ? coreSym : null,
      },
      rf: RF, years: YEARS, points: common.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}

// ---------- históricos (Twelve Data, cacheado) ----------
async function getHistory(symbol, key) {
  const hit = HCACHE.get(symbol);
  if (hit && Date.now() - hit.at < HIST_TTL) return hit.series;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${YEARS * ANN + 30}&apikey=${key}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status === "error" || !Array.isArray(d.values)) throw new Error(d.message || "sin datos");
  const series = d.values.map(v => ({ d: v.datetime, c: parseFloat(v.close) })).filter(p => isFinite(p.c)).reverse();
  HCACHE.set(symbol, { at: Date.now(), series });
  return series;
}
async function pool(items, n, fn) {
  const q = [...items]; const workers = Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  });
  await Promise.all(workers);
}

// ============================================================
//  Núcleo cuantitativo (validado por separado)
// ============================================================
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const quad = (w, M) => { let s = 0; for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) s += w[i] * M[i][j] * w[j]; return s; };
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const std = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

function covMatrix(R) {
  const T = R.length, N = R[0].length, mu = Array(N).fill(0);
  for (const row of R) for (let i = 0; i < N; i++) mu[i] += row[i] / T;
  const C = Array.from({ length: N }, () => Array(N).fill(0));
  for (const row of R) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i][j] += (row[i] - mu[i]) * (row[j] - mu[j]);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i][j] /= (T - 1);
  return { mu, C };
}
const corrFromCov = C => C.map((row, i) => row.map((v, j) => v / Math.sqrt(C[i][i] * C[j][j])));

function portfolioMetrics(R, w, rf = RF) {
  const rp = R.map(row => dot(row, w));
  const m = mean(rp), sd = std(rp);
  const annRet = m * ANN, annVol = sd * Math.sqrt(ANN);
  const dn = Math.sqrt(mean(rp.map(x => x < 0 ? x * x : 0))) * Math.sqrt(ANN);
  let peak = -Infinity, eq = 1, mdd = 0;
  for (const r of rp) { eq *= (1 + r); peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  return { annReturn: annRet, annVol, sharpe: annVol ? (annRet - rf) / annVol : 0, sortino: dn ? (annRet - rf) / dn : 0, maxDrawdown: mdd, calmar: mdd ? annRet / Math.abs(mdd) : 0 };
}
function markowitz(muAnn, covAnn, rf = RF, N = 25000) {
  const n = muAnn.length; let bestSh = -Infinity, wSh = null, minV = Infinity, wMv = null; const cloud = [];
  for (let s = 0; s < N; s++) {
    const w = Array(n); let sum = 0;
    for (let i = 0; i < n; i++) { const e = -Math.log(Math.random() || 1e-12); w[i] = e; sum += e; }
    for (let i = 0; i < n; i++) w[i] /= sum;
    const ret = dot(w, muAnn), vol = Math.sqrt(quad(w, covAnn)), sh = (ret - rf) / vol;
    if (sh > bestSh) { bestSh = sh; wSh = w.slice(); }
    if (vol < minV) { minV = vol; wMv = w.slice(); }
    if (s % 25 === 0 && cloud.length < 900) cloud.push([+vol.toFixed(4), +ret.toFixed(4)]);
  }
  return { maxSharpe: wSh, minVol: wMv, cloud };
}
function linkageSingle(dist) {
  const N = dist.length, active = []; for (let i = 0; i < N; i++) active.push({ id: i, m: [i] });
  const link = []; let nextId = N;
  const cdist = (a, b) => { let x = Infinity; for (const i of a.m) for (const j of b.m) if (dist[i][j] < x) x = dist[i][j]; return x; };
  while (active.length > 1) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) { const d = cdist(active[i], active[j]); if (d < best) { best = d; bi = i; bj = j; } }
    const A = active[bi], B = active[bj];
    link.push([A.id, B.id, best]); active.splice(bj, 1); active.splice(bi, 1); active.push({ id: nextId++, m: [...A.m, ...B.m] });
  }
  return link;
}
function quasiDiag(link, N) {
  let order = [link[link.length - 1][0], link[link.length - 1][1]];
  while (order.some(i => i >= N)) { const nx = []; for (const i of order) { if (i < N) nx.push(i); else { const r = link[i - N]; nx.push(r[0], r[1]); } } order = nx; }
  return order;
}
function clusterVar(C, items) {
  const ivp = items.map(i => 1 / C[i][i]); const s = ivp.reduce((a, b) => a + b, 0); const w = ivp.map(v => v / s);
  let v = 0; for (let a = 0; a < items.length; a++) for (let b = 0; b < items.length; b++) v += w[a] * w[b] * C[items[a]][items[b]];
  return v;
}
function hrp(C) {
  const N = C.length; if (N === 1) return [1];
  const corr = corrFromCov(C);
  const dist = corr.map(row => row.map(c => Math.sqrt(Math.max(0, 0.5 * (1 - c)))));
  const link = linkageSingle(dist), order = quasiDiag(link, N), w = Array(N).fill(1);
  let clusters = [order];
  while (clusters.length) {
    const nc = [];
    for (const items of clusters) {
      if (items.length <= 1) continue;
      const half = Math.floor(items.length / 2), c0 = items.slice(0, half), c1 = items.slice(half);
      const v0 = clusterVar(C, c0), v1 = clusterVar(C, c1), alpha = 1 - v0 / (v0 + v1);
      for (const i of c0) w[i] *= alpha; for (const i of c1) w[i] *= (1 - alpha);
      nc.push(c0, c1);
    }
    clusters = nc;
  }
  return w;
}
const BROAD = new Set(["SPY", "VOO", "VTI", "IVV", "SPLG", "SCHB", "ITOT"]);
function coreSatellite(symbols, band) {
  const coreTarget = { 1: .85, 2: .75, 3: .65, 4: .55, 5: .45 }[band] || .65;
  const heldCore = symbols.filter(s => BROAD.has(s)), coreSym = heldCore[0] || "SPY";
  const satellites = symbols.filter(s => !BROAD.has(s) && s !== coreSym);
  const w = {}; w[coreSym] = coreTarget; const cap = 0.12;
  let satW = satellites.map(() => (1 - coreTarget) / Math.max(1, satellites.length)).map(x => Math.min(x, cap));
  const used = satW.reduce((a, b) => a + b, 0); w[coreSym] += (1 - coreTarget - used);
  satellites.forEach((s, i) => { w[s] = (w[s] || 0) + satW[i]; });
  return { coreSym, coreAdded: !heldCore.length, weights: w };
}
