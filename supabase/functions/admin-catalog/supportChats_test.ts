// Admin → Support chats (supportChats.ts): who may read, what the list and one chat return, paging,
// filters, this month's totals against support-agent's own ceiling, what a failed read leaves out,
// and the audit row naming who opened which chat.
//
// Run: deno test --allow-env --allow-read --node-modules-dir=none admin-catalog/   (from supabase/functions)
// Self-contained (no jsr:/npm: imports), like support-agent/agent_test.ts.
//
// The fake database answers only with the columns these tables have live (read 2026-10-30, plus
// migration 348's seven) and
// refuses any other with 42703, the way PostgREST does: a fake that accepts any column passes a
// select that fails in production. It also returns at most MAX_ROWS (1000) rows per read whatever
// limit() or range() asks, like this project's db-max-rows: the first version of this module read
// "limit(10000)" and "limit(1001)" and passed against a fake without that cap (review, 10-30).
//
// Every value here is an obviously fake fixture: this repo is public.

import {
  CHAT_MESSAGES_MAX, CHATS_PAGE, type ChatDeps, DEFAULT_MONTHLY_CAP_USD, handleSupportChatsAction, MAX_ROWS, monthlyCapMicros,
  monthStartUtc, PREVIEW_CHARS, previewOf,
} from "./supportChats.ts";
import { DEFAULT_MONTHLY_CAP_USD as AGENT_DEFAULT_CAP, monthlyCapMicros as agentMonthlyCapMicros } from "../support-agent/agent.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  actual:   ${a}\n  expected: ${e}`);
}

const COLUMNS: Record<string, string[]> = {
  support_conversations: ["id", "client_id", "user_id", "status", "submission_id", "model", "message_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros", "created_at", "updated_at", "last_message_at", "up_count", "down_count", "gap_count"],
  support_messages: ["id", "conversation_id", "client_id", "user_id", "role", "body", "tools", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micros", "stop_reason", "model", "created_at", "rating", "rating_note", "rated_at", "gap"],
  client_configs: ["client_id", "updated_at", "company_name", "tagline", "logo_url", "header_bg", "accent_color", "contact_fields", "default_sizes", "options", "styles_per_row", "brand_colors"],
  feedback_submissions: ["id", "client_id", "submitted_by", "submitter_name", "submitter_email", "kind", "title", "detail", "severity", "attachment_path", "status", "monday_item_id", "monday_board_id", "monday_error", "created_at", "status_changed_at", "updated_at", "source_app", "source_ref", "support_conversation_id"],
  admin_audit: ["id", "created_at", "action", "target_client_id", "row_count", "note", "actor_email", "actor_user_id"],
};

type Row = Record<string, unknown>;
interface World {
  rows: Record<string, Row[]>;
  /** Tables that answer every read with this error code. */
  fail?: Record<string, string>;
  /** Tables that do not exist (42P01). */
  absent?: string[];
  /** One select that fails: "table:columns as written" → error code. */
  failSelect?: Record<string, string>;
  users?: Record<string, { email: string; user_metadata?: Record<string, unknown> } | "error">;
  monthCostMicros?: number | "error";
  inserted: Row[];
  reads: string[];
}

const cmp = (a: unknown, b: unknown) => {
  const da = typeof a === "string" ? Date.parse(a) : NaN, db = typeof b === "string" ? Date.parse(b) : NaN;
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private lim = Infinity;
  private offset = 0;
  private cols: string[] = [];
  private head = false;
  private single = false;
  private err: { code: string; message: string } | null = null;
  constructor(private w: World, private table: string) {
    if ((w.absent ?? []).includes(table) || !COLUMNS[table]) this.err = { code: "42P01", message: `relation "public.${table}" does not exist` };
    else if (w.fail?.[table]) this.err = { code: w.fail[table], message: `read of ${table} failed` };
  }
  private col(c: string) {
    if (!this.err && !COLUMNS[this.table].includes(c)) this.err = { code: "42703", message: `column ${this.table}.${c} does not exist` };
  }
  select(cols: string, opts?: { count?: string; head?: boolean }) {
    this.cols = cols.split(",").map((s) => s.trim());
    for (const c of this.cols) this.col(c);
    const injected = this.w.failSelect?.[`${this.table}:${cols}`];
    if (injected && !this.err) this.err = { code: injected, message: `select ${cols} on ${this.table} failed` };
    if (opts?.head) this.head = true;
    return this;
  }
  eq(c: string, v: unknown) { this.col(c); this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.col(c); this.filters.push((r) => vs.includes(r[c])); return this; }
  lt(c: string, v: unknown) { this.col(c); this.filters.push((r) => cmp(r[c], v) < 0); return this; }
  gte(c: string, v: unknown) { this.col(c); this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
  gt(c: string, v: number) { this.col(c); this.filters.push((r) => Number(r[c] ?? 0) > v); return this; }
  not(c: string, op: string, v: unknown) {
    this.col(c);
    if (op !== "is" || v !== null) throw new Error("fake: only not(col, 'is', null)");
    this.filters.push((r) => r[c] != null);
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.col(c); this.orders.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.offset = from; this.lim = to - from + 1; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(row: Row) {
    for (const c of Object.keys(row)) this.col(c);
    if (!this.err) this.w.inserted.push({ table: this.table, ...row });
    return Promise.resolve({ data: null, error: this.err });
  }
  then<T>(res: (v: { data: unknown; error: unknown; count: number | null }) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
  private run() {
    this.w.reads.push(this.table);
    if (this.err) return { data: null, error: this.err, count: null };
    let rows = (this.w.rows[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    rows = [...rows].sort((a, b) => {
      for (const [c, asc] of this.orders) { const d = cmp(a[c], b[c]); if (d) return asc ? d : -d; }
      return 0;
    });
    const count = rows.length;
    const out = rows.slice(this.offset, this.offset + Math.min(this.lim, MAX_ROWS)).map((r) => Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null])));
    if (this.head) return { data: null, error: null, count };
    if (this.single) {
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" }, count: null };
      return { data: out[0] ?? null, error: null, count: null };
    }
    return { data: out, error: null, count };
  }
}

function fakeDb(w: World) {
  return {
    from: (t: string) => new Query(w, t),
    rpc: (name: string, args: Row) => {
      w.reads.push(`rpc:${name}`);
      if (name !== "support_usage") return Promise.resolve({ data: null, error: { code: "42883", message: "no such function" } });
      if (typeof args.p_client_id !== "string" || typeof args.p_user_id !== "string") throw new Error("fake: support_usage takes (text, uuid)");
      if (w.monthCostMicros === "error") return Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
      return Promise.resolve({ data: { month_cost_micros: w.monthCostMicros ?? 0, tenant_24h: 0, user_10m: 0 }, error: null });
    },
    auth: {
      admin: {
        getUserById: (id: string) => {
          const u = w.users?.[id];
          if (u === "error") return Promise.resolve({ data: { user: null }, error: { message: "User not found" } });
          return Promise.resolve(u ? { data: { user: { id, ...u } }, error: null } : { data: { user: null }, error: { message: "User not found" } });
        },
      },
    },
  };
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const OP = { via: "operator", userId: "00000000-0000-4000-8000-0000000000a1", email: "operator@example.test" };
const NOW = new Date("2026-10-30T12:00:00.000Z");
const deps = (env: Record<string, string> = {}): ChatDeps => ({ env: (n) => env[n], now: () => NOW });

const U1 = "00000000-0000-4000-8000-0000000000b1";
const U2 = "00000000-0000-4000-8000-0000000000b2";
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, 0) + minutes * 60_000).toISOString();

function conv(n: number, o: Row = {}): Row {
  return {
    id: cid(n), client_id: "demo-builder", user_id: U1, status: "open", submission_id: null, model: "claude-sonnet-5-5",
    message_count: 2, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 1500,
    created_at: at(n), updated_at: at(n), last_message_at: at(n), up_count: 0, down_count: 0, gap_count: 0, ...o,
  };
}
let mid = 0;
function msg(conversation: number, role: "user" | "assistant", body: string, minutes: number, o: Row = {}): Row {
  mid += 1;
  return {
    id: `10000000-0000-4000-8000-${String(mid).padStart(12, "0")}`, conversation_id: cid(conversation), client_id: "demo-builder",
    user_id: U1, role, body, tools: [], input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    cost_micros: role === "assistant" ? 700 : 0, stop_reason: role === "assistant" ? "end_turn" : null, model: role === "assistant" ? "claude-sonnet-5-5" : null,
    created_at: at(minutes), ...o,
  };
}

function world(o: Partial<World> = {}): World {
  return {
    rows: {
      support_conversations: [],
      support_messages: [],
      client_configs: [{ client_id: "demo-builder", company_name: "Demo Sheds" }, { client_id: "other-builder", company_name: "Acme Barns" }],
      feedback_submissions: [],
      admin_audit: [],
    },
    users: { [U1]: { email: "owner@demo.test", user_metadata: { full_name: "Pat Example" } }, [U2]: { email: "staff@acme.test" } },
    inserted: [], reads: [],
    ...o,
  };
}

async function call(w: World, action: string, p: Row = {}, identity: Row = OP, d: ChatDeps = deps()) {
  const r = await handleSupportChatsAction(fakeDb(w), action, p, identity as typeof OP, json, d);
  return { status: r.status, body: await r.json() };
}

// ── Who may read ─────────────────────────────────────────────────────────────────────────────────

Deno.test("the break-glass password path is refused before any table is read", async () => {
  const w = world();
  for (const action of ["support_chats_list", "support_chat_get"]) {
    const r = await call(w, action, { chatId: cid(1) }, { via: "password" });
    assertEquals(r.status, 403, action);
    assertEquals(r.body.code, "operator_only", action);
  }
  assertEquals(w.reads, [], "nothing read");
  assertEquals(w.inserted, [], "nothing written");
});

Deno.test("an action this module does not know is refused", async () => {
  const r = await call(world(), "support_chat_delete", {});
  assertEquals(r.status, 400);
});

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("the list: newest first, with builder, person, ticket and the first question", async () => {
  const w = world();
  w.rows.support_conversations = [
    conv(1),
    conv(2, { client_id: "other-builder", user_id: U2, status: "handed_off", submission_id: "20000000-0000-4000-8000-000000000001", message_count: 6, cost_micros: 9000 }),
    conv(3, { last_message_at: at(-30) }),
  ];
  w.rows.feedback_submissions = [{ id: "20000000-0000-4000-8000-000000000001", client_id: "other-builder", kind: "ticket", title: "Prices look wrong", status: "submitted", created_at: at(5), support_conversation_id: cid(2) }];
  w.rows.support_messages = [
    msg(1, "assistant", "An answer that came first should never be the question", 0),
    msg(1, "user", "  How do I   add\na door?  ", 1),
    msg(1, "user", "A later question", 2),
    msg(2, "user", "x".repeat(PREVIEW_CHARS + 50), 2),
  ];
  const r = await call(w, "support_chats_list");
  assertEquals(r.status, 200);
  assertEquals(r.body.installed, true);
  assertEquals(r.body.chats.map((c: Row) => c.id), [cid(2), cid(1), cid(3)], "ordered by last message, newest first");
  const [two, one, three] = r.body.chats;
  assertEquals(one.companyName, "Demo Sheds");
  assertEquals(one.person, { name: "Pat Example", email: "owner@demo.test" });
  assertEquals(one.firstQuestion, "How do I add a door?", "earliest USER message, whitespace folded");
  assertEquals(one.ticket, null);
  assertEquals(two.person, { name: null, email: "staff@acme.test" }, "no name in the metadata: email only");
  assertEquals(two.ticket, { id: "20000000-0000-4000-8000-000000000001", title: "Prices look wrong", status: "submitted" });
  assertEquals(two.status, "handed_off");
  assertEquals(two.messageCount, 6);
  assertEquals(two.costMicros, 9000);
  assertEquals(two.firstQuestion.length, PREVIEW_CHARS, "cut to the preview length");
  assert(two.firstQuestion.endsWith("…"), "a cut preview ends with an ellipsis");
  assertEquals(three.firstQuestion, null, "a chat with no question yet");
  assertEquals(r.body.more, false);
  assertEquals(r.body.next, null);
});

Deno.test("paging: 50 a page, `next` is the last chat's time, and the next page carries no totals", async () => {
  const w = world();
  w.rows.support_conversations = Array.from({ length: CHATS_PAGE + 7 }, (_, i) => conv(i + 1));
  const first = await call(w, "support_chats_list");
  assertEquals(first.body.chats.length, CHATS_PAGE);
  assertEquals(first.body.more, true);
  assertEquals(first.body.next, first.body.chats[CHATS_PAGE - 1].lastMessageAt);
  assert(first.body.month && Array.isArray(first.body.builders), "the first page has the month and the builders");
  const second = await call(w, "support_chats_list", { before: first.body.next });
  assertEquals(second.body.chats.length, 7);
  assertEquals(second.body.more, false);
  const seen = new Set([...first.body.chats, ...second.body.chats].map((c: Row) => c.id));
  assertEquals(seen.size, CHATS_PAGE + 7, "every chat exactly once across the two pages");
  assert(!("month" in second.body) && !("builders" in second.body), "a later page skips the totals");
});

Deno.test("filters: one builder, or one status; bad values are refused", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1), conv(2, { client_id: "other-builder", status: "handed_off" }), conv(3, { status: "closed" })];
  const mine = await call(w, "support_chats_list", { clientId: "other-builder" });
  assertEquals(mine.body.chats.map((c: Row) => c.id), [cid(2)]);
  const handed = await call(w, "support_chats_list", { status: "handed_off" });
  assertEquals(handed.body.chats.map((c: Row) => c.id), [cid(2)]);
  for (const bad of [{ clientId: "Not An Id" }, { clientId: "a".repeat(80) }, { status: "deleted" }, { before: "yesterday-ish" }, { before: "x".repeat(50) }]) {
    const r = await call(w, "support_chats_list", bad);
    assertEquals(r.status, 400, JSON.stringify(bad));
  }
});

Deno.test("the builders filter lists every builder with chats, by name, with a count", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1), conv(2), conv(3, { client_id: "other-builder" }), conv(4, { client_id: "gone-builder" })];
  const r = await call(w, "support_chats_list");
  assertEquals(r.body.builders, [
    { clientId: "other-builder", companyName: "Acme Barns", chats: 1 },
    { clientId: "demo-builder", companyName: "Demo Sheds", chats: 2 },
    { clientId: "gone-builder", companyName: null, chats: 1 },
  ]);
});

Deno.test("first question: a page whose message read came back full still finds every chat's first question", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1), conv(2)];
  // 1,000 of chat 1's questions come before chat 2's only one, so the page's single read is full of chat 1.
  w.rows.support_messages = [
    ...Array.from({ length: 1000 }, (_, i) => msg(1, "user", `q${i}`, -2000 + i)),
    msg(2, "user", "The only question in chat two", 10),
  ];
  const r = await call(w, "support_chats_list");
  const byId = Object.fromEntries(r.body.chats.map((c: Row) => [c.id, c.firstQuestion]));
  assertEquals(byId[cid(1)], "q0");
  assertEquals(byId[cid(2)], "The only question in chat two");
});

// ── This month ───────────────────────────────────────────────────────────────────────────────────

Deno.test("this month: spend from support_usage, counts since midnight UTC on the 1st, the ceiling support-agent uses", async () => {
  const w = world({ monthCostMicros: 480_000 });
  w.rows.support_conversations = [conv(1), conv(2, { created_at: "2026-09-30T23:59:59.000Z" })];
  w.rows.support_messages = [
    msg(1, "user", "this month", 1), msg(1, "assistant", "answer", 2), msg(1, "user", "this month too", 3),
    msg(2, "user", "last month", 0, { created_at: "2026-09-30T22:00:00.000Z" }),
  ];
  w.rows.feedback_submissions = [
    { id: "20000000-0000-4000-8000-000000000001", kind: "ticket", support_conversation_id: cid(1), title: "a", status: "submitted", created_at: at(4) },
    { id: "20000000-0000-4000-8000-000000000002", kind: "ticket", support_conversation_id: null, title: "b", status: "submitted", created_at: at(4) },
    { id: "20000000-0000-4000-8000-000000000003", kind: "bug", support_conversation_id: null, title: "c", status: "submitted", created_at: at(4) },
    { id: "20000000-0000-4000-8000-000000000004", kind: "ticket", support_conversation_id: cid(2), title: "d", status: "submitted", created_at: "2026-09-29T00:00:00.000Z" },
  ];
  const r = await call(w, "support_chats_list");
  assertEquals(r.body.month, {
    since: "2026-10-01T00:00:00.000Z", chats: 1, questions: 2, tickets: 1, up: 0, down: 0, gaps: 0, costMicros: 480_000, capMicros: 200_000_000,
  });
  const raised = await call(w, "support_chats_list", {}, OP, deps({ SUPPORT_AI_MONTHLY_CAP_USD: "500" }));
  assertEquals(raised.body.month.capMicros, 500_000_000);
});

Deno.test("this month: a failed count reads null, never 0", async () => {
  const w = world({ monthCostMicros: "error" });
  w.rows.support_conversations = [conv(1)];
  w.fail = { feedback_submissions: "XX000" };
  const r = await call(w, "support_chats_list");
  assertEquals(r.body.month.costMicros, null);
  assertEquals(r.body.month.tickets, null);
  assertEquals(r.body.month.chats, 1, "the others still count");
});

Deno.test("the ceiling and the month are support-agent's own rules", () => {
  assertEquals(DEFAULT_MONTHLY_CAP_USD, AGENT_DEFAULT_CAP, "defaults agree");
  for (const v of [undefined, "", "0", "-5", "abc", "150", "500", "12.5"]) {
    const env = (n: string) => (n === "SUPPORT_AI_MONTHLY_CAP_USD" ? v : undefined);
    assertEquals(monthlyCapMicros(env), agentMonthlyCapMicros(env), `cap for ${JSON.stringify(v)}`);
  }
  assertEquals(monthStartUtc(new Date("2026-11-01T00:30:00.000+05:00")), "2026-10-01T00:00:00.000Z", "UTC, not local time");
  assertEquals(monthStartUtc(new Date("2026-12-31T23:59:59.000Z")), "2026-12-01T00:00:00.000Z");
  assertEquals(previewOf(null), "");
});

// ── What a failed or missing read leaves ─────────────────────────────────────────────────────────

Deno.test("names, people, tickets and first questions are best-effort: the chats still list", async () => {
  const w = world({ users: { [U1]: "error" } });
  w.rows.support_conversations = [conv(1, { status: "handed_off", submission_id: "20000000-0000-4000-8000-000000000009" })];
  w.fail = { client_configs: "XX000", feedback_submissions: "XX000", support_messages: "XX000" };
  const r = await call(w, "support_chats_list");
  assertEquals(r.status, 200);
  const [c] = r.body.chats;
  assertEquals(c.id, cid(1));
  assertEquals(c.companyName, null);
  assertEquals(c.person, null);
  assertEquals(c.ticket, { id: "20000000-0000-4000-8000-000000000009", title: null, status: null });
  assertEquals(c.firstQuestion, null);
});

Deno.test("a database without migration 340: the list says so, one chat says so", async () => {
  const w = world({ absent: ["support_conversations", "support_messages"] });
  const r = await call(w, "support_chats_list");
  assertEquals(r.body, { ok: true, installed: false, chats: [], more: false, next: null });
  const g = await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(g.status, 409);
  assertEquals(g.body.code, "support_chats_unavailable");
});

Deno.test("a real database error on the chats themselves is not hidden", async () => {
  const w = world({ fail: { support_conversations: "57014" } });
  let threw = false;
  try { await call(w, "support_chats_list"); } catch { threw = true; }
  assert(threw, "admin-catalog's catch turns it into an error the page shows");
});

// ── One chat ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("one chat: every message oldest first, with the tools each answer used, and nothing from another chat", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1, { status: "handed_off", submission_id: "20000000-0000-4000-8000-000000000001", message_count: 3 }), conv(2)];
  w.rows.feedback_submissions = [{ id: "20000000-0000-4000-8000-000000000001", kind: "ticket", title: "Help with prices", status: "submitted", created_at: at(9), support_conversation_id: cid(1) }];
  w.rows.support_messages = [
    msg(1, "assistant", "Here is what I found.", 3, { tools: ["get_account_overview", "get_catalog_summary"] }),
    msg(1, "user", "Which styles have no prices?", 2),
    msg(2, "user", "Another builder's question", 2),
    msg(1, "user", "Thanks", 4),
  ];
  const r = await call(w, "support_chat_get", { chatId: cid(1).toUpperCase() });
  assertEquals(r.status, 200);
  assertEquals(r.body.chat.id, cid(1));
  assertEquals(r.body.chat.companyName, "Demo Sheds");
  assertEquals(r.body.chat.person, { name: "Pat Example", email: "owner@demo.test" });
  assertEquals(r.body.chat.ticket, { id: "20000000-0000-4000-8000-000000000001", title: "Help with prices", status: "submitted" });
  assertEquals(r.body.messages.map((m: Row) => [m.role, m.body]), [
    ["user", "Which styles have no prices?"], ["assistant", "Here is what I found."], ["user", "Thanks"],
  ]);
  assertEquals(r.body.messages[1].tools, ["get_account_overview", "get_catalog_summary"]);
  assertEquals(r.body.messages[1].costMicros, 700);
  assertEquals(r.body.truncated, false);
  assert(!("firstQuestion" in r.body.chat), "one chat carries its messages, not a preview");
});

Deno.test("one chat: opening it is audited with who, which chat and whose", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1, { client_id: "other-builder" })];
  await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(w.inserted, [{
    table: "admin_audit", action: "support_chat_read", target_client_id: "other-builder",
    actor_email: "operator@example.test", actor_user_id: OP.userId, note: `chat=${cid(1)}`,
  }]);
});

Deno.test("one chat: a bad id, a chat that is gone, and a builder that doesn't match are refused", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1)];
  assertEquals((await call(w, "support_chat_get", { chatId: "not-a-uuid" })).status, 400);
  assertEquals((await call(w, "support_chat_get", {})).status, 400);
  assertEquals((await call(w, "support_chat_get", { chatId: cid(1), clientId: "Bad Id" })).status, 400);
  const gone = await call(w, "support_chat_get", { chatId: cid(99) });
  assertEquals(gone.status, 404);
  assertEquals(gone.body.code, "chat_not_found");
  const other = await call(w, "support_chat_get", { chatId: cid(1), clientId: "other-builder" });
  assertEquals(other.status, 404, "a clientId that isn't the chat's finds nothing");
  assertEquals(w.inserted, [], "nothing audited for a chat nobody opened");
  const ok = await call(w, "support_chat_get", { chatId: cid(1), clientId: "demo-builder" });
  assertEquals(ok.status, 200);
});

Deno.test("the fake holds the row cap: one read returns at most MAX_ROWS whatever it asks", async () => {
  const w = world();
  w.rows.support_conversations = Array.from({ length: MAX_ROWS + 5 }, (_, i) => conv(i + 1));
  const r = await fakeDb(w).from("support_conversations").select("id").limit(MAX_ROWS * 10);
  assertEquals((r.data as unknown[]).length, MAX_ROWS);
});

Deno.test("one chat longer than one read: every message, across pages, oldest first", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1)];
  const n = MAX_ROWS + 500;
  w.rows.support_messages = Array.from({ length: n }, (_, i) => msg(1, i % 2 ? "assistant" : "user", `m${i}`, i));
  const r = await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(r.body.messages.length, n);
  assertEquals(r.body.truncated, false);
  assertEquals(r.body.messages[0].body, "m0", "oldest first");
  assertEquals(r.body.messages[n - 1].body, `m${n - 1}`, "the newest is last");
  assertEquals(new Set(r.body.messages.map((m: Row) => m.id)).size, n, "no message twice");
});

Deno.test("one chat longer than the most shown: its NEWEST messages, oldest first, and it says so", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1)];
  const n = CHAT_MESSAGES_MAX + 300;
  w.rows.support_messages = Array.from({ length: n }, (_, i) => msg(1, i % 2 ? "assistant" : "user", `m${i}`, i));
  const r = await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(r.body.messages.length, CHAT_MESSAGES_MAX);
  assertEquals(r.body.truncated, true, "live, a read capped at MAX_ROWS could never have said this");
  assertEquals(r.body.messages[0].body, "m300", "the oldest 300 are the ones left out");
  assertEquals(r.body.messages[CHAT_MESSAGES_MAX - 1].body, `m${n - 1}`, "the newest is kept");
});

Deno.test("one chat of exactly the most shown is not called cut", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1)];
  w.rows.support_messages = Array.from({ length: CHAT_MESSAGES_MAX }, (_, i) => msg(1, "user", `m${i}`, i));
  const r = await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(r.body.messages.length, CHAT_MESSAGES_MAX);
  assertEquals(r.body.truncated, false);
});

Deno.test("the builders filter counts every chat, past one read's cap", async () => {
  const w = world();
  // 2,400 chats: the last builder's 150 sit at the END of id order, beyond any single read.
  w.rows.support_conversations = [
    ...Array.from({ length: 1500 }, (_, i) => conv(i + 1)),
    ...Array.from({ length: 750 }, (_, i) => conv(1501 + i, { client_id: "other-builder" })),
    ...Array.from({ length: 150 }, (_, i) => conv(2251 + i, { client_id: "late-builder" })),
  ];
  w.rows.client_configs.push({ client_id: "late-builder", company_name: "Zed Lofts" });
  const r = await call(w, "support_chats_list");
  assertEquals(r.body.builders, [
    { clientId: "other-builder", companyName: "Acme Barns", chats: 750 },
    { clientId: "demo-builder", companyName: "Demo Sheds", chats: 1500 },
    { clientId: "late-builder", companyName: "Zed Lofts", chats: 150 },
  ]);
  assert(!("buildersCapped" in r.body), "not capped");
});

Deno.test("a failed builders read gives no filter list, never a short one", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1)];
  // The list read succeeds; only the builders scan (its select is "id, client_id") fails.
  w.failSelect = { "support_conversations:id, client_id": "57014" };
  const r = await call(w, "support_chats_list");
  assertEquals(r.body.chats.length, 1);
  assertEquals(r.body.builders, null);
  assertEquals(r.body.month.chats, 1, "the month still counts");
});

// ── Tracking: thumbs and "didn't know" (migration 348) ─────────────────────────────────────────

Deno.test("tracking: each chat carries its thumbs and gap counts, and a gap chat its newest note", async () => {
  const w = world();
  w.rows.support_conversations = [
    conv(1, { up_count: 2, down_count: 1 }),
    conv(2, { gap_count: 2 }),
    conv(3),
  ];
  w.rows.support_messages = [
    msg(2, "user", "Can I export prices?", 2),
    msg(2, "assistant", "Not sure.", 3, { gap: "Exporting prices" }),
    msg(2, "assistant", "Not sure either.", 4, { gap: "  Bulk   discounts " }),
  ];
  const r = await call(w, "support_chats_list");
  const byId = Object.fromEntries(r.body.chats.map((c: Row) => [c.id, c]));
  assertEquals([byId[cid(1)].up, byId[cid(1)].down, byId[cid(1)].gaps], [2, 1, 0]);
  assertEquals([byId[cid(2)].up, byId[cid(2)].down, byId[cid(2)].gaps], [0, 0, 2]);
  assertEquals(byId[cid(2)].gapNote, "Bulk discounts", "the newest note, folded");
  assertEquals(byId[cid(1)].gapNote, null, "no note on a chat without gaps");
  const gapReads = w.reads.filter((t) => t === "support_messages").length;
  const w2 = world();
  w2.rows.support_conversations = [conv(1), conv(3)];
  await call(w2, "support_chats_list");
  assert(w2.reads.filter((t) => t === "support_messages").length < gapReads, "no gap read when no chat on the page has one");
});

Deno.test("tracking: show down and show gap filter on the chat; anything else is refused", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1, { down_count: 1 }), conv(2, { gap_count: 1 }), conv(3, { up_count: 3 }), conv(4, { down_count: 2, gap_count: 1 })];
  const down = await call(w, "support_chats_list", { show: "down" });
  assertEquals(down.body.chats.map((c: Row) => c.id), [cid(4), cid(1)]);
  const gap = await call(w, "support_chats_list", { show: "gap" });
  assertEquals(gap.body.chats.map((c: Row) => c.id), [cid(4), cid(2)]);
  const both = await call(w, "support_chats_list", { show: "down", clientId: "other-builder" });
  assertEquals(both.body.chats, [], "show and builder combine");
  for (const show of ["up", "DOWN", "down;", 1]) {
    assertEquals((await call(w, "support_chats_list", { show })).status, 400, `show ${String(show)}`);
  }
  assertEquals((await call(w, "support_chats_list", { show: "" })).body.chats.length, 4, "empty is every chat");
});

Deno.test("tracking: this month's thumbs and gap counts, on this month's answers only", async () => {
  const w = world();
  const may = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
  w.rows.support_messages = [
    msg(1, "assistant", "a", 0, { rating: 1, created_at: may(5) }),
    msg(1, "assistant", "b", 0, { rating: 1, created_at: may(6) }),
    msg(1, "assistant", "c", 0, { rating: -1, rating_note: "wrong", created_at: may(7) }),
    msg(1, "assistant", "d", 0, { gap: "x", created_at: may(8) }),
    msg(1, "assistant", "last month", 0, { rating: -1, gap: "y", created_at: "2026-09-30T23:59:00.000Z" }),
  ];
  const r = await call(w, "support_chats_list");
  assertEquals([r.body.month.up, r.body.month.down, r.body.month.gaps], [2, 1, 1]);
  w.fail = { support_messages: "XX000" };
  const failed = await call(w, "support_chats_list");
  assertEquals([failed.body.month.up, failed.body.month.down, failed.body.month.gaps], [null, null, null], "a failed count is a dash, never 0");
});

Deno.test("tracking: one chat's answers carry their rating, the line under a thumbs down, and the gap note", async () => {
  const w = world();
  w.rows.support_conversations = [conv(1, { up_count: 1, down_count: 1, gap_count: 1 })];
  w.rows.support_messages = [
    msg(1, "user", "q", 0),
    msg(1, "assistant", "good", 1, { rating: 1, rated_at: at(2) }),
    msg(1, "assistant", "bad", 3, { rating: -1, rating_note: "Wrong page", rated_at: at(4) }),
    msg(1, "assistant", "unsure", 5, { gap: "Exporting prices" }),
  ];
  const r = await call(w, "support_chat_get", { chatId: cid(1) });
  assertEquals(r.status, 200);
  assertEquals(r.body.messages.map((m: Row) => [m.rating, m.ratingNote, m.gap]), [
    [null, null, null], [1, null, null], [-1, "Wrong page", null], [null, null, "Exporting prices"],
  ]);
  assertEquals([r.body.chat.up, r.body.chat.down, r.body.chat.gaps], [1, 1, 1]);
});
