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

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 2 — the two behaviours the wiring checks above cannot see (2026-09-19).
//
// The checks above prove the reissue READS an acceptance and re-appends a certificate. They
// cannot say WHICH row it reads, or what happens when the stored PNG will not come back —
// and both of those were wrong in the first cut of this fix:
//
//   1. `subject='invoice'` ordered by revision desc took the NEWEST row, and
//      `attest_change_order` writes one of those per-revision rows with method='rep' (a
//      builder's record of a verbal approval — its own consent sentence says it is not the
//      customer's signature). So a customer signature at revision 0 followed by a rep-attested
//      change order at revision 1 selected the REP row, failed the drawn/typed guard, appended
//      nothing, and overwrote the countersigned PDF with an unsigned one.
//   2. supabase-js `storage.download()` RESOLVES `{ data: null, error }` for a missing or
//      denied object. It does not throw, so the try/catch never fired and `dl.error` was never
//      read: a missing PNG degraded silently into a certificate captioning the customer's typed
//      NAME "Signed by hand", with no app_errors row to say so.
//
// Both are executed rather than pattern-matched: the shipped query and the shipped download
// block are LIFTED OUT OF THE SOURCE and run against a fake client (same technique as
// shedProfile_test). A source test that only grepped for `.in("method", …)` would pass on a
// filter naming the wrong column.
// ═══════════════════════════════════════════════════════════════════════════════════════

const INVOICE_BLOCK = rebuildBlock(PORTAL_SETTINGS, 'action === "reissue_invoice"');

/** A slice between two anchors inside one block, loud when either moves. */
function lift(src: string, what: string, start: string, end: string, inclusive = false): string {
  const i = src.indexOf(start);
  assert(i !== -1, `lift(${what}): start anchor moved — RE-POINT IT, do not delete the test: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert(j !== -1, `lift(${what}): end anchor moved — RE-POINT IT: ${end}`);
  return src.slice(i, inclusive ? j + end.length : j);
}

type Acc = Record<string, unknown>;

// ── The shipped acceptance read, executed ────────────────────────────────────────────────
const ACCEPTANCE_QUERY = lift(
  INVOICE_BLOCK,
  "the reissue's acceptance read",
  'const { data: acc } = await admin.from("design_acceptances")',
  ".maybeSingle();",
  true,
);

const runAcceptanceRead = new Function(
  "admin",
  "clientId",
  "shortCode",
  `return (async () => { ${ACCEPTANCE_QUERY} return acc; })();`,
) as unknown as (admin: unknown, clientId: string, shortCode: string) => Promise<Acc | null>;

/** Just enough PostgREST builder for the chain above: select/eq/in/order/limit/maybeSingle. */
function fakeAdmin(rows: Acc[]) {
  return {
    from(table: string) {
      assertEquals(table, "design_acceptances", "the reissue read moved to another table");
      let sel = rows.slice();
      const q = {
        select: (_cols: string) => q,
        eq: (col: string, val: unknown) => {
          sel = sel.filter((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          sel = sel.filter((r) => vals.includes(r[col]));
          return q;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          sel = sel.slice().sort((a, b) =>
            opts.ascending ? Number(a[col]) - Number(b[col]) : Number(b[col]) - Number(a[col])
          );
          return q;
        },
        limit: (n: number) => {
          sel = sel.slice(0, n);
          return q;
        },
        maybeSingle: () => Promise.resolve({ data: sel[0] ?? null, error: null }),
      };
      return q;
    },
  };
}

const CID = "acme-barns", CODE = "SS-AAAA1111";
const row = (over: Acc): Acc => ({
  client_id: CID,
  short_code: CODE,
  subject: "invoice",
  revision: 0,
  method: "drawn",
  signer_name: "Carolyn",
  signature_image_path: `${CID}/${CODE}-0.png`,
  ...over,
});

// ── The shipped drawn/typed guard, executed ──────────────────────────────────────────────
const guardLine = INVOICE_BLOCK.split("\n").find((l) => /^\s*if \(acc && \(/.test(l)) || "";
assert(guardLine, "the certificate guard moved — re-point it");
const stampsCertificate = new Function(
  "acc",
  `return !!(${guardLine.trim().replace(/^if \(/, "").replace(/\) \{$/, "")});`,
) as unknown as (acc: Acc | null) => boolean;

Deno.test("a rep-attested change order does not out-rank the customer's own signature", async () => {
  // THE BUG, in the order it happens on a real account: the customer signs the invoice, then
  // the builder records a verbal approval of CO-1. Before the fix this returned the rep row,
  // the guard refused it, and the reissue uploaded an unsigned PDF over the signed one.
  const acc = await runAcceptanceRead(
    fakeAdmin([
      row({ revision: 0, method: "drawn" }),
      row({ revision: 1, method: "rep", signature_image_path: null }),
    ]),
    CID,
    CODE,
  );
  assert(acc, "the reissue found no acceptance at all, so it would append nothing");
  assertEquals(acc?.method, "drawn", "the reissue picked the rep attestation over the signature");
  assertEquals(acc?.revision, 0);
  assert(stampsCertificate(acc), "a real drawn signature was read and still not stamped");
});

Deno.test("the newest REAL signature wins — it is not pinned to revision 0", async () => {
  // The other half of the rule: when the newer revision IS signed, that is the one bound in,
  // because the rebuilt figures are the amended ones.
  const acc = await runAcceptanceRead(
    fakeAdmin([
      row({ revision: 0, method: "drawn" }),
      row({ revision: 2, method: "rep" }),
      row({ revision: 1, method: "typed", typed_signature: "Carolyn Miller" }),
    ]),
    CID,
    CODE,
  );
  assertEquals(acc?.revision, 1);
  assertEquals(acc?.method, "typed");
});

Deno.test("a rep attestation alone stamps nothing — it is not a signature", async () => {
  // attest_change_order's own consent text says so. An invoice approved only by a rep must not
  // carry a page captioned as the customer's hand or typed signature.
  const acc = await runAcceptanceRead(fakeAdmin([row({ revision: 0, method: "rep" })]), CID, CODE);
  assertEquals(acc, null);
  assertEquals(stampsCertificate(acc), false);
});

Deno.test("the acceptance read stays scoped to this tenant, this order, and the INVOICE", async () => {
  // The filters that keep a certificate off the wrong document. A neighbouring tenant's signed
  // invoice and this order's own QUOTE acceptance are both real rows in that table.
  const acc = await runAcceptanceRead(
    fakeAdmin([
      row({ client_id: "other-barns", revision: 9 }),
      row({ short_code: "SS-BBBB2222", revision: 9 }),
      row({ subject: "quote", revision: 9 }),
      row({ revision: 0 }),
    ]),
    CID,
    CODE,
  );
  assertEquals(acc?.revision, 0, "the reissue read crossed a tenant, an order, or the quote/invoice line");
});

// ── The shipped signature-PNG download, executed ─────────────────────────────────────────
/** `new Function` parses plain JS, and a lifted block can carry a TS type ASSERTION — this
 *  file has shipped `(e as Error).message` in exactly this place. Strip that one form; it
 *  changes nothing at runtime. Anything heavier (an annotated `let`) still throws loudly,
 *  which is the right outcome: re-point or re-shape, do not delete the test. */
const asJs = (src: string) => src.replace(/\s+as\s+[A-Z][A-Za-z0-9_$]*/g, "");

const DOWNLOAD_BLOCK = asJs(lift(
  INVOICE_BLOCK,
  "the signature-PNG download",
  "if (acc.signature_image_path) {",
  "pdfBytes = await appendAcceptancePage(",
));

const runSignatureDownload = new Function(
  "acc",
  "admin",
  "logEdgeError",
  "req",
  "clientId",
  "shortCode",
  `return (async () => { let signaturePng = null; ${DOWNLOAD_BLOCK} return signaturePng; })();`,
) as unknown as (
  acc: Acc,
  admin: unknown,
  logEdgeError: (e: Record<string, unknown>) => Promise<unknown>,
  req: unknown,
  clientId: string,
  shortCode: string,
) => Promise<Uint8Array | null>;

type DlResult = { data: Blob | null; error: { message: string } | null };

async function downloadWith(answer: () => Promise<DlResult>) {
  const logged: Record<string, unknown>[] = [];
  const admin = {
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "signatures", "the signature download moved to another bucket");
        return { download: (_path: string) => answer() };
      },
    },
  };
  const png = await runSignatureDownload(
    row({}),
    admin,
    (e: Record<string, unknown>) => {
      logged.push(e);
      return Promise.resolve(null);
    },
    new Request("https://example.test/"),
    CID,
    CODE,
  );
  return { png, logged };
}

Deno.test("a missing signature PNG is DETECTED and logged — download() resolves, it does not throw", async () => {
  // This is the normal failure mode and it was dead code: supabase-js hands back
  // { data: null, error } for a missing or denied object, so nothing ever reached the catch.
  const { png, logged } = await downloadWith(() =>
    Promise.resolve({ data: null, error: { message: "Object not found" } })
  );
  assertEquals(png, null);
  assertEquals(logged.length, 1, "a missing signature image was swallowed silently");
  assertEquals(logged[0].code, "invoice_signature_png_unreadable");
  assert(
    String(logged[0].message).includes("Object not found"),
    "the logged row does not carry the storage error, so triage cannot tell the causes apart",
  );
});

Deno.test("a thrown download is still logged — the catch is kept, not replaced", async () => {
  // A genuine network/abort throw. The error-branch fix must not cost us this one.
  const { png, logged } = await downloadWith(() => Promise.reject(new Error("connection reset")));
  assertEquals(png, null);
  assertEquals(logged.length, 1);
  assert(String(logged[0].message).includes("connection reset"));
});

Deno.test("a readable signature PNG is embedded and files nothing", async () => {
  // The happy path must stay quiet, or the log stops being worth reading.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { png, logged } = await downloadWith(() =>
    Promise.resolve({ data: new Blob([bytes]), error: null })
  );
  assertEquals(logged.length, 0, "a successful download filed an error row");
  assert(png instanceof Uint8Array, "the PNG bytes never reached the certificate");
  assertEquals(Array.from(png as Uint8Array), Array.from(bytes));
});
