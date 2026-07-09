// ============================================================
//  /api/quotes  ·  Función serverless (Vercel)
//  Consulta precios a Twelve Data sin exponer tu llave al navegador.
//
//  Uso:  /api/quotes?symbols=VOO,QQQ,BTC/USD
//  Devuelve: { ok:true, quotes:{ VOO:{price,change,percent} , ... }, ts:"..." }
//
//  Requiere la variable de entorno TWELVEDATA_API_KEY en Vercel.
// ============================================================

const CACHE = new Map();            // caché en memoria del lambda
const TTL_MS = 60 * 1000;           // 60 s: protege tu cuota diaria

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  const raw = (req.query.symbols || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "Falta el parámetro symbols" });

  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) {
    return res.status(200).json({
      ok: false, error: "no_key",
      message: "Falta TWELVEDATA_API_KEY en las variables de entorno de Vercel.",
    });
  }

  const symbols = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))];
  if (symbols.length > 30)
    return res.status(400).json({ ok: false, error: "Máximo 30 símbolos por llamada" });

  // ---- caché ----
  const now = Date.now();
  const quotes = {};
  const missing = [];
  for (const s of symbols) {
    const hit = CACHE.get(s);
    if (hit && now - hit.t < TTL_MS) quotes[s] = hit.v;
    else missing.push(s);
  }

  if (missing.length) {
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(missing.join(","))}&apikey=${key}`;
      const r = await fetch(url);
      const data = await r.json();

      // La API devuelve el objeto directo si es 1 símbolo, o un mapa si son varios.
      const map = (missing.length === 1) ? { [missing[0]]: data } : data;

      for (const s of missing) {
        const q = map?.[s];
        if (!q || q.status === "error" || q.code) {
          quotes[s] = { error: q?.message || "Símbolo no encontrado" };
          continue;
        }
        const v = {
          price:   Number(q.close),
          change:  Number(q.change),
          percent: Number(q.percent_change),
          currency: q.currency || "USD",
          name:    q.name || s,
          exchange: q.exchange || null,
          is_open: q.is_market_open ?? null,
        };
        if (Number.isFinite(v.price)) {
          quotes[s] = v;
          CACHE.set(s, { t: now, v });
        } else {
          quotes[s] = { error: "Precio no disponible" };
        }
      }
    } catch (e) {
      return res.status(200).json({ ok: false, error: "fetch_failed", message: String(e.message) });
    }
  }

  return res.status(200).json({ ok: true, quotes, ts: new Date().toISOString() });
}
