-- ============================================================
--  InveXia · migración v25
--  Arregla que el ADMIN pueda ver/editar los portafolios simulados
--  de todos los clientes (la "cartera sugerida").
--
--  Usa una función is_admin() SECURITY DEFINER: comprueba el rol
--  sin depender del RLS de la tabla profiles (que a veces bloqueaba
--  la subconsulta y dejaba al admin sin ver nada).
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- Re-crear las políticas de admin en sim_portfolios usando is_admin()
drop policy if exists "sim admin select" on public.sim_portfolios;
create policy "sim admin select" on public.sim_portfolios
  for select to authenticated
  using (public.is_admin());

drop policy if exists "sim admin update" on public.sim_portfolios;
create policy "sim admin update" on public.sim_portfolios
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Refrescar la caché de esquema de la API (por si acaso)
NOTIFY pgrst, 'reload schema';
