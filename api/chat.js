// ============================================================
//  /api/chat  ·  Asistente IA de InveXia (Claude)
//
//  - GET  -> devuelve la cuota restante del usuario
//  - POST -> responde una consulta y descuenta una del cupo
//
//  Seguridad:
//   - La llave de Anthropic vive solo en el servidor.
//   - Verifica el token de sesión contra Supabase.
//   - El contexto (perfil, cartera) se lee de la BASE DE DATOS.
//   - El límite semanal se cuenta en la BASE DE DATOS: no se puede
//     falsear desde el navegador.
//
//  Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 20;
const CHAT_LIMIT = 5;          // consultas por cliente
const WINDOW_DAYS = 7;         // en una ventana móvil de 7 días

// Lo que ve un CLIENTE cuando algo falla por nuestro lado.
const MAINTENANCE = "El asistente está en mantenimiento en este momento. Vuelve a intentarlo más tarde o escríbele a tu asesor desde la sección Mensajes.";
const BUSY = "El asistente está recibiendo muchas consultas ahora mismo. Espera unos segundos e intenta de nuevo.";

export default async function handler(req, res) {
  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const configOk = ANTHROPIC_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: MAINTENANCE });

  const svc = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  const db = (path, init = {}) =>
    fetch(`${SUPABASE_URL}${path}`, { ...init, headers: { ...svc, ...(init.headers || {}) } });

  try {
    // ---------- 1. Identificar al usuario ----------
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();

    const [profile] = await db(`/rest/v1/profiles?id=eq.${me.id}&select=full_name,role`).then(r => r.json());
    const isAdmin = profile?.role === "admin";

    // ---------- 2. Cuota (ventana móvil de 7 días) ----------
    const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
    async function quota() {
      if (isAdmin) return { used: 0, remaining: Infinity, limit: null, resetAt: null };
      const r = await db(
        `/rest/v1/chat_usage?user_id=eq.${me.id}&created_at=gte.${since}&select=created_at&order=created_at.asc`);
      const rows = await r.json();
      const used = Array.isArray(rows) ? rows.length : 0;
      // La cuota se libera 7 días después de la consulta más antigua vigente.
      const resetAt = used >= CHAT_LIMIT && rows[0]
        ? new Date(new Date(rows[0].created_at).getTime() + WINDOW_DAYS * 864e5).toISOString()
        : null;
      return { used, remaining: Math.max(0, CHAT_LIMIT - used), limit: CHAT_LIMIT, resetAt };
    }

    // ---------- GET: solo consultar la cuota ----------
    if (req.method === "GET") {
      const q = await quota();
      return res.status(200).json({
        ok: true, unlimited: isAdmin,
        remaining: isAdmin ? null : q.remaining,
        limit: q.limit, resetAt: q.resetAt,
      });
    }
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, error: "Método no permitido" });

    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_TURNS) : [];
    if (!messages.length) return res.status(400).json({ ok: false, error: "Sin mensajes" });

    // ---------- 3. ¿Le queda cupo? ----------
    const q = await quota();
    if (!isAdmin && q.remaining <= 0) {
      const when = q.resetAt
        ? new Date(q.resetAt).toLocaleDateString("es-BO", { day: "2-digit", month: "long" })
        : null;
      return res.status(429).json({
        ok: false, error: "quota", remaining: 0, limit: CHAT_LIMIT, resetAt: q.resetAt,
        message: `Alcanzaste tu límite de ${CHAT_LIMIT} consultas semanales al asistente.` +
                 (when ? ` Tendrás consultas disponibles nuevamente el ${when}.` : "") +
                 " Mientras tanto, puedes escribirle directamente a tu asesor desde la sección Mensajes.",
      });
    }

    if (!ANTHROPIC_API_KEY)
      return res.status(503).json({ ok: false, error: "config",
        message: isAdmin ? "Falta ANTHROPIC_API_KEY en las variables de entorno de Vercel." : MAINTENANCE });

    // ---------- 4. Contexto real, leído de la base ----------
    const [ra] = await db(
      `/rest/v1/risk_assessments?user_id=eq.${me.id}&select=final_band,band_label,goal_type,target_amount,target_date,monthly_contribution,currency&order=created_at.desc&limit=1`).then(r => r.json());
    const [pf] = await db(
      `/rest/v1/portfolios?user_id=eq.${me.id}&status=eq.published&select=name,currency,allocation,notes&order=updated_at.desc&limit=1`).then(r => r.json());

    let ctx = `El usuario se llama ${profile?.full_name || "cliente"}.`;
    if (ra) {
      ctx += ` Su perfil de riesgo es ${ra.band_label} (nivel ${ra.final_band} de 5).`;
      if (ra.goal_type) ctx += ` Su objetivo declarado es: ${ra.goal_type}.`;
      if (ra.target_amount) ctx += ` Monto meta: ${ra.target_amount} ${ra.currency || "USD"}.`;
      if (ra.monthly_contribution) ctx += ` Aporte mensual: ${ra.monthly_contribution} ${ra.currency || "USD"}.`;
    } else {
      ctx += " Todavía NO ha completado su cuestionario de perfil de riesgo.";
    }
    if (pf) {
      ctx += ` Tiene una cartera publicada ("${pf.name}", ${pf.currency}) con esta asignación objetivo: ${JSON.stringify(pf.allocation)}.`;
      if (pf.notes) ctx += ` Nota de su asesor: "${pf.notes}".`;
    } else {
      ctx += " Aún no tiene una cartera publicada.";
    }

    const system = `Eres el asistente educativo de InveXia, una plataforma boliviana de gestión de inversiones dirigida por un asesor humano.

CONTEXTO DEL USUARIO (verificado, proviene de la base de datos):
${ctx}

TU PAPEL
- Educar y aclarar conceptos financieros: diversificación, riesgo, volatilidad, ETFs, renta fija, interés compuesto, etc.
- Explicar al usuario su propio perfil de riesgo y la lógica detrás de la composición de su cartera.
- Responder dudas sobre cómo funciona la plataforma.

LÍMITES ESTRICTOS
- NO das recomendaciones personalizadas de compra o venta de instrumentos concretos. Si te las piden, explica el concepto general y remite al asesor humano a través de la sección Mensajes.
- NO prometes ni proyectas rentabilidades como si fueran ciertas. Toda cifra es un supuesto, y las rentabilidades pasadas no garantizan resultados futuros.
- NO ejecutas operaciones ni modificas la cartera; no tienes esa capacidad.
- Si el usuario aún no completó su perfil de riesgo, invítalo amablemente a hacerlo.
- Si preguntan por temas regulatorios, fiscales o legales de Bolivia, responde en términos generales y recomienda consultar a un profesional.

ESTILO
- Español claro, cercano y sin jerga innecesaria. Si usas un término técnico, explícalo en una línea.
- Respuestas breves: 2 a 4 párrafos cortos como máximo. Sin encabezados ni listas salvo que ayuden de verdad.
- El usuario tiene un número limitado de consultas, así que sé completo en cada respuesta.
- Nunca inventes datos sobre la cartera o el mercado. Si no lo sabes, dilo.`;

    // ---------- 5. Llamada a Claude ----------
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content).slice(0, 4000),
        })),
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      // El motivo real queda en los registros de Vercel, para el administrador.
      console.error("[chat] Anthropic error:", r.status, detail.slice(0, 400));

      // Saturación: es un estado transitorio y honesto para cualquiera.
      if (/rate_limit/i.test(detail) || r.status === 429)
        return res.status(503).json({ ok: false, error: "busy", message: BUSY });
      if (/overloaded/i.test(detail) || r.status === 529)
        return res.status(503).json({ ok: false, error: "busy", message: BUSY });

      // Saldo, llave o modelo: al cliente, mantenimiento. Al admin, la causa exacta.
      let adminMsg = "Error de la API de Anthropic.";
      if (/credit balance is too low|insufficient/i.test(detail))
        adminMsg = "Sin créditos en Anthropic. Recarga en console.anthropic.com → Plans & Billing.";
      else if (/authentication|invalid x-api-key/i.test(detail) || r.status === 401)
        adminMsg = "ANTHROPIC_API_KEY inválida. Revísala en Vercel.";
      else if (/not_found|model/i.test(detail))
        adminMsg = `El modelo ${MODEL} no está disponible para esta cuenta.`;

      return res.status(503).json({ ok: false, error: "maintenance",
        message: isAdmin ? adminMsg : MAINTENANCE });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text)
      return res.status(503).json({ ok: false, error: "maintenance", message: MAINTENANCE });

    // ---------- 6. Descontar del cupo (solo si hubo respuesta) ----------
    let remaining = null;
    if (!isAdmin) {
      await db(`/rest/v1/chat_usage`, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: me.id }),
      });
      remaining = Math.max(0, q.remaining - 1);
    }

    return res.status(200).json({ ok: true, reply: text, remaining, unlimited: isAdmin, limit: CHAT_LIMIT });
  } catch (e) {
    console.error("[chat] server error:", e);
    return res.status(500).json({ ok: false, error: "server", message: MAINTENANCE });
  }
}
