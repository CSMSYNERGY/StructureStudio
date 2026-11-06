// Unit tests for _shared/ghlEmailCheck.ts, the rules behind the quote email check (migration 357).
//
// Deliberately dependency-free (no jsr:/npm: imports), the same rule the other _shared tests follow.
// GHL is the fake in _test_stubs/ghlFake.ts, which answers the way a tenant's stored key does; the
// database is the small fake below. Nothing reaches the network.
//
// Every way this goes wrong is silent, which is the failure it exists to end: a rule that fires on
// healthy emails gets the table ignored, and a rule that misses gives another four weeks of nothing.
// The fixtures use what the stored key actually returned on 2026-11-04: `failed` with an error,
// `pending` for the silent failure, `delivered` or `clicked` for a healthy email, and nothing else.
//
// Run: deno test --allow-env --allow-read supabase/functions/_shared/ghlEmailCheck.test.ts
// (the pre-push gate runs this for you, see scripts/preflight.mjs)
//
// Tenants, codes and GHL ids are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import {
  CHECKS_PER_RUN, COLUMNS, decide, enqueueGhlEmailCheck, type FiledError, FINAL_LOOK_MINUTES, FIRST_LOOK_MINUTES,
  GIVE_UP_HOURS, MATCH_AFTER_MS, MATCH_BEFORE_MS, runGhlEmailChecks, scrubProviderText,
} from "./ghlEmailCheck.ts";
import { CUSTOMER, type FakeEmail, ghlFake, type GhlWorld } from "./_test_stubs/ghlFake.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

// ─── The database ────────────────────────────────────────────────────────────────────────────
// The column list comes from the migration itself, so a column this code names and the table lacks
// fails here the way PostgREST fails it (42703), rather than first on the live project.
function columnsOfMigration(): Set<string> {
  const sql = Deno.readTextFileSync(new URL("../../migrations/357_ghl_email_checks.sql", import.meta.url)).replace(/\r/g, "");
  const block = /create table if not exists public\.ghl_email_checks \(([\s\S]*?)\n\);/.exec(sql);
  if (!block) throw new Error("357 no longer creates ghl_email_checks the way this test reads it");
  const cols = block[1].split("\n")
    .map((l) => /^\s{2}([a-z_]+)\s+\S/.exec(l)?.[1])
    .filter((c): c is string => !!c);
  return new Set(cols);
}
const SCHEMA: Record<string, Set<string>> = {
  ghl_email_checks: columnsOfMigration(),
  client_settings: new Set(["client_id", "ghl_api_key", "ghl_location_id"]),
};
const PGRST_MAX_ROWS = 1000;

type Row = Record<string, any>;
function fakeDb(seed: { checks?: Row[]; settings?: Row[]; failDueRead?: boolean; failClose?: boolean; throwOnInsert?: boolean; failSettingsRead?: boolean } = {}) {
  const tables: Record<string, Row[]> = { ghl_email_checks: seed.checks ?? [], client_settings: seed.settings ?? [] };
  let nextId = tables.ghl_email_checks.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const unknownColumn = (table: string, cols: string[]) => {
    const bad = cols.find((c) => !SCHEMA[table].has(c));
    return bad ? { code: "42703", message: `column ${table}.${bad} does not exist` } : null;
  };
  const from = (table: string) => {
    if (!SCHEMA[table]) throw new Error(`the fake database has no table ${table}`);
    const filters: ((r: Row) => boolean)[] = [];
    const named: string[] = [];
    let verb = "select", payload: Row | null = null, selectCols: string | null = null;
    let orderBy: string | null = null, limit = PGRST_MAX_ROWS, single = false, returning = false;
    const q: any = {
      select(cols: string) {
        selectCols = cols;
        named.push(...cols.split(",").map((c) => c.trim()));
        if (verb !== "select") returning = true;
        return q;
      },
      insert(row: Row) { verb = "insert"; payload = row; named.push(...Object.keys(row)); return q; },
      update(row: Row) { verb = "update"; payload = row; named.push(...Object.keys(row)); return q; },
      eq(col: string, v: unknown) { named.push(col); filters.push((r) => r[col] === v); return q; },
      lte(col: string, v: string) { named.push(col); filters.push((r) => String(r[col]) <= v); return q; },
      not(col: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error("the fake database only knows not is null");
        named.push(col);
        filters.push((r) => r[col] !== null && r[col] !== undefined);
        return q;
      },
      order(col: string) { named.push(col); orderBy = col; return q; },
      limit(n: number) { limit = n; return q; },
      maybeSingle() { single = true; return q; },
      then(ok: any, bad: any) { return Promise.resolve().then(run).then(ok, bad); },
    };
    const run = () => {
      const bad = unknownColumn(table, named);
      if (bad) return { data: null, error: bad };
      if (verb === "insert") {
        if (seed.throwOnInsert) throw new Error("network down");
        tables[table].push({ id: nextId++, looks: 0, state: "pending", ghl_conversation_id: null, ghl_email_id: null, last_status: null, closed_at: null, ...payload! });
        return { data: null, error: null };
      }
      const rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (verb === "update") {
        if (seed.failClose && payload!.closed_at) return { data: null, error: { message: "write refused" } };
        for (const r of rows) Object.assign(r, payload);
        return { data: returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (seed.failDueRead && selectCols === COLUMNS) return { data: null, error: { message: "queue unreadable" } };
      if (seed.failSettingsRead && table === "client_settings") return { data: null, error: { message: "database blip" } };
      const sorted = orderBy ? [...rows].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!]))) : rows;
      const page = sorted.slice(0, Math.min(limit, PGRST_MAX_ROWS)).map((r) => ({ ...r }));
      return { data: single ? (page[0] ?? null) : page, error: null };
    };
    return q;
  };
  return { from, tables };
}

// ─── The world ───────────────────────────────────────────────────────────────────────────────
const T = "acme-sheds";
const SENT = "2026-11-04T12:00:00.000Z";
const ms = (iso: string) => Date.parse(iso);
const at = (minutes: number) => new Date(ms(SENT) + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const SETTINGS = { client_id: T, ghl_api_key: "harness-key", ghl_location_id: "loc-acme" };

const check = (over: Row = {}): Row => ({
  id: 1,
  client_id: T,
  short_code: "SS-TEST1",
  ghl_estimate_id: "est-1",
  ghl_contact_id: "contact-1",
  send_started_at: SENT,
  next_check_at: iso(FIRST_LOOK_MINUTES),
  looks: 0,
  state: "pending",
  ghl_conversation_id: null,
  ghl_email_id: null,
  last_status: null,
  test_inbox: false,
  closed_at: null,
  ...over,
});
const email = (over: Partial<FakeEmail> = {}): FakeEmail => ({
  rowId: "row-1",
  emailId: "email-1",
  dateAdded: new Date(ms(SENT) + 1500).toISOString(),
  rowStatus: null,
  status: "delivered",
  ...over,
});
const world = (emails: FakeEmail[], over: Partial<GhlWorld> = {}): GhlWorld => ({
  estimates: [],
  opportunities: [],
  conversations: [{ id: "conv-1", contactId: "contact-1", emails }],
  ...over,
});

async function run(db: ReturnType<typeof fakeDb>, w: GhlWorld, minutes: number) {
  const filed: FiledError[] = [];
  const crm = ghlFake(w);
  const summary = await runGhlEmailChecks({
    db,
    fetch: crm.fetch,
    file: (row) => { filed.push(row); return Promise.resolve(); },
    now: () => at(minutes),
  });
  return { filed, summary, crm };
}
const only = (db: ReturnType<typeof fakeDb>) => db.tables.ghl_email_checks[0];
const dueAt = (db: ReturnType<typeof fakeDb>) => Date.parse(only(db).next_check_at);

// ─── decide ──────────────────────────────────────────────────────────────────────────────────
Deno.test("decide: the rules, on the only things the key shows", () => {
  const v = (status: string, error = "") => ({ status, error, channel: "" });
  assertEquals(decide(v("failed", "boom"), false), "failed");
  assertEquals(decide(v("failed"), false), "failed");
  assertEquals(decide(v("undelivered"), true), "failed");
  assertEquals(decide(v("delivered", "boom"), false), "failed", "an error counts whatever the status says");
  assertEquals(decide(v("pending"), false), "wait", "a moment of pending is not a failure");
  assertEquals(decide(v("delivered"), false), "wait", "a healthy first look still gets its final look");
  assertEquals(decide(v("pending"), true), "no_delivery");
  assertEquals(decide(v(""), true), "no_delivery");
  for (const s of ["sent", "delivered", "opened", "clicked", "read", "replied"]) assertEquals(decide(v(s), true), "ok", s);
  assertEquals(decide(v("scheduled"), true), "unknown_status");
});

// ─── The four shapes the key was seen returning ──────────────────────────────────────────────
Deno.test("a failed email files at the first look, and closes", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const msg = "The email request is missing a required property.";
  const { filed, crm } = await run(db, world([email({ rowStatus: "failed", rowError: msg, status: "failed", error: msg })]), 6);
  assertEquals(filed.length, 1);
  assertEquals(filed[0].code, "ghl_quote_email_failed");
  assertEquals(filed[0].severity, "error");
  assertEquals(filed[0].clientId, T);
  assertEquals(filed[0].context.providerError, msg);
  assertEquals(filed[0].context.designId, "SS-TEST1");
  assertEquals(filed[0].context.emailId, "email-1");
  assertEquals(only(db).state, "failed");
  assertEquals(only(db).last_status, "failed");
  assert(only(db).closed_at);
  assertEquals(crm.trace.conversationReads.length, 3, "search, rows, email");
  const again = await run(db, world([email({ status: "failed" })]), 70);
  assertEquals(again.filed.length, 0, "a closed row is never read or filed again");
  assertEquals(again.crm.trace.conversationReads.length, 0);
});

Deno.test("the silent failure: pending waits at the first look and files at the final look", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const w = world([email({ status: "pending" })]);
  const first = await run(db, w, 6);
  assertEquals(first.filed.length, 0);
  assertEquals(only(db).state, "pending");
  assertEquals(only(db).ghl_email_id, "email-1", "the email is remembered");
  assertEquals(only(db).ghl_conversation_id, "conv-1");
  assertEquals(dueAt(db), at(FINAL_LOOK_MINUTES).getTime(), "the next look is the final one");

  const tooSoon = await run(db, w, 30);
  assertEquals(tooSoon.crm.trace.conversationReads.length, 0, "nothing is read before it is due");

  const last = await run(db, w, FINAL_LOOK_MINUTES + 1);
  assertEquals(last.filed.length, 1);
  assertEquals(last.filed[0].code, "ghl_quote_email_no_delivery");
  assertEquals(last.filed[0].severity, "error");
  assertEquals(last.filed[0].context.status, "pending");
  assertEquals(only(db).state, "no_delivery");
  assertEquals(last.crm.trace.conversationReads.length, 1, "the final look costs one read");
});

Deno.test("a blank status with no error is the silent failure too", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  const { filed } = await run(db, world([email({ status: null })]), 61);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_no_delivery"]);
});

Deno.test("a healthy email gets both looks and files nothing", async () => {
  for (const status of ["delivered", "clicked", "sent"]) {
    const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
    const w = world([email({ status })]);
    const first = await run(db, w, 6);
    assertEquals(first.filed.length, 0);
    assertEquals(only(db).state, "pending", "it can still fail later");
    const last = await run(db, w, FINAL_LOOK_MINUTES + 1);
    assertEquals(last.filed.length, 0, status);
    assertEquals(only(db).state, "ok");
    assertEquals(only(db).last_status, status);
  }
});

Deno.test("a healthy email that fails between the looks files at the final look", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  await run(db, world([email({ status: "delivered" })]), 6);
  const { filed } = await run(db, world([email({ status: "failed", error: "bounced" })]), 61);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed"]);
});

Deno.test("a status this check has not seen is filed as a warning, so we learn the word", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  const { filed } = await run(db, world([email({ status: "scheduled" })]), 61);
  assertEquals(filed.map((f) => [f.code, f.severity]), [["ghl_quote_email_no_delivery", "warn"]]);
  assertEquals(filed[0].context.status, "scheduled");
});

Deno.test("no email row: waits at the first look, files not_found at the final look", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const w = world([]);
  const first = await run(db, w, 6);
  assertEquals(first.filed.length, 0);
  assertEquals(only(db).state, "pending");
  assertEquals(dueAt(db), at(FINAL_LOOK_MINUTES).getTime());
  const last = await run(db, w, 61);
  assertEquals(last.filed.map((f) => f.code), ["ghl_quote_email_not_found"]);
  assertEquals(only(db).state, "not_found");
});

Deno.test("a contact GHL no longer has reads as no email, not as an outage", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61), ghl_contact_id: "contact-gone" })], settings: [SETTINGS] });
  const { filed } = await run(db, world([email()]), 61);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_not_found"]);
});

// ─── Finding the right email ─────────────────────────────────────────────────────────────────
Deno.test("the email route is asked with messageIds[0], never the row's own id", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const { crm } = await run(db, world([email({ rowId: "row-9", emailId: "email-9", status: "failed" })]), 6);
  const paths = crm.trace.conversationReads.map((r) => r.path);
  assert(paths.includes("/conversations/messages/email/email-9"));
  assert(!paths.some((p) => p.includes("row-9")));
});

Deno.test("reads carry the tenant's key and the version the routes were proven on", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const { crm } = await run(db, world([email()]), 6);
  for (const r of crm.trace.conversationReads) {
    assertEquals(r.auth, "Bearer harness-key");
    assertEquals(r.version, "2021-07-28");
  }
  assert(crm.trace.conversationReads[0].path.includes("locationId=loc-acme"));
  assert(crm.trace.conversationReads[0].path.includes("contactId=contact-1"));
  assert(crm.trace.conversationReads[1].path.includes("type=TYPE_EMAIL"));
});

Deno.test("the window: other emails to the same contact are not this quote's", async () => {
  const before = new Date(ms(SENT) - MATCH_BEFORE_MS - 1000).toISOString();
  const after = new Date(ms(SENT) + MATCH_AFTER_MS + 1000).toISOString();
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  const { filed } = await run(db, world([
    email({ rowId: "a", emailId: "email-earlier", dateAdded: before, status: "delivered" }),
    email({ rowId: "b", emailId: "email-forwarded", dateAdded: after, status: "delivered" }),
    email({ rowId: "c", emailId: "email-inbound", direction: "inbound", dateAdded: new Date(ms(SENT) + 2000).toISOString(), status: "delivered" }),
  ]), 61);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_not_found"], "a delivered neighbour must not hide a missing quote");
});

Deno.test("two sends in one window each find their own email, so a success can't hide a failure", async () => {
  const db = fakeDb({
    checks: [
      check({ id: 1, short_code: "SS-A" }),
      check({ id: 2, short_code: "SS-B", send_started_at: new Date(ms(SENT) + 10_000).toISOString(), next_check_at: iso(FIRST_LOOK_MINUTES + 1) }),
    ],
    settings: [SETTINGS],
  });
  const { filed } = await run(db, world([
    email({ rowId: "a", emailId: "email-a", status: "failed", error: "boom" }),
    email({ rowId: "b", emailId: "email-b", dateAdded: new Date(ms(SENT) + 11_000).toISOString(), status: "delivered" }),
  ]), 7);
  assertEquals(filed.map((f) => f.context.designId), ["SS-A"]);
  const rows = db.tables.ghl_email_checks;
  assertEquals(rows.find((r) => r.id === 1)!.ghl_email_id, "email-a");
  assertEquals(rows.find((r) => r.id === 2)!.ghl_email_id, "email-b");
});

Deno.test("the row's failed counts whatever the email route says", async () => {
  for (const status of [null, "delivered"]) {
    const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
    const { filed } = await run(db, world([email({ rowStatus: "failed", status })]), 6);
    assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed"], String(status));
  }
});

Deno.test("a healthy email route outranks a row with a lesser status", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  const { filed } = await run(db, world([email({ rowStatus: "pending", status: "delivered" })]), 61);
  assertEquals(filed.length, 0);
  assertEquals(only(db).last_status, "delivered");
});

Deno.test("a row with no message ids is judged on the row alone", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const { filed, crm } = await run(db, world([email({ emailId: undefined, rowStatus: "failed", rowError: "boom" })]), 6);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed"]);
  assertEquals(crm.trace.conversationReads.length, 2, "no email route to ask");
});

Deno.test("a remembered email that stops answering is looked up again", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61), ghl_email_id: "email-old", ghl_conversation_id: "conv-1" })], settings: [SETTINGS] });
  const { filed } = await run(db, world([email({ emailId: "email-new", status: "failed" })]), 61);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed"]);
  assertEquals(only(db).ghl_email_id, "email-new");
});

Deno.test("the email route's answer is read with or without its wrapper", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const { filed } = await run(db, world([email({ status: "failed" })], { bareEmailAnswer: true }), 6);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed"]);
});

// ─── GHL refusing or failing ─────────────────────────────────────────────────────────────────
Deno.test("a missing scope files at once on each route, because the check has gone blind", async () => {
  for (const route of ["search", "messages", "email"] as const) {
    const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
    const { filed } = await run(db, world([email()], { failConversationRoute: { route, status: 401 } }), 6);
    assertEquals(filed.map((f) => f.code), ["ghl_quote_email_unreadable"], route);
    assertEquals(filed[0].context.route, route);
    assertEquals(filed[0].context.httpStatus, 401);
    assertEquals(only(db).state, "unreadable");
  }
});

Deno.test("an outage files nothing and tries again next tick", async () => {
  for (const status of [429, 500, 503]) {
    const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
    const { filed, summary } = await run(db, world([email()], { failConversationRoute: { route: "search", status } }), 6);
    assertEquals(filed.length, 0, String(status));
    assertEquals(only(db).state, "pending");
    assertEquals(summary.waiting, 1);
    assertEquals(dueAt(db), at(11).getTime(), "the claim set the next try");
  }
});

Deno.test("an outage past the final look still waits, and gives up at 24 h", async () => {
  const w = world([email()], { failConversationRoute: { route: "messages", status: 503 } });
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  assertEquals((await run(db, w, 61)).filed.length, 0, "an outage is not a failed email");
  only(db).next_check_at = iso(GIVE_UP_HOURS * 60);
  const { filed } = await run(db, w, GIVE_UP_HOURS * 60);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_unreadable"]);
  assertEquals(filed[0].context.httpStatus, 503);
});

Deno.test("a network failure counts as an outage, not as no email", async () => {
  const db = fakeDb({ checks: [check({ next_check_at: iso(61) })], settings: [SETTINGS] });
  const filed: FiledError[] = [];
  const summary = await runGhlEmailChecks({
    db,
    fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch,
    file: (row) => { filed.push(row); return Promise.resolve(); },
    now: () => at(61),
  });
  assertEquals(filed.length, 0);
  assertEquals(summary.waiting, 1);
  assertEquals(only(db).state, "pending");
});

Deno.test("a tenant with no key on file files once, and asks GHL nothing", async () => {
  const db = fakeDb({ checks: [check()], settings: [{ client_id: T, ghl_api_key: null, ghl_location_id: null }] });
  const { filed, crm } = await run(db, world([email()]), 6);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_unreadable"]);
  assertEquals(filed[0].context.reason, "no_ghl_key");
  assertEquals(crm.trace.conversationReads.length, 0);
  assertEquals(only(db).state, "unreadable");
});

Deno.test("a database blip reading the key is not reported as no key: the row waits", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS], failSettingsRead: true });
  const { filed, summary, crm } = await run(db, world([email({ status: "failed" })]), 6);
  assertEquals(filed.length, 0);
  assertEquals(only(db).state, "pending");
  assertEquals(summary.waiting, 1);
  assertEquals(crm.trace.conversationReads.length, 0);
  assertEquals(dueAt(db), at(11).getTime(), "the claim set the next try");
});

// ─── Customer data ───────────────────────────────────────────────────────────────────────────
Deno.test("no customer value reaches a report, on any path that files one", async () => {
  const leaky = `Could not send to ${CUSTOMER.email} or ${CUSTOMER.phone}`;
  const cases: { w: GhlWorld; minutes: number }[] = [
    { w: world([email({ rowStatus: "failed", rowError: leaky, status: "failed", error: leaky, channel: `Outlook ${CUSTOMER.email}` })]), minutes: 6 },
    { w: world([email({ status: "pending" })]), minutes: 61 },
    { w: world([email({ status: "scheduled" })]), minutes: 61 },
    { w: world([]), minutes: 61 },
    { w: world([email()], { failConversationRoute: { route: "search", status: 401 } }), minutes: 6 },
  ];
  for (const c of cases) {
    const db = fakeDb({ checks: [check({ next_check_at: iso(c.minutes) })], settings: [SETTINGS] });
    const { filed } = await run(db, c.w, c.minutes);
    assertEquals(filed.length, 1);
    const text = JSON.stringify(filed) + JSON.stringify(db.tables.ghl_email_checks);
    for (const value of Object.values(CUSTOMER)) assert(!text.includes(value), `${value} reached a report: ${text}`);
    assert(!text.includes("harness-key"), "the key reached a report");
    assert(!JSON.stringify(filed).includes("contact-1"), "the contact id stays out of the report");
    assert(!text.includes("loc-acme"), "the location id stays out of the report");
  }
});

Deno.test("scrubProviderText: addresses and numbers go, the words stay, and it has a length cap", () => {
  assertEquals(scrubProviderText("bad recipient a.b+c@mail.example.co.uk today"), "bad recipient <email> today");
  assertEquals(scrubProviderText("call +1 (555) 555-0142 now"), "call <number> now");
  assertEquals(scrubProviderText("HTTP 400 required property"), "HTTP 400 required property", "a short code is not a phone number");
  assertEquals(scrubProviderText(null), "");
  assertEquals(scrubProviderText("x".repeat(1000)).length, 300);
});

// ─── The queue ───────────────────────────────────────────────────────────────────────────────
Deno.test("enqueue writes a row the tick can read, due at the first look", async () => {
  const db = fakeDb();
  const out = await enqueueGhlEmailCheck(db, {
    clientId: T, shortCode: "SS-TEST1", estimateId: "est-1", contactId: "contact-1", sendStartedAt: SENT, testInbox: true,
  });
  assertEquals(out, { ok: true });
  assertEquals(only(db).state, "pending");
  assertEquals(only(db).test_inbox, true);
  assertEquals(only(db).next_check_at, iso(FIRST_LOOK_MINUTES));
  db.tables.client_settings.push(SETTINGS);
  const { filed } = await run(db, world([email({ status: "failed" })]), FIRST_LOOK_MINUTES);
  assertEquals(filed.length, 1, "the row it wrote is one the tick picks up");
  assertEquals(filed[0].context.testInbox, true, "a test inbox failure says so");
});

Deno.test("enqueue never throws, whatever the database does", async () => {
  const throws = await enqueueGhlEmailCheck(fakeDb({ throwOnInsert: true }), {
    clientId: T, shortCode: "x", estimateId: "e", contactId: "c", sendStartedAt: SENT, testInbox: false,
  });
  assertEquals(throws, { ok: false, error: "network down" });
  const noTable = await enqueueGhlEmailCheck({ from: () => { throw new Error("relation does not exist"); } }, {
    clientId: T, shortCode: "x", estimateId: "e", contactId: "c", sendStartedAt: SENT, testInbox: false,
  });
  assertEquals(noTable.ok, false);
});

Deno.test("overlapping ticks file one failure once", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS] });
  const w = world([email({ status: "failed" })]);
  const [a, b] = await Promise.all([run(db, w, 6), run(db, w, 6)]);
  assertEquals(a.filed.length + b.filed.length, 1);
});

Deno.test("one run takes the oldest due rows up to its cap, and the rest wait for the next", async () => {
  const checks = Array.from({ length: CHECKS_PER_RUN + 5 }, (_, i) =>
    check({
      id: i + 1,
      ghl_contact_id: `contact-${i + 1}`,
      next_check_at: new Date(at(FIRST_LOOK_MINUTES).getTime() + i * 1000).toISOString(),
    }));
  const db = fakeDb({ checks, settings: [SETTINGS] });
  const conversations = checks.map((c, i) => ({
    id: `conv-${i + 1}`, contactId: c.ghl_contact_id, emails: [email({ rowId: `r${i}`, emailId: `e${i}`, status: "delivered" })],
  }));
  const { summary } = await run(db, world([], { conversations }), 6);
  assertEquals(summary.due, CHECKS_PER_RUN);
  assertEquals(summary.looked, CHECKS_PER_RUN);
  const untouched = db.tables.ghl_email_checks.filter((r) => r.looks === 0).map((r) => r.id);
  assertEquals(untouched, [16, 17, 18, 19, 20]);
});

Deno.test("an unreadable queue is reported as a failed run", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS], failDueRead: true });
  const { summary } = await run(db, world([]), 6);
  assertEquals(summary.ok, false);
  assertEquals(summary.error, "queue unreadable");
});

Deno.test("a failure to close a row is reported, and the email's report still goes", async () => {
  const db = fakeDb({ checks: [check()], settings: [SETTINGS], failClose: true });
  const { filed, summary } = await run(db, world([email({ status: "failed" })]), 6);
  assertEquals(filed.map((f) => f.code), ["ghl_quote_email_failed", "ghl_email_check_write_failed"]);
  assertEquals(summary.writeErrors, 1);
});

Deno.test("the fake database refuses a column the table does not have", async () => {
  const db = fakeDb({ checks: [check()] });
  const { error } = await db.from("ghl_email_checks").select("id, no_such_column");
  assertEquals(error?.code, "42703");
  for (const col of COLUMNS.split(",").map((c) => c.trim())) assert(SCHEMA.ghl_email_checks.has(col), `${col} is not in the migration`);
});
