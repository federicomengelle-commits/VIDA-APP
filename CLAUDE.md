# VIDA — Sistema Operativo Personal · Plan Maestro

> Documento raíz del proyecto. Claude Code lo lee UNA vez y respeta en todo.
> Estado: v1. Se itera. Profundo y ejecutable en Arquitectura + Módulo Nutrición; roadmap en el resto.

---

## 0. Qué es VIDA

OS personal que cubre 4 dominios: **Cuerpo, Plata, Rutina, Bienestar**.

**Principio rector:** el usuario captura input crudo (voz, foto, nota rápida de una línea). La app + un motor de IA lo **estructuran, calculan, mantienen y ejecutan**. El usuario nunca hace data entry manual pesado.

**Objetivo primario:** que le ordene la vida al dueño (Fede) y lo potencie en el día a día.

**Objetivo secundario:** producto vendible online. Por eso se construye **personal-first pero multi-tenant-ready** (ver §1). No es "app personal que después migro": es un core multiusuario que hoy tiene un solo usuario.

**Regla de oro:** NADA hardcodeado del usuario. Metas, horarios, anclas de comida, suplementos → todo vive en tablas de config por usuario, jamás en el código.

---

## 1. Decisiones de arquitectura — LEER PRIMERO

| Decisión | Elección | Por qué |
|---|---|---|
| Frontend | SPA modular **Vanilla JS** (patrón LOBBY-MEPEX) | Un solo patrón mental MEPEX↔VIDA; ya dominado; sin peso de framework |
| Backend / DB | **Supabase** (Postgres + Auth + Storage) | Sync multi-device real; auth y RLS nativos; escala a +14 módulos |
| Auth | **Supabase Auth desde el día 1** | Aunque haya un solo usuario. Habilita multi-tenant sin reescribir |
| Aislamiento de datos | **RLS activo en toda tabla**, `user_id` en todo | Cimiento del producto vendible. Barato hoy, carísimo de retrofitear después |
| Config | **Tabla `user_config`**, cero hardcodeo | Metas/horarios/anclas por usuario. Lo que hace la app generalizable |
| Módulos | **Aislados, prendibles/apagables** | Cada módulo independiente. No se rompen entre sí |
| Branding | Dark mode minimalista + acentos **verde (salud) / azul (confianza)** | Identidad propia, separada de MEPEX. Paleta subjetiva → se afina al final |
| Deploy | **Vercel + autodeploy desde GitHub** | Push → deploy. Estático (Vanilla) + serverless functions para keys secretas |
| Dominio | `vida.app` (deseado) | — |
| Captura | **Voice-first en Android**, 1 tap, mínima fricción | El input crudo es la puerta de entrada de todo |
| Notificaciones | **Google Calendar + Apps Script** como motor | No reinventar push PWA; delega bloqueo/foco a Digital Wellbeing nativo de Android |
| Plataforma dev | Claude Code en Windows 11 | Comandos `type`/`dir`, nunca Linux |

**Andamiaje de producto:** SOLO cimientos ahora (auth + RLS + config-driven). Billing, onboarding y landing se difieren hasta que el core funcione para el dueño y valide seguir (§4, Fase 6).

**Naming & dominio:** sin nombre definitivo aún; dominio deseado `vida.app`. El nombre NO bloquea el desarrollo → se buildea con "VIDA" placeholder y la identidad real (nombre + paleta afinada) se pinta al final tocando solo `tokens.css`, nunca lógica.

**Manejo de keys (crítico para Vercel):** la config pública de Supabase (URL + anon key) va en el cliente — es pública por diseño, la seguridad la da RLS. Las keys SECRETAS (service_role de Supabase, API de Claude en Fase 5) viven en env vars de Vercel y se usan SOLO desde serverless functions (`/api`), jamás en el browser.

---

## 2. Estructura del proyecto

```
vida/
├── index.html              # shell de la SPA
├── css/
│   ├── tokens.css          # variables: colores (dark+turquesa), tipografía, spacing
│   └── base.css
├── js/
│   ├── core/
│   │   ├── supabase.js     # cliente único, config de conexión
│   │   ├── auth.js         # login/session, guarda user_id global
│   │   ├── router.js       # navegación entre módulos (hash-based)
│   │   └── config.js       # lee/escribe user_config, cachea en memoria
│   ├── modules/
│   │   ├── nutricion.js
│   │   ├── plata.js
│   │   ├── rutina.js
│   │   ├── training.js
│   │   └── insights.js     # motor de IA (fase final)
│   └── app.js              # bootstrap: auth → carga config → monta router
└── CLAUDE.md               # este doc
```

### Patrón de módulo canónico (todos lo siguen)

Cada módulo exporta la misma interfaz:
- `init(container, userId, config)` — monta la UI en su contenedor
- `render()` — pinta el estado actual
- lee/escribe SOLO sus tablas, filtradas por `user_id` vía RLS
- no toca el DOM de otros módulos ni asume que otro módulo existe

> Referencia de implementación: los módulos `inventario.js` / `crm.js` de LOBBY. Mismo esqueleto.

---

## 3. Modelo de datos (Supabase)

### Core (Fase 0)

```sql
-- Auth la maneja Supabase (auth.users). Perfil y config aparte:
user_profile (
  user_id      uuid PK references auth.users,
  nombre       text,
  created_at   timestamptz default now()
)
user_config (
  user_id      uuid PK references auth.users,
  modulo       text,              -- 'nutricion' | 'plata' | ...
  clave        text,              -- 'proteina_target' | 'horario_ayuno' | ...
  valor        jsonb,             -- flexible por módulo
  PRIMARY KEY (user_id, modulo, clave)
)
```

**RLS en TODA tabla:** `user_id = auth.uid()`. Sin excepción.

### Por módulo

Cada tabla de módulo lleva siempre `id`, `user_id`, `created_at`. El esquema detallado de cada módulo se diseña **cuando le toca su fase**, no antes (evita sobre-especificar lo lejano). Nutrición (Fase 1) tiene su esquema completo en §5.

---

## 4. Roadmap de módulos (milestones secuenciales)

Cada fase es un milestone ejecutable con su propio prompt para Claude Code. **No se buildea todo junto.**

**Fase 0 — Cimientos.** Shell SPA + Supabase + Auth + RLS + `user_config` + router + tokens de branding. Sin features todavía. Es el andamio sobre el que todo se para.

**Fase 1 — Nutrición** (spec completa en §5). El primer módulo real, ya cerrado. Log diario + planificador semanal + meal prep + lista de compras. Es tu proof of concept técnico Y tu primer test de usuario.

**Fase 2 — Plata** (nivel pro). Ingresos (fuente MEPEX) y egresos, captura por audio/foto → estructura todos los campos. Categorización con separación estricta personal vs. MEPEX. Resumen por categoría/destino. Manejo por objetivos (meta: compra de propiedad). Sin deuda que trackear. Regeneración de resumen on-demand.

**Fase 3 — Rutina / Hábitos.** El corazón del "ordenar el día". Rutinas preseteadas que lanzás a la mañana y vas chequeando ítem por ítem (suplementos AM, skincare, lo que elijas). Podés armar **varias rutinas** y alternarlas por día/mañana. Cada check queda registrado → genera data de adherencia. Notificaciones vía Calendar+Apps Script (§1).

**Fase 4 — Training.** Rutina, series, pesos, evolución. Benchmark de UX: Harbiz — pero NO clonarlo. Arranca simple, enfocado donde Harbiz no te cubre. Evaluar si conviene importar data de Harbiz en vez de duplicar.

**Fase 5 — Motor de IA / Insights.** VA AL FINAL: necesita data histórica de las fases 1-4 para tener qué interpretar. Lee las tablas de todos los módulos y genera insights cruzados (ej: adherencia a rutina vs. evolución de peso; gasto vs. objetivo). Implementación: backend llama a la API de Claude con la data del usuario → devuelve insights estructurados. Corre periódico, no en cada request.

**Fase 6 — Capa de producto** (solo si el core validó para el dueño). Onboarding (setup de config del nuevo usuario), billing, landing, mecánica de viralización. El core ya es multi-tenant, así que esto se suma encima sin tocar la lógica.

---

## 5. Módulo 1 — Nutrición · Spec ejecutable

### Contexto del usuario (va a `user_config`, NO hardcodeado)

- **Target proteína:** ~160 g/día. Piso 140 en días complicados.
- **Peso/altura de referencia:** 144.8 kg / 180 cm. Target calculado sobre masa magra/peso de referencia (NO peso total — la grasa no pide proteína). Overridable por valores de la nutricionista (Dra. Briner), que pisan el default de Mifflin-St Jeor.
- **Ayuno intermitente:** última comida 21h → primera comida ~14h del día siguiente. Café negro + agua no lo rompen.
- **Slots de comida:** Almuerzo 14h · Merienda 17:30 · Cena 21h. La cena, liviana (bajo carbo/grasa), pero proteína completa.
- **Creatina:** monohidrato, 3-5 g/día TODOS los días (incluidos los de descanso — es por saturación, no timing). Anclada a un hábito fijo. (Cruza con módulo Rutina.)

### Data seed — Anclas de proteína (cargar en tabla `nutricion_alimentos`)

| Alimento | Porción | Prot | Carbo | Grasa | kcal |
|---|---|---|---|---|---|
| Carne roja magra | 200 g | 53 | 0 | 16 | 350 |
| Carne roja magra | 250 g | 66 | 0 | 20 | 440 |
| Cuadril | 150 g | 40 | 0 | 12 | 270 |
| Pollo pechuga | 150 g | 45 | 0 | 5 | 230 |
| Pescado blanco | 150 g | 30 | 0 | 3 | 150 |
| Huevo | 2 u | 12 | 1 | 10 | 155 |
| Whey ENA Vainilla Ice Cream | 1 scoop (31 g) | 25 | 2.7 | 2.5 | 123 |
| Yogur griego Serenísima s/endulzar | 150 g | 13 | 6 | 7 | 125 |
| Jamón cocido | 40 g | 7 | 0 | 4 | 65 |
| Lomito | 40 g | 8 | 0 | 3 | 60 |
| Pan G4U ciabatta | 1 porción | 14 | 3 | 2 | 100 |
| Rapidita G4U | 1 u | 5 | ~4* | 1 | 45 |
| Frutos secos | 30 g | 6 | 6 | 18 | 200 |
| Palta | ½ | 2 | 6 | 15 | 160 |
| Banana | 1 mediana | 1 | 27 | 0 | 105 |
| Manzana | ½ | 0 | 13 | 0 | 50 |

*carbo de rapidita: asumido por coherencia con línea G4U. Confirmar con etiqueta.

**Pendientes de confirmar (envases):** queso proteico (~8 g prot/30 g provisorio), leche proteica.

### Data seed — Combos (tabla `nutricion_combos`, favoritos de 1 tap)

| Combo | Slot | Prot | Carbo | Grasa | kcal |
|---|---|---|---|---|---|
| Batido (yogur griego + whey + f.secos + banana) | Merienda | 45 | 42 | 27 | 490 |
| Tostada (2 pan G4U + palta + huevo + café c/leche) | Merienda | 40 | 16 | 24 | 480 |
| Tostado (2 pan G4U + jamón + lomito + queso) | Cena | 51 | 7 | 15 | 330 |
| Rapiditas (4 rapi + cuadril 150g + huevo + verdura) | Cena | 66 | ~20 | 20 | 550 |

### Día tipo (validación del target)

- Almuerzo (200-250 g carne): **53-66 g**
- Merienda (cualquier combo): **40-45 g**
- Cena (cualquier combo): **51-66 g**
- **Total: 145-175 g** → clava el target sin esfuerzo.
- **Regla de compensación:** el día que se saltea la merienda, sumar 1 scoop de whey suelto (25 g) o subir carne del almuerzo. Sin esto se escapan ~40 g.

### Features del módulo

1. **Log diario** — 3 slots (Almuerzo/Merienda/Cena) que matchean el ayuno. Tap sobre ancla o combo favorito → suma al total del día. Barra de progreso hacia el target. Sistema de favoritos.
2. **Planificador semanal** — asignar combos/comidas a cada slot de cada día. Vista de la semana.
3. **Meal prep** — a partir del plan semanal, agrupa qué cocinar en batch.
4. **Lista de compras** — deriva automáticamente del plan semanal: qué ingredientes y cuánto comprar.
5. Persistencia Supabase, RLS por `user_id`. UI dark + turquesa.

### Esquema de datos del módulo

```sql
nutricion_alimentos (id, user_id, nombre, porcion, prot, carbo, grasa, kcal, es_ancla bool)
nutricion_combos    (id, user_id, nombre, slot, prot, carbo, grasa, kcal, ingredientes jsonb)
nutricion_log       (id, user_id, fecha date, slot text, item_ref, prot, carbo, grasa, kcal)
nutricion_plan      (id, user_id, fecha date, slot text, combo_id)  -- planificador semanal
```

---

## 6. Prompt de arranque para Claude Code (Fase 0 + 1)

> Copiar esto a Claude Code para empezar. Fases 2-6 tienen su propio prompt cuando toquen.

```
Leé CLAUDE.md completo. Vamos a construir la Fase 0 (cimientos) + Fase 1 (módulo Nutrición) de VIDA.

Fase 0:
- Shell de SPA en Vanilla JS con router hash-based.
- Integrá Supabase (Auth + Postgres). Configurá login/session que guarde user_id global.
- Creá las tablas core (user_profile, user_config) con RLS activo (user_id = auth.uid()).
- Implementá css/tokens.css con el branding dark + turquesa.
- Patrón de módulo canónico: init(container, userId, config) / render().

Fase 1 — Nutrición:
- Creá las tablas del módulo (§5) con RLS.
- Seedéa las anclas y combos de §5 (para el user actual).
- Cargá el target y horarios de ayuno en user_config (NO hardcodees).
- Features: log diario con 3 slots + favoritos + barra de progreso al target.
- Después: planificador semanal → meal prep → lista de compras.

Workflow: SQL primero, verificá end-to-end en prod, iteramos por feature. Windows 11 (type/dir).
```
