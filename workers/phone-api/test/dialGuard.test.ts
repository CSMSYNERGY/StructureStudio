// The dial guard (src/dialGuard.ts, DEVIATIONS 83): every way a guarded login could make this
// Worker dial or text a phone number, each one refused or allowed as the secret says.
//
// ⚠️ PUBLIC REPO: every value here is fake. Tenants "demo-tenant" (the real business the old login
// sits on) and "example-demo" (a demo business); users are 00000000-... ids; numbers are 555-01xx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CONTACT_2, CUSTOMER, FakeNet, NUMBER_ID, USER_A, USER_B,
  appRequest, attr, call, callerCtx, clientsIn, filter, jsonRes, makeEnv, member, numbersIn, pgTable, phoneListSearch, routeInfo,
  supabaseUrls, twilioPost,
} from "./helpers";
import {
  _resetDialGuard, DEMO_DAILY_MINUTES_DEFAULT, GUARD_WORDS, guardModeFor, parseDialGuard, PEOPLE_PAGE, PEOPLE_PAGES, TEXT_SCAN,
} from "../src/dialGuard";
import type { Env } from "../src/env";
import { resetLogThrottle } from "../src/log";

const DEMO = "example-demo";
/** The demo customer line, in allow_numbers (written the way a person might paste it). */
const DEMO_LINE = "+18165550123";
/** The business's second number (phone_caller_context `numbers`). */
const SECOND_NUMBER = "+15555550102";
/** A number no one has seen: the reviewer's own phone. */
const REVIEWER_OWN = "+15555550161";
const GUARD_START = "2026-10-15T00:00:00Z";
const BEFORE = "2026-10-01T15:00:00Z";
const AFTER = "2026-10-16T15:00:00Z";

const IDENTITY = (u: string) => `client:u_${u.replace(/-/g, "")}_g1`;
const id = (u: string) => `u_${u.replace(/-/g, "")}_g1`;

function secret(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    demo_tenants: [DEMO], old_login_users: [USER_A], allow_numbers: ["(816) 555-0123"],
    guard_start: GUARD_START, demo_daily_minutes: 30, ...over,
  });
}

const env = (over: Partial<Env> = {}) => makeEnv({ PHONE_DIAL_GUARD: secret(), ...over });
const demoCtx = (over: Record<string, unknown> = {}) => callerCtx({ client_id: DEMO, numbers: [BUSINESS_NUMBER, SECOND_NUMBER], ...over });

/** Every app_errors row the test wrote, and the same as one string (to look for leaks in). */
const errors = (net: FakeNet) => net.writes("app_errors").map((s) => s.json);
const leaks = (net: FakeNet, digits: string) => JSON.stringify(errors(net)).includes(digits) || supabaseUrls(net).some((u) => u.includes(digits));

beforeEach(() => {
  _resetDialGuard();
});

// ── The secret ──────────────────────────────────────────────────────────────────────

describe("PHONE_DIAL_GUARD, read", () => {
  it.each([undefined, null])("unset (%j) is off", (raw) => {
    expect(parseDialGuard(raw).kind).toBe("off");
  });

  // Set but blank (an empty file piped to `wrangler secret put`): `secret list` shows it as set, so
  // it must not pass for a guard that is on. It names nobody, but it is unreadable, and says so.
  it.each(["", "   \n", "\r\n"])("set but blank (%j) is unreadable, and names nobody", (raw) => {
    const s = parseDialGuard(raw);
    expect(s).toMatchObject({ kind: "invalid", reason: "it is empty" });
    expect(guardModeFor(s, USER_A, CLIENT)).toBeNull();
    expect(guardModeFor(s, USER_B, DEMO)).toBeNull();
  });

  it("normalises every number to E.164, lowercases user ids, keeps the start as ISO, defaults the demo minutes", () => {
    const s = parseDialGuard(JSON.stringify({
      demo_tenants: [DEMO], old_login_users: [USER_A.toUpperCase()],
      allow_numbers: ["+1 (816) 555-0123", "8165550123", "18165550123"], guard_start: "2026-10-14T19:00:00-05:00",
    }));
    expect(s.kind).toBe("on");
    if (s.kind !== "on") return;
    expect([...s.config.allowNumbers]).toEqual([DEMO_LINE]);
    expect([...s.config.oldLoginUsers]).toEqual([USER_A]);
    expect(s.config.guardStart).toBe("2026-10-15T00:00:00.000Z");
    expect(s.config.demoDailyMinutes).toBe(DEMO_DAILY_MINUTES_DEFAULT);
  });

  it.each([
    ["not JSON", "{demo_tenants: [}"],
    ["not an object", "[]"],
    ["an unknown key (a typo must never switch a guard off)", secret({ demo_tenant: [DEMO] })],
    ["a missing key", JSON.stringify({ demo_tenants: [DEMO], old_login_users: [], allow_numbers: [] })],
    ["a business id that isn't one", secret({ demo_tenants: ["Example Demo"] })],
    ["a user id that isn't a uuid", secret({ old_login_users: ["the old reviewer"] })],
    ["a number that can't be dialed", secret({ allow_numbers: ["555-0123"] })],
    ["a number with an extension", secret({ allow_numbers: ["8165550123x45"] })],
    ["a start with no zone", secret({ guard_start: "2026-10-15T00:00:00" })],
    ["a start that isn't a time", secret({ guard_start: "yesterday" })],
    ["zero demo minutes", secret({ demo_daily_minutes: 0 })],
    ["fractional demo minutes", secret({ demo_daily_minutes: 2.5 })],
  ])("unreadable: %s; the reason never repeats the secret", (_l, raw) => {
    const s = parseDialGuard(raw);
    expect(s.kind).toBe("invalid");
    if (s.kind !== "invalid") return;
    expect(s.reason).not.toMatch(/816|555|0123|example|reviewer|00000000/i);
  });

  it("who is under which rule: a demo business wins, then the old-login list; an unreadable secret takes anyone it names", () => {
    const on = parseDialGuard(secret());
    expect(guardModeFor(on, USER_B, DEMO)).toBe("demo");
    expect(guardModeFor(on, USER_A, DEMO)).toBe("demo");
    expect(guardModeFor(on, USER_A, CLIENT)).toBe("old_login");
    expect(guardModeFor(on, USER_B, CLIENT)).toBeNull();
    const broken = parseDialGuard(`${secret()},`);
    expect(guardModeFor(broken, USER_A, CLIENT)).toBe("unreadable");
    expect(guardModeFor(broken, USER_B, DEMO)).toBe("unreadable");
    expect(guardModeFor(broken, USER_B, CLIENT)).toBeNull();
    // The id written without its hyphens is still them.
    expect(guardModeFor(parseDialGuard(`{"old_login_users": ["${USER_B.replace(/-/g, "")}"`), USER_B, CLIENT)).toBe("unreadable");
  });
});

// ── /voice/outbound ─────────────────────────────────────────────────────────────────

/** The business's history as the guard reads it: 305's search fixtures, and crm_contact_people. */
type History = Parameters<typeof phoneListSearch>[0] & { people?: Record<string, unknown>[] };

function outboundNet(ctx: Record<string, unknown>, history: History = {}, used: unknown[] = []) {
  const net = new FakeNet().install();
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("phone_list_search", phoneListSearch(history));
  net.rest("GET", "crm_contact_people", pgTable(history.people ?? []));
  net.rest("GET", "crm_contacts", () => [{ id: CONTACT_1 }]);
  net.rest("GET", "phone_calls", () => used);
  net.rest("GET", "usage_prices", () => []);
  net.rest("GET", "wallet_accounts", () => []);
  net.rest("GET", "client_settings", () => []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

async function dialOut(e: Env, to: string, from = USER_A, params: Record<string, string> = {}) {
  return call(e, await twilioPost(e, "/voice/outbound", { CallSid: CALL_SID, From: IDENTITY(from), To: to, Direction: "inbound", ...params }));
}

function expectRefused(text: string, words: string) {
  expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">${words}</Say><Hangup/></Response>`);
  expect(numbersIn(text)).toEqual([]);
}

describe("/voice/outbound, demo mode (every login on a demo business)", () => {
  it.each(["+1 (816) 555-0123", "8165550123", "18165550123", "+18165550123"])("calls the allow-listed demo customer line written as %s", async (to) => {
    const net = outboundNet(demoCtx());
    const { text } = await dialOut(env(), to, USER_B);
    expect(numbersIn(text)).toEqual([DEMO_LINE]);
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ client_id: DEMO, to_e164: DEMO_LINE, status: "ringing" });
    // No history lookup: the business's numbers come with the caller's context.
    expect(net.rpcCalls("phone_list_search")).toEqual([]);
  });

  it("calls the business's own numbers, read from the database (phone_caller_context numbers)", async () => {
    outboundNet(demoCtx());
    expect(numbersIn((await dialOut(env(), "(555) 555-0102", USER_B)).text)).toEqual([SECOND_NUMBER]);
  });

  it("refuses everything else: the demo sentence, then hang up; no phone_calls row; one log line with counts only", async () => {
    const net = outboundNet(demoCtx());
    const { text } = await dialOut(env(), CUSTOMER, USER_B);
    expectRefused(text, GUARD_WORDS.demoCall);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.writes("phone_call_events")).toEqual([]);
    const rows = errors(net);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "dial_guard_refused", severity: "info", client_id: DEMO, context: { mode: "demo", what: "call", allowed: 3 } });
    expect(leaks(net, "5550142")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(USER_B);
  });

  // However the number is written, what is checked is what would be dialed: never a way to
  // check one number and dial another.
  it.each([
    "+1 (555) 555-0142", "15555550142", "5555550142,,,", "5555550142w", "5555550142;", "tel:+15555550142",
    "sip:5555550142@sip.example.test", "5555550142x9", "555-555-0142 ext 9", "555555O142", "1-555-JKL-0142",
    `client:${id(USER_A)}`, "client:+15555550142", "  +15555550142  ",
  ])("never dials a number off the list, written as %j", async (to) => {
    const net = outboundNet(demoCtx());
    const { text } = await dialOut(env(), to, USER_B);
    expect(numbersIn(text)).toEqual([]);
    expect(text).toContain("<Hangup/>");
    expect(net.writes("phone_calls")).toEqual([]);
  });

  it("a demo business gets its own daily cap (30 minutes) even when the Worker's is higher or off", async () => {
    const used = [{ duration_s: 30 * 60, answered_at: null, ended_at: null }];
    for (const cap of ["600", "0"]) {
      const net = outboundNet(demoCtx(), {}, used);
      const { text } = await dialOut(env({ DAILY_MINUTE_CAP: cap }), DEMO_LINE, USER_B);
      expect(text).toContain("Today's calling limit is reached");
      expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ error_code: "minute_cap", to_e164: DEMO_LINE });
    }
    // Its own number from the secret, and never above the Worker's.
    outboundNet(demoCtx(), {}, used);
    expect(numbersIn((await dialOut(env({ PHONE_DIAL_GUARD: secret({ demo_daily_minutes: 45 }) }), DEMO_LINE, USER_B)).text)).toEqual([DEMO_LINE]);
    outboundNet(demoCtx(), {}, used);
    expect((await dialOut(env({ PHONE_DIAL_GUARD: secret({ demo_daily_minutes: 45 }), DAILY_MINUTE_CAP: "20" }), DEMO_LINE, USER_B)).text).toContain("Today's calling limit");
    // Any other business keeps the Worker's 600.
    outboundNet(callerCtx(), {}, used);
    expect(numbersIn((await dialOut(env(), CUSTOMER, USER_B)).text)).toEqual([CUSTOMER]);
  });

  it("911 still gets the emergency answer first (the guard comes after it)", async () => {
    outboundNet(demoCtx());
    const { text } = await dialOut(env(), "911", USER_B);
    expect(text).toContain("For emergencies, call 9 1 1 from your cell phone.");
  });
});

// The contact check, the minute cap and the wallet floor refuse through a phone_calls row that holds
// the number dialed. The guard must answer first, so a guarded number never reaches one of them.
describe("/voice/outbound, the guard comes before every refusal that writes a row", () => {
  /** Nothing about the call was stored, and none of the later checks even ran. */
  function expectGuardFirst(net: FakeNet) {
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.writes("phone_call_events")).toEqual([]);
    expect(net.reads("crm_contacts")).toEqual([]);
    expect(net.reads("phone_calls")).toEqual([]);
    expect(net.rpcCalls("wallet_usage_gate")).toEqual([]);
    expect(errors(net).map((r) => r.code)).toEqual(["dial_guard_refused"]);
  }

  it("a demo login at its daily minutes hears the guard's sentence, not the cap's, and no row is written", async () => {
    const net = outboundNet(demoCtx(), {}, [{ duration_s: 30 * 60, answered_at: null, ended_at: null }]);
    expectRefused((await dialOut(env(), CUSTOMER, USER_B)).text, GUARD_WORDS.demoCall);
    expectGuardFirst(net);
  });

  it("the old login with a contact id from another business, dialing a saved contact: the guard's sentence, no row", async () => {
    const net = outboundNet(callerCtx(), { contacts: [{ id: CONTACT_1, client_id: CLIENT, phone_digits: "5555550142", merged_into: null, updated_at: BEFORE }] });
    net.rest("GET", "crm_contacts", () => []);
    expectRefused((await dialOut(env(), CUSTOMER, USER_A, { ContactId: CONTACT_2 })).text, GUARD_WORDS.blockedCall);
    expectGuardFirst(net);
  });

  it("a demo login whose wallet is below the floor: the guard's sentence, no row", async () => {
    const net = outboundNet(demoCtx());
    net.rpc("wallet_usage_gate", () => ({ allow: false, reason: "below_floor", available_cents: 0, floor_cents: 500, auto_topup_enabled: false }));
    expectRefused((await dialOut(env({ PHONE_USAGE_METERS: "on" }), CUSTOMER, USER_B)).text, GUARD_WORDS.demoCall);
    expectGuardFirst(net);
  });
});

describe("/voice/outbound, old-login mode (the listed login, on a real business)", () => {
  const contact = { id: CONTACT_1, client_id: CLIENT, name: "Pat Example", phone_digits: "5555550142", merged_into: null, updated_at: BEFORE };

  it("refuses a saved contact however the number is typed; asks by POST, so the number never rides in a URL", async () => {
    for (const to of [CUSTOMER, "(555) 555-0142", "15555550142", "sip:5555550142@sip.example.test"]) {
      resetLogThrottle(); // each refusal is its own case here; live, one line per 10 s per isolate
      const net = outboundNet(callerCtx(), { contacts: [contact] });
      const { text } = await dialOut(env(), to);
      expectRefused(text, GUARD_WORDS.blockedCall);
      expect(net.writes("phone_calls")).toEqual([]);
      const asks = net.rpcCalls("phone_list_search");
      expect(asks.map((s) => s.json.p_kind).sort()).toEqual(["calls", "contacts", "texts"]);
      for (const s of asks) {
        expect(s.method).toBe("POST");
        expect(s.json).toMatchObject({ p_client_id: CLIENT, p_digits: "5555550142" });
      }
      expect(asks.find((s) => s.json.p_kind === "calls")!.json).toMatchObject({ p_before: "2026-10-15T00:00:00.000Z", p_customers: false });
      expect(errors(net)).toEqual([expect.objectContaining({
        code: "dial_guard_refused", client_id: CLIENT, context: { mode: "old_login", what: "call", contacts: 1, people: 0, calls: 0, texts: 0 },
      })]);
      expect(leaks(net, "5550142")).toBe(false);
    }
  });

  // Migration 190: more people on one contact, each with their own number. They come from a
  // design's second phone (191), a merge (192: the merged-away contact's number lands here on the
  // one kept) and the GHL import (282). 305 has no kind for them, so the guard reads them by tenant.
  const person = (n: number, digits: string, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-0000000d${String(n).padStart(4, "0")}`, client_id: CLIENT, contact_id: CONTACT_1,
    ordinal: 2, name: "Second Person", phone: digits, phone_digits: digits, source: "design", ...over,
  });
  const people = [
    person(1, "5555550147"), // a spouse, from a design's second phone
    person(2, "5555550148", { contact_id: CONTACT_2, source: "merge" }), // a merged-away duplicate's number
    person(3, "555555015012", { source: "import" }), // stored with an extension: still that number
    person(4, null as unknown as string, { email: "second@example.test" }), // no number: never matches
    person(5, "5555550149", { client_id: "other-tenant" }), // another business's never counts
  ];

  it.each([
    ["a spouse's number on the contact", "+15555550147", "5550147"],
    ["a merged-away contact's number, now on the one kept", "(555) 555-0148", "5550148"],
    ["a number saved with an extension", "5555550150", "5550150"],
  ])("refuses %s, read with only the tenant in the URL", async (_l, to, digits) => {
    const net = outboundNet(callerCtx(), { people });
    expectRefused((await dialOut(env(), to)).text, GUARD_WORDS.blockedCall);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(errors(net)[0].context).toMatchObject({ mode: "old_login", contacts: 0, people: 1, calls: 0, texts: 0 });
    const reads = net.reads("crm_contact_people");
    expect(reads).toHaveLength(1);
    expect(filter(reads[0], "client_id")).toBe(CLIENT);
    expect(reads[0].url.searchParams.get("phone_digits")).toBe("not.is.null");
    expect(leaks(net, digits)).toBe(false);
  });

  it("another business's people, and a person with no number, never block: the call rings", async () => {
    const net = outboundNet(callerCtx(), { people });
    expect(numbersIn((await dialOut(env(), "+15555550149")).text)).toEqual(["+15555550149"]);
    expect(errors(net)).toEqual([]);
  });

  it("the old login can't text a second person on a contact either", async () => {
    const { net, token } = await smsNet(callerCtx(), { people });
    const { res, json } = await call(env(), appRequest("POST", "/sms/send", token, { to_e164: "+15555550147", body: "hi" }));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: GUARD_WORDS.blockedText });
    expect(net.to(/Messages\.json$/)).toEqual([]);
  });

  it(`reads every page of people (${PEOPLE_PAGE} a read), and refuses when ${PEOPLE_PAGES} full pages leave more unread`, async () => {
    // Fake 555-0199 numbers in area codes 200 to 999: none of them is a number this test dials.
    const filler = (from: number, count: number) => Array.from({ length: count }, (_, i) => person(from + i, `${200 + ((from + i) % 800)}5550199`));
    // The match is on the second page.
    let net = outboundNet(callerCtx(), { people: [...filler(1, PEOPLE_PAGE), person(9001, "5555550147")] });
    expectRefused((await dialOut(env(), "+15555550147")).text, GUARD_WORDS.blockedCall);
    expect(net.reads("crm_contact_people").map((s) => s.url.searchParams.get("offset") ?? "0")).toEqual(["0", String(PEOPLE_PAGE)]);

    // Two pages, no match: the call rings.
    net = outboundNet(callerCtx(), { people: filler(1, PEOPLE_PAGE + 5) });
    expect(numbersIn((await dialOut(env(), REVIEWER_OWN)).text)).toEqual([REVIEWER_OWN]);
    expect(net.reads("crm_contact_people")).toHaveLength(2);

    // More people than the guard reads: nothing can be ruled out, so it refuses.
    resetLogThrottle();
    net = outboundNet(callerCtx(), { people: filler(1, PEOPLE_PAGE * PEOPLE_PAGES + 1) });
    expectRefused((await dialOut(env(), REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
    expect(net.reads("crm_contact_people")).toHaveLength(PEOPLE_PAGES);
    expect(errors(net)[0].context).toMatchObject({ people: 0, people_full: true });
  });

  it("fails closed: a people read that fails refuses the call and logs the database's code only", async () => {
    const net = outboundNet(callerCtx());
    net.rest("GET", "crm_contact_people", () => jsonRes({ code: "42P01", message: "relation \"public.crm_contact_people\" does not exist" }, 404));
    expectRefused((await dialOut(env(), REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(errors(net)).toEqual([expect.objectContaining({ code: "dial_guard_lookup_failed", severity: "error", context: { what: "call", pg: "42P01" } })]);
  });

  it("refuses a number from the business's calls before the start; one only called since (the reviewer's own phone) still rings", async () => {
    const calls = [
      { id: "00000000-0000-4000-8000-0000000ca001", client_id: CLIENT, direction: "in", from_e164: "+15555550143", to_e164: BUSINESS_NUMBER, started_at: BEFORE, status: "missed" },
      // Apple's steps 2 and 5: call your own phone, then call back the voicemail it left.
      { id: "00000000-0000-4000-8000-0000000ca002", client_id: CLIENT, direction: "out", from_e164: BUSINESS_NUMBER, to_e164: REVIEWER_OWN, started_at: AFTER, status: "completed", placed_by: USER_A },
      { id: "00000000-0000-4000-8000-0000000ca003", client_id: CLIENT, direction: "in", from_e164: REVIEWER_OWN, to_e164: BUSINESS_NUMBER, started_at: AFTER, status: "voicemail" },
      // Another business's history never counts.
      { id: "00000000-0000-4000-8000-0000000ca004", client_id: "other-tenant", direction: "in", from_e164: "+15555550144", to_e164: "+15555550190", started_at: BEFORE, status: "missed" },
    ];
    let net = outboundNet(callerCtx(), { calls });
    expectRefused((await dialOut(env(), "+15555550143")).text, GUARD_WORDS.blockedCall);
    expect(errors(net)[0].context).toMatchObject({ mode: "old_login", calls: 1 });

    net = outboundNet(callerCtx(), { calls });
    const { text } = await dialOut(env(), REVIEWER_OWN);
    expect(numbersIn(text)).toEqual([REVIEWER_OWN]);
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ to_e164: REVIEWER_OWN, placed_by: USER_A, status: "ringing" });
    expect(errors(net)).toEqual([]);

    outboundNet(callerCtx(), { calls });
    expect(numbersIn((await dialOut(env(), "+15555550144")).text)).toEqual(["+15555550144"]);
  });

  it("refuses a number from the business's texts before the start, either way; texts only since don't count", async () => {
    const sms = [
      { id: "00000000-0000-4000-8000-0000000e0001", client_id: CLIENT, contact_id: null, direction: "in", from_number: "+15555550145", to_number: BUSINESS_NUMBER, body: "Is it ready?", created_at: BEFORE },
      { id: "00000000-0000-4000-8000-0000000e0002", client_id: CLIENT, contact_id: null, direction: "out", from_number: BUSINESS_NUMBER, to_number: "+15555550146", body: "On our way", created_at: BEFORE },
      { id: "00000000-0000-4000-8000-0000000e0003", client_id: CLIENT, contact_id: null, direction: "in", from_number: REVIEWER_OWN, to_number: BUSINESS_NUMBER, body: "test", created_at: AFTER },
    ];
    for (const to of ["+15555550145", "+15555550146"]) {
      resetLogThrottle();
      const net = outboundNet(callerCtx(), { sms });
      expectRefused((await dialOut(env(), to)).text, GUARD_WORDS.blockedCall);
      expect(errors(net)[0].context).toMatchObject({ texts: 1 });
      // Not the message bodies either.
      expect(JSON.stringify(errors(net))).not.toMatch(/ready|our way/);
    }
    outboundNet(callerCtx(), { sms });
    expect(numbersIn((await dialOut(env(), REVIEWER_OWN)).text)).toEqual([REVIEWER_OWN]);
  });

  it(`refuses when ${TEXT_SCAN} newer texts fill the page (nothing older can be ruled out)`, async () => {
    const sms = Array.from({ length: TEXT_SCAN }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, client_id: CLIENT, contact_id: null, direction: "in",
      from_number: REVIEWER_OWN, to_number: BUSINESS_NUMBER, body: "x", created_at: AFTER,
    }));
    const net = outboundNet(callerCtx(), { sms });
    expectRefused((await dialOut(env(), REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
    expect(errors(net)[0].context).toMatchObject({ texts: 0, texts_full: true });
  });

  it("fails closed: a lookup that fails refuses the call and logs the database's code only", async () => {
    const net = outboundNet(callerCtx());
    net.rpc("phone_list_search", () => jsonRes({ code: "PGRST202", message: "Could not find phone_list_search(p_digits => 5555550161)" }, 404));
    expectRefused((await dialOut(env(), REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
    expect(net.writes("phone_calls")).toEqual([]);
    expect(errors(net)).toEqual([expect.objectContaining({ code: "dial_guard_lookup_failed", severity: "error", context: { what: "call", pg: "PGRST202" } })]);
    expect(leaks(net, "5550161")).toBe(false);
  });

  it("everyone else on the business calls as before, with no lookup", async () => {
    const net = outboundNet(callerCtx(), { contacts: [contact] });
    const { text } = await dialOut(env(), CUSTOMER, USER_B, { ContactId: CONTACT_1 });
    expect(numbersIn(text)).toEqual([CUSTOMER]);
    expect(net.rpcCalls("phone_list_search")).toEqual([]);
    expect(errors(net)).toEqual([]);
  });
});

describe("/voice/outbound, the secret unreadable or unset", () => {
  it("unreadable: anyone it names is refused, and the config error is logged without the secret; others call as before", async () => {
    const broken = `${secret()},`;
    let net = outboundNet(callerCtx());
    expectRefused((await dialOut(env({ PHONE_DIAL_GUARD: broken }), REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
    expect(net.writes("phone_calls")).toEqual([]);
    const rows = errors(net);
    expect(rows.map((r) => [r.code, r.severity])).toEqual([["dial_guard_config_invalid", "error"], ["dial_guard_refused", "info"]]);
    expect(JSON.stringify(rows)).not.toMatch(/816|0123|example-demo|00000000-0000-4000-8000-0000000000a1/);
    expect(net.rpcCalls("phone_list_search")).toEqual([]);

    // A login on a business the broken secret names (the demo) is refused too.
    outboundNet(demoCtx());
    expectRefused((await dialOut(env({ PHONE_DIAL_GUARD: broken }), DEMO_LINE, USER_B)).text, GUARD_WORDS.blockedCall);

    // Someone it can't name calls normally (the config error is still logged).
    net = outboundNet(callerCtx());
    expect(numbersIn((await dialOut(env({ PHONE_DIAL_GUARD: broken }), CUSTOMER, USER_B)).text)).toEqual([CUSTOMER]);
  });

  it("set but blank: it names nobody, so calls go as before, but dial_guard_config_invalid is logged at error", async () => {
    const net = outboundNet(demoCtx());
    expect(numbersIn((await dialOut(env({ PHONE_DIAL_GUARD: " \n" }), CUSTOMER, USER_A)).text)).toEqual([CUSTOMER]);
    expect(errors(net)).toEqual([expect.objectContaining({ code: "dial_guard_config_invalid", severity: "error" })]);
    expect(errors(net)[0].message).toContain("it is empty");
  });

  // One isolate, one network, no reset in between: what live traffic looks like. A broken secret
  // must not write an error row per call, nor a stream of refusals one row each.
  it("throttled: two calls under a broken secret write one config error and one refusal; later ones write again", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      const e = env({ PHONE_DIAL_GUARD: `${secret()},` });
      const net = outboundNet(callerCtx());
      const codes = () => errors(net).map((r) => r.code);
      expectRefused((await dialOut(e, REVIEWER_OWN)).text, GUARD_WORDS.blockedCall);
      clock.mockReturnValue(t0 + 5_000);
      expectRefused((await dialOut(e, CUSTOMER)).text, GUARD_WORDS.blockedCall);
      expect(codes()).toEqual(["dial_guard_config_invalid", "dial_guard_refused"]);

      // 10 s on, the next refusal is a row again; the config error waits its 10 minutes.
      clock.mockReturnValue(t0 + 11_000);
      expectRefused((await dialOut(e, CUSTOMER)).text, GUARD_WORDS.blockedCall);
      expect(codes()).toEqual(["dial_guard_config_invalid", "dial_guard_refused", "dial_guard_refused"]);
      clock.mockReturnValue(t0 + 10 * 60_000 + 1);
      expectRefused((await dialOut(e, CUSTOMER)).text, GUARD_WORDS.blockedCall);
      expect(codes()).toEqual(["dial_guard_config_invalid", "dial_guard_refused", "dial_guard_refused", "dial_guard_config_invalid", "dial_guard_refused"]);
      expect(net.writes("phone_calls")).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("throttled: quick refusals under a good secret (calls, then a text) write one dial_guard_refused row", async () => {
    const net = outboundNet(demoCtx());
    for (const to of [CUSTOMER, REVIEWER_OWN, "+15555550143"]) expectRefused((await dialOut(env(), to, USER_B)).text, GUARD_WORDS.demoCall);
    expect(errors(net).map((r) => r.code)).toEqual(["dial_guard_refused"]);
    // The same isolate's next refusal, a text, inside the 10 s: refused, and no second row.
    const s = await smsNet(demoCtx(), {}, USER_B);
    expect((await call(env(), appRequest("POST", "/sms/send", s.token, { to_e164: CUSTOMER, body: "hi" }))).res.status).toBe(403);
    expect(errors(s.net)).toEqual([]);
  });

  it("unset: every call as before, nothing in app_errors, and noted at most once on the console", async () => {
    const warn = vi.mocked(console.warn);
    for (let i = 0; i < 2; i++) {
      const net = outboundNet(demoCtx());
      expect(numbersIn((await dialOut(makeEnv(), CUSTOMER, USER_A)).text)).toEqual([CUSTOMER]);
      expect(errors(net)).toEqual([]);
      expect(net.rpcCalls("phone_list_search")).toEqual([]);
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("dial_guard_off"))).toHaveLength(1);
  });
});

// ── /sms/send ───────────────────────────────────────────────────────────────────────

async function smsNet(ctx: Record<string, unknown>, history: History = {}, userId = USER_A) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("phone_list_search", phoneListSearch(history));
  net.rest("GET", "crm_contact_people", pgTable(history.people ?? []));
  net.rest("GET", "crm_contacts", () => []);
  net.rest("GET", "sms_messages", () => []);
  net.rest("POST", "app_errors", () => []);
  net.on("POST", /Messages\.json$/, () => jsonRes({ sid: "SM" + "0".repeat(32) }, 201));
  return { net, token: await auth.token(userId) };
}

describe("/sms/send", () => {
  it("demo mode: a text to anyone but the demo numbers is refused before anything is read or sent", async () => {
    const { net, token } = await smsNet(demoCtx());
    const { res, json } = await call(env(), appRequest("POST", "/sms/send", token, { to_e164: CUSTOMER, contact_id: CONTACT_1, body: "hi" }));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: GUARD_WORDS.demoText });
    expect(net.reads("crm_contacts")).toEqual([]);
    expect(net.writes("sms_messages")).toEqual([]);
    expect(net.to(/Messages\.json$/)).toEqual([]);
    expect(errors(net)[0]).toMatchObject({ code: "dial_guard_refused", context: { mode: "demo", what: "text" } });
    expect(leaks(net, "5550142")).toBe(false);
  });

  it("demo mode: the demo customer line passes the guard (and meets the usual texting rules)", async () => {
    const { net, token } = await smsNet(demoCtx());
    const { json } = await call(env(), appRequest("POST", "/sms/send", token, { to_e164: "816-555-0123", body: "hi" }));
    expect(json.error.message).toBe("You can only reply to a number that texted you first. Save it as a contact to start a conversation.");
    expect(errors(net)).toEqual([]);
  });

  it("old-login mode: a saved contact can't be texted", async () => {
    const { net, token } = await smsNet(callerCtx(), { contacts: [{ id: CONTACT_1, client_id: CLIENT, phone_digits: "5555550142", merged_into: null, updated_at: BEFORE }] });
    const { res, json } = await call(env(), appRequest("POST", "/sms/send", token, { to_e164: CUSTOMER, contact_id: CONTACT_1, body: "hi" }));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: GUARD_WORDS.blockedText });
    expect(net.to(/Messages\.json$/)).toEqual([]);
    expect(leaks(net, "5550142")).toBe(false);
  });

  it("fails closed: an old-login lookup that fails refuses the text and logs the database's code only", async () => {
    const { net, token } = await smsNet(callerCtx());
    net.rpc("phone_list_search", () => jsonRes({ code: "PGRST202", message: "Could not find phone_list_search(p_digits => 5555550161)" }, 404));
    const { res, json } = await call(env(), appRequest("POST", "/sms/send", token, { to_e164: REVIEWER_OWN, body: "hi" }));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: GUARD_WORDS.blockedText });
    expect(net.to(/Messages\.json$/)).toEqual([]);
    expect(net.writes("sms_messages")).toEqual([]);
    expect(errors(net)).toEqual([expect.objectContaining({ code: "dial_guard_lookup_failed", severity: "error", context: { what: "text", pg: "PGRST202" } })]);
    expect(leaks(net, "5550161")).toBe(false);
  });

  it("fails closed: under a broken secret that names the login, the text is refused before anything is read", async () => {
    const { net, token } = await smsNet(callerCtx());
    const { res, json } = await call(env({ PHONE_DIAL_GUARD: `${secret()},` }), appRequest("POST", "/sms/send", token, { to_e164: REVIEWER_OWN, body: "hi" }));
    expect(res.status).toBe(403);
    expect(json.error).toEqual({ code: "not_your_customer", message: GUARD_WORDS.blockedText });
    expect(net.to(/Messages\.json$/)).toEqual([]);
    expect(net.rpcCalls("phone_list_search")).toEqual([]);
    expect(errors(net).map((r) => [r.code, r.context?.mode ?? null])).toEqual([["dial_guard_config_invalid", null], ["dial_guard_refused", "unreadable"]]);
  });
});

// ── Forward to my cell ──────────────────────────────────────────────────────────────

async function settingsNet(ctx: Record<string, unknown>, userId = USER_A, storedForward: string | null = null) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rest("GET", "phone_user_settings", () => [{ forward_to_cell: storedForward }]);
  net.rest("POST", "phone_user_settings", (s) => [{ dnd: s.json.dnd ?? false, dnd_until: null, forward_to_cell: s.json.forward_to_cell ?? storedForward }]);
  net.rest("POST", "app_errors", () => []);
  return { net, token: await auth.token(userId) };
}

describe("POST /settings/me, forward_to_cell", () => {
  it.each([
    ["the old login", callerCtx(), USER_A, null],
    ["a demo login", demoCtx(), USER_B, null],
    ["the old login, replacing a forward stored before the guard", callerCtx(), USER_A, "+15555550178"],
  ])("%s can't save a forward, and nothing else in the request is saved either", async (_l, ctx, user, stored) => {
    const { net, token } = await settingsNet(ctx, user, stored);
    const { res, json } = await call(env(), appRequest("POST", "/settings/me", token, { dnd: true, forward_to_cell: "(555) 555-0177" }));
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message: GUARD_WORDS.forwardOff });
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(errors(net)[0]).toMatchObject({ code: "dial_guard_refused", context: { what: "forward_save" } });
    expect(leaks(net, "5550177")).toBe(false);
  });

  it("an app sending its whole settings back with the forward already stored saves the rest and leaves that value alone (it still never rings)", async () => {
    const { net, token } = await settingsNet(callerCtx(), USER_A, "+15555550178");
    const { res, json } = await call(env(), appRequest("POST", "/settings/me", token, { dnd: true, forward_to_cell: "(555) 555-0178" }));
    expect(res.status).toBe(200);
    expect(json.settings.dnd).toBe(true);
    const w = net.writes("phone_user_settings")[0].json;
    expect(w).toMatchObject({ dnd: true });
    expect("forward_to_cell" in w).toBe(false);
    expect(errors(net)).toEqual([]);
  });

  it("a guarded login may still clear it, and anyone else saves one as before", async () => {
    let s = await settingsNet(callerCtx());
    expect((await call(env(), appRequest("POST", "/settings/me", s.token, { forward_to_cell: null }))).json.settings.forward_to_cell).toBeNull();
    expect(s.net.writes("phone_user_settings")[0].json).toMatchObject({ forward_to_cell: null });
    s = await settingsNet(callerCtx(), USER_B);
    expect((await call(env(), appRequest("POST", "/settings/me", s.token, { forward_to_cell: "(555) 555-0177" }))).json.settings.forward_to_cell).toBe("+15555550177");
  });

  it("fails closed: under a broken secret that names the login, a forward can't be saved and nothing is", async () => {
    const { net, token } = await settingsNet(callerCtx());
    const { res, json } = await call(env({ PHONE_DIAL_GUARD: `${secret()},` }), appRequest("POST", "/settings/me", token, { dnd: true, forward_to_cell: "(555) 555-0177" }));
    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: "bad_request", message: GUARD_WORDS.forwardOff });
    expect(net.writes("phone_user_settings")).toEqual([]);
    expect(errors(net).map((r) => [r.code, r.context?.mode ?? null])).toEqual([["dial_guard_config_invalid", null], ["dial_guard_refused", "unreadable"]]);
  });
});

// The old login is one account reviewer after reviewer signs in to (and it was signed in on a
// team member's phone). A forward stored on it before the guard is never rung, and never shown.
describe("a guarded login's stored forward is never shown", () => {
  const STORED = "+15555550178";

  it.each([
    ["the old login", callerCtx(), USER_A, `${secret()}`],
    ["a demo login", demoCtx(), USER_B, `${secret()}`],
    ["a login a broken secret names", callerCtx(), USER_A, `${secret()},`],
  ])("%s: /token, GET and POST /settings/me and the greeting clear all answer null", async (_l, ctx, user, guard) => {
    const e = env({ PHONE_DIAL_GUARD: guard });
    const s = await settingsNet(ctx, user, STORED);
    const tok = await call(e, appRequest("POST", "/token", s.token, { platform: "ios", build_type: "prod", app_version: "1.0.0" }));
    expect(tok.res.status).toBe(200);
    expect(tok.json.settings.forward_to_cell).toBeNull();
    expect((await call(e, appRequest("GET", "/settings/me", s.token))).json.settings.forward_to_cell).toBeNull();
    const saved = await call(e, appRequest("POST", "/settings/me", s.token, { dnd: true }));
    expect(saved.json.settings).toMatchObject({ dnd: true, forward_to_cell: null });
    expect((await call(e, appRequest("POST", "/settings/me/greeting/clear", s.token, {}))).json.settings.forward_to_cell).toBeNull();
    expect(JSON.stringify([tok.json, saved.json])).not.toContain("5550178");
  });

  it("everyone else still sees their own", async () => {
    const s = await settingsNet(callerCtx(), USER_B, STORED);
    expect((await call(env(), appRequest("POST", "/token", s.token, { platform: "ios", build_type: "prod", app_version: "1.0.0" }))).json.settings.forward_to_cell).toBe(STORED);
    expect((await call(env(), appRequest("GET", "/settings/me", s.token))).json.settings.forward_to_cell).toBe(STORED);
  });
});

// ── Inbound: stored forwards, and a demo business's own forward ─────────────────────

function inboundNet(info: unknown) {
  const net = new FakeNet().install();
  net.rpc("phone_route_for_number", () => info);
  net.rest("GET", "crm_contacts", () => []);
  net.rest("GET", "phone_user_settings", () => []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("PATCH", "phone_calls", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

const ringIn = async (e: Env) => call(e, await twilioPost(e, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }));
const CLOSED = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

describe("/voice/inbound and /voice/after-dial", () => {
  it("never rings a guarded login's stored cell: the old login's app rings, its cell doesn't; a teammate's cell still does", async () => {
    inboundNet(routeInfo({ members: [member(USER_A, { forward_to_cell: "+15555550177" }), member(USER_B, { forward_to_cell: "+15555550178" })] }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn(env());
    expect(clientsIn(text)).toEqual([id(USER_A), id(USER_B)]);
    expect(numbersIn(text)).toEqual(["+15555550178"]);
  });

  it("on a demo business no member's stored cell rings", async () => {
    inboundNet(routeInfo({ client_id: DEMO, members: [member(USER_A, { forward_to_cell: "+15555550177" }), member(USER_B, { forward_to_cell: "+15555550178" })] }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn(env());
    expect(clientsIn(text)).toEqual([id(USER_A), id(USER_B)]);
    expect(numbersIn(text)).toEqual([]);
  });

  it("fails closed: under a broken secret, the cell of a login it names never rings; a teammate it can't name still does", async () => {
    inboundNet(routeInfo({ members: [member(USER_A, { forward_to_cell: "+15555550177" }), member(USER_B, { forward_to_cell: "+15555550178" })] }, { members: [USER_A, USER_B] }));
    const { text } = await ringIn(env({ PHONE_DIAL_GUARD: `${secret()},` }));
    expect(clientsIn(text)).toEqual([id(USER_A), id(USER_B)]);
    expect(numbersIn(text)).toEqual(["+15555550178"]);
  });

  it("fails closed: under a broken secret that names a demo business, its after-hours and no-answer forwards go to voicemail", async () => {
    const broken = env({ PHONE_DIAL_GUARD: `${secret()},` });
    // Even the demo customer line: an unreadable secret can't say it is on the list.
    const net = inboundNet(routeInfo({ client_id: DEMO }, { business_hours: CLOSED, after_hours: "forward", forward_to: DEMO_LINE }));
    const { text } = await ringIn(broken);
    expect(numbersIn(text)).toEqual([]);
    expect(text).toContain("<Record");
    expect(errors(net).find((r) => r.code === "dial_guard_refused")).toMatchObject({ context: { mode: "unreadable", what: "route_forward" } });

    resetLogThrottle();
    const CALL_ID = "00000000-0000-4000-8000-0000000ca112";
    const n2 = inboundNet(routeInfo({ client_id: DEMO }, { no_answer: "forward", forward_to: DEMO_LINE }));
    n2.rest("GET", "phone_calls", () => [{
      id: CALL_ID, client_id: DEMO, number_id: NUMBER_ID, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
      twilio_call_sid: CALL_SID, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [USER_A], transferred_from: null,
      transfer_state: null, status: "ringing", started_at: new Date().toISOString(), answered_at: null, ended_at: null, duration_s: null,
      error_code: null, is_emergency: false,
    }]);
    const after = await call(broken, await twilioPost(broken, "/voice/after-dial", {
      CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound", DialCallStatus: "no-answer", DialBridged: "false",
    }, { call: CALL_ID }));
    expect(numbersIn(after.text)).toEqual([]);
    expect(attr(after.text, "Record", "action")).toContain(`/voice/voicemail?call=${CALL_ID}`);

    // A business it can't name keeps its forward.
    inboundNet(routeInfo({}, { business_hours: CLOSED, after_hours: "forward", forward_to: "+15555550166" }));
    expect(numbersIn((await ringIn(broken)).text)).toEqual(["+15555550166"]);
  });

  it("the 911 callback rings the guarded caller's app, never their stored cell", async () => {
    inboundNet(routeInfo({ recent_emergency_user: USER_A, members: [member(USER_A, { forward_to_cell: "+15555550177" })] }, { members: [USER_A] }));
    const { text } = await ringIn(env());
    expect(clientsIn(text)).toEqual([id(USER_A)]);
    expect(numbersIn(text)).toEqual([]);
  });

  it("a demo business's after-hours forward rings only an allow-listed number; anything else is voicemail", async () => {
    let net = inboundNet(routeInfo({ client_id: DEMO }, { business_hours: CLOSED, after_hours: "forward", forward_to: "+15555550166" }));
    let { text } = await ringIn(env());
    expect(numbersIn(text)).toEqual([]);
    expect(text).toContain("<Record");
    expect(errors(net)[0]).toMatchObject({ code: "dial_guard_refused", context: { mode: "demo", what: "route_forward" } });
    expect(leaks(net, "5550166")).toBe(false);

    inboundNet(routeInfo({ client_id: DEMO }, { business_hours: CLOSED, after_hours: "forward", forward_to: "816-555-0123" }));
    ({ text } = await ringIn(env()));
    expect(numbersIn(text)).toEqual([DEMO_LINE]);

    // The old login's business keeps its own forward: old-login mode is one login, not the business.
    net = inboundNet(routeInfo({}, { business_hours: CLOSED, after_hours: "forward", forward_to: "+15555550166" }));
    expect(numbersIn((await ringIn(env())).text)).toEqual(["+15555550166"]);
  });

  it("a demo business's no-answer forward (after-dial) goes to voicemail instead of a number off the list", async () => {
    const CALL_ID = "00000000-0000-4000-8000-0000000ca111";
    const row = {
      id: CALL_ID, client_id: DEMO, number_id: NUMBER_ID, contact_id: null, direction: "in", from_e164: CUSTOMER, to_e164: BUSINESS_NUMBER,
      twilio_call_sid: CALL_SID, client_call_sid: null, placed_by: null, answered_by: null, rang_user_ids: [USER_A], transferred_from: null,
      transfer_state: null, status: "ringing", started_at: new Date().toISOString(), answered_at: null, ended_at: null, duration_s: null,
      error_code: null, is_emergency: false,
    };
    const net = inboundNet(routeInfo({ client_id: DEMO }, { no_answer: "forward", forward_to: "+15555550166" }));
    net.rest("GET", "phone_calls", () => [row]);
    const e = env();
    const { text } = await call(e, await twilioPost(e, "/voice/after-dial", {
      CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound", DialCallStatus: "no-answer", DialBridged: "false",
    }, { call: CALL_ID }));
    expect(numbersIn(text)).toEqual([]);
    expect(attr(text, "Record", "action")).toContain(`/voice/voicemail?call=${CALL_ID}`);
  });
});
