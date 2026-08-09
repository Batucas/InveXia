// ============================================================
//  /api/quantnet-url  ·  GET   (premium)
//  Devuelve una URL FIRMADA (temporal) al network JSON correcto
//  según el rol real del usuario:
//    - admin   -> network_admin_latest.json  (con señales)
//    - cliente -> network_client_latest.json (sin señales)
//
//  El cliente nunca recibe la URL del archivo de analista: la
//  decisión la toma este servidor con la clave de servicio.
//
//  Variables: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const BUCKET = "quantnet";
const EXPIRES = 300; // segundos de validez de la URL firmada

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de Supabase." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const svc = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  try {
    // ¿quién es?
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();
    const [profile] = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role,premium_quantnet`, { headers: svc }).then(r => r.json());

    const isAdmin = profile?.role === "admin";
    if (!profile?.premium_quantnet && !isAdmin)
      return res.status(403).json({ ok: false, error: "premium", message: "QuantNet no está habilitado en tu cuenta." });

    const role = isAdmin ? "analyst" : "client";
    const file = isAdmin ? "network_admin_latest.json" : "network_client_latest.json";

    // URL firmada (Supabase Storage)
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${file}`, {
      method: "POST", headers: svc, body: JSON.stringify({ expiresIn: EXPIRES }),
    });
    if (!signRes.ok) {
      const t = await signRes.text();
      return res.status(502).json({ ok: false, error: "storage",
        message: /not found/i.test(t) ? "Aún no hay datos publicados. Corre el pipeline." : t.slice(0, 200) });
    }
    const { signedURL } = await signRes.json();
    return res.status(200).json({ ok: true, url: `${SUPABASE_URL}/storage/v1${signedURL}`, role });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
