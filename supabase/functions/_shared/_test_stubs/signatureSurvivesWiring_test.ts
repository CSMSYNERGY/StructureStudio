// The countersignature must survive a rebuild, and a rebuild that loses it must be VISIBLE.
// Pinned against the shipped handlers (2026-09-19).
//
// WHAT WENT WRONG. Carolyn signed an invoice on her phone and the signature was not on the PDF.
// The certificate page exists (`_shared/acceptancePdf.ts`) and customer-accept does embed it —
// but `reissue_invoice` rebuilt the invoice and uploaded it over the SAME storage path while
// reading nothing from design_acceptances. So the first rebuild after a signature silently
// replaced the signed document with an unsigned one, and a change order is the ordinary
// trigger: the change-order ack path never rebuilds the document itself, and reissue_invoice is
// the remedy the stale-invoice refusal points at. The quote twin, regenerateQuotePdf, had
// re-appended since migration 124 — the invoice, the document customers actually sign, did not.
//
// WHY THIS IS A SOURCE TEST. Both regressions are one short edit that throws nothing and that no
// unit test of the PDF builders can see: dropping the re-append from a rebuild path, or putting
// a countersign failure back into console.warn. Supabase's runtime console stream is not
// reliably queryable on this project, so a swallowed failure leaves NO app_errors row at all and
// nobody can say which cause is real — which is what made the original report undiagnosable.
// Same technique as documentUploadWiring_test: read the source, so a drift fails the push. If an
// anchor moves, RE-POINT IT — do not delete the test.

import { assert, assertEquals } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../../", import.meta.url);

/** Source with whole-line comments removed, so a comment that NAMES a trap cannot satisfy or trip
 *  a check. Line endings are normalised first: a Windows checkout (core.autocrlf) reads CRLF. */
const code = (src: string) =>
  src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

const read = async (fn: string) => code(await Deno.readTextFile(new URL(`${fn}/index.ts`, FUNCTIONS)));

const PORTAL_SETTINGS = await read("portal-settings");
const CUSTOMER_ACCEPT = await read("customer-accept");

/** The source from `anchor` up to the first `.upload(` after it — one rebuild-and-store path. */
function rebuildBlock(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  assert(start !== -1, `anchor not found, re-point it: ${anchor}`);
  const up = src.indexOf(".upload(", start);
  assert(up !== -1, `no .upload( after ${anchor} — re-point the anchor`);
  return src.slice(start, up);
}

Deno.test("the anchors this test polices still exist", () => {
  // A scan that matched nothing would pass every check below.
  assert(PORTAL_SETTINGS.includes("async function regenerateQuotePdf("), "regenerateQuotePdf");
  assert(PORTAL_SETTINGS.includes('action === "reissue_invoice"'), "reissue_invoice");
  assert(CUSTOMER_ACCEPT.includes("appendAcceptancePage("), "customer-accept countersigns");
  assertEquals(
    CUSTOMER_ACCEPT.split("appendAcceptancePage(").length - 1,
    2,
    "customer-accept has exactly the two countersign paths: the quote and the invoice",
  );
});

Deno.test("every rebuild that overwrites a signed document re-appends the certificate", () => {
  // Both of these upload over the path the customer's link already points at, so whatever they
  // build IS the document from then on.
  for (const [label, anchor] of [
    ["the quote rebuild", "async function regenerateQuotePdf("],
    ["the invoice reissue", 'action === "reissue_invoice"'],
  ] as const) {
    const block = rebuildBlock(PORTAL_SETTINGS, anchor);
    assert(block.includes("design_acceptances"), `${label}: reads no acceptance row`);
    assert(block.includes("appendAcceptancePage("), `${label}: never re-appends the certificate`);
  }
});

Deno.test("the invoice reissue stamps the INVOICE, and the quote rebuild stamps the QUOTE", () => {
  // docLabel is what the certificate page prints over the document number. The two paths stamp
  // different documents and must not be copied onto each other.
  const invoice = rebuildBlock(PORTAL_SETTINGS, 'action === "reissue_invoice"');
  assert(invoice.includes('.eq("subject", "invoice")'), "the reissue reads the QUOTE's acceptance");
  assert(invoice.includes('docLabel: "Invoice"'), "the reissue's certificate is not labelled Invoice");

  const quote = rebuildBlock(PORTAL_SETTINGS, "async function regenerateQuotePdf(");
  assert(quote.includes('.eq("subject", "quote")'), "the quote rebuild reads the INVOICE's acceptance");
  assert(!quote.includes('docLabel: "Invoice"'), "the quote rebuild labels its certificate Invoice");
});

Deno.test("the invoice reissue re-appends the LATEST revision's signature", () => {
  // Migration 213 writes one design_acceptances row per revision with subject='invoice' and
  // revision = co_no. A reissue after a change order rebuilds the amended figures, so the
  // certificate bound into it must be the signature for that revision, not revision 0's.
  const invoice = rebuildBlock(PORTAL_SETTINGS, 'action === "reissue_invoice"');
  assert(
    /\.order\(\s*"revision",\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(invoice),
    "the reissue does not take the newest revision's acceptance",
  );
});

Deno.test("a certificate only ever asserts a signature the customer actually gave", () => {
  // A quote is click-accepted since migration 136, and `method` would otherwise fall through to
  // "typed" and print a certificate asserting a typed signature over an empty name.
  for (const anchor of ["async function regenerateQuotePdf(", 'action === "reissue_invoice"']) {
    const block = rebuildBlock(PORTAL_SETTINGS, anchor);
    assert(
      /method === "drawn" \|\| \w+\.method === "typed"/.test(block),
      `${anchor}: stamps a certificate without checking the stored method`,
    );
  }
});

Deno.test("no countersign failure in customer-accept is swallowed into the console", () => {
  // Each branch below leaves design_acceptances saying the customer signed while the document
  // they download carries no certificate. The only difference between the causes is which one
  // fired, and console.warn cannot tell anyone.
  const start = CUSTOMER_ACCEPT.indexOf("let signedPdf = false;");
  assert(start !== -1, "countersign blocks not found, re-point the anchor");
  const blocks = CUSTOMER_ACCEPT.split("let signedPdf = false;").slice(1);
  assertEquals(blocks.length, 2, "expected the invoice and quote countersign blocks");
  for (const [i, rest] of blocks.entries()) {
    // Up to the confirmation-email step that follows each block.
    const end = rest.indexOf("const to =");
    const block = end === -1 ? rest : rest.slice(0, end);
    assert(!/console\.warn/.test(block), `countersign block ${i}: a failure still goes to console.warn only`);
    assert(/logEdgeError\(/.test(block), `countersign block ${i}: logs nothing durable`);
  }
});

Deno.test("the prefix guard's skip is observable too", () => {
  // The guard only fetches a PDF under OUR storage under THIS tenant's prefix, which is correct
  // and was also completely silent: an externally-issued document simply never got its
  // certificate and nothing said so.
  assert(
    CUSTOMER_ACCEPT.includes("invoice_countersign_skipped"),
    "an invoice outside the floor-plans prefix is skipped with no signal",
  );
  assert(
    CUSTOMER_ACCEPT.includes("quote_countersign_skipped"),
    "a quote outside the floor-plans prefix is skipped with no signal",
  );
  // A CLICK is SUPPOSED to skip — that is the design, not a fault — so it must not file a row.
  const at = CUSTOMER_ACCEPT.indexOf("quote_countersign_skipped");
  const guard = CUSTOMER_ACCEPT.slice(CUSTOMER_ACCEPT.lastIndexOf("} else", at), at);
  assert(/method !== "click"/.test(guard), "a click-accepted quote would file a skip row it has earned");
});
