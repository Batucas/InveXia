// ============================================================
//  /api/generate-brief  ·  Brief macro de InveXia (Lepton-AI)
//
//  POST (solo admin) -> genera un brief del mercado con Claude,
//  usando como contexto las señales del Radar, y lo guarda en
//  Supabase Storage (media/brief/brief_latest.json). Los clientes
//  solo LEEN ese archivo desde la sección Brief.
//
//  Variables de entorno en Vercel (las mismas del asistente):
//   ANTHROPIC_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const MODEL = "claude-sonnet-4-6";

export default async function handler(req, res) {
  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de Supabase en Vercel." });
  if (!ANTHROPIC_API_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Falta ANTHROPIC_API_KEY en Vercel." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  try {
    // ---------- 1. Verificar que sea admin ----------
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();
    const [profile] = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${me.id}&select=role`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    ).then(r => r.json());
    if (profile?.role !== "admin")
      return res.status(403).json({ ok: false, error: "Solo el administrador puede generar el brief." });

    // ---------- 2. Contexto: señales del Radar ----------
    let radar = null;
    try {
      const rr = await fetch(`${SUPABASE_URL}/storage/v1/object/public/media/radar/radar_latest.json`, { cache: "no-store" });
      if (rr.ok) radar = await rr.json();
    } catch (_) {}
    const top = (radar?.signals || []).slice(0, 40)
      .map(s => `${s.tid} (${s.sector||"—"}): ${s.tag} · score ${s.score}${s.notes?.length ? " · " + s.notes.join("; ") : ""}`)
      .join("\n");
    const radarCtx = top
      ? `Universo: ${radar.universe}. Señales detectadas hoy por el Radar (escáner de precio/volumen), ordenadas por fuerza:\n${top}`
      : "El Radar no tiene señales disponibles en este momento; escribe un brief general de posicionamiento.";

    // ---------- 3. Prompt ----------
    const system = `Eres el analista macro y de mercados de InveXia, una plataforma de gestión de inversiones. Redactas un "brief" diario para inversionistas: claro, sobrio y accionable, en español.

Reglas estrictas:
- Básate ÚNICAMENTE en los datos del Radar que te doy y en conocimiento general de mercados y macroeconomía. NO inventes precios, fechas, cifras concretas ni noticias específicas que no estén en los datos.
- No des recomendaciones personalizadas de compra/venta ni consejo financiero individual. Habla de temas, posicionamiento y escenarios.
- Tono profesional y directo. Sin relleno.
- Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin markdown, sin texto extra) con esta forma:
{
  "titulo": "…",
  "resumen": "2-3 frases con la foto general del día",
  "secciones": [
    { "titulo": "Qué está marcando el Radar", "cuerpo": "…" },
    { "titulo": "Temas macro a vigilar", "cuerpo": "…" },
    { "titulo": "Riesgos y oportunidades", "cuerpo": "…" }
  ]
}
Cada "cuerpo" son 1-2 párrafos cortos.`;

    const userMsg = `${radarCtx}\n\nEscribe el brief de hoy siguiendo el formato JSON indicado.`;

    // ---------- 4. Llamada a Claude ----------
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error("[brief] Anthropic error:", r.status, detail.slice(0, 400));
      let msg = "Error de la API de Anthropic.";
      if (/rate_limit|overloaded/i.test(detail) || r.status === 429 || r.status === 529) msg = "Anthropic está saturado. Intenta en unos segundos.";
      else if (/credit|billing/i.test(detail)) msg = "Sin créditos en Anthropic (console.anthropic.com → Billing).";
      else if (/authentication|x-api-key/i.test(detail)) msg = "ANTHROPIC_API_KEY inválida en Vercel.";
      return res.status(502).json({ ok: false, error: "anthropic", message: msg });
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();

    // ---------- 5. Parsear el JSON del modelo ----------
    let brief;
    try {
      const clean = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
      brief = JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
      console.error("[brief] parse error:", e, text.slice(0, 300));
      return res.status(502).json({ ok: false, error: "parse", message: "La respuesta del modelo no vino en el formato esperado. Intenta de nuevo." });
    }

    const out = {
      generated_at: new Date().toISOString(),
      universe: radar?.universe || "—",
      signals_used: (radar?.signals || []).length,
      titulo: String(brief.titulo || "Brief del mercado"),
      resumen: String(brief.resumen || ""),
      secciones: Array.isArray(brief.secciones) ? brief.secciones.slice(0, 6).map(s => ({
        titulo: String(s.titulo || ""), cuerpo: String(s.cuerpo || ""),
      })) : [],
      disclaimer: "Análisis generado por IA a partir de datos de mercado. No es asesoría financiera personalizada.",
    };

    // ---------- 6. Guardar en Storage ----------
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/media/brief/brief_latest.json`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(out),
    });
    if (!up.ok) {
      const d = await up.text();
      console.error("[brief] upload error:", up.status, d.slice(0, 300));
      return res.status(502).json({ ok: false, error: "storage", message: "No se pudo guardar el brief en Storage." });
    }

    return res.status(200).json({ ok: true, brief: out });
  } catch (e) {
    console.error("[brief] error:", e);
    return res.status(500).json({ ok: false, error: "server", message: "Error inesperado generando el brief." });
  }
}
