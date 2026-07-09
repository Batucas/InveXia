-- ============================================================
--  InveXia · Migración v6
--  Registro de uso del asistente IA (límite semanal por cliente).
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

create table if not exists public.chat_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Índice para contar rápido las consultas de los últimos 7 días.
create index if not exists chat_usage_user_time_idx
  on public.chat_usage(user_id, created_at desc);

alter table public.chat_usage enable row level security;

-- El cliente puede ver su propio consumo; el admin, el de todos.
drop policy if exists "chat_usage_select" on public.chat_usage;
create policy "chat_usage_select" on public.chat_usage
  for select using (user_id = auth.uid() or public.is_admin());

-- Nadie escribe desde el navegador: solo la función serverless
-- (que usa la llave de servicio y salta el RLS). Así el límite
-- no se puede falsear desde el cliente.

-- ============================================================
--  Límite: 5 consultas por cliente en una ventana móvil de 7 días.
--  Los administradores no tienen límite.
--  Para cambiar el límite, edita CHAT_LIMIT en api/chat.js
-- ============================================================
