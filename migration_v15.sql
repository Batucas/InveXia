-- ============================================================
--  InveXia · Migración v15
--  Fase 3 del LMS de cursos:
--   - tarea (assignment) por curso: instrucciones que define el admin
--   - entregas de los clientes (texto + archivo) con calificación y
--     retroalimentación del admin
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- Instrucciones de la tarea, en el propio curso (null = sin tarea)
alter table public.courses add column if not exists assignment text;

-- Entregas de los clientes
create table if not exists public.course_submissions (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  text         text,
  file_url     text,
  file_name    text,
  grade        numeric,          -- calificación puesta por el admin
  feedback     text,             -- retroalimentación del admin
  status       text not null default 'submitted',   -- submitted | graded
  submitted_at timestamptz not null default now(),
  graded_at    timestamptz,
  unique (course_id, user_id)     -- una entrega por curso por cliente (se puede re-subir)
);

alter table public.course_submissions enable row level security;

-- El cliente gestiona su propia entrega
drop policy if exists "own sub read"   on public.course_submissions;
drop policy if exists "own sub insert" on public.course_submissions;
drop policy if exists "own sub update" on public.course_submissions;
create policy "own sub read"   on public.course_submissions for select using (auth.uid() = user_id);
create policy "own sub insert" on public.course_submissions for insert with check (auth.uid() = user_id);
create policy "own sub update" on public.course_submissions for update using (auth.uid() = user_id);

-- El admin ve todas las entregas y las califica
drop policy if exists "admin sub read"   on public.course_submissions;
drop policy if exists "admin sub update" on public.course_submissions;
create policy "admin sub read" on public.course_submissions for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "admin sub update" on public.course_submissions for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
