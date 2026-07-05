# VIDA — Setup paso a paso

Guía para dejar VIDA andando de cero: Supabase + usuario + seed + local + deploy.
Seguí los pasos EN ORDEN — el seed (paso 4) necesita que el usuario ya exista (paso 3).

---

## 1. Crear el proyecto en Supabase

- [ ] Entrá a [supabase.com](https://supabase.com) y logueate (con GitHub es lo más rápido).
- [ ] **New project** → elegí tu organización.
- [ ] Nombre: `vida` (o el que quieras). Región: **South America (São Paulo)** para menor latencia.
- [ ] Definí la **database password** y guardala en tu gestor de claves (no la vas a usar en la app, pero la pide).
- [ ] Esperá 1-2 minutos a que el proyecto termine de provisionarse.

## 2. Correr el SQL de estructura (00 y 01)

En el panel de Supabase, menú izquierdo → **SQL Editor** → **New query**.

- [ ] Abrí `sql/00_core.sql` de esta carpeta, copiá TODO el contenido, pegalo y tocá **Run**. Tiene que decir "Success".
- [ ] Repetí con `sql/01_nutricion.sql`. "Success" de nuevo.

Los archivos SQL son idempotentes: si corriste uno dos veces por error, no pasa nada.

**Todavía NO corras `02_seed_nutricion.sql`** — primero va el paso 3.

## 3. Crear tu usuario y cerrar los signups

- [ ] Menú izquierdo → **Authentication** → **Users** → **Add user** → **Create new user**.
- [ ] Email: `federicomengelle@gmail.com` · Password: elegí una fuerte y guardala. Dejá tildado **Auto Confirm User** si aparece la opción.
- [ ] Ahora cerrá la puerta: **Authentication** → **Sign In / Providers** (según versión del panel puede decir "Providers" o "Settings") → en **Email**, desactivá **"Allow new users to sign up"** y guardá. Así nadie más puede crearse cuenta: sos el único usuario.

## 4. Correr los seeds (02 y 03)

- [ ] Volvé al **SQL Editor**, pegá TODO `sql/02_seed_nutricion.sql` y **Run**.
- [ ] Tiene que terminar en "Success". Si te tira el error *"No hay usuarios en auth.users..."* es que te salteaste el paso 3: creá el usuario y corré el seed de nuevo.
- [ ] Después pegá y corré `sql/03_dias_tipo.sql` — crea las plantillas de día (necesita el 02 ya corrido).

Esto carga: tu config de nutrición (target de proteína, ayuno, slots, compensación, creatina), las 16 anclas de proteína con sus macros, el queso proteico provisorio y los 4 combos (Batido, Tostada, Tostado, Rapiditas) con sus ingredientes.

Para verificar: **Table Editor** → `nutricion_alimentos` tiene que mostrar 17 filas y `nutricion_combos` 4.

## 5. Conectar la app (env.js)

- [ ] En Supabase: **Settings** (engranaje) → **API**.
- [ ] Copiá **Project URL** y la key **anon / public**.
- [ ] Abrí `js/core/env.js` y reemplazá los placeholders:

```js
export const SUPABASE_URL = 'https://TUPROYECTO.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...tu-anon-key...';
```

Tranquilo: la anon key es pública por diseño — la seguridad la da RLS, que ya quedó activo en todas las tablas con los scripts del paso 2.

## 6. Probar en local

La app es 100% estática, solo necesitás un server local. Desde la carpeta del proyecto, en una terminal:

```
npx serve .
```

(o si tenés Python: `python -m http.server 8000`)

- [ ] Abrí la URL que te muestra (ej. `http://localhost:3000`).
- [ ] Logueate con `federicomengelle@gmail.com` y tu password del paso 3.
- [ ] Tenés que ver el módulo Nutrición con tus anclas y combos cargados. Probá loguear un almuerzo y mirá la barra de proteína.

## 7. Deploy en Vercel (vía GitHub)

- [ ] Creá un repo en GitHub (privado está bien) y subí la carpeta del proyecto:

```
git init
git add .
git commit -m "VIDA Fase 0 + 1"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/vida.git
git push -u origin main
```

- [ ] En [vercel.com](https://vercel.com) → **Add New** → **Project** → importá el repo.
- [ ] Framework preset: **Other**. Sin build command, sin output directory (es estático puro). **Deploy**.
- [ ] Abrí la URL que te da Vercel, logueate y listo. De acá en adelante: cada `git push` a `main` redeploya solo.

Nota: `env.js` viaja en el repo con la URL y la anon key. Está bien — son públicas por diseño (ver paso 5). Las keys SECRETAS (service_role, API de Claude en Fase 5) NUNCA van al repo: van a env vars de Vercel cuando toquen.

---

## Pendientes de etiqueta (cuando tengas los envases a mano)

Quedaron tres datos provisorios que conviene confirmar y corregir desde la app (o en Table Editor → `nutricion_alimentos`):

- **Queso proteico**: cargado con 8 g prot / 30 g, carbo y grasa en cero y kcal estimada en 32 (4 kcal por gramo de proteína). Confirmar los cuatro valores con la etiqueta.
- **Leche proteica**: no está cargada — agregarla como alimento cuando tengas la etiqueta.
- **Rapidita G4U**: el carbo (4 g) está asumido por coherencia con la línea G4U. Confirmar con la etiqueta.

## Si algo falla

- **Login rechazado**: revisá que el usuario esté "Confirmed" en Authentication → Users, y que `env.js` tenga la URL/key correctas (sin espacios ni comillas de más).
- **Error "Invalid path specified in request URL"**: la `SUPABASE_URL` de `env.js` tiene un path de más (ej. copiaste `.../rest/v1/`). Tiene que ser SOLO la base: `https://TUPROYECTO.supabase.co` — sin nada después del `.co`.
- **La app carga pero no muestra datos**: casi seguro corriste el seed antes de crear el usuario, o creaste un segundo usuario antes que el tuyo (el seed toma el PRIMER usuario creado). Verificá en Table Editor que las filas de `nutricion_alimentos` tengan tu `user_id`.
- **Error al correr un SQL**: corrélos en orden (00 → 01 → 02 → 03). Se pueden re-correr sin miedo, son idempotentes.

---

## Actualización — Plantillas de día (`sql/03_dias_tipo.sql`)

¿Ya tenés la app andando de antes? Solo hay que correr un SQL más:

- [ ] **SQL Editor** → pegá TODO `sql/03_dias_tipo.sql` → **Run**. "Success" y listo.

Crea la tabla de plantillas de día, le agrega la columna `alimento_id` al plan semanal y te deja armada la plantilla "Día tipo" (almuerzo: carne roja magra 250 g · merienda: Batido · cena: Tostado). Idempotente como los demás.

Si estás instalando de cero: corré el 03 después del seed (02), así la plantilla encuentra sus alimentos y combos.
