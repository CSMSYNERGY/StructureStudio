// jack-agent: what a v2 card says about Carolyn's rules the change would set off (ruleWarn_test.ts).
//
// A record change Jack makes (a job scheduled, a load delivered, a change order sent) fires the same
// rule events a person's button does, so a rule may text or email the customer. Every card says so
// before Approve (plan 5.9). The events are crmRules.ts RULE_EVENTS / RULE_CONTACT_EVENTS keys. A
// message Jack sends has its own lines (sendRuleNotes, below).
//
//   - Someone who can read Automations (settings_crm view) hears which rules, by name: the enabled,
//     unarchived event rules that start on one of these events, and the days-after rules counting from
//     delivery when "delivered" is among them.
//   - Anyone else hears a general sentence and no names: they can't open those rules by hand, so Jack
//     doesn't show them (the cautious default, 11-06).
//   - A list that can't be read says the general sentence too, so a card never claims "no rules" on a
//     read that failed. Customer Hub off (no rules can run) says nothing.

import type { Deps } from "./types.ts";
import { readList } from "./rules.ts";
import { isOutboundAction } from "../_shared/crmRules.ts";
import { scrub } from "./redact.ts";
import { SAID } from "./common.ts";

export interface RuleWarning {
  /** The rules that would start, by name, when the person may see them. Empty otherwise. */
  named: string[];
  /** Whether a rule that would start texts or emails the customer (true when it can't be told). */
  messages: boolean;
  /** The sentence for the card, or null when no rule would start. */
  sentence: string | null;
}

export const RULE_WARN_SAID = {
  general: "If one of your rules starts on this, it may text or email the customer by itself.",
  unread: "I couldn't check your rules just now. If one starts on this, it may text or email the customer by itself.",
};

const quoteList = (names: string[]) =>
  names.length === 1 ? `"${names[0]}"` : `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names[names.length - 1]}"`;

/** The rules a change firing `events` would start, and the card's sentence about them. Never throws. */
export async function ruleWarning(deps: Deps, events: string[]): Promise<RuleWarning> {
  if (!events.length) return { named: [], messages: false, sentence: null };
  if (!deps.canRead("settings_crm")) return { named: [], messages: true, sentence: RULE_WARN_SAID.general };
  let read: Awaited<ReturnType<typeof readList>>;
  try {
    read = await readList(deps);
  } catch {
    return { named: [], messages: true, sentence: RULE_WARN_SAID.unread };
  }
  if ("error" in read) {
    // No Customer Hub on this account: no rule can run, so there is nothing to warn about.
    if (read.error === SAID.noCrm || /Customer Hub/i.test(read.error)) return { named: [], messages: false, sentence: null };
    return { named: [], messages: true, sentence: RULE_WARN_SAID.unread };
  }
  const want = new Set(events);
  const hits = read.list.rules.filter((r) =>
    r.enabled && r.stale.length === 0 && (
      (r.triggerKind === "event" && r.triggerEvent !== null && want.has(r.triggerEvent)) ||
      (r.triggerKind === "elapsed" && r.elapsedAnchor === "delivered" && want.has("delivered"))
    ));
  if (!hits.length) return { named: [], messages: false, sentence: null };
  const named = hits.map((r) => scrub(r.name ?? "A rule with no name", 80));
  const messages = hits.some((r) => r.actions.some((a) => isOutboundAction(a.kind)));
  const later = hits.every((r) => r.triggerKind === "elapsed");
  const what = messages ? "texts or emails the customer by itself" : "runs by itself";
  const verb = later ? "starts the clock on" : "sets off";
  const sentence = `This ${verb} your rule${named.length === 1 ? "" : "s"} ${quoteList(named)}, which ${what}${named.length === 1 ? "" : " (one or more of them)"}.`;
  return { named, messages, sentence };
}

// ── What a message Jack sends can set off (sends.ts, drafts.ts; default 10, 11-06) ─────────────────
//
// A text writes an sms_messages row, which can set off "contact made" (353: once the thread runs both
// ways, on every write) and moves the "last contact" clock that "no contact for N days" rules count from
// (363 crm_rule_last_contact counts texts and calls, never email). An email, or an estimate sent again,
// writes an email_sends row, which can set off "they open an email" and "an email bounces" later (367).
// Re-sending an estimate changes no status, so it sets off no "estimate sent" rule (302).

export type SendWhat = "text" | "email" | "estimate";

export const SEND_RULE_SAID = {
  text: "If one of your rules starts when contact is made, this text can set it off. It also restarts the clock on rules that count the days since anyone last spoke to them.",
  email: "If one of your rules starts when they open an email or an email bounces, this email can set it off later.",
  estimate: "If one of your rules starts when they open an email or an email bounces, this estimate email can set it off later.",
  unread: "I couldn't check your rules just now.",
};

/** The card's lines about the rules a message would set off. Names only for someone who can open
 *  Automations; anyone else hears what kind of rule, never which. Nothing when no rule would start, or
 *  when the account has no Customer Hub (no rule can run). Never throws. */
export async function sendRuleNotes(deps: Deps, what: SendWhat): Promise<string[]> {
  const general = [SEND_RULE_SAID[what]];
  if (!deps.canRead("settings_crm")) return general;
  let read: Awaited<ReturnType<typeof readList>>;
  try {
    read = await readList(deps);
  } catch {
    return [`${SEND_RULE_SAID.unread} ${SEND_RULE_SAID[what]}`];
  }
  if ("error" in read) {
    if (read.error === SAID.noCrm || /Customer Hub/i.test(read.error)) return [];
    return [`${SEND_RULE_SAID.unread} ${SEND_RULE_SAID[what]}`];
  }
  const live = read.list.rules.filter((r) => r.enabled && r.stale.length === 0);
  const name = (r: { name: string | null }) => scrub(r.name ?? "A rule with no name", 80);
  const does = (rs: typeof live) => (rs.some((r) => r.actions.some((a) => isOutboundAction(a.kind))) ? "texts or emails the customer by itself" : "runs by itself");
  const rule = (rs: typeof live) => `your rule${rs.length === 1 ? "" : "s"} ${quoteList(rs.map(name))}`;
  const some = (rs: typeof live) => (rs.length === 1 ? "" : " (one or more of them)");
  const out: string[] = [];
  if (what === "text") {
    const made = live.filter((r) => r.triggerKind === "event" && r.triggerEvent === "contact_made");
    const clock = live.filter((r) => r.triggerKind === "elapsed" && r.elapsedAnchor === "last_contact");
    if (made.length) out.push(`This text can set off ${rule(made)} (${made.length === 1 ? "it starts" : "they start"} when contact is made), which ${does(made)}${some(made)}.`);
    if (clock.length) out.push(`It restarts the clock on ${rule(clock)}, which ${clock.length === 1 ? "counts" : "count"} the days since anyone last spoke to them.`);
  } else {
    // Each line names only what really starts its rules: an open can't set off a bounce rule, nor a
    // bounce an open rule.
    const email = what === "estimate" ? "the estimate email" : "this email";
    const opened = live.filter((r) => r.triggerKind === "event" && r.triggerEvent === "email_opened");
    const bounced = live.filter((r) => r.triggerKind === "event" && r.triggerEvent === "email_bounced");
    if (opened.length) out.push(`If they open ${email}, that can set off ${rule(opened)} later, which ${does(opened)}${some(opened)}.`);
    if (bounced.length) out.push(`If ${email} bounces, that can set off ${rule(bounced)} later, which ${does(bounced)}${some(bounced)}.`);
  }
  return out;
}
