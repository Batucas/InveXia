// ============================================================
//  /api/alpaca-order  ·  POST
//  Coloca una orden de mercado en la cuenta Alpaca del cliente.
//  (Broker API sandbox · dinero de prueba)
//
//  Body: { symbol, notional?, qty?, side?, accountId? }
//   - notional: monto en USD (permite fracciones, ideal para ETFs caros)
//   - qty: cantidad de unidades (alternativa a notional)
//   - side: "buy" (por defecto) | "sell"
//   - accountId: solo lo respeta un admin; el cliente siempre opera SU cuenta
//
//  Seguridad idéntica a alpaca-positions: la llave vive en el
//  servidor y el cliente nunca puede operar una cuenta ajena.
// ============================================================

const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://broker-api.sandbox.alpaca.markets";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { ALPACA_KEY_ID, ALPACA_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!ALPACA_KEY_ID || !ALPACA_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de entorno." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const { symbol, notional, qty, side = "buy", accountId: reqAccount } = req.body || {};
  if (!symbol) return res.status(400).json({ ok: false, error: "Falta el símbolo" });
  if (!notional && !qty) return res.status(400).json({ ok: false, error: "Indica monto (notional) o cantidad (qty)" });

  try {
    // ---- ¿quién opera? ----
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role,alpaca_account_id`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
    const [profile] = await pr.json();
    if (!profile) return res.status(401).json({ ok: false, error: "Perfil no encontrado" });

    const isAdmin = profile.role === "admin";
    const accountId = (isAdmin && reqAccount) ? reqAccount : profile.alpaca_account_id;
    if (!accountId)
      return res.status(400).json({ ok: false, error: "not_linked",
        message: "No tienes una cuenta de inversión vinculada. Contacta a tu asesor." });

    // ---- construir la orden ----
    const isCrypto = String(symbol).includes("/");
    const order = {
      symbol: String(symbol).toUpperCase(),
      side: side === "sell" ? "sell" : "buy",
      type: "market",
      time_in_force: isCrypto ? "gtc" : "day",   // cripto no admite 'day'
    };
    if (notional) order.notional = String(notional);
    else order.qty = String(qty);

    const auth = "Basic " + Buffer.from(`${ALPACA_KEY_ID}:${ALPACA_SECRET}`).toString("base64");
    const r = await fetch(`${ALPACA_BASE}/v1/trading/accounts/${accountId}/orders`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(order),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Errores típicos de Alpaca traducidos
      let msg = data?.message || "No se pudo colocar la orden.";
      if (/insufficient buying power/i.test(msg)) msg = "Saldo insuficiente en la cuenta para esa compra.";
      else if (/market is closed|not open/i.test(msg)) msg = "El mercado está cerrado. Las acciones operan en horario de EE.UU.; la cripto, 24/7.";
      else if (/not tradable|not found|asset/i.test(msg)) msg = `El símbolo ${order.symbol} no está disponible para operar.`;
      return res.status(400).json({ ok: false, error: "order", message: msg });
    }

    return res.status(200).json({
      ok: true,
      order: {
        id: data.id, symbol: data.symbol, side: data.side,
        notional: data.notional, qty: data.qty, status: data.status,
        submitted_at: data.submitted_at,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
