// submit-estimate's half of the formal estimate form, pinned against the SHIPPED handler
// (2026-10-05). quoteDocsWiring_test drives portal-settings' re-prints. Nothing covered the path
// every NEW quote takes, and each way of breaking it is one short edit that throws nothing and
// passes every other test:
//   1. step 8's CRM estimate expiry back at a fixed 30 days, or taken from anything but the
//      tenant's setting: the CRM estimate would disagree with the "Valid until" on the PDF;
//   2. the StructureStudio quote (writeQuotePdf) dropping its validity, its customer or its logo;
//   3. the CRM-mode formal estimate dropping the same three, or printing an issue date or validity
//      other than the CRM estimate's it is attached to;
//   4. a customer block built without the design's code, which is what keeps a legacy
//      six-character code's PDF free of the customer (migration 156's rule, shareCode.ts).
// Step 8's date arithmetic is also LIFTED from the source and run, so "the CRM expiry is the issue
// date plus the tenant's days, and the PDF's Valid until is the same date" is checked as a fact,
// not as a string. Same technique as quoteWriteRaceWiring_test / taxChainWiring_test: read the
// source, so a drift fails the push. If an anchor moves, re-point it; do not delete the test.
//
// The customer is made up (the repo is public).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildFormalEstimatePdf, pdfCustomerFrom } from "../estimatePdf.ts";
import { pdfText } from "./pdfText.ts";

/** Source with whole-line comments removed, so a comment that NAMES a call cannot satisfy a pin.
 *  Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const SUBMIT = code(await Deno.readTextFile(new URL("../../submit-estimate/index.ts", import.meta.url)));

function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  assert(i >= 0 && j > i, `${label}: anchor moved (${JSON.stringify(start)} .. ${JSON.stringify(end)})`);
  return src.slice(i, j + end.length);
}
/** The argument object of the first `callee({` at or after `from`, up to its closing `});`. */
function callArgs(src: string, from: string, callee: string, label: string): string {
  const at = src.indexOf(from);
  assert(at >= 0, `${label}: anchor ${JSON.stringify(from)} moved`);
  return between(src.slice(at), `${callee}({`, "});", label);
}

// ─── 1. step 8: one number behind the CRM expiry ─────────────────────────────────────────────
const STEP8 = between(SUBMIT, "const fmt = (d: Date) =>", "const expiryFormatted = fmt(exp);", "step 8");

Deno.test("step 8 reads the tenant's days and nothing else sets the CRM estimate's expiry", () => {
  assert(STEP8.includes("const { days: quoteValidDays } = await readQuoteValidDays(supabase, clientId);"), "the setting is read in step 8");
  assert(/const exp = new Date\(issueAnchor\.getTime\(\) \+ quoteValidDays \* 24 \* 60 \* 60 \* 1000\);/.test(STEP8), "exp is the issue anchor + the tenant's days");
  assert(!/\b30 \* 24 \* 60 \* 60 \* 1000\b/.test(SUBMIT), "a fixed 30-day expiry is back somewhere in the handler");
  assertEquals((SUBMIT.match(/expiryDate:/g) ?? []).length, 1, "one expiryDate in the CRM payload");
  assert(SUBMIT.includes("expiryDate: expiryFormatted,"), "the CRM payload's expiry is step 8's");
});

// Step 8, run: the source block with its one TypeScript annotation removed, a fixed clock and the
// tenant's setting handed in.
// deno-lint-ignore no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
async function runStep8(days: number, nowMs: number): Promise<{ today: string; expiryFormatted: string; quoteValidDays: number }> {
  const js = STEP8.replace("(d: Date) =>", "(d) =>");
  assert(!/:\s*(Date|number|string)\b/.test(js.replace(/`[^`]*`/g, "")), "step 8 grew another annotation; strip it here too");
  // Step 8 only ever calls new Date(<ms>) and Date.now(), so only the clock is fixed.
  class FixedDate extends Date {
    static override now() { return nowMs; }
  }
  const read = (_db: unknown, _client: string) => Promise.resolve({ days, ok: true });
  const fn = new AsyncFunction("readQuoteValidDays", "supabase", "clientId", "Date", `${js}\nreturn { today, expiryFormatted, quoteValidDays };`);
  return await fn(read, {}, "acme-sheds", FixedDate);
}

const ymdPlus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const label = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };

Deno.test("run: the CRM expiry is the issue date plus the tenant's days, for any setting and any hour", async () => {
  for (const days of [1, 14, 30, 90, 365]) {
    for (const now of [Date.UTC(2026, 9, 5, 0, 30), Date.UTC(2026, 9, 5, 18, 0), Date.UTC(2026, 11, 31, 23, 59), Date.UTC(2027, 1, 28, 6, 0)]) {
      const r = await runStep8(days, now);
      assertEquals(r.quoteValidDays, days);
      assertEquals(r.expiryFormatted, ymdPlus(r.today, days), `${days} days from ${new Date(now).toISOString()}`);
    }
  }
});

Deno.test("run: the PDF's Valid until is the same date as the CRM expiry", async () => {
  const r = await runStep8(14, Date.UTC(2026, 9, 5, 18, 0));
  // The same three arguments both builders are handed below: dateIso today, validityDays, customer.
  const text = await pdfText(await buildFormalEstimatePdf({
    business: { name: "Acme Sheds" }, estimateNumber: "SST-1001", dateIso: r.today, validityDays: r.quoteValidDays,
    customer: pdfCustomerFrom({ name: "Pat Example", email: "pat@example.test" }, "SS-ABCD2345EF"),
    lines: [{ kind: "building", name: "12x24 Lofted Barn", qty: 1, amount: 8950 }],
  }));
  assert(text.includes(`Valid until: ${label(r.expiryFormatted)}`), `Valid until ${label(r.expiryFormatted)}; drew ${/Valid until: [^)]*/.exec(text)?.[0]}`);
  assert(text.includes("Prepared for") && text.includes("Pat Example"));
});

// ─── 2. the StructureStudio quote ────────────────────────────────────────────────────────────
Deno.test("the StructureStudio quote prints the tenant's validity, the customer and the logo", () => {
  const args = callArgs(SUBMIT, "const writeQuotePdf = async", "buildQuotePdf", "writeQuotePdf");
  for (const pin of ["dateIso: today,", "validityDays: quoteValidDays,", "customer: pdfCustomer,", "logoSources,"]) {
    assert(args.includes(pin), `writeQuotePdf's buildQuotePdf no longer passes ${pin}`);
  }
  assert(SUBMIT.includes("const pdfCustomer = pdfCustomerFrom(contact, designId);"), "the customer is built from the contact and the design's own code");
  assert(SUBMIT.includes("const logoSources = pdfLogoSources(businessLogoUrl, supabaseUrl, clientId);"), "the logo sources are this tenant's");
});

// ─── 3. the CRM-mode formal estimate ─────────────────────────────────────────────────────────
Deno.test("the CRM-mode formal estimate prints the CRM estimate's date and validity, the customer and the logo", () => {
  const args = callArgs(SUBMIT, "let formalPdfUrl: string | null = null;", "buildFormalEstimatePdf", "formal estimate");
  for (const pin of ["logo,", "dateIso: today,", "validityDays: quoteValidDays,", "customer: pdfCustomerFrom(contact, designId),", "onLogoSkipped: logoNote,"]) {
    assert(args.includes(pin), `the formal estimate no longer passes ${pin}`);
  }
  const before = between(SUBMIT, "let formalPdfUrl: string | null = null;", "buildFormalEstimatePdf({", "formal estimate");
  assert(before.includes("const logo = await fetchPdfLogo(pdfLogoSources(businessLogoUrl, supabaseUrl, clientId), logoNote);"), "the logo is fetched from this tenant's sources");
});

// ─── 4. never a customer without the code ────────────────────────────────────────────────────
Deno.test("every customer block in the handler is built with the design's code", () => {
  const calls = [...SUBMIT.matchAll(/pdfCustomerFrom\(([^)]*)\)/g)].map((m) => m[1]);
  assert(calls.length >= 2, `expected the quote and the formal estimate, found ${calls.length}`);
  for (const a of calls) assertEquals(a.split(",").map((s) => s.trim())[1], "designId", `pdfCustomerFrom(${a})`);
});
