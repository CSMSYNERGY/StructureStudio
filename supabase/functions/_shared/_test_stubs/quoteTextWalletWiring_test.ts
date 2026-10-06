// The quote text's wallet refusal, pinned against the SHIPPED handler (review, 2026-10-03).
//
// sendTenantSms refuses with reason 'wallet_empty' when the builder's prepaid wallet is under
// the usage floor while texts are armed (migration 259). submit-estimate passed every refusal
// reason straight into its JSON as quoteTextReason, and that JSON is also read by the anonymous
// shopper on the public designer: anyone with devtools could learn that a builder had not
// funded its account. Nothing failed, and no unit test can see it, because the leak is one
// assignment in a 3,800-line handler.
//
// THE RULE PINNED: every assignment of quoteTextReason from the send's outcome hides
// wallet_empty ("failed") unless the caller is signed-in staff (staffCaller, the same flag that
// already guards the send's raw error). Same technique as smsQuietHoursWiring_test: read the
// source, so a drift fails the push. If an anchor moves, re-point it; do not delete the test.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES the reason cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const SUBMIT = code(await Deno.readTextFile(new URL("submit-estimate/index.ts", FUNCTIONS)));

/** From the quote text's send to the success response that carries quoteTextReason. */
function quoteTextBlock(): string {
  const start = SUBMIT.indexOf("const send = sendTenantSms(");
  const end = start < 0 ? -1 : SUBMIT.indexOf("quoteTextReason,", start);
  assert(start >= 0 && end > start, `quoteTextWalletWiring_test: could not find the quote text block (start=${start}, end=${end}). Re-point the anchors.`);
  return SUBMIT.slice(start, end);
}

Deno.test("submit-estimate: the caller's staff flag is resolved before the quote text is answered", () => {
  const declared = SUBMIT.indexOf("let staffCaller = false;");
  const used = SUBMIT.indexOf("const send = sendTenantSms(");
  assert(declared >= 0, "staffCaller is no longer declared — re-point this test");
  assert(used > declared, "the quote text runs before staffCaller is resolved");
});

Deno.test("submit-estimate: a wallet_empty refusal reaches only signed-in staff; anonymous shoppers read 'failed'", () => {
  const block = quoteTextBlock();
  const fromOutcome = [...block.matchAll(/quoteTextReason\s*=\s*([^;]+);/g)].map((m) => m[1]).filter((rhs) => rhs.includes("outcome.reason"));
  assert(fromOutcome.length >= 1, "no assignment of quoteTextReason from outcome.reason was found — re-point this test");
  for (const rhs of fromOutcome) {
    assert(
      /outcome\.reason\s*===\s*"wallet_empty"\s*&&\s*!staffCaller\s*\?\s*"failed"/.test(rhs),
      `quoteTextReason takes the send's reason without hiding wallet_empty from an anonymous caller: ${rhs.trim()}`,
    );
  }
});
