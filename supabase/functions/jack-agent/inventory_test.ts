// inventory.ts: lot buildings changed by Jack. No network: a fake Inventory tab stands in for portal-settings'
// list_inventory, shop_settings, list_locations, update_inventory, save_inventory_listing and
// save_inventory_photos, built from the real routes (portal-settings/index.ts 7839, 8461-8495, 8608-8626,
// 8661-8711, 8902-8922, 8954-9135): the same bodies, keys-only-when-present saves, refusals, columns and
// photo ordering (sort_order, then created_at). crm_rules_list stands in for the rule warning. Any other
// route throws, so no test can reach a delete, an upload, the AI background or a status.

import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, runTool, SENTENCES, type Store, strictCost, toolsFor, type TurnState, type Who } from "./agent.ts";
import { PIECE_KINDS, PIECE_TOOLS, register } from "./pieces.ts";
import { leaksContactDetails } from "./redact.ts";
import { SAID } from "./common.ts";
import { RULE_WARN_SAID } from "./ruleWarn.ts";
import { BIG_CHANGE_PCT, byRef, INV_NOTES, INV_SAID, INVENTORY_KINDS, inventoryPiece, LISTING_EVENTS, money, parsePrice, PRICE_MAX_CENTS, RECORDS_SWITCH, refsOf } from "./inventory.ts";

register([inventoryPiece]);

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const U1 = "3f8a2c1e-5b7d-4e9a-8c6f-1a2b3c4d5e6f"; // #10423 12x24 lofted barn, listed, priced, 3 photos
const U2 = "7c1d9e2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f"; // #10424 10x16 utility, not listed, no price, no photos
const U3 = "b2e4f6a8-1c3d-4e5f-8a9b-0c1d2e3f4a5b"; // #10400 14x28 garage, sold to Dale
const LOT_A = "11a2b3c4-d5e6-4f70-8a9b-c0d1e2f3a4b5";
const LOT_B = "22b3c4d5-e6f7-4a81-9b0c-d1e2f3a4b5c6";
const LOT_OLD = "33c4d5e6-f7a8-4b92-8c1d-e2f3a4b5c6d7";
const P1 = "44d5e6f7-a8b9-4ca3-9d2e-f3a4b5c6d7e8";
const P2 = "55e6f7a8-b9c0-4db4-8e3f-a4b5c6d7e8f9";
const P3 = "66f7a8b9-c0d1-4ec5-9f4a-b5c6d7e8f9a0";
const DESC = "Ready to go home today. Call the office at (816) 555-0100 or sales@ridgeline.test, or stop by 1234 N Main St.";

// deno-lint-ignore no-explicit-any
type Any = any;

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────

function makeStore(init: { on?: boolean; off?: string[] } = {}) {
  const proposals = new Map<string, ProposalRow>();
  let seq = 0;
  const state = { on: init.on ?? true, off: init.off ?? [], proposals };
  const store: Store = {
    settings: () => Promise.resolve({ on: state.on, off: state.off }),
    setOff: (_c, off) => { state.off = off; return Promise.resolve(); },
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(), ...p } as ProposalRow;
      // The database hands jsonb back, never the object the code wrote.
      row.payload = JSON.parse(JSON.stringify(row.payload));
      proposals.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c, id) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when, at) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, JSON.parse(JSON.stringify(patch)));
      return Promise.resolve(r);
    },
    addProposalCost: () => Promise.resolve(),
    proposals: () => Promise.resolve([...proposals.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve(null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(true),
    forgetMemory: () => Promise.resolve(true),
  };
  return { store, state };
}

const wallet: Deps["wallet"] = {
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
};

const LIFECYCLE_LABEL: Record<string, string> = {
  requested: "Requested", in_queue: "In Queue", scheduled_build: "Scheduled to build", built: "Built",
  scheduled_delivery: "Scheduled to be brought to location", at_location: "Available to sell at Location", delivered: "Delivered to the buyer",
};

/** What a write does instead of answering: no answer at all, an answer lost after it landed, a 500, or
 *  the route's own refusal. "half" (photos) sets the first photo's place and then falls over. */
type Fail = { mode: "lost" | "lost_landed" | "half" } | { status: number; error: string };
const WRITES = new Set(["update_inventory", "save_inventory_listing", "save_inventory_photos"]);
const READS = new Set(["list_inventory", "shop_settings", "list_locations", "crm_rules_list"]);

function makeWorld() {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 6, 12, 0, ++tick)).toISOString();
  const w = {
    units: [
      {
        id: U2, serial: 10424, full_serial: "UT1016-10424", design_short_code: "SS-UTILITY22", location_id: LOT_B, asking_price_cents: null as number | null,
        sale_state: "unsold", sold_design_short_code: null, sold_at: null, sold_first_name: null, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z",
        listed: false, show_price_online: true, public_title: null as string | null, public_description: null as string | null,
        style: "utility", size: "10x16", lifecycle: "built",
      },
      {
        id: U1, serial: 10423, full_serial: "LB1224-10423", design_short_code: "SS-LOFTED234", location_id: LOT_A as string | null, asking_price_cents: 845000 as number | null,
        sale_state: "unsold", sold_design_short_code: null, sold_at: null, sold_first_name: null, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-30T10:00:00Z",
        listed: true, show_price_online: true, public_title: "12x24 Lofted Barn, ready now" as string | null, public_description: DESC as string | null,
        style: "lofted_barn", size: "12x24", lifecycle: "at_location",
      },
      {
        id: U3, serial: 10400, full_serial: "GA1428-10400", design_short_code: "SS-GARAGE777", location_id: LOT_A, asking_price_cents: 1500000,
        sale_state: "sold", sold_design_short_code: "SS-DALESMITH9", sold_at: "2026-11-02T10:00:00Z", sold_first_name: "Dale", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z",
        listed: false, show_price_online: true, public_title: null, public_description: null,
        style: "garage", size: "14x28", lifecycle: "at_location",
      },
    ] as Any[],
    photos: [
      { id: P1, unit_id: U1, storage_key: `builder-a/${U1}/${P1}.jpg`, sort_order: 0, ai_edited: false, created_at: "2026-10-21T10:00:00Z" },
      { id: P2, unit_id: U1, storage_key: `builder-a/${U1}/${P2}.jpg`, sort_order: 1, ai_edited: false, created_at: "2026-10-21T10:01:00Z" },
      // An AI-background copy takes its source photo's place (photo_bg_status), so ties are normal.
      { id: P3, unit_id: U1, storage_key: `builder-a/${U1}/${P3}.jpg`, sort_order: 1, ai_edited: true, created_at: "2026-10-22T10:00:00Z" },
    ] as Any[],
    estimates: [
      { inventory_unit_id: U1, short_code: "SS-DALEEST22", contact: { name: "Dale Smith 816-555-0199 dale@example.test" }, status: "quoted", ghl_estimate_number: "1041", created_at: "2026-11-03T10:00:00Z" },
    ],
    lots: [
      { id: LOT_A, name: "Sedalia", street: "1234 N Main St", city: "Sedalia", state: "MO", zip: "65301", active: true },
      { id: LOT_B, name: "Warsaw lot", street: "88 County Road 12", city: "Warsaw", state: "MO", zip: "65355", active: true },
      { id: LOT_OLD, name: "Old Clinton lot", street: "9 Elm Ave", city: "Clinton", state: "MO", zip: "64735", active: false },
    ] as Any[],
    shop: { enabled: true, hide_all_prices: false },
    pay: { payments_online_enabled: true, cardpointe_merchid: "496160873888" },
    rules: [
      { id: "9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d", name: "Text shop leads", scopeKind: "contacts", pipelineId: null, triggerKind: "event", triggerEvent: "shop_request", elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null, actions: [{ kind: "send_sms", params: { body: "Thanks for asking about {{deal_title}}!" } }], nextRunAt: null, armedCount: null, lastRun: null, stale: [] },
      { id: "8b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e", name: "Paused one", scopeKind: "contacts", pipelineId: null, triggerKind: "event", triggerEvent: "shop_purchase", elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: false, appliesFrom: null, actions: [{ kind: "send_email", params: { subject: "Hi", body: "Hi" } }], nextRunAt: null, armedCount: null, lastRun: null, stale: [] },
      { id: "7c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f", name: "Delivered review", scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: "delivered", elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null, actions: [{ kind: "send_email", params: { subject: "Hi", body: "Hi" } }], nextRunAt: null, armedCount: null, lastRun: null, stale: [] },
    ] as Any[],
    rulesStatus: 200, rulesError: null as string | null,
    listStatus: 200, listError: null as string | null,
    shopStatus: 200, lotsStatus: 200,
    /** list_inventory falls over once any write has been sent. */
    listFailsAfterWrite: false,
    readOnly: false,
    fail: {} as Record<string, Fail>,
    calls: [] as { action: string; body: Record<string, unknown> }[],
    stamp,
  };
  const has = (b: object, k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const unit = (id: unknown) => w.units.find((u) => u.id === String(id ?? "").trim());
  const photosOf = (unitId: string) => w.photos.filter((p) => p.unit_id === unitId)
    .sort((a, b) => a.sort_order - b.sort_order || Date.parse(a.created_at) - Date.parse(b.created_at));
  const photoView = (p: Any) => ({ id: p.id, aiEdited: !!p.ai_edited, url: `https://proj.supabase.co/storage/v1/object/public/inventory-photos/${p.storage_key}` });

  // The real routes' saves. Each answers as the route does.
  const save: Record<string, (b: Any, half?: boolean) => { status: number; data: Record<string, unknown> | null }> = {
    update_inventory(b) {
      const unitId = String(b.unitId ?? "").trim();
      if (!unitId) return { status: 400, data: { error: "unitId is required." } };
      if (has(b, "status")) return { status: 400, data: { error: "A building's status can't be set by hand. It follows your Build and Delivery schedules, and it sells when you invoice it." } };
      const patch: Any = { updated_at: stamp() };
      if (has(b, "askingPriceCents")) {
        const v = b.askingPriceCents;
        const cents = v == null || v === "" ? null : Math.round(Number(v));
        if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return { status: 400, data: { error: "Invalid asking price." } };
        patch.asking_price_cents = cents;
      }
      if (has(b, "locationId")) {
        const lid = String(b.locationId ?? "").trim() || null;
        // Only by id and builder, never `active` (8483-8485).
        if (lid && !w.lots.some((l) => l.id === lid)) return { status: 400, data: { error: "Unknown location." } };
        patch.location_id = lid;
      }
      const u = unit(unitId);
      if (!u) return { status: 404, data: { error: "Inventory unit not found." } };
      Object.assign(u, patch);
      return { status: 200, data: { ok: true } };
    },
    save_inventory_listing(b) {
      const unitId = String(b.unitId ?? "").trim();
      if (!unitId) return { status: 400, data: { error: "unitId is required." } };
      const patch: Any = { updated_at: stamp() };
      if (has(b, "listed")) patch.listed = b.listed === true;
      if (has(b, "showPriceOnline")) patch.show_price_online = b.showPriceOnline !== false;
      if (has(b, "publicTitle")) patch.public_title = String(b.publicTitle ?? "").trim().slice(0, 120) || null;
      if (has(b, "publicDescription")) patch.public_description = String(b.publicDescription ?? "").trim().slice(0, 4000) || null;
      const u = unit(unitId);
      if (!u) return { status: 404, data: { error: "Inventory unit not found." } };
      Object.assign(u, patch);
      return { status: 200, data: { ok: true } };
    },
    save_inventory_photos(b, half = false) {
      const u = unit(b.unitId);
      if (!u) return { status: 404, data: { error: "Inventory unit not found." } };
      const asList = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 50);
      const remove = asList(b.remove);
      if (remove.length) w.photos = w.photos.filter((p) => !(p.unit_id === u.id && remove.includes(p.id)));
      if (asList(b.add).length) throw new Error("Jack never adds photos");
      const order = asList(b.order);
      for (let i = 0; i < order.length; i++) {
        const p = w.photos.find((x) => x.unit_id === u.id && x.id === order[i]);
        if (p) p.sort_order = i;
        if (half) return { status: 500, data: { error: "Couldn't load those photos. Please try again." } };
      }
      return { status: 200, data: { ok: true, photos: photosOf(u.id).map(photoView) } };
    },
  };

  const portal: Deps["portal"] = (action, body) => {
    w.calls.push({ action, body: JSON.parse(JSON.stringify(body)) });
    const out = (status: number, data: Record<string, unknown> | null) => Promise.resolve({ status, data });
    if (!READS.has(action) && !WRITES.has(action)) throw new Error(`Jack called a route it must not: ${action}`);
    if (action === "list_inventory") {
      if (w.listStatus !== 200) return out(w.listStatus, w.listError ? { error: w.listError } : null);
      if (w.listFailsAfterWrite && w.calls.some((c) => WRITES.has(c.action))) return out(500, { error: "Couldn't load your inventory." });
      const locById = new Map(w.lots.map((l) => [l.id, l]));
      return out(200, {
        ok: true,
        units: w.units.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((u) => {
          const loc = u.location_id ? locById.get(u.location_id) : null;
          return {
            id: u.id, serial: u.serial, fullSerial: u.full_serial, shortCode: u.design_short_code,
            locationId: u.location_id, locationName: loc?.name ?? null, locationCity: loc?.city ?? null,
            askingPriceCents: u.asking_price_cents, lifecycle: u.lifecycle, lifecycleLabel: LIFECYCLE_LABEL[u.lifecycle],
            saleState: u.sale_state, soldDesignShortCode: u.sold_design_short_code, soldFirstName: u.sold_first_name, soldAt: u.sold_at,
            soldLabelExpiresAt: u.sold_at ? new Date(Date.parse(u.sold_at) + 30 * 86400000).toISOString() : null,
            style: u.style, size: u.size, imageUrl: `https://proj.supabase.co/storage/v1/object/public/floor-plans/${u.design_short_code}.pdf`,
            roofType: "gable", roofColor: "Charcoal", bodyColor: "Barn Red", trimColor: "White",
            createdAt: u.created_at, updatedAt: u.updated_at, atLocationSince: null,
            estimates: w.estimates.filter((e) => e.inventory_unit_id === u.id).map((e) => ({ shortCode: e.short_code, name: e.contact?.name || "", status: e.status, estimateNumber: e.ghl_estimate_number, createdAt: e.created_at })),
            listed: !!u.listed, showPriceOnline: u.show_price_online !== false,
            publicTitle: u.public_title ?? "", publicDescription: u.public_description ?? "",
            photos: photosOf(u.id).map(photoView),
          };
        }),
        // Every lot, inactive ones too, as the real route reads them (8961).
        locations: w.lots.map((l) => ({ id: l.id, name: l.name, city: l.city })),
        soldLabelDays: 30,
      });
    }
    if (action === "shop_settings") {
      if (w.shopStatus !== 200) return out(w.shopStatus, { error: "Couldn't load your shop settings." });
      return out(200, {
        ok: true,
        settings: { enabled: w.shop.enabled, hideAllPrices: w.shop.hide_all_prices, depositMode: "percent", depositValue: 10, allowPayInFull: true, gtmContainerId: "", heading: "", intro: "", termsUrl: "" },
        paymentsLive: !!(w.pay.payments_online_enabled && w.pay.cardpointe_merchid),
      });
    }
    if (action === "list_locations") {
      if (w.lotsStatus !== 200) return out(w.lotsStatus, { error: "Couldn't load your locations." });
      return out(200, { ok: true, locations: w.lots.filter((l) => l.active).map((l) => ({ ...l, sort_order: 0, buildings: w.units.filter((u) => u.location_id === l.id).length })) });
    }
    if (action === "crm_rules_list") {
      if (w.rulesStatus !== 200) return out(w.rulesStatus, w.rulesError ? { error: w.rulesError } : null);
      return out(200, { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: JSON.parse(JSON.stringify(w.rules)), labels: [], timeZone: "America/Chicago" });
    }
    // A write.
    if (w.readOnly) return out(403, { error: "This operator account is read-only." });
    const f = w.fail[action];
    if (f && "status" in f) return out(f.status, { error: f.error });
    if (f && f.mode === "lost") return out(0, null);
    if (f && f.mode === "half") { const r = save[action](body, true); return out(r.status, r.data); }
    const r = save[action](body);
    if (f && f.mode === "lost_landed") return out(0, null);
    return out(r.status, r.data);
  };
  return { w, portal, photosOf };
}

function djb2(t: string) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function makeDeps(store: Store, portal: Deps["portal"], over: Partial<Deps> = {}): Deps {
  return {
    env: () => undefined,
    store,
    portal,
    call(fn, action, body) { return fn === "portal-settings" ? this.portal(action, body) : Promise.resolve({ status: 404, data: null }); },
    wallet,
    fetch: () => { throw new Error("no Claude in these tests"); },
    canRead: () => true,
    canEdit: () => true,
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve("h" + djb2(t)),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
    ...over,
  };
}

function setup(opts: { on?: boolean; off?: string[]; deps?: Partial<Deps> } = {}) {
  const { store, state } = makeStore({ on: opts.on, off: opts.off });
  const { w, portal, photosOf } = makeWorld();
  const deps = makeDeps(store, portal, opts.deps);
  const turn = (): TurnState => ({ who, chatId: "chat1", off: opts.off ?? [], proposalIds: [] });
  const writes = () => w.calls.filter((c) => WRITES.has(c.action));
  const unitRef = (id: string) => refsOf(w.units.map((u) => u.id), "u").get(id)!;
  const photoRef = (unitId: string, id: string) => refsOf(photosOf(unitId).map((p) => p.id), "p").get(id)!;
  const row = (id: string) => w.units.find((u) => u.id === id)!;
  const order = (unitId: string) => photosOf(unitId).map((p) => p.id);
  return { store, state, w, deps, turn, writes, unitRef, photoRef, row, order };
}
type X = ReturnType<typeof setup>;

const change = (o: Record<string, unknown> = {}): Any => ({
  action: "price_and_lot", unit: "", price: "", lot: "", listed: "keep", showPrice: "keep", title: "", description: "", cover: "", photoOrder: [], ...o,
});
const json = (s: string) => JSON.parse(s);

/** Proposes through Claude's tool, as the person's turn would, and returns the card. */
async function proposed(x: X, input: unknown, deps: Deps = x.deps) {
  const s = x.turn();
  const out = await runTool(deps, s, "propose_inventory_change", input);
  return { out, s, card: s.proposalIds.length ? x.state.proposals.get(s.proposalIds[0])! : null };
}
const approve = (x: X, card: ProposalRow, by: Who = who, deps: Deps = x.deps) => handleProposalApprove(deps, by, { id: card.id, hash: card.shown_hash });
const undo = (x: X, card: ProposalRow, deps: Deps = x.deps) => handleProposalUndo(deps, who, { id: card.id });
const rowOf = (x: X, card: ProposalRow) => x.state.proposals.get(card.id)!;
/** A hand edit on the Inventory tab: the value, and updated_at moves, as the routes do. */
const byHand = (x: X, id: string, patch: Record<string, unknown>) => Object.assign(x.row(id), patch, { updated_at: x.w.stamp() });

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("look_at_inventory: refs, prices and listings, and no customer, phone, email or street reaches Claude", async () => {
  const x = setup();
  const s = x.turn();
  const out = await runTool(x.deps, s, "look_at_inventory", { unit: "", search: "" });
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content), out.content);
  for (const id of [U1, U2, U3, LOT_A, LOT_B, P1]) assert(!out.content.includes(id), `no uuid ${id}`);
  for (const bad of ["Dale", "Main St", "County Road", "Elm Ave", "SS-", "496160873888", "storage"]) assert(!out.content.includes(bad), `nothing of ${bad}`);
  const a = json(out.content);
  assertEquals(a.count, 3);
  const barn = a.buildings.find((b: Any) => b.serial === 10423);
  assert(/^u-[bcdfghjkmnpqrstv]{5,}$/.test(barn.ref), barn.ref);
  assertEquals(barn.building, "12x24 Lofted Barn");
  assertEquals(barn.lot, "Sedalia");
  assertEquals(barn.askingPrice, "$8,450");
  assertEquals(barn.status, "Available to sell at Location");
  assertEquals(barn.photos, 3);
  assertEquals(barn.online.listed, true);
  assertEquals(barn.online.priceShown, true);
  assert(barn.online.description.includes("[phone]") && barn.online.description.includes("[email]") && barn.online.description.includes("[address]"), barn.online.description);
  assertEquals(a.buildings.find((b: Any) => b.serial === 10424).askingPrice, "no price");
  // Sold ones last.
  assertEquals(a.buildings.at(-1).serial, 10400);
  assertEquals(a.buildings.at(-1).sold, true);
  // Active lots only, by name and town.
  assertEquals(a.lots, ["Sedalia", "Warsaw lot (Warsaw)"]);
  // Switched on in Settings, never "card payments are on": checkout also needs invoices kept here and
  // no test mode (shop-checkout payReady), which Jack can't read.
  assertEquals(a.shop, { on: true, pricesHiddenOnShop: false, cardPaymentsSwitchedOn: true });
  assert(a.notes.includes(INV_SAID.paymentsUnsure), JSON.stringify(a.notes));
  // A look writes nothing.
  assertEquals(s.proposalIds.length, 0);
  assertEquals(x.writes().length, 0);
  assertEquals(x.state.proposals.size, 0);
  assertEquals(PIECE_TOOLS.get("look_at_inventory")?.customerWords, undefined);
});

Deno.test("look_at_inventory: one building in full has its photo refs in order, and search narrows the list", async () => {
  const x = setup();
  const one = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: x.unitRef(U1), search: "" })).content);
  assertEquals(one.building.photos.map((p: Any) => [p.position, p.cover, p.aiEdited]), [[1, true, false], [2, false, false], [3, false, true]]);
  assertEquals(one.building.photos.map((p: Any) => p.ref), [x.photoRef(U1, P1), x.photoRef(U1, P2), x.photoRef(U1, P3)]);
  assert(one.building.photos.every((p: Any) => /^p-[bcdfghjkmnpqrstv]{5,}$/.test(p.ref)));
  assert(one.building.online.description.startsWith("Ready to go home today."), "the whole description");
  const search = async (q: string) => json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: q })).content);
  assertEquals((await search("warsaw")).buildings.map((b: Any) => b.serial), [10424]);
  assertEquals((await search("10423")).buildings.map((b: Any) => b.serial), [10423]);
  assertEquals((await search("sold")).buildings.map((b: Any) => b.serial), [10400]);
  assertEquals((await search("12x24 sedalia")).buildings.map((b: Any) => b.serial), [10423]);
  assertEquals((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "u-zzzzz", search: "" })).content, INV_SAID.noRef);
});

Deno.test("look_at_inventory: a refused or failed read says so, and a shop or lots it can't read are said, not guessed", async () => {
  {
    const x = setup();
    x.w.listStatus = 403; x.w.listError = "Your access doesn't include Inventory.";
    assertEquals(await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "" }), { content: "Your access doesn't include Inventory.", isError: true });
  }
  {
    const x = setup();
    x.w.listStatus = 500;
    assertEquals((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "" })).content, SAID.readFailed);
  }
  {
    const x = setup();
    x.w.shopStatus = 500; x.w.lotsStatus = 500;
    const a = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "" })).content);
    assertEquals(a.shop, null);
    assertEquals(a.lots, null);
    assert(a.notes.some((n: string) => n.includes("Online Shop")) && a.notes.some((n: string) => n.includes("lots")));
  }
});

// ── Proposing ────────────────────────────────────────────────────────────────────────────────────

Deno.test("propose price: the card holds exactly the change, says the price goes live, and nothing is written", async () => {
  const x = setup();
  const { out, card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7,900" }));
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content), out.content);
  assertEquals(card!.kind, "inventory_price");
  assertEquals(card!.status, "ready");
  assertEquals(card!.title, "New asking price: #10423 12x24 Lofted Barn");
  assertEquals(card!.payload.body, { unitId: U1, askingPriceCents: 790000 });
  assertEquals(card!.preview.lines, [{ label: "Asking price", from: "$8,450", to: "$7,900" }]);
  assertEquals(card!.preview.notes, [INV_NOTES.priceLive, INV_NOTES.priceUndo]);
  assertEquals(card!.payload.shop, { enabled: true, hideAllPrices: false });
  const a = json(out.content);
  assert(a.notes.includes(INV_NOTES.priceLive), "the tool's answer says it too");
  assertEquals(a.serial, 10423);
  assertEquals(x.writes().length, 0);
  // Cents and a dollar sign both read.
  assertEquals(parsePrice("$8,450.50"), { cents: 845050 });
  assertEquals(money(845050), "$8,450.50");
});

Deno.test("propose price: no live-price line when it isn't listed, its price is hidden, the shop is off or hides prices", async () => {
  const cases: [string, (x: X) => void, string][] = [
    ["not listed", () => {}, U2],
    ["price hidden", (x) => { x.row(U1).show_price_online = false; }, U1],
    ["shop off", (x) => { x.w.shop.enabled = false; }, U1],
    ["prices hidden", (x) => { x.w.shop.hide_all_prices = true; }, U1],
  ];
  for (const [what, arrange, id] of cases) {
    const x = setup();
    arrange(x);
    const { card } = await proposed(x, change({ unit: x.unitRef(id), price: "9000" }));
    assert(card, what);
    assert(!card!.preview.notes.includes(INV_NOTES.priceLive), what);
    if (id === U2) assertEquals(card!.payload.shop, null, "an unlisted building's card doesn't hang on the shop");
  }
  // A big jump gets its own line; taking the price off a live listing says Call for price.
  const x = setup();
  const big = (await proposed(x, change({ unit: x.unitRef(U1), price: "3000" }))).card!;
  assert(big.preview.notes.includes(INV_NOTES.bigChange(64, true, "$8,450")), JSON.stringify(big.preview.notes));
  const off = (await proposed(x, change({ unit: x.unitRef(U1), price: "none" }))).card!;
  assertEquals(off.payload.body, { unitId: U1, askingPriceCents: null });
  assertEquals(off.preview.notes, [INV_NOTES.callForPrice]);
});

Deno.test("propose lot: by name, only active lots, and the card says it changes the record only", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ unit: x.unitRef(U1), lot: "Warsaw lot" }));
  assertEquals(card!.payload.body, { unitId: U1, locationId: LOT_B });
  assertEquals(card!.title, "Change the lot: #10423 12x24 Lofted Barn");
  assertEquals(card!.preview.lines, [{ label: "Lot", from: "Sedalia", to: "Warsaw lot (Warsaw)" }]);
  assertEquals(card!.preview.notes, [INV_NOTES.lotRecord, INV_NOTES.lotShop]);
  assertEquals(card!.payload.lotId, LOT_B);
  // By town too, and both at once.
  const both = (await proposed(x, change({ unit: x.unitRef(U1), lot: "warsaw", price: "8000" }))).card!;
  assertEquals(both.payload.body, { unitId: U1, askingPriceCents: 800000, locationId: LOT_B });
  assertEquals(both.title, "Price and lot: #10423 12x24 Lofted Barn");
  // A sold building's lot moves its pickup.
  const sold = (await proposed(x, change({ unit: x.unitRef(U3), lot: "Warsaw lot" }))).card!;
  assertEquals(sold.preview.notes, [INV_NOTES.lotRecord, INV_NOTES.lotSold]);
  // An inactive lot isn't offered; the list names the active ones, never a street.
  const old = await proposed(x, change({ unit: x.unitRef(U1), lot: "Old Clinton lot" }));
  assertEquals(old.out.isError, true);
  assertEquals(old.out.content, `There's no lot called "Old Clinton lot". The lots are: Sedalia, Warsaw lot (Warsaw). Ask the person which one they mean, and don't guess.`);
  // Two lots with one name: ask.
  x.w.lots.push({ id: "44c4d5e6-f7a8-4b92-8c1d-e2f3a4b5c6d8", name: "Sedalia", street: "5 Oak Ave", city: "Sedalia", state: "MO", zip: "65301", active: true });
  const two = await proposed(x, change({ unit: x.unitRef(U2), lot: "Sedalia" }));
  assert(two.out.isError && two.out.content.startsWith("More than one lot matches"), two.out.content);
  assert(!leaksContactDetails(two.out.content) && !two.out.content.includes("Oak Ave"));
});

Deno.test("propose: what it refuses, in plain words, writing nothing", async () => {
  const x = setup();
  const say = async (input: Any) => {
    const r = await proposed(x, input);
    assert(r.out.isError, `refused: ${JSON.stringify(input)} -> ${r.out.content}`);
    assert(!leaksContactDetails(r.out.content));
    return r.out.content;
  };
  assertEquals(await say(change({ unit: "u-bbbbb", price: "9000" })), INV_SAID.noRef);
  // Nothing asked is a question, never "that's how it stands" (Claude would say a status is already so).
  assertEquals(await say(change({ unit: x.unitRef(U1) })), INV_SAID.askWhat);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "keep", lot: " " })), INV_SAID.askWhat);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "0" })), INV_SAID.zero);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "eight grand" })), INV_SAID.badPrice);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "8,45" })), INV_SAID.badPrice);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "20000000" })), INV_SAID.tooHigh);
  assertEquals(await say(change({ unit: x.unitRef(U3), price: "9000" })), INV_SAID.soldPrice);
  assertEquals(await say(change({ unit: x.unitRef(U1), price: "9000", listed: "yes" })), INV_SAID.separate("listing"));
  assertEquals(await say(change({ action: "listing", unit: x.unitRef(U1), cover: x.photoRef(U1, P2) })), INV_SAID.separate("photos"));
  assertEquals(await say(change({ action: "delete", unit: x.unitRef(U1) })), INV_SAID.pickAction);
  assertEquals(await say(change({ action: "listing", unit: x.unitRef(U3), listed: "yes" })), INV_SAID.soldList);
  assertEquals(await say(change({ action: "listing", unit: x.unitRef(U1), description: "Call [phone] today" })), INV_SAID.blanks);
  assertEquals(await say(change({ action: "listing", unit: x.unitRef(U1), title: "x".repeat(121) })), INV_SAID.titleLong(121));
  assertEquals(await say(change({ action: "listing", unit: x.unitRef(U1) })), INV_SAID.askWhat);
  assertEquals(await say(change({ action: "photos", unit: x.unitRef(U2), cover: "p-bbbbb" })), INV_SAID.fewPhotos);
  assertEquals(await say(change({ action: "photos", unit: x.unitRef(U1), cover: "p-zzzzz" })), INV_SAID.noPhotoRef("p-zzzzz"));
  assertEquals(await say(change({ action: "photos", unit: x.unitRef(U1), photoOrder: [x.photoRef(U1, P2), x.photoRef(U1, P2)] })), INV_SAID.photoTwice);
  // A ref from another building's photo names nothing here.
  x.w.photos.push({ id: "77a8b9c0-d1e2-4fd6-8a5b-c6d7e8f9a0b1", unit_id: U2, storage_key: "k", sort_order: 0, ai_edited: false, created_at: "2026-11-01T00:00:00Z" });
  const other = refsOf(["77a8b9c0-d1e2-4fd6-8a5b-c6d7e8f9a0b1"], "p").get("77a8b9c0-d1e2-4fd6-8a5b-c6d7e8f9a0b1")!;
  assertEquals(await say(change({ action: "photos", unit: x.unitRef(U1), cover: other })), INV_SAID.noPhotoRef(other));
  // What's already so makes no card, and says so.
  const same = await proposed(x, change({ unit: x.unitRef(U1), price: "8450", lot: "Sedalia" }));
  assertEquals(json(same.out.content), { shown: false, note: INV_SAID.nothing });
  const sameTitle = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), title: "  12x24 Lofted Barn, ready now  ", listed: "yes" }));
  assertEquals(json(sameTitle.out.content).shown, false);
  const sameCover = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P1) }));
  assertEquals(json(sameCover.out.content).shown, false);
  assertEquals(x.state.proposals.size, 0);
  assertEquals(x.writes().length, 0);
});

Deno.test("propose tools: one strict tool, every parameter required, no unions; offered with inventory edit, the records switch and no customer words", async () => {
  const look = PIECE_TOOLS.get("look_at_inventory")!, propose = PIECE_TOOLS.get("propose_inventory_change")!;
  assertEquals(strictCost([look.def, propose.def]), { tools: 1, optional: 0, unions: 0 });
  assertEquals(look.def.strict, undefined);
  const schema = propose.def.input_schema;
  assertEquals(Object.keys(schema.properties).sort(), ["action", "cover", "description", "listed", "lot", "photoOrder", "price", "showPrice", "title", "unit"]);
  assertEquals([...schema.required].sort(), Object.keys(schema.properties).sort());
  assertEquals(schema.additionalProperties, false);
  assertEquals(schema.properties.action.enum, ["price_and_lot", "listing", "photos"]);
  assert(!JSON.stringify(schema).includes("anyOf") && !JSON.stringify(schema).includes("null"), "no unions, nothing nullable");
  assertEquals(propose.proposesChange, true);
  assertEquals(propose.switchKey, RECORDS_SWITCH);
  assertEquals(look.switchKey, RECORDS_SWITCH);

  const names = (deps: Deps, s: TurnState) => toolsFor(deps, s).map((t) => t.name);
  const x = setup();
  const all = toolsFor(x.deps, x.turn());
  assert(all.some((t) => t.name === "look_at_inventory" && t.strict === undefined));
  assert(all.some((t) => t.name === "propose_inventory_change" && t.strict === true), "Jack's whole set stays inside the strict budget");
  const viewer = makeDeps(x.store, x.deps.portal, { canEdit: () => false });
  assert(names(viewer, x.turn()).includes("look_at_inventory") && !names(viewer, x.turn()).includes("propose_inventory_change"));
  assertEquals((await runTool(viewer, x.turn(), "propose_inventory_change", change({ unit: x.unitRef(U1), price: "1" }))).content, "That isn't available here right now.");
  const blind = makeDeps(x.store, x.deps.portal, { canRead: () => false, canEdit: () => false });
  assert(!names(blind, x.turn()).includes("look_at_inventory"));
  assert(!names(x.deps, { ...x.turn(), off: [RECORDS_SWITCH] }).some((t) => t.includes("inventory_change") || t === "look_at_inventory"));
  const read = { ...x.turn(), customerWordsRead: true };
  assert(names(x.deps, read).includes("look_at_inventory") && !names(x.deps, read).includes("propose_inventory_change"));
  assertEquals(x.state.proposals.size, 0);
});

Deno.test("kinds: three, each needs inventory edit and the records switch to approve or undo", () => {
  assertEquals(INVENTORY_KINDS, ["inventory_price", "inventory_listing", "inventory_photos"]);
  for (const k of INVENTORY_KINDS) {
    const spec = PIECE_KINDS.get(k)!;
    const p = { payload: {} } as ProposalRow;
    assertEquals(spec.areas(p), ["inventory"]);
    assertEquals(spec.switches(p), [RECORDS_SWITCH]);
    assert(!spec.private && !spec.showOnly && spec.apply && spec.undo, k);
    assert(spec.nothingToDo!(p), "an empty card has nothing to approve");
  }
});

// ── Approve ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("approve price: one update_inventory with exactly the card's body; a second press can't run it again", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900", lot: "Warsaw lot" }));
  assertEquals((await handleProposalApprove(x.deps, who, { id: card!.id, hash: "something else" })).status, 409);
  assertEquals(x.writes().length, 0);
  assertEquals((await approve(x, card!)).status, 200);
  assertEquals(x.writes(), [{ action: "update_inventory", body: { unitId: U1, askingPriceCents: 790000, locationId: LOT_B } }]);
  assert(!("status" in x.writes()[0].body), "never a status");
  assertEquals(x.row(U1).asking_price_cents, 790000);
  assertEquals(x.row(U1).location_id, LOT_B);
  const row = rowOf(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(row.approved_by, "u1");
  assertEquals(row.result, { saved: 2, created: 0, reports: [] });
  assertEquals(row.undo.unitId, U1);
  assertEquals((await approve(x, card!)).status, 409);
  assertEquals(x.writes().length, 1);
  assertEquals(((await handleProposalGet(x.deps, who, { id: card!.id })).body.proposal as Any).canUndo, true);
});

Deno.test("approve: an operator in view-as may approve and is named; a read-only one is refused by the route, once", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    const op: Who = { ...who, operatorEmail: "ops@example.test" };
    assertEquals((await approve(x, card!, op)).status, 200);
    assertEquals(rowOf(x, card!).approved_by_operator, "ops@example.test");
    assertEquals(rowOf(x, card!).status, "applied");
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    x.w.readOnly = true;
    await approve(x, card!, { ...who, operatorEmail: "ops@example.test" });
    const row = rowOf(x, card!);
    assertEquals(row.status, "failed");
    assertEquals(row.failure, "This operator account is read-only. Nothing was saved.");
    assertEquals(x.writes().length, 1);
    assertEquals(row.undo, null);
    assertEquals(x.row(U1).asking_price_cents, 845000);
  }
});

Deno.test("approve: refused without inventory edit, with the records switch off, with Jack off, and once expired", async () => {
  const run = async (opts: Parameters<typeof setup>[0], expire = false) => {
    const x = setup(opts);
    const s = x.turn();
    s.off = [];
    // The card is made while everything was allowed.
    await runTool(makeDeps(x.store, x.deps.portal), s, "propose_inventory_change", change({ unit: x.unitRef(U1), price: "7900" }));
    const card = x.state.proposals.get(s.proposalIds[0])!;
    if (expire) card.expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await approve(x, card);
    return { status: r.status, error: r.body.error, writes: x.writes().length };
  };
  assertEquals(await run({ deps: { canEdit: (a) => a !== "inventory" } }), { status: 403, error: SENTENCES.noAccess, writes: 0 });
  assertEquals(await run({ off: [RECORDS_SWITCH] }), { status: 403, error: SENTENCES.switchedOff, writes: 0 });
  assertEquals(await run({ on: false }), { status: 403, error: SENTENCES.off, writes: 0 });
  assertEquals(await run({}, true), { status: 409, error: SENTENCES.expired, writes: 0 });
});

Deno.test("approve listing and photos: refused without inventory edit, switched off, Jack off and expired, like a price card", async () => {
  const asks: [string, Any][] = [
    ["inventory_listing", change({ action: "listing", unit: U2, listed: "yes" })],
    ["inventory_photos", change({ action: "photos", unit: U1, cover: P3 })],
  ];
  for (const [kind, ask] of asks) {
    const run = async (opts: Parameters<typeof setup>[0], expire = false) => {
      const x = setup(opts);
      const s = x.turn();
      s.off = [];
      const input = { ...ask, unit: x.unitRef(ask.unit), cover: ask.cover ? x.photoRef(U1, ask.cover) : "" };
      await runTool(makeDeps(x.store, x.deps.portal), s, "propose_inventory_change", input);
      const card = x.state.proposals.get(s.proposalIds[0])!;
      assertEquals(card.kind, kind);
      if (expire) card.expires_at = new Date(Date.now() - 1000).toISOString();
      const r = await approve(x, card);
      return { status: r.status, error: r.body.error, writes: x.writes().length, left: rowOf(x, card).status };
    };
    assertEquals([kind, await run({ deps: { canEdit: (a) => a !== "inventory" } })], [kind, { status: 403, error: SENTENCES.noAccess, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({ off: [RECORDS_SWITCH] })], [kind, { status: 403, error: SENTENCES.switchedOff, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({ on: false })], [kind, { status: 403, error: SENTENCES.off, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({}, true)], [kind, { status: 409, error: SENTENCES.expired, writes: 0, left: "expired" }]);
  }
});

Deno.test("approve listing and photos: a building deleted or sold since, or an unreadable list, stops it, and nothing is sent", async () => {
  const cases: [string, Any, (x: X) => void, string][] = [
    ["listing: deleted", change({ action: "listing", unit: U2, listed: "yes" }), (x) => { x.w.units = x.w.units.filter((u) => u.id !== U2); }, INV_SAID.gone],
    ["listing: sold since", change({ action: "listing", unit: U2, listed: "yes" }), (x) => byHand(x, U2, { sale_state: "sold" }), INV_SAID.soldSince],
    ["listing: the field moved", change({ action: "listing", unit: U1, title: "Ready today" }), (x) => byHand(x, U1, { public_title: "Edited by hand" }), INV_SAID.moved("Listing title")],
    ["listing: list unreadable", change({ action: "listing", unit: U2, listed: "yes" }), (x) => { x.w.listStatus = 500; }, INV_SAID.applyRead],
    ["photos: deleted", change({ action: "photos", unit: U1, cover: P3 }), (x) => { x.w.units = x.w.units.filter((u) => u.id !== U1); }, INV_SAID.gone],
    ["photos: a photo removed", change({ action: "photos", unit: U1, cover: P3 }), (x) => { x.w.photos = x.w.photos.filter((p) => p.id !== P2); }, INV_SAID.photosMoved],
    ["photos: list unreadable", change({ action: "photos", unit: U1, cover: P3 }), (x) => { x.w.listStatus = 500; }, INV_SAID.applyRead],
  ];
  for (const [what, ask, arrange, failure] of cases) {
    const x = setup();
    const { card } = await proposed(x, { ...ask, unit: x.unitRef(ask.unit), cover: ask.cover ? x.photoRef(U1, ask.cover) : "" });
    assert(card, what);
    arrange(x);
    await approve(x, card!);
    const row = rowOf(x, card!);
    assertEquals([what, row.status, row.failure], [what, "failed", failure]);
    assertEquals([what, x.writes().length, row.undo ?? null], [what, 0, null]);
  }
});

Deno.test("approve listing: a lost answer is never sent again; the building says whether it landed", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes" }));
    x.w.fail.save_inventory_listing = { mode: "lost_landed" };
    await approve(x, card!);
    assertEquals([rowOf(x, card!).status, x.writes().length, x.row(U2).listed], ["applied", 1, true]);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes" }));
    x.w.fail.save_inventory_listing = { mode: "lost" };
    await approve(x, card!);
    assertEquals([rowOf(x, card!).status, rowOf(x, card!).failure, x.writes().length, x.row(U2).listed], ["failed", INV_SAID.notSent, 1, false]);
  }
});

Deno.test("price: a ceiling at $1,000,000, and a line on the card for a change of 50% or more either way", async () => {
  assertEquals(PRICE_MAX_CENTS, 100_000_000);
  assertEquals(parsePrice("1,000,000"), { cents: 100_000_000 });
  for (const t of ["1,000,000.01", "1000001", "2,500,000", "$10,000,000"]) assertEquals([t, parsePrice(t)], [t, { error: INV_SAID.tooHigh }]);
  assert(INV_SAID.tooHigh.includes("$1,000,000") && !/—|quote/i.test(INV_SAID.tooHigh), INV_SAID.tooHigh);
  const x = setup();
  const said = await proposed(x, change({ unit: x.unitRef(U1), price: "1,250,000" }));
  assertEquals([said.out.isError, said.out.content, said.card], [true, INV_SAID.tooHigh, null]);
  // The building is $8,450 now.
  assertEquals(BIG_CHANGE_PCT, 50);
  const notes = async (price: string) => (await proposed(x, change({ unit: x.unitRef(U1), price }))).card!.preview.notes as string[];
  assert((await notes("13000")).includes(INV_NOTES.bigChange(54, false, "$8,450")), "54% higher");
  assert((await notes("12675")).includes(INV_NOTES.bigChange(50, false, "$8,450")), "exactly half again");
  assert((await notes("4225")).includes(INV_NOTES.bigChange(50, true, "$8,450")), "exactly half off");
  for (const p of ["12500", "9000", "5000"]) assert(!(await notes(p)).some((n) => n.startsWith("That's ") && n.includes("than the price now")), `${p}: under half either way, no line`);
  assertEquals(x.writes().length, 0);
});

Deno.test("approve: anything the card showed that moved since stops it, and nothing is sent", async () => {
  const cases: [string, (x: X) => void, string, Any?][] = [
    ["price changed by hand", (x) => byHand(x, U1, { asking_price_cents: 800000 }), INV_SAID.moved("Asking price")],
    ["listing edited (updated_at moved)", (x) => byHand(x, U1, { public_title: "Edited" }), INV_SAID.movedAny],
    ["sold since", (x) => byHand(x, U1, { sale_state: "sold" }), INV_SAID.soldSince],
    ["shop turned off", (x) => { x.w.shop.enabled = false; }, INV_SAID.shopMoved],
    ["shop hides all prices now", (x) => { x.w.shop.hide_all_prices = true; }, INV_SAID.shopMoved],
    ["shop can't be read", (x) => { x.w.shopStatus = 500; }, INV_SAID.shopRead],
    ["unit deleted", (x) => { x.w.units = x.w.units.filter((u) => u.id !== U1); }, INV_SAID.gone],
    ["inventory can't be read", (x) => { x.w.listStatus = 500; }, INV_SAID.applyRead],
    ["lot made inactive", (x) => { x.w.lots[1].active = false; }, INV_SAID.lotGone, change({ lot: "Warsaw lot" })],
    ["lots can't be read", (x) => { x.w.lotsStatus = 500; }, INV_SAID.lotsRead, change({ lot: "Warsaw lot" })],
  ];
  for (const [what, arrange, failure, input] of cases) {
    const x = setup();
    const { card } = await proposed(x, { ...(input ?? change({ price: "7900" })), unit: x.unitRef(U1) });
    assert(card, what);
    arrange(x);
    await approve(x, card!);
    const row = rowOf(x, card!);
    assertEquals(row.status, "failed", what);
    assertEquals(row.failure, failure, what);
    assertEquals(x.writes().length, 0, what);
    assertEquals(row.undo, null, what);
  }
});

Deno.test("approve: the route's own refusal goes on the card, and nothing is sent again", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    x.w.fail.update_inventory = { status: 400, error: "Invalid asking price." };
    await approve(x, card!);
    assertEquals(rowOf(x, card!).status, "failed");
    assertEquals(rowOf(x, card!).failure, "Invalid asking price. Nothing was saved.");
    assertEquals(x.writes().length, 1);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    x.w.fail.update_inventory = { status: 404, error: "Inventory unit not found." };
    await approve(x, card!);
    assertEquals(rowOf(x, card!).failure, INV_SAID.gone);
    assertEquals(x.writes().length, 1);
  }
});

Deno.test("approve: a lost answer is never sent again; the building says whether it landed", async () => {
  const run = async (fail: Fail, arrange: (x: X) => void = () => {}) => {
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    x.w.fail.update_inventory = fail;
    arrange(x);
    await approve(x, card!);
    assertEquals(x.writes().length, 1, "sent once");
    return rowOf(x, card!);
  };
  {
    const row = await run({ mode: "lost" });
    assertEquals(row.status, "failed");
    assertEquals(row.failure, INV_SAID.notSent);
  }
  {
    const row = await run({ mode: "lost_landed" });
    assertEquals(row.status, "applied");
    assertEquals(row.undo.fields[0].to, 790000);
  }
  {
    const row = await run({ status: 503, error: "Service unavailable" });
    assertEquals(row.status, "failed");
    assertEquals(row.failure, INV_SAID.notSent);
  }
  {
    const row = await run({ mode: "lost" }, (x) => { x.w.listFailsAfterWrite = true; });
    assertEquals(row.status, "partly_applied");
    assertEquals(row.result.reports[0].reason, INV_SAID.unsure);
    assertEquals(row.undo, null);
  }
});

Deno.test("approve: the edges of a lost answer, and a card changed after it was shown", async () => {
  {
    // The answer is lost and the building still has the old price, but someone saved it meanwhile:
    // that can't be told apart from a save that landed and was changed back, so it's "check", not
    // "nothing changed".
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    const meanwhile: Deps["portal"] = (action, body) => {
      if (action !== "update_inventory") return x.deps.portal(action, body);
      x.w.calls.push({ action, body: JSON.parse(JSON.stringify(body)) });
      byHand(x, U1, { public_title: "Edited meanwhile" });
      return Promise.resolve({ status: 0, data: null });
    };
    await approve(x, card!, who, makeDeps(x.store, meanwhile));
    const row = rowOf(x, card!);
    assertEquals(row.status, "partly_applied");
    assertEquals(row.result.reports[0].reason, INV_SAID.unsure);
    assertEquals(row.undo, null);
    assertEquals(x.writes().length, 1);
  }
  {
    // A 200 without ok is no answer: never sent again, and the building says it didn't land.
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    x.w.fail.update_inventory = { status: 200, error: "" };
    await approve(x, card!);
    assertEquals([rowOf(x, card!).status, rowOf(x, card!).failure], ["failed", INV_SAID.notSent]);
    assertEquals(x.writes().length, 1);
  }
  {
    // A body that isn't what was shown (a status slipped in, a photo added to the order) runs nothing.
    const x = setup();
    const { card } = await proposed(x, change({ unit: x.unitRef(U1), price: "7900" }));
    rowOf(x, card!).payload.body.status = "sold";
    await approve(x, card!);
    assertEquals([rowOf(x, card!).status, rowOf(x, card!).failure], ["failed", INV_SAID.emptyCard]);
    const photos = (await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }))).card!;
    rowOf(x, photos).payload.body.order.push("99c0d1e2-f3a4-4bf8-8c7d-e8f9a0b1c2d3");
    await approve(x, photos);
    assertEquals([rowOf(x, photos).status, rowOf(x, photos).failure], ["failed", INV_SAID.emptyCard]);
    assertEquals(x.writes().length, 0);
  }
});

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────

async function approvedPrice(input: Any = change({ price: "7900", lot: "Warsaw lot" })) {
  const x = setup();
  const { card } = await proposed(x, { ...input, unit: x.unitRef(U1) });
  await approve(x, card!);
  assertEquals(rowOf(x, card!).status, "applied");
  return { x, card: card! };
}

Deno.test("undo price and lot: puts both back with only their keys, and a second press is refused", async () => {
  const { x, card } = await approvedPrice();
  assertEquals((await undo(x, card)).status, 200);
  assertEquals(x.writes().at(-1), { action: "update_inventory", body: { unitId: U1, askingPriceCents: 845000, locationId: LOT_A } });
  assertEquals([x.row(U1).asking_price_cents, x.row(U1).location_id], [845000, LOT_A]);
  assertEquals(rowOf(x, card).status, "undone");
  assertEquals(rowOf(x, card).result.undo, { restored: 2, removed: 0, failed: 0, reports: [] });
  assertEquals((await undo(x, card)).status, 409);
  assertEquals(x.writes().length, 2);
});

Deno.test("undo: a field changed since is named and left; the rest goes back", async () => {
  const { x, card } = await approvedPrice();
  byHand(x, U1, { asking_price_cents: 775000 });
  await undo(x, card);
  assertEquals(x.writes().at(-1)?.body, { unitId: U1, locationId: LOT_A });
  assertEquals(x.row(U1).asking_price_cents, 775000);
  const res = rowOf(x, card).result.undo;
  assertEquals(res.restored, 1);
  assertEquals(res.reports, [{ label: "Asking price", status: "changed", reason: INV_SAID.changedSince }]);
  assertEquals(rowOf(x, card).status, "undone");
});

Deno.test("undo: a failed read or a lost answer leaves Undo there; a sold-since building keeps its price", async () => {
  {
    const { x, card } = await approvedPrice();
    x.w.listStatus = 500;
    await undo(x, card);
    assertEquals(rowOf(x, card).status, "applied");
    assertEquals(x.writes().length, 1);
    assertEquals(((await handleProposalGet(x.deps, who, { id: card.id })).body.proposal as Any).canUndo, true);
  }
  {
    const { x, card } = await approvedPrice();
    x.w.fail.update_inventory = { mode: "lost" };
    await undo(x, card);
    assertEquals(rowOf(x, card).status, "applied");
    assertEquals(rowOf(x, card).result.undo.reports[0].reason, INV_SAID.undoAgain);
    // The next press reads again and sends only what still holds Jack's value.
    delete x.w.fail.update_inventory;
    await undo(x, card);
    assertEquals(rowOf(x, card).status, "undone");
    assertEquals(x.writes().length, 3);
  }
  {
    const { x, card } = await approvedPrice(change({ price: "7900" }));
    byHand(x, U1, { sale_state: "sold" });
    await undo(x, card);
    assertEquals(x.writes().length, 1, "nothing sent");
    assertEquals(x.row(U1).asking_price_cents, 790000);
    assertEquals(rowOf(x, card).result.undo.reports, [{ label: "Asking price", status: "kept", reason: INV_SAID.soldKeepPrice }]);
  }
});

Deno.test("undo: a building deleted since says so once, and isn't offered again as a retry", async () => {
  const { x, card } = await approvedPrice();
  x.w.fail.update_inventory = { status: 404, error: "Inventory unit not found." };
  await undo(x, card);
  assertEquals(rowOf(x, card).status, "undone");
  assertEquals(rowOf(x, card).result.undo.reports, [{ label: card.title, status: "gone", reason: INV_SAID.undoGone }]);
  assertEquals(x.writes().length, 2);
});

// ── Listings ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("listing: putting a building on the shop says what goes public and which rules a shop request starts; Approve saves only what changes", async () => {
  const x = setup();
  const { out, card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes", showPrice: "yes", title: "10x16 Utility Shed" }));
  assert(!out.isError, out.content);
  assertEquals(card!.kind, "inventory_listing");
  assertEquals(card!.title, "List on your Online Shop: #10424 10x16 Utility");
  assertEquals(card!.payload.body, { unitId: U2, listed: true, publicTitle: "10x16 Utility Shed" });
  assertEquals(card!.preview.lines, [{ label: "On your Online Shop", from: "Not listed", to: "Listed" }, { label: "Listing title", from: "", to: "10x16 Utility Shed" }]);
  const rules = `Once it's listed, a request, purchase or question from your shop can set off your rule "Text shop leads", which texts or emails the customer by itself.`;
  assertEquals(card!.preview.notes, [INV_NOTES.goesPublic, INV_NOTES.noPrice, INV_NOTES.noPhotos, rules, INV_NOTES.listUndo]);
  assertEquals(json(out.content).rules, rules);
  assertEquals(x.writes().length, 0);
  await approve(x, card!);
  assertEquals(x.writes(), [{ action: "save_inventory_listing", body: { unitId: U2, listed: true, publicTitle: "10x16 Utility Shed" } }]);
  assertEquals([x.row(U2).listed, x.row(U2).public_title], [true, "10x16 Utility Shed"]);
  assertEquals(rowOf(x, card!).status, "applied");
  await undo(x, card!);
  assertEquals(x.writes().at(-1)?.body, { unitId: U2, listed: false, publicTitle: "" });
  assertEquals([x.row(U2).listed, x.row(U2).public_title], [false, null]);
  assertEquals(rowOf(x, card!).status, "undone");
  assertEquals(LISTING_EVENTS.includes("shop_request") && LISTING_EVENTS.includes("shop_purchase"), true);
});

Deno.test("listing: who can't open Automations hears no names; rules that can't be read say so; no Customer Hub says nothing", async () => {
  const notes = async (x: X, deps: Deps = x.deps) => (await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes" }), deps)).card!.preview.notes as string[];
  {
    const x = setup();
    const n = await notes(x, makeDeps(x.store, x.deps.portal, { canRead: (a) => a !== "settings_crm" }));
    assert(n.includes("Once it's listed, a request, purchase or question from your shop may start one of your rules, and it may text or email the customer by itself."), JSON.stringify(n));
    assert(!n.some((t) => t.includes("Text shop leads")));
    assert(!x.w.calls.some((c) => c.action === "crm_rules_list"), "names aren't even read for them");
  }
  {
    const x = setup();
    x.w.rulesStatus = 500;
    const n = await notes(x);
    assert(n.some((t) => t.startsWith("I couldn't check your rules just now.")), JSON.stringify(n));
    assertEquals(RULE_WARN_SAID.unread.startsWith("I couldn't check your rules just now."), true);
  }
  {
    const x = setup();
    x.w.rulesStatus = 403; x.w.rulesError = "The Customer Hub is not part of your subscription - add it under Settings -> Billing.";
    const n = await notes(x);
    assert(!n.some((t) => /rule/i.test(t)), JSON.stringify(n));
  }
  {
    // Rules on these events that are paused, or rules on other events, aren't named.
    const x = setup();
    x.w.rules[0].enabled = false;
    const n = await notes(x);
    assert(!n.some((t) => /rule/i.test(t)), JSON.stringify(n));
  }
});

Deno.test("listing: shop off, taking it off, hiding the price, and clearing words read right", async () => {
  {
    const x = setup();
    x.w.shop.enabled = false;
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes" }));
    assertEquals(card!.preview.notes, [INV_NOTES.shopOff]);
  }
  {
    const x = setup();
    // "keep" in a text field leaves it, the way the enums say it.
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), listed: "no", title: "keep", description: "Keep" }));
    assertEquals(card!.title, "Take off your Online Shop: #10423 12x24 Lofted Barn");
    assertEquals(card!.payload.body, { unitId: U1, listed: false });
    assertEquals(card!.preview.notes, [INV_NOTES.comesOff]);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), showPrice: "no" }));
    assertEquals(card!.payload.body, { unitId: U1, showPriceOnline: false });
    assertEquals(card!.preview.lines, [{ label: "Price on the shop", from: "Shown", to: "Hidden" }]);
    assertEquals(card!.preview.notes, [INV_NOTES.priceComesOff]);
  }
  {
    const x = setup();
    x.row(U1).show_price_online = false;
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), showPrice: "yes" }));
    assertEquals(card!.preview.notes, [INV_NOTES.priceShownNow("$8,450")]);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), description: "none" }));
    assertEquals(card!.payload.body, { unitId: U1, publicDescription: "" });
    assertEquals(card!.preview.lines[0].long, true);
    assertEquals(card!.preview.notes, [INV_NOTES.wordsLive, INV_NOTES.contactDropped]);
    await approve(x, card!);
    assertEquals(x.row(U1).public_description, null);
    await undo(x, card!);
    assertEquals(x.row(U1).public_description, DESC);
  }
});

Deno.test("listing: words the person typed with a number stay on the card, and Claude's answer is scrubbed", async () => {
  const x = setup();
  const { out, card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), description: "  Ready now. Call 816-555-0142 to see it.  " }));
  assertEquals(card!.payload.body, { unitId: U1, publicDescription: "Ready now. Call 816-555-0142 to see it." });
  assertEquals(card!.preview.lines[0].to, "Ready now. Call 816-555-0142 to see it.");
  assert(!leaksContactDetails(out.content), out.content);
  // Approve re-reads it the way the route stores it, so the trimmed words compare equal.
  await approve(x, card!);
  assertEquals(rowOf(x, card!).status, "applied");
  byHand(x, U1, { public_description: "Hand edit" });
  await undo(x, card!);
  assertEquals(x.row(U1).public_description, "Hand edit");
  assertEquals(rowOf(x, card!).result.undo.reports, [{ label: "Listing description", status: "changed", reason: INV_SAID.changedSince }]);
});

Deno.test("listing: the list's cut-short description can't be saved back; the full one can", async () => {
  const x = setup();
  const LONG = "Treated floor joists, a loft on both ends, two windows and a nine-lite door, painted to match your house. ".repeat(4).trim();
  x.row(U1).public_description = LONG;
  const list = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "lofted" })).content);
  const b = list.buildings[0];
  assertEquals(b.online.descriptionCut, true);
  assert(b.online.description.endsWith("…") && b.online.description.length === 200, b.online.description);
  assert(list.notes.some((n: string) => n.includes("descriptionCut")), "Claude is told to look in full first");
  // Built on the cut copy: the rest of the description would be lost.
  const cut = await proposed(x, change({ action: "listing", unit: b.ref, description: `${b.online.description} Delivery is free in the county.` }));
  assertEquals(cut.out, { content: INV_SAID.descriptionCut, isError: true });
  assertEquals(cut.card, null);
  // The full look has all of it, with no cut flag, and words built on that make a card.
  const one = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: b.ref, search: "" })).content).building;
  assertEquals(one.online.description, LONG);
  assertEquals(one.online.descriptionCut, undefined);
  const good = await proposed(x, change({ action: "listing", unit: b.ref, description: `${one.online.description} Delivery is free in the county.` }));
  assertEquals(good.card!.payload.body, { unitId: U1, publicDescription: `${LONG} Delivery is free in the county.` });
  // A short description is never cut, so nothing about it is refused.
  x.row(U2).public_description = "Ready now.";
  const short = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "utility" })).content).buildings[0];
  assertEquals([short.online.description, short.online.descriptionCut], ["Ready now.", undefined]);
  assertEquals(x.writes().length, 0);
});

Deno.test("listing: an edit since stops Approve, and a building that sold since stays off the shop on Undo", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U2), listed: "yes" }));
    byHand(x, U2, { asking_price_cents: 500000 });
    await approve(x, card!);
    assertEquals(rowOf(x, card!).failure, INV_SAID.movedAny);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "listing", unit: x.unitRef(U1), listed: "no" }));
    await approve(x, card!);
    byHand(x, U1, { sale_state: "sold" });
    await undo(x, card!);
    assertEquals(x.row(U1).listed, false);
    assertEquals(x.writes().length, 1);
    assertEquals(rowOf(x, card!).result.undo.reports, [{ label: "On your Online Shop", status: "kept", reason: INV_SAID.soldKeepOff }]);
  }
});

// ── Photos ───────────────────────────────────────────────────────────────────────────────────────

Deno.test("photos: a new cover sends the whole order once, Undo puts the old order back, and photos are never added or removed", async () => {
  const x = setup();
  const { out, card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }));
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content) && !out.content.includes("storage"), out.content);
  assertEquals(card!.kind, "inventory_photos");
  assertEquals(card!.title, "New cover photo: #10423 12x24 Lofted Barn");
  assertEquals(card!.payload.body, { unitId: U1, order: [P3, P1, P2] });
  assertEquals(card!.preview.lines, [{ label: "Cover photo", from: "Photo 1", to: "Photo 3" }]);
  assert(card!.preview.photos.to[0].url.includes(P3) && card!.preview.photos.to[0].aiEdited === true);
  assertEquals(card!.preview.notes, [INV_NOTES.coverLive]);
  await approve(x, card!);
  assertEquals(x.order(U1), [P3, P1, P2]);
  assertEquals(rowOf(x, card!).status, "applied");
  await undo(x, card!);
  assertEquals(x.order(U1), [P1, P2, P3]);
  assertEquals(rowOf(x, card!).status, "undone");
  assertEquals(x.writes().map((c) => Object.keys(c.body).sort()), [["order", "unitId"], ["order", "unitId"]]);
  // An order: the ones named first, the rest after in their order now.
  const two = (await proposed(x, change({ action: "photos", unit: x.unitRef(U1), photoOrder: [x.photoRef(U1, P2)] }))).card!;
  assertEquals(two.payload.body.order, [P2, P1, P3]);
  assertEquals(two.title, "New cover photo: #10423 12x24 Lofted Barn");
  const three = (await proposed(x, change({ action: "photos", unit: x.unitRef(U1), photoOrder: [x.photoRef(U1, P1), x.photoRef(U1, P3)] }))).card!;
  assertEquals(three.payload.body.order, [P1, P3, P2]);
  assertEquals(three.title, "Photo order: #10423 12x24 Lofted Barn");
  assertEquals(three.preview.lines, [{ label: "Order", from: "1, 2, 3", to: "1, 3, 2" }]);
});

Deno.test("photos: a photo added or moved since stops Approve; Undo leaves an order someone changed", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P2) }));
    x.w.photos.push({ id: "88b9c0d1-e2f3-4ae7-9b6c-d7e8f9a0b1c2", unit_id: U1, storage_key: "k2", sort_order: 5, ai_edited: false, created_at: "2026-11-06T00:00:00Z" });
    await approve(x, card!);
    assertEquals(rowOf(x, card!).failure, INV_SAID.photosMoved);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P2) }));
    await approve(x, card!);
    // Someone drags them on the Inventory tab.
    x.w.photos.find((p) => p.id === P3)!.sort_order = -1;
    await undo(x, card!);
    assertEquals(x.writes().length, 1);
    assertEquals(rowOf(x, card!).result.undo.reports, [{ label: "Photo order", status: "changed", reason: INV_SAID.photosChangedSince }]);
  }
});

Deno.test("photos: an order that only partly saved can be put back, and a lost answer isn't sent again", async () => {
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }));
    x.w.fail.save_inventory_photos = { mode: "half" };
    await approve(x, card!);
    const row = rowOf(x, card!);
    assertEquals(x.writes().length, 1);
    assertEquals(row.status, "partly_applied");
    assertEquals(row.result.reports[0].reason, INV_SAID.partOrder);
    // P3 took place 0 beside P1's 0, so P1 (older) still shows first.
    assertEquals(x.order(U1), [P1, P3, P2]);
    assertEquals(row.undo.to, [P1, P3, P2]);
    delete x.w.fail.save_inventory_photos;
    await undo(x, card!);
    assertEquals(x.order(U1), [P1, P2, P3]);
    assertEquals(rowOf(x, card!).status, "undone");
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }));
    x.w.fail.save_inventory_photos = { mode: "lost" };
    await approve(x, card!);
    assertEquals(rowOf(x, card!).status, "failed");
    assertEquals(rowOf(x, card!).failure, INV_SAID.notSent);
    assertEquals(x.writes().length, 1);
  }
  {
    const x = setup();
    const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }));
    x.w.fail.save_inventory_photos = { mode: "lost_landed" };
    await approve(x, card!);
    assertEquals(rowOf(x, card!).status, "applied");
    assertEquals(x.writes().length, 1);
  }
});

Deno.test("photos undo: a lost answer keeps Undo there; an order already back sends nothing", async () => {
  const x = setup();
  const { card } = await proposed(x, change({ action: "photos", unit: x.unitRef(U1), cover: x.photoRef(U1, P3) }));
  await approve(x, card!);
  assertEquals(x.order(U1), [P3, P1, P2]);
  x.w.fail.save_inventory_photos = { mode: "lost" };
  await undo(x, card!);
  assertEquals(rowOf(x, card!).status, "applied");
  assertEquals(rowOf(x, card!).result.undo.reports, [{ label: "Photo order", status: "error", reason: INV_SAID.undoAgain }]);
  assertEquals(((await handleProposalGet(x.deps, who, { id: card!.id })).body.proposal as Any).canUndo, true);
  delete x.w.fail.save_inventory_photos;
  // Someone drags them back by hand before the next press.
  for (const [id, i] of [[P1, 0], [P2, 1], [P3, 2]] as const) x.w.photos.find((p) => p.id === id)!.sort_order = i;
  await undo(x, card!);
  assertEquals(rowOf(x, card!).status, "undone");
  assertEquals(rowOf(x, card!).result.undo, { restored: 0, removed: 0, failed: 0, reports: [] });
  assertEquals(x.writes().length, 2, "approve and the lost undo only");
});

Deno.test("look_at_inventory: the list stops at 40 and says how many more a search would find", async () => {
  const x = setup();
  for (let i = 0; i < 42; i++) x.w.units.push({ ...x.row(U2), id: crypto.randomUUID(), serial: 20000 + i, created_at: `2026-08-01T10:${String(i).padStart(2, "0")}:00Z` });
  const a = json((await runTool(x.deps, x.turn(), "look_at_inventory", { unit: "", search: "" })).content);
  assertEquals([a.count, a.buildings.length, a.more], [45, 40, 5]);
  assert(!leaksContactDetails(JSON.stringify(a.buildings)), "serials stay numbers");
});

// ── Refs ─────────────────────────────────────────────────────────────────────────────────────────

Deno.test("refs: letters only, unique, and a ref names one thing or nothing", () => {
  const refs = refsOf([U1, U2, U3], "u");
  const all = [...refs.values()];
  assertEquals(new Set(all).size, 3);
  assert(all.every((r) => /^u-[bcdfghjkmnpqrstv]{5,}$/.test(r) && !leaksContactDetails(r)));
  const items = [{ id: U1 }, { id: U2 }, { id: U3 }];
  assertEquals(byRef(items, refs.get(U2), "u")?.id, U2);
  assertEquals(byRef(items, refs.get(U2)!.replace("u-", "u"), "u")?.id, U2);
  assertEquals(byRef(items, refs.get(U2)!.toUpperCase(), "u")?.id, U2);
  assertEquals(byRef(items, "u-bcd", "u"), null);
  assertEquals(byRef(items, U2, "u"), null);
  assertEquals(byRef(items, refs.get(U2)!.replace("u-", "p-"), "u"), null);
});
