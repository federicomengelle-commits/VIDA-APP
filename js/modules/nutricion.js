// VIDA — Módulo Nutrición (Fase 1)
// Log diario · Planificador semanal · Meal prep · Lista de compras
// Contrato: docs/CONTRATOS.md §4 y §8. Spec funcional: CLAUDE.md §5.
//
// Piel "Instrumento Vivo" (rediseño): usa el motor de movimiento de core/anim.js
// (countUp, ring, stagger, tiltAll) + clases de css/motion.css. La LÓGICA de datos
// (queries, inserts/soft-delete, guards anti-carrera, config-driven) está intacta:
// sólo se rediseñaron las funciones de render y se sumaron features determinísticas
// robadas de Cal AI (anillo héroe de proteína, macros, escala de porción,
// sparkline 7d, timer de ayuno en vivo). BACKLOG.md §2 y §7.
import { supabase } from '../core/supabase.js';
import { toast, confirmDialog } from '../core/ui.js';
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local, semana desde LUNES)
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
function lunesDe(s) { const d = parseFecha(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmtFecha(d); }
function diaIdx(s) { return (parseFecha(s).getDay() + 6) % 7; }
function labelFecha(s) {
  const hoy = hoyStr();
  if (s === hoy) return 'Hoy';
  if (s === addDias(hoy, -1)) return 'Ayer';
  if (s === addDias(hoy, 1)) return 'Mañana';
  const d = parseFecha(s);
  return DIAS[diaIdx(s)] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()];
}
function labelCorto(s) { const d = parseFecha(s); return d.getDate() + '/' + (d.getMonth() + 1); }
function horaAhora() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ============================================================
   Utilidades
   ============================================================ */
const NF = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
function num(n) { return NF.format(Number(n) || 0); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }

/* ============================================================
   Estado del módulo (el DOM se repinta entero en cada paint)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,
  boundEl: null,           // container al que están atados los listeners (si cambia, se re-bindea)
  tab: 'hoy',              // 'hoy' | 'semana' | 'prep' | 'compras'
  fecha: hoyStr(),         // día visible en Hoy
  semana: lunesDe(hoyStr()), // lunes de la semana visible (Semana/Prep/Compras)
  alimentos: [],
  combos: [],
  diasTipo: [],            // plantillas de día (nutricion_dias_tipo)
  log: [],                 // nutricion_log del día visible
  plan: [],                // nutricion_plan de la semana visible
  hist7: {},               // { 'YYYY-MM-DD': protTotal } últimos 7 días → sparkline
  cargando: false,
  mutandoPlan: false,      // in-flight guard de mutaciones del plan (doble tap)
  anotando: false,         // in-flight guard de inserts al log (doble tap)
  picker: null,            // { slot, tab: 'favoritos'|'combos'|'alimentos'|'manual', escala, sel }
  escala: 1,               // multiplicador de porción vigente en el picker (Cal AI)
  busca: '',
  comboPicker: null,       // { fecha, slot, tab: 'combos'|'alimentos' } → modal del planificador
  plantillaModal: null,    // { fecha } → modal de plantillas de día
  ultimaCarga: 0,
};

/* ============================================================
   Config del usuario — TODO viene de user_config, nada hardcodeado
   ============================================================ */
function cfgSlots() {
  const s = S.config ? S.config.get('slots', []) : [];
  return Array.isArray(s) ? s.filter(x => x && x.id && x.label) : [];
}
function cfgTarget() {
  const t = (S.config && S.config.get('proteina_target', null)) || {};
  return { target: Number(t.target_g) || 0, piso: Number(t.piso_g) || 0 };
}
function cfgAyuno() { return S.config ? S.config.get('ayuno', null) : null; }
function cfgCompensacion() { return S.config ? S.config.get('compensacion', null) : null; }
function cfgCreatina() { return S.config ? S.config.get('creatina', null) : null; }

/* ============================================================
   Datos — Supabase (siempre .eq('user_id') + soft delete donde exista)
   ============================================================ */
async function cargarCatalogo() {
  const [alim, comb, dias] = await Promise.all([
    supabase.from('nutricion_alimentos').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).order('nombre'),
    supabase.from('nutricion_combos').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).order('nombre'),
    supabase.from('nutricion_dias_tipo').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).order('nombre'),
  ]);
  if (alim.error) throw alim.error;
  if (comb.error) throw comb.error;
  S.alimentos = alim.data || [];
  S.combos = comb.data || [];
  // Plantillas degradan con gracia: si la tabla no está (falta correr sql/03)
  // la feature queda apagada pero el catálogo existente NO se rompe.
  if (dias.error) {
    S.diasTipo = [];
    console.warn('[nutricion] nutricion_dias_tipo no disponible (¿falta correr sql/03?):', dias.error);
  } else {
    S.diasTipo = dias.data || [];
  }
}

// Devuelven false si la respuesta llegó tarde (el usuario ya navegó a otro
// día/semana): en ese caso NO pisan el estado, para no pintar datos de un
// período bajo el label de otro.
async function cargarLog() {
  const fecha = S.fecha;
  const { data, error } = await supabase.from('nutricion_log').select('*')
    .eq('user_id', S.userId).eq('fecha', fecha).order('created_at');
  if (error) throw error;
  if (fecha !== S.fecha) return false;
  S.log = data || [];
  return true;
}

async function cargarPlan() {
  const lunes = S.semana;
  const { data, error } = await supabase.from('nutricion_plan').select('*')
    .eq('user_id', S.userId)
    .gte('fecha', lunes).lte('fecha', addDias(lunes, 6))
    .order('fecha');
  if (error) throw error;
  if (lunes !== S.semana) return false;
  S.plan = data || [];
  return true;
}

// Sparkline (Cal AI §7): proteína total por día de los últimos 7 días.
// Tolerante — si falla, deja S.hist7 como está y la feature simplemente no pinta.
async function cargarHistoria7() {
  const desde = addDias(hoyStr(), -6);
  try {
    const { data, error } = await supabase.from('nutricion_log')
      .select('fecha, prot').eq('user_id', S.userId)
      .gte('fecha', desde).lte('fecha', hoyStr());
    if (error) throw error;
    const acc = {};
    for (const r of (data || [])) {
      const f = String(r.fecha).slice(0, 10);
      acc[f] = (acc[f] || 0) + (Number(r.prot) || 0);
    }
    S.hist7 = acc;
    return true;
  } catch (_) { return false; }
}

/* ============================================================
   Derivados
   ============================================================ */
function totalesDia() {
  const t = { prot: 0, carbo: 0, grasa: 0, kcal: 0 };
  for (const e of S.log) {
    t.prot += Number(e.prot) || 0;
    t.carbo += Number(e.carbo) || 0;
    t.grasa += Number(e.grasa) || 0;
    t.kcal += Number(e.kcal) || 0;
  }
  return t;
}

function entradasSlot(slotId) { return S.log.filter(e => e.slot === slotId); }

// Serie de 7 días [{ fecha, prot, esHoy }] para el sparkline. El día visible
// (S.fecha, casi siempre hoy) usa el total en vivo del log cargado; el resto
// sale del snapshot S.hist7. Así la barra de hoy se mueve al tipear sin recargar.
function serie7() {
  const totHoy = totalesDia().prot;
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const f = addDias(hoyStr(), -i);
    const prot = f === S.fecha ? totHoy : (Number(S.hist7[f]) || 0);
    out.push({ fecha: f, prot, esHoy: f === hoyStr() });
  }
  return out;
}

// Escala los macros de un item por el multiplicador vigente del picker.
// Devuelve una copia con nombre anotado (ej "Carne 250g ×1.5") si escala ≠ 1.
function escalarItem(item, factor) {
  const f = Number(factor) || 1;
  if (f === 1) return { ...item };
  const sufijo = f === 0.5 ? ' ×½' : f === 0.75 ? ' ×¾' : ' ×' + num(f);
  return {
    ...item,
    nombre: item.nombre + sufijo,
    prot: (Number(item.prot) || 0) * f,
    carbo: (Number(item.carbo) || 0) * f,
    grasa: (Number(item.grasa) || 0) * f,
    kcal: (Number(item.kcal) || 0) * f,
  };
}

// Ventana de ayuno en vivo (Cal AI §7 · BACKLOG §2): a partir de la config
// ultima_comida → primera_comida, calcula estado ahora. Devuelve null si no hay
// config válida. `pct` = avance del ayuno (0..100) para el arco.
function estadoAyuno() {
  const ay = cfgAyuno();
  if (!ay || !ay.ultima_comida || !ay.primera_comida) return null;
  const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const ini = hm(ay.ultima_comida);   // arranca el ayuno (ej 21:00)
  const fin = hm(ay.primera_comida);  // corta el ayuno (ej 14:00 del día siguiente)
  const ahora = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  // Duración total de la ventana (cruza medianoche si fin <= ini).
  const total = (fin - ini + 1440) % 1440 || 1440;
  // Minutos transcurridos desde el inicio del ayuno hasta ahora (mod 24h).
  const trans = (ahora - ini + 1440) % 1440;
  const ayunando = trans < total;
  const fmtHM = (min) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? (m > 0 ? h + 'h ' + m + 'm' : h + 'h') : m + 'm';
  };
  if (ayunando) {
    const falta = total - trans;
    return {
      ayunando: true, pct: Math.min(100, (trans / total) * 100),
      texto: 'Ayunando hace ' + fmtHM(trans),
      sub: falta > 0 ? 'faltan ' + fmtHM(falta) : 'ya podés comer',
      ventana: ay.ultima_comida + ' → ' + ay.primera_comida,
    };
  }
  // Ventana de comida abierta: cuánto falta para el próximo ayuno.
  const haciaAyuno = (ini - ahora + 1440) % 1440;
  return {
    ayunando: false, pct: 0,
    texto: 'Ventana de comida abierta',
    sub: 'ayuno en ' + fmtHM(haciaAyuno),
    ventana: ay.ultima_comida + ' → ' + ay.primera_comida,
  };
}

function planDe(fecha, slot) {
  return S.plan.find(p => String(p.fecha).slice(0, 10) === fecha && p.slot === slot) || null;
}

function combosOrdenados(slotId) {
  return [...S.combos].sort((a, b) =>
    ((b.slot === slotId) - (a.slot === slotId)) ||
    ((b.favorito === true) - (a.favorito === true)) ||
    String(a.nombre).localeCompare(String(b.nombre)));
}

// Semana visible: cuántas veces se planificó cada combo + suma de
// ingredientes por nombre+unidad (base de Prep y Compras).
function resumenSemana() {
  const conteo = new Map();
  const conteoAlim = new Map();
  for (const p of S.plan) {
    if (p.combo_id) conteo.set(p.combo_id, (conteo.get(p.combo_id) || 0) + 1);
    else if (p.alimento_id) conteoAlim.set(p.alimento_id, (conteoAlim.get(p.alimento_id) || 0) + 1);
  }
  const combos = [];
  const ing = new Map();
  for (const [id, veces] of conteo) {
    const c = S.combos.find(x => x.id === id);
    if (!c) continue;
    combos.push({ combo: c, veces });
    const lista = Array.isArray(c.ingredientes) ? c.ingredientes : [];
    for (const i of lista) {
      if (!i || !i.nombre) continue;
      const nombre = String(i.nombre).trim();
      const unidad = String(i.unidad || '').trim();
      const key = (nombre + '|' + unidad).toLowerCase();
      const prev = ing.get(key) || { nombre, unidad, cantidad: 0 };
      prev.cantidad += (Number(i.cantidad) || 0) * veces;
      ing.set(key, prev);
    }
  }
  // Alimentos sueltos planificados → entran como "N × porción" (ej: 3 × 250 g)
  for (const [id, veces] of conteoAlim) {
    const a = S.alimentos.find(x => x.id === id);
    if (!a) continue;
    const nombre = String(a.nombre).trim();
    const unidad = a.porcion ? '× ' + String(a.porcion).trim() : 'veces';
    const key = (nombre + '|' + unidad).toLowerCase();
    const prev = ing.get(key) || { nombre, unidad, cantidad: 0 };
    prev.cantidad += veces;
    ing.set(key, prev);
  }
  combos.sort((a, b) => (b.veces - a.veces) || String(a.combo.nombre).localeCompare(String(b.combo.nombre)));
  const ingredientes = [...ing.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { combos, ingredientes };
}

// Items (combo_id XOR alimento_id) asignados a los slots de un día → formato
// jsonb de nutricion_dias_tipo: [{ slot, tipo, item_id }]
function itemsDelDia(fecha) {
  const items = [];
  for (const sl of cfgSlots()) {
    const p = planDe(fecha, sl.id);
    if (!p) continue;
    if (p.combo_id) items.push({ slot: sl.id, tipo: 'combo', item_id: p.combo_id });
    else if (p.alimento_id) items.push({ slot: sl.id, tipo: 'alimento', item_id: p.alimento_id });
  }
  return items;
}

// Lo planificado para (fecha, slot) resuelto contra el catálogo actual
// (snapshot de macros de HOY, no del momento de planificar). Null si el plan
// cargado es de otra semana o el item ya no existe.
function itemPlanificado(fecha, slotId) {
  if (lunesDe(fecha) !== S.semana) return null;
  const p = planDe(fecha, slotId);
  if (!p) return null;
  if (p.combo_id) {
    const c = S.combos.find(x => x.id === p.combo_id);
    return c ? { tipo: 'combo', id: c.id, nombre: c.nombre, prot: c.prot, carbo: c.carbo, grasa: c.grasa, kcal: c.kcal } : null;
  }
  if (p.alimento_id) {
    const a = S.alimentos.find(x => x.id === p.alimento_id);
    if (!a) return null;
    return {
      tipo: 'alimento', id: a.id,
      nombre: a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre,
      prot: a.prot, carbo: a.carbo, grasa: a.grasa, kcal: a.kcal,
    };
  }
  return null;
}

/* ============================================================
   Compras — checks en localStorage (solo estado de UI, clave por semana)
   ============================================================ */
function comprasKey() { return 'vida_nut_compras_' + S.userId + '_' + S.semana; }
function claveIngrediente(i) { return (i.nombre + '|' + i.unidad).toLowerCase(); }
function comprasEstado() {
  try { return JSON.parse(localStorage.getItem(comprasKey())) || {}; }
  catch (_) { return {}; }
}
function setCompra(key, marcado) {
  const e = comprasEstado();
  if (marcado) e[key] = true; else delete e[key];
  try { localStorage.setItem(comprasKey(), JSON.stringify(e)); } catch (_) { /* sin storage, no pasa nada */ }
}
function textoConteoCompras() {
  const { ingredientes } = resumenSemana();
  const estado = comprasEstado();
  const hechos = ingredientes.filter(i => estado[claveIngrediente(i)]).length;
  return hechos + ' de ' + ingredientes.length + ' en el changuito';
}

/* ============================================================
   Mutaciones
   ============================================================ */
async function agregarEntrada(slot, item) {
  if (S.anotando) return; // doble tap: una anotación a la vez
  S.anotando = true;
  const fecha = S.fecha;
  try {
    const fila = {
      user_id: S.userId,
      fecha: S.fecha,
      slot,
      item_tipo: item.tipo,
      item_id: item.id || null,
      item_nombre: item.nombre,
      prot: Math.max(0, Number(item.prot) || 0),
      carbo: Math.max(0, Number(item.carbo) || 0),
      grasa: Math.max(0, Number(item.grasa) || 0),
      kcal: Math.max(0, Number(item.kcal) || 0),
    };
    const { data, error } = await supabase.from('nutricion_log').insert(fila).select().single();
    if (error) throw error;
    if (S.fecha === fecha) S.log.push(data); // si navegó de día mientras insertaba, no contaminar la vista
    toast('Anotado: ' + item.nombre, 'success');
    paint();
  } catch (err) {
    toast('No se pudo anotar: ' + msgErr(err), 'error');
  }
  S.anotando = false;
}

function addAlimento(id) {
  const a = S.alimentos.find(x => x.id === id);
  if (!a || !S.picker) return;
  // Escala de porción (Cal AI): los macros se guardan ya escalados.
  return agregarEntrada(S.picker.slot, escalarItem({
    tipo: 'alimento', id: a.id,
    nombre: a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre,
    prot: a.prot, carbo: a.carbo, grasa: a.grasa, kcal: a.kcal,
  }, S.escala));
}

function addCombo(id) {
  const c = S.combos.find(x => x.id === id);
  if (!c || !S.picker) return;
  return agregarEntrada(S.picker.slot, escalarItem({
    tipo: 'combo', id: c.id, nombre: c.nombre,
    prot: c.prot, carbo: c.carbo, grasa: c.grasa, kcal: c.kcal,
  }, S.escala));
}

async function borrarEntrada(id) {
  const entrada = S.log.find(x => x.id === id);
  if (!entrada) return;
  const ok = await confirmDialog({
    title: 'Borrar entrada',
    message: '¿Sacás "' + entrada.item_nombre + '" del registro del día?',
    confirmText: 'Borrar',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await supabase.from('nutricion_log').delete()
      .eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.log = S.log.filter(x => x.id !== id);
    toast('Entrada borrada', 'success');
    paint();
  } catch (err) {
    toast('No se pudo borrar: ' + msgErr(err), 'error');
  }
}

async function toggleFav(tipo, id) {
  const lista = tipo === 'combo' ? S.combos : S.alimentos;
  const item = lista.find(x => x.id === id);
  if (!item) return;
  const nuevo = !item.favorito;
  item.favorito = nuevo; // optimista: feedback inmediato
  paint();
  try {
    const tabla = tipo === 'combo' ? 'nutricion_combos' : 'nutricion_alimentos';
    const { error } = await supabase.from(tabla).update({ favorito: nuevo })
      .eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
  } catch (err) {
    item.favorito = !nuevo;
    paint();
    toast('No se pudo actualizar el favorito: ' + msgErr(err), 'error');
  }
}

// Upsert de una celda del plan: update de la fila (fecha,slot) si existe,
// insert si no. patch setea combo_id XOR alimento_id (nullea el otro).
// `previo` opcional: fila snapshot para no depender de S.plan (que puede
// haber cambiado si el usuario navegó de semana durante un loop de awaits).
async function upsertPlan(fecha, slot, patch, previo = undefined) {
  const fila = previo === undefined ? planDe(fecha, slot) : previo;
  if (fila) {
    const { data, error } = await supabase.from('nutricion_plan')
      .update(patch)
      .eq('id', fila.id).eq('user_id', S.userId)
      .select().single();
    if (error) throw error;
    Object.assign(fila, data);
  } else {
    const { data, error } = await supabase.from('nutricion_plan')
      .insert({ user_id: S.userId, fecha, slot, ...patch })
      .select().single();
    if (error) throw error;
    if (lunesDe(fecha) === S.semana) S.plan.push(data); // no contaminar el estado de otra semana
  }
}

async function asignarPlanItem(patch) {
  if (S.mutandoPlan) return; // doble tap
  const ctx = S.comboPicker;
  if (!ctx) return;
  S.mutandoPlan = true;
  try {
    await upsertPlan(ctx.fecha, ctx.slot, patch);
    S.comboPicker = null;
    toast('Plan actualizado', 'success');
  } catch (err) {
    toast('No se pudo asignar: ' + msgErr(err), 'error');
  }
  S.mutandoPlan = false;
  paint();
}

function asignarCombo(comboId) { return asignarPlanItem({ combo_id: comboId, alimento_id: null }); }
function asignarAlimento(alimentoId) { return asignarPlanItem({ alimento_id: alimentoId, combo_id: null }); }

async function aplicarPlantilla(id) {
  const ctx = S.plantillaModal;
  if (!ctx) return;
  const pl = S.diasTipo.find(x => x.id === id);
  if (!pl) return;
  const items = (Array.isArray(pl.items) ? pl.items : [])
    .filter(i => i && i.slot && i.item_id && (i.tipo === 'combo' || i.tipo === 'alimento'));
  if (!items.length) { toast('La plantilla no tiene items', 'warning'); return; }
  if (S.mutandoPlan) return; // doble tap: una aplicación a la vez
  S.mutandoPlan = true;
  // Snapshot de las filas existentes del día ANTES de los awaits: si el
  // usuario navega de semana a mitad del loop, planDe dejaría de verlas y
  // se insertarían filas duplicadas.
  const previos = new Map(items.map(it => [it.slot, planDe(ctx.fecha, it.slot)]));
  S.plantillaModal = null; // cerrar ya: sin re-taps posibles sobre el modal
  paint();
  try {
    for (const it of items) {
      const patch = it.tipo === 'combo'
        ? { combo_id: it.item_id, alimento_id: null }
        : { alimento_id: it.item_id, combo_id: null };
      await upsertPlan(ctx.fecha, it.slot, patch, previos.get(it.slot) || null);
    }
    toast('Plantilla aplicada: ' + pl.nombre, 'success');
  } catch (err) {
    toast('No se pudo aplicar la plantilla: ' + msgErr(err), 'error');
  }
  S.mutandoPlan = false;
  paint();
}

async function borrarPlantilla(id) {
  const pl = S.diasTipo.find(x => x.id === id);
  if (!pl) return;
  const ok = await confirmDialog({
    title: 'Borrar plantilla',
    message: '¿Borrás la plantilla "' + pl.nombre + '"? Los días ya planificados quedan como están.',
    confirmText: 'Borrar',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await supabase.from('nutricion_dias_tipo')
      .update({ _deleted: true })
      .eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.diasTipo = S.diasTipo.filter(x => x.id !== id);
    toast('Plantilla borrada', 'success');
    paint();
  } catch (err) {
    toast('No se pudo borrar la plantilla: ' + msgErr(err), 'error');
  }
}

async function guardarPlantilla(nombre) {
  const ctx = S.plantillaModal;
  if (!ctx) return;
  const items = itemsDelDia(ctx.fecha);
  if (!items.length) { toast('El día no tiene nada asignado para guardar', 'warning'); return; }
  try {
    const { data, error } = await supabase.from('nutricion_dias_tipo')
      .insert({ user_id: S.userId, nombre, items })
      .select().single();
    if (error) throw error;
    S.diasTipo.push(data);
    S.diasTipo.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    toast('Plantilla guardada: ' + nombre, 'success');
    paint();
  } catch (err) {
    toast('No se pudo guardar la plantilla: ' + msgErr(err), 'error');
  }
}

function anotarPlanificado(slotId) {
  const item = itemPlanificado(S.fecha, slotId);
  if (!item) return;
  return agregarEntrada(slotId, item);
}

async function quitarPlan() {
  if (S.mutandoPlan) return; // doble tap
  const ctx = S.comboPicker;
  if (!ctx) return;
  const previo = planDe(ctx.fecha, ctx.slot);
  if (!previo) { S.comboPicker = null; paint(); return; }
  S.mutandoPlan = true;
  try {
    const { error } = await supabase.from('nutricion_plan').delete()
      .eq('id', previo.id).eq('user_id', S.userId);
    if (error) throw error;
    S.plan = S.plan.filter(p => p.id !== previo.id);
    toast('Quitado del plan', 'success');
  } catch (err) {
    toast('No se pudo quitar: ' + msgErr(err), 'error');
  }
  S.mutandoPlan = false;
  S.comboPicker = null;
  paint();
}

async function cambiarDia(fecha) {
  S.fecha = fecha;
  S.picker = null;
  S.cargando = true;
  // El chip "Planificado" resuelve contra la semana del día visible: si el
  // día cruza de semana, la semana cargada se reengancha a la del día.
  const cruzaSemana = lunesDe(fecha) !== S.semana;
  if (cruzaSemana) S.semana = lunesDe(fecha);
  paint();
  try {
    const [logOk] = await Promise.all([cargarLog(), cruzaSemana ? cargarPlan() : Promise.resolve(true)]);
    if (!logOk) return; // llegó tarde: otra navegación se hizo cargo
  } catch (err) {
    if (S.fecha !== fecha) return;
    S.log = []; // nunca dejar comidas de otro día bajo este label
    toast('No se pudo cargar el día: ' + msgErr(err), 'error');
  }
  S.cargando = false;
  paint();
}

async function cambiarSemana(lunes) {
  S.semana = lunes;
  S.comboPicker = null;
  S.plantillaModal = null;
  S.cargando = true;
  paint();
  try {
    if (!(await cargarPlan())) return; // llegó tarde: otra navegación se hizo cargo
  } catch (err) {
    if (S.semana !== lunes) return;
    S.plan = []; // nunca dejar el plan de otra semana bajo este label
    toast('No se pudo cargar la semana: ' + msgErr(err), 'error');
  }
  S.cargando = false;
  paint();
}

async function copiarLista() {
  const { ingredientes } = resumenSemana();
  if (!ingredientes.length) { toast('No hay nada para copiar', 'warning'); return; }
  const titulo = 'Compras — semana del ' + labelCorto(S.semana) + ' al ' + labelCorto(addDias(S.semana, 6));
  const lineas = ingredientes.map(i => ('• ' + i.nombre + ': ' + num(i.cantidad) + ' ' + i.unidad).trim());
  const texto = [titulo, ...lineas].join('\n');
  try {
    await navigator.clipboard.writeText(texto);
    toast('Lista copiada al portapapeles', 'success');
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Lista copiada al portapapeles', 'success');
    } catch (err2) {
      toast('No se pudo copiar la lista', 'error');
    }
  }
}

/* ============================================================
   Eventos — delegación en el container (se bindea UNA vez)
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) {
    // El shell se re-montó (ej. logout→login): soltar el container viejo.
    S.boundEl.removeEventListener('click', onClick);
    S.boundEl.removeEventListener('submit', onSubmit);
    S.boundEl.removeEventListener('change', onChange);
    S.boundEl.removeEventListener('input', onInput);
    S.boundEl.removeEventListener('keydown', onKeydown);
  }
  S.container.addEventListener('click', onClick);
  S.container.addEventListener('submit', onSubmit);
  S.container.addEventListener('change', onChange);
  S.container.addEventListener('input', onInput);
  S.container.addEventListener('keydown', onKeydown);
  // Escape va en document: tras un paint() el foco cae a <body>, fuera del
  // container, y el listener delegado no lo vería. Ref estable → no se duplica.
  document.addEventListener('keydown', onEscape);
  S.boundEl = S.container;
}

function onEscape(e) {
  if (e.key !== 'Escape') return;
  if (!S.container || !S.container.isConnected) return;
  if (S.plantillaModal) { S.plantillaModal = null; paint(); }
  else if (S.comboPicker) { S.comboPicker = null; paint(); }
  else if (S.picker) { S.picker = null; paint(); }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.nut')) return;
  const a = el.dataset.action;

  if (a === 'tab') {
    S.tab = el.dataset.tab; S.picker = null; S.comboPicker = null; S.plantillaModal = null;
    // Al volver a Hoy después de navegar semanas: reenganchar el plan a la
    // semana del día visible para que el chip "Planificado" resuelva bien.
    if (S.tab === 'hoy' && lunesDe(S.fecha) !== S.semana) {
      S.semana = lunesDe(S.fecha);
      cargarPlan().then(ok => { if (ok) paint(); }).catch(() => {});
    }
    paint(); return;
  }

  if (a === 'dia-prev') { cambiarDia(addDias(S.fecha, -1)); return; }
  if (a === 'dia-next') { cambiarDia(addDias(S.fecha, 1)); return; }
  if (a === 'dia-hoy') { cambiarDia(hoyStr()); return; }

  if (a === 'abrir-picker') { S.picker = { slot: el.dataset.slot, tab: 'favoritos' }; S.busca = ''; S.escala = 1; paint(); return; }
  if (a === 'cerrar-picker') { S.picker = null; paint(); return; }
  if (a === 'picker-tab') { if (S.picker) { S.picker.tab = el.dataset.ptab; S.busca = ''; paint(); } return; }
  if (a === 'escala') { S.escala = Number(el.dataset.f) || 1; paint(); return; }

  if (a === 'add-alimento') { addAlimento(el.dataset.id); return; }
  if (a === 'add-combo') { addCombo(el.dataset.id); return; }
  if (a === 'fav') { toggleFav(el.dataset.tipo, el.dataset.id); return; }
  if (a === 'del-log') { borrarEntrada(el.dataset.id); return; }

  if (a === 'sem-prev') { cambiarSemana(addDias(S.semana, -7)); return; }
  if (a === 'sem-next') { cambiarSemana(addDias(S.semana, 7)); return; }
  if (a === 'sem-hoy') { cambiarSemana(lunesDe(hoyStr())); return; }

  if (a === 'celda') {
    const p = planDe(el.dataset.fecha, el.dataset.slot);
    S.comboPicker = { fecha: el.dataset.fecha, slot: el.dataset.slot, tab: p && p.alimento_id ? 'alimentos' : 'combos' };
    paint(); return;
  }
  if (a === 'modal-cerrar') { S.comboPicker = null; paint(); return; }
  if (a === 'modal-fondo') { if (e.target === el) { S.comboPicker = null; paint(); } return; }
  if (a === 'plan-tab') { if (S.comboPicker) { S.comboPicker.tab = el.dataset.ptab; paint(); } return; }
  if (a === 'plan-asignar') { asignarCombo(el.dataset.id); return; }
  if (a === 'plan-asignar-alimento') { asignarAlimento(el.dataset.id); return; }
  if (a === 'plan-quitar') { quitarPlan(); return; }
  if (a === 'anotar-plan') { anotarPlanificado(el.dataset.slot); return; }

  if (a === 'abrir-plantillas') { S.plantillaModal = { fecha: el.dataset.fecha }; paint(); return; }
  if (a === 'plantilla-cerrar') { S.plantillaModal = null; paint(); return; }
  if (a === 'plantilla-fondo') { if (e.target === el) { S.plantillaModal = null; paint(); } return; }
  if (a === 'plantilla-aplicar') { aplicarPlantilla(el.dataset.id); return; }
  if (a === 'plantilla-borrar') { borrarPlantilla(el.dataset.id); return; }

  if (a === 'copiar') { copiarLista(); return; }
  if (a === 'ir-semana') { S.tab = 'semana'; paint(); return; }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form || !form.closest('.nut')) return;
  if (form.dataset.action === 'guardar-plantilla') {
    e.preventDefault();
    const nombre = String(new FormData(form).get('nombre') || '').trim();
    if (!nombre) { toast('Poné un nombre para la plantilla', 'warning'); return; }
    guardarPlantilla(nombre);
    return;
  }
  if (form.dataset.action !== 'manual') return;
  e.preventDefault();
  if (!S.picker) return;
  const fd = new FormData(form);
  const nombre = String(fd.get('nombre') || '').trim();
  if (!nombre) { toast('Poné un nombre para la comida', 'warning'); return; }
  agregarEntrada(S.picker.slot, {
    tipo: 'custom', id: null, nombre,
    prot: Number(fd.get('prot')) || 0,
    carbo: Number(fd.get('carbo')) || 0,
    grasa: Number(fd.get('grasa')) || 0,
    kcal: Number(fd.get('kcal')) || 0,
  });
}

function onChange(e) {
  const cb = e.target.closest('input[data-action="compra"]');
  if (!cb || !cb.closest('.nut')) return;
  setCompra(cb.dataset.key, cb.checked);
  const fila = cb.closest('.nut-compra');
  if (fila) fila.classList.toggle('nut-comprado', cb.checked);
  const conteo = document.getElementById('nutComprasCount');
  if (conteo) conteo.textContent = textoConteoCompras();
}

function onInput(e) {
  const inp = e.target.closest('input[data-action="buscar"]');
  if (!inp || !inp.closest('.nut')) return;
  S.busca = inp.value;
  const lista = document.getElementById('nutPickerLista');
  if (lista) lista.innerHTML = listaAlimentosHTML();
}

function onKeydown(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('.nut-item[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
}

/* ============================================================
   Vistas — el DOM del módulo se reconstruye entero en cada paint()
   ============================================================ */
function paint() {
  if (!S.container) return;
  const tabs = [['hoy', 'Hoy'], ['semana', 'Semana'], ['prep', 'Prep'], ['compras', 'Compras']];
  let vista;
  if (S.tab === 'semana') vista = vistaSemana();
  else if (S.tab === 'prep') vista = vistaPrep();
  else if (S.tab === 'compras') vista = vistaCompras();
  else vista = vistaHoy();
  S.container.innerHTML = `
  <div class="nut">
    <header class="nut-head rise">
      <div class="nut-head-fila">
        <h2 class="nut-titulo">Nutrición</h2>
        ${chipAyuno()}
      </div>
      <nav class="nut-tabs" role="tablist">
        ${tabs.map(([id, lbl]) => `
        <button class="nut-tab${S.tab === id ? ' activa' : ''}" role="tab"
          aria-selected="${S.tab === id}" data-action="tab" data-tab="${id}">${lbl}</button>`).join('')}
      </nav>
    </header>
    <div class="nut-cuerpo">${vista}</div>
    ${S.comboPicker ? modalCombos() : ''}
    ${S.plantillaModal ? modalPlantillas() : ''}
  </div>`;
  animar();
}

// Dispara el motor de movimiento tras cada paint (mismo patrón que home.js):
// anillos SVG, count-ups, entrada escalonada y tilt magnético.
function animar() {
  const root = S.container;
  if (!root) return;
  root.querySelectorAll('.v-ring-fill').forEach(c => ring(c, +c.getAttribute('data-pct') || 0));
  root.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    const decimals = +el.getAttribute('data-dec') || 0;
    countUp(el, to, { suffix, decimals });
  });
  stagger(root.querySelectorAll('.rise'));
  tiltAll(root);
}

// Chip de ayuno EN VIVO (Cal AI §7): contador + micro-arco en el header.
function chipAyuno() {
  const ay = estadoAyuno();
  if (!ay) return '';
  const R = 9, C = 2 * Math.PI * R, off = C * (1 - ay.pct / 100);
  const col = ay.ayunando ? 'var(--accent)' : 'var(--accent-2)';
  return `
  <span class="nut-ayuno${ay.ayunando ? ' nut-ayuno-on' : ''}" title="Ventana de ayuno ${esc(ay.ventana)}">
    <svg class="nut-ayuno-arco" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle class="v-ring-track" cx="11" cy="11" r="${R}" style="stroke-width:2.5"></circle>
      <circle cx="11" cy="11" r="${R}" style="stroke-width:2.5;fill:none;stroke:${col};stroke-linecap:round;stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${off.toFixed(1)};transform:rotate(-90deg);transform-origin:center"></circle>
    </svg>
    <span class="nut-ayuno-txt"><strong>${esc(ay.texto)}</strong><span class="nut-ayuno-sub">${esc(ay.sub)}</span></span>
  </span>`;
}

function vacioConfig() {
  return `
  <div class="nut-vacio rise">
    <div class="nut-vacio-icono">⚙️</div>
    <p>No hay slots de comida configurados.</p>
    <p class="nut-vacio-sub">Corré el seed (sql/02_seed_nutricion.sql) o cargá la clave «slots» del módulo nutricion en user_config.</p>
  </div>`;
}

function vacioPlan() {
  return `
  <div class="nut-vacio rise">
    <div class="nut-vacio-icono">🗓️</div>
    <p>Todavía no planificaste esta semana.</p>
    <p class="nut-vacio-sub">Asigná combos o alimentos a los días (o aplicá una plantilla de día) y de ahí salen el prep y las compras solos.</p>
    <button class="nut-btn-primario" data-action="ir-semana">Andá a Semana</button>
  </div>`;
}

/* ---------- Tab HOY ---------- */
function vistaHoy() {
  const slots = cfgSlots();
  const esHoy = S.fecha === hoyStr();
  const nav = `
  <div class="nut-fechanav rise">
    <button class="nut-nav-btn lively" data-action="dia-prev" aria-label="Día anterior">‹</button>
    <div class="nut-fechanav-centro">
      <div class="nut-fechanav-label">${labelFecha(S.fecha)}</div>
      ${esHoy ? '' : `<button class="nut-chip" data-action="dia-hoy">Volver a hoy</button>`}
    </div>
    <button class="nut-nav-btn lively" data-action="dia-next" aria-label="Día siguiente">›</button>
  </div>`;
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando el día…</div>`;
  if (!slots.length) return nav + vacioConfig();
  return nav + resumenDia() + slots.map(seccionSlot).join('');
}

/* ---------- Sparkline de proteína 7 días (mini SVG de barras) ---------- */
function sparklineHTML() {
  const serie = serie7();
  const max = Math.max(cfgTarget().target || 0, ...serie.map(d => d.prot), 1);
  const W = 168, H = 40, n = serie.length;
  const gap = 5, bw = (W - gap * (n - 1)) / n;
  const barras = serie.map((d, i) => {
    const h = Math.max(2, (d.prot / max) * H);
    const x = i * (bw + gap);
    const y = H - h;
    const col = d.esHoy ? 'var(--accent)' : 'var(--border-strong)';
    const dd = parseFecha(d.fecha).getDate();
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${col}"${d.esHoy ? ' class="nut-spark-hoy"' : ''}></rect>
      <text x="${(x + bw / 2).toFixed(1)}" y="${H + 9}" class="nut-spark-lbl" text-anchor="middle">${dd}</text>`;
  }).join('');
  const prom = serie.reduce((s, d) => s + d.prot, 0) / n;
  return `
  <div class="nut-spark rise">
    <div class="nut-spark-cab">
      <span class="nut-cap">Proteína · últimos 7 días</span>
      <span class="nut-spark-prom">prom <span class="nut-num">${num(prom)}</span> g</span>
    </div>
    <svg class="nut-spark-svg" viewBox="0 0 ${W} ${H + 12}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Proteína de los últimos 7 días">
      ${barras}
    </svg>
  </div>`;
}

/* ---------- Anillo mini de macro secundario (carbo/grasa/kcal) ---------- */
function macroRing(valor, ref, label, unidad, color) {
  const pct = ref > 0 ? Math.min(100, (valor / ref) * 100) : 0;
  return `
  <div class="nut-mring">
    <div class="nut-mring-fig">
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle class="v-ring-track" cx="26" cy="26" r="21" style="stroke-width:5"></circle>
        <circle class="v-ring-fill" cx="26" cy="26" r="21" style="stroke-width:5;stroke:${color}" data-pct="${pct}"></circle>
      </svg>
      <span class="nut-mring-v nut-num" data-count="${Math.round(valor)}">0</span>
    </div>
    <span class="nut-mring-k">${esc(label)}<span class="nut-mring-u">${esc(unidad)}</span></span>
  </div>`;
}

function resumenDia() {
  const { target, piso } = cfgTarget();
  const tot = totalesDia();
  const cre = cfgCreatina();

  // ---- Anillo HÉROE: proteína del día vs target (Cal AI §7, pero proteína). ----
  const pct = target > 0 ? Math.min(100, (tot.prot / target) * 100) : 0;
  const zona = target > 0
    ? (tot.prot >= target ? 'ok' : (piso > 0 && tot.prot >= piso) ? 'medio' : 'bajo')
    : 'medio';
  // Framing sano (BACKLOG §7): rango/tendencia, sin límites rojos ni shaming.
  const restante = Math.max(0, target - tot.prot);
  let estado;
  if (!target) estado = 'Sin target configurado';
  else if (tot.prot >= target) estado = 'Target alcanzado';
  else if (piso > 0 && tot.prot >= piso) estado = 'En zona · sobre el piso';
  else estado = `Vas sumando · faltan ${num(restante)} g`;

  const hero = `
  <div class="nut-hero">
    <div class="nut-hero-ring">
      <svg width="164" height="164" viewBox="0 0 164 164">
        <defs>
          <linearGradient id="nutHeroGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#35e0b2"></stop><stop offset="1" stop-color="#43d17c"></stop>
          </linearGradient>
        </defs>
        <circle class="v-ring-track" cx="82" cy="82" r="70" style="stroke-width:11"></circle>
        <circle class="v-ring-fill nut-hero-fill nut-hero-${zona}" cx="82" cy="82" r="70" style="stroke-width:11" data-pct="${pct}"></circle>
      </svg>
      <div class="nut-hero-centro">
        <span class="nut-hero-num nut-num" data-count="${Math.round(tot.prot)}">0</span>
        <span class="nut-hero-de">${target ? '/ ' + num(target) + ' g' : 'g proteína'}</span>
        <span class="heartbeat nut-hero-heart"></span>
      </div>
    </div>
    <div class="nut-hero-lado">
      <span class="nut-cap">Proteína de hoy</span>
      <div class="nut-hero-estado nut-zona-${zona}">${estado}</div>
      ${piso > 0 ? `<div class="nut-hero-piso">Piso saludable · <span class="nut-num">${num(piso)}</span> g</div>` : ''}
      ${cre ? `<div class="nut-creatina">💊 Creatina ${esc(cre.tipo || '')} · ${esc(cre.dosis_g || '')} g · ${esc(cre.frecuencia || '')}</div>` : ''}
    </div>
  </div>`;

  // ---- Anillos secundarios: carbo/grasa/kcal. La referencia del anillo se
  //      DERIVA del target de proteína del usuario (no hay valores hardcodeados:
  //      escala con su config). Son readouts orientativos, no límites — el
  //      número real siempre se muestra en el centro. Framing neutro (sin rojo).
  const base = target > 0 ? target : 160;
  const refCarbo = base * 2;      // heurística de referencia visual, no prescripción
  const refGrasa = base * 0.6;
  const refKcal = base * 13;
  const secundarios = `
  <div class="nut-mrings">
    ${macroRing(tot.carbo, refCarbo, 'Carbo', 'g', 'var(--accent-2)')}
    ${macroRing(tot.grasa, refGrasa, 'Grasa', 'g', 'var(--warn)')}
    ${macroRing(tot.kcal, refKcal, 'Kcal', '', 'var(--ok)')}
  </div>`;

  return sparklineHTML() + `
  <div class="nut-card nut-resumen rise lively" data-tilt>
    ${hero}
    ${secundarios}
  </div>`;
}

function hintCompensacion(slot, entradas) {
  const comp = cfgCompensacion();
  if (!comp || !comp.regla || comp.aplica_slot !== slot.id) return '';
  if (entradas.length) return '';
  if (S.fecha !== hoyStr()) return '';
  if (!slot.hora || horaAhora() <= slot.hora) return '';
  return `<div class="nut-hint">⚠️ ${esc(comp.regla)}</div>`;
}

function chipPlanificado(slot) {
  const item = itemPlanificado(S.fecha, slot.id);
  if (!item) return '';
  return `
  <div class="nut-plan-chip">
    <span class="nut-plan-chip-txt">📌 Planificado: <strong>${esc(item.nombre)}</strong></span>
    <button class="nut-plan-chip-btn" data-action="anotar-plan" data-slot="${esc(slot.id)}">Anotar</button>
  </div>`;
}

function seccionSlot(slot) {
  const entradas = entradasSlot(slot.id);
  const totProt = entradas.reduce((s, e) => s + (Number(e.prot) || 0), 0);
  const abierto = S.picker && S.picker.slot === slot.id;
  const chip = entradas.length ? '' : chipPlanificado(slot);
  return `
  <section class="nut-slot nut-card rise${abierto ? '' : ' lively'}"${abierto ? '' : ' data-tilt'}>
    <header class="nut-slot-head">
      <div>
        <h3 class="nut-slot-titulo">${esc(slot.label)}</h3>
        <div class="nut-slot-meta">${slot.hora ? esc(slot.hora) + ' h' : ''}${slot.nota ? (slot.hora ? ' · ' : '') + esc(slot.nota) : ''}</div>
      </div>
      ${entradas.length ? `<div class="nut-slot-prot"><span class="nut-num">${num(totProt)}</span> g prot</div>` : ''}
    </header>
    ${hintCompensacion(slot, entradas)}
    ${entradas.length ? entradas.map(filaEntrada).join('') : (chip || `<div class="nut-slot-vacio">Nada anotado todavía</div>`)}
    ${abierto ? pickerHTML(slot) : `<button class="nut-agregar" data-action="abrir-picker" data-slot="${esc(slot.id)}">+ Agregar comida</button>`}
  </section>`;
}

function filaEntrada(e) {
  return `
  <div class="nut-entrada">
    <div class="nut-entrada-info">
      <div class="nut-entrada-nombre">${esc(e.item_nombre)}</div>
      <div class="nut-entrada-macros"><span class="nut-num">${num(e.prot)}</span> g prot · ${num(e.kcal)} kcal</div>
    </div>
    <button class="nut-icono nut-borrar" data-action="del-log" data-id="${esc(e.id)}" aria-label="Borrar entrada" title="Borrar">✕</button>
  </div>`;
}

/* ---------- Picker de agregado ---------- */
function pickerHTML(slot) {
  const t = S.picker.tab;
  const tabs = [['favoritos', '⭐ Favoritos'], ['combos', 'Combos'], ['alimentos', 'Alimentos'], ['manual', 'Manual']];
  let cuerpo = '';
  if (t === 'combos') cuerpo = pickerCombos(slot);
  else if (t === 'alimentos') cuerpo = pickerAlimentos();
  else if (t === 'manual') cuerpo = pickerManual();
  else cuerpo = pickerFavoritos(slot);
  // Escala de porción (Cal AI §7) — en las pestañas de 1 tap, no en Manual.
  const escala = (t === 'manual') ? '' : escalaHTML();
  return `
  <div class="nut-picker">
    <div class="nut-picker-head">
      <div class="nut-picker-tabs">
        ${tabs.map(([id, lbl]) => `<button class="nut-ptab${t === id ? ' activa' : ''}" data-action="picker-tab" data-ptab="${id}">${lbl}</button>`).join('')}
      </div>
      <button class="nut-icono" data-action="cerrar-picker" aria-label="Cerrar picker">✕</button>
    </div>
    ${escala}
    ${cuerpo}
  </div>`;
}

// Botones de escala rápida: multiplican los macros al agregar, sin tipear.
function escalaHTML() {
  const opts = [[0.5, '½'], [0.75, '¾'], [1, '1×'], [1.25, '1¼'], [1.5, '1½'], [2, '2×']];
  return `
  <div class="nut-escala">
    <span class="nut-escala-lbl">Porción</span>
    <div class="nut-escala-btns">
      ${opts.map(([f, lbl]) => `<button class="nut-escala-b${S.escala === f ? ' activa' : ''}" data-action="escala" data-f="${f}">${lbl}</button>`).join('')}
    </div>
  </div>`;
}

// factor: multiplicador de porción vigente (1 salvo que el picker escale).
// Muestra el macro ESCALADO (lo que se va a guardar) para que el tap sea fiel.
function filaAlimento(a, factor = 1) {
  const f = Number(factor) || 1;
  const prot = (Number(a.prot) || 0) * f, kcal = (Number(a.kcal) || 0) * f;
  return `
  <div class="nut-item" data-action="add-alimento" data-id="${esc(a.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(a.nombre)}${a.porcion ? ` <span class="nut-item-porcion">${esc(a.porcion)}${f !== 1 ? ' ×' + num(f) : ''}</span>` : (f !== 1 ? ` <span class="nut-item-porcion">×${num(f)}</span>` : '')}</div>
      <div class="nut-item-macros"><span class="nut-num">${num(prot)}</span> g prot · ${num(kcal)} kcal</div>
    </div>
    <button class="nut-icono nut-star${a.favorito ? ' activa' : ''}" data-action="fav" data-tipo="alimento" data-id="${esc(a.id)}" aria-label="Marcar favorito">${a.favorito ? '★' : '☆'}</button>
  </div>`;
}

function filaCombo(c, factor = 1) {
  const f = Number(factor) || 1;
  const prot = (Number(c.prot) || 0) * f, kcal = (Number(c.kcal) || 0) * f;
  return `
  <div class="nut-item" data-action="add-combo" data-id="${esc(c.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(c.nombre)} <span class="nut-item-porcion">combo${c.slot ? ' · ' + esc(c.slot) : ''}${f !== 1 ? ' ×' + num(f) : ''}</span></div>
      <div class="nut-item-macros"><span class="nut-num">${num(prot)}</span> g prot · ${num(kcal)} kcal</div>
    </div>
    <button class="nut-icono nut-star${c.favorito ? ' activa' : ''}" data-action="fav" data-tipo="combo" data-id="${esc(c.id)}" aria-label="Marcar favorito">${c.favorito ? '★' : '☆'}</button>
  </div>`;
}

function pickerFavoritos(slot) {
  const f = S.escala;
  const favs = [
    ...combosOrdenados(slot.id).filter(c => c.favorito).map(c => filaCombo(c, f)),
    ...S.alimentos.filter(a => a.favorito).map(a => filaAlimento(a, f)),
  ];
  if (!favs.length) return `<div class="nut-picker-vacio">Todavía no tenés favoritos.<br>Marcá con ☆ tus alimentos y combos más usados en las otras pestañas.</div>`;
  return `<div class="nut-picker-lista">${favs.join('')}</div>`;
}

function pickerCombos(slot) {
  if (!S.combos.length) return `<div class="nut-picker-vacio">No hay combos cargados. Corré el seed (sql/02_seed_nutricion.sql).</div>`;
  return `<div class="nut-picker-lista">${combosOrdenados(slot.id).map(c => filaCombo(c, S.escala)).join('')}</div>`;
}

function pickerAlimentos() {
  return `
  <input class="nut-input nut-buscador" data-action="buscar" placeholder="Buscar alimento…" value="${esc(S.busca)}" autocomplete="off" aria-label="Buscar alimento">
  <div class="nut-picker-lista" id="nutPickerLista">${listaAlimentosHTML()}</div>`;
}

function listaAlimentosHTML() {
  const q = S.busca.trim().toLowerCase();
  const items = S.alimentos
    .filter(a => !q || String(a.nombre).toLowerCase().includes(q))
    .sort((a, b) =>
      ((b.favorito === true) - (a.favorito === true)) ||
      ((b.es_ancla === true) - (a.es_ancla === true)) ||
      String(a.nombre).localeCompare(String(b.nombre)));
  if (!items.length) {
    return `<div class="nut-picker-vacio">${S.alimentos.length
      ? 'No encontré nada con esa búsqueda.'
      : 'No hay alimentos cargados. Corré el seed (sql/02_seed_nutricion.sql).'}</div>`;
  }
  return items.map(a => filaAlimento(a, S.escala)).join('');
}

function pickerManual() {
  return `
  <form class="nut-manual" data-action="manual">
    <input class="nut-input" name="nombre" placeholder="¿Qué comiste?" required maxlength="120" autocomplete="off">
    <div class="nut-manual-grid">
      <label class="nut-manual-campo">Prot (g)<input class="nut-input" name="prot" type="number" step="0.1" min="0" inputmode="decimal" placeholder="0"></label>
      <label class="nut-manual-campo">Carbo (g)<input class="nut-input" name="carbo" type="number" step="0.1" min="0" inputmode="decimal" placeholder="0"></label>
      <label class="nut-manual-campo">Grasa (g)<input class="nut-input" name="grasa" type="number" step="0.1" min="0" inputmode="decimal" placeholder="0"></label>
      <label class="nut-manual-campo">Kcal<input class="nut-input" name="kcal" type="number" step="1" min="0" inputmode="decimal" placeholder="0"></label>
    </div>
    <button type="submit" class="nut-btn-primario">Anotar</button>
  </form>`;
}

/* ---------- Tab SEMANA ---------- */
function navSemana() {
  const esActual = S.semana === lunesDe(hoyStr());
  return `
  <div class="nut-fechanav rise">
    <button class="nut-nav-btn lively" data-action="sem-prev" aria-label="Semana anterior">‹</button>
    <div class="nut-fechanav-centro">
      <div class="nut-fechanav-label">Semana del ${labelCorto(S.semana)} al ${labelCorto(addDias(S.semana, 6))}</div>
      ${esActual ? '' : `<button class="nut-chip" data-action="sem-hoy">Esta semana</button>`}
    </div>
    <button class="nut-nav-btn lively" data-action="sem-next" aria-label="Semana siguiente">›</button>
  </div>`;
}

function vistaSemana() {
  const slots = cfgSlots();
  const nav = navSemana();
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando la semana…</div>`;
  if (!slots.length) return nav + vacioConfig();
  const aviso = (S.combos.length || S.alimentos.length) ? '' : `<div class="nut-hint">No hay combos ni alimentos cargados: corré el seed (sql/02_seed_nutricion.sql) para poder planificar.</div>`;
  const fechas = Array.from({ length: 7 }, (_, i) => addDias(S.semana, i));
  return nav + aviso + `<div class="nut-sem-grid">${fechas.map(f => diaCard(f, slots)).join('')}</div>`;
}

function diaCard(fecha, slots) {
  const esHoy = fecha === hoyStr();
  return `
  <div class="nut-sem-dia rise${esHoy ? ' nut-sem-hoy' : ''}">
    <div class="nut-sem-dia-head">${DIAS[diaIdx(fecha)]}<span class="nut-sem-fecha">${labelCorto(fecha)}</span></div>
    ${slots.map(sl => {
      const p = planDe(fecha, sl.id);
      const combo = p && p.combo_id ? S.combos.find(c => c.id === p.combo_id) : null;
      const alimento = p && p.alimento_id ? S.alimentos.find(a => a.id === p.alimento_id) : null;
      let contenido;
      if (combo) {
        contenido = `<span class="nut-celda-combo">${esc(combo.nombre)}</span><span class="nut-celda-prot"><span class="nut-num">${num(combo.prot)}</span> g prot</span>`;
      } else if (alimento) {
        contenido = `<span class="nut-celda-combo">${esc(alimento.nombre)}${alimento.porcion ? ` <span class="nut-celda-porcion">${esc(alimento.porcion)}</span>` : ''}</span><span class="nut-celda-prot"><span class="nut-num">${num(alimento.prot)}</span> g prot</span>`;
      } else if (p) {
        contenido = `<span class="nut-celda-mas">${p.alimento_id ? 'alimento' : 'combo'} no disponible</span>`;
      } else {
        contenido = `<span class="nut-celda-mas">+ asignar</span>`;
      }
      return `
      <button class="nut-celda${(combo || alimento) ? ' nut-celda-llena' : ''}" data-action="celda" data-fecha="${fecha}" data-slot="${esc(sl.id)}">
        <span class="nut-celda-slot">${esc(sl.label)}</span>
        ${contenido}
      </button>`;
    }).join('')}
    <button class="nut-dia-plantilla" data-action="abrir-plantillas" data-fecha="${fecha}">📋 Plantilla</button>
  </div>`;
}

function modalCombos() {
  const ctx = S.comboPicker;
  const slot = cfgSlots().find(s => s.id === ctx.slot);
  const actual = planDe(ctx.fecha, ctx.slot);
  const t = ctx.tab === 'alimentos' ? 'alimentos' : 'combos';
  let cuerpo;
  if (t === 'alimentos') {
    cuerpo = S.alimentos.length
      ? S.alimentos.map(a => filaAlimentoPlan(a, actual)).join('')
      : `<div class="nut-picker-vacio">No hay alimentos cargados. Corré el seed (sql/02_seed_nutricion.sql).</div>`;
  } else {
    const delSlot = S.combos.filter(c => c.slot === ctx.slot);
    const otros = S.combos.filter(c => c.slot !== ctx.slot);
    cuerpo = `
        ${!S.combos.length ? `<div class="nut-picker-vacio">No hay combos cargados. Corré el seed (sql/02_seed_nutricion.sql).</div>` : ''}
        ${delSlot.length ? `<div class="nut-modal-grupo">Combos de ${esc(slot ? slot.label.toLowerCase() : ctx.slot)}</div>${delSlot.map(c => filaComboPlan(c, actual)).join('')}` : ''}
        ${otros.length ? `<div class="nut-modal-grupo">Otros combos</div>${otros.map(c => filaComboPlan(c, actual)).join('')}` : ''}`;
  }
  return `
  <div class="nut-modal" data-action="modal-fondo">
    <div class="nut-modal-card" role="dialog" aria-modal="true" aria-label="Asignar al plan">
      <header class="nut-modal-head">
        <h3 class="nut-modal-titulo">${esc(slot ? slot.label : ctx.slot)} · ${labelFecha(ctx.fecha)}</h3>
        <button class="nut-icono" data-action="modal-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <div class="nut-picker-tabs nut-modal-tabs">
        <button class="nut-ptab${t === 'combos' ? ' activa' : ''}" data-action="plan-tab" data-ptab="combos">Combos</button>
        <button class="nut-ptab${t === 'alimentos' ? ' activa' : ''}" data-action="plan-tab" data-ptab="alimentos">Alimentos</button>
      </div>
      <div class="nut-modal-body">${cuerpo}</div>
      ${actual ? `<button class="nut-btn-peligro" data-action="plan-quitar">Quitar del plan</button>` : ''}
    </div>
  </div>`;
}

function filaComboPlan(c, actual) {
  const activo = actual && actual.combo_id === c.id;
  return `
  <div class="nut-item${activo ? ' nut-item-activo' : ''}" data-action="plan-asignar" data-id="${esc(c.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(c.nombre)}${activo ? ' ✓' : ''}</div>
      <div class="nut-item-macros"><span class="nut-num">${num(c.prot)}</span> g prot · ${num(c.kcal)} kcal</div>
    </div>
  </div>`;
}

function filaAlimentoPlan(a, actual) {
  const activo = actual && actual.alimento_id === a.id;
  return `
  <div class="nut-item${activo ? ' nut-item-activo' : ''}" data-action="plan-asignar-alimento" data-id="${esc(a.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(a.nombre)}${a.porcion ? ` <span class="nut-item-porcion">${esc(a.porcion)}</span>` : ''}${activo ? ' ✓' : ''}</div>
      <div class="nut-item-macros"><span class="nut-num">${num(a.prot)}</span> g prot · ${num(a.kcal)} kcal</div>
    </div>
  </div>`;
}

/* ---------- Modal de plantillas de día ---------- */
function nombreItemPlantilla(it) {
  if (it.tipo === 'combo') {
    const c = S.combos.find(x => x.id === it.item_id);
    return c ? c.nombre : 'no disponible';
  }
  const a = S.alimentos.find(x => x.id === it.item_id);
  return a ? (a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre) : 'no disponible';
}

function filaPlantilla(pl) {
  const slots = cfgSlots();
  const items = Array.isArray(pl.items) ? pl.items : [];
  const partes = items.map(it => {
    const sl = slots.find(s => s.id === it.slot);
    return (sl ? sl.label : it.slot) + ': ' + nombreItemPlantilla(it);
  });
  return `
  <div class="nut-item" data-action="plantilla-aplicar" data-id="${esc(pl.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(pl.nombre)}</div>
      <div class="nut-item-macros">${partes.length ? esc(partes.join(' · ')) : 'Sin items'}</div>
    </div>
    <button class="nut-icono nut-borrar" data-action="plantilla-borrar" data-id="${esc(pl.id)}" aria-label="Borrar plantilla" title="Borrar plantilla">🗑</button>
  </div>`;
}

function modalPlantillas() {
  const ctx = S.plantillaModal;
  const items = itemsDelDia(ctx.fecha);
  let lista;
  if (S.diasTipo.length) {
    lista = `<div class="nut-modal-grupo">Tap para aplicar al día (los slots que la plantilla no cubre quedan como están)</div>`
      + S.diasTipo.map(filaPlantilla).join('');
  } else {
    lista = `<div class="nut-picker-vacio">Todavía no tenés plantillas de día.<br>${items.length
      ? 'Guardá este día con el formulario de abajo y después aplicala a cualquier otro día en 1 tap.'
      : 'Armá un día asignando combos o alimentos a sus slots y guardalo como plantilla desde acá.'}</div>`;
  }
  return `
  <div class="nut-modal" data-action="plantilla-fondo">
    <div class="nut-modal-card" role="dialog" aria-modal="true" aria-label="Plantillas de día">
      <header class="nut-modal-head">
        <h3 class="nut-modal-titulo">📋 Plantillas · ${labelFecha(ctx.fecha)}</h3>
        <button class="nut-icono" data-action="plantilla-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <div class="nut-modal-body">
        ${lista}
        ${items.length ? `
        <div class="nut-modal-grupo">Guardar este día como plantilla</div>
        <form class="nut-plantilla-form" data-action="guardar-plantilla">
          <input class="nut-input" name="nombre" placeholder="Nombre de la plantilla" required maxlength="80" autocomplete="off" aria-label="Nombre de la plantilla">
          <button type="submit" class="nut-btn-primario">Guardar</button>
        </form>` : ''}
      </div>
    </div>
  </div>`;
}

/* ---------- Tab PREP ---------- */
function vistaPrep() {
  const nav = navSemana();
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando la semana…</div>`;
  const { combos, ingredientes } = resumenSemana();
  if (!combos.length && !ingredientes.length) return nav + vacioPlan();
  return nav + `
  <div class="nut-prep">
    ${combos.length ? `
    <section class="nut-card rise lively" data-tilt>
      <h3 class="nut-card-titulo">🍳 A cocinar esta semana</h3>
      ${combos.map(({ combo, veces }) => `
      <div class="nut-prep-fila">
        <div class="nut-prep-nombre">${esc(combo.nombre)}${combo.slot ? ` <span class="nut-item-porcion">${esc(combo.slot)}</span>` : ''}</div>
        <div class="nut-prep-veces">× ${veces}</div>
      </div>`).join('')}
    </section>` : ''}
    <section class="nut-card rise lively" data-tilt>
      <h3 class="nut-card-titulo">🧺 Ingredientes para el batch</h3>
      ${ingredientes.length ? ingredientes.map(i => `
      <div class="nut-prep-fila">
        <div class="nut-prep-nombre">${esc(i.nombre)}</div>
        <div class="nut-prep-cant"><span class="nut-num">${num(i.cantidad)}</span> ${esc(i.unidad)}</div>
      </div>`).join('') : `<div class="nut-picker-vacio">Los combos planificados no tienen ingredientes cargados.</div>`}
    </section>
  </div>`;
}

/* ---------- Tab COMPRAS ---------- */
function vistaCompras() {
  const nav = navSemana();
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando la semana…</div>`;
  const { ingredientes } = resumenSemana();
  if (!ingredientes.length) return nav + vacioPlan();
  const estado = comprasEstado();
  return nav + `
  <div class="nut-card nut-compras rise">
    <header class="nut-compras-head">
      <div>
        <h3 class="nut-card-titulo">🛒 Lista de compras</h3>
        <div class="nut-compras-conteo" id="nutComprasCount">${textoConteoCompras()}</div>
      </div>
      <button class="nut-btn-primario" data-action="copiar">📋 Copiar lista</button>
    </header>
    ${ingredientes.map(i => {
      const key = claveIngrediente(i);
      const marcado = !!estado[key];
      return `
      <label class="nut-compra${marcado ? ' nut-comprado' : ''}">
        <input type="checkbox" class="nut-check" data-action="compra" data-key="${esc(key)}"${marcado ? ' checked' : ''}>
        <span class="nut-compra-nombre">${esc(i.nombre)}</span>
        <span class="nut-compra-cant"><span class="nut-num">${num(i.cantidad)}</span> ${esc(i.unidad)}</span>
      </label>`;
    }).join('')}
  </div>`;
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo nut-, solo var(--token)
   ============================================================ */
const CSS = `
.nut { max-width: 920px; margin: 0 auto; padding: var(--space-4); font-family: var(--font-ui); color: var(--text); }
.nut * { box-sizing: border-box; }
.nut button { font: inherit; color: inherit; cursor: pointer; }
.nut button:focus-visible, .nut input:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.nut-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.nut-cap { font-size: .68rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

/* Header + tabs */
.nut-head { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.nut-head-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.nut-titulo { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: 1.35rem; letter-spacing: -.01em; }

/* Chip de ayuno EN VIVO (contador + micro-arco) */
.nut-ayuno { display: inline-flex; align-items: center; gap: var(--space-2); font-size: .75rem; color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 5px var(--space-3) 5px 6px; white-space: nowrap; }
.nut-ayuno-on { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: linear-gradient(90deg, var(--accent-soft), var(--surface)); }
.nut-ayuno-arco { flex: none; }
.nut-ayuno-txt { display: flex; flex-direction: column; line-height: 1.15; }
.nut-ayuno-txt strong { color: var(--text); font-weight: 700; }
.nut-ayuno-sub { font-size: .66rem; color: var(--text-faint); }
.nut-ayuno-on .nut-ayuno-sub { color: var(--accent); }

.nut-tabs { display: flex; gap: var(--space-2); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.nut-tab { flex: 1 1 0; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); white-space: nowrap; transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease, transform var(--dur) var(--ease-out-expo); }
.nut-tab:hover { transform: translateY(-1px); }
.nut-tab.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 700; }

/* Navegación fecha / semana */
.nut-fechanav { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.nut-nav-btn { width: 48px; min-height: 48px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 1.4rem; line-height: 1; color: var(--text-dim); }
.nut-nav-btn:active { background: var(--surface-2); }
.nut-fechanav-centro { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); min-width: 0; }
.nut-fechanav-label { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; text-align: center; }
.nut-chip { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: var(--space-1) var(--space-3); font-size: .78rem; min-height: 28px; }

/* Cards */
.nut-card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--shadow-1); overflow: hidden; }
.nut-card-titulo { margin: 0 0 var(--space-3); font-family: var(--font-display); font-weight: 700; font-size: 1rem; }

/* ---- Zonas de color (framing sano: verde/turquesa dominan; nunca rojo duro) ---- */
.nut-zona-ok { color: var(--ok); }
.nut-zona-medio { color: var(--accent); }
.nut-zona-bajo { color: var(--text-dim); }

/* ---- Sparkline de proteína 7 días ---- */
.nut-spark { padding: var(--space-4); margin-bottom: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
.nut-spark-cab { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
.nut-spark-prom { font-size: .74rem; color: var(--text-dim); }
.nut-spark-svg { width: 100%; max-width: 340px; height: 56px; display: block; overflow: visible; }
.nut-spark-lbl { fill: var(--text-faint); font-size: 7px; font-family: var(--font-num); }
.nut-spark-hoy { filter: drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 55%, transparent)); }

/* ---- Resumen / hero de proteína ---- */
.nut-resumen { background: linear-gradient(135deg, rgba(53,224,178,.06), rgba(67,209,124,.04)), var(--surface); border-color: var(--border-strong); }
.nut-resumen::before { content: ""; position: absolute; width: 300px; height: 300px; right: -90px; top: -150px; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, rgba(53,224,178,.10), transparent 65%); animation: vida-breathe 5s ease-in-out infinite; }
.nut-hero { position: relative; display: flex; align-items: center; gap: clamp(16px, 4vw, 30px); }
.nut-hero-ring { position: relative; width: 164px; height: 164px; flex: none; }
.nut-hero-ring svg { width: 164px; height: 164px; transform: rotate(-90deg); }
.nut-hero-fill { stroke: url(#nutHeroGrad); }
.nut-hero-medio { stroke: var(--accent); }
.nut-hero-bajo { stroke: var(--text-faint); }
.nut-hero-centro { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
.nut-hero-num { font-weight: 800; font-size: 2.7rem; line-height: 1; color: var(--text); }
.nut-hero-de { font-size: .8rem; color: var(--text-dim); font-family: var(--font-num); }
.nut-hero-heart { width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px 2px rgba(53,224,178,.6); }
.nut-hero-lado { min-width: 0; flex: 1; }
.nut-hero-estado { margin-top: 6px; font-size: 1.02rem; font-weight: 700; }
.nut-hero-piso { margin-top: 4px; font-size: .78rem; color: var(--text-faint); }

/* ---- Anillos secundarios de macros ---- */
.nut-mrings { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.nut-mring { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.nut-mring-fig { position: relative; width: 52px; height: 52px; }
.nut-mring-fig svg { width: 52px; height: 52px; transform: rotate(-90deg); }
.nut-mring-v { position: absolute; inset: 0; display: grid; place-items: center; font-size: .82rem; font-weight: 700; color: var(--text); }
.nut-mring-k { font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--text-dim); display: flex; align-items: baseline; gap: 3px; }
.nut-mring-u { font-size: .58rem; color: var(--text-faint); }
.nut-creatina { margin-top: var(--space-3); font-size: .8rem; color: var(--text-dim); }

/* Slots del día */
.nut-slot-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.nut-slot-titulo { margin: 0; font-family: var(--font-display); font-size: 1.05rem; }
.nut-slot-meta { font-size: .78rem; color: var(--text-faint); margin-top: 2px; }
.nut-slot-prot { font-size: .85rem; color: var(--accent); white-space: nowrap; }
.nut-slot-vacio { padding: var(--space-3) 0; font-size: .85rem; color: var(--text-faint); }
.nut-entrada { display: flex; align-items: center; gap: var(--space-3); min-height: 52px; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.nut-entrada:last-of-type { border-bottom: none; }
.nut-entrada-info { flex: 1; min-width: 0; }
.nut-entrada-nombre { font-size: .92rem; overflow-wrap: anywhere; }
.nut-entrada-macros { font-size: .78rem; color: var(--text-dim); margin-top: 2px; }
.nut-icono { width: 44px; min-height: 44px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-size: 1rem; }
.nut-borrar:hover, .nut-borrar:active { color: var(--danger); background: var(--surface-2); }
.nut-agregar { width: 100%; min-height: 48px; margin-top: var(--space-2); background: transparent; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--accent); font-weight: 600; transition: background .15s, border-color .15s; }
.nut-agregar:hover, .nut-agregar:active { background: var(--accent-soft); border-color: var(--accent); }
.nut-hint { margin-bottom: var(--space-3); padding: var(--space-3); background: var(--surface-2); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); font-size: .82rem; color: var(--text-dim); }

/* Picker */
.nut-picker { margin-top: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); }
.nut-picker-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }

/* Escala rápida de porción (Cal AI) */
.nut-escala { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.nut-escala-lbl { font-size: .66rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); flex: none; }
.nut-escala-btns { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.nut-escala-b { flex: 1 1 0; min-width: 40px; min-height: 34px; padding: 4px 6px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-dim); font-size: .82rem; font-weight: 700; font-family: var(--font-num); transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease, transform var(--dur) var(--ease-out-expo); }
.nut-escala-b:hover { transform: translateY(-1px); color: var(--text); }
.nut-escala-b.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.nut-picker-tabs { flex: 1; display: flex; gap: var(--space-1); overflow-x: auto; }
.nut-ptab { min-height: 38px; padding: var(--space-1) var(--space-3); background: transparent; border: 1px solid transparent; border-radius: 999px; color: var(--text-dim); font-size: .82rem; white-space: nowrap; }
.nut-ptab.activa { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.nut-picker-lista { max-height: 320px; overflow-y: auto; }
.nut-item { display: flex; align-items: center; gap: var(--space-2); min-height: 52px; padding: var(--space-2); border-radius: var(--radius); transition: background .12s; cursor: pointer; }
.nut-item:hover, .nut-item:focus-visible { background: var(--surface); }
.nut-item-activo { background: var(--accent-soft); }
.nut-item-info { flex: 1; min-width: 0; }
.nut-item-nombre { font-size: .9rem; overflow-wrap: anywhere; }
.nut-item-porcion { font-size: .74rem; color: var(--text-faint); }
.nut-item-macros { font-size: .76rem; color: var(--text-dim); margin-top: 2px; }
.nut-star { font-size: 1.15rem; }
.nut-star.activa { color: var(--warn); }
.nut-picker-vacio { padding: var(--space-4); text-align: center; font-size: .84rem; color: var(--text-faint); }
.nut-buscador { margin-bottom: var(--space-2); }
.nut-input { width: 100%; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font: inherit; }
.nut-input:focus { border-color: var(--accent); outline: none; }
.nut-manual { display: flex; flex-direction: column; gap: var(--space-3); }
.nut-manual-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-2); }
.nut-manual-campo { display: flex; flex-direction: column; gap: var(--space-1); font-size: .76rem; color: var(--text-dim); }
.nut-btn-primario { min-height: 48px; padding: var(--space-2) var(--space-4); background: var(--accent); border: none; border-radius: var(--radius); color: var(--bg); font-weight: 700; transition: opacity .15s; }
.nut-btn-primario:hover { opacity: .9; }
.nut-btn-peligro { min-height: 48px; margin-top: var(--space-3); width: 100%; background: transparent; border: 1px solid var(--danger); border-radius: var(--radius); color: var(--danger); font-weight: 600; }
.nut-btn-peligro:hover { background: var(--surface-2); }

/* Semana */
.nut-sem-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }
.nut-sem-dia { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.nut-sem-hoy { border-color: var(--accent); }
.nut-sem-dia-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); font-family: var(--font-display); font-weight: 600; font-size: .92rem; padding-bottom: var(--space-1); }
.nut-sem-hoy .nut-sem-dia-head { color: var(--accent); }
.nut-sem-fecha { font-size: .74rem; color: var(--text-faint); font-family: var(--font-num); }
.nut-celda { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; min-height: 56px; padding: var(--space-2); background: var(--surface-2); border: 1px dashed var(--border); border-radius: var(--radius); text-align: left; transition: border-color .15s, background .15s; }
.nut-celda:hover { border-color: var(--accent); }
.nut-celda-llena { background: var(--accent-soft); border: 1px solid var(--accent); }
.nut-celda-slot { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); }
.nut-celda-combo { font-size: .84rem; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.nut-celda-prot { font-size: .74rem; color: var(--accent); }
.nut-celda-mas { font-size: .82rem; color: var(--text-dim); }
.nut-celda-porcion { font-size: .72rem; font-weight: 400; color: var(--text-faint); }
.nut-dia-plantilla { width: 100%; min-height: 44px; background: transparent; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-size: .8rem; transition: color .15s, border-color .15s, background .15s; }
.nut-dia-plantilla:hover, .nut-dia-plantilla:active { color: var(--accent-2); border-color: var(--accent-2); background: var(--accent-2-soft); }

/* Modal combos — glass + entrada */
@keyframes nut-modal-in { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes nut-modal-fade { from { opacity: 0; } to { opacity: 1; } }
.nut-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--bg) 72%, transparent); backdrop-filter: blur(6px) saturate(1.1); animation: nut-modal-fade var(--dur) ease; }
.nut-modal-card { width: 100%; max-width: 480px; max-height: 82vh; display: flex; flex-direction: column; background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, transparent), var(--surface)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: var(--space-4); box-shadow: var(--shadow-2); animation: nut-modal-in var(--dur-slow) var(--ease-out-expo); }
@media (prefers-reduced-motion: reduce) { .nut-modal, .nut-modal-card { animation: none; } }
.nut-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
.nut-modal-titulo { margin: 0; font-family: var(--font-display); font-size: 1rem; }
.nut-modal-body { flex: 1; overflow-y: auto; }
.nut-modal-grupo { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); margin: var(--space-3) 0 var(--space-1); }
.nut-modal-grupo:first-child { margin-top: 0; }
.nut-modal-tabs { margin-bottom: var(--space-3); }
.nut-plantilla-form { display: flex; gap: var(--space-2); margin-top: var(--space-1); }
.nut-plantilla-form .nut-input { flex: 1; min-width: 0; }
.nut-plantilla-form .nut-btn-primario { flex: none; }

/* Chip "Planificado" en Hoy */
.nut-plan-chip { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 52px; margin: var(--space-2) 0; padding: var(--space-2) var(--space-3); background: var(--accent-2-soft); border: 1px solid var(--border); border-radius: var(--radius); font-size: .84rem; color: var(--text-dim); }
.nut-plan-chip-txt { min-width: 0; overflow-wrap: anywhere; }
.nut-plan-chip strong { color: var(--text); font-weight: 600; }
.nut-plan-chip-btn { flex: none; min-height: 40px; padding: var(--space-1) var(--space-4); background: var(--accent-2); border: none; border-radius: 999px; color: var(--bg); font-weight: 700; font-size: .8rem; transition: opacity .15s; }
.nut-plan-chip-btn:hover { opacity: .9; }

/* Prep */
.nut-prep-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 44px; padding: var(--space-1) 0; border-bottom: 1px solid var(--border); }
.nut-prep-fila:last-child { border-bottom: none; }
.nut-prep-nombre { font-size: .9rem; overflow-wrap: anywhere; }
.nut-prep-veces { font-family: var(--font-num); font-weight: 700; color: var(--accent); white-space: nowrap; }
.nut-prep-cant { font-size: .88rem; color: var(--text-dim); white-space: nowrap; }

/* Compras */
.nut-compras-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.nut-compras-conteo { font-size: .78rem; color: var(--text-faint); margin-top: 2px; }
.nut-compra { display: flex; align-items: center; gap: var(--space-3); min-height: 52px; padding: var(--space-1) 0; border-bottom: 1px solid var(--border); cursor: pointer; }
.nut-compra:last-child { border-bottom: none; }
.nut-check { width: 22px; height: 22px; flex: none; accent-color: var(--accent); cursor: pointer; }
.nut-compra-nombre { flex: 1; font-size: .92rem; overflow-wrap: anywhere; }
.nut-compra-cant { font-size: .85rem; color: var(--text-dim); white-space: nowrap; }
.nut-comprado .nut-compra-nombre { text-decoration: line-through; color: var(--text-faint); }
.nut-comprado .nut-compra-cant { color: var(--text-faint); }

/* Vacíos y cargando */
.nut-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.nut-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.nut-vacio p { margin: 0 0 var(--space-2); }
.nut-vacio-sub { font-size: .82rem; color: var(--text-faint); }
.nut-vacio .nut-btn-primario { margin-top: var(--space-3); }
.nut-cargando { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-faint); font-size: .9rem; }

/* Hero: en pantallas angostas el anillo se centra y el texto va debajo */
@media (max-width: 480px) {
  .nut-hero { flex-direction: column; text-align: center; }
  .nut-hero-lado { text-align: center; }
  .nut-hero-ring, .nut-hero-ring svg { width: 148px; height: 148px; }
  .nut-hero-num { font-size: 2.4rem; }
}

/* Desktop */
@media (min-width: 768px) {
  .nut { padding: var(--space-6); }
  .nut-tab { flex: none; }
  .nut-sem-grid { grid-template-columns: repeat(7, 1fr); }
  .nut-sem-dia { padding: var(--space-2); }
  .nut-manual-grid { grid-template-columns: repeat(4, 1fr); }
  .nut-modal { align-items: center; }
  .nut-modal-card { border-radius: var(--radius-lg); animation: nut-modal-in var(--dur-slow) var(--ease-out-expo); }
}
`;

function inyectarEstilos() {
  if (document.getElementById('nut-styles')) return;
  const st = document.createElement('style');
  st.id = 'nut-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'nutricion',
  label: 'Nutrición',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.tab = 'hoy';
    S.fecha = hoyStr();
    S.semana = lunesDe(hoyStr());
    S.picker = null;
    S.comboPicker = null;
    S.plantillaModal = null;
    inyectarEstilos();
    bind();
    if (!supabase) {
      container.innerHTML = `
      <div class="nut">
        <div class="nut-vacio">
          <div class="nut-vacio-icono">🔌</div>
          <p>Supabase no está configurado.</p>
          <p class="nut-vacio-sub">Completá js/core/env.js con tu URL y anon key (ver SETUP.md).</p>
        </div>
      </div>`;
      return;
    }
    container.innerHTML = `<div class="nut"><div class="nut-cargando">Cargando Nutrición…</div></div>`;
    try {
      // hist7 es tolerante (no throw): no bloquea la carga si falla.
      await Promise.all([cargarCatalogo(), cargarLog(), cargarPlan(), cargarHistoria7()]);
      S.ultimaCarga = Date.now();
    } catch (err) {
      toast('No se pudieron cargar los datos: ' + msgErr(err), 'error');
    }
    this.render();
  },

  render() {
    if (!S.container) return;
    if (!supabase) return;
    // Si cambió el día real desde la última visita, reenganchar "hoy" SIN
    // mostrar el log del día viejo bajo el label nuevo mientras recarga.
    if (S.tab === 'hoy' && S.fecha !== hoyStr() && Date.now() - S.ultimaCarga > 6 * 60 * 60 * 1000) {
      S.fecha = hoyStr();
      S.semana = lunesDe(hoyStr());
      S.log = [];
      S.plan = [];
      S.cargando = true;
      paint();
      S.ultimaCarga = Date.now();
      Promise.all([cargarLog(), cargarPlan(), cargarHistoria7()])
        .then(() => { S.cargando = false; paint(); })
        .catch(() => { S.cargando = false; paint(); toast('No se pudo actualizar el día', 'warning'); });
      return;
    }
    paint();
    // Refresco silencioso al volver de otra ruta (multi-device)
    if (Date.now() - S.ultimaCarga > 30000) {
      S.ultimaCarga = Date.now();
      Promise.all([cargarLog(), cargarPlan(), cargarCatalogo(), cargarHistoria7()])
        .then(() => paint())
        .catch(() => { /* silencioso: la data pintada coincide con su label */ });
    }
  },
};
