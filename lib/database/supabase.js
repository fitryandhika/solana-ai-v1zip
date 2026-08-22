// lib/database/supabase.js
//
// Two clients are exported:
//   - getServiceClient(): server-only, uses the service role key. Full read/write.
//     NEVER import this from a file that ships to the browser.
//   - getPublicClient(): safe for the browser, uses the anon key.
//
// Both are created lazily and memoized so we don't reconnect on every call.

const { createClient } = require("@supabase/supabase-js");

let serviceClient = null;
let publicClient = null;

function getServiceClient() {
  if (serviceClient) return serviceClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase service client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in your environment."
    );
  }

  serviceClient = createClient(url, serviceKey, {
    auth: { persistSession: false }
  });

  return serviceClient;
}

function getPublicClient() {
  if (publicClient) return publicClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase public client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in your environment."
    );
  }

  publicClient = createClient(url, anonKey, {
    auth: { persistSession: false }
  });

  return publicClient;
}

module.exports = { getServiceClient, getPublicClient };
