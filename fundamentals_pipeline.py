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
def _ceo(info):
    try:
        offs = info.get("companyOfficers") or []
        for o in offs:
            t = (o.get("title") or "").lower()
            if "ceo" in t or "chief executive" in t:
                return o.get("name")
        return offs[0].get("name") if offs else None
    except Exception:
        return None


def earnings_info(yft):
    """Próxima fecha de reporte + últimos resultados trimestrales (BPA est. vs. real)."""
    import pandas as pd
    out = {"next_date": None, "quarters": []}
    try:
        ed = yft.earnings_dates
    except Exception:
        ed = None
    if ed is not None and not getattr(ed, "empty", True):
        try:
            tz = ed.index.tz
            now = pd.Timestamp.now(tz=tz) if tz else pd.Timestamp.now()
            fut = ed[ed.index > now].sort_index()
            if len(fut):
                out["next_date"] = fut.index[0].strftime("%Y-%m-%d")
                out["next_eps_est"] = _n(fut.iloc[0].get("EPS Estimate"))
            past = ed[ed.index <= now].sort_index(ascending=False).head(4)
            for dt_, row in past.iterrows():
                rep = _n(row.get("Reported EPS"))
                est = _n(row.get("EPS Estimate"))
                if rep is None and est is None:
                    continue
                sur = round((rep - est) / abs(est) * 100, 1) if (rep is not None and est not in (None, 0)) else None
                out["quarters"].append({"date": dt_.strftime("%Y-%m-%d"),
                                        "eps_est": est, "eps_act": rep, "surprise": sur})
        except Exception:
            pass
    try:
        qi = yft.quarterly_income_stmt
        if qi is not None and not getattr(qi, "empty", True) and "Total Revenue" in qi.index:
            rev = qi.loc["Total Revenue"].dropna()
            if len(rev):
                out["last_revenue"] = _n(rev.iloc[0])
                if len(rev) > 4 and _n(rev.iloc[4]):
                    out["revenue_yoy"] = round((float(rev.iloc[0]) - float(rev.iloc[4])) / abs(float(rev.iloc[4])) * 100, 1)
    except Exception:
        pass
    try:
        calx = yft.calendar
        if isinstance(calx, dict):
            out["rev_est"] = _n(calx.get("Revenue Average"))
            if out.get("next_eps_est") is None:
                out["next_eps_est"] = _n(calx.get("Earnings Average"))
    except Exception:
        pass
    if not out["next_date"] and not out["quarters"]:
        return None
    return out


def _financials_df(inc, bs, quarterly=False, n=5):
    if inc is None or getattr(inc, "empty", True):
        return None
    cols = list(inc.columns)[:n][::-1]

    def row(df, *names):
        if df is None:
            return None
        for nm in names:
            if nm in df.index:
                return df.loc[nm]
        return None

    rev_r = row(inc, "Total Revenue", "TotalRevenue", "Operating Revenue")
    eps_r = row(inc, "Diluted EPS", "Basic EPS")
    ni_r = row(inc, "Net Income", "Net Income Common Stockholders", "NetIncome")
    sh_r = row(bs, "Ordinary Shares Number", "Share Issued", "Common Stock Shares Outstanding")

    years, revenue, eps, shares, net_income = [], [], [], [], []
    for c in cols:
        if quarterly:
            try:
                years.append(f"{(c.month - 1)//3 + 1}T{c.year % 100:02d}")
            except Exception:
                years.append(str(c))
        else:
            try:
                years.append(c.year)
            except Exception:
                years.append(str(c))
        revenue.append(_n(rev_r.get(c)) if rev_r is not None else None)
        ni = _n(ni_r.get(c)) if ni_r is not None else None
        net_income.append(ni)
        sh = _n(sh_r.get(c)) if sh_r is not None else None
        shares.append(sh)
        e = _n(eps_r.get(c)) if eps_r is not None else None
        if e is None and ni and sh:
            e = round(ni / sh, 2)
        eps.append(e)

    if not any(v is not None for v in revenue) and not any(v is not None for v in eps):
        return None
    return {"years": years, "revenue": revenue, "eps": eps, "shares": shares, "net_income": net_income}


def annual_financials(yft):
    try:
        return _financials_df(yft.income_stmt, yft.balance_sheet, quarterly=False, n=5)
    except Exception:
        return None


def quarterly_financials(yft):
    try:
        return _financials_df(yft.quarterly_income_stmt, yft.quarterly_balance_sheet, quarterly=True, n=6)
    except Exception:
        return None


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

    # ---- métricas detalladas estilo Finviz ----
    import pandas as pd
    stats = {}
    if hist is not None and len(hist) > 20:
        cl = hist["Close"].dropna()
        last = float(cl.iloc[-1])

        def _perf(n):
            if len(cl) > n:
                b = float(cl.iloc[-n - 1])
                return round((last - b) / b * 100, 1) if b else None
            return None

        ytd = None
        try:
            yr = cl.index[-1].year
            ycl = cl[cl.index.year == yr]
            if len(ycl) > 1 and float(ycl.iloc[0]):
                ytd = round((last - float(ycl.iloc[0])) / float(ycl.iloc[0]) * 100, 1)
        except Exception:
            pass
        stats["perf"] = {"week": _perf(5), "month": _perf(21), "quarter": _perf(63),
                         "half": _perf(126), "ytd": ytd,
                         "year": _perf(252) or (round(ch1y, 1) if ch1y is not None else None)}
        # RSI 14
        try:
            dd = cl.diff().dropna()
            up = dd.clip(lower=0).rolling(14).mean().iloc[-1]
            dn = (-dd.clip(upper=0)).rolling(14).mean().iloc[-1]
            stats["rsi"] = round(100 - 100 / (1 + up / dn), 1) if dn else (100.0 if up else None)
        except Exception:
            stats["rsi"] = None
        # ATR 14
        try:
            hh, ll, pc = hist["High"], hist["Low"], cl.shift(1)
            tr = pd.concat([(hh - ll), (hh - pc).abs(), (ll - pc).abs()], axis=1).max(axis=1)
            stats["atr"] = round(float(tr.rolling(14).mean().iloc[-1]), 2)
        except Exception:
            stats["atr"] = None
        sma50 = float(cl.rolling(50).mean().iloc[-1]) if len(cl) >= 50 else None
        sma200 = float(cl.rolling(200).mean().iloc[-1]) if len(cl) >= 200 else None
        stats["sma50_pct"] = round((last - sma50) / sma50 * 100, 1) if sma50 else None
        stats["sma200_pct"] = round((last - sma200) / sma200 * 100, 1) if sma200 else None

    fcf = _n(info.get("freeCashflow"))
    mc = _n(info.get("marketCap"))
    stats.update({
        "income": _n(info.get("netIncomeToCommon")),
        "revenue": _n(info.get("totalRevenue")),
        "book_sh": _n(info.get("bookValue")),
        "cash_sh": _n(info.get("totalCashPerShare")),
        "roa": _n(info.get("returnOnAssets")),
        "quick_ratio": _n(info.get("quickRatio")),
        "ev_sales": _n(info.get("enterpriseToRevenue")),
        "p_fcf": (round(mc / fcf, 1) if fcf and mc and fcf > 0 else None),
        "shares_out": _n(info.get("sharesOutstanding")),
        "float_shares": _n(info.get("floatShares")),
        "insider_own": _n(info.get("heldPercentInsiders")),
        "inst_own": _n(info.get("heldPercentInstitutions")),
        "short_float": _n(info.get("shortPercentOfFloat")),
        "avg_volume": _n(info.get("averageVolume")),
        "eps_ttm": _n(info.get("trailingEps")),
        "eps_fwd": _n(info.get("forwardEps")),
    })

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
        "ceo": _ceo(info),
    }
    capital = {"mcap": _n(info.get("marketCap")), "debt": _n(info.get("totalDebt")),
               "cash": _n(info.get("totalCash")), "ev": _n(info.get("enterpriseValue"))}
    ownership = {"float": _n(info.get("floatShares")), "shares_out": _n(info.get("sharesOutstanding"))}

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
        "domain": domain or None, "profile": profile, "stats": stats,
        "capital": capital, "ownership": ownership,
        "financials": (annual_financials(yft) if kind == "stock" else None),
        "financials_q": (quarterly_financials(yft) if kind == "stock" else None),
        "earnings": (earnings_info(yft) if kind == "stock" else None),
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
    cal_up, cal_recent = [], []
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
            e = d.get("earnings")
            if e:
                if e.get("next_date"):
                    cal_up.append({"ticker": t, "name": d["name"], "domain": d.get("domain"),
                                   "sector": d["sector"], "date": e["next_date"],
                                   "eps_est": e.get("next_eps_est"), "rev_est": e.get("rev_est")})
                if e.get("quarters"):
                    q = e["quarters"][0]
                    cal_recent.append({"ticker": t, "name": d["name"], "domain": d.get("domain"),
                                       "date": q["date"], "eps_est": q["eps_est"], "eps_act": q["eps_act"],
                                       "surprise": q["surprise"], "revenue": e.get("last_revenue"),
                                       "revenue_yoy": e.get("revenue_yoy")})
            print(f"  [{i+1}/{len(items)}] {t} ✓")
        except Exception as ex:
            print(f"  [{i+1}/{len(items)}] {t}: error {ex}")

    upload("fundamentals/index.json",
           {"generated_at": dt.datetime.utcnow().isoformat() + "Z", "stocks": index})
    cal_up.sort(key=lambda x: x["date"])
    cal_recent.sort(key=lambda x: x["date"], reverse=True)
    upload("earnings/calendar.json",
           {"generated_at": dt.datetime.utcnow().isoformat() + "Z",
            "upcoming": cal_up[:250], "recent": cal_recent[:250]})
    print(f"\nListo: {len(index)} fichas · {len(cal_up)} próximos · {len(cal_recent)} recientes.")


if __name__ == "__main__":
    main()
