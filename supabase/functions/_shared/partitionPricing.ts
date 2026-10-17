// INTERIOR (PARTITION) WALLS ON THE ESTIMATE — the server half (migration 278; v2 geometry and wall
// height, Interior walls v2 slices 2 and 2b, 2026-10-17).
//
// A builder asked for a wall inside the building that can hold a door or a window. The designer stores
// one in feet as a segment ({ x1Ft, y1Ft, x2Ft, y2Ft, heightMode, heightIn, stud, covers, openings };
// the PARTITION WALLS block in both designer twins) and sends what the estimate needs as
// itemSummary.partitions: each wall's ends and length, how tall it goes, its stud size and the catalog
// id of every door and window in it. The v1 shape ({ axis, lengthFt, heightIn }) is still read, so an
// estimate from a designer tab opened before v2 still prices.
//
// TRUST. submit-estimate is reachable with the public anon key, so every number in that list is
// attacker-controlled. Nothing here makes a wall dearer than the building can hold:
//   * each end is clamped into the building (0..width x 0..length, from building_sizes) and the length
//     is the distance between them, never more than the building's diagonal. A v1 wall with no ends is
//     clamped to the building's run along its axis (an unknown axis gets the longer one);
//   * a "custom" height is clamped to the wall the estimate prices (resolvedWallHeightFt), and anything
//     missing, unreadable or over it is stud wall height — the wall itself, never more;
//   * a wall "to the rafters" is charged by the face area the designer worked out (faceAreaSqFt), held
//     between length x the wall and length x (the wall + the roof's greatest rise, partitionMaxRiseFt).
//     "plate" and "custom" walls are always recomputed here from length x height;
//   * a stud size is one the builder offers (a rate is set for it), else the builder's standard;
//   * at most PARTITION_MAX walls and PARTITION_OPENINGS_MAX openings in each are read;
//   * a door or window carries no price at all here: submit-estimate prices it from fixture_items by
//     its id, and an id that is not in this tenant's catalog prices nothing.
// Under-reporting is always possible — the caller could simply leave a wall off — so it is not guarded.
//
// HOW A WALL IS CHARGED is the builder's method and the rate for its stud size (interior_wall_settings,
// read by interiorWallRates below), through partitionCharge: per lineal foot of wall or per square foot
// of wall, the builder's choice of exactly two (Carolyn, 2026-10-17; no "each" for the wall). The
// designer's ssPartitionCharge is the same rule line for line, so Details and the estimate agree to the
// cent; submitEstimatePartitionWiring_test.ts drives both and compares.
//
// NO SETUP, NO WALLS (2026-10-17). Each builder sets interior wall pricing up on the Interior walls
// tab; a tenant with no interior_wall_settings row is not offered interior walls (the designer shows
// no Interior wall button). A wall that still reaches the estimate (a design saved before, or a hand-
// built body) gets its $0 line, the hidden-until-priced posture of every layout item: it is on the
// plan, so the estimate says so, and it is never charged. The 278 partitionWall layout row prices a
// wall ONLY when the interior_wall_settings table itself does not exist (a database before 312), which
// is the same case in which get_config carries no interiorWalls key and the designer keeps 278's
// behaviour.

/** More walls than any real shed has; the rest of the list is ignored. */
export const PARTITION_MAX = 30;
/** More doors and windows than any partition holds; the rest are ignored. */
export const PARTITION_OPENINGS_MAX = 8;
/** A length when the building's own size cannot be read (no width or length on the size row). */
const LENGTH_CAP_FT = 100;
/** The roof's greatest rise over the plate when the style's pitch or the building's width is unknown. */
export const RISE_CAP_FT = 15;
/** The shape ssPriceRowKey may be given: anything else gets no row key, so no rep price can find it. */
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const r2 = (n: number) => Math.round(n * 100) / 100;

export type Stud = "2x4" | "2x6";
export type HeightMode = "plate" | "rafters" | "custom";
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
  lengthFt: number;
  /** The flat height: the wall for "plate" and "rafters" (its lowest top), the stated height for "custom". */
  heightFt: number;
  heightMode: HeightMode;
  /** One face, in square feet: length x height, or the clamped area under a wall to the rafters. */
  faceAreaSqFt: number;
  /** The stud size the body asked for, when it is a size at all (null = the builder's standard). */
  stud: Stud | null;
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
const num = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The roof's greatest rise over the plate, in feet, from the style's d3 roof and the building's size:
 * a gable's (span / 2) x pitch, a gambrel's ridge, a single slope's span x pitch, plus room for a rear
 * roof step (1.5 ft) and a roof raised on its rafters (1 ft). The span is taken as the LONGER side, so
 * the bound is never short whichever way the ridge runs. A style with wings, or with no roof pitch, or
 * a building of unknown size, gets RISE_CAP_FT.
 */
export function partitionMaxRiseFt(d3: unknown, widthFt: number, lengthFt: number): number {
  // deno-lint-ignore no-explicit-any
  const roof = d3 && typeof d3 === "object" ? (d3 as Record<string, any>).roof : null;
  const span = Math.max(Number(widthFt) || 0, Number(lengthFt) || 0);
  if (!roof || typeof roof !== "object" || !(span > 0)) return RISE_CAP_FT;
  if (Number(roof.wingWidthFt) > 0.5 || (Array.isArray(roof.wingList) && roof.wingList.length)) return RISE_CAP_FT;
  const type = roof.type || "gable";
  let rise: number;
  if (type === "gambrel") {
    rise = (span / 2) * Math.max(num(roof.ridgeRise) ?? 0.8, num(roof.kneeRise) ?? 0.55);
  } else {
    const pitch = num(roof.pitch);
    if (pitch == null || pitch <= 0) return RISE_CAP_FT;
    rise = type === "shed" ? span * pitch : (span / 2) * pitch;
  }
  return Number.isFinite(rise) && rise >= 0 ? rise + 1.5 + 1 : RISE_CAP_FT;
}

/**
 * itemSummary.partitions, read defensively and clamped (see TRUST above). `building` is the size row's
 * inside width and length in feet; `wallFt` the wall height the estimate prices. `opts.maxRiseFt` is
 * partitionMaxRiseFt's answer (RISE_CAP_FT when absent) and `opts.allowRafters` false makes every wall
 * to the rafters a stud wall height one. A malformed entry is dropped, never refused: a shopper must
 * never be blocked by a field they did not knowingly send.
 */
export function partitionsFromPayload(
  raw: unknown,
  building: { widthFt: number; lengthFt: number },
  wallFt: number,
  opts: { maxRiseFt?: number; allowRafters?: boolean } = {},
): Partition[] {
  if (!Array.isArray(raw)) return [];
  const wall = Number.isFinite(wallFt) && wallFt > 0 ? wallFt : 8;
  const W = Number(building.widthFt) > 0 ? Number(building.widthFt) : 0;
  const L = Number(building.lengthFt) > 0 ? Number(building.lengthFt) : 0;
  const rise = Number.isFinite(opts.maxRiseFt) && (opts.maxRiseFt as number) >= 0 ? (opts.maxRiseFt as number) : RISE_CAP_FT;
  const out: Partition[] = [];
  for (const e of raw.slice(0, PARTITION_MAX)) {
    if (!e || typeof e !== "object") continue;
    // deno-lint-ignore no-explicit-any
    const p = e as Record<string, any>;
    const x1 = num(p.x1Ft), y1 = num(p.y1Ft), x2 = num(p.x2Ft), y2 = num(p.y2Ft);
    let lengthFt: number;
    if (x1 != null && y1 != null && x2 != null && y2 != null) {
      // v2: the ends, clamped into the building; the length is the distance between them. The
      // designer's own rounding of that length is kept when it agrees with the ends to 0.02 ft.
      const xMax = W > 0 ? W : LENGTH_CAP_FT, yMax = L > 0 ? L : LENGTH_CAP_FT;
      const len = Math.hypot(clamp(x2, 0, xMax) - clamp(x1, 0, xMax), clamp(y2, 0, yMax) - clamp(y1, 0, yMax));
      const said = num(p.lengthFt);
      const diag = W > 0 && L > 0 ? Math.hypot(W, L) : LENGTH_CAP_FT;
      lengthFt = r2(Math.min(said != null && Math.abs(said - len) <= 0.02 ? said : len, diag));
    } else {
      const axis = p.axis === "x" || p.axis === "y" ? p.axis : null;
      const span = axis === "x" ? W : axis === "y" ? L : Math.max(W, L);
      const len = Number(p.lengthFt);
      if (!Number.isFinite(len) || len <= 0) continue;
      lengthFt = r2(Math.min(len, span > 0 ? span : LENGTH_CAP_FT));
    }
    if (!(lengthFt > 0)) continue;
    // How tall: the v2 heightMode, or the v1 reading of heightIn (null = full height = "plate").
    const h = inches(p.heightIn);
    let heightMode: HeightMode = p.heightMode === "rafters" ? "rafters" : p.heightMode === "plate" ? "plate"
      : p.heightMode === "custom" ? "custom" : (h == null ? "plate" : "custom");
    if (heightMode === "custom" && (h == null || h / 12 >= wall)) heightMode = "plate";
    if (heightMode === "rafters" && opts.allowRafters === false) heightMode = "plate";
    const heightFt = heightMode === "custom" ? (h as number) / 12 : wall;
    let faceAreaSqFt = lengthFt * heightFt;
    if (heightMode === "rafters") {
      const fa = num(p.faceAreaSqFt);
      faceAreaSqFt = clamp(fa != null ? fa : lengthFt * wall, lengthFt * wall, lengthFt * (wall + rise));
    }
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
    out.push({
      id: idOf(p.id), lengthFt, heightFt, heightMode, faceAreaSqFt,
      stud: p.stud === "2x4" || p.stud === "2x6" ? p.stud : null, openings,
    });
  }
  return out;
}

/** The two ways a builder may price the wall itself (coverings keep their own methods). */
export type WallMethod = "lineal_ft" | "sqft_option";
const isWallMethod = (m: unknown): m is WallMethod => m === "lineal_ft" || m === "sqft_option";

/** The builder's interior wall pricing: their standard stud, the method and a rate per offered size. */
export type InteriorWallRates = {
  /** The standard stud has a rate: walls are offered. false = no setup, and every wall prices $0. */
  offered: boolean;
  standardStud: Stud;
  method: WallMethod;
  rates: Record<Stud, number | null>;
  allowRafters: boolean;
  /** false when the builder marked the walls not taxable; null = say nothing (the layout row's flag). */
  taxable: boolean | null;
  source: "interior_wall_settings" | "layout_item_pricing" | "none";
};

/** No setup: nothing offered, nothing charged. */
const NOT_SET_UP: InteriorWallRates = {
  offered: false, standardStud: "2x4", method: "lineal_ft", rates: { "2x4": null, "2x6": null },
  allowRafters: true, taxable: null, source: "none",
};

/**
 * interior_wall_settings' row for the tenant. No row = the builder has not set interior walls up, so
 * none are offered or charged (NOT_SET_UP). Only when `opts.tableMissing` (the table does not exist:
 * a database before 312) is the 278 partitionWall layout_item_pricing row read, as the standard 2x4
 * rate, exactly as before 312 — and then only for a per-foot or per-square-foot row. A size whose rate
 * is null is not offered; a row whose method is not one of the two is not offered either.
 */
export function interiorWallRates(
  // deno-lint-ignore no-explicit-any
  row: Record<string, any> | null | undefined,
  layout: { method: string; rate: number } | null | undefined,
  opts: { tableMissing?: boolean } = {},
): InteriorWallRates {
  if (row && typeof row === "object") {
    if (!isWallMethod(row.pricing_method)) return { ...NOT_SET_UP, source: "interior_wall_settings" };
    const rate = (v: unknown) => { const n = num(v); return n != null && n >= 0 ? n : null; };
    const standardStud: Stud = row.standard_stud === "2x6" ? "2x6" : "2x4";
    const rates = { "2x4": rate(row.rate_2x4), "2x6": rate(row.rate_2x6) };
    return {
      offered: rates[standardStud] != null,
      standardStud,
      method: row.pricing_method,
      rates,
      allowRafters: row.allow_rafters !== false,
      taxable: row.taxable === false ? false : row.taxable === true ? true : null,
      source: "interior_wall_settings",
    };
  }
  if (opts.tableMissing && layout && isWallMethod(layout.method)) {
    return {
      offered: true,
      standardStud: "2x4",
      method: layout.method,
      rates: { "2x4": Number(layout.rate) || 0, "2x6": null },
      allowRafters: true,
      taxable: null,
      source: "layout_item_pricing",
    };
  }
  return { ...NOT_SET_UP };
}

/** Whether a failed interior_wall_settings read means the table does not exist (a database before 312):
 *  PostgREST's "not in the schema cache" (PGRST205) or Postgres' undefined_table (42P01). Any other
 *  failure is a failed read, never a reason to price from the 278 row. */
export function interiorWallTableMissing(err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "PGRST205" || code === "42P01") return true;
  return /interior_wall_settings/.test(String(err.message ?? "")) && /does not exist|could not find the table/i.test(String(err.message ?? ""));
}

/** The stud size a wall is priced at: its own when the builder offers it, else the standard. */
export function partitionStud(p: { stud: Stud | null }, cfg: InteriorWallRates): Stud {
  return p.stud && cfg.rates[p.stud] != null ? p.stud : cfg.standardStud;
}

/** The charge for one wall under the builder's method: { qty, method } with the line's unit amount
 *  being the rate. sqft_option is its face (length x height, or the clamped area under a wall to the
 *  rafters; both to the cent); lineal_ft, and anything else (interiorWallRates never hands on another
 *  method with a rate), is its length. There is no "each" for a wall. */
export function partitionCharge(
  p: { lengthFt: number; heightFt: number; heightMode?: HeightMode; faceAreaSqFt?: number },
  method: string | undefined,
): { qty: number; method: WallMethod } {
  const len = r2(p.lengthFt);
  if (method === "sqft_option") {
    if (p.heightMode === "rafters" && Number.isFinite(p.faceAreaSqFt)) return { qty: r2(Math.max(r2(p.faceAreaSqFt as number), len * p.heightFt)), method };
    return { qty: r2(len * p.heightFt), method };
  }
  return { qty: len, method: "lineal_ft" };
}

/** Feet in feet-and-inches, to the inch — the designer's ssPartitionFtIn. */
export function ftIn(ft: number): string {
  const n = Math.round(Number(ft) * 12);
  if (!(n > 0)) return '0"';
  const f = Math.floor(n / 12), i = n % 12;
  return f ? (i ? `${f}'${i}"` : `${f}'`) : `${i}"`;
}

/** The wall line's description: "12' long, stud wall height (8') · 2x6 framing · with a door and a
 *  window" — the size in the designer's own words (ssPartitionSize), then the framing when it is
 *  given, then what is in the wall. */
export function partitionDescription(p: Partition, stud?: Stud): string {
  const size = `${ftIn(p.lengthFt)} long, ${p.heightMode === "rafters" ? "to the rafters"
    : p.heightMode === "custom" ? `${ftIn(p.heightFt)} tall` : `stud wall height (${ftIn(p.heightFt)})`}`;
  const doors = p.openings.filter((o) => o.kind === "door").length;
  const wins = p.openings.length - doors;
  const what = [doors ? (doors === 1 ? "a door" : `${doors} doors`) : null, wins ? (wins === 1 ? "a window" : `${wins} windows`) : null].filter(Boolean);
  return [size, stud ? `${stud} framing` : null, what.length ? `with ${what.join(" and ")}` : null].filter(Boolean).join(" · ");
}

/** A door or window line's description: its size (the catalog's, when the row has one), how a door
 *  opens, and that it is in the interior wall — the words the doors[] lines use for the same things. */
export function partitionOpeningDescription(o: PartitionOpening, widthIn: number | null, heightIn: number | null): string {
  const w = widthIn ?? o.widthIn, h = heightIn ?? o.heightIn;
  const op = o.kind !== "door" ? null : o.operation === "slideup" ? "slide up" : o.operation === "double" ? "double"
    : o.operation === "right" ? "right hinge" : o.operation === "left" ? "left hinge" : null;
  return [w && h ? `${ftIn(w / 12)}×${ftIn(h / 12)}` : null, op, "in interior wall"].filter(Boolean).join(" · ");
}
