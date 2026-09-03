// InveXia · /api/crypto-coin?id=bitcoin — detalle de una cripto (CoinGecko)
export default async function handler(req, res) {
  try {
    const id = String(req.query.id || "").toLowerCase().replace(/[^a-z0-9\-]/g, "");
    if (!id) { res.status(400).json({ ok: false, error: "id requerido" }); return; }
    const url = `https://api.coingecko.com/api/v3/coins/${id}`
      + "?localization=true&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=true";
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("coingecko " + r.status);
    const c = await r.json();
    const md = c.market_data || {};
    const usd = (o) => (o && o.usd != null ? o.usd : null);
    const links = c.links || {};
    const out = {
      id: c.id, sym: (c.symbol || "").toUpperCase(), name: c.name,
      img: (c.image && c.image.large) || null, rank: c.market_cap_rank,
      desc: ((c.description && (c.description.es || c.description.en)) || "").replace(/<[^>]+>/g, "").slice(0, 900),
      homepage: (links.homepage && links.homepage.find(Boolean)) || null,
      twitter: links.twitter_screen_name ? ("https://twitter.com/" + links.twitter_screen_name) : null,
      price: usd(md.current_price), mcap: usd(md.market_cap), vol: usd(md.total_volume),
      supply: md.circulating_supply, total_supply: md.total_supply, max_supply: md.max_supply,
      ath: usd(md.ath), ath_chg: usd(md.ath_change_percentage),
      atl: usd(md.atl), atl_chg: usd(md.atl_change_percentage),
      high24: usd(md.high_24h), low24: usd(md.low_24h),
      c1h: usd(md.price_change_percentage_1h_in_currency),
      c24h: usd(md.price_change_percentage_24h_in_currency),
      c7d: usd(md.price_change_percentage_7d_in_currency),
      c30d: usd(md.price_change_percentage_30d_in_currency),
      c1y: usd(md.price_change_percentage_1y_in_currency),
      spark: (md.sparkline_7d && md.sparkline_7d.price) ? md.sparkline_7d.price.filter((_, i) => i % 3 === 0) : []
    };
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=180");
    res.status(200).json({ ok: true, coin: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
