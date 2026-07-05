-- ============================================================
-- VIDA · Fase 3 — Rutina: tablas + RLS + índices + seed
-- Correr DESPUÉS de sql/00_core.sql, en el SQL Editor de Supabase,
-- y DESPUÉS de crear tu usuario en Authentication → Users (SETUP.md).
-- Idempotente: correrlo dos veces es safe (guards anti-duplicado).
-- Nota: SIN check constraints sobre datos de rutina — los días,
-- items y demás son DATA del usuario (tablas), no enums del sistema.
-- La rutina "Mañana" seedeada es un ejemplo editable, no dogma.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas
-- ------------------------------------------------------------

create table if not exists public.rutina_rutinas (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  nombre     text not null,
  icono      text,                                 -- emoji
  items      jsonb not null default '[]'::jsonb,   -- [{"id":"<uuid-o-slug>","label":"Creatina 3-5 g","nota":""}]
  dias       jsonb not null default '[]'::jsonb,   -- [0..6] lunes=0; días en que aplica. [] = solo lanzamiento manual
  activa     boolean default true,
  orden      integer default 0,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.rutina_checks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  fecha      date not null,
  rutina_id  uuid not null references public.rutina_rutinas(id) on delete cascade,
  item_id    text not null,
  created_at timestamptz default now(),
  unique (user_id, fecha, rutina_id, item_id)
);

-- ------------------------------------------------------------
-- 2. Índices
-- ------------------------------------------------------------

create index if not exists idx_rutina_checks_user_fecha on public.rutina_checks (user_id, fecha);

-- ------------------------------------------------------------
-- 3. RLS — rutina_rutinas (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.rutina_rutinas enable row level security;

drop policy if exists rutina_rutinas_select on public.rutina_rutinas;
create policy rutina_rutinas_select on public.rutina_rutinas
  for select using (user_id = auth.uid());

drop policy if exists rutina_rutinas_insert on public.rutina_rutinas;
create policy rutina_rutinas_insert on public.rutina_rutinas
  for insert with check (user_id = auth.uid());

drop policy if exists rutina_rutinas_update on public.rutina_rutinas;
create policy rutina_rutinas_update on public.rutina_rutinas
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rutina_rutinas_delete on public.rutina_rutinas;
create policy rutina_rutinas_delete on public.rutina_rutinas
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. RLS — rutina_checks
-- ------------------------------------------------------------

alter table public.rutina_checks enable row level security;

drop policy if exists rutina_checks_select on public.rutina_checks;
create policy rutina_checks_select on public.rutina_checks
  for select using (user_id = auth.uid());

drop policy if exists rutina_checks_insert on public.rutina_checks;
create policy rutina_checks_insert on public.rutina_checks
  for insert with check (user_id = auth.uid());

drop policy if exists rutina_checks_update on public.rutina_checks;
create policy rutina_checks_update on public.rutina_checks
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rutina_checks_delete on public.rutina_checks;
create policy rutina_checks_delete on public.rutina_checks
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. Seed · rutina de ejemplo "Mañana" para el primer usuario
--    Guard anti-duplicado (user_id + nombre). Es DATA editable.
-- ------------------------------------------------------------

do $$
declare
  v_user  uuid;
  v_email text;
begin
  -- Primer usuario dado de alta en el proyecto
  select id, email into v_user, v_email
  from auth.users
  order by created_at
  limit 1;

  if v_user is null then
    raise exception 'No hay usuarios en auth.users. Primero creá el usuario en Authentication → Users (SETUP.md, paso 3) y después corré este seed.';
  end if;

  raise notice 'Seedeando rutina de ejemplo para % (%)', v_email, v_user;

  insert into public.rutina_rutinas (user_id, nombre, icono, items, dias, activa, orden)
  select
    v_user,
    'Mañana',
    '☀️',
    '[{"id":"creatina","label":"Creatina monohidrato 3-5 g","nota":"todos los días — por saturación, no timing"},
      {"id":"suplementos-am","label":"Suplementos AM","nota":""},
      {"id":"skincare","label":"Skincare","nota":""}]'::jsonb,
    '[0,1,2,3,4,5,6]'::jsonb,
    true,
    0
  where not exists (
    select 1 from public.rutina_rutinas r
    where r.user_id = v_user
      and r.nombre  = 'Mañana'
  );

  raise notice 'Seed de Rutina OK: % rutina(s) para el usuario %.',
    (select count(*) from public.rutina_rutinas where user_id = v_user),
    v_email;
end;
$$;

-- Listo: módulo Rutina creado.
