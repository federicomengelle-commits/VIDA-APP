// VIDA · anim — helpers de movimiento del rediseño "Instrumento Vivo".
// Sin dependencias. Todo respeta prefers-reduced-motion.
// API: reducedMotion() · countUp() · ring() · stagger() · tilt() · tiltAll() · pageTransition()

const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false });
const REDUCE = mq('(prefers-reduced-motion: reduce)').matches;
const HOVER  = mq('(hover: hover)').matches;

export function reducedMotion() { return REDUCE; }

// Cuenta un número desde `from` hasta `to`. Devuelve cancel().
export function countUp(el, to, opts = {}) {
  if (!el) return () => {};
  const { from = 0, dur = 1150, decimals = 0, suffix = '', prefix = '' } = opts;
  const fmt = (n) => prefix + Number(n).toFixed(decimals) + suffix;
  if (REDUCE) { el.textContent = fmt(to); return () => {}; }
  let raf = 0, start = null;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (ts) => {
    if (start === null) start = ts;
    const p = Math.min(1, (ts - start) / dur);
    el.textContent = fmt(from + (to - from) * ease(p));
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

// Anima un <circle class="v-ring-fill"> hacia pct (0..100). Lee su radio `r`.
export function ring(circle, pct) {
  if (!circle) return;
  const r = +circle.getAttribute('r') || 26;
  const C = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const target = C * (1 - clamped / 100);
  circle.style.strokeDasharray = C.toFixed(2);
  if (REDUCE) {
    circle.style.transition = 'none';
    circle.style.strokeDashoffset = target.toFixed(2);
    return;
  }
  circle.style.strokeDashoffset = C.toFixed(2); // arranca vacío
  requestAnimationFrame(() =>
    requestAnimationFrame(() => { circle.style.strokeDashoffset = target.toFixed(2); })
  );
}

// Entrada escalonada: agrega .in a cada nodo con delay incremental.
export function stagger(nodes, opts = {}) {
  const { step = 80, base = 60 } = opts;
  const list = Array.from(nodes || []);
  if (REDUCE) { list.forEach((n) => n.classList.add('in')); return; }
  list.forEach((n, i) => setTimeout(() => n.classList.add('in'), base + i * step));
}

// Tilt magnético: la card sigue sutilmente al cursor. Devuelve cleanup().
export function tilt(el, opts = {}) {
  if (!el || REDUCE || !HOVER) return () => {};
  const { max = 5, lift = 2 } = opts;
  const onMove = (e) => {
    const b = el.getBoundingClientRect();
    const px = (e.clientX - b.left) / b.width - 0.5;
    const py = (e.clientY - b.top) / b.height - 0.5;
    el.style.transform =
      `perspective(700px) rotateX(${(py * -max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg) translateY(-${lift}px)`;
  };
  const onLeave = () => { el.style.transform = ''; };
  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseleave', onLeave);
  return () => {
    el.removeEventListener('mousemove', onMove);
    el.removeEventListener('mouseleave', onLeave);
  };
}

// Aplica tilt a todos los [data-tilt] dentro de root. Devuelve cleanup global.
export function tiltAll(root = document) {
  const cleaners = Array.from(root.querySelectorAll('[data-tilt]')).map((el) => tilt(el));
  return () => cleaners.forEach((c) => c());
}

// Transición de página: fade+slide de salida, repaint, fade+slide de entrada.
export function pageTransition(container, paint) {
  if (!container || REDUCE) { if (paint) paint(); return; }
  container.style.transition = 'opacity 120ms ease, transform 120ms ease';
  container.style.opacity = '0';
  container.style.transform = 'translateY(6px)';
  setTimeout(() => {
    if (paint) paint();
    requestAnimationFrame(() => {
      container.style.opacity = '1';
      container.style.transform = 'none';
    });
  }, 120);
}
