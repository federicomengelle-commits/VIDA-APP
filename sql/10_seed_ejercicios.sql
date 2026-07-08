-- ============================================================
-- VIDA · Seed extra de Training — 51 ejercicios por grupo muscular
-- Nombres en español rioplatense (como se dicen en un gym argentino).
-- Correr en el SQL Editor de Supabase, DESPUÉS de sql/06_training.sql
-- (que crea la tabla training_ejercicios + RLS + config grupos/unidades).
-- Idempotente: correrlo dos veces es safe (guard por user_id + nombre).
--
-- Complementa los 6 ejercicios base de 06 (Press banca, Sentadilla, Peso
-- muerto, Press militar, Dominadas, Remo con barra): NO los repite.
-- grupo ∈ {pecho, espalda, pierna, hombro, brazo, core} (ids de config).
-- unidad = 'kg' salvo isométricos por tiempo → 'seg'.
-- Regla de oro: catálogo del usuario, EDITABLE desde la app — no dogma.
-- ============================================================

do $$
declare
  v_user  uuid;
  v_email text;
  v_ins   integer;
begin
  -- Guard amigable: la tabla la crea sql/06. Si no está, avisar claro.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'training_ejercicios'
  ) then
    raise exception 'Falta la tabla training_ejercicios. Corré primero sql/06_training.sql (crea tablas + RLS + config de Training) y después este seed.';
  end if;

  -- Primer usuario dado de alta en el proyecto
  select id, email into v_user, v_email
  from auth.users
  order by created_at
  limit 1;

  if v_user is null then
    raise exception 'No hay usuarios en auth.users. Primero creá el usuario en Authentication → Users (SETUP.md, paso 3) y después corré este seed.';
  end if;

  raise notice 'Seedeando ejercicios de Training para % (%)', v_email, v_user;

  -- ----------------------------------------------------------
  -- Safety: re-asegura la config de grupos/unidades (por si sólo
  -- se corrió la parte de tablas de 06). Upsert idempotente.
  -- ----------------------------------------------------------
  insert into public.user_config (user_id, modulo, clave, valor) values
    (v_user, 'training', 'grupos',
     '[{"id":"pecho","label":"Pecho"},{"id":"espalda","label":"Espalda"},{"id":"pierna","label":"Pierna"},{"id":"hombro","label":"Hombro"},{"id":"brazo","label":"Brazo"},{"id":"core","label":"Core"},{"id":"otro","label":"Otro"}]'::jsonb),
    (v_user, 'training', 'unidades',
     '["kg","lb","placas","seg"]'::jsonb)
  on conflict (user_id, modulo, clave)
  do update set valor = excluded.valor, updated_at = now();

  -- ----------------------------------------------------------
  -- training_ejercicios · 51 ejercicios (8-9 por grupo)
  --   Guard: no inserta si ya existe (user_id + nombre).
  -- ----------------------------------------------------------
  insert into public.training_ejercicios (user_id, nombre, grupo, unidad)
  select v_user, e.nombre, e.grupo, e.unidad
  from (values
    -- PECHO (8) -----------------------------------------------------
    ('Press inclinado con mancuernas'::text, 'pecho'::text,   'kg'::text),
    ('Press plano con mancuernas',           'pecho',         'kg'),
    ('Press inclinado con barra',            'pecho',         'kg'),
    ('Aperturas con mancuernas',             'pecho',         'kg'),
    ('Cruce de poleas',                      'pecho',         'kg'),
    ('Peck deck',                            'pecho',         'kg'),
    ('Fondos en paralelas',                  'pecho',         'kg'),
    ('Press en máquina',                     'pecho',         'kg'),
    -- ESPALDA (9) ---------------------------------------------------
    ('Jalón al pecho',                       'espalda',       'kg'),
    ('Jalón con agarre cerrado',             'espalda',       'kg'),
    ('Remo con mancuerna',                   'espalda',       'kg'),
    ('Remo en polea baja',                   'espalda',       'kg'),
    ('Remo en máquina',                      'espalda',       'kg'),
    ('Remo en T',                            'espalda',       'kg'),
    ('Pullover',                             'espalda',       'kg'),
    ('Dominadas supinas',                    'espalda',       'kg'),
    ('Hiperextensiones',                     'espalda',       'kg'),
    -- PIERNA (9) ----------------------------------------------------
    ('Prensa 45°',                           'pierna',        'kg'),
    ('Hack',                                 'pierna',        'kg'),
    ('Extensiones de cuádriceps',            'pierna',        'kg'),
    ('Curl femoral acostado',                'pierna',        'kg'),
    ('Peso muerto rumano',                   'pierna',        'kg'),
    ('Hip thrust',                           'pierna',        'kg'),
    ('Zancadas',                             'pierna',        'kg'),
    ('Sentadilla búlgara',                   'pierna',        'kg'),
    ('Gemelos en máquina',                   'pierna',        'kg'),
    -- HOMBRO (8) ----------------------------------------------------
    ('Press con mancuernas',                 'hombro',        'kg'),
    ('Elevaciones laterales',                'hombro',        'kg'),
    ('Vuelos posteriores',                   'hombro',        'kg'),
    ('Press Arnold',                         'hombro',        'kg'),
    ('Remo al mentón',                       'hombro',        'kg'),
    ('Elevaciones frontales',                'hombro',        'kg'),
    ('Face pull',                            'hombro',        'kg'),
    ('Elevaciones laterales en polea',       'hombro',        'kg'),
    -- BRAZO (9) -----------------------------------------------------
    ('Curl con barra',                       'brazo',         'kg'),
    ('Curl con mancuernas',                  'brazo',         'kg'),
    ('Curl martillo',                        'brazo',         'kg'),
    ('Curl predicador',                      'brazo',         'kg'),
    ('Curl concentrado',                     'brazo',         'kg'),
    ('Extensión de tríceps en polea',        'brazo',         'kg'),
    ('Press francés',                        'brazo',         'kg'),
    ('Fondos en banco',                      'brazo',         'kg'),
    ('Press cerrado',                        'brazo',         'kg'),
    -- CORE (8) ------------------------------------------------------
    ('Plancha',                              'core',          'seg'),
    ('Plancha lateral',                      'core',          'seg'),
    ('Abdominales en polea',                 'core',          'kg'),
    ('Elevación de piernas',                 'core',          'kg'),
    ('Rueda abdominal',                      'core',          'kg'),
    ('Russian twist',                        'core',          'kg'),
    ('Crunch',                               'core',          'kg'),
    ('Mountain climbers',                    'core',          'seg')
  ) as e(nombre, grupo, unidad)
  where not exists (
    select 1 from public.training_ejercicios te
    where te.user_id = v_user
      and te.nombre  = e.nombre
  );

  get diagnostics v_ins = row_count;

  raise notice 'Seed ejercicios OK: % nuevos insertados; % ejercicios en total para %.',
    v_ins,
    (select count(*) from public.training_ejercicios where user_id = v_user and coalesce(_deleted,false) = false),
    v_email;
end;
$$;

-- Listo: catálogo de Training ampliado a ~57 ejercicios (6 base + 51).
-- Editables desde Training. Re-correr es idempotente.
