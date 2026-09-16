// Unit tests for _shared/locationTax.ts — per-location tax rates and the decision a re-stamp of an
// issued quote makes before it writes (2026-09-17).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access — the same rule the other _shared tests follow.
//
// What is pinned here fails silently in production. A percent stored as a fraction's worth of
// percent (7.25 saved as 7.25, charged at 725%) is refused by the database and the builder sees
// "couldn't save"; the reverse (0.0725 typed and stored as 0.000725) is accepted and quotes at
// 0.07%. A blank that parses as 0 taxes nobody. A request that omitted the location clears it and
// re-prices the quote at the company rate. And a re-stamp that decides "the total moved" from a
// stale column re-emails a customer over nothing, while one that misses a real move changes the
// total under a customer who was never told.

const {
  isAgreedDesign, isVerifiedTax, locationTaxReady, locationTaxView, parseSaveLocationTax, parseSetSalesLocation,
  parseTaxLabel, parseTaxRatePct, ratePct, restampPlan, TAX_LABEL_MAX,
} = await import("./locationTax.ts");
const { designTotalCents } = await import("./estimateLines.ts");

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

const LOT = "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c";

// ── parseTaxRatePct: percent in, fraction out ───────────────────────────────────────────────

Deno.test("a percent is stored as a five-place fraction, from a number or a numeric string", () => {
  assertEquals(parseTaxRatePct(7.25), { ok: true, rate: 0.0725 });
  assertEquals(parseTaxRatePct("7.25"), { ok: true, rate: 0.0725 }, "a text box sends a string");
  assertEquals(parseTaxRatePct(" 8.875 "), { ok: true, rate: 0.08875 });
  assertEquals(parseTaxRatePct(7.123456), { ok: true, rate: 0.07123 }, "rounded to numeric(7,5), not truncated to a float");
  assertEquals(parseTaxRatePct(25), { ok: true, rate: 0.25 }, "the ceiling itself is allowed");
});

Deno.test("0 is a real rate and blank is no rate — they never collapse into each other", () => {
  assertEquals(parseTaxRatePct(0), { ok: true, rate: 0 });
  assertEquals(parseTaxRatePct("0"), { ok: true, rate: 0 });
  assertEquals(parseTaxRatePct("-0"), { ok: true, rate: 0 }, "a negative zero is folded to 0, not refused");
  assertEquals(parseTaxRatePct(""), { ok: true, rate: null });
  assertEquals(parseTaxRatePct("   "), { ok: true, rate: null });
  assertEquals(parseTaxRatePct(null), { ok: true, rate: null });
  assertEquals(parseTaxRatePct(undefined), { ok: true, rate: null });
});

Deno.test("out-of-range, non-numeric and non-scalar rates are refused, never coerced", () => {
  for (const bad of [-0.01, 25.001, 725, "abc", "7,25", NaN, Infinity, true, false, [7], { pct: 7 }]) {
    const r = parseTaxRatePct(bad);
    assert(!r.ok, `${JSON.stringify(bad)} must be refused`);
    if (!r.ok) assertEquals([r.status, r.reason], [400, "bad_rate"]);
  }
});

Deno.test("ratePct reads a stored fraction back as the percent that was typed", () => {
  for (const pct of [0, 4, 6.5, 7.25, 8.875, 9.999, 25]) {
    const parsed = parseTaxRatePct(pct);
    assert(parsed.ok);
    if (parsed.ok) assertEquals(ratePct(parsed.rate), pct, `round-trip of ${pct}`);
  }
  // Five places of a fraction are three of a percent: finer input rounds, once, at the save.
  const fine = parseTaxRatePct(9.99999);
  assert(fine.ok && ratePct(fine.rate) === 10, "9.99999% is stored as 0.1 and reads back as 10");
  assertEquals(ratePct("0.0725"), 7.25, "numeric arrives as a string from some drivers");
  assertEquals(ratePct(null), null);
  assertEquals(ratePct(""), null, "blank is not 0%");
  assertEquals(ratePct(7.25), null, "a percent-shaped stored value is not shown as 725%");
});

// ── labels ───────────────────────────────────────────────────────────────────────────────────

Deno.test("a label is trimmed and capped at the database's 40; blank means the company's", () => {
  assertEquals(parseTaxLabel("  County tax "), "County tax");
  assertEquals(parseTaxLabel(""), null);
  assertEquals(parseTaxLabel("   "), null);
  assertEquals(parseTaxLabel(null), null);
  assertEquals(parseTaxLabel("x".repeat(60))?.length, TAX_LABEL_MAX, "clipped, not refused — the CHECK is 40");
  assertEquals(parseTaxLabel(`${"x".repeat(39)} y`), "x".repeat(39), "no trailing space survives the clip");
});

// ── taxReady ─────────────────────────────────────────────────────────────────────────────────

Deno.test("taxReady needs a ZIP and a state stateCode() understands", () => {
  assert(locationTaxReady({ state: "GA", zip: "31201" }));
  assert(locationTaxReady({ state: "Ohio", zip: "44101" }), "a state NAME maps to its code");
  assert(locationTaxReady({ state: "oh", zip: "44101" }), "casing is not a different state");
  assert(!locationTaxReady({ state: "GA", zip: null }), "no ZIP");
  assert(!locationTaxReady({ state: "GA", zip: "  " }), "a blank ZIP is no ZIP");
  assert(!locationTaxReady({ state: null, zip: "31201" }), "no state");
  assert(!locationTaxReady({ state: "Georgia Peach", zip: "31201" }), "a state name nobody can map");
  assert(!locationTaxReady(null));
});

Deno.test("locationTaxView is the contract shape, with the rate as a percent", () => {
  assertEquals(
    locationTaxView({
      id: LOT, client_id: "acme", name: " Main lot ", city: "Macon", state: "GA", zip: "31201", active: true,
      tax_rate: "0.08", tax_label: null, street: "1 Main St",
    }),
    { id: LOT, name: "Main lot", city: "Macon", state: "GA", zip: "31201", active: true, taxRatePct: 8, taxLabel: null, taxReady: true },
  );
  const bare = locationTaxView({ id: LOT, name: "Lot", active: null, tax_rate: null });
  assertEquals([bare.active, bare.taxRatePct, bare.taxReady], [false, null, false], "unknown activity is not active");
});

// ── payloads ─────────────────────────────────────────────────────────────────────────────────

Deno.test("save_location_tax: rate required as a key, label optional, id must look like an id", () => {
  assertEquals(parseSaveLocationTax({ locationId: LOT, taxRatePct: "7.25" }), { ok: true, value: { locationId: LOT, rate: 0.0725 } },
    "no taxLabel key: the label is left alone (absent from the value, not null)");
  assertEquals(parseSaveLocationTax({ locationId: LOT, taxRatePct: "", taxLabel: "" }), { ok: true, value: { locationId: LOT, rate: null, label: null } },
    "blank rate and blank label both clear");
  assertEquals(parseSaveLocationTax({ locationId: LOT, taxRatePct: 6, taxLabel: " City tax " }),
    { ok: true, value: { locationId: LOT, rate: 0.06, label: "City tax" } });

  const noRate = parseSaveLocationTax({ locationId: LOT, taxLabel: "x" });
  assert(!noRate.ok && noRate.status === 400, "a request that forgot the rate must not read as 'clear my rate'");
  const badId = parseSaveLocationTax({ locationId: "7; drop table", taxRatePct: 7 });
  assert(!badId.ok && badId.status === 404 && badId.reason === "location_not_found", "a malformed id is simply not found");
  const noId = parseSaveLocationTax({ taxRatePct: 7 });
  assert(!noId.ok && noId.status === 404);
  const badRate = parseSaveLocationTax({ locationId: LOT, taxRatePct: 30 });
  assert(!badRate.ok && badRate.reason === "bad_rate");
  assert(!parseSaveLocationTax(null).ok);
});

Deno.test("set_design_sales_location: null clears, an omitted key does not, confirmResend must be literally true", () => {
  assertEquals(parseSetSalesLocation({ shortCode: " SS-ABC234 ", locationId: LOT }),
    { ok: true, value: { shortCode: "SS-ABC234", locationId: LOT, confirmResend: false } });
  assertEquals(parseSetSalesLocation({ shortCode: "SS-ABC234", locationId: null, confirmResend: true }),
    { ok: true, value: { shortCode: "SS-ABC234", locationId: null, confirmResend: true } });
  assertEquals(parseSetSalesLocation({ shortCode: "SS-ABC234", locationId: "" }).ok, true, "blank clears like null");
  for (const truthy of ["true", 1, "yes"]) {
    const r = parseSetSalesLocation({ shortCode: "SS-ABC234", locationId: LOT, confirmResend: truthy });
    assert(r.ok && r.value.confirmResend === false, `${JSON.stringify(truthy)} is not a confirmation to email a customer`);
  }

  const omitted = parseSetSalesLocation({ shortCode: "SS-ABC234" });
  assert(!omitted.ok && omitted.status === 400, "omitting locationId must not clear the location and re-price the quote");
  const noCode = parseSetSalesLocation({ locationId: LOT });
  assert(!noCode.ok && noCode.status === 400);
  const badId = parseSetSalesLocation({ shortCode: "SS-ABC234", locationId: "not-a-uuid" });
  assert(!badId.ok && badId.status === 404 && badId.reason === "location_not_found");
});

// ── agreement and verification ──────────────────────────────────────────────────────────────

Deno.test("an agreed design is accepted_at OR a rung at/after accepted — migration 197's two arms", () => {
  assert(isAgreedDesign({ accepted_at: "2026-09-01T00:00:00Z", status: "sent" }), "accepted_at alone: the ladder can be re-projected");
  for (const s of ["accepted", "invoiced", "delivered"]) assert(isAgreedDesign({ accepted_at: null, status: s }), s);
  for (const s of ["sent", "draft", "viewed", "", null]) assert(!isAgreedDesign({ accepted_at: null, status: s }), String(s));
  assert(!isAgreedDesign(null));
});

Deno.test("only a sane avalara rate counts as verified", () => {
  assert(isVerifiedTax({ source: "avalara", rate: 0.0825 }));
  assert(isVerifiedTax({ source: "avalara", rate: 0 }), "a verified 0% is still verified");
  assert(!isVerifiedTax({ source: "fallback", rate: 0.0825, basis: "location" }));
  assert(!isVerifiedTax({ source: "avalara", rate: 8.25 }), "a percent-shaped rate is not a verified one");
  assert(!isVerifiedTax({ source: "avalara", rate: null }));
  assert(!isVerifiedTax(null));
});

// ── restampPlan ──────────────────────────────────────────────────────────────────────────────

// Taxable base 10,000; delivery 500 is not taxable. At 7.25% the total is 11,225.00.
const LINES = [
  { kind: "building", itemKey: "", name: "Barn", desc: "", qty: 1, amount: 10000, nonTaxable: false },
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "", qty: 1, amount: 500, nonTaxable: true },
];
const taxAt = (rate: number, extra: Record<string, unknown> = {}) => ({
  rate, amount: Math.round(10000 * rate * 100) / 100, label: "Sales tax",
  taxableSubtotal: 10000, nonTaxableSubtotal: 500, taxableBase: 10000, nonTaxableNet: 500,
  source: "fallback", jurisdiction: null, address: { state: "GA", zip: "31201" }, resolvedAt: "2026-09-17T08:00:00Z",
  basis: "company", locationId: null, locationName: null, verifiedAt: null, ...extra,
});
const quote = (rate = 0.0725) => ({ version: 1, styleId: "s1", discount: 0, lines: LINES, tax: taxAt(rate) });

Deno.test("restampPlan: a moved total on an unsent quote is written with no re-send", () => {
  const plan = restampPlan({ snap: quote(), tax: taxAt(0.08, { basis: "location", locationId: LOT }), sent: false, confirmResend: false });
  assert(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return;
  assertEquals([plan.previousTotalCents, plan.totalCents, plan.changed, plan.resend], [1122500, 1130000, true, false]);
  assertEquals(plan.totalCents, designTotalCents(plan.snap), "the total written is the snapshot's own total");
  assertEquals((plan.snap.tax as Record<string, unknown>).locationId, LOT);
  assertEquals([plan.snap.version, plan.snap.styleId, plan.snap.lines], [1, "s1", LINES], "every other key is kept");
});

Deno.test("restampPlan: an emailed quote whose total moves needs confirmResend, then re-sends", () => {
  const refused = restampPlan({ snap: quote(), tax: taxAt(0.08), sent: true, confirmResend: false });
  assertEquals(refused, { ok: false, reason: "quote_sent", previousTotalCents: 1122500, totalCents: 1130000 });

  const confirmed = restampPlan({ snap: quote(), tax: taxAt(0.08), sent: true, confirmResend: true });
  assert(confirmed.ok && confirmed.resend && confirmed.changed, "confirmed: written AND sent again");
});

Deno.test("restampPlan: the same total on an emailed quote asks nothing and sends nothing", () => {
  // A different basis/label at the same rate — the document's words move, the money does not.
  const plan = restampPlan({ snap: quote(), tax: taxAt(0.0725, { basis: "location", locationId: LOT, label: "County tax" }), sent: true, confirmResend: false });
  assert(plan.ok && !plan.changed && !plan.resend, JSON.stringify(plan));
  const confirmed = restampPlan({ snap: quote(), tax: taxAt(0.0725), sent: true, confirmResend: true });
  assert(confirmed.ok && !confirmed.resend, "confirming does not make an unchanged quote worth re-emailing");
});

Deno.test("restampPlan: 'did the total move' comes from the snapshot, never a stale stored column", () => {
  // The input is the snapshot alone; a row whose total_cents lags it cannot reach this decision.
  const plan = restampPlan({ snap: { ...quote(), total_cents: 1 }, tax: taxAt(0.0725), sent: true, confirmResend: false });
  assert(plan.ok && plan.previousTotalCents === 1122500 && !plan.changed);
});

Deno.test("restampPlan: no issued quote means nothing to re-price", () => {
  const noTax = { version: 1, discount: 0, lines: LINES };
  for (const snap of [null, undefined, "x", {}, noTax, { ...noTax, tax: null }, { tax: taxAt(0.0725) }]) {
    assertEquals(restampPlan({ snap, tax: taxAt(0.08), sent: false, confirmResend: true }), { ok: false, reason: "no_quote" },
      JSON.stringify(snap));
  }
});
