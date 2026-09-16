// The paid-lookup wiring, pinned against the SHIPPED handlers (2026-09-17): portal-settings'
// verify_tax and send_invoice, admin-catalog's avalara_ping, customer-accept's accept race.
//
// taxSpend.test.ts proves the decisions; taxLookups.test.ts proves the ledger and the ping
// redaction. What they cannot see is where the handlers call them, and every mistake worth
// pinning here is a short edit that throws nothing and passes every unit test:
//   1. `allowLookup: true` appearing anywhere but paidLookup — a second spender with no cap;
//   2. a verify_tax refusal moved below the lookup — a press on a draft, an accepted quote or an
//      unconfirmed operator view costs a billed call before it is refused;
//   3. the charge moved ahead of the quote write, or out of restampQuoteTax's afterWrite —
//      a builder billed for a rate that never reached a document;
//   4. the invoice-time check writing a total, or the old answer-keyed tax_invoice charge back;
//   5. the switch read folded into send_invoice's settings select, where an unapplied 242 would
//      null the row and send an SS tenant down the CRM path;
//   6. avalara_ping added to the read-only list, or answering with the raw ping;
//   7. the accept-race check placed after the acceptance is recorded;
//   8. the accept promote losing its compare-and-swap, or a re-price caught there refused AFTER the
//      order, the signature image or the emails — the old lines frozen beside the new quote, or a
//      withdrawn acceptance that something already refers to.
// Same technique as locationTaxWiring_test: read the source, so a drift fails the push. If an
// anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, FUNCTIONS));

/** Source with whole-line `//` comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const SETTINGS = code(await read("portal-settings/index.ts"));
const CATALOG = code(await read("admin-catalog/index.ts"));
const ACCEPT = code(await read("customer-accept/index.ts"));

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`taxSpendWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const at = (src: string, needle: string, label: string, from = 0): number => {
  const i = src.indexOf(needle, from);
  assert(i >= 0, `taxSpendWiring_test: "${needle}" not found in ${label} — re-point this test`);
  return i;
};

/** Every non-test .ts under supabase/functions, as [relative path, comment-stripped source]. */
async function functionSources(): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const walk = async (dir: URL, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name === "_test_stubs" || e.name === "node_modules") continue;
        await walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`);
      } else if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith("_test.ts")) {
        out.push([`${rel}${e.name}`, code(await Deno.readTextFile(new URL(e.name, dir)))]);
      }
    }
  };
  await walk(FUNCTIONS, "");
  return out;
}

const VERIFY = block(SETTINGS, 'if (action === "verify_tax") {', "\n  if (action ===", "verify_tax");
const RESTAMP = block(SETTINGS, "const restampQuoteTax = async", "\n  };\n", "restampQuoteTax");
const SS_INVOICE = block(SETTINGS, 'if (action === "send_invoice" || action === "push_to_invoice") {',
  '.select("short_code, ghl_estimate_id, inventory_unit_id")', "send_invoice SS branch");

Deno.test("allowLookup: true exists exactly once in the functions tree — inside taxSpend's paidLookup", async () => {
  const hits: string[] = [];
  for (const [path, src] of await functionSources()) {
    for (const _ of src.matchAll(/allowLookup:\s*true/g)) hits.push(path);
  }
  assert(hits.length === 1 && hits[0] === "_shared/taxSpend.ts", `allowLookup: true found in: ${hits.join(", ") || "nowhere"}`);
  const spend = (await functionSources()).find(([p]) => p === "_shared/taxSpend.ts")![1];
  const fn = block(spend, "export async function paidLookup(", "\n}\n", "paidLookup");
  assert(/allowLookup:\s*true/.test(fn), "the opt-in moved out of paidLookup");
  const cap = at(fn, "countLookups24h(", "paidLookup");
  const row = at(fn, "insertLookup(", "paidLookup");
  const call = at(fn, "resolveRate(", "paidLookup");
  assert(cap < row && row < call, "paidLookup must count, then write the row, then make the request");
});

Deno.test("paidLookup is called from verify_tax and send_invoice only", async () => {
  const callers: string[] = [];
  for (const [path, src] of await functionSources()) {
    const n = [...src.matchAll(/\bpaidLookup\(/g)].length;
    if (path !== "_shared/taxSpend.ts" && n) callers.push(`${path}×${n}`);
  }
  assert(callers.length === 1 && callers[0] === "portal-settings/index.ts×2", `paidLookup callers: ${callers.join(", ")}`);
  assert(VERIFY.includes("paidLookup("), "verify_tax no longer calls paidLookup");
  assert(SS_INVOICE.includes("paidLookup("), "send_invoice's SS branch no longer calls paidLookup");
});

Deno.test("verify_tax: every refusal before the lookup, in the spec's order", () => {
  const order: [string, string][] = [
    ["refuseUnlessDesignVisible(shortCode)", "row scope"],
    ["lookupSwitchRefusal(", "tenant switch"],
    ["refuseIfAgreed(d)", "accepted / ordered"],
    ["verifyQuoteRefusal(", "no quote / no address / operator confirmation"],
    ['auditStrict("operator_verify_tax_attempt"', "operator strict audit"],
    ["quoteSentRefusal(", "emailed quote confirmation"],
    ["rateBucket(", "rate bucket"],
    ["paidLookup(", "the lookup"],
    ["verifyLookupRefusal(", "failure refusal"],
    ["restampQuoteTax(", "the write"],
  ];
  let last = -1;
  for (const [needle, label] of order) {
    const i = at(VERIFY, needle, "verify_tax");
    assert(i > last, `verify_tax: "${label}" is out of order`);
    last = i;
  }
  assert(at(VERIFY, "refuseUnlessDesignVisible(", "verify_tax") < at(VERIFY, "admin.from(", "verify_tax"),
    "the row scope runs after a read");
  assert(/if \(operator\) \{\s*try \{\s*await auditStrict\(/.test(VERIFY), "the strict audit is no longer operator-gated and awaited");
});

Deno.test("verify_tax: the quote is written only through restampQuoteTax, and the charge follows the write", () => {
  assert(!/\.(update|upsert|insert)\(/.test(VERIFY), "verify_tax writes a table itself — the quote write belongs to restampQuoteTax");
  const failure = at(VERIFY, "if (!lookup.ok) {", "verify_tax");
  const failReturn = at(VERIFY, "return json(r.body, r.status);", "verify_tax", failure);
  assert(failReturn < at(VERIFY, "restampQuoteTax(", "verify_tax"), "a failed lookup reaches the write — the stored quote would change");
  const charges = [...VERIFY.matchAll(/chargeLookup\(/g)].map((m) => m.index!);
  assert(charges.length === 1, `verify_tax should charge in exactly one place, found ${charges.length}`);
  const afterWrite = at(VERIFY, "afterWrite: async () => {", "verify_tax");
  assert(charges[0] > afterWrite, "the charge is not inside restampQuoteTax's afterWrite");
  assert(/chargeLookup\(admin, lookup, \{[\s\S]*?kind: "tax_lookup"/.test(VERIFY), "verify_tax charges the wrong meter");
  assert(!/chargeTaxCalculation\(/.test(VERIFY), "verify_tax charges around chargeLookup — no ledger key");

  const write = at(RESTAMP, ".update(", "restampQuoteTax");
  const hook = at(RESTAMP, "opts.afterWrite()", "restampQuoteTax");
  const checked = at(RESTAMP, "changedUnderneath()", "restampQuoteTax", write);
  const pdf = at(RESTAMP, "regenerateQuotePdf(", "restampQuoteTax");
  assert(write < checked && checked < hook, "afterWrite runs before the write is checked");
  assert(hook < pdf, "afterWrite runs after the PDF — a slow render would stand between the write and the charge");
});

Deno.test("send_invoice: the tax check reports and charges; it writes no total and blocks nothing", () => {
  assert(!/taxInvoiceIdem\(/.test(SETTINGS), "the answer-keyed tax_invoice charge (no call behind it) is back");
  const start = at(SS_INVOICE, "let taxCheck: InvoiceTaxCheck", "send_invoice");
  const ret = at(SS_INVOICE, "return json({ ok: true, invoiceNumber: invNumber", "send_invoice", start);
  const check = SS_INVOICE.slice(start, ret);
  assert(!/\.(update|upsert|insert)\(|\breturn\b/.test(check), "the invoice-time check writes a table or returns early");
  assert(!/total/i.test(check.replace(/totalNum|emailTotal/g, "")), "the invoice-time check mentions a total");
  const lookup = at(check, "paidLookup(", "the invoice check");
  const charge = at(check, "chargeLookup(admin, lookup,", "the invoice check");
  assert(lookup < charge, "the invoice charge precedes its lookup");
  assert(/kind: "tax_invoice"/.test(check.slice(charge)), "the invoice check charges the wrong meter");
  assert(/reissue: !!recoveredNumber/.test(check), "a re-send of an issued invoice would pay for another lookup");

  // Last, after everything the invoice itself needs.
  for (const [needle, label] of [
    ['setClaim(sent', "the email outcome"], ["pushQboInvoice(", "the books push"], ['.is("total_cents", null)', "the order total"],
  ] as const) {
    assert(at(SS_INVOICE, needle, "send_invoice") < start, `the tax check runs before ${label}`);
  }
  assert(/taxCheck \}\);\s*$/m.test(SS_INVOICE.slice(ret, ret + 400)), "the final SS response no longer carries taxCheck");

  // The switch read stays out of cur0's select (see header item 5).
  const cur0 = SS_INVOICE.slice(at(SS_INVOICE, "const { data: cur0 }", "send_invoice"), at(SS_INVOICE, ".eq(\"client_id\", clientId).maybeSingle();", "send_invoice"));
  assert(!/tax_lookup_enabled/.test(cur0), "tax_lookup_enabled was folded into cur0's select");
  assert(/select\("tax_lookup_enabled"\)/.test(check), "the invoice check no longer reads the switch on its own");
});

Deno.test("GATES: verify_tax spends, so it sits on settings_crm:edit — never designs", () => {
  assert(/\n\s*verify_tax:\s*\{\s*area:\s*"settings_crm",\s*level:\s*"edit"\s*\}/.test(SETTINGS), "verify_tax's gate changed");
});

Deno.test("admin-catalog avalara_ping: never read-only, row first, whitelisted answer", () => {
  const readOnly = block(CATALOG, "const READ_ONLY_ACTIONS = new Set([", "]);", "READ_ONLY_ACTIONS");
  assert(!readOnly.includes("avalara_ping"), "avalara_ping is on the read-only list — a read-only operator could make a counted call");
  const ping = block(CATALOG, 'case "avalara_ping": {', "\n      case ", "avalara_ping");
  const row = at(ping, "insertLookup(sb,", "avalara_ping");
  const refused = at(ping, "if (!lookupId)", "avalara_ping");
  const call = at(ping, "pingAvalara()", "avalara_ping");
  const close = at(ping, "finishLookup(sb, lookupId, ping)", "avalara_ping");
  assert(row < refused && refused < call && call < close, "avalara_ping must write its row, refuse without one, then ping, then close");
  assert(/kind: "ping"/.test(ping) && /clientId: PING_CLIENT_ID/.test(ping), "the ping row's kind or client_id changed");
  const replies = [...ping.matchAll(/return json\(([^;]*)\);/g)].map((m) => m[1]);
  assert(replies.some((r) => r.startsWith("pingResponse(ping)")), "avalara_ping no longer answers through pingResponse");
  for (const r of replies) assert(!/\.\.\.ping\b|json\(ping\b|^ping\b/.test(r), `avalara_ping echoes the raw ping: ${r}`);
});

Deno.test("customer-accept: the accept race is refused before anything is recorded", () => {
  const acceptQuote = ACCEPT.slice(at(ACCEPT, "const quoteRef = typeof body?.quoteRef", "customer-accept"));
  const owns = at(acceptQuote, "ownsDesign(", "accept_quote");
  const already = at(acceptQuote, "if (design.accepted_at)", "accept_quote");
  const check = at(acceptQuote, "checkExpectedTotal(body?.expectedTotalCents, total)", "accept_quote");
  const insert = at(acceptQuote, 'from("design_acceptances").insert(', "accept_quote");
  assert(owns < check, "the total is revealed before ownership is checked");
  assert(already < check, "a re-tap on an accepted quote would be refused instead of reported done");
  assert(check < insert, "the acceptance is recorded before the total is checked");
});

Deno.test("customer-accept: the promote is a compare-and-swap, and a re-price caught there withdraws the acceptance first", () => {
  const acceptQuote = ACCEPT.slice(at(ACCEPT, "const quoteRef = typeof body?.quoteRef", "customer-accept"));
  const read = acceptQuote.slice(at(acceptQuote, '.from("designs")', "accept_quote"), at(acceptQuote, ".maybeSingle()", "accept_quote"));
  assert(/\.select\("[^"]*[ "]updated_at(?=[,"])[^"]*"\)/.test(read), "accept_quote's design read no longer selects updated_at — the promote has nothing to swap against");

  const insert = at(acceptQuote, 'from("design_acceptances").insert(', "accept_quote");
  const promote = at(acceptQuote, 'from("designs").update(patch)', "accept_quote");
  const swapEnd = at(acceptQuote, '.select("short_code")', "accept_quote", promote);
  const swap = acceptQuote.slice(promote, swapEnd);
  assert(/\.is\("accepted_at", null\)/.test(swap), "the promote no longer requires accepted_at to still be null");
  assert(/\.eq\("updated_at", casUpdatedAt\)/.test(swap), "the promote is no longer a compare-and-swap on updated_at");
  assert((acceptQuote.match(/from\("designs"\)\.update\(/g) ?? []).length === 1, "accept_quote writes the design somewhere other than the guarded promote");

  const miss = at(acceptQuote, "promoteMiss(design.estimate_lines", "accept_quote");
  const withdraw = at(acceptQuote, 'from("design_acceptances").delete()', "accept_quote");
  const refuse = at(acceptQuote, "return json(miss.body, miss.status)", "accept_quote");
  const orders = at(acceptQuote, 'from("orders")', "accept_quote");
  const image = at(acceptQuote, 'storage.from("signatures")', "accept_quote");
  const request = at(acceptQuote, "raiseInvoiceRequest(", "accept_quote");
  const email = at(acceptQuote, "sendTenantEmail(", "accept_quote");
  assert(insert < promote && promote < miss, "the promote no longer follows the record, or the miss is not read after it");
  assert(miss < withdraw && withdraw < refuse, "a re-price is refused without withdrawing the acceptance first");
  assert(refuse < orders, "the order is ensured or filled before a re-price can refuse — from the old lines");
  assert(refuse < image && refuse < request && refuse < email, "the image, the invoice request or an email precedes the re-price refusal");
  const withdrawal = acceptQuote.slice(withdraw, refuse);
  assert(/\.eq\("id", acceptanceId\)/.test(withdrawal), "the withdrawal is not keyed on this request's own acceptance row");
  assert((acceptQuote.match(/\.delete\(\)/g) ?? []).length === 1, "accept_quote deletes something other than its own withdrawn acceptance");
});
