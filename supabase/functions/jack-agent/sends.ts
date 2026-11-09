// jack-agent: the cards that send (sends_test.ts). Plan 5.5 and section 6, and the cautious defaults
// settled on 2026-11-06 (the build brief's defaults 1 to 10).
//
// Two kinds of card, both private (the asker and the Structure Studio team), both cleared after 30 days
// (common.ts PRIVATE_KINDS, 378 jack_clear_old_private):
//   reply_send       a text or an email to one customer (drafts.ts propose_reply_draft makes it)
//   estimate_resend  one of their Structure Studio estimates, emailed again (propose_estimate_resend)
//
// ══ THE SHAPES THE PORTAL CARDS RENDER ══
//   reply_send and reply_draft preview (drafts.ts makes both):
//     { contactId, dealKey, channel: "sms" | "email", subject, body, firstName, dealLabel,
//       factsUsed: string[], notes: string[],
//       sendable: boolean,                      true on reply_send, false on reply_draft
//       ruleNotes: string[],                    the rules a send can set off (ruleWarn.ts sendRuleNotes)
//       quiet: { sentence, opensAt } | null }   texting hours were closed where they live when the card
//                                               was made; opensAt is an ISO time (8am their time)
//     plus fullName, company, town: who it goes to, on this private card only (never to Claude). A record
//     with no name gets no card that sends (reply_draft), so a press always shows exactly who it goes to.
//     plus to: where it goes, "(816) 555-0142" for a text or the address for an email (11-09), and
//     sameName: a sentence when another customer has the same name ("Another customer is also named Dale
//     Rivers. Check the number before you approve."), or null. Both on this private card only.
//   estimate_resend preview:
//     { contactId, dealKey (the design's code), firstName, fullName, company, town, to (the address saved
//       on the estimate, which the record's must match), sameName, dealLabel,
//       estimateNumber, total ("$8,450", or null), lastSentOn (ISO time it last went out, or null when their
//       record's recent history doesn't show it: the card then shows no row, and Claude isn't told), ageDays
//       (whole days from when the estimate was made: a send, Jack's own included, re-sends the old price and
//       never re-prices it), notes: string[], ruleNotes: string[] }
//   result after the press:
//     sent      status "applied", undo null:   { sent: 1, channel: "sms" | "email", at (ISO), ledgerId }
//     waiting   status back to "ready", same hash, nothing sent, approved_* cleared:
//               { waiting: { reason: "quiet_hours" | "wallet_topping_up", sentence, retryAt (ISO) | null } }
//     refused   status "failed", failure = the sentence, result { sent: 0, reports: [] }
//     unclear   status "partly_applied", undo null,
//               result { sent: 0, reports: [{ label, status: "error", reason: SEND_SAID.unsure }] }
//   A press stuck past the give-up time (agent.ts settled), or one that threw after the route was
//   called (agent.ts approvePiece), ends as "unclear" with the same report and sentence; its result
//   may carry no `sent` key, so read the report. A press on a card that waited clears the old wait
//   first, so `waiting` never shows on a card being sent or on one that stalled.
//   payload (never to the browser): reply_send { contactId, dealKey, channel, subject, body, to,
//     oldQuoteDays, daysCard, nonce }; estimate_resend { contactId, dealKey, estimateNumber, totalCents,
//     updatedAt, to, oldQuoteDays, daysCard, nonce }. totalCents and updatedAt pin the estimate as the card
//     showed it: the route emails the design as it stands at the press, and a revised estimate keeps its
//     number, so a press on a card whose estimate changed sends nothing. `to` pins where the card said it
//     goes (the number's smsPhoneKey, or the address in lower case): the route still sends to what the
//     record holds at the press, so a press whose record now holds another number or address sends
//     nothing, and a card with no `to` (made before 11-09) sends nothing either. An email reply hands that
//     address to crm_send_email as its `to`, which the route checks against the record itself. daysCard is
//     the old_quote_days question card the person answered in this chat (drafts.ts answeredDays), or null.
//   The press itself says send: true (Approve on a send card, on a page that shows its words), so a page
//   from before these cards, which draws one as a plain card with Approve and no words, can't send it
//   (agent.ts approvePiece). It also posts the `to` the page drew under the title (11-09): a page from
//   before the To line posts none, so its press sends nothing either.
//
// ══ THE RULES ══
//   - The button is the approval. Claude only proposes. A press runs exactly the words on the card, ONCE:
//     the claim (ready to applying) is the only guard, the routes take no idempotency key, so a press
//     never retries and never reuses apply.ts save(). progress({ undo: null }) goes before the one route
//     call, the way changeorders.ts sends a change order.
//   - Today's route, as the person: crm_send_sms, crm_send_email and resend_quote_email with the caller's
//     own token, so every refusal on the record page's own Send applies (consent, STOP, wallet, an unregistered
//     number, the 'own' row scope, the Customer Hub subscription, an operator who is read-only).
//   - The checks repeat right before each message, on a fresh crm_record read as the caller: merged, Do
//     Not Disturb (all: nothing; email off: no email and no estimate), the channel's facts, and the whole
//     fact guard of a draft (drafts.ts checkDraft). Quiet hours too, for a text, by the automations' own
//     rule (_shared/smsQuietHours.ts) on the customer's own numbers, which never leave the server. The
//     route itself skips quiet hours for a person's own Send (bypassQuietHours stays true there); Jack
//     never does. When it's quiet, nothing is sent and the card goes back to ready with when it opens, or
//     ends (failed) when texting hours open only after the card runs out, so no press is promised.
//   - The team in view-as may send emails and estimates, never a text: the record page hides texting
//     there. Checked before the claim, so the card stays ready for its asker.
//   - Every answer is one of four, never retried: sent, refused (the route answered and nothing went),
//     waiting (quiet hours, a wallet topping up), or unclear (no answer, a timeout, a 5xx, crm_send_email's
//     502, a 200 of the wrong shape, a resend's sent:false "failed", a text whose provider call broke off).
//     Unclear has no Approve button and says to check their record first.
//   - "Sent by Mike with Jack": right after the route says sent, deps.markSentWithJack stamps the ledger
//     row the route answered with (migration 378; makeSentWithJack below, given the service-role client
//     by index.ts). A failed stamp is logged and the message still counts as sent.
//   - One fact the person's own reads can't give a designs-only rep comes from index.ts with the service
//     role, as one boolean and nothing else: whether Structure Studio issues the estimates
//     (Store.paperworkInSS). The estimate's saved address is read through crm_record as the caller.
//   - Nothing new reaches Claude: no phone digits, no email address, no street line. The estimate's own
//     address and the record's are compared here, and only the person's own private card shows where it
//     goes. A refusal names neither (a card's failure is kept for good; its preview is cleared at 30 days).

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, TurnState, Who } from "./types.ts";
import { daysSince, dollars, err, ok, putCard, SAID, saidBy } from "./common.ts";
import { memoryMap, needsAnswer, remembered, validValue } from "./memory.ts";
import { sendRuleNotes } from "./ruleWarn.ts";
import {
  answeredDays, checkDraft, CONSENT_WHERE, contactIdOf, customerOf, DRAFT_SAID, type DraftIn, type Facts, giveCardSlot, OLD_PAGE_NOTE, precheck, quietFor, readCustomer,
  REPLACED_ESTIMATE, refusalFor, replaceOlder, sameNameForClaude, sameNameLine, sameNameOf, SENDS_SWITCH, takeCardSlot, UNPROVEN_DAYS,
} from "./drafts.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Progress = (patch: Record<string, unknown>) => Promise<void>;
type Ledger = "sms_messages" | "email_sends";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEND_SAID = {
  unsure: "I couldn't tell whether it went. Check their record before sending it again.",
  nothingSent: "Nothing was sent.",
  operatorText: "Texting isn't available while you're viewing another account, so this text can't be sent from here.",
  askAgain: "Your answer on how old an estimate can be is gone, so nothing was sent. Ask me again and I'll ask first.",
  textFailed: "The text couldn't go out just now, so nothing was sent. Try again from their record.",
  factsMoved: "An amount or a date in it isn't on their record any more, so nothing was sent. Ask me to write it again.",
  nothing: "There's nothing to send on that one.",
  emailOff: "Email sending isn't switched on for your account yet, so nothing was sent. Set up your sending domain on Settings > Customer Hub > Email Settings.",
  // A read at the press failed (their record, the design, what the builder remembers, how this account
  // issues estimates, or whether it was accepted). The card is done, so it never says "try again" here.
  readAtPress: "I couldn't check everything before sending just now, so nothing was sent. Ask me again and I'll make a fresh card.",
  quietPastCard: "Texting hours where they live open again only after this card runs out, so nothing was sent. Ask me to write it again once texting hours open there.",
  priceTooOld: "The estimate's price in it is older now than you allow, so nothing was sent. Ask me to write it again.",
  // The route's own words for these say "try again", and a refused card has no Approve left: these say what
  // the person can do from here.
  carrier: (code: string) => `The carrier refused the text (carrier code ${code}), so nothing was sent. Ask me to write it again, or call them instead.`,
  damagedNumber: "Their phone number looks damaged (its last digit was lost when it was first saved), so nothing was sent. Fix the number on their record, then ask me to write it again.",
  // Where it goes (11-09). Said without the number or the address: a card's failure is kept for good.
  noTo: "This card doesn't show where it goes, so nothing was sent. Ask me again and I'll make a fresh card.",
  toChanged: (channel: "sms" | "email") =>
    `The ${channel === "sms" ? "number" : "email address"} on their record isn't the one this card showed, so nothing was sent. Check their record, then ask me again.`,
  noConsentNow: `There's no consent to text on file for them now, so nothing was sent. ${CONSENT_WHERE} Once it's on file, ask me again.`,
};

/** A refusal at the press, in words for someone who just pressed Approve on a send card. checkDraft's refusals are written
 *  for Claude while it drafts ("so I won't write them one", "use one from their record"). */
function atPress(refuse: string): string {
  switch (refuse) {
    case DRAFT_SAID.dndAll: return "They're on Do Not Disturb for everything now, so nothing was sent. That's set on their record.";
    case DRAFT_SAID.dndEmail: return "They've turned off email from you since this was written (Email Do Not Disturb), so nothing was sent.";
    case DRAFT_SAID.optedOut: return "They've opted out of texts since this was written, so nothing was sent.";
    case DRAFT_SAID.noConsent: return SEND_SAID.noConsentNow;
    case DRAFT_SAID.dealNotTheirs: return "That deal isn't on this customer's record any more, so nothing was sent.";
    case DRAFT_SAID.merged: return "That customer was merged into another record, so nothing was sent. Look them up again and ask me to write it there.";
  }
  return `${refuse} ${SEND_SAID.nothingSent}`;
}

/** Where an estimate is sent again by hand, and where its card says to look. */
export const RESEND_WHERE = "the Orders screen";

export const RESEND_SAID = {
  noAccess: "Sending an estimate again isn't part of your access. Ask an owner or admin.",
  noDeal: "Say which estimate: use its dealKey from their deals.",
  notTheirs: "That estimate isn't one of this customer's. Use a dealKey from their deals.",
  notEstimate: "That deal has no estimate to send again.",
  notSS: "That estimate wasn't made in Structure Studio, so it can't be sent again from here.",
  gone: "That estimate isn't there any more.",
  merged: "That customer was merged into another record. Look them up again.",
  dndAll: "They're on Do Not Disturb for everything, so I won't send them anything. That's set on their record.",
  dndEmail: "They've turned off email from you (Email Do Not Disturb), so I won't email them the estimate.",
  accepted: `They've accepted that estimate, so I won't send it again. If they need a copy, send it from ${RESEND_WHERE}.`,
  sold: `That estimate is already an order, so I won't send it again. If they need a copy, send it from ${RESEND_WHERE}.`,
  old: (age: number | null, n: number) =>
    `${age === null ? "I can't tell how old that estimate is" : `That estimate is ${age} days old`}, and you treat estimates past ${n} days as old, so I won't send it again. Check its price first, then send it from ${RESEND_WHERE}.`,
  noEmail: "That estimate has no email address saved on it, so it can't be emailed from here.",
  mismatch: `The email address saved on that estimate isn't the one on their record now. Check the address and send it from ${RESEND_WHERE}.`,
  crm: "This account sends its estimates through the CRM, so send it again from there.",
  changed: "That estimate changed since I showed it to you, so nothing was sent. Ask me again and I'll look at it as it is now.",
  notTheirsNow: "That estimate isn't on this customer's record any more, so nothing was sent.",
  noName: `Their record has no name on it, so the card couldn't show who it goes to. Check their record, then send it from ${RESEND_WHERE}.`,
  toChanged: "The email address on their record isn't the one this card showed, so nothing was sent. Check their record, then ask me again.",
};

/** The resend refusals about this record's own channels (drafts.ts refusalFor). */
const RESEND_RECORD_REFUSALS = new Set<string>([RESEND_SAID.dndAll, RESEND_SAID.dndEmail]);

// ── What a route's answer means ────────────────────────────────────────────────────────────────────

export type SendAnswer =
  | { kind: "sent"; id: string | null }
  | { kind: "refused"; sentence: string }
  | { kind: "waiting"; reason: "quiet_hours" | "wallet_topping_up"; sentence: string; retryAt: string | null }
  | { kind: "unclear" };

const UNCLEAR: SendAnswer = { kind: "unclear" };
const errorOf = (r: Res) => (r.data && typeof r.data.error === "string" ? r.data.error.trim() : "");
/** A sentence ends with a stop. */
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const refusedBy = (r: Res, fallback: string): SendAnswer => ({ kind: "refused", sentence: `${stop(saidBy(r, fallback))} ${SEND_SAID.nothingSent}` });
const idOf = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);

/** crm_send_sms: { ok, id } when it went; 400 { error, reason } or 409 not_active when it didn't. */
export function classifySms(r: Res): SendAnswer {
  if (r.status === 200) return r.data?.ok === true ? { kind: "sent", id: idOf(r.data.id) } : UNCLEAR;
  if (r.status === 0 || r.status >= 500) return UNCLEAR;
  const e = errorOf(r);
  const reason = String(r.data?.reason ?? "");
  // Nothing went, and it can go in a minute: the wallet asked for its top-up (smsSend.ts).
  if (reason === "wallet_empty" && /topped up/i.test(e)) return { kind: "waiting", reason: "wallet_topping_up", sentence: `${SEND_SAID.nothingSent} ${stop(e)}`, retryAt: null };
  // The route skips quiet hours for a person's own Send today; if it ever doesn't, it's a wait.
  if (reason === "quiet_hours") return { kind: "waiting", reason: "quiet_hours", sentence: `${SEND_SAID.nothingSent} ${stop(e || "Texts can't go out where they live right now.")}`, retryAt: null };
  if (reason === "failed") {
    // The carrier answered with its code: it didn't go. A refused claim row, an empty body, or a texting
    // account or number that couldn't be read (smsSend.ts says exactly "The text could not be sent. Try
    // again." there, before any claim) never reached the carrier. Anything else "failed" is the provider
    // call breaking off, or a throw part way, which may have gone.
    // Twilio's own server errors (20500, 20503: its HTTP 5xx answers carry these codes) don't prove the
    // message wasn't created, so they may have gone. Any other code is a definite no.
    const code = /carrier code (\d+)/i.exec(e);
    if (code && Number(code[1]) >= 20500 && Number(code[1]) <= 20599) return UNCLEAR;
    if (code) return { kind: "refused", sentence: SEND_SAID.carrier(code[1]) };
    if (/ledger write failed|message is empty/i.test(e) || /^The text could not be sent\. Try again\.$/.test(e)) return { kind: "refused", sentence: SEND_SAID.textFailed };
    return UNCLEAR;
  }
  if (reason === "damaged_number") return { kind: "refused", sentence: SEND_SAID.damagedNumber };
  return refusedBy(r, "The text wasn't sent.");
}

/** crm_send_email: { ok, messageId, id } when it went; 4xx refusals; 503 when sending isn't switched on;
 *  502 when the provider failed, which may still have gone. */
export function classifyEmail(r: Res): SendAnswer {
  if (r.status === 200) return r.data?.ok === true ? { kind: "sent", id: idOf(r.data.id) } : UNCLEAR;
  // The route's own "not switched on" refusal touches no network. Any other 5xx may have gone.
  if (r.status === 503 && /switched on/i.test(errorOf(r))) return { kind: "refused", sentence: SEND_SAID.emailOff };
  if (r.status === 0 || r.status >= 500) return UNCLEAR;
  // The address on the record isn't the one the card showed (the `to` it was handed): refused before the
  // provider is called, in the press's own words rather than the route's ("reopen the record").
  if (r.status === 400 && /doesn't match this customer/i.test(errorOf(r))) return { kind: "refused", sentence: SEND_SAID.toChanged("email") };
  return refusedBy(r, "The email wasn't sent.");
}

/** resend_quote_email: 200 { ok, sent, reason, id } for every send outcome; 4xx for its refusals. */
export function classifyResend(r: Res): SendAnswer {
  if (r.status === 200) {
    const d = r.data;
    if (!d || d.ok !== true) return UNCLEAR;
    if (d.sent === true) return { kind: "sent", id: idOf(d.id) };
    if (d.sent !== false) return UNCLEAR;
    const reason = String(d.reason ?? "");
    if (reason === "not_active") return { kind: "refused", sentence: SEND_SAID.emailOff };
    if (/no email address/i.test(reason)) return { kind: "refused", sentence: `${RESEND_SAID.noEmail} ${SEND_SAID.nothingSent}` };
    // "failed" (a provider timeout lands there too) and anything new may have gone.
    return UNCLEAR;
  }
  if (r.status === 0 || r.status >= 500) return UNCLEAR;
  // The route's own refusals, in the words a person reads here.
  const e = errorOf(r);
  if (/through the CRM/i.test(e)) return { kind: "refused", sentence: `${RESEND_SAID.crm} ${SEND_SAID.nothingSent}` };
  if (/no StructureStudio/i.test(e)) return { kind: "refused", sentence: `${RESEND_SAID.notSS} ${SEND_SAID.nothingSent}` };
  if (/design not found/i.test(e)) return { kind: "refused", sentence: `${RESEND_SAID.gone} ${SEND_SAID.nothingSent}` };
  const said = saidBy(r, "The estimate wasn't sent.").replace(/\ba quote\b/g, "an estimate").replace(/\bA quote\b/g, "An estimate").replace(/\bquotes\b/gi, "estimates").replace(/\bquoted\b/gi, "estimated").replace(/\bquote\b/gi, "estimate");
  return { kind: "refused", sentence: `${stop(said)} ${SEND_SAID.nothingSent}` };
}

// ── The press: the four endings ───────────────────────────────────────────────────────────────────

const refused = (sentence: string): ApplyOutcome => ({ patch: { status: "failed", failure: sentence, result: { sent: 0, reports: [] }, undo: null } });
const unclear = (p: ProposalRow): ApplyOutcome => ({
  patch: { status: "partly_applied", result: { sent: 0, reports: [{ label: p.title, status: "error", reason: SEND_SAID.unsure }] }, undo: null },
});
/** Back to ready, nothing sent: the same card and hash, so a later press (inside its 24 hours) sends. */
const waiting = (reason: "quiet_hours" | "wallet_topping_up", sentence: string, retryAt: string | null): ApplyOutcome => ({
  patch: { status: "ready", result: { waiting: { reason, sentence, retryAt } }, undo: null, approved_by: null, approved_by_operator: null, approved_at: null },
});

/** What the route's answer makes of the card. A sent message is stamped "with Jack", and a stamp that
 *  fails never makes it anything but sent. */
async function ending(deps: Deps, who: Who, p: ProposalRow, said: SendAnswer, channel: "sms" | "email", table: Ledger): Promise<ApplyOutcome> {
  if (said.kind === "refused") return refused(said.sentence);
  if (said.kind === "waiting") return waiting(said.reason, said.sentence, said.retryAt);
  if (said.kind === "unclear") return unclear(p);
  if (said.id) {
    try {
      await deps.markSentWithJack(table, said.id, who.userId);
    } catch {
      // index.ts's stamp never throws; a deps without one (a harness) lands here. Logged, still sent.
      await deps.log({ code: "jack_sent_with_failed", severity: "warn", clientId: who.clientId, message: "A sent message couldn't be marked as sent with Jack.", context: { proposal: p.id, table } }).catch(() => undefined);
    }
  } else {
    // The route answered sent with no row id (one deployed ahead of this jack-agent): the message went,
    // and nothing can mark it "with Jack". Said once, so the gap shows.
    await deps.log({ code: "jack_sent_with_no_id", severity: "info", clientId: who.clientId, message: "A sent message came back with no row id, so it can't be marked as sent with Jack.", context: { proposal: p.id, table } }).catch(() => undefined);
  }
  return { patch: { status: "applied", result: { sent: 1, channel, at: new Date(deps.now()).toISOString(), ledgerId: said.id }, undo: null } };
}

/** The customer read again at the press. A read that throws sent nothing, so it is a refusal, never the
 *  "couldn't tell" a throw after the route call is. */
const readFresh = (deps: Deps, contactId: string) => readCustomer(deps, contactId).catch(() => ({ error: SAID.readFailed }));

/** A press on a card that waited (quiet hours, a wallet topping up) starts clean: the old wait never
 *  stays on a card that is being sent, nor on one that stalls part way (agent.ts settled keeps result). */
async function startClean(p: ProposalRow, progress: Progress): Promise<void> {
  if (p.result) await progress({ result: null });
}

/** The card's oldQuoteDays, if the person's answer in that chat is still behind it (drafts.ts
 *  answeredDays reads the question card again), else null: a number without it is no rule. */
async function daysAtPress(deps: Deps, who: Who, p: ProposalRow): Promise<number | null> {
  const pl = (p.payload ?? {}) as Any;
  if (typeof pl.oldQuoteDays !== "number") return null;
  const card = typeof pl.daysCard === "string" && UUID.test(pl.daysCard) ? pl.daysCard : null;
  if (!card) return null;
  return (await answeredDays(deps, who.clientId, p.user_id, p.conversation_id, pl.oldQuoteDays, card)) ? pl.oldQuoteDays : null;
}

/** The turn state a check at the press reads: the approver, and what the builder remembers NOW. */
async function stateAt(deps: Deps, who: Who, p: ProposalRow): Promise<TurnState | null> {
  try {
    const memory = memoryMap(await deps.store.memory(who.clientId));
    return { who, chatId: p.conversation_id ?? "", off: [], proposalIds: [], memory };
  } catch {
    return null;
  }
}

/** The design code to file a reply under: the deal's design (a design, or a pipeline card of one), or
 *  an order's code. A lead with no design has none. */
function shortCodeOf(f: Facts, dealKey: string | null): string | null {
  if (!dealKey) return null;
  const deal = f.dealKeys.get(dealKey);
  if (deal && !UUID.test(deal.key)) return deal.key;
  return UUID.test(dealKey) ? null : dealKey;
}

// ── reply_send ────────────────────────────────────────────────────────────────────────────────────

/** Send for a reply: read them again as the caller, check everything a draft is checked for again, then
 *  quiet hours for a text, then ONE route call. */
async function applyReply(deps: Deps, who: Who, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  const pl = (p.payload ?? {}) as Any;
  const contactId = contactIdOf(pl.contactId);
  const channel: "sms" | "email" | null = pl.channel === "sms" || pl.channel === "email" ? pl.channel : null;
  if (!contactId || !channel) return refused(SEND_SAID.nothing);
  // Belt and braces: mayNotApprove refused this before the claim.
  if (who.operatorEmail && channel === "sms") return refused(SEND_SAID.operatorText);
  const draft: DraftIn = {
    channel,
    subject: channel === "email" && typeof pl.subject === "string" && pl.subject.trim() ? pl.subject : null,
    body: typeof pl.body === "string" ? pl.body : "",
    dealKey: typeof pl.dealKey === "string" && pl.dealKey ? pl.dealKey : null,
    oldQuoteDays: null,
  };
  const pre = precheck(draft);
  if (pre) return refused(`${pre} ${SEND_SAID.nothingSent}`);
  // Where the card said it goes. A card that never said sends nothing.
  const shownTo = typeof pl.to === "string" && pl.to ? pl.to : null;
  if (!shownTo) return refused(SEND_SAID.noTo);

  await startClean(p, progress);
  draft.oldQuoteDays = await daysAtPress(deps, who, p);
  const read = await readFresh(deps, contactId);
  // A read that failed is said for someone who just pressed; a 404 or a 403 is said as it is.
  if ("error" in read) return refused(read.error === SAID.readFailed ? SEND_SAID.readAtPress : `${read.error} ${SEND_SAID.nothingSent}`);
  const s = await stateAt(deps, who, p);
  if (!s) return refused(SEND_SAID.readAtPress);
  const v = checkDraft(read.facts, draft, s, deps.now(), "send");
  // A price or date refusal quotes amounts and the draft's words; the card's failure is kept for good.
  // The rest were written for Claude while drafting, so the press says them its own way.
  if ("refuse" in v) return refused(v.fact ? SEND_SAID.factsMoved : v.stale ? SEND_SAID.priceTooOld : atPress(v.refuse));
  if ("ask" in v) return refused(SEND_SAID.askAgain);
  // The route sends to what the record holds now: never to a number or an address the person never saw.
  // An email also hands the route the address the card showed (crm_send_email's `to`, a confirmation it
  // compares with the record it reads itself), so an address changed between this read and the route's
  // is refused there too. crm_send_sms takes no such confirmation: a text reads the number again at the
  // route, and that window of a moment is accepted.
  if ((channel === "sms" ? read.keys.textTo : read.keys.email) !== shownTo) return refused(SEND_SAID.toChanged(channel));
  if (channel === "sms") {
    const quiet = quietFor(read.keys, deps.now());
    // Pressed again once texting hours open, inside the card's 24 hours. When they open only after the
    // card runs out, no later press can send it: the card ends here rather than promise one.
    if (quiet && !(Date.parse(quiet.opensAt) < Date.parse(p.expires_at))) return refused(SEND_SAID.quietPastCard);
    if (quiet) return waiting("quiet_hours", `${SEND_SAID.nothingSent} ${quiet.sentence}`, quiet.opensAt);
  }

  const shortCode = shortCodeOf(read.facts, draft.dealKey);
  // From here a lost answer may have sent it: no Undo is ever on the row (changeorders.ts does the same).
  await progress({ undo: null });
  const action = channel === "sms" ? "crm_send_sms" : "crm_send_email";
  const body = channel === "sms"
    ? { contactId, ...(shortCode ? { shortCode } : {}), body: draft.body }
    : { contactId, ...(shortCode ? { shortCode } : {}), to: shownTo, subject: draft.subject, body: draft.body };
  const r = await deps.portal(action, body).catch(() => ({ status: 0, data: null }));
  return await ending(deps, who, p, channel === "sms" ? classifySms(r) : classifyEmail(r), channel, channel === "sms" ? "sms_messages" : "email_sends");
}

const replySendKind: KindSpec = {
  kind: "reply_send",
  // crm_send_sms and crm_send_email are contacts edit (portal-settings GATES).
  areas: () => ["contacts"],
  readAreas: () => ["contacts"],
  switches: () => ["customers", SENDS_SWITCH],
  private: true,
  where: "the customer's record",
  gaveUp: SEND_SAID.unsure,
  sends: true,
  mayNotApprove: (who, p) => (who.operatorEmail && p.payload?.channel === "sms" ? SEND_SAID.operatorText : null),
  nothingToDo: (p) => (contactIdOf(p.payload?.contactId) && (p.payload?.channel === "sms" || p.payload?.channel === "email") && typeof p.payload?.body === "string" && p.payload.body.trim() ? null : SEND_SAID.nothing),
  apply: (deps, who, p, progress) => applyReply(deps, who, p, progress),
};

// ── estimate_resend ───────────────────────────────────────────────────────────────────────────────

interface EstimateOk {
  code: string;
  number: string;
  facts: Facts;
  label: string;
  totalCents: number | null;
  /** designs.updated_at as read: every write to the design moves it (designs_set_updated_at). */
  updatedAt: string | null;
  lastSentAt: string | null;
  ageDays: number | null;
  /** The address it emails: the one saved on the estimate (resend_quote_email's), which is the record's.
   *  `to` in lower case for the press's compare, `toShown` as it's saved, for the card. Never to Claude. */
  to: string;
  toShown: string;
}

/** What the card showed, which the press must find unchanged. */
interface Shown { number: string; totalCents: number | null; updatedAt: string | null; to: string }

/** Everything that decides whether this estimate may be emailed again, read as the caller. The card runs
 *  it, and the press runs it again on fresh reads with `shown`, what the card showed: resend_quote_email
 *  emails the design as it stands at the press (its lines, its total, its PDF), and a revised or re-taxed
 *  estimate keeps its number, so the number alone can't say it's the one the person saw. */
async function checkEstimate(deps: Deps, s: TurnState, contactId: string, dealKey: string, oldQuoteDays: number | null, shown: Shown | null): Promise<EstimateOk | { refuse: string; facts?: Facts } | { ask: string }> {
  const read = await readFresh(deps, contactId);
  if ("error" in read) return { refuse: read.error };
  const f = read.facts;
  if (f.merged) return { refuse: RESEND_SAID.merged };
  // About this record's own channels: the facts ride along, so the card's tool can say when another
  // customer has the same name (drafts.ts refusalFor).
  if (f.dndAll) return { refuse: RESEND_SAID.dndAll, facts: f };
  if (f.dndEmail) return { refuse: RESEND_SAID.dndEmail, facts: f };
  // Their orders couldn't be read: an estimate that is already an order would look open.
  if (!f.ordersRead) return { refuse: SAID.readFailed };
  if (!f.dealKeys.has(dealKey)) return { refuse: RESEND_SAID.notTheirs };
  const deal = f.dealKeys.get(dealKey) ?? null;
  // An order with no design of theirs, or a pipeline lead with no design: no estimate to send.
  if (!deal || UUID.test(deal.key)) return { refuse: RESEND_SAID.notEstimate };
  if (deal.stage === "sold") return { refuse: RESEND_SAID.sold };
  if (deal.stage === "accepted") return { refuse: RESEND_SAID.accepted };
  const code = deal.key;

  // The design itself, as the caller: its own estimate number, and the address the route emails (the
  // design's saved contact, not the record's).
  const dr = await deps.portal("crm_record", { kind: "design", id: code }).catch(() => ({ status: 0, data: null }) as Res);
  if (dr.status === 404) return { refuse: RESEND_SAID.gone };
  if (dr.status === 403) return { refuse: saidBy(dr, SAID.noSee) };
  const designs = Array.isArray(dr.data?.designs) ? dr.data!.designs as Any[] : [];
  const d = designs[0];
  if (dr.status !== 200 || dr.data?.ok !== true || !d || String(d.short_code ?? "") !== code) return { refuse: SAID.readFailed };
  if (String(d.contact_id ?? "").toLowerCase() !== contactId) return { refuse: RESEND_SAID.notTheirs };
  const number = typeof d.ss_quote_number === "string" ? d.ss_quote_number.trim() : d.ss_quote_number ? String(d.ss_quote_number) : "";
  if (!number) return { refuse: RESEND_SAID.notSS };
  // No total on the design is no total, never "$0" (Number(null) is 0).
  const cents = d.total_cents === null || d.total_cents === undefined || d.total_cents === "" ? NaN : Number(d.total_cents);
  const totalCents = Number.isFinite(cents) ? Math.round(cents) : null;
  const updatedAt = typeof d.updated_at === "string" && d.updated_at ? d.updated_at : null;
  if (shown && (number !== shown.number || totalCents !== shown.totalCents || updatedAt !== shown.updatedAt)) return { refuse: RESEND_SAID.changed };
  const saved = typeof d.contact?.email === "string" ? d.contact.email.trim().toLowerCase() : "";
  if (!saved) return { refuse: RESEND_SAID.noEmail };
  if (!read.keys.email || read.keys.email !== saved) return { refuse: RESEND_SAID.mismatch };
  // Where the card said it goes: never an address the person never saw.
  if (shown && saved !== shown.to) return { refuse: RESEND_SAID.toChanged };

  const ss = deps.store.paperworkInSS ? await deps.store.paperworkInSS(s.who.clientId).catch(() => null) : null;
  if (ss === null) return { refuse: SAID.readFailed };
  if (!ss) return { refuse: RESEND_SAID.crm };
  // Accepted, by the design's own stamp or an acceptance row: the caller's feed drops a failed read of
  // those silently, so this one boolean comes from the service role (index.ts estimateTaken).
  const taken = deps.store.estimateTaken ? await deps.store.estimateTaken(s.who.clientId, code).catch(() => null) : null;
  if (taken === null) return { refuse: SAID.readFailed };
  if (taken) return { refuse: RESEND_SAID.accepted };

  // How old the PRICE is: from when the estimate was made. A send never re-prices it, so counting from
  // the last send would let each resend make an old price look new. (A revised estimate keeps its
  // made date, so this can only call an estimate older than it is, never newer.)
  const feed = Array.isArray(dr.data?.feed) ? dr.data!.feed as Any[] : [];
  const sentRow = feed.find((e) => String(e?.id ?? "") === `qs:${code}` && e?.at);
  const lastSentAt = sentRow ? String(sentRow.at) : null;
  const ageDays = daysSince(d.created_at, deps.now());
  const kept = remembered(s, "old_quote_days");
  const n = typeof kept === "number" ? kept : oldQuoteDays;
  if (typeof n !== "number") return { ask: "old_quote_days" };
  if (ageDays === null || ageDays > n) return { refuse: RESEND_SAID.old(ageDays, n) };
  return { code, number, facts: f, label: deal.label, totalCents, updatedAt, lastSentAt, ageDays, to: saved, toShown: String(d.contact.email).trim().slice(0, 320) };
}

/** Send for an estimate: every check again, the estimate as the card showed it, then ONE
 *  resend_quote_email. */
async function applyResend(deps: Deps, who: Who, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  const pl = (p.payload ?? {}) as Any;
  const contactId = contactIdOf(pl.contactId);
  const dealKey = typeof pl.dealKey === "string" ? pl.dealKey : "";
  const expect = typeof pl.estimateNumber === "string" ? pl.estimateNumber : "";
  if (!contactId || !dealKey || !expect) return refused(SEND_SAID.nothing);
  // Where the card said it goes (11-09). A card that never said sends nothing.
  if (typeof pl.to !== "string" || !pl.to) return refused(SEND_SAID.noTo);
  // A card from before the total and the design's stamp were pinned has neither: it reads as changed.
  const shown: Shown = {
    number: expect,
    totalCents: typeof pl.totalCents === "number" ? pl.totalCents : null,
    updatedAt: typeof pl.updatedAt === "string" ? pl.updatedAt : null,
    to: pl.to,
  };
  await startClean(p, progress);
  const s = await stateAt(deps, who, p);
  if (!s) return refused(SEND_SAID.readAtPress);
  const est = await checkEstimate(deps, s, contactId, dealKey, await daysAtPress(deps, who, p), shown);
  if ("refuse" in est) {
    if (est.refuse === RESEND_SAID.changed || est.refuse === RESEND_SAID.toChanged) return refused(est.refuse);
    // Written for Claude ("use a dealKey from their deals", "please try again"), so the press says it
    // its own way.
    if (est.refuse === RESEND_SAID.notTheirs) return refused(RESEND_SAID.notTheirsNow);
    if (est.refuse === SAID.readFailed) return refused(SEND_SAID.readAtPress);
    return refused(`${est.refuse} ${SEND_SAID.nothingSent}`);
  }
  if ("ask" in est) return refused(SEND_SAID.askAgain);
  await progress({ undo: null });
  const r = await deps.portal("resend_quote_email", { shortCode: est.code }).catch(() => ({ status: 0, data: null }));
  return await ending(deps, who, p, classifyResend(r), "email", "email_sends");
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

const resendTool: ToolSpec = {
  def: {
    name: "propose_estimate_resend",
    description: "Put one of a customer's Structure Studio estimates on the person's screen to email to them again, with an Approve button. It goes only when the person presses Approve on the card, which emails it right away. It never goes from your call, you can't press Approve, and typing \"yes, send it\" in the chat doesn't send it. It goes to the email address saved on the estimate, through the same route as the Orders screen, and the estimate's sent date moves to today. Read the customer first with look_at_customer_for_reply and name them by the list and ref it gave you; dealKey is the estimate's dealKey from their deals. It refuses an estimate they've accepted or that is an order, one made in the CRM, and one older than this builder allows.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["list", "ref", "dealKey", "oldQuoteDays"],
      properties: {
        list: { ...nullableString, description: "The list id the look-up gave you, with ref set to the row's ref (like c3). Null only when ref is a contact id." },
        ref: { type: "string", description: "The row's ref on that list, like c3, or the ref look_at_customer_for_reply gave you." },
        dealKey: { type: "string", description: "The estimate's dealKey, from their deals." },
        oldQuoteDays: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Only after this tool said needsAnswer old_quote_days and the person answered the question: the number of days they picked. Otherwise null." },
      },
    },
  },
  // The customer is read through crm_record as the caller; the route is designs edit.
  needs: [{ area: "contacts", level: "view" }, { area: "designs", level: "edit" }],
  switchKey: SENDS_SWITCH,
  customerWords: true,
  async run(deps, s, input) {
    if (s.off.includes(SENDS_SWITCH) || s.off.includes("customers")) return err(SAID.switchedOff);
    if (!deps.canRead("contacts")) return err(SAID.noSee);
    if (!deps.canEdit("designs")) return err(RESEND_SAID.noAccess);
    const i: Any = input ?? {};
    let oldQuoteDays: number | null = null;
    if (i.oldQuoteDays !== null && i.oldQuoteDays !== undefined) {
      const v = validValue("old_quote_days", i.oldQuoteDays);
      if (typeof v !== "number") return err(DRAFT_SAID.badDays);
      oldQuoteDays = v;
    }
    const dealKey = typeof i.dealKey === "string" ? i.dealKey.trim().slice(0, 64) : "";
    if (!dealKey) return err(RESEND_SAID.noDeal);

    if (!takeCardSlot(s)) return err(DRAFT_SAID.tooMany);
    let shown = false;
    try {
      const target = await customerOf(deps, s, i);
      if ("error" in target) return err(target.error);
      // Claude's number counts only with the person's own answer to the question in this chat behind it.
      let daysCard: string | null = null;
      let unproven = false;
      if (oldQuoteDays !== null) {
        daysCard = await answeredDays(deps, s.who.clientId, s.who.userId, s.chatId, oldQuoteDays);
        if (!daysCard) { oldQuoteDays = null; unproven = true; }
      }
      const est = await checkEstimate(deps, s, target.contactId, dealKey, oldQuoteDays, null);
      // Do Not Disturb on this record says so when another customer has the same name (11-09).
      if ("refuse" in est) return err(est.facts ? await refusalFor(deps, s, est.facts, est.refuse, RESEND_RECORD_REFUSALS) : est.refuse);
      if ("ask" in est) {
        return ok({
          ...needsAnswer(est.ask), shown: false,
          ...(unproven ? { unproven: UNPROVEN_DAYS } : {}),
          then: "When they answer, call propose_estimate_resend again with oldQuoteDays set to the number they picked.",
        });
      }
      // One press sends, so the card names exactly who it goes to, and where.
      if (!est.facts.fullName) return err(RESEND_SAID.noName);
      // Another customer this person can see by the same name: the card says so (11-09).
      const twin = await sameNameOf(deps, s, est.facts);
      const ruleNotes = await sendRuleNotes(deps, "estimate");
      // What Approve does is the card's own line; OLD_PAGE_NOTE is for a page from before round 2.
      const notes = [
        OLD_PAGE_NOTE.email,
        "Its sent date moves to today, so the count of days with no answer starts again today.",
      ];
      const total = est.totalCents !== null ? dollars(est.totalCents) : null;
      const card = await putCard(deps, s, {
        kind: "estimate_resend",
        // Teammates see titles on the activity page, so a title never names the customer.
        title: "An estimate to send again",
        // fullName, company, town and to: who it goes to and where, on the asker's private card only
        // (never to Claude). sameName: the line when another customer has the same name.
        preview: {
          contactId: target.contactId, dealKey: est.code, firstName: est.facts.firstName, fullName: est.facts.fullName,
          company: est.facts.company, town: est.facts.town, to: est.toShown, sameName: sameNameLine(est.facts, twin, "email", true), dealLabel: est.label,
          estimateNumber: est.number, total, lastSentOn: est.lastSentAt, ageDays: est.ageDays, notes, ruleNotes,
        },
        payload: {
          contactId: target.contactId, dealKey: est.code, estimateNumber: est.number, totalCents: est.totalCents, updatedAt: est.updatedAt, to: est.to,
          oldQuoteDays, daysCard, nonce: deps.makeId(),
        },
      });
      shown = true;
      const { replaced, yielded, replacedByNewer, unchecked } = await replaceOlder(deps, s, card, (p) => p.kind === "estimate_resend" && p.payload?.contactId === target.contactId && p.payload?.dealKey === est.code, REPLACED_ESTIMATE);
      if (replacedByNewer) {
        return ok({
          shown: true, putAway: true, sent: false, replacedByNewer: true,
          note: "A newer card for this estimate, made at the same time as this one, replaces it, so this one was put away and nothing was sent from it. Tell them only about the newer card.",
        });
      }
      if (unchecked) {
        return ok({
          shown: true, putAway: true, sent: false, unchecked: true,
          note: "The earlier cards for this estimate in this chat couldn't be checked (a read or a save failed), so this new one was put away to keep the estimate from being emailed twice. Nothing was sent from it. Tell them in a sentence, and that they can ask you again.",
        });
      }
      if (yielded) {
        return ok({
          shown: true, putAway: true, sent: false,
          note: "Their earlier card for this estimate was being sent at that very moment, so this new one was put away and nothing was sent from it. Tell them in a sentence.",
        });
      }
      const same = sameNameForClaude(twin, "card", "email");
      return ok({
        // The last send comes from their record's recent history, which can leave an older one out, so
        // a missing date is left out rather than told as "never sent".
        shown: true, estimate: est.number, ageDays: est.ageDays, ...(est.lastSentAt ? { lastSentOn: est.lastSentAt.slice(0, 10) } : {}),
        ...(same ? { sameName: same } : {}),
        ...(ruleNotes.length ? { rules: ruleNotes } : {}),
        ...(replaced ? { replacedOlderCards: replaced } : {}),
        ...(unproven ? { unproven: UNPROVEN_DAYS } : {}),
        note: "The estimate is on the person's screen with an Approve button. Nothing has been sent: it goes only when the person presses Approve on the card, which emails it right away. You can't press it, and typing \"yes, send it\" in the chat doesn't send it. Tell them in a sentence which estimate it is, to press Approve on the card when it's right, that it goes to the address saved on the estimate, and that its sent date moves to today."
          + (ruleNotes.length ? " Say what the card says about their rules." : ""),
      });
    } finally {
      if (!shown) giveCardSlot(s);
    }
  },
};

const estimateResendKind: KindSpec = {
  kind: "estimate_resend",
  // resend_quote_email is designs edit; opening the card shows the customer's name and deal.
  areas: () => ["designs"],
  readAreas: () => ["contacts", "designs"],
  switches: () => ["customers", SENDS_SWITCH],
  private: true,
  where: RESEND_WHERE,
  gaveUp: SEND_SAID.unsure,
  sends: true,
  nothingToDo: (p) => (contactIdOf(p.payload?.contactId) && typeof p.payload?.dealKey === "string" && p.payload.dealKey && typeof p.payload?.estimateNumber === "string" && p.payload.estimateNumber ? null : SEND_SAID.nothing),
  apply: (deps, who, p, progress) => applyResend(deps, who, p, progress),
};

export const sendsPiece: Piece = {
  name: "sends",
  tools: [resendTool],
  kinds: [replySendKind, estimateResendKind],
  can: [
    "Email one of a customer's Structure Studio estimates to them again: read them with look_at_customer_for_reply, then put it on the screen with propose_estimate_resend. The person presses Approve on the card, which emails it right away.",
  ],
  rules: [
    "A card that sends (a text, an email, or an estimate emailed again) has Approve like every other card, and pressing Approve sends it right away (a text only inside texting hours where they live; before then a press sends nothing). Only the person can press it: you can't, and typing \"yes, send it\" in the chat doesn't send it, so tell them to press Approve on the card. Never tell them to press Send: that's the chat box's own button. One card goes to one customer, once, and a message can't be taken back once it's sent.",
  ],
};

/** For the tests: every card kind this piece writes. */
export const SEND_KINDS = sendsPiece.kinds.map((k) => k.kind);

// ── "Sent by Mike with Jack" (migration 378) ──────────────────────────────────────────────────────

type StampLog = (e: { code: string; message: string; severity: "error" | "warn" | "info"; context: Record<string, unknown> }) => Promise<void>;

/** Deps.markSentWithJack, built by index.ts with ⚠️ ITS SERVICE-ROLE CLIENT and the caller's resolved
 *  builder. Here so the tests can drive it with a fake client. Right after a send route says sent, the
 *  row it answered with gets sent_with = 'jack', and sent_by = the person who pressed Approve where the
 *  route left it null (resend_quote_email does). By the row's id, on THIS builder only, and only where
 *  each column is still null, so it can never re-mark or re-attribute a row. It never throws: a failed
 *  write is logged (no message words, only the table, the row id and the database's code) and answers
 *  false, and the caller still counts the message as sent. Before 378 is applied the column is missing
 *  (42703, or PostgREST's PGRST204): that is the deploy window, logged as info. */
// deno-lint-ignore no-explicit-any
export function makeSentWithJack(admin: any, clientId: string, log: StampLog) {
  return async (table: Ledger, id: string, by: string | null): Promise<boolean> => {
    if ((table !== "sms_messages" && table !== "email_sends") || !UUID.test(String(id ?? "")) || !clientId) return false;
    const heard = async (what: string, error: { code?: string; message?: string }) => {
      const missing = error.code === "42703" || error.code === "PGRST204";
      // Who pressed Approve not landing on a row the route left unnamed (a resend) is an error: the row then
      // says "with Jack" and names nobody (crmFeed.ts), so it is worth a look.
      await log({
        code: missing ? "jack_sent_with_unapplied" : "jack_sent_with_failed", severity: missing ? "info" : what === "sent_by" ? "error" : "warn",
        message: missing ? "sent_with isn't on the table yet (migration 378)." : `A sent message couldn't be marked as sent with Jack (${what}).`,
        context: { table, id, dbCode: error.code ?? null },
      }).catch(() => undefined);
    };
    try {
      // The person first: sent_by is there before 378, so a resend still names who sent it.
      if (by && UUID.test(by)) {
        const who = await admin.from(table).update({ sent_by: by }).eq("id", id).eq("client_id", clientId).is("sent_by", null);
        if (who?.error) await heard("sent_by", who.error);
      }
      const { data, error } = await admin.from(table).update({ sent_with: "jack" }).eq("id", id).eq("client_id", clientId).is("sent_with", null).select("id");
      if (error) {
        await heard("sent_with", error);
        return false;
      }
      return (data ?? []).length > 0;
    } catch (e) {
      await heard("threw", { message: String((e as Error)?.message ?? "") });
      return false;
    }
  };
}
