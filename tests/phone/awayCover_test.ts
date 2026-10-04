// My Synergy Phone — "While I'm on Do Not Disturb, ring" in the portal (migration 264), tested
// against the SHIPPED source the way callRecordingUi_test.ts does (slice between stable anchors,
// fail loudly if they move):
//   * 01-core's Worker calls for the signed-in person's own settings and team: the sign-in in the
//     header, never in a URL; the Worker's own refusal sentence; an older Worker's 405 (it routes
//     only POST /settings/me) marked so the card can tell it apart
//   * Settings › Phone's "Your calls" card: its choices and words, and where it is shown
//   * the Worker side it relies on: GET /settings/me exists, and the refusal sentence is the
//     Worker's
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../portal/01-core.jsx");
const SMS = await read("../../portal/11-sms.jsx");
const WORKER_ME = await read("../../workers/phone-api/src/routes/me.ts");
const WORKER_INDEX = await read("../../workers/phone-api/src/index.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`awayCover_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const ME = "00000000-0000-4000-8000-0000000000a1";
const PAT = "00000000-0000-4000-8000-0000000000b2";
const SAM = "00000000-0000-4000-8000-0000000000c3";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.session.sig";
const TEAM = [
  { user_id: SAM, full_name: "Sam Smith", identity_base: "u_x_g1" },
  { user_id: ME, full_name: "Alex Able", identity_base: "u_y_g1" },
  { user_id: PAT, full_name: "Pat Parker", identity_base: "u_z_g1" },
];

// ── 01-core: the Worker calls ────────────────────────────────────────────────────────────────
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "MY SYNERGY PHONE helpers");
type Api = {
  ssPhoneMySettings: (token: unknown, f?: typeof fetch) => Promise<Record<string, unknown> | null>;
  ssPhoneSaveMySettings: (patch: unknown, token: unknown, f?: typeof fetch) => Promise<Record<string, unknown> | null>;
  ssPhoneTeam: (token: unknown, f?: typeof fetch) => Promise<unknown[]>;
};
const core = () => new Function("window", "navigator", "ssIsBetaHost", `${PHONE_BLOCK};
  return { ssPhoneMySettings, ssPhoneSaveMySettings, ssPhoneTeam };`)({ location: { href: "" } }, { userAgent: "Mozilla/5.0 Chrome/140" }, () => false) as Api;

type Seen = { url: string; init: RequestInit };
const worker = (status: number, body: unknown, seen: Seen[]) => ((url: string, init: RequestInit) => {
  seen.push({ url, init });
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}) as unknown as typeof fetch;
const fails = async (p: Promise<unknown>, re: RegExp, status?: number) => {
  await p.then(() => { throw new Error("should refuse"); }, (e) => {
    assert(re.test(e.message), e.message);
    if (status !== undefined) assertEquals(e.status, status);
  });
};

Deno.test("your settings are read and saved with the token in the Authorization header, never the URL", async () => {
  const h = core();
  const seen: Seen[] = [];
  const settings = { dnd: false, dnd_until: null, forward_to_cell: null, dnd_cover_user_id: PAT };
  assertEquals(await h.ssPhoneMySettings(TOKEN, worker(200, { ok: true, settings }, seen)), settings);
  assertEquals(await h.ssPhoneSaveMySettings({ dnd_cover_user_id: PAT }, TOKEN, worker(200, { ok: true, settings }, seen)), settings);
  assertEquals(await h.ssPhoneTeam(TOKEN, worker(200, { ok: true, members: TEAM }, seen)), TEAM);
  assertEquals(seen.map((s) => [s.init.method, s.url]), [
    ["GET", "https://phone.structurestudiosuite.com/settings/me"],
    ["POST", "https://phone.structurestudiosuite.com/settings/me"],
    ["GET", "https://phone.structurestudiosuite.com/team"],
  ]);
  for (const s of seen) {
    assert(!s.url.includes(TOKEN) && !/access_token/.test(s.url));
    assertEquals((s.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assertEquals([s.init.credentials, s.init.cache], ["omit", "no-store"]);
  }
  assertEquals(JSON.parse(String(seen[1].init.body)), { dnd_cover_user_id: PAT });
  assertEquals((seen[1].init.headers as Record<string, string>)["Content-Type"], "application/json");
  assertEquals(seen[0].init.body, undefined, "a GET carries no body");
});

Deno.test("the Worker's own refusal is what the card shows; an older Worker's 405 is marked; nothing is asked without a sign-in", async () => {
  const h = core();
  const seen: Seen[] = [];
  await fails(h.ssPhoneSaveMySettings({ dnd_cover_user_id: SAM }, TOKEN,
    worker(400, { ok: false, error: { code: "bad_request", message: "That teammate can't take calls." } }, seen)), /^That teammate can't take calls\.$/, 400);
  // A Worker from before 264 already routes POST /settings/me, so its GET is the method-mismatch
  // reply (index.ts handleApp), not a 404.
  await fails(h.ssPhoneMySettings(TOKEN, worker(405, { ok: false, error: { code: "bad_request", message: "That method isn't allowed here." } }, seen)), /isn't allowed/, 405);
  await fails(h.ssPhoneMySettings(TOKEN, worker(404, { ok: false, error: { code: "not_found", message: "There's nothing here." } }, seen)), /nothing here/, 404);
  await fails(h.ssPhoneTeam(TOKEN, worker(401, {}, seen)), /Sign in again/, 401);
  await fails(h.ssPhoneTeam(TOKEN, worker(500, {}, seen)), /didn't go through/, 500);
  await fails(h.ssPhoneMySettings(TOKEN, (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch), /Check your connection/);
  const before = seen.length;
  await fails(h.ssPhoneMySettings("", worker(200, {}, seen)), /Sign in again/);
  assertEquals(seen.length, before, "no request without a token");
});

// ── 11-sms: the card ─────────────────────────────────────────────────────────────────────────
const HELPERS = slice(SMS, "// ── Your calls (migration 264)", "function PhoneYourCallsCard(", "the Your calls helpers");
const card = new Function(`${HELPERS}; return { phoneCoverState, phoneCoverOptions, phoneAwayText, phoneCoverSavedText };`)() as {
  phoneCoverState: (id: unknown, team: unknown) => { kind: string };
  phoneCoverOptions: (id: unknown, team: unknown, me: unknown) => { value: string; label: string }[];
  phoneAwayText: (c: unknown) => string;
  phoneCoverSavedText: (c: unknown) => string;
};

Deno.test("the box: No one first, then teammates by name, never yourself", () => {
  assertEquals(card.phoneCoverOptions("", TEAM, ME), [
    { value: "", label: "No one" },
    { value: PAT, label: "Pat Parker" },
    { value: SAM, label: "Sam Smith" },
  ]);
  const gone = "00000000-0000-4000-8000-0000000000d4";
  assertEquals(card.phoneCoverOptions(gone, TEAM, ME)[1], { value: gone, label: "Someone who can't take calls now" }, "a saved cover the list can't name still shows");
  assertEquals(card.phoneCoverOptions(PAT, null, ME), [{ value: "", label: "No one" }, { value: PAT, label: "The teammate you chose" }]);
  assertEquals(card.phoneCoverOptions(PAT, TEAM, ME).filter((o) => o.value === PAT).length, 1);
});

Deno.test("the words match My Synergy Phone's (phone-core away.ts)", () => {
  const t = (id: string | null, team: unknown = TEAM) => card.phoneAwayText(card.phoneCoverState(id, team));
  assertEquals(t(PAT), "While you're on Do Not Disturb, calls skip you and ring Pat Parker in your place.");
  assertEquals(t(null), "While you're on Do Not Disturb, calls skip you and ring your teammates, or go to voicemail.");
  assertEquals(t("00000000-0000-4000-8000-0000000000d4"), "While you're on Do Not Disturb, calls skip you. The teammate you chose can't take calls any more, so pick someone else.");
  assertEquals(card.phoneCoverSavedText(card.phoneCoverState(PAT, TEAM)), "Saved. While you're away, your calls ring Pat Parker.");
  assertEquals(card.phoneCoverSavedText(card.phoneCoverState(null, TEAM)), "Saved. While you're away, calls skip you and ring your teammates, or go to voicemail.");
});

Deno.test("the card shows in the own view and the team view, only while calling is on, never to an operator viewing another business", () => {
  const view = slice(SMS, "function PhoneSettingsView(", "// ── Your calls (migration 264)", "PhoneSettingsView");
  assert(view.includes("const yourCallsCard = on && !viewingLabel ? <PhoneYourCallsCard /> : null;"));
  const own = slice(SMS, "// Someone with their OWN calls only", "{installCard}", "the own-level view");
  assert(own.includes("{yourCallsCard}"), "the own view has it");
  const team = slice(view, "{recCard}", "{installCard}", "the team view's end");
  assert(team.includes("{yourCallsCard}"), "the team view has it");
  const cardSrc = slice(SMS, "function PhoneYourCallsCard(", "// ── The Calls page", "the card");
  // Hooks stay above the early returns (React #310).
  const firstReturn = cardSrc.indexOf("if (st && st.unavailable) return null;");
  assert(firstReturn > 0 && cardSrc.lastIndexOf("useState(") < firstReturn && cardSrc.indexOf("useEffect(") < firstReturn);
  assert(cardSrc.includes("if (e && (e.status === 404 || e.status === 405)) setSt({ unavailable: true });"), "an older Worker (405) hides the card instead of showing a fault");
  assert(cardSrc.includes("ssPhoneSaveMySettings({ dnd_cover_user_id: value || null }"), "No one saves null");
});

Deno.test("the Worker side: GET /settings/me is routed, and the refusal the card shows is the Worker's sentence", () => {
  assert(/\{ method: "GET", re: \/\^\\\/settings\\\/me\$\/, h: \(r, env\) => mySettings\(env, r\) \}/.test(WORKER_INDEX), "GET /settings/me is in the route table");
  assert(WORKER_ME.includes(`const COVER_REFUSED = "That teammate can't take calls.";`));
});
