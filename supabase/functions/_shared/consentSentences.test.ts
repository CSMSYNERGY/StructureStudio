// Deliberately dependency-free (no jsr:/npm: imports), like the other _shared tests.
//
// These pins are byte-for-byte on purpose. The sentences are stored verbatim as consent
// evidence (design_acceptances.consent_text) and printed by two pages, so ANY change here —
// a comma, a space — is a change to what customers agree to and must be a conscious one.
import { consentSentence, consentSentenceChangeOrder, consentSentenceClick, consentSentenceInvoice, fmtMoney } from "./consentSentences.ts";

function assertEq(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "assertEq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("click accept: the approved sentence, with and without a total", () => {
  assertEq(
    consentSentenceClick("JB-1041", "$12,345.50"),
    "I accept quote JB-1041 for $12,345.50 and understand that my builder will send me an invoice to sign.",
  );
  assertEq(
    consentSentenceClick("JB-1041", null),
    "I accept quote JB-1041 and understand that my builder will send me an invoice to sign.",
  );
});

Deno.test("click accept never reads as a signature", () => {
  // The whole point of the click sentence (Carolyn 2026-08-25): accepting is not signing.
  const s = consentSentenceClick("JB-1041", "$1.00");
  if (/signature|binding/i.test(s)) throw new Error(`click sentence must not claim a signature: ${s}`);
});

Deno.test("quote signature: the approved sentence, with and without a total", () => {
  assertEq(
    consentSentence("JB-1041", "$12,345.50"),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept quote JB-1041 for $12,345.50.",
  );
  assertEq(
    consentSentence("JB-1041", null),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept quote JB-1041.",
  );
});

Deno.test("invoice signature: the approved sentence, with and without a total", () => {
  assertEq(
    consentSentenceInvoice("000012", "$3,250.00"),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept invoice 000012 for $3,250.00.",
  );
  assertEq(
    consentSentenceInvoice("000012", null),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept invoice 000012.",
  );
});

Deno.test("an empty total display is treated as no total, not as ' for '", () => {
  assertEq(consentSentenceClick("Q-1", ""), consentSentenceClick("Q-1", null));
  assertEq(consentSentence("Q-1", ""), consentSentence("Q-1", null));
  assertEq(consentSentenceInvoice("1", ""), consentSentenceInvoice("1", null));
});

Deno.test("fmtMoney: cents, thousands separators, sign", () => {
  assertEq(fmtMoney(12345.5), "$12,345.50");
  assertEq(fmtMoney(0), "$0.00");
  assertEq(fmtMoney(999), "$999.00");
  assertEq(fmtMoney(1000000), "$1,000,000.00");
  assertEq(fmtMoney(-42.1), "-$42.10");
});

Deno.test("fmtMoney rounds to cents before formatting, so no '-$0.00' ever reaches a sentence", () => {
  assertEq(fmtMoney(10505.139999999), "$10,505.14");
  assertEq(fmtMoney(0.1 + 0.2), "$0.30");
  // -0.001 rounds to -0; a sentence naming "-$0.00" would read as a refund.
  assertEq(fmtMoney(-0.001), "$0.00");
});

Deno.test("change order sign-off: the whole revised order, byte for byte", () => {
  // The sentence customer-accept's ack_change_order stores, and since 2026-10-04 the one
  // customer-quotes sends my-quotes to print beside the checkbox. Pinned in full, both
  // documents, every optional clause on and off.
  assertEq(
    consentSentenceChangeOrder({
      invoiceNumber: "JB-INV-8005", quoteNumber: "JB-1041", coNo: 2, newTotal: 4050,
      feeCents: 15000, feeTaxCents: 1088, priorDate: "2026-09-01", refundCents: 0,
    }),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept the revised invoice JB-INV-8005 (revision 2) for $4,050.00, which includes change order CO-2 and a change order fee of $160.88, and replaces the version I signed on 2026-09-01.",
  );
  assertEq(
    consentSentenceChangeOrder({
      invoiceNumber: null, quoteNumber: "JB-1041", coNo: 1, newTotal: null,
      feeCents: 0, feeTaxCents: 0, priorDate: null, refundCents: 0,
    }),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept the revised quote JB-1041 (revision 1), which includes change order CO-1.",
  );
  assertEq(
    consentSentenceChangeOrder({
      invoiceNumber: "SSI-9", quoteNumber: "Q-7", coNo: 3, newTotal: 3200,
      feeCents: 0, feeTaxCents: 0, priorDate: "2026-09-02", refundCents: 45000,
    }),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept the revised invoice SSI-9 (revision 3) for $3,200.00, which includes change order CO-3, and replaces the version I signed on 2026-09-02. The revised total is below what I have already paid, and $450.00 is to be refunded to me.",
  );
});

Deno.test("change order sign-off: a blank invoice number keeps customer-accept's word and name", () => {
  // The document WORD keys on the raw value and the NAME on the trimmed one — kept exactly.
  assertEq(
    consentSentenceChangeOrder({
      invoiceNumber: "  ", quoteNumber: "Q-7", coNo: 1, newTotal: 10,
      feeCents: 0, feeTaxCents: 0, priorDate: null, refundCents: 0,
    }),
    "I agree that my electronic signature is as binding as a handwritten one, and I accept the revised invoice Q-7 (revision 1) for $10.00, which includes change order CO-1.",
  );
});
