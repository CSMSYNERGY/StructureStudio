// SSS Phone — the portal's Call / Text gates and its extension bridge, tested against the
// SHIPPED source (portal/02-sales.jsx and portal/01-core.jsx), the crmRecordGate_test way:
// slice the real block between stable anchors, fail loudly if they move, run it.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";

const SALES = (await Deno.readTextFile(new URL("../../portal/02-sales.jsx", import.meta.url))).replace(/\r\n/g, "\n");
const CORE = (await Deno.readTextFile(new URL("../../portal/01-core.jsx", import.meta.url))).replace(/\r\n/g, "\n");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`portalPhone_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// ── CRM_TABS: Call and SMS ─────────────────────────────────────────────────────────────────
type Ctx = Record<string, unknown>;
type Tab = { key: string; enabled: (c: Ctx) => boolean; hint?: string | ((c: Ctx) => string); when?: (c: Ctx) => boolean };
const HELPER = slice(SALES, "function crmContextDesign(", "function crmSsQuoteDesign(", "crmContextDesign");
const TABS_BLOCK = slice(SALES, "const CRM_LOCKED_HINT =", "const CRM_CHIPS = [", "CRM_TABS");
const { CRM_TABS, CRM_VIEWING_CALL_HINT, CRM_VIEWING_TEXT_HINT } = new Function(
  "normStatus",
  `${HELPER}\n${TABS_BLOCK}; return { CRM_TABS, CRM_VIEWING_CALL_HINT, CRM_VIEWING_TEXT_HINT };`,
)((s: string) => String(s || "").toLowerCase()) as { CRM_TABS: Tab[]; CRM_VIEWING_CALL_HINT: string; CRM_VIEWING_TEXT_HINT: string };
const tab = (k: string) => CRM_TABS.find((t) => t.key === k)!;
const hint = (t: Tab, c: Ctx) => (typeof t.hint === "function" ? t.hint(c) : (t.hint || ""));

// A rep with phone access on an account where calling is on, looking at their own contact.
const ctx = (over: Ctx = {}): Ctx => ({
  kind: "contact", record: { id: "c1" }, isAdmin: false, canEdit: true, crmUnlocked: true,
  contact: { id: "c1", phone: "(555) 555-0100", email: "pat@example.test" }, designs: [],
  sms: { ready: true, consented: true, optedOut: false },
  selectedCode: "SS-TEST00001", needsPick: false,
  viewing: false, canCall: true, phone: { on: true }, hasCalls: false,
  ...over,
});

Deno.test("Call is live for someone with phone access when calling is on", () => {
  assertEquals(tab("call").enabled(ctx()), true);
});

Deno.test("Call needs no deal pick and no contacts:edit — it is a phone permission, not a CRM write", () => {
  assertEquals(tab("call").enabled(ctx({ needsPick: true, selectedCode: null })), true);
  assertEquals(tab("call").enabled(ctx({ canEdit: false })), true);
  // …and not the CRM subscription either: calling writes nothing through a crm_ action.
  assertEquals(tab("call").enabled(ctx({ canEdit: false, crmUnlocked: false })), true);
  // A design synthesized from an old submission has a phone and no contact row: still callable.
  assertEquals(tab("call").enabled(ctx({ contact: { id: null, phone: "(555) 555-0100" } })), true);
});

Deno.test("operator view-as greys Call AND SMS first, with the plan's exact words", () => {
  const c = ctx({ viewing: true });
  assertEquals(tab("call").enabled(c), false);
  assertEquals(hint(tab("call"), c), "Calling isn't available while viewing another account.");
  assertEquals(CRM_VIEWING_CALL_HINT, "Calling isn't available while viewing another account.");
  assertEquals(tab("sms").enabled(c), false);
  assertEquals(hint(tab("sms"), c), CRM_VIEWING_TEXT_HINT);
  // FIRST: even when everything else is also wrong, view-as is the reason given.
  const worst = ctx({ viewing: true, canCall: false, phone: { on: false }, contact: {}, crmUnlocked: false, canEdit: false });
  assertEquals(hint(tab("call"), worst), CRM_VIEWING_CALL_HINT);
  assertEquals(hint(tab("sms"), worst), CRM_VIEWING_TEXT_HINT);
});

Deno.test("each other reason Call is off names itself, in order", () => {
  assertEquals(tab("call").enabled(ctx({ canCall: false })), false);
  assert(/permission to make calls/.test(hint(tab("call"), ctx({ canCall: false }))));
  assertEquals(tab("call").enabled(ctx({ phone: { on: false } })), false);
  assert(/isn't switched on for this account/.test(hint(tab("call"), ctx({ phone: { on: false } }))));
  assertEquals(tab("call").enabled(ctx({ contact: { id: "c1" } })), false);
  assert(/no phone number/.test(hint(tab("call"), ctx({ contact: { id: "c1" } }))));
  // Precedence: permission before the account switch before the contact's data.
  assert(/permission/.test(hint(tab("call"), ctx({ canCall: false, phone: { on: false }, contact: {} }))));
  assert(/switched on/.test(hint(tab("call"), ctx({ phone: { on: false }, contact: {} }))));
  // None of Call's reasons blame the CRM subscription (it is not a CRM action).
  for (const c of [ctx({ canCall: false }), ctx({ phone: { on: false } }), ctx({ contact: {} })]) {
    assert(!/subscription/i.test(hint(tab("call"), c)));
  }
});

Deno.test("SMS outside view-as is exactly what it was", () => {
  assertEquals(tab("sms").enabled(ctx()), true);
  assertEquals(tab("sms").enabled(ctx({ needsPick: true })), false);
  assertEquals(tab("sms").enabled(ctx({ sms: { ready: false } })), false);
  assert(/carrier registration/.test(hint(tab("sms"), ctx({ sms: { ready: false } }))));
});

// ── 01-core's phone helpers ────────────────────────────────────────────────────────────────
// Sliced from the SSS PHONE block through the settings-tabs comment that follows it. `window`,
// `navigator` and `ssIsBetaHost` are injected so the slice runs outside a browser.
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "SSS PHONE helpers");
type Win = { SS_PHONE_EXTENSION_IDS?: unknown; chrome?: unknown; location: { href: string } };
function helpers(win: Win, nav: Record<string, unknown> = { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140" }, beta = false) {
  return new Function("window", "navigator", "ssIsBetaHost", `${PHONE_BLOCK};
    return { ssOwnPhoneOnly, ssPhoneOffered, ssPhoneLinkReady, SS_PHONE_LINKS, ssPhoneExtensionIds, ssPhonePing,
      ssPhoneSend, ssPhoneRefusal, ssIsPhoneBrowser, ssPhoneE164, ssPhoneIsEmergency, ssPhoneDeepLink };`,
  )(win, nav, () => beta);
}

Deno.test("ssOwnPhoneOnly mirrors the server's FAIL-CLOSED ownPhoneOnly", () => {
  const h = helpers({ location: { href: "" } });
  assertEquals(h.ssOwnPhoneOnly({ phone: "view" }), false);
  assertEquals(h.ssOwnPhoneOnly({ phone: "edit" }), false);
  assertEquals(h.ssOwnPhoneOnly({ phone: "own" }), true);
  assertEquals(h.ssOwnPhoneOnly({ phone: "none" }), true);
  assertEquals(h.ssOwnPhoneOnly({}), true);
  assertEquals(h.ssOwnPhoneOnly(null), true);
});

Deno.test("ssPhoneOffered: on for the tenant, an operator viewing, or a beta host — never a production builder with calling off", () => {
  const prod = helpers({ location: { href: "" } }, undefined, false);
  assertEquals(prod.ssPhoneOffered("on", false), true);
  assertEquals(prod.ssPhoneOffered("off", false), false);
  assertEquals(prod.ssPhoneOffered(null, false), false);
  assertEquals(prod.ssPhoneOffered("off", true), true);
  const beta = helpers({ location: { href: "" } }, undefined, true);
  assertEquals(beta.ssPhoneOffered("off", false), true);
});

Deno.test("the extension IDs: the unpacked dev build's stable id by default, an injected real-shaped ID wins, junk is ignored", () => {
  const defaults: Win = { location: { href: "" } };
  const h = helpers(defaults);
  assert(Array.isArray(defaults.SS_PHONE_EXTENSION_IDS), "the config constant was not created");
  // The dev build's id (a fixed manifest key keeps it stable). The store id is ADDED here, first,
  // when SSS Phone is published; the comment above the constant says so.
  assertEquals(defaults.SS_PHONE_EXTENSION_IDS, ["ipiccbfkkbenmiaiaoecbhbjalkbikjk"]);
  assertEquals(h.ssPhoneExtensionIds(), ["ipiccbfkkbenmiaiaoecbhbjalkbikjk"], "a real Chrome id shape, so it IS messaged");
  assert(/add the Chrome Web Store id to this list, FIRST/.test(CORE), "the note to add the store id is next to the constant");
  assert(!h.ssPhoneLinkReady(h.SS_PHONE_LINKS.chrome), "a placeholder store link must read as not ready");
  const injected: Win = { location: { href: "" }, SS_PHONE_EXTENSION_IDS: ["abcdefghijklmnopabcdefghijklmnop", "not-an-id", 7] };
  assertEquals(helpers(injected).ssPhoneExtensionIds(), ["abcdefghijklmnopabcdefghijklmnop"]);
});

const EXT = "abcdefghijklmnopabcdefghijklmnop";
function chromeStub(answer: (msg: Record<string, unknown>) => unknown, sent: unknown[][]) {
  const runtime: Record<string, unknown> = { lastError: undefined };
  runtime.sendMessage = (id: string, msg: Record<string, unknown>, cb: (r: unknown) => void) => {
    sent.push([id, msg]);
    const r = answer(msg);
    setTimeout(() => {
      if (r === "__no_extension__") { runtime.lastError = { message: "Could not establish connection." }; cb(undefined); runtime.lastError = undefined; }
      else cb(r);
    }, 1);
  };
  return { runtime };
}

Deno.test("bridge: not installed → installed:false, and nothing but a ping was sent", async () => {
  const sent: unknown[][] = [];
  const h = helpers({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chromeStub(() => "__no_extension__", sent) });
  const out = await h.ssPhoneSend("sss.call", { to_e164: "+15555550100" });
  assertEquals(out, { installed: false, reply: null });
  assertEquals(sent.map((s) => (s[1] as { type: string }).type), ["sss.ping"]);
});

Deno.test("bridge: no chrome.runtime at all (Safari, Firefox) → installed:false without throwing", async () => {
  const h = helpers({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT] });
  assertEquals(await h.ssPhoneSend("sss.call", {}), { installed: false, reply: null });
});

Deno.test("bridge: installed → ping, then the call carries all four SPEC fields", async () => {
  const sent: unknown[][] = [];
  const h = helpers({
    location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT],
    chrome: chromeStub((m) => (m.type === "sss.ping" ? { ok: true, version: "0.1.0", user_id: "u1", client_id: "demo-tenant" } : { ok: true }), sent),
  });
  const payload = { to_e164: "+15555550100", contact_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", client_id: "demo-tenant" };
  const out = await h.ssPhoneSend("sss.call", payload);
  assertEquals(out, { installed: true, reply: { ok: true } });
  assertEquals(sent.length, 2);
  assertEquals(sent[1], [EXT, { type: "sss.call", ...payload }]);
});

Deno.test("bridge: a refusal comes back as the extension's error, and reads as words", async () => {
  const sent: unknown[][] = [];
  const h = helpers({
    location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT],
    chrome: chromeStub((m) => (m.type === "sss.ping" ? { ok: true } : { ok: false, error: "wrong_user", signed_in_as: "Robin Example" }), sent),
  });
  const out = await h.ssPhoneSend("sss.call", {});
  assertEquals(out.reply.error, "wrong_user");
  assertEquals(h.ssPhoneRefusal(out.reply), "SSS Phone on this computer is signed in as Robin Example. Sign in to SSS Phone as yourself, then try again.");
  for (const code of ["signed_out", "no_access", "busy", "bad_request", "emergency_blocked", "no_reply", "something_new"]) {
    const words = h.ssPhoneRefusal({ ok: false, error: code });
    assert(words.length > 20 && !/undefined|null/.test(words), `${code}: ${words}`);
  }
});

Deno.test("ssPhoneE164, the emergency guard, and the app deep link", () => {
  const h = helpers({ location: { href: "" } });
  assertEquals(h.ssPhoneE164("(555) 555-0100"), "+15555550100");
  assertEquals(h.ssPhoneE164("1-555-555-0100"), "+15555550100");
  assertEquals(h.ssPhoneE164("+44 20 7946 0000"), "+442079460000");
  assertEquals(h.ssPhoneE164("555-0100"), "");
  assertEquals(h.ssPhoneE164(null), "");
  for (const n of ["911", "9-1-1", "933", "112"]) assert(h.ssPhoneIsEmergency(n), n);
  assert(!h.ssPhoneIsEmergency("(555) 555-0100"));
  // SPEC section 7: `ts` is when the page made the link (epoch ms); the app drops one over a
  // minute old, so a replayed link never offers a call nobody just asked for.
  const link = h.ssPhoneDeepLink("call", { to_e164: "+15555550100", contact_id: "c1", user_id: "u1", client_id: "demo-tenant" }, 1790000000000);
  assertEquals(link, "sssphone://call?to=%2B15555550100&contact_id=c1&user_id=u1&client_id=demo-tenant&ts=1790000000000");
  const before = Date.now();
  const live = new URL(h.ssPhoneDeepLink("call", { to_e164: "+15555550100" }).replace("sssphone://", "https://x/"));
  const ts = Number(live.searchParams.get("ts"));
  assert(/^\d{13}$/.test(String(live.searchParams.get("ts"))) && ts >= before && ts <= Date.now(), `ts is Date.now(): ${live.searchParams.get("ts")}`);
});

Deno.test("ssIsPhoneBrowser: phones and iPads yes, desktops no", () => {
  const is = (nav: Record<string, unknown>) => helpers({ location: { href: "" } }, nav).ssIsPhoneBrowser();
  assertEquals(is({ userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile" }), true);
  assertEquals(is({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assertEquals(is({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }), true);
  assertEquals(is({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 }), false);
  assertEquals(is({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140", userAgentData: { mobile: false } }), false);
});

// ── portal-settings: the phone GATES are what the plan says ────────────────────────────────
Deno.test("portal-settings gates the phone actions on the phone area (edit to change, view to read)", async () => {
  const src = (await Deno.readTextFile(new URL("../../supabase/functions/portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const want: Record<string, string> = {
    phone_settings_get: "view", phone_calls_report: "view",
    phone_settings_save: "edit", phone_status_set: "edit", phone_signout_user: "edit",
  };
  for (const [action, level] of Object.entries(want)) {
    const re = new RegExp(`\\n\\s*${action}:\\s*\\{\\s*area:\\s*"phone",\\s*level:\\s*"${level}"\\s*\\}`);
    assert(re.test(src), `GATES.${action} should be phone:${level}`);
    assert(src.includes(`action === "${action}"`), `no branch handles ${action}`);
  }
  // The Team reads ask the LITERAL level before handing over anything team-wide.
  const report = slice(src, 'if (action === "phone_calls_report")', "// ── QuickBooks Online", "phone_calls_report branch");
  assert(/wantTeam && ownPhoneOnly\(access\)/.test(report), "the report's Team scope must ask ownPhoneOnly");
  assert(/if \(ownContacts\)/.test(report), "the report must apply the contacts:'own' row scope");
  const get = slice(src, 'if (action === "phone_settings_get")', 'if (action === "phone_settings_save")', "phone_settings_get branch");
  assert(/if \(ownPhoneOnly\(access\)\)/.test(get), "the setup read must answer an 'own' caller with their own slice");
});
