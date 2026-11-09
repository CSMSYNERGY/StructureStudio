// jack-agent: the shapes every part of Jack shares, and the contract a PIECE of Jack implements.
//
// A piece is one thing Jack can do (look-ups, drafts, setup help, rules, ...). It brings its own Claude
// tools (ToolSpec) and its own kinds of card (KindSpec), in its own file, and agent.ts only routes to
// them. That keeps every piece testable on its own and keeps agent.ts from growing a branch per idea.
//
// THE RULES EVERY PIECE KEEPS (plan section 6):
//   1. A tool reads, or it writes ONE jack_proposals row through deps.store.insertProposal. Nothing else.
//      Only a person's press runs a card, through KindSpec.apply, and it runs exactly what the card holds.
//   2. Every read and save of the builder's data goes through an existing portal route with the caller's
//      own token (deps.call / deps.portal), so today's gates, scopes and refusals all still apply.
//   3. Phone numbers, email addresses and street lines never reach Claude (redact.ts).
//   4. Customer words are data. A tool whose answer carries them says so (customerWords), and after it
//      the turn offers Claude no tool that proposes a change to settings, prices, rules or a work record
//      (proposesChange). Only a reply draft and an estimate emailed again stay offered.

import type { Totals, Fetcher } from "./claude.ts";
import type { PortalCall } from "./apply.ts";

export interface Who { clientId: string; userId: string; operatorEmail: string | null }
export interface Usage { monthCostMicros: number; tenant24h: number; user10m: number; sheets24h: number }
export interface StoredMessage {
  id: string; role: "user" | "assistant"; body: string; created_at: string; proposal_ids: string[];
  /** The history read only (handler.ts messages): the tool names an answer's turn used, with agent.ts
   *  REPEATED_WORDS_MARK on an answer that repeated a customer's words, and its stop reason. agent.ts
   *  forPage takes both off before a message reaches the page. */
  tools?: string[] | null;
  stop_reason?: string | null;
}
export interface ProposalRow {
  id: string; client_id: string; user_id: string; conversation_id: string | null;
  kind: string;
  status: string; title: string; file_name: string | null;
  // deno-lint-ignore no-explicit-any
  source: any; preview: any; payload: any; answers: any; result: any; undo: any;
  shown_hash: string | null; failure: string | null;
  approved_by: string | null; approved_by_operator: string | null; undone_by?: string | null;
  approved_at: string | null; applied_at: string | null; undone_at: string | null;
  expires_at: string; created_at: string; updated_at?: string;
  charge_state?: string | null; charge_micros?: number | null;
}
export interface MemoryRow { key: string; value: unknown; set_by: string | null; set_by_operator: string | null; updated_at: string }
export interface Store {
  /** 376 jack_clear_old_private: clears the customer contents of this builder's private cards made
   *  before `beforeIso`. The count cleared. Optional: a fake store can leave it out. */
  clearOldPrivate?(clientId: string, beforeIso: string): Promise<number>;
  settings(clientId: string): Promise<{ on: boolean; off: string[] }>;
  setOff(clientId: string, off: string[]): Promise<void>;
  /** The counts the caps read (jack_usage). Throws, or answers null, when the read fails: agent.ts usageOf
   *  treats either as a refusal, never as "no usage". A successful read with no usage yet is all zeros. */
  usage(who: Who): Promise<Usage | null>;
  openChat(who: Who, preferId: string | null): Promise<{ id: string } | null>;
  createChat(who: Who, title: string): Promise<string>;
  chats(who: Who, limit: number): Promise<{ id: string; title: string | null; status: string; last_message_at: string }[]>;
  /** A chat's history, oldest first, or null when it isn't this person's chat. Each message also carries
   *  `tools` and `stop_reason` (StoredMessage), for the next turn's customer-words lock (agent.ts
   *  lockedByLastReply); agent.ts forPage removes them before the page. */
  messages(who: Who, chatId: string, limit: number): Promise<StoredMessage[] | null>;
  addMessage(m: { chatId: string; who: Who; role: "user" | "assistant"; body: string; tools?: string[]; proposalIds?: string[]; totals?: Totals; stopReason?: string | null; model?: string | null; charge?: { state: string; micros: number | null } }): Promise<StoredMessage>;
  bumpChat(chatId: string, d: { messages: number; totals: Totals; model: string | null }): Promise<void>;
  closeChats(who: Who): Promise<void>;
  reopenChat(who: Who, chatId: string): Promise<boolean>;
  accountLine(who: Who): Promise<{ firstName: string | null; title: string | null; business: string | null; role: string | null }>;
  insertProposal(p: Partial<ProposalRow> & { client_id: string; user_id: string; kind: string; status: string; title: string }): Promise<ProposalRow>;
  getProposal(clientId: string, id: string): Promise<ProposalRow | null>;
  /** Moves a row only if it still stands at one of `whenStatus`, and, with `whenUpdatedAt`, only if
   *  nothing has written it since it was read. Null means it had moved on. */
  updateProposal(clientId: string, id: string, patch: Record<string, unknown>, whenStatus?: string[], whenUpdatedAt?: string): Promise<ProposalRow | null>;
  addProposalCost(clientId: string, id: string, totals: Totals, model: string | null): Promise<void>;
  proposals(clientId: string, limit: number): Promise<ProposalRow[]>;
  proposalsById(clientId: string, ids: string[]): Promise<ProposalRow[]>;
  names(clientId: string, userIds: string[]): Promise<Record<string, string>>;
  /** When a door last changed, or null when it's gone. A read: saves still go through portal-settings. */
  fixtureStamp(clientId: string, id: string): Promise<string | null>;
  /** What Jack remembers for this builder (memory.ts). Service role; the browser never reads it. */
  memory(clientId: string): Promise<MemoryRow[]>;
  /** One answer, written only if the key still stands as it was read (`basedOn`: its updated_at, or
   *  null when it was unset). False means someone else changed it first. */
  putMemory(clientId: string, key: string, value: unknown, by: { userId: string; operatorEmail: string | null }, basedOn: string | null): Promise<boolean>;
  forgetMemory(clientId: string, key: string, basedOn: string): Promise<boolean>;
  /** Whether Structure Studio issues this builder's estimates (client_settings.invoice_in_ghl is false):
   *  false in CRM mode, null when the read failed. One boolean, nothing else: the person's own reads
   *  can't see it unless they open the CRM settings, and resend_quote_email refuses CRM mode at the press
   *  anyway (sends.ts). Optional: a store without it reads as "couldn't tell", which refuses. */
  paperworkInSS?(clientId: string): Promise<boolean | null>;
  /** Whether this estimate was accepted (designs.accepted_at, or a design_acceptances row): true, false,
   *  or null when a read failed. One boolean, nothing else, for the estimate resend card (sends.ts), so an
   *  acceptance the caller's own feed read dropped can't let an accepted estimate go out again.
   *  Optional: a store without it reads as "couldn't tell", which refuses. */
  estimateTaken?(clientId: string, shortCode: string): Promise<boolean | null>;
}

/** The functions Jack reaches with the caller's own token. */
export type PortalFn = "portal-settings" | "portal-setup" | "portal-billing" | "portal-schedule" | "portal-commissions";
export type FnCall = (fn: PortalFn, action: string, body: Record<string, unknown>) => Promise<{ status: number; data: Record<string, unknown> | null }>;

/** Money, for billing.ts. The only service-role writes Jack makes, and none of them can charge a card. */
export interface Wallet {
  /** The jack_ai meter: whether it is armed, and its markup. Null when the read failed. */
  meter(): Promise<{ active: boolean; markup: number | null } | null>;
  /** metered_exempt, then billing_exempt. Null when the read failed. */
  exempt(clientId: string): Promise<boolean | null>;
  /** What the gate needs. Null when the read failed. */
  account(clientId: string): Promise<{ balanceCents: number; heldCents: number; remainderMicros: number; autoTopup: boolean; thresholdCents: number | null } | null>;
  /** wallet_usage_debit: idempotent on the key, never refuses for funds. */
  debit(a: { clientId: string; chargeMicros: number; costMicros: number; refType: "jack_message" | "jack_proposal"; refId: string; memo: string; usage: Record<string, unknown>; key: string }): Promise<{ ok: boolean; txId: number | null }>;
  /** wallet_credit 'grant' under a fixed key. True when granted now or before. */
  grantOnce(clientId: string, cents: number, key: string, memo: string): Promise<boolean>;
  /** Asks the wallet-autotopup door to look at this builder. It decides; Jack passes no amount. */
  requestTopup(clientId: string): void;
  /** Writes how a row was billed. */
  mark(table: "jack_messages" | "jack_proposals", id: string, patch: { charge_state: string; charge_micros: number | null; wallet_tx_id?: number | null }): Promise<void>;
  /** Rows of this builder still waiting to be charged, oldest first. */
  pending(clientId: string, olderThanIso: string, limit: number): Promise<{ table: "jack_messages" | "jack_proposals"; id: string; charge_micros: number; cost_micros: number; model: string | null }[]>;
}

export interface Deps {
  env(name: string): string | undefined;
  store: Store;
  /** portal-settings, with the caller's own token. */
  portal: PortalCall;
  /** Any of the portal functions, with the caller's own token. */
  call: FnCall;
  wallet: Wallet;
  fetch: Fetcher;
  canRead(area: string): boolean;
  canEdit(area: string): boolean;
  /** Keeps work going after the answer is sent. */
  background(work: Promise<unknown>): void;
  /** How long this worker may still run, in ms. */
  budgetMs(): number;
  makeId(): string;
  hash(text: string): Promise<string>;
  log(e: { code: string; message: string; severity?: "error" | "warn" | "info"; clientId?: string | null; context?: Record<string, unknown> }): Promise<void>;
  audit(action: string, rows: number | null, note: string | null): Promise<void>;
  now(): number;
  /** "Sent by Mike with Jack" (migration 378): stamps sent_with = 'jack' on the ledger row a send route
   *  answered with, with Jack's own service-role client, on this builder only and only where it is still
   *  null; fills sent_by with the approver only where it is null. Never throws: a failed stamp is logged
   *  and answers false, and the message still counts as sent (sends.ts). */
  markSentWithJack(table: "sms_messages" | "email_sends", id: string, by: string | null): Promise<boolean>;
}
export interface Reply { status: number; body: Record<string, unknown> }

/** One chat turn, as the tools see it. */
export interface TurnState {
  who: Who;
  chatId: string;
  /** The Jack switches an owner or admin turned off on this account. */
  off: string[];
  proposalIds: string[];
  /** "owner", "admin", "user" or null, for what the person may decide for the whole builder. */
  role?: string | null;
  /** Set once a tool's answer carried a customer's words: from then on, no tool that proposes a change
   *  to settings, prices or rules is offered in this turn. agent.ts handleSend also sets it at the start
   *  of a turn when the answer before repeated a customer's words (ChatTurn.lockedByReply), since those
   *  words come back in the history. */
  customerWordsRead?: boolean;
  /** What Jack remembers for this builder, read once per turn. */
  memory?: Record<string, { value: unknown; updatedAt: string }>;
  /** The browser's IANA time zone, checked (handleSend): "today" and a build marked built are local. */
  tz?: string | null;
}

export interface ToolOut { content: string; isError?: boolean }

/** strict is left off a read tool (agent.ts withinStrictLimits): the API caps strict tools per request. */
// deno-lint-ignore no-explicit-any
export type ToolDef = { name: string; description: string; strict?: true; input_schema: any };

export interface ToolSpec {
  def: ToolDef;
  /** Areas the caller needs for the tool to be offered at all. All must pass. */
  needs?: { area: string; level: "view" | "edit" }[];
  /** At least one of these must pass (for a tool that serves either of two pages). */
  needsAny?: { area: string; level: "view" | "edit" }[];
  /** The Jack switch that takes this tool away. */
  switchKey?: string;
  /** Its answer carries a customer's words or record. */
  customerWords?: boolean;
  /** It writes a card that would change settings, prices, rules or a work record (an order, the build or
   *  delivery schedule, inventory, a commission rate). Not offered after customer words. */
  proposesChange?: boolean;
  /** Not offered to the Structure Studio team in view-as (the route refuses them anyway). */
  noOperators?: boolean;
  run(deps: Deps, s: TurnState, input: unknown): Promise<ToolOut>;
}

export interface ApplyOutcome {
  /** What the row becomes: status, result, undo. */
  patch: Record<string, unknown>;
}
export interface UndoOutcome {
  restored: number;
  removed: number;
  /** Lines the route never answered for: the card stays undoable. */
  failed: number;
  reports: { label: string; status: string; reason: string }[];
}

export interface KindSpec {
  kind: string;
  /** Areas a person needs, at edit, to approve or undo this card. */
  areas(p: ProposalRow): string[];
  /** Areas a person needs, at read, to open this card. Defaults to `areas`. */
  readAreas?(p: ProposalRow): string[];
  /** Jack switches this card needs on to be approved. */
  switches(p: ProposalRow): string[];
  /** Only the person who asked, and the Structure Studio team, may open it: it holds customer names or
   *  words, and a teammate with a narrower view of customers must not see them. */
  private?: boolean;
  /** Shown only, never approved (a look-up list, a question). */
  showOnly?: boolean;
  /** Preview keys the Structure Studio team never sees, even on a card they may open (a pay rate). */
  operatorHidden?: string[];
  /** The team in view-as may not approve, undo or cancel this card: the sentence that says so. */
  noOperators?: string;
  /** Where to look when a save stopped part way, for the give-up sentence. */
  where?: string;
  /** The whole sentence when a press stalled past the give-up time, or threw part way (agent.ts settled
   *  and approvePiece). A kind that sends a message says it may have gone, never "saved". */
  gaveUp?: string;
  /** The press sends a message to a customer: a text, an email, an estimate emailed again, or a change
   *  order emailed to sign. Only a page that shows the card's words says so (its Approve carries send:
   *  true), so an older page that draws this card as a plain card with Approve and no words can't send
   *  words it never showed (agent.ts approvePiece). A kind that sends also says gaveUp in its own words. */
  sends?: true;
  /** What Jack says when this is the one card a turn made and Claude wrote no words (agent.ts
   *  onScreenSentence). Left out, the general sentence for its kind is used. */
  onScreen?: string;
  /** A sentence when THIS person may not approve THIS card, checked before the claim so the card stays
   *  as it was for the person who may (the team in view-as and a text). Null means they may. */
  mayNotApprove?(who: Who, p: ProposalRow): string | null;
  /** Refuses a card that holds nothing to run. A sentence means "nothing to approve". */
  nothingToDo?(p: ProposalRow): string | null;
  apply?(deps: Deps, who: Who, p: ProposalRow, progress: (patch: Record<string, unknown>) => Promise<void>): Promise<ApplyOutcome>;
  undo?(deps: Deps, who: Who, p: ProposalRow): Promise<UndoOutcome>;
}

/** A piece of Jack: its tools, its cards, its switch and what Claude is told about it. */
export interface Piece {
  name: string;
  tools: ToolSpec[];
  kinds: KindSpec[];
  /** Lines for the "What you can do right now" part of the system prompt. */
  can: string[];
  /** Extra lines for "How it works". */
  rules?: string[];
}
