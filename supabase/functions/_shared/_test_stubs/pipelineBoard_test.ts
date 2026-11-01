// The Pipeline board after Carolyn's 2026-10-12 call, tested against the SHIPPED portal source.
//
//   1. THE STATUS FILTER beside the search: "I want to see all my estimates and want to see all my
//      payments, a filter of one or many, and also a filter to exclude." ssStatusFilterKeep decides
//      which cards stay, ssStatusFilterToggle ticks and unticks, ssStatusFilterLabel is what the
//      closed control says.
//   2. NO SCROLL BAR ON THE BOARD: "This scroll bar is not going to be there. I am going to make this
//      like the designer where it can be as wide as it needs to be." Since 2026-11-01 the stages are
//      ONE row that scrolls; the retired ssBoardColumns decided how many
//      stage columns go across; the board has no scroller of its own and lifts the page's 1240px cap.
//   3. STATUSES ARE THE SYSTEM'S: "it is not even possible for them to make the changes, it is
//      system-driven ... 100%." The card pill is a label, the board never sets a status, and the
//      hint no longer says to click one.
//
// Same technique as crmCardOrder_test: slice the real block between stable anchors, guard loudly
// if they move, run it. tests/harness/pipelineBoard.mjs drives the same board in a browser.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SRC = await read("../../../../portal/02-sales.jsx");
const PAGE = await read("../../../../portal.html");

// A top-level function, from its declaration to the next one: robust to edits around it.
const fnText = (src: string, name: string) => {
  const i = src.indexOf(`\nfunction ${name}(`);
  const j = i < 0 ? -1 : src.indexOf("\nfunction ", i + 1);
  if (i < 0 || j < 0) {
    throw new Error(`pipelineBoard_test: could not find function ${name} (start=${i}, end=${j}). Re-point it rather than deleting this test.`);
  }
  return src.slice(i, j);
};
const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `pipelineBoard_test: could not find ${what} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting this test.",
    );
  }
  return src.slice(i, j);
};

const BLOCK = slice(SRC, "// ── THE BOARD'S STATUS FILTER", "function SsStatusFilter(", "the status filter + board width block");
type F = { mode: string; ids: string[] };
type Status = { id: string; name: string; color?: string };
const lifted = new Function(
  `${BLOCK}; return { SS_NO_STATUS, SS_STATUS_FILTER_OFF, ssStatusFilterKeep, ssStatusFilterToggle, ssStatusFilterLabel, SS_BOARD_COL_MIN, SS_BOARD_GAP };`,
)() as {
  SS_NO_STATUS: string;
  SS_STATUS_FILTER_OFF: F;
  ssStatusFilterKeep: (statusId: string | null, f: F | null) => boolean;
  ssStatusFilterToggle: (f: F | null, id: string) => F;
  ssStatusFilterLabel: (f: F | null, statuses: Status[]) => string;
  SS_BOARD_COL_MIN: number;
  SS_BOARD_GAP: number;
};
const { SS_NO_STATUS, SS_STATUS_FILTER_OFF, ssStatusFilterKeep, ssStatusFilterToggle, ssStatusFilterLabel, SS_BOARD_COL_MIN, SS_BOARD_GAP } = lifted;

const EST = "s-estimate", PAID = "s-paid", NEW = "s-new", ACC = "s-accepted";
const STATUSES: Status[] = [
  { id: NEW, name: "New Lead" }, { id: EST, name: "Estimate Sent" }, { id: ACC, name: "Accepted" }, { id: PAID, name: "Payment Received" },
];
const CARDS = [EST, EST, PAID, NEW, ACC, null, EST, PAID];
const keep = (f: F | null) => CARDS.filter((s) => ssStatusFilterKeep(s, f));

// ── 1. The status filter ──────────────────────────────────────────────────────────────────
Deno.test("no filter keeps every card, a null or empty filter included", () => {
  assertEquals(keep(SS_STATUS_FILTER_OFF), CARDS);
  assertEquals(keep(null), CARDS);
  assertEquals(keep({ mode: "exc", ids: [] }), CARDS);
});

Deno.test("show only: one status ('all my estimates')", () => {
  assertEquals(keep({ mode: "inc", ids: [EST] }), [EST, EST, EST]);
});

Deno.test("show only: many statuses ('all my estimates ... all my payments')", () => {
  assertEquals(keep({ mode: "inc", ids: [EST, PAID] }), [EST, EST, PAID, EST, PAID]);
});

Deno.test("hide: one or many statuses are left out, everything else stays", () => {
  assertEquals(keep({ mode: "exc", ids: [PAID] }), [EST, EST, NEW, ACC, null, EST]);
  assertEquals(keep({ mode: "exc", ids: [PAID, EST] }), [NEW, ACC, null]);
});

Deno.test("a card with no status is its own choice: hidden by 'show only', kept by 'hide', unless picked", () => {
  assert(!ssStatusFilterKeep(null, { mode: "inc", ids: [EST] }));
  assert(ssStatusFilterKeep(null, { mode: "exc", ids: [EST] }));
  assert(ssStatusFilterKeep(null, { mode: "inc", ids: [SS_NO_STATUS] }));
  assert(!ssStatusFilterKeep(null, { mode: "exc", ids: [SS_NO_STATUS] }));
  assert(!ssStatusFilterKeep(undefined as unknown as null, { mode: "exc", ids: [SS_NO_STATUS] }), "undefined is no status too");
});

Deno.test("toggle ticks and unticks, keeps the mode, and never mutates what it was given", () => {
  const a = ssStatusFilterToggle(SS_STATUS_FILTER_OFF, EST);
  assertEquals(a, { mode: "inc", ids: [EST] });
  assertEquals(SS_STATUS_FILTER_OFF, { mode: "inc", ids: [] }, "the shared 'off' value is untouched");
  const b = ssStatusFilterToggle(a, PAID);
  assertEquals(b, { mode: "inc", ids: [EST, PAID] });
  assertEquals(ssStatusFilterToggle(b, EST), { mode: "inc", ids: [PAID] });
  assertEquals(ssStatusFilterToggle({ mode: "exc", ids: [PAID] }, NEW), { mode: "exc", ids: [PAID, NEW] });
  assertEquals(ssStatusFilterToggle(null, NEW), { mode: "inc", ids: [NEW] });
});

Deno.test("switching the mode turns the same ticks from 'show only' into 'hide'", () => {
  const ticked = { mode: "inc", ids: [PAID] };
  assertEquals(keep(ticked), [PAID, PAID]);
  assertEquals(keep({ ...ticked, mode: "exc" }), [EST, EST, NEW, ACC, null, EST]);
});

Deno.test("the closed control says what is filtered, by the account's own names", () => {
  assertEquals(ssStatusFilterLabel(SS_STATUS_FILTER_OFF, STATUSES), "All statuses");
  assertEquals(ssStatusFilterLabel(null, STATUSES), "All statuses");
  assertEquals(ssStatusFilterLabel({ mode: "inc", ids: [EST] }, STATUSES), "Estimate Sent");
  assertEquals(ssStatusFilterLabel({ mode: "inc", ids: [EST, PAID] }, STATUSES), "Estimate Sent +1");
  assertEquals(ssStatusFilterLabel({ mode: "exc", ids: [PAID] }, STATUSES), "All but Payment Received");
  assertEquals(ssStatusFilterLabel({ mode: "exc", ids: [PAID, NEW, ACC] }, STATUSES), "All but Payment Received +2");
  assertEquals(ssStatusFilterLabel({ mode: "inc", ids: [SS_NO_STATUS] }, STATUSES), "No status");
  // A rename shows at once: the label reads the list it is given, not a copy.
  assertEquals(ssStatusFilterLabel({ mode: "inc", ids: [EST] }, [{ id: EST, name: "Estimate Out" }]), "Estimate Out");
});

// ── 2. The board's width ──────────────────────────────────────────────────────────────────
// ssBoardColumns and the four tests that pinned its arithmetic lived here. It decided how many
// stage columns went across before the rest WRAPPED onto another row, and Carolyn ended that on
// 2026-11-01: "IT SHOULD NEVER WRAP and have a column under all the other columns." One row that
// scrolls sideways is CSS alone — a grid of `repeat(n, minmax(MIN, 1fr))` inside an `overflow-x`
// wrapper — so there is no arithmetic left in JS to unit-test. What replaces those tests:
//   * here, that the SOURCE still spells that layout (below, with BOARD);
//   * in tests/harness/pipelineBoard.mjs, the W block, which measures a real browser at 1280,
//     1440, 1920 and phone width and asserts one row at every one of them.
// SS_BOARD_COL_MIN / SS_BOARD_GAP are still lifted: they are what the grid's minmax floor is
// written from, and the source check below reads them rather than repeating the numbers.

const BOARD = fnText(SRC, "SalesPipelines");

Deno.test("the board is ONE row that scrolls sideways, and marks itself so the page can widen", () => {
  // ⚠️ This assertion is the exact reverse of what it said until 2026-11-01, when it read
  // "the board has no scroller of its own" and quoted "this scroll bar, absolutely, hell no".
  // That was about a 230px strip scrolling INSIDE the page's 1240px cap while the page went
  // unused. The cap-lifting half of that fix is kept (data-ss-board-wide, below); the wrapping
  // half is what she reversed: "If there are more stages than fit the page, we need a scrollbar
  // at the bottom. IT SHOULD NEVER WRAP."
  assert(/overflowX:\s*"auto"/.test(BOARD), "the board must scroll sideways when its one row does not fit");
  assert(BOARD.includes("data-ss-board-wide"), "the board carries the attribute portal.html widens the page on");
  assert(new RegExp(`minmax\\(\\$\\{SS_BOARD_COL_MIN\\}px, 1fr\\)`).test(BOARD),
    "the grid's columns need a minmax floor of SS_BOARD_COL_MIN — that floor is what overflows the wrapper instead of squashing the columns");
  assert(!/repeat\(\$\{boardCols\}, minmax\(0,/.test(BOARD), "a 0 floor lets the columns squash instead of scrolling");
  assert(/const boardCols = pipe \? pipe\.stages\.length/.test(BOARD), "every stage gets a column: one row, never a wrap");
  assert(
    /\.ss-inner:has\(\[data-ss-board-wide\]\)\{max-width:none\}/.test(PAGE),
    "portal.html lifts .ss-inner's 1240px cap while the board shows",
  );
});

Deno.test("the status filter sits beside the search and filters the cards on screen", () => {
  const i = BOARD.indexOf("<SearchInput"), j = BOARD.indexOf("<SsStatusFilter"), k = BOARD.indexOf('label="Owner"');
  assert(i > 0 && j > i && k > j, `search, then status, then owner (at ${i}, ${j}, ${k})`);
  assert(/ssStatusFilterKeep\(d\.status_id/.test(BOARD), "the shown cards pass through the status filter");
});

// ── 3. Statuses are the system's ──────────────────────────────────────────────────────────
const PILL = fnText(SRC, "SsStatusPill");

Deno.test("the card's status pill is a label, never a control", () => {
  assert(!/<select|<option|onChange|onClick/.test(PILL), "SsStatusPill must not offer a way to change the status");
});

Deno.test("the board never sets a status, by hand or as a side effect of a drag", () => {
  assert(!BOARD.includes("crm_deal_set_status"), "the board calls no set-status action");
  assert(!/status_id:\s*stage\.statusId/.test(BOARD), "a drag does not paint the stage's linked status onto the card");
  assert(BOARD.includes('ssPipeCall("crm_deal_move"'), "dragging between stages still moves the card");
});

Deno.test("the hint no longer tells anyone to click a status to change it", () => {
  assert(!/click (its|a|the) status/i.test(BOARD), "no 'click its status to change it'");
  assert(BOARD.includes("Statuses are set automatically."), "the hint says where statuses come from");
});

// ── 4. The board's view outlives opening a card (C22 with C42, integration review 2026-10-13) ──
// A card opens its customer inside the Contacts tab and the board unmounts, so its search, Owner
// and Status filter used to be gone when Back brought it back. ssBoardViewOf / ssBoardViewPut keep
// each pipeline's view in memory, per signed-in person and account. tests/harness/crmRecordDeals.mjs
// (L6-L8) drives the round trip in a browser.
type View = { query: string; owner: string; showLost: boolean; status: F; key: string };
Deno.test("each pipeline's search, Owner, Status filter and Show lost are kept per person and account, and dropped once back to default", () => {
  const v = new Function("ssCurrentUserId", `${BLOCK}; return { ssBoardViewOf, ssBoardViewPut, ssBoardViewDefault, ssBoardViewIsDefault };`)("user-1") as {
    ssBoardViewOf: (clientId: string, pipelineId: string | null, user?: string, statuses?: unknown) => View;
    ssBoardViewPut: (clientId: string, pipelineId: string | null, view: Partial<View>, user?: string, statuses?: unknown) => View;
    ssBoardViewDefault: (statuses: unknown) => View;
    ssBoardViewIsDefault: (view: unknown, statuses: unknown) => boolean;
  };
  const bare = (x: View) => ({ query: x.query, owner: x.owner, showLost: x.showLost, status: x.status });
  const OFF = { query: "", owner: "all", showLost: false, status: { mode: "inc", ids: [] } };
  assertEquals(bare(v.ssBoardViewOf("acct", "p-1")), OFF, "with no status list there is nothing to hide, so the board opens unfiltered");

  // -- WHAT THE BOARD OPENS ON (migration 353, Carolyn 2026-10-26) --------------------------
  // "by default LOST and Payment received, scheduling and delivered should be hidden." Keyed on
  // each status's EVENT, never its name: a builder renames these freely.
  const LADDER = [
    { id: "t-new", name: "New Lead", triggerEvent: "design_submitted" },
    { id: "t-paid", name: "Money In", triggerEvent: "paid_in_full" },
    { id: "t-sched", name: "On The Build Board", triggerEvent: "build_scheduled" },
    { id: "t-done", name: "Dropped Off", triggerEvent: "delivered" },
  ];
  const def = v.ssBoardViewDefault(LADDER);
  assertEquals(def.showLost, false, "a lost card is not drawn until somebody asks for it");
  assertEquals(def.status, { mode: "exc", ids: ["t-paid", "t-sched", "t-done"] },
    "the three late statuses are hidden by their event, whatever the builder calls them");
  assertEquals(v.ssBoardViewDefault([{ id: "t-x", name: "New", triggerEvent: "design_submitted" }]).status,
    { mode: "inc", ids: [] }, "an account with none of those three hides nothing");
  assert(v.ssBoardViewIsDefault(def, LADDER), "the default is the default");
  assert(!v.ssBoardViewIsDefault({ ...def, showLost: true }, LADDER), "asking for lost cards is a view of its own");
  assertEquals(bare(v.ssBoardViewOf("acct", "p-9", "user-1", LADDER)), bare(def as View), "an untouched board opens on it");

  const f = { mode: "exc", ids: [EST] };
  const put = v.ssBoardViewPut("acct", "p-1", { query: "lofted", owner: "all", status: f });
  assertEquals(bare(put), { query: "lofted", owner: "all", showLost: false, status: f });
  assertEquals(bare(v.ssBoardViewOf("acct", "p-1")), { query: "lofted", owner: "all", showLost: false, status: f }, "the board comes back as it was left");
  assertEquals(put.key, v.ssBoardViewOf("acct", "p-1").key);
  // Another pipeline, another account (an operator's view-as) or another person: their own view.
  assertEquals(bare(v.ssBoardViewOf("acct", "p-2")), OFF);
  assertEquals(bare(v.ssBoardViewOf("other-acct", "p-1")), OFF);
  assertEquals(bare(v.ssBoardViewOf("acct", "p-1", "user-2")), OFF);
  assert(v.ssBoardViewOf("acct", "p-2").key !== put.key, "a view is keyed to its pipeline, so it is never applied to another");
  // An Owner alone is a view too.
  v.ssBoardViewPut("acct", "p-2", { query: "", owner: "none", status: { mode: "inc", ids: [] } });
  assertEquals(v.ssBoardViewOf("acct", "p-2").owner, "none");
  // Show lost alone is a view too, and it is kept.
  v.ssBoardViewPut("acct", "p-3", { query: "", owner: "all", showLost: true, status: { mode: "inc", ids: [] } });
  assertEquals(v.ssBoardViewOf("acct", "p-3").showLost, true);
  // Back to what the board opens on (the ×, Clear, an emptied search): nothing is kept.
  v.ssBoardViewPut("acct", "p-1", { query: "", owner: "all", status: { mode: "exc", ids: [] } });
  assertEquals(bare(v.ssBoardViewOf("acct", "p-1")), OFF);
  v.ssBoardViewPut("acct", "p-3", { query: "", owner: "all", showLost: false, status: { mode: "inc", ids: [] } });
  assertEquals(bare(v.ssBoardViewOf("acct", "p-3")), OFF);
  // And with a status list, "cleared" means the DEFAULT, not everything.
  v.ssBoardViewPut("acct", "p-9", { ...def, showLost: true }, "user-1", LADDER);
  assertEquals(v.ssBoardViewOf("acct", "p-9", "user-1", LADDER).showLost, true);
  v.ssBoardViewPut("acct", "p-9", def, "user-1", LADDER);
  assertEquals(bare(v.ssBoardViewOf("acct", "p-9", "user-1", LADDER)), bare(def as View), "it is back to the opening view, and nothing is kept");
  // No pipeline yet (the list hasn't loaded): nothing is kept under a blank one.
  v.ssBoardViewPut("acct", null, { query: "x", owner: "all", status: { mode: "inc", ids: [] } });
  assertEquals(v.ssBoardViewOf("acct", null).query, "");
});

Deno.test("the board reads its view from ssBoardViewOf and keeps every change with ssBoardViewPut", () => {
  assert(BOARD.includes("ssBoardViewOf(clientId, pipeId, ssCurrentUserId, metaStatuses)"), "the board does not open on the view it was left with");
  assert(BOARD.includes("ssBoardViewPut(clientId, pipeId,"), "a change to the search or a filter is not kept");
  assert(!/const \[(query|owner|statusFilter), set\w+\] = useState/.test(BOARD), "the search or a filter is plain component state again, lost when a card is opened");
  assert(!/sessionStorage|localStorage\.setItem\(\s*["'`]ss_board/.test(BOARD), "the view must stay in memory (a search is a customer's name)");
});

// 4. REFRESH ON THE HUB'S BOARD (2026-10-13). The board only ever draws embedded now (a Contacts hub
// tab), and its Refresh used to show only when it wasn't, so a hub pipeline tab had no way to
// reload its cards short of reloading the page. tests/harness/pipelineBoard.mjs presses it.
Deno.test("the board's Refresh shows on the hub's tabs and reloads both the pipelines and the cards", () => {
  const m = /<button[^>]*data-ss-board-refresh=""[^>]*onClick=\{\(\) => \{ loadMeta\(\); loadDeals\(\); \}\}[^>]*>↻ Refresh<\/button>/.exec(BOARD);
  assert(m, "the board has no Refresh that reloads the pipelines and the cards");
  const before = BOARD.slice(Math.max(0, m!.index - 40), m!.index);
  assert(!/!embedded && $/.test(before) && !/!hosted && $/.test(before), "Refresh is hidden on the hub's board again");
});
