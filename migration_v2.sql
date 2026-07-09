-- ============================================================
--  InveXia · Migración v2
--  Ejecutar en: Supabase > SQL Editor > New query > Run
--  Es seguro correrlo sobre la base existente (no borra nada).
-- ============================================================

-- ---------- 1. Objetivos y plan de aportes (en el cuestionario) ----------
alter table public.risk_assessments
  add column if not exists goal_type            text,
  add column if not exists goal_other           text,
  add column if not exists target_amount        numeric,
  add column if not exists target_date          date,
  add column if not exists initial_amount       numeric,
  add column if not exists monthly_contribution numeric,
  add column if not exists currency             text default 'USD';

-- ---------- 2. Base de costo en las posiciones ----------
--  target_weight  -> cartera OBJETIVO (lo que debería tener)
--  quantity/avg_cost -> cartera EJECUTADA (lo que realmente compró)
alter table public.holdings
  add column if not exists quantity      numeric,
  add column if not exists avg_cost      numeric,
  add column if not exists purchase_date date,
  add column if not exists manual_price  numeric;  -- para DPF, bonos BBV, etc.

-- ---------- 3. Noticias e ideas de inversión ----------
create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'noticia' check (kind in ('noticia','idea')),
  title        text not null,
  body         text,
  source_url   text,
  -- solo para kind='idea'
  ticker       text,
  direction    text check (direction in ('compra','venta','mantener')),
  target_price numeric,
  horizon      text,
  status       text default 'abierta' check (status in ('abierta','cerrada')),
  published    boolean not null default false,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

alter table public.posts enable row level security;

drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts
  for select using (published = true or public.is_admin());

drop policy if exists "posts_admin_write" on public.posts;
create policy "posts_admin_write" on public.posts
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------- 4. El cliente puede actualizar su propio teléfono ----------
--  (la política profiles_update ya lo permite; nada que hacer)

-- ============================================================
--  Listo. Nada más que ejecutar.
-- ============================================================
