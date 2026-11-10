// Option prices (options.ts): Interior items, colors and Electrical items. Carolyn, 11-09: Jack should
// handle "every option". Fakes only: a portal holding the three lists the way the catalog read returns them,
// save_layout_pricing as the Interior items tab saves, and set_color_prices / set_electrical_prices as
// compare-and-set by id. Names and ids are made up; the repo is public.

import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, handleProposalApprove, handleProposalUndo, type ProposalRow, reviseNote, runTool, type Store, toolsFor, type TurnState, type Who } from "./agent.ts";
import { OPTION_KIND, OPTION_REPLACED, priceWords } from "./options.ts";

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const RED = "00000000-0000-4000-8000-0000000c0001";
const RED_METAL = "00000000-0000-4000-8000-0000000c0002";
const BARN = "00000000-0000-4000-8000-0000000c0003";
const OUTLET = "00000000-0000-4000-8000-0000000e0001";
const LIGHT = "00000000-0000-4000-8000-0000000e0002";

// deno-lint-ignore no-explicit-any
type Any = any;
function world() {
  return {
    items: [
      { key: "workbench", label: "Workbench", archived: false, internalOnly: false, paletteGroup: "interior" },
      { key: "loft", label: "Loft", archived: false, internalOnly: true, paletteGroup: "interior" },
      { key: "shelf", label: "Single Shelf", archived: false, internalOnly: false, paletteGroup: "interior", hiddenUntilPriced: true },
      { key: "hookRack", label: "Hook rack", archived: false, internalOnly: false, paletteGroup: "interior", hiddenUntilPriced: false },
      { key: "oldBench", label: "Old bench", archived: true, internalOnly: false, paletteGroup: "interior" },
      { key: "doorRO", label: "Door rough opening", archived: false, internalOnly: false, paletteGroup: "doors" },
      { key: "partitionWall", label: "Partition Wall", archived: false, internalOnly: false, paletteGroup: "interior" },
      { key: "cupola", label: "Cupola", archived: false, internalOnly: false },
    ] as Any[],
    layoutPricing: [
      { item_key: "workbench", pricing_method: "each", rate: "250", image_url: "https://img.example/wb.png" },
      { item_key: "loft", pricing_method: "sqft_option", rate: "8", image_url: null },
      { item_key: "oldBench", pricing_method: "each", rate: "100", image_url: null },
      { item_key: "doorRO", pricing_method: "each", rate: "40", image_url: null },
      { item_key: "cupola", pricing_method: "pct_building_price", rate: "5", image_url: null },
    ] as Any[],
    colors: [
      { id: RED, label: "Red", code: "RD", siding: true, trim: true, shingle: false, metal: false, door: true, door_rate: 60, rate: 0, pricing_method: "each", active: true },
      { id: RED_METAL, label: "Red", code: "RM", siding: false, trim: false, shingle: false, metal: true, door: false, door_rate: 0, rate: 0, pricing_method: "each", active: true },
      { id: BARN, label: "Barn White", code: null, siding: true, trim: true, shingle: false, metal: false, door: false, door_rate: 0, rate: 25, pricing_method: "each", active: false },
    ] as Any[],
    electricalItems: [
      { id: OUTLET, name: "Outlet", price_with_package: 30, price_standalone: 75, active: true, internal_only: false },
      { id: LIGHT, name: "LED light", price_with_package: 45, price_standalone: null, active: true, internal_only: false },
    ] as Any[],
  };
}

function makePortal(init: { stale?: string[]; saveStatus?: number; skipItems?: string[] } = {}) {
  const w = world();
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  let saveStatus = init.saveStatus ?? 200;
  const portal: Deps["portal"] = (action, body) => {
    calls.push({ action, body: JSON.parse(JSON.stringify(body)) });
    if (action === "catalog") return Promise.resolve({ status: 200, data: { styles: [], sizes: [], fixtures: [], insulation: [], ...JSON.parse(JSON.stringify(w)) } });
    if (saveStatus !== 200) return Promise.resolve({ status: saveStatus, data: saveStatus >= 500 ? null : { error: "Refused." } });
    if (action === "save_layout_pricing") {
      const skipped: string[] = [];
      for (const r of (body as Any).rows) {
        if ((init.skipItems ?? []).includes(r.item_key)) { skipped.push(`${r.item_key}: refused`); continue; }
        const lp = w.layoutPricing.find((x) => x.item_key === r.item_key);
        if (lp) Object.assign(lp, { pricing_method: r.pricing_method, rate: String(r.rate) });
      }
      return Promise.resolve({ status: 200, data: { ok: true, saved: 1, skipped } });
    }
    if (action === "set_color_prices" || action === "set_electrical_prices") {
      const list = action === "set_color_prices" ? w.colors : w.electricalItems;
      const COL: Record<string, [string, string]> = action === "set_color_prices"
        ? { rate: ["rate", "expectRate"], doorRate: ["door_rate", "expectDoorRate"] }
        : { priceWithPackage: ["price_with_package", "expectWithPackage"], priceStandalone: ["price_standalone", "expectStandalone"] };
      const savedIds: string[] = [], notSaved: string[] = [];
      for (const r of (body as Any).rows) {
        const row = list.find((x) => x.id === r.id);
        const fields = Object.entries(COL).filter(([f]) => f in r);
        const matches = row && !(init.stale ?? []).includes(r.id) && fields.every(([, [col, ex]]) => !(ex in r) || (r[ex] === null ? row[col] === null : Number(row[col]) === Number(r[ex])));
        if (!matches) { notSaved.push(r.id); continue; }
        for (const [f, [col]] of fields) row[col] = r[f] === "" ? null : Number(r[f]);
        savedIds.push(r.id);
      }
      return Promise.resolve({ status: 200, data: { ok: true, saved: savedIds.length, savedIds, notSaved } });
    }
    return Promise.resolve({ status: 200, data: { ok: true } });
  };
  return { portal, calls, w, setSave: (s: number) => { saveStatus = s; } };
}

function makeStore() {
  const proposals = new Map<string, ProposalRow>();
  let seq = 0;
  const store = {
    settings: () => Promise.resolve({ on: true, off: [] as string[] }),
    messages: () => Promise.resolve([]),
    insertProposal: (p: Partial<ProposalRow>) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date(Date.now() + seq).toISOString(), updated_at: `u${seq}`, ...p } as ProposalRow;
      proposals.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c: string, id: string) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c: string, id: string, patch: Record<string, unknown>, when?: string[], at?: string) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, patch, { updated_at: `u${++seq}` });
      return Promise.resolve(r);
    },
    proposalsById: (_c: string, ids: string[]) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
  } as unknown as Store;
  return { store, proposals };
}

function makeDeps(portal: Deps["portal"], store: Store, over: Partial<Deps> = {}): Deps {
  return {
    env: () => undefined, store, portal,
    call(fn, action, body) { return fn === "portal-settings" ? this.portal(action, body) : Promise.resolve({ status: 404, data: null }); },
    canRead: () => true, canEdit: () => true, background: () => {}, budgetMs: () => 300_000, makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve(`h${t.length}`), log: () => Promise.resolve(), audit: () => Promise.resolve(), now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
    ...over,
  } as Deps;
}
const turn = (off: string[] = []): TurnState => ({ who, chatId: "chat1", off, proposalIds: [] });
const look = async (deps: Deps, area: string) => JSON.parse((await runTool(deps, turn(), "look_at_my_option_prices", { area })).content);
const propose = (deps: Deps, s: TurnState, area: string, changes: unknown[]) => runTool(deps, s, "propose_option_prices", { area, changes });
const only = (m: Map<string, ProposalRow>) => [...m.values()];
const WHOLE_LIST_SAVES = ["save_colors", "save_electrical_items", "save_electrical"];
const noWholeListSave = (calls: { action: string }[]) => assert(!calls.some((c) => WHOLE_LIST_SAVES.includes(c.action)), calls.map((c) => c.action).join(","));

Deno.test("prices read in words: each, a sq ft, a percent, a door", () => {
  assertEquals(priceWords(300, "each", "price"), "$300 each");
  assertEquals(priceWords(8, "sqft_option", "price"), "$8 a sq ft");
  assertEquals(priceWords(2.8, "lineal_ft", "price"), "$2.80 a lineal ft");
  assertEquals(priceWords(5, "pct_building_price", "price"), "5% of the building price");
  assertEquals(priceWords(1650, "each", "door_price"), "$1,650 a door");
});

Deno.test("look: interior lists only the Interior items tab's own rows, unpriced as null, archived and team-only marked", async () => {
  const d = makeDeps(makePortal().portal, makeStore().store);
  const out = await look(d, "interior");
  assertEquals(out.prices.map((p: Any) => [p.ref, p.now]), [["workbench", "$250 each"], ["loft", "$8 a sq ft"], ["shelf", null], ["hookRack", null], ["oldBench", "$100 each"], ["cupola", "5% of the building price"]]);
  // Unpriced, two ways (migration 171): kept off the palette until priced, or placeable and adding nothing.
  assertEquals(out.prices.find((p: Any) => p.ref === "shelf").untilPriced, "customers aren't offered it until it's priced");
  assertEquals(out.prices.find((p: Any) => p.ref === "hookRack").untilPriced, "customers can still place it, and it adds nothing to the price until it's priced");
  assertEquals(out.prices.find((p: Any) => p.ref === "workbench").untilPriced, undefined);
  assertEquals(out.prices.find((p: Any) => p.ref === "loft").teamOnly, true);
  assertEquals(out.prices.find((p: Any) => p.ref === "oldBench").archived, true);
  assert(/first price and how it's charged are set on the tab/.test(out.note), out.note);
});

Deno.test("look: colors carry their page and a door price only when offered on doors; electrical has both prices, null when not offered", async () => {
  const d = makeDeps(makePortal().portal, makeStore().store);
  const c = await look(d, "colors");
  assertEquals(c.prices.map((p: Any) => [p.ref, p.price, p.page, p.now]), [
    [RED, "price", "paint", "$0 each"], [RED, "door_price", "paint", "$60 a door"], [RED_METAL, "price", "metal", "$0 each"], [BARN, "price", "paint", "$25 each"],
  ]);
  assertEquals(c.prices.find((p: Any) => p.ref === BARN).turnedOff, true);
  const e = await look(d, "electrical");
  assertEquals(e.prices.map((p: Any) => [p.name, p.price, p.now]), [["Outlet", "with_package", "$30 each"], ["Outlet", "standalone", "$75 each"], ["LED light", "with_package", "$45 each"], ["LED light", "standalone", null]]);
  assert(/ask which/.test(e.note), e.note);
});

Deno.test("\"workbench to $300\": one line on the Interior items tab, nothing saved yet", async () => {
  const { portal, calls } = makePortal();
  const { store, proposals } = makeStore();
  const out = await propose(makeDeps(portal, store), turn(), "interior", [{ ref: "workbench", price: "price", to: 300 }]);
  assertEquals(out.isError ?? false, false, out.content);
  const [p] = only(proposals);
  assertEquals([p.kind, p.status, p.title], [OPTION_KIND, "ready", "Interior items: Workbench to $300 each"]);
  assertEquals(p.preview.lines, [{ label: "Workbench", from: "$250 each", to: "$300 each" }]);
  assertEquals([p.preview.where, p.preview.route], ["Settings > Options > Interior items", { page: "settings", sub: "interior" }]);
  assertEquals(p.payload, { area: "interior", changes: [{ ref: "workbench", price: "price", label: "Workbench", method: "each", from: 250, to: 300 }] });
  assertEquals(calls.map((c) => c.action), ["catalog"]);
});

Deno.test("Approve on interior sends the tab's own save with only key, method and rate, so the image and sizes stay; Undo puts it back", async () => {
  const { portal, calls, w } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "interior", [{ ref: "workbench", price: "price", to: 300 }, { ref: "loft", price: "price", to: 9.5 }]);
  const [p] = only(proposals);
  assertEquals((await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash })).status, 200);
  const save = calls.filter((c) => c.action === "save_layout_pricing");
  assertEquals(save.map((c) => c.body), [{ rows: [{ item_key: "workbench", pricing_method: "each", rate: 300 }, { item_key: "loft", pricing_method: "sqft_option", rate: 9.5 }] }]);
  assertEquals([p.status, p.result.saved], ["applied", 2]);
  assertEquals(w.layoutPricing.find((x) => x.item_key === "workbench").image_url, "https://img.example/wb.png");
  assertEquals((await handleProposalUndo(deps, who, { id: p.id })).status, 200);
  assertEquals(w.layoutPricing.filter((x) => ["workbench", "loft"].includes(x.item_key)).map((x) => Number(x.rate)), [250, 8]);
  noWholeListSave(calls);
});

Deno.test("colors: a paint color's price and its door price go by id with what each is now; never the whole-list save", async () => {
  const { portal, calls, w } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "colors", [{ ref: RED, price: "price", to: 50 }, { ref: RED, price: "door_price", to: 75 }]);
  const [p] = only(proposals);
  assertEquals(p.preview.lines, [{ label: "Red (paint color)", from: "$0 each", to: "$50 each" }, { label: "Red, on a door", from: "$60 a door", to: "$75 a door" }]);
  assertEquals([p.preview.where, p.preview.route.sub], ["Settings > Colors > Paint", "colors"]);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(calls.filter((c) => c.action === "set_color_prices").map((c) => c.body), [{ rows: [{ id: RED, rate: 50, expectRate: 0, doorRate: 75, expectDoorRate: 60 }] }]);
  assertEquals([w.colors[0].rate, w.colors[0].door_rate, p.status], [50, 75, "applied"]);
  await handleProposalUndo(deps, who, { id: p.id });
  assertEquals(calls.filter((c) => c.action === "set_color_prices")[1].body, { rows: [{ id: RED, rate: 0, expectRate: 50, doorRate: 60, expectDoorRate: 75 }] });
  assertEquals([w.colors[0].rate, w.colors[0].door_rate], [0, 60]);
  noWholeListSave(calls);
});

Deno.test("a metal color's card is on the Metal page, and a color on two pages is told apart on the card", async () => {
  const { portal } = makePortal();
  const { store, proposals } = makeStore();
  await propose(makeDeps(portal, store), turn(), "colors", [{ ref: RED_METAL, price: "price", to: 40 }]);
  const [p] = only(proposals);
  assertEquals([p.title, p.preview.where, p.preview.route.sub], ["Colors: Red (metal color) to $40 each", "Settings > Colors > Metal", "metal"]);
});

Deno.test("electrical: pricing an item on its own that isn't offered that way says customers will be offered it; Undo blanks it again", async () => {
  const { portal, calls, w } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "electrical", [{ ref: LIGHT, price: "standalone", to: 95 }]);
  const [p] = only(proposals);
  assertEquals(p.preview.lines, [{ label: "LED light, on its own", from: "", to: "$95 each" }]);
  assert(p.preview.notes.some((n: string) => /Customers will be offered LED light, on its own/.test(n)), p.preview.notes.join(" | "));
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(calls.filter((c) => c.action === "set_electrical_prices").map((c) => c.body), [{ rows: [{ id: LIGHT, priceStandalone: 95, expectStandalone: null }] }]);
  await handleProposalUndo(deps, who, { id: p.id });
  assertEquals(calls.filter((c) => c.action === "set_electrical_prices")[1].body, { rows: [{ id: LIGHT, priceStandalone: "", expectStandalone: 95 }] });
  assertEquals(w.electricalItems[1].price_standalone, null);
  noWholeListSave(calls);
});

Deno.test("refused in a sentence, with no card", async () => {
  const { portal } = makePortal();
  for (const [area, changes, says] of [
    ["interior", [{ ref: "shelf", price: "price", to: 20 }], /no price yet: customers aren't offered it until it's priced/],
    ["interior", [{ ref: "hookRack", price: "price", to: 20 }], /no price yet: customers can still place it, and it adds nothing/],
    ["interior", [{ ref: "oldBench", price: "price", to: 20 }], /archived/],
    ["interior", [{ ref: "doorRO", price: "price", to: 20 }], /don't have that one/],
    ["interior", [{ ref: "partitionWall", price: "price", to: 20 }], /don't have that one/],
    ["interior", [{ ref: "workbench", price: "door_price", to: 20 }], /price is price/],
    ["interior", [{ ref: "workbench", price: "price", to: 250 }], /already set/],
    ["interior", [{ ref: "workbench", price: "price", to: -5 }], /zero or more/],
    ["interior", [{ ref: "workbench", price: "price", to: 100000 }], /looks off/],
    ["interior", [{ ref: "cupola", price: "price", to: 120 }], /100 or less/],
    ["colors", [{ ref: RED_METAL, price: "door_price", to: 20 }], /isn't offered on doors/],
    ["electrical", [{ ref: OUTLET, price: "price", to: 20 }], /with_package or standalone/],
    ["fence", [{ ref: OUTLET, price: "price", to: 20 }], /interior, colors or electrical/],
    ["colors", [], /No changes/],
  ] as const) {
    const { store, proposals } = makeStore();
    const out = await propose(makeDeps(portal, store), turn(), area, changes as unknown as unknown[]);
    assertEquals(out.isError, true, `${area} ${JSON.stringify(changes)}`);
    assert(says.test(out.content), `${JSON.stringify(changes)}: ${out.content}`);
    assertEquals(proposals.size, 0);
  }
});

Deno.test("turned off and team-only say so on the card", async () => {
  const { portal } = makePortal();
  const a = makeStore();
  await propose(makeDeps(portal, a.store), turn(), "colors", [{ ref: BARN, price: "price", to: 30 }]);
  assert(only(a.proposals)[0].preview.notes.some((n: string) => /Barn White is turned off/.test(n)));
  const b = makeStore();
  await propose(makeDeps(portal, b.store), turn(), "interior", [{ ref: "loft", price: "price", to: 9 }]);
  assert(only(b.proposals)[0].preview.notes.some((n: string) => /Loft is for your team only/.test(n)));
});

Deno.test("a price that moved since the card was made: nothing is saved, and the card says to ask again", async () => {
  const { portal, calls, w } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "electrical", [{ ref: OUTLET, price: "standalone", to: 80 }, { ref: OUTLET, price: "with_package", to: 35 }]);
  w.electricalItems[0].price_standalone = 70; // changed on the page
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "failed");
  assert(/Outlet, on its own changed since I made this card, so I saved nothing/.test(String(p.failure)), String(p.failure));
  assert(!calls.some((c) => c.action === "set_electrical_prices"));
});

Deno.test("an interior row the server refuses is a refusal in its own words, not a race; the rest save and can be undone", async () => {
  const { portal, w } = makePortal({ skipItems: ["loft"] });
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "interior", [{ ref: "workbench", price: "price", to: 300 }, { ref: "loft", price: "price", to: 9 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "partly_applied");
  assertEquals(p.result.reports.map((r: Any) => [r.label, r.status, r.reason]), [["Loft", "refused", "That one didn't save (refused). Check it on Settings > Options > Interior items."]]);
  assertEquals(p.undo.changes.map((c: Any) => c.ref), ["workbench"]);
  assertEquals(w.layoutPricing.find((x) => x.item_key === "workbench").rate, "300");
});

Deno.test("a price changed in the moment before the save (compare and set): that one is left and named, the rest save and can be undone", async () => {
  const { portal, w } = makePortal({ stale: [OUTLET] });
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "electrical", [{ ref: OUTLET, price: "standalone", to: 80 }, { ref: LIGHT, price: "with_package", to: 50 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "partly_applied");
  assertEquals(p.result.reports.map((r: Any) => [r.label, r.status]), [["Outlet, on its own", "changed"]]);
  assertEquals(p.undo.changes.map((c: Any) => c.ref), [LIGHT]);
  assertEquals([w.electricalItems[0].price_standalone, w.electricalItems[1].price_with_package], [75, 50]);
});

Deno.test("a lost answer keeps Undo, and Undo touches only prices that read what the card saved", async () => {
  const { portal, calls, setSave, w } = makePortal({ saveStatus: 502 });
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "colors", [{ ref: RED, price: "price", to: 50 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "partly_applied");
  assert(p.undo && p.undo.changes.length === 1);
  setSave(200);
  // It didn't save after all: Undo finds the price where it was and has nothing to do.
  await handleProposalUndo(deps, who, { id: p.id });
  assertEquals(calls.filter((c) => c.action === "set_color_prices").length, 1);
  assertEquals(w.colors[0].rate, 0);
});

Deno.test("Undo leaves a price changed on the page since, and says so", async () => {
  const { portal, w } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), "interior", [{ ref: "workbench", price: "price", to: 300 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  w.layoutPricing[0].rate = "320";
  const r = await handleProposalUndo(deps, who, { id: p.id });
  assertEquals(w.layoutPricing[0].rate, "320");
  assert(/changed since I saved it/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
});

Deno.test("a correction for the same price replaces the waiting card; a card for a different price stays", async () => {
  const { portal } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  const s = turn();
  await propose(deps, s, "interior", [{ ref: "workbench", price: "price", to: 300 }]);
  await propose(deps, s, "interior", [{ ref: "loft", price: "price", to: 9 }]);
  await propose(deps, s, "interior", [{ ref: "workbench", price: "price", to: 320 }]);
  const [first, second, third] = only(proposals);
  assertEquals([first.status, first.failure], ["cancelled", OPTION_REPLACED]);
  assertEquals([second.status, third.status], ["ready", "ready"]);
  // A color's door price is a different price from its own.
  await propose(deps, s, "colors", [{ ref: RED, price: "price", to: 50 }]);
  await propose(deps, s, "colors", [{ ref: RED, price: "door_price", to: 70 }]);
  const [, , , c1, c2] = only(proposals);
  assertEquals([c1.status, c2.status], ["ready", "ready"]);
});

Deno.test("Revise on an option card tells Claude each price's ref and key, not just the name", async () => {
  const { portal } = makePortal();
  const { store, proposals } = makeStore();
  await propose(makeDeps(portal, store), turn(), "colors", [{ ref: RED_METAL, price: "price", to: 40 }]);
  const note = reviseNote(only(proposals)[0]);
  assert(note.includes(`ref ${RED_METAL}, price price`) && /area colors/.test(note) && /from 0 to 40/.test(note), note);
});

Deno.test("the writer is strict and offered with settings edit and the prices switch; the read isn't strict", () => {
  const d = makeDeps(makePortal().portal, makeStore().store);
  const tools = toolsFor(d, turn());
  assertEquals(tools.find((t) => t.name === "propose_option_prices")?.strict, true);
  assert(tools.some((t) => t.name === "look_at_my_option_prices" && t.strict !== true));
  assert(!toolsFor(d, turn(["prices"])).some((t) => t.name === "propose_option_prices"));
  const viewOnly = makeDeps(makePortal().portal, makeStore().store, { canEdit: () => false });
  assert(!toolsFor(viewOnly, turn()).some((t) => t.name === "propose_option_prices"));
  assert(toolsFor(viewOnly, turn()).some((t) => t.name === "look_at_my_option_prices"));
});
