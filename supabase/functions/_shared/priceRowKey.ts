// ONE SPELLING FOR A PRICED LINE'S ROW KEY (the rep price override, migration 277, 2026-10-05).
//
// A builder asked for a rep with the right permission to change the price of a line right in the
// Designer, silently: the customer's quote shows the new price as the line's price, never as a
// "Custom" fee or a "Discount". The rep types the price on a Details row; submit-estimate prices the
// estimate from the catalog, line by line. Those are two different programs building two different
// lists, so the rep's price has to travel from one to the other by NAME — and the name is this key.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT IS SILENT. If the designer spells a row "fx:<id>|<colour>|"
// and the server spells the same line "fx:<id>|<colour>", nothing errors: the override simply finds
// no line, the quote goes out at list price, and the Details screen the rep looked at said otherwise.
// So there is exactly ONE function that spells a key, and it exists three times, byte for byte:
//   1. here, imported by submit-estimate;
//   2. structure-studio.component.js and
//   3. StructureStudio.jsx, the two hand-mirrored designer twins, which cannot import a file.
// _test_stubs/priceOverride_test.ts lifts the region between the two marker comments out of all
// three files and fails the push when any one differs. Change it here first, then paste the region
// into both twins unchanged.
//
// It is plain JavaScript on purpose — default parameters instead of type annotations — so the same
// characters are valid in the browser bundle and still type-check under Deno's strict mode.
//
// PARTITION WALLS (migration 278) put a line per wall and a line per door or window in one on the
// estimate. Their keys were spelled here before anything used them, so that build could not invent a
// second spelling: "partition:<id>" for the wall and "partition:<id>:open:<openingId>" for a door or
// window in it.

// ── PRICE ROW KEYS ──
// The Details row a priced line sits on, as one string: the designer keys its rows with it and
// submit-estimate tags its lines with it (migration 277). _shared/priceRowKey.ts holds the same
// text; change both together.
//
// A catalog door, window or ramp is grouped by its fixture id, or by name|price when the placed
// item carries none (a fixture since deleted from the catalog, or a design from before ids).
function ssPriceGroupId(fixtureItemId = "", name = "", price = 0) {
  return fixtureItemId ? String(fixtureItemId) : name + "|" + price;
}
// kind  building | wallHeight | buildOnSite | cladding | paint | roof | electrical — one row each
//       layout      id = the built-in item key (singleDoor, window, loft, workbench, ramp, ...)
//       insul       id = the area (floor, walls, roof)
//       foundation | elecItem | ro   id = the catalog item id, or the placed item's id for "ro"
//       fx          id = the group id, a = colour id, b = trim colour id      (catalog doors)
//       win         id = the group id, a = colour id                          (catalog windows)
//       dress       id = shutters | flowerBox, a = colour id
//       ramp        id = the group id, or "simple" for the tenant's one ramp price
//       partition   id = the partition's id; a = a door or window in it      (partition walls, 278)
function ssPriceRowKey(kind = "", id = "", a = "", b = "") {
  switch (kind) {
    case "layout": return id;
    case "fx": return "fx:" + id + "|" + a + "|" + b;
    case "win": return "win:" + id + "|" + a;
    case "dress": return "dress:" + id + "|" + a;
    case "partition": return a ? "partition:" + id + ":open:" + a : "partition:" + id;
    case "insul": case "foundation": case "elecItem": case "ro": case "ramp": return kind + ":" + id;
    default: return kind;
  }
}
// ── END PRICE ROW KEYS ──

export { ssPriceGroupId, ssPriceRowKey };
