import { assert, assertEquals } from "./test_assert.ts";
import { checkGate, gateIsRead, type Level } from "../_shared/access.ts";
import { ASKS_ROLE, type CallerCtx, GATES, type HandlerIO, makeHandler, makeStore, type Resolve, roleFor, ROUTES } from "./handler.ts";
import { REPEATED_WORDS_MARK, SENTENCES, type Wallet } from "./agent.ts";

/** A wallet whose meter is off (agent_test.ts has the same one): nothing moves. */
const quietWallet = (): Wallet => ({
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
});

// Jack's HTTP door (handler.ts), which index.ts only serves. No network and no database: the
// service-role client and resolveTenant are fakes, and every query the store makes is recorded.

// ── A service-role client that records every query and answers from the test ─────────────────────

type Op = [string, ...unknown[]];
interface Query { table: string; ops: Op[] }
type Answer = (q: Query) => { data?: unknown; error?: unknown } | undefined;

function fakeAdmin(answer: Answer = () => undefined) {
  const queries: Query[] = [];
  const settle = (q: Query) => {
    const a = answer(q);
    const one = q.ops.some(([m]) => m === "maybeSingle" || m === "single");
    return Promise.resolve({ data: a && "data" in a ? a.data : one ? null : [], error: a?.error ?? null });
  };
  const from = (table: string) => {
    const q: Query = { table, ops: [] };
    queries.push(q);
    // deno-lint-ignore no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "in", "lt", "order", "limit", "update", "insert", "upsert", "delete"]) b[m] = (...a: unknown[]) => { q.ops.push([m, ...a]); return b; };
    b.maybeSingle = () => { q.ops.push(["maybeSingle"]); return settle(q); };
    b.single = () => { q.ops.push(["single"]); return settle(q); };
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => settle(q).then(ok, bad);
    return b;
  };
  const rpc = (fn: string, args: unknown) => {
    const q: Query = { table: `rpc:${fn}`, ops: [["rpc", args]] };
    queries.push(q);
    return settle(q);
  };
  return { admin: { from, rpc }, queries };
}
const opOf = (q: Query, name: string, col?: string) => q.ops.find(([m, c]) => m === name && (col === undefined || c === col));
const eqOf = (q: Query, col: string) => opOf(q, "eq", col)?.[2];
const selected = (q: Query) => String(opOf(q, "select")?.[1] ?? "");

/** resolveTenant's part that this file depends on, with the REAL gate check (access.ts checkGate) on the
 *  table the handler passes: what the handler is refused is what that table says. */
function gatedResolve(access: Record<string, Level>, over: Partial<CallerCtx> = {}, seen: Parameters<Resolve>[2][] = []): Resolve {
  return async (req, _admin, opts) => {
    seen.push(opts);
    const payload = await req.json();
    const action = String(payload?.action || opts.defaultAction);
    const gate = opts.gates[action];
    if (!gate) return { ok: false, status: 403, body: { error: `Unrecognised action "${action}".` } };
    const why = checkGate(gate, access);
    if (why) return { ok: false, status: 403, body: { error: why } };
    const audits: string[] = [];
    return {
      ok: true,
      ctx: {
        clientId: "builder-a", userId: "u1", selfUserId: "u1", operator: null, payload, action,
        canRead: () => true, canEdit: () => true, audit: (a) => { audits.push(a); return Promise.resolve(); },
        ...over,
      },
    };
  };
}

function io(admin: unknown, resolve: Resolve, over: Partial<HandlerIO> = {}) {
  const fetches: string[] = [];
  const logs: string[] = [];
  const base: HandlerIO = {
    // No JACK_ANTHROPIC_API_KEY: nothing here can reach Claude.
    env: (k) => ({ SUPABASE_URL: "https://project.example.test", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon" } as Record<string, string>)[k],
    admin: () => admin,
    resolveTenant: resolve,
    wallet: () => quietWallet(),
    logEdgeError: (e) => { logs.push(e.code); return Promise.resolve(); },
    fetch: (input) => { fetches.push(String(input)); return Promise.resolve(new Response("{}", { status: 404 })); },
    ...over,
  };
  return { io: base, fetches, logs };
}
const post = (body: Record<string, unknown>) => new Request("https://project.example.test/functions/v1/jack-agent", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });

// ── GATES: which part of the Team screen's `jack` row each action needs ─────────────────────────────

const READS = ["activity", "enabled", "proposal_get", "status"];

Deno.test("every action Jack answers has a gate, and every gate an action", () => {
  assertEquals(Object.keys(GATES).sort(), Object.keys(ROUTES).sort());
  for (const a of ASKS_ROLE) assert(a in ROUTES, a);
});

Deno.test("who may call what: jack at edit reaches every action, at view only the four reads, and without it only enabled", () => {
  const allowed = (access: Record<string, Level>) => Object.keys(GATES).filter((a) => checkGate(GATES[a], access) === null).sort();
  assertEquals(allowed({ jack: "edit" }), Object.keys(GATES).sort());
  assertEquals(allowed({ jack: "view" }), READS);
  assertEquals(allowed({ jack: "none" }), ["enabled"]);
  assertEquals(allowed({}), ["enabled"]);
  // Holding every other area at edit doesn't reach Jack: each card's own areas are checked again in agent.ts.
  assertEquals(allowed({ settings_structures: "edit", settings_options: "edit", contacts: "edit", settings_billing: "edit" }), ["enabled"]);
  // What a read-only operator may call is worked out from the gate: the same four reads.
  assertEquals(Object.keys(GATES).filter((a) => gateIsRead(GATES[a])).sort(), READS);
  // Each one names the jack area and nothing else; enabled is the one open action.
  for (const [a, g] of Object.entries(GATES)) {
    if (a === "enabled") assertEquals(g, "open");
    else assert(typeof g === "object" && "area" in g && g.area === "jack" && (g.level === "edit" || READS.includes(a)), a);
  }
});

Deno.test("the handler hands resolveTenant this gate table, and answers a refusal as it is, reading and calling nothing", async () => {
  const seen: Parameters<Resolve>[2][] = [];
  const db = fakeAdmin();
  const t = io(db.admin, gatedResolve({ jack: "view" }, {}, seen));
  const h = makeHandler(t.io);
  for (const action of ["send", "proposal_approve", "proposal_undo", "set_switches", "sheet_start", "memory_set"]) {
    const res = await h(post({ action, id: "00000000-0000-4000-8000-000000000001", hash: "h", send: true }));
    assertEquals(res.status, 403, action);
    assert(String((await res.json()).error).includes("Ask an owner or admin"), action);
  }
  assertEquals(seen[0].gates, GATES);
  assertEquals([seen[0].defaultAction, seen[0].readActions.size], ["status", 0]);
  assertEquals([db.queries.length, t.fetches.length], [0, 0]);

  // The same person may read.
  const ok = await h(post({ action: "enabled" }));
  assertEquals(ok.status, 200);
});

Deno.test("an action resolveTenant lets through that Jack doesn't answer is a 400, and reads nothing", async () => {
  const db = fakeAdmin();
  const loose: Resolve = async (req) => {
    const payload = await req.json();
    return { ok: true, ctx: { clientId: "builder-a", userId: "u1", selfUserId: "u1", operator: null, payload, action: String(payload.action), canRead: () => true, canEdit: () => true, audit: () => Promise.resolve() } };
  };
  const res = await makeHandler(io(db.admin, loose).io)(post({ action: "launch_rockets" }));
  assertEquals([res.status, (await res.json()).error], [400, "Unknown action."]);
  assertEquals(db.queries.length, 0);
});

Deno.test("OPTIONS, GET and the warm-up ping never reach resolveTenant", async () => {
  let asked = 0;
  const never: Resolve = () => { asked++; return Promise.reject(new Error("not here")); };
  const h = makeHandler(io(fakeAdmin().admin, never).io);
  assertEquals((await h(new Request("https://project.example.test/x", { method: "OPTIONS" }))).status, 200);
  assertEquals((await h(new Request("https://project.example.test/x", { method: "GET" }))).status, 405);
  const warm = await h(new Request("https://project.example.test/x?warm=1", { method: "POST", body: "{}" }));
  assertEquals([warm.status, await warm.json()], [200, { ok: true }]);
  assertEquals(asked, 0);
});

// ── The role: who decides for the whole builder ──────────────────────────────────────────────────

Deno.test("roleFor: only the actions that ask read it; the team viewing the builder is its owner; one wearing a person is that person; a failed read is no role", async () => {
  let reads = 0;
  const read = (role: string | null) => () => { reads++; return Promise.resolve({ role }); };
  for (const a of ["enabled", "send", "proposal_approve", "proposal_undo", "activity", "chat", "new"]) assertEquals(await roleFor(a, null, read("owner")), null, a);
  assertEquals(reads, 0);
  for (const a of ASKS_ROLE) {
    assertEquals(await roleFor(a, { asUserId: null }, read("user")), "owner", a);
    assertEquals(await roleFor(a, { asUserId: "u7" }, read("user")), "user", a);
    assertEquals(await roleFor(a, null, read("admin")), "admin", a);
    assertEquals(await roleFor(a, null, () => Promise.reject(new Error("db"))), null, a);
  }
  assertEquals(reads, ASKS_ROLE.size * 2);
});

/** A builder whose Jack is on, and whose team rows say each person's role. */
function builderDb(roles: Record<string, string>, over: Answer = () => undefined) {
  return fakeAdmin((q) => {
    const own = over(q);
    if (own) return own;
    if (q.table === "client_users" && selected(q).includes("role")) {
      const id = String(eqOf(q, "user_id"));
      return { data: roles[id] ? { full_name: "Pat Example", title: null, role: roles[id] } : null };
    }
    if (q.table === "client_settings" && selected(q).includes("jack_on")) return { data: { jack_on: true, jack_off: [] } };
    if (q.table === "client_settings" && selected(q).includes("business_name")) return { data: { business_name: "Example Sheds" } };
    if (q.table === "rpc:jack_usage") return { data: { month_cost_micros: 0, tenant_24h: 0, user_10m: 0, sheets_24h: 0 } };
    return undefined;
  });
}
const switchWrites = (db: ReturnType<typeof fakeAdmin>) => db.queries.filter((q) => q.table === "client_settings" && opOf(q, "update"));
const roleReads = (db: ReturnType<typeof fakeAdmin>) => db.queries.filter((q) => q.table === "client_users" && selected(q).includes("role"));

Deno.test("through the door: the role comes from the caller's own team row, and only an owner or admin sets a switch", async () => {
  const flip = { action: "set_switches", key: "prices", on: false };
  // A user: refused, and nothing written.
  const asUser = builderDb({ u1: "user" });
  const r1 = await makeHandler(io(asUser.admin, gatedResolve({ jack: "edit" })).io)(post(flip));
  assertEquals([r1.status, (await r1.json()).error], [403, "An owner or admin sets what Jack can do."]);
  assertEquals(switchWrites(asUser).length, 0);
  assertEquals(roleReads(asUser).map((q) => [eqOf(q, "client_id"), eqOf(q, "user_id")]), [["builder-a", "u1"]]);

  // An admin: written, once.
  const asAdmin = builderDb({ u1: "admin" });
  const r2 = await makeHandler(io(asAdmin.admin, gatedResolve({ jack: "edit" })).io)(post(flip));
  assertEquals([r2.status, (await r2.json()).off], [200, ["prices"]]);
  assertEquals(switchWrites(asAdmin).map((q) => opOf(q, "update")?.[1]), [{ jack_off: ["prices"] }]);

  // A read that fails is no role, which refuses.
  const broken = builderDb({ u1: "owner" }, (q) => (q.table === "client_users" ? { error: { message: "down" } } : undefined));
  const r3 = await makeHandler(io(broken.admin, gatedResolve({ jack: "edit" })).io)(post(flip));
  assertEquals(r3.status, 403);
  assertEquals(switchWrites(broken).length, 0);
});

Deno.test("through the door: the team viewing a builder is its owner without a read; wearing a person, it is that person, read by that person's id", async () => {
  const flip = { action: "set_switches", key: "prices", on: false };
  const viewing = builderDb({});
  const op = { email: "ops@example.test", asUserId: null };
  const r1 = await makeHandler(io(viewing.admin, gatedResolve({ jack: "edit" }, { userId: "op1", selfUserId: "op1", operator: op })).io)(post(flip));
  assertEquals(r1.status, 200);
  assertEquals(roleReads(viewing).length, 0);

  // Wearing a sales rep: the rep's own row (selfUserId) decides, never the operator's id.
  const wearing = builderDb({ u7: "user", op1: "owner" });
  const r2 = await makeHandler(io(wearing.admin, gatedResolve({ jack: "edit" }, { userId: "op1", selfUserId: "u7", operator: { ...op, asUserId: "u7" } })).io)(post(flip));
  assertEquals(r2.status, 403);
  assertEquals(roleReads(wearing).map((q) => eqOf(q, "user_id")), ["u7"]);
  assertEquals(switchWrites(wearing).length, 0);
});

Deno.test("through the door: enabled reads only the switch, and status says who may manage Jack from the role", async () => {
  const db = builderDb({ u1: "owner" });
  const h = makeHandler(io(db.admin, gatedResolve({ jack: "edit" })).io);
  const e = await h(post({ action: "enabled" }));
  assertEquals([e.status, (await e.json()).on], [200, true]);
  assertEquals(db.queries.map((q) => q.table), ["client_settings"]);

  const s = await h(post({ action: "status" }));
  assertEquals((await s.json()).canManage, true);
  const user = builderDb({ u1: "user" });
  const s2 = await makeHandler(io(user.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "status" }));
  assertEquals((await s2.json()).canManage, false);
});

// ── The store's queries ──────────────────────────────────────────────────────────────────────────

Deno.test("the claim a press makes: one update on this builder's row that lands only at the statuses given", async () => {
  const db = fakeAdmin((q) => (q.table === "jack_proposals" && opOf(q, "update") ? { data: eqOf(q, "id") === "p1" ? [{ id: "p1", status: "applying" }] : [] } : undefined));
  const store = makeStore(db.admin);
  const got = await store.updateProposal("builder-a", "p1", { status: "applying", approved_by: "u1" }, ["ready"]);
  assertEquals(got, { id: "p1", status: "applying" });
  const q = db.queries[0];
  assertEquals([eqOf(q, "id"), eqOf(q, "client_id"), opOf(q, "in", "status")?.[2], opOf(q, "eq", "updated_at")], ["p1", "builder-a", ["ready"], undefined]);
  // A row that had moved on comes back as nothing (the second press).
  assertEquals(await store.updateProposal("builder-a", "p2", { status: "applying" }, ["ready"]), null);
  // A give-up also checks that nothing wrote the row since it was read.
  await store.updateProposal("builder-a", "p1", { status: "partly_applied" }, ["applying"], "2026-11-09T10:00:00.123456+00:00");
  assertEquals(eqOf(db.queries[2], "updated_at"), "2026-11-09T10:00:00.123456+00:00");
});

Deno.test("the history read brings each answer's tools and stop reason, oldest first; the mark is stored with the tool names; the page gets neither", async () => {
  const rows = [
    { id: "m4", role: "assistant", body: "Jack's answer", created_at: "4", proposal_ids: null, tools: ["look_up_customer", REPEATED_WORDS_MARK], stop_reason: "end_turn" },
    { id: "m3", role: "user", body: "what did they say?", created_at: "3", proposal_ids: [], tools: [], stop_reason: null },
  ];
  const db = builderDb({ u1: "owner" }, (q) => {
    if (q.table === "jack_conversations" && opOf(q, "maybeSingle")) return { data: { id: "c1" } };
    if (q.table === "jack_conversations") return { data: [{ id: "c1" }] };
    if (q.table === "jack_messages" && opOf(q, "insert")) return { data: { id: "m5", role: "assistant", body: "x", created_at: "5", proposal_ids: [] } };
    if (q.table === "jack_messages") return { data: rows };
    return undefined;
  });
  const store = makeStore(db.admin);
  const who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
  const history = await store.messages(who, "c1", 20);
  assertEquals(history?.map((m) => [m.id, (m as unknown as { tools: string[] }).tools, (m as unknown as { stop_reason: string | null }).stop_reason]), [
    ["m3", [], null], ["m4", ["look_up_customer", REPEATED_WORDS_MARK], "end_turn"],
  ]);
  assert(selected(db.queries.find((q) => q.table === "jack_messages")!).includes("tools, stop_reason"));

  await store.addMessage({ chatId: "c1", who, role: "assistant", body: "x", tools: ["look_up_customer", REPEATED_WORDS_MARK], stopReason: "end_turn" });
  const insert = db.queries.find((q) => q.table === "jack_messages" && opOf(q, "insert"))!;
  // deno-lint-ignore no-explicit-any
  const written = opOf(insert, "insert")?.[1] as any;
  assertEquals([written.tools, written.stop_reason], [["look_up_customer", REPEATED_WORDS_MARK], "end_turn"]);

  // The page's copy of the chat is the message as it always was.
  const res = await makeHandler(io(db.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "status" }));
  const chat = (await res.json()).chat;
  assertEquals(chat.messages.map((m: Record<string, unknown>) => Object.keys(m).sort()), [
    ["body", "created_at", "id", "proposal_ids", "role"], ["body", "created_at", "id", "proposal_ids", "role"],
  ]);
});

Deno.test("a usage read that fails stops a send at the door, before any chat is opened", async () => {
  const db = builderDb({ u1: "owner" }, (q) => (q.table === "rpc:jack_usage" ? { error: { message: "down" } } : undefined));
  const t = io(db.admin, gatedResolve({ jack: "edit" }), { env: (k) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : k === "SUPABASE_URL" ? "https://project.example.test" : undefined) });
  const res = await makeHandler(t.io)(post({ action: "send", text: "hello" }));
  const body = await res.json();
  assertEquals([res.status, body.capped, body.reply.body], [200, "usage", SENTENCES.usageUnread]);
  assert(!db.queries.some((q) => q.table === "jack_conversations" || q.table === "jack_messages"));
  assertEquals(t.fetches.length, 0);
});

// ── Plans as data: the company's tab map, through the door (plan.ts) ──────────────────────────────

const CARD_ID = "00000000-0000-4000-8000-0000000000c1";
/** A waiting card of `kind`, as the proposals table holds it. */
const waitingCard = (kind: string, over: Record<string, unknown> = {}) => ({
  id: CARD_ID, client_id: "builder-a", user_id: "u1", conversation_id: "c1", kind, status: "ready", title: "A card", file_name: null,
  source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: "h", failure: null,
  approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(), updated_at: "u0", ...over,
});
/** A builder with one card, whose map read answers `answer` (the server's own shape, or null). */
function planDb(kind: string, answer: unknown, card: Record<string, unknown> = {}) {
  return builderDb({ u1: "owner" }, (q) => {
    if (q.table === "rpc:access_for_server") return { data: answer };
    if (q.table === "jack_proposals" && opOf(q, "update")) return { data: [] };
    if (q.table === "jack_proposals") return { data: opOf(q, "maybeSingle") || opOf(q, "single") ? waitingCard(kind, card) : [waitingCard(kind, card)] };
    return undefined;
  });
}
const mapReads = (db: ReturnType<typeof fakeAdmin>) => db.queries.filter((q) => q.table === "rpc:access_for_server");
const cardWrites = (db: ReturnType<typeof fakeAdmin>) => db.queries.filter((q) => q.table === "jack_proposals" && opOf(q, "update"));
const NO_RULES = { mode: "block", modules: { jack: "on", contacts: "on", automations: "hidden", designer: "hidden" } };

Deno.test("through the door: an approve asks the company's map once, by the company's id, and block mode refuses before anything is written", async () => {
  const db = planDb("automation_rule", NO_RULES);
  const t = io(db.admin, gatedResolve({ jack: "edit" }));
  const res = await makeHandler(t.io)(post({ action: "proposal_approve", id: CARD_ID, hash: "h" }));
  assertEquals([res.status, await res.json()], [403, { error: "This isn't part of your plan. Ask Structure Studio to add it to your account.", code: "module_off" }]);
  assertEquals(mapReads(db).map((q) => q.ops[0][1]), [{ p_client_id: "builder-a" }]);
  assertEquals([cardWrites(db).length, t.fetches.length], [0, 0], "the card was not claimed and nothing was called downstream");
  // "locked" is not "on".
  const locked = planDb("automation_rule", { mode: "block", modules: { ...NO_RULES.modules, automations: "locked" } });
  const r2 = await makeHandler(io(locked.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "proposal_approve", id: CARD_ID, hash: "h" }));
  assertEquals((await r2.json()).code, "module_off");
});

Deno.test("through the door: not named, a failed read and a malformed answer refuse nothing; report files one row and goes on", async () => {
  for (const [name, db] of [
    ["not named", planDb("automation_rule", null)],
    ["the read fails", builderDb({ u1: "owner" }, (q) => (q.table === "rpc:access_for_server" ? { error: { message: "down" } } : q.table === "jack_proposals" && !opOf(q, "update") ? { data: waitingCard("automation_rule") } : undefined))],
    ["a malformed answer", planDb("automation_rule", { mode: "block", modules: {} })],
    ["the tab is on", planDb("automation_rule", { mode: "block", modules: { ...NO_RULES.modules, automations: "on" } })],
  ] as const) {
    const quiet = console.error;
    console.error = () => {};
    try {
      const t = io(db.admin, gatedResolve({ jack: "edit" }));
      const res = await makeHandler(t.io)(post({ action: "proposal_approve", id: CARD_ID, hash: "h" }));
      const body = await res.json();
      assert(body.code !== "module_off", `${name}: refused by a plan`);
      assert(cardWrites(db).length > 0 || res.status === 409, `${name}: the press went on to its own approve path (${res.status})`);
      assertEquals(t.logs.filter((c) => c === "module_would_refuse").length, 0, name);
    } finally {
      console.error = quiet;
    }
  }
  const db = planDb("automation_rule", { ...NO_RULES, mode: "report" });
  const t = io(db.admin, gatedResolve({ jack: "edit" }, { clientId: "report-door-co" }));
  const res = await makeHandler(t.io)(post({ action: "proposal_approve", id: CARD_ID, hash: "h" }));
  assert((await res.json()).code !== "module_off");
  assertEquals(t.logs.filter((c) => c === "module_would_refuse").length, 1);
});

Deno.test("through the door: status asks the company's map once Jack is switched on, and says when a message would be refused", async () => {
  // Block mode, the Jack tab taken away, the company's own switch still on (builderDb). The door lets
  // status through (it has no tab), and the answer tells the page what the door will say to a message.
  const lost = planDb("size_rule", { mode: "block", modules: { jack: "hidden", designer: "on" } });
  const res = await makeHandler(io(lost.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "status" }));
  const body = await res.json();
  assertEquals([res.status, body.enabled, body.available, body.unavailable], [200, true, false, "This isn't part of your plan. Ask Structure Studio to add it to your account."]);
  assertEquals(mapReads(lost).map((q) => q.ops[0][1]), [{ p_client_id: "builder-a" }]);
  // With the tab, in report mode and for a company that is not named, the plan says nothing.
  for (const answer of [{ mode: "block", modules: { jack: "on", designer: "hidden" } }, { mode: "report", modules: { jack: "hidden" } }, null]) {
    const db = planDb("size_rule", answer);
    const b = await (await makeHandler(io(db.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "status" }))).json();
    assert(b.enabled === true && b.unavailable !== body.unavailable, JSON.stringify(answer));
  }
  // The company's own switch off: "not switched on", and the map is not read at all.
  const off = builderDb({ u1: "owner" }, (q) => {
    if (q.table === "rpc:access_for_server") return { data: { mode: "block", modules: { jack: "hidden" } } };
    if (q.table === "client_settings" && selected(q).includes("jack_on")) return { data: { jack_on: false, jack_off: [] } };
    return undefined;
  });
  const said = await (await makeHandler(io(off.admin, gatedResolve({ jack: "edit" })).io)(post({ action: "status" }))).json();
  assertEquals([said.enabled, mapReads(off).length], [false, 0]);
});

Deno.test("through the door: a card's record, a dismissed card and Undo never ask the map, and neither does a card of every account", async () => {
  const applied = { status: "applied", undo: { removes: [], sizes: [] }, shown_hash: "h" };
  for (const [action, kind, card] of [
    ["activity", "size_rule", {}], ["proposal_get", "size_rule", {}],
    ["proposal_cancel", "size_rule", {}], ["proposal_undo", "size_rule", applied],
    ["new", "size_rule", {}], ["set_switches", "size_rule", {}], ["enabled", "size_rule", {}],
    // A setup card is every account's: approving it reads no map either.
    ["proposal_approve", "setup_tick", {}],
  ] as const) {
    const db = planDb(kind, { mode: "block", modules: { jack: "on", designer: "hidden" } }, card);
    const res = await makeHandler(io(db.admin, gatedResolve({ jack: "edit" })).io)(post({ action, id: CARD_ID, hash: "h", key: "prices", on: false }));
    const body = await res.json().catch(() => ({}));
    assertEquals(mapReads(db).length, 0, `${action} read the company's map`);
    assert(body.code !== "module_off", `${action} was refused by a plan`);
  }
});

Deno.test("through the door: a price list in block mode without the Designer is refused before a card or a chat is made", async () => {
  const db = planDb("price_sheet", { mode: "block", modules: { jack: "on", designer: "off" } });
  const t = io(db.admin, gatedResolve({ jack: "edit" }), { env: (k) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : k === "SUPABASE_URL" ? "https://project.example.test" : undefined) });
  const res = await makeHandler(t.io)(post({ action: "sheet_start", fileName: "prices.csv", sheets: [{ name: "S", rows: [["Style", "Size", "Price"], ["Garden", "10x12", "4200"]] }] }));
  assertEquals([res.status, (await res.json()).code], [403, "module_off"]);
  assertEquals(mapReads(db).length, 1);
  assert(!db.queries.some((q) => q.table === "jack_conversations" || q.table === "jack_messages" || q.table === "jack_proposals"), "nothing was opened or written");
  assertEquals(t.fetches.length, 0);
});
