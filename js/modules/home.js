// VIDA — Módulo HOME · el cockpit "Instrumento Vivo" (Ola 1, sin IA)
// ============================================================================
// La cara de VIDA: lo primero que ves al entrar. No es una grilla de módulos —
// es un tablero vivo que reúne los 4 núcleos y, arriba de todo, el PULSO VIDA
// (un número que late) y las PALANCAS cruzadas (lo que el sistema encontró
// cruzando comida + plata + gym + hábitos). BACKLOG.md §6, REDISENO.md.
//
// Arquitectura: separa CARGA (Supabase) de RENDER (puro). `init()` carga datos,
// arma el estado y llama a renderCockpit(); ese render también se exporta para
// poder verificarlo con datos mock sin login (harness local). El motor de
// animación vive en core/anim.js; las palancas en core/palancas.js.
//
// Read-only sobre las tablas de otros módulos (mismo criterio que insights.js):
// cada carga es tolerante a tabla ausente → degrada, nunca tira el cockpit.
// ============================================================================
import { supabase } from '../core/supabase.js';
import { getConfig } from '../core/config.js';
import { navigate } from '../core/router.js';
import { toast } from '../core/ui.js';
import { calcularPalancas, pulsoVida, dominiosDe } from '../core/palancas.js';
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local, semana desde LUNES)
   ============================================================ */
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function parseFecha(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
function addDias(s, n) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); }
function diaSemLunes(s) { const d = parseFecha(s).getDay(); return (d + 6) % 7; }
function desdeRango(dias) { return addDias(hoyStr(), -(dias - 1)); }
function primerDiaMes(s) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), 1)); }
function labelFechaLarga(s) { const d = parseFecha(s); return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`; }
function saludoHora() { const h = new Date().getHours(); return h < 12 ? 'Buen día' : (h < 20 ? 'Buenas tardes' : 'Buenas noches'); }

/* ============================================================
   Utilidades
   ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtNum(n, dec = 0) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
}
function simboloMoneda(mon) {
  const m = String(mon || '').toUpperCase();
  if (m === 'ARS') return '$';
  if (m === 'USD') return 'US$';
  return m ? m + ' ' : '';
}
function clampPct(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }

// Categorías de egreso "fitness/salud" derivadas de la config real (no hardcode).
const RE_ACTIVIDAD = /gym|gimnas|salud|fitness|m[eé]dic|nutri|entren/i;
function categoriasActividad() {
  const cats = getConfig('plata', 'categorias', {});
  const egreso = cats && Array.isArray(cats.egreso) ? cats.egreso : [];
  return new Set(egreso.filter(c => RE_ACTIVIDAD.test(String(c))));
}

/* ============================================================
   Estado
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,
  boundEl: null,
  datos: null,
  cargando: true,
  cargaId: 0,
};

/* ============================================================
   Carga por dominio (tolerante; devuelve resumen o {estado:'error'})
   ============================================================ */

// ---- Nutrición: proteína hoy, promedio 7d, target/piso, compensación ----
async function cargarNutricion() {
  try {
    const cfg = getConfig('nutricion', 'proteina_target', null);
    const target = cfg && Number(cfg.target_g) > 0 ? Number(cfg.target_g) : null;
    const piso = cfg && Number(cfg.piso_g) > 0 ? Number(cfg.piso_g) : null;
    const compensacion = getConfig('nutricion', 'compensacion', null);
    const hoy = hoyStr();
    const { data, error } = await supabase.from('nutricion_log')
      .select('fecha, prot').eq('user_id', S.userId)
      .gte('fecha', desdeRango(7)).lte('fecha', hoy);
    if (error) throw error;
    const rows = data || [];
    const porDia = new Map();
    for (const r of rows) {
      const f = String(r.fecha).slice(0, 10);
      porDia.set(f, (porDia.get(f) || 0) + (Number(r.prot) || 0));
    }
    let suma = 0;
    for (let i = 0; i < 7; i++) suma += (porDia.get(addDias(hoy, -i)) || 0);
    return {
      estado: rows.length ? 'ok' : 'vacio',
      protHoy: porDia.get(hoy) || 0,
      protTarget: target, protPiso: piso,
      prom7: suma / 7,
      compensacion,
    };
  } catch (_) { return { estado: 'error' }; }
}

// ---- Plata: balance del mes (moneda principal) + gasto fitness del mes ----
async function cargarPlata() {
  try {
    const mesActual = primerDiaMes(hoyStr());
    const hoy = hoyStr();
    const { data, error } = await supabase.from('plata_movimientos')
      .select('fecha, tipo, monto, moneda, categoria').eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', mesActual).lte('fecha', hoy);
    if (error) throw error;
    const rows = data || [];
    const catsAct = categoriasActividad();

    const porMoneda = new Map();       // mon → { ingreso, egreso }
    let gastoFitness = 0, nFitness = 0, monFitness = '';
    for (const m of rows) {
      const mon = String(m.moneda || '').toUpperCase();
      const monto = Number(m.monto) || 0;
      if (!porMoneda.has(mon)) porMoneda.set(mon, { ingreso: 0, egreso: 0 });
      const b = porMoneda.get(mon);
      if (m.tipo === 'ingreso') b.ingreso += monto; else b.egreso += monto;
      if (m.tipo === 'egreso' && catsAct.has(m.categoria)) { gastoFitness += monto; nFitness++; if (!monFitness) monFitness = mon; }
    }
    // Moneda principal = la de mayor movimiento total.
    let principal = null, maxMov = -1;
    for (const [mon, b] of porMoneda) {
      const mov = b.ingreso + b.egreso;
      if (mov > maxMov) { maxMov = mov; principal = mon; }
    }
    const bp = principal ? porMoneda.get(principal) : null;
    const balanceMes = bp ? bp.ingreso - bp.egreso : null;
    const tasaAhorro = bp && bp.ingreso > 0 ? clampPct((bp.ingreso - bp.egreso) / bp.ingreso * 100) : null;
    return {
      estado: rows.length ? 'ok' : 'vacio',
      balanceMes, monedaPrincipal: principal, tasaAhorro,
      gastoFitnessMes: gastoFitness, gastoFitnessMoneda: monFitness, nMovFitnessMes: nFitness,
    };
  } catch (_) { return { estado: 'error' }; }
}

// ---- Rutina: adherencia 7d, racha, y estado de la creatina de HOY ----
async function cargarRutina() {
  try {
    const hoy = hoyStr();
    const [rutRes, chkRes] = await Promise.all([
      supabase.from('rutina_rutinas').select('id, items, dias, activa')
        .eq('user_id', S.userId).eq('_deleted', false).eq('activa', true),
      supabase.from('rutina_checks').select('fecha, rutina_id, item_id')
        .eq('user_id', S.userId).gte('fecha', desdeRango(7)).lte('fecha', hoy),
    ]);
    if (rutRes.error) throw rutRes.error;
    if (chkRes.error) throw chkRes.error;
    const rutinas = rutRes.data || [];
    const checks = chkRes.data || [];
    if (!rutinas.length) return { estado: 'vacio' };

    const checksPorDiaRutina = new Map(); // 'fecha|rutina' → Set(item_id)
    for (const c of checks) {
      const k = String(c.fecha).slice(0, 10) + '|' + c.rutina_id;
      if (!checksPorDiaRutina.has(k)) checksPorDiaRutina.set(k, new Set());
      checksPorDiaRutina.get(k).add(c.item_id);
    }

    // Adherencia 7d (checks hechos / posibles en días aplicables).
    let pos = 0, hec = 0;
    for (const r of rutinas) {
      const items = Array.isArray(r.items) ? r.items : [];
      const diasAplica = Array.isArray(r.dias) ? r.dias : [];
      if (!items.length) continue;
      for (let i = 0; i < 7; i++) {
        const f = addDias(hoy, -i);
        const k = f + '|' + r.id;
        const hechosDia = checksPorDiaRutina.has(k) ? checksPorDiaRutina.get(k).size : 0;
        if (diasAplica.includes(diaSemLunes(f))) { pos += items.length; hec += Math.min(hechosDia, items.length); }
        else if (hechosDia > 0) { pos += items.length; hec += Math.min(hechosDia, items.length); }
      }
    }
    const adherencia7 = pos > 0 ? Math.round(hec / pos * 100) : null;

    // Racha: días consecutivos completos hacia atrás.
    let racha = 0;
    for (let i = 0; i < 60; i++) {
      const f = addDias(hoy, -i);
      const dsem = diaSemLunes(f);
      let algunaAplica = false, completo = true;
      for (const r of rutinas) {
        const items = Array.isArray(r.items) ? r.items : [];
        if (!items.length) continue;
        if (!(Array.isArray(r.dias) ? r.dias : []).includes(dsem)) continue;
        algunaAplica = true;
        const k = f + '|' + r.id;
        const hechosDia = checksPorDiaRutina.has(k) ? checksPorDiaRutina.get(k).size : 0;
        if (hechosDia < items.length) { completo = false; break; }
      }
      if (!algunaAplica) continue;
      if (completo) racha++; else break;
    }

    // Creatina de hoy: item cuyo texto matchea /creatin/i en una rutina que aplica hoy.
    const dsemHoy = diaSemLunes(hoy);
    let tieneItemCreatinaHoy = false, creatinaHoyTildada = false, creatinaRutinaId = null, creatinaItemId = null;
    for (const r of rutinas) {
      const items = Array.isArray(r.items) ? r.items : [];
      const diasAplica = Array.isArray(r.dias) ? r.dias : [];
      const aplicaHoy = diasAplica.includes(dsemHoy) || diasAplica.length === 0; // dias:[] = manual/diaria
      if (!aplicaHoy) continue;
      for (const it of items) {
        const txt = Object.values(it || {}).filter(v => typeof v === 'string').join(' ');
        if (/creatin/i.test(txt)) {
          tieneItemCreatinaHoy = true;
          creatinaRutinaId = r.id;
          creatinaItemId = it.id != null ? it.id : (it.item_id != null ? it.item_id : null);
          const k = hoy + '|' + r.id;
          const set = checksPorDiaRutina.get(k);
          creatinaHoyTildada = !!(set && creatinaItemId != null && set.has(creatinaItemId));
          break;
        }
      }
      if (tieneItemCreatinaHoy) break;
    }

    return { estado: 'ok', adherencia7, rachaMax: racha, tieneItemCreatinaHoy, creatinaHoyTildada, creatinaRutinaId, creatinaItemId };
  } catch (_) { return { estado: 'error' }; }
}

// ---- Training: sesiones 30d, ¿entrenó hoy?, días sin entrenar ----
async function cargarTraining() {
  try {
    const hoy = hoyStr();
    const { data, error } = await supabase.from('training_sesiones')
      .select('fecha').eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', desdeRango(30)).lte('fecha', hoy);
    if (error) throw error;
    const ses = (data || []).map(s => String(s.fecha).slice(0, 10));
    const sesionHoy = ses.includes(hoy);
    const sesiones30 = ses.length;
    const ultima = ses.slice().sort().slice(-1)[0] || null;
    const diasSinEntrenar = ultima ? Math.max(0, Math.round((parseFecha(hoy) - parseFecha(ultima)) / 86400000)) : null;
    return { estado: sesiones30 ? 'ok' : 'vacio', sesionHoy, sesiones30, diasSinEntrenar };
  } catch (_) { return { estado: 'error' }; }
}

/* ============================================================
   Orquestación + armado del estado de vista
   ============================================================ */
async function cargarDatos() {
  const id = ++S.cargaId;
  const [nutricion, plata, rutina, training] = await Promise.all([
    cargarNutricion(), cargarPlata(), cargarRutina(), cargarTraining(),
  ]);
  if (id !== S.cargaId) return null; // llegó tarde
  S.datos = { nutricion, plata, rutina, training };
  return S.datos;
}

// Arma el `ctx` que consume el motor de palancas desde los datos crudos.
function armarCtx(datos) {
  const d = datos || {};
  const ok = (x) => x && x.estado !== 'error';
  return {
    hoy: hoyStr(),
    config: {
      umbrales: getConfig('insights', 'umbrales', null),
      pulso_pesos: getConfig('insights', 'pulso_pesos', null),
    },
    nutricion: ok(d.nutricion) ? d.nutricion : null,
    plata: ok(d.plata) ? d.plata : null,
    rutina: ok(d.rutina) ? d.rutina : null,
    training: ok(d.training) ? d.training : null,
  };
}

// Construye el estado de vista (pulso + tiles + palancas) — PURO, testeable.
export function construirEstado(datos, opts = {}) {
  const ctx = opts.ctx || armarCtx(datos);
  const pulso = pulsoVida(ctx);
  const palancas = calcularPalancas(ctx).filter(p => p.id !== 'p15'); // el pulso va al hero
  const d = datos || {};

  const nut = d.nutricion || {};
  const pla = d.plata || {};
  const rut = d.rutina || {};
  const tra = d.training || {};

  const tiles = [
    {
      id: 'nutricion', label: 'Cuerpo', color: 'var(--accent)',
      pct: nut.protTarget ? clampPct((nut.protHoy || 0) / nut.protTarget * 100) : null,
      valor: `${fmtNum(nut.protHoy || 0)}${nut.protTarget ? ` / ${fmtNum(nut.protTarget)}` : ''}`,
      unidad: 'g', sub: 'Proteína de hoy',
    },
    {
      id: 'plata', label: 'Plata', color: 'var(--accent-2)',
      pct: pla.tasaAhorro != null ? clampPct(pla.tasaAhorro) : null,
      valor: pla.balanceMes != null
        ? `${pla.balanceMes < 0 ? '−' : ''}${simboloMoneda(pla.monedaPrincipal)}${fmtNum(Math.abs(pla.balanceMes))}`
        : '—',
      unidad: '', sub: pla.balanceMes != null ? 'Balance del mes' : 'Sin movimientos',
    },
    {
      id: 'rutina', label: 'Rutina', color: 'var(--ok)',
      pct: rut.adherencia7 != null ? clampPct(rut.adherencia7) : null,
      valor: rut.adherencia7 != null ? `${fmtNum(rut.adherencia7)}` : '—',
      unidad: rut.adherencia7 != null ? '%' : '', sub: rut.rachaMax ? `Adherencia 7d · racha ${fmtNum(rut.rachaMax)}` : 'Adherencia 7 días',
    },
    {
      id: 'training', label: 'Training', color: 'var(--accent-2)',
      pct: tra.sesiones30 != null ? clampPct(tra.sesiones30 / 12 * 100) : null,
      valor: tra.sesiones30 != null ? `${fmtNum(tra.sesiones30)}` : '—',
      unidad: tra.sesiones30 != null ? '/30d' : '',
      sub: tra.sesionHoy ? 'Entrenaste hoy 💪' : (tra.diasSinEntrenar != null ? `Hace ${fmtNum(tra.diasSinEntrenar)} días` : 'Sin sesiones'),
    },
  ];

  return {
    saludo: opts.saludo || saludoHora(),
    fechaLabel: opts.fechaLabel || labelFechaLarga(hoyStr()),
    pulso, tiles, palancas,
  };
}

/* ============================================================
   Render (puro sobre un `estado`) + animación. Exportado para el harness.
   ============================================================ */
function tileHtml(t) {
  const anillo = t.pct != null ? `
    <div class="hom-core-fig">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle class="v-ring-track" cx="32" cy="32" r="26" style="stroke-width:6"></circle>
        <circle class="v-ring-fill" cx="32" cy="32" r="26" style="stroke-width:6;stroke:${t.color}" data-pct="${t.pct}"></circle>
      </svg>
      <div class="hom-core-mini" data-count="${Math.round(t.pct)}" data-suffix="%" style="color:${t.color}">0%</div>
    </div>` : '';
  return `
    <button type="button" class="hom-core rise lively" data-tilt data-nav="${esc(t.id)}" style="--cc:${t.color}">
      <div class="hom-core-name">${esc(t.label)}</div>
      <div class="hom-core-mid">
        ${anillo}
        <div class="hom-core-read">
          <div class="hom-core-val"><span class="hom-num">${esc(t.valor)}</span>${t.unidad ? `<span class="hom-core-u">${esc(t.unidad)}</span>` : ''}</div>
          <div class="hom-core-sub">${esc(t.sub)}</div>
        </div>
      </div>
    </button>`;
}

// Arma los data-attrs de una acción de palanca (para el 1-tap o la navegación).
function accionAttrs(accion) {
  if (!accion) return '';
  const p = accion.params || {};
  let a = `data-pal-accion data-modulo="${esc(accion.modulo)}"`;
  if (p.tipo) a += ` data-tipo="${esc(p.tipo)}"`;
  if (p.rutina_id) a += ` data-rutina="${esc(p.rutina_id)}"`;
  if (p.item_id) a += ` data-item="${esc(p.item_id)}"`;
  if (p.fecha) a += ` data-fecha="${esc(p.fecha)}"`;
  return a;
}

function crossHtml(cruza) {
  const nodes = dominiosDe(cruza);
  if (!nodes.length) return '';
  return `<div class="hom-cross">${nodes.map((n, i) =>
    `${i > 0 ? '<span class="hom-link"></span>' : ''}<span class="hom-node hom-node-${esc(n.id)}">${n.icono} ${esc(n.label)}</span>`
  ).join('')}</div>`;
}

function leverHtml(p) {
  const tareas = Array.isArray(p.tareas) && p.tareas.length ? `
    <div class="hom-tareas">${p.tareas.map(t => `
      <div class="hom-tarea ${t.hecho ? 'hom-tarea-ok' : ''}">
        <span class="hom-tarea-mark">${t.hecho ? '✓' : '○'}</span>
        <span class="hom-tarea-lbl">${esc(t.label)}</span>
        ${t.accion ? `<button type="button" class="hom-mini" ${accionAttrs(t.accion)}>${esc(t.accion.label)}</button>` : ''}
      </div>`).join('')}</div>` : '';
  const accion = p.accion ? `
    <div class="hom-lever-foot">
      <button type="button" class="hom-act" ${accionAttrs(p.accion)}>${esc(p.accion.label)}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </div>` : '';
  return `
    <article class="hom-lever rise lively" data-tilt>
      <div class="hom-lever-head">
        <span class="hom-lever-ic">${p.icono || '⚡'}</span>
        ${crossHtml(p.cruza)}
      </div>
      <p class="hom-lever-txt">${esc(p.texto)}</p>
      ${p.dato ? `<div class="hom-lever-dato hom-num">${esc(p.dato)}</div>` : ''}
      ${tareas}
      ${accion}
    </article>`;
}

function pulseHtml(pulso) {
  if (!pulso) return '';
  const comps = (pulso.componentes || []).map(c => {
    const lbl = c.k === 'adherencia' ? 'Rutina' : (c.k === 'proteina' ? 'Cuerpo' : 'Training');
    const col = c.k === 'adherencia' ? 'var(--ok)' : (c.k === 'proteina' ? 'var(--accent)' : 'var(--accent-2)');
    return `<div class="hom-feed"><div class="hom-feed-top"><span>${lbl}</span><span class="hom-num">${c.pct}</span></div>
      <div class="hom-feed-bar"><div class="hom-feed-fill" style="width:${clampPct(c.pct)}%;background:${col}"></div></div></div>`;
  }).join('');
  return `
  <section class="hom-pulse rise">
    <div class="hom-pulse-ring">
      <svg width="112" height="112" viewBox="0 0 112 112">
        <defs><linearGradient id="homPulseGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#35e0b2"></stop><stop offset="1" stop-color="#5aa2ff"></stop>
        </linearGradient></defs>
        <circle class="v-ring-track" cx="56" cy="56" r="46" style="stroke-width:8"></circle>
        <circle class="v-ring-fill hom-pulse-fill" cx="56" cy="56" r="46" style="stroke-width:8" data-pct="${pulso.score}"></circle>
      </svg>
      <div class="hom-pulse-center">
        <span class="hom-pulse-score hom-num" data-count="${pulso.score}">0</span>
        <span class="heartbeat hom-pulse-heart"></span>
      </div>
    </div>
    <div class="hom-pulse-body">
      <span class="hom-cap">Pulso VIDA</span>
      <p class="hom-pulse-txt">${esc(pulso.texto)}</p>
      ${comps ? `<div class="hom-feeds">${comps}</div>` : ''}
    </div>
  </section>`;
}

// Pinta el cockpit en `container` desde un `estado` y dispara las animaciones.
export function renderCockpit(container, estado) {
  if (!container) return;
  const palancas = estado.palancas || [];
  const levers = palancas.length
    ? palancas.map(leverHtml).join('')
    : `<div class="hom-empty">Todavía no hay suficiente data para cruzar. Cargá comida, rutina y entrenos unos días y el sistema empieza a encontrar palancas.</div>`;

  container.innerHTML = `
  <div class="hom">
    <header class="hom-head rise">
      <div>
        <h1 class="hom-hi">${esc(estado.saludo)}.</h1>
        <p class="hom-date">${esc(estado.fechaLabel)} · esto es lo que se mueve hoy</p>
      </div>
    </header>

    ${pulseHtml(estado.pulso)}

    <div class="hom-lbl rise"><span class="hom-cap">Tus núcleos · en vivo</span><span class="hom-rule"></span></div>
    <section class="hom-cores">${estado.tiles.map(tileHtml).join('')}</section>

    <div class="hom-lbl rise"><span class="hom-cap">Palancas de hoy · lo que el sistema cruzó</span><span class="hom-rule"></span></div>
    <section class="hom-levers">${levers}</section>
  </div>`;

  // Animación: anillos + count-up + entrada escalonada + tilt magnético.
  container.querySelectorAll('.v-ring-fill').forEach(c => ring(c, +c.getAttribute('data-pct') || 0));
  container.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    countUp(el, to, { suffix });
  });
  stagger(container.querySelectorAll('.rise'));
  tiltAll(container);
}

/* ============================================================
   Estado de carga (skeleton vivo)
   ============================================================ */
function paintCargando() {
  if (!S.container) return;
  S.container.innerHTML = `
  <div class="hom">
    <header class="hom-head"><div><h1 class="hom-hi">${esc(saludoHora())}.</h1>
      <p class="hom-date">${esc(labelFechaLarga(hoyStr()))}</p></div></header>
    <div class="hom-pulse"><div class="hom-pulse-ring shimmer" style="border-radius:50%"></div>
      <div class="hom-pulse-body" style="flex:1"><div class="shimmer" style="height:14px;width:40%;margin-bottom:10px"></div>
        <div class="shimmer" style="height:28px;width:80%"></div></div></div>
    <section class="hom-cores">
      ${[0, 1, 2, 3].map(() => `<div class="hom-core"><div class="shimmer" style="height:64px"></div></div>`).join('')}
    </section>
  </div>`;
}

/* ============================================================
   Eventos — delegación (bindea 1 vez). Tap en núcleo o acción de palanca.
   ============================================================ */
function bind() {
  if (S.boundEl === S.container) return;
  if (S.boundEl) S.boundEl.removeEventListener('click', onClick);
  S.container.addEventListener('click', onClick);
  S.boundEl = S.container;
}
function onClick(e) {
  const nav = e.target.closest('[data-nav]');
  if (nav && S.container.contains(nav)) { navigate(nav.dataset.nav); return; }
  const acc = e.target.closest('[data-pal-accion]');
  if (acc && S.container.contains(acc)) {
    // 1-tap real: si la acción es tildar un check (ej. creatina), lo insertamos
    // sin salir del Home. El resto de acciones navegan al módulo destino.
    if (acc.dataset.tipo === 'check' && acc.dataset.rutina && acc.dataset.item) {
      tildarCheck(acc.dataset.rutina, acc.dataset.item, acc.dataset.fecha);
      return;
    }
    if (acc.dataset.modulo) navigate(acc.dataset.modulo);
  }
}

// Tilda un ítem de rutina (ej. creatina) directo desde el Home, sin navegar.
async function tildarCheck(rutinaId, itemId, fecha) {
  if (!supabase || !S.userId || !rutinaId || !itemId) { navigate('rutina'); return; }
  try {
    const { error } = await supabase.from('rutina_checks')
      .insert({ user_id: S.userId, fecha: fecha || hoyStr(), rutina_id: rutinaId, item_id: itemId });
    if (error) throw error;
    toast('Listo, tildado ✓', 'success');
    montar(); // recarga el cockpit → la palanca cumplida desaparece
  } catch (err) {
    toast('No se pudo tildar: ' + (err && err.message ? err.message : 'error'), 'error');
  }
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo hom-, solo var(--token) + motion.css
   ============================================================ */
const CSS = `
.hom { max-width: 1040px; margin: 0 auto; padding: var(--space-2) 0 var(--space-6); font-family: var(--font-ui); color: var(--text); }
.hom * { box-sizing: border-box; }
.hom-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.hom-cap { font-size: .68rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

/* Header */
.hom-head { margin-bottom: var(--space-5); }
.hom-hi { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: clamp(1.6rem, 4vw, 2.2rem); letter-spacing: -.02em; }
.hom-date { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: .9rem; }

/* Pulso VIDA */
.hom-pulse { position: relative; display: flex; align-items: center; gap: clamp(16px, 3vw, 28px); padding: clamp(18px, 3vw, 26px); margin-bottom: var(--space-6); border-radius: var(--radius-lg); overflow: hidden;
  background: linear-gradient(135deg, rgba(53,224,178,.07), rgba(90,162,255,.06)), var(--surface); border: 1px solid var(--border-strong); }
.hom-pulse::before { content: ""; position: absolute; width: 320px; height: 320px; left: -50px; top: -140px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(53,224,178,.12), transparent 65%); animation: vida-breathe 5s ease-in-out infinite; }
.hom-pulse-ring { position: relative; width: 112px; height: 112px; flex: none; }
.hom-pulse-ring svg { transform: rotate(-90deg); }
.hom-pulse-fill { stroke: url(#homPulseGrad); }
.hom-pulse-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.hom-pulse-score { font-weight: 700; font-size: 2.1rem; line-height: 1; }
.hom-pulse-heart { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px 2px rgba(53,224,178,.6); }
.hom-pulse-body { min-width: 0; }
.hom-pulse-txt { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: .95rem; max-width: 48ch; }
.hom-feeds { display: flex; gap: var(--space-4); margin-top: var(--space-4); flex-wrap: wrap; }
.hom-feed { display: flex; flex-direction: column; gap: 5px; min-width: 78px; }
.hom-feed-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: .7rem; font-weight: 700; color: var(--text-dim); }
.hom-feed-bar { height: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.hom-feed-fill { height: 100%; border-radius: 999px; }
@media (max-width: 560px) { .hom-pulse { flex-direction: column; align-items: flex-start; } .hom-feeds { width: 100%; } }

/* Label de sección */
.hom-lbl { display: flex; align-items: center; gap: var(--space-3); margin: 0 2px var(--space-3); }
.hom-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--border-strong), transparent); }

/* Núcleos */
.hom-cores { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3); margin-bottom: var(--space-6); }
@media (max-width: 820px) { .hom-cores { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 380px) { .hom-cores { grid-template-columns: 1fr; } }
.hom-core { position: relative; padding: var(--space-4); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); text-align: left; overflow: hidden; }
.hom-core:hover { border-color: color-mix(in srgb, var(--cc) 50%, transparent); box-shadow: var(--shadow-2); }
.hom-core-name { font-size: .72rem; font-weight: 700; letter-spacing: .02em; color: var(--text-dim); margin-bottom: var(--space-3); }
.hom-core-mid { display: flex; align-items: center; gap: var(--space-3); }
.hom-core-fig { position: relative; width: 56px; height: 56px; flex: none; }
.hom-core-fig svg { width: 56px; height: 56px; transform: rotate(-90deg); }
.hom-core-mini { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-num); font-weight: 700; font-size: .72rem; }
.hom-core-read { min-width: 0; }
.hom-core-val { font-weight: 700; line-height: 1; display: flex; align-items: baseline; gap: 3px; }
.hom-core-val .hom-num { font-size: 1.35rem; }
.hom-core-u { font-size: .78rem; color: var(--text-faint); font-weight: 600; }
.hom-core-sub { margin-top: 4px; font-size: .74rem; color: var(--text-dim); }

/* Palancas */
.hom-levers { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
@media (max-width: 720px) { .hom-levers { grid-template-columns: 1fr; } }
.hom-lever { position: relative; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.hom-lever:hover { border-color: var(--border-strong); box-shadow: var(--shadow-2); }
.hom-lever-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.hom-lever-ic { width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center; background: var(--accent-soft); font-size: 1rem; }
.hom-cross { display: flex; align-items: center; gap: 6px; }
.hom-node { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; font-size: .62rem; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; background: var(--surface-2); color: var(--text-dim); }
.hom-node-cuerpo { background: var(--accent-soft); color: var(--accent); }
.hom-node-plata { background: var(--accent-2-soft); color: var(--accent-2); }
.hom-node-rutina { background: rgba(67,209,124,.13); color: var(--ok); }
.hom-node-training { background: var(--accent-2-soft); color: var(--accent-2); }
.hom-link { width: 14px; height: 1.5px; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.hom-lever-txt { margin: 0; font-size: .95rem; line-height: 1.5; color: var(--text); }
.hom-lever-dato { margin-top: var(--space-2); font-size: .76rem; color: var(--text-faint); }
.hom-tareas { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-1); }
.hom-tarea { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); font-size: .84rem; }
.hom-tarea-mark { font-family: var(--font-num); color: var(--text-faint); }
.hom-tarea-ok .hom-tarea-mark { color: var(--ok); }
.hom-tarea-lbl { flex: 1; min-width: 0; }
.hom-mini { padding: 4px 10px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent); border: none; font-size: .74rem; font-weight: 700; cursor: pointer; }
.hom-lever-foot { margin-top: var(--space-4); }
.hom-act { display: inline-flex; align-items: center; gap: 7px; padding: 9px 15px; border-radius: var(--radius); font-size: .82rem; font-weight: 700; color: var(--text-dim); background: transparent; border: 1px solid var(--border-strong); cursor: pointer; transition: color var(--dur) ease, border-color var(--dur) ease; }
.hom-act:hover { color: var(--text); border-color: var(--text-faint); }
.hom-act svg { width: 15px; height: 15px; }
.hom-empty { grid-column: 1 / -1; padding: var(--space-6); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); color: var(--text-dim); text-align: center; font-size: .9rem; }
`;

function inyectarEstilos() {
  if (document.getElementById('hom-styles')) return;
  const st = document.createElement('style');
  st.id = 'hom-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
async function montar() {
  if (!supabase) {
    S.container.innerHTML = `<div class="hom"><div class="hom-empty">Supabase no está configurado (ver SETUP.md).</div></div>`;
    return;
  }
  paintCargando();
  const datos = await cargarDatos();
  if (datos === null) return; // otra carga se hizo cargo
  renderCockpit(S.container, construirEstado(datos));
}

export default {
  id: 'home',
  label: 'Inicio',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.datos = null;
    S.cargando = true;
    inyectarEstilos();
    bind();
    await montar();
  },

  render() {
    if (!S.container) return;
    // Al volver de otro módulo el container tiene otro DOM → recargar el cockpit.
    montar();
  },
};
