// "Offered on" for catalog fixtures (migration 272). Dependency-free, so this file belongs to the
// `_shared/*.test.ts` group and runs without an import map.
//
// Imported directly: portal-settings' validateFixtureRow, save_fixture and import_fixtures, and
// admin-catalog's template clone, are the callers and this module is the rule's one authority. The
// wiring into both is pinned by shape at the bottom, because the handlers have no unit-test harness.

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { cloneStyleIds, keepTenantStyleIds, NO_STYLE_TICKED, readStyleIds } from "./fixtureStyleIds.ts";

const GREENHOUSE = "00000000-0000-4000-8000-000000000003";
const DELUXE = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

Deno.test("null is every style, the living default every row had before 272", () => {
  assertEquals(readStyleIds(null), { value: null });
});

Deno.test("the ask: one style ticked is a one-element list", () => {
  assertEquals(readStyleIds([GREENHOUSE]), { value: [GREENHOUSE] });
});

Deno.test("ids are trimmed, lower-cased and de-duplicated, in the order sent", () => {
  assertEquals(
    readStyleIds([` ${GREENHOUSE.toUpperCase()} `, DELUXE, GREENHOUSE]),
    { value: [GREENHOUSE, DELUXE] },
  );
});

Deno.test("malformed ids are dropped, so one cannot fail the whole row at the uuid[] cast", () => {
  assertEquals(readStyleIds([GREENHOUSE, "greenhouse", 42, null, "", "not-a-uuid"]), { value: [GREENHOUSE] });
});

Deno.test("an empty list is refused, not stored as 'offered nowhere'", () => {
  assertEquals(readStyleIds([]), { err: NO_STYLE_TICKED });
  // Nothing uuid-shaped left is the same thing.
  assertEquals(readStyleIds(["greenhouse", ""]), { err: NO_STYLE_TICKED });
  assert(NO_STYLE_TICKED.includes("untick Active"), "the refusal says how to stop offering it everywhere");
});

Deno.test("anything else is ignored: the field is left as it is", () => {
  for (const raw of [undefined, "all", GREENHOUSE, 1, true, { ids: [GREENHOUSE] }]) {
    assertEquals(readStyleIds(raw), {}, JSON.stringify(raw));
  }
});

Deno.test("only this tenant's styles stay, in the order sent", () => {
  const mine = new Set([DELUXE, GREENHOUSE]);
  assertEquals(keepTenantStyleIds([GREENHOUSE, OTHER_TENANT, DELUXE], mine), [GREENHOUSE, DELUXE]);
  assertEquals(keepTenantStyleIds([OTHER_TENANT], mine), []);
  assertEquals(keepTenantStyleIds([], mine), []);
});

// ── A client cloned from a template gets its OWN style ids ─────────────────────────────────
const NEW_GREENHOUSE = "00000000-0000-4000-8000-0000000000c3";
const NEW_DELUXE = "00000000-0000-4000-8000-0000000000c1";
const CLONE_MAP = new Map([[GREENHOUSE, NEW_GREENHOUSE], [DELUXE, NEW_DELUXE]]);

Deno.test("clone: a template restricted to its Greenhouse lands on the clone's Greenhouse", () => {
  assertEquals(cloneStyleIds([GREENHOUSE], CLONE_MAP), { value: [NEW_GREENHOUSE], dropped: false });
  assertEquals(cloneStyleIds([DELUXE, GREENHOUSE], CLONE_MAP), { value: [NEW_DELUXE, NEW_GREENHOUSE], dropped: false }, "order kept");
});

Deno.test("clone: an id with no new style (deleted from the template) is dropped", () => {
  assertEquals(cloneStyleIds([GREENHOUSE, OTHER_TENANT], CLONE_MAP), { value: [NEW_GREENHOUSE], dropped: false });
});

Deno.test("clone: a list that maps to nothing becomes every style, never an empty list", () => {
  assertEquals(cloneStyleIds([OTHER_TENANT], CLONE_MAP), { value: null, dropped: true });
  assertEquals(cloneStyleIds([], CLONE_MAP), { value: null, dropped: true });
});

// ── admin-catalog, by shape ────────────────────────────────────────────────────────────────
const AC = await Deno.readTextFile(new URL("../admin-catalog/index.ts", import.meta.url));

Deno.test("admin-catalog's template clone remaps style_ids through the style map, lists only", () => {
  const clone = AC.slice(AC.indexOf("// 3. fixture_items (the doors/windows/ramps catalog)"), AC.indexOf("// 4. building_size_inclusions"));
  assert(clone.length > 0, "the clone's fixture step moved");
  assert(clone.includes("if (Array.isArray(rest.style_ids)) {"), "only a list is touched: NULL stays NULL, a missing key stays missing");
  assert(clone.includes("const s = cloneStyleIds(rest.style_ids, styleIdMap);"), "through the old -> new style map");
  assert(clone.includes("rest.style_ids = s.value;"), "and the row carries the clone's ids");
  assert(clone.indexOf("cloneStyleIds(") < clone.indexOf('.from("fixture_items").insert(fxRows)'), "before the insert");
  assert(AC.indexOf("const styleIdMap = new Map<string, string>();") < AC.indexOf("cloneStyleIds(rest.style_ids"), "the map is built first");
});

// ── portal-settings, by shape ──────────────────────────────────────────────────────────────
const PS = await Deno.readTextFile(new URL("../portal-settings/index.ts", import.meta.url));

Deno.test("validateFixtureRow reads styleIds for EVERY category, presence-guarded", () => {
  const v = PS.slice(PS.indexOf("const validateFixtureRow = "), PS.indexOf("const fixtureInsertDefaults = "));
  assert(v.length > 0, "validateFixtureRow moved");
  const at = v.indexOf('if (has("styleIds")) {');
  assert(at > 0, "styleIds is read behind has(), so a sheet without it leaves the ticks alone");
  // Not inside a category branch: the line before it closes the window-colour block, and nothing
  // between that and it tests the category.
  const before = v.slice(v.lastIndexOf("rec.window_color_ids = row.windowColorIds.map", at), at)
    .split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(!/category/.test(before), "the styleIds read sits outside every category test");
  // Two closing braces: the window-colour array branch and the window-colour category branch.
  assertEquals(before.match(/}/g)?.length, 2, before);
  assert(v.slice(at, at + 400).includes("readStyleIds(row.styleIds)"), "and goes through readStyleIds");
});

Deno.test("an insert with no styleIds gets NULL (every style), never an empty list", () => {
  const d = PS.slice(PS.indexOf("const fixtureInsertDefaults = "), PS.indexOf("const filterWindowColorIds = "));
  assert(d.includes(`if (!("style_ids" in rec)) rec.style_ids = null;`));
});

Deno.test("save_fixture and import_fixtures keep only this tenant's styles", () => {
  const save = PS.slice(PS.indexOf('if (action === "save_fixture") {'), PS.indexOf('if (action === "delete_fixture") {'));
  assert(save.includes("keepTenantStyleIds(v.rec!.style_ids as string[], t.ids!)"), "save_fixture filters by tenant");
  assert(/if \(!kept\.length\) return json\(\{ error: [^\n]*\}, 400\);/.test(save), "and refuses when none are the tenant's");
  assert(save.indexOf("keepTenantStyleIds") < save.indexOf('.from("fixture_items").update('), "before it writes");
  const imp = PS.slice(PS.indexOf('if (action === "import_fixtures") {'), PS.indexOf('if (action === "set_layout_item_archived") {'));
  assert(imp.includes("keepTenantStyleIds(v.rec!.style_ids as string[], styleIds)"), "import_fixtures filters by tenant");
  assert(imp.includes("delete v.rec!.style_ids;"), "and leaves a row's styles alone when none are the tenant's");
});

Deno.test("the catalog read returns style_ids, so the portal can show the ticks", () => {
  const sel = PS.match(/admin\.from\("fixture_items"\)\.select\("([^"]+)"\)\.eq\("client_id", clientId\)\.order\("sort_order"\)/);
  assert(sel, "the catalog's fixture_items select moved");
  assertStrictEquals(sel![1].split(", ").includes("style_ids"), true);
});
