-- ============================================================
--  InveXia · migración v21
--  Onboarding de perfil: fecha de nacimiento + marca "onboarded".
--  El celular (phone) y la foto (avatar_url) ya existen en profiles.
--
--  Regla: solo las cuentas NUEVAS verán el paso de completar perfil.
--  Por eso marcamos como "ya completadas" (onboarded=true) todas
--  las cuentas existentes; las nuevas quedan en false por defecto.
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

alter table public.profiles add column if not exists birth_date date;
alter table public.profiles add column if not exists onboarded boolean not null default false;

-- Cuentas ya existentes: no necesitan el paso (grandfather)
update public.profiles set onboarded = true where onboarded = false;
