// portal-settings' crm_import_leads (migration 381), driven through the SHIPPED handler: one page of
// a spreadsheet of leads into contacts and deals.
//
// _shared/leadImport.test.ts pins the sheet rules and tests/sql/migration381.test.cjs the database
// function. This file pins what only the handler decides:
//   1. WHO: contacts at edit, and the Customer Hub subscription (the crm_ prefix); a tenant without it
//      is refused before the database function runs.
//   2. A DRY RUN unless the body says dryRun: false. A real page writes its audit row FIRST, and no
//      audit means no import.
//   3. SOMEONE LIMITED TO THEIR OWN CUSTOMERS owns everything they import and never writes onto a
//      contact they cannot see: force_owner, viewer and default_owner are them, and every row's
//      owner is overwritten, whatever the browser sent.
//   4. CUSTOM VALUES are checked against the builder's real fields; one that doesn't fit is left off
//      with a warning, and the rest of the page still goes.
//   5. COUNTS ONLY in the answer and the audit line; the database's own refusals become sentences.
//   6. Before migration 381 is applied: a plain "not installed yet", marked as a refusal.
//
// HOW. ghlContactImportWiring_test's idiom: Deno.serve is stubbed while index.ts is imported, so a
// request runs through withErrorLog, resolveTenant and every step as it does live; supabase-js is
// swapped for supabase_stub.ts by the import map. No --allow-net: nothing leaves the box.
//
// Tenants, people and numbers are made up (555-01xx, example.invalid). The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

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

const BUILDER = "acme-sheds";     // pays for the Customer Hub (billing_exempt here)
const UNPAID = "bravo-barns";     // does not
const USER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const PIPE = "00000000-0000-4000-8000-0000000000e1";
const STAGE = "00000000-0000-4000-8000-0000000000f1";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = { SUPABASE_URL: PROJECT, SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
const SETTINGS: Record<string, { internal_account: boolean; billing_exempt: boolean }> = {
  [BUILDER]: { internal_account: false, billing_exempt: true },
  [UNPAID]: { internal_account: false, billing_exempt: false },
};

type World = {
  member: { client_id: string; role: string; title: string | null; access: unknown };
  auditFails?: boolean;
  fieldDefs?: Record<string, any[]>;
  rpc?: (args: any) => { data: unknown; error: unknown };
};
type Trace = { events: string[]; rpc: any[]; audits: any[]; errors: any[] };

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
      if (table === "client_users") return { data: [{ user_id: USER, ...w.member, prefs: null, location_id: null }], error: null };
      if (table === "app_operators") return { data: null, error: null };
      if (table === "client_configs") return { data: SETTINGS[eqVal("client_id")] ? { client_id: eqVal("client_id") } : null, error: null };
      if (table === "client_settings") return { data: SETTINGS[eqVal("client_id")] ?? null, error: null };
      if (table === "crm_field_defs") {
        t.events.push(`fields:${eqVal("entity")}`);
        return { data: (w.fieldDefs ?? {})[eqVal("entity")] ?? [], error: null };
      }
      return { data: single ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

const ANSWER = (args: any) => ({
  data: {
    dry_run: args.p_dry_run, rows: args.p_rows.length, contacts_created: args.p_rows.length - 1, contacts_matched: 1,
    matched_skipped: 0, deals_created: args.p_rows.length, already_in_pipeline: 0, not_yours: 0, no_identity: 0, no_name: 0,
    conflicts: 0, notes_added: 0, labelled: 0, people_added: 0, opted_out: 0, refused: [{ row: 9, code: "not_yours", name: "dropped" }],
  },
  error: null,
});

async function call(w: World, body: Record<string, unknown>, tenant = BUILDER) {
  const t: Trace = { events: [], rpc: [], audits: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: USER, email: "owner@example.invalid" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain({ ...w, member: { ...w.member, client_id: tenant } }, t, table, []);
  stubRpc.rpc = (fn: string, args: any) => {
    if (fn !== "crm_import_leads") return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    t.events.push("rpc");
    t.rpc.push(args);
    return Promise.resolve((w.rpc ?? ANSWER)(args));
  };
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "crm_import_leads", ...body }),
    }));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, headers: res.headers, t };
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

const OWNER: World = { member: { client_id: BUILDER, role: "owner", title: "owner", access: null } };
const REP_OWN: World = { member: { client_id: BUILDER, role: "user", title: "sales_rep", access: { contacts: "own" } } };
const ROWS = [
  { row: 2, name: "Pat Example", phone: "(555) 010-0101", email: "pat@example.invalid", owner: OTHER, stage: STAGE, labels: ["hot"] },
  { row: 3, company: "Acme Barns", email: "acme@example.invalid", note: "Called once" },
];
const LEAK = /Pat|Acme|example\.invalid|555|hot|Called/;

Deno.test("an owner: a dry run by default, one database call, counts and row numbers only", async () => {
  const { status, body, text, t } = await call(OWNER, { pipelineId: PIPE, defaultStageId: STAGE, rows: ROWS });
  assertEquals(status, 200, text);
  assertEquals([body.ok, body.dryRun, body.rows, body.contacts_created, body.contacts_matched, body.deals_created], [true, true, 2, 1, 1, 2]);
  assertEquals(body.refused, [{ row: 9, code: "not_yours" }], "a refusal is a row and a code, whatever else the database sent");
  assertEquals(body.warnings, []);
  assertEquals(t.rpc.length, 1);
  const a = t.rpc[0];
  assertEquals([a.p_client_id, a.p_dry_run, a.p_actor], [BUILDER, true, USER]);
  assertEquals(a.p_opts, { pipeline: PIPE, default_stage: STAGE, on_match: "attach", default_owner: null, force_owner: null, viewer: null });
  assertEquals(a.p_rows[0].owner, OTHER, "an owner who may assign keeps the row's owner (the database checks the team)");
  assert(!t.events.includes("audit:crm_import_leads_page"), "a dry run writes no start row");
  assert(!LEAK.test(text), `the answer carries nothing from a row: ${text}`);
  const line = t.audits.find((r) => r.action === "crm_import_leads");
  assert(line, "the page is audited");
  // The row's actor_email is the signed-in person, which is what an audit row is for; the NOTE is ours.
  assert(!LEAK.test(String(line.note)), `the audit note carries nothing from a row: ${line.note}`);
  assert(/dry_run=true .*created=1 .*deals=2/.test(String(line.note)), String(line.note));
});

Deno.test("a real page: the audit row is written first, and no audit means no import", async () => {
  const ok = await call(OWNER, { dryRun: false, pipelineId: PIPE, rows: ROWS, page: 2, pages: 3 });
  assertEquals(ok.status, 200, ok.text);
  assertEquals(ok.body.dryRun, false);
  const at = ok.t.events.indexOf("audit:crm_import_leads_page");
  assert(at >= 0 && at < ok.t.events.indexOf("rpc"), `the start row comes before the import: ${ok.t.events}`);
  assert(/page=2\/3/.test(JSON.stringify(ok.t.audits)), "the page number is in the audit");
  const failed = await call({ ...OWNER, auditFails: true }, { dryRun: false, pipelineId: PIPE, rows: ROWS });
  assert(failed.status >= 500, `an unrecordable import is refused: ${failed.status} ${failed.text}`);
  assertEquals(failed.t.rpc.length, 0, "and nothing was imported");
});

Deno.test("someone limited to their own customers owns all of it and is the viewer", async () => {
  const { status, text, t } = await call(REP_OWN, { dryRun: false, pipelineId: PIPE, defaultOwnerUserId: OTHER, rows: ROWS });
  assertEquals(status, 200, text);
  const a = t.rpc[0];
  assertEquals([a.p_opts.force_owner, a.p_opts.viewer, a.p_opts.default_owner], [USER, USER, USER]);
  assertEquals(a.p_rows.map((r: any) => r.owner), [USER, USER], "every row's owner is overwritten");
});

Deno.test("refused before the database: a bad request, too many rows, no Customer Hub", async () => {
  const many = Array.from({ length: 201 }, (_v, i) => ({ row: i + 2, name: "x", phone: "5550100101" }));
  for (const [body, has] of [
    [{ pipelineId: PIPE, rows: many }, "at most 200"],
    [{ pipelineId: "board", rows: ROWS }, "pipeline"],
    [{ pipelineId: PIPE, rows: [] }, "no rows"],
    [{ pipelineId: PIPE, onMatch: "overwrite", rows: ROWS }, "already in Contacts"],
  ] as [Record<string, unknown>, string][]) {
    const r = await call(OWNER, body);
    assertEquals(r.status, 400, r.text);
    assert(String(r.body.error).includes(has), `${has}: ${r.body.error}`);
    assertEquals(r.t.rpc.length, 0);
  }
  const unpaid = await call(OWNER, { pipelineId: PIPE, rows: ROWS }, UNPAID);
  assertEquals(unpaid.status, 403, unpaid.text);
  assert(/Customer Hub/.test(unpaid.body.error), unpaid.body.error);
  assertEquals(unpaid.t.rpc.length, 0);
});

Deno.test("custom values are checked against the builder's fields; a misfit is left off with a warning", async () => {
  const fieldDefs = {
    contact: [{ id: "f1", key: "farm", label: "Farm", field_type: "text" }, { id: "f2", key: "acres", label: "Acres", field_type: "number" }],
    deal: [{ id: "f3", key: "size", label: "Size", field_type: "select", choices: ["12x16", "10x12"] }],
  };
  const rows = [
    { row: 2, name: "A", phone: "5550100101", contact_custom: { farm: "Bear Creek", acres: "lots", gone: "x" }, deal_custom: { size: "12X16" } },
    { row: 3, name: "B", phone: "5550100102", deal_custom: { size: "huge" } },
  ];
  const { status, body, text, t } = await call({ ...OWNER, fieldDefs }, { pipelineId: PIPE, rows });
  assertEquals(status, 200, text);
  assertEquals(t.rpc[0].p_rows[0].contact_custom, { farm: "Bear Creek" }, "a number that isn't one is dropped; an unknown key too");
  assertEquals(t.rpc[0].p_rows[0].deal_custom, { size: "12x16" }, "a choice is stored in the choice's own spelling");
  assertEquals(t.rpc[0].p_rows[1].deal_custom, undefined, "a row whose only custom value misfits sends none");
  assertEquals(body.warnings, [{ row: 2, code: "custom_dropped" }, { row: 3, code: "custom_dropped" }]);
  const none = await call(OWNER, { pipelineId: PIPE, rows: ROWS });
  assert(!none.t.events.some((e) => e.startsWith("fields:")), "no custom values, no field read");
});

Deno.test("the database's refusals become sentences; not installed yet is a marked refusal", async () => {
  const nope = await call({ ...OWNER, rpc: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) }, { pipelineId: PIPE, rows: ROWS });
  assertEquals(nope.status, 503, nope.text);
  assert(/isn't installed on this server yet/.test(nope.body.error));
  assertEquals(nope.headers.get("x-ss-refusal"), "1");
  const gone = await call({ ...OWNER, rpc: () => ({ data: null, error: { code: "P0002", message: "pipeline not found" } }) }, { pipelineId: PIPE, rows: ROWS });
  assertEquals(gone.status, 404, gone.text);
  assert(/pipeline no longer exists/.test(gone.body.error));
  const stage = await call({ ...OWNER, rpc: () => ({ data: null, error: { code: "P0002", message: "stage not found" } }) }, { pipelineId: PIPE, rows: ROWS });
  assertEquals(stage.status, 404, stage.text);
  const owner = await call({ ...OWNER, rpc: () => ({ data: null, error: { code: "23503", message: "owner is not on this team" } }) }, { pipelineId: PIPE, rows: ROWS });
  assertEquals(owner.status, 400, owner.text);
});

Deno.test("the action is gated and row-scoped in the shipped source", () => {
  assert(/\n\s+crm_import_leads:\s+\{ area: "contacts", level: "edit" \}/.test(SRC), "a contacts:edit gate");
  assert(/\n\s+crm_import_leads:\s+\{ creates: true \}/.test(SRC), "a CONTACT_ROW_SCOPE entry");
});
