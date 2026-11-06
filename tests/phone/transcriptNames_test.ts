// My Synergy Phone — the team member's name on a call transcript, instead of "Team" (Carolyn
// 2026-10-23, 24:13: "Customer" can stay). Pinned here:
//   * crmFeed's transcriptTeamUser: who our side of the transcript is, and when it is nobody
//     in particular (a transfer, a message left on the call, nobody answered)
//   * callFeedEvents / buildCrmFeed: a recorded call's line carries `teamSpeaker`, a REAL name or
//     null, never "a former team member"
//   * 01-core's ssTranscriptNamed: only a line's own "Team: " label changes
//   * the Worker still writes "Customer: " / "Team: " labels, which is what the portal relies on
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/
//
// Every value here is an obviously fake fixture: this repo is public.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrmFeed, callFeedEvents, transcriptTeamUser } from "../../supabase/functions/_shared/crmFeed.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../portal/01-core.jsx");
const SALES = await read("../../portal/02-sales.jsx");
const TRANSCRIBE = await read("../../workers/phone-api/src/cron/transcribe.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`transcriptNames_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const SAM = "00000000-0000-4000-8000-0000000000a2";
const NONAME = "00000000-0000-4000-8000-0000000000a3";
const GONE = "00000000-0000-4000-8000-0000000000a4";
const CID = "11111111-1111-4111-8111-111111111111";
const TEAM = { level: "team" as const, userId: JORDAN };
const recRow = { id: "5f0c1d2e-3a4b-4c5d-8e6f-708192a3b4c5", status: "completed", duration_s: 73, summary: "Wants a 10x12.", transcript_status: "done", deleted_at: null };
const call = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), direction: "in", status: "completed", from_e164: "+15555550100", to_e164: "+15555550199",
  started_at: "2026-10-23T17:13:00Z", answered_at: "2026-10-23T17:13:04Z", duration_s: 73,
  placed_by: null, answered_by: null, transferred_from: null, rang_user_ids: [JORDAN, SAM],
  phone_voicemails: null, phone_call_recordings: recRow, ...over,
});

// ── who our side is ─────────────────────────────────────────────────────────────────────────
Deno.test("transcriptTeamUser: the one person who placed or answered the call", () => {
  assertEquals(transcriptTeamUser(call({ direction: "out", placed_by: JORDAN })), JORDAN, "outbound: who placed it");
  assertEquals(transcriptTeamUser(call({ answered_by: SAM })), SAM, "inbound: who answered it");
  assertEquals(transcriptTeamUser(call({ direction: "out", placed_by: JORDAN, answered_by: JORDAN })), JORDAN, "the same person twice is one person");
  assertEquals(transcriptTeamUser(call({ direction: "out", placed_by: JORDAN, answered_by: SAM })), null, "two people on an outbound call");
  // An inbound call's placed_by is not someone on the line (the Worker leaves it null; even set, it is not who spoke).
  assertEquals(transcriptTeamUser(call({ placed_by: JORDAN, answered_by: SAM })), SAM);
});

Deno.test("transcriptTeamUser: a transfer, a message left or nobody answering keeps \"Team\"", () => {
  assertEquals(transcriptTeamUser(call({ answered_by: SAM, transferred_from: JORDAN })), null, "inbound handed on: both spoke on our channel");
  assertEquals(transcriptTeamUser(call({ direction: "out", placed_by: JORDAN, transferred_from: JORDAN, answered_by: SAM })), null, "outbound handed on");
  assertEquals(transcriptTeamUser(call({ answered_by: null, transferred_from: JORDAN })), null, "handed on to a forward number: someone else spoke after them");
  assertEquals(transcriptTeamUser(call({ answered_by: null, transferred_from: JORDAN,
    phone_voicemails: { id: "vm-1", duration_s: 12, transcript: null, listened_at: null, deleted_at: null } })), null, "a transfer nobody took, ended in voicemail");
  assertEquals(transcriptTeamUser(call({ answered_by: SAM, phone_voicemails: [{ id: "vm-2" }] })), null, "a message left on it: the greeting played on our side");
  assertEquals(transcriptTeamUser(call({ status: "voicemail" })), null);
  assertEquals(transcriptTeamUser(call({})), null, "a ring group nobody picked up (or a forward number that did)");
  assertEquals(transcriptTeamUser(call({ direction: "out", placed_by: null })), null);
  assertEquals(transcriptTeamUser(null), null);
});

// ── the timeline line ───────────────────────────────────────────────────────────────────────
const NAMES: Record<string, string> = { [JORDAN]: "Jordan Lee", [SAM]: "Sam Rivera" };
const nameOf = (id: string) => NAMES[id] ?? "a former team member";
const speakerName = (id: string) => NAMES[id] ?? null;

Deno.test("callFeedEvents: a recorded call carries teamSpeaker, a real name or null", () => {
  const [out, inbound, handedOn, left, plain] = callFeedEvents([
    call({ direction: "out", placed_by: JORDAN }),
    call({ answered_by: SAM }),
    call({ answered_by: SAM, transferred_from: JORDAN }),
    call({ answered_by: GONE }),
    call({ direction: "out", placed_by: JORDAN, phone_call_recordings: null }),
  ], nameOf, speakerName);
  assertEquals(out.meta?.teamSpeaker, "Jordan Lee");
  assertEquals(out.body, "Talked 1m 13s · by Jordan Lee", "the line's own words are unchanged");
  assertEquals(inbound.meta?.teamSpeaker, "Sam Rivera");
  assertEquals(handedOn.meta?.teamSpeaker, null);
  assertEquals(left.meta?.teamSpeaker, null, "someone no longer on the team is not \"a former team member\" on a transcript");
  assertEquals(left.body, "Answered by a former team member · talked 1m 13s");
  assert(!("teamSpeaker" in (plain.meta ?? {})), "a call that wasn't recorded gains nothing");
});

Deno.test("callFeedEvents without speakerName adds nothing (the older two-argument call)", () => {
  const [e] = callFeedEvents([call({ direction: "out", placed_by: JORDAN })], nameOf);
  assert(!("teamSpeaker" in (e.meta ?? {})));
});

// A PostgREST stand-in: every query resolves to the rows registered for its table, and the
// client_users reads are recorded (still one for the whole feed).
function stubAdmin(tables: Record<string, unknown[]>, ins: unknown[][]) {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "is", "order", "limit"]) b[m] = () => b;
    b.in = (_col: string, vals: unknown[]) => { if (table === "client_users") ins.push(vals); return b; };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

Deno.test("buildCrmFeed names our side from client_users, and keeps \"Team\" for someone with no name set", async () => {
  const ins: unknown[][] = [];
  const rows = [
    call({ id: "c-out", direction: "out", placed_by: JORDAN }),
    call({ id: "c-noname", answered_by: NONAME }),
    call({ id: "c-handoff", answered_by: JORDAN, transferred_from: SAM }),
  ];
  const feed = await buildCrmFeed(stubAdmin({
    phone_calls: rows,
    client_users: [{ user_id: JORDAN, full_name: "Jordan Lee" }, { user_id: NONAME, full_name: null }, { user_id: SAM, full_name: "Sam Rivera" }],
  }, ins), "demo-tenant", { codes: [], contactId: CID, phone: TEAM });
  const by = (id: string) => feed.find((e) => e.id === `pc:${id}`)!;
  assertEquals(by("c-out").meta?.teamSpeaker, "Jordan Lee");
  assertEquals(by("c-noname").meta?.teamSpeaker, null, "a user from before full_name existed");
  assertEquals(by("c-noname").body, "Answered by a team member · talked 1m 13s");
  assertEquals(by("c-handoff").meta?.teamSpeaker, null, "handed on: two of us spoke on that channel");
  assertEquals(by("c-handoff").body, "Answered by Jordan Lee · talked 1m 13s");
  assertEquals(ins.length, 1, "still ONE client_users read for the whole feed");
});

// ── 01-core: the display ────────────────────────────────────────────────────────────────────
const NAMED = slice(CORE, "function ssTranscriptNamed(", "\n}\n", "ssTranscriptNamed") + "\n}\n";
const ssTranscriptNamed = new Function(`${NAMED}; return ssTranscriptNamed;`)() as (t: unknown, n: unknown) => string;

Deno.test("ssTranscriptNamed puts the name on our side's lines and leaves the customer's alone", () => {
  const t = "Customer: Hi, I'm calling about a shed.\nTeam: Sure, what size?\nCustomer: Ten by twelve. Team: are you open Saturday?\nTeam: We are.";
  assertEquals(ssTranscriptNamed(t, "Jordan Lee"),
    "Customer: Hi, I'm calling about a shed.\nJordan Lee: Sure, what size?\nCustomer: Ten by twelve. Team: are you open Saturday?\nJordan Lee: We are.");
  assertEquals(ssTranscriptNamed(t, null), t, "no name keeps \"Team\"");
  assertEquals(ssTranscriptNamed(t, "   "), t);
  assertEquals(ssTranscriptNamed("Team: Hello.", "Pat $& Co"), "Pat $& Co: Hello.", "a name is text, never a replacement pattern");
  assertEquals(ssTranscriptNamed("Team: Hello.", " Jordan\n Lee "), "Jordan Lee: Hello.", "a name never breaks a line");
  assertEquals(ssTranscriptNamed("Teamwork: no.\nTeam:no space", "Jordan Lee"), "Teamwork: no.\nTeam:no space", "only the exact label");
  assertEquals(ssTranscriptNamed(null, "Jordan Lee"), "");
});

Deno.test("the record's transcript box shows the named text, from the feed's teamSpeaker", () => {
  const comp = slice(SALES, "function SsCallRecording(", "\n}\n", "SsCallRecording");
  assert(comp.includes("{ssTranscriptNamed(text, meta.teamSpeaker)}"), "the box renders the named transcript");
  assert(!/>\s*\{text\}\s*</.test(comp), "and not the raw text");
});

Deno.test("the Worker still labels lines \"Customer: \" and \"Team: \", the labels the portal renames", () => {
  assert(TRANSCRIBE.includes('const line = `${l.who === "customer" ? "Customer" : "Team"}: ${l.text}`;'),
    "cron/transcribe.ts transcriptOf changed its labels: update ssTranscriptNamed to match");
  assert(TRANSCRIBE.includes("out ? `${out}\\n${line}` : line"), "one speaker turn per line, joined with \\n");
});
