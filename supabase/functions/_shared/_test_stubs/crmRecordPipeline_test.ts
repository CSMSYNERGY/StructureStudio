// The contact record's Deals card and its top bar, tested against the SHIPPED portal source and
// the shipped crm_record branch (Carolyn's 2026-10-12 call).
//
//   * ONE Deals section: "I'm still confused about this deals and sales pipeline ... So this also
//     has to be merged." Each design is joined to its pipeline card; a card with no design is a
//     row of its own (crmDealRows).
//   * The top bar names the deal's pipeline and draws that pipeline's own stages: "I want this
//     up here to say shed deals with the stage that it's in." Picking a deal in another pipeline
//     switches it (crmPipeBarRow).
//   * The stage drop-down lists the deal's own pipeline only, and a move to another pipeline
//     lands in that pipeline's first open stage (crmPipeFirstOpen, crmPipeMoveTargets,
//     crmPipeMoved). A deal is in one pipeline: "these cards can only be in one pipeline."
//   * The status is shown and never set on the record: "the statuses are system-driven, 100%."
//
// Same technique as crmCardOrder_test: slice the real block between stable anchors, guard
// loudly if they move, run it. Fixtures are made up (example ids, no tenant).

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../../../portal/02-sales.jsx");
const SETTINGS = await read("../../portal-settings/index.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `crmRecordPipeline_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
};

const BLOCK = slice(SRC, "const crmPipeDealFor =", "// A read-only status pill.", "the pipeline helpers");
type Fn = (...a: any[]) => any;
const H = new Function(
  `${BLOCK}; return { crmPipeDealFor, crmPipeOf, crmPipeStatus, crmPipeFirstOpen, crmPipeMoveTargets, crmDealRows, crmPipeBarRow, crmPipeMoved };`,
)() as Record<string, Fn>;

// Two pipelines and a retired one's card. Stage kinds as migration 301 defines them.
const SHED = {
  id: "p-shed", name: "Shed Deals", lostReasons: ["Price"],
  stages: [
    { id: "s-new", name: "New Incoming", color: "#64748B", kind: "open" },
    { id: "s-try", name: "Attempting Contact", color: "#0EA5E9", kind: "open" },
    { id: "s-warm", name: "Nurturing - Warm", color: "#F59E0B", kind: "open" },
    { id: "s-cold", name: "Gone Cold Again", color: "#94A3B8", kind: "open" },
  ],
};
const SOLD = {
  id: "p-sold", name: "Sold", lostReasons: [],
  stages: [
    { id: "s-lost", name: "Fell through", color: "#DC2626", kind: "lost" },
    { id: "s-won", name: "Signed", color: "#16A34A", kind: "won" },
    { id: "s-build", name: "Building", color: "#6366F1", kind: "open" },
  ],
};
const ONLY_LOST = { id: "p-x", name: "Closed out", lostReasons: [], stages: [{ id: "s-x", name: "Lost", color: "#DC2626", kind: "lost" }] };
const STATUSES = [
  { id: "t-new", name: "New Lead", color: "#64748B" },
  { id: "t-sent", name: "Estimate Sent", color: "#0EA5E9" },
];
const DESIGNS = [
  { short_code: "SS-AAAA0001", created_at: "2026-09-20T10:00:00Z" },
  { short_code: "SS-AAAA0002", created_at: "2026-08-25T10:00:00Z" },
  { short_code: "SS-AAAA0003", created_at: "2026-07-01T10:00:00Z" }, // no card (an old design)
];
const DEALS = [
  { id: "d-1", pipeline_id: "p-shed", stage_id: "s-warm", status_id: "t-sent", short_code: "SS-AAAA0001", created_at: "2026-09-20T10:00:01Z" },
  { id: "d-2", pipeline_id: "p-sold", stage_id: "s-build", status_id: "t-new", short_code: "SS-AAAA0002", created_at: "2026-08-25T10:00:01Z" },
  // A lead with no design, added straight to a pipeline.
  { id: "d-3", pipeline_id: "p-shed", stage_id: "s-try", status_id: "t-new", short_code: null, title: "Phone lead", created_at: "2026-09-01T09:00:00Z" },
  // A card left in a pipeline that has since been retired (not in the live list).
  { id: "d-4", pipeline_id: "p-retired", stage_id: "s-gone", status_id: null, short_code: null, title: null, created_at: "2026-06-01T09:00:00Z" },
];
const PIPE = { pipelines: [SHED, SOLD, ONLY_LOST], statuses: STATUSES, deals: DEALS };

Deno.test("one Deals list: each design with its card, each card with no design on its own row, newest first", () => {
  const rows = H.crmDealRows(DESIGNS, PIPE);
  assertEquals(rows.map((r: any) => r.key), ["SS-AAAA0001", "d-3", "SS-AAAA0002", "SS-AAAA0003", "d-4"]);
  assertEquals(rows[0].deal.id, "d-1", "a design row carries its own card");
  assertEquals(rows[2].deal.id, "d-2");
  assertEquals(rows[3].deal, null, "a design with no card keeps its row, with no card");
  assertEquals(rows[1].design, null, "a lead is a row with no design");
  // Every card is drawn exactly once: none twice, none missing.
  const drawn = rows.map((r: any) => r.deal && r.deal.id).filter(Boolean);
  assertEquals(drawn.sort(), ["d-1", "d-2", "d-3", "d-4"]);
});

Deno.test("without a pipeline block the Deals list is the designs list it always was", () => {
  for (const pipe of [undefined, null]) {
    const rows = H.crmDealRows(DESIGNS, pipe);
    assertEquals(rows.map((r: any) => r.key), DESIGNS.map((d) => d.short_code));
    assert(rows.every((r: any) => r.deal === null));
  }
  assertEquals(H.crmDealRows(undefined, undefined), []);
});

Deno.test("a card whose design isn't this person's any more is still drawn, as its own row", () => {
  const stray = { id: "d-9", pipeline_id: "p-shed", stage_id: "s-new", short_code: "SS-ELSEWHERE", created_at: "2026-09-30T00:00:00Z" };
  const rows = H.crmDealRows(DESIGNS, { ...PIPE, deals: [stray] });
  assertEquals(rows[0].key, "d-9");
  assertEquals(rows[0].design, null);
});

Deno.test("the top bar names the deal's pipeline and draws that pipeline's stages, the current one lit", () => {
  const shed = H.crmPipeBarRow(PIPE, DEALS[0]);
  assertEquals(shed.label, "Shed Deals");
  assertEquals(shed.stages.map((s: any) => s.name), ["New Incoming", "Attempting Contact", "Nurturing - Warm", "Gone Cold Again"]);
  assertEquals(shed.idx, 2);
  assertEquals(shed.only, true, "only the stage it is in lights up, not a trail of 'reached' stages");
  // Picking the deal in another pipeline switches the bar to that pipeline.
  const sold = H.crmPipeBarRow(PIPE, DEALS[1]);
  assertEquals(sold.label, "Sold");
  assertEquals(sold.stages.map((s: any) => s.name), ["Fell through", "Signed", "Building"]);
  assertEquals(sold.idx, 2);
  // Never the old hard-coded ladder.
  for (const r of [shed, sold]) assert(!r.stages.some((s: any) => /Qualified|Proposal Made|Contract Signed/.test(s.name)));
});

Deno.test("no bar row with nothing picked, for a retired pipeline, or without a pipeline block", () => {
  assertEquals(H.crmPipeBarRow(PIPE, null), null);
  assertEquals(H.crmPipeBarRow(PIPE, DEALS[3]), null);
  assertEquals(H.crmPipeBarRow(undefined, DEALS[0]), null);
  // A stage removed since: the pipeline still shows, with nothing lit.
  assertEquals(H.crmPipeBarRow(PIPE, { ...DEALS[0], stage_id: "s-gone" }).idx, null);
});

Deno.test("the design record finds its card by short code", () => {
  assertEquals(H.crmPipeDealFor(PIPE, "SS-AAAA0002").id, "d-2");
  assertEquals(H.crmPipeDealFor(PIPE, "SS-AAAA0003"), null);
  assertEquals(H.crmPipeDealFor(PIPE, null), null);
  assertEquals(H.crmPipeDealFor(undefined, "SS-AAAA0001"), null);
});

Deno.test("the status shown on a row is the card's own, looked up by id", () => {
  assertEquals(H.crmPipeStatus(PIPE, DEALS[0]).name, "Estimate Sent");
  assertEquals(H.crmPipeStatus(PIPE, DEALS[3]), null);
  assertEquals(H.crmPipeStatus(PIPE, { ...DEALS[0], status_id: "t-archived" }), null);
  assertEquals(H.crmPipeStatus(PIPE, null), null);
});

Deno.test("a move to another pipeline lands in its first OPEN stage, never a lost one", () => {
  assertEquals(H.crmPipeFirstOpen(SHED).id, "s-new");
  assertEquals(H.crmPipeFirstOpen(SOLD).id, "s-build", "skips a lost and a won stage ahead of the first open one");
  assertEquals(H.crmPipeFirstOpen({ stages: [{ id: "a", kind: "lost" }, { id: "b", kind: "won" }] }).id, "b");
  assertEquals(H.crmPipeFirstOpen(ONLY_LOST), null);
  assertEquals(H.crmPipeFirstOpen(null), null);
});

Deno.test("the move list is every other live pipeline a deal can land in", () => {
  assertEquals(H.crmPipeMoveTargets(PIPE, DEALS[0]).map((p: any) => p.id), ["p-sold"]);
  assertEquals(H.crmPipeMoveTargets(PIPE, DEALS[1]).map((p: any) => p.id), ["p-shed"]);
  // A card in a retired pipeline can be rescued into any of them.
  assertEquals(H.crmPipeMoveTargets(PIPE, DEALS[3]).map((p: any) => p.id), ["p-shed", "p-sold"]);
  assertEquals(H.crmPipeMoveTargets(undefined, DEALS[0]), []);
});

Deno.test("a move is painted in the stage's pipeline (one pipeline per deal), the status untouched", () => {
  const target = SOLD.stages[2];
  const after = H.crmPipeMoved(PIPE, "d-1", target);
  const moved = after.deals.find((d: any) => d.id === "d-1");
  assertEquals(moved.pipeline_id, "p-sold");
  assertEquals(moved.stage_id, "s-build");
  assertEquals(moved.status_id, "t-sent", "a status is the system's; a move never paints one");
  assertEquals(after.deals.filter((d: any) => d.id !== "d-1"), PIPE.deals.filter((d) => d.id !== "d-1"));
  assertEquals(PIPE.deals[0].pipeline_id, "p-shed", "the block it was given is not mutated");
  // The bar follows it.
  assertEquals(H.crmPipeBarRow(after, moved).label, "Sold");
  // A lost stage keeps the reason; any other clears it.
  const lost = H.crmPipeMoved(PIPE, "d-2", SOLD.stages[0], "Price").deals.find((d: any) => d.id === "d-2");
  assertEquals(lost.lost_reason, "Price");
  const back = H.crmPipeMoved({ ...PIPE, deals: [lost] }, "d-2", SOLD.stages[2]).deals[0];
  assertEquals(back.lost_reason, null);
});

// ── WIRING: the record shows a status and never sets one, and the two cards are one ──────────
const RECORD = slice(SRC, "function CrmRecord(", "\nfunction ", "CrmRecord");
const SECTIONS = slice(SRC, "const CRM_SECTIONS = [", "];", "CRM_SECTIONS");

Deno.test("the record never sets a status, and moves through the board's own action", () => {
  assert(!RECORD.includes("crm_deal_set_status"), "the record must not set a status (C40)");
  assert(!RECORD.includes("SsStatusPill"), "the board's status control is not used on the record");
  assert(RECORD.includes('ssPipeCall("crm_deal_move"'), "stage and pipeline moves go through crm_deal_move");
  assertEquals(RECORD.split("<CrmDealStatusPill").length - 1, 1, "the status pill is drawn in ONE place on the record");
});

Deno.test("one Deals card: the Sales pipelines card and its component are gone", () => {
  assert(!/key:\s*"salesPipelines"/.test(SECTIONS), "CRM_SECTIONS still lists salesPipelines");
  assert(!SRC.includes("function SsContactDeals("), "SsContactDeals should be merged into the Deals card");
  assert(!RECORD.includes('key === "salesPipelines"'));
});

Deno.test("crm_record sends the pipeline block only to a contact reader, read only", () => {
  const branch = slice(SETTINGS, 'if (action === "crm_record") {', 'if (action === "crm_feed") {', "the crm_record branch");
  assert(branch.includes("if (!mayReadContacts) return undefined;"), "the pipeline read must follow the contact gate");
  assert(/return json\(\{[^}]*\bpipeline\b[^}]*\}\);/.test(branch), "crm_record must return `pipeline`");
  assert(!branch.includes("crm_ensure_pipelines"), "opening a record must not seed pipelines");
  for (const t of ["crm_deals", "crm_pipelines", "crm_pipeline_stages", "crm_statuses"]) {
    assert(branch.includes(`admin.from("${t}")`), `crm_record should read ${t}`);
  }
  // Every one of them archived-aware, so a retired pipeline (Quotes) offers no stages.
  assertEquals((branch.match(/\.is\("archived_at", null\)/g) ?? []).length >= 4, true);
});
