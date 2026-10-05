// The Conversations inbox: every customer's newest email, text or call, newest first, across the
// whole account (portal-settings `crm_inbox`, the portal's Conversations page).
//
// Carolyn, 2026-08-21 @45:22: "I like the idea of a conversations tab ... So conversations would be
// email, all of it. In the way that GoHighLevel has that, like I like that except I want that bar
// at the top that shows that I can sort and see just that." And @42:45: "yes, I want a
// conversations tab, sure, but I want to be able to see my calls." So the list is one row per
// CUSTOMER (not per message), built from four tables, with a channel filter on top.
//
// WHY A MODULE OF ITS OWN, and why crmFeed.ts was not touched: crmFeed is bundled by the phone-api
// Worker as well as by every function that imports it, so a change there means redeploying all of
// them. This file has exactly one importer, portal-settings.
//
// WHAT IS PURE HERE AND WHAT IS NOT. Everything that decides what the list says lives here: the
// page window, the grouping, the "already shown on an earlier page" rule, the visibility and
// "mine" filters, and the wording of a row. The database is reached only through the InboxSource
// the caller hands buildInbox(), so the tests drive the whole algorithm, page after page, against
// tables held in memory. No imports, so the test loads it without a registry.
//
// THE PAGING RULE is the phone-api Worker's (workers/phone-api/src/routes/reads.ts, listThreads),
// extended from two tables to four:
//   • each table is read newest-first below the cursor, up to its own limit;
//   • a table that came back FULL has only been read back to its oldest row, so nothing older than
//     that, from any table, belongs on this page (the "window boundary"). Without it a customer
//     could show an older email as their newest while a newer text sat just past the end of the
//     text read, and then show again on the next page;
//   • on page 2 and later, a customer with anything at or above the cursor was already listed on
//     an earlier page, so they are left out (every table the list is built from is asked);
//   • a full page continues after its last row; a short page continues from the window boundary,
//     so nothing further back becomes unreachable.
// Three things go further than the Worker, all found writing the tests:
//   • timestamps are compared at the database's MICROSECOND precision. A cursor cut to
//     milliseconds skips a message stamped a few microseconds after it;
//   • rows that share one timestamp are never split across a page edge (see inboxWindow and
//     finishInbox). Everything one transaction inserts carries the same now();
//   • "I've been in touch with them" (the Mine toggle) means ever, not "on this page". Otherwise a
//     customer could drop out of Mine between one page and the next.

export type InboxChannel = "email" | "sms" | "calls";
export type InboxFilter = "all" | InboxChannel;
/** The four reads a page can be built from. */
export type InboxTable = "sms" | "emailIn" | "emailOut" | "calls";

/** Customers per page. */
export const INBOX_PAGE = 50;
/** Rows read from each table for one page. Texts are the busiest table, so they get the most: the
 *  Worker's SCAN and EMAIL_SCAN. Calls take the email figure. */
export const INBOX_SCAN: Record<InboxTable, number> = { sms: 500, emailIn: 200, emailOut: 200, calls: 200 };
/** The email kinds that move a conversation: a person writing to a person. Quotes, invoices,
 *  change orders and receipts carry no contact_id and show on the record, not here. The phone-api
 *  Worker's LIST_EMAIL_KINDS (workers/phone-api/src/emailThread.ts); keep the two identical. */
export const INBOX_EMAIL_KINDS = ["conversation", "test"];
/** How much of a text the row shows. */
export const INBOX_PREVIEW_CHARS = 140;
/** Ids per `in (...)` list. A GET's whole filter rides in the URL, and ~37 characters an id times
 *  a page's worth of customers would pass the length proxies and PostgREST accept. */
export const INBOX_ID_CHUNK = 150;

const FILTERS: InboxFilter[] = ["all", "email", "sms", "calls"];

// ── The request ───────────────────────────────────────────────────────────────────────────────

export type InboxRequest = { channel: InboxFilter; mine: boolean; cursor: string | null };

/** The browser's { channel, mine, cursor }. A filter the inbox does not know, or a cursor that is
 *  not a timestamp, is refused rather than read as "all" or "from the top": either guess would show
 *  a list that isn't the one asked for, and look right. */
export function parseInboxRequest(p: Record<string, unknown> | null | undefined): InboxRequest | { error: string } {
  const raw = p?.channel;
  const channel = (raw == null || raw === "") ? "all" : String(raw);
  if (!FILTERS.includes(channel as InboxFilter)) return { error: "That isn't one of the inbox's filters." };
  let cursor: string | null = null;
  if (p?.cursor != null && p.cursor !== "") {
    cursor = typeof p.cursor === "string" ? canonAt(p.cursor) : null;
    if (!cursor) return { error: "That page marker isn't valid." };
  }
  return { channel: channel as InboxFilter, mine: p?.mine === true, cursor };
}

/** Which tables a filter reads. Calls only for someone who may see the phone at all. */
export function inboxTables(channel: InboxFilter, seesCalls: boolean): InboxTable[] {
  const out: InboxTable[] = [];
  if (channel === "all" || channel === "sms") out.push("sms");
  if (channel === "all" || channel === "email") out.push("emailIn", "emailOut");
  if ((channel === "all" || channel === "calls") && seesCalls) out.push("calls");
  return out;
}

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

const AT_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** A timestamp in ONE shape, so two of them compare as strings in time order:
 *  "2026-10-01T12:00:00.123456Z". Microseconds kept, which Date would drop (Postgres stamps rows to
 *  the microsecond). Offsets are applied; no offset reads as UTC, as Postgres prints timestamptz.
 *  Null for anything that is not a timestamp. */
export function canonAt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = AT_RE.exec(v.trim());
  if (!m) return null;
  let zone = (m[4] ?? "Z").toUpperCase();
  if (zone !== "Z" && !zone.includes(":")) zone = zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const whole = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(whole)) return null;
  const micros = (m[3] ?? "").slice(0, 6).padEnd(6, "0");
  return `${new Date(whole).toISOString().slice(0, 19)}.${micros}Z`;
}

const newestFirst = (x: { at: string }, y: { at: string }) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0);

// ── One thing that happened, from whichever table ─────────────────────────────────────────────

export interface InboxEvent {
  contactId: string;
  /** canonAt() form. */
  at: string;
  channel: InboxChannel;
  direction: "in" | "out";
  /** What the row says: an email's subject, a text's first words, or what happened on a call. */
  preview: string;
  /** I sent it, placed it or answered it: "Mine" keeps a customer I have been in touch with. */
  byMe: boolean;
  /** A call that needs nothing from anyone: somebody answered it, or it is happening now. An
   *  inbound call like that is not "waiting on you" the way a missed one is. */
  handled: boolean;
}

// deno-lint-ignore no-explicit-any
type Row = any;

const one = (v: unknown) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** A text's first INBOX_PREVIEW_CHARS characters on one line. A picture with no words says so. */
export function smsPreview(body: unknown, numMedia?: unknown): string {
  const words = String(body ?? "").replace(/\s+/g, " ").trim();
  if (words) return words.length > INBOX_PREVIEW_CHARS ? `${words.slice(0, INBOX_PREVIEW_CHARS - 1).trimEnd()}…` : words;
  return Number(numMedia) > 0 ? "Picture message" : "Text message";
}

/** 192 → "3:12", 3720 → "1:02:00". A call's length as a phone shows it. */
export function fmtClock(seconds: unknown): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

const callIsLive = (c: Row) => {
  const st = String(c?.status ?? "");
  return st === "ringing" || st === "in_progress";
};
const callAnswered = (c: Row) => c?.direction === "out"
  ? !!c.answered_at && (Number(c.duration_s) || 0) > 0
  : !!c?.answered_by || (!!c?.answered_at && !callIsLive(c));

/** What happened on a call, in a few words. NEVER a transcript: a voicemail's words and a call
 *  summary stay on the record, behind the phone permission the record applies to them. The
 *  outcomes are crmFeed's callFeedEvents, said shorter:
 *    happening now                                 → "Call in progress"
 *    answered (either way), with a length          → "Call 3:12"
 *    answered, no length yet                       → "Call"
 *    outbound, not answered                        → "Call, no answer" / "Call, busy" / "Call didn't connect"
 *    inbound, a message was left                   → "Voicemail"
 *    inbound, anything else                        → "Missed call" */
export function callLabel(c: Row): string {
  const status = String(c?.status ?? "");
  if (callIsLive(c)) return "Call in progress";
  const dur = Number(c?.duration_s) || 0;
  if (callAnswered(c)) return dur > 0 ? `Call ${fmtClock(dur)}` : "Call";
  if (c?.direction === "out") return status === "busy" ? "Call, busy" : status === "failed" ? "Call didn't connect" : "Call, no answer";
  if (one(c?.phone_voicemails) || status === "voicemail") return "Voicemail";
  return "Missed call";
}

export function smsEvent(r: Row, me: string | null): InboxEvent | null {
  const at = canonAt(r?.created_at);
  if (!r?.contact_id || !at) return null;
  return {
    contactId: String(r.contact_id), at, channel: "sms", direction: r.direction === "in" ? "in" : "out",
    preview: smsPreview(r.body, r.num_media), byMe: !!me && r.sent_by === me, handled: false,
  };
}
export function emailInEvent(r: Row): InboxEvent | null {
  const at = canonAt(r?.received_at);
  if (!r?.contact_id || !at) return null;
  return {
    contactId: String(r.contact_id), at, channel: "email", direction: "in",
    preview: String(r.subject ?? "").trim() || "(no subject)", byMe: false, handled: false,
  };
}
export function emailOutEvent(r: Row, me: string | null): InboxEvent | null {
  const at = canonAt(r?.created_at);
  if (!r?.contact_id || !at) return null;
  return {
    contactId: String(r.contact_id), at, channel: "email", direction: "out",
    preview: String(r.subject ?? "").trim() || "(no subject)", byMe: !!me && r.sent_by === me, handled: false,
  };
}
export function callEvent(r: Row, me: string | null): InboxEvent | null {
  const at = canonAt(r?.started_at);
  if (!r?.contact_id || !at) return null;
  return {
    contactId: String(r.contact_id), at, channel: "calls", direction: r.direction === "out" ? "out" : "in",
    preview: callLabel(r), byMe: !!me && (r.placed_by === me || r.answered_by === me),
    handled: callIsLive(r) || callAnswered(r),
  };
}

/** The column each table is ordered and paged on. */
export const INBOX_AT_COLUMN: Record<InboxTable, string> = { sms: "created_at", emailIn: "received_at", emailOut: "created_at", calls: "started_at" };

// ── The window, the grouping, the page ────────────────────────────────────────────────────────

/** One table's read. `edge` is the oldest row READ (before anything was filtered out of it):
 *  that, not the oldest row kept, is where the read stopped. */
export interface InboxScan { events: InboxEvent[]; full: boolean; edge: string | null }

export function scanOf(table: InboxTable, rows: Row[], limit: number, toEvent: (r: Row) => InboxEvent | null): InboxScan {
  const list = rows ?? [];
  let edge: string | null = null;
  const events: InboxEvent[] = [];
  for (const r of list) {
    const at = canonAt(r?.[INBOX_AT_COLUMN[table]]);
    if (at && (edge === null || at < edge)) edge = at;
    const e = toEvent(r);
    if (e) events.push(e);
  }
  return { events, full: list.length >= limit, edge };
}

/** One microsecond after `at` (a canonAt() string). A cursor is read as "older than", so this is
 *  the cursor that reads `at` itself again. */
export function afterAt(at: string): string {
  const base = Date.parse(`${at.slice(0, 19)}Z`);
  const micros = Number(at.slice(20, 26)) + 1;
  const carry = micros >= 1_000_000;
  return `${new Date(base + (carry ? 1000 : 0)).toISOString().slice(0, 19)}.${String(carry ? 0 : micros).padStart(6, "0")}Z`;
}

/** Everything on this page, newest first; where the window ends (null: nothing older is left
 *  unread); and the cursor that carries on from there when the page does not fill.
 *
 *  THE BOUNDARY ITSELF IS LEFT FOR THE NEXT PAGE (the Worker keeps it, `>=`). A table that came
 *  back full may hold more rows stamped with exactly its oldest time than it had room for, and
 *  "older than the boundary" on the next page would then skip them for good. Rows can share a
 *  stamp: everything one transaction inserts gets the same now(). So this page keeps what is
 *  strictly newer, and the next one starts AT the boundary (afterAt).
 *  The one exception: when the boundary sits right under the cursor this page came from, starting
 *  at it would read this same page again, for ever. Then the boundary's rows are taken now. */
export function inboxWindow(scans: InboxScan[], cursor: string | null = null): { events: InboxEvent[]; boundary: string | null; resumeAt: string | null } {
  let boundary: string | null = null;
  for (const s of scans) {
    if (!s.full || !s.edge) continue;
    if (boundary === null || s.edge > boundary) boundary = s.edge;
  }
  const all = scans.flatMap((s) => s.events).sort(newestFirst);
  if (boundary === null) return { events: all, boundary: null, resumeAt: null };
  let resumeAt = afterAt(boundary);
  let strict = true;
  if (cursor && resumeAt >= cursor) { strict = false; resumeAt = boundary; }
  const b = boundary;
  return { events: all.filter((e) => (strict ? e.at > b : e.at >= b)), boundary, resumeAt };
}

export interface InboxGroup { last: InboxEvent; byMe: boolean }

/** Newest event per customer, in newest-first order of that event, and whether I took part. */
export function groupByContact(events: InboxEvent[]): Map<string, InboxGroup> {
  const groups = new Map<string, InboxGroup>();
  for (const e of [...events].sort(newestFirst)) {
    const g = groups.get(e.contactId);
    if (!g) groups.set(e.contactId, { last: e, byMe: e.byMe });
    else if (e.byMe) g.byMe = true;
  }
  return groups;
}

export interface InboxContact {
  id: string;
  name: string | null;
  owner_user_id: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface InboxThread {
  contactId: string;
  name: string | null;
  channel: InboxChannel;
  direction: "in" | "out";
  preview: string;
  at: string;
  /** The newest thing is the customer's and nobody has answered it. Derived, so there is no read
   *  state to keep: replying (or calling back) is what clears it. */
  awaitingReply: boolean;
}

/** The newest event is theirs and still needs someone: an email or text from them, or a call from
 *  them nobody picked up. */
export function awaitingReply(e: InboxEvent): boolean {
  return e.direction === "in" && !e.handled;
}

/** The customer's name as the row shows it: the record's name, else how to reach them. */
export function inboxName(c: InboxContact): string | null {
  return (c.name ?? "").trim() || (c.email ?? "").trim() || (c.phone ?? "").trim() || null;
}

/** "Mine": the customer is mine, or nobody's, or I have been in touch with them. The phone-api
 *  Worker's rule for the same toggle (reads.ts, "Section 7"), with "in touch" meaning ever. */
export function isMine(g: InboxGroup, c: InboxContact, me: string | null, everByMe: ReadonlySet<string>): boolean {
  const owner = c.owner_user_id ?? null;
  return g.byMe || everByMe.has(c.id) || !owner || (!!me && owner === me);
}

/** The groups "Mine" cannot decide from this page alone: someone else's customer I sent nothing to
 *  on this page. Whether I EVER did is one more read, asked only about these. */
export function needsEverCheck(groups: Map<string, InboxGroup>, contacts: Map<string, InboxContact>, me: string | null): string[] {
  const out: string[] = [];
  for (const [id, g] of groups) {
    const c = contacts.get(id);
    if (!c || g.byMe) continue;
    const owner = c.owner_user_id ?? null;
    if (owner && owner !== me) out.push(id);
  }
  return out;
}

/** The page: rows in order, INBOX_PAGE of them, and where the next page starts (null: the end).
 *
 *  A full page continues below its last row's time. Customers whose newest message carries that
 *  SAME time ride along on this page (it runs a row or two long), because "older than" would skip
 *  them on the next one. A short page continues from `resumeAt` (inboxWindow). */
export function finishInbox(
  groups: Map<string, InboxGroup>,
  o: {
    contacts: Map<string, InboxContact>;
    visible: ReadonlySet<string>;
    mine: boolean;
    me: string | null;
    everByMe?: ReadonlySet<string>;
    resumeAt: string | null;
  },
): { threads: InboxThread[]; cursor: string | null } {
  const ever = o.everByMe ?? new Set<string>();
  const threads: InboxThread[] = [];
  let fullAt: string | null = null;
  for (const [id, g] of groups) {
    if (fullAt !== null && g.last.at !== fullAt) break;
    // Not returned: merged into another record (its messages moved with it), or not this
    // account's. Either way there is no record to open.
    const c = o.contacts.get(id);
    if (!c) continue;
    if (!o.visible.has(id)) continue;
    if (o.mine && !isMine(g, c, o.me, ever)) continue;
    threads.push({
      contactId: id, name: inboxName(c), channel: g.last.channel, direction: g.last.direction,
      preview: g.last.preview, at: g.last.at, awaitingReply: awaitingReply(g.last),
    });
    if (fullAt === null && threads.length >= INBOX_PAGE) fullAt = g.last.at;
  }
  return { threads, cursor: fullAt ?? o.resumeAt };
}

/** `xs` in lists of at most `n`. */
export function chunked<T>(xs: readonly T[], n = INBOX_ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ── The whole page, against whatever holds the rows ───────────────────────────────────────────

/** A read failed. `where` finishes "Couldn't …" (portal-settings' dbFail sentence). */
export class InboxReadError extends Error {
  constructor(public where: string, public dbError?: unknown) {
    super(where);
  }
}

/** How buildInbox reaches the rows. portal-settings implements it with PostgREST; the tests with
 *  arrays. Every method throws InboxReadError on a failed read; nothing may answer "no rows" for
 *  "the read failed", which would look like an empty inbox. */
export interface InboxSource {
  /** One table's rows with a contact, newest first, below the cursor (all of them with no cursor),
   *  at most `limit`. Calls carry what callVisible needs. */
  scan(table: InboxTable, cursor: string | null, limit: number): Promise<Row[]>;
  /** Rows at or above the cursor for these customers: contact_id, plus for calls what callVisible
   *  needs. A customer with any (visible) row here was listed on an earlier page. */
  newer(table: InboxTable, contactIds: string[], cursor: string): Promise<Row[]>;
  /** These customers' records, merged-away ones left out. */
  contacts(ids: string[]): Promise<InboxContact[]>;
  /** Which of these the viewer may see. Null when the check itself failed: the caller refuses,
   *  and never shows everything instead. */
  visible(ids: string[]): Promise<Set<string> | null>;
  /** Which of these customers the viewer has ever texted, emailed, called or answered. */
  everByMe(ids: string[]): Promise<Set<string>>;
}

export interface InboxViewer {
  me: string | null;
  /** May this person see calls at all (any phone level)? Without it phone_calls is not read. */
  seesCalls: boolean;
  /** Is this call one they may see? phone:'own' sees only their own (portal-settings passes
   *  crmFeed's scopeCallRows with the customer's owner). */
  callVisible: (row: Row) => boolean;
}

export async function buildInbox(src: InboxSource, req: InboxRequest, v: InboxViewer): Promise<{ threads: InboxThread[]; cursor: string | null }> {
  const tables = inboxTables(req.channel, v.seesCalls);
  const toEvent = (t: InboxTable) => (r: Row): InboxEvent | null => {
    if (t === "sms") return smsEvent(r, v.me);
    if (t === "emailIn") return emailInEvent(r);
    if (t === "emailOut") return emailOutEvent(r, v.me);
    return v.callVisible(r) ? callEvent(r, v.me) : null;
  };
  const scans = await Promise.all(tables.map(async (t) => scanOf(t, await src.scan(t, req.cursor, INBOX_SCAN[t]), INBOX_SCAN[t], toEvent(t))));
  const { events, resumeAt } = inboxWindow(scans, req.cursor);
  const groups = groupByContact(events);

  // Page 2 and later: whoever has anything at or above the cursor was listed already. Only the
  // tables this filter reads are asked, and only calls this person may see count.
  if (req.cursor && groups.size) {
    const cursor = req.cursor;
    const ids = [...groups.keys()];
    const hits = await Promise.all(tables.map(async (t) => {
      const rows = (await Promise.all(chunked(ids).map((part) => src.newer(t, part, cursor)))).flat();
      return rows.filter((r) => r?.contact_id && (t !== "calls" || v.callVisible(r))).map((r) => String(r.contact_id));
    }));
    for (const id of hits.flat()) groups.delete(id);
  }

  const ids = [...groups.keys()];
  const [visible, contactRows] = await Promise.all([
    ids.length ? src.visible(ids) : Promise.resolve(new Set<string>()),
    ids.length ? Promise.all(chunked(ids).map((part) => src.contacts(part))).then((x) => x.flat()) : Promise.resolve([] as InboxContact[]),
  ]);
  if (!visible) throw new InboxReadError("check who these customers are assigned to");
  const contacts = new Map<string, InboxContact>(contactRows.map((c) => [c.id, c]));

  let everByMe: Set<string> = new Set();
  if (req.mine) {
    const ask = needsEverCheck(groups, contacts, v.me).filter((id) => visible.has(id));
    if (ask.length && v.me) everByMe = new Set((await Promise.all(chunked(ask).map((part) => src.everByMe(part)))).flatMap((s) => [...s]));
  }
  return finishInbox(groups, { contacts, visible, mine: req.mine, me: v.me, everByMe, resumeAt });
}
