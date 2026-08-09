-- ============================================================
--  InveXia · Migración v11
--  Habilita el servicio premium "QuantNet" (red de mercado).
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.profiles
  add column if not exists premium_quantnet boolean not null default false;

-- El guard admin-only ahora cubre también premium_quantnet
create or replace function public.guard_alpaca_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.alpaca_account_id  is distinct from old.alpaca_account_id
      or new.premium_portfolio is distinct from old.premium_portfolio
      or new.premium_quantnet  is distinct from old.premium_quantnet)
     and not public.is_admin() then
    raise exception 'Solo un administrador puede cambiar la cuenta de inversión o los accesos premium.';
  end if;
  return new;
end; $$;

-- ============================================================
--  Además, crea un bucket privado "quantnet" en Supabase:
--    Storage > New bucket > name: quantnet > Public: NO
--  El pipeline sube ahí network_admin_latest.json y
--  network_client_latest.json. InveXia genera URLs firmadas.
-- ============================================================
