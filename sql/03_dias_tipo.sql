-- ============================================================
-- VIDA · Fase 1 (extensión) — Plantillas de día ("día tipo")
-- Correr DESPUÉS de sql/01_nutricion.sql (y del seed 02 para que
-- la plantilla seed encuentre sus alimentos/combos), en el SQL
-- Editor de Supabase.
-- Idempotente: correrlo dos veces es safe.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla
-- ------------------------------------------------------------

create table if not exists public.nutricion_dias_tipo (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  nombre     text not null,
  items      jsonb not null default '[]'::jsonb,   -- [{"slot":"almuerzo","tipo":"combo"|"alimento","item_id":"<uuid>"}]
  notas      text,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. RLS — nutricion_dias_tipo (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.nutricion_dias_tipo enable row level security;

drop policy if exists nutricion_dias_tipo_select on public.nutricion_dias_tipo;
create policy nutricion_dias_tipo_select on public.nutricion_dias_tipo
  for select using (user_id = auth.uid());

drop policy if exists nutricion_dias_tipo_insert on public.nutricion_dias_tipo;
create policy nutricion_dias_tipo_insert on public.nutricion_dias_tipo
  for insert with check (user_id = auth.uid());

drop policy if exists nutricion_dias_tipo_update on public.nutricion_dias_tipo;
create policy nutricion_dias_tipo_update on public.nutricion_dias_tipo
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nutricion_dias_tipo_delete on public.nutricion_dias_tipo;
create policy nutricion_dias_tipo_delete on public.nutricion_dias_tipo
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 3. nutricion_plan: ahora una celda puede planificar un alimento
--    suelto (combo_id XOR alimento_id — lo garantiza la app al
--    escribir, sin constraint).
-- ------------------------------------------------------------

alter table public.nutricion_plan
  add column if not exists alimento_id uuid references public.nutricion_alimentos(id);

-- ------------------------------------------------------------
-- 4. Seed — plantilla "Día tipo" para el primer usuario
--    almuerzo → Carne roja magra 250 g · merienda → Batido · cena → Tostado
--    Guard anti-duplicado: (user_id + nombre). Si un id no se
--    resuelve, raise notice y se saltea ese ítem (no exception).
-- ------------------------------------------------------------

do $$
declare
  v_user    uuid;
  v_email   text;
  v_carne   uuid;
  v_batido  uuid;
  v_tostado uuid;
  v_items   jsonb := '[]'::jsonb;
begin
  -- Primer usuario dado de alta en el proyecto
  select id, email into v_user, v_email
  from auth.users
  order by created_at
  limit 1;

  if v_user is null then
    raise exception 'No hay usuarios en auth.users. Primero creá el usuario en Authentication → Users (SETUP.md, paso 3) y después corré este seed.';
  end if;

  -- Guard anti-duplicado por (user_id, nombre)
  if exists (
    select 1 from public.nutricion_dias_tipo t
    where t.user_id = v_user
      and t.nombre  = 'Día tipo'
  ) then
    raise notice 'La plantilla "Día tipo" ya existe para % — no se re-inserta.', v_email;
    return;
  end if;

  -- Resolver ids: alimento por nombre + porción, combos por nombre
  select a.id into v_carne
  from public.nutricion_alimentos a
  where a.user_id  = v_user
    and a.nombre   = 'Carne roja magra'
    and a.porcion  = '250 g'
    and a._deleted = false
  limit 1;

  select c.id into v_batido
  from public.nutricion_combos c
  where c.user_id  = v_user
    and c.nombre   = 'Batido'
    and c._deleted = false
  limit 1;

  select c.id into v_tostado
  from public.nutricion_combos c
  where c.user_id  = v_user
    and c.nombre   = 'Tostado'
    and c._deleted = false
  limit 1;

  if v_carne is not null then
    v_items := v_items || jsonb_build_array(jsonb_build_object('slot', 'almuerzo', 'tipo', 'alimento', 'item_id', v_carne));
  else
    raise notice 'No se encontró el alimento "Carne roja magra" (250 g) — la plantilla queda sin almuerzo.';
  end if;

  if v_batido is not null then
    v_items := v_items || jsonb_build_array(jsonb_build_object('slot', 'merienda', 'tipo', 'combo', 'item_id', v_batido));
  else
    raise notice 'No se encontró el combo "Batido" — la plantilla queda sin merienda.';
  end if;

  if v_tostado is not null then
    v_items := v_items || jsonb_build_array(jsonb_build_object('slot', 'cena', 'tipo', 'combo', 'item_id', v_tostado));
  else
    raise notice 'No se encontró el combo "Tostado" — la plantilla queda sin cena.';
  end if;

  -- Self-healing: si ningún ítem resolvió (ej. corriste el 03 antes que el 02),
  -- NO insertar una plantilla vacía — así re-correr este archivo después del 02
  -- la crea completa (el guard anti-duplicado no la bloquea).
  if jsonb_array_length(v_items) = 0 then
    raise notice 'Ningún ítem se pudo resolver — corré sql/02_seed_nutricion.sql primero y volvé a correr este seed.';
    return;
  end if;

  insert into public.nutricion_dias_tipo (user_id, nombre, items)
  values (v_user, 'Día tipo', v_items);

  raise notice 'Plantilla "Día tipo" creada para % con % ítems.', v_email, jsonb_array_length(v_items);
end;
$$;

-- Listo: plantillas de día creadas. La app las usa desde el tab Semana.
