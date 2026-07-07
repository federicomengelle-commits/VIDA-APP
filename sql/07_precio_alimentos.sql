-- ============================================================
-- VIDA · Cruce Nutrición↔Plata — precio por alimento
-- Correr en el SQL Editor de Supabase, DESPUÉS de sql/01_nutricion.sql.
-- Idempotente: correrlo dos veces es safe (add column if not exists).
--
-- Para qué: habilita que la lista de compras del plan semanal se
-- convierta en GASTO PROYECTADO en Plata (el "foso" cross-dominio,
-- BACKLOG.md §7). El precio es OPCIONAL por alimento: si no lo cargás,
-- ese ingrediente simplemente no suma al costo estimado (degrada limpio).
-- El precio es por la `porcion` del alimento (misma unidad que los macros).
-- ============================================================

alter table public.nutricion_alimentos
  add column if not exists precio        numeric;   -- costo de UNA porción (null = sin precio)
alter table public.nutricion_alimentos
  add column if not exists precio_moneda text;      -- moneda del precio (ej. 'ARS'); null = moneda principal

-- (Opcional) mismo par en combos, por si querés fijar el costo de un combo a mano
-- en vez de derivarlo de sus ingredientes.
alter table public.nutricion_combos
  add column if not exists precio        numeric;
alter table public.nutricion_combos
  add column if not exists precio_moneda text;

-- Listo: los alimentos/combos ahora pueden llevar precio.
-- La UI de Nutrición (y Ajustes) permite cargarlo; la lista de compras suma.
