-- ============================================================
-- VIDA · Seed extra de Nutrición — 39 alimentos comunes (Argentina)
-- Macros reales por porción (USDA / Argenfoods-UNLu / etiquetas AR) +
-- precio estimado de la porción (relevamiento supermercado AR, jul-2026).
-- Correr en el SQL Editor de Supabase, DESPUÉS de 01_nutricion.sql.
-- (No exige 07: se auto-agregan las columnas precio/precio_moneda por las dudas.)
-- Idempotente: correrlo dos veces es safe (guard por user_id + nombre + porcion).
--
-- Complementa el seed base (02): NO repite ninguno de esos 17 alimentos.
-- Regla de oro: es catálogo del usuario, EDITABLE desde la app — no dogma.
--
-- Sobre los PRECIOS: son ARS, estimados de góndola/mayorista (Coto, Carrefour,
-- Jumbo, Día, Distribuidora del Sur, mayoristas), relevados jun–jul 2026. En
-- Argentina se desactualizan rápido → tomalos como orden de magnitud y ajustalos
-- desde Ajustes/Nutrición. El precio es por la `porcion` indicada.
-- Sobre es_ancla: true solo en las proteínas base (carnes/pescado/soja) para que
-- la vista de "anclas" siga siendo útil ahora que el catálogo es grande.
-- ============================================================

-- Auto-suficiente: si no se corrió 07, agrega las columnas de precio.
alter table public.nutricion_alimentos add column if not exists precio        numeric;
alter table public.nutricion_alimentos add column if not exists precio_moneda text;

do $$
declare
  v_user  uuid;
  v_email text;
  v_ins   integer;
begin
  -- Primer usuario dado de alta en el proyecto
  select id, email into v_user, v_email
  from auth.users
  order by created_at
  limit 1;

  if v_user is null then
    raise exception 'No hay usuarios en auth.users. Primero creá el usuario en Authentication → Users (SETUP.md, paso 3) y después corré este seed.';
  end if;

  raise notice 'Seedeando alimentos AR para % (%)', v_email, v_user;

  -- ------------------------------------------------------------
  -- nutricion_alimentos · 39 alimentos comunes (macros por porción + precio ARS)
  --   Guard: no inserta si ya existe (user_id + nombre + porcion).
  --   precio_moneda = 'ARS'. favorito queda en default (false).
  -- ------------------------------------------------------------
  insert into public.nutricion_alimentos
    (user_id, nombre, porcion, prot, carbo, grasa, kcal, es_ancla, notas, precio, precio_moneda)
  select v_user, x.nombre, x.porcion, x.prot, x.carbo, x.grasa, x.kcal, x.es_ancla, x.notas, x.precio, 'ARS'
  from (values
    -- CARNES / PROTEÍNA (es_ancla = true) ------------------------------------
    ('Bife de chorizo'::text,          '200 g'::text,               54::numeric, 0::numeric,   28::numeric, 470::numeric, true,  2800::numeric, null::text),
    ('Tira de asado',                  '200 g',                     50,          0,            44,          600,          true,  2400,          'grasa variable según desgrase (rango 480-680 kcal)'),
    ('Milanesa de carne al horno',     '150 g',                     27,          21,           14,          320,          true,  1800,          'al horno; varía con la receta'),
    ('Carne picada común',             '150 g',                     39,          0,            25,          380,          true,  1035,          null),
    ('Nalga magra',                    '200 g',                     62,          0,            9,           335,          true,  2400,          null),
    ('Bondiola de cerdo',              '150 g',                     35,          0,            28,          400,          true,  1575,          null),
    ('Muslo de pollo sin piel',        '150 g',                     37,          0,            12,          270,          true,  975,           null),
    ('Atún al natural',                '1 lata (120 g esc.)',       28,          0,            1.2,         130,          true,  3200,          'proteína varía 19-26 g/100 g según marca'),
    ('Merluza',                        '150 g',                     33,          0,            2,           155,          true,  2400,          null),
    ('Salmón',                         '150 g',                     33,          0,            19,          310,          true,  4725,          null),
    ('Milanesa de soja',               '2 u',                       18,          46,           19,          430,          true,  2572,          'varía por marca (~215 kcal/u; base Granja del Sol)'),
    -- LÁCTEOS (es_ancla = false) ---------------------------------------------
    ('Leche entera',                   '200 ml',                    6.2,         9.4,          6.6,         122,          false, 351,           null),
    ('Leche descremada',               '200 ml',                    6.4,         9.6,          0.6,         70,           false, 367,           null),
    ('Queso port salut',               '40 g',                      9.5,         0.2,          11,          140,          false, 500,           null),
    ('Queso cremoso',                  '40 g',                      7.5,         0.5,          10,          122,          false, 425,           null),
    ('Muzzarella',                     '40 g',                      8,           0.9,          8.4,         112,          false, 480,           null),
    ('Queso rallado',                  '20 g',                      7,           0.6,          5.8,         84,           false, 360,           'sardo/reggianito'),
    ('Ricota entera',                  '100 g',                     11,          4,            14,          185,          false, 900,           'marca varía 175-209 kcal/100 g'),
    ('Dulce de leche',                 '20 g (1 cda)',              1.3,         11.5,         1.3,         63,           false, 165,           null),
    -- CARBOS / CEREALES (es_ancla = false) -----------------------------------
    ('Arroz blanco cocido',            '150 g',                     4,           42,           0.4,         195,          false, 100,           null),
    ('Fideos cocidos',                 '150 g',                     8.7,         46,           1.4,         235,          false, 195,           null),
    ('Papa hervida',                   '200 g',                     3.8,         40,           0.2,         175,          false, 300,           null),
    ('Batata hervida',                 '150 g',                     2.1,         26.5,         0.2,         115,          false, 255,           null),
    ('Pan francés',                    '50 g (1 miñón)',            4.4,         27,           1,           138,          false, 190,           null),
    ('Avena arrollada',                '40 g',                      6.8,         26.5,         2.8,         155,          false, 224,           null),
    ('Polenta cocida',                 '200 g',                     3,           30,           0.8,         140,          false, 81,            null),
    ('Galletitas de agua',             '30 g',                      3,           22,           2.6,         125,          false, 190,           null),
    -- LEGUMBRES (es_ancla = false) -------------------------------------------
    ('Lentejas cocidas',               '150 g',                     13.5,        30,           0.6,         175,          false, 160,           null),
    ('Garbanzos cocidos',              '150 g',                     13.4,        41,           3.9,         245,          false, 144,           null),
    -- FRUTAS (es_ancla = false) ----------------------------------------------
    ('Naranja',                        '1 mediana',                 1.2,         15.3,         0.1,         61,           false, 208,           null),
    ('Pera',                           '1 mediana',                 0.6,         22.8,         0.2,         86,           false, 195,           null),
    ('Frutilla',                       '150 g',                     1,           11.5,         0.5,         48,           false, 1650,          null),
    -- VERDURAS (es_ancla = false) --------------------------------------------
    ('Tomate',                         '1 mediano',                 1.1,         4.7,          0.2,         22,           false, 240,           null),
    ('Zanahoria',                      '1 mediana',                 0.7,         6.7,          0.1,         29,           false, 112,           null),
    ('Brócoli',                        '100 g',                     2.8,         6.6,          0.4,         34,           false, 250,           null),
    ('Zapallo anco',                   '150 g',                     1.5,         17.6,         0.2,         68,           false, 225,           null),
    -- GRASAS / OTROS (es_ancla = false) --------------------------------------
    ('Aceite de oliva',                '1 cda (15 ml)',             0,           0,            13.5,        120,          false, 270,           null),
    ('Manteca',                        '10 g',                      0.1,         0,            8.1,         72,           false, 155,           null),
    ('Miel',                           '20 g (1 cda)',              0.1,         16.5,         0,           61,           false, 220,           null)
  ) as x(nombre, porcion, prot, carbo, grasa, kcal, es_ancla, precio, notas)
  where not exists (
    select 1 from public.nutricion_alimentos a
    where a.user_id = v_user
      and a.nombre  = x.nombre
      and a.porcion = x.porcion
  );

  get diagnostics v_ins = row_count;

  raise notice 'Seed alimentos AR OK: % nuevos insertados; % alimentos en total para %.',
    v_ins,
    (select count(*) from public.nutricion_alimentos where user_id = v_user and coalesce(_deleted,false) = false),
    v_email;
end;
$$;

-- Listo: 39 alimentos argentinos con macros + precio estimado (jul-2026).
-- Editables desde Nutrición/Ajustes. Re-correr es idempotente.
