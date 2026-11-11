// The one connection to the Supabase database. Server side only: it uses the secret key, which
// must never reach the browser, so nothing in a client component may import this file.
// The tables are locked, so only this key can read or write them.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const DB_TIMEOUT_MS = 5000;

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error("The database is not configured");
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // A slow database must never hold a customer's message for long.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) }) },
  });
  return client;
}
