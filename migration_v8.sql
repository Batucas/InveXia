-- ============================================================
--  InveXia · Migración v8
--  Guarda la explicación de cartera generada por IA (una sola vez).
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.risk_assessments
  add column if not exists ai_suggestion text;

-- ============================================================
--  La asignación (porcentajes) sale de reglas deterministas;
--  este texto es solo la explicación en lenguaje natural.
-- ============================================================
