// End-to-end: one SS quote, from the snapshot submit-estimate builds to the figures a customer
// sees, signs and is billed for.
//
// The unit suites each prove one module in isolation. What they CANNOT prove is the property
// this whole feature stands on:
//
//   the number printed on the document, the number in the consent sentence the customer signs,
//   and the number written to the order ledger are the SAME number.
//
// Three different call paths produce those three figures (estimatePdf's totals block,
// totalFromSnapshot via customer-accept, orderCentsFromSnapshot via the orders update). A
// rounding difference or a stale field in any one of them is invisible to a unit test and is a
// billing dispute in production. So this suite builds the snapshot the way submit-estimate
// does, then reads all three back and demands they agree.
//
// Run (cwd: supabase/functions — how scripts/preflight.mjs invokes the group):
//   deno test --quiet --allow-env --node-modules-dir=none \
//             --import-map=_shared/_test_stubs/import_map.json \
//             _shared/_test_stubs/salesTaxE2E_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildQuotePdf } from "../quotePdf.ts";
import { pdfText } from "./pdfText.ts";
import {
  orderCentsFromSnapshot,
  subtotalsFromSnapshot,
  taxFromSnapshot,
  totalFromSnapshot,
} from "../estimateLines.ts";
import { resolveRate, taxOn } from "../salesTax.ts";
import {
  ADDRESS_CHANGED,
  agreedTax,
  carriedTax,
  carryDecision,
  chooseDefaultRate,
  stampTax,
  taxLocationFrom,
} from "../taxChain.ts";
import { changeOrderDescription } from "../changeOrderDiff.ts";

const BUSINESS = {
  name: "Example Barn Co.",
  phone: "(555) 010-0100",
  address: { addressLine1: "100 Example Rd", city: "Macon", state: "GA", postalCode: "31201" },
};

/** fmtMoney as customer-accept composes it for the consent sentence — the same shape
 *  estimatePdf prints. Duplicated deliberately: if the two ever diverge, this test is the
 *  thing that notices. */
const fmtMoney = (n: number): string => {
  const v = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

/**
 * Exactly what submit-estimate's 9-ALT branch does: build the snapshot, compute the pools,
 * apply the rate, stamp `tax` onto the object that is BOTH persisted and handed to the PDF.
 * The stamp goes through taxChain's stampTax, the function that branch calls (2026-09-17), so
 * the object under test is the object the handler writes rather than a hand-kept copy of it.
 */
function stampedSnapshot(opts: {
  lines: Record<string, unknown>[];
  discountRows?: { description: string; amount: number; taxable: boolean }[];
  rate: number;
  label?: string;
  jurisdiction?: string | null;
  source?: "avalara" | "fallback";
}) {
  const rows = opts.discountRows ?? [];
  const snap: Record<string, unknown> = {
    version: 1,
    styleId: "style-1",
    discount: rows.reduce((a, r) => a + r.amount, 0),
    ...(rows.length
      ? {
        discounts: {
          taxable: rows.filter((r) => r.taxable).reduce((a, r) => a + r.amount, 0),
          nonTaxable: rows.filter((r) => !r.taxable).reduce((a, r) => a + r.amount, 0),
          rows,
        },
      }
      : {}),
    lines: opts.lines,
  };
  const pools = subtotalsFromSnapshot(snap)!;
  snap.tax = stampTax({
    pools,
    resolved: {
      rate: opts.rate,
      source: opts.source ?? "avalara",
      // `??` would swallow an explicitly-passed null, which is exactly the no-jurisdiction case
      // the fallback test needs to exercise.
      jurisdiction: opts.jurisdiction === undefined ? "BIBB, GA" : opts.jurisdiction,
      reason: null,
    },
    choice: { basis: "company", label: opts.label ?? "Sales tax", locationId: null, locationName: null },
    address: { state: "GA", zip: "31201" },
    now: "2026-08-28T12:00:00Z",
  });
  return snap;
}

// The plan's mock-up fixture: 12,450 taxable, 600 non-taxable.
const LINES = [
  { kind: "building", itemKey: "", name: "12x24 Lofted Barn", desc: "Charcoal metal roof", qty: 1, amount: 11200, nonTaxable: false },
  { kind: "door", itemKey: "d1", name: "36in Steel Door", desc: "", qty: 2, amount: 325, nonTaxable: false },
  { kind: "layout_item", itemKey: "loft", name: "Loft package", desc: "", qty: 1, amount: 600, nonTaxable: false },
  { kind: "layout_item", itemKey: "setup", name: "Setup & leveling", desc: "", qty: 1, amount: 150, nonTaxable: true },
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "Within 50 miles", qty: 1, amount: 450, nonTaxable: true },
];

/** The three figures that must never disagree, gathered from their three real call paths. */
async function threeWay(snap: Record<string, unknown>, docKind: "estimate" | "invoice") {
  const bytes = await buildQuotePdf({
    docKind,
    business: BUSINESS,
    estimateNumber: docKind === "invoice" ? "SSI-8001" : "JB-1041",
    dateIso: "2026-08-28T12:00:00Z",
    // deno-lint-ignore no-explicit-any
    lines: (snap.lines as any[]),
    discount: Number(snap.discount) || 0,
    // deno-lint-ignore no-explicit-any
    tax: (snap as any).tax,
    // deno-lint-ignore no-explicit-any
    discountRows: (snap as any).discounts?.rows ?? null,
  });
  return {
    printed: await pdfText(bytes),
    consentFigure: fmtMoney(totalFromSnapshot(snap)!),   // what customer-accept puts in the sentence
    ledger: orderCentsFromSnapshot(snap)!,               // what the orders row gets
  };
}

Deno.test("E2E: no discount — document, consent sentence and ledger all agree", async () => {
  const snap = stampedSnapshot({ lines: LINES, rate: 0.0725 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");

  // The document.
  assert(printed.includes("$12,450.00"), "taxable subtotal");
  assert(printed.includes("$600.00"), "non-taxable subtotal");
  assert(printed.includes("Sales tax (7.25%"), "the tax row names its rate");
  assert(printed.includes("BIBB, GA"), "the tax row names the jurisdiction");
  assert(printed.includes("$902.63"), "the tax figure");
  assert(printed.includes("$13,952.63"), "the tax-inclusive total");
  assert(printed.includes("Delivery *") && printed.includes("* Not subject to sales tax"), "marker + footnote");

  // The three-way agreement — the property this file exists for.
  assertEquals(consentFigure, "$13,952.63", "the customer signs the printed total");
  assertEquals(ledger.totalCents, 1395263, "the ledger carries the printed total");
  assertEquals(ledger.pretaxCents + (ledger.taxCents ?? 0), ledger.totalCents, "pretax + tax = total");
  assertEquals(ledger.taxCents, 90263, "the ledger's tax is the printed tax");
  assert(printed.includes(consentFigure), "the consent figure must appear ON the document");
});

Deno.test("E2E: taxable and non-taxable discounts, each in its own pool", async () => {
  const snap = stampedSnapshot({
    lines: LINES,
    discountRows: [
      { description: "Spring promo", amount: 500, taxable: true },
      { description: "Delivery waiver", amount: 100, taxable: false },
    ],
    rate: 0.0725,
  });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");

  assert(printed.includes("Discount - Spring promo"), "the taxable discount is named");
  assert(printed.includes("Discount - Delivery waiver"), "the non-taxable discount is named");
  assert(printed.includes("$11,950.00"), "the taxable base is printed, so the tax can be checked");
  assert(printed.includes("$866.38"), "7.25% of 11,950 — NOT of 12,450, and NOT prorated");
  assert(printed.includes("$13,316.38"), "the total");

  assertEquals(consentFigure, "$13,316.38");
  assertEquals(ledger.totalCents, 1331638);
  assertEquals(ledger.pretaxCents + (ledger.taxCents ?? 0), ledger.totalCents);
  assert(printed.includes(consentFigure));
});

Deno.test("E2E: the invoice restates the quote exactly — a bill is not a re-price", async () => {
  // The SAME snapshot renders both documents. If the invoice ever re-derived anything, the two
  // would drift and the customer would sign a bill for a different number than they accepted.
  const snap = stampedSnapshot({
    lines: LINES,
    discountRows: [{ description: "Spring promo", amount: 500, taxable: true }],
    rate: 0.0725,
  });
  const quote = await threeWay(snap, "estimate");
  const invoice = await threeWay(snap, "invoice");

  assertEquals(invoice.consentFigure, quote.consentFigure, "same total on both documents");
  for (const figure of ["$12,450.00", "$11,950.00", "$866.38", quote.consentFigure]) {
    assert(quote.printed.includes(figure), `quote missing ${figure}`);
    assert(invoice.printed.includes(figure), `invoice missing ${figure}`);
  }
  assert(invoice.printed.includes("Invoice #SSI-8001"), "titled as an invoice");
  assert(!invoice.printed.includes("Valid until"), "a bill does not expire");
});

Deno.test("E2E: the fallback rate produces a complete, correct document", async () => {
  // Avalara unreachable. The document must be indistinguishable in quality — the difference is
  // recorded in `source` for the portal, never shown to the customer as a defect.
  const snap = stampedSnapshot({ lines: LINES, rate: 0.0725, source: "fallback", jurisdiction: null });
  const { printed, consentFigure } = await threeWay(snap, "estimate");
  assert(printed.includes("Sales tax (7.25%)"), "the rate still prints, with no jurisdiction");
  assert(printed.includes("$902.63") && printed.includes("$13,952.63"));
  assertEquals(consentFigure, "$13,952.63");
  assertEquals((snap.tax as Record<string, unknown>).source, "fallback");
});

Deno.test("E2E: 0% is a real answer — the tax row prints and the total is unchanged", async () => {
  // The builder who explicitly said "I don't collect sales tax". The document must still say so
  // rather than silently omitting tax, which is indistinguishable from the bug this fixes.
  const snap = stampedSnapshot({ lines: LINES, rate: 0 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(taxFromSnapshot(snap), 0);
  assertEquals(consentFigure, "$13,050.00", "the pre-tax subtotal IS the total at 0%");
  assertEquals(ledger.taxCents, 0, "0, not null — the builder answered");
  assert(printed.includes("Taxable subtotal"), "the pools still show");
});

Deno.test("E2E: an all-non-taxable order taxes nothing and still balances", async () => {
  const lines = LINES.map((l) => ({ ...l, nonTaxable: true }));
  const snap = stampedSnapshot({ lines, rate: 0.0725 });
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(taxFromSnapshot(snap), 0, "no taxable base means no tax");
  assertEquals(consentFigure, "$13,050.00");
  assertEquals(ledger.taxCents, 0);
  assert(printed.includes("* Not subject to sales tax"), "every line wears the marker");
});

Deno.test("E2E: a pre-tax snapshot is untouched — the CRM path, and every legacy document", async () => {
  // No `tax` key: the totals block, the total and the ledger must all be exactly what they were
  // before any of this shipped. This is the regression that protects every tenant still on GHL.
  const snap = { version: 1, styleId: "s", discount: 250, lines: LINES } as Record<string, unknown>;
  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assertEquals(consentFigure, "$12,800.00", "13,050 - 250, as it always was");
  assertEquals(ledger.taxCents, null, "null, not 0 — this order was never taxed");
  assertEquals(ledger.pretaxCents, ledger.totalCents);
  assert(!printed.includes("Taxable subtotal"), "no pool split");
  assert(!printed.includes("Sales tax"), "no tax row");
  assert(!printed.includes("* Not subject"), "no footnote");
  assert(!printed.includes("Delivery *"), "no marker, even though a line is flagged nonTaxable");
});

// ── The rate chain on a resubmit (2026-09-17) ─────────────────────────────────────────────
//
// What a resubmit does to a quote's tax, end to end: the decision taxChain makes, the stamp
// submit-estimate writes, then the three figures (document, consent sentence, ledger) and the
// change-order sentence a customer is shown. The regressions here cost money quietly: a
// verified rate a shopper sheds by editing their ZIP, a carried rate whose pools still describe
// the old lines, and a re-stamp that raises a change order about nothing.

const VERIFIED_QUOTE = () =>
  stampedSnapshot({ lines: LINES, rate: 0.0825, source: "avalara", jurisdiction: "Bibb County, GA" });
const WORKBENCH = { kind: "layout_item", itemKey: "wb", name: "Workbench", desc: "8 ft", qty: 1, amount: 600, nonTaxable: false };

/** submit-estimate's tax block for one resubmit: the lines were rebuilt, then the chain runs.
 *  fetch is replaced for the duration, and every call to it counted. */
async function resubmit(opts: {
  prior: Record<string, unknown>;
  lines: Record<string, unknown>[];
  staffCaller: boolean;
  address: { state: string | null; zip: string | null };
  location?: Record<string, unknown> | null;
}) {
  const snap: Record<string, unknown> = { version: 1, styleId: "style-1", discount: 0, lines: opts.lines };
  const pools = subtotalsFromSnapshot(snap)!;
  const storedTax = (opts.prior as { tax?: Record<string, unknown> }).tax ?? null;
  const carry = carryDecision({ staffCaller: opts.staffCaller, storedTax, address: opts.address });
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    fetches++;
    return Promise.reject(new Error("no network in this test"));
  }) as typeof fetch;
  try {
    if (carry.carry) {
      snap.tax = carriedTax(storedTax!, pools);
    } else {
      const location = taxLocationFrom(opts.location ?? null, "example-barns");
      const choice = chooseDefaultRate({
        salesLocationId: location?.id ?? null, location, homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax",
      })!;
      const resolved = await resolveRate(
        { street: "1 Main St", city: "Macon", ...opts.address },
        choice.rate,
        { allowLookup: false },
      );
      snap.tax = stampTax({ pools, resolved, choice, address: opts.address, reason: carry.reason, now: "2026-09-17T08:00:00Z" });
    }
  } finally {
    globalThis.fetch = original;
  }
  return { snap, fetches };
}

Deno.test("E2E carry-over: a shopper's resubmit keeps the verified rate, re-priced to the new lines", async () => {
  const quote = VERIFIED_QUOTE();
  // The shopper added a workbench AND moved the delivery to another state. They send that
  // address, so it must not be what decides the rate the builder paid to verify.
  const { snap, fetches } = await resubmit({
    prior: quote, lines: [...LINES, WORKBENCH], staffCaller: false, address: { state: "AL", zip: "35203" },
  });
  const tax = snap.tax as Record<string, unknown>;
  assertEquals(fetches, 0, "a resubmit never calls Avalara");
  assertEquals([tax.source, tax.basis, tax.rate, tax.jurisdiction], ["avalara", "avalara", 0.0825, "Bibb County, GA"]);
  assertEquals(tax.address, { state: "GA", zip: "31201" }, "the verified address is carried, not the shopper's edit");
  assertEquals(tax.amount, 1076.63, "8.25% of the NEW taxable base, 13,050");

  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assert(printed.includes("Bibb County, GA"), "the document still names the verified jurisdiction");
  assert(printed.includes("$13,050.00"), "the pools followed the new lines");
  assertEquals(consentFigure, "$14,726.63", "13,050 + 600 + 1,076.63");
  assertEquals(ledger.totalCents, 1472663);
  assert(printed.includes(consentFigure), "the document's Total is the figure the customer signs");

  const co = changeOrderDescription(quote, snap);
  assert(co !== null && co.includes("Added: Workbench"), `the line is named: ${co}`);
  assert(co!.includes("Sales tax: $1,027.13 → $1,076.63"), `the tax move is named as a line effect: ${co}`);
  assert(!co!.includes("rate:"), `the rate did not move and must not be reported as moving: ${co}`);
});

Deno.test("E2E carry-over: staff moving the delivery ZIP gives the verified rate up, visibly", async () => {
  const quote = VERIFIED_QUOTE();
  const { snap, fetches } = await resubmit({
    prior: quote,
    lines: LINES,
    staffCaller: true,
    address: { state: "GA", zip: "31204" },
    location: {
      id: "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c", client_id: "example-barns", name: "Macon lot",
      active: true, tax_rate: 0.08, tax_label: null,
    },
  });
  const tax = snap.tax as Record<string, unknown>;
  assertEquals(fetches, 0, "invalidating a verified rate must not buy a new one");
  assertEquals(
    [tax.source, tax.basis, tax.rate, tax.jurisdiction, tax.reason, tax.locationName],
    ["fallback", "location", 0.08, null, ADDRESS_CHANGED, "Macon lot"],
  );

  const { printed, consentFigure, ledger } = await threeWay(snap, "estimate");
  assert(printed.includes("Sales tax (8%)"), "the document names the location rate");
  assert(!printed.includes("Bibb County"), "the old jurisdiction is not left on the document");
  assertEquals(ledger.totalCents, Math.round((12450 + 600 + taxOn(12450, 0.08)) * 100));
  assert(printed.includes(consentFigure));

  const co = changeOrderDescription(quote, snap);
  assert(co !== null && co.includes("Sales tax rate: 8.25% → 8%"), `a revision of an UNSIGNED quote names why its total moved: ${co}`);
});

Deno.test("E2E: the first re-stamp of a snapshot written before the chain raises no change order", async () => {
  // Every signed SS order holds a tax object with no basis/location/verifiedAt keys. Re-stamped
  // at the same rate for the same lines, the only differences are those keys — which must not
  // put a change in front of a customer to approve.
  const legacy = stampedSnapshot({ lines: LINES, rate: 0.0725, source: "fallback", jurisdiction: null });
  for (const k of ["basis", "locationId", "locationName", "verifiedAt"]) delete (legacy.tax as Record<string, unknown>)[k];
  const { snap } = await resubmit({ prior: legacy, lines: LINES, staffCaller: true, address: { state: "GA", zip: "31201" } });
  assertEquals((snap.tax as Record<string, unknown>).basis, "company");
  assertEquals(changeOrderDescription(legacy, snap), null, "new bookkeeping keys alone are not a change");
  assertEquals(totalFromSnapshot(snap), totalFromSnapshot(legacy));
});

// ── A signed order keeps the rate it was agreed at (review, 2026-09-17) ────────────────────
//
// Both change-order writers (submit-estimate's amendment path, portal-settings'
// stage_order_attribute_change) ask agreedTax first and carry it; only a design nobody signed
// runs the chain. Before that, an order signed at a LOCATION rate was re-priced by its first
// change after the lot was deleted or re-rated, and the change order asked the customer to
// approve a tax-rate line nobody chose.

const MACON_LOT = {
  id: "3f0c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c", client_id: "example-barns", name: "Macon lot", active: true, tax_rate: 0.08, tax_label: "County tax",
};

/** An order signed at the Macon lot's 8%: the accepted snapshot and the design row as both writers read them. */
function signedAtLocation() {
  const snap: Record<string, unknown> = { version: 1, styleId: "style-1", discount: 0, lines: LINES };
  const location = taxLocationFrom(MACON_LOT, "example-barns");
  const choice = chooseDefaultRate({ salesLocationId: MACON_LOT.id, location, homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax" })!;
  snap.tax = stampTax({
    pools: subtotalsFromSnapshot(snap)!,
    resolved: { rate: choice.rate, source: "fallback", jurisdiction: null, reason: "not requested" },
    choice, address: { state: "GA", zip: "31201" }, now: "2026-09-12T09:00:00Z",
  });
  return {
    accepted_at: "2026-09-13T15:00:00Z",
    accepted_snapshot: { estimateLines: snap, selections: {}, paintColors: {} },
    estimate_lines: snap,
  };
}

/** A change to a design, taxed the way both change-order writers tax it: agreed tax first, then the chain. */
async function amend(design: Record<string, unknown>, opts: {
  lines: Record<string, unknown>[];
  location: Record<string, unknown> | null;
  salesLocationId: string | null;
  address: { state: string | null; zip: string | null };
}) {
  const snap: Record<string, unknown> = { version: 1, styleId: "style-1", discount: 0, lines: opts.lines };
  const pools = subtotalsFromSnapshot(snap)!;
  const signed = agreedTax(design);
  // deno-lint-ignore no-explicit-any
  const storedTax = (design.estimate_lines as any)?.tax ?? null;
  const carry = signed ? { carry: true as const } : carryDecision({ staffCaller: true, storedTax, address: opts.address });
  if (carry.carry) {
    snap.tax = carriedTax((signed ?? storedTax)!, pools);
  } else {
    const location = taxLocationFrom(opts.location, "example-barns");
    const choice = chooseDefaultRate({
      salesLocationId: opts.salesLocationId, location, homeLot: null, companyRate: 0.0725, companyLabel: "Sales tax",
    })!;
    const resolved = await resolveRate({ street: "1 Main St", city: "Macon", ...opts.address }, choice.rate, { allowLookup: false });
    snap.tax = stampTax({ pools, resolved, choice, address: opts.address, reason: carry.reason, now: "2026-09-17T08:00:00Z" });
  }
  return snap;
}

Deno.test("E2E signed order: the lot deleted or re-rated after the signature — the change order raises no tax-rate line", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  try {
    const design = signedAtLocation();
    const agreed = design.accepted_snapshot.estimateLines;
    const scenarios: [string, { location: Record<string, unknown> | null; salesLocationId: string | null; address: { state: string; zip: string } }][] = [
      ["the lot was deleted (sales_location_id set null)", { location: null, salesLocationId: null, address: { state: "GA", zip: "31201" } }],
      ["the lot's rate was edited to 9%", { location: { ...MACON_LOT, tax_rate: 0.09 }, salesLocationId: MACON_LOT.id, address: { state: "GA", zip: "31201" } }],
      ["the lot's rate was cleared", { location: { ...MACON_LOT, tax_rate: null }, salesLocationId: MACON_LOT.id, address: { state: "GA", zip: "31201" } }],
      ["staff moved the delivery ZIP too", { location: null, salesLocationId: null, address: { state: "GA", zip: "31204" } }],
    ];
    for (const [label, opts] of scenarios) {
      const snap = await amend(design, { lines: [...LINES, WORKBENCH], ...opts });
      const tax = snap.tax as Record<string, unknown>;
      assertEquals([tax.rate, tax.basis, tax.locationId, tax.locationName, tax.label], [0.08, "location", MACON_LOT.id, "Macon lot", "County tax"],
        `${label}: the agreed tax is carried`);
      assertEquals(tax.amount, taxOn(12450 + 600, 0.08), `${label}: only the amount follows the new lines`);

      const co = changeOrderDescription(agreed, snap);
      assert(co !== null && co.includes("Added: Workbench"), `${label}: the real change is described: ${co}`);
      assert(!co!.includes("rate:"), `${label}: a tax-rate line nobody chose: ${co}`);
      assert(co!.includes("County tax: $996.00 → $1,044.00"), `${label}: the tax moves only with the lines: ${co}`);
    }

    // The control: the same lot deleted on a quote nobody signed does re-price, which is why the
    // carry is keyed on the agreement and not applied to every design.
    const unsigned = { ...signedAtLocation(), accepted_at: null, accepted_snapshot: null };
    const repriced = await amend(unsigned, { lines: LINES, location: null, salesLocationId: null, address: { state: "GA", zip: "31201" } });
    assertEquals([(repriced.tax as Record<string, unknown>).rate, (repriced.tax as Record<string, unknown>).basis], [0.0725, "company"]);
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(fetches, 0, "no change order may reach the network");
});
