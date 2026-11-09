// jack-agent: asking when unsure, and remembering the answer for this builder (memory_test.ts).
//
// Carolyn, 11-04: don't fix the numbers. Jack asks ("I want to make sure I understand. 7 days or 14?"),
// and remembers the answer for that builder, and a person can see and change what it remembers.
//
// THE RULES
//   - Claude never writes memory. Its tool only puts a question card on the screen. A person's press on
//     an option is what answers it.
//   - Values are typed, from one fixed catalogue in this file: whole numbers in a range, or yes/no. The
//     labels are written here, so no text from Claude, a file or a customer ever reaches the prompt
//     through memory.
//   - One answer is for the whole builder, so only an owner or admin (or the Structure Studio team, not
//     wearing someone) makes it stick. Anyone else's pick is used for that one answer and not kept, and
//     the card says so (Ahsan's default, 11-06).
//   - A look-up never falls back to a made-up number: unset means ask.

import type { Deps, MemoryRow, Piece, ProposalRow, Reply, ToolSpec, TurnState, Who } from "./types.ts";
import { err, ok, putCard } from "./common.ts";

export interface MemoryKey {
  key: string;
  kind: "days" | "yesno";
  min?: number;
  max?: number;
  /** The question on the card. */
  ask: string;
  /** Suggested options for a number. */
  options?: number[];
  /** How Claude is told the answer, with {v} for the value. */
  said: (v: unknown) => string;
  /** How the panel shows it. */
  label: string;
}

const yes = (v: unknown) => v === true;

export const MEMORY: MemoryKey[] = [
  {
    key: "quote_quiet_days", kind: "days", min: 1, max: 365, options: [7, 14, 30],
    ask: "When an estimate has gone out and the customer hasn't answered, after how many days does it count as quiet?",
    label: "A sent estimate with no answer counts as quiet after",
    said: (v) => `A sent estimate with no answer counts as quiet after ${v} days.`,
  },
  {
    key: "lead_wait_days", kind: "days", min: 1, max: 60, options: [1, 2, 3],
    ask: "When a new lead comes in and nobody has called or written yet, after how many days should I count them as waiting on you?",
    label: "A new lead nobody has contacted counts as waiting after",
    said: (v) => `A new lead nobody has contacted counts as waiting on the builder after ${v} days.`,
  },
  {
    key: "not_bought_includes_lost", kind: "yesno",
    ask: "When you ask who hasn't bought, should I include leads marked lost?",
    label: "\"Who hasn't bought\" includes leads marked lost",
    said: (v) => (yes(v) ? "\"Who hasn't bought\" includes leads marked lost." : "\"Who hasn't bought\" leaves out leads marked lost."),
  },
  {
    key: "not_bought_includes_past_buyers", kind: "yesno",
    ask: "When you ask who hasn't bought, should I include past buyers who haven't bought again lately?",
    label: "\"Who hasn't bought\" includes past buyers",
    said: (v) => (yes(v) ? "\"Who hasn't bought\" includes past buyers who haven't bought again." : "\"Who hasn't bought\" leaves out anyone who has ever bought."),
  },
  {
    key: "sold_not_scheduled_days", kind: "days", min: 1, max: 120, options: [7, 10, 14],
    ask: "A job sold with no build date yet: after how many days should I call that out?",
    label: "A sold job with no build date counts as late after",
    said: (v) => `A sold job with no build date counts as late after ${v} days.`,
  },
  {
    key: "lot_days", kind: "days", min: 7, max: 1095, options: [90, 180, 365],
    ask: "A building on the lot: after how many days has it been sitting too long?",
    label: "A building on the lot counts as sitting after",
    said: (v) => `A building on the lot counts as sitting too long after ${v} days.`,
  },
  {
    // One answer for both: a follow-up leaves an old price out (drafts.ts, counted from when the estimate
    // was last sent), and Jack won't email an old estimate again (sends.ts, counted from when it was made).
    key: "old_quote_days", kind: "days", min: 7, max: 365, options: [30, 60, 90],
    ask: "How many days old can an estimate's price be before you want to check it first? Past that, I leave the price out of follow-ups and won't email the estimate again.",
    label: "An estimate's price needs checking first when it's older than",
    said: (v) => `An estimate's price needs checking first when it's older than ${v} days. Past that, a follow-up leaves the price out for the rep to check (counted from when the estimate was last sent), and Jack won't email the estimate again (counted from when it was made).`,
  },
];

export const MEMORY_BY_KEY = new Map(MEMORY.map((m) => [m.key, m]));

/** A value the catalogue accepts for this key, or null. */
export function validValue(key: string, v: unknown): number | boolean | null {
  const m = MEMORY_BY_KEY.get(key);
  if (!m) return null;
  if (m.kind === "yesno") return typeof v === "boolean" ? v : null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < (m.min ?? 1) || n > (m.max ?? 3650)) return null;
  return n;
}

/** What Claude is told about this builder, built only from the catalogue's own sentences. */
export function memoryText(memory: Record<string, { value: unknown }>): string {
  const lines = MEMORY.filter((m) => memory[m.key] !== undefined && validValue(m.key, memory[m.key].value) !== null).map((m) => `- ${m.said(memory[m.key].value)}`);
  return lines.length ? ["What this builder told you before (their answers; use them, and don't ask again):", ...lines].join("\n") : "";
}

export function memoryMap(rows: MemoryRow[]): Record<string, { value: unknown; updatedAt: string }> {
  const out: Record<string, { value: unknown; updatedAt: string }> = {};
  for (const r of rows) if (MEMORY_BY_KEY.has(r.key)) out[r.key] = { value: r.value, updatedAt: r.updated_at };
  return out;
}

/** A remembered value for a key, typed, or null when unset. Look-ups call this; unset means ask. */
export function remembered(s: TurnState, key: string): number | boolean | null {
  const m = s.memory?.[key];
  return m === undefined ? null : validValue(key, m.value);
}

/** The sentence a look-up hands back when a number it needs is unset. Claude then asks with the card. */
export const needsAnswer = (key: string) => ({
  needsAnswer: key,
  note: `I don't know this builder's answer for ${key} yet. Ask with ask_to_be_sure (key ${key}) before answering, and don't guess a number.`,
});

const optionsFor = (m: MemoryKey) => (m.kind === "yesno"
  ? [{ value: true, label: "Yes" }, { value: false, label: "No" }]
  : (m.options ?? []).map((n) => ({ value: n, label: `${n} days` })));

const askTool: ToolSpec = {
  def: {
    name: "ask_to_be_sure",
    description: "When you aren't sure what the person means by a number or a choice this builder decides once (when an estimate counts as quiet, whether lost leads count as not bought, and so on), put a question card on their screen with options to press. Their press answers it, and an owner's or admin's answer is remembered for this builder. Use it instead of guessing. Say a short sentence like \"I want to make sure I understand\" with it.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["key"],
      properties: { key: { type: "string", enum: MEMORY.map((m) => m.key) } },
    },
  },
  async run(deps, s, input) {
    // deno-lint-ignore no-explicit-any
    const key = String((input as any)?.key ?? "");
    const m = MEMORY_BY_KEY.get(key);
    if (!m) return err("That isn't something I keep an answer for.");
    const current = s.memory?.[key];
    const p = await putCard(deps, s, {
      kind: "memory", title: m.ask, status: "ready", hashed: false,
      preview: { key, ask: m.ask, kind: m.kind, options: optionsFor(m), min: m.min ?? null, max: m.max ?? null, current: current ? current.value : null },
      payload: { key, basedOn: current ? current.updatedAt : null },
    });
    return ok({ shown: true, card: p.id, note: "The question is on the person's screen with buttons. Ask it in a short sentence and stop: their press answers it, and their answer arrives as their next message." });
  },
};

export const memoryPiece: Piece = {
  name: "memory",
  can: ["Ask when you aren't sure, with ask_to_be_sure: a question card with options, whose answer this builder keeps."],
  rules: ["If a tool says it needs an answer (needsAnswer), ask with ask_to_be_sure for that key and wait. Never make the number up, and never ask again for something this builder already answered."],
  tools: [askTool],
  kinds: [{
    kind: "memory",
    areas: () => [],
    switches: () => [],
    showOnly: true,
  }],
};

/** Whether this person's answer is kept for the whole builder. */
// index.ts gives an operator who isn't wearing anyone the role "owner", and one wearing a person that
// person's role, so this is the same rule for everyone.
export const mayDecideForBuilder = (_who: Who, role: string | null) => role === "owner" || role === "admin";

/** A person pressed an option on a question card. */
export async function handleMemoryPick(deps: Deps, who: Who, role: string | null, payload: { id?: unknown; value?: unknown }): Promise<Reply> {
  const id = String(payload.id ?? "");
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await deps.store.getProposal(who.clientId, id) : null;
  if (!row || row.kind !== "memory") return { status: 404, body: { error: "That isn't here any more." } };
  if (row.status !== "ready") return { status: 409, body: { error: "That's already answered.", proposal: pickView(row) } };
  const key = String(row.payload?.key ?? "");
  const m = MEMORY_BY_KEY.get(key);
  const value = validValue(key, payload.value);
  if (!m || value === null) return { status: 400, body: { error: m && m.kind === "days" ? `Pick a whole number of days from ${m.min} to ${m.max}.` : "Pick one of the options." } };
  const keep = mayDecideForBuilder(who, role);
  let kept = false;
  if (keep) {
    kept = await deps.store.putMemory(who.clientId, key, value, { userId: who.userId, operatorEmail: who.operatorEmail }, row.payload?.basedOn ?? null).catch(() => false);
  }
  const label = m.kind === "yesno" ? (value ? "Yes" : "No") : `${value} days`;
  const moved = await deps.store.updateProposal(who.clientId, id, {
    status: "applied", approved_by: who.userId, approved_by_operator: who.operatorEmail, approved_at: new Date(deps.now()).toISOString(),
    result: { value, label, remembered: kept, notKeptWhy: keep ? (kept ? null : "changed") : "role" },
  }, ["ready"]);
  if (!moved) return { status: 409, body: { error: "That's already answered." } };
  if (kept) await deps.audit("jack_memory", 1, `key=${key} value=${String(value)}`).catch(() => undefined);
  return { status: 200, body: { ok: true, proposal: pickView(moved), say: label } };
}

/** The panel: change or forget what Jack remembers. Owners and admins only. */
export async function handleMemorySet(deps: Deps, who: Who, role: string | null, payload: { key?: unknown; value?: unknown; basedOn?: unknown }): Promise<Reply> {
  if (!mayDecideForBuilder(who, role)) return { status: 403, body: { error: "An owner or admin changes what Jack remembers." } };
  const key = String(payload.key ?? "");
  const value = validValue(key, payload.value);
  if (value === null) return { status: 400, body: { error: "That isn't a value Jack can keep for this." } };
  const basedOn = typeof payload.basedOn === "string" ? payload.basedOn : null;
  const kept = await deps.store.putMemory(who.clientId, key, value, { userId: who.userId, operatorEmail: who.operatorEmail }, basedOn);
  if (!kept) return { status: 409, body: { error: "Someone changed that a moment ago. Here's what it says now.", memory: await memoryList(deps, who) } };
  await deps.audit("jack_memory", 1, `key=${key} value=${String(value)}`).catch(() => undefined);
  return { status: 200, body: { ok: true, memory: await memoryList(deps, who) } };
}

export async function handleMemoryForget(deps: Deps, who: Who, role: string | null, payload: { key?: unknown; basedOn?: unknown }): Promise<Reply> {
  if (!mayDecideForBuilder(who, role)) return { status: 403, body: { error: "An owner or admin changes what Jack remembers." } };
  const key = String(payload.key ?? "");
  if (!MEMORY_BY_KEY.has(key) || typeof payload.basedOn !== "string") return { status: 400, body: { error: "Say which answer." } };
  const gone = await deps.store.forgetMemory(who.clientId, key, payload.basedOn);
  if (!gone) return { status: 409, body: { error: "Someone changed that a moment ago. Here's what it says now.", memory: await memoryList(deps, who) } };
  await deps.audit("jack_memory_forget", 1, `key=${key}`).catch(() => undefined);
  return { status: 200, body: { ok: true, memory: await memoryList(deps, who) } };
}

/** What the "What Jack remembers" panel shows: every key, set or not, in the catalogue's words. */
export async function memoryList(deps: Deps, who: Who) {
  const rows = await deps.store.memory(who.clientId).catch(() => null);
  if (!rows) return null;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const names = await deps.store.names(who.clientId, [...new Set(rows.map((r) => r.set_by).filter(Boolean) as string[])]).catch(() => ({} as Record<string, string>));
  return MEMORY.map((m) => {
    const r = byKey.get(m.key);
    const value = r ? validValue(m.key, r.value) : null;
    return {
      key: m.key, label: m.label, kind: m.kind, min: m.min ?? null, max: m.max ?? null, options: optionsFor(m),
      value, updatedAt: r ? r.updated_at : null,
      setBy: r ? (r.set_by_operator ? `${r.set_by_operator} (Structure Studio team)` : r.set_by ? names[r.set_by] ?? null : null) : null,
    };
  });
}

function pickView(p: ProposalRow) {
  return { id: p.id, kind: p.kind, status: p.status, title: p.title, preview: p.preview, result: p.result, createdAt: p.created_at, expiresAt: p.expires_at, canUndo: false, canRetry: false };
}
