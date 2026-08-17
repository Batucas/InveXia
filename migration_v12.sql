-- ============================================================
--  InveXia · Migración v12
--  Conexiones manuales entre cursos (malla curricular):
--  "después de este curso, sigue…" (continuaciones).
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.courses
  add column if not exists next_courses jsonb not null default '[]'::jsonb;

-- ============================================================
--  Guarda una lista de IDs de cursos a los que este curso lleva.
--  El mapa de cursos dibuja una flecha de este curso hacia cada uno.
-- ============================================================
