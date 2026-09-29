// Founding pricing is yearly only, and the server's switch cannot drift from the browser's.
//
// Two copies of one switch (see foundingPricing.ts for why there are two): FOUNDING_ANNUAL_ONLY
// in portal/03-catalog.jsx drives the Billing tab, and FOUNDING_ANNUAL_ONLY in foundingPricing.ts
// drives portal-billing's refusal. If they ever disagree, either the page offers a Monthly button
// the server refuses, or the page says "yearly only" while the server quietly sells monthly to
// anyone who asks. These cases read the SHIPPED browser source, the house technique for mirrored
// rules (qboLineKinds.test.ts, operatorMirror_test.ts), so a drift fails the push.
//
// The handler itself (order of the refusal against the vault and the gateway, the internal
// account's own 409, operators, cancel) is driven for real in
// _test_stubs/foundingAnnualOnly_test.ts.
//
// Dependency-free like the other _shared tests. The file-reading cases need --allow-read on the
// repo (preflight passes it); without it they report ignored rather than failing.

import {
  FOUNDING_ANNUAL_ONLY, FOUNDING_ANNUAL_ONLY_CODE, FOUNDING_ANNUAL_ONLY_MESSAGE, FOUNDING_ANNUAL_ONLY_STATUS,
  monthlyPlansRefused,
} from "./foundingPricing.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const CATALOG = new URL("../../../portal/03-catalog.jsx", import.meta.url);
const BILLING_MIGRATION = new URL("../../migrations/050_billing.sql", import.meta.url);
const canRead = (u: URL) => Deno.permissions.querySync({ name: "read", path: u }).state === "granted";
const read = async (u: URL) => (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");
// Code only: a comment that quotes the old rule (to say it changed) must not satisfy or fail a pin.
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// Plan rows in the shape portal-billing resolves a cart to (billing_plans columns).
const plan = (feature: string, billing_interval: string) => ({ id: `${feature}_${billing_interval}`, feature, billing_interval });

Deno.test("while the switch is on, every monthly plan in a cart is refused and no annual one is", () => {
  const cart = [plan("simple_layout", "annual"), plan("crm", "monthly"), plan("view_3d", "annual"), plan("full_suite", "monthly")];
  const refused = monthlyPlansRefused(cart, true);
  assert(refused.length === 2, `expected the two monthly plans, got ${JSON.stringify(refused)}`);
  assert(refused.every((p) => p.billing_interval === "monthly"), "an annual plan was refused");
  assert(refused[0].id === "crm_monthly" && refused[1].id === "full_suite_monthly", "refused plans come back in cart order");
});

Deno.test("an all-annual cart is allowed", () => {
  const cart = [plan("simple_layout", "annual"), plan("schedule_builds", "annual")];
  assert(monthlyPlansRefused(cart, true).length === 0, "an annual cart was refused");
  assert(monthlyPlansRefused([], true).length === 0, "an empty cart was refused");
});

Deno.test("with the switch off, monthly is sold again (the plumbing Carolyn asked to keep)", () => {
  const cart = [plan("simple_layout", "monthly"), plan("crm", "monthly")];
  assert(monthlyPlansRefused(cart, false).length === 0, "monthly was refused with the switch off");
});

Deno.test("the default is the module's switch, and the switch is ON", () => {
  // Flipping it is a deliberate two-file change (see the pin below), not something to find out
  // about from a checkout. If you are reopening monthly, change this assertion with it.
  assert(FOUNDING_ANNUAL_ONLY === true, "FOUNDING_ANNUAL_ONLY is off; update this test in the same change");
  const cart = [plan("simple_layout", "monthly")];
  assert(monthlyPlansRefused(cart).length === 1, "the default did not follow FOUNDING_ANNUAL_ONLY");
});

Deno.test("keyed on billing_interval, never on the id's spelling", () => {
  // A row whose id says _monthly but which bills yearly is annual; the interval is what the
  // gateway is registered with (month_frequency 12), and the browser keys on it too.
  const oddlyNamed = { id: "legacy_monthly", feature: "legacy", billing_interval: "annual" };
  assert(monthlyPlansRefused([oddlyNamed], true).length === 0, "an annual plan was refused for its id");
  const missing = { id: "x_monthly", feature: "x", billing_interval: null };
  assert(monthlyPlansRefused([missing], true).length === 0, "a row with no interval matched 'monthly'");
});

Deno.test("the refusal is a 4xx with a stable code and a plain sentence", () => {
  assert(FOUNDING_ANNUAL_ONLY_STATUS >= 400 && FOUNDING_ANNUAL_ONLY_STATUS < 500, "a refusal must be a 4xx (the severity split files 4xx as info)");
  // 401 and 403 get a suffix appended by the portal's invoke wrapper ("— sign out and back in.",
  // "— ask an owner or admin to do this."), which would be wrong advice here.
  assert(FOUNDING_ANNUAL_ONLY_STATUS !== 401 && FOUNDING_ANNUAL_ONLY_STATUS !== 403, "401/403 would get the wrapper's sign-in/ask-an-owner suffix");
  assert(FOUNDING_ANNUAL_ONLY_CODE === "founding_annual_only", "the code is part of the API — do not rename it casually");
  assert(/^[A-Z].*\.$/.test(FOUNDING_ANNUAL_ONLY_MESSAGE), "the sentence starts with a capital and ends with a full stop");
  assert(!/monthly_|_annual|billing_interval|plan id|409/i.test(FOUNDING_ANNUAL_ONLY_MESSAGE), "no internals in the sentence the builder reads");
  assert(FOUNDING_ANNUAL_ONLY_MESSAGE.includes("Yearly"), "the sentence names the button the builder has to press");
});

Deno.test({
  name: "drift pin: FOUNDING_ANNUAL_ONLY in portal/03-catalog.jsx equals the server's switch",
  ignore: !canRead(CATALOG),
  fn: async () => {
    const src = codeOnly(await read(CATALOG));
    const decls = [...src.matchAll(/^\s*const\s+FOUNDING_ANNUAL_ONLY\s*=\s*([^;\n]+);/gm)];
    assert(decls.length === 1, `expected exactly one FOUNDING_ANNUAL_ONLY declaration in 03-catalog.jsx, found ${decls.length}`);
    const raw = decls[0][1].trim();
    assert(raw === "true" || raw === "false",
      `the browser switch must stay a literal true/false so this pin can read it (got ${JSON.stringify(raw)})`);
    const browser = raw === "true";
    assert(browser === FOUNDING_ANNUAL_ONLY,
      `DRIFT: the Billing tab has FOUNDING_ANNUAL_ONLY = ${browser} but _shared/foundingPricing.ts has ${FOUNDING_ANNUAL_ONLY}. ` +
        "Change both together: the browser constant drives the page, this one drives portal-billing's refusal.");
  },
});

Deno.test({
  name: "drift pin: the browser's rule is the server's rule (refuse monthly while the switch is on)",
  ignore: !canRead(CATALOG),
  fn: async () => {
    const src = codeOnly(await read(CATALOG));
    // setInterval_ is the only way a tile's cart entry ever becomes monthly.
    const at = src.indexOf("const setInterval_ = (f, iv) => {");
    assert(at >= 0, "03-catalog.jsx no longer declares setInterval_ — re-point this pin rather than deleting it");
    const body = src.slice(at, src.indexOf("\n  };", at));
    assert(body.includes('if (FOUNDING_ANNUAL_ONLY && iv === "monthly") return;'),
      "setInterval_ no longer refuses exactly `monthly` while FOUNDING_ANNUAL_ONLY — monthlyPlansRefused must change with it");
    // Every default that seeds the cart writes "annual", so nothing else can put monthly in it.
    const seeds = [...src.matchAll(/(?:simple_layout|\[f\.feature\]|n\.simple_layout|n\[f\.feature\])\s*[:=]\s*"(monthly|annual)"/g)].map((m) => m[1]);
    assert(seeds.length >= 3 && seeds.every((s) => s === "annual"), `a cart default writes something other than "annual": ${JSON.stringify(seeds)}`);
  },
});

Deno.test({
  name: "the interval vocabulary is the table's: 'monthly' and 'annual' are the only billing_interval values",
  ignore: !canRead(BILLING_MIGRATION),
  fn: async () => {
    const sql = await read(BILLING_MIGRATION);
    const m = sql.match(/billing_interval\s+text\s+not\s+null\s+check\s*\(\s*billing_interval\s+in\s*\(([^)]*)\)\s*\)/i);
    assert(m, "050_billing.sql no longer carries the billing_interval CHECK this test reads");
    const values = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert(JSON.stringify(values) === JSON.stringify(["annual", "monthly"]),
      `billing_interval allows ${JSON.stringify(values)}; monthlyPlansRefused only knows "monthly" as the non-annual value`);
  },
});
