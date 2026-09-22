// Foundation items (Carolyn, 2026-09-14).
//
// A builder can price the ground work under a building: a GRAVEL PAD, FENCE REMOVAL, PIERS and
// a CONCRETE SLAB. Each is priced by any of the product's seven methods — the same vocabulary
// layout items, cladding and build-on-site already use (see ./buildOnSite.ts, BOS_BASES). What
// makes a foundation item different from every other priced thing on the estimate is that three
// of those methods need a QUANTITY THE BUILDING CANNOT SUPPLY: "each" is how many piers,
// "lineal ft" is how much fence comes out, and "option sq ft" is the pad or slab — which defaults
// to the building's footprint (width x length) because that is what a pad usually is, but the
// customer may pour a bigger apron. The Foundation card in the designer collects those numbers,
// and this module decides what they mean.
//
// WHY THIS IS ITS OWN FILE. The same rule has to answer twice: once in submit-estimate, where
// the foundation block turns the customer's typing into the money on the estimate, and once in
// the designer, where the card previews the line before the customer commits. The designer is a
// browser twin (StructureStudio.jsx / structure-studio.component.js) and CANNOT import this — it
// carries its own copy, `foundationQtyOf`, mirrored by hand. That is exactly why the rule is
// isolated here with no dependency beyond ./buildOnSite.ts: one small, tested file the designer's
// copy is written to MIRROR, so a divergence is a diff against this file rather than an
// archaeology dig through submit-estimate. The ESTIMATE is the number that binds, and this is
// its one authority. Change the rule here first; then change the designer's copy to match.
//
// POSTURE — REFUSE, NEVER COERCE. A bad quantity returns an error and a qty of 0; it is never
// quietly rounded, clamped or defaulted. "2.5 piers" typed by a customer is a question for the
// customer, not a number for us to guess at, and the caller (submit-estimate) refuses the
// submission with the message rather than pricing something nobody asked for. This is the same
// posture as the wall-height increase: an unpriced structural change is a hard 400, not $0.

import type { BosBasis } from "./buildOnSite.ts";

/** The four foundation items, in the order the card shows them. */
export const FOUNDATION_IDS = ["gravel_pad", "fence_removal", "piers", "concrete_slab"] as const;
export type FoundationId = typeof FOUNDATION_IDS[number];

export const FOUNDATION_LABEL: Record<FoundationId, string> = {
  gravel_pad: "Gravel pad",
  fence_removal: "Fence removal",
  piers: "Piers",
  concrete_slab: "Concrete slab",
};

/**
 * Sanity ceilings on what a customer can type. They are not business rules — no builder pours
 * a 100,000 sq ft slab under a shed — they exist so a stray keystroke ("2400000") is refused
 * at the door instead of producing a seven-figure line that a rep then has to explain.
 */
export const FOUNDATION_QTY_CAP = 100000;   // sq ft / ft
export const FOUNDATION_COUNT_CAP = 1000;   // each

/** Narrow an untrusted id (request body, catalog row) to one of the four. */
export function isFoundationId(raw: unknown): raw is FoundationId {
  return typeof raw === "string" && (FOUNDATION_IDS as readonly string[]).includes(raw);
}

/**
 * True for the three OPTION-shaped bases, whose quantity is something the customer supplies
 * (or, for sqft_option, may override). The card shows an input for exactly these; the four
 * whole-building bases read their quantity off the building and show none.
 */
export function foundationNeedsQty(basis: BosBasis): boolean {
  return basis === "each" || basis === "lineal_ft" || basis === "sqft_option";
}

/** null/undefined/"" (and whitespace) read as "not given" — a blank input, not a zero. */
function isBlank(raw: unknown): boolean {
  return raw == null || (typeof raw === "string" && raw.trim() === "");
}

/**
 * The customer's typing as a number, or NaN. Numeric strings are accepted ("120" -> 120) because
 * that is what an <input> yields; anything else (booleans, objects, arrays) is NaN rather than
 * whatever Number() would make of it — Number(true) is 1 and Number([5]) is 5, and neither is a
 * quantity anybody typed.
 */
function toNum(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw.trim());
  return NaN;
}

/**
 * The quantity a foundation line is charged over, from the customer's raw input and the
 * building's geometry, or an error to show them. `qty` is 0 whenever `error` is set, so a
 * caller that forgets to check the error still cannot charge anything.
 *
 *   each                -> not given: 1 (one of the thing); else a whole number 1..COUNT_CAP
 *   lineal_ft           -> REQUIRED (nothing on the building is "the fence"); finite, > 0, <= CAP
 *   sqft_option         -> not given: the building footprint, rounded; else finite, > 0, <= CAP
 *   sqft_building       -> the footprint, rounded — the input is ignored
 *   perimeter_building  -> the perimeter, rounded — the input is ignored
 *   pct_*               -> 1: the rate is a percent, not a per-unit price — the input is ignored
 *
 * The messages are the customer's, so they say what to type, not what went wrong internally.
 */
export function foundationQtyFor(
  basis: BosBasis,
  rawQty: unknown,
  geom: { area: number; perimeter: number },
): { qty: number; error: string | null } {
  const area = Math.round(Number(geom.area) || 0);
  const perimeter = Math.round(Number(geom.perimeter) || 0);

  if (basis === "each") {
    if (isBlank(rawQty)) return { qty: 1, error: null };
    const n = toNum(rawQty);
    if (!Number.isInteger(n) || n < 1 || n > FOUNDATION_COUNT_CAP) {
      return { qty: 0, error: `enter a whole number of units (1–${FOUNDATION_COUNT_CAP})` };
    }
    return { qty: n, error: null };
  }

  if (basis === "lineal_ft") {
    if (isBlank(rawQty)) return { qty: 0, error: "enter how many feet" };
    const n = toNum(rawQty);
    if (!Number.isFinite(n) || n <= 0 || n > FOUNDATION_QTY_CAP) {
      return { qty: 0, error: "enter the feet as a number greater than 0" };
    }
    return { qty: n, error: null };
  }

  if (basis === "sqft_option") {
    if (isBlank(rawQty)) return { qty: area, error: null };
    const n = toNum(rawQty);
    if (!Number.isFinite(n) || n <= 0 || n > FOUNDATION_QTY_CAP) {
      return { qty: 0, error: "enter the square feet as a number greater than 0" };
    }
    return { qty: n, error: null };
  }

  if (basis === "sqft_building") return { qty: area, error: null };
  if (basis === "perimeter_building") return { qty: perimeter, error: null };
  return { qty: 1, error: null };   // pct_building_price, pct_estimate_total
}

/**
 * The line description the customer reads on the estimate. Dollar rates render to cents; the
 * two percentage bases print the rate exactly as the builder typed it ("10% of …", not
 * "10.00% of …"), because a percent is a whole idea and trailing cents on it read as a typo.
 */
export function foundationDesc(basis: BosBasis, qty: number, rate: number): string {
  const r = Number(rate).toFixed(2);
  switch (basis) {
    case "each": return `${qty} at $${r} each`;
    case "lineal_ft": return `${qty} ft at $${r} per foot`;
    case "sqft_option": return `${qty} sq ft at $${r} per sq ft`;
    case "sqft_building": return `${qty} sq ft of building at $${r} per sq ft`;
    case "perimeter_building": return `${qty} ft of perimeter at $${r} per foot`;
    case "pct_building_price": return `${rate}% of the building price`;
    case "pct_estimate_total": return `${rate}% of the rest of this quote`;
  }
}
