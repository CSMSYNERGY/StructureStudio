// Unit tests for the formal estimate PDF builder.
//
// The builder runs inside submit-estimate on the send path — a throw here is a failed
// estimate submission, so the tests pin the two properties that matter: a representative
// snapshot produces a real PDF, and degenerate/hostile input (missing fields, 0-qty,
// non-WinAnsi characters) still produces one instead of throwing.
//
// Lives in _test_stubs (NOT as _shared/estimatePdf.test.ts) because this group is allowed
// registry imports — the self-contained _shared/*.test.ts group bans jsr:/npm: so it can
// run offline, and this suite necessarily pulls npm:pdf-lib.
//
// Run (cwd: supabase/functions — exactly how scripts/preflight.mjs invokes the group):
//   deno test --quiet --allow-env --node-modules-dir=none \
//             --import-map=_shared/_test_stubs/import_map.json \
//             _shared/_test_stubs/estimatePdf_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { buildFormalEstimatePdf } from "../estimatePdf.ts";
import { pdfText } from "./pdfText.ts";

// Generic identities only — this repo is PUBLIC; no client names or domains in fixtures.
const BUSINESS = {
  name: "Example Barn Co.",
  phone: "(555) 010-0100",
  website: "example.com",
  address: { addressLine1: "100 Example Rd", city: "Springfield", state: "OH", postalCode: "45500" },
};

// Exactly 300 chars — the wrap-and-paginate stressor the layout must absorb in one row.
const LONG_DESC = ("Custom option detail describing the reinforced framing package with " +
  "treated skids, upgraded floor joists on twelve inch centers, double top plates, " +
  "hurricane ties at every rafter, house wrap under the siding, and an extended " +
  "eave overhang on both long walls for additional weather protection over doors.")
  .slice(0, 300);

const TERMS =
  "This estimate is provided for planning purposes and does not constitute a contract. " +
  "Prices are valid for the period stated above and may be adjusted afterward to reflect " +
  "current material costs. A signed agreement and deposit are required to schedule your " +
  "build. Site preparation, permits, and utility connections are the responsibility of " +
  "the customer unless otherwise noted in writing.";

// Shaped exactly like estimate_lines.lines (submit-estimate step 11):
// kind/itemKey/name/desc/qty/amount/nonTaxable, `amount` being the UNIT price.
const LINES = [
  { kind: "building", itemKey: "", name: "Northwood (12x24)", desc: "Base building. Original price $12,500.00.", qty: 1, amount: 12500, nonTaxable: false },
  { kind: "paint", itemKey: "", name: "Paint Colors", desc: "Body: Slate Gray. Trim: Arctic White.", qty: 1, amount: 0, nonTaxable: false },
  { kind: "roof", itemKey: "", name: "Roof", desc: "Metal roof, Charcoal.", qty: 1, amount: 450, nonTaxable: false },
  { kind: "door", itemKey: "door-9lite", name: "9-Lite Entry Door", desc: "36in 9-lite steel entry door.", qty: 2, amount: 385, nonTaxable: false },
  { kind: "window", itemKey: "win-2x3", name: "2x3 Window", desc: "", qty: 4, amount: 165, nonTaxable: false },
  { kind: "ramp", itemKey: "ramp-std", name: "Ramp", desc: "Standard 4ft ramp.", qty: 0, amount: 250, nonTaxable: false }, // 0-qty: renders, contributes $0
  { kind: "delivery", itemKey: "", name: "Delivery", desc: "Delivery within 50 miles.", qty: 1, amount: 250, nonTaxable: true },
  { kind: "custom", itemKey: "", name: "Framing Upgrade Package", desc: LONG_DESC, qty: 1, amount: 975, nonTaxable: false },
];

const FIXTURE = {
  business: BUSINESS,
  estimateNumber: "1042",
  dateIso: "2026-08-10T12:00:00Z",
  validityDays: 30,
  lines: LINES,
  discount: 250,
  quoteTerms: TERMS,
};

function assertIsPdf(bytes: Uint8Array) {
  assert(bytes.length > 1000, `expected > 1000 bytes, got ${bytes.length}`);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
}

Deno.test("representative snapshot builds a real PDF", async () => {
  assertEquals(LONG_DESC.length, 300); // the fixture's own claim, kept honest
  const bytes = await buildFormalEstimatePdf(FIXTURE);
  assertIsPdf(bytes);
  // Structural validity, not just magic bytes: pdf-lib itself can re-open the document.
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 1); // 8 lines + terms fit one page; a layout change that
  // silently doubles density (or halves it) should have to update this number on purpose.
});

Deno.test("degenerate input still builds instead of throwing", async () => {
  // Everything optional missing at once: no number, no date, no discount, no terms, empty
  // business identity, zero lines.
  assertIsPdf(await buildFormalEstimatePdf({ business: {}, lines: [] }));

  // lines entirely absent, partial address, hostile line content: blank name/desc, 0-qty,
  // and non-WinAnsi characters (emoji + curly quotes) — the standard fonts cannot encode
  // these, so an unsanitized draw would THROW and fail the whole estimate submission.
  assertIsPdf(await buildFormalEstimatePdf({
    business: { name: "Solo “Quoted” Sheds \u{1F6AA}", address: { city: "Springfield" } },
    estimateNumber: null,
    lines: undefined,
  }));
  assertIsPdf(await buildFormalEstimatePdf({
    business: BUSINESS,
    estimateNumber: 7,
    lines: [
      { kind: "fallback", itemKey: "", name: "", desc: "", qty: 0, amount: 0, nonTaxable: false },
      { kind: "custom", itemKey: "opt-x", name: "Décor pack — “premium” \u{1F3E0}", desc: "Léon's picks • no substitutions", qty: 1, amount: 100 },
    ],
    discount: Number.NaN, // NaN/negative discounts render no Discount row rather than NaN money
    quoteTerms: "  ",
  }));
});

Deno.test("overflowing line items paginate", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: "custom",
    itemKey: `opt-${i}`,
    name: `Line item ${i + 1}`,
    desc: "Detail text that wraps onto a couple of lines so each row has realistic height.",
    qty: 1,
    amount: 25,
    nonTaxable: false,
  }));
  const bytes = await buildFormalEstimatePdf({ ...FIXTURE, lines: many });
  assertIsPdf(bytes);
  const doc = await PDFDocument.load(bytes);
  assert(doc.getPageCount() >= 2, `expected the 60-line estimate to spill pages, got ${doc.getPageCount()}`);
});

// ── Sales tax (migration 127) ────────────────────────────────────────────────────────────
// The figures below are the plan's mock-ups 1-3, so the tests and the document a customer
// actually receives are demonstrably the same arithmetic:
//   taxable      11,200 + (2 x 325) + 600 = 12,450.00
//   non-taxable  150 (setup) + 450 (delivery) =    600.00

const TAX_LINES = [
  { kind: "building", name: "12x24 Lofted Barn", desc: "Charcoal metal roof", qty: 1, amount: 11200 },
  { kind: "door", name: "36in Steel Door", desc: "", qty: 2, amount: 325 },
  { kind: "layout_item", name: "Loft package", desc: "", qty: 1, amount: 600 },
  { kind: "layout_item", name: "Setup & leveling", desc: "", qty: 1, amount: 150, nonTaxable: true },
  { kind: "delivery", name: "Delivery", desc: "Within 50 miles", qty: 1, amount: 450, nonTaxable: true },
];

const TAX_BASE = { business: BUSINESS, estimateNumber: "JB-1041", dateIso: "2026-08-27T12:00:00Z", lines: TAX_LINES };

Deno.test("the taxed totals block renders both pools, the tax row and the footnote", async () => {
  const bytes = await buildFormalEstimatePdf({
    ...TAX_BASE,
    tax: {
      label: "Sales tax", rate: 0.0725, amount: 902.63, jurisdiction: "Bibb County, GA",
      taxableSubtotal: 12450, nonTaxableSubtotal: 600, taxableBase: 12450, nonTaxableNet: 600,
    },
  });
  assertIsPdf(bytes);
  const t = await pdfText(bytes);

  assert(t.includes("Taxable subtotal"), "the taxable pool must be labelled");
  assert(t.includes("$12,450.00"), "the taxable subtotal figure must render");
  assert(t.includes("Non-taxable subtotal"), "the non-taxable pool must be labelled");
  assert(t.includes("$600.00"), "the non-taxable subtotal figure must render");
  assert(t.includes("Sales tax (7.25%"), "the tax row must name the rate it charged");
  assert(t.includes("Bibb County, GA"), "the tax row must name the jurisdiction when known");
  assert(t.includes("$902.63"), "the tax figure must render");
  // The grand total is the pools plus the stored tax — the number the consent sentence quotes.
  assert(t.includes("$13,952.63"), "the tax-inclusive total must render");
  // The marker and its footnote, together: one without the other is worse than neither.
  assert(t.includes("Delivery *"), "a non-taxable line must wear the marker");
  assert(t.includes("Setup & leveling *"), "every non-taxable line must wear it, not just delivery");
  assert(!t.includes("Loft package *"), "a taxable line must NOT wear the marker");
  assert(t.includes("* Not subject to sales tax"), "the footnote must explain the marker");
});

Deno.test("each discount sits under the pool the rep aimed it at, and is named", async () => {
  const bytes = await buildFormalEstimatePdf({
    ...TAX_BASE,
    discount: 600,
    discountRows: [
      { description: "Spring promo", amount: 500, taxable: true },
      { description: "Delivery waiver", amount: 100, taxable: false },
    ],
    tax: {
      label: "Sales tax", rate: 0.0725, amount: 866.38, jurisdiction: "Bibb County, GA",
      taxableSubtotal: 12450, nonTaxableSubtotal: 600, taxableBase: 11950, nonTaxableNet: 500,
    },
  });
  assertIsPdf(bytes);
  const t = await pdfText(bytes);

  // Each discount named with its reason — "Discount $600.00" tells a customer nothing.
  assert(t.includes("Discount - Spring promo"), "a taxable discount must be named");
  assert(t.includes("Discount - Delivery waiver"), "a non-taxable discount must be named");
  assert(t.includes("-$500.00") && t.includes("-$100.00"), "both discount amounts must render");
  // The net of each pool is printed, so the base the tax row claims is ON THE PAGE above it
  // rather than the output of a proration rule the reader cannot check.
  assert(t.includes("$11,950.00"), "the taxable base must be printed, not just implied");
  assert(t.includes("$500.00"), "the non-taxable net must be printed");
  assert(t.includes("$866.38"), "the tax charged on 11,950 at 7.25%");
  assert(t.includes("$13,316.38"), "the tax-inclusive total with discounts");
});

Deno.test("no tax input renders the original pre-tax block — no marker, no footnote, no tax row", async () => {
  // Every pre-tax document still in the system takes this path, GHL-mode estimates included.
  // A snapshot with no tax figure IS a pre-tax document; inventing a tax line for it would
  // disagree with the number the customer already holds.
  const t = await pdfText(await buildFormalEstimatePdf({ ...TAX_BASE, discount: 250 }));
  assert(t.includes("Subtotal"), "the plain subtotal row stays");
  assert(!t.includes("Taxable subtotal"), "no pool split without tax");
  assert(!t.includes("Non-taxable subtotal"), "no pool split without tax");
  assert(!t.includes("Sales tax"), "no tax row without tax");
  assert(!t.includes("* Not subject to sales tax"), "no footnote without tax");
  assert(!t.includes("Delivery *"), "no marker without tax, even on a nonTaxable line");
  // 13,050 - 250 = 12,800.00, exactly what it printed before this shipped.
  assert(t.includes("$12,800.00"), "the pre-tax total is unchanged");
});

Deno.test("a taxed totals block keeps its rows together across a page break", async () => {
  // The block is measured before it is drawn so Subtotal cannot land on one page with Total on
  // the next. The taxed variant has a VARIABLE row count, so the measure has to grow with the
  // discounts — 60 lines forces the block near a boundary, and its last row must share a page
  // with its first.
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: "custom", itemKey: `opt-${i}`, name: `Line item ${i + 1}`,
    desc: "Detail text that wraps onto a couple of lines so each row has realistic height.",
    qty: 1, amount: 25,
  }));
  const bytes = await buildFormalEstimatePdf({
    ...TAX_BASE,
    lines: many,
    discountRows: [
      { description: "A", amount: 10, taxable: true }, { description: "B", amount: 10, taxable: true },
      { description: "C", amount: 10, taxable: false }, { description: "D", amount: 10, taxable: false },
    ],
    tax: {
      label: "Sales tax", rate: 0.07, amount: 100, taxableSubtotal: 1500,
      nonTaxableSubtotal: 0, taxableBase: 1480, nonTaxableNet: 0,
    },
  });
  assertIsPdf(bytes);
  const doc = await PDFDocument.load(bytes);
  assert(doc.getPageCount() >= 2, `expected pagination, got ${doc.getPageCount()}`);
  const t = await pdfText(bytes);
  assert(t.includes("Taxable subtotal") && t.includes("Sales tax (7%"), "the whole block still renders");
});
