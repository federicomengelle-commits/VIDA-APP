-- ============================================================
-- VIDA · Señales nuevas del cuerpo — peso · energía · sueño · hidratación
-- Correr en el SQL Editor de Supabase, DESPUÉS de sql/00_core.sql
-- y de crear tu usuario (Authentication → Users, SETUP.md).
-- Idempotente: correrlo dos veces es safe.
--
-- Diseño: UNA tabla-diario genérica (no una tabla por métrica). Cada fila
-- es una señal del día con un `tipo` y un `valor` jsonb flexible. Así peso,
-- energía, sueño e hidratación son filas del mismo diario y se prende/apaga
-- cada una desde config (cuerpo.metricas_activas) sin tocar el schema.
-- Habilita palancas nuevas (recuperación, sueño↔volumen, energía↔proteína)
-- y recalcular el target de proteína por peso real (CLAUDE.md §5). BACKLOG §2/§4.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla
-- ------------------------------------------------------------
create table if not exists public.cuerpo_metricas (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  fecha      date not null,
  tipo       text not null,                 -- 'peso' | 'energia' | 'sueno' | 'hidratacion' (config-driven)
  valor      jsonb not null default '{}'::jsonb,  -- ej. peso:{kg,grasa_pct} · energia:{nivel,animo} · sueno:{horas,calidad} · hidratacion:{ml,vasos}
  origen     text default 'manual',          -- 'manual' | 'voz' | 'wearable'
  nota       text,
  _deleted   boolean default false,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. Índices
-- ------------------------------------------------------------
create index if not exists idx_cuerpo_metricas_user_fecha on public.cuerpo_metricas (user_id, fecha);
create index if not exists idx_cuerpo_metricas_user_tipo  on public.cuerpo_metricas (user_id, tipo, fecha);

-- ------------------------------------------------------------
-- 3. RLS — 4 políticas explícitas (nunca FOR ALL)
-- ------------------------------------------------------------
alter table public.cuerpo_metricas enable row level security;

drop policy if exists cuerpo_metricas_select on public.cuerpo_metricas;
create policy cuerpo_metricas_select on public.cuerpo_metricas
  for select using (user_id = auth.uid());

drop policy if exists cuerpo_metricas_insert on public.cuerpo_metricas;
create policy cuerpo_metricas_insert on public.cuerpo_metricas
  for insert with check (user_id = auth.uid());

drop policy if exists cuerpo_metricas_update on public.cuerpo_metricas;
create policy cuerpo_metricas_update on public.cuerpo_metricas
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cuerpo_metricas_delete on public.cuerpo_metricas;
create policy cuerpo_metricas_delete on public.cuerpo_metricas
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. Seed · config del módulo 'cuerpo' (qué señales están activas + targets).
--    Todo editable desde Ajustes; estos son defaults, no dogma.
--    Idempotente: upsert (re-correr actualiza).
-- ------------------------------------------------------------
do $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'No hay usuarios en auth.users. Creá el usuario en Authentication → Users (SETUP.md) y volvé a correr.';
  end if;

  insert into public.user_config (user_id, modulo, clave, valor) values
    (v_user, 'cuerpo', 'metricas_activas', '["peso","energia","sueno","hidratacion"]'::jsonb),
    (v_user, 'cuerpo', 'hidratacion',      '{"ml_target":2500,"ml_vaso":250}'::jsonb),
    (v_user, 'cuerpo', 'sueno',            '{"horas_target":7.5}'::jsonb),
    (v_user, 'cuerpo', 'energia',          '{"escala":5}'::jsonb)
  on conflict (user_id, modulo, clave)
  do update set valor = excluded.valor, updated_at = now();

  raise notice 'cuerpo_metricas + config seed OK para el usuario %.', v_user;
end;
$$;

-- Listo: señales del cuerpo habilitadas (peso, energía, sueño, hidratación).
