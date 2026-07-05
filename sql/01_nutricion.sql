-- ============================================================
-- VIDA · Fase 1 — Nutrición: tablas + RLS + índices
-- Correr DESPUÉS de sql/00_core.sql, en el SQL Editor de Supabase.
-- Idempotente: correrlo dos veces es safe.
-- Nota: SIN check constraint sobre `slot` — los slots son config
-- por usuario (user_config), no un enum del sistema.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas
-- ------------------------------------------------------------

create table if not exists public.nutricion_alimentos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  nombre     text not null,
  porcion    text,
  prot       numeric default 0,
  carbo      numeric default 0,
  grasa      numeric default 0,
  kcal       numeric default 0,
  es_ancla   boolean default false,
  favorito   boolean default false,
  notas      text,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.nutricion_combos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  nombre       text not null,
  slot         text,
  prot         numeric default 0,
  carbo        numeric default 0,
  grasa        numeric default 0,
  kcal         numeric default 0,
  ingredientes jsonb default '[]'::jsonb,
  favorito     boolean default true,
  notas        text,
  _deleted     boolean default false,
  created_at   timestamptz default now()
);

create table if not exists public.nutricion_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  fecha       date not null,
  slot        text not null,
  item_tipo   text not null,          -- 'alimento' | 'combo' | 'custom'
  item_id     uuid,
  item_nombre text not null,
  prot        numeric default 0,
  carbo       numeric default 0,
  grasa       numeric default 0,
  kcal        numeric default 0,
  created_at  timestamptz default now()
);

create table if not exists public.nutricion_plan (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  fecha      date not null,
  slot       text not null,
  combo_id   uuid references public.nutricion_combos(id),
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. Índices
-- ------------------------------------------------------------

create index if not exists idx_nutricion_log_user_fecha  on public.nutricion_log  (user_id, fecha);
create index if not exists idx_nutricion_plan_user_fecha on public.nutricion_plan (user_id, fecha);

-- ------------------------------------------------------------
-- 3. RLS — nutricion_alimentos (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.nutricion_alimentos enable row level security;

drop policy if exists nutricion_alimentos_select on public.nutricion_alimentos;
create policy nutricion_alimentos_select on public.nutricion_alimentos
  for select using (user_id = auth.uid());

drop policy if exists nutricion_alimentos_insert on public.nutricion_alimentos;
create policy nutricion_alimentos_insert on public.nutricion_alimentos
  for insert with check (user_id = auth.uid());

drop policy if exists nutricion_alimentos_update on public.nutricion_alimentos;
create policy nutricion_alimentos_update on public.nutricion_alimentos
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutricion_alimentos_delete on public.nutricion_alimentos;
create policy nutricion_alimentos_delete on public.nutricion_alimentos
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. RLS — nutricion_combos
-- ------------------------------------------------------------

alter table public.nutricion_combos enable row level security;

drop policy if exists nutricion_combos_select on public.nutricion_combos;
create policy nutricion_combos_select on public.nutricion_combos
  for select using (user_id = auth.uid());

drop policy if exists nutricion_combos_insert on public.nutricion_combos;
create policy nutricion_combos_insert on public.nutricion_combos
  for insert with check (user_id = auth.uid());

drop policy if exists nutricion_combos_update on public.nutricion_combos;
create policy nutricion_combos_update on public.nutricion_combos
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutricion_combos_delete on public.nutricion_combos;
create policy nutricion_combos_delete on public.nutricion_combos
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. RLS — nutricion_log
-- ------------------------------------------------------------

alter table public.nutricion_log enable row level security;

drop policy if exists nutricion_log_select on public.nutricion_log;
create policy nutricion_log_select on public.nutricion_log
  for select using (user_id = auth.uid());

drop policy if exists nutricion_log_insert on public.nutricion_log;
create policy nutricion_log_insert on public.nutricion_log
  for insert with check (user_id = auth.uid());

drop policy if exists nutricion_log_update on public.nutricion_log;
create policy nutricion_log_update on public.nutricion_log
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutricion_log_delete on public.nutricion_log;
create policy nutricion_log_delete on public.nutricion_log
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 6. RLS — nutricion_plan
-- ------------------------------------------------------------

alter table public.nutricion_plan enable row level security;

drop policy if exists nutricion_plan_select on public.nutricion_plan;
create policy nutricion_plan_select on public.nutricion_plan
  for select using (user_id = auth.uid());

drop policy if exists nutricion_plan_insert on public.nutricion_plan;
create policy nutricion_plan_insert on public.nutricion_plan
  for insert with check (user_id = auth.uid());

drop policy if exists nutricion_plan_update on public.nutricion_plan;
create policy nutricion_plan_update on public.nutricion_plan
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutricion_plan_delete on public.nutricion_plan;
create policy nutricion_plan_delete on public.nutricion_plan
  for delete using (user_id = auth.uid());

-- Listo: módulo Nutrición creado.
-- Antes de correr sql/02_seed_nutricion.sql, creá tu usuario en
-- Authentication → Users (ver SETUP.md, paso 3).
