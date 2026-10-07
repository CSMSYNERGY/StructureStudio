// The formal estimate form, driven through the SHIPPED portal-settings handler (2026-10-05,
// Carolyn 2026-08-06: "a nice estimate form" with the letterhead, the customer's name and
// "estimate good for X amount of days").
//
// WHAT THIS PINS, against the real handler rather than the builder alone:
//
//   1. status hands the Settings card quoteValidDays from its own tolerant read, and null (box
//      hidden) when the database has no such column yet, while every other field still loads.
//   2. save writes quote_valid_days only when asked, puts 30 back for a blank, and refuses
//      anything but a whole number of days from 1 to 365 with a sentence and NO write.
//   3. A quote this function re-prints (regenerateQuotePdf, here through void_change_order) carries
//      "Prepared for" with the customer on the design, "Valid until" from the tenant's setting and
//      the tenant's logo, fetched from Storage's scaled copy of THIS tenant's branding folder only.
//      With 269 missing it still prints, at 30 days.
//   4. A reissued invoice (reissue_invoice) carries "Bill to", the same customer and the logo, and
//      no "Valid until".
//   5. A logo stored anywhere else (another site, another tenant's folder) is never fetched.
//   6. A legacy six-character share code (migration 156) re-prints with no customer at all, on the
//      quote or the invoice: those PDFs sit in the public bucket under a key derived from the code
//      alone, so printing the customer there would undo 156's redaction.
//
// HOW. The deleteDesignWiring_test idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the action's branch as it
// does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubStorage
// route every table and storage call into the fakes below. fetch answers the logo and nothing
// else, and no --allow-net is granted, so nothing leaves the box. Nothing is emailed: the reissue
// runs with sendEmail:false.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants, codes, numbers and the customer are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubStorage } from "./supabase_stub.ts";
import { pdfText } from "./pdfText.ts";
import { makePng } from "./pngFixture.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const T = "acme-sheds";
// A code as genShortCode makes them today (10 characters). LEGACY is one of the 48 six-character
// codes migration 156 redacts.
const CODE = "SS-ABCD2345EF";
const LEGACY = "SS-ABC234";
const PROJECT = "https://stub.supabase.co";
const FLOOR = `${PROJECT}/storage/v1/object/public/floor-plans/`;
const OUR_LOGO = `${PROJECT}/storage/v1/object/public/branding/${T}/biz-logo-0f1e2d3c.png`;
const SCALED_LOGO = `${PROJECT}/storage/v1/render/image/public/branding/${T}/biz-logo-0f1e2d3c.png?width=640&height=200&resize=contain&format=origin`;
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const CONTACT = {
  name: "Pat Example", email: "pat@example.test", phone: "(555) 010-0199",
  street: "42 Sample Lane", city: "Springfield", state: "OH", zip: "45501",
};
const LINES = {
  version: 1, discount: 0,
  lines: [
    { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "Base building", qty: 1, amount: 8950 },
    { kind: "door", itemKey: "door-9lite", name: "9-Lite Entry Door", desc: "", qty: 1, amount: 385 },
  ],
};
const SETTINGS = {
  business_name: "Acme Sheds", business_phone: "(555) 010-0100", business_website: "acme-sheds.example.test",
  business_address: { addressLine1: "100 Example Rd", city: "Springfield", state: "OH", postalCode: "45500" },
  business_logo_url: OUR_LOGO, quote_terms: "Deposit due at signing.", co_fee_label: null, email_template_copy: null,
};

type World = {
  validDays?: number;            // client_settings.quote_valid_days
  noColumn?: boolean;            // the database has no quote_valid_days (a deploy ahead of 269)
  logoUrl?: string | null;       // overrides SETTINGS.business_logo_url
  contact?: Record<string, unknown> | null;
  code?: string;                 // the design's short code, CODE unless a test says otherwise
};
type Trace = {
  events: string[];
  upserts: Record<string, unknown>[];
  uploads: { path: string; bytes: Uint8Array }[];
  fetched: string[];
  rows: Record<string, unknown>[]; // app_errors
};

const MISSING = { code: "42703", message: "column client_settings.quote_valid_days does not exist" };

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const cols = String(arg("select") ?? "");
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
  if (table === "admin_audit") return { data: null, error: null };
  if (table === "client_settings") {
    if (has("upsert")) { trace.upserts.push(arg("upsert")); return { data: null, error: world.noColumn && "quote_valid_days" in arg("upsert") ? MISSING : null }; }
    if (/\bquote_valid_days\b/.test(cols)) {
      return world.noColumn ? { data: null, error: MISSING } : { data: { quote_valid_days: world.validDays ?? 30 }, error: null };
    }
    const logo = world.logoUrl === undefined ? SETTINGS.business_logo_url : world.logoUrl;
    return { data: { ...SETTINGS, business_logo_url: logo, invoice_in_ghl: false, ghl_invoicing_allowed: false }, error: null };
  }
  if (table === "client_configs") return { data: { company_name: "Acme Sheds" }, error: null };
  if (table === "designs") {
    if (has("update")) return { data: null, error: null };
    const contact = world.contact === undefined ? CONTACT : world.contact;
    return {
      data: {
        short_code: world.code ?? CODE, status: "accepted", ss_quote_number: "SST-1001", image_url: null, contact,
        estimate_lines: LINES, accepted_snapshot: LINES, items: [], custom_options: [], ro_dimensions: [],
        bldg_w: 12, bldg_h: 24, inventory_unit_id: null,
      },
      error: null,
    };
  }
  if (table === "design_versions") return has("insert") ? { data: null, error: null } : { data: { version: 3 }, error: null };
  if (table === "design_acceptances") return { data: null, error: null };
  if (table === "change_orders") {
    if (has("update")) return { data: [{ id: "00000000-0000-4000-8000-0000000000c1" }], error: null };
    if (cols.startsWith("id, short_code, co_no")) {
      return {
        data: { id: "00000000-0000-4000-8000-0000000000c1", short_code: world.code ?? CODE, co_no: 2, status: "pending_ack",
          snapshot_before: { estimateLines: LINES, selections: null, paintColors: null } },
        error: null,
      };
    }
    return { data: [], error: null }; // no pending, no acknowledged change orders
  }
  if (table === "invoice_sends") {
    if (has("update")) return { data: null, error: null };
    return { data: { invoice_number: "SSI-2001", invoice_pdf_url: `${FLOOR}${T}/${world.code ?? CODE}-invoice.pdf`, issued_by: "structurestudio", status: "sent" }, error: null };
  }
  if (table === "orders") return { data: { total_cents: 933500, pretax_subtotal_cents: 933500 }, error: null };
  // Anything else answers empty rather than throwing: these tests are about the documents, and a
  // read this file does not model must not be mistaken for one that failed.
  trace.events.push(`unmodelled:${table}:${cols.slice(0, 40)}`);
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.rows.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    trace.events.push(`db:${table}:${verb}`);
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

function bucket(trace: Trace) {
  return (name: string) => ({
    upload(path: string, bytes: Uint8Array) {
      trace.events.push(`storage:${name}:upload`);
      trace.uploads.push({ path, bytes });
      return Promise.resolve({ data: { path }, error: null });
    },
    getPublicUrl(path: string) {
      return { data: { publicUrl: `${PROJECT}/storage/v1/object/public/${name}/${path}` } };
    },
    download() {
      return Promise.resolve({ data: null, error: { message: "not modelled" } });
    },
  });
}

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { events: [], upserts: [], uploads: [], fetched: [], rows: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  stubStorage.from = bucket(trace);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    trace.fetched.push(url);
    if (url === SCALED_LOGO) {
      return Promise.resolve(new Response(makePng(314, 200).slice().buffer as ArrayBuffer, { status: 200, headers: { "content-type": "image/png" } }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubStorage.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const imageCount = (bytes: Uint8Array) => (new TextDecoder("latin1").decode(bytes).match(/\/Subtype \/Image/g) ?? []).length;
const validUntil = (t: string) => /Valid until: ([A-Za-z]+ \d+, \d{4})/.exec(t)?.[1] ?? null;
const issued = (t: string) => /Issued: ([A-Za-z]+ \d+, \d{4})/.exec(t)?.[1] ?? null;
const plusDays = (label: string, days: number) => {
  const d = new Date(Date.parse(`${label} 12:00 UTC`) + days * 86_400_000);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

// ─── 1. status ─────────────────────────────────────────────────────────────────────────────────
Deno.test("status hands the Settings card the tenant's number of days", async () => {
  const { status, body } = await drive({ action: "status" }, { validDays: 14 });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.quoteValidDays, 14);
  assertEquals(body.quoteTerms, "Deposit due at signing.", "the rest of the card still loads");
});

Deno.test("status on a database without 269: null (the box hides) and the rest of the portal still boots", async () => {
  const { status, body, trace } = await drive({ action: "status" }, { noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.quoteValidDays, null);
  assertEquals(body.businessName, "Acme Sheds");
  assertEquals(trace.rows.length, 0, "a column that is not there yet is not an error for support");
});

// ─── 2. save ───────────────────────────────────────────────────────────────────────────────────
Deno.test("save writes quote_valid_days when asked, and 30 for a blank", async () => {
  for (const [sent, stored] of [[14, 14], ["60", 60], [365, 365], [1, 1], ["", 30], [null, 30]] as const) {
    const { status, body, trace } = await drive({ action: "save", quoteValidDays: sent });
    assertEquals(status, 200, `${JSON.stringify(sent)}: ${JSON.stringify(body)}`);
    assertEquals(trace.upserts.length, 1);
    assertEquals(trace.upserts[0].quote_valid_days, stored, `sent ${JSON.stringify(sent)}`);
  }
});

Deno.test("save refuses anything but a whole number of days from 1 to 365, with a sentence and no write", async () => {
  for (const sent of [0, 366, -3, 7.5, "7.5", "two weeks", true]) {
    const { status, body, trace } = await drive({ action: "save", quoteValidDays: sent });
    assertEquals(status, 400, `${JSON.stringify(sent)}: ${JSON.stringify(body)}`);
    assertEquals(body.error, "Estimates have to stay good for a whole number of days, from 1 to 365.");
    assertEquals(trace.upserts.length, 0, `${JSON.stringify(sent)} wrote nothing`);
  }
});

Deno.test("a save that does not mention it never names the column (the page and server can ship ahead of 269)", async () => {
  const { status, trace } = await drive({ action: "save", quoteTerms: "New terms." }, { noColumn: true });
  assertEquals(status, 200);
  assert(!("quote_valid_days" in trace.upserts[0]), JSON.stringify(trace.upserts[0]));
});

// ─── 3. a re-printed quote ─────────────────────────────────────────────────────────────────────
async function reprint(world: World) {
  const out = await drive({ action: "void_change_order", changeOrderId: "00000000-0000-4000-8000-0000000000c1", reason: "Customer changed their mind" }, world);
  assertEquals(out.status, 200, JSON.stringify(out.body));
  const up = out.trace.uploads.find((u) => u.path === `${T}/${world.code ?? CODE}-quote.pdf`);
  assert(up, `the quote PDF was re-printed at its fixed path; uploads: ${JSON.stringify(out.trace.uploads.map((u) => u.path))}`);
  return { ...out, pdf: up!.bytes, text: await pdfText(up!.bytes) };
}

Deno.test("a re-printed quote carries Prepared for, the tenant's validity and the tenant's logo", async () => {
  const { pdf, text, trace } = await reprint({ validDays: 14 });
  for (const s of ["Prepared for", "Pat Example", "42 Sample Lane", "Springfield, OH 45501", "(555) 010-0199", "pat@example.test"]) {
    assert(text.includes(s), `"${s}" is on the re-printed quote`);
  }
  assertEquals(validUntil(text), plusDays(issued(text)!, 14), "Valid until is the issue date + the tenant's 14 days");
  assertEquals(imageCount(pdf), 1, "the logo is on it");
  assertEquals(trace.fetched, [SCALED_LOGO], "only Storage's scaled copy of this tenant's own logo was fetched");
});

Deno.test("a re-printed quote on a database without 269 still prints, at 30 days", async () => {
  const { text } = await reprint({ noColumn: true });
  assert(text.includes("Estimate #SST-1001"));
  assertEquals(validUntil(text), plusDays(issued(text)!, 30));
});

Deno.test("a design with no contact re-prints without a customer block, never 'undefined'", async () => {
  const { text } = await reprint({ contact: null });
  assert(!text.includes("Prepared for"), "no block");
  assert(!/\bundefined\b|\bnull\b/.test(text), "no placeholder words");
});

Deno.test("a logo stored anywhere but this tenant's branding folder is never fetched", async () => {
  for (const logoUrl of [
    "https://cdn.example.test/logo.png",
    `${PROJECT}/storage/v1/object/public/branding/other-sheds/biz-logo-1.png`,
    `${PROJECT}/storage/v1/object/public/branding/${T}/../other-sheds/biz-logo-1.png`,
    null,
  ]) {
    const { pdf, trace } = await reprint({ logoUrl });
    assertEquals(trace.fetched, [], `${logoUrl}: nothing fetched`);
    assertEquals(imageCount(pdf), 0, `${logoUrl}: the text letterhead`);
  }
});

// ─── 4. a reissued invoice ─────────────────────────────────────────────────────────────────────
Deno.test("a reissued invoice carries Bill to, the customer and the logo, and no Valid until", async () => {
  const { status, body, trace } = await drive({ action: "reissue_invoice", shortCode: CODE, sendEmail: false }, { validDays: 14 });
  assertEquals(status, 200, JSON.stringify(body));
  const up = trace.uploads.find((u) => u.path === `${T}/${CODE}-invoice.pdf`);
  assert(up, `the invoice was rebuilt; uploads: ${JSON.stringify(trace.uploads.map((u) => u.path))}`);
  const text = await pdfText(up!.bytes);
  assert(text.includes("Invoice #SSI-2001"), "titled Invoice");
  assert(text.includes("Bill to") && text.includes("Pat Example") && text.includes("42 Sample Lane"), "Bill to, with the customer");
  assert(!text.includes("Prepared for") && !text.includes("Valid until"), "an invoice is not an offer");
  assertEquals(imageCount(up!.bytes), 1, "the logo is on it");
  assertEquals(trace.fetched, [SCALED_LOGO]);
});

// ─── 6. a legacy six-character code ────────────────────────────────────────────────────────────
Deno.test("a legacy six-character code re-prints its quote with no customer, and everything else", async () => {
  const { pdf, text } = await reprint({ validDays: 14, code: LEGACY });
  for (const s of ["Prepared for", "Pat Example", "42 Sample Lane", "(555) 010-0199", "pat@example.test"]) {
    assert(!text.includes(s), `"${s}" is NOT on a legacy code's quote`);
  }
  assert(text.includes("Estimate #SST-1001"));
  assertEquals(validUntil(text), plusDays(issued(text)!, 14), "the validity still prints");
  assertEquals(imageCount(pdf), 1, "and the logo");
});

Deno.test("a legacy six-character code's reissued invoice has no Bill to and no customer", async () => {
  const { status, body, trace } = await drive({ action: "reissue_invoice", shortCode: LEGACY, sendEmail: false }, { code: LEGACY });
  assertEquals(status, 200, JSON.stringify(body));
  const up = trace.uploads.find((u) => u.path === `${T}/${LEGACY}-invoice.pdf`);
  assert(up, `the invoice was rebuilt; uploads: ${JSON.stringify(trace.uploads.map((u) => u.path))}`);
  const text = await pdfText(up!.bytes);
  assert(text.includes("Invoice #SSI-2001"), "titled Invoice");
  for (const s of ["Bill to", "Pat Example", "42 Sample Lane", "pat@example.test"]) assert(!text.includes(s), `"${s}" is NOT on it`);
});
