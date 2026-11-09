// jack-agent: small helpers every piece uses. Imports only types, so any piece can use it without a cycle
// through agent.ts.

import type { Deps, ProposalRow, ToolOut, TurnState } from "./types.ts";

/** A private card (a look-up list, a reply draft or send, an estimate resend) keeps its customer contents
 *  this long, then they are cleared: on any read (agent.ts settled) and by the sweep (378
 *  jack_clear_old_private). */
export const PRIVATE_KEEP_DAYS = 30;
export const PRIVATE_KEEP_MS = PRIVATE_KEEP_DAYS * 86_400_000;
/** The kinds that hold customer contents. 378's jack_clear_old_private names the same list (kinds_test.ts). */
export const PRIVATE_KINDS = ["lookup", "reply_draft", "reply_send", "estimate_resend"] as const;
/** A read or a press that hasn't answered by now died with its worker: no worker lives past 400 s
 *  (agent.ts READ_GIVE_UP_MS is this). */
export const GIVE_UP_MS = 7 * 60_000;

export const hashOf = (deps: Deps, payload: unknown) => deps.hash(JSON.stringify(payload));

/** Words every piece says the same way. */
export const SAID = {
  noAccess: "Changing that isn't part of your access. Ask an owner or admin.",
  noSee: "That isn't part of your access.",
  switchedOff: "That's switched off for Jack on this account. An owner or admin can turn it back on from the Jack tab.",
  readFailed: "I couldn't read that just now, so I won't guess. Please try again.",
  noCrm: "Customer Hub isn't on this account's subscription, so I can't look at customers here.",
  onScreen: "The card is on the person's screen. Tell them what it shows in a sentence. Nothing has changed.",
  onScreenApprove: "The preview is on the person's screen with an Approve button. Tell them what it does in a sentence and ask them to check it. Nothing has changed yet.",
};

export const err = (content: string): ToolOut => ({ content, isError: true });
export const ok = (data: unknown): ToolOut => ({ content: typeof data === "string" ? data : JSON.stringify(data) });

/** Writes one card and puts it under this turn's answer. The ONLY write a tool makes. */
export async function putCard(deps: Deps, s: TurnState, card: {
  kind: string; title: string; preview: unknown; payload?: unknown; status?: "ready" | "applied" | "needs_answers";
  hashed?: boolean;
}): Promise<ProposalRow> {
  const payload = card.payload ?? {};
  const p = await deps.store.insertProposal({
    client_id: s.who.clientId, user_id: s.who.userId, conversation_id: s.chatId, kind: card.kind,
    status: card.status ?? "ready", title: card.title.slice(0, 200), preview: card.preview, payload,
    shown_hash: card.hashed === false ? null : await hashOf(deps, payload),
  });
  s.proposalIds.push(p.id);
  return p;
}

/** A portal answer's error sentence, or a fallback. Routes answer with a plain sentence in `error`. */
export function saidBy(r: { status: number; data: Record<string, unknown> | null }, fallback: string): string {
  const e = r.data && typeof r.data.error === "string" ? r.data.error : "";
  if (r.status === 403 && /subscription|Customer Hub/i.test(e)) return SAID.noCrm;
  if (r.status === 403) return e || SAID.noSee;
  return e || fallback;
}

/** Days between an ISO time and now, whole. Null when there's no time. */
export function daysSince(iso: unknown, now: number): number | null {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/** Cents as a plain dollar figure for Claude: "$8,450". Never cents, so no long digit runs. */
export function dollars(cents: unknown): string | null {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return "$" + (Math.round(n) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
