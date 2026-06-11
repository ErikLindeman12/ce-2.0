import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

// Lazily created so `next build` doesn't need the env vars at build time —
// they're read on the first request instead. Server-only: uses the service
// role key, never exposed to the browser.
export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      // Next.js patches global fetch with its Data Cache, which silently
      // caches Supabase REST reads inside route handlers — queue views and
      // item details would serve minutes-old snapshots. Always bypass it.
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
  return client;
}
