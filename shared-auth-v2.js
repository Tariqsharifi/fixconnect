// shared/auth.js
//
// Shared authentication helpers used by all three panels.
// Two login methods: Telegram (primary, one-tap) and email/password
// (fallback, in case Telegram isn't available for the user).

import { supabase, callFunction } from "./supabase-client.js";

// ---------------- Telegram login ----------------

// Call this once the Telegram Login Widget gives you a payload.
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

// ---------------- Email login ----------------

// Simple 3-field signup: name, email, password. No email confirmation
// step — the person is logged in immediately, to keep friction low.
export async function signupWithEmail(fullName, email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
    },
  });

  if (error) {
    throw new Error(translateAuthError(error.message));
  }

  return data;
}

export async function loginWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw new Error(translateAuthError(error.message));
  }

  return data;
}

function translateAuthError(message) {
  const map = {
    "Invalid login credentials": "ایمیل یا رمز عبور اشتباه است",
    "User already registered": "این ایمیل قبلاً ثبت‌نام کرده — وارد شوید",
    "Password should be at least 6 characters": "رمز عبور باید حداقل ۶ کاراکتر باشد",
  };
  return map[message] || "خطایی رخ داد، دوباره تلاش کنید";
}

// ---------------- Shared (used by both methods) ----------------

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

// FIX: previously nothing ever set profiles.role to "professional"
// until the signup page did it *immediately on submit* — before any
// admin review. That meant a rejected applicant was permanently
// stuck (no longer "customer", never approved as "professional").
//
// New rule: profiles.role only becomes "professional" when an admin
// approves the application (see admin panel). While an application
// is pending/rejected/blocked, role stays "customer" and pages use
// this helper to find the professional_profiles row (if any) so a
// pending/rejected applicant is still routed to the status page
// instead of silently landing back in the customer panel.
export async function getProfessionalApplication(profileId) {
  const { data } = await supabase
    .from("professional_profiles")
    .select("status")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data; // { status } or null if never applied
}

// Guards a page: if not logged in, or logged in with the wrong role,
// redirect to loginUrl. Call this at the top of every panel page.
// FIX/FEATURE: requiredRole can now be a single role ("customer") or
// an array of allowed roles (["customer", "professional"]) — this
// lets a professional account also use the customer-side pages (e.g.
// to submit their own repair request) without needing a second email,
// while a plain customer still can't reach professional-only pages.
export async function requireRole(requiredRole, loginUrl = "/fixconnect/index.html") {
  const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
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

  if (!allowedRoles.includes(profile.role)) {
    window.location.href = loginUrl;
    return null;
  }

  return profile;
}

export async function logout() {
  await supabase.auth.signOut();
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}
