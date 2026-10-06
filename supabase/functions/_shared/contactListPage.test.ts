/**
 * Unit tests for _shared/contactListPage.ts: the page of contacts an operator's view-as reads
 * through operator-portal's get_portal, and the drift check against the builder's own read in
 * portal/02-sales.jsx (the browser cannot import the module, so the two are kept equal here).
 *
 * Run: deno test --allow-read supabase/functions/_shared/contactListPage.test.ts
 * (the pre-push gate runs this for you; the read is for the 02-sales.jsx drift check.)
 */
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  CONTACT_LIST_COLS,
  CONTACT_LIST_MAX_FROM,
  CONTACT_LIST_PAGE,
  parseContactsFrom,
  readContactListPage,
} from "./contactListPage.ts";

// A PostgREST query builder that records every call made on it and answers `result` when awaited.
function fakeAdmin(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "range"]) {
    builder[m] = (...args: unknown[]) => { calls.push([m, args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
  const admin = { from: (t: string) => { calls.push(["from", [t]]); return builder; } };
  return { admin, calls };
}

Deno.test("parseContactsFrom: absent is the first page", () => {
  assertEquals(parseContactsFrom(undefined), 0);
  assertEquals(parseContactsFrom(null), 0);
  assertEquals(parseContactsFrom(0), 0);
  assertEquals(parseContactsFrom(500), 500);
  assertEquals(parseContactsFrom(CONTACT_LIST_MAX_FROM), CONTACT_LIST_MAX_FROM);
});

Deno.test("parseContactsFrom: a malformed offset is refused, never read as the first page", () => {
  // Read as 0, a broken "Show more" would answer page one again on every press and the list would
  // look complete while it was not.
  for (const bad of [-1, 1.5, "500", NaN, Infinity, CONTACT_LIST_MAX_FROM + 1, {}, [], true]) {
    assertThrows(() => parseContactsFrom(bad), Error, "Invalid contactsFrom.", `accepted ${String(bad)}`);
  }
});

Deno.test("readContactListPage: live contacts of ONE tenant, newest first, one bounded page with a total", async () => {
  const rows = [{ id: "c2", name: "Acme Sheds lead", phone: null, email: "lead@example.test", source: "ghl_import", first_seen_at: "2026-09-01T00:00:00Z", created_at: "2026-10-06T00:00:00Z" }];
  const { admin, calls } = fakeAdmin({ data: rows, count: 1234 });
  const out = await readContactListPage(admin, "acme-sheds", 500);
  assertEquals(out, { rows, total: 1234 });
  assertEquals(calls, [
    ["from", ["crm_contacts"]],
    ["select", [CONTACT_LIST_COLS, { count: "exact" }]],
    // The tenant guard. This read runs as the service role, which RLS does not narrow.
    ["eq", ["client_id", "acme-sheds"]],
    // A merged contact is a tombstone: its designs and notes moved to the survivor (192).
    ["is", ["merged_into", null]],
    ["order", ["first_seen_at", { ascending: false }]],
    ["order", ["id", { ascending: false }]],
    ["range", [500, 500 + CONTACT_LIST_PAGE - 1]],
  ]);
});

Deno.test("readContactListPage: no count means the rows in hand are the total, never more", async () => {
  const rows = [{ id: "c1" }, { id: "c2" }];
  const { admin } = fakeAdmin({ data: rows, count: null });
  assertEquals((await readContactListPage(admin, "acme-sheds", 1000)).total, 1002);
  const empty = fakeAdmin({ data: null, count: null });
  assertEquals(await readContactListPage(empty.admin, "acme-sheds", 0), { rows: [], total: 0 });
});

Deno.test("readContactListPage: a database error is thrown, not answered as an empty page", async () => {
  const { admin } = fakeAdmin({ error: { message: "permission denied" } });
  await assertRejects(() => readContactListPage(admin, "acme-sheds", 0));
});

Deno.test("readContactListPage: an offset past the end (PGRST103) is the end of the list, not an error", async () => {
  // Merges between two pages can pull the total under the next offset, and PostgREST answers 416.
  // Thrown, every later "Show more" would fail the same way; answered empty, the list ends.
  const { admin } = fakeAdmin({ error: { code: "PGRST103", message: "Requested range not satisfiable" } });
  assertEquals(await readContactListPage(admin, "acme-sheds", 1000), { rows: [], total: 1000 });
});

Deno.test("the page stays under PostgREST's 1000-row cap", () => {
  // At the cap a page can come back short without saying so, and "short" is what ends a scan.
  assert(CONTACT_LIST_PAGE > 0 && CONTACT_LIST_PAGE < 1000);
});

Deno.test("portal/02-sales.jsx reads the same page and the same columns", async () => {
  // A builder's own portal reads this page from PostgREST itself; view-as reads it here. If the
  // two drift, a contact shows one way in a builder's list and another in the operator's.
  const src = await Deno.readTextFile(new URL("../../../portal/02-sales.jsx", import.meta.url));
  const page = /const SS_CONTACT_LIST_PAGE = (\d+);/.exec(src);
  const cols = /const SS_CONTACT_LIST_COLS = "([^"]+)";/.exec(src);
  assert(page, "02-sales.jsx: SS_CONTACT_LIST_PAGE not found; re-anchor this test");
  assert(cols, "02-sales.jsx: SS_CONTACT_LIST_COLS not found; re-anchor this test");
  assertEquals(Number(page[1]), CONTACT_LIST_PAGE);
  assertEquals(cols[1], CONTACT_LIST_COLS);
});
