// Admin → Support chats (Ahsan 2026-10-30): every Studio Assistant chat, newest first, for an
// operator to read. READ-ONLY: nothing here writes a chat, a message or a ticket.
//
// The chats live in support_conversations and support_messages (migration 340). Both are
// service-role only (RLS on, no policies, every browser grant revoked), so the portal cannot read
// them and this module is the only way an operator sees them.
//
// WHO MAY READ, in order:
//   * admin-catalog's checkAdminAuth: an operator JWT or the break-glass password. A support
//     operator and a builder are refused there.
//   * here: the OPERATOR path only. A chat holds a builder's own words about their customers, and
//     the password path has no person to name; every chat opened here is recorded in admin_audit
//     with who opened it, which chat, and whose it is.
// Both actions are on admin-catalog's READ_ONLY_ACTIONS: reading needs no can_write.
//
// Builders were told (the chat panel, migration 340's header) that chats are saved so our team can
// follow up, and kept 180 days. support-agent deletes a chat after 180 days without a message;
// nothing here keeps one longer.
//
// A link to one chat is /console/chats?chat=<id> (the portal's Admin → Support chats tab). Tickets
// handed off from a chat may carry it; support_chat_get takes the chat id alone for that reason and
// reads the builder from the chat itself.

// deno-lint-ignore no-explicit-any
type Db = any;
type Identity = { via: string; userId?: string; email?: string };
type Json = (b: unknown, s?: number) => Response;
export type ChatDeps = { env: (name: string) => string | undefined; now: () => Date };

export const SUPPORT_CHAT_ACTIONS: readonly string[] = ["support_chats_list", "support_chat_get"];

/** Chats per page. One more is read to learn whether older ones exist. */
export const CHATS_PAGE = 50;
/** The most messages one chat's read returns. The caps (12 per person per 10 minutes, 60 per
 *  builder per day) keep a chat far below this; a longer one says so (`truncated`). */
export const CHAT_MESSAGES_MAX = 1000;
/** The first question's preview in the list, in characters. */
export const PREVIEW_CHARS = 200;
/** support-agent's own default ceiling (agent.ts DEFAULT_MONTHLY_CAP_USD). Repeated, not imported:
 *  importing agent.ts would bundle the assistant's knowledge into admin-catalog. A test holds the
 *  two equal. */
export const DEFAULT_MONTHLY_CAP_USD = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const STATUSES = ["open", "handed_off", "closed"];
const CONV_COLS = "id, client_id, user_id, status, submission_id, model, message_count, cost_micros, created_at, last_message_at";
const MSG_COLS = "id, role, body, tools, cost_micros, model, created_at";
/** The tables themselves are missing: a database without migration 340. */
const missing = (err: unknown) => ["42P01", "PGRST205"].includes(String((err as { code?: string } | null)?.code ?? ""));
const NOT_APPLIED = { error: "Migration 340 isn't applied on this database yet.", code: "support_chats_unavailable" };

/** The calendar month support_usage() sums spend over: midnight UTC on the 1st. */
export function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** The monthly ceiling support-agent enforces, in micros (agent.ts monthlyCapMicros, the same rule). */
export function monthlyCapMicros(env: (name: string) => string | undefined): number {
  const n = Number(env("SUPPORT_AI_MONTHLY_CAP_USD"));
  return Math.round((Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_CAP_USD) * 1_000_000);
}

/** One line of a builder's first question: whitespace folded, cut at PREVIEW_CHARS. */
export function previewOf(body: unknown): string {
  const s = String(body ?? "").replace(/\s+/g, " ").trim();
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS - 1).trimEnd() + "…" : s;
}

type Person = { name: string | null; email: string | null };
type Ticket = { id: string; title: string | null; status: string | null };

/** The builder's login behind each chat. A login that is gone, or a lookup that fails, shows no
 *  person; it never fails the page. */
async function peopleOf(sb: Db, ids: string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  await Promise.all(ids.map(async (id) => {
    try {
      const { data, error } = await sb.auth.admin.getUserById(id);
      if (error || !data?.user) return;
      const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      const name = String(meta.full_name || meta.name || "").trim().slice(0, 120) || null;
      out.set(id, { name, email: data.user.email ?? null });
    } catch { /* no person on that row */ }
  }));
  return out;
}

/** Every builder's name. A failed read leaves the names out, never the chats. */
async function namesOf(sb: Db): Promise<Map<string, string | null>> {
  const r = await sb.from("client_configs").select("client_id, company_name");
  return new Map(((r.error ? [] : r.data ?? []) as { client_id: string; company_name: string | null }[])
    .map((c) => [String(c.client_id), c.company_name ?? null]));
}

/** The tickets these chats became. A failed read shows "became a ticket" without its title. */
async function ticketsOf(sb: Db, ids: string[]): Promise<Map<string, Ticket>> {
  if (!ids.length) return new Map();
  const r = await sb.from("feedback_submissions").select("id, title, status").in("id", ids);
  return new Map(((r.error ? [] : r.data ?? []) as Ticket[]).map((t) => [String(t.id), { id: String(t.id), title: t.title ?? null, status: t.status ?? null }]));
}

/** Each chat's first question. One read for the page; only when that read came back full (a page
 *  of very long chats) is each chat still without one read on its own. Best-effort: a failed read
 *  shows the chats without their first question. */
async function firstQuestionsOf(sb: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const READ = 1000;
  const r = await sb.from("support_messages").select("conversation_id, body, created_at")
    .in("conversation_id", ids).eq("role", "user").order("created_at", { ascending: true }).limit(READ);
  if (r.error) return out;
  const rows = (r.data ?? []) as { conversation_id: string; body: string }[];
  for (const m of rows) if (!out.has(String(m.conversation_id))) out.set(String(m.conversation_id), previewOf(m.body));
  if (rows.length >= READ) {
    await Promise.all(ids.filter((id) => !out.has(id)).map(async (id) => {
      const one = await sb.from("support_messages").select("conversation_id, body, created_at")
        .eq("conversation_id", id).eq("role", "user").order("created_at", { ascending: true }).limit(1);
      const m = !one.error && (one.data ?? [])[0];
      if (m) out.set(id, previewOf(m.body));
    }));
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function chatView(c: any, names: Map<string, string | null>, people: Map<string, Person>, tickets: Map<string, Ticket>, first?: Map<string, string>) {
  const sub = c.submission_id ? String(c.submission_id) : null;
  return {
    id: String(c.id), clientId: String(c.client_id), companyName: names.get(String(c.client_id)) ?? null,
    person: people.get(String(c.user_id)) ?? null,
    status: String(c.status),
    ticket: sub ? (tickets.get(sub) ?? { id: sub, title: null, status: null }) : null,
    messageCount: Number(c.message_count) || 0, costMicros: Number(c.cost_micros) || 0, model: c.model ?? null,
    createdAt: c.created_at, lastMessageAt: c.last_message_at,
    ...(first ? { firstQuestion: first.get(String(c.id)) ?? null } : {}),
  };
}

/** This month across every builder: what the assistant was asked and what it cost against the
 *  ceiling. Spend comes from support_usage(), the very sum support-agent checks before each answer.
 *  A count that fails reads null (the page shows a dash), never 0. */
async function monthOf(sb: Db, deps: ChatDeps) {
  const since = monthStartUtc(deps.now());
  const head = { count: "exact", head: true };
  const [usage, chats, questions, tickets] = await Promise.all([
    sb.rpc("support_usage", { p_client_id: "", p_user_id: NIL_UUID }),
    sb.from("support_conversations").select("id", head).gte("created_at", since),
    sb.from("support_messages").select("id", head).eq("role", "user").gte("created_at", since),
    sb.from("feedback_submissions").select("id", head).eq("kind", "ticket").not("support_conversation_id", "is", null).gte("created_at", since),
  ]);
  const n = (r: { error?: unknown; count?: number | null }) => (r.error ? null : Number(r.count ?? 0));
  return {
    since,
    chats: n(chats), questions: n(questions), tickets: n(tickets),
    costMicros: usage.error ? null : Number(usage.data?.month_cost_micros) || 0,
    capMicros: monthlyCapMicros(deps.env),
  };
}

/** The builders that have chats, for the page's filter: each with its number of chats. */
async function buildersOf(sb: Db, names: Map<string, string | null>) {
  const LIMIT = 10000;
  const r = await sb.from("support_conversations").select("client_id").limit(LIMIT);
  if (r.error) return null;
  const counts = new Map<string, number>();
  for (const c of (r.data ?? []) as { client_id: string }[]) counts.set(String(c.client_id), (counts.get(String(c.client_id)) ?? 0) + 1);
  return [...counts].map(([clientId, chats]) => ({ clientId, companyName: names.get(clientId) ?? null, chats }))
    .sort((a, b) => String(a.companyName || a.clientId).localeCompare(String(b.companyName || b.clientId)));
}

const optional = (v: unknown) => (v == null || v === "" ? null : String(v));

async function listChats(sb: Db, p: Record<string, unknown>, json: Json, deps: ChatDeps) {
  const before = optional(p.before);
  if (before !== null && (before.length > 40 || Number.isNaN(Date.parse(before)))) return json({ error: "That page marker isn't a date." }, 400);
  const clientId = optional(p.clientId);
  if (clientId !== null && !CLIENT_ID.test(clientId)) return json({ error: "That isn't a builder id." }, 400);
  const status = optional(p.status);
  if (status !== null && !STATUSES.includes(status)) return json({ error: "Status is open, handed_off or closed." }, 400);

  let q = sb.from("support_conversations").select(CONV_COLS);
  if (clientId) q = q.eq("client_id", clientId);
  if (status) q = q.eq("status", status);
  if (before) q = q.lt("last_message_at", before);
  const r = await q.order("last_message_at", { ascending: false }).limit(CHATS_PAGE + 1);
  if (r.error && missing(r.error)) return json({ ok: true, installed: false, chats: [], more: false, next: null });
  if (r.error) throw r.error;
  // deno-lint-ignore no-explicit-any
  const all = (r.data ?? []) as any[];
  const rows = all.slice(0, CHATS_PAGE);
  const more = all.length > CHATS_PAGE;
  const uniq = (xs: unknown[]) => [...new Set(xs.filter(Boolean).map(String))];

  const [names, people, tickets, first] = await Promise.all([
    namesOf(sb),
    peopleOf(sb, uniq(rows.map((c) => c.user_id))),
    ticketsOf(sb, uniq(rows.map((c) => c.submission_id))),
    firstQuestionsOf(sb, rows.map((c) => String(c.id))),
  ]);
  const firstPage = before === null;
  const [month, builders] = firstPage ? await Promise.all([monthOf(sb, deps), buildersOf(sb, names)]) : [undefined, undefined];
  return json({
    ok: true, installed: true,
    chats: rows.map((c) => chatView(c, names, people, tickets, first)),
    more, next: more ? rows[rows.length - 1].last_message_at : null,
    ...(firstPage ? { month, builders } : {}),
  });
}

async function getChat(sb: Db, p: Record<string, unknown>, identity: Identity, json: Json) {
  const chatId = String(p.chatId ?? "").trim().toLowerCase();
  if (!UUID.test(chatId)) return json({ error: "Which chat?" }, 400);
  const clientId = optional(p.clientId);
  if (clientId !== null && !CLIENT_ID.test(clientId)) return json({ error: "That isn't a builder id." }, 400);

  let q = sb.from("support_conversations").select(CONV_COLS).eq("id", chatId);
  if (clientId) q = q.eq("client_id", clientId);
  const c = await q.maybeSingle();
  if (c.error && missing(c.error)) return json(NOT_APPLIED, 409);
  if (c.error) throw c.error;
  if (!c.data) return json({ error: "That chat isn't here. Chats are deleted after 180 days without a message.", code: "chat_not_found" }, 404);
  const conv = c.data;

  // Who opened which chat, and whose it is. admin-catalog's own audit row names only the posted
  // clientId, which a link to a chat does not carry; this one reads the builder from the chat.
  try {
    await sb.from("admin_audit").insert({
      action: "support_chat_read", target_client_id: String(conv.client_id),
      actor_email: identity.email ?? null, actor_user_id: identity.userId ?? null, note: `chat=${chatId}`,
    });
  } catch { /* best-effort, like every admin_audit write in admin-catalog */ }

  const [m, names, people, tickets] = await Promise.all([
    sb.from("support_messages").select(MSG_COLS).eq("conversation_id", chatId).eq("client_id", String(conv.client_id))
      .order("created_at", { ascending: true }).limit(CHAT_MESSAGES_MAX + 1),
    namesOf(sb),
    peopleOf(sb, conv.user_id ? [String(conv.user_id)] : []),
    ticketsOf(sb, conv.submission_id ? [String(conv.submission_id)] : []),
  ]);
  if (m.error) throw m.error;
  // deno-lint-ignore no-explicit-any
  const msgs = (m.data ?? []) as any[];
  return json({
    ok: true,
    chat: chatView(conv, names, people, tickets),
    messages: msgs.slice(0, CHAT_MESSAGES_MAX).map((x) => ({
      id: String(x.id), role: x.role === "assistant" ? "assistant" : "user", body: String(x.body ?? ""),
      tools: Array.isArray(x.tools) ? x.tools.map(String) : [], costMicros: Number(x.cost_micros) || 0,
      model: x.model ?? null, createdAt: x.created_at,
    })),
    truncated: msgs.length > CHAT_MESSAGES_MAX,
  });
}

export async function handleSupportChatsAction(
  sb: Db, action: string, p: Record<string, unknown>, identity: Identity, json: Json,
  deps: ChatDeps = { env: (n) => Deno.env.get(n), now: () => new Date() },
): Promise<Response> {
  if (identity.via !== "operator") {
    return json({ error: "Support chats open only in the portal's Admin console, signed in as an operator.", code: "operator_only" }, 403);
  }
  if (action === "support_chats_list") return await listChats(sb, p, json, deps);
  if (action === "support_chat_get") return await getChat(sb, p, identity, json);
  return json({ error: `Unknown action: ${action}` }, 400);
}
