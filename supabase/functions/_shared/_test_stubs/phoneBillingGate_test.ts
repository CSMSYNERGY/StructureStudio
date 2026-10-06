// admin-catalog's four phone & text billing actions must stay on the money grant (can_bill),
// the two reads included: phone_billing_get and phone_usage_report serve our cost of every call
// and text, i.e. the margin on every builder. The gate is a list somebody will extend, so this
// pins that every phone_* action the switch handles is on it, that none of them slipped onto
// READ_ONLY_ACTIONS (which would drop the can_write check too), and that the check runs before
// the switch. Same read-the-source technique as adminCatalogWarm_test.ts.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
/** Source with whole-line comments removed, so a comment that NAMES a call cannot satisfy it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (s: string) => s.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const SRC = code(await Deno.readTextFile(new URL("admin-catalog/index.ts", FUNCTIONS)));

const setOf = (name: string): string[] => {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(SRC);
  assert(m, `${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

Deno.test("every phone billing action the switch handles is on the can_bill gate", () => {
  const handled = [...SRC.matchAll(/case "((?:phone_billing|phone_usage)_[a-z_]+)":/g)].map((m) => m[1]);
  assert(handled.length >= 4, `expected the four phone billing cases, found ${handled.join(", ")}`);
  const gated = setOf("PHONE_BILLING_ACTIONS");
  for (const a of handled) assert(gated.includes(a), `${a} is handled but not on PHONE_BILLING_ACTIONS`);
});

Deno.test("no phone billing action is a read-only action", () => {
  const ro = setOf("READ_ONLY_ACTIONS");
  for (const a of setOf("PHONE_BILLING_ACTIONS")) assert(!ro.includes(a), `${a} is on READ_ONLY_ACTIONS`);
});

Deno.test("the can_bill check runs inside the operator gate, before the switch", () => {
  const check = SRC.indexOf("PHONE_BILLING_ACTIONS.has(String(action ?? \"\")) && !identity.canBill");
  const gate = SRC.indexOf('identity.via === "operator" && !READ_ONLY_ACTIONS.has(');
  const sw = SRC.indexOf("switch (action)");
  assert(check > gate && gate > 0, "the can_bill check moved out of the operator gate (or is gone)");
  assert(sw > check, "the switch now runs before the can_bill check");
});

Deno.test("arming everyone needs scope \"all\": an empty pilot list never widens charging", () => {
  const arm = SRC.slice(SRC.indexOf('case "phone_billing_arm":'));
  const refusal = arm.indexOf('p.armed && !pilots.length && p.scope !== "all"');
  const target = arm.indexOf('const target:');
  assert(refusal > 0, "the empty-pilot refusal is gone from phone_billing_arm");
  assert(target > refusal, "the refusal must run before the target is chosen");
  const card = code(Deno.readTextFileSync(new URL("../../portal/07-admin.jsx", FUNCTIONS)));
  assert(card.includes('{ armed: true, scope: "all" }'), "the operator card no longer asks for everyone by name");
});
