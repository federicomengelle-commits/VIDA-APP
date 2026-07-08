# VIDA · Handoff — 2026-07-06

> Punto de continuidad entre charlas. Leelo al arrancar una sesión nueva junto con `CLAUDE.md`, `docs/BACKLOG.md` y `docs/REDISENO.md`.

## 1. Dónde está el proyecto

- **En producción:** https://vida-app-nine.vercel.app (Vercel autodeploy desde `main` del repo `federicomengelle-commits/VIDA-APP`; push → deploy; hard-refresh Ctrl+Shift+R tras cada deploy). Supabase proyecto `csdveyedsrciscbedyov`.
- **Último commit deployado:** `dc0087d`.
- **8 módulos** en la nav nueva: Inicio (Home cockpit), Nutrición, Cuerpo, Plata, Rutina, Training, Insights, Ajustes.

## 2. Qué se hizo en la última sesión (2 deploys grandes)

- **Rediseño "Instrumento Vivo"** (commit `b3b2f86`): nav rehecha (top-bar glass + indicador deslizante, dock mobile; fuera la barra lateral); los 6 módulos re-skineados con anillos vivos / count-up / stagger / tilt / glass; captura viva (FAB animado + card que "vuela" al módulo + undo); Home con palancas de 1 tap; motor de animación `js/core/anim.js` + `css/motion.css`; motor de palancas `js/core/palancas.js`.
- **Cuerpo + Ajustes + cruce + P19** (commit `dc0087d`): módulo **Cuerpo** (peso/energía/sueño/hidratación), módulo **Ajustes** (editar `user_config` desde la app), **cruce Nutrición↔Plata** (precio por alimento → costo de compras → "Registrar en Plata"), palanca **P19**.
- Método: fan-out de agentes en paralelo, cada uno preservando la lógica de datos. Verificado con `node --check` + imports en browser (no screenshot: el renderer del preview se cuelga → la validación visual la hace Fede en prod).

## 3. Pendiente de Fede (hacer cuando pueda)

1. **Correr 2 SQL** en Supabase (SQL Editor → pegar → Run; idempotentes):
   - `sql/07_precio_alimentos.sql` → activa el cruce Nutrición↔Plata.
   - `sql/08_cuerpo_metricas.sql` → activa el módulo Cuerpo.
   - (Recordatorio viejo: `sql/06_training.sql` — confirmar si ya se corrió; activa Training con datos.)
2. **Mirar el deploy** y reportar qué se ve raro con datos reales.
3. **Traer `ANTHROPIC_API_KEY`** (env var en Vercel) cuando quiera arrancar la **Ola 3 IA** (foto→macros, coach, captura con Claude).

## 4. PRÓXIMO OBJETIVO (para la charla nueva): SEEDS de datos reales

Diseñar **SQLs de seed** para llenar las tablas con datos reales buscados en Internet (cosas variadas, útiles para usar la app en serio). Candidatos:

- **`training_ejercicios`** (`nombre`, `grupo`, `unidad`): catálogo grande de ejercicios reales por grupo muscular (pecho/espalda/pierna/hombro/brazo/core). Hoy tiene solo 6 (seed en `sql/06`).
- **`nutricion_alimentos`** (`nombre`, `porcion`, `prot`, `carbo`, `grasa`, `kcal`, `es_ancla`, y ahora `precio`/`precio_moneda`): muchos alimentos comunes (contexto argentino) con **macros reales por porción**. Hoy tiene el seed base de `sql/02`.
- **`nutricion_combos`**: combos armados con esos alimentos.
- Lo que surja (categorías, etc.).

**Patrón a seguir** (mirá `sql/02_seed_nutricion.sql` y `sql/06_training.sql`): archivo `.sql` **idempotente**, bloque `do $$ ... $$` que toma el **primer usuario** de `auth.users`, **guards anti-duplicado** (no insertar si ya existe por `user_id + nombre`), y `raise notice` de resumen. RLS ya está en las tablas. Regla de oro: son datos del usuario (seed para el user actual), catálogo **editable**, no dogma.

**Cómo trabajar el seed:** buscar en Internet (WebSearch/WebFetch) macros de alimentos y listas de ejercicios; armar los `.sql`; Fede los corre en Supabase. "Después vamos viendo" (iterativo).

## 5. Mapa del proyecto (para no recalentar)

- **Plan/visión:** `CLAUDE.md` (raíz), `docs/BACKLOG.md` (features + 22 palancas + benchmark Cal AI §7), `docs/REDISENO.md` (piel "Instrumento Vivo"), `docs/CONTRATOS.md` (contratos técnicos VINCULANTES: esquemas por módulo).
- **SQL:** `sql/00`–`sql/08`. Seeds de ejemplo: `02` (nutrición) y `06` (training).
- **Front:** `js/modules/*.js` (home, nutricion, cuerpo, plata, rutina, training, insights, ajustes). Core: `js/core/*.js` (`palancas`, `anim`, `captura`, `router`, `config`, `auth`, `supabase`, `ui`). Estilo: `css/tokens.css` + `css/base.css` + `css/motion.css`.
- **Convenciones:** regla de oro (nada del usuario hardcodeado → `user_config`/tablas); RLS 4 políticas explícitas por tabla; SQL idempotente; verificar `node --check` + imports antes de deployar; commits en español; plataforma Windows.

## 6. Prompt sugerido para arrancar la charla nueva

```
Leé docs/HANDOFF.md, CLAUDE.md y docs/BACKLOG.md para el contexto.
Objetivo de hoy: diseñar SQLs de SEED con datos reales (buscá en Internet) para
llenar training_ejercicios (ejercicios por grupo muscular) y nutricion_alimentos
(alimentos comunes argentinos con macros por porción + precio estimado), siguiendo
el patrón idempotente de sql/02 y sql/06. Arrancá con un lote y después iteramos.
```
