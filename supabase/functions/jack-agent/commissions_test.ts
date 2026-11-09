// The commissions piece (commissions.ts), through agent.ts's own routing: the tool as Claude reaches it
// (runTool, toolsFor) and the card as a person presses it (handleProposalApprove / handleProposalUndo /
// handleProposalGet / handleActivity). portal-commissions is a fake that keeps the real route's order of
// checks, bodies, columns and refusals for list, set_rate and list_entries (index.ts:266-385, 503-629,
// 1178-1181, 404-497): the caller's own team row, the 403 on any targetClientId (every operator call, as
// jack-agent/index.ts adds it), canSeeRates, the case-sensitive self check, requireMember, the 0..100 range
// and the 3-decimal rounding. No network.

import { assert, assertEquals } from "./test_assert.ts";
import {
  type Deps, handleActivity, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, runTool, SENTENCES, strictCost,
  type Store, toolsFor, type TurnState, type Who,
} from "./agent.ts";
import { PIECE_KINDS, PIECE_TOOLS, register } from "./pieces.ts";
import { COMM_SAID, COMMISSION_KIND, COMMISSION_OPERATOR_HIDDEN, commissionsPiece, ledgerFor, rateKind } from "./commissions.ts";
import { leaksContactDetails } from "./redact.ts";
import { SAID } from "./common.ts";

register([commissionsPiece]);

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };

const OWNER_ID = "0a000000-0000-4000-8000-000000000001";
const DALE_ID = "0b000000-0000-4000-8000-000000000002";
const PAM_ID = "0c000000-0000-4000-8000-000000000003";
const RICK_ID = "0d000000-0000-4000-8000-000000000004";
const DANA_ID = "0e000000-0000-4000-8000-000000000005";
const OPERATOR_ID = "0f000000-0000-4000-8000-0000000000ff";

const OWNER: Who = { clientId: "builder-a", userId: OWNER_ID, operatorEmail: null };
/** Office manager: an admin the owner gave full access (sees and edits rates), not every payout. */
const PAM: Who = { clientId: "builder-a", userId: PAM_ID, operatorEmail: null };
/** Sales manager: Team at view, no full access, so no rates. */
const RICK: Who = { clientId: "builder-a", userId: RICK_ID, operatorEmail: null };
const OPERATOR: Who = { clientId: "builder-a", userId: OPERATOR_ID, operatorEmail: "ops@csmsynergy.example" };

const okRes = (data: Record<string, unknown> = {}): Res => ({ status: 200, data: { ok: true, ...data } });
const no = (status: number, error: string): Res => ({ status, data: { error } });
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ── The builder's team, and portal-commissions as index.ts answers ──────────────────────────────────

interface Row { userId: string; fullName: string; email: string; role: string; title: string | null; rate: number | null; fullAccess: boolean; seesAll: boolean; banned: boolean }
/** What resolveTenant would give this caller, the way portal-commissions resolves it from client_users. */
interface Caller { who: Who; team: boolean; commissions: boolean }

const entry = (id: string, orderId: string, earner: string, status: string, o: Partial<Any> = {}) => ({
  id, orderId, orderNo: 1001, customer: "Jane Buyer", building: "Garden Shed 10x12", earnerUserId: earner, earnerName: "x",
  baseCents: 100_000, ratePercent: 5, amountCents: 5_000, earnedOn: "2026-10-01", periodKey: "2026-10-01", periodLabel: "Oct 1 – Oct 14, 2026",
  status, kind: "commission", isOverride: false, splitShare: null, ...o,
});

class World {
  members: Row[] = [
    { userId: OWNER_ID, fullName: "Mike Owner", email: "mike@ridgeline.example", role: "owner", title: null, rate: null, fullAccess: false, seesAll: false, banned: false },
    { userId: DALE_ID, fullName: "Dale Smith", email: "dale@ridgeline.example", role: "user", title: "sales_rep", rate: 5, fullAccess: false, seesAll: false, banned: false },
    { userId: PAM_ID, fullName: "Pam Office", email: "pam@ridgeline.example", role: "admin", title: "office_manager", rate: 2, fullAccess: true, seesAll: false, banned: false },
    { userId: RICK_ID, fullName: "Rick Sales", email: "rick@ridgeline.example", role: "user", title: "sales_manager", rate: 4, fullAccess: false, seesAll: false, banned: false },
    { userId: DANA_ID, fullName: "Dana Lee", email: "dana@ridgeline.example", role: "user", title: "sales_rep", rate: null, fullAccess: false, seesAll: false, banned: true },
  ];
  entries: Any[] = [
    entry("e1", "o1", DALE_ID, "pending"),
    // A sale with an approved line on it: compute leaves the whole sale alone.
    entry("e2", "o2", DALE_ID, "pending", { baseCents: 200_000, amountCents: 10_000 }), entry("e2b", "o2", RICK_ID, "payable"),
    entry("e3", "o3", DALE_ID, "pending", { isOverride: true }),
    entry("e4", "o4", DALE_ID, "paid"),
    entry("e5", "o5", RICK_ID, "pending"),
    entry("e6", "o6", DALE_ID, "pending", { baseCents: null, amountCents: null, ratePercent: null }),
    entry("e7", "o7", DALE_ID, "pending", { kind: "clawback", amountCents: -5_000 }),
    entry("e8", "o8", DALE_ID, "excluded"),
  ];
  enabled = true;
  calls: { fn: string; action: string; body: Any }[] = [];
  /** Forced answers by action, for the failure paths. */
  answer: Record<string, Res | ((body: Any, caller: Caller) => Res)> = {};
  cards = new Map<string, ProposalRow>();
  store: Store | null = null;

  route(fn: string, action: string, body: Any, caller: Caller): Res {
    this.calls.push({ fn, action, body });
    const forced = this.answer[action];
    if (forced) return typeof forced === "function" ? forced(body, caller) : forced;
    if (fn !== "portal-commissions") return no(400, "Unknown action");
    return this.commissions(action, body, caller);
  }

  /** index.ts, in its own order: the caller's team row (:281), the targetClientId refusal (:381), then the action. */
  commissions(action: string, body: Any, caller: Caller): Res {
    // client_users.user_id is a uuid column: a lookup ignores case.
    const me = this.members.find((m) => m.userId === caller.who.userId.toLowerCase());
    if (!me) return no(403, "Your login isn't attached to an account.");
    if (body.targetClientId !== undefined && body.targetClientId !== null && body.targetClientId !== "") {
      return no(403, "Commissions are per-builder and cannot be changed on another account's behalf. Ask that builder's owner to make the change.");
    }
    const isOwner = me.role === "owner";
    const canSeeRates = isOwner || me.fullAccess;
    const seesAll = isOwner || me.seesAll;
    switch (action) {
      case "list":
        if (!caller.team) return no(403, "You don't have access to the team list.");
        return okRes({
          clientId: "builder-a", role: me.role, canSeeRates, isOwner, locations: [], meta: {}, isInternal: false, canManageTeam: false, myAccess: {},
          members: this.members.map((m) => ({
            userId: m.userId, email: m.email, fullName: m.fullName, role: m.role,
            // The route compares as typed (uid === user.id).
            isSelf: m.userId === caller.who.userId,
            commissionPercent: canSeeRates ? m.rate : undefined, rateHidden: canSeeRates ? undefined : true,
            seesAllPayouts: isOwner ? m.seesAll : undefined, fullAccess: isOwner ? m.fullAccess : undefined,
            lastActive: "2026-11-05T15:00:00Z", deactivated: m.banned, driver: null, title: m.title, access: null, effective: {}, locationId: null,
          })),
        });
      case "set_rate": {
        if (!canSeeRates) return no(403, "You don't have access to commission rates.");
        if (!isOwner && String(body.userId || "") === String(caller.who.userId)) return no(403, "You can't set your own commission rate — ask an owner to change it.");
        if (!isUuid(body.userId)) return no(400, "Invalid user id.");
        const t = this.members.find((m) => m.userId === String(body.userId).toLowerCase());
        if (!t) return no(400, "That person isn't on your team.");
        let percent: number | null = null;
        if (body.percent !== null && body.percent !== "" && body.percent !== undefined) {
          const n = Number(body.percent);
          if (!Number.isFinite(n) || n < 0 || n > 100) return no(400, "Rate must be between 0 and 100.");
          percent = Math.round(n * 1000) / 1000;
        }
        t.rate = percent;
        return okRes();
      }
      case "list_entries": {
        if (!caller.commissions) return no(403, "You don't have access to commissions.");
        const entries = seesAll ? this.entries : this.entries.filter((e) => e.earnerUserId === caller.who.userId);
        return okRes({
          isOwner, seesAll, canSeeRates, enabled: this.enabled, entries: structuredClone(entries),
          team: canSeeRates ? this.members.map((m) => ({ userId: m.userId, name: m.fullName, email: m.email })) : undefined,
        });
      }
    }
    return no(400, "Unknown action");
  }

  member(id: string) {
    return this.members.find((m) => m.userId === id)!;
  }
  saves(action = "set_rate") {
    return this.calls.filter((c) => c.action === action).map((c) => c.body);
  }
}

/** What a jsonb column gives back: object keys shortest first, then alphabetical, never the order written. */
function jsonb<T>(v: T): T {
  if (Array.isArray(v)) return v.map(jsonb) as T;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonb((v as Record<string, unknown>)[k])])) as T;
  }
  return v;
}

function makeStore(world: World): Store {
  let seq = 0;
  const cards = world.cards;
  const none = () => Promise.resolve();
  return {
    settings: () => Promise.resolve({ on: true, off: [] }),
    setOff: none,
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: none,
    closeChats: none,
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const now = new Date().toISOString();
      const row = { id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: now, updated_at: now, ...jsonb(structuredClone(p)) } as ProposalRow;
      cards.set(id, row);
      return Promise.resolve(row);
    },
    getProposal: (c, id) => { const r = cards.get(id); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, id, patch, when, at) => {
      const r = cards.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, jsonb(structuredClone(patch)));
      return Promise.resolve(r);
    },
    addProposalCost: none,
    proposals: () => Promise.resolve([...cards.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => cards.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve(null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(false),
    forgetMemory: () => Promise.resolve(false),
  };
}

const quietWallet = (): Deps["wallet"] => ({
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
});

/** One person's turn. `read` is the areas they read: "all", or a list (Jack's own and the route's). */
function turn(world: World, o: { who?: Who; read?: string[] | "all"; off?: string[] } = {}) {
  const who = o.who ?? OWNER;
  const store = world.store ?? (world.store = makeStore(world));
  const read = o.read ?? "all";
  const can = (a: string) => read === "all" || read.includes(a);
  const caller: Caller = { who, team: can("settings_team"), commissions: can("commissions") };
  // jack-agent/index.ts adds the account to every call an operator makes, and that is never stripped.
  const asTenant = who.operatorEmail ? { targetClientId: who.clientId } : {};
  const deps: Deps = {
    env: () => undefined,
    store,
    portal: (action, body) => Promise.resolve(world.route("portal-settings", action, { ...body, ...asTenant }, caller)),
    call: (fn, action, body) => Promise.resolve(world.route(fn, action, { ...body, ...asTenant }, caller)),
    wallet: quietWallet(),
    fetch: () => { throw new Error("Claude isn't called in these tests"); },
    canRead: can,
    canEdit: can,
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (text) => Promise.resolve(`h${text.length}:${text.slice(0, 60)}`),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
  };
  const s: TurnState = { who, chatId: "chat1", off: o.off ?? [], proposalIds: [] };
  return { deps, s, who };
}

const TOOL = "propose_commission_rate";
const lastCard = (world: World) => [...world.cards.values()].at(-1)!;
const approve = (deps: Deps, who: Who, p: ProposalRow) => handleProposalApprove(deps, who, { id: p.id, hash: p.shown_hash });
const undo = (deps: Deps, who: Who, p: ProposalRow) => handleProposalUndo(deps, who, { id: p.id });
const tool = (deps: Deps, s: TurnState, input: unknown) => runTool(deps, s, TOOL, input);
const ask = (person: string, percent: number, clear = false) => ({ person, percent, clear });

/** Makes Dale's card (5% to 7% unless said) as the owner, and returns it. */
async function daleCard(w: World, input = ask("Dale", 7)) {
  const t = turn(w);
  const out = await tool(t.deps, t.s, input);
  assert(!out.isError, out.content);
  return lastCard(w);
}

/** No rate or dollar figure: for titles, results and failures, which more people read than the card. */
const FIGURE = /\d+(\.\d+)?\s*%|\$\s?\d/;

/** What Approve runs: the payload without its nonce, which is there only to make the hash unguessable. */
const runOf = (p: ProposalRow) => {
  const { nonce, ...run } = p.payload;
  assert(isUuid(nonce), `the payload's nonce: ${nonce}`);
  return run;
};
/** index.ts's own deps.hash: SHA-256 of the text, with no key. */
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ── The piece's shape ─────────────────────────────────────────────────────────────────────────────

Deno.test("the piece: one strict tool named propose_, inside the strict budget; the card is private and checked from a live list", () => {
  const defs = commissionsPiece.tools.map((t) => t.def);
  assertEquals(defs.map((d) => d.name), [TOOL]);
  assertEquals(strictCost(defs), { tools: 1, optional: 0, unions: 0 });
  const schema = defs[0].input_schema;
  assertEquals(schema.additionalProperties, false);
  assertEquals([...schema.required].sort(), Object.keys(schema.properties).sort());
  const text = JSON.stringify(schema);
  assert(!/anyOf|nullable|"type":\[/.test(text), text);
  const t = commissionsPiece.tools[0];
  assertEquals([t.switchKey, t.proposesChange, !!t.customerWords], ["commissions", true, false]);
  assertEquals(t.needs, [{ area: "settings_team", level: "view" }]);
  // The card's kind, with the area prefix, registered once.
  assertEquals(commissionsPiece.kinds.map((k) => k.kind), [COMMISSION_KIND]);
  assert(COMMISSION_KIND.startsWith("commission"));
  assertEquals(PIECE_KINDS.get(COMMISSION_KIND), rateKind);
  const p = {} as ProposalRow;
  assertEquals([rateKind.private, rateKind.areas(p), rateKind.readAreas!(p), rateKind.switches(p)], [true, [], ["settings_team"], ["commissions"]]);
  assertEquals(rateKind.operatorHidden, ["rate", "ledger"]);
  assertEquals(COMMISSION_OPERATOR_HIDDEN, ["rate", "ledger"]);
  // The never-list: no tool for who sees rates or payouts, approving, paying out, or a line's amount.
  assert(!/grant|access|pay|approve|adjust|split|entry|compute/i.test(defs.map((d) => d.name).join(" ")));
});

Deno.test("offered: with Team at view and the switch on; not without them, and not after a customer's words", () => {
  const w = new World();
  const has = (o: Parameters<typeof turn>[1], words = false) => {
    const t = turn(w, o);
    t.s.customerWordsRead = words;
    return toolsFor(t.deps, t.s).some((d) => d.name === TOOL);
  };
  assert(has({ read: ["jack", "settings_team"] }));
  assert(!has({ read: ["jack", "commissions"] }), "Team at view is the screen the rate box is on");
  assert(!has({ off: ["commissions"] }));
  assert(!has({}, true), "a customer's words can't put a rate card in front of anyone");
});

// ── propose_commission_rate ───────────────────────────────────────────────────────────────────────

Deno.test("a card: Dale from 5% to 7%, built from the live list; Claude hears his name and the new rate, nothing else", async () => {
  const w = new World();
  const t = turn(w);
  const out = await tool(t.deps, t.s, ask("dale", 7));
  assert(!out.isError, out.content);
  const a = JSON.parse(out.content);
  assertEquals([a.shown, a.person, a.newRate], [true, "Dale Smith", "7%"]);
  // Not the old rate, nobody else's, no email, no ledger figure.
  assert(!/\b5\b|\b2\b|\b4\b|\$/.test(out.content), out.content);
  assert(!out.content.includes("@") && !leaksContactDetails(out.content), out.content);
  assert(a.note.includes("past sales"), a.note);

  const p = lastCard(w);
  assertEquals(t.s.proposalIds, [p.id]);
  assertEquals([p.kind, p.status, p.title], [COMMISSION_KIND, "ready", "Change a team member's commission rate"]);
  assert(!FIGURE.test(p.title) && !p.title.includes("Dale"), "the title names nobody and no figure");
  assertEquals(runOf(p), { userId: DALE_ID, percent: 7, from: 5 });
  assert(p.shown_hash, "the card is hashed, so Approve runs what was shown");
  assertEquals(p.preview.member, { name: "Dale Smith", deactivated: false });
  assertEquals(p.preview.rate, { from: 5, to: 7, fromWords: "5%", toWords: "7%", note: null });
  assert(p.preview.notes[0].includes("re-prices Dale Smith's lines that aren't approved yet, past sales included"), p.preview.notes[0]);
  assertEquals(p.preview.route, { page: "settings", sub: "team" });
  // A tool reads and writes one card. Nothing was saved.
  assertEquals(w.calls.map((c) => c.action), ["list", "list_entries"]);
  assertEquals(w.member(DALE_ID).rate, 5);
});

Deno.test("the ledger line: what the next compute prices again, for someone who sees every payout", async () => {
  const w = new World();
  const p = await daleCard(w);
  // o1 (priced) and o6 (no sale amount yet). Not o2 (an approved line on that sale), o3 (changed by hand),
  // o4 (paid), o5 (Rick's), o7 (a clawback) or o8 (excluded).
  assertEquals(p.preview.ledger, {
    lines: 2,
    say: "That's up to 2 lines not yet approved. Together they come to $50 now, and about $70 at the new rate. 1 of them has no sale amount yet, so the new figure leaves it out.",
  });
  // No customer from list_entries anywhere on the card.
  assert(!JSON.stringify(p.preview).includes("Jane Buyer"));

  assertEquals(ledgerFor(w.entries, DALE_ID, null).say, "That's up to 2 lines not yet approved. Together they come to $50 now, and with no rate they would show no amount.");
  assertEquals(ledgerFor([entry("x", "o9", DALE_ID, "pending")], DALE_ID, 10).say, "That's up to 1 line not yet approved. It comes to $50 now, and about $100 at the new rate.");
  assertEquals(ledgerFor([entry("x", "o9", DALE_ID, "pending", { amountCents: null, baseCents: null })], DALE_ID, 10).say,
    "That's up to 1 line not yet approved. It shows no amount now. It has no sale amount yet, so I can't work out the new figure.");
  assertEquals(ledgerFor([], DALE_ID, 7), { lines: 0, say: "None of their lines are waiting to be approved right now." });
  // The earner id is compared without case.
  assertEquals(ledgerFor([entry("x", "o9", DALE_ID.toUpperCase(), "pending")], DALE_ID, 7).lines, 1);
});

Deno.test("the ledger line needs every payout: someone who sees only their own gets the general sentence; tracking off says so", async () => {
  const w = new World();
  const pam = turn(w, { who: PAM });
  assert(!(await tool(pam.deps, pam.s, ask("Dale", 7))).isError);
  const p = lastCard(w);
  assertEquals(p.preview.ledger, null);
  assert(p.preview.notes[0].includes("past sales included"));

  const w2 = new World();
  const noReport = turn(w2, { read: ["jack", "settings_team"] });
  assert(!(await tool(noReport.deps, noReport.s, ask("Dale", 7))).isError);
  assertEquals(w2.calls.map((c) => c.action), ["list"], "no Commissions access, no report read");
  assertEquals(lastCard(w2).preview.ledger, null);

  const w3 = new World();
  w3.enabled = false;
  const p3 = await daleCard(w3);
  assertEquals(p3.preview.ledger, null);
  assert(p3.preview.notes.includes(COMM_SAID.off));

  // A report that can't be read leaves the line off; the card still goes up.
  const w4 = new World();
  w4.answer.list_entries = { status: 0, data: null };
  assertEquals((await daleCard(w4)).preview.ledger, null);
});

Deno.test("refused before any card: an operator, no rate access, an owner row, yourself, a bad rate", async () => {
  // An operator: refused before anything is read.
  const w = new World();
  const op = turn(w, { who: OPERATOR });
  // Not offered to the team at all (ToolSpec noOperators), and the tool itself still refuses if reached.
  assertEquals((await tool(op.deps, op.s, ask("Dale", 7))).isError, true);
  assertEquals(await PIECE_TOOLS.get(TOOL)!.run(op.deps, op.s, ask("Dale", 7)), { content: COMM_SAID.operator, isError: true });
  assertEquals(w.calls, []);

  const cases: [Who, unknown, string][] = [
    [RICK, ask("Dale", 7), COMM_SAID.noRates],
    [OWNER, ask("Mike", 7), COMM_SAID.ownerRow],
    [OWNER, ask("Mike Owner", 0, true), COMM_SAID.ownerRow],
    [PAM, ask("Pam Office", 9), COMM_SAID.self],
    // The route's own self check compares ids as typed. Jack's doesn't.
    [{ ...PAM, userId: PAM_ID.toUpperCase() }, ask("Pam", 9), COMM_SAID.self],
    [OWNER, ask("Dale", 150), COMM_SAID.range],
    [OWNER, ask("Dale", -1), COMM_SAID.range],
    [OWNER, { person: "Dale", percent: "seven", clear: false }, COMM_SAID.range],
    [OWNER, ask("  ", 7), COMM_SAID.who],
  ];
  for (const [who, input, said] of cases) {
    const w2 = new World();
    const t = turn(w2, { who });
    const out = await tool(t.deps, t.s, input);
    assertEquals([out.isError, out.content], [true, said], JSON.stringify(input));
    assertEquals(w2.cards.size, 0);
    assertEquals(w2.saves(), []);
  }
});

Deno.test("names: an unknown or shared name goes back to Claude with names only, never an email or a rate", async () => {
  const w = new World();
  const t = turn(w);
  const out = await tool(t.deps, t.s, ask("Zed", 7));
  assert(out.isError);
  assert(out.content.startsWith(`There's no one on your team called "Zed".`), out.content);
  assert(out.content.includes("Dale Smith, Pam Office, Rick Sales, Dana Lee"), out.content);
  assert(!out.content.includes("Mike Owner"), "owners have no rate");
  assert(!out.content.includes("@") && !leaksContactDetails(out.content) && !FIGURE.test(out.content), out.content);

  w.members.push({ userId: "0b000000-0000-4000-8000-0000000000b2", fullName: "Dale Jones", email: "dj@ridgeline.example", role: "user", title: "sales_rep", rate: 3, fullAccess: false, seesAll: false, banned: false });
  const two = await tool(t.deps, t.s, ask("Dale", 7));
  assert(two.isError && two.content.startsWith(`More than one person on your team is called "Dale".`), two.content);
  // The full name still finds one.
  assert(!(await tool(t.deps, t.s, ask("dale  SMITH", 7))).isError);
  assertEquals(lastCard(w).payload.userId, DALE_ID);
  assertEquals(w.saves(), []);
});

Deno.test("no change, no card: the rate they already have; a read that fails is said, never guessed", async () => {
  const w = new World();
  const t = turn(w);
  assertEquals(JSON.parse((await tool(t.deps, t.s, ask("Dale", 5))).content), { shown: false, note: COMM_SAID.same });
  assertEquals(JSON.parse((await tool(t.deps, t.s, ask("Dana", 0, true))).content), { shown: false, note: COMM_SAID.sameClear });
  assertEquals(w.cards.size, 0);

  w.answer.list = { status: 500, data: { error: "Couldn't load your team. Please try again." } };
  assertEquals(await tool(t.deps, t.s, ask("Dale", 7)), { content: SAID.readFailed, isError: true });
  w.answer.list = no(403, "You don't have access to the team list.");
  assertEquals(await tool(t.deps, t.s, ask("Dale", 7)), { content: "You don't have access to the team list.", isError: true });
  assertEquals(w.cards.size, 0);
});

Deno.test("deactivated: a switched-off login can still get a rate, as on the Team screen, and the card says so", async () => {
  const w = new World();
  const p = await daleCard(w, ask("Dana", 3));
  assertEquals(runOf(p), { userId: DANA_ID, percent: 3, from: null });
  assertEquals(p.preview.rate.fromWords, "No rate");
  assert(p.preview.notes.includes("Dana Lee's login is switched off."));
});

// ── Approve ───────────────────────────────────────────────────────────────────────────────────────

Deno.test("Approve runs exactly the card: the team read again, then one set_rate with its userId and percent", async () => {
  const w = new World();
  const p = await daleCard(w);
  w.calls = [];
  const { deps } = turn(w);
  const r = await approve(deps, OWNER, p);
  assertEquals([r.status, (r.body.proposal as Any).status], [200, "applied"]);
  assertEquals(w.calls.map((c) => c.action), ["list", "set_rate"]);
  assertEquals(w.saves(), [{ userId: DALE_ID, percent: 7 }]);
  assertEquals(w.member(DALE_ID).rate, 7);
  const row = w.cards.get(p.id)!;
  assertEquals(row.result, { rates: 1, reports: [] });
  assertEquals(row.undo, { userId: DALE_ID, from: 5, to: 7 });
  assertEquals(row.failure, null);
  assertEquals((r.body.proposal as Any).canUndo, true);
  // A second press finds it already run.
  assertEquals((await approve(deps, OWNER, row)).status, 409);
  assertEquals(w.saves().length, 1);
});

Deno.test("Approve refuses, and sends nothing, when what the card showed has moved", async () => {
  const moves: [string, (w: World) => void, string, Who?][] = [
    ["the rate changed by hand", (w) => { w.member(DALE_ID).rate = 6; }, COMM_SAID.moved],
    ["the rate cleared by hand", (w) => { w.member(DALE_ID).rate = null; }, COMM_SAID.moved],
    ["he left the team", (w) => { w.members = w.members.filter((m) => m.userId !== DALE_ID); }, COMM_SAID.notOnTeam],
    ["he became an owner", (w) => { w.member(DALE_ID).role = "owner"; }, COMM_SAID.ownerRow],
    ["the asker lost full access", (w) => { w.member(PAM_ID).fullAccess = false; }, COMM_SAID.noRates, PAM],
    ["the team can't be read", (w) => { w.answer.list = { status: 0, data: null }; }, COMM_SAID.readTeam],
  ];
  for (const [what, move, said, asker] of moves) {
    const w = new World();
    const maker = turn(w, { who: asker ?? OWNER });
    assert(!(await tool(maker.deps, maker.s, ask("Dale", 7))).isError, what);
    const p = lastCard(w);
    move(w);
    const r = await approve(maker.deps, maker.who, p);
    const row = w.cards.get(p.id)!;
    assertEquals([r.status, row.status, row.failure], [200, "failed", said], what);
    assertEquals(w.saves(), [], what);
    assertEquals([row.undo, row.result], [null, { rates: 0, reports: [] }], what);
    assert(!FIGURE.test(String(row.failure)), what);
  }

  // The asker lost Team at view: the route's own sentence.
  const w = new World();
  const p = await daleCard(w);
  const blind = turn(w, { read: ["jack", "commissions"] });
  await approve(blind.deps, OWNER, p);
  assertEquals(w.cards.get(p.id)!.failure, "You don't have access to the team list. Nothing changed.");
  assertEquals(w.saves(), []);
});

Deno.test("Approve: the switch turned off since stops it; a teammate can't open someone else's rate card", async () => {
  const w = new World();
  const p = await daleCard(w);
  const t = turn(w);
  w.store!.settings = () => Promise.resolve({ on: true, off: ["commissions"] });
  const r = await approve(t.deps, OWNER, p);
  assertEquals([r.status, r.body.error], [403, SENTENCES.switchedOff]);
  w.store!.settings = () => Promise.resolve({ on: true, off: [] });
  // Private: Pam may change rates herself, but this card is the owner's.
  const pam = turn(w, { who: PAM });
  assertEquals((await handleProposalGet(pam.deps, PAM, { id: p.id })).status, 404);
  assertEquals((await approve(pam.deps, PAM, p)).status, 404);
  assertEquals(w.saves(), []);
});

Deno.test("Approve: a refusal from set_rate is said as it is, and nothing was saved", async () => {
  for (const [res, said] of [
    [no(400, "That person isn't on your team."), "That person isn't on your team. Nothing was saved."],
    [no(403, "You can't set your own commission rate — ask an owner to change it."), "You can't set your own commission rate: ask an owner to change it. Nothing was saved."],
    [no(400, "Rate must be between 0 and 100."), "Rate must be between 0 and 100. Nothing was saved."],
  ] as [Res, string][]) {
    const w = new World();
    const p = await daleCard(w);
    w.answer.set_rate = res;
    await approve(turn(w).deps, OWNER, p);
    const row = w.cards.get(p.id)!;
    assertEquals([row.status, row.failure, row.undo], ["failed", said, null]);
    assertEquals(w.saves().length, 1, "sent once");
  }
});

Deno.test("Approve: a lost answer is never sent again; the team, read again, decides", async () => {
  // Landed, answer lost: applied, with Undo.
  const w = new World();
  const p = await daleCard(w);
  w.answer.set_rate = (b, c) => { w.commissions("set_rate", b, c); return { status: 0, data: null }; };
  await approve(turn(w).deps, OWNER, p);
  let row = w.cards.get(p.id)!;
  assertEquals([row.status, row.result, row.undo], ["applied", { rates: 1, reports: [] }, { userId: DALE_ID, from: 5, to: 7 }]);
  assertEquals(w.saves().length, 1);

  // Didn't land (a 500): "check before trying again", sent once, and Undo is still there to read and decide.
  const w2 = new World();
  const p2 = await daleCard(w2);
  w2.answer.set_rate = { status: 500, data: { error: "Couldn't save that commission rate. Please try again — if it keeps happening, tell CSM Synergy and mention \"save that commission rate\".", ref: "save that commission rate" } };
  const t2 = turn(w2);
  const r2 = await approve(t2.deps, OWNER, p2);
  row = w2.cards.get(p2.id)!;
  assertEquals(row.status, "partly_applied");
  assertEquals(row.result, { rates: 0, reports: [{ label: p2.title, status: "error", reason: COMM_SAID.unsure }] });
  assertEquals(w2.saves().length, 1);
  assertEquals(w2.member(DALE_ID).rate, 5);
  assertEquals((r2.body.proposal as Any).canUndo, true);
  // Undo reads: the rate is where it was, so nothing is sent and the card is done.
  delete w2.answer.set_rate;
  await undo(t2.deps, OWNER, row);
  row = w2.cards.get(p2.id)!;
  assertEquals([row.status, row.result.undo.restored], ["undone", 1]);
  assertEquals(w2.saves().length, 1);

  // Lost, and the read after it fails too.
  const w3 = new World();
  const p3 = await daleCard(w3);
  w3.answer.set_rate = { status: 0, data: null };
  let reads = 0;
  w3.answer.list = (b, c) => (++reads === 1 ? w3.commissions("list", b, c) : { status: 0, data: null });
  await approve(turn(w3).deps, OWNER, p3);
  assertEquals([w3.cards.get(p3.id)!.status, w3.saves().length], ["partly_applied", 1]);

  // A worker that dies mid-send still leaves Undo: it's written before the send.
  const w4 = new World();
  const p4 = await daleCard(w4);
  w4.answer.set_rate = () => { throw new Error("worker died"); };
  await approve(turn(w4).deps, OWNER, p4);
  assertEquals(w4.cards.get(p4.id)!.undo, { userId: DALE_ID, from: 5, to: 7 });
});

Deno.test("Approve: a card that holds nothing to run can't be approved", async () => {
  const w = new World();
  const t = turn(w);
  const p = await w.store!.insertProposal({ client_id: "builder-a", user_id: OWNER_ID, kind: COMMISSION_KIND, status: "ready", title: "x", payload: { userId: DALE_ID, percent: 5, from: 5 }, shown_hash: "h" });
  const r = await handleProposalApprove(t.deps, OWNER, { id: p.id, hash: "h" });
  assertEquals([r.status, r.body.error], [409, "Nothing would change, so there's nothing to approve."]);
  const p2 = await w.store!.insertProposal({ client_id: "builder-a", user_id: OWNER_ID, kind: COMMISSION_KIND, status: "ready", title: "x", payload: { userId: DALE_ID, percent: 250, from: 5 }, shown_hash: "h" });
  assertEquals((await handleProposalApprove(t.deps, OWNER, { id: p2.id, hash: "h" })).status, 409);
  assertEquals(w.saves(), []);
});

// ── Undo ──────────────────────────────────────────────────────────────────────────────────────────

Deno.test("Undo puts the old rate back while the rate still holds Jack's value", async () => {
  const w = new World();
  const p = await daleCard(w);
  const t = turn(w);
  await approve(t.deps, OWNER, p);
  w.calls = [];
  const r = await undo(t.deps, OWNER, w.cards.get(p.id)!);
  const row = w.cards.get(p.id)!;
  assertEquals([r.status, row.status, row.result.undo], [200, "undone", { restored: 1, removed: 0, failed: 0, reports: [] }]);
  assertEquals(w.calls.map((c) => c.action), ["list", "set_rate"]);
  assertEquals(w.saves(), [{ userId: DALE_ID, percent: 5 }]);
  assertEquals(w.member(DALE_ID).rate, 5);

  // From no rate: Undo blanks it again.
  const w2 = new World();
  const p2 = await daleCard(w2, ask("Dana", 3));
  const t2 = turn(w2);
  await approve(t2.deps, OWNER, p2);
  await undo(t2.deps, OWNER, w2.cards.get(p2.id)!);
  assertEquals(w2.saves(), [{ userId: DANA_ID, percent: 3 }, { userId: DANA_ID, percent: null }]);
  assertEquals(w2.member(DANA_ID).rate, null);
});

Deno.test("Undo leaves a rate someone changed since, and says so; one already back counts as back", async () => {
  const cases: [string, (w: World) => void, Any, number][] = [
    ["changed by hand", (w) => { w.member(DALE_ID).rate = 8; }, { restored: 0, removed: 0, failed: 0, reports: [{ label: "Change a team member's commission rate", status: "changed", reason: COMM_SAID.changedSince }] }, 8],
    ["he left", (w) => { w.members = w.members.filter((m) => m.userId !== DALE_ID); }, { restored: 0, removed: 0, failed: 0, reports: [{ label: "Change a team member's commission rate", status: "gone", reason: COMM_SAID.goneUndo }] }, -1],
    ["he's an owner now", (w) => { w.member(DALE_ID).role = "owner"; }, { restored: 0, removed: 0, failed: 0, reports: [{ label: "Change a team member's commission rate", status: "changed", reason: COMM_SAID.ownerNow }] }, 7],
    ["put back by hand", (w) => { w.member(DALE_ID).rate = 5; }, { restored: 1, removed: 0, failed: 0, reports: [] }, 5],
  ];
  for (const [what, move, want, rate] of cases) {
    const w = new World();
    const p = await daleCard(w);
    const t = turn(w);
    await approve(t.deps, OWNER, p);
    move(w);
    await undo(t.deps, OWNER, w.cards.get(p.id)!);
    const row = w.cards.get(p.id)!;
    assertEquals([row.status, row.result.undo], ["undone", want], what);
    assertEquals(w.saves().length, 1, `${what}: nothing sent back`);
    if (rate >= 0) assertEquals(w.member(DALE_ID).rate, rate, what);
    assert(!FIGURE.test(JSON.stringify(row.result)), what);
  }
});

Deno.test("Undo's lost answer: read again, never sent blind; until it's known, the card stays undoable", async () => {
  const w = new World();
  const p = await daleCard(w);
  const t = turn(w);
  await approve(t.deps, OWNER, p);
  w.answer.set_rate = { status: 0, data: null };
  await undo(t.deps, OWNER, w.cards.get(p.id)!);
  let row = w.cards.get(p.id)!;
  assertEquals([row.status, row.result.undo], ["applied", { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: COMM_SAID.tryAgain }] }]);
  assertEquals(w.saves().length, 2);
  // The next press reads first, finds Jack's value, and sends it once.
  delete w.answer.set_rate;
  await undo(t.deps, OWNER, row);
  row = w.cards.get(p.id)!;
  assertEquals([row.status, w.member(DALE_ID).rate, w.saves().length], ["undone", 5, 3]);

  // Landed with its answer lost: the read after it says it's back.
  const w2 = new World();
  const p2 = await daleCard(w2);
  const t2 = turn(w2);
  await approve(t2.deps, OWNER, p2);
  w2.answer.set_rate = (b, c) => { w2.commissions("set_rate", b, c); return { status: 504, data: null }; };
  await undo(t2.deps, OWNER, w2.cards.get(p2.id)!);
  assertEquals([w2.cards.get(p2.id)!.status, w2.saves().length], ["undone", 2]);

  // A team that can't be read: nothing sent, try again.
  const w3 = new World();
  const p3 = await daleCard(w3);
  const t3 = turn(w3);
  await approve(t3.deps, OWNER, p3);
  w3.answer.list = { status: 0, data: null };
  await undo(t3.deps, OWNER, w3.cards.get(p3.id)!);
  assertEquals([w3.cards.get(p3.id)!.status, w3.cards.get(p3.id)!.result.undo.reports[0].reason, w3.saves().length], ["applied", COMM_SAID.readAgain, 1]);
});

// ── Operators ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("operators: may open a card, never approve or undo it, and never reach set_rate; the figures sit only in the keys taken off for them", async () => {
  const w = new World();
  const p = await daleCard(w);
  const op = turn(w, { who: OPERATOR });
  // Open: private cards stay open to the Structure Studio team.
  const got = await handleProposalGet(op.deps, OPERATOR, { id: p.id });
  assertEquals(got.status, 200);
  // Whether or not agent.ts has taken the hidden keys off yet (operatorHidden), what's left holds no figure,
  // and still says whose rate it is and what a new rate does.
  const preview = (got.body.proposal as Any).preview;
  const rest: Any = Object.fromEntries(Object.entries(preview).filter(([k]) => !COMMISSION_OPERATOR_HIDDEN.includes(k)));
  assert(!FIGURE.test(JSON.stringify(rest)), JSON.stringify(rest));
  assertEquals([rest.member.name, rest.notes.length > 0], ["Dale Smith", true]);
  // Every figure is under those keys: the asker's own view of the same card.
  const asker = ((await handleProposalGet(turn(w).deps, OWNER, { id: p.id })).body.proposal as Any).preview;
  for (const k of COMMISSION_OPERATOR_HIDDEN) assert(k in asker, k);
  assert(FIGURE.test(JSON.stringify(asker.rate)) && FIGURE.test(JSON.stringify(asker.ledger)));

  // Approve: nothing read, nothing saved. Today apply refuses inside the claim, so the card ends failed.
  // Once agent.ts refuses an operator before the claim (leftForIntegration), it answers 403 and the card
  // stays ready for the builder.
  w.calls = [];
  const r = await approve(op.deps, OPERATOR, p);
  const after = w.cards.get(p.id)!;
  if (r.status === 403) assertEquals([r.body.error, after.status], [COMM_SAID.operator, "ready"]);
  else assertEquals([after.status, after.failure], ["failed", COMM_SAID.operator]);
  assertEquals(w.calls, []);

  // Undo of a card the owner approved: refused, and it stays the builder's to undo.
  const w2 = new World();
  const p2 = await daleCard(w2);
  await approve(turn(w2).deps, OWNER, p2);
  const op2 = turn(w2, { who: OPERATOR });
  w2.calls = [];
  const u = await undo(op2.deps, OPERATOR, w2.cards.get(p2.id)!);
  const row = w2.cards.get(p2.id)!;
  assertEquals([row.status, !!row.undo], ["applied", true]);
  if (u.status === 403) assertEquals(u.body.error, COMM_SAID.operator);
  else assertEquals([row.result.undo.failed, row.result.undo.reports[0].reason], [1, COMM_SAID.operator]);
  assertEquals(w2.calls, []);
  assertEquals(w2.member(DALE_ID).rate, 7);

  // The route refuses an operator itself too, whatever Jack does.
  const res = w2.commissions("set_rate", { userId: DALE_ID, percent: 9, targetClientId: "builder-a" }, { who: OWNER, team: true, commissions: true });
  assertEquals(res.status, 403);

  // The activity page carries no figure for anyone: no counts on this card, and a result without numbers.
  const act = await handleActivity(op2.deps, OPERATOR);
  const mine = (act.body.activity as Any[]).find((a) => a.id === p2.id);
  assert(!FIGURE.test(JSON.stringify(mine)), JSON.stringify(mine));
  const teammate = await handleActivity(turn(w2, { who: PAM }).deps, PAM);
  const seen = (teammate.body.activity as Any[]).find((a) => a.id === p2.id);
  assertEquals([seen.private, seen.title], [true, "Change a team member's commission rate"]);
});

Deno.test("the card's hash gives no rate away: a teammate with no rate access can't work both figures out of the activity page", async () => {
  const w = new World();
  const owner = turn(w);
  owner.deps.hash = sha256;
  assert(!(await tool(owner.deps, owner.s, ask("Dale", 7))).isError);
  const p = lastCard(w);
  const stored = w.cards.get(p.id)!.shown_hash!;
  // Rick: Team at view and Jack, no rate access. `list` gives him every userId and no rate.
  const rick = turn(w, { who: RICK });
  const team = (await rick.deps.call("portal-commissions" as Any, "list", {})).data as Any;
  assertEquals([team.canSeeRates, team.members.some((m: Any) => m.commissionPercent !== undefined)], [false, false]);
  // The activity page hands him the hash of someone else's private rate card (and operators get it on
  // every view). Whether or not agent.ts later drops it there, the stored hash must not open.
  const seen = ((await handleActivity(rick.deps, RICK)).body.activity as Any[]).find((a) => a.id === p.id);
  assertEquals(seen.private, true);
  assert(seen.hash === stored || seen.hash == null, String(seen.hash));
  // What anyone reading this code would try: each member, no rate or every whole rate, before and after.
  const rates = [null, ...Array.from({ length: 101 }, (_, i) => i)];
  const found: string[] = [];
  for (const m of team.members as Any[]) {
    if (m.role === "owner") continue;
    for (const from of rates) {
      for (const percent of rates) {
        if (await sha256(JSON.stringify({ userId: m.userId, percent, from })) === stored) found.push(`${m.fullName}: ${from} to ${percent}`);
      }
    }
  }
  assertEquals(found, []);
  // The hash is still the one Approve checks, and it still runs.
  const r = await approve(owner.deps, OWNER, w.cards.get(p.id)!);
  assertEquals([r.status, w.cards.get(p.id)!.status, w.saves()], [200, "applied", [{ userId: DALE_ID, percent: 7 }]]);
});

// ── Zero, no rate, rounding ───────────────────────────────────────────────────────────────────────

Deno.test("0% and no rate read differently on the card, and save as they are", async () => {
  const w = new World();
  const zero = await daleCard(w, ask("Dale", 0));
  assertEquals([zero.payload.percent, zero.preview.rate.toWords, zero.preview.rate.note], [0, "0%", "At 0%, their lines come to $0."]);

  const w2 = new World();
  const t2 = turn(w2);
  const out = JSON.parse((await tool(t2.deps, t2.s, ask("Dale", 0, true))).content);
  assertEquals(out.newRate, "No rate");
  const none = lastCard(w2);
  assertEquals([none.payload.percent, none.preview.rate.toWords], [null, "No rate"]);
  assertEquals(none.preview.rate.note, "With no rate, their lines show no amount, and approving a period leaves those lines out.");
  await approve(t2.deps, OWNER, none);
  assertEquals(w2.saves(), [{ userId: DALE_ID, percent: null }]);
  assertEquals([w2.cards.get(none.id)!.status, w2.member(DALE_ID).rate], ["applied", null]);
});

Deno.test("a rate is a percent from 0 to 100: at the tool, and again at Approve and Undo, whatever the card holds", async () => {
  // The edges stand.
  for (const [pct, to] of [[100, 100], [0, 0], ["7%", 7], [" 6.5 ", 6.5]] as const) {
    const w = new World();
    const p = await daleCard(w, { person: "Dale", percent: pct as number, clear: false });
    assertEquals([pct, p.payload.percent], [pct, to]);
  }
  // Past them, or not a plain number, nothing is made.
  for (const bad of [100.0001, 101, -0.0001, -5, Number.NaN, Number.POSITIVE_INFINITY, "150%", "1e2", "-3", "seven", null]) {
    const w = new World();
    const t = turn(w);
    const out = await tool(t.deps, t.s, { person: "Dale", percent: bad, clear: false });
    assertEquals([String(bad), out.isError, out.content], [String(bad), true, COMM_SAID.range]);
    assertEquals([String(bad), w.cards.size, w.saves().length], [String(bad), 0, 0]);
  }
  // A card holding a rate past them (written some other way) is never run, and set_rate never sees it.
  for (const percent of [100.5, -1, 1000]) {
    const w = new World();
    const t = turn(w);
    const p = await w.store!.insertProposal({ client_id: "builder-a", user_id: OWNER_ID, kind: COMMISSION_KIND, status: "ready", title: "x", payload: { userId: DALE_ID, percent, from: 5, nonce: crypto.randomUUID() }, shown_hash: "h" });
    const r = await handleProposalApprove(t.deps, OWNER, { id: p.id, hash: "h" });
    assertEquals([percent, r.status, r.body.error], [percent, 409, "There's nothing to change on that one."]);
    assertEquals([percent, w.saves()], [percent, []]);
  }
  {
    // An Undo record past them puts nothing back.
    const w = new World();
    const t = turn(w);
    const p = await w.store!.insertProposal({ client_id: "builder-a", user_id: OWNER_ID, kind: COMMISSION_KIND, status: "applied", title: "x", payload: { userId: DALE_ID, percent: 7, from: 5, nonce: crypto.randomUUID() }, undo: { userId: DALE_ID, from: 250, to: 7 }, shown_hash: "h" });
    await undo(t.deps, OWNER, p);
    assertEquals(w.saves(), []);
    assertEquals(w.member(DALE_ID).rate, 5);
  }
});

Deno.test("rates round as the route stores them, so the checks at Approve and Undo agree", async () => {
  const w = new World();
  w.member(DALE_ID).rate = 5.125;
  const p = await daleCard(w, ask("Dale", 6.12345));
  assertEquals(runOf(p), { userId: DALE_ID, percent: 6.123, from: 5.125 });
  const t = turn(w);
  await approve(t.deps, OWNER, p);
  assertEquals([w.cards.get(p.id)!.status, w.member(DALE_ID).rate], ["applied", 6.123]);
  await undo(t.deps, OWNER, w.cards.get(p.id)!);
  assertEquals([w.cards.get(p.id)!.status, w.member(DALE_ID).rate], ["undone", 5.125]);
});

// ── Contact details ───────────────────────────────────────────────────────────────────────────────

Deno.test("no contact detail reaches Claude: every member's email is in `list`, and none is in any answer", async () => {
  const w = new World();
  // A name that is really an email, as a member with no name set might carry.
  w.members.push({ userId: "0b000000-0000-4000-8000-0000000000b3", fullName: "sam@ridgeline.example", email: "sam@ridgeline.example", role: "user", title: "sales_rep", rate: 1, fullAccess: false, seesAll: false, banned: false });
  const t = turn(w);
  const outs = [
    await tool(t.deps, t.s, ask("Dale", 7)),
    await tool(t.deps, t.s, ask("Zed", 7)),
    await tool(t.deps, t.s, ask("Mike", 7)),
    await tool(t.deps, t.s, ask("Dale", 5)),
  ];
  for (const o of outs) {
    assert(!o.content.includes("@") && !leaksContactDetails(o.content), o.content);
    assert(!o.content.includes("Jane Buyer"), "no customer from the report");
  }
});
