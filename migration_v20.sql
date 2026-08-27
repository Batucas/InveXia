-- ============================================================
--  InveXia · migración v20
--  Realismo del simulador: órdenes pendientes/condicionales
--  y apalancamiento simple por portafolio.
--
--  - pending_orders: cola de órdenes (límite, stop, take profit,
--    o de mercado con bolsa cerrada). Se ejecutan cuando el
--    cliente abre la app en horario de mercado y se cumple la
--    condición de precio.
--  - leverage: multiplicador de poder de compra (1x por defecto).
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

alter table public.sim_portfolios
  add column if not exists pending_orders jsonb not null default '[]'::jsonb;

alter table public.sim_portfolios
  add column if not exists leverage numeric not null default 1;
