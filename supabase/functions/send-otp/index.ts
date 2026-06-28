// supabase/functions/send-otp/index.ts
//
// Generates a 6-digit OTP, stores its SHA-256 hash in `otp_codes`,
// and sends it to the user's phone via the BulkSMS API.
//
// Required secrets (set with `supabase secrets set`):
//   SUPABASE_URL              (auto-provided by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided by Supabase)
//   BULKSMS_TOKEN_ID
//   BULKSMS_TOKEN_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Normalise a SA number like "0821234567" or "+27821234567" to "27821234567"
// (the format BulkSMS expects, no leading +)
function normalisePhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-()]/g, "");
  if (digits.startsWith("+27")) digits = digits.slice(1);
  else if (digits.startsWith("0")) digits = "27" + digits.slice(1);
  else if (digits.startsWith("27")) {
    // already fine
  } else {
    return null;
  }
  return /^27\d{9}$/.test(digits) ? digits : null;
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    console.log("send-otp: request received");
    const { phone } = await req.json();
    console.log("send-otp: parsed phone =", phone);
    if (!phone || typeof phone !== "string") {
      return jsonResponse({ ok: false, error: "Phone number is required." }, 400);
    }

    const normalised = normalisePhone(phone);
    console.log("send-otp: normalised =", normalised);
    if (!normalised) {
      return jsonResponse({ ok: false, error: "Please enter a valid South African cell number." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    console.log("send-otp: supabase client created");

    // Reliable existence check: query profiles table by phone.
    const { data: profile, error: profileLookupError } = await supabase
      .from("profiles")
      .select("id")
      .eq("phone", phone.trim())
      .maybeSingle();

    console.log("send-otp: profile lookup =", JSON.stringify(profile), "error =", profileLookupError?.message);

    if (!profile) {
      console.log("send-otp: no matching profile, returning ok without sending");
      return jsonResponse({ ok: true }); // caller proceeds to OTP screen either way
    }

    // Rate-limit: don't allow more than 1 code every 60s per phone
    const { data: recent } = await supabase
      .from("otp_codes")
      .select("created_at")
      .eq("phone", phone.trim())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log("send-otp: rate-limit check, recent =", JSON.stringify(recent));

    if (recent && Date.now() - new Date(recent.created_at).getTime() < 60_000) {
      return jsonResponse({ ok: false, error: "Please wait a minute before requesting another code." }, 429);
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await sha256(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Remove any older codes for this phone, then insert the fresh one
    await supabase.from("otp_codes").delete().eq("phone", phone.trim());
    const { error: insertError } = await supabase.from("otp_codes").insert({
      phone: phone.trim(),
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (insertError) {
      console.error("otp insert error:", insertError.message);
      return jsonResponse({ ok: false, error: "Could not generate code. Please try again." }, 500);
    }
    console.log("send-otp: code stored, calling BulkSMS now. code (debug only) =", code);

    // ── Send via BulkSMS ──────────────────────────────────────────────────
    const tokenId = Deno.env.get("BULKSMS_TOKEN_ID")!;
    const tokenSecret = Deno.env.get("BULKSMS_TOKEN_SECRET")!;
    console.log("send-otp: tokenId present =", !!tokenId, "tokenSecret present =", !!tokenSecret);
    const basicAuth = btoa(`${tokenId}:${tokenSecret}`);

    let smsResp: Response;
    try {
      smsResp = await fetch("https://api.bulksms.com/v1/messages", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{
          to: normalised,
          body: `Your Phunya Tsela password reset code is ${code}. It expires in 10 minutes.`,
        }]),
      });
    } catch (fetchErr) {
      console.error("send-otp: BulkSMS fetch threw:", fetchErr);
      return jsonResponse({ ok: false, error: "Could not reach SMS provider. Please try again." }, 502);
    }

    console.log("send-otp: BulkSMS response status =", smsResp.status);

    if (!smsResp.ok) {
      const errText = await smsResp.text();
      console.error("send-otp: BulkSMS error body:", errText);
      return jsonResponse({ ok: false, error: "Could not send SMS. Please try again." }, 502);
    }

    const smsJson = await smsResp.json();
    console.log("send-otp: BulkSMS success body =", JSON.stringify(smsJson));

    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("send-otp exception:", e);
    return jsonResponse({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
});