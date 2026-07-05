// Primitivas de feedback: toasts apilables + modal de confirmación propio.

const TIPOS = ['success', 'error', 'warning', 'info'];
const ICONOS = { success: '✓', error: '✕', warning: '!', info: 'i' };

let toastWrap = null;

function ensureToastWrap() {
  if (toastWrap && document.body.contains(toastWrap)) return toastWrap;
  toastWrap = document.createElement('div');
  toastWrap.id = 'vidaToasts';
  toastWrap.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastWrap);
  return toastWrap;
}

export function toast(msg, type = 'info') {
  if (!TIPOS.includes(type)) type = 'info';
  const wrap = ensureToastWrap();

  const el = document.createElement('div');
  el.className = `vida-toast vida-toast-${type}`;
  el.setAttribute('role', 'status');

  const ic = document.createElement('span');
  ic.className = 'vida-toast-ic';
  ic.textContent = ICONOS[type];

  const tx = document.createElement('span');
  tx.className = 'vida-toast-msg';
  tx.textContent = String(msg ?? '');

  el.append(ic, tx);
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove('in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // fallback si no hay transición
  };

  const ttl = type === 'error' ? 5000 : 3200;
  const timer = setTimeout(dismiss, ttl);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

export function confirmDialog({ title = '¿Estás seguro?', message = '', confirmText = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vida-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'card vida-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const h = document.createElement('h3');
    h.className = 'vida-modal-title';
    h.textContent = title;
    modal.appendChild(h);

    if (message) {
      const p = document.createElement('p');
      p.className = 'vida-modal-msg';
      p.textContent = message;
      modal.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'vida-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancelar';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    okBtn.textContent = confirmText;

    actions.append(cancelBtn, okBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    let settled = false;
    const close = (valor) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.classList.remove('in');
      setTimeout(() => overlay.remove(), 200);
      resolve(valor);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('in'));
    (danger ? cancelBtn : okBtn).focus();
  });
}
