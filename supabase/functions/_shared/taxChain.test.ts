// Unit tests for _shared/taxChain.ts — the free default tax rate and the carry-over of a verified
// one (2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// Every failure worth pinning here is silent. A home lot that replaces a location staff chose, a
// verified rate a shopper can shed by editing their ZIP, a carried tax whose pools still describe
// the old lines, a stamp that drops a field an old reader needs — none of them throws, and each
// one is a customer holding a total the builder did not intend. And the one that costs money
// outright: an automatic re-stamp that reaches the network.

// Junk credentials BEFORE the import, so the "no call" cases below prove the switch, not a
// missing key. The base URL is a reserved .test host: a stub that failed to install still could
// not reach anyone.
Deno.env.set("AVALARA_ACCOUNT_ID", "test-account");
Deno.env.set("AVALARA_LICENSE_KEY", "test-key");
Deno.env.set("AVALARA_API_BASE", "https://avatax.test");

const { resolveRate, taxOn } = await import("./salesTax.ts");
const {
  ADDRESS_CHANGED, agreedTax, carriedTax, carryDecision, chooseDefaultRate, homeLotApplies, sameTaxAddress, stampTax,
  taxLocationFrom,
} = await import("./taxChain.ts");

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const TENANT = "acme";
const LOT_A = "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c";
const LOT_HOME = "0b6f7c1d-2e3a-4b5c-8d9e-0f1a2b3c4d5e";

const row = (over: Record<string, unknown> = {}) => ({
  id: LOT_A, client_id: TENANT, name: "Main lot", active: true, tax_rate: 0.0825, tax_label: "County tax", ...over,
});
const lot = (over: Record<string, unknown> = {}) => taxLocationFrom(row(over), TENANT);
const home = (over: Record<string, unknown> = {}) => taxLocationFrom(row({ id: LOT_HOME, name: "Home lot", tax_rate: 0.09, tax_label: null, ...over }), TENANT);

// ── taxLocationFrom: which rows may price this tenant's quote ─────────────────────────────

Deno.test("taxLocationFrom keeps this tenant's active lot, with its rate as a sane fraction", () => {
  assertEquals(lot(), { id: LOT_A, name: "Main lot", rate: 0.0825, label: "County tax" });
  assertEquals(lot({ tax_rate: "0.0725" })?.rate, 0.0725, "numeric arrives as a string from some drivers");
  assertEquals(lot({ tax_rate: 0 })?.rate, 0, "0% is a real answer, not a missing one");
});

Deno.test("taxLocationFrom refuses another tenant's lot, an inactive lot and a non-row", () => {
  assertEquals(lot({ client_id: "someone-else" }), null, "another tenant's location never prices this quote");
  assertEquals(lot({ active: false }), null, "an inactive location is not a sales location");
  assertEquals(lot({ active: null }), null, "unknown activity is not active");
  assertEquals(lot({ id: "" }), null);
  assertEquals(taxLocationFrom(null, TENANT), null);
  assertEquals(taxLocationFrom(row(), ""), null, "no tenant to match against means no match");
});

Deno.test("taxLocationFrom keeps a location with NO rate, so it still counts as the quote's location", () => {
  assertEquals(lot({ tax_rate: null }), { id: LOT_A, name: "Main lot", rate: null, label: "County tax" });
  assertEquals(lot({ tax_rate: 7.25 })?.rate, null, "a percent-shaped rate is refused, never charged at 725%");
  assertEquals(lot({ tax_rate: "" })?.rate, null, "blank is not 0%");
});

// ── chooseDefaultRate: links 2-4 ───────────────────────────────────────────────────────────

const choose = (over: Partial<Parameters<typeof chooseDefaultRate>[0]> = {}) =>
  chooseDefaultRate({ salesLocationId: null, location: null, homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax", ...over });

Deno.test("the quote's own location rate wins, under the location's label", () => {
  assertEquals(choose({ salesLocationId: LOT_A, location: lot(), homeLot: home() }), {
    rate: 0.0825, basis: "location", label: "County tax", locationId: LOT_A, locationName: "Main lot", recordLocationId: null,
  });
  assertEquals(choose({ salesLocationId: LOT_A, location: lot({ tax_label: null }) })?.label, "Sales tax",
    "a location with no label of its own uses the company's");
  assertEquals(choose({ salesLocationId: LOT_A, location: lot({ tax_rate: 0 }) })?.rate, 0, "a 0% location is honoured");
});

Deno.test("a quote WITH a location never borrows a staff member's home lot", () => {
  // The location has no rate, was deactivated, or its row was not found: the quote still has a
  // location somebody chose, so the home lot must not replace it — company rate, nothing recorded.
  for (const location of [lot({ tax_rate: null }), null]) {
    const got = choose({ salesLocationId: LOT_A, location, homeLot: home() });
    assertEquals(got, { rate: 0.0725, basis: "company", label: "Sales tax", locationId: null, locationName: null, recordLocationId: null });
  }
  const mismatched = choose({ salesLocationId: LOT_A, location: home(), homeLot: null });
  assertEquals(mismatched?.basis, "company", "a row that is not the design's location is not its rate");
});

Deno.test("no location + a home lot with a rate: that rate, and the lot is recorded", () => {
  assertEquals(choose({ homeLot: home() }), {
    rate: 0.09, basis: "location", label: "Sales tax", locationId: LOT_HOME, locationName: "Home lot", recordLocationId: LOT_HOME,
  });
});

Deno.test("a home lot with no usable rate is neither used nor recorded", () => {
  for (const homeLot of [home({ tax_rate: null }), { id: LOT_HOME, name: "Hand-built", rate: 7.25, label: null }]) {
    const got = choose({ homeLot });
    assertEquals(got?.basis, "company");
    assertEquals(got?.recordLocationId, null, "recording a rateless lot would move later resubmits for no reason");
  }
});

Deno.test("the company rate is the last link; with none, there is no default and the caller refuses", () => {
  assertEquals(choose(), { rate: 0.0725, basis: "company", label: "Sales tax", locationId: null, locationName: null, recordLocationId: null });
  assertEquals(choose({ companyRate: 0 })?.rate, 0, "an explicit 0% company rate is a rate");
  for (const companyRate of [null, undefined, "", 7.25, "abc"]) {
    assertEquals(choose({ companyRate }), null, `company rate ${JSON.stringify(companyRate)} must not become 0%`);
  }
  assertEquals(choose({ companyLabel: "  " })?.label, "Sales tax");
});

// ── homeLotApplies: link 3 is a first-issue rule ─────────────────────────────────────────────

const USER = "7c1d0b6f-2e3a-4b5c-8d9e-0f1a2b3c4d5e";
const homeInput = (over: Partial<Parameters<typeof homeLotApplies>[0]> = {}) =>
  ({ salesLocationId: null, staffCaller: true, callerUserId: USER, firstIssue: true, signed: false, ...over });

Deno.test("homeLotApplies: only a signed-in staff member's FIRST issue of a quote with no location", () => {
  assert(homeLotApplies(homeInput()), "the first issue by staff, no location");
  assert(!homeLotApplies(homeInput({ firstIssue: false })), "a resubmit never borrows the home lot");
  assert(!homeLotApplies(homeInput({ salesLocationId: LOT_A })), "a quote with a location keeps it");
  assert(!homeLotApplies(homeInput({ staffCaller: false })), "a shopper has no home lot");
  assert(!homeLotApplies(homeInput({ callerUserId: null })) && !homeLotApplies(homeInput({ callerUserId: "  " })), "no user, no lot");
  assert(!homeLotApplies(homeInput({ signed: true })), "a signed order is never re-homed");
});

Deno.test("a CLEARED location + a staff resubmit stays at the company rate and records no location", () => {
  // Staff cleared the quote's location (set_design_sales_location with null, or the lot was
  // deleted), then pressed Submit again. The quote already has a number, so it is not a first
  // issue: the home lot is not read, the company rate applies, and nothing is recorded.
  const salesLocationId = null;
  const homeLot = homeLotApplies(homeInput({ salesLocationId, firstIssue: false })) ? home() : null;
  const got = choose({ salesLocationId, location: null, homeLot });
  assertEquals(got, { rate: 0.0725, basis: "company", label: "Sales tax", locationId: null, locationName: null, recordLocationId: null });

  // The same quote on its FIRST issue would have taken the home lot and recorded it.
  const first = choose({ homeLot: homeLotApplies(homeInput()) ? home() : null });
  assertEquals([first?.basis, first?.recordLocationId], ["location", LOT_HOME]);
});

Deno.test("a location rate still prices the quote when the company rate is missing", () => {
  assertEquals(choose({ companyRate: null, salesLocationId: LOT_A, location: lot() })?.rate, 0.0825);
  assertEquals(choose({ companyRate: null, homeLot: home() })?.rate, 0.09);
});

// ── carryDecision: when a verified rate survives ───────────────────────────────────────────

const VERIFIED = {
  rate: 0.0825, amount: 902.63, label: "Sales tax", source: "avalara", jurisdiction: "Bibb County, GA",
  address: { state: "Georgia", zip: "31201-4410" }, resolvedAt: "2026-09-10T12:00:00Z",
};

Deno.test("sameTaxAddress compares through stateCode and five ZIP digits, and blank is never a match", () => {
  assert(sameTaxAddress({ state: "Georgia", zip: "31201-4410" }, { state: "ga", zip: " 31201 " }));
  assert(sameTaxAddress({ state: "Oh", zip: "43004" }, { state: "OH", zip: "43004" }), "casing alone must not invalidate a paid rate");
  assert(!sameTaxAddress({ state: "GA", zip: "31201" }, { state: "GA", zip: "31204" }));
  assert(!sameTaxAddress({ state: "GA", zip: "31201" }, { state: "AL", zip: "31201" }));
  assert(!sameTaxAddress({ state: "", zip: "" }, { state: "", zip: "" }), "two empty addresses are not the same place");
  assert(!sameTaxAddress({ state: "Atlantis", zip: "00000" }, { state: "Atlantis", zip: "00000" }));
  assert(!sameTaxAddress(null, { state: "GA", zip: "31201" }));
});

Deno.test("only a verified rate is ever carried", () => {
  const moved = { state: "GA", zip: "31201" };
  for (const storedTax of [null, undefined, { ...VERIFIED, source: "fallback" }, { ...VERIFIED, rate: 8.25 }, { ...VERIFIED, rate: null }]) {
    for (const staffCaller of [true, false]) {
      assertEquals(carryDecision({ staffCaller, storedTax, address: moved }), { carry: false, reason: null },
        `stored ${JSON.stringify(storedTax)} must run the chain, with no re-verify reason`);
    }
  }
});

Deno.test("a SHOPPER's resubmit always carries the verified rate — they control the address", () => {
  for (const address of [{ state: "Alabama", zip: "35203" }, { state: null, zip: null }, { state: "GA", zip: "31201" }]) {
    assertEquals(carryDecision({ staffCaller: false, storedTax: VERIFIED, address }), { carry: true });
  }
});

Deno.test("a STAFF resubmit carries while state + ZIP match, and says why when they do not", () => {
  assertEquals(carryDecision({ staffCaller: true, storedTax: VERIFIED, address: { state: "GA", zip: "31201" } }), { carry: true });
  assertEquals(carryDecision({ staffCaller: true, storedTax: VERIFIED, address: { state: "GA", zip: "31204" } }),
    { carry: false, reason: ADDRESS_CHANGED });
  assertEquals(carryDecision({ staffCaller: true, storedTax: VERIFIED, address: { state: "AL", zip: "31201" } }),
    { carry: false, reason: ADDRESS_CHANGED });
  assertEquals(carryDecision({ staffCaller: true, storedTax: { ...VERIFIED, address: undefined }, address: { state: "GA", zip: "31201" } }),
    { carry: false, reason: ADDRESS_CHANGED }, "a verified stamp with no address cannot be confirmed as the same place");
});

// ── agreedTax: a signed order carries whatever rate it was agreed at ───────────────────────

const LOCATION_AGREED = {
  rate: 0.0825, amount: 902.63, label: "County tax", taxableSubtotal: 10941, nonTaxableSubtotal: 0,
  taxableBase: 10941, nonTaxableNet: 0, source: "fallback", jurisdiction: null, address: { state: "GA", zip: "31201" },
  resolvedAt: "2026-09-12T09:00:00Z", reason: "not requested", basis: "location", locationId: LOT_A, locationName: "Main lot",
  verifiedAt: null,
};

Deno.test("agreedTax: nobody signed it — no agreed tax, the chain runs", () => {
  assertEquals(agreedTax({ accepted_at: null, accepted_snapshot: null, estimate_lines: { tax: LOCATION_AGREED } }), null);
  assertEquals(agreedTax(null), null);
  assertEquals(agreedTax({}), null);
});

Deno.test("agreedTax: a signed order's agreement is the accepted snapshot's tax, whatever its basis", () => {
  const revised = { ...LOCATION_AGREED, rate: 0.0725, basis: "company", locationId: null, locationName: null };
  for (const tax of [LOCATION_AGREED, VERIFIED, { ...LOCATION_AGREED, basis: "company", locationId: null, locationName: null, rate: 0 }]) {
    assertEquals(agreedTax({ accepted_at: "2026-09-13T00:00:00Z", accepted_snapshot: { estimateLines: { tax } }, estimate_lines: { tax: revised } }), tax,
      `the agreement wins over the live revision (${tax.rate})`);
  }
  assertEquals(agreedTax({ accepted_at: null, accepted_snapshot: { estimateLines: { tax: LOCATION_AGREED } }, estimate_lines: null }),
    LOCATION_AGREED, "an accepted snapshot is agreement even where accepted_at reads null (a promote that failed)");
});

Deno.test("agreedTax: signed before accepted_snapshot existed — the design's own stamped tax; none usable — null", () => {
  assertEquals(agreedTax({ accepted_at: "2026-08-01T00:00:00Z", accepted_snapshot: null, estimate_lines: { tax: LOCATION_AGREED } }), LOCATION_AGREED);
  assertEquals(agreedTax({ accepted_at: "2026-08-01T00:00:00Z", accepted_snapshot: { estimateLines: { lines: [] } }, estimate_lines: { lines: [] } }), null,
    "a pre-tax agreement has nothing to carry");
  assertEquals(agreedTax({ accepted_at: "2026-08-01T00:00:00Z", accepted_snapshot: { estimateLines: { tax: { rate: 8.25 } } }, estimate_lines: null }), null,
    "a percent-shaped rate is not a rate to carry");
});

// ── carriedTax / stampTax: the object on the snapshot ─────────────────────────────────────

const POOLS = { taxable: 12450, nonTaxable: 600, taxableBase: 12450, nonTaxableNet: 600 };

Deno.test("carriedTax keeps the verified answer verbatim and recomputes only what the lines decide", () => {
  const stored = { ...VERIFIED, taxableSubtotal: 1, nonTaxableSubtotal: 2, taxableBase: 3, nonTaxableNet: 4 };
  const before = JSON.stringify(stored);
  const got = carriedTax(stored, POOLS);
  assertEquals(JSON.stringify(stored), before, "the stored object is not mutated");
  for (const k of ["rate", "label", "source", "jurisdiction", "address", "resolvedAt"]) {
    assertEquals(got[k], (stored as Record<string, unknown>)[k], `${k} is carried verbatim`);
  }
  assertEquals(got.amount, taxOn(12450, 0.0825), "the amount follows the new taxable base at the carried rate");
  assertEquals([got.taxableSubtotal, got.nonTaxableSubtotal, got.taxableBase, got.nonTaxableNet], [12450, 600, 12450, 600],
    "the pools follow the new lines — the PDF prints its Total from them");
  assertEquals([got.basis, got.locationId, got.locationName, got.verifiedAt], ["avalara", null, null, "2026-09-10T12:00:00Z"],
    "a stamp from before the chain gains its basis, and its lookup time as verifiedAt");
  assertEquals(carriedTax({ ...VERIFIED, verifiedAt: "2026-09-11T09:00:00Z" }, POOLS).verifiedAt, "2026-09-11T09:00:00Z");
});

Deno.test("carriedTax carries an agreed LOCATION or company rate verbatim too — basis, location and all", () => {
  const got = carriedTax(LOCATION_AGREED, POOLS);
  for (const k of ["rate", "label", "source", "jurisdiction", "address", "resolvedAt", "reason", "basis", "locationId", "locationName"]) {
    assertEquals(got[k], (LOCATION_AGREED as Record<string, unknown>)[k], `${k} is carried verbatim`);
  }
  assertEquals([got.amount, got.taxableBase, got.verifiedAt], [taxOn(12450, 0.0825), 12450, null], "the money follows the new lines; a default is never 'verified'");

  const legacy: Record<string, unknown> = { ...LOCATION_AGREED, rate: 0.0725 };
  for (const k of ["basis", "locationId", "locationName", "verifiedAt"]) delete legacy[k];
  const old = carriedTax(legacy, POOLS);
  assertEquals([old.basis, old.locationId, old.locationName, old.verifiedAt], ["company", null, null, null],
    "a default stamped before the chain was the company rate");
});

const NOW = "2026-09-17T08:00:00.000Z";
const ADDR = { state: "GA", zip: "31201" };

Deno.test("stampTax keeps every field the old stamp carried, then adds the four", () => {
  const choice = chooseDefaultRate({ salesLocationId: LOT_A, location: lot(), homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax" })!;
  const resolved = { rate: 0.0825, source: "fallback" as const, jurisdiction: null, reason: "not requested" };
  const got = stampTax({ pools: POOLS, resolved, choice, address: ADDR, now: NOW });
  assertEquals(Object.keys(got), [
    "rate", "amount", "label", "taxableSubtotal", "nonTaxableSubtotal", "taxableBase", "nonTaxableNet",
    "source", "jurisdiction", "address", "resolvedAt", "reason",
    "basis", "locationId", "locationName", "verifiedAt",
  ]);
  assertEquals(got, {
    rate: 0.0825, amount: 1027.13, label: "County tax",
    taxableSubtotal: 12450, nonTaxableSubtotal: 600, taxableBase: 12450, nonTaxableNet: 600,
    source: "fallback", jurisdiction: null, address: ADDR, resolvedAt: NOW, reason: "not requested",
    basis: "location", locationId: LOT_A, locationName: "Main lot", verifiedAt: null,
  });
});

Deno.test("stampTax: the re-verify reason overrides, and a company default names no location", () => {
  const choice = chooseDefaultRate({ salesLocationId: null, location: null, homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax" })!;
  const resolved = { rate: 0.0725, source: "fallback" as const, jurisdiction: null, reason: "not requested" };
  const got = stampTax({ pools: POOLS, resolved, choice, address: ADDR, reason: ADDRESS_CHANGED, now: NOW });
  assertEquals([got.reason, got.basis, got.locationId, got.locationName, got.amount], [ADDRESS_CHANGED, "company", null, null, 902.63],
    "12450 x 7.25% is 902.63 — taxOn's cent-scaling, not the float round that gives 902.62");
  const quiet = stampTax({ pools: POOLS, resolved: { ...resolved, reason: null }, choice, address: ADDR, now: NOW });
  assert(!("reason" in quiet), "no reason, no key — as before");
});

Deno.test("stampTax: a rate that really came from Avalara is basis avalara, verified now, at no location", () => {
  const choice = chooseDefaultRate({ salesLocationId: LOT_A, location: lot(), homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax" })!;
  const resolved = { rate: 0.08, source: "avalara" as const, jurisdiction: "Bibb County, GA", reason: null };
  const got = stampTax({ pools: POOLS, resolved, choice, address: ADDR, now: NOW });
  assertEquals([got.source, got.basis, got.verifiedAt, got.locationId, got.locationName, got.jurisdiction],
    ["avalara", "avalara", NOW, null, null, "Bibb County, GA"]);
});

// ── The automatic re-stamp never reaches the network ─────────────────────────────────────

/** The chain as submit-estimate runs it: carry, else default → resolveRate(allowLookup false) → stamp. */
async function restamp(staffCaller: boolean, storedTax: unknown, address: { state: string | null; zip: string | null }) {
  const carry = carryDecision({ staffCaller, storedTax, address });
  if (carry.carry) return carriedTax(storedTax as Record<string, unknown>, POOLS);
  const choice = chooseDefaultRate({ salesLocationId: LOT_A, location: lot(), homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax" })!;
  const addr = { street: "1 Main St", city: "Macon", ...address };
  const resolved = await resolveRate(addr, choice.rate, { allowLookup: false });
  return stampTax({ pools: POOLS, resolved, choice, address, reason: carry.reason, now: NOW });
}

Deno.test("no re-stamp — carried, invalidated or defaulted — makes a request, with credentials present", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  try {
    const carried = await restamp(false, VERIFIED, { state: "AL", zip: "35203" });
    assertEquals([carried.source, carried.rate, carried.basis], ["avalara", 0.0825, "avalara"]);

    const invalidated = await restamp(true, VERIFIED, { state: "GA", zip: "31204" });
    assertEquals([invalidated.source, invalidated.basis, invalidated.rate, invalidated.reason],
      ["fallback", "location", 0.0825, ADDRESS_CHANGED], "a moved address falls to the location rate, visibly");

    const fresh = await restamp(true, null, { state: "GA", zip: "31201" });
    assertEquals([fresh.source, fresh.basis, fresh.reason], ["fallback", "location", "not requested"]);
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(calls, 0, "an automatic re-stamp reached the network — that is a billed call nobody chose");
});
