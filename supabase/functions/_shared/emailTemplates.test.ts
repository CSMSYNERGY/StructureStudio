// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a
// machine with no registry access -- the same rule the other _shared tests follow.
// Preflight discovers _shared/*.test.ts automatically, so these run on every push.
import { acceptanceEmail, changeOrderEmail, esc, estimateEmail, formatMoney, invoiceEmail, testEmail } from "./emailTemplates.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertIncludes(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg ?? "assertIncludes"}: expected output to contain ${JSON.stringify(needle)}`);
  }
}
function assertNotIncludes(haystack: string, needle: string, msg?: string) {
  if (haystack.includes(needle)) {
    throw new Error(`${msg ?? "assertNotIncludes"}: output must not contain ${JSON.stringify(needle)}`);
  }
}

const baseEstimate = () => ({
  businessName: "Junior Barns",
  logoUrl: "https://example.com/logo.png",
  phone: "(555) 201-8890",
  website: "juniorbarns.example.com",
  estimateNumber: "EST-1042",
  total: 12345.5,
  styleLabel: "Northwood",
  sizeLabel: "12x24",
  estimateUrl: "https://pay.example.com/estimate/abc123",
  pdfUrl: "https://storage.example.com/floor-plans/junior-barns/SS-ABC123.pdf",
  quoteTerms: "50% deposit due on acceptance.\nBalance due on delivery.",
});

const baseInvoice = () => ({
  businessName: "Junior Barns",
  phone: "(555) 201-8890",
  invoiceNumber: "000012",
  total: "$500.00",
  invoiceUrl: "https://pay.example.com/invoice/xyz789",
  quoteTerms: "Net 15.",
});

/** The stored shape of client_settings.email_template_copy (migration 138) for one kind. */
const tplCopy = (invoice: Record<string, unknown>) => ({ invoice });

Deno.test("esc escapes every HTML-significant character and survives nullish", () => {
  assert(esc(`<script>&"'`) === "&lt;script&gt;&amp;&quot;&#39;", `esc got: ${esc(`<script>&"'`)}`);
  assert(esc(null) === "", "esc(null) must be empty");
  assert(esc(undefined) === "", "esc(undefined) must be empty");
});

Deno.test("a name carrying <script> is escaped in every builder's html", () => {
  // Tenant/customer data flows into these emails; a raw tag reaching the html is XSS in
  // whatever webmail client renders it.
  const hostile = `Acme <script>alert("x")</script> Barns`;
  const outs = [
    estimateEmail({ ...baseEstimate(), businessName: hostile }),
    invoiceEmail({ ...baseInvoice(), businessName: hostile }),
    testEmail({ businessName: hostile, fromAddress: "info@acme.example" }),
  ];
  for (const o of outs) {
    assertNotIncludes(o.html, "<script>", "raw tag must never reach the html");
    assertIncludes(o.html, "&lt;script&gt;", "the escaped form should render as text");
  }
});

Deno.test("attribute values are escaped too -- a quote in a URL cannot break out of href", () => {
  const o = estimateEmail({ ...baseEstimate(), pdfUrl: `https://x.example/a.pdf" onmouseover="alert(1)` });
  assertNotIncludes(o.html, `" onmouseover="`, "unescaped quote would open a new attribute");
  assertIncludes(o.html, "&quot; onmouseover=", "the quote should arrive escaped");
});

Deno.test("null estimateUrl omits the CTA button entirely and keeps the floor-plan PDF link", () => {
  const o = estimateEmail({ ...baseEstimate(), estimateUrl: null });
  assertNotIncludes(o.html, "View &amp; Accept Your Estimate", "button label must not render");
  assertNotIncludes(o.html, "https://pay.example.com", "no residual href to the hosted page");
  assertIncludes(o.html, baseEstimate().pdfUrl, "PDF link stays");
  assertNotIncludes(o.text, "accept your estimate", "text CTA line must be dropped too");
  assertIncludes(o.text, baseEstimate().pdfUrl, "text keeps the PDF link");
});

Deno.test("estimateUrl present renders the CTA linking to it", () => {
  const o = estimateEmail(baseEstimate());
  assertIncludes(o.html, `href="https://pay.example.com/estimate/abc123"`);
  assertIncludes(o.html, "View &amp; Accept Your Estimate");
});

Deno.test("null invoiceUrl omits the View Invoice button; present renders it", () => {
  const without = invoiceEmail({ ...baseInvoice(), invoiceUrl: null });
  assertNotIncludes(without.html, "View Invoice");
  assertNotIncludes(without.html, "https://pay.example.com");
  const withUrl = invoiceEmail(baseInvoice());
  assertIncludes(withUrl.html, `href="https://pay.example.com/invoice/xyz789"`);
  assertIncludes(withUrl.html, "View Invoice");
});

Deno.test("subjects carry the document number", () => {
  assertIncludes(estimateEmail(baseEstimate()).subject, "EST-1042");
  assertIncludes(invoiceEmail(baseInvoice()).subject, "000012");
});

Deno.test("subjects are one line even when a value carries newlines", () => {
  // A newline surviving into the subject is a header-injection primitive.
  const o = estimateEmail({ ...baseEstimate(), businessName: "Acme\r\nBcc: evil@example.com" });
  assert(!/[\r\n]/.test(o.subject), `subject must not contain CR/LF: ${JSON.stringify(o.subject)}`);
});

Deno.test("text versions are non-empty and mirror the content", () => {
  const e = estimateEmail(baseEstimate());
  assert(e.text.trim().length > 0, "estimate text empty");
  assertIncludes(e.text, "EST-1042");
  assertIncludes(e.text, "$12,345.50");
  assertIncludes(e.text, "https://pay.example.com/estimate/abc123");
  assertIncludes(e.text, "Northwood");

  const i = invoiceEmail(baseInvoice());
  assert(i.text.trim().length > 0, "invoice text empty");
  assertIncludes(i.text, "000012");
  assertIncludes(i.text, "$500.00");
  assertIncludes(i.text, "https://pay.example.com/invoice/xyz789");

  const t = testEmail({ businessName: "Junior Barns", fromAddress: "info@juniorbarns.example.com" });
  assert(t.text.trim().length > 0, "test-email text empty");
  assertIncludes(t.text, "info@juniorbarns.example.com");
});

Deno.test("formatMoney formats numbers $#,##0.00 and passes strings through", () => {
  assert(formatMoney(12345.5) === "$12,345.50", formatMoney(12345.5));
  assert(formatMoney(0) === "$0.00", formatMoney(0));
  assert(formatMoney(999) === "$999.00", formatMoney(999));
  assert(formatMoney(1000000) === "$1,000,000.00", formatMoney(1000000));
  assert(formatMoney(-42.1) === "-$42.10", formatMoney(-42.1));
  assert(formatMoney("$1,234.00") === "$1,234.00", "pre-formatted strings pass through");
});

const baseAcceptance = () => ({
  businessName: "Junior Barns",
  phone: "(555) 201-8890",
  quoteNumber: "JB-1041",
  total: 12345.5,
  signerName: "Pat Example",
  acceptedAtIso: "2026-08-23T18:30:00.000Z",
  pdfUrl: "https://storage.example.com/floor-plans/junior-barns/SS-ABC123-quote.pdf",
  quoteTerms: "50% deposit due on acceptance.",
});

Deno.test("docWord 'quote' reworders the estimate email; default stays 'estimate'", () => {
  const q = estimateEmail({ ...baseEstimate(), estimateNumber: "JB-1041", docWord: "quote" });
  assertIncludes(q.subject, "Your quote JB-1041");
  assertIncludes(q.html, "View &amp; Sign Your Quote");
  assertNotIncludes(q.html, "Your estimate is ready");
  assertIncludes(q.text, "Quote #: JB-1041");
  const e = estimateEmail(baseEstimate());
  assertIncludes(e.subject, "Your estimate EST-1042");
  assertIncludes(e.html, "View &amp; Accept Your Estimate");
});

Deno.test("acceptanceEmail carries the number, signer, date and signed-PDF link", () => {
  const o = acceptanceEmail(baseAcceptance());
  assertIncludes(o.subject, "You accepted quote JB-1041");
  assertIncludes(o.html, "Pat Example");
  assertIncludes(o.html, "2026-08-23");
  assertIncludes(o.html, `href="${baseAcceptance().pdfUrl}"`);
  assertIncludes(o.text, "Signed by: Pat Example");
  // No PDF -> no link, still a valid email.
  const bare = acceptanceEmail({ ...baseAcceptance(), pdfUrl: null });
  assertNotIncludes(bare.html, "signed quote (PDF)");
  assert(bare.text.trim().length > 0, "text half must survive without a PDF");
});

const baseChangeOrder = () => ({
  businessName: "Junior Barns",
  quoteNumber: "JB-1041",
  coNo: 2,
  description: "Added: Window ×2 ($450.00)\nBody color: options updated\nTotal: $2,800.00 → $3,250.00",
  totalBefore: 2800,
  totalAfter: 3250,
  reviewUrl: "https://app.example.com/my-quotes?client=junior-barns",
  quoteTerms: "50% deposit due on acceptance.",
});

Deno.test("changeOrderEmail carries the description, totals, CO number and review CTA", () => {
  const o = changeOrderEmail(baseChangeOrder());
  assertIncludes(o.subject, "A change to your quote JB-1041 needs your approval");
  assertIncludes(o.html, "CO-2");
  assertIncludes(o.html, "Added: Window ×2");
  assertIncludes(o.html, "$2,800.00");
  assertIncludes(o.html, "$3,250.00");
  assertIncludes(o.html, `href="${baseChangeOrder().reviewUrl}"`);
  assertIncludes(o.html, "Review &amp; Approve");
  assertIncludes(o.text, "New total: $3,250.00");
  // Multi-line description keeps its structure in HTML.
  assertIncludes(o.html, "($450.00)<br>Body color");
});

Deno.test("changeOrderEmail escapes a hostile description", () => {
  const o = changeOrderEmail({ ...baseChangeOrder(), description: `<script>alert(1)</script> changed` });
  assertNotIncludes(o.html, "<script>");
  assertIncludes(o.html, "&lt;script&gt;");
});

Deno.test("acceptanceEmail escapes a hostile signer name", () => {
  const o = acceptanceEmail({ ...baseAcceptance(), signerName: `Pat <script>alert(1)</script>` });
  assertNotIncludes(o.html, "<script>", "raw tag must never reach the html");
  assertIncludes(o.html, "&lt;script&gt;");
});

Deno.test("white-label: no platform branding anywhere in any output", () => {
  // The whole point of the Postmark path is that the customer sees ONLY their builder.
  const outs = [
    estimateEmail(baseEstimate()),
    estimateEmail({ ...baseEstimate(), docWord: "quote" }),
    invoiceEmail(baseInvoice()),
    invoiceEmail({ ...baseInvoice(), templateCopy: tplCopy({ subject: "Invoice {number}", intro: "Thanks from {business}." }) }),
    acceptanceEmail(baseAcceptance()),
    changeOrderEmail(baseChangeOrder()),
    testEmail({ businessName: "Junior Barns", fromAddress: "info@juniorbarns.example.com" }),
  ];
  for (const o of outs) {
    const all = (o.subject + o.html + o.text).toLowerCase();
    for (const brand of ["structurestudio", "structure studio", "postmark", "csm synergy"]) {
      assertNotIncludes(all, brand, `platform identifier "${brand}" leaked`);
    }
  }
});

Deno.test("quote terms keep their line structure in html and stay verbatim in text", () => {
  const o = estimateEmail(baseEstimate());
  assertIncludes(o.html, "50% deposit due on acceptance.<br>Balance due on delivery.");
  assertIncludes(o.text, "50% deposit due on acceptance.\nBalance due on delivery.");
});

Deno.test("logo renders as an img with the business name as alt; no logo, no img", () => {
  const withLogo = estimateEmail(baseEstimate());
  assertIncludes(withLogo.html, `alt="Junior Barns"`);
  const noLogo = estimateEmail({ ...baseEstimate(), logoUrl: null });
  assertNotIncludes(noLogo.html, "<img");
});

Deno.test("formalPdfUrl renders a second PDF link; absent renders nothing formal", () => {
  const url = "https://storage.example.com/floor-plans/junior-barns/SS-ABC123-estimate.pdf";
  const withFormal = estimateEmail({ ...baseEstimate(), formalPdfUrl: url });
  assertIncludes(withFormal.html, `href="${url}"`);
  assertIncludes(withFormal.html, "View your estimate (PDF)");
  assertIncludes(withFormal.text, `Estimate (PDF): ${url}`);
  // Both floor-plan and formal links coexist.
  assertIncludes(withFormal.html, "View your floor plan (PDF)");
  // Formal link alone (no floor-plan PDF) still renders.
  const only = estimateEmail({ ...baseEstimate(), pdfUrl: null, formalPdfUrl: url });
  assertIncludes(only.html, "View your estimate (PDF)");
  assertNotIncludes(only.html, "View your floor plan (PDF)");
  // Absent input — the pre-existing shape — renders no formal link at all.
  const without = estimateEmail(baseEstimate());
  assertNotIncludes(without.html, "View your estimate (PDF)");
  assertNotIncludes(without.text, "Estimate (PDF):");
});

// ── Per-tenant wording on the INVOICE email (migration 138) ──────────────────────────
// The wording screen offers an Invoice tab and email_save_template stores the "invoice"
// kind, so the builder's subject and opening line have to actually reach the invoice.

Deno.test("invoice tenant copy replaces the subject and the opening line", () => {
  const o = invoiceEmail({
    ...baseInvoice(),
    templateCopy: tplCopy({
      subject: "Invoice {number} for {total} from {business}",
      intro: "Your barn is on its way! Here is invoice {number} for {total}.",
    }),
  });
  assert(o.subject === "Invoice 000012 for $500.00 from Junior Barns", `subject was: ${o.subject}`);
  assertIncludes(o.html, "Your barn is on its way! Here is invoice 000012 for $500.00.");
  assertIncludes(o.text, "Your barn is on its way! Here is invoice 000012 for $500.00.");
  // The shipped wording is replaced, not appended.
  assertNotIncludes(o.html, "Thank you for your business.");
  assertNotIncludes(o.text, "Thank you for your business.");
  // Structure stays ours: the rows, the CTA and the footer are untouched by a wording edit.
  assertIncludes(o.html, "Amount due");
  assertIncludes(o.html, "View Invoice");
  assertIncludes(o.html, "Net 15.");
});

Deno.test("invoice copy on the sign path replaces the wording without touching the sign CTA", () => {
  const o = invoiceEmail({
    ...baseInvoice(),
    signUrl: "https://app.example.com/my-quotes?client=junior-barns",
    templateCopy: tplCopy({ subject: "Please sign invoice {number}", intro: "One last step — sign invoice {number}." }),
  });
  assert(o.subject === "Please sign invoice 000012", `subject was: ${o.subject}`);
  assertIncludes(o.html, "One last step — sign invoice 000012.");
  assertIncludes(o.html, "Review &amp; Sign Your Invoice");
  assertIncludes(o.text, "Review and sign your invoice: https://app.example.com/my-quotes?client=junior-barns");
});

Deno.test("invoice copy fills every token the wording screen advertises", () => {
  // {building} has no invoice-side value, but it must still resolve: fillTokens leaves an
  // UNKNOWN token verbatim, so an unsupplied one would ship a literal "{building}".
  const o = invoiceEmail({
    ...baseInvoice(),
    templateCopy: tplCopy({ subject: "{business} {number} {total} {building} {customer} {nope}" }),
  });
  assertNotIncludes(o.subject, "{building}");
  assertNotIncludes(o.subject, "{customer}");
  assertNotIncludes(o.subject, "{business}");
  assertNotIncludes(o.subject, "{number}");
  assertNotIncludes(o.subject, "{total}");
  assertIncludes(o.subject, "Junior Barns 000012 $500.00");
  // An unknown token stays verbatim on purpose — a typo the builder can see and fix.
  assertIncludes(o.subject, "{nope}");
  // Supplied by a caller that has the contact name, the {customer} token fills.
  const named = invoiceEmail({
    ...baseInvoice(),
    customerName: "Pat Example",
    templateCopy: tplCopy({ intro: "Hi {customer}, invoice {number} is ready." }),
  });
  assertIncludes(named.html, "Hi Pat Example, invoice 000012 is ready.");
});

Deno.test("invoice copy is escaped in the html half and raw in the text half", () => {
  // The intro is builder-authored text landing in a customer's inbox — the whole reason
  // the feature is copy-only. Escaping is what keeps it copy.
  const o = invoiceEmail({
    ...baseInvoice(),
    templateCopy: tplCopy({ intro: `Payment plans & terms: read "our policy" first.` }),
  });
  assertIncludes(o.html, "Payment plans &amp; terms: read &quot;our policy&quot; first.");
  assertNotIncludes(o.html, `read "our policy"`);
  assertIncludes(o.text, `Payment plans & terms: read "our policy" first.`);
});

Deno.test("invoice copy carrying markup is dropped, not half-escaped", () => {
  const o = invoiceEmail({
    ...baseInvoice(),
    templateCopy: tplCopy({ subject: "<b>Pay now</b>", intro: `<img src=x onerror=alert(1)>` }),
  });
  assertNotIncludes(o.html, "<b>");
  assertNotIncludes(o.html, "onerror");
  assertNotIncludes(o.subject, "<b>");
  // Dropping the field means the shipped wording shows, not a blank.
  assert(o.subject === "Invoice 000012 from Junior Barns", `subject was: ${o.subject}`);
  assertIncludes(o.html, "Thank you for your business.");
});

Deno.test("invoice subject stays one line even with tenant copy", () => {
  const o = invoiceEmail({
    ...baseInvoice(),
    businessName: "Acme\r\nBcc: evil@example.com",
    templateCopy: tplCopy({ subject: "Invoice {number}\nfrom {business}" }),
  });
  assert(!/[\r\n]/.test(o.subject), `subject must not contain CR/LF: ${JSON.stringify(o.subject)}`);
});

Deno.test("absent, blank or wrong-kind invoice copy keeps the shipped wording byte for byte", () => {
  // A tenant who never opens the wording screen must see no change whatsoever.
  const shipped = invoiceEmail(baseInvoice());
  const inert: unknown[] = [
    undefined,
    null,
    "not an object",
    42,
    {},
    { invoice: null },
    { invoice: {} },
    { invoice: { subject: "   ", intro: "" } },
    // Another kind's wording must never leak onto the invoice.
    { estimate: { subject: "Estimate wording" }, quote: { intro: "Quote wording" } },
  ];
  for (const templateCopy of inert) {
    const o = invoiceEmail({ ...baseInvoice(), templateCopy });
    assert(o.subject === shipped.subject, `subject drifted for ${JSON.stringify(templateCopy)}: ${o.subject}`);
    assert(o.html === shipped.html, `html drifted for ${JSON.stringify(templateCopy)}`);
    assert(o.text === shipped.text, `text drifted for ${JSON.stringify(templateCopy)}`);
  }
});
