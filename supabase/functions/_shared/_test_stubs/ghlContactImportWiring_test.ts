// portal-settings' crm_import_ghl_contacts (migration 282), driven through the SHIPPED handler:
// CSM Synergy's own GoHighLevel contacts into its own CRM, contacts only, a dry run first.
//
// _shared/ghlContactImport.test.ts pins the GoHighLevel walk and tests/sql/migration282.test.cjs the
// database function. This file pins what only the handler decides:
//   1. WHO: an operator who can write (an app_operators member on their own tenant, or an operator
//      in view-as), never a plain owner, a support-only or a read-only operator, never a caller
//      limited to their own customers; and only on our own account (internal_account). Every
//      refusal happens before GoHighLevel is called and before the database function runs.
//   2. A DRY RUN unless the body says dryRun: false; the real run's audit row is written before the
//      first GoHighLevel request, and no audit means no import. A real run handed a dry run's cursor
//      is refused before any of that.
//   3. THE KEY AND THE LOCATION are the tenant's own, read server-side; nothing but POST
//      /contacts/search is ever called (the fake throws on anything else, writes included).
//   4. COUNTS ONLY in the answer and in every row it logs: a GoHighLevel refusal and a database
//      failure are logged by code and counts, never by a contact or by Postgres's own message.
//   5. Before migration 282 is applied: a plain "not installed yet", marked as a refusal.
//
// HOW. paperworkDefaultWiring_test's idiom: Deno.serve is stubbed while index.ts is imported, so a
// request runs through withErrorLog, resolveTenant and every step as it does live. The import map
// swaps supabase-js for supabase_stub.ts, whose stubDb / stubRpc route every table and rpc call into
// the fakes below, and fetch answers GoHighLevel from _test_stubs/ghlFake.ts. No --allow-net is
// granted, so nothing leaves the box.
//
// Tenants, people, keys and numbers are made up (555-01xx numbers, example domains). The repo is
// public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import { type FakeContact, ghlFake, type GhlWorld } from "./ghlFake.ts";
import { DRY_RUN_CURSOR_SENTENCE, encodeCursor } from "../ghlContactImport.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
async function captureHandler(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const HANDLER = await captureHandler("../../portal-settings/index.ts");
const SRC = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));

const OURS = "acme-platform";      // plays CSM Synergy's own tenant (internal_account)
const BUILDER = "acme-sheds";      // a customer tenant
const USER = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

type Settings = { internal_account: boolean; billing_exempt: boolean; ghl_location_id: string | null; ghl_api_key: string | null };
const SETTINGS: Record<string, Settings> = {
  [OURS]: { internal_account: true, billing_exempt: false, ghl_location_id: "loc-ours", ghl_api_key: "key-ours" },
  // Billing-exempt, so the CRM subscription check lets it through and the account check is what refuses.
  [BUILDER]: { internal_account: false, billing_exempt: true, ghl_location_id: "loc-builder", ghl_api_key: "key-builder" },
};

type World = {
  /** The caller's own client_users row (null: none, a platform operator). */
  member: { client_id: string; role: string; title: string | null; access: unknown } | null;
  /** The caller's app_operators row (null: not an operator). */
  operatorRow: { can_write: boolean; can_bill?: boolean; support_only: boolean } | null;
  settings?: Record<string, Settings>;
  auditFails?: boolean;
  /** What the database function answers for a page (default: every row new). */
  rpc?: (args: any) => { data: unknown; error: unknown };
};

type Trace = {
  events: string[];
  rpc: any[];
  audits: any[];
  errors: any[];
  settingsReads: string[];
};

function chain(w: World, t: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(w, t, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const has = (op: string) => ops.some((o) => o[0] === op);
    const arg = (op: string, i = 1) => (ops.find((o) => o[0] === op) ?? [])[i];
    const eqVal = (col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
    const single = has("maybeSingle") || has("single");
    const answer = () => {
      if (table === "app_errors") { t.errors.push(arg("insert")); return { data: null, error: null }; }
      if (table === "admin_audit") {
        const row = arg("insert");
        t.events.push(`audit:${row?.action}`);
        if (w.auditFails) return { data: null, error: { message: "audit table unavailable" } };
        t.audits.push(row);
        return { data: null, error: null };
      }
      if (table === "client_users") {
        return { data: w.member ? [{ user_id: USER, ...w.member, prefs: null, location_id: null }] : [], error: null };
      }
      if (table === "app_operators") {
        return { data: w.operatorRow ? { user_id: USER, email: "ops@platform.test", can_bill: false, ...w.operatorRow } : null, error: null };
      }
      if (table === "client_configs") {
        const id = eqVal("client_id");
        return { data: (w.settings ?? SETTINGS)[id] ? { client_id: id } : null, error: null };
      }
      if (table === "client_settings") {
        const cols = String(arg("select") ?? "");
        t.settingsReads.push(cols);
        const row = (w.settings ?? SETTINGS)[eqVal("client_id")] ?? null;
        return { data: row, error: null };
      }
      // billing_plans, billing_subscriptions, and anything else: empty.
      return { data: single ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

const contacts = (n: number): FakeContact[] => Array.from({ length: n }, (_v, i) => ({
  id: `c-${i}`, firstName: "Customer", lastName: `Person${i}`, phone: `+1555010${String(1000 + i).slice(-4)}`,
  email: `customer${i}@example.com`, tags: ["lead"], dateAdded: "2024-01-02T03:04:05Z",
}));

async function call(w: World, body: Record<string, unknown>, ghl: Partial<GhlWorld> = { contacts: contacts(3) }) {
  const t: Trace = { events: [], rpc: [], audits: [], errors: [], settingsReads: [] };
  const fake = ghlFake({ estimates: [], opportunities: [], ...ghl });
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER, email: "ops@platform.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(w, t, table, []);
  stubRpc.rpc = (fn: string, args: any) => {
    if (fn !== "crm_import_ghl_contacts") return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    t.events.push("rpc");
    t.rpc.push(args);
    const a = w.rpc ? w.rpc(args) : {
      data: {
        dry_run: args.p_dry_run, rows: args.p_rows.length, created: args.p_rows.length, matched: 0, no_identity: 0, conflicts: 0,
        labelled: args.p_rows.length, opted_out: args.p_rows.filter((r: any) => r.sms_dnd && r.phone).length, split: 0,
      },
      error: null,
    };
    return Promise.resolve(a);
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://services.leadconnectorhq.com/")) {
      t.events.push("ghl");
      return fake.fetch(input, init);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "crm_import_ghl_contacts", ...body }),
    }));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, headers: res.headers, t, fake };
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

/** One of our own people: owner of our own tenant and a platform operator who can write. */
const OUR_OPERATOR: World = { member: { client_id: OURS, role: "owner", title: null, access: null }, operatorRow: { can_write: true, support_only: false } };
const LEAK = /Customer|Person\d|example\.com|\+1555|lead"/;

Deno.test("an operator on our own account: a dry run by default, counts only, through the tenant's own key", async () => {
  const { status, body, text, t, fake } = await call(OUR_OPERATOR, {});
  assertEquals(status, 200, text);
  assertEquals([body.ok, body.dryRun, body.done, body.stopped, body.cursor, body.pages], [true, true, true, "end", null, 1]);
  assertEquals(body.counts, { fetched: 3, created: 3, matched: 0, noIdentity: 0, conflicts: 0, labelled: 3, optedOut: 0, split: 0, repeats: 0, smsDnd: 0 });
  assert(/^Dry run, nothing was saved\. 3 GoHighLevel contacts read/.test(body.message), body.message);
  assert(!LEAK.test(text), `the answer carries no contact: ${text}`);

  assertEquals(t.rpc.length, 1);
  assertEquals([t.rpc[0].p_client_id, t.rpc[0].p_dry_run], [OURS, true]);
  assertEquals(Object.keys(t.rpc[0].p_rows[0]), ["name", "phone", "email", "tags", "added_at", "sms_dnd"], "only the six fields the function takes");
  assertEquals(fake.trace.calls, ["POST /contacts/search"], "nothing but the contact search");
  assertEquals([fake.trace.contactSearches[0].auth, fake.trace.contactSearches[0].body.locationId], ["Bearer key-ours", "loc-ours"]);

  assertEquals(t.audits.map((a) => a.action), ["crm_import_ghl_contacts"], "a dry run is recorded, best-effort, and has no start row");
  assert(/^dry_run=true stopped=end pages=1 fetched=3 created=3 /.test(t.audits[0].note), t.audits[0].note);
  assert(!LEAK.test(JSON.stringify(t.audits)), "the audit row carries numbers only");
  assertEquals(t.errors.length, 0, "nothing logged");
});

Deno.test("GoHighLevel's do-not-disturb rides to the database, and its opt-outs come back as a count", async () => {
  const dnd = contacts(3).map((c, i) => (i === 1 ? { ...c, dndSettings: { SMS: { status: "active" } } } : c));
  const { status, body, text, t } = await call(OUR_OPERATOR, { dryRun: false }, { contacts: dnd });
  assertEquals(status, 200, text);
  assertEquals(t.rpc[0].p_rows.map((r: any) => r.sms_dnd), [false, true, false]);
  assertEquals([body.counts.smsDnd, body.counts.optedOut], [1, 1]);
  assert(/ 1 marked do not text\./.test(body.message), body.message);
  assert(/ opted_out=1 split=0 /.test(t.audits.at(-1).note), t.audits.at(-1).note);
  assert(!LEAK.test(text) && !LEAK.test(JSON.stringify(t.audits)), "still counts only");
});

Deno.test("dryRun: false runs it for real, and its audit row is written before GoHighLevel is asked", async () => {
  const { status, body, t } = await call(OUR_OPERATOR, { dryRun: false });
  assertEquals(status, 200);
  assertEquals([body.dryRun, body.done], [false, true]);
  assertEquals(t.rpc.map((r) => r.p_dry_run), [false]);
  assertEquals(t.events, ["audit:crm_import_ghl_contacts_start", "ghl", "rpc", "audit:crm_import_ghl_contacts"]);
  assert(/^Imported\. 3 GoHighLevel contacts read/.test(body.message), body.message);
  for (const v of ["false", 0, null, "no"]) {
    const again = await call(OUR_OPERATOR, { dryRun: v });
    assertEquals(again.t.rpc.map((r) => r.p_dry_run), [true], `dryRun ${JSON.stringify(v)} is still a dry run`);
  }
});

Deno.test("no audit, no import: a real run whose start cannot be recorded never reaches GoHighLevel", async () => {
  const { status, body, t } = await call({ ...OUR_OPERATOR, auditFails: true }, { dryRun: false });
  assertEquals(status, 500);
  assert(/record who started the import/.test(body.error), body.error);
  assertEquals([t.events.filter((e) => e === "ghl").length, t.rpc.length], [0, 0]);
});

Deno.test("who may run it: never a plain owner, a support-only or a read-only operator, never someone limited to their own customers", async () => {
  const cases: [string, World, RegExp, number][] = [
    ["the owner of our own account who is not an operator", { member: OUR_OPERATOR.member, operatorRow: null }, /done by Structure Studio staff/, 403],
    ["a support-only operator", { member: OUR_OPERATOR.member, operatorRow: { can_write: true, support_only: true } }, /done by Structure Studio staff/, 403],
    ["a read-only operator", { member: OUR_OPERATOR.member, operatorRow: { can_write: false, support_only: false } }, /done by Structure Studio staff/, 403],
    ["an operator limited to their own customers", {
      member: { client_id: OURS, role: "user", title: "sales_rep", access: { contacts: "own" } }, operatorRow: { can_write: true, support_only: false },
    }, /covers the whole business/, 403],
  ];
  for (const [label, w, re, code] of cases) {
    for (const dryRun of [undefined, false]) {
      const { status, body, t } = await call(w, dryRun === undefined ? {} : { dryRun });
      assertEquals(status, code, `${label}: ${JSON.stringify(body)}`);
      assert(re.test(String(body.error)), `${label}: ${body.error}`);
      assertEquals([t.events.filter((e) => e === "ghl").length, t.rpc.length], [0, 0], `${label}: GoHighLevel and the database are never reached`);
      assert(!t.settingsReads.some((c) => c.includes("ghl_api_key")), `${label}: the key is never read`);
    }
  }
});

Deno.test("only on our own account: an operator viewing as a builder is refused before anything is read", async () => {
  const platformOperator: World = { member: null, operatorRow: { can_write: true, support_only: false } };
  const builder = await call(platformOperator, { targetClientId: BUILDER });
  assertEquals(builder.status, 403, JSON.stringify(builder.body));
  assert(/only for Structure Studio's own account/.test(builder.body.error), builder.body.error);
  assertEquals([builder.t.events.filter((e) => e === "ghl").length, builder.t.rpc.length], [0, 0]);
  assert(!builder.t.settingsReads.some((c) => c.includes("ghl_api_key")), "the builder's key is never read");

  const ours = await call(platformOperator, { targetClientId: OURS });
  assertEquals([ours.status, ours.body.dryRun, ours.t.rpc[0]?.p_client_id], [200, true, OURS], JSON.stringify(ours.body));

  const support = await call({ member: null, operatorRow: { can_write: true, support_only: true } }, { targetClientId: OURS });
  assertEquals(support.status, 403, "a support-only operator in view-as is refused too");
});

Deno.test("our account with no GoHighLevel connection: a sentence, nothing called", async () => {
  const settings = { ...SETTINGS, [OURS]: { ...SETTINGS[OURS], ghl_api_key: null } };
  const { status, body, t } = await call({ ...OUR_OPERATOR, settings }, {});
  assertEquals(status, 409);
  assert(/isn't connected to GoHighLevel/.test(body.error), body.error);
  assertEquals([t.events.filter((e) => e === "ghl").length, t.rpc.length], [0, 0]);
});

Deno.test("a bad cursor is refused; a good one resumes where it says", async () => {
  const bad = await call(OUR_OPERATOR, { cursor: "not-a-cursor!" });
  assertEquals(bad.status, 400);
  assert(/import position isn't valid/.test(bad.body.error), bad.body.error);
  assertEquals(bad.t.events.filter((e) => e === "ghl").length, 0);

  const resumed = await call(OUR_OPERATOR, { cursor: encodeCursor({ after: [1700000000001, "c-1"] }, true) });
  assertEquals(resumed.status, 200);
  assertEquals(resumed.fake.trace.contactSearches[0].body.searchAfter, [1700000000001, "c-1"]);
  assertEquals(resumed.body.counts.fetched, 1, "only the contact after c-1");
});

Deno.test("a real run refuses a dry run's cursor: 400, before the key, the start row, GoHighLevel or the database", async () => {
  const dryCursor = encodeCursor({ after: [1700000000001, "c-1"] }, true);
  const { status, body, t } = await call(OUR_OPERATOR, { dryRun: false, cursor: dryCursor });
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, DRY_RUN_CURSOR_SENTENCE);
  assertEquals([t.events.filter((e) => e === "ghl").length, t.rpc.length, t.audits.length], [0, 0, 0], "nothing called, nothing recorded");
  assert(!t.settingsReads.some((c) => c.includes("ghl_api_key")), "the key is never read");

  // The real run's own cursor carries the real run on.
  const realCursor = encodeCursor({ after: [1700000000001, "c-1"] }, false);
  const ok = await call(OUR_OPERATOR, { dryRun: false, cursor: realCursor });
  assertEquals([ok.status, ok.body.dryRun, ok.body.counts.fetched], [200, false, 1], JSON.stringify(ok.body));
  assertEquals(ok.t.audits[0].note, "dry_run=false resume=yes");
});

Deno.test("before migration 282: \"not installed yet\", marked as a refusal, nothing written", async () => {
  const w: World = { ...OUR_OPERATOR, rpc: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.crm_import_ghl_contacts" } }) };
  const { status, body, headers, t } = await call(w, {});
  assertEquals(status, 503);
  assertEquals(body.error, "The contact import isn't installed on this server yet.");
  assertEquals(headers.get("x-ss-refusal"), "1");
  assertEquals(t.rpc.length, 1, "one page tried, then it stops");
});

Deno.test("GoHighLevel refusing the key: 502, one row by code and counts, the cursor to carry on", async () => {
  const { status, body, text, t } = await call(OUR_OPERATOR, {}, { contacts: contacts(150), failContacts: { from: 1, count: 1, status: 401 } });
  assertEquals(status, 502, text);
  assertEquals([body.ok, body.stopped, body.ghlStatus, body.pages, body.counts.fetched], [false, "ghl_auth", 401, 1, 100]);
  assert(typeof body.cursor === "string" && body.cursor.length > 0, "a cursor");
  assert(/refused this account's API key/.test(body.error), body.error);
  assertEquals(t.errors.length, 1, "exactly one row: the wrapper does not file a second");
  assertEquals([t.errors[0].code, t.errors[0].severity, t.errors[0].client_id], ["ghl_import_ghl_auth", "warn", OURS]);
  assert(!LEAK.test(JSON.stringify(t.errors)) && !LEAK.test(text), "counts only, in the row and the answer");
});

Deno.test("a page the database refuses: 500, logged by its code, never by Postgres's message", async () => {
  const w: World = {
    ...OUR_OPERATOR,
    rpc: () => ({ data: null, error: { code: "23514", message: 'new row violates check constraint', details: "Failing row contains (Customer Person0, +15550101000, customer0@example.com)" } }),
  };
  const { status, body, text, t } = await call(w, { dryRun: false });
  assertEquals(status, 500, text);
  assertEquals([body.stopped, body.done, body.pages, body.counts.created], ["database", false, 0, 0]);
  assert(typeof body.cursor === "string", "the cursor of the page that failed");
  assertEquals(t.errors.length, 1);
  assertEquals([t.errors[0].code, t.errors[0].severity, t.errors[0].context.pgCode], ["ghl_import_database", "error", "23514"]);
  assert(!LEAK.test(JSON.stringify(t.errors)) && !/violates|Failing row/.test(JSON.stringify(t.errors)), JSON.stringify(t.errors));
  assert(!LEAK.test(text) && !/Failing row/.test(text), text);
});

Deno.test("the gate line and the row scope are what the branch's comment says", () => {
  assert(/\n\s{2}crm_import_ghl_contacts: \{ area: "contacts", level: "edit" \},/.test(SRC), "GATES: contacts:'edit' (the floor)");
  assert(/\n\s{4}crm_import_ghl_contacts: \{ tenantWide: true \},/.test(SRC), "CONTACT_ROW_SCOPE: tenantWide");
});
