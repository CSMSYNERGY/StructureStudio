// Moving a builder off GoHighLevel invoicing onto StructureStudio's own quotes and invoices
// (migration 280; Carolyn 2026-09-07, "All other builders will only have the option to invoice
// through SS"), driven through the SHIPPED portal-settings and submit-estimate handlers.
//
// 280 changes one thing, client_settings.invoice_in_ghl's DEFAULT (true → false). The move of each
// existing builder is an ops step: the owner, or an operator viewing as them, saves Settings → CRM
// Connection → Quotes & Invoices with the builder's own next quote number, next invoice number and
// tax rate. The one function change that goes with it: portal-settings' save checks judge a tenant
// with NO row by the row the save creates (paperwork mode under 280), not as CRM mode. This file
// pins that both halves do what the plan says:
//
//   portal-settings `save`, as the Quotes & Invoices card posts it
//     1. a grandfathered tenant (CRM mode, no capability, no numbering), CRM-connected or not, and
//        a tenant with NO settings row: the save lands invoice_in_ghl = false with exactly the
//        numbers and rate given, and names no CRM column (the connection keeps flowing);
//     2. a stale page posting invoiceInGhl: true for a tenant without the capability is still
//        written as false (217);
//     3. any of the three missing: a sentence and NO write. Nothing is ever guessed;
//     4. 0% tax is an answer, not a blank;
//     5. the one tenant WITH the capability can still choose the CRM;
//     6. a neighbouring save (a tax label) from a grandfathered tenant never flips it mid-flight;
//     7. a tenant with NO row posting a starting quote number alone is held to all three;
//     8. a tenant with NO row may set a change order fee (its row will be paperwork), while a
//        grandfathered CRM-mode row is still refused one.
//   submit-estimate, a shopper's quote, against the row shapes the plan meets
//     9. a row created under 280's default (paperwork mode, no numbering yet): the actionable
//        refusal that names the Quotes & Invoices card, after asking for a number exactly once;
//    10. a grandfathered row with no CRM (today's blocked shape): the old refusal, unchanged;
//    11. a grandfathered row WITH a CRM and without the capability: still the CRM's estimate. There
//        is no read-time override that treats "not allowed" as false;
//    12. no row at all: "hasn't finished setting up quotes yet", unchanged.
//
// HOW. quoteCornerViewsWiring_test's idiom for portal-settings and
// submitEstimatePriceOverrideWiring_test's for submit-estimate: Deno.serve is stubbed while each
// index.ts is imported, so a request runs through withErrorLog and every step as it does live. The
// import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubRpc route every table and
// rpc call into the fakes below, and fetch answers the CRM's endpoints locally. No --allow-net is
// granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIERS ARE COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one
// would type-check the handlers against the stub's partial client type.
//
// Tenants, people and numbers are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

// ─── The real handlers ─────────────────────────────────────────────────────────────────────────
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
const SETTINGS_HANDLER = await captureHandler("../../portal-settings/index.ts");
const SUBMIT_HANDLER = await captureHandler("../../submit-estimate/index.ts");

const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

// The row shapes, as client_settings holds them. `null` is a tenant with no row at all.
type Row = Record<string, unknown> | null;
const BASE_ROW = {
  client_id: T, business_name: "Acme Sheds", business_phone: "", business_website: "", business_address: null,
  business_logo_url: "", quote_terms: "", beta_mode: false, beta_email: null, show_pricing: true,
  ramp_price: 0, ramp_price_method: "each", ramp_image_url: null, ramp_show_image: false,
  email_provider: "ghl", email_domain_status: null, email_domain: null, email_from_local: null, email_from_name: null,
  email_template_copy: null, ghl_pipeline_id: null, ghl_stage_send_quote_id: null,
  ss_quote_prefix: "", ss_invoice_prefix: "", ss_tax_label: "Sales tax", ss_tax_delivery: false,
  co_unlock_required: false, co_fee_cents: 0, quote_valid_days: 30, insulation_enabled: false,
};
const CRM = { ghl_location_id: "loc-1", ghl_api_key: "harness-key" };
const NO_CRM = { ghl_location_id: null, ghl_api_key: null };
const UNNUMBERED = { ss_quote_next: null, ss_invoice_next: null, ss_tax_rate: null };
/** CRM mode without the capability (217), connected to a CRM: quoting through it today. */
const GRANDFATHERED_CRM: Row = { ...BASE_ROW, ...CRM, ...UNNUMBERED, invoice_in_ghl: true, ghl_invoicing_allowed: false };
/** CRM mode without the capability and with NO CRM: every quote refused today. */
const GRANDFATHERED_NO_CRM: Row = { ...BASE_ROW, ...NO_CRM, ...UNNUMBERED, invoice_in_ghl: true, ghl_invoicing_allowed: false };
/** The one tenant allowed to invoice through the CRM. */
const CAPABLE: Row = { ...BASE_ROW, ...CRM, ...UNNUMBERED, invoice_in_ghl: true, ghl_invoicing_allowed: true };
/** A row created after 280 by a save that did not touch invoicing: paperwork mode, no numbering. */
const NEW_DEFAULT: Row = { ...BASE_ROW, ...NO_CRM, ...UNNUMBERED, invoice_in_ghl: false, ghl_invoicing_allowed: false };

// ═══ portal-settings ══════════════════════════════════════════════════════════════════════════
type SettingsTrace = { upserts: Record<string, unknown>[]; rows: Record<string, unknown>[] };

function settingsChain(row: Row, trace: SettingsTrace, table: string, ops: any[][]): any {
  const next = (op: any[]) => settingsChain(row, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const has = (op: string) => ops.some((o) => o[0] === op);
    const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
    const answer = () => {
      if (table === "app_errors") { trace.rows.push(arg("insert")); return { data: null, error: null }; }
      if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
      if (table === "client_settings") {
        if (has("upsert")) { trace.upserts.push(arg("upsert")); return { data: null, error: null }; }
        return { data: row, error: null };
      }
      // designs / invoice_sends (the numbering floor): nothing issued by StructureStudio yet, which is
      // every grandfathered tenant's truth. Anything else answers empty rather than throwing.
      return { data: has("maybeSingle") || has("single") ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

async function save(payload: Record<string, unknown>, row: Row) {
  const trace: SettingsTrace = { upserts: [], rows: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => settingsChain(row, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await SETTINGS_HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "save", ...payload }),
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

/** The Quotes & Invoices card's body (03-catalog.jsx saveInvoicing), for a tenant WITHOUT the
 *  capability: it posts invoiceInGhl false, and the form's strings as typed. */
const card = (over: Record<string, unknown> = {}) => ({
  invoiceInGhl: false,
  ssQuoteNext: "3101", ssQuotePrefix: "Q-", ssInvoiceNext: "7001", ssInvoicePrefix: "INV-",
  ssTaxRate: "6.5", ssTaxLabel: "Sales tax", ssTaxDelivery: false,
  ...over,
});
const CRM_COLUMNS = ["ghl_location_id", "ghl_api_key", "ghl_pipeline_id", "ghl_stage_send_quote_id", "ghl_invoicing_allowed"];

Deno.test("the move: a grandfathered tenant's Quotes & Invoices save lands paperwork mode with exactly its own numbers", async () => {
  for (const [label, row] of [["CRM-connected", GRANDFATHERED_CRM], ["no CRM", GRANDFATHERED_NO_CRM], ["no settings row", null]] as const) {
    const { status, body, trace } = await save(card(), row);
    assertEquals(status, 200, `${label}: ${JSON.stringify(body)}`);
    assertEquals(trace.upserts.length, 1, label);
    const up = trace.upserts[0];
    assertEquals(up.client_id, T, `${label}: the upsert names the tenant, so a missing row is created`);
    assertEquals(up.invoice_in_ghl, false, label);
    assertEquals([up.ss_quote_next, up.ss_quote_prefix, up.ss_invoice_next, up.ss_invoice_prefix, up.ss_tax_rate],
      [3101, "Q-", 7001, "INV-", 0.065], label);
    for (const c of CRM_COLUMNS) assertFalse(c in up, `${label}: the save does not touch ${c}`);
  }
});

Deno.test("a stale page asking for the CRM path is still written as paperwork for a tenant without the capability (217)", async () => {
  for (const row of [GRANDFATHERED_CRM, GRANDFATHERED_NO_CRM, null]) {
    const { status, trace } = await save(card({ invoiceInGhl: true }), row);
    assertEquals(status, 200);
    assertEquals(trace.upserts[0].invoice_in_ghl, false);
  }
});

Deno.test("nothing is guessed: any of the three left blank is a sentence and no write", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ssQuoteNext: "" }, /needs a starting quote number/],
    [{ ssInvoiceNext: "" }, /needs a starting invoice number too/],
    [{ ssTaxRate: "" }, /needs a sales tax rate/],
  ];
  for (const row of [GRANDFATHERED_CRM, GRANDFATHERED_NO_CRM, null]) {
    for (const [over, re] of cases) {
      const { status, body, trace } = await save(card(over), row);
      assertEquals(status, 400, `${JSON.stringify(over)}: ${JSON.stringify(body)}`);
      assert(re.test(String(body.error)), String(body.error));
      assertEquals(trace.upserts.length, 0, `${JSON.stringify(over)} wrote nothing`);
    }
  }
});

Deno.test("0% tax is an answer: stored as 0, not refused as a blank", async () => {
  const { status, trace } = await save(card({ ssTaxRate: "0" }), GRANDFATHERED_NO_CRM);
  assertEquals(status, 200);
  assertEquals(trace.upserts[0].ss_tax_rate, 0);
  assertEquals(trace.upserts[0].invoice_in_ghl, false);
});

Deno.test("the tenant WITH the capability can still keep the CRM path, with no numbering asked for", async () => {
  const { status, body, trace } = await save(card({ invoiceInGhl: true, ssQuoteNext: "", ssInvoiceNext: "", ssTaxRate: "" }), CAPABLE);
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(trace.upserts[0].invoice_in_ghl, true);
});

Deno.test("a neighbouring save from a grandfathered tenant never flips it mid-flight", async () => {
  for (const row of [GRANDFATHERED_CRM, GRANDFATHERED_NO_CRM]) {
    const { status, trace } = await save({ ssTaxLabel: "State tax" }, row);
    assertEquals(status, 200);
    assertEquals(trace.upserts.length, 1);
    assertFalse("invoice_in_ghl" in trace.upserts[0], JSON.stringify(trace.upserts[0]));
  }
});

// A tenant with NO row is judged as the row its save creates, which under 280 is paperwork mode.
// Read as "anything but false is the CRM", a lone starting quote number skipped all three
// refusals and created a paperwork-mode row with no invoice number and no rate.
Deno.test("no settings row: a lone starting quote number is held to all three, and nothing is written", async () => {
  const { status, body, trace } = await save({ ssQuoteNext: "3101" }, null);
  assertEquals(status, 400, JSON.stringify(body));
  assert(/needs a starting invoice number too/.test(String(body.error)), String(body.error));
  assertEquals(trace.upserts.length, 0);
});

Deno.test("no settings row: a change order fee is paperwork's to charge, so it saves; a CRM-mode row is still refused", async () => {
  // The change-order card's body (03-catalog.jsx saveChangeOrders): no invoiceInGhl key.
  const coCard = { coUnlockRequired: true, coFreeDays: "7", coFee: "50", coFeeTaxable: false, coFeeLabel: "Change order fee", coUnlockHours: "72" };
  const fresh = await save(coCard, null);
  assertEquals(fresh.status, 200, JSON.stringify(fresh.body));
  assertEquals(fresh.trace.upserts.length, 1);
  assertEquals(fresh.trace.upserts[0].co_fee_cents, 5000);
  assertFalse("invoice_in_ghl" in fresh.trace.upserts[0], "the row takes 280's default; the save names no mode");
  for (const row of [GRANDFATHERED_CRM, GRANDFATHERED_NO_CRM]) {
    const { status, body, trace } = await save(coCard, row);
    assertEquals(status, 400, JSON.stringify(body));
    assert(/created in your CRM right now/.test(String(body.error)), String(body.error));
    assertEquals(trace.upserts.length, 0);
  }
});

// ═══ submit-estimate ══════════════════════════════════════════════════════════════════════════
const CODE = "SS-PDM234ABCD";
const STYLE = { id: "st-econo", key: "econo", label: "Econo", image_url: null, show_image_on_estimate: false, taxable: true, d3: { wallHeightFt: 8 } };
const SIZE = { id: "sz-1012", style_id: "st-econo", base_price: 3000, label: "10x12", width_ft: 10, length_ft: 12 };

type SubmitTrace = { rows: any[]; rpcs: string[]; ghl: { url: string; method: string }[] };

function submitRows(row: Row, table: string): any[] | null {
  switch (table) {
    case "client_settings": return row ? [row] : [];
    case "designs": return [{
      client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-05T10:00:00Z", ghl_contact_id: null,
      ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
      accepted_at: null, estimate_lines: null, accepted_snapshot: null,
    }];
    case "building_styles": return [STYLE];
    case "building_sizes": return [SIZE];
    default: return null;   // catalog extras, delivery, locations, contacts …: nothing on file
  }
}

function submitChain(row: Row, trace: SubmitTrace, table: string, ops: any[][]): any {
  const next = (op: any[]) => submitChain(row, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle", "not", "or", "gte", "lte", "gt", "lt", "range"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    if (table === "app_errors" && verb === "insert") {
      trace.rows.push(ops.find((o) => o[0] === "insert")?.[1]);
      return Promise.resolve({ data: null, error: null }).then(ok, bad);
    }
    if (verb !== "select") return Promise.resolve({ data: [], error: null }).then(ok, bad);
    let rows = submitRows(row, table);
    const one = ops.some((o) => o[0] === "single" || o[0] === "maybeSingle");
    if (rows == null) return Promise.resolve({ data: one ? null : [], error: null }).then(ok, bad);
    for (const o of ops) {
      if (o[0] === "eq") rows = rows.filter((r) => !(o[1] in r) || r[o[1]] === o[2]);
    }
    // `.single()` on nothing is PostgREST's "no rows" error, which is how submit-estimate meets a
    // tenant without a settings row.
    if (ops.some((o) => o[0] === "single") && !rows.length) {
      return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } }).then(ok, bad);
    }
    return Promise.resolve({ data: one ? (rows[0] ?? null) : rows, error: null }).then(ok, bad);
  };
  return q;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function submit(row: Row) {
  const trace: SubmitTrace = { rows: [], rpcs: [], ghl: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = null;
  stubAuth.error = null;
  stubDb.from = (table: string) => submitChain(row, trace, table, []);
  // No starting number on file: the allocator hands back NULL, as allocate_ss_quote_number does
  // for a NULL ss_quote_next. Any other rpc answers nothing.
  stubRpc.rpc = (fn: string) => {
    trace.rpcs.push(fn);
    return Promise.resolve({ data: null, error: null });
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://services.leadconnectorhq.com/")) throw new Error(`unexpected fetch: ${url}`);
    trace.ghl.push({ url, method: String(init?.method ?? "GET") });
    if (url.endsWith("/contacts/upsert")) return Promise.resolve(json({ contact: { id: "contact-1" } }));
    if (url.includes("/products/")) return Promise.resolve(json({ products: [{ createdBy: "ghl-user-1", locationId: "loc-1" }] }));
    if (url.includes("/opportunities/search")) return Promise.resolve(json({ opportunities: [] }));
    if (url.endsWith("/opportunities/")) return Promise.resolve(json({ opportunity: { id: "opp-1" } }));
    if (/\/invoices\/estimate$/.test(url)) return Promise.resolve(json({ _id: "est-1", estimateNumber: 1001 }));
    if (url.endsWith("/send")) return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json({}));
  }) as typeof fetch;
  try {
    const res = await SUBMIT_HANDLER(new Request(`${PROJECT}/functions/v1/submit-estimate`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({
        designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [],
        contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
        selections: { buildingStyle: "econo", buildingSize: "10x12", paint: "Painted", roofType: "Shingle" },
        doors: [], ramps: [], windows: [], customOptions: [], discounts: [], roughOpenings: [],
        itemSummary: { singleDoors: 0, doubleDoors: 0, windows: 0, workbenches: [], shelves: [], doubleShelves: [], electricalItems: [], lofts: 0, loftSqft: 0, ramp: 0, lines: 0, notes: [] },
      }),
    }));
    return { status: res.status, body: await res.json(), trace };
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
const estimateCalls = (t: SubmitTrace) => t.ghl.filter((c) => /\/invoices\/estimate/.test(c.url));

Deno.test("a row created under 280's default: the refusal names the Quotes & Invoices card, and nothing is issued", async () => {
  const { status, body, trace } = await submit(NEW_DEFAULT);
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, "This account issues its own quotes but has no starting quote number set. Add one in Settings → CRM Connection → Quotes & Invoices.");
  assertEquals(trace.rpcs.filter((f) => f === "allocate_ss_quote_number").length, 1, "asked for a number exactly once");
  assertEquals(trace.ghl.length, 0, "no CRM is connected, so nothing went to one");
});

Deno.test("a grandfathered row with no CRM (today's blocked shape) is refused exactly as before", async () => {
  const { status, body, trace } = await submit(GRANDFATHERED_NO_CRM);
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, `${T} isn't set up to send quotes yet. (For the business: connect your CRM, or switch quotes to Structure Studio paperwork, under Settings → CRM Connection.)`);
  assertEquals(trace.rpcs.length, 0);
  assertEquals(trace.ghl.length, 0);
});

Deno.test("NO read-time override: a grandfathered row with a CRM keeps issuing the CRM's estimate until its own save", async () => {
  const { status, body, trace } = await submit(GRANDFATHERED_CRM);
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(estimateCalls(trace).length >= 1, true, "the CRM estimate was created");
  assertFalse(trace.rpcs.includes("allocate_ss_quote_number"), "no StructureStudio number was taken");
});

Deno.test("no settings row at all: refused as before (the first save creates the row)", async () => {
  const { status, body, trace } = await submit(null);
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, `${T} hasn't finished setting up quotes yet — please try again later, or contact them directly.`);
  assertEquals(trace.rpcs.length, 0);
  assertEquals(trace.ghl.length, 0);
});
