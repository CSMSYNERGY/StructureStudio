// THE SERVER HALF OF PLANS AS DATA (_shared/accessEnforce.ts, migrations 386 to 388), and the one
// place it is enforced, driven through the SHIPPED portal-schedule and portal-settings handlers.
//
// For a company named in access_config.enforce.server_clients the edge functions refuse an action
// whose tab the company has not got. For one named in server_report they refuse nothing and write
// down what they would have refused. For everyone else, and whenever the database cannot answer,
// nothing changes. This file holds all three, and the paid-feature check's half:
//
//   1. the answer reader: anything that is not a clean { mode, modules } is null (the old rules);
//   2. block: an action on a tab the company lacks is 403 `module_off`; one on a tab it has, and
//      one with no tab at all, go through; "locked" is refused;
//   3. report: nothing is refused, and one info row per action is filed;
//   4. not named / failed read / malformed: exactly the old answer;
//   5. hasPaidFeature and usableFeatureSet answer by the map in block mode only.
//
// HOW. The phoneOnlyAccount_test idiom: Deno.serve is stubbed while a function's index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the real branches; the import
// map swaps supabase-js for supabase_stub.ts. Tenants are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";
import { anyModuleOn, firstReport, MODULE_REFUSAL, serverAccess, serverAccessFromAnswer, serverAccessOn, serverModules } from "../accessEnforce.ts";
import { hasPaidFeature, usableFeatureSet } from "../featureCheck.ts";

// ── 1. the answer reader ────────────────────────────────────────────────────────────────────
Deno.test("a clean answer comes back; anything else is null", () => {
  assertEquals(serverAccessFromAnswer({ mode: "block", modules: { contacts: "on", jack: "hidden" } }), { mode: "block", modules: { contacts: "on", jack: "hidden" } });
  assertEquals(serverAccessFromAnswer({ mode: "report", modules: { contacts: "locked" } }), { mode: "report", modules: { contacts: "locked" } });
  for (const bad of [
    null, undefined, "block", 7, [], {}, { mode: "block" }, { modules: { contacts: "on" } },
    { mode: "enforce", modules: { contacts: "on" } }, { mode: "block", modules: null }, { mode: "block", modules: [] },
    { mode: "block", modules: {} }, { mode: "block", modules: { contacts: "yes" } }, { mode: "block", modules: { contacts: true } },
    { mode: "block", modules: { "Customer Hub": "on" } }, { mode: "block", modules: { contacts: "on", jack: null } },
  ]) assertEquals(serverAccessFromAnswer(bad), null, JSON.stringify(bad));
});

Deno.test("serverAccess never throws; serverModules is the map in BLOCK mode only", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const ok = (a: unknown) => ({ rpc: () => Promise.resolve({ data: a, error: null }) });
    assertEquals(await serverAccess(ok({ mode: "block", modules: { contacts: "on" } }), "a"), { mode: "block", modules: { contacts: "on" } });
    assertEquals(await serverModules(ok({ mode: "block", modules: { contacts: "on" } }), "a"), { contacts: "on" });
    assertEquals(await serverModules(ok({ mode: "report", modules: { contacts: "on" } }), "a"), null);
    assertEquals(await serverAccess(ok(null), "a"), null);
    assertEquals(await serverAccess({ rpc: () => Promise.resolve({ data: null, error: { message: "no function" } }) }, "a"), null);
    assertEquals(await serverAccess({ rpc: () => { throw new Error("network"); } }, "a"), null);
    assertEquals(await serverAccess({ rpc: () => Promise.reject(new Error("timeout")) }, "a"), null);
    assertEquals(await serverAccess({}, "a"), null);
    assertEquals(await serverAccess(null, "a"), null);
    let asked = false;
    assertEquals(await serverAccess({ rpc: () => { asked = true; return Promise.resolve({ data: null, error: null }); } }, ""), null);
    assert(!asked, "an empty company id must not reach the database");
    const calls: unknown[] = [];
    await serverAccess({ rpc: (fn: string, args: unknown) => { calls.push([fn, args]); return Promise.resolve({ data: null, error: null }); } }, "acme-sheds");
    assertEquals(calls, [["access_for_server", { p_client_id: "acme-sheds" }]]);
  } finally {
    console.error = quiet;
  }
});

// The cache is off under `deno test` (accessEnforce.ts cachesHere), so serverAccessOn is handed
// "this runtime caches" and a clock. Each company here is asked about by this test alone.
Deno.test("where the runtime caches: a good answer is asked for once in 30 seconds, and a FAILED read once in 10", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    let t = 1_000_000;
    const now = () => t;
    const BLOCK = { mode: "block" as const, modules: { contacts: "on" } };
    /** A database that answers each ask from the list in turn, and counts the asks. */
    const db = (answers: (() => Promise<{ data: unknown; error: unknown }>)[]) => {
      const d = { asks: 0, rpc: () => { d.asks++; return answers[Math.min(d.asks, answers.length) - 1](); } };
      return d;
    };
    const good = () => Promise.resolve({ data: BLOCK, error: null });
    const errored = () => Promise.resolve({ data: null, error: { message: "statement timeout" } });
    const threw = () => Promise.reject(new Error("network"));

    // A good answer: one read serves the next 30 seconds, then it is asked for again.
    const ok = db([good]);
    assertEquals(await serverAccessOn(ok, "cache-co-good", true, now), BLOCK);
    t += 29_999;
    assertEquals(await serverAccessOn(ok, "cache-co-good", true, now), BLOCK);
    assertEquals(ok.asks, 1);
    t += 1;
    await serverAccessOn(ok, "cache-co-good", true, now);
    assertEquals(ok.asks, 2);

    // A failed read, by error and by throw. ONE REQUEST ASKS TWICE (resolveTenant at the door, then
    // jack-agent for the turn): the second ask must not go back to a database that just took its
    // whole timeout to fail. Null both times, so no answer changes.
    for (const [company, fail] of [["cache-co-errored", errored], ["cache-co-threw", threw]] as const) {
      const d = db([fail, good]);
      assertEquals(await serverAccessOn(d, company, true, now), null);
      assertEquals(await serverAccessOn(d, company, true, now), null);
      t += 9_999;
      assertEquals(await serverAccessOn(d, company, true, now), null);
      assertEquals(d.asks, 1, `${company}: a failed read was paid for again inside 10 seconds`);
      // Not for the full 30: after 10 seconds the database is asked again, and a recovered answer
      // is the answer from then on.
      t += 1;
      assertEquals(await serverAccessOn(d, company, true, now), BLOCK, `${company}: asked again after 10 seconds`);
      assertEquals(await serverAccessOn(d, company, true, now), BLOCK);
      assertEquals(d.asks, 2);
    }

    // A failure is remembered for that company only.
    const other = db([good]);
    const down = db([errored]);
    await serverAccessOn(down, "cache-co-down", true, now);
    assertEquals(await serverAccessOn(other, "cache-co-up", true, now), BLOCK);

    // Where the runtime does not cache (every test, and so serverAccess here) nothing is remembered.
    const never = db([errored, good]);
    assertEquals(await serverAccessOn(never, "cache-co-never", false, now), null);
    assertEquals(await serverAccessOn(never, "cache-co-never", false, now), BLOCK);
    assertEquals(await serverAccessOn(never, "cache-co-never", false, now), BLOCK);
    assertEquals(never.asks, 3);
    const plain = db([errored, good]);
    assertEquals(await serverAccess(plain, "cache-co-plain"), null);
    assertEquals(await serverAccess(plain, "cache-co-plain"), BLOCK);
    assertEquals(plain.asks, 2);
    // A client that cannot ask at all is not a read: nothing is remembered for it.
    assertEquals(await serverAccessOn({}, "cache-co-noclient", true, now), null);
    assertEquals(await serverAccessOn(db([good]), "cache-co-noclient", true, now), BLOCK);
  } finally {
    console.error = quiet;
  }
});

// TWO REQUESTS CAN BE READING FOR ONE COMPANY AT ONCE (nothing shares a read between requests, and
// the phone Worker could not). The slow one may fail after the fast one has answered, and several
// may fail one after another. Each read here is answered by hand, so the order they land in is the
// test's, and the clock is the injected one. Every case runs with the reads begun on the same tick
// of the clock, and a millisecond apart in each order, which is what real requests do.
// ON THE TICK ITSELF: a failure is kept only over an entry stored BEFORE its own read began, so an
// answer that lands on the very tick the slow read began (the clock has not moved since) has to
// stay too. The "on that tick" cases are the only ones that tell `<` from `<=` in that rule: with
// `<=` they lose the answer in hand, or push the 10 seconds out, and every other case still passes.
Deno.test("where the runtime caches: a failed read never replaces an answer that arrived while it was out, and overlapping failures hold a company for one 10 seconds", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    let t = 5_000_000;
    const now = () => t;
    const BLOCK = { mode: "block" as const, modules: { contacts: "on" } };
    type Answer = { data: unknown; error: unknown };
    /** A database whose every ask waits until the test answers it. */
    const db = () => {
      const d = {
        asks: [] as { answer: (a: Answer) => void; reject: (e: Error) => void }[],
        rpc: () => new Promise<Answer>((answer, reject) => { d.asks.push({ answer, reject }); }),
      };
      return d;
    };
    const good: Answer = { data: BLOCK, error: null };
    const errored: Answer = { data: null, error: { message: "statement timeout" } };
    type Db = ReturnType<typeof db>;
    const ask = (d: Db, company: string) => serverAccessOn(d, company, true, now);
    /** Fail one waiting ask the way the case says: an error answer, or a thrown call. */
    const fail = (d: Db, i: number, how: "errored" | "threw") => how === "errored" ? d.asks[i].answer(errored) : d.asks[i].reject(new Error("network"));

    // (a) Both miss the cache. The fast read answers and is kept; the slow one times out 5 seconds
    // later. The answer in hand is still the answer, with no new read, for the rest of its 30 seconds.
    let n = 0;
    for (const how of ["errored", "threw"] as const) {
      for (const order of ["same tick", "same tick, answered on that tick", "slow began first", "slow began last", "slow began last, answered on that tick"] as const) {
        const company = `overlap-co-a${++n}`;
        const d = db();
        let slow: Promise<unknown>, fast: Promise<unknown>, slowAsk: number;
        if (order.startsWith("slow began last")) { fast = ask(d, company); t += 1; slow = ask(d, company); slowAsk = 1; }
        else { slow = ask(d, company); if (order === "slow began first") t += 1; fast = ask(d, company); slowAsk = 0; }
        assertEquals(d.asks.length, 2, "both requests missed the cache and asked");
        // "On that tick": the fast answer is stored before the clock moves on from the slow read's start.
        if (!order.endsWith("answered on that tick")) t += 1;
        const answeredAt = t;
        d.asks[1 - slowAsk].answer(good);
        assertEquals(await fast, BLOCK);
        assertEquals(await ask(d, company), BLOCK);
        t += 5_000;
        fail(d, slowAsk, how);
        assertEquals(await slow, null, "the request whose own read failed keeps the old rules");
        assertEquals(await ask(d, company), BLOCK, `${how}, ${order}: a late failure threw away the good answer`);
        t = answeredAt + 29_999;
        assertEquals(await ask(d, company), BLOCK);
        assertEquals(d.asks.length, 2, `${how}, ${order}: the good answer was paid for again inside its 30 seconds`);
        t = answeredAt + 30_000;
        const next = ask(d, company);
        assertEquals(d.asks.length, 3, "and it lapses when it always did");
        d.asks[2].answer(good);
        await next;
      }
    }

    // (b) Three reads overlap and fail at +0, +8 and +16 seconds. The company is held on the old
    // rules for 10 seconds from the FIRST failure, not 10 from each: the database is asked again at
    // +10, not at +26. `lands` 0 is the first failure landing on the tick all three began.
    for (const how of ["errored", "threw"] as const) {
      for (const [gap, lands] of [[0, 1], [1, 1], [0, 0]]) {
        const company = `overlap-co-b${++n}`;
        const d = db();
        const reads = [ask(d, company)];
        t += gap; reads.push(ask(d, company));
        t += gap; reads.push(ask(d, company));
        assertEquals(d.asks.length, 3);
        t += lands;
        const first = t;
        fail(d, 0, how);
        assertEquals(await reads[0], null);
        t = first + 8_000;
        fail(d, 1, how);
        assertEquals(await reads[1], null);
        t = first + 9_999;
        assertEquals(await ask(d, company), null);
        assertEquals(d.asks.length, 3, "inside the first 10 seconds the failure is still remembered");
        t = first + 10_000;
        const again = ask(d, company);
        assertEquals(d.asks.length, 4, `${how}, gap ${gap}, lands ${lands}: a second failure pushed the 10 seconds out`);
        d.asks[3].answer(good);
        assertEquals(await again, BLOCK);
        // The third lands after the company has recovered: it does not take the good answer away.
        t = first + 16_000;
        fail(d, 2, how);
        assertEquals(await reads[2], null);
        assertEquals(await ask(d, company), BLOCK, `${how}, gap ${gap}: a late failure threw away the recovered answer`);
        assertEquals(d.asks.length, 4);

        // The same three with nobody asking in between: straight after the last failure the first
        // memo is long over, so the next ask goes to the database.
        const company2 = `overlap-co-b${++n}`;
        const d2 = db();
        const reads2 = [ask(d2, company2)];
        t += gap; reads2.push(ask(d2, company2));
        t += gap; reads2.push(ask(d2, company2));
        t += lands;
        const first2 = t;
        for (const [i, at] of [[0, 0], [1, 8_000], [2, 16_000]]) {
          t = first2 + at;
          fail(d2, i, how);
          assertEquals(await reads2[i], null);
        }
        t = first2 + 16_001;
        const after = ask(d2, company2);
        assertEquals(d2.asks.length, 4, `${how}, gap ${gap}, lands ${lands}: three failures held the company past the first one's 10 seconds`);
        d2.asks[3].answer(good);
        assertEquals(await after, BLOCK);
      }
    }
  } finally {
    console.error = quiet;
  }
});

Deno.test("anyModuleOn: on is the only yes", () => {
  const m = { a: "on", b: "locked", c: "hidden", d: "off" };
  assertEquals(anyModuleOn(m, ["a"]), true);
  assertEquals(anyModuleOn(m, ["b", "c", "d", "missing"]), false);
  assertEquals(anyModuleOn(m, ["c", "a"]), true);
  assertEquals(anyModuleOn(m, []), false);
});

Deno.test("report mode files a would-be refusal once per company, function and action", () => {
  assertEquals(firstReport("co-one", "portal-schedule", "build_board"), true);
  assertEquals(firstReport("co-one", "portal-schedule", "build_board"), false);
  assertEquals(firstReport("co-one", "portal-schedule", "job_activity"), true);
  assertEquals(firstReport("co-two", "portal-schedule", "build_board"), true);
});

// ── the real handlers ───────────────────────────────────────────────────────────────────────
const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
async function load(fn: string): Promise<(req: Request) => Promise<Response>> {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  try {
    await import(new URL(`../../${fn}/index.ts`, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
  if (!handler) throw new Error(`${fn} did not hand Deno.serve a handler`);
  return handler as (req: Request) => Promise<Response>;
}
const SCHEDULE = await load("portal-schedule");

const TENANT = "harness-builder";
type World = { answer?: unknown; rpcError?: boolean; rpcMissing?: boolean };

/** A database that answers resolveTenant's own reads and then FAILS every other table with a marker,
 *  so "the request got past the gate" is visible as that marker instead of needing a whole schema. */
const PAST_THE_GATE = "harness: past the gate";
function chain(table: string, inserted: any[]): any {
  const q: any = {};
  let op = "select";
  let payload: unknown = null;
  for (const m of ["select", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or", "limit", "order", "range", "single", "maybeSingle", "contains", "ilike", "match"]) {
    q[m] = () => q;
  }
  q.insert = (row: unknown) => { op = "insert"; payload = row; return q; };
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => {
    if (table === "client_users") return { data: [{ client_id: TENANT, role: "owner", title: null, access: null }], error: null };
    if (table === "app_operators") return { data: null, error: null };
    if (table === "client_configs") return { data: { client_id: TENANT }, error: null };
    if (table === "client_settings") return { data: null, error: null };
    if (table === "app_errors") { if (op === "insert") inserted.push(payload); return { data: null, error: null }; }
    return { data: null, error: { code: "XX000", message: PAST_THE_GATE } };
  }).then(ok, bad);
  return q;
}

async function call(handler: (req: Request) => Promise<Response>, fn: string, action: string, world: World) {
  const inserted: any[] = [];
  const rpcCalls: string[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  stubAuth.user = { id: "00000000-0000-4000-8000-00000000f001", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(table, inserted);
  stubPlanRead.on = true;
  stubRpc.rpc = world.rpcMissing ? null : (name: string) => {
    rpcCalls.push(name);
    if (name === "access_for_server") {
      if (world.rpcError) return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
      return Promise.resolve({ data: world.answer ?? null, error: null });
    }
    return Promise.resolve({ data: null, error: { code: "XX000", message: PAST_THE_GATE } });
  };
  try {
    const res = await handler(new Request(`https://stub.supabase.co/functions/v1/${fn}`, {
      method: "POST",
      headers: { "authorization": "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action }),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    // Report rows are awaited by resolveTenant; this turn of the loop is only a margin.
    await new Promise((r) => setTimeout(r, 5));
    const refusedByPlan = res.status === 403 && body && body.code === "module_off";
    return { status: res.status, body, refusedByPlan, rpcCalls, reports: inserted.filter((r) => r && r.code === "module_would_refuse") };
  } finally {
    [console.error, console.warn, console.log] = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const ALL_HIDDEN = { build_schedule: "hidden", delivery_schedule: "hidden", repairs: "hidden", designer: "on", contacts: "on" };

// ── 2. block ────────────────────────────────────────────────────────────────────────────────
Deno.test("block: an action on a tab the company lacks is refused with module_off; one it has goes through", async () => {
  const lacks = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: ALL_HIDDEN } });
  assertEquals([lacks.status, lacks.body.code, lacks.body.error], [403, "module_off", MODULE_REFUSAL]);
  const has = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: { ...ALL_HIDDEN, build_schedule: "on" } } });
  assertEquals(has.refusedByPlan, false, JSON.stringify(has.body));
  assert(has.status !== 403, `past the plan check the handler should have run: ${has.status} ${JSON.stringify(has.body)}`);
});

Deno.test("block: locked is refused too, and an unknown action is still an unknown action", async () => {
  const lockedTab = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "block", modules: { ...ALL_HIDDEN, build_schedule: "locked" } } });
  assertEquals(lockedTab.refusedByPlan, true);
  const unknown = await call(SCHEDULE, "portal-schedule", "no_such_action", { answer: { mode: "block", modules: ALL_HIDDEN } });
  assertEquals(unknown.refusedByPlan, false);
  assert(unknown.status === 400 || unknown.status === 403, String(unknown.status));
  assertEquals(unknown.rpcCalls.includes("access_for_server"), false, "an action with no gate must be refused before the map is ever read");
});

// Stage D. Stage C gave every Jack action but `enabled` the Jack tab, so a company that had Jack and
// lost the tab could no longer read its own record, dismiss a card, or put back a change it had
// approved: against jack-agent/agent.ts rule 4 ("Undo keeps working on purpose"). Through Jack's real
// door: the door refuses none of those five and reads no map for them; new work still is refused.
// Two things this does NOT say. `status` itself asks the map once it has read that Jack is switched
// on, to tell the page whether a message would be refused: this harness's database cannot answer the
// switch, so it never gets that far here, and jack-agent/handler_test.ts holds it. And Undo getting
// past THIS door is not the put-back landing: it saves through portal-settings and portal-schedule,
// whose own doors still ask for the tab (jack-agent/plan_test.ts holds what happens then).
const JACK = await load("jack-agent");
Deno.test("block: without the Jack tab Jack's door still lets a company read what he did, dismiss a card and press Undo; new work is refused", async () => {
  const noJack = { mode: "block", modules: { ...ALL_HIDDEN, jack: "hidden" } };
  const id = "00000000-0000-4000-8000-00000000d001";
  // call() sends { action } only; some of these also want a card id, which changes nothing the gate
  // reads. Past the gate this harness's database fails every table, and Jack's store throws on that:
  // a throw is "got past the gate", the same thing the marker says for the other functions.
  const door = (req: Request) => req.json()
    .then((b) => JACK(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ ...b, id, hash: "h" }) })))
    .catch(() => new Response(JSON.stringify({ error: PAST_THE_GATE }), { status: 500 }));
  const ask = (action: string) => call(door, "jack-agent", action, { answer: noJack });
  for (const action of ["status", "activity", "proposal_get", "proposal_cancel", "proposal_undo", "enabled"]) {
    const r = await ask(action);
    assertEquals(r.refusedByPlan, false, `${action}: ${JSON.stringify(r.body)}`);
    assertEquals(r.rpcCalls.includes("access_for_server"), false, `${action} read the map though it carries no tab`);
  }
  for (const action of ["send", "chat", "new", "sheet_start", "proposal_answer", "proposal_approve", "set_switches", "memory_pick", "memory_set", "memory_forget"]) {
    const r = await ask(action);
    assertEquals([r.status, r.body.code, r.body.error], [403, "module_off", MODULE_REFUSAL], action);
  }
  // With the tab on, nothing of Jack's is refused at the door.
  const has = await call(door, "jack-agent", "send", { answer: { mode: "block", modules: { ...ALL_HIDDEN, jack: "on" } } });
  assertEquals(has.refusedByPlan, false);
});

// ── 3. report ───────────────────────────────────────────────────────────────────────────────
Deno.test("report: nothing is refused, and what would have been is filed once as an info row", async () => {
  const w = { answer: { mode: "report", modules: ALL_HIDDEN } };
  const first = await call(SCHEDULE, "portal-schedule", "job_activity", w);
  assertEquals(first.refusedByPlan, false);
  assertEquals(first.reports.length, 1, JSON.stringify(first.reports));
  const row = first.reports[0];
  assertEquals([row.severity, row.source, row.client_id], ["info", "edge:portal-schedule", TENANT]);
  assert(String(row.message).includes("job_activity") && String(row.message).includes("build_schedule"), row.message);
  assertEquals(row.context.tabs, ["build_schedule"]);
  // The same action again from the same isolate: allowed again, not filed again.
  const second = await call(SCHEDULE, "portal-schedule", "job_activity", w);
  assertEquals([second.refusedByPlan, second.reports.length], [false, 0]);
  // A tab the company has is not reported at all.
  const fine = await call(SCHEDULE, "portal-schedule", "build_board", { answer: { mode: "report", modules: { ...ALL_HIDDEN, build_schedule: "on" } } });
  assertEquals(fine.reports.length, 0);
});

// ── 4. not named, or the database cannot answer ─────────────────────────────────────────────
Deno.test("not named, a failed read, a missing function, a malformed answer: the old rules, nothing refused, nothing filed", async () => {
  const before = await call(SCHEDULE, "portal-schedule", "build_board", { answer: null });
  for (const world of [
    { answer: null }, { rpcError: true }, { rpcMissing: true },
    { answer: { mode: "block", modules: {} } }, { answer: { mode: "blok", modules: ALL_HIDDEN } }, { answer: { modules: ALL_HIDDEN } },
    { answer: { mode: "block", modules: { build_schedule: "nope" } } },
  ] as World[]) {
    const r = await call(SCHEDULE, "portal-schedule", "build_board", world);
    assertEquals([r.refusedByPlan, r.status, r.reports.length], [false, before.status, 0], JSON.stringify(world));
  }
});

// ── 5. the paid-feature checks ──────────────────────────────────────────────────────────────
const billingAdmin = (rpcAnswer: unknown, settings: Record<string, unknown> | null = null) => ({
  rpc: () => Promise.resolve({ data: rpcAnswer, error: null }),
  from: (t: string) => {
    const q: any = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve({ data: t === "client_settings" ? settings : null, error: null });
    q.then = (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad);
    return q;
  },
});

Deno.test("hasPaidFeature: by the map in block mode; by billing otherwise", async () => {
  const blockWith = (m: Record<string, string>) => billingAdmin({ mode: "block", modules: m });
  // A plan gives the contact list with no Customer Hub subscription: the feature check must not refuse it.
  assertEquals(await hasPaidFeature(blockWith({ contacts: "on" }), "co", "crm"), true);
  assertEquals(await hasPaidFeature(blockWith({ contacts: "locked", pipelines: "hidden" }), "co", "crm"), false);
  assertEquals(await hasPaidFeature(blockWith({ quickbooks: "on" }), "co", "quickbooks_sync"), true);
  assertEquals(await hasPaidFeature(blockWith({ rtp: "off" }), "co", "on_demand_pricing"), false);
  // On the map, Non-billable no longer answers for a tab the map says is off.
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "block", modules: { rtp: "off" } }, { billing_exempt: true }), "co", "on_demand_pricing"), false);
  // Report mode and not named: billing decides, exactly as before (no subscriptions here = false; Non-billable = true).
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "report", modules: { contacts: "on" } }), "co", "crm"), false);
  assertEquals(await hasPaidFeature(billingAdmin(null), "co", "crm"), false);
  assertEquals(await hasPaidFeature(billingAdmin(null, { billing_exempt: true }), "co", "crm"), true);
  // A feature with no tabs is never answered by the map.
  assertEquals(await hasPaidFeature(billingAdmin({ mode: "block", modules: { contacts: "on" } }, { internal_account: true }), "co", "smartbuild_sync"), true);
});

Deno.test("usableFeatureSet: mapped features by the map, the rest by billing, merged", async () => {
  const set = async (admin: unknown, f: string[]) => [...(await usableFeatureSet(admin, "co", f))].sort();
  const block = billingAdmin({ mode: "block", modules: { contacts: "on", quickbooks: "hidden", rtp: "on" } });
  assertEquals(await set(block, ["crm", "quickbooks_sync", "on_demand_pricing", "smartbuild_sync"]), ["crm", "on_demand_pricing"]);
  // Ours: the unmapped feature comes from billing's "everything", the mapped ones still from the map.
  const ours = billingAdmin({ mode: "block", modules: { contacts: "on", quickbooks: "hidden" } }, { internal_account: true });
  assertEquals(await set(ours, ["crm", "quickbooks_sync", "smartbuild_sync"]), ["crm", "smartbuild_sync"]);
  // Not named: unchanged.
  assertEquals(await set(billingAdmin(null, { billing_exempt: true }), ["crm", "quickbooks_sync"]), ["crm", "quickbooks_sync"]);
  assertEquals(await set(billingAdmin(null), ["crm"]), []);
});
