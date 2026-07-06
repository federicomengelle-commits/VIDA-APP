# VIDA · Backlog de Producto & Catálogo de Palancas

> La visión completa de a dónde va VIDA, integrada al plan. Sale de un brainstorm profundo por área (los 4 dominios + el cerebro + las interconexiones).
> Complementa CLAUDE.md (roadmap raíz) y REDISENO.md (la piel y el movimiento). Regla de oro en todo: nada del usuario hardcodeado — metas, umbrales, categorías, horarios viven en `user_config`/tablas.

---

## 0. La idea que amarra todo

VIDA deja de ser **5 módulos** y pasa a ser **un organismo**: un **cerebro** (captura + insights + palancas) y una **cara** (el Home cockpit con un pulso único). Tres verdades que salieron del análisis:

1. **El diferencial defendible son las PALANCAS cruzadas.** Nadie más puede decirte "entrenaste fuerte pero venís corto de proteína" o "pagás el gym y no vas hace 6 días" — porque nadie tiene tu comida, tu plata, tu gym y tus hábitos en el mismo lugar. Esa es la ventaja que ningún competidor (Harbiz, apps de finanzas, apps de hábitos) puede copiar.
2. **~70% se construye HOY, sin API key.** El Home, los anillos vivos, la captura por voz (Web Speech), y ~10 insights cruzados son 100% determinísticos. La capa de IA (Claude API) se enchufa después, en huecos que el código **ya tiene reservados** (`captura.js` seam `interpretar()`, la card "Sugerencias/Próximamente" de Insights). Cero retrabajo.
3. **La captura es la puerta.** Un braindump hablado al final del día → el sistema se ordena solo. Es el "principio rector" de CLAUDE.md en su forma final.

---

## 1. Roadmap integrado — 3 Olas

Cada ola entrega **piel + funcionalidad juntas** (no se rediseña vacío ni se agrega feature fea). Mapea al roadmap raíz y a las fases D de REDISENO.md.

| Ola | Título | Qué entrega | API key |
|---|---|---|---|
| **Ola 1** | *El sistema cobra vida* | Motor de animación · **Home cockpit** con **Pulso VIDA** + anillos del día · **5 palancas determinísticas** · **captura por voz viva** · Nutrición rediseñada (faro) | ❌ No |
| **Ola 2** | *Cada núcleo, superador* | **Plata Panorama** (net worth + waterfall + presupuestos + objetivos configurables) · Training (timer, PR, volumen×músculo, plantillas) · Rutina (momentos del día, inventario↔Plata, racha, estado/ánimo) · Cuerpo (hidratación, peso, ayuno vivo) · **señales nuevas** (peso, energía) | ❌ No |
| **Ola 3** | *El cerebro con IA* | `/api/parse` (captura real) · foto→macros · ticket→gasto · **coach proactivo** (Calendar) · preguntas en lenguaje natural · palancas IA · anomalías · captura por lote · timeline narrado | ✅ Sí (Fase 5b) |

**El faro (Ola 1) = lo que validamos primero.** No es "Home + Nutrición" genérico: es el Home cockpit con el Pulso VIDA latiendo, las palancas cruzadas arriba, y la captura por voz andando. Eso es lo que hace sentir "OS personal".

---

## 2. Catálogo por área

Tamaño: **S** rápido · **M** mediano · **L** grande. `[IA]` = requiere API key (Ola 3). Todo lo demás es determinístico.

### 🥩 Cuerpo / Nutrición

| Idea | T | Interconexión clave |
|---|---|---|
| Captura por voz de comidas ("almorcé 250 de carne") | M | Cerebro (seam captura); base sin IA |
| Anillos de macros vivos (prot/carbo/grasa/kcal) | S | Componente compartido con Insights/Home |
| Timer de ayuno en vivo (cuenta regresiva + arco) | S | Rutina (café no rompe); Insights (ventana real) |
| Sparkline de proteína 7 días | S | Insights (mismo componente) |
| "Qué te falta" accionable ("= 1 scoop whey") | S | Usa `compensacion` de config |
| Racha de adherencia nutricional | S | Helper de racha unificado (Rutina/Training) |
| Hidratación como anillo de agua (+1 tap) | M | Rutina; Ayuno; Insights |
| Peso + composición con tendencia suavizada | M | Recalcular target; Training; Plata |
| Estado/energía diario (2 taps) | M | **El conector de Insights** — cruza con todo |
| Recetas con macros derivados de ingredientes | M | Prep/Compras; Plata (costo por plato) |
| Adherencia plan vs. realidad | M | Insights; grilla Semana coloreada |
| Micronutrientes + semáforo de calidad | M | Integración nutricionista |
| Modo Nutricionista (Dra. Briner pisa defaults) | M | Producto vendible (multi-tenant) |
| Foto al plato → macros | L `[IA]` | Reusa seam de captura |
| Sueño como fundación del día | L | **Gran conector**: energía, adherencia, volumen |
| Dashboard de Cuerpo unificado ("instrumento vivo") | L | Cara de Cuerpo en el Home |
| Botones de escala rápida de porción (½·¾·1x·1.5x·2x) | S | Cal AI — escalar sin tipear (§7) |
| Anillo héroe de proteína + swipe a macros secundarios | S | Cal AI — pero proteína, no calorías (§7) |
| Foto→macros con loop de corrección de 1 tap | L `[IA]` | Cal AI — el estándar del rubro (§7) |

**Top 3:** captura por voz · anillos+ayuno+sparkline (la piel premium) · estado/energía + sueño (materia prima de Insights).

### 💵 Plata

| Idea | T | Interconexión clave |
|---|---|---|
| **Tab "Panorama"** (dashboard de entrada, default) | S | Lienzo de todo lo demás |
| Delta mes-a-mes en cada número | S | Insights |
| Rangos rápidos (mes/30d/trimestre/año/todo) | S | Desbloquea tendencias y net worth |
| Top movimientos + gasto hormiga | S | Umbral configurable |
| Tipo de cambio + "equivalente USD" opt-in | S | Net worth, runway, objetivos |
| Presupuestos por categoría + alertas | M | Rutina (mantener presupuesto = hábito) |
| Comparativa/tendencia 6 meses | M | Proyección de cashflow y objetivos |
| **Runway** ("X meses de colchón") | M | Ámbito Personal vs MEPEX |
| **Net worth / patrimonio** con cuentas | M | Hero del Panorama; base de runway |
| Suscripciones/recurrentes detectados | M | Presupuestos; proyección; Insights |
| **Objetivos genéricos con proyección de fecha** | L | **Mata el seed "Casa"**; Rutina (ahorro como hábito) |
| Cashflow proyectado (waterfall) | L | Nodo donde converge todo Plata |
| Captura audio/foto de ticket → categoría | L `[IA]` | Diferencial §0; schema ya lo previó |
| Split Personal / MEPEX como dos vistas | L | P&L de negocio vs. finanza personal |

**Dashboard Panorama (de arriba abajo):** Net worth hero (curva de área + delta) → 3 tiles (Balance+delta · Runway · Objetivo) → **cashflow waterfall** → tendencia 6m → presupuestos → recurrentes → FAB captura 🎤.
**Top 3:** Panorama con net worth + waterfall · objetivos genéricos con proyección (mata "Casa") · captura de ticket.
**Acción inmediata:** eliminar el seed hardcodeado "Compra de propiedad" (CONTRATOS.md §objetivos) → estado vacío que invita a crear el primero.

### ☀️ Rutina / Hábitos

| Idea | T | Interconexión clave |
|---|---|---|
| Momentos del día (AM/PM/Noche) | S | Ancla de recordatorios; Insights |
| Objetivo semanal "X de 7" por hábito | S | Training (entreno 4x, no 7) |
| "No rompas la cadena" — racha en Hoy | S | Home/Insights (racha viva) |
| Reordenar rutinas (↑↓) | S | Higiene UX |
| Recordatorios vía Calendar + Apps Script | M | **Infra compartida** (Nutrición/Training) ⚠️ requiere que Fede autorice Google |
| Deep-work / bloques de foco lanzables | M | Calendar; Insights (horas de foco) |
| **Inventario suplementos/skincare ↔ Plata** | M | **Cruce estrella**: check descuenta stock → "reponer" pre-carga gasto |
| Estado/ánimo/energía diario | M | **Pegamento de Insights** |
| Plantillas de rutina (biblioteca) | M | Onboarding (Fase 6) |
| Habit stacking (encadenar hábitos) | M | Insights (qué eslabón rompe) |
| Heatmap anual estilo GitHub | L | Compartible → viralización |
| Gamificación sana (racha con red de seguridad) | L | Logros cross-dominio |
| Rutinas adaptativas por contexto | L | Training (día de gym), energía, Calendar |

**Top 3:** inventario↔Plata · momentos del día + recordatorios Calendar · racha en Hoy (+ Home "índice del día").

### 🏋️ Training

| Idea | T | Interconexión clave |
|---|---|---|
| **Timer de descanso** (anillo que se vacía) | S | La carencia #1 vs. una app de gym real |
| Auto-detección + celebración de PR | S | Insights (card de PR); feed de logros |
| Duplicar sesión / repetir último | S | Puente a plantillas |
| Notas y flags por set (warmup/fallo/lesión) | S | Cuerpo/Rutina (recuperación); Insights |
| Captura por voz de la serie ("4x10 con 80") | M | Seam de captura §15 |
| **Plantillas de rutina de entrenamiento** | M | Desbloquea mesociclos, volumen, adherencia |
| Progressive overload sugerido | M | Insights; fatiga modula |
| Volumen por grupo muscular + frecuencia | M | Nutrición (demanda de proteína) |
| Heatmap corporal de músculos trabajados | M | El "wow" visual; flags de lesión |
| Gráficos de evolución premium (multi-métrica) | M | Insights consume las series |
| **Fatiga/recuperación (readiness cruzado)** | L | **Donde VIDA aplasta a Harbiz**: sueño+proteína+carga |
| Mesociclos y periodización con deload | L | Calendar; plantillas; fatiga |
| Importación desde Harbiz | L | Útil desde día 1 |
| Superseries, circuitos y tipos de ejercicio | L | Timer; volumen |

**Top 3:** timer de descanso · fatiga/recuperación cruzado (el diferencial) · plantillas de rutina (desbloqueadora).

### 🧠 El Cerebro — Captura · Insights · Home · Coach

| Idea | T | API |
|---|---|---|
| FAB de captura con estados vivos (halo, onda de voz) | S | ❌ |
| Card que "vuela" a su módulo destino (FLIP) | S | ❌ |
| Undo con snackbar tras cada captura/log | S | ❌ |
| Quick-add chips contextuales por hora | S | ❌ |
| "Resumen del día" determinístico (titular) | S | ❌ |
| Anillos del día (estilo Apple Watch) | S | ❌ |
| **Motor de insights determinístico expandido (~10)** | M | ❌ |
| **Home / Cockpit como módulo propio** | M | ❌ |
| Ingesta serverless de captura (`/api/parse`) | M | ✅ |
| Foto al plato → macros | M | ✅ |
| Parsing de tickets/comprobantes | M | ✅ |
| **Coach proactivo** (digest por Calendar) | M | ✅ (fallback determinístico) |
| Preguntas en lenguaje natural sobre tus datos | M | ✅ |
| Timeline unificado de vida + resumen semanal narrado | L | ❌ base / ✅ narrativa |
| Detección de anomalías y tendencias | L | ❌ detección / ✅ explicación |
| Router de captura por lote (audio multi-módulo) | L | ✅ |

**Top 3:** Home cockpit + anillos + resumen determinístico (la cara, sin API) · captura viva (FAB+FLIP+undo, sin API) · insights determinísticos → coach proactivo.

---

## 3. ⭐ Catálogo de PALANCAS (el corazón)

Las palancas son lo que aparece **arriba del Home**: cruces que el sistema encontró. Cada una: qué áreas cruza · `[D]` determinística / `[IA]` · qué hace. **⭐ = las 5 para arrancar** (todas determinísticas → funcionan sin API key desde el día 1).

| # | Palanca | Cruza | Tipo | Qué dice / hace |
|---|---|---|---|---|
| ⭐ P15 | **Pulso VIDA** | Rutina×Cuerpo×Training | D | Score 0–100 compuesto (pesos configurables). La firma del Home: un latido que resume tu semana en un número |
| ⭐ P14 | **Trifecta del día de entreno** | Training×Cuerpo×Rutina | D | Día de gym: una tarjeta con 3 micro-acciones (proteína · creatina · registrar) a 1 tap c/u |
| ⭐ P2 | **Creatina pendiente** | Cuerpo×Rutina | D | "No tildaste la creatina — es por saturación, todos los días". 1 tap tilda. Cierra el loop de CLAUDE.md §5 |
| ⭐ P1 | **Refuerzo post-entreno** | Cuerpo×Training | D | "Entrenaste y vas corto de proteína. El músculo se arma con lo que comés ahora" → anotar batido |
| ⭐ P8/P10 | **Gym: plata vs. uso** | Plata×Training | D | "Pagás gimnasio y no vas hace N días" / "cada sesión te salió $X" |
| P3 | Deuda de recuperación | Cuerpo×Training | D | Volumen alto + proteína floja sostenida |
| P6 | Semana redonda / a reenganchar | Cuerpo×Rutina | D | Ya vivo en insights.js — elevar al Home |
| P9 | Costo por sesión | Plata×Training | D | Gasto gym ÷ sesiones; gamifica ir más |
| P12 | Suplemento pagado sin usar | Cuerpo×Plata | D | Compraste whey/creatina y casi no lo registrás |
| P13 | ROI de tu inversión física | Plata×Training×Cuerpo | D | Plata → sesiones → progreso, encadenado |
| P17 | Constancia de registro financiero | Plata×Rutina | D | Registrar plata tratado como hábito (X de Y días) |
| P18 | Ritmo de ahorro como hábito | Plata×Rutina | D | Aportes irregulares → sugerir aporte fijo |
| P19 | Disciplina pareja | Rutina×Training | D | Cumplís la rutina pero no entrenás (o viceversa) |
| P20 | Auto-check de entreno | Rutina×Training | D | Registrar sesión → tilda "Entrenar" en la rutina |
| P22 | Regla de compensación (merienda) | Cuerpo | D | Slot vencido → regla de config. Ya en Nutrición, elevar |
| P5 | Entrenás en ayunas | Cuerpo×Training | D | Informativo, respeta que el ayuno es elección |
| P4 | Plateau por combustible | Cuerpo×Training | IA | e1RM plano + proteína baja → hipótesis |
| P7 | Tus mejores días comen mejor | Cuerpo×Rutina | IA | Correlación adherencia↔proteína validada |
| P16 | Acelerá el objetivo | Plata×Rutina | IA | Proyección + gasto recortable para adelantar la meta |
| P21 | Carbo para pierna | Cuerpo×Training | IA | Día demandante + cena liviana → posible falta de energía |

**Onda visual de las palancas:** cada tarjeta muestra **hilos de luz** (SVG animado, `--accent`/`--accent-2`) que conectan los íconos de los núcleos que cruza + **chips de origen** (`🥩 Cuerpo` `🏋️ Training`). La intensidad del hilo = fuerza de la señal. El Pulso VIDA es el latido central del que cuelgan los núcleos.

---

## 4. Señales nuevas a capturar (habilitan palancas más ricas)

| Señal | Dónde/cómo se captura | Prioridad |
|---|---|---|
| **Peso corporal** (serie) | Voz ("peso 143") o módulo salud | 🥇 Alta |
| **Energía / ánimo diario** | Rutina: 1 emoji al cerrar el día | 🥇 Alta |
| Sueño (horas/calidad) | Rutina (item) o import wearable | 🥈 Media |
| RPE por set (ya en schema, sin UI) | Training: input opcional | 🥈 Media |
| Hidratación | Rutina (contador) | 🥉 |
| Flag `recurrente` en gastos | Plata | 🥉 |
| Hora real de la comida (ya hay `created_at`) | Nutrición: exponerlo | 🥉 |

Peso y energía son máximo impacto/esfuerzo: 1 tap o 1 frase, y desbloquean decenas de cruces. Conviene **empezar a capturarlas ya** para tener histórico cuando llegue la capa de IA.

---

## 5. Notas de arquitectura (para no romper la regla de oro)

- **`js/core/palancas.js` compartido.** Extraer la lógica de cruces (hoy en `insights.js:471 calcularCruces()`, que ya produce P6/P8/P11) a un módulo que **Home e Insights** consuman. Una sola fuente de verdad para las palancas.
- **Umbrales en config.** Nueva clave `user_config` módulo `insights`, clave `umbrales` (jsonb: `{adherencia_baja:70, dias_sin_entrenar:4, ...}`) con fallbacks. Nada de "70%" hardcodeado.
- **Categorías por léxico, no por nombre fijo.** Seguir el patrón `RE_ACTIVIDAD` (`insights.js:104`) que deriva categorías fitness de la config del usuario. Aplica a P8/P9/P10/P12.
- **Acciones 1-tap.** Las palancas determinísticas (P2, P14, P22, P1) insertan/tildan sin navegar, reusando `agregarEntrada` (Nutrición) / `toggleCheck` (Rutina).
- **Seams ya reservados** (cero retrabajo al llegar la IA): `captura.js` → `interpretar()` (CONTRATOS §15) · card "Sugerencias/Próximamente" (`insights.js:631`) · columnas `origen`/`crudo`/`fuente` en `plata_movimientos`.
- **Sin API key primero.** Ola 1 y 2 no tocan la Claude API. La Ola 3 solo agrega serverless `/api/*` sin reescribir UI.

---

## 6. Ola 1 — desglose ejecutable (por dónde se empieza)

El arranque en 6 pasos. Cada paso entrega algo verificable y no rompe lo anterior. Workflow del proyecto: SQL primero si aplica → construir → verificar end-to-end en prod (CLAUDE.md §6).

| # | Paso | Se crea / toca | Entrega | Se verifica |
|---|---|---|---|---|
| 1 | **Motor de movimiento** (D1) | `tokens.css` (easings/duraciones/glows) · `css/motion.css` (nuevo) · `js/core/anim.js` (nuevo: countUp/ring/stagger/tilt/pageTransition) · linkear en `index.html` | Helpers de animación listos, con guarda `prefers-reduced-motion` | Importan sin romper la app actual |
| 2 | **Motor de palancas** | `js/core/palancas.js` (nuevo): extrae y expande `calcularCruces()` de `insights.js`; arranca con las 5 ⭐ (Pulso VIDA, Trifecta, Creatina, Refuerzo, Gym×uso); umbrales desde `user_config.insights.umbrales` con fallbacks | `palancas(datos) → lista de cruces` | Devuelve las palancas correctas con datos reales |
| 3 | **Home cockpit** (D2, faro) | `js/modules/home.js` (nuevo, patrón init/render): Pulso VIDA + anillos del día + tiles de núcleos + palancas + FAB · registrar en `router.js`/`app.js` como ruta **default** y en la nav | Entrás y ves el Home vivo | Preview: el pulso late, los anillos cuentan, las palancas aparecen, el tap navega |
| 4 | **Capa viva de la captura** (sin IA) | La captura v0 **ya existe y anda en prod** (`js/core/captura.js`: Web Speech + parser rioplatense + card + ruteo). Falta la piel: FAB 🎤 con estados animados (halo/onda/pensando), card que "vuela" a su módulo destino, undo (extender `ui.js`) | La captura existente se siente premium | End-to-end en prod, con undo |
| 5 | **Nutrición rediseñada** (faro del módulo) | `js/modules/nutricion.js`: anillos de macros vivos, timer de ayuno en vivo, sparkline 7d, primitivas elevadas — sin tocar su lógica de datos | Nutrición se siente premium | Preview + prod: mismos datos, piel nueva |
| 6 | **Cierre de Ola 1** | — | QA de gusto + validación con Fede | 60fps, reduced-motion, mobile real; se siente **un sistema** |

**Orden recomendado:** 1 y 2 en paralelo (la base) → 3 (que los usa) → 4 y 5. Si querés el "wow" cuanto antes, el paso 3 (Home cockpit) es el primer entregable visible; la captura (4) puede ir justo después.

**Único SQL de la Ola 1:** la clave `user_config.insights.umbrales` (opcional, con fallbacks). Todo lo demás es front + lógica sobre tablas que ya existen. Las señales nuevas (peso, energía, sueño) y sus tablas son de la Ola 2.

---

## 7. Benchmark: Cal AI & food trackers con IA → Nutrición

Investigamos **Cal AI** (líder del "foto→macros", ~$50M ARR, comprada por MyFitnessPal en 3/2026) y sus competidores (SnapCalorie, Foodvisor, Bitesnap, MacroFactor, Carbon Diet Coach). Qué robar, qué evitar, y dónde VIDA les gana.

### A robar — sin IA (determinístico, se puede en Ola 2)

| Feature de Cal AI | Adaptación a VIDA |
|---|---|
| **Anillo héroe + macro-rings + swipe a secundarias** (un número grande = "lo que queda", detalle a un swipe) | Igual, pero el héroe es **proteína** (target ~160g), no calorías. Fiel a §5. Reusa el anillo de `anim.js` |
| **Botones de escala rápida** de porción (½·¾·1x·1.25x·1.5x·2x) | Sobre cualquier ancla/combo: escalás la porción de 1 tap, sin tipear macros |
| **Relog / "food memory" de 1 tap** (recuerda tus comidas frecuentes) | Ya es nuestro concepto de **anclas + combos favoritos**. Cal AI lo validó a escala de $30M+ |
| **Onboarding: Mifflin-St Jeor + factor de actividad + selector de objetivo con timeline en vivo** ("a este ritmo llegás a X kg el DD/MM") | El cálculo ya está en §5; el microinteractivo del timeline lo hace tangible. Va en Fase 6 (onboarding), el cálculo sirve ya |
| **Streaks + "trophy room" de logros** | Cruza con la racha de adherencia nutricional (ya en catálogo §2) |
| **Peso con gráficos 7/30/90/anual** | Ya en catálogo (peso + tendencia suavizada) |

### A robar — con IA (Ola 3, visión + serverless)

- **Foto→macros con loop de corrección de 1 tap**: foto → ítems detectados por separado + porción estimada → el usuario ajusta con slider/escala, swap de ítem, agrega lo que la cámara no vio, o edita el macro. **Nunca auto-commit** (ya es el patrón de captura §15). Cal AI usa *depth sensor* para el volumen; VIDA puede arrancar solo con Claude visión (mayor error) y pedir confirmación de porción.
- **Digitalizar etiqueta nutricional** (foto de la tabla → campos).
- **Describe tu comida por voz/texto** → ya es la captura universal (la joya de §4).
- **Resúmenes diarios/semanales por IA** → ya en el cerebro (coach proactivo §2).

### Lo que NO hacemos — los errores de Cal AI son nuestro diferencial

- **Precisión honesta.** El foto→macros de TODA la categoría tiene **10–25% de error** (peor en platos mixtos; subestima ~20%; no ve aceites/salsas). Cal AI publicita "90%" sin citar. VIDA muestra **rango/confianza** y prioriza estimar bien **la proteína (la ancla)**, con corrección de 1 tap. Honestidad > marketing.
- **Seguridad por diseño.** Cal AI tuvo un **breach de 3,2M usuarios** (Firebase abierto, PINs de 4 dígitos sin rate-limit). VIDA ya tiene **RLS por `user_id` en toda tabla** (CLAUDE.md §1) — el cimiento que a ellos les faltó.
- **Sin paywall engañoso.** Cal AI fue **bajado del App Store (4/2026)** por billing engañoso. VIDA es personal-first; si algún día hay billing (Fase 6), transparente.

### También robá de los que NO son Cal AI

- **MacroFactor — TDEE adaptativo** (el mejor concepto del rubro): en vez de una fórmula estática, calcula tu gasto *real* revirtiendo tu tendencia de peso vs. ingesta y **recalibra solo cada semana**. Para VIDA: alimentado por tu **volumen de Training real** + peso de referencia (no solo pasos). Día de pierna pesado → sube el target de carbos.
- **MacroFactor — "adherence-neutral"**: no castiga el tracking imperfecto. Clave para retención sana (coherente con tu Rutina "gamificación sana").
- **MacroFactor — "grounded, not generated"**: los macros salen de ingredientes de una **base verificada** (tus anclas `nutricion_alimentos` del §5), no de un número alucinado por el LLM. Tu seed ES la fuente de verdad.
- **Cronometer — micronutrientes con DB verificada**: cruza con tu "modo nutricionista" (Dra. Briner define objetivos de micros).

### Precisión: el whitespace del rubro (donde VIDA es honesta y gana confianza)

El error real del foto→macros es 10–25% (la grasa invisible tiene ~55% de error — "es física, no IA"). Casi ninguna app muestra esa incertidumbre: tiran un número falsamente preciso ("487 kcal") que puede estar 20-30% mal. Ese es el hueco. Principios para VIDA:

1. **Voz > foto para tu caso.** El hallazgo más fuerte: la foto sola correlaciona **0.59** con la realidad; **foto + una frase de contexto ("2 cucharadas de aceite") salta a 0.94**. Tu captura por voz *ya* le dice a la app lo que la cámara no ve. Ventaja estructural.
2. **Mostrá banda, no falsa precisión.** "~480 kcal (±20%)" o un rango. **El ancho de la banda = calidad del input**: solo foto = ancha; foto + porción confirmada + aceite declarado = angosta. De las poquísimas apps honestas.
3. **"Agregá lo invisible" de 1 tap** tras cada captura: método de cocción, aceite, salsa, multiplicador de porción. Es la palanca de precisión #1 (0.59→0.94).
4. **Optimizá consistencia, no perfección por comida.** Loguear los mismos combos igual cada día lava el error (~±0.65% en un mes por cancelación estadística). Tus anclas/combos de 1 tap explotan esto — ventaja técnica sobre la foto.
5. **Framing sano (ético).** Los calorie trackers se asocian a conductas alimentarias problemáticas cuando usan límites duros + rojo/verde. VIDA: **rangos en vez de límites, tendencia en vez del número del día, cero shaming.**

### El foso: lo que ninguna food app tiene

Cal AI, MacroFactor, Cronometer & co. son **islas de comida**. VIDA cruza la comida con **plata, gym y hábitos** (las palancas §3), y estas interconexiones son imposibles para una app aislada:
- **Nutrición ↔ Training:** TDEE adaptativo por volumen de entrenamiento real (no solo pasos).
- **Nutrición ↔ Rutina:** la **creatina y el whey** son ítems de hábito → un check, dos módulos actualizados.
- **Nutrición ↔ Plata (nadie lo hace):** la **lista de compras del plan semanal → gasto proyectado** categorizado, contra tu objetivo de ahorro. *"Tu meal prep de esta semana = $X, Y% sobre presupuesto de comida."*
- **Insights cruzados (§3):** *"las semanas que clavaste proteína, tu press subió"* — justo la **guía** que los usuarios de Cal AI piden a gritos y que ninguna food app da.

**Ese es el diferencial defendible.**
