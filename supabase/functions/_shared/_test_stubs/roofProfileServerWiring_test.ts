// THE METAL ROOF PROFILE, PER DESIGN (2026-10-06), driven through the three SHIPPED handlers that
// print it: submit-estimate (the quote's Roof line), portal-settings' stage_order_attribute_change
// (the order screen's change orders) and portal-schedule's appearanceFrom (the crew card).
//
// WHAT THIS PINS, against the real code:
//
//   1. submit-estimate. A metal roof on standing seam reads "Metal (Standing Seam) — Black" on the
//      CRM estimate and in estimate_lines; every other roof reads exactly what it did, and the amount
//      never moves. The pick is the body's when the body NAMES roofProfile ("" is a real clear), else
//      the stored design's (a designer older than the pick names no key), else the style's d3, else
//      AG Panel. The design read selects `selections` for that fallback.
//   2. stage_order_attribute_change. A recolour or a paint change on a standing seam order keeps the
//      Roof line's "(Standing Seam)", so the change order the customer signs names only what moved and
//      never a phantom "Roof: options updated". The style is read with its d3 for a design that has not
//      picked. Before this, the same request reworded the roof line and raised that sentence.
//   3. appearanceFrom. The crew card's roof type is "Metal (Standing Seam)" for such a roof, by the
//      same rule; the style is read only for a metal roof without a pick, matched by key or label;
//      and a failed or throwing read still answers, with plain "Metal".
//   4. A SIGNED design with no pick of its own keeps the profile its agreed Roof line names, in all
//      three, whatever the style says now (review 2026-10-07). A builder who sets a style to Standing
//      Seam for future quotes must not reword orders already signed on it as "Metal — Black": a
//      paint change or a resubmit would raise "Roof: options updated" for a roof nobody changed, and
//      the crew card would name a roof the customer did not buy.
//
// HOW. The submitEstimatePriceOverrideWiring_test / claddingExposureWiring_test idiom: Deno.serve is
// stubbed while each index.ts is imported, the import map swaps supabase-js for supabase_stub.ts, and
// stubDb routes every table into the fakes below. fetch answers the CRM's endpoints locally and no
// --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIERS ARE COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check the handler against the stub's partial client type.
//
// Tenants, people and codes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";

async function importHandler(fn: string): Promise<{ handler: (req: Request) => Promise<Response>; mod: any }> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: any) => { handler = h; return { finished: Promise.resolve() }; };
  let mod: any;
  try {
    mod = await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return { handler, mod };
}
const SUBMIT = (await importHandler("submit-estimate")).handler;
const SETTINGS_FN = (await importHandler("portal-settings")).handler;
const SCHEDULE = (await importHandler("portal-schedule")).mod;

const T = "acme-sheds";
const CODE = "SS-RPF234ABCD";
const UID = "00000000-0000-4000-8000-0000000000ab";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
const USER_TOKEN = jwt({ sub: UID, role: "authenticated" });

async function withEnv<R>(fn: () => Promise<R>): Promise<R> {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── The catalog both handlers price from ──────────────────────────────────────────────────────
const COLORS = [
  { id: "m1", label: "Black", rate: 2.5, pricing_method: "sqft_building", allow_custom: false, metal: true, shingle: false, siding: false, trim: false, active: true, taxable: true },
  { id: "m2", label: "Galvalume", rate: 0, pricing_method: "each", allow_custom: false, metal: true, shingle: false, siding: false, trim: false, active: true, taxable: true },
  { id: "s1", label: "Weathered Wood", rate: 150, pricing_method: "each", allow_custom: false, metal: false, shingle: true, siding: false, trim: false, active: true, taxable: true },
  { id: "p1", label: "Barn Red", rate: 100, pricing_method: "each", allow_custom: false, metal: false, shingle: false, siding: true, trim: true, active: true, taxable: true },
];
const styleRow = (d3: unknown) => ({ id: "st-dlx", key: "deluxe", label: "Deluxe Gable", image_url: null, show_image_on_estimate: false, taxable: true, d3 });
const SIZE = { id: "sz-1012", style_id: "st-dlx", base_price: 9000, label: "10x12", width_ft: 10, length_ft: 12 };

// ═══ 1. submit-estimate ════════════════════════════════════════════════════════════════════════
const SETTINGS = {
  client_id: T, ghl_location_id: "loc-1", ghl_api_key: "harness-key", ghl_pipeline_id: null, ghl_stage_send_quote_id: null,
  business_name: "Acme Sheds", business_phone: "", business_website: "", business_address: null, business_logo_url: "",
  quote_terms: "", beta_mode: false, beta_email: null, ramp_price: 0, ramp_price_method: "each", ramp_image_url: null,
  ramp_show_image: false, email_provider: "ghl", email_domain_status: null, email_domain: null, email_from_local: null,
  email_from_name: null, invoice_in_ghl: true, email_template_copy: null, ss_tax_rate: null, ss_tax_label: null,
  ss_tax_delivery: false, quote_valid_days: 30, insulation_enabled: false,
};
/** `signedRoof`: the design is a signed order whose agreed Roof line read this (Black: $300). */
type SubmitWorld = { styleD3: unknown; storedSelections: Record<string, unknown> | null; signedRoof?: string };
type SubmitTrace = { designSelects: string[]; designUpdates: any[]; ghl: { url: string; body: any }[] };

function submitRows(world: SubmitWorld, table: string): any[] | null {
  switch (table) {
    case "client_settings": return [SETTINGS];
    case "designs": {
      if (world.signedRoof != null) {
        const snap = agreedSnap(world.signedRoof);
        return [{
          client_id: T, short_code: CODE, status: "accepted", updated_at: "2026-10-06T10:00:00Z", ghl_contact_id: null,
          ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: "1001",
          accepted_at: "2026-10-01T12:00:00Z", estimate_lines: snap,
          accepted_snapshot: { estimateLines: snap, selections: world.storedSelections, paintColors: {} },
          selections: world.storedSelections,
        }];
      }
      return [{
        client_id: T, short_code: CODE, status: "draft", updated_at: "2026-10-06T10:00:00Z", ghl_contact_id: null,
        ghl_estimate_id: null, ghl_estimate_number: null, ghl_opportunity_id: null, ss_quote_number: null,
        accepted_at: null, estimate_lines: null, accepted_snapshot: null, selections: world.storedSelections,
      }];
    }
    case "client_users": return [{ role: "owner", title: null, access: null, user_id: UID, client_id: T, location_id: null, prefs: null }];
    case "building_styles": return [styleRow(world.styleD3)];
    case "building_sizes": return [SIZE];
    case "colors": return COLORS;
    default: return null;
  }
}

function submitChain(world: SubmitWorld, trace: SubmitTrace, table: string, ops: any[][]): any {
  const next = (op: any[]) => submitChain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle", "not", "or", "gte", "lte", "gt", "lt"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    if (verb === "update" && table === "designs") trace.designUpdates.push(ops.find((o) => o[0] === "update")?.[1]);
    if (verb !== "select") return Promise.resolve({ data: [], error: null }).then(ok, bad);
    if (table === "designs") trace.designSelects.push(String(ops.find((o) => o[0] === "select")?.[1] ?? ""));
    let rows = submitRows(world, table);
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

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The submit payload the designer sends, cut to the building and its roof. `roof` is merged into
 *  selections as given, so a test can leave roofProfile out entirely (an older designer). */
const payloadFor = (roof: Record<string, unknown>) => ({
  designId: CODE, clientId: T, source: "StructureStudio", deliveryFee: 0, declinedItems: [],
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100" },
  selections: { buildingStyle: "deluxe", buildingSize: "10x12", paint: "No Paint", ...roof },
  doors: [], ramps: [], windows: [], customOptions: [], discounts: [], roughOpenings: [],
  itemSummary: { singleDoors: 0, doubleDoors: 0, windows: 0, workbenches: [], shelves: [], doubleShelves: [], electricalItems: [], lofts: 0, loftSqft: 0, ramp: 0, lines: 0, notes: [] },
});

async function submit(roof: Record<string, unknown>, world: SubmitWorld) {
  const trace: SubmitTrace = { designSelects: [], designUpdates: [], ghl: [] };
  return await withEnv(async () => {
    const realFetch = globalThis.fetch;
    stubAuth.user = { id: UID, email: "owner@example.test" };
    stubAuth.error = null;
    stubDb.from = (table: string) => submitChain(world, trace, table, []);
    // A signed order's resubmit asks the amendment gate first (migration 210): open.
    stubRpc.rpc = (fn: string) => {
      if (fn === "order_amendment_gate") return Promise.resolve({ data: { signed: true, open: true, authority: "free_window", reason: "" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://services.leadconnectorhq.com/")) throw new Error(`unexpected fetch: ${url}`);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      trace.ghl.push({ url, body });
      if (url.endsWith("/contacts/upsert")) return Promise.resolve(jsonRes({ contact: { id: "contact-1" } }));
      if (url.includes("/products/")) return Promise.resolve(jsonRes({ products: [{ createdBy: "ghl-user-1", locationId: "loc-1" }] }));
      if (url.includes("/opportunities/search")) return Promise.resolve(jsonRes({ opportunities: [] }));
      if (url.endsWith("/opportunities/")) return Promise.resolve(jsonRes({ opportunity: { id: "opp-1" } }));
      if (/\/invoices\/estimate$/.test(url)) return Promise.resolve(jsonRes({ _id: "est-1", estimateNumber: 1001 }));
      return Promise.resolve(jsonRes({}));
    }) as typeof fetch;
    try {
      const res = await SUBMIT(new Request("https://stub.supabase.co/functions/v1/submit-estimate", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "harness/1.0", authorization: `Bearer ${USER_TOKEN}` },
        body: JSON.stringify(payloadFor(roof)),
      }));
      const body = await res.json();
      const estimate = trace.ghl.find((c) => /\/invoices\/estimate$/.test(c.url))?.body ?? null;
      const snap = [...trace.designUpdates].reverse().find((u) => u && u.estimate_lines)?.estimate_lines ?? null;
      const roofItem = estimate ? (estimate.items || []).find((i: any) => i.name === "Roof") : null;
      const roofLine = snap ? snap.lines.find((l: any) => l.kind === "roof") : null;
      return { status: res.status, body, trace, roofItem, roofLine };
    } finally {
      globalThis.fetch = realFetch;
      stubDb.from = null;
      stubRpc.rpc = null;
      stubAuth.user = null;
    }
  });
}

const METAL = { roofType: "Metal", roofColor: "Black" };
const PLAIN_STYLE = { wallHeightFt: 8 };
const SS_STYLE = { wallHeightFt: 8, roofMaterial: "metal", roofProfile: "standingseam" };
/** Black is $2.50 a square foot on a 10x12. */
const BLACK = 300;
/** The lines a signed order was agreed with, its Roof line reading `roofDesc` (Black: $300). */
const agreedSnap = (roofDesc: string) => ({
  version: 1, discount: 0, lines: [
    { kind: "building", itemKey: "", name: "Deluxe Gable (10x12)", desc: "", qty: 1, amount: 9000 },
    { kind: "paint", itemKey: "", name: "Paint Colors", desc: "Body: TBD, Trim: TBD", qty: 1, amount: 0 },
    { kind: "roof", itemKey: "", name: "Roof", desc: roofDesc, qty: 1, amount: BLACK },
  ],
});

async function roofOf(roof: Record<string, unknown>, world: SubmitWorld) {
  const r = await submit(roof, world);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(r.roofItem && r.roofLine, `a Roof line on the estimate and in the snapshot: ${JSON.stringify(r.body).slice(0, 300)}`);
  // The CRM estimate and estimate_lines carry the same words and the same money.
  assertEquals(r.roofLine.desc, r.roofItem.description);
  assertEquals(r.roofLine.amount, r.roofItem.amount);
  return { desc: r.roofLine.desc as string, amount: r.roofLine.amount as number, trace: r.trace };
}

Deno.test("submit-estimate: every design today keeps its Roof line byte for byte", async () => {
  // No pick anywhere and a style that says nothing: the 9 metal designs on the platform.
  const today = await roofOf({ ...METAL, roofProfile: "" }, { styleD3: PLAIN_STYLE, storedSelections: { ...METAL } });
  assertEquals([today.desc, today.amount], ["Metal — Black", BLACK]);
  // The same from a designer older than the pick (no key at all).
  const older = await roofOf({ ...METAL }, { styleD3: PLAIN_STYLE, storedSelections: { ...METAL } });
  assertEquals([older.desc, older.amount], ["Metal — Black", BLACK]);
  // An explicit AG Panel pick, and a shingle roof with a standing seam pick, are today's words too.
  assertEquals((await roofOf({ ...METAL, roofProfile: "agpanel" }, { styleD3: SS_STYLE, storedSelections: null })).desc, "Metal — Black");
  const shingle = await roofOf({ roofType: "Shingle", roofColor: "Weathered Wood", roofProfile: "standingseam" }, { styleD3: SS_STYLE, storedSelections: null });
  assertEquals([shingle.desc, shingle.amount], ["Shingle — Weathered Wood", 150]);
  assertEquals((await roofOf({ roofType: "", roofColor: "", roofProfile: "standingseam" }, { styleD3: SS_STYLE, storedSelections: null })).desc, "No roof selected");
  assertEquals((await roofOf({ roofType: "Metal", roofColor: "", roofProfile: "" }, { styleD3: PLAIN_STYLE, storedSelections: null })).desc, "Metal — (color TBD)");
});

Deno.test("submit-estimate: a standing seam pick is named on the line, at the same amount", async () => {
  const r = await roofOf({ ...METAL, roofProfile: "standingseam" }, { styleD3: PLAIN_STYLE, storedSelections: null });
  assertEquals([r.desc, r.amount], ["Metal (Standing Seam) — Black", BLACK]);
  // The design read asks for selections, for the older-designer fallback below.
  assert(r.trace.designSelects.some((s) => /(^|,\s*)selections(\s*,|$)/.test(s)), JSON.stringify(r.trace.designSelects));
  // No colour yet.
  assertEquals((await roofOf({ roofType: "Metal", roofColor: "", roofProfile: "standingseam" }, { styleD3: PLAIN_STYLE, storedSelections: null })).desc, "Metal (Standing Seam) — (color TBD)");
});

Deno.test("submit-estimate: the style's standing seam is the starting value; the design's own pick beats it either way", async () => {
  assertEquals((await roofOf({ ...METAL, roofProfile: "" }, { styleD3: SS_STYLE, storedSelections: null })).desc, "Metal (Standing Seam) — Black");
  assertEquals((await roofOf({ ...METAL, roofProfile: "agpanel" }, { styleD3: SS_STYLE, storedSelections: null })).desc, "Metal — Black");
  assertEquals((await roofOf({ ...METAL, roofProfile: "Standing Seam" }, { styleD3: PLAIN_STYLE, storedSelections: null })).desc, "Metal (Standing Seam) — Black");
  // A junk pick falls through to the style.
  assertEquals((await roofOf({ ...METAL, roofProfile: "shiny" }, { styleD3: SS_STYLE, storedSelections: null })).desc, "Metal (Standing Seam) — Black");
});

Deno.test("submit-estimate: a body with no roofProfile key keeps the stored design's pick; \"\" in the body is a real clear", async () => {
  const stored = { ...METAL, roofProfile: "standingseam" };
  // Production's designer (no key): the pick a rep set on beta stands.
  assertEquals((await roofOf({ ...METAL }, { styleD3: PLAIN_STYLE, storedSelections: stored })).desc, "Metal (Standing Seam) — Black");
  // The new designer always names it: "" clears the pick, back to the style's (AG Panel here).
  assertEquals((await roofOf({ ...METAL, roofProfile: "" }, { styleD3: PLAIN_STYLE, storedSelections: stored })).desc, "Metal — Black");
  // The body's own pick beats the stored one.
  assertEquals((await roofOf({ ...METAL, roofProfile: "agpanel" }, { styleD3: PLAIN_STYLE, storedSelections: stored })).desc, "Metal — Black");
  // A stored design with no selections at all is AG Panel.
  assertEquals((await roofOf({ ...METAL }, { styleD3: PLAIN_STYLE, storedSelections: null })).desc, "Metal — Black");
});

Deno.test("submit-estimate: a signed order with no pick keeps the profile it was signed with, whatever the style says now", async () => {
  // Signed as AG Panel, then the builder set the style's default to Standing Seam for future quotes.
  // The resubmit (a window moved, say) words the roof exactly as it was agreed.
  const roofLine = (r: Awaited<ReturnType<typeof submit>>) =>
    [...r.trace.designUpdates].reverse().find((u) => u && u.estimate_lines)?.estimate_lines?.lines?.find((l: any) => l.kind === "roof") ?? null;
  const flipped = await submit({ ...METAL, roofProfile: "" }, { styleD3: SS_STYLE, storedSelections: { ...METAL }, signedRoof: "Metal — Black" });
  assertEquals(flipped.status, 200, JSON.stringify(flipped.body));
  assertEquals(roofLine(flipped)?.desc, "Metal — Black");
  // An older designer (no key) and a stored design with no pick: the same.
  const older = await submit({ ...METAL }, { styleD3: SS_STYLE, storedSelections: { ...METAL }, signedRoof: "Metal — Black" });
  assertEquals(roofLine(older)?.desc, "Metal — Black");
  // The other way round: signed on standing seam, the style since put back to AG Panel.
  const back = await submit({ ...METAL, roofProfile: "" }, { styleD3: PLAIN_STYLE, storedSelections: { ...METAL }, signedRoof: "Metal (Standing Seam) — Black" });
  assertEquals(roofLine(back)?.desc, "Metal (Standing Seam) — Black");
  // A rep's own pick on the signed order is a real change, and still reads as one.
  const picked = await submit({ ...METAL, roofProfile: "standingseam" }, { styleD3: PLAIN_STYLE, storedSelections: { ...METAL }, signedRoof: "Metal — Black" });
  assertEquals(roofLine(picked)?.desc, "Metal (Standing Seam) — Black");
});

// ═══ 2. portal-settings stage_order_attribute_change ═══════════════════════════════════════════
/** `keyMiss`: the exact-key style read finds nothing (the design stores the style's label). */
type StageWorld = { design: Record<string, unknown>; styleD3: unknown; keyMiss?: boolean };
type StageTrace = { styleSelects: string[] };

function stageAnswer(world: StageWorld, trace: StageTrace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: UID, prefs: null }], error: null };
  if (table === "admin_audit") return { data: null, error: null };
  if (table === "building_styles" && has("maybeSingle")) {
    trace.styleSelects.push(String(arg("select")));
    return { data: world.keyMiss ? null : { id: "st-dlx", d3: world.styleD3 }, error: null };
  }
  // resolveBuildingContext's two catalog reads, and the key-or-label d3 read after an exact-key miss.
  if (table === "building_styles") {
    trace.styleSelects.push(String(arg("select")));
    return { data: [{ id: "st-dlx", key: "deluxe", label: "Deluxe Gable", d3: world.styleD3 }], error: null };
  }
  if (table === "building_sizes") return { data: [{ id: "sz-1012", base_price: 9000, label: "10x12", width_ft: 10, length_ft: 12 }], error: null };
  if (table === "designs" && has("maybeSingle")) return { data: world.design, error: null };
  if (table === "colors") return { data: COLORS, error: null };
  if (table === "style_cladding") return { data: [], error: null };
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}
function stageChain(world: StageWorld, trace: StageTrace, table: string, ops: any[][]): any {
  const next = (op: any[]) => stageChain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") return Promise.resolve({ error: null }).then(ok, bad);
    return Promise.resolve().then(() => stageAnswer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}
async function stage(attrs: Record<string, unknown>, world: StageWorld) {
  const trace: StageTrace = { styleSelects: [] };
  return await withEnv(async () => {
    const realFetch = globalThis.fetch;
    stubAuth.user = { id: UID, email: "owner@example.test" };
    stubAuth.error = null;
    stubDb.from = (table: string) => stageChain(world, trace, table, []);
    stubRpc.rpc = (fn: string) => {
      if (fn === "order_amendment_gate") return Promise.resolve({ data: { signed: true, open: true, authority: "free_window", reason: "" }, error: null });
      throw new Error(`unexpected rpc: ${fn}`);
    };
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as typeof fetch;
    try {
      const res = await SETTINGS_FN(new Request(`${ENV.SUPABASE_URL}/functions/v1/portal-settings`, {
        method: "POST",
        headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
        body: JSON.stringify({ action: "stage_order_attribute_change", shortCode: CODE, dryRun: true, attrs }),
      }));
      return { status: res.status, body: await res.json(), trace };
    } finally {
      globalThis.fetch = realFetch;
      stubDb.from = null;
      stubRpc.rpc = null;
      stubAuth.user = null;
    }
  });
}

/** A signed order whose Roof line was quoted as `roofDesc` (Black: $300). */
const signedOrder = (selections: Record<string, unknown>, roofDesc: string) => {
  const snap = {
    version: 1, discount: 0, lines: [
      { kind: "building", itemKey: "", name: "Deluxe Gable (10x12)", desc: "", qty: 1, amount: 9000 },
      { kind: "paint", itemKey: "", name: "Paint Colors", desc: "Body: TBD, Trim: TBD", qty: 1, amount: 0 },
      { kind: "roof", itemKey: "", name: "Roof", desc: roofDesc, qty: 1, amount: BLACK },
    ],
  };
  return {
    short_code: CODE, status: "accepted", accepted_at: "2026-10-01T12:00:00Z", ss_quote_number: "1001", ss_quote_pdf_url: null, image_url: null,
    estimate_lines: snap, accepted_snapshot: { estimateLines: snap, selections, paintColors: {} },
    selections: { style: "deluxe", size: "10x12", paint: "No Paint", ...selections }, paint_colors: {},
    contact: {}, custom_options: null, ro_dimensions: null, items: [], bldg_w: 10, bldg_h: 12, inventory_unit_id: null,
  };
};
const descLines = (body: any) => String(body.description ?? "").split("\n");

Deno.test("order screen: a paint change on a standing seam order (the design's pick) keeps the Roof line, so no phantom roof sentence", async () => {
  const design = signedOrder({ ...METAL, roofProfile: "standingseam" }, "Metal (Standing Seam) — Black");
  const { status, body, trace } = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design, styleD3: PLAIN_STYLE });
  assertEquals(status, 200, JSON.stringify(body));
  const lines = descLines(body);
  assert(lines.includes("Paint: Unpainted → Painted"), JSON.stringify(lines));
  assert(!lines.some((l) => l.startsWith("Roof:")), `the roof did not change: ${JSON.stringify(lines)}`);
  assertEquals(trace.styleSelects.filter((s) => /d3/.test(s)), ["id, d3"], "the style is read with its d3, once");
});

Deno.test("order screen: the same on a standing seam STYLE with no pick, and a recolour keeps the profile in the line", async () => {
  const design = signedOrder({ ...METAL }, "Metal (Standing Seam) — Black");
  const paint = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design, styleD3: SS_STYLE });
  assertEquals(paint.status, 200, JSON.stringify(paint.body));
  assert(!descLines(paint.body).some((l) => l.startsWith("Roof:")), JSON.stringify(descLines(paint.body)));
  // A real recolour still reads as one: the colour sentence and the Roof line's new price.
  const recolour = await stage({ roofColor: "Galvalume" }, { design: signedOrder({ ...METAL, roofProfile: "standingseam" }, "Metal (Standing Seam) — Black"), styleD3: PLAIN_STYLE });
  assertEquals(recolour.status, 200, JSON.stringify(recolour.body));
  const lines = descLines(recolour.body);
  assert(lines.includes("Roof color: Black → Galvalume") && lines.includes("Roof: price $300.00 → $0.00"), JSON.stringify(lines));
});

Deno.test("order screen: a style set to Standing Seam AFTER the order was signed as AG Panel leaves its Roof line alone", async () => {
  // Signed as "Metal — Black"; the builder then set the style's default to Standing Seam for future
  // quotes. A paint-only change must not add "Roof: options updated" to the change order the
  // customer signs, and a recolour keeps the agreed profile in the line.
  const design = signedOrder({ ...METAL }, "Metal — Black");
  const paint = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design, styleD3: SS_STYLE });
  assertEquals(paint.status, 200, JSON.stringify(paint.body));
  const lines = descLines(paint.body);
  assert(lines.includes("Paint: Unpainted → Painted"), JSON.stringify(lines));
  assert(!lines.some((l) => l.startsWith("Roof:")), `the roof did not change: ${JSON.stringify(lines)}`);
  const recolour = await stage({ roofColor: "Galvalume" }, { design, styleD3: SS_STYLE });
  assertEquals(recolour.status, 200, JSON.stringify(recolour.body));
  const rl = descLines(recolour.body);
  assert(rl.includes("Roof color: Black → Galvalume") && rl.includes("Roof: price $300.00 → $0.00"), JSON.stringify(rl));
  assert(!rl.some((l) => l.startsWith("Roof: options updated") || /Standing Seam/.test(l)), JSON.stringify(rl));
  // A design nobody signed has agreed to nothing: the style's starting value still applies to it.
  const unsigned = { ...signedOrder({ ...METAL }, "Metal — Black"), status: "sent", accepted_at: null, accepted_snapshot: null };
  const u = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design: unsigned, styleD3: SS_STYLE });
  assertEquals(u.status, 200, JSON.stringify(u.body));
  assert(descLines(u.body).includes("Roof: options updated"), JSON.stringify(descLines(u.body)));
});

Deno.test("order screen: a design that stores its style's LABEL finds the style's d3 the way the quote did", async () => {
  // Unsigned (no agreement to hold it to), quoted by submit-estimate, which matched "Deluxe Gable" by
  // label and worded the roof from that standing seam style. The exact-key read misses; the d3 is
  // then matched by key or label, so a paint change leaves the roof's words alone.
  const quoted = signedOrder({ ...METAL, style: "Deluxe Gable" }, "Metal (Standing Seam) — Black");
  const design = { ...quoted, status: "sent", accepted_at: null, accepted_snapshot: null };
  const r = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design, styleD3: SS_STYLE, keyMiss: true });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(!descLines(r.body).some((l) => l.startsWith("Roof:")), JSON.stringify(descLines(r.body)));
  assert(r.trace.styleSelects.includes("key, label, d3"), JSON.stringify(r.trace.styleSelects));
});

Deno.test("order screen: an AG Panel order is exactly as before (a paint change never touches its roof)", async () => {
  const design = signedOrder({ ...METAL }, "Metal — Black");
  const { status, body } = await stage({ paintStatus: "Paint", paintBody: "Barn Red", paintTrim: "Barn Red" }, { design, styleD3: PLAIN_STYLE });
  assertEquals(status, 200, JSON.stringify(body));
  assert(!descLines(body).some((l) => l.startsWith("Roof:")), JSON.stringify(descLines(body)));
});

// ═══ 3. portal-schedule appearanceFrom ═════════════════════════════════════════════════════════
type ScheduleWorld = { styles?: any[]; fail?: "error" | "throw" };
function scheduleAdmin(world: ScheduleWorld, reads: string[]) {
  const chain = (table: string, ops: any[][]): any => {
    const next = (op: any[]) => chain(table, [...ops, op]);
    const q: any = {};
    for (const m of ["select", "eq", "limit", "maybeSingle"]) q[m] = (...a: unknown[]) => next([m, ...a]);
    q.then = (ok: any, bad: any) => {
      reads.push(`${table}:${(ops.find((o) => o[0] === "select") ?? [])[1]}`);
      if (table === "building_styles" && world.fail === "error") return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } }).then(ok, bad);
      if (table === "building_styles") return Promise.resolve({ data: world.styles ?? [], error: null }).then(ok, bad);
      if (table === "colors") return Promise.resolve({ data: [{ label: "Black", hex: "#111111" }], error: null }).then(ok, bad);
      return Promise.resolve({ data: [], error: null }).then(ok, bad);
    };
    return q;
  };
  return {
    from: (table: string) => {
      if (table === "building_styles" && world.fail === "throw") throw new Error("connection reset");
      return chain(table, []);
    },
  };
}
const STYLES_SS = [{ key: "deluxe", label: "Deluxe Gable", d3: SS_STYLE }, { key: "utility", label: "Utility", d3: PLAIN_STYLE }];
async function card(sel: Record<string, unknown>, world: ScheduleWorld = { styles: STYLES_SS }, agreedLines: unknown = null) {
  const reads: string[] = [];
  const out = await SCHEDULE.appearanceFrom(scheduleAdmin(world, reads), T, sel, { body: "Barn Red" }, agreedLines);
  return { out, styleReads: reads.filter((r) => r.startsWith("building_styles")) };
}

Deno.test("crew card: a standing seam roof is \"Metal (Standing Seam)\"; every other roof is written as before", async () => {
  // The design's own pick: no style read at all.
  let r = await card({ style: "utility", roofType: "Metal", roofColor: "Black", roofProfile: "standingseam" });
  assertEquals([r.out.roof_type, r.out.roof_color, r.out.roof_color_hex], ["Metal (Standing Seam)", "Black", "#111111"]);
  assertEquals(r.styleReads, []);
  // No pick: the style's starting value, matched by key, or by label (an older row's buildingStyle).
  r = await card({ style: "deluxe", roofType: "Metal", roofColor: "Black" });
  assertEquals(r.out.roof_type, "Metal (Standing Seam)");
  assertEquals(r.styleReads, ["building_styles:key, label, d3"]);
  assertEquals((await card({ buildingStyle: "Deluxe Gable", roofType: "Metal" })).out.roof_type, "Metal (Standing Seam)");
  // AG Panel, by its style, by an explicit pick over a standing seam style, or by nothing said.
  assertEquals((await card({ style: "utility", roofType: "Metal" })).out.roof_type, "Metal");
  r = await card({ style: "deluxe", roofType: "Metal", roofProfile: "agpanel" });
  assertEquals([r.out.roof_type, r.styleReads.length], ["Metal", 0]);
  assertEquals((await card({ style: "nowhere", roofType: "Metal" })).out.roof_type, "Metal");
  // Not metal: untouched, and the style is never read.
  r = await card({ style: "deluxe", roofType: "Shingle", roofProfile: "standingseam" });
  assertEquals([r.out.roof_type, r.styleReads.length], ["Shingle", 0]);
  r = await card({ style: "deluxe" });
  assertEquals([r.out.roof_type, r.styleReads.length], [null, 0]);
  // The rest of the snapshot is what it was.
  assertEquals((await card({ style: "deluxe", roofType: "Metal", roofColor: "Black" })).out.body_color, "Barn Red");
});

Deno.test("crew card: a failed or throwing style read never fails the job; the roof is plain \"Metal\"", async () => {
  for (const fail of ["error", "throw"] as const) {
    const r = await card({ style: "deluxe", roofType: "Metal", roofColor: "Black" }, { styles: STYLES_SS, fail });
    assertEquals([r.out.roof_type, r.out.roof_color_hex], ["Metal", "#111111"], fail);
  }
});

Deno.test("crew card: a signed order with no pick is built as it was signed, whatever the style says now", async () => {
  // Signed as "Metal — Black" on a style since set to Standing Seam: plain "Metal", and the agreed
  // line decides, so the style is never read.
  let r = await card({ style: "deluxe", roofType: "Metal", roofColor: "Black" }, { styles: STYLES_SS }, agreedSnap("Metal — Black"));
  assertEquals([r.out.roof_type, r.styleReads.length], ["Metal", 0]);
  // Signed on standing seam, the style since put back to AG Panel.
  r = await card({ style: "utility", roofType: "Metal", roofColor: "Black" }, { styles: STYLES_SS }, agreedSnap("Metal (Standing Seam) — Black"));
  assertEquals([r.out.roof_type, r.styleReads.length], ["Metal (Standing Seam)", 0]);
  // The design's own pick still wins over the agreement.
  r = await card({ style: "deluxe", roofType: "Metal", roofProfile: "standingseam" }, { styles: STYLES_SS }, agreedSnap("Metal — Black"));
  assertEquals(r.out.roof_type, "Metal (Standing Seam)");
  // Signed with a shingle roof and switched to metal since: the style's starting value, read as before.
  r = await card({ style: "deluxe", roofType: "Metal" }, { styles: STYLES_SS }, agreedSnap("Shingle — Weathered Wood"));
  assertEquals([r.out.roof_type, r.styleReads], ["Metal (Standing Seam)", ["building_styles:key, label, d3"]]);
});

Deno.test("crew card: create_job hands appearanceFrom the agreed lines of the design it read", async () => {
  // The handler path is not driven here (create_job needs the whole board); the wiring is pinned in
  // the source instead: both design reads select the agreement, and both calls pass it.
  const src = await Deno.readTextFile(new URL("../../portal-schedule/index.ts", import.meta.url));
  const reads = src.match(/\.select\("[^"]*selections, paint_colors[^"]*"\)/g) ?? [];
  assertEquals(reads.length, 2, JSON.stringify(reads));
  for (const r of reads) assert(/accepted_at/.test(r) && /accepted_snapshot/.test(r) && /estimate_lines/.test(r), r);
  const calls = src.match(/appearanceFrom\(admin, clientId, [^\n]*\)\);/g) ?? [];
  assertEquals(calls.length, 2, JSON.stringify(calls));
  for (const c of calls) assert(/agreedRoofLines\((design|master)\)\)\);$/.test(c), c);
});
