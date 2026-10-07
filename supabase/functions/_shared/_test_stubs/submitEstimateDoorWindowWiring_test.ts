// Windows IN DOORS on the estimate (migration 289), driven through the SHIPPED submit-estimate handler.
//
// The door generator's four looks (American, Basic, Classic, Dutch) can carry a window the builder
// ticked "Can be used inside a door", one in the upper panel of every leaf. PRICING (decided): each
// is its OWN window line at the window's catalog price, one per leaf (two on a double), appended to
// the payload's windows[] with `inDoor: true` -- never folded into the door's line, because an
// included door nets its whole grouped price and would give the window away with it.
//
// WHAT IS PINNED, each against the real handler and the designer's own shipped code:
//   1. ONE SPELLING, BOTH SIDES. The designer's Details rows (computeLayoutPricingRows, lifted by
//      designerPricing.ts) and its own payload block for these windows (lifted below from the twin)
//      land on the same total as the CRM estimate, with and without a size inclusion of the window,
//      and with a rep's price on the window row.
//   2. ONE LINE PER LEAF, AT THE CATALOG PRICE. A single door's window is one line, a double's two;
//      the body's price is never read; each line says "Window in door: <the door>", and is kept off
//      a wall window's line (and another door's) by the group key.
//   3. CHARGED ONLY WHERE DRAWN. A window stamped on a door the renderer would not draw it in -- a
//      plank door, a window too big for the leaf, a slide-up -- sends nothing and prices nothing; the
//      same ssDoorWindowCount answers both, so the designer and the estimate cannot disagree.
//   4. ABSENT MEANS TODAY. Doors with no window, and designs from before the stamps, produce the
//      estimate they always did.
//
// HOW. submitEstimatePartitionWiring_test's harness: Deno.serve is stubbed while
// submit-estimate/index.ts is imported, the import map swaps supabase-js for supabase_stub.ts, every
// table is answered from the fake below, and fetch answers the CRM locally -- no --allow-net.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).
//
// Tenants, people and codes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";
import { CMP, JSX, designer, detailsSubtotal, lift } from "./designerPricing.ts";

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

// ─── The designer's own code for these windows, lifted from the shipped twins ─────────────────────
const HELP_START = "// ── WINDOWS IN DOORS (migration 289) ──\n", HELP_END = "// ── END WINDOWS IN DOORS ──\n";
const PAY_START = "ssDoorWindowLines(items, C.fixtures).map((w) => {", PAY_END = "\n          })),\n        itemSummary: {";
const LABEL_START = "function getDisplayLabel(", LABEL_END = "// How to name a wall in a sentence";
const regions = (src: string, file: string) => ({
  help: lift(src, file, HELP_START, HELP_END),
  pay: lift(src, file, PAY_START, PAY_END),
  label: lift(src, file, LABEL_START, LABEL_END),
});
const R_CMP = regions(CMP, "structure-studio.component.js"), R_JSX = regions(JSX, "StructureStudio.jsx");
Deno.test("the lifted door-window helpers and payload block are byte-identical in both twins", () => {
  assertEquals(R_JSX.help, R_CMP.help);
  assertEquals(R_JSX.pay, R_CMP.pay);
});
const W = new Function(`${R_CMP.help}\n${R_CMP.label}\n; return {
  ssDoorWindowCount, ssDoorWindowFit, ssDoorLeafFt, ssDoorWindowLines, doorWindowStamps,
  payload: (items, C, frontWall) => ${R_CMP.pay}\n          }),
};`)() as {
  ssDoorWindowCount: (it: any, look: string) => number;
  ssDoorWindowFit: (w: number, h: number, wi: any, hi: any) => any;
  ssDoorLeafFt: (wi: any, hi: any, dbl: boolean) => { w: number; h: number } | null;
  ssDoorWindowLines: (items: any[], fixtures: any[]) => any[];
  doorWindowStamps: (w: any) => Record<string, unknown>;
  payload: (items: any[], C: any, frontWall: string | null) => any[];
};

// ─── The tenant: a 10 x 12 Econo with doors in the generator's looks and a small door lite ───────
const T = "acme-sheds";
const CODE = "SS-DRW234ABCD";
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
  { id: "fx-classic", category: "door", name: "Classic door", price: 600, width_in: 36, height_in: 80, door_style: "classic" },
  { id: "fx-american2", category: "door", name: "American double", price: 1000, width_in: 60, height_in: 80, door_style: "american", op_double: true },
  { id: "fx-plank", category: "door", name: "Barn door", price: 450, width_in: 36, height_in: 80, door_style: "plank" },
  { id: "fx-lite", category: "window", name: "Door lite", price: 95, width_in: 18, height_in: 24, in_door: true },
  { id: "fx-big", category: "window", name: "Big lite", price: 150, width_in: 30, height_in: 40, in_door: true },
].map((f) => ({ image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true, ...f }));
// The designer's catalog (get_fixtures' shape): ids, prices and the door looks it reads.
const DESIGNER_FIXTURES = FIXTURES.map((f) => ({ id: f.id, category: f.category, price: f.price, ...(f.category === "door" ? { doorStyle: f.door_style } : {}), ...(f.in_door ? { inDoor: true } : {}) }));

type World = { inclusion?: boolean };
type Trace = { designUpdates: any[]; ghl: { url: string; method: string; body: any }[] };
function tableRows(world: World, table: string): any[] | null {
  switch (table) {
    case "client_settings": return [SETTINGS];
    case "designs": return [{
      client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-07T10:00:00Z", ghl_contact_id: null,
      ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
      accepted_at: null, estimate_lines: null, accepted_snapshot: null,
    }];
    case "client_users": return [{ role: "owner", title: null, access: null, user_id: UID, client_id: T, location_id: null, prefs: null }];
    case "app_operators": return [];
    case "building_styles": return [STYLE];
    case "building_sizes": return [SIZE];
    case "layout_item_pricing": return [];
    case "building_size_inclusions": return world.inclusion ? [{ item_key: "fx-lite", qty: 1, included: true, size_id: "sz-1012" }] : [];
    case "client_layout_items": return [];
    case "fixture_items": return FIXTURES;
    case "colors": return [];
    case "window_colors": return [];
    case "style_wall_heights": return [];
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

// ─── The design, as the designer holds it ───────────────────────────────────────────────────────
const LITE = W.doorWindowStamps({ id: "fx-lite", name: "Door lite", widthIn: 18, heightIn: 24, price: 95 });
const BIG = W.doorWindowStamps({ id: "fx-big", name: "Big lite", widthIn: 30, heightIn: 40, price: 150 });
const NONE = W.doorWindowStamps(null);
const door = (id: number, fx: any, wall: string, operation: string, win: Record<string, unknown>) => ({
  id, type: "fixtureDoor", wall, fixtureItemId: fx.id, doorName: fx.name, price: fx.price, widthIn: fx.width_in, heightIn: fx.height_in,
  widthFt: fx.width_in / 12, swing: "out", operation, colorId: null, colorLabel: null, colorHex: null, trimColorId: null, trimColorLabel: null, trimColorHex: null, ...win,
});
const fx = (id: string) => FIXTURES.find((f) => f.id === id)!;
const WALL_LITE = { id: 1, type: "window", wall: "north", fixtureItemId: "fx-lite", windowName: "Door lite", price: 95, widthIn: 18, heightIn: 24, colorId: null };
const ITEMS: any[] = [
  door(2, fx("fx-classic"), "south", "right", LITE),       // one window
  door(3, fx("fx-american2"), "east", "double", LITE),     // two windows, one per leaf
  door(4, fx("fx-plank"), "west", "right", LITE),          // a plank door draws no window: nothing
  door(5, fx("fx-classic"), "west", "left", BIG),          // too big for the leaf: nothing
  door(6, fx("fx-classic"), "north", "slideup", LITE),     // a slide-up is not a hinged leaf: nothing
  WALL_LITE,
];
const SEL: any = { style: "econo", size: "10x12" };
const PAINT = { body: "", trim: "" };
const C = (w: World) => ({
  clientId: T, showPricing: true, options: [], layoutPricing: {}, layoutItems: {},
  sizePricing: { econo: { "10x12": { basePrice: 3000, widthFt: 10, lengthFt: 12 } } },
  buildingStyles: [{ value: "econo", label: "Econo", d3: { wallHeightFt: 8 }, ...(w.inclusion ? { sizeInclusionQty: { "10x12": { "fx-lite": 1 } } } : {}) }],
  colors: [], windowColors: [],
  wallHeightOptions: {},
  fixtures: DESIGNER_FIXTURES,
});
const D = designer();
const r2 = (n: number) => Math.round(n * 100) / 100;
const linesTotal = (items: any[]) => r2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.amount) || 0), 0));

/** The payload the designer builds, cut to what pricing reads: its doors[] and windows[] blocks as
 *  they ship, the door windows from the lifted block itself. */
function payloadFor(items: any[], w: World, extra: Record<string, unknown> = {}) {
  const c = C(w);
  const doors = items.filter((i) => i.type === "fixtureDoor").map((d) => ({
    name: d.doorName || "Door", widthIn: d.widthIn, heightIn: d.heightIn, swing: d.swing, operation: d.operation,
    price: d.price, wall: d.wall, fixtureItemId: d.fixtureItemId, colorId: null, colorLabel: null, trimColorId: null, trimColorLabel: null,
  }));
  const wallWindows = items.filter((i) => i.type === "window" && i.fixtureItemId).map((x) => ({
    name: x.windowName, widthIn: x.widthIn, heightIn: x.heightIn, price: x.price, wall: "front", fixtureItemId: x.fixtureItemId,
    colorId: null, colorLabel: null, shutters: false, shutterColorId: null, shutterColorLabel: null, flowerBox: false, flowerBoxColorId: null, flowerBoxColorLabel: null,
  }));
  return {
    designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [],
    contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
    selections: { buildingStyle: SEL.style, buildingSize: SEL.size, paint: "" },
    doors, ramps: [], windows: wallWindows.concat(W.payload(items, c, "south")),
    itemSummary: { singleDoors: 0, doubleDoors: 0, windows: 0, workbenches: [], shelves: [], doubleShelves: [], electricalItems: [], lofts: 0, loftSqft: 0, ramp: 0, lines: 0, notes: [] },
    customOptions: [], discounts: [], roughOpenings: [],
    ...extra,
  };
}
const named = (snap: any, name: string) => snap.lines.filter((l: any) => l.name === name);

// ─── 3. Charged only where drawn: the rule itself ───────────────────────────────────────────────
Deno.test("ssDoorWindowCount: one per leaf on the four built looks, only when the window fits, never on a slide-up", () => {
  const look = (it: any) => (DESIGNER_FIXTURES.find((f) => f.id === it.fixtureItemId) as any).doorStyle;
  assertEquals(ITEMS.filter((i) => i.type === "fixtureDoor").map((i) => W.ssDoorWindowCount(i, look(i))), [1, 2, 0, 0, 0]);
  for (const l of ["american", "basic", "classic", "dutch"]) assertEquals(W.ssDoorWindowCount(ITEMS[0], l), 1, l);
  for (const l of ["auto", "plank", "zbrace", "xbrace", "rollup", "gothic"]) assertEquals(W.ssDoorWindowCount(ITEMS[0], l), 0, l);
  assertEquals(W.ssDoorWindowCount({ ...ITEMS[0], ...NONE }, "classic"), 0, "no window picked");
  // An 18 x 24 lite fits a 36 x 80 leaf and a 30 in leaf of a 60 in double; a 30 x 40 fits neither.
  const single = W.ssDoorLeafFt(36, 80, false)!, half = W.ssDoorLeafFt(60, 80, true)!;
  assert(W.ssDoorWindowFit(single.w, single.h, 18, 24) && W.ssDoorWindowFit(half.w, half.h, 18, 24));
  assertFalse(W.ssDoorWindowFit(single.w, single.h, 30, 40) || W.ssDoorWindowFit(half.w, half.h, 30, 40));
  // The window sits in the UPPER panel: above the mid rail at 42%, below the top rail.
  const r = W.ssDoorWindowFit(single.w, single.h, 18, 24);
  assert(r.y0 > single.h * 0.42 && r.y1 < single.h, JSON.stringify(r));
});

Deno.test("the designer's payload: one inDoor window line per drawn leaf, naming its door, at the stamped price", () => {
  const lines = W.payload(ITEMS, C({}), "south");
  assertEquals(lines.map((l: any) => [l.name, l.fixtureItemId, l.price, l.inDoor, l.doorName, l.wall]), [
    ["Door lite", "fx-lite", 95, true, "Classic door", "front"],
    ["Door lite", "fx-lite", 95, true, "American double", "right"],
    ["Door lite", "fx-lite", 95, true, "American double", "right"],
  ]);
  assert(lines.every((l: any) => l.shutters === false && l.flowerBox === false && l.colorId === null));
});

// ─── 2. One line per door, at the catalog price ─────────────────────────────────────────────────
Deno.test("the estimate: the wall window and each door's windows are separate lines at the catalog price", async () => {
  const r = await submit(payloadFor(ITEMS, {}), {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(named(r.snap, "Door lite").map((l: any) => [l.kind, l.qty, l.amount, l.desc]), [
    ["window", 1, 95, "1'6\"×2' · front wall"],
    ["window", 1, 95, "1'6\"×2' · Window in door: Classic door"],
    ["window", 2, 95, "1'6\"×2' · Window in door: American double"],
  ]);
  assertEquals(named(r.snap, "Big lite"), [], "a window that does not fit its door is not on the estimate");
  // The doors' own lines are the doors alone: nothing of the windows folded in.
  assertEquals(r.snap.lines.filter((l: any) => l.kind === "door").map((l: any) => [l.name, l.qty, l.amount]),
    [["Classic door", 3, 600], ["American double", 1, 1000], ["Barn door", 1, 450]]);
});

Deno.test("the body's price is never read: a forged door window is priced from fixture_items", async () => {
  const p = payloadFor(ITEMS, {});
  (p.windows as any[]).forEach((w) => { if (w.inDoor) w.price = 1; });
  const r = await submit(p, {}, ANON_KEY);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(named(r.snap, "Door lite").every((l: any) => l.amount === 95));
});

// ─── 1. One spelling, both sides ────────────────────────────────────────────────────────────────
Deno.test("PARITY: the Details rows and the CRM estimate agree to the cent, with and without a size inclusion", async () => {
  for (const w of [{}, { inclusion: true }] as World[]) {
    const client = detailsSubtotal(D, SEL, ITEMS, [], C(w), PAINT);
    const r = await submit(payloadFor(ITEMS, w), w);
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(linesTotal(r.estimate.items), r2(client.subtotal), `inclusion ${!!w.inclusion}: Details subtotal == the estimate's line total`);
    const win = client.priceRows.filter((x: any) => x.key === "win:fx-lite|");
    // Four lites: one wall, one in the Classic, two in the American double (one included when the size includes one).
    assertEquals(win.map((x: any) => [x.qty, x.total]), [[w.inclusion ? 3 : 4, w.inclusion ? 285 : 380]], JSON.stringify(win));
  }
});

Deno.test("PARITY: a rep's price on the window row re-prices the wall window and every window in a door", async () => {
  const ov = { "win:fx-lite|": { amount: "80", was: 95 } };
  const sel = { ...SEL, priceOverrides: ov };
  const list = D.ssPriceOverrideList(sel, ITEMS, [], C({}), PAINT);
  assertEquals(list, [{ rowKey: "win:fx-lite|", amount: 80 }]);
  const client = detailsSubtotal(D, sel, ITEMS, [], C({}), PAINT);
  const r = await submit(payloadFor(ITEMS, {}, { priceOverrides: list }), {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(named(r.snap, "Door lite").map((l: any) => [l.qty, l.amount, l.listAmount]), [[1, 80, 95], [1, 80, 95], [2, 80, 95]]);
  assertEquals(linesTotal(r.estimate.items), r2(client.subtotal));
});

// ─── 4. Absent means today ─────────────────────────────────────────────────────────────────────
Deno.test("doors with no window, and doors from before the stamps, produce the estimate they always did", async () => {
  const bare = ITEMS.map((i) => (i.type === "fixtureDoor" ? { ...i, ...NONE } : i));
  const legacy = ITEMS.map((i) => {
    if (i.type !== "fixtureDoor") return i;
    const { doorWindowId: _a, doorWindowName: _b, doorWindowWidthIn: _c, doorWindowHeightIn: _d, doorWindowPrice: _e, ...rest } = i;
    return rest;
  });
  assertEquals(W.payload(bare, C({}), "south"), []);
  assertEquals(W.payload(legacy, C({}), "south"), []);
  const a = await submit(payloadFor(bare, {}), {});
  const b = await submit(payloadFor(legacy, {}), {});
  assertEquals(a.status, 200, JSON.stringify(a.body));
  assertEquals(a.estimate.items, b.estimate.items);
  assertEquals(named(a.snap, "Door lite").map((l: any) => [l.qty, l.desc]), [[1, "1'6\"×2' · front wall"]]);
  assertEquals(linesTotal(a.estimate.items), r2(detailsSubtotal(D, SEL, bare, [], C({}), PAINT).subtotal));
});
