// Supabase Edge Function: ai-test-lab-analyze
// مسیر فایل در پروژه Supabase شما: supabase/functions/ai-test-lab-analyze/index.ts
//
// این تابع روی سرور Supabase اجرا می‌شود، نه در مرورگر کاربر.
// کلیدهای API (ANTHROPIC_API_KEY و OPENAI_API_KEY) اینجا از Secrets خوانده می‌شوند
// و هرگز به Frontend فرستاده نمی‌شوند.
//
// نحوه تنظیم Secrets (از طریق داشبورد Supabase، بدون نیاز به کامپیوتر/CLI):
// Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets
//   ANTHROPIC_API_KEY = sk-ant-...
//   OPENAI_API_KEY   = sk-...   (فقط برای تبدیل صدا به متن با Whisper)

// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC_MODEL = "claude-sonnet-5"; // در صورت نیاز به مدل دیگر اینجا تغییر دهید

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { text, imageBase64, imageMimeType, audioBase64, audioMimeType } = body;

    // ---------- مرحله ۱: تبدیل صدا به متن (در صورت وجود) ----------
    // نکته مهم: Claude API به‌صورت مستقیم فایل صوتی را نمی‌پذیرد (فقط متن و تصویر).
    // به همین دلیل، اگر صدا ارسال شده باشد، اول با Whisper (OpenAI) به متن تبدیل می‌شود
    // و سپس همان متن به‌عنوان بخشی از پیام به Claude فرستاده می‌شود.
    let transcribedAudio = "";
    if (audioBase64) {
      if (!OPENAI_API_KEY) {
        return errorResponse(
          "برای تبدیل صدا به متن، کلید OPENAI_API_KEY تنظیم نشده است. " +
          "یا این کلید را در Secrets پروژه اضافه کنید، یا فعلاً بدون صدا تست کنید.",
          400
        );
      }
      transcribedAudio = await transcribeAudio(audioBase64, audioMimeType);
    }

    // ---------- مرحله ۲: ساخت پیام برای Claude ----------
    if (!ANTHROPIC_API_KEY) {
      return errorResponse("کلید ANTHROPIC_API_KEY در Secrets تنظیم نشده است.", 400);
    }

    const combinedTextParts: string[] = [];
    if (text) combinedTextParts.push(`متن کاربر: ${text}`);
    if (transcribedAudio) combinedTextParts.push(`متن استخراج‌شده از صدای کاربر: ${transcribedAudio}`);
    const combinedText = combinedTextParts.length
      ? combinedTextParts.join("\n")
      : "کاربر فقط عکس ارسال کرده و توضیح متنی یا صوتی نداده است.";

    const systemPrompt = `تو یک دستیار فنی هستی که به کاربران در تشخیص اولیه مشکلات لوازم خانگی کمک می‌کنی.
فقط و فقط یک آبجکت JSON معتبر برگردان، بدون هیچ متن اضافه، بدون backtick و بدون توضیح قبل یا بعد آن.
ساختار دقیق JSON باید این باشد:
{
  "device": "نام وسیله شناسایی‌شده یا 'مشخص نشد'",
  "brand_model": "برند/مدل در صورت تشخیص از عکس، در غیر این صورت 'تشخیص داده نشد'",
  "probable_issue": "توضیح کوتاه مشکل احتمالی",
  "confidence": "کم" یا "متوسط" یا "زیاد",
  "safe_suggestions": ["اقدام بی‌خطر ۱", "اقدام بی‌خطر ۲"],
  "safety_warning": "در صورت وجود خطر برق/گاز/فشار/قطعات متحرک/باز کردن دستگاه، هشدار واضح و ارجاع به تعمیرکار؛ در غیر این صورت null",
  "full_response": "پاسخ کامل و طبیعی به زبان فارسی خطاب به کاربر"
}
فقط اقدامات کاملاً بی‌خطر و قابل انجام توسط خود کاربر را در safe_suggestions پیشنهاد بده.`;

    const userContent: any[] = [];
    if (imageBase64) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: imageMimeType || "image/jpeg",
          data: imageBase64,
        },
      });
    }
    userContent.push({ type: "text", text: combinedText });

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      return errorResponse(`خطا از Claude API: ${claudeResp.status} — ${errText}`, 502);
    }

    const claudeData = await claudeResp.json();
    const rawText = (claudeData.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    let parsed: any;
    try {
      const cleaned = rawText.replace(/^```json\s*|```\s*$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // اگر Claude دقیقاً JSON برنگرداند، حداقل پاسخ خام را برمی‌گردانیم
      parsed = {
        device: "مشخص نشد",
        brand_model: "تشخیص داده نشد",
        probable_issue: "—",
        confidence: "کم",
        safe_suggestions: [],
        safety_warning: null,
        full_response: rawText,
      };
    }

    parsed.transcribed_audio = transcribedAudio || null;

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return errorResponse("خطای داخلی سرور: " + err.message, 500);
  }
});

async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const binary = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  const ext = (mimeType || "").includes("mp4") ? "m4a" : "webm";
  const blob = new Blob([binary], { type: mimeType || "audio/mp4" });

  const form = new FormData();
  form.append("file", blob, `voice.${ext}`);
  form.append("model", "whisper-1");
  form.append("language", "fa");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`خطا در تبدیل صدا به متن (Whisper): ${resp.status} — ${errText}`);
  }
  const data = await resp.json();
  return data.text || "";
}

function errorResponse(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
