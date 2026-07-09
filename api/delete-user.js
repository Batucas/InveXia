// ============================================================
//  /api/delete-user  ·  Función serverless (Vercel)
//  Elimina la cuenta de un cliente y TODOS sus datos asociados.
//  IRREVERSIBLE.
//
//  Seguridad:
//   1. Solo acepta POST.
//   2. Verifica el token de quien llama contra Supabase.
//   3. Comprueba que ese usuario tenga role='admin'.
//   4. Impide borrar administradores y borrarse a uno mismo.
//
//  Variables de entorno requeridas en Vercel:
//   - SUPABASE_URL                (misma URL de tu proyecto)
//   - SUPABASE_SERVICE_ROLE_KEY   (llave secreta: NUNCA en el frontend)
// ============================================================

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Método no permitido" });

  const URL = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !SERVICE)
    return res.status(500).json({ ok: false, error: "config",
      message: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel." });

  // ---- token de quien llama ----
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const targetId = (req.body?.userId || "").trim();
  if (!targetId) return res.status(400).json({ ok: false, error: "Falta userId" });

  const admin = (path, init = {}) =>
    fetch(`${URL}${path}`, {
      ...init,
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

  try {
    // 1) ¿Quién llama? Validamos su token contra Supabase.
    const meRes = await fetch(`${URL}/auth/v1/user`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();

    // 2) ¿Es administrador?
    const roleRes = await admin(`/rest/v1/profiles?id=eq.${me.id}&select=role`);
    const [meProfile] = await roleRes.json();
    if (meProfile?.role !== "admin")
      return res.status(403).json({ ok: false, error: "Solo un administrador puede eliminar cuentas" });

    // 3) No permitir autoborrado.
    if (targetId === me.id)
      return res.status(400).json({ ok: false, error: "No puedes eliminar tu propia cuenta" });

    // 4) No permitir borrar a otros administradores.
    const tRes = await admin(`/rest/v1/profiles?id=eq.${targetId}&select=role,email,full_name`);
    const [target] = await tRes.json();
    if (!target) return res.status(404).json({ ok: false, error: "Cliente no encontrado" });
    if (target.role === "admin")
      return res.status(403).json({ ok: false, error: "No se puede eliminar a otro administrador" });

    // 5) Borrar la cuenta. El borrado en cascada del esquema arrastra
    //    profiles -> risk_assessments, portfolios, holdings y messages.
    const delRes = await admin(`/auth/v1/admin/users/${targetId}`, { method: "DELETE" });
    if (!delRes.ok) {
      const detail = await delRes.text();
      return res.status(500).json({ ok: false, error: "No se pudo eliminar", message: detail });
    }

    return res.status(200).json({ ok: true, deleted: target.email || targetId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
