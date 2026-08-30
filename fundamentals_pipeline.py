#!/usr/bin/env python3
"""
InveXia · fundamentals_pipeline.py
==================================
Genera la ficha de "Análisis de acciones" (estilo Simply Wall St) para el
universo S&P 500 + ETFs + cripto usando yfinance, y sube los JSON a
Supabase Storage (bucket 'media', carpeta 'fundamentals/').

Salida:
  fundamentals/index.json        -> lista para el buscador
  fundamentals/{TICKER}.json     -> ficha completa por activo

Entorno (secrets de GitHub Actions):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

Uso:
  python fundamentals_pipeline.py                # universo completo
  python fundamentals_pipeline.py --limit 40     # primeros 40 (pruebas)
  python fundamentals_pipeline.py --self-test    # valida el scoring sin red
"""
import os, sys, json, argparse, math, datetime as dt

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "media"

_GICS = {
    "Information Technology": "Tecnología", "Health Care": "Salud",
    "Financials": "Financiero", "Consumer Discretionary": "Consumo discrecional",
    "Communication Services": "Comunicación", "Industrials": "Industrial",
    "Consumer Staples": "Consumo básico", "Energy": "Energía",
    "Utilities": "Servicios públicos", "Real Estate": "Inmobiliario",
    "Materials": "Materiales",
}

# ETFs y cripto que agregamos al universo del S&P 500
ETFS = ["SPY", "QQQ", "DIA", "IWM", "VOO", "VTI", "TLT", "AGG", "LQD", "HYG",
        "GLD", "SLV", "USO", "VNQ", "SMH", "XLK", "XLF", "XLE"]
CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD"]

NASDAQ100_FALLBACK = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "COST", "NFLX",
    "AMD", "PEP", "ADBE", "CSCO", "QCOM", "INTU", "TXN", "AMGN", "HON", "MU",
]


# ------------------------------------------------------------------ utilidades
def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _n(x):
    """float seguro (None si no es número finito)."""
    try:
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ scoring 0-100
def score_value(pe, pb, peg):
    s = []
    if pe and pe > 0:
        s.append(clamp(100 * (1 - (pe - 8) / 34), 0, 100))     # P/E 8→100, 42→0
    if pb and pb > 0:
        s.append(clamp(100 * (1 - (pb - 1) / 8), 0, 100))      # P/B 1→100, 9→0
    if peg and peg > 0:
        s.append(clamp(100 * (1 - (peg - 0.8) / 2.4), 0, 100)) # PEG .8→100, 3.2→0
    return round(sum(s) / len(s)) if s else None


def score_future(eg, rg):
    s = []
    if eg is not None:
        s.append(clamp(50 + eg * 250, 0, 100))    # +20% beneficios → 100
    if rg is not None:
        s.append(clamp(50 + rg * 300, 0, 100))    # +17% ingresos → 100
    return round(sum(s) / len(s)) if s else None


def score_past(roe, pm):
    s = []
    if roe is not None:
        s.append(clamp(roe * 400, 0, 100))   # ROE 25% → 100
    if pm is not None:
        s.append(clamp(pm * 400, 0, 100))    # margen 25% → 100
    return round(sum(s) / len(s)) if s else None


def score_health(de, cr):
    s = []
    if de is not None:
        s.append(clamp(100 - de / 3, 0, 100))          # D/E 0%→100, 300%→0
    if cr is not None:
        s.append(clamp((cr - 0.4) / 2.1 * 100, 0, 100))  # liquidez 2.5→100
    return round(sum(s) / len(s)) if s else None


def score_dividend(dy, payout):
    if not dy or dy <= 0:
        return 5
    sc = clamp(dy * 100 * 18, 0, 100)   # 5.5% → ~100
    if payout and payout > 0:
        sc *= clamp(1 - max(0, payout - 0.8) / 0.7, 0.3, 1)  # penaliza payout > 80%
    return round(sc)


def fair_value(fwd_eps, eg, price):
    """Valor justo simple con PEG≈1: PE_justo = crecimiento(%) acotado."""
    if not fwd_eps or fwd_eps <= 0 or not price:
        return None, None
    g = (eg * 100) if eg is not None else 12
    fair_pe = clamp(g, 8, 35)
    fv = fwd_eps * fair_pe
    up = (fv - price) / price * 100
    return round(fv, 2), round(up, 1)


def rewards_risks(d):
    rw, rk = [], []
    fu = d.get("fair_upside")
    if fu is not None:
        if fu >= 8:
            rw.append(f"Cotiza ~{fu:.0f}% por debajo de nuestra estimación de valor justo")
        elif fu <= -8:
            rk.append(f"Cotiza ~{abs(fu):.0f}% por encima de nuestra estimación de valor justo")
    eg = d["growth"]["earnings_growth"]
    if eg is not None:
        if eg >= 0.10:
            rw.append(f"Se prevé un crecimiento anual de beneficios de {eg*100:.0f}%")
        elif eg < 0:
            rk.append("Se prevén beneficios decrecientes")
    roe = d["past"]["roe"]
    if roe is not None and roe > 0.20:
        rw.append(f"Retorno sobre el capital sobresaliente ({roe*100:.0f}%)")
    de = d["health"]["debt_to_equity"]
    if de is not None:
        if de < 60:
            rw.append("Deuda contenida y bien cubierta")
        elif de > 150:
            rk.append(f"Deuda elevada frente al patrimonio ({de:.0f}%)")
    cr = d["health"]["current_ratio"]
    if cr is not None and cr < 1:
        rk.append("Liquidez corriente por debajo de 1")
    pe = d["valuation"]["pe"]
    if pe is not None and pe > 45:
        rk.append(f"Múltiplos elevados (P/E {pe:.0f})")
    dy = d["dividend"]["yield"]
    if dy and dy > 0.03:
        rw.append(f"Dividendo atractivo ({dy*100:.1f}%)")
    return rw[:4], rk[:4]


# ------------------------------------------------------------------ universo
def fetch_sp500_universe():
    import requests, pandas as pd, io
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    df = pd.read_html(io.StringIO(html))[0]
    sym_col = next((c for c in df.columns if str(c).lower() in ("symbol", "ticker")), df.columns[0])
    sec_col = next((c for c in df.columns if "sector" in str(c).lower()), None)
    uni = {}
    for _, row in df.iterrows():
        tid = str(row[sym_col]).strip().replace(".", "-")
        sec = _GICS.get(str(row[sec_col]).strip(), "—") if sec_col else "—"
        if tid and tid.upper() == tid:
            uni[tid] = sec
    return uni


def build_universe():
    try:
        uni = fetch_sp500_universe()
        if len(uni) >= 100:
            print(f"Universo S&P 500: {len(uni)} acciones.")
            return uni
    except Exception as e:
        print(f"  (no se pudo leer S&P 500: {e}; uso Nasdaq-100)")
    return {t: "—" for t in NASDAQ100_FALLBACK}


# ------------------------------------------------------------------ ficha
def build_report(ticker, sector_es, kind):
    import yfinance as yf
    yft = yf.Ticker(ticker)
    try:
        info = yft.info or {}
    except Exception:
        info = {}
    try:
        hist = yft.history(period="1y", interval="1d")
    except Exception:
        hist = None

    price = _n(info.get("currentPrice")) or _n(info.get("regularMarketPrice"))
    if price is None and hist is not None and len(hist):
        price = _n(hist["Close"].iloc[-1])
    if price is None:
        return None
    prev = _n(info.get("previousClose"))

    ch1d = ch7d = ch1y = None
    spark = []
    if hist is not None and len(hist) > 2:
        c = hist["Close"].dropna()
        last = float(c.iloc[-1])
        if prev is None:
            prev = float(c.iloc[-2])
        if prev:
            ch1d = (last - prev) / prev * 100
        if len(c) > 6:
            base7 = float(c.iloc[-6])
            if base7:
                ch7d = (last - base7) / base7 * 100
        base1y = float(c.iloc[0])
        if base1y:
            ch1y = (last - base1y) / base1y * 100
        step = max(1, len(c) // 52)
        spark = [round(float(v), 2) for v in c.iloc[::step]][-52:]

    dy = _n(info.get("dividendYield"))
    if dy is not None and dy > 1:    # yfinance a veces lo da en porcentaje
        dy = dy / 100.0

    val = {"pe": _n(info.get("trailingPE")), "forward_pe": _n(info.get("forwardPE")),
           "pb": _n(info.get("priceToBook")),
           "peg": _n(info.get("trailingPegRatio")) or _n(info.get("pegRatio"))}
    grw = {"earnings_growth": _n(info.get("earningsGrowth")),
           "revenue_growth": _n(info.get("revenueGrowth"))}
    pst = {"roe": _n(info.get("returnOnEquity")),
           "profit_margin": _n(info.get("profitMargins")),
           "gross_margin": _n(info.get("grossMargins"))}
    hlt = {"debt_to_equity": _n(info.get("debtToEquity")),
           "current_ratio": _n(info.get("currentRatio"))}
    div = {"yield": dy, "payout": _n(info.get("payoutRatio"))}
    tgt = _n(info.get("targetMeanPrice"))
    ana = {"target": tgt,
           "upside": (round((tgt - price) / price * 100, 1) if tgt and price else None),
           "num": info.get("numberOfAnalystOpinions"),
           "rec": info.get("recommendationKey")}
    fv, fu = fair_value(_n(info.get("forwardEps")), grw["earnings_growth"], price)

    # dominio para el logo (desde el sitio web)
    website = info.get("website") or ""
    domain = ""
    if website:
        domain = website.replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0].strip()

    profile = {
        "industry": info.get("industry"),
        "country": info.get("country"),
        "employees": info.get("fullTimeEmployees"),
        "website": website or None,
        "ps": _n(info.get("priceToSalesTrailing12Months")),
        "ev_ebitda": _n(info.get("enterpriseToEbitda")),
        "beta": _n(info.get("beta")),
        "wk_high": _n(info.get("fiftyTwoWeekHigh")),
        "wk_low": _n(info.get("fiftyTwoWeekLow")),
    }

    d = {
        "ticker": ticker,
        "name": info.get("longName") or info.get("shortName") or ticker,
        "sector": sector_es, "industry": info.get("industry"), "type": kind,
        "currency": info.get("currency", "USD"),
        "summary": (info.get("longBusinessSummary") or "")[:420],
        "price": round(price, 2), "prev_close": prev, "mcap": _n(info.get("marketCap")),
        "change_1d": round(ch1d, 1) if ch1d is not None else None,
        "change_7d": round(ch7d, 1) if ch7d is not None else None,
        "change_1y": round(ch1y, 1) if ch1y is not None else None,
        "spark": spark, "valuation": val, "growth": grw, "past": pst,
        "health": hlt, "dividend": div, "analyst": ana,
        "fair_value": fv, "fair_upside": fu,
        "domain": domain or None, "profile": profile,
    }

    if kind == "stock":
        sn = {"value": score_value(val["pe"], val["pb"], val["peg"]),
              "future": score_future(grw["earnings_growth"], grw["revenue_growth"]),
              "past": score_past(pst["roe"], pst["profit_margin"]),
              "health": score_health(hlt["debt_to_equity"], hlt["current_ratio"]),
              "dividend": score_dividend(div["yield"], div["payout"])}
        if len([v for v in sn.values() if v is not None]) < 3:
            d["snowflake"] = None
        else:
            d["snowflake"] = {k: (v if v is not None else 0) for k, v in sn.items()}
    else:
        d["snowflake"] = None

    rw, rk = rewards_risks(d)
    if kind in ("etf", "crypto") and not rw:
        rw = ["Instrumento líquido para diversificar"]
    d["rewards"], d["risks"] = rw, rk
    return d


# ------------------------------------------------------------------ subida
def upload(name, obj):
    import requests
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  (sin credenciales Supabase; omito subida)")
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}"
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
               "Content-Type": "application/json", "x-upsert": "true"}
    r = requests.post(url, headers=headers, data=json.dumps(obj, allow_nan=False))
    if r.status_code in (200, 201):
        return True
    print(f"  ✗ error subiendo {name}: {r.status_code} {r.text[:160]}")
    return False


# ------------------------------------------------------------------ self-test
def selftest():
    print("Self-test del scoring (sin red)…")
    v = score_value(52, 48, 1.1); f = score_future(0.42, 0.38)
    p = score_past(0.91, 0.55); h = score_health(22, 4.1); dv = score_dividend(0.0003, 0.01)
    print(f"  NVDA-like → value={v} future={f} past={p} health={h} dividend={dv}")
    assert f > 80 and p > 80 and h > 70 and dv < 15, "scores fuera de rango esperado"
    fvv, fuu = fair_value(4.0, 0.42, 121.0)
    print(f"  fair_value(fwd_eps=4, g=42%, price=121) = {fvv} ({fuu}%)")
    d = {"growth": {"earnings_growth": 0.42}, "past": {"roe": 0.91},
         "health": {"debt_to_equity": 22, "current_ratio": 4.1},
         "valuation": {"pe": 52}, "dividend": {"yield": 0.0003}, "fair_upside": 15.3}
    rw, rk = rewards_risks(d)
    print("  rewards:", rw)
    print("  risks:", rk)
    print("✓ OK")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="procesar solo los primeros N")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return selftest()

    uni = build_universe()
    items = [(t, s, "stock") for t, s in uni.items()]
    items += [(e, "ETF · Fondo cotizado", "etf") for e in ETFS]
    items += [(c, "Cripto", "crypto") for c in CRYPTO]
    if a.limit:
        items = items[:a.limit]

    index = []
    for i, (t, sec, kind) in enumerate(items):
        try:
            d = build_report(t, sec, kind)
            if not d:
                print(f"  [{i+1}/{len(items)}] {t}: sin datos")
                continue
            upload(f"fundamentals/{t}.json", d)
            index.append({"ticker": t, "name": d["name"], "sector": d["sector"],
                          "type": kind, "price": d["price"], "change_1y": d["change_1y"],
                          "domain": d.get("domain"), "mcap": d.get("mcap"),
                          "pe": d["valuation"]["pe"], "div_yield": d["dividend"]["yield"],
                          "snowflake": d.get("snowflake")})
            print(f"  [{i+1}/{len(items)}] {t} ✓")
        except Exception as ex:
            print(f"  [{i+1}/{len(items)}] {t}: error {ex}")

    upload("fundamentals/index.json",
           {"generated_at": dt.datetime.utcnow().isoformat() + "Z", "stocks": index})
    print(f"\nListo: {len(index)} fichas subidas.")


if __name__ == "__main__":
    main()
