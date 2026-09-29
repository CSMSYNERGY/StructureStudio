// SSS Phone — calls in the CRM timeline (supabase/functions/_shared/crmFeed.ts).
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Two things are pinned: how a phone_calls row turns into a timeline line (type, wording), and
// that the chip in portal/02-sales.jsx asks for EXACTLY the types the server emits — a chip
// naming a type nobody emits fails silently (the changelog-read-0 bug crmFeed.ts documents).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrmFeed, callFeedEvents, callVisibleToOwn, CRM_FEED_TYPES, fmtCallLength, scopeCallRows } from "../../supabase/functions/_shared/crmFeed.ts";

const NAMES: Record<string, string> = {
  "00000000-0000-4000-8000-00000000000a": "Alex Example",
  "00000000-0000-4000-8000-00000000000b": "Blair Example",
};
const nameOf = (id: string) => NAMES[id] ?? "a former team member";
const row = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), direction: "in", status: "completed", from_e164: "+15555550100", to_e164: "+15555550199",
  started_at: "2026-09-29T15:00:00Z", answered_at: null, duration_s: null, placed_by: null, answered_by: null,
  phone_voicemails: null, ...over,
});

Deno.test("fmtCallLength says a length the way a person does", () => {
  assertEquals(fmtCallLength(0), "0s");
  assertEquals(fmtCallLength(42), "42s");
  assertEquals(fmtCallLength(120), "2m");
  assertEquals(fmtCallLength(192), "3m 12s");
  assertEquals(fmtCallLength(3720), "1h 2m");
  assertEquals(fmtCallLength("junk"), "0s");
});

Deno.test("outbound calls are `call`, whatever happened — a missed call is one the CUSTOMER made", () => {
  const [talked, noAnswer, busy, failed] = callFeedEvents([
    row({ direction: "out", placed_by: "00000000-0000-4000-8000-00000000000a", answered_at: "2026-09-29T15:00:05Z", duration_s: 192 }),
    row({ direction: "out", placed_by: "00000000-0000-4000-8000-00000000000a", status: "no_answer" }),
    row({ direction: "out", status: "busy" }),
    row({ direction: "out", status: "failed" }),
  ], nameOf);
  assertEquals([talked.type, noAnswer.type, busy.type, failed.type], ["call", "call", "call", "call"]);
  assertEquals(talked.title, "Call to +15555550199");
  assertEquals(talked.body, "Talked 3m 12s · by Alex Example");
  assertEquals(noAnswer.body, "No answer · by Alex Example");
  assertEquals(busy.body, "Busy");
  assertEquals(failed.body, "Didn't connect");
});

Deno.test("inbound: answered, missed, voicemail and live are told apart", () => {
  const events = callFeedEvents([
    row({ answered_by: "00000000-0000-4000-8000-00000000000b", answered_at: "2026-09-29T15:00:03Z", duration_s: 65 }),
    row({ status: "missed" }),
    row({ status: "voicemail", phone_voicemails: { id: "vm-1", duration_s: 42, transcript: null, listened_at: null, deleted_at: null } }),
    // The embed arriving as an ARRAY (a one-to-many shape) is accepted too.
    row({ status: "missed", phone_voicemails: [{ id: "vm-2", duration_s: 10, transcript: "Call me back about the 12x16.", listened_at: "2026-09-29T16:00:00Z", deleted_at: null }] }),
    row({ status: "voicemail", phone_voicemails: { id: "vm-3", duration_s: 5, transcript: "gone", listened_at: null, deleted_at: "2026-09-29T17:00:00Z" } }),
    row({ status: "ringing" }),
  ], nameOf);
  const [answered, missed, vm, vmArray, vmDeleted, ringing] = events;
  assertEquals(answered.type, "call");
  assertEquals(answered.title, "Call from +15555550100");
  assertEquals(answered.body, "Answered by Blair Example · talked 1m 5s");
  assertEquals(missed.type, "call_missed");
  assertEquals(missed.title, "Missed call from +15555550100");
  assertEquals(vm.type, "voicemail");
  assertEquals(vm.body, "42s message · not listened to yet");
  assertEquals(vm.meta?.voicemailId, "vm-1");
  assertEquals(vmArray.type, "voicemail");
  assertEquals(vmArray.body, "Call me back about the 12x16.");
  assertEquals(vmDeleted.body, "The message was deleted.");
  assertEquals(ringing.type, "call");
  assertEquals(ringing.body, "Ringing");
  for (const e of events) assert(e.id.startsWith("pc:"), e.id);
});

Deno.test("an unknown number and a person who has left both read as words, never as null", () => {
  const [e] = callFeedEvents([row({ direction: "out", to_e164: null, placed_by: "00000000-0000-4000-8000-0000000000ff", status: "no_answer" })], nameOf);
  assertEquals(e.title, "Call to an unknown number");
  assertEquals(e.body, "No answer · by a former team member");
});

// ── buildCrmFeed, end to end against a stub client ──────────────────────────────────────────
// A tiny PostgREST stand-in: every query resolves to the rows registered for its table. Enough
// to prove the slot-14 read lands in the right name (the positional-destructure trap the file
// warns about) and that its names resolve through the shared client_users read.
function stubAdmin(tables: Record<string, unknown[]>, calls: string[]) {
  const builder = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    calls.push(table);
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

Deno.test("buildCrmFeed puts calls in the feed — and texts stay texts, field changes stay field changes", async () => {
  const seen: string[] = [];
  const admin = stubAdmin({
    sms_messages: [{ id: "s1", direction: "in", from_number: "+15555550100", to_number: "+15555550199", body: "hi", status: "received", created_at: "2026-09-29T14:00:00Z" }],
    crm_field_changes: [{ id: "f1", field: "phone", old_value: "1", new_value: "2", changed_by: null, created_at: "2026-09-29T13:00:00Z" }],
    phone_calls: [row({ id: "c1", status: "missed" }), row({ id: "c2", direction: "out", placed_by: "00000000-0000-4000-8000-00000000000a", status: "no_answer" })],
    client_users: [{ user_id: "00000000-0000-4000-8000-00000000000a", full_name: "Alex Example" }],
  }, seen);
  const feed = await buildCrmFeed(admin, "demo-tenant", {
    codes: [], contactId: "11111111-1111-4111-8111-111111111111",
    phone: { level: "team", userId: "00000000-0000-4000-8000-00000000000b" },
  });
  const types = feed.map((e) => e.type).sort();
  assertEquals(types, ["call", "call_missed", "field_change", "sms_in"]);
  const out = feed.find((e) => e.id === "pc:c2")!;
  assertEquals(out.body, "No answer · by Alex Example");
  assert(seen.includes("phone_calls"));
});

Deno.test("no contact, no calls: a design record never reads phone_calls", async () => {
  const seen: string[] = [];
  await buildCrmFeed(stubAdmin({}, seen), "demo-tenant", { codes: ["SS-TEST00001"], contactId: null });
  assert(!seen.includes("phone_calls"));
});

Deno.test("the Calls chip asks for exactly the call types the server emits", async () => {
  const src = (await Deno.readTextFile(new URL("../../portal/02-sales.jsx", import.meta.url))).replace(/\r\n/g, "\n");
  const i = src.indexOf("const CRM_CHIPS = [");
  const j = src.indexOf("];", i);
  assert(i >= 0 && j > i, "CRM_CHIPS moved — re-point this test");
  const chips = new Function(`${src.slice(i, j + 2)}; return CRM_CHIPS;`)() as { key: string; types: string[] | null; when?: (c: unknown) => boolean }[];
  const calls = chips.find((c) => c.key === "calls");
  assert(calls, "no Calls chip in CRM_CHIPS");
  assertEquals(calls!.types, [...CRM_FEED_TYPES.call]);
  // Every type the call mapper can emit is one the chip asks for.
  const emitted = new Set(callFeedEvents([
    row({ direction: "out" }), row({ status: "missed" }), row({ status: "voicemail" }),
    row({ answered_by: "x", answered_at: "2026-09-29T15:00:00Z" }),
  ], nameOf).map((e) => e.type));
  for (const t of emitted) assert(calls!.types!.includes(t), `chip misses emitted type ${t}`);
  // Shown once calling is on, OR once the record has a call — never hiding history that exists.
  assertEquals(calls!.when!({ phone: { on: false }, hasCalls: false }), false);
  assertEquals(calls!.when!({ phone: { on: true }, hasCalls: false }), true);
  assertEquals(calls!.when!({ phone: { on: false }, hasCalls: true }), true);
});

// ── Review SSB-5: the timeline shows calls the way the phone-api Worker does ────────────────
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b", C = "00000000-0000-4000-8000-00000000000c";
const CID = "11111111-1111-4111-8111-111111111111";
const VM_SECRET = "Please call me back about the 12x16 barn, my gate code is 4417.";
const teamCalls = () => [
  row({ id: "mine-out", direction: "out", placed_by: A, status: "completed", answered_at: "2026-09-29T15:00:05Z", duration_s: 60 }),
  row({ id: "theirs-out", direction: "out", placed_by: B, status: "completed", answered_at: "2026-09-29T15:00:05Z", duration_s: 60 }),
  row({ id: "theirs-answered", answered_by: B, answered_at: "2026-09-29T15:00:03Z", duration_s: 30 }),
  row({ id: "i-handed-on", answered_by: B, transferred_from: A, answered_at: "2026-09-29T15:00:03Z", duration_s: 30 }),
  row({ id: "rang-me", status: "missed", rang_user_ids: [A, B] }),
  row({ id: "rang-them", status: "voicemail", rang_user_ids: [B], phone_voicemails: { id: "vm-9", duration_s: 20, transcript: VM_SECRET, listened_at: null, deleted_at: null } }),
];

Deno.test("callVisibleToOwn is the Worker's callIsMine + transferred_from, clause by clause", () => {
  const vis = (id: string, owner: string | null = null) => callVisibleToOwn(A, teamCalls().find((c) => c.id === id), owner);
  assertEquals(vis("mine-out"), true, "placed it");
  assertEquals(vis("theirs-out"), false, "a teammate's outbound call");
  assertEquals(vis("theirs-answered"), false, "a teammate answered it");
  assertEquals(vis("i-handed-on"), true, "handed it on");
  assertEquals(vis("rang-me"), true, "a missed call that rang me, on a contact nobody owns");
  assertEquals(vis("rang-me", C), false, "…but on a contact someone else owns, the missed call is the owner's");
  assertEquals(vis("rang-them", A), true, "a missed call on MY contact is mine even if it rang someone else");
  assertEquals(vis("rang-them"), false, "a voicemail that rang only a teammate");
  assertEquals(callVisibleToOwn(null, teamCalls()[0], null), false, "no user, nothing");
  // The Worker's own copy, so the two cannot drift silently.
  return Deno.readTextFile(new URL("../../workers/phone-api/src/scope.ts", import.meta.url)).then((t) => t.replace(/\r\n/g, "\n")).then((w) => {
    assert(w.includes('if (c.placed_by === userId || c.answered_by === userId) return true;'), "Worker callIsMine changed; update crmFeed callVisibleToOwn");
    assert(w.includes('const unanswered = c.status === "missed" || c.status === "voicemail" || c.status === "ringing";'));
    assert(w.includes("if (c.contact_owner) return c.contact_owner === userId;"));
  });
});

Deno.test("scopeCallRows: none (or nothing said) sees no calls, own sees theirs, team sees all", () => {
  assertEquals(scopeCallRows(teamCalls(), undefined), [], "fails closed");
  assertEquals(scopeCallRows(teamCalls(), { level: "none", userId: A }), []);
  assertEquals(scopeCallRows(teamCalls(), { level: "own", userId: A }).map((c) => c.id), ["mine-out", "i-handed-on", "rang-me"]);
  assertEquals(scopeCallRows(teamCalls(), { level: "team", userId: A }).length, 6);
});

Deno.test("buildCrmFeed: phone:'none' gets no calls and phone_calls is never read; 'own' never sees a teammate's voicemail transcript", async () => {
  const seenNone: string[] = [];
  const none = await buildCrmFeed(stubAdmin({ phone_calls: teamCalls() }, seenNone), "demo-tenant", { codes: [], contactId: CID, phone: { level: "none", userId: A } });
  assertEquals(none.filter((e) => CRM_FEED_TYPES.call.includes(e.type as never)), []);
  assert(!seenNone.includes("phone_calls"), "a person with no phone access does not even read the table");
  const noScope = await buildCrmFeed(stubAdmin({ phone_calls: teamCalls() }, []), "demo-tenant", { codes: [], contactId: CID });
  assertEquals(noScope.filter((e) => e.id.startsWith("pc:")), [], "a caller that forgets to say who is looking gets no calls");

  const own = await buildCrmFeed(stubAdmin({ phone_calls: teamCalls() }, []), "demo-tenant", { codes: [], contactId: CID, phone: { level: "own", userId: A, contactOwner: null } });
  assertEquals(own.filter((e) => e.id.startsWith("pc:")).map((e) => e.id).sort(), ["pc:i-handed-on", "pc:mine-out", "pc:rang-me"]);
  assert(!JSON.stringify(own).includes(VM_SECRET), "a teammate's voicemail transcript must not reach an 'own' viewer");
  assert(!own.some((e) => e.meta && e.meta.voicemailId === "vm-9"), "and no player is offered for it");

  const team = await buildCrmFeed(stubAdmin({ phone_calls: teamCalls() }, []), "demo-tenant", { codes: [], contactId: CID, phone: { level: "team", userId: A } });
  assert(JSON.stringify(team).includes(VM_SECRET), "team level still sees every voicemail");
});

Deno.test("portal-settings passes WHO IS LOOKING to both feeds, from the literal phone level", async () => {
  const SRC = (await Deno.readTextFile(new URL("../../supabase/functions/portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(/level: \(!canRead\("phone"\) \? "none" : ownPhoneOnly\(access\) \? "own" : "team"\)/.test(SRC), "the scope comes from canRead + ownPhoneOnly");
  assert(/buildCrmFeed\(admin, clientId, \{ codes, contactId: contact\?\.id \?\? null, isAdmin: true, phone: phoneFeedScope\(contact\?\.owner_user_id \?\? null\) \}\)/.test(SRC), "crm_record passes the scope and the contact's owner");
  assert(/buildCrmFeed\(admin, clientId, \{ codes, contactId, isAdmin: true, phone: \{ \.\.\.scope0, contactOwner \} \}\)/.test(SRC), "crm_feed passes it too");
  const calls = (SRC.match(/buildCrmFeed\(/g) ?? []).length;
  assertEquals(calls, 2, "every buildCrmFeed call must say who is looking; a new one needs `phone:`");
});
