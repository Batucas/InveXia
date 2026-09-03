-- ============================================================
--  InveXia · migración v24
--  Staking simulado de criptos. El usuario "bloquea" un monto de
--  una cripto en una piscina con un APY simulado; las recompensas
--  se calculan por el tiempo transcurrido (sin cron, al vuelo).
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

create table if not exists public.crypto_stakes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  coin text,
  symbol text not null,
  amount numeric not null check (amount > 0),
  apy numeric not null default 0,
  staked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.crypto_stakes enable row level security;

drop policy if exists "stakes own select" on public.crypto_stakes;
create policy "stakes own select" on public.crypto_stakes
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "stakes own insert" on public.crypto_stakes;
create policy "stakes own insert" on public.crypto_stakes
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "stakes own delete" on public.crypto_stakes;
create policy "stakes own delete" on public.crypto_stakes
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists crypto_stakes_user on public.crypto_stakes(user_id);
