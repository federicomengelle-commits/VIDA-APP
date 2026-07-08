// VIDA — /api/foto · foto al plato → macros (Ola 3 · Claude visión)
// ============================================================
// Serverless function de Vercel. Recibe { imagen: dataURL, config } y devuelve
// los alimentos que la IA ESTIMA en la foto:
//   { items:[{nombre, gramos, confianza}], slot, nota }
// Claude SOLO identifica y estima porciones — NUNCA inventa calorías ni macros.
// El GROUNDING (IDs + macros reales) lo hace el cliente contra el catálogo del
// usuario (BACKLOG.md §7: "grounded, not generated"). La foto es una ESTIMACIÓN
// y el usuario ajusta antes de guardar (honestidad > falsa precisión, §7).
//
// SEGURIDAD (CLAUDE.md §1): la ANTHROPIC_API_KEY vive SOLO como env var en
// Vercel; nunca en el repo ni en el browser. Si falta → 501 (el cliente avisa).
// Modelo: claude-sonnet-4-6 (elección de Fede por costo).
// ============================================================

import Anthropic from '@anthropic-ai/sdk';

const MODELO = 'claude-sonnet-4-6';

const SISTEMA = `Sos el analizador de fotos de comida de VIDA (español rioplatense, Argentina). Mirás UNA foto de un plato y listás los alimentos visibles con una ESTIMACIÓN de los gramos de cada porción.

Reglas:
- Listá cada alimento por separado, con nombre simple en es-AR (ej. "carne", "arroz", "huevo", "palta", "pan", "pollo", "fideos").
- "gramos": tu mejor estimación del peso de la porción servida (número). Si no podés estimar, null.
- NUNCA calcules ni inventes calorías, proteínas ni macros: eso lo pone la app desde su base verificada. Vos solo das nombre + gramos.
- "confianza" por ítem: "alta" | "media" | "baja" según lo claro que se vea.
- "slot": si se nota el momento del día (desayuno/almuerzo/merienda/cena), usá el id del vocabulario de slots que te paso; si no, "".
- "nota": una línea honesta y corta reconociendo que es una estimación (ej. "estimación por foto, revisá las porciones"). No exageres precisión.
- Si no hay comida reconocible, devolvé items: [].

Respondé EXCLUSIVAMENTE un objeto JSON válido con esta forma (sin texto antes ni después, sin markdown, sin comillas triples):
{"items":[{"nombre":"","gramos":null,"confianza":"media"}],"slot":"","nota":""}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: 'sin_api_key' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const imagen = typeof body.imagen === 'string' ? body.imagen : '';
  const m = imagen.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'imagen_invalida' });
  const mediaType = m[1];
  const base64 = m[2];
  const config = (body.config && typeof body.config === 'object') ? body.config : {};

  const userText =
    'Vocabulario de slots del usuario (usá el id EXACTO si aplica):\n'
    + JSON.stringify(config.slots || [])
    + '\n\nAnalizá esta foto del plato y listá los alimentos con gramos estimados.';

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODELO,
      max_tokens: 900,
      system: SISTEMA,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: userText },
        ],
      }],
    });

    if (msg.stop_reason === 'refusal') return res.status(200).json({ items: [] });

    const bloque = Array.isArray(msg.content) ? msg.content.find(b => b.type === 'text') : null;
    let txt = (bloque && bloque.text) ? bloque.text.trim() : '';
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const i = txt.indexOf('{');
    const j = txt.lastIndexOf('}');
    if (i >= 0 && j > i) txt = txt.slice(i, j + 1);

    let data;
    try { data = JSON.parse(txt); }
    catch { return res.status(200).json({ items: [] }); }

    return res.status(200).json(data);
  } catch (err) {
    const detalle = (err && err.message) ? err.message : 'error';
    return res.status(502).json({ error: 'anthropic', detalle });
  }
}
