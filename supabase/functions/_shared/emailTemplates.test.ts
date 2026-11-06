// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a
// machine with no registry access -- the same rule the other _shared tests follow.
// Preflight discovers _shared/*.test.ts automatically, so these run on every push.
import {
  acceptanceEmail,
  changeOrderEmail,
  cleanTemplateCopy,
  emailPictureUrl,
  esc,
  estimateEmail,
  formatMoney,
  invoiceEmail,
  invoiceRequestEmail,
  PREVIEW_SAMPLE,
  templatePreviewEmail,
  TEMPLATE_LIMITS,
  tenantCopy,
  tenantStylePhotoUrl,
  testEmail,
} from "./emailTemplates.ts";

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
function assertEq(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
  assertIncludes(q.html, "View &amp; Accept Your Quote");
  assertNotIncludes(q.html, "Your estimate is ready");
  assertIncludes(q.text, "Quote #: JB-1041");
  const e = estimateEmail(baseEstimate());
  assertIncludes(e.subject, "Your estimate EST-1042");
  assertIncludes(e.html, "View &amp; Accept Your Estimate");
});

// ── The QUOTE email carries no total (Carolyn, 2026-09-14) ───────────────────────────
// She highlighted "Quote total" in the Gmail preview and asked for it gone. The preview line
// is the preheader, so the amount has to leave all three places, not just the visible row.

Deno.test("quote email: no total in the html, the text, the subject or the inbox preview line", () => {
  const q = estimateEmail({ ...baseEstimate(), estimateNumber: "JB-1041", docWord: "quote" });
  for (const [label, s] of [["html", q.html], ["text", q.text], ["subject", q.subject]] as const) {
    assertNotIncludes(s, "$12,345.50", `quote ${label} must not show the amount`);
    assertNotIncludes(s, "12,345", `quote ${label} must not show any form of the amount`);
    assertNotIncludes(s, "Quote total", `quote ${label} must not carry a total row`);
  }
  // The preheader is the hidden first div; pin its exact wording so the preview reads right.
  assertIncludes(q.html, ">Your quote from Junior Barns is ready.</div>");
  // Everything else in the summary survives.
  assertIncludes(q.html, "JB-1041");
  assertIncludes(q.html, "Northwood - 12x24");
  assertIncludes(q.text, "Building: Northwood - 12x24");
});

Deno.test("quote email: the CTA says accept, never sign, in both halves", () => {
  const q = estimateEmail({ ...baseEstimate(), estimateNumber: "JB-1041", docWord: "quote" });
  assertIncludes(q.html, "View &amp; Accept Your Quote");
  assertIncludes(q.text, "View & accept your quote: https://pay.example.com/estimate/abc123");
  assertNotIncludes(q.html, "Sign Your Quote");
  assertNotIncludes(q.text.toLowerCase(), "sign your quote");
});

Deno.test("estimate (CRM) email is unchanged: total row, text line and the amount in the preview", () => {
  const e = estimateEmail(baseEstimate());
  assertIncludes(e.html, "Estimate total");
  assertIncludes(e.html, "$12,345.50");
  assertIncludes(e.html, ">Your estimate from Junior Barns is ready - $12,345.50.</div>");
  assertIncludes(e.text, "Estimate total: $12,345.50");
});

Deno.test("a builder's saved quote wording that uses {total} still fills it — never a literal token", () => {
  // The token stays in the map on purpose: a builder who wrote "{total}" into their own
  // subject or intro before the row was removed must not start sending customers "{total}".
  const q = estimateEmail({
    ...baseEstimate(),
    estimateNumber: "JB-1041",
    docWord: "quote",
    templateCopy: { quote: { subject: "Quote {number} for {total}", intro: "Your {building} comes to {total}." } },
  });
  assertEq(q.subject, "Quote JB-1041 for $12,345.50");
  assertIncludes(q.html, "Your Northwood - 12x24 comes to $12,345.50.");
  assertNotIncludes(q.subject + q.html + q.text, "{total}");
  // The builder chose to name the figure in their own words; the structural row stays gone.
  assertNotIncludes(q.html, "Quote total");
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

const baseInvoiceRequest = () => ({
  businessName: "Junior Barns",
  quoteNumber: "JB-1041",
  customerName: "Pat Example",
  styleLabel: "Northwood",
  sizeLabel: "12x24",
  total: 10505.14,
  acceptedAtIso: "2026-09-15T14:03:00.000Z",
  reviewUrl: "https://app.structurestudiosuite.com/portal/orders/o-3f2b8c1e-9a4d-4e6f-8b21-5c7d9e0a1b2c",
});

Deno.test("invoiceRequestEmail: subject, rows, date and the CTA to the order", () => {
  const o = invoiceRequestEmail(baseInvoiceRequest());
  assertEq(o.subject, "Invoice to approve: quote JB-1041 was accepted");
  assertIncludes(o.html, "Pat Example accepted quote JB-1041.");
  assertIncludes(o.html, "Northwood - 12x24");
  assertIncludes(o.html, "$10,505.14");
  assertIncludes(o.html, "2026-09-15");
  assertIncludes(o.html, `href="${baseInvoiceRequest().reviewUrl}"`);
  assertIncludes(o.html, "Review &amp; send invoice");
  assertIncludes(o.text, "Quote total: $10,505.14");
  assertIncludes(o.text, "Accepted: 2026-09-15");
  assertIncludes(o.text, `Review & send invoice: ${baseInvoiceRequest().reviewUrl}`);
  // The header is the builder's own business; the reader is the builder.
  assertIncludes(o.html, "Junior Barns");
});

Deno.test("invoiceRequestEmail never reads as though an invoice already exists", () => {
  // Nothing is numbered, built or sent until the builder approves (migration 229).
  const o = invoiceRequestEmail(baseInvoiceRequest());
  const all = o.subject + o.html + o.text;
  assertIncludes(o.text, "nothing has been sent to the customer yet");
  assertIncludes(o.html, "nothing has been sent to the customer yet");
  assertNotIncludes(all, "Invoice #");
  assertNotIncludes(all, "Amount due");
  assertNotIncludes(all.toLowerCase(), "invoice sent");
});

Deno.test("invoiceRequestEmail: optional fields absent leave no empty rows and still read", () => {
  const o = invoiceRequestEmail({ ...baseInvoiceRequest(), customerName: null, styleLabel: null, sizeLabel: " ", total: null });
  assertIncludes(o.html, "Your customer accepted quote JB-1041.");
  assertNotIncludes(o.html, ">Customer<");
  assertNotIncludes(o.html, ">Building<");
  assertNotIncludes(o.html, "Quote total");
  assertNotIncludes(o.text, "Customer:");
  assertNotIncludes(o.text, "Quote total:");
  assertIncludes(o.text, "Accepted: 2026-09-15");
});

Deno.test("invoiceRequestEmail: the wording names nothing of ours — only the portal link does", () => {
  // Not a white-label email (the reader is the builder, and the CTA must open our portal), but
  // the COPY carries no platform name, so a builder who forwards it forwards only a link.
  const o = invoiceRequestEmail(baseInvoiceRequest());
  const url = baseInvoiceRequest().reviewUrl;
  const copy = (o.subject + o.html.split(url).join("") + o.text.split(url).join("")).toLowerCase();
  for (const brand of ["structurestudio", "structure studio", "postmark", "csm synergy"]) {
    assertNotIncludes(copy, brand, `platform identifier "${brand}" in the wording`);
  }
});

Deno.test("invoiceRequestEmail escapes a hostile customer name and keeps the subject one line", () => {
  const o = invoiceRequestEmail({ ...baseInvoiceRequest(), customerName: `Pat <script>alert(1)</script>`, quoteNumber: "JB-1\r\nBcc: x@example.com" });
  assertNotIncludes(o.html, "<script>", "raw tag must never reach the html");
  assertIncludes(o.html, "&lt;script&gt;");
  assert(!/[\r\n]/.test(o.subject), `subject must be one line, got ${JSON.stringify(o.subject)}`);
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
    // invoiceRequestEmail is deliberately NOT here: it goes to the builder, and its button has
    // to open OUR portal, so its link names our host by necessity. Its copy is pinned below.
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

Deno.test("test email: the sender's signature sits under the message, escaped, after \"-- \" in the text", () => {
  // My Profile's email signature (2026-10-04). A test shows the sender how their emails end.
  const base = { businessName: "Acme Sheds", fromAddress: "info@acme-sheds.example.com" };
  const o = testEmail({ ...base, signature: `Pat <b>Lee</b>\r\nSales & delivery` });
  assertIncludes(o.html, "Pat &lt;b&gt;Lee&lt;/b&gt;<br>Sales &amp; delivery", "escaped, line by line");
  assertNotIncludes(o.html, "<b>Lee</b>", "markup in a signature never reaches the html");
  assert(o.html.indexOf("your sending domain is set up correctly") < o.html.indexOf("Pat &lt;b&gt;"), "under the message");
  assert(o.text.endsWith("set up correctly.\n\n-- \nPat <b>Lee</b>\nSales & delivery\n"), `text: ${JSON.stringify(o.text.slice(-80))}`);
  // None (or blank): the test email is byte for byte what it was before signatures.
  const plain = testEmail(base);
  for (const signature of [null, "", "   "]) {
    const t = testEmail({ ...base, signature });
    assertEq(t.html, plain.html, `html with signature ${JSON.stringify(signature)}`);
    assertEq(t.text, plain.text, `text with signature ${JSON.stringify(signature)}`);
  }
  assertNotIncludes(plain.text, "-- ", "no signature line without a signature");
});

// ── Wording beyond the subject and opening line (2026-10-04) ─────────────────────────
// Carolyn, 2026-08-21: "a template that they can edit, you know, for images and all of that
// stuff too". A closing message, the button's words and the building photo, as plain-text
// blocks: the structure (where the button goes, the rows, the links, the footer) stays ours.
// The "nothing saved means nothing changes" half is emailTemplates.golden.test.ts.

const STORAGE = "https://ref.supabase.example";
const acmeQuote = () => ({
  businessName: "Acme Sheds",
  phone: "(555) 555-0100",
  website: "acmesheds.example.com",
  estimateNumber: "AS-1041",
  total: 8400,
  styleLabel: "Lofted Barn",
  sizeLabel: "12x24",
  estimateUrl: "https://app.example.com/my-quotes?client=acme-sheds",
  pdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123.pdf",
  formalPdfUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123-quote.pdf",
  quoteTerms: "Quote good for 30 days.",
  docWord: "quote" as "quote" | "estimate" | undefined,
});
const acmeInvoice = () => ({
  businessName: "Acme Sheds",
  invoiceNumber: "000031",
  total: "$2,000.00",
  invoiceUrl: "https://storage.example.com/floor-plans/acme-sheds/SS-ABC123-invoice.pdf",
  quoteTerms: "Net 15.",
});
const PHOTO = `${STORAGE}/storage/v1/object/public/branding/acme-sheds/style-lofted-barn.jpg`;

Deno.test("closing and button are escaped in the html and raw in the text", () => {
  const q = estimateEmail({
    ...acmeQuote(),
    templateCopy: { quote: { closing: `Questions? Call "Pat" & we'll help.`, button: `See "your" quote & more` } },
  });
  assertIncludes(q.html, "Questions? Call &quot;Pat&quot; &amp; we&#39;ll help.");
  assertIncludes(q.html, ">See &quot;your&quot; quote &amp; more</a>");
  assertNotIncludes(q.html, `Call "Pat"`);
  assertIncludes(q.text, `Questions? Call "Pat" & we'll help.`);
  assertIncludes(q.text, `See "your" quote & more: https://app.example.com/my-quotes?client=acme-sheds`);
});

Deno.test("markup in the closing or the button is dropped on the way out, so ours shows instead", () => {
  const q = estimateEmail({
    ...acmeQuote(),
    templateCopy: { quote: { closing: `<img src=x onerror=alert(1)> thanks`, button: "<b>Pay</b>" } },
  });
  assertNotIncludes(q.html, "onerror");
  assertNotIncludes(q.html, "<b>");
  assertIncludes(q.html, ">View &amp; Accept Your Quote</a>");
  assertEq(estimateEmail(acmeQuote()).html, q.html, "a dropped closing and button leave the shipped email");
});

Deno.test("line breaks survive in the closing only; the subject and button are flattened", () => {
  // The subject is a mail header: a CR/LF there is header injection. The button is one line by
  // nature. The closing is the one field meant to hold a few lines (a sign-off, a phone number).
  const q = estimateEmail({
    ...acmeQuote(),
    templateCopy: {
      quote: {
        subject: "Quote {number}\r\nBcc: someone@example.com",
        button: "View\r\nBcc: someone@example.com",
        closing: "Thanks again!\r\n\r\nPat Lee\rAcme Sheds",
      },
    },
  });
  assert(!/[\r\n]/.test(q.subject), `subject must be one line: ${JSON.stringify(q.subject)}`);
  assertEq(q.subject, "Quote AS-1041 Bcc: someone@example.com");
  assertIncludes(q.html, ">View Bcc: someone@example.com</a>");
  assertIncludes(q.text, "View Bcc: someone@example.com: https://app.example.com/my-quotes?client=acme-sheds");
  assertIncludes(q.html, "Thanks again!<br><br>Pat Lee<br>Acme Sheds</p>");
  assertIncludes(q.text, "Thanks again!\n\nPat Lee\nAcme Sheds\n");
});

Deno.test("the closing sits after the button and both PDF links, in both halves, above the footer", () => {
  const q = estimateEmail({ ...acmeQuote(), templateCopy: { quote: { closing: "See you on delivery day." } } });
  const at = (s: string, n: string) => {
    const i = s.indexOf(n);
    assert(i >= 0, `missing ${JSON.stringify(n)}`);
    return i;
  };
  assert(at(q.html, "View &amp; Accept Your Quote") < at(q.html, "See you on delivery day."), "html: after the button");
  assert(at(q.html, "View your quote (PDF)") < at(q.html, "See you on delivery day."), "html: after the PDF links");
  assert(at(q.html, "See you on delivery day.") < at(q.html, "Quote good for 30 days."), "html: above the terms");
  assert(at(q.text, "Quote (PDF): ") < at(q.text, "See you on delivery day."), "text: after the links");
  assert(at(q.text, "See you on delivery day.") < at(q.text, "Quote good for 30 days."), "text: above the terms");
  assertIncludes(q.text, "-quote.pdf\n\nSee you on delivery day.\n\nAcme Sheds |", "one blank line each side");
  // No links at all: still exactly one blank line above it.
  const bare = estimateEmail({ businessName: "Acme Sheds", estimateNumber: "AS-1", total: 1, templateCopy: { estimate: { closing: "Bye." } } });
  assertIncludes(bare.text, "Estimate total: $1.00\n\nBye.\n\nAcme Sheds\n");
});

Deno.test("button text changes the button's words, never where it goes", () => {
  const url = acmeQuote().estimateUrl;
  const q = estimateEmail({ ...acmeQuote(), templateCopy: { quote: { button: "View Shed Quote" } } });
  assertIncludes(q.html, `href="${esc(url)}"`);
  assertIncludes(q.html, ">View Shed Quote</a>");
  assertNotIncludes(q.html, "View &amp; Accept Your Quote");
  assertIncludes(q.text, `View Shed Quote: ${url}`);
  assertNotIncludes(q.text, "View & accept your quote");
  // No hosted page, no button: the words have nothing to sit on.
  const noCta = estimateEmail({ ...acmeQuote(), estimateUrl: null, templateCopy: { quote: { button: "View Shed Quote" } } });
  assertNotIncludes(noCta.html + noCta.text, "View Shed Quote");
});

Deno.test("invoice wording: closing and button on the sign path and the view path", () => {
  const signUrl = "https://app.example.com/my-quotes?client=acme-sheds";
  const copy = { invoice: { button: "Sign invoice {number}", closing: "Thank you, {customer}!" } };
  const s = invoiceEmail({ ...acmeInvoice(), signUrl, customerName: "Alex Smith", templateCopy: copy });
  assertIncludes(s.html, `href="${esc(signUrl)}"`);
  assertIncludes(s.html, ">Sign invoice 000031</a>");
  assertIncludes(s.html, "Thank you, Alex Smith!</p>");
  assertIncludes(s.text, `Sign invoice 000031: ${signUrl}`);
  assertIncludes(s.text, `Invoice (PDF): ${acmeInvoice().invoiceUrl}`, "the demoted PDF line keeps its own words");
  assertIncludes(s.text, "Thank you, Alex Smith!");
  assert(s.html.indexOf("View the invoice (PDF)") < s.html.indexOf("Thank you, Alex Smith!"), "closing after the PDF link");
  const v = invoiceEmail({ ...acmeInvoice(), customerName: "Alex Smith", templateCopy: copy });
  assertIncludes(v.html, `href="${acmeInvoice().invoiceUrl}"`);
  assertIncludes(v.html, ">Sign invoice 000031</a>");
  assertIncludes(v.text, `Sign invoice 000031: ${acmeInvoice().invoiceUrl}`);
});

Deno.test("{customer} fills on the estimate and the quote, and is blank (not literal) without a name", () => {
  const copy = { subject: "{customer}, your quote {number}", intro: "Hi {customer}!", closing: "Bye {customer}.", button: "Open it, {customer}" };
  const named = estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", templateCopy: { quote: copy } });
  assertEq(named.subject, "Alex Smith, your quote AS-1041");
  assertIncludes(named.html, "Hi Alex Smith!");
  assertIncludes(named.html, "Bye Alex Smith.");
  assertIncludes(named.html, ">Open it, Alex Smith</a>");
  const est = estimateEmail({ ...acmeQuote(), docWord: undefined, customerName: "Alex Smith", templateCopy: { estimate: { intro: "Hi {customer}!" } } });
  assertIncludes(est.html, "Hi Alex Smith!");
  const unnamed = estimateEmail({ ...acmeQuote(), templateCopy: { quote: copy } });
  assertNotIncludes(unnamed.subject + unnamed.html + unnamed.text, "{customer}");
});

Deno.test("a button that fills to nothing falls back to ours rather than an empty button", () => {
  const q = estimateEmail({ ...acmeQuote(), templateCopy: { quote: { button: "{customer}" } } });
  assertIncludes(q.html, ">View &amp; Accept Your Quote</a>");
  assertIncludes(q.text, "View & accept your quote: ");
});

Deno.test("the building photo: drawn above the details for an https address, and only then", () => {
  const q = estimateEmail({ ...acmeQuote(), pictureUrl: PHOTO });
  assertIncludes(q.html, `<img src="${PHOTO}" alt="Lofted Barn - 12x24" width="536"`);
  assert(q.html.indexOf(PHOTO) > q.html.indexOf("Your quote is ready."), "under the opening line");
  assert(q.html.indexOf(PHOTO) < q.html.indexOf("Quote #"), "above the detail rows");
  assertNotIncludes(q.text, PHOTO, "the text half has no picture");
  const est = estimateEmail({ ...acmeQuote(), docWord: undefined, pictureUrl: PHOTO });
  assertIncludes(est.html, `<img src="${PHOTO}"`);
  // Never anything but https.
  for (const bad of ["http://storage.example.com/a.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "//storage.example.com/a.jpg", `https://storage.example.com/a.jpg" onerror="x`]) {
    const o = estimateEmail({ ...acmeQuote(), pictureUrl: bad });
    assertEq(o.html, estimateEmail(acmeQuote()).html, `no picture for ${bad}`);
  }
});

Deno.test("the builder can switch the photo off, per kind; the switch never reaches the invoice", () => {
  const off = estimateEmail({ ...acmeQuote(), pictureUrl: PHOTO, templateCopy: { quote: { picture: false } } });
  assertNotIncludes(off.html, "<img src=");
  // Switched off on the ESTIMATE tab: the quote still shows it.
  const other = estimateEmail({ ...acmeQuote(), pictureUrl: PHOTO, templateCopy: { estimate: { picture: false } } });
  assertIncludes(other.html, `<img src="${PHOTO}"`);
  assertEq(tenantCopy({ invoice: { picture: false } }, "invoice").picture, undefined);
  // Only false counts: anything else is the default, on.
  for (const picture of [true, "false", 0, null]) {
    assertIncludes(estimateEmail({ ...acmeQuote(), pictureUrl: PHOTO, templateCopy: { quote: { picture } } }).html, `<img src="${PHOTO}"`);
  }
});

Deno.test("tenantCopy cuts each field to its limit, counting characters rather than code units", () => {
  const long = "\u{1F600}".repeat(1200);
  const c = tenantCopy({ quote: { closing: long, button: long, subject: long, intro: long } }, "quote");
  assertEq(Array.from(c.closing ?? "").length, TEMPLATE_LIMITS.closing);
  assertEq(Array.from(c.button ?? "").length, TEMPLATE_LIMITS.button);
  assertEq(Array.from(c.subject ?? "").length, TEMPLATE_LIMITS.subject);
  assertEq(Array.from(c.intro ?? "").length, TEMPLATE_LIMITS.intro);
  assertEq(c.button, "\u{1F600}".repeat(TEMPLATE_LIMITS.button), "no emoji cut in half");
});

Deno.test("cleanTemplateCopy: keeps what says something, refuses markup by name, stores the photo switch only as false", () => {
  const r = cleanTemplateCopy({
    estimate: { subject: "  Your   estimate  ", intro: "", closing: " Thanks!\r\nPat \n", button: " Open ", picture: false },
    quote: { subject: "", intro: "   ", closing: "", button: "", picture: true },
    invoice: { closing: "Pay by check.", picture: false },
    other: { subject: "ignored" },
  });
  assert("copy" in r, "expected a clean copy");
  if (!("copy" in r)) return;
  assertEq(JSON.stringify(r.copy), JSON.stringify({
    estimate: { subject: "Your estimate", closing: "Thanks!\nPat", button: "Open", picture: false },
    invoice: { closing: "Pay by check." },
  }));
  for (const [field, words] of [["subject", "subject"], ["intro", "opening line"], ["closing", "closing message"], ["button", "button text"]]) {
    const bad = cleanTemplateCopy({ quote: { [field]: "Hi <b>there</b>" } });
    assert("error" in bad, `${field} with markup must be refused`);
    if ("error" in bad) assertEq(bad.error, `Remove the < > characters from the estimate ${words} — this is plain text, not HTML.`);
    // The "estimate" (CRM) key is the tab the editor calls "CRM estimate".
    const crm = cleanTemplateCopy({ estimate: { [field]: "Hi <b>there</b>" } });
    if ("error" in crm) assertEq(crm.error, `Remove the < > characters from the CRM estimate ${words} — this is plain text, not HTML.`);
  }
  const none = cleanTemplateCopy(null);
  assert("error" in none && none.error === "Nothing to save.", "null is nothing to save");
  // A lone half of an emoji would make jsonb refuse the whole write.
  const half = cleanTemplateCopy({ quote: { closing: "Thanks \uD83D" } });
  assert("copy" in half && half.copy.quote?.closing === "Thanks \uFFFD", JSON.stringify(half));
});

Deno.test("emailPictureUrl and tenantStylePhotoUrl: https, and only this builder's own folder", () => {
  assertEq(emailPictureUrl(" https://a.example.com/x.jpg "), "https://a.example.com/x.jpg");
  for (const bad of [null, "", "http://a.example.com/x.jpg", "https://", "https://a.example.com/a b.jpg", `https://a.example.com/x".jpg`, "https://a.example.com/" + "x".repeat(2100)]) {
    assertEq(emailPictureUrl(bad), null, `refused: ${String(bad).slice(0, 40)}`);
  }
  const own = (p: string) => tenantStylePhotoUrl(`${STORAGE}/storage/v1/object/public/${p}`, STORAGE, "acme-sheds");
  assertEq(own("branding/acme-sheds/style.jpg"), `${STORAGE}/storage/v1/object/public/branding/acme-sheds/style.jpg`);
  assertEq(own("fixtures/acme-sheds/door.jpg"), `${STORAGE}/storage/v1/object/public/fixtures/acme-sheds/door.jpg`);
  // Another builder's folder (a catalog copied from a demo account points there), a climb out of
  // the folder, a private bucket, a bare-prefix match on a longer tenant id, another host: all refused.
  assertEq(own("branding/demo-builder/style.jpg"), null);
  assertEq(own("branding/acme-sheds/../demo-builder/style.jpg"), null);
  assertEq(own("signatures/acme-sheds/sig.png"), null);
  assertEq(own("branding/acme-sheds-2/style.jpg"), null);
  assertEq(tenantStylePhotoUrl("https://cdn.example.com/branding/acme-sheds/style.jpg", STORAGE, "acme-sheds"), null);
  assertEq(tenantStylePhotoUrl(`${STORAGE}/storage/v1/object/public/branding/acme-sheds/style.jpg`, `${STORAGE}/`, "acme-sheds"),
    `${STORAGE}/storage/v1/object/public/branding/acme-sheds/style.jpg`, "a trailing slash on the project URL is fine");
  assertEq(tenantStylePhotoUrl(PHOTO, "", "acme-sheds"), null);
  assertEq(tenantStylePhotoUrl(PHOTO, STORAGE, ""), null);
});

Deno.test("preview: the builder's own header, footer and photo around a sample customer and document", () => {
  const base = { businessName: "Acme Sheds", phone: "(555) 555-0100", website: "acmesheds.example.com", quoteTerms: "Quote good for 30 days." };
  const q = templatePreviewEmail({
    ...base, kind: "quote", pictureUrl: PHOTO, styleLabel: "Lofted Barn",
    copy: { subject: "Your quote {number}, {customer}", closing: "Thanks!", button: "View Shed Quote" },
  });
  assertEq(q.subject, `Your quote ${PREVIEW_SAMPLE.number}, ${PREVIEW_SAMPLE.customerName}`);
  assertIncludes(q.html, ">View Shed Quote</a>");
  assertIncludes(q.html, "Thanks!</p>");
  assertIncludes(q.html, `<img src="${PHOTO}" alt="Lofted Barn - 12x24"`);
  assertIncludes(q.html, "Quote good for 30 days.");
  assertIncludes(q.html, "acmesheds.example.com");
  // Every link in a sample leads nowhere (the website link in the footer is the builder's own).
  const hrefs = [...q.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h.includes("acmesheds.example.com"));
  assert(hrefs.length >= 3 && hrefs.every((h) => h === "#"), `sample links: ${JSON.stringify(hrefs)}`);
  const off = templatePreviewEmail({ ...base, kind: "quote", pictureUrl: PHOTO, copy: { picture: false } });
  assertNotIncludes(off.html, "<img src=");
  const sign = templatePreviewEmail({ ...base, kind: "invoice", copy: {}, invoiceToSign: true });
  assertIncludes(sign.html, "Review &amp; Sign Your Invoice");
  const view = templatePreviewEmail({ ...base, kind: "invoice", copy: {}, invoiceToSign: false });
  assertIncludes(view.html, ">View Invoice</a>");
  const est = templatePreviewEmail({ ...base, kind: "estimate", copy: {} });
  assertIncludes(est.html, "Estimate total");
  assertIncludes(est.html, PREVIEW_SAMPLE.styleLabel);
});

Deno.test("white-label: the new wording blocks and the photo add no platform branding", () => {
  const copy = { subject: "S {business}", intro: "I {number}", closing: "C {customer}\nbye", button: "B {total}", picture: true };
  const outs = [
    estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", pictureUrl: PHOTO, templateCopy: { quote: copy } }),
    estimateEmail({ ...acmeQuote(), docWord: undefined, pictureUrl: PHOTO, templateCopy: { estimate: copy } }),
    invoiceEmail({ ...acmeInvoice(), signUrl: "https://app.example.com/my-quotes?client=acme-sheds", templateCopy: { invoice: copy } }),
    templatePreviewEmail({ kind: "quote", copy, businessName: "Acme Sheds", pictureUrl: PHOTO }),
  ];
  for (const o of outs) {
    const all = (o.subject + o.html + o.text).toLowerCase();
    for (const brand of ["structurestudio", "structure studio", "postmark", "csm synergy", "resend"]) {
      assertNotIncludes(all, brand, `platform identifier "${brand}" leaked`);
    }
  }
});

// ── THE PHOTO-HEADER DESIGN (Carolyn 2026-10-14) ──────────────────────────────────────────
// Her GHL email: photo, rule, "We're getting closer, {first}", paragraphs, a wide green button, a
// slogan, "Thanks," and a signature card. Opt-in per kind with layout "photo"; everything else in
// this file (and the golden test) pins that a builder who never switches it on sees no change.

const HERO = `${STORAGE}/storage/v1/object/public/branding/acme-sheds/email-hero-1.jpg`;
const BANNER = `${STORAGE}/storage/v1/object/public/branding/acme-sheds/email-footer-1.jpg`;
const photoCopy = () => ({
  layout: "photo",
  subject: "Your shed estimate is here!",
  hero: HERO,
  heading: "We're getting closer, {first}",
  message: "Hi {first},\n\nHere is the estimate for your new shed! Please click the button below.\n\n*If you have any changes, let me know.*\n\n**Click Accept to move this order forward!**",
  button: "VIEW SHED ESTIMATE",
  tagline: "EVERYONE NEEDS *a little space* IN THEIR LIFE",
  closing: "Thanks,",
  signName: "Pat Miller",
  signTitle: "Owner/Manager",
  footer: BANNER,
  accent: "#F47B2A",
  buttonColor: "#2cab05",
});
const ADDRESS = { addressLine1: "1 Barn Way", city: "Springfield", state: "MO", postalCode: "65801", countryCode: "US" };
const photoQuote = (copy: Record<string, unknown> = photoCopy(), extra: Record<string, unknown> = {}) =>
  estimateEmail({ ...acmeQuote(), logoUrl: "https://example.com/logo.png", customerName: "Alex Smith", address: ADDRESS, templateCopy: { quote: copy }, ...extra });

Deno.test("photo design: photo, heading, paragraphs, wide button, slogan, signature and banner, in her order", () => {
  const q = photoQuote();
  assertEq(q.subject, "Your shed estimate is here!");
  const order = [
    `src="${HERO}"`,
    ">We&#39;re getting closer, Alex</h2>",
    ">Hi Alex,</p>",
    "<em>If you have any changes, let me know.</em>",
    "<strong>Click Accept to move this order forward!</strong>",
    ">VIEW SHED ESTIMATE</a>",
    "Estimate #AS-1041 · Lofted Barn - 12x24",
    "View your floor plan (PDF)",
    ">a little space</span>",
    ">Thanks,</p>",
    ">Pat Miller</p>",
    ">Acme Sheds</p>",
    ">Owner/Manager</p>",
    `<img src="https://example.com/logo.png"`,
    ">1 Barn Way, Springfield, MO 65801</p>",
    ">acmesheds.example.com</a>",
    ">(555) 555-0100</p>",
    `src="${BANNER}"`,
    "All rights reserved.",
    "Quote good for 30 days.",
  ];
  let at = -1;
  for (const needle of order) {
    const i = q.html.indexOf(needle, at + 1);
    assert(i > at, `expected ${JSON.stringify(needle)} after the previous piece (found at ${i}, previous ${at})`);
    at = i;
  }
  // The photo opens the same page the button does, the way hers is linked.
  assertIncludes(q.html, `<a href="https://app.example.com/my-quotes?client=acme-sheds" target="_blank" style="text-decoration:none;"><img src="${HERO}"`);
  // Colours: the accent is stored lowercase and drawn on the rules; the button is a filled cell.
  assertIncludes(q.html, `bgcolor="#f47b2a"`);
  assertIncludes(q.html, `bgcolor="#2cab05" style="background-color:#2cab05;padding:14px 25px;"`);
  // No total on a quote email, here either (Carolyn 2026-09-14).
  for (const s of [q.html, q.text, q.subject]) assertNotIncludes(s, "8,400");
    assertIncludes(q.html, ">Your estimate from Acme Sheds is ready.</div>");
});

Deno.test("photo design: every word a reader sees says estimate, never quote (Carolyn Q12)", () => {
  // Terms are the builder's own words; ours are what this pins.
  for (const o of [photoQuote({ layout: "photo" }, { quoteTerms: "Good for 30 days." }), photoQuote({ layout: "photo" }, { docWord: undefined, quoteTerms: "Good for 30 days." })]) {
    // Addresses are identifiers (my-quotes, -quote.pdf); everything a person reads is checked.
    const read = (o.subject + o.html.replace(/(href|src)="[^"]*"/g, "") + o.text.replace(/https?:\/\/\S+/g, "")).toLowerCase();
    assert(!/\bquot(e|es|ed|ing)\b/.test(read), `a reader sees "quote": ${read.match(/.{0,40}\bquote.{0,40}/)?.[0]}`);
  }
  const d = photoQuote({ layout: "photo" });
  assertEq(d.subject, "Your estimate AS-1041 from Acme Sheds");
  assertIncludes(d.html, "View your estimate (PDF)");
});

Deno.test("photo design: the website reads without https:// and a slash, a bare 10-digit phone gets its dashes", () => {
  const o = photoQuote({ layout: "photo" }, { website: "https://acmesheds.example.com/", phone: "5555550100" });
  assertIncludes(o.html, `href="https://acmesheds.example.com/"`);
  assertIncludes(o.html, ">acmesheds.example.com</a>");
  assertIncludes(o.html, ">(555) 555-0100</p>");
  assertIncludes(o.text, "(555) 555-0100 | acmesheds.example.com");
  const typed = photoQuote({ layout: "photo" }, { phone: "707.725.2276" });
  assertIncludes(typed.html, ">707.725.2276</p>");
});

Deno.test("photo design: the text half reads the same email without markers", () => {
  const q = photoQuote();
  for (const line of [
    "We're getting closer, Alex",
    "Hi Alex,",
    "If you have any changes, let me know.",
    "Click Accept to move this order forward!",
    "VIEW SHED ESTIMATE: https://app.example.com/my-quotes?client=acme-sheds",
    "Estimate #: AS-1041",
    "Floor plan (PDF): https://storage.example.com/floor-plans/acme-sheds/SS-ABC123.pdf",
    "EVERYONE NEEDS a little space IN THEIR LIFE",
    "Thanks,\nPat Miller\nAcme Sheds\nOwner/Manager\n1 Barn Way, Springfield, MO 65801\n(555) 555-0100 | acmesheds.example.com",
    "Quote good for 30 days.",
  ]) assertIncludes(q.text, line);
  assertNotIncludes(q.text, "**");
  assertNotIncludes(q.text, "*a little");
  assertNotIncludes(q.text, "<");
});

Deno.test("photo design: with no name on the design, no dangling comma and a polite greeting", () => {
  const q = photoQuote(photoCopy(), { customerName: "" });
  assertIncludes(q.html, ">We&#39;re getting closer</h2>");
  assertIncludes(q.html, ">Hi,</p>");
  const d = photoQuote({ layout: "photo" }, { customerName: undefined });
  assertIncludes(d.html, ">We&#39;re getting closer</h2>");
  assertIncludes(d.html, ">Hi there,</p>");
  assertIncludes(d.html, ">VIEW YOUR ESTIMATE</a>");
  assertIncludes(d.html, ">Thanks,</p>");
});

Deno.test("photo design: ours when nothing is typed, and the floor plan sentence only with a floor plan", () => {
  const d = photoQuote({ layout: "photo" });
  assertIncludes(d.html, ">We&#39;re getting closer, Alex</h2>");
  assertIncludes(d.html, "Your floor plan, with everything you chose, is linked below.");
  assertIncludes(d.html, `bgcolor="#2cab05"`);
  assertIncludes(d.html, `bgcolor="#f47b2a"`);
  const noPlan = photoQuote({ layout: "photo" }, { pdfUrl: null });
  assertNotIncludes(noPlan.html, "Your floor plan");
  // No top photo and no building photo: the logo and the name open it, like the classic card.
  assertIncludes(d.html, `<img src="https://example.com/logo.png" alt="Acme Sheds" width="170"`);
});

Deno.test("photo design: the building photo takes the top when there is no top photo, and only then", () => {
  const withPic = photoQuote({ layout: "photo" }, { pictureUrl: PHOTO });
  assertIncludes(withPic.html, `<img src="${PHOTO}" alt="Acme Sheds" width="560"`);
  const both = photoQuote({ layout: "photo", hero: HERO }, { pictureUrl: PHOTO });
  assertIncludes(both.html, `src="${HERO}"`);
  assertNotIncludes(both.html, PHOTO);
  const off = photoQuote({ layout: "photo", picture: false }, { pictureUrl: PHOTO });
  assertNotIncludes(off.html, PHOTO);
});

Deno.test("photo design: every builder value is escaped, and markup is dropped on the way out", () => {
  const hostile = `<script>alert(1)</script> & "q"`;
  const q = photoQuote({ ...photoCopy(), heading: `Hi "you" & co`, signName: `Pat "P" & Co`, tagline: `A & B *c & d*` }, { customerName: hostile });
  assertNotIncludes(q.html, "<script>");
  assertIncludes(q.html, "Hi &quot;you&quot; &amp; co");
  assertIncludes(q.html, "Pat &quot;P&quot; &amp; Co");
  assertIncludes(q.html, "A &amp; B <span");
  assertIncludes(q.html, ">c &amp; d</span>");
  // A field with markup in it never reaches the email: tenantCopy drops it and ours shows.
  const m = photoQuote({ layout: "photo", heading: "<b>x</b>", message: "<img src=x>" });
  assertIncludes(m.html, ">We&#39;re getting closer, Alex</h2>");
  assertNotIncludes(m.html, "src=x");
  // A picture that isn't https:// is never drawn.
  const bad = photoQuote({ layout: "photo", hero: "http://example.com/a.jpg", footer: "javascript:alert(1)" });
  assertNotIncludes(bad.html, "http://example.com/a.jpg");
  assertNotIncludes(bad.html, "javascript:");
});

Deno.test("photo design: a light button colour gets dark words, a dark one white", () => {
  const light = photoQuote({ layout: "photo", buttonColor: "#ffe066" });
  assertIncludes(light.html, "color:#111111;text-decoration:none;\">VIEW YOUR ESTIMATE</a>");
  const dark = photoQuote({ layout: "photo", buttonColor: "#1e3a8a" });
  assertIncludes(dark.html, "color:#FFFFFF;text-decoration:none;\">VIEW YOUR ESTIMATE</a>");
});

Deno.test("photo design fields without the switch change nothing: the classic card is the same bytes", () => {
  const { layout: _l, ...rest } = photoCopy();
  const plain = estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", templateCopy: { quote: { subject: rest.subject, button: rest.button, closing: rest.closing } } });
  const stored = estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", address: ADDRESS, templateCopy: { quote: rest } });
  assertEq(stored.html, plain.html, "html");
  assertEq(stored.text, plain.text, "text");
  assertEq(stored.subject, plain.subject, "subject");
  // And a layout that isn't "photo" is the classic card too.
  const odd = estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", templateCopy: { quote: { ...rest, layout: "fancy" } } });
  assertEq(odd.html, plain.html, "unknown layout");
});

Deno.test("photo design is estimate and quote only: the invoice ignores it", () => {
  const inv = invoiceEmail({ ...acmeInvoice(), templateCopy: { invoice: photoCopy() } });
  const plain = invoiceEmail({ ...acmeInvoice(), templateCopy: { invoice: { subject: "Your shed estimate is here!", button: "VIEW SHED ESTIMATE", closing: "Thanks," } } });
  assertEq(inv.html, plain.html);
  const c = cleanTemplateCopy({ invoice: photoCopy() });
  assert(!("error" in c), "an invoice with photo fields still saves");
  const kept = "copy" in c ? c.copy.invoice ?? {} : {};
  for (const f of ["layout", "hero", "heading", "message", "tagline", "signName", "signTitle", "footer", "accent", "buttonColor"]) {
    assert(!(f in kept), `invoice kept ${f}`);
  }
});

Deno.test("cleanTemplateCopy keeps the photo design and refuses what it can't use, out loud", () => {
  const c = cleanTemplateCopy({ quote: photoCopy() });
  assert("copy" in c, JSON.stringify(c));
  const q = "copy" in c ? c.copy.quote! : {};
  assertEq(q.layout, "photo");
  assertEq(q.hero, HERO);
  assertEq(q.footer, BANNER);
  assertEq(q.accent, "#f47b2a", "colour stored lowercase");
  assertEq(q.message, photoCopy().message, "the message keeps its blank lines");
  assertEq(q.tagline, photoCopy().tagline);
  const httpHero = cleanTemplateCopy({ quote: { layout: "photo", hero: "http://example.com/a.jpg" } });
  assert("error" in httpHero && /top photo must be an https/.test(httpHero.error), JSON.stringify(httpHero));
  const badBanner = cleanTemplateCopy({ estimate: { footer: "data:image/png;base64,AAAA" } });
  assert("error" in badBanner && /bottom banner/.test(badBanner.error), JSON.stringify(badBanner));
  const badColour = cleanTemplateCopy({ quote: { accent: "red" } });
  assert("error" in badColour && /accent colour must be a colour like/.test(badColour.error), JSON.stringify(badColour));
  const url = cleanTemplateCopy({ quote: { buttonColor: "url(x)" } });
  assert("error" in url && /button colour/.test(url.error), JSON.stringify(url));
  const tag = cleanTemplateCopy({ quote: { heading: "<b>hi</b>" } });
  assert("error" in tag && /heading/.test(tag.error), JSON.stringify(tag));
  // "Classic" is stored as no layout at all, never as a value.
  const classic = cleanTemplateCopy({ quote: { layout: "", heading: "Kept" } });
  assert("copy" in classic && classic.copy.quote?.layout === undefined && classic.copy.quote?.heading === "Kept", JSON.stringify(classic));
  // The limits hold for the new words.
  const long = cleanTemplateCopy({ quote: { heading: "x".repeat(400), message: "y".repeat(4000) } });
  assert("copy" in long && long.copy.quote?.heading?.length === TEMPLATE_LIMITS.heading && long.copy.quote?.message?.length === TEMPLATE_LIMITS.message, "limits");
});

Deno.test("{first} fills in every document email, classic and invoice too", () => {
  const q = estimateEmail({ ...acmeQuote(), customerName: "Alex Smith", templateCopy: { quote: { intro: "Hi {first}!" } } });
  assertIncludes(q.html, ">Hi Alex!</p>");
  const inv = invoiceEmail({ ...acmeInvoice(), customerName: "Alex Smith", templateCopy: { invoice: { intro: "Hi {first}!" } } });
  assertIncludes(inv.html, "Hi Alex!");
  assertNotIncludes(inv.html + inv.text, "{first}");
});

Deno.test("the Preview draws the photo design with the builder's address", () => {
  const p = templatePreviewEmail({ kind: "quote", copy: photoCopy() as never, businessName: "Acme Sheds", address: ADDRESS, phone: "(555) 555-0100" });
  assertIncludes(p.html, `src="${HERO}"`);
  assertIncludes(p.html, `>We&#39;re getting closer, ${PREVIEW_SAMPLE.customerName.split(" ")[0]}</h2>`);
  assertIncludes(p.html, ">1 Barn Way, Springfield, MO 65801</p>");
  const hrefs = [...p.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h.includes("example.com"));
  assert(hrefs.length >= 2 && hrefs.every((h) => h === "#"), `sample links: ${JSON.stringify(hrefs)}`);
});

Deno.test("white-label: the photo design adds no platform branding", () => {
  const outs = [photoQuote(), photoQuote({ layout: "photo" }), templatePreviewEmail({ kind: "quote", copy: photoCopy() as never, businessName: "Acme Sheds" })];
  for (const o of outs) {
    const all = (o.subject + o.html + o.text).toLowerCase();
    for (const brand of ["structurestudio", "structure studio", "postmark", "csm synergy", "resend"]) {
      assertNotIncludes(all, brand, `platform identifier "${brand}" leaked`);
    }
  }
});

Deno.test("photo design: a * in the customer's or the business's name stays a *, never formatting", () => {
  const q = estimateEmail({
    ...acmeQuote(), businessName: "A*Star Barns", customerName: "Jo*Anne Smith",
    templateCopy: { quote: { layout: "photo", message: "Hi {first}, thanks for choosing {business}! *Any changes, just reply.*", tagline: "{business} builds *a little space*" } },
  });
  assertIncludes(q.html, ">Hi Jo*Anne, thanks for choosing A*Star Barns! <em>Any changes, just reply.</em></p>");
  assertIncludes(q.html, "A*Star Barns builds <span");
  assertIncludes(q.html, ">a little space</span>");
  assertIncludes(q.text, "Hi Jo*Anne, thanks for choosing A*Star Barns! Any changes, just reply.");
  const d = estimateEmail({ ...acmeQuote(), customerName: "Jo*Anne", templateCopy: { quote: { layout: "photo" } } });
  assertIncludes(d.html, ">Hi Jo*Anne,</p>");
  assertNotIncludes(d.html + d.text, "\uE000");
});

Deno.test("photo design: markers count only around words, the way people write them", () => {
  const m = (message: string, extra: Record<string, unknown> = {}) =>
    photoQuote({ layout: "photo", message }, extra);
  const nested = m("**Call *today* to lock in your price**");
  assertIncludes(nested.html, "<strong>Call <em>today</em> to lock in your price</strong>");
  assertIncludes(nested.text, "Call today to lock in your price");
  assertNotIncludes(nested.text, "*");
  const stray = m("Free delivery* within 50 miles. *Ask about rent-to-own*");
  assertIncludes(stray.html, "Free delivery* within 50 miles. <em>Ask about rent-to-own</em>");
  assertIncludes(stray.text, "Free delivery* within 50 miles. Ask about rent-to-own");
  const sizes = m("Sizes 8*10 and 10*12 in stock");
  assertIncludes(sizes.html, ">Sizes 8*10 and 10*12 in stock</p>");
  const slogan = photoQuote({ layout: "photo", tagline: "**BIG** *savings* today" });
  assertIncludes(slogan.html, "<strong>BIG</strong> <span");
  assertIncludes(slogan.html, ">savings</span> today");
  assertIncludes(slogan.text, "BIG savings today");
});

Deno.test("photo design: with no name, every field closes its gap and nothing else moves", () => {
  const q = photoQuote({
    layout: "photo",
    subject: "Your shed estimate is here, {first}!",
    heading: "{first}",
    message: "Hi **{first}**,\n\nSee below.\n\nThanks,",
    button: "SEE IT, {first}",
    closing: "Talk soon, {first}!",
  }, { customerName: "" });
  assertEq(q.subject, "Your shed estimate is here!");
  assertIncludes(q.html, ">We&#39;re getting closer</h2>");
  assertIncludes(q.html, ">Hi,</p>");
  assertIncludes(q.html, ">Thanks,</p>");
  assertIncludes(q.html, ">SEE IT</a>");
  assertIncludes(q.text, "SEE IT: https://app.example.com/my-quotes?client=acme-sheds");
  assertIncludes(q.html, ">Talk soon!</p>");
  assertNotIncludes(q.html + q.text + q.subject, "\uE001");
  // With a name, the same wording reads in full.
  const named = photoQuote({ layout: "photo", subject: "Here you go, {first}!", button: "SEE IT, {first}" });
  assertEq(named.subject, "Here you go, Alex!");
  assertIncludes(named.html, ">SEE IT, Alex</a>");
});

Deno.test("photo design: Outlook gets a fixed 600px column, everything else may shrink the card", () => {
  const q = photoQuote();
  const open = `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`;
  const card = `bgcolor="#FFFFFF" style="width:100%;max-width:600px;`;
  const close = `<!--[if mso]></td></tr></table><![endif]-->`;
  assert(q.html.indexOf(open) >= 0 && q.html.indexOf(open) < q.html.indexOf(card), "the Outlook column opens before the card");
  assert(q.html.lastIndexOf(close) > q.html.indexOf("All rights reserved."), "and closes after it");
});

// ── Quote to a business entity (2026-10-21) ─────────────────────────────────────────────────
// Junior Barns: "Bear River Band communications all say "Hi Bear" ... I am working with a guy
// named Thomas". With a company on the design's contact, {first} is the PERSON and {company} the
// business. Without one, nothing moves (the golden test pins the bytes).

Deno.test("company: {first} greets the person and {company} names the business, classic and invoice", () => {
  const who = { customerName: "Thomas Example", customerCompany: "Bear River Band" };
  const q = estimateEmail({ ...acmeQuote(), ...who, templateCopy: { quote: { intro: "Hi {first} at {company}!", subject: "{company}: your estimate" } } });
  assertIncludes(q.html, "Hi Thomas at Bear River Band!");
  assertIncludes(q.text, "Hi Thomas at Bear River Band!");
  assertEq(q.subject, "Bear River Band: your estimate");
  const inv = invoiceEmail({ ...acmeInvoice(), ...who, templateCopy: { invoice: { intro: "Hi {first} ({company})" } } });
  assertIncludes(inv.html + inv.text, "Hi Thomas (Bear River Band)");
  assertNotIncludes(inv.html + inv.text, "{company}");
});

Deno.test("company: a name that only repeats the company is no person, so it is never 'Hi Bear'", () => {
  for (const customerName of ["Bear River Band", "", "  bear river band "]) {
    const q = photoQuote(photoCopy(), { customerName, customerCompany: "Bear River Band" });
    assertNotIncludes(q.html + q.text, "Bear,", customerName);
    assertNotIncludes(q.html + q.text, "Hi Bear", customerName);
    assertIncludes(q.html, ">We&#39;re getting closer</h2>", `${customerName}: the heading closes up`);
    // Her default message (no wording saved) greets "there".
    const d = photoQuote({ layout: "photo" }, { customerName, customerCompany: "Bear River Band" });
    assertIncludes(d.html + d.text, "Hi there,", customerName);
  }
});

Deno.test("company: absent, empty or blank is no company, and {company} fills with nothing", () => {
  for (const customerCompany of [undefined, null, "", "   "]) {
    const q = estimateEmail({ ...acmeQuote(), customerName: "Bear River Band", customerCompany, templateCopy: { quote: { intro: "Hi {first}[{company}]" } } });
    assertIncludes(q.html + q.text, "Hi Bear[]", String(customerCompany));
  }
});

Deno.test("company: the wording screen's preview shows a sample company", () => {
  assertEq(PREVIEW_SAMPLE.customerCompany, "Smith Family Farm");
  const p = templatePreviewEmail({ kind: "quote", copy: { intro: "Hi {first} at {company}" }, businessName: "Acme Sheds" });
  assertIncludes(p.html, "Hi Alex at Smith Family Farm");
});
