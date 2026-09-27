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
FAST = False   # modo rápido: omite estados financieros pesados (menos peticiones a Yahoo)

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
    nam_col = next((c for c in df.columns if str(c).lower() in ("security", "company", "name")), None)
    uni = {}
    for _, row in df.iterrows():
        tid = str(row[sym_col]).strip().replace(".", "-")
        sec = _GICS.get(str(row[sec_col]).strip(), "—") if sec_col else "—"
        nam = str(row[nam_col]).strip() if nam_col else None
        if tid and tid.upper() == tid:
            uni[tid] = {"sector": sec, "name": nam}
    return uni


def stooq_series(ticker):
    """Historial diario de 1 año desde Stooq (fuente confiable, no bloquea como Yahoo)."""
    import requests, io, datetime as dt
    import pandas as pd
    sym = ticker.lower().replace(".", "-") + ".us"
    d1 = (dt.date.today() - dt.timedelta(days=400)).strftime("%Y%m%d")
    url = f"https://stooq.com/q/d/l/?s={sym}&d1={d1}&i=d"
    try:
        txt = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20).text
        if not txt or "Date" not in txt[:40]:
            return None
        df = pd.read_csv(io.StringIO(txt), parse_dates=["Date"], index_col="Date")
        if df.empty or "Close" not in df.columns or df["Close"].dropna().shape[0] < 2:
            return None
        return df
    except Exception:
        return None


def batch_prices(tickers, chunk=100):
    """Descarga los precios de 1 año de TODOS los activos en pocas peticiones (yf.download)."""
    import yfinance as yf, time
    out = {}
    for i in range(0, len(tickers), chunk):
        part = tickers[i:i + chunk]
        try:
            df = yf.download(part, period="1y", interval="1d", group_by="ticker",
                             auto_adjust=True, threads=True, progress=False)
        except Exception as e:
            print(f"  batch {i//chunk+1}: error {e}")
            continue
        for t in part:
            try:
                if len(part) == 1:
                    sub = df
                else:
                    if t not in df.columns.get_level_values(0):
                        continue
                    sub = df[t]
                if sub is None or "Close" not in sub or sub["Close"].dropna().shape[0] < 2:
                    continue
                out[t] = sub
            except Exception:
                continue
        print(f"  batch {i//chunk+1}/{(len(tickers)+chunk-1)//chunk}: {len(out)} con precio")
        time.sleep(1.5)
    return out


def build_universe():
    try:
        uni = fetch_sp500_universe()
        if len(uni) >= 100:
            print(f"Universo S&P 500: {len(uni)} acciones.")
            return uni
    except Exception as e:
        print(f"  (no se pudo leer S&P 500: {e}; uso Nasdaq-100)")
    return {t: {"sector": "—", "name": None} for t in NASDAQ100_FALLBACK}


# ------------------------------------------------------------------ ficha
INCOME_ITEMS = [
    ("Ingresos totales", ["Total Revenue", "TotalRevenue", "Operating Revenue"]),
    ("Costo de ingresos", ["Cost Of Revenue", "Reconciled Cost Of Revenue"]),
    ("Beneficio bruto", ["Gross Profit"]),
    ("Gastos operativos", ["Operating Expense", "Total Operating Expenses"]),
    ("Beneficio operativo", ["Operating Income", "Total Operating Income As Reported"]),
    ("EBITDA", ["EBITDA", "Normalized EBITDA"]),
    ("Beneficio neto", ["Net Income", "Net Income Common Stockholders"]),
    ("BPA diluido", ["Diluted EPS"]),
]
BALANCE_ITEMS = [
    ("Activos totales", ["Total Assets"]),
    ("Activos corrientes", ["Current Assets", "Total Current Assets"]),
    ("Pasivos totales", ["Total Liabilities Net Minority Interest", "Total Liabilities"]),
    ("Pasivos corrientes", ["Current Liabilities", "Total Current Liabilities"]),
    ("Deuda total", ["Total Debt"]),
    ("Efectivo e inversiones", ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"]),
    ("Patrimonio neto", ["Stockholders Equity", "Total Equity Gross Minority Interest"]),
    ("Ganancias retenidas", ["Retained Earnings"]),
]
CASHFLOW_ITEMS = [
    ("Flujo operativo", ["Operating Cash Flow", "Total Cash From Operating Activities", "Cash Flow From Continuing Operating Activities"]),
    ("Flujo de inversión", ["Investing Cash Flow", "Total Cashflows From Investing Activities", "Cash Flow From Continuing Investing Activities"]),
    ("Flujo de financiación", ["Financing Cash Flow", "Total Cash From Financing Activities", "Cash Flow From Continuing Financing Activities"]),
    ("Gastos de capital (Capex)", ["Capital Expenditure", "Capital Expenditures"]),
    ("Flujo de caja libre", ["Free Cash Flow"]),
]


def _statement(df, items, quarterly=False, n=4):
    if df is None or getattr(df, "empty", True):
        return None
    cols = list(df.columns)[:n][::-1]
    periods = []
    for c in cols:
        try:
            periods.append(f"{(c.month-1)//3+1}T{c.year%100:02d}" if quarterly else str(c.year))
        except Exception:
            periods.append(str(c))
    rows = []
    for label, names in items:
        r = None
        for nm in names:
            if nm in df.index:
                r = df.loc[nm]; break
        vals = [(_n(r.get(c)) if r is not None else None) for c in cols]
        if any(v is not None for v in vals):
            rows.append({"label": label, "values": vals})
    if not rows:
        return None
    return {"periods": periods, "rows": rows}


def build_statements(yft):
    def pair(annual_df, q_df, items):
        a = _statement(annual_df, items, False)
        q = _statement(q_df, items, True)
        if not a and not q:
            return None
        return {"annual": a, "quarterly": q}
    try:
        inc = pair(yft.income_stmt, yft.quarterly_income_stmt, INCOME_ITEMS)
        bal = pair(yft.balance_sheet, yft.quarterly_balance_sheet, BALANCE_ITEMS)
        cfl = pair(yft.cashflow, yft.quarterly_cashflow, CASHFLOW_ITEMS)
    except Exception:
        return None
    out = {}
    if inc: out["income"] = inc
    if bal: out["balance"] = bal
    if cfl: out["cashflow"] = cfl
    return out or None


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


INCOME_SPEC = [
    ("Ingresos", ["Total Revenue", "Operating Revenue"]),
    ("Costo de ventas", ["Cost Of Revenue", "Reconciled Cost Of Revenue"]),
    ("Beneficio bruto", ["Gross Profit"]),
    ("Gastos operativos", ["Operating Expense", "Total Operating Expenses"]),
    ("Beneficio operativo", ["Operating Income", "Total Operating Income As Reported"]),
    ("Beneficio antes de impuestos", ["Pretax Income"]),
    ("Impuestos", ["Tax Provision"]),
    ("Beneficio neto", ["Net Income", "Net Income Common Stockholders"]),
    ("BPA diluido", ["Diluted EPS"]),
]
BALANCE_SPEC = [
    ("Activos totales", ["Total Assets"]),
    ("Activos corrientes", ["Current Assets", "Total Current Assets"]),
    ("Efectivo e inversiones", ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"]),
    ("Pasivos totales", ["Total Liabilities Net Minority Interest", "Total Liabilities"]),
    ("Pasivos corrientes", ["Current Liabilities", "Total Current Liabilities"]),
    ("Deuda total", ["Total Debt"]),
    ("Patrimonio", ["Stockholders Equity", "Total Equity Gross Minority Interest"]),
]
CASHFLOW_SPEC = [
    ("Flujo operativo", ["Operating Cash Flow", "Total Cash From Operating Activities"]),
    ("Inversión de capital (CapEx)", ["Capital Expenditure"]),
    ("Flujo de caja libre (FCF)", ["Free Cash Flow"]),
    ("Flujo de inversión", ["Investing Cash Flow", "Total Cashflows From Investing Activities"]),
    ("Flujo de financiación", ["Financing Cash Flow", "Total Cash From Financing Activities"]),
    ("Variación de efectivo", ["Changes In Cash", "Change In Cash"]),
]


def _stmt(df, spec, quarterly=False, n=4):
    if df is None or getattr(df, "empty", True):
        return None
    cols = list(df.columns)[:n][::-1]
    periods = []
    for c in cols:
        try:
            periods.append(f"{(c.month-1)//3+1}T{c.year % 100:02d}" if quarterly else c.year)
        except Exception:
            periods.append(str(c))
    rows = []
    for label, names in spec:
        r = None
        for nm in names:
            if nm in df.index:
                r = df.loc[nm]; break
        if r is None:
            continue
        vals = [_n(r.get(c)) for c in cols]
        if any(v is not None for v in vals):
            rows.append({"label": label, "values": vals})
    return {"periods": periods, "rows": rows} if rows else None


def statements(yft):
    try:
        inc, bs, cf = yft.income_stmt, yft.balance_sheet, yft.cashflow
        qi, qb, qc = yft.quarterly_income_stmt, yft.quarterly_balance_sheet, yft.quarterly_cashflow
    except Exception:
        return None
    out = {
        "income": {"annual": _stmt(inc, INCOME_SPEC), "quarterly": _stmt(qi, INCOME_SPEC, True, 6)},
        "balance": {"annual": _stmt(bs, BALANCE_SPEC), "quarterly": _stmt(qb, BALANCE_SPEC, True, 6)},
        "cashflow": {"annual": _stmt(cf, CASHFLOW_SPEC), "quarterly": _stmt(qc, CASHFLOW_SPEC, True, 6)},
    }
    if not any(v.get("annual") or v.get("quarterly") for v in out.values()):
        return None
    return out


def _financials_df(inc, bs, cf=None, quarterly=False, n=5):
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
    ocf_r = row(cf, "Operating Cash Flow", "Total Cash From Operating Activities", "Cash Flow From Continuing Operating Activities")
    fcf_r = row(cf, "Free Cash Flow")

    years, revenue, eps, shares, net_income, op_cf, fcf = [], [], [], [], [], [], []
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
        op_cf.append(_n(ocf_r.get(c)) if ocf_r is not None else None)
        fcf.append(_n(fcf_r.get(c)) if fcf_r is not None else None)
        e = _n(eps_r.get(c)) if eps_r is not None else None
        if e is None and ni and sh:
            e = round(ni / sh, 2)
        eps.append(e)

    if not any(v is not None for v in revenue) and not any(v is not None for v in eps):
        return None
    return {"years": years, "revenue": revenue, "eps": eps, "shares": shares,
            "net_income": net_income, "op_cf": op_cf, "fcf": fcf}


def annual_financials(yft):
    try:
        return _financials_df(yft.income_stmt, yft.balance_sheet, yft.cashflow, quarterly=False, n=5)
    except Exception:
        return None


def quarterly_financials(yft):
    try:
        return _financials_df(yft.quarterly_income_stmt, yft.quarterly_balance_sheet, yft.quarterly_cashflow, quarterly=True, n=6)
    except Exception:
        return None


def build_report(ticker, sector_es, kind, price_hist=None, name_hint=None):
    import yfinance as yf
    import time
    yft = yf.Ticker(ticker)
    info = {}
    for attempt in range(2):   # .info best-effort: si falla, el activo igual aparece con datos del batch
        try:
            info = yft.info or {}
            if info.get("currentPrice") or info.get("regularMarketPrice") or info.get("shortName"):
                break
        except Exception:
            pass
        time.sleep(0.5)
    hist = price_hist   # precios de la descarga masiva (batch), sin bloqueos por activo

    price = _n(info.get("currentPrice")) or _n(info.get("regularMarketPrice"))
    if price is None and hist is not None and len(hist):
        price = _n(hist["Close"].iloc[-1])
    if price is None:
        # sin precio de ninguna fuente: ficha mínima para que el activo NO desaparezca del universo
        return {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or name_hint or ticker,
            "sector": sector_es, "industry": info.get("industry"), "type": kind,
            "currency": info.get("currency", "USD"),
            "summary": (info.get("longBusinessSummary") or "")[:420],
            "price": None, "prev_close": None, "mcap": _n(info.get("marketCap")),
            "change_1d": None, "change_7d": None, "change_1y": None, "spark": [],
            "valuation": {"pe": _n(info.get("trailingPE")), "forward_pe": _n(info.get("forwardPE")),
                          "pb": _n(info.get("priceToBook")), "peg": _n(info.get("trailingPegRatio"))},
            "growth": {"earnings_growth": None, "revenue_growth": None},
            "past": {"roe": _n(info.get("returnOnEquity")), "profit_margin": None, "gross_margin": None},
            "health": {"debt_to_equity": None, "current_ratio": None},
            "dividend": {"yield": _n(info.get("dividendYield")), "payout": None},
            "analyst": {}, "fair_value": None, "fair_upside": None,
            "domain": None, "profile": {}, "stats": {}, "capital": {}, "ownership": {},
            "financials": None, "financials_q": None, "statements": None,
            "earnings": None, "snowflake": None,
        }
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
        "name": info.get("longName") or info.get("shortName") or name_hint or ticker,
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
        "financials": (annual_financials(yft) if (kind == "stock" and not FAST) else None),
        "financials_q": (quarterly_financials(yft) if (kind == "stock" and not FAST) else None),
        "statements": None,
        "earnings": None,
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
def _clean(o):
    import math
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    return o


def upload(name, obj):
    import requests
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  (sin credenciales Supabase; omito subida)")
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}"
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
               "Content-Type": "application/json", "x-upsert": "true"}
    r = requests.post(url, headers=headers, data=json.dumps(_clean(obj), allow_nan=False))
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
def _pnum(s):
    if s is None:
        return None
    t = str(s).replace("$", "").replace(",", "").replace("%", "").strip()
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    if t in ("", "N/A", "--", "n/a", "-"):
        return None
    try:
        v = float(t)
        return -v if neg else v
    except Exception:
        return None


def _nasdaq_earnings(date_str):
    import requests
    hdr = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/122 Safari/537.36",
           "Accept": "application/json, text/plain, */*",
           "Accept-Language": "en-US,en;q=0.9"}
    try:
        r = requests.get(f"https://api.nasdaq.com/api/calendar/earnings?date={date_str}",
                         headers=hdr, timeout=20)
        j = r.json()
        return ((j.get("data") or {}).get("rows")) or []
    except Exception:
        return None


def build_earnings_calendar(keep=None):
    """Calendario de resultados desde Nasdaq (masivo y confiable, no bloquea como Yahoo).
    keep: set opcional de tickers para filtrar (p. ej. el S&P 500)."""
    import datetime as dt, time
    today = dt.date.today()
    up, rec = [], []
    for delta in list(range(0, 25)) + list(range(-1, -13, -1)):
        d = today + dt.timedelta(days=delta)
        if d.weekday() >= 5:
            continue
        ds = d.strftime("%Y-%m-%d")
        rows = _nasdaq_earnings(ds)
        if not rows:
            continue
        for row in rows:
            sym = (row.get("symbol") or "").strip().upper()
            if not sym or not sym.replace(".", "").replace("-", "").isalnum():
                continue
            if keep is not None and sym not in keep:
                continue
            est = _pnum(row.get("epsForecast"))
            base = {"ticker": sym, "name": row.get("name"), "date": ds, "eps_est": est}
            if delta >= 0:
                up.append(base)
            else:
                rec.append({**base, "eps_act": None, "surprise": None,
                            "revenue": None, "revenue_yoy": None})
        time.sleep(0.35)
    if not up and not rec:
        return None
    up.sort(key=lambda x: x["date"])
    seen, up2 = set(), []
    for e in up:
        if e["ticker"] in seen:
            continue
        seen.add(e["ticker"]); up2.append(e)
    rec.sort(key=lambda x: x["date"], reverse=True)
    return {"upcoming": up2[:250], "recent": rec[:250]}


def enrich_recent_actuals(recent, limit=120):
    """Rellena BPA real + sorpresa de los que ya reportaron (yfinance, acotado, best-effort)."""
    import yfinance as yf, time
    import pandas as pd
    for e in recent[:limit]:
        try:
            ed = yf.Ticker(e["ticker"]).earnings_dates
            if ed is None or getattr(ed, "empty", True):
                continue
            tz = ed.index.tz
            target = pd.Timestamp(e["date"], tz=tz) if tz else pd.Timestamp(e["date"])
            idx = (ed.index - target).to_series().abs().idxmin()
            row = ed.loc[idx]
            rep = _n(row.get("Reported EPS")); est = _n(row.get("EPS Estimate"))
            if rep is not None:
                e["eps_act"] = rep
                if e.get("eps_est") is None and est is not None:
                    e["eps_est"] = est
                base = e.get("eps_est")
                if base not in (None, 0):
                    e["surprise"] = round((rep - base) / abs(base) * 100, 1)
        except Exception:
            pass
        time.sleep(0.2)
    return recent


def main():
    import time
    global FAST
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="procesar solo los primeros N")
    ap.add_argument("--fast", action="store_true", help="omite estados financieros (llena el universo rápido)")
    ap.add_argument("--pace", type=float, default=0.5, help="segundos de pausa entre activos (anti-bloqueo)")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return selftest()
    FAST = a.fast
    print(f"Modo: {'RÁPIDO (solo precio + ratios, ~2 peticiones/activo)' if FAST else 'COMPLETO (con estados financieros, ~15 peticiones/activo)'} · pausa {a.pace}s")
    try:
        import curl_cffi  # yfinance lo usa para imitar un navegador y evitar bloqueos
        print("curl_cffi disponible ✓ (menos bloqueos de Yahoo)")
    except Exception:
        print("curl_cffi NO disponible — instálalo para reducir bloqueos (pip install curl_cffi)")

    uni = build_universe()
    items = [(t, v.get("sector", "—"), v.get("name"), "stock") for t, v in uni.items()]
    items += [(e, "ETF · Fondo cotizado", None, "etf") for e in ETFS]
    items += [(c, "Cripto", None, "crypto") for c in CRYPTO]
    if a.limit:
        items = items[:a.limit]

    all_tickers = [t for t, _, _, _ in items]
    print(f"Descargando precios en bloque de {len(all_tickers)} activos…")
    PRICES = batch_prices(all_tickers)
    print(f"Precios (batch Yahoo) obtenidos para {len(PRICES)} de {len(all_tickers)} activos.")

    # Respaldo Stooq para las acciones/ETFs sin precio (Stooq no bloquea como Yahoo)
    missing = [t for t, _, _, k in items if t not in PRICES and k != "crypto"]
    if missing:
        print(f"Faltan {len(missing)} sin precio → respaldo Stooq…")
        got = 0
        for j, t in enumerate(missing):
            s = stooq_series(t)
            if s is not None:
                PRICES[t] = s; got += 1
            if (j + 1) % 50 == 0:
                print(f"  Stooq {j+1}/{len(missing)} (recuperados {got})")
            time.sleep(0.12)
        print(f"Stooq recuperó {got} precios más. Total con precio: {len(PRICES)}.")

    index = []
    for i, (t, sec, name, kind) in enumerate(items):
        ph = PRICES.get(t)
        try:
            d = build_report(t, sec, kind, price_hist=ph, name_hint=name)
            if not d:
                print(f"  [{i+1}/{len(items)}] {t}: sin precio")
                continue
            upload(f"fundamentals/{t}.json", d)
            index.append({"ticker": t, "name": d["name"], "sector": d["sector"],
                          "type": kind, "price": d["price"], "change_1y": d["change_1y"],
                          "domain": d.get("domain"), "mcap": d.get("mcap"),
                          "pe": d["valuation"]["pe"], "div_yield": d["dividend"]["yield"],
                          "forward_pe": d["valuation"]["forward_pe"], "peg": d["valuation"]["peg"],
                          "pb": d["valuation"]["pb"], "ps": d["profile"].get("ps"),
                          "roe": d["past"]["roe"], "beta": d["profile"].get("beta"),
                          "rsi": d["stats"].get("rsi"),
                          "snowflake": d.get("snowflake")})
            print(f"  [{i+1}/{len(items)}] {t} ✓")
        except Exception as ex:
            print(f"  [{i+1}/{len(items)}] {t}: error {ex}")
        if a.pace:
            time.sleep(a.pace)

    upload("fundamentals/index.json",
           {"generated_at": dt.datetime.utcnow().isoformat() + "Z", "stocks": index})
    print(f"Índice subido: {len(index)} fichas.")

    # Calendario de resultados desde Nasdaq (masivo y confiable; independiente de Yahoo)
    print("Armando calendario de resultados (Nasdaq)…")
    keep = set(e["ticker"] for e in index)
    dommap = {e["ticker"]: e.get("domain") for e in index}
    cal = build_earnings_calendar(keep=keep)
    if cal:
        if cal.get("recent"):
            enrich_recent_actuals(cal["recent"])
        for e in cal.get("upcoming", []):
            e["domain"] = dommap.get(e["ticker"])
        for e in cal.get("recent", []):
            e["domain"] = dommap.get(e["ticker"])
        upload("earnings/calendar.json",
               {"generated_at": dt.datetime.utcnow().isoformat() + "Z",
                "upcoming": cal["upcoming"], "recent": cal["recent"]})
        print(f"Calendario real: {len(cal['upcoming'])} próximos · {len(cal['recent'])} recientes.")
    else:
        print("Calendario: Nasdaq no respondió (se mantiene el anterior).")

    print(f"\nListo: {len(index)} fichas.")


if __name__ == "__main__":
    main()
