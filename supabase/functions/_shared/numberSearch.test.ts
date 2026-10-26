// Unit tests for _shared/numberSearch.ts — searching for a number to buy by its area code, or by
// the area code and up to three more digits (the 2026-10-12 call).
//
// Deliberately dependency-free (no jsr:/npm: imports), the rule the other _shared tests follow.
//
// What matters, and why:
//   * what the box accepts: 3 to 6 digits however they are typed or pasted, nothing in between
//     quietly widened into a search somewhere else;
//   * what Twilio is sent: AreaCode = the first three digits and, only for a longer search, a
//     Contains pattern anchored to the START of the number ("+1" + the digits, Twilio's documented
//     "start with a pattern" form), with the "+" encoded so it doesn't arrive as a space;
//   * that a result which doesn't start with what was typed is never shown.
//
// No network: globalThis.fetch is a stub that records the request and answers like Twilio. Every
// SID, key and number is made up (555 numbers).
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/numberSearch.test.ts

import {
  NUMBER_SEARCH_AREA_SENTENCE, NUMBER_SEARCH_EXCHANGE_SENTENCE, NUMBER_SEARCH_LENGTH_SENTENCE, NUMBER_SEARCH_MAX_DIGITS,
  numberSearchOf, startsWithPrefix,
} from "./numberSearch.ts";
import { searchAvailableNumbers, type TrustHubCreds } from "./twilioTrustHub.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

Deno.test("an area code alone searches that area code, exactly as before", () => {
  assertEquals(numberSearchOf("555"), { ok: true, digits: "555", areaCode: "555", contains: null, prefix: "+1555" });
  assertEquals(numberSearchOf(" (555) "), { ok: true, digits: "555", areaCode: "555", contains: null, prefix: "+1555" });
});

Deno.test("the area code and up to three more digits: AreaCode plus a pattern anchored to the start", () => {
  assertEquals(numberSearchOf("555300"), { ok: true, digits: "555300", areaCode: "555", contains: "+1555300", prefix: "+1555300" });
  assertEquals(numberSearchOf("5553"), { ok: true, digits: "5553", areaCode: "555", contains: "+15553", prefix: "+15553" });
  assertEquals(numberSearchOf("55530"), { ok: true, digits: "55530", areaCode: "555", contains: "+155530", prefix: "+155530" });
  assertEquals(NUMBER_SEARCH_MAX_DIGITS, 6);
  // Twilio's pattern is 2 to 16 characters; the longest one sent is 8.
  const longest = numberSearchOf("555300");
  assert(longest.ok && longest.contains !== null && longest.contains.length <= 16, JSON.stringify(longest));
});

Deno.test("formatting is ignored, and a pasted +1 country code is not part of the search", () => {
  for (const typed of ["555-300", "(555) 300", "555.300", " 555 300 ", "+1 555 300", "1-555-300", "+1 (555) 300"]) {
    const q = numberSearchOf(typed);
    assert(q.ok && q.digits === "555300" && q.contains === "+1555300", `${typed} → ${JSON.stringify(q)}`);
  }
  const ac = numberSearchOf("+1 555");
  assert(ac.ok && ac.digits === "555" && ac.contains === null, JSON.stringify(ac));
});

Deno.test("nothing typed is a search anywhere in the US (the screen offers 'leave it empty')", () => {
  for (const empty of ["", "   ", "--", null, undefined]) {
    assertEquals(numberSearchOf(empty), { ok: true, digits: "", areaCode: null, contains: null, prefix: null }, String(empty));
  }
});

Deno.test("too few or too many digits are refused with a sentence, never widened into a different search", () => {
  for (const bad of ["5", "55", "5553001", "555300123", "5553001234"]) {
    assertEquals(numberSearchOf(bad), { ok: false, error: NUMBER_SEARCH_LENGTH_SENTENCE }, bad);
  }
  // A whole pasted number is more than the search takes; the screen trims it to six before sending.
  assertEquals(numberSearchOf("+1 (555) 300-0101"), { ok: false, error: NUMBER_SEARCH_LENGTH_SENTENCE });
});

Deno.test("a US area code starts 2-9, and so does the digit after it", () => {
  for (const bad of ["055", "155", "055300", "123"]) {
    assertEquals(numberSearchOf(bad), { ok: false, error: NUMBER_SEARCH_AREA_SENTENCE }, bad);
  }
  for (const bad of ["5550", "5551", "555100", "555012"]) {
    assertEquals(numberSearchOf(bad), { ok: false, error: NUMBER_SEARCH_EXCHANGE_SENTENCE }, bad);
  }
  // The screen shows these as they are, so each says what to try instead.
  assert(/816300/.test(NUMBER_SEARCH_LENGTH_SENTENCE) && /fewer digits/.test(NUMBER_SEARCH_EXCHANGE_SENTENCE));
});

Deno.test("only results that really start with the search are kept", () => {
  const list = [
    { phoneNumber: "+15553000101", region: "MO" },
    { phoneNumber: "+15553100102", region: "MO" },
    { phoneNumber: "+15550555300", region: "MO" }, // "555300" in the middle: not a match
    { phoneNumber: "+15553009999", region: null },
  ];
  assertEquals(startsWithPrefix(list, "+1555300").map((n) => n.phoneNumber), ["+15553000101", "+15553009999"]);
  assertEquals(startsWithPrefix(list, "+1555").length, 4, "an area code search keeps its area code");
  assertEquals(startsWithPrefix(list, null), list, "no search, no filter");
  assertEquals(startsWithPrefix([], "+1555300"), []);
});

// ── On the wire: what searchAvailableNumbers asks Twilio for ────────────────────────────────
const SUB: TrustHubCreds = { accountSid: "AC" + "5".repeat(32), user: "SK" + "5".repeat(32), pass: "subkeysecret" + "x".repeat(20) };

async function withTwilio(answer: string[], fn: (urls: string[]) => Promise<void>) {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const body = { available_phone_numbers: answer.map((n) => ({ phone_number: n, friendly_name: n, locality: null, region: "MO" })) };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("Twilio is asked for AreaCode and Contains=+1<digits>, the + sent as %2B", async () => {
  await withTwilio(["+15553000101", "+15559990102"], async (urls) => {
    const q = numberSearchOf("555-300");
    assert(q.ok);
    if (!q.ok) return;
    const found = await searchAvailableNumbers({ areaCode: q.areaCode ?? undefined, contains: q.contains ?? undefined, limit: 10 }, SUB);
    const u = new URL(urls[0]);
    assert(u.pathname.endsWith(`/Accounts/${SUB.accountSid}/AvailablePhoneNumbers/US/Local.json`), u.pathname);
    assertEquals(u.searchParams.get("AreaCode"), "555");
    assertEquals(u.searchParams.get("Contains"), "+1555300");
    assert(urls[0].includes("Contains=%2B1555300"), `the + must be encoded, or Twilio reads a space: ${urls[0]}`);
    assertEquals(u.searchParams.get("PageSize"), "10");
    // A stray result Twilio might hand back is dropped before the screen sees it.
    assertEquals(startsWithPrefix(found, q.prefix).map((n) => n.phoneNumber), ["+15553000101"]);
  });
});

Deno.test("an area code alone sends no Contains at all (the search it always was)", async () => {
  await withTwilio(["+15553000101"], async (urls) => {
    const q = numberSearchOf("555");
    assert(q.ok);
    if (!q.ok) return;
    await searchAvailableNumbers({ areaCode: q.areaCode ?? undefined, contains: q.contains ?? undefined, limit: 10 }, SUB);
    const u = new URL(urls[0]);
    assertEquals(u.searchParams.get("AreaCode"), "555");
    assertEquals(u.searchParams.has("Contains"), false);
  });
});
