// ============================================================
//  /api/suggest-portfolio  ·  POST
//  Genera (una sola vez) una explicación en lenguaje natural de
//  la cartera sugerida para el cliente.
//
//  IMPORTANTE (modelo híbrido):
//   - La ASIGNACIÓN (porcentajes) sale de REGLAS deterministas,
//     no de la IA. Mismo perfil -> misma cartera, siempre.
//   - La IA solo REDACTA el porqué, para el cliente.
//   Si la IA no está disponible, se devuelve una explicación
//   estática basada en las mismas reglas (nunca se rompe el flujo).
//
//  Variables: ANTHROPIC_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const MODEL = "claude-sonnet-4-6";

// Reglas deterministas: banda -> asignación objetivo (debe reflejar BANDS en app.js)
const ALLOC = {
  1: { cash: 15, fixed_income: 65, equity: 18, crypto: 2 },
  2: { cash: 10, fixed_income: 55, equity: 30, crypto: 5 },
  3: { cash: 8,  fixed_income: 40, equity: 45, crypto: 7 },
  4: { cash: 5,  fixed_income: 25, equity: 60, crypto: 10 },
  5: { cash: 5,  fixed_income: 10, equity: 70, crypto: 15 },
};
const CLASS_ES = { cash:"liquidez", fixed_income:"renta fija", equity:"renta variable", crypto:"cripto" };
const BAND_LABEL = { 1:"Conservador", 2:"Moderado-Conservador", 3:"Moderado", 4:"Moderado-Agresivo", 5:"Agresivo" };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ ok: false, error: "config", message: "Faltan variables de Supabase." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Sin sesión" });

  const svc = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

  try {
    // Identificar usuario
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!meRes.ok) return res.status(401).json({ ok: false, error: "Sesión inválida" });
    const me = await meRes.json();

    // Última evaluación del propio usuario
    const raRes = await fetch(
      `${SUPABASE_URL}/rest/v1/risk_assessments?user_id=eq.${me.id}&select=id,final_band,band_label,goal_type,target_amount,monthly_contribution,currency,ai_suggestion&order=created_at.desc&limit=1`,
      { headers: svc });
    const [ra] = await raRes.json();
    if (!ra) return res.status(404).json({ ok: false, error: "Sin perfil de riesgo" });

    const band = ra.final_band || 3;
    const alloc = ALLOC[band];

    // Si ya existe una explicación guardada, devolverla (no regenerar ni gastar créditos)
    if (ra.ai_suggestion)
      return res.status(200).json({ ok: true, band, alloc, suggestion: ra.ai_suggestion, cached: true });

    // Explicación estática de respaldo (reglas), por si la IA no está disponible
    const fallback = staticRationale(band, alloc, ra);

    let suggestion = fallback, source = "reglas";
    if (ANTHROPIC_API_KEY) {
      const prompt = `Eres el asesor de InveXia. Explica al cliente, en 2 párrafos cortos y en español cercano, por qué su cartera sugerida tiene esta asignación. NO cambies los porcentajes; solo explícalos.

Perfil: ${ra.band_label || BAND_LABEL[band]} (nivel ${band} de 5).
${ra.goal_type ? `Objetivo: ${ra.goal_type}.` : ""}
${ra.monthly_contribution ? `Aporte mensual: ${ra.monthly_contribution} ${ra.currency || "USD"}.` : ""}
Asignación objetivo: ${Object.entries(alloc).map(([k, v]) => `${v}% ${CLASS_ES[k]}`).join(", ")}.

Reglas: no prometas rentabilidades; recuerda que es una sugerencia inicial que su asesor puede ajustar; sé claro y sin jerga. No uses encabezados ni listas.`;
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
        });
        if (r.ok) {
          const data = await r.json();
          const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
          if (text) { suggestion = text; source = "ia"; }
        }
      } catch (_) { /* usa el fallback */ }
    }

    // Guardar para no regenerar
    await fetch(`${SUPABASE_URL}/rest/v1/risk_assessments?id=eq.${ra.id}`, {
      method: "PATCH", headers: { ...svc, Prefer: "return=minimal" },
      body: JSON.stringify({ ai_suggestion: suggestion }),
    });

    return res.status(200).json({ ok: true, band, alloc, suggestion, source });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server", message: String(e.message) });
  }
}

function staticRationale(band, alloc, ra) {
  const label = ra.band_label || BAND_LABEL[band];
  const parts = Object.entries(alloc).map(([k, v]) => `${v}% en ${CLASS_ES[k]}`).join(", ");
  return `Según tus respuestas, tu perfil es ${label}. Por eso tu cartera sugerida combina ${parts}. ` +
    `La parte más estable (liquidez y renta fija) busca proteger tu capital, mientras que la renta variable y una pequeña porción de cripto aportan crecimiento en el largo plazo, en la medida que tu perfil lo permite. ` +
    `Es una sugerencia inicial: tu asesor puede ajustarla a tus necesidades. No representa una promesa de rentabilidad.`;
}
