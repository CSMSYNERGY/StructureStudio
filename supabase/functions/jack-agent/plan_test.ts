import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, handleProposalApprove, handleProposalCancel, handleProposalUndo, handleSend, handleSheetStart, handleStatus, type ProposalRow, reportHiddenTools,
  runTool, type Store, type StoredMessage, STRICT_LIMITS, strictCost, systemText, TOOL_DEFS, toolsFor, type TurnState, type Who, withinStrictLimits,
} from "./agent.ts";
import type { ToolDef } from "./types.ts";
import { PIECE_KINDS, PIECE_TOOLS } from "./pieces.ts";
import { blockedBy, JACK_TABS, KIND_MODULE, lacks, missingAreas, PLAN_FN, planLine, planOf, planSoon, reportRow, type ServerAccess, SHEET_START_KEY, SHEET_START_TABS, tabsOfKind, tabsOfTool, TOOL_MODULE, wouldBlock } from "./plan.ts";
import { addOnOn } from "./buildschedule.ts";
import { GATES } from "./handler.ts";
import { firstReport, MODULE_REFUSAL } from "../_shared/accessEnforce.ts";
import { modulesForAction } from "../_shared/accessActions.ts";
import { ACCESS_MODULE_KEYS, ACCESS_MODULES, isAccessModule } from "../_shared/accessModules.ts";

// JACK OBEYS THE COMPANY'S TAB MAP (plan.ts; plans as data, stage D).
//
// Before this, every company was sent every tool: one whose plan has no Orders page was still told
// Jack could look up who owes them, and a card made while a company had a tab could be approved after
// it was taken away. The map now decides which tools Claude is sent and which presses may run. Getting
// it wrong takes Jack's tools away from every builder at once, so this file holds the whole contract:
//
//   1. THE TABLES ARE COMPLETE. Every tool and every card kind has a decision, and none is stale, so a
//      tool added without deciding its tab fails the push. Every tab named is a catalogue tab.
//   2. NO PLAN (not named, or the map couldn't be read): the tool list, the system blocks and every
//      press are exactly what they were. Nothing is filed.
//   3. REPORT: the same list and the same answers, plus one info row per tool or press that block mode
//      would have stopped, once per isolate.
//   4. BLOCK: exactly the tools of the missing tabs are gone, the three price and door tools included;
//      one called anyway is refused; "locked" is not "on"; one short line tells Jack which areas the
//      plan leaves out, after the cached block, which stays byte for byte the shared one.
//   5. A PRESS: Approve and a price list are 403 module_off in block mode before anything is saved,
//      and go ahead in report mode. Undo and cancel are never refused BY JACK and never even ask.
//      ⚠️ Not the same as "Undo always works": the put-back is a save behind another function's door,
//      and that door still refuses it when its tab is gone. Pinned below as it is today, so nobody
//      reads a green test as a working Undo.
//
// Companies here are made up (public repo). Each report-mode test has its own, because "filed once
// per isolate" is remembered for the whole test process.

// ── Plans ─────────────────────────────────────────────────────────────────────────────────────────

/** A map with every catalogue tab on, except the ones named, which get `state`. */
const mapWithout = (missing: string[], state = "hidden"): Record<string, string> =>
  ({ ...Object.fromEntries(ACCESS_MODULE_KEYS.map((k) => [k, "on"])), ...Object.fromEntries(missing.map((k) => [k, state])) });
const block = (missing: string[], state = "hidden"): ServerAccess => ({ mode: "block", modules: mapWithout(missing, state) });
const report = (missing: string[], state = "hidden"): ServerAccess => ({ mode: "report", modules: mapWithout(missing, state) });
/** A company whose plan is the phone and nothing else Jack has a tool for. */
const NOTHING = [...new Set(Object.values(TOOL_MODULE).flat())];

// ── A store, a portal and a Claude, all fakes ─────────────────────────────────────────────────────

const V = "2026-11-01T00:00:00.000000+00:00";
const TABLE = {
  styles: [{ id: "garden", label: "Garden Shed" }],
  sizes: [{ id: "s1", style_id: "garden", label: "10x12", width_ft: 10, length_ft: 12, base_price: 4000, active: true, updated_at: V }],
  inclusions: [],
  counts: { sizes: 1, inclusions: 0 },
};
const CATALOG = { items: [], fixtures: [] };

function makeStore() {
  const proposals = new Map<string, ProposalRow>();
  const messages: StoredMessage[] = [];
  let seq = 0;
  const store: Store = {
    settings: () => Promise.resolve({ on: true, off: [] }),
    setOff: () => Promise.resolve(),
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => {
      const r: StoredMessage = { id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] };
      messages.push(r);
      return Promise.resolve(r);
    },
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Pat", title: "Owner", business: "Acme Sheds", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString(), ...p } as ProposalRow;
      proposals.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c, id) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when, at) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
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

type Log = { code: string; severity?: string; clientId?: string | null; message: string; context?: Record<string, unknown> };

/** Deps for an owner who may read and edit everything. `plan`: undefined leaves Deps.plan out (as every
 *  other test's Deps does); anything else is what the company's map read answers. */
function world(o: { plan?: ServerAccess | null | "throws"; claude?: unknown[]; over?: Partial<Deps> } = {}) {
  const s = makeStore();
  const calls: { fn: string; action: string }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const logs: Log[] = [];
  const money: string[] = [];
  const background: Promise<unknown>[] = [];
  let planReads = 0;
  const claude = [...(o.claude ?? [])];
  // A plain function, not a method: agent.ts hands deps.portal on by itself (applyPayload).
  const call: Deps["call"] = (fn, action, body) => {
      calls.push({ fn, action });
      if (fn === "portal-billing" && action === "status") return Promise.resolve({ status: 200, data: { entitlement: { features: { schedule_builds: false } } } });
      if (fn !== "portal-settings") return Promise.resolve({ status: 404, data: null });
      if (action === "size_table") return Promise.resolve({ status: 200, data: TABLE as unknown as Record<string, unknown> });
      if (action === "catalog") return Promise.resolve({ status: 200, data: CATALOG as unknown as Record<string, unknown> });
      if (action === "save_fixture") return Promise.resolve({ status: 200, data: { ok: true, id: "fx1" } });
      if (action === "delete_fixture") return Promise.resolve({ status: 200, data: { ok: true } });
      if (action === "save_pricing_cells") {
        // deno-lint-ignore no-explicit-any
        const b = body as any;
        return Promise.resolve({ status: 200, data: {
          results: (b.sizes ?? []).map((z: { id: string }) => ({ id: z.id, status: "saved", version: "v2", row: { active: true } })),
          created: [], removed: [],
        } });
      }
      return Promise.resolve({ status: 404, data: null });
  };
  const deps: Deps = {
    env: (k) => (k === "JACK_ANTHROPIC_API_KEY" ? "key" : undefined),
    store: s.store,
    portal: (action, body) => call("portal-settings", action, body),
    call,
    wallet: {
      meter: () => { money.push("meter"); return Promise.resolve({ active: false, markup: 1.5 }); },
      exempt: () => { money.push("exempt"); return Promise.resolve(false); },
      account: () => { money.push("account"); return Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }); },
      debit: () => { money.push("debit"); return Promise.resolve({ ok: true, txId: 1 }); },
      grantOnce: () => { money.push("grantOnce"); return Promise.resolve(true); },
      requestTopup: () => { money.push("requestTopup"); },
      mark: () => Promise.resolve(),
      pending: () => { money.push("pending"); return Promise.resolve([]); },
    },
    fetch: (_u, init) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = claude.shift();
      if (!next) throw new Error("Claude was asked more times than this test expected");
      return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
    },
    canRead: () => true,
    canEdit: () => true,
    background: (w) => { background.push(w.catch(() => undefined)); },
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve(`h${t.length}`),
    log: (e) => { logs.push(e as Log); return Promise.resolve(); },
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
    ...(o.plan === undefined ? {} : {
      plan: () => {
        planReads++;
        if (o.plan === "throws") return Promise.reject(new Error("the map read threw"));
        return Promise.resolve(o.plan as ServerAccess | null);
      },
    }),
    ...(o.over ?? {}),
  };
  const reports = () => logs.filter((l) => l.code === "module_would_refuse");
  return { deps, ...s, calls, bodies, logs, reports, money, background, planReads: () => planReads };
}

const whoAt = (clientId: string): Who => ({ clientId, userId: "u1", operatorEmail: null });
const turn = (clientId: string, plan?: ServerAccess | null): TurnState =>
  ({ who: whoAt(clientId), chatId: "chat1", off: [], proposalIds: [], ...(plan === undefined ? {} : { plan }) });
const names = (defs: { name: string }[]) => defs.map((d) => d.name);
const said = (text: string) => ({ stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] });
const toolUse = (name: string, input: unknown) => ({ stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "t1", name, input }] });
const raise5 = { title: "Raise 5%", rules: [{ styles: [], widths: [], minWidth: null, maxWidth: null, minLength: null, maxLength: null, setPrice: null, raisePercent: 5, raiseDollars: null, setOptions: [] }] };
const NOT_AVAILABLE = "That isn't available here right now.";

const ALL_TOOLS = [...names(TOOL_DEFS), ...PIECE_TOOLS.keys()];
const ALL_KINDS = ["price_sheet", "size_rule", "new_fixture", ...PIECE_KINDS.keys()];
/** What an owner with every area and every switch was sent before plans existed: every tool, in the
 *  pieces' order, through the strict limits. Worked out here without offered() or the plan. */
const TODAY: ToolDef[] = withinStrictLimits([...(TOOL_DEFS as ToolDef[]), ...[...PIECE_TOOLS.values()].map((t) => t.def)]);

// ── 1. The tables are complete ────────────────────────────────────────────────────────────────────

Deno.test("every tool Claude can be sent has a tab decision, and no decision is for a tool that is gone", () => {
  assert(ALL_TOOLS.length >= 43, `only ${ALL_TOOLS.length} tools found`);
  assertEquals(Object.keys(TOOL_MODULE).sort(), [...ALL_TOOLS].sort(), "plan.ts TOOL_MODULE and the tools differ: a new tool needs its tab decided there ([] = every account)");
});

Deno.test("every kind of card has a tab decision, and no decision is for a kind that is gone", () => {
  assertEquals(Object.keys(KIND_MODULE).sort(), [...ALL_KINDS].sort(), "plan.ts KIND_MODULE and the card kinds differ: a new kind needs its tab decided there ([] = never refused by a plan)");
});

Deno.test("every tab the two tables name is a tab in the catalogue", () => {
  for (const [name, tabs] of [...Object.entries(TOOL_MODULE), ...Object.entries(KIND_MODULE), ["sheet_start", SHEET_START_TABS] as const]) {
    assert(Array.isArray(tabs), `${name}: not a list`);
    for (const t of tabs) assert(isAccessModule(t), `${name} names "${t}", which is not a catalogue tab`);
    assertEquals(new Set(tabs).size, tabs.length, `${name} names a tab twice`);
  }
  // A name neither table knows carries no tab: it is not a plan's to refuse.
  assertEquals([tabsOfTool("no_such_tool"), tabsOfKind("no_such_kind"), tabsOfTool("constructor"), tabsOfKind("toString")], [[], [], [], []]);
});

/** A table as tab -> sorted names, so a changed decision shows as one moved name. */
const byTab = (table: Readonly<Record<string, readonly string[]>>) => {
  const out: Record<string, string[]> = {};
  for (const [name, tabs] of Object.entries(table)) (out[tabs.join("+") || "(every account)"] ??= []).push(name);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
};

Deno.test("the decisions, tool by tool: changing one is changing what a company's plan takes away", () => {
  assertEquals(byTab(TOOL_MODULE), {
    // propose_commission_rate: the rate is the Team screen's (portal-commissions set_rate and list carry
    // no tab), so Jack must not be stricter than the screen a person sets it on by hand.
    "(every account)": ["ask_to_be_sure", "look_at_billing", "look_at_my_setup", "point_to_step", "propose_commission_rate", "propose_company_details", "propose_locations", "propose_paperwork", "propose_setup_tick"],
    designer: ["look_at_my_catalog", "look_at_my_insulation", "look_at_my_option_prices", "propose_catalog_item", "propose_insulation_prices", "propose_new_door", "propose_option_prices", "propose_size_changes", "propose_styles"],
    automations: ["look_at_my_rules", "look_at_rule_runs", "propose_rule", "propose_rule_pause"],
    contacts: ["find_not_bought", "find_quiet_customers", "look_at_customer_for_reply", "look_up_customer", "propose_estimate_resend", "propose_reply_draft"],
    conversations: ["find_conversations", "what_came_in"],
    orders: ["find_built_not_delivered", "find_sold_not_scheduled", "find_who_owes", "look_at_order_for_change", "propose_change_order"],
    inventory: ["find_lot_inventory", "look_at_inventory", "propose_inventory_change"],
    build_schedule: ["look_at_build_schedule", "propose_build_schedule"],
    delivery_schedule: ["find_to_be_loaded", "look_at_delivery_loads", "propose_delivery_change"],
  });
});

Deno.test("the decisions, card by card: a card follows its tool, and setup, memory and look-up cards are never refused", () => {
  assertEquals(byTab(KIND_MODULE), {
    "(every account)": ["commission_rate", "lookup", "memory", "setup_company", "setup_guide", "setup_locations", "setup_paperwork", "setup_tick"],
    designer: ["insulation_price", "new_fixture", "option_price", "price_sheet", "setup_fixture", "setup_styles", "size_rule"],
    automations: ["automation_pause", "automation_rule"],
    contacts: ["estimate_resend", "reply_draft", "reply_send"],
    orders: ["changeorder_attrs", "changeorder_unlock"],
    inventory: ["inventory_listing", "inventory_photos", "inventory_price"],
    build_schedule: ["build_job_add", "build_job_built", "build_job_change"],
    delivery_schedule: ["delivery_load_create", "delivery_load_delivered", "delivery_load_out", "delivery_stop_add", "delivery_stop_delivered", "delivery_stop_reorder"],
  });
  // A kind that is only ever shown has no press to refuse.
  for (const k of PIECE_KINDS.values()) if (k.showOnly && k.kind !== "reply_draft") assertEquals(tabsOfKind(k.kind), [], k.kind);
  assertEquals(SHEET_START_TABS, ["designer"]);
});

// ── The three answers, as plain functions ─────────────────────────────────────────────────────────

Deno.test("only 'on' is had: locked, hidden, off and a tab the map doesn't mention are all lacked", () => {
  const m = (state: string): ServerAccess => ({ mode: "block", modules: { orders: state, contacts: "on" } });
  assertEquals(lacks(m("on"), ["orders"]), false);
  for (const state of ["locked", "hidden", "off"]) assertEquals(lacks(m(state), ["orders"]), true, state);
  assertEquals(lacks(m("on"), ["inventory"]), true, "a tab the map doesn't mention");
  // Any one of a tool's tabs is enough.
  assertEquals(lacks(m("hidden"), ["orders", "contacts"]), false);
  // No tabs, or no map: never lacked.
  assertEquals([lacks(m("hidden"), []), lacks(null, ["orders"]), lacks(undefined, ["orders"])], [false, false, false]);
});

Deno.test("block mode blocks, report mode only would, and no plan does neither", () => {
  const tabs = ["orders"];
  assertEquals([blockedBy(block(["orders"]), tabs), wouldBlock(block(["orders"]), tabs)], [true, false]);
  assertEquals([blockedBy(report(["orders"]), tabs), wouldBlock(report(["orders"]), tabs)], [false, true]);
  assertEquals([blockedBy(block([]), tabs), wouldBlock(report([]), tabs)], [false, false], "a tab the company has");
  for (const none of [null, undefined]) assertEquals([blockedBy(none, tabs), wouldBlock(none, tabs)], [false, false]);
});

Deno.test("the plan is read through Deps.plan: left out, null or a read that throws is no plan", async () => {
  assertEquals(await planOf(world().deps), null);
  assertEquals(await planOf(world({ plan: null }).deps), null);
  assertEquals(await planOf(world({ plan: "throws" }).deps), null);
  assertEquals(await planOf(world({ plan: block(["orders"]) }).deps), block(["orders"]));
});

// ── 2. No plan: exactly today's list ──────────────────────────────────────────────────────────────

Deno.test("with no plan an owner is sent today's exact list: left out, null, and every tab on are all the same", () => {
  const { deps } = world();
  const want = JSON.stringify(TODAY);
  assertEquals(names(TODAY), ALL_TOOLS, "the list an owner was sent before plans is every tool, in order");
  assertEquals(JSON.stringify(toolsFor(deps, turn("acme-sheds"))), want, "no plan on the turn");
  assertEquals(JSON.stringify(toolsFor(deps, turn("acme-sheds", null))), want, "a null plan");
  assertEquals(JSON.stringify(toolsFor(deps, turn("acme-sheds", block([])))), want, "block mode with every tab on hides nothing");
});

Deno.test("with no plan a person with narrow access, a switch off and a customer-words lock get the list they always got", () => {
  const narrow = world({ over: { canRead: (a) => a === "contacts", canEdit: () => false } }).deps;
  for (const s of [
    turn("acme-sheds"),
    { ...turn("acme-sheds"), off: ["customers", "records"] },
    { ...turn("acme-sheds"), customerWordsRead: true },
  ] as TurnState[]) {
    for (const deps of [world().deps, narrow]) {
      const before = JSON.stringify(toolsFor(deps, s));
      assertEquals(JSON.stringify(toolsFor(deps, { ...s, plan: null })), before);
      assertEquals(JSON.stringify(toolsFor(deps, { ...s, plan: report(NOTHING) })), before, "report mode never changes the list");
    }
  }
});

Deno.test("no plan: a chat turn's request to Claude is the same with Deps.plan left out, null, or failing", async () => {
  const ask = async (plan: ServerAccess | null | "throws" | undefined) => {
    const w = world({ plan, claude: [said("Morning.")] });
    const r = await handleSend(w.deps, whoAt("acme-sheds"), { text: "hello" });
    assertEquals(r.status, 200);
    // The person line carries today's date and nothing else varies, so the bodies compare whole.
    return { body: JSON.stringify({ tools: w.bodies[0].tools, system: w.bodies[0].system }), w };
  };
  const without = await ask(undefined);
  assertEquals(JSON.stringify(without.w.bodies[0].tools), JSON.stringify(TODAY));
  const system = without.w.bodies[0].system as { text: string; cache_control?: unknown }[];
  assertEquals([system.length, system[0].text === systemText(), !!system[0].cache_control], [2, true, true]);
  for (const plan of [null, "throws"] as const) {
    const got = await ask(plan);
    assertEquals(got.body, without.body, String(plan));
    assertEquals([got.w.planReads(), got.w.reports().length], [1, 0], "read once a turn, nothing filed");
  }
});

// ── 3. Report: today's list, plus rows ────────────────────────────────────────────────────────────

Deno.test("report: the turn is sent today's exact list and no plan line, and each tool block mode would hide is filed once", async () => {
  const company = "report-barns-one";
  const plan = report(["orders", "inventory"]);
  const w = world({ plan, claude: [said("Morning."), said("Again.")] });
  const r = await handleSend(w.deps, whoAt(company), { text: "hello" });
  assertEquals(r.status, 200);
  assertEquals(JSON.stringify(w.bodies[0].tools), JSON.stringify(TODAY));
  assertEquals((w.bodies[0].system as unknown[]).length, 2, "no plan line in report mode");

  const wouldHide = ALL_TOOLS.filter((n) => ["orders", "inventory"].includes(TOOL_MODULE[n][0])).sort();
  assertEquals(wouldHide.length, 8);
  const rows = w.reports();
  assertEquals(rows.map((x) => String(x.context?.action)).sort(), wouldHide.map((n) => `tool:${n}`).sort());
  const row = rows.find((x) => x.context?.action === "tool:find_who_owes")!;
  assertEquals([row.code, row.severity, row.clientId], ["module_would_refuse", "info", company]);
  assertEquals(row.message, "Report only: tool:find_who_owes would be refused (needs orders).");
  assertEquals(row.context, { action: "tool:find_who_owes", tabs: ["orders"], states: { orders: "hidden" } });

  // The next turn from the same isolate is sent the same list and files nothing more.
  await handleSend(w.deps, whoAt(company), { text: "hello again" });
  assertEquals(JSON.stringify(w.bodies[1].tools), JSON.stringify(TODAY));
  assertEquals(w.reports().length, wouldHide.length);
});

Deno.test("report: a tool the plan would hide still runs, and only a tool the person is offered is filed", async () => {
  const company = "report-barns-two";
  const plan = report(["designer", "orders"]);
  const w = world({ plan });
  const out = await runTool(w.deps, turn(company, plan), "look_at_my_catalog", {});
  assertEquals(out.isError, undefined, out.content);
  assert(w.calls.some((c) => c.action === "size_table"), "the tool ran as it always did");

  // A person without Orders isn't offered the orders tools today, so nothing is taken from them.
  const noOrders = world({ plan, over: { canRead: (a) => a !== "orders" && a !== "change_orders", canEdit: (a) => a !== "orders" && a !== "change_orders" } });
  await reportHiddenTools(noOrders.deps, turn(company, plan));
  const filed = noOrders.reports().map((x) => String(x.context?.action));
  assert(filed.length > 0 && filed.every((a) => TOOL_MODULE[a.slice(5)][0] === "designer"), filed.join(", "));
  // And with no plan or a block plan, the reporter files nothing at all.
  for (const p of [undefined, null, block(["designer"])]) {
    const quiet = world();
    await reportHiddenTools(quiet.deps, turn("report-barns-three", p));
    assertEquals(quiet.logs.length, 0);
  }
});

Deno.test("report: a logger that fails doesn't fail the turn", async () => {
  const plan = report(["orders"]);
  const w = world({ plan, claude: [said("Morning.")], over: { log: () => Promise.reject(new Error("app_errors is down")) } });
  const r = await handleSend(w.deps, whoAt("report-barns-four"), { text: "hello" });
  assertEquals([r.status, r.body.ok], [200, true]);
});

// ── 4. Block ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("block: taking one tab away hides exactly that tab's tools, whatever the tab", () => {
  const { deps } = world();
  const tabs = [...new Set(Object.values(TOOL_MODULE).flat())];
  assertEquals(tabs.length, 8);
  for (const tab of tabs) {
    const gone = ALL_TOOLS.filter((n) => TOOL_MODULE[n].includes(tab));
    assert(gone.length > 0, tab);
    for (const state of ["hidden", "locked", "off"]) {
      const got = names(toolsFor(deps, turn("acme-sheds", block([tab], state))));
      assertEquals(got, ALL_TOOLS.filter((n) => !gone.includes(n)), `${tab} ${state}`);
    }
  }
});

Deno.test("block: a company with none of the tabs keeps exactly the tools every account has", () => {
  const { deps } = world();
  const got = names(toolsFor(deps, turn("acme-sheds", block(NOTHING))));
  assertEquals(got, ALL_TOOLS.filter((n) => TOOL_MODULE[n].length === 0));
  assertEquals([...got].sort(), ["ask_to_be_sure", "look_at_billing", "look_at_my_setup", "point_to_step", "propose_commission_rate", "propose_company_details", "propose_locations", "propose_paperwork", "propose_setup_tick"]);
  // A map that names no tab at all (only something else) reads the same: missing is not on.
  assertEquals(names(toolsFor(deps, turn("acme-sheds", { mode: "block", modules: { phone: "on" } }))), got);
});

Deno.test("block: the three price and door tools are hidden with the Designer, and refused if Claude calls one anyway", async () => {
  const plan = block(["designer"]);
  const w = world({ plan });
  const s = turn("acme-sheds", plan);
  const sent = names(toolsFor(w.deps, s));
  for (const n of names(TOOL_DEFS)) assert(!sent.includes(n), `${n} was sent to a company without the Designer`);
  for (const [n, input] of [["look_at_my_catalog", {}], ["propose_size_changes", raise5], ["propose_new_door", { name: "Barn door", widthInches: 60, heightInches: 80, price: 400, swing: "out", operation: "double" }]] as const) {
    assertEquals(await runTool(w.deps, s, n, input), { content: NOT_AVAILABLE, isError: true }, n);
  }
  assertEquals([w.calls.length, w.proposals.size], [0, 0], "nothing was read and no card was made");
  // With the Designer on they run.
  const has = world();
  assertEquals((await runTool(has.deps, turn("acme-sheds", block(["orders"])), "look_at_my_catalog", {})).isError, undefined);
  // A name no tool has is still an unknown tool, not a plan refusal.
  assertEquals((await runTool(w.deps, s, "no_such_tool", {})).content, "Unknown tool no_such_tool.");
});

Deno.test("block: a piece's tool the plan leaves out is refused if called, before it reads anything", async () => {
  const plan = block(["orders", "automations"]);
  const w = world({ plan });
  const s = turn("acme-sheds", plan);
  for (const n of ["find_who_owes", "propose_change_order", "look_at_my_rules"]) {
    assertEquals(await runTool(w.deps, s, n, {}), { content: NOT_AVAILABLE, isError: true }, n);
  }
  assertEquals(w.calls.length, 0);
  // After a customer's words the answer is still the plan's, never "ask again in a new message".
  const locked = { ...s, customerWordsRead: true, lockedByReply: true } as TurnState;
  assertEquals((await runTool(w.deps, locked, "propose_change_order", {})).content, NOT_AVAILABLE);
  // A commission rate is the Team screen's, which carries no tab (portal-commissions set_rate): a
  // company without the Commissions tab sets a rate by hand, so Jack still offers it and runs it.
  const noCommissions = block([...NOTHING, "commissions"]);
  const team = world({ plan: noCommissions });
  assert(names(toolsFor(team.deps, turn("acme-sheds", noCommissions))).includes("propose_commission_rate"), "the rate tool was hidden by a plan");
  assert((await runTool(team.deps, turn("acme-sheds", noCommissions), "propose_commission_rate", {})).content !== NOT_AVAILABLE, "the rate tool was refused by a plan");
});

Deno.test("block: what is left stays inside the API's strict limits", () => {
  const { deps } = world();
  for (const tab of [...new Set(Object.values(TOOL_MODULE).flat())]) {
    const c = strictCost(toolsFor(deps, turn("acme-sheds", block([tab]))));
    assert(c.tools <= STRICT_LIMITS.tools && c.optional <= STRICT_LIMITS.optional && c.unions <= STRICT_LIMITS.unions, `${tab}: ${JSON.stringify(c)}`);
  }
  assert(strictCost(TODAY).tools <= STRICT_LIMITS.tools, "an owner's whole list still fits");
});

Deno.test("block: one line after the cached block tells Jack which areas the plan leaves out; the cached block is untouched", async () => {
  const plan = block(["orders", "inventory", "automations"]);
  const w = world({ plan, claude: [toolUse("find_who_owes", {}), said("Orders aren't part of this account's plan.")] });
  const r = await handleSend(w.deps, whoAt("acme-sheds"), { text: "who owes me money?" });
  assertEquals(r.status, 200);
  const system = w.bodies[0].system as { text: string; cache_control?: unknown }[];
  assertEquals(system.length, 3);
  assertEquals([system[0].text === systemText(), !!system[0].cache_control], [true, true], "the shared cached block is byte for byte the same");
  assertEquals(system[1].text, planLine(plan));
  assertEquals(system[1].cache_control, undefined);
  assert(system[2].text.startsWith("The person you are helping"), "the person line still follows");
  // The catalogue's own labels, in the catalogue's order.
  assert(system[1].text.startsWith("This account's plan does not include: Automations, Inventory, Orders."), system[1].text);
  assert(/isn't part of their account's plan/.test(system[1].text), system[1].text);
  // The tools sent leave those areas out, and the one Claude called anyway came back refused.
  const sent = names(w.bodies[0].tools as { name: string }[]);
  for (const n of ["find_who_owes", "look_at_inventory", "propose_rule"]) assert(!sent.includes(n), n);
  // deno-lint-ignore no-explicit-any
  const result = ((w.bodies[1].messages as any[]).at(-1).content as any[])[0];
  assertEquals([result.type, result.content, result.is_error], ["tool_result", NOT_AVAILABLE, true]);
  // The same line on the second round: it is worked out from the plan alone.
  assertEquals(JSON.stringify(w.bodies[1].system), JSON.stringify(w.bodies[0].system));
  assertEquals([w.planReads(), w.reports().length, w.calls.length], [1, 0, 0], "read once, nothing filed in block mode, nothing read downstream");
});

Deno.test("the plan line: only in block mode, only when a tool is hidden, and in the catalogue's words", () => {
  for (const none of [null, undefined, report(NOTHING), block([])]) assertEquals(planLine(none), null);
  // A tab no tool of Jack's belongs to is not his to mention.
  assertEquals(planLine(block(["phone", "quickbooks", "forms", "commissions"])), null);
  const label = (k: string) => ACCESS_MODULES.find((m) => m.key === k)!.label;
  assertEquals(missingAreas(block(["delivery_schedule", "contacts", "designer"])), [label("contacts"), label("designer"), label("delivery_schedule")]);
  assertEquals(missingAreas(block(NOTHING)).length, 8);
  const line = planLine(block(["inventory"]))!;
  assert(line.startsWith("This account's plan does not include: Inventory.") && line.length < 400, line);
});

// ── 5. A press ────────────────────────────────────────────────────────────────────────────────────

/** A sizes-table card, made by a turn with no plan in the way, ready to approve. */
async function readyCard(company: string) {
  const maker = world({ claude: [toolUse("propose_size_changes", raise5), said("Check it over.")] });
  await handleSend(maker.deps, whoAt(company), { text: "raise everything 5%" });
  const [card] = [...maker.proposals.values()];
  assertEquals([card.kind, card.status], ["size_rule", "ready"]);
  return card;
}
/** The same world, holding `card`, with `plan` as the company's map. */
function worldWith(card: ProposalRow, plan: ServerAccess | null | undefined) {
  const w = world({ plan });
  w.proposals.set(card.id, { ...card });
  return w;
}

Deno.test("approve in block mode: a card whose tab the company lost is 403 module_off, and nothing is saved or claimed", async () => {
  const company = "acme-sheds";
  const card = await readyCard(company);
  const w = worldWith(card, block(["designer"]));
  const r = await handleProposalApprove(w.deps, whoAt(company), { id: card.id, hash: card.shown_hash });
  assertEquals([r.status, r.body], [403, { error: MODULE_REFUSAL, code: "module_off" }]);
  const after = w.proposals.get(card.id)!;
  assertEquals([after.status, after.approved_by, after.approved_at], ["ready", null, null], "the card stays as it was");
  assertEquals([w.calls.length, w.reports().length, w.planReads()], [0, 0, 1]);
  // "locked" is refused like hidden.
  const locked = worldWith(card, block(["designer"], "locked"));
  assertEquals((await handleProposalApprove(locked.deps, whoAt(company), { id: card.id, hash: card.shown_hash })).body.code, "module_off");
  // With the tab on, in block mode, it runs.
  const has = worldWith(card, block(["orders"]));
  const ok = await handleProposalApprove(has.deps, whoAt(company), { id: card.id, hash: card.shown_hash });
  assertEquals([ok.status, has.proposals.get(card.id)?.status], [200, "applied"]);
});

Deno.test("approve with no plan, and in report mode, runs as it always did; report files one row for the press", async () => {
  for (const plan of [undefined, null, "throws"] as const) {
    const company = "acme-sheds";
    const card = await readyCard(company);
    const w = world({ plan });
    w.proposals.set(card.id, { ...card });
    const r = await handleProposalApprove(w.deps, whoAt(company), { id: card.id, hash: card.shown_hash });
    assertEquals([r.status, w.proposals.get(card.id)?.status, w.reports().length], [200, "applied", 0], String(plan));
    assertEquals(w.calls.filter((c) => c.action === "save_pricing_cells").length, 1);
  }
  const company = "report-barns-five";
  const plan = report(["designer"]);
  const first = await readyCard(company);
  const w = worldWith(first, plan);
  const r = await handleProposalApprove(w.deps, whoAt(company), { id: first.id, hash: first.shown_hash });
  assertEquals([r.status, w.proposals.get(first.id)?.status], [200, "applied"]);
  assertEquals(w.reports().map((x) => [x.message, x.clientId, x.severity]), [["Report only: approve:size_rule would be refused (needs designer).", company, "info"]]);
  assertEquals(w.reports()[0].context, { action: "approve:size_rule", tabs: ["designer"], states: { designer: "hidden" } });
  // A second card of the same kind, the same isolate: it runs, and is not filed again.
  const second = await readyCard(company);
  const again = worldWith(second, plan);
  assertEquals((await handleProposalApprove(again.deps, whoAt(company), { id: second.id, hash: second.shown_hash })).status, 200);
  assertEquals(again.reports().length, 0);
});

Deno.test("approve: a piece's card is checked before its own approve path, and a card of every account never asks the plan", async () => {
  const company = "acme-sheds";
  const put = (w: ReturnType<typeof world>, kind: string) => {
    const row = { id: "00000000-0000-4000-8000-0000000000aa", client_id: company, user_id: "u1", conversation_id: "chat1", kind, status: "ready", title: "A card", file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: "h", failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString() } as ProposalRow;
    w.proposals.set(row.id, row);
    return row;
  };
  for (const [kind, tab] of [["automation_rule", "automations"], ["inventory_price", "inventory"], ["delivery_load_out", "delivery_schedule"], ["estimate_resend", "contacts"], ["setup_styles", "designer"]]) {
    const w = world({ plan: block([tab]) });
    const row = put(w, kind);
    const r = await handleProposalApprove(w.deps, whoAt(company), { id: row.id, hash: "h", send: true });
    assertEquals([r.status, r.body.code, r.body.error], [403, "module_off", MODULE_REFUSAL], kind);
    assertEquals([w.proposals.get(row.id)?.status, w.calls.length], ["ready", 0], kind);
    // The same card when another tab is the missing one is not refused by the plan.
    const other = world({ plan: block([tab === "orders" ? "inventory" : "orders"]) });
    const row2 = put(other, kind);
    const r2 = await handleProposalApprove(other.deps, whoAt(company), { id: row2.id, hash: "h", send: true });
    assert(r2.body.code !== "module_off", `${kind} was refused by a plan that has its tab`);
  }
  // Setup, memory: every account's. Not refused with every tab gone, and the map is never read for them.
  // A commission rate too, with the Commissions tab gone as well: its route is the Team screen's.
  for (const kind of ["setup_tick", "setup_company", "setup_locations", "setup_paperwork", "commission_rate"]) {
    const w = world({ plan: block([...NOTHING, "commissions"]) });
    const row = put(w, kind);
    const r = await handleProposalApprove(w.deps, whoAt(company), { id: row.id, hash: "h" });
    assert(r.body.code !== "module_off", kind);
    assertEquals(w.planReads(), 0, `${kind} read the plan though it has no tab`);
  }
});

Deno.test("undo and cancel are never refused at Jack's own door, and never ask the plan (the routes behind it answer 200 here)", async () => {
  // This world's portal answers 200 to everything, so it shows Jack's half only: he does not stand
  // in the way. What the real routes say to a put-back whose tab is gone is the next test.
  const company = "acme-sheds";
  const gone = block(NOTHING);
  // Approved while the company had the Designer…
  const card = await readyCard(company);
  const had = worldWith(card, null);
  assertEquals((await handleProposalApprove(had.deps, whoAt(company), { id: card.id, hash: card.shown_hash })).status, 200);
  const applied = had.proposals.get(card.id)!;
  assert(applied.status === "applied" && applied.undo, "the card was applied and can be undone");
  // …and put back after every tab was taken away.
  const w = worldWith(applied, gone);
  const undo = await handleProposalUndo(w.deps, whoAt(company), { id: card.id });
  assertEquals([undo.status, w.proposals.get(card.id)?.status], [200, "undone"]);
  assertEquals(w.calls.filter((c) => c.action === "save_pricing_cells").length, 1, "the undo reached the table");
  assertEquals(w.planReads(), 0, "undo never reads the plan");

  // A card still waiting can always be dismissed.
  const waiting = await readyCard(company);
  const c = worldWith(waiting, gone);
  const cancel = await handleProposalCancel(c.deps, whoAt(company), { id: waiting.id });
  assertEquals([cancel.status, c.proposals.get(waiting.id)?.status, c.planReads()], [200, "cancelled", 0]);
});

Deno.test("OPEN GAP, pinned as it is: an Undo whose tab is gone gets past Jack, is refused by the route behind him, and keeps its Undo", async () => {
  // Stage D review, finding 1. Contract rule 4 says a plan never refuses the undo of something already
  // done. Jack's door keeps that. The put-back does not: it is save_pricing_cells in portal-settings,
  // with the person's own token, and that door (resolveTenant with portal-settings' gate table) answers
  // 403 module_off once the Designer is gone. That cannot be cured in jack-agent (plan.ts says why), so
  // this test holds what a person gets TODAY, and the two things that must stay true until it is cured:
  // nothing is called "undone" that was not put back, and the one Undo is not spent.
  // ⚠️ When the routes behind Jack learn to let a put-back through, the first half of this test is the
  // part to change: the press should then end "undone" the first time.
  const company = "acme-sheds";
  const card = await readyCard(company);
  const had = worldWith(card, null);
  assertEquals((await handleProposalApprove(had.deps, whoAt(company), { id: card.id, hash: card.shown_hash })).status, 200);
  const applied = had.proposals.get(card.id)!;
  const sizes = (applied.undo as { sizes: unknown[] }).sizes.length;
  assert(applied.status === "applied" && sizes > 0, "the card was applied and has sizes to put back");

  // The company loses the Designer. portal-settings answers as resolveTenant does for it.
  let designer = false;
  const asked: string[] = [];
  const w = worldWith(applied, block(["designer"]));
  const answers = w.deps.portal;
  w.deps.portal = (action, body) => {
    asked.push(action);
    return designer ? answers(action, body) : Promise.resolve({ status: 403, data: { error: MODULE_REFUSAL, code: "module_off" } });
  };
  const first = await handleProposalUndo(w.deps, whoAt(company), { id: card.id });
  const after = w.proposals.get(card.id)!;
  // Jack answers 200 and never read the plan: the refusal is not his.
  assertEquals([first.status, w.planReads()], [200, 0]);
  // A refusal is an answer, so it is asked once, not retried like a dropped connection.
  assertEquals(asked, ["save_pricing_cells"]);
  // Nothing went back, and the card says so: still applied, never "undone", every size reported with
  // the plan's own sentence, so the person reads why and not "something went wrong".
  assertEquals([after.status, after.undone_at ?? null], ["applied", null]);
  const told = (after.result as { undo: { restored: number; failed: number; reports: { status: string; reason: string }[] } }).undo;
  assertEquals([told.restored, told.failed], [0, sizes]);
  assertEquals(told.reports.map((x) => [x.status, x.reason]), Array.from({ length: sizes }, () => ["error", MODULE_REFUSAL]));
  // The Undo is not spent: the plan it would run is still on the card.
  assertEquals(after.undo, applied.undo);

  // The tab comes back (or the route is cured): the same press now puts it back.
  designer = true;
  const second = await handleProposalUndo(w.deps, whoAt(company), { id: card.id });
  assertEquals([second.status, w.proposals.get(card.id)?.status], [200, "undone"]);
  assertEquals(asked, ["save_pricing_cells", "save_pricing_cells"]);
});

const SHEET = { fileName: "prices.csv", sheets: [{ name: "Sheet1", rows: [["Style", "Size", "Price"], ["Garden Shed", "10x12", "4200"]] }] };

Deno.test("a price list in block mode without the Designer is 403 module_off before the wallet, a card or a read", async () => {
  const w = world({ plan: block(["designer"]) });
  const r = await handleSheetStart(w.deps, whoAt("acme-sheds"), SHEET);
  assertEquals([r.status, r.body], [403, { error: MODULE_REFUSAL, code: "module_off" }]);
  assertEquals([w.money.length, w.proposals.size, w.messages.length, w.background.length, w.bodies.length, w.calls.length], [0, 0, 0, 0, 0, 0]);
  // A person who may not change the sizes table hears that first, as before.
  const noAccess = world({ plan: block(["designer"]), over: { canEdit: () => false } });
  const refused = await handleSheetStart(noAccess.deps, whoAt("acme-sheds"), SHEET);
  assertEquals([refused.status, refused.body.code, noAccess.planReads()], [403, undefined, 0]);
});

Deno.test("a price list with no plan, with the Designer on, and in report mode starts as it always did", async () => {
  const start = async (company: string, plan: ServerAccess | null | undefined) => {
    // The read itself is Claude's and not this test's: it fails, in the background, and the card says so.
    const w = world({ plan, claude: [] });
    const r = await handleSheetStart(w.deps, whoAt(company), SHEET);
    await Promise.all(w.background);
    return { r, w };
  };
  for (const plan of [undefined, null, block(["orders"])]) {
    const { r, w } = await start("acme-sheds", plan);
    assertEquals([r.status, r.body.ok, w.proposals.size, w.reports().length], [200, true, 1, 0], JSON.stringify(plan ?? null));
    assert(w.money.length > 0, "the wallet was asked, as before");
  }
  const { r, w } = await start("report-barns-six", report(["designer"]));
  assertEquals([r.status, r.body.ok, w.proposals.size], [200, true, 1]);
  assertEquals(w.reports().map((x) => x.message), ["Report only: press:sheet_start would be refused (needs designer)."]);
});

Deno.test("report: a price list's row is keyed apart from the route's own, so resolveTenant's row for the Jack tab cannot silence it", async () => {
  // resolveTenant files its own report for an action under (company, "jack-agent", <the route's
  // name>), and it always runs first. A company in report mode whose Jack tab is off AND which has no
  // Designer gets resolveTenant's "sheet_start would be refused (needs jack)". Played here by marking
  // that key the way resolveTenant does; the press must still say the price list needs the Designer.
  const company = "report-barns-seven";
  assertEquals(firstReport(company, PLAN_FN, "sheet_start"), true, "resolveTenant's own row, filed first");
  const w = world({ plan: report(["jack", "designer"]), claude: [] });
  const r = await handleSheetStart(w.deps, whoAt(company), SHEET);
  await Promise.all(w.background);
  assertEquals([r.status, r.body.ok], [200, true]);
  assertEquals(w.reports().map((x) => [x.message, x.context]), [[
    "Report only: press:sheet_start would be refused (needs designer).",
    { action: "press:sheet_start", tabs: ["designer"], states: { designer: "hidden" } },
  ]]);
  // The rule behind it: no key Jack files under is a route's name, because every route's name is a
  // key resolveTenant may already have used for this company.
  const routes = new Set(Object.keys(GATES));
  const keys = [SHEET_START_KEY, ...ALL_TOOLS.map((n) => `tool:${n}`), ...ALL_KINDS.map((k) => `approve:${k}`)];
  assertEquals(keys.filter((k) => routes.has(k)), []);
  assert(routes.has("sheet_start"), "the route is still called sheet_start");
});

// ── What `status` tells the page ──────────────────────────────────────────────────────────────────

Deno.test("status in block mode without the Jack tab: the record is all there, and the page is told a message would be refused", async () => {
  // The case: an operator takes the Jack tab away from a company whose own switch (jack_on) is still
  // on. `status` carries no tab, so it answers; before this it said Jack was available, and the first
  // message typed came back 403 "This isn't part of your plan".
  const company = "acme-sheds";
  const card = await readyCard(company);
  const applied = { ...card, status: "applied", undo: { removes: [], sizes: [] } } as ProposalRow;
  const open = (plan: ServerAccess | null | undefined | "throws", over: Partial<Store> = {}) => {
    const w = world({ plan });
    w.proposals.set(applied.id, { ...applied });
    Object.assign(w.store, {
      openChat: () => Promise.resolve({ id: "chat1" }),
      chats: () => Promise.resolve([{ id: "chat1", title: "Raise 5%" }]),
      messages: () => Promise.resolve([{ id: "m1", role: "assistant", body: "Here it is.", created_at: "now", proposal_ids: [applied.id] }]),
      ...over,
    });
    return w;
  };
  // What a company with no plan is told: the answer every other case is measured against.
  const before = (await handleStatus(open(undefined).deps, whoAt(company), "owner")).body;
  assertEquals([before.enabled, before.available, before.unavailable], [true, true, null]);

  for (const state of ["hidden", "off", "locked"]) {
    const w = open(block(["jack"], state));
    const r = await handleStatus(w.deps, whoAt(company), "owner");
    assertEquals([r.status, r.body.enabled, r.body.available, r.body.unavailable], [200, true, false, MODULE_REFUSAL], state);
    // Nothing else moved: the chat, its card with what can be undone, the chat list and who may manage.
    assertEquals({ ...r.body, available: true, unavailable: null }, before, state);
    const shown = (r.body.chat as { proposals: { id: string; status: string }[] }).proposals;
    assertEquals(shown.map((p) => [p.id, p.status]), [[applied.id, "applied"]]);
    assertEquals([w.planReads(), w.reports().length], [1, 0]);
  }
  // The plan's sentence comes first: it is why, and a month's cap or a missing key is not.
  const noKey = open(block(["jack"]));
  noKey.deps.env = () => undefined;
  assertEquals((await handleStatus(noKey.deps, whoAt(company), "owner")).body.unavailable, MODULE_REFUSAL);

  // Not named, a read that fails, REPORT mode (which refuses nothing, so says nothing), and block mode
  // with the Jack tab on whatever else is missing: the answer is the one above, to the letter.
  for (const plan of [null, "throws", report(["jack"]), report(NOTHING), block(NOTHING), block([])] as const) {
    const w = open(plan);
    assertEquals((await handleStatus(w.deps, whoAt(company), "owner")).body, before, JSON.stringify(plan));
    assertEquals(w.reports().length, 0);
  }
  // Jack switched off by the company itself: "not switched on", as always, and the map is never read.
  const off = open(block(["jack"]), { settings: () => Promise.resolve({ on: false, off: [] }) });
  const said = (await handleStatus(off.deps, whoAt(company), "owner")).body;
  assertEquals([said.enabled, said.available, off.planReads()], [false, false, 0]);
  assert(said.unavailable !== MODULE_REFUSAL);
});

/** Every timer started and stopped while `run` is going: the delay each was started with, and whether
 *  it was cleared. The real timers still run; this only watches. `deno test` does not fail a test that
 *  leaves a timer running (seen on Deno 2.9.2), so nothing but this says planSoon stops its own. */
async function timersDuring<T>(run: () => Promise<T>): Promise<{ value: T; timers: { ms: unknown; cleared: boolean }[] }> {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const realSet = g.setTimeout, realClear = g.clearTimeout;
  const started: { id: unknown; ms: unknown }[] = [];
  const cleared: unknown[] = [];
  g.setTimeout = (fn: unknown, ms: unknown, ...rest: unknown[]) => { const id = realSet(fn, ms, ...rest); started.push({ id, ms }); return id; };
  g.clearTimeout = (id: unknown) => { cleared.push(id); return realClear(id); };
  try {
    const value = await run();
    return { value, timers: started.map((t) => ({ ms: t.ms, cleared: cleared.includes(t.id) })) };
  } finally {
    g.setTimeout = realSet;
    g.clearTimeout = realClear;
  }
}

Deno.test("status never waits on the map: a read that never answers still answers status in about a second, exactly as before plans", async () => {
  // Before stage D `status` read no map at all. It now asks, to tell the page whether a message
  // would be refused, and a stalled read (the function slow, a lock on the plan tables) must not
  // hang the panel: a slow read is the old rules. The promise here never settles at all.
  const company = "acme-sheds";
  const before = (await handleStatus(world().deps, whoAt(company), "owner")).body;
  assertEquals([before.enabled, before.available, before.unavailable], [true, true, null]);
  let asked = 0;
  const stalled = world({ over: { plan: () => { asked++; return new Promise<ServerAccess | null>(() => {}); } } });
  const started = Date.now();
  const watched = await timersDuring(() => handleStatus(stalled.deps, whoAt(company), "owner"));
  const took = Date.now() - started;
  const r = watched.value;
  assertEquals([r.status, asked], [200, 1]);
  assertEquals(r.body, before, "a stalled read answers as a company with no plan does");
  // The wall clock is a loose bound on purpose (other work shares this machine). What holds status
  // to ONE second is the delay it starts its one timer with, and that timer is stopped behind it.
  assert(took < 6_000, `status waited ${took} ms on a read that never answered`);
  assertEquals(watched.timers, [{ ms: 1000, cleared: true }], "status bounds its map read at one second, and leaves no timer behind");

  // planSoon itself. A read that answers in time is the answer, whatever it is; one that is late, or
  // throws, or is not there, is null. EVERY ONE STOPS ITS TIMER, and the ones that matter are the
  // reads that answer first: without the clear each status call would leave a timer running for
  // the rest of its second on the edge.
  const soon = async (deps: Deps, want: ServerAccess | null, ms?: number) => {
    const w = await timersDuring(() => (ms === undefined ? planSoon(deps) : planSoon(deps, ms)));
    assertEquals(w.value, want);
    assertEquals(w.timers, [{ ms: ms ?? 1000, cleared: true }], "planSoon starts one timer, of the delay asked for, and stops it");
  };
  await soon(stalled.deps, null, 20);
  await soon(world({ plan: block(["jack"]) }).deps, block(["jack"]), 20);
  await soon(world({ plan: null }).deps, null, 20);
  await soon(world({ plan: "throws" }).deps, null, 20);
  await soon(world().deps, null, 20);
  // Left to itself the bound is one second (asked of a read that answers at once, so nothing waits).
  await soon(world({ plan: block(["jack"]) }).deps, block(["jack"]));
  let late: (v: ServerAccess | null) => void = () => {};
  const slow = world({ over: { plan: () => new Promise<ServerAccess | null>((r) => { late = r; }) } });
  await soon(slow.deps, null, 20);
  late(block(["jack"]));
  // send, approve and a price list still wait for the real answer: only the display is bounded.
  const waits = world({ over: { plan: () => new Promise<ServerAccess | null>((r) => setTimeout(() => r(block(["jack"])), 40)) } });
  assertEquals(await planOf(waits.deps), block(["jack"]));
});

Deno.test("the tab status answers by is the tab the door refuses a message, a price list and an approve by", () => {
  for (const action of ["send", "sheet_start", "proposal_approve"]) {
    assertEquals(modulesForAction(PLAN_FN, action, GATES[action]), [...JACK_TABS], action);
  }
  assert(isAccessModule(JACK_TABS[0]));
  // And status itself has no tab: it is never refused, so it has to be the one to say.
  assertEquals(modulesForAction(PLAN_FN, "status", GATES.status), []);
});

// ── The Shed Scheduler add-on check ───────────────────────────────────────────────────────────────

Deno.test("the build schedule's add-on check: the map answers in block mode, the entitlement everywhere else", async () => {
  // Block: a company given the Build Schedule by a plan row alone has no Shed Scheduler subscription
  // (the fake entitlement says false), and must not be refused by Jack while the page allows it.
  const given = world({ plan: block([]) });
  assertEquals(await addOnOn(given.deps), true);
  assertEquals(given.calls.length, 0, "the entitlement isn't asked when the map answers");
  for (const state of ["hidden", "locked", "off"]) assertEquals(await addOnOn(world({ plan: block(["build_schedule"], state) }).deps), false, state);
  // No plan, a failed read, report mode: the entitlement, exactly as before.
  for (const plan of [undefined, null, "throws", report(["build_schedule"]), report([])] as const) {
    const w = world({ plan });
    assertEquals(await addOnOn(w.deps), false, String(plan));
    assertEquals(w.calls, [{ fn: "portal-billing", action: "status" }]);
  }
  const subscribed = world({ plan: null, over: { call: () => Promise.resolve({ status: 200, data: { entitlement: { features: { schedule_builds: true } } } }) } });
  assertEquals(await addOnOn(subscribed.deps), true);
});

// ── The report row ────────────────────────────────────────────────────────────────────────────────

Deno.test("a report row is in resolveTenant's own words and shape, filed under jack-agent", () => {
  assertEquals(PLAN_FN, "jack-agent");
  assertEquals(reportRow(report(["contacts"], "locked"), "tool:look_up_customer", ["contacts"]), {
    code: "module_would_refuse", severity: "info",
    message: "Report only: tool:look_up_customer would be refused (needs contacts).",
    context: { action: "tool:look_up_customer", tabs: ["contacts"], states: { contacts: "locked" } },
  });
  // A tab the map doesn't mention is recorded as null, never left out.
  assertEquals(reportRow({ mode: "report", modules: { phone: "on" } }, SHEET_START_KEY, ["designer"]).context.states, { designer: null });
});
