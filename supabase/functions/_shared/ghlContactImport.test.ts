// Unit tests for _shared/ghlContactImport.ts, the GoHighLevel side of the contact import
// (migration 282, portal-settings crm_import_ghl_contacts).
//
// Deliberately dependency-free (no jsr:/npm: imports), like every _shared test. GoHighLevel is the
// fake in _test_stubs/ghlFake.ts, which answers POST /contacts/search and THROWS on any other URL or
// method, so a write to GoHighLevel, or any second endpoint, fails a test here instead of being
// answered by accident. The database is a recording stand-in for public.crm_import_ghl_contacts
// (tests/sql/migration282.test.cjs drives the real one). Nothing reaches the network.
//
// What is pinned:
//   1. Reading a contact: the name (capitalised when GoHighLevel only has it lowercased), phone,
//      email, tags, date and do-not-disturb (carried on the row as sms_dnd), and the shapes that are
//      dropped.
//   2. The request: a dry run unless dryRun is the boolean false; the cursor round-trips with its
//      mode, a bad one is refused, and a real run refuses a dry run's cursor.
//   3. The walk: 100 a page, page 1 first, then searchAfter (or page numbers when GoHighLevel sends
//      none), to the short page that ends it, every page into the database exactly once, in order.
//   4. Rate limits: Retry-After honoured, 1 s / 2 s / 4 s otherwise, four tries, then a stop that
//      carries on from the page that did not land, with nothing skipped or doubled.
//   5. A refused key or request stops at once; a failed database page leaves the totals as they were.
//   6. Time: no new page after the soft deadline; the first page on an old worker; a back-off that
//      would cross the hard deadline is not waited out.
//   7. Counts only: the answer carries no name, number, address or tag.
//
// Run: deno test --allow-env --allow-read supabase/functions/_shared/ghlContactImport.test.ts
// (the pre-push gate runs this for you, see scripts/preflight.mjs)
//
// People, numbers and ids are made up (555-01xx numbers, example domains). The repo is public.

import {
  BAD_CURSOR_SENTENCE, capitaliseLowercaseName, cleanTags, decodeCursor, DRY_RUN_CURSOR_SENTENCE, encodeCursor, GHL_API_VERSION,
  GHL_TRIES_PER_PAGE, IMPORT_FIRST_PAGE_MS, IMPORT_PAGE_SIZE, importDeadlines, type ImportRow, importSummary, type PageCounts,
  parseGhlContact, parseImportRequest, retryWaitMs, runGhlContactImport,
} from "./ghlContactImport.ts";
import { type FakeContact, ghlFake, type GhlWorld } from "./_test_stubs/ghlFake.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

const LOC = "loc-test";
const KEY = "test-key";

/** A location with contacts and nothing else (the fake's estimate and opportunity lists stay empty). */
type ContactWorld = Omit<GhlWorld, "estimates" | "opportunities">;
const fakeCrm = (w: ContactWorld) => ghlFake({ estimates: [], opportunities: [], ...w });

/** n contacts, each with a distinct phone and email, a tag and a date. */
function people(n: number, from = 0): FakeContact[] {
  return Array.from({ length: n }, (_v, i) => {
    const k = from + i;
    return {
      id: `c-${String(k).padStart(5, "0")}`,
      firstName: "Person", lastName: `Number${k}`,
      phone: `+1555${String(1000000 + k).slice(-7)}`,
      email: `person${k}@example.com`,
      tags: ["lead", `batch ${Math.floor(k / 100)}`],
      dateAdded: "2024-05-06T07:08:09.000Z",
    };
  });
}

/** The database stand-in: records every page and answers "all new", every do-not-disturb row with a
 *  phone opted out. */
function db(opts: { failOn?: number } = {}) {
  const calls: { rows: ImportRow[]; dryRun: boolean }[] = [];
  const importPage = (rows: ImportRow[], dryRun: boolean): Promise<PageCounts> => {
    calls.push({ rows, dryRun });
    if (opts.failOn !== undefined && calls.length - 1 === opts.failOn) return Promise.reject(Object.assign(new Error("boom"), { code: "XX000" }));
    return Promise.resolve({
      created: rows.length, matched: 0, noIdentity: 0, conflicts: 0, labelled: rows.length,
      optedOut: rows.filter((r) => r.sms_dnd && r.phone).length, split: 0,
    });
  };
  return { calls, importPage };
}

/** The position inside a cursor the import answered (its mode aside). */
const at = (cursor: string | null) => (cursor ? decodeCursor(cursor)?.cursor : undefined);

/** A clock that only moves when told to (and when the import sleeps). */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: (ms: number) => { sleeps.push(ms); t += ms; return Promise.resolve(); },
    sleeps,
  };
}

async function run(world: ContactWorld, o: { dryRun?: boolean; cursor?: string | null; failOn?: number; softIn?: number; hardIn?: number; tick?: number } = {}) {
  const fake = fakeCrm(world);
  const store = db({ failOn: o.failOn });
  const c = clock();
  const parsed = parseImportRequest({ dryRun: o.dryRun, cursor: o.cursor ?? null });
  if (!parsed.ok) throw new Error(parsed.error);
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    if (o.tick) c.advance(o.tick);   // each request costs this much wall time
    return fake.fetch(input, init);
  }) as typeof fetch;
  const result = await runGhlContactImport({
    locationId: LOC, apiKey: KEY, dryRun: parsed.dryRun, cursor: parsed.cursor,
    importPage: store.importPage, softMs: c.now() + (o.softIn ?? 90_000), hardMs: c.now() + (o.hardIn ?? 120_000),
    fetchFn, now: c.now, sleep: c.sleep,
  });
  return { result, fake, store, c };
}

// ─── 1. Reading a contact ────────────────────────────────────────────────────────────────────────
Deno.test("a contact: name, phone, email, tags, date added and do-not-disturb", () => {
  const p = parseGhlContact({
    id: "c-1", firstName: "  Pat ", lastName: "Example", phone: " +1 (555) 010-0101 ", email: "Pat@Example.com",
    tags: ["Lead", "lead", "  spring   show ", 7, "", null], dateAdded: "2024-03-04T05:06:07Z", dnd: false,
    dndSettings: { SMS: { status: "active" } },
  });
  assertEquals(p?.row, { name: "Pat Example", phone: "+1 (555) 010-0101", email: "Pat@Example.com", tags: ["Lead", "spring show"], added_at: "2024-03-04T05:06:07.000Z", sms_dnd: true });
  assertEquals([p?.phoneKey, p?.emailKey, p?.smsDnd], ["5550100101", "pat@example.com", true]);
});

Deno.test("a contact: the name falls back to GoHighLevel's other name fields, in order", () => {
  assertEquals(parseGhlContact({ firstNameRaw: "Robin", lastNameRaw: "Lead" })?.row.name, "Robin Lead");
  assertEquals(parseGhlContact({ firstNameLowerCase: "sam" })?.row.name, "Sam", "a lowercase-only name is capitalised");
  assertEquals(parseGhlContact({ firstNameLowerCase: "mary-jane", lastNameLowerCase: "o'brien" })?.row.name, "Mary-Jane O'Brien");
  assertEquals(parseGhlContact({ firstName: "Pat", lastNameLowerCase: "van der berg" })?.row.name, "Pat Van Der Berg");
  assertEquals(parseGhlContact({ contactName: "kim contact" })?.row.name, "Kim Contact", "GoHighLevel's contactName is lowercased");
  assertEquals(parseGhlContact({ contactName: "Kim Contact", companyName: "Acme Sheds" })?.row.name, "Kim Contact");
  assertEquals(parseGhlContact({ firstName: "deShawn", lastName: "mcKay" })?.row.name, "deShawn mcKay", "a name as written is never recased");
  assertEquals(parseGhlContact({ name: "acme sheds llc" })?.row.name, "acme sheds llc", "only the lowercased fields are capitalised");
  assertEquals([capitaliseLowercaseName(null), capitaliseLowercaseName("ÉMILE zola"), capitaliseLowercaseName("élise")], [null, "ÉMILE zola", "Élise"]);
  assertEquals(parseGhlContact({ companyName: "Acme Sheds" })?.row.name, "Acme Sheds");
  assertEquals(parseGhlContact({ firstName: "   " })?.row.name, null);
});

Deno.test("a contact: what is dropped rather than stored", () => {
  assertEquals(parseGhlContact(null), null);
  assertEquals(parseGhlContact("c-1"), null);
  assertEquals(parseGhlContact([{ phone: "5550100101" }]), null);
  const bad = parseGhlContact({ email: "not an email", phone: 5550100101, dateAdded: "someday", tags: "lead" });
  assertEquals(bad?.row, { name: null, phone: null, email: null, tags: [], added_at: null, sms_dnd: false }, "a number-typed phone, a malformed email and date, a tags string");
  assertEquals([bad?.phoneKey, bad?.emailKey, bad?.smsDnd], ["", "", false]);
  assertEquals([parseGhlContact({ dnd: true })?.smsDnd, parseGhlContact({ dnd: true })?.row.sms_dnd], [true, true], "dnd on every channel counts too, and rides on the row");
  assertEquals(parseGhlContact({ dndSettings: { SMS: { status: "inactive" } } })?.smsDnd, false);
});

Deno.test("tags: at most 25, at most 60 characters, one per spelling ignoring case", () => {
  const many = cleanTags([...Array.from({ length: 30 }, (_v, i) => `t${i}`)]);
  assertEquals(many.length, 25);
  assertEquals(many[24], "t24");
  assertEquals(cleanTags(["x".repeat(80)]), ["x".repeat(60)]);
  assertEquals(cleanTags(["VIP", "vip", "Vip "]), ["VIP"]);
  assertEquals(cleanTags(undefined), []);
});

// ─── 2. The request ──────────────────────────────────────────────────────────────────────────────
Deno.test("the request is a dry run unless dryRun is the boolean false", () => {
  for (const v of [undefined, null, true, "false", 0, "", "no"]) {
    const r = parseImportRequest({ dryRun: v });
    assert(r.ok && r.dryRun === true, `dryRun ${JSON.stringify(v)} must be a dry run`);
  }
  const real = parseImportRequest({ dryRun: false });
  assert(real.ok && real.dryRun === false);
});

Deno.test("the cursor round-trips with its mode, and anything else is refused with a sentence", () => {
  for (const c of [{ page: 1 }, { page: 7 }, { after: [1700000000123, "c-00042"] }, { after: ["x"] }] as const) {
    for (const dryRun of [true, false]) {
      assertEquals(decodeCursor(encodeCursor(c as never, dryRun)), { cursor: c, dryRun });
      const r = parseImportRequest({ dryRun, cursor: encodeCursor(c as never, dryRun) });
      assert(r.ok && r.dryRun === dryRun && JSON.stringify(r.cursor) === JSON.stringify(c), `${JSON.stringify(c)} in a ${dryRun ? "dry" : "real"} run`);
    }
  }
  // Base64url of {"v":1,"p":2}: a position with no mode, as no deployed version ever answered.
  const modeless = btoa(JSON.stringify({ v: 1, p: 2 })).replace(/=+$/, "");
  const wrongMode = btoa(JSON.stringify({ v: 1, d: true, p: 2 })).replace(/=+$/, "");
  for (const bad of ["%%%", "e30", encodeCursor({ page: 101 }, true), encodeCursor({ page: 0 }, true), encodeCursor({ after: [] }, true), "x".repeat(2001), 12, modeless, wrongMode]) {
    const r = parseImportRequest({ cursor: bad });
    assert(!r.ok && r.error === BAD_CURSOR_SENTENCE, `cursor ${String(bad).slice(0, 20)} must be refused`);
  }
  const none = parseImportRequest({ cursor: "" });
  assert(none.ok && none.cursor === null);
});

Deno.test("a real run refuses a dry run's cursor, which would skip every page before it", async () => {
  const contacts = people(500);
  const dry = await run({ contacts }, { softIn: 25_000, tick: 10_000 });
  assertEquals([dry.result.stopped, dry.result.pages], ["time", 3]);
  const cursor = dry.result.cursor!;
  const real = parseImportRequest({ dryRun: false, cursor });
  assert(!real.ok && real.error === DRY_RUN_CURSOR_SENTENCE, JSON.stringify(real));
  const moreDry = parseImportRequest({ cursor });
  assert(moreDry.ok && moreDry.dryRun === true, "the dry run carries on with it");

  // A real run's own cursor carries the real run on, and is harmless in a dry run.
  const first = await run({ contacts }, { dryRun: false, softIn: 25_000, tick: 10_000 });
  assertEquals(first.result.stopped, "time");
  const realCursor = first.result.cursor!;
  assertEquals(decodeCursor(realCursor)?.dryRun, false);
  const next = await run({ contacts }, { dryRun: false, cursor: realCursor });
  assertEquals([next.result.done, next.result.counts.fetched], [true, 200]);
  assert(parseImportRequest({ cursor: realCursor }).ok);
});

// ─── 3. The walk ─────────────────────────────────────────────────────────────────────────────────
Deno.test("searchAfter paging: page 1, then the last contact's searchAfter, to the short page", async () => {
  const world: ContactWorld = { contacts: people(250) };
  const { result, fake, store } = await run(world);
  assertEquals([result.done, result.stopped, result.cursor, result.pages, result.total, result.paging], [true, "end", null, 3, 250, "after"]);
  const bodies = fake.trace.contactSearches.map((s) => s.body);
  assertEquals(bodies[0], { locationId: LOC, pageLimit: 100, page: 1 });
  assertEquals(bodies[1], { locationId: LOC, pageLimit: 100, searchAfter: [1700000000099, "c-00099"] });
  assertEquals(bodies[2], { locationId: LOC, pageLimit: 100, searchAfter: [1700000000199, "c-00199"] });
  assert(fake.trace.contactSearches.every((s) => s.method === "POST" && s.auth === `Bearer ${KEY}` && s.version === GHL_API_VERSION), "every search is a POST with the key and API version");
  assertEquals(fake.trace.calls, ["POST /contacts/search", "POST /contacts/search", "POST /contacts/search"], "nothing but the contact search is ever called");
  assertEquals(store.calls.map((c) => c.rows.length), [100, 100, 50], "every page into the database once, in order");
  assert(store.calls.every((c) => c.dryRun === true), "a dry run all the way down");
  assertEquals(store.calls[0].rows[0], { name: "Person Number0", phone: "+15551000000", email: "person0@example.com", tags: ["lead", "batch 0"], added_at: "2024-05-06T07:08:09.000Z", sms_dnd: false });
  assertEquals(result.counts, { fetched: 250, created: 250, matched: 0, noIdentity: 0, conflicts: 0, labelled: 250, optedOut: 0, split: 0, repeats: 0, smsDnd: 0 });
});

Deno.test("page-number paging when GoHighLevel sends no searchAfter, and an exact multiple of 100", async () => {
  const { result, fake, store } = await run({ contacts: people(200), contactPaging: "page" }, { dryRun: false });
  assertEquals([result.done, result.stopped, result.pages, result.paging], [true, "end", 3, "page"]);
  assertEquals(fake.trace.contactSearches.map((s) => s.body.page), [1, 2, 3], "the empty third page is what ends an exact multiple");
  assertEquals(store.calls.map((c) => [c.rows.length, c.dryRun]), [[100, false], [100, false]], "the empty page writes nothing");
});

Deno.test("an empty location: one search, nothing into the database", async () => {
  const { result, store } = await run({ contacts: [], noContactTotal: true });
  assertEquals([result.done, result.pages, result.total, result.counts.fetched, store.calls.length], [true, 1, null, 0, 0]);
});

Deno.test("contacts with no phone and no email never reach the database; repeats and do-not-disturb are counted", async () => {
  const contacts: FakeContact[] = [
    { id: "a", firstName: "Only", lastName: "Name" },
    { id: "b", phone: "+15550100101", email: "one@example.com" },
    { id: "c", phone: "555-010-0101", dnd: true },               // b's number again
    { id: "d", email: "ONE@example.com" },                        // b's email again
    { id: "e", email: "broken@", phone: "ext. only" },           // nothing usable
  ];
  const { result, store } = await run({ contacts });
  assertEquals(store.calls[0].rows.length, 3, "b, c and d go in; a and e do not");
  assertEquals([result.counts.fetched, result.counts.noIdentity, result.counts.repeats, result.counts.smsDnd], [5, 2, 2, 1]);
  assertEquals(store.calls[0].rows.map((r) => r.sms_dnd), [false, true, false], "the do-not-disturb rides on its row to the database");
  assertEquals(result.counts.optedOut, 1, "and the database's opted_out comes back in the counts");
});

Deno.test("resuming from a cursor reads from there, and a stuck searchAfter stops instead of looping", async () => {
  const contacts = people(250);
  const cursor = encodeCursor({ after: [1700000000099, "c-00099"] }, true);
  const { result, fake } = await run({ contacts }, { cursor });
  assertEquals(fake.trace.contactSearches[0].body, { locationId: LOC, pageLimit: 100, searchAfter: [1700000000099, "c-00099"] });
  assertEquals([result.done, result.counts.fetched], [true, 150]);

  const stuck = await run({ contacts, stuckSearchAfter: true });
  assertEquals([stuck.result.done, stuck.result.stopped, stuck.result.pages], [false, "paging_stuck", 2]);
  assertEquals(stuck.result.counts.fetched, 200, "the second page still went in before the walk noticed");
});

// ─── 4. Rate limits ──────────────────────────────────────────────────────────────────────────────
Deno.test("a 429 with Retry-After is waited out and the page is tried again", async () => {
  const { result, c, fake, store } = await run({ contacts: people(150), failContacts: { from: 1, count: 2, status: 429, retryAfter: "3" } });
  assertEquals([result.done, result.counts.fetched], [true, 150]);
  assertEquals(c.sleeps, [3000, 3000]);
  assertEquals(fake.trace.contactSearches.length, 4, "page 1, then page 2 three times");
  assertEquals(store.calls.map((x) => x.rows.length), [100, 50], "no page doubled");
});

Deno.test("without Retry-After the back-off is 1 s, 2 s, 4 s; a 5xx or a dropped connection is tried again too", async () => {
  const busy = await run({ contacts: people(50), failContacts: { from: 0, count: 3, status: 503 } });
  assertEquals([busy.result.done, busy.c.sleeps], [true, [1000, 2000, 4000]]);
  assertEquals(retryWaitMs(null, 1, 0), 1000);
  assertEquals(retryWaitMs(new Response(null, { headers: { "retry-after": "120" } }), 1, 0), 30_000, "never more than 30 s");
  assertEquals(retryWaitMs(new Response(null, { headers: { "retry-after": new Date(10_000).toUTCString() } }), 1, 4_000), 6_000, "an HTTP date");

  const fake = fakeCrm({ contacts: people(10) });
  let drops = 1;
  const c = clock();
  const store = db();
  const result = await runGhlContactImport({
    locationId: LOC, apiKey: KEY, dryRun: true, cursor: null, importPage: store.importPage, softMs: c.now() + 90_000, hardMs: c.now() + 120_000,
    now: c.now, sleep: c.sleep,
    fetchFn: ((i: string | URL | Request, init?: RequestInit) => drops-- > 0 ? Promise.reject(new TypeError("connection reset")) : fake.fetch(i, init)) as typeof fetch,
  });
  assertEquals([result.done, result.counts.fetched, c.sleeps], [true, 10, [1000]]);
});

Deno.test("four refusals in a row stop the call, and the cursor carries on from that page with nothing skipped or doubled", async () => {
  const contacts = people(350);
  const first = await run({ contacts, failContacts: { from: 2, count: GHL_TRIES_PER_PAGE, status: 429 } });
  assertEquals([first.result.done, first.result.stopped, first.result.ghlStatus, first.result.pages], [false, "ghl_busy", 429, 2]);
  assertEquals(first.c.sleeps, [1000, 2000, 4000], "three waits between the four tries");
  assert(first.result.cursor, "a cursor to carry on from");
  assertEquals(decodeCursor(first.result.cursor!), { cursor: { after: [1700000000199, "c-00199"] }, dryRun: true }, "the page that did not land, from a dry run");

  const second = await run({ contacts }, { cursor: first.result.cursor });
  assertEquals([second.result.done, second.result.counts.fetched], [true, 150]);
  const ids = [...first.store.calls, ...second.store.calls].flatMap((x) => x.rows.map((r) => r.email));
  assertEquals(ids.length, 350, "every contact once across the two calls");
  assertEquals(new Set(ids).size, 350, "and none twice");
});

// ─── 5. Refusals and a failed page ───────────────────────────────────────────────────────────────
Deno.test("a refused key or request stops at once, untried again, with the page's cursor", async () => {
  for (const [status, stopped] of [[401, "ghl_auth"], [403, "ghl_auth"], [400, "ghl_refused"], [422, "ghl_refused"]] as const) {
    const { result, c, fake, store } = await run({ contacts: people(150), failContacts: { from: 1, count: 1, status } });
    assertEquals([result.done, result.stopped, result.ghlStatus, c.sleeps.length, fake.trace.contactSearches.length], [false, stopped, status, 0, 2], String(status));
    assertEquals(store.calls.length, 1, `${status}: only the first page went in`);
    assertEquals(at(result.cursor), { after: [1700000000099, "c-00099"] });
  }
});

Deno.test("an answer that is not a contact list is a refusal, not an empty location", async () => {
  const c = clock();
  const result = await runGhlContactImport({
    locationId: LOC, apiKey: KEY, dryRun: true, cursor: null, importPage: db().importPage, softMs: c.now() + 90_000, hardMs: c.now() + 120_000,
    now: c.now, sleep: c.sleep,
    fetchFn: (() => Promise.resolve(new Response(JSON.stringify({ message: "ok" }), { status: 200 }))) as typeof fetch,
  });
  assertEquals([result.done, result.stopped, result.ghlStatus], [false, "ghl_refused", 200]);
});

Deno.test("a page the database refuses stops the call, leaves the totals as they were and keeps its cursor", async () => {
  const { result } = await run({ contacts: people(250) }, { failOn: 1 });
  assertEquals([result.done, result.stopped, result.pages, result.counts.fetched, result.counts.created], [false, "database", 1, 100, 100]);
  assertEquals((result.dbError as { code?: string }).code, "XX000");
  assertEquals(at(result.cursor), { after: [1700000000099, "c-00099"] }, "the next call redoes the failed page");
});

Deno.test("page numbering stops at GoHighLevel's 10,000-record ceiling", async () => {
  const { result, fake } = await run({ contacts: people(10_050), contactPaging: "page" }, { softIn: 10_000_000, hardIn: 10_000_000 });
  assertEquals([result.done, result.stopped, result.pages, result.cursor], [false, "page_ceiling", 100, null]);
  assertEquals(fake.trace.contactSearches.at(-1)?.body.page, 100);
});

// ─── 6. Time ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("no new page after the soft deadline; the cursor carries on from the next one", async () => {
  const { result } = await run({ contacts: people(500) }, { softIn: 25_000, tick: 10_000 });
  assertEquals([result.done, result.stopped, result.pages], [false, "time", 3]);
  assertEquals(at(result.cursor), { after: [1700000000299, "c-00299"] });
});

Deno.test("the first page is tried on an old worker; nothing at all when even that cannot fit", async () => {
  const late = await run({ contacts: people(150) }, { softIn: -1, hardIn: IMPORT_FIRST_PAGE_MS + 1 });
  assertEquals([late.result.stopped, late.result.pages], ["time", 1]);
  const none = await run({ contacts: people(150) }, { softIn: -1, hardIn: IMPORT_FIRST_PAGE_MS });
  assertEquals([none.result.stopped, none.result.pages, none.fake.trace.contactSearches.length, none.result.cursor], ["time", 0, 0, encodeCursor({ page: 1 }, true)]);
});

Deno.test("a back-off that would cross the hard deadline is not waited out", async () => {
  const { result, c } = await run({ contacts: people(150), failContacts: { from: 0, count: 1, status: 429, retryAfter: "30" } }, { hardIn: IMPORT_FIRST_PAGE_MS + 4_000 });
  assertEquals([result.stopped, result.pages, c.sleeps.length], ["ghl_busy", 0, 0]);
});

Deno.test("deadlines: from the request, and from the worker's 400 s life", () => {
  assertEquals(importDeadlines({ requestStartMs: 1_000_000, workerBornMs: 1_000_000 }), { softMs: 1_090_000, hardMs: 1_120_000 }, "a fresh worker");
  assertEquals(importDeadlines({ requestStartMs: 1_000_000, workerBornMs: 1_000_000 - 300_000 }), { softMs: 1_035_000, hardMs: 1_060_000 }, "a worker 300 s old");
  const old = importDeadlines({ requestStartMs: 1_000_000, workerBornMs: 1_000_000 - 360_000 });
  assert(old.hardMs === 1_000_000 && old.softMs < old.hardMs, "a worker at its margin has no time at all");
});

// ─── 7. Counts only ──────────────────────────────────────────────────────────────────────────────
Deno.test("the answer and its sentence carry numbers, never a contact", async () => {
  const contacts = people(120).map((c, i) => ({ ...c, companyName: `Company ${i}`, tags: ["secret-tag"] }));
  for (const dryRun of [true, false]) {
    const { result } = await run({ contacts, failContacts: { from: 1, count: 4, status: 429 } }, { dryRun });
    const said = JSON.stringify(result) + importSummary(result, dryRun);
    for (const leak of ["Person", "Number", "example.com", "+1555", "secret-tag", "Company"]) {
      assert(!said.includes(leak), `the answer must not carry "${leak}"`);
    }
  }
  const { result } = await run({ contacts: people(3) });
  assertEquals(importSummary(result, true), "Dry run, nothing was saved. 3 GoHighLevel contacts read over 1 page: 3 would be new, 0 already here, 0 with no phone or email. That is every contact in the location.");
  assertEquals(importSummary(result, false).startsWith("Imported. 3 GoHighLevel contacts read over 1 page: 3 new,"), true);
  const more = { ...result, counts: { ...result.counts, optedOut: 2, split: 1 } };
  assertEquals(importSummary(more, true), "Dry run, nothing was saved. 3 GoHighLevel contacts read over 1 page: 3 would be new, 0 already here, 0 with no phone or email, 2 would be marked do not text, 1 with an email another contact already has (left there). That is every contact in the location.");
  assert(importSummary(more, false).includes(", 2 marked do not text,"));
  assertEquals(IMPORT_PAGE_SIZE, 100, "the contract's page size");
});
