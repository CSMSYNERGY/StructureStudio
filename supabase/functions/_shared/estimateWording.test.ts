// "Estimate", never "quote", in anything a customer or a builder reads from these modules
// (Carolyn Q12, 2026-10-06). scripts/preflight.mjs reads the SOURCE for the word; this renders the
// OUTPUT, because a sentence can be assembled from parts that each look innocent ("Your " + word).
//
// It also pins the one thing the rewording must NOT move: StructureStudio's own paperwork (docWord
// "quote", the internal key) still leaves the total out of its email — the row, the plain-text line
// and the inbox preview (Carolyn, 2026-09-14) — while the CRM path's estimate email keeps it. That
// rule keys on docWord, never on the word the email prints.
//
// Links are identifiers, not words: a PDF stored as "...-quote.pdf" and the /my-quotes page keep
// their names, so URLs are stripped before the check. Dependency-free (no jsr:/npm: imports), like
// the other _shared tests.
import {
  acceptanceEmail,
  changeOrderEmail,
  estimateEmail,
  invoiceRequestEmail,
  templatePreviewEmail,
  TEMPLATE_KINDS,
  type EmailContent,
} from "./emailTemplates.ts";
import { consentSentence, consentSentenceChangeOrder, consentSentenceClick } from "./consentSentences.ts";
import { foundationDesc } from "./foundation.ts";

const QUOTE_WORD = /\bquot(e|es|ed|ing)\b/i;
/** The words a person reads: URLs (in attributes or printed bare) are names, not words. */
const words = (s: string) => s.replace(/(href|src)="[^"]*"/g, "").replace(/https?:\/\/\S+/g, "");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertNoQuote(label: string, o: EmailContent) {
  for (const [part, s] of [["subject", o.subject], ["html", o.html], ["text", o.text]] as const) {
    const m = QUOTE_WORD.exec(words(s));
    const at = m ? words(s).slice(Math.max(0, m.index - 60), m.index + 40) : "";
    assert(!m, `${label} ${part} says "${m && m[0]}" where a person reads it: …${at}…`);
  }
}

// Neutral fixtures (this repo is public). The PDF names are the real storage-key shapes.
const BIZ = {
  businessName: "Acme Sheds",
  logoUrl: "https://storage.example.com/branding/acme-sheds/logo.png",
  phone: "(555) 555-0100",
  website: "acmesheds.example.com",
  quoteTerms: "50% deposit due on acceptance.",
};
const doc = (docWord?: "quote" | "estimate") => ({
  ...BIZ,
  estimateNumber: docWord === "quote" ? "AS-1041" : "EST-2001",
  total: 12345.5,
  styleLabel: "Lofted Barn",
  sizeLabel: "12x24",
  estimateUrl: "https://app.example.com/?client=acme-sheds&account=quotes&q=SS-ABCDEFGHJK",
  pdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABCDEFGHJK.pdf",
  formalPdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABCDEFGHJK-quote.pdf",
  docWord,
});

Deno.test("every email a customer or builder gets says estimate, never quote", () => {
  assertNoQuote("estimateEmail(docWord quote)", estimateEmail(doc("quote")));
  assertNoQuote("estimateEmail(docWord quote, no button)", estimateEmail({ ...doc("quote"), estimateUrl: null, formalPdfUrl: null }));
  assertNoQuote("estimateEmail(docWord estimate)", estimateEmail(doc("estimate")));
  assertNoQuote("estimateEmail(default)", estimateEmail(doc()));
  assertNoQuote("changeOrderEmail", changeOrderEmail({
    ...BIZ, quoteNumber: "AS-1041", coNo: 2, description: "Added: Window x2 ($450.00)",
    totalBefore: 2800, totalAfter: 3250, reviewUrl: "https://app.example.com/my-quotes?client=acme-sheds",
  }));
  const acc = { ...BIZ, quoteNumber: "AS-1041", total: 12345.5, signerName: "Pat Example", acceptedAtIso: "2026-08-23T18:30:00.000Z",
    pdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABCDEFGHJK-quote.pdf" };
  assertNoQuote("acceptanceEmail(quote, signed)", acceptanceEmail(acc));
  assertNoQuote("acceptanceEmail(quote, click)", acceptanceEmail({ ...acc, method: "click" }));
  assertNoQuote("acceptanceEmail(invoice)", acceptanceEmail({ ...acc, quoteNumber: "000012", docWord: "invoice" }));
  assertNoQuote("acceptanceEmail(invoice, click)", acceptanceEmail({ ...acc, quoteNumber: "000012", docWord: "invoice", method: "click" }));
  assertNoQuote("invoiceRequestEmail", invoiceRequestEmail({
    businessName: "Acme Sheds", quoteNumber: "AS-1041", customerName: "Pat Example", styleLabel: "Lofted Barn", sizeLabel: "12x24",
    total: 10505.14, acceptedAtIso: "2026-09-15T14:03:00.000Z", reviewUrl: "https://app.example.com/portal/orders/o-1",
  }));
  assertNoQuote("invoiceRequestEmail(bare)", invoiceRequestEmail({
    businessName: "Acme Sheds", quoteNumber: "AS-1041", acceptedAtIso: "2026-09-15T14:03:00.000Z", reviewUrl: "https://app.example.com/portal/orders/o-1",
  }));
  assert(TEMPLATE_KINDS.length === 3, "a new wording kind needs a preview row here");
  for (const kind of TEMPLATE_KINDS) {
    assertNoQuote(`templatePreviewEmail(${kind})`, templatePreviewEmail({ kind, copy: {}, ...BIZ }));
    assertNoQuote(`templatePreviewEmail(${kind}, to sign)`, templatePreviewEmail({ kind, copy: {}, ...BIZ, invoiceToSign: true }));
  }
});

Deno.test("the consent sentences and the percentage line name an estimate", () => {
  for (const [label, s] of [
    ["consentSentence", consentSentence("AS-1041", "$12,345.50")],
    ["consentSentenceClick", consentSentenceClick("AS-1041", "$12,345.50")],
    ["consentSentenceClick (no total)", consentSentenceClick("AS-1041", null)],
    ["consentSentenceChangeOrder (no invoice yet)", consentSentenceChangeOrder({
      invoiceNumber: null, quoteNumber: "AS-1041", coNo: 1, newTotal: 4050, feeCents: 0, feeTaxCents: 0, priorDate: null, refundCents: 0,
    })],
    ["foundationDesc pct", foundationDesc("pct_estimate_total", 1, 7.5)],
  ] as const) {
    assert(!QUOTE_WORD.test(s), `${label} says quote: ${s}`);
    assert(/\bestimate\b/.test(s), `${label} names the estimate: ${s}`);
  }
});

Deno.test("the rewording moves no behaviour: StructureStudio paperwork still has no total, the CRM email keeps it", () => {
  const ss = estimateEmail(doc("quote"));
  for (const [part, s] of [["subject", ss.subject], ["html", ss.html], ["text", ss.text]] as const) {
    assert(!s.includes("12,345"), `the StructureStudio estimate email must not show the amount in its ${part}`);
    assert(!s.includes("Estimate total"), `the StructureStudio estimate email must not carry a total row in its ${part}`);
  }
  assert(ss.html.includes(">Your estimate from Acme Sheds is ready.</div>"), "the preview line names no amount");
  const crm = estimateEmail(doc("estimate"));
  assert(crm.html.includes("Estimate total") && crm.html.includes("$12,345.50"), "the CRM email keeps its total row");
  assert(crm.text.includes("Estimate total: $12,345.50"), "the CRM email keeps its total line");
  assert(crm.html.includes(">Your estimate from Acme Sheds is ready - $12,345.50.</div>"), "the CRM preview line keeps the amount");
  // The builder's wording is still read from the tab each path has always used.
  const ssWorded = estimateEmail({ ...doc("quote"), templateCopy: { quote: { subject: "SS {number}" }, estimate: { subject: "CRM {number}" } } });
  const crmWorded = estimateEmail({ ...doc("estimate"), templateCopy: { quote: { subject: "SS {number}" }, estimate: { subject: "CRM {number}" } } });
  assert(ssWorded.subject === "SS AS-1041", `StructureStudio paperwork reads the "quote" tab: ${ssWorded.subject}`);
  assert(crmWorded.subject === "CRM EST-2001", `the CRM email reads the "estimate" tab: ${crmWorded.subject}`);
});
