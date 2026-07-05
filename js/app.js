// Bootstrap de VIDA: setup → auth → config → shell → módulos → router.
import { isConfigured, supabase } from './core/supabase.js';
import { initAuth, login, logout, getUser, onAuthChange } from './core/auth.js';
import { loadConfig } from './core/config.js';
import { registerModule, startRouter, navigate } from './core/router.js';
import { toast, confirmDialog } from './core/ui.js';
import { initCaptura } from './core/captura.js';

const MODULES = [
  { id: 'nutricion', label: 'Nutrición', icon: '🥩', enabled: true,  loader: () => import('./modules/nutricion.js') },
  { id: 'plata',     label: 'Plata',     icon: '💵', enabled: true,  loader: () => import('./modules/plata.js') },
  { id: 'rutina',    label: 'Rutina',    icon: '☀️', enabled: true,  loader: () => import('./modules/rutina.js') },
  { id: 'training',  label: 'Training',  icon: '🏋️', enabled: true,  loader: () => import('./modules/training.js') },
  { id: 'insights',  label: 'Insights',  icon: '🧠', enabled: true,  loader: () => import('./modules/insights.js') },
];

const FASES = { plata: 'Fase 2', rutina: 'Fase 3', training: 'Fase 4', insights: 'Fase 5' };

const app = document.getElementById('app');
let entering = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- Pantalla de setup (env.js sin configurar) ---------- */
function renderSetup() {
  app.innerHTML = `
    <div class="vida-auth">
      <div class="vida-auth-glow"></div>
      <div class="card vida-setup-card">
        <div class="vida-brand">
          <span class="vida-logo">VIDA</span>
          <span class="vida-tagline">Tu sistema operativo personal</span>
        </div>
        <h2>Falta conectar Supabase</h2>
        <ol class="vida-setup-steps">
          <li>Creá tu proyecto en <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>
          <li>Corré los SQL de la carpeta <code>sql/</code> en orden: <code>00_core.sql</code>, <code>01_nutricion.sql</code>.</li>
          <li>Creá tu usuario en <strong>Authentication → Users</strong> y recién ahí corré <code>02_seed_nutricion.sql</code>.</li>
          <li>Copiá la URL y la anon key (Settings → API) en <code>js/core/env.js</code>.</li>
          <li>Recargá esta página.</li>
        </ol>
        <p class="vida-setup-note">La guía completa paso a paso está en <code>SETUP.md</code>.</p>
      </div>
    </div>`;
}

/* ---------- Error de conexión con el CDN de Supabase ---------- */
function renderConnError() {
  app.innerHTML = `
    <div class="vida-auth">
      <div class="vida-auth-glow"></div>
      <div class="card vida-setup-card">
        <div class="vida-brand">
          <span class="vida-logo">VIDA</span>
        </div>
        <h2>No se pudo cargar Supabase</h2>
        <p class="vida-setup-note" style="margin-bottom: var(--space-5);">
          Parece un problema de conexión. Revisá tu internet y volvé a intentar.
        </p>
        <button type="button" class="btn btn-primary" id="reloadBtn">Recargar</button>
      </div>
    </div>`;
  const btn = document.getElementById('reloadBtn');
  if (btn) btn.addEventListener('click', () => location.reload());
}

/* ---------- Login ---------- */
function renderLogin() {
  app.innerHTML = `
    <div class="vida-auth">
      <div class="vida-auth-glow"></div>
      <div class="card vida-auth-card">
        <div class="vida-brand">
          <span class="vida-logo">VIDA</span>
          <span class="vida-tagline">Tu sistema operativo personal</span>
        </div>
        <form id="loginForm" novalidate>
          <label class="vida-field">
            <span>Email</span>
            <input class="input" type="email" name="email" autocomplete="email" inputmode="email" required>
          </label>
          <label class="vida-field">
            <span>Contraseña</span>
            <input class="input" type="password" name="password" autocomplete="current-password" required>
          </label>
          <div class="vida-auth-error" id="loginError" hidden></div>
          <button class="btn btn-primary vida-auth-submit" type="submit">Entrar</button>
        </form>
      </div>
    </div>`;

  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;

    errorBox.hidden = true;
    if (!email || !password) {
      errorBox.textContent = 'Completá email y contraseña.';
      errorBox.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Entrando…';
    try {
      const user = await login(email, password);
      await enterApp(user);
    } catch (err) {
      errorBox.textContent = err?.message || 'No se pudo iniciar sesión.';
      errorBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Entrar';
    }
  });

  form.email.focus();
}

/* ---------- Shell logueado ---------- */
function navItemHtml(m) {
  const disabled = m.enabled ? '' : 'data-disabled';
  const fase = m.enabled ? '' : `<span class="vida-fase">${esc(FASES[m.id] || 'Pronto')}</span>`;
  return `
    <button type="button" class="vida-nav-item" data-id="${esc(m.id)}" ${disabled}>
      <span class="vida-nav-ic" aria-hidden="true">${m.icon}</span>
      <span>${esc(m.label)}</span>
      ${fase}
    </button>`;
}

function renderShell(user) {
  const items = MODULES.map(navItemHtml).join('');
  const email = esc(user?.email || '');

  app.innerHTML = `
    <div class="vida-shell">
      <header class="vida-topbar">
        <span class="vida-logo vida-logo-sm">VIDA</span>
        <button type="button" class="btn btn-ghost" data-logout>Salir</button>
      </header>
      <nav class="vida-sidenav" aria-label="Módulos">
        <div class="vida-brand-side"><span class="vida-logo vida-logo-sm">VIDA</span></div>
        <div class="vida-nav-list">${items}</div>
        <div class="vida-side-foot">
          <span class="vida-user" title="${email}">${email}</span>
          <button type="button" class="btn btn-ghost" data-logout>Salir</button>
        </div>
      </nav>
      <main id="mainContent"></main>
      <nav class="vida-bottomnav" aria-label="Módulos">${items}</nav>
    </div>`;

  const shell = app.querySelector('.vida-shell');

  shell.addEventListener('click', async (e) => {
    const navBtn = e.target.closest('.vida-nav-item');
    if (navBtn) {
      const id = navBtn.dataset.id;
      const mod = MODULES.find((m) => m.id === id);
      if (!mod) return;
      if (!mod.enabled) {
        toast(`${mod.label} llega en ${FASES[id] || 'una fase próxima'}.`, 'info');
        return;
      }
      navigate(id);
      return;
    }

    if (e.target.closest('[data-logout]')) {
      const ok = await confirmDialog({
        title: 'Cerrar sesión',
        message: '¿Querés salir de VIDA?',
        confirmText: 'Salir',
      });
      if (!ok) return;
      await logout(); // onAuthChange vuelve al login
    }
  });
}

/* ---------- Resaltado del ítem activo ---------- */
window.addEventListener('vida:route', (e) => {
  const id = e.detail?.id;
  document.querySelectorAll('.vida-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
});

/* ---------- Entrada a la app ---------- */
async function enterApp(user) {
  if (entering) return;
  entering = true;
  try {
    app.innerHTML = '<div class="vida-boot"><span class="vida-logo">VIDA</span></div>';

    await loadConfig(user.id);
    renderShell(user);

    let registrados = 0;
    for (const m of MODULES) {
      if (!m.enabled || typeof m.loader !== 'function') continue;
      try {
        const imported = await m.loader();
        const mod = imported?.default;
        if (!mod || mod.id !== m.id) throw new Error(`export default inválido en ${m.id}`);
        registerModule(mod);
        registrados++;
      } catch (err) {
        console.error(`[app] no se pudo cargar el módulo "${m.id}":`, err);
        toast(`No se pudo cargar ${m.label}.`, 'error');
      }
    }

    if (registrados === 0) {
      const main = document.getElementById('mainContent');
      if (main) {
        main.innerHTML = `
          <div class="empty-state">
            <strong>No hay módulos disponibles</strong>
            <span>Ningún módulo pudo cargarse. Recargá la página o revisá la consola.</span>
          </div>`;
      }
      return;
    }

    await startRouter('nutricion');
    initCaptura(); // captador universal (voz + texto); idempotente
  } catch (err) {
    console.error('[app] enterApp falló:', err);
    toast('Algo falló al iniciar la app.', 'error');
  } finally {
    entering = false;
  }
}

/* ---------- Boot ---------- */
async function boot() {
  if (!app) return;

  if (!isConfigured) {
    renderSetup();
    return;
  }
  if (!supabase) {
    renderConnError();
    return;
  }

  onAuthChange((user) => {
    if (!user && !entering) {
      renderLogin();
      toast('Cerraste sesión.', 'info');
    }
  });

  const user = await initAuth();
  if (user) {
    await enterApp(user);
  } else {
    renderLogin();
  }
}

boot().catch((err) => {
  console.error('[app] boot falló:', err);
  if (app) {
    app.innerHTML = `
      <div class="vida-auth">
        <div class="card vida-setup-card">
          <h2>Algo salió mal</h2>
          <p class="vida-setup-note">Recargá la página. Si sigue fallando, revisá la consola del navegador.</p>
        </div>
      </div>`;
  }
});
