// My Synergy Phone plan phase 6 — the calling-only number and "Connect this number for calls"
// (supabase/functions/portal-settings/phoneNumber.ts, and its wiring in index.ts).
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env tests/phone/
// (--allow-env: the test of the SHARED purchase helper sets its credentials; without it that one
// test is reported as ignored, not passed.)
//
// ⚠️ NOTHING HERE REACHES TWILIO. Every Twilio call goes to a stub fetch that records what it was
// asked and answers like Twilio would; the one test that drives the SHARED purchase helper
// (_shared/twilioTrustHub.ts purchaseNumber) swaps globalThis.fetch for the same stub and puts
// it back. Nothing is bought, configured or read. Fixtures are fake (555-01xx, PN00…, AC00…).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applyNumberVoice, areaCodeOf, buyCallingNumber, callingOnlyNumberRow, DEFAULT_PHONE_API_BASE, fallbackUrlOf, findNumberSid, numberActionForSwitch,
  numberHoldKey, numberSmsConfig, numberVoiceConfig, numberVoicemailConfig, pickedNumber, pickOrphan, smsInboundUrl, strictEncode,
  SWITCH_WARNINGS, switchCalling, voiceEnv, type Bought, type HoldResult,
} from "../../supabase/functions/portal-settings/phoneNumber.ts";
// Workstream 2 phase 2 moved phoneNumber.ts's copy of the credentials (twilioCreds) into the shared
// resolver as parentCreds; portal-settings resolves the tenant's account from there.
import { parentCreds } from "../../supabase/functions/_shared/twilioAccount.ts";

const SRC = (await Deno.readTextFile(new URL("../../supabase/functions/portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const WORKER_URLS = (await Deno.readTextFile(new URL("../../workers/phone-api/src/urls.ts", import.meta.url))).replace(/\r\n/g, "\n");
const PORTAL_SMS = (await Deno.readTextFile(new URL("../../supabase/functions/portal-sms/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const SMS_INBOUND = (await Deno.readTextFile(new URL("../../supabase/functions/sms-inbound/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`phoneNumber_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const SECRET = "abc123DEF456abc123DEF456";
const env = (m: Record<string, string>) => (k: string) => m[k];
const PN = "PN00000000000000000000000000000001";
const CREDS = { accountSid: "AC00000000000000000000000000000000", user: "SK00000000000000000000000000000000", pass: "not-a-real-secret" };

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
function stubFetch(answer: (s: Seen) => { status?: number; body: unknown }, seen: Seen[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(input), method: String(init?.method ?? "GET"),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(s);
    const a = answer(s);
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
}

// ── the environment ────────────────────────────────────────────────────────────────────────
Deno.test("voiceEnv: the Worker base defaults to the SPEC's address; the secret and the fallback are required", () => {
  const ok = voiceEnv(env({ PHONE_WEBHOOK_SECRET: SECRET, PHONE_FALLBACK_URL: "https://handler.example.test/bin" }));
  assert(ok.ok);
  assertEquals(ok.ok && ok.env.apiBase, DEFAULT_PHONE_API_BASE);
  assertEquals(DEFAULT_PHONE_API_BASE, "https://phone.structurestudiosuite.com");
  const trimmed = voiceEnv(env({ PHONE_API_BASE: "https://phone-api.example.test///", PHONE_WEBHOOK_SECRET: SECRET, PHONE_FALLBACK_URL: "https://handler.example.test/bin" }));
  assertEquals(trimmed.ok && trimmed.env.apiBase, "https://phone-api.example.test");
  const none = voiceEnv(env({}));
  assertEquals(!none.ok && none.missing, ["PHONE_WEBHOOK_SECRET", "PHONE_FALLBACK_URL"]);
  const http = voiceEnv(env({ PHONE_API_BASE: "http://phone.example.test", PHONE_WEBHOOK_SECRET: SECRET, PHONE_FALLBACK_URL: "http://x.example.test" }));
  assertEquals(!http.ok && http.missing, ["PHONE_API_BASE", "PHONE_FALLBACK_URL"]);
});

Deno.test("numberVoiceConfig is SETUP.md step 6, in the Worker's own URL shape", () => {
  const ve = voiceEnv(env({ PHONE_API_BASE: "https://phone-api.example.test", PHONE_WEBHOOK_SECRET: SECRET, PHONE_FALLBACK_URL: "https://handler.example.test/bin" }));
  assert(ve.ok);
  if (!ve.ok) return;
  assertEquals(numberVoiceConfig(ve.env), {
    VoiceUrl: `https://phone-api.example.test/voice/inbound?key=${SECRET}`,
    VoiceMethod: "POST",
    StatusCallback: `https://phone-api.example.test/voice/status?leg=pstn&key=${SECRET}`,
    StatusCallbackMethod: "POST",
    VoiceFallbackUrl: "https://handler.example.test/bin",
    VoiceFallbackMethod: "POST",
  });
  // The Worker validates X-Twilio-Signature against the URL it receives, so the encoding must be
  // the Worker's byte for byte (workers/phone-api/src/urls.ts).
  assert(WORKER_URLS.includes("encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)"),
    "the Worker's strictEncode changed; copy it here again");
  assertEquals(strictEncode("a b!'()*"), "a%20b%21%27%28%29%2A");
  const odd = numberVoiceConfig({ apiBase: "https://p.example.test", secret: "k'y", fallbackUrl: "https://f.example.test" });
  assertEquals(odd.VoiceUrl, "https://p.example.test/voice/inbound?key=k%27y");
});

Deno.test("parentCreds prefers an API key pair, like twilioTrustHub's basicAuthPair", () => {
  assertEquals(parentCreds(env({})), null);
  assertEquals(parentCreds(env({ TWILIO_ACCOUNT_SID: "AC1" })), null);
  assertEquals(parentCreds(env({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" })), { accountSid: "AC1", user: "AC1", pass: "t" });
  assertEquals(parentCreds(env({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_API_KEY: "SK1", TWILIO_API_SECRET: "s" })), { accountSid: "AC1", user: "SK1", pass: "s" });
});

// ── the two Twilio calls, against a stub ───────────────────────────────────────────────────
Deno.test("applyNumberVoice POSTs the voice settings to that number, authenticated, and nothing else", async () => {
  const seen: Seen[] = [];
  const config = numberVoiceConfig({ apiBase: "https://p.example.test", secret: SECRET, fallbackUrl: "https://f.example.test/bin" });
  const r = await applyNumberVoice({ creds: CREDS, numberSid: PN, config, fetchImpl: stubFetch(() => ({ body: { sid: PN } }), seen) });
  assertEquals(r, { ok: true });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].method, "POST");
  assertEquals(seen[0].url, `https://api.twilio.com/2010-04-01/Accounts/${CREDS.accountSid}/IncomingPhoneNumbers/${PN}.json`);
  assertEquals(seen[0].headers.Authorization, `Basic ${btoa(`${CREDS.user}:${CREDS.pass}`)}`);
  const form = Object.fromEntries(new URLSearchParams(seen[0].body));
  assertEquals(form, config);
  // No messaging field is ever sent: texts stay on sms-inbound / sms-status.
  assert(!Object.keys(form).some((k) => /^Sms/.test(k)));
});

Deno.test("applyNumberVoice: a malformed sid never reaches Twilio; a Twilio refusal comes back as codes only", async () => {
  const seen: Seen[] = [];
  const f = stubFetch(() => ({ status: 400, body: { code: 21402, message: `echo of VoiceUrl=...key=${SECRET}` } }), seen);
  assertEquals(await applyNumberVoice({ creds: CREDS, numberSid: "PN-nope", config: {}, fetchImpl: f }), { ok: false, status: 400, code: 0 });
  assertEquals(seen.length, 0);
  const r = await applyNumberVoice({ creds: CREDS, numberSid: PN, config: { VoiceUrl: "x" }, fetchImpl: f });
  assertEquals(r, { ok: false, status: 400, code: 21402 });
  assert(!JSON.stringify(r).includes(SECRET), "Twilio's body echoes the secret; it must not come back");
  const down = await applyNumberVoice({ creds: CREDS, numberSid: PN, config: {}, fetchImpl: (() => Promise.reject(new Error("offline"))) as typeof fetch });
  assertEquals(down, { ok: false, status: 0, code: 0 });
});

Deno.test("findNumberSid finds a hand-bought number's sid by its E.164", async () => {
  const seen: Seen[] = [];
  const f = stubFetch(() => ({ body: { incoming_phone_numbers: [{ sid: PN, phone_number: "+15555550100" }] } }), seen);
  assertEquals(await findNumberSid({ creds: CREDS, e164: "+15555550100", fetchImpl: f }), { ok: true, sid: PN });
  assert(seen[0].url.endsWith("/IncomingPhoneNumbers.json?PhoneNumber=%2B15555550100&PageSize=5") && seen[0].method === "GET");
  const none = stubFetch(() => ({ body: { incoming_phone_numbers: [] } }), []);
  assertEquals(await findNumberSid({ creds: CREDS, e164: "+15555550101", fetchImpl: none }), { ok: true, sid: null });
});

// ── the calling-only purchase ──────────────────────────────────────────────────────────────
// A stub of everything buyCallingNumber touches, recording the order things happened in.
function buyWorld(o: {
  twilioHas?: Bought[]; hold?: HoldResult; purchaseFails?: boolean; recordFails?: boolean; releaseFails?: boolean;
} = {}) {
  const log: string[] = [];
  const deps = {
    findPurchasedNumbers: (cid: string) => { log.push(`find:${cid}`); return Promise.resolve(o.twilioHas ?? []); },
    purchaseNumber: (x: { phoneNumber: string; clientId: string }) => {
      log.push(`buy:${x.phoneNumber}:${JSON.stringify(Object.keys(x).sort())}`);
      return o.purchaseFails ? Promise.reject(new Error("21422 not available")) : Promise.resolve({ sid: "PN00000000000000000000000000000099", phoneNumber: x.phoneNumber });
    },
    releaseNumber: (sid: string) => { log.push(`release-number:${sid}`); return o.releaseFails ? Promise.reject(new Error("down")) : Promise.resolve(); },
    hold: (idem: string): Promise<HoldResult> => { log.push(`hold:${idem}`); return Promise.resolve(o.hold ?? { ok: true, holdId: 7 }); },
    capture: (id: number, b: Bought) => { log.push(`capture:${id}:${b.phoneNumber}`); return Promise.resolve(); },
    releaseHold: (id: number, why: string) => { log.push(`release-hold:${id}:${why}`); return Promise.resolve(); },
    record: (b: Bought) => {
      log.push(`record:${b.phoneNumber}`);
      return Promise.resolve(o.recordFails
        ? { ok: false as const, error: { code: "57014" } }
        : { ok: true as const, row: { id: "row-1", phone_number: b.phoneNumber, twilio_sid: b.sid } });
    },
  };
  return { log, deps };
}
const ORPHAN = { sid: PN, phoneNumber: "+15555550101" };

Deno.test("buy: a fresh number is held, bought with NO messaging service, recorded, then captured — in that order", async () => {
  const w = buyWorld();
  const out = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550102" }, w.deps);
  assert(out.ok);
  assertEquals(out.ok && [out.reconciled, out.adoptedInstead, out.row.phone_number], [false, false, "+15555550102"]);
  assertEquals(w.log, [
    "find:demo-tenant",
    "hold:sms_num:demo-tenant:+15555550102",          // portal-sms's own meter key, so a retry is one hold
    'buy:+15555550102:["clientId","phoneNumber"]',     // no messagingServiceSid, ever
    "record:+15555550102",
    "capture:7:+15555550102",
  ]);
  assertEquals(numberHoldKey("demo-tenant", "+15555550102"), "sms_num:demo-tenant:+15555550102");
});

Deno.test("buy (review SSB-4): an earlier purchase that was never recorded is ADOPTED even when the builder picked a different number", async () => {
  const w = buyWorld({ twilioHas: [ORPHAN] });
  const out = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550102" }, w.deps);
  assert(out.ok);
  assertEquals(out.ok && [out.bought.phoneNumber, out.reconciled, out.adoptedInstead], ["+15555550101", true, true]);
  assert(!w.log.some((l) => l.startsWith("buy:")), "nothing new is rented while an unrecorded number exists");
  assert(w.log.includes("hold:sms_num:demo-tenant:+15555550101"), "the hold is keyed on the number KEPT, so a captured earlier hold replays instead of charging twice");
  // The pick wins when it is among them; junk rows are ignored.
  assertEquals(pickOrphan([ORPHAN, { sid: "PNx", phoneNumber: "+15555550102" }], "+15555550102")?.phoneNumber, "+15555550102");
  assertEquals(pickOrphan([{ sid: "", phoneNumber: "+15555550103" }, { sid: "PNy", phoneNumber: "" }], "+15555550103"), null);
});

Deno.test("buy (review SSB-4): a fresh number whose row fails is RELEASED at Twilio and its hold let go — nothing stays rented unrecorded", async () => {
  const w = buyWorld({ recordFails: true });
  const out = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550104" }, w.deps);
  assert(!out.ok && out.kind === "record_failed");
  assertEquals(!out.ok && out.kind === "record_failed" && out.releasedAtTwilio, true);
  assert(w.log.includes("release-number:PN00000000000000000000000000000099"));
  assert(w.log.some((l) => l.startsWith("release-hold:7:")));
  assert(!w.log.some((l) => l.startsWith("capture:")), "nothing is charged for a number we gave back");
});

Deno.test("buy: if Twilio will not take the number back either, it is left under FriendlyName for the next press to adopt — never released if it was ADOPTED", async () => {
  const w = buyWorld({ recordFails: true, releaseFails: true });
  const out = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550105" }, w.deps);
  assertEquals(!out.ok && out.kind === "record_failed" && out.releasedAtTwilio, false);
  // An adopted number may be the only copy of an earlier purchase: it is never released here.
  const a = buyWorld({ twilioHas: [ORPHAN], recordFails: true });
  const aOut = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550101" }, a.deps);
  assert(!aOut.ok && aOut.kind === "record_failed");
  assert(!a.log.some((l) => l.startsWith("release-number:")), "an adopted number stays ours");
});

Deno.test("buy: a refused hold buys nothing; a failed purchase lets the hold go; hold_replayed (holdId null) buys unbilled", async () => {
  const broke = buyWorld({ hold: { ok: false, status: 402, body: { error: "no funds", code: "insufficient_funds" } } });
  const r1 = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550106" }, broke.deps);
  assertEquals(!r1.ok && r1.kind === "refused" && r1.status, 402);
  assert(!broke.log.some((l) => l.startsWith("buy:") || l.startsWith("record:")));
  const taken = buyWorld({ purchaseFails: true });
  const r2 = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550107" }, taken.deps);
  assertEquals(!r2.ok && r2.kind, "purchase_failed");
  assert(taken.log.includes("release-hold:7:number purchase failed"));
  const free = buyWorld({ hold: { ok: true, holdId: null } });
  const r3 = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550108" }, free.deps);
  assert(r3.ok && !free.log.some((l) => l.startsWith("capture:") || l.startsWith("release-hold:")), "no hold id, nothing to settle");
  const lost = buyWorld();
  lost.deps.findPurchasedNumbers = () => Promise.reject(new Error("Twilio 503"));
  const r4 = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550109" }, lost.deps);
  assertEquals(!r4.ok && r4.kind, "lookup_failed");
  assert(!lost.log.some((l) => l.startsWith("hold:")), "if we cannot see what is already rented, nothing is held or bought");
});

// Needs --allow-env (the shared helper reads its credentials from the environment); without it
// the test is reported as ignored rather than passing vacuously.
const ENV_OK = Deno.permissions.querySync({ name: "env" }).state === "granted";
Deno.test({ name: "the SHARED purchaseNumber, driven with no messaging service, makes exactly one Twilio call (stubbed)", ignore: !ENV_OK, fn: async () => {
  const { purchaseNumber } = await import("../../supabase/functions/_shared/twilioTrustHub.ts");
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  const had = { sid: Deno.env.get("TWILIO_ACCOUNT_SID"), key: Deno.env.get("TWILIO_API_KEY"), secret: Deno.env.get("TWILIO_API_SECRET") };
  Deno.env.set("TWILIO_ACCOUNT_SID", CREDS.accountSid);
  Deno.env.set("TWILIO_API_KEY", CREDS.user);
  Deno.env.set("TWILIO_API_SECRET", CREDS.pass);
  globalThis.fetch = stubFetch((s) => ({ status: 201, body: s.method === "POST" ? { sid: PN, phone_number: "+15555550103" } : {} }), seen);
  try {
    const r = await purchaseNumber({ phoneNumber: "+15555550103", clientId: "demo-tenant" });
    assertEquals(r, { sid: PN, phoneNumber: "+15555550103" });
    assertEquals(seen.length, 1, "no messaging-service attach call when none is given");
    assert(seen[0].url.endsWith("/IncomingPhoneNumbers.json"));
    assertEquals(Object.fromEntries(new URLSearchParams(seen[0].body)), { PhoneNumber: "+15555550103", FriendlyName: "demo-tenant" });
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["TWILIO_ACCOUNT_SID", had.sid], ["TWILIO_API_KEY", had.key], ["TWILIO_API_SECRET", had.secret]] as const) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
} });

Deno.test("the calling-only row: not registered for texting (165's word), no messaging service", () => {
  assertEquals(callingOnlyNumberRow("demo-tenant", { sid: PN, phoneNumber: "+15555550104" }), {
    client_id: "demo-tenant", phone_number: "+15555550104", twilio_sid: PN,
    messaging_service_sid: null, registration_status: "pending_registration",
  });
  assertEquals(callingOnlyNumberRow("demo-tenant", { sid: "", phoneNumber: "+15555550104" }).twilio_sid, null);
});

Deno.test("only a US number from the search, and a three-digit area code, get through", () => {
  assertEquals(pickedNumber("+15555550105"), "+15555550105");
  for (const bad of ["5555550105", "+1555555010", "+445555550105", "+11555550105", "", null]) assertEquals(pickedNumber(bad), null, String(bad));
  assertEquals(areaCodeOf("816"), "816");
  assertEquals(areaCodeOf(" (816) "), "816");
  assertEquals(areaCodeOf("116"), null);
  assertEquals(areaCodeOf("8165"), null);
  assertEquals(areaCodeOf(undefined), null);
});

// ── the handlers' wiring (index.ts) ────────────────────────────────────────────────────────
Deno.test("the three phase-6 actions are phone:edit, behind the rollout, and buying ALSO needs billing (and an operator's canBill)", () => {
  for (const a of ["phone_search_numbers", "phone_buy_number", "phone_enable_number"]) {
    assert(new RegExp(`\\n\\s*${a}:\\s*\\{\\s*area:\\s*"phone",\\s*level:\\s*"edit"\\s*\\}`).test(SRC), `GATES.${a} should be phone:edit`);
    const b = slice(SRC, `if (action === "${a}") {`, "\n  }\n", `${a} branch`);
    // Review SSB-1: the FIRST thing each of them does is the server-side rollout check.
    assert(/^if \(action === "\w+"\) \{\s*const refused = await phoneRolloutGate\(\);\s*if \(refused\) return refused;/.test(b), `${a} must refuse through phoneRolloutGate before anything else`);
  }
  assert(/const mayBuyPhoneNumber = \(\) => canEdit\("phone"\) && canEdit\("settings_billing"\) && \(!operator \|\| operator\.canBill\);/.test(SRC));
  const buy = slice(SRC, 'if (action === "phone_buy_number") {', "// ── Plan phase 6: caller-ID trust", "phone_buy_number branch");
  assert(/if \(!mayBuyPhoneNumber\(\)\)/.test(buy));
  assert(/buyCallingNumber\(\{ clientId, wanted, recorded: liveRows\.map\(\(r\) => String\(r\.phone_number\)\) \}, \{/.test(buy),
    "the purchase is buyCallingNumber (tested above), told which numbers are already the tenant's");
  assert(/p_kind: "sms_number_monthly"/.test(SRC) && /hold: takeNumberHold/.test(buy), "the first month is held on portal-sms's meter");
  // In the tenant's own Twilio account (Workstream 2: tenantTwilio, the parent while TWILIO_SUBACCOUNTS is off).
  assert(/findPurchasedNumbers: \(id\) => findPurchasedNumbers\(id, creds\),\s*purchaseNumber: \(o\) => purchaseNumber\(o, creds\),\s*releaseNumber: \(sid\) => releaseNumber\(sid, creds\),/.test(buy),
    "a number bought but not recorded can be given back, in the account it was bought in");
  assert(buy.indexOf("await tenantTwilio()") > 0 && buy.indexOf("await tenantTwilio()") < buy.indexOf("buyCallingNumber("), "the account is resolved before anything is bought");
  assert(/\.insert\(callingOnlyNumberRow\(clientId, b\)\)/.test(buy));
  assert(!/messagingServiceSid/.test(buy), "the purchase itself never passes a messaging service (joining texting is attachToTexting, after the row is recorded)");
  assert(!/client_settings"\)\s*\.update/.test(buy), "a calling-only number must not become client_settings.sms_number");
  // Up to MAX_NUMBERS live numbers (migration 266), checked before anything is bought; the env a number needs, before money moves.
  assert(/const live = await phoneNumberRows\(\);[\s\S]*?if \(liveRows\.length >= MAX_NUMBERS\) \{/.test(buy));
  assert(buy.indexOf("phoneNumberRows()") < buy.indexOf("buyCallingNumber("));
  assert(!/\(count \?\? 0\) >= 1/.test(buy), "the one-number refusal is gone");
  assert(buy.indexOf("smsInboundUrl(") < buy.indexOf("buyCallingNumber("), "no SMS webhook configured, no purchase");
  // Review SSB-3: every path gives the new number somewhere for its TEXTS to go.
  assert(buy.indexOf("if (phoneOn) {") < buy.indexOf("connectNumberForCalls("));
  assert(/config: \{ \.\.\.numberVoicemailConfig\(ve\.env\), \.\.\.\(joined \? \{\} : numberSmsConfig\(smsUrl\)\) \}/.test(buy),
    "calling off: voicemail + the SMS webhook (unless it joined texting), in one update");
  assert(/connectNumberForCalls\(\{ \.\.\.row, messaging_service_sid: joined \? serviceSid : null \}\)/.test(buy),
    "calling on: connect it as the calling-only number it is, or as the texting number it just became");
  // Migration 266: texting joins AFTER the row is recorded, and only while the builder's texting is on.
  assert(buy.indexOf("const serviceSid = await textingServiceSid();") > buy.indexOf("buyCallingNumber("));
  // The join runs in the tenant's own Twilio account (Workstream 2), the one the number was bought in.
  assert(/attachToTexting\(\{ serviceSid, numberSid: bought\.sid \}, textingDeps\(String\(row\.id\), creds\)\)/.test(buy));
});

Deno.test("Connect this number for calls: only while calling is on; a calling-only number gets its SMS webhook in the same update", () => {
  const en = slice(SRC, 'if (action === "phone_enable_number") {', 'if (action === "phone_buy_number") {', "phone_enable_number branch");
  assert(/phone_status !== "on"\) \{\s*return json\(\{ error: "Turn calling on first, then connect the number\." \}, 409\);/.test(en));
  const connect = slice(SRC, "const connectNumberForCalls = async", "const numberToVoicemail = async", "connectNumberForCalls");
  assert(/voiceEnv\(\(k\) => Deno\.env\.get\(k\)\)/.test(connect), "reads PHONE_API_BASE / PHONE_WEBHOOK_SECRET / PHONE_FALLBACK_URL from the edge env");
  assert(/const smsUrl = !n\.messaging_service_sid \? smsInboundUrl\(\(k\) => Deno\.env\.get\(k\)\) : null;/.test(connect),
    "only a number with NO messaging service gets its own SmsUrl");
  assert(/const config = \{ \.\.\.numberVoiceConfig\(ve\.env\), \.\.\.\(smsUrl \? numberSmsConfig\(smsUrl\) : \{\}\) \};/.test(connect));
  assert(connect.indexOf("applyNumberVoice(") < connect.indexOf("voice_enabled: true"), "voice_enabled is written only after Twilio accepted the change");
  // The reverse (review SSB-2) writes voice_enabled = false only after Twilio accepted the voicemail settings.
  const off = slice(SRC, "const numberToVoicemail = async", "\n  };\n", "numberToVoicemail");
  assert(/config: numberVoicemailConfig\(\{ fallbackUrl \}\)/.test(off));
  assert(/const fallbackUrl = fallbackUrlOf\(/.test(off) && !/voiceEnv\(/.test(off), "moving to voicemail needs only the fallback, not the Worker's secret");
  assert(off.indexOf("applyNumberVoice(") < off.indexOf("voice_enabled: false"));
});

// ── Review SSB-3: where a calling-only number's texts go ─────────────────────────────────────
Deno.test("smsInboundUrl is portal-sms's own sms-inbound webhook, byte for byte; numberSmsConfig sets it on the number", () => {
  const url = smsInboundUrl(env({ SUPABASE_URL: "https://proj.example.test/", SMS_INBOUND_SECRET: "s3cr3tKEY" }));
  assertEquals(url, "https://proj.example.test/functions/v1/sms-inbound?key=s3cr3tKEY");
  assertEquals(numberSmsConfig(url!), { SmsUrl: "https://proj.example.test/functions/v1/sms-inbound?key=s3cr3tKEY", SmsMethod: "POST" });
  assertEquals(smsInboundUrl(env({ SUPABASE_URL: "https://proj.example.test" })), null, "no secret, no webhook (sms-inbound would refuse every text)");
  assertEquals(smsInboundUrl(env({ SMS_INBOUND_SECRET: "x" })), null);
  // The same URL shape portal-sms puts on a texting Messaging Service and sms-inbound checks the signature against.
  assert(PORTAL_SMS.includes("inboundWebhookUrl: `${Deno.env.get(\"SUPABASE_URL\")}/functions/v1/sms-inbound?key=${Deno.env.get(\"SMS_INBOUND_SECRET\") ?? \"\"}`"),
    "portal-sms's inbound URL changed; keep smsInboundUrl identical");
  assert(SMS_INBOUND.includes("/functions/v1/sms-inbound?key=${key}"), "sms-inbound rebuilds the same URL to check the signature");
});

Deno.test("applyNumberVoice carries the SMS webhook when it is given one (the calling-only connect)", async () => {
  const seen: Seen[] = [];
  const config = { ...numberVoiceConfig({ apiBase: "https://p.example.test", secret: SECRET, fallbackUrl: "https://f.example.test/bin" }), ...numberSmsConfig("https://proj.example.test/functions/v1/sms-inbound?key=k") };
  assertEquals(await applyNumberVoice({ creds: CREDS, numberSid: PN, config, fetchImpl: stubFetch(() => ({ body: { sid: PN } }), seen) }), { ok: true });
  const form = Object.fromEntries(new URLSearchParams(seen[0].body));
  assertEquals(form.SmsUrl, "https://proj.example.test/functions/v1/sms-inbound?key=k");
  assertEquals(form.SmsMethod, "POST");
  assertEquals(form.VoiceUrl, `https://p.example.test/voice/inbound?key=${SECRET}`);
});

// ── Review SSB-2: the switch moves the number ────────────────────────────────────────────────
Deno.test("numberVoicemailConfig sends calls to the fallback Bin and clears the Worker's callbacks, touching no SMS setting", () => {
  const c = numberVoicemailConfig({ fallbackUrl: "https://f.example.test/bin" });
  assertEquals(c, { VoiceUrl: "https://f.example.test/bin", VoiceMethod: "POST", StatusCallback: "", VoiceFallbackUrl: "" });
  assert(!JSON.stringify(c).includes("/voice/"), "nothing points at the Worker any more");
  // Only the Bin is needed to move a number off the Worker (a hand-connected pilot number with no
  // PHONE_WEBHOOK_SECRET on the edge must still be movable).
  assertEquals(fallbackUrlOf(env({ PHONE_FALLBACK_URL: " https://f.example.test/bin " })), "https://f.example.test/bin");
  assertEquals(fallbackUrlOf(env({ PHONE_FALLBACK_URL: "http://f.example.test/bin" })), null);
  assertEquals(fallbackUrlOf(env({})), null);
});

Deno.test("numberActionForSwitch: off moves a connected number; on puts back one the switch moved; nothing else changes", () => {
  assertEquals(numberActionForSwitch(false, { voice_enabled: true, voice_configured_at: "2026-09-29T00:00:00Z" }), "to_voicemail");
  assertEquals(numberActionForSwitch(false, { voice_enabled: false, voice_configured_at: null }), null, "a number never connected keeps what it had");
  assertEquals(numberActionForSwitch(true, { voice_enabled: false, voice_configured_at: "2026-09-29T00:00:00Z" }), "connect");
  assertEquals(numberActionForSwitch(true, { voice_enabled: false, voice_configured_at: null }), null, "never connected: the owner presses Connect");
  assertEquals(numberActionForSwitch(true, { voice_enabled: true, voice_configured_at: "2026-09-29T00:00:00Z" }), null);
  assertEquals(numberActionForSwitch(false, null), null);
});

function switchWorld(o: {
  number?: Record<string, unknown> | null; numbers?: Record<string, unknown>[]; readFails?: boolean;
  moveOk?: boolean | ((id: string) => boolean); connectOk?: boolean | ((id: string) => boolean); write?: "ok" | "noRow" | "error";
} = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      writeStatus: (on: boolean) => {
        log.push(`status:${on ? "on" : "off"}`);
        return Promise.resolve(o.write === "noRow" ? { ok: false as const, noRow: true as const }
          : o.write === "error" ? { ok: false as const, error: { code: "XX000" } } : { ok: true as const });
      },
      // Migration 266: every live number (oldest first); `number` is the one-number world.
      readNumbers: () => {
        log.push("read");
        const rows = o.numbers ?? (o.number ? [o.number] : []);
        return Promise.resolve(o.readFails ? { error: { code: "XX000" } } : { rows: rows as never });
      },
      toVoicemail: (n: { id: string }) => {
        log.push(o.numbers ? `to_voicemail:${n.id}` : "to_voicemail");
        return Promise.resolve(typeof o.moveOk === "function" ? o.moveOk(n.id) : (o.moveOk ?? true));
      },
      connect: (n: { id: string }) => {
        log.push(o.numbers ? `connect:${n.id}` : "connect");
        return Promise.resolve(typeof o.connectOk === "function" ? o.connectOk(n.id) : (o.connectOk ?? true));
      },
    },
  };
}
const CONNECTED = { id: "n1", phone_number: "+15555550100", twilio_sid: PN, voice_enabled: true, voice_configured_at: "2026-09-29T00:00:00Z" };

Deno.test("switchCalling OFF: the switch lands first, then a connected number moves to voicemail", async () => {
  const w = switchWorld({ number: CONNECTED });
  assertEquals(await switchCalling(false, w.deps), { ok: true, phoneStatus: "off", number: { voiceReady: false }, numbers: [{ id: "n1", voiceReady: false }], warning: null });
  assertEquals(w.log, ["status:off", "read", "to_voicemail"]);
});

Deno.test("switchCalling OFF when the move fails: still off (it is the safety switch), and the answer says callers still hear 'can't take calls'", async () => {
  const w = switchWorld({ number: CONNECTED, moveOk: false });
  assertEquals(await switchCalling(false, w.deps), { ok: true, phoneStatus: "off", number: { voiceReady: true }, numbers: [{ id: "n1", voiceReady: true }], warning: SWITCH_WARNINGS.offStuck });
  const unread = switchWorld({ readFails: true });
  assertEquals(await switchCalling(false, unread.deps), { ok: true, phoneStatus: "off", number: null, numbers: [], warning: SWITCH_WARNINGS.offUnchecked });
});

Deno.test("switchCalling ON reconnects a number the switch moved; a failed reconnect says so; a number never connected is left for Connect", async () => {
  const moved = { ...CONNECTED, voice_enabled: false };
  const w = switchWorld({ number: moved });
  assertEquals(await switchCalling(true, w.deps), { ok: true, phoneStatus: "on", number: { voiceReady: true }, numbers: [{ id: "n1", voiceReady: true }], warning: null });
  assertEquals(w.log, ["status:on", "read", "connect"]);
  const bad = switchWorld({ number: moved, connectOk: false });
  assertEquals((await switchCalling(true, bad.deps) as { warning: string }).warning, SWITCH_WARNINGS.onNotReconnected);
  const fresh = switchWorld({ number: { ...moved, voice_configured_at: null } });
  assertEquals(await switchCalling(true, fresh.deps), { ok: true, phoneStatus: "on", number: { voiceReady: false }, numbers: [{ id: "n1", voiceReady: false }], warning: null });
  assert(!fresh.log.includes("connect"));
});

// ── Migration 266: the switch moves EVERY number, not only the first ──────────────────────────
const SECOND = { id: "n2", phone_number: "+15555550101", twilio_sid: PN, voice_enabled: true, voice_configured_at: "2026-10-01T00:00:00Z" };
const NEVER = { id: "n3", phone_number: "+15555550102", twilio_sid: PN, voice_enabled: false, voice_configured_at: null };

Deno.test("switchCalling OFF with three numbers: each connected one moves to voicemail, in order; one never connected is left alone", async () => {
  const w = switchWorld({ numbers: [CONNECTED, SECOND, NEVER] });
  assertEquals(await switchCalling(false, w.deps), {
    ok: true, phoneStatus: "off", number: { voiceReady: false },
    numbers: [{ id: "n1", voiceReady: false }, { id: "n2", voiceReady: false }, { id: "n3", voiceReady: false }], warning: null,
  });
  assertEquals(w.log, ["status:off", "read", "to_voicemail:n1", "to_voicemail:n2"]);
});

Deno.test("switchCalling OFF: one number that won't move doesn't stop the others, and the warning says SOME", async () => {
  const w = switchWorld({ numbers: [CONNECTED, SECOND], moveOk: (id) => id !== "n1" });
  const out = await switchCalling(false, w.deps);
  assertEquals(out, {
    ok: true, phoneStatus: "off", number: { voiceReady: true },
    numbers: [{ id: "n1", voiceReady: true }, { id: "n2", voiceReady: false }], warning: SWITCH_WARNINGS.offStuckSome,
  });
  assertEquals(w.log, ["status:off", "read", "to_voicemail:n1", "to_voicemail:n2"], "the second is still moved");
});

Deno.test("switchCalling ON with two numbers the switch moved: both reconnect; a failed one says SOME", async () => {
  const moved = [{ ...CONNECTED, voice_enabled: false }, { ...SECOND, voice_enabled: false }];
  const w = switchWorld({ numbers: moved });
  assertEquals((await switchCalling(true, w.deps) as { numbers: unknown }).numbers, [{ id: "n1", voiceReady: true }, { id: "n2", voiceReady: true }]);
  assertEquals(w.log, ["status:on", "read", "connect:n1", "connect:n2"]);
  const bad = switchWorld({ numbers: moved, connectOk: (id) => id === "n1" });
  const out = await switchCalling(true, bad.deps) as { warning: string; number: unknown };
  assertEquals(out.warning, SWITCH_WARNINGS.onNotReconnectedSome);
  assertEquals(out.number, { voiceReady: true }, "`number` is still the first number's state, for an older portal");
});

Deno.test("buy (migration 266): the tenant's OWN recorded numbers are never 'adopted' as orphans", async () => {
  // Twilio lists every FriendlyName=client_id number, the recorded ones included.
  assertEquals(pickOrphan([ORPHAN], "+15555550102", [ORPHAN.phoneNumber]), null, "a recorded number is not an orphan");
  assertEquals(pickOrphan([ORPHAN, { sid: "PNx", phoneNumber: "+15555550109" }], "+15555550102", [ORPHAN.phoneNumber])?.phoneNumber, "+15555550109",
    "an unrecorded one beside it still is");
  const w = buyWorld({ twilioHas: [ORPHAN] });
  const out = await buyCallingNumber({ clientId: "demo-tenant", wanted: "+15555550102", recorded: [ORPHAN.phoneNumber] }, w.deps);
  assert(out.ok);
  assertEquals(out.ok && [out.bought.phoneNumber, out.reconciled, out.adoptedInstead], ["+15555550102", false, false], "the second number is BOUGHT");
  assert(w.log.includes("hold:sms_num:demo-tenant:+15555550102"), "and held on its own key");
});

Deno.test("switchCalling: no settings row, or a failed write, touches no number", async () => {
  const none = switchWorld({ write: "noRow", number: CONNECTED });
  assertEquals(await switchCalling(false, none.deps), { ok: false, noRow: true });
  assertEquals(none.log, ["status:off"]);
  const err = switchWorld({ write: "error", number: CONNECTED });
  assert(!(await switchCalling(false, err.deps)).ok);
  assertEquals(err.log, ["status:off"]);
});

Deno.test("phone_status_set is switchCalling, and only turning it ON passes the rollout check", () => {
  const b = slice(SRC, 'if (action === "phone_status_set") {', "\n  }\n", "phone_status_set branch");
  assert(/if \(on\) \{\s*const refused = await phoneRolloutGate\(\);\s*if \(refused\) return refused;\s*\}/.test(b), "ON is behind the rollout; OFF never is");
  assert(/const out = await switchCalling\(on, \{/.test(b));
  assert(/toVoicemail: \(n\) => numberToVoicemail\(n\)/.test(b) && /connect: async \(n\) => \(await connectNumberForCalls\(n\)\)\.ok/.test(b));
  // The helpers it uses are declared ABOVE it (a const used before its line is a TDZ throw).
  for (const h of ["const connectNumberForCalls = async", "const numberToVoicemail = async", "const phoneRolloutGate = async"]) {
    assert(SRC.indexOf(h) > 0 && SRC.indexOf(h) < SRC.indexOf('if (action === "phone_status_set") {'), `${h} must be declared above phone_status_set`);
  }
});
