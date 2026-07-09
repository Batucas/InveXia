// ============================================================
//  /api/chat  ·  Asistente IA de InveXia (Claude)
//
//  Seguridad:
//   - La llave de Anthropic vive solo en el servidor.
//   - Verifica el token de sesión del usuario contra Supabase.
//   - El contexto (perfil de riesgo, cartera) se lee de la BASE DE DATOS,
//     no de lo que envíe el navegador. Así nadie puede fingir otro perfil.
//
//  Variables de entorno en Vercel:
//   - ANTHROPIC_API_KEY
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 20;

const BANDS = {
  1: "Conservador", 2: "Moderado-Conservador", 3: "Moderado",
  4: "Moderado-Agresivo", 5: "Agresivo",
};

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!ANTHROPIC_API_KEY)
    return res.status(500).json({ ok: false, error: "config",
      message: "Falta ANTHROPIC_API_KEY en las variables de entorno de Vercel." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config",
      message: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_TURNS) : [];
  if (!messages.length) return res.status(400).json({ ok: false, error: "Sin mensajes" });

  const db = (path) =>
    fetch(`${SUPABASE_URL}${path}`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY,
                 Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    }).then((r) => r.json());

  try {
    // ---- 1. ¿Quién pregunta? ----
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();

    // ---- 2. Contexto real, leído de la base ----
    const [profile] = await db(`/rest/v1/profiles?id=eq.${me.id}&select=full_name,role`);
    const [ra] = await db(
      `/rest/v1/risk_assessments?user_id=eq.${me.id}&select=final_band,band_label,goal_type,target_amount,target_date,monthly_contribution,currency&order=created_at.desc&limit=1`);
    const [pf] = await db(
      `/rest/v1/portfolios?user_id=eq.${me.id}&status=eq.published&select=name,currency,allocation,notes&order=updated_at.desc&limit=1`);

    let ctx = `El usuario se llama ${profile?.full_name || "cliente"}.`;
    if (ra) {
      ctx += ` Su perfil de riesgo es ${ra.band_label || BANDS[ra.final_band]} (nivel ${ra.final_band} de 5).`;
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
- Nunca inventes datos sobre la cartera o el mercado. Si no lo sabes, dilo.`;

    // ---- 3. Llamada a Claude ----
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
      return res.status(502).json({ ok: false, error: "anthropic", message: detail.slice(0, 300) });
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return res.status(200).json({ ok: true, reply: text || "No pude generar una respuesta." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}
