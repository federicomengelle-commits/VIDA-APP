// user_config: única fuente de metas/horarios/slots. Cache en memoria por sesión.
import { supabase } from './supabase.js';
import { toast } from './ui.js';

let cache = {};          // { modulo: { clave: valor } }
let cachedUserId = null;

export async function loadConfig(userId) {
  cache = {};
  cachedUserId = userId ?? null;
  if (!supabase || !userId) return cache;
  try {
    const { data, error } = await supabase
      .from('user_config')
      .select('*')
      .eq('user_id', userId);
    if (error) throw error;
    for (const row of data ?? []) {
      if (!cache[row.modulo]) cache[row.modulo] = {};
      cache[row.modulo][row.clave] = row.valor;
    }
  } catch (err) {
    // Config inaccesible ≠ config vacía: si esto se traga el error, el módulo
    // diagnostica "falta el seed" cuando en realidad falló la conexión.
    console.error('[config] loadConfig falló:', err);
    toast('No se pudo cargar tu configuración: ' + (err?.message || 'error de conexión'), 'error');
  }
  return cache;
}

export function getConfig(modulo, clave, fallback = null) {
  const valor = cache?.[modulo]?.[clave];
  return valor === undefined ? fallback : valor;
}

export async function setConfig(modulo, clave, valor) {
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!cachedUserId) throw new Error('No hay usuario activo para guardar la config.');
  const { error } = await supabase
    .from('user_config')
    .upsert(
      { user_id: cachedUserId, modulo, clave, valor, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,modulo,clave' }
    );
  if (error) {
    console.error('[config] setConfig falló:', error);
    throw new Error('No se pudo guardar la configuración.');
  }
  if (!cache[modulo]) cache[modulo] = {};
  cache[modulo][clave] = valor;
  return valor;
}

export function moduleConfig(modulo) {
  return {
    get(clave, fallback = null) { return getConfig(modulo, clave, fallback); },
    set(clave, valor) { return setConfig(modulo, clave, valor); },
    all() { return { ...(cache[modulo] ?? {}) }; },
  };
}
