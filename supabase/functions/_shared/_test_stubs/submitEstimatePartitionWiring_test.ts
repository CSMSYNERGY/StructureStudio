// Partition walls on the estimate (migration 278), driven through the SHIPPED submit-estimate handler.
//
// WHAT IS PINNED, each against the real handler:
//   1. THE THREE METHODS. A wall priced per foot is its length at the rate, per square foot of wall
//      its length x height (full height = the wall the estimate prices, a taller-wall upgrade
//      included), each one at the rate; an unpriced wall still prints, at $0.
//   2. CLAMPING. The anon key reaches this function, so a body claiming a 400 ft wall, a 50 ft one in
//      a 10 ft building or a 40 ft height is charged for the building's own run and its own wall —
//      never more. And a size inclusion row for the item nets nothing.
//   3. DOORS AND WINDOWS IN A WALL are priced from fixture_items by id: the body's price is never
//      read, an id that is not this tenant's door or window prices nothing, an unpriced one adds no
//      line, and each is a door/window line, described as in the partition.
//   4. ONE SPELLING, BOTH SIDES. The designer's own Details rows for the same design (lifted from the
//      shipped twin by designerPricing.ts) and its own payload (ssPartitionSummary) land on the same
//      total as the CRM estimate, for every method; a rep's price typed on a wall's row and on a
//      door's row re-prices exactly that line.
//   5. ABSENT MEANS TODAY. No partitions key and an empty list produce the same estimate.
//
// HOW. submitEstimatePriceOverrideWiring_test's harness: Deno.serve is stubbed while
// submit-estimate/index.ts is imported, the import map swaps supabase-js for supabase_stub.ts, every
// table is answered from the fake below, and fetch answers the CRM locally — no --allow-net.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).
//
// Tenants, people and codes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { designer, detailsSubtotal } from "./designerPricing.ts";

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

// ─── The tenant: a 10 x 12 Econo with 8 ft walls (a +6 in upgrade on offer) ─────────────────────
const T = "acme-sheds";
const CODE = "SS-PRT234ABCD";
const UID = "00000000-0000-4000-8000-0000000000aa";
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
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
const FIXTURES = [
  { id: "fx-door", category: "door", name: "Barn Door", price: 450, width_in: 36, height_in: 80, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
  { id: "fx-win", category: "window", name: "2x3 Window", price: 120, width_in: 24, height_in: 36, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
  { id: "fx-free", category: "door", name: "Curtain", price: null, width_in: 36, height_in: 80, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
  { id: "fx-ramp", category: "ramp", name: "Ramp", price: 300, width_in: 48, height_in: 48, image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true },
];

type World = { method?: string | null; rate?: number; wallHeight?: boolean; inclusion?: boolean };
type Trace = { designUpdates: any[]; ghl: { url: string; method: string; body: any }[] };
const ratesOf = (w: World) => (w.method === null ? [] : [{ item_key: "partitionWall", style_id: null, pricing_method: w.method ?? "lineal_ft", rate: w.rate ?? 22, image_url: null }]);

function tableRows(world: World, table: string): any[] | null {
  switch (table) {
    case "client_settings": return [SETTINGS];
    case "designs": return [{
      client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-05T10:00:00Z", ghl_contact_id: null,
      ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
      accepted_at: null, estimate_lines: null, accepted_snapshot: null,
    }];
    case "client_users": return [{ role: "owner", title: null, access: null, user_id: UID, client_id: T, location_id: null, prefs: null }];
    case "app_operators": return [];
    case "building_styles": return [STYLE];
    case "building_sizes": return [SIZE];
    case "layout_item_pricing": return ratesOf(world);
    case "building_size_inclusions": return world.inclusion ? [{ item_key: "partitionWall", qty: 1, included: true, size_id: "sz-1012" }] : [];
    case "client_layout_items": return [];
    case "fixture_items": return FIXTURES;
    case "colors": return [];
    case "window_colors": return [];
    case "style_wall_heights": return world.wallHeight
      ? [{ delta_in: 6, rate_per_lf: 5, taxable: true, active: true, widths_ft: null, build_on_site: false, bos_fee_basis: null, bos_fee_rate: null }]
      : [];
    default: return null;
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

async function submit(payload: Record<string, unknown>, world: World, token: string | null = USER_TOKEN) {
  const trace: Trace = { designUpdates: [], ghl: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = token === USER_TOKEN ? { id: UID, email: "owner@example.test" } : null;
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
    return { status: res.status, body, estimate, snap };
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

// ─── The design: two partitions in a 10 x 12, as the designer holds them ─────────────────────────
// Wall 7 runs the full 10 ft width, full height, with a priced door and a window in it; wall 8 is
// 6 ft 6 in long and 7 ft 6 in tall with an unpriced door.
const ITEMS: any[] = [
  { id: 7, type: "partitionWall", wall: null, axis: "x", atFt: 6, fromFt: 0, toFt: 10, heightIn: null, openings: [
    { id: 1, kind: "door", fixtureItemId: "fx-door", name: "Barn Door", planLabel: "BARN", widthIn: 36, heightIn: 80, centerFt: 3, swing: "out", operation: "right", price: 450 },
    { id: 2, kind: "window", fixtureItemId: "fx-win", name: "2x3 Window", planLabel: "WIN", widthIn: 24, heightIn: 36, sillIn: null, centerFt: 7.5, price: 120 },
  ] },
  { id: 8, type: "partitionWall", wall: null, axis: "y", atFt: 4, fromFt: 0, toFt: 6.5, heightIn: 90, openings: [
    { id: 1, kind: "door", fixtureItemId: "fx-free", name: "Curtain", widthIn: 36, heightIn: 80, centerFt: 3, swing: "out", operation: null, price: null },
  ] },
];
const SEL: any = { style: "econo", size: "10x12" };
const PAINT = { body: "", trim: "" };
const C = (w: World) => ({
  clientId: T, showPricing: true, options: [],
  layoutPricing: Object.fromEntries(ratesOf(w).map((r) => [r.item_key, { rate: r.rate, method: r.pricing_method }])),
  layoutItems: { partitionWall: { label: "Partition Wall", modelKey: "partition", group: "interior" } },
  sizePricing: { econo: { "10x12": { basePrice: 3000, widthFt: 10, lengthFt: 12 } } },
  buildingStyles: [{ value: "econo", label: "Econo", d3: { wallHeightFt: 8 } }],
  colors: [],
  wallHeightOptions: w.wallHeight ? { econo: [{ deltaIn: 6, ratePerLf: 5 }] } : {},
  fixtures: FIXTURES.map((f) => ({ id: f.id, price: f.price })),
});

const D = designer();
const r2 = (n: number) => Math.round(n * 100) / 100;
const linesTotal = (items: any[]) => r2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.amount) || 0), 0));

/** The payload the designer builds (the `const payload = {` block), cut to what pricing reads; the
 *  partitions come from the designer's own ssPartitionSummary at its own priced wall height. */
function payloadFor(items: any[], sel: any, w: World, extra: Record<string, unknown> = {}, raw?: unknown) {
  const c = C(w);
  const wallFt = D.pricedWallHeightFt(c, c.buildingStyles[0], sel.style, sel, 10);
  const parts = raw !== undefined ? raw : D.ssPartitionSummary(items, wallFt);
  return {
    designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [],
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
    selections: { buildingStyle: sel.style, buildingSize: sel.size, paint: "", ...(sel.wallHeightDeltaIn ? { wallHeightDeltaIn: sel.wallHeightDeltaIn } : {}) },
    doors: [], ramps: [], windows: [],
    itemSummary: {
      singleDoors: 0, doubleDoors: 0, windows: 0, workbenches: [], shelves: [], doubleShelves: [], electricalItems: [],
      lofts: 0, loftSqft: 0, ramp: 0, lines: 0, notes: [],
      // Sent only when there are some, like the designer; a raw list (a forged body) is sent as it is.
      ...(raw !== undefined || (parts as any[]).length ? { partitions: parts } : {}),
    },
    customOptions: [], discounts: [], roughOpenings: [],
    ...extra,
  };
}
const wallLines = (snap: any) => snap.lines.filter((l: any) => l.itemKey === "partitionWall");
const named = (snap: any, name: string) => snap.lines.filter((l: any) => l.name === name);

// ─── 1. The three methods ───────────────────────────────────────────────────────────────────────
Deno.test("per foot: each wall is its length at the rate, its door and window their catalog prices", async () => {
  const r = await submit(payloadFor(ITEMS, SEL, {}), {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(wallLines(r.snap).map((l: any) => [l.name, l.qty, l.amount, l.desc]), [
    ["Partition Wall", 10, 22, "10' long, full height (8') · with a door and a window"],
    ["Partition Wall", 6.5, 22, "6'6\" long, 7'6\" tall · with a door"],
  ]);
  assertEquals(named(r.snap, "Barn Door").map((l: any) => [l.kind, l.qty, l.amount, l.desc]), [["door", 1, 450, "3'×6'8\" · right hinge · in partition wall"]]);
  assertEquals(named(r.snap, "2x3 Window").map((l: any) => [l.kind, l.qty, l.amount, l.desc]), [["window", 1, 120, "2'×3' · in partition wall"]]);
  assertEquals(named(r.snap, "Curtain"), [], "an unpriced catalog door adds no line");
  assert(wallLines(r.snap).every((l: any) => l.kind === "layout_item"), "no new QBO kind");
});

Deno.test("per square foot of wall: length x height, full height at the priced wall (upgrade included)", async () => {
  const w: World = { method: "sqft_option", rate: 3 };
  const r = await submit(payloadFor(ITEMS, SEL, w), w);
  assertEquals(wallLines(r.snap).map((l: any) => [l.qty, l.amount]), [[80, 3], [48.75, 3]]);
  const up: World = { ...w, wallHeight: true };
  const sel = { ...SEL, wallHeightDeltaIn: 6 };
  const r2_ = await submit(payloadFor(ITEMS, sel, up), up);
  assertEquals(r2_.status, 200, JSON.stringify(r2_.body));
  assertEquals(wallLines(r2_.snap).map((l: any) => l.qty), [85, 48.75], "full height follows the +6 in wall; a stated 7'6\" does not");
});

Deno.test("each: one at the rate per wall; unpriced: still on the quote, at $0", async () => {
  const each: World = { method: "each", rate: 650 };
  const r = await submit(payloadFor(ITEMS, SEL, each), each);
  assertEquals(wallLines(r.snap).map((l: any) => [l.qty, l.amount]), [[1, 650], [1, 650]]);
  const none: World = { method: null };
  const z = await submit(payloadFor(ITEMS, SEL, none), none);
  assertEquals(wallLines(z.snap).map((l: any) => [l.qty, l.amount]), [[1, 0], [1, 0]]);
});

// ─── 2. Clamping ───────────────────────────────────────────────────────────────────────────────
Deno.test("an anonymous caller cannot make a wall longer than the building or taller than its walls", async () => {
  const forged = [
    { id: "1", axis: "x", lengthFt: 400, heightIn: 900, openings: [] },
    { id: "2", axis: "y", lengthFt: 50, heightIn: null, openings: [] },
    { id: "3", lengthFt: 1e9, openings: [] },
  ];
  for (const method of ["lineal_ft", "sqft_option"]) {
    const w: World = { method, rate: 10 };
    const r = await submit(payloadFor([], SEL, w, {}, forged), w, ANON_KEY);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(wallLines(r.snap).map((l: any) => l.qty), method === "lineal_ft" ? [10, 12, 12] : [80, 96, 96], method);
  }
});

Deno.test("a size inclusion row for a partition wall nets nothing", async () => {
  const w: World = { inclusion: true };
  const r = await submit(payloadFor(ITEMS, SEL, w), w);
  assertEquals(wallLines(r.snap).map((l: any) => [l.name, l.qty, l.amount]), [["Partition Wall", 10, 22], ["Partition Wall", 6.5, 22]]);
  assertFalse(JSON.stringify(r.snap).includes("(included)"));
  // ...and declining one it "includes" credits nothing off the building.
  const d = await submit(payloadFor([], SEL, w, { declinedItems: [{ key: "partitionWall", label: "Partition Wall" }] }), w);
  assertEquals(d.status, 200, JSON.stringify(d.body));
  assertEquals(named(d.snap, "Econo (10x12)").map((l: any) => l.amount), [3000]);
});

// ─── 3. Doors and windows are the catalog's ─────────────────────────────────────────────────────
Deno.test("a door's price is the catalog's, whatever the body says; a foreign id or a ramp prices nothing", async () => {
  const parts = [{ id: "1", axis: "x", lengthFt: 10, heightIn: null, openings: [
    { id: "1", kind: "door", fixtureItemId: "fx-door", name: "Cheap door", price: 1, widthIn: 36, heightIn: 80 },
    { id: "2", kind: "door", fixtureItemId: "fx-nope", name: "Gold door", price: 99999 },
    { id: "3", kind: "door", fixtureItemId: "fx-ramp", name: "Ramp door" },
  ] }];
  const r = await submit(payloadFor([], SEL, {}, {}, parts), {}, ANON_KEY);
  assertEquals(r.status, 200);
  const doors = r.snap.lines.filter((l: any) => l.kind === "door");
  assertEquals(doors.map((l: any) => [l.name, l.amount]), [["Barn Door", 450]], "named and priced from the catalog row");
  assertFalse(JSON.stringify(r.estimate).includes("99999"));
});

// ─── 4. One spelling, both sides ────────────────────────────────────────────────────────────────
Deno.test("PARITY: the Details rows and the CRM estimate agree to the cent, for every method", async () => {
  for (const w of [{ method: "lineal_ft", rate: 22 }, { method: "sqft_option", rate: 3.15 }, { method: "each", rate: 650 }, { method: null }] as World[]) {
    const client = detailsSubtotal(D, SEL, ITEMS, [], C(w), PAINT);
    const r = await submit(payloadFor(ITEMS, SEL, w), w);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(linesTotal(r.estimate.items), r2(client.subtotal), `${w.method}: Details subtotal == the estimate's line total`);
    const keys = client.priceRows.map((x: any) => x.key);
    assertEquals(keys, ["partition:7", "partition:7:open:1", "partition:7:open:2", "partition:8"], String(w.method));
  }
});

Deno.test("a rep's price on a wall's row and on a door's row re-prices exactly those two lines", async () => {
  const w: World = { method: "lineal_ft", rate: 22 };
  const ov = { "partition:7": { amount: "25", was: 22 }, "partition:7:open:1": { amount: "400", was: 450 } };
  const sel = { ...SEL, priceOverrides: ov };
  const list = D.ssPriceOverrideList(sel, ITEMS, [], C(w), PAINT);
  assertEquals(list, [{ rowKey: "partition:7", amount: 25 }, { rowKey: "partition:7:open:1", amount: 400 }]);
  const client = detailsSubtotal(D, sel, ITEMS, [], C(w), PAINT);
  const r = await submit(payloadFor(ITEMS, SEL, w, { priceOverrides: list }), w);
  const repriced = r.snap.lines.filter((l: any) => "listAmount" in l);
  assertEquals(repriced.map((l: any) => [l.name, l.qty, l.amount, l.listAmount]), [["Partition Wall", 10, 25, 22], ["Barn Door", 1, 400, 450]]);
  assertEquals(linesTotal(r.estimate.items), r2(client.subtotal));
});

Deno.test("Details' × on a door row inside a wall matches no item (it takes the door out of the wall instead)", () => {
  assertFalse(ITEMS.some(D.priceRowMatcher("partition:7:open:1")));
  assertEquals(ITEMS.filter(D.priceRowMatcher("partition:8")).map((i) => i.id), [8]);
});

// ─── 5. Absent means today ─────────────────────────────────────────────────────────────────────
Deno.test("no partitions key and an empty list produce the same estimate, with no partition line", async () => {
  const a = await submit(payloadFor([], SEL, {}), {});
  const b = await submit(payloadFor([], SEL, {}, {}, []), {});
  assertEquals(a.status, 200, JSON.stringify(a.body));
  assertEquals(a.estimate.items, b.estimate.items);
  assertEquals(a.snap, b.snap);
  assertEquals(wallLines(a.snap), []);
});
