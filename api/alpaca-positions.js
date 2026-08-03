// ============================================================
//  /api/alpaca-positions  ·  GET
//  Lee de Alpaca (Broker API sandbox) el resumen de cuenta y las
//  posiciones reales del cliente, para mostrarlas en InveXia.
//
//  Seguridad:
//   - La llave de Alpaca vive solo en el servidor.
//   - Verifica la sesión del usuario contra Supabase.
//   - Un cliente SOLO puede leer su propia cuenta vinculada.
//     Un admin puede leer cualquiera pasando ?accountId=...
//
//  Variables de entorno en Vercel:
//   ALPACA_KEY_ID · ALPACA_SECRET · (ALPACA_BASE_URL opcional)
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://broker-api.sandbox.alpaca.markets";

export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { ALPACA_KEY_ID, ALPACA_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de Supabase." });
  if (!ALPACA_KEY_ID || !ALPACA_SECRET)
    return res.status(500).json({ ok: false, error: "config",
      message: "Faltan ALPACA_KEY_ID o ALPACA_SECRET en Vercel." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  try {
    const { profile } = await whoAmI(token, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    if (!profile) return res.status(401).json({ ok: false, error: "Sesión inválida" });

    const isAdmin = profile.role === "admin";
    const accountId = (isAdmin && req.query.accountId) ? req.query.accountId : profile.alpaca_account_id;
    if (!accountId) return res.status(200).json({ ok: true, linked: false });

    const auth = "Basic " + Buffer.from(`${ALPACA_KEY_ID}:${ALPACA_SECRET}`).toString("base64");
    const base = `${ALPACA_BASE}/v1/trading/accounts/${accountId}`;

    const [accRes, posRes] = await Promise.all([
      fetch(`${base}/account`, { headers: { authorization: auth, accept: "application/json" } }),
      fetch(`${base}/positions`, { headers: { authorization: auth, accept: "application/json" } }),
    ]);

    if (!accRes.ok) {
      const t = await accRes.text();
      return res.status(502).json({ ok: false, error: "alpaca", message: t.slice(0, 300) });
    }
    const account = await accRes.json();
    const positions = posRes.ok ? await posRes.json() : [];

    // Resumen compacto
    const summary = {
      currency: account.currency || "USD",
      equity: num(account.equity),
      cash: num(account.cash),
      buying_power: num(account.buying_power),
      last_equity: num(account.last_equity),
      pnl_today: num(account.equity) - num(account.last_equity),
      status: account.status,
    };
    const pos = (Array.isArray(positions) ? positions : []).map((p) => ({
      symbol: p.symbol,
      qty: num(p.qty),
      avg_entry: num(p.avg_entry_price),
      current: num(p.current_price),
      market_value: num(p.market_value),
      unrealized_pl: num(p.unrealized_pl),
      unrealized_plpc: num(p.unrealized_plpc) * 100,
      asset_class: p.asset_class,
    }));

    return res.status(200).json({ ok: true, linked: true, account: summary, positions: pos });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

async function whoAmI(token, url, service) {
  const meRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: service, Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) return { profile: null };
  const me = await meRes.json();
  const r = await fetch(
    `${url}/rest/v1/profiles?id=eq.${me.id}&select=role,alpaca_account_id`,
    { headers: { apikey: service, Authorization: `Bearer ${service}` } });
  const [profile] = await r.json();
  return { me, profile };
}
