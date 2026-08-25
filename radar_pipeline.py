#!/usr/bin/env python3
# ============================================================
#  InveXia · Radar — escáner de señales del mercado
#  ------------------------------------------------------------
#  Recorre el universo (S&P 500) con datos de precio/volumen
#  (yfinance, gratis) y detecta desequilibrios de:
#    momentum, volatilidad, extensión de precio y flujo (volumen).
#  Produce  radar_latest.json  y lo sube a Supabase Storage
#  (bucket 'media', ruta radar/radar_latest.json) — el mismo
#  que la app lee en la sección Radar.
#
#  Uso:
#     python radar_pipeline.py              # real + subida
#     python radar_pipeline.py --no-upload  # genera, no sube
#
#  Variables de entorno (las mismas de QuantNet):
#     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# ============================================================
import os, sys, json, argparse, datetime as dt
import numpy as np

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "media"
OUT_NAME = "radar/radar_latest.json"

# Umbral mínimo de score para que un activo aparezca en el radar
MIN_SCORE = 55
MAX_CARDS = 140            # tope de tarjetas (las más fuertes)
LOOKBACK_DAYS = 400        # historia a descargar

# Mapa de sectores GICS (inglés → español), para la ficha
_GICS = {
    "Information Technology": "Tecnología", "Health Care": "Salud",
    "Financials": "Financiero", "Consumer Discretionary": "Consumo discrecional",
    "Communication Services": "Comunicación", "Industrials": "Industrial",
    "Consumer Staples": "Consumo básico", "Energy": "Energía",
    "Utilities": "Servicios públicos", "Real Estate": "Inmobiliario",
    "Materials": "Materiales",
}

NASDAQ100_FALLBACK = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","AVGO","COST",
    "NFLX","AMD","PEP","ADBE","LIN","CSCO","QCOM","INTU","TMUS","AMAT",
    "TXN","INTC","AMGN","ISRG","HON","BKNG","VRTX","REGN","MU","ADI",
    "PANW","KLAC","LRCX","SNPS","CDNS","MELI","ASML","CRWD","MAR","ORLY",
]


def fetch_sp500_universe():
    """Constituyentes del S&P 500 desde Wikipedia -> {ticker: sector_es}."""
    import requests, pandas as pd, io
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
    tables = pd.read_html(io.StringIO(html))
    df = tables[0]
    sym_col = next((c for c in df.columns if str(c).lower() in ("symbol", "ticker")), df.columns[0])
    sec_col = next((c for c in df.columns if "sector" in str(c).lower()), None)
    uni = {}
    for _, row in df.iterrows():
        tid = str(row[sym_col]).strip().replace(".", "-")   # BRK.B -> BRK-B
        sec = _GICS.get(str(row[sec_col]).strip(), "—") if sec_col else "—"
        if tid and tid.upper() == tid:
            uni[tid] = sec
    return uni


def build_universe():
    try:
        uni = fetch_sp500_universe()
        if len(uni) >= 100:
            print(f"Universo S&P 500: {len(uni)} activos.")
            return uni, "S&P 500"
    except Exception as e:
        print(f"  (no se pudo leer S&P 500: {e}; uso Nasdaq-100)")
    return {t: "—" for t in NASDAQ100_FALLBACK}, "Nasdaq-100"


def pct(series, value):
    """Percentil (0-1) de 'value' dentro de 'series'."""
    s = series[~np.isnan(series)]
    if len(s) < 20:
        return 0.5
    return float((s < value).mean())


def analyze(tid, sector, close, volume):
    """Devuelve la señal dominante {tag, score, notes} o None."""
    close = close[~np.isnan(close)]
    if len(close) < 120:
        return None
    price = float(close[-1])
    rets = np.diff(close) / close[:-1]

    # --- volatilidad realizada (20d, anualizada) y su percentil sobre ~1 año ---
    def rvol(a):
        return float(np.std(a[-20:]) * np.sqrt(252)) if len(a) >= 20 else np.nan
    vol_now = rvol(rets)
    vol_hist = np.array([rvol(rets[:i]) for i in range(60, len(rets) + 1)])
    vpct = pct(vol_hist, vol_now)

    # --- medias móviles y extensión (z-score vs SMA20) ---
    sma20 = float(np.mean(close[-20:])); sma50 = float(np.mean(close[-50:]))
    sma200 = float(np.mean(close[-200:])) if len(close) >= 200 else float(np.mean(close))
    sd20 = float(np.std(close[-20:])) or 1e-9
    z = (price - sma20) / sd20

    # --- momentum y posición de 52 semanas ---
    ret20 = price / close[-21] - 1 if len(close) > 21 else 0.0
    ret60 = price / close[-61] - 1 if len(close) > 61 else 0.0
    hi = float(np.max(close[-252:])); lo = float(np.min(close[-252:]))
    pos52 = (price - lo) / (hi - lo) if hi > lo else 0.5

    # --- flujo: z-score del volumen de hoy vs 20d ---
    vol_z = np.nan
    if volume is not None:
        v = volume[~np.isnan(volume)]
        if len(v) >= 21:
            m, s = float(np.mean(v[-21:-1])), float(np.std(v[-21:-1])) or 1e-9
            vol_z = (float(v[-1]) - m) / s

    cands = []  # (tag, score, [notes])
    if vpct >= 0.90:
        cands.append(("VOLATILIDAD_EXTREMA", 55 + 45 * (vpct - 0.90) / 0.10,
                     [f"Volatilidad realizada en el percentil {int(vpct*100)}",
                      f"Vol. anualizada ≈ {vol_now*100:.0f}%"]))
    if vpct <= 0.10:
        cands.append(("VOLATILIDAD_COMPRIMIDA", 55 + 45 * (0.10 - vpct) / 0.10,
                     [f"Volatilidad en el percentil {int(vpct*100)}",
                      "La compresión suele preceder movimientos amplios"]))
    if ret20 > 0.05 and ret20 > ret60 * 0.5:
        cands.append(("MOMENTUM_ACELERANDO", min(100, 55 + ret20 * 300),
                     [f"Retorno 20d {ret20*100:+.1f}% con aceleración",
                      f"A {(1-pos52)*100:.0f}% del máximo de 52 semanas"]))
    if pos52 >= 0.98 and ret20 > 0:
        cands.append(("RUPTURA_ALCISTA", min(100, 60 + (pos52 - 0.98) * 1500),
                     ["Nuevo máximo de 52 semanas", "Ruptura al alza"]))
    if pos52 <= 0.02 and ret20 < 0:
        cands.append(("RUPTURA_BAJISTA", min(100, 60 + (0.02 - pos52) * 1500),
                     ["Nuevo mínimo de 52 semanas", "Ruptura a la baja"]))
    if z >= 2:
        cands.append(("PRECIO_SOBREEXTENDIDO", min(100, 50 + z * 12),
                     [f"Z-score {z:+.1f} vs media de 20 días", "Sobre-extendido al alza"]))
    if z <= -2:
        cands.append(("PRECIO_INFRAEXTENDIDO", min(100, 50 + abs(z) * 12),
                     [f"Z-score {z:+.1f} vs media de 20 días", "Infra-extendido, posible reversión"]))
    if not np.isnan(vol_z) and vol_z >= 2.5:
        cands.append(("FLUJO_INUSUAL", min(100, 50 + vol_z * 10),
                     [f"Volumen { (float(volume[-1])/ (np.mean(volume[-21:-1])+1e-9)):.1f}× su promedio de 20d",
                      "Interés inusual, posible catalizador"]))
    if (price > sma50 > sma200) or (price < sma50 < sma200):
        strength = abs(price - sma200) / (sma200 or 1e-9)
        up = price > sma50
        cands.append(("TENDENCIA_FUERTE", min(95, 50 + strength * 120),
                     ["Alineación " + ("alcista" if up else "bajista") + " de medias (20/50/200)",
                      f"Tendencia sostenida · {ret60*100:+.1f}% en 60d"]))

    if not cands:
        return None
    tag, score, notes = max(cands, key=lambda c: c[1])
    return {"tid": tid, "name": tid, "sector": sector,
            "price": round(price, 2), "score": round(float(score)),
            "tag": tag, "notes": notes}


def fetch_and_scan():
    import yfinance as yf
    uni, uni_name = build_universe()
    tickers = list(uni.keys())
    print(f"Descargando precio/volumen de {len(tickers)} activos…")
    start = (dt.date.today() - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    data = yf.download(tickers, start=start, interval="1d",
                       auto_adjust=True, progress=False, group_by="column")
    close = data["Close"].ffill()
    volume = data["Volume"] if "Volume" in data else None

    signals = []
    for t in tickers:
        if t not in close.columns:
            continue
        c = close[t].values.astype(float)
        v = volume[t].values.astype(float) if (volume is not None and t in volume.columns) else None
        try:
            sig = analyze(t, uni.get(t, "—"), c, v)
        except Exception:
            sig = None
        if sig and sig["score"] >= MIN_SCORE:
            signals.append(sig)

    signals.sort(key=lambda s: s["score"], reverse=True)
    signals = signals[:MAX_CARDS]
    print(f"  {len(signals)} señales detectadas (score ≥ {MIN_SCORE}).")
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "universe": uni_name, "count": len(signals), "signals": signals,
    }


def upload(name, obj):
    import requests
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  (sin credenciales Supabase; omito subida)"); return False
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}"
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
               "Content-Type": "application/json", "x-upsert": "true"}
    r = requests.post(url, headers=headers, data=json.dumps(obj, allow_nan=False))
    if r.status_code in (200, 201):
        print(f"  ✓ subido: {name}"); return True
    print(f"  ✗ error subiendo {name}: {r.status_code} {r.text[:200]}")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-upload", action="store_true")
    args = ap.parse_args()
    snap = fetch_and_scan()
    with open("radar_latest.json", "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, allow_nan=False)
    print("  radar_latest.json escrito.")
    if not args.no_upload:
        upload(OUT_NAME, snap)


if __name__ == "__main__":
    main()
