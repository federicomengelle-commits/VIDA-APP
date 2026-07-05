// VIDA — Módulo Insights (Fase 5a · determinístico, SIN IA todavía)
// Dashboard READ-ONLY: lee las tablas de los demás módulos y muestra un
// chequeo cruzado con números reales. NUNCA escribe. Robustez máxima:
// cada card en su propio try/catch → si una tabla no existe o falla una
// query, esa card muestra "sin datos todavía" y el resto sigue vivo.
// Contrato: docs/CONTRATOS.md §4 y §13. Roadmap: CLAUDE.md §4 (Fase 5).
import { supabase } from '../core/supabase.js';
// Insights lee config de OTROS módulos (nutricion.proteina_target, plata objetivos),
// no solo la suya → importa el accessor global read-only (cache ya cargado en login).
import { getConfig } from '../core/config.js';

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
  // Resultado por dominio: { estado: 'ok'|'vacio'|'error', ...datos }
  nutricion: null,
  plata: null,
  rutina: null,
  training: null,
  cruces: null,
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

// ---- Cruces determinísticos (solo con data de ambos lados) ----
function calcularCruces() {
  const out = [];
  const nut = S.nutricion;
  const rut = S.rutina;
  const tra = S.training;
  const pla = S.plata;

  // 1) Adherencia de rutina (7d) vs proteína promedio (7d).
  if (rut && rut.estado === 'ok' && rut.adh7 != null && nut && nut.estado === 'ok' && nut.target != null) {
    const adh = rut.adh7; // ventana fija de 7 días, en línea con prom7
    const cumpleProt = nut.prom7 >= nut.target;
    let txt;
    if (adh >= 70 && cumpleProt) txt = 'Semana redonda: adherencia alta y proteína en target. Sostené el ritmo.';
    else if (adh >= 70 && !cumpleProt) txt = 'Buena adherencia a la rutina, pero la proteína promedio quedó bajo el target. Ojo con la comida.';
    else if (adh < 70 && cumpleProt) txt = 'La proteína viene bien, pero la adherencia a la rutina está floja. Ahí hay margen.';
    else txt = 'Semana para reenganchar: adherencia y proteína quedaron por debajo. Un ítem a la vez.';
    out.push({ icono: '🔗', titulo: 'Rutina vs. proteína (7 días)', texto: txt,
      dato: `Adherencia ${adh}% · Proteína prom ${fmtNum(nut.prom7)} g / ${fmtNum(nut.target)} g` });
  }

  // 2) Gasto en Gym/Salud vs sesiones de training (mes actual / rango).
  if (pla && pla.estado === 'ok' && tra && tra.estado === 'ok') {
    const nGasto = (pla.gastoGymSalud || []).length;
    if (nGasto > 0) {
      const ses = tra.sesiones30;
      let txt;
      if (ses > 0) txt = `Estás pagando salud/actividad y entrenando (${fmtNum(ses)} sesiones en 30 días). El gasto se está usando.`;
      else txt = 'Hay gasto en salud/actividad este mes pero no registraste sesiones de training en 30 días. ¿Plata sin uso?';
      out.push({ icono: '💪', titulo: 'Salud/actividad vs. entrenamiento', texto: txt,
        dato: `${nGasto} movimiento(s) · ${fmtNum(ses)} sesiones (30d)` });
    }
  }

  // 3) Días sin entrenar (señal simple pero útil).
  if (tra && tra.estado === 'ok' && tra.diasSinEntrenar != null) {
    if (tra.diasSinEntrenar >= 4) {
      out.push({ icono: '⏳', titulo: 'Días sin entrenar', texto:
        `Van ${fmtNum(tra.diasSinEntrenar)} días desde tu última sesión. Si no fue descanso planeado, quizás toca volver.`,
        dato: 'Última sesión: ' + esc(tra.ultima) });
    }
  }

  return out;
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
  S.cruces = calcularCruces();
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
  S.cruces = calcularCruces();
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
    <header class="ins-head">
      <div class="ins-head-fila">
        <h2 class="ins-titulo">Insights</h2>
        <div class="ins-rango" role="group" aria-label="Rango de análisis">
          <button class="ins-rango-btn${S.rango === 7 ? ' activa' : ''}" data-action="rango" data-rango="7">7 días</button>
          <button class="ins-rango-btn${S.rango === 30 ? ' activa' : ''}" data-action="rango" data-rango="30">30 días</button>
        </div>
      </div>
      <p class="ins-sub">Chequeo cruzado con tus números reales. Solo lectura.</p>
    </header>
    <div class="ins-grid">
      ${cardSugerencias()}
      ${cardCruces()}
      ${cardNutricion()}
      ${cardPlata()}
      ${cardRutina()}
      ${cardTraining()}
    </div>
  </div>`;
}

// Envoltorio de card genérico con encabezado.
function card(icono, titulo, cuerpo, extraClase = '') {
  return `
  <section class="ins-card ${extraClase}">
    <div class="ins-card-head">
      <span class="ins-card-icono">${icono}</span>
      <h3 class="ins-card-titulo">${esc(titulo)}</h3>
    </div>
    <div class="ins-card-cuerpo">${cuerpo}</div>
  </section>`;
}

function loadingCuerpo() { return `<div class="ins-cargando">Cargando…</div>`; }
function sinDatosCuerpo(msg) {
  return `<div class="ins-sindatos"><span class="ins-sindatos-ic">—</span><span>${esc(msg || 'Sin datos todavía')}</span></div>`;
}

/* ---------- Card Sugerencias (PRÓXIMAMENTE — no simular IA) ---------- */
function cardSugerencias() {
  return `
  <section class="ins-card ins-card-destacada">
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

/* ---------- Card Cruces ---------- */
function cardCruces() {
  if (S.cargando || S.cargandoRango) return card('🔗', 'Cruces', loadingCuerpo());
  const cruces = S.cruces || [];
  if (!cruces.length) {
    return card('🔗', 'Cruces',
      sinDatosCuerpo('Todavía no hay suficiente data en dos o más módulos para cruzar. Cargá comida, rutina y entrenos unos días.'));
  }
  const cuerpo = `<div class="ins-cruces">${cruces.map(c => `
    <div class="ins-cruce">
      <div class="ins-cruce-head"><span class="ins-cruce-ic">${c.icono}</span><span class="ins-cruce-tit">${esc(c.titulo)}</span></div>
      <p class="ins-cruce-txt">${esc(c.texto)}</p>
      ${c.dato ? `<div class="ins-cruce-dato ins-num">${esc(c.dato)}</div>` : ''}
    </div>`).join('')}</div>`;
  return card('🔗', 'Cruces', cuerpo, 'ins-card-cruces');
}

/* ---------- Card Nutrición ---------- */
function cardNutricion() {
  if (S.cargando) return card('🥩', 'Nutrición', loadingCuerpo());
  const n = S.nutricion;
  if (!n || n.estado === 'error') return card('🥩', 'Nutrición', sinDatosCuerpo('No se pudo leer Nutrición (¿corriste sql/01?).'));
  if (n.estado === 'vacio') return card('🥩', 'Nutrición', sinDatosCuerpo('Todavía no registraste comidas esta semana.'));
  const tieneTarget = n.target != null;
  const pctHoy = tieneTarget ? Math.min(100, (n.protHoy / n.target) * 100) : 0;
  const claseHoy = !tieneTarget ? '' : (n.protHoy >= n.target ? 'ins-bar-ok' : (n.piso != null && n.protHoy >= n.piso ? 'ins-bar-warn' : 'ins-bar-bajo'));
  const cuerpo = `
    <div class="ins-metrica">
      <div class="ins-metrica-fila">
        <span class="ins-metrica-k">Proteína hoy</span>
        <span class="ins-metrica-v ins-num">${fmtNum(n.protHoy)} g${tieneTarget ? ` <span class="ins-metrica-de">/ ${fmtNum(n.target)}</span>` : ''}</span>
      </div>
      ${tieneTarget ? `<div class="ins-bar"><div class="ins-bar-fill ${claseHoy}" style="width:${pctHoy}%"></div></div>` : ''}
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
      <div class="ins-objetivo-head"><span class="ins-objetivo-nombre">🎯 ${esc(o.nombre)}</span></div>
      ${tieneTarget ? `
      <div class="ins-bar"><div class="ins-bar-fill ins-bar-accent" style="width:${pctObj}%"></div></div>
      <div class="ins-objetivo-sub ins-num">${fmtMonto(o.aportado, o.moneda)} / ${fmtMonto(o.target, o.moneda)} · ${Math.floor(pctObj)}%</div>`
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
    <div class="ins-datos">
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${r.adherenciaGlobal}%</span>
        <span class="ins-dato-k">Adherencia ${r.dias} días</span>
      </div>
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(r.racha)}</span>
        <span class="ins-dato-k">Racha (días completos)</span>
      </div>
    </div>
    <div class="ins-bar"><div class="ins-bar-fill ins-bar-accent" style="width:${r.adherenciaGlobal}%"></div></div>
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
        <span class="ins-dato-v ins-num">${fmtNum(t.sesiones7)}</span>
        <span class="ins-dato-k">Sesiones 7 días</span>
      </div>
      <div class="ins-dato">
        <span class="ins-dato-v ins-num">${fmtNum(t.sesiones30)}</span>
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

/* ============================================================
   Estilos — inyectados 1 vez, prefijo ins-, solo var(--token)
   ============================================================ */
const CSS = `
.ins { max-width: 900px; margin: 0 auto; padding: var(--space-4); font-family: var(--font-ui); color: var(--text); }
.ins * { box-sizing: border-box; }
.ins button { font: inherit; color: inherit; cursor: pointer; }
.ins button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.ins-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

/* Header */
.ins-head { margin-bottom: var(--space-4); }
.ins-head-fila { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.ins-titulo { margin: 0; font-family: var(--font-display); font-size: 1.35rem; letter-spacing: .01em; }
.ins-sub { margin: var(--space-2) 0 0; font-size: .82rem; color: var(--text-dim); }
.ins-rango { display: flex; gap: var(--space-1); background: var(--surface-2); border-radius: var(--radius); padding: var(--space-1); }
.ins-rango-btn { min-height: 38px; padding: var(--space-1) var(--space-3); border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-dim); font-weight: 600; font-size: .82rem; transition: background .15s, color .15s; }
.ins-rango-btn.activa { background: var(--accent-soft); color: var(--accent); }

/* Grid de cards */
.ins-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }

/* Card base */
.ins-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); box-shadow: var(--shadow-1); }
.ins-card-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
.ins-card-icono { font-size: 1.15rem; flex: none; }
.ins-card-titulo { margin: 0; font-family: var(--font-display); font-size: 1rem; flex: 1; min-width: 0; }
.ins-card-cuerpo { display: flex; flex-direction: column; gap: var(--space-3); }

/* Card destacada (Sugerencias) */
.ins-card-destacada { border-color: var(--accent-2); background: linear-gradient(160deg, var(--accent-2-soft), transparent 60%), var(--surface); }
.ins-proximamente { flex: none; padding: 3px 10px; background: var(--accent-2-soft); border: 1px solid var(--accent-2); border-radius: 999px; color: var(--accent-2); font-size: .64rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.ins-sug-txt { margin: 0; font-size: .95rem; color: var(--text); }
.ins-sug-sub { margin: 0; font-size: .82rem; color: var(--text-dim); }
.ins-sug-nota { margin-top: var(--space-1); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); font-size: .78rem; color: var(--text-faint); }

/* Métrica principal con barra */
.ins-metrica-fila { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); }
.ins-metrica-k { font-size: .8rem; color: var(--text-dim); }
.ins-metrica-v { font-size: 1.35rem; font-weight: 700; }
.ins-metrica-de { font-size: .85rem; color: var(--text-dim); font-weight: 400; }

/* Barra de progreso */
.ins-bar { height: 10px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.ins-bar-fill { height: 100%; border-radius: 999px; background: var(--text-faint); transition: width .35s ease; }
.ins-bar-ok { background: var(--ok); }
.ins-bar-warn { background: var(--warn); }
.ins-bar-bajo { background: var(--danger); }
.ins-bar-accent { background: var(--accent); }

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
.ins-objetivo { padding-top: var(--space-2); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--space-2); }
.ins-objetivo-nombre { font-size: .88rem; font-weight: 600; overflow-wrap: anywhere; }
.ins-objetivo-sub { font-size: .78rem; color: var(--text-dim); }

/* PR */
.ins-pr { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); border-left: 3px solid var(--accent); }
.ins-pr-ic { font-size: 1.3rem; flex: none; }
.ins-pr-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ins-pr-ej { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }
.ins-pr-dato { font-size: .78rem; color: var(--text-dim); }

/* Cruces */
.ins-card-cruces { border-color: var(--accent-soft); }
.ins-cruces { display: flex; flex-direction: column; gap: var(--space-3); }
.ins-cruce { padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius); border-left: 3px solid var(--accent); }
.ins-cruce-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); }
.ins-cruce-ic { font-size: 1rem; flex: none; }
.ins-cruce-tit { font-size: .85rem; font-weight: 700; }
.ins-cruce-txt { margin: 0; font-size: .85rem; color: var(--text-dim); line-height: 1.4; }
.ins-cruce-dato { margin-top: var(--space-2); font-size: .74rem; color: var(--text-faint); }

/* Sin datos / cargando */
.ins-sindatos { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-2); color: var(--text-faint); font-size: .85rem; }
.ins-sindatos-ic { font-family: var(--font-num); opacity: .6; }
.ins-cargando { padding: var(--space-5) var(--space-2); text-align: center; color: var(--text-faint); font-size: .85rem; }

/* Vacío global */
.ins-vacio { padding: var(--space-8) var(--space-4); text-align: center; color: var(--text-dim); }
.ins-vacio-icono { font-size: 2.2rem; margin-bottom: var(--space-3); }
.ins-vacio p { margin: 0 0 var(--space-2); }
.ins-vacio-sub { font-size: .82rem; color: var(--text-faint); }

/* Desktop: 2 columnas, destacada full-width */
@media (min-width: 768px) {
  .ins { padding: var(--space-6); }
  .ins-grid { grid-template-columns: 1fr 1fr; }
  .ins-card-destacada, .ins-card-cruces { grid-column: 1 / -1; }
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
    S.cruces = null;
    S.cargando = true;
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
