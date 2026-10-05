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

// A cross-app report (app-feedback, migration 161) has client_id NULL, so no tenant can ever
// read a comment on it. Both publishing paths must refuse BEFORE writing the feedback_comments
// copy, or the drawer reports VISIBLE TO CLIENT for a note nobody will see.
const ADD = block(PROJECTS, 'case "add_update": {', 'case "publish_update": {', "add_update");
const PUBLISH = block(PROJECTS, 'case "publish_update": {', 'case "edit_update": {', "publish_update");
const AUDIENCE = block(PROJECTS, "const noAudienceRefusal = async", "\n  };\n", "noAudienceRefusal");

Deno.test("publishing to a submission with no tenant is refused before the client copy is written", () => {
  assert(/\.select\("client_id, source_app"\)/.test(AUDIENCE) && /if \(sub && sub\.client_id\) return null;/.test(AUDIENCE),
    "noAudienceRefusal no longer lets through only a submission that has a client_id");
  for (const [label, src] of [["add_update", ADD], ["publish_update", PUBLISH]] as const) {
    const check = src.indexOf("noAudienceRefusal(item.feedback_submission_id)");
    const copy = src.indexOf('.from("feedback_comments").insert(');
    assert(check >= 0, `${label} no longer asks noAudienceRefusal`);
    assert(copy > check, `${label} writes the client copy before checking anyone can read it`);
  }
});

// setup_overview reads EVERY builder's every step — a whole-set read past PostgREST's 1000-row
// cap, which truncates silently. It must page, deterministically ordered, until an empty page.
const OVERVIEW = block(PROJECTS, 'case "setup_overview": {', 'case "setup_client_items": {', "setup_overview");

Deno.test("setup_overview pages tenant_setup_items instead of trusting one capped read", () => {
  const read = OVERVIEW.slice(OVERVIEW.indexOf('.from("tenant_setup_items")'));
  assert(read.length > 0 && /\.order\("id", \{ ascending: true \}\)\s*\.range\(offset, offset \+ 999\)/.test(read),
    "setup_overview's tenant_setup_items read is no longer an id-ordered range page");
  assert(/for \(let offset = 0;/.test(OVERVIEW) && /offset \+= page\.length;/.test(OVERVIEW),
    "setup_overview no longer loops pages, advancing by what came back");
  assert(/if \(!page \|\| !page\.length\) break;/.test(OVERVIEW), "setup_overview must stop on an EMPTY page");
});
