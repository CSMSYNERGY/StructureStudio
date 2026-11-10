// Insulation prices (insulation.ts). Carolyn, 11-09: "change my price of spray foam to $2.80". Fakes only:
// a portal holding the grid the way the catalog read and save_insulation do, and a store.

import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, handleProposalApprove, handleProposalUndo, type ProposalRow, runTool, type Store, toolsFor, type TurnState, type Who } from "./agent.ts";
import { INSULATION_KIND, INSULATION_REPLACED, WHERE } from "./insulation.ts";
import { GUIDES } from "./setup.ts";

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };

type Row = { ins_type: string; area: string; rate_per_sqft: number; taxable: boolean; active: boolean; internal_only: boolean };
/** The live grid on structure-studio at the call: batt 0.90/0.90/1.10, spray foam 1.50/1.50/2.50, no rigid foam. */
const LIVE = (): Row[] => [
  { ins_type: "batt", area: "floor", rate_per_sqft: 0.9, taxable: true, active: true, internal_only: false },
  { ins_type: "batt", area: "walls", rate_per_sqft: 0.9, taxable: true, active: true, internal_only: false },
  { ins_type: "batt", area: "roof", rate_per_sqft: 1.1, taxable: true, active: true, internal_only: false },
  { ins_type: "spray_foam", area: "floor", rate_per_sqft: 1.5, taxable: false, active: true, internal_only: false },
  { ins_type: "spray_foam", area: "walls", rate_per_sqft: 1.5, taxable: true, active: true, internal_only: true },
  { ins_type: "spray_foam", area: "roof", rate_per_sqft: 2.5, taxable: true, active: true, internal_only: false },
];

/** save_insulation as portal-settings runs it: a blank rate deletes the cell, anything else upserts it with
 *  taxable/active/internal-only from the row ("yes, yes, no" when a key is missing). */
function makePortal(init: { rows?: Row[]; enabled?: boolean; catalogStatus?: number; saveStatus?: number; skip?: string[] } = {}) {
  const grid = { rows: init.rows ?? LIVE(), enabled: init.enabled ?? true };
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  let saveStatus = init.saveStatus ?? 200;
  const portal: Deps["portal"] = (action, body) => {
    calls.push({ action, body: JSON.parse(JSON.stringify(body)) });
    if (action === "catalog") {
      if (init.catalogStatus) return Promise.resolve({ status: init.catalogStatus, data: null });
      return Promise.resolve({ status: 200, data: { styles: [], sizes: [], fixtures: [], insulation: grid.rows.map((r) => ({ ...r, rate_per_sqft: String(r.rate_per_sqft) })), insulationEnabled: grid.enabled } });
    }
    if (action === "save_insulation") {
      if (saveStatus !== 200) return Promise.resolve({ status: saveStatus, data: saveStatus >= 500 ? null : { error: "Refused." } });
      const skipped: string[] = [];
      // deno-lint-ignore no-explicit-any
      for (const r of (body as any).rows) {
        const k = `${r.type}/${r.area}`;
        if ((init.skip ?? []).includes(k)) { skipped.push(`${k}: refused`); continue; }
        grid.rows = grid.rows.filter((x) => !(x.ins_type === r.type && x.area === r.area));
        if (String(r.ratePerSqft) === "") continue;
        grid.rows.push({ ins_type: r.type, area: r.area, rate_per_sqft: Number(r.ratePerSqft), taxable: r.taxable !== false, active: r.active !== false, internal_only: r.internalOnly === true });
      }
      return Promise.resolve({ status: 200, data: { ok: true, saved: 1, cleared: 0, skipped } });
    }
    return Promise.resolve({ status: 200, data: { ok: true } });
  };
  return { portal, calls, grid, setSave: (s: number) => { saveStatus = s; } };
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
const propose = (deps: Deps, s: TurnState, changes: unknown[]) => runTool(deps, s, "propose_insulation_prices", { changes });
const only = (m: Map<string, ProposalRow>) => [...m.values()];

Deno.test("look_at_my_insulation reads the grid: every cell, its rate or none, and the ask-which-area note", async () => {
  const { portal } = makePortal();
  const out = JSON.parse((await runTool(makeDeps(portal, makeStore().store), turn(), "look_at_my_insulation", {})).content);
  assertEquals(out.offeredToCustomers, true);
  assertEquals(out.rates.length, 9);
  assertEquals(out.rates.filter((r: { type: string }) => r.type === "spray_foam").map((r: { area: string; perSqFt: number }) => [r.area, r.perSqFt]), [["floor", 1.5], ["walls", 1.5], ["roof", 2.5]]);
  assertEquals(out.rates.filter((r: { type: string; offered: boolean }) => r.type === "rigid_foam" && r.offered).length, 0);
  assert(/ask which areas/.test(out.note), out.note);
});

Deno.test("\"spray foam to $2.80\" on the roof: one line, from $2.50 to $2.80, on the Insulation tab", async () => {
  const { portal, calls } = makePortal();
  const { store, proposals } = makeStore();
  const out = await propose(makeDeps(portal, store), turn(), [{ type: "spray_foam", area: "roof", ratePerSqFt: 2.8 }]);
  assertEquals(out.isError ?? false, false);
  const [p] = only(proposals);
  assertEquals([p.kind, p.status, p.title], [INSULATION_KIND, "ready", "Insulation: Spray foam, roof to $2.80 a sq ft"]);
  assertEquals(p.preview.lines, [{ label: "Spray foam, roof", from: "$2.50 a sq ft", to: "$2.80 a sq ft" }]);
  assertEquals([p.preview.where, p.preview.route], [WHERE, { page: "settings", sub: "insulation" }]);
  assertEquals(p.payload.cells, [{ type: "spray_foam", area: "roof", from: 2.5, to: 2.8 }]);
  // Making the card saved nothing.
  assert(!calls.some((c) => c.action === "save_insulation"));
});

Deno.test("\"all\" is every area the type is offered on now; a type offered nowhere is all three, and the card says customers will see it", async () => {
  const { portal } = makePortal();
  const a = makeStore();
  await propose(makeDeps(portal, a.store), turn(), [{ type: "spray_foam", area: "all", ratePerSqFt: 2.8 }]);
  assertEquals(only(a.proposals)[0].payload.cells.map((c: { area: string; from: number }) => [c.area, c.from]), [["floor", 1.5], ["walls", 1.5], ["roof", 2.5]]);
  const b = makeStore();
  await propose(makeDeps(portal, b.store), turn(), [{ type: "rigid_foam", area: "all", ratePerSqFt: 2 }]);
  const card = only(b.proposals)[0];
  assertEquals(card.payload.cells.map((c: { area: string; from: null }) => [c.area, c.from]), [["floor", null], ["walls", null], ["roof", null]]);
  assert(card.preview.notes.some((n: string) => /Customers will be offered rigid foam on the floor, rigid foam on the walls, rigid foam on the roof/.test(n)), card.preview.notes.join(" | "));
  assertEquals(card.preview.lines[0].from, "");
});

Deno.test("refused in a sentence, with no card: nothing would change, a rate no insulation has, an unknown type or area, prices switched off", async () => {
  const { portal } = makePortal();
  for (const [changes, says] of [
    [[{ type: "spray_foam", area: "roof", ratePerSqFt: 2.5 }], /already set/],
    [[{ type: "spray_foam", area: "roof", ratePerSqFt: 1000 }], /looks off for insulation/],
    [[{ type: "spray_foam", area: "roof", ratePerSqFt: -1 }], /zero or more/],
    [[{ type: "foam", area: "roof", ratePerSqFt: 2 }], /batt, spray foam or rigid foam/],
    [[{ type: "batt", area: "ceiling", ratePerSqFt: 2 }], /floor, walls, roof, or all/],
    [[], /No changes/],
  ] as const) {
    const { store, proposals } = makeStore();
    const out = await propose(makeDeps(portal, store), turn(), changes as unknown as unknown[]);
    assertEquals(out.isError, true, JSON.stringify(changes));
    assert(says.test(out.content) && !/[—–]/.test(out.content), out.content);
    assertEquals(proposals.size, 0);
  }
  // The price switch off: not offered at all, and refused if called.
  const s = makeStore();
  const d = makeDeps(portal, s.store);
  assert(!toolsFor(d, turn(["prices"])).some((t) => t.name === "propose_insulation_prices"));
  assertEquals((await propose(d, turn(["prices"]), [{ type: "batt", area: "roof", ratePerSqFt: 2 }])).isError, true);
  // No Options access: neither tool is offered.
  const noAccess = makeDeps(portal, s.store, { canRead: () => false, canEdit: () => false });
  assert(!toolsFor(noAccess, turn()).some((t) => t.name.includes("insulation")));
  // After a customer's words, no insulation card.
  assert(!toolsFor(d, { ...turn(), customerWordsRead: true }).some((t) => t.name === "propose_insulation_prices"));
});

Deno.test("Approve saves only the card's cells, each with its own taxable, on/off and team-only, and never the master switch", async () => {
  const { portal, calls, grid } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), [{ type: "spray_foam", area: "all", ratePerSqFt: 2.8 }]);
  const [p] = only(proposals);
  const r = await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(r.status, 200);
  const save = calls.filter((c) => c.action === "save_insulation");
  assertEquals(save.length, 1);
  assertEquals(Object.keys(save[0].body), ["rows"]);
  assertEquals(save[0].body.rows, [
    { type: "spray_foam", area: "floor", ratePerSqft: "2.8", taxable: false, active: true, internalOnly: false },
    { type: "spray_foam", area: "walls", ratePerSqft: "2.8", taxable: true, active: true, internalOnly: true },
    { type: "spray_foam", area: "roof", ratePerSqft: "2.8", taxable: true, active: true, internalOnly: false },
  ]);
  assertEquals([p.status, p.result.saved], ["applied", 3]);
  assertEquals(grid.rows.filter((x) => x.ins_type === "spray_foam").map((x) => [x.area, x.rate_per_sqft, x.taxable, x.internal_only]).sort(), [["floor", 2.8, false, false], ["roof", 2.8, true, false], ["walls", 2.8, true, true]]);
  assertEquals(grid.rows.filter((x) => x.ins_type === "batt").map((x) => x.rate_per_sqft), [0.9, 0.9, 1.1]);
});

Deno.test("a cell that moved since the card was made: nothing is saved, and the card says to ask again", async () => {
  const { portal, calls, grid } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), [{ type: "spray_foam", area: "all", ratePerSqFt: 2.8 }]);
  grid.rows.find((x) => x.ins_type === "spray_foam" && x.area === "roof")!.rate_per_sqft = 2.6; // someone saved the tab meanwhile
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "failed");
  assert(/Spray foam, roof changed since I made this card, so I saved nothing/.test(p.failure ?? ""), p.failure ?? "");
  assert(!calls.some((c) => c.action === "save_insulation"));
});

Deno.test("Undo puts each rate back while it still reads what Jack saved, blanks a cell Jack started offering, and leaves one changed since", async () => {
  const { portal, calls, grid } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), [{ type: "spray_foam", area: "roof", ratePerSqFt: 2.8 }, { type: "spray_foam", area: "walls", ratePerSqFt: 2 }, { type: "rigid_foam", area: "walls", ratePerSqFt: 3 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "applied");
  grid.rows.find((x) => x.ins_type === "spray_foam" && x.area === "walls")!.rate_per_sqft = 2.2; // edited by hand since
  await handleProposalUndo(deps, who, { id: p.id });
  const last = calls.filter((c) => c.action === "save_insulation").at(-1)!;
  assertEquals(last.body.rows, [
    { type: "spray_foam", area: "roof", ratePerSqft: "2.5", taxable: true, active: true, internalOnly: false },
    { type: "rigid_foam", area: "walls", ratePerSqft: "", taxable: true, active: true, internalOnly: false },
  ]);
  assertEquals(grid.rows.find((x) => x.ins_type === "spray_foam" && x.area === "roof")!.rate_per_sqft, 2.5);
  assertEquals(grid.rows.some((x) => x.ins_type === "rigid_foam"), false);
  assertEquals(grid.rows.find((x) => x.ins_type === "spray_foam" && x.area === "walls")!.rate_per_sqft, 2.2);
  assertEquals(p.status, "undone");
  assert(p.result.undo.reports.some((r: { label: string; status: string }) => r.label === "Spray foam, walls" && r.status === "changed"), JSON.stringify(p.result.undo));
});

Deno.test("a lost answer on save keeps Undo, and Undo touches only cells that read what the card saved", async () => {
  const { portal, setSave, grid } = makePortal({ saveStatus: 500 });
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), [{ type: "spray_foam", area: "roof", ratePerSqFt: 2.8 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals([p.status, p.result.reports[0].status], ["partly_applied", "error"]);
  assert(/couldn't tell if that saved/.test(p.result.reports[0].reason));
  assert(p.undo && p.undo.cells.length === 1, JSON.stringify(p.undo));
  // It hadn't landed after all: Undo finds the old rate there and has nothing to do.
  setSave(200);
  await handleProposalUndo(deps, who, { id: p.id });
  assertEquals(grid.rows.find((x) => x.ins_type === "spray_foam" && x.area === "roof")!.rate_per_sqft, 2.5);
  assertEquals(p.status, "undone");
});

Deno.test("a refused cell on save is listed, and only what saved can be undone", async () => {
  const { portal } = makePortal({ skip: ["spray_foam/walls"] });
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  await propose(deps, turn(), [{ type: "spray_foam", area: "all", ratePerSqFt: 2.8 }]);
  const [p] = only(proposals);
  await handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
  assertEquals(p.status, "partly_applied");
  assertEquals(p.result.reports, [{ label: "Spray foam, walls", status: "refused", reason: "That one didn't save." }]);
  assertEquals(p.undo.cells.map((c: { area: string }) => c.area), ["floor", "roof"]);
});

Deno.test("insulation switched off for customers, or a type turned off: the card says so; the read failing makes no card", async () => {
  const off = makePortal({ enabled: false, rows: LIVE().map((r) => (r.ins_type === "batt" ? { ...r, active: false } : r)) });
  const s = makeStore();
  await propose(makeDeps(off.portal, s.store), turn(), [{ type: "batt", area: "roof", ratePerSqFt: 1.2 }]);
  const notes = only(s.proposals)[0].preview.notes.join(" | ");
  assert(/Insulation is switched off for customers right now/.test(notes) && /Batt is turned off for customers/.test(notes), notes);
  const broken = makePortal({ catalogStatus: 500 });
  const b = makeStore();
  const out = await propose(makeDeps(broken.portal, b.store), turn(), [{ type: "batt", area: "roof", ratePerSqFt: 1.2 }]);
  assertEquals([out.isError, b.proposals.size], [true, 0]);
});

Deno.test("a corrected rate is a new card, and the older insulation card in the chat is put away", async () => {
  const { portal } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  const s = turn();
  await propose(deps, s, [{ type: "spray_foam", area: "roof", ratePerSqFt: 2.8 }]);
  await propose(deps, s, [{ type: "spray_foam", area: "all", ratePerSqFt: 2.8 }]);
  const [first, second] = only(proposals);
  assertEquals([first.status, first.failure, second.status], ["cancelled", INSULATION_REPLACED, "ready"]);
});

Deno.test("a card for other cells is not a correction: \"roof to $2.80\" then \"batt walls to $1\" keeps both (11-10)", async () => {
  const { portal } = makePortal();
  const { store, proposals } = makeStore();
  const deps = makeDeps(portal, store);
  const s = turn();
  await propose(deps, s, [{ type: "spray_foam", area: "roof", ratePerSqFt: 2.8 }]);
  await propose(deps, s, [{ type: "batt", area: "walls", ratePerSqFt: 1 }]);
  assertEquals(only(proposals).map((p) => p.status), ["ready", "ready"]);
});

Deno.test("Jack is told insulation is its own tab, and point_to_step can send them there", () => {
  assertEquals([GUIDES.insulation.where, GUIDES.insulation.sub], [WHERE, "insulation"]);
  const d = makeDeps(makePortal().portal, makeStore().store);
  const tools = toolsFor(d, turn());
  const point = tools.find((t) => t.name === "point_to_step")!;
  // deno-lint-ignore no-explicit-any
  assert(((point.input_schema as any).properties.key.enum as string[]).includes("insulation"));
  assert(/insulation is not interior items/.test(point.description), point.description);
});
