// My Synergy Phone — portal-settings' pure rules (supabase/functions/portal-settings/phone.ts).
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture (555-01xx numbers, made-up uuids): this repo is
// public, so no client name, number or SID may appear in a test either.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildCallsReport, keepForOwnScope, nanpE164, parseBusinessHours, parseGreetingUrl, parseRoute,
  phoneLevelOf, validTimeZone, type ReportCall, type ReportText,
} from "../../supabase/functions/portal-settings/phone.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const OUTSIDER = "00000000-0000-4000-8000-0000000000ff";

Deno.test("nanpE164 accepts the ways a US number is typed and refuses the rest", () => {
  assertEquals(nanpE164("(555) 555-0100"), "+15555550100");
  assertEquals(nanpE164("555.555.0100"), "+15555550100");
  assertEquals(nanpE164("+1 555 555 0100"), "+15555550100");
  assertEquals(nanpE164("15555550100"), "+15555550100");
  // Area code / exchange starting 0 or 1 is not a real NANP number.
  assertEquals(nanpE164("(155) 555-0100"), null);
  assertEquals(nanpE164("(555) 155-0100"), null);
  // Outside the US and Canada: refused at the door, because the geo permissions would refuse
  // every forwarded call anyway.
  assertEquals(nanpE164("+44 20 7946 0000"), null);
  assertEquals(nanpE164(""), null);
  assertEquals(nanpE164("911"), null);
});

Deno.test("validTimeZone takes real IANA zones only", () => {
  assert(validTimeZone("America/Chicago"));
  assert(validTimeZone("Pacific/Honolulu"));
  assert(!validTimeZone("Mars/Olympus_Mons"));
  assert(!validTimeZone("America/Chicago; drop table"));
  assert(!validTimeZone(""));
  assert(!validTimeZone(42));
});

Deno.test("business hours: null is ALWAYS OPEN and {} is CLOSED ALL WEEK — never collapsed", () => {
  const open = parseBusinessHours(null);
  assert(open.ok);
  assertEquals(open.ok && open.value, null);
  const closed = parseBusinessHours({});
  assert(closed.ok);
  assertEquals(closed.ok && closed.value, {});
});

Deno.test("business hours: periods are validated, sorted, and empty days dropped", () => {
  const r = parseBusinessHours({ mon: [["13:00", "17:00"], ["08:00", "12:00"]], sun: [] });
  assert(r.ok);
  assertEquals(r.ok && r.value, { mon: [["08:00", "12:00"], ["13:00", "17:00"]] });
});

Deno.test("business hours: each kind of bad input names the day and the problem", () => {
  const bad = (v: unknown) => { const r = parseBusinessHours(v); assert(!r.ok); return (r as { error: string }).error; };
  assert(/closing time has to be after/.test(bad({ tue: [["17:00", "08:00"]] })));
  assert(/Tuesday/.test(bad({ tue: [["17:00", "08:00"]] })));
  assert(/overlap/.test(bad({ wed: [["08:00", "12:00"], ["11:00", "15:00"]] })));
  assert(/hours and minutes/.test(bad({ thu: [["8am", "5pm"]] })));
  assert(/not in a shape/.test(bad({ funday: [["08:00", "17:00"]] })));
  assert(/not in a shape/.test(bad([["08:00", "17:00"]])));
  assert(/more than 4/.test(bad({ fri: [["01:00", "02:00"], ["03:00", "04:00"], ["05:00", "06:00"], ["07:00", "08:00"], ["09:00", "10:00"]] })));
});

Deno.test("greeting must be an https link, or empty for the standard greeting", () => {
  const empty = parseGreetingUrl("  ");
  assert(empty.ok && empty.value === null);
  const good = parseGreetingUrl("https://example.test/greeting.mp3");
  assert(good.ok && good.value === "https://example.test/greeting.mp3");
  assert(!parseGreetingUrl("http://example.test/greeting.mp3").ok);
  assert(!parseGreetingUrl("javascript:alert(1)").ok);
  assert(!parseGreetingUrl("not a url").ok);
});

Deno.test("parseRoute: a full owner setup becomes the phone_routes row", () => {
  const eligible = new Set([A, B]);
  const r = parseRoute({
    mode: "in_order", members: [B, A, B], ringSeconds: 25, noAnswer: "forward", forwardTo: "(555) 555-0142",
    businessHours: { mon: [["08:00", "17:00"]] }, timeZone: "America/Denver", afterHours: "voicemail",
    greetingUrl: "https://example.test/g.mp3",
  }, eligible);
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  // Order is kept (it IS the ring order) and a double tick collapses.
  assertEquals(r.row.members, [B, A]);
  assertEquals(r.row.mode, "in_order");
  assertEquals(r.row.ring_seconds, 25);
  assertEquals(r.row.forward_to, "+15555550142");
  assertEquals(r.row.business_hours, { mon: [["08:00", "17:00"]] });
  assertEquals(r.row.time_zone, "America/Denver");
});

Deno.test("parseRoute: defaults are the SPEC's column defaults", () => {
  const r = parseRoute({}, new Set());
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.row, {
    mode: "all_at_once", members: [], ring_seconds: 20, no_answer: "voicemail", forward_to: null,
    business_hours: null, time_zone: "America/Chicago", after_hours: "voicemail", greeting_url: null,
  });
});

Deno.test("parseRoute: only people with phone access on THIS team can be assigned", () => {
  const names = new Map([[C, "Casey Example"]]);
  const r = parseRoute({ members: [A, C] }, new Set([A]), names);
  assert(!r.ok);
  assert(/Casey Example doesn't have Phone access/.test((r as { error: string }).error));
  const stranger = parseRoute({ members: [OUTSIDER] }, new Set([A]));
  assert(!stranger.ok);
  const junk = parseRoute({ members: ["not-a-uuid"] }, new Set([A]));
  assert(!junk.ok);
});

Deno.test("parseRoute: at most ten people ring", () => {
  const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
  const r = parseRoute({ members: ids }, new Set(ids));
  assert(!r.ok);
  assert(/Up to 10/.test((r as { error: string }).error));
});

Deno.test("parseRoute: ring time is held to the table's CHECK (5..60)", () => {
  for (const bad of [4, 61, 12.5, "x"]) assert(!parseRoute({ ringSeconds: bad }, new Set()).ok, String(bad));
  for (const good of [5, 60]) assert(parseRoute({ ringSeconds: good }, new Set()).ok, String(good));
});

Deno.test("parseRoute: forwarding needs a number, and a stale one is not kept", () => {
  const missing = parseRoute({ noAnswer: "forward" }, new Set());
  assert(!missing.ok);
  assert(/cell number/.test((missing as { error: string }).error));
  const afterHoursToo = parseRoute({ afterHours: "forward" }, new Set());
  assert(!afterHoursToo.ok);
  // A number left in the field while nothing forwards to it is dropped, not stored: it would
  // otherwise ring somebody's cell the day a switch is flipped.
  const stale = parseRoute({ noAnswer: "voicemail", forwardTo: "(555) 555-0142" }, new Set());
  assert(stale.ok && stale.row.forward_to === null);
  const foreign = parseRoute({ noAnswer: "forward", forwardTo: "+44 20 7946 0000" }, new Set());
  assert(!foreign.ok);
  assert(/US or Canadian/.test((foreign as { error: string }).error));
});

Deno.test("parseRoute: unknown enum values are refused rather than coerced", () => {
  assert(!parseRoute({ mode: "round_robin" }, new Set()).ok);
  assert(!parseRoute({ noAnswer: "hang_up" }, new Set()).ok);
  assert(!parseRoute({ afterHours: "hang_up" }, new Set()).ok);
  assert(!parseRoute({ timeZone: "Nowhere/Land" }, new Set()).ok);
});

Deno.test("phoneLevelOf resolves through access.ts presets, owners absolute", () => {
  assertEquals(phoneLevelOf({ role: "owner", title: "owner", access: { phone: "none" } }), "edit");
  assertEquals(phoneLevelOf({ role: "user", title: "sales_rep", access: null }), "own");
  assertEquals(phoneLevelOf({ role: "user", title: "sales_manager", access: null }), "view");
  assertEquals(phoneLevelOf({ role: "user", title: "crew_member", access: null }), "none");
  // An override on top of the preset.
  assertEquals(phoneLevelOf({ role: "user", title: "crew_member", access: { phone: "own" } }), "own");
});

// ── The Calls report ────────────────────────────────────────────────────────────────────────
const call = (over: Partial<ReportCall>): ReportCall => ({
  id: crypto.randomUUID(), direction: "in", status: "completed", placed_by: null, answered_by: null,
  rang_user_ids: [], duration_s: null, answered_at: null, contact_id: null, ...over,
});

Deno.test("report: a missed call counts against EVERYONE it rang, once in the totals", () => {
  const r = buildCallsReport({
    calls: [call({ status: "missed", rang_user_ids: [A, B, C] })],
    texts: [], voicemailCallIds: new Set(), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }, { userId: B, name: "B" }, { userId: C, name: "C" }],
    includeOthers: true, nameOf: () => "x",
  });
  for (const l of r.lines) { assertEquals(l.missed, 1, l.name); assertEquals(l.callsIn, 1, l.name); }
  assertEquals(r.totals.missed, 1);
  assertEquals(r.totals.callsIn, 1);
});

Deno.test("report: a call a teammate answered is NOT a miss for the others", () => {
  const r = buildCallsReport({
    calls: [call({ status: "completed", rang_user_ids: [A, B], answered_by: B, answered_at: "2026-09-29T15:00:00Z", duration_s: 120 })],
    texts: [], voicemailCallIds: new Set(), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }, { userId: B, name: "B" }],
    includeOthers: true, nameOf: () => "x",
  });
  const [a, b] = r.lines;
  assertEquals([a.callsIn, a.answered, a.missed], [1, 0, 0]);
  assertEquals([b.callsIn, b.answered, b.missed, b.avgSeconds], [1, 1, 0, 120]);
  assertEquals(r.totals.answered, 1);
  assertEquals(r.totals.missed, 0);
});

Deno.test("report: answered with NO answered_by (the forward number took it, or a cold transfer nobody took) is answered, not missed", () => {
  // The Worker writes both shapes: /voice/screen stamps answered_at with no user for the route's
  // forward number, and a cold transfer clears answered_by and keeps answered_at (fileVoicemail:
  // "an answered call that ended in voicemail stays answered").
  const forwarded = call({ status: "completed", rang_user_ids: [A, B], answered_at: "2026-09-29T15:00:00Z", duration_s: 90 });
  const transferVm = call({ status: "completed", rang_user_ids: [A, B], answered_at: "2026-09-29T16:00:00Z", duration_s: 30 });
  // Mid-transfer (answered once, nobody holding it now): neither answered nor missed yet.
  const live = call({ status: "in_progress", rang_user_ids: [A, B], answered_at: "2026-09-29T17:00:00Z" });
  const r = buildCallsReport({
    calls: [forwarded, transferVm, live],
    texts: [], voicemailCallIds: new Set([transferVm.id]), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }, { userId: B, name: "B" }],
    includeOthers: true, nameOf: () => "x",
  });
  for (const l of r.lines) {
    assertEquals([l.callsIn, l.answered, l.missed, l.voicemails], [3, 0, 0, 0], l.name);
  }
  assertEquals([r.totals.callsIn, r.totals.answered, r.totals.missed, r.totals.voicemails], [3, 2, 0, 0]);
  assertEquals(r.totals.avgSeconds, 60);
});

Deno.test("report: voicemails, live calls, outbound and average length", () => {
  const vmCall = call({ status: "voicemail", rang_user_ids: [A] });
  const vmByRow = call({ status: "missed", rang_user_ids: [A] });
  const r = buildCallsReport({
    calls: [
      vmCall, vmByRow,
      // Still ringing: neither answered nor missed yet.
      call({ status: "ringing", rang_user_ids: [A] }),
      // Outbound: one connected (counts toward average), one not (does not drag it to zero).
      call({ direction: "out", placed_by: A, answered_at: "2026-09-29T15:00:00Z", duration_s: 300, status: "completed" }),
      call({ direction: "out", placed_by: A, status: "no_answer" }),
    ],
    texts: [], voicemailCallIds: new Set([vmByRow.id]), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }], includeOthers: false, nameOf: () => "x",
  });
  const a = r.lines[0];
  assertEquals(a.callsIn, 3);
  assertEquals(a.missed, 2);
  assertEquals(a.voicemails, 2);
  assertEquals(a.callsOut, 2);
  assertEquals(a.avgSeconds, 300);
});

Deno.test("report: a transfer lands on someone the number never rang — still their call in", () => {
  const r = buildCallsReport({
    calls: [call({ rang_user_ids: [A], answered_by: C, answered_at: "2026-09-29T15:00:00Z", duration_s: 60 })],
    texts: [], voicemailCallIds: new Set(), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }, { userId: C, name: "C" }], includeOthers: true, nameOf: () => "x",
  });
  const c = r.lines.find((l) => l.userId === C)!;
  assertEquals([c.callsIn, c.answered], [1, 1]);
});

Deno.test("report: texts — sent by sender, received by the customer's assigned owner, unowned only in totals", () => {
  const texts: ReportText[] = [
    { direction: "out", sent_by: A, contact_id: "k1" },
    { direction: "out", sent_by: B, contact_id: "k2" },
    { direction: "in", sent_by: null, contact_id: "k1" },   // owned by A
    { direction: "in", sent_by: null, contact_id: "k3" },   // owned by nobody
    { direction: "in", sent_by: null, contact_id: null },   // unknown number
  ];
  const r = buildCallsReport({
    calls: [], texts, voicemailCallIds: new Set(),
    contactOwner: new Map([["k1", A], ["k3", null]]),
    people: [{ userId: A, name: "A" }, { userId: B, name: "B" }], includeOthers: true, nameOf: () => "x",
  });
  const [a, b] = r.lines;
  assertEquals([a.textsSent, a.textsReceived], [1, 1]);
  assertEquals([b.textsSent, b.textsReceived], [1, 0]);
  assertEquals([r.totals.textsSent, r.totals.textsReceived], [2, 3]);
});

Deno.test("report: someone who has left still gets a line on Team, named, after the team", () => {
  const r = buildCallsReport({
    calls: [call({ direction: "out", placed_by: OUTSIDER, status: "no_answer" })],
    texts: [], voicemailCallIds: new Set(), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }], includeOthers: true, nameOf: () => "Former team member",
  });
  assertEquals(r.lines.map((l) => l.name), ["A", "Former team member"]);
  // …and on "mine" nobody else appears at all.
  const mine = buildCallsReport({
    calls: [call({ direction: "out", placed_by: OUTSIDER, status: "no_answer" })],
    texts: [], voicemailCallIds: new Set(), contactOwner: new Map(),
    people: [{ userId: A, name: "A" }], includeOthers: false, nameOf: () => "x",
  });
  assertEquals(mine.lines.length, 1);
  assertEquals(mine.lines[0].callsOut, 0);
});

Deno.test("keepForOwnScope: the contacts:'own' rule for report rows", () => {
  const vis = new Set(["mine-contact"]);
  assert(keepForOwnScope("mine-contact", vis, false));
  assert(!keepForOwnScope("someone-elses", vis, true));        // a visible-contact rule, not an ownership one
  assert(keepForOwnScope(null, vis, true));                    // their own call to an unknown number
  assert(!keepForOwnScope(null, vis, false));                  // someone else's unknown number
});
