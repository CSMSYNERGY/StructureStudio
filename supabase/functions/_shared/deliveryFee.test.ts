// The pure half of distance-priced delivery (2026-09-14). No I/O, no env, no stubs — every
// case here is arithmetic and validation, which is exactly why the money logic was split
// from the Google call: the cents can be pinned without a key.
//
// Only jsr:@std/assert is imported. The pre-push gate runs _shared/*.test.ts with NO import
// map, so any other jsr:/npm: import fails to resolve there.
import { assertEquals } from "jsr:@std/assert@1";

const {
  normalizeRules, feeFor, milesFromMeters, deliveryDesc, nearestOrigin, addressKey, addressLine,
} = await import("./deliveryFee.ts");

import type { DeliveryRules } from "./deliveryFee.ts";

/** A complete rule card of the given type; tests override what they are about. */
function rules(over: Partial<DeliveryRules> & { ruleType: DeliveryRules["ruleType"] }): DeliveryRules {
  return {
    flatFee: null, baseFee: null, perMile: null, freeMiles: null, perMileCounts: "beyond", bands: [],
    ...over,
  };
}

function mustNormalize(raw: unknown): DeliveryRules {
  const r = normalizeRules(raw);
  if (r.rules === null) throw new Error(`expected valid rules, got: ${r.error}`);
  return r.rules;
}

const errorOf = (raw: unknown): string | null => normalizeRules(raw).error;

// ── The four shapes ──────────────────────────────────────────────────────────────────────

Deno.test("flat: one price, distance ignored — miles may be null", () => {
  const r = rules({ ruleType: "flat", flatFee: 150 });
  assertEquals(feeFor(r, null, null), { amount: 150, autoPriced: true, reason: null, desc: "Delivery" });
  assertEquals(feeFor(r, 62, "Springfield lot"),
    { amount: 150, autoPriced: true, reason: null, desc: "Delivery — 62 miles from Springfield lot" });
});

Deno.test("flat with no fee is rule_incomplete, never $0", () => {
  const f = feeFor(rules({ ruleType: "flat" }), 10, "shop");
  assertEquals([f.amount, f.autoPriced, f.reason], [null, false, "rule_incomplete"]);
});

Deno.test("base_plus: base + per-mile × miles from mile one", () => {
  const r = rules({ ruleType: "base_plus", baseFee: 100, perMile: 3.5 });
  assertEquals(feeFor(r, 62, "Springfield lot"),
    { amount: 317, autoPriced: true, reason: null, desc: "Delivery — 62 miles from Springfield lot" });
  assertEquals(feeFor(r, 0, "shop").amount, 100);
});

Deno.test("base_plus needs both money fields and a distance, in that order", () => {
  assertEquals(feeFor(rules({ ruleType: "base_plus", baseFee: 100 }), 10, "shop").reason, "rule_incomplete");
  assertEquals(feeFor(rules({ ruleType: "base_plus", perMile: 3 }), 10, "shop").reason, "rule_incomplete");
  // Both missing: the rule is what the builder can fix, so it is reported first.
  assertEquals(feeFor(rules({ ruleType: "base_plus" }), null, null).reason, "rule_incomplete");
  const nd = feeFor(rules({ ruleType: "base_plus", baseFee: 100, perMile: 3 }), null, "shop");
  assertEquals([nd.amount, nd.autoPriced, nd.reason, nd.desc], [null, false, "no_distance", "Delivery"]);
});

Deno.test("free_radius: exactly N is free, N+1 is charged — perMileCounts 'beyond'", () => {
  const r = rules({ ruleType: "free_radius", freeMiles: 30, perMile: 4, perMileCounts: "beyond" });
  assertEquals(feeFor(r, 30, "shop"),
    { amount: 0, autoPriced: true, reason: null, desc: "Delivery — 30 miles from shop (free within 30 miles)" });
  assertEquals(feeFor(r, 31, "shop"),
    { amount: 4, autoPriced: true, reason: null, desc: "Delivery — 31 miles from shop" });
  assertEquals(feeFor(r, 0, "shop").amount, 0);
  assertEquals(feeFor(r, 62, "shop").amount, 128); // (62 − 30) × 4
});

Deno.test("free_radius: exactly N is free, N+1 charges EVERY mile — perMileCounts 'all'", () => {
  const r = rules({ ruleType: "free_radius", freeMiles: 30, perMile: 4, perMileCounts: "all" });
  assertEquals(feeFor(r, 30, "shop").amount, 0);
  assertEquals(feeFor(r, 30, "shop").desc, "Delivery — 30 miles from shop (free within 30 miles)");
  assertEquals(feeFor(r, 31, "shop").amount, 124); // 31 × 4
  assertEquals(feeFor(r, 62, "shop").amount, 248);
});

Deno.test("free_radius needs freeMiles, perMile and a distance", () => {
  assertEquals(feeFor(rules({ ruleType: "free_radius", perMile: 4 }), 10, "shop").reason, "rule_incomplete");
  assertEquals(feeFor(rules({ ruleType: "free_radius", freeMiles: 30 }), 10, "shop").reason, "rule_incomplete");
  assertEquals(feeFor(rules({ ruleType: "free_radius", freeMiles: 30, perMile: 4 }), null, "shop").reason, "no_distance");
});

const BANDS = [
  { minMiles: 0, maxMiles: 25, fee: 100 },
  { minMiles: 26, maxMiles: 50, fee: 175 },
];

Deno.test("bands: inclusive edges 25/26/50/51", () => {
  const r = rules({ ruleType: "bands", bands: BANDS });
  assertEquals(feeFor(r, 0, "shop").amount, 100);
  assertEquals(feeFor(r, 25, "shop").amount, 100);
  assertEquals(feeFor(r, 26, "shop").amount, 175);
  assertEquals(feeFor(r, 50, "shop").amount, 175);
  assertEquals(feeFor(r, 51, "shop"),
    { amount: null, autoPriced: false, reason: "beyond_last_band", desc: "Delivery — 51 miles from shop" });
  assertEquals(feeFor(r, 26, "Springfield lot").desc, "Delivery — 26 miles from Springfield lot");
});

Deno.test("bands: no bands is rule_incomplete; no distance is no_distance", () => {
  assertEquals(feeFor(rules({ ruleType: "bands", bands: [] }), 10, "shop").reason, "rule_incomplete");
  assertEquals(feeFor(rules({ ruleType: "bands", bands: BANDS }), null, "shop").reason, "no_distance");
});

Deno.test("amounts are rounded to cents once", () => {
  // 3 × 0.1 = 0.30000000000000004 in binary floating point.
  assertEquals(feeFor(rules({ ruleType: "base_plus", baseFee: 0, perMile: 0.1 }), 3, "shop").amount, 0.3);
  assertEquals(feeFor(rules({ ruleType: "base_plus", baseFee: 10.005, perMile: 0 }), 1, "shop").amount, 10.01);
  assertEquals(feeFor(rules({ ruleType: "free_radius", freeMiles: 10, perMile: 1.235 }), 11, "shop").amount, 1.24);
  assertEquals(feeFor(rules({ ruleType: "flat", flatFee: 99.999 }), null, null).amount, 100);
});

// ── normalizeRules ───────────────────────────────────────────────────────────────────────

Deno.test("a snake_case database row is accepted and canonicalised", () => {
  const r = mustNormalize({
    rule_type: "free_radius", flat_fee: null, base_fee: null, per_mile: "3.50", free_miles: "30",
    per_mile_counts: "all", bands: [],
  });
  assertEquals(r, {
    ruleType: "free_radius", flatFee: null, baseFee: null, perMile: 3.5, freeMiles: 30,
    perMileCounts: "all", bands: [],
  });
});

Deno.test("a camelCase portal payload is accepted too, and numeric strings are coerced", () => {
  const r = mustNormalize({ ruleType: "base_plus", baseFee: "100", perMile: "2.25" });
  assertEquals([r.baseFee, r.perMile, r.perMileCounts], [100, 2.25, "beyond"]);
  const b = mustNormalize({
    ruleType: "bands",
    bands: [{ minMiles: "0", maxMiles: "25", fee: "100" }, { min_miles: 26, max_miles: 50, fee: 175 }],
  });
  assertEquals(b.bands, BANDS);
});

Deno.test("a half-filled card saves — completeness is feeFor's job, not the validator's", () => {
  // A builder saving "bands" with automation off, before typing any amounts, must not be
  // refused on the money fields. (Bands themselves ARE required for a bands rule.)
  const r = mustNormalize({ ruleType: "base_plus" });
  assertEquals([r.baseFee, r.perMile], [null, null]);
  assertEquals(feeFor(r, 10, "shop").reason, "rule_incomplete");
});

Deno.test("empty and blank money fields stay null; they are not zero", () => {
  const r = mustNormalize({ ruleType: "flat", flatFee: "" });
  assertEquals(r.flatFee, null);
  assertEquals(mustNormalize({ ruleType: "flat", flatFee: 0 }).flatFee, 0);
});

Deno.test("an unknown rule type is refused", () => {
  assertEquals(errorOf({ ruleType: "per_hour" }), "rule type must be one of flat, base_plus, free_radius, bands");
  assertEquals(errorOf({}), "rule type must be one of flat, base_plus, free_radius, bands");
  assertEquals(errorOf(null), "delivery rules are missing");
  assertEquals(errorOf([]), "delivery rules are missing");
});

Deno.test("negative or non-numeric money is refused, naming the field", () => {
  assertEquals(errorOf({ ruleType: "flat", flatFee: -1 }), "flat fee cannot be negative");
  assertEquals(errorOf({ ruleType: "base_plus", baseFee: "-50" }), "base fee cannot be negative");
  assertEquals(errorOf({ ruleType: "base_plus", perMile: "lots" }), "per-mile rate must be a number");
  assertEquals(errorOf({ ruleType: "free_radius", freeMiles: -5 }), "free miles cannot be negative");
  assertEquals(errorOf({ ruleType: "free_radius", freeMiles: 2.5 }), "free miles must be a whole number of miles");
  assertEquals(errorOf({ ruleType: "flat", flatFee: Infinity }), "flat fee must be a number");
  assertEquals(errorOf({ ruleType: "flat", perMileCounts: "some" }), 'per-mile counting must be "beyond" or "all"');
});

Deno.test("bands: the table must be a list that starts at 0 with no holes or overlaps", () => {
  assertEquals(errorOf({ ruleType: "bands", bands: "0-25" }), "bands must be a list");
  assertEquals(errorOf({ ruleType: "bands", bands: [] }), "add at least one mileage band");
  assertEquals(errorOf({ ruleType: "bands", bands: null }), "add at least one mileage band");
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 1, maxMiles: 25, fee: 100 }] }),
    "the first band must start at 0 miles",
  );
  // A hole: 26 is unpriced.
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25, fee: 100 }, { minMiles: 27, maxMiles: 50, fee: 175 }] }),
    "bands must be contiguous: 0–25 is followed by 27–50",
  );
  // An overlap: 25 is priced twice.
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25, fee: 100 }, { minMiles: 25, maxMiles: 50, fee: 175 }] }),
    "bands must be contiguous: 0–25 is followed by 25–50",
  );
});

Deno.test("bands: each band's own numbers are checked", () => {
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25, fee: -100 }] }),
    "band 1 fee cannot be negative",
  );
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25.5, fee: 100 }] }),
    "band 1 maximum must be a whole number of miles",
  );
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25, fee: 100 }, { minMiles: 50, maxMiles: 26, fee: 175 }] }),
    "band 2: minimum is above its maximum",
  );
  assertEquals(
    errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25, fee: 100 }, { minMiles: -26, maxMiles: 50, fee: 175 }] }),
    "band 2 minimum cannot be negative",
  );
  assertEquals(errorOf({ ruleType: "bands", bands: [{ minMiles: 0, maxMiles: 25 }] }), "band 1 needs a fee");
  assertEquals(errorOf({ ruleType: "bands", bands: [{ fee: 5 }] }), "band 1 needs a minimum and a maximum");
  assertEquals(errorOf({ ruleType: "bands", bands: ["0-25"] }), "band 1 is not a band");
});

Deno.test("bands are sorted by minMiles on the way in", () => {
  const r = mustNormalize({ ruleType: "bands", bands: [BANDS[1], BANDS[0]] });
  assertEquals(r.bands, BANDS);
});

Deno.test("an empty band list is fine for every rule type except bands", () => {
  for (const ruleType of ["flat", "base_plus", "free_radius"]) {
    assertEquals(errorOf({ ruleType, bands: [] }), null, ruleType);
    assertEquals(errorOf({ ruleType }), null, ruleType);
  }
});

// ── Miles ────────────────────────────────────────────────────────────────────────────────

Deno.test("milesFromMeters rounds UP to whole miles", () => {
  assertEquals(milesFromMeters(0), 0);
  assertEquals(milesFromMeters(1), 1);
  assertEquals(milesFromMeters(1609.344), 1);
  assertEquals(milesFromMeters(1609.345), 2);
  assertEquals(milesFromMeters(99999), 63);
  assertEquals(milesFromMeters(NaN), 0);
  assertEquals(milesFromMeters(-500), 0);
  assertEquals(milesFromMeters(Infinity), 0);
});

// ── The description ──────────────────────────────────────────────────────────────────────

Deno.test("deliveryDesc — every shape, exactly", () => {
  assertEquals(deliveryDesc(62, "Springfield lot"), "Delivery — 62 miles from Springfield lot");
  assertEquals(deliveryDesc(62, null), "Delivery — 62 miles");
  assertEquals(deliveryDesc(null, "Springfield lot"), "Delivery");
  assertEquals(deliveryDesc(null, null), "Delivery");
  assertEquals(deliveryDesc(1, "shop"), "Delivery — 1 mile from shop");
  assertEquals(deliveryDesc(0, "shop"), "Delivery — 0 miles from shop");
  assertEquals(deliveryDesc(30, "shop", "free within 30 miles"), "Delivery — 30 miles from shop (free within 30 miles)");
  assertEquals(deliveryDesc(null, null, "quoted by hand"), "Delivery (quoted by hand)");
});

// ── nearestOrigin ────────────────────────────────────────────────────────────────────────

Deno.test("nearestOrigin: minimum non-null miles, first wins a tie, null when nothing resolved", () => {
  const a = { name: "a", miles: null }, b = { name: "b", miles: 40 }, c = { name: "c", miles: 12 }, d = { name: "d", miles: 12 };
  assertEquals(nearestOrigin([a, b, c, d]), c);
  assertEquals(nearestOrigin([d, c]), d);
  assertEquals(nearestOrigin([a]), null);
  assertEquals(nearestOrigin([]), null);
  assertEquals(nearestOrigin([{ miles: 0 }, { miles: 5 }]), { miles: 0 });
});

// ── Address helpers ──────────────────────────────────────────────────────────────────────

Deno.test("addressKey: case, trim and inner whitespace do not make a new key", () => {
  assertEquals(addressKey({ street: "100 Example Rd", city: "Macon", state: "GA", zip: "31201" }), "100 example rd|macon|ga|31201");
  assertEquals(
    addressKey({ street: "  100   EXAMPLE rd ", city: "macon ", state: " ga", zip: "31201" }),
    "100 example rd|macon|ga|31201",
  );
  assertEquals(addressKey({ city: "Macon", state: "GA" }), "|macon|ga|");
  assertEquals(addressKey({}), "|||");
  assertEquals(addressKey({ street: null, city: null, state: null, zip: null }), "|||");
});

Deno.test("addressLine: what Google is sent, blanks skipped, country pinned", () => {
  assertEquals(addressLine({ street: "100 Example Rd", city: "Macon", state: "GA", zip: "31201" }), "100 Example Rd, Macon, GA 31201, USA");
  assertEquals(addressLine({ street: null, city: "Macon", state: "GA", zip: "31201" }), "Macon, GA 31201, USA");
  assertEquals(addressLine({ street: null, city: "Macon", state: null, zip: "31201" }), "Macon, 31201, USA");
  assertEquals(addressLine({ street: null, city: "Macon", state: "GA", zip: null }), "Macon, GA, USA");
  assertEquals(addressLine({ street: " 100  Example Rd ", city: "Macon", state: "GA", zip: "31201" }), "100 Example Rd, Macon, GA 31201, USA");
  assertEquals(addressLine({}), "USA");
});
