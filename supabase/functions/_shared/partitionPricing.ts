// PARTITION WALLS ON THE ESTIMATE — the server half (migration 278).
//
// A builder asked for a wall inside the building that can hold a door or a window. The designer stores
// one in feet ({ axis, atFt, fromFt, toFt, heightIn, openings }; the PARTITION WALLS block in both
// designer twins) and sends what the estimate needs as itemSummary.partitions: each wall's length,
// its height (null = full) and the catalog id of every door and window in it.
//
// TRUST. submit-estimate is reachable with the public anon key, so every number in that list is
// attacker-controlled. Nothing here makes a wall dearer than the building can hold:
//   * a length is clamped to the building's inside dimension along the wall's run (axis "x" runs the
//     building's width, "y" its length, both from building_sizes; an unknown axis gets the longer one);
//   * a height is clamped to the wall the estimate prices (resolvedWallHeightFt), and anything missing,
//     unreadable or over it is full height — the wall itself, never more;
//   * at most PARTITION_MAX walls and PARTITION_OPENINGS_MAX openings in each are read;
//   * a door or window carries no price at all here: submit-estimate prices it from fixture_items by
//     its id, and an id that is not in this tenant's catalog prices nothing.
// Under-reporting is always possible — the caller could simply leave a wall off — so it is not guarded.
//
// HOW A WALL IS CHARGED is the builder's method on the partitionWall pricing row, through
// partitionCharge below: per foot of wall, per square foot of wall (length x height), or each. The
// designer's ssPartitionCharge is the same rule line for line, so Details and the estimate agree to the
// cent; submitEstimatePartitionWiring_test.ts drives both and compares.

/** More walls than any real shed has; the rest of the list is ignored. */
export const PARTITION_MAX = 30;
/** More doors and windows than any partition holds; the rest are ignored. */
export const PARTITION_OPENINGS_MAX = 8;
/** A length when the building's own size cannot be read (no width or length on the size row). */
const LENGTH_CAP_FT = 100;
/** The shape ssPriceRowKey may be given: anything else gets no row key, so no rep price can find it. */
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const r2 = (n: number) => Math.round(n * 100) / 100;

export type PartitionOpening = {
  id: string | null;
  kind: "door" | "window";
  fixtureItemId: string | null;
  name: string;
  widthIn: number | null;
  heightIn: number | null;
  swing: "in" | "out" | null;
  operation: string | null;
};
export type Partition = {
  id: string | null;
  axis: "x" | "y" | null;
  lengthFt: number;
  heightFt: number;
  fullHeight: boolean;
  openings: PartitionOpening[];
};

const idOf = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  return ID_RE.test(s) ? s : null;
};
const inches = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
};
const text = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * itemSummary.partitions, read defensively and clamped (see TRUST above). `building` is the size row's
 * inside width and length in feet; `wallFt` the wall height the estimate prices. A malformed entry is
 * dropped, never refused: a shopper must never be blocked by a field they did not knowingly send.
 */
export function partitionsFromPayload(
  raw: unknown,
  building: { widthFt: number; lengthFt: number },
  wallFt: number,
): Partition[] {
  if (!Array.isArray(raw)) return [];
  const wall = Number.isFinite(wallFt) && wallFt > 0 ? wallFt : 8;
  const W = Number(building.widthFt) > 0 ? Number(building.widthFt) : 0;
  const L = Number(building.lengthFt) > 0 ? Number(building.lengthFt) : 0;
  const out: Partition[] = [];
  for (const e of raw.slice(0, PARTITION_MAX)) {
    if (!e || typeof e !== "object") continue;
    // deno-lint-ignore no-explicit-any
    const p = e as Record<string, any>;
    const axis = p.axis === "x" || p.axis === "y" ? p.axis : null;
    const span = axis === "x" ? W : axis === "y" ? L : Math.max(W, L);
    const len = Number(p.lengthFt);
    if (!Number.isFinite(len) || len <= 0) continue;
    const lengthFt = r2(Math.min(len, span > 0 ? span : LENGTH_CAP_FT));
    const h = inches(p.heightIn);
    const fullHeight = h == null || h / 12 >= wall;
    const openings: PartitionOpening[] = [];
    for (const o of (Array.isArray(p.openings) ? p.openings : []).slice(0, PARTITION_OPENINGS_MAX)) {
      if (!o || typeof o !== "object") continue;
      const kind = o.kind === "window" ? "window" : o.kind === "door" ? "door" : null;
      if (!kind) continue;
      openings.push({
        id: idOf(o.id),
        kind,
        fixtureItemId: o.fixtureItemId != null && String(o.fixtureItemId).length <= 64 ? String(o.fixtureItemId) : null,
        name: text(o.name, 80) || (kind === "window" ? "Window" : "Door"),
        widthIn: inches(o.widthIn),
        heightIn: inches(o.heightIn),
        swing: o.swing === "in" || o.swing === "out" ? o.swing : null,
        operation: typeof o.operation === "string" ? text(o.operation, 20) : null,
      });
    }
    out.push({ id: idOf(p.id), axis, lengthFt, heightFt: fullHeight ? wall : (h as number) / 12, fullHeight, openings });
  }
  return out;
}

/** The charge for one wall under the builder's method: { qty, method } with the line's unit amount
 *  being the rate. lineal_ft is its length, sqft_option its length x height (both to the cent), and
 *  every other method — "each" and anything a row could carry that means nothing for a wall — one. */
export function partitionCharge(p: { lengthFt: number; heightFt: number }, method: string | undefined): { qty: number; method: "lineal_ft" | "sqft_option" | "each" } {
  const len = r2(p.lengthFt);
  if (method === "lineal_ft") return { qty: len, method };
  if (method === "sqft_option") return { qty: r2(len * p.heightFt), method };
  return { qty: 1, method: "each" };
}

/** Feet in feet-and-inches, to the inch — the designer's ssPartitionFtIn. */
export function ftIn(ft: number): string {
  const n = Math.round(Number(ft) * 12);
  if (!(n > 0)) return '0"';
  const f = Math.floor(n / 12), i = n % 12;
  return f ? (i ? `${f}'${i}"` : `${f}'`) : `${i}"`;
}

/** The wall line's description: "12' long, full height (8') · with a door and a window". */
export function partitionDescription(p: Partition): string {
  const size = `${ftIn(p.lengthFt)} long, ${p.fullHeight ? `full height (${ftIn(p.heightFt)})` : `${ftIn(p.heightFt)} tall`}`;
  const doors = p.openings.filter((o) => o.kind === "door").length;
  const wins = p.openings.length - doors;
  const what = [doors ? (doors === 1 ? "a door" : `${doors} doors`) : null, wins ? (wins === 1 ? "a window" : `${wins} windows`) : null].filter(Boolean);
  return what.length ? `${size} · with ${what.join(" and ")}` : size;
}

/** A door or window line's description: its size (the catalog's, when the row has one), how a door
 *  opens, and that it is in the partition — the words the doors[] lines use for the same things. */
export function partitionOpeningDescription(o: PartitionOpening, widthIn: number | null, heightIn: number | null): string {
  const w = widthIn ?? o.widthIn, h = heightIn ?? o.heightIn;
  const op = o.kind !== "door" ? null : o.operation === "slideup" ? "slide up" : o.operation === "double" ? "double"
    : o.operation === "right" ? "right hinge" : o.operation === "left" ? "left hinge" : null;
  return [w && h ? `${ftIn(w / 12)}×${ftIn(h / 12)}` : null, op, "in partition wall"].filter(Boolean).join(" · ");
}
