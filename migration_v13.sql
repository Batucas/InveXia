-- ============================================================
--  InveXia · Migración v13
--  Fase 1 del LMS de cursos:
--   - video embebido (YouTube) por curso
--   - cursos premium (marca por curso + permiso por cliente)
--   - materiales descargables (PDF/imágenes) por curso
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

-- Curso: video, premium y materiales
alter table public.courses add column if not exists video_url  text;
alter table public.courses add column if not exists premium    boolean not null default false;
alter table public.courses add column if not exists materials  jsonb   not null default '[]'::jsonb;

-- Cliente: permiso para acceder a cursos premium (como premium_quantnet)
alter table public.profiles add column if not exists premium_courses boolean not null default false;

-- materials guarda una lista de objetos: [{ "name": "...", "url": "...", "kind": "pdf|img" }]
