// VIDA — Módulo Nutrición (Fase 1)
// Log diario · Planificador semanal · Meal prep · Lista de compras
// Contrato: docs/CONTRATOS.md §4 y §8. Spec funcional: CLAUDE.md §5.
import { supabase } from '../core/supabase.js';
import { toast, confirmDialog } from '../core/ui.js';

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
  log: [],                 // nutricion_log del día visible
  plan: [],                // nutricion_plan de la semana visible
  cargando: false,
  picker: null,            // { slot, tab: 'favoritos'|'combos'|'alimentos'|'manual' }
  busca: '',
  comboPicker: null,       // { fecha, slot } → modal del planificador
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
  const [alim, comb] = await Promise.all([
    supabase.from('nutricion_alimentos').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).order('nombre'),
    supabase.from('nutricion_combos').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).order('nombre'),
  ]);
  if (alim.error) throw alim.error;
  if (comb.error) throw comb.error;
  S.alimentos = alim.data || [];
  S.combos = comb.data || [];
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
  for (const p of S.plan) {
    if (p.combo_id) conteo.set(p.combo_id, (conteo.get(p.combo_id) || 0) + 1);
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
  combos.sort((a, b) => (b.veces - a.veces) || String(a.combo.nombre).localeCompare(String(b.combo.nombre)));
  const ingredientes = [...ing.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { combos, ingredientes };
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
    S.log.push(data);
    toast('Anotado: ' + item.nombre, 'success');
    paint();
  } catch (err) {
    toast('No se pudo anotar: ' + msgErr(err), 'error');
  }
}

function addAlimento(id) {
  const a = S.alimentos.find(x => x.id === id);
  if (!a || !S.picker) return;
  return agregarEntrada(S.picker.slot, {
    tipo: 'alimento', id: a.id,
    nombre: a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre,
    prot: a.prot, carbo: a.carbo, grasa: a.grasa, kcal: a.kcal,
  });
}

function addCombo(id) {
  const c = S.combos.find(x => x.id === id);
  if (!c || !S.picker) return;
  return agregarEntrada(S.picker.slot, {
    tipo: 'combo', id: c.id, nombre: c.nombre,
    prot: c.prot, carbo: c.carbo, grasa: c.grasa, kcal: c.kcal,
  });
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

async function asignarCombo(comboId) {
  const ctx = S.comboPicker;
  if (!ctx) return;
  try {
    const previo = planDe(ctx.fecha, ctx.slot);
    if (previo) {
      const { data, error } = await supabase.from('nutricion_plan')
        .update({ combo_id: comboId })
        .eq('id', previo.id).eq('user_id', S.userId)
        .select().single();
      if (error) throw error;
      Object.assign(previo, data);
    } else {
      const { data, error } = await supabase.from('nutricion_plan')
        .insert({ user_id: S.userId, fecha: ctx.fecha, slot: ctx.slot, combo_id: comboId })
        .select().single();
      if (error) throw error;
      S.plan.push(data);
    }
    S.comboPicker = null;
    toast('Plan actualizado', 'success');
  } catch (err) {
    toast('No se pudo asignar: ' + msgErr(err), 'error');
  }
  paint();
}

async function quitarPlan() {
  const ctx = S.comboPicker;
  if (!ctx) return;
  const previo = planDe(ctx.fecha, ctx.slot);
  if (!previo) { S.comboPicker = null; paint(); return; }
  try {
    const { error } = await supabase.from('nutricion_plan').delete()
      .eq('id', previo.id).eq('user_id', S.userId);
    if (error) throw error;
    S.plan = S.plan.filter(p => p.id !== previo.id);
    toast('Quitado del plan', 'success');
  } catch (err) {
    toast('No se pudo quitar: ' + msgErr(err), 'error');
  }
  S.comboPicker = null;
  paint();
}

async function cambiarDia(fecha) {
  S.fecha = fecha;
  S.picker = null;
  S.cargando = true;
  paint();
  try {
    if (!(await cargarLog())) return; // llegó tarde: otra navegación se hizo cargo
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
  if (S.comboPicker) { S.comboPicker = null; paint(); }
  else if (S.picker) { S.picker = null; paint(); }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.nut')) return;
  const a = el.dataset.action;

  if (a === 'tab') { S.tab = el.dataset.tab; S.picker = null; S.comboPicker = null; paint(); return; }

  if (a === 'dia-prev') { cambiarDia(addDias(S.fecha, -1)); return; }
  if (a === 'dia-next') { cambiarDia(addDias(S.fecha, 1)); return; }
  if (a === 'dia-hoy') { cambiarDia(hoyStr()); return; }

  if (a === 'abrir-picker') { S.picker = { slot: el.dataset.slot, tab: 'favoritos' }; S.busca = ''; paint(); return; }
  if (a === 'cerrar-picker') { S.picker = null; paint(); return; }
  if (a === 'picker-tab') { if (S.picker) { S.picker.tab = el.dataset.ptab; S.busca = ''; paint(); } return; }

  if (a === 'add-alimento') { addAlimento(el.dataset.id); return; }
  if (a === 'add-combo') { addCombo(el.dataset.id); return; }
  if (a === 'fav') { toggleFav(el.dataset.tipo, el.dataset.id); return; }
  if (a === 'del-log') { borrarEntrada(el.dataset.id); return; }

  if (a === 'sem-prev') { cambiarSemana(addDias(S.semana, -7)); return; }
  if (a === 'sem-next') { cambiarSemana(addDias(S.semana, 7)); return; }
  if (a === 'sem-hoy') { cambiarSemana(lunesDe(hoyStr())); return; }

  if (a === 'celda') { S.comboPicker = { fecha: el.dataset.fecha, slot: el.dataset.slot }; paint(); return; }
  if (a === 'modal-cerrar') { S.comboPicker = null; paint(); return; }
  if (a === 'modal-fondo') { if (e.target === el) { S.comboPicker = null; paint(); } return; }
  if (a === 'plan-asignar') { asignarCombo(el.dataset.id); return; }
  if (a === 'plan-quitar') { quitarPlan(); return; }

  if (a === 'copiar') { copiarLista(); return; }
  if (a === 'ir-semana') { S.tab = 'semana'; paint(); return; }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-action="manual"]');
  if (!form || !form.closest('.nut')) return;
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
    <header class="nut-head">
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
  </div>`;
}

function chipAyuno() {
  const ay = cfgAyuno();
  if (!ay || !ay.ultima_comida || !ay.primera_comida) return '';
  return `<span class="nut-ayuno" title="Ventana de ayuno">⏳ ${esc(ay.ultima_comida)} → ${esc(ay.primera_comida)}</span>`;
}

function vacioConfig() {
  return `
  <div class="nut-vacio">
    <div class="nut-vacio-icono">⚙️</div>
    <p>No hay slots de comida configurados.</p>
    <p class="nut-vacio-sub">Corré el seed (sql/02_seed_nutricion.sql) o cargá la clave «slots» del módulo nutricion en user_config.</p>
  </div>`;
}

function vacioPlan() {
  return `
  <div class="nut-vacio">
    <div class="nut-vacio-icono">🗓️</div>
    <p>Todavía no planificaste esta semana.</p>
    <p class="nut-vacio-sub">Asigná combos a los días y de ahí salen el prep y las compras solos.</p>
    <button class="nut-btn-primario" data-action="ir-semana">Andá a Semana</button>
  </div>`;
}

/* ---------- Tab HOY ---------- */
function vistaHoy() {
  const slots = cfgSlots();
  const esHoy = S.fecha === hoyStr();
  const nav = `
  <div class="nut-fechanav">
    <button class="nut-nav-btn" data-action="dia-prev" aria-label="Día anterior">‹</button>
    <div class="nut-fechanav-centro">
      <div class="nut-fechanav-label">${labelFecha(S.fecha)}</div>
      ${esHoy ? '' : `<button class="nut-chip" data-action="dia-hoy">Volver a hoy</button>`}
    </div>
    <button class="nut-nav-btn" data-action="dia-next" aria-label="Día siguiente">›</button>
  </div>`;
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando el día…</div>`;
  if (!slots.length) return nav + vacioConfig();
  return nav + resumenDia() + slots.map(seccionSlot).join('');
}

function resumenDia() {
  const { target, piso } = cfgTarget();
  const tot = totalesDia();
  const cre = cfgCreatina();
  let barra = '';
  if (target > 0) {
    const pct = Math.min(100, (tot.prot / target) * 100);
    const pisoPct = piso > 0 && piso < target ? Math.min(100, (piso / target) * 100) : null;
    const zona = tot.prot >= target ? 'ok' : (piso > 0 && tot.prot >= piso) ? 'medio' : 'bajo';
    const restante = Math.max(0, target - tot.prot);
    const estado = zona === 'ok'
      ? '¡Target cumplido! 💪'
      : `Te faltan <span class="nut-num">${num(restante)}</span> g${piso > 0 ? ` · piso ${num(piso)} g` : ''}`;
    barra = `
    <div class="nut-prog">
      <div class="nut-prog-fila">
        <div class="nut-prog-num"><span class="nut-num">${num(tot.prot)}</span><span class="nut-prog-de"> / ${num(target)} g proteína</span></div>
        <div class="nut-prog-estado nut-zona-${zona}">${estado}</div>
      </div>
      <div class="nut-bar">
        <div class="nut-bar-fill nut-bar-${zona}" style="width:${pct}%"></div>
        ${pisoPct !== null ? `<div class="nut-bar-piso" style="left:${pisoPct}%" title="Piso ${num(piso)} g"></div>` : ''}
      </div>
    </div>`;
  }
  return `
  <div class="nut-card nut-resumen">
    ${barra}
    <div class="nut-macros">
      <div class="nut-macro"><span class="nut-macro-v nut-num">${num(tot.prot)}</span><span class="nut-macro-k">prot g</span></div>
      <div class="nut-macro"><span class="nut-macro-v nut-num">${num(tot.carbo)}</span><span class="nut-macro-k">carbo g</span></div>
      <div class="nut-macro"><span class="nut-macro-v nut-num">${num(tot.grasa)}</span><span class="nut-macro-k">grasa g</span></div>
      <div class="nut-macro"><span class="nut-macro-v nut-num">${num(tot.kcal)}</span><span class="nut-macro-k">kcal</span></div>
    </div>
    ${cre ? `<div class="nut-creatina">💊 Creatina ${esc(cre.tipo || '')} · ${esc(cre.dosis_g || '')} g · ${esc(cre.frecuencia || '')}</div>` : ''}
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

function seccionSlot(slot) {
  const entradas = entradasSlot(slot.id);
  const totProt = entradas.reduce((s, e) => s + (Number(e.prot) || 0), 0);
  const abierto = S.picker && S.picker.slot === slot.id;
  return `
  <section class="nut-slot nut-card">
    <header class="nut-slot-head">
      <div>
        <h3 class="nut-slot-titulo">${esc(slot.label)}</h3>
        <div class="nut-slot-meta">${slot.hora ? esc(slot.hora) + ' h' : ''}${slot.nota ? (slot.hora ? ' · ' : '') + esc(slot.nota) : ''}</div>
      </div>
      ${entradas.length ? `<div class="nut-slot-prot"><span class="nut-num">${num(totProt)}</span> g prot</div>` : ''}
    </header>
    ${hintCompensacion(slot, entradas)}
    ${entradas.length ? entradas.map(filaEntrada).join('') : `<div class="nut-slot-vacio">Nada anotado todavía</div>`}
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
  return `
  <div class="nut-picker">
    <div class="nut-picker-head">
      <div class="nut-picker-tabs">
        ${tabs.map(([id, lbl]) => `<button class="nut-ptab${t === id ? ' activa' : ''}" data-action="picker-tab" data-ptab="${id}">${lbl}</button>`).join('')}
      </div>
      <button class="nut-icono" data-action="cerrar-picker" aria-label="Cerrar picker">✕</button>
    </div>
    ${cuerpo}
  </div>`;
}

function filaAlimento(a) {
  return `
  <div class="nut-item" data-action="add-alimento" data-id="${esc(a.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(a.nombre)}${a.porcion ? ` <span class="nut-item-porcion">${esc(a.porcion)}</span>` : ''}</div>
      <div class="nut-item-macros"><span class="nut-num">${num(a.prot)}</span> g prot · ${num(a.kcal)} kcal</div>
    </div>
    <button class="nut-icono nut-star${a.favorito ? ' activa' : ''}" data-action="fav" data-tipo="alimento" data-id="${esc(a.id)}" aria-label="Marcar favorito">${a.favorito ? '★' : '☆'}</button>
  </div>`;
}

function filaCombo(c) {
  return `
  <div class="nut-item" data-action="add-combo" data-id="${esc(c.id)}" role="button" tabindex="0">
    <div class="nut-item-info">
      <div class="nut-item-nombre">${esc(c.nombre)} <span class="nut-item-porcion">combo${c.slot ? ' · ' + esc(c.slot) : ''}</span></div>
      <div class="nut-item-macros"><span class="nut-num">${num(c.prot)}</span> g prot · ${num(c.kcal)} kcal</div>
    </div>
    <button class="nut-icono nut-star${c.favorito ? ' activa' : ''}" data-action="fav" data-tipo="combo" data-id="${esc(c.id)}" aria-label="Marcar favorito">${c.favorito ? '★' : '☆'}</button>
  </div>`;
}

function pickerFavoritos(slot) {
  const favs = [
    ...combosOrdenados(slot.id).filter(c => c.favorito).map(filaCombo),
    ...S.alimentos.filter(a => a.favorito).map(filaAlimento),
  ];
  if (!favs.length) return `<div class="nut-picker-vacio">Todavía no tenés favoritos.<br>Marcá con ☆ tus alimentos y combos más usados en las otras pestañas.</div>`;
  return `<div class="nut-picker-lista">${favs.join('')}</div>`;
}

function pickerCombos(slot) {
  if (!S.combos.length) return `<div class="nut-picker-vacio">No hay combos cargados. Corré el seed (sql/02_seed_nutricion.sql).</div>`;
  return `<div class="nut-picker-lista">${combosOrdenados(slot.id).map(filaCombo).join('')}</div>`;
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
  return items.map(filaAlimento).join('');
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
  <div class="nut-fechanav">
    <button class="nut-nav-btn" data-action="sem-prev" aria-label="Semana anterior">‹</button>
    <div class="nut-fechanav-centro">
      <div class="nut-fechanav-label">Semana del ${labelCorto(S.semana)} al ${labelCorto(addDias(S.semana, 6))}</div>
      ${esActual ? '' : `<button class="nut-chip" data-action="sem-hoy">Esta semana</button>`}
    </div>
    <button class="nut-nav-btn" data-action="sem-next" aria-label="Semana siguiente">›</button>
  </div>`;
}

function vistaSemana() {
  const slots = cfgSlots();
  const nav = navSemana();
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando la semana…</div>`;
  if (!slots.length) return nav + vacioConfig();
  const aviso = S.combos.length ? '' : `<div class="nut-hint">No hay combos cargados: corré el seed (sql/02_seed_nutricion.sql) para poder planificar.</div>`;
  const fechas = Array.from({ length: 7 }, (_, i) => addDias(S.semana, i));
  return nav + aviso + `<div class="nut-sem-grid">${fechas.map(f => diaCard(f, slots)).join('')}</div>`;
}

function diaCard(fecha, slots) {
  const esHoy = fecha === hoyStr();
  return `
  <div class="nut-sem-dia${esHoy ? ' nut-sem-hoy' : ''}">
    <div class="nut-sem-dia-head">${DIAS[diaIdx(fecha)]}<span class="nut-sem-fecha">${labelCorto(fecha)}</span></div>
    ${slots.map(sl => {
      const p = planDe(fecha, sl.id);
      const combo = p ? S.combos.find(c => c.id === p.combo_id) : null;
      let contenido;
      if (combo) {
        contenido = `<span class="nut-celda-combo">${esc(combo.nombre)}</span><span class="nut-celda-prot"><span class="nut-num">${num(combo.prot)}</span> g prot</span>`;
      } else if (p) {
        contenido = `<span class="nut-celda-mas">combo no disponible</span>`;
      } else {
        contenido = `<span class="nut-celda-mas">+ asignar</span>`;
      }
      return `
      <button class="nut-celda${combo ? ' nut-celda-llena' : ''}" data-action="celda" data-fecha="${fecha}" data-slot="${esc(sl.id)}">
        <span class="nut-celda-slot">${esc(sl.label)}</span>
        ${contenido}
      </button>`;
    }).join('')}
  </div>`;
}

function modalCombos() {
  const ctx = S.comboPicker;
  const slot = cfgSlots().find(s => s.id === ctx.slot);
  const actual = planDe(ctx.fecha, ctx.slot);
  const delSlot = S.combos.filter(c => c.slot === ctx.slot);
  const otros = S.combos.filter(c => c.slot !== ctx.slot);
  return `
  <div class="nut-modal" data-action="modal-fondo">
    <div class="nut-modal-card" role="dialog" aria-modal="true" aria-label="Elegir combo">
      <header class="nut-modal-head">
        <h3 class="nut-modal-titulo">${esc(slot ? slot.label : ctx.slot)} · ${labelFecha(ctx.fecha)}</h3>
        <button class="nut-icono" data-action="modal-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <div class="nut-modal-body">
        ${!S.combos.length ? `<div class="nut-picker-vacio">No hay combos cargados. Corré el seed (sql/02_seed_nutricion.sql).</div>` : ''}
        ${delSlot.length ? `<div class="nut-modal-grupo">Combos de ${esc(slot ? slot.label.toLowerCase() : ctx.slot)}</div>${delSlot.map(c => filaComboPlan(c, actual)).join('')}` : ''}
        ${otros.length ? `<div class="nut-modal-grupo">Otros combos</div>${otros.map(c => filaComboPlan(c, actual)).join('')}` : ''}
      </div>
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

/* ---------- Tab PREP ---------- */
function vistaPrep() {
  const nav = navSemana();
  if (S.cargando) return nav + `<div class="nut-cargando">Cargando la semana…</div>`;
  const { combos, ingredientes } = resumenSemana();
  if (!combos.length) return nav + vacioPlan();
  return nav + `
  <div class="nut-prep">
    <section class="nut-card">
      <h3 class="nut-card-titulo">🍳 A cocinar esta semana</h3>
      ${combos.map(({ combo, veces }) => `
      <div class="nut-prep-fila">
        <div class="nut-prep-nombre">${esc(combo.nombre)}${combo.slot ? ` <span class="nut-item-porcion">${esc(combo.slot)}</span>` : ''}</div>
        <div class="nut-prep-veces">× ${veces}</div>
      </div>`).join('')}
    </section>
    <section class="nut-card">
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
  <div class="nut-card nut-compras">
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
.nut-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

/* Header + tabs */
.nut-head { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.nut-head-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.nut-titulo { margin: 0; font-family: var(--font-display); font-size: 1.35rem; letter-spacing: .01em; }
.nut-ayuno { font-size: .75rem; color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: var(--space-1) var(--space-3); white-space: nowrap; }
.nut-tabs { display: flex; gap: var(--space-2); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.nut-tab { flex: 1 1 0; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
.nut-tab.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

/* Navegación fecha / semana */
.nut-fechanav { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.nut-nav-btn { width: 48px; min-height: 48px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 1.4rem; line-height: 1; color: var(--text-dim); }
.nut-nav-btn:active { background: var(--surface-2); }
.nut-fechanav-centro { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); min-width: 0; }
.nut-fechanav-label { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; text-align: center; }
.nut-chip { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: var(--space-1) var(--space-3); font-size: .78rem; min-height: 28px; }

/* Cards */
.nut-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--shadow-1); }
.nut-card-titulo { margin: 0 0 var(--space-3); font-family: var(--font-display); font-size: 1rem; }

/* Progreso de proteína */
.nut-prog { margin-bottom: var(--space-4); }
.nut-prog-fila { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
.nut-prog-num { font-size: 1.7rem; font-weight: 700; }
.nut-prog-de { font-size: .85rem; font-weight: 400; color: var(--text-dim); }
.nut-prog-estado { font-size: .82rem; }
.nut-zona-ok { color: var(--ok); }
.nut-zona-medio { color: var(--warn); }
.nut-zona-bajo { color: var(--danger); }
.nut-bar { position: relative; height: 14px; background: var(--surface-2); border-radius: 999px; }
.nut-bar-fill { height: 100%; border-radius: 999px; transition: width .35s ease; }
.nut-bar-bajo { background: var(--danger); }
.nut-bar-medio { background: linear-gradient(90deg, var(--warn), var(--ok)); }
.nut-bar-ok { background: linear-gradient(90deg, var(--accent), var(--ok)); }
.nut-bar-piso { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--text-dim); border-radius: 1px; }
.nut-macros { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-2); }
.nut-macro { background: var(--surface-2); border-radius: var(--radius); padding: var(--space-2); text-align: center; }
.nut-macro-v { display: block; font-size: 1.05rem; font-weight: 600; }
.nut-macro-k { display: block; font-size: .68rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }
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

/* Modal combos */
.nut-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--bg) 75%, transparent); backdrop-filter: blur(2px); }
.nut-modal-card { width: 100%; max-width: 480px; max-height: 82vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: var(--space-4); box-shadow: var(--shadow-2); }
.nut-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
.nut-modal-titulo { margin: 0; font-family: var(--font-display); font-size: 1rem; }
.nut-modal-body { flex: 1; overflow-y: auto; }
.nut-modal-grupo { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); margin: var(--space-3) 0 var(--space-1); }
.nut-modal-grupo:first-child { margin-top: 0; }

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

/* Desktop */
@media (min-width: 768px) {
  .nut { padding: var(--space-6); }
  .nut-tab { flex: none; }
  .nut-sem-grid { grid-template-columns: repeat(7, 1fr); }
  .nut-sem-dia { padding: var(--space-2); }
  .nut-manual-grid { grid-template-columns: repeat(4, 1fr); }
  .nut-modal { align-items: center; }
  .nut-modal-card { border-radius: var(--radius-lg); }
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
      await Promise.all([cargarCatalogo(), cargarLog(), cargarPlan()]);
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
      Promise.all([cargarLog(), cargarPlan()])
        .then(() => { S.cargando = false; paint(); })
        .catch(() => { S.cargando = false; paint(); toast('No se pudo actualizar el día', 'warning'); });
      return;
    }
    paint();
    // Refresco silencioso al volver de otra ruta (multi-device)
    if (Date.now() - S.ultimaCarga > 30000) {
      S.ultimaCarga = Date.now();
      Promise.all([cargarLog(), cargarPlan()])
        .then(() => paint())
        .catch(() => { /* silencioso: la data pintada coincide con su label */ });
    }
  },
};
