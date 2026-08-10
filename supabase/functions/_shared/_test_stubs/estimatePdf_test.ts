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
