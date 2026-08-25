/**
 * The acceptance certificate page (migration 124).
 *
 * After a customer signs their quote on the customer portal, this appends ONE page to the
 * existing quote PDF: quote number, total, the signature (the drawn image, or the typed
 * name rendered in an italic face), who signed, when (UTC), from which IP, and the exact
 * consent sentence they agreed to. The countersigned document is re-uploaded over the same
 * storage path, so every link that pointed at the quote now points at the signed quote.
 *
 * CALLER OWNS DEGRADATION. Like buildQuotePdf's plan sheets, the certificate is evidence
 * presentation, not the evidence itself — the design_acceptances row is the record. So this
 * module may throw (malformed source PDF, un-embeddable PNG) and customer-accept catches,
 * logs, and moves on with the acceptance intact.
 */

// deno-lint-ignore-file no-explicit-any
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.13, 0.15, 0.18);
const GRAY = rgb(0.45, 0.47, 0.5);
const RULE = rgb(0.8, 0.82, 0.84);

/** WinAnsi guard, same reasoning as estimatePdf.ts: the standard fonts throw on characters
 *  they cannot encode, and signer names are customer-authored free text. */
function sanitize(s: string): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    // deno-lint-ignore no-control-regex
    .replace(/[^\x20-\x7E -ÿ]/g, "?");
}

function fmtMoney(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

export interface AcceptanceCert {
  businessName?: string | null;
  quoteNumber: string;
  total?: number | null;
  signerName: string;
  method: "drawn" | "typed";
  /** Raw PNG bytes of the drawn signature; required when method === 'drawn'. */
  signaturePng?: Uint8Array | null;
  /** The typed name-as-signature; required when method === 'typed'. */
  typedSignature?: string | null;
  acceptedAtIso: string;
  ip?: string | null;
  consentText: string;
  /** 'Change order CO-2' instead of the default 'Quote' subject line. */
  subjectLabel?: string | null;
  /** Which document this certificate is bound into. Defaults to 'Quote'. Since migration
   *  136 the certificate rides the INVOICE for new work, so the row must not keep saying
   *  "Quote" over an invoice number — the page is the evidence exhibit, and a mislabelled
   *  document number is the first thing anyone disputing it would point at.
   *  Ignored when subjectLabel is set (a change order names its own subject). */
  docLabel?: "Quote" | "Invoice";
}

/**
 * Append the certificate page to an existing PDF's bytes and return the new document.
 * Throws on a malformed source PDF or signature image — the caller degrades.
 */
export async function appendAcceptancePage(pdfBytes: Uint8Array, cert: AcceptanceCert): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (s: string, x: number, size: number, font: any, color = INK) => {
    page.drawText(sanitize(s), { x, y, size, font, color });
  };
  const rule = () => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: RULE });
  };

  // Header
  y -= 14;
  text(cert.subjectLabel ? "Acceptance of Change" : "Acceptance Certificate", MARGIN, 20, bold);
  y -= 18;
  if (cert.businessName) { text(cert.businessName, MARGIN, 11, helv, GRAY); y -= 16; }
  y -= 6;
  rule();
  y -= 26;

  // Facts table: label / value rows
  const row = (label: string, value: string) => {
    text(label, MARGIN, 10, helv, GRAY);
    text(value, MARGIN + 150, 11, bold);
    y -= 22;
  };
  row(cert.subjectLabel ? "Change to" : (cert.docLabel || "Quote"), cert.quoteNumber + (cert.subjectLabel ? ` — ${cert.subjectLabel}` : ""));
  if (cert.total != null && Number.isFinite(Number(cert.total))) row("Total", fmtMoney(Number(cert.total)));
  row("Signed by", cert.signerName);
  {
    const d = new Date(cert.acceptedAtIso);
    const when = isNaN(d.getTime()) ? cert.acceptedAtIso : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    row("Signed at", when);
  }
  if (cert.ip) row("From IP address", String(cert.ip));

  y -= 8;
  text("Signature", MARGIN, 10, helv, GRAY);
  y -= 10;

  // The signature itself: the drawn image at up to 260x110pt, or the typed name in italics.
  if (cert.method === "drawn" && cert.signaturePng && cert.signaturePng.byteLength > 0) {
    const png = await doc.embedPng(cert.signaturePng);
    const maxW = 260, maxH = 110;
    const scale = Math.min(maxW / png.width, maxH / png.height, 1);
    const w = png.width * scale, h = png.height * scale;
    y -= h;
    page.drawImage(png, { x: MARGIN, y, width: w, height: h });
    y -= 10;
  } else {
    const shown = cert.typedSignature || cert.signerName;
    y -= 30;
    page.drawText(sanitize(shown), { x: MARGIN, y, size: 26, font: italic, color: INK });
    y -= 12;
  }
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + 300, y }, thickness: 0.75, color: INK });
  y -= 14;
  text(cert.method === "drawn" ? "Signed by hand on the customer quote page" : "Typed signature, entered on the customer quote page",
    MARGIN, 8.5, helv, GRAY);
  y -= 30;

  // The exact consent sentence, wrapped. Width-measured wrap like estimatePdf's terms block.
  text("Agreed statement", MARGIN, 10, helv, GRAY);
  y -= 16;
  const consent = sanitize(cert.consentText);
  const words = consent.split(/\s+/);
  let line = "";
  const size = 9.5;
  const flush = () => {
    if (!line) return;
    page.drawText(line, { x: MARGIN, y, size, font: helv, color: INK });
    y -= 13;
    line = "";
  };
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (helv.widthOfTextAtSize(candidate, size) > CONTENT_W) flush();
    line = line ? `${line} ${w}` : w;
    if (line === w && helv.widthOfTextAtSize(line, size) > CONTENT_W) {
      // A single unbreakable token wider than the page: hard-truncate rather than overflow.
      while (line.length > 1 && helv.widthOfTextAtSize(line, size) > CONTENT_W) line = line.slice(0, -1);
      flush();
    }
  }
  flush();

  y -= 16;
  rule();
  y -= 16;
  text("This page was generated automatically when the customer accepted, and is part of the quote document above.",
    MARGIN, 8.5, helv, GRAY);

  return await doc.save();
}
