-- ============================================================
-- VIDA · Fase 2 — Plata: tablas + RLS + índices + seed
-- Correr DESPUÉS de sql/00_core.sql, en el SQL Editor de Supabase.
-- Idempotente: correrlo dos veces es safe.
-- Nota: SIN check constraints sobre tipo/ambito/categoria/moneda —
-- son config por usuario (user_config), no enums del sistema.
-- El seed exige que ya exista tu usuario en Authentication → Users.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas (objetivos primero: plata_movimientos tiene FK a él)
-- ------------------------------------------------------------

create table if not exists public.plata_objetivos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  nombre       text not null,
  target_monto numeric,                      -- null = sin definir todavía
  moneda       text not null default 'USD',
  nota         text,
  activo       boolean default true,
  _deleted     boolean default false,
  created_at   timestamptz default now()
);

create table if not exists public.plata_movimientos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  fecha       date not null,
  tipo        text not null,                 -- 'ingreso' | 'egreso'
  monto       numeric not null,
  moneda      text not null default 'ARS',
  ambito      text not null,                 -- id de config 'ambitos' (ej. 'personal' | 'mepex')
  categoria   text,
  descripcion text,
  fuente      text,                          -- de dónde viene / a dónde va (ej. 'MEPEX', 'Mercado Pago')
  objetivo_id uuid references public.plata_objetivos(id),  -- si es aporte a un objetivo
  origen      text not null default 'manual',              -- 'manual' | 'voz' | 'foto' (IA, Fase 5)
  crudo       text,                          -- input crudo original si vino de captura (Fase 5)
  _deleted    boolean default false,
  created_at  timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. Índices
-- ------------------------------------------------------------

create index if not exists idx_plata_movimientos_user_fecha on public.plata_movimientos (user_id, fecha);

-- ------------------------------------------------------------
-- 3. RLS — plata_objetivos (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.plata_objetivos enable row level security;

drop policy if exists plata_objetivos_select on public.plata_objetivos;
create policy plata_objetivos_select on public.plata_objetivos
  for select using (user_id = auth.uid());

drop policy if exists plata_objetivos_insert on public.plata_objetivos;
create policy plata_objetivos_insert on public.plata_objetivos
  for insert with check (user_id = auth.uid());

drop policy if exists plata_objetivos_update on public.plata_objetivos;
create policy plata_objetivos_update on public.plata_objetivos
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists plata_objetivos_delete on public.plata_objetivos;
create policy plata_objetivos_delete on public.plata_objetivos
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. RLS — plata_movimientos
-- ------------------------------------------------------------

alter table public.plata_movimientos enable row level security;

drop policy if exists plata_movimientos_select on public.plata_movimientos;
create policy plata_movimientos_select on public.plata_movimientos
  for select using (user_id = auth.uid());

drop policy if exists plata_movimientos_insert on public.plata_movimientos;
create policy plata_movimientos_insert on public.plata_movimientos
  for insert with check (user_id = auth.uid());

drop policy if exists plata_movimientos_update on public.plata_movimientos;
create policy plata_movimientos_update on public.plata_movimientos
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists plata_movimientos_delete on public.plata_movimientos;
create policy plata_movimientos_delete on public.plata_movimientos
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. Seed · config del módulo 'plata' + objetivo inicial
--    Exige usuario existente (raise exception estilo 02_seed).
--    Idempotente: upsert de config + guard anti-duplicado del objetivo.
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

  raise notice 'Seedeando datos de Plata para % (%)', v_email, v_user;

  -- ----------------------------------------------------------
  -- 5.1 user_config · módulo 'plata' (upsert: re-correr actualiza)
  -- ----------------------------------------------------------
  insert into public.user_config (user_id, modulo, clave, valor) values
    (v_user, 'plata', 'monedas',
     '["ARS","USD"]'::jsonb),
    (v_user, 'plata', 'ambitos',
     '[{"id":"personal","label":"Personal"},{"id":"mepex","label":"MEPEX"}]'::jsonb),
    (v_user, 'plata', 'categorias',
     '{"ingreso":["MEPEX","Otros"],"egreso":["Vivienda","Comida","Transporte","Salud","Gym","Suscripciones","Salidas","Compras","Impuestos","Otros"]}'::jsonb)
  on conflict (user_id, modulo, clave)
  do update set valor = excluded.valor, updated_at = now();

  -- ----------------------------------------------------------
  -- 5.2 plata_objetivos · objetivo inicial 'Compra de propiedad'
  --     target_monto null (se define desde la app).
  --     Guard: no inserta si ya existe (user_id + nombre).
  -- ----------------------------------------------------------
  insert into public.plata_objetivos (user_id, nombre, target_monto, moneda, nota, activo)
  select v_user, 'Compra de propiedad', null, 'USD',
         'Definí el monto objetivo desde la app', true
  where not exists (
    select 1 from public.plata_objetivos o
    where o.user_id = v_user
      and o.nombre  = 'Compra de propiedad'
  );

  raise notice 'Seed de Plata OK: config (3 claves), % objetivo(s) para el usuario %.',
    (select count(*) from public.plata_objetivos where user_id = v_user),
    v_email;
end;
$$;

-- Listo: módulo Plata creado (tablas + RLS + seed).
