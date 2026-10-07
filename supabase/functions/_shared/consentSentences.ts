// The sentences a customer agrees to when they accept a quote or sign an invoice — composed
// in ONE place (moved out of customer-accept, 2026-09-15).
//
// ⚠️ THESE STRINGS ARE EVIDENCE, NOT COPY. customer-accept stores the composition verbatim as
// design_acceptances.consent_text, so the sentence beside the checkbox and the sentence the
// record holds must be the same bytes. Until now they lived inside customer-accept and
// my-quotes.html kept a hand-copied twin. The designer's account panel (Carolyn, 2026-09-14:
// accept and sign from the designer, not a separate page) has to print them too, and a third
// hand-kept copy is how one of them quietly drifts — so customer-quotes now sends each quote's
// exact sentence down with the list and the panel prints what it is given.
//
// Changing a sentence changes what every future customer agrees to. The wording is Carolyn's
// (signature 2026-08-23, click accept 2026-08-25); an edit goes past her first, and
// my-quotes.html's client-side copies (toggleAcceptPanel / toggleSignPanel) change with it.
//
// Dependency-free on purpose (no jsr:/npm: imports): _shared/*.test.ts runs with no import map.
// IMPORTERS: customer-accept, customer-quotes — redeploy BOTH when this file changes, or the
// sentence the panel shows and the sentence the accept stores come from different builds.

/** Signing the QUOTE (the drawn/typed signature path, migration 124). */
export function consentSentence(quoteNumber: string, totalDisplay: string | null): string {
  return `I agree that my electronic signature is as binding as a handwritten one, and I accept estimate ${quoteNumber}${totalDisplay ? ` for ${totalDisplay}` : ""}.`;
}

/** Accepting a quote is not signing for it. The sentence says what the customer is actually
 *  agreeing to — that they want to go ahead, and that the binding document arrives next —
 *  so nobody can later claim a click was presented to them as a signature. */
export function consentSentenceClick(quoteNumber: string, totalDisplay: string | null): string {
  return `I accept estimate ${quoteNumber}${totalDisplay ? ` for ${totalDisplay}` : ""} and understand that my builder will send me an invoice to sign.`;
}

/** The invoice is the binding document now, so this is the sentence that carries the weight
 *  the quote's used to. Same "as binding as handwritten" language, pointed at the invoice. */
export function consentSentenceInvoice(invoiceNumber: string, totalDisplay: string | null): string {
  return `I agree that my electronic signature is as binding as a handwritten one, and I accept invoice ${invoiceNumber}${totalDisplay ? ` for ${totalDisplay}` : ""}.`;
}

/** Signing off a CHANGE to a signed order (ack_change_order, 2026-09-07). The figure is the
 *  WHOLE revised order — every acknowledged change and every fee — not this change alone,
 *  and the sentence names what it replaces. Moved here from customer-accept unchanged so
 *  customer-quotes can send the customer the exact text the signature will store: my-quotes
 *  kept a hand-written copy ("I approve change order CO-n … for a new total of <this
 *  change's after-figure>") that had stopped matching the stored sentence, figure included. */
export function consentSentenceChangeOrder(p: {
  /** invoice_sends.invoice_number, raw — any truthy value makes the document an "invoice". */
  invoiceNumber: unknown;
  quoteNumber: string;
  coNo: number | string;
  /** The whole revised order, in dollars, or null when it cannot be computed. */
  newTotal: number | null;
  feeCents: number;
  feeTaxCents: number;
  /** YYYY-MM-DD of the invoice signature this revision replaces, or null. */
  priorDate: string | null;
  /** What the customer has paid above the revised total, in cents (0 when nothing). */
  refundCents: number;
}): string {
  const docName = String(p.invoiceNumber ?? "").trim() || p.quoteNumber;
  return `I agree that my electronic signature is as binding as a handwritten one, and I accept the revised ` +
    `${p.invoiceNumber ? "invoice" : "estimate"} ${docName} (revision ${p.coNo})` +
    (p.newTotal == null ? "" : ` for ${fmtMoney(p.newTotal)}`) +
    `, which includes change order CO-${p.coNo}` +
    (p.feeCents > 0 ? ` and a change order fee of ${fmtMoney((p.feeCents + p.feeTaxCents) / 100)}` : "") +
    (p.priorDate ? `, and replaces the version I signed on ${p.priorDate}` : "") +
    (p.refundCents > 0 ? `. The revised total is below what I have already paid, and ${fmtMoney(p.refundCents / 100)} is to be refunded to me` : "") +
    `.`;
}

/** The money figure inside those sentences. Rounded to cents FIRST, so a float tail can never
 *  print a different cent than the invoice does. Deliberately not emailTemplates' formatMoney:
 *  that one passes pre-formatted strings through, and a sentence must only ever name a number. */
export const fmtMoney = (n: number): string => {
  const v = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};
