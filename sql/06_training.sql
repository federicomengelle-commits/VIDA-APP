-- ============================================================
-- VIDA · Fase 4 — Training: tablas + RLS + índices + seed
-- Correr DESPUÉS de sql/00_core.sql, en el SQL Editor de Supabase,
-- y DESPUÉS de crear tu usuario en Authentication → Users (SETUP.md).
-- Idempotente: correrlo dos veces es safe (guards anti-duplicado).
-- Nota: SIN check constraints sobre grupo/unidad — son config por
-- usuario (user_config), no enums del sistema. Los ejercicios base
-- seedeados son un catálogo editable, no dogma.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas
--    Orden por FK: ejercicios y sesiones ANTES que sets.
--    training_sets.sesion_id  → on delete cascade (borrar sesión borra sus sets).
--    training_sets.ejercicio_id → SIN cascade (no borrar historial al tocar catálogo).
-- ------------------------------------------------------------

create table if not exists public.training_ejercicios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  nombre     text not null,
  grupo      text,                                 -- id de config 'grupos' (ej. 'pecho','espalda','pierna'...)
  unidad     text not null default 'kg',           -- unidad de carga
  nota       text,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.training_sesiones (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  fecha      date not null,
  nombre     text,                                 -- opcional ('Push A', 'Pierna'...)
  nota       text,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.training_sets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  sesion_id    uuid not null references public.training_sesiones(id) on delete cascade,
  ejercicio_id uuid not null references public.training_ejercicios(id),
  orden        integer default 0,                  -- orden del ejercicio dentro de la sesión
  set_num      integer default 1,                  -- número de serie
  peso         numeric default 0,
  reps         integer default 0,
  rpe          numeric,                            -- esfuerzo percibido opcional (RPE 1-10)
  completado   boolean default true,
  created_at   timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. Índices
-- ------------------------------------------------------------

create index if not exists idx_training_sesiones_user_fecha on public.training_sesiones (user_id, fecha);
create index if not exists idx_training_sets_user_ejercicio on public.training_sets (user_id, ejercicio_id);
create index if not exists idx_training_sets_sesion         on public.training_sets (sesion_id);

-- ------------------------------------------------------------
-- 3. RLS — training_ejercicios (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.training_ejercicios enable row level security;

drop policy if exists training_ejercicios_select on public.training_ejercicios;
create policy training_ejercicios_select on public.training_ejercicios
  for select using (user_id = auth.uid());

drop policy if exists training_ejercicios_insert on public.training_ejercicios;
create policy training_ejercicios_insert on public.training_ejercicios
  for insert with check (user_id = auth.uid());

drop policy if exists training_ejercicios_update on public.training_ejercicios;
create policy training_ejercicios_update on public.training_ejercicios
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists training_ejercicios_delete on public.training_ejercicios;
create policy training_ejercicios_delete on public.training_ejercicios
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. RLS — training_sesiones
-- ------------------------------------------------------------

alter table public.training_sesiones enable row level security;

drop policy if exists training_sesiones_select on public.training_sesiones;
create policy training_sesiones_select on public.training_sesiones
  for select using (user_id = auth.uid());

drop policy if exists training_sesiones_insert on public.training_sesiones;
create policy training_sesiones_insert on public.training_sesiones
  for insert with check (user_id = auth.uid());

drop policy if exists training_sesiones_update on public.training_sesiones;
create policy training_sesiones_update on public.training_sesiones
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists training_sesiones_delete on public.training_sesiones;
create policy training_sesiones_delete on public.training_sesiones
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. RLS — training_sets
-- ------------------------------------------------------------

alter table public.training_sets enable row level security;

drop policy if exists training_sets_select on public.training_sets;
create policy training_sets_select on public.training_sets
  for select using (user_id = auth.uid());

drop policy if exists training_sets_insert on public.training_sets;
create policy training_sets_insert on public.training_sets
  for insert with check (user_id = auth.uid());

drop policy if exists training_sets_update on public.training_sets;
create policy training_sets_update on public.training_sets
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists training_sets_delete on public.training_sets;
create policy training_sets_delete on public.training_sets
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 6. Seed · config del módulo 'training' + ejercicios base
--    Exige usuario existente (raise exception estilo 04_plata).
--    Idempotente: upsert de config + guard anti-duplicado (user_id+nombre).
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

  raise notice 'Seedeando datos de Training para % (%)', v_email, v_user;

  -- ----------------------------------------------------------
  -- 6.1 user_config · módulo 'training' (upsert: re-correr actualiza)
  -- ----------------------------------------------------------
  insert into public.user_config (user_id, modulo, clave, valor) values
    (v_user, 'training', 'grupos',
     '[{"id":"pecho","label":"Pecho"},{"id":"espalda","label":"Espalda"},{"id":"pierna","label":"Pierna"},{"id":"hombro","label":"Hombro"},{"id":"brazo","label":"Brazo"},{"id":"core","label":"Core"},{"id":"otro","label":"Otro"}]'::jsonb),
    (v_user, 'training', 'unidades',
     '["kg","lb","placas","seg"]'::jsonb)
  on conflict (user_id, modulo, clave)
  do update set valor = excluded.valor, updated_at = now();

  -- ----------------------------------------------------------
  -- 6.2 training_ejercicios · catálogo base (6 ejercicios editables)
  --     Guard: no inserta si ya existe (user_id + nombre).
  -- ----------------------------------------------------------
  insert into public.training_ejercicios (user_id, nombre, grupo, unidad)
  select v_user, e.nombre, e.grupo, 'kg'
  from (values
    ('Press banca',     'pecho'),
    ('Sentadilla',      'pierna'),
    ('Peso muerto',     'espalda'),
    ('Press militar',   'hombro'),
    ('Dominadas',       'espalda'),
    ('Remo con barra',  'espalda')
  ) as e(nombre, grupo)
  where not exists (
    select 1 from public.training_ejercicios te
    where te.user_id = v_user
      and te.nombre  = e.nombre
  );

  raise notice 'Seed de Training OK: config (2 claves), % ejercicio(s) en catálogo para el usuario %.',
    (select count(*) from public.training_ejercicios where user_id = v_user),
    v_email;
end;
$$;

-- Listo: módulo Training creado (tablas + RLS + índices + seed).
