// VIDA — Captura universal (voz + texto) v0 · SIN API key
// El diferencial de VIDA (CLAUDE.md §0): una línea hablada/escrita → la app
// la entiende, muestra qué entendió para confirmar/editar, y la inserta en el
// módulo correcto. Contrato VINCULANTE: docs/CONTRATOS.md §15.
//
// SEAM DE IA (Fase 5b · ACTIVO): `interpretar(texto)` intenta primero el
// cerebro serverless (`/api/parse` → Claude Sonnet 4.6); si no está la
// ANTHROPIC_API_KEY o falla, cae al parser determinístico es-AR. Los dos
// caminos devuelven la MISMA forma de propuesta, y el GROUNDING (IDs + macros
// reales) lo hace el cliente contra el catálogo (nada inventado, BACKLOG §7).
// La UI (overlay, card de confirmación) y los inserts (commit) NO se tocan.
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

// Respeto por prefers-reduced-motion — se lee en vivo (no cachea) para
// reaccionar si el usuario cambia la preferencia del SO en caliente.
// Espeja el criterio de core/anim.js pero sin importarlo (mandato: 1 archivo).
function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

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
   Fase 5b ACTIVA. Orden: (1) intenta el cerebro serverless /api/parse
   (Claude Sonnet 4.6) que ENTIENDE/segmenta la frase; el cliente hace el
   GROUNDING (resuelve IDs + macros reales contra el catálogo del usuario,
   nada inventado). (2) Si el endpoint no está (sin API key → 501, o error /
   timeout) cae al parser determinístico es-AR. Ambos caminos devuelven el
   MISMO contrato:
     { modulo, confianza:'alta'|'media'|'baja', campos, resumen, crudo }
   o { modulo: null, crudo } si no se pudo determinar intención.
   `campos` es específico por módulo (ver commit()).
   ============================================================ */
async function interpretar(texto) {
  const crudo = String(texto || '').trim();
  if (!crudo) return { modulo: null, crudo };
  await cargarCatalogos();
  try {
    const ia = await interpretarIA(crudo);
    if (ia && ia.modulo) return ia;          // la IA entendió y quedó grounded
  } catch (_) { /* endpoint ausente/erróneo/timeout → parser determinístico */ }
  return interpretarDet(crudo);
}

/* ---- IA: llama al cerebro (Claude vía serverless) y hace grounding ----
   Devuelve una propuesta ya grounded o null (→ el caller cae al determinístico).
   NO inserta nada (eso lo hace commit() tras la confirmación del usuario). */
async function interpretarIA(crudo) {
  const payload = {
    texto: crudo,
    config: {
      slots: cfgSlots(),
      monedas: cfgMonedas(),
      ambitos: cfgAmbitos(),
      categorias: { egreso: cfgCategorias('egreso'), ingreso: cfgCategorias('ingreso') },
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000); // fallback si el endpoint cuelga
  let res;
  try {
    res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error('parse ' + res.status); // 501 sin key / 5xx → fallback
  const data = await res.json();                        // HTML (preview sin /api) → throw → fallback
  if (!data || !data.modulo || data.modulo === 'ninguno') return null;
  return groundPropuesta(data, crudo);
}

// Convierte el "entendimiento" de la IA en una propuesta con IDs/macros reales.
function groundPropuesta(data, crudo) {
  const n = norm(crudo);
  if (data.modulo === 'plata')     return groundPlata(data, n, crudo);
  if (data.modulo === 'nutricion') return groundNutricion(data, n, crudo);
  if (data.modulo === 'training')  return groundTraining(data, n, crudo);
  if (data.modulo === 'rutina')    return groundRutina(data, n, crudo);
  return null;
}

/* ---- Grounding: Plata ---- */
function groundPlata(data, n, crudo) {
  const p = data.plata || {};
  const tipo = (p.tipo === 'ingreso' || p.tipo === 'egreso') ? p.tipo : 'egreso';
  const montoNum = Number(p.monto);
  const monto = (Number.isFinite(montoNum) && montoNum > 0) ? montoNum : null;
  const moneda = mapMoneda(p.moneda);
  const ambito = mapAmbito(p.ambito, n);
  const categoria = mapCategoria(p.categoria, n, tipo);
  const fecha = resolverFechaIA(p.fecha, n);
  const descripcion = (typeof p.descripcion === 'string') ? p.descripcion.trim() : '';
  let confianza;
  if (monto && categoria) confianza = 'alta';
  else if (monto) confianza = 'media';
  else confianza = 'baja';
  return {
    modulo: 'plata', confianza,
    campos: {
      tipo,
      monto: monto != null ? monto : '',
      moneda, ambito,
      categoria: categoria || '',
      descripcion,
      fecha,
    },
    resumen: (tipo === 'ingreso' ? 'Ingreso' : 'Egreso')
      + (monto != null ? ' de ' + monto + ' ' + moneda : '')
      + (categoria ? ' · ' + categoria : '')
      + ' · ' + labelAmbito(ambito),
    crudo,
  };
}
function mapMoneda(m) {
  const monedas = cfgMonedas();
  if (typeof m === 'string' && m.trim() && monedas.length) {
    const mn = norm(m);
    const hit = monedas.find(x => norm(x) === mn)
             || monedas.find(x => norm(x).includes(mn) || mn.includes(norm(x)));
    if (hit) return hit;
  }
  return primeraMoneda();
}
function mapAmbito(a, n) {
  const ambitos = cfgAmbitos();
  if (typeof a === 'string' && a.trim() && ambitos.length) {
    const an = norm(a);
    const hit = ambitos.find(x => norm(x.id) === an || norm(x.label) === an)
             || ambitos.find(x => norm(x.label).includes(an) || an.includes(norm(x.id)));
    if (hit) return hit.id;
  }
  return matchAmbito(n); // fallback determinístico sobre el crudo
}
function mapCategoria(c, n, tipo) {
  const validas = cfgCategorias(tipo);
  if (typeof c === 'string' && c.trim() && validas.length) {
    const cn = norm(c);
    const hit = validas.find(v => norm(v) === cn)
             || validas.find(v => norm(v).includes(cn) || cn.includes(norm(v)));
    if (hit) return hit;
  }
  return matchCategoria(n, tipo) || '';
}
function resolverFechaIA(f, n) {
  if (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.trim())) return f.trim();
  return resolverFecha(n); // 'hoy'/'ayer'/relativas → resolver sobre el crudo
}

/* ---- Grounding: Nutrición ---- */
function groundNutricion(data, n, crudo) {
  const nut = data.nutricion || {};
  const slots = cfgSlots();
  let slot = null;
  if (typeof nut.slot === 'string' && nut.slot.trim()) {
    const sn = norm(nut.slot);
    slot = slots.find(s => norm(s.id) === sn || norm(s.label) === sn)
        || slots.find(s => norm(s.label).includes(sn) || sn.includes(norm(s.id)));
  }
  if (!slot) { const sv = slotPorVerbo(n); slot = slots.find(s => s.id === sv) || null; }
  if (!slot) slot = slots[0] || null;
  const slotId = slot ? slot.id : 'almuerzo';
  const fecha = resolverFecha(n);

  const items = [];
  const itemsIn = Array.isArray(nut.items) ? nut.items : [];
  for (const it of itemsIn) {
    const nombre = (it && typeof it.nombre === 'string') ? it.nombre.trim() : '';
    if (!nombre) continue;
    const g = Number(it.gramos), c = Number(it.cantidad);
    items.push(resolverItemNutricion(nombre,
      (Number.isFinite(g) && g > 0) ? g : null,
      (Number.isFinite(c) && c > 0) ? c : null));
  }
  if (!items.length) {
    // La IA dijo nutrición pero no listó items → entrada manual con el crudo.
    items.push({ tipo: 'custom', id: null, nombre: crudo, cantidad: 1, prot: 0, carbo: 0, grasa: 0, kcal: 0 });
  }
  const hayReal = items.some(i => i.tipo !== 'custom');
  const totalProt = items.reduce((s, it) => s + it.prot, 0);
  return {
    modulo: 'nutricion',
    confianza: hayReal ? 'alta' : 'baja',
    campos: { slot: slotId, fecha, items },
    resumen: (slot ? slot.label : slotId) + ': '
      + items.map(it => (it.cantLabel && it.cantLabel !== 1 ? it.cantLabel + (typeof it.cantLabel === 'number' ? '× ' : ' ') : '') + it.nombre).join(', ')
      + ' · ' + Math.round(totalProt) + ' g prot',
    crudo,
  };
}
// Resuelve un nombre libre contra el catálogo (combos → alimentos) y escala
// macros por gramos/cantidad. Sin match → item custom (macros 0). Espeja matchComida.
function resolverItemNutricion(nombre, gramos, cantidad) {
  const nn = norm(nombre);
  for (const c of CAT.combos) {
    const nom = norm(c.nombre);
    if (nom && nom.length >= 3 && (nn.includes(nom) || nom.includes(nn))) {
      const f = (cantidad && cantidad > 0) ? cantidad : 1;
      return { tipo: 'combo', id: c.id, nombre: c.nombre, cantidad: f,
        prot: num(c.prot) * f, carbo: num(c.carbo) * f, grasa: num(c.grasa) * f, kcal: num(c.kcal) * f };
    }
  }
  for (const a of CAT.alimentos) {
    const nom = norm(a.nombre);
    if (!nom || nom.length < 3) continue;
    const primera = nom.split(' ')[0];
    if (!(nn.includes(nom) || nom.includes(nn) || (primera.length >= 3 && nn.includes(primera)))) continue;
    const pg = gramosDePorcion(a.porcion);
    let factor;
    if (pg > 0 && gramos != null) factor = gramos / pg;
    else if (cantidad != null) factor = cantidad;
    else factor = 1;
    if (!(factor > 0)) factor = 1;
    const cantLabel = (pg > 0 && factor !== 1) ? Math.round(pg * factor) + ' g' : factor;
    return { tipo: 'alimento', id: a.id,
      nombre: a.porcion ? a.nombre + ' (' + a.porcion + ')' : a.nombre,
      cantidad: typeof cantLabel === 'number' ? cantLabel : 1, cantLabel,
      prot: num(a.prot) * factor, carbo: num(a.carbo) * factor, grasa: num(a.grasa) * factor, kcal: num(a.kcal) * factor };
  }
  return { tipo: 'custom', id: null, nombre, cantidad: cantidad || 1, prot: 0, carbo: 0, grasa: 0, kcal: 0 };
}

/* ---- Grounding: Training ---- */
function groundTraining(data, n, crudo) {
  const tr = data.training || {};
  const nombreIA = (typeof tr.ejercicio === 'string') ? tr.ejercicio.trim() : '';
  const ej = resolverEjercicio(nombreIA);
  const nombre = ej ? ej.nombre : nombreIA;
  const tablaAusente = CAT.errores.training;
  const sets = (Array.isArray(tr.sets) ? tr.sets : [])
    .map(s => ({ peso: num(s && s.peso), reps: Math.max(0, Math.round(Number(s && s.reps) || 0)) }))
    .filter(s => s.reps > 0 || s.peso > 0);
  if (!sets.length) {
    return {
      modulo: 'training', confianza: 'baja',
      campos: { ejercicio_id: ej ? ej.id : null, ejercicio_nombre: nombre, sets: [] },
      resumen: (nombre || 'Ejercicio') + ': completá las series'
        + (tablaAusente ? ' (¿corriste sql/06?)' : ''),
      crudo,
    };
  }
  let confianza;
  if (tablaAusente) confianza = 'baja';
  else if (ej && sets.length) confianza = 'alta';
  else confianza = 'media';
  return {
    modulo: 'training', confianza,
    campos: { ejercicio_id: ej ? ej.id : null, ejercicio_nombre: nombre, sets },
    resumen: (nombre || 'Ejercicio') + ': ' + sets.length + '×' + (sets[0] ? sets[0].reps : 0)
      + (sets[0] && sets[0].peso ? ' con ' + sets[0].peso + ' kg' : ''),
    crudo,
  };
}
function resolverEjercicio(nombre) {
  const nn = norm(nombre);
  if (!nn) return null;
  for (const e of CAT.ejercicios) {
    const nom = norm(e.nombre);
    if (!nom) continue;
    const primera = nom.split(' ')[0];
    if (nn.includes(nom) || nom.includes(nn) || (primera.length >= 4 && nn.includes(primera))) return e;
  }
  return null;
}

/* ---- Grounding: Rutina ---- */
function groundRutina(data, n, crudo) {
  // Los IDs de hábito viven en el catálogo → resolvemos contra las rutinas
  // activas por el crudo (y por las frases que aportó la IA, si hiciera falta).
  let checks = matchHabito(n);
  if (!checks.length) {
    const frases = (data.rutina && Array.isArray(data.rutina.items)) ? data.rutina.items : [];
    const vistos = new Set();
    for (const f of frases) {
      for (const c of matchHabito(norm(String(f || '')))) {
        const k = c.rutina_id + '|' + c.item_id;
        if (!vistos.has(k)) { vistos.add(k); checks.push(c); }
      }
    }
  }
  if (!checks.length) return null; // nada matcheó → que caiga al determinístico
  return {
    modulo: 'rutina', confianza: 'alta',
    campos: { fecha: resolverFecha(n), checks },
    resumen: 'Marcar: ' + checks.map(c => c.label).join(', '),
    crudo,
  };
}

/* ============================================================
   PARSER DETERMINÍSTICO · interpretarDet(texto) → propuesta
   ------------------------------------------------------------
   Fallback sin API key (idéntico al motor v0). Mismo contrato de retorno
   que interpretar(). es-AR, normaliza sin acentos.
   ============================================================ */
async function interpretarDet(texto) {
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
  interpretando: false,// true mientras corre interpretar() (FAB "pensando")
  ultimoInsert: null,  // { tabla, ids:[], soft, label, modulo } para deshacer
};

/* ---- Estado vivo del FAB: 'idle' | 'grabando' | 'pensando' -------------- */
// El FAB es el latido de la captura (CLAUDE.md §0). Un solo data-attr manda
// la animación (CSS puro); el nivel del micro (opcional) modula --cap-level.
function setFabEstado(estado) {
  if (!O.fab) return;
  O.fab.dataset.capEstado = estado;
}

/* ---- Medidor de nivel de micrófono (Web Audio, opcional y degradable) ---
   Alimenta la variable CSS --cap-level (0..1) para que el anillo de "grabando"
   reaccione a la voz. Si el navegador no da getUserMedia/AudioContext, no pasa
   nada: la animación de pulso por CSS ya cubre el caso sin medidor. */
const MIC = { ctx: null, stream: null, analyser: null, raf: 0, data: null };

async function iniciarMedidorMic() {
  if (reducedMotion()) return;               // sin animaciones → sin medición
  if (MIC.ctx) return;                       // ya activo
  try {
    const nav = window.navigator;
    if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const stream = await nav.mediaDevices.getUserMedia({ audio: true });
    // Si el usuario ya cerró/paró mientras pedíamos permiso, soltar y salir.
    if (!O.reconociendo) { stream.getTracks().forEach(t => t.stop()); return; }
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    MIC.ctx = ctx; MIC.stream = stream; MIC.analyser = analyser;
    MIC.data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!MIC.analyser) return;
      MIC.analyser.getByteFrequencyData(MIC.data);
      let suma = 0;
      for (let i = 0; i < MIC.data.length; i++) suma += MIC.data[i];
      const prom = suma / MIC.data.length / 255;             // 0..1 crudo
      const nivel = Math.min(1, Math.max(0, prom * 2.2));     // realza voz baja
      if (O.fab) O.fab.style.setProperty('--cap-level', nivel.toFixed(3));
      MIC.raf = requestAnimationFrame(tick);
    };
    MIC.raf = requestAnimationFrame(tick);
  } catch (_) {
    // Permiso denegado o API ausente: el pulso CSS alcanza. No romper.
    detenerMedidorMic();
  }
}

function detenerMedidorMic() {
  if (MIC.raf) cancelAnimationFrame(MIC.raf);
  MIC.raf = 0;
  if (MIC.stream) { try { MIC.stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
  if (MIC.ctx) { try { MIC.ctx.close(); } catch (_) {} }
  MIC.ctx = null; MIC.stream = null; MIC.analyser = null; MIC.data = null;
  if (O.fab) O.fab.style.setProperty('--cap-level', '0');
}

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
      detenerMedidorMic();
      setFabEstado('idle');
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
    rec.onend = () => {
      O.reconociendo = false;
      detenerMedidorMic();
      // Si el overlay sigue abierto, el FAB vuelve a respirar (idle).
      if (O.abierto) setFabEstado('idle');
      pintarOverlay();
    };
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
    detenerMedidorMic();
    setFabEstado('idle');
    pintarOverlay();
    return;
  }
  try {
    O.recognition.start();
    O.reconociendo = true;
    setFabEstado('grabando');
    iniciarMedidorMic();   // async; degrada solo si no hay permiso/API
    pintarOverlay();
  } catch (err) {
    // start() tira si ya está corriendo; lo dejamos consistente.
    O.reconociendo = false;
    detenerMedidorMic();
    setFabEstado('idle');
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
  O.interpretando = false;
  origenUltimo = 'texto'; // por defecto; pasa a 'voz' si se usa el micrófono
  setFabEstado('idle');
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
  O.interpretando = false;
  detenerMedidorMic();
  setFabEstado('idle');
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
  // Detener dictado si seguía activo y pasar el FAB a "pensando" (shimmer).
  if (O.reconociendo && O.recognition) { try { O.recognition.stop(); } catch (_) {} }
  O.reconociendo = false;
  detenerMedidorMic();
  O.interpretando = true;
  setFabEstado('pensando');
  pintarOverlay(); // muestra el botón "Entender" en estado ocupado
  try {
    O.propuesta = await interpretar(txt);
  } catch (err) {
    O.propuesta = { modulo: null, crudo: String(txt).trim() };
    toast('No se pudo interpretar: ' + msgErr(err), 'error');
  }
  O.interpretando = false;
  setFabEstado('idle');
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
      aria-label="Texto a interpretar"${O.interpretando ? ' disabled' : ''}>${esc(O.texto)}</textarea>

    <button class="cap-btn-primario${O.interpretando ? ' cap-pensando' : ''}" data-cap="entender"${O.interpretando ? ' disabled' : ''}>
      <span class="cap-btn-lbl">${O.interpretando ? 'Interpretando…' : 'Entender'}</span>
    </button>
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

    // Guardar referencia para "Deshacer" solo si hay ids reales que revertir.
    O.ultimoInsert = (etiqueta.undo && etiqueta.undo.ids && etiqueta.undo.ids.length)
      ? { ...etiqueta.undo, label: etiqueta.label, modulo: etiqueta.modulo, sello: Date.now() }
      : null;

    // La card "vuela" al ícono del módulo destino y ese ícono pega un pulso.
    // volarCardAlModulo cierra el overlay (con o sin animación) al terminar.
    volarCardAlModulo(etiqueta.modulo, () => {
      toastAnotado(etiqueta.label, etiqueta.modulo);
    });
  } catch (err) {
    toast('No se pudo guardar: ' + msgErr(err), 'error');
  }
  O.guardando = false;
}

const MOD_LABEL = { plata: 'Plata', nutricion: 'Nutrición', training: 'Training', rutina: 'Rutina' };

// Toast "Anotado en X" con acciones "Deshacer" (revierte el insert) y "Ver"
// (navega al módulo). Ventana de deshacer ~6s. El core toast() no soporta
// botones de acción → montamos un toast propio con las dos acciones.
function toastAnotado(detalle, modulo) {
  toast('Anotado en ' + (MOD_LABEL[modulo] || modulo) + (detalle ? ': ' + detalle : ''), 'success');

  const wrap = document.getElementById('vidaToasts');
  if (!wrap) return;

  const puedeDeshacer = !!(O.ultimoInsert && O.ultimoInsert.ids && O.ultimoInsert.ids.length);
  const selloEsperado = puedeDeshacer ? O.ultimoInsert.sello : null;

  const el = document.createElement('div');
  el.className = 'vida-toast vida-toast-info cap-toast-acc';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    ${puedeDeshacer ? `<button type="button" class="cap-toast-btn cap-toast-undo" data-cap-toast="undo">↩ Deshacer</button>` : ''}
    <button type="button" class="cap-toast-btn cap-toast-ver" data-cap-toast="ver"><span class="cap-toast-arrow">→</span> Ver ${esc(MOD_LABEL[modulo] || modulo)}</button>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));

  let cerrado = false;
  const quitar = () => {
    if (cerrado) return;
    cerrado = true;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 400);
  };

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cap-toast]');
    if (!btn) return;
    const accion = btn.dataset.capToast;
    if (accion === 'ver') { navigate(modulo); quitar(); return; }
    if (accion === 'undo') {
      // Solo deshace si el "último insert" sigue siendo ESTE (no lo pisó otra captura).
      if (!O.ultimoInsert || O.ultimoInsert.sello !== selloEsperado) { quitar(); return; }
      btn.disabled = true;
      await deshacerUltimo(O.ultimoInsert, modulo);
      quitar();
    }
  });

  // Ventana de deshacer ~6s (un poco más larga que un toast normal, para dar tiempo).
  setTimeout(quitar, 6000);
}

/* ============================================================
   Deshacer — revierte el insert recién hecho.
   Soft-delete (_deleted=true) donde el esquema lo soporta (plata);
   hard delete donde no (nutricion_log / training_sets / rutina_checks).
   ============================================================ */
async function deshacerUltimo(ref, modulo) {
  if (!supabase) { toast('Supabase no está configurado', 'error'); return; }
  const uid = getUserId();
  if (!uid) { toast('No hay sesión activa', 'error'); return; }
  const { tabla, ids, soft } = ref || {};
  if (!tabla || !Array.isArray(ids) || !ids.length) return;
  try {
    let error;
    if (soft) {
      ({ error } = await supabase.from(tabla).update({ _deleted: true }).in('id', ids).eq('user_id', uid));
    } else {
      ({ error } = await supabase.from(tabla).delete().in('id', ids).eq('user_id', uid));
    }
    if (error) throw error;
    // Consumido: no permitir deshacer dos veces el mismo insert.
    if (O.ultimoInsert && O.ultimoInsert.sello === ref.sello) O.ultimoInsert = null;
    toast('Deshecho · se quitó de ' + (MOD_LABEL[modulo] || modulo), 'info');
  } catch (err) {
    toast('No se pudo deshacer: ' + msgErr(err), 'error');
  }
}

/* ============================================================
   Card "vuela" al módulo destino (FLIP con getBoundingClientRect).
   Clona la card, la encoge y desliza hacia el ícono de la nav del módulo;
   ese ícono pega un pulso de "recibido". Sin ícono / reduced-motion →
   fade normal. Siempre cierra el overlay al terminar (onDone corre antes
   del cierre visual para que el toast aparezca en tiempo).
   ============================================================ */

// Ícono de la nav del módulo que esté VISIBLE (desktop .vida-nav o mobile
// .vida-dock; el otro está display:none). Devuelve el elemento o null.
function iconoNavModulo(modulo) {
  const nodos = document.querySelectorAll(`.vida-nav-item[data-id="${modulo}"]`);
  for (const el of nodos) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el; // visible (el oculto mide 0)
  }
  return null;
}

// Pulso "recibido" en el ícono destino (glow + rebote breve).
function pulsarIcono(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove('cap-nav-recibido');
  // reflow para reiniciar la animación si ya la tenía
  void el.offsetWidth;
  el.classList.add('cap-nav-recibido');
  setTimeout(() => el.classList.remove('cap-nav-recibido'), 700);
}

function volarCardAlModulo(modulo, onDone) {
  const card = O.overlay && O.overlay.querySelector('.cap-card');
  const destino = iconoNavModulo(modulo);

  // Degradación: sin animación posible → toast + cierre directo.
  if (!card || !destino || reducedMotion()) {
    if (onDone) onDone();
    pulsarIcono(destino); // no-op si reduced-motion o sin destino
    cerrar();
    return;
  }

  const desde = card.getBoundingClientRect();
  const hasta = destino.getBoundingClientRect();

  // Clon volador: copia el look de la card, posicionado fixed sobre ella.
  const vol = document.createElement('div');
  vol.className = 'cap-volador';
  vol.style.left = desde.left + 'px';
  vol.style.top = desde.top + 'px';
  vol.style.width = desde.width + 'px';
  vol.style.height = desde.height + 'px';
  document.body.appendChild(vol);

  // Ocultar la card real y el fondo del modal ya (el clon toma la posta).
  // pointer-events:none evita un re-tap sobre el modal invisible durante el vuelo.
  const modal = O.overlay.querySelector('.cap-modal');
  if (modal) { modal.style.opacity = '0'; modal.style.pointerEvents = 'none'; }

  // Delta hacia el centro del ícono destino + escala mínima.
  const cx = hasta.left + hasta.width / 2;
  const cy = hasta.top + hasta.height / 2;
  const dx = cx - (desde.left + desde.width / 2);
  const dy = cy - (desde.top + desde.height / 2);
  const escala = Math.max(0.05, Math.min(0.22, (hasta.width || 40) / (desde.width || 320)));

  // Toast/estado ahora (antes de que el clon termine) para que aparezca a tiempo.
  if (onDone) onDone();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      vol.style.transform = `translate(${dx}px, ${dy}px) scale(${escala})`;
      vol.style.opacity = '0.15';
    });
  });

  let terminado = false;
  const finalizar = () => {
    if (terminado) return;
    terminado = true;
    vol.remove();
    pulsarIcono(destino);
    cerrar();
  };
  vol.addEventListener('transitionend', finalizar, { once: true });
  setTimeout(finalizar, 620); // fallback si no dispara transitionend
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
  const { data, error } = await supabase.from('plata_movimientos').insert(fila).select('id');
  if (error) throw error;
  const ids = (data || []).map(r => r.id).filter(Boolean);
  return {
    modulo: 'plata',
    label: (fila.tipo === 'ingreso' ? '+' : '−') + ' ' + monto + ' ' + fila.moneda,
    undo: { tabla: 'plata_movimientos', ids, soft: true },
  };
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
  const { data, error } = await supabase.from('nutricion_log').insert(filas).select('id');
  if (error) throw error;
  const ids = (data || []).map(r => r.id).filter(Boolean);
  const totalProt = filas.reduce((s, f) => s + f.prot, 0);
  return {
    modulo: 'nutricion',
    label: filas.length + ' ítem' + (filas.length > 1 ? 's' : '') + ' · ' + Math.round(totalProt) + ' g prot',
    undo: { tabla: 'nutricion_log', ids, soft: false },
  };
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
  const { data: setsIns, error: e3 } = await supabase.from('training_sets').insert(filas).select('id');
  if (e3) throw e3;
  const ids = (setsIns || []).map(r => r.id).filter(Boolean);
  // Undo revierte los SETS recién insertados (el registro capturado). La sesión
  // y el ejercicio del catálogo quedan; borrar solo los sets es el revert seguro.
  return {
    modulo: 'training',
    label: nombre + ' · ' + filas.length + ' serie' + (filas.length > 1 ? 's' : ''),
    undo: { tabla: 'training_sets', ids, soft: false },
  };
}

async function commitRutina(uid, p) {
  const c = p.campos;
  const checks = (Array.isArray(c.checks) ? c.checks : []).filter(ch => ch._marcar !== false);
  if (!checks.length) { toast('No hay hábitos marcados', 'warning'); return null; }
  const fecha = String(c.fecha || hoyStr()).slice(0, 10) || hoyStr();
  let ok = 0, yaHechos = 0;
  const idsNuevos = []; // solo los checks RECIÉN insertados (deshacer no toca los que ya estaban)
  for (const ch of checks) {
    const { data, error } = await supabase.from('rutina_checks').insert({
      user_id: uid, fecha, rutina_id: ch.rutina_id, item_id: String(ch.item_id),
    }).select('id');
    if (error) {
      // 23505 = violación de unique → ya estaba hecho ese día. No es error.
      if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) { yaHechos++; continue; }
      throw error;
    }
    if (data && data[0] && data[0].id) idsNuevos.push(data[0].id);
    ok++;
  }
  const partes = [];
  if (ok) partes.push(ok + ' marcado' + (ok > 1 ? 's' : ''));
  if (yaHechos) partes.push(yaHechos + ' ya estaba' + (yaHechos > 1 ? 'n' : ''));
  return {
    modulo: 'rutina',
    label: partes.join(' · ') || 'sin cambios',
    undo: { tabla: 'rutina_checks', ids: idsNuevos, soft: false },
  };
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
  --cap-level: 0;                         /* nivel del micro (0..1), lo setea el medidor */
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

/* El FAB emite dos capas vivas (::before halo/anillo, ::after onda). El icono
   queda por encima (position + z-index sobre los pseudo-elementos). */
.cap-fab > * { position: relative; z-index: 2; }
.cap-fab::before, .cap-fab::after {
  content: ""; position: absolute; inset: 0; border-radius: 50%;
  pointer-events: none; z-index: 1;
}

/* --- IDLE: halo turquesa que respira alrededor del FAB --- */
.cap-fab[data-cap-estado="idle"]::before {
  background: radial-gradient(circle, var(--accent-soft) 0%, transparent 70%);
  transform: scale(1.35);
  animation: cap-halo 4.5s ease-in-out infinite;
}
@keyframes cap-halo {
  0%, 100% { transform: scale(1.2);  opacity: .55; }
  50%      { transform: scale(1.7);  opacity: 1; }
}

/* --- GRABANDO: anillo que late; su intensidad sube con la voz (--cap-level) --- */
.cap-fab[data-cap-estado="grabando"] {
  animation: cap-fab-latido 1.6s ease-in-out infinite;
}
.cap-fab[data-cap-estado="grabando"]::before {
  border: 2px solid var(--accent);
  opacity: calc(.35 + var(--cap-level) * .55);
  transform: scale(calc(1.15 + var(--cap-level) * .55));
  transition: transform .08s linear, opacity .08s linear;
}
.cap-fab[data-cap-estado="grabando"]::after {
  border: 2px solid var(--accent);
  animation: cap-onda 1.5s ease-out infinite;
}
@keyframes cap-onda {
  0%   { transform: scale(1);   opacity: .5; }
  100% { transform: scale(2.1); opacity: 0; }
}
@keyframes cap-fab-latido {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.06); }
}

/* --- PENSANDO: shimmer que barre el FAB mientras interpreta --- */
.cap-fab[data-cap-estado="pensando"] {
  background-image: linear-gradient(100deg, var(--accent) 30%, var(--accent-2) 50%, var(--accent) 70%);
  background-size: 220% 100%;
  animation: cap-shimmer-fab 1.1s linear infinite;
}
.cap-fab[data-cap-estado="pensando"]::before {
  border: 2px dashed color-mix(in srgb, var(--accent-2) 70%, transparent);
  transform: scale(1.3);
  animation: cap-girar 2.4s linear infinite;
}
@keyframes cap-shimmer-fab { 100% { background-position: 220% 0; } }
@keyframes cap-girar { 100% { transform: scale(1.3) rotate(360deg); } }

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
/* "Entender" ocupado mientras interpreta: shimmer sutil sobre el acento. */
.cap-btn-primario.cap-pensando {
  opacity: 1;
  background-image: linear-gradient(100deg, var(--accent) 30%, var(--accent-2) 50%, var(--accent) 70%);
  background-size: 220% 100%;
  animation: cap-shimmer-fab 1.1s linear infinite;
}
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

/* --- Toast de acciones tras guardar: Deshacer + Ver --- */
.cap-toast-acc {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) var(--space-2) !important;
  cursor: default; border-color: var(--accent) !important;
}
.cap-toast-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 12px; border-radius: var(--radius-sm);
  background: transparent; border: 1px solid var(--border-strong);
  color: var(--text); font: inherit; font-size: .82rem; font-weight: 700;
  cursor: pointer; white-space: nowrap;
  transition: background var(--dur-fast, .12s) ease, border-color var(--dur-fast, .12s) ease, color var(--dur-fast, .12s) ease;
}
.cap-toast-btn:hover { background: var(--surface-2); }
.cap-toast-undo { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
.cap-toast-undo:hover { background: color-mix(in srgb, var(--warn) 14%, transparent); border-color: var(--warn); }
.cap-toast-undo:disabled { opacity: .5; cursor: default; }
.cap-toast-ver { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.cap-toast-ver:hover { background: var(--accent-soft); border-color: var(--accent); }
.cap-toast-arrow { font-weight: 800; }

/* --- Clon volador de la card hacia el ícono del módulo --- */
.cap-volador {
  position: fixed; z-index: 80; pointer-events: none;
  background: var(--surface); border: 1px solid var(--accent);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 1px var(--accent-soft), var(--shadow-2);
  opacity: .95; transform-origin: center center; will-change: transform, opacity;
  transition: transform 560ms var(--ease-spring, cubic-bezier(0.34,1.4,0.5,1)), opacity 560ms ease-in;
}

/* --- Pulso "recibido" en el ícono destino de la nav --- */
.cap-nav-recibido { animation: cap-recibido 700ms var(--ease-out-expo, cubic-bezier(0.16,1,0.3,1)); }
.cap-nav-recibido .vida-nav-ic { animation: cap-recibido-ic 700ms var(--ease-spring, cubic-bezier(0.34,1.4,0.5,1)); }
@keyframes cap-recibido {
  0%   { background: var(--accent-soft); box-shadow: 0 0 0 0 var(--accent-soft); }
  40%  { background: var(--accent-soft); box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 22%, transparent); }
  100% { background: transparent; box-shadow: 0 0 0 0 transparent; }
}
@keyframes cap-recibido-ic {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.5); }
  100% { transform: scale(1); }
}

@media (min-width: 768px) {
  .cap-modal { align-items: center; }
  .cap-card { border-radius: var(--radius-lg); }
}

/* --- Respeto por prefers-reduced-motion: nada de movimiento --- */
@media (prefers-reduced-motion: reduce) {
  .cap-fab { transition: none; animation: none !important; }
  .cap-fab::before, .cap-fab::after { animation: none !important; opacity: 0 !important; }
  .cap-btn-primario.cap-pensando { animation: none !important; background-image: none; }
  .cap-volador { transition: none !important; }
  .cap-nav-recibido, .cap-nav-recibido .vida-nav-ic { animation: none !important; }
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
    fab.dataset.capEstado = 'idle'; // arranca respirando (halo turquesa)
    // El emoji va en un span para quedar por encima de los pseudo-elementos vivos.
    fab.innerHTML = '<span class="cap-fab-ic" aria-hidden="true">🎤</span>';
    fab.addEventListener('click', abrir);
    document.body.appendChild(fab);
    O.fab = fab;
  } else {
    O.fab = document.getElementById('capFab');
    if (O.fab && !O.fab.dataset.capEstado) O.fab.dataset.capEstado = 'idle';
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
