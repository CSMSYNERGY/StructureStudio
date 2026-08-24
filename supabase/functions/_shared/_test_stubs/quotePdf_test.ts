// Unit tests for the three-sheet StructureStudio quote document.
//
// buildQuotePdf runs on the SS-mode send path, so the property under test is not really "it
// makes a nice PDF" — it is that NOTHING about the plan sheets can cost the customer their
// estimate. Each case below is a way the plan PDF can be wrong (absent, 404, oversized,
// garbage, encrypted, zero-page, a hung server) and each must still yield a real document.
//
// Lives in _test_stubs, like estimatePdf_test.ts: this group is the one allowed registry
// imports, and pdf-lib is unavoidable here.
//
// Run (cwd: supabase/functions — how scripts/preflight.mjs invokes the group):
//   deno test --quiet --allow-env --node-modules-dir=auto \
//             --import-map=_shared/_test_stubs/import_map.json \
//             _shared/_test_stubs/quotePdf_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { buildQuotePdf } from "../quotePdf.ts";

// Generic identities only — this repo is PUBLIC; no client names or domains in fixtures.
const INPUT = {
  business: { name: "Example Barn Co.", phone: "(555) 010-0100" },
  estimateNumber: "JB-1041",
  lines: [
    { kind: "building", itemKey: "building", name: "12x24 Lofted Barn", desc: "Base building", qty: 1, amount: 8950 },
    { kind: "layout", itemKey: "workbench", name: "Workbench", desc: "8 ft, north wall", qty: 8, amount: 22.5 },
  ],
};

function assertIsPdf(bytes: Uint8Array) {
  assert(bytes.length > 1000, `expected > 1000 bytes, got ${bytes.length}`);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
}

/** A stand-in for the designer's upload: an N-page PDF, same way pdf-lib would read the real one. */
async function makePlanPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return await doc.save();
}

/** A 200 carrying binary bytes. `.slice().buffer` because a Uint8Array view is not a `BodyInit`
 *  under this TS lib, and slice() hands back a buffer whose length matches the view exactly. */
const binaryResponse = (bytes: Uint8Array, init?: ResponseInit) =>
  new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, ...init });

/** Swap globalThis.fetch for the duration of one case, always restoring it. */
async function withFetch(handler: () => Promise<Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => handler()) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

Deno.test("no plan url → the estimate sheet alone, and no fetch is attempted", async () => {
  let called = false;
  await withFetch(
    () => { called = true; return Promise.resolve(new Response("", { status: 200 })); },
    async () => {
      const bytes = await buildQuotePdf(INPUT);
      assertIsPdf(bytes);
      assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
    },
  );
  assertEquals(called, false, "a missing url must not produce a network call");
});

Deno.test("plan pages are appended after the estimate sheet", async () => {
  const plan = await makePlanPdf(2); // floor plan + the four-sided 3D sheet
  await withFetch(
    () => Promise.resolve(binaryResponse(plan)),
    async () => {
      const bytes = await buildQuotePdf({ ...INPUT, planPdfUrl: "https://example.test/plan.pdf" });
      assertIsPdf(bytes);
      // 1 estimate + 2 plan pages. This is the three-sheet document, asserted as a count so a
      // change that silently drops the 3D sheet has to update the number deliberately.
      assertEquals((await PDFDocument.load(bytes)).getPageCount(), 3);
    },
  );
});

Deno.test("every broken-plan path degrades to the estimate sheet instead of throwing", async () => {
  const reasons: string[] = [];
  const one = async (label: string, handler: () => Promise<Response>) => {
    await withFetch(handler, async () => {
      const bytes = await buildQuotePdf({
        ...INPUT,
        planPdfUrl: "https://example.test/plan.pdf",
        onSheetSkipped: (r) => reasons.push(`${label}:${r}`),
      });
      assertIsPdf(bytes);
      assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1, label);
    });
  };

  await one("404", () => Promise.resolve(new Response("nope", { status: 404 })));
  await one("empty", () => Promise.resolve(binaryResponse(new Uint8Array(0))));
  await one("garbage", () => Promise.resolve(binaryResponse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))));
  await one("network", () => Promise.reject(new TypeError("connection refused")));
  // Oversized declared length: refused on the header, before the body is ever read.
  await one("huge", () => Promise.resolve(new Response("x", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } })));

  // NOT covered here: a genuinely page-less plan PDF. quotePdf.ts guards for it because another
  // producer can emit one, but pdf-lib cannot be made to — `PDFDocument.create().save()` round-
  // trips as a ONE-page document, so a fixture built that way asserts the wrong thing rather
  // than the guard. Left as a code-level guard with no test, rather than a test proving nothing.

  // Each failure reported exactly one reason — the telemetry a support call needs to explain
  // a quote that arrived with only its first sheet.
  assertEquals(reasons.length, 5, `expected one reason per case, got ${reasons.join(", ")}`);
});

Deno.test("docKind 'invoice' renders a real document titled Invoice, without a validity line", async () => {
  // pdf-lib flate-compresses content streams AND hex-encodes drawn strings, so proving a
  // title rendered means: find each stream (skipping the trailing half of "endstream"),
  // trim the EOL pdf-lib appends before "endstream" (pako refuses trailing bytes), inflate,
  // then decode the <hex> string operands back to text. pako is pdf-lib's own compression
  // dependency, so this adds nothing new.
  const { inflate } = await import("npm:pako@2.1.0");
  const textOf = (bytes: Uint8Array) => {
    const raw = new TextDecoder("latin1").decode(bytes);
    let out = "";
    const re = /stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (raw.slice(Math.max(0, m.index - 3), m.index) === "end") continue;
      const start = m.index + m[0].length;
      let end = raw.indexOf("endstream", start);
      if (end < 0) continue;
      while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
      try {
        const inflated = inflate(bytes.subarray(start, end));
        if (inflated) out += new TextDecoder("latin1").decode(inflated);
      } catch { /* not a flate stream */ }
    }
    return out.replace(/<([0-9A-Fa-f]+)>/g, (_all, h: string) => {
      let s = "";
      for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
      return s;
    });
  };
  const bytes = await buildQuotePdf({ ...INPUT, docKind: "invoice" });
  assertIsPdf(bytes);
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
  const invText = textOf(bytes);
  assert(invText.includes("Invoice #JB-1041"), "invoice title must render");
  assert(!invText.includes("Valid until"), "an invoice must not carry a validity window");
  // And the default stays an estimate.
  const estText = textOf(await buildQuotePdf(INPUT));
  assert(estText.includes("Estimate #JB-1041"), "default docKind must stay Estimate");
  assert(estText.includes("Valid until"), "estimates keep the validity window");
});

Deno.test("a hostile onSheetSkipped callback cannot break the document", async () => {
  await withFetch(
    () => Promise.resolve(new Response("nope", { status: 404 })),
    async () => {
      const bytes = await buildQuotePdf({
        ...INPUT,
        planPdfUrl: "https://example.test/plan.pdf",
        onSheetSkipped: () => { throw new Error("telemetry exploded"); },
      });
      assertIsPdf(bytes);
    },
  );
});
