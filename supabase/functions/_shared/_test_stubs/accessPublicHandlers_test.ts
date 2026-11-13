// THE THREE PUBLIC FUNCTIONS THAT ASK THE PLAN (migration 389, _shared/accessPublic.ts), each driven
// through its SHIPPED request handler: lead-form (tab "forms"), book-public (tab "meetings") and
// shop-checkout (tab "inventory").
//
// What a plan may do on a public page is narrow, and this file is where it is held:
//
//   1. NOBODY NAMED = NOTHING CHANGES. With the plan read answering null (and when it fails, is
//      missing, or answers nonsense) every action answers exactly what it answers with the plan
//      read never asked: same status, same body, same database reads in the same order.
//   2. BLOCK refuses only the actions that START something (load / start a form, ask for meeting
//      times or book one, price a cart), and in the function's EXISTING not-found shape: the very
//      response an unpublished form, a switched-off booking page or a switched-off shop gives, so
//      nobody outside can tell which builders have a feature.
//   3. REPORT refuses nothing and files one info row saying what would have been refused.
//   4. WHAT A CUSTOMER HAS ALREADY DONE IS NEVER ASKED ABOUT: a form submit, a purchase request, a
//      card payment, pay_setup, and a booking read, moved or cancelled by its token. Those requests
//      never reach the plan read at all, whatever the company's plan says.
//   5. A MADE-UP COMPANY NEVER REACHES THE PLAN READ: the read is cached by company id, so it is
//      asked only after the function proved the company's form / booking page / shop exists.
//
// HOW. The accessEnforce_test idiom: Deno.serve is stubbed while a function's index.ts is imported,
// so a request goes through withErrorLog and the real branches; the import map swaps supabase-js for
// supabase_stub.ts. The database is a table of canned answers that also writes down every table and
// rpc the handler touched, in order; a table the world does not list answers an error, so a request
// that wanders further than its world expects shows up as a different transcript. No network is
// granted. Tenants are made up (public repo).
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --allow-read=<repo root> --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json _shared/_test_stubs/accessPublicHandlers_test.ts

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
type Handler = (req: Request) => Promise<Response>;
async function load(fn: string): Promise<Handler> {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realServe = Deno.serve;
  let handler: Handler | null = null;
  (Deno as any).serve = (h: Handler) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler as Handler;
}
const LEAD_FORM = await load("lead-form");
const BOOK_PUBLIC = await load("book-public");
const SHOP_CHECKOUT = await load("shop-checkout");

// ── the plan read, as a test sets it ────────────────────────────────────────────────────────
/** `untouched` leaves the double's default in place (it answers null without asking the test's own
 *  rpc fake): that is the baseline, the function as every other test sees it. */
type Plan = { untouched: true } | { answer: unknown } | { error: true } | { throws: true };
const UNTOUCHED: Plan = { untouched: true };
const blocking = (tab: string, mode = "block"): Plan => ({ answer: { mode, holds: true, blocked: { forms: false, meetings: false, inventory: false, contacts: false, [tab]: true } } });
const NOTHING_CHANGES: [string, Plan][] = [
  ["not named (null)", { answer: null }],
  ["the read fails", { error: true }],
  ["the read throws", { throws: true }],
  ["an answer with no blocked map", { answer: { mode: "block", holds: true } }],
  ["the SERVER's answer shape", { answer: { mode: "block", modules: { forms: "hidden", meetings: "hidden", inventory: "hidden" } } }],
  ["a blocked value that is not a boolean", { answer: { mode: "block", holds: true, blocked: { forms: "true", meetings: "true", inventory: "true" } } }],
  ["an unknown mode", { answer: { mode: "enforce", holds: true, blocked: { forms: true, meetings: true, inventory: true } } }],
  ["block, and this tab is not blocked", blocking("contacts")],
  ["report, and this tab is not blocked", blocking("contacts", "report")],
];

// ── the database: canned answers, and a transcript ──────────────────────────────────────────
type World = { tables: Record<string, unknown>; rpc?: Record<string, unknown> };
const NOT_IN_THIS_WORLD = "harness: this world has no such table";
const PLAN_READS = new Set(["access_for_public", "access_for_server", "access_for_portal"]);

async function call(handler: Handler, fn: string, body: Record<string, unknown>, world: World, plan: Plan) {
  const touched: string[] = [];
  const reports: any[] = [];
  let askedPublic = 0;
  const from = (table: string) => {
    if (table !== "app_errors") touched.push(table);
    const q: any = {};
    let op = "select";
    let payload: unknown = null;
    for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle", "contains", "ilike", "match"]) q[m] = () => q;
    for (const m of ["insert", "update", "upsert", "delete"]) q[m] = (row: unknown) => { op = m; payload = row; return q; };
    q.then = (ok: any, bad: any) => Promise.resolve().then(() => {
      if (table === "app_errors") { if (op === "insert") reports.push(payload); return { data: null, error: null }; }
      if (!(table in world.tables)) return { data: null, error: { code: "XX000", message: `${NOT_IN_THIS_WORLD}: ${table}` } };
      if (op !== "select") return { data: null, error: null };
      return { data: world.tables[table], error: null, count: 0 };
    }).then(ok, bad);
    return q;
  };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  stubDb.from = from;
  stubPlanRead.on = !("untouched" in plan);
  stubRpc.rpc = (name: string) => {
    if (name === "access_for_public") {
      askedPublic++;
      if ("throws" in plan) throw new Error("harness: the plan read threw");
      if ("error" in plan) return Promise.resolve({ data: null, error: { code: "42883", message: "function public.access_for_public(text) does not exist" } });
      return Promise.resolve({ data: "answer" in plan ? plan.answer : null, error: null });
    }
    // The server's own plan read (book-public's Customer Hub check asks it): not named.
    if (PLAN_READS.has(name)) return Promise.resolve({ data: null, error: null });
    touched.push(`rpc:${name}`);
    if (world.rpc && name in world.rpc) return Promise.resolve({ data: world.rpc[name], error: null });
    return Promise.resolve({ data: null, error: { code: "XX000", message: `${NOT_IN_THIS_WORLD}: rpc ${name}` } });
  };
  try {
    let status = 0;
    let answer: unknown = null;
    try {
      const res = await handler(new Request(`https://stub.supabase.co/functions/v1/${fn}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "harness/1.0", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify(body),
      }));
      status = res.status;
      const text = await res.text();
      try { answer = JSON.parse(text); } catch { answer = text; }
    } catch (e) {
      // withErrorLog files an unhandled throw and rethrows it; for a transcript that is an answer too.
      answer = `threw: ${(e as Error).message}`;
    }
    return {
      // What a caller could tell apart, and what the handler did to get there.
      transcript: { status, answer, touched },
      status, answer, touched, askedPublic,
      reports: reports.filter((r) => r && r.code === "module_would_refuse"),
    };
  } finally {
    [console.error, console.warn, console.log] = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

/** The whole "nothing changes" claim for one request: every way the plan read can fail to say
 *  "blocked" gives the baseline's transcript, and files nothing. */
async function assertNothingChanges(handler: Handler, fn: string, body: Record<string, unknown>, world: World, asksPlan: boolean) {
  const base = await call(handler, fn, body, world, UNTOUCHED);
  for (const [name, plan] of NOTHING_CHANGES) {
    const r = await call(handler, fn, body, world, plan);
    assertEquals(r.transcript, base.transcript, `${fn} ${body.action}: ${name}`);
    assertEquals(r.reports.length, 0, `${fn} ${body.action}: ${name} filed a report`);
    assertEquals(r.askedPublic, asksPlan ? 1 : 0, `${fn} ${body.action}: ${name}, plan reads`);
  }
  return base;
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// lead-form
// ═════════════════════════════════════════════════════════════════════════════════════════
const TENANT = "acme-sheds";
const FORM_ID = "11111111-1111-4111-8111-111111111111";
const formRow = (over: Record<string, unknown> = {}) => ({
  id: FORM_ID, client_id: TENANT, name: "Get a price", status: "published", published_version: 3,
  published_definition: { fields: [{ id: "full_name", type: "full_name", label: "Your name", required: true }] },
  settings: {}, ...over,
});
const formWorld = (form: unknown): World => ({
  tables: {
    lead_forms: form,
    client_settings: { lead_sms_consent_box: true, business_name: "Acme Sheds" },
    client_configs: { company_name: "Acme Sheds", logo_url: null },
    lead_form_submissions: null,
  },
  rpc: { lead_form_bump: null },
});
const form = (action: string, extra: Record<string, unknown> = {}) => ({ action, clientId: TENANT, formId: FORM_ID, ...extra });

Deno.test("lead-form: with nobody named, load and start answer exactly as before", async () => {
  const loaded = await assertNothingChanges(LEAD_FORM, "lead-form", form("load"), formWorld(formRow()), true);
  assertEquals(loaded.status, 200);
  assertEquals([(loaded.answer as any).ok, (loaded.answer as any).form.id, (loaded.answer as any).branding.companyName], [true, FORM_ID, "Acme Sheds"]);
  assert(loaded.touched.includes("rpc:lead_form_bump"), "a load that is served counts a view");
  const started = await assertNothingChanges(LEAD_FORM, "lead-form", form("start"), formWorld(formRow()), true);
  assertEquals([started.status, started.answer], [200, { ok: true }]);
});

Deno.test("lead-form: block + forms blocked refuses load and start exactly as an unpublished form is refused", async () => {
  const unpublished = await call(LEAD_FORM, "lead-form", form("load"), formWorld(formRow({ status: "draft" })), UNTOUCHED);
  assertEquals([unpublished.status, unpublished.answer], [404, { ok: false, reason: "not_found" }]);
  for (const action of ["load", "start"]) {
    const r = await call(LEAD_FORM, "lead-form", form(action), formWorld(formRow()), blocking("forms"));
    assertEquals([r.status, r.answer], [unpublished.status, unpublished.answer], action);
    // Refused before anything else is read or counted: only the form row itself was touched.
    assertEquals(r.touched, ["lead_forms"], action);
    assertEquals([r.askedPublic, r.reports.length], [1, 0], action);
  }
});

Deno.test("lead-form: report mode refuses nothing, and files what it would have refused once per action", async () => {
  const base = await call(LEAD_FORM, "lead-form", form("load"), formWorld(formRow()), UNTOUCHED);
  const first = await call(LEAD_FORM, "lead-form", form("load"), formWorld(formRow()), blocking("forms", "report"));
  assertEquals(first.transcript, base.transcript);
  assertEquals(first.reports.length, 1);
  const row = first.reports[0];
  assertEquals([row.source, row.severity, row.client_id, row.message], ["edge:lead-form", "info", TENANT, "Report only: load would be refused (needs forms)."]);
  assertEquals(row.context, { action: "load", tabs: ["forms"], surface: "public" });
  const again = await call(LEAD_FORM, "lead-form", form("load"), formWorld(formRow()), blocking("forms", "report"));
  assertEquals([again.transcript, again.reports.length], [base.transcript, 0]);
  const start = await call(LEAD_FORM, "lead-form", form("start"), formWorld(formRow()), blocking("forms", "report"));
  assertEquals([start.status, start.reports.length, start.reports[0]?.context.action], [200, 1, "start"]);
});

Deno.test("lead-form: SUBMIT is never asked about, whatever the plan says", async () => {
  // A submit that fails validation (the required name is missing) answers 422: past the place the
  // plan would be asked, and before anything is written.
  const world = formWorld(formRow());
  const base = await call(LEAD_FORM, "lead-form", form("submit", { answers: {} }), world, UNTOUCHED);
  assertEquals([base.status, (base.answer as any).reason], [422, "invalid"]);
  for (const plan of [blocking("forms"), blocking("forms", "report"), { error: true } as Plan]) {
    const r = await call(LEAD_FORM, "lead-form", form("submit", { answers: {} }), world, plan);
    assertEquals(r.transcript, base.transcript);
    assertEquals([r.askedPublic, r.reports.length], [0, 0]);
  }
  // …and a submit to a form that has closed still gets the closed answer, not a plan refusal.
  const closed = await call(LEAD_FORM, "lead-form", form("submit", { answers: {} }), formWorld(formRow({ settings: { closesAt: "2020-01-01" } })), blocking("forms"));
  assertEquals([closed.status, (closed.answer as any).reason, closed.askedPublic], [410, "closed", 0]);
});

Deno.test("lead-form: a made-up company, a made-up form and an unpublished one never reach the plan read", async () => {
  for (const [name, body, world] of [
    ["a form that does not exist", form("load"), formWorld(null)],
    ["an unpublished form", form("load"), formWorld(formRow({ status: "draft" }))],
    ["a slug that is not a slug", form("load", { clientId: "Not A Slug!" }), formWorld(formRow())],
    ["a form id that is not an id", form("start", { formId: "nope" }), formWorld(formRow())],
  ] as [string, Record<string, unknown>, World][]) {
    const r = await call(LEAD_FORM, "lead-form", body, world, blocking("forms"));
    assertEquals([r.status, r.answer, r.askedPublic], [404, { ok: false, reason: "not_found" }, 0], name);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// book-public
// ═════════════════════════════════════════════════════════════════════════════════════════
const TOKEN = "0123456789abcdef0123456789abcdef";
const bookWorld = (over: Partial<World["tables"]> = {}, page: unknown = { ok: true }): World => ({
  tables: {
    // Non-billable: today's Customer Hub check says yes, so a request gets PAST it.
    client_settings: { internal_account: false, billing_exempt: true },
    billing_plans: [],
    rate_buckets: null,
    // A host who is not taking bookings: availability answers a clean, empty 200.
    meeting_hosts: { id: "h1", user_id: "u1", time_zone: "America/New_York", weekly_hours: {}, accepting: false },
    meeting_types: { id: "t1", duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, min_notice_hours: 1, max_days_ahead: 30, slot_interval_minutes: 30 },
    meetings: {
      id: "m1", client_id: TENANT, host_id: "h1", type_id: "t1", starts_at: "2031-01-06T15:00:00.000Z", ends_at: "2031-01-06T15:30:00.000Z",
      booked_time_zone: "America/New_York", status: "cancelled", customer_name: "Pat Example", reschedule_count: 0,
      meeting_types: { id: "t1", name: "Lot visit", slug: "lot-visit", location_kind: "in_person", location_detail: null },
      meeting_hosts: { id: "h1", user_id: "u1", slug: "sam", public_name: "Sam", time_zone: "America/New_York", accepting: true, active: true },
    },
    ...over,
  },
  rpc: { get_public_booking: page },
});
const avail = { action: "availability", clientId: TENANT, hostSlug: "sam", typeSlug: "lot-visit" };
const book = { action: "book", clientId: TENANT, hostSlug: "sam", typeSlug: "lot-visit" };

Deno.test("book-public: with nobody named, availability and book answer exactly as before", async () => {
  const a = await assertNothingChanges(BOOK_PUBLIC, "book-public", avail, bookWorld(), true);
  assertEquals([a.status, a.answer], [200, { ok: true, accepting: false, timeZone: "America/New_York", days: [] }]);
  // A booking with no name stops at the first thing the handler asks for, past both checks.
  const b = await assertNothingChanges(BOOK_PUBLIC, "book-public", book, bookWorld(), true);
  assertEquals([b.status, b.answer], [400, { ok: false, error: "Tell us your name." }]);
});

Deno.test("book-public: block + meetings blocked refuses availability and book exactly as a switched-off page is refused", async () => {
  const off = await call(BOOK_PUBLIC, "book-public", avail, bookWorld({}, { ok: false, reason: "not_found" }), UNTOUCHED);
  assertEquals([off.status, off.answer], [404, { ok: false, error: "not_found" }]);
  for (const body of [avail, book]) {
    const r = await call(BOOK_PUBLIC, "book-public", body, bookWorld(), blocking("meetings"));
    assertEquals([r.status, r.answer], [off.status, off.answer], body.action);
    // Asked BEFORE the Customer Hub check: nothing after the booking page's own read was touched.
    assertEquals(r.touched, ["rpc:get_public_booking"], body.action);
    assertEquals([r.askedPublic, r.reports.length], [1, 0], body.action);
  }
});

Deno.test("book-public: when the plan does not refuse, today's Customer Hub check still decides", async () => {
  // A company with no Customer Hub (not Non-billable, no subscription): refused today, and still.
  const noHub = bookWorld({ client_settings: { internal_account: false, billing_exempt: false } });
  // (Its own company: a report is filed once per company, function and action for the whole run.)
  const body = { ...avail, clientId: "ridge-co" };
  const base = await call(BOOK_PUBLIC, "book-public", body, noHub, UNTOUCHED);
  assertEquals([base.status, base.answer], [404, { ok: false, error: "not_found" }]);
  assert(base.touched.includes("client_settings"), "that 404 came from the Customer Hub check, not from the page read");
  for (const [plan, filed] of [[blocking("contacts"), 0], [{ answer: null }, 0], [blocking("meetings", "report"), 1]] as [Plan, number][]) {
    const r = await call(BOOK_PUBLIC, "book-public", body, noHub, plan);
    assertEquals(r.transcript, base.transcript);
    // Report mode says what the PLAN would refuse, whatever the older check goes on to answer.
    assertEquals(r.reports.length, filed);
  }
});

Deno.test("book-public: report mode refuses nothing, and files what it would have refused", async () => {
  const base = await call(BOOK_PUBLIC, "book-public", avail, bookWorld(), UNTOUCHED);
  const r = await call(BOOK_PUBLIC, "book-public", avail, bookWorld(), blocking("meetings", "report"));
  assertEquals(r.transcript, base.transcript);
  assertEquals(r.reports.length, 1);
  assertEquals([r.reports[0].source, r.reports[0].severity, r.reports[0].message], ["edge:book-public", "info", "Report only: availability would be refused (needs meetings)."]);
  assertEquals(r.reports[0].context, { action: "availability", tabs: ["meetings"], surface: "public" });
});

Deno.test("book-public: a booking read, moved or cancelled by its token is never asked about", async () => {
  for (const action of ["lookup", "reschedule", "cancel"]) {
    const body = { action, token: TOKEN };
    const base = await call(BOOK_PUBLIC, "book-public", body, bookWorld(), UNTOUCHED);
    assert(base.status === 200 || base.status === 409, `${action}: the token found its booking (${base.status} ${JSON.stringify(base.answer)})`);
    for (const plan of [blocking("meetings"), blocking("meetings", "report"), { throws: true } as Plan]) {
      const r = await call(BOOK_PUBLIC, "book-public", body, bookWorld(), plan);
      assertEquals(r.transcript, base.transcript, action);
      assertEquals([r.askedPublic, r.reports.length], [0, 0], action);
    }
  }
});

Deno.test("book-public: a made-up company or host never reaches the plan read", async () => {
  for (const [name, body, world] of [
    ["the booking page says not_found", avail, bookWorld({}, { ok: false, reason: "not_found" })],
    ["the booking page answers nothing", book, bookWorld({}, null)],
    ["a slug that is not a slug", { ...avail, clientId: "Not A Slug!" }, bookWorld()],
    ["a host that is not a slug", { ...avail, hostSlug: "../etc" }, bookWorld()],
  ] as [string, Record<string, unknown>, World][]) {
    const r = await call(BOOK_PUBLIC, "book-public", body, world, blocking("meetings"));
    assertEquals([r.status, r.answer, r.askedPublic], [404, { ok: false, error: "not_found" }, 0], name);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// shop-checkout
// ═════════════════════════════════════════════════════════════════════════════════════════
const UNIT = "22222222-2222-4222-8222-222222222222";
const shopWorld = (over: Partial<World["tables"]> = {}): World => ({
  tables: {
    rate_buckets: null,
    shop_settings: { client_id: TENANT, enabled: true, hide_all_prices: false, deposit_mode: "percent", deposit_value: 10, allow_pay_in_full: true },
    client_settings: { ss_tax_rate: null, ss_tax_label: null, ss_tax_delivery: null, business_name: "Acme Sheds" },
    client_configs: { company_name: "Acme Sheds" },
    // The building in the cart has since been taken off the lot: a clean answer with no pricing maths.
    inventory_units: [],
    building_styles: [],
    ...over,
  },
});
const cart = (action?: string, extra: Record<string, unknown> = {}) => ({ ...(action ? { action } : {}), clientId: TENANT, unitIds: [UNIT], ...extra });
const SHOP_GONE = { error: "This shop isn't available right now." };

Deno.test("shop-checkout: with nobody named, pricing a cart answers exactly as before", async () => {
  const p = await assertNothingChanges(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld(), true);
  assertEquals(p.status, 200);
  assertEquals([(p.answer as any).ok, (p.answer as any).items, (p.answer as any).problems], [true, [], [{ unitId: UNIT, reason: "no_longer_listed" }]]);
  // No action at all is a price too.
  const bare = await assertNothingChanges(SHOP_CHECKOUT, "shop-checkout", cart(), shopWorld(), true);
  assertEquals(bare.transcript, p.transcript);
});

Deno.test("shop-checkout: block + inventory blocked refuses a price exactly as a switched-off shop is refused", async () => {
  const off = await call(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld({ shop_settings: { client_id: TENANT, enabled: false } }), UNTOUCHED);
  assertEquals([off.status, off.answer], [404, SHOP_GONE]);
  const r = await call(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld(), blocking("inventory"));
  assertEquals([r.status, r.answer], [off.status, off.answer]);
  assert(!r.touched.includes("inventory_units"), "refused before any building is read");
  assertEquals([r.askedPublic, r.reports.length], [1, 0]);
  // It reads as "off", not as "prices hidden": the plan is asked before the hide-all-prices answer.
  const hidden = await call(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld({ shop_settings: { client_id: TENANT, enabled: true, hide_all_prices: true } }), blocking("inventory"));
  assertEquals([hidden.status, hidden.answer], [404, SHOP_GONE]);
});

Deno.test("shop-checkout: report mode refuses nothing, and files what it would have refused", async () => {
  const base = await call(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld(), UNTOUCHED);
  const r = await call(SHOP_CHECKOUT, "shop-checkout", cart("price"), shopWorld(), blocking("inventory", "report"));
  assertEquals(r.transcript, base.transcript);
  assertEquals(r.reports.length, 1);
  assertEquals([r.reports[0].source, r.reports[0].severity, r.reports[0].message], ["edge:shop-checkout", "info", "Report only: price would be refused (needs inventory)."]);
  assertEquals(r.reports[0].context, { action: "price", tabs: ["inventory"], surface: "public" });
});

Deno.test("shop-checkout: a purchase request, a card payment and pay_setup are never asked about", async () => {
  for (const body of [cart("request", { name: "Pat Example", phone: "555-0100" }), cart("purchase", { name: "Pat Example" }), { action: "pay_setup", clientId: TENANT }]) {
    const base = await call(SHOP_CHECKOUT, "shop-checkout", body, shopWorld(), UNTOUCHED);
    assert(base.status !== 404, `${body.action}: this world's shop is open (${base.status} ${JSON.stringify(base.answer)})`);
    for (const plan of [blocking("inventory"), blocking("inventory", "report"), { error: true } as Plan]) {
      const r = await call(SHOP_CHECKOUT, "shop-checkout", body, shopWorld(), plan);
      assertEquals(r.transcript, base.transcript, String(body.action));
      assertEquals([r.askedPublic, r.reports.length], [0, 0], String(body.action));
    }
  }
});

Deno.test("shop-checkout: a made-up company and a shop that is off never reach the plan read", async () => {
  for (const [name, body, world, want] of [
    ["no shop row", cart("price"), shopWorld({ shop_settings: null }), SHOP_GONE],
    ["a shop that is off", cart("price"), shopWorld({ shop_settings: { client_id: TENANT, enabled: false } }), SHOP_GONE],
    ["a company with no config row", cart("price"), shopWorld({ client_configs: null }), SHOP_GONE],
    ["a slug that is not a slug", cart("price", { clientId: "Not A Slug!" }), shopWorld(), { error: "Unknown builder." }],
  ] as [string, Record<string, unknown>, World, unknown][]) {
    const r = await call(SHOP_CHECKOUT, "shop-checkout", body, world, blocking("inventory"));
    assertEquals([r.status, r.answer, r.askedPublic], [404, want, 0], name);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The wiring itself, read from the source
// ═════════════════════════════════════════════════════════════════════════════════════════
// The driven tests above prove today's actions. This pins the SHAPE, so an action added later (or a
// guard loosened) cannot quietly put something a customer already did behind a plan.
const source = async (fn: string) => (await Deno.readTextFile(new URL(`../../${fn}/index.ts`, import.meta.url))).replace(/\r/g, "");
const callsOf = (src: string) => src.split("\n").filter((l) => l.includes("publicVerdict(") && !l.trim().startsWith("//") && !l.trim().startsWith("import "));

Deno.test("wiring: each function asks the plan in exactly one place, behind a list of the actions that start something", async () => {
  const lead = await source("lead-form");
  assertEquals(callsOf(lead), ['  if ((action === "load" || action === "start") && await publicVerdict(sb, clientId, "lead-form", action, "forms", req) === "refuse") {']);
  const book = await source("book-public");
  assertEquals(callsOf(book), ['    if (await publicVerdict(admin, clientId, "book-public", action, "meetings", req) === "refuse") {']);
  const shop = await source("shop-checkout");
  assertEquals(callsOf(shop), ['  if (action === "price" && await publicVerdict(admin, clientId, "shop-checkout", "price", "inventory", req) === "refuse") {']);
});

Deno.test("wiring: the question comes after the company is proven and before the next thing is read", async () => {
  const order = (src: string, marks: string[]) => {
    const at = marks.map((m) => src.indexOf(m));
    assert(at.every((i) => i >= 0), `a marker moved: ${marks[at.findIndex((i) => i < 0)]}`);
    assertEquals([...at].sort((a, b) => a - b), at, "the order changed");
  };
  order(await source("lead-form"), [
    'if (!form || form.status !== "published" || !form.published_definition) return json({ ok: false, reason: "not_found" }, 404);',
    'publicVerdict(sb, clientId, "lead-form"',
    "const def = cleanDefinition(form.published_definition, SB_URL);",
    'if (closed) return json({ ok: false, reason: "closed"',
  ]);
  order(await source("book-public"), [
    'if (!page || page.ok !== true) return json({ ok: false, error: "not_found" }, 404);',
    '  if (action === "availability" || action === "book") {\n    // PLANS AS DATA',
    'publicVerdict(admin, clientId, "book-public"',
    'crmOn = await hasPaidFeature(admin, clientId, "crm");',
    "  switch (action) {",
    '    case "lookup":\n    case "reschedule":\n    case "cancel": {',
  ]);
  order(await source("shop-checkout"), [
    '  if (action === "pay_setup") {',
    "if (!shop?.enabled || !cfg) return json({ error: \"This shop isn't available right now.\" }, 404);",
    'publicVerdict(admin, clientId, "shop-checkout"',
    'if (shop.hide_all_prices) return json(',
    '  if (action === "purchase") {',
  ]);
});

Deno.test("wiring: the token branch of book-public, and the submit, request and purchase paths, hold no plan question", async () => {
  const book = await source("book-public");
  const tokens = book.slice(book.indexOf('    case "lookup":\n    case "reschedule":\n    case "cancel": {'));
  assert(tokens.length > 500 && !tokens.includes("publicVerdict") && !tokens.includes("publicAccess"), "the token branch must not ask the plan");
  const lead = await source("lead-form");
  const submit = lead.slice(lead.indexOf('if (closed) return json({ ok: false, reason: "closed"'));
  assert(submit.length > 500 && !submit.includes("publicVerdict") && !submit.includes("publicAccess"), "submit must not ask the plan");
  const shop = await source("shop-checkout");
  const beforeHandler = shop.slice(0, shop.indexOf('Deno.serve(withErrorLog("shop-checkout"'));
  assert(beforeHandler.includes("async function purchase(") && beforeHandler.includes("async function payReady("), "purchase and payReady live above the handler");
  assertEquals(callsOf(beforeHandler), [], "purchase, payReady and the builder's email must not ask the plan");
  const afterPrice = shop.slice(shop.indexOf('  if (action === "price") return json(priced);'));
  assert(afterPrice.length > 500 && !afterPrice.includes("publicVerdict"), "the request path must not ask the plan");
});
