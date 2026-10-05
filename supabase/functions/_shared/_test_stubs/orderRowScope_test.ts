// Every portal-settings action that reads or writes ONE order's paperwork or change orders asks
// the row scope (migration 207) before it touches the database.
//
// Why this test exists. contacts:'own' narrows a caller to their own customers — a Dealer holds
// orders:edit with contacts:'own' — and GATES can only say "may you do this KIND of thing". The
// row is refuseUnlessDesignVisible's job, and these actions take a short code (or a change order
// id) straight from the browser. send_invoice, dismiss_invoice_request, text_sign_link and
// resend_quote_email asked; the rest of the order screen did not, so a narrowed caller could
// rebuild and resend another rep's customer's invoice, read its paperwork, stage, send, attest or
// void a change on it, or open and finalise an amendment — by posting a code.
//
// Read against the SHIPPED source, like the other *Wiring tests: an action's branch runs from its
// `if (action === "x")` to the next top-level action, and the check must appear before that
// branch's first database read or write.

import { assert } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(
  new URL("../../portal-settings/index.ts", import.meta.url),
)).replace(/\r\n/g, "\n");

function branch(action: string): string {
  const start = SRC.indexOf(`\n  if (action === "${action}"`);
  assert(start >= 0, `portal-settings: no \`if (action === "${action}")\` branch — the anchor moved; re-point it`);
  const next = SRC.indexOf("\n  if (action === ", start + 10);
  return SRC.slice(start, next < 0 ? undefined : next);
}

// Short code from the body: checked before anything is read.
const BY_CODE = [
  "send_invoice", "dismiss_invoice_request", "reissue_invoice", "order_paperwork",
  "stage_order_attribute_change", "amendment_status", "request_order_unlock",
  "decide_order_unlock", "open_amendment", "retry_qbo_push", "apply_change_order_money",
];
// Change order id from the body: checked on the change order's own short_code, right after it is
// found and before anything else is read or written.
const BY_CHANGE_ORDER = ["send_change_order", "void_change_order", "attest_change_order", "finalize_amendment"];

for (const action of BY_CODE) {
  Deno.test(`${action}: asks the row scope before touching the database`, () => {
    const b = branch(action);
    const check = b.indexOf("refuseUnlessDesignVisible(shortCode)");
    assert(check >= 0, `${action} never calls refuseUnlessDesignVisible(shortCode)`);
    const firstDb = b.search(/admin\.(from|rpc|storage)\(/);
    assert(firstDb < 0 || check < firstDb, `${action}: the row scope runs after a database call`);
  });
}

for (const action of BY_CHANGE_ORDER) {
  Deno.test(`${action}: asks the row scope on the change order's design`, () => {
    const b = branch(action);
    const check = b.indexOf("refuseUnlessDesignVisible(String(co.short_code");
    assert(check >= 0, `${action} never checks the row scope of the change order's design`);
    // Exactly one database call — loading the change order itself — may come first.
    const calls = [...b.matchAll(/admin\.(from|rpc|storage)\(/g)].map((m) => m.index ?? 0);
    assert(calls.length >= 1 && calls[0] < check, `${action}: expected the change-order read before the check`);
    assert(calls.length < 2 || calls[1] > check, `${action}: a second database call runs before the row scope`);
  });
}
