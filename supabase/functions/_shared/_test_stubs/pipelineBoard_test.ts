// The Pipeline board after Carolyn's 2026-10-12 call, tested against the SHIPPED portal source.
//
//   1. THE STATUS FILTER beside the search: "I want to see all my estimates and want to see all my
//      payments, a filter of one or many, and also a filter to exclude." ssStatusFilterKeep decides
//      which cards stay, ssStatusFilterToggle ticks and unticks, ssStatusFilterLabel is what the
//      closed control says.
//   2. NO SCROLL BAR ON THE BOARD: "This scroll bar is not going to be there. I am going to make this
//      like the designer where it can be as wide as it needs to be." ssBoardColumns decides how many
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
  `${BLOCK}; return { SS_NO_STATUS, SS_STATUS_FILTER_OFF, ssStatusFilterKeep, ssStatusFilterToggle, ssStatusFilterLabel, ssBoardColumns, SS_BOARD_COL_MIN, SS_BOARD_GAP };`,
)() as {
  SS_NO_STATUS: string;
  SS_STATUS_FILTER_OFF: F;
  ssStatusFilterKeep: (statusId: string | null, f: F | null) => boolean;
  ssStatusFilterToggle: (f: F | null, id: string) => F;
  ssStatusFilterLabel: (f: F | null, statuses: Status[]) => string;
  ssBoardColumns: (stages: number, width: number, min?: number, gap?: number) => number;
  SS_BOARD_COL_MIN: number;
  SS_BOARD_GAP: number;
};
const { SS_NO_STATUS, SS_STATUS_FILTER_OFF, ssStatusFilterKeep, ssStatusFilterToggle, ssStatusFilterLabel, ssBoardColumns, SS_BOARD_COL_MIN, SS_BOARD_GAP } = lifted;

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
// Widths are the board's own: viewport − 240 sidebar − 48 page padding − 42 card padding/border,
// less a 15px scroll bar when the page is long.
const BOARD_AT = { 1280: 950 - 15, 1440: 1110 - 15, 1920: 1590 - 15 } as const;

Deno.test("every stage in one row whenever they fit at the minimum column width", () => {
  assertEquals(ssBoardColumns(6, BOARD_AT[1280]), 6, "Shed Deals' six stages fit at 1280");
  assertEquals(ssBoardColumns(8, BOARD_AT[1920]), 8, "eight stages fit at 1920");
  assertEquals(ssBoardColumns(7, BOARD_AT[1440]), 7);
  assertEquals(ssBoardColumns(3, 400), 2, "three stages at 400px: two across");
  assertEquals(ssBoardColumns(3, 3000), 3);
});

Deno.test("when they don't fit, as many go across as fit and the rest wrap below", () => {
  assertEquals(ssBoardColumns(8, BOARD_AT[1440]), 7, "8 at 1440 → 7 + 1");
  assertEquals(ssBoardColumns(8, BOARD_AT[1280]), 6, "8 at 1280 → 6 + 2");
  assertEquals(ssBoardColumns(7, BOARD_AT[1280]), 6, "7 at 1280 → 6 + 1");
  assertEquals(ssBoardColumns(9, 3 * SS_BOARD_COL_MIN + 2 * SS_BOARD_GAP), 3, "9 at three-wide → 3 + 3 + 3");
  assertEquals(ssBoardColumns(8, 2 * SS_BOARD_COL_MIN + SS_BOARD_GAP), 2);
  assertEquals(ssBoardColumns(8, 90), 1, "narrower than one column: one column, never zero");
});

Deno.test("exactly as many columns as fit (never more, never fewer), and never more than stages", () => {
  for (let n = 1; n <= 14; n++) {
    for (let w = 100; w <= 2600; w += 37) {
      const cols = ssBoardColumns(n, w);
      const fit = Math.max(1, Math.floor((w + SS_BOARD_GAP) / (SS_BOARD_COL_MIN + SS_BOARD_GAP)));
      assertEquals(cols, Math.min(n, fit), `n=${n} w=${w}`);
      // And the columns that come out are never under the minimum (unless one column is all there is).
      const colW = (w - (cols - 1) * SS_BOARD_GAP) / cols;
      assert(cols === 1 || colW >= SS_BOARD_COL_MIN, `n=${n} w=${w}: ${cols} columns of ${colW}px`);
    }
  }
});

Deno.test("before the board is measured, every stage goes in one row", () => {
  assertEquals(ssBoardColumns(8, 0), 8);
  assertEquals(ssBoardColumns(8, NaN), 8);
  assertEquals(ssBoardColumns(0, 900), 1, "a pipeline with no stages still gets one column");
});

const BOARD = fnText(SRC, "SalesPipelines");

Deno.test("the board has no scroller of its own and marks itself so the page can widen", () => {
  assert(!/overflow[XY]?:\s*"(auto|scroll)"/.test(BOARD), "SalesPipelines must not scroll inside itself (Carolyn: 'this scroll bar, absolutely, hell no')");
  assert(!/minWidth:\s*"min-content"/.test(BOARD), "a min-content strip is what forced the sideways scroll");
  assert(BOARD.includes("data-ss-board-wide"), "the board carries the attribute portal.html widens the page on");
  assert(BOARD.includes("ssBoardColumns("), "the board sizes its columns with ssBoardColumns");
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
