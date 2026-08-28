// Offline unit tests for the SMS transport's pure parts. No `jsr:`/`npm:` imports, so the
// preflight gate's self-contained group picks these up and they pass on a machine with no
// registry access.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  smsPhoneKey, isDamagedPhoneKey, smsE164US, smsSegments, validateTwilioSignature,
} from "./twilioSms.ts";

Deno.test("smsPhoneKey matches crm_phone_key: 11 digits leading 1 loses the 1", () => {
  assertEquals(smsPhoneKey("+1 816 300 9111"), "8163009111");
  assertEquals(smsPhoneKey("18163009111"), "8163009111");
  assertEquals(smsPhoneKey("(816) 300-9111"), "8163009111");
  assertEquals(smsPhoneKey("816.300.9111"), "8163009111");
});

Deno.test("smsPhoneKey leaves a plain 10-digit number alone", () => {
  assertEquals(smsPhoneKey("8163009111"), "8163009111");
});

Deno.test("isDamagedPhoneKey catches the truncated +1 shape and nothing else", () => {
  // The formatter bug fixed 2026-08-25: "+1 707 362 5667" -> 17073625667 -> sliced to 10 ->
  // "1707362566", last digit destroyed. No NANP area code starts with 1, so this shape is
  // provably not a real number.
  assert(isDamagedPhoneKey("1707362566"));
  assert(!isDamagedPhoneKey("8163009111"));
  assert(!isDamagedPhoneKey("17073625667")); // 11 digits — smsPhoneKey strips this first
  assert(!isDamagedPhoneKey(""));
});

Deno.test("smsE164US accepts only the two US shapes", () => {
  assertEquals(smsE164US("8163009111"), "+18163009111");
  assertEquals(smsE164US("18163009111"), "+18163009111");
  assertEquals(smsE164US("816300911"), null);   // too short
  assertEquals(smsE164US("448163009111"), null); // not US
  assertEquals(smsE164US(""), null);
});

Deno.test("smsSegments: GSM-7 boundaries", () => {
  assertEquals(smsSegments("").segments, 0);
  assertEquals(smsSegments("a".repeat(160)).segments, 1);
  // Past 160 the message is concatenated, and each part loses 7 chars to the UDH header.
  assertEquals(smsSegments("a".repeat(161)).segments, 2);
  assertEquals(smsSegments("a".repeat(306)).segments, 2);
  assertEquals(smsSegments("a".repeat(307)).segments, 3);
});

Deno.test("smsSegments: one non-GSM character halves the budget", () => {
  // A curly apostrophe is the realistic case — it arrives by paste from Word or a phone
  // keyboard and turns a one-segment message into two without anybody typing more.
  const s = "a".repeat(100) + "’";
  assert(smsSegments(s).unicode);
  assertEquals(smsSegments(s).segments, 2);
  assert(!smsSegments("a".repeat(100)).unicode);
  assertEquals(smsSegments("a".repeat(100)).segments, 1);
});

Deno.test("validateTwilioSignature refuses when no auth token is set", async () => {
  const had = Deno.env.get("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  try {
    assertEquals(await validateTwilioSignature("https://x/y", { A: "1" }, "sig"), false);
  } finally {
    if (had !== undefined) Deno.env.set("TWILIO_AUTH_TOKEN", had);
  }
});

Deno.test("validateTwilioSignature accepts a correctly-signed request and rejects tampering", async () => {
  const had = Deno.env.get("TWILIO_AUTH_TOKEN");
  Deno.env.set("TWILIO_AUTH_TOKEN", "test-token");
  try {
    const url = "https://example.supabase.co/functions/v1/sms-inbound?key=s3cret";
    const params = { To: "+18160000001", From: "+18163009111", Body: "hello" };
    // Recompute the signature the way Twilio does: sorted keys, key then value, appended.
    const data = url + Object.keys(params).sort().map((k) => k + (params as Record<string, string>)[k]).join("");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("test-token"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const sig = btoa(String.fromCharCode(...new Uint8Array(mac)));

    assert(await validateTwilioSignature(url, params, sig));
    // A changed body must invalidate it — this is the whole point of the check.
    assert(!await validateTwilioSignature(url, { ...params, Body: "goodbye" }, sig));
    // A different URL must too: the signature is over the URL Twilio was configured with.
    assert(!await validateTwilioSignature(url + "x", params, sig));
  } finally {
    if (had === undefined) Deno.env.delete("TWILIO_AUTH_TOKEN"); else Deno.env.set("TWILIO_AUTH_TOKEN", had);
  }
});
