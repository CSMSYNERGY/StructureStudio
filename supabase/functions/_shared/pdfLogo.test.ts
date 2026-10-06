// The logo on the quote PDFs (2026-10-05): which URLs the server may fetch, what it will embed, and
// that the fetch can only ever cost the logo. The drawing itself is pinned with real images in
// _test_stubs/estimatePdf_test.ts and quotePdf_test.ts (they need pdf-lib); this file pins:
//
//   - only our own storage, only the branding bucket, only this tenant's folder, one plain name,
//     after "../" and "%2e%2e" are resolved;
//   - PNG and JPEG are recognised by their bytes, with their pixel size;
//   - over 1 MB, not PNG/JPEG, or a PNG too big to decode is refused before pdf-lib sees it;
//   - the scaled copy first, the original only when that is refused, one 3 s budget for both,
//     exactly one telemetry reason on any failure, and never a throw.
//
// Deliberately dependency-free (no jsr:/npm: imports), like the other self-contained _shared
// tests. Tenants and file names are made up (the repo is public). globalThis.fetch is stubbed per
// case; no network permission is granted.

import {
  fetchPdfLogo,
  LOGO_MAX_BYTES,
  LOGO_MAX_PNG_PIXELS,
  logoUnfit,
  pdfLogoSources,
  sniffLogo,
} from "./pdfLogo.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const PROJECT = "https://project.supabase.example";
const T = "acme-sheds";
const LOGO = `${PROJECT}/storage/v1/object/public/branding/${T}/biz-logo-0f1e2d3c.png`;

// ─── pdfLogoSources ────────────────────────────────────────────────────────────────────────────
Deno.test("pdfLogoSources: an uploaded logo gives the scaled copy and the original", () => {
  assertEquals(pdfLogoSources(LOGO, PROJECT, T), {
    render: `${PROJECT}/storage/v1/render/image/public/branding/${T}/biz-logo-0f1e2d3c.png?width=640&height=200&resize=contain&format=origin`,
    original: LOGO,
  });
  // A trailing slash on SUPABASE_URL, a query or a fragment on the stored URL: same file.
  assertEquals(pdfLogoSources(`${LOGO}?v=3#x`, `${PROJECT}/`, T)?.original, LOGO);
  assertEquals(pdfLogoSources(`  ${LOGO}  `, PROJECT, T)?.original, LOGO);
});

Deno.test("pdfLogoSources: nothing outside this tenant's branding folder on our own storage", () => {
  const refuse = (url: unknown, why: string, clientId = T) => assertEquals(pdfLogoSources(url, PROJECT, clientId), null, why);
  refuse("https://cdn.example.test/logo.png", "another host (a pasted link): emails only, never fetched by the server");
  refuse(`${PROJECT}.evil.test/storage/v1/object/public/branding/${T}/x.png`, "a host that merely starts with ours");
  refuse(`http://project.supabase.example/storage/v1/object/public/branding/${T}/x.png`, "our host over another scheme");
  refuse(`${PROJECT}/storage/v1/object/public/floor-plans/${T}/x.png`, "another bucket");
  refuse(`${PROJECT}/storage/v1/object/public/branding/other-sheds/x.png`, "another tenant's folder");
  refuse(`${PROJECT}/storage/v1/object/public/branding/acme-sheds-2/x.png`, "a tenant whose id starts with this one");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/../other-sheds/x.png`, "../ out of the folder");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/%2e%2e/other-sheds/x.png`, "%2e%2e out of the folder");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/sub/x.png`, "a nested folder");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/x%20y.png`, "a percent-escape in the name");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/.hidden`, "a dot-file");
  refuse(`${PROJECT}/storage/v1/object/public/branding/${T}/`, "the folder itself");
  refuse(`${PROJECT}/storage/v1/object/sign/branding/${T}/x.png`, "a signed-URL path");
  refuse("", "blank");
  refuse(null, "null");
  refuse(42, "not a string");
  refuse("not a url", "not a URL");
  refuse(LOGO, "a tenant id with a slash cannot widen the folder", `${T}/..`);
  refuse(LOGO, "no tenant", "");
  assertEquals(pdfLogoSources(LOGO, "not a url", T), null, "a broken SUPABASE_URL fetches nothing");
});

// ─── sniffLogo / logoUnfit ─────────────────────────────────────────────────────────────────────
/** The first bytes of a PNG: signature + IHDR (width, height, 8-bit RGB). Enough to sniff. */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b.set([8, 2, 0, 0, 0], 24);
  return b;
}
/** SOI, an APP0 segment, a frame header of the given SOF marker, EOI. */
function jpegHeader(w: number, h: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sofSeg = [0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sofSeg, 0xff, 0xd9]);
}

Deno.test("sniffLogo: PNG and JPEG by their bytes, with their size", () => {
  assertEquals(sniffLogo(pngHeader(640, 200)), { kind: "png", width: 640, height: 200 });
  assertEquals(sniffLogo(pngHeader(11000, 7000)), { kind: "png", width: 11000, height: 7000 });
  assertEquals(sniffLogo(jpegHeader(473, 200)), { kind: "jpeg", width: 473, height: 200 });
  assertEquals(sniffLogo(jpegHeader(2084, 882, 0xc2)), { kind: "jpeg", width: 2084, height: 882 }, "progressive (SOF2)");
});

Deno.test("sniffLogo: anything else is null — WebP, GIF, SVG, HTML, truncated, empty", () => {
  const ascii = (s: string) => new TextEncoder().encode(s.padEnd(40, " "));
  assertEquals(sniffLogo(ascii("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), null);
  assertEquals(sniffLogo(ascii("GIF89a")), null);
  assertEquals(sniffLogo(ascii("<svg xmlns='http://www.w3.org/2000/svg'>")), null);
  assertEquals(sniffLogo(ascii("<html><body>Not found</body></html>")), null);
  assertEquals(sniffLogo(pngHeader(10, 10).slice(0, 20)), null, "a PNG cut off before its size");
  assertEquals(sniffLogo(jpegHeader(10, 10).slice(0, 26)), null, "a JPEG cut off before its frame header");
  const noIhdr = pngHeader(10, 10);
  noIhdr[12] = 0x58;
  assertEquals(sniffLogo(noIhdr), null, "a PNG whose first chunk is not IHDR");
  assertEquals(sniffLogo(new Uint8Array(0)), null);
  assertEquals(sniffLogo(null), null);
});

Deno.test("logoUnfit: what pdf-lib is never handed", () => {
  assertEquals(logoUnfit(pngHeader(640, 200)), null);
  assertEquals(logoUnfit(jpegHeader(2084, 882)), null, "a big JPEG is copied, not decoded: only the byte cap applies");
  assertEquals(logoUnfit(new Uint8Array(0)), "empty");
  assertEquals(logoUnfit(null), "empty");
  const big = new Uint8Array(LOGO_MAX_BYTES + 1);
  big.set(pngHeader(10, 10));
  assertEquals(logoUnfit(big), "over 1 MB");
  assertEquals(logoUnfit(new TextEncoder().encode("GIF89a".padEnd(40, "."))), "not a PNG or JPEG");
  assertEquals(logoUnfit(pngHeader(0, 10)), "no size");
  // The pixel cap: 1254x1254 (a live logo's size on 2026-10-05) is past it, 632x632 is not.
  assert(1254 * 1254 > LOGO_MAX_PNG_PIXELS && 632 * 632 <= LOGO_MAX_PNG_PIXELS, "the fixture sizes straddle the cap");
  assertEquals(logoUnfit(pngHeader(1254, 1254)), "1254x1254 PNG is too big to embed");
  assertEquals(logoUnfit(pngHeader(11000, 7000)), "11000x7000 PNG is too big to embed");
  assertEquals(logoUnfit(pngHeader(632, 632)), null);
});

// ─── fetchPdfLogo ──────────────────────────────────────────────────────────────────────────────
const SRC = pdfLogoSources(LOGO, PROJECT, T)!;
type Answer = Response | Error | "hang";

/** Swap globalThis.fetch for one case: `answers` by which source was asked; `seen` in order. */
async function withFetch(answers: { scaled?: Answer; original?: Answer }, run: (seen: string[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const which = url === SRC.render ? "scaled" : url === SRC.original ? "original" : null;
    if (!which) throw new Error(`unexpected fetch: ${url}`);
    seen.push(which);
    const a = answers[which] ?? new Response("missing", { status: 404 });
    if (a === "hang") {
      return new Promise((_ok, bad) => init?.signal?.addEventListener("abort", () => bad(init.signal!.reason)));
    }
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  }) as typeof fetch;
  try { await run(seen); } finally { globalThis.fetch = realFetch; }
}
const img = (bytes: Uint8Array, headers?: Record<string, string>) =>
  new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers });

Deno.test("fetchPdfLogo: the scaled copy is used when Storage serves it, and nothing else is asked", async () => {
  const notes: string[] = [];
  await withFetch({ scaled: img(pngHeader(314, 200)) }, async (seen) => {
    const got = await fetchPdfLogo(SRC, (r) => notes.push(r));
    assertEquals(got && sniffLogo(got), { kind: "png", width: 314, height: 200 });
    assertEquals(seen, ["scaled"]);
  });
  assertEquals(notes, [], "a logo that printed says nothing");
});

Deno.test("fetchPdfLogo: the original only when the scaled copy is refused", async () => {
  // The image service off (a 400), down (a network error), or answering something we cannot embed.
  for (const scaled of [new Response("no transforms", { status: 400 }), new TypeError("connection reset"), img(pngHeader(1254, 1254))]) {
    const notes: string[] = [];
    await withFetch({ scaled, original: img(jpegHeader(473, 200)) }, async (seen) => {
      const got = await fetchPdfLogo(SRC, (r) => notes.push(r));
      assertEquals(got && sniffLogo(got)?.kind, "jpeg");
      assertEquals(seen, ["scaled", "original"]);
    });
    assertEquals(notes, []);
  }
});

Deno.test("fetchPdfLogo: both refused is null and exactly one reason naming both", async () => {
  const cases: [string, { scaled?: Answer; original?: Answer }, RegExp][] = [
    ["404s", { scaled: new Response("", { status: 404 }), original: new Response("", { status: 404 }) }, /^logo skipped: scaled 404; original 404$/],
    ["webp", { scaled: img(new TextEncoder().encode("RIFF....WEBPVP8 ".padEnd(40))), original: img(new TextEncoder().encode("RIFF....WEBPVP8 ".padEnd(40))) },
      /^logo skipped: scaled not a PNG or JPEG; original not a PNG or JPEG$/],
    ["huge png", { scaled: new Response("", { status: 400 }), original: img(pngHeader(11000, 7000)) }, /original 11000x7000 PNG is too big to embed$/],
    ["declared over 1 MB", { scaled: new Response("x", { status: 200, headers: { "content-length": String(LOGO_MAX_BYTES + 1) } }), original: new Response("", { status: 404 }) },
      /^logo skipped: scaled over 1 MB; original 404$/],
    ["network", { scaled: new TypeError("dns"), original: new TypeError("dns") }, /^logo skipped: scaled TypeError; original TypeError$/],
  ];
  for (const [label, answers, want] of cases) {
    const notes: string[] = [];
    await withFetch(answers, async () => {
      assertEquals(await fetchPdfLogo(SRC, (r) => notes.push(r)), null, label);
    });
    assertEquals(notes.length, 1, `${label}: one reason, got ${JSON.stringify(notes)}`);
    assert(want.test(notes[0]), `${label}: ${notes[0]}`);
  }
});

Deno.test("fetchPdfLogo: a body past 1 MB with no length header is cut off, not read whole", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(256 * 1024);
  chunk.set(pngHeader(100, 100));
  const endless = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(chunk.slice()); },
  });
  const notes: string[] = [];
  await withFetch({ scaled: new Response(endless, { status: 200 }), original: new Response("", { status: 404 }) }, async () => {
    assertEquals(await fetchPdfLogo(SRC, (r) => notes.push(r)), null);
  });
  assert(pulled <= 6, `read stopped near the cap (pulled ${pulled} chunks of 256 KB)`);
  assertEquals(notes, ["logo skipped: scaled over 1 MB; original 404"]);
});

Deno.test("fetchPdfLogo: a hung storage read gives up at the budget, with no time spent on the fallback", async () => {
  const notes: string[] = [];
  await withFetch({ scaled: "hang", original: img(pngHeader(10, 10)) }, async (seen) => {
    const t0 = Date.now();
    assertEquals(await fetchPdfLogo(SRC, (r) => notes.push(r), 80), null);
    const took = Date.now() - t0;
    assert(took < 1500, `gave up at the budget, took ${took} ms`);
    assertEquals(seen, ["scaled"], "the budget is spent: the original is not tried");
  });
  assertEquals(notes, ["logo fetch timed out"]);
  // The budget is shared: a refused scaled copy, then a hung original, still ends on time.
  const notes2: string[] = [];
  await withFetch({ scaled: new Response("", { status: 400 }), original: "hang" }, async (seen) => {
    assertEquals(await fetchPdfLogo(SRC, (r) => notes2.push(r), 80), null);
    assertEquals(seen, ["scaled", "original"]);
  });
  assertEquals(notes2, ["logo fetch timed out (scaled 400)"]);
});

Deno.test("fetchPdfLogo: no source fetches nothing and says nothing; a throwing sink changes nothing", async () => {
  const notes: string[] = [];
  await withFetch({}, async (seen) => {
    assertEquals(await fetchPdfLogo(null, (r) => notes.push(r)), null);
    assertEquals(await fetchPdfLogo(undefined, (r) => notes.push(r)), null);
    assertEquals(seen, []);
  });
  assertEquals(notes, []);
  await withFetch({ scaled: new Response("", { status: 404 }), original: new Response("", { status: 404 }) }, async () => {
    assertEquals(await fetchPdfLogo(SRC, () => { throw new Error("telemetry exploded"); }), null);
  });
});
