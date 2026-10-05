// My Synergy Phone — each person's own voicemail greeting, recorded by phone (migration 264), in
// the portal, tested against the SHIPPED source the way awayCover_test.ts does (slice between
// stable anchors, fail loudly if they move):
//   * 01-core's three Worker calls (Record, Play, Use the standard greeting): the sign-in in the
//     header, never in a URL, and the Worker's own refusal sentence;
//   * the Your calls card's greeting section: its words (pinned to the same answers as the phone
//     repo's phone-core greeting.ts tests), when it shows, and hooks above any early return;
//   * the owner's link field says where it still plays;
//   * the Worker and the migration agree on what a greeting is.
// The Worker's behaviour itself is workers/phone-api/test/greeting.test.ts (TwiML, the save,
// the audio path), inbound.test.ts and afterDial.test.ts (which greeting a voicemail plays).
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../portal/01-core.jsx");
const SMS = await read("../../portal/11-sms.jsx");
const WORKER_INDEX = await read("../../workers/phone-api/src/index.ts");
const WORKER_GREETING = await read("../../workers/phone-api/src/greeting.ts");
const MIGRATION = await read("../../supabase/migrations/264_phone_away_rules.sql");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`greeting_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.session.sig";

// ── 01-core: the Worker calls ────────────────────────────────────────────────────────────────
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "MY SYNERGY PHONE helpers");
type Api = {
  ssPhoneRecordGreeting: (token: unknown, f?: typeof fetch) => Promise<void>;
  ssPhoneClearGreeting: (token: unknown, f?: typeof fetch) => Promise<Record<string, unknown> | null>;
  ssPhoneFetchGreeting: (token: unknown, f?: typeof fetch) => Promise<string>;
};
const core = () => new Function("window", "navigator", "ssIsBetaHost", `${PHONE_BLOCK};
  return { ssPhoneRecordGreeting, ssPhoneClearGreeting, ssPhoneFetchGreeting };`)({ location: { href: "" } }, { userAgent: "Mozilla/5.0 Chrome/140" }, () => false) as Api;

type Seen = { url: string; init: RequestInit };
const worker = (status: number, body: unknown, seen: Seen[], raw?: BodyInit) => ((url: string, init: RequestInit) => {
  seen.push({ url, init });
  return Promise.resolve(new Response(raw ?? JSON.stringify(body), { status, headers: { "content-type": raw ? "audio/mpeg" : "application/json" } }));
}) as unknown as typeof fetch;
const fails = async (p: Promise<unknown>, re: RegExp) => {
  await p.then(() => { throw new Error("should refuse"); }, (e) => assert(re.test(e.message), e.message));
};

Deno.test("Record, Play and Use the standard greeting call the Worker with the sign-in in the header, never the URL", async () => {
  const h = core();
  const seen: Seen[] = [];
  await h.ssPhoneRecordGreeting(TOKEN, worker(200, { ok: true, ringing: true }, seen));
  const settings = { dnd: false, greeting: { set: false, updated_at: null } };
  assertEquals(await h.ssPhoneClearGreeting(TOKEN, worker(200, { ok: true, settings }, seen)), settings);
  const url = await h.ssPhoneFetchGreeting(TOKEN, worker(200, null, seen, "ID3-mp3"));
  assert(url.startsWith("blob:"), url);
  URL.revokeObjectURL(url);
  assertEquals(seen.map((s) => [s.init.method, s.url]), [
    ["POST", "https://phone.structurestudiosuite.com/settings/me/greeting/record"],
    ["POST", "https://phone.structurestudiosuite.com/settings/me/greeting/clear"],
    ["GET", "https://phone.structurestudiosuite.com/settings/me/greeting/audio"],
  ]);
  for (const s of seen) {
    assert(!s.url.includes(TOKEN) && !/access_token/.test(s.url));
    assertEquals((s.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assertEquals([s.init.credentials, s.init.cache], ["omit", "no-store"]);
  }
});

Deno.test("the Worker's own sentence is what the card shows; nothing is asked without a sign-in", async () => {
  const h = core();
  const seen: Seen[] = [];
  await fails(h.ssPhoneRecordGreeting(TOKEN, worker(429, { ok: false, error: { code: "bad_request", message: "Your phone is already ringing for your greeting. Try again in half a minute." } }, seen)),
    /^Your phone is already ringing for your greeting\. Try again in half a minute\.$/);
  await fails(h.ssPhoneRecordGreeting(TOKEN, worker(409, { ok: false, error: { code: "no_number", message: "Your business doesn't have a phone number yet." } }, seen)),
    /doesn't have a phone number yet/);
  await fails(h.ssPhoneFetchGreeting(TOKEN, worker(404, { ok: false, error: { code: "not_found", message: "You haven't recorded a greeting." } }, seen)),
    /^You haven't recorded a greeting\.$/);
  await fails(h.ssPhoneFetchGreeting(TOKEN, worker(401, {}, seen)), /Sign in again to play your greeting/);
  await fails(h.ssPhoneFetchGreeting(TOKEN, (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch), /Check your connection/);
  const before = seen.length;
  await fails(h.ssPhoneRecordGreeting("", worker(200, {}, seen)), /Sign in again/);
  await fails(h.ssPhoneFetchGreeting("", worker(200, {}, seen)), /Sign in again/);
  assertEquals(seen.length, before, "no request without a token");
});

// ── 11-sms: the greeting section ─────────────────────────────────────────────────────────────
const HELPERS = slice(SMS, "// ── Your voicemail greeting (migration 264)", "function PhoneGreetingSection(", "the greeting helpers");
const g = new Function(`${HELPERS}; return { PHONE_GREETING_WORDS, PHONE_GREETING_WAIT_MS, PHONE_GREETING_POLL_MS,
  phoneGreetingSupported, phoneGreetingText, phoneGreetingChanged };`)() as {
  PHONE_GREETING_WORDS: Record<string, string>;
  PHONE_GREETING_WAIT_MS: number;
  PHONE_GREETING_POLL_MS: number;
  phoneGreetingSupported: (s: unknown) => boolean;
  phoneGreetingText: (g: unknown) => string;
  phoneGreetingChanged: (before: unknown, after: unknown) => boolean;
};
// Midday UTC: the same calendar day in every US zone, so the day word is stable wherever this runs.
const AT = "2026-10-05T17:00:00Z";

Deno.test("the words match My Synergy Phone's (phone-core greeting.ts)", () => {
  assertEquals(g.phoneGreetingText({ set: true, updated_at: AT }), "Your own greeting, recorded Oct 5.");
  assertEquals(g.phoneGreetingText({ set: true, updated_at: null }), "Your own greeting.");
  assertEquals(g.phoneGreetingText({ set: false, updated_at: null }), "You haven't recorded one, so callers hear the business's greeting.");
  assertEquals(g.phoneGreetingText(null), "You haven't recorded one, so callers hear the business's greeting.");
  assertEquals(g.PHONE_GREETING_WORDS.ringing, "My Synergy Phone will ring now. Answer it and speak after the tone.");
  assertEquals(g.PHONE_GREETING_WORDS.saved, "Your new greeting is saved.");
  assertEquals(g.PHONE_GREETING_WORDS.where,
    "It plays when a call meant for you goes to voicemail: a call transferred to you, or a number that rings only you. Calls to the shared business number keep the business's greeting.");
  assertEquals(g.PHONE_GREETING_WORDS.standardDone, "Done. Callers hear the business's greeting.");
});

Deno.test("offered only by a Worker that keeps greetings; a new greeting is told apart from the old", () => {
  assert(g.phoneGreetingSupported({ greeting: { set: false, updated_at: null } }));
  assert(!g.phoneGreetingSupported({ dnd: false }), "an older Worker sends no greeting: no section");
  assert(!g.phoneGreetingSupported(null));
  assert(g.phoneGreetingChanged(null, { set: true, updated_at: AT }), "a first greeting");
  assert(g.phoneGreetingChanged("2026-10-01T10:00:00Z", { set: true, updated_at: AT }), "a newer one");
  assert(!g.phoneGreetingChanged(AT, { set: true, updated_at: AT }), "still the old one");
  assert(!g.phoneGreetingChanged(null, { set: false, updated_at: null }), "nothing yet");
  assert(g.PHONE_GREETING_WAIT_MS >= 2 * 60_000 && g.PHONE_GREETING_POLL_MS <= 10_000, "watches long enough for a minute of speaking, often enough to feel quick");
});

Deno.test("the section: in the Your calls card when the Worker keeps greetings, hooks first, a confirm before deleting", () => {
  const section = slice(SMS, "function PhoneGreetingSection(", "// ── Your calls (migration 264)", "PhoneGreetingSection");
  const firstReturn = section.indexOf("return (");
  assert(firstReturn > 0 && section.lastIndexOf("useState(") < firstReturn && section.lastIndexOf("useEffect(") < firstReturn,
    "hooks stay above the return (React #310)");
  assert(!/\n\s+if \([^)]*\) return null;/.test(section.slice(0, firstReturn)), "no early return before the hooks");
  assert(section.includes("window.confirm(PHONE_GREETING_WORDS.confirmStandard)"), "deleting asks first");
  assert(section.includes("await ssPhoneRecordGreeting(await token());"));
  assert(section.includes("setSrc(await ssPhoneFetchGreeting(await token()));"));
  assert(section.includes("URL.revokeObjectURL(src)"), "the blob is let go");
  const card = slice(SMS, "function PhoneYourCallsCard(", "// ── The Calls page", "the card");
  assert(card.includes("{phoneGreetingSupported(st.settings) && ("), "only when the Worker sends `greeting`");
  assert(card.includes("<PhoneGreetingSection greeting={st.settings.greeting}"));
});

Deno.test("the owner's link field says it is for the shared number, and that everyone records their own", () => {
  assert(SMS.includes("Plays on calls to the shared number that aren&rsquo;t for one person."));
  assert(SMS.includes("Everyone can record their own greeting under Your calls."));
});

// ── The Worker and the migration ─────────────────────────────────────────────────────────────
Deno.test("the Worker routes the three app calls, the recording ring's TwiML, and the GET <Play> fetches", () => {
  assert(WORKER_INDEX.includes(`re: /^\\/settings\\/me\\/greeting\\/record$/`));
  assert(WORKER_INDEX.includes(`re: /^\\/settings\\/me\\/greeting\\/audio$/`));
  assert(WORKER_INDEX.includes(`re: /^\\/settings\\/me\\/greeting\\/clear$/`));
  assert(/"\/voice\/greeting",\n\]\);/.test(WORKER_INDEX), "the TwiML path is a Twilio path (key and signature)");
  const fetchFn = slice(WORKER_INDEX, "async fetch(req: Request, env: Env, ec: ExecutionContext)", "async scheduled(", "the fetch entry");
  assert(fetchFn.indexOf(`path === "/voice/greeting-audio"`) < fetchFn.indexOf("return handleApp("), "the audio GET is matched before the app routes");
});

Deno.test("a greeting is a Twilio recording sid, the same shape on both sides", () => {
  assert(MIGRATION.includes("greeting_recording_sid ~ '^RE[0-9a-f]{32}$'"));
  assert(WORKER_GREETING.includes("export const GREETING_SID_RE = /^RE[0-9a-f]{32}$/;"));
  assert(WORKER_GREETING.includes("export const GREETING_MAX_SECONDS = 60;"));
});
