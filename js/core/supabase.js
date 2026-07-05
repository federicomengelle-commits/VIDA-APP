// Cliente único de Supabase. Ningún otro archivo importa el CDN.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './env.js';

export const isConfigured =
  typeof SUPABASE_URL === 'string' &&
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_URL.length > 0 &&
  SUPABASE_ANON_KEY.length > 0 &&
  !SUPABASE_URL.startsWith('__') &&
  !SUPABASE_ANON_KEY.startsWith('__');

let client = null;

if (isConfigured) {
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error('[supabase] No se pudo cargar el cliente desde el CDN:', err);
    client = null;
  }
}

export const supabase = client;
