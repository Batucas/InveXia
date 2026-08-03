// ============================================================
//  /api/alpaca-setup  ·  POST   (solo admin)
//  Crea una cuenta de PRUEBA en Alpaca (Broker API sandbox) y la
//  fondea con dólares ficticios. Devuelve el account_id para
//  vincularlo a un cliente de InveXia.
//
//  Es un atajo para el sandbox. En producción, la cuenta se crea
//  en el onboarding con los datos reales y el KYC del cliente.
//
//  Variables: ALPACA_KEY_ID · ALPACA_SECRET · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
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

  try {
    // Solo un admin puede crear cuentas de prueba
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
    const [profile] = await pr.json();
    if (profile?.role !== "admin")
      return res.status(403).json({ ok: false, error: "Solo un administrador puede crear cuentas de prueba" });

    const auth = "Basic " + Buffer.from(`${ALPACA_KEY_ID}:${ALPACA_SECRET}`).toString("base64");
    const H = { authorization: auth, "content-type": "application/json", accept: "application/json" };
    const now = new Date().toISOString();
    const rid = Math.random().toString(36).slice(2, 7);
    // El SSN de prueba no puede empezar con 000 ni 666 (Alpaca los rechaza).
    const area = 100 + Math.floor(Math.random() * 800);          // 100–899, nunca 000/666
    const ssn = `${area === 666 ? 665 : area}-${10 + Math.floor(Math.random() * 89)}-${1000 + Math.floor(Math.random() * 9000)}`;

    // ---------- 1. Crear la cuenta ----------
    const accountBody = {
      contact: {
        email_address: `prueba.${Date.now()}.${rid}@example.com`,
        phone_number: "555-666-7788",
        street_address: ["20 N San Mateo Dr"],
        city: "San Mateo", state: "CA", postal_code: "94401", country: "USA",
      },
      identity: {
        given_name: "Cliente", family_name: `Prueba ${rid}`,
        date_of_birth: "1990-01-01",
        tax_id: ssn, tax_id_type: "USA_SSN",
        country_of_citizenship: "USA", country_of_birth: "USA", country_of_tax_residence: "USA",
        funding_source: ["employment_income"],
      },
      disclosures: {
        is_control_person: false, is_affiliated_exchange_or_finra: false,
        is_politically_exposed: false, immediate_family_exposed: false,
      },
      agreements: [
        { agreement: "customer_agreement", signed_at: now, ip_address: "127.0.0.1" },
        { agreement: "account_agreement", signed_at: now, ip_address: "127.0.0.1" },
        { agreement: "margin_agreement", signed_at: now, ip_address: "127.0.0.1" },
      ],
    };

    const accRes = await fetch(`${ALPACA_BASE}/v1/accounts`, {
      method: "POST", headers: H, body: JSON.stringify(accountBody),
    });
    const account = await accRes.json().catch(() => ({}));
    if (!accRes.ok)
      return res.status(400).json({ ok: false, error: "create", message: account?.message || "No se pudo crear la cuenta." });

    const accountId = account.id;

    // ---------- 2. Fondear (ACH instantáneo en sandbox) ----------
    let funded = false, fundMsg = "";
    try {
      const relRes = await fetch(`${ALPACA_BASE}/v1/accounts/${accountId}/ach_relationships`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          account_owner_name: "Cliente Prueba", bank_account_type: "CHECKING",
          bank_account_number: "32131231abc", bank_routing_number: "121000358",
          nickname: "Banco de prueba",
        }),
      });
      const rel = await relRes.json().catch(() => ({}));
      if (relRes.ok && rel.id) {
        const trRes = await fetch(`${ALPACA_BASE}/v1/accounts/${accountId}/transfers`, {
          method: "POST", headers: H,
          body: JSON.stringify({ transfer_type: "ach", relationship_id: rel.id, amount: "50000", direction: "INCOMING" }),
        });
        const tr = await trRes.json().catch(() => ({}));
        funded = trRes.ok;
        fundMsg = trRes.ok ? `Depósito de $50 000 (${tr.status || "enviado"})` : (tr?.message || "El fondeo quedó pendiente.");
      } else {
        fundMsg = rel?.message || "No se pudo crear la relación bancaria de prueba.";
      }
    } catch (e) { fundMsg = "Fondeo no completado: " + e.message; }

    return res.status(200).json({
      ok: true,
      account_id: accountId,
      account_number: account.account_number,
      status: account.status,
      funded, fundMsg,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
