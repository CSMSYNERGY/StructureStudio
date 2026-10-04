// portal-settings' error contract, pinned against the SHIPPED source.
//
// The contract (dbFail's header, and CLAUDE.md's portal-settings note): a sentence THIS function
// writes goes to the browser verbatim; text it did not write does not — a Postgres message, a
// third party's response body (GoHighLevel's), or the runtime's network error text. Those go to
// app_errors under the label the builder is shown, and the builder gets our sentence.
//
// Nine returns had slipped past it: the invoice-number allocation echoed Postgres, the two
// operator audit refusals echoed auditStrict's message (which carries the insert's Postgres text),
// send_invoice's convert / send / resend / estimate-list failures echoed GoHighLevel's body or the
// fetch error, and the two GHL connection checks echoed the fetch error.
//
// Lifted, not copied, so a drift fails the push. Same technique as style3dErrors_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

// ── 1. No return hands provider text to the browser ──────────────────────────────────────────
// What a leak looks like on one line. setClaim(...) rows are exempt: invoice_sends is service-role
// only and its `error` column is the support record, never put on the wire (the activity read
// leaves it out). skipped.push lines are exempt by colorSaveReason's documented choice.
const RAW = [
  /\berror:\s*\(?\s*[A-Za-z_$][\w$]*\s+as\s+Error\s*\)?\s*\.message\b/, // error: (e as Error).message
  /\berror:\s*[A-Za-z_$][\w$.?]*\.message\b/, //                           error: allocErr.message
  /\berror:\s*`[^`]*\$\{[^}]*(\.message|\bnetErr)\b/, //                  error: `… ${x.message} …`
];

Deno.test("no portal-settings return puts a database, CRM or network message in `error`", () => {
  const hits = SRC.split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !/setClaim\(|skipped\.push|^\s*\/\//.test(l))
    .filter(({ l }) => RAW.some((re) => re.test(l)))
    .map(({ l, n }) => `${n}: ${l.trim().slice(0, 120)}`);
  assertEquals(hits, [], "raw provider text reaches the browser; use dbFail, or log it and write the sentence");
});

Deno.test("the scan still recognises each leak it exists for", () => {
  // If these stop matching, the test above passes blind.
  for (const line of [
    "return json({ error: `Could not allocate an invoice number: ${allocErr.message}` }, 502);",
    "return json({ error: (e as Error).message }, 503);",
    "return json({ error: `Creating the invoice failed: ${convRes.body?.message ?? convRes.status ?? convRes.netErr}` }, 502);",
    "return json({ error: `Could not read estimates from your CRM (${r.status || r.netErr}).` }, 502);",
  ]) assert(RAW.some((re) => re.test(line)), `the scan no longer catches: ${line}`);
});

Deno.test("the activity drawer's invoice_sends read leaves the error column off the wire", () => {
  const i = SRC.indexOf('invoiceSends: sends ?? []');
  assert(i > 0, "settingsErrorContract_test: the invoiceSends return moved — re-point this anchor");
  const sel = SRC.lastIndexOf('.from("invoice_sends")', i);
  const read = SRC.slice(sel, SRC.indexOf(";", sel));
  assert(!/\berror\b/.test(read.replace(/\/\/.*$/gm, "")), `the activity read selects invoice_sends.error: ${read}`);
});
