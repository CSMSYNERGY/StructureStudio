// On 2026-10-27 a builder uploaded a pricing sheet and one row came back "skipped" with a
// Cloudflare 502 error PAGE as the reason — a few hundred characters of HTML in the red list under
// the upload button. Nothing was wrong with their sheet: the gateway in front of PostgREST dropped
// one call out of several hundred. The price had saved; one size's included options had not.
//
// WHAT IS PINNED HERE:
//   1. A call the database never answered is RETRIED (twice more) and the sheet still lands clean.
//   2. A gateway's own answer NEVER reaches the builder's screen. They get what to do next, and
//      the body is logged through onFault so a human can still read it.
//   3. A refusal POSTGRES wrote is shown as written and is NOT retried — it would say the same
//      thing three times and spend the isolate's CPU limit doing it (546, the 2026-10-27 crash).
//
// Tables are the in-memory fake (pricingImportFake.ts); a failure with no SQLSTATE is how it
// mimics a gateway answering instead of the database. Tenants and prices are made up; the repo
// is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { importPricingRows } from "../pricingImport.ts";
import { fakeDb, snapshot } from "./pricingImportFake.ts";

const CLIENT = "acme-sheds";
const SEED = { building_styles: [{ client_id: CLIENT, id: "st-a", key: "utility", label: "Utility" }] };
const SHEET = [{ style: "Utility", width: "8", length: "10", price: "2400", active: "", inclusions: { workbench: "1" } }];

// The body Adam actually saw, shortened: an HTML page, no SQLSTATE, nothing he could act on.
const GATEWAY_502 = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>';

const faults: { code: string; message: string }[] = [];
const onFault = (code: string, message: string) => void faults.push({ code, message });

Deno.test("a gateway blip on an option write is retried, and the sheet lands with nothing skipped", async () => {
  let blips = 0;
  const { sb, tables, calls } = fakeDb(structuredClone(SEED), {
    failOn: ({ table, verb }) =>
      table === "building_size_inclusions" && verb === "upsert" && blips++ === 0
        ? { message: GATEWAY_502 }   // no code: the database never answered
        : null,
  });
  const r = await importPricingRows(sb, CLIENT, SHEET, onFault);

  assertEquals(r.skipped, []);
  assertEquals([r.created, r.updated], [1, 0]);
  // The option is on file, and it got there on the retry of the same bulk call — not by falling
  // back to one write per row, which is what makes a big sheet run out of CPU.
  assertEquals(snapshot(tables).inclusions.map(([k]) => k), ["st-a|8|10|workbench"]);
  assertEquals(calls.filter((c) => c.table === "building_size_inclusions" && c.verb === "upsert").length, 2);
});

Deno.test("a gateway's own page never reaches the builder; it is logged and replaced", async () => {
  faults.length = 0;
  const { sb, calls } = fakeDb(structuredClone(SEED), {
    failOn: ({ table, verb }) => table === "building_size_inclusions" && verb === "upsert" ? { message: GATEWAY_502 } : null,
  });
  const r = await importPricingRows(sb, CLIENT, SHEET, onFault);

  assertEquals(r.skipped.length, 1);
  const line = r.skipped[0];
  // Nothing of the gateway's answer, in any form.
  assert(!line.includes("<"), line);
  assert(!/cloudflare|bad gateway|502|html/i.test(line), line);
  // It still says WHICH size and option, and what to do about it.
  assert(line.startsWith("Utility 8x10 / workbench:"), line);
  assert(/upload the same sheet again/i.test(line), line);
  // Three attempts at the bulk call, then three at the one row it fell back to.
  assertEquals(calls.filter((c) => c.table === "building_size_inclusions" && c.verb === "upsert").length, 6);
  // The body is not lost: a human can read it in the error log.
  assertEquals(faults.length, 1);
  assertEquals(faults[0].code, "pricing_import_write_failed");
  assert(faults[0].message.includes("502 Bad Gateway"), faults[0].message);
  assert(faults[0].message.startsWith("Utility 8x10 / workbench:"), faults[0].message);
});

Deno.test("a gateway blip on the price write is retried too", async () => {
  let blips = 0;
  const { sb, tables } = fakeDb(structuredClone(SEED), {
    failOn: ({ table }) => table === "building_sizes" && blips++ === 0 ? { message: GATEWAY_502 } : null,
  });
  const r = await importPricingRows(sb, CLIENT, SHEET, onFault);
  assertEquals(r.skipped, []);
  assertEquals([r.created, r.updated], [1, 0]);
  assertEquals(snapshot(tables).sizes.map(([, z]) => z.base_price), [2400]);
});

Deno.test("a refusal Postgres wrote is shown as written, and tried once", async () => {
  faults.length = 0;
  const { sb, calls } = fakeDb(structuredClone(SEED), {
    failOn: ({ table, verb }) =>
      table === "building_size_inclusions" && verb === "upsert"
        ? { code: "23514", message: 'new row violates check constraint "building_size_inclusions_qty_check"' }
        : null,
  });
  const r = await importPricingRows(sb, CLIENT, SHEET, onFault);

  assertEquals(r.skipped, ['Utility 8x10 / workbench: new row violates check constraint "building_size_inclusions_qty_check"']);
  // One bulk call and one per-row replay — no retries of either, and nothing logged as a fault.
  assertEquals(calls.filter((c) => c.table === "building_size_inclusions" && c.verb === "upsert").length, 2);
  assertEquals(faults, []);
});
