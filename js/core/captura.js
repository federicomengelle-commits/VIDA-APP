// VIDA — Captura universal (voz + texto) v0 · SIN API key
// El diferencial de VIDA (CLAUDE.md §0): una línea hablada/escrita → la app
// la entiende, muestra qué entendió para confirmar/editar, y la inserta en el
// módulo correcto. Contrato VINCULANTE: docs/CONTRATOS.md §15.
//
// SEAM DE IA (Fase 5b): el ÚNICO punto que cambia cuando llegue la
// ANTHROPIC_API_KEY es `interpretar(texto)`. Hoy es un parser determinístico
// es-AR; mañana será `await fetch('/api/parse', ...)` que devuelve la MISMA
// forma de propuesta. La UI (overlay, card de confirmación) y los inserts
// (commit) NO se tocan. Por eso `interpretar` está aislado y documentado.
//
// SEGURIDAD: nunca auto-commitea. Toda propuesta pasa por la card de
// confirmación editable. Aunque el parser v0 se equivoque, el usuario revisa.

import { supabase } from './supabase.js';
import { getUserId } from './auth.js';
import { getConfig } from './config.js';
import { toast } from './ui.js';
import { navigate } from './router.js';

/* ============================================================
   Utilidades base
   ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function msgErr(err) { return (err && err.message) ? err.message : 'error de conexión'; }

// Normaliza para matchear: minúsculas, sin acentos/diacríticos, espacios simples.
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---- Fechas: YYYY-MM-DD local del dispositivo (semana arranca lunes) ---- */
function fmtFecha(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hoyStr() { return fmtFecha(new Date()); }
function addDias(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }

// Resuelve una fecha relativa en es-AR a partir del texto normalizado.
// "hoy" (default) · "ayer" · "anteayer"/"antes de ayer" · "el lunes".. (día
// de la semana más reciente ya pasado, o hoy si coincide).
function resolverFecha(n) {
  const hoy = new Date();
  if (/\banteayer\b|\bantes de ayer\b/.test(n)) return fmtFecha(addDias(hoy, -2));
  if (/\bayer\b/.test(n)) return fmtFecha(addDias(hoy, -1));
  if (/\bhoy\b/.test(n)) return hoyStr();
  // getDay(): 0=domingo..6=sábado. Mapeo por nombre de día.
  const dias = {
    domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
  };
  const m = n.match(/\bel (domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (m) {
    const objetivo = dias[m[1]];
    const actual = hoy.getDay();
    let diff = actual - objetivo;
    if (diff < 0) diff += 7;   // el día de la semana más reciente (incluye hoy)
    return fmtFecha(addDias(hoy, -diff));
  }
  return hoyStr();
}

/* ============================================================
   Parser de montos / números en palabras (es-AR)
   ============================================================ */
const NUM_PALABRAS = {
  cero: 0, un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veinticinco: 25, treinta: 30,
  cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
  noventa: 90, cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700,
  ochocientos: 800, novecientos: 900, mil: 1000,
};

// Convierte una secuencia corta de palabras-número a un entero.
// Cubre lo básico del contrato: "mil quinientos" → 1500, "cinco mil" → 5000,
// "dos mil quinientos" → 2500, "cien" → 100. No pretende ser un parser total
// del español; alcanza para captura de una línea.
function palabrasANumero(tokens) {
  if (!tokens.length) return null;
  let total = 0, actual = 0, vistoAlgo = false;
  for (const t of tokens) {
    if (!(t in NUM_PALABRAS) && t !== 'y') return null; // token no numérico corta
    if (t === 'y') continue;
    const v = NUM_PALABRAS[t];
    vistoAlgo = true;
    if (v === 1000) {
      actual = (actual === 0 ? 1 : actual) * 1000;
      total += actual;
      actual = 0;
    } else {
      actual += v;
    }
  }
  if (!vistoAlgo) return null;
  return total + actual;
}

// Parsea "5 lucas", "cinco lucas", "5 mil", "5k", "una luca", "$1.500",
// "1500 pesos", "mil quinientos", "20 dólares/usd/verdes".
// Devuelve { monto, moneda|null } o null. moneda solo se setea si hay señal
// explícita de dólar; el default de moneda lo pone el caller (config).
function parseMonto(n) {
  let moneda = null;
  if (/\b(dolar|dolares|usd|verde|verdes|dolar blue|u\$s)\b/.test(n)) moneda = 'USD';

  // 1) Símbolo $ o números con separador de miles es-AR: $1.500 · 1.234.567
  //    Interpretamos el punto como separador de miles (uso rioplatense).
  let m = n.match(/\$\s?([\d.]+(?:,\d+)?)/) || n.match(/\b(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\b/);
  if (m) {
    const limpio = m[1].replace(/\./g, '').replace(',', '.');
    const val = Number(limpio);
    if (val > 0) return { monto: aplicarLucas(n, val), moneda };
  }

  // 2) Número + "k" (5k = 5000)
  m = n.match(/\b(\d+(?:[.,]\d+)?)\s?k\b/);
  if (m) {
    const val = Number(m[1].replace(',', '.')) * 1000;
    if (val > 0) return { monto: val, moneda };
  }

  // 3) Número dígito suelto (con "mil"/"luca(s)" como multiplicador si aplica)
  m = n.match(/\b(\d+(?:[.,]\d+)?)\b/);
  if (m) {
    let val = Number(m[1].replace(',', '.'));
    val = aplicarLucas(n, val, m[1]);
    // "5 mil" → 5000 (si el número precede a "mil" y no fue ya multiplicado)
    if (/\bmil\b/.test(n) && val < 1000 && !/luca/.test(n)) val *= 1000;
    if (val > 0) return { monto: val, moneda };
  }

  // 4) Todo en palabras: "cinco lucas", "mil quinientos", "una luca"
  const tokens = n.replace(/[^a-z\s]/g, ' ').split(' ').filter(Boolean);
  // "una luca" / "cinco lucas" → N * 1000
  const lucaM = n.match(/\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta)\s+lucas?\b/);
  if (lucaM) {
    const base = NUM_PALABRAS[lucaM[1]] || 1;
    return { monto: base * 1000, moneda };
  }
  // Secuencia de palabras-número (tomamos los tokens numéricos contiguos)
  const numToks = [];
  for (const t of tokens) {
    if (t in NUM_PALABRAS || t === 'y') numToks.push(t);
    else if (numToks.length) break;
  }
  const val = palabrasANumero(numToks);
  if (val && val > 0) return { monto: val, moneda };

  return null;
}

// Aplica el multiplicador "luca(s)" cuando el número es un dígito: "5 lucas" → 5000.
function aplicarLucas(n, val, raw) {
  if (/\bluca(s)?\b/.test(n) && val < 1000) return val * 1000;
  return val;
}

// Extrae un entero de "2 huevos", "3 scoops": cantidad que antecede a un ítem.
function parseCantidadAntes(n, nombreNorm) {
  const idx = n.indexOf(nombreNorm);
  if (idx < 0) return 1;
  const antes = n.slice(0, idx).trim();
  const m = antes.match(/(\d+)\s*$/) || antes.match(/\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*$/);
  if (!m) return 1;
  const v = /\d/.test(m[1]) ? Number(m[1]) : NUM_PALABRAS[m[1]];
  return v > 0 ? v : 1;
}

// Escapa una cadena para usarla dentro de un RegExp.
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Match por palabra completa (evita que "pan" pegue dentro de "pantalón").
function contienePalabra(n, w) {
  if (!w) return false;
  try { return new RegExp('(?:^|[^a-z0-9])' + escRe(w) + '(?:$|[^a-z0-9])').test(n); }
  catch (_) { return n.includes(w); }
}

// Gramos de una porción tipo "250 g" / "200 g". 0 si la porción es en unidades
// ("2 u", "1 scoop", "½") — ahí la cantidad se cuenta por unidad, no por gramo.
function gramosDePorcion(porcion) {
  const m = String(porcion || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*g\b/i);
  return m ? Number(m[1].replace(',', '.')) : 0;
}

// Gramos dichos antes de un alimento: "250 de carne", "250 g de carne", "250g carne".
function gramosDichos(n, nombreNorm) {
  try {
    const m = n.match(new RegExp('(\\d+)\\s*(?:g|gr|gramos?)?\\s*(?:de\\s+)?' + escRe(nombreNorm)));
    return m ? Number(m[1]) : null;
  } catch (_) { return null; }
}

// Normaliza un monto editado a mano en formato es-AR:
// "1.500" → 1500 (punto de miles) · "1500,50" → 1500.5 · "1500.50" → 1500.5
function montoEditado(str) {
  let s = String(str == null ? '' : str).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');          // 1.500,50 → 1500.50
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');          // 1.500 / 1.234.567 → miles
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/* ============================================================
   Config del usuario — TODO de user_config (cero hardcodeo de valores)
   ============================================================ */
function cfgMonedas() {
  const m = getConfig('plata', 'monedas', []);
  return Array.isArray(m) ? m.filter(x => typeof x === 'string' && x.trim()) : [];
}
function cfgAmbitos() {
  const a = getConfig('plata', 'ambitos', []);
  return Array.isArray(a) ? a.filter(x => x && x.id && x.label) : [];
}
function cfgCategorias(tipo) {
  const c = getConfig('plata', 'categorias', null) || {};
  const lista = c && Array.isArray(c[tipo]) ? c[tipo] : [];
  return lista.filter(x => typeof x === 'string' && x.trim());
}
function cfgSlots() {
  const s = getConfig('nutricion', 'slots', []);
  return Array.isArray(s) ? s.filter(x => x && x.id && x.label) : [];
}
function primeraMoneda() { const m = cfgMonedas(); return m.length ? m[0] : 'ARS'; }
function primerAmbitoId() { const a = cfgAmbitos(); return a.length ? a[0].id : 'personal'; }
function labelAmbito(id) { const a = cfgAmbitos().find(x => x.id === id); return a ? a.label : (id || '—'); }

/* ============================================================
   Léxico del parser — es léxico del IDIOMA, no valores del usuario.
   Permitido por el contrato (§15 "Reglas").
   ============================================================ */
const DISPARADORES_EGRESO = ['gaste', 'pague', 'compre', 'me salio', 'se me fue', 'gasto en', 'gasto de'];
const DISPARADORES_INGRESO = ['cobre', 'me pagaron', 'ingreso de', 'me entro', 'facture', 'me deposito', 'me depositaron'];
const DISPARADORES_COMIDA = ['comi', 'almorce', 'cene', 'merende', 'desayune', 'me tome un batido', 'me comi', 'desayuno', 'almuerzo de', 'cena de'];
const DISPARADORES_TRAINING = ['entrene', 'hice', 'entreno de'];
const DISPARADORES_HABITO = ['tome', 'me tome', 'hice', 'complete', 'termine'];

// Mapa verbo→slot para nutrición. Si no matchea, cae al primer slot de config.
function slotPorVerbo(n) {
  if (/\balmorce\b|\balmuerzo\b/.test(n)) return 'almuerzo';
  if (/\bcene\b|\bcena\b/.test(n)) return 'cena';
  if (/\bmerende\b|\bmerienda\b|\bdesayune\b|\bdesayuno\b|batido\b/.test(n)) return 'merienda';
  return null;
}

// Keywords de categoría → NOMBRE de categoría de config (matcheo por contains).
// Los keywords son léxico; el NOMBRE final debe existir en config.categorias.
const CAT_KEYWORDS = {
  Comida: ['super', 'supermercado', 'comida', 'almacen', 'verduleria', 'carniceria', 'restaurant', 'resto', 'delivery', 'pedidosya', 'rappi', 'chino', 'kiosco', 'panaderia'],
  Transporte: ['nafta', 'combustible', 'uber', 'cabify', 'didi', 'bondi', 'colectivo', 'subte', 'tren', 'peaje', 'estacionamiento', 'sube', 'taxi', 'remis'],
  Salud: ['farmacia', 'medico', 'remedio', 'remedios', 'obra social', 'prepaga', 'dentista', 'psicologo', 'analisis'],
  Gym: ['gym', 'gimnasio', 'suplemento', 'suplementos', 'proteina', 'creatina', 'entrenador'],
  Suscripciones: ['netflix', 'spotify', 'disney', 'hbo', 'suscripcion', 'suscripciones', 'youtube', 'chatgpt', 'membresia'],
  Salidas: ['bar', 'boliche', 'cine', 'salida', 'birra', 'cerveza', 'trago', 'joda', 'fernet'],
  Vivienda: ['alquiler', 'expensas', 'luz', 'gas', 'agua', 'internet', 'wifi', 'seguro hogar'],
  Impuestos: ['impuesto', 'impuestos', 'afip', 'monotributo', 'arba', 'rentas', 'abl', 'patente'],
  Compras: ['ropa', 'zapatillas', 'compras', 'mercadolibre', 'amazon', 'regalo', 'electrodomestico'],
};

// Devuelve el NOMBRE de categoría (que exista en config.categorias[tipo]) o null.
function matchCategoria(n, tipo) {
  const validas = cfgCategorias(tipo);
  if (!validas.length) return null;
  const validasNorm = new Map(validas.map(v => [norm(v), v]));
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS)) {
    const catNorm = norm(cat);
    if (!validasNorm.has(catNorm)) continue; // esa categoría no está en la config del usuario
    if (kws.some(k => n.includes(k))) return validasNorm.get(catNorm);
  }
  // Match directo: el texto nombra una categoría de la config tal cual.
  for (const [vn, original] of validasNorm) {
    if (vn.length >= 4 && n.includes(vn)) return original;
  }
  return null;
}

// Ámbito por señales de "laburo/trabajo/mepex" → busca id de config que matchee.
function matchAmbito(n) {
  const ambitos = cfgAmbitos();
  if (!ambitos.length) return primerAmbitoId();
  const esMepex = /\bmepex\b|\bdel laburo\b|\bde laburo\b|\btrabajo\b|\bde la empresa\b|\bde mi empresa\b/.test(n);
  if (esMepex) {
    const m = ambitos.find(a => norm(a.id) === 'mepex' || norm(a.label).includes('mepex'));
    if (m) return m.id;
  }
  // Personal explícito o default.
  const personal = ambitos.find(a => norm(a.id) === 'personal' || norm(a.label).includes('personal'));
  return personal ? personal.id : ambitos[0].id;
}

function contieneAlguno(n, lista) { return lista.some(k => n.includes(k)); }

/* ============================================================
   Catálogos on-demand para el parser (nutrición / training / rutina).
   Se traen al abrir el overlay (una vez por sesión de captura) y quedan
   cacheados. Tolerante a tablas ausentes: si una query falla, ese intent
   degrada a confianza baja + aviso, no rompe.
   ============================================================ */
const CAT = {
  cargado: false,
  cargando: null,
  alimentos: [],
  combos: [],
  ejercicios: [],
  rutinas: [],
  errores: { nutricion: false, training: false, rutina: false },
};

async function cargarCatalogos() {
  if (CAT.cargado) return CAT;
  if (CAT.cargando) return CAT.cargando;
  CAT.cargando = (async () => {
    const uid = getUserId();
    if (!supabase || !uid) { CAT.cargado = true; return CAT; }
    const q = (tabla, sel, extra) => {
      let query = supabase.from(tabla).select(sel).eq('user_id', uid);
      if (extra) query = extra(query);
      return query.then(r => r, e => ({ error: e }));
    };
    const [alim, comb, ejer, ruts] = await Promise.all([
      q('nutricion_alimentos', '*', x => x.eq('_deleted', false)),
      q('nutricion_combos', '*', x => x.eq('_deleted', false)),
      q('training_ejercicios', '*', x => x.eq('_deleted', false)),
      q('rutina_rutinas', '*', x => x.eq('_deleted', false).eq('activa', true)),
    ]);
    CAT.alimentos = (!alim.error && alim.data) ? alim.data : [];
    CAT.combos = (!comb.error && comb.data) ? comb.data : [];
    CAT.ejercicios = (!ejer.error && ejer.data) ? ejer.data : [];
    CAT.rutinas = (!ruts.error && ruts.data) ? ruts.data : [];
    CAT.errores.nutricion = !!(alim.error || comb.error);
    CAT.errores.training = !!ejer.error;
    CAT.errores.rutina = !!ruts.error;
    CAT.cargado = true;
    return CAT;
  })();
  return CAT.cargando;
}

/* ============================================================
   EL SEAM DE IA · interpretar(texto) → propuesta
   ------------------------------------------------------------
   Único punto que cambia en Fase 5b. Contrato de retorno:
     { modulo, confianza:'alta'|'media'|'baja', campos, resumen, crudo }
   o { modulo: null, crudo } si no pudo determinar intención.
   `campos` es específico por módulo (ver commit()).
   Determinístico, es-AR, normaliza sin acentos.
   ============================================================ */
async function interpretar(texto) {
  const crudo = String(texto || '').trim();
  if (!crudo) return { modulo: null, crudo };
  await cargarCatalogos();
  const n = norm(crudo);

  const esEgreso = contieneAlguno(n, DISPARADORES_EGRESO);
  const esIngreso = contieneAlguno(n, DISPARADORES_INGRESO);
  const esComida = contieneAlguno(n, DISPARADORES_COMIDA) || matchComida(n).items.length > 0;
  const esTraining = /\b(entrene|entreno)\b/.test(n) || matchTraining(n) !== null;
  const esHabito = matchHabito(n).length > 0;

  // Prioridad: intención de plata explícita (verbo de dinero + monto) gana,
  // porque "compré" también podría sonar a comida. Luego training, luego
  // rutina/hábito, luego comida.
  if ((esEgreso || esIngreso)) {
    const prop = propuestaPlata(n, crudo, esIngreso && !esEgreso ? 'ingreso' : 'egreso');
    if (prop) return prop;
  }
  if (esTraining) {
    const prop = propuestaTraining(n, crudo);
    if (prop) return prop;
  }
  if (esHabito && !esComida) {
    const prop = propuestaRutina(n, crudo);
    if (prop) return prop;
  }
  if (esComida) {
    const prop = propuestaNutricion(n, crudo);
    if (prop) return prop;
  }

  // Último intento: si hay monto, tratarlo como egreso (lo más común).
  const monto = parseMonto(n);
  if (monto) {
    const prop = propuestaPlata(n, crudo, 'egreso');
    if (prop) { prop.confianza = 'baja'; return prop; }
  }

  return { modulo: null, crudo };
}

/* ---- Propuesta: Plata ---- */
function propuestaPlata(n, crudo, tipo) {
  const parsed = parseMonto(n);
  const monedaDefault = primeraMoneda();
  const monto = parsed ? parsed.monto : null;
  const moneda = parsed && parsed.moneda ? parsed.moneda : monedaDefault;
  const ambito = matchAmbito(n);
  const categoria = matchCategoria(n, tipo);
  const fecha = resolverFecha(n);

  let confianza;
  if (monto && categoria) confianza = 'alta';
  else if (monto) confianza = 'media';
  else confianza = 'baja';

  return {
    modulo: 'plata',
    confianza,
    campos: {
      tipo,
      monto: monto != null ? monto : '',
      moneda,
      ambito,
      categoria: categoria || '',
      descripcion: '',
      fecha,
    },
    resumen: (tipo === 'ingreso' ? 'Ingreso' : 'Egreso')
      + (monto != null ? ' de ' + monto + ' ' + moneda : '')
      + (categoria ? ' · ' + categoria : '')
      + ' · ' + labelAmbito(ambito),
    crudo,
  };
}

/* ---- Nutrición: match de alimentos/combos del catálogo ---- */
function matchComida(n) {
  const items = [];
  // Combos primero (nombres más específicos), luego alimentos.
  for (const c of CAT.combos) {
    const nom = norm(c.nombre);
    if (nom && nom.length >= 3 && n.includes(nom)) {
      items.push({ tipo: 'combo', id: c.id, nombre: c.nombre, cantidad: 1,
        prot: num(c.prot), carbo: num(c.carbo), grasa: num(c.grasa), kcal: num(c.kcal) });
    }
  }
  const primerasUsadas = new Set(); // no matchear dos alimentos por la misma palabra (carne 200 y 250)
  for (const a of CAT.alimentos) {
    const nom = norm(a.nombre);
    if (!nom || nom.length < 3) continue;
    // Match por nombre completo o por la primera palabra significativa ("carne", "pan").
    const primera = nom.split(' ')[0];
    const porNombre = contienePalabra(n, nom) || n.includes(nom);
    const porPrimera = primera.length >= 3 && contienePalabra(n, primera);
    if (!porNombre && !porPrimera) continue;
    if (items.some(it => it.id === a.id)) continue;
    const clave = porNombre ? nom : primera;
    if (!porNombre && primerasUsadas.has(primera)) continue; // ya matcheamos otro alimento con esa palabra
    primerasUsadas.add(primera);
    // Escala: si la porción es en gramos y el usuario dijo gramos ("250 de carne"),
    // escala por gramos_dichos/gramos_porción; si no, cuenta por unidad ("2 huevos").
    const pg = gramosDePorcion(a.porcion);
    let factor;
    if (pg > 0) { const g = gramosDichos(n, clave); factor = g != null ? g / pg : 1; }
    else { factor = parseCantidadAntes(n, clave); }
    if (!(factor > 0)) factor = 1;
    const cantLabel = pg > 0 && factor !== 1 ? Math.round(pg * factor) + ' g' : factor;
    items.push({ tipo: 'alimento', id: a.id,
      nombre: a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre,
      cantidad: typeof cantLabel === 'number' ? cantLabel : 1, cantLabel,
      prot: num(a.prot) * factor, carbo: num(a.carbo) * factor, grasa: num(a.grasa) * factor, kcal: num(a.kcal) * factor });
  }
  return { items };
}

function propuestaNutricion(n, crudo) {
  const slots = cfgSlots();
  const slotVerbo = slotPorVerbo(n);
  // slot: el del verbo si existe en config; si no, el primero de config.
  let slot = slots.find(s => s.id === slotVerbo);
  if (!slot) slot = slots[0] || null;
  const slotId = slot ? slot.id : (slotVerbo || 'almuerzo');

  const { items } = matchComida(n);
  const tablaAusente = CAT.errores.nutricion;
  const fecha = resolverFecha(n);

  if (items.length) {
    const totalProt = items.reduce((s, it) => s + it.prot, 0);
    return {
      modulo: 'nutricion',
      confianza: 'alta',
      campos: { slot: slotId, fecha, items },
      resumen: (slot ? slot.label : slotId) + ': '
        + items.map(it => (it.cantLabel && it.cantLabel !== 1 ? it.cantLabel + (typeof it.cantLabel === 'number' ? '× ' : ' ') : '') + it.nombre).join(', ')
        + ' · ' + Math.round(totalProt) + ' g prot',
      crudo,
    };
  }

  // Nada matcheó el catálogo → entrada manual (nombre = texto, macros 0).
  return {
    modulo: 'nutricion',
    confianza: 'baja',
    campos: {
      slot: slotId,
      fecha,
      items: [{ tipo: 'custom', id: null, nombre: crudo, cantidad: 1, prot: 0, carbo: 0, grasa: 0, kcal: 0 }],
    },
    resumen: (slot ? slot.label : slotId) + ': ' + crudo + ' · completá los macros'
      + (tablaAusente ? ' (¿corriste sql/01?)' : ''),
    crudo,
  };
}

/* ---- Training: ejercicio + patrón NxM con P ---- */
// Devuelve { ejercicio, sets:[{peso,reps}] } o null si no hay ejercicio+patrón.
function matchTraining(n) {
  // ejercicio: match contra catálogo por nombre o primera palabra.
  let ej = null;
  for (const e of CAT.ejercicios) {
    const nom = norm(e.nombre);
    if (!nom) continue;
    const primera = nom.split(' ')[0];
    if (contienePalabra(n, nom) || n.includes(nom) || (primera.length >= 4 && contienePalabra(n, primera))) { ej = e; break; }
  }
  // patrón "4x10 con 80" · "4 x 10 con 80" · "4x10 80 kg" · "5x5 100 kilos"
  // (el conector con/a/de es opcional: acepta el peso suelto tras las reps)
  const m = n.match(/(\d+)\s*(?:x|por)\s*(\d+)(?:\s*(?:con|a|de)?\s*(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?|k)?\b)?/);
  if (!m) return null;
  const nSets = Math.min(20, Math.max(1, Number(m[1]) || 1));
  const reps = Number(m[2]) || 0;
  const peso = m[3] != null ? Number(String(m[3]).replace(',', '.')) : 0;
  const sets = [];
  for (let i = 0; i < nSets; i++) sets.push({ peso, reps });
  return { ejercicio: ej, sets };
}

function propuestaTraining(n, crudo) {
  const t = matchTraining(n);
  const tablaAusente = CAT.errores.training;
  if (!t) {
    return {
      modulo: 'training',
      confianza: 'baja',
      campos: { ejercicio_id: null, ejercicio_nombre: '', sets: [] },
      resumen: 'No pude leer el ejercicio ni las series'
        + (tablaAusente ? ' (¿corriste sql/06?)' : '') + ' · completá abajo',
      crudo,
    };
  }
  const nombre = t.ejercicio ? t.ejercicio.nombre : '';
  let confianza;
  if (tablaAusente) confianza = 'baja';
  else if (t.ejercicio && t.sets.length) confianza = 'alta';
  else confianza = 'media';
  return {
    modulo: 'training',
    confianza,
    campos: {
      ejercicio_id: t.ejercicio ? t.ejercicio.id : null,
      ejercicio_nombre: nombre,
      sets: t.sets,
    },
    resumen: (nombre || 'Ejercicio')
      + ': ' + t.sets.length + '×' + (t.sets[0] ? t.sets[0].reps : 0)
      + (t.sets[0] && t.sets[0].peso ? ' con ' + t.sets[0].peso + ' kg' : ''),
    crudo,
  };
}

/* ---- Rutina: match de items de rutinas activas → checks ---- */
// Devuelve [{ rutina_id, item_id, label, rutina_nombre }] de los items que matchean.
function matchHabito(n) {
  const encontrados = [];
  for (const r of CAT.rutinas) {
    const items = Array.isArray(r.items) ? r.items : [];
    for (const it of items) {
      if (!it || !it.id || !it.label) continue;
      const lbl = norm(it.label);
      // Palabras clave del label (>=4 letras) presentes en el texto.
      const palabras = lbl.split(' ').filter(w => w.length >= 4);
      const hit = palabras.some(w => n.includes(w)) || (lbl.length >= 4 && n.includes(lbl));
      if (hit) encontrados.push({ rutina_id: r.id, item_id: String(it.id), label: it.label, rutina_nombre: r.nombre });
    }
  }
  return encontrados;
}

function propuestaRutina(n, crudo) {
  const checks = matchHabito(n);
  const fecha = resolverFecha(n);
  if (!checks.length) return null;
  return {
    modulo: 'rutina',
    confianza: checks.length ? 'alta' : 'baja',
    campos: { fecha, checks },
    resumen: 'Marcar: ' + checks.map(c => c.label).join(', '),
    crudo,
  };
}

function num(x) { const v = Number(String(x == null ? '' : x).replace(',', '.')); return Number.isFinite(v) ? Math.max(0, v) : 0; }

/* ============================================================
   Estado del overlay
   ============================================================ */
const O = {
  inyectado: false,
  overlay: null,
  fab: null,
  abierto: false,
  reconociendo: false,
  recognition: null,
  sttDisponible: false,
  texto: '',
  propuesta: null,     // resultado de interpretar() (editable)
  guardando: false,    // guard anti doble-tap del commit
};

/* ---- Web Speech API (STT) ---- */
function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function iniciarSTT() {
  const SR = getSpeechRecognition();
  if (!SR) return;
  try {
    const rec = new SR();
    rec.lang = 'es-AR';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      let txt = '';
      for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      O.texto = txt;
      const ta = O.overlay && O.overlay.querySelector('#capTexto');
      if (ta) ta.value = txt;
    };
    rec.onerror = (ev) => {
      O.reconociendo = false;
      pintarOverlay();
      const err = ev && ev.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        toast('No hay permiso de micrófono. Podés escribir igual.', 'warning');
      } else if (err === 'no-speech') {
        toast('No se escuchó nada. Probá de nuevo o escribí.', 'info');
      } else if (err === 'language-not-supported') {
        // Fallback de idioma: reintentar en es-419 / es-ES quedaría acá.
        toast('Idioma de voz no soportado; escribí el texto.', 'warning');
      }
    };
    rec.onend = () => { O.reconociendo = false; pintarOverlay(); };
    O.recognition = rec;
    O.sttDisponible = true;
  } catch (err) {
    O.sttDisponible = false;
  }
}

function toggleGrabar() {
  if (!O.sttDisponible || !O.recognition) return;
  if (O.reconociendo) {
    try { O.recognition.stop(); } catch (_) {}
    O.reconociendo = false;
    pintarOverlay();
    return;
  }
  try {
    O.recognition.start();
    O.reconociendo = true;
    pintarOverlay();
  } catch (err) {
    // start() tira si ya está corriendo; lo dejamos consistente.
    O.reconociendo = false;
    pintarOverlay();
  }
}

/* ============================================================
   UI — FAB + overlay
   ============================================================ */
function abrir() {
  O.abierto = true;
  O.texto = '';
  O.propuesta = null;
  O.guardando = false;
  origenUltimo = 'texto'; // por defecto; pasa a 'voz' si se usa el micrófono
  cargarCatalogos(); // pre-cachea para que "Entender" sea instantáneo
  pintarOverlay();
  requestAnimationFrame(() => {
    const ta = O.overlay && O.overlay.querySelector('#capTexto');
    if (ta) ta.focus();
  });
}

function cerrar() {
  if (O.reconociendo && O.recognition) { try { O.recognition.stop(); } catch (_) {} }
  O.reconociendo = false;
  O.abierto = false;
  O.propuesta = null;
  O.texto = '';
  if (O.overlay) O.overlay.innerHTML = '';
  if (O.overlay) O.overlay.classList.remove('cap-abierto');
}

async function entender() {
  const ta = O.overlay && O.overlay.querySelector('#capTexto');
  const txt = ta ? ta.value : O.texto;
  O.texto = txt;
  if (!String(txt || '').trim()) { toast('Escribí o dictá algo primero', 'warning'); return; }
  try {
    O.propuesta = await interpretar(txt);
  } catch (err) {
    O.propuesta = { modulo: null, crudo: String(txt).trim() };
    toast('No se pudo interpretar: ' + msgErr(err), 'error');
  }
  pintarOverlay();
}

function pintarOverlay() {
  if (!O.overlay) return;
  if (!O.abierto) { O.overlay.innerHTML = ''; O.overlay.classList.remove('cap-abierto'); return; }
  O.overlay.classList.add('cap-abierto');
  O.overlay.innerHTML = `
  <div class="cap-modal" data-cap="fondo">
    <div class="cap-card" role="dialog" aria-modal="true" aria-label="Captura rápida">
      <header class="cap-head">
        <h3 class="cap-titulo">Capturá</h3>
        <button class="cap-x" data-cap="cerrar" aria-label="Cerrar">✕</button>
      </header>
      ${O.propuesta ? vistaConfirmacion() : vistaEntrada()}
    </div>
  </div>`;
}

function vistaEntrada() {
  const grabando = O.reconociendo;
  return `
  <div class="cap-entrada">
    ${O.sttDisponible ? `
    <button class="cap-mic-grande${grabando ? ' cap-grabando' : ''}" data-cap="grabar" aria-label="${grabando ? 'Detener' : 'Grabar'}">
      <span class="cap-mic-ic">🎤</span>
      <span class="cap-mic-txt">${grabando ? 'Escuchando… (tocá para parar)' : 'Tocá y hablá'}</span>
    </button>` : `
    <div class="cap-sin-voz">Tu navegador no soporta dictado por voz. Escribí abajo 👇</div>`}

    <textarea id="capTexto" class="cap-textarea" rows="3"
      placeholder="Ej: gasté 5 lucas en el súper · almorcé 250 de carne · tomé la creatina · press banca 4x10 con 80"
      aria-label="Texto a interpretar">${esc(O.texto)}</textarea>

    <button class="cap-btn-primario" data-cap="entender">Entender</button>
    <p class="cap-hint">Siempre vas a poder revisar y editar antes de guardar.</p>
  </div>`;
}

/* ---- Card de confirmación (editable, con selector de módulo) ---- */
function vistaConfirmacion() {
  const p = O.propuesta;
  const modActual = p.modulo || '';
  const bannerBaja = p.modulo && p.confianza === 'baja'
    ? `<div class="cap-banner-baja">Revisá bien lo que entendí ⚠️</div>` : '';

  const opciones = [
    ['plata', '💵 Plata'], ['nutricion', '🥩 Nutrición'],
    ['training', '🏋️ Training'], ['rutina', '☀️ Rutina'],
  ];
  const selector = `
  <label class="cap-field">
    <span class="cap-label">Módulo</span>
    <select class="cap-input" data-cap-field="modulo" aria-label="Módulo destino">
      <option value=""${!modActual ? ' selected' : ''}>— Elegí un módulo —</option>
      ${opciones.map(([id, lbl]) => `<option value="${id}"${modActual === id ? ' selected' : ''}>${lbl}</option>`).join('')}
    </select>
  </label>`;

  let cuerpo;
  if (p.modulo === 'plata') cuerpo = formPlata(p.campos);
  else if (p.modulo === 'nutricion') cuerpo = formNutricion(p.campos);
  else if (p.modulo === 'training') cuerpo = formTraining(p.campos);
  else if (p.modulo === 'rutina') cuerpo = formRutina(p.campos);
  else cuerpo = `<div class="cap-nomatch">No pude decidir a qué módulo va. Elegí el módulo arriba y completá los datos.</div>`;

  return `
  <div class="cap-confirm">
    ${bannerBaja}
    <div class="cap-crudo">"${esc(p.crudo)}"</div>
    ${selector}
    <div class="cap-form">${cuerpo}</div>
    <div class="cap-acciones">
      <button class="cap-btn-ghost" data-cap="volver">Volver</button>
      <button class="cap-btn-primario" data-cap="guardar"${p.modulo ? '' : ' disabled'}>Guardar</button>
    </div>
  </div>`;
}

function formPlata(c) {
  const monedas = cfgMonedas();
  const ambitos = cfgAmbitos();
  const cats = cfgCategorias(c.tipo);
  return `
  <div class="cap-grid2">
    <label class="cap-field">
      <span class="cap-label">Tipo</span>
      <select class="cap-input" data-cap-field="tipo">
        <option value="egreso"${c.tipo === 'egreso' ? ' selected' : ''}>Egreso</option>
        <option value="ingreso"${c.tipo === 'ingreso' ? ' selected' : ''}>Ingreso</option>
      </select>
    </label>
    <label class="cap-field">
      <span class="cap-label">Monto</span>
      <input class="cap-input cap-num" data-cap-field="monto" type="text" inputmode="decimal" value="${esc(c.monto)}" placeholder="0">
    </label>
  </div>
  <div class="cap-grid2">
    <label class="cap-field">
      <span class="cap-label">Moneda</span>
      <select class="cap-input" data-cap-field="moneda">
        ${(monedas.length ? monedas : [c.moneda]).map(m => `<option value="${esc(m)}"${c.moneda === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}
      </select>
    </label>
    <label class="cap-field">
      <span class="cap-label">Ámbito</span>
      <select class="cap-input" data-cap-field="ambito">
        ${(ambitos.length ? ambitos : [{ id: c.ambito, label: c.ambito }]).map(a => `<option value="${esc(a.id)}"${c.ambito === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}
      </select>
    </label>
  </div>
  <label class="cap-field">
    <span class="cap-label">Categoría</span>
    <select class="cap-input" data-cap-field="categoria">
      <option value=""${!c.categoria ? ' selected' : ''}>Sin categoría</option>
      ${cats.map(cat => `<option value="${esc(cat)}"${c.categoria === cat ? ' selected' : ''}>${esc(cat)}</option>`).join('')}
    </select>
  </label>
  <div class="cap-grid2">
    <label class="cap-field">
      <span class="cap-label">Descripción</span>
      <input class="cap-input" data-cap-field="descripcion" type="text" value="${esc(c.descripcion)}" maxlength="160" placeholder="Opcional">
    </label>
    <label class="cap-field">
      <span class="cap-label">Fecha</span>
      <input class="cap-input" data-cap-field="fecha" type="date" value="${esc(c.fecha)}" max="9999-12-31">
    </label>
  </div>`;
}

function formNutricion(c) {
  const slots = cfgSlots();
  const items = Array.isArray(c.items) ? c.items : [];
  return `
  <div class="cap-form-grid">
    <label class="cap-field">
      <span class="cap-label">Slot</span>
      <select class="cap-input" data-cap-field="slot">
        ${(slots.length ? slots : [{ id: c.slot, label: c.slot }]).map(s => `<option value="${esc(s.id)}"${c.slot === s.id ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
    </label>
    <label class="cap-field">
      <span class="cap-label">Fecha</span>
      <input class="cap-input" data-cap-field="fecha" type="date" value="${esc(c.fecha || hoyStr())}" max="9999-12-31">
    </label>
  </div>
  <div class="cap-label">Ítems a anotar</div>
  <div class="cap-items">
    ${items.map((it, i) => `
    <div class="cap-item">
      <input class="cap-input cap-item-nombre" data-cap-item="${i}" data-cap-item-field="nombre" type="text" value="${esc(it.nombre)}" placeholder="Nombre">
      <div class="cap-item-macros">
        <label>P<input class="cap-input cap-num cap-mini" data-cap-item="${i}" data-cap-item-field="prot" type="text" inputmode="decimal" value="${esc(it.prot)}"></label>
        <label>C<input class="cap-input cap-num cap-mini" data-cap-item="${i}" data-cap-item-field="carbo" type="text" inputmode="decimal" value="${esc(it.carbo)}"></label>
        <label>G<input class="cap-input cap-num cap-mini" data-cap-item="${i}" data-cap-item-field="grasa" type="text" inputmode="decimal" value="${esc(it.grasa)}"></label>
        <label>kcal<input class="cap-input cap-num cap-mini" data-cap-item="${i}" data-cap-item-field="kcal" type="text" inputmode="decimal" value="${esc(it.kcal)}"></label>
      </div>
      ${items.length > 1 ? `<button class="cap-item-x" data-cap="quitar-item" data-i="${i}" aria-label="Quitar ítem">✕</button>` : ''}
    </div>`).join('')}
  </div>`;
}

function formTraining(c) {
  const sets = Array.isArray(c.sets) ? c.sets : [];
  return `
  <label class="cap-field">
    <span class="cap-label">Ejercicio</span>
    <input class="cap-input" data-cap-field="ejercicio_nombre" type="text" value="${esc(c.ejercicio_nombre)}" placeholder="Nombre del ejercicio"${c.ejercicio_id ? ' readonly' : ''}>
    ${c.ejercicio_id ? '' : `<span class="cap-nota-mini">No está en tu catálogo: se creará al guardar.</span>`}
  </label>
  <div class="cap-label">Series</div>
  <div class="cap-sets">
    ${sets.length ? sets.map((s, i) => `
    <div class="cap-set">
      <span class="cap-set-n">#${i + 1}</span>
      <label>Peso<input class="cap-input cap-num cap-mini" data-cap-set="${i}" data-cap-set-field="peso" type="text" inputmode="decimal" value="${esc(s.peso)}"></label>
      <label>Reps<input class="cap-input cap-num cap-mini" data-cap-set="${i}" data-cap-set-field="reps" type="text" inputmode="numeric" value="${esc(s.reps)}"></label>
      <button class="cap-item-x" data-cap="quitar-set" data-i="${i}" aria-label="Quitar serie">✕</button>
    </div>`).join('') : `<div class="cap-nota-mini">Sin series. Agregá una.</div>`}
  </div>
  <button class="cap-btn-sec" data-cap="add-set">+ Serie</button>`;
}

function formRutina(c) {
  const checks = Array.isArray(c.checks) ? c.checks : [];
  return `
  <label class="cap-field">
    <span class="cap-label">Fecha</span>
    <input class="cap-input" data-cap-field="fecha" type="date" value="${esc(c.fecha)}" max="9999-12-31">
  </label>
  <div class="cap-label">Hábitos a marcar</div>
  <div class="cap-checks">
    ${checks.length ? checks.map((ch, i) => `
    <label class="cap-check">
      <input type="checkbox" data-cap-check="${i}" checked>
      <span>${esc(ch.label)} <span class="cap-check-rut">· ${esc(ch.rutina_nombre)}</span></span>
    </label>`).join('') : `<div class="cap-nota-mini">Ningún hábito matcheó tus rutinas activas.</div>`}
  </div>`;
}

/* ============================================================
   Lectura de los campos editados desde el DOM → objeto campos
   ============================================================ */
function leerCamposDelDOM() {
  const p = O.propuesta;
  if (!p) return;
  const root = O.overlay;
  const modSel = root.querySelector('[data-cap-field="modulo"]');
  const nuevoModulo = modSel ? modSel.value : p.modulo;

  // Cambió el módulo → regenerar campos con defaults del nuevo módulo.
  if (nuevoModulo !== p.modulo) {
    p.modulo = nuevoModulo || null;
    p.campos = camposDefault(p.modulo, p.crudo);
    return; // el re-render pinta el form nuevo
  }

  if (p.modulo === 'plata') {
    for (const f of ['tipo', 'monto', 'moneda', 'ambito', 'categoria', 'descripcion', 'fecha']) {
      const el = root.querySelector(`[data-cap-field="${f}"]`);
      if (el) p.campos[f] = el.value;
    }
  } else if (p.modulo === 'nutricion') {
    const sl = root.querySelector('[data-cap-field="slot"]');
    if (sl) p.campos.slot = sl.value;
    const fe = root.querySelector('[data-cap-field="fecha"]');
    if (fe) p.campos.fecha = fe.value;
    root.querySelectorAll('[data-cap-item]').forEach(el => {
      const i = Number(el.dataset.capItem);
      const f = el.dataset.capItemField;
      if (p.campos.items[i]) p.campos.items[i][f] = el.value;
    });
  } else if (p.modulo === 'training') {
    const nom = root.querySelector('[data-cap-field="ejercicio_nombre"]');
    if (nom && !nom.readOnly) p.campos.ejercicio_nombre = nom.value;
    root.querySelectorAll('[data-cap-set]').forEach(el => {
      const i = Number(el.dataset.capSet);
      const f = el.dataset.capSetField;
      if (p.campos.sets[i]) p.campos.sets[i][f] = el.value;
    });
  } else if (p.modulo === 'rutina') {
    const fe = root.querySelector('[data-cap-field="fecha"]');
    if (fe) p.campos.fecha = fe.value;
    p.campos.checks.forEach((ch, i) => {
      const cb = root.querySelector(`[data-cap-check="${i}"]`);
      ch._marcar = cb ? cb.checked : true;
    });
  }
}

function camposDefault(modulo, crudo) {
  if (modulo === 'plata') {
    return { tipo: 'egreso', monto: '', moneda: primeraMoneda(), ambito: primerAmbitoId(), categoria: '', descripcion: '', fecha: hoyStr() };
  }
  if (modulo === 'nutricion') {
    const slots = cfgSlots();
    return { slot: slots.length ? slots[0].id : 'almuerzo', fecha: hoyStr(), items: [{ tipo: 'custom', id: null, nombre: crudo || '', cantidad: 1, prot: 0, carbo: 0, grasa: 0, kcal: 0 }] };
  }
  if (modulo === 'training') {
    return { ejercicio_id: null, ejercicio_nombre: '', sets: [{ peso: 0, reps: 0 }] };
  }
  if (modulo === 'rutina') {
    return { fecha: hoyStr(), checks: [] };
  }
  return {};
}

/* ============================================================
   COMMIT — inserts EXACTOS al esquema. Guard anti doble-tap.
   Nunca se llega acá sin confirmación del usuario.
   ============================================================ */
async function commit() {
  if (O.guardando) return;
  leerCamposDelDOM();
  const p = O.propuesta;
  if (!p || !p.modulo) { toast('Elegí un módulo primero', 'warning'); pintarOverlay(); return; }
  if (!supabase) { toast('Supabase no está configurado', 'error'); return; }
  const uid = getUserId();
  if (!uid) { toast('No hay sesión activa', 'error'); return; }

  O.guardando = true;
  try {
    let etiqueta;
    if (p.modulo === 'plata') etiqueta = await commitPlata(uid, p);
    else if (p.modulo === 'nutricion') etiqueta = await commitNutricion(uid, p);
    else if (p.modulo === 'training') etiqueta = await commitTraining(uid, p);
    else if (p.modulo === 'rutina') etiqueta = await commitRutina(uid, p);
    else { toast('Módulo no soportado', 'error'); O.guardando = false; return; }

    if (etiqueta === null) { O.guardando = false; return; } // validación falló (ya avisó)

    toastAnotado(etiqueta.label, etiqueta.modulo);
    cerrar();
  } catch (err) {
    toast('No se pudo guardar: ' + msgErr(err), 'error');
  }
  O.guardando = false;
}

const MOD_LABEL = { plata: 'Plata', nutricion: 'Nutrición', training: 'Training', rutina: 'Rutina' };

// Toast "Anotado en X" con acción "Ver" que navega al módulo.
function toastAnotado(detalle, modulo) {
  toast('Anotado en ' + (MOD_LABEL[modulo] || modulo) + (detalle ? ': ' + detalle : ''), 'success');
  // Acción "Ver": toast() del core no soporta botón de acción, así que
  // exponemos la navegación por un toast clickeable adicional.
  const wrap = document.getElementById('vidaToasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'vida-toast vida-toast-info cap-toast-ver';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="vida-toast-ic">→</span><span class="vida-toast-msg">Ver ${esc(MOD_LABEL[modulo] || modulo)}</span>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const quitar = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); };
  el.addEventListener('click', () => { navigate(modulo); quitar(); });
  setTimeout(quitar, 5000);
}

async function commitPlata(uid, p) {
  const c = p.campos;
  const monto = montoEditado(c.monto);
  if (!(monto > 0)) { toast('Poné un monto mayor a 0', 'warning'); return null; }
  if (!c.moneda) { toast('Elegí una moneda', 'warning'); return null; }
  if (!c.ambito) { toast('Elegí un ámbito', 'warning'); return null; }
  const fila = {
    user_id: uid,
    fecha: String(c.fecha || hoyStr()).slice(0, 10) || hoyStr(),
    tipo: c.tipo === 'ingreso' ? 'ingreso' : 'egreso',
    monto,
    moneda: c.moneda,
    ambito: c.ambito,
    categoria: c.categoria || null,
    descripcion: c.descripcion ? String(c.descripcion).trim() : null,
    origen: origenActual(),
    crudo: p.crudo,
  };
  const { error } = await supabase.from('plata_movimientos').insert(fila);
  if (error) throw error;
  return { modulo: 'plata', label: (fila.tipo === 'ingreso' ? '+' : '−') + ' ' + monto + ' ' + fila.moneda };
}

async function commitNutricion(uid, p) {
  const c = p.campos;
  const items = (Array.isArray(c.items) ? c.items : []).filter(it => String(it.nombre || '').trim());
  if (!items.length) { toast('Poné al menos un ítem', 'warning'); return null; }
  if (!c.slot) { toast('Elegí un slot', 'warning'); return null; }
  const fecha = String(c.fecha || hoyStr()).slice(0, 10) || hoyStr();
  const filas = items.map(it => ({
    user_id: uid,
    fecha,
    slot: c.slot,
    item_tipo: it.tipo === 'combo' ? 'combo' : (it.tipo === 'alimento' ? 'alimento' : 'custom'),
    item_id: it.id || null,
    item_nombre: String(it.nombre).trim(),
    prot: num(it.prot),
    carbo: num(it.carbo),
    grasa: num(it.grasa),
    kcal: num(it.kcal),
  }));
  const { error } = await supabase.from('nutricion_log').insert(filas);
  if (error) throw error;
  const totalProt = filas.reduce((s, f) => s + f.prot, 0);
  return { modulo: 'nutricion', label: filas.length + ' ítem' + (filas.length > 1 ? 's' : '') + ' · ' + Math.round(totalProt) + ' g prot' };
}

async function commitTraining(uid, p) {
  const c = p.campos;
  const nombre = String(c.ejercicio_nombre || '').trim();
  const sets = (Array.isArray(c.sets) ? c.sets : []).filter(s => Number(s.reps) > 0 || Number(s.peso) > 0);
  if (!nombre) { toast('Poné el nombre del ejercicio', 'warning'); return null; }
  if (!sets.length) { toast('Agregá al menos una serie', 'warning'); return null; }

  // 1) Ejercicio: reusar del catálogo o crear.
  let ejId = c.ejercicio_id;
  if (!ejId) {
    const { data: ej, error: e0 } = await supabase.from('training_ejercicios')
      .insert({ user_id: uid, nombre, unidad: 'kg' }).select().single();
    if (e0) throw e0;
    ejId = ej.id;
    CAT.ejercicios.push(ej); // refrescar cache para próximas capturas
  }

  // 2) Sesión del día: reusar la última no borrada o crear una nueva.
  const fecha = hoyStr();
  let sesionId;
  const { data: ses, error: e1 } = await supabase.from('training_sesiones').select('id')
    .eq('user_id', uid).eq('fecha', fecha).eq('_deleted', false)
    .order('created_at', { ascending: false }).limit(1);
  if (e1) throw e1;
  if (ses && ses.length) {
    sesionId = ses[0].id;
  } else {
    const { data: nueva, error: e2 } = await supabase.from('training_sesiones')
      .insert({ user_id: uid, fecha }).select().single();
    if (e2) throw e2;
    sesionId = nueva.id;
  }

  // orden del ejercicio dentro de la sesión = max(orden)+1 de sets existentes.
  let orden = 0;
  const { data: existentes } = await supabase.from('training_sets').select('orden')
    .eq('user_id', uid).eq('sesion_id', sesionId);
  if (existentes && existentes.length) orden = Math.max(...existentes.map(x => Number(x.orden) || 0)) + 1;

  // 3) Sets.
  const filas = sets.map((s, i) => ({
    user_id: uid,
    sesion_id: sesionId,
    ejercicio_id: ejId,
    orden,
    set_num: i + 1,
    peso: Number(String(s.peso).replace(',', '.')) || 0,
    reps: Math.round(Number(s.reps) || 0),
    completado: true,
  }));
  const { error: e3 } = await supabase.from('training_sets').insert(filas);
  if (e3) throw e3;
  return { modulo: 'training', label: nombre + ' · ' + filas.length + ' serie' + (filas.length > 1 ? 's' : '') };
}

async function commitRutina(uid, p) {
  const c = p.campos;
  const checks = (Array.isArray(c.checks) ? c.checks : []).filter(ch => ch._marcar !== false);
  if (!checks.length) { toast('No hay hábitos marcados', 'warning'); return null; }
  const fecha = String(c.fecha || hoyStr()).slice(0, 10) || hoyStr();
  let ok = 0, yaHechos = 0;
  for (const ch of checks) {
    const { error } = await supabase.from('rutina_checks').insert({
      user_id: uid, fecha, rutina_id: ch.rutina_id, item_id: String(ch.item_id),
    });
    if (error) {
      // 23505 = violación de unique → ya estaba hecho ese día. No es error.
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) { yaHechos++; continue; }
      throw error;
    }
    ok++;
  }
  const partes = [];
  if (ok) partes.push(ok + ' marcado' + (ok > 1 ? 's' : ''));
  if (yaHechos) partes.push(yaHechos + ' ya estaba' + (yaHechos > 1 ? 'n' : ''));
  return { modulo: 'rutina', label: partes.join(' · ') || 'sin cambios' };
}

// origen: 'voz' si la última captura vino del dictado, 'texto' si se tipeó.
// Aproximación v0: si STT está disponible y se usó grabación en esta apertura.
let origenUltimo = 'texto';
function origenActual() { return origenUltimo; }

/* ============================================================
   Delegación de eventos del overlay
   ============================================================ */
function onOverlayClick(e) {
  const el = e.target.closest('[data-cap]');
  if (!el) {
    // click en el fondo del modal cierra
    if (e.target.closest('[data-cap="fondo"]') === e.target) cerrar();
    return;
  }
  const a = el.dataset.cap;
  if (a === 'fondo') { if (e.target === el) cerrar(); return; }
  if (a === 'cerrar') { cerrar(); return; }
  if (a === 'grabar') { origenUltimo = 'voz'; toggleGrabar(); return; }
  if (a === 'entender') { entender(); return; }
  if (a === 'volver') { O.propuesta = null; pintarOverlay(); return; }
  if (a === 'guardar') { commit(); return; }
  if (a === 'quitar-item') { quitarItem(Number(el.dataset.i)); return; }
  if (a === 'quitar-set') { quitarSet(Number(el.dataset.i)); return; }
  if (a === 'add-set') { agregarSetForm(); return; }
}

function onOverlayChange(e) {
  const p = O.propuesta;
  if (!p) return;
  const sel = e.target.closest('[data-cap-field="modulo"]');
  if (sel) {
    leerCamposDelDOM(); // detecta el cambio de módulo y regenera campos
    pintarOverlay();
    return;
  }
  // Plata: cambiar Tipo (egreso↔ingreso) cambia la lista de categorías.
  const tipoSel = e.target.closest('[data-cap-field="tipo"]');
  if (tipoSel && p.modulo === 'plata') {
    leerCamposDelDOM();
    // Si la categoría elegida ya no existe para el nuevo tipo, limpiarla.
    const cats = cfgCategorias(p.campos.tipo);
    if (p.campos.categoria && !cats.includes(p.campos.categoria)) p.campos.categoria = '';
    pintarOverlay();
  }
}

// Persistir lo tipeado en el textarea de entrada aunque no se toque "Entender".
function onOverlayInput(e) {
  const ta = e.target.closest('#capTexto');
  if (ta) { O.texto = ta.value; return; }
}

function quitarItem(i) {
  leerCamposDelDOM();
  const p = O.propuesta;
  if (p && p.modulo === 'nutricion' && p.campos.items.length > 1) {
    p.campos.items.splice(i, 1);
    pintarOverlay();
  }
}
function quitarSet(i) {
  leerCamposDelDOM();
  const p = O.propuesta;
  if (p && p.modulo === 'training') { p.campos.sets.splice(i, 1); pintarOverlay(); }
}
function agregarSetForm() {
  leerCamposDelDOM();
  const p = O.propuesta;
  if (p && p.modulo === 'training') {
    const ult = p.campos.sets[p.campos.sets.length - 1];
    p.campos.sets.push({ peso: ult ? ult.peso : 0, reps: ult ? ult.reps : 0 });
    pintarOverlay();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && O.abierto) { cerrar(); }
}

/* ============================================================
   Estilos — inyectados 1 vez, prefijo cap-, SOLO var(--token) del §6.
   El FAB no tapa la bottom-nav en mobile (safe-area).
   ============================================================ */
const CSS = `
.cap-fab {
  position: fixed; z-index: 45;
  right: calc(var(--space-4) + env(safe-area-inset-right, 0px));
  bottom: calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
  width: 60px; height: 60px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: var(--bg); border: none;
  font-size: 26px; line-height: 1; cursor: pointer;
  box-shadow: var(--shadow-2);
  transition: transform .12s, filter .15s;
}
.cap-fab:hover { filter: brightness(1.08); }
.cap-fab:active { transform: scale(.94); }
.cap-fab:focus-visible { outline: 3px solid var(--accent-2); outline-offset: 3px; }

/* Mobile: la bottom-nav ocupa ~88px abajo → subir el FAB por encima. */
@media (max-width: 767px) {
  .cap-fab {
    width: 56px; height: 56px; font-size: 24px;
    bottom: calc(88px + var(--space-3) + env(safe-area-inset-bottom, 0px));
  }
}

.cap-overlay { position: fixed; inset: 0; z-index: 70; display: none; }
.cap-overlay.cap-abierto { display: block; }
.cap-modal {
  position: fixed; inset: 0; display: flex;
  align-items: flex-end; justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
}
.cap-card {
  width: 100%; max-width: 520px; max-height: 90vh;
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: var(--space-4);
  padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  box-shadow: var(--shadow-2);
  font-family: var(--font-ui); color: var(--text);
}
.cap-card * { box-sizing: border-box; }
.cap-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); }
.cap-titulo { margin: 0; font-family: var(--font-display); font-size: 1.15rem; }
.cap-x { width: 38px; height: 38px; flex: none; background: transparent; border: none; color: var(--text-faint); font-size: 1rem; cursor: pointer; border-radius: var(--radius); }
.cap-x:hover { color: var(--text); background: var(--surface-2); }

.cap-entrada { display: flex; flex-direction: column; gap: var(--space-3); overflow-y: auto; }
.cap-mic-grande {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  min-height: 96px; padding: var(--space-4);
  background: var(--surface-2); border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg); color: var(--text-dim); cursor: pointer;
  font: inherit; transition: border-color .15s, background .15s;
}
.cap-mic-grande:hover { border-color: var(--accent); }
.cap-mic-ic { font-size: 2rem; line-height: 1; }
.cap-mic-txt { font-size: .85rem; font-weight: 600; }
.cap-grabando { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.cap-grabando .cap-mic-ic { animation: cap-pulso 1s ease-in-out infinite; }
@keyframes cap-pulso { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: .6; } }
.cap-sin-voz { padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius); color: var(--text-dim); font-size: .85rem; text-align: center; }

.cap-textarea {
  width: 100%; min-height: 84px; padding: var(--space-3);
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius);
  color: var(--text); font: inherit; resize: vertical;
}
.cap-textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.cap-hint { margin: 0; font-size: .74rem; color: var(--text-faint); text-align: center; }

.cap-btn-primario { min-height: 50px; padding: var(--space-2) var(--space-4); background: var(--accent); border: none; border-radius: var(--radius); color: var(--bg); font-weight: 700; font: inherit; font-weight: 700; cursor: pointer; transition: filter .15s; }
.cap-btn-primario:hover { filter: brightness(1.1); }
.cap-btn-primario:active { transform: translateY(1px); }
.cap-btn-primario:disabled { opacity: .45; cursor: default; }
.cap-btn-sec { min-height: 42px; padding: var(--space-1) var(--space-4); background: transparent; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font: inherit; font-weight: 600; cursor: pointer; }
.cap-btn-sec:hover { background: var(--surface-2); color: var(--text); }
.cap-btn-ghost { min-height: 44px; padding: var(--space-1) var(--space-4); background: transparent; border: none; color: var(--text-faint); font: inherit; font-weight: 600; cursor: pointer; border-radius: var(--radius); }
.cap-btn-ghost:hover { color: var(--text); background: var(--surface-2); }

.cap-confirm { display: flex; flex-direction: column; gap: var(--space-3); overflow-y: auto; }
.cap-banner-baja { padding: var(--space-2) var(--space-3); background: color-mix(in srgb, var(--warn) 15%, transparent); border: 1px solid var(--warn); border-radius: var(--radius); color: var(--warn); font-size: .82rem; font-weight: 600; }
.cap-crudo { padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); color: var(--text-dim); font-size: .85rem; font-style: italic; overflow-wrap: anywhere; }
.cap-nomatch { padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius); color: var(--text-dim); font-size: .85rem; }

.cap-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.cap-label { font-size: .72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; }
.cap-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.cap-input { width: 100%; min-height: 46px; padding: var(--space-2) var(--space-3); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font: inherit; }
.cap-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
select.cap-input { appearance: none; -webkit-appearance: none; }
.cap-num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }

.cap-items, .cap-sets, .cap-checks { display: flex; flex-direction: column; gap: var(--space-2); }
.cap-item { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); position: relative; }
.cap-item-nombre { min-height: 40px; }
.cap-item-macros { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.cap-item-macros label, .cap-set label { display: flex; align-items: center; gap: 4px; font-size: .72rem; color: var(--text-dim); }
.cap-mini { min-height: 36px; width: 62px; padding: var(--space-1) var(--space-2); text-align: right; }
.cap-item-x { position: absolute; top: var(--space-1); right: var(--space-1); width: 30px; height: 30px; background: transparent; border: none; color: var(--text-faint); cursor: pointer; border-radius: var(--radius-sm); }
.cap-item-x:hover { color: var(--danger); background: var(--bg); }
.cap-set { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); position: relative; }
.cap-set-n { font-family: var(--font-num); font-size: .78rem; color: var(--text-faint); flex: none; }
.cap-set .cap-item-x { position: static; margin-left: auto; }
.cap-check { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); font-size: .88rem; cursor: pointer; }
.cap-check input { width: 20px; height: 20px; margin-top: 2px; flex: none; accent-color: var(--accent); }
.cap-check-rut { color: var(--text-faint); font-size: .76rem; }
.cap-nota-mini { font-size: .74rem; color: var(--text-faint); }

.cap-acciones { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.cap-acciones .cap-btn-primario { flex: 1; }

.cap-toast-ver { cursor: pointer; border-color: var(--accent) !important; }

@media (min-width: 768px) {
  .cap-modal { align-items: center; }
  .cap-card { border-radius: var(--radius-lg); }
}
`;

function inyectarEstilos() {
  if (document.getElementById('cap-styles')) return;
  const st = document.createElement('style');
  st.id = 'cap-styles';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ============================================================
   Entry point — lo llama app.js tras startRouter (usuario logueado).
   Re-inyecta sin duplicar el FAB (logout→login).
   ============================================================ */
export function initCaptura() {
  inyectarEstilos();

  // FAB (guard anti-duplicado: si ya existe, no re-crear).
  if (!document.getElementById('capFab')) {
    const fab = document.createElement('button');
    fab.id = 'capFab';
    fab.className = 'cap-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Captura rápida por voz o texto');
    fab.title = 'Capturá (voz o texto)';
    fab.textContent = '🎤';
    fab.addEventListener('click', abrir);
    document.body.appendChild(fab);
    O.fab = fab;
  }

  // Overlay (guard anti-duplicado).
  if (!document.getElementById('capOverlay')) {
    const ov = document.createElement('div');
    ov.id = 'capOverlay';
    ov.className = 'cap-overlay';
    ov.addEventListener('click', onOverlayClick);
    ov.addEventListener('change', onOverlayChange);
    ov.addEventListener('input', onOverlayInput);
    document.body.appendChild(ov);
    O.overlay = ov;
  } else {
    O.overlay = document.getElementById('capOverlay');
  }

  // STT: init una vez (no rompe si el browser no lo soporta).
  if (!O.recognition) iniciarSTT();

  // Escape global (bindeado 1 vez).
  if (!O.inyectado) {
    document.addEventListener('keydown', onKeydown);
    O.inyectado = true;
  }
}
