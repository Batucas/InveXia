# InveXia · Plataforma de gestión de inversiones

Frontend estático (HTML/CSS/JS) + **Supabase** (auth + base de datos con RLS)
+ una **función serverless** en Vercel para las cotizaciones de mercado.

## Módulos
**Cliente:** registro (nombre, celular) → cuestionario (objetivo + plan de aportes + dos ejes de riesgo)
→ cartera con rendimiento en vivo → simulador de aportes → mercado e ideas → cursos, calendario, mensajes.

**Administrador:** clientes (con objetivo, perfil, celular y enlace a WhatsApp), constructor de cartera
(asignación objetivo + posiciones con cantidad y precio de entrada), noticias e ideas de inversión,
cursos, calendario y bandeja de mensajes.

---

# ────────  ACTUALIZACIÓN v2  ────────
Si ya tenías la v1 corriendo, sigue estos 3 pasos.

## Paso 1 · Actualizar la base de datos
Supabase → **SQL Editor → New query** → pega todo `migration_v2.sql` → **Run**.
Es seguro: solo agrega columnas y la tabla `posts`. No borra nada.

## Paso 2 · Conseguir tu llave de precios de mercado
1. Crea una cuenta gratis en **https://twelvedata.com** (plan Basic).
2. Copia tu **API key** del panel.

Plan gratuito: 800 créditos por día (se reinician a medianoche UTC) y 8 por minuto.
Cada símbolo consulta 1 crédito. La app cachea 60 s, así que una cartera de 10 instrumentos
consultada decenas de veces al día cabe de sobra.

## Paso 3 · Configurar la llave en Vercel
Vercel → tu proyecto → **Settings → Environment Variables** → **Add New**:

| Campo   | Valor                    |
|---------|--------------------------|
| Name    | `TWELVEDATA_API_KEY`     |
| Value   | *(tu API key)*           |
| Environments | marca las tres (Production, Preview, Development) |

Guarda, ve a **Deployments** y pulsa **Redeploy** en el último despliegue
(las variables solo se aplican en un despliegue nuevo).

Sube los archivos nuevos a GitHub (Commit + Push) y listo. La carpeta `api/`
debe quedar en la raíz del repo, junto a `index.html`.

> Si no configuras la llave, la app **no se rompe**: muestra un aviso y usa los
> precios manuales o el costo de entrada.

---

## Cómo funciona el rendimiento
Cada posición tiene dos capas:
- **Peso objetivo** (`target_weight`) → la cartera que *debería* tener el cliente. Es lo único obligatorio.
- **Cantidad + precio de entrada** (`quantity`, `avg_cost`) → la cartera *realmente ejecutada*.

Mientras no cargues cantidades, el cliente ve su cartera objetivo y un aviso.
Apenas registras cantidad y precio de entrada de al menos una posición, aparecen automáticamente:
valor actual, capital invertido, P&L global y por instrumento, y la **desviación (drift)**
de cada clase de activo respecto a su objetivo (la barra blanca marca el objetivo).

**Precio efectivo** de cada posición, en orden de prioridad:
1. Precio de mercado (si tiene ticker y Twelve Data lo devuelve)
2. `manual_price` — para DPF, bonos de la BBV, acciones bolivianas y cualquier cosa sin feed
3. `avg_cost` — último recurso

Tickers: acciones y ETFs en formato normal (`VOO`, `AAPL`); cripto como par (`BTC/USD`, `ETH/USD`).

## Simulador de aportes
Dos pestañas, ambas calibradas con el retorno (μ) y la volatilidad (σ) de la banda de riesgo del cliente,
editables con sliders:

- **Determinista** — capitalización mensual con aportes al final de cada mes. Separa el capital
  aportado del interés generado.
- **Monte Carlo** — 1 000 trayectorias de un movimiento browniano geométrico con aportes mensuales:
  `V(t+1) = V(t)·exp((μ − σ²/2)·Δt + σ·√Δt·Z) + aporte`. Muestra abanico de percentiles
  (p10–p90, p25–p75, mediana) y, si el cliente fijó un monto meta, la **probabilidad de alcanzarla**.

Supuestos por banda (anuales, referenciales):

| Banda | Perfil | μ | σ |
|---|---|---|---|
| 1 | Conservador | 4,5 % | 5 % |
| 2 | Moderado-Conservador | 6,0 % | 8 % |
| 3 | Moderado | 7,5 % | 11 % |
| 4 | Moderado-Agresivo | 9,0 % | 15 % |
| 5 | Agresivo | 10,5 % | 19 % |

No son promesas de rentabilidad. Ajústalos si tienes mejores estimaciones para tu universo de inversión.

---

## Instalación desde cero
1. **Supabase:** crea proyecto → SQL Editor → corre `schema.sql` y luego `migration_v2.sql`.
2. **Auth:** Authentication → Providers → Email → desactiva *Confirm email*.
3. **config.js:** pega tu Project URL y tu llave *publishable* (`sb_publishable_…`) o *anon*.
4. **GitHub → Vercel:** sube el repo, importa en Vercel, Deploy. Añade `TWELVEDATA_API_KEY`.
5. **Hazte admin:** regístrate en el sitio y luego en SQL Editor:
   ```sql
   update public.profiles set role='admin' where email='TU_CORREO';
   ```
   Cierra sesión y vuelve a entrar.

## Probar en local
```bash
npx serve invexia      # o: cd invexia && python3 -m http.server 5173
```
Nota: en local `/api/quotes` no existe (es de Vercel). La app lo detecta y usa precios manuales.
Para probar la API en local: `npx vercel dev`.

## Nota regulatoria
Piloto de software. La administración de dinero de terceros por comisión y la custodia u operación
de criptoactivos en Bolivia están reguladas por ASFI (figuras ETF / PSAV). Consulta a un abogado
antes de operar con dinero real de clientes.
