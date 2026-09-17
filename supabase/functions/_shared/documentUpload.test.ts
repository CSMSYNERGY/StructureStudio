// What FIXED_PATH_PDF_UPLOAD actually puts on the wire, through the REAL supabase-js the edge
// functions import (review, 2026-09-17). Not a copy of the option object: the hazard is in how
// storage-js turns cacheControl into a header, so the test drives the library with a fetch stub
// and reads the request it would have sent. Nothing leaves the process; no network permission.
//
// The shipped call sites are pinned separately, by _test_stubs/documentUploadWiring_test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { FIXED_PATH_PDF_UPLOAD } from "./documentUpload.ts";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

/** A service-role client whose every request is captured and answered like a Storage upload. */
function capturingClient() {
  const sent: { url: string; method: string; headers: Headers }[] = [];
  const fetchStub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    sent.push({
      url: req ? req.url : String(input),
      method: String(init?.method ?? req?.method ?? "GET"),
      headers: new Headers(init?.headers ?? req?.headers),
    });
    return Promise.resolve(new Response(JSON.stringify({ Id: "00000000-0000-0000-0000-000000000000", Key: "floor-plans/t/SS-ABC123-quote.pdf" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  };
  const sb = createClient("https://project.supabase.example", "service-role-test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchStub as typeof fetch },
  });
  return { sb, sent };
}

Deno.test("a fixed-path PDF is uploaded with max-age=0, so an open revalidates instead of serving an hour-old copy", async () => {
  const { sb, sent } = capturingClient();
  const up = await sb.storage.from("floor-plans").upload("t/SS-ABC123-quote.pdf", PDF, FIXED_PATH_PDF_UPLOAD);
  assertEquals(up.error, null);
  const uploads = sent.filter((r) => r.url.includes("/storage/v1/object/floor-plans/"));
  assertEquals(uploads.length, 1, "exactly one upload request");
  const h = uploads[0].headers;
  assertEquals(h.get("cache-control"), "max-age=0");
  // The rest of what the call sites passed before, unchanged: still a PDF, still replacing in place.
  assertEquals(h.get("content-type"), "application/pdf");
  assertEquals(h.get("x-upsert"), "true");
});

Deno.test("control: the options the writers used to pass leave storage-js's one-hour default on the object", async () => {
  // If this starts failing, storage-js changed its default. The fix above does not depend on it,
  // but the comment in documentUpload.ts describing the hazard would then be out of date.
  const { sb, sent } = capturingClient();
  await sb.storage.from("floor-plans").upload("t/SS-ABC123-quote.pdf", PDF, { contentType: "application/pdf", upsert: true });
  const uploads = sent.filter((r) => r.url.includes("/storage/v1/object/floor-plans/"));
  assertEquals(uploads[0]?.headers.get("cache-control"), "max-age=3600");
});

Deno.test("the option object cannot be edited by one caller for the next", () => {
  assert(Object.isFrozen(FIXED_PATH_PDF_UPLOAD));
  assertEquals({ ...FIXED_PATH_PDF_UPLOAD }, { contentType: "application/pdf", upsert: true, cacheControl: "0" });
});
