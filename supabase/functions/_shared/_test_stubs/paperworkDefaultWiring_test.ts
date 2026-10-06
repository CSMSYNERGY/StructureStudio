// Moving a builder off GoHighLevel invoicing onto StructureStudio's own quotes and invoices
// (migration 280; Carolyn 2026-09-07, "All other builders will only have the option to invoice
// through SS"), driven through the SHIPPED portal-settings and submit-estimate handlers.
//
// 280 changes one thing, client_settings.invoice_in_ghl's DEFAULT (true → false). The move of each
// existing builder is an ops step: the owner, or an operator viewing as them, saves Settings → CRM
// Connection → Quotes & Invoices with the builder's tax rate and, if they have them, their own next
// quote and invoice numbers. Since migration 283 (Carolyn 2026-10-06) a blank number starts at 1000
// in the allocator, so the save asks only for the tax rate. The function changes that go with it:
// portal-settings' save checks judge a tenant with NO row by the row the save creates (paperwork
// mode under 280), not as CRM mode; and submit-estimate allocates the quote number only after the
// sales-tax decision, so a refusal burns no number. This file pins that each part does what the
// plan says:
//
//   portal-settings `save`, as the Quotes & Invoices card posts it
//     1. a grandfathered tenant (CRM mode, no capability, no numbering), CRM-connected or not, and
//        a tenant with NO settings row: the save lands invoice_in_ghl = false with exactly the
//        numbers and rate given, and names no CRM column (the connection keeps flowing);
//     2. a stale page posting invoiceInGhl: true for a tenant without the capability is still
//        written as false (217);
//     3. blank numbers with a rate: saved, both starts stored NULL ("not chosen": 1000 on first
//        use, 283); a blank RATE is still a sentence and NO write. A rate is never guessed;
//     4. 0% tax is an answer, not a blank;
//     5. the one tenant WITH the capability can still choose the CRM;
//     6. a neighbouring save (a tax label) from a grandfathered tenant never flips it mid-flight;
//     7. a tenant with NO row posting a starting quote number alone is held to the tax rate;
//     8. a tenant with NO row may set a change order fee (its row will be paperwork), while a
//        grandfathered CRM-mode row is still refused one.
//   submit-estimate, a shopper's quote, against the row shapes the plan meets
//     9. a row created under 280's default (paperwork mode, no numbering, no rate): the no_tax_rate
//        refusal that names the Quotes & Invoices card, and NO number taken;
//    10. the same row with a rate and still no numbering: the allocator is asked exactly once and
//        its answer (1000 under 283) is the number the quote is persisted and issued under;
//    11. a grandfathered row with no CRM (today's blocked shape): the old refusal, unchanged;
//    12. a grandfathered row WITH a CRM and without the capability: still the CRM's estimate. There
//        is no read-time override that treats "not allowed" as false;
//    13. no row at all: "hasn't finished setting up quotes yet", unchanged.
//   portal-settings `send_invoice`, a paperwork tenant's first invoice with a blank start
//    14. QuickBooks pushes on (the paid entitlement AND a connected, unbroken company): refused with
//        the sentence that asks for their next QuickBooks number, the claim marked failed, and no
//        number taken; without either half, or with a start set, the allocator is asked as before.
//    15. an entitlement that cannot be read while a company is connected refuses (fails closed); with
//        nothing connected the billing read is never made.
//   portal-settings `push_to_invoice`
//    16. the same QuickBooks refusal (and the fail-closed one) comes BEFORE the rep acceptance, the
//        design promote and the order: a refused push writes none of them.
//   portal-settings `save` and `status`
//    17. a blank start never unsets a counter already in use; an unreadable row refuses the blank.
//    18. status.qboConnected is the connection (realm AND connected_at), and only for settings_crm.
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
import { stubAuth, stubDb, stubRpc, stubStorage } from "./supabase_stub.ts";

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
/** The same row once its owner saved a tax rate and left both numbers blank (allowed since 283). */
const NEW_DEFAULT_TAXED: Row = { ...NEW_DEFAULT, ss_tax_rate: 0.07 };

// ═══ portal-settings ══════════════════════════════════════════════════════════════════════════
type SettingsTrace = { upserts: Record<string, unknown>[]; rows: Record<string, unknown>[] };

/** `failRead`: a client_settings select whose column list matches it answers an error. */
function settingsChain(row: Row, trace: SettingsTrace, table: string, ops: any[][], failRead?: RegExp): any {
  const next = (op: any[]) => settingsChain(row, trace, table, [...ops, op], failRead);
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
        if (failRead && failRead.test(String(arg("select") ?? ""))) return { data: null, error: { message: "harness: settings read failed" } };
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

async function save(payload: Record<string, unknown>, row: Row, failRead?: RegExp) {
  const trace: SettingsTrace = { upserts: [], rows: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => settingsChain(row, trace, table, [], failRead);
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

// Migration 283 (Carolyn 2026-10-06): "if a builder hasn't set a starting number, start at 1000
// automatically". A blank number is stored as NULL ("not chosen") and the allocator turns it into
// 1000 on first use, so the card no longer refuses it. The tax rate is still never guessed.
Deno.test("blank starting numbers save as not chosen (1000 on first use, 283); the rate is still required", async () => {
  for (const [label, row] of [["CRM-connected", GRANDFATHERED_CRM], ["no CRM", GRANDFATHERED_NO_CRM], ["no settings row", null]] as const) {
    for (const over of [{ ssQuoteNext: "", ssInvoiceNext: "" }, { ssQuoteNext: "" }, { ssInvoiceNext: "" }]) {
      const { status, body, trace } = await save(card(over), row);
      assertEquals(status, 200, `${label} ${JSON.stringify(over)}: ${JSON.stringify(body)}`);
      assertEquals(trace.upserts.length, 1, label);
      const up = trace.upserts[0];
      assertEquals(up.invoice_in_ghl, false, label);
      assertEquals(up.ss_quote_next, "ssQuoteNext" in over ? null : 3101, `${label}: a blank quote start is stored NULL, a typed one as typed`);
      assertEquals(up.ss_invoice_next, "ssInvoiceNext" in over ? null : 7001, `${label}: a blank invoice start is stored NULL, a typed one as typed`);
      assertEquals(up.ss_tax_rate, 0.065, label);
    }
    // A blank rate: a sentence and no write, with or without numbers.
    for (const over of [{ ssTaxRate: "" }, { ssTaxRate: "", ssQuoteNext: "", ssInvoiceNext: "" }]) {
      const { status, body, trace } = await save(card(over), row);
      assertEquals(status, 400, `${label} ${JSON.stringify(over)}: ${JSON.stringify(body)}`);
      assert(/needs a sales tax rate/.test(String(body.error)), String(body.error));
      assertFalse(/starting (quote|invoice) number/.test(String(body.error)), "no numbering sentence is left");
      assertEquals(trace.upserts.length, 0, `${label} ${JSON.stringify(over)} wrote nothing`);
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

// The card posts both numbers on every save, so a tab opened while a box was blank would write NULL
// over a counter that has moved since: the allocator's floor then reads only the documents still on
// file, and a number on a deleted design goes out again. A blank against a set counter keeps it.
Deno.test("a blank start never unsets a counter already in use; a read that fails refuses rather than guess", async () => {
  const inUse: Row = { ...NEW_DEFAULT, ss_quote_next: 1043, ss_invoice_next: 2001, ss_tax_rate: 0.065 };
  const { status, body, trace } = await save(card({ ssQuoteNext: "", ssInvoiceNext: "" }), inUse);
  assertEquals(status, 200, JSON.stringify(body));
  const up = trace.upserts[0];
  assertFalse("ss_quote_next" in up, `the quote counter in use was overwritten: ${JSON.stringify(up)}`);
  assertFalse("ss_invoice_next" in up, `the invoice counter in use was overwritten: ${JSON.stringify(up)}`);
  assertEquals(up.ss_quote_prefix, "Q-", "the rest of the card still saves");
  // One set, one not: only the unset one is stored NULL.
  const half = await save(card({ ssQuoteNext: "", ssInvoiceNext: "" }), { ...inUse, ss_invoice_next: null });
  assertEquals(half.status, 200, JSON.stringify(half.body));
  assertFalse("ss_quote_next" in half.trace.upserts[0]);
  assertEquals(half.trace.upserts[0].ss_invoice_next, null);
  // A typed number still replaces it (the floor check owns that case).
  const typed = await save(card({ ssQuoteNext: "1500", ssInvoiceNext: "" }), inUse);
  assertEquals(typed.trace.upserts[0].ss_quote_next, 1500);
  assertFalse("ss_invoice_next" in typed.trace.upserts[0]);
  // The stored counters cannot be read: a blank is refused, nothing is written.
  const blind = await save(card({ ssQuoteNext: "" }), inUse, /\bss_quote_next\b/);
  assertEquals(blind.status, 500, JSON.stringify(blind.body));
  assertEquals(blind.trace.upserts.length, 0);
});

// A tenant with NO row is judged as the row its save creates, which under 280 is paperwork mode.
// Read as "anything but false is the CRM", a lone starting quote number skipped the refusals and
// created a paperwork-mode row with no rate. Since 283 the numbers are optional, so the rate is
// the one thing it is held to.
Deno.test("no settings row: a lone starting quote number is held to the tax rate, and nothing is written", async () => {
  const { status, body, trace } = await save({ ssQuoteNext: "3101" }, null);
  assertEquals(status, 400, JSON.stringify(body));
  assert(/needs a sales tax rate/.test(String(body.error)), String(body.error));
  assertEquals(trace.upserts.length, 0);
  // With the rate, the same lone number saves; the invoice start is simply not chosen yet.
  const withRate = await save({ ssQuoteNext: "3101", ssTaxRate: "6" }, null);
  assertEquals(withRate.status, 200, JSON.stringify(withRate.body));
  assertEquals(withRate.trace.upserts[0].ss_quote_next, 3101);
  assertEquals(withRate.trace.upserts[0].ss_tax_rate, 0.06);
  assertFalse("ss_invoice_next" in withRate.trace.upserts[0], "an invoice start nobody posted is not written");
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

type SubmitTrace = {
  rows: any[]; rpcs: string[]; ghl: { url: string; method: string }[];
  /** Every insert/update/upsert, as { table, verb, payload } (the persisted quote number lands here). */
  writes: { table: string; verb: string; payload: any }[];
  uploads: string[];
};

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
    if (verb !== "select") {
      const payload = ops.find((o) => o[0] === verb)?.[1];
      if (verb !== "delete") trace.writes.push({ table, verb, payload });
      // A designs update that asks for its row back (the draft promote, the guarded persist) found
      // it: the one design this run is about, as the write left it.
      if (table === "designs" && verb === "update" && ops.some((o) => o[0] === "select")) {
        return Promise.resolve({ data: [{ estimate_lines: payload?.estimate_lines ?? null, status: payload?.status ?? "sent" }], error: null }).then(ok, bad);
      }
      return Promise.resolve({ data: [], error: null }).then(ok, bad);
    }
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

/** `quoteNumber` is what allocate_ss_quote_number answers: NULL (123 with a NULL ss_quote_next, or
 *  no row) by default, or the number 283 hands a blank start ("1000"). */
async function submit(row: Row, { quoteNumber = null }: { quoteNumber?: string | null } = {}) {
  const trace: SubmitTrace = { rows: [], rpcs: [], ghl: [], writes: [], uploads: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = null;
  stubAuth.error = null;
  stubDb.from = (table: string) => submitChain(row, trace, table, []);
  // The allocator answers `quoteNumber`. Any other rpc answers nothing.
  stubRpc.rpc = (fn: string) => {
    trace.rpcs.push(fn);
    return Promise.resolve({ data: fn === "allocate_ss_quote_number" ? quoteNumber : null, error: null });
  };
  // The quote document's upload (floor-plans/<client>/<code>-quote.pdf), answered locally.
  stubStorage.from = (bucket: string) => ({
    upload: (path: string) => { trace.uploads.push(`${bucket}/${path}`); return Promise.resolve({ data: { path }, error: null }); },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `${PROJECT}/storage/v1/object/public/${bucket}/${path}` } }),
  });
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
    stubStorage.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const estimateCalls = (t: SubmitTrace) => t.ghl.filter((c) => /\/invoices\/estimate/.test(c.url));

// 283 turns a blank start into 1000, so the allocation now waits until the sales tax is decided:
// a refusal for want of a rate must not burn 1000, 1001, 1002 … one shopper attempt at a time.
Deno.test("a row created under 280's default with no rate: no_tax_rate, names the card, and NO number is taken", async () => {
  const { status, body, trace } = await submit(NEW_DEFAULT, { quoteNumber: "1000" });
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.reason, "no_tax_rate");
  assert(/Settings → CRM Connection → Quotes & Invoices/.test(String(body.error)), String(body.error));
  assertEquals(trace.rpcs.filter((f) => f === "allocate_ss_quote_number").length, 0, "the allocator was never asked");
  assertFalse(trace.writes.some((w) => w.table === "designs"), "nothing was written to the design");
  assertEquals(trace.ghl.length, 0, "no CRM is connected, so nothing went to one");
});

Deno.test("the same row with a rate and blank numbers: asked once, and 1000 is the number the quote goes out under", async () => {
  const { status, body, trace } = await submit(NEW_DEFAULT_TAXED, { quoteNumber: "1000" });
  assertEquals(trace.rpcs.filter((f) => f === "allocate_ss_quote_number").length, 1, `asked for a number exactly once: ${JSON.stringify(trace.rpcs)}`);
  const persisted = trace.writes.filter((w) => w.table === "designs" && w.payload && "ss_quote_number" in w.payload).map((w) => w.payload.ss_quote_number);
  assert(persisted.length >= 1, `the number reached the design: ${JSON.stringify(trace.writes.map((w) => [w.table, w.verb]))}`);
  assert(persisted.every((n) => n === "1000"), `every write carries 1000: ${JSON.stringify(persisted)}`);
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.estimateNumber, "1000");
  assertEquals(body.quoteNumber, "1000");
  assertEquals(trace.ghl.length, 0, "no CRM is connected, so nothing went to one");
});

Deno.test("defensive: an allocator that still answers NULL (123 live, 283 not applied) refuses without inventing a number", async () => {
  const { status, body, trace } = await submit(NEW_DEFAULT_TAXED, { quoteNumber: null });
  assertEquals(status, 400, JSON.stringify(body));
  assert(/couldn't issue a quote number/.test(String(body.error)), String(body.error));
  assertEquals(trace.rpcs.filter((f) => f === "allocate_ss_quote_number").length, 1);
  assertFalse(trace.writes.some((w) => w.table === "designs"), "nothing was written to the design");
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

// ═══ portal-settings send_invoice: QuickBooks and a blank invoice start ═══════════════════════
// Since 283 a blank invoice start is allocated as 1000. The books push then hands that number to
// QuickBooks as the DocNumber, and pushQboInvoice adopts any QuickBooks invoice already carrying it
// (_shared/qboInvoice.ts). So while the push would run, send_invoice asks for the builder's next
// QuickBooks number instead. "Would run" is the push's own two dark guards, BOTH: the paid
// quickbooks_sync entitlement (qboPushAllowed) AND a connected, unbroken company (getQboConnection).
// A builder who pays for QuickBooks but never connected it must not be told "You're connected".
//
// Driven through the real handler as the owner, on an accepted design with its quote issued, as far
// as the number: the allocator answers NULL here (nothing past the number is under test), so a run
// that reaches it ends on the defensive refusal and is told apart from the QuickBooks one by text.
const QBO_SENTENCE = "You're connected to QuickBooks, so set your next invoice number first (Settings → CRM Connection → Quotes & Invoices). Starting at 1000 could reuse an invoice number already in QuickBooks.";
const INVOICE_CODE = "SS-PDMINV00001";
const ACCEPTED_DESIGN = {
  client_id: T, short_code: INVOICE_CODE, status: "accepted", accepted_at: "2026-10-01T15:00:00Z", updated_at: "2026-10-01T15:00:00Z",
  ss_quote_number: "1000", ss_quote_pdf_url: null, image_url: null, inventory_unit_id: null,
  estimate_lines: { lines: [{ name: "Econo 10x12", qty: 1, amount: 3000, taxable: true }], discount: 0 },
  accepted_snapshot: null, selections: {}, paint_colors: {}, contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
};
/** A paperwork tenant with a rate and a blank invoice start, plus the QuickBooks knobs under test. */
const invoiceRow = (o: { paid: boolean; connected: boolean; broken?: boolean; invoiceNext?: number | null }): Record<string, unknown> => ({
  ...NEW_DEFAULT_TAXED, ss_quote_next: 1001, ss_invoice_next: o.invoiceNext ?? null,
  // hasPaidFeature: billing_exempt confers every feature (228), the shortest honest "paid".
  billing_exempt: o.paid, internal_account: false,
  qbo_realm_id: o.connected ? "realm-harness" : null, qbo_connected_at: o.connected ? "2026-09-01T00:00:00Z" : null,
  qbo_refresh_error: o.broken ? "invalid_grant" : null,
});
type InvoiceTrace = {
  rpcs: string[]; claims: any[]; claimUpdates: any[]; rows: any[];
  /** Every other insert/update/upsert/delete, as [table, verb]: the push_to_invoice attestation's
   *  acceptance row, design promote and order land here. */
  writes: [string, string][];
};
/** The world one send_invoice / push_to_invoice / status call runs in. */
type InvoiceWorld = {
  design?: Record<string, unknown>;
  /** The caller's client_users row (default: the owner). */
  caller?: Record<string, unknown>;
  /** billing_plans answers an error: the quickbooks_sync entitlement cannot be read. */
  failBilling?: boolean;
};

function invoiceChain(row: Record<string, unknown>, trace: InvoiceTrace, table: string, ops: any[][], world: InvoiceWorld = {}): any {
  const next = (op: any[]) => invoiceChain(row, trace, table, [...ops, op], world);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const has = (op: string) => ops.some((o) => o[0] === op);
    const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
    const one = has("maybeSingle") || has("single");
    const answer = () => {
      if (table === "app_errors") { trace.rows.push(arg("insert")); return { data: null, error: null }; }
      if (table === "client_users") {
        return { data: [world.caller ?? { client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null, full_name: "Owner Example" }], error: null };
      }
      if (table === "billing_plans" && world.failBilling) return { data: null, error: { message: "harness: billing read failed" } };
      if (table === "client_settings") return { data: has("select") ? row : null, error: null };
      const design = world.design ?? ACCEPTED_DESIGN;
      if (table === "invoice_sends") {
        if (has("insert")) { trace.claims.push(arg("insert")); return { data: null, error: null }; }
        if (has("update")) { trace.claimUpdates.push(arg("update")); return { data: [{ short_code: INVOICE_CODE }], error: null }; }
      }
      for (const verb of ["insert", "update", "upsert", "delete"]) if (has(verb)) trace.writes.push([table, verb]);
      if (table === "designs" && has("select") && !has("update")) return { data: one ? design : [design], error: null };
      // change_orders (none pending), orders, billing_plans …: nothing on file.
      return { data: one ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

async function sendInvoice(row: Record<string, unknown>, world: InvoiceWorld = {}, payload: Record<string, unknown> = { action: "send_invoice", shortCode: INVOICE_CODE }) {
  const trace: InvoiceTrace = { rpcs: [], claims: [], claimUpdates: [], rows: [], writes: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => invoiceChain(row, trace, table, [], world);
  stubRpc.rpc = (fn: string) => {
    trace.rpcs.push(fn);
    return Promise.resolve({ data: null, error: null });
  };
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await SETTINGS_HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
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
const allocations = (t: InvoiceTrace) => t.rpcs.filter((f) => f === "allocate_ss_invoice_number").length;

Deno.test("send_invoice: QuickBooks paid AND connected with a blank invoice start is refused before any number is taken", async () => {
  const { status, body, trace } = await sendInvoice(invoiceRow({ paid: true, connected: true }));
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, QBO_SENTENCE);
  assertEquals(allocations(trace), 0, "no invoice number was allocated");
  assertEquals(trace.claims.length, 1, "the send was claimed first, as every send is");
  assert(trace.claimUpdates.some((u) => u.status === "failed" && u.error === "qbo needs invoice start"),
    `the claim is marked failed so the next press starts clean: ${JSON.stringify(trace.claimUpdates)}`);
});

Deno.test("send_invoice: without either half of the push guard, or with a start set, the allocator is asked as before", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["not paid, connected", invoiceRow({ paid: false, connected: true })],
    ["paid, never connected (the entitlement alone is not a connection)", invoiceRow({ paid: true, connected: false })],
    ["paid, connected but broken (the push is dark)", invoiceRow({ paid: true, connected: true, broken: true })],
    ["paid and connected, invoice start set", invoiceRow({ paid: true, connected: true, invoiceNext: 7001 })],
  ];
  for (const [label, row] of cases) {
    const { body, trace } = await sendInvoice(row);
    assertEquals(allocations(trace), 1, `${label}: the allocator is asked once (${JSON.stringify(body)})`);
    assertFalse(String(body.error ?? "").includes("QuickBooks"), `${label}: no QuickBooks refusal: ${JSON.stringify(body)}`);
  }
});

// FAILS CLOSED. qboPushAllowed answers false on a billing-read error; used here, that let 1000
// through while the push further down, reading again, could succeed and send it. The guard reads the
// entitlement itself and refuses when it cannot. The connection is judged first and from the row
// already read, so a tenant with nothing connected never reaches the billing read at all.
Deno.test("send_invoice: an unreadable QuickBooks entitlement refuses (fails closed); with nothing connected it is never read", async () => {
  const blind = await sendInvoice(invoiceRow({ paid: false, connected: true }), { failBilling: true });
  assertEquals(blind.status, 502, JSON.stringify(blind.body));
  assert(String(blind.body.error).includes("check your QuickBooks plan"), String(blind.body.error));
  assertEquals(allocations(blind.trace), 0, "a number was taken while the entitlement could not be read");
  assert(blind.trace.claimUpdates.some((u) => u.status === "failed" && u.error === "qbo entitlement unreadable"),
    `the claim is marked failed: ${JSON.stringify(blind.trace.claimUpdates)}`);
  // Not connected: the guard has its answer before the billing read, so the failing read is never made.
  const dark = await sendInvoice(invoiceRow({ paid: false, connected: false }), { failBilling: true });
  assertEquals(allocations(dark.trace), 1, `the allocator is asked as before: ${JSON.stringify(dark.body)}`);
});

// push_to_invoice records a rep acceptance, promotes the design and opens its order BEFORE the
// number is allocated. The QuickBooks refusal is a normal outcome since 283 (a blank start saves),
// so it is asked before any of that, beside the missing-phone refusal and for the same reason.
const SENT_DESIGN = { ...ACCEPTED_DESIGN, status: "sent", accepted_at: null };
const pushToInvoice = (row: Record<string, unknown>, world: InvoiceWorld = {}) =>
  sendInvoice(row, { design: SENT_DESIGN, ...world }, { action: "push_to_invoice", shortCode: INVOICE_CODE });
const ATTEST_TABLES = ["design_acceptances", "designs", "orders", "admin_audit"];

Deno.test("push_to_invoice: QuickBooks paid AND connected with a blank start is refused before the acceptance is written", async () => {
  const { status, body, trace } = await pushToInvoice(invoiceRow({ paid: true, connected: true }));
  assertEquals(status, 400, JSON.stringify(body));
  assertEquals(body.error, QBO_SENTENCE);
  assertEquals(trace.writes.filter(([t]) => ATTEST_TABLES.includes(t)), [], "an acceptance, promote, order or audit was written for a refused push");
  assertEquals(trace.claims.length, 0, "no invoice send was claimed");
  assertEquals(allocations(trace), 0);
});

Deno.test("push_to_invoice: an unreadable entitlement refuses before the acceptance too", async () => {
  const { status, body, trace } = await pushToInvoice(invoiceRow({ paid: false, connected: true }), { failBilling: true });
  assertEquals(status, 502, JSON.stringify(body));
  assertEquals(trace.writes.filter(([t]) => ATTEST_TABLES.includes(t)), []);
  assertEquals(trace.claims.length, 0);
});

Deno.test("push_to_invoice: with a start set, or nothing connected, the attestation goes ahead as before", async () => {
  for (const [label, row] of [
    ["start set", invoiceRow({ paid: true, connected: true, invoiceNext: 7001 })],
    ["paid, never connected", invoiceRow({ paid: true, connected: false })],
  ] as const) {
    const { body, trace } = await pushToInvoice(row);
    assertFalse(String(body.error ?? "").includes("QuickBooks"), `${label}: ${JSON.stringify(body)}`);
    assert(trace.writes.some(([t, v]) => t === "design_acceptances" && v === "insert"), `${label}: the rep acceptance was not written: ${JSON.stringify(trace.writes)}`);
  }
});

// The card's QuickBooks line reads status.qboConnected. It must follow the CONNECTION (realm AND
// connected_at, getQboConnection's test), never the realm alone (the tombstone a disconnect leaves)
// nor the entitlement, and it rides the settings_crm block like the rest of the numbering card.
Deno.test("status: qboConnected is the connection (realm AND connected_at), and only for settings_crm", async () => {
  const at = "2026-09-01T00:00:00Z";
  for (const [label, qbo, expected] of [
    ["connected", { qbo_realm_id: "realm-harness", qbo_connected_at: at }, true],
    ["disconnected (the realm survives as a tombstone)", { qbo_realm_id: "realm-harness", qbo_connected_at: null }, false],
    ["never connected, though paid", { qbo_realm_id: null, qbo_connected_at: null, billing_exempt: true }, false],
  ] as const) {
    const { status, body } = await sendInvoice({ ...NEW_DEFAULT_TAXED, ...qbo }, {}, { action: "status" });
    assertEquals(status, 200, `${label}: ${JSON.stringify(body)}`);
    assertEquals(body.qboConnected, expected, label);
  }
  const driver = await sendInvoice({ ...NEW_DEFAULT_TAXED, qbo_realm_id: "realm-harness", qbo_connected_at: at }, {
    caller: { client_id: T, role: "user", title: "driver", access: null, user_id: "u1", prefs: null, full_name: "Driver Example" },
  }, { action: "status" });
  assertEquals(driver.status, 200, JSON.stringify(driver.body));
  assertFalse("qboConnected" in driver.body, "a caller without settings_crm is told about the QuickBooks connection");
  assertFalse("ssInvoiceNext" in driver.body, "the numbering card's fields left the settings_crm block");
});
