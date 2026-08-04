// ============================================================
//  /api/alpaca-assets?q=appl  ·  GET
//  Buscador en vivo de activos: filtra la lista maestra de Alpaca
//  (~10 000 acciones y ETFs) por símbolo o nombre.
//
//  La lista completa se cachea en memoria (6 h) para no pedirla
//  a Alpaca en cada tecla.
//
//  Variables: ALPACA_KEY_ID · ALPACA_SECRET · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://broker-api.sandbox.alpaca.markets";
const TTL = 6 * 60 * 60 * 1000;   // 6 horas
let CACHE = { at: 0, list: null };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { ALPACA_KEY_ID, ALPACA_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!ALPACA_KEY_ID || !ALPACA_SECRET)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan ALPACA_KEY_ID o ALPACA_SECRET." });

  // Requiere sesión válida (evita uso anónimo del proxy)
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(401).json({ ok: false, error: "Sin sesión" });
  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });

  const q = String(req.query.q || "").trim().toUpperCase();
  if (q.length < 1) return res.status(200).json({ ok: true, results: [] });

  try {
    // ---- lista maestra (cacheada) ----
    if (!CACHE.list || Date.now() - CACHE.at > TTL) {
      const auth = "Basic " + Buffer.from(`${ALPACA_KEY_ID}:${ALPACA_SECRET}`).toString("base64");
      const r = await fetch(`${ALPACA_BASE}/v1/assets?status=active&asset_class=us_equity`, {
        headers: { authorization: auth, accept: "application/json" },
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(502).json({ ok: false, error: "alpaca", message: t.slice(0, 200) });
      }
      const all = await r.json();
      // Solo lo operable; guardamos lo mínimo
      CACHE = {
        at: Date.now(),
        list: (Array.isArray(all) ? all : [])
          .filter(a => a.tradable)
          .map(a => ({ s: a.symbol, n: a.name || "", f: !!a.fractionable, e: a.exchange || "" })),
      };
    }

    // ---- filtrar ----
    const list = CACHE.list;
    const starts = [], contains = [];
    for (const a of list) {
      if (a.s.startsWith(q)) starts.push(a);
      else if (a.s.includes(q) || a.n.toUpperCase().includes(q)) contains.push(a);
      if (starts.length >= 20) break;
    }
    // Prioriza coincidencia por símbolo; completa hasta 20
    const results = [...starts, ...contains].slice(0, 20).map(a => ({
      symbol: a.s, name: a.n, fractionable: a.f, exchange: a.e,
    }));

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
