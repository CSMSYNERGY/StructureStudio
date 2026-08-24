/**
 * Money math over the designs.estimate_lines snapshot — submit-estimate step 11's shape:
 *   { version, discount, lines: [{ kind, itemKey, name, desc, qty, amount, nonTaxable }] }
 *
 * `amount` is the UNIT price; a line's total is qty * amount. Round each line total, sum,
 * subtract a positive discount, round 2dp, clamp at >= 0 — the exact math estimatePdf.ts
 * and qboInvoice.ts use, extracted here (2026-08-23) because a THIRD consumer arrived
 * (customer acceptance snapshots the total the customer signed for; the SS invoice adds a
 * fourth). One implementation, so the PDF, the books, the acceptance record and the
 * customer's screen can never disagree about the same snapshot.
 *
 * Returns null when there is no snapshot — older designs predate it, and null renders
 * honestly as "—" instead of a fabricated $0.00.
 */

// deno-lint-ignore-file no-explicit-any

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * De-render the GHL-flavored HTML that estimate_lines.desc carries (the floor-plan <a>
 * link prepended to the building line, and <br>-joined credit notes, both entity-escaped)
 * into the plain text every PDF renders: drop anchors whole (a link label with no href is
 * noise on paper), <br> → newline, strip tags, then unescape in reverse of the escape
 * order (&lt;/&gt; before &amp;).
 *
 * Shared here (2026-08-24, moved from submit-estimate's module scope) because the SS
 * invoice renders the same snapshot from portal-settings — two copies of an HTML stripper
 * that must agree is precisely the drift worth avoiding.
 */
export const deHtml = (s: string) =>
  s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();

export function totalFromSnapshot(snap: any): number | null {
  if (!snap || !Array.isArray(snap.lines)) return null;
  let subtotal = 0;
  for (const li of snap.lines) {
    const qty = Number(li?.qty) || 0;
    const unit = Number(li?.amount) || 0;
    subtotal += round2(qty * unit);
  }
  subtotal = round2(subtotal);
  const discount = Number(snap.discount) || 0;
  if (discount > 0) subtotal = round2(subtotal - discount);
  // Clamped at >= 0 like estimatePdf.ts' Total row (audit 2026-08-20).
  return Math.max(0, subtotal);
}
