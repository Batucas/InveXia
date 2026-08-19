-- ============================================================
--  InveXia · Migración v18
--  Categoría por curso (área temática) para el mapa tipo malla,
--  con clasificación por color estilo "Camino Quant".
--  Ejecutar en: Supabase > SQL Editor > New query > Run
-- ============================================================

alter table public.courses
  add column if not exists category text not null default 'fund';

-- Claves válidas: fund, econ, rv, rf, mp, alt, risk, deriv, hedge, quant
