// Unit tests for _shared/companyTax.ts — the company sales tax rate and the "Use tax codes" switch
// (Settings → Company → Tax, 2026-10-09).
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine with
// no registry access — the same rule the other _shared tests follow.
//
// THE PARITY TABLE IS THE POINT. parseCompanyTax is the parser that lived inline in portal-settings'
// `save` until 2026-10-09, moved out so save_company_tax reads a rate the same way. `save` is what
// production's Estimates & Invoices card posts to, and production gets the moved parser the moment
// portal-settings deploys, with no switch in front of it. OLD_INLINE below is a FROZEN COPY of the
// block as it stood at origin/beta d118eb2e (portal-settings/index.ts, the `save` action), changed
// only to return instead of writing to `updates` and answering json(). Never edit it to make a
// failing row pass: a failure means production's save now reads some input differently.

const {
  BAD_RATE, companyTaxNeedsRow, companyTaxRefusal, companyTaxView, parseCodesSwitch, parseCompanyTax, RATE_FIRST, RATE_REQUIRED,
} = await import("./companyTax.ts");

const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};
const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};

// ── THE FROZEN COPY (origin/beta d118eb2e, portal-settings `save`) ───────────────────────────────
// deno-lint-ignore no-explicit-any
function OLD_INLINE(payload: any): { updates: Record<string, unknown> } | { error: string; status: number } {
  const updates: Record<string, unknown> = {};
  // The sales tax rate, entered as a PERCENT and stored as a FRACTION. Blank clears it back
  // to "not set", which the guard below then refuses to leave SS mode with. An explicit 0 is
  // a real answer and must survive — hence the blank/zero distinction rather than falsiness.
  if ("ssTaxRate" in payload) {
    const raw = String(payload.ssTaxRate ?? "").trim();
    if (!raw) updates.ss_tax_rate = null;
    else {
      const pct = Number(raw);
      if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
        return { error: "The sales tax rate must be a percentage between 0 and 25 — for example 7.25.", status: 400 };
      }
      // 5dp, matching numeric(7,5): 7.25% -> 0.0725. Rounded here so the stored value is the
      // one the card will read back, rather than a float that redisplays as 7.249999.
      updates.ss_tax_rate = Math.round((pct / 100) * 100000) / 100000;
    }
  }
  if ("ssTaxLabel" in payload) {
    // Printed on the customer's document, so bounded like the numbering prefixes are.
    const l = String(payload.ssTaxLabel ?? "").trim().slice(0, 40);
    updates.ss_tax_label = l || "Sales tax";
  }
  if ("ssTaxDelivery" in payload) updates.ss_tax_delivery = Boolean(payload.ssTaxDelivery);
  return { updates };
}

/** Both answers in one comparable shape. Object.is per value, so a -0 the old code stored is a -0
 *  the new code must store too (JSON.stringify would call both "0"). */
// deno-lint-ignore no-explicit-any
const sameUpdates = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b)) && Object.keys(a).every((k) => Object.is(a[k], b[k]));

const RATES: unknown[] = [
  "7.25", 7.25, " 8.875 ", "7.123456", "0", 0, "-0", -0, "0.0", "00", "25", 25, "25.0001", 25.0001, "-0.0001", -1,
  "", "   ", null, undefined, "abc", "7,25", "1,000", "7.25%", "1e1", "1e-3", "0x10", "Infinity", "-Infinity", "NaN",
  true, false, [], ["7"], [7, 8], {}, { valueOf: () => 7 }, "\t6.5\n", "+6.5", ".5", "5.", "0.000004", "0.000005",
];
const LABELS: unknown[] = [
  "Sales tax", "  County tax  ", "", "   ", null, undefined, "x".repeat(40), "y".repeat(41), "  " + "z".repeat(45),
  42, true, false, [], ["a", "b"], {}, "Tax\nline", "Taéx", "🧾 receipt tax",
];
const DELIVERY: unknown[] = [true, false, "true", "false", "", 0, 1, null, undefined, [], {}, "no"];

Deno.test("PARITY: parseCompanyTax answers exactly what save's old inline block did, key by key", () => {
  const payloads: Record<string, unknown>[] = [{}];
  for (const r of RATES) payloads.push({ ssTaxRate: r });
  for (const l of LABELS) payloads.push({ ssTaxLabel: l });
  for (const d of DELIVERY) payloads.push({ ssTaxDelivery: d });
  // Combinations, including a bad rate beside a label (the old code stopped at the rate).
  for (const r of ["6.5", "", "abc", "0", "26"]) {
    for (const l of ["County tax", "", null]) {
      for (const d of [true, false, "yes"]) payloads.push({ ssTaxRate: r, ssTaxLabel: l, ssTaxDelivery: d });
    }
  }
  // Keys this parser does not own ride along untouched, as they did in `save`.
  payloads.push({ action: "save", invoiceInGhl: false, ssQuoteNext: "1000", ssTaxRate: "7", businessName: "Acme Sheds" });
  payloads.push({ action: "save_company_tax", ssTaxRate: "7", taxCodesEnabled: true });
  let n = 0;
  for (const p of payloads) {
    const before = OLD_INLINE(p);
    const after = parseCompanyTax(p);
    const label = JSON.stringify(p, (_k, v) => (v === undefined ? "<undefined>" : Object.is(v, -0) ? "<-0>" : v));
    if ("error" in before) {
      assert(!after.ok, `${label}: the old code refused, the new one accepted`);
      if (!after.ok) assertEquals(after.error, before.error, `${label}: the refusal sentence changed`);
    } else {
      assert(after.ok, `${label}: the old code accepted, the new one refused`);
      if (after.ok) assert(sameUpdates(after.updates, before.updates), `${label}: ${JSON.stringify(after.updates)} vs the old ${JSON.stringify(before.updates)}`);
    }
    n++;
  }
  assert(n > 120, `the parity table shrank to ${n} rows`);
});

Deno.test("PARITY: a -0 rate is stored as the old code stored it, and 0 is never blank", () => {
  const minus = parseCompanyTax({ ssTaxRate: "-0" });
  const old = OLD_INLINE({ ssTaxRate: "-0" });
  assert(minus.ok && "updates" in old && Object.is(minus.updates.ss_tax_rate, old.updates.ss_tax_rate), "\"-0\" diverged");
  const zero = parseCompanyTax({ ssTaxRate: "0" });
  assert(zero.ok && zero.updates.ss_tax_rate === 0, "0 is an answer, not a blank");
});

Deno.test("the rate: percent in, five-place fraction out; blank clears; out of range is refused with save's sentence", () => {
  assertEquals(parseCompanyTax({ ssTaxRate: "7.25" }), { ok: true, updates: { ss_tax_rate: 0.0725 } });
  assertEquals(parseCompanyTax({ ssTaxRate: "7.123456" }), { ok: true, updates: { ss_tax_rate: 0.07123 } });
  assertEquals(parseCompanyTax({ ssTaxRate: "" }), { ok: true, updates: { ss_tax_rate: null } });
  assertEquals(parseCompanyTax({ ssTaxRate: null }), { ok: true, updates: { ss_tax_rate: null } });
  assertEquals(parseCompanyTax({ ssTaxRate: "25" }), { ok: true, updates: { ss_tax_rate: 0.25 } });
  for (const bad of ["25.0001", "-1", "abc", "7,25", "Infinity"]) {
    assertEquals(parseCompanyTax({ ssTaxRate: bad }), { ok: false, error: BAD_RATE }, bad);
  }
  assertEquals(BAD_RATE, "The sales tax rate must be a percentage between 0 and 25 — for example 7.25.");
});

Deno.test("the label: trimmed, capped at 40, blank becomes Sales tax", () => {
  assertEquals(parseCompanyTax({ ssTaxLabel: "  County tax  " }), { ok: true, updates: { ss_tax_label: "County tax" } });
  assertEquals(parseCompanyTax({ ssTaxLabel: "" }), { ok: true, updates: { ss_tax_label: "Sales tax" } });
  assertEquals(parseCompanyTax({ ssTaxLabel: "y".repeat(41) }), { ok: true, updates: { ss_tax_label: "y".repeat(40) } });
});

Deno.test("only the keys that were sent are parsed", () => {
  assertEquals(parseCompanyTax({}), { ok: true, updates: {} });
  assertEquals(parseCompanyTax({ ssTaxDelivery: true }), { ok: true, updates: { ss_tax_delivery: true } });
  assertEquals(parseCompanyTax({ invoiceInGhl: false, ghlApiKey: "k", ssQuoteNext: 5 }), { ok: true, updates: {} },
    "nothing outside the three tax keys is ever produced");
});

Deno.test("parseCodesSwitch: absent, or a real boolean; anything else is refused", () => {
  assertEquals(parseCodesSwitch({}), { ok: true, value: undefined });
  assertEquals(parseCodesSwitch({ taxCodesEnabled: true }), { ok: true, value: true });
  assertEquals(parseCodesSwitch({ taxCodesEnabled: false }), { ok: true, value: false });
  for (const bad of ["true", "false", 1, 0, null, undefined, "on", {}, []]) {
    const r = parseCodesSwitch({ taxCodesEnabled: bad });
    assert(!r.ok && r.status === 400 && r.reason === "bad_switch", `${JSON.stringify(bad)} was not refused`);
  }
});

Deno.test("companyTaxRefusal: nothing sent is refused", () => {
  const r = companyTaxRefusal({}, { invoice_in_ghl: false });
  assert(r && r.reason === "nothing_to_save" && r.status === 400, JSON.stringify(r));
});

Deno.test("companyTaxRefusal: a real rate (0 included) is allowed in every mode and with no row", () => {
  for (const rate of [0, 0.0725, 0.25]) {
    for (const row of [null, { invoice_in_ghl: false }, { invoice_in_ghl: true }, { invoice_in_ghl: null }]) {
      assertEquals(companyTaxRefusal({ ss_tax_rate: rate }, row), null, `${rate} / ${JSON.stringify(row)}`);
      assertEquals(companyTaxRefusal({ ss_tax_rate: rate, ss_tax_label: "X", tax_codes_enabled: true }, row), null);
    }
    assert(!companyTaxNeedsRow({ ss_tax_rate: rate }), "a real rate needs no row read");
  }
});

Deno.test("companyTaxRefusal: a blank rate is refused in paperwork mode and with no row, allowed in CRM mode", () => {
  const paper = companyTaxRefusal({ ss_tax_rate: null }, { invoice_in_ghl: false });
  assert(paper && paper.reason === "rate_required" && paper.error === RATE_REQUIRED, JSON.stringify(paper));
  const none = companyTaxRefusal({ ss_tax_rate: null }, null);
  assert(none && none.reason === "rate_required", JSON.stringify(none));
  // Anything but an explicit false is the CRM (status's reading), so a row predating 121 clears too.
  for (const crm of [true, null, undefined]) {
    assertEquals(companyTaxRefusal({ ss_tax_rate: null }, { invoice_in_ghl: crm }), null, `invoice_in_ghl ${crm}`);
  }
  assertEquals(RATE_REQUIRED, "Your estimates need a sales tax rate. Enter 0 if you don't collect sales tax.");
});

Deno.test("companyTaxRefusal: no row and no rate (a label, delivery or the switch alone) is refused", () => {
  for (const u of [{ ss_tax_label: "County tax" }, { ss_tax_delivery: true }, { tax_codes_enabled: true }, { tax_codes_enabled: false }]) {
    const r = companyTaxRefusal(u, null);
    // The switch saves by itself, so its refusal says which save comes first.
    const want = "tax_codes_enabled" in u ? ["rate_first", RATE_FIRST] : ["rate_required", RATE_REQUIRED];
    assert(r && r.reason === want[0] && r.error === want[1], `${JSON.stringify(u)}: ${JSON.stringify(r)}`);
    assert(companyTaxNeedsRow(u), `${JSON.stringify(u)} must read the row`);
    assertEquals(companyTaxRefusal(u, { invoice_in_ghl: false }), null, `${JSON.stringify(u)} with a paperwork row`);
    assertEquals(companyTaxRefusal(u, { invoice_in_ghl: true }), null, `${JSON.stringify(u)} with a CRM row`);
  }
  // A blank rate sent WITH the switch, no row: still the switch's sentence.
  const both = companyTaxRefusal({ ss_tax_rate: null, tax_codes_enabled: true }, null);
  assert(both && both.reason === "rate_first", JSON.stringify(both));
  assertEquals(RATE_FIRST, "Save your sales tax rate above first, then turn tax codes on. Enter 0 if you don't collect sales tax.");
});

Deno.test("companyTaxView: tax_settings' shapes, and a builder with no row", () => {
  assertEquals(companyTaxView({ ss_tax_rate: 0.0725, ss_tax_label: "County tax", ss_tax_delivery: true }),
    { companyRatePct: 7.25, companyLabel: "County tax", ssTaxDelivery: true });
  assertEquals(companyTaxView({ ss_tax_rate: "0.06500", ss_tax_label: null, ss_tax_delivery: false }),
    { companyRatePct: 6.5, companyLabel: "Sales tax", ssTaxDelivery: false }, "numeric arrives as a string from PostgREST");
  assertEquals(companyTaxView({ ss_tax_rate: 0 }), { companyRatePct: 0, companyLabel: "Sales tax", ssTaxDelivery: false }, "0 stays 0");
  assertEquals(companyTaxView(null), { companyRatePct: null, companyLabel: "Sales tax", ssTaxDelivery: false });
});
