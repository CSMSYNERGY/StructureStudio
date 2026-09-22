// The sales-location and location-rate wiring in portal-settings, pinned against the SHIPPED
// handler (2026-09-17).
//
// locationTax.test.ts proves the decisions. What it cannot see is where portal-settings calls
// them, and every mistake worth pinning here is one short edit that throws nothing and passes
// every unit test:
//   1. a re-stamp that writes before it has refused — an accepted quote, or an emailed one whose
//      total moves without confirmResend, changed anyway;
//   2. a re-send placed before the write, emailing the customer the OLD total;
//   3. the row scope moved below the first read, so an own-contacts rep learns a design exists;
//   4. `allowLookup: true` on a path a rep can press as often as they like;
//   5. the location rates leaking onto list_locations' inventory:view-only branch;
//   6. a helper `const` used above its declaration — a ReferenceError at request time (the
//      dispatch is one long function, so the order of the branches IS the order of execution),
//      which deno check does not report.
// Same technique as taxChainWiring_test: read the source, so a drift fails the push. If an
// anchor moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const SETTINGS = await Deno.readTextFile(new URL("../../portal-settings/index.ts", import.meta.url));

/** Source with whole-line `//` comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF, and the
 *  block anchors below span a newline. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const SRC = code(SETTINGS);

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`locationTaxWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const at = (src: string, needle: string, label: string): number => {
  const i = src.indexOf(needle);
  assert(i >= 0, `locationTaxWiring_test: "${needle}" not found in ${label} — re-point this test`);
  return i;
};

const RESTAMP = block(SRC, "const restampQuoteTax = async", "\n  };\n", "restampQuoteTax");
const SET_LOCATION = block(SRC, 'if (action === "set_design_sales_location") {', "\n  if (action ===", "set_design_sales_location");
const LIST = block(SRC, 'if (action === "list_locations") {', "\n  if (action ===", "list_locations");

Deno.test("restampQuoteTax refuses everything before its one write, then regenerates, then re-sends", () => {
  const agreed = at(RESTAMP, "refuseIfAgreed(", "restampQuoteTax");
  const changed = at(RESTAMP, "JSON.stringify(fresh.estimate_lines", "restampQuoteTax");
  const sentRefusal = at(RESTAMP, '"quote_sent"', "restampQuoteTax");
  const write = at(RESTAMP, ".update(", "restampQuoteTax");
  const pdf = at(RESTAMP, "regenerateQuotePdf(", "restampQuoteTax");
  const resend = at(RESTAMP, "sendQuoteEmail(", "restampQuoteTax");
  assert(agreed < write && changed < write && sentRefusal < write, "a refusal sits below the write — a refused call would already have changed the quote");
  assert(write < pdf, "the PDF is regenerated before the snapshot it prints is written");
  assert(write < resend, "the re-send runs before the write — the customer would be emailed the old total");
  assert((RESTAMP.match(/\.update\(/g) ?? []).length === 1, "restampQuoteTax should write the design exactly once");
});

Deno.test("restampQuoteTax's write is checked: a compare-and-swap, never onto an accepted quote", () => {
  const write = RESTAMP.slice(at(RESTAMP, ".update(", "restampQuoteTax"));
  assert(/\.is\("accepted_at", null\)/.test(write), "the write no longer requires accepted_at to still be null");
  assert(/\.eq\("updated_at", fresh\.updated_at\)/.test(write), "the write is no longer a compare-and-swap on updated_at");
  assert(/estimate_lines: plan\.snap, total_cents: plan\.totalCents/.test(write), "estimate_lines and total_cents are no longer written together");
  assert(/\.\.\.\(opts\.alsoSet \?\? \{\}\), estimate_lines/.test(write), "alsoSet must be spread FIRST, so it can never overwrite the money columns");
});

Deno.test("refuseIfAgreed: a recorded quote acceptance is agreement, and an unreadable one is refused", () => {
  const refuse = block(SRC, "const refuseIfAgreed = async", "const restampQuoteTax = async", "refuseIfAgreed");
  const acc = at(refuse, 'from("design_acceptances")', "refuseIfAgreed");
  const read = refuse.slice(acc, at(refuse, "if (accErr)", "refuseIfAgreed"));
  assert(/\.eq\("subject", "quote"\)/.test(read), "the acceptance read is no longer narrowed to the quote subject");
  assert(/if \(accErr\) return dbFail\(/.test(refuse), "an unreadable acceptance table no longer fails closed");
  assert(/\(acc \?\? \[\]\)\.length\) return agreedRefusal\(\)/.test(refuse), "a recorded acceptance no longer refuses the re-price");
  assert(acc < at(refuse, 'from("orders")', "refuseIfAgreed"), "the acceptance check moved below the order read");
});

Deno.test("set_design_sales_location: row scope first, agreement refused, free rates only", () => {
  const scope = at(SET_LOCATION, "refuseUnlessDesignVisible(shortCode)", "set_design_sales_location");
  const firstRead = at(SET_LOCATION, "admin.from(", "set_design_sales_location");
  assert(scope < firstRead, "the row scope runs after a read — a refusal would no longer be free of timing");
  assert(SET_LOCATION.includes("refuseIfAgreed(d)"), "set_design_sales_location no longer refuses an accepted/ordered quote up front");
  assert(SET_LOCATION.includes("restampQuoteTax("), "set_design_sales_location re-prices without the shared helper");
  const calls = SET_LOCATION.match(/resolveRate\([\s\S]*?\)\s*;/g) ?? [];
  for (const c of calls) assert(/allowLookup:\s*false/.test(c), `a sales-location resolveRate without allowLookup false: ${c}`);
  assert(!/allowLookup:\s*true/.test(SET_LOCATION + RESTAMP), "a pressable path passes allowLookup true");
  assert(/homeLot:\s*null/.test(SET_LOCATION), "clearing a location must not borrow the rep's home lot");
});

Deno.test("list_locations: the tax fields exist only behind canRead(settings_crm)", () => {
  const gate = at(LIST, 'canRead("settings_crm")', "list_locations");
  for (const needle of ["tax_rate", "taxRatePct", "taxLabel", "taxReady"]) {
    const i = LIST.indexOf(needle);
    assert(i < 0 || i > gate, `list_locations exposes ${needle} before the settings_crm check`);
  }
  const firstSelect = LIST.slice(0, gate);
  assert(!/tax_/.test(firstSelect), "the base lot read (the inventory:view branch) selects a tax column");
});

Deno.test("the shared helpers are declared above every use (no TDZ at request time)", () => {
  for (const name of ["sendQuoteEmail", "refuseIfAgreed", "restampQuoteTax"]) {
    const decl = at(SRC, `const ${name} = async`, "portal-settings");
    const uses = [...SRC.matchAll(new RegExp(`\\b${name}\\(`, "g"))].map((m) => m.index!);
    assert(uses.length >= 1, `${name} is declared but never used — re-point this test`);
    for (const u of uses) assert(u > decl, `${name} is called above its declaration`);
  }
  assert(block(SRC, 'if (action === "resend_quote_email") {', "\n  }\n", "resend_quote_email").includes("sendQuoteEmail("),
    "resend_quote_email no longer uses the shared send — the re-stamp's re-send and the button would drift");
  assert((SRC.match(/estimateEmail\(/g) ?? []).length === 1, "a second quote-email builder appeared in portal-settings");
});
