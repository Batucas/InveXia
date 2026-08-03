-- ============================================================
--  InveXia · Migración v7
--  Vincula cada cliente con su cuenta de Alpaca (Broker API).
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.profiles
  add column if not exists alpaca_account_id text;

-- ------------------------------------------------------------
--  Seguridad: SOLO un administrador puede vincular o cambiar
--  la cuenta de Alpaca de un perfil. Sin esto, un cliente podría
--  apuntar a la cuenta de otro y operar en su nombre.
-- ------------------------------------------------------------
create or replace function public.guard_alpaca_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.alpaca_account_id is distinct from old.alpaca_account_id
     and not public.is_admin() then
    raise exception 'Solo un administrador puede vincular la cuenta de inversión.';
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_alpaca on public.profiles;
create trigger trg_guard_alpaca
  before update on public.profiles
  for each row execute function public.guard_alpaca_account();

-- ============================================================
--  Listo. El id de la cuenta lo pega el admin desde la ficha
--  del cliente (modo sandbox de prueba por ahora).
-- ============================================================
