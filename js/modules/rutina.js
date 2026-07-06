// VIDA — Módulo Rutina (Fase 3) · re-skin "Instrumento Vivo"
// Checklist diario · Editor de rutinas · Adherencia
// Contrato: docs/CONTRATOS.md §10. Interfaz canónica: §4.
//
// Re-skin (no rewrite): la lógica de datos (toggleCheck optimista, editor,
// adherencia/racha, soft-delete, guards, estado S) se preserva EXACTA. Solo
// cambian el paint/render y el CSS inyectado (prefijo rut-), y se agregan:
//   · Tab Hoy: anillo de progreso por rutina + racha viva destacada arriba.
//   · Momentos del día (AM/PM/Noche) si la rutina trae campo `momento`; si no,
//     todo cae en "General" (no se inventan datos → degrada).
//   · Heatmap de adherencia con entrada animada y mejor color.
// Motor de movimiento: core/anim.js (countUp/ring/stagger/tiltAll) + motion.css.
import { supabase } from '../core/supabase.js';
import { toast, confirmDialog } from '../core/ui.js';
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local, semana desde LUNES)
   ============================================================ */
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DIAS_CHIP = ['L', 'M', 'X', 'J', 'V', 'S', 'D']; // lunes=0
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

/* ============================================================
   Utilidades
   ============================================================ */
const NF = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
function num(n) { return NF.format(Number(n) || 0); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }

// slug estable de un label para item_id. Los checks históricos referencian
// estos ids → una vez creado un item NO se regenera su id al renombrar la
// rutina ni al reordenar; solo se genera para items nuevos (con dedup).
function slugify(txt) {
  const base = String(txt || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'item';
}
function slugUnico(txt, usados) {
  let base = slugify(txt);
  let s = base;
  let i = 2;
  while (usados.has(s)) { s = base + '-' + i; i++; }
  usados.add(s);
  return s;
}

/* ============================================================
   Momentos del día — SOLO si la rutina trae un campo `momento`.
   No se inventan datos: si ninguna rutina lo tiene, todo cae en
   "General" y no se muestran secciones (degradación limpia).
   Valores reconocidos (case-insensitive, con/ sin acento): am|manana,
   pm|tarde, noche. Cualquier otro / ausente → 'general'.
   ============================================================ */
const MOMENTOS = [
  { id: 'am', label: 'Mañana', icono: '🌅' },
  { id: 'pm', label: 'Tarde', icono: '🌇' },
  { id: 'noche', label: 'Noche', icono: '🌙' },
  { id: 'general', label: 'General', icono: '📋' },
];
const MOMENTO_LABEL = MOMENTOS.reduce((o, m) => (o[m.id] = m, o), {});

function momentoDe(r) {
  const raw = String((r && r.momento) != null ? r.momento : '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (raw === 'am' || raw === 'manana' || raw === 'am/pm' || raw === 'amanecer') return 'am';
  if (raw === 'pm' || raw === 'tarde') return 'pm';
  if (raw === 'noche' || raw === 'night') return 'noche';
  return 'general';
}
// ¿Alguna de estas rutinas declara momento real (≠ general)? Habilita secciones.
function hayMomentos(lista) {
  return lista.some(r => momentoDe(r) !== 'general');
}

/* ============================================================
   Estado del módulo (el DOM se repinta entero en cada paint)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,
  boundEl: null,           // container al que están atados los listeners (si cambia, se re-bindea)
  tab: 'hoy',              // 'hoy' | 'rutinas' | 'adherencia'
  fecha: hoyStr(),         // día visible en Hoy
  rutinas: [],             // rutina_rutinas (activas o no, no _deleted)
  checks: [],              // rutina_checks del día visible (tab Hoy)
  adhChecks: [],           // rutina_checks del rango (tab Adherencia)
  adhRango: 7,             // 7 | 30 días de la vista Adherencia
  lanzadas: {},            // { 'fecha|rutina_id': true } — lanzamientos manuales locales de rutinas dias:[]
  cargando: false,         // Hoy cargando
  cargandoAdh: false,      // Adherencia cargando
  toggling: new Set(),     // in-flight guard por item (doble tap): key 'rutina_id|item_id'
  mutando: false,          // in-flight guard de mutaciones de rutinas (crear/editar/borrar)
  editor: null,            // { id|null, nombre, icono, dias:[..], items:[{id,label,nota}] } → editor abierto
  lanzarModal: false,      // picker de "+ Lanzar rutina" (rutinas dias:[])
  ultimaCarga: 0,
  _firma: null,            // firma de la última vista pintada (control de entrada animada)
};

/* ============================================================
   Datos — Supabase (siempre .eq('user_id') + soft delete)
   ============================================================ */
async function cargarRutinas() {
  const { data, error } = await supabase.from('rutina_rutinas').select('*')
    .eq('user_id', S.userId).eq('_deleted', false)
    .order('orden').order('created_at');
  if (error) throw error;
  S.rutinas = (data || []).map(normalizarRutina);
}

// Normaliza jsonb defensivamente (items/dias pueden venir null o mal tipados).
function normalizarRutina(r) {
  const items = Array.isArray(r.items) ? r.items.filter(i => i && i.id && i.label) : [];
  const dias = Array.isArray(r.dias) ? r.dias.map(Number).filter(n => n >= 0 && n <= 6) : [];
  return { ...r, items, dias };
}

// Devuelven false si la respuesta llegó tarde (el usuario ya navegó a otro
// día/rango): en ese caso NO pisan el estado, para no pintar datos de un
// período bajo el label de otro.
async function cargarChecks() {
  const fecha = S.fecha;
  const { data, error } = await supabase.from('rutina_checks').select('*')
    .eq('user_id', S.userId).eq('fecha', fecha);
  if (error) throw error;
  if (fecha !== S.fecha) return false;
  S.checks = data || [];
  return true;
}

async function cargarAdherencia() {
  const rango = S.adhRango;
  const desde = addDias(hoyStr(), -(rango - 1));
  const { data, error } = await supabase.from('rutina_checks').select('*')
    .eq('user_id', S.userId).gte('fecha', desde).lte('fecha', hoyStr());
  if (error) throw error;
  if (rango !== S.adhRango) return false;
  S.adhChecks = data || [];
  S.adhCargadaRango = rango; // evita re-query en cada visita al tab
  return true;
}

/* ============================================================
   Derivados
   ============================================================ */
function rutinaById(id) { return S.rutinas.find(r => r.id === id) || null; }

function keyLanzada(fecha, rutinaId) { return fecha + '|' + rutinaId; }

// Un check existe para (rutina, item) en el día visible.
function checkeado(rutinaId, itemId) {
  return S.checks.some(c => c.rutina_id === rutinaId && c.item_id === itemId);
}
function checkDe(rutinaId, itemId) {
  return S.checks.find(c => c.rutina_id === rutinaId && c.item_id === itemId) || null;
}
// ¿La rutina tiene algún check en el día visible? (para mostrar dias:[] ya lanzadas)
function tieneChecksEseDia(rutinaId) {
  return S.checks.some(c => c.rutina_id === rutinaId);
}

// Rutinas a mostrar en Hoy para el día visible:
//  - activa && dias incluye diaIdx  → aplica por calendario
//  - activa && dias vacío && (lanzada manual ese día || ya tiene checks ese día)
// Las de dias:[] son "manuales": se lanzan con botón (estado local) o
// reaparecen solas si ya tienen un check registrado ese día (sobrevive reload).
function rutinasDelDia() {
  const idx = diaIdx(S.fecha);
  return S.rutinas.filter(r => {
    if (!r.activa) return false;
    if (r.dias.length) return r.dias.includes(idx);
    return S.lanzadas[keyLanzada(S.fecha, r.id)] || tieneChecksEseDia(r.id);
  });
}

// Rutinas manuales (dias:[]) disponibles para lanzar hoy y todavía no visibles.
function rutinasLanzables() {
  return S.rutinas.filter(r =>
    r.activa && !r.dias.length &&
    !S.lanzadas[keyLanzada(S.fecha, r.id)] && !tieneChecksEseDia(r.id));
}

function progresoRutina(r) {
  const total = r.items.length;
  const hechos = r.items.filter(i => checkeado(r.id, i.id)).length;
  return { total, hechos, completa: total > 0 && hechos === total };
}

// Racha viva del día (para el hero de Hoy): días consecutivos hacia atrás en
// los que TODA rutina que aplicaba quedó completa. Se calcula sobre S.checks
// del día visible NO alcanza (solo tiene 1 día) → esta racha usa la data del
// tab Adherencia si está cargada; si no, degrada a la racha del día actual
// (0 o "completo hoy"). Es un realce visual, no altera la lógica de checks.
function rachaHoyViva() {
  // Reusa la data de adherencia si ya la tenemos cargada (evita otra query).
  const checks = S.adhChecks && S.adhChecks.length ? S.adhChecks : S.checks;
  if (!checks.length || !S.rutinas.length) return 0;
  // Índice fecha → (rutina_id → nº items tildados)
  const conteo = new Map(); // 'rutina|fecha' → count
  const diasConAlgo = new Set();
  for (const c of checks) {
    const f = String(c.fecha).slice(0, 10);
    diasConAlgo.add(f);
    const k = c.rutina_id + '|' + f;
    conteo.set(k, (conteo.get(k) || 0) + 1);
  }
  const base = S.fecha; // arranca desde el día visible (normalmente hoy)
  let racha = 0;
  for (let i = 0; i < 60; i++) {
    const f = addDias(base, -i);
    const idx = diaIdx(f);
    let algunaAplica = false, completo = true;
    for (const r of S.rutinas) {
      if (!r.activa || !r.items.length) continue;
      let aplica;
      if (r.dias.length) aplica = r.dias.includes(idx);
      else aplica = diasConAlgo.has(f) && (conteo.get(r.id + '|' + f) || 0) > 0; // manual: solo si hubo actividad
      if (!aplica) continue;
      algunaAplica = true;
      const hechos = conteo.get(r.id + '|' + f) || 0;
      if (hechos < r.items.length) { completo = false; break; }
    }
    if (!algunaAplica) { if (i === 0) continue; else continue; } // día sin rutinas aplicables no corta
    if (completo) racha++; else break;
  }
  return racha;
}

/* ============================================================
   Mutaciones — checks (toggle optimista con revert)
   ============================================================ */
async function toggleCheck(rutinaId, itemId) {
  const key = rutinaId + '|' + itemId;
  if (S.toggling.has(key)) return; // doble tap sobre el mismo item
  const r = rutinaById(rutinaId);
  if (!r) return;
  const fecha = S.fecha;
  const existente = checkDe(rutinaId, itemId);
  S.toggling.add(key);
  S.adhCargadaRango = null; // el toggle cambia la adherencia → recargar al volver al tab

  if (existente) {
    // Destildar: quitar optimista, borrar en DB, revertir si falla.
    S.checks = S.checks.filter(c => c.id !== existente.id);
    paint();
    try {
      const { error } = await supabase.from('rutina_checks').delete()
        .eq('id', existente.id).eq('user_id', S.userId);
      if (error) throw error;
    } catch (err) {
      if (S.fecha === fecha && !checkeado(rutinaId, itemId)) { S.checks.push(existente); paint(); }
      toast('No se pudo destildar: ' + msgErr(err), 'error');
    }
    S.toggling.delete(key);
    return;
  }

  // Tildar: agregar optimista (id temporal), insertar en DB.
  const optimista = { id: 'tmp-' + key + '-' + Date.now(), user_id: S.userId, fecha, rutina_id: rutinaId, item_id: itemId };
  S.checks.push(optimista);
  paint();
  try {
    const { data, error } = await supabase.from('rutina_checks')
      .insert({ user_id: S.userId, fecha, rutina_id: rutinaId, item_id: itemId })
      .select().single();
    if (error) throw error;
    // Reemplazar la fila optimista por la real (solo si seguimos en ese día).
    if (S.fecha === fecha) {
      const i = S.checks.findIndex(c => c.id === optimista.id);
      if (i >= 0) S.checks[i] = data; else S.checks.push(data);
      paint();
    }
  } catch (err) {
    // 23505 = unique violation: el check YA existía (doble-tap o multi-device).
    // No es un error para el usuario: dejamos la fila optimista (queda tildado).
    if (err && err.code === '23505') {
      // ok — ya estaba checkeado; el refetch silencioso lo reconcilia
    } else {
      if (S.fecha === fecha) { S.checks = S.checks.filter(c => c.id !== optimista.id); paint(); }
      toast('No se pudo tildar: ' + msgErr(err), 'error');
    }
  }
  S.toggling.delete(key);
}

function lanzarRutina(id) {
  const r = rutinaById(id);
  if (!r) return;
  S.lanzadas[keyLanzada(S.fecha, id)] = true;
  S.lanzarModal = false;
  paint();
}

/* ============================================================
   Mutaciones — rutinas (crear / editar / desactivar / borrar)
   ============================================================ */
// Construye el payload de items desde el editor, preservando ids estables:
// items con id existente lo conservan; items nuevos reciben slug único.
function itemsDesdeEditor(ed) {
  const usados = new Set(ed.items.filter(i => i.id).map(i => i.id));
  return ed.items
    .map(i => ({ label: String(i.label || '').trim(), nota: String(i.nota || '').trim(), id: i.id }))
    .filter(i => i.label)
    .map(i => ({
      id: i.id || slugUnico(i.label, usados),
      label: i.label,
      nota: i.nota,
    }));
}

async function guardarRutina() {
  if (S.mutando) return; // doble tap
  const ed = S.editor;
  if (!ed) return;
  const nombre = String(ed.nombre || '').trim();
  if (!nombre) { toast('Poné un nombre para la rutina', 'warning'); return; }
  const items = itemsDesdeEditor(ed);
  if (!items.length) { toast('Agregá al menos un ítem', 'warning'); return; }
  const dias = [...ed.dias].filter(n => n >= 0 && n <= 6).sort((a, b) => a - b);
  const icono = String(ed.icono || '').trim().slice(0, 4) || null;
  S.mutando = true;
  try {
    if (ed.id) {
      const { data, error } = await supabase.from('rutina_rutinas')
        .update({ nombre, icono, items, dias })
        .eq('id', ed.id).eq('user_id', S.userId)
        .select().single();
      if (error) throw error;
      const idx = S.rutinas.findIndex(r => r.id === ed.id);
      if (idx >= 0) S.rutinas[idx] = normalizarRutina(data);
      toast('Rutina actualizada', 'success');
    } else {
      const orden = S.rutinas.length ? Math.max(...S.rutinas.map(r => Number(r.orden) || 0)) + 1 : 0;
      const { data, error } = await supabase.from('rutina_rutinas')
        .insert({ user_id: S.userId, nombre, icono, items, dias, activa: true, orden })
        .select().single();
      if (error) throw error;
      S.rutinas.push(normalizarRutina(data));
      toast('Rutina creada', 'success');
    }
    S.editor = null;
  } catch (err) {
    toast('No se pudo guardar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
  paint();
}

async function toggleActiva(id) {
  if (S.mutando) return;
  const r = rutinaById(id);
  if (!r) return;
  const nueva = !r.activa;
  S.mutando = true;
  r.activa = nueva; // optimista
  paint();
  try {
    const { error } = await supabase.from('rutina_rutinas')
      .update({ activa: nueva }).eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    toast(nueva ? 'Rutina activada' : 'Rutina desactivada', 'success');
  } catch (err) {
    r.activa = !nueva; // revert
    toast('No se pudo actualizar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
  paint();
}

async function borrarRutina(id) {
  const r = rutinaById(id);
  if (!r) return;
  const ok = await confirmDialog({
    title: 'Borrar rutina',
    message: '¿Borrás "' + r.nombre + '"? El historial de adherencia se conserva, pero la rutina desaparece de la lista.',
    confirmText: 'Borrar',
    danger: true,
  });
  if (!ok) return;
  if (S.mutando) return;
  S.mutando = true;
  try {
    const { error } = await supabase.from('rutina_rutinas')
      .update({ _deleted: true }).eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.rutinas = S.rutinas.filter(x => x.id !== id);
    toast('Rutina borrada', 'success');
  } catch (err) {
    toast('No se pudo borrar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
  paint();
}

/* ============================================================
   Editor de rutinas — estado local (se persiste al guardar)
   ============================================================ */
function abrirEditorNuevo() {
  S.editor = { id: null, nombre: '', icono: '', dias: [0, 1, 2, 3, 4, 5, 6], items: [{ id: null, label: '', nota: '' }] };
  paint();
}
function abrirEditor(id) {
  const r = rutinaById(id);
  if (!r) return;
  S.editor = {
    id: r.id,
    nombre: r.nombre || '',
    icono: r.icono || '',
    dias: [...r.dias],
    items: r.items.map(i => ({ id: i.id, label: i.label, nota: i.nota || '' })),
  };
  paint();
}
function cerrarEditor() { S.editor = null; paint(); }

function editorToggleDia(idx) {
  if (!S.editor) return;
  const set = new Set(S.editor.dias);
  if (set.has(idx)) set.delete(idx); else set.add(idx);
  S.editor.dias = [...set];
  paint();
}
function editorAddItem() {
  if (!S.editor) return;
  S.editor.items.push({ id: null, label: '', nota: '' });
  paint();
}
function editorDelItem(pos) {
  if (!S.editor) return;
  S.editor.items.splice(pos, 1);
  if (!S.editor.items.length) S.editor.items.push({ id: null, label: '', nota: '' });
  paint();
}
function editorMoveItem(pos, dir) {
  if (!S.editor) return;
  const dst = pos + dir;
  const arr = S.editor.items;
  if (dst < 0 || dst >= arr.length) return;
  const tmp = arr[pos]; arr[pos] = arr[dst]; arr[dst] = tmp;
  paint();
}
// Captura los inputs del editor en S antes de un repaint (agregar/mover/quitar
// ítems, togglear días) para no perder lo tipeado.
function capturarEditor() {
  if (!S.editor || !S.container) return;
  const root = S.container.querySelector('.rut-editor');
  if (!root) return;
  const nombre = root.querySelector('[data-ed="nombre"]');
  const icono = root.querySelector('[data-ed="icono"]');
  if (nombre) S.editor.nombre = nombre.value;
  if (icono) S.editor.icono = icono.value;
  root.querySelectorAll('[data-ed-item]').forEach(fila => {
    const pos = Number(fila.dataset.edItem);
    if (!S.editor.items[pos]) return;
    const lab = fila.querySelector('[data-edf="label"]');
    const nota = fila.querySelector('[data-edf="nota"]');
    if (lab) S.editor.items[pos].label = lab.value;
    if (nota) S.editor.items[pos].nota = nota.value;
  });
}

/* ============================================================
   Adherencia — cálculo client-side
   ============================================================ */
function rangoFechas(n) {
  const arr = [];
  for (let i = n - 1; i >= 0; i--) arr.push(addDias(hoyStr(), -i));
  return arr;
}

// ¿La rutina "aplicaba" en esa fecha? (para el denominador del %).
// Días futuros no cuentan (el rango es hasta hoy). Para dias:[] (manuales),
// solo cuentan los días donde efectivamente hubo actividad (algún check).
function aplicabaEnFecha(r, fecha, checksPorDia) {
  if (r.dias.length) return r.dias.includes(diaIdx(fecha));
  const set = checksPorDia.get(fecha);
  return !!(set && set.has(r.id));
}

// Estadística por rutina en el rango: % adherencia, celdas por día, racha.
function estadisticasAdherencia() {
  const fechas = rangoFechas(S.adhRango);
  // Índice: fecha → Set(rutina_id con >=1 check) y (rutina_id|fecha) → count
  const checksPorDia = new Map();
  const conteo = new Map(); // 'rutina|fecha' → nº de items tildados
  for (const c of S.adhChecks) {
    const f = String(c.fecha).slice(0, 10);
    if (!checksPorDia.has(f)) checksPorDia.set(f, new Set());
    checksPorDia.get(f).add(c.rutina_id);
    const k = c.rutina_id + '|' + f;
    conteo.set(k, (conteo.get(k) || 0) + 1);
  }

  const filas = S.rutinas.map(r => {
    const totalItems = r.items.length;
    let hechos = 0;     // items tildados en días aplicables
    let posibles = 0;   // items × días aplicables
    const celdas = fechas.map(f => {
      const aplica = aplicabaEnFecha(r, f, checksPorDia);
      if (!aplica || totalItems === 0) return { fecha: f, estado: 'na' };
      const hoy = conteo.get(r.id + '|' + f) || 0;
      posibles += totalItems;
      hechos += Math.min(hoy, totalItems);
      let estado = 'vacio';
      if (hoy >= totalItems) estado = 'completo';
      else if (hoy > 0) estado = 'parcial';
      return { fecha: f, estado };
    });
    const pct = posibles > 0 ? Math.round((hechos / posibles) * 100) : null;
    // Racha actual: días completos consecutivos hacia atrás desde hoy,
    // saltando días donde la rutina no aplicaba.
    let racha = 0;
    for (let i = celdas.length - 1; i >= 0; i--) {
      const cel = celdas[i];
      if (cel.estado === 'na') continue;      // día no aplicable: no corta
      if (cel.estado === 'completo') racha++;
      else break;                              // vacío/parcial corta la racha
    }
    return { rutina: r, pct, celdas, racha, aplicable: posibles > 0 };
  });
  return { fechas, filas };
}

/* ============================================================
   Navegación de día (Hoy) — guard anti-carrera
   ============================================================ */
async function cambiarDia(fecha) {
  S.fecha = fecha;
  S.lanzarModal = false;
  S.cargando = true;
  paint();
  try {
    if (!(await cargarChecks())) return; // llegó tarde: otra navegación se hizo cargo
  } catch (err) {
    if (S.fecha !== fecha) return;
    S.checks = []; // nunca dejar checks de otro día bajo este label
    toast('No se pudo cargar el día: ' + msgErr(err), 'error');
  }
  S.cargando = false;
  paint();
}

async function cambiarRangoAdh(n) {
  if (n === S.adhRango) return;
  S.adhRango = n;
  S.cargandoAdh = true;
  paint();
  try {
    if (!(await cargarAdherencia())) return;
  } catch (err) {
    if (S.adhRango !== n) return;
    S.adhChecks = [];
    toast('No se pudo cargar la adherencia: ' + msgErr(err), 'error');
  }
  S.cargandoAdh = false;
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
  }
  S.container.addEventListener('click', onClick);
  S.container.addEventListener('submit', onSubmit);
  // Escape va en document: tras un paint() el foco cae a <body>, fuera del
  // container, y el listener delegado no lo vería. Ref estable → no se duplica.
  document.addEventListener('keydown', onEscape);
  S.boundEl = S.container;
}

function onEscape(e) {
  if (e.key !== 'Escape') return;
  if (!S.container || !S.container.isConnected) return;
  if (S.editor) { S.editor = null; paint(); }
  else if (S.lanzarModal) { S.lanzarModal = false; paint(); }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.rut')) return;
  const a = el.dataset.action;

  if (a === 'tab') {
    const dst = el.dataset.tab;
    if (dst === S.tab) return;
    S.tab = dst; S.editor = null; S.lanzarModal = false;
    // Adherencia: solo consultar si aún no tenemos el rango vigente cacheado.
    if (dst === 'adherencia' && S.adhCargadaRango !== S.adhRango) {
      S.cargandoAdh = true;
      paint();
      cargarAdherencia()
        .then(ok => { if (ok !== false) { S.cargandoAdh = false; paint(); } })
        .catch(() => { S.cargandoAdh = false; paint(); toast('No se pudo cargar la adherencia', 'warning'); });
    } else {
      paint();
    }
    return;
  }

  // --- Hoy ---
  if (a === 'dia-prev') { cambiarDia(addDias(S.fecha, -1)); return; }
  if (a === 'dia-next') { cambiarDia(addDias(S.fecha, 1)); return; }
  if (a === 'dia-hoy') { cambiarDia(hoyStr()); return; }
  if (a === 'toggle-check') { toggleCheck(el.dataset.rutina, el.dataset.item); return; }
  if (a === 'abrir-lanzar') { S.lanzarModal = true; paint(); return; }
  if (a === 'lanzar-cerrar') { S.lanzarModal = false; paint(); return; }
  if (a === 'lanzar-fondo') { if (e.target === el) { S.lanzarModal = false; paint(); } return; }
  if (a === 'lanzar-rutina') { lanzarRutina(el.dataset.id); return; }

  // --- Rutinas ---
  if (a === 'nueva-rutina') { abrirEditorNuevo(); return; }
  if (a === 'editar-rutina') { abrirEditor(el.dataset.id); return; }
  if (a === 'toggle-activa') { toggleActiva(el.dataset.id); return; }
  if (a === 'borrar-rutina') { borrarRutina(el.dataset.id); return; }

  // --- Editor ---
  if (a === 'ed-dia') { capturarEditor(); editorToggleDia(Number(el.dataset.dia)); return; }
  if (a === 'ed-add-item') { capturarEditor(); editorAddItem(); return; }
  if (a === 'ed-del-item') { capturarEditor(); editorDelItem(Number(el.dataset.pos)); return; }
  if (a === 'ed-up') { capturarEditor(); editorMoveItem(Number(el.dataset.pos), -1); return; }
  if (a === 'ed-down') { capturarEditor(); editorMoveItem(Number(el.dataset.pos), 1); return; }
  if (a === 'ed-cancelar') { cerrarEditor(); return; }
  if (a === 'ed-fondo') { if (e.target === el) { capturarEditor(); cerrarEditor(); } return; }

  // --- Adherencia ---
  if (a === 'adh-rango') { cambiarRangoAdh(Number(el.dataset.rango)); return; }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form || !form.closest('.rut')) return;
  if (form.dataset.action === 'ed-guardar') {
    e.preventDefault();
    capturarEditor();
    guardarRutina();
  }
}

/* ============================================================
   Vistas — el DOM del módulo se reconstruye entero en cada paint()
   El paint arma el HTML y, al final, dispara la animación (anillos +
   count-up + entrada escalonada + tilt). Todo respeta reduced-motion.
   ============================================================ */
function paint() {
  if (!S.container) return;
  const tabs = [['hoy', 'Hoy'], ['rutinas', 'Rutinas'], ['adherencia', 'Adherencia']];
  let vista;
  if (S.tab === 'rutinas') vista = vistaRutinas();
  else if (S.tab === 'adherencia') vista = vistaAdherencia();
  else vista = vistaHoy();
  S.container.innerHTML = `
  <div class="rut">
    <header class="rut-head rise">
      <h2 class="rut-titulo">Rutina</h2>
      <nav class="rut-tabs" role="tablist">
        ${tabs.map(([id, lbl]) => `
        <button class="rut-tab${S.tab === id ? ' activa' : ''}" role="tab"
          aria-selected="${S.tab === id}" data-action="tab" data-tab="${id}">${lbl}</button>`).join('')}
      </nav>
    </header>
    <div class="rut-cuerpo">${vista}</div>
    ${S.editor ? modalEditor() : ''}
    ${S.lanzarModal ? modalLanzar() : ''}
  </div>`;
  // Entrada completa solo si cambió la estructura de la vista; los toggles de
  // check repintan con los mismos elementos y solo asientan valores.
  const firma = firmaVista();
  const entrada = firma !== S._firma;
  S._firma = firma;
  animarPaint(entrada);
}

// Firma de la vista: cambia cuando la estructura cambió (tab/día/rango, set de
// rutinas, editor/modal). NO cambia al tildar un ítem. Sirve para animar la
// ENTRADA completa solo en un (re)mount real y, en cambio, "asentar" los
// valores al instante en updates in-place (togglear un check) — sin re-barrer
// los anillos ni recontar desde 0 en cada tap. Puro presentacional.
function firmaVista() {
  return [
    S.tab, S.fecha, S.adhRango,
    S.cargando ? 'L' : '', S.cargandoAdh ? 'A' : '',
    S.editor ? 'E' + (S.editor.id || 'nuevo') + S.editor.items.length : '',
    S.lanzarModal ? 'M' : '',
    S.rutinas.map(r => r.id + (r.activa ? '1' : '0')).join(','),
  ].join('|');
}

// Dispara las animaciones del lenguaje "Instrumento Vivo" tras cada paint.
// `entrada` = true → reproduce la coreografía de entrada (anillos desde vacío,
// count-up, stagger). false → asienta los valores finales sin barrido.
function animarPaint(entrada) {
  const c = S.container;
  if (!c) return;
  c.querySelectorAll('.v-ring-fill').forEach(el => {
    const pct = +el.getAttribute('data-pct') || 0;
    if (entrada) ring(el, pct);
    else { // asentar directo (sin sweep desde vacío)
      const r = +el.getAttribute('r') || 26, C = 2 * Math.PI * r;
      el.style.strokeDasharray = C.toFixed(2);
      el.style.strokeDashoffset = (C * (1 - Math.max(0, Math.min(100, pct)) / 100)).toFixed(2);
    }
  });
  c.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    if (entrada) countUp(el, to, { suffix, dur: +el.getAttribute('data-dur') || 900 });
    else el.textContent = String(to) + suffix; // valor final, sin contar
  });
  if (entrada) stagger(c.querySelectorAll('.rise'));
  else c.querySelectorAll('.rise').forEach(n => n.classList.add('in')); // ya visibles, sin re-animar
  tiltAll(c);
}

/* ---------- Tab HOY ---------- */
function vistaHoy() {
  const esHoy = S.fecha === hoyStr();
  const nav = `
  <div class="rut-fechanav rise">
    <button class="rut-nav-btn" data-action="dia-prev" aria-label="Día anterior">‹</button>
    <div class="rut-fechanav-centro">
      <div class="rut-fechanav-label">${labelFecha(S.fecha)}</div>
      ${esHoy ? '' : `<button class="rut-chip" data-action="dia-hoy">Volver a hoy</button>`}
    </div>
    <button class="rut-nav-btn" data-action="dia-next" aria-label="Día siguiente">›</button>
  </div>`;
  if (S.cargando) return nav + skeletonHoy();
  if (!S.rutinas.length) return nav + vacioSinRutinas();

  const lista = rutinasDelDia();
  const lanzables = rutinasLanzables();
  const botonLanzar = lanzables.length
    ? `<button class="rut-lanzar rise" data-action="abrir-lanzar">+ Lanzar rutina</button>`
    : '';

  if (!lista.length) {
    return nav + heroHoy(lista) + `
    <div class="rut-vacio rise">
      <div class="rut-vacio-icono">🗓️</div>
      <p>No hay rutinas para ${esc(labelFecha(S.fecha).toLowerCase())}.</p>
      <p class="rut-vacio-sub">Ninguna rutina activa aplica a este día. Podés lanzar una manual o armar tus rutinas en la pestaña Rutinas.</p>
      ${botonLanzar}
    </div>`;
  }

  // Agrupación por momento del día (solo si alguna rutina lo declara).
  const secciones = agruparPorMomento(lista);
  const cuerpo = secciones.map(sec => {
    const cards = sec.rutinas.map(cardRutinaHoy).join('');
    if (!sec.header) return cards; // grupo "General" sin momentos → sin header
    const m = MOMENTO_LABEL[sec.id] || MOMENTO_LABEL.general;
    return `
    <div class="rut-momento rise">
      <span class="rut-momento-ic">${m.icono}</span>
      <span class="rut-momento-lbl">${esc(m.label)}</span>
      <span class="rut-momento-rule"></span>
      <span class="rut-momento-n rut-num">${num(sec.rutinas.length)}</span>
    </div>
    ${cards}`;
  }).join('');

  return nav + heroHoy(lista) + cuerpo + botonLanzar;
}

// Hero de Hoy: resumen del día (rutinas completas / total) + racha viva.
// Framing sano: la racha se celebra con gracia; si no hay, invita sin culpa.
function heroHoy(lista) {
  const total = lista.length;
  const completas = lista.filter(r => progresoRutina(r).completa).length;
  const totalItems = lista.reduce((n, r) => n + r.items.length, 0);
  const hechosItems = lista.reduce((n, r) => n + progresoRutina(r).hechos, 0);
  const pct = totalItems > 0 ? Math.round((hechosItems / totalItems) * 100) : 0;
  const racha = rachaHoyViva();
  const esHoy = S.fecha === hoyStr();

  const rachaTxt = racha > 0
    ? `<span class="rut-hero-racha-n rut-num" data-count="${racha}" data-dur="1000">0</span> día${racha === 1 ? '' : 's'} en racha`
    : (esHoy ? 'Empezá tu racha hoy' : 'Sin racha en este día');
  const rachaHint = racha > 0
    ? (pct === 100 ? '¡Día redondo! No la cortes.' : 'Cerrá el día y la seguís sumando.')
    : 'Completá todo lo de hoy para arrancarla.';

  const arco = totalItems > 0 ? `
    <div class="rut-hero-fig">
      <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
        <circle class="v-ring-track" cx="46" cy="46" r="38" style="stroke-width:8"></circle>
        <circle class="v-ring-fill" cx="46" cy="46" r="38" style="stroke-width:8" data-pct="${pct}"></circle>
      </svg>
      <div class="rut-hero-fig-in">
        <span class="rut-hero-fig-pct rut-num" data-count="${pct}" data-suffix="%" data-dur="1000">0%</span>
        <span class="rut-hero-fig-sub">${num(completas)}/${num(total)}</span>
      </div>
    </div>` : '';

  return `
  <section class="rut-hero rise">
    ${arco}
    <div class="rut-hero-body">
      <div class="rut-hero-racha">
        <span class="rut-hero-flame heartbeat${racha > 0 ? ' on' : ''}">🔥</span>
        <span class="rut-hero-racha-txt">${rachaTxt}</span>
      </div>
      <p class="rut-hero-hint">${esc(rachaHint)}</p>
    </div>
  </section>`;
}

// Agrupa la lista de Hoy por momento del día. Si NINGUNA rutina declara
// momento real → un solo grupo sin header (degradación, no se inventa nada).
function agruparPorMomento(lista) {
  if (!hayMomentos(lista)) {
    return [{ id: 'general', header: false, rutinas: lista }];
  }
  const orden = ['am', 'pm', 'noche', 'general'];
  const buckets = new Map(orden.map(id => [id, []]));
  for (const r of lista) buckets.get(momentoDe(r)).push(r);
  return orden
    .map(id => ({ id, header: true, rutinas: buckets.get(id) }))
    .filter(sec => sec.rutinas.length);
}

function cardRutinaHoy(r) {
  const { total, hechos, completa } = progresoRutina(r);
  const pct = total > 0 ? Math.round((hechos / total) * 100) : 0;
  const items = r.items.map(i => filaItemCheck(r, i)).join('');
  const anillo = total > 0 ? `
    <div class="rut-card-fig">
      <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="v-ring-track" cx="26" cy="26" r="21" style="stroke-width:5"></circle>
        <circle class="v-ring-fill${completa ? ' rut-ring-ok' : ''}" cx="26" cy="26" r="21" style="stroke-width:5" data-pct="${pct}"></circle>
      </svg>
      <div class="rut-card-fig-in rut-num" data-count="${hechos}" data-dur="700">0</div>
    </div>` : '';
  return `
  <section class="rut-card rut-rutina rise lively${completa ? ' rut-completa' : ''}" data-tilt>
    <header class="rut-rutina-head">
      ${anillo}
      <div class="rut-rutina-info">
        <div class="rut-rutina-titulo">
          <span class="rut-rutina-icono">${esc(r.icono || '📋')}</span>
          <span>${esc(r.nombre)}</span>
        </div>
        <div class="rut-rutina-prog"><span class="rut-num">${num(hechos)}</span> de <span class="rut-num">${num(total)}</span>${completa ? ' · Completa 💪' : ' hechos'}</div>
      </div>
    </header>
    <div class="rut-items">${items || '<div class="rut-slot-vacio">Esta rutina no tiene ítems. Editala en Rutinas.</div>'}</div>
  </section>`;
}

function filaItemCheck(r, item) {
  const on = checkeado(r.id, item.id);
  return `
  <button class="rut-item-check${on ? ' rut-on' : ''}" data-action="toggle-check"
    data-rutina="${esc(r.id)}" data-item="${esc(item.id)}"
    role="checkbox" aria-checked="${on}">
    <span class="rut-box" aria-hidden="true"><span class="rut-box-tick">✓</span></span>
    <span class="rut-item-texto">
      <span class="rut-item-label">${esc(item.label)}</span>
      ${item.nota ? `<span class="rut-item-nota">${esc(item.nota)}</span>` : ''}
    </span>
  </button>`;
}

function modalLanzar() {
  const lanzables = rutinasLanzables();
  const cuerpo = lanzables.length
    ? lanzables.map(r => `
      <button class="rut-lista-item" data-action="lanzar-rutina" data-id="${esc(r.id)}">
        <span class="rut-rutina-icono">${esc(r.icono || '📋')}</span>
        <span class="rut-lista-nombre">${esc(r.nombre)}</span>
        <span class="rut-lista-meta">${num(r.items.length)} ítems</span>
      </button>`).join('')
    : `<div class="rut-picker-vacio">No hay rutinas manuales para lanzar. Creá una con días vacíos en la pestaña Rutinas.</div>`;
  return `
  <div class="rut-modal" data-action="lanzar-fondo">
    <div class="rut-modal-card" role="dialog" aria-modal="true" aria-label="Lanzar rutina">
      <header class="rut-modal-head">
        <h3 class="rut-modal-titulo">Lanzar rutina · ${labelFecha(S.fecha)}</h3>
        <button class="rut-icono" data-action="lanzar-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <div class="rut-modal-body">${cuerpo}</div>
    </div>
  </div>`;
}

/* ---------- Tab RUTINAS ---------- */
function vistaRutinas() {
  const nuevo = `<button class="rut-btn-primario rut-nueva rise" data-action="nueva-rutina">+ Nueva rutina</button>`;
  if (!S.rutinas.length) {
    return `
    <div class="rut-vacio rise">
      <div class="rut-vacio-icono">☀️</div>
      <p>Todavía no tenés rutinas.</p>
      <p class="rut-vacio-sub">Armá tu primera rutina (ej. suplementos AM, skincare) y chequeala cada mañana. Si corriste el seed (sql/05_rutina.sql) ya deberías ver la rutina «Mañana».</p>
      ${nuevo}
    </div>`;
  }
  return nuevo + S.rutinas.map(cardRutinaLista).join('');
}

function cardRutinaLista(r) {
  const dias = r.dias.length
    ? DIAS_CHIP.map((d, i) => `<span class="rut-diachip${r.dias.includes(i) ? ' on' : ''}">${d}</span>`).join('')
    : `<span class="rut-manual-badge">Manual (se lanza a mano)</span>`;
  const items = r.items.length
    ? r.items.map(i => esc(i.label)).join(' · ')
    : 'Sin ítems';
  const mom = momentoDe(r);
  const momBadge = mom !== 'general'
    ? `<span class="rut-momento-badge">${MOMENTO_LABEL[mom].icono} ${esc(MOMENTO_LABEL[mom].label)}</span>`
    : '';
  return `
  <section class="rut-card rut-rlista rise lively${r.activa ? '' : ' rut-inactiva'}" data-tilt>
    <div class="rut-rlista-top">
      <div class="rut-rutina-titulo">
        <span class="rut-rutina-icono">${esc(r.icono || '📋')}</span>
        <span>${esc(r.nombre)}${r.activa ? '' : ' <span class="rut-inact-badge">inactiva</span>'}</span>
      </div>
      <div class="rut-rlista-acciones">
        <button class="rut-icono" data-action="editar-rutina" data-id="${esc(r.id)}" aria-label="Editar" title="Editar">✎</button>
        <button class="rut-icono" data-action="toggle-activa" data-id="${esc(r.id)}" aria-label="${r.activa ? 'Desactivar' : 'Activar'}" title="${r.activa ? 'Desactivar' : 'Activar'}">${r.activa ? '⏸' : '▶'}</button>
        <button class="rut-icono rut-borrar" data-action="borrar-rutina" data-id="${esc(r.id)}" aria-label="Borrar" title="Borrar">🗑</button>
      </div>
    </div>
    <div class="rut-rlista-dias">${dias}${momBadge}</div>
    <div class="rut-rlista-items">${items}</div>
  </section>`;
}

/* ---------- Editor (modal) ---------- */
function modalEditor() {
  const ed = S.editor;
  const chips = DIAS_CHIP.map((d, i) =>
    `<button type="button" class="rut-diachip rut-diachip-btn${ed.dias.includes(i) ? ' on' : ''}" data-action="ed-dia" data-dia="${i}">${d}</button>`).join('');
  const filas = ed.items.map((it, pos) => `
    <div class="rut-ed-item" data-ed-item="${pos}">
      <div class="rut-ed-item-campos">
        <input class="rut-input" data-edf="label" value="${esc(it.label)}" placeholder="Ítem (ej. Creatina 3-5 g)" maxlength="120" autocomplete="off">
        <input class="rut-input rut-input-nota" data-edf="nota" value="${esc(it.nota || '')}" placeholder="Nota (opcional)" maxlength="160" autocomplete="off">
      </div>
      <div class="rut-ed-item-acc">
        <button type="button" class="rut-icono" data-action="ed-up" data-pos="${pos}" aria-label="Subir" title="Subir"${pos === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="rut-icono" data-action="ed-down" data-pos="${pos}" aria-label="Bajar" title="Bajar"${pos === ed.items.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="rut-icono rut-borrar" data-action="ed-del-item" data-pos="${pos}" aria-label="Quitar ítem" title="Quitar">✕</button>
      </div>
    </div>`).join('');
  return `
  <div class="rut-modal" data-action="ed-fondo">
    <div class="rut-modal-card rut-editor" role="dialog" aria-modal="true" aria-label="Editor de rutina">
      <header class="rut-modal-head">
        <h3 class="rut-modal-titulo">${ed.id ? 'Editar rutina' : 'Nueva rutina'}</h3>
        <button class="rut-icono" data-action="ed-cancelar" aria-label="Cerrar">✕</button>
      </header>
      <form class="rut-modal-body rut-ed-form" data-action="ed-guardar">
        <div class="rut-ed-fila">
          <label class="rut-ed-campo rut-ed-icono">Emoji<input class="rut-input" data-ed="icono" value="${esc(ed.icono)}" placeholder="☀️" maxlength="4" autocomplete="off"></label>
          <label class="rut-ed-campo rut-ed-nombre">Nombre<input class="rut-input" data-ed="nombre" value="${esc(ed.nombre)}" placeholder="Nombre de la rutina" maxlength="80" autocomplete="off" required></label>
        </div>
        <div class="rut-ed-grupo">
          <div class="rut-ed-grupo-label">Días de la semana <span class="rut-ed-hint">(vacío = solo lanzamiento manual)</span></div>
          <div class="rut-diachips">${chips}</div>
        </div>
        <div class="rut-ed-grupo">
          <div class="rut-ed-grupo-label">Ítems del checklist</div>
          <div class="rut-ed-items">${filas}</div>
          <button type="button" class="rut-btn-ghost rut-ed-add" data-action="ed-add-item">+ Agregar ítem</button>
        </div>
        <div class="rut-ed-acciones">
          <button type="button" class="rut-btn-ghost" data-action="ed-cancelar">Cancelar</button>
          <button type="submit" class="rut-btn-primario">${ed.id ? 'Guardar cambios' : 'Crear rutina'}</button>
        </div>
      </form>
    </div>
  </div>`;
}

/* ---------- Tab ADHERENCIA ---------- */
function vistaAdherencia() {
  const toggle = `
  <div class="rut-adh-toggle rise">
    <button class="rut-seg${S.adhRango === 7 ? ' activa' : ''}" data-action="adh-rango" data-rango="7">7 días</button>
    <button class="rut-seg${S.adhRango === 30 ? ' activa' : ''}" data-action="adh-rango" data-rango="30">30 días</button>
  </div>`;
  if (S.cargandoAdh) return toggle + skeletonAdh();
  if (!S.rutinas.length) {
    return toggle + `
    <div class="rut-vacio rise">
      <div class="rut-vacio-icono">📊</div>
      <p>Sin rutinas todavía.</p>
      <p class="rut-vacio-sub">Creá rutinas y empezá a chequearlas: acá vas a ver tu adherencia y tus rachas.</p>
    </div>`;
  }
  const { fechas, filas } = estadisticasAdherencia();
  const conDatos = filas.some(f => f.aplicable);
  if (!conDatos) {
    return toggle + `
    <div class="rut-vacio rise">
      <div class="rut-vacio-icono">📊</div>
      <p>Todavía no hay datos en este rango.</p>
      <p class="rut-vacio-sub">Chequeá tus rutinas en Hoy y volvé: la adherencia se arma sola.</p>
    </div>`;
  }
  return toggle + resumenAdh(filas) + filas.map(f => bloqueAdherencia(f, fechas)).join('');
}

// Resumen superior del tab: adherencia media del rango + mejor racha viva.
function resumenAdh(filas) {
  const conPct = filas.filter(f => f.aplicable && f.pct != null);
  const media = conPct.length ? Math.round(conPct.reduce((n, f) => n + f.pct, 0) / conPct.length) : null;
  const mejorRacha = filas.reduce((mx, f) => Math.max(mx, f.racha || 0), 0);
  if (media == null) return '';
  const arco = `
    <div class="rut-adh-hero-fig">
      <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">
        <circle class="v-ring-track" cx="42" cy="42" r="34" style="stroke-width:8"></circle>
        <circle class="v-ring-fill" cx="42" cy="42" r="34" style="stroke-width:8" data-pct="${media}"></circle>
      </svg>
      <div class="rut-adh-hero-pct rut-num" data-count="${media}" data-suffix="%" data-dur="1000">0%</div>
    </div>`;
  return `
  <section class="rut-adh-hero rise">
    ${arco}
    <div class="rut-adh-hero-body">
      <span class="rut-adh-hero-lbl">Adherencia media · ${S.adhRango}d</span>
      <div class="rut-adh-hero-racha">
        <span class="rut-hero-flame heartbeat${mejorRacha > 0 ? ' on' : ''}">🔥</span>
        <span>${mejorRacha > 0 ? `Mejor racha: <span class="rut-num" data-count="${mejorRacha}" data-dur="900">0</span> día${mejorRacha === 1 ? '' : 's'}` : 'Sumá tu primera racha'}</span>
      </div>
    </div>
  </section>`;
}

function bloqueAdherencia(f, fechas) {
  const r = f.rutina;
  const pctTxt = f.pct == null ? '—' : num(f.pct) + '%';
  const zona = f.pct == null ? '' : (f.pct >= 80 ? ' rut-zona-ok' : f.pct >= 50 ? ' rut-zona-medio' : ' rut-zona-bajo');
  // data-i alimenta el delay incremental de entrada del heatmap (CSS var).
  const celdas = f.celdas.map((c, i) => {
    const cls = c.estado === 'completo' ? 'rut-cel-completo'
      : c.estado === 'parcial' ? 'rut-cel-parcial'
      : c.estado === 'vacio' ? 'rut-cel-vacio'
      : 'rut-cel-na';
    return `<span class="rut-cel ${cls}" style="--i:${i}" title="${esc(labelCorto(c.fecha))}"></span>`;
  }).join('');
  return `
  <section class="rut-card rut-adh-fila rise lively${r.activa ? '' : ' rut-inactiva'}" data-tilt>
    <header class="rut-adh-head">
      <div class="rut-rutina-titulo">
        <span class="rut-rutina-icono">${esc(r.icono || '📋')}</span>
        <span>${esc(r.nombre)}</span>
      </div>
      <div class="rut-adh-pct rut-num${zona}">${pctTxt}</div>
    </header>
    <div class="rut-adh-grid">${celdas}</div>
    <div class="rut-adh-pie">
      <span class="rut-adh-racha">${f.racha > 0 ? `🔥 Racha: <span class="rut-num">${num(f.racha)}</span> día${f.racha === 1 ? '' : 's'}` : 'Sin racha activa'}</span>
      <span class="rut-adh-rango-txt">${labelCorto(fechas[0])} → ${labelCorto(fechas[fechas.length - 1])}</span>
    </div>
  </section>`;
}

/* ---------- Skeletons (carga viva con shimmer) ---------- */
function skeletonHoy() {
  return `
  <section class="rut-hero"><div class="shimmer" style="width:92px;height:92px;border-radius:50%"></div>
    <div style="flex:1"><div class="shimmer" style="height:16px;width:55%;margin-bottom:10px"></div>
      <div class="shimmer" style="height:12px;width:75%"></div></div></section>
  ${[0, 1].map(() => `<div class="rut-card"><div class="shimmer" style="height:20px;width:40%;margin-bottom:14px"></div>
    <div class="shimmer" style="height:56px;margin-bottom:8px"></div><div class="shimmer" style="height:56px"></div></div>`).join('')}`;
}
function skeletonAdh() {
  return `
  <section class="rut-adh-hero"><div class="shimmer" style="width:84px;height:84px;border-radius:50%"></div>
    <div style="flex:1"><div class="shimmer" style="height:14px;width:45%;margin-bottom:10px"></div>
      <div class="shimmer" style="height:12px;width:60%"></div></div></section>
  ${[0, 1].map(() => `<div class="rut-card"><div class="shimmer" style="height:18px;width:35%;margin-bottom:14px"></div>
    <div class="shimmer" style="height:18px;width:90%"></div></div>`).join('')}`;
}

/* ---------- Vacíos ---------- */
function vacioSinRutinas() {
  return `
  <div class="rut-vacio rise">
    <div class="rut-vacio-icono">☀️</div>
    <p>Todavía no tenés rutinas.</p>
    <p class="rut-vacio-sub">Andá a la pestaña Rutinas y armá tu primera (o corré el seed sql/05_rutina.sql para arrancar con «Mañana»).</p>
    <button class="rut-btn-primario" data-action="tab" data-tab="rutinas">Ir a Rutinas</button>
  </div>`;
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo rut-, solo var(--token) + motion.css
   ============================================================ */
const CSS = `
.rut { max-width: 920px; margin: 0 auto; padding: var(--space-4); font-family: var(--font-ui); color: var(--text); }
.rut * { box-sizing: border-box; }
.rut button { font: inherit; color: inherit; cursor: pointer; }
.rut button:focus-visible, .rut input:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.rut-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.rut .v-ring-fill.rut-ring-ok { stroke: var(--ok); }

/* Header + tabs */
.rut-head { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.rut-titulo { margin: 0; font-family: var(--font-display); font-size: 1.35rem; letter-spacing: .01em; }
.rut-tabs { display: flex; gap: var(--space-2); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.rut-tab { flex: 1 1 0; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); white-space: nowrap; transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease; }
.rut-tab:hover { border-color: var(--border-strong); }
.rut-tab.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

/* Navegación fecha */
.rut-fechanav { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.rut-nav-btn { width: 48px; min-height: 48px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 1.4rem; line-height: 1; color: var(--text-dim); transition: background var(--dur) ease, border-color var(--dur) ease; }
.rut-nav-btn:hover { border-color: var(--border-strong); color: var(--text); }
.rut-nav-btn:active { background: var(--surface-2); }
.rut-fechanav-centro { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); min-width: 0; }
.rut-fechanav-label { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; text-align: center; }
.rut-chip { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: var(--space-1) var(--space-3); font-size: .78rem; min-height: 28px; }

/* Hero del día — arco de progreso + racha viva */
.rut-hero { position: relative; display: flex; align-items: center; gap: clamp(14px, 3vw, 22px); padding: clamp(16px, 3vw, 22px); margin-bottom: var(--space-5); border-radius: var(--radius-lg); overflow: hidden;
  background: linear-gradient(135deg, rgba(53,224,178,.07), rgba(90,162,255,.05)), var(--surface); border: 1px solid var(--border-strong); }
.rut-hero::before { content: ""; position: absolute; width: 260px; height: 260px; left: -40px; top: -120px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(53,224,178,.13), transparent 65%); animation: vida-breathe 5s ease-in-out infinite; }
.rut-hero-fig { position: relative; width: 92px; height: 92px; flex: none; }
.rut-hero-fig svg { width: 92px; height: 92px; transform: rotate(-90deg); }
.rut-hero-fig-in { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
.rut-hero-fig-pct { font-weight: 700; font-size: 1.4rem; line-height: 1; color: var(--accent); }
.rut-hero-fig-sub { font-family: var(--font-num); font-size: .72rem; color: var(--text-faint); }
.rut-hero-body { min-width: 0; position: relative; }
.rut-hero-racha { display: flex; align-items: center; gap: var(--space-2); }
.rut-hero-flame { font-size: 1.25rem; filter: grayscale(1) opacity(.5); transform-origin: center; }
.rut-hero-flame.on { filter: none; }
.rut-hero-racha-txt { font-family: var(--font-display); font-size: 1.05rem; font-weight: 700; }
.rut-hero-racha-n { font-size: 1.5rem; color: var(--accent); margin-right: 2px; }
.rut-hero-hint { margin: var(--space-1) 0 0; font-size: .82rem; color: var(--text-dim); }

/* Momentos del día (secciones) */
.rut-momento { display: flex; align-items: center; gap: var(--space-2); margin: var(--space-5) 2px var(--space-3); }
.rut-momento-ic { font-size: 1rem; }
.rut-momento-lbl { font-size: .7rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); }
.rut-momento-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--border-strong), transparent); }
.rut-momento-n { font-size: .72rem; color: var(--text-faint); }

/* Cards */
.rut-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--shadow-1); }

/* Rutina en Hoy — anillo + checklist con tap-targets grandes */
.rut-rutina-head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.rut-card-fig { position: relative; width: 52px; height: 52px; flex: none; }
.rut-card-fig svg { width: 52px; height: 52px; transform: rotate(-90deg); }
.rut-card-fig-in { position: absolute; inset: 0; display: grid; place-items: center; font-size: .95rem; font-weight: 700; color: var(--accent); }
.rut-completa .rut-card-fig-in { color: var(--ok); }
.rut-rutina-info { flex: 1; min-width: 0; }
.rut-rutina-titulo { display: flex; align-items: center; gap: var(--space-2); font-family: var(--font-display); font-size: 1.1rem; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.rut-rutina-icono { font-size: 1.25rem; flex: none; }
.rut-rutina-prog { font-size: .82rem; color: var(--text-dim); white-space: nowrap; margin-top: 2px; }
.rut-completa { border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
.rut-completa .rut-rutina-prog { color: var(--ok); }
.rut-items { display: flex; flex-direction: column; gap: var(--space-2); }
.rut-item-check { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 60px; padding: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); text-align: left; transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) ease; }
.rut-item-check:hover { border-color: var(--border-strong); }
.rut-item-check:active { transform: scale(.99); }
.rut-item-check.rut-on { background: var(--accent-soft); border-color: var(--accent); }
.rut-box { width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--bg); border: 2px solid var(--border-strong); border-radius: 8px; transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease; }
.rut-box-tick { font-size: 1.05rem; font-weight: 800; color: var(--bg); transform: scale(0); transition: transform var(--dur) var(--ease-spring); }
.rut-on .rut-box { background: var(--accent); border-color: var(--accent); }
.rut-on .rut-box-tick { transform: scale(1); }
.rut-item-texto { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rut-item-label { font-size: .98rem; overflow-wrap: anywhere; }
.rut-on .rut-item-label { color: var(--text); }
.rut-item-nota { font-size: .76rem; color: var(--text-faint); overflow-wrap: anywhere; }
.rut-slot-vacio { padding: var(--space-3) 0; font-size: .85rem; color: var(--text-faint); }
.rut-lanzar { width: 100%; min-height: 48px; margin-bottom: var(--space-4); background: transparent; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--accent-2); font-weight: 600; transition: background var(--dur) ease, border-color var(--dur) ease; }
.rut-lanzar:hover, .rut-lanzar:active { background: var(--accent-2-soft); border-color: var(--accent-2); }

/* Lista de rutinas */
.rut-nueva { width: 100%; margin-bottom: var(--space-4); }
.rut-rlista-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.rut-rlista-acciones { display: flex; gap: var(--space-1); flex: none; }
.rut-inact-badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-faint); background: var(--surface-2); border-radius: 999px; padding: 2px var(--space-2); vertical-align: middle; }
.rut-inactiva { opacity: .62; }
.rut-rlista-dias { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-2); }
.rut-diachip { width: 26px; height: 26px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-size: .74rem; font-weight: 600; color: var(--text-faint); }
.rut-diachip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.rut-manual-badge { font-size: .76rem; color: var(--text-dim); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: var(--space-1) var(--space-3); }
.rut-momento-badge { font-size: .7rem; color: var(--accent-2); background: var(--accent-2-soft); border-radius: 999px; padding: 2px var(--space-2); margin-left: var(--space-1); }
.rut-rlista-items { font-size: .82rem; color: var(--text-dim); overflow-wrap: anywhere; }

/* Botones e íconos */
.rut-btn-primario { min-height: 48px; padding: var(--space-2) var(--space-4); background: var(--accent); border: none; border-radius: var(--radius); color: var(--bg); font-weight: 700; transition: opacity var(--dur) ease, transform var(--dur-fast) ease; }
.rut-btn-primario:hover { opacity: .9; }
.rut-btn-primario:active { transform: scale(.98); }
.rut-btn-ghost { min-height: 44px; padding: var(--space-2) var(--space-4); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-weight: 600; transition: background var(--dur) ease, color var(--dur) ease; }
.rut-btn-ghost:hover { background: var(--surface-2); color: var(--text); }
.rut-icono { width: 44px; min-height: 44px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-size: 1rem; transition: background var(--dur-fast) ease, color var(--dur-fast) ease; }
.rut-icono:hover { background: var(--surface-2); color: var(--text-dim); }
.rut-icono:disabled { opacity: .3; cursor: default; }
.rut-icono.rut-borrar:hover, .rut-icono.rut-borrar:active { color: var(--danger); }

/* Inputs */
.rut-input { width: 100%; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font: inherit; transition: border-color var(--dur) ease; }
.rut-input:focus { border-color: var(--accent); outline: none; }
.rut-input-nota { min-height: 40px; font-size: .85rem; }

/* Modal (editor / lanzar) — glass */
.rut-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--bg) 68%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: rut-fade var(--dur) ease; }
.rut-modal-card { width: 100%; max-width: 520px; max-height: 88vh; display: flex; flex-direction: column; background: color-mix(in srgb, var(--surface) 92%, transparent); border: 1px solid var(--border-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: var(--space-4); box-shadow: var(--shadow-2); animation: rut-rise var(--dur-slow) var(--ease-out-expo); }
@keyframes rut-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rut-rise { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.rut-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
.rut-modal-titulo { margin: 0; font-family: var(--font-display); font-size: 1.05rem; }
.rut-modal-body { flex: 1; overflow-y: auto; }
.rut-picker-vacio { padding: var(--space-4); text-align: center; font-size: .84rem; color: var(--text-faint); }
.rut-lista-item { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 56px; padding: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: var(--space-2); text-align: left; transition: border-color var(--dur-fast) ease, transform var(--dur-fast) ease; }
.rut-lista-item:hover { border-color: var(--accent-2); }
.rut-lista-item:active { transform: scale(.99); }
.rut-lista-nombre { flex: 1; min-width: 0; font-size: .95rem; overflow-wrap: anywhere; }
.rut-lista-meta { font-size: .76rem; color: var(--text-faint); white-space: nowrap; }

/* Editor */
.rut-ed-form { display: flex; flex-direction: column; gap: var(--space-4); }
.rut-ed-fila { display: flex; gap: var(--space-2); }
.rut-ed-campo { display: flex; flex-direction: column; gap: var(--space-1); font-size: .76rem; color: var(--text-dim); }
.rut-ed-icono { flex: none; width: 72px; }
.rut-ed-nombre { flex: 1; min-width: 0; }
.rut-ed-grupo-label { font-size: .78rem; color: var(--text-dim); margin-bottom: var(--space-2); }
.rut-ed-hint { color: var(--text-faint); font-size: .72rem; }
.rut-diachips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.rut-diachip-btn { width: 40px; height: 40px; cursor: pointer; transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.rut-diachip-btn:hover { border-color: var(--border-strong); }
.rut-ed-items { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-2); }
.rut-ed-item { display: flex; gap: var(--space-2); align-items: flex-start; }
.rut-ed-item-campos { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.rut-ed-item-acc { display: flex; flex: none; }
.rut-ed-item-acc .rut-icono { width: 38px; min-height: 40px; }
.rut-ed-add { width: 100%; }
.rut-ed-acciones { display: flex; gap: var(--space-2); justify-content: flex-end; }
.rut-ed-acciones .rut-btn-primario { flex: 1; }

/* Adherencia */
.rut-adh-toggle { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); }
.rut-seg { flex: 1; min-height: 44px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); font-weight: 600; transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease; }
.rut-seg:hover { border-color: var(--border-strong); }
.rut-seg.activa { background: var(--accent-2-soft); border-color: var(--accent-2); color: var(--accent-2); }

/* Adherencia — hero de resumen */
.rut-adh-hero { position: relative; display: flex; align-items: center; gap: clamp(14px, 3vw, 20px); padding: clamp(14px, 3vw, 20px); margin-bottom: var(--space-5); border-radius: var(--radius-lg); overflow: hidden;
  background: linear-gradient(135deg, rgba(90,162,255,.07), rgba(53,224,178,.05)), var(--surface); border: 1px solid var(--border-strong); }
.rut-adh-hero-fig { position: relative; width: 84px; height: 84px; flex: none; }
.rut-adh-hero-fig svg { width: 84px; height: 84px; transform: rotate(-90deg); }
.rut-adh-hero-fig .v-ring-fill { stroke: var(--accent-2); }
.rut-adh-hero-pct { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 700; font-size: 1.3rem; color: var(--accent-2); }
.rut-adh-hero-body { min-width: 0; }
.rut-adh-hero-lbl { font-size: .7rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); }
.rut-adh-hero-racha { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); font-family: var(--font-display); font-size: 1rem; font-weight: 700; }

.rut-adh-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.rut-adh-pct { font-size: 1.35rem; font-weight: 700; white-space: nowrap; }
.rut-zona-ok { color: var(--ok); }
.rut-zona-medio { color: var(--warn); }
.rut-zona-bajo { color: var(--danger); }
.rut-adh-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: var(--space-3); }
.rut-cel { width: 16px; height: 16px; flex: none; border-radius: 4px; border: 1px solid var(--border); animation: rut-cel-in var(--dur) var(--ease-spring) backwards; animation-delay: calc(var(--i, 0) * 22ms); }
@keyframes rut-cel-in { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
.rut-cel-completo { background: var(--ok); border-color: var(--ok); box-shadow: 0 0 6px color-mix(in srgb, var(--ok) 45%, transparent); }
.rut-cel-parcial { background: color-mix(in srgb, var(--warn) 60%, transparent); border-color: color-mix(in srgb, var(--warn) 75%, transparent); }
.rut-cel-vacio { background: color-mix(in srgb, var(--danger) 26%, transparent); border-color: color-mix(in srgb, var(--danger) 42%, transparent); }
.rut-cel-na { background: var(--surface-2); border-color: var(--border); opacity: .5; }
.rut-adh-pie { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; font-size: .8rem; color: var(--text-dim); }
.rut-adh-rango-txt { color: var(--text-faint); font-family: var(--font-num); }

/* Vacíos */
.rut-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.rut-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.rut-vacio p { margin: 0 0 var(--space-2); }
.rut-vacio-sub { font-size: .82rem; color: var(--text-faint); }
.rut-vacio .rut-btn-primario, .rut-vacio .rut-lanzar { margin-top: var(--space-3); display: inline-block; width: auto; padding-left: var(--space-6); padding-right: var(--space-6); }

/* Reduced-motion: neutraliza los keyframes propios de este módulo */
@media (prefers-reduced-motion: reduce) {
  .rut-hero::before { animation: none !important; }
  .rut-modal, .rut-modal-card, .rut-cel { animation: none !important; }
  .rut-box-tick { transition: none !important; }
}

/* Desktop */
@media (min-width: 768px) {
  .rut { padding: var(--space-6); }
  .rut-tab { flex: none; }
  .rut-nueva, .rut-vacio .rut-btn-primario { width: auto; }
  .rut-cel { width: 18px; height: 18px; }
}
`;

function inyectarEstilos() {
  if (document.getElementById('rut-styles')) return;
  const st = document.createElement('style');
  st.id = 'rut-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'rutina',
  label: 'Rutina',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.tab = 'hoy';
    S.fecha = hoyStr();
    S.adhRango = 7;
    S.editor = null;
    S.lanzarModal = false;
    S.lanzadas = {};
    S._firma = null; // fuerza coreografía de entrada en el primer paint del mount
    inyectarEstilos();
    bind();
    if (!supabase) {
      container.innerHTML = `
      <div class="rut">
        <div class="rut-vacio">
          <div class="rut-vacio-icono">🔌</div>
          <p>Supabase no está configurado.</p>
          <p class="rut-vacio-sub">Completá js/core/env.js con tu URL y anon key (ver SETUP.md).</p>
        </div>
      </div>`;
      return;
    }
    container.innerHTML = `<div class="rut"><div class="rut-cuerpo">${skeletonHoy()}</div></div>`;
    try {
      await Promise.all([cargarRutinas(), cargarChecks()]);
      S.ultimaCarga = Date.now();
    } catch (err) {
      toast('No se pudieron cargar los datos: ' + msgErr(err), 'error');
    }
    this.render();
  },

  render() {
    if (!S.container) return;
    if (!supabase) return;
    // Al volver de otra ruta queremos que la vista "reviva": forzar la
    // coreografía de entrada en este paint (los toggles internos, que llaman
    // paint() directo, siguen asentando sin re-animar).
    S._firma = null;
    // Si cambió el día real desde la última visita, reenganchar "hoy" SIN
    // mostrar los checks del día viejo bajo el label nuevo mientras recarga.
    if (S.tab === 'hoy' && S.fecha !== hoyStr() && Date.now() - S.ultimaCarga > 6 * 60 * 60 * 1000) {
      S.fecha = hoyStr();
      S.checks = [];
      S.cargando = true;
      paint();
      S.ultimaCarga = Date.now();
      Promise.all([cargarRutinas(), cargarChecks()])
        .then(() => { S.cargando = false; paint(); })
        .catch(() => { S.cargando = false; paint(); toast('No se pudo actualizar el día', 'warning'); });
      return;
    }
    paint();
    // Refresco silencioso al volver de otra ruta (multi-device)
    if (Date.now() - S.ultimaCarga > 30000) {
      S.ultimaCarga = Date.now();
      const proms = [cargarRutinas(), cargarChecks()];
      if (S.tab === 'adherencia') proms.push(cargarAdherencia());
      Promise.all(proms)
        .then(() => paint())
        .catch(() => { /* silencioso: la data pintada coincide con su label */ });
    }
  },
};
