// The Conversations inbox's rules (crmInbox.ts): what a row says, which customers a page holds, and
// how the pages join up. portal-settings' crm_inbox only reaches the tables; everything pinned
// here is what it does with them.
//
// The heart of it is the WALK: a few thousand messages across the four tables, read page after
// page through buildInbox exactly as the portal reads them, and checked against the answer worked
// out by hand from the same rows. Every customer must appear exactly once, on the right page, with
// their true newest message, in newest-first order, under every filter, with the Mine toggle, for
// someone who sees only some customers or only some calls, and with rows that share a timestamp
// right where a read stops.
//
// The tables are held in memory by FakeSource, which answers the way PostgREST does for the
// queries portal-settings makes (newest first, below the cursor, up to the limit; ties come back
// in whatever order, here deliberately the least convenient one).
//
// Dependency-free like the other _shared tests. Every id, name and address is made up: the repo is
// public.

import {
  afterAt, awaitingReply, buildInbox, callLabel, canonAt, chunked, fmtClock, INBOX_AT_COLUMN, INBOX_EMAIL_KINDS,
  INBOX_PAGE, INBOX_SCAN, InboxReadError, inboxTables, parseInboxRequest, smsPreview,
  type InboxContact, type InboxEvent, type InboxFilter, type InboxRequest, type InboxSource, type InboxTable,
  type InboxThread, type InboxViewer,
} from "./crmInbox.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function same(got: unknown, want: unknown, msg: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg}: expected ${w}, got ${g}`);
}
async function rejects(p: Promise<unknown>, msg: string): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error(msg);
}

// deno-lint-ignore no-explicit-any
type Row = any;
const ME = "00000000-0000-4000-8000-00000000a001";
const OTHER = "00000000-0000-4000-8000-00000000a002";
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A canonical stamp `micros` microseconds after a fixed start. */
const T0 = Date.parse("2026-09-01T00:00:00Z");
const at = (micros: number) => `${new Date(T0 + Math.floor(micros / 1000)).toISOString().slice(0, 19)}.${String((Math.floor(micros / 1000) % 1000) * 1000 + (micros % 1000)).padStart(6, "0")}Z`;

// ── The rows' own wording ───────────────────────────────────────────────────────────────────────

Deno.test("the request: defaults, refusals, and a cursor kept to the microsecond", () => {
  same(parseInboxRequest({}), { channel: "all", mine: false, cursor: null }, "nothing asked");
  same(parseInboxRequest({ channel: "sms", mine: true }), { channel: "sms", mine: true, cursor: null }, "texts, mine");
  same(parseInboxRequest({ mine: "yes" }), { channel: "all", mine: false, cursor: null }, "only true is mine");
  assert("error" in parseInboxRequest({ channel: "texts" }), "a filter the inbox doesn't know was read as something");
  assert("error" in parseInboxRequest({ channel: "all", cursor: "yesterday" }), "a junk cursor was accepted");
  assert("error" in parseInboxRequest({ cursor: 12345 }), "a number was accepted as a cursor");
  const r = parseInboxRequest({ cursor: "2026-10-01T12:00:00.123456+00:00" });
  same(r, { channel: "all", mine: false, cursor: "2026-10-01T12:00:00.123456Z" }, "cursor");
});

Deno.test("timestamps: one shape, microseconds kept, offsets applied, so they sort as strings", () => {
  same(canonAt("2026-10-01T12:00:00.123456+00:00"), "2026-10-01T12:00:00.123456Z", "postgres");
  same(canonAt("2026-10-01 12:00:00.12+00"), "2026-10-01T12:00:00.120000Z", "short offset");
  same(canonAt("2026-10-01T08:00:00-04:00"), "2026-10-01T12:00:00.000000Z", "offset applied");
  same(canonAt("2026-10-01T12:00:00Z"), "2026-10-01T12:00:00.000000Z", "no fraction");
  same(canonAt("2026-10-01T12:00:00.1234567Z"), "2026-10-01T12:00:00.123456Z", "nanoseconds cut");
  same([canonAt("nope"), canonAt(null), canonAt(5)], [null, null, null], "not timestamps");
  // The case a millisecond cursor gets wrong: these two are 200 microseconds apart.
  assert(canonAt("2026-10-01T12:00:00.123200Z")! < canonAt("2026-10-01T12:00:00.123456Z")!, "micro order lost");
  same(afterAt("2026-10-01T12:00:00.123456Z"), "2026-10-01T12:00:00.123457Z", "one microsecond on");
  same(afterAt("2026-10-01T23:59:59.999999Z"), "2026-10-02T00:00:00.000000Z", "carry into the next second");
});

Deno.test("a text's preview: its first words on one line; a picture says so", () => {
  same(smsPreview("  Is the\n12x16   still\tavailable? "), "Is the 12x16 still available?", "collapsed");
  const long = smsPreview("x".repeat(300));
  assert(long.length === 140 && long.endsWith("…"), `cut to 140: ${long.length}`);
  same(smsPreview("", 1), "Picture message", "picture");
  same(smsPreview(null), "Text message", "empty");
});

Deno.test("a call's line says what happened and never what was said", () => {
  same(fmtClock(192), "3:12", "clock");
  same(fmtClock(3720), "1:02:00", "hours");
  const c = (o: Row) => ({ direction: "in", status: "completed", answered_at: null, answered_by: null, duration_s: null, phone_voicemails: null, ...o });
  same(callLabel(c({ answered_by: ME, answered_at: "x", duration_s: 192 })), "Call 3:12", "answered in");
  same(callLabel(c({ direction: "out", answered_at: "x", duration_s: 65 })), "Call 1:05", "answered out");
  same(callLabel(c({ direction: "out", status: "no_answer" })), "Call, no answer", "out, no answer");
  same(callLabel(c({ direction: "out", status: "busy" })), "Call, busy", "busy");
  same(callLabel(c({ direction: "out", status: "failed" })), "Call didn't connect", "failed");
  same(callLabel(c({ status: "missed" })), "Missed call", "missed");
  same(callLabel(c({ status: "ringing" })), "Call in progress", "live");
  const said = "Hi, it's Pat, call me back about the gambrel please";
  same(callLabel(c({ status: "missed", phone_voicemails: { id: "vm1", transcript: said } })), "Voicemail", "voicemail embed");
  same(callLabel(c({ status: "voicemail", phone_voicemails: [{ id: "vm2", transcript: said }] })), "Voicemail", "voicemail array");
});

Deno.test("waiting on you: the customer spoke last and nobody has answered", () => {
  const e = (o: Partial<InboxEvent>): InboxEvent => ({ contactId: "c", at: at(1), channel: "email", direction: "in", preview: "", byMe: false, handled: false, ...o });
  same([
    awaitingReply(e({})), awaitingReply(e({ channel: "sms" })), awaitingReply(e({ direction: "out" })),
    awaitingReply(e({ channel: "calls", handled: false })), awaitingReply(e({ channel: "calls", handled: true })),
  ], [true, true, false, true, false], "awaiting");
});

Deno.test("which tables each filter reads, and calls only for someone who may see them", () => {
  same(inboxTables("all", true), ["sms", "emailIn", "emailOut", "calls"], "all");
  same(inboxTables("all", false), ["sms", "emailIn", "emailOut"], "all, no phone");
  same(inboxTables("email", true), ["emailIn", "emailOut"], "email");
  same(inboxTables("sms", true), ["sms"], "texts");
  same(inboxTables("calls", false), [], "calls without phone access reads nothing");
  same(chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], "chunks");
});

// ── The tables, in memory ───────────────────────────────────────────────────────────────────────

type Tables = Record<InboxTable, Row[]>;
const TABLE_KEYS: InboxTable[] = ["sms", "emailIn", "emailOut", "calls"];

class FakeSource implements InboxSource {
  log: { table: string; ids?: number; cursor?: string | null }[] = [];
  constructor(
    public t: Tables,
    public people: InboxContact[],
    // seesCalls: portal-settings' everByMe reads phone_calls only for someone with phone access.
    public o: { visible?: Set<string> | null; merged?: Set<string>; me?: string | null; seesCalls?: boolean } = {},
  ) {}
  // deno-lint-ignore require-await
  async scan(table: InboxTable, cursor: string | null, limit: number): Promise<Row[]> {
    this.log.push({ table, cursor });
    const col = INBOX_AT_COLUMN[table];
    // Ties come back in REVERSE insertion order: whatever order the database picks, the page
    // edges must not depend on it.
    return this.t[table]
      .map((r, i) => [r, i] as const)
      .filter(([r]) => r.contact_id && (!cursor || r[col] < cursor) && (table !== "emailOut" || INBOX_EMAIL_KINDS.includes(r.kind)))
      .sort(([a, i], [b, j]) => (a[col] < b[col] ? 1 : a[col] > b[col] ? -1 : j - i))
      .slice(0, limit)
      .map(([r]) => r);
  }
  // deno-lint-ignore require-await
  async newer(table: InboxTable, ids: string[], cursor: string): Promise<Row[]> {
    this.log.push({ table: `newer:${table}`, ids: ids.length });
    const col = INBOX_AT_COLUMN[table];
    return this.t[table].filter((r) => ids.includes(r.contact_id) && r[col] >= cursor
      && (table !== "emailOut" || INBOX_EMAIL_KINDS.includes(r.kind))).slice(0, 1000);
  }
  // deno-lint-ignore require-await
  async contacts(ids: string[]): Promise<InboxContact[]> {
    return this.people.filter((c) => ids.includes(c.id) && !this.o.merged?.has(c.id));
  }
  // deno-lint-ignore require-await
  async visible(ids: string[]): Promise<Set<string> | null> {
    if (this.o.visible === null) return null;
    return new Set(ids.filter((id) => !this.o.visible || this.o.visible.has(id)));
  }
  // deno-lint-ignore require-await
  async everByMe(ids: string[]): Promise<Set<string>> {
    const me = this.o.me ?? ME;
    const out = new Set<string>();
    for (const r of this.t.sms) if (ids.includes(r.contact_id) && r.sent_by === me) out.add(r.contact_id);
    for (const r of this.t.emailOut) if (ids.includes(r.contact_id) && r.sent_by === me && INBOX_EMAIL_KINDS.includes(r.kind)) out.add(r.contact_id);
    if (this.o.seesCalls !== false) {
      for (const r of this.t.calls) if (ids.includes(r.contact_id) && (r.placed_by === me || r.answered_by === me)) out.add(r.contact_id);
    }
    return out;
  }
}

const empty = (): Tables => ({ sms: [], emailIn: [], emailOut: [], calls: [] });
const person = (n: number, owner: string | null = null, name: string | null = `Customer ${n}`): InboxContact =>
  ({ id: cid(n), name, owner_user_id: owner, email: `customer${n}@example.test`, phone: `+1555555${String(n).padStart(4, "0")}` });
const text = (n: number, m: number, o: Row = {}) => ({ id: `t${n}-${m}`, contact_id: cid(n), direction: "in", body: `text ${m}`, num_media: 0, sent_by: null, created_at: at(m), ...o });
const mailIn = (n: number, m: number, o: Row = {}) => ({ id: `i${n}-${m}`, contact_id: cid(n), subject: `re: quote ${m}`, received_at: at(m), ...o });
const mailOut = (n: number, m: number, o: Row = {}) => ({ id: `o${n}-${m}`, contact_id: cid(n), kind: "conversation", subject: `quote ${m}`, sent_by: ME, created_at: at(m), ...o });
const call = (n: number, m: number, o: Row = {}) => ({
  id: `c${n}-${m}`, contact_id: cid(n), direction: "in", status: "missed", started_at: at(m), answered_at: null, duration_s: null,
  placed_by: null, answered_by: null, transferred_from: null, rang_user_ids: [ME], crm_contacts: { owner_user_id: null }, phone_voicemails: null, ...o,
});
const everyone: InboxViewer = { me: ME, seesCalls: true, callVisible: () => true };

async function pages(src: InboxSource, req: Omit<InboxRequest, "cursor">, viewer: InboxViewer = everyone): Promise<InboxThread[][]> {
  const out: InboxThread[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const page: { threads: InboxThread[]; cursor: string | null } = await buildInbox(src, { ...req, cursor }, viewer);
    out.push(page.threads);
    if (!page.cursor) return out;
    assert(!cursor || page.cursor < cursor, `the cursor did not move back: ${cursor} → ${page.cursor}`);
    cursor = page.cursor;
  }
  throw new Error("the walk never ended");
}

// ── Pages, one case at a time ───────────────────────────────────────────────────────────────────

Deno.test("one row per customer, from their newest message, whichever table it is in", async () => {
  const t = empty();
  t.sms.push(text(1, 100), text(1, 300, { direction: "out", sent_by: ME, body: "On its way" }), text(2, 200));
  t.emailIn.push(mailIn(2, 400, { subject: "Paint colours" }), mailIn(3, 50));
  t.calls.push(call(1, 250), call(3, 500, { direction: "out", placed_by: ME, status: "completed", answered_at: "x", duration_s: 192 }));
  const src = new FakeSource(t, [person(1), person(2), person(3)]);
  const [page] = await pages(src, { channel: "all", mine: false });
  same(page.map((r) => [r.name, r.channel, r.direction, r.preview, r.awaitingReply]), [
    ["Customer 3", "calls", "out", "Call 3:12", false],
    ["Customer 2", "email", "in", "Paint colours", true],
    ["Customer 1", "sms", "out", "On its way", false],
  ], "rows");
  same(page[0].at, at(500), "the row's time is its newest message's");
});

Deno.test("the filter: Email shows each customer's newest EMAIL, and reads only the email tables", async () => {
  const t = empty();
  t.sms.push(text(1, 900));
  t.emailOut.push(mailOut(1, 100, { subject: "Your quote" }), mailOut(2, 50, { kind: "estimate" }));
  t.calls.push(call(2, 950));
  const src = new FakeSource(t, [person(1), person(2)]);
  const [page] = await pages(src, { channel: "email", mine: false });
  same(page.map((r) => [r.contactId, r.preview]), [[cid(1), "Your quote"]], "a quote email (kind estimate) is not a conversation");
  same([...new Set(src.log.map((l) => l.table))].sort(), ["emailIn", "emailOut"], "tables read");
  const [texts] = await pages(new FakeSource(t, [person(1), person(2)]), { channel: "sms", mine: false });
  same(texts.map((r) => r.contactId), [cid(1)], "texts");
  const [calls] = await pages(new FakeSource(t, [person(1), person(2)]), { channel: "calls", mine: false });
  same(calls.map((r) => [r.contactId, r.preview]), [[cid(2), "Missed call"]], "calls");
  const noPhone = new FakeSource(t, [person(1), person(2)]);
  const [none] = await pages(noPhone, { channel: "calls", mine: false }, { ...everyone, seesCalls: false });
  same([none, noPhone.log.filter((l) => l.table === "calls").length], [[], 0], "no phone access: phone_calls is not even read");
});

Deno.test("the window: a FULL table ends the page, so an older email can't stand in for a newer text", async () => {
  // 500 texts (a full read) from 30 customers, newest first from time 10,000 down. Customer 1
  // texted just past the end of that read, and emailed earlier still. Customer 2 only emailed,
  // older than the end of the read.
  const t = empty();
  for (let i = 0; i < INBOX_SCAN.sms; i++) t.sms.push(text(100 + (i % 30), 10_000 - i));
  const edge = 10_000 - (INBOX_SCAN.sms - 1);
  t.sms.push(text(1, edge - 5, { body: "the newer text" }));
  t.emailIn.push(mailIn(1, edge - 10, { subject: "the older email" }), mailIn(2, edge - 20));
  const people = [person(1), person(2), ...Array.from({ length: 30 }, (_, i) => person(100 + i))];
  const src = new FakeSource(t, people);
  const first = await buildInbox(src, { channel: "all", mine: false, cursor: null }, everyone);
  same(first.threads.length, 30, "page 1: the thirty texters");
  assert(!first.threads.some((r) => r.contactId === cid(1) || r.contactId === cid(2)), "a customer from past the window's end was on page 1");
  same(first.cursor, afterAt(at(edge)), "page 1 carries on from the window's end");
  const second = await buildInbox(src, { channel: "all", mine: false, cursor: first.cursor }, everyone);
  same(second.threads.map((r) => [r.contactId, r.preview]), [[cid(1), "the newer text"], [cid(2), "re: quote " + (edge - 20)]], "page 2");
  same(second.cursor, null, "and that is the end");
});

Deno.test("page 2: a customer with anything newer was on page 1, so they are left out", async () => {
  // 60 customers, each with one text, newest first: page 1 holds 50. Customer 1 (on page 1 with a
  // new text) also has an old email that falls on page 2.
  const t = empty();
  for (let n = 1; n <= 60; n++) t.sms.push(text(n, 10_000 - n));
  t.emailIn.push(mailIn(1, 100));
  const src = new FakeSource(t, Array.from({ length: 60 }, (_, i) => person(i + 1)));
  const [p1, p2] = await pages(src, { channel: "all", mine: false });
  same(p1.length, INBOX_PAGE, "page 1 is a full page");
  assert(p1.some((r) => r.contactId === cid(1)), "customer 1 was not on page 1");
  same(p2.map((r) => r.contactId), Array.from({ length: 10 }, (_, i) => cid(51 + i)), "page 2: only the ten not yet shown");
  assert(src.log.some((l) => l.table === "newer:sms") && src.log.some((l) => l.table === "newer:emailIn"), "every table read was asked");
});

Deno.test("customers whose newest message shares the page's last timestamp stay on that page", async () => {
  // 49 customers, then three more all stamped at one instant, then one older. A cursor of "older
  // than that instant" would skip two of the three on the next page.
  const t = empty();
  for (let n = 1; n <= 49; n++) t.sms.push(text(n, 10_000 - n));
  for (let n = 50; n <= 52; n++) t.emailIn.push(mailIn(n, 5000));
  t.sms.push(text(53, 4000));
  const src = new FakeSource(t, Array.from({ length: 53 }, (_, i) => person(i + 1)));
  const [p1, p2] = await pages(src, { channel: "all", mine: false });
  same(p1.length, 52, "the tied customers ride along");
  same(p2.map((r) => r.contactId), [cid(53)], "page 2");
});

Deno.test("rows sharing the timestamp a full read stopped at are not lost to the next page", async () => {
  // The text read's last slot falls inside a run of six texts all stamped at once (one
  // transaction): two were read and four were not. Page 1 must leave all six for page 2.
  const t = empty();
  for (let i = 0; i < INBOX_SCAN.sms - 2; i++) t.sms.push(text(1000 + i, 100_000 - i));
  for (let n = 1; n <= 6; n++) t.sms.push(text(n, 50_000));
  const people = [...Array.from({ length: INBOX_SCAN.sms - 2 }, (_, i) => person(1000 + i)), ...Array.from({ length: 6 }, (_, i) => person(i + 1))];
  const src = new FakeSource(t, people);
  const all = (await pages(src, { channel: "sms", mine: false })).flat();
  same(all.filter((r) => r.at === at(50_000)).map((r) => r.contactId).sort(), Array.from({ length: 6 }, (_, i) => cid(i + 1)), "all six");
  same(new Set(all.map((r) => r.contactId)).size, all.length, "nobody twice");
});

Deno.test("a read that is ALL one timestamp still moves on (no endless Load more)", async () => {
  const t = empty();
  for (let n = 1; n <= INBOX_SCAN.sms + 40; n++) t.sms.push(text(n, 7000));
  const src = new FakeSource(t, Array.from({ length: INBOX_SCAN.sms + 40 }, (_, i) => person(i + 1)));
  const walked = await pages(src, { channel: "sms", mine: false });   // throws if it loops
  assert(walked.flat().length >= INBOX_SCAN.sms, `shown ${walked.flat().length}`);
});

Deno.test("contacts:'own': only their customers, and a failed check shows nobody", async () => {
  const t = empty();
  t.sms.push(text(1, 300), text(2, 200), text(3, 100));
  const people = [person(1), person(2), person(3)];
  const [page] = await pages(new FakeSource(t, people, { visible: new Set([cid(2)]) }), { channel: "all", mine: false });
  same(page.map((r) => r.contactId), [cid(2)], "visible only");
  const err = await rejects(buildInbox(new FakeSource(t, people, { visible: null }), { channel: "all", mine: false, cursor: null }, everyone),
    "a failed visibility check returned a page");
  assert(err instanceof InboxReadError && /assigned/.test(err.where), `wrong refusal: ${err}`);
});

Deno.test("a customer merged into another record is not listed", async () => {
  const t = empty();
  t.sms.push(text(1, 300), text(2, 200));
  const [page] = await pages(new FakeSource(t, [person(1), person(2)], { merged: new Set([cid(1)]) }), { channel: "all", mine: false });
  same(page.map((r) => r.contactId), [cid(2)], "merged left out");
});

Deno.test("Mine: my customers, nobody's, and anyone I've been in touch with, ever", async () => {
  // The Email filter, so only the email tables are read for the page. Customers 5 and 6 are kept
  // by a text and a call that this page never reads: "in touch" means ever.
  const t = empty();
  for (let n = 1; n <= 7; n++) t.emailIn.push(mailIn(n, 1000 - n));
  t.emailOut.push(mailOut(4, 10));                                            // I emailed them
  t.sms.push(text(5, 10, { direction: "out", sent_by: ME }));                 // I texted them once
  t.calls.push(call(6, 10, { direction: "out", placed_by: ME, status: "completed" }));   // I called them once
  t.emailOut.push(mailOut(7, 10, { kind: "estimate" }));                      // only a quote went to them
  const people = [person(1, ME), person(2, null), person(3, OTHER), person(4, OTHER), person(5, OTHER), person(6, OTHER), person(7, OTHER)];
  const [page] = await pages(new FakeSource(t, people), { channel: "email", mine: true });
  same(page.map((r) => r.contactId), [cid(1), cid(2), cid(4), cid(5), cid(6)], "mine");
  const [all] = await pages(new FakeSource(t, people), { channel: "email", mine: false });
  same(all.length, 7, "everyone");
  // Someone without phone access: a call they once placed does not count, the text still does.
  const [noPhone] = await pages(new FakeSource(t, people, { seesCalls: false }), { channel: "email", mine: true }, { ...everyone, seesCalls: false });
  same(noPhone.map((r) => r.contactId), [cid(1), cid(2), cid(4), cid(5)], "mine, no phone");
});

Deno.test("phone:'own': a call that isn't theirs is not shown and does not hide the customer", async () => {
  // Customer 1: a missed call (someone else's) newer than a text. They must show with the text on
  // page 1. Customer 2: the same, with the text far enough back to fall on page 2, where the
  // hidden call above the cursor must not count as "already shown" (it never was).
  const t = empty();
  t.calls.push(call(1, 9000, { rang_user_ids: [OTHER] }), call(2, 8000, { rang_user_ids: [OTHER] }));
  t.sms.push(text(1, 5000));
  for (let n = 10; n < 60; n++) t.sms.push(text(n, 7000 - n));
  t.sms.push(text(2, 100));
  const people = [person(1), person(2), ...Array.from({ length: 50 }, (_, i) => person(10 + i))];
  const mineOnly = (r: Row) => r.placed_by === ME || r.answered_by === ME || (r.rang_user_ids ?? []).includes(ME);
  const walked = (await pages(new FakeSource(t, people), { channel: "all", mine: false }, { me: ME, seesCalls: true, callVisible: mineOnly })).flat();
  const row = (n: number) => walked.find((r) => r.contactId === cid(n));
  same([row(1)?.channel, row(1)?.preview], ["sms", "text 5000"], "customer 1");
  same([row(2)?.channel, row(2)?.preview], ["sms", "text 100"], "customer 2 was lost to a call they couldn't see");
  assert(!walked.some((r) => r.channel === "calls"), "a call that isn't theirs was shown");
});

// ── The walk ────────────────────────────────────────────────────────────────────────────────────

// A small seeded generator, so a failure reproduces.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function world(seed: number) {
  const r = rng(seed);
  const N = 320;
  const people = Array.from({ length: N }, (_, i) => person(i + 1, r() < 0.3 ? ME : r() < 0.5 ? OTHER : null));
  const pick = () => 1 + Math.floor(r() * N);
  // Stamps drawn from a small pool now and then, so ties are common, including at read edges.
  const pool = Array.from({ length: 40 }, () => Math.floor(r() * 5_000_000));
  const when = () => (r() < 0.15 ? pool[Math.floor(r() * pool.length)] : Math.floor(r() * 5_000_000));
  const t = empty();
  for (let i = 0; i < 1400; i++) t.sms.push(text(pick(), when(), { id: `t${i}`, direction: r() < 0.5 ? "in" : "out", sent_by: r() < 0.3 ? ME : r() < 0.5 ? OTHER : null }));
  for (let i = 0; i < 520; i++) t.emailIn.push(mailIn(pick(), when(), { id: `i${i}` }));
  for (let i = 0; i < 520; i++) t.emailOut.push(mailOut(pick(), when(), { id: `o${i}`, kind: r() < 0.8 ? "conversation" : "estimate", sent_by: r() < 0.4 ? ME : OTHER }));
  for (let i = 0; i < 460; i++) {
    const out = r() < 0.4;
    t.calls.push(call(pick(), when(), {
      id: `c${i}`, direction: out ? "out" : "in", status: out ? "completed" : r() < 0.5 ? "missed" : "completed",
      placed_by: out ? (r() < 0.5 ? ME : OTHER) : null, answered_by: !out && r() < 0.4 ? (r() < 0.5 ? ME : OTHER) : null,
      rang_user_ids: r() < 0.5 ? [ME] : [OTHER],
    }));
  }
  // A few customers merged away, and a few with no record row at all.
  const merged = new Set([cid(7), cid(77)]);
  return { t, people: people.filter((p) => p.id !== cid(300)), merged };
}

/** The answer, worked out directly from every row: each eligible customer's newest message. */
function truth(t: Tables, people: InboxContact[], o: { channel: InboxFilter; mine: boolean; visible?: Set<string>; merged: Set<string>; seesCalls: boolean; callVisible: (r: Row) => boolean }) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const newest = new Map<string, string>();
  const ever = new Set<string>();
  const tables = inboxTables(o.channel, o.seesCalls);
  for (const k of TABLE_KEYS) {
    for (const row of t[k]) {
      if (k === "emailOut" && !INBOX_EMAIL_KINDS.includes(row.kind)) continue;
      if (k === "calls" && !(o.seesCalls && o.callVisible(row))) continue;
      const mine = k === "sms" || k === "emailOut" ? row.sent_by === ME : k === "calls" ? (row.placed_by === ME || row.answered_by === ME) : false;
      if (mine) ever.add(row.contact_id);
      if (!tables.includes(k)) continue;
      const a = row[INBOX_AT_COLUMN[k]];
      if (!newest.has(row.contact_id) || a > newest.get(row.contact_id)!) newest.set(row.contact_id, a);
    }
  }
  const want = new Map<string, string>();
  for (const [id, a] of newest) {
    const c = byId.get(id);
    if (!c || o.merged.has(id)) continue;
    if (o.visible && !o.visible.has(id)) continue;
    if (o.mine && !(ever.has(id) || !c.owner_user_id || c.owner_user_id === ME)) continue;
    want.set(id, a);
  }
  return want;
}

for (const seed of [1, 2, 3]) {
  Deno.test(`the walk (seed ${seed}): every customer once, with their newest message, newest first`, async () => {
    const { t, people, merged } = world(seed);
    const visibleSome = new Set(people.filter((_, i) => i % 3 !== 0).map((p) => p.id));
    const ownCalls = (row: Row) => row.placed_by === ME || row.answered_by === ME
      || (["missed", "voicemail", "ringing"].includes(row.status) && (row.rang_user_ids ?? []).includes(ME));
    const cases: { channel: InboxFilter; mine: boolean; visible?: Set<string>; seesCalls: boolean; callVisible: (r: Row) => boolean }[] = [];
    for (const channel of ["all", "email", "sms", "calls"] as InboxFilter[]) {
      for (const mine of [false, true]) cases.push({ channel, mine, seesCalls: true, callVisible: () => true });
    }
    cases.push({ channel: "all", mine: false, visible: visibleSome, seesCalls: true, callVisible: () => true });
    cases.push({ channel: "all", mine: true, visible: visibleSome, seesCalls: true, callVisible: ownCalls });
    cases.push({ channel: "all", mine: false, seesCalls: true, callVisible: ownCalls });
    cases.push({ channel: "all", mine: false, seesCalls: false, callVisible: () => true });
    for (const c of cases) {
      const label = JSON.stringify({ channel: c.channel, mine: c.mine, some: !!c.visible, seesCalls: c.seesCalls, own: c.callVisible !== cases[0].callVisible });
      const src = new FakeSource(t, people, { visible: c.visible, merged, seesCalls: c.seesCalls });
      const walked = await pages(src, { channel: c.channel, mine: c.mine }, { me: ME, seesCalls: c.seesCalls, callVisible: c.callVisible });
      const rows = walked.flat();
      const want = truth(t, people, { ...c, merged });
      const seen = new Map<string, string>();
      for (const r of rows) {
        assert(!seen.has(r.contactId), `${label}: ${r.contactId} listed twice`);
        seen.set(r.contactId, r.at);
      }
      for (const [id, a] of want) assert(seen.get(id) === a, `${label}: ${id} should show ${a}, showed ${seen.get(id)}`);
      for (const id of seen.keys()) assert(want.has(id), `${label}: ${id} should not be listed`);
      for (let i = 1; i < rows.length; i++) assert(rows[i - 1].at >= rows[i].at, `${label}: out of order at row ${i}`);
      assert(walked.length > 1 || rows.length < INBOX_PAGE, `${label}: the walk should span pages`);
    }
  });
}
