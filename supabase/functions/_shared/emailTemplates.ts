// Subject/html/text builders for the tenant-branded emails on the Postmark send path:
// the estimate email (submit-estimate), the invoice email (portal-settings), and the
// Settings -> Email test send.
//
// WHITE-LABEL IS THE CONTRACT. The recipient is the TENANT's customer, so the only
// identity allowed anywhere in these emails -- header, footer, copy, alt text,
// preheader -- is the tenant's own (business name, logo, phone, website, quote terms).
// No platform or provider branding, ever. New copy speaks as the tenant. The test file
// pins this with a literal scan; keep it green.
//
// EMAIL-CLIENT-SAFE BY CONSTRUCTION (same rules as supabase/email-templates/*.html):
// nested tables + inline styles only (Outlook has no flex/grid, Gmail strips <style>
// blocks), width capped at 600px, explicit bgcolor so forced dark mode cannot invert
// text into invisibility, and the CTA's padding sits on the <td> because Outlook
// ignores padding on <a>.
//
// ESCAPING: every interpolated value is tenant- or customer-supplied (business_name,
// quote_terms, contact fields all round-trip through here), so esc() wraps EVERY
// interpolation in the HTML -- element text and attribute values alike. The text and
// subject halves are not HTML and take raw values; subjects are flattened to one line
// so a value carrying a newline can never smuggle in an extra header.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EstimateEmailInput {
  /** Per-tenant subject/intro overrides — client_settings.email_template_copy (138).
   *  Untyped jsonb by nature; tenantCopy() validates and drops anything unusable. */
  templateCopy?: unknown;
  /** Used only by the {customer} token in tenant copy. */
  customerName?: string;

  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  estimateNumber: string | number;
  /** Pre-formatted display string ("$1,234.00") or a raw number to format here. */
  total: string | number;
  styleLabel?: string | null;
  sizeLabel?: string | null;
  /** Hosted estimate page. null = unbuildable -> the CTA button is omitted entirely. */
  estimateUrl?: string | null;
  /** Floor-plan PDF (tenant-validated storage URL). Linked whether or not the CTA exists. */
  pdfUrl?: string | null;
  /** Formal estimate PDF (letterhead + line items + terms; tenant storage URL). Optional
   *  second document link — absent renders nothing, so pre-existing callers are unchanged. */
  formalPdfUrl?: string | null;
  quoteTerms?: string | null;
  /** Which word the document goes by. StructureStudio-issued paperwork says "quote"
   *  (Carolyn's terminology, migration 121+); the GHL path keeps "estimate" so existing
   *  tenants' emails don't change under them. Also flips the CTA to "View & Sign Your
   *  Quote" — the SS-mode CTA leads to the customer portal where the signature lives. */
  docWord?: "estimate" | "quote";
}

export interface ChangeOrderEmailInput {
  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  quoteNumber: string | number;
  coNo: number;
  /** The generated (or rep-typed) description of what changed. Multi-line. */
  description: string;
  totalBefore?: string | number | null;
  totalAfter?: string | number | null;
  /** The customer portal (my-quotes) — where they review and sign the change. */
  reviewUrl: string;
  quoteTerms?: string | null;
}

export interface AcceptanceEmailInput {
  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  quoteNumber: string | number;
  total?: string | number | null;
  signerName: string;
  /** ISO timestamp of the signature; rendered as a plain date. */
  acceptedAtIso: string;
  /** The (now countersigned) quote PDF. */
  pdfUrl?: string | null;
  quoteTerms?: string | null;
  /** Which document this confirms. 'quote' (accepted — the invoice comes next) or
   *  'invoice' (signed — the commitment). Defaults to 'quote', so existing callers are
   *  byte-identical. The layout is shared because the two emails differ only in wording. */
  docWord?: "quote" | "invoice";
  /** How they agreed. A 'click' acceptance is NOT a signature and must not be described as
   *  one — the email is the customer's own record of what they did. Defaults to a signature. */
  method?: "drawn" | "typed" | "click";
}

export interface InvoiceEmailInput {
  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  invoiceNumber: string | number;
  total: string | number;
  /** Hosted invoice page. null -> the CTA button is omitted entirely. */
  invoiceUrl?: string | null;
  quoteTerms?: string | null;
  /** The customer's my-quotes page, where the invoice is signed. When present it TAKES OVER
   *  the CTA and invoiceUrl is demoted to a plain "view the PDF" link — the button has to
   *  lead somewhere the customer can act, and a PDF is a dead end for a document that now
   *  needs their signature. */
  signUrl?: string | null;
}

export interface TestEmailInput {
  businessName: string;
  fromAddress: string;
}

/**
 * HTML-escape one interpolated value. Handles nullish. Escapes quotes too, so the same
 * helper is safe inside attribute values (href="...") -- a quote in a URL cannot break
 * out of the attribute -- not just in element text.
 */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * $#,##0.00 for numbers; strings arrive pre-formatted upstream and pass through.
 * Deterministic regex grouping rather than toLocaleString -- the edge runtime's locale
 * is nobody's contract.
 */
export function formatMoney(total: string | number): string {
  if (typeof total === "number" && Number.isFinite(total)) {
    const sign = total < 0 ? "-" : "";
    const [int, dec] = Math.abs(total).toFixed(2).split(".");
    return `${sign}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
  }
  return String(total ?? "").trim();
}

/** Subjects are single-line by definition; strip anything header-shaped. */
function oneLine(v: unknown): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A bare domain becomes an https:// href; real http(s) URLs pass through. */
function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

/**
 * The one primary CTA. Padding lives on the <td>, not the <a>: Outlook ignores <a>
 * padding. Explicit bgcolor so a dark-mode inversion cannot render white-on-white.
 */
function ctaButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 4px auto;">
  <tr>
    <td align="center" bgcolor="#1F2937" style="background-color:#1F2937;border-radius:8px;padding:15px 36px;">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;font-family:${FONT};font-size:16px;font-weight:700;line-height:1;color:#FFFFFF;text-decoration:none;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/** One label/value row of the summary table. `valueHtml` is ALREADY escaped by the caller. */
function detailRow(label: string, valueHtml: string): string {
  return `<tr>
  <td style="padding:8px 0;font-family:${FONT};font-size:13px;color:#64748B;white-space:nowrap;">${esc(label)}</td>
  <td align="right" style="padding:8px 0 8px 18px;font-family:${FONT};font-size:14px;font-weight:600;color:#1F2937;">${valueHtml}</td>
</tr>`;
}

interface ShellInput {
  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  quoteTerms?: string | null;
  preheader: string;
  /** Fully built and fully escaped by the caller. */
  bodyHtml: string;
}

/** The shared 600px card: tenant header, body, tenant contact footer + quote terms. */
function htmlShell(s: ShellInput): string {
  const logo = s.logoUrl
    ? `<img src="${esc(s.logoUrl)}" alt="${esc(s.businessName)}" width="170" style="display:block;max-width:170px;max-height:64px;width:auto;height:auto;border:0;margin:0 auto 10px auto;" />`
    : "";
  const contactBits: string[] = [];
  if (s.phone && String(s.phone).trim()) contactBits.push(esc(String(s.phone).trim()));
  if (s.website && String(s.website).trim()) {
    const raw = String(s.website).trim();
    contactBits.push(`<a href="${esc(websiteHref(raw))}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">${esc(raw)}</a>`);
  }
  const contactLine = [esc(s.businessName), ...contactBits].join(" &middot; ");
  const terms = s.quoteTerms && String(s.quoteTerms).trim()
    ? `<p style="margin:10px 0 0 0;font-family:${FONT};font-size:11px;line-height:1.6;color:#94A3B8;">${esc(String(s.quoteTerms).replace(/\r\n/g, "\n")).replace(/\n/g, "<br>")}</p>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F1F5F9;margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <div style="display:none;font-size:1px;color:#F1F5F9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(s.preheader)}</div>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">
        <tr>
          <td align="center" style="padding:30px 32px 22px 32px;border-bottom:1px solid #E2E8F0;">
            ${logo}<div style="font-family:${FONT};font-size:20px;font-weight:800;color:#1F2937;line-height:1.3;">${esc(s.businessName)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 30px 32px;">
            ${s.bodyHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="background-color:#F8FAFC;padding:18px 32px 22px 32px;border-top:1px solid #E2E8F0;">
            <p style="margin:0;font-family:${FONT};font-size:12px;color:#64748B;">${contactLine}</p>
            ${terms}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/** Shared text-version footer: tenant contact line + quote terms, raw (not HTML). */
function textFooter(input: { businessName: string; phone?: string | null; website?: string | null; quoteTerms?: string | null }): string[] {
  const lines: string[] = [];
  const contact = [input.phone, input.website].map(oneLine).filter(Boolean).join(" | ");
  lines.push("", contact ? `${oneLine(input.businessName)} | ${contact}` : oneLine(input.businessName));
  const terms = input.quoteTerms ? String(input.quoteTerms).replace(/\r\n/g, "\n").trim() : "";
  if (terms) lines.push("", terms);
  return lines;
}

/** Per-tenant SUBJECT / INTRO overrides (migration 138).
 *
 * ⚠️ COPY ONLY, NEVER HTML. A builder edits the two things that are genuinely theirs — the
 * subject line and the opening sentence. Everything structural (the branded header, the
 * detail rows, the CTA, the PDF links, the footer) stays owned by this file, because those
 * are the parts of the email that DO something and a wording edit has no business near
 * them. It is also the difference between a template feature and an injection surface
 * pointed at a customer's inbox.
 *
 * Tokens are substituted here and the VALUES are escaped by the caller for the HTML path,
 * so a tenant cannot smuggle markup through {business} either. An unknown token is left
 * verbatim rather than blanked: a stray "{foo}" reads as a typo the builder can see and
 * fix, where an empty gap reads as our bug.
 */
export type TemplateCopy = { subject?: string; intro?: string };

export function tenantCopy(raw: unknown, kind: string): TemplateCopy {
  if (!raw || typeof raw !== "object") return {};
  const byKind = (raw as Record<string, unknown>)[kind];
  if (!byKind || typeof byKind !== "object") return {};
  const o = byKind as Record<string, unknown>;
  const take = (v: unknown) => {
    const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    // Anything with a tag in it is a builder pasting HTML in; drop the whole field rather
    // than half-escaping it into gibberish, so the shipped wording shows instead.
    return t && !/[<>]/.test(t) ? t.slice(0, 300) : "";
  };
  const out: TemplateCopy = {};
  const sub = take(o.subject), intro = take(o.intro);
  if (sub) out.subject = sub;
  if (intro) out.intro = intro;
  return out;
}

export function fillTokens(tpl: string, vals: Record<string, string>): string {
  return String(tpl || "").replace(/\{(\w+)\}/g, (whole, k) =>
    Object.prototype.hasOwnProperty.call(vals, k) ? String(vals[k] ?? "") : whole);
}

export function estimateEmail(input: EstimateEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const num = oneLine(input.estimateNumber);
  const money = formatMoney(input.total);
  // "quote" for StructureStudio-issued paperwork, "estimate" (the default) for the GHL path.
  const word = input.docWord === "quote" ? "quote" : "estimate";
  const Word = word === "quote" ? "Quote" : "Estimate";
  const building = [input.styleLabel, input.sizeLabel]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean)
    .join(" - ");

  const rows = [detailRow(`${Word} #`, esc(num))];
  if (building) rows.push(detailRow("Building", esc(building)));
  rows.push(detailRow(`${Word} total`, esc(money)));

  const cta = input.estimateUrl
    ? ctaButton(input.estimateUrl, word === "quote" ? "View & Sign Your Quote" : "View & Accept Your Estimate")
    : "";
  const pdfLink = input.pdfUrl
    ? `<p style="margin:18px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.pdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your floor plan (PDF)</a></p>`
    : "";
  // Second document link: the formal (letterhead) document PDF. Tighter top margin when it
  // sits directly under the floor-plan link so the two read as one list.
  const formalPdfLink = input.formalPdfUrl
    ? `<p style="margin:${input.pdfUrl ? "8px" : "18px"} 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.formalPdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your ${word} (PDF)</a></p>`
    : "";

  // Tenant copy, if they wrote any. Values are escaped for the HTML path; the plain-text
  // path below uses the raw ones.
  const copy = tenantCopy(input.templateCopy, word === "quote" ? "quote" : "estimate");
  const tokens = { business: name, number: num, total: money, building, customer: oneLine(input.customerName ?? "") };
  const introRaw = copy.intro
    ? fillTokens(copy.intro, tokens)
    : `Thank you for designing your building with ${name}. Your ${word} is ready.`;
  const introHtml = copy.intro
    ? esc(introRaw)
    : `Thank you for designing your building with ${esc(name)}. Your ${word} is ready.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${introHtml}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${cta}${pdfLink}${formalPdfLink}`;

  const text: string[] = [
    name,
    "",
    introRaw,
    "",
    `${Word} #: ${num}`,
  ];
  if (building) text.push(`Building: ${building}`);
  text.push(`${Word} total: ${money}`, "");
  if (input.estimateUrl) {
    text.push(word === "quote" ? `View & sign your quote: ${input.estimateUrl}` : `View & accept your estimate: ${input.estimateUrl}`);
  }
  if (input.pdfUrl) text.push(`Floor plan (PDF): ${input.pdfUrl}`);
  if (input.formalPdfUrl) text.push(`${Word} (PDF): ${input.formalPdfUrl}`);
  text.push(...textFooter(input));

  return {
    subject: copy.subject ? fillTokens(copy.subject, tokens) : `Your ${word} ${num} from ${name}`,
    html: htmlShell({
      businessName: name,
      logoUrl: input.logoUrl,
      phone: input.phone,
      website: input.website,
      quoteTerms: input.quoteTerms,
      preheader: `Your ${word} from ${name} is ready - ${money}.`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}

export function changeOrderEmail(input: ChangeOrderEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const num = oneLine(input.quoteNumber);
  const co = `CO-${Number(input.coNo) || 0}`;
  const beforeMoney = input.totalBefore == null || input.totalBefore === "" ? "" : formatMoney(input.totalBefore);
  const afterMoney = input.totalAfter == null || input.totalAfter === "" ? "" : formatMoney(input.totalAfter);
  // The description is multi-line generated/typed text — escape it, then honor the line
  // structure in HTML the same way quote terms do.
  const descHtml = esc(String(input.description ?? "").replace(/\r\n/g, "\n").trim()).replace(/\n/g, "<br>");

  const rows = [detailRow("Quote #", esc(num)), detailRow("Change order", esc(co))];
  if (beforeMoney) rows.push(detailRow("Previous total", esc(beforeMoney)));
  if (afterMoney) rows.push(detailRow("New total", esc(afterMoney)));

  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">A change to your order from ${esc(name)} needs your approval before it goes ahead.</p>
            <p style="margin:0 0 16px 0;font-family:${FONT};font-size:14px;line-height:1.7;color:#1F2937;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px;">${descHtml}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${ctaButton(input.reviewUrl, "Review & Approve")}`;

  const text: string[] = [
    name,
    "",
    `A change to your order from ${name} needs your approval before it goes ahead.`,
    "",
    String(input.description ?? "").replace(/\r\n/g, "\n").trim(),
    "",
    `Quote #: ${num}`,
    `Change order: ${co}`,
  ];
  if (beforeMoney) text.push(`Previous total: ${beforeMoney}`);
  if (afterMoney) text.push(`New total: ${afterMoney}`);
  text.push("", `Review & approve: ${input.reviewUrl}`);
  text.push(...textFooter(input));

  return {
    subject: `A change to your quote ${num} needs your approval`,
    html: htmlShell({
      businessName: name,
      logoUrl: input.logoUrl,
      phone: input.phone,
      website: input.website,
      quoteTerms: input.quoteTerms,
      preheader: `A change to quote ${num} needs your approval.`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}

export function acceptanceEmail(input: AcceptanceEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const num = oneLine(input.quoteNumber);
  const signer = oneLine(input.signerName);
  const money = input.total == null || input.total === "" ? "" : formatMoney(input.total);
  const d = new Date(input.acceptedAtIso);
  const when = isNaN(d.getTime()) ? oneLine(input.acceptedAtIso) : d.toISOString().slice(0, 10);

  const isInvoice = input.docWord === "invoice";
  const doc = isInvoice ? "invoice" : "quote";
  const Doc = isInvoice ? "Invoice" : "Quote";
  const signed = input.method !== "click";
  // You ACCEPT a quote and you SIGN an invoice — the verb follows the document, not the
  // gesture. (A drawn signature on a quote was still "accepted" before this change, and
  // the white-label test pins that wording.) The BY-LABEL is the opposite: it describes
  // what the customer physically did, so a click must never read as "Signed by".
  const verb = isInvoice ? "signed" : "accepted";
  const byLabel = signed ? "Signed by" : "Accepted by";
  const pdfLabel = signed ? `View your signed ${doc} (PDF)` : `View your ${doc} (PDF)`;
  // The one line that differs in substance rather than tense: a clicked quote acceptance is
  // the only state where something is still expected FROM the customer, so it says so.
  const lead = isInvoice
    ? `Thank you! You signed invoice ${esc(num)} from ${esc(name)}. A copy is below for your records.`
    : signed
    ? `Thank you! You accepted your quote from ${esc(name)}. A copy of the signed document is attached below for your records.`
    : `Thank you! You accepted your quote from ${esc(name)}. Your invoice will follow shortly for you to sign.`;
  const leadText = isInvoice
    ? `Thank you! You signed invoice ${num} from ${name}.`
    : signed
    ? `Thank you! You accepted your quote from ${name}.`
    : `Thank you! You accepted your quote from ${name}. Your invoice will follow shortly for you to sign.`;

  const rows = [detailRow(`${Doc} #`, esc(num))];
  if (money) rows.push(detailRow("Total", esc(money)));
  rows.push(detailRow(byLabel, esc(signer)));
  rows.push(detailRow("Date", esc(when)));

  const pdfLink = input.pdfUrl
    ? `<p style="margin:18px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.pdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">${esc(pdfLabel)}</a></p>`
    : "";

  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${lead}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${pdfLink}`;

  const text: string[] = [
    name,
    "",
    leadText,
    "",
    `${Doc} #: ${num}`,
  ];
  if (money) text.push(`Total: ${money}`);
  text.push(`${byLabel}: ${signer}`, `Date: ${when}`, "");
  if (input.pdfUrl) text.push(`${pdfLabel}: ${input.pdfUrl}`);
  text.push(...textFooter(input));

  return {
    subject: `You ${verb} ${doc} ${num} from ${name}`,
    html: htmlShell({
      businessName: name,
      logoUrl: input.logoUrl,
      phone: input.phone,
      website: input.website,
      quoteTerms: input.quoteTerms,
      preheader: `${Doc} ${num} ${verb} - thank you!`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}

export function invoiceEmail(input: InvoiceEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const num = oneLine(input.invoiceNumber);
  const money = formatMoney(input.total);

  const toSign = !!input.signUrl;
  const rows = [detailRow("Invoice #", esc(num)), detailRow("Amount due", esc(money))];
  const cta = toSign
    ? ctaButton(input.signUrl!, "Review & Sign Your Invoice")
    : input.invoiceUrl
    ? ctaButton(input.invoiceUrl, "View Invoice")
    : "";
  // Demoted, not dropped: some customers just want the paperwork.
  const pdfLink = toSign && input.invoiceUrl
    ? `<p style="margin:18px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.invoiceUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View the invoice (PDF)</a></p>`
    : "";
  const lead = toSign
    ? `Thank you for your business. Your invoice from ${esc(name)} is ready for your signature.`
    : `Thank you for your business. Your invoice from ${esc(name)} is ready.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${lead}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${cta}
            ${pdfLink}`;

  const text: string[] = [
    name,
    "",
    toSign
      ? `Thank you for your business. Your invoice from ${name} is ready for your signature.`
      : `Thank you for your business. Your invoice from ${name} is ready.`,
    "",
    `Invoice #: ${num}`,
    `Amount due: ${money}`,
    "",
  ];
  if (toSign) text.push(`Review and sign your invoice: ${input.signUrl}`);
  if (input.invoiceUrl) text.push(`${toSign ? "Invoice (PDF)" : "View your invoice"}: ${input.invoiceUrl}`);
  text.push(...textFooter(input));

  return {
    subject: toSign ? `Invoice ${num} from ${name} - ready to sign` : `Invoice ${num} from ${name}`,
    html: htmlShell({
      businessName: name,
      logoUrl: input.logoUrl,
      phone: input.phone,
      website: input.website,
      quoteTerms: input.quoteTerms,
      preheader: toSign ? `Your invoice from ${name} - ${money}. Sign to confirm.` : `Your invoice from ${name} - ${money}.`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}

export function testEmail(input: TestEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const from = oneLine(input.fromAddress);

  const bodyHtml = `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">This is a test message confirming that email sending for ${esc(name)} is working.</p>
            <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">It was sent from <strong style="color:#1F2937;">${esc(from)}</strong>. If it landed in your inbox with that sender showing, your sending domain is set up correctly.</p>`;

  const text = [
    name,
    "",
    `This is a test message confirming that email sending for ${name} is working.`,
    `It was sent from ${from}. If it landed in your inbox with that sender showing, your sending domain is set up correctly.`,
  ];

  return {
    subject: `Test email from ${name}`,
    html: htmlShell({
      businessName: name,
      preheader: `Test email from ${name}.`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}
