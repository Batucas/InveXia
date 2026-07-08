-- ============================================================
--  InveXia · Esquema de base de datos (Supabase / PostgreSQL)
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- ---------- PERFILES ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  role        text not null default 'client' check (role in ('client','admin')),
  created_at  timestamptz not null default now()
);

-- Helper: ¿el usuario actual es admin?  (SECURITY DEFINER evita recursión de RLS)
create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'admin');
$$;

-- Crear perfil automáticamente al registrarse
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- PERFIL DE RIESGO ----------
create table if not exists public.risk_assessments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  answers           jsonb not null,
  willingness_score int,
  willingness_band  int,
  capacity_score    int,
  capacity_band     int,
  horizon_band      int,
  final_band        int,
  band_label        text,
  created_at        timestamptz not null default now()
);

-- ---------- CARTERAS ----------
create table if not exists public.portfolios (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null default 'Cartera principal',
  currency    text not null default 'USD',
  status      text not null default 'draft' check (status in ('draft','published')),
  allocation  jsonb not null default '{}'::jsonb,   -- {cash, fixed_income, equity, crypto, alt}
  notes       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- POSICIONES (instrumentos concretos de una cartera) ----------
create table if not exists public.holdings (
  id            uuid primary key default gen_random_uuid(),
  portfolio_id  uuid not null references public.portfolios(id) on delete cascade,
  asset_class   text not null,        -- cash / fixed_income / equity / crypto / alt
  name          text not null,
  ticker        text,
  target_weight numeric,
  notes         text
);

-- ---------- MENSAJES (un hilo por cliente) ----------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.profiles(id) on delete cascade, -- dueño del hilo
  sender_role text not null check (sender_role in ('client','admin')),
  sender_id   uuid not null references public.profiles(id),
  body        text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- CURSOS ----------
create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  level       text default 'Básico',
  url         text,
  published   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- CALENDARIO ----------
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  event_date  date not null,
  kind        text default 'general',
  created_at  timestamptz not null default now()
);

-- ============================================================
--  RLS (Row Level Security)
-- ============================================================
alter table public.profiles         enable row level security;
alter table public.risk_assessments enable row level security;
alter table public.portfolios       enable row level security;
alter table public.holdings         enable row level security;
alter table public.messages         enable row level security;
alter table public.courses          enable row level security;
alter table public.events           enable row level security;

-- perfiles
create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles_update" on public.profiles
  for update using (id = auth.uid() or public.is_admin());

-- perfil de riesgo
create policy "ra_select" on public.risk_assessments
  for select using (user_id = auth.uid() or public.is_admin());
create policy "ra_insert" on public.risk_assessments
  for insert with check (user_id = auth.uid());

-- carteras: cliente lee la suya, admin lee/escribe todas
create policy "pf_select" on public.portfolios
  for select using (user_id = auth.uid() or public.is_admin());
create policy "pf_admin_write" on public.portfolios
  for all using (public.is_admin()) with check (public.is_admin());

-- posiciones
create policy "hd_select" on public.holdings
  for select using (
    public.is_admin() or exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()));
create policy "hd_admin_write" on public.holdings
  for all using (public.is_admin()) with check (public.is_admin());

-- mensajes
create policy "msg_select" on public.messages
  for select using (client_id = auth.uid() or public.is_admin());
create policy "msg_insert" on public.messages
  for insert with check (sender_id = auth.uid()
                         and (client_id = auth.uid() or public.is_admin()));
create policy "msg_update" on public.messages
  for update using (client_id = auth.uid() or public.is_admin());

-- cursos
create policy "courses_select" on public.courses
  for select using (published = true or public.is_admin());
create policy "courses_admin_write" on public.courses
  for all using (public.is_admin()) with check (public.is_admin());

-- calendario
create policy "events_select" on public.events for select using (true);
create policy "events_admin_write" on public.events
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
--  DESPUÉS DE REGISTRARTE, conviértete en admin ejecutando:
--  update public.profiles set role='admin' where email='TU_CORREO';
-- ============================================================
