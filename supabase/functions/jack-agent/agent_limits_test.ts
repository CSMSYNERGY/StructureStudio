// What stops Jack (agent.ts): the spending caps and what happens when they can't be read, the person
// cap under parallel sends, the activity page's per-area filter and its operator audit, the new-door
// tool's limits, and one turn's own limits (rounds, the last no-tools round, the 120 s budget, a refusal,
// a cut-off answer, the last-net scrub). The audit of 11-09 found each of these untested or open.
// Fakes only: no database, no network, no real waiting.

import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, handleActivity, handleSend, handleSheetStart, MAX_TOOL_ROUNDS, monthlyCapMicros, type ProposalRow, runTool, runTurn, SENTENCES, SHEETS_DAILY_CAP,
  type Store, type StoredMessage, TENANT_DAILY_CAP, TURN_TIMEOUT_MS, type TurnState, type Usage, USER_10M_CAP, usageOf, type Who,
} from "./agent.ts";
import { forgetGrantsSeen, WALLET_SAID } from "./billing.ts";
import { PIECE_TOOLS } from "./pieces.ts";
import type { ToolSpec, Wallet } from "./types.ts";

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const operator: Who = { ...who, operatorEmail: "ops@example.test" };
const V = "2026-11-01T00:00:00.000000+00:00";
const TABLE = {
  styles: [{ id: "garden", label: "Garden Shed" }],
  sizes: [{ id: "s1", style_id: "garden", label: "10x12", width_ft: 10, length_ft: 12, base_price: 4000, active: true, updated_at: V }],
  inclusions: [],
  counts: { sizes: 1, inclusions: 0 },
};
const SINGLE = { id: "d1", name: "Single door", category: "door", width_in: 36, height_in: 80 };
const ZERO: Usage = { monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 };
const SHEET = { fileName: "prices.csv", sheets: [{ name: "Prices", rows: [["Size", "Price"], ["10x12", "$4,350"]] }] };
const MAP = {
  blocks: [{ kind: "list", sheet: 0, firstRow: 1, lastRow: 1, styleCol: null, styleFixed: "Garden Sheds", sizeCol: 0, widthCol: null, lengthCol: null, priceCol: 1, stylesAcross: [], lengthHeaderRow: null, firstPriceCol: null, lastPriceCol: null, options: [] }],
  styleMatches: [], cannotRead: null,
};

/** A store whose usage() counts what it holds, as jack_usage does: the person's messages, the
 *  builder's messages, and the builder's price lists. `usage` overrides it. */
function makeStore(init: { usage?: () => Promise<Usage | null> } = {}) {
  const proposals = new Map<string, ProposalRow>();
  const messages: (StoredMessage & { user_id: string; stop_reason?: string | null; charge?: unknown })[] = [];
  let seq = 0;
  const counted = (): Usage => ({
    monthCostMicros: 0,
    tenant24h: messages.filter((m) => m.role === "user").length,
    user10m: messages.filter((m) => m.role === "user" && m.user_id === who.userId).length,
    sheets24h: [...proposals.values()].filter((p) => p.kind === "price_sheet").length,
  });
  const store: Store = {
    settings: () => Promise.resolve({ on: true, off: [] }),
    setOff: () => Promise.resolve(),
    usage: init.usage ?? (() => Promise.resolve(counted())),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => {
      const r = { id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [], user_id: m.who.userId, stop_reason: m.stopReason ?? null, charge: m.charge };
      messages.push(r);
      return Promise.resolve(r);
    },
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Pat", title: "Owner", business: "Example Sheds", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(), ...p } as ProposalRow;
      proposals.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c, id) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status))) return Promise.resolve(null);
      Object.assign(r, patch);
      return Promise.resolve(r);
    },
    addProposalCost: () => Promise.resolve(),
    proposals: () => Promise.resolve([...proposals.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve("f1"),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(true),
    forgetMemory: () => Promise.resolve(true),
  };
  return { store, proposals, messages };
}

/** The meter off: nothing is billable, and the wallet is never asked for a balance. */
function quietWallet(): Wallet {
  return {
    meter: () => Promise.resolve({ active: false, markup: 1.5 }),
    exempt: () => Promise.resolve(false),
    account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
    debit: () => Promise.resolve({ ok: true, txId: 1 }),
    grantOnce: () => Promise.resolve(true),
    requestTopup: () => {},
    mark: () => Promise.resolve(),
    pending: () => Promise.resolve([]),
  };
}

function makeDeps(store: Store, over: Partial<Deps> = {}, claude: unknown[] = []) {
  const claudeBodies: Record<string, unknown>[] = [];
  const background: Promise<unknown>[] = [];
  const logs: { code: string; severity?: string; context?: Record<string, unknown> }[] = [];
  const audits: { action: string; rows: number | null; note: string | null }[] = [];
  const portalCalls: string[] = [];
  const deps: Deps = {
    env: (k) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : undefined),
    store,
    portal: (action) => {
      portalCalls.push(action);
      if (action === "size_table") return Promise.resolve({ status: 200, data: TABLE as unknown as Record<string, unknown> });
      if (action === "catalog") return Promise.resolve({ status: 200, data: { items: [], fixtures: [SINGLE] } });
      return Promise.resolve({ status: 200, data: { ok: true } });
    },
    call() { return Promise.resolve({ status: 404, data: null }); },
    wallet: quietWallet(),
    fetch: (_u, init) => {
      claudeBodies.push(JSON.parse(String(init.body)));
      const next = claude.shift();
      if (!next) throw new Error("Claude was asked more times than this test expected");
      return Promise.resolve(new Response(JSON.stringify(typeof next === "function" ? next() : next), { status: 200 }));
    },
    canRead: () => true,
    canEdit: () => true,
    background: (w) => { background.push(w); },
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve(`h${t.length}`),
    log: (e) => { logs.push(e); return Promise.resolve(); },
    audit: (action, rows, note) => { audits.push({ action, rows, note }); return Promise.resolve(); },
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
    ...over,
  };
  return { deps, claudeBodies, background, logs, audits, portalCalls };
}

const said = (text: string) => ({ stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] });
const toolUse = (name: string, input: unknown, id = "t1") => ({ stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name, input }] });
const sheetRead = () => ({ stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: JSON.stringify(MAP) }] });
const fixed = (u: Partial<Usage>) => () => Promise.resolve({ ...ZERO, ...u });

// ── 1 and 2. Every cap, at and past its limit, and a count that can't be read ─────────────────────

Deno.test("each chat cap: one under its limit goes ahead; at it and past it the turn stops in its sentence, with nothing stored and Claude never asked", async () => {
  const cap = monthlyCapMicros(() => undefined);
  const cases: [Partial<Usage>, Partial<Usage>, string, string][] = [
    [{ user10m: USER_10M_CAP - 1 }, { user10m: USER_10M_CAP }, "user", SENTENCES.userCap],
    [{ tenant24h: TENANT_DAILY_CAP - 1 }, { tenant24h: TENANT_DAILY_CAP }, "tenant", SENTENCES.tenantCap],
    [{ monthCostMicros: cap - 1 }, { monthCostMicros: cap }, "month", SENTENCES.monthCap],
  ];
  for (const [under, at, code, sentence] of cases) {
    const ok = makeStore({ usage: fixed(under) });
    const a = makeDeps(ok.store, {}, [said("Hi.")]);
    const r = await handleSend(a.deps, who, { text: "hello" });
    assertEquals([r.body.ok, a.claudeBodies.length], [true, 1], JSON.stringify(under));
    for (const u of [at, Object.fromEntries(Object.entries(at).map(([k, n]) => [k, Number(n) + 5]))]) {
      const s = makeStore({ usage: fixed(u) });
      const d = makeDeps(s.store);
      const out = await handleSend(d.deps, who, { text: "hello" });
      assertEquals([out.status, out.body.ok, out.body.capped], [200, false, code], JSON.stringify(u));
      // deno-lint-ignore no-explicit-any
      assertEquals((out.body.reply as any).body, sentence);
      assertEquals([d.claudeBodies.length, s.messages.length, s.proposals.size], [0, 0, 0], JSON.stringify(u));
    }
  }
});

Deno.test("the month cap reads its ceiling from JACK_AI_MONTHLY_CAP_USD", async () => {
  const env = (k: string) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : k === "JACK_AI_MONTHLY_CAP_USD" ? "10" : undefined);
  const s = makeStore({ usage: fixed({ monthCostMicros: 10_000_000 }) });
  const d = makeDeps(s.store, { env });
  assertEquals((await handleSend(d.deps, who, { text: "hello" })).body.capped, "month");
  const under = makeStore({ usage: fixed({ monthCostMicros: 9_999_999 }) });
  const u = makeDeps(under.store, { env }, [said("Hi.")]);
  assertEquals((await handleSend(u.deps, who, { text: "hello" })).body.ok, true);
});

Deno.test("the price list cap: one under goes ahead and makes the card; at it and past it the upload stops with no card and no read", async () => {
  const ok = makeStore({ usage: fixed({ sheets24h: SHEETS_DAILY_CAP - 1 }) });
  const a = makeDeps(ok.store, {}, [sheetRead()]);
  const r = await handleSheetStart(a.deps, who, SHEET);
  await Promise.all(a.background);
  assertEquals([r.body.ok, ok.proposals.size, a.claudeBodies.length], [true, 1, 1]);
  for (const n of [SHEETS_DAILY_CAP, SHEETS_DAILY_CAP + 4]) {
    const s = makeStore({ usage: fixed({ sheets24h: n }) });
    const d = makeDeps(s.store);
    const out = await handleSheetStart(d.deps, who, SHEET);
    await Promise.all(d.background);
    assertEquals([out.body.ok, out.body.capped], [false, "sheets"], String(n));
    // deno-lint-ignore no-explicit-any
    assertEquals((out.body.reply as any).body, SENTENCES.sheetCap);
    assertEquals([s.proposals.size, s.messages.length, d.claudeBodies.length], [0, 0, 0]);
  }
  // The person, month and builder caps stop an upload too.
  for (const u of [{ user10m: USER_10M_CAP }, { tenant24h: TENANT_DAILY_CAP }, { monthCostMicros: monthlyCapMicros(() => undefined) }]) {
    const s = makeStore({ usage: fixed(u) });
    const d = makeDeps(s.store);
    assertEquals((await handleSheetStart(d.deps, who, SHEET)).body.ok, false, JSON.stringify(u));
    assertEquals(s.proposals.size, 0);
  }
});

Deno.test("a usage read that fails stops send and sheet_start in a plain sentence; it's never read as no usage", async () => {
  const failing: [string, () => Promise<Usage | null>][] = [
    ["throws", () => Promise.reject(new Error("rpc down"))],
    ["answers null", () => Promise.resolve(null)],
    ["answers no counts", () => Promise.resolve({ monthCostMicros: Number.NaN, tenant24h: 0, user10m: 0, sheets24h: 0 })],
    ["answers a missing count", () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0 } as unknown as Usage)],
  ];
  for (const [how, usage] of failing) {
    const s = makeStore({ usage });
    const d = makeDeps(s.store);
    const send = await handleSend(d.deps, who, { text: "hello" });
    assertEquals([send.status, send.body.ok, send.body.capped], [200, false, "usage"], how);
    // deno-lint-ignore no-explicit-any
    assertEquals((send.body.reply as any).body, SENTENCES.usageUnread);
    const sheet = await handleSheetStart(d.deps, who, SHEET);
    assertEquals([sheet.body.ok, sheet.body.capped], [false, "usage"], how);
    assertEquals([d.claudeBodies.length, s.messages.length, s.proposals.size], [0, 0, 0], how);
    assertEquals(await usageOf(d.deps, who), null, how);
  }
  // The sentence is short and plain, with no dash.
  assert(SENTENCES.usageUnread.length <= 140 && !/—|–/.test(SENTENCES.usageUnread));
});

Deno.test("no usage yet is a successful read of zeros, and the turn goes ahead", async () => {
  const s = makeStore({ usage: fixed({}) });
  const d = makeDeps(s.store, {}, [said("Hi Pat.")]);
  const r = await handleSend(d.deps, who, { text: "hello" });
  assertEquals([r.body.ok, d.claudeBodies.length], [true, 1]);
  const sheet = makeDeps(makeStore({ usage: fixed({}) }).store, {}, [sheetRead()]);
  assertEquals((await handleSheetStart(sheet.deps, who, SHEET)).body.ok, true);
});

Deno.test("a usage read that fails after the message went in stops the turn there: Claude isn't asked and the refusal is stored at no cost", async () => {
  let n = 0;
  const s = makeStore({ usage: () => (++n === 1 ? Promise.resolve(ZERO) : Promise.reject(new Error("rpc down"))) });
  const d = makeDeps(s.store);
  const r = await handleSend(d.deps, who, { text: "hello" });
  assertEquals([r.body.ok, r.body.capped, d.claudeBodies.length], [false, "usage", 0]);
  assertEquals(s.messages.map((m) => [m.role, m.body, m.stop_reason ?? null]), [["user", "hello", null], ["assistant", SENTENCES.usageUnread, "capped"]]);
  assertEquals(s.messages[1].charge, { state: "not_billable", micros: null });
});

// ── 1. The wallet floor, as send and sheet_start reach it ─────────────────────────────────────────

function armed(over: Partial<Wallet> = {}): Wallet {
  return { ...quietWallet(), meter: () => Promise.resolve({ active: true, markup: 1.5 }), ...over };
}

Deno.test("meter armed and the wallet unreadable: send and sheet_start stop before Claude is asked or a card is made", async () => {
  for (const w of [armed({ account: () => Promise.reject(new Error("down")) }), armed({ account: () => Promise.resolve(null) }), armed({ exempt: () => Promise.resolve(null) }), { ...quietWallet(), meter: () => Promise.resolve(null) }]) {
    forgetGrantsSeen();
    const s = makeStore();
    const d = makeDeps(s.store, { wallet: w });
    const r = await handleSend(d.deps, who, { text: "hello" });
    assertEquals([r.body.ok, r.body.capped], [false, "wallet"]);
    // deno-lint-ignore no-explicit-any
    assertEquals((r.body.reply as any).body, WALLET_SAID.unread);
    const sh = await handleSheetStart(d.deps, who, SHEET);
    assertEquals([sh.body.ok, sh.body.capped], [false, "wallet"]);
    assertEquals([d.claudeBodies.length, s.messages.length, s.proposals.size], [0, 0, 0]);
  }
});

Deno.test("meter known to be off: a wallet that can't be read changes nothing, as before", async () => {
  const w: Wallet = { ...quietWallet(), exempt: () => Promise.resolve(null), account: () => Promise.reject(new Error("down")) };
  const s = makeStore();
  const d = makeDeps(s.store, { wallet: w }, [said("Hi.")]);
  assertEquals((await handleSend(d.deps, who, { text: "hello" })).body.ok, true);
});

// ── 3. The person cap under parallel sends ────────────────────────────────────────────────────────

/** Holds the first `n` usage reads until all `n` have been made, so every parallel send passes the
 *  first check on the same count, the way they would on a real database. */
function barrier(store: Store, n: number) {
  const real = store.usage.bind(store);
  let waiting = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  store.usage = async (w) => {
    const u = await real(w);
    if (++waiting <= n) {
      if (waiting === n) open();
      await gate;
    }
    return u;
  };
}

const seed = (s: ReturnType<typeof makeStore>, n: number) => {
  for (let i = 0; i < n; i++) s.messages.push({ id: `old${i}`, role: "user", body: "earlier", created_at: "then", proposal_ids: [], user_id: who.userId });
};

Deno.test("parallel sends at the last place: no more than the cap reach Claude, and each one stopped says so in the chat", async () => {
  const s = makeStore();
  seed(s, USER_10M_CAP - 1);
  barrier(s.store, 3);
  const d = makeDeps(s.store, {}, [said("One."), said("Two."), said("Three.")]);
  const out = await Promise.all([1, 2, 3].map((i) => handleSend(d.deps, who, { text: `message ${i}` })));
  const ran = out.filter((r) => r.body.ok === true).length;
  const stopped = out.filter((r) => r.body.capped === "user");
  // One place was left. Before the fix all three passed the check and all three asked Claude.
  assert(ran <= 1, `${ran} turns ran past the cap`);
  assertEquals(ran + stopped.length, 3);
  assertEquals(d.claudeBodies.length, ran);
  for (const r of stopped) {
    // deno-lint-ignore no-explicit-any
    assertEquals((r.body.reply as any).body, SENTENCES.userCap);
    const [mine, answer] = r.body.messages as StoredMessage[];
    assertEquals([mine.role, answer.role, answer.body], ["user", "assistant", SENTENCES.userCap]);
  }
});

Deno.test("a burst of parallel sends from nothing: never more than the cap reach Claude", async () => {
  const burst = USER_10M_CAP + 6;
  const s = makeStore();
  barrier(s.store, burst);
  const d = makeDeps(s.store, {}, Array.from({ length: burst }, () => said("Hi.")));
  const out = await Promise.all(Array.from({ length: burst }, (_, i) => handleSend(d.deps, who, { text: `m${i}` })));
  const ran = out.filter((r) => r.body.ok === true).length;
  assert(ran <= USER_10M_CAP, `${ran} turns ran`);
  assertEquals(d.claudeBodies.length, ran);
});

Deno.test("one at a time, the cap lets exactly its number through and stops the next before anything is stored", async () => {
  const s = makeStore();
  const d = makeDeps(s.store, {}, Array.from({ length: USER_10M_CAP }, () => said("Hi.")));
  for (let i = 0; i < USER_10M_CAP; i++) assertEquals((await handleSend(d.deps, who, { text: `m${i}` })).body.ok, true, String(i));
  const stored = s.messages.length;
  const next = await handleSend(d.deps, who, { text: "one more" });
  assertEquals([next.body.ok, next.body.capped, s.messages.length], [false, "user", stored]);
  assertEquals(d.claudeBodies.length, USER_10M_CAP);
});

Deno.test("the builder's daily cap is counted again after the message too", async () => {
  const s = makeStore();
  // Other people at this builder: they count toward the builder's day, not this person's ten minutes.
  for (let i = 0; i < TENANT_DAILY_CAP - 1; i++) s.messages.push({ id: `t${i}`, role: "user", body: "x", created_at: "then", proposal_ids: [], user_id: "someone-else" });
  barrier(s.store, 2);
  const d = makeDeps(s.store, {}, [said("A."), said("B.")]);
  const out = await Promise.all([handleSend(d.deps, who, { text: "a" }), handleSend(d.deps, who, { text: "b" })]);
  assert(out.filter((r) => r.body.ok === true).length <= 1);
  assert(out.some((r) => r.body.capped === "tenant"));
});

// ── 4. The activity page: per-area, and the team's views are logged ──────────────────────────────

async function cards(store: Store) {
  const at = { client_id: who.clientId, status: "applied", shown_hash: "h" };
  const sizes = await store.insertProposal({ ...at, user_id: "u1", kind: "size_rule", title: "Raise sizes", preview: { counts: { edits: 3 } } } as never);
  const sheet = await store.insertProposal({ ...at, user_id: "u1", kind: "price_sheet", title: "Price list", preview: { counts: { edits: 9 } } } as never);
  const door = await store.insertProposal({ ...at, user_id: "u1", kind: "new_fixture", title: "Add a door: 36 walk door", preview: { fixture: { name: "36 walk door" } } } as never);
  const reply = await store.insertProposal({ ...at, user_id: "u2", kind: "reply_send", title: "A reply by text", preview: { body: "Hi there" }, payload: { channel: "sms" } } as never);
  const orders = await store.insertProposal({ ...at, user_id: "u1", kind: "lookup", title: "Sold, not scheduled", preview: {}, payload: { area: "orders" } } as never);
  const people = await store.insertProposal({ ...at, user_id: "u1", kind: "lookup", title: "Waiting on you", preview: {}, payload: { area: "contacts" } } as never);
  const company = await store.insertProposal({ ...at, user_id: "u1", kind: "setup_company", title: "Company details", preview: {}, payload: { calls: { save: { businessName: "Example Sheds" } } } } as never);
  const mystery = await store.insertProposal({ ...at, user_id: "u1", kind: "something_new", title: "A card this build doesn't know" } as never);
  return { sizes, sheet, door, reply, orders, people, company, mystery };
}

/** The activity read as index.ts makes it: three parts of the preview, the payload parts a card's areas
 *  need, and no undo. */
const asIndexReads = (rows: ProposalRow[]) => rows.map((r) => ({
  ...r,
  preview: { counts: r.preview?.counts ?? null, fixture: r.preview?.fixture ?? null, skipped: r.preview?.skipped ?? null },
  payload: { area: r.payload?.area ?? null, also: r.payload?.also ?? null, cleared: r.payload?.cleared ?? null, calls: { save: r.payload?.calls?.save ?? null } },
  undo: null,
} as ProposalRow));

Deno.test("the activity page lists only the cards whose areas this person may read, and never a kind this build doesn't know", async () => {
  for (const partial of [false, true]) {
    const s = makeStore();
    const c = await cards(s.store);
    if (partial) {
      const all = [...s.proposals.values()];
      s.store.proposals = () => Promise.resolve(asIndexReads(all));
    }
    // Contacts and the Options screen, but not the sizes table, orders or the CRM settings.
    const reads = new Set(["jack", "contacts", "settings_options", "settings_branding"]);
    const d = makeDeps(s.store, { canRead: (a) => reads.has(a) });
    const r = await handleActivity(d.deps, who);
    // deno-lint-ignore no-explicit-any
    const ids = (r.body.activity as any[]).map((v) => v.id).sort();
    assertEquals(ids, [c.door.id, c.reply.id, c.people.id].sort(), partial ? "as index.ts reads it" : "whole rows");
    // A teammate's private card still shows only that it was asked.
    // deno-lint-ignore no-explicit-any
    const reply = (r.body.activity as any[]).find((v) => v.id === c.reply.id);
    assertEquals([reply.private, reply.hash, JSON.stringify(reply).includes("Hi there")], [true, null, false]);
    assertEquals(d.audits.filter((a) => a.action === "jack_activity_view").length, 0, "a builder's own person isn't audited for reading");
  }
  // With every area, every known card is there; the unknown one still isn't.
  const s = makeStore();
  const c = await cards(s.store);
  const d = makeDeps(s.store);
  // deno-lint-ignore no-explicit-any
  const ids = ((await handleActivity(d.deps, who)).body.activity as any[]).map((v) => v.id);
  assertEquals(ids.length, 7);
  assert(!ids.includes(c.mystery.id));
});

Deno.test("the Structure Studio team opening the activity page is written to the audit log, with counts only", async () => {
  const s = makeStore();
  await cards(s.store);
  const d = makeDeps(s.store, { canRead: (a) => a !== "orders" });
  const r = await handleActivity(d.deps, operator);
  // deno-lint-ignore no-explicit-any
  const shown = (r.body.activity as any[]).length;
  const views = d.audits.filter((a) => a.action === "jack_activity_view");
  assertEquals(views, [{ action: "jack_activity_view", rows: shown, note: `shown=${shown} left_out=${8 - shown}` }]);
  // An audit write that fails never stops the page.
  const failing = makeDeps(s.store, { audit: () => Promise.reject(new Error("down")) });
  assertEquals((await handleActivity(failing.deps, operator)).status, 200);
});

// ── 5. A new door: sane limits, and not twice ──────────────────────────────────────────────────────

const turn = (): TurnState => ({ who, chatId: "chat1", off: [], proposalIds: [] });
const door = (over: Record<string, unknown> = {}) => ({ name: "Barn door", widthInches: 96, heightInches: 84, price: 650, ...over });

Deno.test("a new door with a size or price no door could have is refused in a sentence, and makes no card", async () => {
  for (const bad of [{ widthInches: 2000 }, { widthInches: 5000 }, { heightInches: 2000 }, { heightInches: 1e9 }, { price: 1_000_000 }, { price: 25_000_000 }, { widthInches: Number.POSITIVE_INFINITY }]) {
    const s = makeStore();
    const d = makeDeps(s.store);
    const out = await runTool(d.deps, turn(), "propose_new_door", door(bad));
    assertEquals(out.isError, true, JSON.stringify(bad));
    assert(/looks off for a door/.test(out.content) && /2,000 inches/.test(out.content) && !/—|–/.test(out.content), out.content);
    assertEquals(s.proposals.size, 0);
  }
  // Just under the limits is a card.
  const s = makeStore();
  const d = makeDeps(s.store);
  const ok = await runTool(d.deps, turn(), "propose_new_door", door({ widthInches: 1999, heightInches: 1999, price: 999_999.99 }));
  assertEquals([ok.isError ?? false, s.proposals.size], [false, 1]);
  // What was missing still says what a door needs.
  const none = await runTool(d.deps, turn(), "propose_new_door", door({ widthInches: "wide" }));
  assertEquals(none.content, "A door needs a name, a width, a height and a price.");
});

Deno.test("a door they already have is refused; the same name in another size, or an archived twin, is a new door", async () => {
  const s = makeStore();
  const d = makeDeps(s.store);
  const twin = await runTool(d.deps, turn(), "propose_new_door", door({ name: "  single DOOR ", widthInches: 36, heightInches: 80, price: 200 }));
  assertEquals([twin.isError, twin.content], [true, "You already have that door: single DOOR, 36 by 80 inches."]);
  assertEquals(s.proposals.size, 0);
  const other = await runTool(d.deps, turn(), "propose_new_door", door({ name: "Single door", widthInches: 42, heightInches: 80 }));
  assertEquals([other.isError ?? false, s.proposals.size], [false, 1]);
  // An archived door of that name and size doesn't count, and a door with no category is a door.
  const portal: Deps["portal"] = (a) => Promise.resolve(a === "catalog"
    ? { status: 200, data: { fixtures: [{ ...SINGLE, archived: true }, { id: "w1", name: "Barn door", category: "window", width_in: 96, height_in: 84 }] } }
    : { status: 200, data: {} });
  const a = makeStore();
  const ad = makeDeps(a.store, { portal });
  assertEquals((await runTool(ad.deps, turn(), "propose_new_door", door({ name: "Single door", widthInches: 36, heightInches: 80 }))).isError ?? false, false);
  assertEquals((await runTool(ad.deps, turn(), "propose_new_door", door())).isError ?? false, false, "a window of that name isn't a door");
  const bare: Deps["portal"] = (x) => Promise.resolve(x === "catalog" ? { status: 200, data: { fixtures: [{ id: "d9", name: "Barn door", width_in: 96, height_in: 84 }] } } : { status: 200, data: {} });
  const b = makeStore();
  assertEquals((await runTool(makeDeps(b.store, { portal: bare }).deps, turn(), "propose_new_door", door())).isError, true);
});

Deno.test("a new door whose duplicate check can't run makes no card", async () => {
  for (const [status, data, says] of [[500, null, "couldn't check your doors"], [0, null, "couldn't check your doors"], [200, { items: [] }, "couldn't check your doors"], [403, null, SENTENCES.noAccess]] as const) {
    const s = makeStore();
    const d = makeDeps(s.store, { portal: () => Promise.resolve({ status, data: data as Record<string, unknown> | null }) });
    const out = await runTool(d.deps, turn(), "propose_new_door", door());
    assertEquals(out.isError, true);
    assert(out.content.includes(says), out.content);
    assertEquals(s.proposals.size, 0, String(status));
  }
});

// ── 6. One turn's limits ───────────────────────────────────────────────────────────────────────────

const look = (i: number) => toolUse("look_at_my_catalog", {}, `t${i}`);

Deno.test(`after ${MAX_TOOL_ROUNDS} rounds of tools the last round offers none, and its words are the answer`, async () => {
  const s = makeStore();
  const d = makeDeps(s.store, {}, [...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => look(i)), said("You have one style, Garden Shed.")]);
  const t = await runTurn(d.deps, turn(), "key", "claude-sonnet-5-5", "person", [], "what do I sell?");
  assertEquals(d.claudeBodies.length, MAX_TOOL_ROUNDS + 1);
  // deno-lint-ignore no-explicit-any
  assertEquals(d.claudeBodies.map((b: any) => b.tool_choice.type), [...Array(MAX_TOOL_ROUNDS).fill("auto"), "none"]);
  assertEquals([t.text, t.stopReason, t.tools.length], ["You have one style, Garden Shed.", "end_turn", MAX_TOOL_ROUNDS]);
});

Deno.test("a tool asked for on the last round is never run, and Claude is never asked again: the turn ends with no answer", async () => {
  const s = makeStore();
  const d = makeDeps(s.store, {}, Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) => look(i)));
  const reads = () => d.portalCalls.filter((a) => a === "size_table").length;
  const t = await runTurn(d.deps, turn(), "key", "claude-sonnet-5-5", "person", [], "what do I sell?");
  assertEquals(d.claudeBodies.length, MAX_TOOL_ROUNDS + 1);
  assertEquals([t.text, t.stopReason, t.tools.length, reads()], [SENTENCES.noText, "no_text", MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS]);
});

Deno.test("the 120 s turn budget: once it's spent no further call is made, and the turn says it took too long", async () => {
  let now = Date.parse("2026-11-09T15:00:00Z");
  const start = now;
  const s = makeStore();
  // Each answer takes 50 s of the turn's clock: at 0, 50 and 100 s a call still fits; at 150 s none does.
  const slow = (i: number) => () => { now += 50_000; return look(i); };
  const d = makeDeps(s.store, { now: () => now }, [slow(0), slow(1), slow(2), slow(3), slow(4), slow(5)]);
  const logs: string[] = [];
  d.deps.log = (e) => { logs.push(e.code); return Promise.resolve(); };
  const t = await runTurn(d.deps, turn(), "key", "claude-sonnet-5-5", "person", [], "what do I sell?");
  assertEquals(d.claudeBodies.length, 3);
  assertEquals([t.text, t.stopReason], [SENTENCES.timeout, "timeout"]);
  assert(now - start > TURN_TIMEOUT_MS);
  assertEquals(logs, ["jack_timeout"]);
});

/** An armed meter with money in the wallet, counting what it's asked to charge. */
function charging() {
  const debits: unknown[] = [];
  return { debits, wallet: armed({ debit: (a) => { debits.push(a); return Promise.resolve({ ok: true, txId: 1 }); } }) };
}

Deno.test("Claude declining says the refusal sentence, is logged by category, and isn't billed", async () => {
  forgetGrantsSeen();
  const s = makeStore();
  const w = charging();
  const refusal = { stop_reason: "refusal", stop_details: { category: "cyber" }, model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 0 }, content: [{ type: "text", text: "partial words" }] };
  const d = makeDeps(s.store, { wallet: w.wallet }, [refusal]);
  const r = await handleSend(d.deps, who, { text: "something it won't do" });
  assertEquals([(r.body.messages as StoredMessage[])[1].body, r.body.billed, w.debits.length], [SENTENCES.refusal, false, 0]);
  assertEquals(s.messages.at(-1)?.stop_reason, "refusal");
  assert(d.logs.some((l) => l.code === "jack_refusal" && l.context?.category === "cyber"));
  // The same armed wallet does charge a turn that answered, so the 0 above is the refusal's.
  const ok = makeDeps(makeStore().store, { wallet: w.wallet }, [said("Hi.")]);
  assertEquals((await handleSend(ok.deps, who, { text: "hello" })).body.billed, true);
});

Deno.test("an answer cut off at max_tokens says so, keeps none of the cut words, and isn't billed", async () => {
  forgetGrantsSeen();
  const s = makeStore();
  const w = charging();
  const cut = { stop_reason: "max_tokens", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 8000 }, content: [{ type: "text", text: "Here is a very long" }] };
  const d = makeDeps(s.store, { wallet: w.wallet }, [cut]);
  const r = await handleSend(d.deps, who, { text: "tell me everything" });
  assertEquals([(r.body.messages as StoredMessage[])[1].body, r.body.billed, w.debits.length], [SENTENCES.cutOff, false, 0]);
  assertEquals(s.messages.at(-1)?.stop_reason, "max_tokens");
  assert(!s.messages.some((m) => m.body.includes("very long")));
});

Deno.test("a call that fails says the plain sentence; only a status a retry can't fix is logged as an error", async () => {
  const cases: [string, Deps["fetch"], string][] = [
    ["400", () => Promise.resolve(new Response("{}", { status: 400 })), "error"],
    ["401", () => Promise.resolve(new Response("{}", { status: 401 })), "error"],
    ["408", () => Promise.resolve(new Response("{}", { status: 408 })), "warn"],
    ["unreachable", () => Promise.reject(new TypeError("network down")), "warn"],
  ];
  for (const [what, fetch, severity] of cases) {
    const s = makeStore();
    const d = makeDeps(s.store, { fetch });
    const t = await runTurn(d.deps, turn(), "key", "claude-sonnet-5-5", "person", [], "hello");
    assertEquals([t.text, t.stopReason], [SENTENCES.failed, "error"], what);
    assertEquals(d.logs.map((l) => [l.code, l.severity]), [["jack_failed", severity]], what);
  }
});

// ── 6. The last net: a customer-words tool whose answer still holds a contact detail ──────────────

const LEAKY = "look_test_leaky_words";
const leaky: ToolSpec = {
  def: { name: LEAKY, description: "test only", input_schema: { type: "object", additionalProperties: false, required: [], properties: {} } },
  customerWords: true,
  run: () => Promise.resolve({ content: JSON.stringify({ words: "Call me at (816) 555-0142 or write to someone@example.com, thanks" }) }),
};

Deno.test("the last net: a customer-words answer that still holds a phone or an email is scrubbed before Claude sees it, and logged by code", async () => {
  PIECE_TOOLS.set(LEAKY, leaky);
  try {
    const s = makeStore();
    const d = makeDeps(s.store, {}, [toolUse(LEAKY, {}), said("They asked for a call.")]);
    const state = turn();
    const direct = await runTool(d.deps, state, LEAKY, {});
    assert(!direct.content.includes("555-0142") && !direct.content.includes("someone@example.com"), direct.content);
    assert(direct.content.includes("[phone]") && direct.content.includes("[email]") && direct.content.includes("thanks"), direct.content);
    assertEquals(state.customerWordsRead, true);
    const net = d.logs.filter((l) => l.code === "jack_redact_net");
    assertEquals(net.map((l) => [l.severity, l.context?.tool]), [["warn", LEAKY]]);
    assert(!JSON.stringify(net).includes("555"), "the log holds no contact detail");

    // In a turn, what goes back to Claude is the scrubbed answer.
    const t = await runTurn(d.deps, turn(), "key", "claude-sonnet-5-5", "person", [], "what did they say?");
    assertEquals(t.text, "They asked for a call.");
    const sent = JSON.stringify(d.claudeBodies[1].messages);
    assert(!sent.includes("555-0142") && !sent.includes("someone@example.com") && sent.includes("[phone]"), sent);
  } finally {
    PIECE_TOOLS.delete(LEAKY);
  }
});

Deno.test("a customer-words answer with nothing to scrub goes through as it is, unlogged", async () => {
  const clean: ToolSpec = { ...leaky, run: () => Promise.resolve({ content: JSON.stringify({ words: "Can it be green? $4,350 is fine." }) }) };
  PIECE_TOOLS.set(LEAKY, clean);
  try {
    const s = makeStore();
    const d = makeDeps(s.store);
    const out = await runTool(d.deps, turn(), LEAKY, {});
    assertEquals(out.content, JSON.stringify({ words: "Can it be green? $4,350 is fine." }));
    assertEquals(d.logs.length, 0);
  } finally {
    PIECE_TOOLS.delete(LEAKY);
  }
});

// ── The sheets cap under parallel uploads (11-09, A1's open item) ────────────────────────────────────

/** Price lists this builder already sent today, as jack_usage counts them. */
const seedSheets = (s: ReturnType<typeof makeStore>, n: number) => {
  for (let i = 0; i < n; i++) {
    const id = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
    s.proposals.set(id, { id, client_id: who.clientId, user_id: who.userId, kind: "price_sheet", status: "applied", title: "Price list: earlier.csv" } as ProposalRow);
  }
};
/** The cards these uploads made: the ones not seeded. */
const madeNow = (s: ReturnType<typeof makeStore>) => [...s.proposals.values()].filter((p) => !p.id.startsWith("00000000-0000-4000-9000-"));

Deno.test("parallel price lists at the last place: no more than the cap are read, and each one stopped fails its card in the cap's sentence", async () => {
  const s = makeStore();
  seedSheets(s, SHEETS_DAILY_CAP - 1);
  // Every upload passes the first check on the same count, as on a real database.
  barrier(s.store, 3);
  const d = makeDeps(s.store, {}, [sheetRead(), sheetRead(), sheetRead()]);
  const out = await Promise.all([1, 2, 3].map((i) => handleSheetStart(d.deps, who, { ...SHEET, fileName: `prices-${i}.csv` })));
  await Promise.all(d.background);
  const ran = out.filter((r) => r.body.ok === true);
  const stopped = out.filter((r) => r.body.capped === "sheets");
  // One place was left. Before the recount all three passed and all three were read and paid for.
  assert(ran.length <= 1, `${ran.length} price lists read past the cap`);
  assertEquals(ran.length + stopped.length, 3);
  assertEquals(d.claudeBodies.length, ran.length);
  const cards = madeNow(s);
  assertEquals(cards.length, 3);
  const failedCards = cards.filter((p) => p.status === "failed");
  assertEquals(failedCards.length, stopped.length);
  for (const p of failedCards) {
    // A failed card with no rows read: no Try again, nothing to approve.
    assertEquals([p.failure, p.source?.rows ?? null, p.shown_hash], [SENTENCES.sheetCap, null, null]);
  }
  for (const r of stopped) {
    // deno-lint-ignore no-explicit-any
    assertEquals((r.body.reply as any).body, SENTENCES.sheetCap);
    const [mine, answer] = r.body.messages as (StoredMessage & { stop_reason?: string | null; charge?: unknown })[];
    assertEquals([mine.role, mine.body, answer.role, answer.body], ["user", "Uploaded a price list", "assistant", SENTENCES.sheetCap]);
  }
  // The refusals are stored as Jack's answers, unbilled and marked capped, so the lock logic passes over them.
  const caps = s.messages.filter((m) => m.role === "assistant" && m.body === SENTENCES.sheetCap);
  assertEquals(caps.length, stopped.length);
  for (const m of caps) assertEquals([m.stop_reason, m.charge], ["capped", { state: "not_billable", micros: null }]);
});

Deno.test("a burst of parallel price lists: never more than the cap are read in a day", async () => {
  const s = makeStore();
  seedSheets(s, SHEETS_DAILY_CAP - 2);
  barrier(s.store, 6);
  const d = makeDeps(s.store, {}, Array.from({ length: 6 }, () => sheetRead()));
  const out = await Promise.all(Array.from({ length: 6 }, (_, i) => handleSheetStart(d.deps, who, { ...SHEET, fileName: `p${i}.csv` })));
  await Promise.all(d.background);
  const ran = out.filter((r) => r.body.ok === true).length;
  assert(ran <= 2, `${ran} read`);
  assertEquals(d.claudeBodies.length, ran);
  assertEquals(madeNow(s).filter((p) => p.status !== "failed").length, ran);
});

Deno.test("price lists one at a time: exactly the cap are read, and the next stops at the first check with no card", async () => {
  const s = makeStore();
  seedSheets(s, SHEETS_DAILY_CAP - 2);
  const d = makeDeps(s.store, {}, [sheetRead(), sheetRead()]);
  for (const i of [1, 2]) {
    const r = await handleSheetStart(d.deps, who, { ...SHEET, fileName: `p${i}.csv` });
    await Promise.all(d.background);
    assertEquals(r.body.ok, true, String(i));
  }
  const next = await handleSheetStart(d.deps, who, SHEET);
  assertEquals([next.body.ok, next.body.capped, madeNow(s).length, d.claudeBodies.length], [false, "sheets", 2, 2]);
});

Deno.test("a usage read that fails on the recount fails the price list's card, unread and unpaid", async () => {
  let n = 0;
  const s = makeStore();
  s.store.usage = () => (++n === 1 ? Promise.resolve(ZERO) : Promise.reject(new Error("rpc down")));
  const d = makeDeps(s.store, {}, [sheetRead()]);
  const r = await handleSheetStart(d.deps, who, SHEET);
  await Promise.all(d.background);
  // deno-lint-ignore no-explicit-any
  assertEquals([r.body.ok, r.body.capped, (r.body.reply as any).body, d.claudeBodies.length], [false, "usage", SENTENCES.usageUnread, 0]);
  const [p] = madeNow(s);
  assertEquals([p.status, p.failure], ["failed", SENTENCES.usageUnread]);
});
