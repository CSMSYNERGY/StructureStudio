// The key rules behind delete_design's storage step (2026-10-05). The shipped handler is driven
// end to end, against a fake bucket, by _test_stubs/deleteDesignWiring_test.ts; this file pins
// the rules themselves, one at a time:
//
//   - only this tenant's prefix, only this design's code, only an exact known tail;
//   - a longer code that starts with this one is never this design's;
//   - <code>-invoice.pdf is never planned for removal, from any source, in any state;
//   - the quote documents go unless an invoice exists, and then they are reported as kept;
//   - the invoice gate sees a StructureStudio invoice that left the design 'accepted';
//   - the CRM estimate's gate does not: a StructureStudio invoice was never made from it;
//   - a listing or storage failure removes less, and never throws; a failed remove says "failed".
//
// Tenants and codes are made up (the repo is public).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  designObjectKind,
  floorPlanKey,
  FLOOR_PLANS,
  crmInvoiceExists,
  type FloorPlanStorage,
  invoiceExists,
  isOwnDesignImageKey,
  isOwnFloorPlanKey,
  planDesignObjectRemoval,
  quoteDocumentKeys,
  removeDesignObjects,
} from "./designStorageKeys.ts";

const T = "acme-sheds";
const CODE = "SS-ABC234";
const BASE = "https://project.supabase.example/storage/v1/object/public/floor-plans/";
const url = (key: string) => BASE + key;

// ─── floorPlanKey ──────────────────────────────────────────────────────────────────────────────
Deno.test("floorPlanKey: our public URL becomes its key, anything else is null", () => {
  assertEquals(floorPlanKey(url(`${T}/${CODE}-quote.pdf`)), `${T}/${CODE}-quote.pdf`);
  // Query and fragment are dropped; "../" is resolved before the path is read.
  assertEquals(floorPlanKey(url(`${T}/${CODE}-1790000000000.pdf?v=2#p`)), `${T}/${CODE}-1790000000000.pdf`);
  assertEquals(floorPlanKey(url(`${T}/../${T}/${CODE}.pdf`)), `${T}/${CODE}.pdf`);
  assertEquals(floorPlanKey("https://project.supabase.example/storage/v1/object/public/fixtures/x.pdf"), null);
  assertEquals(floorPlanKey("not a url"), null);
  assertEquals(floorPlanKey(""), null);
  assertEquals(floorPlanKey(null), null);
  assertEquals(floorPlanKey(42), null);
  // Percent-escapes are refused, never decoded (a lone "%" would throw in decodeURIComponent).
  assertEquals(floorPlanKey(url(`${T}/${CODE}%2D1.pdf`)), null);
  assertEquals(floorPlanKey(url(`${T}/${"A".repeat(400)}.pdf`)), null);
});

// ─── designObjectKind ──────────────────────────────────────────────────────────────────────────
Deno.test("designObjectKind: every shape this design's uploads produce, and nothing else", () => {
  const k = (name: string, legacyOk = false) => designObjectKind(name, T, CODE, legacyOk);
  assertEquals(k(`${T}/${CODE}.pdf`), "plan");
  assertEquals(k(`${T}/${CODE}-1790000000000.pdf`), "plan");
  assertEquals(k(`${T}/${CODE}-1.png`), "plan");
  assertEquals(k(`${T}/${CODE}-plan-1790000000000.jpg`), "image");
  assertEquals(k(`${T}/${CODE}-3d-1790000000000.jpg`), "image");
  assertEquals(k(`${T}/${CODE}-quote.pdf`), "quote");
  assertEquals(k(`${T}/${CODE}-estimate.pdf`), "estimate");
  assertEquals(k(`${T}/${CODE}-invoice.pdf`), "invoice");

  // Near misses are not ours.
  for (const name of [
    `${T}/${CODE}-plan-.jpg`, `${T}/${CODE}-plan-12.jpeg`, `${T}/${CODE}-plan-12.png`, `${T}/${CODE}-3d-x1.jpg`,
    `${T}/${CODE}-quote.PDF`, `${T}/${CODE}-quote-1.pdf`, `${T}/${CODE}quote.pdf`, `${T}/${CODE}-3d1b789eae3030d4.png`,
    `${T}/${CODE}-dc9de4594f3f4b8c.pdf`, `${T}/${CODE}/x.pdf`, `${T}/${CODE}-quote.pdf/x`, `${T}/ss-abc234-quote.pdf`,
    `${T}/${CODE}`, `${T}/`, ``,
  ]) assertEquals(k(name), null, name);
});

Deno.test("designObjectKind: a longer code sharing this one's prefix is another design", () => {
  // SS-ABC234 is a prefix of SS-ABC2345: the tail test is what keeps them apart.
  for (const tail of ["-quote.pdf", "-plan-1790000000000.jpg", ".pdf", "-1790000000000.pdf"]) {
    assertEquals(designObjectKind(`${T}/SS-ABC2345${tail}`, T, CODE, false), null, tail);
  }
  // And the other way round: the shorter code does not own the longer one's files.
  assertEquals(designObjectKind(`${T}/${CODE}-quote.pdf`, T, "SS-ABC23", false), null);
});

Deno.test("designObjectKind: another tenant's prefix is never ours, whatever the slug holds", () => {
  assertEquals(designObjectKind(`other-sheds/${CODE}-quote.pdf`, T, CODE, true), null);
  assertEquals(designObjectKind(`${T}x/${CODE}-quote.pdf`, T, CODE, true), null);
  // Plain string ops: a slug with RegExp metacharacters matches only itself.
  assertEquals(designObjectKind(`axb/${CODE}-quote.pdf`, "a.b", CODE, false), null);
  assertEquals(designObjectKind(`a.b/${CODE}-quote.pdf`, "a.b", CODE, false), "quote");
  assertEquals(designObjectKind(`${T}/${CODE}-quote.pdf`, "", CODE, false), null);
  assertEquals(designObjectKind(`${T}/-quote.pdf`, T, "", false), null);
});

Deno.test("designObjectKind: the bucket-root era admits the plan PDF only, and only for a row from that era", () => {
  assertEquals(designObjectKind(`${CODE}.pdf`, T, CODE, true), "plan");
  assertEquals(designObjectKind(`${CODE}-1780000000000.pdf`, T, CODE, true), "plan");
  assertEquals(designObjectKind(`${CODE}.pdf`, T, CODE, false), null);
  for (const tail of ["-quote.pdf", "-estimate.pdf", "-invoice.pdf", "-plan-1780000000000.jpg"]) {
    assertEquals(designObjectKind(`${CODE}${tail}`, T, CODE, true), null, tail);
  }
});

Deno.test("isOwnFloorPlanKey / isOwnDesignImageKey keep their narrow meanings", () => {
  assert(isOwnFloorPlanKey(`${T}/${CODE}-1.pdf`, T, CODE, false));
  assert(!isOwnFloorPlanKey(`${T}/${CODE}-quote.pdf`, T, CODE, false));
  assert(!isOwnFloorPlanKey(`${T}/${CODE}-plan-1.jpg`, T, CODE, false));
  assert(isOwnDesignImageKey(`${T}/${CODE}-plan-1.jpg`, T, CODE));
  assert(isOwnDesignImageKey(`${T}/${CODE}-3d-1.jpg`, T, CODE));
  assert(!isOwnDesignImageKey(`${T}/${CODE}-1.pdf`, T, CODE));
  assert(!isOwnDesignImageKey(`other-sheds/${CODE}-plan-1.jpg`, T, CODE));
  assert(!isOwnDesignImageKey(`${CODE}-plan-1.jpg`, T, CODE));
});

Deno.test("quoteDocumentKeys: derived from the row, and never the invoice", () => {
  assertEquals(quoteDocumentKeys(T, CODE), [`${T}/${CODE}-quote.pdf`, `${T}/${CODE}-estimate.pdf`]);
  for (const key of quoteDocumentKeys(T, CODE)) assert(!key.endsWith("-invoice.pdf"));
});

// ─── invoiceExists ─────────────────────────────────────────────────────────────────────────────
Deno.test("invoiceExists: the one gate, across both invoicing modes", () => {
  assert(invoiceExists("invoiced", null, null));
  assert(invoiceExists("delivered", null, null));
  // A CRM invoice: the ledger's invoice_id, even when the cached status was downgraded.
  assert(invoiceExists("accepted", { invoice_id: "inv-1", status: "sent" }, null));
  assert(invoiceExists("accepted", { invoice_id: "inv-1", status: "failed" }, null));
  // A StructureStudio invoice: no invoice_id, the design still 'accepted' (migration 136).
  assert(invoiceExists("accepted", { invoice_id: null, invoice_number: "SSI-1001", invoice_pdf_url: "u", status: "sent" }, null));
  assert(invoiceExists("accepted", { invoice_id: null, invoice_number: null, invoice_pdf_url: null, status: "created" }, null));
  assert(invoiceExists("accepted", null, "2026-10-01T12:00:00Z"));
  // Nothing was ever made.
  assert(!invoiceExists("accepted", null, null));
  assert(!invoiceExists("sent", undefined, null));
  assert(!invoiceExists("accepted", { invoice_id: null, status: "claimed" }, null));
  assert(!invoiceExists("accepted", { invoice_id: null, status: "failed" }, null));
  assert(!invoiceExists("INVOICED", null, null));
});

Deno.test("crmInvoiceExists: the CRM estimate's 09-02 rule, blind to a StructureStudio invoice", () => {
  assert(crmInvoiceExists("invoiced", null));
  assert(crmInvoiceExists("delivered", null));
  // The ledger's invoice_id, even when the cached status was downgraded.
  assert(crmInvoiceExists("accepted", { invoice_id: "inv-1", status: "sent" }));
  assert(crmInvoiceExists("accepted", { invoice_id: "inv-1", status: "failed" }));
  // A StructureStudio invoice was made from the StructureStudio quote, not the CRM estimate.
  assert(!crmInvoiceExists("accepted", { invoice_id: null, invoice_number: "SSI-1001", invoice_pdf_url: "u", status: "sent" }));
  assert(!crmInvoiceExists("accepted", { invoice_id: null, invoice_number: null, invoice_pdf_url: null, status: "created" }));
  assert(!crmInvoiceExists("accepted", null));
  assert(!crmInvoiceExists("sent", undefined));
  assert(!crmInvoiceExists("INVOICED", null));
});

// ─── planDesignObjectRemoval ───────────────────────────────────────────────────────────────────
const LISTED = [
  `${CODE}.pdf`,
  `${CODE}-1780000000000.pdf`,
  `${CODE}-1790000000000.pdf`,
  `${CODE}-plan-1780000000000.jpg`,
  `${CODE}-3d-1780000000000.jpg`,
  `${CODE}-plan-1790000000000.jpg`,
  `${CODE}-3d-1790000000000.jpg`,
  `${CODE}-quote.pdf`,
  `${CODE}-estimate.pdf`,
  `${CODE}-invoice.pdf`,
  // Storage's search is a case-insensitive name prefix, so these come back too and are not ours.
  `SS-ABC2345-quote.pdf`,
  `SS-ABC2345-plan-1790000000000.jpg`,
  `ss-abc234-quote.pdf`,
  `${CODE}-dc9de4594f3f4b8c.pdf`,
  `${CODE}`,
];
const plan = (o: Partial<Parameters<typeof planDesignObjectRemoval>[0]> = {}) =>
  planDesignObjectRemoval({
    clientId: T, shortCode: CODE, legacyOk: false, invoiced: false,
    storedUrls: [], listed: [], hasQuoteDoc: false, ...o,
  });
const sorted = (a: string[]) => [...a].sort();

Deno.test("plan: not invoiced, everything the design made goes, the invoice and other codes stay", () => {
  const p = plan({ listed: LISTED, hasQuoteDoc: true });
  assertEquals(sorted(p.remove), sorted([
    `${T}/${CODE}.pdf`, `${T}/${CODE}-1780000000000.pdf`, `${T}/${CODE}-1790000000000.pdf`,
    `${T}/${CODE}-plan-1780000000000.jpg`, `${T}/${CODE}-3d-1780000000000.jpg`,
    `${T}/${CODE}-plan-1790000000000.jpg`, `${T}/${CODE}-3d-1790000000000.jpg`,
    `${T}/${CODE}-quote.pdf`, `${T}/${CODE}-estimate.pdf`,
  ]));
  assertEquals(sorted(p.quoteKeys), sorted(quoteDocumentKeys(T, CODE)));
  assertEquals(p.quoteKept, false);
  assertEquals(p.refused, []);
});

Deno.test("plan: invoiced, the quote documents and the invoice stay, the rest still goes", () => {
  const p = plan({ listed: LISTED, invoiced: true, hasQuoteDoc: false });
  assert(!p.remove.includes(`${T}/${CODE}-quote.pdf`));
  assert(!p.remove.includes(`${T}/${CODE}-estimate.pdf`));
  assert(!p.remove.includes(`${T}/${CODE}-invoice.pdf`));
  assert(p.remove.includes(`${T}/${CODE}-plan-1790000000000.jpg`));
  assert(p.remove.includes(`${T}/${CODE}-1790000000000.pdf`));
  assertEquals(p.quoteKeys, []);
  // The listing found a quote document, so it is reported as kept.
  assertEquals(p.quoteKept, true);
});

Deno.test("plan: invoiced with no quote document anywhere reports nothing kept", () => {
  assertEquals(plan({ invoiced: true, listed: [`${CODE}-1790000000000.pdf`] }).quoteKept, false);
  // ss_quote_pdf_url alone is enough to know there is one, when the listing is empty.
  assertEquals(plan({ invoiced: true, hasQuoteDoc: true }).quoteKept, true);
});

Deno.test("plan: the derived quote keys are tried even when the listing returned nothing", () => {
  const p = plan({ listed: [] });
  assertEquals(sorted(p.remove), sorted(quoteDocumentKeys(T, CODE)));
  assertEquals(plan({ listed: [], invoiced: true }).remove, []);
});

Deno.test("plan: stored URLs are tested exactly like listed names", () => {
  const p = plan({
    storedUrls: [
      url(`${T}/${CODE}-1790000000000.pdf`),
      url(`${T}/${CODE}-plan-1790000000000.jpg`),
      url(`${T}/${CODE}-3d-1790000000000.jpg`),
      null, "", undefined,
    ],
  });
  assert(p.remove.includes(`${T}/${CODE}-1790000000000.pdf`));
  assert(p.remove.includes(`${T}/${CODE}-plan-1790000000000.jpg`));
  assert(p.remove.includes(`${T}/${CODE}-3d-1790000000000.jpg`));
  assertEquals(p.refused, []);
});

Deno.test("plan: a stored URL naming another tenant, or another design, is refused and never removed", () => {
  const p = plan({
    storedUrls: [
      url(`other-sheds/${CODE}-1790000000000.pdf`),
      url(`other-sheds/SS-ZZZ999-plan-1.jpg`),
      url(`Not_A.Slug/${CODE}.pdf`),
      url(`${T}/SS-ZZZ999-quote.pdf`),
      "https://elsewhere.example/whatever",
    ],
  });
  assertEquals(sorted(p.remove), sorted(quoteDocumentKeys(T, CODE)));
  assertEquals(p.refused.length, 5);
  assertEquals(sorted(p.namespaces), ["(non-slug)", "other-sheds"]);
});

Deno.test("plan: a stored URL to this design's own invoice is neither removed nor reported as planted", () => {
  const p = plan({ storedUrls: [url(`${T}/${CODE}-invoice.pdf`)] });
  assert(!p.remove.includes(`${T}/${CODE}-invoice.pdf`));
  assertEquals(p.refused, []);
});

Deno.test("plan: a stored quote URL follows the invoice gate too", () => {
  const p = plan({ invoiced: true, storedUrls: [url(`${T}/${CODE}-quote.pdf`)] });
  assertEquals(p.remove, []);
  assertEquals(p.quoteKept, true);
});

Deno.test("plan: legacy root objects come only from stored URLs of a row from that era", () => {
  assert(plan({ legacyOk: true, storedUrls: [url(`${CODE}.pdf`)] }).remove.includes(`${CODE}.pdf`));
  const young = plan({ legacyOk: false, storedUrls: [url(`${CODE}.pdf`)] });
  assert(!young.remove.includes(`${CODE}.pdf`));
  assertEquals(young.refused.length, 1);
  // A listed name is always under the tenant folder; a "/" in one is not something we act on.
  assertEquals(sorted(plan({ listed: [`x/${CODE}-plan-1.jpg`, `../${CODE}-plan-1.jpg`] }).remove), sorted(quoteDocumentKeys(T, CODE)));
});

Deno.test("plan: <code>-invoice.pdf is never planned, in any state, from any source", () => {
  const invoiceKey = `${T}/${CODE}-invoice.pdf`;
  for (const invoiced of [false, true]) {
    for (const legacyOk of [false, true]) {
      for (const hasQuoteDoc of [false, true]) {
        const p = plan({
          invoiced, legacyOk, hasQuoteDoc, listed: LISTED,
          storedUrls: [url(invoiceKey), url(`${CODE}-invoice.pdf`), url(`${T}/${CODE}-quote.pdf`)],
        });
        for (const key of p.remove) assert(!key.endsWith("-invoice.pdf"), `${key} (invoiced=${invoiced})`);
      }
    }
  }
});

Deno.test("plan: duplicates collapse", () => {
  const p = plan({ listed: [`${CODE}-quote.pdf`, `${CODE}-quote.pdf`], storedUrls: [url(`${T}/${CODE}-quote.pdf`)] });
  assertEquals(p.remove.filter((k) => k === `${T}/${CODE}-quote.pdf`).length, 1);
});

// ─── removeDesignObjects ───────────────────────────────────────────────────────────────────────
type Call = { op: "list" | "remove"; bucket: string; args: unknown[] };
function fakeStorage(o: {
  objects: string[];
  listError?: boolean;
  listThrows?: boolean;
  removeError?: boolean;
  removeThrows?: boolean;
}): { storage: FloorPlanStorage; calls: Call[]; objects: Set<string> } {
  const objects = new Set(o.objects);
  const calls: Call[] = [];
  const storage: FloorPlanStorage = {
    from(bucket: string) {
      return {
        list(path?: string, options?: { limit?: number; search?: string }) {
          calls.push({ op: "list", bucket, args: [path, options] });
          if (o.listThrows) throw new TypeError("network down");
          if (o.listError) return Promise.resolve({ data: null, error: { message: "list failed" } });
          // Storage's own semantics: prefix + search as a case-insensitive name prefix, one level.
          const prefix = `${path}/`;
          const want = (prefix + (options?.search ?? "")).toLowerCase();
          const names = [...objects]
            .filter((k) => k.toLowerCase().startsWith(want) && !k.slice(prefix.length).includes("/"))
            .map((k) => k.slice(prefix.length))
            .sort()
            .slice(0, options?.limit ?? 100);
          return Promise.resolve({ data: names.map((name) => ({ name })), error: null });
        },
        remove(paths: string[]) {
          calls.push({ op: "remove", bucket, args: [paths] });
          if (o.removeThrows) throw new TypeError("network down");
          if (o.removeError) return Promise.resolve({ data: null, error: { message: "remove failed" } });
          const gone = paths.filter((k) => objects.delete(k));
          return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
        },
      };
    },
  };
  return { storage, calls, objects };
}

const BUCKET = [
  ...LISTED.filter((n) => n !== CODE).map((n) => `${T}/${n}`),
  `other-sheds/${CODE}-quote.pdf`,
  `other-sheds/${CODE}-plan-1790000000000.jpg`,
  `${T}/SS-QQQ777-quote.pdf`,
];
const INPUT = { clientId: T, shortCode: CODE, legacyOk: false, invoiced: false, storedUrls: [] as unknown[], hasQuoteDoc: true };

Deno.test("removeDesignObjects: lists the tenant folder by code, removes what the plan says, reports it", async () => {
  const f = fakeStorage({ objects: BUCKET });
  const out = await removeDesignObjects(f.storage, INPUT);
  assertEquals(f.calls[0].op, "list");
  assertEquals(f.calls[0].bucket, FLOOR_PLANS);
  assertEquals(f.calls[0].args[0], T);
  assertEquals((f.calls[0].args[1] as { search: string }).search, CODE);
  assertEquals(out.quote, "removed");
  assertEquals(out.listFailed, false);
  assertEquals(out.filesRemoved, 9);
  // What is left: the invoice, the longer and lower-case codes' files, the stray shape, other tenants.
  assertEquals(sorted([...f.objects]), sorted([
    `${T}/${CODE}-invoice.pdf`,
    `${T}/SS-ABC2345-quote.pdf`, `${T}/SS-ABC2345-plan-1790000000000.jpg`, `${T}/ss-abc234-quote.pdf`,
    `${T}/${CODE}-dc9de4594f3f4b8c.pdf`,
    `other-sheds/${CODE}-quote.pdf`, `other-sheds/${CODE}-plan-1790000000000.jpg`,
    `${T}/SS-QQQ777-quote.pdf`,
  ]));
});

Deno.test("removeDesignObjects: invoiced keeps the quote documents and says so", async () => {
  const f = fakeStorage({ objects: BUCKET });
  const out = await removeDesignObjects(f.storage, { ...INPUT, invoiced: true });
  assertEquals(out.quote, "kept");
  assert(f.objects.has(`${T}/${CODE}-quote.pdf`));
  assert(f.objects.has(`${T}/${CODE}-estimate.pdf`));
  assert(f.objects.has(`${T}/${CODE}-invoice.pdf`));
  assert(!f.objects.has(`${T}/${CODE}-plan-1780000000000.jpg`));
  assertEquals(out.filesRemoved, 7);
});

Deno.test("removeDesignObjects: no quote document at all reads none, not removed", async () => {
  const f = fakeStorage({ objects: [`${T}/${CODE}-1790000000000.pdf`] });
  const out = await removeDesignObjects(f.storage, { ...INPUT, hasQuoteDoc: false });
  assertEquals(out.quote, "none");
  assertEquals(out.filesRemoved, 1);
});

for (const how of ["listError", "listThrows"] as const) {
  Deno.test(`removeDesignObjects: a failed listing (${how}) still removes the stored and derived keys`, async () => {
    const f = fakeStorage({ objects: BUCKET, [how]: true });
    const out = await removeDesignObjects(f.storage, {
      ...INPUT, storedUrls: [url(`${T}/${CODE}-1790000000000.pdf`), url(`${T}/${CODE}-plan-1790000000000.jpg`)],
    });
    assertEquals(out.listFailed, true);
    assertEquals(out.quote, "removed");
    assert(!f.objects.has(`${T}/${CODE}-quote.pdf`));
    assert(!f.objects.has(`${T}/${CODE}-estimate.pdf`));
    assert(!f.objects.has(`${T}/${CODE}-1790000000000.pdf`));
    assert(!f.objects.has(`${T}/${CODE}-plan-1790000000000.jpg`));
    // The older pair had no pointer, so without the listing it stays.
    assert(f.objects.has(`${T}/${CODE}-plan-1780000000000.jpg`));
    assert(f.objects.has(`${T}/${CODE}-invoice.pdf`));
  });
}

for (const how of ["removeError", "removeThrows"] as const) {
  Deno.test(`removeDesignObjects: a failed remove (${how}) says so, removes nothing and does not throw`, async () => {
    const f = fakeStorage({ objects: BUCKET, [how]: true });
    const out = await removeDesignObjects(f.storage, INPUT);
    assertEquals(out.filesRemoved, 0);
    // Not "none": the quote PDF is still there, and "none" would read as "there never was one".
    assertEquals(out.quote, "failed");
    assertEquals(out.removeFailed, true);
    assert(out.planned > 0, String(out.planned));
    assertEquals(f.objects.size, BUCKET.length);
  });
}

Deno.test("removeDesignObjects: a failed remove with a failed listing cannot rule a quote out, so it is failed", async () => {
  const f = fakeStorage({ objects: BUCKET, listError: true, removeError: true });
  const out = await removeDesignObjects(f.storage, { ...INPUT, hasQuoteDoc: false });
  assertEquals(out.quote, "failed");
  assertEquals(out.listFailed, true);
});

Deno.test("removeDesignObjects: a failed remove where the listing showed no quote document reads none", async () => {
  const f = fakeStorage({ objects: [`${T}/${CODE}-1790000000000.pdf`], removeError: true });
  const out = await removeDesignObjects(f.storage, { ...INPUT, hasQuoteDoc: false });
  assertEquals(out.quote, "none");
  assertEquals(out.removeFailed, true);
});

Deno.test("removeDesignObjects: a remove that works reports removeFailed false and how many keys it sent", async () => {
  const f = fakeStorage({ objects: BUCKET });
  const out = await removeDesignObjects(f.storage, INPUT);
  assertEquals(out.removeFailed, false);
  const sent = f.calls.filter((c) => c.op === "remove").flatMap((c) => c.args[0] as string[]);
  assertEquals(out.planned, sent.length);
});

Deno.test("removeDesignObjects: the remove call never names an invoice or another tenant", async () => {
  const f = fakeStorage({ objects: BUCKET });
  await removeDesignObjects(f.storage, {
    ...INPUT, storedUrls: [url(`other-sheds/${CODE}-quote.pdf`), url(`${T}/${CODE}-invoice.pdf`)],
  });
  const removed = f.calls.filter((c) => c.op === "remove").flatMap((c) => c.args[0] as string[]);
  assert(removed.length > 0);
  for (const key of removed) {
    assert(key.startsWith(`${T}/${CODE}`), key);
    assert(!key.endsWith("-invoice.pdf"), key);
  }
});
