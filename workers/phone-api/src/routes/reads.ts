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

import type { Env } from "../env";
import { requireCaller, type Caller } from "../context";
import { CALL_COLUMNS, must, type CallRow } from "../db";
import { ApiError, ok, pathParam, UUID_RE } from "../http";
import { toE164, toIdentity } from "../identity";
import { callIsMine, isTeamLevel, mayReadUnknownNumbers, phoneLevelOf, visibleContactIds } from "../scope";

const PAGE = 50;
const SCAN = 500;

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
};

interface VoicemailJoin {
  id: string;
  duration_s: number | null;
  listened_at: string | null;
  deleted_at: string | null;
  /** Twilio's transcription (TRANSCRIBE=on), or null. */
  transcript?: string | null;
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

const VM_SELECT = "phone_voicemails(id, duration_s, listened_at, deleted_at, transcript)";
const CALL_SELECT = `${CALL_COLUMNS}, crm_contacts(name, owner_user_id), ${VM_SELECT}`;

export function callSummary(r: CallWithJoins) {
  const contact = one(r.crm_contacts);
  const vm = one(r.phone_voicemails);
  return {
    id: r.id,
    direction: r.direction,
    e164: r.direction === "in" ? r.from_e164 : r.to_e164,
    contact_id: r.contact_id,
    contact_name: contact?.name ?? null,
    status: r.status,
    started_at: r.started_at,
    duration_s: r.duration_s,
    answered_by: r.answered_by,
    voicemail: vm && !vm.deleted_at
      ? { id: vm.id, duration_s: vm.duration_s, listened: !!vm.listened_at, transcript: vm.transcript ?? null }
      : null,
  };
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
      base(`${CALL_COLUMNS}, crm_contacts!inner(name, owner_user_id), ${VM_SELECT}`)
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
  return ok({ calls: rows.map(callSummary), ...(nextCursor ? { cursor: nextCursor } : {}) });
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

export async function listThreads(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  if (c.ctx.contacts_level === "none") return ok({ threads: [] });
  const url = new URL(req.url);
  const cursor = cursorParam(url);
  const mine = url.searchParams.get("mine") === "1" || !isTeamLevel(c.ctx.phone_level);
  const me = c.userId;

  // No crm_contacts embed here: sms_messages.contact_id has no foreign key, so PostgREST cannot
  // join it (phone_calls has one, which is why the call reads embed). Names and owners are read
  // in one batch below.
  let q = c.admin.from("sms_messages")
    .select("id, contact_id, direction, body, status, created_at, from_number, to_number, sent_by")
    .eq("client_id", c.ctx.client_id).order("created_at", { ascending: false }).limit(SCAN);
  if (cursor) q = q.lt("created_at", cursor);
  const msgs = (must(await q, "list texts") as MsgRow[] | null) ?? [];

  // Newest message per thread, and whether I sent anything in it.
  const groups = new Map<string, { last: MsgRow; sentByMe: boolean }>();
  for (const m of msgs) {
    const key = threadKey(m);
    const g = groups.get(key);
    if (!g) groups.set(key, { last: m, sentByMe: m.sent_by === me });
    else if (m.sent_by === me) g.sentByMe = true;
  }

  // Page 2+: a thread whose newest text is ABOVE the cursor was already shown on an earlier page.
  if (cursor && groups.size) {
    const ids = [...groups.keys()].filter((k) => !k.startsWith("n:"));
    const nums = [...groups.keys()].filter((k) => k.startsWith("n:")).map((k) => k.slice(2)).filter(Boolean);
    const [newerC, newerN] = await Promise.all([
      ids.length
        ? c.admin.from("sms_messages").select("contact_id").eq("client_id", c.ctx.client_id).gte("created_at", cursor).in("contact_id", ids).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      nums.length
        ? c.admin.from("sms_messages").select("direction, from_number, to_number, contact_id").eq("client_id", c.ctx.client_id)
          .gte("created_at", cursor).is("contact_id", null)
          .or(`from_number.in.(${nums.join(",")}),to_number.in.(${nums.join(",")})`).limit(1000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of (must(newerC as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
    for (const r of (must(newerN as never, "check newer texts") as MsgRow[] | null) ?? []) groups.delete(threadKey(r));
  }

  const candidates = [...groups.entries()];
  const contactIds = [...new Set(candidates.map(([, g]) => g.last.contact_id).filter((v): v is string => !!v))];
  const [visible, contactRows] = await Promise.all([
    visibleContactIds(c, contactIds),
    contactIds.length
      ? c.admin.from("crm_contacts").select("id, name, owner_user_id").eq("client_id", c.ctx.client_id).in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const contacts = new Map<string, { name: string | null; owner_user_id: string | null }>();
  for (const r of (must(contactRows as never, "read thread contacts") as { id: string; name: string | null; owner_user_id: string | null }[] | null) ?? []) {
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
      e164: customerNumber(g.last),
      last: { body: g.last.body ?? "", direction: g.last.direction, at: g.last.created_at },
    });
    if (threads.length >= PAGE) break;
  }
  // A full page continues after its last thread; a full scan that filtered down to a short page
  // continues after the oldest text it read, so nothing further back is unreachable.
  const nextCursor = threads.length >= PAGE
    ? threads[threads.length - 1].last.at
    : msgs.length === SCAN ? msgs[msgs.length - 1].created_at : null;
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
  if (UUID_RE.test(key)) {
    const contact = must(
      await c.admin.from("crm_contacts").select("id, owner_user_id").eq("client_id", c.ctx.client_id).eq("id", key).maybeSingle(),
      "read contact",
    );
    if (!contact) throw notFound();
    const seen = await visibleContactIds(c, [key]);
    if (!seen.has(key)) throw notFound();
    [msgs, calls] = await Promise.all([
      c.admin.from("sms_messages").select(msgCols).eq("client_id", c.ctx.client_id).eq("contact_id", key)
        .order("created_at", { ascending: false }).limit(200),
      c.admin.from("phone_calls").select(CALL_SELECT).eq("client_id", c.ctx.client_id).eq("contact_id", key)
        .order("started_at", { ascending: false }).limit(PAGE),
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
    calls: cr.map(callSummary),
  });
}

// ── search ──────────────────────────────────────────────────────────────────────────

/** Strip what would break a PostgREST filter expression (commas, parens, wildcards, quotes). */
export function searchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N} .'@_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export async function search(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req);
  if (c.ctx.contacts_level === "none") return ok({ contacts: [] });
  const raw = new URL(req.url).searchParams.get("q") ?? "";
  const term = searchTerm(raw);
  const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (term.length < 2 && digits.length < 3) return ok({ contacts: [] });

  const ors: string[] = [];
  if (term.length >= 2) ors.push(`name.ilike.*${term}*`);
  if (digits.length >= 3) ors.push(`phone_digits.like.*${digits}*`);
  const rows = (must(
    await c.admin.from("crm_contacts").select("id, name, phone, phone_digits")
      .eq("client_id", c.ctx.client_id).is("merged_into", null).or(ors.join(","))
      .order("updated_at", { ascending: false }).limit(60),
    "search contacts",
  ) as { id: string; name: string | null; phone: string | null; phone_digits: string | null }[] | null) ?? [];

  const visible = await visibleContactIds(c, rows.map((r) => r.id));
  const contacts = [];
  for (const r of rows) {
    if (!visible.has(r.id)) continue;
    const e164 = toE164(r.phone) ?? toE164(r.phone_digits);
    if (!e164) continue; // nothing to call or text
    contacts.push({ id: r.id, name: r.name ?? "", e164 });
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
