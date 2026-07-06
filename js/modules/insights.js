// VIDA — Módulo Insights (Fase 5a · determinístico, SIN IA todavía)
// ============================================================================
// Dashboard READ-ONLY: lee las tablas de los demás módulos y muestra un tablero
// vivo con los números reales. NUNCA escribe. Robustez máxima: cada dominio en
// su propio try/catch → si una tabla no existe o falla una query, esa card
// muestra "sin datos todavía" y el resto sigue vivo.
//
// Rediseño "Instrumento Vivo" (BACKLOG.md §5): Insights y el Home comparten la
// MISMA fuente de verdad de palancas → el motor puro `core/palancas.js`. Acá se
// arma un `ctx` (mismo shape que en home.js) desde los datos que ya cargamos y
// se pinta el Pulso VIDA + las palancas ricas con chips de origen, en vez del
// viejo `calcularCruces()` local. La carga de datos NO cambió: sigue siendo
// read-only, tolerante y anti-carrera.
//
// Contrato: docs/CONTRATOS.md §4 y §13. Roadmap: CLAUDE.md §4 (Fase 5).
import { supabase } from '../core/supabase.js';
// Insights lee config de OTROS módulos (nutricion.proteina_target, plata objetivos),
// no solo la suya → importa el accessor global read-only (cache ya cargado en login).
import { getConfig } from '../core/config.js';
// Motor de palancas: ÚNICA fuente de verdad de los cruces (compartida con Home).
import { calcularPalancas, pulsoVida, dominiosDe } from '../core/palancas.js';
// Animación del rediseño: anillos vivos, count-up, entrada escalonada, tilt.
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local, semana desde LUNES)
   ============================================================ */
const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function parseFecha(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Resta n días a un YYYY-MM-DD y devuelve YYYY-MM-DD.
function addDias(s, n) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); }
// Día de la semana con LUNES=0 (JS domingo=0 → mapear).
function diaSemLunes(s) { const d = parseFecha(s).getDay(); return (d + 6) % 7; }
// Rango [desde, hoy] inclusive de N días (N=7 → hoy y los 6 previos).
function desdeRango(dias) { return addDias(hoyStr(), -(dias - 1)); }
// Mes en curso (primer y último día) y mes anterior.
function primerDiaMes(s) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), 1)); }
function ultimoDiaMes(s) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
function addMeses(s, n) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
function labelMes(s) { const d = parseFecha(s); return MESES_LARGO[d.getMonth()] + ' ' + d.getFullYear(); }

/* ============================================================
   Utilidades
   ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
// Número es-AR sin decimales por default (macros/reps/volumen redondos).
function fmtNum(n, dec = 0) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
}
// Monto es-AR por moneda. ARS: sin decimales. Resto: con decimales solo si los tiene.
function fmtMonto(monto, moneda) {
  const n = Number(monto) || 0;
  const mon = String(moneda || '').toUpperCase();
  const tieneDec = Math.abs(n % 1) > 0.0000001;
  const opts = mon === 'ARS'
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : { minimumFractionDigits: tieneDec ? 2 : 0, maximumFractionDigits: 2 };
  const num = new Intl.NumberFormat('es-AR', opts).format(Math.abs(n));
  return simboloMoneda(mon) + ' ' + num;
}
function simboloMoneda(mon) {
  const m = String(mon || '').toUpperCase();
  if (m === 'ARS') return '$';
  if (m === 'USD') return 'US$';
  return m;
}
function pct(parte, total) { return total > 0 ? Math.round((parte / total) * 100) : 0; }
function clampPct(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }
// Epley 1RM estimado: peso × (1 + reps/30).
function e1rm(peso, reps) { return (Number(peso) || 0) * (1 + (Number(reps) || 0) / 30); }

/* ============================================================
   Estado del módulo (dashboard read-only: cada card tiene su propio
   estado de carga/datos para no romper el render por un módulo faltante)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,          // moduleConfig('insights') — no lo usamos, pero llega por contrato
  boundEl: null,
  rango: 7,              // 7 | 30 — rango global donde aplica
  cargando: true,
  cargandoRango: false,
  // Resultado por dominio: { estado: 'ok'|'vacio'|'error', ...datos }
  nutricion: null,
  plata: null,
  rutina: null,
  training: null,
  palancas: null,        // salida de calcularPalancas(ctx) (sin el Pulso p15)
  pulso: null,           // salida de pulsoVida(ctx)
  cargaId: 0,            // anti-carrera: cada carga incrementa; respuestas viejas se descartan
};

/* ============================================================
   Config (read-only) — targets/objetivos de otros módulos
   ============================================================ */
function proteinaTarget() {
  const cfg = getConfig('nutricion', 'proteina_target', null);
  const target = cfg && Number(cfg.target_g) > 0 ? Number(cfg.target_g) : null;
  const piso = cfg && Number(cfg.piso_g) > 0 ? Number(cfg.piso_g) : null;
  return { target, piso };
}

// Categorías de egreso de Plata que representan actividad física / salud, para
// el cruce con Training. Derivadas de la config real (no de nombres fijos): si
// el usuario las renombra el cruce las sigue; si no hay ninguna, se omite.
const RE_ACTIVIDAD = /gym|gimnas|salud|fitness|m[eé]dic|nutri|entren/i;
function categoriasActividad() {
  const cats = getConfig('plata', 'categorias', {});
  const egreso = cats && Array.isArray(cats.egreso) ? cats.egreso : [];
  return new Set(egreso.filter(c => RE_ACTIVIDAD.test(String(c))));
}

/* ============================================================
   Cargas por dominio — cada una TOLERANTE a tabla ausente / query rota.
   Devuelven un objeto de estado; NUNCA hacen throw hacia afuera.
   (SIN CAMBIOS respecto de la versión previa: mismas queries, mismos campos.)
   ============================================================ */

// ---- Nutrición: proteína hoy vs target, promedio 7d, días que llegó al piso ----
async function cargarNutricion() {
  try {
    const { target, piso } = proteinaTarget();
    const desde7 = desdeRango(7);
    const hoy = hoyStr();
    const { data, error } = await supabase.from('nutricion_log')
      .select('fecha, prot')
      .eq('user_id', S.userId)
      .gte('fecha', desde7).lte('fecha', hoy);
    if (error) throw error;
    const rows = data || [];
    // Proteína acumulada por día.
    const porDia = new Map();
    for (const r of rows) {
      const f = String(r.fecha).slice(0, 10);
      porDia.set(f, (porDia.get(f) || 0) + (Number(r.prot) || 0));
    }
    const protHoy = porDia.get(hoy) || 0;
    // Promedio sobre los 7 días del rango (incluye días sin log como 0 → promedio real).
    let suma = 0;
    let diasPiso = 0;
    for (let i = 0; i < 7; i++) {
      const f = addDias(hoy, -i);
      const p = porDia.get(f) || 0;
      suma += p;
      if (piso != null && p >= piso) diasPiso++;
    }
    const prom7 = suma / 7;
    const hayData = rows.length > 0;
    return {
      estado: hayData ? 'ok' : 'vacio',
      target, piso, protHoy, prom7, diasPiso,
      // Serie para cruce con rutina (prot por día, últimos 7).
      serieProt: (() => {
        const s = {};
        for (let i = 0; i < 7; i++) { const f = addDias(hoy, -i); s[f] = porDia.get(f) || 0; }
        return s;
      })(),
    };
  } catch (err) {
    return { estado: 'error' };
  }
}

// ---- Plata: balance del mes por moneda, gasto mes vs mes anterior, objetivo activo ----
async function cargarPlata() {
  try {
    const mesActual = primerDiaMes(hoyStr());
    const mesAnterior = addMeses(mesActual, -1);
    const desde = mesAnterior;                 // desde el 1° del mes anterior
    const hasta = ultimoDiaMes(mesActual);     // hasta el fin del mes actual
    const { data, error } = await supabase.from('plata_movimientos')
      .select('fecha, tipo, monto, moneda, categoria, objetivo_id')
      .eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', desde).lte('fecha', hasta);
    if (error) throw error;
    const rows = data || [];

    // Balance del mes actual por moneda + gasto (egresos) actual vs anterior.
    const balancePorMoneda = new Map();  // moneda → { ingreso, egreso }
    const gastoActual = new Map();       // moneda → egreso total mes actual
    const gastoAnterior = new Map();     // moneda → egreso total mes anterior
    const finMesAnterior = ultimoDiaMes(mesAnterior);
    for (const m of rows) {
      const mon = String(m.moneda || '').toUpperCase();
      const monto = Number(m.monto) || 0;
      const f = String(m.fecha).slice(0, 10);
      const esActual = f >= mesActual;
      const esIngreso = m.tipo === 'ingreso';
      if (esActual) {
        if (!balancePorMoneda.has(mon)) balancePorMoneda.set(mon, { ingreso: 0, egreso: 0 });
        const b = balancePorMoneda.get(mon);
        if (esIngreso) b.ingreso += monto; else b.egreso += monto;
        if (!esIngreso) gastoActual.set(mon, (gastoActual.get(mon) || 0) + monto);
      } else if (f <= finMesAnterior) {
        if (!esIngreso) gastoAnterior.set(mon, (gastoAnterior.get(mon) || 0) + monto);
      }
    }

    // Objetivo activo principal (el más viejo activo) + su progreso (todas las fechas).
    let objetivo = null;
    try {
      const { data: objs, error: e2 } = await supabase.from('plata_objetivos')
        .select('id, nombre, target_monto, moneda')
        .eq('user_id', S.userId).eq('_deleted', false).eq('activo', true)
        .order('created_at').limit(1);
      if (e2) throw e2;
      if (objs && objs.length) {
        const o = objs[0];
        const { data: aportes, error: e3 } = await supabase.from('plata_movimientos')
          .select('monto, moneda')
          .eq('user_id', S.userId).eq('_deleted', false)
          .eq('objetivo_id', o.id);
        if (e3) throw e3;
        const mon = String(o.moneda || '').toUpperCase();
        let total = 0;
        for (const a of (aportes || [])) {
          if (String(a.moneda || '').toUpperCase() === mon) total += Number(a.monto) || 0;
        }
        objetivo = {
          nombre: o.nombre,
          moneda: mon,
          target: o.target_monto != null ? Number(o.target_monto) : null,
          aportado: total,
        };
      }
    } catch (_) { objetivo = null; } // objetivos rotos no invalidan el resto de la card

    // Ensamble de balances con delta de gasto por moneda.
    const monedas = [...new Set([...balancePorMoneda.keys(), ...gastoActual.keys(), ...gastoAnterior.keys()])].sort();
    const balances = monedas.map(mon => {
      const b = balancePorMoneda.get(mon) || { ingreso: 0, egreso: 0 };
      const gA = gastoActual.get(mon) || 0;
      const gP = gastoAnterior.get(mon) || 0;
      return {
        moneda: mon,
        ingreso: b.ingreso,
        egreso: b.egreso,
        balance: b.ingreso - b.egreso,
        gastoActual: gA,
        gastoAnterior: gP,
        deltaGasto: gA - gP,
      };
    });
    const hayData = rows.length > 0 || !!objetivo;
    return {
      estado: hayData ? 'ok' : 'vacio',
      mesActualLabel: labelMes(mesActual),
      mesAnteriorLabel: labelMes(mesAnterior),
      balances, objetivo,
      // Para cruce con training: egresos en categorías de actividad/salud del mes
      // actual. Las categorías salen de la config de Plata (no hardcodeadas): así
      // respetan renombres del usuario y el cruce se omite si no hay ninguna.
      gastoGymSalud: rows.filter(m => m.tipo === 'egreso' && String(m.fecha).slice(0, 10) >= mesActual
        && categoriasActividad().has(m.categoria)),
    };
  } catch (err) {
    return { estado: 'error' };
  }
}

// ---- Rutina: adherencia 7/30, racha, mejor/peor rutina ----
async function cargarRutina() {
  try {
    const dias = S.rango;
    const desde = desdeRango(dias);
    const hoy = hoyStr();
    const [rutRes, chkRes] = await Promise.all([
      supabase.from('rutina_rutinas')
        .select('id, nombre, icono, items, dias, activa')
        .eq('user_id', S.userId).eq('_deleted', false).eq('activa', true),
      supabase.from('rutina_checks')
        .select('fecha, rutina_id, item_id')
        .eq('user_id', S.userId)
        .gte('fecha', desde).lte('fecha', hoy),
    ]);
    if (rutRes.error) throw rutRes.error;
    if (chkRes.error) throw chkRes.error;
    const rutinas = rutRes.data || [];
    const checks = chkRes.data || [];
    if (!rutinas.length) return { estado: 'vacio' };

    // Set de checks por "fecha|rutina" para contar cumplidos por día.
    const checksPorDiaRutina = new Map(); // 'fecha|rutina_id' → Set(item_id)
    for (const c of checks) {
      const k = String(c.fecha).slice(0, 10) + '|' + c.rutina_id;
      if (!checksPorDiaRutina.has(k)) checksPorDiaRutina.set(k, new Set());
      checksPorDiaRutina.get(k).add(c.item_id);
    }

    // Adherencia por rutina: checks hechos / (items × días aplicables en el rango
    // según `dias` de la rutina). Solo cuenta días donde la rutina aplicaba.
    const detalle = [];
    let posiblesGlobal = 0;
    let hechosGlobal = 0;
    for (const r of rutinas) {
      const items = Array.isArray(r.items) ? r.items : [];
      const diasAplica = Array.isArray(r.dias) ? r.dias : [];
      const nItems = items.length;
      if (!nItems) { detalle.push({ nombre: r.nombre, icono: r.icono, pct: 0, sinItems: true }); continue; }
      let posibles = 0;
      let hechos = 0;
      for (let i = 0; i < dias; i++) {
        const f = addDias(hoy, -i);
        // Rutinas con dias:[] son de lanzamiento manual → solo cuentan días con algún check.
        const aplicaFijo = diasAplica.includes(diaSemLunes(f));
        const k = f + '|' + r.id;
        const hechosDia = checksPorDiaRutina.has(k) ? checksPorDiaRutina.get(k).size : 0;
        if (aplicaFijo) {
          posibles += nItems;
          hechos += Math.min(hechosDia, nItems);
        } else if (hechosDia > 0) {
          // Día lanzado manualmente: cuenta como aplicable ese día.
          posibles += nItems;
          hechos += Math.min(hechosDia, nItems);
        }
      }
      posiblesGlobal += posibles;
      hechosGlobal += hechos;
      detalle.push({ nombre: r.nombre, icono: r.icono, pct: pct(hechos, posibles), posibles, hechos });
    }

    // Racha: días consecutivos hacia atrás desde hoy donde TODAS las rutinas que
    // aplicaban ese día se completaron (todos sus items). Corta al primer día incompleto.
    let racha = 0;
    for (let i = 0; i < 60; i++) {
      const f = addDias(hoy, -i);
      const dsem = diaSemLunes(f);
      let algunaAplica = false;
      let todoCompleto = true;
      for (const r of rutinas) {
        const items = Array.isArray(r.items) ? r.items : [];
        if (!items.length) continue;
        const aplica = (Array.isArray(r.dias) ? r.dias : []).includes(dsem);
        if (!aplica) continue;
        algunaAplica = true;
        const k = f + '|' + r.id;
        const hechosDia = checksPorDiaRutina.has(k) ? checksPorDiaRutina.get(k).size : 0;
        if (hechosDia < items.length) { todoCompleto = false; break; }
      }
      if (!algunaAplica) continue;               // día sin rutinas fijas: no corta ni suma
      if (todoCompleto) racha++; else break;
    }

    // Adherencia fija de 7 días para el cruce con nutrición (independiente del
    // selector de rango, así el cruce y su label «7 días» siempre coinciden).
    let pos7 = 0, hec7 = 0;
    const ventana7 = Math.min(7, dias); // checks disponibles cubren `dias`
    for (const r of rutinas) {
      const items = Array.isArray(r.items) ? r.items : [];
      const diasAplica = Array.isArray(r.dias) ? r.dias : [];
      if (!items.length) continue;
      for (let i = 0; i < ventana7; i++) {
        const f = addDias(hoy, -i);
        const k = f + '|' + r.id;
        const hechosDia = checksPorDiaRutina.has(k) ? checksPorDiaRutina.get(k).size : 0;
        if (diasAplica.includes(diaSemLunes(f))) { pos7 += items.length; hec7 += Math.min(hechosDia, items.length); }
        else if (hechosDia > 0) { pos7 += items.length; hec7 += Math.min(hechosDia, items.length); }
      }
    }

    const conDatos = detalle.filter(d => !d.sinItems && d.posibles > 0);
    const mejor = conDatos.length ? conDatos.reduce((a, b) => b.pct > a.pct ? b : a) : null;
    const peor = conDatos.length ? conDatos.reduce((a, b) => b.pct < a.pct ? b : a) : null;
    return {
      estado: 'ok',
      dias,
      adherenciaGlobal: pct(hechosGlobal, posiblesGlobal),
      adh7: pos7 > 0 ? pct(hec7, pos7) : null, // null si no aplicó ninguna rutina en 7 días
      hechosGlobal, posiblesGlobal,
      racha, detalle,
      mejor: mejor && conDatos.length > 1 ? mejor : null,
      peor: peor && conDatos.length > 1 && peor !== mejor ? peor : null,
      // Días con al menos un check → cruce con nutrición (adherencia vs proteína).
      diasConCheck: (() => {
        const set = new Set();
        for (const c of checks) set.add(String(c.fecha).slice(0, 10));
        return set;
      })(),
    };
  } catch (err) {
    return { estado: 'error' };
  }
}

// ---- Training: sesiones 7/30, volumen, último PR ----
async function cargarTraining() {
  try {
    const desde30 = desdeRango(30);
    const hoy = hoyStr();
    const { data: sesiones, error: eS } = await supabase.from('training_sesiones')
      .select('id, fecha, nombre')
      .eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', desde30).lte('fecha', hoy);
    if (eS) throw eS;
    const ses = sesiones || [];
    if (!ses.length) {
      // Aún puede haber PR histórico fuera del rango; pero sin sesiones recientes
      // mostramos estado con sesiones=0 y buscamos el PR igual (lectura acotada).
      return await conPRsVacio(hoy);
    }
    const desde7 = desdeRango(7);
    const idsSesion = ses.map(s => s.id);
    const sesFecha = new Map(ses.map(s => [s.id, String(s.fecha).slice(0, 10)]));

    // Sets de las sesiones del rango de 30 días → volumen + PR reciente.
    const { data: sets, error: eSet } = await supabase.from('training_sets')
      .select('sesion_id, ejercicio_id, peso, reps')
      .eq('user_id', S.userId)
      .in('sesion_id', idsSesion);
    if (eSet) throw eSet;
    const filas = sets || [];

    let volumen30 = 0;
    let volumen7 = 0;
    for (const st of filas) {
      const vol = (Number(st.peso) || 0) * (Number(st.reps) || 0);
      volumen30 += vol;
      const f = sesFecha.get(st.sesion_id);
      if (f && f >= desde7) volumen7 += vol;
    }
    const sesiones7 = ses.filter(s => String(s.fecha).slice(0, 10) >= desde7).length;
    const sesiones30 = ses.length;

    // Último PR: mejor e1RM por ejercicio en los sets del rango, tomando el más alto.
    let pr = null;
    const nombreEjercicio = await mapaEjercicios();
    for (const st of filas) {
      const est = e1rm(st.peso, st.reps);
      if (est <= 0) continue;
      if (!pr || est > pr.e1rm) {
        pr = {
          e1rm: est,
          peso: Number(st.peso) || 0,
          reps: Number(st.reps) || 0,
          ejercicio: nombreEjercicio.get(st.ejercicio_id) || 'Ejercicio',
        };
      }
    }
    // Días sin entrenar: desde la última sesión hasta hoy.
    const ultima = ses.map(s => String(s.fecha).slice(0, 10)).sort().slice(-1)[0];
    const diasSinEntrenar = ultima ? Math.max(0, Math.round((parseFecha(hoy) - parseFecha(ultima)) / 86400000)) : null;

    return {
      estado: 'ok',
      sesiones7, sesiones30, volumen7, volumen30, pr, ultima, diasSinEntrenar,
    };
  } catch (err) {
    return { estado: 'error' };
  }
}

// Mapa ejercicio_id → nombre (para etiquetar el PR). Tolerante a fallo.
async function mapaEjercicios() {
  const m = new Map();
  try {
    const { data, error } = await supabase.from('training_ejercicios')
      .select('id, nombre').eq('user_id', S.userId).eq('_deleted', false);
    if (error) throw error;
    for (const e of (data || [])) m.set(e.id, e.nombre);
  } catch (_) { /* sin nombres: el PR muestra 'Ejercicio' */ }
  return m;
}

// Sin sesiones en 30 días: card viva con ceros (no rompe el dashboard).
async function conPRsVacio(hoy) {
  return {
    estado: 'ok',
    sesiones7: 0, sesiones30: 0, volumen7: 0, volumen30: 0, pr: null,
    ultima: null, diasSinEntrenar: null, sinRecientes: true,
  };
}

/* ============================================================
   ctx para el motor de palancas — MISMA fuente de verdad que el Home.
   Traduce el estado ya cargado (S.nutricion/plata/rutina/training) al shape
   documentado en core/palancas.js. Es un mapeo PURO sobre datos en memoria: no
   dispara queries nuevas (Insights es read-only). Los campos de acción 1-tap que
   Insights no computa (creatina/sesionHoy exacto) se derivan de lo disponible o
   se omiten → las palancas que los exigen no disparan, y las ricas (semana,
   gym vs. uso, días sin entrenar) sí. BACKLOG.md §5.
   ============================================================ */
function armarCtx() {
  const ok = (x) => x && x.estado !== 'error' && x.estado !== 'vacio';
  const n = S.nutricion, p = S.plata, r = S.rutina, t = S.training;

  // Nutrición: renombra target→protTarget, piso→protPiso (shape de palancas).
  // compensacion se lee de config (read-only) para enriquecer el texto del refuerzo.
  const nutricion = ok(n) ? {
    protHoy: n.protHoy,
    protTarget: n.target != null ? n.target : null,
    protPiso: n.piso != null ? n.piso : null,
    prom7: n.prom7,
    compensacion: getConfig('nutricion', 'compensacion', null),
  } : null;

  // Plata: deriva el gasto fitness del mes desde la lista gastoGymSalud que ya
  // arma cargarPlata (misma categorización por léxico). balanceMes = balance de
  // la moneda principal (la de mayor movimiento del mes actual).
  let plata = null;
  if (ok(p)) {
    const movs = Array.isArray(p.gastoGymSalud) ? p.gastoGymSalud : [];
    let gastoFitnessMes = 0, gastoFitnessMoneda = '';
    for (const m of movs) {
      gastoFitnessMes += Number(m.monto) || 0;
      if (!gastoFitnessMoneda) gastoFitnessMoneda = String(m.moneda || '').toUpperCase();
    }
    const balances = Array.isArray(p.balances) ? p.balances : [];
    let principal = null, maxMov = -1;
    for (const b of balances) {
      const mov = (Number(b.ingreso) || 0) + (Number(b.egreso) || 0);
      if (mov > maxMov) { maxMov = mov; principal = b; }
    }
    plata = {
      gastoFitnessMes,
      gastoFitnessMoneda,
      nMovFitnessMes: movs.length,
      balanceMes: principal ? principal.balance : null,
    };
  }

  // Rutina: renombra adh7→adherencia7, racha→rachaMax. La creatina no se computa
  // acá (Insights no escanea items) → se pasan flags en false; P2/P14 no disparan.
  const rutina = ok(r) ? {
    adherencia7: r.adh7 != null ? r.adh7 : null,
    rachaMax: r.racha != null ? r.racha : 0,
    tieneItemCreatinaHoy: false,
    creatinaHoyTildada: false,
    creatinaRutinaId: null,
    creatinaItemId: null,
  } : null;

  // Training: sesionHoy se deriva de diasSinEntrenar===0 (aprox. suficiente para
  // los cruces read-only; P14/P1 dependen de entreno de hoy y acá solo informan).
  const training = ok(t) ? {
    sesionHoy: t.diasSinEntrenar === 0,
    sesiones30: t.sesiones30 != null ? t.sesiones30 : 0,
    diasSinEntrenar: t.diasSinEntrenar != null ? t.diasSinEntrenar : null,
    volumen7: t.volumen7 != null ? t.volumen7 : 0,
  } : null;

  return {
    hoy: hoyStr(),
    config: {
      umbrales: getConfig('insights', 'umbrales', null),
      pulso_pesos: getConfig('insights', 'pulso_pesos', null),
    },
    nutricion, plata, rutina, training,
  };
}

// Recalcula Pulso + palancas desde el estado actual (tras cada carga).
function recalcularPalancas() {
  const ctx = armarCtx();
  S.pulso = pulsoVida(ctx);
  // El Pulso (p15) va en su propio panel arriba → lo sacamos de la lista de cards.
  S.palancas = calcularPalancas(ctx).filter(p => p.id !== 'p15');
}

/* ============================================================
   Carga orquestada (anti-carrera por cargaId)
   ============================================================ */
async function cargarTodo() {
  const id = ++S.cargaId;
  S.cargando = true;
  paint();
  // Cada dominio resuelve su propio estado; Promise.all no falla aunque un
  // dominio devuelva {estado:'error'} (las funciones no hacen throw hacia afuera).
  const [nut, pla, rut, tra] = await Promise.all([
    cargarNutricion(), cargarPlata(), cargarRutina(), cargarTraining(),
  ]);
  if (id !== S.cargaId) return; // llegó tarde: otra carga se hizo cargo
  S.nutricion = nut;
  S.plata = pla;
  S.rutina = rut;
  S.training = tra;
  recalcularPalancas();
  S.cargando = false;
  paint();
}

// Recarga solo lo que depende del rango (rutina) al cambiar 7↔30.
async function recargarPorRango() {
  const id = ++S.cargaId;
  S.cargandoRango = true; // loading solo en las cards que dependen del rango
  paint();
  const rut = await cargarRutina();
  if (id !== S.cargaId) return;
  S.rutina = rut;
  recalcularPalancas();
  S.cargandoRango = false;
  paint();
}

/* ============================================================
   Eventos — delegación en el container (se bindea UNA vez)
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) S.boundEl.removeEventListener('click', onClick);
  S.container.addEventListener('click', onClick);
  S.boundEl = S.container;
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.ins')) return;
  const a = el.dataset.action;
  if (a === 'rango') {
    const nuevo = Number(el.dataset.rango);
    if (nuevo === S.rango) return;
    S.rango = nuevo;
    recargarPorRango();
    return;
  }
}

/* ============================================================
   Animación — dispara anillos + count-up + entrada + tilt tras cada paint.
   ============================================================ */
function animar() {
  const c = S.container;
  if (!c) return;
  c.querySelectorAll('.v-ring-fill').forEach(el => ring(el, +el.getAttribute('data-pct') || 0));
  c.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    const dec = +el.getAttribute('data-dec') || 0;
    countUp(el, to, { suffix, decimals: dec });
  });
  stagger(c.querySelectorAll('.rise'));
  tiltAll(c);
}

/* ============================================================
   Vistas — el DOM del módulo se reconstruye entero en cada paint()
   ============================================================ */
function paint() {
  if (!S.container) return;
  if (!supabase) {
    S.container.innerHTML = `
    <div class="ins">
      <div class="ins-vacio">
        <div class="ins-vacio-icono">🔌</div>
        <p>Supabase no está configurado.</p>
        <p class="ins-vacio-sub">Completá js/core/env.js con tu URL y anon key (ver SETUP.md).</p>
      </div>
    </div>`;
    return;
  }
  S.container.innerHTML = `
  <div class="ins">
    <header class="ins-head rise">
      <div class="ins-head-fila">
        <div>
          <h2 class="ins-titulo">Insights</h2>
          <p class="ins-sub">Chequeo cruzado con tus números reales. Solo lectura.</p>
        </div>
        <div class="ins-rango" role="group" aria-label="Rango de análisis">
          <button class="ins-rango-btn${S.rango === 7 ? ' activa' : ''}" data-action="rango" data-rango="7">7 días</button>
          <button class="ins-rango-btn${S.rango === 30 ? ' activa' : ''}" data-action="rango" data-rango="30">30 días</button>
        </div>
      </div>
    </header>

    ${panelPulso()}

    <div class="ins-lbl rise"><span class="ins-cap">Palancas · lo que el sistema cruzó</span><span class="ins-rule"></span></div>
    <section class="ins-palancas">${seccionPalancas()}</section>

    <div class="ins-lbl rise"><span class="ins-cap">Tus núcleos · en detalle</span><span class="ins-rule"></span></div>
    <div class="ins-grid">
      ${cardSugerencias()}
      ${cardNutricion()}
      ${cardPlata()}
      ${cardRutina()}
      ${cardTraining()}
    </div>
  </div>`;
  animar();
}

// Envoltorio de card genérico con encabezado.
function card(icono, titulo, cuerpo, extraClase = '') {
  return `
  <section class="ins-card rise lively ${extraClase}" data-tilt>
    <div class="ins-card-head">
      <span class="ins-card-icono">${icono}</span>
      <h3 class="ins-card-titulo">${esc(titulo)}</h3>
    </div>
    <div class="ins-card-cuerpo">${cuerpo}</div>
  </section>`;
}

function loadingCuerpo() { return `<div class="ins-cargando"><span class="ins-cargando-dot"></span>Cargando…</div>`; }
function sinDatosCuerpo(msg) {
  return `<div class="ins-sindatos"><span class="ins-sindatos-ic">—</span><span>${esc(msg || 'Sin datos todavía')}</span></div>`;
}

// Anillo vivo reutilizable: SVG de radio 26 + número que cuenta al centro.
// `color` es una var()/color CSS; `suffix` va pegado al número (ej. '%').
function anilloVivo(pctValor, textoCentro, color, opts = {}) {
  const p = clampPct(pctValor);
  const suffix = opts.suffix || '';
  const dec = opts.dec || 0;
  const size = opts.size || 72;
  const sw = opts.sw || 7;
  const r = 26;
  const centro = textoCentro != null
    ? `<div class="ins-ring-mini" data-count="${textoCentro}" data-suffix="${esc(suffix)}" data-dec="${dec}" style="color:${color}">0${esc(suffix)}</div>`
    : `<div class="ins-ring-mini" style="color:${color}">—</div>`;
  return `
    <div class="ins-ring" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 64 64" width="${size}" height="${size}">
        <circle class="v-ring-track" cx="32" cy="32" r="${r}" style="stroke-width:${sw}"></circle>
        <circle class="v-ring-fill" cx="32" cy="32" r="${r}" style="stroke-width:${sw};stroke:${color}" data-pct="${p}"></circle>
      </svg>
      ${centro}
    </div>`;
}

/* ---------- Panel PULSO VIDA (arriba de todo, compartido con Home) ---------- */
function panelPulso() {
  if (S.cargando) {
    return `<section class="ins-pulse rise">
      <div class="ins-pulse-ring shimmer" style="border-radius:50%"></div>
      <div class="ins-pulse-body" style="flex:1">
        <div class="shimmer" style="height:12px;width:35%;margin-bottom:10px"></div>
        <div class="shimmer" style="height:24px;width:75%"></div>
      </div>
    </section>`;
  }
  const pulso = S.pulso;
  if (!pulso) {
    // Sin ≥2 dominios con data el Pulso no es significativo → placeholder sobrio.
    return `<section class="ins-pulse ins-pulse-vacio rise">
      <div class="ins-pulse-ring ins-pulse-ring-off"><span class="ins-pulse-off-n">—</span></div>
      <div class="ins-pulse-body">
        <span class="ins-cap">Pulso VIDA</span>
        <p class="ins-pulse-txt">Todavía falta data en dos o más módulos para calcular tu pulso. Cargá comida, rutina y entrenos unos días.</p>
      </div>
    </section>`;
  }
  const comps = (pulso.componentes || []).map(c => {
    const lbl = c.k === 'adherencia' ? 'Rutina' : (c.k === 'proteina' ? 'Cuerpo' : 'Training');
    const col = c.k === 'adherencia' ? 'var(--ok)' : (c.k === 'proteina' ? 'var(--accent)' : 'var(--accent-2)');
    return `<div class="ins-feed"><div class="ins-feed-top"><span>${lbl}</span><span class="ins-num">${c.pct}</span></div>
      <div class="ins-feed-bar"><div class="ins-feed-fill" style="width:${clampPct(c.pct)}%;background:${col}"></div></div></div>`;
  }).join('');
  return `
  <section class="ins-pulse ins-pulse-z-${esc(pulso.zona)} rise">
    <div class="ins-pulse-ring">
      <svg width="112" height="112" viewBox="0 0 112 112">
        <defs><linearGradient id="insPulseGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#35e0b2"></stop><stop offset="1" stop-color="#5aa2ff"></stop>
        </linearGradient></defs>
        <circle class="v-ring-track" cx="56" cy="56" r="46" style="stroke-width:8"></circle>
        <circle class="v-ring-fill ins-pulse-fill" cx="56" cy="56" r="46" style="stroke-width:8" data-pct="${pulso.score}"></circle>
      </svg>
      <div class="ins-pulse-center">
        <span class="ins-pulse-score ins-num" data-count="${pulso.score}">0</span>
        <span class="heartbeat ins-pulse-heart"></span>
      </div>
    </div>
    <div class="ins-pulse-body">
      <span class="ins-cap">Pulso VIDA</span>
      <p class="ins-pulse-txt">${esc(pulso.texto)}</p>
      ${comps ? `<div class="ins-feeds">${comps}</div>` : ''}
    </div>
  </section>`;
}

/* ---------- Sección PALANCAS (reemplaza el viejo calcularCruces) ---------- */
// Chips de origen de cada palanca (🥩 Cuerpo · 🏋️ Training…) vía dominiosDe.
function crossHtml(cruza) {
  const nodes = dominiosDe(cruza);
  if (!nodes.length) return '';
  return `<div class="ins-cross">${nodes.map((n, i) =>
    `${i > 0 ? '<span class="ins-linknode"></span>' : ''}<span class="ins-node ins-node-${esc(n.id)}">${n.icono} ${esc(n.label)}</span>`
  ).join('')}</div>`;
}

// Una palanca rica (misma info que en Home, pero Insights no ejecuta acciones:
// las tareas/acción se muestran como lectura, sin botones 1-tap).
function palancaHtml(p) {
  const tareas = Array.isArray(p.tareas) && p.tareas.length ? `
    <div class="ins-tareas">${p.tareas.map(t => `
      <div class="ins-tarea ${t.hecho ? 'ins-tarea-ok' : ''}">
        <span class="ins-tarea-mark">${t.hecho ? '✓' : '○'}</span>
        <span class="ins-tarea-lbl">${esc(t.label)}</span>
      </div>`).join('')}</div>` : '';
  return `
    <article class="ins-palanca rise lively" data-tilt>
      <div class="ins-palanca-head">
        <span class="ins-palanca-ic">${p.icono || '⚡'}</span>
        ${crossHtml(p.cruza)}
      </div>
      <p class="ins-palanca-txt">${esc(p.texto)}</p>
      ${p.dato ? `<div class="ins-palanca-dato ins-num">${esc(p.dato)}</div>` : ''}
      ${tareas}
    </article>`;
}

function seccionPalancas() {
  if (S.cargando || S.cargandoRango) {
    return `<div class="ins-palanca ins-palanca-skel"><div class="shimmer" style="height:70px"></div></div>`;
  }
  const palancas = S.palancas || [];
  if (!palancas.length) {
    return `<div class="ins-empty">Todavía no hay suficiente data en dos o más módulos para cruzar. Cargá comida, rutina y entrenos unos días y el sistema empieza a encontrar palancas.</div>`;
  }
  return palancas.map(palancaHtml).join('');
}

/* ---------- Card Sugerencias (PRÓXIMAMENTE — no simular IA) ---------- */
function cardSugerencias() {
  return `
  <section class="ins-card ins-card-destacada rise lively" data-tilt>
    <div class="ins-card-head">
      <span class="ins-card-icono">✨</span>
      <h3 class="ins-card-titulo">Sugerencias</h3>
      <span class="ins-proximamente">Próximamente</span>
    </div>
    <div class="ins-card-cuerpo">
      <p class="ins-sug-txt">Las sugerencias personalizadas por IA y la captura por audio llegan en la próxima fase.</p>
      <p class="ins-sug-sub">El motor va a leer todos tus módulos y proponer ajustes concretos (comida, gasto, entreno) en lenguaje natural. Requiere configurar la API key de Claude.</p>
      <div class="ins-sug-nota">🔒 Se habilita en la Fase 5b (API key).</div>
    </div>
  </section>`;
}

/* ---------- Card Nutrición ---------- */
function cardNutricion() {
  if (S.cargando) return card('🥩', 'Nutrición', loadingCuerpo());
  const n = S.nutricion;
  if (!n || n.estado === 'error') return card('🥩', 'Nutrición', sinDatosCuerpo('No se pudo leer Nutrición (¿corriste sql/01?).'));
  if (n.estado === 'vacio') return card('🥩', 'Nutrición', sinDatosCuerpo('Todavía no registraste comidas esta semana.'));
  const tieneTarget = n.target != null;
  const pctHoy = tieneTarget ? Math.min(100, (n.protHoy / n.target) * 100) : 0;
  const colorAnillo = !tieneTarget ? 'var(--text-faint)'
    : (n.protHoy >= n.target ? 'var(--ok)' : (n.piso != null && n.protHoy >= n.piso ? 'var(--warn)' : 'var(--danger)'));
  const cuerpo = `
    <div class="ins-hero">
      ${tieneTarget
        ? anilloVivo(pctHoy, Math.round(pctHoy), colorAnillo, { suffix: '%' })
        : anilloVivo(0, null, 'var(--text-faint)')}
      <div class="ins-hero-read">
        <div class="ins-hero-val"><span class="ins-num" data-count="${Math.round(n.protHoy)}" data-suffix=" g">0 g</span></div>
        <div class="ins-hero-sub">Proteína hoy${tieneTarget ? ` · target ${fmtNum(n.target)} g` : ''}</div>
      </div>
    </div>
    <div class="ins-datos">
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(n.prom7)} g</span>
        <span class="ins-dato-k">Promedio 7 días${tieneTarget ? ` (target ${fmtNum(n.target)})` : ''}</span>
      </div>
      ${n.piso != null ? `
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(n.diasPiso)} / 7</span>
        <span class="ins-dato-k">Días que llegó al piso (${fmtNum(n.piso)} g)</span>
      </div>` : ''}
    </div>`;
  return card('🥩', 'Nutrición', cuerpo);
}

/* ---------- Card Plata ---------- */
function cardPlata() {
  if (S.cargando) return card('💵', 'Plata', loadingCuerpo());
  const p = S.plata;
  if (!p || p.estado === 'error') return card('💵', 'Plata', sinDatosCuerpo('No se pudo leer Plata (¿corriste sql/04?).'));
  if (p.estado === 'vacio') return card('💵', 'Plata', sinDatosCuerpo('Sin movimientos ni objetivos todavía.'));
  const balances = p.balances || [];
  let cuerpo = `<div class="ins-plata-mes">${esc(p.mesActualLabel)}</div>`;
  if (balances.length) {
    cuerpo += `<div class="ins-balances">${balances.map(b => {
      const balCls = b.balance >= 0 ? 'ins-pos' : 'ins-neg';
      const deltaTxt = b.gastoAnterior > 0
        ? `${b.deltaGasto >= 0 ? '▲' : '▼'} ${fmtMonto(Math.abs(b.deltaGasto), b.moneda)} vs ${esc(p.mesAnteriorLabel)}`
        : 'sin mes anterior para comparar';
      const deltaCls = b.deltaGasto > 0 ? 'ins-neg' : (b.deltaGasto < 0 ? 'ins-pos' : 'ins-neutro');
      return `
      <div class="ins-balance">
        <div class="ins-balance-head"><span class="ins-balance-mon">${esc(b.moneda)}</span>
          <span class="ins-balance-bal ${balCls} ins-num">${b.balance < 0 ? '−' : ''}${fmtMonto(b.balance, b.moneda)}</span></div>
        <div class="ins-balance-sub">
          <span class="ins-num">Gasto ${fmtMonto(b.gastoActual, b.moneda)}</span>
          <span class="${deltaCls} ins-num">${deltaTxt}</span>
        </div>
      </div>`;
    }).join('')}</div>`;
  } else {
    cuerpo += sinDatosCuerpo('Sin movimientos este mes.');
  }
  // Objetivo activo.
  if (p.objetivo) {
    const o = p.objetivo;
    const tieneTarget = o.target != null && o.target > 0;
    const pctObj = tieneTarget ? Math.min(100, (o.aportado / o.target) * 100) : 0;
    cuerpo += `
    <div class="ins-objetivo">
      <div class="ins-objetivo-head"><span class="ins-objetivo-nombre">🎯 ${esc(o.nombre)}</span>${tieneTarget ? `<span class="ins-objetivo-pct ins-num">${Math.floor(pctObj)}%</span>` : ''}</div>
      ${tieneTarget ? `
      <div class="ins-bar"><div class="ins-bar-fill ins-bar-accent" style="width:${pctObj}%"></div></div>
      <div class="ins-objetivo-sub ins-num">${fmtMonto(o.aportado, o.moneda)} / ${fmtMonto(o.target, o.moneda)}</div>`
      : `<div class="ins-objetivo-sub ins-num">${fmtMonto(o.aportado, o.moneda)} aportado · sin target definido</div>`}
    </div>`;
  }
  return card('💵', 'Plata', cuerpo);
}

/* ---------- Card Rutina ---------- */
function cardRutina() {
  if (S.cargando || S.cargandoRango) return card('☀️', 'Rutina', loadingCuerpo());
  const r = S.rutina;
  if (!r || r.estado === 'error') return card('☀️', 'Rutina', sinDatosCuerpo('No se pudo leer Rutina (¿corriste sql/05?).'));
  if (r.estado === 'vacio') return card('☀️', 'Rutina', sinDatosCuerpo('Todavía no tenés rutinas activas.'));
  const cuerpo = `
    <div class="ins-hero">
      ${anilloVivo(r.adherenciaGlobal, r.adherenciaGlobal, 'var(--ok)', { suffix: '%' })}
      <div class="ins-hero-read">
        <div class="ins-hero-val"><span class="ins-num" data-count="${fmtNumRaw(r.racha)}">0</span></div>
        <div class="ins-hero-sub">Racha (días completos) · adherencia ${r.dias} días</div>
      </div>
    </div>
    ${(r.mejor || r.peor) ? `
    <div class="ins-mejorpeor">
      ${r.mejor ? `<div class="ins-mp ins-mp-mejor"><span class="ins-mp-k">Mejor</span><span class="ins-mp-v">${esc(r.mejor.icono || '')} ${esc(r.mejor.nombre)} · ${r.mejor.pct}%</span></div>` : ''}
      ${r.peor ? `<div class="ins-mp ins-mp-peor"><span class="ins-mp-k">A mejorar</span><span class="ins-mp-v">${esc(r.peor.icono || '')} ${esc(r.peor.nombre)} · ${r.peor.pct}%</span></div>` : ''}
    </div>` : ''}`;
  return card('☀️', 'Rutina', cuerpo);
}

/* ---------- Card Training ---------- */
function cardTraining() {
  if (S.cargando) return card('🏋️', 'Training', loadingCuerpo());
  const t = S.training;
  if (!t || t.estado === 'error') return card('🏋️', 'Training', sinDatosCuerpo('No se pudo leer Training (¿corriste sql/06?).'));
  const cuerpo = `
    <div class="ins-datos">
      <div class="ins-dato">
        <span class="ins-dato-v ins-num" data-count="${fmtNumRaw(t.sesiones7)}">0</span>
        <span class="ins-dato-k">Sesiones 7 días</span>
      </div>
      <div class="ins-dato">
        <span class="ins-dato-v ins-num" data-count="${fmtNumRaw(t.sesiones30)}">0</span>
        <span class="ins-dato-k">Sesiones 30 días</span>
      </div>
    </div>
    <div class="ins-datos">
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(t.volumen7)}</span>
        <span class="ins-dato-k">Volumen 7 días (kg×reps)</span>
      </div>
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(t.volumen30)}</span>
        <span class="ins-dato-k">Volumen 30 días</span>
      </div>
    </div>
    ${t.pr ? `
    <div class="ins-pr">
      <span class="ins-pr-ic">🏆</span>
      <div class="ins-pr-info">
        <span class="ins-pr-ej">${esc(t.pr.ejercicio)}</span>
        <span class="ins-pr-dato ins-num">${fmtNum(t.pr.peso)} kg × ${fmtNum(t.pr.reps)} · 1RM est. ${fmtNum(t.pr.e1rm, 1)} kg</span>
      </div>
    </div>` : (t.sinRecientes ? `<div class="ins-sindatos"><span class="ins-sindatos-ic">—</span><span>Sin sesiones en los últimos 30 días.</span></div>` : '')}`;
  return card('🏋️', 'Training', cuerpo);
}

// Valor numérico crudo para data-count (el count-up formatea; acá solo el número).
function fmtNumRaw(n) { return Number(n) || 0; }

/* ============================================================
   Estilos — inyectados 1 vez, prefijo ins-, solo var(--token) + motion.css
   ============================================================ */
const CSS = `
.ins { max-width: 1040px; margin: 0 auto; padding: var(--space-4) 0 var(--space-6); font-family: var(--font-ui); color: var(--text); }
.ins * { box-sizing: border-box; }
.ins button { font: inherit; color: inherit; cursor: pointer; }
.ins button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.ins-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.ins-cap { font-size: .68rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

/* Header */
.ins-head { margin-bottom: var(--space-5); }
.ins-head-fila { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.ins-titulo { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: clamp(1.5rem, 3.5vw, 2rem); letter-spacing: -.02em; }
.ins-sub { margin: var(--space-1) 0 0; font-size: .88rem; color: var(--text-dim); }
.ins-rango { display: flex; gap: var(--space-1); background: var(--surface-2); border-radius: var(--radius); padding: var(--space-1); flex: none; }
.ins-rango-btn { min-height: 38px; padding: var(--space-1) var(--space-3); border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-dim); font-weight: 600; font-size: .82rem; transition: background var(--dur) ease, color var(--dur) ease; }
.ins-rango-btn.activa { background: var(--accent-soft); color: var(--accent); }

/* Label de sección */
.ins-lbl { display: flex; align-items: center; gap: var(--space-3); margin: 0 2px var(--space-3); }
.ins-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--border-strong), transparent); }

/* ---- Pulso VIDA ---- */
.ins-pulse { position: relative; display: flex; align-items: center; gap: clamp(16px, 3vw, 28px); padding: clamp(18px, 3vw, 26px); margin-bottom: var(--space-6); border-radius: var(--radius-lg); overflow: hidden;
  background: linear-gradient(135deg, rgba(53,224,178,.07), rgba(90,162,255,.06)), var(--surface); border: 1px solid var(--border-strong); }
.ins-pulse::before { content: ""; position: absolute; width: 320px; height: 320px; left: -50px; top: -140px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(53,224,178,.12), transparent 65%); animation: vida-breathe 5s ease-in-out infinite; }
.ins-pulse-z-bajo::before { background: radial-gradient(circle, rgba(242,109,109,.10), transparent 65%); }
.ins-pulse-ring { position: relative; width: 112px; height: 112px; flex: none; }
.ins-pulse-ring svg { transform: rotate(-90deg); }
.ins-pulse-fill { stroke: url(#insPulseGrad); }
.ins-pulse-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.ins-pulse-score { font-weight: 700; font-size: 2.1rem; line-height: 1; }
.ins-pulse-heart { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px 2px rgba(53,224,178,.6); }
.ins-pulse-body { min-width: 0; }
.ins-pulse-txt { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: .95rem; max-width: 52ch; line-height: 1.5; }
.ins-feeds { display: flex; gap: var(--space-4); margin-top: var(--space-4); flex-wrap: wrap; }
.ins-feed { display: flex; flex-direction: column; gap: 5px; min-width: 78px; }
.ins-feed-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: .7rem; font-weight: 700; color: var(--text-dim); }
.ins-feed-bar { height: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.ins-feed-fill { height: 100%; border-radius: 999px; transition: width var(--dur-slow) var(--ease-out-expo); }
/* Pulso sin data (placeholder sobrio) */
.ins-pulse-vacio { background: var(--surface); border-style: dashed; }
.ins-pulse-ring-off { display: grid; place-items: center; border-radius: 50%; border: 2px dashed var(--border-strong); }
.ins-pulse-off-n { font-family: var(--font-num); font-size: 2rem; color: var(--text-faint); }
@media (max-width: 560px) { .ins-pulse { flex-direction: column; align-items: flex-start; } .ins-feeds { width: 100%; } }

/* ---- Palancas ---- */
.ins-palancas { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-bottom: var(--space-6); }
@media (max-width: 720px) { .ins-palancas { grid-template-columns: 1fr; } }
.ins-palanca { position: relative; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.ins-palanca:hover { border-color: var(--border-strong); }
.ins-palanca-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.ins-palanca-ic { width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center; background: var(--accent-soft); font-size: 1rem; }
.ins-cross { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ins-node { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; font-size: .62rem; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; background: var(--surface-2); color: var(--text-dim); }
.ins-node-cuerpo { background: var(--accent-soft); color: var(--accent); }
.ins-node-plata { background: var(--accent-2-soft); color: var(--accent-2); }
.ins-node-rutina { background: rgba(67,209,124,.13); color: var(--ok); }
.ins-node-training { background: var(--accent-2-soft); color: var(--accent-2); }
.ins-linknode { width: 14px; height: 1.5px; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.ins-palanca-txt { margin: 0; font-size: .95rem; line-height: 1.5; color: var(--text); }
.ins-palanca-dato { margin-top: var(--space-2); font-size: .76rem; color: var(--text-faint); }
.ins-tareas { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-1); }
.ins-tarea { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); font-size: .84rem; }
.ins-tarea-mark { font-family: var(--font-num); color: var(--text-faint); }
.ins-tarea-ok .ins-tarea-mark { color: var(--ok); }
.ins-tarea-lbl { flex: 1; min-width: 0; }
.ins-palanca-skel { grid-column: 1 / -1; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); }
.ins-empty { grid-column: 1 / -1; padding: var(--space-6); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); color: var(--text-dim); text-align: center; font-size: .9rem; }

/* Grid de cards */
.ins-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }

/* Card base */
.ins-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-1); overflow: hidden; }
.ins-card-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.ins-card-icono { font-size: 1.15rem; flex: none; }
.ins-card-titulo { margin: 0; font-family: var(--font-display); font-size: 1rem; flex: 1; min-width: 0; }
.ins-card-cuerpo { display: flex; flex-direction: column; gap: var(--space-4); }

/* Card destacada (Sugerencias) */
.ins-card-destacada { border-color: var(--accent-2); background: linear-gradient(160deg, var(--accent-2-soft), transparent 60%), var(--surface); }
.ins-proximamente { flex: none; padding: 3px 10px; background: var(--accent-2-soft); border: 1px solid var(--accent-2); border-radius: 999px; color: var(--accent-2); font-size: .64rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.ins-sug-txt { margin: 0; font-size: .95rem; color: var(--text); }
.ins-sug-sub { margin: 0; font-size: .82rem; color: var(--text-dim); }
.ins-sug-nota { margin-top: var(--space-1); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); font-size: .78rem; color: var(--text-faint); }

/* Hero de card con anillo vivo */
.ins-hero { display: flex; align-items: center; gap: var(--space-4); }
.ins-ring { position: relative; flex: none; }
.ins-ring svg { transform: rotate(-90deg); }
.ins-ring-mini { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-num); font-weight: 700; font-size: .82rem; letter-spacing: -.02em; }
.ins-hero-read { min-width: 0; }
.ins-hero-val { font-weight: 700; line-height: 1; }
.ins-hero-val .ins-num { font-size: 1.7rem; }
.ins-hero-sub { margin-top: 5px; font-size: .78rem; color: var(--text-dim); line-height: 1.35; }

/* Barra de progreso (objetivo de plata) */
.ins-bar { height: 10px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.ins-bar-fill { height: 100%; border-radius: 999px; background: var(--text-faint); transition: width var(--dur-slow) var(--ease-out-expo); }
.ins-bar-accent { background: var(--accent-2); }

/* Datos en grilla (2 col) */
.ins-datos { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.ins-dato { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3) var(--space-2); background: var(--surface-2); border-radius: var(--radius); }
.ins-dato-v { font-size: 1.1rem; font-weight: 700; }
.ins-dato-k { font-size: .68rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .04em; line-height: 1.3; }

/* Mejor/peor rutina */
.ins-mejorpeor { display: flex; flex-direction: column; gap: var(--space-1); }
.ins-mp { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-1) var(--space-3); background: var(--surface-2); border-radius: var(--radius); font-size: .82rem; }
.ins-mp-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); }
.ins-mp-v { overflow-wrap: anywhere; text-align: right; }
.ins-mp-mejor { border-left: 3px solid var(--ok); }
.ins-mp-peor { border-left: 3px solid var(--warn); }

/* Plata */
.ins-plata-mes { font-size: .74rem; text-transform: capitalize; letter-spacing: .03em; color: var(--text-faint); }
.ins-balances { display: flex; flex-direction: column; gap: var(--space-2); }
.ins-balance { padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); }
.ins-balance-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.ins-balance-mon { font-size: .82rem; font-weight: 700; color: var(--text-dim); letter-spacing: .04em; }
.ins-balance-bal { font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
.ins-balance-sub { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-1); font-size: .74rem; color: var(--text-dim); flex-wrap: wrap; }
.ins-pos { color: var(--ok); }
.ins-neg { color: var(--danger); }
.ins-neutro { color: var(--text-faint); }
.ins-objetivo { padding-top: var(--space-3); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--space-2); }
.ins-objetivo-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.ins-objetivo-nombre { font-size: .88rem; font-weight: 600; overflow-wrap: anywhere; }
.ins-objetivo-pct { font-size: .82rem; font-weight: 700; color: var(--accent-2); }
.ins-objetivo-sub { font-size: .78rem; color: var(--text-dim); }

/* PR */
.ins-pr { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); border-left: 3px solid var(--accent); }
.ins-pr-ic { font-size: 1.3rem; flex: none; }
.ins-pr-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ins-pr-ej { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }
.ins-pr-dato { font-size: .78rem; color: var(--text-dim); }

/* Sin datos / cargando */
.ins-sindatos { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-2); color: var(--text-faint); font-size: .85rem; }
.ins-sindatos-ic { font-family: var(--font-num); opacity: .6; }
.ins-cargando { display: flex; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-5) var(--space-2); text-align: center; color: var(--text-faint); font-size: .85rem; }
.ins-cargando-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: vida-heart 2.4s ease-in-out infinite; }

/* Vacío global */
.ins-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.ins-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.ins-vacio p { margin: 0 0 var(--space-2); }
.ins-vacio-sub { font-size: .82rem; color: var(--text-faint); }

/* Desktop: 2 columnas, destacada full-width */
@media (min-width: 768px) {
  .ins-grid { grid-template-columns: 1fr 1fr; }
  .ins-card-destacada { grid-column: 1 / -1; }
}
`;

function inyectarEstilos() {
  if (document.getElementById('ins-styles')) return;
  const st = document.createElement('style');
  st.id = 'ins-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'insights',
  label: 'Insights',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.rango = 7;
    S.nutricion = null;
    S.plata = null;
    S.rutina = null;
    S.training = null;
    S.palancas = null;
    S.pulso = null;
    S.cargando = true;
    S.cargandoRango = false;
    inyectarEstilos();
    bind();
    if (!supabase) { paint(); return; }
    await cargarTodo();
  },

  render() {
    if (!S.container) return;
    if (!supabase) { paint(); return; }
    // Al volver de otra ruta el container tiene el DOM de otro módulo →
    // repintamos y refrescamos (dashboard read-only: refetch al entrar).
    paint();
    cargarTodo();
  },
};
