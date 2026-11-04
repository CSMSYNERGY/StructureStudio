// The pinned CRM sender (client_settings.ghl_sender_user_id, migration 356), driven through the
// SHIPPED submit-estimate handler.
//
// WHAT IS PINNED, each against the real handler:
//   1. ABSENT MEANS TODAY. No pin: the estimate and its send go out as products[0].createdBy, and no
//      extra CRM call is made.
//   2. A PIN WINS. The estimate create and the send both carry it. Nothing else about the send
//      changes: same action, same recipient, and the floor plan PDF stays on the estimate, which is
//      the point of routing around the mailbox.
//   3. A PIN GHL NO LONGER LISTS never costs the quote: it goes out as the default user, with one
//      error row that names no id, because the email may be back on the route the pin was avoiding.
//   4. A LIST WE COULD NOT GET says nothing about the user: the pin stands, with no error row.
//   5. BEFORE THE MIGRATION the column read answers 42703. The quote still goes out as it does today,
//      which also proves submit-estimate's main settings select does not name the column.
//   6. SS MODE never reads the column or asks GHL for users.
//
// HOW. The submitEstimatePriceOverrideWiring_test idiom: Deno.serve is stubbed while
// submit-estimate/index.ts is imported, so a request runs through withErrorLog and every step as it
// does live. stubDb routes every table into the fake below, and fetch answers the CRM's endpoints
// locally. No --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check submit-estimate against the stub's partial client type.
//
// Tenants, people and codes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

// ─── The real handler ───────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../submit-estimate/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("submit-estimate did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The tenant ─────────────────────────────────────
const T = "acme-sheds";
const CODE = "SS-PRC234ABCD";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const ANON_KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "anon", iss: "supabase" })}.c2ln`;
const PDF_URL = `${ENV.SUPABASE_URL}/storage/v1/object/public/floor-plans/${T}/${CODE}-1.pdf`;
const CUSTOMER = "pat@example.test";

const CREATOR = "ghl-user-creator";
const PIN = "ghl-user-no-mailbox";

type World = {
  /** The stored value. Absent: a tenant with no pin. */
  pin?: string | null;
  /** False: the database has no such column yet, so naming it answers 42703. */
  column?: boolean;
  /** What GET /users/ answers. Default: both users, 200. */
  users?: unknown[];
  usersStatus?: number;
  invoiceInGhl?: boolean;
};
type Trace = {
  rows: any[];
  settingsSelects: string[];
  ghl: { url: string; method: string; body: any }[];
};

const settingsRow = (world: World) => ({
  client_id: T, ghl_location_id: "loc-1", ghl_api_key: "harness-key", ghl_pipeline_id: null, ghl_stage_send_quote_id: null,
  business_name: "Acme Sheds", business_phone: "", business_website: "", business_address: null, business_logo_url: "",
  quote_terms: "", beta_mode: false, beta_email: null, ramp_price: 0, ramp_price_method: "each", ramp_image_url: null,
  ramp_show_image: false, email_provider: "ghl", email_domain_status: null, email_domain: null, email_from_local: null,
  email_from_name: null, invoice_in_ghl: world.invoiceInGhl !== false, email_template_copy: null, ss_tax_rate: null, ss_tax_label: null,
  ss_tax_delivery: false, quote_valid_days: 30, insulation_enabled: false,
  ...(world.column === false ? {} : { ghl_sender_user_id: world.pin ?? null }),
});

function tableRows(world: World, table: string): any[] | null {
  switch (table) {
    case "client_settings": return [settingsRow(world)];
    case "designs": return [{
      client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-05T10:00:00Z", ghl_contact_id: null,
      ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
      accepted_at: null, estimate_lines: null, accepted_snapshot: null,
    }];
    case "client_users": return [];
    case "app_operators": return [];
    case "building_styles": return [{ id: "st-econo", key: "econo", label: "Econo", image_url: null, show_image_on_estimate: false, taxable: true, d3: { wallHeightFt: 8 } }];
    case "building_sizes": return [{ id: "sz-1012", style_id: "st-econo", base_price: 3000, label: "10x12", width_ft: 10, length_ft: 12 }];
    case "layout_item_pricing": return [];
    case "building_size_inclusions": return [];
    case "client_layout_items": return [];
    case "fixture_items": return [];
    case "colors": return [];
    case "window_colors": return [];
    case "style_wall_heights": return [];
    default: return null;   // delivery_settings, rate_buckets, crm_contacts, builder_locations …: nothing on file
  }
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle", "gte", "lte", "gt", "lt", "not", "or", "range", "ilike", "contains"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    if (table === "app_errors" && verb === "insert") {
      trace.rows.push(ops.find((o) => o[0] === "insert")?.[1]);
      return Promise.resolve({ data: null, error: null }).then(ok, bad);
    }
    if (verb !== "select") return Promise.resolve({ data: [], error: null }).then(ok, bad);
    if (table === "client_settings") {
      const cols = String(ops.find((o) => o[0] === "select")?.[1] ?? "");
      trace.settingsSelects.push(cols);
      if (world.column === false && cols.includes("ghl_sender_user_id")) {
        return Promise.resolve({ data: null, error: { code: "42703", message: "column client_settings.ghl_sender_user_id does not exist" } }).then(ok, bad);
      }
    }
    let rows = tableRows(world, table);
    const one = ops.some((o) => o[0] === "single" || o[0] === "maybeSingle");
    if (rows == null) return Promise.resolve({ data: one ? null : [], error: null }).then(ok, bad);
    for (const o of ops) {
      if (o[0] === "eq") rows = rows.filter((r) => !(o[1] in r) || r[o[1]] === o[2]);
      if (o[0] === "in") rows = rows.filter((r) => !(o[1] in r) || (o[2] as unknown[]).includes(r[o[1]]));
    }
    return Promise.resolve({ data: one ? (rows[0] ?? null) : rows, error: null }).then(ok, bad);
  };
  return q;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PAYLOAD = {
  designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [], imageUrl: PDF_URL,
  contact: { name: "Pat Example", email: CUSTOMER, phone: "5550100100" },
  selections: { buildingStyle: "econo", buildingSize: "10x12", paint: "Unpainted" },
  doors: [], ramps: [], windows: [],
  itemSummary: { singleDoors: 0, doubleDoors: 0, windows: 0, workbenches: [], shelves: [], doubleShelves: [], electricalItems: [], lofts: 0, loftSqft: 0, ramp: 0, lines: 0, notes: [] },
  customOptions: [], discounts: [], roughOpenings: [],
};

async function submit(world: World) {
  const trace: Trace = { rows: [], settingsSelects: [], ghl: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = null;
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://services.leadconnectorhq.com/")) throw new Error(`unexpected fetch: ${url}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    trace.ghl.push({ url, method: String(init?.method ?? "GET"), body });
    if (url.endsWith("/contacts/upsert")) return Promise.resolve(json({ contact: { id: "contact-1" } }));
    if (url.includes("/products/")) return Promise.resolve(json({ products: [{ createdBy: CREATOR, locationId: "loc-1" }] }));
    if (url.includes("/users/")) return Promise.resolve(json({ users: world.users ?? [{ id: CREATOR }, { id: PIN }] }, world.usersStatus ?? 200));
    if (url.includes("/opportunities/search")) return Promise.resolve(json({ opportunities: [] }));
    if (url.endsWith("/opportunities/")) return Promise.resolve(json({ opportunity: { id: "opp-1" } }));
    if (/\/invoices\/estimate$/.test(url)) return Promise.resolve(json({ _id: "est-1", estimateNumber: 1001 }));
    if (url.endsWith("/send")) return Promise.resolve(json({ ok: true }, 201));
    return Promise.resolve(json({}));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/submit-estimate", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "harness/1.0", authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify(PAYLOAD),
    }));
    const body = await res.json();
    const estimate = trace.ghl.find((c) => /\/invoices\/estimate$/.test(c.url))?.body ?? null;
    const send = trace.ghl.find((c) => c.url.endsWith("/send"))?.body ?? null;
    const usersCalls = trace.ghl.filter((c) => c.url.includes("/users/")).length;
    const pinRows = trace.rows.flat().filter((r: any) => r?.code === "ghl_sender_pin_stale");
    return { status: res.status, body, trace, estimate, send, usersCalls, pinRows };
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

Deno.test("no pin: the estimate and its send go out as the product's creator, with no extra CRM call", async () => {
  for (const pin of [undefined, null, "", "   "]) {
    const r = await submit({ pin });
    assertEquals(r.status, 200);
    assertEquals(r.estimate.userId, CREATOR);
    assertEquals(r.send.userId, CREATOR);
    assertEquals(r.usersCalls, 0, "no list to check a pin against");
    assertEquals(r.pinRows.length, 0);
  }
});

Deno.test("a pin: both the estimate and its send carry it, and nothing else about the send moves", async () => {
  const r = await submit({ pin: PIN });
  assertEquals(r.status, 200);
  assertEquals(r.estimate.userId, PIN);
  assertEquals(r.send, { altId: "loc-1", altType: "location", userId: PIN, action: "email", liveMode: true, sentTo: { email: [CUSTOMER] } });
  assertEquals(r.usersCalls, 1);
  assertEquals(r.pinRows.length, 0);
});

Deno.test("a pin keeps the floor plan PDF on the estimate, the reason for routing this way", async () => {
  const pinned = await submit({ pin: PIN });
  const unpinned = await submit({});
  assertEquals(pinned.estimate.attachments.map((a: any) => a.url), [PDF_URL]);
  assertEquals(pinned.estimate.attachments, unpinned.estimate.attachments);
});

Deno.test("a pin GHL no longer lists: the quote still goes out, as the default user, and one error row says so", async () => {
  const r = await submit({ pin: PIN, users: [{ id: CREATOR }] });
  assertEquals(r.status, 200);
  assertEquals(r.estimate.userId, CREATOR);
  assertEquals(r.send.userId, CREATOR);
  assertEquals(r.pinRows.length, 1);
  assertEquals(r.pinRows[0].severity ?? "error", "error");
  assert(!JSON.stringify(r.pinRows[0]).includes(PIN), "the error row names no id");
});

Deno.test("a user list we could not get says nothing about the user: the pin stands, with no error row", async () => {
  for (const world of [{ usersStatus: 500 }, { usersStatus: 401 }, { users: [] }]) {
    const r = await submit({ pin: PIN, ...world });
    assertEquals(r.status, 200, JSON.stringify(world));
    assertEquals(r.estimate.userId, PIN, JSON.stringify(world));
    assertEquals(r.send.userId, PIN, JSON.stringify(world));
    assertEquals(r.pinRows.length, 0, JSON.stringify(world));
  }
});

Deno.test("before the migration: the column read fails alone and the quote goes out as it does today", async () => {
  const r = await submit({ column: false });
  assertEquals(r.status, 200);
  assertEquals(r.estimate.userId, CREATOR);
  assertEquals(r.send.userId, CREATOR);
  assertEquals(r.usersCalls, 0);
  assert(r.trace.settingsSelects.some((c) => c === "ghl_sender_user_id"), "the pin has its own read");
  assert(r.trace.settingsSelects.filter((c) => c !== "ghl_sender_user_id").every((c) => !c.includes("ghl_sender_user_id")), "no other settings read names the column");
});

Deno.test("SS mode never reads the pin and never asks GHL for users", async () => {
  const r = await submit({ pin: PIN, invoiceInGhl: false });
  assert(!r.trace.settingsSelects.some((c) => c.includes("ghl_sender_user_id")), "the pin was read in SS mode");
  assertEquals(r.usersCalls, 0);
  assertEquals(r.estimate, null);
  assertEquals(r.pinRows.length, 0);
});
