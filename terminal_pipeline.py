#!/usr/bin/env python3
# ============================================================
#  InveXia · Terminal de opciones — motor de cálculo propio
#  ------------------------------------------------------------
#  Baja la cadena de opciones de Polygon.io (dato primario:
#  strike, vencimiento, interés abierto, precios) y calcula
#  NOSOTROS MISMOS:
#     · IV por inversión de Black-Scholes
#     · gamma (y demás griegas) por BS
#     · GEX por strike, GEX neto, gamma flip, muros call/put
#     · superficie de IV (strike × vencimiento) y term structure
#  Sube un snapshot por ticker a Supabase Storage
#  (media/terminal/{TICKER}.json) + un índice.
#
#  Convención de dealers (EXPLÍCITA, es un supuesto, no un hecho):
#     dealers LARGOS gamma en CALLS, CORTOS gamma en PUTS
#     (convención "SqueezeMetrics", la más usada en el retail).
#
#  Uso:
#     python terminal_pipeline.py               # todos los tickers, sube
#     python terminal_pipeline.py --no-upload   # no sube
#     python terminal_pipeline.py --self-test   # valida el motor (sin red)
#
#  Variables de entorno:
#     POLYGON_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
# ============================================================
import os, sys, json, math, argparse, datetime as dt
from urllib.parse import urlencode

POLYGON_KEY  = os.environ.get("POLYGON_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "media"

TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"]

R = 0.045          # tasa libre de riesgo (aprox.)
Q = 0.0            # dividend yield (aprox.)
MULT = 100         # contrato = 100 acciones
MAX_EXPIRIES = 8   # vencimientos para la superficie/term structure
STRIKE_BAND = 0.25 # ±25% alrededor del spot para el análisis

# ---------------------------------------------------------------
#  Black-Scholes: precio, gamma, vega, e inversión de IV
# ---------------------------------------------------------------
def _norm_pdf(x): return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
def _norm_cdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def bs_d1(S, K, T, sigma, r=R, q=Q):
    if sigma <= 0 or T <= 0: return float("nan")
    return (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))

def bs_price(S, K, T, sigma, kind, r=R, q=Q):
    if T <= 0 or sigma <= 0:
        return max(0.0, (S - K) if kind == "call" else (K - S))
    d1 = bs_d1(S, K, T, sigma, r, q); d2 = d1 - sigma * math.sqrt(T)
    if kind == "call":
        return S * math.exp(-q * T) * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * math.exp(-q * T) * _norm_cdf(-d1)

def bs_gamma(S, K, T, sigma, r=R, q=Q):
    if T <= 0 or sigma <= 0: return 0.0
    d1 = bs_d1(S, K, T, sigma, r, q)
    return math.exp(-q * T) * _norm_pdf(d1) / (S * sigma * math.sqrt(T))

def bs_vega(S, K, T, sigma, r=R, q=Q):
    if T <= 0 or sigma <= 0: return 0.0
    d1 = bs_d1(S, K, T, sigma, r, q)
    return S * math.exp(-q * T) * _norm_pdf(d1) * math.sqrt(T)

def implied_vol(price, S, K, T, kind, r=R, q=Q):
    """IV por Newton-Raphson con respaldo de bisección. Devuelve None si no converge."""
    if price is None or price <= 0 or T <= 0: return None
    intrinsic = max(0.0, (S - K) if kind == "call" else (K - S))
    if price < intrinsic - 1e-6: return None            # precio por debajo del valor intrínseco
    sigma = 0.25
    for _ in range(60):
        diff = bs_price(S, K, T, sigma, kind, r, q) - price
        v = bs_vega(S, K, T, sigma, r, q)
        if v < 1e-8: break
        step = diff / v
        sigma -= step
        if sigma <= 1e-4: sigma = 1e-4
        if abs(step) < 1e-6:
            return sigma if 1e-3 < sigma < 6 else None
    # respaldo: bisección
    lo, hi = 1e-3, 6.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if bs_price(S, K, T, mid, kind, r, q) > price: hi = mid
        else: lo = mid
    sigma = 0.5 * (lo + hi)
    return sigma if 1e-3 < sigma < 6 else None

# ---------------------------------------------------------------
#  GEX — exposición gamma de dealers
# ---------------------------------------------------------------
def gex_contribution(gamma, oi, S, kind):
    """$ gamma por movimiento de 1% del subyacente, con signo de dealer."""
    sign = 1.0 if kind == "call" else -1.0     # dealers largos calls, cortos puts
    return sign * gamma * oi * MULT * (S ** 2) * 0.01

def build_analytics(spot, contracts, today):
    """contracts: lista de dicts {kind, strike, expiry(date), oi, price}.
    Devuelve el bloque de analítica del ticker."""
    band_lo, band_hi = spot * (1 - STRIKE_BAND), spot * (1 + STRIKE_BAND)
    rows = []
    for c in contracts:
        K = c["strike"]
        if not (band_lo <= K <= band_hi): continue
        T = max((c["expiry"] - today).days, 0) / 365.0
        if T <= 0: continue
        iv = implied_vol(c.get("price"), spot, K, T, c["kind"])
        if iv is None: iv = c.get("iv")            # respaldo: IV del proveedor
        if iv is None: continue
        g = bs_gamma(spot, K, T, iv)
        rows.append({"kind": c["kind"], "K": K, "T": T, "days": round(T * 365),
                     "oi": c.get("oi", 0) or 0, "iv": iv, "gamma": g,
                     "gex": gex_contribution(g, c.get("oi", 0) or 0, spot, c["kind"])})
    if not rows:
        return None

    # --- GEX por strike ---
    by_strike = {}
    for r_ in rows:
        by_strike[r_["K"]] = by_strike.get(r_["K"], 0.0) + r_["gex"]
    gex_by_strike = sorted(({"strike": k, "gex": round(v / 1e9, 4)} for k, v in by_strike.items()),
                           key=lambda x: x["strike"])            # en $bn por 1%
    net_gex = round(sum(v for v in by_strike.values()) / 1e9, 4)
    call_wall = max(by_strike.items(), key=lambda kv: kv[1])[0] if by_strike else None
    put_wall  = min(by_strike.items(), key=lambda kv: kv[1])[0] if by_strike else None

    # --- gamma flip: nivel de spot donde el GEX total cruza cero ---
    def total_gex_at(S_hyp):
        tot = 0.0
        for r_ in rows:
            g = bs_gamma(S_hyp, r_["K"], r_["T"], r_["iv"])
            tot += gex_contribution(g, r_["oi"], S_hyp, r_["kind"])
        return tot
    flip = None
    grid = [spot * (1 + t) for t in [i / 100 for i in range(-15, 16)]]
    prev_S, prev_v = grid[0], total_gex_at(grid[0])
    for S_hyp in grid[1:]:
        v = total_gex_at(S_hyp)
        if prev_v == 0 or (prev_v < 0) != (v < 0):        # cambio de signo
            flip = round(prev_S + (S_hyp - prev_S) * abs(prev_v) / (abs(prev_v) + abs(v) + 1e-12), 2)
            break
        prev_S, prev_v = S_hyp, v

    # --- superficie de IV y term structure ---
    expiries = sorted({r_["days"] for r_ in rows})[:MAX_EXPIRIES]
    strikes = sorted({r_["K"] for r_ in rows})
    surf = []
    for d in expiries:
        row_iv = []
        for k in strikes:
            cand = [r_["iv"] for r_ in rows if r_["days"] == d and r_["K"] == k]
            row_iv.append(round(sum(cand) / len(cand), 4) if cand else None)
        surf.append(row_iv)
    term = []
    for d in expiries:
        atmc = min((r_ for r_ in rows if r_["days"] == d), key=lambda r_: abs(r_["K"] - spot), default=None)
        if atmc: term.append({"days": d, "atm_iv": round(atmc["iv"], 4)})

    return {"spot": round(spot, 2), "net_gex": net_gex, "gamma_flip": flip,
            "call_wall": call_wall, "put_wall": put_wall,
            "gex_by_strike": gex_by_strike,
            "surface": {"strikes": strikes, "expiries": expiries, "iv": surf},
            "term": term}

# ---------------------------------------------------------------
#  Polygon.io — descarga de la cadena
# ---------------------------------------------------------------
def poly_get(path, params=None):
    import requests
    params = dict(params or {}); params["apiKey"] = POLYGON_KEY
    r = requests.get(f"https://api.polygon.io{path}?{urlencode(params)}", timeout=40)
    r.raise_for_status()
    return r.json()

def fetch_chain(ticker):
    """Devuelve (spot, [contratos]) desde el snapshot de opciones de Polygon."""
    import requests
    spot = None
    try:
        prev = poly_get(f"/v2/aggs/ticker/{ticker}/prev", {"adjusted": "true"})
        spot = prev["results"][0]["c"]
    except Exception:
        pass
    contracts = []
    url = f"/v3/snapshot/options/{ticker}"
    params = {"limit": 250}
    for _ in range(30):                     # hasta 30 páginas
        data = poly_get(url, params)
        for it in data.get("results", []):
            d = it.get("details", {})
            if spot is None:
                spot = (it.get("underlying_asset") or {}).get("price")
            lq = it.get("last_quote") or {}
            price = None
            if lq.get("bid") and lq.get("ask"): price = (lq["bid"] + lq["ask"]) / 2
            elif (it.get("day") or {}).get("close"): price = it["day"]["close"]
            try:
                exp = dt.date.fromisoformat(d["expiration_date"])
            except Exception:
                continue
            contracts.append({
                "kind": "call" if d.get("contract_type") == "call" else "put",
                "strike": float(d["strike_price"]), "expiry": exp,
                "oi": it.get("open_interest") or 0, "price": price,
                "iv": it.get("implied_volatility"),
            })
        nxt = data.get("next_url")
        if not nxt: break
        url = nxt.replace("https://api.polygon.io", ""); params = {}
    return spot, contracts

# ---------------------------------------------------------------
#  Subida
# ---------------------------------------------------------------
def upload(name, obj):
    import requests
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  (sin credenciales Supabase; omito subida)"); return False
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}"
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
               "Content-Type": "application/json", "x-upsert": "true"}
    r = requests.post(url, headers=headers, data=json.dumps(obj, allow_nan=False))
    ok = r.status_code in (200, 201)
    print(f"  {'✓ subido' if ok else '✗ error'}: {name}" + ("" if ok else f" ({r.status_code} {r.text[:150]})"))
    return ok

# ---------------------------------------------------------------
#  Self-test del motor (sin red): precia opciones con BS, recupera
#  la IV por inversión, calcula gamma y GEX, y verifica coherencia.
# ---------------------------------------------------------------
def self_test():
    print("· Test 1 — recuperar IV por inversión de BS")
    S, K, T, true_iv, kind = 100, 105, 0.25, 0.32, "call"
    px = bs_price(S, K, T, true_iv, kind)
    got = implied_vol(px, S, K, T, kind)
    print(f"   IV real={true_iv}  recuperada={got:.4f}  → {'OK' if abs(got-true_iv)<1e-3 else 'FALLA'}")

    print("· Test 2 — gamma máxima cerca del ATM")
    gats = [(k, bs_gamma(100, k, 0.1, 0.3)) for k in range(80, 121, 2)]
    kmax = max(gats, key=lambda x: x[1])[0]
    print(f"   strike de gamma máx={kmax} (esperado ≈100) → {'OK' if 96<=kmax<=104 else 'FALLA'}")

    print("· Test 3 — GEX: cartera con muchas calls arriba, puts abajo")
    today = dt.date.today(); exp = today + dt.timedelta(days=30)
    contracts = []
    for k in range(90, 111, 5):
        p_c = bs_price(100, k, 30/365, 0.3, "call"); p_p = bs_price(100, k, 30/365, 0.3, "put")
        oi_c = 5000 if k >= 100 else 1000
        oi_p = 5000 if k <= 100 else 1000
        contracts.append({"kind": "call", "strike": k, "expiry": exp, "oi": oi_c, "price": p_c})
        contracts.append({"kind": "put",  "strike": k, "expiry": exp, "oi": oi_p, "price": p_p})
    a = build_analytics(100.0, contracts, today)
    print(f"   GEX neto={a['net_gex']} $bn · call_wall={a['call_wall']} · put_wall={a['put_wall']} · gamma_flip={a['gamma_flip']}")
    ok = a["call_wall"] >= 100 and a["put_wall"] <= 100 and a["net_gex"] != 0
    print(f"   coherencia (muro call arriba, put abajo) → {'OK' if ok else 'FALLA'}")
    print(f"   strikes en superficie: {a['surface']['strikes']}")
    print(f"   term structure: {a['term']}")

def run():
    idx = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "tickers": []}
    today = dt.date.today()
    for t in TICKERS:
        print(f"· {t} …")
        try:
            spot, contracts = fetch_chain(t)
            if not spot or not contracts:
                print("   sin datos, salto."); continue
            a = build_analytics(spot, contracts, today)
            if not a:
                print("   sin contratos válidos, salto."); continue
            snap = {"ticker": t, "generated_at": idx["generated_at"],
                    "dealer_convention": "dealers largos gamma en calls, cortos en puts (SqueezeMetrics)",
                    **a}
            upload(f"terminal/{t}.json", snap)
            idx["tickers"].append({"ticker": t, "spot": a["spot"], "net_gex": a["net_gex"]})
        except Exception as e:
            print(f"   error: {e}")
    upload("terminal/index.json", idx)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test(); return
    if args.no_upload:
        global upload
        _orig = upload
        upload = lambda name, obj: print(f"  (no-upload) {name}") or True
    run()

if __name__ == "__main__":
    main()
