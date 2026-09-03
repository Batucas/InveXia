// InveXia · /api/crypto — datos de mercado cripto en vivo (CoinGecko, gratis)
// Devuelve el top de monedas con precio, cambios, mcap, volumen, suministro y sparkline 7d.
export default async function handler(req, res) {
  try {
    const per = Math.min(250, parseInt(req.query.n || "100", 10) || 100);
    const url = "https://api.coingecko.com/api/v3/coins/markets"
      + "?vs_currency=usd&order=market_cap_desc&per_page=" + per + "&page=1"
      + "&sparkline=true&price_change_percentage=1h,24h,7d";
    const r = await fetch(url, { headers: { "accept": "application/json" } });
    if (!r.ok) throw new Error("coingecko " + r.status);
    const data = await r.json();
    const coins = (Array.isArray(data) ? data : []).map(c => ({
      id: c.id,
      sym: (c.symbol || "").toUpperCase(),
      name: c.name,
      img: c.image,
      rank: c.market_cap_rank,
      price: c.current_price,
      mcap: c.market_cap,
      vol: c.total_volume,
      supply: c.circulating_supply,
      c1h: c.price_change_percentage_1h_in_currency,
      c24h: c.price_change_percentage_24h_in_currency,
      c7d: c.price_change_percentage_7d_in_currency,
      spark: (c.sparkline_in_7d && c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((_, i) => i % 4 === 0) : []
    }));
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=180");
    res.status(200).json({ ok: true, coins, ts: Date.now() });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
