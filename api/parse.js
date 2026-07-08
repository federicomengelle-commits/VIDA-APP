// VIDA — /api/parse · cerebro de la captura (Fase 5b / Ola 3)
// ============================================================
// Serverless function de Vercel. Recibe { texto, config } y devuelve el
// "entendimiento" de Claude como JSON:
//   { modulo, confianza, resumen, plata?, nutricion?, training?, rutina? }
// El GROUNDING (IDs reales + macros reales contra el catálogo del usuario) lo
// hace el CLIENTE (js/core/captura.js). Acá Claude SOLO entiende y segmenta —
// nunca inventa macros ni montos que la persona no dijo (BACKLOG.md §7:
// "grounded, not generated").
//
// SEGURIDAD (CLAUDE.md §1): la ANTHROPIC_API_KEY vive SOLO como env var en
// Vercel (Production + Preview), jamás en el repo ni en el browser. Si falta,
// respondemos 501 y el cliente cae al parser determinístico (degrada limpio).
//
// Modelo: claude-sonnet-4-6 (elección de Fede por costo). Sin thinking, salida
// corta → rápido y barato. Sonnet 4.6 no usa structured-outputs estricto, así
// que pedimos JSON por prompt y lo parseamos con tolerancia.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';

const MODELO = 'claude-sonnet-4-6';

const SISTEMA = `Sos el motor de captura de VIDA, un OS personal (español rioplatense, Argentina). Recibís UNA frase (dictada o escrita) y decidís a qué módulo va y qué datos tiene.

Módulos:
- "plata": movimientos de dinero (ingresos/egresos). Campos: tipo ("ingreso"|"egreso"), monto (número puro, sin símbolos ni miles con punto), moneda, ambito (personal, o trabajo/mepex), categoria, descripcion, fecha ("hoy"|"ayer"|"YYYY-MM-DD" solo si la nombran).
- "nutricion": comidas. Campos: slot (momento del día) e items = lista de {nombre, gramos (si dijo gramos), cantidad (si contó unidades, ej "2 huevos")}. Segmentá CADA alimento por separado. NUNCA inventes calorías ni macros: solo el nombre y la cantidad/gramos que dijo la persona; los macros los pone la app desde su base verificada.
- "training": entrenamiento de gimnasio. Campos: ejercicio (nombre) y sets = lista de {peso (kg), reps}. "4x10 con 80" = 4 sets de 10 reps con 80 kg; "3 series de 12" = 3 sets de 12 reps sin peso.
- "rutina": hábitos / checklist del día (tomar creatina, skincare, suplementos, meditar, leer...). Campos: items = lista de frases de los hábitos mencionados.

Reglas:
- Elegí el módulo MÁS probable. Si hay verbo de plata ("gasté", "pagué", "cobré", "compré") + un monto, casi siempre es "plata". Si no entendés la intención, devolvé modulo "ninguno".
- No inventes datos que la persona no dijo. Campos desconocidos: "" o null o [].
- Usá el VOCABULARIO del usuario (slots, monedas, ámbitos y categorías) que te paso en el mensaje: devolvé el id o el nombre EXACTO de esa lista cuando corresponda (ej. el id del slot, el nombre de la categoría, el id del ámbito).
- "resumen": una sola línea corta, en es-AR, de lo que entendiste.

Respondé EXCLUSIVAMENTE un objeto JSON válido con esta forma exacta (sin texto antes ni después, sin markdown, sin comillas triples):
{"modulo":"plata|nutricion|training|rutina|ninguno","confianza":"alta|media|baja","resumen":"","plata":{"tipo":"","monto":null,"moneda":"","ambito":"","categoria":"","descripcion":"","fecha":""},"nutricion":{"slot":"","items":[]},"training":{"ejercicio":"","sets":[]},"rutina":{"items":[]}}
Completá SOLO el bloque del módulo elegido; los demás dejalos con sus valores vacíos.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Sin credencial → el cliente cae al parser determinístico (no es un error).
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: 'sin_api_key' });
  }

  // Body tolerante (Vercel suele parsear JSON, pero por las dudas).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const texto = typeof body.texto === 'string' ? body.texto.trim() : '';
  if (!texto) return res.status(400).json({ error: 'texto_vacio' });
  const config = (body.config && typeof body.config === 'object') ? body.config : {};

  const userMsg =
    'Vocabulario del usuario (usá estos ids/nombres EXACTOS cuando apliquen):\n'
    + JSON.stringify({
        slots: config.slots || [],
        monedas: config.monedas || [],
        ambitos: config.ambitos || [],
        categorias: config.categorias || {},
      })
    + '\n\nFrase a interpretar:\n"' + texto + '"';

  try {
    const client = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno
    const msg = await client.messages.create({
      model: MODELO,
      max_tokens: 700,
      system: SISTEMA,
      messages: [{ role: 'user', content: userMsg }],
    });

    // Rechazo del clasificador → tratamos como "sin intención" (fallback limpio).
    if (msg.stop_reason === 'refusal') {
      return res.status(200).json({ modulo: 'ninguno' });
    }

    const bloque = Array.isArray(msg.content) ? msg.content.find(b => b.type === 'text') : null;
    let txt = (bloque && bloque.text) ? bloque.text.trim() : '';
    // Sacar cercos de código si Claude los agregó.
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // Quedarnos del primer "{" al último "}" por si hay algo alrededor.
    const i = txt.indexOf('{');
    const j = txt.lastIndexOf('}');
    if (i >= 0 && j > i) txt = txt.slice(i, j + 1);

    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      // No devolvió JSON válido → que el cliente use el parser determinístico.
      return res.status(200).json({ modulo: 'ninguno' });
    }

    return res.status(200).json(data);
  } catch (err) {
    const detalle = (err && err.message) ? err.message : 'error';
    // Error de la API/SDK → 502; el cliente cae al determinístico.
    return res.status(502).json({ error: 'anthropic', detalle });
  }
}
