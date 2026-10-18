// Subject/html/text builders for the tenant-branded emails on the Postmark send path:
// the estimate email (submit-estimate), the invoice email (portal-settings), and the
// Settings -> Email test send. Plus one email that goes the OTHER way — to the builder, not
// their customer: the "Invoice to approve" notice customer-accept sends when a customer
// accepts a quote (migration 229). See invoiceRequestEmail for how it differs.
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
//
// ⚠️ Importers, ALL of which must be redeployed together when this changes (_shared
//    bundles PER function): portal-settings, submit-estimate, customer-accept.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EstimateEmailInput {
  /** Per-tenant wording — client_settings.email_template_copy (138): subject, opening line,
   *  closing message, button text and the photo switch. Untyped jsonb by nature; tenantCopy()
   *  validates and drops anything unusable. */
  templateCopy?: unknown;
  /** Used only by the {customer} and {first} tokens in tenant copy: the name on the design's contact. */
  customerName?: string;
  /** The building's photo: the builder's own style photo, and only when that style's "show on
   *  estimate" switch is on (callers use tenantStylePhotoUrl). Drawn above the detail rows when
   *  it is an https:// address and the builder hasn't switched the photo off in their wording.
   *  Absent renders nothing, so a caller that passes none sends exactly what it always did. */
  pictureUrl?: string | null;
  /** The business address: client_settings.business_address (jsonb) or a line of text. Only the
   *  photo design's signature draws it; the classic card never has. */
  address?: unknown;

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
   *  tenants' emails don't change under them. "quote" also flips the CTA to "View & Accept
   *  Your Quote" and leaves the total OUT of the email (Carolyn, 2026-09-14 — see
   *  estimateEmail). The signature moved to the invoice on 2026-08-26, so the quote CTA no
   *  longer says "Sign". */
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
  /** Per-tenant wording — client_settings.email_template_copy (138), read under the "invoice"
   *  kind (the wording screen offers that tab alongside estimate/quote). Untyped jsonb by
   *  nature; tenantCopy() validates and drops anything unusable, so absent or unusable copy
   *  keeps the shipped wording byte for byte. An invoice has no photo. */
  templateCopy?: unknown;
  /** Used only by the {customer} token in tenant copy: the name on the design's contact. */
  customerName?: string;

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
  /** The sender's own email signature (My Profile; cleaned by _shared/emailSignature.ts), so a
   *  test shows how their emails will end. Plain text: escaped here, line breaks kept. */
  signature?: string | null;
}

export interface InvoiceRequestEmailInput {
  /** The builder's OWN business name. The reader is the builder, so their name heads it. */
  businessName: string;
  quoteNumber: string | number;
  /** The name on the design's contact. Optional — a design can arrive without one. */
  customerName?: string | null;
  styleLabel?: string | null;
  sizeLabel?: string | null;
  /** What the customer accepted. Pre-formatted string or a number to format here. */
  total?: string | number | null;
  /** ISO timestamp of the acceptance; rendered as a plain date. */
  acceptedAtIso: string;
  /** The order in the portal (/portal/orders/o-<id>, which the host 301s to /orders/o-<id>), where "Approve & send invoice" lives. */
  reviewUrl: string;
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

/** Per-tenant WORDING for the document emails (migration 138; widened 2026-10-04).
 *
 * ⚠️ COPY ONLY, NEVER HTML. A builder edits the things that are genuinely theirs: the subject
 * line, the opening sentence, a closing message under the links, the words on the button, and
 * whether their building's photo shows. Everything structural (the branded header, the detail
 * rows, where the button GOES, the PDF links, the footer) stays owned by this file, because
 * those are the parts of the email that DO something and a wording edit has no business near
 * them. It is also the difference between a template feature and an injection surface pointed
 * at a customer's inbox. Carolyn asked for "a template that they can edit, you know, for images
 * and all of that stuff too" (2026-08-21); her GHL one is a picture, the details, then a "View
 * Shed Quote" button. Structured blocks give her that without free HTML.
 *
 * Every field is plain text. The one-line fields (subject, intro, button) have their
 * whitespace collapsed, so nothing header-shaped survives; the closing message keeps its line
 * breaks, which the HTML half draws as <br> after escaping. `picture` is only ever stored as
 * false (the photo is on unless the builder switches it off), and only for estimate and quote.
 *
 * Tokens are substituted here and the VALUES are escaped by the caller for the HTML path,
 * so a tenant cannot smuggle markup through {business} either. An unknown token is left
 * verbatim rather than blanked: a stray "{foo}" reads as a typo the builder can see and
 * fix, where an empty gap reads as our bug.
 */
export type TemplateCopy = {
  subject?: string;
  intro?: string;
  /** Under the button and the PDF links. Line breaks kept. */
  closing?: string;
  /** The button's words. Where it goes is never the builder's to change. */
  button?: string;
  /** false = leave the building photo out. Absent = show it (when there is one). */
  picture?: boolean;

  // ── The PHOTO-HEADER design (Carolyn, 2026-10-14) ───────────────────────────────────────
  // "I really want that template inside Structure Studio for sending out the quote. It has a
  // nice truck on it." Her GHL quote email: a big photo across the top, an orange rule, "We're
  // getting closer, Ahsan", a few short paragraphs, one wide green "VIEW SHED QUOTE" button, a
  // slogan, and a signature (name, company, title, logo card, address, phone). layout "photo"
  // switches a quote or estimate to that shape; everything below is only read while it is on, so
  // a builder can flip back to the classic card without losing what they typed. Estimate and
  // quote only: the invoice keeps one design.
  /** "photo" = the photo-header design. Absent = the classic card. */
  layout?: "photo";
  /** The photo across the top (https://). Absent = the building photo when there is one, else
   *  the logo and name the classic card opens with. */
  hero?: string;
  /** The big line under the photo, e.g. "We're getting closer, {first}". */
  heading?: string;
  /** The paragraphs above the button. Blank lines split paragraphs; **bold** and *italic*. */
  message?: string;
  /** A slogan between the button and the signature. *words* draw in a script face. */
  tagline?: string;
  /** The signature: the person's name (large) and their title (under the company name). */
  signName?: string;
  signTitle?: string;
  /** A banner across the bottom (https://). Absent = a thin rule in the accent colour. */
  footer?: string;
  /** #rrggbb. The rules either side of the heading (and the bottom rule). */
  accent?: string;
  /** #rrggbb. The button. Its words turn dark on a light colour so they stay readable. */
  buttonColor?: string;
};

/** The three kinds the wording screen has a tab for. */
export const TEMPLATE_KINDS = ["estimate", "quote", "invoice"] as const;
export type TemplateKind = typeof TEMPLATE_KINDS[number];

/** The longest each field may be, in characters (code points). The editor's boxes stop at the
 *  same lengths, so what is saved is what was typed. */
export const TEMPLATE_LIMITS = {
  subject: 300, intro: 300, closing: 1000, button: 40,
  heading: 150, message: 1500, tagline: 150, signName: 80, signTitle: 80,
} as const;
type CopyField = keyof typeof TEMPLATE_LIMITS;
const COPY_FIELDS: CopyField[] = ["subject", "intro", "closing", "button", "heading", "message", "tagline", "signName", "signTitle"];
/** The photo design's words: estimate and quote only, never the invoice. */
const PHOTO_FIELDS: CopyField[] = ["heading", "message", "tagline", "signName", "signTitle"];
/** Fields that keep their line breaks (the rest are one line). */
const MULTILINE_FIELDS: CopyField[] = ["closing", "message"];
/** How a refusal names each field, in the editor's own words. */
const FIELD_WORDS: Record<CopyField, string> = {
  subject: "subject",
  intro: "opening line",
  closing: "closing message",
  button: "button text",
  heading: "heading",
  message: "message",
  tagline: "slogan",
  signName: "signature name",
  signTitle: "signature title",
};
/** Each kind as the wording screen's tab names it, for refusals: the "quote" key is StructureStudio's
 *  own paperwork, which every reader calls an estimate (Carolyn 2026-10-06, Q12). */
const KIND_WORDS: Record<TemplateKind, string> = { estimate: "CRM estimate", quote: "estimate", invoice: "invoice" };
/** The photo design's two pictures, as a refusal names them. */
const PHOTO_IMAGES = [["hero", "top photo"], ["footer", "bottom banner"]] as const;
/** The photo design's two colours, as a refusal names them. */
const PHOTO_COLORS = [["accent", "accent colour"], ["buttonColor", "button colour"]] as const;
/** A colour the photo design accepts: #rrggbb, nothing else (no names, no gradients, no url()). */
function hexColor(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : "";
}

/**
 * One field as it is stored and sent: "" when there is nothing usable. Control characters go
 * (a tab or a line break counts as a space in the one-line fields), a lone half of an emoji
 * becomes U+FFFD because jsonb refuses one (_shared/emailSignature.ts has the same rule), and
 * the result is cut to the field's limit. It does NOT judge markup: tenantCopy drops a field
 * with < or > quietly, and cleanTemplateCopy refuses it out loud.
 */
function copyField(field: CopyField, v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  if (MULTILINE_FIELDS.includes(field)) {
    s = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  } else {
    s = s.replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  }
  const max = TEMPLATE_LIMITS[field];
  // .length counts UTF-16 units, never fewer than code points, so only a long one pays for the split.
  if (s.length > max) s = Array.from(s).slice(0, max).join("").trimEnd();
  return s;
}

export function tenantCopy(raw: unknown, kind: string): TemplateCopy {
  if (!raw || typeof raw !== "object") return {};
  const byKind = (raw as Record<string, unknown>)[kind];
  if (!byKind || typeof byKind !== "object") return {};
  const o = byKind as Record<string, unknown>;
  const out: TemplateCopy = {};
  for (const f of COPY_FIELDS) {
    if (kind === "invoice" && PHOTO_FIELDS.includes(f)) continue;
    const t = copyField(f, o[f]);
    // Anything with a tag in it is a builder pasting HTML in; drop the whole field rather
    // than half-escaping it into gibberish, so the shipped wording shows instead.
    if (t && !/[<>]/.test(t)) out[f] = t;
  }
  if (o.picture === false && kind !== "invoice") out.picture = false;
  if (kind !== "invoice") photoDesign(o, out);
  return out;
}

/** The photo design's switch, pictures and colours onto `out`, keeping only usable values. The
 *  words went through copyField with the rest. Shared by tenantCopy (quietly drops what it can't
 *  use) and cleanTemplateCopy (which has already refused anything unusable out loud). */
function photoDesign(o: Record<string, unknown>, out: TemplateCopy): void {
  if (o.layout === "photo") out.layout = "photo";
  for (const [f] of PHOTO_IMAGES) {
    const u = emailPictureUrl(o[f]);
    if (u) out[f] = u;
  }
  for (const [f] of PHOTO_COLORS) {
    const c = hexColor(o[f]);
    if (c) out[f] = c;
  }
}

/**
 * The wording as email_save_template stores it, and as email_preview_template renders it:
 * { copy } keyed by kind, holding only the fields that say something, or { error } with the
 * sentence to show. Markup is refused LOUDLY here rather than stripped: a builder who pasted it
 * needs to be told, not to have it silently vanish and wonder which half saved. tenantCopy
 * applies the same rules again on the way out, so a row written before a rule existed is held
 * to it too.
 */
export function cleanTemplateCopy(raw: unknown): { copy: Partial<Record<TemplateKind, TemplateCopy>> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Nothing to save." };
  const copy: Partial<Record<TemplateKind, TemplateCopy>> = {};
  for (const kind of TEMPLATE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const out: TemplateCopy = {};
    for (const f of COPY_FIELDS) {
      if (kind === "invoice" && PHOTO_FIELDS.includes(f)) continue;
      const t = copyField(f, o[f]);
      if (!t) continue;
      if (/[<>]/.test(t)) return { error: `Remove the < > characters from the ${KIND_WORDS[kind]} ${FIELD_WORDS[f]} — this is plain text, not HTML.` };
      out[f] = t;
    }
    if (o.picture === false && kind !== "invoice") out.picture = false;
    if (kind !== "invoice") {
      // A picture or colour that was given but can't be used is refused, not dropped: the
      // builder would otherwise see "Saved." and a design without the photo they just chose.
      for (const [f, words] of PHOTO_IMAGES) {
        const v = typeof o[f] === "string" ? String(o[f]).trim() : "";
        if (v && !emailPictureUrl(v)) return { error: `The ${KIND_WORDS[kind]} ${words} must be an https:// web address (upload the picture instead).` };
      }
      for (const [f, words] of PHOTO_COLORS) {
        const v = typeof o[f] === "string" ? String(o[f]).trim() : "";
        if (v && !hexColor(v)) return { error: `The ${KIND_WORDS[kind]} ${words} must be a colour like #2cab05.` };
      }
      photoDesign(o, out);
    }
    if (Object.keys(out).length) copy[kind] = out;
  }
  return { copy };
}

/**
 * An address an email may draw as the building photo, or null: https:// only (a customer's mail
 * app shows a broken-image box, or a "load remote content" warning, for anything else), no
 * spaces or quote marks, at most 2,048 characters.
 */
export function emailPictureUrl(url: unknown): string | null {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u || u.length > 2048 || !/^https:\/\/[^\s"'<>\\]+$/i.test(u)) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * The style photo a document email may show, or null. ONLY the builder's own upload: an address
 * under THIS tenant's folder in the public branding or fixtures bucket, the same guard
 * submit-estimate's imgAttachments puts on the estimate's line photos, so a tampered or copied
 * catalog row can't put somebody else's picture (or a tracking pixel) in a customer's inbox. The
 * parsed address must still sit under that folder, so "../" can't climb out of it.
 *
 * The caller checks the style's own show_image_on_estimate switch; this checks the address.
 */
export function tenantStylePhotoUrl(url: unknown, supabaseUrl: string, clientId: string): string | null {
  const u = emailPictureUrl(url);
  const base = String(supabaseUrl ?? "").replace(/\/+$/, "");
  if (!u || !base || !clientId) return null;
  const prefixes = ["branding", "fixtures"].map((b) => `${base}/storage/v1/object/public/${b}/${clientId}/`);
  if (!prefixes.some((p) => u.startsWith(p))) return null;
  try {
    const href = new URL(u).href;
    return prefixes.some((p) => href.startsWith(p)) ? u : null;
  } catch {
    return null;
  }
}

/** The closing message as an HTML block (escaped, line by line), or "" with none. It opens
 *  with its own line break so it can be appended after the links unconditionally. */
function closingBlock(closing: string): string {
  return closing
    ? `
            <p style="margin:18px 0 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${esc(closing).replace(/\n/g, "<br>")}</p>`
    : "";
}

/** Adds the closing message to the text half: one blank line above it, never two. */
function pushClosing(text: string[], closing: string): void {
  if (!closing) return;
  if (text[text.length - 1] !== "") text.push("");
  text.push(closing);
}

export function fillTokens(tpl: string, vals: Record<string, string>): string {
  return String(tpl || "").replace(/\{(\w+)\}/g, (whole, k) =>
    Object.prototype.hasOwnProperty.call(vals, k) ? String(vals[k] ?? "") : whole);
}

// ── THE PHOTO-HEADER DESIGN (Carolyn, 2026-10-14) ──────────────────────────────────────────
// Her GHL quote email, rebuilt from the bytes it sent (Junior Barns' "Your shed quote is
// here!", 2026-07-08): photo, orange rule, heading, rule, paragraphs, a full-width green button,
// a slogan, then "Thanks," and a signature card. Same email-client rules as the classic card:
// nested tables and inline styles only, explicit bgcolor everywhere, 600px wide.

const PHOTO_ACCENT = "#f47b2a";
/** Holds a token value's "*" out of the marker patterns while the photo design is built. */
const HELD_STAR = "\uE000";
/** Stands where {first} or {customer} had no name to give, until the gap around it is closed. */
const NO_NAME = "\uE001";
const PHOTO_BUTTON = "#2cab05";
/** Her GHL email's body face. */
const PHOTO_FONT = "Arial,Helvetica,sans-serif";

/** The first word of the customer's name, for {first}. "" when there is none. */
function firstName(customerName: unknown): string {
  return oneLine(customerName).split(" ")[0] || "";
}

/** The business address on one line ("1645 Bethany Rd, Cottage Grove, TN 38224"), from the
 *  client_settings.business_address jsonb or a plain string. Anything else is "". */
function addressLine(a: unknown): string {
  if (typeof a === "string") return oneLine(a);
  if (!a || typeof a !== "object") return "";
  const o = a as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? oneLine(v) : "");
  const stateZip = [s(o.state), s(o.postalCode)].filter(Boolean).join(" ");
  return [s(o.addressLine1), s(o.city), stateZip].filter(Boolean).join(", ");
}

/** Wording that used {first} or {customer} when the design has no name on it would read "Hi ," or
 *  "We're getting closer, ". The missing name was filled as NO_NAME; this closes the gap around
 *  it and touches nothing else the builder wrote (their own "Thanks," keeps its comma). */
function closeGap(s: string): string {
  return s
    .replace(/\*\*\uE001\*\*|\*\uE001\*/g, NO_NAME)                // **{first}** with nothing in it
    .replace(/,[ \t]*\uE001(?=[ \t]*(?:[.!?]|$|\n))/g, "")          // "closer, {first}!" -> "closer!"
    .replace(/[ \t]+\uE001/g, "")                                   // "Hi {first}," -> "Hi,"
    .replace(/\uE001[ \t]*,?[ \t]*/g, "");                          // "{first}, see..." -> "see..."
}

// The builder's **bold** and *italic*. A marker counts only where it opens and closes a run of
// words, the way people write it: "**Call *today***", "*If you have any changes*". An asterisk
// inside a word ("8*10") or standing alone ("delivery* within") stays a plain "*". Bold may hold
// italic. The HTML, the slogan and the text half all read the markers with these two patterns,
// so the two halves never disagree.
const BOLD_MARK = /(^|[^*\w])\*\*(?=\S)([^\n]*?\S)\*\*(?![*\w])/g;
const ITALIC_MARK = /(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;

/** Escaped text with the builder's **bold** and *italic*; line breaks become <br>. */
function richText(s: string): string {
  return esc(s)
    .replace(BOLD_MARK, "$1<strong>$2</strong>")
    .replace(ITALIC_MARK, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

/** The same text as the plain-text half reads it: the markers dropped. */
function plainText(s: string): string {
  return s.replace(BOLD_MARK, "$1$2").replace(ITALIC_MARK, "$1$2");
}

/** Paragraphs: split on blank lines. */
function paragraphs(s: string): string[] {
  return s.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
}

/** The slogan: *words* in a script face, the rest bold capitals' size — her "EVERYONE NEEDS
 *  *a little space* IN THEIR LIFE". Mail apps without the face fall back to a cursive one. */
function taglineHtml(t: string): string {
  return esc(t)
    .replace(BOLD_MARK, "$1<strong>$2</strong>")
    .replace(ITALIC_MARK, `$1<span style="font-family:Lobster,'Brush Script MT','Segoe Script',cursive;font-size:26px;font-weight:400;color:#000000;">$2</span>`);
}

/** A website the way people write it: no scheme, no trailing slash. The link keeps the full address. */
function websiteText(w: string): string {
  return w.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** Ten bare digits read as a US number. Anything typed with its own punctuation stays as typed. */
function phoneText(p: string): string {
  return /^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
}

/** Readable words on the builder's button colour: white, or near-black on a light colour. */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#FFFFFF";
}

/** The rule either side of the heading: a 2px cell in the accent colour (a border would be
 *  dropped by some mail apps; a filled cell never is). */
function accentRule(color: string, px: number): string {
  return `<tr>
          <td style="padding:0 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${px}" bgcolor="${color}" style="background-color:${color};height:${px}px;line-height:${px}px;font-size:1px;">&nbsp;</td></tr></table>
          </td>
        </tr>`;
}

/** Her GHL wording, the floor plan sentence only when there is a floor plan to point at. Her
 *  email said the drawing was ATTACHED; ours links it, so the sentence says so. And "everything
 *  you chose", not her "everything we discussed": a shopper on the public designer talked to nobody. */
function defaultPhotoMessage(word: string, first: string, hasPlan: boolean): string {
  return [
    `Hi ${first || "there"},`,
    `Here is the ${word} for your new building! Please click the button below to review and approve it.`,
    ...(hasPlan ? [`Your floor plan, with everything you chose, is linked below. *If you have any changes or questions, please let me know so we can get it dialed in for you.*`] : []),
    `**View your ${word} below, and click "Accept" to move this order forward!**`,
  ].join("\n\n");
}

interface PhotoParts {
  name: string;
  num: string;
  /** The document's name as the reader sees it ("estimate"), and capitalised. */
  word: string;
  Word: string;
  building: string;
  money: string;
  showTotal: boolean;
  tokens: Record<string, string>;
  /** The building photo the classic card would show, already allowed (or null). */
  picture: string | null;
  preheader: string;
  /** Ours, for when the builder wrote no subject. */
  subject: string;
}

function photoEstimateEmail(input: EstimateEmailInput, copy: TemplateCopy, p: PhotoParts): EmailContent {
  const { name, num, word, Word, building, tokens } = p;
  const accent = copy.accent || PHOTO_ACCENT;
  const btnBg = copy.buttonColor || PHOTO_BUTTON;
  const noName = !tokens.first;
  // A customer's or a catalog's own "*" (a name, a style label) must never pair with the
  // builder's **bold** and *italic* markers. Values go in with each "*" held as a private-use
  // character the marker patterns can't match, and it turns back into "*" once the email is built.
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) safe[k] = String(v).replace(/\*/g, HELD_STAR);
  // Every builder field is filled the same way here, the subject, button and sign-off included,
  // so a missing name closes up wherever it was used. (The classic card fills its own; this
  // design never touches it.)
  if (noName) { safe.first = NO_NAME; safe.customer = NO_NAME; }
  const fill = (tpl: string) => closeGap(fillTokens(tpl, safe));

  const hero = copy.hero || p.picture || null;
  // A heading that fills to nothing (only {first}, no name) gets ours, not an empty band.
  const heading = (copy.heading ? oneLine(fill(copy.heading)) : "") || oneLine(fill("We're getting closer, {first}"));
  const message = copy.message ? fill(copy.message) : defaultPhotoMessage(word, noName ? "" : safe.first, Boolean(input.pdfUrl));
  const paras = paragraphs(message);
  const ctaLabel = (copy.button ? oneLine(fill(copy.button)) : "") || `VIEW YOUR ${word.toUpperCase()}`;
  const tagline = copy.tagline ? oneLine(fill(copy.tagline)) : "";
  const signName = copy.signName ? oneLine(fill(copy.signName)) : "";
  const signTitle = copy.signTitle ? oneLine(fill(copy.signTitle)) : "";
  const closing = (copy.closing ? fill(copy.closing).trim() : "") || "Thanks,";
  const subject = (copy.subject ? oneLine(fill(copy.subject)) : "") || p.subject;
  const address = addressLine(input.address);
  const phone = phoneText(oneLine(input.phone ?? ""));
  const website = oneLine(input.website ?? "");
  const terms = input.quoteTerms ? String(input.quoteTerms).replace(/\r\n/g, "\n").trim() : "";
  const year = new Date().getUTCFullYear();

  const details = [`${Word} #${num}`];
  if (building) details.push(building);
  if (p.showTotal) details.push(p.money);
  const links: string[] = [];
  if (input.pdfUrl) links.push(`<a href="${esc(input.pdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your floor plan (PDF)</a>`);
  if (input.formalPdfUrl) links.push(`<a href="${esc(input.formalPdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your ${word} (PDF)</a>`);

  // ── Top: the photo, linked to the quote the way hers is; without one, the logo and name. ──
  const heroImg = hero
    ? `<img src="${esc(hero)}" alt="${esc(name)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />`
    : "";
  const logo = input.logoUrl
    ? `<img src="${esc(input.logoUrl)}" alt="${esc(name)}" width="170" style="display:block;max-width:170px;max-height:64px;width:auto;height:auto;border:0;margin:0 auto 10px auto;" />`
    : "";
  const top = hero
    ? `<tr>
          <td style="padding:20px 20px 12px 20px;">${input.estimateUrl ? `<a href="${esc(input.estimateUrl)}" target="_blank" style="text-decoration:none;">${heroImg}</a>` : heroImg}</td>
        </tr>`
    : `<tr>
          <td align="center" style="padding:28px 20px 16px 20px;">
            ${logo}<div style="font-family:${FONT};font-size:20px;font-weight:800;color:#1F2937;line-height:1.3;">${esc(name)}</div>
          </td>
        </tr>`;

  const bodyParas = paras.map((t) =>
    `<p style="margin:0 0 14px 0;font-family:${PHOTO_FONT};font-size:16px;line-height:1.5;color:#000000;">${richText(t)}</p>`
  ).join("\n            ");

  const button = input.estimateUrl
    ? `<tr>
          <td style="padding:6px 20px 4px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${btnBg}" style="background-color:${btnBg};padding:14px 25px;">
                  <a href="${esc(input.estimateUrl)}" target="_blank" style="display:block;font-family:${PHOTO_FONT};font-size:16px;font-weight:700;line-height:1.25;color:${inkOn(btnBg)};text-decoration:none;">${esc(ctaLabel)}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
    : "";

  const detailRowHtml = `<tr>
          <td align="center" style="padding:10px 20px 4px 20px;">
            <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.7;color:#475569;">${esc(details.join(" · "))}${links.length ? `<br>${links.join(" &middot; ")}` : ""}</p>
          </td>
        </tr>`;

  const taglineRow = tagline
    ? `<tr>
          <td align="center" style="padding:22px 24px 4px 24px;">
            <p style="margin:0;font-family:${PHOTO_FONT};font-size:16px;font-weight:700;line-height:1.3;color:#000000;">${taglineHtml(tagline)}</p>
          </td>
        </tr>`
    : "";

  // ── The signature: hers is "Thanks," then the owner's name large, the company in bold grey,
  // the title in italics, the logo card, then address, email and phone. ──
  const sig: string[] = [
    `<p style="margin:0 0 6px 0;font-family:${PHOTO_FONT};font-size:14px;line-height:1.4;color:#000000;">${esc(closing).replace(/\n/g, "<br>")}</p>`,
  ];
  if (signName) sig.push(`<p style="margin:0 0 4px 0;font-family:${PHOTO_FONT};font-size:26px;font-weight:700;line-height:1.15;color:#000000;">${esc(signName)}</p>`);
  sig.push(`<p style="margin:0 0 4px 0;font-family:${PHOTO_FONT};font-size:18px;font-weight:700;line-height:1.2;color:#595959;">${esc(name)}</p>`);
  if (signTitle) sig.push(`<p style="margin:0 0 4px 0;font-family:${PHOTO_FONT};font-size:18px;font-style:italic;text-decoration:underline;line-height:1.2;color:#7F7F7F;">${esc(signTitle)}</p>`);
  if (input.logoUrl) sig.push(`<img src="${esc(input.logoUrl)}" alt="${esc(name)}" width="203" style="display:block;max-width:203px;max-height:130px;width:auto;height:auto;border:0;margin:12px 0 10px 0;" />`);
  if (address) sig.push(`<p style="margin:0 0 4px 0;font-family:${PHOTO_FONT};font-size:14px;font-weight:700;line-height:1.3;color:#000000;">${esc(address)}</p>`);
  if (website) sig.push(`<p style="margin:0 0 4px 0;font-family:${PHOTO_FONT};font-size:14px;line-height:1.3;"><a href="${esc(websiteHref(website))}" target="_blank" style="color:#0000EE;text-decoration:underline;">${esc(websiteText(website))}</a></p>`);
  if (phone) sig.push(`<p style="margin:0;font-family:${PHOTO_FONT};font-size:20px;line-height:1.3;color:#000000;">${esc(phone)}</p>`);

  const footerRow = copy.footer
    ? `<tr>
          <td style="padding:10px 20px 0 20px;"><img src="${esc(copy.footer)}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" /></td>
        </tr>`
    : accentRule(accent, 6);

  const termsHtml = terms
    ? `<p style="margin:10px 0 0 0;font-family:${FONT};font-size:11px;line-height:1.6;color:#94A3B8;">${esc(terms).replace(/\n/g, "<br>")}</p>`
    : "";

  // Outlook on Windows ignores max-width, so a width:100% card would stretch across its whole
  // reading pane: it alone reads the [if mso] table, a fixed 600px column. Everything else skips
  // that and lets width:100%;max-width:600px shrink the card to a phone's width (the classic card
  // scrolls sideways there; hers didn't). A width:600px card can't do both: inside a table cell,
  // max-width:100% resolves against the 600px it asked for.
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EAF0F6" style="background-color:#EAF0F6;margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <div style="display:none;font-size:1px;color:#EAF0F6;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(p.preheader)}</div>
      <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;">
        ${top}
        ${accentRule(accent, 2)}
        <tr>
          <td style="padding:4px 20px;">
            <h2 style="margin:10px 0;font-family:${PHOTO_FONT};font-size:22px;font-weight:700;line-height:1.4;color:#000000;">${esc(heading)}</h2>
          </td>
        </tr>
        ${accentRule(accent, 2)}
        <tr>
          <td style="padding:16px 20px 2px 20px;">
            ${bodyParas}
          </td>
        </tr>
        ${button}
        ${detailRowHtml}
        ${taglineRow}
        <tr>
          <td style="padding:20px 24px 12px 24px;">
            ${sig.join("\n            ")}
          </td>
        </tr>
        ${footerRow}
        <tr>
          <td style="padding:12px 20px 20px 20px;">
            <p style="margin:0;font-family:${PHOTO_FONT};font-size:12px;line-height:1.6;color:#000000;"><em>Copyright &copy; ${year} ${esc(name)}. All rights reserved.</em></p>${termsHtml}
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>`;

  const text: string[] = [heading, ""];
  for (const t of paras) text.push(plainText(t), "");
  if (input.estimateUrl) text.push(`${ctaLabel}: ${input.estimateUrl}`);
  text.push(`${Word} #: ${num}`);
  if (building) text.push(`Building: ${building}`);
  if (p.showTotal) text.push(`${Word} total: ${p.money}`);
  if (input.pdfUrl) text.push(`Floor plan (PDF): ${input.pdfUrl}`);
  if (input.formalPdfUrl) text.push(`${Word} (PDF): ${input.formalPdfUrl}`);
  if (tagline) text.push("", plainText(tagline));
  text.push("", closing);
  if (signName) text.push(signName);
  text.push(name);
  if (signTitle) text.push(signTitle);
  if (address) text.push(address);
  const contact = [phone, websiteText(website)].filter(Boolean).join(" | ");
  if (contact) text.push(contact);
  if (terms) text.push("", terms);

  const unhold = (s: string) => s.replace(/\uE000/g, "*").replace(/\uE001/g, "");
  return { subject: unhold(subject), html: unhold(html), text: unhold(text.join("\n") + "\n") };
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

  // ⚠️ NO TOTAL ON A QUOTE EMAIL (Carolyn, 2026-09-14 — she highlighted "Quote total" in the
  // Gmail preview of a real quote and asked for it removed). The figure belongs on the quote
  // itself — the PDF and the page the button opens — where the line items and tax that
  // explain it sit beside it, not bare in an inbox. It leaves ALL THREE places at once: the
  // detail row, the plain-text line and the preheader (the preview line she was looking at).
  // The CRM-mode ESTIMATE email keeps its total: those tenants' emails don't change under them.
  // `money` stays in the token map below, so a builder's saved wording using {total} still
  // fills — that is their own choice of words, and a literal "{total}" would read as our bug.
  const showTotal = word !== "quote";

  const rows = [detailRow(`${Word} #`, esc(num))];
  if (building) rows.push(detailRow("Building", esc(building)));
  if (showTotal) rows.push(detailRow(`${Word} total`, esc(money)));

  // Tenant copy, if they wrote any. Values are escaped for the HTML path; the plain-text
  // path below uses the raw ones. `building` is oneLine()'d only here, in the token map:
  // it is assembled from caller-supplied style/size labels with a bare trim(), and a
  // tenant subject containing {building} would otherwise put a CR/LF straight back into
  // a Subject header — the one thing tenantCopy() already strips from the template. The
  // detail row and the plain-text line keep the raw value; a break there is only ugly.
  const copy = tenantCopy(input.templateCopy, word === "quote" ? "quote" : "estimate");
  const tokens = { business: name, number: num, total: money, building: oneLine(building), customer: oneLine(input.customerName ?? ""), first: firstName(input.customerName) };
  // The builder's button words, filled. Blank once filled (a lone {customer} with no name on the
  // design) falls back to ours rather than drawing an empty button.
  const buttonText = copy.button ? oneLine(fillTokens(copy.button, tokens)) : "";
  const closing = copy.closing ? fillTokens(copy.closing, tokens).trim() : "";
  // The building photo: above the details, the way her GHL quote email has it. Absent unless the
  // caller passed a usable https:// address AND the builder hasn't switched it off.
  const picture = copy.picture === false ? null : emailPictureUrl(input.pictureUrl);

  // The photo-header design, when the builder switched it on for this kind. Nothing below this
  // line runs for it, so the classic card is byte-for-byte what it was (the golden test). Every
  // word a person reads in it says "estimate" (Carolyn 2026-10-06, Q12): it is new, so it starts
  // there rather than waiting for the held server rewording. docWord still decides which wording
  // tab it reads and whether the total shows.
  if (copy.layout === "photo") {
    return photoEstimateEmail(input, copy, {
      name, num, word: "estimate", Word: "Estimate", building, money, showTotal, tokens, picture,
      preheader: showTotal ? `Your estimate from ${name} is ready - ${money}.` : `Your estimate from ${name} is ready.`,
      subject: `Your estimate ${num} from ${name}`,
    });
  }
  const pictureHtml = picture
    ? `
            <img src="${esc(picture)}" alt="${esc(building || name)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px;margin:0 0 16px 0;" />`
    : "";

  // The quote CTA said "Sign" until 2026-09-15. The signature moved to the INVOICE on
  // 2026-08-26 (migration 136); what the quote page asks for now is a click to accept.
  const cta = input.estimateUrl
    ? ctaButton(input.estimateUrl, buttonText || (word === "quote" ? "View & Accept Your Quote" : "View & Accept Your Estimate"))
    : "";
  const pdfLink = input.pdfUrl
    ? `<p style="margin:18px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.pdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your floor plan (PDF)</a></p>`
    : "";
  // Second document link: the formal (letterhead) document PDF. Tighter top margin when it
  // sits directly under the floor-plan link so the two read as one list.
  const formalPdfLink = input.formalPdfUrl
    ? `<p style="margin:${input.pdfUrl ? "8px" : "18px"} 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.formalPdfUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View your ${word} (PDF)</a></p>`
    : "";

  const introRaw = copy.intro
    ? fillTokens(copy.intro, tokens)
    : `Thank you for designing your building with ${name}. Your ${word} is ready.`;
  const introHtml = copy.intro
    ? esc(introRaw)
    : `Thank you for designing your building with ${esc(name)}. Your ${word} is ready.`;

  // pictureHtml and the closing block are "" when absent, so an email with neither is the
  // same bytes it was before they existed (emailTemplates.golden.test.ts).
  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${introHtml}</p>${pictureHtml}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${cta}${pdfLink}${formalPdfLink}${closingBlock(closing)}`;

  const text: string[] = [
    name,
    "",
    introRaw,
    "",
    `${Word} #: ${num}`,
  ];
  if (building) text.push(`Building: ${building}`);
  if (showTotal) text.push(`${Word} total: ${money}`);
  text.push("");
  if (input.estimateUrl) {
    text.push(buttonText
      ? `${buttonText}: ${input.estimateUrl}`
      : word === "quote" ? `View & accept your quote: ${input.estimateUrl}` : `View & accept your estimate: ${input.estimateUrl}`);
  }
  if (input.pdfUrl) text.push(`Floor plan (PDF): ${input.pdfUrl}`);
  if (input.formalPdfUrl) text.push(`${Word} (PDF): ${input.formalPdfUrl}`);
  pushClosing(text, closing);
  text.push(...textFooter(input));

  return {
    subject: copy.subject ? fillTokens(copy.subject, tokens) : `Your ${word} ${num} from ${name}`,
    html: htmlShell({
      businessName: name,
      logoUrl: input.logoUrl,
      phone: input.phone,
      website: input.website,
      quoteTerms: input.quoteTerms,
      // The inbox preview line — the one place a quote total would still show without the row.
      preheader: showTotal ? `Your ${word} from ${name} is ready - ${money}.` : `Your ${word} from ${name} is ready.`,
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
  // Tenant copy, if they wrote any (migration 138). Same contract as the estimate email:
  // COPY ONLY, and the HTML half escapes it — the structural half stays ours. The button
  // text changes the button's words, never where it goes.
  //
  // Every token the wording screen advertises is supplied, with "" for the ones an invoice
  // has no value for: fillTokens leaves an UNKNOWN token verbatim on purpose, so omitting
  // {building} here would ship a literal "{building}" to a customer's inbox.
  const copy = tenantCopy(input.templateCopy, "invoice");
  const tokens = { business: name, number: num, total: money, building: "", customer: oneLine(input.customerName ?? ""), first: firstName(input.customerName) };
  const buttonText = copy.button ? oneLine(fillTokens(copy.button, tokens)) : "";
  const closing = copy.closing ? fillTokens(copy.closing, tokens).trim() : "";
  const cta = toSign
    ? ctaButton(input.signUrl!, buttonText || "Review & Sign Your Invoice")
    : input.invoiceUrl
    ? ctaButton(input.invoiceUrl, buttonText || "View Invoice")
    : "";
  // Demoted, not dropped: some customers just want the paperwork.
  const pdfLink = toSign && input.invoiceUrl
    ? `<p style="margin:18px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><a href="${esc(input.invoiceUrl)}" target="_blank" style="color:#2B4C7E;text-decoration:underline;">View the invoice (PDF)</a></p>`
    : "";
  const introRaw = copy.intro
    ? fillTokens(copy.intro, tokens)
    : toSign
    ? `Thank you for your business. Your invoice from ${name} is ready for your signature.`
    : `Thank you for your business. Your invoice from ${name} is ready.`;
  const introHtml = copy.intro
    ? esc(introRaw)
    : toSign
    ? `Thank you for your business. Your invoice from ${esc(name)} is ready for your signature.`
    : `Thank you for your business. Your invoice from ${esc(name)} is ready.`;

  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${introHtml}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${cta}
            ${pdfLink}${closingBlock(closing)}`;

  const text: string[] = [
    name,
    "",
    introRaw,
    "",
    `Invoice #: ${num}`,
    `Amount due: ${money}`,
    "",
  ];
  if (toSign) text.push(`${buttonText || "Review and sign your invoice"}: ${input.signUrl}`);
  if (input.invoiceUrl) text.push(`${toSign ? "Invoice (PDF)" : buttonText || "View your invoice"}: ${input.invoiceUrl}`);
  pushClosing(text, closing);
  text.push(...textFooter(input));

  return {
    subject: copy.subject
      ? fillTokens(copy.subject, tokens)
      : toSign
      ? `Invoice ${num} from ${name} - ready to sign`
      : `Invoice ${num} from ${name}`,
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

/**
 * "Invoice to approve" — to the BUILDER's owners and admins when a customer accepts a quote
 * (migration 229; Ahsan's decision, 2026-09-15: accept raises a DRAFT invoice and the builder
 * approves it with one click).
 *
 * The one email in this file whose reader is not the tenant's customer. customer-accept sends
 * it from the platform sender, the way a login code goes out, because it must reach a builder
 * who has never set up their own email domain — which today is every builder. So the
 * white-label contract above does not bind it, and it could not keep it anyway: the button
 * has to open OUR portal. Its WORDING still names nothing of ours (the test pins the copy
 * with the link stripped), so a builder who forwards it forwards a link and nothing else.
 *
 * ⚠️ IT MUST NOT READ AS THOUGH AN INVOICE EXISTS. Nothing has been numbered, built, pushed to
 * QuickBooks or sent when this goes out — approving in the portal is what does all of that.
 * So there is no invoice number, no "amount due", and the copy says plainly that the customer
 * has not been sent anything yet. The figure shown is the QUOTE total they accepted.
 */
export function invoiceRequestEmail(input: InvoiceRequestEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const num = oneLine(input.quoteNumber);
  const customer = oneLine(input.customerName ?? "");
  const who = customer || "Your customer";
  const money = input.total == null || input.total === "" ? "" : formatMoney(input.total);
  const building = [input.styleLabel, input.sizeLabel]
    .map((v) => oneLine(v ?? ""))
    .filter(Boolean)
    .join(" - ");
  const d = new Date(input.acceptedAtIso);
  const when = isNaN(d.getTime()) ? oneLine(input.acceptedAtIso) : d.toISOString().slice(0, 10);

  const rows = [detailRow("Quote #", esc(num))];
  if (customer) rows.push(detailRow("Customer", esc(customer)));
  if (building) rows.push(detailRow("Building", esc(building)));
  if (money) rows.push(detailRow("Quote total", esc(money)));
  rows.push(detailRow("Accepted", esc(when)));

  const leadText = `${who} accepted quote ${num}. The invoice is waiting for your approval — nothing has been sent to the customer yet.`;
  const nextText = "Approving issues the invoice with your next invoice number and emails it to the customer to sign.";

  const bodyHtml = `<p style="margin:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${esc(leadText)}</p>
            <p style="margin:0 0 16px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;">${esc(nextText)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${ctaButton(input.reviewUrl, "Review & send invoice")}`;

  const text: string[] = [name, "", leadText, nextText, "", `Quote #: ${num}`];
  if (customer) text.push(`Customer: ${customer}`);
  if (building) text.push(`Building: ${building}`);
  if (money) text.push(`Quote total: ${money}`);
  text.push(`Accepted: ${when}`, "", `Review & send invoice: ${input.reviewUrl}`);

  return {
    subject: `Invoice to approve: quote ${num} was accepted`,
    html: htmlShell({
      businessName: name,
      preheader: `${who} accepted quote ${num}. Approve the invoice when you're ready.`,
      bodyHtml,
    }),
    text: text.join("\n") + "\n",
  };
}

// ── Online Shop purchase request (2026-10-17) ──────────────────────────────────────────────
// To the builder's owners/admins when a shopper checks out a cart and online payment is not on.
// Nothing was charged; the builder follows up. Read by the builder, so their name heads it.
export interface ShopRequestEmailInput {
  businessName: string;
  customerName: string;
  phone: string;
  email?: string | null;
  deliverTo?: string | null;
  message?: string | null;
  items: { label: string; totalCents: number | null; note?: string | null }[];
  totalCents: number | null;
  dueNowCents: number | null;
  payInFull: boolean;
  reviewUrl: string;
  /** Set for a PAID online purchase (phase 4): what was charged. Absent = a purchase request. */
  paidCents?: number | null;
}

export function shopRequestEmail(input: ShopRequestEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const who = oneLine(input.customerName) || "A shopper";
  const cents = (c: number | null) => (c == null ? "" : formatMoney(c / 100));
  const n = input.items.length;
  const paid = input.paidCents != null;
  const leadText = paid
    ? `${who} bought ${n === 1 ? "a building" : n + " buildings"} from your Online Inventory and paid ${cents(input.paidCents!)} by card. The invoice is waiting for your approval — approve it and the customer gets it to sign.`
    : `${who} wants to buy ${n === 1 ? "a building" : n + " buildings"} from your Online Inventory. Nothing has been charged — reach out to confirm, then send the estimate from your Inventory tab.`;
  const rows = [detailRow("Customer", esc(who)), detailRow("Phone", esc(oneLine(input.phone)))];
  if (input.email) rows.push(detailRow("Email", esc(oneLine(input.email))));
  if (input.deliverTo) rows.push(detailRow("Deliver to", esc(oneLine(input.deliverTo))));
  for (const it of input.items) {
    rows.push(detailRow(esc(oneLine(it.label)), esc([cents(it.totalCents), oneLine(it.note ?? "")].filter(Boolean).join(" · ")) || "—"));
  }
  if (input.totalCents != null) rows.push(detailRow("Total (est.)", esc(cents(input.totalCents))));
  if (paid) rows.push(detailRow("Paid online", esc(cents(input.paidCents!))));
  else if (input.dueNowCents != null) rows.push(detailRow(input.payInFull ? "They chose to pay in full" : "Deposit due", esc(cents(input.dueNowCents))));
  const msg = oneLine(input.message ?? "");
  const bodyHtml = `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">${esc(leadText)}</p>
            ${msg ? `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;"><strong>They wrote:</strong> ${esc(msg)}</p>` : ""}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
              ${rows.join("\n")}
            </table>
            ${ctaButton(input.reviewUrl, paid ? "Review & send invoice" : "Open your Inventory")}`;
  const text: string[] = [name, "", leadText, ""];
  if (msg) text.push(`They wrote: ${msg}`, "");
  text.push(`Customer: ${who}`, `Phone: ${oneLine(input.phone)}`);
  if (input.email) text.push(`Email: ${oneLine(input.email)}`);
  if (input.deliverTo) text.push(`Deliver to: ${oneLine(input.deliverTo)}`);
  for (const it of input.items) text.push(`${oneLine(it.label)}: ${[cents(it.totalCents), oneLine(it.note ?? "")].filter(Boolean).join(" · ")}`);
  if (input.totalCents != null) text.push(`Total (est.): ${cents(input.totalCents)}`);
  if (paid) text.push(`Paid online: ${cents(input.paidCents!)}`);
  else if (input.dueNowCents != null) text.push(`${input.payInFull ? "Pay in full" : "Deposit due"}: ${cents(input.dueNowCents)}`);
  text.push("", `${paid ? "Review & send invoice" : "Open your Inventory"}: ${input.reviewUrl}`);
  return {
    subject: paid
      ? `Online Inventory: ${who} bought ${n === 1 ? input.items[0]?.label || "a building" : n + " buildings"} — invoice to approve`
      : `Online Inventory: ${who} wants to buy ${n === 1 ? input.items[0]?.label || "a building" : n + " buildings"}`,
    html: htmlShell({ businessName: name, preheader: leadText, bodyHtml }),
    text: text.join("\n"),
  };
}

/** The made-up customer and document the wording screen's Preview shows. Everything else in a
 *  preview is the builder's own: their name, logo, phone, website, terms and style photo. */
export const PREVIEW_SAMPLE = {
  customerName: "Alex Smith",
  number: "1001",
  total: 12500,
  styleLabel: "Lofted Barn",
  sizeLabel: "12x24",
} as const;

export interface TemplatePreviewInput {
  kind: TemplateKind;
  /** The wording for THIS kind, as the editor holds it (cleanTemplateCopy has passed it). */
  copy: TemplateCopy;
  businessName: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
  quoteTerms?: string | null;
  /** Their first style photo that is switched on for quotes (tenantStylePhotoUrl), if any. */
  pictureUrl?: string | null;
  /** That style's name, so the photo and the Building row agree. */
  styleLabel?: string | null;
  /** client_settings.business_address, for the photo design's signature. */
  address?: unknown;
  /** True when invoices are signed on the customer page (StructureStudio invoicing): the button
   *  then asks for a signature, as the real email does. False: it opens the invoice. */
  invoiceToSign?: boolean;
}

/**
 * The email the wording screen previews: the real estimateEmail / invoiceEmail with the sample
 * customer and document above, so what the builder sees is what the customer would get, bar
 * the numbers. Every link points at "#": the preview is drawn in a sandboxed frame where links
 * can't open anyway, and a sample must never lead anywhere real.
 */
export function templatePreviewEmail(p: TemplatePreviewInput): EmailContent {
  const templateCopy = { [p.kind]: p.copy };
  const shared = {
    templateCopy,
    customerName: PREVIEW_SAMPLE.customerName,
    businessName: p.businessName,
    logoUrl: p.logoUrl ?? null,
    phone: p.phone ?? null,
    website: p.website ?? null,
    quoteTerms: p.quoteTerms ?? null,
  };
  if (p.kind === "invoice") {
    return invoiceEmail({
      ...shared,
      invoiceNumber: PREVIEW_SAMPLE.number,
      total: PREVIEW_SAMPLE.total,
      invoiceUrl: "#",
      signUrl: p.invoiceToSign ? "#" : null,
    });
  }
  return estimateEmail({
    ...shared,
    estimateNumber: PREVIEW_SAMPLE.number,
    total: PREVIEW_SAMPLE.total,
    styleLabel: (p.styleLabel && String(p.styleLabel).trim()) || PREVIEW_SAMPLE.styleLabel,
    sizeLabel: PREVIEW_SAMPLE.sizeLabel,
    estimateUrl: "#",
    pdfUrl: "#",
    formalPdfUrl: "#",
    docWord: p.kind === "quote" ? "quote" : "estimate",
    pictureUrl: p.pictureUrl ?? null,
    address: p.address ?? null,
  });
}

export function testEmail(input: TestEmailInput): EmailContent {
  const name = oneLine(input.businessName);
  const from = oneLine(input.fromAddress);
  const signature = String(input.signature ?? "").replace(/\r\n?/g, "\n").trim();
  // The sender's signature, the way their conversation emails end: inside the card, under the
  // message, drawn the way the quote terms are (escaped, line by line).
  const signatureHtml = signature
    ? `
            <p style="margin:16px 0 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;">${esc(signature).replace(/\n/g, "<br>")}</p>`
    : "";

  const bodyHtml = `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">This is a test message confirming that email sending for ${esc(name)} is working.</p>
            <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:#475569;">It was sent from <strong style="color:#1F2937;">${esc(from)}</strong>. If it landed in your inbox with that sender showing, your sending domain is set up correctly.</p>${signatureHtml}`;

  const text = [
    name,
    "",
    `This is a test message confirming that email sending for ${name} is working.`,
    `It was sent from ${from}. If it landed in your inbox with that sender showing, your sending domain is set up correctly.`,
  ];
  // "-- " (dash, dash, space) is the line mail programs recognise as the start of a signature.
  if (signature) text.push("", "-- ", signature);

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
