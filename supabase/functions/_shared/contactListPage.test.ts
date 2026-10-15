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
  CONTACT_COMPANY_CHUNK,
  CONTACT_COMPANY_COLS,
  CONTACT_COMPANY_LANES,
  CONTACT_COMPANY_MAX_IDS,
  CONTACT_LIST_COLS,
  CONTACT_LIST_MAX_FROM,
  CONTACT_LIST_PAGE,
  contactIdsNeedingCompany,
  parseContactsFrom,
  readContactCompanies,
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

type Query = Array<[string, unknown[]]>;

// A client whose every query answers `answer(that query's calls)` a tick later, like the network,
// counting how many are in flight at once (the company read's lanes).
function fakeIdAdmin(answer: (q: Query) => { data?: unknown; error?: unknown }) {
  const calls: Query[] = [];
  let inFlight = 0;
  let most = 0;
  const admin = {
    from: (t: string) => {
      const q: Query = [["from", [t]]];
      calls.push(q);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "in", "order", "range"]) {
        builder[m] = (...args: unknown[]) => { q.push([m, args]); return builder; };
      }
      builder.then = (resolve: (v: unknown) => void) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          const r = answer(q);
          resolve({ data: r.data ?? null, error: r.error ?? null });
        }, 1);
      };
      return builder;
    },
  };
  return { admin, calls, most: () => most };
}
// The ids a query asked for (its `.in("id", ids)`; none when it has no such filter).
const idsOf = (q: Query) => ((q.find(([m]) => m === "in")?.[1][1] ?? []) as string[]);
// crm_contacts as far as the company read goes: the asked-for rows that have a company (the query
// itself filters out a null one).
const answering = (companies: Record<string, string | null>) => (q: Query) => ({
  data: idsOf(q).filter((id) => companies[id] != null).map((id) => ({ id, company: companies[id] })),
});
const many = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

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
  const rows = [{ id: "c2", name: "Acme Sheds lead", company: "Example Barn Co.", phone: null, email: "lead@example.test", source: "ghl_import", first_seen_at: "2026-09-01T00:00:00Z", created_at: "2026-10-06T00:00:00Z" }];
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

Deno.test("a contact-only row reads its company", () => {
  // Carolyn, 2026-10-14: a lead she entered with a company was listed under the person's name alone.
  assert(CONTACT_LIST_COLS.split(",").map((c) => c.trim()).includes("company"), CONTACT_LIST_COLS);
});

Deno.test("contactIdsNeedingCompany: the linked contacts the page does not hold, once each, in row order", () => {
  // Designs' contact ids then visits', newest first; p1 and p2 are on the page, so their own rows
  // carry their companies. A row with no contact id (or a junk one) has no company to read.
  const linked = ["d1", null, "p1", "d1", "", 42, "l1", "p2", undefined, "d2"];
  assertEquals(contactIdsNeedingCompany(linked, new Set(["p1", "p2"])), ["d1", "l1", "d2"]);
  assertEquals(contactIdsNeedingCompany([], new Set()), []);
  // Every linked contact on the page (any tenant under one page of contacts): nothing to read.
  assertEquals(contactIdsNeedingCompany(["p1", "p2", "p1"], new Set(["p1", "p2"])), []);
});

Deno.test("contactIdsNeedingCompany: at most CONTACT_COMPANY_MAX_IDS, the newest rows' first", () => {
  const ids = many(CONTACT_COMPANY_MAX_IDS + 50);
  const out = contactIdsNeedingCompany(ids, new Set(["c0"]));
  assertEquals(out.length, CONTACT_COMPANY_MAX_IDS);
  assertEquals(out[0], "c1");
  assertEquals(out[out.length - 1], `c${CONTACT_COMPANY_MAX_IDS}`);
});

Deno.test("readContactCompanies: no ids, no read", async () => {
  const { admin, calls } = fakeIdAdmin(() => ({ data: [] }));
  assertEquals(await readContactCompanies(admin, "acme-sheds", []), []);
  assertEquals(calls.length, 0);
});

Deno.test("readContactCompanies: id and company of THOSE contacts only, live, of ONE tenant", async () => {
  const { admin, calls } = fakeIdAdmin(answering({
    c1: "Example Barn Co.", c2: "  Sample Shed Works  ", c3: "   ", c4: null,
  }));
  const out = await readContactCompanies(admin, "acme-sheds", ["c1", "c2", "c3", "c4"]);
  // A company of only spaces is no company.
  assertEquals(out, [{ id: "c1", company: "Example Barn Co." }, { id: "c2", company: "Sample Shed Works" }]);
  assertEquals(calls, [[
    ["from", ["crm_contacts"]],
    ["select", [CONTACT_COMPANY_COLS]],
    // The tenant guard. This read runs as the service role, which RLS does not narrow.
    ["eq", ["client_id", "acme-sheds"]],
    // A tombstone's company is the one it had when it was merged: the survivor's is the one to show.
    ["is", ["merged_into", null]],
    ["not", ["company", "is", null]],
    // The ids asked for, and nothing else: never every contact that has a company.
    ["in", ["id", ["c1", "c2", "c3", "c4"]]],
  ]]);
  assertEquals(CONTACT_COMPANY_COLS, "id, company");
});

Deno.test("readContactCompanies: an imported call list does not make it read the whole table", async () => {
  // 3,000 imported prospects, every one with a company (Pipelines' Import CSV), and two designs
  // whose contacts are not on the page: the read asks for those two, in one request.
  const companies: Record<string, string> = Object.fromEntries(many(3000, "imp").map((id) => [id, `Prospect ${id}`]));
  companies.d1 = "Example Barn Co.";
  const { admin, calls } = fakeIdAdmin(answering(companies));
  const out = await readContactCompanies(admin, "acme-sheds", ["d1", "d2"]);
  assertEquals(out, [{ id: "d1", company: "Example Barn Co." }]);
  assertEquals(calls.length, 1);
});

Deno.test("readContactCompanies: CONTACT_COMPANY_CHUNK ids a request, CONTACT_COMPANY_LANES at once", async () => {
  const ids = many(CONTACT_COMPANY_CHUNK * 9 + 7);
  const { admin, calls, most } = fakeIdAdmin(answering(Object.fromEntries(ids.map((id) => [id, `Barn ${id}`]))));
  const out = await readContactCompanies(admin, "acme-sheds", ids);
  assertEquals(calls.length, 10);
  assert(calls.every((q) => idsOf(q).length <= CONTACT_COMPANY_CHUNK), "a request carried more ids than a chunk");
  assertEquals(calls.flatMap(idsOf).sort(), [...ids].sort());
  assertEquals(out.length, ids.length);
  assertEquals(most(), CONTACT_COMPANY_LANES);
  // The ids ride in the URL: a chunk of uuids (36 characters and a comma) stays far under what a
  // proxy refuses.
  assert(CONTACT_COMPANY_CHUNK * 37 < 8000);
});

Deno.test("readContactCompanies: never more than CONTACT_COMPANY_MAX_IDS ids, however many it is handed", async () => {
  const ids = many(CONTACT_COMPANY_MAX_IDS + 300);
  const { admin, calls } = fakeIdAdmin(() => ({ data: [] }));
  await readContactCompanies(admin, "acme-sheds", ids);
  assertEquals(calls.flatMap(idsOf), ids.slice(0, CONTACT_COMPANY_MAX_IDS));
});

Deno.test("readContactCompanies: a database error is thrown, and no further chunk is started", async () => {
  const ids = many(CONTACT_COMPANY_CHUNK * 20);
  const { admin, calls } = fakeIdAdmin(() => ({ error: { message: "permission denied" } }));
  await assertRejects(() => readContactCompanies(admin, "acme-sheds", ids));
  assertEquals(calls.length, CONTACT_COMPANY_LANES);
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
  // The companies a design's or a visit's row shows: read the same way on both paths, or a row
  // would carry a company in the builder's list and none in the operator's.
  const companyCols = /const SS_CONTACT_COMPANY_COLS = "([^"]+)";/.exec(src);
  assert(companyCols, "02-sales.jsx: SS_CONTACT_COMPANY_COLS not found; re-anchor this test");
  assertEquals(companyCols[1], CONTACT_COMPANY_COLS);
  // And the same chunk, lanes and bound, so the two paths give companies to the same rows.
  const nums: Array<[string, number]> = [
    ["CHUNK", CONTACT_COMPANY_CHUNK], ["LANES", CONTACT_COMPANY_LANES], ["MAX_IDS", CONTACT_COMPANY_MAX_IDS],
  ];
  for (const [name, want] of nums) {
    const m = new RegExp(`const SS_CONTACT_COMPANY_${name} = (\\d+);`).exec(src);
    assert(m, `02-sales.jsx: SS_CONTACT_COMPANY_${name} not found; re-anchor this test`);
    assertEquals(Number(m[1]), want, `SS_CONTACT_COMPANY_${name}`);
  }
});

// The browser's copies of contactIdsNeedingCompany and readContactCompanies, lifted out of
// 02-sales.jsx and run here: the two paths are proved to pick the same contacts and to read them
// the same way, not only to share constants.
async function liftSales() {
  const src = (await Deno.readTextFile(new URL("../../../portal/02-sales.jsx", import.meta.url))).replace(/\r\n/g, "\n");
  const block = (name: string) => {
    const m = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}$`, "m").exec(src);
    assert(m, `02-sales.jsx: ${name} not found; re-anchor this test`);
    return m[0];
  };
  const pick = new Function(
    "SS_CONTACT_COMPANY_MAX_IDS",
    `${block("ssContactIdsNeedingCompany")}\nreturn ssContactIdsNeedingCompany;`,
  )(CONTACT_COMPANY_MAX_IDS);
  const read = (sb: unknown) => new Function(
    "sb", "SS_CONTACT_COMPANY_COLS", "SS_CONTACT_COMPANY_CHUNK", "SS_CONTACT_COMPANY_LANES",
    `${block("ssReadContactCompanies")}\nreturn ssReadContactCompanies;`,
  )(sb, CONTACT_COMPANY_COLS, CONTACT_COMPANY_CHUNK, CONTACT_COMPANY_LANES);
  return { pick, read };
}

Deno.test("portal/02-sales.jsx picks the same contacts, in the same order, to the same bound", async () => {
  const { pick } = await liftSales();
  const cases: Array<[unknown[], Set<string>]> = [
    [["d1", null, "p1", "d1", "", 42, "l1", "p2", undefined, "d2"], new Set(["p1", "p2"])],
    [["p1", "p2"], new Set(["p1", "p2"])],
    [many(CONTACT_COMPANY_MAX_IDS + 50), new Set(["c0", "c7"])],
  ];
  for (const [linked, have] of cases) assertEquals(pick(linked, have), contactIdsNeedingCompany(linked, have));
});

Deno.test("portal/02-sales.jsx reads the companies with the same query, chunks and lanes", async () => {
  const { read } = await liftSales();
  const ids = many(CONTACT_COMPANY_CHUNK * 3 + 5);
  const companies = Object.fromEntries(ids.filter((_, i) => i % 3 === 0).map((id) => [id, ` Barn ${id} `]));
  const server = fakeIdAdmin(answering(companies));
  const browser = fakeIdAdmin(answering(companies));
  const fromServer = await readContactCompanies(server.admin, "acme-sheds", ids);
  const fromBrowser: Map<string, string> = await read(browser.admin)("acme-sheds", ids);
  // Call for call: the builder's own read runs under RLS with their token and keeps client_id as
  // the same guard the service-role read needs.
  assertEquals(browser.calls, server.calls);
  assertEquals(browser.most(), server.most());
  // Every id asked is answered ("" for none), so the answer outranks what the last paint showed.
  assertEquals(fromBrowser.size, ids.length);
  assertEquals([...fromBrowser].filter(([, c]) => c), fromServer.map((c) => [c.id, c.company]));
  // A failed chunk fails the read (the list keeps what it showed), and starts no further chunk.
  const failing = fakeIdAdmin(() => ({ error: { message: "permission denied" } }));
  await assertRejects(() => read(failing.admin)("acme-sheds", many(CONTACT_COMPANY_CHUNK * 20)));
  assertEquals(failing.calls.length, CONTACT_COMPANY_LANES);
});
