// support-agent's decisions (agent.ts): the caps checked before Claude is asked, what Claude is asked
// and how, the tool rounds, every fixed sentence, what is stored and what it cost, and that no message
// text ever reaches a log. The store, Claude, the tools' database and the logger are stubs.
//
// Run: deno test --allow-env --allow-read --node-modules-dir=none support-agent/   (from supabase/functions)
// Self-contained (no jsr:/npm: imports), like customer-designs/handler.test.ts.
//
// Every value here is an obviously fake fixture: this repo is public.

import {
  addUsage, type AgentDeps, type AgentStore, clip, DEFAULT_DAILY_CAP, DEFAULT_MODEL, effectiveDailyCap, handleNew, handleSend,
  handleStatus, MAX_TOOL_ROUNDS, MAX_USER_CHARS, modelFrom, monthlyCapMicros, SENTENCES, type StoredMessage, toMessages,
  USER_10M_CAP, type Usage, zeroTotals,
} from "./agent.ts";
import { KNOWLEDGE } from "./knowledge.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  actual:   ${a}\n  expected: ${e}`);
}

const WHO = { clientId: "demo-builder", userId: "00000000-0000-4000-8000-0000000000c1" };
const SECRET = "the customer's gate code is 4321";

interface World {
  usage?: Usage | null;
  dailyCap?: number | null;
  key?: string | null;
  env?: Record<string, string>;
  claude?: (body: Record<string, unknown>, call: number) => Response | Promise<Response>;
  clock?: () => number;
}

function world(w: World = {}) {
  const asked: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const stored: { role: string; body: string; tools?: string[]; costMicros?: number; stopReason?: string | null; model?: string | null }[] = [];
  const logs: { code: string; message: string; severity?: string; context?: Record<string, unknown> }[] = [];
  const toolDb: string[] = [];
  let swept = 0;
  let closed = 0;
  let convs = 0;
  const env: Record<string, string> = { ...(w.key === null ? {} : { ANTHROPIC_API_KEY: w.key ?? "test-key" }), ...(w.env ?? {}) };
  const history: StoredMessage[] = [];

  const store: AgentStore = {
    usage: () => Promise.resolve(w.usage === undefined ? { monthCostMicros: 0, tenant24h: 0, user10m: 0 } : w.usage),
    dailyCap: () => Promise.resolve(w.dailyCap === undefined ? null : w.dailyCap),
    openConversation: () => Promise.resolve(convs ? { id: "00000000-0000-4000-8000-00000000c0c1" } : null),
    createConversation: () => { convs++; return Promise.resolve("00000000-0000-4000-8000-00000000c0c1"); },
    history: () => Promise.resolve([...history]),
    addMessage: (m) => {
      stored.push({ role: m.role, body: m.body, tools: m.tools, costMicros: m.totals?.costMicros, stopReason: m.stopReason, model: m.model });
      const row: StoredMessage = { id: `m${stored.length}`, role: m.role, body: m.body, created_at: "2026-10-27T12:00:00Z" };
      history.push(row);
      return Promise.resolve(row);
    },
    bumpConversation: () => Promise.resolve(),
    closeConversations: () => { closed++; return Promise.resolve(); },
    sweep: () => { swept++; return Promise.resolve(); },
    accountLine: () => Promise.resolve({ firstName: "Pat", title: "Owner", business: "Demo Sheds" }),
  };

  // A tools database that answers every read with nothing and records the tables touched.
  // deno-lint-ignore no-explicit-any
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
      return () => chain;
    },
  });
  const db = { from: (t: string) => { toolDb.push(t); return chain; } };

  let call = 0;
  const deps: AgentDeps = {
    env: (k) => env[k],
    store,
    toolCtx: { access: { settings_structures: "view" }, db, features: () => Promise.resolve(new Set<string>()) },
    fetch: async (url, init) => {
      assertEquals(url, "https://api.anthropic.com/v1/messages", "Claude's URL");
      const body = JSON.parse(String(init.body));
      asked.push({ headers: init.headers as Record<string, string>, body });
      call++;
      return w.claude ? await w.claude(body, call) : reply("Here is how.");
    },
    log: (e) => { logs.push(e); return Promise.resolve(); },
    now: w.clock ?? (() => Date.parse("2026-10-27T12:00:00Z")),
  };
  return { deps, asked, stored, logs, toolDb, history, counts: () => ({ swept, closed, convs, calls: call }) };
}

function reply(text: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: "claude-sonnet-5-5", stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    ...extra,
  }), { status: 200 });
}
function toolUse(name: string, input: Record<string, unknown> = {}, id = "toolu_1"): Response {
  return new Response(JSON.stringify({
    model: "claude-sonnet-5-5", stop_reason: "tool_use",
    content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id, name, input }],
    usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
  }), { status: 200 });
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

Deno.test("daily cap: NULL is the default, 0 is unlimited, n is n", () => {
  assertEquals(effectiveDailyCap(null), DEFAULT_DAILY_CAP);
  assertEquals(effectiveDailyCap(undefined), DEFAULT_DAILY_CAP);
  assertEquals(effectiveDailyCap(0), 0);
  assertEquals(effectiveDailyCap(2), 2);
  assertEquals(effectiveDailyCap(-5), DEFAULT_DAILY_CAP, "a negative stored value falls back to the default, never unlimited");
});

Deno.test("model and monthly ceiling come from the environment, with safe defaults", () => {
  assertEquals(modelFrom(() => undefined), DEFAULT_MODEL);
  assertEquals(DEFAULT_MODEL, "claude-sonnet-5-5", "Ahsan 10-27: Sonnet 5.5");
  assertEquals(modelFrom(() => "claude-opus-5-5"), "claude-opus-5-5");
  assertEquals(modelFrom(() => "gpt-4; drop table"), DEFAULT_MODEL, "a malformed value is ignored");
  assertEquals(monthlyCapMicros(() => undefined), 150_000_000);
  assertEquals(monthlyCapMicros(() => "40"), 40_000_000);
  assertEquals(monthlyCapMicros(() => "-1"), 150_000_000);
});

Deno.test("cost: Sonnet 5.5 list prices, cache reads and writes priced apart, unknown models priced high", () => {
  const t = addUsage(zeroTotals(), { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000 }, "claude-sonnet-5-5");
  // $2/M in, $10/M out, $2.50/M cache write, $0.20/M cache read = 2000 + 1000 + 5000 + 2000 micros.
  assertEquals(t.costMicros, 10000, "Sonnet 5.5 cost");
  assertEquals([t.input, t.output, t.cacheWrite, t.cacheRead], [1000, 100, 2000, 10000]);
  const u = addUsage(zeroTotals(), { input_tokens: 1000 }, "claude-mystery-9");
  assert(u.costMicros > 2000, "an unknown model costs more than Sonnet, never nothing");
  assertEquals(addUsage(zeroTotals(), { input_tokens: -5, output_tokens: "x" }, "claude-sonnet-5-5").costMicros, 0, "junk usage counts as zero");
});

Deno.test("history becomes alternating messages that start with the builder", () => {
  const m = toMessages([
    { role: "assistant", body: "orphan reply" },
    { role: "user", body: "one" },
    { role: "user", body: "two" },
    { role: "assistant", body: "answer" },
    { role: "assistant", body: " " },
  ], "three");
  assertEquals(m.map((x) => x.role), ["user", "assistant", "user"]);
  assertEquals(m[0].content, "one\n\ntwo");
  assertEquals(m[2].content, "three");
});

Deno.test("clip keeps stored answers inside the column", () => {
  assertEquals(clip("short"), "short");
  const long = "A sentence here. ".repeat(1000);
  const c = clip(long);
  assert(c.length <= 8000, "within 8,000");
  assert(c.endsWith("…"), "marked as cut");
});

// ── caps ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("the 13th message inside 10 minutes gets the cap sentence, and Claude is not asked", async () => {
  const w = world({ usage: { monthCostMicros: 0, tenant24h: 12, user10m: USER_10M_CAP } });
  const r = await handleSend(w.deps, WHO, { text: "hello" });
  assertEquals(r.body.capped, "user");
  assertEquals((r.body.reply as { body: string }).body, SENTENCES.userCap);
  assertEquals(w.asked.length, 0, "no call to Claude");
  assertEquals(w.stored.length, 0, "a refused message is not stored, so it does not grow the window");
  const ok = await handleSend(world({ usage: { monthCostMicros: 0, tenant24h: 11, user10m: USER_10M_CAP - 1 } }).deps, WHO, { text: "hello" });
  assertEquals(ok.body.ok, true, "the 12th is answered");
});

Deno.test("the tenant's daily cap: default 60, 0 unlimited, a lowered cap bites", async () => {
  let r = await handleSend(world({ usage: { monthCostMicros: 0, tenant24h: 60, user10m: 0 }, dailyCap: null }).deps, WHO, { text: "hi" });
  assertEquals(r.body.capped, "tenant", "60 used of the default 60");
  r = await handleSend(world({ usage: { monthCostMicros: 0, tenant24h: 59, user10m: 0 }, dailyCap: null }).deps, WHO, { text: "hi" });
  assertEquals(r.body.ok, true, "59 used of 60");
  r = await handleSend(world({ usage: { monthCostMicros: 0, tenant24h: 5000, user10m: 0 }, dailyCap: 0 }).deps, WHO, { text: "hi" });
  assertEquals(r.body.ok, true, "0 = unlimited (our own account)");
  r = await handleSend(world({ usage: { monthCostMicros: 0, tenant24h: 2, user10m: 0 }, dailyCap: 2 }).deps, WHO, { text: "hi" });
  assertEquals(r.body.capped, "tenant", "a cap lowered to 2 refuses the third");
  assertEquals((r.body.reply as { body: string }).body, SENTENCES.tenantCap);
});

Deno.test("the monthly ceiling switches the assistant to 'please submit a ticket'", async () => {
  const w = world({ usage: { monthCostMicros: 150_000_000, tenant24h: 0, user10m: 0 } });
  const r = await handleSend(w.deps, WHO, { text: "hi" });
  assertEquals(r.body.capped, "month");
  assert(String((r.body.reply as { body: string }).body).includes("ticket"), "offers a ticket");
  const s = await handleStatus(w.deps, WHO);
  assertEquals(s.body.available, false, "status says unavailable too");
});

Deno.test("an unreadable usage count fails OPEN; a missing API key fails closed with a ticket offer", async () => {
  const open = await handleSend(world({ usage: null }).deps, WHO, { text: "hi" });
  assertEquals(open.body.ok, true);
  const w = world({ key: null });
  const closed = await handleSend(w.deps, WHO, { text: "hi" });
  assertEquals(closed.body.capped, "unavailable");
  assertEquals(w.asked.length, 0);
});

Deno.test("empty and over-long questions are refused before anything else", async () => {
  const w = world();
  assertEquals((await handleSend(w.deps, WHO, { text: "   " })).status, 400);
  assertEquals((await handleSend(w.deps, WHO, { text: "x".repeat(MAX_USER_CHARS + 1) })).status, 400);
  assertEquals((await handleSend(w.deps, WHO, { text: 42 })).status, 400);
  assertEquals(w.asked.length + w.stored.length, 0);
});

// ── the request ──────────────────────────────────────────────────────────────────────────────

Deno.test("Claude is asked with Sonnet 5.5 at low effort, the fallback, strict tools and a cached knowledge prefix", async () => {
  const w = world();
  const r = await handleSend(w.deps, WHO, { text: "How do I add a door?" });
  assertEquals(r.body.ok, true);
  const { headers, body } = w.asked[0];
  assertEquals(body.model, "claude-sonnet-5-5");
  assertEquals(body.output_config, { effort: "low" });
  assertEquals(body.fallbacks, "default");
  assertEquals(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assertEquals(body.tool_choice, { type: "auto" });
  assert(!("thinking" in body), "thinking left adaptive (disabled is a 400 on Sonnet 5.5)");
  // deno-lint-ignore no-explicit-any
  const tools = body.tools as any[];
  assert(tools.length === 5 && tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false), "five strict tools");
  // deno-lint-ignore no-explicit-any
  const system = body.system as any[];
  assertEquals(system.length, 2);
  assertEquals(system[0].cache_control, { type: "ephemeral" }, "the shared prefix is the breakpoint");
  assert(system[0].text.includes(KNOWLEDGE), "the knowledge is in the cached block");
  assert(!system[0].text.includes("Demo Sheds"), "no tenant data in the shared, cached block");
  // Live run 10-27: with only the words of earlier turns kept, later turns "corrected" answers
  // that HAD been checked ("I hadn't run that lookup"). The rules now say earlier answers stand.
  assert(/never retract one for that reason/.test(system[0].text), "earlier answers are treated as checked");
  assert(system[1].text.includes("Pat") && system[1].text.includes("Demo Sheds") && !system[1].cache_control, "the per-person line is after the breakpoint");
  assertEquals(body.messages, [{ role: "user", content: "How do I add a door?" }]);
  assertEquals(w.stored.map((s) => s.role), ["user", "assistant"]);
  assertEquals(w.stored[1].body, "Here is how.");
  assertEquals(w.stored[1].model, "claude-sonnet-5-5");
  assert((w.stored[1].costMicros ?? 0) > 0, "cost recorded");
});

Deno.test("SUPPORT_AI_MODEL can switch the model; Haiku gets no fallback field (it would 400)", async () => {
  const w = world({ env: { SUPPORT_AI_MODEL: "claude-haiku-5-5" } });
  await handleSend(w.deps, WHO, { text: "hi" });
  assertEquals(w.asked[0].body.model, "claude-haiku-5-5");
  assert(!("fallbacks" in w.asked[0].body), "no fallbacks");
  assert(!("anthropic-beta" in w.asked[0].headers), "no fallback beta header");
});

Deno.test("a tool round: the tool runs on THIS tenant, the turn goes back whole, and the answer is stored with both rounds' cost", async () => {
  const w = world({ claude: (_b, n) => (n === 1 ? toolUse("get_my_requests") : reply("You have no open requests.")) });
  const r = await handleSend(w.deps, WHO, { text: "Any news on my requests?" });
  assertEquals(r.body.ok, true);
  assertEquals(w.asked.length, 2);
  assertEquals(w.toolDb[0], "feedback_submissions", "the tool read the requests table");
  // deno-lint-ignore no-explicit-any
  const second = w.asked[1].body.messages as any[];
  assertEquals(second.map((m) => m.role), ["user", "assistant", "user"]);
  assertEquals(second[1].content[1].type, "tool_use", "the assistant turn is passed back unchanged");
  assertEquals(second[2].content[0].type, "tool_result");
  assertEquals(second[2].content[0].tool_use_id, "toolu_1");
  assertEquals(w.stored[1].tools, ["get_my_requests"], "tool NAMES are stored");
  const oneRound = addUsage(zeroTotals(), { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 5000 }, "claude-sonnet-5-5").costMicros
    + addUsage(zeroTotals(), { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000 }, "claude-sonnet-5-5").costMicros;
  assertEquals(w.stored[1].costMicros, oneRound, "both rounds are priced");
});

Deno.test("offer_handoff reaches the portal as a card, and changes nothing by itself", async () => {
  const w = world({
    claude: (_b, n) => (n === 1 ? toolUse("offer_handoff", { title: "Estimate emails not arriving", summary: "Estimates do not reach customers." }) : reply("I can send this to the team.")),
  });
  const r = await handleSend(w.deps, WHO, { text: "my estimates are broken" });
  assertEquals(r.body.handoff, { title: "Estimate emails not arriving", summary: "Estimates do not reach customers." });
  assertEquals(w.toolDb.length, 0, "no database touched");
});

Deno.test("out of tool rounds, the last call forbids tools so the model must answer", async () => {
  const w = world({ claude: (b) => ((b.tool_choice as { type: string }).type === "none" ? reply("Best I can tell...") : toolUse("get_account_overview")) });
  const r = await handleSend(w.deps, WHO, { text: "check everything" });
  assertEquals(w.asked.length, MAX_TOOL_ROUNDS + 1);
  assertEquals((w.asked[MAX_TOOL_ROUNDS].body.tool_choice as { type: string }).type, "none");
  assertEquals(r.body.ok, true);
  assertEquals(w.stored[1].body, "Best I can tell...");
});

// ── fixed sentences ──────────────────────────────────────────────────────────────────────────

Deno.test("a refusal, a cut-off answer, an HTTP fault and a timeout each answer with a fixed sentence", async () => {
  const cases: [World["claude"], string, string][] = [
    [() => reply("", { stop_reason: "refusal", content: [], stop_details: { category: "general_harms" } }), SENTENCES.refusal, "refusal"],
    [() => reply("partial", { stop_reason: "max_tokens" }), SENTENCES.cutOff, "max_tokens"],
    [() => new Response("overloaded", { status: 529 }), SENTENCES.failed, "error"],
    [() => new Response("bad", { status: 400 }), SENTENCES.failed, "error"],
    [() => reply("", { content: [{ type: "thinking", thinking: "" }] }), SENTENCES.noText, "end_turn"],
  ];
  for (const [claude, sentence, stop] of cases) {
    const w = world({ claude });
    const r = await handleSend(w.deps, WHO, { text: "x" });
    assertEquals(r.body.ok, true, `${stop}: still answers`);
    assertEquals(w.stored[1].body, sentence, `${stop}: sentence`);
    assertEquals(w.stored[1].stopReason, stop, `${stop}: stop reason stored`);
  }
  // The turn's clock runs out: no call is made past the deadline.
  let t = Date.parse("2026-10-27T12:00:00Z");
  const w = world({ clock: () => t, claude: () => { t += 95_000; return toolUse("get_my_requests"); } });
  await handleSend(w.deps, WHO, { text: "x" });
  assertEquals(w.stored[1].body, SENTENCES.timeout);
  assertEquals(w.asked.length, 1, "no second call after the 90 s turn limit");
});

Deno.test("no message text, answer or tool output ever reaches a log", async () => {
  const w = world({
    claude: (_b, n) => (n === 1 ? toolUse("get_my_requests") : n === 2 ? new Response(SECRET, { status: 500 }) : reply(SECRET)),
  });
  await handleSend(w.deps, WHO, { text: `Help, ${SECRET}` });
  const w2 = world({ claude: () => reply("", { stop_reason: "refusal", content: [] }) });
  await handleSend(w2.deps, WHO, { text: `Help, ${SECRET}` });
  const all = JSON.stringify([...w.logs, ...w2.logs]);
  assert(w.logs.length > 0 && w2.logs.length > 0, "the faults were logged");
  assert(!all.includes("4321") && !all.includes("gate code"), "no words in any log");
});

// ── status and new ───────────────────────────────────────────────────────────────────────────

Deno.test("status: the name, the 24-hour promise, live support hidden, and the retention sweep", async () => {
  const w = world();
  const s = await handleStatus(w.deps, WHO);
  assertEquals(s.body.name, "Studio Assistant", "Ahsan 10-27");
  assertEquals(s.body.replyPromise, "A person on our team replies within 24 hours.", "Ahsan 10-27");
  assertEquals(s.body.liveSupport, { available: false }, "stage 2 is a hidden flag only");
  assertEquals(s.body.available, true);
  assertEquals(w.counts().swept, 1, "idle chats are swept on status");
  const nk = await handleStatus(world({ key: null }).deps, WHO);
  assertEquals(nk.body.available, false);
});

Deno.test("new closes the open chat (kept for the team) and the next send starts another", async () => {
  const w = world();
  await handleSend(w.deps, WHO, { text: "one" });
  await handleNew(w.deps, WHO);
  assertEquals(w.counts().closed, 1);
});
