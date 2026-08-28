-- ============================================================
--  InveXia · migración v23
--  Cartera sugerida por el asesor, por cada portafolio simulado.
--
--  - suggested_alloc: asignación objetivo por clase de activo
--    { "cash":10, "fixed_income":40, "equity":40, "crypto":5, "alt":5 }
--  - suggested_note: nota/racional para el cliente.
--  - Permisos: el admin puede leer y actualizar los portafolios de
--    todos los clientes (para poder sugerir). El cliente sigue viendo
--    y editando solo los suyos (políticas de la migración v19).
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

alter table public.sim_portfolios add column if not exists suggested_alloc jsonb;
alter table public.sim_portfolios add column if not exists suggested_note text;

-- El admin puede LEER los portafolios de cualquier cliente
drop policy if exists "sim admin select" on public.sim_portfolios;
create policy "sim admin select" on public.sim_portfolios
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- El admin puede ACTUALIZAR (para guardar la cartera sugerida)
drop policy if exists "sim admin update" on public.sim_portfolios;
create policy "sim admin update" on public.sim_portfolios
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
