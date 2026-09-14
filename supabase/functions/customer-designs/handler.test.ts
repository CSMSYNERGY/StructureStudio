/**
 * Unit tests for customer-designs (migration 231) — link / list / hide against an in-memory
 * database. No network, no registry: handler.ts imports nothing from jsr:/npm:, and the real
 * customerSession.checkSession runs against the fake's customer_sessions table, so the auth path
 * under test is the production one.
 *
 * WHAT MUST HOLD (the handler header's two rules, plus the housekeeping):
 *   * a design is linked only under an identity the session PROVED and the design's contact NAMES
 *   * the list reads links only, drafts only, and drops a design whose contact no longer names the
 *     identity it was saved under
 *   * "Remove" sticks across re-links, and hides only the caller's own links
 *   * the 200 cap refuses before writing anything; a refusal never leaks the raw database message
 *
 * Run (from supabase/functions/customer-designs/):
 *   deno test --allow-env --node-modules-dir=none handler.test.ts
 * ⚠️ scripts/preflight.mjs discovers only _shared/*.test.ts and _shared/_test_stubs/*_test.ts, so
 * the pre-push gate does NOT run this file. Run it by hand when handler.ts changes.
 */

import { handle, MAX_LINKS_PER_IDENTITY, type LogInput } from "./handler.ts";
import { sha256Hex } from "../_shared/customerSession.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${msg ? ` — ${msg}` : ""}`);
}

// ── In-memory database ─────────────────────────────────────────────────────────────────────
// Just enough of supabase-js's builder for the calls handler.ts and checkSession make:
//   select(cols, {count, head}?) · insert(row) · update(patch)
//   .eq · .is · .gt · .in · .order · .limit · .maybeSingle() · await
// customer_design_links enforces the migration's check and both partial unique indexes, so a
// handler that relied on "insert twice and hope" fails here the way it would on Postgres.

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "update";

class FakeDb {
  tables: Record<string, Row[]> = { customer_sessions: [], designs: [], customer_design_links: [] };
  calls: { table: string; op: Op }[] = [];
  /** Fail the next matching call with this Postgres-shaped error. */
  failOn: { table: string; op: Op; error: Row } | null = null;
  /** Simulate a concurrent link landing between the existence check and the insert. */
  raceOnInsert = false;
  private seq = 0;
  nextId() { return `id-${++this.seq}`; }
  from(table: string) { return new Query(this, table); }
  links() { return this.tables.customer_design_links; }
}

class Query {
  private op: Op = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row | null = null;
  private head = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  constructor(private db: FakeDb, private table: string) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }) { this.op = "select"; this.head = !!opts?.head; return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  is(col: string, val: unknown) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
  gt(col: string, val: unknown) { this.filters.push((r) => String(r[col]) > String(val)); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() {
    return this.run().then((res) => {
      if (res.error) return res;
      const rows = (res.data as Row[] | null) ?? [];
      if (rows.length > 1) return { data: null, error: { message: "multiple rows for maybeSingle" } };
      return { data: rows[0] ?? null, error: null };
    });
  }
  then<T>(ok: (v: { data: unknown; error: Row | null; count?: number | null }) => T, bad?: (e: unknown) => T) {
    return this.run().then(ok, bad);
  }

  private rows() { return this.db.tables[this.table] ??= []; }

  private run(): Promise<{ data: unknown; error: Row | null; count?: number | null }> {
    this.db.calls.push({ table: this.table, op: this.op });
    const f = this.db.failOn;
    if (f && f.table === this.table && f.op === this.op) {
      this.db.failOn = null;
      return Promise.resolve({ data: null, error: f.error, count: null });
    }
    const match = (r: Row) => this.filters.every((fn) => fn(r));

    if (this.op === "insert") {
      const row: Row = { id: this.db.nextId(), created_at: new Date().toISOString(), hidden_at: null, ...this.payload };
      if (this.table === "customer_design_links") {
        const nn = [row.phone_digits, row.email_lower].filter((v) => v != null).length;
        if (nn !== 1) return Promise.resolve({ data: null, error: { code: "23514", message: "check violation" } });
        if (this.db.raceOnInsert) {
          this.db.raceOnInsert = false;
          this.rows().push({ ...row, id: this.db.nextId() });
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value" } });
        }
        const dup = this.rows().some((r) =>
          r.client_id === row.client_id && r.short_code === row.short_code &&
          ((row.phone_digits != null && r.phone_digits === row.phone_digits) ||
            (row.email_lower != null && r.email_lower === row.email_lower))
        );
        if (dup) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value" } });
      }
      this.rows().push(row);
      return Promise.resolve({ data: null, error: null });
    }

    if (this.op === "update") {
      for (const r of this.rows()) if (match(r)) Object.assign(r, this.payload);
      return Promise.resolve({ data: null, error: null });
    }

    let out = this.rows().filter(match).map((r) => ({ ...r }));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    if (this.head) return Promise.resolve({ data: null, error: null, count: out.length });
    return Promise.resolve({ data: out, error: null, count: out.length });
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────

const ORIGIN = "https://proj.supabase.co";
const OWN_IMG = `${ORIGIN}/storage/v1/object/public/floor-plans/t1/SS-AAA-3d.png`;
const P = "8165550100";
const Q = "8165550199";
const E = "pat@example.com";

function setup() {
  const db = new FakeDb();
  const logs: LogInput[] = [];
  let built = 0;
  const deps = {
    admin: () => { built++; return db; },
    log: (i: LogInput) => { logs.push(i); return Promise.resolve(); },
    storageOrigin: ORIGIN,
  };
  return { db, logs, deps, built: () => built };
}

let tokenSeq = 0;
async function session(db: FakeDb, who: { phone?: string; email?: string }, clientId = "t1"): Promise<string> {
  const token = `tok${++tokenSeq}`.padEnd(43, "x");
  db.tables.customer_sessions.push({
    client_id: clientId,
    phone_digits: who.phone ?? null,
    email_lower: who.email ?? null,
    name: null,
    token_hash: await sha256Hex(token),
    revoked_at: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  return token;
}

function design(db: FakeDb, code: string, over: Row = {}) {
  const row: Row = {
    short_code: code,
    client_id: "t1",
    status: "draft",
    contact: { phone: `(816) 555-0100`, email: "" },
    selections: { style: "Lofted Barn", size: "12x20" },
    created_at: "2026-09-15T10:00:00.000Z",
    updated_at: "2026-09-15T10:00:00.000Z",
    view3d_image_url: null,
    ...over,
  };
  db.tables.designs.push(row);
  return row;
}

async function call(deps: ReturnType<typeof setup>["deps"], body: unknown, init: RequestInit = {}, url = "https://edge.example/customer-designs") {
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  const res = await handle(req, deps);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* "ok" for OPTIONS */ }
  return { status: res.status, json, text, cors: res.headers.get("access-control-allow-origin") };
}

// ── Transport ──────────────────────────────────────────────────────────────────────────────

Deno.test("OPTIONS, warm-up, wrong method, bad JSON and unknown action never build a client", async () => {
  const t = setup();
  const pre = await handle(new Request("https://edge.example/customer-designs", { method: "OPTIONS" }), t.deps);
  assertEquals(pre.status, 200);
  assertEquals(pre.headers.get("access-control-allow-origin"), "*");
  assertEquals((await call(t.deps, "{}", {}, "https://edge.example/customer-designs?warm=1")).json, { ok: true });
  assertEquals((await handle(new Request("https://edge.example/customer-designs"), t.deps)).status, 405);
  assertEquals((await call(t.deps, "not json")).status, 400);
  const unknown = await call(t.deps, { action: "delete_everything", token: "x" });
  assertEquals(unknown.status, 400);
  assertEquals(unknown.cors, "*", "refusals carry CORS too, or the browser reads a network error");
  assertEquals(t.built(), 0);
});

Deno.test("a garbage or unknown token is 401 before any design is read", async () => {
  const t = setup();
  for (const token of [undefined, "short", "y".repeat(43)]) {
    const r = await call(t.deps, { action: "list", token });
    assertEquals(r.status, 401);
    assertEquals(r.json.error, "Session expired — sign in again.");
  }
  assert(t.db.calls.every((c) => c.table === "customer_sessions"), "only the session table is touched");
});

// ── link ───────────────────────────────────────────────────────────────────────────────────

Deno.test("link: your own draft is saved under the phone you proved", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-AAA");
  const r = await call(t.deps, { action: "link", token, code: "SS-AAA" });
  assertEquals(r.json, { ok: true, linked: true, hidden: false });
  assertEquals(t.db.links().length, 1);
  assertEquals([t.db.links()[0].phone_digits, t.db.links()[0].email_lower, t.db.links()[0].client_id], [P, null, "t1"]);
});

Deno.test("link: a design naming someone else's phone, another builder's design, stock and junk codes all refuse the same way", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-THEIRS", { contact: { phone: Q } });
  design(t.db, "SS-OTHERT", { client_id: "t2" });
  design(t.db, "SS-STOCK", { status: "inventory" });
  for (const code of ["SS-THEIRS", "SS-OTHERT", "SS-STOCK", "SS-NOPE"]) {
    const r = await call(t.deps, { action: "link", token, code });
    assertEquals(r.status, 404, code);
    assertEquals(r.json.error, "That design wasn't found on your account.", code);
  }
  assertEquals((await call(t.deps, { action: "link", token, code: "../x" })).status, 400);
  assertEquals((await call(t.deps, { action: "hide", token })).status, 400, "hide needs a code too");
  assertEquals(t.db.links().length, 0);
});

Deno.test("link: an email session saves under the normalised address, never under the design's phone", async () => {
  const t = setup();
  const token = await session(t.db, { email: E });
  design(t.db, "SS-MAIL", { contact: { phone: P, email: "  Pat@Example.com " } });
  const r = await call(t.deps, { action: "link", token, code: "SS-MAIL" });
  assertEquals(r.json.linked, true);
  assertEquals(t.db.links().map((l) => [l.phone_digits, l.email_lower]), [[null, E]]);
});

Deno.test("link: a two-identity session writes one row per identity the contact NAMES, and only those", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P, email: E });
  design(t.db, "SS-BOTH", { contact: { phone: P, email: E } });
  design(t.db, "SS-PHONE", { contact: { phone: P, email: "someone@else.com" } });
  await call(t.deps, { action: "link", token, code: "SS-BOTH" });
  await call(t.deps, { action: "link", token, code: "SS-PHONE" });
  const rows = t.db.links().map((l) => `${l.short_code}:${l.phone_digits ?? ""}:${l.email_lower ?? ""}`).sort();
  assertEquals(rows, [`SS-BOTH::${E}`, `SS-BOTH:${P}:`, `SS-PHONE:${P}:`].sort());
});

Deno.test("link: an issued quote is not an error and saves nothing; linking twice writes once", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-SIGNED", { status: "accepted" });
  design(t.db, "SS-SENT", { status: "sent" });
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-SIGNED" })).json, { ok: true, linked: false, reason: "order" });
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-SENT" })).json.linked, true, "sent is still linkable");
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-SENT" })).json, { ok: true, linked: true, hidden: false });
  assertEquals(t.db.links().length, 1);
});

Deno.test("link: a concurrent link winning the insert (23505) is success, not a 500", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-RACE");
  t.db.raceOnInsert = true;
  const r = await call(t.deps, { action: "link", token, code: "SS-RACE" });
  assertEquals(r.status, 200);
  assertEquals(r.json.linked, true);
  assertEquals(t.logs.length, 0);
});

Deno.test("link: at the cap it refuses BEFORE writing; an already-saved design and a freed slot both still work", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  for (let i = 0; i < MAX_LINKS_PER_IDENTITY; i++) {
    t.db.links().push({ id: `seed${i}`, client_id: "t1", short_code: `SS-S${i}`, phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-09-01T00:00:00Z" });
    design(t.db, `SS-S${i}`); // still drafts: these are what the cap counts
  }
  // Hidden links and another identity's links do not count against P.
  t.db.links().push({ id: "h", client_id: "t1", short_code: "SS-HID", phone_digits: P, email_lower: null, hidden_at: "2026-09-02T00:00:00Z" });
  t.db.links().push({ id: "q", client_id: "t1", short_code: "SS-Q", phone_digits: Q, email_lower: null, hidden_at: null });
  design(t.db, "SS-HID");
  design(t.db, "SS-Q", { contact: { phone: Q } });
  design(t.db, "SS-NEW");

  const refused = await call(t.deps, { action: "link", token, code: "SS-NEW" });
  assertEquals(refused.status, 409);
  assertEquals(refused.json.reason, "cap");
  assert(!t.db.calls.some((c) => c.op === "insert"), "nothing inserted on a refusal");

  assertEquals((await call(t.deps, { action: "link", token, code: "SS-S7" })).json.linked, true, "already saved: no cap");

  await call(t.deps, { action: "hide", token, code: "SS-S7" });
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-NEW" })).json, { ok: true, linked: true, hidden: false });
});

Deno.test("link: links whose drafts became quotes do not count against the cap — a repeat customer can still save", async () => {
  // Review, 2026-09-15: a draft's link outlives it becoming a quote, and quotes have no Remove
  // under Saved designs. Counting them locked a customer with 200 quotes out of saving any draft.
  const t = setup();
  const token = await session(t.db, { phone: P });
  for (let i = 0; i < MAX_LINKS_PER_IDENTITY; i++) {
    t.db.links().push({ id: `seed${i}`, client_id: "t1", short_code: `SS-S${i}`, phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-09-01T00:00:00Z" });
    design(t.db, `SS-S${i}`, { status: i % 2 ? "sent" : "accepted" });
  }
  design(t.db, "SS-NEW");
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-NEW" })).json, { ok: true, linked: true, hidden: false });

  // …and the cap still holds for real drafts: 199 more drafts fill it, the next one is refused.
  for (let i = 0; i < MAX_LINKS_PER_IDENTITY - 1; i++) {
    t.db.links().push({ id: `d${i}`, client_id: "t1", short_code: `SS-D${i}`, phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-09-02T00:00:00Z" });
    design(t.db, `SS-D${i}`);
  }
  design(t.db, "SS-ONEMORE");
  const refused = await call(t.deps, { action: "link", token, code: "SS-ONEMORE" });
  assertEquals([refused.status, refused.json.reason], [409, "cap"]);
});

Deno.test("link: a database failure is an authored 500, and the raw message goes only to the log", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-AAA");
  t.db.failOn = { table: "designs", op: "select", error: { code: "XX000", message: "relation leaked 8165550100" } };
  const r = await call(t.deps, { action: "link", token, code: "SS-AAA" });
  assertEquals(r.status, 500);
  assertEquals(r.json.error, "Couldn't reach your saved designs. Please try again in a moment.");
  assert(!r.text.includes("8165550100"), "no raw database text in the response");
  assertEquals(t.logs.length, 1);
  assert(t.logs[0].message.includes("relation leaked"), "the log keeps the real reason");
  assertEquals(t.logs[0].fn, "customer-designs");

  // Before migration 231 the table does not exist: also an authored 500, never a crash.
  t.db.failOn = { table: "customer_design_links", op: "select", error: { code: "PGRST205", message: "Could not find the table" } };
  assertEquals((await call(t.deps, { action: "link", token, code: "SS-AAA" })).status, 500);
});

// ── list ───────────────────────────────────────────────────────────────────────────────────

Deno.test("list: only LINKED drafts — a stranger's draft carrying your phone never appears", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P });
  design(t.db, "SS-MINE", { updated_at: "2026-09-15T12:00:00Z", view3d_image_url: OWN_IMG });
  design(t.db, "SS-PLANTED", { updated_at: "2026-09-15T13:00:00Z" }); // your phone, never linked
  design(t.db, "SS-OLDER", { updated_at: "2026-09-14T09:00:00Z", view3d_image_url: "https://evil.example/x.png" });
  design(t.db, "SS-QUOTED", { status: "sent" });
  for (const code of ["SS-MINE", "SS-OLDER", "SS-QUOTED"]) await call(t.deps, { action: "link", token, code });

  const r = await call(t.deps, { action: "list", token });
  assertEquals(r.status, 200);
  const designs = r.json.designs as Row[];
  assertEquals(designs.map((d) => d.ref), ["SS-MINE", "SS-OLDER"], "newest first; sent quotes and unlinked drafts excluded");
  assertEquals(Object.keys(designs[0]).sort(), ["createdAt", "ref", "size", "style", "updatedAt", "view3dImageUrl"]);
  assertEquals(designs[0].view3dImageUrl, OWN_IMG);
  assertEquals(designs[1].view3dImageUrl, null, "a thumbnail that is not our own storage never leaves");
  assertEquals([designs[0].style, designs[0].size], ["Lofted Barn", "12x20"]);
  assert(!r.text.includes("555-0100"), "no contact in the projection");
});

Deno.test("list: a design whose contact was rewritten after saving drops out, even if another identity of yours now matches", async () => {
  const t = setup();
  const token = await session(t.db, { phone: P, email: E });
  const d = design(t.db, "SS-MOVED", { contact: { phone: P } });
  await call(t.deps, { action: "link", token, code: "SS-MOVED" }); // saved under P only
  assertEquals(((await call(t.deps, { action: "list", token })).json.designs as Row[]).length, 1);

  d.contact = { phone: Q, email: E }; // anon save_design rewrote it
  assertEquals((await call(t.deps, { action: "list", token })).json.designs, [],
    "E matches now, but the design was never saved under E");
});

Deno.test("list: an email-only login does not see a design saved under the phone, and vice versa", async () => {
  const t = setup();
  const both = await session(t.db, { phone: P, email: E });
  design(t.db, "SS-PH", { contact: { phone: P } });
  design(t.db, "SS-EM", { contact: { email: E } });
  await call(t.deps, { action: "link", token: both, code: "SS-PH" });
  await call(t.deps, { action: "link", token: both, code: "SS-EM" });

  const emailOnly = await session(t.db, { email: E });
  const phoneOnly = await session(t.db, { phone: P });
  assertEquals(((await call(t.deps, { action: "list", token: emailOnly })).json.designs as Row[]).map((d) => d.ref), ["SS-EM"]);
  assertEquals(((await call(t.deps, { action: "list", token: phoneOnly })).json.designs as Row[]).map((d) => d.ref), ["SS-PH"]);
  assertEquals(((await call(t.deps, { action: "list", token: both })).json.designs as Row[]).length, 2, "no duplicates");

  const otherTenant = await session(t.db, { phone: P }, "t2");
  assertEquals((await call(t.deps, { action: "list", token: otherTenant })).json.designs, [], "links never cross builders");
});

Deno.test("list: a draft behind more than 200 newer links to issued quotes still appears, and the list stops at the cap", async () => {
  // Review, 2026-09-15: the list read the newest 200 links and THEN filtered to drafts, so a
  // repeat customer's real drafts fell off the end behind their own quotes.
  const t = setup();
  const token = await session(t.db, { phone: P });
  t.db.links().push({ id: "old", client_id: "t1", short_code: "SS-OLDDRAFT", phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-08-01T00:00:00Z" });
  design(t.db, "SS-OLDDRAFT", { updated_at: "2026-08-01T00:00:00Z" });
  for (let i = 0; i < 250; i++) {
    const code = `SS-QT${i}`;
    t.db.links().push({ id: `qt${i}`, client_id: "t1", short_code: code, phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-09-10T00:00:00Z" });
    design(t.db, code, { status: "sent" });
  }
  assertEquals(((await call(t.deps, { action: "list", token })).json.designs as Row[]).map((d) => d.ref), ["SS-OLDDRAFT"]);

  // More visible draft links than the cap (seeded past it): the list shows the cap, newest first.
  for (let i = 0; i < MAX_LINKS_PER_IDENTITY + 5; i++) {
    const code = `SS-DR${i}`;
    t.db.links().push({ id: `dr${i}`, client_id: "t1", short_code: code, phone_digits: P, email_lower: null, hidden_at: null, created_at: "2026-09-11T00:00:00Z" });
    design(t.db, code, { updated_at: `2026-09-12T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z` });
  }
  const capped = (await call(t.deps, { action: "list", token })).json.designs as Row[];
  assertEquals(capped.length, MAX_LINKS_PER_IDENTITY);
  assertEquals(capped[0].ref, `SS-DR${MAX_LINKS_PER_IDENTITY + 4}`, "newest-edited first");
  assert(!capped.some((d) => d.ref === "SS-OLDDRAFT"), "the oldest draft is the one past the cap");
});

// ── hide ───────────────────────────────────────────────────────────────────────────────────

Deno.test("hide: removes it from YOUR list only, sticks across a re-link, and always answers ok", async () => {
  const t = setup();
  const mine = await session(t.db, { phone: P });
  const partner = await session(t.db, { email: E });
  design(t.db, "SS-SHARED", { contact: { phone: P, email: E } });
  await call(t.deps, { action: "link", token: mine, code: "SS-SHARED" });
  await call(t.deps, { action: "link", token: partner, code: "SS-SHARED" });

  assertEquals((await call(t.deps, { action: "hide", token: mine, code: "SS-SHARED" })).json, { ok: true });
  assertEquals((await call(t.deps, { action: "list", token: mine })).json.designs, []);
  assertEquals(((await call(t.deps, { action: "list", token: partner })).json.designs as Row[]).length, 1, "partner's link untouched");

  assertEquals((await call(t.deps, { action: "link", token: mine, code: "SS-SHARED" })).json,
    { ok: true, linked: true, hidden: true }, "a refresh re-links; Remove must not undo itself");
  assertEquals((await call(t.deps, { action: "list", token: mine })).json.designs, []);
  assertEquals(t.db.links().length, 2, "no new row from the re-link");

  assertEquals((await call(t.deps, { action: "hide", token: mine, code: "SS-NEVER" })).json, { ok: true });
  assertEquals(t.db.tables.designs.length, 1, "hiding never touches the design");
});
