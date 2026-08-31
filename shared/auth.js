// shared/auth.js
//
// Shared authentication helpers used by all three panels.
// Two login methods: Telegram (primary, one-tap) and email/password
// (fallback, in case Telegram isn't available for the user).

import { supabase, callFunction } from "./supabase-client.js";

// ---------------- Telegram login ----------------

export async function loginWithTelegram(telegramPayload) {
  const result = await callFunction("telegram-auth", telegramPayload);

  const { error } = await supabase.auth.setSession({
    access_token: result.session.access_token,
    refresh_token: result.session.refresh_token,
  });

  if (error) {
    throw new Error("خطا در فعال‌سازی نشست کاربری");
  }

  return result.profile;
}

// ---------------- Email login ----------------

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

export async function getProfessionalApplication(profileId) {
  const { data } = await supabase
    .from("professional_profiles")
    .select("status")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data;
}

export async function requireRole(requiredRole, loginUrl = "/fixconnect/index.html") {
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

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}
