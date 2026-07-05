# VIDA — Contratos técnicos Fase 0 + Fase 1 (VINCULANTE)

> Este doc fija las interfaces exactas entre archivos para que se puedan construir en paralelo.
> Ante cualquier duda o ambigüedad del CLAUDE.md, **gana este contrato**.
> Complementa (no reemplaza) al CLAUDE.md raíz: la spec funcional vive allá (§5).

## 1. Stack y convenciones globales

- Vanilla JS con **ES modules nativos** (`<script type="module">`), SIN bundler, SIN frameworks. Debe servir estático (Vercel / cualquier http server).
- Supabase JS v2 vía CDN ESM: `import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'` — SOLO en `js/core/supabase.js`, ningún otro archivo importa el CDN.
- Textos de UI en español rioplatense. Comentarios mínimos.
- Eventos: SIEMPRE `addEventListener` (o delegación en el container). NUNCA `onclick=""` inline.
- Supabase es la ÚNICA fuente de verdad. `localStorage` SOLO para preferencias de UI (ej. último tab).
- Soft delete: columna `_deleted boolean default false`; todo SELECT filtra `.eq('_deleted', false)` donde exista.
- **Regla de oro (CLAUDE.md §0):** cero valores del usuario hardcodeados en JS (targets, horarios, slots, macros). Todo viene de `user_config` o de las tablas. Los números del usuario SOLO pueden aparecer en `sql/02_seed_nutricion.sql`.
- Fechas: `YYYY-MM-DD` local del dispositivo (helper local por módulo). Semana arranca LUNES.
- Moneda/números: formato es-AR.

## 2. Árbol de archivos y OWNERSHIP (cada agente escribe SOLO su lote)

```
VIDA APP/
├── index.html                  [CORE]
├── SETUP.md                    [SQL]
├── css/
│   ├── tokens.css              [CORE]
│   └── base.css                [CORE]
├── js/
│   ├── core/
│   │   ├── env.js              [CORE]
│   │   ├── supabase.js         [CORE]
│   │   ├── auth.js             [CORE]
│   │   ├── config.js           [CORE]
│   │   ├── router.js           [CORE]
│   │   └── ui.js               [CORE]
│   ├── modules/
│   │   └── nutricion.js        [NUTRICION]
│   └── app.js                  [CORE]
├── sql/
│   ├── 00_core.sql             [SQL]
│   ├── 01_nutricion.sql        [SQL]
│   └── 02_seed_nutricion.sql   [SQL]
└── docs/CONTRATOS.md           (este doc — NO tocar)
```

## 3. Contratos de `js/core/` (exports EXACTOS)

### env.js
```js
export const SUPABASE_URL = '__SUPABASE_URL__';
export const SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';
```
Placeholders literales. Fede los reemplaza con los valores reales de su proyecto Supabase (ver SETUP.md). La anon key es pública por diseño; la seguridad la da RLS.

### supabase.js
```js
export const isConfigured  // boolean: false si env.js sigue con placeholders '__...'
export const supabase      // cliente creado con createClient(URL, ANON_KEY) o null si !isConfigured
```

### auth.js
```js
export async function initAuth()        // restaura sesión; retorna user (objeto Supabase) o null
export async function login(email, password)   // signInWithPassword; throw con mensaje legible si falla
export async function logout()
export function getUser()               // user cacheado o null
export function getUserId()             // user.id o null
export function onAuthChange(cb)        // cb(user|null) en cada cambio de sesión
```

### config.js
```js
export async function loadConfig(userId)       // SELECT * de user_config del user; cachea en memoria
export function getConfig(modulo, clave, fallback = null)   // valor jsonb ya parseado
export async function setConfig(modulo, clave, valor)       // upsert (onConflict 'user_id,modulo,clave') + actualiza cache
export function moduleConfig(modulo)           // accessor scoped: { get(clave, fallback), set(clave, valor), all() }
```

### router.js
```js
export function registerModule(mod)     // mod = interfaz canónica §4; guarda en Map por mod.id
export async function startRouter(defaultId)  // escucha hashchange + resuelve ruta inicial
export function navigate(id)            // setea location.hash = '#/' + id
export function currentRoute()          // id activo
```
Comportamiento: ruta `#/<id>`. Primera visita a un módulo → `await mod.init(container, getUserId(), moduleConfig(mod.id))`. Visitas siguientes → `mod.render()`. `container` = `document.getElementById('mainContent')`. Ruta desconocida → módulo default. Tras cada navegación despacha `window.dispatchEvent(new CustomEvent('vida:route', { detail: { id } }))` (app.js lo usa para marcar el ítem activo del nav).

### ui.js
```js
export function toast(msg, type = 'info')      // type: 'success' | 'error' | 'warning' | 'info'; auto-dismiss
export function confirmDialog({ title, message, confirmText, danger })  // Promise<boolean>, modal propio
```

### app.js (bootstrap)
1. `if (!isConfigured)` → pinta pantalla de setup en `#app` (instrucciones cortas: correr sql/, crear user, completar env.js; referencia a SETUP.md). FIN.
2. `await initAuth()` → sin sesión → pantalla de login (email + password, card centrada, branding VIDA). Login OK → paso 3.
3. `await loadConfig(userId)` → monta shell (§5) → registra módulos habilitados → `startRouter('nutricion')`.
4. `onAuthChange`: logout → volver a login.

Registro de módulos en app.js (módulos prendibles/apagables, lazy):
```js
const MODULES = [
  { id: 'nutricion', label: 'Nutrición', icon: '🥩', enabled: true,  loader: () => import('./modules/nutricion.js') },
  { id: 'plata',     label: 'Plata',     icon: '💵', enabled: false },  // Fase 2
  { id: 'rutina',    label: 'Rutina',    icon: '☀️', enabled: false },  // Fase 3
  { id: 'training',  label: 'Training',  icon: '🏋️', enabled: false },  // Fase 4
  { id: 'insights',  label: 'Insights',  icon: '🧠', enabled: false },  // Fase 5
];
```
Los `enabled: false` aparecen en el nav deshabilitados con nota "Fase N". Solo los enabled se importan (dynamic import) y registran.

## 4. Interfaz canónica de módulo (`js/modules/*.js`)

```js
export default {
  id: 'nutricion',
  label: 'Nutrición',
  async init(container, userId, config) { /* guarda refs, inyecta estilos 1 vez, carga data, llama this.render() */ },
  render() { /* repinta TODO el UI del módulo dentro del container guardado */ },
};
```
- `config` es el accessor scoped de `moduleConfig(id)`: `config.get('proteina_target')`, etc.
- `render()` debe reconstruir su DOM completo dentro del container (al volver de otra ruta, el container tiene el contenido del otro módulo).
- Estilos del módulo: `<style id="nut-styles">` inyectado 1 sola vez en `<head>` (guard con flag). TODAS las clases con prefijo `nut-`. Prohibido tocar estilos globales.
- El módulo importa `supabase` de `../core/supabase.js` y `toast`/`confirmDialog` de `../core/ui.js`. NO importa auth ni router (recibe `userId` por init).
- Lee/escribe SOLO tablas `nutricion_*`, siempre con `.eq('user_id', userId)` explícito (defensa en profundidad; RLS igual protege).

## 5. Shell de la app (owner CORE)

- `index.html`: `<div id="app">` vacío; carga `css/tokens.css`, `css/base.css`, Google Fonts, `<script type="module" src="js/app.js">`. Meta viewport mobile. `<title>VIDA</title>`. Favicon emoji inline (data URI o SVG).
- Shell logueado (lo pinta app.js dentro de `#app`): nav lateral en desktop (logo VIDA arriba, módulos, logout abajo) que colapsa a **bottom nav** en mobile (<768px); `<main id="mainContent">` como área del módulo.
- Mobile-first en serio: la captura del día a día va a ser desde Android.

## 6. Tokens CSS (nombres EXACTOS — el módulo usa SOLO estas vars)

```
--bg  --surface  --surface-2  --border  --border-strong
--text  --text-dim  --text-faint
--accent  --accent-soft  --accent-2  --accent-2-soft
--ok  --warn  --danger
--font-ui  --font-display  --font-num
--radius-sm  --radius  --radius-lg
--space-1 .. --space-8   (escala 4px)
--shadow-1  --shadow-2
--sidebar-w
```
- Identidad: dark minimalista premium. `--accent` = turquesa/verde salud; `--accent-2` = azul confianza. Fondos casi negros, jerarquía por sutileza. **Identidad propia, NO copiar MEPEX** (nada de Outfit/Space Mono).
- `--font-num`: fuente para números/datos (macros, montos) con buen tabular. `--font-display` para títulos.
- `base.css` provee primitivas compartidas que los módulos pueden usar: `.card`, `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.input`, `.badge`, `.empty-state`, `.tabs`/`.tab` (+ estados activos/disabled/focus visibles).

## 7. Esquema SQL (owner SQL — nombres y tipos EXACTOS)

Todo idempotente (correr 2 veces = safe): `create table if not exists`, `drop policy if exists` antes de cada `create policy`, seeds con guards. RLS: **enable row level security + 4 políticas explícitas por tabla** (select / insert / update / delete) con `using (user_id = auth.uid())` y `with check (user_id = auth.uid())` según corresponda. NUNCA `FOR ALL`.

### 00_core.sql
```sql
user_profile (user_id uuid PK references auth.users(id) on delete cascade, nombre text, created_at timestamptz default now())
user_config  (user_id uuid references auth.users(id) on delete cascade, modulo text, clave text,
              valor jsonb not null default '{}'::jsonb, updated_at timestamptz default now(),
              PRIMARY KEY (user_id, modulo, clave))
```
+ trigger `on auth.users` insert → crea `user_profile` automáticamente (function security definer).

### 01_nutricion.sql
```sql
nutricion_alimentos (id uuid PK default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
                     nombre text not null, porcion text, prot numeric default 0, carbo numeric default 0,
                     grasa numeric default 0, kcal numeric default 0, es_ancla boolean default false,
                     favorito boolean default false, notas text, _deleted boolean default false,
                     created_at timestamptz default now())
nutricion_combos    (id uuid PK default gen_random_uuid(), user_id uuid not null ..., nombre text not null,
                     slot text, prot numeric default 0, carbo numeric default 0, grasa numeric default 0,
                     kcal numeric default 0, ingredientes jsonb default '[]'::jsonb, favorito boolean default true,
                     notas text, _deleted boolean default false, created_at timestamptz default now())
nutricion_log       (id uuid PK default gen_random_uuid(), user_id uuid not null ..., fecha date not null,
                     slot text not null, item_tipo text not null,   -- 'alimento' | 'combo' | 'custom'
                     item_id uuid, item_nombre text not null, prot numeric default 0, carbo numeric default 0,
                     grasa numeric default 0, kcal numeric default 0, created_at timestamptz default now())
nutricion_plan      (id uuid PK default gen_random_uuid(), user_id uuid not null ..., fecha date not null,
                     slot text not null, combo_id uuid references nutricion_combos(id),
                     created_at timestamptz default now())
```
- SIN check constraints sobre `slot` (los slots son config por usuario, no enum del sistema).
- Índices: `nutricion_log (user_id, fecha)` y `nutricion_plan (user_id, fecha)`.
- `ingredientes` jsonb: array de `{ "nombre": text, "cantidad": number, "unidad": text }` — la unidad en términos de compra/cocina ("g", "u", "scoop", "porción").

### 02_seed_nutricion.sql
`DO $$` block: `v_user := (select id from auth.users order by created_at limit 1)`; si null → `raise exception` con mensaje claro ("Primero creá el usuario en Authentication"). Inserta:
- `user_config` (upsert on conflict): claves del módulo `nutricion`:
  - `proteina_target` → `{"target_g":160,"piso_g":140,"base":"masa magra / peso de referencia","override":"Dra. Briner pisa Mifflin-St Jeor"}`
  - `referencia_corporal` → `{"peso_kg":144.8,"altura_cm":180}`
  - `ayuno` → `{"ultima_comida":"21:00","primera_comida":"14:00","no_rompen":["café negro","agua"]}`
  - `slots` → `[{"id":"almuerzo","label":"Almuerzo","hora":"14:00"},{"id":"merienda","label":"Merienda","hora":"17:30"},{"id":"cena","label":"Cena","hora":"21:00","nota":"liviana: bajo carbo/grasa, proteína completa"}]`
  - `compensacion` → `{"regla":"Si se saltea la merienda: sumar 1 scoop de whey suelto (25 g) o subir la carne del almuerzo.","aplica_slot":"merienda","sugerencia_g":25}`
  - `creatina` → `{"tipo":"monohidrato","dosis_g":"3-5","frecuencia":"todos los días","nota":"por saturación, no timing; anclar a hábito fijo (cruza con módulo Rutina)"}`
- `nutricion_alimentos`: las 16 anclas EXACTAS de CLAUDE.md §5 (macros idénticos, es_ancla=true; rapidita con nota del carbo asumido) + `Queso proteico` 30 g / 8 prot como fila extra con `es_ancla=false` y nota "provisorio — confirmar etiqueta".
- `nutricion_combos`: los 4 combos EXACTOS de §5 (slot en minúscula matcheando ids de slots: 'merienda'/'cena'), con `ingredientes` desglosado coherente con las anclas.
- Guard anti-duplicado: insertar solo si no existe (user_id + nombre + porcion para alimentos; user_id + nombre para combos).

### SETUP.md (owner SQL)
Guía paso a paso para Fede (no técnico-denso): 1) crear proyecto Supabase, 2) correr los 3 SQL en orden en el SQL Editor (00 y 01 primero), 3) crear su usuario en Authentication → Users (email+password; desactivar signups públicos en settings), 4) recién ahí correr 02_seed, 5) copiar URL + anon key (Settings → API) a `js/core/env.js`, 6) probar local (cualquier server estático) y 7) deploy: repo GitHub + import en Vercel (proyecto estático, sin build). Nota sobre pendientes de etiqueta (queso proteico, leche proteica, carbo rapidita).

## 8. Módulo Nutrición — layout funcional (owner NUTRICION; spec funcional completa en CLAUDE.md §5)

4 tabs internos: **Hoy** (default) · **Semana** · **Prep** · **Compras**.

**Hoy:** header con fecha (navegable ← hoy →) + barra de progreso de proteína hacia `target_g` (marca visual del `piso_g`; colores: <piso rojo/warn, piso..target amarillo→verde, ≥target verde/accent) + totales del día (prot/carbo/grasa/kcal). Secciones por slot (de `config.get('slots')`, con hora y nota): entradas logueadas (borrables) + botón agregar → picker con tabs Favoritos / Combos / Alimentos / Manual (nombre + macros). Tap en item → inserta en `nutricion_log` con macros snapshot. Toggle favorito (estrella) en alimentos/combos. Si el slot merienda quedó vacío y ya pasó su hora → mostrar hint con la regla de `compensacion` (texto de config, no hardcodeado). Mostrar recordatorio discreto de creatina si existe la config.

**Semana:** grilla lunes→domingo × slots. Celda = combo asignado (o vacía). Tap → elegir combo (de `nutricion_combos`) o quitar. Navegación semana anterior/siguiente. Fila/columna según viewport (mobile: día como card vertical).

**Prep:** de la semana visible, agrupa: cuántas veces se planificó cada combo + total de ingredientes a cocinar en batch (suma cantidades por nombre+unidad). Vista de lectura.

**Compras:** agrega ingredientes de todos los combos planificados de la semana visible → lista `nombre — cantidad total unidad`, con checkbox (estado local/localStorage, no DB) y botón "Copiar lista" (clipboard) para mandarla por WhatsApp.

Estados vacíos con guía ("Todavía no planificaste esta semana → andá a Semana"). Todo responsive mobile-first. Loading states simples. Errores de Supabase → `toast(msg, 'error')`, nunca romper el render.

## 8b. Plantillas de día (extensión Fase 1 — owner SQL: sql/03_dias_tipo.sql · owner NUTRICION: js/modules/nutricion.js)

**Concepto:** el usuario come por patrones de día ("día tipo", "sin merienda", etc.). Una plantilla define qué va en cada slot. Planificar la semana = aplicar plantillas a días. Aplicar NO bloquea nada: el día queda como filas normales de `nutricion_plan`, editables individualmente después (flexibilidad total, para cualquier usuario).

### SQL (03_dias_tipo.sql — idempotente, correr después de 01)
```sql
nutricion_dias_tipo (
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  items jsonb not null default '[]'::jsonb,   -- [{"slot":"almuerzo","tipo":"combo"|"alimento","item_id":"<uuid>"}]
  notas text,
  _deleted boolean default false,
  created_at timestamptz default now()
)
```
+ RLS 4 políticas explícitas (mismo patrón que las demás).
+ `alter table nutricion_plan add column if not exists alimento_id uuid references nutricion_alimentos(id);`
  (una celda del plan tiene combo_id **o** alimento_id, nunca ambos — sin constraint, lo garantiza la app al escribir).
+ Seed guarded para el primer usuario: 1 plantilla "Día tipo" = almuerzo → alimento 'Carne roja magra' porción '250 g' · merienda → combo 'Batido' · cena → combo 'Tostado' (ids resueltos por subselect por nombre; si falta alguno, `raise notice` y skip — no exception).

### Módulo (comportamiento)
- **Semana**: cada card de día suma acción "Plantilla" → modal con: lista de plantillas (tap = aplicar al día), borrar plantilla (confirmDialog), y si el día ya tiene celdas asignadas, "Guardar este día como plantilla" (input nombre). Aplicar = por cada item: update de la fila (fecha,slot) si existe, insert si no; setea combo_id XOR alimento_id (nullea el otro). Slots que la plantilla no cubre quedan intactos.
- **Celda del plan** (modal existente de asignar): tabs **Combos | Alimentos** — ahora se puede planificar un alimento/ancla suelto (ej. "Carne roja magra 250 g" de almuerzo). La celda muestra nombre (+porción si es alimento).
- **Prep y Compras**: los alimentos planificados entran a la agregación como ingrediente `{nombre, cantidad: veces, unidad: '× ' + porcion}` → se ve "Carne roja magra: 3 × 250 g". Combos igual que hoy.
- **Hoy**: si un slot está vacío y hay plan para hoy en ese slot → chip "Planificado: <nombre>" con botón anotar de 1 tap (snapshot de macros actuales del combo/alimento). Cierra el loop plan→log sin fricción.
- `S.diasTipo` se carga en init junto al catálogo y se refresca con el refetch silencioso. Cero hardcodeo de slots/valores (todo sigue saliendo de config y tablas). Data-actions nuevos por el onClick delegado existente. Clases prefijo `nut-`.

---

## 9. Módulo Plata — Fase 2 v1 (owner SQL-PLATA: sql/04_plata.sql · owner MOD-PLATA: js/modules/plata.js)

**Alcance v1:** captura rápida manual + categorización + resumen + objetivos. La captura por audio/foto con IA llega con el motor de Fase 5 — el esquema YA la prevé (`origen`, `crudo`) pero NO se implementa nada de IA ahora.

### SQL (04_plata.sql — idempotente, mismo estilo/RLS que 00-03)
```sql
plata_objetivos (
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  target_monto numeric,                -- null = sin definir todavía
  moneda text not null default 'USD',
  nota text,
  activo boolean default true,
  _deleted boolean default false,
  created_at timestamptz default now()
)
plata_movimientos (
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  tipo text not null,                  -- 'ingreso' | 'egreso'
  monto numeric not null,
  moneda text not null default 'ARS',
  ambito text not null,                -- id de config 'ambitos' (ej. 'personal' | 'mepex')
  categoria text,
  descripcion text,
  fuente text,                         -- de dónde viene / a dónde va (ej. 'MEPEX', 'Mercado Pago')
  objetivo_id uuid references plata_objetivos(id),  -- si es aporte a un objetivo
  origen text not null default 'manual',            -- 'manual' | 'voz' | 'foto' (IA, Fase 5)
  crudo text,                          -- input crudo original si vino de captura (Fase 5)
  _deleted boolean default false,
  created_at timestamptz default now()
)
```
- SIN check constraints sobre tipo/ambito/categoria/moneda (config por usuario). Índice `(user_id, fecha)` en movimientos. RLS 4 políticas por tabla.
- Seed `user_config` módulo `plata` (upsert): `monedas` → `["ARS","USD"]` · `ambitos` → `[{"id":"personal","label":"Personal"},{"id":"mepex","label":"MEPEX"}]` · `categorias` → `{"ingreso":["MEPEX","Otros"],"egreso":["Vivienda","Comida","Transporte","Salud","Gym","Suscripciones","Salidas","Compras","Impuestos","Otros"]}`.
- Seed objetivo: `Compra de propiedad` (moneda USD, target_monto null, nota 'Definí el monto objetivo desde la app', activo). Guard anti-duplicado (user_id, nombre).

### Módulo plata.js (prefijo CSS `pla-`, interfaz canónica §4, id 'plata', label 'Plata')
3 tabs: **Mes** (default) · **Resumen** · **Objetivos**. Mes visible navegable ‹ › (default mes actual).
- **Mes**: form de captura rápida SIEMPRE visible arriba (mobile-first, 1 mano): toggle Ingreso/Egreso, monto (teclado numérico), moneda (chips desde config), ámbito (chips desde config), categoría (select según tipo desde config), descripción corta opcional, fecha default hoy editable. Guardar → insert + toast + form se limpia (foco al monto). Lista de movimientos del mes agrupada por día (más nuevo arriba): tipo/categoría/ámbito/descr + monto con signo y color (--ok ingreso, --danger egreso), badge de ámbito. Borrar con confirmDialog (soft delete). Estados vacíos con guía.
- **Resumen** (del mes visible, calculado client-side on-demand): por moneda: total ingresos, total egresos, balance. Split ESTRICTO por ámbito (personal vs mepex, labels desde config). Breakdown de egresos por categoría con barras proporcionales (var(--accent-2)). Si hay aportes a objetivos en el mes, línea "Aportado a objetivos".
- **Objetivos**: cards: nombre, progreso = suma de movimientos con ese objetivo_id (no _deleted) en la moneda del objetivo vs target_monto (barra --accent; si target null → mostrar total aportado + botón "Definir target"), botón "Aportar" (mini-form monto+fecha → insert movimiento tipo 'egreso', ambito 'personal' por default editable, categoria 'Objetivos', objetivo_id seteado), crear objetivo (nombre/target/moneda/nota), editar target/nota, archivar (activo=false) con confirm. 
- Formato es-AR: $ 1.234.567 (sin decimales) para ARS, US$ con decimales solo si hay. `Intl.NumberFormat('es-AR')`.
- Guards anti doble-tap en todo insert/update (patrón S.mutando de nutricion). Queries siempre `.eq('user_id')` + `.eq('_deleted', false)`. Cero hardcodeo: monedas/ámbitos/categorías SIEMPRE desde config con fallback [] y estado vacío que guía a correr sql/04.

## 10. Módulo Rutina — Fase 3 v1 (owner SQL-RUTINA: sql/05_rutina.sql · owner MOD-RUTINA: js/modules/rutina.js)

**Alcance v1:** rutinas con checklist diario + registro de adherencia. SIN notificaciones (Calendar+Apps Script llega después).

### SQL (05_rutina.sql — idempotente, mismo estilo/RLS)
```sql
rutina_rutinas (
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  icono text,                          -- emoji
  items jsonb not null default '[]',   -- [{"id":"<uuid-o-slug>","label":"Creatina 3-5 g","nota":""}]
  dias jsonb not null default '[]',    -- [0..6] lunes=0; días en que aplica. [] = solo lanzamiento manual
  activa boolean default true,
  orden integer default 0,
  _deleted boolean default false,
  created_at timestamptz default now()
)
rutina_checks (
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  rutina_id uuid not null references rutina_rutinas(id) on delete cascade,
  item_id text not null,
  created_at timestamptz default now(),
  unique (user_id, fecha, rutina_id, item_id)
)
```
- Índice `(user_id, fecha)` en checks. RLS 4 políticas por tabla.
- Seed: rutina `Mañana` (icono ☀️, dias [0,1,2,3,4,5,6], orden 0) con items: `creatina` → "Creatina monohidrato 3-5 g" (nota "todos los días — por saturación, no timing"), `suplementos-am` → "Suplementos AM", `skincare` → "Skincare". Guard anti-duplicado (user_id, nombre). Es ejemplo editable, no dogma.

### Módulo rutina.js (prefijo CSS `rut-`, interfaz canónica §4, id 'rutina', label 'Rutina')
3 tabs: **Hoy** (default) · **Rutinas** · **Adherencia**.
- **Hoy**: fecha navegable ‹ hoy ›. Muestra las rutinas activas cuyo `dias` incluye el día visible (lunes=0) + las de `dias:[]` solo si tienen algún check ese día o se lanzan con botón "+ Lanzar rutina" (picker de las manuales). Por rutina: card con icono, nombre, progreso x/y + barra, checklist de items con tap-target grande; tap = toggle (insert en rutina_checks / delete del check; optimista con revert en error). Al completar todas → mini celebración (borde --ok + "Completa 💪"). Estados vacíos con guía.
- **Rutinas**: lista + crear/editar: nombre, emoji, días de la semana (chips L M X J V S D), items dinámicos (agregar/quitar/reordenar simple con ↑↓, label + nota opcional; id = slug estable del label al crear, NO regenerar al editar label si ya existe). Desactivar (activa=false) y borrar (soft) con confirm. Al editar items de una rutina, los checks históricos quedan (referencian item_id viejo — no romper Adherencia).
- **Adherencia**: últimos 7 y 30 días (toggle): por rutina, % = checks hechos / (items × días aplicables en el rango, contando solo días donde la rutina aplicaba por `dias`); grilla de días (fila por rutina, celda por día: vacío/parcial/completo con --danger/--warn/--ok suave) + racha actual de días completos. Client-side con 1 query de checks del rango.
- Guards anti doble-tap en toggles. Queries `.eq('user_id')` + `_deleted=false` donde exista. Cero hardcodeo (la rutina seedeada es DATA, no código).

## 11. Registro de módulos nuevos
`js/app.js` (owner: integrador principal, NO los agentes): flip de `enabled: true` + `loader` para plata y rutina en MODULES. Los módulos deben exportar default con los ids EXACTOS 'plata' y 'rutina' (app.js valida mod.id).
