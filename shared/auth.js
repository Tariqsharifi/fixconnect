// shared/auth.js
//
// Shared authentication helpers used by all three panels.
// Handles: applying a Telegram-issued session, getting the current
// user + role, redirecting based on role, and logging out.

import { supabase, callFunction } from "./supabase-client.js";

// Call this once the Telegram Login Widget gives you a payload.
// It exchanges the Telegram data for a real Supabase session and
// stores it in the browser via supabase-js.
export async function loginWithTelegram(telegramPayload) {
  const result = await callFunction("telegram-auth", telegramPayload);

  const { error } = await supabase.auth.setSession({
    access_token: result.session.access_token,
    refresh_token: result.session.refresh_token,
  });

  if (error) {
    throw new Error("خطا در فعال‌سازی نشست کاربری");
  }

  return result.profile; // { id, role, full_name, phone, city, area, is_blocked }
}

// Returns the logged-in user's profile row, or null if not logged in.
export async function getCurrentProfile() {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, role, full_name, phone, city, area, is_blocked, telegram_username, telegram_photo_url")
    .eq("id", user.id)
    .single();

  if (error) return null;
  return profile;
}

// Guards a page: if not logged in, or logged in with the wrong role,
// redirect to loginUrl / homeUrl. Call this at the top of every
// panel page (customer/professional/admin), right after imports.
//
// Example (inside professional/index.html's script):
//   const profile = await requireRole("professional", "/index.html");
export async function requireRole(requiredRole, loginUrl = "/index.html") {
  const profile = await getCurrentProfile();

  if (!profile) {
    window.location.href = loginUrl;
    return null;
  }

  if (profile.is_blocked) {
    await logout();
    alert("حساب شما مسدود شده است.");
    window.location.href = loginUrl;
    return null;
  }

  if (profile.role !== requiredRole) {
    window.location.href = loginUrl;
    return null;
  }

  return profile;
}

export async function logout() {
  await supabase.auth.signOut();
}

// Listen for auth state changes (e.g. token refreshed, signed out
// in another tab). Optional to use, but handy for keeping UI in sync.
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}
