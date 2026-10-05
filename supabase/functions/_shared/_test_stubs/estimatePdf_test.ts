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
import { buildFormalEstimatePdf, pdfCustomerFrom } from "../estimatePdf.ts";
import { pdfText } from "./pdfText.ts";
import { makeJpegShape, makePng } from "./pngFixture.ts";

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

// ── The formal estimate form (2026-10-05) ────────────────────────────────────────────────
// Carolyn, 2026-08-06: the printed estimate should carry the letterhead, the customer's name and
// "estimate good for X amount of days". These pin the customer block ("Prepared for", or "Bill to"
// on an invoice), the per-builder validity and the logo, and above all that leaving all three out
// draws exactly the page it drew before.

/**
 * Everything the page DRAWS, in order, comparable across renders: the inflated content and image
 * streams with pdf-lib's per-document random resource names (/Helvetica-Bold-7098480789, /Image-…)
 * normalised.
 *
 * Read from a re-save WITHOUT object streams, never from the bytes as built. pdf-lib saves with
 * object streams, which puts the info dictionary (CreationDate/ModDate, stamped to the second) in
 * one compressed stream and the cross-reference table in another, and that table holds byte
 * offsets. Whenever the dates compress to a different length every later offset moves by a byte,
 * so stripping the dates is not enough: two builds a second apart still differed in about one run
 * in six (2026-10-05). Re-saved this way, both are plain text outside any stream, and the content
 * streams are copied byte for byte.
 */
async function drawn(bytes: Uint8Array): Promise<string> {
  const flat = await (await PDFDocument.load(bytes, { updateMetadata: false })).save({ useObjectStreams: false });
  return (await pdfText(flat)).replace(/\/(Helvetica-Bold|Helvetica|Image)-\d+/g, "/$1");
}
/** The text lines drawn, as "x,y text", for "where did it land" assertions. */
async function placed(bytes: Uint8Array): Promise<string[]> {
  return [...(await pdfText(bytes)).matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\n(.*) Tj/g)].map((m) => `${m[1]},${m[2]} ${m[3]}`);
}
const at = (lines: string[], text: string) => lines.find((l) => l.endsWith(` ${text}`))?.split(" ")[0] ?? null;
const imageCount = (bytes: Uint8Array) => (new TextDecoder("latin1").decode(bytes).match(/\/Subtype \/Image/g) ?? []).length;

// Made-up customer (the repo is public), shaped like designs.contact as the designer writes it.
const CONTACT = {
  name: "Pat Example", email: "pat@example.test", phone: "(555) 010-0199",
  street: "42 Sample Lane", city: "Springfield", state: "OH", zip: "45501",
};
// A share code as genShortCode makes them today (10 characters), and one of the 48 legacy
// six-character codes migration 156 redacts.
const CODE = "SS-ABCD2345EF";
const LEGACY = "SS-ABC234";

Deno.test("pdfCustomerFrom reads designs.contact, and nothing printable is null", () => {
  assertEquals(pdfCustomerFrom(CONTACT, CODE), {
    name: "Pat Example", phone: "(555) 010-0199", email: "pat@example.test",
    address: { street: "42 Sample Lane", city: "Springfield", state: "OH", zip: "45501" },
  });
  // The legacy key names contactAddress.ts knows (address / postalCode).
  assertEquals(pdfCustomerFrom({ name: "Lee", address: "9 Mill St", postalCode: "65401" }, CODE)?.address,
    { street: "9 Mill St", city: null, state: null, zip: "65401" });
  for (const blank of [null, undefined, {}, [], "Pat", { name: "  ", email: "" }, { country: "US" }]) {
    assertEquals(pdfCustomerFrom(blank, CODE), null, `for ${JSON.stringify(blank)}`);
  }
});

Deno.test("pdfCustomerFrom prints no customer for a code short enough to guess (migration 156's rule)", async () => {
  // The quote documents live in the public bucket under <client>/<code>-quote.pdf (and -estimate,
  // -invoice): a key derived from the code alone. For a legacy six-character code that key can be
  // enumerated, so a customer block there would hand out what load_design withholds.
  assertEquals(pdfCustomerFrom(CONTACT, LEGACY), null);
  assertEquals(pdfCustomerFrom(CONTACT, "SS-ABC2345"), null, "7 characters");
  assert(pdfCustomerFrom(CONTACT, "SS-ABC23456"), "8 characters is one target, not enumerable");
  assert(pdfCustomerFrom(CONTACT, CODE));
  // A lost code prints no customer rather than the wrong one.
  for (const code of ["", "SS-", undefined, null]) assertEquals(pdfCustomerFrom(CONTACT, code as unknown as string), null, String(code));
  // And so the legacy code's page is exactly the page with no customer.
  const none = await drawn(await buildFormalEstimatePdf(FIXTURE));
  assertEquals(await drawn(await buildFormalEstimatePdf({ ...FIXTURE, customer: pdfCustomerFrom(CONTACT, LEGACY) })), none);
});

Deno.test("the customer block prints Prepared for, the name, the delivery address, phone and email", async () => {
  const bytes = await buildFormalEstimatePdf({ ...FIXTURE, customer: pdfCustomerFrom(CONTACT, CODE) });
  assertIsPdf(bytes);
  const lines = await placed(bytes);
  for (const s of ["Prepared for", "Pat Example", "42 Sample Lane", "Springfield, OH 45501", "(555) 010-0199", "pat@example.test"]) {
    assert(at(lines, s), `"${s}" must render; drew ${JSON.stringify(lines.slice(0, 14))}`);
  }
  // Beside the title block, not under it: same top band, right-hand column.
  const [tx, ty] = at(lines, "Estimate #1042")!.split(",").map(Number);
  const [px, py] = at(lines, "Prepared for")!.split(",").map(Number);
  assert(px > tx + 200 && Math.abs(py - ty) < 12, `Prepared for at ${px},${py}; the title at ${tx},${ty}`);
  // And the representative estimate still fits one page with it.
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
});

Deno.test("no customer draws exactly the page it drew before: no heading, nothing moved", async () => {
  const base = await drawn(await buildFormalEstimatePdf(FIXTURE));
  assert(!base.includes("Prepared for") && !base.includes("Bill to"), "no block without a customer");
  // Every way of having nothing to print is the same page as not passing a customer at all.
  for (const customer of [null, undefined, {}, { name: "   ", phone: "", email: null, address: { street: " ", city: null } }]) {
    assertEquals(await drawn(await buildFormalEstimatePdf({ ...FIXTURE, customer })), base, `customer ${JSON.stringify(customer)}`);
  }
  // And a logo-less business is the old text letterhead at the old place.
  const lines = await placed(await buildFormalEstimatePdf(FIXTURE));
  assertEquals(at(lines, "Example Barn Co."), "54,718");
});

Deno.test("a customer with only part of the record prints that part, and never 'null' or 'undefined'", async () => {
  const t = await drawn(await buildFormalEstimatePdf({ ...FIXTURE, customer: pdfCustomerFrom({ name: "Sam Only", zip: "45501" }, CODE) }));
  assert(t.includes("Prepared for") && t.includes("Sam Only") && t.includes("45501 Tj"), "name and zip print");
  assert(!/\bnull\b|\bundefined\b/.test(t), "no placeholder words on a customer's document");
  const emailOnly = await drawn(await buildFormalEstimatePdf({ ...FIXTURE, customer: { email: "only@example.test" } }));
  assert(emailOnly.includes("Prepared for") && emailOnly.includes("only@example.test"), "an email alone still gets the block");
});

Deno.test("a non-Latin or emoji customer name is sanitised to WinAnsi instead of failing the quote", async () => {
  // The standard fonts encode WinAnsi only and pdf-lib THROWS on anything else: a shopper's name
  // must not be the reason a quote has no document.
  const bytes = await buildFormalEstimatePdf({
    ...FIXTURE,
    customer: { name: "Zoë Łukasz 李 \u{1F3E0}", address: { street: "Straße “7”", city: "Zürich" } },
  });
  assertIsPdf(bytes);
  const t = await drawn(bytes);
  assert(t.includes("Zoë ?ukasz ?"), "Latin-1 kept, the rest replaced");
  assert(t.includes('Straße "7"'), "curly quotes normalised, ß kept");
  assert(t.includes("Zürich"), "ü kept");
});

Deno.test("a hostile 1,000-character name keeps two lines and cannot push the table off the page", async () => {
  const bytes = await buildFormalEstimatePdf({ ...FIXTURE, customer: { name: "Very Long Name ".repeat(70), email: "x@example.test" } });
  assertIsPdf(bytes);
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1, "the representative estimate still fits one page");
  const nameLines = (await placed(bytes)).filter((l) => / Very Long Name/.test(l));
  assertEquals(nameLines.length, 2, `at most two name lines, got ${nameLines.length}`);
});

Deno.test("validityDays sets the Valid until date; absent, zero or junk keeps 30", async () => {
  // Issued 2026-08-10: + 14 days is August 24, + 60 is October 9, + 365 is August 10, 2027.
  const valid = async (validityDays: number | undefined) =>
    (await placed(await buildFormalEstimatePdf({ ...FIXTURE, validityDays })))
      .find((l) => l.includes("Valid until:"))?.split(" ").slice(1).join(" ");
  assertEquals(await valid(14), "Valid until: August 24, 2026");
  assertEquals(await valid(60), "Valid until: October 9, 2026");
  assertEquals(await valid(365), "Valid until: August 10, 2027");
  assertEquals(await valid(undefined), "Valid until: September 9, 2026");
  assertEquals(await valid(0), "Valid until: September 9, 2026");
  assertEquals(await valid(Number.NaN), "Valid until: September 9, 2026");
});

Deno.test("an invoice prints Bill to and no Valid until, with the same customer", async () => {
  const t = await drawn(await buildFormalEstimatePdf({ ...FIXTURE, docKind: "invoice", validityDays: 14, customer: pdfCustomerFrom(CONTACT, CODE) }));
  assert(t.includes("Invoice #1042"), "titled Invoice");
  assert(t.includes("Bill to"), "the customer block is titled Bill to");
  assert(!t.includes("Prepared for"), "not Prepared for");
  assert(!t.includes("Valid until"), "an invoice is a bill, not an offer: no validity, whatever the setting");
  assert(t.includes("Pat Example") && t.includes("42 Sample Lane"), "the customer prints");
});

Deno.test("a PNG logo is embedded left of the business name, at most 48 pt high", async () => {
  const skipped: string[] = [];
  const bytes = await buildFormalEstimatePdf({
    ...FIXTURE,
    business: { ...BUSINESS, logo: makePng(300, 100) },
    onLogoSkipped: (r) => skipped.push(r),
  });
  assertIsPdf(bytes);
  assertEquals(skipped, []);
  assertEquals(imageCount(bytes), 1, "one image XObject");
  // 300x100 at 48 pt high is 144 x 48, drawn at the margin; the name moves right of it (54 + 144 + 14).
  assert((await drawn(bytes)).includes("144 0 0 48 0 0 cm"), "drawn 144 x 48");
  assertEquals(at(await placed(bytes), "Example Barn Co."), "212,718");
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
});

Deno.test("a very wide logo is capped at 2 inches wide instead of pushing the name off the line", async () => {
  const bytes = await buildFormalEstimatePdf({ ...FIXTURE, business: { ...BUSINESS, logo: makePng(800, 100) } });
  assert((await drawn(bytes)).includes("144 0 0 18 0 0 cm"), "800x100 scales to 144 x 18");
});

Deno.test("a JPEG logo takes the JPEG path (copied as DCT data, not decoded)", async () => {
  const skipped: string[] = [];
  const bytes = await buildFormalEstimatePdf({ ...FIXTURE, business: { ...BUSINESS, logo: makeJpegShape(473, 200) }, onLogoSkipped: (r) => skipped.push(r) });
  assertIsPdf(bytes);
  assertEquals(skipped, []);
  assert(/\/Subtype \/Image[\s\S]{0,200}\/Filter \/DCTDecode/.test(new TextDecoder("latin1").decode(bytes)), "a DCTDecode image");
});

Deno.test("an unusable logo leaves the text letterhead exactly as it was, and says why", async () => {
  const base = await drawn(await buildFormalEstimatePdf(FIXTURE));
  const header = makePng(1254, 1254).slice(0, 33); // only the header: sniffed, never decoded
  const broken = makePng(40, 20);
  broken.fill(7, 41, broken.length - 12); // a real header over a corrupted body: pdf-lib throws
  const cases: [string, Uint8Array, RegExp][] = [
    ["too many pixels", header, /^logo 1254x1254 PNG is too big to embed$/],
    ["corrupt PNG", broken, /^logo embed failed/],
    ["a GIF", new TextEncoder().encode("GIF89a".padEnd(64, ".")), /^logo not a PNG or JPEG$/],
    ["empty", new Uint8Array(0), /^logo empty$/],
  ];
  for (const [label, logo, want] of cases) {
    const skipped: string[] = [];
    const bytes = await buildFormalEstimatePdf({ ...FIXTURE, business: { ...BUSINESS, logo }, onLogoSkipped: (r) => skipped.push(r) });
    assertIsPdf(bytes);
    assertEquals(imageCount(bytes), 0, `${label}: no image`);
    assertEquals(await drawn(bytes), base, `${label}: the page is the logo-less one`);
    assertEquals(skipped.length, 1, `${label}: one reason, got ${JSON.stringify(skipped)}`);
    assert(want.test(skipped[0]), `${label}: ${skipped[0]}`);
  }
  // A throwing telemetry sink cannot cost the document either.
  assertIsPdf(await buildFormalEstimatePdf({
    ...FIXTURE, business: { ...BUSINESS, logo: header }, onLogoSkipped: () => { throw new Error("boom"); },
  }));
});
