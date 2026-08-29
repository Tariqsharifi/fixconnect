// Supabase Edge Function: ai-test-lab-repair
// آزمایش ۳ — تشخیص وسیله با AI و پیدا کردن تعمیرکار مرتبط از دیتابیس واقعی
// (هیچ‌جای این کد "if یخچال => نمایش علی" وجود ندارد؛ همه‌چیز از جدول professionals می‌آید)
//
// نسخهٔ کاملاً رایگان: از Gemini (تحلیل تصویر/متن) + Groq Whisper (تبدیل صدا به متن) استفاده می‌کند
// — همون دو کلیدی که برای آزمایش ۲ ست کرده بودی، بدون نیاز به کلید یا سرویس پولی جدید.
//
// این تابع سه عملیات را از روی فیلد "action" در بدنهٔ درخواست انجام می‌دهد:
//   action = "analyze"     -> تحلیل AI + پیدا کردن تعمیرکار مرتبط
//   action = "register"    -> ثبت‌نام تعمیرکار جدید در دیتاست
//   action = "professions" -> گرفتن لیست حرفه‌ها (برای فرم ثبت‌نام)
//
// Secrets لازم (Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets):
//   GEMINI_API_KEY   (همون کلید آزمایش ۲ — برای تحلیل تصویر/متن)
//   GROQ_API_KEY     (همون کلید آزمایش ۲ — برای تبدیل صدا به متن)
// SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY نیازی به تنظیم دستی ندارند —
// Supabase به‌صورت خودکار در اختیار هر Edge Function قرار می‌دهد.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- لایهٔ دیتابیس (PostgREST خام، بدون هیچ منطق ثابت‌کدشده) ----------
async function dbSelect(table: string, query: string) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error(`خطای دیتابیس (${table}): ${resp.status} — ${await resp.text()}`);
  return resp.json();
}

async function dbInsert(table: string, row: Record<string, unknown>) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`خطای ثبت در دیتابیس (${table}): ${resp.status} — ${await resp.text()}`);
  return resp.json();
}

// ---------- لایهٔ Speech-to-Text (Groq Whisper — رایگان) ----------
async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY تنظیم نشده است.");
  const binary = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "wav";
  const form = new FormData();
  form.append("file", new Blob([binary], { type: mimeType }), `audio.${ext}`);
  form.append("model", "whisper-large-v3");
  form.append("language", "fa");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`خطای Whisper: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return (data.text ?? "").trim();
}

// ---------- لایهٔ AI اصلی (رایگان — Gemini) ----------
async function analyzeWithGemini(
  combinedText: string,
  imageBase64: string | null,
  imageMimeType: string | null,
  allowedProfessions: string[],
) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY تنظیم نشده است.");

  const instruction = `
تو یک دستیار فنی برای عیب‌یابی اولیهٔ لوازم خانگی و خودرو هستی.
فقط یک JSON خام و معتبر برگردان (بدون Markdown، بدون توضیح اضافه) با این ساختار دقیق:
{
  "device_type": "نوع وسیله یا 'نامشخص'",
  "brand": "برند اگر از عکس قابل تشخیص بود، وگرنه 'نامشخص'",
  "model": "مدل اگر قابل تشخیص بود، وگرنه 'نامشخص'",
  "symptoms": ["علائم ذکرشده توسط کاربر"],
  "possible_problem": "توضیح کوتاه مشکل احتمالی، بدون ادعای تشخیص قطعی اگر مطمئن نیستی",
  "required_profession": "دقیقاً یکی از این مقادیر مجاز: ${allowedProfessions.join(" | ")}",
  "confidence": "low یا medium یا high"
}
اگر هیچ‌کدام از حرفه‌های مجاز مناسب نبود، نزدیک‌ترین مورد را انتخاب کن و confidence را low بگذار.
اگر مطمئن نیستی، صریحاً confidence پایین بگذار و در possible_problem عدم قطعیت را ذکر کن.

ورودی کاربر:
${combinedText}
`.trim();

  const parts: Record<string, unknown>[] = [{ text: instruction }];
  if (imageBase64 && imageMimeType) {
    parts.push({ inline_data: { mime_type: imageMimeType, data: imageBase64 } });
  }

  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.3 },
    }),
  });

  if (!resp.ok) throw new Error(`خطای Gemini: ${resp.status} — ${await resp.text()}`);
  const data = await resp.json();
  const rawText: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      device_type: "نامشخص",
      brand: "نامشخص",
      model: "نامشخص",
      symptoms: [],
      possible_problem: "پاسخ AI ساختاریافته نبود: " + rawText,
      required_profession: allowedProfessions[0] ?? "نامشخص",
      confidence: "low",
    };
  }
}

// ---------- Handler اصلی ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = body.action;

    // ---------- گرفتن لیست حرفه‌ها (برای فرم ثبت‌نام) ----------
    if (action === "professions") {
      const professions = await dbSelect("professions", "select=name&order=name");
      return json({ professions: professions.map((p: any) => p.name) });
    }

    // ---------- ثبت‌نام تعمیرکار جدید ----------
    if (action === "register") {
      const { name, phone, city, businessName, specialties } = body;
      if (!name || !city || !Array.isArray(specialties) || specialties.length === 0) {
        return json({ error: "نام، شهر و حداقل یک تخصص لازم است." }, 400);
      }
      const inserted = await dbInsert("professionals", {
        name,
        phone: phone || null,
        city,
        business_name: businessName || null,
        specialties,
      });
      return json({ professional: inserted[0] });
    }

    // ---------- تحلیل AI + تطبیق تعمیرکار ----------
    if (action === "analyze") {
      const { text, imageBase64, imageMimeType, audioBase64, audioMimeType, city } = body;

      if (!text && !imageBase64 && !audioBase64) {
        return json({ error: "حداقل یکی از متن/عکس/صدا لازم است." }, 400);
      }
      if (!city) {
        return json({ error: "شهر انتخاب نشده است." }, 400);
      }

      let transcribedVoiceText = "";
      if (audioBase64 && audioMimeType) {
        transcribedVoiceText = await transcribeAudio(audioBase64, audioMimeType);
      }

      const professionsRows = await dbSelect("professions", "select=name&order=name");
      const allowedProfessions: string[] = professionsRows.map((p: any) => p.name);

      const combinedTextParts: string[] = [];
      if (text) combinedTextParts.push(`متن کاربر: ${text}`);
      if (transcribedVoiceText) combinedTextParts.push(`متن استخراج‌شده از صدا: ${transcribedVoiceText}`);
      const combinedText = combinedTextParts.join("\n") || "کاربر فقط عکس فرستاده است.";

      const analysis = await analyzeWithGemini(
        combinedText,
        imageBase64 || null,
        imageMimeType || null,
        allowedProfessions,
      );

      // ---------- تطبیق واقعی با دیتابیس (نه if/else ثابت) ----------
      const encodedProfession = encodeURIComponent(`{${analysis.required_profession}}`);
      const encodedCity = encodeURIComponent(city);
      const matching = await dbSelect(
        "professionals",
        `select=*&specialties=cs.${encodedProfession}&city=eq.${encodedCity}`,
      );

      const allInCity = await dbSelect("professionals", `select=id&city=eq.${encodedCity}`);
      const filteredCount = allInCity.length - matching.length;

      return json({
        analysis,
        matchingProfessionals: matching,
        debug: {
          imageReceived: Boolean(imageBase64),
          audioReceived: Boolean(audioBase64),
          textReceived: Boolean(text),
          transcribedVoiceText: transcribedVoiceText || null,
          city,
          matchingCount: matching.length,
          filteredCount,
        },
      });
    }

    return json({ error: "action نامعتبر است." }, 400);
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
