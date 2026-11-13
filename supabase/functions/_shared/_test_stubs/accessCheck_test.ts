// THE TAB CHECK FOR CODE OUTSIDE resolveTenant (_shared/accessCheck.ts, plans as data stage D).
//
// portal-commissions signs its own callers in and crm-rules-tick has no caller at all, so neither
// passes through resolveTenant's plan check. moduleVerdict is what they ask instead. A wrong answer
// here is a company refused its commissions ledger, or its automations silently stopped, so every
// branch is held:
//
//   1. no tabs: ok, and the map is never read;
//   2. not named, a failed read, a thrown read, a malformed answer: ok, nothing filed;
//   3. block: refuse unless one of the tabs is exactly "on" ("locked" is not);
//   4. report: ok, one info row per company, function and action, in resolveTenant's own shape;
//   5. it never throws, whatever it is handed;
//   6. the cache switch (accessEnforce.ts cachesHere) is on for the edge runtime and the Cloudflare
//      Worker, and off under deno and node.
//
// logEdgeError writes through createClient, which the import map swaps for supabase_stub.ts, so the
// rows land in stubDb.from. Tenants are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb } from "./supabase_stub.ts";
import { MODULE_REFUSAL, moduleVerdict } from "../accessCheck.ts";
import { cachesHere, MODULE_REFUSAL as ENFORCE_REFUSAL } from "../accessEnforce.ts";

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };

/** A service client that answers access_for_server with `answer` (or fails as told) and counts. */
function adminFor(answer: unknown, how: "ok" | "error" | "throw" | "reject" = "ok") {
  const calls: [string, unknown][] = [];
  return {
    calls,
    rpc: (name: string, args: unknown) => {
      calls.push([name, args]);
      if (how === "throw") throw new Error("network");
      if (how === "reject") return Promise.reject(new Error("timeout"));
      if (how === "error") return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
      return Promise.resolve({ data: answer, error: null });
    },
  };
}

/** Runs `work` with the logger able to write, and hands back the app_errors rows it wrote. */
async function withRows<T>(work: () => Promise<T>, insertFails = false): Promise<{ out: T; rows: any[] }> {
  const rows: any[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn];
  console.error = console.warn = () => {};
  stubDb.from = (table: string) => ({
    insert: (row: unknown) => {
      if (insertFails) throw new Error("app_errors is down");
      if (table === "app_errors") rows.push(row);
      return Promise.resolve({ data: null, error: null });
    },
  });
  try {
    return { out: await work(), rows };
  } finally {
    [console.error, console.warn] = quiet;
    stubDb.from = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const block = (modules: Record<string, string>) => ({ mode: "block", modules });
const report = (modules: Record<string, string>) => ({ mode: "report", modules });

Deno.test("the refusal sentence callers answer with is resolveTenant's own", () => {
  assertEquals(MODULE_REFUSAL, ENFORCE_REFUSAL);
});

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("an action with no tab is ok, and the map is never read for it", async () => {
  const admin = adminFor(block({ commissions: "hidden" }));
  const { out, rows } = await withRows(() => moduleVerdict(admin, "acme-sheds", "portal-commissions", "list", []));
  assertEquals(out, "ok");
  assertEquals([admin.calls.length, rows.length], [0, 0]);
});

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("not named, a failed read, a thrown read, a malformed answer: ok, and nothing is filed", async () => {
  const worlds: [string, ReturnType<typeof adminFor>][] = [
    ["not named", adminFor(null)],
    ["the function is missing", adminFor(null, "error")],
    ["the call throws", adminFor(null, "throw")],
    ["the call rejects", adminFor(null, "reject")],
    ["an empty map", adminFor(block({}))],
    ["an unknown mode", adminFor({ mode: "enforce", modules: { commissions: "hidden" } })],
    ["a bad state", adminFor(block({ commissions: "nope" }))],
  ];
  for (const [name, admin] of worlds) {
    const { out, rows } = await withRows(() => moduleVerdict(admin, "acme-sheds", "portal-commissions", "compute", ["commissions"]));
    assertEquals([out, rows.length], ["ok", 0], name);
  }
});

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("block: refused unless one of the tabs is exactly on; locked, hidden, off and missing are not had", async () => {
  const ask = async (modules: Record<string, string>, tabs: string[]) =>
    (await withRows(() => moduleVerdict(adminFor(block(modules)), "acme-sheds", "portal-commissions", "compute", tabs))).out;
  assertEquals(await ask({ commissions: "on" }, ["commissions"]), "ok");
  for (const state of ["locked", "hidden", "off"]) assertEquals(await ask({ commissions: state, designer: "on" }, ["commissions"]), "refuse", state);
  assertEquals(await ask({ designer: "on" }, ["commissions"]), "refuse", "a tab the map does not mention");
  // An action two tabs share is allowed with either.
  assertEquals(await ask({ build_schedule: "hidden", delivery_schedule: "on" }, ["build_schedule", "delivery_schedule"]), "ok");
  assertEquals(await ask({ build_schedule: "hidden", delivery_schedule: "locked" }, ["build_schedule", "delivery_schedule"]), "refuse");
});

Deno.test("block refuses without filing anything: the caller's 403 is the record", async () => {
  const { out, rows } = await withRows(() => moduleVerdict(adminFor(block({ automations: "off", contacts: "on" })), "block-co", "crm-rules-tick", "send", ["automations"]));
  assertEquals([out, rows.length], ["refuse", 0]);
});

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("report: nothing is refused, and what would have been is filed once, in resolveTenant's shape", async () => {
  const admin = adminFor(report({ commissions: "locked", designer: "on" }));
  const req = new Request("https://stub.supabase.co/functions/v1/portal-commissions", { method: "POST", headers: { "user-agent": "harness/1.0" } });
  const first = await withRows(() => moduleVerdict(admin, "report-co-one", "portal-commissions", "compute", ["commissions"], req));
  assertEquals(first.out, "ok");
  assertEquals(first.rows.length, 1, JSON.stringify(first.rows));
  const row = first.rows[0];
  assertEquals([row.source, row.severity, row.code, row.client_id], ["edge:portal-commissions", "info", "module_would_refuse", "report-co-one"]);
  assertEquals(row.message, "Report only: compute would be refused (needs commissions).");
  assertEquals(row.context, { action: "compute", tabs: ["commissions"], states: { commissions: "locked" } });
  assertEquals([row.url, row.user_agent], ["/functions/v1/portal-commissions", "harness/1.0"]);

  // The same action again from this isolate: allowed again, not filed again.
  const second = await withRows(() => moduleVerdict(admin, "report-co-one", "portal-commissions", "compute", ["commissions"], req));
  assertEquals([second.out, second.rows.length], ["ok", 0]);
  // Another action, another company, and a caller with no request (a clock) each get their own row.
  const other = await withRows(() => moduleVerdict(admin, "report-co-one", "portal-commissions", "mark_paid", ["commissions"], req));
  assertEquals(other.rows.length, 1);
  const clock = await withRows(() => moduleVerdict(adminFor(report({ automations: "hidden", sms: "hidden" })), "report-co-two", "crm-rules-tick", "send", ["automations", "sms"]));
  assertEquals([clock.out, clock.rows.length], ["ok", 1]);
  assertEquals(clock.rows[0].message, "Report only: send would be refused (needs automations or sms).");
  assertEquals(clock.rows[0].context.states, { automations: "hidden", sms: "hidden" });
  assertEquals(clock.rows[0].url, null);
});

Deno.test("report: a tab the company has is not filed at all", async () => {
  const { out, rows } = await withRows(() => moduleVerdict(adminFor(report({ commissions: "on" })), "report-co-three", "portal-commissions", "compute", ["commissions"]));
  assertEquals([out, rows.length], ["ok", 0]);
});

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("it never throws: a broken client, a broken logger and nonsense arguments are all ok", async () => {
  assertEquals((await withRows(() => moduleVerdict(null, "acme-sheds", "portal-commissions", "compute", ["commissions"]))).out, "ok");
  assertEquals((await withRows(() => moduleVerdict({}, "acme-sheds", "portal-commissions", "compute", ["commissions"]))).out, "ok");
  assertEquals((await withRows(() => moduleVerdict(adminFor(block({ commissions: "hidden" })), "", "portal-commissions", "compute", ["commissions"]))).out, "ok", "no company, no refusal");
  assertEquals((await withRows(() => moduleVerdict(adminFor(block({ commissions: "hidden" })), "acme-sheds", "portal-commissions", "compute", null as any))).out, "ok");
  // The report row cannot be written: the action still goes ahead.
  const broken = await withRows(() => moduleVerdict(adminFor(report({ commissions: "hidden" })), "report-co-four", "portal-commissions", "compute", ["commissions"]), true);
  assertEquals(broken.out, "ok");
  // A map whose getter throws stands in for anything unforeseen inside the check itself.
  const trap = { rpc: () => Promise.resolve({ data: new Proxy({}, { get() { throw new Error("boom"); } }), error: null }) };
  assertEquals((await withRows(() => moduleVerdict(trap, "acme-sheds", "portal-commissions", "compute", ["commissions"]))).out, "ok");
});

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("the 30-second cache is on for the edge runtime and the Cloudflare Worker, and off under deno and node", () => {
  assertEquals(cachesHere({ EdgeRuntime: { waitUntil() {} } }), true, "Supabase's edge runtime");
  assertEquals(cachesHere({ navigator: { userAgent: "Cloudflare-Workers" } }), true, "the phone Worker");
  assertEquals(cachesHere({ navigator: { userAgent: "Deno/2.9.2" } }), false, "deno test");
  assertEquals(cachesHere({ navigator: { userAgent: "Node.js/22" } }), false, "vitest on node");
  assertEquals(cachesHere({}), false, "node without a navigator");
  assertEquals(cachesHere(null), false);
  assertEquals(cachesHere({ get navigator() { throw new Error("no"); } }), false, "a navigator that cannot be read");
  // And here, now: this test process must not be caching, or the tests above depend on their order.
  assertEquals(cachesHere(globalThis), false);
});

Deno.test("under the tests every ask is its own read: nothing is remembered between two calls", async () => {
  const admin = adminFor(block({ commissions: "on" }));
  await withRows(async () => {
    await moduleVerdict(admin, "acme-sheds", "portal-commissions", "compute", ["commissions"]);
    await moduleVerdict(admin, "acme-sheds", "portal-commissions", "compute", ["commissions"]);
  });
  assertEquals(admin.calls, [["access_for_server", { p_client_id: "acme-sheds" }], ["access_for_server", { p_client_id: "acme-sheds" }]]);
  assert(admin.calls.length === 2);
});
