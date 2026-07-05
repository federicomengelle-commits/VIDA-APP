-- ============================================================
-- VIDA · Fase 1 — Seed de Nutrición (config + anclas + combos)
-- Correr DESPUÉS de 00_core.sql y 01_nutricion.sql, y DESPUÉS de
-- crear tu usuario en Authentication → Users (ver SETUP.md).
-- Idempotente: correrlo dos veces es safe (guards anti-duplicado).
-- Los valores del usuario viven ACÁ y en user_config — jamás en JS.
-- ============================================================

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

  raise notice 'Seedeando datos de Nutrición para % (%)', v_email, v_user;

  -- ------------------------------------------------------------
  -- 1. user_profile (por si el usuario se creó antes del trigger)
  -- ------------------------------------------------------------
  insert into public.user_profile (user_id, nombre)
  values (v_user, split_part(v_email, '@', 1))
  on conflict (user_id) do nothing;

  -- ------------------------------------------------------------
  -- 2. user_config · módulo 'nutricion' (upsert: re-correr actualiza)
  -- ------------------------------------------------------------
  insert into public.user_config (user_id, modulo, clave, valor) values
    (v_user, 'nutricion', 'proteina_target',
     '{"target_g":160,"piso_g":140,"base":"masa magra / peso de referencia","override":"Dra. Briner pisa Mifflin-St Jeor"}'::jsonb),
    (v_user, 'nutricion', 'referencia_corporal',
     '{"peso_kg":144.8,"altura_cm":180}'::jsonb),
    (v_user, 'nutricion', 'ayuno',
     '{"ultima_comida":"21:00","primera_comida":"14:00","no_rompen":["café negro","agua"]}'::jsonb),
    (v_user, 'nutricion', 'slots',
     '[{"id":"almuerzo","label":"Almuerzo","hora":"14:00"},{"id":"merienda","label":"Merienda","hora":"17:30"},{"id":"cena","label":"Cena","hora":"21:00","nota":"liviana: bajo carbo/grasa, proteína completa"}]'::jsonb),
    (v_user, 'nutricion', 'compensacion',
     '{"regla":"Si se saltea la merienda: sumar 1 scoop de whey suelto (25 g) o subir la carne del almuerzo.","aplica_slot":"merienda","sugerencia_g":25}'::jsonb),
    (v_user, 'nutricion', 'creatina',
     '{"tipo":"monohidrato","dosis_g":"3-5","frecuencia":"todos los días","nota":"por saturación, no timing; anclar a hábito fijo (cruza con módulo Rutina)"}'::jsonb)
  on conflict (user_id, modulo, clave)
  do update set valor = excluded.valor, updated_at = now();

  -- ------------------------------------------------------------
  -- 3. nutricion_alimentos · 16 anclas (macros idénticos a CLAUDE.md §5)
  --    + queso proteico provisorio (es_ancla = false)
  --    Guard: no inserta si ya existe (user_id + nombre + porcion)
  -- ------------------------------------------------------------
  insert into public.nutricion_alimentos (user_id, nombre, porcion, prot, carbo, grasa, kcal, es_ancla, notas)
  select v_user, x.nombre, x.porcion, x.prot, x.carbo, x.grasa, x.kcal, x.es_ancla, x.notas
  from (values
    ('Carne roja magra'::text,                   '200 g'::text,          53::numeric,  0::numeric,   16::numeric,  350::numeric, true,  null::text),
    ('Carne roja magra',                         '250 g',                66,           0,            20,           440,          true,  null),
    ('Cuadril',                                  '150 g',                40,           0,            12,           270,          true,  null),
    ('Pollo pechuga',                            '150 g',                45,           0,            5,            230,          true,  null),
    ('Pescado blanco',                           '150 g',                30,           0,            3,            150,          true,  null),
    ('Huevo',                                    '2 u',                  12,           1,            10,           155,          true,  null),
    ('Whey ENA Vainilla Ice Cream',              '1 scoop (31 g)',       25,           2.7,          2.5,          123,          true,  null),
    ('Yogur griego Serenísima s/endulzar',       '150 g',                13,           6,            7,            125,          true,  null),
    ('Jamón cocido',                             '40 g',                 7,            0,            4,            65,           true,  null),
    ('Lomito',                                   '40 g',                 8,            0,            3,            60,           true,  null),
    ('Pan G4U ciabatta',                         '1 porción',            14,           3,            2,            100,          true,  null),
    ('Rapidita G4U',                             '1 u',                  5,            4,            1,            45,           true,  'carbo asumido por coherencia con línea G4U — confirmar con etiqueta'),
    ('Frutos secos',                             '30 g',                 6,            6,            18,           200,          true,  null),
    ('Palta',                                    '½',                    2,            6,            15,           160,          true,  null),
    ('Banana',                                   '1 mediana',            1,            27,           0,            105,          true,  null),
    ('Manzana',                                  '½',                    0,            13,           0,            50,           true,  null),
    ('Queso proteico',                           '30 g',                 8,            0,            0,            32,           false, 'provisorio — confirmar etiqueta (solo prot estimada; carbo/grasa/kcal pendientes)')
  ) as x(nombre, porcion, prot, carbo, grasa, kcal, es_ancla, notas)
  where not exists (
    select 1 from public.nutricion_alimentos a
    where a.user_id = v_user
      and a.nombre  = x.nombre
      and a.porcion = x.porcion
  );

  -- ------------------------------------------------------------
  -- 4. nutricion_combos · 4 combos exactos de CLAUDE.md §5
  --    (slot en minúscula matcheando ids de user_config 'slots')
  --    Guard: no inserta si ya existe (user_id + nombre)
  -- ------------------------------------------------------------
  insert into public.nutricion_combos (user_id, nombre, slot, prot, carbo, grasa, kcal, ingredientes, favorito, notas)
  select v_user, x.nombre, x.slot, x.prot, x.carbo, x.grasa, x.kcal, x.ingredientes, true, x.notas
  from (values
    ('Batido'::text, 'merienda'::text, 45::numeric, 42::numeric, 27::numeric, 490::numeric,
     '[{"nombre":"Yogur griego Serenísima s/endulzar","cantidad":150,"unidad":"g"},
       {"nombre":"Whey ENA Vainilla Ice Cream","cantidad":1,"unidad":"scoop"},
       {"nombre":"Frutos secos","cantidad":30,"unidad":"g"},
       {"nombre":"Banana","cantidad":1,"unidad":"u"}]'::jsonb,
     'yogur griego + whey + f.secos + banana'::text),
    ('Tostada', 'merienda', 40, 16, 24, 480,
     '[{"nombre":"Pan G4U ciabatta","cantidad":2,"unidad":"porción"},
       {"nombre":"Palta","cantidad":0.5,"unidad":"u"},
       {"nombre":"Huevo","cantidad":2,"unidad":"u"},
       {"nombre":"Café con leche","cantidad":1,"unidad":"u"}]'::jsonb,
     '2 pan G4U + palta + huevo + café c/leche'),
    ('Tostado', 'cena', 51, 7, 15, 330,
     '[{"nombre":"Pan G4U ciabatta","cantidad":2,"unidad":"porción"},
       {"nombre":"Jamón cocido","cantidad":40,"unidad":"g"},
       {"nombre":"Lomito","cantidad":40,"unidad":"g"},
       {"nombre":"Queso proteico","cantidad":30,"unidad":"g"}]'::jsonb,
     '2 pan G4U + jamón + lomito + queso'),
    ('Rapiditas', 'cena', 66, 20, 20, 550,
     '[{"nombre":"Rapidita G4U","cantidad":4,"unidad":"u"},
       {"nombre":"Cuadril","cantidad":150,"unidad":"g"},
       {"nombre":"Huevo","cantidad":2,"unidad":"u"},
       {"nombre":"Verdura","cantidad":1,"unidad":"porción"}]'::jsonb,
     '4 rapi + cuadril 150 g + huevo + verdura — carbo ~20 asumido por rapiditas')
  ) as x(nombre, slot, prot, carbo, grasa, kcal, ingredientes, notas)
  where not exists (
    select 1 from public.nutricion_combos c
    where c.user_id = v_user
      and c.nombre  = x.nombre
  );

  raise notice 'Seed de Nutrición OK: config (6 claves), % alimentos, % combos para el usuario %.',
    (select count(*) from public.nutricion_alimentos where user_id = v_user),
    (select count(*) from public.nutricion_combos   where user_id = v_user),
    v_email;
end;
$$;
