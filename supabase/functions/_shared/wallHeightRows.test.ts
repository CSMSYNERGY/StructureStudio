// One hauled and one built-on-site row per wall-height increase (migration 272). Dependency-free,
// so this file belongs to the `_shared/*.test.ts` group and runs without an import map.
//
// Imported directly rather than sliced from source: portal-settings' save_wall_heights is the only
// caller and this module is the rule's one authority. The portal's own pre-check (03-catalog.jsx)
// is a browser copy; its wording is pinned against this one at the bottom.

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { bindWallHeightWrites, wallHeightClash, wallHeightKey, wallHeightListedTwice } from "./wallHeightRows.ts";

// A style sold in 8, 10, 12 and 14 wide, the shape of the bug report (2026-10-02).
const WIDTHS = [8, 10, 12, 14];
const hauled = (deltaIn: number, widthsFt: number[] | null) => ({ deltaIn, buildOnSite: false, widthsFt });
const onSite = (deltaIn: number, widthsFt: number[] | null) => ({ deltaIn, buildOnSite: true, widthsFt });

Deno.test("the ask itself: +12 hauled on 8-12 and +12 built on site on 14 is allowed", () => {
  assertStrictEquals(wallHeightClash([hauled(12, [8, 10, 12]), onSite(12, [14])], WIDTHS), null);
});

Deno.test("today's catalogs (one row per increase) are all still allowed", () => {
  assertStrictEquals(wallHeightClash([], WIDTHS), null);
  assertStrictEquals(wallHeightClash([hauled(6, null), hauled(12, [8, 10])], WIDTHS), null);
  assertStrictEquals(wallHeightClash([hauled(6, [8, 10, 12, 14]), onSite(24, [8, 10])], WIDTHS), null);
});

Deno.test("two hauled rows for one increase are refused, as 'listed twice' always was", () => {
  const why = wallHeightClash([hauled(12, [8, 10]), hauled(12, [14])], WIDTHS);
  assertEquals(why, "+12 in is listed twice. An increase can be listed once for hauled buildings and once ticked Built on site.");
});

Deno.test("two built-on-site rows for one increase are refused too", () => {
  const why = wallHeightClash([onSite(12, [12]), onSite(12, [14])], WIDTHS);
  assertEquals(why, "+12 in is listed twice as built on site. An increase can be listed once for hauled buildings and once ticked Built on site.");
});

Deno.test("a hauled and an on-site row that share a width are refused, naming the width", () => {
  // The case that would make the designer and the estimate disagree about which row a 12 wide is.
  assertEquals(
    wallHeightClash([hauled(12, [8, 10, 12]), onSite(12, [12, 14])], WIDTHS),
    "+12 in is offered both hauled and built on site at 12 ft wide. Untick that width on one of the two rows.",
  );
  assertEquals(
    wallHeightClash([hauled(12, [8, 10, 12, 14]), onSite(12, [12, 14])], WIDTHS),
    "+12 in is offered both hauled and built on site at 12, 14 ft wide. Untick those widths on one of the two rows.",
  );
});

Deno.test("a NULL widths list counts as every width the style sells", () => {
  // Portal writes have been explicit since 174, but an older NULL row is still "every width".
  assertEquals(
    wallHeightClash([hauled(12, null), onSite(12, [14])], WIDTHS),
    "+12 in is offered both hauled and built on site at 14 ft wide. Untick that width on one of the two rows.",
  );
  assertStrictEquals(wallHeightClash([hauled(12, null), onSite(12, [16])], WIDTHS), null, "16 is not a width this style sells");
});

Deno.test("on a style with no sizes yet, NULL is every width and overlaps anything", () => {
  assertEquals(
    wallHeightClash([hauled(12, null), onSite(12, null)], []),
    "+12 in is offered both hauled and built on site at every width. Untick those widths on one of the two rows.",
  );
  assertEquals(
    wallHeightClash([hauled(12, null), onSite(12, [14])], []),
    "+12 in is offered both hauled and built on site at 14 ft wide. Untick that width on one of the two rows.",
  );
});

Deno.test("different increases never clash with each other", () => {
  assertStrictEquals(wallHeightClash([hauled(6, WIDTHS), onSite(12, WIDTHS), hauled(18, WIDTHS)], WIDTHS), null);
});

// ── The pair switched off (WALL_HEIGHT_SITE_PAIRS not "on") ────────────────────────────────────
Deno.test("switched off: the ask is refused, an increase is listed once as before 272", () => {
  assertEquals(
    wallHeightListedTwice([hauled(12, [8, 10, 12]), onSite(12, [14])]),
    "+12 in is listed twice. For now, list each increase once.",
  );
  assertEquals(wallHeightListedTwice([hauled(12, [8]), hauled(12, [14])]), "+12 in is listed twice. For now, list each increase once.");
});

Deno.test("switched off: today's catalogs (one row per increase, hauled or on site) still save", () => {
  assertStrictEquals(wallHeightListedTwice([]), null);
  assertStrictEquals(wallHeightListedTwice([hauled(6, null), onSite(12, [14]), hauled(18, [8])]), null);
});

// portal-settings applies it by shape: the switch is read per request, off unless exactly "on",
// and while off it runs BEFORE the pair rule on the same list, so no pair can be stored.
Deno.test("switched off by default: portal-settings refuses the second row unless the secret is on", () => {
  const PS = Deno.readTextFileSync(new URL("../portal-settings/index.ts", import.meta.url));
  const from = PS.indexOf('if (action === "save_wall_heights") {');
  const save = from < 0 ? "" : PS.slice(from, PS.indexOf('return json({ ok: true, saved, deleted, skipped });', from));
  assert(save.length > 0, "save_wall_heights moved");
  assert(save.includes('const sitePairs = Deno.env.get("WALL_HEIGHT_SITE_PAIRS") === "on";'), "the switch, off unless exactly on");
  assert(save.includes("const asSaved = [...plans, ...leftAlone];"), "checked on the list as it will be");
  assert(save.includes("const clash = (sitePairs ? null : wallHeightListedTwice(asSaved)) ?? wallHeightClash(asSaved, allWidths);"), "off: listed twice first");
  const at = save.indexOf("const clash = ");
  assert(at > 0 && at < save.indexOf('.from("style_wall_heights").delete()') && at < save.indexOf("bindWallHeightWrites(pool, plans)"),
    "refused before anything is deleted or written");
  assert(/if \(clash\) return json\(\{ error: `Nothing was saved\. \$\{clash\}` \}, 400\);/.test(save), "refused whole");
});

Deno.test("the key is the increase and the flag", () => {
  assertEquals(wallHeightKey(12, false), "12:haul");
  assertEquals(wallHeightKey(12, true), "12:site");
  assert(wallHeightKey(12, false) !== wallHeightKey(12, true));
});

// ── bindWallHeightWrites: no write ever meets the unique key half-way through a save ───────────
// Replays the binding against an in-memory table with the 272 key, write by write in the order the
// save writes them, and fails the moment one write would collide. Then checks the END state is what
// the builder asked for, key by key.
type Existing = { id: string; deltaIn: number; buildOnSite: boolean };
type Plan = { rid: string; deltaIn: number; buildOnSite: boolean; tag: string };
function replay(pool: Existing[], plans: Plan[]) {
  const table = new Map(pool.map((r) => [r.id, { key: wallHeightKey(r.deltaIn, r.buildOnSite), tag: "old" }]));
  const targets = bindWallHeightWrites(pool, plans);
  assertEquals(targets.length, plans.length);
  let next = 0;
  plans.forEach((p, n) => {
    const key = wallHeightKey(p.deltaIn, p.buildOnSite);
    const id = targets[n] ?? `new-${next++}`;
    for (const [other, row] of table) {
      if (other !== id && row.key === key) throw new Error(`write ${n} (${p.tag}) collides with ${other} on ${key}`);
    }
    table.set(id, { key, tag: p.tag });
  });
  const byKey = Object.fromEntries([...table.values()].map((r) => [r.key, r.tag]));
  return { targets, byKey, rows: table.size };
}

Deno.test("binding: an untouched row is written onto itself", () => {
  const { targets } = replay([{ id: "a", deltaIn: 12, buildOnSite: false }], [{ rid: "a", deltaIn: 12, buildOnSite: false, tag: "A" }]);
  assertEquals(targets, ["a"]);
});

Deno.test("binding: adding the on-site +12 beside the hauled +12 inserts it", () => {
  const { targets, byKey, rows } = replay(
    [{ id: "a", deltaIn: 12, buildOnSite: false }],
    [{ rid: "a", deltaIn: 12, buildOnSite: false, tag: "hauled" }, { rid: "", deltaIn: 12, buildOnSite: true, tag: "site" }],
  );
  assertEquals(targets, ["a", null]);
  assertEquals(byKey, { "12:haul": "hauled", "12:site": "site" });
  assertEquals(rows, 2);
});

Deno.test("binding: swapping which +12 row is on site never collides", () => {
  // Row a was hauled and becomes on site; row b the other way round. Written row by row onto
  // their own ids, the first update would hit the key b still holds.
  const { targets, byKey, rows } = replay(
    [{ id: "a", deltaIn: 12, buildOnSite: false }, { id: "b", deltaIn: 12, buildOnSite: true }],
    [{ rid: "a", deltaIn: 12, buildOnSite: true, tag: "a-now-site" }, { rid: "b", deltaIn: 12, buildOnSite: false, tag: "b-now-hauled" }],
  );
  assertEquals(targets, ["b", "a"], "each lands on the row already holding its key");
  assertEquals(byKey, { "12:site": "a-now-site", "12:haul": "b-now-hauled" });
  assertEquals(rows, 2);
});

Deno.test("binding: swapping two increases' inches never collides", () => {
  const { byKey, rows } = replay(
    [{ id: "a", deltaIn: 6, buildOnSite: false }, { id: "b", deltaIn: 12, buildOnSite: false }],
    [{ rid: "a", deltaIn: 12, buildOnSite: false, tag: "a12" }, { rid: "b", deltaIn: 6, buildOnSite: false, tag: "b6" }],
  );
  assertEquals(byKey, { "12:haul": "a12", "6:haul": "b6" });
  assertEquals(rows, 2);
});

Deno.test("binding: a chain of moves (hauled +12 to on site, on-site +12 to on-site +18)", () => {
  const { byKey, rows } = replay(
    [{ id: "a", deltaIn: 12, buildOnSite: false }, { id: "b", deltaIn: 12, buildOnSite: true }],
    [{ rid: "a", deltaIn: 12, buildOnSite: true, tag: "a" }, { rid: "b", deltaIn: 18, buildOnSite: true, tag: "b" }],
  );
  assertEquals(byKey, { "12:site": "a", "18:site": "b" });
  assertEquals(rows, 2, "no row left over, none inserted");
});

Deno.test("binding: a new row taking a key a moved row gave up lands on that row, the moved one inserts", () => {
  const { targets, byKey, rows } = replay(
    [{ id: "a", deltaIn: 12, buildOnSite: false }],
    [{ rid: "a", deltaIn: 6, buildOnSite: false, tag: "a6" }, { rid: "", deltaIn: 12, buildOnSite: false, tag: "new12" }],
  );
  assertEquals(targets, [null, "a"]);
  assertEquals(byKey, { "6:haul": "a6", "12:haul": "new12" });
  assertEquals(rows, 2);
});

Deno.test("binding: a payload naming one id twice never writes a row twice", () => {
  const { targets } = replay(
    [{ id: "a", deltaIn: 12, buildOnSite: false }],
    [{ rid: "a", deltaIn: 12, buildOnSite: false, tag: "first" }, { rid: "a", deltaIn: 18, buildOnSite: false, tag: "second" }],
  );
  assertEquals(targets, ["a", null]);
});

Deno.test("binding: every row of the pool is written exactly once", () => {
  const pool = [
    { id: "a", deltaIn: 6, buildOnSite: false }, { id: "b", deltaIn: 12, buildOnSite: false },
    { id: "c", deltaIn: 12, buildOnSite: true }, { id: "d", deltaIn: 24, buildOnSite: true },
  ];
  const plans = [
    { rid: "a", deltaIn: 12, buildOnSite: true, tag: "1" }, { rid: "b", deltaIn: 6, buildOnSite: false, tag: "2" },
    { rid: "c", deltaIn: 24, buildOnSite: true, tag: "3" }, { rid: "d", deltaIn: 12, buildOnSite: false, tag: "4" },
    { rid: "", deltaIn: 30, buildOnSite: true, tag: "5" },
  ];
  const { targets, rows } = replay(pool, plans);
  const written = targets.filter((t): t is string => t !== null).sort();
  assertEquals(written, ["a", "b", "c", "d"]);
  assertEquals(targets.filter((t) => t === null).length, 1, "only the new row inserts");
  assertEquals(rows, 5);
});

// ── The portal's pre-check says the same thing ─────────────────────────────────────────────────
// portal/03-catalog.jsx refuses the same pair before it sends, so a builder reads the sentence
// instead of a refused save. It cannot import this module, so its copy (whClash, plain JS with no
// JSX in it) is lifted out of the SHIPPED file and run against the same cases as this one. The
// portal holds deltaIn as the typed string, which the lift feeds it.
const PORTAL = Deno.readTextFileSync(new URL("../../../portal/03-catalog.jsx", import.meta.url));
const P_START = "function whClash(rows, styleWidths) {";
const P_END = "// -- Wall Height Upgrades (172)";
const pi = PORTAL.indexOf(P_START);
const pj = PORTAL.indexOf(P_END, pi);
if (pi < 0 || pj < 0) {
  throw new Error(`wallHeightRows.test: could not find whClash in portal/03-catalog.jsx (start=${pi}, end=${pj}). Re-point the anchors rather than deleting this check.`);
}
const whClash = new Function(`${PORTAL.slice(pi, pj)}; return whClash;`)() as
  (rows: { deltaIn: string; buildOnSite: boolean; widthsFt: number[] | null }[], styleWidths: number[]) => string | null;

Deno.test("the portal's pre-check answers every case exactly as the server's rule does", () => {
  const cases: [ReturnType<typeof hauled>[], number[]][] = [
    [[hauled(12, [8, 10, 12]), onSite(12, [14])], WIDTHS],
    [[hauled(6, null), hauled(12, [8, 10])], WIDTHS],
    [[hauled(12, [8, 10]), hauled(12, [14])], WIDTHS],
    [[onSite(12, [12]), onSite(12, [14])], WIDTHS],
    [[hauled(12, [8, 10, 12]), onSite(12, [12, 14])], WIDTHS],
    [[hauled(12, [8, 10, 12, 14]), onSite(12, [12, 14])], WIDTHS],
    [[hauled(12, null), onSite(12, [14])], WIDTHS],
    [[hauled(12, null), onSite(12, [16])], WIDTHS],
    [[hauled(12, null), onSite(12, null)], []],
    [[hauled(12, null), onSite(12, [14])], []],
    [[onSite(12, [14]), hauled(12, [14])], WIDTHS],
    [[hauled(6, WIDTHS), onSite(12, WIDTHS), hauled(18, WIDTHS)], WIDTHS],
  ];
  for (const [rows, widths] of cases) {
    const asTyped = rows.map((r) => ({ ...r, deltaIn: String(r.deltaIn) }));
    assertEquals(whClash(asTyped, widths), wallHeightClash(rows, widths), JSON.stringify(rows));
  }
  assert(cases.some(([r, w]) => wallHeightClash(r, w) !== null) && cases.some(([r, w]) => wallHeightClash(r, w) === null),
    "the cases cover both answers");
});
