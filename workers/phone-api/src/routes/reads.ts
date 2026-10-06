// The apps' read endpoints: GET /threads, /threads/:key, /calls, /search and /team.
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
import { ApiError, ok, pathParam, UUID_RE } from "../http";
import { toE164, toIdentity } from "../identity";
import { callIsMine, isTeamLevel, mayReadUnknownNumbers, maySendToContacts, phoneLevelOf, visibleContactIds } from "../scope";

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

export async function listCalls(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  const url = new URL(req.url);
  const cursor = cursorParam(url);
  const team = url.searchParams.get("scope") === "team" && isTeamLevel(c.ctx.phone_level);
  const me = c.userId;

  const base = (select: string) => {
    let q = c.admin.from("phone_calls").select(select).eq("client_id", c.ctx.client_id)
      .order("started_at", { ascending: false }).limit(PAGE);
    if (cursor) q = q.lt("started_at", cursor);
    return q;
  };

  let fetched: CallWithJoins[];
  let full: boolean;
  if (team) {
    fetched = (must(await base(CALL_SELECT), "list team calls") as CallWithJoins[] | null) ?? [];
    full = fetched.length === PAGE;
  } else {
    // "Mine" is two sources: calls I placed, answered, handed on or was rung for; and missed
    // calls / voicemails on contacts I OWN, which ring whoever the route rings, not me.
    const [a, b] = await Promise.all([
      base(CALL_SELECT).or(`placed_by.eq.${me},answered_by.eq.${me},transferred_from.eq.${me},rang_user_ids.cs.{${me}}`),
      base(`${CALL_COLUMNS}, crm_contacts!inner(name, owner_user_id), ${VM_SELECT}, ${REC_SELECT}`)
        .eq("crm_contacts.owner_user_id", me).in("status", ["missed", "voicemail", "ringing"]),
    ]);
    const ra = (must(a, "list my calls") as CallWithJoins[] | null) ?? [];
    const rb = (must(b, "list my customers' missed calls") as CallWithJoins[] | null) ?? [];
    full = ra.length === PAGE || rb.length === PAGE;
    const byId = new Map<string, CallWithJoins>();
    for (const r of [...ra, ...rb]) byId.set(r.id, r);
    fetched = [...byId.values()]
      .sort((x, y) => (x.started_at < y.started_at ? 1 : x.started_at > y.started_at ? -1 : 0))
      .slice(0, PAGE);
  }
  const nextCursor = full && fetched.length ? fetched[fetched.length - 1].started_at : null;

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

  const msgCols = "id, direction, body, status, created_at, sent_by, client_temp_id, num_media";
  let msgs;
  let calls;
  let emails: ThreadEmail[];
  let compose: Compose;
  if (UUID_RE.test(key)) {
    const contact = must(
      await c.admin.from("crm_contacts").select("id, owner_user_id, email").eq("client_id", c.ctx.client_id).eq("id", key).maybeSingle(),
      "read contact",
    ) as { id: string; owner_user_id: string | null; email: string | null } | null;
    if (!contact) throw notFound();
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
    calls: await summaries(c, cr),
    emails,
    compose,
  });
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

/**
 * GET /search?q=: contacts by name or 3+ digits of their number, each with a number to call or
 * text. `&email=1` (2026-10-05, the phone app's New message) also matches the email address and
 * keeps a contact that has only an email: every row then carries `email` (null when there is
 * none), and `e164` is null for an email-only one. Address matches are read separately and come
 * after the name and number matches, so a common address fragment never pushes a name out of
 * the 20. Without it the answer is exactly as before, which old app builds, the extension's
 * Keypad and New message, and the Contacts tab (a call list) all read.
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

  const ors: string[] = [];
  if (term.length >= 2) ors.push(`name.ilike.*${term}*`);
  if (digits.length >= 3) ors.push(`phone_digits.like.*${digits}*`);
  type Row = { id: string; name: string | null; phone: string | null; phone_digits: string | null; email?: string | null };
  const contactsQuery = () =>
    c.admin.from("crm_contacts").select(withEmail ? "id, name, phone, phone_digits, email" : "id, name, phone, phone_digits")
      .eq("client_id", c.ctx.client_id).is("merged_into", null)
      .order("updated_at", { ascending: false }).limit(60);
  const emailTerm = withEmail ? emailSearchTerm(raw) : null;
  const [byName, byEmail] = await Promise.all([
    contactsQuery().or(ors.join(",")),
    // email_lower is generated (lower(btrim(email)), migration 130).
    emailTerm ? contactsQuery().ilike("email_lower", `*${emailTerm}*`) : null,
  ]);
  const named = (must(byName, "search contacts") as Row[] | null) ?? [];
  const found = new Set(named.map((r) => r.id));
  const addressed = byEmail ? ((must(byEmail, "search contacts by email") as Row[] | null) ?? []).filter((r) => !found.has(r.id)) : [];
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
