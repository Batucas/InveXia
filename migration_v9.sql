-- ============================================================
--  InveXia · Migración v9
--  Habilita el servicio premium "Ajuste de portafolio".
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.profiles
  add column if not exists premium_portfolio boolean not null default false;

-- ------------------------------------------------------------
--  Seguridad: solo un admin puede cambiar la cuenta de Alpaca
--  O el acceso premium. (Reemplaza el guard de la migración v7
--  para cubrir también premium_portfolio.)
-- ------------------------------------------------------------
create or replace function public.guard_alpaca_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.alpaca_account_id is distinct from old.alpaca_account_id
      or new.premium_portfolio is distinct from old.premium_portfolio)
     and not public.is_admin() then
    raise exception 'Solo un administrador puede cambiar la cuenta de inversión o el acceso premium.';
  end if;
  return new;
end; $$;

-- El trigger trg_guard_alpaca de la v7 ya invoca esta función; no hay que recrearlo.

-- ============================================================
--  Listo. El admin activa el premium desde la ficha del cliente.
-- ============================================================
