/**
 * The StructureStudio quote document (migrations 121/122 — DDL first applied 2026-08-21).
 *
 * ONE PDF, three sheets, for tenants who have turned `invoice_in_ghl` off:
 *   1. the priced estimate — letterhead, line items, discount, terms
 *   2. the floor plan
 *   3. the building from four sides in 3D
 *
 * Sheet 1 is `buildFormalEstimatePdf` unchanged — the same builder, from the same
 * `designs.estimate_lines` snapshot, so the SS quote and the GHL-mode formal estimate cannot
 * disagree about a number. Sheets 2 and 3 are COPIED, not re-rendered: they can only be drawn
 * in a browser (canvas + WebGL), and the designer already uploads exactly them as the pages of
 * its plan PDF. Copying those pages means no second storage object (the anon upload policy
 * admits `{client_id}/SS-<code>.pdf` and nothing else — a .jpg sibling is not an option), no
 * megabyte of base64 riding the submit payload, and one source of truth for what the customer
 * saw on screen.
 *
 * NEVER THROWS ON A MISSING SHEET. A quote with the plan pages missing is a worse document; a
 * quote that failed to send because a storage fetch was slow is a lost sale. Every failure path
 * degrades to the sheets we have — at minimum the priced estimate, which is the part that has
 * to be right. Same contract as `_shared/emailSend.ts` and `_shared/qboInvoice.ts`: cosmetics
 * and bookkeeping never break the money path.
 *
 * Unit tests: _shared/_test_stubs/quotePdf_test.ts (npm: import, so it belongs to that group —
 * see the note at the top of estimatePdf.ts).
 */

// deno-lint-ignore-file no-explicit-any
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { buildFormalEstimatePdf, type EstimatePdfInput } from "./estimatePdf.ts";

/** Hard ceilings on the fetched plan PDF. A tenant's plan is tens to hundreds of KB; 20MB is
 *  far past anything legitimate and stops a wrong URL from parking an unbounded body in the
 *  function's memory. The timeout is what keeps a slow storage read from stalling a submit. */
const MAX_PLAN_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface QuotePdfInput extends EstimatePdfInput {
  /**
   * Public URL of the designer's plan PDF (`designs.image_url`): page 1 the floor plan, page 2
   * the four-sided 3D sheet when one was captured. Null/absent → estimate sheet only.
   */
  planPdfUrl?: string | null;
  /** Optional sink for why a sheet was dropped. Never used for control flow — telemetry only. */
  onSheetSkipped?: (reason: string) => void;
}

/**
 * Fetch the plan PDF. Returns null — never throws — on any of: no URL, a non-2xx, a body over
 * the cap, a timeout, or a network error.
 */
async function fetchPlanPdf(url: string, note: (r: string) => void): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) { note(`plan fetch ${res.status}`); return null; }
    // Trust the header when it is present and honest, but check the real length too — a
    // Content-Length can be absent on a chunked response, so the cap has to hold either way.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_PLAN_BYTES) { note("plan too large (header)"); return null; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PLAN_BYTES) { note("plan too large"); return null; }
    if (bytes.byteLength === 0) { note("plan empty"); return null; }
    return bytes;
  } catch (e) {
    note(`plan fetch failed: ${(e as Error)?.name || "error"}`);
    return null;
  }
}

/**
 * Build the quote document. Always returns a real PDF: the estimate sheet at minimum, with the
 * plan PDF's pages appended when they could be read.
 */
export async function buildQuotePdf(input: QuotePdfInput): Promise<Uint8Array> {
  const note = (r: string) => { try { input?.onSheetSkipped?.(r); } catch { /* telemetry only */ } };

  // Sheet 1 first and on its own: if THIS throws the caller has no document at all, which is a
  // real failure and must surface — unlike a missing plan page.
  const estimateBytes = await buildFormalEstimatePdf(input);

  const planUrl = String(input?.planPdfUrl ?? "").trim();
  if (!planUrl) { note("no plan url"); return estimateBytes; }

  const planBytes = await fetchPlanPdf(planUrl, note);
  if (!planBytes) return estimateBytes;

  try {
    const doc = await PDFDocument.load(estimateBytes);
    // ignoreEncryption: the designer's own upload is never encrypted, but a tenant who
    // hand-replaced the file with a protected PDF would otherwise take down the whole quote.
    const plan = await PDFDocument.load(planBytes, { ignoreEncryption: true });
    const pageCount = plan.getPageCount();
    if (pageCount === 0) { note("plan has no pages"); return estimateBytes; }
    const copied = await doc.copyPages(plan, plan.getPageIndices());
    copied.forEach((p: any) => doc.addPage(p));
    return await doc.save();
  } catch (e) {
    // A malformed plan PDF must not cost the customer their estimate.
    note(`plan merge failed: ${(e as Error)?.message?.slice(0, 120) || "error"}`);
    return estimateBytes;
  }
}
