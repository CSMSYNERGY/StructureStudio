// Self-contained on purpose: no jsr:/npm: imports, so the gate does not need a registry
// fetch and cannot fail closed on an offline machine. Preflight runs this group.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOverlayItems, columnIdMap, doneLabelIds, isItemDone, overlaySlugs, remapValues, statusColumnOf,
} from "./pmOverlay.ts";

const statusCol = (id: string, labels: Array<{ id: string; kind?: string }>) =>
  ({ id, name: "Status", type: "status", settings: { labels } });

Deno.test("doneLabelIds reads kind, never the label text", () => {
  const c = statusCol("s1", [
    { id: "l_fixed", kind: "done" },
    { id: "l_dup", kind: "done" },
    { id: "l_fixing", kind: "working" },
    { id: "l_readydev" },                       // untagged
    { id: "l_shipped_but_untagged" },           // named like done, NOT tagged
  ]);
  const done = doneLabelIds(c);
  assertEquals([...done].sort(), ["l_dup", "l_fixed"]);
  // The whole point: a label that merely READS as finished is not treated as finished.
  assert(!done.has("l_shipped_but_untagged"));
});

Deno.test("an untagged label is NOT done — the safe direction", () => {
  const c = statusCol("s1", [{ id: "l_new" }, { id: "l_fixed", kind: "done" }]);
  assert(!isItemDone({ id: "i", board_id: "b", name: "x", values: { s1: "l_new" } }, c));
  assert(isItemDone({ id: "i", board_id: "b", name: "x", values: { s1: "l_fixed" } }, c));
  // No status set at all: still visible, never silently hidden.
  assert(!isItemDone({ id: "i", board_id: "b", name: "x", values: {} }, c));
});

Deno.test("doneLabelIds is empty for a non-status column", () => {
  assertEquals(doneLabelIds({ id: "c", name: "Notes", type: "long_text" }).size, 0);
  assertEquals(doneLabelIds(null).size, 0);
});

Deno.test("columnIdMap matches on name AND type, case/space insensitive on name", () => {
  const src = [
    { id: "s-status", name: "Status", type: "status" },
    { id: "s-assignee", name: " assignee ", type: "people" },
    { id: "s-due", name: "Due", type: "date" },
  ];
  const dest = [
    { id: "d-status", name: "status", type: "status" },
    { id: "d-assignee", name: "Assignee", type: "people" },
    { id: "d-due", name: "Due", type: "date" },
  ];
  const m = columnIdMap(src, dest);
  assertEquals(m.get("s-status"), "d-status");
  assertEquals(m.get("s-assignee"), "d-assignee");
  assertEquals(m.get("s-due"), "d-due");
});

Deno.test("columnIdMap FAILS CLOSED on a type mismatch", () => {
  // Same name, different type. Writing a text value into a date column is exactly the
  // corruption this pair-matching exists to prevent.
  const m = columnIdMap([{ id: "s-due", name: "Due", type: "text" }], [{ id: "d-due", name: "Due", type: "date" }]);
  assertEquals(m.size, 0);
  assertEquals(m.get("s-due"), undefined);
});

Deno.test("columnIdMap drops a column the destination does not have", () => {
  const m = columnIdMap(
    [{ id: "s-client", name: "Client", type: "text" }, { id: "s-status", name: "Status", type: "status" }],
    [{ id: "d-status", name: "Status", type: "status" }],
  );
  assertEquals(m.size, 1);
  assertEquals(m.get("s-status"), "d-status");
});

Deno.test("remapValues re-keys what it can and drops the rest", () => {
  const m = new Map([["s-status", "d-status"]]);
  assertEquals(remapValues({ "s-status": "l_fixing", "s-orphan": "keep me out" }, m), { "d-status": "l_fixing" });
  assertEquals(remapValues(null, m), {});
});

Deno.test("statusColumnOf takes the first status column", () => {
  assertEquals(statusColumnOf([{ id: "a", name: "Notes", type: "long_text" }, { id: "b", name: "Status", type: "status" }])?.id, "b");
  assertEquals(statusColumnOf([{ id: "a", name: "Notes", type: "long_text" }]), null);
});

Deno.test("overlaySlugs is empty for an ordinary board, so the feature is inert", () => {
  assertEquals(overlaySlugs(null), []);
  assertEquals(overlaySlugs({}), []);
  assertEquals(overlaySlugs({ settings: {} }), []);
  assertEquals(overlaySlugs({ settings: { overlay_from: "bugs" } }), []);          // not an array
  assertEquals(overlaySlugs({ settings: { overlay_from: ["bugs", " features "] } }), ["bugs", "features"]);
  assertEquals(overlaySlugs({ settings: { overlay_from: ["a", 1, null, "b"] } }), ["a", "b"]);
});

Deno.test("buildOverlayItems: finished items drop out, the rest are remapped and stamped", () => {
  const destColumns = [
    { id: "d-status", name: "Status", type: "status" },
    { id: "d-assignee", name: "Assignee", type: "people" },
  ];
  const bugsColumns = [
    statusCol("b-status", [{ id: "l_readydev" }, { id: "l_fixed", kind: "done" }]),
    { id: "b-assignee", name: "Assignee", type: "people" },
    { id: "b-client", name: "Client", type: "text" },   // no counterpart on the working board
  ];
  const rows = buildOverlayItems({
    destColumns,
    sources: [{
      board: { id: "B1", slug: "bugs", name: "Bugs" },
      columns: bugsColumns,
      items: [
        { id: "i1", board_id: "B1", name: "Wall Height Measurements", values: { "b-status": "l_readydev", "b-assignee": "p1", "b-client": "structure-studio" } },
        { id: "i2", board_id: "B1", name: "QuickBooks phone number", values: { "b-status": "l_fixed" } },
      ],
    }],
  });

  assertEquals(rows.length, 1, "the Fixed item is not on the working table");
  const r = rows[0];
  assertEquals(r.name, "Wall Height Measurements");
  // Its identity is UNCHANGED: update_item is keyed by id and resolves columns from
  // board_id, so an edit still lands on Bugs with Bugs' own columns.
  assertEquals(r.id, "i1");
  assertEquals(r.board_id, "B1");
  assertEquals(r.home_board_slug, "bugs");
  assertEquals(r.home_board_name, "Bugs");
  assertEquals(r.overlay, true);
  // Values are remapped for DISPLAY, and the unmappable Client column is dropped rather
  // than written under some other column's id.
  assertEquals(r.values, { "d-status": "l_readydev", "d-assignee": "p1" });
});

Deno.test("buildOverlayItems keeps items whose board has no done labels at all", () => {
  const rows = buildOverlayItems({
    destColumns: [{ id: "d-status", name: "Status", type: "status" }],
    sources: [{
      board: { id: "B2", slug: "features", name: "Feature Requests" },
      columns: [statusCol("f-status", [{ id: "l_new" }, { id: "l_planned" }])],
      items: [{ id: "j1", board_id: "B2", name: "Side nav", values: { "f-status": "l_new" } }],
    }],
  });
  assertEquals(rows.length, 1);
});
