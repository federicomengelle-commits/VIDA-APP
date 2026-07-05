# VIDA · Rediseño "Instrumento Vivo"

> Norte visual y plan de ejecución del rediseño superador de toda la app.
> Complementa CLAUDE.md (no lo reemplaza). La arquitectura no cambia; cambia la piel y el movimiento.

## Decisiones tomadas

- **Estética:** *Instrumento vivo* — la precisión afilada de Linear/Arc (oscuro, tipografía protagonista, datos nítidos) fusionada con el pulso orgánico de Oura/Whoop (glows que respiran, anillos, gradientes vivos). Datos duros que se sienten vivos.
- **Estrategia:** *Faro primero* — se construye el nuevo lenguaje en un **Home nuevo** (hoy inexistente) + **Nutrición** como módulo faro; se valida navegable; recién ahí se propaga al resto.
- **Paleta:** se mantiene la de marca (turquesa salud + azul confianza). La identidad final se afina al cierre tocando solo `tokens.css`.

## Principios de diseño (qué lo hace "superador")

1. **Datos vivos, no estáticos.** Todo número clave respira: count-up al aparecer, anillos que se llenan con easing, barras que crecen, glows que pulsan sutil. La data se siente organismo, no planilla.
2. **Jerarquía cinética.** El movimiento guía el ojo: entrada escalonada (stagger) de fondo a foco. Lo importante llega último y se queda.
3. **Magnetismo táctil.** Cada elemento interactivo responde: hover con lift + glow, press con scale-down, cards con tilt sutil hacia el cursor. Se siente que responde a vos.
4. **Profundidad por capas.** Fondo casi-negro con glows radiales que derivan lento, superficies con borde que brilla al filo del acento, glass/blur en overlays. Profundidad = confianza premium.
5. **El cruce como protagonista (el diferencial de VIDA).** El Home no es una grilla de módulos: es un tablero donde los núcleos (Cuerpo, Plata, Rutina, Training) se muestran vivos y, en el centro, las **palancas** — los cruces que el sistema encontró. Materializa "cruzás la info entre núcleos para encontrar palancas".
6. **Respeto por el que mira.** 60fps siempre (solo `transform`/`opacity`), `prefers-reduced-motion` honrado, nada que maree. El lujo es que se sienta fluido, no recargado.

## Motor de diseño y movimiento (base reutilizable)

- **`tokens.css`** (ampliar): curvas de easing (`--ease-out-expo`, `--spring`), duraciones (`--dur-fast/dur/dur-slow`), capas de glow por acento.
- **`css/motion.css`** (nuevo): keyframes + utilidades (`.rise`, `.breathe`, `.shimmer`, page-transition).
- **`js/core/anim.js`** (nuevo): `countUp()`, `ring()` (anillo SVG), `stagger()`, `tilt()`, `pageTransition()`. Todo con guarda de `prefers-reduced-motion`.
- **Primitivas elevadas:** `card` viva, botón magnético, barra animada, tab con indicador deslizante, skeletons de carga.

## Fases

| Fase | Qué | Entregable |
|---|---|---|
| **D0** | Norte visual | Prototipo navegable del Home (Artifact) para validar la dirección — **hecho** |
| **D1** | Motor de diseño + movimiento | tokens ampliados + `motion.css` + `anim.js` + primitivas elevadas |
| **D2** | El faro | `home.js` (tablero de núcleos + palancas) como landing post-login + Nutrición rediseñada |
| **D3** | Propagación | El lenguaje aplicado a Plata, Rutina, Training, Insights (uno por uno, verificando) |
| **D4** | Shell + transiciones globales | Sidenav con indicador deslizante, transición entre módulos, bottom-nav con física, boot animado |
| **D5** | QA de gusto | Performance 60fps, reduced-motion, mobile real, accesibilidad |

## Qué NO cambia

- Arquitectura Vanilla JS + patrón `init(container, userId, config)` / `render()`.
- Supabase + Auth + RLS por `user_id`.
- `tokens.css` como única fuente de identidad (cambiar marca = tocar solo tokens).
- El render por `paint()` (reemplazo de HTML). El movimiento se monta encima, no lo reemplaza.
