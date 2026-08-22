// Formal estimate PDF (Workstream C, 2026-08-10).
//
// Renders the letterhead + line-item + terms estimate document server-side from the
// `designs.estimate_lines` snapshot — the shape serialized by submit-estimate step 11:
//   { version: 1, styleId, discount, lines: [{ kind, itemKey, name, desc, qty, amount, nonTaxable }] }
// `amount` is the UNIT price; a line's total is qty * amount (the exact math
// _shared/qboInvoice.ts uses when it pushes the same snapshot to QuickBooks — the PDF must
// agree with the books). `desc` arrives capped at 1000 chars, which also bounds row height.
//
// Business identity comes from client_settings.business_* — every field is nullable (the
// portal saves them piecemeal), so every field here is optional and a missing one is
// skipped, never rendered as "null" and never a crash.
//
// This module lives in _shared but is deliberately dependency-light: pdf-lib is pure JS
// (no fs/net/env at runtime), and the version is PINNED — a floating npm tag changing
// under every tenant on a cold start is the same hazard the vendored browser libs exist
// to prevent.
//
// Unit tests: _shared/_test_stubs/estimatePdf_test.ts (that suite may use npm:/jsr:
// imports; the self-contained _shared/*.test.ts group bans them, which is why the test
// is not a sibling of this file).

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";

export interface EstimatePdfBusiness {
  name?: string | null;
  phone?: string | null;
  website?: string | null;
  /** client_settings.business_address jsonb — key-allowlisted upstream by portal-settings. */
  address?: {
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  } | null;
  // TODO (deliberate v1 omission): no logo image embedding. business_logo_url is a remote
  // fetch at estimate-submit time — a slow, failed, oversized, or non-image response would
  // add failure modes to the submit path for a cosmetic gain. Revisit with a cached,
  // size-capped fetch if the logo is wanted on the formal PDF.
}

/** One entry of estimate_lines.lines — see submit-estimate step 11 for provenance. */
export interface EstimatePdfLine {
  kind?: string;
  itemKey?: string;
  name?: string | null;
  desc?: string | null;
  qty?: number | null;
  /** UNIT price. Line total = qty * amount (matches qboInvoice.ts). */
  amount?: number | null;
  nonTaxable?: boolean;
}

export interface EstimatePdfInput {
  business: EstimatePdfBusiness;
  estimateNumber?: string | number | null;
  /** Issue date (ISO). Unparseable/missing falls back to "now". */
  dateIso?: string | null;
  /** Days the quote stays valid. Default 30; NaN/<=0 also falls back to 30. */
  validityDays?: number;
  lines?: EstimatePdfLine[] | null;
  /** Invoice-level discount (estimate_lines.discount). Rendered only when > 0. */
  discount?: number | null;
  /** client_settings.quote_terms — wrapped as a smaller footer paragraph. */
  quoteTerms?: string | null;
}

// ── Page metrics (US Letter, points) ─────────────────────────────────────────────────────
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54; // 0.75"
const CONTENT_W = PAGE_W - MARGIN * 2; // 504

// Table columns across the 504pt content width: 140 + 10 + 214 + 10 + 40 + 10 + 80 = 504.
const COL = {
  nameX: MARGIN,
  nameW: 140,
  descX: MARGIN + 150,
  descW: 214,
  qtyRight: MARGIN + 150 + 224 + 40, // right edge of the Qty column (right-aligned)
  amountRight: PAGE_W - MARGIN,      // right edge of the Amount column (right-aligned)
};

const INK = rgb(0.13, 0.15, 0.18);
const GRAY = rgb(0.45, 0.47, 0.5);
const RULE = rgb(0.8, 0.82, 0.84);

// ── Small pure helpers ───────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100; // same as qboInvoice.ts

/** $#,##0.00 — deterministic (no Intl, so output can't drift by runtime locale). */
function fmtMoney(n: number): string {
  const v = round2(Number(n) || 0);
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v < 0 ? "-" : ""}$${grouped}.${frac}`;
}

/** Whole quantities render bare ("2"), fractional keep up to 2 decimals ("1.5"). */
function fmtQty(n: number): string {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(round2(v));
}

/**
 * WinAnsi guard. The standard fonts encode WinAnsi only and pdf-lib THROWS on a character
 * it cannot encode — and name/desc/quoteTerms are tenant-authored free text, so one emoji
 * in an item name must not 500 the whole estimate submission. Normalize the common
 * typographic characters to ASCII, then replace anything outside printable ASCII + Latin-1
 * with "?". Newlines survive (wrapText honors them); tabs become spaces.
 */
function sanitizeText(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  s = s
    .replace(/[\u2018\u2019\u201A]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D\u201E]/g, '"') // curly double quotes
    .replace(/[\u2013\u2014]/g, "-") // en/em dash
    .replace(/\u2026/g, "...") // ellipsis
    .replace(/\u00A0/g, " ") // NBSP (0xA0 sits outside the keep-range below)
    .replace(/\u2022/g, "-"); // bullet
  return s.replace(/[^\n\x20-\x7E\xA1-\xFF]/g, "?");
}

/**
 * Greedy word wrap measured with real font metrics (better than a character-count
 * heuristic — the desc column fits ~85–95 chars of 9pt Helvetica). Honors explicit
 * newlines; hard-splits any single token wider than the column so nothing can overflow.
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/ +/).filter((w) => w.length > 0);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "August 10, 2026" — UTC accessors so the rendered date can't shift by server timezone. */
function fmtDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ── The builder ──────────────────────────────────────────────────────────────────────────

export async function buildFormalEstimatePdf(input: EstimatePdfInput): Promise<Uint8Array> {
  const business = input?.business ?? {};
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  const discountRaw = Number(input?.discount);
  const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? round2(discountRaw) : 0;
  const vdRaw = Number(input?.validityDays);
  const validityDays = Number.isFinite(vdRaw) && vdRaw > 0 ? vdRaw : 30;
  const issuedMs = Date.parse(String(input?.dateIso ?? ""));
  const issued = Number.isFinite(issuedMs) ? new Date(issuedMs) : new Date();
  const validUntil = new Date(issued.getTime() + validityDays * 86_400_000);

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN; // running TOP cursor; baselines are drawn at y - size
  // While the line-item table is open, a page break repeats the table header so a spilled
  // page stays readable. Cleared before the totals block, so a totals/terms spill page is
  // a plain continuation page.
  let tableOpen = false;

  const drawTableHeader = () => {
    page.drawText("Name", { x: COL.nameX, y: y - 9, size: 9, font: bold, color: INK });
    page.drawText("Description", { x: COL.descX, y: y - 9, size: 9, font: bold, color: INK });
    const q = "Qty";
    page.drawText(q, { x: COL.qtyRight - bold.widthOfTextAtSize(q, 9), y: y - 9, size: 9, font: bold, color: INK });
    const a = "Amount";
    page.drawText(a, { x: COL.amountRight - bold.widthOfTextAtSize(a, 9), y: y - 9, size: 9, font: bold, color: INK });
    y -= 14;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.8, color: RULE });
    y -= 8;
  };

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
    if (tableOpen) drawTableHeader();
  };

  const ensureRoom = (h: number) => {
    if (y - h < MARGIN) newPage();
  };

  // ── Letterhead ────────────────────────────────────────────────────────────────────────
  const bizName = sanitizeText(business.name).trim();
  if (bizName) {
    for (const ln of wrapText(bizName, bold, 20, CONTENT_W)) {
      page.drawText(ln, { x: MARGIN, y: y - 20, size: 20, font: bold, color: INK });
      y -= 24;
    }
    y -= 2;
  }
  const addr = business.address ?? {};
  const cityState = [addr.city, addr.state]
    .map((s) => sanitizeText(s).trim())
    .filter(Boolean)
    .join(", ");
  const locality = [cityState, sanitizeText(addr.postalCode).trim()].filter(Boolean).join(" ");
  const addrOneLine = [sanitizeText(addr.addressLine1).trim(), locality].filter(Boolean).join(", ");
  const contactLine = [sanitizeText(business.phone).trim(), sanitizeText(business.website).trim(), addrOneLine]
    .filter(Boolean)
    .join(" · "); // middle dot — Latin-1, WinAnsi-safe
  if (contactLine) {
    for (const ln of wrapText(contactLine, helv, 9, CONTENT_W)) {
      page.drawText(ln, { x: MARGIN, y: y - 9, size: 9, font: helv, color: GRAY });
      y -= 12;
    }
  }
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: RULE });
  y -= 18;

  // ── Title block ───────────────────────────────────────────────────────────────────────
  const numText = sanitizeText(input?.estimateNumber).trim();
  const title = numText ? `Estimate #${numText}` : "Estimate";
  page.drawText(title, { x: MARGIN, y: y - 14, size: 14, font: bold, color: INK });
  y -= 20;
  page.drawText(`Issued: ${fmtDate(issued)}`, { x: MARGIN, y: y - 10, size: 10, font: helv, color: INK });
  y -= 14;
  page.drawText(`Valid until: ${fmtDate(validUntil)}`, { x: MARGIN, y: y - 10, size: 10, font: helv, color: GRAY });
  y -= 22;

  // ── Line-item table ───────────────────────────────────────────────────────────────────
  tableOpen = true;
  ensureRoom(40); // header + at least one row's worth
  drawTableHeader();

  let subtotal = 0;
  for (const li of lines) {
    const name = sanitizeText(li?.name).trim() || sanitizeText(li?.itemKey).trim() || "Item";
    const desc = sanitizeText(li?.desc).trim();
    const qty = Number(li?.qty) || 0; // 0-qty renders honestly as 0 / $0.00
    const unit = Number(li?.amount) || 0;
    const total = round2(qty * unit);
    subtotal += total;

    const nameLines = wrapText(name, helv, 9, COL.nameW);
    const descLines = desc ? wrapText(desc, helv, 9, COL.descW) : [];
    const rows = Math.max(nameLines.length, descLines.length, 1);
    // desc is capped at 1000 chars upstream, so a row is always far shorter than a page —
    // no row ever needs to straddle a page break.
    const rowH = rows * 12 + 6;
    ensureRoom(rowH);

    nameLines.forEach((ln, i) => {
      page.drawText(ln, { x: COL.nameX, y: y - 9 - i * 12, size: 9, font: helv, color: INK });
    });
    descLines.forEach((ln, i) => {
      page.drawText(ln, { x: COL.descX, y: y - 9 - i * 12, size: 9, font: helv, color: GRAY });
    });
    const qs = fmtQty(qty);
    page.drawText(qs, { x: COL.qtyRight - helv.widthOfTextAtSize(qs, 9), y: y - 9, size: 9, font: helv, color: INK });
    const as = fmtMoney(total);
    page.drawText(as, { x: COL.amountRight - helv.widthOfTextAtSize(as, 9), y: y - 9, size: 9, font: helv, color: INK });
    y -= rowH;
  }
  subtotal = round2(subtotal);
  tableOpen = false;

  // ── Totals ────────────────────────────────────────────────────────────────────────────
  // The whole block moves together — Subtotal on one page and Total on the next reads like
  // a mistake on a legal-ish document.
  const totalsH = 8 + 16 + (discount > 0 ? 14 : 0) + 8 + 18;
  ensureRoom(totalsH);
  y -= 8;
  const labelRight = COL.amountRight - 100; // labels right-aligned left of the value column
  const drawTotalRow = (label: string, value: string, font: PDFFont, size: number, color = INK) => {
    page.drawText(label, { x: labelRight - font.widthOfTextAtSize(label, size), y: y - size, size, font, color });
    page.drawText(value, { x: COL.amountRight - font.widthOfTextAtSize(value, size), y: y - size, size, font, color });
    y -= size + 5;
  };
  drawTotalRow("Subtotal", fmtMoney(subtotal), helv, 10);
  if (discount > 0) drawTotalRow("Discount", fmtMoney(-discount), helv, 10, GRAY);
  page.drawLine({ start: { x: labelRight - 60, y }, end: { x: COL.amountRight, y }, thickness: 0.8, color: RULE });
  y -= 6;
  // Clamped at >= 0 defensively: the upstream discount clamp should make a negative total
  // impossible, but a stale snapshot must not print a negative grand total. NOTE: no tax
  // line — the snapshot carries per-line nonTaxable flags but no tax figure; inventing one
  // here would disagree with what GHL/QBO compute. The estimate presents pre-tax numbers.
  drawTotalRow("Total", fmtMoney(Math.max(0, round2(subtotal - discount))), bold, 12);

  // ── Terms footer ──────────────────────────────────────────────────────────────────────
  const terms = sanitizeText(input?.quoteTerms).trim();
  if (terms) {
    ensureRoom(36); // heading + first couple of lines together
    y -= 12;
    page.drawText("Terms", { x: MARGIN, y: y - 9, size: 9, font: bold, color: INK });
    y -= 14;
    for (const ln of wrapText(terms, helv, 8, CONTENT_W)) {
      ensureRoom(11);
      page.drawText(ln, { x: MARGIN, y: y - 8, size: 8, font: helv, color: GRAY });
      y -= 11;
    }
  }

  // ── Page numbers (total count only known now) ─────────────────────────────────────────
  // Annotated because pdf-lib ships CJS and Deno resolves its types inconsistently: with a
  // cold npm cache `doc` degrades to `any` and these params infer fine, but once the cache is
  // warm they become implicit-any and `deno check` fails TS7006. Naming them makes the file
  // check the same either way. `p` is a pdf-lib PDFPage; typing it structurally to the one
  // method used here avoids importing a type from a module whose resolution is the problem.
  const pages = doc.getPages();
  pages.forEach((p: { drawText: (t: string, o: Record<string, unknown>) => void }, i: number) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = helv.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: MARGIN / 2, size: 8, font: helv, color: GRAY });
  });

  return await doc.save();
}
