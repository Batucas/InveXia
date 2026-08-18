-- ============================================================
--  InveXia · Migración v17
--  Los cursos ahora se estructuran en MÓDULOS (lecciones).
--   - courses.modules: lista ordenada de módulos, cada uno con
--       { id, title, description, video_url, materials:[{name,url,kind}] }
--   - course_progress.modules_done: ids de los módulos que el
--       cliente ya completó (para la barra de avance)
--  El examen y la tarea siguen siendo a nivel de curso.
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.courses
  add column if not exists modules jsonb not null default '[]'::jsonb;

alter table public.course_progress
  add column if not exists modules_done jsonb not null default '[]'::jsonb;
