// VIDA — Módulo Plata (Fase 2 · re-skin "Instrumento Vivo")
// Panorama (dashboard vivo) · Captura rápida de movimientos · Resumen · Objetivos
// Contrato: docs/CONTRATOS.md §4 y §9. Roadmap: CLAUDE.md §4 (Fase 2), BACKLOG.md §2.
//
// RE-SKIN, no rewrite: la capa de datos (queries, inserts/deletes soft, estado S,
// guards de carrera/doble-tap, config desde user_config) queda INTACTA. Solo se
// rediseñan las funciones de pintado y se agrega el tab Panorama, que deriva TODO
// de lo que el módulo ya calcula (resumenMes / movimientos). Sin tablas ni SQL.
import { supabase } from '../core/supabase.js';
import { toast, confirmDialog } from '../core/ui.js';
import { countUp, ring, stagger, tiltAll } from '../core/anim.js';

/* ============================================================
   Fechas — helpers locales (YYYY-MM-DD local del dispositivo)
   ============================================================ */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function parseFecha(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Mes visible: primer día del mes en formato YYYY-MM-01
function primerDiaMes(s) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), 1)); }
function mesActual() { const d = new Date(); return fmtFecha(new Date(d.getFullYear(), d.getMonth(), 1)); }
function addMeses(s, n) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
function ultimoDiaMes(s) { const d = parseFecha(s); return fmtFecha(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
function labelMes(s) {
  const d = parseFecha(s);
  return MESES_LARGO[d.getMonth()] + ' ' + d.getFullYear();
}
function labelDiaLista(s) {
  const hoy = hoyStr();
  const d = parseFecha(s);
  const base = DIAS[d.getDay()] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()];
  if (s === hoy) return 'Hoy · ' + base;
  return base;
}

/* ============================================================
   Utilidades
   ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }

// Formato es-AR por moneda. ARS: sin decimales (montos grandes redondos).
// El resto (USD, etc.): con decimales solo si el número los tiene.
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
  return m; // moneda desconocida: mostrar el código como prefijo
}

/* ============================================================
   Estado del módulo (el DOM se repinta entero en cada paint)
   ============================================================ */
const S = {
  container: null,
  userId: null,
  config: null,
  boundEl: null,           // container atado a los listeners (si cambia, se re-bindea)
  tab: 'panorama',         // 'panorama' | 'mes' | 'resumen' | 'objetivos'
  mes: mesActual(),        // primer día del mes visible (YYYY-MM-01)
  movimientos: [],         // plata_movimientos del mes visible
  movimientosPrev: null,   // { mes, rows } → mes anterior al visible (cache p/ delta del Panorama)
  cargandoPrev: false,     // in-flight del fetch del mes anterior
  objetivos: [],           // plata_objetivos activos (no borrados)
  objetivosCargados: false, // distingue "nunca cargado" de "cargado y vacío"
  aportesObjetivos: [],    // movimientos con objetivo_id (todas las fechas) → progreso
  form: null,              // estado del form de captura (persiste entre paints)
  cargando: false,
  cargandoObjetivos: false,
  mutando: false,          // in-flight guard de inserts/updates/deletes (doble tap)
  aporteModal: null,       // { objetivoId } → mini-form de aporte
  objetivoModal: null,     // { modo: 'crear'|'editar', id? } → form de objetivo
  targetModal: null,       // { objetivoId } → definir/editar target
  ultimaCarga: 0,
};

// Estado inicial del form de captura. Se conserva entre paints para no perder
// lo tipeado; se resetea (menos moneda/ámbito) tras un guardado exitoso.
function formInicial() {
  return {
    tipo: 'egreso',
    monto: '',
    moneda: primeraMoneda(),
    ambito: primerAmbito(),
    categoria: '',
    descripcion: '',
    fecha: hoyStr(),
  };
}

/* ============================================================
   Config del usuario — TODO viene de user_config, nada hardcodeado
   ============================================================ */
function cfgMonedas() {
  const m = S.config ? S.config.get('monedas', []) : [];
  return Array.isArray(m) ? m.filter(x => typeof x === 'string' && x.trim()) : [];
}
function cfgAmbitos() {
  const a = S.config ? S.config.get('ambitos', []) : [];
  return Array.isArray(a) ? a.filter(x => x && x.id && x.label) : [];
}
function cfgCategorias(tipo) {
  const c = (S.config && S.config.get('categorias', null)) || {};
  const lista = c && Array.isArray(c[tipo]) ? c[tipo] : [];
  return lista.filter(x => typeof x === 'string' && x.trim());
}
function primeraMoneda() { const m = cfgMonedas(); return m.length ? m[0] : ''; }
function primerAmbito() { const a = cfgAmbitos(); return a.length ? a[0].id : ''; }
function labelAmbito(id) {
  const a = cfgAmbitos().find(x => x.id === id);
  return a ? a.label : (id || '—');
}
function configLista() { return cfgMonedas().length && cfgAmbitos().length; }

/* ============================================================
   Datos — Supabase (siempre .eq('user_id') + .eq('_deleted', false))
   ============================================================ */
// Anti-carrera: captura el mes pedido y devuelve false si el usuario ya
// navegó a otro mes antes de que llegue la respuesta (no pisar el estado).
async function cargarMovimientos() {
  const mes = S.mes;
  const desde = mes;
  const hasta = ultimoDiaMes(mes);
  const { data, error } = await supabase.from('plata_movimientos').select('*')
    .eq('user_id', S.userId).eq('_deleted', false)
    .gte('fecha', desde).lte('fecha', hasta)
    .order('fecha', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw error;
  if (mes !== S.mes) return false;
  S.movimientos = data || [];
  return true;
}

// Mes anterior al visible — SOLO lectura, para el delta del Panorama. Tolerante:
// si falla, deja el cache vacío y el Panorama muestra el mes sin comparación.
// No toca S.movimientos (que pertenece al mes visible). Cachea por mes.
async function cargarMesAnterior() {
  const mesPrev = addMeses(S.mes, -1);
  if (S.cargandoPrev) return;
  if (S.movimientosPrev && S.movimientosPrev.mes === mesPrev) return; // ya cacheado
  S.cargandoPrev = true;
  try {
    const desde = mesPrev;
    const hasta = ultimoDiaMes(mesPrev);
    const { data, error } = await supabase.from('plata_movimientos')
      .select('tipo, monto, moneda, categoria, descripcion, objetivo_id')
      .eq('user_id', S.userId).eq('_deleted', false)
      .gte('fecha', desde).lte('fecha', hasta);
    if (error) throw error;
    if (addMeses(S.mes, -1) !== mesPrev) return; // el usuario ya navegó a otro mes
    S.movimientosPrev = { mes: mesPrev, rows: data || [] };
  } catch (_) {
    // Silencioso: el delta es una mejora, no un requisito. Marca "sin comparación".
    S.movimientosPrev = { mes: mesPrev, rows: null };
  } finally {
    S.cargandoPrev = false;
  }
}

async function cargarObjetivos() {
  const [obj, aportes] = await Promise.all([
    supabase.from('plata_objetivos').select('*')
      .eq('user_id', S.userId).eq('_deleted', false).eq('activo', true)
      .order('created_at'),
    // Todos los movimientos con objetivo_id (cualquier fecha) → base del progreso.
    // Traemos id para poder quitar un aporte puntual del progreso al borrarlo
    // sin confundirlo con otro de igual monto/moneda del mismo objetivo.
    supabase.from('plata_movimientos').select('id, objetivo_id, monto, moneda')
      .eq('user_id', S.userId).eq('_deleted', false)
      .not('objetivo_id', 'is', null),
  ]);
  if (obj.error) throw obj.error;
  if (aportes.error) throw aportes.error;
  S.objetivos = obj.data || [];
  S.aportesObjetivos = aportes.data || [];
}

/* ============================================================
   Derivados
   ============================================================ */
function movimientosPorDia() {
  const grupos = new Map();
  for (const m of S.movimientos) {
    const f = String(m.fecha).slice(0, 10);
    if (!grupos.has(f)) grupos.set(f, []);
    grupos.get(f).push(m);
  }
  // Ya vienen ordenados desc por fecha+created_at desde la query.
  return [...grupos.entries()]; // [ [fecha, [movs]], ... ]
}

// Resumen del mes: por moneda { ingreso, egreso, balance }, split por ámbito,
// egresos por categoría, total aportado a objetivos. NUNCA mezcla monedas.
function resumenMes() {
  const monedas = new Map(); // moneda → { ingreso, egreso }
  const porAmbito = new Map(); // moneda → { ambitoId → { ingreso, egreso } }
  const porCategoria = new Map(); // moneda → { categoria → egreso }
  const aportes = new Map(); // moneda → total aportado a objetivos (egresos con objetivo_id)

  for (const m of S.movimientos) {
    const mon = String(m.moneda || '').toUpperCase();
    const monto = Number(m.monto) || 0;
    const esIngreso = m.tipo === 'ingreso';
    if (!monedas.has(mon)) monedas.set(mon, { ingreso: 0, egreso: 0 });
    const mm = monedas.get(mon);
    if (esIngreso) mm.ingreso += monto; else mm.egreso += monto;

    if (!porAmbito.has(mon)) porAmbito.set(mon, new Map());
    const amb = porAmbito.get(mon);
    const aid = m.ambito || '';
    if (!amb.has(aid)) amb.set(aid, { ingreso: 0, egreso: 0 });
    if (esIngreso) amb.get(aid).ingreso += monto; else amb.get(aid).egreso += monto;

    if (!esIngreso) {
      if (!porCategoria.has(mon)) porCategoria.set(mon, new Map());
      const cat = porCategoria.get(mon);
      const c = (m.categoria && String(m.categoria).trim()) || 'Sin categoría';
      cat.set(c, (cat.get(c) || 0) + monto);
      if (m.objetivo_id) aportes.set(mon, (aportes.get(mon) || 0) + monto);
    }
  }

  const monedasArr = [...monedas.keys()].sort();
  return monedasArr.map(mon => {
    const mm = monedas.get(mon);
    const ambMap = porAmbito.get(mon) || new Map();
    const catMap = porCategoria.get(mon) || new Map();
    const cats = [...catMap.entries()]
      .map(([categoria, egreso]) => ({ categoria, egreso }))
      .sort((a, b) => b.egreso - a.egreso);
    const maxCat = cats.reduce((mx, c) => Math.max(mx, c.egreso), 0);
    return {
      moneda: mon,
      ingreso: mm.ingreso,
      egreso: mm.egreso,
      balance: mm.ingreso - mm.egreso,
      ambitos: [...ambMap.entries()].map(([id, v]) => ({ id, label: labelAmbito(id), ...v })),
      categorias: cats,
      maxCat,
      aportado: aportes.get(mon) || 0,
    };
  });
}

/* ---------- Derivados del Panorama (dashboard) — TODO desde datos ya cargados ---------- */

// Agrega una lista cruda de movimientos por moneda: ingreso/egreso/balance,
// egresos por categoría (ordenados), y el total de egresos individuales para el
// waterfall. Es la MISMA lógica que resumenMes pero sobre un array arbitrario,
// para poder aplicarla también al mes anterior (cache) sin duplicar reglas.
function agregarPorMoneda(rows) {
  const monedas = new Map(); // mon → { ingreso, egreso }
  const cats = new Map();    // mon → Map(categoria → egreso)
  for (const m of (rows || [])) {
    const mon = String(m.moneda || '').toUpperCase();
    const monto = Number(m.monto) || 0;
    const esIngreso = m.tipo === 'ingreso';
    if (!monedas.has(mon)) monedas.set(mon, { ingreso: 0, egreso: 0 });
    const mm = monedas.get(mon);
    if (esIngreso) mm.ingreso += monto; else mm.egreso += monto;
    if (!esIngreso) {
      if (!cats.has(mon)) cats.set(mon, new Map());
      const c = (m.categoria && String(m.categoria).trim()) || 'Sin categoría';
      const cm = cats.get(mon);
      cm.set(c, (cm.get(c) || 0) + monto);
    }
  }
  const out = new Map();
  for (const [mon, mm] of monedas) {
    const catMap = cats.get(mon) || new Map();
    const catsArr = [...catMap.entries()]
      .map(([categoria, egreso]) => ({ categoria, egreso }))
      .sort((a, b) => b.egreso - a.egreso);
    out.set(mon, {
      moneda: mon,
      ingreso: mm.ingreso,
      egreso: mm.egreso,
      balance: mm.ingreso - mm.egreso,
      movimiento: mm.ingreso + mm.egreso,
      categorias: catsArr,
    });
  }
  return out;
}

// Elige la moneda "principal" = la de mayor movimiento total (ingreso+egreso).
function monedaPrincipalDe(agg) {
  let principal = null, max = -1;
  for (const [mon, b] of agg) {
    if (b.movimiento > max) { max = b.movimiento; principal = mon; }
  }
  return principal;
}

// Arma todo el estado de vista del Panorama a partir de S.movimientos (mes visible)
// y del cache del mes anterior (para deltas). Puro: no toca Supabase.
function datosPanorama() {
  const agg = agregarPorMoneda(S.movimientos);
  const principal = monedaPrincipalDe(agg);
  const prevRows = S.movimientosPrev && S.movimientosPrev.rows; // null = sin comparación
  const aggPrev = prevRows ? agregarPorMoneda(prevRows) : null;

  // Tiles de balance por moneda (todas las monedas del mes, principal primero).
  const monedas = [...agg.keys()].sort((a, b) =>
    (a === principal ? -1 : b === principal ? 1 : agg.get(b).movimiento - agg.get(a).movimiento));

  const bp = principal ? agg.get(principal) : null;
  const bpPrev = (aggPrev && principal && aggPrev.has(principal)) ? aggPrev.get(principal) : null;

  // Delta % del balance vs. mes anterior (misma moneda principal). null si no hay base.
  const deltaBalance = deltaPct(bp ? bp.balance : null, bpPrev ? bpPrev.balance : null);
  const deltaGasto = deltaPct(bp ? bp.egreso : null, bpPrev ? bpPrev.egreso : null);

  // Top 3 egresos individuales del mes (moneda principal), para el tile de gastos.
  const topGastos = principal ? S.movimientos
    .filter(m => m.tipo === 'egreso' && String(m.moneda || '').toUpperCase() === principal)
    .map(m => ({
      titulo: (m.categoria && String(m.categoria).trim()) || 'Egreso',
      sub: (m.descripcion && String(m.descripcion).trim()) || labelAmbito(m.ambito),
      monto: Number(m.monto) || 0, moneda: principal,
    }))
    .sort((a, b) => b.monto - a.monto)
    .slice(0, 3) : [];

  return {
    hayDatos: !!bp,
    principal,
    balance: bp ? bp.balance : 0,
    ingreso: bp ? bp.ingreso : 0,
    egreso: bp ? bp.egreso : 0,
    deltaBalance,
    deltaGasto,
    egresoPrev: bpPrev ? bpPrev.egreso : null,
    sinComparacion: prevRows === null || prevRows === undefined,
    tiles: monedas.map(mon => {
      const b = agg.get(mon);
      return { moneda: mon, balance: b.balance, ingreso: b.ingreso, egreso: b.egreso };
    }),
    waterfall: bp ? construirWaterfall(bp) : null,
    topGastos,
  };
}

// Delta porcentual firmado de `actual` vs `prev`. null cuando no hay comparación posible.
function deltaPct(actual, prev) {
  if (actual == null || prev == null) return null;
  if (Math.abs(prev) < 0.0000001) return null; // sin base (mes anterior en 0) → no forzar %
  return ((actual - prev) / Math.abs(prev)) * 100;
}

// Waterfall del cashflow del mes: saldo 0 → +ingresos → −egresos (por categoría, top 5
// + "otros") → balance. Devuelve pasos con acumulado para dibujar barras flotantes.
function construirWaterfall(b) {
  const pasos = [];
  let acum = 0;
  pasos.push({ tipo: 'base', label: 'Inicio', delta: 0, desde: 0, hasta: 0 });
  // Ingresos (un solo bloque hacia arriba).
  const desdeIng = acum; acum += b.ingreso;
  pasos.push({ tipo: 'ingreso', label: 'Ingresos', delta: b.ingreso, desde: desdeIng, hasta: acum });
  // Egresos por categoría (top 5, resto agrupado), cada uno baja el acumulado.
  const TOP = 5;
  const top = b.categorias.slice(0, TOP);
  const resto = b.categorias.slice(TOP);
  const restoTotal = resto.reduce((s, c) => s + c.egreso, 0);
  for (const c of top) {
    const desde = acum; acum -= c.egreso;
    pasos.push({ tipo: 'egreso', label: c.categoria, delta: -c.egreso, desde, hasta: acum });
  }
  if (restoTotal > 0) {
    const desde = acum; acum -= restoTotal;
    pasos.push({ tipo: 'egreso', label: 'Otros', delta: -restoTotal, desde, hasta: acum });
  }
  // Balance final (barra sólida desde 0).
  pasos.push({ tipo: 'balance', label: 'Balance', delta: acum, desde: 0, hasta: acum });
  const valores = pasos.flatMap(p => [p.desde, p.hasta]);
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores);
  return { pasos, min, max, moneda: b.moneda };
}

// Progreso de un objetivo = suma de movimientos (no borrados) con su objetivo_id
// en la moneda del objetivo.
function progresoObjetivo(obj) {
  const mon = String(obj.moneda || '').toUpperCase();
  let total = 0;
  for (const a of S.aportesObjetivos) {
    if (a.objetivo_id !== obj.id) continue;
    if (String(a.moneda || '').toUpperCase() !== mon) continue;
    total += Number(a.monto) || 0;
  }
  return total;
}

/* ============================================================
   Mutaciones
   ============================================================ */
async function guardarMovimiento() {
  if (S.mutando) return; // doble tap: un guardado a la vez
  const f = S.form;
  const monto = Number(String(f.monto).replace(',', '.'));
  if (!(monto > 0)) { toast('Poné un monto mayor a 0', 'warning'); return; }
  if (!f.moneda) { toast('Elegí una moneda', 'warning'); return; }
  if (!f.ambito) { toast('Elegí un ámbito', 'warning'); return; }
  const mesDestino = primerDiaMes(f.fecha);
  S.mutando = true;
  try {
    const fila = {
      user_id: S.userId,
      fecha: f.fecha,
      tipo: f.tipo === 'ingreso' ? 'ingreso' : 'egreso',
      monto,
      moneda: f.moneda,
      ambito: f.ambito,
      categoria: f.categoria || null,
      descripcion: f.descripcion ? f.descripcion.trim() : null,
      origen: 'manual',
    };
    const { data, error } = await supabase.from('plata_movimientos').insert(fila).select().single();
    if (error) throw error;
    // Solo insertar en la vista si el movimiento cae en el mes visible.
    if (mesDestino === S.mes) {
      S.movimientos.unshift(data);
      S.movimientos.sort((a, b) =>
        String(b.fecha).localeCompare(String(a.fecha)) ||
        String(b.created_at).localeCompare(String(a.created_at)));
    }
    toast('Guardado: ' + fmtMonto(monto, f.moneda), 'success');
    // Reset del form conservando moneda/ámbito/tipo/fecha (flujo de carga rápida).
    S.form = {
      tipo: f.tipo,
      monto: '',
      moneda: f.moneda,
      ambito: f.ambito,
      categoria: '',
      descripcion: '',
      fecha: f.fecha,
    };
    paint();
    enfocarMonto();
  } catch (err) {
    toast('No se pudo guardar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function borrarMovimiento(id) {
  const mov = S.movimientos.find(x => x.id === id);
  if (!mov) return;
  const ok = await confirmDialog({
    title: 'Borrar movimiento',
    message: '¿Sacás este ' + (mov.tipo === 'ingreso' ? 'ingreso' : 'egreso') + ' de ' + fmtMonto(mov.monto, mov.moneda) + '?',
    confirmText: 'Borrar',
    danger: true,
  });
  if (!ok) return;
  if (S.mutando) return;
  S.mutando = true;
  try {
    const { error } = await supabase.from('plata_movimientos')
      .update({ _deleted: true })
      .eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.movimientos = S.movimientos.filter(x => x.id !== id);
    // Si tenía objetivo_id, sacar ese aporte puntual del progreso (por id exacto).
    if (mov.objetivo_id) S.aportesObjetivos = S.aportesObjetivos.filter(x => x.id !== id);
    toast('Movimiento borrado', 'success');
    paint();
  } catch (err) {
    toast('No se pudo borrar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function crearObjetivo(datos) {
  if (S.mutando) return;
  S.mutando = true;
  try {
    const fila = {
      user_id: S.userId,
      nombre: datos.nombre,
      target_monto: datos.target != null ? datos.target : null,
      moneda: datos.moneda,
      nota: datos.nota || null,
      activo: true,
    };
    const { data, error } = await supabase.from('plata_objetivos').insert(fila).select().single();
    if (error) throw error;
    S.objetivos.push(data);
    S.objetivoModal = null;
    toast('Objetivo creado: ' + datos.nombre, 'success');
    paint();
  } catch (err) {
    toast('No se pudo crear el objetivo: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function editarObjetivo(id, patch) {
  if (S.mutando) return;
  const obj = S.objetivos.find(x => x.id === id);
  if (!obj) return;
  S.mutando = true;
  try {
    const { data, error } = await supabase.from('plata_objetivos')
      .update(patch).eq('id', id).eq('user_id', S.userId)
      .select().single();
    if (error) throw error;
    Object.assign(obj, data);
    S.objetivoModal = null;
    S.targetModal = null;
    toast('Objetivo actualizado', 'success');
    paint();
  } catch (err) {
    toast('No se pudo actualizar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function archivarObjetivo(id) {
  const obj = S.objetivos.find(x => x.id === id);
  if (!obj) return;
  const ok = await confirmDialog({
    title: 'Archivar objetivo',
    message: '¿Archivás "' + obj.nombre + '"? Los aportes quedan registrados, pero deja de aparecer en la lista.',
    confirmText: 'Archivar',
    danger: true,
  });
  if (!ok) return;
  if (S.mutando) return;
  S.mutando = true;
  try {
    const { error } = await supabase.from('plata_objetivos')
      .update({ activo: false }).eq('id', id).eq('user_id', S.userId);
    if (error) throw error;
    S.objetivos = S.objetivos.filter(x => x.id !== id);
    toast('Objetivo archivado', 'success');
    paint();
  } catch (err) {
    toast('No se pudo archivar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

async function aportarObjetivo(datos) {
  if (S.mutando) return;
  const obj = S.objetivos.find(x => x.id === datos.objetivoId);
  if (!obj) return;
  const monto = Number(String(datos.monto).replace(',', '.'));
  if (!(monto > 0)) { toast('Poné un monto mayor a 0', 'warning'); return; }
  const mesDestino = primerDiaMes(datos.fecha);
  S.mutando = true;
  try {
    const fila = {
      user_id: S.userId,
      fecha: datos.fecha,
      tipo: 'egreso',
      monto,
      moneda: obj.moneda,
      ambito: datos.ambito || primerAmbito(),
      categoria: 'Objetivos',
      descripcion: 'Aporte a ' + obj.nombre,
      objetivo_id: obj.id,
      origen: 'manual',
    };
    const { data, error } = await supabase.from('plata_movimientos').insert(fila).select().single();
    if (error) throw error;
    // Reflejar el aporte en el progreso al instante (con id para borrado exacto).
    S.aportesObjetivos.push({ id: data.id, objetivo_id: data.objetivo_id, monto: data.monto, moneda: data.moneda });
    if (mesDestino === S.mes) {
      S.movimientos.unshift(data);
      S.movimientos.sort((a, b) =>
        String(b.fecha).localeCompare(String(a.fecha)) ||
        String(b.created_at).localeCompare(String(a.created_at)));
    }
    S.aporteModal = null;
    toast('Aporte a ' + obj.nombre + ': ' + fmtMonto(monto, obj.moneda), 'success');
    paint();
  } catch (err) {
    toast('No se pudo aportar: ' + msgErr(err), 'error');
  }
  S.mutando = false;
}

/* ============================================================
   Navegación
   ============================================================ */
async function cambiarMes(mes) {
  S.mes = mes;
  S.cargando = true;
  S.movimientosPrev = null; // el mes anterior cacheado ya no corresponde al nuevo mes visible
  paint();
  try {
    if (!(await cargarMovimientos())) return; // llegó tarde: otra navegación se hizo cargo
  } catch (err) {
    if (S.mes !== mes) return;
    S.movimientos = []; // nunca dejar movimientos de otro mes bajo este label
    toast('No se pudo cargar el mes: ' + msgErr(err), 'error');
  }
  S.cargando = false;
  paint();
  // Si estamos en Panorama, traer el nuevo mes anterior para el delta.
  if (S.tab === 'panorama') asegurarMesAnterior();
}

function enfocarMonto() {
  // Tras guardar/paint: devolver el foco al monto para la próxima carga de 1 mano.
  requestAnimationFrame(() => {
    const inp = document.getElementById('plaMonto');
    if (inp) { inp.focus(); }
  });
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
}

function onEscape(e) {
  if (e.key !== 'Escape') return;
  if (!S.container || !S.container.isConnected) return;
  if (S.aporteModal) { S.aporteModal = null; paint(); }
  else if (S.objetivoModal) { S.objetivoModal = null; paint(); }
  else if (S.targetModal) { S.targetModal = null; paint(); }
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.closest('.pla')) return;
  const a = el.dataset.action;

  if (a === 'tab') {
    S.tab = el.dataset.tab;
    S.aporteModal = null; S.objetivoModal = null; S.targetModal = null;
    // Objetivos se cargan on-demand la primera vez que se entra a su tab.
    if (S.tab === 'objetivos' && !S.objetivosCargados && !S.cargandoObjetivos) {
      cargarObjetivosLazy();
    }
    // Panorama necesita el mes anterior para el delta → carga tolerante en background.
    if (S.tab === 'panorama') asegurarMesAnterior();
    paint();
    return;
  }

  if (a === 'mes-prev') { cambiarMes(addMeses(S.mes, -1)); return; }
  if (a === 'mes-next') { cambiarMes(addMeses(S.mes, 1)); return; }
  if (a === 'mes-hoy') { cambiarMes(mesActual()); return; }

  // Form de captura — chips y toggles (actualizan estado sin repintar todo el form)
  if (a === 'set-tipo') { S.form.tipo = el.dataset.tipo; if (!cfgCategorias(S.form.tipo).includes(S.form.categoria)) S.form.categoria = ''; paint(); enfocarMonto(); return; }
  if (a === 'set-moneda') { S.form.moneda = el.dataset.moneda; paint(); enfocarMonto(); return; }
  if (a === 'set-ambito') { S.form.ambito = el.dataset.ambito; paint(); enfocarMonto(); return; }

  if (a === 'del-mov') { borrarMovimiento(el.dataset.id); return; }

  // Objetivos
  if (a === 'nuevo-objetivo') { S.objetivoModal = { modo: 'crear' }; paint(); return; }
  if (a === 'editar-objetivo') { S.objetivoModal = { modo: 'editar', id: el.dataset.id }; paint(); return; }
  if (a === 'definir-target') { S.targetModal = { objetivoId: el.dataset.id }; paint(); return; }
  if (a === 'archivar-objetivo') { archivarObjetivo(el.dataset.id); return; }
  if (a === 'abrir-aporte') { S.aporteModal = { objetivoId: el.dataset.id }; paint(); return; }

  // Modales — cierres
  if (a === 'modal-cerrar') { S.aporteModal = null; S.objetivoModal = null; S.targetModal = null; paint(); return; }
  if (a === 'modal-fondo') { if (e.target === el) { S.aporteModal = null; S.objetivoModal = null; S.targetModal = null; paint(); } return; }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form || !form.closest('.pla')) return;
  const a = form.dataset.action;

  if (a === 'guardar-mov') {
    e.preventDefault();
    guardarMovimiento();
    return;
  }

  if (a === 'aporte') {
    e.preventDefault();
    const ctx = S.aporteModal;
    if (!ctx) return;
    const fd = new FormData(form);
    aportarObjetivo({
      objetivoId: ctx.objetivoId,
      monto: fd.get('monto'),
      fecha: String(fd.get('fecha') || hoyStr()).slice(0, 10) || hoyStr(),
      ambito: fd.get('ambito') || primerAmbito(),
    });
    return;
  }

  if (a === 'objetivo') {
    e.preventDefault();
    const ctx = S.objetivoModal;
    if (!ctx) return;
    const fd = new FormData(form);
    const nombre = String(fd.get('nombre') || '').trim();
    if (!nombre) { toast('Poné un nombre para el objetivo', 'warning'); return; }
    const targetRaw = String(fd.get('target') || '').trim();
    const target = targetRaw ? Number(targetRaw.replace(',', '.')) : null;
    if (targetRaw && !(target >= 0)) { toast('El target tiene que ser un número válido', 'warning'); return; }
    const moneda = String(fd.get('moneda') || primeraMoneda());
    const nota = String(fd.get('nota') || '').trim();
    if (ctx.modo === 'editar') {
      editarObjetivo(ctx.id, { nombre, target_monto: target, moneda, nota: nota || null });
    } else {
      crearObjetivo({ nombre, target, moneda, nota });
    }
    return;
  }

  if (a === 'target') {
    e.preventDefault();
    const ctx = S.targetModal;
    if (!ctx) return;
    const fd = new FormData(form);
    const targetRaw = String(fd.get('target') || '').trim();
    const target = targetRaw ? Number(targetRaw.replace(',', '.')) : null;
    if (targetRaw && !(target >= 0)) { toast('El target tiene que ser un número válido', 'warning'); return; }
    editarObjetivo(ctx.objetivoId, { target_monto: target });
    return;
  }
}

function onInput(e) {
  const inp = e.target.closest('[data-field]');
  if (!inp || !inp.closest('.pla-form')) return;
  const field = inp.dataset.field;
  if (field in S.form) S.form[field] = inp.value;
}

function onChange(e) {
  const sel = e.target.closest('[data-field]');
  if (!sel || !sel.closest('.pla-form')) return;
  const field = sel.dataset.field;
  if (field in S.form) S.form[field] = sel.value;
}

/* ============================================================
   Carga lazy de objetivos (primera entrada al tab)
   ============================================================ */
async function cargarObjetivosLazy() {
  S.cargandoObjetivos = true;
  paint();
  try {
    await cargarObjetivos();
    S.objetivosCargados = true;
  } catch (err) {
    toast('No se pudieron cargar los objetivos: ' + msgErr(err), 'error');
  }
  S.cargandoObjetivos = false;
  paint();
}

// Carga el mes anterior (para el delta del Panorama) sin bloquear: si ya está
// cacheado no hace nada; cuando llega, repinta solo si seguimos en Panorama y en
// el mismo mes visible (el delta pasa de "—" a "▲/▼ %").
function asegurarMesAnterior() {
  const mesPrev = addMeses(S.mes, -1);
  if (S.movimientosPrev && S.movimientosPrev.mes === mesPrev) return;
  cargarMesAnterior().then(() => {
    if (S.tab === 'panorama' && S.movimientosPrev && S.movimientosPrev.mes === addMeses(S.mes, -1)) {
      paint();
    }
  });
}

/* ============================================================
   Vistas — el DOM del módulo se reconstruye entero en cada paint()
   ============================================================ */
function paint() {
  if (!S.container) return;
  const tabs = [['panorama', 'Panorama'], ['mes', 'Mes'], ['resumen', 'Resumen'], ['objetivos', 'Objetivos']];
  let vista;
  if (S.tab === 'panorama') vista = vistaPanorama();
  else if (S.tab === 'resumen') vista = vistaResumen();
  else if (S.tab === 'objetivos') vista = vistaObjetivos();
  else vista = vistaMes();
  S.container.innerHTML = `
  <div class="pla">
    <header class="pla-head">
      <div class="pla-head-fila">
        <h2 class="pla-titulo">Plata</h2>
      </div>
      <nav class="pla-tabs" role="tablist">
        ${tabs.map(([id, lbl]) => `
        <button class="pla-tab${S.tab === id ? ' activa' : ''}" role="tab"
          aria-selected="${S.tab === id}" data-action="tab" data-tab="${id}">${lbl}</button>`).join('')}
      </nav>
    </header>
    <div class="pla-cuerpo">${vista}</div>
    ${S.aporteModal ? modalAporte() : ''}
    ${S.objetivoModal ? modalObjetivo() : ''}
    ${S.targetModal ? modalTarget() : ''}
  </div>`;
  animarVista();
}

// Count-up para montos: como anim.js countUp pero formatea cada frame con
// separadores es-AR (miles) y prefijo de moneda. anim.js es solo-lectura, por eso
// vive acá. Respeta prefers-reduced-motion (salta al valor final formateado).
function countUpMoneda(el, to, { prefix = '', decimals = 0, dur = 1150 } = {}) {
  if (!el) return;
  const nf = new Intl.NumberFormat('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const fmt = (n) => prefix + nf.format(n);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { el.textContent = fmt(to); return; }
  let start = null;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (ts) => {
    if (start === null) start = ts;
    const p = Math.min(1, (ts - start) / dur);
    el.textContent = fmt(to * ease(p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Dispara las animaciones del lenguaje "Instrumento Vivo" tras cada pintado:
// count-up de números héroe, anillos SVG, barras que crecen, entrada escalonada,
// tilt magnético. Todo respeta prefers-reduced-motion vía anim.js.
function animarVista() {
  const c = S.container;
  if (!c) return;
  // Montos héroe (con separadores de miles).
  c.querySelectorAll('[data-count-money]').forEach(el => {
    const to = +el.getAttribute('data-count-money') || 0;
    const dec = +el.getAttribute('data-dec') || 0;
    const prefix = el.getAttribute('data-prefix') || '';
    countUpMoneda(el, to, { decimals: dec, prefix });
  });
  // Números que cuentan (tiles, porcentajes).
  c.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.getAttribute('data-count') || 0;
    const dec = +el.getAttribute('data-dec') || 0;
    const prefix = el.getAttribute('data-prefix') || '';
    const suffix = el.getAttribute('data-suffix') || '';
    countUp(el, to, { decimals: dec, prefix, suffix });
  });
  // Anillos SVG.
  c.querySelectorAll('.v-ring-fill').forEach(ci => ring(ci, +ci.getAttribute('data-pct') || 0));
  // Barras (categorías, objetivos, waterfall): del 0 al ancho/alto objetivo.
  c.querySelectorAll('[data-grow-w]').forEach(el => {
    const w = el.getAttribute('data-grow-w');
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = w; }));
  });
  c.querySelectorAll('[data-grow-h]').forEach(el => {
    const h = el.getAttribute('data-grow-h');
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.height = h; }));
  });
  // Entrada escalonada + tilt.
  stagger(c.querySelectorAll('.rise'));
  tiltAll(c);
}

function navMes() {
  const esActual = S.mes === mesActual();
  return `
  <div class="pla-mesnav">
    <button class="pla-nav-btn" data-action="mes-prev" aria-label="Mes anterior">‹</button>
    <div class="pla-mesnav-centro">
      <div class="pla-mesnav-label">${esc(labelMes(S.mes))}</div>
      ${esActual ? '' : `<button class="pla-chip" data-action="mes-hoy">Este mes</button>`}
    </div>
    <button class="pla-nav-btn" data-action="mes-next" aria-label="Mes siguiente">›</button>
  </div>`;
}

/* ---------- Tab PANORAMA (dashboard de entrada, default) ---------- */
function vistaPanorama() {
  const nav = navMes();
  if (!configLista()) return nav + vacioConfig();
  if (S.cargando) return nav + heroSkeleton();
  const d = datosPanorama();
  if (!d.hayDatos) {
    return nav + `
    <div class="pla-vacio rise">
      <div class="pla-vacio-icono">📈</div>
      <p>Sin movimientos en ${esc(labelMes(S.mes))}.</p>
      <p class="pla-vacio-sub">Cargá tu primer ingreso o egreso en la pestaña <b>Mes</b> y acá vas a ver el balance, la evolución y el cashflow del mes vivos.</p>
      <button class="pla-btn-primario" data-action="tab" data-tab="mes">Cargar movimiento</button>
    </div>`;
  }
  return nav
    + heroBalance(d)
    + tilesPanorama(d)
    + (d.topGastos.length ? topGastosCard(d) : '')
    + waterfallCard(d);
}

// Número HÉROE del balance del mes, con curva/gradiente de fondo y delta vs. mes anterior.
function heroBalance(d) {
  const neg = d.balance < 0;
  const signo = neg ? '−' : '';
  const col = neg ? 'var(--danger)' : 'var(--accent)';
  const abs = Math.abs(d.balance);
  const decimales = d.principal === 'ARS' ? 0 : (abs % 1 !== 0 ? 2 : 0);
  const prefijo = signo + simboloMoneda(d.principal) + ' ';
  return `
  <section class="pla-hero rise" style="--hcol:${col}">
    <div class="pla-hero-curva">${curvaHero(d, neg)}</div>
    <div class="pla-hero-cont">
      <div class="pla-hero-cap">Balance de ${esc(labelMes(S.mes))} · ${esc(d.principal)}</div>
      <div class="pla-hero-num pla-num" style="color:${col}"
        data-count-money="${abs}" data-dec="${decimales}" data-prefix="${esc(prefijo)}">${esc(prefijo)}0</div>
      <div class="pla-hero-fila">
        ${deltaBadge(d.deltaBalance, d.sinComparacion, true)}
        <div class="pla-hero-io">
          <span class="pla-hero-io-item"><span class="pla-dot pla-dot-in"></span>Ingresos <b class="pla-num">${esc(fmtMonto(d.ingreso, d.principal))}</b></span>
          <span class="pla-hero-io-item"><span class="pla-dot pla-dot-out"></span>Egresos <b class="pla-num">${esc(fmtMonto(d.egreso, d.principal))}</b></span>
        </div>
      </div>
    </div>
  </section>`;
}

// Curva decorativa de fondo del hero (SVG). No es un dato histórico (no lo hay aún):
// es una firma visual que refleja el signo del balance (sube si positivo, baja si negativo).
function curvaHero(d, neg) {
  const path = neg
    ? 'M0,26 C60,30 110,52 180,58 C250,64 300,54 360,60'
    : 'M0,60 C60,54 110,30 180,26 C250,22 300,34 360,20';
  const area = neg
    ? 'M0,26 C60,30 110,52 180,58 C250,64 300,54 360,60 L360,80 L0,80 Z'
    : 'M0,60 C60,54 110,30 180,26 C250,22 300,34 360,20 L360,80 L0,80 Z';
  return `
  <svg viewBox="0 0 360 80" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="plaHeroGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--hcol)" stop-opacity="0.28"></stop>
        <stop offset="1" stop-color="var(--hcol)" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#plaHeroGrad)"></path>
    <path d="${path}" fill="none" stroke="var(--hcol)" stroke-width="2" stroke-linecap="round" opacity="0.85"></path>
  </svg>`;
}

// Badge de delta ▲/▼ %. esBalance=true → subir es bueno (verde); false (gasto) →
// bajar es bueno (gastar menos), se invierte el color.
function deltaBadge(delta, sinComparacion, esBalance) {
  if (sinComparacion || delta == null) {
    return `<span class="pla-delta pla-delta-neutro">Sin mes anterior</span>`;
  }
  const sube = delta >= 0;
  // Balance: subir es bueno (verde). Ver tile de gasto para el caso inverso.
  const bueno = esBalance ? sube : !sube;
  const flecha = sube ? '▲' : '▼';
  const cls = Math.abs(delta) < 0.5 ? 'pla-delta-neutro' : (bueno ? 'pla-delta-ok' : 'pla-delta-mal');
  const val = Math.abs(delta) >= 999 ? '999+' : fmtPct(Math.abs(delta));
  return `<span class="pla-delta ${cls}">${flecha} ${val}% <span class="pla-delta-vs">vs. mes ant.</span></span>`;
}

function fmtPct(n) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);
}

// Fila de tiles vivos: balance por moneda + gasto del mes vs. anterior.
function tilesPanorama(d) {
  const tiles = [];
  // Un tile por moneda con su balance (nunca mezcla monedas).
  for (const t of d.tiles) {
    const neg = t.balance < 0;
    const col = neg ? 'var(--danger)' : 'var(--accent)';
    const esPrincipal = t.moneda === d.principal;
    tiles.push(`
    <div class="pla-tile rise lively" data-tilt style="--tcol:${col}">
      <div class="pla-tile-cap">Balance ${esc(t.moneda)}</div>
      <div class="pla-tile-val pla-num" style="color:${col}">${neg ? '−' : ''}${esc(fmtMonto(t.balance, t.moneda))}</div>
      <div class="pla-tile-sub">${esPrincipal ? deltaMini(d.deltaBalance, d.sinComparacion, true) : `<span class="pla-tile-io">+${esc(fmtMonto(t.ingreso, t.moneda))} · −${esc(fmtMonto(t.egreso, t.moneda))}</span>`}</div>
    </div>`);
  }
  // Tile de gasto del mes (moneda principal) vs. anterior.
  tiles.push(`
  <div class="pla-tile rise lively" data-tilt style="--tcol:var(--accent-2)">
    <div class="pla-tile-cap">Gasto del mes</div>
    <div class="pla-tile-val pla-num" style="color:var(--text)">${esc(fmtMonto(d.egreso, d.principal))}</div>
    <div class="pla-tile-sub">${deltaMini(d.deltaGasto, d.sinComparacion, false)}${d.egresoPrev != null ? ` <span class="pla-tile-io">ant. ${esc(fmtMonto(d.egresoPrev, d.principal))}</span>` : ''}</div>
  </div>`);
  return `<section class="pla-tiles">${tiles.join('')}</section>`;
}

function deltaMini(delta, sinComparacion, esBalance) {
  if (sinComparacion || delta == null) return `<span class="pla-delta-mini pla-delta-neutro">—</span>`;
  const sube = delta >= 0;
  const bueno = esBalance ? sube : !sube;
  const flecha = sube ? '▲' : '▼';
  const cls = Math.abs(delta) < 0.5 ? 'pla-delta-neutro' : (bueno ? 'pla-delta-ok' : 'pla-delta-mal');
  const val = Math.abs(delta) >= 999 ? '999+' : fmtPct(Math.abs(delta));
  return `<span class="pla-delta-mini ${cls}">${flecha} ${val}%</span>`;
}

// Card "Top 3 gastos del mes" (moneda principal).
function topGastosCard(d) {
  const max = d.topGastos.reduce((m, g) => Math.max(m, g.monto), 0);
  return `
  <section class="pla-card pla-top rise lively" data-tilt>
    <div class="pla-card-titulo">Top gastos · ${esc(d.principal)}</div>
    <div class="pla-top-lista">
      ${d.topGastos.map((g, i) => {
        const pct = max > 0 ? Math.max(6, (g.monto / max) * 100) : 0;
        return `
        <div class="pla-top-item">
          <div class="pla-top-rank">${i + 1}</div>
          <div class="pla-top-info">
            <div class="pla-top-fila">
              <span class="pla-top-nombre">${esc(g.titulo)}</span>
              <span class="pla-top-monto pla-num">${esc(fmtMonto(g.monto, g.moneda))}</span>
            </div>
            ${g.sub ? `<div class="pla-top-sub">${esc(g.sub)}</div>` : ''}
            <div class="pla-top-bar"><div class="pla-top-fill" style="width:0" data-grow-w="${pct}%"></div></div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

// Card del cashflow del mes tipo WATERFALL (SVG inline). Barras flotantes que
// animan su altura al montar: saldo 0 → +ingresos → −egresos por categoría → balance.
function waterfallCard(d) {
  const w = d.waterfall;
  if (!w || !w.pasos.length) return '';
  const H = 220;            // alto útil del área de barras (px)
  const rango = (w.max - w.min) || 1;
  const y0 = (H * (w.max)) / rango;          // píxel del cero (medido desde arriba)
  const yDe = (v) => (H * (w.max - v)) / rango;
  const barras = w.pasos.map((p, i) => {
    const top = Math.min(yDe(p.desde), yDe(p.hasta));
    const bottom = Math.max(yDe(p.desde), yDe(p.hasta));
    const alto = Math.max(2, bottom - top);
    const col = p.tipo === 'ingreso' ? 'var(--ok)'
      : p.tipo === 'egreso' ? 'var(--danger)'
      : (p.tipo === 'balance' ? (p.delta < 0 ? 'var(--danger)' : 'var(--accent)') : 'var(--text-faint)');
    const sub = p.tipo === 'base' ? '' : `${p.delta > 0 ? '+' : (p.delta < 0 ? '−' : '')}${esc(fmtMonto(Math.abs(p.delta), w.moneda))}`;
    // La barra "base" (inicio en 0) no dibuja columna, solo la etiqueta de arranque.
    const columna = p.tipo === 'base'
      ? `<div class="pla-wf-base" style="top:${y0.toFixed(1)}px"></div>`
      : `<div class="pla-wf-col" style="top:${top.toFixed(1)}px; height:0; background:${col}" data-grow-h="${alto.toFixed(1)}px"></div>`;
    return `
    <div class="pla-wf-slot" style="--wcol:${col}">
      <div class="pla-wf-area">
        ${columna}
      </div>
      <div class="pla-wf-val pla-num">${sub}</div>
      <div class="pla-wf-lbl">${esc(p.label)}</div>
    </div>`;
  }).join('');
  return `
  <section class="pla-card pla-wf rise">
    <div class="pla-card-titulo">Cashflow del mes · ${esc(w.moneda)}</div>
    <div class="pla-wf-graf" style="--wf-h:${H}px">
      <div class="pla-wf-cero" style="top:${y0.toFixed(1)}px"></div>
      <div class="pla-wf-slots">${barras}</div>
    </div>
    <div class="pla-wf-leyenda">
      <span><span class="pla-dot pla-dot-in"></span>Ingresos</span>
      <span><span class="pla-dot pla-dot-out"></span>Egresos por categoría</span>
      <span><span class="pla-dot pla-dot-bal"></span>Balance</span>
    </div>
  </section>`;
}

// Skeleton vivo del hero mientras carga el mes.
function heroSkeleton() {
  return `
  <section class="pla-hero">
    <div class="pla-hero-cont">
      <div class="shimmer" style="height:14px;width:45%;margin-bottom:14px"></div>
      <div class="shimmer" style="height:40px;width:70%;margin-bottom:14px"></div>
      <div class="shimmer" style="height:16px;width:55%"></div>
    </div>
  </section>
  <section class="pla-tiles">
    ${[0, 1, 2].map(() => `<div class="pla-tile"><div class="shimmer" style="height:64px"></div></div>`).join('')}
  </section>`;
}

function vacioConfig() {
  return `
  <div class="pla-vacio">
    <div class="pla-vacio-icono">⚙️</div>
    <p>Todavía no hay monedas ni ámbitos configurados.</p>
    <p class="pla-vacio-sub">Corré el seed (sql/04_plata.sql) para cargar las monedas, los ámbitos (Personal / MEPEX) y las categorías del módulo.</p>
  </div>`;
}

/* ---------- Tab MES ---------- */
function vistaMes() {
  const nav = navMes();
  if (!configLista()) return nav + vacioConfig();
  const form = formCaptura();
  if (S.cargando) return nav + form + `<div class="pla-cargando">Cargando el mes…</div>`;
  return nav + form + listaMovimientos();
}

function formCaptura() {
  const f = S.form;
  const monedas = cfgMonedas();
  const ambitos = cfgAmbitos();
  const cats = cfgCategorias(f.tipo);
  const esIngreso = f.tipo === 'ingreso';
  return `
  <form class="pla-form pla-card rise" data-action="guardar-mov" autocomplete="off">
    <div class="pla-tipo-toggle" role="group" aria-label="Tipo de movimiento">
      <button type="button" class="pla-tipo-btn${esIngreso ? ' activa pla-tipo-ingreso' : ''}" data-action="set-tipo" data-tipo="ingreso">Ingreso</button>
      <button type="button" class="pla-tipo-btn${!esIngreso ? ' activa pla-tipo-egreso' : ''}" data-action="set-tipo" data-tipo="egreso">Egreso</button>
    </div>

    <div class="pla-monto-fila">
      <span class="pla-monto-sim">${esc(simboloMoneda(f.moneda))}</span>
      <input class="pla-monto-input" id="plaMonto" data-field="monto" type="text"
        inputmode="decimal" placeholder="0" value="${esc(f.monto)}"
        aria-label="Monto" autocomplete="off">
    </div>

    ${monedas.length > 1 ? `
    <div class="pla-chips" role="group" aria-label="Moneda">
      ${monedas.map(mon => `
      <button type="button" class="pla-chip-op${f.moneda === mon ? ' activa' : ''}" data-action="set-moneda" data-moneda="${esc(mon)}">${esc(mon)}</button>`).join('')}
    </div>` : ''}

    <div class="pla-campo-label">Ámbito</div>
    <div class="pla-chips" role="group" aria-label="Ámbito">
      ${ambitos.map(am => `
      <button type="button" class="pla-chip-op${f.ambito === am.id ? ' activa' : ''}" data-action="set-ambito" data-ambito="${esc(am.id)}">${esc(am.label)}</button>`).join('')}
    </div>

    <div class="pla-form-grid">
      <label class="pla-field">
        <span class="pla-campo-label">Categoría</span>
        <select class="pla-input" data-field="categoria" aria-label="Categoría">
          <option value=""${!f.categoria ? ' selected' : ''}>Sin categoría</option>
          ${cats.map(c => `<option value="${esc(c)}"${f.categoria === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </label>
      <label class="pla-field">
        <span class="pla-campo-label">Fecha</span>
        <input class="pla-input" data-field="fecha" type="date" value="${esc(f.fecha)}" max="9999-12-31" aria-label="Fecha">
      </label>
    </div>

    <input class="pla-input" data-field="descripcion" type="text" placeholder="Descripción (opcional)"
      value="${esc(f.descripcion)}" maxlength="160" aria-label="Descripción">

    <button type="submit" class="pla-btn-primario">Guardar ${esIngreso ? 'ingreso' : 'egreso'}</button>
  </form>`;
}

function listaMovimientos() {
  if (!S.movimientos.length) {
    return `
    <div class="pla-vacio rise">
      <div class="pla-vacio-icono">💸</div>
      <p>Sin movimientos en ${esc(labelMes(S.mes))}.</p>
      <p class="pla-vacio-sub">Cargá tu primer ingreso o egreso con el formulario de arriba. Monto → guardar, listo.</p>
    </div>`;
  }
  const grupos = movimientosPorDia();
  return `<div class="pla-lista">${grupos.map(([fecha, movs]) => `
    <div class="pla-dia rise">
      <div class="pla-dia-head">${esc(labelDiaLista(fecha))}</div>
      ${movs.map(filaMovimiento).join('')}
    </div>`).join('')}</div>`;
}

function filaMovimiento(m) {
  const esIngreso = m.tipo === 'ingreso';
  const signo = esIngreso ? '+' : '−';
  const cls = esIngreso ? 'pla-mov-ingreso' : 'pla-mov-egreso';
  const titulo = (m.categoria && String(m.categoria).trim()) || (esIngreso ? 'Ingreso' : 'Egreso');
  const sub = [m.descripcion, m.fuente].filter(x => x && String(x).trim()).join(' · ');
  return `
  <div class="pla-mov">
    <div class="pla-mov-info">
      <div class="pla-mov-titulo">${esc(titulo)} <span class="pla-badge">${esc(labelAmbito(m.ambito))}</span></div>
      ${sub ? `<div class="pla-mov-sub">${esc(sub)}</div>` : ''}
    </div>
    <div class="pla-mov-monto ${cls}"><span class="pla-num">${signo} ${esc(fmtMonto(m.monto, m.moneda))}</span></div>
    <button class="pla-icono pla-borrar" data-action="del-mov" data-id="${esc(m.id)}" aria-label="Borrar movimiento" title="Borrar">✕</button>
  </div>`;
}

/* ---------- Tab RESUMEN ---------- */
function vistaResumen() {
  const nav = navMes();
  if (!configLista()) return nav + vacioConfig();
  if (S.cargando) return nav + `<div class="pla-cargando">Cargando el mes…</div>`;
  const resumen = resumenMes();
  if (!resumen.length) {
    return nav + `
    <div class="pla-vacio rise">
      <div class="pla-vacio-icono">📊</div>
      <p>Nada para resumir en ${esc(labelMes(S.mes))}.</p>
      <p class="pla-vacio-sub">Cargá movimientos en la pestaña Mes y acá aparece el resumen por moneda, ámbito y categoría.</p>
    </div>`;
  }
  return nav + resumen.map(bloqueResumenMoneda).join('');
}

function bloqueResumenMoneda(r) {
  const balCls = r.balance >= 0 ? 'pla-mov-ingreso' : 'pla-mov-egreso';
  return `
  <section class="pla-card pla-res rise lively" data-tilt>
    <div class="pla-res-head">
      <h3 class="pla-res-moneda">${esc(r.moneda)}</h3>
    </div>
    <div class="pla-res-totales">
      <div class="pla-res-tot">
        <span class="pla-res-tot-k">Ingresos</span>
        <span class="pla-res-tot-v pla-mov-ingreso pla-num">${esc(fmtMonto(r.ingreso, r.moneda))}</span>
      </div>
      <div class="pla-res-tot">
        <span class="pla-res-tot-k">Egresos</span>
        <span class="pla-res-tot-v pla-mov-egreso pla-num">${esc(fmtMonto(r.egreso, r.moneda))}</span>
      </div>
      <div class="pla-res-tot pla-res-tot-bal">
        <span class="pla-res-tot-k">Balance</span>
        <span class="pla-res-tot-v ${balCls} pla-num">${r.balance < 0 ? '−' : ''}${esc(fmtMonto(r.balance, r.moneda))}</span>
      </div>
    </div>

    ${r.ambitos.length ? `
    <div class="pla-res-sub-titulo">Por ámbito</div>
    <div class="pla-res-ambitos">
      ${r.ambitos.map(am => `
      <div class="pla-res-ambito">
        <div class="pla-res-ambito-nombre">${esc(am.label)}</div>
        <div class="pla-res-ambito-nums">
          <span class="pla-mov-ingreso pla-num">+${esc(fmtMonto(am.ingreso, r.moneda))}</span>
          <span class="pla-mov-egreso pla-num">−${esc(fmtMonto(am.egreso, r.moneda))}</span>
        </div>
      </div>`).join('')}
    </div>` : ''}

    ${r.categorias.length ? `
    <div class="pla-res-sub-titulo">Egresos por categoría</div>
    <div class="pla-res-cats">
      ${r.categorias.map(c => {
        const pct = r.maxCat > 0 ? Math.max(3, (c.egreso / r.maxCat) * 100) : 0;
        return `
        <div class="pla-res-cat">
          <div class="pla-res-cat-fila">
            <span class="pla-res-cat-nombre">${esc(c.categoria)}</span>
            <span class="pla-res-cat-monto pla-num">${esc(fmtMonto(c.egreso, r.moneda))}</span>
          </div>
          <div class="pla-res-cat-bar"><div class="pla-res-cat-fill" style="width:0" data-grow-w="${pct}%"></div></div>
        </div>`;
      }).join('')}
    </div>` : ''}

    ${r.aportado > 0 ? `<div class="pla-res-aportes">🎯 Aportado a objetivos: <span class="pla-num">${esc(fmtMonto(r.aportado, r.moneda))}</span></div>` : ''}
  </section>`;
}

/* ---------- Tab OBJETIVOS ---------- */
function vistaObjetivos() {
  // Los objetivos se listan aunque falte config (monedas/ámbitos): solo el
  // mini-form de aporte necesita ámbitos. No bloquear la vista entera.
  if (S.cargandoObjetivos) return `<div class="pla-cargando">Cargando objetivos…</div>`;
  const nuevo = `<button class="pla-btn-primario pla-obj-nuevo" data-action="nuevo-objetivo">+ Nuevo objetivo</button>`;
  if (!S.objetivos.length) {
    return `
    <div class="pla-vacio rise">
      <div class="pla-vacio-icono">🎯</div>
      <p>Todavía no tenés objetivos.</p>
      <p class="pla-vacio-sub">Un objetivo es una meta de plata a la que le vas aportando (una compra, un colchón, un viaje). Definís un target opcional y seguís el progreso.</p>
      ${nuevo}
    </div>`;
  }
  return nuevo + `<div class="pla-objs">${S.objetivos.map(cardObjetivo).join('')}</div>`;
}

function cardObjetivo(obj) {
  const total = progresoObjetivo(obj);
  const target = obj.target_monto != null ? Number(obj.target_monto) : null;
  const tieneTarget = target != null && target > 0;
  const pct = tieneTarget ? Math.min(100, (total / target) * 100) : 0;
  const completo = tieneTarget && total >= target;
  return `
  <section class="pla-card pla-obj${completo ? ' pla-obj-completo' : ''} rise lively" data-tilt>
    <div class="pla-obj-head">
      <div class="pla-obj-info">
        <h3 class="pla-obj-nombre">${esc(obj.nombre)}</h3>
        ${obj.nota ? `<div class="pla-obj-nota">${esc(obj.nota)}</div>` : ''}
      </div>
      <span class="pla-badge">${esc(String(obj.moneda || '').toUpperCase())}</span>
    </div>

    ${tieneTarget ? `
    <div class="pla-obj-prog">
      <div class="pla-obj-prog-fila">
        <span class="pla-num pla-obj-total">${esc(fmtMonto(total, obj.moneda))}</span>
        <span class="pla-obj-de">/ ${esc(fmtMonto(target, obj.moneda))}</span>
      </div>
      <div class="pla-obj-bar"><div class="pla-obj-fill${completo ? ' pla-obj-fill-ok' : ''}" style="width:0" data-grow-w="${pct}%"></div></div>
      <div class="pla-obj-pct">${completo ? '¡Objetivo cumplido! 🎉' : Math.floor(pct) + '% · faltan ' + esc(fmtMonto(target - total, obj.moneda))}</div>
    </div>` : `
    <div class="pla-obj-prog">
      <div class="pla-obj-prog-fila">
        <span class="pla-num pla-obj-total">${esc(fmtMonto(total, obj.moneda))}</span>
        <span class="pla-obj-de">aportado</span>
      </div>
      <button class="pla-btn-sec" data-action="definir-target" data-id="${esc(obj.id)}">Definir target</button>
    </div>`}

    <div class="pla-obj-acciones">
      <button class="pla-btn-primario pla-obj-aportar" data-action="abrir-aporte" data-id="${esc(obj.id)}">Aportar</button>
      <button class="pla-btn-sec" data-action="editar-objetivo" data-id="${esc(obj.id)}">Editar</button>
      <button class="pla-btn-ghost" data-action="archivar-objetivo" data-id="${esc(obj.id)}">Archivar</button>
    </div>
  </section>`;
}

/* ---------- Modales ---------- */
function modalAporte() {
  const ctx = S.aporteModal;
  const obj = S.objetivos.find(x => x.id === ctx.objetivoId);
  if (!obj) return '';
  const ambitos = cfgAmbitos();
  const defAmbito = primerAmbito();
  return `
  <div class="pla-modal" data-action="modal-fondo">
    <div class="pla-modal-card" role="dialog" aria-modal="true" aria-label="Aportar al objetivo">
      <header class="pla-modal-head">
        <h3 class="pla-modal-titulo">Aportar a ${esc(obj.nombre)}</h3>
        <button class="pla-icono" data-action="modal-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <form class="pla-modal-form" data-action="aporte" autocomplete="off">
        <label class="pla-field">
          <span class="pla-campo-label">Monto (${esc(String(obj.moneda || '').toUpperCase())})</span>
          <input class="pla-input" name="monto" type="text" inputmode="decimal" placeholder="0" required autofocus aria-label="Monto del aporte">
        </label>
        <label class="pla-field">
          <span class="pla-campo-label">Fecha</span>
          <input class="pla-input" name="fecha" type="date" value="${esc(hoyStr())}" max="9999-12-31">
        </label>
        ${ambitos.length ? `
        <label class="pla-field">
          <span class="pla-campo-label">Ámbito</span>
          <select class="pla-input" name="ambito">
            ${ambitos.map(am => `<option value="${esc(am.id)}"${am.id === defAmbito ? ' selected' : ''}>${esc(am.label)}</option>`).join('')}
          </select>
        </label>` : ''}
        <button type="submit" class="pla-btn-primario">Registrar aporte</button>
      </form>
    </div>
  </div>`;
}

function modalObjetivo() {
  const ctx = S.objetivoModal;
  const editar = ctx.modo === 'editar';
  const obj = editar ? S.objetivos.find(x => x.id === ctx.id) : null;
  if (editar && !obj) return '';
  const monedas = cfgMonedas();
  const monActual = obj ? String(obj.moneda || '').toUpperCase() : primeraMoneda();
  const targetVal = obj && obj.target_monto != null ? String(obj.target_monto) : '';
  return `
  <div class="pla-modal" data-action="modal-fondo">
    <div class="pla-modal-card" role="dialog" aria-modal="true" aria-label="${editar ? 'Editar objetivo' : 'Nuevo objetivo'}">
      <header class="pla-modal-head">
        <h3 class="pla-modal-titulo">${editar ? 'Editar objetivo' : 'Nuevo objetivo'}</h3>
        <button class="pla-icono" data-action="modal-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <form class="pla-modal-form" data-action="objetivo" autocomplete="off">
        <label class="pla-field">
          <span class="pla-campo-label">Nombre</span>
          <input class="pla-input" name="nombre" type="text" placeholder="Ej: colchón de emergencia" required maxlength="120" value="${esc(obj ? obj.nombre : '')}" autofocus>
        </label>
        <div class="pla-form-grid">
          <label class="pla-field">
            <span class="pla-campo-label">Target (opcional)</span>
            <input class="pla-input" name="target" type="text" inputmode="decimal" placeholder="0" value="${esc(targetVal)}">
          </label>
          <label class="pla-field">
            <span class="pla-campo-label">Moneda</span>
            <select class="pla-input" name="moneda">
              ${(monedas.length ? monedas : [monActual]).map(mon => `<option value="${esc(mon)}"${mon === monActual ? ' selected' : ''}>${esc(mon)}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="pla-field">
          <span class="pla-campo-label">Nota (opcional)</span>
          <input class="pla-input" name="nota" type="text" placeholder="Detalle del objetivo" maxlength="200" value="${esc(obj ? (obj.nota || '') : '')}">
        </label>
        <button type="submit" class="pla-btn-primario">${editar ? 'Guardar cambios' : 'Crear objetivo'}</button>
      </form>
    </div>
  </div>`;
}

function modalTarget() {
  const ctx = S.targetModal;
  const obj = S.objetivos.find(x => x.id === ctx.objetivoId);
  if (!obj) return '';
  const targetVal = obj.target_monto != null ? String(obj.target_monto) : '';
  return `
  <div class="pla-modal" data-action="modal-fondo">
    <div class="pla-modal-card" role="dialog" aria-modal="true" aria-label="Definir target">
      <header class="pla-modal-head">
        <h3 class="pla-modal-titulo">Target de ${esc(obj.nombre)}</h3>
        <button class="pla-icono" data-action="modal-cerrar" aria-label="Cerrar">✕</button>
      </header>
      <form class="pla-modal-form" data-action="target" autocomplete="off">
        <label class="pla-field">
          <span class="pla-campo-label">Monto objetivo (${esc(String(obj.moneda || '').toUpperCase())})</span>
          <input class="pla-input" name="target" type="text" inputmode="decimal" placeholder="0" value="${esc(targetVal)}" required autofocus>
        </label>
        <button type="submit" class="pla-btn-primario">Guardar target</button>
      </form>
    </div>
  </div>`;
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo pla-, solo var(--token)
   ============================================================ */
const CSS = `
.pla { max-width: 720px; margin: 0 auto; padding: var(--space-4); font-family: var(--font-ui); color: var(--text); }
.pla * { box-sizing: border-box; }
.pla button { font: inherit; color: inherit; cursor: pointer; }
.pla button:focus-visible, .pla input:focus-visible, .pla select:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.pla-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

/* Header + tabs */
.pla-head { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.pla-head-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.pla-titulo { margin: 0; font-family: var(--font-display); font-size: 1.35rem; letter-spacing: .01em; }
.pla-tabs { display: flex; gap: var(--space-2); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.pla-tab { flex: 1 1 0; min-height: 44px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-dim); white-space: nowrap; font-weight: 600; transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease, transform var(--dur) var(--ease-out-expo); }
.pla-tab:hover { color: var(--text); border-color: var(--border-strong); }
.pla-tab.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 700; }

/* Navegación de mes */
.pla-mesnav { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-4); }
.pla-nav-btn { width: 48px; min-height: 48px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 1.4rem; line-height: 1; color: var(--text-dim); }
.pla-nav-btn:active { background: var(--surface-2); }
.pla-mesnav-centro { flex: 1; display: flex; flex-direction: column; align-items: center; gap: var(--space-1); min-width: 0; }
.pla-mesnav-label { font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; text-align: center; text-transform: capitalize; }
.pla-chip { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: var(--space-1) var(--space-3); font-size: .78rem; min-height: 28px; }

/* Cards */
.pla-card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); margin-bottom: var(--space-4); box-shadow: var(--shadow-1); overflow: hidden; }
.pla-card-titulo { font-size: .72rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); margin-bottom: var(--space-3); }

/* Form de captura */
.pla-form { display: flex; flex-direction: column; gap: var(--space-3); }
.pla-tipo-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-1); background: var(--surface-2); border-radius: var(--radius); padding: var(--space-1); }
.pla-tipo-btn { min-height: 44px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-dim); font-weight: 700; transition: background .15s, color .15s; }
.pla-tipo-btn.activa.pla-tipo-ingreso { background: var(--accent-soft); color: var(--ok); }
.pla-tipo-btn.activa.pla-tipo-egreso { background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--danger); }

.pla-monto-fila { display: flex; align-items: center; gap: var(--space-2); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: var(--space-2) var(--space-3); }
.pla-monto-fila:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.pla-monto-sim { font-family: var(--font-num); font-size: 1.4rem; color: var(--text-dim); flex: none; }
.pla-monto-input { flex: 1; min-width: 0; width: 100%; border: none; background: transparent; color: var(--text); font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 1.8rem; font-weight: 700; outline: none; padding: var(--space-1) 0; }
.pla-monto-input::placeholder { color: var(--text-faint); }

.pla-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pla-chip-op { min-height: 40px; padding: var(--space-1) var(--space-4); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; color: var(--text-dim); font-weight: 600; font-size: .85rem; transition: background .15s, color .15s, border-color .15s; }
.pla-chip-op.activa { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

.pla-campo-label { font-size: .74rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; }
.pla-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.pla-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.pla-input { width: 100%; min-height: 46px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font: inherit; }
.pla-input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
select.pla-input { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--text-faint) 50%), linear-gradient(135deg, var(--text-faint) 50%, transparent 50%); background-position: calc(100% - 18px) center, calc(100% - 13px) center; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: var(--space-8); }

.pla-btn-primario { min-height: 50px; padding: var(--space-2) var(--space-4); background: var(--accent); border: none; border-radius: var(--radius); color: var(--bg); font-weight: 700; transition: filter .15s; }
.pla-btn-primario:hover { filter: brightness(1.1); }
.pla-btn-primario:active { transform: translateY(1px); }
.pla-btn-sec { min-height: 44px; padding: var(--space-1) var(--space-4); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-weight: 600; transition: background .15s, color .15s, border-color .15s; }
.pla-btn-sec:hover { background: var(--surface-2); color: var(--text); border-color: var(--text-faint); }
.pla-btn-ghost { min-height: 44px; padding: var(--space-1) var(--space-4); background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-weight: 600; transition: color .15s, background .15s; }
.pla-btn-ghost:hover { color: var(--danger); background: var(--surface-2); }

/* Lista de movimientos */
.pla-lista { display: flex; flex-direction: column; gap: var(--space-4); }
.pla-dia-head { font-size: .74rem; text-transform: capitalize; letter-spacing: .03em; color: var(--text-faint); margin-bottom: var(--space-2); padding-left: var(--space-1); }
.pla-mov { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: var(--space-2); }
.pla-mov:last-child { margin-bottom: 0; }
.pla-mov-info { flex: 1; min-width: 0; }
.pla-mov-titulo { font-size: .92rem; display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.pla-mov-sub { font-size: .78rem; color: var(--text-dim); margin-top: 2px; overflow-wrap: anywhere; }
.pla-badge { display: inline-flex; align-items: center; padding: 2px 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; color: var(--text-dim); font-size: .66rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.pla-mov-monto { font-size: .95rem; font-weight: 700; white-space: nowrap; }
.pla-mov-ingreso { color: var(--ok); }
.pla-mov-egreso { color: var(--danger); }
.pla-icono { width: 40px; min-height: 40px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: var(--radius); color: var(--text-faint); font-size: .95rem; }
.pla-borrar:hover, .pla-borrar:active { color: var(--danger); background: var(--surface-2); }

/* Resumen */
.pla-res-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--space-3); }
.pla-res-moneda { margin: 0; font-family: var(--font-display); font-size: 1rem; letter-spacing: .05em; color: var(--text-dim); }
.pla-res-totales { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); margin-bottom: var(--space-4); }
.pla-res-tot { background: var(--surface-2); border-radius: var(--radius); padding: var(--space-3) var(--space-2); text-align: center; }
.pla-res-tot-k { display: block; font-size: .68rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .06em; margin-bottom: var(--space-1); }
.pla-res-tot-v { display: block; font-size: .95rem; font-weight: 700; overflow-wrap: anywhere; }
.pla-res-sub-titulo { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); margin: var(--space-4) 0 var(--space-2); }
.pla-res-ambitos { display: flex; flex-direction: column; gap: var(--space-2); }
.pla-res-ambito { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); }
.pla-res-ambito-nombre { font-size: .88rem; font-weight: 600; }
.pla-res-ambito-nums { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: .8rem; }
.pla-res-cats { display: flex; flex-direction: column; gap: var(--space-3); }
.pla-res-cat-fila { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-1); }
.pla-res-cat-nombre { font-size: .85rem; overflow-wrap: anywhere; }
.pla-res-cat-monto { font-size: .82rem; color: var(--text-dim); white-space: nowrap; }
.pla-res-cat-bar { height: 8px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.pla-res-cat-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-2), color-mix(in srgb, var(--accent-2) 60%, var(--accent))); transition: width var(--dur-slow) var(--ease-out-expo); }
.pla-res-aportes { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); font-size: .82rem; color: var(--text-dim); }

/* Objetivos */
.pla-obj-nuevo { width: 100%; margin-bottom: var(--space-4); }
.pla-objs { display: flex; flex-direction: column; gap: var(--space-4); }
.pla-obj { margin-bottom: 0; }
.pla-obj-completo { border-color: var(--ok); }
.pla-obj-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.pla-obj-info { min-width: 0; }
.pla-obj-nombre { margin: 0; font-family: var(--font-display); font-size: 1.05rem; overflow-wrap: anywhere; }
.pla-obj-nota { font-size: .78rem; color: var(--text-dim); margin-top: 2px; overflow-wrap: anywhere; }
.pla-obj-prog { margin-bottom: var(--space-4); }
.pla-obj-prog-fila { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.pla-obj-total { font-size: 1.5rem; font-weight: 700; }
.pla-obj-de { font-size: .82rem; color: var(--text-dim); }
.pla-obj-bar { height: 12px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.pla-obj-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-2), var(--accent)); transition: width var(--dur-slow) var(--ease-out-expo); }
.pla-obj-fill-ok { background: linear-gradient(90deg, var(--accent), var(--ok)); }
.pla-obj-pct { font-size: .78rem; color: var(--text-dim); margin-top: var(--space-2); }
.pla-obj-completo .pla-obj-pct { color: var(--ok); }
.pla-obj-acciones { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.pla-obj-aportar { flex: 1; min-width: 120px; }

/* Modales — glass: fondo difuminado + card que entra */
.pla-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--bg) 68%, transparent); backdrop-filter: blur(8px) saturate(1.2); -webkit-backdrop-filter: blur(8px) saturate(1.2); animation: pla-fade var(--dur) ease; }
.pla-modal-card { position: relative; width: 100%; max-width: 480px; max-height: 88vh; display: flex; flex-direction: column; background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid var(--border-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding: var(--space-5) var(--space-4); box-shadow: var(--shadow-2); animation: pla-modal-in var(--dur-slow) var(--ease-out-expo); }
.pla-modal-card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: var(--glow-accent); opacity: .5; }
.pla-modal-card > * { position: relative; }
@keyframes pla-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pla-modal-in { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .pla-modal, .pla-modal-card { animation: none !important; } }
.pla-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-4); }
.pla-modal-titulo { margin: 0; font-family: var(--font-display); font-size: 1.05rem; overflow-wrap: anywhere; }
.pla-modal-form { display: flex; flex-direction: column; gap: var(--space-3); overflow-y: auto; }

/* Vacíos y cargando */
.pla-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.pla-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.pla-vacio p { margin: 0 0 var(--space-2); }
.pla-vacio-sub { font-size: .82rem; color: var(--text-faint); }
.pla-vacio .pla-btn-primario { margin-top: var(--space-4); }
.pla-cargando { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-faint); font-size: .9rem; }

/* ============================================================
   PANORAMA — hero + tiles + top gastos + waterfall
   ============================================================ */

/* Hero: número héroe del balance con curva de fondo */
.pla-hero { position: relative; overflow: hidden; border-radius: var(--radius-lg); border: 1px solid var(--border-strong); background:
  linear-gradient(160deg, color-mix(in srgb, var(--hcol) 8%, transparent), transparent 55%), var(--surface);
  padding: clamp(18px, 4vw, 28px); margin-bottom: var(--space-4); }
.pla-hero::before { content: ""; position: absolute; width: 320px; height: 320px; right: -80px; top: -160px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, color-mix(in srgb, var(--hcol) 14%, transparent), transparent 65%); animation: vida-breathe 5.5s ease-in-out infinite; }
.pla-hero-curva { position: absolute; left: 0; right: 0; bottom: 0; height: 80px; pointer-events: none; opacity: .9; }
.pla-hero-curva svg { width: 100%; height: 100%; display: block; }
.pla-hero-cont { position: relative; }
.pla-hero-cap { font-size: .72rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }
.pla-hero-num { display: block; margin: var(--space-2) 0 var(--space-3); font-weight: 800; font-size: clamp(2.1rem, 7vw, 3.2rem); line-height: 1; letter-spacing: -.02em; overflow-wrap: anywhere; }
.pla-hero-fila { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.pla-hero-io { display: flex; gap: var(--space-4); flex-wrap: wrap; font-size: .82rem; color: var(--text-dim); }
.pla-hero-io-item { display: inline-flex; align-items: center; gap: 6px; }
.pla-hero-io-item b { color: var(--text); font-weight: 700; }

/* Puntos de leyenda */
.pla-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.pla-dot-in { background: var(--ok); }
.pla-dot-out { background: var(--danger); }
.pla-dot-bal { background: var(--accent); }

/* Delta badges */
.pla-delta { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 999px; font-size: .74rem; font-weight: 700; font-family: var(--font-num); white-space: nowrap; }
.pla-delta-vs { font-family: var(--font-ui); font-weight: 600; font-size: .68rem; opacity: .7; }
.pla-delta-ok { background: rgba(67,209,124,.14); color: var(--ok); }
.pla-delta-mal { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
.pla-delta-neutro { background: var(--surface-2); color: var(--text-dim); }
.pla-delta-mini { display: inline-flex; align-items: center; gap: 3px; font-family: var(--font-num); font-size: .74rem; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
.pla-delta-mini.pla-delta-ok { background: rgba(67,209,124,.14); color: var(--ok); }
.pla-delta-mini.pla-delta-mal { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
.pla-delta-mini.pla-delta-neutro { background: var(--surface-2); color: var(--text-faint); }

/* Tiles vivos */
.pla-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
.pla-tile { position: relative; padding: var(--space-4); border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.pla-tile::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--tcol); opacity: .7; }
.pla-tile:hover { border-color: color-mix(in srgb, var(--tcol) 45%, transparent); }
.pla-tile-cap { font-size: .68rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint); }
.pla-tile-val { margin-top: var(--space-2); font-size: 1.3rem; font-weight: 800; line-height: 1.1; overflow-wrap: anywhere; }
.pla-tile-sub { margin-top: var(--space-2); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: .74rem; color: var(--text-dim); }
.pla-tile-io { color: var(--text-faint); }

/* Top gastos */
.pla-top-lista { display: flex; flex-direction: column; gap: var(--space-3); }
.pla-top-item { display: flex; align-items: flex-start; gap: var(--space-3); }
.pla-top-rank { flex: none; width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-2-soft); color: var(--accent-2); font-family: var(--font-num); font-weight: 700; font-size: .8rem; margin-top: 2px; }
.pla-top-info { flex: 1; min-width: 0; }
.pla-top-fila { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.pla-top-nombre { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }
.pla-top-monto { font-size: .88rem; font-weight: 700; color: var(--danger); white-space: nowrap; }
.pla-top-sub { font-size: .74rem; color: var(--text-dim); margin-top: 1px; overflow-wrap: anywhere; }
.pla-top-bar { height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; margin-top: 6px; }
.pla-top-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--danger), color-mix(in srgb, var(--danger) 55%, transparent)); transition: width var(--dur-slow) var(--ease-out-expo); }

/* Waterfall */
.pla-wf-graf { position: relative; height: var(--wf-h); margin: var(--space-2) 0 var(--space-3); }
.pla-wf-cero { position: absolute; left: 0; right: 0; height: 1px; background: var(--border-strong); z-index: 1; }
.pla-wf-slots { position: relative; display: flex; align-items: stretch; gap: 2px; height: 100%; z-index: 2; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
.pla-wf-slot { flex: 1 1 0; min-width: 46px; display: flex; flex-direction: column; }
.pla-wf-area { position: relative; height: var(--wf-h); }
.pla-wf-col { position: absolute; left: 12%; right: 12%; border-radius: 4px; transition: height var(--dur-slow) var(--ease-out-expo); box-shadow: 0 0 10px color-mix(in srgb, var(--wcol) 45%, transparent); }
.pla-wf-base { position: absolute; left: 20%; right: 20%; height: 2px; border-radius: 2px; background: var(--text-faint); transform: translateY(-1px); }
.pla-wf-val { margin-top: var(--space-1); font-size: .62rem; color: var(--text-dim); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pla-wf-lbl { font-size: .6rem; color: var(--text-faint); text-align: center; text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pla-wf-leyenda { display: flex; gap: var(--space-4); flex-wrap: wrap; padding-top: var(--space-3); border-top: 1px solid var(--border); font-size: .72rem; color: var(--text-dim); }
.pla-wf-leyenda span { display: inline-flex; align-items: center; gap: 6px; }

/* Balance destacado en el resumen */
.pla-res-tot-bal { background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); border: 1px solid var(--border); }

/* Desktop */
@media (min-width: 768px) {
  .pla { padding: var(--space-6); max-width: 860px; }
  .pla-tab { flex: none; }
  .pla-modal { align-items: center; }
  .pla-modal-card { border-radius: var(--radius-lg); }
  .pla-wf-slot { min-width: 0; }
}
`;

function inyectarEstilos() {
  if (document.getElementById('pla-styles')) return;
  const st = document.createElement('style');
  st.id = 'pla-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Interfaz canónica del módulo (CONTRATOS.md §4)
   ============================================================ */
export default {
  id: 'plata',
  label: 'Plata',

  async init(container, userId, config) {
    S.container = container;
    S.userId = userId;
    S.config = config;
    S.tab = 'panorama';
    S.mes = mesActual();
    S.form = formInicial();
    S.movimientos = [];
    S.movimientosPrev = null;
    S.objetivos = [];
    S.aportesObjetivos = [];
    S.aporteModal = null;
    S.objetivoModal = null;
    S.targetModal = null;
    inyectarEstilos();
    bind();
    if (!supabase) {
      container.innerHTML = `
      <div class="pla">
        <div class="pla-vacio">
          <div class="pla-vacio-icono">🔌</div>
          <p>Supabase no está configurado.</p>
          <p class="pla-vacio-sub">Completá js/core/env.js con tu URL y anon key (ver SETUP.md).</p>
        </div>
      </div>`;
      return;
    }
    container.innerHTML = `<div class="pla"><div class="pla-cargando">Cargando Plata…</div></div>`;
    try {
      await cargarMovimientos();
      S.ultimaCarga = Date.now();
    } catch (err) {
      toast('No se pudieron cargar los movimientos: ' + msgErr(err), 'error');
    }
    this.render();
    // El Panorama es el tab default → traer el mes anterior para el delta (tolerante).
    if (S.tab === 'panorama') asegurarMesAnterior();
  },

  render() {
    if (!S.container) return;
    if (!supabase) return;
    // Si cambió el mes real desde la última visita (app abierta cruzando de mes),
    // reenganchar el mes visible al actual sin dejar datos viejos bajo el label.
    if ((S.tab === 'mes' || S.tab === 'panorama' || S.tab === 'resumen')
        && S.mes !== mesActual() && Date.now() - S.ultimaCarga > 6 * 60 * 60 * 1000) {
      S.mes = mesActual();
      S.movimientos = [];
      S.movimientosPrev = null; // el cache del mes anterior ya no corresponde
      S.cargando = true;
      paint();
      S.ultimaCarga = Date.now();
      cargarMovimientos()
        .then(() => { S.cargando = false; paint(); if (S.tab === 'panorama') asegurarMesAnterior(); })
        .catch(() => { S.cargando = false; paint(); toast('No se pudo actualizar el mes', 'warning'); });
      return;
    }
    paint();
    if (S.tab === 'panorama') asegurarMesAnterior();
    // Refresco silencioso al volver de otra ruta (multi-device).
    if (Date.now() - S.ultimaCarga > 30000) {
      S.ultimaCarga = Date.now();
      const tareas = [cargarMovimientos()];
      if (S.objetivos.length || S.tab === 'objetivos') tareas.push(cargarObjetivos());
      Promise.all(tareas)
        .then(() => {
          // El mes anterior también pudo cambiar en otro device → refrescar su cache.
          if (S.tab === 'panorama') { S.movimientosPrev = null; asegurarMesAnterior(); }
          paint();
        })
        .catch(() => { /* silencioso: la data pintada coincide con su label */ });
    }
  },
};
