# InveXia · Plataforma de gestión de inversiones (piloto)

Frontend estático (HTML/CSS/JS, sin build) + **Supabase** (auth + base de datos con RLS).
Se despliega en **Vercel** o **Netlify** en minutos.

## Qué incluye
- **Cliente:** registro/login → cuestionario de riesgo (2 ejes, 5 bandas) → espera de cartera → vista de cartera (donut + posiciones) → cursos, calendario y mensajes al asesor.
- **Admin (tú):** lista de clientes con su perfil, **constructor de cartera** (asignación por clase + instrumentos + nota + publicar), gestor de cursos, calendario y bandeja de mensajes.
- Perfil de riesgo **exportable** (PDF vía impresión + JSON).

---

## Paso 1 · Crear el proyecto Supabase
1. Entra a https://supabase.com → **New project** (elige región cercana, p. ej. São Paulo).
2. Cuando esté listo, abre **SQL Editor → New query**, pega **todo** `schema.sql` y pulsa **Run**.
3. Ve a **Authentication → Providers → Email** y **desactiva "Confirm email"** (para el piloto, así el login es inmediato tras registrarse).
4. En **Project Settings → API** copia:
   - **Project URL**
   - **anon public key**

## Paso 2 · Configurar
Abre `config.js` y pega esos dos valores:
```js
export const SUPABASE_URL = "https://tuproyecto.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```
> La anon key es pública por diseño; la seguridad real la aplican las políticas RLS del esquema.

## Paso 3 · Convertirte en administrador
1. Abre la app (localmente o desplegada) y **regístrate** con tu correo.
2. En Supabase → **SQL Editor**, ejecuta:
```sql
update public.profiles set role='admin' where email='TU_CORREO';
```
3. Cierra sesión y vuelve a entrar: verás el panel de administrador.
Cualquier otro registro entra como **cliente** automáticamente.

## Paso 4 · Desplegar
**Netlify (lo más rápido):** entra a https://app.netlify.com → arrastra la carpeta `invexia/` a la zona de deploy. Listo.

**Vercel:** sube la carpeta a un repo de GitHub → https://vercel.com → *Add New Project* → importa el repo → *Deploy* (sin configuración; es estático).

Tras desplegar, en Supabase → **Authentication → URL Configuration** agrega tu URL pública (p. ej. `https://invexia.vercel.app`) como *Site URL*.

## Probar en local
Necesita un servidor (por los módulos ES). Con Node:
```bash
npx serve invexia
```
o con Python:
```bash
cd invexia && python3 -m http.server 5173
```
Abre `http://localhost:5173`.

---

## Lógica del perfil de riesgo
- **Eje 1 — Disposición** (5 preguntas actitudinales) y **Eje 2 — Capacidad** (5 preguntas objetivas). Cada eje se puntúa y se traduce a una banda 1–5.
- **Perfil final = mínimo(disposición, capacidad)**, y además **acotado por el horizonte** (un horizonte corto limita el nivel máximo). Es la regla defendible y auditable: nadie con baja capacidad termina en una cartera agresiva.
- Cada banda trae una **asignación sugerida** (liquidez / renta fija / renta variable / cripto) que puedes sobrescribir al construir la cartera real.

## Próximos módulos (cuando quieras)
- Chatbot integrado en Mensajes.
- Rendimiento real de la cartera (precios + valorización).
- Pagos / cobro de comisión (recuerda el marco ASFI–PSAV antes de manejar dinero real).
- Roles de "asesor" además de admin, y multi-asesor.

## Nota
Piloto de software. La administración de dinero de terceros por comisión y la custodia/operación de criptoactivos en Bolivia están reguladas por ASFI (figuras ETF/PSAV). Consulta a un abogado antes de operar con dinero real.
