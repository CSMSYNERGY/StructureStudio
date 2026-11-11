/**
 * Which configuration set an email leaves through on Amazon SES (mailTransport.ts).
 *
 * WHY THIS EXISTS (2026-11-11). SES adds its open-tracking image to EVERY email sent through a
 * configuration set that counts opens; there is no per-email switch. So "does this email carry
 * the image" is decided by which set it goes through, and that is decided in exactly two
 * places: sendMail (a builder's emails, the default set) and sendPlatformMail (login codes,
 * receipts, team notices: the platform set when one is named). A slip here is invisible on
 * every screen: the email arrives either way. These tests are the only place it shows.
 *
 * `fetch` is stubbed: no network, no AWS, no Resend.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/mailTransport.test.ts
 * (the pre-push gate discovers _shared/*.test.ts automatically: see scripts/preflight.mjs)
 */

import { defaultTransport, sendMail, sendPlatformMail, type MailInput } from "./mailTransport.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}` + (msg ? ` (${msg})` : ""));
}

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
const realFetch = globalThis.fetch;
function stub(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")), headers });
    const answer = String(input).includes("amazonaws.com") ? { MessageId: "ses-id" } : { id: "resend-id" };
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return calls;
}

const ENV = [
  "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_SESSION_TOKEN", "SES_REGION", "SES_CONFIGURATION_SET",
  "SES_PLATFORM_CONFIGURATION_SET", "SES_OPEN_TRACKING", "EMAIL_DEFAULT_TRANSPORT", "RESEND_API_KEY",
];
function setup(env: Record<string, string>) {
  for (const k of ENV) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
}
function teardown() {
  for (const k of ENV) Deno.env.delete(k);
  globalThis.fetch = realFetch;
}

const SES_KEY = { SES_ACCESS_KEY_ID: "AKIDEXAMPLE", SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const MAIL: MailInput = {
  from: "StructureStudio <no-reply@mail.example.com>", to: "customer@example.org",
  subject: "Your sign-in code", html: "<p>123456</p>", idempotencyKey: "resend-only-key",
  tags: [{ name: "kind", value: "login_code" }],
};

Deno.test("a platform email goes through the platform set when one is named; a builder's email stays on the default set", async () => {
  setup({ ...SES_KEY, EMAIL_DEFAULT_TRANSPORT: "ses", SES_PLATFORM_CONFIGURATION_SET: "ss-platform" });
  const calls = stub();
  try {
    assertEquals(defaultTransport(), "ses");
    assertEquals(await sendPlatformMail(MAIL), { id: "ses-id" });
    assertEquals(await sendMail("ses", MAIL), { id: "ses-id" });
    assertEquals(calls.map((c) => c.body.ConfigurationSetName), ["ss-platform", "ss-default"]);
    // The set is the ONLY difference between the two requests.
    const [platform, builder] = calls.map((c) => ({ ...c.body, ConfigurationSetName: null }));
    assertEquals(platform, builder);
    // And Resend's key never reaches SES on either path.
    assert(!JSON.stringify(calls.map((c) => [c.body, c.headers])).includes("resend-only-key"), "the Idempotency-Key stays behind");
  } finally { teardown(); }
});

Deno.test("with no platform set named, a platform email is sent exactly as a builder's is", async () => {
  const cases: Record<string, string>[] = [{}, { SES_PLATFORM_CONFIGURATION_SET: "" }, { SES_PLATFORM_CONFIGURATION_SET: "not a name" }, { SES_PLATFORM_CONFIGURATION_SET: "ss-default" }];
  for (const extra of cases) {
    setup({ ...SES_KEY, EMAIL_DEFAULT_TRANSPORT: "ses", ...extra });
    const calls = stub();
    try {
      await sendPlatformMail(MAIL);
      await sendMail("ses", MAIL);
      assertEquals(calls[0].body, calls[1].body, JSON.stringify(extra));
      assertEquals(calls[0].body.ConfigurationSetName, "ss-default");
    } finally { teardown(); }
  }
});

Deno.test("on Resend the platform set is never read: the request is Resend's, key and all", async () => {
  // The default is Resend (the setting is absent), though SES is configured and a set is named.
  setup({ ...SES_KEY, RESEND_API_KEY: "re_test_key", SES_PLATFORM_CONFIGURATION_SET: "ss-platform" });
  const calls = stub();
  try {
    assertEquals(defaultTransport(), "resend");
    assertEquals(await sendPlatformMail(MAIL), { id: "resend-id" });
    assertEquals(calls.length, 1);
    assert(calls[0].url.startsWith("https://api.resend.com/"), "it went to Resend");
    assert(!("ConfigurationSetName" in calls[0].body) && !("configurationSet" in calls[0].body), "no SES field leaks into Resend's body");
    assertEquals(calls[0].headers["idempotency-key"], "resend-only-key");
  } finally { teardown(); }
});

Deno.test("a platform set that SES refuses still delivers the platform email, through the default set", async () => {
  setup({ ...SES_KEY, EMAIL_DEFAULT_TRANSPORT: "ses", SES_PLATFORM_CONFIGURATION_SET: "ss-platform" });
  const sets: unknown[] = [];
  const warn = console.warn;
  console.warn = () => {};
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sets.push(body.ConfigurationSetName);
    return Promise.resolve(body.ConfigurationSetName === "ss-platform"
      ? new Response(JSON.stringify({ message: "User is not authorized" }), { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException" } })
      : new Response(JSON.stringify({ MessageId: "went" }), { status: 200 }));
  }) as typeof fetch;
  try {
    assertEquals(await sendPlatformMail(MAIL), { id: "went" });
    assertEquals(sets, ["ss-platform", "ss-default"]);
  } finally { console.warn = warn; teardown(); }
});
