// The Conversations page's server action (portal-settings `crm_inbox`), driven through the SHIPPED
// handler: resolveTenant, the GATES table, the CRM subscription check, and the branch's own reads.
// crmInbox.test.ts proves the paging rules against arrays; this proves the branch asks the real
// tables the right questions and narrows the answer the way the record page does:
//
//   1. an owner gets one row per customer from all four tables, newest first; a customer merged
//      into another record is left out, quote/invoice emails do not count, another builder's rows
//      never appear, and no voicemail words reach the page; the first page says which filters to
//      offer
//   2. a filter reads only its own tables (the offer probes aside)
//   3. contacts:'own' sees only their customers, through crm_visible_contact_ids; if that check
//      fails the page is REFUSED (a dbFail with its ref), never everyone
//   4. no phone access: phone_calls is never read, not even for the offer probe, and Calls is empty
//   5. phone:'own': someone else's missed call is not shown, and does not hide the customer
//   6. page 2 leaves out whoever has anything at or above the cursor
//   7. Mine keeps someone else's customer I once texted, with a sent_by read scoped to me
//   8. refusals: no CRM (403), no contacts access (403), a filter or a cursor it doesn't know (400),
//      and a failed read (500 with the ref, logged to app_errors)
//
// HOW. qboRealmWiring_test's idiom: Deno.serve is stubbed while the handler is imported, the
// import map swaps supabase-js for supabase_stub.ts, and its stubDb/stubRpc hooks route every
// read into ONE in-memory database below. The fake applies the filters the code really put on each
// query, refuses a column the table does not have (PostgREST's 42703: the column lists are the
// live schema's, read 2026-10-05), and answers the two embeds the branch uses (a call's customer
// and its voicemail). No network permission.
//
// Tenants, people and messages are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

async function importHandler(fn: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: any) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    // Computed, so this file is not type-checked against the stub's partial client.
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler;
}
const SETTINGS = await importHandler("portal-settings");

// ─── Made-up identities ────────────────────────────────────────────────────────────────────────
const TENANT = "acme-sheds";
const BYSTANDER = "bystander-barns";
const ME = "00000000-0000-4000-8000-00000000a001";
const OTHER = "00000000-0000-4000-8000-00000000a002";
const c = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, 0) + minute * 60_000).toISOString().replace("Z", "+00:00");
const WORDS = "Hi it's Pat, please call me back about the gambrel";

// ─── One in-memory database ────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;

const COLUMNS: Record<string, string[]> = {
  sms_messages: ["id", "client_id", "contact_id", "short_code", "direction", "from_number", "to_number", "body", "status", "error_code",
    "provider", "provider_sid", "num_segments", "sent_by", "delivered_at", "created_at", "updated_at", "client_temp_id", "sent_via", "num_media"],
  email_inbound: ["id", "client_id", "contact_id", "short_code", "from_email", "from_name", "to_email", "subject", "body_text", "body_html",
    "message_id", "in_reply_to", "references_raw", "provider", "spam_verdict", "received_at", "created_at"],
  email_sends: ["id", "client_id", "short_code", "kind", "to_email", "intended_email", "from_email", "subject", "status", "error",
    "postmark_message_id", "delivered_at", "bounced_at", "bounce_reason", "created_at", "updated_at", "provider_message_id", "contact_id",
    "body_text", "sent_by", "client_temp_id"],
  phone_calls: ["id", "client_id", "number_id", "contact_id", "direction", "from_e164", "to_e164", "twilio_call_sid", "client_call_sid",
    "placed_by", "answered_by", "rang_user_ids", "transferred_from", "transfer_state", "status", "started_at", "answered_at", "ended_at",
    "duration_s", "cost_cents", "error_code", "is_emergency", "handoff_state", "handoff_to", "handoff_key", "handoff_at", "handoff_sid", "handoff_from_sid"],
  phone_voicemails: ["id", "call_id", "client_id", "recording_sid", "duration_s", "transcript", "listened_at", "listened_by", "deleted_at", "created_at"],
  crm_contacts: ["id", "client_id", "name", "phone", "phone_digits", "email", "email_lower", "street", "city", "state", "zip", "owner_user_id",
    "labels", "merged_into", "source", "first_seen_at", "created_at", "updated_at", "sms_opt_out_at", "billing_street", "billing_city",
    "billing_state", "billing_zip"],
};
// The embeds PostgREST would answer (both to-one: phone_calls.contact_id → crm_contacts.id, and
// phone_voicemails.call_id is unique).
const EMBEDS: Record<string, (db: FakeDb, r: Row) => Row | null> = {
  "phone_calls.crm_contacts": (db, r) => db.rows("crm_contacts").find((x) => x.id === r.contact_id) ?? null,
  "phone_calls.phone_voicemails": (db, r) => db.rows("phone_voicemails").find((x) => x.call_id === r.id) ?? null,
};

class FakeDb {
  tables: Record<string, Row[]>;
  log: { table: string; ops: any[][] }[] = [];
  fails: { table: string }[] = [];
  rpcFails = false;
  constructor(seed: Record<string, Row[]>) { this.tables = structuredClone(seed); }
  rows(t: string): Row[] { return (this.tables[t] ??= []); }
  from(table: string): any { return chain(this, table, []); }
  rpc(fn: string, args?: any): any { return chain(this, `rpc:${fn}`, [["args", args]]); }
  /** The reads made of `table` (selects only, not the inserts logging makes). */
  reads(table: string) { return this.log.filter((l) => l.table === table && l.ops.some((o) => o[0] === "select")); }
}

/** Top-level comma split, keeping `name(a, b)` embeds whole. */
function selectItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function matches(r: Row, ops: any[][]): boolean {
  for (const o of ops) {
    const [op, col, v, w] = o;
    if (op === "eq" && !(r[col] != null && r[col] === v)) return false;
    if (op === "is" && v === null && r[col] != null) return false;
    if (op === "not" && v === "is" && w === null && r[col] == null) return false;
    if (op === "in" && !(v as unknown[]).includes(r[col])) return false;
    if (op === "lt" && !(r[col] != null && Date.parse(r[col]) < Date.parse(v))) return false;
    if (op === "gte" && !(r[col] != null && Date.parse(r[col]) >= Date.parse(v))) return false;
    if (op === "or") {
      const any = String(col).split(",").some((part) => {
        const [k, verb, ...rest] = part.split(".");
        return verb === "eq" && String(r[k]) === rest.join(".");
      });
      if (!any) return false;
    }
  }
  return true;
}

function run(db: FakeDb, table: string, ops: any[][]): any {
  if (table.startsWith("rpc:")) {
    const fn = table.slice(4), args = ops[0][1];
    if (fn === "crm_visible_contact_ids") {
      if (db.rpcFails) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      // 193's predicate, cut down: the caller owns the customer.
      const mine = db.rows("crm_contacts").filter((x) => x.client_id === args.p_client_id && x.owner_user_id === args.p_user_id).map((x) => x.id);
      return { data: (args.p_ids as string[]).filter((id) => mine.includes(id)), error: null };
    }
    throw new Error(`the fake database has no rpc ${fn}`);
  }
  const verbOp = ops.find((o) => ["select", "insert"].includes(o[0])) ?? ["select", "*"];
  if (verbOp[0] === "insert") {
    for (const r of [verbOp[1]].flat()) db.rows(table).push({ ...r });
    return { data: null, error: null };
  }
  if (db.fails.some((f) => f.table === table)) return { data: null, error: { code: "08006", message: "connection lost" } };
  const filters = ops.filter((o) => o[0] !== "select");
  const items = verbOp[1] === "*" ? null : selectItems(String(verbOp[1]));
  const plain = (items ?? []).filter((i) => !i.includes("("));
  const embeds = (items ?? []).filter((i) => i.includes("(")).map((i) => ({ name: i.slice(0, i.indexOf("(")), cols: selectItems(i.slice(i.indexOf("(") + 1, -1)) }));
  const named = [...plain, ...filters.filter((o) => ["eq", "is", "not", "in", "lt", "gte", "order"].includes(o[0])).map((o) => o[1]),
    ...filters.filter((o) => o[0] === "or").flatMap((o) => String(o[1]).split(",").map((p) => p.split(".")[0]))];
  const cols = COLUMNS[table];
  const bad = cols ? named.filter((n) => !cols.includes(n)) : [];
  if (bad.length) return { data: null, error: { code: "42703", message: `column ${table}.${bad[0]} does not exist` } };
  for (const e of embeds) {
    if (!EMBEDS[`${table}.${e.name}`]) return { data: null, error: { code: "PGRST200", message: `no relationship ${table} → ${e.name}` } };
    const ecols = COLUMNS[e.name];
    const eb = ecols ? e.cols.filter((x) => !ecols.includes(x)) : [];
    if (eb.length) return { data: null, error: { code: "42703", message: `column ${e.name}.${eb[0]} does not exist` } };
  }
  let out = db.rows(table).filter((r) => matches(r, filters));
  for (const o of filters) {
    if (o[0] === "order") {
      const asc = !(o[2] && o[2].ascending === false);
      out = [...out].sort((a, b) => (Date.parse(a[o[1]]) - Date.parse(b[o[1]])) * (asc ? 1 : -1));
    }
  }
  const lim = filters.find((o) => o[0] === "limit");
  if (lim) out = out.slice(0, lim[1]);
  const projected = out.map((r) => {
    if (!items) return { ...r };
    const p: Row = Object.fromEntries(plain.map((k) => [k, r[k] ?? null]));
    for (const e of embeds) {
      const hit = EMBEDS[`${table}.${e.name}`](db, r);
      p[e.name] = hit ? Object.fromEntries(e.cols.map((k) => [k, hit[k] ?? null])) : null;
    }
    return p;
  });
  if (filters.some((o) => o[0] === "maybeSingle")) return { data: projected[0] ?? null, error: null };
  return { data: projected, error: null };
}

function chain(db: FakeDb, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(db, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "eq", "is", "not", "in", "lt", "gte", "or", "order", "limit", "maybeSingle", "single"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    db.log.push({ table, ops });
    return Promise.resolve().then(() => run(db, table, ops)).then(ok, bad);
  };
  return q;
}

// ─── The world one call runs in ────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

async function call(db: FakeDb, payload: Row, user = ME) {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: unknown) => Promise.reject(new Error(`TEST FAILURE: unexpected fetch ${String(u)}`))) as typeof fetch;
  stubAuth.user = { id: user, email: "person@example.test" };
  stubAuth.error = null;
  stubDb.from = (t: string) => db.from(t);
  stubRpc.rpc = (fn: string, args?: unknown) => db.rpc(fn, args);
  try {
    const res = await SETTINGS(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, text };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── Seeds ─────────────────────────────────────────────────────────────────────────────────────
function person(n: number, owner: string | null = null, extra: Row = {}): Row {
  return { id: c(n), client_id: TENANT, name: `Customer ${n}`, phone: `+1555555${String(n).padStart(4, "0")}`, email: `customer${n}@example.test`,
    owner_user_id: owner, merged_into: null, ...extra };
}
const text = (n: number, minute: number, extra: Row = {}): Row => ({
  id: `sm-${n}-${minute}`, client_id: TENANT, contact_id: c(n), direction: "in", body: `text at ${minute}`, num_media: 0, sent_by: null, created_at: at(minute), ...extra,
});
const mailIn = (n: number, minute: number, extra: Row = {}): Row => ({
  id: `in-${n}-${minute}`, client_id: TENANT, contact_id: c(n), subject: `subject at ${minute}`, received_at: at(minute), ...extra,
});
const mailOut = (n: number, minute: number, extra: Row = {}): Row => ({
  id: `es-${n}-${minute}`, client_id: TENANT, contact_id: c(n), kind: "conversation", subject: `sent at ${minute}`, sent_by: ME, created_at: at(minute), ...extra,
});
const callRow = (n: number, minute: number, extra: Row = {}): Row => ({
  id: `pc-${n}-${minute}`, client_id: TENANT, contact_id: c(n), direction: "in", status: "missed", started_at: at(minute), answered_at: null,
  duration_s: null, placed_by: null, answered_by: null, transferred_from: null, rang_user_ids: [ME], ...extra,
});

function world(opts: { title?: string | null; role?: string; access?: Row | null; billingExempt?: boolean; extra?: Record<string, Row[]> } = {}): FakeDb {
  return new FakeDb({
    client_users: [{ user_id: ME, client_id: TENANT, role: opts.role ?? "owner", title: opts.title ?? null, access: opts.access ?? null }],
    client_settings: [{ client_id: TENANT, internal_account: false, billing_exempt: opts.billingExempt ?? true, sms_status: "active", sms_number: "+15555550199" }],
    billing_plans: [],
    crm_contacts: [
      person(1, ME), person(2, OTHER), person(3, null), person(4, OTHER), person(5, null, { merged_into: c(3) }),
      { ...person(9), client_id: BYSTANDER, name: "Someone Else's Customer" },
    ],
    sms_messages: [
      text(1, 50, { body: "Is the 12x16 still available?" }),
      text(2, 10, { direction: "out", sent_by: ME, body: "On its way" }),
      text(5, 99, { body: "merged-away text" }),
      { ...text(9, 120), client_id: BYSTANDER, contact_id: c(9), body: "another builder's text" },
      { ...text(0, 130), contact_id: null, body: "from a number that is not a contact" },
    ],
    email_inbound: [mailIn(3, 40, { subject: "Paint colours" })],
    email_sends: [
      mailOut(3, 30, { subject: "Re: paint" }),
      mailOut(4, 80, { kind: "estimate", subject: "Your quote" }),
    ],
    phone_calls: [callRow(4, 60, { rang_user_ids: [OTHER] }), callRow(2, 70)],
    phone_voicemails: [{ id: "vm-1", call_id: "pc-2-70", client_id: TENANT, transcript: WORDS, duration_s: 9, deleted_at: null }],
    app_errors: [],
    admin_audit: [],
    ...(opts.extra ?? {}),
  });
}
const rowsOf = (body: any) => (body.threads ?? []).map((t: Row) => [t.name, t.channel, t.direction, t.preview, t.awaitingReply]);

// ─── 1, 2. The owner ───────────────────────────────────────────────────────────────────────────
Deno.test("an owner: one row per customer from all four tables, newest first, and nothing that isn't theirs", async () => {
  const db = world();
  const r = await call(db, { action: "crm_inbox" });
  assertEquals(r.status, 200, r.text);
  assertEquals(rowsOf(r.body), [
    ["Customer 2", "calls", "in", "Voicemail", true],                    // 70: the voicemail, newer than our text at 10
    ["Customer 4", "calls", "in", "Missed call", true],                  // 60: the quote email at 80 is not a conversation
    ["Customer 1", "sms", "in", "Is the 12x16 still available?", true],
    ["Customer 3", "email", "in", "Paint colours", true],
  ]);
  assert(!r.text.includes("merged-away") && !r.text.includes(c(5)), "a merged-away customer was listed");
  assert(!r.text.includes("another builder") && !r.text.includes(c(9)), "another builder's customer was listed");
  assert(!r.text.includes("not a contact"), "a text from a bare number was listed");
  assert(!r.text.includes("gambrel"), "a voicemail's words reached the page");
  assertEquals([r.body.cursor, r.body.smsReady, r.body.hasTexts, r.body.hasCalls, r.body.seesCalls], [null, true, true, true, true]);
  // Every read is this tenant's, and the email read asks only for conversations.
  for (const t of ["sms_messages", "email_inbound", "email_sends", "phone_calls", "crm_contacts"]) {
    for (const l of db.reads(t)) assert(l.ops.some((o) => o[0] === "eq" && o[1] === "client_id" && o[2] === TENANT), `${t} read without the tenant: ${JSON.stringify(l.ops)}`);
  }
  const sends = db.reads("email_sends").find((l) => l.ops.some((o) => o[0] === "order"))!;
  assertEquals(sends.ops.find((o) => o[0] === "in" && o[1] === "kind")?.[2], ["conversation", "test"]);
  const contacts = db.reads("crm_contacts")[0];
  assert(contacts.ops.some((o) => o[0] === "is" && o[1] === "merged_into" && o[2] === null), "the contacts read doesn't leave out merged records");
});

Deno.test("a filter reads only its own tables", async () => {
  const db = world();
  const r = await call(db, { action: "crm_inbox", channel: "email" });
  assertEquals(r.status, 200, r.text);
  assertEquals(rowsOf(r.body), [["Customer 3", "email", "in", "Paint colours", true]]);
  const scans = (t: string) => db.reads(t).filter((l) => l.ops.some((o) => o[0] === "order")).length;
  assertEquals([scans("sms_messages"), scans("phone_calls"), scans("email_inbound"), scans("email_sends")], [0, 0, 1, 1]);
  const calls = await call(world(), { action: "crm_inbox", channel: "calls" });
  assertEquals(rowsOf(calls.body).map((x: any[]) => x[0]), ["Customer 2", "Customer 4"]);
});

// ─── 3. contacts:'own' ─────────────────────────────────────────────────────────────────────────
Deno.test("contacts:'own' sees only their customers, and a failed check refuses the page", async () => {
  const rep = { role: "user", title: "sales_rep", access: { contacts: "own" } };
  const db = world(rep);
  const r = await call(db, { action: "crm_inbox" });
  assertEquals(r.status, 200, r.text);
  assertEquals(rowsOf(r.body).map((x: any[]) => x[0]), ["Customer 1"]);
  const rpc = db.log.find((l) => l.table === "rpc:crm_visible_contact_ids")!;
  assertEquals([rpc.ops[0][1].p_client_id, rpc.ops[0][1].p_user_id], [TENANT, ME]);

  const broken = world(rep);
  broken.rpcFails = true;
  const no = await call(broken, { action: "crm_inbox" });
  assertEquals(no.status, 500, no.text);
  assertEquals(no.body.ref, "check who these customers are assigned to");
  assert(!("threads" in no.body), "a failed visibility check still returned rows");
  assert(broken.rows("app_errors").length >= 1, "the failure was not logged");
});

// ─── 4, 5. The phone level ─────────────────────────────────────────────────────────────────────
Deno.test("no phone access: phone_calls is never read, and Calls is empty", async () => {
  const db = world({ role: "user", title: "office_staff", access: { phone: "none" } });
  const r = await call(db, { action: "crm_inbox" });
  assertEquals(r.status, 200, r.text);
  assertEquals(db.reads("phone_calls").length, 0, "phone_calls was read");
  assertEquals([r.body.seesCalls, r.body.hasCalls], [false, false]);
  // Customer 2 shows with what they CAN see: our text.
  assertEquals(rowsOf(r.body).find((x: any[]) => x[0] === "Customer 2"), ["Customer 2", "sms", "out", "On its way", false]);
  const calls = await call(world({ role: "user", title: "office_staff", access: { phone: "none" } }), { action: "crm_inbox", channel: "calls" });
  assertEquals(calls.body.threads, []);
});

Deno.test("phone:'own': someone else's missed call is hidden, and does not hide the customer", async () => {
  // Unanswered calls belong to the customer's owner, or with no owner to whoever was rung
  // (crmFeed callVisibleToOwn). Customer 4 and customer 2 are OTHER's, so neither call is mine,
  // even the one that rang me; customer 3 is nobody's and their call rang me.
  const db = world({ role: "user", title: "sales_rep", access: { contacts: "edit", phone: "own" }, extra: {
    email_inbound: [mailIn(3, 40, { subject: "Paint colours" }), mailIn(4, 20, { subject: "Door question" })],
    phone_calls: [callRow(4, 60, { rang_user_ids: [OTHER] }), callRow(2, 70), callRow(3, 90, { rang_user_ids: [ME] })],
  } });
  const r = await call(db, { action: "crm_inbox" });
  assertEquals(r.status, 200, r.text);
  const row = (n: number) => rowsOf(r.body).find((x: any[]) => x[0] === `Customer ${n}`);
  assertEquals(row(4), ["Customer 4", "email", "in", "Door question", true]);
  assertEquals(row(2), ["Customer 2", "sms", "out", "On its way", false]);
  assertEquals(row(3), ["Customer 3", "calls", "in", "Missed call", true]);
  const scan = db.reads("phone_calls").find((l) => l.ops.some((o) => o[0] === "order"))!;
  assert(String(scan.ops.find((o) => o[0] === "select")?.[1]).includes("crm_contacts(owner_user_id)"), "the call read doesn't carry its customer's owner");
});

// ─── 6. Page 2 ─────────────────────────────────────────────────────────────────────────────────
Deno.test("page 2 leaves out whoever has anything at or above the cursor", async () => {
  const db = world();
  const r = await call(db, { action: "crm_inbox", cursor: at(45) });
  assertEquals(r.status, 200, r.text);
  // Below minute 45: customer 3's email (40) and customer 2's text (10). Customer 2 has a call at
  // 70, so it was on page 1.
  assertEquals(rowsOf(r.body).map((x: any[]) => x[0]), ["Customer 3"]);
  assert(!("smsReady" in r.body), "page 2 repeated the first page's offer probes");
  const newer = db.reads("phone_calls").filter((l) => l.ops.some((o) => o[0] === "gte"));
  assert(newer.length >= 1, "the calls were not asked about newer rows");
});

// ─── 7. Mine ───────────────────────────────────────────────────────────────────────────────────
Deno.test("Mine keeps someone else's customer I once texted, asking only about my own sends", async () => {
  // Customer 4 is OTHER's; under the Email filter the page holds only their email, and the text
  // I sent them long ago is what keeps them.
  const db = world({ extra: {
    email_inbound: [mailIn(3, 40), mailIn(4, 20), mailIn(2, 15)],
    sms_messages: [text(4, 1, { direction: "out", sent_by: ME })],
  } });
  const r = await call(db, { action: "crm_inbox", channel: "email", mine: true });
  assertEquals(r.status, 200, r.text);
  // 3 is nobody's, 4 I texted, 2 is OTHER's and I never wrote to them on any channel.
  assertEquals(rowsOf(r.body).map((x: any[]) => x[0]), ["Customer 3", "Customer 4"]);
  const ever = db.reads("sms_messages").find((l) => l.ops.some((o) => o[0] === "eq" && o[1] === "sent_by"))!;
  assertEquals(ever.ops.find((o) => o[0] === "eq" && o[1] === "sent_by")?.[2], ME);
});

// ─── 8. Refusals ───────────────────────────────────────────────────────────────────────────────
Deno.test("refusals: no CRM, no contacts access, an unknown filter or cursor, and a failed read", async () => {
  const unpaid = await call(world({ billingExempt: false }), { action: "crm_inbox" });
  assertEquals(unpaid.status, 403, unpaid.text);
  assert(/CRM is not part of your subscription/.test(unpaid.body.error), unpaid.text);

  const crew = await call(world({ role: "user", title: "crew_member", access: null }), { action: "crm_inbox" });
  assertEquals(crew.status, 403, crew.text);

  const odd = await call(world(), { action: "crm_inbox", channel: "voicemail" });
  assertEquals(odd.status, 400, odd.text);
  const lost = await call(world(), { action: "crm_inbox", cursor: "next week" });
  assertEquals(lost.status, 400, lost.text);

  const db = world();
  db.fails.push({ table: "email_inbound" });
  const failed = await call(db, { action: "crm_inbox" });
  assertEquals(failed.status, 500, failed.text);
  assertEquals(failed.body.ref, "load your conversations");
  assert(!("threads" in failed.body), "a failed read answered as an empty inbox");
});
