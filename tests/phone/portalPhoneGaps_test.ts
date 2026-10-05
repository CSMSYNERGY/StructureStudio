// My Synergy Phone — the portal pieces added on 2026-09-29's second pass, tested against the SHIPPED
// source the way portalPhone_test.ts does (slice between stable anchors, fail loudly if they move):
//   * the phone area's labels on the Team switches (ssLevelLabel)
//   * Call on the contact LIST, through the record page's own rules
//   * voicemail playback in the contact timeline (SS_PHONE_API_BASE + ssPhoneFetchVoicemail)
//   * the one call hand-off both of them use (ssPhoneStartCall)
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../portal/01-core.jsx");
const SALES = await read("../../portal/02-sales.jsx");
const INTEG = await read("../../portal/08-integrations.jsx");
const SHELL = await read("../../portal/12-shell.jsx");
const SMS = await read("../../portal/11-sms.jsx");
const FEED = await read("../../supabase/functions/_shared/crmFeed.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`portalPhoneGaps_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// ── ssLevelLabel ───────────────────────────────────────────────────────────────────────────
Deno.test("the Team screen names the phone levels: No access / Own calls / Team calls / Edit", () => {
  const fn = slice(INTEG, "function ssLevelLabel(areaKey, lv) {", "\n}\n", "ssLevelLabel") + "\n}";
  const ssLevelLabel = new Function(`${fn}; return ssLevelLabel;`)() as (a: string, l: string) => string;
  assertEquals(["none", "own", "view", "edit"].map((l) => ssLevelLabel("phone", l)), ["No access", "Own calls", "Team calls", "Edit"]);
  // Nothing else moved.
  assertEquals(ssLevelLabel("contacts", "own"), "Own only");
  assertEquals(ssLevelLabel("orders", "view"), "View");
});

// ── 01-core: the voicemail URL and the shared hand-off ─────────────────────────────────────
const PHONE_BLOCK = slice(CORE, "function ssOwnPhoneOnly(", "// ── The Settings sub-pages", "MY SYNERGY PHONE helpers");
type Win = Record<string, unknown> & { location: { href: string } };
function core(win: Win, nav: Record<string, unknown> = { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140" }) {
  return new Function("window", "navigator", "ssIsBetaHost", `${PHONE_BLOCK};
    return { ssPhoneVoicemailAudioUrl, ssPhoneFetchVoicemail, ssPhoneStartCall };`)(win, nav, () => false) as {
    ssPhoneVoicemailAudioUrl: (id: unknown) => string;
    ssPhoneFetchVoicemail: (id: unknown, token: unknown, f?: typeof fetch) => Promise<string>;
    ssPhoneStartCall: (raw: unknown, ids: Record<string, unknown>, bad?: string) => Promise<Record<string, unknown>>;
  };
}
const VM = "5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5";

Deno.test("PHONE_API_BASE defaults to the SPEC's Worker address, and a value set first wins", () => {
  const w: Win = { location: { href: "" } };
  const h = core(w);
  assertEquals(w.SS_PHONE_API_BASE, "https://phone.structurestudiosuite.com");
  assertEquals(h.ssPhoneVoicemailAudioUrl(VM), `https://phone.structurestudiosuite.com/voicemails/${VM}/audio`);
  const injected: Win = { location: { href: "" }, SS_PHONE_API_BASE: "https://phone-api.example.test" };
  assertEquals(core(injected).ssPhoneVoicemailAudioUrl(VM), `https://phone-api.example.test/voicemails/${VM}/audio`);
  // The sign-in token is SENT there, so a non-https base is never used.
  const http: Win = { location: { href: "" }, SS_PHONE_API_BASE: "http://phone.example.test" };
  core(http);
  assertEquals(http.SS_PHONE_API_BASE, "https://phone.structurestudiosuite.com");
  // The config constant sits next to SS_PHONE_EXTENSION_IDS (SPEC section 5's config shape).
  assert(CORE.indexOf("window.SS_PHONE_API_BASE") - CORE.indexOf("window.SS_PHONE_EXTENSION_IDS = [") < 1200);
});

// Review SSB-7: the Worker logs request URLs (observability on), so a token in the <audio src>
// query string was written to Cloudflare's logs on every play.
Deno.test("the voicemail is fetched with the token in the Authorization header — never in the URL — and played from a blob", async () => {
  const h = core({ location: { href: "" } });
  const seen: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(new Blob([new Uint8Array([0x49, 0x44, 0x33])], { type: "audio/mpeg" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.session.sig";
  const src = await h.ssPhoneFetchVoicemail(VM, TOKEN, f);
  assert(src.startsWith("blob:"), `plays from a blob: URL, got ${src}`);
  URL.revokeObjectURL(src);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, `https://phone.structurestudiosuite.com/voicemails/${VM}/audio`);
  assert(!seen[0].url.includes(TOKEN) && !/access_token/.test(seen[0].url), "the token must not be in the URL");
  assertEquals((seen[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assertEquals(seen[0].init.credentials, "omit");
});

Deno.test("ssPhoneFetchVoicemail asks for nothing it cannot be sure of, and answers failures in words", async () => {
  const h = core({ location: { href: "" } });
  let calls = 0;
  const f = ((_u: string, _i: RequestInit) => { calls++; return Promise.resolve(new Response("{}", { status: 404 })); }) as unknown as typeof fetch;
  assertEquals(h.ssPhoneVoicemailAudioUrl("not-an-id"), "");
  await h.ssPhoneFetchVoicemail("not-an-id", "t", f).then(() => { throw new Error("should refuse"); }, (e) => assert(/isn't available/.test(e.message)));
  await h.ssPhoneFetchVoicemail(VM, "", f).then(() => { throw new Error("should refuse"); }, (e) => assert(/Sign in again/.test(e.message)));
  assertEquals(calls, 0, "no request without an id and a token");
  await h.ssPhoneFetchVoicemail(VM, "t", f).then(() => { throw new Error("should refuse"); }, (e) => assert(/isn't available any more/.test(e.message)));
  const down = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
  await h.ssPhoneFetchVoicemail(VM, "t", down).then(() => { throw new Error("should refuse"); }, (e) => assert(/couldn't be loaded/.test(e.message)));
});

Deno.test("no portal source puts a session token in a URL, and the timeline plays through SsVoicemailPlayer only on a press", () => {
  for (const [name, src] of [["01-core", CORE], ["02-sales", SALES], ["12-shell", SHELL]] as const) {
    assert(!/[?&]access_token=\$\{/.test(src), `${name} builds a URL with ?access_token=`);
  }
  assert(!/accessToken=\{session\.access_token/.test(SHELL), "the shell no longer hands the record page its token");
  const player = slice(SALES, "function SsVoicemailPlayer({ voicemailId }) {", "\n}\n", "SsVoicemailPlayer");
  assert(/const play = async \(\) => \{/.test(player) && /onClick=\{play\}/.test(player), "nothing is fetched until Play is pressed (the Worker marks it heard)");
  assert(/await sb\.auth\.getSession\(\)/.test(player), "the session is read at the press, so a refreshed token is used");
  assert(/URL\.revokeObjectURL\(src\)/.test(player), "the blob is let go");
  assert(/<SsVoicemailPlayer voicemailId=\{e\.meta\.voicemailId\} \/>/.test(SALES));
});

const EXT = "abcdefghijklmnopabcdefghijklmnop";
function chrome(answer: (m: Record<string, unknown>) => unknown, sent: Record<string, unknown>[]) {
  const runtime: Record<string, unknown> = { lastError: undefined };
  runtime.sendMessage = (_id: string, msg: Record<string, unknown>, cb: (r: unknown) => void) => {
    sent.push(msg);
    const r = answer(msg);
    setTimeout(() => {
      if (r === "__none__") { runtime.lastError = { message: "no" }; cb(undefined); runtime.lastError = undefined; }
      else cb(r);
    }, 1);
  };
  return { runtime };
}
const IDS = { contact_id: "c1", user_id: "u1", client_id: "demo-tenant" };

Deno.test("ssPhoneStartCall: 911 and an undialable number stop before anything is sent", async () => {
  const sent: Record<string, unknown>[] = [];
  const h = core({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chrome(() => ({ ok: true }), sent) });
  assertEquals(await h.ssPhoneStartCall("911", IDS), { kind: "error", text: "For emergencies, call 911 from your cell phone." });
  assertEquals(await h.ssPhoneStartCall("555-0100", IDS, "Check it on their record."), { kind: "error", text: "Check it on their record." });
  assertEquals(sent, []);
});

Deno.test("ssPhoneStartCall: installed → the call with all four SPEC fields; missing → install; refused → words", async () => {
  const sent: Record<string, unknown>[] = [];
  const on = core({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chrome((m) => (m.type === "sss.ping" ? { ok: true } : { ok: true }), sent) });
  assertEquals(await on.ssPhoneStartCall("(555) 555-0142", IDS), { kind: "calling", to: "+15555550142" });
  assertEquals(sent[1], { type: "sss.call", to_e164: "+15555550142", ...IDS });
  const none = core({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chrome(() => "__none__", []) });
  assertEquals(await none.ssPhoneStartCall("(555) 555-0142", IDS), { kind: "install", to: "+15555550142" });
  const refused = core({ location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chrome((m) => (m.type === "sss.ping" ? { ok: true } : { ok: false, error: "signed_out" }), []) });
  const r = await refused.ssPhoneStartCall("(555) 555-0142", IDS);
  assertEquals(r.kind, "error");
  assert(/isn't signed in/.test(String(r.text)));
});

Deno.test("ssPhoneStartCall on a phone's browser opens the app by its link and messages no extension", async () => {
  const sent: Record<string, unknown>[] = [];
  const w: Win = { location: { href: "" }, SS_PHONE_EXTENSION_IDS: [EXT], chrome: chrome(() => ({ ok: true }), sent) };
  const h = core(w, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
  assertEquals(await h.ssPhoneStartCall("(555) 555-0142", IDS), { kind: "app", to: "+15555550142" });
  const t0 = Date.now();
  assert(/^mysynergyphone:\/\/call\?to=%2B15555550142&contact_id=c1&user_id=u1&client_id=demo-tenant&ts=\d{13}$/.test(w.location.href), w.location.href);
  const ts = Number(w.location.href.split("&ts=")[1]);
  assert(Math.abs(ts - t0) < 60000, "the link carries the moment it was made (the app drops one over a minute old)");
  assertEquals(sent, []);
});

// ── the contact list ───────────────────────────────────────────────────────────────────────
Deno.test("the list's Call asks the record's own Call tab, and dials through the shared hand-off", () => {
  const list = slice(SALES, "function LeadsTable(", "// ═══", "LeadsTable");
  assert(/const callTab = CRM_TABS\.find\(\(t\) => t\.key === "call"\);/.test(list), "the row must use CRM_TABS' call entry, not a copy of its rules");
  assert(/callTab\.enabled\(c\)/.test(list) && /callTab\.hint/.test(list));
  assert(/ssPhoneStartCall\(g\.phone, \{ contact_id: g\.contactId \|\| null, user_id: userId, client_id: clientId \}/.test(list));
  assert(/callOffered && callTab && g\.phone &&/.test(list), "no Call where calling is not offered, and none for a row with no phone");
  // The record page dials through the same function.
  const rec = slice(SALES, "const startCall = async () => {", "const routeText = async", "CrmRecord.startCall");
  assert(/ssPhoneStartCall\(/.test(rec));
});

Deno.test("the shell feeds the list EXACTLY what it feeds the record's Call tab", () => {
  const list = slice(SHELL, "<LeadsTable key=", "/>", "LeadsTable props");
  const rec = slice(SHELL, "<CrmRecord", "/>", "CrmRecord props");
  for (const prop of [
    'userId={session.user ? session.user.id : null}',
    'canCall={!viewing && (tenant.role === "owner" || ssCanRead(myAccess, "phone"))}',
    'phoneOn={phoneOffered && effPhoneStatus === "on"}',
  ]) {
    assert(list.includes(prop), `LeadsTable is missing ${prop}`);
    assert(rec.includes(prop), `CrmRecord is missing ${prop}`);
  }
  assert(list.includes("callOffered={phoneOffered}") && list.includes("viewing={!!viewing}"));
  // Review SSB-7: the record page no longer takes the session token as a prop (the player reads
  // the session itself at the press, and sends it as a header).
  assert(!rec.includes("accessToken="), "CrmRecord must not be handed the session token");
});

// ── the voicemail player ───────────────────────────────────────────────────────────────────
Deno.test("the timeline plays a voicemail from the Worker, never preloading it, only for someone the Worker serves", () => {
  const i = SALES.indexOf('{e.type === "voicemail" && e.meta && e.meta.voicemailId');
  assert(i > 0, "the voicemail player's anchor moved");
  const player = SALES.slice(i, SALES.indexOf("/>", i) + 2);
  assert(/!e\.meta\.voicemailDeleted/.test(player));
  assert(/ctx\.canCall && ctx\.phone\.on && !ctx\.viewing/.test(player), "not in view-as, not without phone access, not with calling off");
  // Nothing is fetched until Play (the Worker marks a voicemail heard on its first stream): the
  // line renders SsVoicemailPlayer, whose only fetch is inside its onClick (tested above).
  assert(/<SsVoicemailPlayer voicemailId=\{e\.meta\.voicemailId\} \/>/.test(player));
  assert(!/<audio[^>]*src=\{ssPhone/.test(SALES), "no <audio> points straight at the Worker any more");
  // The feed says whether the recording still exists.
  assert(/voicemailDeleted: !!vm\?\.deleted_at/.test(FEED));
});

// ── Settings → Phone offers the phase-6 pieces ─────────────────────────────────────────────
Deno.test("the Phone tab offers Connect and a calling-only number, each only where the server will accept it", () => {
  const view = slice(SMS, "function PhoneSettingsView(", "// ── The Calls page", "PhoneSettingsView");
  assert(/phoneAction\("phone_enable_number", \{ numberId: sel\.id \}\)/.test(view), "Connect names the open number (migration 266)");
  assert(/phoneAction\("phone_search_numbers", \{ areaCode: numQ \}\)/.test(view));
  assert(/phoneAction\("phone_buy_number", \{ phoneNumber: e164 \}\)/.test(view));
  assert(/data\.scope === "team" && !data\.number && data\.canBuyNumber && data\.numbersForSale/.test(view), "buying is offered only to someone canBuyNumber allows");
  assert(/disabled=\{busy \|\| !on \|\| !data\.voiceSetup\}/.test(view), "Connect waits for calling to be on and the server to be set up");
  // Hooks stay above the early returns (React #310).
  const firstReturn = view.indexOf("if (err && !data) return");
  assert(view.indexOf("useState(\"\")") > 0 && view.indexOf("useState(\"\")") < firstReturn);
});
