-- ============================================================
--  InveXia · Migración v14
--  Fase 2 del LMS de cursos:
--   - examen de opción múltiple por curso (auto-calificado)
--   - progreso por usuario (curso completado + nota del examen)
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- Examen guardado en el propio curso:
--   [{ "q": "pregunta", "options": ["a","b","c"], "correct": 0 }, ...]
alter table public.courses add column if not exists exam jsonb not null default '[]'::jsonb;

-- Progreso por usuario y curso
create table if not exists public.course_progress (
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  completed   boolean not null default false,
  exam_score  numeric,                    -- porcentaje 0-100 del último intento
  updated_at  timestamptz not null default now(),
  primary key (user_id, course_id)
);

alter table public.course_progress enable row level security;

-- El usuario gestiona su propio progreso
drop policy if exists "own progress read"   on public.course_progress;
drop policy if exists "own progress insert" on public.course_progress;
drop policy if exists "own progress update" on public.course_progress;
create policy "own progress read"   on public.course_progress for select using (auth.uid() = user_id);
create policy "own progress insert" on public.course_progress for insert with check (auth.uid() = user_id);
create policy "own progress update" on public.course_progress for update using (auth.uid() = user_id);

-- El admin puede ver el progreso de todos (para seguimiento / futuras fases)
drop policy if exists "admin progress read" on public.course_progress;
create policy "admin progress read" on public.course_progress for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
