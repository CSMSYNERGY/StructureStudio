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

// ALL SEVEN pricing methods since migration 228 (Carolyn 2026-09-14: "All these but each is
// flat rate") — the same vocabulary layout items and cladding already price by, so every one
// of them has geometry or a base price in submit-estimate. It was three until then.
export const BOS_BASES = [
  "each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building",
  "pct_building_price", "pct_estimate_total",
] as const;
export type BosBasis = typeof BOS_BASES[number];

/** NULL/unknown reads as a flat fee, matching the column comment on `bos_fee_basis`. */
export function bosBasisOf(raw: unknown): BosBasis {
  const s = String(raw ?? "").trim();
  return (BOS_BASES as readonly string[]).includes(s) ? (s as BosBasis) : "each";
}

/**
 * How many units the fee is charged over.
 *
 * A flat fee is quantity ONE, not the building's size — that is the whole point of "each",
 * and returning area here would multiply a $500 call-out into $144,000 on a 12x24.
 *
 * `explicitQty` (foundation items, Carolyn 2026-09-14): the three OPTION-shaped bases — each,
 * lineal_ft, sqft_option — name a quantity the building cannot always supply. For a
 * build-on-site fee it can: the fee is a whole-building option, so "each" is one call-out,
 * "lineal ft" is the perimeter and "option sq ft" is the wall area, and whole-building callers
 * pass nothing and keep exactly that reading. A Foundation item is different — "each" is the
 * NUMBER OF PIERS, "lineal ft" is the FENCE the crew tears out, "option sq ft" is the PAD or
 * SLAB — quantities only the customer knows, which the Foundation card collects (gravel pad,
 * fence removal, piers, concrete slab). A caller holding one passes it here and it wins.
 * Anything that is not a finite number above zero falls back to the whole-building reading,
 * so a blank or junk field can never zero a line or multiply it by NaN — validation of the
 * customer's typing belongs to foundationQtyFor, not here. The four whole-building bases
 * (sqft_building, perimeter_building and both percentages) IGNORE it on purpose: their
 * quantity is a fact about the building, and honouring an override there would let one line
 * describe a different building from the rest of the estimate.
 */
export function bosQtyFor(
  basis: BosBasis,
  buildingArea: number,
  buildingPerimeter: number,
  wallArea = 0,
  explicitQty: number | null = null,
): number {
  if (
    (basis === "each" || basis === "lineal_ft" || basis === "sqft_option") &&
    typeof explicitQty === "number" && Number.isFinite(explicitQty) && explicitQty > 0
  ) {
    return explicitQty;
  }
  if (basis === "sqft_building") return Number(buildingArea) || 0;
  // A wall-height fee is a whole-building option, so it reads like cladding: "option area" is
  // the WALL area (perimeter x the wall height actually billed) and "lineal ft" is the
  // perimeter — identical to perimeter_building on purpose, both names are in the vocabulary.
  if (basis === "sqft_option") return Number(wallArea) || 0;
  if (basis === "perimeter_building" || basis === "lineal_ft") return Number(buildingPerimeter) || 0;
  return 1;   // each, and both percentages: the rate is not a per-unit price
}

/** The unit suffix the customer reads beside the rate. A flat fee has no "per" anything. */
export function bosUnitSuffix(basis: BosBasis): string {
  if (basis === "sqft_building") return " / sq ft";
  if (basis === "sqft_option") return " / sq ft of wall";
  if (basis === "perimeter_building" || basis === "lineal_ft") return " / ft";
  return "";
}

/** True for the two percentage bases, whose "rate" is a percent rather than dollars. */
export function bosIsPct(basis: BosBasis): boolean {
  return basis === "pct_building_price" || basis === "pct_estimate_total";
}

/**
 * The per-unit amount that goes on the line. pct_building_price resolves here because the
 * base price is already known; pct_estimate_total CANNOT — it is a share of every OTHER line —
 * so it goes out at 0 and the caller registers the line for submit-estimate's step 7a pass,
 * exactly as cladding and layout add-ons do. Everything else is the rate as typed.
 */
export function bosAmountFor(basis: BosBasis, rate: number, buildingPrice: number): number {
  const r = Number(rate) || 0;
  if (basis === "pct_building_price") return (r / 100) * (Number(buildingPrice) || 0);
  if (basis === "pct_estimate_total") return 0;
  return r;
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
