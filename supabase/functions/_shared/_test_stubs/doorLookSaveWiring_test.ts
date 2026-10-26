// A door row's own 3D look (fixture_items.door_look_id, migration 337), driven through the SHIPPED
// portal-settings handler: save_fixture, import_fixtures and the catalog read.
//
// WHAT IS PINNED (plan "Door looks from a photo" §6). Today's production portal sends doorStyle on
// EVERY door save, and edge functions reach production the moment they deploy, so:
//   1. An ABSENT doorLookId never clears a look. A doorStyle equal to the look's base keeps it (the old
//      portal's price edit); a doorStyle that differs clears it (another standard look was picked).
//   2. doorLookId <id> sets the look and forces door_style to its base; refused unless the tenant flag
//      is on and the look is this builder's and READY (another builder's, a draft, an archived one).
//   3. doorLookId null clears it (even with the flag off: clearing only ever goes back to the base).
//   4. A non-door never carries one; a malformed id is refused in words.
//   5. import_fixtures follows the same rules from one read per sheet, and a refusal is a note that
//      leaves that row's look alone while the rest of the row goes in.
//   6. On a database without 337: the catalog still loads (42703 fallback, flag reads off), and a door
//      save that never named a look goes through untouched; setting one is refused.
//   7. The catalog returns door_looks_beta and the door meter's money line beside the building one.
// Tenants and users are made up; the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { call, FakeDb, OTHER, OWN, type Row } from "./doorLookFake.ts";

const DOOR = "00000000-0000-4000-8000-0000000000d1";
const DOOR2 = "00000000-0000-4000-8000-0000000000d2";
const BARE = "00000000-0000-4000-8000-0000000000d3";
const WIN = "00000000-0000-4000-8000-0000000000a1";
const LOOK = "00000000-0000-4000-8000-00000000100a";      // OWN, ready, base zbrace
const DRAFT = "00000000-0000-4000-8000-00000000100d";     // OWN, draft
const ARCHIVED = "00000000-0000-4000-8000-0000000010ae";  // OWN, archived
const FOREIGN = "00000000-0000-4000-8000-00000000100b";   // OTHER, ready

function seed(flag: boolean | null = true): FakeDb {
  const settings: Row[] = flag === null ? [] : [{ client_id: OWN, door_looks_beta: flag }];
  return new FakeDb({
    client_settings: settings,
    fixture_items: [
      { id: DOOR, client_id: OWN, category: "door", name: "Barn door", width_in: 72, height_in: 78, price: 900, door_style: "zbrace", door_look_id: LOOK, sort_order: 0 },
      { id: DOOR2, client_id: OWN, category: "door", name: "Barn door", width_in: 60, height_in: 78, price: 800, door_style: "zbrace", door_look_id: LOOK, sort_order: 1 },
      { id: BARE, client_id: OWN, category: "door", name: "Single door", width_in: 36, height_in: 78, price: 400, door_style: "plank", door_look_id: null, sort_order: 2 },
      { id: WIN, client_id: OWN, category: "window", name: "Wall window", width_in: 24, height_in: 36, price: 120, door_style: "auto", door_look_id: null, sort_order: 0 },
    ],
    door_looks: [
      { id: LOOK, client_id: OWN, name: "Our barn door", base: "zbrace", status: "ready", spec: { v: 1, base: "zbrace" }, version: 3 },
      { id: DRAFT, client_id: OWN, name: "A draft", base: "basic", status: "draft", spec: { v: 1, base: "basic" }, version: 1 },
      { id: ARCHIVED, client_id: OWN, name: "Old look", base: "plank", status: "archived", spec: { v: 1, base: "plank" }, version: 2 },
      { id: FOREIGN, client_id: OTHER, name: "Theirs", base: "classic", status: "ready", spec: { v: 1, base: "classic" }, version: 1 },
    ],
    usage_prices: [
      { kind: "video_3d_generation", price_cents: 2000, active: false, visible: true },
      { kind: "door_look_generation", price_cents: 500, active: false, visible: true },
    ],
    wallet_accounts: [{ client_id: OWN, metered_exempt: true }],
  });
}
const LINE = { name: "Barn door", widthIn: 72, heightIn: 78, price: "950" };
const save = (db: FakeDb, extra: Record<string, unknown>) => call(db, { action: "save_fixture", category: "door", id: DOOR, ...LINE, ...extra });
const lastUpdate = (db: FakeDb) => db.writesTo("fixture_items", "update").at(-1)?.row;

Deno.test("old portal: a price edit that sends the base as doorStyle keeps the look", async () => {
  const db = seed();
  const r = await save(db, { doorStyle: "zbrace" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const row = lastUpdate(db);
  assertEquals(row.door_style, "zbrace");
  assert(!("door_look_id" in row), "the save never names door_look_id: " + JSON.stringify(row));
  assertEquals(db.rows("fixture_items").find((x) => x.id === DOOR)!.door_look_id, LOOK);
});

Deno.test("a save with neither key reads nothing about looks and writes nothing about them", async () => {
  const db = seed();
  const r = await save(db, {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(!("door_look_id" in lastUpdate(db)));
  assertEquals(db.readsOf("door_looks").length, 0);
  assertEquals(db.readsOf("client_settings").length, 0);
});

Deno.test("another standard look (a different doorStyle) takes the look off", async () => {
  const db = seed();
  const r = await save(db, { doorStyle: "plank" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(lastUpdate(db).door_look_id, null);
  assertEquals(lastUpdate(db).door_style, "plank");
  // An unrecognised doorStyle is 'auto' (the photo), which is not the base either: also off.
  const db2 = seed();
  await save(db2, { doorStyle: "sliding" });
  assertEquals(lastUpdate(db2).door_style, "auto");
  assertEquals(lastUpdate(db2).door_look_id, null);
});

Deno.test("doorLookId sets the look and forces door_style to its base", async () => {
  const db = seed();
  const r = await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, name: "Single door", doorStyle: "plank", doorLookId: LOOK.toUpperCase() });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const row = lastUpdate(db);
  assertEquals([row.door_look_id, row.door_style], [LOOK, "zbrace"]);
});

Deno.test("doorLookId is refused with the flag off, unread or missing, and for any look not this builder's and ready", async () => {
  for (const [flag, status, code] of [[false, 403, "door_looks_off"], [null, 403, "door_looks_off"]] as const) {
    const db = seed(flag);
    const r = await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, doorLookId: LOOK });
    assertEquals([r.status, r.body.code], [status, code], JSON.stringify(r.body));
    assertEquals(db.writesTo("fixture_items").length, 0, "nothing written");
  }
  {
    const db = seed();
    db.failing.add("client_settings");
    const r = await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, doorLookId: LOOK });
    assertEquals(r.status, 500, "a flag we could not read refuses: " + JSON.stringify(r.body));
    assertEquals(db.writesTo("fixture_items").length, 0);
  }
  for (const [look, status, code] of [[FOREIGN, 404, "door_look_not_found"], [DRAFT, 409, "door_look_not_ready"], [ARCHIVED, 409, "door_look_archived"], ["00000000-0000-4000-8000-000000009999", 404, "door_look_not_found"]] as const) {
    const db = seed();
    const r = await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, doorLookId: look });
    assertEquals([r.status, r.body.code], [status, code], `${look}: ${JSON.stringify(r.body)}`);
    assert(String(r.body.error).startsWith("Barn door: "), "the refusal names the line");
    assertEquals(db.writesTo("fixture_items").length, 0);
  }
  const db = seed();
  const r = await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, doorLookId: "not-a-uuid" });
  assertEquals(r.status, 400, JSON.stringify(r.body));
});

Deno.test("doorLookId null takes the look off, with the flag on or off", async () => {
  for (const flag of [true, false]) {
    const db = seed(flag);
    const r = await save(db, { doorStyle: "zbrace", doorLookId: null });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(lastUpdate(db).door_look_id, null);
    assertEquals(lastUpdate(db).door_style, "zbrace", "the base stays as its standard look");
  }
  // On a row that has no look, a null writes nothing about looks.
  const db = seed();
  await call(db, { action: "save_fixture", category: "door", id: BARE, ...LINE, doorLookId: null });
  assert(!("door_look_id" in lastUpdate(db)));
});

Deno.test("a window never carries a look, and reads nothing about looks", async () => {
  const db = seed();
  const r = await call(db, { action: "save_fixture", category: "window", id: WIN, name: "Wall window", widthIn: 24, heightIn: 36, price: "120", doorLookId: LOOK });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(!("door_look_id" in lastUpdate(db)));
  assertEquals(db.readsOf("door_looks").length, 0);
});

Deno.test("a new door: with a look it is inserted on it; without one the insert never names the column", async () => {
  const db = seed();
  const r = await call(db, { action: "save_fixture", category: "door", ...LINE, name: "New barn door", doorStyle: "plank", doorLookId: LOOK });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const ins = db.writesTo("fixture_items", "insert").at(-1)!.row;
  assertEquals([ins.door_look_id, ins.door_style], [LOOK, "zbrace"]);
  const db2 = seed();
  await call(db2, { action: "save_fixture", category: "door", ...LINE, name: "Plain door", doorStyle: "plank" });
  const ins2 = db2.writesTo("fixture_items", "insert").at(-1)!.row;
  assert(!("door_look_id" in ins2), JSON.stringify(ins2));
  assertEquals(db2.readsOf("door_looks").length, 0);
});

Deno.test("a look we could not read refuses the save (fails closed)", async () => {
  const db = seed();
  db.failing.add("door_looks");
  const r = await save(db, { doorStyle: "plank" });
  assertEquals(r.status, 500, JSON.stringify(r.body));
  assertEquals(db.writesTo("fixture_items").length, 0);
});

Deno.test("a database without 337: door saves go through untouched; setting a look is refused", async () => {
  const db = seed();
  db.missingColumns.add("fixture_items.door_look_id").add("client_settings.door_looks_beta");
  db.missingTables.add("door_looks");
  const r = await save(db, { doorStyle: "zbrace" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(!("door_look_id" in lastUpdate(db)));
  const cleared = await save(db, { doorLookId: null });
  assertEquals(cleared.status, 200, "a clear has nothing to clear: " + JSON.stringify(cleared.body));
  assert(!("door_look_id" in lastUpdate(db)));
  const set = await call(db, { action: "save_fixture", category: "door", ...LINE, doorLookId: LOOK });
  assertEquals([set.status, set.body.code], [503, "door_looks_unavailable"], JSON.stringify(set.body));
});

Deno.test("import_fixtures: the same rules, one read per sheet, refusals as notes", async () => {
  const db = seed();
  const r = await call(db, { action: "import_fixtures", category: "door", rows: [
    { id: DOOR, ...LINE, doorStyle: "zbrace" },                                   // keeps its look
    { id: DOOR2, ...LINE, doorStyle: "xbrace" },                                  // another standard look: off
    { id: BARE, ...LINE, name: "Single door", doorStyle: "plank", doorLookId: DRAFT }, // refused: a note, the rest goes in
    { ...LINE, name: "New door", doorStyle: "plank", doorLookId: LOOK },          // a new row on the look
  ] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const ups = db.writesTo("fixture_items", "update");
  const upOf = (id: string) => ups.find((w) => w.filters.some((f) => f[0] === "eq" && f[1] === "id" && f[2] === id))!.row;
  assert(!("door_look_id" in upOf(DOOR)), "the base as doorStyle keeps the look");
  assertEquals(upOf(DOOR2).door_look_id, null);
  assert(!("door_look_id" in upOf(BARE)) && upOf(BARE).price === 950, "the refused row's look is untouched and its price goes in");
  const ins = db.writesTo("fixture_items", "insert").at(-1)!.row;
  assertEquals([ins.door_look_id, ins.door_style], [LOOK, "zbrace"]);
  assertEquals(r.body.skipped.length, 1, JSON.stringify(r.body.skipped));
  assert(/Single door: Save that 3D look first.*left as it was/.test(r.body.skipped[0]), r.body.skipped[0]);
  assertEquals(db.readsOf("door_looks").length, 1, "one read of the looks for the whole sheet");
  assertEquals(db.readsOf("client_settings").length, 1, "and one of the flag");
});

Deno.test("import_fixtures: flag off refuses every look it sets; a window sheet reads nothing about looks", async () => {
  const db = seed(false);
  const r = await call(db, { action: "import_fixtures", category: "door", rows: [{ id: BARE, ...LINE, doorLookId: LOOK }, { id: DOOR, ...LINE, doorStyle: "zbrace" }] });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assert(r.body.skipped.length === 1 && /aren't turned on/.test(r.body.skipped[0]), JSON.stringify(r.body.skipped));
  assert(db.writesTo("fixture_items", "update").every((w) => !("door_look_id" in w.row)));
  const w = seed();
  await call(w, { action: "import_fixtures", category: "window", rows: [{ id: WIN, name: "Wall window", widthIn: 24, heightIn: 36, price: "120", doorLookId: LOOK }] });
  assertEquals(w.readsOf("door_looks").length + w.readsOf("client_settings").length, 0);
  assert(!("door_look_id" in w.writesTo("fixture_items", "update")[0].row));
  // A door sheet without either column reads nothing about looks either.
  const plain = seed();
  await call(plain, { action: "import_fixtures", category: "door", rows: [{ id: DOOR, ...LINE }] });
  assertEquals(plain.readsOf("door_looks").length, 0);
});

Deno.test("catalog: selects door_look_id, returns the flag and the door meter's money line", async () => {
  const db = seed();
  const r = await call(db, { action: "catalog" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  const sel = db.readsOf("fixture_items").map((x) => x.cols);
  assert(sel.some((s) => /\bin_door, door_window_at, lite_rows, lite_cols,/.test(s) && /\bdoor_look_id\b/.test(s)), JSON.stringify(sel));
  assertEquals(r.body.fixtures.find((f: any) => f.id === DOOR).door_look_id, LOOK);
  assertEquals(r.body.doorLooksBeta, true);
  assertEquals(r.body.doorWallet, { priceCents: 500, meterActive: false, exempt: true });
  assertEquals(r.body.wallet, { priceCents: 2000, meterActive: false, exempt: true }, "the building meter is unchanged");
  const off = await call(seed(false), { action: "catalog" });
  assertEquals(off.body.doorLooksBeta, false);
  const none = await call(seed(null), { action: "catalog" });
  assertEquals(none.body.doorLooksBeta, false, "no settings row: off");
});

Deno.test("catalog on a database without 337: still loads, no look on any row, flag off, no door money line", async () => {
  const db = seed();
  db.missingColumns.add("fixture_items.door_look_id").add("client_settings.door_looks_beta");
  db.tables.usage_prices = db.rows("usage_prices").filter((p) => p.kind !== "door_look_generation");
  const r = await call(db, { action: "catalog" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(r.body.fixtures.length, 4);
  assert(r.body.fixtures.every((f: any) => !("door_look_id" in f) && "door_style" in f), JSON.stringify(r.body.fixtures[0]));
  assertEquals(r.body.doorLooksBeta, false);
  assertEquals(r.body.doorWallet, null, "no price row: no money claim either way");
  assertEquals(r.body.wallet.priceCents, 2000);
  assertEquals(db.readsOf("fixture_items").length, 1, "the read that failed is not recorded; the retry is");
});
