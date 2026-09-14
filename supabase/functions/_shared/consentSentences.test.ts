// Deliberately dependency-free (no jsr:/npm: imports), like the other _shared tests.
//
// These pins are byte-for-byte on purpose. The sentences are stored verbatim as consent
// evidence (design_acceptances.consent_text) and printed by two pages, so ANY change here —
// a comma, a space — is a change to what customers agree to and must be a conscious one.
import { consentSentence, consentSentenceClick, consentSentenceInvoice, fmtMoney } from "./consentSentences.ts";

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
