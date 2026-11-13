// THE PUBLIC SIDE OF PLANS AS DATA (_shared/accessPublic.ts, migration 389), piece by piece.
//
// The pages a builder's customers open with no login (a website form, the booking page, the lot
// shop) ask one question before they OFFER anything: is this tab blocked for this company's public?
// This file holds the three functions that answer it, one branch at a time:
//
//   1. the answer reader: anything that is not a clean { mode, holds, blocked } is null (today);
//   2. the read: one rpc, never throws, and every failure is null;
//   3. the verdict: null, a tab that is not blocked and a tab the answer does not list are "ok";
//      block + blocked is "refuse"; report + blocked is "ok" with ONE info row per company,
//      function and action, written before the answer comes back;
//   4. the test double answers access_for_public as "not named" unless a test asks otherwise, so no
//      other test has to learn the question.
//
// The handlers that call it are driven in accessPublicHandlers_test.ts. Tenants are made up.
//
// Run (from supabase/functions/):
//   deno test --quiet --allow-env --allow-read=<repo root> --node-modules-dir=none \
//     --import-map=_shared/_test_stubs/import_map.json _shared/_test_stubs/accessPublic_test.ts

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { createClient, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";
import { publicAccess, publicAccessFromAnswer, publicVerdict } from "../accessPublic.ts";

const BLOCKED = { mode: "block", holds: true, blocked: { forms: true, meetings: false, inventory: true } };
const REPORT = { ...BLOCKED, mode: "report" };
const answers = (a: unknown) => ({ rpc: () => Promise.resolve({ data: a, error: null }) });

// ── 1. the answer reader ────────────────────────────────────────────────────────────────────
Deno.test("a clean answer comes back; anything else is null", () => {
  assertEquals(publicAccessFromAnswer(BLOCKED), BLOCKED as any);
  assertEquals(publicAccessFromAnswer({ mode: "report", holds: false, blocked: { forms: false } }), { mode: "report", holds: false, blocked: { forms: false } });
  // Extra keys are dropped, not trusted.
  assertEquals(publicAccessFromAnswer({ ...BLOCKED, modules: { forms: "on" } }), BLOCKED as any);
  for (const bad of [
    null, undefined, "block", 7, true, [], {}, { mode: "block" }, { mode: "block", holds: true }, { holds: true, blocked: { forms: true } },
    { mode: "enforce", holds: true, blocked: { forms: true } }, { mode: "block", blocked: { forms: true } },
    { mode: "block", holds: "true", blocked: { forms: true } }, { mode: "block", holds: 1, blocked: { forms: true } },
    { mode: "block", holds: true, blocked: null }, { mode: "block", holds: true, blocked: [] }, { mode: "block", holds: true, blocked: {} },
    { mode: "block", holds: true, blocked: { forms: "true" } }, { mode: "block", holds: true, blocked: { forms: 1 } },
    { mode: "block", holds: true, blocked: { forms: true, meetings: null } }, { mode: "block", holds: true, blocked: { "Website forms": true } },
    // The SERVER's answer is not this one: a caller that asked the wrong function gets today's behaviour.
    { mode: "block", modules: { forms: "hidden" } },
  ]) assertEquals(publicAccessFromAnswer(bad), null, JSON.stringify(bad));
});

// ── 2. the read ─────────────────────────────────────────────────────────────────────────────
Deno.test("publicAccess asks access_for_public once, never throws, and every failure is null", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assertEquals(await publicAccess(answers(BLOCKED), "acme-sheds"), BLOCKED as any);
    assertEquals(await publicAccess(answers(null), "acme-sheds"), null);
    assertEquals(await publicAccess(answers({ mode: "block", holds: true, blocked: {} }), "acme-sheds"), null);
    assertEquals(await publicAccess({ rpc: () => Promise.resolve({ data: BLOCKED, error: { message: "function does not exist" } }) }, "acme-sheds"), null);
    assertEquals(await publicAccess({ rpc: () => { throw new Error("network"); } }, "acme-sheds"), null);
    assertEquals(await publicAccess({ rpc: () => Promise.reject(new Error("timeout")) }, "acme-sheds"), null);
    assertEquals(await publicAccess({}, "acme-sheds"), null);
    assertEquals(await publicAccess(null, "acme-sheds"), null);
    let asked = false;
    assertEquals(await publicAccess({ rpc: () => { asked = true; return Promise.resolve({ data: BLOCKED, error: null }); } }, ""), null);
    assert(!asked, "an empty company id must not reach the database");
    const calls: unknown[] = [];
    await publicAccess({ rpc: (fn: string, args: unknown) => { calls.push([fn, args]); return Promise.resolve({ data: null, error: null }); } }, "acme-sheds");
    assertEquals(calls, [["access_for_public", { p_client_id: "acme-sheds" }]]);
  } finally {
    console.error = quiet;
  }
});

Deno.test("under deno test nothing is cached: the second read sees the second answer", async () => {
  let n = 0;
  const admin = { rpc: () => Promise.resolve({ data: ++n === 1 ? BLOCKED : null, error: null }) };
  assertEquals((await publicAccess(admin, "cache-co"))?.mode, "block");
  assertEquals(await publicAccess(admin, "cache-co"), null);
});

Deno.test("on the edge runtime a successful read is kept for the company, a failed one is not", async () => {
  // The cache switches on where EdgeRuntime exists, decided when the module loads. So a second copy
  // of the module is loaded with it set (a query string makes it a separate module), and this
  // file's own copy stays uncached like every other test's.
  const g = globalThis as any;
  const had = "EdgeRuntime" in g, was = g.EdgeRuntime;
  g.EdgeRuntime = {};
  const quiet = console.error;
  console.error = () => {};
  try {
    const edge = await import(new URL("../accessPublic.ts?as-on-the-edge", import.meta.url).href);
    let n = 0;
    const counting = (a: unknown) => ({ rpc: () => { n++; return Promise.resolve({ data: a, error: null }); } });
    assertEquals((await edge.publicAccess(counting(BLOCKED), "edge-named"))?.mode, "block");
    assertEquals((await edge.publicAccess(counting(null), "edge-named"))?.mode, "block", "inside 30 seconds the first answer stands");
    assertEquals(n, 1, "and the database was asked once");
    // "Not named" is an answer too, and is kept.
    assertEquals(await edge.publicAccess(counting(null), "edge-unnamed"), null);
    assertEquals(await edge.publicAccess(counting(BLOCKED), "edge-unnamed"), null);
    assertEquals(n, 2);
    // A failure is not: the next call asks again and gets the real answer.
    assertEquals(await edge.publicAccess({ rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) }, "edge-failed"), null);
    assertEquals(await edge.publicAccess({ rpc: () => { throw new Error("network"); } }, "edge-failed"), null);
    assertEquals((await edge.publicAccess(counting(BLOCKED), "edge-failed"))?.mode, "block");
    // One company's answer is never another's.
    assertEquals(await edge.publicAccess(counting(null), "edge-other"), null);
    // The verdict reads through the same cache.
    assertEquals(await edge.publicVerdict(counting(null), "edge-named", "lead-form", "load", "forms"), "refuse");
  } finally {
    console.error = quiet;
    if (had) g.EdgeRuntime = was; else delete g.EdgeRuntime;
  }
});

Deno.test("on the edge runtime an answer is kept for 30 seconds and no longer: un-naming a company reaches a warm isolate", async () => {
  // The way back from a wrong block is to take the company out of the list. That only works if a
  // warm isolate lets go of the old answer, so the expiry is pinned on both sides of 30 seconds.
  const g = globalThis as any;
  const had = "EdgeRuntime" in g, was = g.EdgeRuntime;
  g.EdgeRuntime = {};
  const realNow = Date.now;
  const t0 = realNow.call(Date);
  let clock = t0;
  Date.now = () => clock;
  try {
    const edge = await import(new URL("../accessPublic.ts?as-on-the-edge", import.meta.url).href);
    let asked = 0;
    const counting = (a: unknown) => ({ rpc: () => { asked++; return Promise.resolve({ data: a, error: null }); } });
    assertEquals(await edge.publicVerdict(counting(BLOCKED), "edge-expiry", "lead-form", "load", "forms"), "refuse");
    assertEquals(asked, 1);
    // One millisecond short of 30 seconds: the first answer still stands, and nobody is asked.
    clock = t0 + 29_999;
    assertEquals(await edge.publicVerdict(counting(null), "edge-expiry", "lead-form", "load", "forms"), "refuse");
    assertEquals(asked, 1, "inside 30 seconds the database is not asked again");
    // At 30 seconds the answer is too old: the database is asked, and "not named" now wins.
    clock = t0 + 30_000;
    assertEquals(await edge.publicAccess(counting(null), "edge-expiry"), null);
    assertEquals(asked, 2, "at 30 seconds the database is asked again");
    assertEquals(await edge.publicVerdict(counting(BLOCKED), "edge-expiry", "lead-form", "load", "forms"), "ok", "the company was un-named, so nothing is refused");
    // The fresh answer starts its own 30 seconds, counted from when IT was read.
    clock = t0 + 59_999;
    assertEquals(await edge.publicAccess(counting(BLOCKED), "edge-expiry"), null);
    assertEquals(asked, 2, "the second answer is kept from its own read, not from the first one");
    clock = t0 + 60_000;
    assertEquals((await edge.publicAccess(counting(BLOCKED), "edge-expiry"))?.mode, "block");
    assertEquals(asked, 3);
  } finally {
    Date.now = realNow;
    if (had) g.EdgeRuntime = was; else delete g.EdgeRuntime;
  }
});

// ── 3. the verdict ──────────────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
/** Run `fn` with the logger able to write, and hand back the app_errors rows it wrote. */
async function withLog<T>(fn: () => Promise<T>, insertFails = false): Promise<{ value: T; rows: any[] }> {
  const rows: any[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn];
  console.error = console.warn = () => {};
  stubDb.from = (table: string) => ({
    insert: (row: unknown) => {
      if (insertFails) throw new Error("app_errors is down");
      if (table === "app_errors") rows.push(row);
      return Promise.resolve({ error: null });
    },
  });
  try {
    return { value: await fn(), rows };
  } finally {
    stubDb.from = null;
    [console.error, console.warn] = quiet;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}
const REQ = () => new Request("https://stub.supabase.co/functions/v1/lead-form", { method: "POST", headers: { "user-agent": "harness/1.0" } });

Deno.test("not named, a failed read, a malformed answer: ok, and nothing is written", async () => {
  for (const admin of [
    answers(null), answers({ mode: "block" }), answers({ mode: "block", holds: true, blocked: { forms: "yes" } }), {}, null,
    { rpc: () => Promise.resolve({ data: BLOCKED, error: { message: "boom" } }) }, { rpc: () => { throw new Error("network"); } },
  ]) {
    const r = await withLog(() => publicVerdict(admin, "v-null", "lead-form", "load", "forms", REQ()));
    assertEquals([r.value, r.rows.length], ["ok", 0]);
  }
});

Deno.test("block: a blocked tab is refused; one that is not blocked, or not in the answer at all, is ok", async () => {
  const r = await withLog(async () => [
    await publicVerdict(answers(BLOCKED), "v-block", "lead-form", "load", "forms", REQ()),
    await publicVerdict(answers(BLOCKED), "v-block", "book-public", "book", "meetings", REQ()),
    await publicVerdict(answers(BLOCKED), "v-block", "shop-checkout", "price", "inventory"),
    await publicVerdict(answers(BLOCKED), "v-block", "lead-form", "load", "no_such_tab", REQ()),
    await publicVerdict(answers(BLOCKED), "v-block", "lead-form", "load", "", REQ()),
  ]);
  assertEquals(r.value, ["refuse", "ok", "refuse", "ok", "ok"]);
  assertEquals(r.rows.length, 0, "block mode writes no report row");
});

Deno.test("report: nothing is refused, and the would-be refusal is filed once per company, function and action", async () => {
  const first = await withLog(() => publicVerdict(answers(REPORT), "v-report", "lead-form", "load", "forms", REQ()));
  assertEquals(first.value, "ok");
  assertEquals(first.rows.length, 1, "the row is written before the verdict comes back (awaited)");
  const row = first.rows[0];
  assertEquals([row.source, row.severity, row.code, row.client_id], ["edge:lead-form", "info", "module_would_refuse", "v-report"]);
  assertEquals(row.message, "Report only: load would be refused (needs forms).");
  assertEquals(row.context, { action: "load", tabs: ["forms"], surface: "public" });
  assertEquals([row.url, row.user_agent], ["/functions/v1/lead-form", "harness/1.0"]);
  // The same action again: still ok, not filed again.
  const again = await withLog(() => publicVerdict(answers(REPORT), "v-report", "lead-form", "load", "forms", REQ()));
  assertEquals([again.value, again.rows.length], ["ok", 0]);
  // Another action, another function and another company are each their own row.
  const others = await withLog(async () => [
    await publicVerdict(answers(REPORT), "v-report", "lead-form", "start", "forms", REQ()),
    await publicVerdict(answers(REPORT), "v-report", "shop-checkout", "price", "inventory"),
    await publicVerdict(answers(REPORT), "v-report-two", "lead-form", "load", "forms", REQ()),
  ]);
  assertEquals([others.value, others.rows.length], [["ok", "ok", "ok"], 3]);
  // A tab that is not blocked is not reported at all.
  const fine = await withLog(() => publicVerdict(answers(REPORT), "v-report", "book-public", "availability", "meetings", REQ()));
  assertEquals([fine.value, fine.rows.length], ["ok", 0]);
});

Deno.test("report: a logger that cannot write changes nothing; the verdict is still ok and nothing is thrown", async () => {
  const r = await withLog(() => publicVerdict(answers(REPORT), "v-report-down", "lead-form", "load", "forms", REQ()), true);
  assertEquals([r.value, r.rows.length], ["ok", 0]);
});

// ── 4. the test double ──────────────────────────────────────────────────────────────────────
Deno.test("the supabase double answers access_for_public as not named unless a test turns the plan read on", async () => {
  const seen: string[] = [];
  stubRpc.rpc = (fn: string) => { seen.push(fn); return Promise.resolve({ data: BLOCKED, error: null }); };
  try {
    const admin = createClient("https://stub.supabase.co", "stub-service");
    assertEquals(await publicAccess(admin, "double-co"), null);
    assertEquals(seen, [], "a test's own rpc fake must not be asked a question that is not its own");
    stubPlanRead.on = true;
    assertEquals((await publicAccess(admin, "double-co"))?.mode, "block");
    assertEquals(seen, ["access_for_public"]);
  } finally {
    stubPlanRead.on = false;
    stubRpc.rpc = null;
  }
});

Deno.test("accessPublic.ts does not import the server half (it must not join that deploy set)", async () => {
  const src = (await Deno.readTextFile(new URL("../accessPublic.ts", import.meta.url))).replace(/\r/g, "");
  const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  assertEquals(imports, ["./logError.ts"]);
});
