// Router hash-based: #/<id>. Primera visita → init(); siguientes → render().
import { getUserId } from './auth.js';
import { moduleConfig } from './config.js';

const modules = new Map();
const inited = new Map(); // id → container con el que se hizo init (si cambia, se re-inicializa)
let currentId = null;
let defaultId = null;
let listening = false;
let seq = 0;

export function registerModule(mod) {
  if (!mod || typeof mod.id !== 'string' || !mod.id) {
    console.error('[router] módulo inválido, se ignora:', mod);
    return;
  }
  modules.set(mod.id, mod);
}

function parseHash() {
  const m = /^#\/([A-Za-z0-9_-]+)/.exec(location.hash || '');
  return m ? m[1] : null;
}

function paintError(container, id) {
  container.innerHTML = `
    <div class="empty-state">
      <strong>Algo falló al cargar este módulo.</strong>
      <span>Revisá la conexión y probá de nuevo.</span>
      <button type="button" class="btn btn-ghost" data-retry="${id}">Reintentar</button>
    </div>`;
  const btn = container.querySelector('[data-retry]');
  if (btn) btn.addEventListener('click', () => { resolveRoute(); });
}

async function resolveRoute() {
  const my = ++seq;
  let id = parseHash();
  if (!id || !modules.has(id)) id = defaultId;
  if (!id || !modules.has(id)) return;

  const container = document.getElementById('mainContent');
  if (!container) return;

  const mod = modules.get(id);
  currentId = id;
  if (location.hash !== '#/' + id) {
    history.replaceState(null, '', '#/' + id);
  }

  let ok = true;
  try {
    if (inited.get(id) !== container) {
      // Primera visita, o el shell se re-montó (ej. logout→login): init de nuevo
      // con el container y userId frescos.
      inited.set(id, container);
      await mod.init(container, getUserId(), moduleConfig(id));
    } else {
      mod.render();
    }
  } catch (err) {
    ok = false;
    console.error(`[router] falló el módulo "${id}":`, err);
    inited.delete(id);
    if (my === seq) paintError(container, id);
  }

  if (my !== seq || !ok) return; // hubo otra navegación mientras cargaba, o falló el init
  window.dispatchEvent(new CustomEvent('vida:route', { detail: { id } }));
}

export async function startRouter(defaultModuleId) {
  defaultId = defaultModuleId;
  if (!listening) {
    listening = true;
    window.addEventListener('hashchange', resolveRoute);
  }
  await resolveRoute();
}

export function navigate(id) {
  location.hash = '#/' + id;
}

export function currentRoute() {
  return currentId;
}
