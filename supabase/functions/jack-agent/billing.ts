// jack-agent: what Jack costs a builder, and the only money it moves (billing_test.ts).
//
// Carolyn, 11-04 (plan section 9, "What builders pay"): Jack is included in any plan, with $50 of credit
// once, then the wallet at $1.50 for every $1 of AI cost, automatic top-up, a balance line under the chat
// and a spending report. This file is the server half. It is NOT a piece: Claude has no tool here, and
// nothing in it can be reached from a tool. agent.ts calls it around a turn:
//
//   before a send or a price list read   sweep, then ensureWelcomeCredit, then gate
//   after the row with the cost is saved settle, then afterCharge when settle says it charged
//
// THE RULES
//   1. JACK NEVER CHARGES A CARD. Its only money writes are deps.wallet.debit (wallet_usage_debit: its
//      own usage, at cost x the jack_ai meter's markup) and deps.wallet.grantOnce (the $50, once ever,
//      under the fixed key jack_welcome). Automatic top-up stays the builder's own: Jack only ASKS the
//      wallet-autotopup door to look (deps.wallet.requestTopup, no amount), and the door decides with its
//      cooldown, its daily cap, the builder's agreement and its switch-off on a decline.
//      These two writes are service-role, a deliberate exception to "every save through a portal route
//      with the person's token": no route a person's token can reach posts a usage debit
//      (wallet_usage_debit is revoked from authenticated, migration 259).
//   2. A CHARGE IS KEYED TO THE ACT: jack:answer:<jack_messages.id>, jack:read:<jack_proposals.id>. A
//      retry, a replay or a second worker can't charge twice: wallet_usage_debit answers a repeated key
//      with the first line.
//   3. DECIDED IN THIS ORDER, first match wins (the phone meters' order, workers/phone-api usageCharge.ts):
//        not_billable  no answer through our fault (timeout, error, spend limit, cut off, refused, no
//                      words), a price list read that failed, nothing spent, or a Structure Studio team
//                      member's turn in view-as (Ahsan 11-06: absorbed). Its cost stays on the row.
//        exempt        metered_exempt, then billing_exempt. The would-be charge is recorded, no wallet line.
//        shadow        the jack_ai meter isn't armed (it ships inactive). The would-be charge is recorded,
//                      so real numbers exist before anyone arms it.
//        charged       wallet_usage_debit posted it.
//        pending       not decided yet (a read failed: charge_micros null), or sent and not confirmed
//                      (charge_micros set). sweep() finishes both, under the same key and amount.
//        failed        one charge over wallet_usage_debit's $500 guard, which would refuse it forever.
//   4. NEVER THROWS. Trouble is logged with codes and ids, never words or figures. Settling a turn never
//      fails it. Only the gate stops one, before it starts: under the floor, or when it can't check the
//      wallet and the meter isn't known to be off (11-09).
//   5. NO MONEY FIGURE goes to Claude or into a reply from HERE: the gate's sentences carry none. Figures
//      reach a person through portal-billing's own `status`, with their own token, behind its Billing
//      check (the portal's JackBalanceLine). Since v2 they reach Claude only through reads.ts
//      look_at_billing, read with the person's own token behind settings_billing and the "billing" switch.

import type { Deps, Wallet, Who } from "./types.ts";

export const JACK_METER = "jack_ai";
/** The welcome credit: $50, once per builder, at its first billable Jack use (Ahsan 11-06: existing
 *  builders too). An ordinary wallet grant, so it shows under Funds and can pay for anything the wallet
 *  pays for. The key is the record that it was given: wallet_transactions is unique on client + key. */
export const WELCOME_CENTS = 5000;
export const WELCOME_KEY = "jack_welcome";
/** _shared/walletLedger.ts JACK_WELCOME_MEMO shows this one grant by name (billing_test pins the two). */
export const WELCOME_MEMO = "Jack welcome credit";
/** What must be spendable to start: $1 for a chat turn, $3 for a price list read (Ahsan 11-06). */
export const FLOOR_CENTS = { chat: 100, sheet: 300 } as const;
/** The balance line says "Low" under this. */
export const LOW_CENTS = 1000;
/** A pending row younger than this may still be settling in the worker that wrote it. */
export const SWEEP_AGE_MS = 60_000;
export const SWEEP_LIMIT = 10;
/** wallet_usage_debit raises on any single charge above this (259's units guard). */
export const MAX_CHARGE_MICROS = 500_000_000;

export type ChargeTable = "jack_messages" | "jack_proposals";
export type ChargeState = "not_billable" | "exempt" | "shadow" | "pending" | "charged" | "failed";
export type Purpose = "chat" | "sheet";

/** One row that cost something: Jack's answer (jack_messages) or a price list read (jack_proposals). */
export interface ChargeRef {
  table: ChargeTable;
  id: string;
  /** What Anthropic charged us for it, from claude.ts. */
  costMicros: number;
  model: string | null;
  /** Whether it gave the person what they asked for. turnOutcome() for a chat turn; read.ok for a read. */
  outcome: "answered" | "failed";
  /** Token counts for the ledger line's `usage` (never shown to a builder). */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface Settled { state: ChargeState; chargeMicros: number | null; billed: boolean }

/** The gate's sentences. Plain, short, and no figures. */
export const WALLET_SAID = {
  empty: "Your wallet is out of credit, so I can't answer right now. Add funds under Settings, Billing.",
  emptySheet: "Your wallet is too low for me to read a price list. Add funds under Settings, Billing.",
  askOwner: "Jack's credit has run out. Ask an owner to add funds.",
  askOwnerSheet: "There isn't enough credit for me to read a price list. Ask an owner to add funds.",
  toppingUp: "Your wallet is low, so I've asked for an automatic top-up. Try again in a minute. If it still stops, check Settings, Billing.",
  toppingUpAsk: "Your wallet is low, so I've asked for an automatic top-up. Try again in a minute. If it still stops, ask an owner.",
  // The floor fails closed once the meter may be armed (11-09): a wallet it can't check isn't a full one.
  unread: "I can't check the wallet for this account right now, so I didn't start. Try again in a minute.",
} as const;

// ── Small pure pieces ─────────────────────────────────────────────────────────────────────────────

/** round(cost x markup), half up, in integer arithmetic: the phone meters' rule (usageCharge.ts
 *  chargeFor) with no ceiling. The markup counts to a thousandth, as numeric(6,3) stores it. */
export function chargeFor(costMicros: number, markup: number): number {
  if (!Number.isFinite(costMicros) || !Number.isFinite(markup)) return 0;
  const milli = Math.round(markup * 1000);
  return Math.floor((Math.max(0, costMicros) * milli + 500) / 1000);
}

/** A markup the meter may charge at: the migration's own check, 1.0 to 10.0. */
export const validMarkup = (m: unknown): m is number => typeof m === "number" && Number.isFinite(m) && m >= 1 && m <= 10;

const armed = (m: { active: boolean; markup: number | null }) => m.active === true && validMarkup(m.markup);

/** What could be spent now, counting the fraction of a cent already owed (wallet_usage_gate's measure). */
export function availableCents(a: { balanceCents: number; heldCents: number; remainderMicros: number }): number {
  return (Number(a.balanceCents) || 0) - (Number(a.heldCents) || 0) - Math.ceil(Math.max(0, Number(a.remainderMicros) || 0) / 10_000);
}

/** The stop reasons runTurn gives a turn that produced no answer the person can use. Anything else
 *  answered (end_turn, stop_sequence, ...). */
const NO_ANSWER = new Set(["timeout", "error", "spend_limit", "rounds", "max_tokens", "refusal", "no_text"]);
export function turnOutcome(stopReason: string | null | undefined): "answered" | "failed" {
  const s = String(stopReason ?? "");
  return !s || NO_ANSWER.has(s) ? "failed" : "answered";
}

export const chargeKey = (table: ChargeTable, id: string) => (table === "jack_messages" ? `jack:answer:${id}` : `jack:read:${id}`);
const refTypeOf = (table: ChargeTable) => (table === "jack_messages" ? "jack_message" as const : "jack_proposal" as const);
/** The ledger line's words (walletLedger.ts shows a jack_ai line by its memo). */
const memoOf = (table: ChargeTable) => (table === "jack_messages" ? "Jack · answer" : "Jack · price list read");

// ── Reads, held for a few seconds per request ─────────────────────────────────────────────────────
// One send reads the meter and the exempt flags up to five times (sweep, welcome, gate, settle, after).
// index.ts makes a wallet per request, so these live only as long as that request, and a background read
// that runs for minutes reads them again after READ_TTL_MS. A failed read is never kept.

const READ_TTL_MS = 30_000;
type Meter = { active: boolean; markup: number | null };
const READS = new WeakMap<Wallet, { meter?: { at: number; v: Meter }; exempt: Map<string, { at: number; v: boolean }> }>();
const cacheOf = (w: Wallet) => {
  let c = READS.get(w);
  if (!c) { c = { exempt: new Map() }; READS.set(w, c); }
  return c;
};

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function meterOf(deps: Deps): Promise<Meter | null> {
  const c = cacheOf(deps.wallet), now = deps.now();
  if (c.meter && now - c.meter.at < READ_TTL_MS) return c.meter.v;
  const m = await attempt(() => deps.wallet.meter());
  if (!m || typeof m !== "object") return null;
  const v = { active: m.active === true, markup: m.markup === null || m.markup === undefined ? null : Number(m.markup) };
  c.meter = { at: now, v };
  return v;
}

async function exemptOf(deps: Deps, clientId: string): Promise<boolean | null> {
  const c = cacheOf(deps.wallet), now = deps.now();
  const hit = c.exempt.get(clientId);
  if (hit && now - hit.at < READ_TTL_MS) return hit.v;
  const e = await attempt(() => deps.wallet.exempt(clientId));
  if (typeof e !== "boolean") return null;
  c.exempt.set(clientId, { at: now, v: e });
  return e;
}

async function say(deps: Deps, e: { code: string; message: string; severity: "error" | "warn" | "info"; clientId: string; context?: Record<string, unknown> }) {
  try {
    await deps.log(e);
  } catch { /* a log that can't be written never stops billing */ }
}

async function mark(deps: Deps, clientId: string, table: ChargeTable, id: string, patch: { charge_state: ChargeState; charge_micros: number | null; wallet_tx_id?: number | null }): Promise<boolean> {
  try {
    await deps.wallet.mark(table, id, patch);
    return true;
  } catch {
    await say(deps, { code: "jack_charge_mark", severity: "warn", clientId, message: "A Jack row's charge state didn't save.", context: { table, row: id, state: patch.charge_state } });
    return false;
  }
}

function askForTopup(deps: Deps, clientId: string): void {
  try {
    deps.wallet.requestTopup(clientId);
  } catch { /* the door is asked again on the next charge or refusal */ }
}

// ── Posting ───────────────────────────────────────────────────────────────────────────────────────

/** Sends one priced charge. The row already says pending with this amount, so a lost answer or a dead
 *  worker leaves it for sweep(), which sends the same key and amount again. */
async function post(deps: Deps, who: Who, r: { table: ChargeTable; id: string; charge: number; cost: number; usage: Record<string, unknown> }): Promise<Settled> {
  const out = await attempt(() => deps.wallet.debit({
    clientId: who.clientId, chargeMicros: r.charge, costMicros: r.cost, refType: refTypeOf(r.table), refId: r.id,
    memo: memoOf(r.table), usage: r.usage, key: chargeKey(r.table, r.id),
  }));
  if (!out || out.ok !== true) {
    await say(deps, { code: "jack_charge_failed", severity: "warn", clientId: who.clientId, message: "A Jack charge didn't post; it stays pending.", context: { table: r.table, row: r.id } });
    return { state: "pending", chargeMicros: r.charge, billed: false };
  }
  await mark(deps, who.clientId, r.table, r.id, { charge_state: "charged", charge_micros: r.charge, wallet_tx_id: out.txId ?? null });
  return { state: "charged", chargeMicros: r.charge, billed: true };
}

/** A row the meter is armed for: pending with its price first, then the debit. */
async function charge(deps: Deps, who: Who, table: ChargeTable, id: string, cost: number, markup: number, usage: Record<string, unknown>): Promise<Settled> {
  const amount = chargeFor(cost, markup);
  if (amount > MAX_CHARGE_MICROS) {
    await mark(deps, who.clientId, table, id, { charge_state: "failed", charge_micros: amount });
    await say(deps, { code: "jack_charge_too_big", severity: "error", clientId: who.clientId, message: "A Jack charge is over the $500 guard and wasn't sent.", context: { table, row: id } });
    return { state: "failed", chargeMicros: amount, billed: false };
  }
  await mark(deps, who.clientId, table, id, { charge_state: "pending", charge_micros: amount });
  return await post(deps, who, { table, id, charge: amount, cost, usage });
}

// ── What agent.ts calls ───────────────────────────────────────────────────────────────────────────

/** Bills one row. Call it once the row is written (addMessage, addProposalCost). Never throws. */
export async function settle(deps: Deps, who: Who, ref: ChargeRef): Promise<Settled> {
  try {
    const table = ref.table, id = String(ref.id ?? "");
    const cost = Math.max(0, Math.round(Number(ref.costMicros) || 0));
    if ((table !== "jack_messages" && table !== "jack_proposals") || !id) return { state: "pending", chargeMicros: null, billed: false };
    const final = async (state: ChargeState, micros: number | null): Promise<Settled> => {
      await mark(deps, who.clientId, table, id, { charge_state: state, charge_micros: micros });
      return { state, chargeMicros: micros, billed: false };
    };
    if (ref.outcome !== "answered" || who.operatorEmail || cost === 0) return await final("not_billable", null);

    // Nothing has been sent when a read fails, so sweep() can decide the row from scratch later.
    const deferred = async () => {
      await say(deps, { code: "jack_charge_deferred", severity: "info", clientId: who.clientId, message: "A Jack charge waits for a wallet read.", context: { table, row: id } });
      return await final("pending", null);
    };
    const exempt = await exemptOf(deps, who.clientId);
    const meter = await meterOf(deps);
    const would = meter && validMarkup(meter.markup) ? chargeFor(cost, meter.markup) : null;
    if (exempt === true) return await final("exempt", would);
    // While the meter is off nothing moves for anyone, so an unread exempt flag changes nothing: a shadow
    // now. Left pending, a turn taken before the meter was armed would be charged by the first sweep after.
    if (meter !== null && !armed(meter)) return await final("shadow", would);
    if (exempt === null || meter === null) return await deferred();
    const usage = {
      model: ref.model ?? null,
      ...(ref.tokens ? { input: ref.tokens.input, output: ref.tokens.output, cache_read: ref.tokens.cacheRead, cache_write: ref.tokens.cacheWrite } : {}),
    };
    return await charge(deps, who, table, id, cost, meter.markup as number, usage);
  } catch {
    await say(deps, { code: "jack_charge_fault", severity: "error", clientId: who.clientId, message: "Billing a Jack row failed.", context: { table: ref?.table ?? null, row: ref?.id ?? null } });
    return { state: "pending", chargeMicros: null, billed: false };
  }
}

/** Finishes this builder's rows still pending after a minute, up to ten, oldest first. A row that was
 *  sent goes again under the SAME key and amount, so one that did post comes back as the first line and
 *  nothing is charged twice. While the meter is off or the builder is exempt such a row waits rather
 *  than being written off, because its debit may already be on the ledger. A row that was never priced
 *  (a read failed) is decided now. Stops at the first debit that doesn't answer. Never throws. */
export async function sweep(deps: Deps, who: Who): Promise<{ looked: number; charged: number }> {
  let looked = 0, charged = 0;
  try {
    const exempt = await exemptOf(deps, who.clientId);
    if (exempt === null) return { looked, charged };
    const meter = await meterOf(deps);
    if (meter === null) return { looked, charged };
    const on = armed(meter);
    const markup = validMarkup(meter.markup) ? meter.markup : null;
    const rows = await attempt(() => deps.wallet.pending(who.clientId, new Date(deps.now() - SWEEP_AGE_MS).toISOString(), SWEEP_LIMIT));
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, SWEEP_LIMIT)) {
      // A worker near its end leaves the rest for the next send.
      if (deps.budgetMs() < 20_000) break;
      const table = row.table, id = String(row.id ?? "");
      if ((table !== "jack_messages" && table !== "jack_proposals") || !id) continue;
      looked++;
      const priced = Number(row.charge_micros) > 0;
      const cost = Math.max(0, Math.round(Number(row.cost_micros) || 0));
      const usage = { model: row.model ?? null, replay: true };
      if (priced) {
        if (exempt || !on) continue;
        const r = await post(deps, who, { table, id, charge: Math.round(Number(row.charge_micros)), cost, usage });
        if (r.state !== "charged") break;
        charged++;
        continue;
      }
      if (cost === 0) { await mark(deps, who.clientId, table, id, { charge_state: "not_billable", charge_micros: null }); continue; }
      const would = markup !== null ? chargeFor(cost, markup) : null;
      if (exempt) { await mark(deps, who.clientId, table, id, { charge_state: "exempt", charge_micros: would }); continue; }
      if (!on) { await mark(deps, who.clientId, table, id, { charge_state: "shadow", charge_micros: would }); continue; }
      const r = await charge(deps, who, table, id, cost, markup as number, usage);
      if (r.state === "charged") charged++;
      else if (r.state === "pending") break;
    }
  } catch {
    await say(deps, { code: "jack_sweep_fault", severity: "error", clientId: who.clientId, message: "Finishing Jack's pending charges failed.", context: { looked } });
  }
  return { looked, charged };
}

/** Builders get the $50 once ever, at their first billable use. The ledger key makes it once; this set
 *  only saves the call for a builder this worker has already seen granted. */
const GRANTED = new Set<string>();
/** For tests: forget what this worker has seen granted. */
export const forgetGrantsSeen = () => GRANTED.clear();

/** The $50. Call it from send and sheet_start only, before the gate, so a builder's first message is
 *  never refused at $0. Skipped while the meter is off (nothing is billable yet, so no wallet money is
 *  made before Ahsan arms it), for an exempt builder, when a read fails (it tries again next time) and
 *  for a Structure Studio team member in view-as (their turns are absorbed, so they aren't the builder's
 *  first use). "granted" means it is on the ledger, now or from before. Never throws. */
export async function ensureWelcomeCredit(deps: Deps, who: Who): Promise<"granted" | "skipped" | "failed"> {
  try {
    if (who.operatorEmail) return "skipped";
    if (GRANTED.has(who.clientId)) return "granted";
    const meter = await meterOf(deps);
    if (!meter || !armed(meter)) return "skipped";
    if ((await exemptOf(deps, who.clientId)) !== false) return "skipped";
    const ok = await attempt(() => deps.wallet.grantOnce(who.clientId, WELCOME_CENTS, WELCOME_KEY, WELCOME_MEMO));
    if (ok === true) {
      GRANTED.add(who.clientId);
      return "granted";
    }
    await say(deps, { code: "jack_welcome_failed", severity: "warn", clientId: who.clientId, message: "The Jack welcome credit didn't post; it is tried again on the next message." });
    return "failed";
  } catch {
    return "failed";
  }
}

/** May this person start a chat turn or a price list read? Refuses when the meter is armed, the builder
 *  isn't exempt and what they can spend is under the floor. With automatic top-up on, it asks the door
 *  to look and says so. A team member in view-as is never refused: their turn is absorbed.
 *  A read it can't make (11-09, Ahsan: the cautious side): while the meter is known to be off nothing is
 *  billable, so nothing more is read and the turn goes ahead, as before. Otherwise it refuses, in a
 *  sentence: the meter that can't be read may be armed, and a wallet that can't be read may be empty,
 *  and the phone meters' "charge it after" would let a builder with nothing left keep spending.
 *  `canSeeBilling`: canRead("settings_billing"), for whether to point at Billing or at an owner. */
export async function gate(deps: Deps, who: Who, purpose: Purpose, canSeeBilling: boolean): Promise<{ ok: true } | { ok: false; sentence: string; cap: "wallet" }> {
  const go = { ok: true } as const;
  const unread = async (what: string) => {
    await say(deps, { code: "jack_wallet_gate_error", severity: "warn", clientId: who.clientId, message: `The wallet floor couldn't read the ${what}; the turn was stopped.` });
    return { ok: false, sentence: WALLET_SAID.unread, cap: "wallet" } as const;
  };
  try {
    if (who.operatorEmail) return go;
    const meter = await meterOf(deps);
    if (!meter) return await unread("meter");
    if (!armed(meter)) return go;
    const exempt = await exemptOf(deps, who.clientId);
    if (exempt === null) return await unread("exempt flags");
    if (exempt) return go;
    const a = await attempt(() => deps.wallet.account(who.clientId));
    if (!a) return await unread("wallet");
    const floor = purpose === "sheet" ? FLOOR_CENTS.sheet : FLOOR_CENTS.chat;
    if (availableCents(a) >= floor) return go;
    const topup = a.autoTopup === true;
    if (topup) askForTopup(deps, who.clientId);
    await say(deps, { code: "jack_wallet_floor", severity: "info", clientId: who.clientId, message: "Jack stopped at the wallet floor.", context: { purpose, topup } });
    const sentence = topup
      ? (canSeeBilling ? WALLET_SAID.toppingUp : WALLET_SAID.toppingUpAsk)
      : purpose === "sheet"
      ? (canSeeBilling ? WALLET_SAID.emptySheet : WALLET_SAID.askOwnerSheet)
      : (canSeeBilling ? WALLET_SAID.empty : WALLET_SAID.askOwner);
    return { ok: false, sentence, cap: "wallet" };
  } catch {
    return await unread("wallet");
  }
}

/** After a charge: asks the top-up door to look when automatic top-up is on, a threshold is set and what
 *  the builder can spend (balance less held, the door's own measure) is under it. The phone meters' rule
 *  (usageCharge.ts autoTopUps). The door re-reads and decides. True when it asked. Never throws. */
export async function afterCharge(deps: Deps, who: Who): Promise<boolean> {
  try {
    if (who.operatorEmail) return false;
    const meter = await meterOf(deps);
    if (!meter || !armed(meter)) return false;
    if ((await exemptOf(deps, who.clientId)) !== false) return false;
    const a = await attempt(() => deps.wallet.account(who.clientId));
    if (!a || a.autoTopup !== true) return false;
    const threshold = Number(a.thresholdCents);
    if (a.thresholdCents === null || !Number.isFinite(threshold) || threshold <= 0) return false;
    if ((Number(a.balanceCents) || 0) - (Number(a.heldCents) || 0) >= threshold) return false;
    askForTopup(deps, who.clientId);
    return true;
  } catch {
    return false;
  }
}
