// Workstream 2: every TrustHub / Messaging / numbers call runs as the ACCOUNT it is handed
// (twilioTrustHub.ts TrustHubCreds), and as the parent from the environment when handed none.
//
// What is pinned: the /Accounts/{sid} path AND the Basic pair on the wire, for each kind of export
// (an opts function, a positional one, the campaign writer that bypasses call(), the v1.2 read,
// the purchase that attaches through the bound transport, and trustHubHttp for the helpers that
// take `http`). A sub-account's resources are refused to the parent's key, so a request that
// carried the right path with the wrong pair (or the reverse) would fail only in production.
//
// No network: globalThis.fetch is a stub that records and answers like Twilio. Every SID, key and
// secret is made up. call() keeps its one-request-per-second throttle, so this file takes a few
// seconds on purpose rather than reaching into the module.
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/twilioTrustHubAccount.test.ts

import {
  attachNumberToService, createCampaign, fetchCampaign, findIncomingNumberSid, purchaseNumber, releaseNumber,
  searchAvailableNumbers, trustHubHttp, type TrustHubCreds,
} from "./twilioTrustHub.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const PARENT = "AC" + "0".repeat(32);
const PARENT_KEY = "SK" + "0".repeat(32);
const SUB: TrustHubCreds = { accountSid: "AC" + "5".repeat(32), user: "SK" + "5".repeat(32), pass: "subkeysecret" + "x".repeat(20) };
const SERVICE = "MG" + "5".repeat(32);
const NUMBER = "PN" + "5".repeat(32);
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

type Seen = { method: string; url: string; auth: string | null; version: string | null };

async function withTwilio(fn: (seen: Seen[]) => Promise<void>) {
  const env: Record<string, string> = { TWILIO_ACCOUNT_SID: PARENT, TWILIO_API_KEY: PARENT_KEY, TWILIO_API_SECRET: "parent-api-secret" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers);
    seen.push({ method: (init?.method ?? "GET").toUpperCase(), url, auth: h.get("authorization"), version: h.get("x-twilio-api-version") });
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }));
    if (url.includes("/AvailablePhoneNumbers/")) return json({ available_phone_numbers: [{ phone_number: "+15555550123", friendly_name: "(555) 555-0123" }] });
    if (url.endsWith("/IncomingPhoneNumbers.json")) return json({ sid: NUMBER, phone_number: "+15555550123" }, 201);
    if (url.includes("/IncomingPhoneNumbers.json?PhoneNumber=")) return json({ incoming_phone_numbers: [{ sid: NUMBER, phone_number: "+15555550123" }] });
    if (url.includes("/IncomingPhoneNumbers/")) return Promise.resolve(new Response(null, { status: 204 }));
    if (url.endsWith("/PhoneNumbers")) return json({ sid: NUMBER }, 201);
    if (url.includes("/Compliance/Usa2p")) {
      return json({ sid: "QE" + "5".repeat(32), campaign_status: "IN_PROGRESS", privacy_policy_url: "https://x.example.test/p", terms_and_conditions_url: "https://x.example.test/t", compliance: [] }, 201);
    }
    return json({ message: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("an /Accounts/{sid} export: the sub's path and the sub's pair; with no account, the parent's from the environment", async () => {
  await withTwilio(async (seen) => {
    await searchAvailableNumbers({ areaCode: "555", limit: 3 }, SUB);
    await searchAvailableNumbers({ areaCode: "555", limit: 3 });
    assert(seen[0].url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/AvailablePhoneNumbers/US/Local.json?`), seen[0].url);
    assertEquals(seen[0].auth, basic(SUB.user, SUB.pass));
    assert(seen[1].url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${PARENT}/AvailablePhoneNumbers/US/Local.json?`), seen[1].url);
    assertEquals(seen[1].auth, basic(PARENT_KEY, "parent-api-secret"), "no account = exactly the environment's pair, as before");
  });
});

Deno.test("purchaseNumber: bought in the sub AND attached to its Messaging Service with the sub's pair", async () => {
  await withTwilio(async (seen) => {
    await purchaseNumber({ phoneNumber: "+15555550123", clientId: "sub-builder", messagingServiceSid: SERVICE }, SUB);
    assertEquals(seen.map((s) => [s.method, s.url, s.auth]), [
      ["POST", `https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/IncomingPhoneNumbers.json`, basic(SUB.user, SUB.pass)],
      ["POST", `https://messaging.twilio.com/v1/Services/${SERVICE}/PhoneNumbers`, basic(SUB.user, SUB.pass)],
    ]);
    await releaseNumber(NUMBER, SUB);
    assertEquals([seen[2].method, seen[2].url, seen[2].auth],
      ["DELETE", `https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/IncomingPhoneNumbers/${NUMBER}.json`, basic(SUB.user, SUB.pass)]);
  });
});

Deno.test("the campaign writer (not call()) and the v1.2 read carry the sub's pair too", async () => {
  await withTwilio(async (seen) => {
    await createCampaign({
      serviceSid: SERVICE, brandSid: "BN" + "5".repeat(32), useCase: "MIXED",
      copy: { description: "d".repeat(50), messageFlow: "f".repeat(50), messageSamples: ["Sample one, reply STOP to opt out.", "Sample two, reply STOP to opt out."] },
      privacyPolicyUrl: "https://x.example.test/p", termsUrl: "https://x.example.test/t",
    }, SUB);
    await fetchCampaign(SERVICE, SUB);
    assertEquals(seen.map((s) => [s.method, s.url, s.auth, s.version]), [
      ["POST", `https://messaging.twilio.com/v1/Services/${SERVICE}/Compliance/Usa2p`, basic(SUB.user, SUB.pass), "v1.2"],
      ["GET", `https://messaging.twilio.com/v1/Services/${SERVICE}/Compliance/Usa2p`, basic(SUB.user, SUB.pass), "v1.2"],
    ]);
  });
});

Deno.test("trustHubHttp binds the `http` helpers to an account; null is the environment's transport", async () => {
  await withTwilio(async (seen) => {
    await attachNumberToService(SERVICE, NUMBER, trustHubHttp(SUB));
    assertEquals(await findIncomingNumberSid("+15555550123", trustHubHttp(SUB), SUB.accountSid), NUMBER);
    await attachNumberToService(SERVICE, NUMBER, trustHubHttp(null));
    assertEquals(seen.map((s) => s.auth), [basic(SUB.user, SUB.pass), basic(SUB.user, SUB.pass), basic(PARENT_KEY, "parent-api-secret")]);
    assert(seen[1].url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=`), seen[1].url);
  });
});
