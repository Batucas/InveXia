-- ============================================================
--  InveXia · migración v19
--  Portafolios simulados del cliente (dinero ficticio).
--  Cada cliente arma hasta 10 portafolios con nombre, cada uno
--  con $10,000 ficticios; las tenencias se guardan como JSONB.
--  Reemplaza el paper trading de Alpaca por simulación propia.
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

create table if not exists public.sim_portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  cash       numeric not null default 10000,     -- efectivo ficticio disponible
  holdings   jsonb not null default '[]'::jsonb,  -- [{ticker,name,asset_class,quantity,avg_cost}]
  created_at timestamptz default now()
);

create index if not exists sim_portfolios_user_idx on public.sim_portfolios(user_id);

alter table public.sim_portfolios enable row level security;

-- Cada cliente solo ve y maneja SUS portafolios
drop policy if exists "sim own select" on public.sim_portfolios;
create policy "sim own select" on public.sim_portfolios
  for select using (auth.uid() = user_id);

drop policy if exists "sim own insert" on public.sim_portfolios;
create policy "sim own insert" on public.sim_portfolios
  for insert with check (auth.uid() = user_id);

drop policy if exists "sim own update" on public.sim_portfolios;
create policy "sim own update" on public.sim_portfolios
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "sim own delete" on public.sim_portfolios;
create policy "sim own delete" on public.sim_portfolios
  for delete using (auth.uid() = user_id);

-- Tope de 10 portafolios por cliente (defensa a nivel base de datos)
create or replace function public.sim_portfolios_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.sim_portfolios where user_id = new.user_id) >= 10 then
    raise exception 'Límite de 10 portafolios alcanzado';
  end if;
  return new;
end; $$;

drop trigger if exists sim_portfolios_limit_trg on public.sim_portfolios;
create trigger sim_portfolios_limit_trg
  before insert on public.sim_portfolios
  for each row execute function public.sim_portfolios_limit();
