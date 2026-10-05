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
import { pdfText } from "./pdfText.ts";
import { makePng } from "./pngFixture.ts";

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
  // pdfText inflates the content streams and decodes the hex string operands — see that
  // module for why reading a PDF back is fiddly enough to be worth sharing.
  const bytes = await buildQuotePdf({ ...INPUT, docKind: "invoice" });
  assertIsPdf(bytes);
  assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
  const invText = await pdfText(bytes);
  assert(invText.includes("Invoice #JB-1041"), "invoice title must render");
  assert(!invText.includes("Valid until"), "an invoice must not carry a validity window");
  // And the default stays an estimate.
  const estText = await pdfText(await buildQuotePdf(INPUT));
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

// ── The logo (2026-10-05) ────────────────────────────────────────────────────────────────
// Sheet 1's letterhead logo is fetched inside buildQuotePdf, beside the plan PDF. The property
// under test is the same as for the plan sheets: nothing about the logo can cost the customer
// their estimate. It prints when Storage serves it, and every way it can fail (refused, hung,
// unreadable) still yields sheet 1 with the text letterhead and one "logo …" reason.

const LOGO_SRC = {
  render: "https://example.test/storage/v1/render/image/public/branding/acme-sheds/biz-logo-1.png?width=640&height=200&resize=contain&format=origin",
  original: "https://example.test/storage/v1/object/public/branding/acme-sheds/biz-logo-1.png",
};
const PLAN_URL = "https://example.test/storage/v1/object/public/floor-plans/acme-sheds/SS-ABC234-1.pdf";
const imageCount = (bytes: Uint8Array) => (new TextDecoder("latin1").decode(bytes).match(/\/Subtype \/Image/g) ?? []).length;

/** Answer each URL from `routes`; anything else is a test failure. `hang` waits for the abort. */
async function withRoutes(routes: Record<string, () => Promise<Response> | "hang">, run: (seen: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const r = routes[url];
    if (!r) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    const a = r();
    if (a === "hang") return new Promise<Response>((_ok, bad) => init?.signal?.addEventListener("abort", () => bad(init.signal!.reason)));
    return a;
  }) as typeof fetch;
  try { await run(seen); } finally { globalThis.fetch = original; }
}

Deno.test("the logo prints on sheet 1 and the plan pages are still appended after it", async () => {
  const plan = await makePlanPdf(2);
  const reasons: string[] = [];
  await withRoutes({
    [LOGO_SRC.render]: () => Promise.resolve(binaryResponse(makePng(314, 200))),
    [PLAN_URL]: () => Promise.resolve(binaryResponse(plan)),
  }, async (seen) => {
    const bytes = await buildQuotePdf({ ...INPUT, planPdfUrl: PLAN_URL, logoSources: LOGO_SRC, onSheetSkipped: (r) => reasons.push(r) });
    assertIsPdf(bytes);
    assertEquals((await PDFDocument.load(bytes)).getPageCount(), 3, "estimate + floor plan + 3D");
    assertEquals(imageCount(bytes), 1, "the logo is on the document");
    assertEquals(seen.filter((u) => u === LOGO_SRC.original).length, 0, "the scaled copy served, so the original was never asked for");
  });
  assertEquals(reasons, [], "a document with everything on it reports nothing");
});

Deno.test("the logo and the plan are fetched side by side, not one after the other", async () => {
  // The logo answers only after the plan fetch has STARTED. If buildQuotePdf waited for the logo
  // before asking for the plan, the plan would never be asked for and this would hang until the
  // logo's own budget ran out, then print no logo.
  const plan = await makePlanPdf(1);
  let planAsked: () => void = () => {};
  const planStarted = new Promise<void>((ok) => { planAsked = ok; });
  const reasons: string[] = [];
  await withRoutes({
    [LOGO_SRC.render]: () => planStarted.then(() => binaryResponse(makePng(200, 200))),
    [PLAN_URL]: () => { planAsked(); return Promise.resolve(binaryResponse(plan)); },
  }, async () => {
    const t0 = Date.now();
    const bytes = await buildQuotePdf({ ...INPUT, planPdfUrl: PLAN_URL, logoSources: LOGO_SRC, onSheetSkipped: (r) => reasons.push(r) });
    assert(Date.now() - t0 < 2000, "no budget was spent waiting");
    assertEquals(imageCount(bytes), 1, "the logo printed");
    assertEquals((await PDFDocument.load(bytes)).getPageCount(), 2);
  });
  assertEquals(reasons, []);
});

Deno.test("a refused or unreadable logo still yields sheet 1, text letterhead, one logo reason", async () => {
  const cases: [string, Record<string, () => Promise<Response>>, RegExp][] = [
    ["both 404", {
      [LOGO_SRC.render]: () => Promise.resolve(new Response("", { status: 404 })),
      [LOGO_SRC.original]: () => Promise.resolve(new Response("", { status: 404 })),
    }, /^logo skipped: scaled 404; original 404$/],
    ["network down", {
      [LOGO_SRC.render]: () => Promise.reject(new TypeError("connection refused")),
      [LOGO_SRC.original]: () => Promise.reject(new TypeError("connection refused")),
    }, /^logo skipped: scaled TypeError; original TypeError$/],
    ["an HTML error page", {
      [LOGO_SRC.render]: () => Promise.resolve(new Response("<html><body>Bad gateway</body></html>".padEnd(64), { status: 200 })),
      [LOGO_SRC.original]: () => Promise.resolve(new Response("<html><body>Bad gateway</body></html>".padEnd(64), { status: 200 })),
    }, /^logo skipped: scaled not a PNG or JPEG; original not a PNG or JPEG$/],
    ["a PNG that will not decode", {
      [LOGO_SRC.render]: () => {
        const broken = makePng(40, 20);
        broken.fill(7, 41, broken.length - 12);
        return Promise.resolve(binaryResponse(broken));
      },
    }, /^logo embed failed/],
  ];
  for (const [label, routes, want] of cases) {
    const reasons: string[] = [];
    await withRoutes(routes, async () => {
      const bytes = await buildQuotePdf({ ...INPUT, logoSources: LOGO_SRC, onSheetSkipped: (r) => reasons.push(r) });
      assertIsPdf(bytes);
      assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1, label);
      assertEquals(imageCount(bytes), 0, `${label}: no image`);
      const t = await pdfText(bytes);
      assert(t.includes("Example Barn Co.") && t.includes("Estimate #JB-1041"), `${label}: sheet 1 is all there`);
    });
    const logo = reasons.filter((r) => r.startsWith("logo"));
    assertEquals(logo.length, 1, `${label}: one logo reason, got ${JSON.stringify(reasons)}`);
    assert(want.test(logo[0]), `${label}: ${logo[0]}`);
    assert(reasons.includes("no plan url"), `${label}: the plan reason is still its own`);
  }
});

Deno.test("a hung logo fetch costs the logo after its 3 s budget, never the document", async () => {
  const reasons: string[] = [];
  await withRoutes({ [LOGO_SRC.render]: () => "hang", [LOGO_SRC.original]: () => "hang" }, async (seen) => {
    const t0 = Date.now();
    const bytes = await buildQuotePdf({ ...INPUT, logoSources: LOGO_SRC, onSheetSkipped: (r) => reasons.push(r) });
    const took = Date.now() - t0;
    assertIsPdf(bytes);
    assertEquals((await PDFDocument.load(bytes)).getPageCount(), 1);
    assertEquals(imageCount(bytes), 0);
    assert(took >= 2900 && took < 6000, `gave up at the 3 s budget, took ${took} ms`);
    assertEquals(seen.filter((u) => u === LOGO_SRC.original).length, 0, "no fallback once the budget is spent");
  });
  assertEquals(reasons.filter((r) => r.startsWith("logo")), ["logo fetch timed out"]);
});

Deno.test("no logo sources: no logo fetch, no logo reason (every tenant without an uploaded logo)", async () => {
  const reasons: string[] = [];
  await withRoutes({}, async (seen) => {
    const bytes = await buildQuotePdf({ ...INPUT, logoSources: null, onSheetSkipped: (r) => reasons.push(r) });
    assertIsPdf(bytes);
    assertEquals(seen, []);
  });
  assertEquals(reasons, ["no plan url"]);
});
