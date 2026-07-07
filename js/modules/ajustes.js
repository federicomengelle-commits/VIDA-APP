// VIDA — Módulo AJUSTES · la "regla de oro" hecha pantalla (Instrumento Vivo)
// ============================================================================
// CLAUDE.md §0: NADA del usuario hardcodeado. Metas, horarios, slots, categorías
// viven en `user_config` y ESTA pantalla los hace editables sin tocar SQL.
//
// A diferencia del resto de módulos, Ajustes lee/escribe config de VARIOS módulos
// (nutricion · plata · insights), así que NO usa el `S.config` scoped que le pasa
// el router — importa getConfig/setConfig directo de core/config.js. setConfig ya
// hace upsert a user_config { user_id, modulo, clave, valor } (PK user_id,modulo,
// clave; valor jsonb) Y refresca el cache en memoria, así que el resto de la app
// ve el cambio sin recargar. Ver core/config.js.
//
// Regla estricta: los defaults acá son del SISTEMA (formas vacías, placeholders,
// umbrales de palancas.js). NUNCA se inventan valores del usuario: si una clave no
// existe, el campo queda vacío/placeholder y sólo se persiste lo que Fede tipea.
//
// Lenguaje: cards .lively, entrada .rise + stagger, prefijo CSS `aju-`, sólo
// var(--token) + motion.css, prefers-reduced-motion respetado (vía anim.js).
// ============================================================================
import { getConfig, setConfig } from '../core/config.js';
import { toast } from '../core/ui.js';
import { stagger, tiltAll } from '../core/anim.js';
import { UMBRALES_DEFAULT } from '../core/palancas.js';

/* ============================================================
   Estado
   ============================================================ */
const S = {
  container: null,
  userId: null,
  boundEl: null,
  guardando: new Set(), // claves de sección en vuelo → guard anti doble-tap
};

/* ============================================================
   Utilidades
   ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// Slug estable para el `id` de un slot/ámbito nuevo, derivado del label.
function slugify(txt) {
  const base = String(txt || '')
    .toLowerCase()
    .normalize('NFD')                 // separa acentos (á → a + ´)
    .replace(/[^a-z0-9]+/g, '_')      // todo lo no alfanumérico (incl. acentos sueltos) → _
    .replace(/^_+|_+$/g, '');
  return base || ('item_' + Math.random().toString(36).slice(2, 7));
}
// Normaliza "9:5" / "0900" / "09:00" → "HH:MM" o '' si no se entiende.
function normHora(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) return '';
  let h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  let mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/* ============================================================
   Lectura de config (con fallback a forma vacía; NUNCA valores del usuario)
   ============================================================ */
function readProteina() {
  const t = getConfig('nutricion', 'proteina_target', null) || {};
  return { target_g: t.target_g ?? '', piso_g: t.piso_g ?? '' };
}
function readSlots() {
  const s = getConfig('nutricion', 'slots', null);
  const arr = Array.isArray(s) ? s : [];
  return arr
    .filter(x => x && (x.id || x.label))
    .map(x => ({ id: x.id || slugify(x.label), label: x.label || '', hora: x.hora || '' }));
}
function readAyuno() {
  const a = getConfig('nutricion', 'ayuno', null) || {};
  return { ultima_comida: a.ultima_comida || '', primera_comida: a.primera_comida || '' };
}
function readUmbrales() {
  const u = getConfig('insights', 'umbrales', null) || {};
  return {
    adherencia_baja: u.adherencia_baja ?? '',
    dias_sin_entrenar: u.dias_sin_entrenar ?? '',
    prot_margen_pct: u.prot_margen_pct ?? '',
  };
}
function readPulso() {
  // pulso_pesos suelto, o el sub-objeto .pulso dentro de umbrales (palancas.js
  // acepta ambos). Priorizamos la clave dedicada.
  const p = getConfig('insights', 'pulso_pesos', null)
    || (getConfig('insights', 'umbrales', null) || {}).pulso
    || {};
  return {
    adherencia: p.adherencia ?? '',
    proteina: p.proteina ?? '',
    training: p.training ?? '',
  };
}
function readMonedas() {
  const m = getConfig('plata', 'monedas', null);
  return Array.isArray(m) ? m.filter(x => typeof x === 'string' && x.trim()) : [];
}
function readCategorias() {
  const c = getConfig('plata', 'categorias', null) || {};
  const norm = (l) => (Array.isArray(l) ? l.filter(x => typeof x === 'string' && x.trim()) : []);
  return { ingreso: norm(c.ingreso), egreso: norm(c.egreso) };
}

/* ============================================================
   Guardado — setConfig (upsert user_config + refresca cache). Guard anti
   doble-tap por sección; toast de éxito/error. Devuelve bool.
   ============================================================ */
async function guardar(seccionKey, modulo, clave, valor, okMsg) {
  if (S.guardando.has(seccionKey)) return false;
  S.guardando.add(seccionKey);
  const btn = S.container?.querySelector(`[data-save="${seccionKey}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('aju-saving'); }
  try {
    await setConfig(modulo, clave, valor);
    toast(okMsg || 'Guardado ✓', 'success');
    return true;
  } catch (err) {
    console.error('[ajustes] guardar falló:', err);
    toast(err?.message || 'No se pudo guardar. Probá de nuevo.', 'error');
    return false;
  } finally {
    S.guardando.delete(seccionKey);
    if (btn) { btn.disabled = false; btn.classList.remove('aju-saving'); }
  }
}

/* ============================================================
   Handlers de guardado por sección (leen del DOM → arman el jsonb → persisten
   → re-pintan para reflejar lo normalizado).
   ============================================================ */
async function guardarProteina() {
  const target = numOrNull(val('#aju-prot-target'));
  const piso = numOrNull(val('#aju-prot-piso'));
  if (target != null && piso != null && piso > target) {
    toast('El piso no puede ser mayor al target.', 'warning');
    return;
  }
  // Preserva otras claves que la nutricionista pudiera haber guardado.
  const prev = getConfig('nutricion', 'proteina_target', null) || {};
  const valor = { ...prev };
  if (target != null) valor.target_g = target; else delete valor.target_g;
  if (piso != null) valor.piso_g = piso; else delete valor.piso_g;
  if (await guardar('proteina', 'nutricion', 'proteina_target', valor, 'Proteína actualizada ✓')) montar();
}

async function guardarSlots() {
  const filas = [...S.container.querySelectorAll('[data-slot-row]')];
  const slots = [];
  const vistos = new Set();
  for (const fila of filas) {
    const label = String(fila.querySelector('[data-slot-label]')?.value || '').trim();
    if (!label) continue; // fila vacía → se descarta
    const hora = normHora(fila.querySelector('[data-slot-hora]')?.value);
    let id = fila.getAttribute('data-slot-id') || slugify(label);
    while (vistos.has(id)) id += '_2';
    vistos.add(id);
    const slot = { id, label };
    if (hora) slot.hora = hora;
    slots.push(slot);
  }
  if (await guardar('slots', 'nutricion', 'slots', slots, 'Slots de comida actualizados ✓')) montar();
}

async function guardarAyuno() {
  const ultima = normHora(val('#aju-ayuno-ultima'));
  const primera = normHora(val('#aju-ayuno-primera'));
  if ((val('#aju-ayuno-ultima').trim() && !ultima) || (val('#aju-ayuno-primera').trim() && !primera)) {
    toast('Usá el formato HH:MM en las horas de ayuno.', 'warning');
    return;
  }
  const valor = {};
  if (ultima) valor.ultima_comida = ultima;
  if (primera) valor.primera_comida = primera;
  if (await guardar('ayuno', 'nutricion', 'ayuno', valor, 'Ventana de ayuno actualizada ✓')) montar();
}

async function guardarInsights() {
  // Umbrales: preserva las claves que no editamos acá (gym_dias_sin_uso, etc.).
  const prevU = getConfig('insights', 'umbrales', null) || {};
  const umbrales = { ...prevU };
  const setNum = (obj, key, sel) => {
    const n = numOrNull(val(sel));
    if (n != null) obj[key] = n; else delete obj[key];
  };
  setNum(umbrales, 'adherencia_baja', '#aju-umb-adh');
  setNum(umbrales, 'dias_sin_entrenar', '#aju-umb-dias');
  setNum(umbrales, 'prot_margen_pct', '#aju-umb-prot');

  // Pesos del Pulso: los tres campos. Si quedan todos vacíos, no forzamos la clave.
  const pa = numOrNull(val('#aju-pulso-adh'));
  const pp = numOrNull(val('#aju-pulso-prot'));
  const pt = numOrNull(val('#aju-pulso-tra'));
  const algunPeso = pa != null || pp != null || pt != null;

  const okU = await guardar('insights', 'insights', 'umbrales', umbrales, 'Umbrales de insights actualizados ✓');
  if (okU && algunPeso) {
    const prevP = getConfig('insights', 'pulso_pesos', null) || {};
    const pulso = { ...prevP };
    if (pa != null) pulso.adherencia = pa;
    if (pp != null) pulso.proteina = pp;
    if (pt != null) pulso.training = pt;
    await guardar('pulso', 'insights', 'pulso_pesos', pulso, 'Pesos del Pulso actualizados ✓');
  }
  if (okU) montar();
}

async function guardarMonedas() {
  const monedas = chipsDe('monedas'); // ya normalizadas (mayúsculas, sin repes)
  if (await guardar('monedas', 'plata', 'monedas', monedas, 'Monedas actualizadas ✓')) montar();
}

async function guardarCategorias() {
  const prev = getConfig('plata', 'categorias', null) || {};
  const valor = { ...prev, ingreso: chipsDe('cat-ingreso'), egreso: chipsDe('cat-egreso') };
  if (await guardar('categorias', 'plata', 'categorias', valor, 'Categorías actualizadas ✓')) montar();
}

/* ============================================================
   Estado en vivo de los "chips" (monedas/categorías) — se mantiene en el DOM,
   se lee al guardar. Cada grupo es un contenedor [data-chips="<grupo>"].
   ============================================================ */
function chipsDe(grupo) {
  const cont = S.container.querySelector(`[data-chips="${grupo}"]`);
  if (!cont) return [];
  const out = [];
  const vistos = new Set();
  cont.querySelectorAll('[data-chip-val]').forEach(el => {
    let v = String(el.getAttribute('data-chip-val') || '').trim();
    if (grupo === 'monedas') v = v.toUpperCase();
    const k = v.toLowerCase();
    if (v && !vistos.has(k)) { vistos.add(k); out.push(v); }
  });
  return out;
}
// Agrega un chip al grupo (sin persistir todavía; el guardado lee el DOM).
function agregarChip(grupo, valorCrudo) {
  let v = String(valorCrudo || '').trim();
  if (!v) return;
  if (grupo === 'monedas') v = v.toUpperCase();
  const cont = S.container.querySelector(`[data-chips="${grupo}"]`);
  if (!cont) return;
  const existe = [...cont.querySelectorAll('[data-chip-val]')]
    .some(el => String(el.getAttribute('data-chip-val')).toLowerCase() === v.toLowerCase());
  if (existe) { toast('Ya está en la lista.', 'info'); return; }
  cont.insertAdjacentHTML('beforeend', chipHtml(grupo, v));
}

/* ============================================================
   Helpers de lectura del DOM
   ============================================================ */
function val(sel) {
  const el = S.container.querySelector(sel);
  return el ? String(el.value ?? '') : '';
}

/* ============================================================
   Render — HTML puro por sección
   ============================================================ */
function field(id, label, value, opts = {}) {
  const { type = 'text', ph = '', suffix = '', inputmode = '', step = '', min = '', max = '' } = opts;
  const attrs = [
    `id="${id}"`,
    `type="${type}"`,
    `class="aju-input"`,
    `value="${esc(value)}"`,
    ph ? `placeholder="${esc(ph)}"` : '',
    inputmode ? `inputmode="${inputmode}"` : '',
    step ? `step="${step}"` : '',
    min !== '' ? `min="${min}"` : '',
    max !== '' ? `max="${max}"` : '',
  ].filter(Boolean).join(' ');
  return `
    <label class="aju-field">
      <span class="aju-field-lbl">${esc(label)}</span>
      <span class="aju-field-wrap">
        <input ${attrs} />
        ${suffix ? `<span class="aju-suffix">${esc(suffix)}</span>` : ''}
      </span>
    </label>`;
}

function chipHtml(grupo, valor) {
  return `<span class="aju-chip" data-chip-val="${esc(valor)}">
    <span class="aju-chip-tx">${esc(valor)}</span>
    <button type="button" class="aju-chip-x" data-chip-del aria-label="Quitar ${esc(valor)}">×</button>
  </span>`;
}

function chipsBlock(grupo, label, valores, ph) {
  return `
    <div class="aju-chips-block">
      <span class="aju-field-lbl">${esc(label)}</span>
      <div class="aju-chips" data-chips="${grupo}">
        ${valores.map(v => chipHtml(grupo, v)).join('') || `<span class="aju-chips-empty">Sin ${esc(label.toLowerCase())} todavía</span>`}
      </div>
      <div class="aju-add">
        <input type="text" class="aju-input aju-add-in" data-chip-input="${grupo}" placeholder="${esc(ph)}" />
        <button type="button" class="aju-btn-ghost" data-chip-add="${grupo}">Agregar</button>
      </div>
    </div>`;
}

function slotRowHtml(slot) {
  return `
    <div class="aju-slot-row" data-slot-row data-slot-id="${esc(slot.id || '')}">
      <input type="text" class="aju-input aju-slot-name" data-slot-label value="${esc(slot.label || '')}" placeholder="Nombre (ej. Almuerzo)" />
      <input type="text" class="aju-input aju-slot-time" data-slot-hora value="${esc(slot.hora || '')}" placeholder="HH:MM" inputmode="numeric" />
      <button type="button" class="aju-chip-x aju-slot-del" data-slot-del aria-label="Quitar slot">×</button>
    </div>`;
}

function sectionHtml({ id, icono, kicker, titulo, desc, body, saveLabel }) {
  return `
    <section class="aju-card lively rise" data-tilt>
      <header class="aju-card-head">
        <span class="aju-card-ic">${icono}</span>
        <div class="aju-card-titles">
          <span class="aju-kicker">${esc(kicker)}</span>
          <h2 class="aju-card-h">${esc(titulo)}</h2>
          ${desc ? `<p class="aju-card-desc">${esc(desc)}</p>` : ''}
        </div>
      </header>
      <div class="aju-card-body">${body}</div>
      <footer class="aju-card-foot">
        <button type="button" class="aju-save" data-save="${id}">
          <span class="aju-save-tx">${esc(saveLabel || 'Guardar')}</span>
          <svg class="aju-save-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
        </button>
      </footer>
    </section>`;
}

function paint() {
  if (!S.container) return;

  const prot = readProteina();
  const slots = readSlots();
  const ayuno = readAyuno();
  const umb = readUmbrales();
  const pulso = readPulso();
  const monedas = readMonedas();
  const cats = readCategorias();

  // Placeholders de umbrales = defaults del SISTEMA (palancas.js), no del usuario.
  const uDef = UMBRALES_DEFAULT;

  const bodyProteina = `
    <div class="aju-grid-2">
      ${field('aju-prot-target', 'Target diario', prot.target_g, { type: 'number', ph: 'ej. 160', suffix: 'g', inputmode: 'decimal', min: 0 })}
      ${field('aju-prot-piso', 'Piso (día flojo)', prot.piso_g, { type: 'number', ph: 'ej. 140', suffix: 'g', inputmode: 'decimal', min: 0 })}
    </div>`;

  const bodySlots = `
    <div class="aju-slots" data-slots>
      <div class="aju-slots-head">
        <span class="aju-col-lbl">Comida</span>
        <span class="aju-col-lbl">Hora</span>
        <span></span>
      </div>
      ${slots.map(slotRowHtml).join('') || `<p class="aju-hint">No hay slots configurados. Agregá el primero.</p>`}
      <button type="button" class="aju-btn-ghost aju-add-row" data-slot-agregar>+ Agregar comida</button>
    </div>`;

  const bodyAyuno = `
    <div class="aju-grid-2">
      ${field('aju-ayuno-ultima', 'Última comida', ayuno.ultima_comida, { ph: '21:00', inputmode: 'numeric' })}
      ${field('aju-ayuno-primera', 'Primera comida', ayuno.primera_comida, { ph: '14:00', inputmode: 'numeric' })}
    </div>
    <p class="aju-hint">La ventana va de la última comida a la primera del día siguiente. Café negro y agua no la rompen.</p>`;

  const bodyInsights = `
    <div class="aju-sub">Umbrales de las palancas</div>
    <div class="aju-grid-3">
      ${field('aju-umb-adh', 'Adherencia baja', umb.adherencia_baja, { type: 'number', ph: String(uDef.adherencia_baja), suffix: '%', inputmode: 'numeric', min: 0, max: 100 })}
      ${field('aju-umb-dias', 'Días sin entrenar', umb.dias_sin_entrenar, { type: 'number', ph: String(uDef.dias_sin_entrenar), suffix: 'días', inputmode: 'numeric', min: 0 })}
      ${field('aju-umb-prot', 'Margen de proteína', umb.prot_margen_pct, { type: 'number', ph: String(uDef.prot_margen_pct), suffix: '%', inputmode: 'numeric', min: 0, max: 100 })}
    </div>
    <div class="aju-sub">Pesos del Pulso VIDA</div>
    <div class="aju-grid-3">
      ${field('aju-pulso-adh', 'Rutina', pulso.adherencia, { type: 'number', ph: String(uDef.pulso.adherencia), inputmode: 'decimal', step: '0.05', min: 0, max: 1 })}
      ${field('aju-pulso-prot', 'Proteína', pulso.proteina, { type: 'number', ph: String(uDef.pulso.proteina), inputmode: 'decimal', step: '0.05', min: 0, max: 1 })}
      ${field('aju-pulso-tra', 'Training', pulso.training, { type: 'number', ph: String(uDef.pulso.training), inputmode: 'decimal', step: '0.05', min: 0, max: 1 })}
    </div>
    <p class="aju-hint">Los pesos se normalizan solos: importan las proporciones, no que sumen 1.</p>`;

  const bodyMonedas = chipsBlock('monedas', 'Monedas', monedas, 'ej. ARS, USD');
  const bodyCategorias = `
    ${chipsBlock('cat-ingreso', 'Categorías de ingreso', cats.ingreso, 'ej. Sueldo, MEPEX')}
    ${chipsBlock('cat-egreso', 'Categorías de egreso', cats.egreso, 'ej. Súper, Gym, Salud')}`;

  S.container.innerHTML = `
  <div class="aju">
    <header class="aju-head rise">
      <div>
        <h1 class="aju-title">Ajustes</h1>
        <p class="aju-lead">Todo lo que mueve VIDA sale de acá. Cambialo sin tocar código — se guarda al toque y el resto de la app lo toma solo.</p>
      </div>
    </header>

    <div class="aju-dom-lbl rise"><span class="aju-cap">Cuerpo · Nutrición</span><span class="aju-rule"></span></div>
    <div class="aju-dom-grid">
      ${sectionHtml({ id: 'proteina', icono: '🥩', kicker: 'Meta diaria', titulo: 'Proteína', desc: 'Tu objetivo de gramos por día y el piso para días complicados.', body: bodyProteina, saveLabel: 'Guardar proteína' })}
      ${sectionHtml({ id: 'ayuno', icono: '🕒', kicker: 'Ventana', titulo: 'Ayuno intermitente', desc: 'Cuándo cerrás y cuándo abrís la ventana de comida.', body: bodyAyuno, saveLabel: 'Guardar ayuno' })}
    </div>
    <div class="aju-dom-grid aju-dom-grid-1">
      ${sectionHtml({ id: 'slots', icono: '🍽️', kicker: 'Comidas del día', titulo: 'Slots de comida', desc: 'Las franjas del día donde registrás lo que comés.', body: bodySlots, saveLabel: 'Guardar slots' })}
    </div>

    <div class="aju-dom-lbl rise"><span class="aju-cap">Plata</span><span class="aju-rule"></span></div>
    <div class="aju-dom-grid">
      ${sectionHtml({ id: 'monedas', icono: '💵', kicker: 'Divisas', titulo: 'Monedas', desc: 'Las monedas con las que registrás movimientos.', body: bodyMonedas, saveLabel: 'Guardar monedas' })}
      ${sectionHtml({ id: 'categorias', icono: '🏷️', kicker: 'Clasificación', titulo: 'Categorías', desc: 'Cómo agrupás ingresos y egresos.', body: bodyCategorias, saveLabel: 'Guardar categorías' })}
    </div>

    <div class="aju-dom-lbl rise"><span class="aju-cap">Insights · Palancas</span><span class="aju-rule"></span></div>
    <div class="aju-dom-grid aju-dom-grid-1">
      ${sectionHtml({ id: 'insights', icono: '⚡', kicker: 'Motor de cruces', titulo: 'Umbrales y Pulso', desc: 'Cuándo saltan las palancas y cuánto pesa cada dominio en el Pulso VIDA.', body: bodyInsights, saveLabel: 'Guardar insights' })}
    </div>
  </div>`;

  stagger(S.container.querySelectorAll('.rise'));
  tiltAll(S.container);
}

/* ============================================================
   Eventos — delegación (bindea 1 vez sobre el container)
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) {
    S.boundEl.removeEventListener('click', onClick);
    S.boundEl.removeEventListener('keydown', onKeydown);
  }
  S.container.addEventListener('click', onClick);
  S.container.addEventListener('keydown', onKeydown);
  S.boundEl = S.container;
}

function onClick(e) {
  // Guardar sección
  const save = e.target.closest('[data-save]');
  if (save && S.container.contains(save)) {
    dispatchGuardar(save.getAttribute('data-save'));
    return;
  }
  // Agregar chip (monedas / categorías)
  const add = e.target.closest('[data-chip-add]');
  if (add && S.container.contains(add)) {
    const grupo = add.getAttribute('data-chip-add');
    const input = S.container.querySelector(`[data-chip-input="${grupo}"]`);
    agregarChip(grupo, input?.value);
    if (input) { input.value = ''; input.focus(); }
    return;
  }
  // Quitar chip
  const del = e.target.closest('[data-chip-del]');
  if (del && S.container.contains(del)) {
    const chip = del.closest('.aju-chip');
    if (chip) chip.remove();
    return;
  }
  // Agregar fila de slot
  const addRow = e.target.closest('[data-slot-agregar]');
  if (addRow && S.container.contains(addRow)) {
    const cont = S.container.querySelector('[data-slots]');
    const hint = cont?.querySelector('.aju-hint');
    if (hint) hint.remove();
    addRow.insertAdjacentHTML('beforebegin', slotRowHtml({ id: '', label: '', hora: '' }));
    const nuevas = cont?.querySelectorAll('[data-slot-label]');
    nuevas?.[nuevas.length - 1]?.focus();
    return;
  }
  // Quitar fila de slot
  const delRow = e.target.closest('[data-slot-del]');
  if (delRow && S.container.contains(delRow)) {
    delRow.closest('[data-slot-row]')?.remove();
    return;
  }
}

// Enter en el input de un chip → agregarlo (UX de "escribí y enter").
function onKeydown(e) {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('[data-chip-input]');
  if (input && S.container.contains(input)) {
    e.preventDefault();
    const grupo = input.getAttribute('data-chip-input');
    agregarChip(grupo, input.value);
    input.value = '';
    input.focus();
  }
}

function dispatchGuardar(id) {
  switch (id) {
    case 'proteina': return guardarProteina();
    case 'slots': return guardarSlots();
    case 'ayuno': return guardarAyuno();
    case 'insights': return guardarInsights();
    case 'monedas': return guardarMonedas();
    case 'categorias': return guardarCategorias();
  }
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo aju-, sólo var(--token) + motion.css
   ============================================================ */
const CSS = `
.aju { max-width: 1040px; margin: 0 auto; padding: var(--space-2) 0 var(--space-8); font-family: var(--font-ui); color: var(--text); }
.aju * { box-sizing: border-box; }
.aju-cap { font-size: .68rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

/* Header */
.aju-head { margin-bottom: var(--space-6); }
.aju-title { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: clamp(1.6rem, 4vw, 2.2rem); letter-spacing: -.02em; }
.aju-lead { margin: var(--space-2) 0 0; color: var(--text-dim); font-size: .95rem; max-width: 62ch; line-height: 1.5; }

/* Etiqueta de dominio */
.aju-dom-lbl { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-6) 2px var(--space-3); }
.aju-dom-lbl:first-of-type { margin-top: 0; }
.aju-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--border-strong), transparent); }

/* Grid de cards por dominio */
.aju-dom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-bottom: var(--space-3); }
.aju-dom-grid-1 { grid-template-columns: 1fr; }
@media (max-width: 720px) { .aju-dom-grid { grid-template-columns: 1fr; } }

/* Card */
.aju-card { position: relative; display: flex; flex-direction: column; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.aju-card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); opacity: .5; }
.aju-card:hover { border-color: var(--border-strong); }
.aju-card-head { display: flex; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-4); }
.aju-card-ic { width: 34px; height: 34px; flex: none; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); font-size: 1.05rem; }
.aju-card-titles { min-width: 0; }
.aju-kicker { font-size: .64rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
.aju-card-h { margin: 2px 0 0; font-family: var(--font-display); font-weight: 700; font-size: 1.1rem; letter-spacing: -.01em; }
.aju-card-desc { margin: var(--space-2) 0 0; color: var(--text-dim); font-size: .82rem; line-height: 1.45; }
.aju-card-body { flex: 1; display: flex; flex-direction: column; gap: var(--space-4); }

/* Grids internos de campos */
.aju-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.aju-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
@media (max-width: 480px) { .aju-grid-2, .aju-grid-3 { grid-template-columns: 1fr; } }

/* Sub-título dentro de una card */
.aju-sub { font-size: .7rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); margin-top: var(--space-1); }

/* Campo */
.aju-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.aju-field-lbl { font-size: .78rem; font-weight: 700; color: var(--text-dim); }
.aju-field-wrap { position: relative; display: flex; align-items: center; }
.aju-input { width: 100%; min-height: 44px; padding: 10px var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-ui); font-size: .92rem; transition: border-color var(--dur) ease, box-shadow var(--dur) ease, background var(--dur) ease; }
.aju-input::placeholder { color: var(--text-faint); }
.aju-input:hover { border-color: var(--border-strong); }
.aju-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface); }
.aju-field-wrap .aju-input { padding-right: 44px; }
.aju-suffix { position: absolute; right: var(--space-3); font-family: var(--font-num); font-size: .78rem; color: var(--text-faint); pointer-events: none; }

/* Slots (filas) */
.aju-slots { display: flex; flex-direction: column; gap: var(--space-2); }
.aju-slots-head { display: grid; grid-template-columns: 1fr 120px 40px; gap: var(--space-2); padding: 0 2px; }
.aju-col-lbl { font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }
.aju-slot-row { display: grid; grid-template-columns: 1fr 120px 40px; gap: var(--space-2); align-items: center; }
.aju-slot-time { text-align: center; font-family: var(--font-num); }
.aju-slot-del { align-self: center; }
@media (max-width: 480px) { .aju-slots-head { grid-template-columns: 1fr 96px 36px; } .aju-slot-row { grid-template-columns: 1fr 96px 36px; } }

/* Chips (monedas / categorías) */
.aju-chips-block { display: flex; flex-direction: column; gap: var(--space-2); }
.aju-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); min-height: 34px; align-items: center; }
.aju-chips-empty { font-size: .8rem; color: var(--text-faint); font-style: italic; }
.aju-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 6px 6px 12px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: .82rem; font-weight: 600; color: var(--text); }
.aju-chip-tx { line-height: 1; }
.aju-chip-x { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border: none; border-radius: 50%; background: transparent; color: var(--text-faint); font-size: 1.1rem; line-height: 1; cursor: pointer; transition: background var(--dur) ease, color var(--dur) ease; }
.aju-chip-x:hover { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
.aju-slot-del { width: 40px; height: 40px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-faint); font-size: 1.2rem; cursor: pointer; }
.aju-slot-del:hover { border-color: var(--danger); color: var(--danger); }

/* Fila de "agregar" (chip nuevo) */
.aju-add { display: flex; gap: var(--space-2); }
.aju-add-in { flex: 1; }
.aju-btn-ghost { flex: none; min-height: 44px; padding: 0 var(--space-4); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-family: var(--font-ui); font-size: .84rem; font-weight: 700; cursor: pointer; transition: color var(--dur) ease, border-color var(--dur) ease, background var(--dur) ease; }
.aju-btn-ghost:hover { color: var(--text); border-color: var(--text-faint); background: var(--surface-2); }
.aju-add-row { align-self: flex-start; margin-top: var(--space-1); }

/* Hint */
.aju-hint { margin: 0; font-size: .78rem; color: var(--text-faint); line-height: 1.45; }

/* Footer + botón guardar */
.aju-card-foot { margin-top: var(--space-5); display: flex; justify-content: flex-end; }
.aju-save { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: var(--radius); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-soft); color: var(--accent); font-family: var(--font-ui); font-size: .86rem; font-weight: 800; cursor: pointer; transition: background var(--dur) ease, border-color var(--dur) ease, transform var(--dur) var(--ease-out-expo), opacity var(--dur) ease; }
.aju-save:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); transform: translateY(-1px); }
.aju-save:active { transform: translateY(0); }
.aju-save:disabled { opacity: .55; cursor: default; transform: none; }
.aju-save-ic { width: 16px; height: 16px; }
.aju-save.aju-saving .aju-save-ic { animation: vida-heart 1s ease-in-out infinite; }
`;

function inyectarEstilos() {
  if (document.getElementById('aju-styles')) return;
  const st = document.createElement('style');
  st.id = 'aju-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
function montar() {
  paint();
}

export default {
  id: 'ajustes',
  label: 'Ajustes',

  async init(container, userId /*, config */) {
    S.container = container;
    S.userId = userId;
    inyectarEstilos();
    bind();
    montar();
  },

  render() {
    if (!S.container) return;
    // Al volver de otro módulo el container tiene otro DOM → re-pintar desde la
    // config vigente en cache (que ya refleja lo último guardado).
    montar();
  },
};
