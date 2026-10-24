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
//   5. THE TRANSOM (fixture_items.door_window_at 'top', 2026-10-21; Yoder Barns). A 29 x 10 transom
//      fits the leaf of a 72 in double and of a 36 in door where no panel window that wide would; it
//      goes in the built looks, the board-and-batten looks and a slab with no photo, never a photo
//      door or a slide-up; each leaf is one "Transom in door: <door>" line at the catalog price, in
//      its own group, and the Details rows agree. A signed order resubmitted unchanged raises no
//      change order, and adding a transom to one says exactly what was added.
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
import { changeOrderDescription } from "../changeOrderDiff.ts";

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
// The grid of lites (335): the window's rows x columns, which the payload block resolves per window.
const LITES_START = "// ── WINDOW LITES (335) ──\n", LITES_END = "// ── END WINDOW LITES ──\n";
const regions = (src: string, file: string) => ({
  lites: lift(src, file, LITES_START, LITES_END),
  help: lift(src, file, HELP_START, HELP_END),
  pay: lift(src, file, PAY_START, PAY_END),
  label: lift(src, file, LABEL_START, LABEL_END),
});
const R_CMP = regions(CMP, "structure-studio.component.js"), R_JSX = regions(JSX, "StructureStudio.jsx");
Deno.test("the lifted door-window helpers and payload block are byte-identical in both twins", () => {
  assertEquals(R_JSX.help, R_CMP.help);
  assertEquals(R_JSX.pay, R_CMP.pay);
  assertEquals(R_JSX.lites, R_CMP.lites);
});
const W = new Function(`${R_CMP.lites}\n${R_CMP.help}\n${R_CMP.label}\n; return {
  ssDoorWindowCount, ssDoorWindowFit, ssDoorLeafFt, ssDoorWindowLines, doorWindowStamps, ssItemPlacesKey, ssRemoveFromRow,
  ssDoorWindowLookOk, ssDoorPhotoOf, ssLites, ssLitesWords, ssItemLites,
  payload: (items, C, frontWall) => ${R_CMP.pay}\n          }),
};`)() as {
  ssDoorWindowCount: (it: any, look: string, photo?: boolean) => number;
  ssDoorWindowFit: (w: number, h: number, wi: any, hi: any, at?: string) => any;
  ssDoorWindowLookOk: (look: string, at: string, photo: boolean, operation: string | null) => boolean;
  ssDoorPhotoOf: (fixtures: any[], it: any) => boolean;
  ssDoorLeafFt: (wi: any, hi: any, dbl: boolean) => { w: number; h: number } | null;
  ssDoorWindowLines: (items: any[], fixtures: any[]) => any[];
  doorWindowStamps: (w: any, l?: { rows: number; cols: number } | null) => Record<string, unknown>;
  ssLites: (r: unknown, c: unknown) => { rows: number; cols: number } | null;
  ssLitesWords: (l: { rows: number; cols: number } | null) => string;
  ssItemLites: (it: any, fixtures: any[]) => { rows: number; cols: number } | null;
  ssItemPlacesKey: (it: any, k: string, fixtures: any[]) => boolean;
  ssRemoveFromRow: (key: string, it: any) => any;
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
  // The TRANSOM (door_window_at 'top', 2026-10-21): Yoder Barns' own row, 29 x 10 at $81, and their
  // 72 in double; a plain slab with a photo (which cannot hold one); a door left on 'auto' with none.
  { id: "fx-transom", category: "window", name: "Transom Windows", price: 81, width_in: 29, height_in: 10, in_door: true, door_window_at: "top" },
  { id: "fx-yoder2", category: "door", name: "Cross buck Double Doors", price: 1200, width_in: 72, height_in: 72, door_style: "xbrace", op_double: true },
  { id: "fx-slab", category: "door", name: "Plain door", price: 350, width_in: 36, height_in: 80 },
  { id: "fx-photo", category: "door", name: "Photo door", price: 380, width_in: 36, height_in: 80, image_url: "https://stub.supabase.co/storage/v1/object/public/fixtures/door.jpg" },
].map((f) => ({ image_url: null, show_image_on_estimate: false, color_mode: "fixed", archived: false, taxable: true, ...f }));
// The designer's catalog (get_fixtures' shape): ids, prices, the door looks it reads, a door's photo,
// and the sparse inDoor / doorWindowAt.
const DESIGNER_FIXTURES = FIXTURES.map((f: any) => ({ id: f.id, category: f.category, price: f.price,
  ...(f.category === "door" && f.door_style ? { doorStyle: f.door_style } : {}), ...(f.image_url ? { imageUrl: f.image_url } : {}),
  ...(f.in_door ? { inDoor: true } : {}), ...(f.door_window_at === "top" ? { doorWindowAt: "top" } : {}) }));

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

// ─── 5. A window in a door IS a placed window (review 2026-10-07) ────────────────────────────────
// submit-estimate's placedKeys takes the fixture id of every windows[] line, the in-door ones too, so
// a size's included lite that the customer declined and then put in a door is kept and netted, never
// credited. Details used to count only wall windows as placed: it credited the decline AND netted the
// door's lite, one credit below the estimate.
Deno.test("PARITY: an included lite declined and placed only in a door -- no credit on either side", async () => {
  const w: World = { inclusion: true };
  const items = [door(2, fx("fx-classic"), "south", "right", LITE)];
  const sel = { ...SEL, declinedItems: ["fx-lite"] };
  const client = detailsSubtotal(D, sel, items, [], C(w), PAINT);
  const r = await submit(payloadFor(items, w, { declinedItems: [{ key: "fx-lite", label: "Door lite" }] }), w);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(linesTotal(r.estimate.items), 3600, "the estimate: building 3000 + Classic 600 + the lite included at 0");
  assertEquals(r2(client.subtotal), 3600, "Details: the same, with no decline credit");
  assertFalse(JSON.stringify(client.selRows).includes("declined"), JSON.stringify(client.selRows));
  // The same decline with the lite on a PLANK door (not drawn there) is a real decline: credited on both sides.
  const plank = [door(4, fx("fx-plank"), "west", "right", LITE)];
  const c2 = detailsSubtotal(D, sel, plank, [], C(w), PAINT);
  const r2b = await submit(payloadFor(plank, w, { declinedItems: [{ key: "fx-lite", label: "Door lite" }] }), w);
  assertEquals(r2b.status, 200, JSON.stringify(r2b.body));
  assertEquals(linesTotal(r2b.estimate.items), r2(c2.subtotal));
  assertEquals(r2(c2.subtotal), 3000 - 95 + 450);
});

Deno.test("the Included chip and the submit gate count a drawn door window as the window placed", () => {
  const F = DESIGNER_FIXTURES;
  assert(W.ssItemPlacesKey(ITEMS[0], "fx-lite", F), "a Classic single drawing the lite places it");
  assert(W.ssItemPlacesKey(ITEMS[1], "fx-lite", F), "so does an American double");
  assertFalse(W.ssItemPlacesKey(ITEMS[2], "fx-lite", F), "a plank door does not draw it");
  assertFalse(W.ssItemPlacesKey(ITEMS[3], "fx-big", F), "nor does a door the window is too big for");
  assertFalse(W.ssItemPlacesKey(ITEMS[4], "fx-lite", F), "nor a slide-up");
  assertFalse(W.ssItemPlacesKey({ ...ITEMS[0], ...NONE }, "fx-lite", F), "nor a door with no window");
  // The tests it replaced still hold: the item's type, and the fixture it is.
  assert(W.ssItemPlacesKey(ITEMS[0], "fx-classic", F) && W.ssItemPlacesKey(WALL_LITE, "fx-lite", F) && W.ssItemPlacesKey({ type: "loft" }, "loft", F));
  assertFalse(W.ssItemPlacesKey(WALL_LITE, "fx-big", F));
});

// The Details row's × for a window row: computeLayoutPricingRows folds door windows into the
// win:<fid>|<colour> row, so the row's matcher has to reach the door, and taking it off the row takes
// the window out of the door and leaves the door.
Deno.test("the window row's × reaches the door that carries the window, and keeps the door", () => {
  const F = DESIGNER_FIXTURES;
  const only = [door(2, fx("fx-classic"), "south", "right", LITE)];
  const row = detailsSubtotal(D, SEL, only, [], C({}), PAINT).priceRows.find((x: any) => x.key === "win:fx-lite|");
  assertEquals([row.qty, row.total, row.method], [1, 95, "each"]);
  assertEquals(only.filter(D.priceRowMatcher("win:fx-lite|", F)).map((i) => i.id), [2]);
  // Without the catalog no door matches, as before; and a door that does not draw its window never does.
  assertEquals(only.filter(D.priceRowMatcher("win:fx-lite|")).length, 0);
  assertEquals(ITEMS.filter(D.priceRowMatcher("win:fx-lite|", F)).map((i) => i.id), [2, 3, 1], "the Classic, the American double and the wall lite; not the plank or the slide-up");
  assertEquals(ITEMS.filter(D.priceRowMatcher("win:fx-big|", F)).length, 0, "the too-big window is on no row and matches nothing");
  // A coloured window row is a wall window's only: door windows are colourless.
  assertEquals(ITEMS.filter(D.priceRowMatcher("win:fx-lite|c-black", F)).length, 0);
  // The door rows still match the doors and nothing else.
  assertEquals(ITEMS.filter(D.priceRowMatcher("fx:fx-classic||", F)).map((i) => i.id), [2, 5, 6]);
  // Taking the door off the window row: the door stays, without its window.
  const kept = W.ssRemoveFromRow("win:fx-lite|", only[0]);
  assertEquals([kept.id, kept.type, kept.fixtureItemId, kept.doorWindowId, kept.doorWindowPrice], [2, "fixtureDoor", "fx-classic", null, null]);
  assertEquals(W.ssRemoveFromRow("win:fx-lite|", WALL_LITE), null, "a wall window is removed");
  assertEquals(W.ssRemoveFromRow("fx:fx-classic||", only[0]), null, "a door off its own row is removed");
  // ...and the row it leaves is gone.
  const after = detailsSubtotal(D, SEL, [kept], [], C({}), PAINT);
  assertEquals(after.priceRows.filter((x: any) => x.key === "win:fx-lite|"), []);
});

// ─── 5. The transom (door_window_at 'top', 2026-10-21) ─────────────────────────────────────────
const TOP = W.doorWindowStamps({ id: "fx-transom", name: "Transom Windows", widthIn: 29, heightIn: 10, price: 81, doorWindowAt: "top" });
const TITEMS: any[] = [
  door(20, fx("fx-yoder2"), "south", "double", TOP),       // Yoder's 72 in double, X-brace: one per leaf
  door(21, fx("fx-classic"), "east", "right", TOP),        // a built look
  door(22, fx("fx-slab"), "west", "left", TOP),            // a plain slab with no photo
  door(23, fx("fx-photo"), "west", "right", TOP),          // a photo door: nothing
  door(24, fx("fx-plank"), "north", "slideup", TOP),       // a slide-up: nothing
  door(26, fx("fx-american2"), "east", "double", TOP),     // a 60 in double's 29 in leaf is too narrow: nothing
  door(25, fx("fx-american2"), "north", "double", LITE),   // panel windows beside them, as before
];

Deno.test("transom stamps: a sixth field, 'top' for a transom and null otherwise", () => {
  assertEquals(TOP.doorWindowAt, "top");
  assertEquals(LITE.doorWindowAt, null);
  // ...and since 335 the two grid fields, null when the window takes its row's default.
  assertEquals(Object.keys(NONE).sort(), ["doorWindowAt", "doorWindowHeightIn", "doorWindowId", "doorWindowLiteCols", "doorWindowLiteRows", "doorWindowName", "doorWindowPrice", "doorWindowWidthIn"]);
  assert(Object.values(NONE).every((v) => v === null));
  // Anything but the exact "top" is a panel window.
  assertEquals(W.doorWindowStamps({ id: "x", name: "X", widthIn: 18, heightIn: 24, price: 1, doorWindowAt: "TOP" }).doorWindowAt, null);
});

Deno.test("ssDoorWindowFit 'top': Yoder's 29 x 10 fits a 72 in double's leaf and a 36 in door, under the top rail", () => {
  const yoder = W.ssDoorLeafFt(72, 72, true)!, single = W.ssDoorLeafFt(36, 80, false)!, narrow = W.ssDoorLeafFt(60, 80, true)!;
  const r = W.ssDoorWindowFit(yoder.w, yoder.h, 29, 10, "top");
  assert(r, "fits the 35 in leaf");
  assert(Math.abs((r.x0 + r.x1) / 2 - yoder.w / 2) < 1e-9, "centred across the leaf");
  assert(Math.abs(r.y1 - (yoder.h - 0.29)) < 1e-9 && Math.abs(r.y1 - r.y0 - 10 / 12) < 1e-9, `its top under the 3.5 in top rail: ${JSON.stringify(r)}`);
  assertEquals(W.ssDoorWindowFit(yoder.w, yoder.h, 29, 10), null, "the same window does NOT fit the upper panel (the 289 rule)");
  assert(W.ssDoorWindowFit(single.w, single.h, 29, 10, "top"), "fits a 36 in door");
  assertEquals(W.ssDoorWindowFit(narrow.w, narrow.h, 29, 10, "top"), null, "not a 60 in double's 29 in leaf: 1.5 in a side is the least");
  // Height: at most 30% of the leaf, and the band (glass, casing, rail) ends above 60% of it.
  assert(W.ssDoorWindowFit(yoder.w, yoder.h, 29, 19, "top"), "19 in tall still leaves the panel");
  assertEquals(W.ssDoorWindowFit(yoder.w, yoder.h, 29, 20, "top"), null, "20 in would run the band below 60% of the leaf");
  assertEquals(W.ssDoorWindowFit(yoder.w, yoder.h, 29, 24, "top"), null, "24 in is over 30% of the leaf");
});

Deno.test("ssDoorWindowLookOk: a transom goes in the built, board-and-batten and photo-less slab doors; a panel window in the built four", () => {
  for (const l of ["american", "basic", "classic", "dutch", "plank", "zbrace", "xbrace", "auto"]) assert(W.ssDoorWindowLookOk(l, "top", false, "right"), l);
  assertFalse(W.ssDoorWindowLookOk("auto", "top", true, "right"), "a photo door cannot be cut");
  assert(W.ssDoorWindowLookOk("xbrace", "top", true, "right"), "a board-and-batten door's photo is not drawn, so it can");
  for (const l of ["rollup", "gothic"]) assertFalse(W.ssDoorWindowLookOk(l, "top", false, "right"), l);
  for (const l of ["american", "auto", "plank"]) assertFalse(W.ssDoorWindowLookOk(l, "top", false, "slideup"), `${l} slide-up`);
  for (const l of ["american", "basic", "classic", "dutch"]) assert(W.ssDoorWindowLookOk(l, "panel", true, "double"), l);
  for (const l of ["auto", "plank", "zbrace", "xbrace", "rollup"]) assertFalse(W.ssDoorWindowLookOk(l, "panel", false, "right"), l);
});

Deno.test("ssDoorWindowCount: one transom per leaf where the look and the leaf take it", () => {
  const F = DESIGNER_FIXTURES;
  const counts = TITEMS.map((i) => W.ssDoorWindowCount(i, (F.find((f: any) => f.id === i.fixtureItemId) as any).doorStyle || "auto", W.ssDoorPhotoOf(F, i)));
  assertEquals(counts, [2, 1, 1, 0, 0, 0, 2]);
  assert(W.ssDoorPhotoOf(F, TITEMS[3]) && !W.ssDoorPhotoOf(F, TITEMS[2]) && !W.ssDoorPhotoOf(F, { fixtureItemId: "gone" }));
  // The 289 call without a photo argument still answers for every panel window.
  assertEquals(W.ssDoorWindowCount(ITEMS[0], "classic"), 1);
});

Deno.test("the designer's payload: a transom's lines say doorWindowAt 'top'; a panel window's lines are unchanged", () => {
  const lines = W.payload(TITEMS, C({}), "south");
  assertEquals(lines.map((l: any) => [l.name, l.fixtureItemId, l.price, l.doorName, l.doorWindowAt ?? "-"]), [
    ["Transom Windows", "fx-transom", 81, "Cross buck Double Doors", "top"],
    ["Transom Windows", "fx-transom", 81, "Cross buck Double Doors", "top"],
    ["Transom Windows", "fx-transom", 81, "Classic door", "top"],
    ["Transom Windows", "fx-transom", 81, "Plain door", "top"],
    ["Door lite", "fx-lite", 95, "American double", "-"],
    ["Door lite", "fx-lite", 95, "American double", "-"],
  ]);
  assert(lines.filter((l: any) => l.name === "Door lite").every((l: any) => !("doorWindowAt" in l)), "sparse: a panel window's line has no new key");
  assertEquals(W.payload(ITEMS, C({}), "south").filter((l: any) => "doorWindowAt" in l), [], "the 289 design's payload is exactly what it was");
});

Deno.test("the estimate: 'Transom in door: <door>' per door at the catalog price; panel windows still 'Window in door'", async () => {
  const r = await submit(payloadFor(TITEMS, {}), {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(named(r.snap, "Transom Windows").map((l: any) => [l.kind, l.qty, l.amount, l.desc]), [
    ["window", 2, 81, "2'5\"×10\" · Transom in door: Cross buck Double Doors"],
    ["window", 1, 81, "2'5\"×10\" · Transom in door: Classic door"],
    ["window", 1, 81, "2'5\"×10\" · Transom in door: Plain door"],
  ]);
  assertEquals(named(r.snap, "Door lite").map((l: any) => [l.qty, l.desc]), [[2, "1'6\"×2' · Window in door: American double"]]);
  const client = detailsSubtotal(D, SEL, TITEMS, [], C({}), PAINT);
  assertEquals(linesTotal(r.estimate.items), r2(client.subtotal), "PARITY: Details subtotal == the estimate's line total");
  assertEquals(client.priceRows.filter((x: any) => x.key === "win:fx-transom|").map((x: any) => [x.qty, x.total]), [[4, 324]]);
});

Deno.test("the position joins the group key: the same window as a panel and as a transom in one door name is two lines", async () => {
  const p: any = payloadFor([], {});
  const base = { name: "Transom Windows", widthIn: 29, heightIn: 10, price: 81, wall: "front", inDoor: true, doorName: "Classic door", fixtureItemId: "fx-transom",
    colorId: null, colorLabel: null, shutters: false, shutterColorId: null, shutterColorLabel: null, flowerBox: false, flowerBoxColorId: null, flowerBoxColorLabel: null };
  p.windows = [{ ...base, doorWindowAt: "top" }, { ...base }, { ...base, doorWindowAt: "TOP" }];
  const r = await submit(p, {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(named(r.snap, "Transom Windows").map((l: any) => [l.qty, l.desc]), [
    [1, "2'5\"×10\" · Transom in door: Classic door"],
    [2, "2'5\"×10\" · Window in door: Classic door"],
  ]);
});

Deno.test("change orders: a signed order resubmitted unchanged raises none; adding transoms says exactly that", async () => {
  const a = await submit(payloadFor(TITEMS, {}), {});
  const b = await submit(payloadFor(TITEMS, {}), {});
  assertEquals(a.status, 200, JSON.stringify(a.body));
  assertEquals(changeOrderDescription(a.snap, b.snap), null, "a transom design resubmitted as it was");
  // A door placed before the stamp (no doorWindowAt key) and the same door placed now (null) price alike.
  const legacy = ITEMS.map((i) => { if (i.type !== "fixtureDoor") return i; const { doorWindowAt: _x, ...rest } = i; return rest; });
  const old = await submit(payloadFor(legacy, {}), {});
  const now = await submit(payloadFor(ITEMS, {}), {});
  assertEquals(changeOrderDescription(old.snap, now.snap), null, "a 289 order resubmitted after the transom shipped");
  const bare = TITEMS.map((i) => (i.type === "fixtureDoor" ? { ...i, ...NONE } : i));
  const before = await submit(payloadFor(bare, {}), {});
  const text = changeOrderDescription(before.snap, a.snap) || "";
  assert(text.includes("Added: Transom Windows ×4 ($324.00)"), text);
  assert(text.includes("Added: Door lite ×2 ($190.00)"), text);
});

// ─── 6. THE GRID (335; Carolyn, 2026-10-23): a window's rows x columns of lites, in words ─────────
// The designer sends the grid it draws on each windows[] line: the rep's override on the placed
// window or door, else the window row's default (get_fixtures' liteRows / liteCols), else nothing
// (automatic). The estimate says it on that window's line, "9-lite (3 rows of 3)", and keeps a 6-lite
// and a plain window of one row apart; plain and automatic say nothing, so a design without a grid
// keeps every line exactly as it was; and no grid moves any money.
const GFIX = DESIGNER_FIXTURES.map((f: any) => (f.id === "fx-transom" ? { ...f, liteRows: 1, liteCols: 5 } : f));
const GITEMS: any[] = [
  door(30, fx("fx-classic"), "south", "right",
    W.doorWindowStamps({ id: "fx-lite", name: "Door lite", widthIn: 18, heightIn: 24, price: 95 }, { rows: 3, cols: 3 })), // the rep's 9-lite
  door(31, fx("fx-yoder2"), "east", "double", TOP),        // the transom row's default: 1 row of 5, one per leaf
  door(32, fx("fx-american2"), "north", "double", LITE),   // no override, and the lite's row sets none: automatic
];
const gridPayload = (items: any[], wall: Record<string, unknown>[]) => {
  const p: any = payloadFor([], {});
  p.doors = payloadFor(items, {}).doors;
  p.windows = wall.concat(W.payload(items, { ...C({}), fixtures: GFIX }, "south"));
  return p;
};
const WALL_WIN = { name: "Door lite", widthIn: 18, heightIn: 24, price: 95, wall: "front", fixtureItemId: "fx-lite",
  colorId: null, colorLabel: null, shutters: false, shutterColorId: null, shutterColorLabel: null, flowerBox: false, flowerBoxColorId: null, flowerBoxColorLabel: null };

Deno.test("THE GRID: the words, and what counts as a grid", () => {
  assertEquals(W.ssLitesWords(null), "", "automatic says nothing");
  assertEquals(W.ssLitesWords(W.ssLites(1, 1)), "", "no grid says nothing");
  assertEquals(W.ssLitesWords(W.ssLites(1, 5)), "5-lite (1 row of 5)");
  assertEquals(W.ssLitesWords(W.ssLites(3, 2)), "6-lite (3 rows of 2)");
  assertEquals(W.ssLitesWords(W.ssLites("3", "3")), "9-lite (3 rows of 3)");
  for (const bad of [[0, 1], [9, 1], [1, 9], [1.5, 2], ["x", 2], [null, 2], [2, undefined]]) assertEquals(W.ssLites(bad[0], bad[1]), null, JSON.stringify(bad));
});

Deno.test("THE GRID: each window in a door sends the rep's override, else its row's default, else nothing", () => {
  const lines = W.payload(GITEMS, { ...C({}), fixtures: GFIX }, "south");
  assertEquals(lines.map((l: any) => [l.doorName, l.liteRows, l.liteCols]), [
    ["Classic door", 3, 3],
    ["Cross buck Double Doors", 1, 5], ["Cross buck Double Doors", 1, 5],
    ["American double", null, null], ["American double", null, null],
  ]);
  assertEquals(W.ssItemLites(GITEMS[1], GFIX), { rows: 1, cols: 5 });
  assertEquals(W.ssItemLites({ ...GITEMS[1], doorWindowLiteRows: 1, doorWindowLiteCols: 1 }, GFIX), { rows: 1, cols: 1 }, "the rep's No grid beats the row's default");
  assertEquals(NONE.doorWindowLiteRows, null);
  assertEquals(W.doorWindowStamps(null, { rows: 3, cols: 3 }).doorWindowLiteRows, null, "no window, no grid");
});

Deno.test("THE GRID: the estimate says it on each window's line, and nothing on a window without one", async () => {
  const r = await submit(gridPayload(GITEMS, [{ ...WALL_WIN, liteRows: 3, liteCols: 2 }, { ...WALL_WIN }, { ...WALL_WIN, liteRows: 1, liteCols: 1 }]), {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(named(r.snap, "Door lite").map((l: any) => [l.qty, l.amount, l.desc]), [
    [1, 95, "1'6\"×2' · 6-lite (3 rows of 2) · front wall"],
    [2, 95, "1'6\"×2' · front wall"],
    [1, 95, "1'6\"×2' · 9-lite (3 rows of 3) · Window in door: Classic door"],
    [2, 95, "1'6\"×2' · Window in door: American double"],
  ]);
  assertEquals(named(r.snap, "Transom Windows").map((l: any) => [l.qty, l.amount, l.desc]), [
    [2, 81, "2'5\"×10\" · 5-lite (1 row of 5) · Transom in door: Cross buck Double Doors"],
  ]);
});

Deno.test("THE GRID: no money moves, a forged grid is no words, and an unchanged resubmit raises no change order", async () => {
  const withGrid = await submit(gridPayload(GITEMS, [{ ...WALL_WIN, liteRows: 3, liteCols: 2 }]), {});
  const plain = GITEMS.map((i) => ({ ...i, doorWindowLiteRows: null, doorWindowLiteCols: null }));
  const p: any = payloadFor([], {});
  p.doors = payloadFor(plain, {}).doors;
  p.windows = [{ ...WALL_WIN }].concat(W.payload(plain, C({}), "south"));
  const without = await submit(p, {});
  assertEquals(withGrid.status, 200, JSON.stringify(withGrid.body));
  assertEquals(linesTotal(withGrid.estimate.items), linesTotal(without.estimate.items), "the same total with and without grids");
  assertEquals(withGrid.snap.lines.reduce((s: number, l: any) => s + l.qty, 0), without.snap.lines.reduce((s: number, l: any) => s + l.qty, 0), "the same count of everything");
  const forged = await submit(gridPayload([], [{ ...WALL_WIN, liteRows: 99, liteCols: 2 }, { ...WALL_WIN, liteRows: "x", liteCols: "<b>" }]), {});
  assertEquals(named(forged.snap, "Door lite").map((l: any) => [l.qty, l.desc]), [[2, "1'6\"×2' · front wall"]], "out-of-range or junk is no words");
  const again = await submit(gridPayload(GITEMS, [{ ...WALL_WIN, liteRows: 3, liteCols: 2 }]), {});
  assertEquals(changeOrderDescription(withGrid.snap, again.snap), null, "a design with grids resubmitted as it was");
});
