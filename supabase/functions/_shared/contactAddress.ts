// The delivery address a customer typed into the designer, read out of `designs.contact`.
//
// WHY THIS IS SHARED AND TESTED rather than a local helper: `contact` is a jsonb blob with
// no schema, written by the designer over three years, so its keys are a small history
// lesson — `street`/`zip` today, `address`/`postalCode` on older rows. A silent miss here
// does not throw; it produces a delivery stop with no destination, which is exactly the
// state every stop in production was in until 2026-08-07 (add_stop never read these at
// all). A wrong answer is invisible, so it gets a test.

// deno-lint-ignore no-explicit-any
const s = (v: any): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface StopAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

// deno-lint-ignore no-explicit-any
export function addressFrom(contact: any): StopAddress {
  const c = contact ?? {};
  return {
    street: s(c.street) ?? s(c.address),
    city: s(c.city),
    state: s(c.state),
    zip: s(c.zip) ?? s(c.postalCode),
  };
}

/** Is there enough here to place a stop on a map or in a territory? */
export function hasDestination(a: StopAddress): boolean {
  return !!(a.city || a.zip);
}

/**
 * The territory a destination falls in, from where this tenant has already delivered.
 * Zip beats city: two towns share a name far more often than a postcode.
 *
 * v1 rule from SCHEDULING_SCOPE.md — geocoding replaces it later without a schema change.
 */
export function territoryFor(
  a: StopAddress,
  byZip: Record<string, string>,
  byCity: Record<string, string>,
): string | null {
  if (a.zip && byZip[a.zip]) return byZip[a.zip];
  if (a.city) {
    const k = a.city.trim().toLowerCase();
    if (byCity[k]) return byCity[k];
  }
  return null;
}
