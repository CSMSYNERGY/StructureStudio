// Plans as data in the phone Worker (src/plan.ts, stage D; migrations 386 to 388).
//
// THE CONTRACT these tests hold, point by point:
//   1. nobody named (today), or any failed, malformed or slow plan read: exactly the old behaviour,
//      and while nobody is named not one access_for_server request is made;
//   2. report mode refuses nothing and hides nothing, and files one info row per company and action;
//   3. block mode: a tab that is not exactly "on" is not had;
//   4. a plan only stops NEW work: 911 and its callback, an inbound caller (voicemail, never a
//      drop), a person's own settings and reading a thread all carry on.
//
// ⚠️ PUBLIC REPO: every company here is made up (demo-tenant, acme-sheds, ridge-co).

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adminClient } from "../src/db";
import { installDenoShim } from "../src/env";
import {
  APP_PLAN_MS, EMERGENCY_WINDOW_MS, VOICE_PLAN_MS, _resetPlanCaches, emergencyWindowOpen, planFor, planNamed, planNamedFromValue, planNamedSoon,
  planRefuses, planReport, planVerdict,
} from "../src/plan";
import { NO_TEXTING_PLAN } from "../src/routes/sms";
import {
  Auth, BUSINESS_NUMBER, CALL_SID, CLIENT, CONTACT_1, CUSTOMER, FakeCtx, FakeNet, USER_A, USER_B,
  appRequest, blockPlan, call, callerCtx, clientsIn, filter, jsonRes, makeEnv, member, numbersIn, pgTable, phoneListSearch,
  planModules, reportPlan, routeInfo, servePlan, twilioPost, wouldRefuseRows,
} from "./helpers";

const planReads = (net: FakeNet) => net.rpcCalls("access_for_server");
const namedReads = (net: FakeNet) => net.reads("access_config");
/** A request that never gets its answer: a database that has stopped responding. */
const never = () => new Promise<Response>(() => {});
/** An answer that does come, but only after `ms`: a database that is slow rather than gone. */
const late = (ms: number, answer: unknown) => () => new Promise<unknown>((r) => setTimeout(() => r(answer), ms));
/**
 * A request whose waitUntil work is not waited for. The call webhooks and /token hand a plan read
 * that passed its bound to waitUntil; one that NEVER answers would hold call()'s settle() for ever
 * (the runtime itself gives up on such work after 30 seconds).
 */
class LeftRunning extends FakeCtx {
  override async settle(): Promise<void> {}
}
const warned = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
/** The console lines plan.ts writes about PLAN reads (access_config, access_for_server) that passed their bound. */
const slowLines = () => warned().filter((l) => l.includes("a plan read passed its"));
/**
 * The 911 window read's own line for the same thing. Its own, because whoever reads "a plan read
 * passed its bound" goes looking at the two plan reads, and here they were fine: it was phone_calls
 * that was slow, and a blocked company was let through on it.
 */
const windowSlowLine = (ms: number) => `[phone-api] the 911 callback window read passed its ${ms} ms bound; the plan refuses nobody meanwhile`;
const windowSlowLines = () => warned().filter((l) => l.includes("911 callback window read passed its"));
const admin = () => adminClient(makeEnv());

// ── The 911 callback window (emergencyWindowOpen) ───────────────────────────────────
/** The window's own read of phone_calls, told from every other read of that table by its is_emergency filter. */
const emergencyReads = (net: FakeNet) => net.reads("phone_calls").filter((s) => s.url.searchParams.has("is_emergency"));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
/** A 911 call USER_A placed from the demo tenant 20 minutes ago, as /voice/outbound writes the row. */
const emergencyCall = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-00000000e911", client_id: CLIENT, placed_by: USER_A, direction: "out", is_emergency: true,
  started_at: minutesAgo(20), ...over,
});
/**
 * phone_calls answering the window's read the way the database would: only the rows that pass the
 * query's OWN filters (pgTable), so a filter the Worker forgot (whose call, which company, how long
 * ago) shows up as a wrong answer instead of a passing test. Every other read of the table gets
 * no rows, as app() serves it.
 */
function emergencyCalls(net: FakeNet, rows: Record<string, unknown>[]): FakeNet {
  const table = pgTable(rows);
  return net.rest("GET", "phone_calls", (s) => (s.url.searchParams.has("is_emergency") ? table(s) : []));
}
/** The same table with the window's read answered by `reply` (a fault, or nothing at all). */
function emergencyReadIs(net: FakeNet, reply: () => unknown): FakeNet {
  return net.rest("GET", "phone_calls", (s) => (s.url.searchParams.has("is_emergency") ? reply() : []));
}
/** Rows the window's read must never count, each one filter away from the call that opens it. */
const NOT_THIS_WINDOW: [string, Record<string, unknown>][] = [
  ["a teammate's 911 call", { placed_by: USER_B }],
  ["this person's 911 call 61 minutes ago", { started_at: minutesAgo(61) }],
  ["a 911 call in another company", { client_id: "acme-sheds" }],
  ["an emergency row that is not an outbound call", { direction: "in" }],
  ["a 911 attempt that was refused, so no dispatcher has a number to call back (is_emergency false)", { is_emergency: false }],
];

// ── Who is named (access_config.enforce), read the way migration 388 reads it ────────

describe("planNamedFromValue: the enforce row, with 388's tolerance", () => {
  const sets = (v: unknown) => {
    const n = planNamedFromValue(v);
    return { all: n.all, block: [...n.block], report: [...n.report] };
  };
  const NOBODY = { all: false, block: [], report: [] };

  it("names the companies in server_clients (block) and server_report (report), and everyone under server_all", () => {
    expect(sets({ all: false, clients: [], server_clients: ["acme-sheds"], server_report: ["acme-sheds", "ridge-co"] }))
      .toEqual({ all: false, block: ["acme-sheds"], report: ["acme-sheds", "ridge-co"] });
    expect(sets({ server_all: true, server_report: ["ridge-co"] })).toEqual({ all: true, block: [], report: ["ridge-co"] });
  });

  it("the PORTAL's lists (387's all and clients) never name anyone for the server", () => {
    expect(sets({ all: true, clients: ["acme-sheds"] })).toEqual(NOBODY);
  });

  it.each([
    ["server_all as a string", { server_all: "true" }],
    ["server_all as 1", { server_all: 1 }],
    ["server_clients as a string", { server_clients: "acme-sheds" }],
    ["server_clients as an object", { server_clients: { "acme-sheds": true } }],
    ["server_report as a string", { server_report: "acme-sheds" }],
    ["an empty object", {}],
    ["a bare array", ["acme-sheds"]],
    ["a string", "acme-sheds"],
    ["null (a missing row)", null],
    ["nothing at all", undefined],
  ])("malformed (%s) names nobody", (_l, v) => {
    expect(sets(v)).toEqual(NOBODY);
  });

  it("only the strings in a list count, as SQL's ? sees them", () => {
    expect(sets({ server_clients: ["acme-sheds", 7, null, { id: "ridge-co" }, ["ridge-co"]] }).block).toEqual(["acme-sheds"]);
  });

  it("one malformed key does not hide a good one (each is read on its own, as the SQL does)", () => {
    expect(sets({ server_all: "yes", server_clients: "acme-sheds", server_report: ["ridge-co"] })).toEqual({ all: false, block: [], report: ["ridge-co"] });
  });
});

describe("planNamed: one cached read of who is named", () => {
  it("reads the enforce row once and keeps it for 30 seconds", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    expect([...(await planNamed(admin())).block]).toEqual(["acme-sheds"]);
    await planNamed(admin());
    expect(namedReads(net)).toHaveLength(1);
    expect(filter(namedReads(net)[0], "key")).toBe("enforce");
    expect(namedReads(net)[0].url.searchParams.get("select")).toBe("value");
    // 29 seconds on: still the kept answer. 31: asked again.
    await planNamed(admin(), Date.now() + 29_000);
    expect(namedReads(net)).toHaveLength(1);
    await planNamed(admin(), Date.now() + 31_000);
    expect(namedReads(net)).toHaveLength(2);
  });

  it("no row at all (a database before 387) names nobody, and that answer is kept too", async () => {
    const net = new FakeNet().install();
    const n = await planNamed(admin());
    expect([n.all, n.block.size, n.report.size]).toEqual([false, 0, 0]);
    await planNamed(admin());
    expect(namedReads(net)).toHaveLength(1);
  });

  it("a failed read names nobody and is NOT kept: the next request asks again", async () => {
    const net = new FakeNet().install();
    net.rest("GET", "access_config", () => jsonRes({ message: "boom" }, 500));
    expect((await planNamed(admin())).block.size).toBe(0);
    net.rest("GET", "access_config", () => [{ value: { server_clients: ["acme-sheds"] } }]);
    expect([...(await planNamed(admin())).block]).toEqual(["acme-sheds"]);
    expect(namedReads(net)).toHaveLength(2);
  });

  it("a read that throws names nobody and never rejects", async () => {
    new FakeNet().install();
    const broken = { from: () => { throw new Error("no database"); } } as unknown as ReturnType<typeof adminClient>;
    await expect(planNamed(broken)).resolves.toMatchObject({ all: false });
    await expect(planFor(broken, "acme-sheds")).resolves.toBeNull();
  });

  it("the early start and the request that then needs the answer are ONE read, handed along by the request itself", async () => {
    const net = servePlan(new FakeNet().install(), { server_report: ["acme-sheds"] });
    const named = planNamedSoon(admin());
    expect((await planFor(admin(), "acme-sheds", { named }))?.mode).toBe("report");
    expect(namedReads(net)).toHaveLength(1);
    // The answer is kept: the next request's early start is no read at all.
    await planFor(admin(), "acme-sheds", { named: planNamedSoon(admin()) });
    expect(namedReads(net)).toHaveLength(1);
  });

  it("an early start nobody waits for (the request refused first) is not inherited: a later request makes its own read", async () => {
    const net = new FakeNet().install();
    net.rest("GET", "access_config", never);
    void planNamedSoon(admin());
    net.rest("GET", "access_config", () => [{ value: { server_clients: ["acme-sheds"] } }]);
    expect([...(await planNamed(admin())).block]).toEqual(["acme-sheds"]);
    expect(namedReads(net)).toHaveLength(2);
  });
});

describe("planFor: one company's answer", () => {
  it("nobody named: null, and access_for_server is never asked", async () => {
    const net = new FakeNet().install();
    expect(await planFor(admin(), "acme-sheds")).toBeNull();
    expect(await planFor(admin(), "ridge-co")).toBeNull();
    expect(planReads(net)).toEqual([]);
    expect(namedReads(net)).toHaveLength(1);
  });

  it("a named company: one access_for_server call with its id, kept 30 seconds; a company not named asks nothing", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] }, { "acme-sheds": planModules({ sms: "hidden" }) });
    const plan = await planFor(admin(), "acme-sheds");
    expect(plan).toEqual({ mode: "block", modules: planModules({ sms: "hidden" }) });
    expect(await planFor(admin(), "acme-sheds")).toEqual(plan);
    expect(await planFor(admin(), "ridge-co")).toBeNull();
    expect(planReads(net).map((r) => r.json)).toEqual([{ p_client_id: "acme-sheds" }]);
  });

  it("server_all names everyone, a company the lists never mention included", async () => {
    const net = servePlan(new FakeNet().install(), { server_all: true });
    expect((await planFor(admin(), "ridge-co"))?.mode).toBe("block");
    expect(planReads(net)).toHaveLength(1);
  });

  it("report mode comes back as report", async () => {
    servePlan(new FakeNet().install(), { server_report: ["acme-sheds"] });
    expect((await planFor(admin(), "acme-sheds"))?.mode).toBe("report");
  });

  it("no company id is null with nothing read", async () => {
    const net = servePlan(new FakeNet().install(), { server_all: true });
    expect(await planFor(admin(), "")).toBeNull();
    expect(net.seen).toEqual([]);
  });

  it("a failed access_for_server is null and NOT kept", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500));
    expect(await planFor(admin(), "acme-sheds")).toBeNull();
    net.rpc("access_for_server", () => ({ mode: "block", modules: planModules() }));
    expect((await planFor(admin(), "acme-sheds"))?.mode).toBe("block");
    expect(planReads(net)).toHaveLength(2);
  });

  it.each([
    ["an unknown mode", { mode: "enforce", modules: planModules() }],
    ["no modules", { mode: "block" }],
    ["an empty map", { mode: "block", modules: {} }],
    ["a tab with a state nobody defined", { mode: "block", modules: { phone: "maybe" } }],
    ["a bare string", "block"],
  ])("a malformed answer (%s) is null: the old rules", async (_l, answer) => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    net.rpc("access_for_server", () => answer);
    expect(await planFor(admin(), "acme-sheds")).toBeNull();
  });

  it("a read that never answers is null once the time is up, and the wait is bounded", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    net.rpc("access_for_server", never);
    const t0 = Date.now();
    expect(await planFor(admin(), "acme-sheds", { timeoutMs: 40 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    // The same for the "who is named" read. A fresh isolate first: the read above kept who is
    // named for 30 seconds, and with that answer in hand the hung read below would never be made.
    _resetPlanCaches();
    net.rest("GET", "access_config", never);
    const t1 = Date.now();
    expect(await planFor(admin(), "ridge-co", { timeoutMs: 40 })).toBeNull();
    const took = Date.now() - t1;
    expect(took).toBeGreaterThanOrEqual(30);
    expect(took).toBeLessThan(1000);
    // The hung read really was asked (the second of the two), and nothing came after it.
    expect(namedReads(net)).toHaveLength(2);
    expect(planReads(net)).toHaveLength(1);
  });

  it("a read that passes its bound says so on the console: once a minute per isolate, with how many there were", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    net.rpc("access_for_server", never);
    expect(await planFor(admin(), "acme-sheds", { timeoutMs: 30 })).toBeNull();
    expect(slowLines()).toEqual(["[phone-api] a plan read passed its 30 ms bound (1 since the last line like this); the old rules applied meanwhile"]);
    await planFor(admin(), "acme-sheds", { timeoutMs: 30 });
    await planFor(admin(), "acme-sheds", { timeoutMs: 30 });
    expect(slowLines()).toHaveLength(1);
    // A minute on, the next one also counts the two nobody was told about.
    const then = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(then);
    await planFor(admin(), "acme-sheds", { timeoutMs: 30 });
    expect(slowLines()).toHaveLength(2);
    expect(slowLines()[1]).toContain("(3 since the last line like this)");
  });

  it("a read that answers in time, fails or is malformed writes no such line", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds", "ridge-co"] });
    await planFor(admin(), "acme-sheds", { timeoutMs: 500 });
    net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500));
    await planFor(admin(), "ridge-co", { timeoutMs: 500 });
    await new Promise((r) => setTimeout(r, 20));
    expect(slowLines()).toEqual([]);
  });

  it("keep (the request's waitUntil) is handed the read only when it passed its bound, and when that read lands its answer is kept", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] }, { "acme-sheds": planModules({ phone: "hidden" }) });
    const kept: Promise<unknown>[] = [];
    const keep = (read: Promise<unknown>) => { kept.push(read); };
    // In time: there is nothing to keep going.
    expect((await planFor(admin(), "acme-sheds", { timeoutMs: 500, keep }))?.mode).toBe("block");
    expect(kept).toEqual([]);
    _resetPlanCaches();
    // Slow: the caller gets null at the bound, and the read is handed over.
    net.rpc("access_for_server", late(120, { mode: "block", modules: planModules({ phone: "hidden" }) }));
    expect(await planFor(admin(), "acme-sheds", { timeoutMs: 30, keep })).toBeNull();
    expect(kept).toHaveLength(1);
    await kept[0];
    // It landed: the next request is answered from what it left, with no read of its own.
    net.rpc("access_for_server", never);
    expect((await planFor(admin(), "acme-sheds", { timeoutMs: 30 }))?.modules.phone).toBe("hidden");
    expect(planReads(net)).toHaveLength(2);
  });

  it("a keep that throws (the request already answered) changes nothing", async () => {
    const net = servePlan(new FakeNet().install(), { server_clients: ["acme-sheds"] });
    net.rpc("access_for_server", never);
    await expect(planFor(admin(), "acme-sheds", { timeoutMs: 30, keep: () => { throw new Error("the request is over"); } })).resolves.toBeNull();
    expect(slowLines()).toHaveLength(1);
  });

  it("the two bounds: a ringing phone waits far less than a person does", () => {
    expect(VOICE_PLAN_MS).toBeLessThanOrEqual(500);
    expect(APP_PLAN_MS).toBeGreaterThan(VOICE_PLAN_MS);
  });
});

describe("planVerdict, planReport and planRefuses", () => {
  const block = (m: Record<string, string>) => ({ mode: "block" as const, modules: planModules(m) });
  const report = (m: Record<string, string>) => ({ mode: "report" as const, modules: planModules(m) });

  it("only \"on\" is had: locked, hidden, off and a missing tab are all refused in block mode", () => {
    expect(planVerdict(block({}), ["phone"])).toBe("ok");
    for (const state of ["locked", "hidden", "off"]) expect(planVerdict(block({ phone: state }), ["phone"])).toBe("refuse");
    expect(planVerdict({ mode: "block", modules: { contacts: "on" } }, ["phone"])).toBe("refuse");
  });

  it("no plan answer is ok, whatever the tab; report mode never refuses", () => {
    expect(planVerdict(null, ["phone"])).toBe("ok");
    expect(planVerdict(undefined, ["sms"])).toBe("ok");
    expect(planVerdict(report({ phone: "hidden" }), ["phone"])).toBe("report");
    expect(planVerdict(report({}), ["phone"])).toBe("ok");
  });

  it("report mode files ONE info row per company and action, with the tab's state and nothing about a person", async () => {
    const net = new FakeNet().install();
    installDenoShim(makeEnv()); // the shared logger reads its secrets through it; a request installs it
    net.rest("POST", "app_errors", () => []);
    const plan = report({ sms: "locked" });
    expect(await planRefuses(plan, "acme-sheds", "sms_send", ["sms"])).toBe(false);
    expect(await planRefuses(plan, "acme-sheds", "sms_send", ["sms"])).toBe(false);
    await planReport("acme-sheds", "sms_send", plan, ["sms"]);
    expect(wouldRefuseRows(net)).toEqual([{
      source: "edge:phone-api", severity: "info", code: "module_would_refuse", client_id: "acme-sheds",
      message: "Report only: sms_send would be refused (needs sms).", url: null, user_agent: null,
      context: { action: "sms_send", tabs: ["sms"], states: { sms: "locked" } },
    }]);
    // Another action, and another company, each get their own row.
    await planRefuses(plan, "acme-sheds", "token_texting", ["sms"]);
    await planRefuses(plan, "ridge-co", "sms_send", ["sms"]);
    expect(wouldRefuseRows(net).map((r) => [r.client_id, r.context.action])).toEqual([
      ["acme-sheds", "sms_send"], ["acme-sheds", "token_texting"], ["ridge-co", "sms_send"],
    ]);
  });

  it("block mode answers true and files nothing; a tab that is on answers false and files nothing", async () => {
    const net = new FakeNet().install();
    net.rest("POST", "app_errors", () => []);
    expect(await planRefuses(block({ sms: "hidden" }), "acme-sheds", "sms_send", ["sms"])).toBe(true);
    expect(await planRefuses(block({}), "acme-sheds", "sms_send", ["sms"])).toBe(false);
    expect(await planRefuses(report({}), "acme-sheds", "sms_send", ["sms"])).toBe(false);
    expect(await planRefuses(null, "acme-sheds", "sms_send", ["sms"])).toBe(false);
    expect(net.seen).toEqual([]);
  });

  it("a report row that cannot be written never throws", async () => {
    new FakeNet().install(); // app_errors unmatched: the insert answers 500
    await expect(planRefuses(report({ phone: "off" }), "acme-sheds", "app_route", ["phone"])).resolves.toBe(false);
  });
});

// A plan never refuses 911 or its callback. The callback rings the device of the person who
// dialed, so for the same 60 minutes the database rings only them (migration 266,
// recent_emergency_user) the plan must not take that person's line away.
describe("emergencyWindowOpen: did this person dial 911 in the last 60 minutes", () => {
  it("asks phone_calls the database's own question (migration 266): this company, this person, an outbound emergency call, started inside 60 minutes", async () => {
    const net = emergencyCalls(new FakeNet().install(), [emergencyCall()]);
    const t0 = Date.now();
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
    const reads = emergencyReads(net);
    expect(reads).toHaveLength(1);
    const q = reads[0].url.searchParams;
    expect([...q.keys()].sort()).toEqual(["client_id", "direction", "is_emergency", "limit", "placed_by", "select", "started_at"]);
    expect([q.get("select"), q.get("limit")]).toEqual(["id", "1"]);
    expect([filter(reads[0], "client_id"), filter(reads[0], "placed_by"), filter(reads[0], "direction"), filter(reads[0], "is_emergency")])
      .toEqual([CLIENT, USER_A, "out", "true"]);
    // Strictly after "60 minutes ago", as the SQL's started_at > now() - interval '60 minutes'.
    expect(EMERGENCY_WINDOW_MS).toBe(60 * 60_000);
    expect(q.get("started_at")).toMatch(/^gt\./);
    const cutoff = Date.parse(String(filter(reads[0], "started_at")));
    expect(cutoff).toBeGreaterThanOrEqual(t0 - EMERGENCY_WINDOW_MS);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - EMERGENCY_WINDOW_MS);
  });

  it("59 minutes after the call the window is still open", async () => {
    emergencyCalls(new FakeNet().install(), [emergencyCall({ started_at: minutesAgo(59) })]);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
  });

  it("no such call: the window is shut", async () => {
    emergencyCalls(new FakeNet().install(), []);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(false);
  });

  it.each(NOT_THIS_WINDOW)("%s does not open it", async (_l, over) => {
    emergencyCalls(new FakeNet().install(), [emergencyCall(over)]);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(false);
  });

  it("it is the person's window, not the company's: the teammate who dialed has it, and so has each of two who did", async () => {
    emergencyCalls(new FakeNet().install(), [emergencyCall({ placed_by: USER_B }), emergencyCall({ id: "00000000-0000-4000-8000-00000000e912", started_at: minutesAgo(40) })]);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_B)).toBe(true);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
  });

  // A failed read must never refuse: whatever goes wrong, the answer is "open".
  it("a read that fails is OPEN, and says so on the console", async () => {
    emergencyReadIs(new FakeNet().install(), () => jsonRes({ message: "boom" }, 500));
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
    expect(vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("911"))).toHaveLength(1);
  });

  it("a read that throws is OPEN and never rejects", async () => {
    new FakeNet().install();
    const broken = { from: () => { throw new Error("no database"); } } as unknown as ReturnType<typeof adminClient>;
    await expect(emergencyWindowOpen(broken, CLIENT, USER_A)).resolves.toBe(true);
  });

  it("an answer that is not a list of rows is OPEN", async () => {
    emergencyReadIs(new FakeNet().install(), () => jsonRes({ id: "x" }));
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
  });

  it("a read that never answers is OPEN once the time is up, the wait is bounded, and the console says the WINDOW read passed its bound", async () => {
    const net = emergencyReadIs(new FakeNet().install(), never);
    const t0 = Date.now();
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A, 40)).toBe(true);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(30);
    expect(took).toBeLessThan(1000);
    expect(emergencyReads(net)).toHaveLength(1);
    // Its own line, naming the read that was slow. Not the plan reads' line: those were not slow.
    expect(windowSlowLines()).toEqual([windowSlowLine(40)]);
    expect(slowLines()).toEqual([]);
  });

  // The plan reads' line counts plan reads and is written once a minute. A slow window read must
  // neither add to that count nor use up that minute's line.
  it("a slow window read is not counted as a slow plan read: the next slow plan read still writes its own line, counting one", async () => {
    const net = servePlan(emergencyReadIs(new FakeNet().install(), never), { server_clients: ["acme-sheds"] });
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A, 30)).toBe(true);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A, 30)).toBe(true);
    // Every one is said: each is a person a blocked company's plan would have refused.
    expect(windowSlowLines()).toEqual([windowSlowLine(30), windowSlowLine(30)]);
    expect(slowLines()).toEqual([]);
    // A different bound from the window's above, so this line can only be this read's own.
    net.rpc("access_for_server", never);
    expect(await planFor(admin(), "acme-sheds", { timeoutMs: 45 })).toBeNull();
    expect(slowLines()).toEqual(["[phone-api] a plan read passed its 45 ms bound (1 since the last line like this); the old rules applied meanwhile"]);
  });

  it("a window read that answers in time, or fails, writes no such line", async () => {
    const net = emergencyCalls(new FakeNet().install(), [emergencyCall()]);
    await emergencyWindowOpen(admin(), CLIENT, USER_A, 500);
    emergencyReadIs(net, () => jsonRes({ message: "boom" }, 500));
    await emergencyWindowOpen(admin(), CLIENT, USER_A, 500);
    await new Promise((r) => setTimeout(r, 20));
    expect(windowSlowLines()).toEqual([]);
    expect(slowLines()).toEqual([]);
  });

  it("nothing is kept: a call placed a moment after a \"no\" is seen by the very next ask", async () => {
    const net = emergencyCalls(new FakeNet().install(), []);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(false);
    emergencyCalls(net, [emergencyCall({ started_at: minutesAgo(0.01) })]);
    expect(await emergencyWindowOpen(admin(), CLIENT, USER_A)).toBe(true);
    expect(emergencyReads(net)).toHaveLength(2);
  });
});

// ── Where the plan is asked, and where it must never be ─────────────────────────────

describe("wiring: which files ask about a plan", () => {
  const SRC = resolve(process.cwd(), "src");
  const read = (f: string) => readFileSync(resolve(SRC, f), "utf8").replace(/\r\n/g, "\n");
  const files = (dir: string): string[] => readdirSync(resolve(SRC, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`.replace(/^\.\//, "")] : []));
  const asksPlan = (f: string) => /from "\.\.?\/plan"/.test(read(f));

  it("only the login check, /token, the two call webhooks, /sms/send and the contact reads import plan.ts", () => {
    expect(files(".").filter(asksPlan).sort()).toEqual(["context.ts", "routes/reads.ts", "routes/sms.ts", "routes/token.ts", "routes/voice.ts"]);
    // So: no cron job (fees and usage charges keep posting), no push webhook, no after-dial,
    // status, conference, recording, voicemail or handoff callback (calls in flight), no greeting.
    expect(files("./cron").length).toBeGreaterThan(5);
    expect(files("./cron").filter(asksPlan)).toEqual([]);
  });

  it("requireLogin (sign-out, forgetting a device, /log) never asks", () => {
    const login = read("context.ts").split("export async function requireLogin(")[1];
    expect(login).toBeTruthy();
    expect(login).not.toMatch(/plan/i);
  });

  it("in voice.ts the plan is asked in exactly two places: a NEW outbound call, below the 911 block, and an inbound one", () => {
    const voice = read("routes/voice.ts");
    const code = voice.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code.match(/planFor\(/g)).toHaveLength(2);
    expect(code.match(/const named = planNamedSoon\(admin\);/g)).toHaveLength(2);
    // The handoff branch (a live call moving to the computer) sits above `outbound` and asks nothing.
    const handoff = code.slice(code.indexOf("async function handoffOutbound("), code.indexOf("export async function outbound("));
    expect(handoff).toContain("handoffAnswer(");
    expect(handoff).not.toMatch(/plan/i);
    // Outbound: nothing about plans until the 911 block has returned.
    const out = code.slice(code.indexOf("export async function outbound("), code.indexOf("export async function inbound("));
    const emergencyEnds = out.indexOf("return response(say(SAY.emergency), hangup());");
    expect(emergencyEnds).toBeGreaterThan(0);
    expect(out.slice(0, emergencyEnds)).not.toMatch(/plan/i);
    expect(out.slice(emergencyEnds)).toContain("const named = planNamedSoon(admin);");
    // ...and its refusal comes before the first thing that can write a failed call row.
    expect(out.indexOf('if (planSays === "refuse")')).toBeLessThan(out.indexOf('return refuse("not_your_customer"'));
    // Inbound: never read inside the 911 callback window, and voicemail stays behind !emergencyUser.
    const inb = code.slice(code.indexOf("export async function inbound("));
    expect(inb).toContain('const planRead = !info.recent_emergency_user && info.phone_status === "on"');
    expect(inb).toContain('if (!emergencyUser && (info.phone_status !== "on" || planOff)) {');
  });
});

// ── The app routes: /token, requireCaller, /sms/send, /contacts, /search ─────────────

const MSG_ID = "00000000-0000-4000-8000-00000000e002";
/** A call id no row has. */
const NO_CALL = "00000000-0000-4000-8000-00000000e0ff";
const SERVICE = "MG" + "0".repeat(32);
const WHEN = "2026-10-01T12:00:00.000Z";
const CONTACT_ROW = {
  id: CONTACT_1, client_id: CLIENT, merged_into: null, name: "Jordan Demo", phone: CUSTOMER, phone_digits: "5555550142",
  email: null, owner_user_id: USER_A, sms_opt_out_at: null, updated_at: WHEN,
};
const TEXT_IN = {
  id: "m1", client_id: CLIENT, contact_id: CONTACT_1, direction: "in", body: "Is my shed ready?", status: "received",
  created_at: WHEN, from_number: CUSTOMER, to_number: BUSINESS_NUMBER, sent_by: null, client_temp_id: null, num_media: 0,
};

/** One signed-in person and everything the routes below read, as a business that has it all. */
async function app(ctx: Record<string, unknown> = callerCtx()) {
  const net = new FakeNet().install();
  const auth = await new Auth().init();
  auth.serve(net);
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("crm_visible_contact_ids", (s) => s.json.p_ids);
  net.rpc("phone_list_search", phoneListSearch({ contacts: [CONTACT_ROW] }));
  net.rest("GET", "phone_user_settings", () => []);
  net.rest("GET", "crm_contacts", () => [CONTACT_ROW]);
  net.rest("GET", "sms_messages", () => [TEXT_IN]);
  net.rest("GET", "phone_calls", () => []);
  net.rest("GET", "phone_call_events", () => []);
  // /sms/send through the real shared sendTenantSms (test/smsSend.test.ts).
  net.rest("GET", "client_settings", () => [{ client_id: CLIENT, sms_number: BUSINESS_NUMBER, sms_status: "active" }]);
  net.rest("GET", "sms_registrations", () => [{ status: "active", messaging_service_sid: SERVICE }]);
  net.rest("GET", "sms_numbers", () => [{ phone_number: BUSINESS_NUMBER, registration_status: "registered", messaging_service_sid: SERVICE, assigned_user_id: null }]);
  net.rest("GET", "sms_opt_outs", () => []);
  net.rest("GET", "sms_consent_log", () => [{ action: "granted" }]);
  net.rest("POST", "sms_messages", () => [{ id: MSG_ID }]);
  net.rest("PATCH", "sms_messages", () => []);
  net.on("POST", /api\.twilio\.com\/2010-04-01\/Accounts\/AC0+\/Messages\.json$/, () => jsonRes({ sid: "SM" + "0".repeat(32), num_segments: "1", status: "queued" }, 201));
  // A thread read also looks for the contact's email and whether one can be sent.
  net.rest("GET", "designs", () => []);
  net.rest("GET", "email_sends", () => []);
  net.rest("GET", "email_inbound", () => []);
  net.rest("GET", "billing_plans", () => []);
  net.rest("GET", "billing_subscriptions", () => []);
  net.rest("POST", "app_errors", () => []);
  const token = await auth.token(USER_A);
  const env = makeEnv();
  const get = (path: string) => call(env, appRequest("GET", path, token));
  return {
    net, env, token, get,
    mint: (ctx: FakeCtx = new FakeCtx()) => call(env, appRequest("POST", "/token", token, { platform: "ios", build_type: "prod" }), ctx),
    text: () => call(env, appRequest("POST", "/sms/send", token, { to_e164: CUSTOMER, contact_id: CONTACT_1, body: "On our way", client_temp_id: "tmp-9" })),
    sent: () => net.to(/Messages\.json$/),
  };
}

/** Every app enforcement point, asked once: what today's rules answer when no plan refuses. */
async function everyAppRoute(w: Awaited<ReturnType<typeof app>>) {
  const mint = await w.mint();
  const calls = await w.get("/calls");
  const text = await w.text();
  const contacts = await w.get("/contacts");
  const search = await w.get("/search?q=jord");
  const threads = await w.get("/threads");
  const settings = await w.get("/settings/me");
  return { mint, calls, text, contacts, search, threads, settings };
}

function expectAsToday(r: Awaited<ReturnType<typeof everyAppRoute>>, w: Awaited<ReturnType<typeof app>>) {
  expect(r.mint.res.status).toBe(200);
  expect(r.mint.json.user.can_text_contacts).toBe(true);
  expect(r.calls.res.status).toBe(200);
  expect(r.text.json).toMatchObject({ ok: true, message: { id: MSG_ID, status: "sent" } });
  expect(w.sent()).toHaveLength(1);
  expect(r.contacts.json.contacts).toEqual([{ id: CONTACT_1, name: "Jordan Demo", e164: CUSTOMER, email: null }]);
  expect(r.search.json.contacts).toEqual([{ id: CONTACT_1, name: "Jordan Demo", e164: CUSTOMER }]);
  expect(r.threads.json.threads).toHaveLength(1);
  expect(r.settings.res.status).toBe(200);
}

describe("the app routes with NOBODY named (today)", () => {
  it("every route answers as before, and access_for_server is never asked", async () => {
    const w = await app();
    expectAsToday(await everyAppRoute(w), w);
    expect(planReads(w.net)).toEqual([]);
    // "Who is named" was read once for all seven requests (kept per isolate), and nothing was logged.
    expect(namedReads(w.net)).toHaveLength(1);
    expect(w.net.writes("app_errors")).toEqual([]);
    expect(w.net.unmatched).toEqual([]);
  });

  it("a needOn: false route never starts the read at all", async () => {
    const w = await app();
    expect((await w.get("/settings/me")).res.status).toBe(200);
    expect(namedReads(w.net)).toEqual([]);
  });

  it("the switch still decides first: phone_status off is phone_off with no plan asked", async () => {
    const w = await app(callerCtx({ phone_status: "off" }));
    servePlan(w.net, { server_clients: [CLIENT] }, { [CLIENT]: planModules() });
    expect((await w.get("/calls")).json.error.code).toBe("phone_off");
    expect((await w.mint()).json.error.code).toBe("phone_off");
    expect(planReads(w.net)).toEqual([]);
  });

  it("a company named for the PORTAL only (387's clients) is not named here", async () => {
    const w = await app();
    servePlan(w.net, { all: true, clients: [CLIENT] }, { [CLIENT]: planModules({ phone: "hidden", sms: "hidden", contacts: "hidden" }) });
    expectAsToday(await everyAppRoute(w), w);
    expect(planReads(w.net)).toEqual([]);
  });

  it("another company being blocked changes nothing for this one", async () => {
    const w = await app();
    servePlan(w.net, { server_clients: ["acme-sheds"] }, { "acme-sheds": planModules({ phone: "hidden" }) });
    expectAsToday(await everyAppRoute(w), w);
    expect(planReads(w.net)).toEqual([]);
  });
});

describe("the app routes when the plan read FAILS: exactly today's behaviour", () => {
  const NOTHING = { phone: "hidden", sms: "hidden", contacts: "hidden" };

  it("the access_config read answers 500", async () => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    w.net.rest("GET", "access_config", () => jsonRes({ message: "boom" }, 500));
    expectAsToday(await everyAppRoute(w), w);
    expect(planReads(w.net)).toEqual([]);
    expect(w.net.writes("app_errors")).toEqual([]);
  });

  it("access_for_server answers 500", async () => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    w.net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500));
    expectAsToday(await everyAppRoute(w), w);
    expect(w.net.writes("app_errors")).toEqual([]);
  });

  it("access_for_server answers something that is not a plan", async () => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    w.net.rpc("access_for_server", () => ({ mode: "block", modules: { phone: "sort of" } }));
    expectAsToday(await everyAppRoute(w), w);
  });

  it("access_for_server never answers: the route waits its bound and then answers as before", async () => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    w.net.rpc("access_for_server", never);
    const t0 = Date.now();
    const { res, json } = await w.get("/calls");
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(APP_PLAN_MS + 1500);
    // Not silently: the console says a read passed its bound.
    expect(slowLines()).toEqual([`[phone-api] a plan read passed its ${APP_PLAN_MS} ms bound (1 since the last line like this); the old rules applied meanwhile`]);
  });

  it("the access_config read never answers: the route waits its bound and then answers as before", async () => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    w.net.rest("GET", "access_config", never);
    const t0 = Date.now();
    const { res, json } = await w.get("/calls");
    const took = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(took).toBeGreaterThanOrEqual(APP_PLAN_MS - 50);
    expect(took).toBeLessThan(APP_PLAN_MS + 1500);
    expect(planReads(w.net)).toEqual([]);
  });

  // /token asks on its own (it does not go through requireCaller), so it is held to the same bound.
  // It has the request's waitUntil, so like the two call webhooks it leaves the late read running
  // (LeftRunning: one that NEVER answers would hold call()'s settle() for ever).
  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", never)],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", never)],
  ])("POST /token with a %s read that never answers: the line is minted once the bound is up, exactly as before", async (_l, hang) => {
    const w = await app();
    blockPlan(w.net, NOTHING);
    hang(w.net);
    const t0 = Date.now();
    const { res, json, ctx } = await w.mint(new LeftRunning());
    const took = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(typeof json.token).toBe("string");
    expect(json.user.can_text_contacts).toBe(true);
    expect(took).toBeGreaterThanOrEqual(APP_PLAN_MS - 50);
    expect(took).toBeLessThan(APP_PLAN_MS + 1500);
    expect(w.net.writes("app_errors")).toEqual([]);
    // Not silently, and the read was left with waitUntil in case it does land.
    expect(slowLines()).toHaveLength(1);
    expect(ctx.pending.length).toBeGreaterThan(0);
  });

  // A slow stretch must not mean every /token pays the bound and mints by the old rules: the read
  // that was too slow for this one is kept going (waitUntil) and answers the next.
  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", late(APP_PLAN_MS + 250, { mode: "block", modules: planModules({ phone: "hidden" }) }))],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", late(APP_PLAN_MS + 250, [{ value: { server_clients: [CLIENT] } }]))],
  ])("POST /token with a %s read slower than the bound: this line is minted by the old rules, the read still lands, and the next /token is answered from it", async (_l, slow) => {
    const w = await app();
    blockPlan(w.net, { phone: "hidden" });
    slow(w.net);
    expect((await w.mint()).res.status).toBe(200);
    // call() waited for the request's waitUntil work, as the runtime does. The late read was in it.
    w.net.rpc("access_for_server", never);
    const t0 = Date.now();
    const next = await w.mint();
    expect(Date.now() - t0).toBeLessThan(APP_PLAN_MS - 500);
    expect(next.json.error?.code).toBe("phone_off");
    expect(namedReads(w.net)).toHaveLength(1);
    expect(planReads(w.net)).toHaveLength(1);
    expect(slowLines()).toHaveLength(1);
  });
});

describe("the app routes in REPORT mode: nothing refused, nothing hidden, one row per action", () => {
  it("with phone, sms and contacts all off in the map every route still answers as today", async () => {
    const w = await app();
    reportPlan(w.net, { phone: "hidden", sms: "locked", contacts: "off" });
    expectAsToday(await everyAppRoute(w), w);
    const rows = wouldRefuseRows(w.net);
    expect(rows.map((r) => r.context.action).sort()).toEqual(["app_route", "contacts_list", "contacts_search", "sms_send", "token"]);
    for (const r of rows) expect(r).toMatchObject({ source: "edge:phone-api", severity: "info", client_id: CLIENT, url: null });
    expect(rows.find((r) => r.context.action === "sms_send").context).toEqual({ action: "sms_send", tabs: ["sms"], states: { sms: "locked" } });
    expect(rows.find((r) => r.context.action === "contacts_list").context.states).toEqual({ contacts: "off" });
    // One plan read served all seven requests.
    expect(planReads(w.net)).toHaveLength(1);
  });

  it("a second pass over the same routes files nothing more", async () => {
    const w = await app();
    reportPlan(w.net, { phone: "hidden", sms: "locked", contacts: "off" });
    await everyAppRoute(w);
    const before = wouldRefuseRows(w.net).length;
    await everyAppRoute(w);
    expect(wouldRefuseRows(w.net)).toHaveLength(before);
  });

  it("a company with every tab on files nothing", async () => {
    const w = await app();
    reportPlan(w.net);
    expectAsToday(await everyAppRoute(w), w);
    expect(w.net.writes("app_errors")).toEqual([]);
  });

  it("/token never asks about the sms tab: with only texting off in the map it files nothing, whoever signs in", async () => {
    for (const [level, can] of [["edit", true], ["view", false]] as const) {
      const w = await app(callerCtx({ contacts_level: level }));
      reportPlan(w.net, { sms: "hidden" });
      expect((await w.mint()).json.user.can_text_contacts).toBe(can);
      expect(wouldRefuseRows(w.net)).toEqual([]);
    }
  });
});

describe("the app routes in BLOCK mode", () => {
  it("every tab on: nothing changes", async () => {
    const w = await app();
    blockPlan(w.net);
    expectAsToday(await everyAppRoute(w), w);
    expect(w.net.writes("app_errors")).toEqual([]);
  });

  describe("only the phone tab off", () => {
    it.each(["hidden", "locked", "off"])("/token is refused phone_off (%s), in the words the apps already show, and no line is minted", async (state) => {
      const w = await app();
      blockPlan(w.net, { phone: state });
      const { res, json } = await w.mint();
      expect(res.status).toBe(403);
      expect(json).toEqual({ ok: false, error: { code: "phone_off", message: "My Synergy Phone isn't switched on for your business yet." } });
    });

    it("a tab missing from the map is not had either", async () => {
      const w = await app();
      servePlan(w.net, { server_clients: [CLIENT] }, { [CLIENT]: { contacts: "on", sms: "on" } });
      expect((await w.mint()).json.error.code).toBe("phone_off");
    });

    it("a route that needs the switch is refused phone_off; one that does not (needOn: false) still answers", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      for (const path of ["/calls", "/threads", "/contacts", "/search?q=jord", "/team"]) {
        const { res, json } = await w.get(path);
        expect([path, res.status, json.error?.code]).toEqual([path, 403, "phone_off"]);
      }
      const text = await w.text();
      expect(text.json.error.code).toBe("phone_off");
      expect(w.sent()).toEqual([]);
      // Their own settings, with the phone tab off: untouched.
      const settings = await w.get("/settings/me");
      expect(settings.res.status).toBe(200);
      expect(settings.json.ok).toBe(true);
      // Block mode refuses; it does not also write rows.
      expect(w.net.writes("app_errors")).toEqual([]);
    });

    // A plan only stops NEW work. These nine routes work a call that is already up (or the relay
    // its audio runs through), and none of them can start one, so they never ask about the plan:
    // a customer put on hold before the tab went must not be left there by a Resume that answers
    // phone_off. Each is asked for a call id nobody has, so what comes back is the route's own
    // answer (not found, nothing pending), never the plan's.
    const LIVE_CALL: [string, string][] = [
      ["POST", `/calls/${NO_CALL}/hold`], ["POST", `/calls/${NO_CALL}/resume`],
      ["POST", `/calls/${NO_CALL}/transfer`], ["POST", `/calls/${NO_CALL}/warm-transfer`],
      ["POST", `/calls/${NO_CALL}/handoff`], ["GET", `/calls/${NO_CALL}/handoff`], ["POST", `/calls/${NO_CALL}/handoff/cancel`],
      ["GET", "/handoff/pending"], ["GET", "/turn"],
    ];
    const liveCall = (w: Awaited<ReturnType<typeof app>>, method: string, path: string) =>
      call(w.env, appRequest(method, path, w.token, method === "POST" ? { to_user_id: USER_B, target: "phone" } : undefined));

    it.each(LIVE_CALL)("the controls of a call already up are never refused by the plan: %s %s", async (method, path) => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden", sms: "hidden", contacts: "hidden" });
      const { json } = await liveCall(w, method, path);
      expect(json.error?.code).not.toBe("phone_off");
      // Not even "who is named" is read for them, so a slow plan read cannot hold a Resume up.
      expect(namedReads(w.net)).toEqual([]);
      expect(planReads(w.net)).toEqual([]);
    });

    it.each(LIVE_CALL)("...and still follow the SWITCH, as they always did: %s %s is phone_off with phone_status off", async (method, path) => {
      const w = await app(callerCtx({ phone_status: "off" }));
      const { res, json } = await liveCall(w, method, path);
      expect([res.status, json.error?.code]).toEqual([403, "phone_off"]);
    });

    it("exactly those routes pass plan: false, and nothing that can start work does", () => {
      const src = (f: string) => readFileSync(resolve(process.cwd(), "src/routes", f), "utf8").replace(/\r\n/g, "\n");
      const fnsWith = (f: string) => [...src(f).matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n(?:  \/\/[^\n]*\n)*  (?:const c = )?await requireCaller\(env, req, \{ plan: false \}\);/g)].map((m) => m[1]);
      expect(fnsWith("conference.ts")).toEqual(["hold", "resume", "warmTransfer"]);
      expect(fnsWith("calls.ts")).toEqual(["transfer"]);
      expect(fnsWith("handoff.ts")).toEqual(["startHandoff", "cancelHandoff", "handoffStatus", "pendingHandoff"]);
      expect(fnsWith("me.ts")).toEqual(["turn"]);
      const all = readdirSync(resolve(process.cwd(), "src/routes")).filter((f) => f.endsWith(".ts"));
      expect(all.map((f) => (src(f).match(/plan: false/g) ?? []).length).reduce((a, b) => a + b, 0)).toBe(9);
    });

    it("signing out everywhere still works (a login is all it asks)", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      w.net.rest("GET", "phone_user_settings", () => [{ device_generation: 3 }]);
      w.net.rest("PATCH", "phone_user_settings", () => [{ user_id: USER_A }]);
      w.net.rest("DELETE", "phone_devices", () => []);
      w.net.on("POST", (u) => u.pathname === "/auth/v1/logout", () => new Response(null, { status: 204 }));
      const { json } = await call(w.env, appRequest("POST", "/devices/signout-all", w.token, {}));
      expect(json).toEqual({ ok: true });
      expect(w.net.writes("phone_user_settings", "PATCH")[0].json.device_generation).toBe(4);
      // requireLogin asks nothing about plans, not even who is named.
      expect(namedReads(w.net)).toEqual([]);
      expect(planReads(w.net)).toEqual([]);
    });
  });

  // A plan never refuses 911 or its callback. /voice/inbound rings only the person who dialed for
  // 60 minutes (below), and that ring goes to the line /token mints, which lasts the same hour: so
  // for those 60 minutes the plan must not refuse that one person their line, nor send their app
  // to its "not switched on" screen.
  describe("the phone tab off, inside the 60 minutes after this person's own 911 call", () => {
    it("/token still mints the line, and the routes that need the switch answer as before", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyCalls(w.net, [emergencyCall()]);
      const mint = await w.mint();
      expect(mint.res.status).toBe(200);
      expect(typeof mint.json.token).toBe("string");
      expect(mint.json.identity).toBe(id(USER_A));
      for (const path of ["/calls", "/threads"]) {
        const { res, json } = await w.get(path);
        expect([path, res.status, json.ok]).toEqual([path, 200, true]);
      }
      // One look at the window per request the plan would have refused, and nothing written.
      expect(emergencyReads(w.net)).toHaveLength(3);
      expect(w.net.writes("app_errors")).toEqual([]);
      expect(w.net.unmatched).toEqual([]);
    });

    it("the other tabs still decide what they always decided: with contacts off as well the contact list stays empty", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden", contacts: "hidden" });
      emergencyCalls(w.net, [emergencyCall()]);
      const contacts = await w.get("/contacts");
      expect([contacts.res.status, contacts.json]).toEqual([200, { ok: true, contacts: [] }]);
    });

    it.each(NOT_THIS_WINDOW)("%s is not this person's window: phone_off, as for any blocked company", async (_l, over) => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyCalls(w.net, [emergencyCall(over)]);
      const mint = await w.mint();
      expect([mint.res.status, mint.json.error?.code]).toEqual([403, "phone_off"]);
      const calls = await w.get("/calls");
      expect([calls.res.status, calls.json.error?.code]).toEqual([403, "phone_off"]);
      expect(emergencyReads(w.net)).toHaveLength(2);
    });

    it("the window's read failing never refuses: /token mints and the route answers", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyReadIs(w.net, () => jsonRes({ message: "boom" }, 500));
      expect((await w.mint()).res.status).toBe(200);
      expect((await w.get("/calls")).res.status).toBe(200);
      expect(w.net.writes("app_errors")).toEqual([]);
    });

    it("the window's read never answering: the route waits its bound and then answers, not refused", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyReadIs(w.net, never);
      const t0 = Date.now();
      const { res, json } = await w.get("/calls");
      const took = Date.now() - t0;
      expect([res.status, json.ok]).toEqual([200, true]);
      expect(took).toBeGreaterThanOrEqual(APP_PLAN_MS - 50);
      expect(took).toBeLessThan(APP_PLAN_MS + 1500);
      // Not silently, and the line names the read that was slow: the plan reads answered in time.
      expect(windowSlowLines()).toEqual([windowSlowLine(APP_PLAN_MS)]);
      expect(slowLines()).toEqual([]);
    });

    it("POST /token the same: minted once the bound is up, and the console names the window read", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyReadIs(w.net, never);
      const t0 = Date.now();
      const { res, json } = await w.mint();
      const took = Date.now() - t0;
      expect([res.status, typeof json.token]).toEqual([200, "string"]);
      expect(took).toBeGreaterThanOrEqual(APP_PLAN_MS - 50);
      expect(took).toBeLessThan(APP_PLAN_MS + 1500);
      expect(windowSlowLines()).toEqual([windowSlowLine(APP_PLAN_MS)]);
      expect(slowLines()).toEqual([]);
    });
  });

  // The window is asked on the refuse path ONLY: no request the plan lets through pays for it.
  describe("the 911 window is never read unless the plan is about to refuse", () => {
    const WITH_CALL = [emergencyCall()];

    it("nobody named", async () => {
      const w = await app();
      emergencyCalls(w.net, WITH_CALL);
      expectAsToday(await everyAppRoute(w), w);
      expect(emergencyReads(w.net)).toEqual([]);
    });

    it("report mode with every tab off (it refuses nothing, so there is nothing to excuse)", async () => {
      const w = await app();
      reportPlan(w.net, { phone: "hidden", sms: "locked", contacts: "off" });
      emergencyCalls(w.net, WITH_CALL);
      expectAsToday(await everyAppRoute(w), w);
      expect(emergencyReads(w.net)).toEqual([]);
      // ...and the report rows are filed as they are with no 911 call anywhere.
      expect(wouldRefuseRows(w.net).map((r) => r.context.action).sort()).toEqual(["app_route", "contacts_list", "contacts_search", "sms_send", "token"]);
    });

    it("block mode with the phone tab on, whatever the other tabs say", async () => {
      const w = await app();
      blockPlan(w.net, { sms: "hidden", contacts: "hidden" });
      emergencyCalls(w.net, WITH_CALL);
      expect((await w.mint()).res.status).toBe(200);
      expect((await w.get("/calls")).res.status).toBe(200);
      expect((await w.text()).json.error.code).toBe(NO_TEXTING_PLAN.code);
      expect((await w.get("/contacts")).json.contacts).toEqual([]);
      expect(emergencyReads(w.net)).toEqual([]);
    });

    it("a plan read that failed (the old rules)", async () => {
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyCalls(w.net, WITH_CALL);
      w.net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500));
      expect((await w.mint()).res.status).toBe(200);
      expect((await w.get("/calls")).res.status).toBe(200);
      expect(emergencyReads(w.net)).toEqual([]);
    });

    it("the switch off, a needOn: false route and the controls of a call already up", async () => {
      const off = await app(callerCtx({ phone_status: "off" }));
      blockPlan(off.net, { phone: "hidden" });
      emergencyCalls(off.net, WITH_CALL);
      expect((await off.mint()).json.error.code).toBe("phone_off");
      expect((await off.get("/calls")).json.error.code).toBe("phone_off");
      expect(emergencyReads(off.net)).toEqual([]);

      _resetPlanCaches();
      const w = await app();
      blockPlan(w.net, { phone: "hidden" });
      emergencyCalls(w.net, WITH_CALL);
      expect((await w.get("/settings/me")).res.status).toBe(200);
      await call(w.env, appRequest("POST", `/calls/${NO_CALL}/resume`, w.token, {}));
      await w.get("/turn");
      expect(emergencyReads(w.net)).toEqual([]);
    });
  });

  describe("only the sms tab off", () => {
    it("/sms/send is refused before anything is sent, with a code and a sentence both apps show", async () => {
      const w = await app();
      blockPlan(w.net, { sms: "hidden" });
      const { res, json } = await w.text();
      expect(res.status).toBe(409);
      expect(json).toEqual({ ok: false, error: { code: "number_not_registered", message: "Texting isn't part of your plan. Ask Structure Studio to add it." } });
      expect(json.error).toEqual({ code: NO_TEXTING_PLAN.code, message: NO_TEXTING_PLAN.message });
      // Nothing was claimed, sent or even looked up for the message.
      expect(w.sent()).toEqual([]);
      expect(w.net.writes("sms_messages")).toEqual([]);
      expect(w.net.reads("crm_contacts")).toEqual([]);
    });

    it("the refusal comes before the message is even read: an empty body is still the plan's answer", async () => {
      const w = await app();
      blockPlan(w.net, { sms: "locked" });
      const { json } = await call(w.env, appRequest("POST", "/sms/send", w.token, { to_e164: CUSTOMER, body: "" }));
      expect(json.error.code).toBe("number_not_registered");
    });

    // In both installed apps can_text_contacts means "has Contacts edit access", and emailing a
    // customer, New message and Save as contact all follow it. The sms tab must not reach it.
    it.each(["hidden", "locked", "off"])("/token still mints the line and leaves can_text_contacts alone (sms %s): it is the person's Contacts access, not the plan's", async (state) => {
      const w = await app();
      blockPlan(w.net, { sms: state });
      const { res, json } = await w.mint();
      expect(res.status).toBe(200);
      expect(typeof json.token).toBe("string");
      expect(json.user.can_text_contacts).toBe(true);
      expect(w.net.writes("app_errors")).toEqual([]);
    });

    it("sms off with email and contacts on: /token says what it says with nobody named, the thread still offers Email, and only the text is refused", async () => {
      const plain = await app();
      const before = (await plain.mint()).json.user;
      expect(before.can_text_contacts).toBe(true);

      _resetPlanCaches(); // a fresh isolate: "nobody is named" is kept for 30 seconds otherwise
      const w = await app();
      blockPlan(w.net, { sms: "hidden" });
      // The flag the apps hang Email, New message and Save as contact on is untouched...
      expect((await w.mint()).json.user).toEqual(before);
      // ...so the apps go by the thread's own answer about emailing this customer, and that one
      // counts the email tab as had: neither "no edit access" nor "no CRM" (this demo business
      // simply has no sending address yet).
      const thread = (await w.get(`/threads/${CONTACT_1}`)).json;
      expect(thread.compose).toEqual({ email_to: null, email_block: "not_set_up" });
      // The one thing the sms tab takes away is the text itself, in the Worker's own sentence.
      expect((await w.text()).json.error).toEqual({ code: NO_TEXTING_PLAN.code, message: NO_TEXTING_PLAN.message });
      expect(w.sent()).toEqual([]);
    });

    it("someone without Contacts edit access is still told so by /token, plan or no plan", async () => {
      const w = await app(callerCtx({ contacts_level: "view" }));
      blockPlan(w.net, { sms: "hidden" });
      expect((await w.mint()).json.user.can_text_contacts).toBe(false);
    });

    it("threads still list and a thread still opens; calls, contacts and search are untouched", async () => {
      const w = await app();
      blockPlan(w.net, { sms: "hidden" });
      expect((await w.get("/threads")).json.threads).toHaveLength(1);
      const thread = await w.get(`/threads/${CONTACT_1}`);
      expect(thread.res.status).toBe(200);
      expect(thread.json.messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
      expect((await w.get("/calls")).res.status).toBe(200);
      expect((await w.get("/contacts")).json.contacts).toHaveLength(1);
      expect((await w.get("/search?q=jord")).json.contacts).toHaveLength(1);
    });
  });

  describe("only the contacts tab off", () => {
    it("GET /contacts and GET /search answer the empty list a person with no contacts access gets", async () => {
      const w = await app();
      blockPlan(w.net, { contacts: "hidden" });
      const contacts = await w.get("/contacts");
      expect([contacts.res.status, contacts.json]).toEqual([200, { ok: true, contacts: [] }]);
      const search = await w.get("/search?q=jord");
      expect([search.res.status, search.json]).toEqual([200, { ok: true, contacts: [] }]);
      expect(w.net.reads("crm_contacts")).toEqual([]);
      expect(w.net.rpcCalls("phone_list_search")).toEqual([]);
    });

    it("a plan with the phone and texting but no contact list still texts, still lists threads and still opens one", async () => {
      const w = await app();
      blockPlan(w.net, { contacts: "hidden" });
      const mint = await w.mint();
      expect(mint.res.status).toBe(200);
      expect(mint.json.user.can_text_contacts).toBe(true);
      expect((await w.text()).json).toMatchObject({ ok: true, message: { status: "sent" } });
      expect(w.sent()).toHaveLength(1);
      expect((await w.get("/threads")).json.threads).toHaveLength(1);
      expect((await w.get(`/threads/${CONTACT_1}`)).json.messages).toHaveLength(1);
      expect((await w.get("/calls")).res.status).toBe(200);
    });
  });

  it("one plan read serves a whole run of requests (kept 30 seconds per company)", async () => {
    const w = await app();
    blockPlan(w.net, { contacts: "hidden" });
    await w.mint();
    await w.get("/calls");
    await w.get("/contacts");
    await w.text();
    expect(planReads(w.net)).toHaveLength(1);
    expect(namedReads(w.net)).toHaveLength(1);
  });
});

// ── The two voice webhooks ──────────────────────────────────────────────────────────

const IDENTITY_A = `client:u_${USER_A.replace(/-/g, "")}_g1`;
const id = (u: string, g = 1) => `u_${u.replace(/-/g, "")}_g${g}`;

function voice(ctx: Record<string, unknown> | null = callerCtx(), info: unknown = routeInfo()) {
  const net = new FakeNet().install();
  net.rpc("phone_caller_context", () => ctx);
  net.rpc("phone_route_for_number", () => info);
  net.rest("GET", "crm_contacts", () => []);
  net.rest("GET", "phone_calls", () => []);
  net.rest("GET", "phone_user_settings", () => []);
  net.rest("GET", "usage_prices", () => []);
  net.rest("GET", "wallet_accounts", () => []);
  net.rest("GET", "client_settings", () => []);
  net.rest("POST", "phone_calls", () => []);
  net.rest("POST", "phone_call_events", () => []);
  net.rest("POST", "app_errors", () => []);
  return net;
}

async function dialOut(env = makeEnv(), params: Record<string, string> = {}, ctx = new FakeCtx()) {
  return call(env, await twilioPost(env, "/voice/outbound", { CallSid: CALL_SID, From: IDENTITY_A, To: CUSTOMER, Direction: "inbound", ...params }), ctx);
}

async function ringIn(env = makeEnv(), ctx = new FakeCtx()) {
  return call(env, await twilioPost(env, "/voice/inbound", { CallSid: CALL_SID, From: CUSTOMER, To: BUSINESS_NUMBER, Direction: "inbound" }), ctx);
}

/** What access_for_server answers for the demo tenant blocked with no phone tab, for a `late` reply. */
const BLOCKED_NO_PHONE = { mode: "block", modules: planModules({ phone: "hidden" }) };

describe("/voice/outbound and the plan", () => {
  it("nobody named: the call dials, access_for_server is never asked, nothing is logged", async () => {
    const net = voice();
    const { text } = await dialOut();
    expect(numbersIn(text)).toEqual([CUSTOMER]);
    expect(planReads(net)).toEqual([]);
    expect(namedReads(net)).toHaveLength(1);
    expect(net.writes("app_errors")).toEqual([]);
    expect(net.unmatched).toEqual([]);
  });

  it("block mode with the phone tab on: the call dials", async () => {
    const net = blockPlan(voice());
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(net.writes("phone_calls", "POST")).toHaveLength(1);
  });

  it.each(["hidden", "locked", "off"])("block mode with the phone tab %s: the sentence the switch speaks, a hangup, NO call row and nobody dialed", async (state) => {
    const net = blockPlan(voice(), { phone: state });
    const { res, text } = await dialOut();
    expect(res.status).toBe(200);
    expect(text).toContain("My Synergy Phone isn't switched on for your business yet.");
    expect(text).toContain("<Hangup/>");
    expect(text).not.toContain("<Dial");
    expect(net.writes("phone_calls")).toEqual([]);
    expect(net.writes("phone_call_events")).toEqual([]);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it("the plan is asked before the contact, the cap and the wallet can write a failed row", async () => {
    // A contact id from another business would be refused WITH a row; the plan's refusal comes first.
    const net = blockPlan(voice(), { phone: "hidden" });
    const { text } = await dialOut(makeEnv(), { ContactId: CONTACT_1 });
    expect(text).toContain("isn't switched on");
    expect(net.writes("phone_calls")).toEqual([]);
  });

  it("911 still dials with the phone tab off in the plan, and never asks about the plan at all", async () => {
    const net = blockPlan(voice(), { phone: "hidden", sms: "hidden", contacts: "hidden" });
    const { text } = await dialOut(makeEnv({ EMERGENCY_MODE: "allow" }), { To: "911" });
    expect(numbersIn(text)).toEqual(["911"]);
    expect(net.writes("phone_calls", "POST")[0].json).toMatchObject({ is_emergency: true, to_e164: "911" });
    expect(namedReads(net)).toEqual([]);
    expect(planReads(net)).toEqual([]);
  });

  it("only the sms tab off, or only contacts: calling is the phone tab's alone", async () => {
    const net = blockPlan(voice(), { sms: "hidden", contacts: "hidden" });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(net.writes("phone_calls", "POST")).toHaveLength(1);
  });

  it("report mode: the call dials and one row is filed, however many calls follow", async () => {
    const net = reportPlan(voice(), { phone: "hidden" });
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(wouldRefuseRows(net)).toHaveLength(1);
    expect(wouldRefuseRows(net)[0]).toMatchObject({
      severity: "info", client_id: CLIENT, url: null,
      message: "Report only: outbound_call would be refused (needs phone).",
      context: { action: "outbound_call", tabs: ["phone"], states: { phone: "hidden" } },
    });
  });

  it.each([
    ["the access_config read fails", (net: FakeNet) => net.rest("GET", "access_config", () => jsonRes({ message: "boom" }, 500))],
    ["access_for_server fails", (net: FakeNet) => net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500))],
    ["access_for_server is malformed", (net: FakeNet) => net.rpc("access_for_server", () => ({ mode: "block" }))],
  ])("%s: the call dials as it does today", async (_l, breakIt) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    breakIt(net);
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", never)],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", never)],
  ])("a %s read that never answers holds the call for the short bound only, then it dials", async (_l, hang) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    hang(net);
    const t0 = Date.now();
    const { text, ctx } = await dialOut(makeEnv(), {}, new LeftRunning());
    const took = Date.now() - t0;
    expect(numbersIn(text)).toEqual([CUSTOMER]);
    expect(took).toBeGreaterThanOrEqual(VOICE_PLAN_MS - 50);
    expect(took).toBeLessThan(VOICE_PLAN_MS + 1500);
    // Not silently: one console line, and the read was left with waitUntil in case it does land.
    expect(slowLines()).toEqual([`[phone-api] a plan read passed its ${VOICE_PLAN_MS} ms bound (1 since the last line like this); the old rules applied meanwhile`]);
    expect(ctx.pending.length).toBeGreaterThan(0);
  });

  // A slow stretch must not mean every call pays the bound and dials by the old rules: the read
  // that was too slow for this call is kept going (waitUntil) and answers the next one.
  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", late(VOICE_PLAN_MS + 250, BLOCKED_NO_PHONE))],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", late(VOICE_PLAN_MS + 250, [{ value: { server_clients: [CLIENT] } }]))],
  ])("a %s read slower than the bound: this call dials by the old rules, the read still lands, and the next call is answered from it", async (_l, slow) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    slow(net);
    expect(numbersIn((await dialOut()).text)).toEqual([CUSTOMER]);
    // call() waited for the request's waitUntil work, as the runtime does. The late read was in it.
    net.rpc("access_for_server", () => BLOCKED_NO_PHONE);
    const t0 = Date.now();
    const next = await dialOut();
    expect(Date.now() - t0).toBeLessThan(VOICE_PLAN_MS - 100);
    expect(next.text).toContain("isn't switched on");
    expect(numbersIn(next.text)).toEqual([]);
    expect(namedReads(net)).toHaveLength(1);
    expect(planReads(net)).toHaveLength(1);
    expect(slowLines()).toHaveLength(1);
  });

  it("the switch off is still refused before the plan is asked", async () => {
    const net = blockPlan(voice(callerCtx({ phone_status: "off" })));
    expect((await dialOut()).text).toContain("isn't switched on");
    expect(planReads(net)).toEqual([]);
  });
});

describe("/voice/outbound handing a live call to the computer (the handoff branch)", () => {
  it("never asks about the plan: a call in flight is not new work", async () => {
    const net = blockPlan(voice(), { phone: "hidden" });
    const { res, text } = await dialOut(makeEnv(), { To: "handoff", HandoffCall: "00000000-0000-4000-8000-00000000d001", HandoffKey: "00000000-0000-4000-8000-00000000d002" });
    // The branch ran (it looked the call up) and answered by its own rules: the plan's sentence
    // is not among them, and nothing about plans was read. test/handoff.test.ts holds the rest.
    expect(res.status).toBe(200);
    expect(net.reads("phone_calls")).toHaveLength(1);
    expect(filter(net.reads("phone_calls")[0], "id")).toBe("00000000-0000-4000-8000-00000000d001");
    expect(text).not.toContain("isn't switched on");
    expect(namedReads(net)).toEqual([]);
    expect(planReads(net)).toEqual([]);
  });
});

describe("/voice/inbound and the plan", () => {
  it("nobody named: everyone rings, access_for_server is never asked, nothing is logged", async () => {
    const net = voice();
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
    expect(planReads(net)).toEqual([]);
    expect(namedReads(net)).toHaveLength(1);
    expect(net.writes("app_errors")).toEqual([]);
    expect(net.unmatched).toEqual([]);
  });

  it("block mode with the phone tab on: everyone rings", async () => {
    blockPlan(voice());
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
  });

  it.each(["hidden", "locked", "off"])("block mode with the phone tab %s: voicemail, the row kept, nobody rung, the caller never dropped", async (state) => {
    const net = blockPlan(voice(), { phone: state });
    const { res, text } = await ringIn();
    expect(res.status).toBe(200);
    expect(text).toContain("<Record");
    expect(text).not.toContain("can't take calls right now");
    expect(clientsIn(text)).toEqual([]);
    const row = net.writes("phone_calls", "POST")[0].json;
    expect(row).toMatchObject({ client_id: CLIENT, direction: "in", rang_user_ids: [], status: "ringing" });
    expect(row.recording_armed).toBeUndefined();
  });

  it("a recorded business: the plan's voicemail is not armed and plays no recording notice", async () => {
    const recording = { on: true, notice: true, notice_text: null, transcribe: true };
    const net = blockPlan(voice(callerCtx(), routeInfo({ recording })), { phone: "hidden" });
    const { text } = await ringIn(makeEnv({ CALL_RECORDING: "on" }));
    expect(clientsIn(text)).toEqual([]);
    expect(text).not.toMatch(/may be recorded/i);
    expect(net.writes("phone_calls", "POST")[0].json.recording_armed).toBeUndefined();
  });

  it("the 911 callback still rings the person who dialed, with the phone tab off, and the plan is not asked", async () => {
    const net = blockPlan(voice(callerCtx(), routeInfo({ recent_emergency_user: USER_B, members: [member(USER_A), member(USER_B, { dnd: true, busy: true })] })), { phone: "hidden" });
    const { text } = await ringIn();
    expect(clientsIn(text)).toEqual([id(USER_B)]);
    expect(text).not.toContain("<Record");
    expect(planReads(net)).toEqual([]);
  });

  it("the 911 callback rings even when the plan read would never answer", async () => {
    const net = blockPlan(voice(callerCtx(), routeInfo({ recent_emergency_user: USER_B })), { phone: "hidden" });
    net.rpc("access_for_server", never);
    net.rest("GET", "access_config", never);
    const t0 = Date.now();
    expect(clientsIn((await ringIn()).text)).toEqual([id(USER_B)]);
    expect(Date.now() - t0).toBeLessThan(VOICE_PLAN_MS);
  });

  it("the switch already off: voicemail as before, and the plan is not asked", async () => {
    const net = blockPlan(voice(callerCtx(), routeInfo({ phone_status: "off" })));
    expect((await ringIn()).text).toContain("<Record");
    expect(planReads(net)).toEqual([]);
  });

  it("only the sms tab off, or only contacts: the phone still rings", async () => {
    blockPlan(voice(), { sms: "hidden", contacts: "hidden" });
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
  });

  it("report mode: everyone rings and one row is filed", async () => {
    const net = reportPlan(voice(), { phone: "off" });
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
    expect(wouldRefuseRows(net)).toHaveLength(1);
    expect(wouldRefuseRows(net)[0]).toMatchObject({
      severity: "info", client_id: CLIENT, url: null,
      context: { action: "inbound_call", tabs: ["phone"], states: { phone: "off" } },
    });
  });

  it.each([
    ["the access_config read fails", (net: FakeNet) => net.rest("GET", "access_config", () => jsonRes({ message: "boom" }, 500))],
    ["access_for_server fails", (net: FakeNet) => net.rpc("access_for_server", () => jsonRes({ message: "boom" }, 500))],
    ["access_for_server is malformed", (net: FakeNet) => net.rpc("access_for_server", () => "block")],
  ])("%s: everyone rings as today, and it is never a 500", async (_l, breakIt) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    breakIt(net);
    const { res, text } = await ringIn();
    expect(res.status).toBe(200);
    expect(clientsIn(text)).toHaveLength(3);
    expect(net.writes("app_errors")).toEqual([]);
  });

  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", never)],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", never)],
  ])("a %s read that never answers holds the caller for the short bound only, then everyone rings", async (_l, hang) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    hang(net);
    const t0 = Date.now();
    const { res, text, ctx } = await ringIn(makeEnv(), new LeftRunning());
    const took = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(clientsIn(text)).toHaveLength(3);
    expect(took).toBeGreaterThanOrEqual(VOICE_PLAN_MS - 50);
    expect(took).toBeLessThan(VOICE_PLAN_MS + 1500);
    expect(slowLines()).toHaveLength(1);
    expect(ctx.pending.length).toBeGreaterThan(0);
  });

  it.each([
    ["access_for_server", (net: FakeNet) => net.rpc("access_for_server", late(VOICE_PLAN_MS + 250, BLOCKED_NO_PHONE))],
    ["access_config", (net: FakeNet) => net.rest("GET", "access_config", late(VOICE_PLAN_MS + 250, [{ value: { server_clients: [CLIENT] } }]))],
  ])("a %s read slower than the bound: this caller rings everyone, the read still lands, and the next caller gets the plan's voicemail", async (_l, slow) => {
    const net = blockPlan(voice(), { phone: "hidden" });
    slow(net);
    expect(clientsIn((await ringIn()).text)).toHaveLength(3);
    net.rpc("access_for_server", () => BLOCKED_NO_PHONE);
    const t0 = Date.now();
    const next = await ringIn();
    expect(Date.now() - t0).toBeLessThan(VOICE_PLAN_MS - 100);
    expect(next.text).toContain("<Record");
    expect(clientsIn(next.text)).toEqual([]);
    expect(namedReads(net)).toHaveLength(1);
    expect(planReads(net)).toHaveLength(1);
  });

  it("a number nobody owns is still \"not in service\", with no plan asked for anyone", async () => {
    const net = blockPlan(voice(callerCtx(), null), { phone: "hidden" });
    expect((await ringIn()).text).toContain("can't take calls right now");
    expect(planReads(net)).toEqual([]);
  });
});
