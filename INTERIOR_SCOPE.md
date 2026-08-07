# Interior section, shelves, and the road to siding — Scoping Document

**Status: NOT BUILT — plan for review. Written 2026-08-06.**

Picked up from a session that hit a usage limit before it could write this down. Carolyn's
four answers and three product decisions below are settled; everything else is open.

---

## The short version

You asked whether all this means "many different components in the options". It doesn't, but
it also isn't free. The honest split, after reading the code:

- **Grouping the palette into sections (Doors · Windows · Interior · …) is configuration.**
  The tool buttons are already generated from each tenant's `layoutItems` config — nothing is
  hard-coded. Adding an **Interior** heading is a small, safe change.
- **Moving loft and workbench into Interior is a label change.** Their data doesn't move, saved
  designs don't change, and — critically — their prices don't move either. See decision C.
- **A brand-new item type like a shelf is real code, not configuration.** The designer
  special-cases `loft` by name 19 times and `workbench` 10 times. A shelf has to be taught to
  the placement engine, both drawing paths, the pricing order, the estimate rollup, and the
  edge function. That's a day of careful work, not a config row.

So: one slice that adds the section, moves two items into it, and adds shelves — proving the
"a new interior item is mostly configuration" claim **before** we bet the bigger reorganisation
on it. Interior walls, electrical, siding and 3D stay on the roadmap with your answers recorded.

---

## The reframe: two axes, not many components

Everything you listed varies along only two axes, and the designer already models the first.

### 1. How it attaches to the building

| Item | Attaches how | Exists today? |
|---|---|---|
| Doors, windows, rough openings | on a wall line | ✅ `wallOnly` |
| Ramp | to a door | ✅ `doorSnap` |
| Workbench | against a wall, stretches along it | ✅ `wallSnap` |
| Loft | free inside, must touch a wall | ✅ `checkLoftAttached` |
| **Shelves** | against a wall — same as the workbench | **new, but reuses `wallSnap`** |
| **Interior walls** | a drawn segment between two points | **new geometry — the hardest one** |
| **Electrical** | a point on a wall or ceiling | **new, but the smallest** |

### 2. What extra attributes it carries

Doors have swing and operation. Shelves have tiers (single/double). Electrical has a device
type. That's a small per-category field set, not a separate system — the same shape the
FixtureCatalog already uses for doors.

**Siding is not on this list on purpose.** Lap / vinyl / metal / board & batten aren't things
you *place*; they're a finish on the building, priced by square foot or perimeter. That belongs
next to Colors, not on the floor plan. See the roadmap.

---

## Decisions already taken

1. **Shelves are wall-mounted only, same mechanism as the workbench** (Carolyn). No
   freestanding shelving units — that would need the loft's free-floating behaviour instead,
   and it isn't what builders sell.
2. **Interior walls must be able to hold a door** (Carolyn). Recorded; it is the main reason
   interior walls are not in slice 1.
3. **Electrical offers both a package and per-addon pricing** (Carolyn).
4. **Siding is whole-building or per-wall, and wainscot too** (Carolyn).
5. **(A) Single vs double shelves are two separate buttons** to the customer — not one button
   with a tier toggle. Simpler to pick, and each gets its own price row, which is how builders
   already think about them.
6. **(B) Shelves ship OFF until the builder prices them.** They do not appear in any tenant's
   customer-facing designer on the day this deploys. A `base_price IS NULL` item is not offered
   — the same not-yet-priced contract the size catalog already uses.
7. **(C) Loft and workbench prices "move to Interior" as a LABEL ONLY.** This is the single most
   important line in this document. See the trap below.

### The trap behind decision C

`layout_item_pricing.item_key` matches the key in each tenant's `layoutItems` config. Every
tenant's loft and workbench prices are keyed on the literal strings `loft` and `workbench`. If
"moving them to Interior" renames those keys, **every tenant's loft and workbench pricing
silently detaches** — the items keep working and quietly price at zero, on live customer
estimates, with no error anywhere.

So the move is a *grouping* attribute added alongside the key, never a rename:

```jsonc
"loft":      { "label": "Loft",      "group": "interior", ... }   // key stays "loft"
"workbench": { "label": "Workbench", "group": "interior", ... }   // key stays "workbench"
```

Same for saved designs: a placed item stores `type: "loft"`, and old short-code links customers
still hold will load it. Nothing about the stored shape changes.

---

## SLICE 1 — what to build

### What a builder sees

Their tool palette grows a heading. Instead of one flat row of buttons, they get
**Doors · Windows · Interior**, with Loft and Workbench sitting under Interior alongside two new
buttons: **Shelf** and **Double shelf**. Their customer sees the same grouping.

Nothing about their prices, their saved designs, or their existing estimates changes. Shelves
stay invisible until they price them.

### 1. The Interior section (configuration + a small render change)

- **`structure-studio.component.js` + `StructureStudio.jsx`** (the hand-mirrored twins — both,
  always): the palette at ~line 4174 currently does
  `Object.entries(ITEMS).filter(...)` into one flat row, split into included vs additional.
  Add a `group` read with a stable display order (`doors`, `windows`, `interior`, then
  ungrouped last), and render a small heading per group. Items with no `group` keep working
  exactly as now — that is what makes this safe for every existing tenant.
- **`client_configs.config.layoutItems`**: add `"group"` to each item. No migration — it's a
  jsonb field per tenant. Ships inert until the config rows are updated.
- **`portal.html` Settings → Options**: let a builder set the group on an item.

### 2. Move loft + workbench (a config edit, per tenant)

Set `"group": "interior"` on both, in each tenant's config. **Do not touch `item_key`, the
item `type` string, or any `layout_item_pricing` row.** Verify after: a saved design from before
the change still loads with its loft, and its estimate total is unchanged to the penny.

### 3. Shelves — the one genuinely new type

This is where the work is. A shelf reuses `wallSnap`, but the code branches on item names, not
only on flags. Every place that must learn about shelves:

| Where | What | Why it matters if missed |
|---|---|---|
| `ITEMS` / `layoutItems` | two entries: `shelf`, `doubleShelf` (decision A) | — |
| `handleClick` ~2396 | the `wallSnap` placement branch already generalises | — |
| **`handleClick` ~2408** | overlap check is `if (ob.type !== "workbench" ...) continue` | **a shelf would happily overlap a workbench** |
| **`onPtrMove` ~2833** | the same check again, while dragging | same, on drag |
| SVG render | draw the bar on the wall line | invisible item |
| **`generatePNG`** | draw the same bar on canvas | **the customer's PDF and emailed estimate won't match the screen** |
| **`LAYOUT_PRICE_ORDER` (line 501)** | hard-coded `["singleDoor","doubleDoor","window","workbench","loft","ramp"]` | **a type missing from this list is mis-ordered or missing on the priced estimate** |
| `itemSummary` rollup ~706 | counts, and length for resizable items | shelf never reaches the estimate |
| `submit-estimate` | a line item for the new type | silent omission on the customer's quote |
| `layout_item_pricing` | rows with `pricing_method='lineal_ft'` (like the workbench) | unpriced |

Those two overlap checks are the ones most likely to be missed, because nothing fails loudly —
you just get a shelf sitting on top of a workbench.

**Generalise rather than copy:** change `ob.type !== "workbench"` to "any `wallSnap` item on this
wall", so the next wall-mounted item is genuinely configuration. That is the change that makes
the claim in this document true rather than aspirational.

### Rollback

Slice 1 has no schema migration. Rollback is: remove `group` from the configs (palette returns
to one flat row), and set the shelf items' prices back to NULL (they stop being offered).

---

## Rules that are easy to break

1. **The twin rule.** `structure-studio.component.js` and `StructureStudio.jsx` are hand-mirrored
   with no generator. Every change here lands in both, or the browser build drifts from source.
2. **The two rendering paths.** Live UI draws in SVG; export and submit draw the same scene again
   in `generatePNG`. Add a shelf to only one and the PDF the customer receives doesn't match what
   they designed.
3. **`LAYOUT_PRICE_ORDER` is a hard-coded list**, not derived from the catalog. New types must be
   added to it explicitly.
4. **Never rename an `item_key`.** It is the join to every tenant's pricing. See decision C.
5. **`save_design` / the submit payload is a contract.** `floorPlanItems[]` and `itemSummary`
   are consumed by `submit-estimate` and stored on the design row; adding fields is safe,
   renaming or restructuring breaks old saved designs and the estimate flow silently.
6. **Old designs must keep loading.** Any new field on a placed item needs a sensible default
   when it's absent, because thousands of stored designs won't have it.

---

## Roadmap — decided, not planned

**Interior walls that can hold a door.** The hardest item: genuinely new geometry (a drawn
segment between two points), plus a door hosted *on* that segment rather than on a building
wall. Needs its own scoping pass. Everything else should ship first.

**Electrical — package or per-addon.** Both, per Carolyn. Per-addon is a point item with a
device type; the package is a single priced line that doesn't require placing anything. The
package half is close to how `customOptions` already works.

**Siding — whole building, per wall, and wainscot.** Not a floor-plan item. Priced by square
foot or perimeter, and it belongs beside Colors. The real dependency to design for:
**siding type constrains colour choice** — metal colours ≠ vinyl colours ≠ paint colours. The
`colors` table already carries paint/shingle/metal flags (migration 038) and exposes
rate/method gated by `show_pricing` (039), so the natural shape is a **Materials** concept:
pick the siding type, and the colour palette filters to what exists in that material.

Open question for Carolyn, recorded from the earlier session: **can a customer pick one siding
type for the whole building, or per wall?** Her answer — "whole or per wall and even wainscot" —
means the data model needs one field on the design *plus* optional per-wall overrides *plus* a
wainscot band. Worth its own scoping pass before anyone starts.

**3D.** Floor-plan items store a 2D footprint and a wall. 3D additionally needs **height off the
floor** (shelves at 40", outlets at 18", lights on the ceiling) and a **`model_key`** per type so
the renderer maps type → mesh without a second lookup table to maintain. Both are cheap to add
*when Interior is built* and expensive to retrofit — 3D would otherwise have to guess a mount
height for every design placed between now and then. **Add `heightOffFloorIn` and `model_key`
during slice 1 even though nothing reads them yet.**

---

## What we are deliberately NOT doing

- **Not deleting the Options feature.** After loft and workbench move to Interior it looks nearly
  empty, which is what makes deletion tempting. The fix is regrouping by *where the thing goes on
  the building* — Doors·Windows / Interior / Exterior & Attachments / Materials & Colors — not
  removal. Same catalog machinery underneath, organised the way a builder thinks.
- **Not building interior walls, electrical, siding or 3D in slice 1.** Each is recorded above
  with its decision.
- **Not turning shelves on for anyone.** Decision B: they appear when a builder prices them.
- **Not renaming anything.** See rule 4.

---

## Open questions for Carolyn

1. **Shelf depth** — is it a fixed depth per tenant (a setting), or does the customer resize it
   in both directions? The workbench today resizes along the wall only.
2. **Does a shelf over a window matter?** Doors and windows collide with each other today. A
   shelf above a window is physically fine; a shelf across a doorway is not. Which pairs should
   the designer refuse?
3. **Wainscot** — is it priced as its own line, or as a modifier on the siding line?
