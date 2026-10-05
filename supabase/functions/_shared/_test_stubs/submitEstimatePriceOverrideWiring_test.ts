// A rep's own price for a line (a builder's request; migration 277), driven through the
// SHIPPED submit-estimate handler.
//
// WHAT IS PINNED, each against the real handler:
//   1. WHO. The price is honoured for an owner, an admin, a rep an owner granted "Override prices"
//      and a platform operator who may write; it is STRIPPED — and the quote goes out at list
//      price — for an anonymous caller, a rep without the grant and a read-only operator account,
//      with one INFO row (a refusal, never a fault) saying so. A rep without the grant still gets a
//      discount through, as before.
//   2. ABSENT MEANS TODAY. No field, an empty list, an unknown key and a stripped field all produce
//      the same CRM estimate and the same estimate_lines snapshot, with no listAmount anywhere.
//   3. WHERE. A re-priced line takes the new UNIT amount with its quantity untouched; the catalog
//      amount it replaced is kept as listAmount in estimate_lines and nowhere else (never in the
//      CRM payload); a description quoting the list rate is re-spelled at the new one; the
//      building's credit breakdown, which opens with the original price, is dropped; a percentage
//      line is never re-priced, and IS worked out again on the re-priced subtotal.
//   4. ONE SPELLING, BOTH SIDES. The designer's own Details rows (lifted from the shipped twin by
//      designerPricing.ts) are given a price on EVERY row that can take one, the designer's own
//      ssPriceOverrideList builds the payload field from them, and the server must re-price
//      exactly that many lines and land on the Details subtotal to the cent. A key spelled
//      differently on either side shows up here as a line left at list price.
//   5. A catalog door whose row was re-priced gets a line of its own even where the server would
//      otherwise fold it into an identical-looking line from another fixture.
//
// HOW. The deleteDesignWiring_test idiom: Deno.serve is stubbed while submit-estimate/index.ts is
// imported, so a request runs through withErrorLog and every step as it does live. The import map
// swaps supabase-js for supabase_stub.ts; stubDb routes every table into the fake below. The tenant
// is in CRM mode with the CRM's own email (the shortest path to an issued estimate), and fetch
// answers the CRM's endpoints locally — no --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check submit-estimate against the stub's partial client type.
//
// Tenants, people and codes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { designer, detailsSubtotal } from "./designerPricing.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
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

// ─── The tenant ────────────────────────────────────────────────────────────────────────────────
const T = "acme-sheds";
const CODE = "SS-PRC234ABCD";
const UID = "00000000-0000-4000-8000-0000000000aa";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
const ANON_KEY = jwt({ role: "anon", iss: "supabase" });
const USER_TOKEN = jwt({ sub: UID, role: "authenticated" });

const SETTINGS = {
  client_id: T, ghl_location_id: "loc-1", ghl_api_key: "harness-key", ghl_pipeline_id: null, ghl_stage_send_quote_id: null,
  business_name: "Acme Sheds", business_phone: "", business_website: "", business_address: null, business_logo_url: "",
  quote_terms: "", beta_mode: false, beta_email: null, ramp_price: 0, ramp_price_method: "each", ramp_image_url: null,
  ramp_show_image: false, email_provider: "ghl", email_domain_status: null, email_domain: null, email_from_local: null,
  email_from_name: null, invoice_in_ghl: true, email_template_copy: null, ss_tax_rate: null, ss_tax_label: null,
  ss_tax_delivery: false, quote_valid_days: 30, insulation_enabled: false,
};
const STYLE = { id: "st-econo", key: "econo", label: "Econo", image_url: null, show_image_on_estimate: false, taxable: true, d3: { wallHeightFt: 8 } };
const SIZE = { id: "sz-1012", style_id: "st-econo", base_price: 3000, label: "10x12", width_ft: 10, length_ft: 12 };
const LAYOUT_RATES = [
  { item_key: "singleDoor", style_id: null, pricing_method: "each", rate: 400, image_url: null },
  { item_key: "workbench", style_id: null, pricing_method: "lineal_ft", rate: 12.5, image_url: null },
  { item_key: "loft", style_id: null, pricing_method: "sqft_option", rate: 6, image_url: null },
  { item_key: "shelf", style_id: null, pricing_method: "pct_estimate_total", rate: 5, image_url: null },
  { item_key: "roughOpeningDoor", style_id: null, pricing_method: "each", rate: 150, image_url: null },
];
const FIXTURES = [
  { id: "fx-door", price: 500, image_url: null, show_image_on_estimate: false, color_mode: "paint", archived: false, taxable: true },
  { id: "fx-door2", price: 500, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
  { id: "fx-win", price: 200, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
  { id: "fx-ramp", price: 300, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
];
const COLORS = [{
  id: "c1", label: "Barn Red", rate: 100, pricing_method: "each", allow_custom: false, shingle: true, metal: false,
  door: true, door_rate: 50, trim: true, active: true, taxable: true,
}];

// The SAME catalog as the designer receives it from get_config / get_fixtures.
const C = {
  clientId: T, showPricing: true, options: [],
  layoutPricing: Object.fromEntries(LAYOUT_RATES.map((r) => [r.item_key, { rate: r.rate, method: r.pricing_method }])),
  sizePricing: { econo: { "10x12": { basePrice: 3000, widthFt: 10, lengthFt: 12 } } },
  buildingStyles: [{ value: "econo", label: "Econo", sizeInclusionQty: { "10x12": { singleDoor: 1 } } }],
  colors: [{ id: "c1", label: "Barn Red", siding: true, trim: true, rate: 100, pricingMethod: "each", doorRate: 50, shingle: true }],
  wallHeightOptions: { econo: [{ deltaIn: 6, ratePerLf: 5 }] },
  fixtures: [{ id: "fx-door", price: 500, colorMode: "paint" }, { id: "fx-door2", price: 500, colorMode: "fixed" }, { id: "fx-win", price: 200 }, { id: "fx-ramp", price: 300 }],
};

// ─── The fake database ─────────────────────────────────────────────────────────────────────────
type Member = { role: string; title: string | null; access: Record<string, string> | null } | null;
type World = { member: Member; operator?: boolean; operatorReadOnly?: boolean; wallHeight?: boolean };
type Trace = { rows: any[]; designUpdates: any[]; ghl: { url: string; method: string; body: any }[] };

function tableRows(world: World, table: string): any[] | null {
  switch (table) {
    case "client_settings": return [SETTINGS];
    case "designs": return [{
      client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-05T10:00:00Z", ghl_contact_id: null,
      ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
      accepted_at: null, estimate_lines: null, accepted_snapshot: null,
    }];
    case "client_users": return world.member ? [{ ...world.member, user_id: UID, client_id: T, location_id: null, prefs: null }] : [];
    case "app_operators": return world.operator ? [{ user_id: UID, can_write: !world.operatorReadOnly }] : [];
    case "building_styles": return [STYLE];
    case "building_sizes": return [SIZE];
    case "layout_item_pricing": return LAYOUT_RATES;
    case "building_size_inclusions": return [{ item_key: "singleDoor", qty: 1, included: true, size_id: "sz-1012" }];
    case "client_layout_items": return [];
    case "fixture_items": return FIXTURES;
    case "colors": return COLORS;
    case "window_colors": return [];
    case "style_wall_heights": return world.wallHeight
      ? [{ delta_in: 6, rate_per_lf: 5, taxable: true, active: true, widths_ft: null, build_on_site: false, bos_fee_basis: null, bos_fee_rate: null }]
      : [];
    default: return null;   // delivery_settings, rate_buckets, crm_contacts, builder_locations …: nothing on file
  }
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle", "not", "or", "gte", "lte", "gt", "lt"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    if (table === "app_errors" && verb === "insert") {
      trace.rows.push(ops.find((o) => o[0] === "insert")?.[1]);
      return Promise.resolve({ data: null, error: null }).then(ok, bad);
    }
    if (verb === "update" && table === "designs") trace.designUpdates.push(ops.find((o) => o[0] === "update")?.[1]);
    if (verb !== "select") return Promise.resolve({ data: [], error: null }).then(ok, bad);
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

async function submit(payload: Record<string, unknown>, world: World, token: string | null) {
  const trace: Trace = { rows: [], designUpdates: [], ghl: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = token === USER_TOKEN ? { id: UID, email: "rep@example.test" } : null;
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://services.leadconnectorhq.com/")) throw new Error(`unexpected fetch: ${url}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    trace.ghl.push({ url, method: String(init?.method ?? "GET"), body });
    if (url.endsWith("/contacts/upsert")) return Promise.resolve(json({ contact: { id: "contact-1" } }));
    if (url.includes("/products/")) return Promise.resolve(json({ products: [{ createdBy: "ghl-user-1", locationId: "loc-1" }] }));
    if (url.includes("/opportunities/search")) return Promise.resolve(json({ opportunities: [] }));
    if (url.endsWith("/opportunities/")) return Promise.resolve(json({ opportunity: { id: "opp-1" } }));
    if (/\/invoices\/estimate$/.test(url)) return Promise.resolve(json({ _id: "est-1", estimateNumber: 1001 }));
    if (url.endsWith("/send")) return Promise.resolve(json({ ok: true }));
    return Promise.resolve(json({}));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/submit-estimate", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "harness/1.0", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    }));
    const body = await res.json();
    const estimate = trace.ghl.find((c) => /\/invoices\/estimate$/.test(c.url))?.body ?? null;
    const snap = [...trace.designUpdates].reverse().find((u) => u && u.estimate_lines)?.estimate_lines ?? null;
    return { status: res.status, body, trace, estimate, snap };
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

// ─── The design, as the designer holds it and as it sends it ───────────────────────────────────
const ITEMS: any[] = [
  { id: 1, type: "singleDoor" }, { id: 2, type: "singleDoor" },                 // one included by the size
  { id: 3, type: "workbench", widthFt: 6 },
  { id: 4, type: "loft", widthFt: 6, heightFt: 8 },
  { id: 5, type: "shelf", widthFt: 4 },                                          // priced as 5% of the rest
  { id: 11, type: "fixtureDoor", fixtureItemId: "fx-door", price: 500, doorName: "Barn Door", colorId: "c1", colorLabel: "Barn Red" },
  { id: 12, type: "fixtureDoor", fixtureItemId: "fx-door", price: 500, doorName: "Barn Door", colorId: "c1", colorLabel: "Barn Red" },
  { id: 13, type: "fixtureDoor", fixtureItemId: "fx-door", price: 500, doorName: "Barn Door" },
  { id: 14, type: "window", fixtureItemId: "fx-win", price: 200, windowName: "Window 2x3" },
  { id: 15, type: "window", fixtureItemId: "fx-win", price: 200, windowName: "Window 2x3" },
  { id: 16, type: "ramp", fixtureItemId: "fx-ramp", price: 300, rampName: "Ramp 4x4" },
  { id: 21, type: "roughOpeningDoor" }, { id: 22, type: "roughOpeningDoor" },
];
const SEL: any = { style: "econo", size: "10x12", paint: "Painted", roofType: "Shingle", roofColor: "Barn Red" };
const PAINT = { body: "Barn Red", trim: "Barn Red" };

/** The submit payload the designer builds for ITEMS/SEL (structure-studio.component.js, the
 *  `const payload = {` block), cut to what pricing reads. */
function payloadFor(items: any[], sel: any, extra: Record<string, unknown> = {}) {
  return {
    designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [],
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
    selections: {
      buildingStyle: sel.style, buildingSize: sel.size, paint: sel.paint,
      paintBodyColor: PAINT.body, paintTrimColor: PAINT.trim, roofType: sel.roofType, roofColor: sel.roofColor,
      ...(sel.wallHeightDeltaIn ? { wallHeightDeltaIn: sel.wallHeightDeltaIn } : {}),
    },
    doors: items.filter((i) => i.type === "fixtureDoor").map((d) => ({
      name: d.doorName || "Door", widthIn: 36, heightIn: 80, swing: null, operation: null, price: d.price, wall: "front",
      fixtureItemId: d.fixtureItemId || null, colorId: d.colorId || null, colorLabel: d.colorLabel || null, trimColorId: null, trimColorLabel: null,
    })),
    ramps: items.filter((i) => i.type === "ramp").map((r) => ({
      name: r.rampName || null, widthIn: 48, heightIn: 48, price: r.price, doorWidthFt: null, wall: "front", fixtureItemId: r.fixtureItemId || null,
    })),
    windows: items.filter((i) => i.type === "window" && i.fixtureItemId).map((w) => ({
      name: w.windowName || "Window", widthIn: 24, heightIn: 36, price: w.price, wall: "left", fixtureItemId: w.fixtureItemId,
      colorId: null, colorLabel: null, shutters: false, shutterColorId: null, shutterColorLabel: null, flowerBox: false, flowerBoxColorId: null, flowerBoxColorLabel: null,
    })),
    itemSummary: {
      singleDoors: items.filter((i) => i.type === "singleDoor").length, doubleDoors: 0,
      windows: items.filter((i) => i.type === "window" && !i.fixtureItemId).length,
      workbenches: items.filter((i) => i.type === "workbench").map((i) => ({ wall: "front", lengthFt: i.widthFt })),
      shelves: items.filter((i) => i.type === "shelf").map((i) => ({ wall: "left", lengthFt: i.widthFt })),
      doubleShelves: [], electricalItems: [],
      lofts: items.filter((i) => i.type === "loft").length,
      loftSqft: Math.round(items.filter((i) => i.type === "loft").reduce((s, i) => s + i.widthFt * i.heightFt, 0)),
      ramp: items.filter((i) => i.type === "ramp").length, lines: 0, notes: [],
    },
    customOptions: [], discounts: [],
    roughOpenings: items.filter((i) => /^roughOpening/.test(i.type)).map((ro, k) => ({
      name: `RO-D${k + 1}`, itemKey: ro.type, dimensions: "3 x 7", qty: 1, id: ro.id,
    })),
    ...extra,
  };
}

const OWNER: World = { member: { role: "owner", title: null, access: null } };
const REP: World = { member: { role: "user", title: "sales_rep", access: null } };
const GRANTED_REP: World = { member: { role: "user", title: "sales_rep", access: { price_override: "edit" } } };
const ADMIN: World = { member: { role: "admin", title: "admin", access: null } };
const OPERATOR: World = { member: null, operator: true };
// A read-only (support) operator account: every other write is refused it by resolveTenant.
const READ_ONLY_OPERATOR: World = { member: null, operator: true, operatorReadOnly: true };

const D = designer();
const r2 = (n: number) => Math.round(n * 100) / 100;
const linesTotal = (items: any[]) => r2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.amount) || 0), 0));
const lineNamed = (snap: any, name: string) => snap.lines.filter((l: any) => l.name === name);
const refusals = (t: Trace) => t.rows.filter((r) => r && r.code === "unauthorized_price_override");

// ─── 2. Absent means today ─────────────────────────────────────────────────────────────────────
const BASE = await submit(payloadFor(ITEMS, SEL), OWNER, USER_TOKEN);

Deno.test("the baseline submit issues an estimate, and no line carries a listAmount", () => {
  assertEquals(BASE.status, 200, JSON.stringify(BASE.body));
  assert(BASE.estimate && BASE.snap, "the CRM estimate and the snapshot were both written");
  assert(BASE.snap.lines.every((l: any) => !("listAmount" in l)));
  assertEquals(refusals(BASE.trace).length, 0);
});

Deno.test("no field, an empty list and an unknown key all produce exactly today's estimate", async () => {
  for (const extra of [{ priceOverrides: [] }, { priceOverrides: [{ rowKey: "no-such-row", amount: 1 }] }, { priceOverrides: "nonsense" }]) {
    const r = await submit(payloadFor(ITEMS, SEL, extra), OWNER, USER_TOKEN);
    assertEquals(r.status, 200);
    assertEquals(r.estimate.items, BASE.estimate.items, JSON.stringify(extra));
    assertEquals(r.snap, BASE.snap, JSON.stringify(extra));
  }
});

// ─── 1. Who ────────────────────────────────────────────────────────────────────────────────────
const BUILDING_ONLY = { priceOverrides: [{ rowKey: "building", amount: 2750 }] };

Deno.test("an anonymous caller's prices are stripped: list price, one INFO row, nothing else moves", async () => {
  for (const token of [ANON_KEY, null]) {
    const r = await submit(payloadFor(ITEMS, SEL, BUILDING_ONLY), OWNER, token);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.estimate.items, BASE.estimate.items, "the CRM estimate is exactly the list-price one");
    assertEquals(r.snap, BASE.snap);
    const rows = refusals(r.trace);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].severity, "info", "a refusal, not a fault");
    assertEquals(rows[0].context.overrideCount, 1);
    assertEquals(rows[0].context.staffCaller, false);
  }
});

Deno.test("a sales rep WITHOUT the grant is stripped too — designer access is not enough", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, BUILDING_ONLY), REP, USER_TOKEN);
  assertEquals(r.status, 200);
  assertEquals(r.estimate.items, BASE.estimate.items);
  assertEquals(r.snap, BASE.snap);
  const rows = refusals(r.trace);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].context.staffCaller, true, "a real rep, so the row says so");
});

Deno.test("...and that rep's DISCOUNT still applies: the new gate is beside the old one, not over it", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, { ...BUILDING_ONLY, discounts: [{ description: "Fall special", amount: 100, taxable: true }] }), REP, USER_TOKEN);
  assertEquals(r.snap.discount, 100);
  assertEquals(lineNamed(r.snap, "Econo (10x12)")[0].amount, 3000);
});

Deno.test("the owner, an admin, a granted rep and a platform operator are honoured", async () => {
  for (const [who, world] of [["owner", OWNER], ["admin", ADMIN], ["granted rep", GRANTED_REP], ["operator", OPERATOR]] as const) {
    const r = await submit(payloadFor(ITEMS, SEL, BUILDING_ONLY), world, USER_TOKEN);
    assertEquals(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    const b = lineNamed(r.snap, "Econo (10x12)")[0];
    assertEquals([b.amount, b.listAmount, b.qty], [2750, 3000, 1], who);
    assertEquals(refusals(r.trace).length, 0, who);
  }
});

Deno.test("a READ-ONLY operator account is stripped: it may look at a builder's quote, not re-price it", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, BUILDING_ONLY), READ_ONLY_OPERATOR, USER_TOKEN);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.estimate.items, BASE.estimate.items);
  assertEquals(r.snap, BASE.snap);
  const rows = refusals(r.trace);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].context.staffCaller, true, "still staff for everything else, as before");
});

// ─── 3. Where ──────────────────────────────────────────────────────────────────────────────────
Deno.test("the CRM never sees listAmount or rowKey, and its building line carries the new price", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, BUILDING_ONLY), OWNER, USER_TOKEN);
  const text = JSON.stringify(r.estimate);
  assertFalse(text.includes("listAmount"));
  assertFalse(text.includes("rowKey"));
  const b = r.estimate.items.find((i: any) => i.name === "Econo (10x12)");
  assertEquals(b.amount, 2750);
  // Only the building moved: every other line is the list-price one.
  const others = (items: any[]) => items.filter((i: any) => i.name !== "Econo (10x12)" && i.name !== "Shelf" && i.name !== "Single Shelf");
  assertEquals(others(r.estimate.items), others(BASE.estimate.items));
});

Deno.test("a percentage line is never re-priced, and is worked out again on the re-priced subtotal", async () => {
  const pctOf = (snap: any) => snap.lines.find((l: any) => l.itemKey === "shelf");
  const base = pctOf(BASE.snap);
  assert(base && base.amount > 0, "the 5% shelf line exists");
  const r = await submit(payloadFor(ITEMS, SEL, { priceOverrides: [{ rowKey: "building", amount: 2750 }, { rowKey: "shelf", amount: 1 }] }), OWNER, USER_TOKEN);
  const pct = pctOf(r.snap);
  assertFalse("listAmount" in pct, "the percentage line took no price of its own");
  // 5% of every OTHER line: the base fell by exactly the building's $250.
  assertEquals(r2(pct.amount), r2(base.amount - 0.05 * 250));
});

Deno.test("measured lines are re-priced PER UNIT; quantity and the list-rate text follow", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, { priceOverrides: [{ rowKey: "workbench", amount: 10 }, { rowKey: "loft", amount: 5.5 }] }), OWNER, USER_TOKEN);
  const wb = r.snap.lines.find((l: any) => l.itemKey === "workbench");
  const loft = r.snap.lines.find((l: any) => l.itemKey === "loft");
  assertEquals([wb.qty, wb.amount, wb.listAmount], [6, 10, 12.5]);
  assertEquals([loft.qty, loft.amount, loft.listAmount], [48, 5.5, 6]);
});

Deno.test("a description that quotes the list rate is re-spelled at the new one", async () => {
  const sel = { ...SEL, wallHeightDeltaIn: 6 };
  const base = await submit(payloadFor(ITEMS, sel), { ...OWNER, wallHeight: true }, USER_TOKEN);
  const wh0 = base.snap.lines.find((l: any) => l.kind === "wall_height");
  assertEquals(wh0.desc, "44 ft of wall at $5.00 per foot");
  const r = await submit(payloadFor(ITEMS, sel, { priceOverrides: [{ rowKey: "wallHeight", amount: 6.25 }] }), { ...OWNER, wallHeight: true }, USER_TOKEN);
  const wh = r.snap.lines.find((l: any) => l.kind === "wall_height");
  assertEquals([wh.qty, wh.amount, wh.listAmount], [44, 6.25, 5]);
  assertEquals(wh.desc, "44 ft of wall at $6.25 per foot", "the customer never reads the $5.00");
  assertFalse(JSON.stringify(r.estimate).includes("$5.00"));
});

Deno.test("each rough opening is its own line, priced by its own id", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, { priceOverrides: [{ rowKey: "ro:22", amount: 275 }] }), OWNER, USER_TOKEN);
  const ros = r.snap.lines.filter((l: any) => l.itemKey === "roughOpeningDoor");
  assertEquals(ros.map((l: any) => [l.name, l.amount, l.listAmount ?? null]), [["RO-D1", 150, null], ["RO-D2", 275, 150]]);
});

Deno.test("malformed entries are dropped one by one; a negative price is a free line, a huge one is capped", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, { priceOverrides: [
    { rowKey: "building", amount: -50 }, { rowKey: 7, amount: 1 }, { rowKey: "workbench", amount: "abc" },
    { rowKey: "loft", amount: null }, { rowKey: "singleDoor", amount: 9e9 },
  ] }), OWNER, USER_TOKEN);
  assertEquals(lineNamed(r.snap, "Econo (10x12)")[0].amount, 0);
  assertEquals(r.snap.lines.find((l: any) => l.itemKey === "workbench").amount, 12.5);
  assertEquals(r.snap.lines.find((l: any) => l.itemKey === "loft").amount, 6);
  assertEquals(r.snap.lines.find((l: any) => l.itemKey === "singleDoor" && l.amount > 0).amount, 1_000_000);
});

// ─── 5. A re-priced catalog door gets a line of its own ────────────────────────────────────────
Deno.test("two fixtures that would share one line are split only when one of their rows is re-priced", async () => {
  const items = [
    { id: 31, type: "fixtureDoor", fixtureItemId: "fx-door2", price: 500, doorName: "Barn Door" },
    { id: 32, type: "fixtureDoor", fixtureItemId: "fx-door", price: 500, doorName: "Barn Door" },
  ];
  // fx-door is colour_mode paint, fx-door2 fixed; with no colour chosen both price at 500 and the
  // server folds them into ONE "Barn Door" line — the designer shows two rows.
  const plain = await submit(payloadFor(items, SEL), OWNER, USER_TOKEN);
  assertEquals(lineNamed(plain.snap, "Barn Door").map((l: any) => [l.qty, l.amount]), [[2, 500]]);
  const r = await submit(payloadFor(items, SEL, { priceOverrides: [{ rowKey: "fx:fx-door||", amount: 650 }] }), OWNER, USER_TOKEN);
  assertEquals(lineNamed(r.snap, "Barn Door").map((l: any) => [l.qty, l.amount, l.listAmount ?? null]), [[1, 500, null], [1, 650, 500]]);
});

// ─── 4. One spelling, both sides ───────────────────────────────────────────────────────────────
Deno.test("PARITY: a price on every Details row lands on exactly one server line each, and the totals agree", async () => {
  // The designer's own rows, at list. Every row that can take a price is given one ($7.25 over
  // list), and every rough opening too, the way a rep would type them in.
  const listRows = detailsSubtotal(D, SEL, ITEMS, [], C, PAINT);
  const priceable = [...listRows.selRows, ...listRows.priceRows].filter((r: any) => r.listUnit != null);
  assert(priceable.length >= 9, `expected every kind of row to be priceable, got ${priceable.map((r: any) => r.key)}`);
  const ov: Record<string, { amount: string; was: number }> = {};
  for (const row of priceable) ov[row.key] = { amount: String(r2(row.listUnit + 7.25)), was: row.listUnit };
  for (const ro of ITEMS.filter((i) => /^roughOpening/.test(i.type))) ov[D.ssPriceRowKey("ro", ro.id)] = { amount: "157.25", was: 150 };
  const sel = { ...SEL, priceOverrides: ov };
  const list = D.ssPriceOverrideList(sel, ITEMS, [], C, PAINT);
  assertEquals(list.length, priceable.length + 2, "the payload carries every applied row and both openings");

  const client = detailsSubtotal(D, sel, ITEMS, [], C, PAINT);
  const r = await submit(payloadFor(ITEMS, SEL, { priceOverrides: list }), OWNER, USER_TOKEN);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const repriced = r.snap.lines.filter((l: any) => "listAmount" in l);
  assertEquals(repriced.length, list.length, `server re-priced ${repriced.map((l: any) => l.name)}; designer sent ${list.map((x) => x.rowKey)}`);
  for (const l of repriced) assertEquals(r2(l.amount - l.listAmount), 7.25, l.name);
  // The number the rep saw is the number on the CRM estimate.
  assertEquals(linesTotal(r.estimate.items), r2(client.subtotal), "Details subtotal == the estimate's line total");
  // ...and at list the two agreed already (so the check above is about the prices, not the set-up).
  assertEquals(linesTotal(BASE.estimate.items), r2(listRows.subtotal));
});
