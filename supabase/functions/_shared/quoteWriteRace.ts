// An issued quote has two writers, and they must not leave its document and its row disagreeing
// (review, 2026-09-17).
//
// THE TWO WRITERS. submit-estimate re-prices a quote on every resubmit. portal-settings'
// restampQuoteTax re-prices its tax from the portal (the Verify button, a sales-location change).
// Both write designs.estimate_lines + total_cents, and both upload the quote PDF to the SAME fixed
// path, floor-plans/<client>/<code>-quote.pdf, which the quote email and the customer's quote page
// link to.
//
// WHAT WENT WRONG. The re-stamp's write was already a compare-and-swap; submit-estimate's persist
// was not, and it uploaded its PDF and emailed the customer BEFORE persisting. A re-stamp landing
// between the submit's read and its persist was overwritten (a paid, verified rate silently
// dropped), and whichever PDF upload happened to land last decided what the document printed. The
// stored PDF could print the re-stamp's total while estimate_lines, the quote page and the
// acceptance froze the submit's.
//
// THE RULE BOTH WRITERS NOW FOLLOW, and why it is enough:
//   1. the money write is a compare-and-swap on the updated_at the writer priced from. A miss is
//      read here (submitPersistMiss): a foreign re-stamp refuses the submit before anything is
//      uploaded or emailed, so the re-stamp, its PDF and its email stand together;
//   2. the PDF is uploaded AFTER the write it prints, never before;
//   3. after uploading, the writer re-reads the stored lines, and when they are no longer the lines
//      it printed (quotePdfStale), it prints the stored ones instead.
// Take the LAST upload of all. Its writer re-read the lines after that upload. Every money write
// comes before its own writer's upload (2), and so before that last upload and that re-read, so
// the re-read saw the final lines. Had they differed from the printed ones, the writer would have
// uploaded again (3), and that upload would be the last. So the last document prints the final
// row. Emails are not part of the proof: each names the total its own writer just made current.
//
// PURE. Both callers do the reads and writes. Importers: submit-estimate and portal-settings.
// Derive them before a deploy rather than trusting this line:
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*quoteWriteRace\.ts"}s' {}

import { isAgreedDesign } from "./locationTax.ts";

/** The fields that say who stamped a tax and when. Every stamp that prices a quote afresh
 *  (taxChain's stampTax, the Verify button's verifiedTax) writes a new `resolvedAt`; a carried
 *  tax (carriedTax) keeps every one of these verbatim and recomputes only the amount and pools,
 *  which follow the lines rather than the stamp. */
const STAMP_FIELDS = ["source", "basis", "rate", "label", "jurisdiction", "locationId", "resolvedAt", "verifiedAt", "reason"] as const;

const taxObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/**
 * Is `a` the same tax STAMP as `b`? No tax on both sides is the same (a first issue). The rate is
 * compared as a number, so 0.0725 read back from jsonb matches the 0.0725 that was written.
 */
export function sameTaxStamp(a: unknown, b: unknown): boolean {
  const x = taxObject(a), y = taxObject(b);
  if (!x || !y) return !x && !y;
  return STAMP_FIELDS.every((k) => {
    const vx = x[k] ?? null, vy = y[k] ?? null;
    if (k === "rate" && vx != null && vy != null) return Number(vx) === Number(vy);
    return vx === vy;
  });
}

export type SubmitPersistMiss =
  | { kind: "retry"; updatedAt: string | null }
  | { kind: "retaxed" }
  | { kind: "accepted" }
  | { kind: "gone" };

/**
 * submit-estimate's persist matched no row: why, from a fresh read of the design (`now`, null when
 * it is gone). `readTax` is the tax the submit read and priced from; `stampedTax` is the tax it is
 * about to write.
 *   - gone: the design was deleted under the submit;
 *   - accepted: the customer agreed (accepted_at, or the status ladder) after the submit read an
 *     unsigned quote. The submit priced it as a quote, not as an amendment, and must not overwrite
 *     a signed order's lines; a resubmit now takes the change-order path;
 *   - retaxed: the stored tax is neither the one the submit read nor the one it stamped, so another
 *     writer re-priced the quote in between (the Verify button, a sales-location change). The
 *     submit refuses before anything is uploaded or emailed, and the resubmit starts from the new
 *     tax: a verified rate is carried, a location rate re-derived;
 *   - retry: the tax is untouched, or is the submit's own stamp (its draft promote wrote it). An
 *     unrelated write moved updated_at; swap against the fresh value.
 */
export function submitPersistMiss(input: {
  readTax: unknown;
  stampedTax: unknown;
  now: { estimate_lines?: unknown; accepted_at?: unknown; status?: unknown; updated_at?: unknown } | null | undefined;
}): SubmitPersistMiss {
  const now = input.now;
  if (!now) return { kind: "gone" };
  if (isAgreedDesign(now)) return { kind: "accepted" };
  const tax = (now.estimate_lines as { tax?: unknown } | null | undefined)?.tax ?? null;
  if (sameTaxStamp(tax, input.readTax) || sameTaxStamp(tax, input.stampedTax)) {
    return { kind: "retry", updatedAt: typeof now.updated_at === "string" ? now.updated_at : null };
  }
  return { kind: "retaxed" };
}

/** What submit-estimate answers when a persist loses to another writer. Read by an anonymous
 *  shopper as often as by staff, so neither names the portal or a button. Nothing was emailed and
 *  no document was replaced, and each says so, so pressing the button again is plainly safe. */
export const SUBMIT_RACE_REFUSAL = {
  retaxed: {
    error: "This quote was updated while it was being submitted, so nothing was sent. Submit it again to send the updated quote.",
    reason: "changed",
  },
  accepted: {
    error: "This quote was accepted while it was being submitted, so these changes weren't saved and nothing was sent. Reopen the design: a change to an accepted quote is sent as a change order.",
    reason: "accepted",
  },
} as const;

/**
 * Does the document just uploaded print lines the design no longer holds? Both sides are
 * estimate_lines as the DATABASE returned them (the writer's own write read back, and a fresh
 * read), so jsonb's key order and number formatting are the same on both, and a plain string
 * compare is exact. An in-memory object must never be passed as either side.
 */
export function quotePdfStale(printed: unknown, stored: unknown): boolean {
  return JSON.stringify(printed ?? null) !== JSON.stringify(stored ?? null);
}
