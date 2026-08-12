#!/usr/bin/env python3
# =====================================================================
#  InveXia · QuantNet — Pipeline de datos reales
#  ---------------------------------------------------------------------
#  Descarga precios y fundamentales reales (yfinance), calcula la red de
#  correlaciones y las métricas, y produce dos archivos:
#     network_admin_latest.json    -> completo, con señales (ANALISTA)
#     network_client_latest.json   -> sin señales (CLIENTE)
#  Luego los sube a Supabase Storage (bucket 'quantnet').
#
#  Uso:
#     pip install yfinance numpy pandas requests
#     python quantnet_pipeline.py                # datos reales + subida
#     python quantnet_pipeline.py --dry-run      # sintético, valida JSON
#     python quantnet_pipeline.py --no-upload    # genera archivos, no sube
#
#  Programarlo a diario (ej. 23:00): cron, GitHub Actions o Colab.
# =====================================================================

import os, sys, json, math, argparse, datetime as dt
import numpy as np

# --------- Configuración ---------
LOOKBACK   = 252          # días hábiles por ventana de correlación
N_SNAPS    = 12           # snapshots mensuales (deslizador temporal)
BUCKET     = "quantnet"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Universo ~100 (Nasdaq-100 aprox.) con sector legible en español.
UNIVERSE = {
  "AAPL":"Tecnología","MSFT":"Tecnología","NVDA":"Tecnología","AVGO":"Tecnología","ADBE":"Tecnología",
  "CSCO":"Tecnología","AMD":"Tecnología","INTC":"Tecnología","QCOM":"Tecnología","TXN":"Tecnología",
  "AMAT":"Tecnología","MU":"Tecnología","INTU":"Tecnología","LRCX":"Tecnología","KLAC":"Tecnología",
  "ADI":"Tecnología","SNPS":"Tecnología","CDNS":"Tecnología","NXPI":"Tecnología","MCHP":"Tecnología",
  "GOOGL":"Comunicaciones","GOOG":"Comunicaciones","META":"Comunicaciones","NFLX":"Comunicaciones",
  "CMCSA":"Comunicaciones","TMUS":"Comunicaciones","CHTR":"Comunicaciones","WBD":"Comunicaciones","EA":"Comunicaciones",
  "AMZN":"Consumo discrecional","TSLA":"Consumo discrecional","MELI":"Consumo discrecional","BKNG":"Consumo discrecional",
  "SBUX":"Consumo discrecional","MAR":"Consumo discrecional","ORLY":"Consumo discrecional","LULU":"Consumo discrecional",
  "ROST":"Consumo discrecional","ABNB":"Consumo discrecional","PDD":"Consumo discrecional",
  "PEP":"Consumo básico","COST":"Consumo básico","MDLZ":"Consumo básico","KDP":"Consumo básico",
  "KHC":"Consumo básico","MNST":"Consumo básico","CTAS":"Consumo básico",
  "AMGN":"Salud","GILD":"Salud","VRTX":"Salud","REGN":"Salud","ISRG":"Salud","MRNA":"Salud",
  "IDXX":"Salud","DXCM":"Salud","BIIB":"Salud","ILMN":"Salud",
  "PYPL":"Financiero","FANG":"Energía","EXC":"Servicios básicos","AEP":"Servicios básicos","XEL":"Servicios básicos",
  "HON":"Industrial","ADP":"Industrial","CSX":"Industrial","PCAR":"Industrial","PAYX":"Industrial",
  "FAST":"Industrial","ODFL":"Industrial","CPRT":"Industrial","ROP":"Industrial","VRSK":"Industrial",
  "GEHC":"Salud","ON":"Tecnología","TTD":"Comunicaciones","DDOG":"Tecnología","TEAM":"Tecnología",
  "CRWD":"Tecnología","PANW":"Tecnología","FTNT":"Tecnología","ZS":"Tecnología","CDW":"Tecnología",
  "MRVL":"Tecnología","WDAY":"Tecnología","DASH":"Consumo discrecional","CEG":"Servicios básicos",
  "AZN":"Salud","LIN":"Materiales","ADSK":"Tecnología","BKR":"Energía","CCEP":"Consumo básico",
  "DLTR":"Consumo discrecional","EBAY":"Consumo discrecional","GFS":"Tecnología","TTWO":"Comunicaciones",
  "WBA":"Consumo básico","ANSS":"Tecnología","MDB":"Tecnología","SMCI":"Tecnología","ARM":"Tecnología",
}
MARKET = "SPY"   # proxy de mercado para betas

# =====================================================================
#  Utilidades numéricas
# =====================================================================
def ann(x):        return x * 252
def ann_vol(x):    return x * math.sqrt(252)

def clean(o):
    """Convierte NaN/Infinity (no válidos en JSON) en None, de forma recursiva."""
    if isinstance(o, dict):  return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):  return [clean(v) for v in o]
    if isinstance(o, float): return o if math.isfinite(o) else None
    try:
        if isinstance(o, np.floating): return float(o) if math.isfinite(float(o)) else None
        if isinstance(o, np.integer):  return int(o)
    except Exception:
        pass
    return o

def factor_model(stock_ret, mkt_ret):
    """beta (CAPM), residuo idiosincrático."""
    var_m = np.var(mkt_ret)
    beta = float(np.cov(stock_ret, mkt_ret)[0, 1] / var_m) if var_m > 0 else 1.0
    resid = stock_ret - beta * mkt_ret
    idio = float(np.std(resid))
    return beta, idio, resid

def corr_matrix(R):
    """R: (T x N) -> matriz de correlación NxN (lista de listas)."""
    C = np.corrcoef(R, rowvar=False)
    C = np.nan_to_num(C, nan=0.0)
    np.fill_diagonal(C, 1.0)
    C = np.clip(C, -0.99, 0.99)
    np.fill_diagonal(C, 1.0)
    return C

# =====================================================================
#  Cointegración (Engle-Granger) — para la red de pairs trading
# =====================================================================
def halflife(spread):
    """Vida media de reversión a la media del spread (días)."""
    s = np.asarray(spread, dtype=float)
    lag = s[:-1] - s[:-1].mean()
    d = np.diff(s)
    if len(lag) < 5 or np.var(lag) == 0:
        return None
    beta = np.polyfit(lag, d, 1)[0]
    if beta >= 0:
        return None
    hl = -math.log(2) / beta
    return round(float(hl), 1) if math.isfinite(hl) and 0 < hl < 400 else None

def coint_layer(logpx, corr, syms, thr=0.6, max_pairs=800):
    """Matriz de fuerza de cointegración (0..1) + lista de pares ordenados.
       logpx: T x N (log-precios) · corr: NxN (corr de log-retornos)."""
    from statsmodels.tsa.stattools import coint as eg_coint
    N = corr.shape[0]
    M = np.zeros((N, N))
    cands = []
    for i in range(N):
        for j in range(i + 1, N):
            c = abs(corr[i][j])
            if c >= thr:
                cands.append((c, i, j))
    cands.sort(reverse=True)
    cands = cands[:max_pairs]
    pairs = []
    for _, i, j in cands:
        a, b = logpx[:, i], logpx[:, j]
        if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
            continue
        try:
            _, pval, _ = eg_coint(a, b)
        except Exception:
            continue
        if pval < 0.10:
            beta = float(np.polyfit(b, a, 1)[0])
            hl = halflife(a - beta * b)
            strength = round(float(1 - pval), 4)
            M[i][j] = M[j][i] = strength
            pairs.append({"a": syms[i], "b": syms[j], "pval": round(float(pval), 4),
                          "beta": round(beta, 3), "halflife": hl,
                          "corr": round(float(corr[i][j]), 3), "strength": strength})
    pairs.sort(key=lambda p: -p["strength"])
    return M, pairs[:20]

# =====================================================================
#  Descarga de datos reales (yfinance)
# =====================================================================
def fetch_real():
    import yfinance as yf
    import pandas as pd
    tickers = list(UNIVERSE.keys())
    all_syms = tickers + [MARKET]
    print(f"Descargando precios de {len(all_syms)} símbolos…")
    start = (dt.date.today() - dt.timedelta(days=800)).isoformat()
    px = yf.download(all_syms, start=start, interval="1d",
                     auto_adjust=True, progress=False)["Close"]
    px = px.dropna(axis=1, how="all").ffill().dropna()
    good = [t for t in tickers if t in px.columns and t != MARKET]
    print(f"  {len(good)} símbolos con datos válidos.")

    # fundamentales/perfil (una sola vez; se aplican a todos los snapshots)
    print("Descargando fundamentales/perfil…")
    profiles = {}
    for t in good:
        try:
            info = yf.Ticker(t).info
        except Exception:
            info = {}
        profiles[t] = build_profile_fin(info)

    logpx = np.log(px)
    rets = logpx.diff().dropna()   # LOG-retornos (correcto para pairs trading)
    dates_idx = rets.index

    # fechas de snapshot: últimos N_SNAPS fines de mes disponibles
    monthly = rets.resample("ME").last().index
    snap_dates = [d for d in monthly if d in dates_idx][-N_SNAPS:]
    if len(snap_dates) < N_SNAPS:
        snap_dates = list(dates_idx[-N_SNAPS:])

    snapshots, out_dates = {}, []
    for sd in snap_dates:
        window = rets.loc[:sd].tail(LOOKBACK)
        if len(window) < 60:
            continue
        mkt = window[MARKET].values
        node_syms = [t for t in good if t in window.columns]
        Rmat = window[node_syms].values
        C = corr_matrix(Rmat)

        nodes = []
        for k, t in enumerate(node_syms):
            sr = window[t].values
            beta, idio, resid = factor_model(sr, mkt)
            # gamma: carga al componente común del sector
            sect = UNIVERSE[t]
            peers = [s for s in node_syms if UNIVERSE.get(s) == sect and s != t]
            if peers:
                peer_mean = window[peers].mean(axis=1).values
                cov = np.cov(resid, peer_mean - beta * mkt)[0, 1]
                gamma = abs(float(cov / np.var(peer_mean))) if np.var(peer_mean) > 0 else 0.15
            else:
                gamma = 0.15
            prof = profiles[t]
            nodes.append(make_node(t, sect, beta, min(gamma, 1.5), idio,
                                   window[t], prof, sd))
        key = sd.strftime("%Y-%m-%d")
        snapshots[key] = {"nodes": nodes, "rho": C.round(4).tolist()}
        logpxwin = logpx.loc[window.index, node_syms].values
        Mc, cpairs = coint_layer(logpxwin, C, node_syms)
        snapshots[key]["coint"] = Mc.round(4).tolist()
        snapshots[key]["_pairs"] = cpairs
        out_dates.append(key)

    return out_dates, snapshots


def build_profile_fin(info):
    g = info.get
    return {
        "profile": {
            "long_name": g("longName") or g("shortName") or "",
            "country": g("country") or "Estados Unidos",
            "exchange": g("exchange") or "—",
            "currency": g("currency") or "USD",
            "industry": g("industry") or "—",
            "hq": ", ".join(x for x in [g("city"), g("state")] if x) or "—",
            "employees": g("fullTimeEmployees"),
            "founded": None,
            "free_float": round((g("floatShares") or 0) / (g("sharesOutstanding") or 1) * 100, 1)
                          if g("sharesOutstanding") else None,
        },
        "fin": {
            "price": g("currentPrice") or g("regularMarketPrice"),
            "shares_out": g("sharesOutstanding"),
            "revenue": g("totalRevenue"),
            "revenue_growth": round((g("revenueGrowth") or 0) * 100, 1) if g("revenueGrowth") is not None else None,
            "net_income": g("netIncomeToCommon"),
            "ebitda": g("ebitda"),
            "gross_margin": round((g("grossMargins") or 0) * 100, 1) if g("grossMargins") is not None else None,
            "op_margin": round((g("operatingMargins") or 0) * 100, 1) if g("operatingMargins") is not None else None,
            "net_margin": round((g("profitMargins") or 0) * 100, 1) if g("profitMargins") is not None else None,
            "eps": g("trailingEps"),
            "pe": g("trailingPE"),
            "ps": g("priceToSalesTrailing12Months"),
            "pb": g("priceToBook"),
            "ev_ebitda": g("enterpriseToEbitda"),
            "roe": round((g("returnOnEquity") or 0) * 100, 1) if g("returnOnEquity") is not None else None,
            "roic": None,
            "debt_equity": round((g("debtToEquity") or 0) / 100, 2) if g("debtToEquity") is not None else None,
            "current_ratio": g("currentRatio"),
            "fcf": g("freeCashflow"),
            "div_yield": round((g("dividendYield") or 0) * 100, 2) if g("dividendYield") is not None else None,
            "payout": round((g("payoutRatio") or 0) * 100, 0) if g("payoutRatio") is not None else None,
            "w52_low": g("fiftyTwoWeekLow"),
            "w52_high": g("fiftyTwoWeekHigh"),
        },
        "mcap": g("marketCap") or 0,
        "adv": (g("averageVolume") or 0) * (g("currentPrice") or g("regularMarketPrice") or 0),
    }


def make_node(tid, sector, beta, gamma, idio, price_series, prof, sd):
    px = price_series.values
    def trailing(n):
        return float(px[-1] / px[-n - 1] - 1) if len(px) > n else 0.0
    daily = np.diff(px) / px[:-1]
    vol21 = float(np.std(daily[-21:]) * math.sqrt(252)) if len(daily) >= 21 else float(np.std(daily) * math.sqrt(252))
    node = {
        "id": tid, "name": prof["profile"]["long_name"] or tid, "sector": sector,
        "beta": round(beta, 3), "gamma": round(gamma, 3), "idio": round(idio * math.sqrt(252), 3),
        "mcap": prof["mcap"], "adv": prof["adv"],
        "profile": prof["profile"], "fin": prof["fin"],
        "ret_21d": round(trailing(21), 4), "ret_63d": round(trailing(63), 4), "ret_252d": round(trailing(251), 4),
        "vol_21d": round(vol21, 4), "iv_rank": None, "iv_pct": None,
    }
    return node

# =====================================================================
#  Modo prueba (sintético) — valida la estructura sin red
# =====================================================================
def fetch_synthetic():
    rng = np.random.default_rng(42)
    tickers = list(UNIVERSE.keys())[:30]
    T = 400
    import pandas as pd
    idx = pd.bdate_range(end=dt.date.today(), periods=T)
    T = len(idx)  # bdate_range puede devolver una longitud ligeramente distinta
    common = rng.normal(0, 1, T)
    px = {t: 100 * np.cumprod(1 + (0.0003 + 0.01 * (0.6 * common + 0.8 * rng.normal(0, 1, T)))) for t in tickers}
    dfpx = pd.DataFrame(px, index=idx)
    logpx = np.log(dfpx)
    rets = logpx.diff().dropna()
    snap_dates = list(rets.resample("ME").last().index)[-N_SNAPS:]
    snapshots, out_dates = {}, []
    for sd in snap_dates:
        window = rets.loc[:sd].tail(LOOKBACK)
        if len(window) < 40: continue
        C = corr_matrix(window.values)
        nodes = []
        for t in tickers:
            prof = {"profile": {"long_name": t, "country": "Estados Unidos", "exchange": "NASDAQ",
                    "currency": "USD", "industry": "—", "hq": "—", "employees": None,
                    "founded": None, "free_float": None},
                    "fin": {k: None for k in ("price","shares_out","revenue","revenue_growth","net_income",
                    "ebitda","gross_margin","op_margin","net_margin","eps","pe","ps","pb","ev_ebitda",
                    "roe","roic","debt_equity","current_ratio","fcf","div_yield","payout","w52_low","w52_high")},
                    "mcap": 1e11, "adv": 1e8}
            nodes.append(make_node(t, UNIVERSE[t], 1.0, 0.2, 0.2, dfpx[t].loc[:sd], prof, sd))
        key = sd.strftime("%Y-%m-%d")
        snapshots[key] = {"nodes": nodes, "rho": C.round(4).tolist()}
        logpxwin = logpx.loc[window.index, tickers].values
        Mc, cpairs = coint_layer(logpxwin, C, tickers)
        snapshots[key]["coint"] = Mc.round(4).tolist()
        snapshots[key]["_pairs"] = cpairs
        out_dates.append(key)
    return out_dates, snapshots

# =====================================================================
#  Ensamblado de los dos JSON (admin/cliente)
# =====================================================================
def build_outputs(dates, snapshots, synthetic=False):
    today = dt.date.today().isoformat()
    meta = {"universe": f"Nasdaq-100 ({len(UNIVERSE)} activos)",
            "estimator": "correlación de retornos · ventana 252d",
            "lookback": LOOKBACK, "generated": today, "synthetic": synthetic}

    # ADMIN: completo + señales por snapshot
    admin_snaps = {}
    for d in dates:
        s = snapshots[d]
        admin_snaps[d] = {"nodes": s["nodes"], "rho": s["rho"], "coint": s.get("coint"),
                          "signals": {"coint_pairs": s.get("_pairs", [])}}
    admin = {"meta": {**meta, "role": "analyst"}, "dates": dates, "snapshots": admin_snaps}

    # CLIENTE: rho + coint (para dibujar ambas redes), SIN el screener de pares
    client_snaps = {d: {"nodes": snapshots[d]["nodes"], "rho": snapshots[d]["rho"],
                        "coint": snapshots[d].get("coint")} for d in dates}
    client = {"meta": {**meta, "role": "client"}, "dates": dates, "snapshots": client_snaps}
    return admin, client

# =====================================================================
#  Subida a Supabase Storage
# =====================================================================
def key_role(k):
    """Detecta el rol de la llave SIN exponerla (para diagnóstico)."""
    try:
        import base64
        parts = k.split(".")
        if len(parts) == 3:  # JWT legacy
            pad = parts[1] + "=" * (-len(parts[1]) % 4)
            return json.loads(base64.urlsafe_b64decode(pad)).get("role", "?")
        if k.startswith("sb_secret"): return "secret (nueva, ok)"
        if k.startswith("sb_publishable"): return "publishable (¡es la pública!)"
        return "desconocido"
    except Exception:
        return "no-decodable"

def upload(name, obj):
    import requests
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  (sin credenciales Supabase; omito subida)"); return False
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}"
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}",
               "apikey": SUPABASE_KEY, "Content-Type": "application/json",
               "x-upsert": "true"}
    r = requests.post(url, headers=headers, data=json.dumps(obj, allow_nan=False))
    if r.status_code in (200, 201):
        print(f"  ✓ subido: {name}"); return True
    print(f"  ✗ error subiendo {name}: {r.status_code} {r.text[:200]}")
    return False

# =====================================================================
#  Main
# =====================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="sintético, valida estructura")
    ap.add_argument("--no-upload", action="store_true", help="no subir a Supabase")
    args = ap.parse_args()

    if args.dry_run:
        print("== MODO PRUEBA (sintético) ==")
        dates, snaps = fetch_synthetic()
        synthetic = True
    else:
        dates, snaps = fetch_real()
        synthetic = False

    if not dates:
        print("Sin snapshots generados. Aborta."); sys.exit(1)

    admin, client = build_outputs(dates, snaps, synthetic)
    admin, client = clean(admin), clean(client)   # elimina NaN/Inf -> JSON válido
    print(f"Snapshots: {len(dates)}  ({dates[0]} … {dates[-1]})")
    print(f"Nodos: {len(admin['snapshots'][dates[-1]]['nodes'])}")

    # guardar copias locales (allow_nan=False garantiza JSON válido)
    with open("network_admin_latest.json", "w") as f: json.dump(admin, f, allow_nan=False)
    with open("network_client_latest.json", "w") as f: json.dump(client, f, allow_nan=False)
    print("Archivos locales escritos.")

    if not args.no_upload and not args.dry_run:
        print("Subiendo a Supabase Storage…")
        print(f"  llave detectada: rol = {key_role(SUPABASE_KEY)}   (debe ser 'service_role' o 'secret')")
        ok1 = upload("network_admin_latest.json", admin)
        ok2 = upload("network_client_latest.json", client)
        if not (ok1 and ok2):
            print("\n⚠ La subida falló. Si el rol de arriba dice 'anon' o 'publishable',")
            print("  la llave en GitHub es la PÚBLICA, no la service_role. Corrígela y reintenta.")
            sys.exit(1)   # que el job salga ROJO para que se note

    print("Listo.")

if __name__ == "__main__":
    main()
