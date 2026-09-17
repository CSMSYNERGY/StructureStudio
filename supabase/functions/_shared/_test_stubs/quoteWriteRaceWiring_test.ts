// The two writers of an issued quote, pinned against the SHIPPED handlers (review, 2026-09-17).
//
// quoteWriteRace.test.ts proves the decisions and checks the ordering rule against every
// interleaving of two writers. What it cannot see is whether the handlers follow that order, and
// every way of breaking it is a short edit that throws nothing and passes every unit test:
//   1. submit-estimate uploading the quote PDF, or emailing, before its persist: the document can
//      print a total the row does not hold, and a race refusal would come after the customer
//      already has the email;
//   2. the persist losing its compare-and-swap, or its race refusal moving below the upload or
//      the email: a verified rate overwritten again, or a refusal after the fact;
//   3. ss_quote_sent_at back inside the money write, which runs before the email now: the quote
//      would read as emailed whether or not the email landed;
//   4. either writer dropping the re-read after its upload, or re-sending beside it: a stale
//      document outlives a later writer's lines;
//   5. the email naming a total other than the one the document prints.
// Same technique as taxSpendWiring_test: read the source, so a drift fails the push. If an anchor
// moves, re-point it — do not delete the test.

import { assert } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES a trap cannot trip it.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const SUBMIT = code(await Deno.readTextFile(new URL("submit-estimate/index.ts", FUNCTIONS)));
const SETTINGS = code(await Deno.readTextFile(new URL("portal-settings/index.ts", FUNCTIONS)));

function block(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`quoteWriteRaceWiring_test: could not find the ${label} block (start=${i}, end=${j}). Re-point the anchors.`);
  }
  return src.slice(i, j);
}

const at = (src: string, needle: string, label: string, from = 0): number => {
  const i = src.indexOf(needle, from);
  assert(i >= 0, `quoteWriteRaceWiring_test: "${needle}" not found in ${label} — re-point this test`);
  return i;
};

/** 9-ALT: the StructureStudio paperwork branch of submit-estimate, up to its success response. */
const SS = block(SUBMIT, "let ssQuoteNumber: string | null = existingDesign.ss_quote_number || null;",
  '\n      issuedBy: "structurestudio",\n', "submit-estimate 9-ALT");
const RESTAMP = block(SETTINGS, "const restampQuoteTax = async", "\n  };\n", "restampQuoteTax");

Deno.test("submit-estimate: the design read carries the persist's compare-and-swap token", () => {
  const read = block(SUBMIT, "const { data: existingDesign, error: designErr } = await supabase", ".single();", "the step 2 read");
  assert(/\.select\("[^"]*[ "]updated_at(?=[,"])[^"]*"\)/.test(read), "step 2 no longer selects updated_at — the persist has nothing to swap against");
});

Deno.test("submit-estimate: persist, then the document, then the email, then the sent stamp", () => {
  const persist = at(SS, "let write = supabase", "9-ALT persist");
  const refusal = at(SS, "return json(SUBMIT_RACE_REFUSAL[miss.kind], 409);", "9-ALT");
  const pdf = at(SS, "let quotePdfUrl = await writeQuotePdf(estimateLines);", "9-ALT");
  const check = at(SS, "quotePdfStale(printed, after.estimate_lines)", "9-ALT");
  const email = at(SS, "await sendTenantEmail(", "9-ALT");
  const stamp = at(SS, "ss_quote_sent_at: new Date().toISOString()", "9-ALT");
  assert(persist < refusal && refusal < pdf, "the race refusal no longer sits between the persist and the upload");
  assert(pdf < check && check < email, "the document check no longer follows the upload and precedes the email");
  assert(email < stamp, "ss_quote_sent_at is stamped before the email it records");

  // The document is built only through writeQuotePdf, and never called above the persist.
  const firstCall = SS.search(/writeQuotePdf\((?!snap)/);
  assert(firstCall > persist, "writeQuotePdf is called above the persist — the document would print lines the row may not hold");
  assert((SS.match(/\.upload\(/g) ?? []).length === 1, "9-ALT uploads something other than through writeQuotePdf");
  assert(at(SS, ".upload(", "9-ALT") < at(SS, "const writeQuotePdf = async", "9-ALT") + 3000, "the one upload is no longer inside writeQuotePdf");
});

Deno.test("submit-estimate: the persist is a compare-and-swap for an unagreed quote, and carries no send stamp", () => {
  assert(/const guardPersist = !isAgreedDesign\(existingDesign\);/.test(SS), "the guard no longer keys on agreement");
  const loop = SS.slice(at(SS, "const PERSIST_ATTEMPTS", "9-ALT"), at(SS, "if (persistErr) {", "9-ALT"));
  assert(/if \(guardPersist\) write = casUpdatedAt \? write\.eq\("updated_at", casUpdatedAt\) : write\.is\("updated_at", null\);/.test(loop),
    "the persist is no longer a compare-and-swap on updated_at");
  assert(/submitPersistMiss\(\{ readTax: storedTax, stampedTax: \(estimateLines as Record<string, unknown>\)\.tax, now \}\)/.test(loop),
    "the miss is no longer decided from the tax the submit read and the one it stamped");
  assert(/\.select\("estimate_lines, accepted_at, status, updated_at"\)/.test(loop), "the miss re-read lost a column submitPersistMiss decides on");
  const money = loop.slice(at(loop, ".update({", "the persist"), at(loop, '.eq("short_code", designId);', "the persist"));
  assert(!/ss_quote_sent_at|ss_quote_pdf_url/.test(money), "the money write stamps the email or the document, which have not happened yet");
});

Deno.test("submit-estimate: the quote email names the total the document prints", () => {
  const estimate = SS.slice(at(SS, ": estimateEmail({", "9-ALT"));
  assert(/total: printedTotal,/.test(estimate.slice(0, 900)), "the quote email's total is not the printed total");
  assert(/printedTotal = totalFromSnapshot\(after\.estimate_lines\) \?\? printedTotal;/.test(SS), "a rebuilt document no longer moves the emailed total with it");
});

Deno.test("restampQuoteTax: the re-read follows the regenerate, and a moved quote is not re-sent", () => {
  const write = at(RESTAMP, ".update(", "restampQuoteTax");
  assert(/\.select\("short_code, estimate_lines"\)/.test(RESTAMP.slice(write, write + 600)), "the write no longer reads back the stored lines");
  const pdf = at(RESTAMP, "regenerateQuotePdf(", "restampQuoteTax");
  const check = at(RESTAMP, "quotePdfStale(printed, after.estimate_lines)", "restampQuoteTax");
  const gate = at(RESTAMP, "restampResend({", "restampQuoteTax");
  const resend = at(RESTAMP, "sendQuoteEmail(", "restampQuoteTax");
  assert(write < pdf && pdf < check && check < gate && gate < resend, "write, regenerate, re-read, gate and re-send are out of order");
  assert(/movedOn \}\)/.test(RESTAMP.slice(gate, gate + 200)), "the re-send gate no longer hears that the quote moved on");
  assert(/let printed: unknown = wrote\[0\]\.estimate_lines;/.test(RESTAMP), "the re-read no longer compares against the lines the database stored");
});
