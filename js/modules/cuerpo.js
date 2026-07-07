// VIDA — Módulo Cuerpo (Ola 1 · señales vivas del cuerpo)
// ============================================================================
// Captura y visualiza las 4 señales base del cuerpo: PESO, ENERGÍA/ÁNIMO,
// SUEÑO e HIDRATACIÓN. Es el complemento "input crudo, cero data-entry pesado"
// del módulo Nutrición: un tap registra la señal del día y el instrumento la
// devuelve viva (anillos, count-up, tendencia suavizada, stagger).
//
// Data: TODO vive en la tabla-diario única `cuerpo_metricas` (id, user_id,
// fecha, tipo, valor jsonb, origen, nota, _deleted, created_at) — ver
// sql/08_cuerpo_metricas.sql. Cada señal es una fila con su `tipo` y un `valor`:
//   peso        → { kg, grasa_pct? }
//   energia     → { nivel, animo? }
//   sueno       → { horas, calidad? }
//   hidratacion → { ml, vasos }
// Regla de escritura: UNA fila por (user_id + fecha + tipo). Si ya existe la del
// día para ese tipo → UPDATE; si no → INSERT (upsert manual, sin depender de una
// constraint que la tabla no declara). Soft-delete vía `_deleted`.
//
// Config-driven (nada hardcodeado del usuario): qué señales mostrar sale de
// cuerpo.metricas_activas; targets de hidratacion/sueno/energia salen de config.
// El peso de referencia lo lee de nutricion.referencia_corporal si existe.
//
// Piel "Instrumento Vivo": importa el motor de core/anim.js (countUp, ring,
// stagger, tiltAll) + clases de css/motion.css. Todo respeta
// prefers-reduced-motion (lo garantiza anim.js/motion.css).
//
// Tolerancia: si la tabla no existe todavía (falta correr el SQL) o falla la
// conexión, cada carga degrada a "sin datos" / empty-state y NUNCA tira el
// módulo. Guards anti doble-tap en cada escritura.
// ============================================================================
import { supabase } from '../core/supabase.js';
import { getConfig } from '../core/config.js';
import { toast } from '../core/ui.js';
import { countUp, ring, stagger, tiltAll, reducedMotion } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local)
   ============================================================ */
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function parseFecha(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
function addDias(s, n) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); }
function diaIdxLunes(s) { return (parseFecha(s).getDay() + 6) % 7; }
function desdeRango(dias) { return addDias(hoyStr(), -(dias - 1)); }
function labelDiaCorto(s) { const d = parseFecha(s); return DIAS[diaIdxLunes(s)] + ' ' + d.getDate(); }

/* ============================================================
   Utilidades
   ============================================================ */
const NF1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
function num(n, dec = 1) {
  const v = Number(n) || 0;
  return dec === 1 ? NF1.format(v) : new Intl.NumberFormat('es-AR', { maximumFractionDigits: dec }).format(v);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function clampPct(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ============================================================
   Estado del módulo (el DOM se repinta entero en cada paint)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,          // moduleConfig('cuerpo') → .get()/.set()/.all()
  boundEl: null,         // container atado a los listeners (si cambia, re-bindea)
  rangoPeso: 30,         // 7 | 30 | 90 días para el gráfico de tendencia
  registros: [],         // cuerpo_metricas de la ventana visible (todas las señales)
  cargando: false,
  cargaId: 0,            // token anti-carrera de la carga
  guardando: new Set(),  // guards anti doble-tap por tipo ('peso','energia',...)
  tablaAusente: false,   // la tabla no existe todavía → degradación total
  editandoPeso: false,   // el input de peso está abierto
};

// Cuántos días necesito traer: máx(rango de peso, ventana de heatmap de energía).
const VENTANA_ENERGIA = 14;
function diasVentana() { return Math.max(S.rangoPeso, VENTANA_ENERGIA); }

/* ============================================================
   Config del usuario — TODO viene de user_config, nada hardcodeado
   ============================================================ */
function cfg(clave, fallback) {
  // Preferimos el wrapper moduleConfig que llega por init; si no, getConfig global.
  if (S.config && typeof S.config.get === 'function') return S.config.get(clave, fallback);
  return getConfig('cuerpo', clave, fallback);
}
function metricasActivas() {
  const m = cfg('metricas_activas', ['peso', 'energia', 'sueno', 'hidratacion']);
  const arr = Array.isArray(m) ? m.filter(x => typeof x === 'string') : [];
  return arr.length ? arr : ['peso', 'energia', 'sueno', 'hidratacion'];
}
function activa(tipo) { return metricasActivas().includes(tipo); }
function cfgHidratacion() {
  const h = cfg('hidratacion', {}) || {};
  return { mlTarget: toNum(h.ml_target) || 2500, mlVaso: toNum(h.ml_vaso) || 250 };
}
function cfgSueno() {
  const s = cfg('sueno', {}) || {};
  return { horasTarget: toNum(s.horas_target) || 8 };
}
function cfgEnergia() {
  const e = cfg('energia', {}) || {};
  const escala = toNum(e.escala);
  return { escala: escala && escala >= 2 ? Math.round(escala) : 5 };
}
// Peso de referencia: vive en el módulo Nutrición (no lo duplicamos).
function pesoReferencia() {
  const r = getConfig('nutricion', 'referencia_corporal', null);
  return r && toNum(r.peso_kg) ? toNum(r.peso_kg) : null;
}

/* ============================================================
   Datos — Supabase (siempre .eq('user_id') + .eq('_deleted', false))
   Tolerante: si la tabla falta o falla, degrada a "sin datos".
   ============================================================ */
async function cargarRegistros() {
  const id = ++S.cargaId;
  S.tablaAusente = false;
  if (!supabase || !S.userId) { S.registros = []; return true; }
  const desde = desdeRango(diasVentana());
  try {
    const { data, error } = await supabase.from('cuerpo_metricas')
      .select('id, fecha, tipo, valor, nota, created_at')
      .eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', desde).lte('fecha', hoyStr())
      .order('created_at');
    if (error) throw error;
    if (id !== S.cargaId) return false;       // llegó tarde
    S.registros = data || [];
    return true;
  } catch (err) {
    if (id !== S.cargaId) return false;
    S.registros = [];
    // 42P01 = tabla inexistente en Postgres → degradación explícita "sin datos".
    if (err && (err.code === '42P01' || /does not exist|relation .* does not exist/i.test(err.message || ''))) {
      S.tablaAusente = true;
    } else {
      console.warn('[cuerpo] cargarRegistros falló:', err);
    }
    return true; // seguimos: pintamos empty-state, no rompemos
  }
}

// Última fila de un tipo para una fecha (o null). Recorre de atrás → la más nueva.
function registroDia(tipo, fecha) {
  for (let i = S.registros.length - 1; i >= 0; i--) {
    const r = S.registros[i];
    if (r.tipo === tipo && String(r.fecha).slice(0, 10) === fecha) return r;
  }
  return null;
}
function valorDia(tipo, fecha) {
  const r = registroDia(tipo, fecha);
  return r && r.valor && typeof r.valor === 'object' ? r.valor : null;
}

/* ------------------------------------------------------------
   Escritura: UPSERT manual por (user_id + fecha + tipo).
   Si ya existe la fila del día para ese tipo → UPDATE; si no → INSERT.
   Guard anti doble-tap por `tipo`. Devuelve true si guardó.
   ------------------------------------------------------------ */
async function guardarSenal(tipo, valor, { nota = null, origen = 'manual' } = {}) {
  if (!supabase || !S.userId) { toast('Supabase no está configurado.', 'error'); return false; }
  if (S.guardando.has(tipo)) return false;         // ya hay una escritura de este tipo en vuelo
  S.guardando.add(tipo);
  const fecha = hoyStr();
  try {
    const existente = registroDia(tipo, fecha);
    if (existente) {
      const patch = { valor };
      if (nota !== null) patch.nota = nota;
      const { data, error } = await supabase.from('cuerpo_metricas')
        .update(patch).eq('id', existente.id).eq('user_id', S.userId)
        .select('id, fecha, tipo, valor, nota, created_at');
      if (error) throw error;
      // Reflejo local inmediato (evita releer para repintar).
      if (data && data[0]) Object.assign(existente, data[0]);
      else { existente.valor = valor; if (nota !== null) existente.nota = nota; }
    } else {
      const fila = { user_id: S.userId, fecha, tipo, valor, origen, _deleted: false };
      if (nota !== null) fila.nota = nota;
      const { data, error } = await supabase.from('cuerpo_metricas')
        .insert(fila).select('id, fecha, tipo, valor, nota, created_at');
      if (error) throw error;
      if (data && data[0]) S.registros.push(data[0]);
    }
    return true;
  } catch (err) {
    if (err && err.code === '42P01') {
      toast('Falta crear la tabla del cuerpo (correr sql/08).', 'error');
      S.tablaAusente = true;
    } else {
      toast('No se pudo guardar: ' + msgErr(err), 'error');
    }
    return false;
  } finally {
    S.guardando.delete(tipo);
  }
}

// Soft-delete de la señal de HOY de un tipo (deshacer un registro del día).
async function borrarSenalHoy(tipo) {
  if (!supabase || !S.userId || S.guardando.has(tipo)) return false;
  const fecha = hoyStr();
  const existente = registroDia(tipo, fecha);
  if (!existente) return false;
  S.guardando.add(tipo);
  try {
    const { error } = await supabase.from('cuerpo_metricas')
      .update({ _deleted: true }).eq('id', existente.id).eq('user_id', S.userId);
    if (error) throw error;
    S.registros = S.registros.filter(r => r.id !== existente.id);
    return true;
  } catch (err) {
    toast('No se pudo deshacer: ' + msgErr(err), 'error');
    return false;
  } finally {
    S.guardando.delete(tipo);
  }
}

/* ============================================================
   Derivados / series
   ============================================================ */
// Serie de peso [{fecha, kg}] ordenada, sólo días CON registro, dentro del rango.
function seriePeso(rango) {
  const desde = desdeRango(rango);
  const out = [];
  const vistos = new Set();
  // De atrás → adelante quedándome con el último registro de cada día.
  for (let i = S.registros.length - 1; i >= 0; i--) {
    const r = S.registros[i];
    if (r.tipo !== 'peso') continue;
    const f = String(r.fecha).slice(0, 10);
    if (f < desde || vistos.has(f)) continue;
    const kg = r.valor && toNum(r.valor.kg);
    if (kg == null) continue;
    vistos.add(f);
    out.push({ fecha: f, kg });
  }
  out.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  return out;
}

// Media móvil centrada (ventana pequeña) → línea suavizada de tendencia.
function mediaMovil(serie, ventana = 3) {
  const n = serie.length;
  if (n === 0) return [];
  const w = Math.max(1, Math.min(ventana, n));
  const half = Math.floor(w / 2);
  return serie.map((_, i) => {
    let suma = 0, cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) { suma += serie[j].kg; cnt++; }
    }
    return { fecha: serie[i].fecha, kg: suma / cnt };
  });
}

// Serie de energía últimos N días [{fecha, nivel|null, esHoy}].
function serieEnergia(dias) {
  const hoy = hoyStr();
  const out = [];
  for (let i = dias - 1; i >= 0; i--) {
    const f = addDias(hoy, -i);
    const v = valorDia('energia', f);
    out.push({ fecha: f, nivel: v ? toNum(v.nivel) : null, esHoy: f === hoy });
  }
  return out;
}

/* ============================================================
   Escalas / etiquetas de las señales blandas
   ============================================================ */
const ANIMO_EMOJI = ['😖', '😕', '😐', '🙂', '😄'];       // 1..5 (ánimo cualitativo)
function emojiEnergia(nivel, escala) {
  if (nivel == null) return '·';
  const idx = Math.max(0, Math.min(ANIMO_EMOJI.length - 1, Math.round((nivel - 1) / (escala - 1) * (ANIMO_EMOJI.length - 1))));
  return ANIMO_EMOJI[idx];
}
function colorEnergia(nivel, escala) {
  if (nivel == null) return 'var(--surface-2)';
  const t = (nivel - 1) / (escala - 1);           // 0..1
  if (t >= 0.75) return 'var(--ok)';
  if (t >= 0.5) return 'var(--accent)';
  if (t >= 0.25) return 'var(--warn)';
  return 'var(--danger)';
}
const CALIDAD_SUENO = [
  { v: 'mala', label: 'Mala', emoji: '🥱' },
  { v: 'ok', label: 'Normal', emoji: '😴' },
  { v: 'buena', label: 'Buena', emoji: '💤' },
];

/* ============================================================
   RENDER — se repinta el container entero; luego se animan anillos/count-up.
   Cada tarjeta es independiente y sólo se pinta si su métrica está activa.
   ============================================================ */

// ---------- Tarjeta PESO: valor de hoy + input inline + gráfico de tendencia ----------
function cardPeso() {
  const hoy = hoyStr();
  const vHoy = valorDia('peso', hoy);
  const serie = seriePeso(S.rangoPeso);
  const ref = pesoReferencia();

  const ultimo = serie.length ? serie[serie.length - 1] : null;
  const primero = serie.length ? serie[0] : null;
  const delta = (ultimo && primero && serie.length > 1) ? ultimo.kg - primero.kg : null;
  const kgHoy = vHoy ? toNum(vHoy.kg) : null;
  const grasaHoy = vHoy ? toNum(vHoy.grasa_pct) : null;

  const valorGrande = kgHoy != null
    ? `<span class="cue-num" data-count="${kgHoy}" data-dec="1" data-suffix=" kg">0 kg</span>`
    : (ultimo ? `<span class="cue-num cue-stale">${num(ultimo.kg)} kg</span>` : `<span class="cue-dash">—</span>`);

  const sub = kgHoy != null
    ? (grasaHoy != null ? `Registrado hoy · ${num(grasaHoy)}% grasa` : 'Registrado hoy')
    : (ultimo ? `Último: ${labelDiaCorto(ultimo.fecha)}` : 'Sin registros todavía');

  const deltaTag = delta != null && Math.abs(delta) >= 0.05
    ? `<span class="cue-delta ${delta < 0 ? 'cue-delta-down' : 'cue-delta-up'}">${delta < 0 ? '↓' : '↑'} ${num(Math.abs(delta))} kg</span>`
    : '';

  const editor = S.editandoPeso ? `
    <div class="cue-peso-form">
      <div class="cue-field">
        <label>Peso (kg)</label>
        <input type="number" inputmode="decimal" step="0.1" min="0" class="cue-input" id="cuePesoKg" value="${kgHoy != null ? kgHoy : ''}" placeholder="${ultimo ? num(ultimo.kg) : '0.0'}">
      </div>
      <div class="cue-field">
        <label>Grasa % <span class="cue-opt">(opcional)</span></label>
        <input type="number" inputmode="decimal" step="0.1" min="0" max="100" class="cue-input" id="cuePesoGrasa" value="${grasaHoy != null ? grasaHoy : ''}" placeholder="—">
      </div>
      <div class="cue-form-actions">
        <button type="button" class="cue-btn cue-btn-ghost" data-act="peso-cancelar">Cancelar</button>
        <button type="button" class="cue-btn cue-btn-primary" data-act="peso-guardar">Guardar</button>
      </div>
    </div>` : `
    <div class="cue-peso-cta">
      <button type="button" class="cue-btn cue-btn-soft" data-act="peso-abrir">${kgHoy != null ? 'Editar peso de hoy' : '+ Registrar peso'}</button>
      ${kgHoy != null ? `<button type="button" class="cue-icon-btn" data-act="peso-borrar" title="Deshacer registro de hoy">✕</button>` : ''}
    </div>`;

  return `
  <article class="cue-card cue-card-peso rise lively" data-tilt>
    <header class="cue-card-head">
      <div class="cue-card-title"><span class="cue-ic cue-ic-peso">⚖️</span> Peso</div>
      <div class="cue-range">
        ${[7, 30, 90].map(r => `<button type="button" class="cue-range-btn ${S.rangoPeso === r ? 'is-on' : ''}" data-act="rango-peso" data-r="${r}">${r}d</button>`).join('')}
      </div>
    </header>

    <div class="cue-peso-read">
      <div class="cue-big">${valorGrande}${deltaTag}</div>
      <div class="cue-sub">${esc(sub)}</div>
    </div>

    ${graficoPeso(serie, ref)}
    ${editor}
  </article>`;
}

// Gráfico de tendencia SVG: puntos crudos + línea de media móvil suavizada.
function graficoPeso(serie, ref) {
  if (!serie.length) {
    return `<div class="cue-chart-empty">Registrá tu peso unos días y acá aparece la tendencia.</div>`;
  }
  const W = 640, H = 180, PADX = 14, PADY = 20;
  const suave = mediaMovil(serie, serie.length >= 5 ? 3 : 1);
  const kgs = serie.map(p => p.kg).concat(suave.map(p => p.kg));
  let min = Math.min(...kgs), max = Math.max(...kgs);
  if (ref != null) { min = Math.min(min, ref); max = Math.max(max, ref); }
  if (max - min < 1) { const mid = (max + min) / 2; min = mid - 0.75; max = mid + 0.75; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;

  const n = serie.length;
  const x = (i) => PADX + (n === 1 ? (W - 2 * PADX) / 2 : (i / (n - 1)) * (W - 2 * PADX));
  const y = (kg) => PADY + (1 - (kg - min) / (max - min)) * (H - 2 * PADY);

  // Área bajo la línea suavizada (relleno tenue).
  const linePts = suave.map((p, i) => `${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`);
  const linePath = 'M' + linePts.join(' L');
  const areaPath = `M${x(0).toFixed(1)},${(H - PADY).toFixed(1)} L` + linePts.join(' L') + ` L${x(n - 1).toFixed(1)},${(H - PADY).toFixed(1)} Z`;

  // Puntos crudos.
  const dots = serie.map((p, i) => {
    const esUlt = i === n - 1;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="${esUlt ? 4.5 : 2.6}" class="cue-dot ${esUlt ? 'cue-dot-last' : ''}"><title>${esc(labelDiaCorto(p.fecha))}: ${num(p.kg)} kg</title></circle>`;
  }).join('');

  // Línea de referencia (peso objetivo/referencia), si entra en rango.
  const refLine = (ref != null) ? `
    <line x1="${PADX}" y1="${y(ref).toFixed(1)}" x2="${W - PADX}" y2="${y(ref).toFixed(1)}" class="cue-refline"></line>
    <text x="${W - PADX}" y="${(y(ref) - 5).toFixed(1)}" class="cue-reftext" text-anchor="end">ref ${num(ref)}</text>` : '';

  const dash = reducedMotion() ? '' : 'cue-line-draw';
  return `
  <div class="cue-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cue-chart-svg" role="img" aria-label="Tendencia de peso">
      <defs>
        <linearGradient id="cuePesoArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity="0.22"></stop>
          <stop offset="1" stop-color="var(--accent)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${refLine}
      <path d="${areaPath}" class="cue-area"></path>
      <path d="${linePath}" class="cue-line ${dash}"></path>
      ${dots}
    </svg>
    <div class="cue-chart-axis"><span>${esc(labelDiaCorto(serie[0].fecha))}</span><span>${esc(labelDiaCorto(serie[n - 1].fecha))}</span></div>
  </div>`;
}

// ---------- Tarjeta ENERGÍA/ÁNIMO: check de 2 taps (orbes) + heatmap ----------
function cardEnergia() {
  const { escala } = cfgEnergia();
  const hoy = hoyStr();
  const vHoy = valorDia('energia', hoy);
  const nivelHoy = vHoy ? toNum(vHoy.nivel) : null;
  const serie = serieEnergia(VENTANA_ENERGIA);

  const orbes = [];
  for (let n = 1; n <= escala; n++) {
    const on = nivelHoy != null && n <= nivelHoy;
    orbes.push(`
      <button type="button" class="cue-orb ${on ? 'is-on' : ''} ${nivelHoy === n ? 'is-sel' : ''}" data-act="energia-set" data-nivel="${n}" style="--orb:${colorEnergia(n, escala)}" title="Nivel ${n}" aria-label="Energía nivel ${n}">
        <span class="cue-orb-face">${emojiEnergia(n, escala)}</span>
      </button>`);
  }

  const heat = serie.map(d => {
    const col = colorEnergia(d.nivel, escala);
    const cls = d.nivel == null ? 'cue-heat-empty' : '';
    return `<span class="cue-heat ${cls} ${d.esHoy ? 'cue-heat-hoy' : ''}" style="--hc:${col}" title="${esc(labelDiaCorto(d.fecha))}${d.nivel != null ? ' · nivel ' + d.nivel : ' · sin registro'}"></span>`;
  }).join('');

  const estado = nivelHoy != null
    ? `<span class="cue-num">${emojiEnergia(nivelHoy, escala)}</span> Nivel ${nivelHoy}/${escala} hoy`
    : 'Tocá un orbe para marcar tu energía de hoy';

  return `
  <article class="cue-card rise lively" data-tilt>
    <header class="cue-card-head">
      <div class="cue-card-title"><span class="cue-ic cue-ic-energia">⚡</span> Energía / ánimo</div>
      ${nivelHoy != null ? `<button type="button" class="cue-icon-btn" data-act="energia-borrar" title="Deshacer">✕</button>` : ''}
    </header>
    <div class="cue-orbs">${orbes.join('')}</div>
    <div class="cue-sub cue-energia-estado">${estado}</div>
    <div class="cue-heatwrap">
      <span class="cue-heatlbl">${VENTANA_ENERGIA} días</span>
      <div class="cue-heatrow">${heat}</div>
    </div>
  </article>`;
}

// ---------- Tarjeta SUEÑO: horas dormidas (+calidad) vs target ----------
function cardSueno() {
  const { horasTarget } = cfgSueno();
  const hoy = hoyStr();
  const vHoy = valorDia('sueno', hoy);
  const horasHoy = vHoy ? toNum(vHoy.horas) : null;
  const calHoy = vHoy ? (vHoy.calidad || null) : null;
  const pct = horasHoy != null ? clampPct(horasHoy / horasTarget * 100) : 0;

  // Anillo con el avance hacia el target de sueño.
  const anillo = `
    <div class="cue-ring">
      <svg viewBox="0 0 96 96" class="cue-ring-svg">
        <circle class="v-ring-track" cx="48" cy="48" r="40" style="stroke-width:8"></circle>
        <circle class="v-ring-fill" cx="48" cy="48" r="40" style="stroke-width:8;stroke:var(--accent-2)" data-pct="${pct}"></circle>
      </svg>
      <div class="cue-ring-center">
        ${horasHoy != null
      ? `<span class="cue-num" data-count="${horasHoy}" data-dec="1">0</span><span class="cue-ring-u">h</span>`
      : `<span class="cue-dash">—</span>`}
      </div>
    </div>`;

  const chips = [4, 5, 6, 7, 8, 9, 10].map(h =>
    `<button type="button" class="cue-chip ${horasHoy === h ? 'is-on' : ''}" data-act="sueno-set" data-horas="${h}">${h}h</button>`
  ).join('');

  const calChips = CALIDAD_SUENO.map(c =>
    `<button type="button" class="cue-chip cue-chip-cal ${calHoy === c.v ? 'is-on' : ''}" data-act="sueno-cal" data-cal="${c.v}" title="${c.label}">${c.emoji} ${c.label}</button>`
  ).join('');

  const sub = horasHoy != null
    ? `${num(horasHoy)}h de ${num(horasTarget)}h${calHoy ? ' · ' + (CALIDAD_SUENO.find(c => c.v === calHoy) || {}).label : ''}`
    : `Objetivo: ${num(horasTarget)}h`;

  return `
  <article class="cue-card rise lively" data-tilt>
    <header class="cue-card-head">
      <div class="cue-card-title"><span class="cue-ic cue-ic-sueno">🌙</span> Sueño</div>
      ${horasHoy != null ? `<button type="button" class="cue-icon-btn" data-act="sueno-borrar" title="Deshacer">✕</button>` : ''}
    </header>
    <div class="cue-sueno-body">
      ${anillo}
      <div class="cue-sueno-side">
        <div class="cue-sub">${esc(sub)}</div>
        <div class="cue-chips">${chips}</div>
        <div class="cue-chips cue-chips-cal">${calChips}</div>
      </div>
    </div>
  </article>`;
}

// ---------- Tarjeta HIDRATACIÓN: +1 vaso, anillo que se llena al target ----------
function cardHidratacion() {
  const { mlTarget, mlVaso } = cfgHidratacion();
  const hoy = hoyStr();
  const vHoy = valorDia('hidratacion', hoy);
  const ml = vHoy ? (toNum(vHoy.ml) || 0) : 0;
  const vasos = vHoy ? (toNum(vHoy.vasos) || 0) : 0;
  const pct = clampPct(ml / mlTarget * 100);
  const vasosTarget = Math.max(1, Math.round(mlTarget / mlVaso));

  const anillo = `
    <div class="cue-ring cue-ring-agua">
      <svg viewBox="0 0 96 96" class="cue-ring-svg">
        <circle class="v-ring-track" cx="48" cy="48" r="40" style="stroke-width:8"></circle>
        <circle class="v-ring-fill" cx="48" cy="48" r="40" style="stroke-width:8;stroke:var(--accent-2)" data-pct="${pct}"></circle>
      </svg>
      <div class="cue-ring-center">
        <span class="cue-num" data-count="${vasos}">0</span>
        <span class="cue-ring-u">/ ${vasosTarget} vasos</span>
      </div>
    </div>`;

  return `
  <article class="cue-card rise lively" data-tilt>
    <header class="cue-card-head">
      <div class="cue-card-title"><span class="cue-ic cue-ic-agua">💧</span> Hidratación</div>
      ${vasos > 0 ? `<button type="button" class="cue-icon-btn" data-act="agua-borrar" title="Reiniciar hoy">✕</button>` : ''}
    </header>
    <div class="cue-agua-body">
      ${anillo}
      <div class="cue-agua-side">
        <div class="cue-sub"><span class="cue-num">${num(ml, 0)}</span> ml de ${num(mlTarget, 0)} ml</div>
        <div class="cue-agua-actions">
          <button type="button" class="cue-btn cue-btn-primary cue-btn-agua" data-act="agua-mas">+1 vaso <span class="cue-agua-ml">${num(mlVaso, 0)} ml</span></button>
          <button type="button" class="cue-btn cue-btn-ghost cue-btn-menos ${vasos <= 0 ? 'is-disabled' : ''}" data-act="agua-menos" ${vasos <= 0 ? 'disabled' : ''}>−1</button>
        </div>
      </div>
    </div>
  </article>`;
}

// Arma la grilla de tarjetas según metricas_activas (config-driven).
function cardsHtml() {
  const orden = ['peso', 'energia', 'sueno', 'hidratacion'];
  const fns = { peso: cardPeso, energia: cardEnergia, sueno: cardSueno, hidratacion: cardHidratacion };
  const cards = orden.filter(activa).map(t => fns[t]());
  if (!cards.length) {
    return `<div class="cue-empty">No hay señales activas. Activá alguna en la config del módulo (cuerpo.metricas_activas).</div>`;
  }
  return `<section class="cue-grid">${cards.join('')}</section>`;
}

// Repinta el módulo entero + dispara animaciones (anillos, count-up, stagger, tilt).
function paint() {
  if (!S.container) return;

  if (!supabase) {
    S.container.innerHTML = `<div class="cue"><div class="cue-empty">Supabase no está configurado (ver SETUP.md).</div></div>`;
    return;
  }
  if (S.cargando) { paintCargando(); return; }

  const avisoTabla = S.tablaAusente
    ? `<div class="cue-note">Todavía no está creada la tabla del cuerpo. Corré <code>sql/08_cuerpo_metricas.sql</code> en Supabase y volvé. Mientras tanto ves el módulo en vacío.</div>`
    : '';

  S.container.innerHTML = `
  <div class="cue">
    <header class="cue-head rise">
      <div>
        <h1 class="cue-h1">Cuerpo</h1>
        <p class="cue-hint">Las señales de hoy · un tap y quedan registradas</p>
      </div>
    </header>
    ${avisoTabla}
    ${cardsHtml()}
  </div>`;

  // Animaciones: anillos SVG → count-ups → entrada escalonada → tilt magnético.
  S.container.querySelectorAll('.v-ring-fill').forEach(c => ring(c, +c.getAttribute('data-pct') || 0));
  S.container.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const decimals = +el.getAttribute('data-dec') || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    countUp(el, to, { decimals, suffix });
  });
  stagger(S.container.querySelectorAll('.rise'));
  tiltAll(S.container);

  // Si el editor de peso está abierto, foco al input (mejor captura).
  if (S.editandoPeso) {
    const inp = S.container.querySelector('#cuePesoKg');
    if (inp) inp.focus();
  }
}

/* ============================================================
   Estado de carga (skeleton vivo, mismo lenguaje que home)
   ============================================================ */
function paintCargando() {
  if (!S.container) return;
  const skel = () => `<div class="cue-card"><div class="shimmer" style="height:16px;width:38%;margin-bottom:14px"></div><div class="shimmer" style="height:120px"></div></div>`;
  S.container.innerHTML = `
  <div class="cue">
    <header class="cue-head"><div><h1 class="cue-h1">Cuerpo</h1><p class="cue-hint">Cargando tus señales…</p></div></header>
    <section class="cue-grid">${[0, 1, 2, 3].map(skel).join('')}</section>
  </div>`;
}

/* ============================================================
   Eventos — delegación (bindea 1 vez). Cada acción escribe y repinta.
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) S.boundEl.removeEventListener('click', onClick);
  S.container.addEventListener('click', onClick);
  S.boundEl = S.container;
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !S.container.contains(btn)) return;
  const act = btn.dataset.act;

  // --- Peso: rango del gráfico ---
  if (act === 'rango-peso') {
    const r = +btn.dataset.r || 30;
    if (r === S.rangoPeso) return;
    const necesitaMas = r > diasVentana();
    S.rangoPeso = r;
    if (necesitaMas) { await montar(); }        // hay que traer más historia
    else paint();                                // ya está en memoria → sólo repinta
    return;
  }
  // --- Peso: abrir/cerrar editor ---
  if (act === 'peso-abrir') { S.editandoPeso = true; paint(); return; }
  if (act === 'peso-cancelar') { S.editandoPeso = false; paint(); return; }
  if (act === 'peso-guardar') { await guardarPesoDesdeForm(); return; }
  if (act === 'peso-borrar') {
    if (await borrarSenalHoy('peso')) { toast('Registro de peso deshecho', 'success'); paint(); }
    return;
  }

  // --- Energía: set nivel (2 taps: abrir módulo = tap implícito, orbe = tap real) ---
  if (act === 'energia-set') {
    const nivel = +btn.dataset.nivel || 0;
    if (!nivel) return;
    const actual = valorDia('energia', hoyStr());
    const valor = { nivel };
    if (actual && actual.animo) valor.animo = actual.animo;
    if (await guardarSenal('energia', valor)) { toast('Energía registrada ⚡', 'success'); paint(); }
    return;
  }
  if (act === 'energia-borrar') {
    if (await borrarSenalHoy('energia')) { toast('Energía deshecha', 'success'); paint(); }
    return;
  }

  // --- Sueño: horas / calidad ---
  if (act === 'sueno-set') {
    const horas = +btn.dataset.horas || 0;
    if (!horas) return;
    const actual = valorDia('sueno', hoyStr());
    const valor = { horas };
    if (actual && actual.calidad) valor.calidad = actual.calidad;
    if (await guardarSenal('sueno', valor)) { toast('Sueño registrado 🌙', 'success'); paint(); }
    return;
  }
  if (act === 'sueno-cal') {
    const cal = btn.dataset.cal;
    const actual = valorDia('sueno', hoyStr());
    // La calidad sola no tiene sentido sin horas: si no hay horas aún, guardo horas=target.
    const horas = actual && toNum(actual.horas) != null ? toNum(actual.horas) : cfgSueno().horasTarget;
    if (await guardarSenal('sueno', { horas, calidad: cal })) { paint(); }
    return;
  }
  if (act === 'sueno-borrar') {
    if (await borrarSenalHoy('sueno')) { toast('Sueño deshecho', 'success'); paint(); }
    return;
  }

  // --- Hidratación: +1 / −1 vaso ---
  if (act === 'agua-mas') { await sumarVaso(1); return; }
  if (act === 'agua-menos') { await sumarVaso(-1); return; }
  if (act === 'agua-borrar') {
    if (await borrarSenalHoy('hidratacion')) { toast('Hidratación reiniciada', 'success'); paint(); }
    return;
  }
}

// Suma (o resta) un vaso a la hidratación de hoy y persiste ml + vasos.
async function sumarVaso(dir) {
  const { mlVaso } = cfgHidratacion();
  const actual = valorDia('hidratacion', hoyStr());
  const vasosPrev = actual ? (toNum(actual.vasos) || 0) : 0;
  const vasos = Math.max(0, vasosPrev + dir);
  if (vasos === vasosPrev) return;               // nada que hacer (ya en 0)
  const valor = { vasos, ml: vasos * mlVaso };
  if (await guardarSenal('hidratacion', valor)) paint();
}

// Lee el form de peso, valida y guarda { kg, grasa_pct? }.
async function guardarPesoDesdeForm() {
  const kgEl = S.container.querySelector('#cuePesoKg');
  const grasaEl = S.container.querySelector('#cuePesoGrasa');
  const kg = kgEl ? toNum(kgEl.value) : null;
  const grasa = grasaEl ? toNum(grasaEl.value) : null;
  if (kg == null || kg <= 0 || kg > 500) { toast('Ingresá un peso válido (kg).', 'warning'); if (kgEl) kgEl.focus(); return; }
  const valor = { kg };
  if (grasa != null && grasa > 0 && grasa < 100) valor.grasa_pct = grasa;
  if (await guardarSenal('peso', valor)) {
    S.editandoPeso = false;
    toast('Peso registrado ⚖️', 'success');
    paint();
  }
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo cue-, sólo var(--token) + motion.css
   ============================================================ */
const CSS = `
.cue { max-width: 1040px; margin: 0 auto; padding: var(--space-2) 0 var(--space-6); font-family: var(--font-ui); color: var(--text); }
.cue * { box-sizing: border-box; }
.cue-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.cue-dash { color: var(--text-faint); font-family: var(--font-num); }

/* Header */
.cue-head { margin-bottom: var(--space-5); }
.cue-h1 { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: clamp(1.5rem, 4vw, 2rem); letter-spacing: -.02em; }
.cue-hint { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: .9rem; }

.cue-note { margin: 0 0 var(--space-4); padding: var(--space-3) var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-size: .84rem; }
.cue-note code { font-family: var(--font-num); color: var(--accent); }
.cue-empty { padding: var(--space-6); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); color: var(--text-dim); text-align: center; font-size: .9rem; }

/* Grilla de tarjetas */
.cue-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.cue-card-peso { grid-column: 1 / -1; }
@media (max-width: 720px) { .cue-grid { grid-template-columns: 1fr; } }

.cue-card { position: relative; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.cue-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-2); }
.cue-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-4); }
.cue-card-title { display: flex; align-items: center; gap: var(--space-2); font-size: .82rem; font-weight: 800; letter-spacing: .01em; color: var(--text); }
.cue-ic { width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center; font-size: 1rem; background: var(--surface-2); }
.cue-ic-peso, .cue-ic-energia { background: var(--accent-soft); }
.cue-ic-sueno, .cue-ic-agua { background: var(--accent-2-soft); }

.cue-sub { font-size: .82rem; color: var(--text-dim); }
.cue-opt { color: var(--text-faint); font-weight: 500; }

/* Botones */
.cue-btn { font-family: var(--font-ui); font-weight: 700; font-size: .84rem; border-radius: var(--radius); border: 1px solid transparent; cursor: pointer; padding: 9px 15px; transition: transform var(--dur) var(--ease-out-expo), background var(--dur) ease, border-color var(--dur) ease, color var(--dur) ease; }
.cue-btn:active { transform: translateY(1px); }
.cue-btn-primary { background: var(--accent); color: #052018; }
.cue-btn-primary:hover { box-shadow: 0 0 18px 1px var(--accent-soft); }
.cue-btn-soft { background: var(--accent-soft); color: var(--accent); }
.cue-btn-ghost { background: transparent; color: var(--text-dim); border-color: var(--border-strong); }
.cue-btn-ghost:hover { color: var(--text); border-color: var(--text-faint); }
.cue-btn.is-disabled, .cue-btn:disabled { opacity: .4; cursor: default; }
.cue-icon-btn { width: 26px; height: 26px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-faint); cursor: pointer; font-size: .72rem; line-height: 1; transition: color var(--dur) ease, border-color var(--dur) ease; }
.cue-icon-btn:hover { color: var(--danger); border-color: var(--danger); }

/* --- PESO --- */
.cue-range { display: flex; gap: 4px; }
.cue-range-btn { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); font-family: var(--font-num); font-size: .72rem; font-weight: 700; cursor: pointer; transition: all var(--dur) ease; }
.cue-range-btn.is-on { background: var(--accent-soft); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.cue-peso-read { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.cue-big { display: flex; align-items: baseline; gap: var(--space-3); }
.cue-big .cue-num { font-size: 2.4rem; font-weight: 700; line-height: 1; }
.cue-stale { color: var(--text-dim); }
.cue-delta { font-family: var(--font-num); font-size: .82rem; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
.cue-delta-down { color: var(--ok); background: rgba(67,209,124,.13); }
.cue-delta-up { color: var(--warn); background: rgba(232,182,76,.13); }

.cue-chart { margin-top: var(--space-2); }
.cue-chart-svg { width: 100%; height: 180px; display: block; overflow: visible; }
.cue-area { fill: url(#cuePesoArea); stroke: none; }
.cue-line { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.cue-dot { fill: var(--surface); stroke: var(--accent); stroke-width: 1.6; }
.cue-dot-last { fill: var(--accent); stroke: var(--bg); stroke-width: 2; }
.cue-refline { stroke: var(--text-faint); stroke-width: 1; stroke-dasharray: 4 4; opacity: .6; }
.cue-reftext { fill: var(--text-faint); font-family: var(--font-num); font-size: 11px; }
.cue-chart-axis { display: flex; justify-content: space-between; margin-top: 4px; font-family: var(--font-num); font-size: .68rem; color: var(--text-faint); }
.cue-chart-empty { margin-top: var(--space-2); padding: var(--space-6) var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius); color: var(--text-dim); text-align: center; font-size: .84rem; }
@keyframes cue-draw { to { stroke-dashoffset: 0; } }
.cue-line-draw { stroke-dasharray: 2000; stroke-dashoffset: 2000; animation: cue-draw 1.1s var(--ease-out-expo) forwards; }

.cue-peso-cta { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-4); }
.cue-peso-form { margin-top: var(--space-4); display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-items: end; }
.cue-field { display: flex; flex-direction: column; gap: 5px; }
.cue-field label { font-size: .72rem; font-weight: 700; color: var(--text-dim); }
.cue-input { width: 100%; padding: 9px 11px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); font-family: var(--font-num); font-size: 1rem; }
.cue-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.cue-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 460px) { .cue-peso-form { grid-template-columns: 1fr; } }

/* --- ENERGÍA --- */
.cue-orbs { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.cue-orb { position: relative; width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer; display: grid; place-items: center; transition: transform var(--dur) var(--ease-spring), border-color var(--dur) ease, box-shadow var(--dur) ease, background var(--dur) ease; }
.cue-orb:hover { transform: translateY(-2px) scale(1.04); }
.cue-orb-face { font-size: 1.25rem; filter: grayscale(.7); opacity: .55; transition: filter var(--dur) ease, opacity var(--dur) ease; }
.cue-orb.is-on { background: color-mix(in srgb, var(--orb) 16%, var(--surface-2)); border-color: color-mix(in srgb, var(--orb) 55%, transparent); }
.cue-orb.is-on .cue-orb-face { filter: none; opacity: 1; }
.cue-orb.is-sel { box-shadow: 0 0 0 2px var(--orb), 0 0 18px 1px color-mix(in srgb, var(--orb) 45%, transparent); border-color: var(--orb); }
.cue-energia-estado { display: flex; align-items: center; gap: 6px; }
.cue-energia-estado .cue-num { font-size: 1.1rem; }
.cue-heatwrap { margin-top: var(--space-4); }
.cue-heatlbl { display: block; font-size: .66rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 6px; }
.cue-heatrow { display: flex; gap: 4px; }
.cue-heat { flex: 1; height: 22px; border-radius: 5px; background: var(--hc); min-width: 8px; }
.cue-heat-empty { background: var(--surface-2); border: 1px dashed var(--border); }
.cue-heat-hoy { outline: 2px solid var(--text-faint); outline-offset: 1px; }

/* --- SUEÑO + HIDRATACIÓN (anillos) --- */
.cue-sueno-body, .cue-agua-body { display: flex; align-items: center; gap: var(--space-4); }
.cue-ring { position: relative; width: 96px; height: 96px; flex: none; }
.cue-ring-svg { width: 96px; height: 96px; transform: rotate(-90deg); }
.cue-ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
.cue-ring-center .cue-num { font-size: 1.6rem; font-weight: 700; line-height: 1; }
.cue-ring-u { font-size: .64rem; color: var(--text-faint); font-weight: 700; }
.cue-sueno-side, .cue-agua-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.cue-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.cue-chip { padding: 6px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-dim); font-family: var(--font-num); font-size: .76rem; font-weight: 700; cursor: pointer; transition: all var(--dur) ease; }
.cue-chip:hover { border-color: var(--text-faint); color: var(--text); }
.cue-chip.is-on { background: var(--accent-2-soft); color: var(--accent-2); border-color: color-mix(in srgb, var(--accent-2) 45%, transparent); }
.cue-chip-cal { font-family: var(--font-ui); }
.cue-chips-cal { margin-top: 2px; }

.cue-agua-actions { display: flex; align-items: center; gap: var(--space-2); }
.cue-btn-agua { display: inline-flex; align-items: center; gap: 7px; }
.cue-agua-ml { font-family: var(--font-num); font-size: .68rem; opacity: .7; font-weight: 600; }
.cue-btn-menos { padding: 9px 13px; font-family: var(--font-num); }
.cue-ring-agua .v-ring-fill { filter: drop-shadow(0 0 5px var(--accent-2-soft)); }

@media (max-width: 380px) {
  .cue-sueno-body, .cue-agua-body { flex-direction: column; align-items: flex-start; }
}
`;

function inyectarEstilos() {
  if (document.getElementById('cue-styles')) return;
  const st = document.createElement('style');
  st.id = 'cue-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Orquestación
   ============================================================ */
async function montar() {
  S.cargando = true;
  paintCargando();
  const ok = await cargarRegistros();
  if (!ok) return;             // otra carga se hizo cargo
  S.cargando = false;
  paint();
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'cuerpo',
  label: 'Cuerpo',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.registros = [];
    S.editandoPeso = false;
    S.cargando = true;
    inyectarEstilos();
    bind();
    await montar();
  },

  render() {
    if (!S.container) return;
    // Al volver de otro módulo el container tiene otro DOM → re-bindear + recargar.
    bind();
    montar();
  },
};
