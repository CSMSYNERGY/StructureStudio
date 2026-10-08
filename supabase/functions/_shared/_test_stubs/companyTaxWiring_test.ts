// The company sales tax rate and the "Use tax codes" switch on Settings → Company → Tax
// (2026-10-09, migration 290), driven through the SHIPPED portal-settings handler.
//
// companyTax.test.ts proves the decisions (and that `save` parses a rate exactly as it did). What it
// cannot see is the handler around them, and every mistake worth pinning here is a short edit that
// throws nothing:
//
//   save_company_tax
//     1. a grandfathered builder (CRM mode, no capability, no CRM) saving 0%: the upsert carries the
//        rate and NOT invoice_in_ghl, so the row stays in CRM mode; no ghl_* column and no
//        numbering counter is ever written, whatever the body says;
//     2. a blank rate on a paperwork-mode row, and on a builder with NO row: the sentence, and no
//        write at all; on a CRM-mode row (with a CRM): the rate is cleared;
//     3. a builder with no row may not save a label or the switch alone (the upsert would create a
//        paperwork-mode row with no rate); with a rate, the save creates the row;
//     4. the codes switch alone writes only that column (plus client_id and updated_at), and a
//        "true" string is refused; switching off never touches tax_code_assignments;
//     5. settings_crm:edit WITHOUT Branding may save (unlike `save`, which needs both); settings_crm
//        view is refused with resolveTenant's 403, before any read;
//     6. the answer is what is stored, and every save leaves an admin_audit row.
//   tax_codes_get
//     7. it answers the company rate, ssMode, ghlInvoicingAllowed, crmConfigured and taxCodesEnabled,
//        with only booleans about the CRM (never the location id or the key);
//     8. on a database WITHOUT migration 290 (the column missing): 200, taxCodesEnabled null, every
//        other field as before, and no app_errors row (the tolerant read);
//     9. a builder with no settings row reads no rate, CRM mode, switch off.
//
// HOW. paperworkDefaultWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request runs through withErrorLog, resolveTenant and the action's branch as it does
// live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb routes every table call
// into the fake below. No --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants, people and keys are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { BAD_RATE, RATE_REQUIRED } from "../companyTax.ts";

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

const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

// The row shapes, as client_settings holds them (paperworkDefaultWiring_test's names). `null` is a
// builder with no row at all.
type Row = Record<string, unknown> | null;
const BASE_ROW = {
  client_id: T, business_name: "Acme Sheds", ss_tax_label: "Sales tax", ss_tax_delivery: false, tax_lookup_enabled: false,
  ss_quote_next: null, ss_invoice_next: null, ss_tax_rate: null,
};
const CRM = { ghl_location_id: "loc-1", ghl_api_key: "harness-key" };
const NO_CRM = { ghl_location_id: null, ghl_api_key: null };
/** CRM mode without the capability (217), connected to a CRM. */
const GRANDFATHERED_CRM: Row = { ...BASE_ROW, ...CRM, invoice_in_ghl: true, ghl_invoicing_allowed: false, ss_tax_rate: 0.07 };
/** CRM mode without the capability and with NO CRM: every estimate refused today. */
const GRANDFATHERED_NO_CRM: Row = { ...BASE_ROW, ...NO_CRM, invoice_in_ghl: true, ghl_invoicing_allowed: false };
/** A row created after 280 by a save that did not touch invoicing: paperwork mode. */
const NEW_DEFAULT: Row = { ...BASE_ROW, ...NO_CRM, invoice_in_ghl: false, ghl_invoicing_allowed: false, ss_tax_rate: 0.065 };

type World = {
  row?: Row;
  codes?: boolean;          // client_settings.tax_codes_enabled
  noColumn?: boolean;       // the database has no tax_codes_enabled (a deploy ahead of 290)
  member?: { role: string; title: string | null; access: Record<string, string> | null };
};
type Trace = {
  upserts: Record<string, unknown>[];
  tables: string[];
  writes: { table: string; op: string }[];
  audits: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  selects: string[];
};
const MISSING = { code: "42703", message: "column client_settings.tax_codes_enabled does not exist" };
const WRITE_OPS = ["insert", "update", "upsert", "delete"];

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const cols = String(arg("select") ?? "");
  const row = world.row === undefined ? GRANDFATHERED_CRM : world.row;
  for (const op of WRITE_OPS) if (has(op) && table !== "app_errors" && table !== "admin_audit") trace.writes.push({ table, op });
  if (table === "client_users") {
    const m = world.member ?? { role: "owner", title: null, access: null };
    return { data: [{ client_id: T, role: m.role, title: m.title, access: m.access, user_id: "u1", prefs: null }], error: null };
  }
  if (table === "admin_audit") { trace.audits.push(arg("insert")); return { data: null, error: null }; }
  if (table === "client_settings") {
    if (has("upsert")) {
      const up = arg("upsert");
      trace.upserts.push(up);
      if (world.noColumn && "tax_codes_enabled" in up) return { data: null, error: MISSING };
      return { data: { ...(row ?? {}), tax_codes_enabled: world.codes ?? false, ...up }, error: null };
    }
    trace.selects.push(cols);
    if (/\btax_codes_enabled\b/.test(cols)) {
      if (world.noColumn) return { data: null, error: MISSING };
      return { data: row ? { tax_codes_enabled: world.codes ?? false } : null, error: null };
    }
    return { data: row, error: null };
  }
  // building_styles / tax_code_assignments / avalara_tax_codes for tax_codes_get: empty, which is a
  // builder with no styles and no codes. Anything else answers empty rather than throwing.
  return { data: has("maybeSingle") || has("single") ? null : [], error: null, count: 0 };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle", "ilike"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.errors.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

async function drive(body: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { upserts: [], tables: [], writes: [], audits: [], errors: [], selects: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => { trace.tables.push(table); return chain(world, trace, table, []); };
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const saveTax = (payload: Record<string, unknown>, world: World = {}) => drive({ action: "save_company_tax", ...payload }, world);
const FORBIDDEN = /^(invoice_in_ghl|ghl_|ss_quote_|ss_invoice_|co_|business_)/;
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();

// ─── save_company_tax ──────────────────────────────────────────────────────────────────────────
Deno.test("1. a grandfathered builder with no CRM saving 0%: the rate lands, the row stays in CRM mode", async () => {
  const { status, body, trace } = await saveTax({ ssTaxRate: "0" }, { row: GRANDFATHERED_NO_CRM });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.upserts.length, 1);
  const up = trace.upserts[0];
  assertEquals(keysOf(up), ["client_id", "ss_tax_rate", "updated_at"], "only the sent key, the tenant and the stamp");
  assertEquals(up.client_id, T);
  assertEquals(up.ss_tax_rate, 0, "0 is an answer, stored as 0");
  assertFalse("invoice_in_ghl" in up, "the save never moves the builder into paperwork mode");
  assertEquals(body.ssMode, false, "the answer says the row is still in CRM mode");
  assertEquals(body.companyRatePct, 0);
  assertEquals(body.companyLabel, "Sales tax");
});

Deno.test("1b. whatever the body adds, no ghl_*, mode, numbering, fee or business column is written", async () => {
  const { status, body, trace } = await saveTax({
    ssTaxRate: "6.5", ssTaxLabel: "County tax", ssTaxDelivery: true,
    invoiceInGhl: false, ghlApiKey: "stolen", ghlLocationId: "loc-x", ssQuoteNext: "1", ssInvoiceNext: "1",
    coFee: "100", businessName: "Not Acme",
  }, { row: GRANDFATHERED_CRM });
  assertEquals(status, 200, JSON.stringify(body));
  const up = trace.upserts[0];
  assertEquals(keysOf(up), ["client_id", "ss_tax_delivery", "ss_tax_label", "ss_tax_rate", "updated_at"], JSON.stringify(up));
  for (const k of Object.keys(up)) assertFalse(FORBIDDEN.test(k), `wrote ${k}`);
  assertEquals([up.ss_tax_rate, up.ss_tax_label, up.ss_tax_delivery], [0.065, "County tax", true]);
  assertEquals([body.companyRatePct, body.companyLabel, body.ssTaxDelivery], [6.5, "County tax", true], "the answer is what is stored");
});

Deno.test("2. a blank rate in paperwork mode, or with no row: the sentence, and no write", async () => {
  for (const [label, row] of [["paperwork mode", NEW_DEFAULT], ["no settings row", null]] as const) {
    for (const blank of ["", "   ", null]) {
      const { status, body, trace } = await saveTax({ ssTaxRate: blank, ssTaxLabel: "County tax" }, { row });
      assertEquals(status, 400, `${label} / ${JSON.stringify(blank)}: ${JSON.stringify(body)}`);
      assertEquals(body.error, RATE_REQUIRED);
      assertEquals(body.reason, "rate_required");
      assertEquals(trace.upserts.length, 0, `${label}: nothing written`);
      assertEquals(trace.audits.length, 0, `${label}: nothing audited`);
    }
  }
});

Deno.test("2b. a blank rate on a CRM-mode row (CRM connected): the rate is cleared", async () => {
  const { status, body, trace } = await saveTax({ ssTaxRate: "" }, { row: GRANDFATHERED_CRM });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.upserts.length, 1);
  assertEquals(trace.upserts[0].ss_tax_rate, null);
  assertEquals(body.companyRatePct, null);
});

Deno.test("2c. a rate out of range is refused with save's own sentence, and no write", async () => {
  for (const bad of ["25.0001", "abc", "-1"]) {
    const { status, body, trace } = await saveTax({ ssTaxRate: bad }, { row: NEW_DEFAULT });
    assertEquals(status, 400, bad);
    assertEquals(body.error, BAD_RATE);
    assertEquals(trace.upserts.length, 0);
  }
});

Deno.test("3. no settings row: a label or the switch alone is refused; with a rate the save creates the row", async () => {
  for (const payload of [{ ssTaxLabel: "County tax" }, { ssTaxDelivery: true }, { taxCodesEnabled: true }]) {
    const { status, body, trace } = await saveTax(payload, { row: null });
    assertEquals(status, 400, `${JSON.stringify(payload)}: ${JSON.stringify(body)}`);
    assertEquals(body.reason, "rate_required");
    assertEquals(trace.upserts.length, 0, `${JSON.stringify(payload)} wrote nothing`);
  }
  const { status, body, trace } = await saveTax({ ssTaxRate: "7.25", ssTaxLabel: "State tax" }, { row: null });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(keysOf(trace.upserts[0]), ["client_id", "ss_tax_label", "ss_tax_rate", "updated_at"]);
  assertEquals(trace.upserts[0].client_id, T, "the upsert names the tenant, so the missing row is created");
  assertFalse(trace.selects.some((c) => /invoice_in_ghl/.test(c) && !/ss_tax_rate/.test(c)),
    "a real rate needs no row read before the write");
});

Deno.test("4. the codes switch alone writes only that column; a string is refused; codes are never touched", async () => {
  for (const on of [true, false]) {
    const { status, body, trace } = await saveTax({ taxCodesEnabled: on }, { row: NEW_DEFAULT, codes: !on });
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(keysOf(trace.upserts[0]), ["client_id", "tax_codes_enabled", "updated_at"]);
    assertEquals(trace.upserts[0].tax_codes_enabled, on);
    assertEquals(body.taxCodesEnabled, on, "the answer carries the stored switch");
    assertFalse(trace.tables.includes("tax_code_assignments"), "switching codes on or off never reads or writes the codes");
  }
  for (const bad of ["true", "false", 1, null]) {
    const { status, body, trace } = await saveTax({ taxCodesEnabled: bad }, { row: NEW_DEFAULT });
    assertEquals(status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(body)}`);
    assertEquals(body.reason, "bad_switch");
    assertEquals(trace.upserts.length, 0);
  }
  const empty = await saveTax({}, { row: NEW_DEFAULT });
  assertEquals(empty.status, 400, "nothing to save is refused");
  assertEquals(empty.body.reason, "nothing_to_save");
  assertEquals(empty.trace.upserts.length, 0);
});

Deno.test("4b. a rate save never names the switch, so it works on a database without 290", async () => {
  const { status, body, trace } = await saveTax({ ssTaxRate: "6" }, { row: NEW_DEFAULT, noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertFalse("tax_codes_enabled" in trace.upserts[0]);
  assertFalse("taxCodesEnabled" in body, "the answer does not claim a switch it did not read");
  assertFalse(trace.selects.some((c) => /tax_codes_enabled/.test(c)));
});

Deno.test("5. settings_crm:edit without Branding may save; settings_crm:view is refused before any read", async () => {
  const crmOnly = { role: "user", title: "sales_rep", access: { settings_crm: "edit", settings_branding: "none" } };
  const ok = await saveTax({ ssTaxRate: "5" }, { row: NEW_DEFAULT, member: crmOnly });
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
  assertEquals(ok.trace.upserts.length, 1);
  // The difference from `save`, which writes business identity too and so asks for Branding as well.
  const viaSave = await drive({ action: "save", ssTaxRate: "5" }, { row: NEW_DEFAULT, member: crmOnly });
  assertEquals(viaSave.status, 403, "save still needs Branding as well");

  const viewer = { role: "user", title: "sales_rep", access: { settings_crm: "view" } };
  const no = await saveTax({ ssTaxRate: "5" }, { row: NEW_DEFAULT, member: viewer });
  assertEquals(no.status, 403, JSON.stringify(no.body));
  assertEquals(no.trace.upserts.length, 0);
  assertFalse(no.trace.tables.includes("client_settings"), "refused before the settings row is read");
});

Deno.test("6. every save is audited strictly, with the keys and the rate, never the CRM", async () => {
  const { trace } = await saveTax({ ssTaxRate: "6.5", taxCodesEnabled: false }, { row: NEW_DEFAULT });
  assertEquals(trace.audits.length, 1);
  assertEquals(trace.audits[0].action, "portal_save_company_tax");
  assertEquals(trace.audits[0].target_client_id, T);
  assert(/keys=ss_tax_rate,tax_codes_enabled rate=0\.065 codes=false/.test(String(trace.audits[0].note)), String(trace.audits[0].note));
  assertEquals(trace.writes.filter((w) => w.table !== "client_settings"), [], "client_settings is the only table written");
});

// ─── tax_codes_get ─────────────────────────────────────────────────────────────────────────────
Deno.test("7. tax_codes_get answers the company rate and what the Tax tab's copy needs, CRM as booleans only", async () => {
  const { status, body, trace } = await drive({ action: "tax_codes_get" }, { row: GRANDFATHERED_CRM, codes: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals([body.companyRatePct, body.companyLabel, body.ssTaxDelivery], [7, "Sales tax", false]);
  assertEquals([body.ssMode, body.ghlInvoicingAllowed, body.crmConfigured, body.taxCodesEnabled], [false, false, true, true]);
  const raw = JSON.stringify(body);
  assertFalse(raw.includes("harness-key") || raw.includes("loc-1"), "neither the CRM key nor the location id leaves");
  assert(Array.isArray(body.headings) && Array.isArray(body.assignments), "the codes half is unchanged");
  assertEquals(trace.selects.filter((c) => /\btax_codes_enabled\b/.test(c)), ["tax_codes_enabled"], "the switch is its own read");
  assertFalse(trace.selects.some((c) => /\btax_codes_enabled\b/.test(c) && /invoice_in_ghl/.test(c)), "the switch is not in the main select");

  const paper = await drive({ action: "tax_codes_get" }, { row: NEW_DEFAULT, codes: false });
  assertEquals([paper.body.ssMode, paper.body.crmConfigured, paper.body.taxCodesEnabled, paper.body.companyRatePct], [true, false, false, 6.5]);
  const noCrm = await drive({ action: "tax_codes_get" }, { row: GRANDFATHERED_NO_CRM });
  assertEquals([noCrm.body.ssMode, noCrm.body.crmConfigured, noCrm.body.companyRatePct], [false, false, null]);
});

Deno.test("8. tax_codes_get on a database without 290: 200, taxCodesEnabled null, nothing logged", async () => {
  const { status, body, trace } = await drive({ action: "tax_codes_get" }, { row: GRANDFATHERED_CRM, noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.taxCodesEnabled, null, "null hides the switch; the editor shows as it always has");
  assertEquals(body.companyRatePct, 7, "every other field still loads");
  assertEquals(body.crmConfigured, true);
  assert(Array.isArray(body.headings));
  assertEquals(trace.errors.length, 0, "a column that is not there yet is not an error for support");
});

Deno.test("9. tax_codes_get for a builder with no settings row: no rate, CRM mode, switch off", async () => {
  const { status, body } = await drive({ action: "tax_codes_get" }, { row: null });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals([body.companyRatePct, body.companyLabel, body.ssTaxDelivery], [null, "Sales tax", false]);
  assertEquals([body.ssMode, body.ghlInvoicingAllowed, body.crmConfigured, body.taxCodesEnabled], [false, false, false, false]);
});
