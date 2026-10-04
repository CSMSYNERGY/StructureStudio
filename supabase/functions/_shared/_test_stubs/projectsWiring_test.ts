// portal-projects board writes, pinned against the SHIPPED handler (2026-10-04).
//
// An overlay board (pm_boards.settings.overlay_from) renders rows that live on OTHER boards,
// every row is draggable, and the browser sends the group of the row it was dropped on. Any
// write that takes a group id from the browser must therefore check that the group is on the
// ITEM's board, or a drag rewrites a Bugs card into a group on a board it does not live on.
// move_items does it with a board_id filter; reorder_item did not, until 2026-10-04.
// Same technique as quoteWriteRaceWiring_test: read the source, so a drift fails the push.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const PROJECTS = code(await Deno.readTextFile(new URL("portal-projects/index.ts", FUNCTIONS)));

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`projectsWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const REORDER = block(PROJECTS, 'case "reorder_item": {', 'case "archive_items": {', "reorder_item");
const MOVE = block(PROJECTS, 'case "move_items": {', 'case "reorder_item": {', "move_items");

Deno.test("reorder_item refuses a group on another board BEFORE it reads or writes anything", () => {
  const check = REORDER.search(/dest\.board_id !== item\.board_id/);
  assert(check >= 0, "reorder_item no longer compares the destination group's board with the item's board");
  const firstRead = REORDER.indexOf('.from("pm_items")');
  const firstWrite = REORDER.indexOf(".update(");
  assert(firstRead > check, "reorder_item reads the destination group's rows before checking the group is on the item's board");
  assert(firstWrite > check, "reorder_item writes before checking the group is on the item's board");
  assert(/return json\(\{ error:[^}]*\}, 400\)/.test(REORDER.slice(check, firstRead)),
    "a cross-board reorder must be a 400 refusal, not a silent no-op or a 500");
});

Deno.test("move_items still never moves across boards", () => {
  assert(/\.eq\("board_id", dest\.board_id\)/.test(MOVE), "move_items lost its board_id filter");
});
