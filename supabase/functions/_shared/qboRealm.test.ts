// Which QuickBooks company a mapping or a pushed invoice belongs to (qboRealm.ts, migration 265).
//
// The rule these pin: a mapping only counts against the company it was picked from, and nothing
// that cannot say which company it came from counts at all. The direction matters more than the
// detail. A row kept by mistake bills a line as whatever shares that item id in another company's
// books; a row dropped by mistake stops the push with "unmapped … then Retry". Every ambiguous
// case here therefore lands on dropped.
//
// The handlers that use these (the push, the callback's wipe, save/list/status/retry) are driven
// end to end in _test_stubs/qboRealmWiring_test.ts.
//
// Dependency-free like the other _shared tests.

import { companyTagOf, mapRowsForRealm, pushedToOtherCompany } from "./qboRealm.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function same(got: unknown, want: unknown, msg: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg}: expected ${w}, got ${g}`);
}

// Made-up company ids, in Intuit's shape (long digit strings). The repo is public.
const BOOKS_A = "4000000000000000001";
const BOOKS_B = "4000000000000000002";

const ROWS = [
  { id: "a1", line_kind: "building", realm_id: BOOKS_A },
  { id: "a2", line_kind: "fallback", realm_id: BOOKS_A },
  { id: "b1", line_kind: "building", realm_id: BOOKS_B },
  { id: "n1", line_kind: "door", realm_id: null },
  { id: "u1", line_kind: "window" },                 // the column absent altogether
  { id: "e1", line_kind: "ramp", realm_id: "" },
];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

Deno.test("mapRowsForRealm keeps exactly the connected company's rows", () => {
  same(ids(mapRowsForRealm(ROWS, BOOKS_A)), ["a1", "a2"], "company A");
  same(ids(mapRowsForRealm(ROWS, BOOKS_B)), ["b1"], "company B");
});

Deno.test("mapRowsForRealm: a row nobody stamped belongs to no company", () => {
  // null, missing and "" are all "unknown", and unknown is never a match, whatever is connected.
  for (const realm of [BOOKS_A, BOOKS_B]) {
    const kept = ids(mapRowsForRealm(ROWS, realm));
    for (const id of ["n1", "u1", "e1"]) assert(!kept.includes(id), `${id} was kept for ${realm}`);
  }
});

Deno.test("mapRowsForRealm: no company on file means no mappings, never all of them", () => {
  for (const realm of [null, undefined, ""]) {
    same(mapRowsForRealm(ROWS, realm), [], `realm ${JSON.stringify(realm)}`);
  }
  // A non-string from a loosely typed read must not slip through as "no filter".
  same(mapRowsForRealm(ROWS, 4000000000000000001 as unknown as string), [], "a numeric realm");
});

Deno.test("mapRowsForRealm: exact match only, and an empty or missing list is fine", () => {
  same(mapRowsForRealm([{ id: "s", realm_id: ` ${BOOKS_A}` }], BOOKS_A), [], "no trimming");
  same(mapRowsForRealm([{ id: "p", realm_id: BOOKS_A.slice(0, -1) }], BOOKS_A), [], "no prefix match");
  same(mapRowsForRealm(null, BOOKS_A), [], "null rows");
  same(mapRowsForRealm(undefined, BOOKS_A), [], "undefined rows");
  same(mapRowsForRealm([], BOOKS_A), [], "no rows");
  // A hole in a loosely typed array is skipped rather than throwing.
  same(ids(mapRowsForRealm([null as unknown as { id: string; realm_id: string }, { id: "x", realm_id: BOOKS_A }], BOOKS_A)), ["x"], "a null entry");
});

Deno.test("mapRowsForRealm returns the rows as they were, untouched", () => {
  const kept = mapRowsForRealm(ROWS, BOOKS_A);
  assert(kept[0] === ROWS[0], "the same objects come back, so callers can strip fields afterwards");
  same(ROWS.length, 6, "the input array is not modified");
});

Deno.test("pushedToOtherCompany only when both companies are known and differ", () => {
  assert(pushedToOtherCompany(BOOKS_A, BOOKS_B), "A then B");
  assert(!pushedToOtherCompany(BOOKS_A, BOOKS_A), "same company");
  // Unknown on either side keeps the old answer ("already in QuickBooks").
  for (const [inv, cur] of [[null, BOOKS_A], [undefined, BOOKS_A], ["", BOOKS_A], [BOOKS_A, null], [BOOKS_A, undefined], [BOOKS_A, ""], [null, null]] as const) {
    assert(!pushedToOtherCompany(inv, cur), `invoice ${JSON.stringify(inv)} vs current ${JSON.stringify(cur)}`);
  }
});

Deno.test("companyTagOf: one short tag per company, never the realm id itself", async () => {
  const a = await companyTagOf(BOOKS_A);
  const b = await companyTagOf(BOOKS_B);
  assert(typeof a === "string" && /^[0-9a-f]{12}$/.test(a), `tag shape: ${a}`);
  same(await companyTagOf(BOOKS_A), a, "the same company gives the same tag");
  assert(a !== b, "two companies share a tag");
  assert(!BOOKS_A.includes(String(a)) && !String(a).includes(BOOKS_A.slice(-4)), "the tag carries the realm id");
  // SHA-256("4000000000000000001"), first six bytes: pinned so the tag cannot drift between the
  // grid's load and its save across a deploy.
  same(a, "ff8308bd2cf8", "the tag is SHA-256's first six bytes");
});

Deno.test("companyTagOf: no company is null, and null only matches null", async () => {
  for (const realm of [null, undefined, ""]) same(await companyTagOf(realm), null, `realm ${JSON.stringify(realm)}`);
  assert((await companyTagOf(BOOKS_A)) !== null, "a company gave no tag");
});
