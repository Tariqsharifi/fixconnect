// shared/supabase-client.js
//
// Single shared Supabase connection used by all three panels
// (customer, professional, admin). Only the public anon key lives
// here — it is safe to expose in frontend code by design.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://oprbgrmakaxdsyxftdqb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nkRUaEuiemv3FlzOHk6bOA_hdK8TqZR";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "fixconnect-auth",
  },
});

// Helper to call any Edge Function by name with a JSON body.
// Automatically attaches the current session's access token when
// one exists (needed once a user is logged in); for the very first
// telegram-auth call there is no session yet, which is fine.
export async function callFunction(name, body) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || "خطای ناشناخته از سرور");
  }
  return json;
}
