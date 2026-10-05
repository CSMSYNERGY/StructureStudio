// billing_webhook_events stores the REDACTED copy of a gateway event, never the body itself.
//
// WHY THIS EXISTS. Until 2026-10 billing-webhook inserted the raw Deposyt/NMI body, and every stored
// row carried the payer's masked card number, expiry, name, email and phone — for other products'
// customers too, because the gateway account is shared. _shared/billingWebhookRedact.ts is the fix
// and migration 281 scrubbed what was already stored; both are undone, silently, by one edit that
// puts `payload` back into the insert. Nothing would fail: the webhook processes the parsed body in
// memory either way, and nobody reads the stored copy. So the wiring is pinned here, on the shipped
// source, the way the other *Wiring tests pin theirs.
//
// ⚠️ WHAT THIS DOES NOT PROVE. That the redactor's whitelist is right — billingWebhookRedact.test.ts
// does that, against the live shape. This proves the webhook uses it, on every write to the table.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");

const SRC = await read("../../billing-webhook/index.ts");
const CONFIG = await read("../../../config.toml");

// Every statement that names the table: from `.from("billing_webhook_events")` to the end of the
// chained call (the first `;` after it — none of these calls has a `;` inside its arguments).
const statements = (() => {
  const out: string[] = [];
  const needle = `.from("billing_webhook_events")`;
  for (let i = SRC.indexOf(needle); i >= 0; i = SRC.indexOf(needle, i + 1)) {
    out.push(SRC.slice(i, SRC.indexOf(";", i)));
  }
  return out;
})();

Deno.test("the webhook imports the redactor from _shared", () => {
  assert(
    /import \{[^}]*\bredactWebhookPayload\b[^}]*\} from "\.\.\/_shared\/billingWebhookRedact\.ts";/.test(SRC),
    "billing-webhook must import redactWebhookPayload from ../_shared/billingWebhookRedact.ts",
  );
});

Deno.test("the event-log insert stores redactWebhookPayload(payload), never the raw payload", () => {
  const inserts = statements.filter((s) => s.includes(".insert("));
  assertEquals(inserts.length, 1, "exactly one insert into billing_webhook_events");
  const args = inserts[0].slice(inserts[0].indexOf(".insert("));
  assert(args.includes("payload: redactWebhookPayload(payload)"), `the insert must pass the redacted copy:\n${args}`);
  // The shorthand `{ ..., payload }` (or `payload: payload`, or a spread) is exactly the old bug.
  const bare = args.replace("redactWebhookPayload(payload)", "");
  assert(!/\bpayload\b(?!\s*:)/.test(bare), `the raw payload must not reach the insert:\n${args}`);
  assert(!/\.\.\.\s*payload\b/.test(args), "and must not be spread into it");
});

Deno.test("no other write to the table carries a payload", () => {
  for (const s of statements) {
    if (s.includes(".insert(")) continue;
    assert(!/\.(upsert|insert)\(/.test(s), `an unexpected write:\n${s}`);
    if (/\.update\(/.test(s)) {
      assert(!/\bpayload\b/.test(s), `the status update must not rewrite the payload:\n${s}`);
    }
  }
  assert(statements.some((s) => /\.select\("id, status"\)/.test(s)), "the idempotency read stays on id + status");
  assert(statements.some((s) => /\.update\(/.test(s)), "the processed/failed update is still there");
});

Deno.test("billing-webhook stays verify_jwt = false (the gateway cannot send a JWT)", () => {
  const i = CONFIG.indexOf("[functions.billing-webhook]");
  assert(i >= 0, "config.toml still declares billing-webhook");
  const block = CONFIG.slice(i, CONFIG.indexOf("\n[", i + 1));
  assert(/^verify_jwt = false$/m.test(block), `verify_jwt must stay false:\n${block}`);
});
