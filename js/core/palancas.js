// VIDA — Motor de PALANCAS (Fase 5a · determinístico, SIN IA)
// ============================================================================
// Las "palancas" son los cruces accionables que aparecen ARRIBA del Home y en
// Insights: lo que el sistema encontró cruzando comida + plata + gym + hábitos.
// Es el diferencial defendible de VIDA (BACKLOG.md §0/§3): nadie más tiene los
// 4 dominios en el mismo lugar para poder decir "entrenaste y vas corto de
// proteína" o "pagás el gym y no vas hace N días".
//
// Este módulo es la ÚNICA fuente de verdad de las palancas: Home e Insights lo
// consumen (BACKLOG.md §5). Es una función PURA: NO toca Supabase, NO pinta DOM.
// Recibe un `ctx` con resúmenes YA calculados por cada módulo y devuelve la
// lista de palancas que disparan, ordenada por prioridad. El fetching y el
// render viven afuera (home.js arma el ctx; insights.js ya sabe leer las tablas).
//
// Regla de oro del proyecto (CLAUDE.md §0): NADA del usuario hardcodeado. Los
// umbrales (adherencia baja, días sin entrenar, pesos del Pulso) se leen de
// `user_config` módulo 'insights', clave 'umbrales'. Los DEFAULTS de este
// archivo (UMBRALES_DEFAULT) son del SISTEMA, no del usuario → por eso pueden
// vivir en el código. Si el usuario define su clave, pisa estos defaults.
//
// Contrato: docs/CONTRATOS.md §13 · Catálogo: docs/BACKLOG.md §3.
// ============================================================================

/* ============================================================================
   CONTRATO DE ENTRADA — shape de `ctx` (lo arma home.js / insights.js)
   ----------------------------------------------------------------------------
   Todos los sub-objetos son OPCIONALES: si un dominio no tiene datos, pasá
   `null` (o no lo incluyas) y las palancas que lo necesiten se omiten solas.
   Cada campo abajo dice de qué tabla / cálculo sale (mirá insights.js: casi
   todo esto ya se computa ahí en cargarNutricion/Plata/Rutina/Training).

   ctx = {
     hoy,      // 'YYYY-MM-DD' string, día local del dispositivo. Requerido.
     config,   // objeto plano de config resuelta. Se lee con ctx.config?.<clave>.
               // Mínimo esperado (todo opcional, con fallback):
               //   config.umbrales   → jsonb de user_config insights.umbrales
               //                       (ver UMBRALES_DEFAULT abajo). Pisa defaults.
               //   config.pulso_pesos→ jsonb opcional insights.pulso_pesos:
               //                       { adherencia, proteina, training } (se
               //                       normalizan; si falta, UMBRALES_DEFAULT.pulso).
               // (proteina_target/ayuno/creatina viven en sus módulos y ya
               //  llegan resumidos abajo; no hace falta pasarlos crudos acá.)

     // ---- NUTRICIÓN — de nutricion_log + user_config nutricion.* -----------
     nutricion: {
       protHoy,     // number. Σ prot del nutricion_log de HOY. (insights: protHoy)
       protTarget,  // number|null. user_config nutricion.proteina_target.target_g.
       protPiso,    // number|null. …proteina_target.piso_g.
       prom7,       // number. Promedio de prot/día en los últimos 7 días (días
                    //          sin log cuentan 0). (insights: prom7)
       compensacion,// {texto,sugerencia_g}|null. user_config nutricion.compensacion
                    //          (regla "si salteás merienda, +1 scoop"). Opcional.
     },

     // ---- PLATA — de plata_movimientos + user_config plata.categorias -------
     plata: {
       // Gasto del MES en curso en categorías fitness/salud/gym. La categoría
       // se deriva por léxico de la config (patrón RE_ACTIVIDAD de insights.js),
       // NO por nombre fijo → respeta renombres del usuario.
       gastoFitnessMes,   // number. Σ egresos del mes en cats de actividad. 0 si no hay.
       gastoFitnessMoneda,// string. Moneda de ese gasto (ej. 'ARS'). Opcional.
       nMovFitnessMes,    // number. Cantidad de movimientos fitness del mes. Opcional.
       balanceMes,        // number|null. Balance del mes (ingreso-egreso) en la
                          //          moneda principal. Opcional (no lo usan las ⭐).
     },

     // ---- RUTINA — de rutina_rutinas + rutina_checks -----------------------
     rutina: {
       adherencia7,          // number|null. % adherencia global últimos 7 días
                             //   (checks hechos / posibles). null si nada aplicó.
                             //   (insights: adh7)
       rachaMax,             // number. Racha actual de días completos. (insights: racha)
       tieneItemCreatinaHoy, // bool. Alguna rutina activa que aplica HOY tiene un
                             //   item de creatina (match por léxico creatina/creatin).
       creatinaHoyTildada,   // bool. Ese item de creatina ya tiene check hoy.
       creatinaRutinaId,     // string|null. rutina_id del item de creatina (para la
                             //   acción de tildar 1-tap). Opcional.
       creatinaItemId,       // string|null. item_id de la creatina. Opcional.
     },

     // ---- TRAINING — de training_sesiones + training_sets ------------------
     training: {
       sesionHoy,        // bool. ¿Hay training_sesiones con fecha = hoy?
       sesiones30,       // number. Sesiones en los últimos 30 días. (insights: sesiones30)
       diasSinEntrenar,  // number|null. Días desde la última sesión a hoy.
                         //   null si nunca entrenó. (insights: diasSinEntrenar)
       volumen7,         // number. Σ peso×reps de la última semana. Opcional.
     },
   }
   ============================================================================ */

/* ============================================================================
   UMBRALES_DEFAULT — constantes DEL SISTEMA (fallback; el usuario los pisa vía
   user_config insights.umbrales). Comentados uno a uno.
   ============================================================================ */
export const UMBRALES_DEFAULT = {
  adherencia_baja: 70,      // % por debajo del cual la adherencia se marca floja
  adherencia_alta: 70,      // % a partir del cual la semana se considera "redonda"
  dias_sin_entrenar: 4,     // días sin sesión que disparan la alerta de inactividad
  prot_margen_pct: 90,      // % del target por debajo del cual se avisa "vas corto"
                            //   (protHoy < target*0.90 → refuerzo). Evita alertar
                            //   por diferencias mínimas.
  gym_dias_sin_uso: 5,      // días sin entrenar (con gasto de gym vigente) para
                            //   disparar "pagás y no vas" (P8/P10)
  // Pesos del Pulso VIDA (P15). Se normalizan a suma 1 aunque no sumen exacto.
  // El usuario puede pisarlos con user_config insights.pulso_pesos.
  pulso: {
    adherencia: 0.4,        // peso de la adherencia de rutina en el score
    proteina: 0.3,          // peso del cumplimiento de proteína (hoy vs target)
    training: 0.3,          // peso de la regularidad de entreno
  },
  // Referencia de "entreno regular" para el componente training del Pulso:
  // sesiones30 que se consideran 100%. 12 = ~3 por semana. Configurable.
  training_sesiones_optimo_30: 12,
};

/* ============================================================================
   Helpers internos (no exportados)
   ============================================================================ */

// Clampa n al rango [min,max].
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Redondeo a entero seguro (NaN/undefined → 0).
function redondear(n) { const v = Number(n); return Number.isFinite(v) ? Math.round(v) : 0; }

// Formato número es-AR sin decimales (macros/reps/días redondos), igual criterio
// que insights.js. Se deja acá para que las palancas puedan armar su `texto`
// sin depender del módulo de UI (este archivo es puro).
function fmtNum(n, dec = 0) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
}

// Resuelve los umbrales efectivos: DEFAULT del sistema pisado por config del
// usuario (merge superficial + merge del sub-objeto `pulso`). Nunca rompe si
// config viene null o con basura.
function resolverUmbrales(config) {
  const u = (config && typeof config.umbrales === 'object' && config.umbrales) ? config.umbrales : {};
  const pulsoUser = (u.pulso && typeof u.pulso === 'object') ? u.pulso
    : (config && typeof config.pulso_pesos === 'object' && config.pulso_pesos) ? config.pulso_pesos
    : {};
  return {
    ...UMBRALES_DEFAULT,
    ...u,
    pulso: { ...UMBRALES_DEFAULT.pulso, ...pulsoUser },
  };
}

// Chips de origen por dominio (para que la UI pinte "🥩 Cuerpo" · "🏋️ Training"
// sin duplicar el mapa en cada consumidor). BACKLOG.md §3 "onda visual".
const DOMINIOS = {
  cuerpo:   { id: 'cuerpo',   label: 'Cuerpo',   icono: '🥩' },
  plata:    { id: 'plata',    label: 'Plata',    icono: '💵' },
  rutina:   { id: 'rutina',   label: 'Rutina',   icono: '☀️' },
  training: { id: 'training', label: 'Training', icono: '🏋️' },
};
// Devuelve los descriptores de dominio para una lista de ids (para chips en UI).
export function dominiosDe(ids) {
  return (ids || []).map(id => DOMINIOS[id]).filter(Boolean);
}

/* ============================================================================
   Definición de las palancas.
   ----------------------------------------------------------------------------
   Cada palanca es un objeto con:
     id, titulo, cruza (ids de dominio), tipo ('D'), icono,
     evaluar(ctx, U) → objeto Palanca (con texto/prioridad/accion) o null.
   `evaluar` es el "dispara(ctx)" del contrato: decide si aplica y arma el
   mensaje. No se exporta; el orquestador de abajo la corre.
   ----------------------------------------------------------------------------
   Convención de `accion` (la ejecuta el consumidor, no este módulo):
     { label, modulo, params } | null
   - modulo: id de módulo destino ('nutricion'|'rutina'|'training'|'plata').
   - params: pista de qué hacer. Las acciones 1-tap (tildar creatina, anotar
     batido) traen `tipo` para que el Home decida si insertar inline o navegar.
   ============================================================================ */

// ---- P15 · Pulso VIDA (score 0–100 compuesto) ----------------------------
// La firma del Home: un número que resume la semana. Siempre presente si hay
// data en ≥2 dominios. Prioridad máxima (va arriba de todo).
const P15 = {
  id: 'p15',
  titulo: 'Pulso VIDA',
  cruza: ['rutina', 'cuerpo', 'training'],
  tipo: 'D',
  icono: '❤️',
  evaluar(ctx, U) {
    const nut = ctx.nutricion;
    const rut = ctx.rutina;
    const tra = ctx.training;

    // Cada componente aporta un sub-score 0–1 y participa solo si su dominio
    // tiene data. Los pesos se re-normalizan sobre los dominios PRESENTES, así
    // el score es justo aunque falte uno (no penaliza por dato ausente).
    const comps = [];
    const pesos = U.pulso;

    // Adherencia de rutina (0–1) — de adherencia7.
    if (rut && rut.adherencia7 != null) {
      comps.push({ k: 'adherencia', v: clamp(rut.adherencia7 / 100, 0, 1), peso: pesos.adherencia });
    }
    // Proteína (0–1) — cumplimiento de HOY vs target (cap 1). Sin target no suma.
    if (nut && nut.protTarget != null && nut.protTarget > 0) {
      comps.push({ k: 'proteina', v: clamp((Number(nut.protHoy) || 0) / nut.protTarget, 0, 1), peso: pesos.proteina });
    }
    // Regularidad de entreno (0–1) — sesiones30 vs óptimo configurable.
    if (tra && tra.sesiones30 != null) {
      const opt = Number(U.training_sesiones_optimo_30) || 12;
      comps.push({ k: 'training', v: clamp((Number(tra.sesiones30) || 0) / opt, 0, 1), peso: pesos.training });
    }

    // El Pulso necesita ≥2 dominios con data para ser significativo.
    if (comps.length < 2) return null;

    const pesoTotal = comps.reduce((a, c) => a + (Number(c.peso) || 0), 0) || 1;
    const score01 = comps.reduce((a, c) => a + c.v * ((Number(c.peso) || 0) / pesoTotal), 0);
    const score = clamp(redondear(score01 * 100), 0, 100);

    // Zona textual (no hardcodea números del usuario; son bandas del score).
    let zona, texto;
    if (score >= 80) { zona = 'alto'; texto = 'Tu semana viene fuerte. Todo lo importante está alineado — sostené el ritmo.'; }
    else if (score >= 55) { zona = 'medio'; texto = 'Buen pulso, con margen. Hay un dominio que te está frenando — miralo abajo.'; }
    else { zona = 'bajo'; texto = 'Semana para reenganchar. Elegí una sola palanca de abajo y empezá por ahí.'; }

    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto,
      prioridad: 1000,                 // siempre arriba
      score,                           // 0–100, extra para el latido del Home
      zona,                            // 'alto'|'medio'|'bajo' (color del pulso)
      componentes: comps.map(c => ({ k: c.k, pct: redondear(c.v * 100) })), // desglose opcional
      accion: null,                    // el Pulso no ofrece botón: es el resumen
    };
  },
};

// ---- P14 · Trifecta del día de entreno -----------------------------------
// Día de gym: una tarjeta con 3 micro-acciones (proteína · creatina · registrar)
// a 1 tap cada una. Solo dispara si HOY hay sesión de training.
const P14 = {
  id: 'p14',
  titulo: 'Trifecta del día de entreno',
  cruza: ['training', 'cuerpo', 'rutina'],
  tipo: 'D',
  icono: '🎯',
  evaluar(ctx, U) {
    const tra = ctx.training;
    if (!tra || !tra.sesionHoy) return null; // sin entreno hoy no aplica

    const nut = ctx.nutricion;
    const rut = ctx.rutina;
    const tareas = [];

    // 1) Proteína: ¿llegó al target hoy? Si no, tarea de reforzar.
    if (nut && nut.protTarget != null && nut.protTarget > 0) {
      const ok = (Number(nut.protHoy) || 0) >= nut.protTarget;
      tareas.push({
        k: 'proteina',
        hecho: ok,
        label: ok ? 'Proteína en target' : `Proteína: ${fmtNum(nut.protHoy)}/${fmtNum(nut.protTarget)} g`,
        accion: ok ? null : { label: 'Anotar comida', modulo: 'nutricion', params: { tipo: 'log' } },
      });
    }
    // 2) Creatina: ¿tildada hoy? (solo si hoy corresponde el hábito).
    if (rut && rut.tieneItemCreatinaHoy) {
      const ok = !!rut.creatinaHoyTildada;
      tareas.push({
        k: 'creatina',
        hecho: ok,
        label: ok ? 'Creatina tildada' : 'Tildá la creatina',
        accion: ok ? null : {
          label: 'Tildar creatina', modulo: 'rutina',
          params: { tipo: 'check', rutina_id: rut.creatinaRutinaId || null, item_id: rut.creatinaItemId || null, fecha: ctx.hoy },
        },
      });
    }
    // 3) Registrar el entreno: la sesión existe hoy → invitar a completar sets.
    tareas.push({
      k: 'registrar',
      hecho: false, // "abierto": siempre podés seguir cargando series
      label: 'Registrá tus series',
      accion: { label: 'Abrir Training', modulo: 'training', params: { tipo: 'sesion', fecha: ctx.hoy } },
    });

    const pendientes = tareas.filter(t => !t.hecho).length;
    // Si por algún motivo no quedó ninguna tarea con contenido, no molestamos.
    if (!tareas.length) return null;

    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto: pendientes > 0
        ? 'Día de entreno: cerrá las tres para exprimirlo — comé la proteína, tildá la creatina y registrá tus series.'
        : 'Trifecta completa: proteína, creatina y registro. Día de entreno bien cerrado.',
      prioridad: 900,
      tareas,                 // el Home pinta los 3 chips con su acción 1-tap
      accion: null,           // la acción vive en cada tarea, no en la palanca
    };
  },
};

// ---- P2 · Creatina pendiente ---------------------------------------------
// "No tildaste la creatina — es por saturación, todos los días". 1 tap tilda.
// Cierra el loop de CLAUDE.md §5. No dispara si hoy no toca o ya está tildada.
// (Si es día de entreno, P14 ya la incluye; se de-duplica en el orquestador.)
const P2 = {
  id: 'p2',
  titulo: 'Creatina pendiente',
  cruza: ['cuerpo', 'rutina'],
  tipo: 'D',
  icono: '💊',
  evaluar(ctx, U) {
    const rut = ctx.rutina;
    if (!rut || !rut.tieneItemCreatinaHoy || rut.creatinaHoyTildada) return null;
    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto: 'Todavía no tildaste la creatina. Es por saturación, no por timing: suma tomarla todos los días, también los de descanso.',
      prioridad: 700,
      accion: {
        label: 'Tildar creatina', modulo: 'rutina',
        params: { tipo: 'check', rutina_id: rut.creatinaRutinaId || null, item_id: rut.creatinaItemId || null, fecha: ctx.hoy },
      },
    };
  },
};

// ---- P1 · Refuerzo post-entreno ------------------------------------------
// "Entrenaste y vas corto de proteína. El músculo se arma con lo que comés
// ahora" → anotar batido. Dispara si HOY hubo sesión y protHoy < target*margen.
const P1 = {
  id: 'p1',
  titulo: 'Refuerzo post-entreno',
  cruza: ['cuerpo', 'training'],
  tipo: 'D',
  icono: '🥤',
  evaluar(ctx, U) {
    const tra = ctx.training;
    const nut = ctx.nutricion;
    if (!tra || !tra.sesionHoy) return null;
    if (!nut || nut.protTarget == null || nut.protTarget <= 0) return null;
    const protHoy = Number(nut.protHoy) || 0;
    const umbral = nut.protTarget * (Number(U.prot_margen_pct) || 90) / 100;
    if (protHoy >= umbral) return null; // ya está bien de proteína

    const falta = Math.max(0, redondear(nut.protTarget - protHoy));
    // Sugerencia concreta desde la regla de compensación de config si existe.
    const sug = nut.compensacion && nut.compensacion.sugerencia_g
      ? ` Un scoop de whey (${fmtNum(nut.compensacion.sugerencia_g)} g) te acerca rápido.`
      : '';
    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto: `Entrenaste y vas corto de proteína: te faltan ~${fmtNum(falta)} g para el target. El músculo se arma con lo que comés ahora.${sug}`,
      prioridad: 800,
      dato: `Hoy ${fmtNum(protHoy)} g / ${fmtNum(nut.protTarget)} g`,
      accion: { label: 'Anotar batido', modulo: 'nutricion', params: { tipo: 'log', hint: 'batido' } },
    };
  },
};

// ---- P8/P10 · Gym: plata vs. uso -----------------------------------------
// "Pagás gimnasio y no vas hace N días" / "cada sesión te salió $X".
// Dispara si hay gasto fitness este mes. El tono depende del uso (sesiones30 /
// días sin entrenar).
const P8 = {
  id: 'p8',
  titulo: 'Gym: plata vs. uso',
  cruza: ['plata', 'training'],
  tipo: 'D',
  icono: '💪',
  evaluar(ctx, U) {
    const pla = ctx.plata;
    const tra = ctx.training;
    if (!pla || !(Number(pla.gastoFitnessMes) > 0)) return null; // sin gasto fitness, nada que cruzar

    const gasto = Number(pla.gastoFitnessMes) || 0;
    const mon = pla.gastoFitnessMoneda || '';
    const ses = tra ? (Number(tra.sesiones30) || 0) : 0;
    const dias = tra ? tra.diasSinEntrenar : null;
    const limiteSinUso = Number(U.gym_dias_sin_uso) || 5;

    // Etiqueta de monto simple (es-AR). El símbolo lo resuelve la UI si quiere;
    // acá damos un texto legible con la moneda cruda.
    const montoTxt = `${mon ? mon + ' ' : ''}${fmtNum(gasto)}`;

    let texto, dato, prioridad;
    if (ses === 0 || (dias != null && dias >= limiteSinUso)) {
      // Plata sin uso: alerta.
      const cuando = dias != null ? `hace ${fmtNum(dias)} días` : 'este mes';
      texto = `Pagaste gym/salud este mes (${montoTxt}) pero no entrenás ${cuando}. O lo usás, o esa plata está de adorno.`;
      dato = `${montoTxt} · ${fmtNum(ses)} sesiones (30d)`;
      prioridad = 650;
    } else {
      // Se está usando: costo por sesión (gamifica ir más — P9).
      const costoSes = ses > 0 ? gasto / ses : gasto;
      texto = `Estás usando lo que pagás: ${fmtNum(ses)} sesiones este mes. Cada una te salió ${mon ? mon + ' ' : ''}${fmtNum(costoSes)}. Cuantas más vas, más barata.`;
      dato = `${montoTxt} ÷ ${fmtNum(ses)} = ${mon ? mon + ' ' : ''}${fmtNum(costoSes)}/sesión`;
      prioridad = 300; // informativa/positiva: más abajo
    }
    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto, dato, prioridad,
      accion: { label: 'Ver Training', modulo: 'training', params: { tipo: 'sesion', fecha: ctx.hoy } },
    };
  },
};

// ---- P6 · Semana redonda / a reenganchar ----------------------------------
// Ya vivía en insights.js (calcularCruces #1). Cruza adherencia7 × proteína
// promedio7. Se eleva al Home. Es un resumen de la semana (prioridad media-baja;
// el Pulso ya da el número, esta da la lectura cualitativa del cruce).
const P6 = {
  id: 'p6',
  titulo: 'Semana: rutina vs. proteína',
  cruza: ['cuerpo', 'rutina'],
  tipo: 'D',
  icono: '🔗',
  evaluar(ctx, U) {
    const rut = ctx.rutina;
    const nut = ctx.nutricion;
    if (!rut || rut.adherencia7 == null) return null;
    if (!nut || nut.protTarget == null) return null;

    const adh = rut.adherencia7;
    const cumpleProt = (Number(nut.prom7) || 0) >= nut.protTarget;
    const alta = adh >= (Number(U.adherencia_alta) || 70);

    let texto;
    if (alta && cumpleProt) texto = 'Semana redonda: adherencia alta y proteína en target. Sostené el ritmo.';
    else if (alta && !cumpleProt) texto = 'Buena adherencia a la rutina, pero la proteína promedio quedó bajo el target. Ojo con la comida.';
    else if (!alta && cumpleProt) texto = 'La proteína viene bien, pero la adherencia a la rutina está floja. Ahí hay margen.';
    else texto = 'Semana para reenganchar: adherencia y proteína quedaron por debajo. Un ítem a la vez.';

    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto,
      prioridad: 400,
      dato: `Adherencia ${fmtNum(adh)}% · Proteína prom ${fmtNum(nut.prom7)} g / ${fmtNum(nut.protTarget)} g`,
      accion: null,
    };
  },
};

// ---- P11 · Días sin entrenar ----------------------------------------------
// Señal simple pero útil (ya en insights.js calcularCruces #3). Solo Training.
// Se omite si hay gasto de gym (P8 ya cubre el caso "pagás y no vas", más rico).
const P11 = {
  id: 'p11',
  titulo: 'Días sin entrenar',
  cruza: ['training'],
  tipo: 'D',
  icono: '⏳',
  evaluar(ctx, U) {
    const tra = ctx.training;
    if (!tra || tra.diasSinEntrenar == null) return null;
    const limite = Number(U.dias_sin_entrenar) || 4;
    if (tra.diasSinEntrenar < limite) return null;
    // Si Plata ya tiene gasto fitness, P8 dice esto mejor → evitá el duplicado.
    if (ctx.plata && Number(ctx.plata.gastoFitnessMes) > 0) return null;

    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto: `Van ${fmtNum(tra.diasSinEntrenar)} días desde tu última sesión. Si no fue descanso planeado, quizás toca volver.`,
      prioridad: 350,
      accion: { label: 'Empezar sesión', modulo: 'training', params: { tipo: 'sesion', fecha: ctx.hoy } },
    };
  },
};

// ---- P19 · Disciplina pareja (Rutina×Training) -----------------------------
// Cumplís la rutina pero entrenás poco: la disciplina de la mañana no llega al gym.
const P19 = {
  id: 'p19',
  titulo: 'Disciplina pareja',
  cruza: ['rutina', 'training'],
  tipo: 'D',
  icono: '⚖️',
  evaluar(ctx, U) {
    const rut = ctx.rutina;
    const tra = ctx.training;
    if (!rut || rut.adherencia7 == null || !tra || tra.sesiones30 == null) return null;
    const adh = rut.adherencia7;
    const ses = tra.sesiones30;
    const alta = adh >= (Number(U.adherencia_alta) || 70);
    const pocoEntreno = ses < Math.max(1, Math.round((Number(U.training_sesiones_optimo_30) || 12) / 2));
    if (!(alta && pocoEntreno)) return null; // solo el caso "rutina alta, gym flojo"
    return {
      id: this.id, titulo: this.titulo, cruza: this.cruza, tipo: this.tipo, icono: this.icono,
      texto: `Cumplís tu rutina al ${fmtNum(adh)}% pero entrenaste ${fmtNum(ses)} ${ses === 1 ? 'vez' : 'veces'} en 30 días. Esa disciplina de la mañana te banca para llevarla al gym.`,
      prioridad: 320,
      dato: `Adherencia ${fmtNum(adh)}% · ${fmtNum(ses)} sesiones (30d)`,
      accion: { label: 'Ver Training', modulo: 'training', params: { tipo: 'sesion', fecha: ctx.hoy } },
    };
  },
};

// Registro de palancas evaluables (orden de declaración da el orden de empate).
const PALANCAS = [P15, P14, P2, P1, P8, P19, P6, P11];

/* ============================================================================
   API pública
   ============================================================================ */

/**
 * calcularPalancas(ctx) — función PURA.
 * Evalúa todas las palancas contra el contexto y devuelve solo las que disparan,
 * ordenadas por prioridad descendente (mayor arriba). No toca Supabase ni el DOM.
 *
 * De-duplicación: si es día de entreno, la Trifecta (P14) ya incluye la creatina,
 * así que se suprime P2 suelta para no repetir la misma acción.
 *
 * @param {object} ctx  ver el contrato de entrada arriba.
 * @returns {Array<object>} lista de Palanca (ver contrato) ordenada por prioridad.
 */
export function calcularPalancas(ctx) {
  if (!ctx || typeof ctx !== 'object') return [];
  const U = resolverUmbrales(ctx.config);

  const out = [];
  for (const p of PALANCAS) {
    let r = null;
    try {
      r = p.evaluar(ctx, U); // cada palanca aislada: una que rompa no tumba al resto
    } catch (_) {
      r = null;
    }
    if (r) out.push(r);
  }

  // De-dup: P14 (Trifecta) ya cubre la creatina del día de entreno → sacá P2.
  const hayTrifecta = out.some(p => p.id === 'p14');
  const filtrado = hayTrifecta ? out.filter(p => p.id !== 'p2') : out;

  // Orden estable por prioridad desc (empate: orden de declaración en PALANCAS).
  return filtrado
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.prioridad - a.p.prioridad) || (a.i - b.i))
    .map(x => x.p);
}

/**
 * pulsoVida(ctx) — atajo para el Home cuando SOLO querés el score del Pulso
 * (P15) sin recorrer toda la lista. Devuelve la Palanca de Pulso o null si no
 * hay data en ≥2 dominios.
 */
export function pulsoVida(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const U = resolverUmbrales(ctx.config);
  try { return P15.evaluar(ctx, U); } catch (_) { return null; }
}
