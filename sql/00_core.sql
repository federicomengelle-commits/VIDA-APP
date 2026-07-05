-- ============================================================
-- VIDA · Fase 0 — Core: user_profile + user_config + RLS + trigger
-- Pegar completo en el SQL Editor de Supabase y correr.
-- Idempotente: correrlo dos veces es safe.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tablas core
-- ------------------------------------------------------------

create table if not exists public.user_profile (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nombre     text,
  created_at timestamptz default now()
);

create table if not exists public.user_config (
  user_id    uuid not null references auth.users(id) on delete cascade,
  modulo     text not null,
  clave      text not null,
  valor      jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, modulo, clave)
);

-- ------------------------------------------------------------
-- 2. RLS — user_profile (4 políticas explícitas, nunca FOR ALL)
-- ------------------------------------------------------------

alter table public.user_profile enable row level security;

drop policy if exists user_profile_select on public.user_profile;
create policy user_profile_select on public.user_profile
  for select using (user_id = auth.uid());

drop policy if exists user_profile_insert on public.user_profile;
create policy user_profile_insert on public.user_profile
  for insert with check (user_id = auth.uid());

drop policy if exists user_profile_update on public.user_profile;
create policy user_profile_update on public.user_profile
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_profile_delete on public.user_profile;
create policy user_profile_delete on public.user_profile
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 3. RLS — user_config (4 políticas explícitas)
-- ------------------------------------------------------------

alter table public.user_config enable row level security;

drop policy if exists user_config_select on public.user_config;
create policy user_config_select on public.user_config
  for select using (user_id = auth.uid());

drop policy if exists user_config_insert on public.user_config;
create policy user_config_insert on public.user_config
  for insert with check (user_id = auth.uid());

drop policy if exists user_config_update on public.user_config;
create policy user_config_update on public.user_config
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_config_delete on public.user_config;
create policy user_config_delete on public.user_config
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. Trigger: alta en auth.users → crea user_profile automático
--    (security definer: corre con permisos del owner y salta RLS)
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profile (user_id, nombre)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1))
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Listo: core creado. Seguí con sql/01_nutricion.sql.
