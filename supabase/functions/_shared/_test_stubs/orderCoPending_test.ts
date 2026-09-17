// Order-screen change orders and the invoice email retry, pinned against the SHIPPED
// portal-settings source.
//
// Why this test exists (2026-09-17). Two paths in portal-settings answered a 5xx fault for
// something that was never a fault:
//
//   1. stage_order_attribute_change adopted only a live 'design_edit' change order. A MANUAL
//      change order waiting on the customer was invisible to it, so it rewrote the design row
//      and then hit the source-blind one-live-CO index on the insert: a 500, and an order left
//      revised with no change order recorded. The fix is a source-blind check that refuses
//      with 409 co_pending BEFORE anything is written and before the dry-run preview returns.
//      Its value is entirely in WHERE it sits, and a later edit that moves a write above it
//      (or narrows the lookup back to one source) fails silently, so the order is pinned here.
//
//   2. send_invoice's already-invoiced email retry turned a provider rejection of a
//      placeholder address into a 502 row reading "(failed)". The retry now skips the
//      provider for a placeholder address and answers 200 sent:false in the SAME shape as its
//      success return, because the production designer navigates off `orderId` from it.
//
// No login and no database can drive either path from a test, so this uses the technique of
// operatorMirror_test / crmRecordGate_test: slice the real block between stable anchors,
// guard loudly if they move, assert on the code with comment lines stripped.

import { assert } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../portal-settings/index.ts", import.meta.url),
);

/** The slice between two anchors, comment lines stripped so a comment cannot satisfy or fail
 *  an assertion the way the code would. */
function codeBetween(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(
      `orderCoPending_test: could not find the ${label} block ` +
        `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
    );
  }
  return src.slice(i, j).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

const STAGE = codeBetween(
  SRC,
  'if (action === "stage_order_attribute_change") {',
  'if (action === "void_change_order") {',
  "stage_order_attribute_change",
);

/** Index of `needle` in `hay`, failing loudly when it is absent (a -1 would pass a `<`). */
function at(hay: string, needle: string, label: string): number {
  const k = hay.indexOf(needle);
  assert(k >= 0, `${label}: expected to find ${JSON.stringify(needle)}`);
  return k;
}

Deno.test("the co_pending guard reads live change orders of EVERY source", () => {
  const g0 = at(STAGE, "const { data: liveCo, error: liveErr }", "guard lookup");
  const g1 = at(STAGE, 'reason: "co_pending"', "guard refusal");
  const guard = STAGE.slice(g0, g1);
  assert(guard.includes('.in("status", ["draft", "pending_ack"])'), "the guard must cover both live states");
  assert(!guard.includes('.eq("source"'), "the guard lookup has been narrowed to one source again");
  assert(guard.includes('String(liveCo.source) !== "design_edit"'), "only a CO this handler cannot adopt is refused");
  assert(STAGE.slice(g1, g1 + 60).includes("}, 409);"), "co_pending must answer 409");
});

Deno.test("the co_pending guard runs before the dry-run return and before every write", () => {
  const guard = at(STAGE, 'reason: "co_pending"', "guard refusal");
  const writes: [string, string][] = [
    ["if (dryRun) {", "the dry-run preview return"],
    ["chargeTaxCalculation(", "the tax-lookup meter charge"],
    ["update({ selections: newSelections", "the designs update"],
    ['from("design_versions").insert(', "the design_versions insert"],
    ['source: "design_edit",', "the change order insert"],
    ["regenerateQuotePdf(", "the quote PDF regeneration"],
  ];
  for (const [needle, label] of writes) {
    assert(guard < at(STAGE, needle, label), `the co_pending guard must come before ${label}`);
  }
});

Deno.test("a 23505 on the change order insert answers the same 409, not dbFail's 500", () => {
  const race = at(STAGE, 'String(coErr.code) === "23505"', "23505 backstop");
  const fail = at(STAGE, 'dbFail(req, clientId, "raise the change order", coErr)', "insert dbFail");
  assert(race < fail, "the 23505 backstop must be checked before the generic dbFail");
  const backstop = STAGE.slice(race, fail);
  assert(backstop.includes('reason: "co_pending"') && backstop.includes("}, 409);"), "the backstop must be a 409 co_pending");
  assert(backstop.includes('severity: "info"') && backstop.includes('code: "co_pending_race"'), "the backstop must leave an info row — the design was already written");
});

const RETRY = codeBetween(
  SRC,
  'if (prior && String(prior.status) === "created" && String(prior.issued_by) === "structurestudio" && prior.invoice_number) {',
  'return json({ error: "This design was already invoiced." }, 400);',
  "send_invoice email retry",
);

Deno.test("the retry skips the provider for a placeholder address", () => {
  const check = at(RETRY, "isPlaceholderRecipient(to2)", "placeholder check");
  assert(check < at(RETRY, "sendTenantEmail(", "provider send"), "the placeholder check must run before sendTenantEmail");
  assert(at(RETRY, "if (!isEmail(to2))", "isEmail check") < check, "isEmail still runs first");
});

Deno.test("the placeholder answer mirrors the retry's success shape and logs info with no address", () => {
  const p0 = at(RETRY, "isPlaceholderRecipient(to2)", "placeholder check");
  const p1 = at(RETRY, "const amend2 = await loadAmendments();", "the send path after it");
  const branch = RETRY.slice(p0, p1);
  for (
    const field of [
      "ok: true",
      "invoiceNumber: prior.invoice_number",
      "invoicePdfUrl: prior.invoice_pdf_url",
      'issuedBy: "structurestudio"',
      "sent: false",
      "attested: false",
      "quoteNumber: d.ss_quote_number",
      "...(await loadOrderRef())",
      "emailReason:",
    ]
  ) {
    assert(branch.includes(field), `the placeholder response is missing ${field}`);
  }
  assert(!/\},\s*[45]\d\d\);/.test(branch), "the placeholder answer must be a 200, not an error status");
  assert(branch.includes('severity: "info"') && branch.includes('code: "invoice_email_placeholder"'), "the skip must leave an info row");
  const ctx = branch.slice(at(branch, "context:", "log context"));
  assert(!/context:[^}]*\bto2\b/.test(ctx), "the log row must not carry the customer's address");
});

Deno.test("a real retry failure stays a 502 with a sentence, never the bare status or provider text", () => {
  const send = at(RETRY, "sendTenantEmail(", "provider send");
  const tail = RETRY.slice(send);
  assert(tail.includes("sent: false }, 502);"), "a real send failure must stay a 502 fault");
  assert(!tail.includes('out2.reason || "failed"'), 'the bare "(failed)" is back');
  assert(!/out2\.error/.test(tail), "the provider's raw string must not reach the response");
});
