// VIDA — Módulo Training (Fase 4) · piel "Instrumento Vivo"
// Sesión (registrar rápido) · Historial · Progreso
// Contrato: docs/CONTRATOS.md §12. Interfaz canónica: §4.
//
// RE-SKIN + FEATURES (BACKLOG §2 Training): la LÓGICA DE DATOS quedó intacta
// (queries, inserts/updates con debounce, soft-delete, guards anti doble-tap /
// anti-carrera, contrato init/render, config grupos/unidades). Lo nuevo:
//   1) Timer de descanso flotante (anillo SVG que se vacía) — 100% client-side,
//      vive fuera del repaint del módulo (fixed en <body>), rAF propio.
//   2) Auto-detección de PR (peso y 1RM Epley) al persistir un set → badge + destello.
//   3) Volumen por grupo muscular (barras horizontales) en Progreso.
// Movimiento reutilizado de core/anim.js + clases de css/motion.css.
import { supabase } from '../core/supabase.js';
import { toast, confirmDialog } from '../core/ui.js';
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local del dispositivo)
   ============================================================ */
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function parseFecha(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDias(s, n) { const d = parseFecha(s); d.setDate(d.getDate() + n); return fmtFecha(d); }
function diaIdx(s) { return (parseFecha(s).getDay() + 6) % 7; } // lunes=0
function labelFecha(s) {
  const hoy = hoyStr();
  if (s === hoy) return 'Hoy';
  if (s === addDias(hoy, -1)) return 'Ayer';
  if (s === addDias(hoy, 1)) return 'Mañana';
  const d = parseFecha(s);
  return DIAS[diaIdx(s)] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()];
}
function labelCorto(s) { const d = parseFecha(s); return d.getDate() + '/' + (d.getMonth() + 1); }
function labelLargo(s) { const d = parseFecha(s); return DIAS[diaIdx(s)] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()]; }
function diasEntre(a, b) { return Math.round((parseFecha(b) - parseFecha(a)) / 86400000); }

/* ============================================================
   Utilidades
   ============================================================ */
const NF = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
function num(n) { return NF.format(Number(n) || 0); }
function num0(n) { return NF0.format(Number(n) || 0); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }

// 1RM estimado — Epley. Con reps 0 el factor es 1 → devuelve el peso crudo.
// Nunca divide por cero: 30 es constante.
function epley(peso, reps) {
  const p = Number(peso) || 0;
  const r = Number(reps) || 0;
  return p * (1 + r / 30);
}

/* ============================================================
   Estado del módulo (el DOM se repinta entero en cada paint)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,
  boundEl: null,           // container atado a los listeners (si cambia, se re-bindea)
  tab: 'sesion',           // 'sesion' | 'historial' | 'progreso'
  fecha: hoyStr(),         // día visible en Sesión
  ejercicios: [],          // catálogo (training_ejercicios)
  sesion: null,            // sesión del día visible (o null si no hay)
  sets: [],                // sets de la sesión visible (training_sets)
  previos: {},             // ejercicio_id → { fecha, sets:[{peso,reps}] } último registro previo
  historial: [],           // [{ sesion, sets:[...] }] para el tab Historial
  historialCargado: false,
  progresoEjId: '',        // ejercicio seleccionado en Progreso
  progresoData: null,      // { ejercicio, puntos:[{fecha, mejorPeso, mejor1rm}] }
  progresoCargando: false,
  volGrupo: null,          // [{grupo,label,vol}] volumen semanal por músculo (tab Progreso)
  volGrupoCargado: false,
  volGrupoCargando: false,
  cargando: false,
  cargandoHist: false,
  mutando: false,          // in-flight guard de inserts/updates/deletes (doble tap)
  ejPicker: null,          // { crear: bool } → modal de agregar ejercicio a la sesión
  busca: '',               // búsqueda en el picker de ejercicios
  expandidas: {},          // sesion_id → bool (historial: detalle abierto)
  ultimaCarga: 0,
  prPorEj: {},             // ejercicio_id → { peso, e1rm } mejor histórico ANTERIOR a hoy (para detectar PR)
  setsPR: {},              // set_id → { peso:bool, e1rm:bool } sets de HOY que batieron récord (badge 🔥)
};

/* ============================================================
   Timer de descanso — estado propio, VIVE FUERA del repaint.
   El módulo repinta todo el DOM en cada paint(); un contador flotante no puede
   colgar de ahí o se reiniciaría a cada tecla. Se monta como elemento fixed en
   <body>, con su propio rAF, y sobrevive a los paint(). Cero DB en el tick.
   ============================================================ */
const TIMER = {
  el: null,          // nodo flotante en <body>
  ringFill: null,    // <circle> del anillo
  numEl: null,       // texto de segundos restantes
  raf: 0,            // handle de requestAnimationFrame
  finAt: 0,          // timestamp (ms) en que termina
  durMs: 0,          // duración total de esta cuenta
  warned: false,     // ya entró en la zona --warn (últimos 10s)
  activo: false,
};
const TIMER_WARN_MS = 10000; // últimos 10s → color de alerta

// Debounce de persistencia de edición inline de sets: el input se edita en
// vivo en el estado local (repintado optimista) y se manda a la DB tras una
// pausa de tipeo → no spameamos un UPDATE por tecla. Un timer por set_id.
const guardadoInline = new Map(); // set_id → timeout handle
let persistsEnVuelo = 0;          // UPDATEs de set en curso (debounce ya disparado)
const DEBOUNCE_MS = 700;

// Hay edición inline sin confirmar si queda un debounce pendiente o un UPDATE en vuelo.
function edicionPendiente() { return guardadoInline.size > 0 || persistsEnVuelo > 0; }

/* ============================================================
   Config del usuario — TODO viene de user_config, nada hardcodeado
   ============================================================ */
function cfgGrupos() {
  const g = S.config ? S.config.get('grupos', []) : [];
  return Array.isArray(g) ? g.filter(x => x && x.id && x.label) : [];
}
function cfgUnidades() {
  const u = S.config ? S.config.get('unidades', []) : [];
  const lista = Array.isArray(u) ? u.filter(x => typeof x === 'string' && x.trim()) : [];
  return lista;
}
function labelGrupo(id) {
  const g = cfgGrupos().find(x => x.id === id);
  return g ? g.label : (id || '');
}
function unidadDefault() { const u = cfgUnidades(); return u.length ? u[0] : 'kg'; }
function configLista() { return cfgGrupos().length > 0; }

// Descanso default (segundos). Configurable vía user_config training.descanso_seg;
// si no está seedeado, cae a 90s. Nada hardcodeado del usuario (regla de oro).
function descansoSegDefault() {
  const v = S.config ? Number(S.config.get('descanso_seg', 90)) : 90;
  return (isFinite(v) && v > 0) ? Math.round(v) : 90;
}

/* ============================================================
   Datos — Supabase (siempre .eq('user_id') + soft delete donde exista)
   ============================================================ */
async function cargarEjercicios() {
  const { data, error } = await supabase.from('training_ejercicios').select('*')
    .eq('user_id', S.userId).eq('_deleted', false).order('nombre');
  if (error) throw error;
  S.ejercicios = data || [];
}

// Sesión + sets del día visible. Anti-carrera: captura la fecha pedida y
// devuelve false si el usuario ya navegó a otro día antes de que llegue la
// respuesta (no pisar el estado bajo un label que ya no corresponde).
async function cargarSesion(silencioso = false) {
  const fecha = S.fecha;
  const { data: ses, error: e1 } = await supabase.from('training_sesiones').select('*')
    .eq('user_id', S.userId).eq('_deleted', false).eq('fecha', fecha)
    .order('created_at').limit(1);
  if (e1) throw e1;
  if (fecha !== S.fecha) return false;
  const sesion = (ses && ses.length) ? ses[0] : null;
  let sets = [];
  if (sesion) {
    const { data: st, error: e2 } = await supabase.from('training_sets').select('*')
      .eq('user_id', S.userId).eq('sesion_id', sesion.id)
      .order('orden').order('set_num');
    if (e2) throw e2;
    if (fecha !== S.fecha) return false;
    sets = st || [];
  }
  // En refetch silencioso, si apareció una edición inline mientras traíamos los
  // sets, no pisar el valor recién tipeado con la fila vieja de la DB.
  if (silencioso && edicionPendiente()) return false;
  S.sesion = sesion;
  S.sets = sets;
  // Referencia "último previo" por cada ejercicio de la sesión actual.
  await cargarPreviosDeSesion();
  if (fecha !== S.fecha) return false;
  // Baseline de PR (mejor histórico previo) para detectar récords de hoy.
  await cargarPRDeSesion();
  if (fecha !== S.fecha) return false;
  return true;
}

// Para cada ejercicio presente en la sesión visible, trae su registro previo:
// los sets de la sesión ANTERIOR (fecha < la visible) donde aparece. Sirve de
// referencia de "cuánto meter". Una query por ejercicio de la sesión.
async function cargarPreviosDeSesion() {
  const ids = [...new Set(S.sets.map(s => s.ejercicio_id))];
  const fecha = S.fecha;
  const previos = {};
  for (const ejId of ids) {
    const prev = await ultimoPrevio(ejId, fecha);
    if (fecha !== S.fecha) return;
    if (prev) previos[ejId] = prev;
  }
  if (fecha !== S.fecha) return;
  S.previos = previos;
}

// Última sesión (fecha < corte) donde aparece ejId, con sus sets. Null si no hay.
async function ultimoPrevio(ejId, corteFecha) {
  // Sesiones del ejercicio antes del corte, más reciente primero.
  const { data: sets, error } = await supabase.from('training_sets')
    .select('id, sesion_id, peso, reps, set_num, training_sesiones!inner(fecha, _deleted)')
    .eq('user_id', S.userId).eq('ejercicio_id', ejId)
    .eq('training_sesiones._deleted', false)
    .lt('training_sesiones.fecha', corteFecha)
    .order('fecha', { ascending: false, referencedTable: 'training_sesiones' })
    .order('set_num');
  if (error) {
    // No romper la carga de la sesión si la referencia falla.
    console.warn('[training] no se pudo cargar el previo de', ejId, error);
    return null;
  }
  if (!sets || !sets.length) return null;
  // Quedarnos con los sets de la sesión más reciente encontrada.
  let mejorFecha = '';
  for (const s of sets) {
    const f = s.training_sesiones ? String(s.training_sesiones.fecha).slice(0, 10) : '';
    if (f > mejorFecha) mejorFecha = f;
  }
  const delDia = sets
    .filter(s => (s.training_sesiones ? String(s.training_sesiones.fecha).slice(0, 10) : '') === mejorFecha)
    .map(s => ({ peso: Number(s.peso) || 0, reps: Number(s.reps) || 0 }));
  return { fecha: mejorFecha, sets: delDia };
}

// Historial: sesiones (todas, más nueva arriba) + sus sets, en 2 queries.
async function cargarHistorial() {
  const { data: ses, error: e1 } = await supabase.from('training_sesiones').select('*')
    .eq('user_id', S.userId).eq('_deleted', false)
    .order('fecha', { ascending: false }).order('created_at', { ascending: false });
  if (e1) throw e1;
  const sesiones = ses || [];
  let setsByS = new Map();
  if (sesiones.length) {
    const ids = sesiones.map(s => s.id);
    const { data: st, error: e2 } = await supabase.from('training_sets').select('*')
      .eq('user_id', S.userId).in('sesion_id', ids)
      .order('orden').order('set_num');
    if (e2) throw e2;
    for (const s of (st || [])) {
      if (!setsByS.has(s.sesion_id)) setsByS.set(s.sesion_id, []);
      setsByS.get(s.sesion_id).push(s);
    }
  }
  S.historial = sesiones.map(se => ({ sesion: se, sets: setsByS.get(se.id) || [] }));
}

// Volumen por grupo muscular de los últimos `dias` días (Σ peso×reps). Junta los
// sets con la fecha de su sesión (solo no borradas) y mapea ejercicio→grupo con
// el catálogo ya cargado en memoria. Devuelve [{grupo, label, vol}] desc.
async function cargarVolumenPorGrupo(dias = 7) {
  const desde = addDias(hoyStr(), -(dias - 1));
  const { data, error } = await supabase.from('training_sets')
    .select('peso, reps, ejercicio_id, training_sesiones!inner(fecha, _deleted)')
    .eq('user_id', S.userId)
    .eq('training_sesiones._deleted', false)
    .gte('training_sesiones.fecha', desde);
  if (error) throw error;
  // ejercicio_id → grupo (del catálogo). Sin grupo → 'otro'.
  const grupoDeEj = new Map(S.ejercicios.map(e => [e.id, e.grupo || 'otro']));
  const acum = new Map(); // grupo_id → vol
  for (const s of (data || [])) {
    const g = grupoDeEj.get(s.ejercicio_id) || 'otro';
    const v = (Number(s.peso) || 0) * (Number(s.reps) || 0);
    if (v <= 0) continue;
    acum.set(g, (acum.get(g) || 0) + v);
  }
  const arr = [...acum.entries()].map(([g, vol]) => ({ grupo: g, label: labelGrupo(g) || g, vol }));
  arr.sort((a, b) => b.vol - a.vol);
  return arr;
}

// Progreso de un ejercicio: mejor set por sesión a lo largo del tiempo.
async function cargarProgreso(ejId) {
  const { data, error } = await supabase.from('training_sets')
    .select('peso, reps, set_num, sesion_id, training_sesiones!inner(fecha, _deleted)')
    .eq('user_id', S.userId).eq('ejercicio_id', ejId)
    .eq('training_sesiones._deleted', false)
    .order('fecha', { ascending: true, referencedTable: 'training_sesiones' });
  if (error) throw error;
  // Agrupar por fecha de sesión → mejor peso y mejor 1RM del día.
  const porFecha = new Map();
  for (const s of (data || [])) {
    const f = s.training_sesiones ? String(s.training_sesiones.fecha).slice(0, 10) : '';
    if (!f) continue;
    const peso = Number(s.peso) || 0;
    const reps = Number(s.reps) || 0;
    const rm = epley(peso, reps);
    const prev = porFecha.get(f) || { fecha: f, mejorPeso: 0, mejor1rm: 0 };
    if (peso > prev.mejorPeso) prev.mejorPeso = peso;
    if (rm > prev.mejor1rm) prev.mejor1rm = rm;
    porFecha.set(f, prev);
  }
  const puntos = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  return puntos;
}

/* ============================================================
   Derivados
   ============================================================ */
function ejercicioNombre(id) {
  const e = S.ejercicios.find(x => x.id === id);
  return e ? e.nombre : 'Ejercicio';
}
function ejercicioUnidad(id) {
  const e = S.ejercicios.find(x => x.id === id);
  return e ? (e.unidad || unidadDefault()) : unidadDefault();
}

// Sets de la sesión visible agrupados por ejercicio, respetando el orden del
// ejercicio dentro de la sesión (campo `orden`) y el set_num.
function ejerciciosDeSesion() {
  const grupos = new Map(); // ejercicio_id → { ejId, orden, sets:[] }
  for (const s of S.sets) {
    if (!grupos.has(s.ejercicio_id)) {
      grupos.set(s.ejercicio_id, { ejId: s.ejercicio_id, orden: Number(s.orden) || 0, sets: [] });
    }
    const g = grupos.get(s.ejercicio_id);
    g.sets.push(s);
    // El orden del ejercicio es el menor `orden` visto entre sus sets.
    if ((Number(s.orden) || 0) < g.orden) g.orden = Number(s.orden) || 0;
  }
  const arr = [...grupos.values()];
  arr.sort((a, b) => (a.orden - b.orden) || String(ejercicioNombre(a.ejId)).localeCompare(String(ejercicioNombre(b.ejId))));
  for (const g of arr) g.sets.sort((a, b) => (Number(a.set_num) || 0) - (Number(b.set_num) || 0));
  return arr;
}

// Volumen de un conjunto de sets = Σ peso × reps.
function volumen(sets) {
  let v = 0;
  for (const s of sets) v += (Number(s.peso) || 0) * (Number(s.reps) || 0);
  return v;
}

function resumenSesion(sets) {
  const ejs = new Set(sets.map(s => s.ejercicio_id));
  return { nEjercicios: ejs.size, nSets: sets.length, volumen: volumen(sets) };
}

function ejerciciosFiltrados() {
  const q = S.busca.trim().toLowerCase();
  const enSesion = new Set(S.sets.map(s => s.ejercicio_id));
  return S.ejercicios
    .filter(e => !q || String(e.nombre).toLowerCase().includes(q))
    .sort((a, b) =>
      ((enSesion.has(a.id) ? 1 : 0) - (enSesion.has(b.id) ? 1 : 0)) || // ya-en-sesión al fondo
      String(a.nombre).localeCompare(String(b.nombre)));
}

// PR (récord) de un ejercicio sobre puntos de progreso: mayor 1RM estimado.
function prDe(puntos) {
  let pr = null;
  for (const p of puntos) {
    if (!pr || p.mejor1rm > pr.mejor1rm) pr = p;
  }
  return pr;
}

/* ============================================================
   Auto-detección de PR — comparación SOLO de lectura, sin tabla nueva.
   El "récord a batir" = mejor peso y mejor 1RM (Epley) del ejercicio en
   sesiones ANTERIORES a la visible. Al persistir un set de hoy, si supera el
   baseline → badge 🔥 + destello. Recalculado sobre los datos ya cargados.
   ============================================================ */

// Baseline histórico por cada ejercicio de la sesión visible: {peso, e1rm} del
// mejor set en fechas < la visible. Sin datos previos → {peso:0, e1rm:0} (todo
// batido cuenta como PR "primera marca"). Una query por ejercicio (barata).
async function cargarPRDeSesion() {
  const ids = [...new Set(S.sets.map(s => s.ejercicio_id))];
  const fecha = S.fecha;
  const prs = {};
  for (const ejId of ids) {
    const base = await mejorHistorico(ejId, fecha);
    if (fecha !== S.fecha) return;
    prs[ejId] = base;
  }
  if (fecha !== S.fecha) return;
  S.prPorEj = prs;
  recomputarPRsSesion();
}

// Mejor peso y mejor 1RM del ejercicio en sesiones con fecha < corte. Tolerante:
// si falla, devuelve baseline en 0 (no rompe la carga de la sesión).
async function mejorHistorico(ejId, corteFecha) {
  const { data, error } = await supabase.from('training_sets')
    .select('peso, reps, training_sesiones!inner(fecha, _deleted)')
    .eq('user_id', S.userId).eq('ejercicio_id', ejId)
    .eq('training_sesiones._deleted', false)
    .lt('training_sesiones.fecha', corteFecha);
  if (error) {
    console.warn('[training] no se pudo cargar el PR histórico de', ejId, error);
    return { peso: 0, e1rm: 0 };
  }
  let peso = 0, e1rm = 0;
  for (const s of (data || [])) {
    const p = Number(s.peso) || 0;
    const rm = epley(p, Number(s.reps) || 0);
    if (p > peso) peso = p;
    if (rm > e1rm) e1rm = rm;
  }
  return { peso, e1rm };
}

// Recorre los sets de HOY y marca cuáles baten el baseline histórico. Además
// contempla PRs "dentro del mismo día" (el mejor set de hoy manda). Escribe
// S.setsPR = { set_id: {peso, e1rm} }. Puro sobre el estado (sin red).
function recomputarPRsSesion() {
  const marcas = {};
  // Agrupar sets de hoy por ejercicio para resolver el mejor del día.
  const porEj = new Map();
  for (const s of S.sets) {
    if (!porEj.has(s.ejercicio_id)) porEj.set(s.ejercicio_id, []);
    porEj.get(s.ejercicio_id).push(s);
  }
  for (const [ejId, sets] of porEj) {
    const base = S.prPorEj[ejId] || { peso: 0, e1rm: 0 };
    // Umbral mínimo para no marcar sets vacíos (peso 0) como récord.
    let mejorPeso = base.peso, mejorRm = base.e1rm;
    // Orden estable por set_num para que "primer set que rompe" gane el badge.
    const ordenados = sets.slice().sort((a, b) => (Number(a.set_num) || 0) - (Number(b.set_num) || 0));
    for (const s of ordenados) {
      const p = Number(s.peso) || 0;
      const reps = Number(s.reps) || 0;
      if (p <= 0) continue; // set en blanco: no es marca
      const rm = epley(p, reps);
      const m = { peso: false, e1rm: false };
      if (p > mejorPeso + 1e-6) { m.peso = true; mejorPeso = p; }
      if (rm > mejorRm + 1e-6) { m.e1rm = true; mejorRm = rm; }
      if (m.peso || m.e1rm) marcas[s.id] = m;
    }
  }
  S.setsPR = marcas;
}

// ¿El set batió algún récord? (para pintar el badge en su fila)
function prDeSet(setId) { return S.setsPR[setId] || null; }

/* ============================================================
   Mutaciones — Sesión
   ============================================================ */
async function empezarSesion() {
  if (S.mutando) return; // doble tap
  if (S.sesion) return;
  const fecha = S.fecha;
  S.mutando = true;
  try {
    const { data, error } = await supabase.from('training_sesiones')
      .insert({ user_id: S.userId, fecha })
      .select().single();
    if (error) throw error;
    if (S.fecha === fecha) { S.sesion = data; S.sets = []; }
    toast('Sesión iniciada', 'success');
    paint();
  } catch (err) {
    toast('No se pudo iniciar la sesión: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function guardarNombreSesion(nombre) {
  if (!S.sesion) return;
  const val = String(nombre || '').trim() || null;
  if (val === (S.sesion.nombre || null)) return;
  try {
    const { data, error } = await supabase.from('training_sesiones')
      .update({ nombre: val })
      .eq('id', S.sesion.id).eq('user_id', S.userId)
      .select().single();
    if (error) throw error;
    if (S.sesion && S.sesion.id === data.id) Object.assign(S.sesion, data);
  } catch (err) {
    toast('No se pudo guardar el nombre: ' + msgErr(err), 'error');
  }
}

async function borrarSesion(id) {
  const item = S.historial.find(h => h.sesion.id === id);
  const ses = item ? item.sesion : (S.sesion && S.sesion.id === id ? S.sesion : null);
  if (!ses) return;
  const ok = await confirmDialog({
    title: 'Borrar sesión',
    message: '¿Borrás la sesión del ' + labelLargo(String(ses.fecha).slice(0, 10)) + '? Se van también sus series.',
    confirmText: 'Borrar',
    danger: true,
  });
  if (!ok) return;
  if (S.mutando) return;
  S.mutando = true;
  try {
    const { error } = await supabase.from('training_sesiones')
      .update({ _deleted: true })
      .eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.historial = S.historial.filter(h => h.sesion.id !== id);
    if (S.sesion && S.sesion.id === id) { S.sesion = null; S.sets = []; S.previos = {}; }
    toast('Sesión borrada', 'success');
    paint();
  } catch (err) {
    toast('No se pudo borrar la sesión: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

/* ============================================================
   Mutaciones — Ejercicios (catálogo + agregar a sesión)
   ============================================================ */
// Asegura que exista una sesión para el día visible (crea si falta) y devuelve
// su id. Devuelve null si la creación falla o el usuario navegó de día.
async function asegurarSesion() {
  if (S.sesion) return S.sesion.id;
  const fecha = S.fecha;
  const { data, error } = await supabase.from('training_sesiones')
    .insert({ user_id: S.userId, fecha })
    .select().single();
  if (error) throw error;
  if (S.fecha !== fecha) return null;
  S.sesion = data;
  S.sets = [];
  return data.id;
}

// Agrega un ejercicio a la sesión: crea la sesión si no existe y le mete un
// primer set en blanco (peso/reps 0) listo para tipear.
async function agregarEjercicioASesion(ejId) {
  if (S.mutando) return;
  const ej = S.ejercicios.find(x => x.id === ejId);
  if (!ej) return;
  // Ya está en la sesión: no re-agregar (duplicaría el bloque de sets).
  if (S.sets.some(s => s.ejercicio_id === ejId)) {
    toast('Ese ejercicio ya está en la sesión', 'info');
    return;
  }
  const fecha = S.fecha;
  S.mutando = true;
  try {
    const sesionId = await asegurarSesion();
    if (!sesionId) { S.mutando = false; return; }
    // Orden = (máximo orden actual) + 1, para que quede al final.
    const ordenes = S.sets.map(s => Number(s.orden) || 0);
    const orden = ordenes.length ? Math.max(...ordenes) + 1 : 0;
    const fila = {
      user_id: S.userId, sesion_id: sesionId, ejercicio_id: ejId,
      orden, set_num: 1, peso: 0, reps: 0, completado: true,
    };
    const { data, error } = await supabase.from('training_sets').insert(fila).select().single();
    if (error) throw error;
    if (S.fecha === fecha) {
      S.sets.push(data);
      // Traer la referencia del previo de este ejercicio (si no la teníamos).
      if (!S.previos[ejId]) {
        const prev = await ultimoPrevio(ejId, fecha);
        if (S.fecha === fecha && prev) S.previos[ejId] = prev;
      }
      // Baseline de PR del ejercicio recién sumado (para detectar récords).
      if (!S.prPorEj[ejId]) {
        const base = await mejorHistorico(ejId, fecha);
        if (S.fecha === fecha) S.prPorEj[ejId] = base;
      }
      recomputarPRsSesion();
    }
    S.ejPicker = null;
    S.busca = '';
    toast('Agregado: ' + ej.nombre, 'success');
    paint();
  } catch (err) {
    toast('No se pudo agregar el ejercicio: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

// Crea un ejercicio nuevo en el catálogo y lo agrega a la sesión de una.
async function crearEjercicio(nombre, grupo) {
  if (S.mutando) return;
  const nom = String(nombre || '').trim();
  if (!nom) { toast('Poné un nombre para el ejercicio', 'warning'); return; }
  S.mutando = true;
  try {
    const fila = {
      user_id: S.userId, nombre: nom,
      grupo: grupo || null, unidad: unidadDefault(),
    };
    const { data, error } = await supabase.from('training_ejercicios').insert(fila).select().single();
    if (error) throw error;
    S.ejercicios.push(data);
    S.ejercicios.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    S.mutando = false;
    // Agregarlo a la sesión (reusa su propio guard).
    await agregarEjercicioASesion(data.id);
    return;
  } catch (err) {
    toast('No se pudo crear el ejercicio: ' + msgErr(err), 'error');
    S.mutando = false;
  }
}

async function borrarEjercicioDeSesion(ejId) {
  const nombre = ejercicioNombre(ejId);
  const ok = await confirmDialog({
    title: 'Quitar ejercicio',
    message: '¿Sacás "' + nombre + '" de esta sesión? Se borran sus series de hoy.',
    confirmText: 'Quitar',
    danger: true,
  });
  if (!ok) return;
  if (S.mutando) return;
  const ids = S.sets.filter(s => s.ejercicio_id === ejId).map(s => s.id);
  if (!ids.length) return;
  S.mutando = true;
  try {
    const { error } = await supabase.from('training_sets').delete()
      .in('id', ids).eq('user_id', S.userId);
    if (error) throw error;
    S.sets = S.sets.filter(s => s.ejercicio_id !== ejId);
    delete S.previos[ejId];
    delete S.prPorEj[ejId];
    recomputarPRsSesion();
    toast('Ejercicio quitado', 'success');
    paint();
  } catch (err) {
    toast('No se pudo quitar el ejercicio: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

/* ============================================================
   Mutaciones — Sets
   ============================================================ */
// Agrega un set al ejercicio, pre-llenando peso/reps del último set del mismo.
async function agregarSet(ejId) {
  if (S.mutando) return;
  const delEj = S.sets.filter(s => s.ejercicio_id === ejId)
    .sort((a, b) => (Number(a.set_num) || 0) - (Number(b.set_num) || 0));
  if (!delEj.length) return; // el ejercicio siempre tiene al menos 1 set
  const ultimo = delEj[delEj.length - 1];
  const fecha = S.fecha;
  S.mutando = true;
  try {
    const fila = {
      user_id: S.userId, sesion_id: ultimo.sesion_id, ejercicio_id: ejId,
      orden: Number(ultimo.orden) || 0,
      set_num: (Number(ultimo.set_num) || delEj.length) + 1,
      peso: Number(ultimo.peso) || 0,
      reps: Number(ultimo.reps) || 0,
      rpe: ultimo.rpe != null ? ultimo.rpe : null,
      completado: true,
    };
    const { data, error } = await supabase.from('training_sets').insert(fila).select().single();
    if (error) throw error;
    if (S.fecha === fecha) {
      S.sets.push(data);
      recomputarPRsSesion(); // el nuevo set puede ser récord (o dejar de serlo otro)
    }
    paint();
    // Arrancó una serie nueva → dispara el descanso (solo en el día de hoy).
    if (S.fecha === hoyStr()) iniciarTimer(descansoSegDefault());
  } catch (err) {
    toast('No se pudo agregar la serie: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function borrarSet(setId) {
  const set = S.sets.find(s => s.id === setId);
  if (!set) return;
  const delEj = S.sets.filter(s => s.ejercicio_id === set.ejercicio_id);
  // Si es el único set del ejercicio, quitar el ejercicio entero (con confirm).
  if (delEj.length <= 1) { return borrarEjercicioDeSesion(set.ejercicio_id); }
  if (S.mutando) return;
  S.mutando = true;
  try {
    // Cancelar cualquier guardado inline pendiente de este set.
    if (guardadoInline.has(setId)) { clearTimeout(guardadoInline.get(setId)); guardadoInline.delete(setId); }
    const { error } = await supabase.from('training_sets').delete()
      .eq('id', setId).eq('user_id', S.userId);
    if (error) throw error;
    S.sets = S.sets.filter(s => s.id !== setId);
    recomputarPRsSesion();
    paint();
  } catch (err) {
    toast('No se pudo borrar la serie: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

// Edición inline: actualiza el estado local al instante (sin repintar todo, el
// input ya tiene el valor) y persiste con debounce → no un UPDATE por tecla.
function editarSetLocal(setId, campo, valorRaw) {
  const set = S.sets.find(s => s.id === setId);
  if (!set) return;
  let valor;
  if (campo === 'reps') valor = Math.max(0, Math.round(Number(String(valorRaw).replace(',', '.')) || 0));
  else if (campo === 'rpe') {
    const v = String(valorRaw).trim();
    valor = v === '' ? null : Math.min(10, Math.max(0, Number(v.replace(',', '.')) || 0));
  } else valor = Math.max(0, Number(String(valorRaw).replace(',', '.')) || 0); // peso
  set[campo] = valor;
  // Actualizar el volumen del header sin repintar los inputs (no perder el foco).
  actualizarVolumenVivo();
  // Re-evaluar PRs en vivo y reflejar el badge sin tocar los inputs.
  recomputarPRsSesion();
  actualizarBadgesPR();
  programarGuardadoSet(setId, campo, valor);
}

function programarGuardadoSet(setId, campo, valor) {
  if (guardadoInline.has(setId)) clearTimeout(guardadoInline.get(setId));
  const h = setTimeout(() => {
    guardadoInline.delete(setId);
    persistirSet(setId, { [campo]: valor });
  }, DEBOUNCE_MS);
  guardadoInline.set(setId, h);
}

async function persistirSet(setId, patch) {
  persistsEnVuelo++;
  try {
    const { error } = await supabase.from('training_sets')
      .update(patch).eq('id', setId).eq('user_id', S.userId);
    if (error) throw error;
  } catch (err) {
    toast('No se pudo guardar la serie: ' + msgErr(err), 'error');
  } finally {
    persistsEnVuelo--;
  }
}

// Refresca solo los números de volumen visibles (header de sesión y de cada
// ejercicio) sin tocar los inputs → la edición inline no pierde el foco.
function actualizarVolumenVivo() {
  const totalEl = document.getElementById('traVolTotal');
  if (totalEl) totalEl.textContent = num0(volumen(S.sets));
  for (const g of ejerciciosDeSesion()) {
    const el = document.getElementById('traVolEj-' + g.ejId);
    if (el) el.textContent = num0(volumen(g.sets));
  }
}

// Sincroniza los badges "PR 🔥" de cada fila con el estado S.setsPR, sin
// repintar (no perder el foco del input). Dispara el destello solo cuando una
// fila PASA a ser récord (no en cada tecla).
function actualizarBadgesPR() {
  for (const s of S.sets) {
    const fila = document.getElementById('traSet-' + s.id);
    if (!fila) continue;
    const badge = fila.querySelector('.tra-pr-badge');
    const esPR = !!prDeSet(s.id);
    if (esPR && !badge) {
      const b = document.createElement('span');
      b.className = 'tra-pr-badge';
      b.title = 'Nuevo récord';
      b.innerHTML = 'PR&nbsp;🔥';
      // Insertar antes del botón de borrar para respetar la grilla.
      const del = fila.querySelector('.tra-set-del');
      fila.insertBefore(b, del);
      fila.classList.remove('tra-pr-flash'); void fila.offsetWidth; // reflow → reinicia anim
      fila.classList.add('tra-pr-flash');
    } else if (!esPR && badge) {
      badge.remove();
      fila.classList.remove('tra-pr-flash');
    }
  }
}

/* ============================================================
   Timer de descanso (flotante) — anillo SVG que se vacía, rAF client-side.
   No toca la DB. Vive en <body> para sobrevivir a los repaint del módulo.
   ============================================================ */
const R_TIMER = 26;                    // radio del anillo (coincide con motion.css)
const C_TIMER = 2 * Math.PI * R_TIMER; // circunferencia (para dasharray)

function construirTimer() {
  if (TIMER.el && document.body.contains(TIMER.el)) return;
  const el = document.createElement('div');
  el.className = 'tra-timer';
  el.setAttribute('role', 'timer');
  el.setAttribute('aria-live', 'off');
  el.innerHTML = `
    <div class="tra-timer-ring">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="v-ring-track" cx="32" cy="32" r="${R_TIMER}" style="stroke-width:5"></circle>
        <circle class="tra-timer-fill" cx="32" cy="32" r="${R_TIMER}" style="stroke-width:5"></circle>
      </svg>
      <span class="tra-timer-num tra-num">0:00</span>
    </div>
    <div class="tra-timer-body">
      <span class="tra-timer-cap">Descanso</span>
      <div class="tra-timer-ctrl">
        <button type="button" class="tra-timer-btn" data-timer="menos" aria-label="Restar 15 segundos">−15</button>
        <button type="button" class="tra-timer-btn" data-timer="mas" aria-label="Sumar 15 segundos">+15</button>
        <button type="button" class="tra-timer-btn tra-timer-x" data-timer="cerrar" aria-label="Cerrar timer">✕</button>
      </div>
    </div>`;
  // Handlers directos (este nodo no está bajo la delegación del container).
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-timer]');
    if (!b) return;
    if (b.dataset.timer === 'menos') ajustarTimer(-15000);
    else if (b.dataset.timer === 'mas') ajustarTimer(15000);
    else if (b.dataset.timer === 'cerrar') detenerTimer();
  });
  document.body.appendChild(el);
  TIMER.el = el;
  TIMER.ringFill = el.querySelector('.tra-timer-fill');
  TIMER.numEl = el.querySelector('.tra-timer-num');
  TIMER.ringFill.style.strokeDasharray = C_TIMER.toFixed(2);
}

function fmtSeg(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Arranca (o reinicia) la cuenta con `seg` segundos. Se llama al agregar/tener
// un set nuevo. reduced-motion: igual cuenta, sin transición del anillo.
function iniciarTimer(seg) {
  if (!S.container || !S.container.isConnected) return;
  const durMs = Math.max(1000, (Number(seg) || descansoSegDefault()) * 1000);
  construirTimer();
  TIMER.durMs = durMs;
  TIMER.finAt = performance.now() + durMs;
  TIMER.warned = false;
  TIMER.activo = true;
  TIMER.el.classList.add('activo');
  TIMER.el.classList.remove('tra-timer-warn', 'tra-timer-fin');
  cancelAnimationFrame(TIMER.raf);
  tickTimer();
}

function ajustarTimer(deltaMs) {
  if (!TIMER.activo) return;
  TIMER.finAt += deltaMs;
  TIMER.durMs = Math.max(1000, TIMER.durMs + deltaMs);
  const rest = TIMER.finAt - performance.now();
  if (rest <= 0) { finTimer(); return; }
  if (rest > TIMER_WARN_MS) { TIMER.warned = false; TIMER.el.classList.remove('tra-timer-warn'); }
}

function tickTimer() {
  if (!TIMER.activo) return;
  const now = performance.now();
  const rest = TIMER.finAt - now;
  // Fracción restante (1 → lleno, 0 → vacío): el anillo se VACÍA con el tiempo.
  const frac = Math.max(0, Math.min(1, rest / TIMER.durMs));
  TIMER.ringFill.style.strokeDashoffset = (C_TIMER * (1 - frac)).toFixed(2);
  TIMER.numEl.textContent = fmtSeg(rest);
  if (rest <= TIMER_WARN_MS && !TIMER.warned) {
    TIMER.warned = true;
    TIMER.el.classList.add('tra-timer-warn');
  }
  if (rest <= 0) { finTimer(); return; }
  TIMER.raf = requestAnimationFrame(tickTimer);
}

function finTimer() {
  cancelAnimationFrame(TIMER.raf);
  TIMER.raf = 0;
  if (!TIMER.el) return;
  TIMER.ringFill.style.strokeDashoffset = C_TIMER.toFixed(2); // vacío
  TIMER.numEl.textContent = '0:00';
  TIMER.el.classList.add('tra-timer-fin');
  TIMER.el.classList.remove('tra-timer-warn');
  // Auto-oculta un rato después de terminar (deja ver el "¡Dale!" un momento).
  setTimeout(() => { if (TIMER.el && TIMER.el.classList.contains('tra-timer-fin')) detenerTimer(); }, 4000);
  TIMER.activo = false;
}

function detenerTimer() {
  cancelAnimationFrame(TIMER.raf);
  TIMER.raf = 0;
  TIMER.activo = false;
  if (TIMER.el) TIMER.el.classList.remove('activo', 'tra-timer-warn', 'tra-timer-fin');
}

// Baja el timer al salir del módulo (render de otra ruta o desmontaje).
function limpiarTimer() { detenerTimer(); }

/* ============================================================
   Navegación
   ============================================================ */
async function cambiarDia(fecha) {
  S.fecha = fecha;
  S.ejPicker = null;
  S.busca = '';
  S.cargando = true;
  paint();
  try {
    if (!(await cargarSesion())) return; // llegó tarde: otra navegación se hizo cargo
  } catch (err) {
    if (S.fecha !== fecha) return;
    S.sesion = null; S.sets = []; S.previos = {}; // nunca dejar otra sesión bajo este label
    toast('No se pudo cargar el día: ' + msgErr(err), 'error');
  }
  S.cargando = false;
  paint();
}

async function cargarHistorialLazy() {
  S.cargandoHist = true;
  paint();
  try {
    await cargarHistorial();
    S.historialCargado = true;
  } catch (err) {
    toast('No se pudo cargar el historial: ' + msgErr(err), 'error');
  }
  S.cargandoHist = false;
  paint();
}

async function cargarVolumenLazy() {
  S.volGrupoCargando = true;
  paint();
  try {
    S.volGrupo = await cargarVolumenPorGrupo(7);
    S.volGrupoCargado = true;
  } catch (err) {
    S.volGrupo = [];
    toast('No se pudo cargar el volumen por grupo: ' + msgErr(err), 'error');
  }
  S.volGrupoCargando = false;
  paint();
}

async function seleccionarProgreso(ejId) {
  S.progresoEjId = ejId;
  S.progresoData = null;
  if (!ejId) { paint(); return; }
  S.progresoCargando = true;
  paint();
  try {
    const puntos = await cargarProgreso(ejId);
    if (S.progresoEjId !== ejId) return; // cambió la selección
    S.progresoData = { ejId, puntos };
  } catch (err) {
    if (S.progresoEjId !== ejId) return;
    S.progresoData = { ejId, puntos: [] };
    toast('No se pudo cargar el progreso: ' + msgErr(err), 'error');
  }
  S.progresoCargando = false;
  paint();
}

/* ============================================================
   Eventos — delegación en el container (se bindea UNA vez)
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) {
    S.boundEl.removeEventListener('click', onClick);
    S.boundEl.removeEventListener('submit', onSubmit);
    S.boundEl.removeEventListener('input', onInput);
    S.boundEl.removeEventListener('change', onChange);
  }
  S.container.addEventListener('click', onClick);
  S.container.addEventListener('submit', onSubmit);
  S.container.addEventListener('input', onInput);
  S.container.addEventListener('change', onChange);
  document.addEventListener('keydown', onEscape);
  S.boundEl = S.container;
  bindRouteWatch();
}

// El timer de descanso vive en <body> (sobrevive a los repaint); hay que bajarlo
// al salir del módulo. El router emite 'vida:route' en cada navegación → si el
// destino no es training, se detiene. Se ata UNA sola vez (global).
let routeWatchBound = false;
function bindRouteWatch() {
  if (routeWatchBound) return;
  routeWatchBound = true;
  window.addEventListener('vida:route', (e) => {
    const id = e && e.detail ? e.detail.id : null;
    if (id !== 'training') limpiarTimer();
  });
}

function onEscape(e) {
  if (e.key !== 'Escape') return;
  if (!S.container || !S.container.isConnected) return;
  if (S.ejPicker) { S.ejPicker = null; S.busca = ''; paint(); }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.tra')) return;
  const a = el.dataset.action;

  if (a === 'tab') {
    S.tab = el.dataset.tab;
    S.ejPicker = null; S.busca = '';
    if (S.tab === 'historial' && !S.historialCargado && !S.cargandoHist) cargarHistorialLazy();
    if (S.tab === 'progreso' && !S.volGrupoCargado && !S.volGrupoCargando) cargarVolumenLazy();
    paint();
    return;
  }

  if (a === 'dia-prev') { cambiarDia(addDias(S.fecha, -1)); return; }
  if (a === 'dia-next') { cambiarDia(addDias(S.fecha, 1)); return; }
  if (a === 'dia-hoy') { cambiarDia(hoyStr()); return; }

  if (a === 'empezar') { empezarSesion(); return; }
  if (a === 'del-sesion') { borrarSesion(el.dataset.id); return; }

  if (a === 'add-set') { agregarSet(el.dataset.ej); return; }
  if (a === 'del-set') { borrarSet(el.dataset.id); return; }
  if (a === 'del-ejercicio') { borrarEjercicioDeSesion(el.dataset.ej); return; }

  if (a === 'abrir-ejpicker') { S.ejPicker = { crear: false }; S.busca = ''; paint(); return; }
  if (a === 'ejpicker-cerrar') { S.ejPicker = null; S.busca = ''; paint(); return; }
  if (a === 'ejpicker-fondo') { if (e.target === el) { S.ejPicker = null; S.busca = ''; paint(); } return; }
  if (a === 'ejpicker-crear') { if (S.ejPicker) { S.ejPicker.crear = true; paint(); } return; }
  if (a === 'ejpicker-volver') { if (S.ejPicker) { S.ejPicker.crear = false; paint(); } return; }
  if (a === 'pick-ejercicio') { agregarEjercicioASesion(el.dataset.id); return; }

  if (a === 'hist-toggle') {
    const id = el.dataset.id;
    S.expandidas[id] = !S.expandidas[id];
    paint();
    return;
  }

  if (a === 'prog-ir-sesion') { S.tab = 'sesion'; paint(); return; }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form || !form.closest('.tra')) return;
  const a = form.dataset.action;
  if (a === 'crear-ejercicio') {
    e.preventDefault();
    const fd = new FormData(form);
    crearEjercicio(String(fd.get('nombre') || ''), String(fd.get('grupo') || '') || null);
    return;
  }
}

function onInput(e) {
  // Buscador del picker de ejercicios (no repinta todo → no pierde foco).
  const busc = e.target.closest('input[data-action="ej-buscar"]');
  if (busc && busc.closest('.tra')) {
    S.busca = busc.value;
    const lista = document.getElementById('traEjLista');
    if (lista) lista.innerHTML = listaEjerciciosHTML();
    return;
  }
  // Edición inline de un set (peso / reps / rpe).
  const inp = e.target.closest('input[data-set]');
  if (inp && inp.closest('.tra')) {
    editarSetLocal(inp.dataset.set, inp.dataset.campo, inp.value);
    return;
  }
}

function onChange(e) {
  // Nombre de la sesión: persiste al perder foco / cambiar (no por tecla).
  const nom = e.target.closest('input[data-action="nombre-sesion"]');
  if (nom && nom.closest('.tra')) { guardarNombreSesion(nom.value); return; }
  // Selector de ejercicio en Progreso.
  const sel = e.target.closest('select[data-action="prog-ejercicio"]');
  if (sel && sel.closest('.tra')) { seleccionarProgreso(sel.value); return; }
}

/* ============================================================
   Vistas — el DOM del módulo se reconstruye entero en cada paint()
   ============================================================ */
function paint() {
  if (!S.container) return;
  const tabs = [['sesion', 'Sesión'], ['historial', 'Historial'], ['progreso', 'Progreso']];
  let vista;
  if (S.tab === 'historial') vista = vistaHistorial();
  else if (S.tab === 'progreso') vista = vistaProgreso();
  else vista = vistaSesion();
  S.container.innerHTML = `
  <div class="tra">
    <header class="tra-head rise">
      <div class="tra-head-fila">
        <div class="tra-head-titulo">
          <span class="tra-head-ic" aria-hidden="true">🏋️</span>
          <h2 class="tra-titulo">Training</h2>
        </div>
      </div>
      <nav class="tra-tabs" role="tablist">
        ${tabs.map(([id, lbl]) => `
        <button class="tra-tab${S.tab === id ? ' activa' : ''}" role="tab"
          aria-selected="${S.tab === id}" data-action="tab" data-tab="${id}">${lbl}</button>`).join('')}
      </nav>
    </header>
    <div class="tra-cuerpo">${vista}</div>
    ${S.ejPicker ? modalEjercicios() : ''}
  </div>`;
  animarPaint();
}

// Dispara las animaciones del rediseño sobre el DOM recién pintado: entrada
// escalonada (.rise), anillos (.v-ring-fill), count-up (data-count), barras de
// volumen (data-bar) y tilt magnético. Igual patrón que home.renderCockpit().
function animarPaint() {
  const c = S.container;
  if (!c) return;
  c.querySelectorAll('.v-ring-fill').forEach(el => ring(el, +el.getAttribute('data-pct') || 0));
  c.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    countUp(el, to, { suffix: el.getAttribute('data-suffix') || '', decimals: +el.getAttribute('data-dec') || 0 });
  });
  // Barras de volumen: crecen desde 0 a su ancho objetivo tras montar.
  const barras = c.querySelectorAll('[data-bar]');
  if (barras.length) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      barras.forEach(el => { el.style.width = (el.getAttribute('data-bar') || 0) + '%'; });
    }));
  }
  stagger(c.querySelectorAll('.rise'));
  tiltAll(c);
}

function vacioConfig() {
  return `
  <div class="tra-vacio">
    <div class="tra-vacio-icono">⚙️</div>
    <p>Todavía no hay grupos musculares configurados.</p>
    <p class="tra-vacio-sub">Corré el seed (sql/06_training.sql) para cargar los grupos, las unidades y los ejercicios base del módulo.</p>
  </div>`;
}

/* ---------- Tab SESIÓN ---------- */
function navFecha() {
  const esHoy = S.fecha === hoyStr();
  return `
  <div class="tra-fechanav">
    <button class="tra-nav-btn" data-action="dia-prev" aria-label="Día anterior">‹</button>
    <div class="tra-fechanav-centro">
      <div class="tra-fechanav-label">${esc(labelFecha(S.fecha))}</div>
      ${esHoy ? '' : `<button class="tra-chip" data-action="dia-hoy">Volver a hoy</button>`}
    </div>
    <button class="tra-nav-btn" data-action="dia-next" aria-label="Día siguiente">›</button>
  </div>`;
}

function vistaSesion() {
  const nav = navFecha();
  if (!configLista()) return nav + vacioConfig();
  if (S.cargando) return nav + `<div class="tra-cargando">Cargando la sesión…</div>`;
  if (!S.sesion) {
    return nav + `
    <div class="tra-vacio rise">
      <div class="tra-vacio-icono">🏋️</div>
      <p>No hay sesión para ${S.fecha === hoyStr() ? 'hoy' : 'este día'}.</p>
      <p class="tra-vacio-sub">Arrancá una sesión y anotá tus series a medida que entrenás.</p>
      <button class="tra-btn-primario" data-action="empezar"${S.mutando ? ' disabled' : ''}>Empezar sesión</button>
    </div>`;
  }
  const grupos = ejerciciosDeSesion();
  const r = resumenSesion(S.sets);
  const cuerpo = grupos.length
    ? grupos.map(bloqueEjercicio).join('')
    : `<div class="tra-slot-vacio rise">Sesión vacía. Agregá el primer ejercicio 👇</div>`;
  return nav + `
  <div class="tra-card tra-sesion-head rise lively" data-tilt>
    <input class="tra-nombre-input" data-action="nombre-sesion" type="text"
      placeholder="Nombre de la sesión (opcional)" maxlength="80"
      value="${esc(S.sesion.nombre || '')}" aria-label="Nombre de la sesión" autocomplete="off">
    <div class="tra-sesion-stats">
      <div class="tra-stat">
        <span class="tra-stat-v"><span class="tra-num" data-count="${r.nEjercicios}">0</span></span>
        <span class="tra-stat-k">${r.nEjercicios === 1 ? 'ejerc.' : 'ejercs.'}</span>
      </div>
      <div class="tra-stat">
        <span class="tra-stat-v"><span class="tra-num" data-count="${r.nSets}">0</span></span>
        <span class="tra-stat-k">${r.nSets === 1 ? 'serie' : 'series'}</span>
      </div>
      <div class="tra-stat tra-stat-vol">
        <span class="tra-stat-v"><span class="tra-num" id="traVolTotal" data-count="${Math.round(r.volumen)}">0</span></span>
        <span class="tra-stat-k">vol · ${esc(unidadVolumen())}</span>
      </div>
    </div>
  </div>
  ${cuerpo}
  <button class="tra-add-ejercicio rise" data-action="abrir-ejpicker">+ Ejercicio</button>`;
}

// Unidad "genérica" para el volumen (usa la unidad más común de la sesión, o
// la default de config). Es descriptiva; el volumen mezcla ejercicios.
function unidadVolumen() {
  const us = S.sets.map(s => ejercicioUnidad(s.ejercicio_id)).filter(Boolean);
  if (!us.length) return unidadDefault();
  const conteo = new Map();
  for (const u of us) conteo.set(u, (conteo.get(u) || 0) + 1);
  return [...conteo.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function bloqueEjercicio(g) {
  const unidad = ejercicioUnidad(g.ejId);
  const prev = S.previos[g.ejId];
  const vol = volumen(g.sets);
  const hayPR = g.sets.some(s => prDeSet(s.id));
  const referencia = prev && prev.sets.length
    ? `<div class="tra-previo" title="Última sesión con este ejercicio">↩ ${esc(labelCorto(prev.fecha))}: ${prev.sets.map(s => `${num(s.peso)}×${num0(s.reps)}`).join(' · ')}</div>`
    : `<div class="tra-previo tra-previo-vacio">Sin registro previo</div>`;
  return `
  <section class="tra-card tra-ejercicio rise lively" data-tilt>
    <header class="tra-ej-head">
      <div class="tra-ej-info">
        <h3 class="tra-ej-nombre">${esc(ejercicioNombre(g.ejId))}${hayPR ? ' <span class="tra-pr-chip" title="Récord en esta sesión">PR&nbsp;🔥</span>' : ''}</h3>
        <div class="tra-ej-meta">${labelGrupo(grupoDe(g.ejId)) ? esc(labelGrupo(grupoDe(g.ejId))) + ' · ' : ''}<span class="tra-num" id="traVolEj-${esc(g.ejId)}">${num0(vol)}</span> ${esc(unidad)} vol</div>
      </div>
      <button class="tra-icono tra-borrar" data-action="del-ejercicio" data-ej="${esc(g.ejId)}" aria-label="Quitar ejercicio" title="Quitar ejercicio">✕</button>
    </header>
    ${referencia}
    <div class="tra-sets">
      <div class="tra-set-header">
        <span class="tra-set-col-num">#</span>
        <span class="tra-set-col">${esc(unidad)}</span>
        <span class="tra-set-col">reps</span>
        <span class="tra-set-col tra-set-col-rpe">RPE</span>
        <span class="tra-set-col-del"></span>
      </div>
      ${g.sets.map((s, i) => filaSet(s, i + 1)).join('')}
    </div>
    <button class="tra-add-set" data-action="add-set" data-ej="${esc(g.ejId)}"${S.mutando ? ' disabled' : ''}>+ Set</button>
  </section>`;
}

function grupoDe(ejId) {
  const e = S.ejercicios.find(x => x.id === ejId);
  return e ? e.grupo : null;
}

function filaSet(s, nSet) {
  const pr = prDeSet(s.id);
  return `
  <div class="tra-set${pr ? ' tra-set-pr' : ''}" id="traSet-${esc(s.id)}">
    <span class="tra-set-num tra-num">${nSet}</span>
    <input class="tra-set-input tra-num" data-set="${esc(s.id)}" data-campo="peso" type="number"
      inputmode="decimal" step="0.5" min="0" value="${esc(s.peso != null ? s.peso : '')}" aria-label="Peso" placeholder="0">
    <input class="tra-set-input tra-num" data-set="${esc(s.id)}" data-campo="reps" type="number"
      inputmode="numeric" step="1" min="0" value="${esc(s.reps != null ? s.reps : '')}" aria-label="Repeticiones" placeholder="0">
    <input class="tra-set-input tra-set-input-rpe tra-num" data-set="${esc(s.id)}" data-campo="rpe" type="number"
      inputmode="decimal" step="0.5" min="0" max="10" value="${esc(s.rpe != null ? s.rpe : '')}" aria-label="RPE" placeholder="—">
    ${pr ? `<span class="tra-pr-badge" title="${pr.peso && pr.e1rm ? 'Récord de peso y 1RM' : (pr.peso ? 'Récord de peso' : 'Récord de 1RM')}">PR&nbsp;🔥</span>` : ''}
    <button class="tra-icono tra-set-del" data-action="del-set" data-id="${esc(s.id)}" aria-label="Borrar serie" title="Borrar serie">✕</button>
  </div>`;
}

/* ---------- Modal picker de ejercicios ---------- */
function modalEjercicios() {
  const crear = S.ejPicker.crear;
  return `
  <div class="tra-modal" data-action="ejpicker-fondo">
    <div class="tra-modal-card tra-glass" role="dialog" aria-modal="true" aria-label="Agregar ejercicio">
      <header class="tra-modal-head">
        <h3 class="tra-modal-titulo">${crear ? 'Nuevo ejercicio' : 'Agregar ejercicio'}</h3>
        <button class="tra-icono" data-action="ejpicker-cerrar" aria-label="Cerrar">✕</button>
      </header>
      ${crear ? formCrearEjercicio() : pickerEjercicios()}
    </div>
  </div>`;
}

function pickerEjercicios() {
  return `
  <input class="tra-input tra-buscador" data-action="ej-buscar" placeholder="Buscar ejercicio…"
    value="${esc(S.busca)}" autocomplete="off" aria-label="Buscar ejercicio">
  <div class="tra-ej-lista" id="traEjLista">${listaEjerciciosHTML()}</div>
  <button class="tra-btn-sec tra-crear-btn" data-action="ejpicker-crear">+ Crear ejercicio nuevo</button>`;
}

function listaEjerciciosHTML() {
  const items = ejerciciosFiltrados();
  const enSesion = new Set(S.sets.map(s => s.ejercicio_id));
  if (!items.length) {
    return `<div class="tra-picker-vacio">${S.ejercicios.length
      ? 'No encontré ningún ejercicio con esa búsqueda.'
      : 'No hay ejercicios cargados. Corré el seed (sql/06_training.sql) o creá uno nuevo.'}</div>`;
  }
  return items.map(e => {
    const ya = enSesion.has(e.id);
    // Un ejercicio ya presente no se re-agrega (duplicaría bloques de sets y
    // rompería la numeración de series): botón deshabilitado, sin data-action.
    return `
  <button class="tra-ej-op${ya ? ' tra-ej-op-ya' : ''}"${ya ? '' : ` data-action="pick-ejercicio" data-id="${esc(e.id)}"`}${(S.mutando || ya) ? ' disabled' : ''}>
    <span class="tra-ej-op-info">
      <span class="tra-ej-op-nombre">${esc(e.nombre)}</span>
      ${e.grupo ? `<span class="tra-ej-op-grupo">${esc(labelGrupo(e.grupo))}</span>` : ''}
    </span>
    ${ya ? `<span class="tra-badge tra-ej-op-en">en sesión</span>` : `<span class="tra-ej-op-mas">+</span>`}
  </button>`;
  }).join('');
}

function formCrearEjercicio() {
  const grupos = cfgGrupos();
  return `
  <form class="tra-modal-form" data-action="crear-ejercicio" autocomplete="off">
    <label class="tra-field">
      <span class="tra-campo-label">Nombre</span>
      <input class="tra-input" name="nombre" type="text" placeholder="Ej: Press inclinado" required maxlength="80" autofocus>
    </label>
    <label class="tra-field">
      <span class="tra-campo-label">Grupo</span>
      <select class="tra-input" name="grupo" aria-label="Grupo muscular">
        <option value="">Sin grupo</option>
        ${grupos.map(g => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('')}
      </select>
    </label>
    <div class="tra-modal-acciones">
      <button type="button" class="tra-btn-sec" data-action="ejpicker-volver">‹ Volver</button>
      <button type="submit" class="tra-btn-primario"${S.mutando ? ' disabled' : ''}>Crear y agregar</button>
    </div>
  </form>`;
}

/* ---------- Tab HISTORIAL ---------- */
function vistaHistorial() {
  if (!configLista()) return vacioConfig();
  if (S.cargandoHist) return `<div class="tra-cargando">Cargando el historial…</div>`;
  if (!S.historial.length) {
    return `
    <div class="tra-vacio">
      <div class="tra-vacio-icono">📚</div>
      <p>Todavía no hay sesiones registradas.</p>
      <p class="tra-vacio-sub">Registrá tu primera sesión en la pestaña Sesión y acá vas a ver el historial completo.</p>
    </div>`;
  }
  return `<div class="tra-hist">${S.historial.map(cardHistorial).join('')}</div>`;
}

function cardHistorial(item) {
  const ses = item.sesion;
  const fecha = String(ses.fecha).slice(0, 10);
  const r = resumenSesion(item.sets);
  const abierta = !!S.expandidas[ses.id];
  return `
  <section class="tra-card tra-hist-item rise lively"${abierta ? '' : ' data-tilt'}>
    <header class="tra-hist-head" data-action="hist-toggle" data-id="${esc(ses.id)}" role="button" tabindex="0">
      <div class="tra-hist-info">
        <div class="tra-hist-fecha">${esc(labelLargo(fecha))}${ses.nombre ? ` · <span class="tra-hist-nombre">${esc(ses.nombre)}</span>` : ''}</div>
        <div class="tra-hist-resumen">${r.nEjercicios} ${r.nEjercicios === 1 ? 'ejercicio' : 'ejercicios'} · ${r.nSets} ${r.nSets === 1 ? 'serie' : 'series'} · vol <span class="tra-num">${num0(r.volumen)}</span></div>
      </div>
      <span class="tra-hist-flecha${abierta ? ' abierta' : ''}" aria-hidden="true">▾</span>
    </header>
    ${abierta ? detalleHistorial(item) : ''}
  </section>`;
}

function detalleHistorial(item) {
  const grupos = new Map();
  for (const s of item.sets) {
    if (!grupos.has(s.ejercicio_id)) grupos.set(s.ejercicio_id, { ejId: s.ejercicio_id, orden: Number(s.orden) || 0, sets: [] });
    grupos.get(s.ejercicio_id).sets.push(s);
  }
  const arr = [...grupos.values()].sort((a, b) => a.orden - b.orden);
  for (const g of arr) g.sets.sort((a, b) => (Number(a.set_num) || 0) - (Number(b.set_num) || 0));
  const bloques = arr.length
    ? arr.map(g => `
      <div class="tra-hist-ej">
        <div class="tra-hist-ej-nombre">${esc(ejercicioNombre(g.ejId))}</div>
        <div class="tra-hist-ej-sets">${g.sets.map(s =>
          `<span class="tra-hist-set tra-num">${num(s.peso)}×${num0(s.reps)}${s.rpe != null ? ` <span class="tra-hist-rpe">@${num(s.rpe)}</span>` : ''}</span>`
        ).join('')}</div>
      </div>`).join('')
    : `<div class="tra-slot-vacio">Sesión sin series registradas.</div>`;
  return `
  <div class="tra-hist-detalle">
    ${bloques}
    <button class="tra-btn-ghost tra-hist-borrar" data-action="del-sesion" data-id="${esc(item.sesion.id)}">Borrar sesión</button>
  </div>`;
}

/* ---------- Tab PROGRESO ---------- */
function vistaProgreso() {
  if (!configLista()) return vacioConfig();
  const ejs = [...S.ejercicios].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  const volPanel = panelVolumenGrupo();
  const selector = `
  <div class="tra-card tra-prog-selector rise">
    <label class="tra-field">
      <span class="tra-campo-label">Evolución por ejercicio</span>
      <select class="tra-input" data-action="prog-ejercicio" aria-label="Elegí un ejercicio">
        <option value="">Elegí un ejercicio…</option>
        ${ejs.map(e => `<option value="${esc(e.id)}"${S.progresoEjId === e.id ? ' selected' : ''}>${esc(e.nombre)}</option>`).join('')}
      </select>
    </label>
  </div>`;
  if (!ejs.length) {
    return volPanel + `
    <div class="tra-vacio rise">
      <div class="tra-vacio-icono">📈</div>
      <p>No hay ejercicios para graficar.</p>
      <p class="tra-vacio-sub">Corré el seed (sql/06_training.sql) o creá ejercicios desde la pestaña Sesión.</p>
    </div>`;
  }
  if (!S.progresoEjId) {
    return volPanel + selector + `
    <div class="tra-vacio rise">
      <div class="tra-vacio-icono">📈</div>
      <p>Elegí un ejercicio para ver su evolución.</p>
      <p class="tra-vacio-sub">Vas a ver la carga a lo largo del tiempo, el récord estimado y la última vs. la anterior.</p>
    </div>`;
  }
  if (S.progresoCargando) return volPanel + selector + `<div class="tra-cargando">Cargando el progreso…</div>`;
  const puntos = (S.progresoData && S.progresoData.ejId === S.progresoEjId) ? S.progresoData.puntos : [];
  if (!puntos.length) {
    return volPanel + selector + `
    <div class="tra-vacio rise">
      <div class="tra-vacio-icono">📉</div>
      <p>Sin registros para este ejercicio todavía.</p>
      <p class="tra-vacio-sub">Registrá algunas series en Sesión y volvé para ver la evolución.</p>
      <button class="tra-btn-sec" data-action="prog-ir-sesion">Ir a Sesión</button>
    </div>`;
  }
  return volPanel + selector + bloqueProgreso(puntos);
}

// Mini-panel: volumen semanal por grupo muscular (Σ peso×reps de los últimos 7
// días). Barras horizontales que animan al montar (data-bar → ancho objetivo).
function panelVolumenGrupo() {
  if (S.volGrupoCargando) {
    return `<div class="tra-card tra-volpanel rise">
      <div class="tra-volpanel-head"><span class="tra-volpanel-titulo">Volumen por músculo</span><span class="tra-volpanel-sub">últimos 7 días</span></div>
      <div class="tra-cargando">Cargando volumen…</div></div>`;
  }
  const datos = Array.isArray(S.volGrupo) ? S.volGrupo.filter(d => d.vol > 0) : [];
  if (!S.volGrupoCargado) {
    // Aún no se disparó la carga (defensivo): panel vacío discreto.
    return '';
  }
  if (!datos.length) {
    return `<div class="tra-card tra-volpanel rise">
      <div class="tra-volpanel-head"><span class="tra-volpanel-titulo">Volumen por músculo</span><span class="tra-volpanel-sub">últimos 7 días</span></div>
      <div class="tra-slot-vacio">Sin series en los últimos 7 días. Entrená y volvé para ver el reparto por grupo.</div></div>`;
  }
  const maxVol = Math.max(...datos.map(d => d.vol)) || 1;
  const total = datos.reduce((a, d) => a + d.vol, 0);
  const unidad = unidadVolumen();
  // Color alternado accent / accent-2 por orden (mismo criterio "vivo" del Home).
  const filas = datos.map((d, i) => {
    const pct = Math.max(3, Math.round(d.vol / maxVol * 100)); // piso 3% para que se vea la barra
    const col = i % 2 === 0 ? 'var(--accent)' : 'var(--accent-2)';
    const share = total > 0 ? Math.round(d.vol / total * 100) : 0;
    return `
    <div class="tra-volrow">
      <div class="tra-volrow-top">
        <span class="tra-volrow-lbl">${esc(d.label)}</span>
        <span class="tra-volrow-val"><span class="tra-num">${num0(d.vol)}</span> <small>${esc(unidad)} · ${share}%</small></span>
      </div>
      <div class="tra-volbar-track">
        <div class="tra-volbar-fill" data-bar="${pct}" style="background:${col}"></div>
      </div>
    </div>`;
  }).join('');
  return `
  <div class="tra-card tra-volpanel rise lively" data-tilt>
    <div class="tra-volpanel-head">
      <span class="tra-volpanel-titulo">Volumen por músculo</span>
      <span class="tra-volpanel-sub">últimos 7 días · <span class="tra-num">${num0(total)}</span> ${esc(unidad)} total</span>
    </div>
    <div class="tra-volrows">${filas}</div>
  </div>`;
}

function bloqueProgreso(puntos) {
  const unidad = ejercicioUnidad(S.progresoEjId);
  const pr = prDe(puntos);
  const ultimo = puntos[puntos.length - 1];
  const anterior = puntos.length > 1 ? puntos[puntos.length - 2] : null;
  const delta1rm = anterior ? ultimo.mejor1rm - anterior.mejor1rm : 0;
  const deltaCls = delta1rm > 0.05 ? 'tra-up' : (delta1rm < -0.05 ? 'tra-down' : 'tra-flat');
  const deltaTxt = anterior
    ? (delta1rm > 0.05 ? '▲ +' + num(delta1rm) : delta1rm < -0.05 ? '▼ −' + num(Math.abs(delta1rm)) : '= sin cambio')
    : 'primera sesión';
  return `
  <div class="tra-card tra-prog rise lively" data-tilt>
    ${graficoSVG(puntos)}
    <div class="tra-prog-stats">
      <div class="tra-prog-stat tra-prog-stat-pr">
        <span class="tra-prog-stat-k">Récord 🔥 (1RM est.)</span>
        <span class="tra-prog-stat-v tra-num">${num(pr ? pr.mejor1rm : 0)} <small>${esc(unidad)}</small></span>
        ${pr ? `<span class="tra-prog-stat-sub">${esc(labelCorto(pr.fecha))}</span>` : ''}
      </div>
      <div class="tra-prog-stat">
        <span class="tra-prog-stat-k">Mejor peso</span>
        <span class="tra-prog-stat-v tra-num">${num(ultimo.mejorPeso)} <small>${esc(unidad)}</small></span>
        <span class="tra-prog-stat-sub">última sesión</span>
      </div>
      <div class="tra-prog-stat">
        <span class="tra-prog-stat-k">Última vs. anterior</span>
        <span class="tra-prog-stat-v tra-num ${deltaCls}">${deltaTxt}</span>
        <span class="tra-prog-stat-sub">1RM estimado</span>
      </div>
    </div>
    <div class="tra-prog-nota">Línea = 1RM estimado (Epley) del mejor set por sesión. Puntos = ${puntos.length} ${puntos.length === 1 ? 'sesión' : 'sesiones'}.</div>
  </div>`;
}

// Gráfico de línea SVG inline, sin librerías. Eje X = índice de sesión
// (equiespaciado), eje Y = 1RM estimado. División por cero imposible:
// rango mínimo forzado y denominadores guardados.
function graficoSVG(puntos) {
  const W = 320, H = 160, PL = 8, PR = 8, PT = 12, PB = 18;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;
  const vals = puntos.map(p => p.mejor1rm);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max - min < 0.0001) { max = min + 1; min = Math.max(0, min - 1); } // rango plano → ventana artificial
  const span = max - min; // > 0 garantizado
  const n = puntos.length;
  const x = i => PL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = v => PT + innerH - ((v - min) / span) * innerH;

  const coords = puntos.map((p, i) => ({ cx: x(i), cy: y(p.mejor1rm), p }));
  const linea = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c.cx.toFixed(1) + ' ' + c.cy.toFixed(1)).join(' ');
  // Área bajo la línea (relleno suave).
  const area = coords.length
    ? `M${coords[0].cx.toFixed(1)} ${(PT + innerH).toFixed(1)} ` +
      coords.map(c => 'L' + c.cx.toFixed(1) + ' ' + c.cy.toFixed(1)).join(' ') +
      ` L${coords[coords.length - 1].cx.toFixed(1)} ${(PT + innerH).toFixed(1)} Z`
    : '';
  const puntosSVG = coords.map(c =>
    `<circle cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="3.2" class="tra-svg-dot"><title>${esc(labelCorto(c.p.fecha))}: ${num(c.p.mejor1rm)} (1RM est.)</title></circle>`
  ).join('');
  const gridY = [max, (max + min) / 2, min].map(v => {
    const yy = y(v);
    return `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${(W - PR).toFixed(1)}" y2="${yy.toFixed(1)}" class="tra-svg-grid"/>
      <text x="${PL}" y="${(yy - 3).toFixed(1)}" class="tra-svg-lbl">${num0(v)}</text>`;
  }).join('');
  return `
  <div class="tra-svg-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="tra-svg" role="img" aria-label="Evolución del 1RM estimado" preserveAspectRatio="none">
      ${gridY}
      ${area ? `<path d="${area}" class="tra-svg-area"/>` : ''}
      <path d="${linea}" class="tra-svg-line" fill="none"/>
      ${puntosSVG}
    </svg>
  </div>`;
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo tra-, solo var(--token)
   ============================================================ */
const CSS = `
.tra { max-width: 720px; margin: 0 auto; padding: var(--space-4); font-family: var(--font-ui); color: var(--text); }
.tra * { box-sizing: border-box; }
.tra button { font: inherit; color: inherit; cursor: pointer; }
.tra button:focus-visible, .tra input:focus-visible, .tra select:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.tra-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

/* Header + tabs */
.tra-head { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.tra-head-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.tra-head-titulo { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.tra-head-ic { width: 40px; height: 40px; flex: none; display: grid; place-items: center; border-radius: 12px; font-size: 1.15rem;
  background: linear-gradient(135deg, var(--accent-soft), var(--accent-2-soft)); border: 1px solid var(--border-strong); }
.tra-titulo { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: 1.4rem; letter-spacing: -.01em; }
.tra-tabs { display: flex; gap: var(--space-2); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.tra-tab { flex: 1 1 0; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); white-space: nowrap;
  transition: background var(--dur) var(--ease-out-expo), color var(--dur) ease, border-color var(--dur) ease, transform var(--dur) var(--ease-out-expo); }
.tra-tab:hover:not(.activa) { color: var(--text); border-color: var(--border-strong); }
.tra-tab.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 700; box-shadow: 0 0 0 1px var(--accent-soft), 0 6px 18px -8px var(--accent); }

/* Navegación de fecha */
.tra-fechanav { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.tra-nav-btn { width: 48px; min-height: 48px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 1.4rem; line-height: 1; color: var(--text-dim); }
.tra-nav-btn:active { background: var(--surface-2); }
.tra-fechanav-centro { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); min-width: 0; }
.tra-fechanav-label { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; text-align: center; }
.tra-chip { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: var(--space-1) var(--space-3); font-size: .78rem; min-height: 28px; }

/* Cards */
.tra-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--shadow-1); }

/* Header de sesión */
.tra-sesion-head { position: relative; display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; overflow: hidden; }
.tra-sesion-head::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: var(--glow-accent); opacity: .5; }
.tra-nombre-input { position: relative; flex: 1; min-width: 140px; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font: inherit; font-family: var(--font-display); font-weight: 600; }
.tra-nombre-input::placeholder { color: var(--text-faint); font-weight: 400; }
.tra-nombre-input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.tra-sesion-stats { position: relative; display: flex; gap: var(--space-4); flex: none; }
.tra-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 42px; }
.tra-stat-v { font-size: 1.25rem; font-weight: 800; line-height: 1; color: var(--text); }
.tra-stat-vol .tra-stat-v { color: var(--accent); }
.tra-stat-k { font-size: .6rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .05em; }

/* Ejercicio */
.tra-ejercicio { padding-bottom: var(--space-3); }
.tra-ej-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); }
.tra-ej-info { min-width: 0; }
.tra-ej-nombre { margin: 0; font-family: var(--font-display); font-size: 1.05rem; overflow-wrap: anywhere; }
.tra-ej-meta { font-size: .74rem; color: var(--text-dim); margin-top: 2px; }
.tra-previo { font-size: .76rem; color: var(--accent-2); background: var(--accent-2-soft); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-2); margin-bottom: var(--space-3); overflow-wrap: anywhere; }
.tra-previo-vacio { color: var(--text-faint); background: var(--surface-2); }

/* Grilla de sets */
.tra-sets { display: flex; flex-direction: column; gap: var(--space-2); }
.tra-set-header { display: grid; grid-template-columns: 28px 1fr 1fr 64px 40px; gap: var(--space-2); align-items: center; padding: 0 var(--space-1); }
.tra-set-col, .tra-set-col-num { font-size: .66rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .05em; text-align: center; }
.tra-set-col-num { text-align: center; }
.tra-set { position: relative; display: grid; grid-template-columns: 28px 1fr 1fr 64px 40px; gap: var(--space-2); align-items: center; border-radius: var(--radius); transition: background var(--dur) ease; }
.tra-set-num { font-size: .9rem; color: var(--text-dim); text-align: center; }
.tra-set-input { width: 100%; min-width: 0; min-height: 48px; padding: var(--space-1) var(--space-2); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font-size: 1.15rem; font-weight: 700; text-align: center; -moz-appearance: textfield; }
.tra-set-input::-webkit-outer-spin-button, .tra-set-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.tra-set-input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.tra-set-input::placeholder { color: var(--text-faint); font-weight: 400; }
.tra-set-input-rpe { font-size: .95rem; font-weight: 600; color: var(--text-dim); }
.tra-set-del { justify-self: center; }

.tra-add-set { width: 100%; min-height: 44px; margin-top: var(--space-3); background: var(--surface-2); border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-weight: 600; transition: background .15s, color .15s, border-color .15s; }
.tra-add-set:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.tra-add-set:disabled { opacity: .5; cursor: not-allowed; }

.tra-add-ejercicio { width: 100%; min-height: 52px; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: var(--radius); color: var(--accent); font-weight: 700; font-size: 1rem; transition: filter .15s; }
.tra-add-ejercicio:hover { filter: brightness(1.15); }
.tra-add-ejercicio:active { transform: translateY(1px); }

/* Botones */
.tra-btn-primario { min-height: 50px; padding: var(--space-2) var(--space-4); background: var(--accent); border: none; border-radius: var(--radius); color: var(--bg); font-weight: 700; transition: filter .15s; }
.tra-btn-primario:hover:not(:disabled) { filter: brightness(1.1); }
.tra-btn-primario:active:not(:disabled) { transform: translateY(1px); }
.tra-btn-primario:disabled { opacity: .5; cursor: not-allowed; }
.tra-btn-sec { min-height: 44px; padding: var(--space-1) var(--space-4); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-weight: 600; transition: background .15s, color .15s, border-color .15s; }
.tra-btn-sec:hover:not(:disabled) { background: var(--surface-2); color: var(--text); border-color: var(--text-faint); }
.tra-btn-ghost { min-height: 40px; padding: var(--space-1) var(--space-4); background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-weight: 600; transition: color .15s, background .15s; }
.tra-btn-ghost:hover { color: var(--danger); background: var(--surface-2); }

.tra-icono { width: 40px; min-height: 40px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-size: .95rem; }
.tra-borrar:hover, .tra-borrar:active, .tra-set-del:hover, .tra-set-del:active { color: var(--danger); background: var(--surface-2); }

.tra-input { width: 100%; min-height: 46px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font: inherit; }
.tra-input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
select.tra-input { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--text-faint) 50%), linear-gradient(135deg, var(--text-faint) 50%, transparent 50%); background-position: calc(100% - 18px) center, calc(100% - 13px) center; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: var(--space-8); }
.tra-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.tra-campo-label { font-size: .74rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; }

.tra-slot-vacio { padding: var(--space-4); text-align: center; color: var(--text-faint); font-size: .88rem; }

/* Modal */
.tra-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--bg) 75%, transparent); backdrop-filter: blur(2px); }
.tra-modal-card { width: 100%; max-width: 480px; max-height: 88vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: var(--space-4); box-shadow: var(--shadow-2); }
.tra-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-4); }
.tra-modal-titulo { margin: 0; font-family: var(--font-display); font-size: 1.05rem; overflow-wrap: anywhere; }
.tra-modal-form { display: flex; flex-direction: column; gap: var(--space-3); overflow-y: auto; }
.tra-modal-acciones { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.tra-modal-acciones .tra-btn-primario { flex: 1; }

.tra-buscador { margin-bottom: var(--space-3); }
.tra-ej-lista { display: flex; flex-direction: column; gap: var(--space-2); overflow-y: auto; max-height: 46vh; }
.tra-ej-op { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 52px; padding: var(--space-2) var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); text-align: left; transition: border-color .15s, background .15s; }
.tra-ej-op:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
.tra-ej-op:disabled { opacity: .5; cursor: not-allowed; }
.tra-ej-op-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tra-ej-op-nombre { font-weight: 600; font-size: .95rem; overflow-wrap: anywhere; }
.tra-ej-op-grupo { font-size: .72rem; color: var(--text-dim); }
.tra-ej-op-mas { font-size: 1.4rem; color: var(--accent); font-weight: 700; flex: none; }
.tra-ej-op-en { flex: none; }
.tra-badge { display: inline-flex; align-items: center; padding: 2px 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; color: var(--text-dim); font-size: .62rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.tra-picker-vacio { padding: var(--space-6) var(--space-3); text-align: center; color: var(--text-faint); font-size: .85rem; }
.tra-crear-btn { margin-top: var(--space-3); width: 100%; }

/* Historial */
.tra-hist { display: flex; flex-direction: column; gap: var(--space-3); }
.tra-hist-item { margin-bottom: 0; padding: 0; overflow: hidden; }
.tra-hist-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4); cursor: pointer; }
.tra-hist-info { min-width: 0; }
.tra-hist-fecha { font-family: var(--font-display); font-weight: 600; font-size: 1rem; text-transform: capitalize; overflow-wrap: anywhere; }
.tra-hist-nombre { font-weight: 400; color: var(--text-dim); font-family: var(--font-ui); }
.tra-hist-resumen { font-size: .78rem; color: var(--text-dim); margin-top: 2px; }
.tra-hist-flecha { flex: none; color: var(--text-faint); font-size: 1rem; transition: transform .18s ease; }
.tra-hist-flecha.abierta { transform: rotate(180deg); color: var(--accent); }
.tra-hist-detalle { padding: 0 var(--space-4) var(--space-4); border-top: 1px solid var(--border); }
.tra-hist-ej { padding: var(--space-3) 0; border-bottom: 1px solid var(--border); }
.tra-hist-ej:last-of-type { border-bottom: none; }
.tra-hist-ej-nombre { font-weight: 600; font-size: .9rem; margin-bottom: var(--space-2); }
.tra-hist-ej-sets { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.tra-hist-set { padding: 2px 8px; background: var(--surface-2); border-radius: var(--radius-sm); font-size: .82rem; }
.tra-hist-rpe { color: var(--text-faint); font-size: .72rem; }
.tra-hist-borrar { margin-top: var(--space-3); }

/* Progreso */
.tra-prog-selector { margin-bottom: var(--space-4); }
.tra-svg-wrap { width: 100%; margin-bottom: var(--space-4); }
.tra-svg { width: 100%; height: auto; display: block; }
.tra-svg-grid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 3; }
.tra-svg-lbl { fill: var(--text-faint); font-size: 8px; font-family: var(--font-num); }
.tra-svg-area { fill: var(--accent-soft); }
.tra-svg-line { stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tra-svg-dot { fill: var(--accent); stroke: var(--surface); stroke-width: 1.5; }
.tra-prog-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); margin-bottom: var(--space-3); }
.tra-prog-stat { background: var(--surface-2); border-radius: var(--radius); padding: var(--space-3) var(--space-2); text-align: center; display: flex; flex-direction: column; gap: 2px; }
.tra-prog-stat-k { font-size: .64rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .05em; }
.tra-prog-stat-v { font-size: 1.1rem; font-weight: 700; }
.tra-prog-stat-v small { font-size: .68rem; color: var(--text-dim); font-weight: 600; }
.tra-prog-stat-sub { font-size: .66rem; color: var(--text-faint); }
.tra-up { color: var(--ok); }
.tra-down { color: var(--danger); }
.tra-flat { color: var(--text-dim); }
.tra-prog-nota { font-size: .72rem; color: var(--text-faint); text-align: center; padding-top: var(--space-2); border-top: 1px solid var(--border); }

/* Vacíos y cargando */
.tra-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.tra-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.tra-vacio p { margin: 0 0 var(--space-2); }
.tra-vacio-sub { font-size: .82rem; color: var(--text-faint); }
.tra-vacio .tra-btn-primario, .tra-vacio .tra-btn-sec { margin-top: var(--space-4); }
.tra-cargando { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-faint); font-size: .9rem; }

/* ---------- PR: badge en la fila + chip en el ejercicio + destello ---------- */
.tra-pr-badge { position: absolute; top: -9px; right: 46px; z-index: 2; display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 8px; border-radius: 999px; font-family: var(--font-num); font-size: .62rem; font-weight: 700; letter-spacing: .03em; white-space: nowrap;
  color: var(--bg); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 2px 10px -2px var(--accent);
  animation: tra-pr-pop var(--dur) var(--ease-spring) both; }
.tra-set-pr .tra-set-input[data-campo="peso"], .tra-set-pr .tra-set-input[data-campo="reps"] { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)); }
.tra-pr-chip { display: inline-flex; align-items: center; vertical-align: middle; margin-left: 6px; padding: 2px 8px; border-radius: 999px;
  font-family: var(--font-num); font-size: .6rem; font-weight: 700; letter-spacing: .03em; color: var(--bg);
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 2px 10px -3px var(--accent); }
@keyframes tra-pr-pop { 0% { transform: scale(.6); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes tra-pr-flash {
  0%   { background: color-mix(in srgb, var(--accent) 34%, transparent); box-shadow: 0 0 0 1px var(--accent) inset; }
  100% { background: transparent; box-shadow: none; }
}
.tra-pr-flash { animation: tra-pr-flash 1100ms var(--ease-out-expo) both; }

/* ---------- Volumen por músculo (tab Progreso) ---------- */
.tra-volpanel { position: relative; overflow: hidden; }
.tra-volpanel::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: var(--glow-accent-2); opacity: .4; }
.tra-volpanel-head { position: relative; display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); flex-wrap: wrap; }
.tra-volpanel-titulo { font-family: var(--font-display); font-weight: 700; font-size: 1.02rem; }
.tra-volpanel-sub { font-size: .72rem; color: var(--text-faint); }
.tra-volrows { position: relative; display: flex; flex-direction: column; gap: var(--space-3); }
.tra-volrow { display: flex; flex-direction: column; gap: 5px; }
.tra-volrow-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.tra-volrow-lbl { font-size: .82rem; font-weight: 600; color: var(--text); }
.tra-volrow-val { font-size: .82rem; font-weight: 700; color: var(--text-dim); }
.tra-volrow-val small { font-size: .66rem; color: var(--text-faint); font-weight: 600; }
.tra-volbar-track { height: 9px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.tra-volbar-fill { height: 100%; width: 0; border-radius: 999px; transition: width var(--dur-slow) var(--ease-out-expo); }

/* ---------- Modal glass ---------- */
.tra-glass { background: color-mix(in srgb, var(--surface) 82%, transparent); backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3); }

/* ---------- Timer de descanso (flotante, fixed en <body>) ---------- */
.tra-timer { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 18px); transform: translate(-50%, 140%); z-index: 70;
  display: flex; align-items: center; gap: var(--space-3); padding: 10px 16px 10px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 86%, transparent); backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); opacity: 0; pointer-events: none;
  transition: transform var(--dur-slow) var(--ease-spring), opacity var(--dur) ease; font-family: var(--font-ui); }
.tra-timer.activo { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
.tra-timer-ring { position: relative; width: 56px; height: 56px; flex: none; }
.tra-timer-ring svg { width: 56px; height: 56px; transform: rotate(-90deg); }
.tra-timer-fill { fill: none; stroke: var(--accent); stroke-linecap: round; }
.tra-timer-num { position: absolute; inset: 0; display: grid; place-items: center; font-size: .84rem; font-weight: 700; color: var(--text); }
.tra-timer-body { display: flex; flex-direction: column; gap: 4px; }
.tra-timer-cap { font-size: .6rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); }
.tra-timer-ctrl { display: flex; align-items: center; gap: 6px; }
.tra-timer-btn { min-width: 40px; min-height: 30px; padding: 0 10px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim); font-family: var(--font-num); font-size: .76rem; font-weight: 700; cursor: pointer; transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease; }
.tra-timer-btn:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface); }
.tra-timer-x { min-width: 30px; padding: 0; color: var(--text-faint); }
.tra-timer-x:hover { color: var(--danger); }
/* Zona de alerta: últimos 10s → el anillo y el número se ponen ámbar y el aro late */
.tra-timer-warn .tra-timer-fill { stroke: var(--warn); }
.tra-timer-warn .tra-timer-num { color: var(--warn); }
.tra-timer-warn .tra-timer-ring { animation: tra-timer-pulse 1s ease-in-out infinite; }
@keyframes tra-timer-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
/* Fin: destello verde y "¡Dale!" (se oculta el número, el ::after trae el texto) */
.tra-timer-fin .tra-timer-fill { stroke: var(--ok); }
.tra-timer-fin .tra-timer-num { color: transparent; }
.tra-timer-fin .tra-timer-num::after { content: "¡Dale!"; color: var(--ok); font-size: .68rem; font-weight: 800; }
.tra-timer-fin .tra-timer-cap::after { content: " · listo"; color: var(--ok); }

@media (prefers-reduced-motion: reduce) {
  .tra-timer { transition: opacity var(--dur) ease; transform: translate(-50%, 0); }
  .tra-timer:not(.activo) { transform: translate(-50%, 0); }
  .tra-timer-warn .tra-timer-ring { animation: none; }
  .tra-timer-fill { transition: none; }
  .tra-pr-flash, .tra-pr-badge, .tra-pr-chip { animation: none; }
  .tra-volbar-fill { transition: none; }
}

/* Desktop */
@media (min-width: 768px) {
  .tra { padding: var(--space-6); }
  .tra-tab { flex: none; }
  .tra-modal { align-items: center; }
  .tra-modal-card { border-radius: var(--radius-lg); }
  .tra-timer { left: auto; right: 24px; bottom: 24px; transform: translateY(140%); }
  .tra-timer.activo { transform: translateY(0); }
}
`;

function inyectarEstilos() {
  if (document.getElementById('tra-styles')) return;
  const st = document.createElement('style');
  st.id = 'tra-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'training',
  label: 'Training',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.tab = 'sesion';
    S.fecha = hoyStr();
    S.ejercicios = [];
    S.sesion = null;
    S.sets = [];
    S.previos = {};
    S.historial = [];
    S.historialCargado = false;
    S.progresoEjId = '';
    S.progresoData = null;
    S.volGrupo = null;
    S.volGrupoCargado = false;
    S.volGrupoCargando = false;
    S.prPorEj = {};
    S.setsPR = {};
    S.ejPicker = null;
    S.busca = '';
    S.expandidas = {};
    limpiarTimer();
    inyectarEstilos();
    bind();
    if (!supabase) {
      container.innerHTML = `
      <div class="tra">
        <div class="tra-vacio">
          <div class="tra-vacio-icono">🔌</div>
          <p>Supabase no está configurado.</p>
          <p class="tra-vacio-sub">Completá js/core/env.js con tu URL y anon key (ver SETUP.md).</p>
        </div>
      </div>`;
      return;
    }
    container.innerHTML = `<div class="tra"><div class="tra-cargando">Cargando Training…</div></div>`;
    try {
      await cargarEjercicios();
      await cargarSesion();
      S.ultimaCarga = Date.now();
    } catch (err) {
      toast('No se pudo cargar Training: ' + msgErr(err), 'error');
    }
    this.render();
  },

  render() {
    if (!S.container) return;
    if (!supabase) return;
    // Si cambió el día real desde la última visita (app abierta cruzando de día),
    // reenganchar la fecha visible a hoy sin dejar la sesión de ayer bajo el label.
    if (S.tab === 'sesion' && S.fecha !== hoyStr() && Date.now() - S.ultimaCarga > 6 * 60 * 60 * 1000) {
      S.fecha = hoyStr();
      S.sesion = null; S.sets = []; S.previos = {};
      S.cargando = true;
      paint();
      S.ultimaCarga = Date.now();
      cargarSesion()
        .then(() => { S.cargando = false; paint(); })
        .catch(() => { S.cargando = false; paint(); toast('No se pudo actualizar el día', 'warning'); });
      return;
    }
    paint();
    // Refresco silencioso al volver de otra ruta (multi-device). No pisa una
    // edición inline en curso (si hay guardados pendientes, esperá a que caigan).
    if (Date.now() - S.ultimaCarga > 30000 && !edicionPendiente()) {
      S.ultimaCarga = Date.now();
      const fecha = S.fecha;
      Promise.all([cargarEjercicios(), cargarSesion(true)])
        .then(() => { if (S.fecha === fecha && !edicionPendiente()) paint(); })
        .catch(() => { /* silencioso: la data pintada coincide con su label */ });
    }
  },
};
