// Build-on-site pricing (migration 183).
//
// Carolyn, 2026-09-01: taller walls are capped because "they haul these ... down the road and
// they have road restrictions to go under bridges." Above a style's haul limit the building
// can only be assembled on the customer's lot — "then it becomes a build on site building" —
// and that carries an upcharge "because they're sending the crew out there to build."
//
// The rule lives here rather than inline in submit-estimate because the same arithmetic has to
// answer twice: once for the money on the estimate, and once for the preview row the customer
// reads in the designer before they commit. The designer is a browser twin and cannot import
// this, so it still carries its own copy — but the ESTIMATE, which is the number that binds,
// has exactly one authority, and this is the file a test can hold still.

export type BosBasis = "each" | "sqft_building" | "perimeter_building";

/** NULL/unknown reads as a flat fee, matching the column comment on `bos_fee_basis`. */
export function bosBasisOf(raw: unknown): BosBasis {
  const s = String(raw ?? "").trim();
  return s === "sqft_building" || s === "perimeter_building" ? s : "each";
}

/**
 * How many units the fee is charged over.
 *
 * A flat fee is quantity ONE, not the building's size — that is the whole point of "each",
 * and returning area here would multiply a $500 call-out into $144,000 on a 12x24.
 */
export function bosQtyFor(basis: BosBasis, buildingArea: number, buildingPerimeter: number): number {
  if (basis === "sqft_building") return Number(buildingArea) || 0;
  if (basis === "perimeter_building") return Number(buildingPerimeter) || 0;
  return 1;
}

/** The unit suffix the customer reads beside the rate. A flat fee has no "per" anything. */
export function bosUnitSuffix(basis: BosBasis): string {
  if (basis === "sqft_building") return " / sq ft";
  if (basis === "perimeter_building") return " / ft";
  return "";
}

/**
 * Whether this increase actually produces a charge line.
 *
 * ⚠️ The two halves are deliberately different, and this is the crux of the feature. A flagged
 * increase with NO fee is a builder who absorbs the cost — Carolyn says builders always charge,
 * but that is her market, not a constraint — so the building is still BUILT ON SITE and simply
 * carries no line. That is why this returns false rather than throwing: an unpriced wall-height
 * INCREASE is a hard 400 (a builder must not sell an unpriced structural change at $0), but an
 * unpriced build-on-site fee is a legitimate configuration.
 */
export function bosCharges(buildOnSite: unknown, feeRate: unknown, qty: number): boolean {
  if (buildOnSite !== true) return false;
  if (feeRate == null) return false;
  const rate = Number(feeRate);
  return Number.isFinite(rate) && rate > 0 && qty > 0;
}
