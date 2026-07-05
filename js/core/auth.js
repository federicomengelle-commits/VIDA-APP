// Sesión y usuario actual. Único dueño del estado de auth.
import { supabase } from './supabase.js';

let currentUser = null;
let watching = false;
const listeners = new Set();

function notify(user) {
  for (const cb of listeners) {
    try { cb(user); } catch (err) { console.error('[auth] listener falló:', err); }
  }
}

function watchSession() {
  if (watching || !supabase) return;
  watching = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    const changed = (user?.id ?? null) !== (currentUser?.id ?? null);
    currentUser = user;
    if (changed) notify(user);
  });
}

function mensajeLegible(error) {
  const m = (error?.message || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'Email o contraseña incorrectos.';
  if (m.includes('email not confirmed')) return 'Ese email no está confirmado. Confirmalo desde el panel de Supabase.';
  if (m.includes('missing email')) return 'Completá el email.';
  if (m.includes('missing password')) return 'Completá la contraseña.';
  if (m.includes('too many requests') || m.includes('rate limit')) return 'Demasiados intentos. Esperá un minuto y probá de nuevo.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'No hay conexión con el servidor. Revisá tu internet.';
  return error?.message || 'No se pudo iniciar sesión. Probá de nuevo.';
}

export async function initAuth() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    currentUser = data?.session?.user ?? null;
  } catch (err) {
    console.error('[auth] initAuth falló:', err);
    currentUser = null;
  }
  watchSession();
  return currentUser;
}

export async function login(email, password) {
  if (!supabase) throw new Error('Supabase no está configurado todavía.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(mensajeLegible(error));
  currentUser = data?.user ?? null;
  return currentUser;
}

export async function logout() {
  if (!supabase) return;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  } catch (err) {
    console.error('[auth] logout falló:', err);
  }
  // Garantiza la salida local aunque el servidor no responda.
  const habiaSesion = currentUser !== null;
  currentUser = null;
  if (habiaSesion) notify(null);
}

export function getUser() {
  return currentUser;
}

export function getUserId() {
  return currentUser?.id ?? null;
}

export function onAuthChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}
