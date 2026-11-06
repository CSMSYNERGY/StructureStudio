// The apps' read endpoints: GET /threads, /threads/:key, /calls, /search, /contacts and /team,
// and the list searches, POST /threads/search and POST /calls/search.
//
// THE APPS NEVER READ THE PHONE TABLES DIRECTLY (plan section 7). Realtime broadcasts carry ids
// only, and the app comes here for the row, so every read applies:
//   • the contacts row scope: someone limited to their own customers sees only those (the
//     crm_visible_contact_ids predicate), contacts `none` sees no customer at all, and unknown
//     numbers are for contacts view/edit only;
//   • the phone level: `own` sees "my" calls (section 7's definition, scope.ts callIsMine);
//     `view`/`edit` may ask for the team's.
// Texts follow the contacts area, as they always have; "mine" narrows the thread LIST only.
// Email follows it the same way (emailThread.ts shapes it), and is never narrowed by phone level.

import { senderVerifiedFrom } from "../../../../supabase/functions/_shared/crmFeed.ts";
import { hasPaidFeature } from "../../../../supabase/functions/_shared/featureCheck.ts";
import { readSmsOptOut, smsOptOutFacts, smsOptOutReasonOf, type SmsOptOutReason } from "../../../../supabase/functions/_shared/smsOptOut.ts";
import type { Env } from "../env";
import { warmStates, type WarmInfo } from "../callEvents";
import { requireCaller, type Caller } from "../context";
import { CALL_COLUMNS, DbError, must, type CallRow } from "../db";
import {
  EMAIL_PAGE, INBOUND_COLS, LIST_EMAIL_KINDS, SEND_COLS, SEND_COLS_BEFORE_262, THREAD_EMAIL_KINDS,
  contactEmailFilter, emailAddress, emailBlock, hasText, threadEmails,
  type Compose, type EmailInboundRow, type EmailSendRow, type EmailSettings, type ThreadEmail,
} from "../emailThread";
import { switchUnderWay } from "../handoff";
import { ApiError, ok, pathParam, readJson, UUID_RE } from "../http";
import { phoneDigits, toE164, toIdentity } from "../identity";
import { logFault } from "../log";
import { callIsMine, isTeamLevel, mayReadUnknownNumbers, maySendToContacts, narrowedToOwn, phoneLevelOf, visibleContactIds } from "../scope";

const PAGE = 50;
const SCAN = 500;
/** PostgREST / Postgres "no such column" (media.ts's set). */
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);
/** Rows read per email table for one page of the list (?channels=…,email). */
const EMAIL_SCAN = 200;

function cursorParam(url: URL): string | null {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new ApiError("bad_request", "That page marker isn't valid.");
  return new Date(t).toISOString();
}

// ── calls ───────────────────────────────────────────────────────────────────────────

type CallWithJoins = CallRow & {
  crm_contacts: { name: string | null; owner_user_id: string | null } | { name: string | null; owner_user_id: string | null }[] | null;
  phone_voicemails: VoicemailJoin | VoicemailJoin[] | null;
  /** The call's recording (migration 263). Optional: fixtures from before it need nothing. */
  phone_call_recordings?: RecordingJoin | RecordingJoin[] | null;
};

interface VoicemailJoin {
  id: string;
  duration_s: number | null;
  listened_at: string | null;
  deleted_at: string | null;
  /** Twilio's transcription (TRANSCRIBE=on), or null. */
  transcript?: string | null;
}

interface RecordingJoin {
  id: string;
  status: string;
  duration_s: number | null;
  summary: string | null;
  transcript_status: string;
  /** Optional: fixtures from before it need nothing. 'off' beside a done transcript = no words. */
  summary_status?: string;
  deleted_at: string | null;
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

const VM_SELECT = "phone_voicemails(id, duration_s, listened_at, deleted_at, transcript)";
// The Voicemail tab's lists (?voicemail=1, and search with `voicemail`): only calls that left a
// voicemail, read with `phone_voicemails.deleted_at=is.null` beside it, so a call whose voicemail
// retention deleted drops out in the database and a page of 50 is 50 voicemails.
const VM_INNER = "phone_voicemails!inner(id, duration_s, listened_at, deleted_at, transcript)";
// ⚠️ migration 263's table: this Worker must not be deployed before it is applied.
// No transcript here, on purpose: both apps save these rows on the device (the extension's
// IndexedDB, the phone's query cache), where a copy would outlive the business's retention. The
// transcript is read on demand, GET /calls/:id/transcript, and kept in memory only.
const REC_SELECT = "phone_call_recordings(id, status, duration_s, summary, transcript_status, summary_status, deleted_at)";
const CALL_SELECT = `${CALL_COLUMNS}, crm_contacts(name, owner_user_id), ${VM_SELECT}, ${REC_SELECT}`;

export type RecordingState = "live" | "paused" | "processing" | "ready" | "failed";

/**
 * A call's recording as the apps see it (null: none, or deleted by retention):
 *   live        recording now (or starting)
 *   paused      the customer is on hold
 *   processing  the call is over and Twilio has not finished the file yet
 *   ready       playable: GET /recordings/:id/audio
 *   failed      it did not record (Twilio refused, or heard nothing)
 * Who may see it is who may see the call: the list is already scoped (scopeCalls, isMineCall).
 */
export function recordingOut(r: Pick<CallRow, "ended_at">, rec: RecordingJoin | null) {
  if (!rec || rec.deleted_at) return null;
  let state: RecordingState;
  if (rec.status === "completed") state = "ready";
  else if (rec.status === "failed" || rec.status === "absent") state = "failed";
  else if (r.ended_at) state = "processing";
  else state = rec.status === "paused" ? "paused" : "live";
  return { id: rec.id, duration_s: rec.duration_s ?? null, state };
}

/**
 * pending | done | failed for the apps (working is pending to them; off is null). `done` is the
 * apps' cue for "Show transcript", which reads GET /calls/:id/transcript, so it means there is
 * text: a call nova-3 heard no words in (done, with its summary left off, cron/transcribe.ts)
 * is null, like one never transcribed.
 */
function transcriptStatusOut(rec: RecordingJoin | null): "pending" | "done" | "failed" | null {
  if (!rec || rec.deleted_at) return null;
  if (rec.transcript_status === "pending" || rec.transcript_status === "working") return "pending";
  if (rec.transcript_status === "done") return rec.summary_status === "off" ? null : "done";
  if (rec.transcript_status === "failed") return "failed";
  return null;
}

/**
 * One call as the apps see it. `warm` (only on a live call in its conference that a warm
 * transfer rang someone into) is how the latest warm transfer stands: callEvents.ts WarmInfo.
 * A teammate who does not answer changes nothing else on the row, so this is the only way an
 * app waiting on one learns it is over before its own ring limit.
 *
 * `error_code` is why a call was refused before it was placed (wallet_empty, minute_cap,
 * not_your_customer, ...; null for every call that went out or came in), so Recents can say
 * "Not placed: wallet empty" instead of a bare "failed".
 *
 * Call recording (release B2, additive: older apps ignore the keys):
 *   recording          recordingOut above, or null
 *   summary            2-4 sentences and action items; KEPT after the audio is deleted
 *   transcript_status  pending | done | failed, or null (not transcribed, no words, or
 *                      deleted). The transcript itself is never on a call row (REC_SELECT says
 *                      why): done means GET /calls/:id/transcript has it.
 */
export function callSummary(r: CallWithJoins, warm?: WarmInfo | null) {
  const contact = one(r.crm_contacts);
  const vm = one(r.phone_voicemails);
  const rec = one(r.phone_call_recordings);
  return {
    id: r.id,
    direction: r.direction,
    e164: r.direction === "in" ? r.from_e164 : r.to_e164,
    contact_id: r.contact_id,
    contact_name: contact?.name ?? null,
    status: r.status,
    error_code: r.error_code ?? null,
    started_at: r.started_at,
    duration_s: r.duration_s,
    answered_by: r.answered_by,
    voicemail: vm && !vm.deleted_at
      ? { id: vm.id, duration_s: vm.duration_s, listened: !!vm.listened_at, transcript: vm.transcript ?? null }
      : null,
    // A move to the person's other device under way (../handoff.ts): ringing / connecting, and
    // where to. Null when none is, or the last one is past its 45 s. Outcomes: GET /calls/:id/handoff.
    handoff_state: switchUnderWay(r) ? r.handoff_state ?? null : null,
    handoff_to: switchUnderWay(r) ? r.handoff_to ?? null : null,
    recording: recordingOut(r, rec),
    summary: rec?.summary ?? null,
    transcript_status: transcriptStatusOut(rec),
    ...(warm ? { warm } : {}),
  };
}

/**
 * The summaries, with `warm` read (one events query) for the calls it can apply to: live, in
 * their conference. Most pages have none and cost nothing more. A failed read leaves `warm`
 * off: the apps still have their ring limit.
 */
async function summaries(c: Caller, rows: CallWithJoins[]) {
  const live = rows.filter((r) => r.transfer_state === "conference" && r.status === "in_progress" && !r.ended_at);
  const warm = live.length
    ? await warmStates(c.admin, live).catch(() => new Map<string, WarmInfo>())
    : new Map<string, WarmInfo>();
  return rows.map((r) => callSummary(r, warm.get(r.id)));
}

function involvesMe(userId: string, r: CallRow): boolean {
  return r.placed_by === userId || r.answered_by === userId || r.transferred_from === userId
    || (r.rang_user_ids ?? []).includes(userId);
}

/** Drop calls about customers this caller may not see (and unknown numbers, where that applies). */
export async function scopeCalls(c: Caller, rows: CallWithJoins[]): Promise<CallWithJoins[]> {
  const visible = await visibleContactIds(c, rows.map((r) => r.contact_id));
  const unknownOk = mayReadUnknownNumbers(c.ctx);
  return rows.filter((r) => (r.contact_id ? visible.has(r.contact_id) : unknownOk || involvesMe(c.userId, r)));
}

export function isMineCall(userId: string, r: CallWithJoins): boolean {
  const contact = one(r.crm_contacts);
  return callIsMine(userId, { ...r, contact_owner: contact?.owner_user_id ?? null }) || r.transferred_from === userId;
}

/** The statuses of a call nobody answered: on a contact with an owner, those are the owner's (section 7). */
const UNANSWERED = ["missed", "voicemail", "ringing"];

/** "Mine", the calls I took part in: placed, answered, handed on, or rung for (a PostgREST `or`). */
const involvedOr = (me: string) => `placed_by.eq.${me},answered_by.eq.${me},transferred_from.eq.${me},rang_user_ids.cs.{${me}}`;

const newestCallFirst = (x: CallWithJoins, y: CallWithJoins) => (x.started_at < y.started_at ? 1 : x.started_at > y.started_at ? -1 : 0);

/**
 * Several reads of one list, each newest first below the same cursor and PAGE long, as one page:
 * each call once, newest first, at most PAGE. More follow when any read was full (it stopped
 * before its older calls) OR when together they held more than a page (the rest were cut here).
 * Then the cursor is the page's oldest call, and the next page reads every source below it again,
 * so nothing is skipped. (Until 2026-10-13 only a full read set the cursor: two reads of 30
 * different calls made a page of 50 with no cursor, and the other 10 could never be reached.)
 */
function mergeCallReads(lists: CallWithJoins[][]): { fetched: CallWithJoins[]; nextCursor: string | null } {
  const byId = new Map<string, CallWithJoins>();
  for (const r of lists.flat()) if (!byId.has(r.id)) byId.set(r.id, r);
  const fetched = [...byId.values()].sort(newestCallFirst).slice(0, PAGE);
  const more = lists.some((l) => l.length === PAGE) || byId.size > PAGE;
  return { fetched, nextCursor: more && fetched.length ? fetched[fetched.length - 1].started_at : null };
}

export async function listCalls(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const url = new URL(req.url);
  const cursor = cursorParam(url);
  const team = url.searchParams.get("scope") === "team" && isTeamLevel(c.ctx.phone_level);
  // The Voicemail tab (2026-10-13, features.list_search): only calls with a voicemail that isn't
  // deleted, paged like the rest, instead of the voicemails among the newest 50 calls.
  const vmOnly = url.searchParams.get("voicemail") === "1";
  const vm = vmOnly ? VM_INNER : VM_SELECT;
  const me = c.userId;

  const base = (select: string) => {
    let q = c.admin.from("phone_calls").select(select).eq("client_id", c.ctx.client_id)
      .order("started_at", { ascending: false }).limit(PAGE);
    if (vmOnly) q = q.is("phone_voicemails.deleted_at", null);
    if (cursor) q = q.lt("started_at", cursor);
    return q;
  };

  let fetched: CallWithJoins[];
  let nextCursor: string | null;
  if (team) {
    fetched = (must(await base(`${CALL_COLUMNS}, crm_contacts(name, owner_user_id), ${vm}, ${REC_SELECT}`), "list team calls") as CallWithJoins[] | null) ?? [];
    nextCursor = fetched.length === PAGE ? fetched[PAGE - 1].started_at : null;
  } else {
    // "Mine" is two sources: calls I placed, answered, handed on or was rung for; and missed
    // calls / voicemails on contacts I OWN, which ring whoever the route rings, not me.
    const [a, b] = await Promise.all([
      base(`${CALL_COLUMNS}, crm_contacts(name, owner_user_id), ${vm}, ${REC_SELECT}`).or(involvedOr(me)),
      base(`${CALL_COLUMNS}, crm_contacts!inner(name, owner_user_id), ${vm}, ${REC_SELECT}`)
        .eq("crm_contacts.owner_user_id", me).in("status", UNANSWERED),
    ]);
    const ra = (must(a, "list my calls") as CallWithJoins[] | null) ?? [];
    const rb = (must(b, "list my customers' missed calls") as CallWithJoins[] | null) ?? [];
    ({ fetched, nextCursor } = mergeCallReads([ra, rb]));
  }

  let rows = await scopeCalls(c, fetched);
  if (!team) rows = rows.filter((r) => isMineCall(me, r));
  return ok({ calls: await summaries(c, rows), ...(nextCursor ? { cursor: nextCursor } : {}) });
}

// ── threads ─────────────────────────────────────────────────────────────────────────

interface MsgRow {
  id: string;
  contact_id: string | null;
  direction: "in" | "out";
  body: string | null;
  status: string;
  created_at: string;
  from_number: string | null;
  to_number: string | null;
  sent_by: string | null;
  client_temp_id?: string | null;
  num_media?: number | null;
}

/** The customer's side of a text: who sent it in, or who it went out to. */
export function customerNumber(m: Pick<MsgRow, "direction" | "from_number" | "to_number">): string {
  return String((m.direction === "in" ? m.from_number : m.to_number) ?? "");
}

export function threadKey(m: Pick<MsgRow, "contact_id" | "direction" | "from_number" | "to_number">): string {
  return m.contact_id ?? `n:${customerNumber(m)}`;
}

/**
 * `?channels=sms,email` (opt-in): what the list is built from. Absent, or naming nothing known,
 * means texts alone: older apps and the shipped extension send no param, and the list they get
 * is the one from before email joined it, byte for byte.
 */
function channelsParam(url: URL): Set<"sms" | "email"> | null {
  const raw = url.searchParams.get("channels");
  if (raw === null) return null;
  const set = new Set<"sms" | "email">();
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (v === "sms" || v === "email") set.add(v);
  }
  return set.size ? set : null;
}

/** One thing that happened in a conversation, from whichever table it came from. */
interface ThreadEvent {
  key: string;
  contact_id: string | null;
  at: string;
  direction: "in" | "out";
  /** A text's words, or an email's subject (so a renderer that knows nothing of email still reads right). */
  body: string;
  channel: "sms" | "email";
  sent_by: string | null;
  /** The text itself, for texts: the thread's number comes from it. */
  sms: MsgRow | null;
  /** A customer's email only: crmFeed's verdict on its sender (false: failed SPF, DKIM or DMARC). */
  sender_verified?: boolean | null;
}

/** One table's newest rows below the cursor. `full` means it hit its limit: older rows exist that it didn't read. */
interface Scan {
  events: ThreadEvent[];
  full: boolean;
}

const newestFirst = (x: { at: string }, y: { at: string }) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0);

export async function listThreads(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  if (c.ctx.contacts_level === "none") return ok({ threads: [] });
  const url = new URL(req.url);
  const cursor = cursorParam(url);
  const channels = channelsParam(url);
  const withSms = !channels || channels.has("sms");
  const withEmail = channels?.has("email") ?? false;
  const mine = url.searchParams.get("mine") === "1" || !isTeamLevel(c.ctx.phone_level);
  const me = c.userId;
  const client = c.ctx.client_id;
  const none = Promise.resolve({ data: [], error: null });

  // No crm_contacts embed here: sms_messages.contact_id has no foreign key, so PostgREST cannot
  // join it (phone_calls has one, which is why the call reads embed). Names and owners are read
  // in one batch below.
  const texts = async (): Promise<Scan> => {
    let q = c.admin.from("sms_messages")
      .select("id, contact_id, direction, body, status, created_at, from_number, to_number, sent_by")
      .eq("client_id", client).order("created_at", { ascending: false }).limit(SCAN);
    if (cursor) q = q.lt("created_at", cursor);
    const msgs = (must(await q, "list texts") as MsgRow[] | null) ?? [];
    return {
      events: msgs.map((m) => ({
        key: threadKey(m), contact_id: m.contact_id, at: m.created_at, direction: m.direction,
        body: m.body ?? "", channel: "sms", sent_by: m.sent_by, sms: m,
      })),
      full: msgs.length === SCAN,
    };
  };
  // Email moves a conversation up when someone wrote it: the customer's mail and ours (kind
  // conversation or test), on a contact. Mail from someone who isn't a contact isn't listed,
  // as in the portal, and quotes and invoices show inside the conversation, not here.
  const received = async (): Promise<Scan> => {
    let q = c.admin.from("email_inbound").select("id, contact_id, subject, received_at, spam_verdict")
      .eq("client_id", client).not("contact_id", "is", null).order("received_at", { ascending: false }).limit(EMAIL_SCAN);
    if (cursor) q = q.lt("received_at", cursor);
    const rows = (must(await q, "list received email") as { id: string; contact_id: string; subject: string | null; received_at: string; spam_verdict: string | null }[] | null) ?? [];
    return {
      events: rows.map((r) => ({
        key: r.contact_id, contact_id: r.contact_id, at: r.received_at, direction: "in",
        body: r.subject ?? "", channel: "email", sent_by: null, sms: null, sender_verified: senderVerifiedFrom(r.spam_verdict),
      })),
      full: rows.length === EMAIL_SCAN,
    };
  };
  const sent = async (): Promise<Scan> => {
    let q = c.admin.from("email_sends").select("id, contact_id, subject, created_at, sent_by")
      .eq("client_id", client).not("contact_id", "is", null).in("kind", LIST_EMAIL_KINDS)
      .order("created_at", { ascending: false }).limit(EMAIL_SCAN);
    if (cursor) q = q.lt("created_at", cursor);
    const rows = (must(await q, "list sent email") as { id: string; contact_id: string; subject: string | null; created_at: string; sent_by: string | null }[] | null) ?? [];
    return {
      events: rows.map((r) => ({
        key: r.contact_id, contact_id: r.contact_id, at: r.created_at, direction: "out",
        body: r.subject ?? "", channel: "email", sent_by: r.sent_by ?? null, sms: null,
      })),
      full: rows.length === EMAIL_SCAN,
    };
  };
  const scans = await Promise.all([
    withSms ? texts() : { events: [], full: false },
    ...(withEmail ? [received(), sent()] : []),
  ]);

  // Where this page's window ends. A scan that hit its limit has read back only to its oldest
  // row; anything older, from any table, waits for the next page. Otherwise a thread could show
  // an older email as its newest while a newer text sat unread just past the end of the text
  // scan, and then show again on the next page. With texts alone this is the oldest text read.
  let boundary: string | null = null;
  for (const s of scans) {
    if (!s.full || !s.events.length) continue;
    const oldest = s.events[s.events.length - 1].at;
    if (boundary === null || oldest > boundary) boundary = oldest;
  }
  const events = scans.flatMap((s) => s.events).filter((e) => boundary === null || e.at >= boundary).sort(newestFirst);

  // Newest event per thread, its newest text (for the number), and whether I sent anything in it.
  const groups = new Map<string, { last: ThreadEvent; sms: MsgRow | null; sentByMe: boolean }>();
  for (const e of events) {
    const g = groups.get(e.key);
    if (!g) {
      groups.set(e.key, { last: e, sms: e.sms, sentByMe: e.sent_by === me });
      continue;
    }
    if (e.sent_by === me) g.sentByMe = true;
    if (!g.sms) g.sms = e.sms;
  }

  // Page 2+: a thread whose newest message is ABOVE the cursor was already shown on an earlier
  // page. Every table the list is built from is asked.
  if (cursor && groups.size) {
    const ids = [...groups.keys()].filter((k) => !k.startsWith("n:"));
    const nums = [...groups.keys()].filter((k) => k.startsWith("n:")).map((k) => k.slice(2)).filter(Boolean);
    const [newerC, newerN, newerIn, newerOut] = await Promise.all([
      withSms && ids.length
        ? c.admin.from("sms_messages").select("contact_id").eq("client_id", client).gte("created_at", cursor).in("contact_id", ids).limit(1000)
        : none,
      withSms && nums.length
        ? c.admin.from("sms_messages").select("direction, from_number, to_number, contact_id").eq("client_id", client)
          .gte("created_at", cursor).is("contact_id", null)
          .or(`from_number.in.(${nums.join(",")}),to_number.in.(${nums.join(",")})`).limit(1000)
        : none,
      withEmail && ids.length
        ? c.admin.from("email_inbound").select("contact_id").eq("client_id", client).gte("received_at", cursor).in("contact_id", ids).limit(1000)
        : none,
      withEmail && ids.length
        ? c.admin.from("email_sends").select("contact_id").eq("client_id", client).in("kind", LIST_EMAIL_KINDS)
          .gte("created_at", cursor).in("contact_id", ids).limit(1000)
        : none,
    ]);
    for (const r of (must(newerC as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
    for (const r of (must(newerN as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
    for (const r of (must(newerIn as never, "check newer email") as { contact_id: string }[] | null) ?? []) groups.delete(r.contact_id);
    for (const r of (must(newerOut as never, "check newer email") as { contact_id: string }[] | null) ?? []) groups.delete(r.contact_id);
  }

  const candidates = [...groups.entries()];
  const contactIds = [...new Set(candidates.map(([, g]) => g.last.contact_id).filter((v): v is string => !!v))];
  const [visible, contactRows] = await Promise.all([
    visibleContactIds(c, contactIds),
    contactIds.length
      ? c.admin.from("crm_contacts").select(withEmail ? "id, name, owner_user_id, phone" : "id, name, owner_user_id")
        .eq("client_id", client).in("id", contactIds)
      : none,
  ]);
  type ContactRow = { id: string; name: string | null; owner_user_id: string | null; phone?: string | null };
  const contacts = new Map<string, ContactRow>();
  for (const r of (must(contactRows as never, "read thread contacts") as ContactRow[] | null) ?? []) {
    contacts.set(r.id, r);
  }
  const unknownOk = mayReadUnknownNumbers(c.ctx);

  const threads = [];
  for (const [key, g] of candidates) {
    const contact = g.last.contact_id ? contacts.get(g.last.contact_id) ?? null : null;
    if (g.last.contact_id ? !visible.has(g.last.contact_id) : !unknownOk) continue;
    if (mine) {
      // Section 7: the contact's owner; with no owner, everyone who can see it; and anything I sent.
      const owner = contact?.owner_user_id ?? null;
      if (!(g.sentByMe || !owner || owner === me)) continue;
    }
    threads.push({
      key,
      contact_id: g.last.contact_id,
      contact_name: contact?.name ?? null,
      // The number from their newest text. A contact who has only emailed gets the one on their
      // record, and may have none (null). `e164_source` says which, so the apps fold an `n:`
      // thread into this one only when its texts are the ones filed here: a number on the record
      // says nothing about where texts from it went.
      e164: g.sms ? customerNumber(g.sms) : toE164(contact?.phone),
      ...(channels ? { e164_source: g.sms ? "sms" : "contact" } : {}),
      last: {
        body: g.last.body, direction: g.last.direction, at: g.last.at,
        ...(channels ? { channel: g.last.channel } : {}),
        // A customer's email: false when its sender failed SPF, DKIM or DMARC, so the apps don't
        // alert on a forged "From:" (the rule /push/email keeps). null is unknown, and alerts.
        ...(g.last.channel === "email" && g.last.direction === "in" ? { sender_verified: g.last.sender_verified ?? null } : {}),
      },
    });
    if (threads.length >= PAGE) break;
  }
  // A full page continues after its last thread; a full scan that filtered down to a short page
  // continues from the window's end, so nothing further back is unreachable.
  const nextCursor = threads.length >= PAGE ? threads[threads.length - 1].last.at : boundary;
  return ok({ threads, ...(nextCursor ? { cursor: nextCursor } : {}) });
}

export async function getThread(env: Env, req: Request, rawKey: string): Promise<Response> {
  const c = await requireCaller(env, req);
  const key = pathParam(rawKey);
  const notFound = () => new ApiError("not_found", "That conversation wasn't found.");
  if (c.ctx.contacts_level === "none") throw notFound();

  // from_number / to_number only to know the thread's number when there is none on record (`sms`
  // below); the messages the apps get carry neither.
  const msgCols = "id, direction, body, status, created_at, sent_by, client_temp_id, num_media, from_number, to_number";
  let msgs;
  let calls;
  let emails: ThreadEmail[];
  let compose: Compose;
  /** The number on record (a contact's phone), and the contact's own older opt-out flag. */
  let onRecord: string | null = null;
  let contactOptOutAt: string | null = null;
  if (UUID_RE.test(key)) {
    const contact = must(
      await c.admin.from("crm_contacts").select("id, owner_user_id, email, phone, sms_opt_out_at").eq("client_id", c.ctx.client_id).eq("id", key).maybeSingle(),
      "read contact",
    ) as { id: string; owner_user_id: string | null; email: string | null; phone?: string | null; sms_opt_out_at?: string | null } | null;
    if (!contact) throw notFound();
    onRecord = contact.phone ?? null;
    contactOptOutAt = contact.sms_opt_out_at ?? null;
    const seen = await visibleContactIds(c, [key]);
    if (!seen.has(key)) throw notFound();
    [msgs, calls, emails, compose] = await Promise.all([
      c.admin.from("sms_messages").select(msgCols).eq("client_id", c.ctx.client_id).eq("contact_id", key)
        .order("created_at", { ascending: false }).limit(200),
      c.admin.from("phone_calls").select(CALL_SELECT).eq("client_id", c.ctx.client_id).eq("contact_id", key)
        .order("started_at", { ascending: false }).limit(PAGE),
      contactEmails(c, key),
      composeFor(c, contact.email),
    ]);
  } else if (key.startsWith("n:")) {
    const e164 = toE164(key.slice(2));
    if (!e164 || !mayReadUnknownNumbers(c.ctx)) throw notFound();
    onRecord = e164;
    [msgs, calls] = await Promise.all([
      c.admin.from("sms_messages").select(msgCols).eq("client_id", c.ctx.client_id).is("contact_id", null)
        .or(`from_number.eq.${e164},to_number.eq.${e164}`).order("created_at", { ascending: false }).limit(200),
      c.admin.from("phone_calls").select(CALL_SELECT).eq("client_id", c.ctx.client_id).is("contact_id", null)
        .or(`from_e164.eq.${e164},to_e164.eq.${e164}`).order("started_at", { ascending: false }).limit(PAGE),
    ]);
    // Email is kept on contacts: a number nobody has saved has none, and no address to write to.
    emails = [];
    compose = { email_to: null, email_block: "unknown_number" };
  } else {
    throw new ApiError("bad_request", "That conversation key isn't valid.");
  }

  const m = (must(msgs, "read texts") as MsgRow[] | null) ?? [];
  let cr = (must(calls, "read calls") as CallWithJoins[] | null) ?? [];
  if (!isTeamLevel(c.ctx.phone_level)) cr = cr.filter((r) => isMineCall(c.userId, r));
  // The number a text from this thread goes to, so the state below is about the number Send uses.
  // A contact's: the phone on record, because POST /sms/send texts a contact there and nowhere
  // else, and portal-settings crm_record and crm_record_consent key on it too (the newest text's
  // number only when there is none on record). An unknown number's thread: its own number.
  const newestTo = m[0] ? toE164(customerNumber(m[0])) : null;
  const textTo = UUID_RE.test(key) ? (toE164(onRecord) ?? newestTo) : (newestTo ?? toE164(onRecord));
  const [callRows, sms] = await Promise.all([
    summaries(c, cr),
    smsStateFor(c, textTo, contactOptOutAt).catch(async (e: unknown) => {
      // Advice only (the send path checks again), so a failed read leaves `sms` out and the
      // thread still opens: the apps then say nothing new, as with an older Worker. Logged with
      // the database's code, never its message, which can quote the number. And never with the
      // request: app_errors.url would keep its path, and an unknown number's thread is
      // /threads/n:+1..., the number itself. The route's template instead.
      await logFault({
        code: "sms_state_read_failed",
        message: `The thread's texting state could not be read (${e instanceof DbError ? `${e.op}: ${e.pgCode ?? "no code"}` : "unexpected"}); sms left out.`,
        context: { route: "GET /threads/:key" }, clientId: c.ctx.client_id, throttleMs: 60_000,
      });
      return undefined;
    }),
  ]);
  return ok({
    messages: m.reverse().map((r) => ({
      id: r.id,
      direction: r.direction,
      body: r.body ?? "",
      status: r.status,
      at: r.created_at,
      sent_by: r.sent_by,
      client_temp_id: r.client_temp_id ?? null,
      num_media: Number(r.num_media ?? 0) || 0,
    })),
    calls: callRows,
    emails,
    compose,
    ...(sms === undefined ? {} : { sms }),
  });
}

// ── opt-out state ───────────────────────────────────────────────────────────────────

export type SmsConsent = "granted" | "none" | "revoked";
export type { SmsOptOutReason };

export interface SmsState {
  e164: string;
  opted_out: boolean;
  opted_out_at: string | null;
  consent: SmsConsent;
  opted_out_reason: SmsOptOutReason | null;
}

/**
 * sms_opt_outs.reason as the apps read it: a STOP (or Twilio's 21610), the team, anything else.
 * _shared/smsOptOut.ts's, so the portal's contact record says the same (crm_record optOutReason).
 */
export const optOutReasonOf = smsOptOutReasonOf;

/**
 * GET /threads/:key `sms` (2026-10-13, asked for 2026-10-12: "Can we see if a customer has opted
 * out?"): the send path's own facts for this number (_shared/smsSend.ts), keyed on its 10 digits
 * as that is, so the screen and Send cannot disagree:
 *   opted_out  an sms_opt_outs row for the business and number, or the contact's older
 *              crm_contacts.sms_opt_out_at;
 *   consent    revoked exactly when opted out; else granted when sms_consent_log holds any grant
 *              for the number (the question smsSend asks: "is there a grant?"); else none.
 * Null when there is no number to text (a contact who only emails).
 */
export async function smsStateFor(c: Caller, e164: string | null, contactOptOutAt: string | null): Promise<SmsState | null> {
  const digits = phoneDigits(e164);
  if (!e164 || !digits) return null;
  const [oo, grant] = await Promise.all([
    readSmsOptOut(c.admin, c.ctx.client_id, digits),
    c.admin.from("sms_consent_log").select("action")
      .eq("client_id", c.ctx.client_id).eq("phone_digits", digits).eq("action", "granted").limit(1).maybeSingle(),
  ]);
  const row = must(oo, "read the number's opt-out") as { reason: string | null; effective_at: string | null } | null;
  const granted = !!must(grant, "read the number's texting consent");
  // Either record of it, read as portal-settings crm_record reads it (_shared/smsOptOut.ts).
  const o = smsOptOutFacts(row, contactOptOutAt);
  return {
    e164,
    opted_out: o.optedOut,
    opted_out_at: o.at,
    consent: o.optedOut ? "revoked" : granted ? "granted" : "none",
    opted_out_reason: o.reason,
  };
}

/**
 * A contact's email, both ways (emailThread.ts shapes it): mail stamped with the contact, and
 * mail about any of their designs, which is how quotes and invoices are found. Sign-in codes
 * never are. The caller has already checked the contact is this tenant's and theirs to see.
 * Mail that came in with no text part has its HTML read in one more, small read: by id, for
 * those rows only.
 */
async function contactEmails(c: Caller, contactId: string): Promise<ThreadEmail[]> {
  const client = c.ctx.client_id;
  const designs = (must(
    await c.admin.from("designs").select("short_code").eq("client_id", client).eq("contact_id", contactId).limit(200),
    "read contact designs",
  ) as { short_code: string | null }[] | null) ?? [];
  const scope = contactEmailFilter(contactId, designs.map((d) => d.short_code));
  const readSent = (cols: string) =>
    c.admin.from("email_sends").select(cols).eq("client_id", client).in("kind", THREAD_EMAIL_KINDS).or(scope)
      .order("created_at", { ascending: false }).limit(EMAIL_PAGE);
  const [firstSent, receivedRes] = await Promise.all([
    readSent(SEND_COLS),
    c.admin.from("email_inbound").select(INBOUND_COLS).eq("client_id", client).or(scope)
      .order("received_at", { ascending: false }).limit(EMAIL_PAGE),
  ]);
  // A Worker deployed ahead of migration 262 is refused opened_at ("no such column"), and must()
  // would fail the WHOLE thread over it — texts and calls included. Asked once more without it,
  // the thread opens and its emails simply never read "opened".
  const sentRes = MISSING_COLUMN.has(String((firstSent as { error?: { code?: string } | null }).error?.code ?? ""))
    ? await readSent(SEND_COLS_BEFORE_262)
    : firstSent;
  const sent = (must(sentRes as never, "read sent email") as EmailSendRow[] | null) ?? [];
  const received = (must(receivedRes as never, "read received email") as EmailInboundRow[] | null) ?? [];

  const html = new Map<string, string>();
  const bare = received.filter((r) => !hasText(r.body_text)).map((r) => r.id);
  if (bare.length) {
    const rows = (must(
      await c.admin.from("email_inbound").select("id, body_html").eq("client_id", client).in("id", bare),
      "read received email html",
    ) as { id: string; body_html: string | null }[] | null) ?? [];
    for (const r of rows) if (r.body_html) html.set(r.id, r.body_html);
  }
  return threadEmails(sent, received, html);
}

/**
 * Can this person email this contact from the thread? Advice for the composer: the portal
 * action that sends (crm_send_email) checks all of it again. The paid-CRM check fails closed
 * like every paid gate (featureCheck.ts): a billing read that errors fails this read rather
 * than offer a composer that can't send. Someone who can't write is told so without it.
 */
async function composeFor(c: Caller, address: string | null): Promise<Compose> {
  const email_to = emailAddress(address);
  const canEdit = maySendToContacts(c.ctx);
  if (!canEdit) return { email_to, email_block: "no_edit" };
  const [crmPaid, settings] = await Promise.all([
    // A DbError, so app_errors names what failed rather than filing it as "unhandled".
    hasPaidFeature(c.admin, c.ctx.client_id, "crm").catch((e: unknown) => {
      throw new DbError("check the CRM subscription", (e as Error)?.message ?? String(e));
    }),
    c.admin.from("client_settings").select("email_provider, invoice_in_ghl, email_domain_status")
      .eq("client_id", c.ctx.client_id).maybeSingle(),
  ]);
  return {
    email_to,
    email_block: emailBlock({ canEdit, crmPaid, settings: must(settings, "read email settings") as EmailSettings | null, address: email_to }),
  };
}

// ── search ──────────────────────────────────────────────────────────────────────────

/** Strip what would break a PostgREST filter expression (commas, parens, wildcards, quotes). */
export function searchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N} .'@_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * The email-address half of `?email=1`: lower case, with the characters an address holds (a `+`
 * too, which searchTerm drops) and nothing a PostgREST filter would trip on. Null when it is
 * too short to search addresses by: under 3 characters with no @, a term like "co" or "ma"
 * would match every .com and gmail address.
 */
export function emailSearchTerm(q: string): string | null {
  const t = q.toLowerCase().replace(/[^\p{L}\p{N}.'@_+-]/gu, "").slice(0, 60);
  return t.length >= 3 || (t.length >= 2 && t.includes("@")) ? t : null;
}

/** The contacts GET /search reads per way of matching (by name or number, and by address). */
export const DIRECTORY_READ = 60;

/**
 * GET /search?q=: contacts by name or 3+ digits of their number, each with a number to call or
 * text. `&email=1` (2026-10-05, the phone app's New message) also matches the email address and
 * keeps a contact that has only an email: every row then carries `email` (null when there is
 * none), and `e164` is null for an email-only one. Address matches are read separately and come
 * after the name and number matches, so a common address fragment never pushes a name out of
 * the 20. Without it the answer is exactly as before, which old app builds, the extension's
 * Keypad and New message, and the Contacts tab (a call list) all read.
 *
 * Both reads go through migration 305's search function by POST (`findRows`, below), so the term
 * never rides in a URL to Supabase. The term is matched as itself (`_` is no wildcard any more),
 * and a failed read is logged with the database's code only (`quiet`).
 */
export async function search(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  if (c.ctx.contacts_level === "none") return ok({ contacts: [] });
  const url = new URL(req.url);
  const raw = url.searchParams.get("q") ?? "";
  const withEmail = url.searchParams.get("email") === "1";
  const term = searchTerm(raw);
  const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (term.length < 2 && digits.length < 3) return ok({ contacts: [] });

  type Row = { id: string; name: string | null; phone: string | null; phone_digits: string | null; email?: string | null };
  const emailTerm = withEmail ? emailSearchTerm(raw) : null;
  const [byName, byEmail] = await Promise.all([
    findRows(c, "directory", { p_term: term.length >= 2 ? term : null, p_digits: digits.length >= 3 ? digits : null, p_limit: DIRECTORY_READ }),
    // email_lower is generated (lower(btrim(email)), migration 130).
    emailTerm ? findRows(c, "directory_email", { p_term: emailTerm, p_limit: DIRECTORY_READ }) : null,
  ]);
  const named = (quiet(byName, "search contacts") as Row[] | null) ?? [];
  const found = new Set(named.map((r) => r.id));
  const addressed = byEmail ? ((quiet(byEmail, "search contacts by email") as Row[] | null) ?? []).filter((r) => !found.has(r.id)) : [];
  const rows = [...named, ...addressed];

  const visible = await visibleContactIds(c, rows.map((r) => r.id));
  const contacts = [];
  for (const r of rows) {
    if (!visible.has(r.id)) continue;
    const e164 = toE164(r.phone) ?? toE164(r.phone_digits);
    if (withEmail) {
      const email = emailAddress(r.email);
      if (!e164 && !email) continue; // nothing to call, text or email
      contacts.push({ id: r.id, name: r.name ?? "", e164, email });
    } else {
      if (!e164) continue; // nothing to call or text
      contacts.push({ id: r.id, name: r.name ?? "", e164 });
    }
    if (contacts.length >= 20) break;
  }
  return ok({ contacts });
}

// ── list search: POST /threads/search, POST /calls/search ───────────────────────────
//
// Asked for 2026-10-12: Messages searched "by anything in the message ... the names of the person,
// or the phone number", the same on Voicemail, and on Recents "I want to see if I ever called this
// number", in both My and Team. The phone repo's docs/SPEC.md section 3 "List search" is the
// contract (phone-core listSearch.ts is the client half).
//
// ⚠️ LIMITED USE. The term travels only in POST bodies, both hops: the app's request to this Worker
// (request URLs are logged here), and this Worker's requests to Supabase (decided 2026-10-13: its
// API request logs keep every URL, and a PostgREST GET carries its filters in the URL). Every read
// that filters by the term, its digits or a number the search found goes through migration 305's
// public.phone_list_search by POST rpc (findRows below); what a search still reads by GET is named
// by the tenant and row ids only (contacts and calls read back by id). The term never reaches a
// log line, phone_call_events or app_errors: a failed search read is logged with the database's
// code only (quiet below). Nothing here logs a name, a number, a text or a transcript.
//
// SCOPE: search never shows more than the lists. The function only finds candidates inside the
// tenant; the rules are applied here after it, as the lists apply them: visibleContactIds and
// mayReadUnknownNumbers for threads, then "mine" exactly as listThreads; scopeCalls and isMineCall
// for calls, as listCalls.

/** Refused under this many characters, once searchTerm has cleaned the term. */
export const LIST_SEARCH_MIN = 2;
/** The longest term the apps send (phone-core LIST_SEARCH_MAX); the Worker cuts there first too. */
export const LIST_SEARCH_MAX = 60;
const TOO_SHORT = "Type at least 2 characters to search.";

/**
 * The text a list search searches, or null to refuse it (400, TOO_SHORT). EXACTLY phone-core's
 * rule, the client half (packages/phone-core/src/listSearch.ts: listSearchTerm, then
 * listSearchCleaned on what it returns), so the Worker refuses precisely the terms the apps hold
 * back without asking and takes every term they send (workers/phone-api test/listSearch.test.ts
 * pins the two together when PHONE_CORE_DIR is set):
 *   1. what the apps send: spaces collapsed, trimmed, cut to 60, trimmed again; under 2 refused;
 *   2. what is searched: searchTerm on THAT; under 2 refused too ("+1", "(8", "#5", "$5", "a+", "?!").
 * The cut comes BEFORE the cleaning, as in the apps. Cleaning the whole body first (this route's
 * first cut) took a long term whose first 60 characters clean to nothing, and could end a term on
 * half of a character that the cut split.
 */
export function listSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const sent = raw.replace(/\s+/g, " ").trim().slice(0, LIST_SEARCH_MAX).trim();
  if (sent.length < LIST_SEARCH_MIN) return null;
  const term = searchTerm(sent);
  return term.length >= LIST_SEARCH_MIN ? term : null;
}
/** Contacts read whose name or number matches, to find their conversations. */
export const SEARCH_CONTACTS = 100;
/** Matching texts read, newest first, to find the conversations whose words or number match. */
export const SEARCH_TEXTS = 500;
/**
 * At most this many conversations are searched: contacts, and unknown numbers. Sized when they were
 * one GET's `in` list (the inbox's INBOX_ID_CHUNK, inside what a URL holds); since migration 305
 * they travel in a POST body, and the caps stay so a page and `partial` mean what they did.
 * Counted after the scope (only conversations this person may see), and past it the newest matches
 * win; the answer then says `partial: true`.
 */
export const SEARCH_THREAD_CONTACTS = 150;
export const SEARCH_THREAD_NUMBERS = 50;
/** A snippet is at most this many characters, "…" included. */
export const SNIPPET_CHARS = 160;

/**
 * The digits to match numbers by: only when the term is digits and what people type around them
 * (spaces, brackets, dashes, dots, a plus) and has 3 or more digits. Null otherwise, so "Bob 555"
 * is words. phone-core's listSearchDigits, the client half, follows the same rule.
 */
export function listSearchDigits(raw: string): string | null {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, LIST_SEARCH_MAX).trim();
  if (!/^[\d\s().+-]+$/.test(t)) return null;
  const d = t.replace(/\D/g, "");
  return d.length >= 3 ? d : null;
}

/**
 * The term as the search function matches it, for telling which field matched and where:
 * case-insensitive, and every character as itself. Migration 305 escapes LIKE's `%`, `_` and `\`,
 * so `_` (which searchTerm keeps) is an underscore, not "any one character" (it was, while the
 * reads were PostgREST `ilike` filters).
 */
export function termPattern(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

/** Does a number hold these digits? Compared on its E.164 digits, so a typed leading 1 matches too. */
function numberHas(e164: string | null | undefined, digits: string): boolean {
  return !!e164 && e164.replace(/\D/g, "").includes(digits);
}

/** The surrogate halves of one character are never split by a cut. */
const lowHalf = (s: string, i: number) => i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]);

/**
 * Up to SNIPPET_CHARS of a text around the first hit, on one line, cut with "…" where it was
 * cut. The whole text when it fits. A text the pattern can't place starts from its beginning.
 */
export function snippetAround(text: string, pattern: RegExp): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const at = pattern.exec(flat)?.index ?? 0;
  let end = Math.min(flat.length, Math.max(0, at - 40) + SNIPPET_CHARS);
  let start = Math.max(0, end - SNIPPET_CHARS);
  const pre = start > 0;
  const post = end < flat.length;
  if (pre) start += 1;
  if (post) end -= 1;
  if (lowHalf(flat, start)) start += 1;
  if (lowHalf(flat, end)) end -= 1;
  return `${pre ? "…" : ""}${flat.slice(start, end)}${post ? "…" : ""}`;
}

/** must() for a search read: on failure the database's code only, never its message (it can quote the term). */
function quiet<T>(res: { data: T | null; error: { message?: string; code?: string } | null }, op: string): T | null {
  if (res.error) throw new DbError(op, `failed (${res.error.code ?? "no code"})`, res.error.code ?? null);
  return res.data;
}

/** One read of a search, as migration 305's public.phone_list_search names it (its header says what each finds). */
type SearchKind = "texts" | "contacts" | "conversations" | "calls" | "directory" | "directory_email";

/**
 * A search read through migration 305's public.phone_list_search (security definer, service_role
 * only), by POST rpc: the term, its digits and the numbers a search found travel in the request
 * BODY, which Supabase's API request logs don't keep, where a GET's filters would ride in its URL.
 * Each kind is the PostgREST read it replaced (same filters, order and limit), inside this tenant;
 * the function escapes LIKE's `%`, `_` and `\` and finds nothing for a term under 2 characters.
 * ⚠️ Migration 305 must be applied before this Worker is deployed: without it every search, and
 * GET /search, fails (PGRST202, logged by code only).
 */
function findRows(c: Caller, kind: SearchKind, args: Record<string, unknown>) {
  return c.admin.rpc("phone_list_search", { p_client_id: c.ctx.client_id, p_kind: kind, ...args });
}

interface ListSearch {
  term: string;
  digits: string | null;
  pattern: RegExp;
  /** Team, and allowed it; otherwise the list's My. */
  team: boolean;
  cursor: string | null;
  voicemail: boolean;
}

/**
 * The POST body: {q, scope, cursor?, voicemail?}. `q` goes through listSearchTerm (phone-core's own
 * rule: cut, then cleaned like GET /search's searchTerm), and under 2 characters either way is
 * refused. `scope` other than mine or team is refused; team for someone
 * whose phone level isn't a team level means mine, as in the lists. The cursor is the lists' (an
 * ISO time), opaque to the apps.
 */
async function listSearchRequest(c: Caller, req: Request): Promise<ListSearch> {
  const body = await readJson(req);
  const term = listSearchTerm(body.q);
  if (term === null) throw new ApiError("bad_request", TOO_SHORT);
  const scope = body.scope ?? "mine";
  if (scope !== "mine" && scope !== "team") throw new ApiError("bad_request", "Search My or Team.");
  let cursor: string | null = null;
  if (body.cursor != null && body.cursor !== "") {
    const t = typeof body.cursor === "string" ? Date.parse(body.cursor) : NaN;
    if (!Number.isFinite(t)) throw new ApiError("bad_request", "That page marker isn't valid.");
    cursor = new Date(t).toISOString();
  }
  return {
    term,
    digits: listSearchDigits(body.q as string), // a string: listSearchTerm refused anything else
    pattern: termPattern(term),
    team: scope === "team" && isTeamLevel(c.ctx.phone_level),
    cursor,
    voicemail: body.voicemail === true,
  };
}

/** Why a row matched: the first of name, number, then the text or transcript. */
type ListMatch = { field: "name" | "number" | "body" | "transcript"; snippet?: string; at?: string };

/**
 * POST /threads/search: the Messages list, searched. A conversation matches when any of its texts
 * (not only the newest) holds the term, when its contact's name does, or, for a number-like term,
 * when its number does. Rows are GET /threads rows (texts only) plus `match`, one per
 * conversation, newest first by its newest text.
 *
 * Two steps. First the candidates: contacts whose name or number matches (SEARCH_CONTACTS) and the
 * newest SEARCH_TEXTS matching texts (the function's `contacts` and `texts`: a number matches on
 * the customer's side of a text only, and a contact's phone_digits with or without a typed leading
 * 1), narrowed by the contacts scope, then capped at SEARCH_THREAD_CONTACTS contacts and
 * SEARCH_THREAD_NUMBERS unknown numbers, newest matches first.
 * When a read or a cap was full, older matches may be missing, and every page says `partial: true`
 * (an addition to the contract: the apps can say "Showing the newest matches"; older builds ignore
 * it), so a cursor is never read as "this is everything".
 * Then listThreads' own walk over THOSE conversations' texts only (the function's `conversations`,
 * so an unknown number the search found travels in a body too): newest first below the cursor,
 * SCAN at a time, the "already shown on an earlier page" check, "mine", and the same cursor rule (a
 * full page continues after its last row; a full read that filtered down to a short page continues
 * from where the read ended). The candidates are the same on every page, so the pages fit together.
 * The one GET left reads the page's contacts by id.
 */
export async function searchThreads(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const s = await listSearchRequest(c, req);
  if (c.ctx.contacts_level === "none") return ok({ threads: [] });
  const client = c.ctx.client_id;
  const me = c.userId;
  const mine = !s.team;
  const none = Promise.resolve({ data: [], error: null });

  // ── the candidates (migration 305's function, by POST: the term and its digits in the body) ──
  const [textRes, contactRes] = await Promise.all([
    findRows(c, "texts", { p_term: s.term, p_digits: s.digits, p_limit: SEARCH_TEXTS }),
    findRows(c, "contacts", { p_term: s.term, p_digits: s.digits, p_limit: SEARCH_CONTACTS }),
  ]);
  const hits = (quiet(textRes, "search texts") as MsgRow[] | null) ?? [];
  const named = (quiet(contactRes, "search contacts") as { id: string }[] | null) ?? [];

  // Every candidate once, in order: the contacts found by name or number, then the conversations
  // of the matching texts, newest first.
  const contactIds: string[] = [];
  const numbers: string[] = [];
  const candidate = new Set<string>();
  const add = (key: string) => {
    if (candidate.has(key)) return;
    candidate.add(key);
    if (!key.startsWith("n:")) contactIds.push(key);
    else if (key.length > 2) numbers.push(key.slice(2));
  };
  for (const r of named) add(r.id);
  // Per conversation: its newest matching text (for the snippet), and whether a text's number matched.
  const bodyHit = new Map<string, MsgRow>();
  const numberHit = new Set<string>();
  for (const m of hits) {
    const key = threadKey(m);
    add(key);
    if (s.digits && numberHas(customerNumber(m), s.digits)) numberHit.add(key);
    if (!bodyHit.has(key) && s.pattern.test(m.body ?? "")) bodyHit.set(key, m);
  }
  // The scope first, the caps after it: a contact this person can't see never takes the place of
  // one they can (someone limited to their own customers, at a busy business), and unknown numbers
  // count only for those who may read them.
  const visible = await visibleContactIds(c, contactIds);
  const seenIds = contactIds.filter((id) => visible.has(id));
  const readable = mayReadUnknownNumbers(c.ctx) ? numbers : [];
  const ids = seenIds.slice(0, SEARCH_THREAD_CONTACTS);
  const nums = readable.slice(0, SEARCH_THREAD_NUMBERS);
  const partial = named.length === SEARCH_CONTACTS || hits.length === SEARCH_TEXTS
    || seenIds.length > SEARCH_THREAD_CONTACTS || readable.length > SEARCH_THREAD_NUMBERS;
  if (!ids.length && !nums.length) return ok({ threads: [], ...(partial ? { partial: true } : {}) });
  const wanted = new Set([...ids, ...nums.map((n) => `n:${n}`)]);

  // ── listThreads' walk, over the candidates' texts only (by POST too: the unknown numbers it
  // names are what the search matched) ──
  const msgs = (quiet(
    await findRows(c, "conversations", { p_ids: ids, p_numbers: nums, p_before: s.cursor, p_limit: SCAN }),
    "read the matching conversations",
  ) as MsgRow[] | null) ?? [];
  const boundary = msgs.length === SCAN ? msgs[msgs.length - 1].created_at : null;

  const groups = new Map<string, { last: MsgRow; sentByMe: boolean }>();
  for (const m of msgs) {
    const key = threadKey(m);
    if (!wanted.has(key)) continue;
    const g = groups.get(key);
    if (!g) groups.set(key, { last: m, sentByMe: m.sent_by === me });
    else if (m.sent_by === me) g.sentByMe = true;
  }

  // Page 2+: a conversation with a text at or above the cursor was shown on an earlier page.
  if (s.cursor && groups.size) {
    const pageIds = [...groups.keys()].filter((k) => !k.startsWith("n:"));
    const pageNums = [...groups.keys()].filter((k) => k.startsWith("n:")).map((k) => k.slice(2));
    const newer = (which: { p_ids: string[] } | { p_numbers: string[] }) =>
      findRows(c, "conversations", { ...which, p_after: s.cursor, p_limit: 1000 });
    const [newerC, newerN] = await Promise.all([
      pageIds.length ? newer({ p_ids: pageIds }) : none,
      pageNums.length ? newer({ p_numbers: pageNums }) : none,
    ]);
    for (const r of (quiet(newerC as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
    for (const r of (quiet(newerN as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
  }

  type ContactRow = { id: string; name: string | null; owner_user_id: string | null; phone_digits: string | null };
  const pageContactIds = [...groups.keys()].filter((k) => !k.startsWith("n:"));
  const contactRows = pageContactIds.length
    ? await c.admin.from("crm_contacts").select("id, name, owner_user_id, phone_digits").eq("client_id", client).in("id", pageContactIds)
    : { data: [], error: null };
  const contacts = new Map<string, ContactRow>();
  for (const r of (quiet(contactRows as never, "read the conversations' contacts") as ContactRow[] | null) ?? []) contacts.set(r.id, r);

  const threads = [];
  for (const [key, g] of groups) {
    const contact = g.last.contact_id ? contacts.get(g.last.contact_id) ?? null : null;
    if (mine) {
      // listThreads' rule: the contact's owner; with no owner, everyone who can see it; and anything I sent.
      const owner = contact?.owner_user_id ?? null;
      if (!(g.sentByMe || !owner || owner === me)) continue;
    }
    const e164 = customerNumber(g.last);
    let match: ListMatch | null = null;
    if (contact?.name && s.pattern.test(contact.name)) match = { field: "name" };
    else if (s.digits && (numberHit.has(key) || numberHas(e164, s.digits) || numberHas(contact?.phone_digits ? `1${contact.phone_digits}` : null, s.digits))) {
      match = { field: "number" };
    } else {
      const hit = bodyHit.get(key);
      if (hit) match = { field: "body", snippet: snippetAround(hit.body ?? "", s.pattern), at: hit.created_at };
    }
    threads.push({
      key,
      contact_id: g.last.contact_id,
      contact_name: contact?.name ?? null,
      e164,
      last: { body: g.last.body ?? "", direction: g.last.direction, at: g.last.created_at },
      ...(match ? { match } : {}),
    });
    if (threads.length >= PAGE) break;
  }
  const nextCursor = threads.length >= PAGE ? threads[threads.length - 1].last.at : boundary;
  // Counts only: never the term, a name, a number or a text.
  console.log(`[phone-api] threads search: term ${s.term.length} chars${s.digits ? ", number-like" : ""}, ${ids.length + nums.length} candidates${partial ? " (partial)" : ""}, ${threads.length} rows`);
  return ok({ threads, ...(nextCursor ? { cursor: nextCursor } : {}), ...(partial ? { partial: true } : {}) });
}

/**
 * POST /calls/search: Recents (or, with `voicemail`, the Voicemail tab) searched. A call matches
 * by its contact's name, its customer number (a number-like term), or its voicemail's transcript.
 * Rows are GET /calls rows plus `match`, newest first by started_at, paged like GET /calls.
 *
 * Two steps. First migration 305's function (`calls`, by POST: the term and its digits in the body)
 * finds the newest PAGE calls below the cursor that match any way: by the contact's name, by number
 * (the customer's side of the call only, so the business's own number matches nothing), or by the
 * transcript of a voicemail that isn't deleted (retention deletes the words with the audio).
 * Recording transcripts and summaries are not searched: those are read only on request (GET
 * /calls/:id/transcript). For My it asks the database for MY calls, as listCalls reads My, so a
 * page isn't spent on the team's: the calls I took part in, and the unanswered calls on customers I
 * own. The Voicemail tab (`voicemail`) keeps to calls with a voicemail that isn't deleted.
 * Then the rows, read back by id with GET /calls's own columns (the Voicemail tab's join as
 * `?voicemail=1` reads it), in the function's order. A full page hands back a cursor (its oldest
 * call), as GET /calls's does. Then scopeCalls and, for My, isMineCall, as listCalls.
 */
export async function searchCalls(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const s = await listSearchRequest(c, req);
  const me = c.userId;
  // Contacts `none` sees no customer's call, so neither a name nor "my customers" can find one.
  const customers = c.ctx.contacts_level !== "none";

  const found = (quiet(await findRows(c, "calls", {
    p_term: s.term, p_digits: s.digits, p_before: s.cursor, p_limit: PAGE, p_voicemail: s.voicemail,
    p_user_id: s.team ? null : me, p_customers: customers,
  }), "search calls") as { id: string; started_at: string }[] | null) ?? [];

  let fetched: CallWithJoins[] = [];
  if (found.length) {
    let q = c.admin.from("phone_calls")
      .select(`${CALL_COLUMNS}, crm_contacts(name, owner_user_id), ${s.voicemail ? VM_INNER : VM_SELECT}, ${REC_SELECT}`)
      .eq("client_id", c.ctx.client_id).in("id", found.map((r) => r.id));
    if (s.voicemail) q = q.is("phone_voicemails.deleted_at", null);
    const read = (quiet(await q, "read the matching calls") as CallWithJoins[] | null) ?? [];
    const order = new Map(found.map((r, i) => [r.id, i]));
    fetched = read.filter((r) => order.has(r.id)).sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  }
  const nextCursor = found.length === PAGE ? found[PAGE - 1].started_at : null;

  let rows = await scopeCalls(c, fetched);
  if (!s.team) rows = rows.filter((r) => isMineCall(me, r));
  const calls = (await summaries(c, rows)).map((row) => {
    let match: ListMatch | null = null;
    if (row.contact_name && s.pattern.test(row.contact_name)) match = { field: "name" };
    else if (s.digits && numberHas(row.e164, s.digits)) match = { field: "number" };
    else if (row.voicemail?.transcript && s.pattern.test(row.voicemail.transcript)) {
      match = { field: "transcript", snippet: snippetAround(row.voicemail.transcript, s.pattern) };
    }
    return { ...row, ...(match ? { match } : {}) };
  });
  // Counts only: never the term, a name, a number or a transcript.
  console.log(`[phone-api] calls search: term ${s.term.length} chars${s.digits ? ", number-like" : ""}${s.voicemail ? ", voicemail" : ""}, ${found.length} found, ${fetched.length} read, ${calls.length} rows`);
  return ok({ calls, ...(nextCursor ? { cursor: nextCursor } : {}) });
}

// ── contacts (A-Z) ──────────────────────────────────────────────────────────────────

/** Contacts read per page of GET /contacts. */
export const CONTACTS_PAGE = 200;
/**
 * Someone limited to their own customers: one request reads on, page after page, until it has
 * this many to show or has read CONTACTS_NARROWED_SCAN rows, so a rep with a handful of
 * customers in a big business gets them in a request or two, not one empty page per 200.
 */
export const CONTACTS_NARROWED_WANT = 50;
export const CONTACTS_NARROWED_SCAN = 2000;

/** The page marker of GET /contacts: how many contacts the earlier pages read. */
function contactsOffset(url: URL): number {
  const raw = url.searchParams.get("cursor");
  if (!raw) return 0;
  if (!/^\d{1,7}$/.test(raw)) throw new ApiError("bad_request", "That page marker isn't valid.");
  return Number(raw);
}

/**
 * GET /contacts?cursor=: every contact the caller may see, A-Z by name (2026-10-07, the phone
 * app's Contacts tab, which used to be search only). Rows are shaped like /search?email=1:
 * { id, name, e164, email }, where e164 is null for an email-only contact; a contact with
 * neither is left out, as there is nothing to call, text or email. A contact with no name
 * sorts last (its name is "").
 *
 * Postgres sorts: the database's ICU collation already orders names the way people read them
 * (case and accents folded), so the app keeps this order and never re-sorts. Pages are read
 * by offset, CONTACTS_PAGE rows at a time, like the portal's Contacts list. "cursor" (the next
 * offset) is there whenever the last READ was full, which is what "there may be more" means;
 * an offset past the end just reads nothing. Someone limited to their own customers gets the
 * visible rows of what was read, so a page can still come back short or even empty, and the
 * app keeps asking until "cursor" is gone.
 */
export async function listContacts(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  if (c.ctx.contacts_level === "none") return ok({ contacts: [] });
  const from = contactsOffset(new URL(req.url));

  type Row = { id: string; name: string | null; phone: string | null; phone_digits: string | null; email: string | null };
  const narrowed = narrowedToOwn(c.ctx);
  const contacts: { id: string; name: string; e164: string | null; email: string | null }[] = [];
  let at = from;
  let more = true;
  do {
    const res = await c.admin.from("crm_contacts").select("id, name, phone, phone_digits, email")
      .eq("client_id", c.ctx.client_id).is("merged_into", null)
      .order("name", { ascending: true, nullsFirst: false }).order("id", { ascending: true })
      .range(at, at + CONTACTS_PAGE - 1);
    const rows = (must(res, "list contacts") as Row[] | null) ?? [];
    at += CONTACTS_PAGE;
    more = rows.length >= CONTACTS_PAGE;
    const visible = await visibleContactIds(c, rows.map((r) => r.id));
    for (const r of rows) {
      if (!visible.has(r.id)) continue;
      const e164 = toE164(r.phone) ?? toE164(r.phone_digits);
      const email = emailAddress(r.email);
      if (!e164 && !email) continue; // nothing to call, text or email
      contacts.push({ id: r.id, name: r.name ?? "", e164, email });
    }
  } while (narrowed && more && contacts.length < CONTACTS_NARROWED_WANT && at - from < CONTACTS_NARROWED_SCAN);
  return ok({ contacts, ...(more ? { cursor: String(at) } : {}) });
}

// ── team ────────────────────────────────────────────────────────────────────────────

export async function team(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const [users, settings] = await Promise.all([
    c.admin.from("client_users").select("user_id, full_name, role, title, access").eq("client_id", c.ctx.client_id),
    c.admin.from("phone_user_settings").select("user_id, device_generation").eq("client_id", c.ctx.client_id),
  ]);
  const gen = new Map<string, number>();
  for (const s of (must(settings, "read phone settings") as { user_id: string; device_generation: number }[] | null) ?? []) {
    gen.set(s.user_id, Number(s.device_generation) >= 1 ? Number(s.device_generation) : 1);
  }
  const members = [];
  for (const u of (must(users, "read team") as { user_id: string; full_name: string | null; role: string | null; title: string | null; access: Record<string, unknown> | null }[] | null) ?? []) {
    if (!UUID_RE.test(u.user_id) || phoneLevelOf(u) === "none") continue;
    members.push({ user_id: u.user_id, full_name: u.full_name, identity_base: toIdentity(u.user_id, gen.get(u.user_id) ?? 1) });
  }
  members.sort((a, b) => String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")));
  return ok({ members });
}
