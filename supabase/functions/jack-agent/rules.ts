// jack-agent: Carolyn's when/then rules, the Automations tab (rules_test.ts).
//
// Jack reads a builder's rules back in plain words, says what a rule did lately (counts only), writes a
// new rule from a sentence, and pauses or turns one back on. Plan section 5.6, as Automations stands on
// beta: a rule says who it is for (one pipeline, every pipeline, customers, or the team), starts on an
// event, a number of days after something, or a schedule, may carry "only if" conditions, and does up to
// ten steps, two of which message the customer.
//
// THE RULES
//   - Claude never saves a rule. propose_rule writes one card through putCard. Only a person's Approve
//     sends crm_rule_save, ONCE, with exactly the body on the card. crm_rule_save has no repeat guard and
//     writes the steps in a second step (portal-settings), so a lost answer is never sent again: Jack
//     reads the list again and looks for the rule it made.
//   - Everything goes through portal-settings with the caller's own token: crm_rules_list and
//     crm_rule_log at settings_crm view, crm_rule_save at settings_crm edit, and the Customer Hub
//     subscription that every crm_ action checks.
//   - The request is checked with Carolyn's own parsers (_shared/crmRules.ts, imported, never copied),
//     so Jack refuses what her save would refuse, in her words. Her save is still the truth: a 400 or 409
//     goes on the card as it is. ⚠️ That import is bundled into jack-agent, so jack-agent is redeployed
//     whenever crmRules.ts changes.
//   - Version 1 (Ahsan, 11-06): event and days-after rules that act on one card or customer at a time,
//     and schedules only for reminders to the team. No schedule or customer-filter rule that messages a
//     group: that is "Message many", version 2. Promotions are refused, by text and by email.
//   - What a rule sends (11-09): no promotion (promo.ts, the screen replies get too), no dollar amount, no
//     warranty, guarantee or promise, and no day, date, time or deadline, since it sends the same words to
//     everyone whenever it runs. Checked when the card is made and again at its Approve.
//   - Paid in full is the only payment event (plan 5.6). "A payment comes in" fires on a deposit too, so
//     Jack doesn't offer it, refuses a rule that names it, and doesn't turn on one made by hand.
//   - Undo pauses the rule ({id, enabled:false}), and only when what it does is unchanged since Jack
//     saved it. Pausing also stops a message the rule already queued, a text held for the morning
//     included: crm-rules-tick skips a queued message whose rule is paused or removed (2026-11-06).
//   - Undo of a pause turns a rule on, so it asks resumeBlock first, the same check a turn-on card gets.
//     A rule Jack wouldn't turn on stays paused, and the pause card says so before Approve. Undo of a
//     turn-on (it pauses) is never refused: stopping is always allowed.
//   - No customer data reaches Claude from here: rules are the builder's words, and run counts carry no
//     names. Free text is scrubbed anyway, so a phone number in a rule's text stays on the card.

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, TurnState, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { scrub } from "./redact.ts";
import { claimHit, looksPromotional, moneyIn, promoHit, spelledAmountHit } from "./promo.ts";
import {
  actionAllowedForScope, actionScopeError, audienceLabel, isOutboundAction, parseRuleConditions, parseRuleSave,
  RULE_ACTION_KINDS, RULE_ACTION_LABELS, RULE_ANCHORS, RULE_CONDITION_FIELDS, RULE_CONDITION_OPS, RULE_CONTACT_EVENTS,
  RULE_CONTACT_SOURCES, RULE_DEAL_SOURCES, RULE_EVENTS, RULE_MERGE_FIELDS, type RuleActionKind, type RuleCondition,
  type RuleNeed, type RuleSchedule, ruleSentence,
} from "../_shared/crmRules.ts";

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

export const WHERE = "Settings > Customer Hub > Automations";

/** Steps that send a builder's data out of StructureStudio (beta's 370: a webhook, a GoHighLevel push).
 *  Jack never writes them (11-09, the cautious side): a rule runs by itself, and an address Claude put
 *  in a rule could hand customer details to anyone. They're left out of the tool's list, refused at the
 *  tool, and refused again at Approve for a card that names one. The builder adds them by hand. */
export const JACK_NEVER_ACTIONS: ReadonlySet<string> = new Set(["webhook", "ghl_push"]);
export const JACK_ACTION_KINDS = RULE_ACTION_KINDS.filter((k) => !JACK_NEVER_ACTIONS.has(k));

export const RULE_SAID = {
  notOn: "Automations aren't switched on for this account yet.",
  noCrm: "Automations are part of Customer Hub, which isn't on this account's subscription, so I can't set up rules here.",
  promotion: `Rule texts can only be about a customer's own estimate and building, and rule emails still need a postal address and their own sending account before a promotion can go out. You can write one by hand in ${WHERE}.`,
  promotionName: (w: string) => `The rule's name reads like a promotion ("${w}"). Name it after what it does, and I'll show it.`,
  scheduleTeamOnly: `In this version I only write schedules that remind your team. A schedule that reaches many cards or customers at once is set up by hand in ${WHERE}, where you arm it with the count.`,
  customersNoMessages: `In this version I don't write rules that text or email customers picked by a filter. A rule on a pipeline can still message each customer as their card moves. A group one is set up by hand in ${WHERE}.`,
  noPrice: "A rule sends the same words to every customer, so I leave dollar amounts out of its messages.",
  noPromise: "A rule sends the same words to every customer, so I leave warranties, guarantees, promises and engineering or code claims out of its messages.",
  noDate: "A rule sends the same words to every customer, whenever it runs, so I leave days, dates, times and deadlines out of its messages.",
  paidInFullOnly: "I can set a rule on a payment only when it's paid in full. A deposit or a part payment can't start a rule I write.",
  noDataOut: `I don't add steps that send your data out of StructureStudio, like a webhook or a GoHighLevel push. Add that step yourself in ${WHERE}.`,
  pickEvent: "Pick what happens from the list.",
  pickAnchor: "Pick what the days are counted from.",
  noRef: "I couldn't find that rule. Look at the rules again with look_at_my_rules and use its ref.",
  editedSince: `Someone changed what this rule does since I made it, so I left it as it is. Pause or remove it in ${WHERE}.`,
  gone: `That rule isn't in ${WHERE} any more.`,
  unsure: `I couldn't tell if that saved. Check ${WHERE} before trying again.`,
  readAgain: "I couldn't read your rules just now. Press Undo to try again.",
  changedSinceShown: "This rule changed since I showed it, so I didn't turn it on. Ask me again.",
  halfRemoved: "That rule saved without its steps, so I removed it again. Nothing will run. Ask me again in a moment.",
  halfLeft: `A rule with no steps may be left in ${WHERE}. Remove it there.`,
  staleResume: `That rule points at something that was removed, so it would fail every time. Fix it in ${WHERE} first.`,
  promotionResume: `That rule's messages read like a promotion, and I don't put those live: texts can only be about a customer's own estimate and building, and rule emails still need a postal address and their own sending account. You can turn it on by hand in ${WHERE}.`,
  paymentResume: `That rule starts when any payment comes in, a deposit included, and I don't put those live. I only turn on payment rules that start when it's paid in full. You can turn it on by hand in ${WHERE}.`,
  alreadyOff: "Someone paused that rule since I made this card, so nothing changed.",
  alreadyOn: "Someone turned that rule on since I made this card, so nothing changed.",
};

/** A route's sentence, made plain for a person: her sentences use a dash as a pause. */
export const plain = (s: string) => s.replace(/\s*—\s*/g, ": ").replace(/\s+/g, " ").trim();

/** Ahsan, 11-06: version 1 doesn't write a customer-filter rule that messages customers. Flip this when
 *  "Message many" ships (version 2); the schedule limit is separate. */
export const CUSTOMER_SCOPE_MAY_MESSAGE = false;

// ── What crm_rules_list answers (portal-settings, the AUTOMATIONS block) ─────────────────────────────

interface Named { id: string; name: string | null }
interface Pipe { id: string; name: string | null; stages: Named[]; statuses: Named[]; lostReasons: string[] }
interface Mate { userId: string; name: string | null }
export interface ListRule {
  id: string; name: string | null; scopeKind: string; pipelineId: string | null;
  triggerKind: string; triggerEvent: string | null; elapsedAnchor: string | null; elapsedDays: number | null;
  schedule: RuleSchedule | null; conditions: { field: string; op: string; value: unknown }[];
  oncePerCard: boolean; enabled: boolean; appliesFrom: string | null;
  actions: { kind: string; params: Record<string, unknown> }[];
  nextRunAt: string | null; armedCount: number | null; lastRun: { outcome: string; firedAt: string } | null; stale: string[];
}
export interface RulesList { pipelines: Pipe[]; team: Mate[]; canManage: boolean; rules: ListRule[]; labels: string[]; timeZone: string }

// deno-lint-ignore no-explicit-any
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const strOr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A refusal's sentence: the route's own, except that the subscription one names Automations. */
export function refusalOf(r: { status: number; data: Record<string, unknown> | null }, fallback: string): string {
  const said = saidBy(r, fallback);
  return said === SAID.noCrm ? RULE_SAID.noCrm : plain(said);
}

/** The list, whole, or the sentence to say. A cut-short answer is never the base of a rule. */
export async function readList(deps: Deps): Promise<{ list: RulesList } | { error: string }> {
  const r = await deps.portal("crm_rules_list", {});
  if (r.status === 403) return { error: refusalOf(r, SAID.noSee) };
  if (r.status !== 200 || !r.data) return { error: SAID.readFailed };
  const d = r.data;
  if (!(Number(d.rulesVersion) >= 2)) return { error: RULE_SAID.notOn };
  if (!Array.isArray(d.rules) || !Array.isArray(d.pipelines)) return { error: SAID.readFailed };
  const named = (x: unknown): Named[] => arr(x).filter((t) => t && typeof t.id === "string").map((t) => ({ id: String(t.id).toLowerCase(), name: strOr(t.name) }));
  return {
    list: {
      pipelines: d.pipelines.filter((p) => p && typeof p.id === "string").map((p) => ({
        id: String(p.id).toLowerCase(), name: strOr(p.name), stages: named(p.stages), statuses: named(p.statuses),
        lostReasons: arr(p.lostReasons).filter((x) => typeof x === "string"),
      })),
      team: arr(d.team).filter((m) => m && typeof m.userId === "string").map((m) => ({ userId: String(m.userId).toLowerCase(), name: strOr(m.name) })),
      canManage: d.canManage === true,
      labels: arr(d.labels).filter((x) => typeof x === "string"),
      timeZone: typeof d.timeZone === "string" ? d.timeZone : "America/Chicago",
      rules: d.rules.filter((x) => x && typeof x.id === "string").map((x) => ({
        id: String(x.id).toLowerCase(), name: strOr(x.name), scopeKind: String(x.scopeKind ?? "pipeline"),
        pipelineId: typeof x.pipelineId === "string" ? x.pipelineId.toLowerCase() : null,
        triggerKind: String(x.triggerKind ?? ""), triggerEvent: strOr(x.triggerEvent),
        elapsedAnchor: strOr(x.elapsedAnchor), elapsedDays: typeof x.elapsedDays === "number" ? x.elapsedDays : null,
        schedule: x.schedule && typeof x.schedule === "object" ? x.schedule as RuleSchedule : null,
        conditions: arr(x.conditions), oncePerCard: x.oncePerCard === true, enabled: x.enabled === true,
        appliesFrom: strOr(x.appliesFrom),
        actions: arr(x.actions).map((a) => ({ kind: String(a?.kind ?? ""), params: a?.params && typeof a.params === "object" ? a.params : {} })),
        nextRunAt: strOr(x.nextRunAt), armedCount: typeof x.armedCount === "number" ? x.armedCount : null,
        lastRun: x.lastRun && typeof x.lastRun === "object" ? { outcome: String(x.lastRun.outcome ?? ""), firedAt: String(x.lastRun.firedAt ?? "") } : null,
        stale: arr(x.stale).map(String),
      })),
    },
  };
}

// ── Refs: a short code per rule, stable across turns, never the uuid ────────────────────────────────

// Hex spelled in letters, so a ref is never a run of digits (redact.ts would read seven as a phone).
const LETTERS = "bcdfghjkmnpqrstv";
const spell = (id: string) => id.replace(/[^0-9a-f]/gi, "").toLowerCase().split("").map((c) => LETTERS[parseInt(c, 16)]).join("");

/** Each rule's ref: "r" and the shortest spelling of its id (5 letters or more) no other rule shares. */
export function refsFor(ids: string[]): Map<string, string> {
  const spelled = ids.map(spell);
  const out = new Map<string, string>();
  ids.forEach((id, i) => {
    let n = 5;
    while (n < spelled[i].length && spelled.some((s, j) => j !== i && s.startsWith(spelled[i].slice(0, n)))) n++;
    out.set(id, "r" + spelled[i].slice(0, n));
  });
  return out;
}

/** The rule a ref names: its spelling must start the id's, and only one rule may match. */
export function ruleByRef(list: RulesList, ref: unknown): ListRule | null {
  const want = String(ref ?? "").trim().toLowerCase().replace(/^r/, "");
  if (want.length < 5 || !/^[bcdfghjkmnpqrstv]+$/.test(want)) return null;
  const hits = list.rules.filter((x) => spell(x.id).startsWith(want));
  return hits.length === 1 ? hits[0] : null;
}

// ── Saying a rule ─────────────────────────────────────────────────────────────────────────────────

const OP_WORDS: Record<string, string> = { eq: "is", neq: "is not", gt: "is more than", lt: "is less than", has: "include", lacks: "don't include" };
const nameOf = (list: Named[], id: unknown) => list.find((x) => x.id === String(id ?? "").toLowerCase())?.name ?? "one that was removed";
const mateName = (team: Mate[], id: unknown) => {
  const m = team.find((x) => x.userId === String(id ?? "").toLowerCase());
  return m ? m.name ?? "a teammate with no name set" : "someone no longer on the team";
};

function conditionWords(c: { field: string; op: string; value: unknown }, pipe: Pipe | null, team: Mate[]): string {
  const spec = RULE_CONDITION_FIELDS[c.field];
  if (!spec) return "a check that no longer exists";
  if (spec.type === "bool") {
    const yes = c.value === true;
    if (c.field === "deal.lost") return yes ? "The card is lost" : "The card is not lost";
    if (c.field === "contact.has_phone") return yes ? "The customer has a phone number" : "The customer has no phone number";
    return yes ? "The customer has an email address" : "The customer has no email address";
  }
  if (c.field === "contact.owner" && c.op === "is_empty") return "The customer has no owner";
  if (c.field === "contact.owner" && c.op === "not_empty") return "The customer has an owner";
  let v: string;
  if (spec.type === "money") v = "$" + Number(c.value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  else if (spec.type === "status") v = pipe ? nameOf(pipe.statuses, c.value) : "a status";
  else if (spec.type === "stage") v = pipe ? nameOf(pipe.stages, c.value) : "a stage";
  else if (spec.type === "owner") v = mateName(team, c.value);
  else if (spec.type === "choice") v = RULE_DEAL_SOURCES[String(c.value)] ?? String(c.value);
  else if (spec.type === "contact_source") v = RULE_CONTACT_SOURCES[String(c.value)] ?? String(c.value);
  else if (spec.type === "number") v = `${c.value} days`;
  else v = String(c.value ?? "");
  const label = spec.type === "number" ? spec.label.replace(/^Days since/, "The days since") : spec.label;
  return `${label} ${OP_WORDS[c.op] ?? c.op} ${v}`;
}

export interface StepView { kind: string; says: string; subject?: string; text?: string; outbound: boolean }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One step in words. `cut` caps the free text (for Claude); the card gets it whole. */
function stepView(a: { kind: string; params: Record<string, unknown> }, pipe: Pipe | null, list: Pick<RulesList, "pipelines" | "team">, cut?: number): StepView {
  const p = a.params ?? {};
  const label = (RULE_ACTION_LABELS[a.kind as RuleActionKind] ?? a.kind).replace(/…$/, "").trim();
  const words = (s: unknown) => (cut ? scrub(s, cut) : String(s ?? ""));
  // Names people typed (a teammate's, a status's, a pipeline's) are free text too: scrubbed for Claude.
  const nm = (s: string) => (cut ? scrub(s, 80) : s);
  let says = label;
  let subject: string | undefined;
  let text: string | undefined;
  switch (a.kind) {
    case "set_status": says = `Set the status to ${pipe ? nm(nameOf(pipe.statuses, p.statusId)) : "a status"}`; break;
    case "move_stage": says = `Move the card to the ${pipe ? nm(nameOf(pipe.stages, p.stageId)) : "chosen"} stage`; break;
    case "mark_lost": says = "Mark it lost"; text = words(p.reason); break;
    case "set_follow_up": says = `Set a follow-up in ${plural(Number(p.days ?? 0), "day", "days")}`; break;
    case "set_close_date": says = `Set the expected close date ${plural(Number(p.days ?? 0), "day", "days")} out`; break;
    case "add_note": says = "Add a note to the customer"; text = words(p.body); break;
    case "create_card": says = `Create a card in ${nm(nameOf(list.pipelines, p.pipelineId))}`; if (p.title) subject = words(p.title); break;
    case "add_label": says = `Add the tag ${words(p.label)}`; break;
    case "remove_label": says = `Remove the tag ${words(p.label)}`; break;
    case "assign_owner": says = `Assign the customer to ${nm(mateName(list.team, p.userId))}`; break;
    case "create_task": {
      const days = Number(p.dueDays ?? 0);
      says = `Create a task, due ${days ? `in ${plural(days, "day", "days")}` : "the same day"}${p.assigneeUserId ? `, for ${nm(mateName(list.team, p.assigneeUserId))}` : ""}`;
      subject = words(p.title);
      break;
    }
    case "notify_team": {
      const ids = arr(p.userIds);
      says = `Email your team (${ids.length ? ids.map((u) => nm(mateName(list.team, u))).join(", ") : "the owners and admins"})`;
      subject = words(p.subject); text = words(p.body);
      break;
    }
    case "send_sms": says = "Send the customer a text"; text = words(p.body); break;
    case "send_email": says = "Send the customer an email"; subject = words(p.subject); text = words(p.body); break;
  }
  return { kind: a.kind, says, ...(subject ? { subject } : {}), ...(text ? { text } : {}), outbound: isOutboundAction(a.kind) };
}

function onceWords(triggerKind: string, oncePerCard: boolean, scope: string): string {
  const per = scope === "contacts" ? "customer" : "card";
  if (triggerKind === "schedule") return "Each time it runs";
  if (triggerKind === "event" && !oncePerCard) return "Every time it happens";
  return `Once per ${per}`;
}

const STALE: Record<string, string> = { pipeline_gone: "its pipeline was removed" };
const staleWords = (s: string) => STALE[s] ?? (/^action:(\d+)$/.test(s) ? `step ${Number(s.split(":")[1]) + 1} points at something that was removed`
  : /^condition:(\d+)$/.test(s) ? `only-if ${Number(s.split(":")[1]) + 1} points at something that was removed` : "something in it needs fixing");

const dayOf = (iso: unknown) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/** A stored rule in words, for Claude. Names, never ids; free text scrubbed. */
function ruleForClaude(x: ListRule, list: RulesList, ref: string) {
  const pipe = x.scopeKind === "pipeline" ? list.pipelines.find((p) => p.id === x.pipelineId) ?? null : null;
  const pipes = list.pipelines.map((p) => ({ id: p.id, name: p.name ?? "A pipeline" }));
  return {
    ref,
    name: x.name ? scrub(x.name, 120) : null,
    on: x.enabled,
    sentence: scrub(ruleSentence({ ...x, actions: x.actions }), 400),
    whoFor: scrub(audienceLabel(x, pipes), 120),
    ...(x.conditions.length ? { onlyIf: x.conditions.map((c) => scrub(conditionWords(c, pipe, list.team), 200)) } : {}),
    steps: x.actions.map((a) => stepView(a, pipe, list, 1500)),
    runs: onceWords(x.triggerKind, x.oncePerCard, x.scopeKind),
    ...(x.triggerKind === "schedule" ? { nextRun: dayOf(x.nextRunAt), armed: x.armedCount !== null } : {}),
    lastRun: x.lastRun ? { outcome: x.lastRun.outcome, on: dayOf(x.lastRun.firedAt) } : null,
    ...(x.stale.length ? { needsFixing: x.stale.map(staleWords) } : {}),
  };
}

// ── The shape: what a rule does, for "has anyone changed it since?" ─────────────────────────────────

/** Sorted keys, so two copies of the same thing read the same. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

interface ShapeIn {
  scopeKind: string | null; pipelineId: string | null; triggerKind: string | null; triggerEvent: string | null;
  elapsedAnchor: string | null; elapsedDays: number | null; schedule: unknown; conditions: unknown[]; oncePerCard: boolean;
  actions?: { kind: string; params: Record<string, unknown> }[];
}
/** What it does. Not the name (a rename isn't a new rule), and not whether it's on. */
function shapeKey(s: ShapeIn, withActions = true): string {
  const t = s.triggerKind;
  return stable({
    scope: s.scopeKind, pipeline: s.scopeKind === "pipeline" ? s.pipelineId : null, trigger: t,
    event: t === "event" ? s.triggerEvent : null,
    anchor: t === "elapsed" ? s.elapsedAnchor : null, days: t === "elapsed" ? s.elapsedDays : null,
    schedule: t === "schedule" ? s.schedule : null,
    conditions: s.conditions, once: s.oncePerCard,
    ...(withActions ? { actions: (s.actions ?? []).map((a) => ({ kind: a.kind, params: a.params })) } : {}),
  });
}
export const shapeOfListRule = (x: ListRule, withActions = true) => shapeKey(x, withActions);

/** A save body's shape, as the route will store it: through the same parsers. Null when it doesn't parse. */
export function shapeOfBody(body: Record<string, unknown>, withActions = true): string | null {
  const rl = parseRuleSave(body);
  if (!rl.ok || !rl.scopeKind) return null;
  const pc = parseRuleConditions(body.conditions ?? [], rl.scopeKind);
  if (!pc.ok) return null;
  return shapeKey({ ...rl, conditions: pc.conditions, oncePerCard: rl.oncePerCard ?? true, actions: rl.actions ?? [] }, withActions);
}

// ── Version 1's limits ────────────────────────────────────────────────────────────────────────────

/** What version 1 won't write or turn on, or null. */
export function v1Refusal(scope: string, triggerKind: string | null, actionKinds: string[]): string | null {
  if (triggerKind === "schedule" && scope !== "none") return RULE_SAID.scheduleTeamOnly;
  if (scope === "contacts" && !CUSTOMER_SCOPE_MAY_MESSAGE && actionKinds.some(isOutboundAction)) return RULE_SAID.customersNoMessages;
  return null;
}

// The promotion screen on what a rule sends is promo.ts's, the same one a reply gets (11-09). The system
// prompt tells Claude to refuse too; the screen is the part that holds when Claude doesn't. "Bill of sale"
// and "special order" are how sheds are sold, so they pass.
export { looksPromotional };

const firstOf = (res: RegExp[], text: string): string | null => {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
};

// What a rule's message may say (11-09). A rule sends the same words to every customer, whenever it runs (a
// text can wait for 8am, a days-after rule can run weeks later), so it carries no warranty, guarantee or
// promise, and no day, date, time or deadline. Claude is told so; these screens hold when it isn't. They
// read what goes to the customer (a text, a customer email), not the team's own reminders. The merge fields
// pass: none is a date, and a rule has no {{date}} to fill. They lean to catching more, because a refusal
// only goes back to Claude to word again.

const PROMISES: RegExp[] = [
  /\bpromis(?:e|es|ed|ing)\b/i,
  /\bguarantee(?:d|s|ing)?\b/i, /\bguaranty\b/i,
  /\bwarrant(?:y|ies|ied|s)?\b/i,
  /\blifetime\b/i,
  /\b(?:risk|worry|hassle|maintenance|trouble)[-\s]free\b/i,
  /\bmoney[-\s]back\b/i,
  /\bfree\s+of\s+charge\b/i, /\b(?:at\s+)?no\s+(?:extra\s+|additional\s+)?(?:charge|cost)\b/i,
  /\b(?:100\s?%|fully|completely|totally)\s+(?:satisfied|satisfaction|covered|protected|insured)\b/i,
  /\b(?:rust|rot|leak|water|weather|storm|termite|fire|pest|bullet|fade)[-\s]?proof\b/i,
  /\b(?:will\s+)?never\s+(?:rust|rot|leak|fade|crack|warp|sag|peel|break|fail)s?\b/i,
  /\bwon'?t\s+(?:ever\s+)?(?:rust|rot|leak|fade|crack|warp|sag|peel|break|fail)\b/i,
  /\b(?:lasts?|built\s+to\s+last)\s+(?:a\s+lifetime|forever|for\s+(?:decades|generations|life))\b/i, /\bbuilt\s+to\s+last\b/i,
];

/** The first warranty, guarantee, promise or engineering or code claim in a rule's message, or null. */
export const promiseHit = (text: string): string | null => claimHit(text) ?? firstOf(PROMISES, String(text ?? ""));

const MONTH_ANY = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?";
// "May" alone is a word ("you may"), so it counts only beside a day number.
const MONTH_NOT_MAY = "(?:january|february|march|april|june|july|august|september|october|november|december)";
const COUNT = "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[-\\s]?eight|twenty[-\\s]?four|a\\s+few|a\\s+couple(?:\\s+of)?|few|couple(?:\\s+of)?|several)";
const SPAN = "(?:business\\s+|working\\s+|calendar\\s+)?(?:minutes?|mins?|hours?|hrs?|days?|nights?|weeks?|wks?|months?|years?)";
const LEAD = "(?:on|by|for|until|till|til|before|after|around|from|thru|through|starting|since|due)";

const DATES: RegExp[] = [
  // Days: Friday, the weekend, today, tomorrow, next week, end of the month.
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/i, /\b(?:tues|thurs|weds)\b/i, /\bweekends?\b/i,
  /\b(?:today|tonight|tomorrow|tmrw|yesterday)\b/i,
  /\b(?:this|next|last|coming|following)\s+(?:week|month|year|season|spring|summer|fall|autumn|winter)\b/i,
  /\b(?:this|tomorrow|in\s+the|by\s+the)\s+(?:morning|afternoon|evening)\b/i,
  /\b(?:end|start|beginning|middle|first|last)\s+of\s+(?:the\s+|this\s+|next\s+)?(?:week|month|year|day|season)\b/i,
  /\b(?:same|next)[-\s]day\b/i,
  // Holidays and seasons: by Christmas, before winter.
  /\b(?:christmas|xmas|thanksgiving|easter|halloween|new\s+year'?s?|memorial\s+day|labor\s+day|independence\s+day|(?:4th|fourth)\s+of\s+july|presidents'?\s+day|veterans'?\s+day|holidays?)\b/i,
  /\b(?:by|before|until|till|this|next|last|in\s+the|in|early|late|mid|end\s+of|start\s+of)\s+(?:spring|summer|fall|autumn|winter)\b/i,
  // Dates in numbers: 2026-11-20, on 11/20, 11/20/26, 11-20-2026, and a year. 24/7 isn't a date.
  /\b\d{4}-\d{1,2}-\d{1,2}\b/,
  /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/(?:\d{4}|\d{2}))?\b/,
  /\b(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])-(?:\d{4}|\d{2})\b/,
  /\b20[2-9]\d\b/,
  // Dates in words: Nov 20, November 20th, 20 November, on the 20th, the 1st of the month, by March.
  new RegExp(String.raw`\b${MONTH_ANY}\s+\d{1,2}(?:st|nd|rd|th)?\b`, "i"),
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_ANY}(?![a-z])`, "i"),
  new RegExp(String.raw`\b${LEAD}\s+the\s+\d{1,2}(?:st|nd|rd|th)\b`, "i"),
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)\s+of\s+(?:the|each|every|this|next)\s+month\b`, "i"),
  new RegExp(String.raw`\b(?:${LEAD}|in|this|next|early|late|mid|end\s+of|beginning\s+of)\s+${MONTH_NOT_MAY}\b`, "i"),
  // Times: 3pm, 3:30 p.m., noon.
  /\b\d{1,2}(?::\d{2})?\s?[ap](?:\.m\.|m)(?![a-z])/i, /\b\d{1,2}:\d{2}\b/, /\b(?:noon|midnight|o'?clock)\b/i,
  // Deadlines: within 3 days, in two weeks, 3 to 5 business days, a 30-day window, the deadline.
  new RegExp(String.raw`\b(?:within|in|under|inside(?:\s+of)?|after|before|by|over\s+the\s+next|next|for\s+the\s+next|up\s+to)\s+(?:the\s+next\s+)?${COUNT}(?:\s*(?:-|to|or)\s*${COUNT})?\s+${SPAN}\b`, "i"),
  new RegExp(String.raw`\b${COUNT}\s*(?:-|to)\s*${COUNT}\s+${SPAN}\b`, "i"),
  new RegExp(String.raw`\b${COUNT}\s+(?:business|working)\s+days?\b`, "i"),
  /\b\d+-(?:minute|hour|day|week|month|year)\b/i,
  /\b(?:deadline|due\s+(?:date|by|on)|expir(?:e|es|ed|ing|ation)|last\s+day|cut[-\s]?off)\b/i,
];

/** The first day, date, time or deadline in a rule's message, as written, or null. */
export const dateHit = (text: string): string | null => firstOf(DATES, String(text ?? ""));

/** The promotion screen on a rule that sends: its texts and emails, then its name. The name never reaches a
 *  customer (crm-rules-tick builds a message from the step's own words), but Jack still won't name a rule
 *  like a promotion (the cautious side, 11-09), and says it's the name, with the words, so Claude renames
 *  it instead of rewording a text that was fine. */
function promotionRefusal(sends: string[], name: string): string | null {
  if (looksPromotional(sends)) return RULE_SAID.promotion;
  const inName = sends.length ? promoHit(name) : null;
  return inName ? RULE_SAID.promotionName(inName) : null;
}

/** Whether a rule's text holds a dollar amount: the reply's reader (promo.ts moneyIn: "$8,450", "7,500",
 *  "7500", "7.5k", "500 dollars") or one in words. A rule has no record to check one against (11-09). */
const hasAmount = (t: string) => moneyIn(t).length > 0 || spelledAmountHit(t) !== null;

/** The screens on what a rule sends to the customer (its texts and emails, and the rule's name with them,
 *  for a promotion), in the order a person hears them. Null when it may go out. */
function sendsRefusal(sends: string[], name: string): string | null {
  const promo = promotionRefusal(sends, name);
  if (promo) return promo;
  if (sends.some(hasAmount)) return RULE_SAID.noPrice;
  for (const t of sends) {
    const hit = promiseHit(t);
    if (hit) return `${RULE_SAID.noPromise} Take out "${hit}".`;
  }
  for (const t of sends) {
    const hit = dateHit(t);
    if (hit) return `${RULE_SAID.noDate} Take out "${hit}".`;
  }
  return null;
}

/** A merge field this product doesn't fill, or a placeholder that would go out as typed. */
export function mergeProblem(texts: string[]): string | null {
  const known = Object.keys(RULE_MERGE_FIELDS).join(", ");
  for (const t of texts) {
    for (const m of t.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
      if (!(`{{${m[1].toLowerCase()}}}` in RULE_MERGE_FIELDS)) return `${m[0]} isn't something a rule can fill in. It can use ${known}, and nothing else.`;
    }
    if (/(?<!\{)\{\s*[A-Za-z_ ]{2,30}\s*\}(?!\})/.test(t)) return `Merge fields take two braces on each side, like {{first_name}}. A rule can use ${known}.`;
    if (/\[\s*(first|last|full|customer'?s?|their|your)?\s*(name|first name|company|business( name)?)\s*\]/i.test(t)) return `A rule fills names in with merge fields, like {{first_name}}, not brackets. It can use ${known}.`;
  }
  return null;
}

// ── Turning names into ids ────────────────────────────────────────────────────────────────────────

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const quote = (s: string) => `"${scrub(s, 60)}"`;

function byName<T>(items: T[], name: string, nameOfIt: (t: T) => string | null, what: string, where: string): { item: T } | { error: string } {
  const n = norm(name);
  if (!n) return { error: `Say which ${what}${where ? ` in ${where}` : ""}.` };
  const hits = items.filter((t) => norm(nameOfIt(t)) === n);
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { error: `More than one ${what}${where ? ` in ${where}` : ""} is called ${quote(name)}. Ask the person which one they mean.` };
  const names = items.map(nameOfIt).filter((x): x is string => !!x).map((x) => scrub(x, 60));
  return { error: `There's no ${what} called ${quote(name)}${where ? ` in ${where}` : ""}. ${names.length ? `The ones there are: ${names.slice(0, 30).join(", ")}.` : "There aren't any."} Ask the person which one they mean, and don't guess.` };
}

/** A person by full name, or by first name when only one person has it. */
function personByName(team: Mate[], name: string): { item: Mate } | { error: string } {
  const full = byName(team, name, (m) => m.name, "person on the team", "");
  if ("item" in full) return full;
  const n = norm(name);
  const first = team.filter((m) => norm(m.name).split(" ")[0] === n);
  if (first.length === 1) return { item: first[0] };
  if (first.length > 1) return { error: `More than one person on the team is called ${quote(name)}. Ask the person which one they mean.` };
  return full;
}

const pipeName = (p: Pipe) => p.name;

// A probe action per need, so "does this scope give a condition what it needs?" is answered by
// crmRules.ts's own table rather than a copy of it.
const NEED_PROBE: Record<RuleNeed, string> = { pipeline: "set_status", deal: "mark_lost", contact: "add_note", any: "notify_team" };
const provides = (scope: string, need: RuleNeed) => actionAllowedForScope(NEED_PROBE[need], scope);

// ── The tools ─────────────────────────────────────────────────────────────────────────────────────

const WHO: Record<string, string> = { one_pipeline: "pipeline", every_pipeline: "all_pipelines", customers: "contacts", team: "none" };
const ALL_EVENT_WORDS: Record<string, string> = { ...RULE_EVENTS, ...RULE_CONTACT_EVENTS };
const ownWords = (key: string) => (Object.prototype.hasOwnProperty.call(ALL_EVENT_WORDS, key) ? ALL_EVENT_WORDS[key] : "");

/** Whether an event is about a payment other than paid in full. Plan 5.6: paid in full is the only payment
 *  event a rule Jack writes may start on. "A payment comes in" (payment_received, 367) fires on a deposit
 *  or a part payment too, so it is left out, and so is any payment event beta adds later until someone
 *  decides (rules_test.ts pins today's list). */
export const isPaymentEvent = (key: string, words = ownWords(key)) =>
  key !== "paid_in_full" && /pay|paid|deposit|refund|charge/i.test(`${key} ${words}`);

/** The events Jack offers and writes rules on: every one Carolyn's rules take, less the payment ones. */
export const JACK_EVENT_KEYS = Object.keys(ALL_EVENT_WORDS).filter((k) => !isPaymentEvent(k));
const EVENT_WORDS: Record<string, string> = Object.fromEntries(JACK_EVENT_KEYS.map((k) => [k, ALL_EVENT_WORDS[k]]));
const OFFERED = new Set(JACK_EVENT_KEYS);

/** Why Jack won't write (or save) a rule on this trigger, or null. An event must be one Jack offers: a
 *  payment that isn't paid in full is refused by name, anything else off the list in her parser's words.
 *  A days-after rule's anchor must be one of hers too. Her parser looks both up on plain objects, so a key
 *  like "constructor" or "toString" would get past it. */
export function triggerRefusal(triggerKind: string | null | undefined, triggerEvent: unknown, anchor?: unknown): string | null {
  if (triggerKind === "elapsed") {
    return Object.prototype.hasOwnProperty.call(RULE_ANCHORS, String(anchor ?? "").trim()) ? null : RULE_SAID.pickAnchor;
  }
  if (triggerKind !== "event") return null;
  const key = String(triggerEvent ?? "").trim();
  if (isPaymentEvent(key.toLowerCase())) return RULE_SAID.paidInFullOnly;
  return OFFERED.has(key) ? null : RULE_SAID.pickEvent;
}

const lookTool: ToolSpec = {
  def: {
    name: "look_at_my_rules",
    description: "Read this builder's when/then rules (Settings > Customer Hub > Automations) in plain words: each rule's ref, name, sentence, who it's for, its only-if checks, every step with the full text it sends, whether it's on, and its last run. It also gives the names to write a rule with: pipelines with their stages and statuses, the team, tags, the event names and the time zone. Use it before writing or pausing a rule, and to answer \"what happens when ...\". Rules run top to bottom.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  needs: [{ area: "settings_crm", level: "view" }],
  switchKey: "rules",
  async run(deps, _s) {
    const read = await readList(deps);
    if ("error" in read) return err(read.error);
    const { list } = read;
    const refs = refsFor(list.rules.map((x) => x.id));
    return ok({
      rules: list.rules.slice(0, 60).map((x) => ruleForClaude(x, list, refs.get(x.id)!)),
      ...(list.rules.length > 60 ? { more: list.rules.length - 60 } : {}),
      canChangeRules: list.canManage && deps.canEdit("settings_crm"),
      names: {
        pipelines: list.pipelines.map((p) => ({
          name: p.name ? scrub(p.name, 80) : null,
          stages: p.stages.map((t) => t.name).filter(Boolean).map((t) => scrub(t, 60)),
          statuses: p.statuses.map((t) => t.name).filter(Boolean).map((t) => scrub(t, 60)),
          lostReasons: p.lostReasons.slice(0, 20).map((t) => scrub(t, 80)),
        })),
        team: list.team.map((m) => m.name).filter(Boolean).map((n) => scrub(n, 80)),
        tags: list.labels.slice(0, 100).map((t) => scrub(t, 60)),
        events: EVENT_WORDS,
        countFrom: RULE_ANCHORS,
        mergeFields: RULE_MERGE_FIELDS,
        timeZone: list.timeZone,
      },
      notes: [
        "The only payment event you can write a rule on is paid_in_full (It is paid in full), when payments reach the order total. A deposit or a part payment starts no rule you write, and you don't turn on a rule that starts on one.",
        "A new rule goes at the end of the list, and rules run top to bottom.",
        "Every rule acts only on what happens after it's saved.",
      ],
    });
  },
};

const runsTool: ToolSpec = {
  def: {
    name: "look_at_rule_runs",
    description: "What one rule did lately, as counts: how many times it ran, was skipped (and why) or failed, and how its texts and emails stand (sent, waiting, held for the morning, skipped, failed). No customer names. Use the rule's ref from look_at_my_rules. For who it reached, point them to the rule's Runs in Automations.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["ref"], properties: { ref: { type: "string", description: "The rule's ref from look_at_my_rules." } } },
  },
  needs: [{ area: "settings_crm", level: "view" }],
  switchKey: "rules",
  async run(deps, _s, input) {
    const read = await readList(deps);
    if ("error" in read) return err(read.error);
    // deno-lint-ignore no-explicit-any
    const rule = ruleByRef(read.list, (input as any)?.ref);
    if (!rule) return err(RULE_SAID.noRef);
    const r = await deps.portal("crm_rule_log", { ruleId: rule.id });
    if (r.status === 403) return err(refusalOf(r, SAID.noSee));
    if (r.status !== 200 || !r.data) return err(SAID.readFailed);
    return ok(runCounts(rule, refsFor(read.list.rules.map((x) => x.id)).get(rule.id)!, arr(r.data.runs), arr(r.data.outbox), deps.now()));
  },
};

// Why a run was skipped, from the reasons the database writes (migrations 363 and 365), in words.
const SKIP_WHY: [RegExp, string][] = [
  [/^conditions$/, "its only-if checks didn't match"],
  [/^already run for this card$/, "it had already run for that card"],
  [/^already run for this customer$/, "it had already run for that customer"],
  [/^already run for them today$/, "it had already run for them that day"],
  [/^already run$/, "it had already run"],
  [/^missed its time/, "it missed its time by more than six hours"],
  [/^not armed/, "it wasn't armed"],
];
// The fixed sentences a failed run can carry (365's raise exception). Anything else is "an error": the
// rest can hold database text, which isn't for Claude.
const FAIL_WHY: [RegExp, string][] = [
  [/needs a card, and this rule runs on a customer/, "a step needs a card, and it ran on a customer"],
  [/needs a customer, and this rule has none/, "a step needs a customer, and it had none"],
  [/names no tag/, "a step names no tag"],
  [/assigns to is no longer on your team/, "the person it assigns to left the team"],
  [/task is for is no longer on your team/, "the person the task is for left the team"],
];
// What crm-rules-tick writes on a message it didn't send. Anything else is "another reason": smsSend's
// and the email sender's own sentences can carry a number or an address.
const OUT_WHY: [RegExp, string][] = [
  [/rule was paused or removed/i, "the rule was paused or removed before it went out"],
  [/Waiting for 8am/i, "waiting for 8am where the customer lives"],
  [/Do Not Disturb is on/i, "Do Not Disturb is on for that customer"],
  [/Email is off for this customer/i, "that customer turned email off"],
  [/no longer there/i, "the card or customer was removed"],
  [/no phone number/i, "that customer has no phone number"],
  [/no email address/i, "that customer has no email address"],
  [/Nobody on your team has an email/i, "nobody on the team has an email address"],
  [/Team email isn't switched on/i, "team email isn't switched on yet"],
  [/Email isn't switched on/i, "email isn't switched on for this account yet"],
  [/Gave up after/i, "it gave up after four tries"],
  [/opt(ed)?[\s-]?out|\bSTOP\b|unsubscrib/i, "the customer opted out"],
  [/consent/i, "there's no texting consent on file"],
  [/number/i, "the number can't take texts"],
  [/not active|not switched on|isn't (set up|on)/i, "texting isn't switched on for this account"],
];
const whyOf = (table: [RegExp, string][], text: unknown, other: string) => {
  const t = String(text ?? "");
  return table.find(([re]) => re.test(t))?.[1] ?? other;
};
const tally = (list: string[]) => {
  const m = new Map<string, number>();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count }));
};

// deno-lint-ignore no-explicit-any
export function runCounts(rule: ListRule, ref: string, runs: any[], outbox: any[], now: number) {
  const by = (o: string) => runs.filter((r) => r?.outcome === o);
  const skipped = by("skipped"), failed = by("failed");
  const held = (o: { state?: string; holdUntil?: string; lastError?: string }) =>
    o.state === "queued" && ((o.holdUntil && Date.parse(o.holdUntil) > now) || /8am/i.test(String(o.lastError ?? "")));
  const notSent = outbox.filter((o) => o?.state === "skipped" || o?.state === "failed");
  return {
    ref,
    name: rule.name ? scrub(rule.name, 120) : null,
    on: rule.enabled,
    runs: {
      counted: runs.length, done: by("done").length, skipped: skipped.length, failed: failed.length,
      latest: dayOf(runs[0]?.firedAt), earliest: dayOf(runs[runs.length - 1]?.firedAt),
      ...(skipped.length ? { skippedBecause: tally(skipped.map((r) => whyOf(SKIP_WHY, r?.detail?.reason, "another reason"))) } : {}),
      ...(failed.length ? { failedBecause: tally(failed.map((r) => whyOf(FAIL_WHY, r?.detail?.error, "it hit an error"))) } : {}),
    },
    messages: {
      counted: outbox.length,
      sent: outbox.filter((o) => o?.state === "sent").length,
      heldForMorning: outbox.filter(held).length,
      waiting: outbox.filter((o) => o?.state === "queued" && !held(o)).length,
      skipped: outbox.filter((o) => o?.state === "skipped").length,
      failed: outbox.filter((o) => o?.state === "failed").length,
      ...(notSent.length ? { notSentBecause: tally(notSent.map((o) => whyOf(OUT_WHY, o?.lastError, "another reason"))) } : {}),
    },
    note: "Counts only, from the latest 100 runs and messages. Who each one was about is on the rule's Runs in Automations.",
  };
}

// ── propose_rule ──────────────────────────────────────────────────────────────────────────────────

interface StepIn { kind: string; name: string; people: string[]; subject: string; text: string; days: number }
interface CheckIn { field: string; op: string; value: string }
interface RuleInput {
  name: string; who: string; pipelineName: string; when: string; event: string; anchor: string; days: number;
  schedule: { freq: string; at: string; weekdays: number[]; everyWeeks: number; dayOfMonth: number; month: number; day: number };
  onlyIf: CheckIn[]; steps: StepIn[]; everyTime: boolean;
}

const s = (v: unknown) => String(v ?? "").trim();
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : Number(s(v)));

/** The texts a step sends, for the screens. */
function sentTexts(st: StepIn): string[] {
  if (st.kind === "send_sms") return [st.text];
  if (st.kind === "send_email" || st.kind === "notify_team") return [st.subject, st.text];
  return [];
}

/** One step's params from names. A name that's unknown or could be two things goes back to Claude. */
function stepParams(st: StepIn, i: number, pipe: Pipe | null, list: RulesList): { params: Record<string, unknown> } | { error: string } {
  const at = `Step ${i + 1}: `;
  const fail = (e: string) => ({ error: at + e });
  switch (st.kind) {
    case "set_status": {
      const hit = byName(pipe!.statuses, st.name, (t) => t.name, "status", pipe!.name ?? "that pipeline");
      return "item" in hit ? { params: { statusId: hit.item.id } } : fail(hit.error);
    }
    case "move_stage": {
      const hit = byName(pipe!.stages, st.name, (t) => t.name, "stage", pipe!.name ?? "that pipeline");
      return "item" in hit ? { params: { stageId: hit.item.id } } : fail(hit.error);
    }
    case "mark_lost": return { params: { reason: s(st.text) } };
    case "reopen": return { params: {} };
    case "set_follow_up": case "set_close_date": return { params: { days: int(st.days) } };
    case "add_note": return { params: { body: s(st.text) } };
    case "create_card": {
      const hit = byName(list.pipelines, st.name, pipeName, "pipeline", "");
      if (!("item" in hit)) return fail(hit.error);
      return { params: { pipelineId: hit.item.id, ...(s(st.subject) ? { title: s(st.subject) } : {}) } };
    }
    case "add_label": case "remove_label": {
      // An existing tag keeps its own spelling, so "vip" doesn't become a second tag beside "VIP".
      const known = list.labels.find((l) => norm(l) === norm(st.name));
      return { params: { label: known ?? s(st.name) } };
    }
    case "assign_owner": {
      const hit = personByName(list.team, st.name);
      return "item" in hit ? { params: { userId: hit.item.userId } } : fail(hit.error);
    }
    case "create_task": {
      let assignee: string | null = null;
      if (s(st.name)) {
        const hit = personByName(list.team, st.name);
        if (!("item" in hit)) return fail(hit.error);
        assignee = hit.item.userId;
      }
      return { params: { title: s(st.subject), dueDays: int(st.days), ...(assignee ? { assigneeUserId: assignee } : {}) } };
    }
    case "notify_team": {
      const ids: string[] = [];
      for (const n of (st.people ?? []).map(s).filter(Boolean)) {
        const hit = personByName(list.team, n);
        if (!("item" in hit)) return fail(hit.error);
        ids.push(hit.item.userId);
      }
      return { params: { userIds: [...new Set(ids)], subject: s(st.subject), body: s(st.text) } };
    }
    case "send_sms": return { params: { body: s(st.text) } };
    case "send_email": return { params: { subject: s(st.subject), body: s(st.text) } };
  }
  return { error: at + "Pick what the rule should do from the list." };
}

/** One only-if check's value from a name or a word. Left as given when the parser will refuse it anyway,
 *  so the person hears her sentence, not mine. */
function checkValue(c: CheckIn, i: number, scope: string, pipe: Pipe | null, list: RulesList): { value: unknown } | { error: string } {
  const spec = RULE_CONDITION_FIELDS[c.field];
  const raw = s(c.value);
  if (!spec || !provides(scope, spec.needs) || !(spec.ops as readonly string[]).includes(c.op)) return { value: raw };
  if (c.op === "is_empty" || c.op === "not_empty") return { value: null };
  const at = `Only-if ${i + 1}: `;
  switch (spec.type) {
    case "money": { const v = raw.replace(/[$,\s]/g, ""); return { value: /^\d+(\.\d+)?$/.test(v) ? Number(v) : v }; }
    case "number": return { value: /^\d+$/.test(raw) ? Number(raw) : raw };
    case "bool": return { value: /^(yes|true|y)$/i.test(raw) ? true : /^(no|false|n)$/i.test(raw) ? false : raw };
    case "status": case "stage": {
      const hit = byName(spec.type === "status" ? pipe!.statuses : pipe!.stages, raw, (t) => t.name, spec.type, pipe!.name ?? "that pipeline");
      return "item" in hit ? { value: hit.item.id } : { error: at + hit.error };
    }
    case "owner": {
      const hit = personByName(list.team, raw);
      return "item" in hit ? { value: hit.item.userId } : { error: at + hit.error };
    }
    case "choice": case "contact_source": {
      const from = spec.type === "choice" ? RULE_DEAL_SOURCES : RULE_CONTACT_SOURCES;
      const key = Object.keys(from).find((k) => norm(k) === norm(raw) || norm(from[k]) === norm(raw));
      return { value: key ?? raw };
    }
    case "label": {
      const known = list.labels.find((l) => norm(l) === norm(raw));
      return { value: known ?? raw };
    }
  }
  return { value: raw };
}

function scheduleIn(i: RuleInput["schedule"]): Record<string, unknown> {
  const out: Record<string, unknown> = { freq: s(i?.freq), at: s(i?.at) };
  if (out.freq === "weekly") { out.days = arr(i?.weekdays); if (int(i?.everyWeeks) > 1) out.every = int(i?.everyWeeks); }
  if (out.freq === "monthly") out.dayOfMonth = int(i?.dayOfMonth);
  if (out.freq === "yearly") { out.month = int(i?.month); out.day = int(i?.day); }
  return out;
}

const triggerOf = (when: unknown) => (when === "event" ? "event" : when === "days_after" ? "elapsed" : when === "schedule" ? "schedule" : null);

/** What version 1 won't write, and what no rule may send: checked before anything is read. */
export function preCheck(input: RuleInput): string | null {
  const scope = WHO[s(input?.who)];
  if (!scope) return "Pick who the rule is for.";
  const triggerKind = triggerOf(input.when);
  if (!triggerKind) return "Pick when the rule runs.";
  // Paid in full is the only payment event: a deposit starts no rule Jack writes, whatever the enum said.
  const trigger = triggerRefusal(triggerKind, input.event, input.anchor);
  if (trigger) return trigger;
  const steps = arr(input.steps) as StepIn[];
  const v1 = v1Refusal(scope, triggerKind, steps.map((x) => x.kind));
  if (v1) return v1;
  const sends = steps.filter((x) => isOutboundAction(x.kind)).flatMap(sentTexts).map(s);
  const promo = promotionRefusal(sends, s(input.name));
  if (promo) return promo;
  const merge = mergeProblem(steps.flatMap(sentTexts).map(s));
  if (merge) return merge;
  return sendsRefusal(sends, s(input.name));
}

/** What the press checks again on a new rule's body, before its one save: the trigger, and what it sends,
 *  through the same screens the card passed. A card an older Jack made that these would refuse now is
 *  refused at the press, with nothing sent. Null when it may save. */
export function saveRefusal(body: Record<string, unknown>): string | null {
  const rl = parseRuleSave(body);
  if (!rl.ok) return null; // shapeOfBody refuses a body that doesn't parse, in its own words
  const trigger = triggerRefusal(rl.triggerKind, rl.triggerEvent, rl.elapsedAnchor);
  if (trigger) return trigger;
  if ((rl.actions ?? []).some((a) => JACK_NEVER_ACTIONS.has(String(a.kind)))) return RULE_SAID.noDataOut;
  const sends = (rl.actions ?? []).filter((a) => isOutboundAction(a.kind))
    .flatMap((a) => [a.params?.subject, a.params?.body]).map(s).filter(Boolean);
  return sendsRefusal(sends, s(rl.name));
}

/** The request, built and checked, or the sentence that stops it. Exported for the tests. */
export function buildRule(input: RuleInput, list: RulesList): { body: Record<string, unknown>; scope: string; pipe: Pipe | null } | { error: string } {
  const pre = preCheck(input);
  if (pre) return { error: pre };
  const scope = WHO[s(input.who)];
  const triggerKind = triggerOf(input.when)!;
  const steps = arr(input.steps) as StepIn[];

  let pipe: Pipe | null = null;
  if (scope === "pipeline") {
    const hit = byName(list.pipelines, s(input.pipelineName), pipeName, "pipeline", "");
    if (!("item" in hit)) return { error: hit.error };
    pipe = hit.item;
  }

  const actions: { kind: string; params: Record<string, unknown> }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (JACK_NEVER_ACTIONS.has(s(st.kind).trim().toLowerCase())) return { error: RULE_SAID.noDataOut };
    if (!(JACK_ACTION_KINDS as readonly string[]).includes(st.kind)) return { error: `Step ${i + 1}: pick what the rule should do from the list.` };
    // Her sentence for a step this scope can't carry, before any name is looked for.
    if (!actionAllowedForScope(st.kind, scope)) return { error: plain(actionScopeError(i, st.kind)) };
    const made = stepParams(st, i, pipe, list);
    if ("error" in made) return { error: made.error };
    actions.push({ kind: st.kind, params: made.params });
  }

  const conditions: { field: string; op: string; value: unknown }[] = [];
  const checks = arr(input.onlyIf) as CheckIn[];
  for (let i = 0; i < checks.length; i++) {
    const v = checkValue(checks[i], i, scope, pipe, list);
    if ("error" in v) return { error: v.error };
    conditions.push({ field: s(checks[i].field), op: s(checks[i].op), value: v.value });
  }

  const body: Record<string, unknown> = { name: s(input.name).slice(0, 121) || null, scopeKind: scope };
  if (pipe) body.pipelineId = pipe.id;
  body.triggerKind = triggerKind;
  if (triggerKind === "event") body.triggerEvent = s(input.event) === "none" ? "" : s(input.event);
  if (triggerKind === "elapsed") { body.elapsedAnchor = s(input.anchor) === "none" ? "" : s(input.anchor); body.elapsedDays = int(input.days); }
  if (triggerKind === "schedule") body.schedule = scheduleIn(input.schedule);
  body.conditions = conditions;
  body.actions = actions;
  // A time rule and a schedule always run once (355's own constraint), so only an event asks.
  body.oncePerCard = triggerKind === "event" ? input.everyTime !== true : true;
  body.enabled = true;

  // Carolyn's parsers, as her save will run them.
  const rl = parseRuleSave(body);
  if (!rl.ok) return { error: plain(rl.error) };
  const pc = parseRuleConditions(body.conditions, scope);
  if (!pc.ok) return { error: plain(pc.error) };
  return { body, scope, pipe };
}

const stepSchema = {
  type: "object", additionalProperties: false, required: ["kind", "name", "people", "subject", "text", "days"],
  properties: {
    kind: { type: "string", enum: [...JACK_ACTION_KINDS] },
    name: { type: "string", description: "What the step names, by its name: the status (set_status), stage (move_stage), pipeline (create_card), tag (add_label, remove_label) or person (assign_owner, or who a task is for). Empty when it names nothing." },
    people: { type: "array", items: { type: "string" }, description: "notify_team only: who to email, by name. Empty means the owners and admins." },
    subject: { type: "string", description: "An email's subject (send_email, notify_team), a task's title (create_task) or a new card's title (create_card). Empty otherwise." },
    text: { type: "string", description: "The words: the text (send_sms, 480 characters at most), the email body, the note (add_note), or why it's marked lost (mark_lost). Empty otherwise." },
    days: { type: "integer", description: "Days for set_follow_up and set_close_date, or how many days out a task is due. 0 otherwise." },
  },
};

const proposeTool: ToolSpec = {
  def: {
    name: "propose_rule",
    description: "Put a new when/then rule on the person's screen for Settings > Customer Hub > Automations. It changes nothing: the person presses Approve. Use names from look_at_my_rules. Write the message wording yourself, in the rep's voice, using only the merge fields {{first_name}}, {{name}}, {{company}}, {{business}} and {{deal_title}}, and never a price, a day, date, time or deadline, a warranty, a guarantee or a promise. Never a sale, discount, special or promotion. A rule on a payment starts only when it's paid in full (paid_in_full), never on a deposit. Schedules are only for reminders to the team (who=team, notify_team).",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["name", "who", "pipelineName", "when", "event", "anchor", "days", "schedule", "onlyIf", "steps", "everyTime"],
      properties: {
        name: { type: "string", description: "A short name, like Ask for a review." },
        who: { type: "string", enum: Object.keys(WHO), description: "one_pipeline: the cards in one pipeline. every_pipeline: cards in every pipeline. customers: customers, by the only-if checks. team: nobody but the team (schedules only)." },
        pipelineName: { type: "string", description: "The pipeline's name when who is one_pipeline. Empty otherwise." },
        when: { type: "string", enum: ["event", "days_after", "schedule"] },
        event: { type: "string", enum: [...JACK_EVENT_KEYS, "none"], description: "What starts it, when it's event. paid_in_full is the only payment event. none otherwise." },
        anchor: { type: "string", enum: [...Object.keys(RULE_ANCHORS), "none"], description: "What the days count from, when it's days_after. none otherwise." },
        days: { type: "integer", description: "How many days after, when it's days_after. 0 otherwise." },
        schedule: {
          type: "object", additionalProperties: false, required: ["freq", "at", "weekdays", "everyWeeks", "dayOfMonth", "month", "day"],
          description: "When it's schedule. Otherwise freq none and zeros.",
          properties: {
            freq: { type: "string", enum: ["daily", "weekly", "monthly", "yearly", "none"] },
            at: { type: "string", description: "The time, HH:MM in 24 hours, in the account's time zone. Empty when not a schedule." },
            weekdays: { type: "array", items: { type: "integer" }, description: "weekly: days of the week, 1 Monday to 7 Sunday." },
            everyWeeks: { type: "integer", description: "weekly: every how many weeks, 1 for every week." },
            dayOfMonth: { type: "integer", description: "monthly: the day of the month." },
            month: { type: "integer", description: "yearly: the month, 1 to 12." },
            day: { type: "integer", description: "yearly: the day." },
          },
        },
        onlyIf: {
          type: "array", description: "Checks that must all hold for it to act. Empty for none.",
          items: {
            type: "object", additionalProperties: false, required: ["field", "op", "value"],
            properties: {
              field: { type: "string", enum: Object.keys(RULE_CONDITION_FIELDS) },
              op: { type: "string", enum: [...RULE_CONDITION_OPS] },
              value: { type: "string", description: "By name: a status, stage or person's name, a tag, yes or no, a dollar amount, or a number of days. Empty for is_empty and not_empty." },
            },
          },
        },
        steps: { type: "array", items: stepSchema, description: "What it does, in order. At most 10." },
        everyTime: { type: "boolean", description: "true only for an event rule meant to run every time it happens, not once per card. A days_after rule always runs once." },
      },
    },
  },
  needs: [{ area: "settings_crm", level: "edit" }],
  switchKey: "rules",
  proposesChange: true,
  async run(deps, st, input) {
    if (!deps.canEdit("settings_crm")) return err(SAID.noAccess);
    const pre = preCheck(input as RuleInput);
    if (pre) return err(pre);
    const read = await readList(deps);
    if ("error" in read) return err(read.error);
    const { list } = read;
    if (!list.canManage) return err(SAID.noAccess);
    const built = buildRule(input as RuleInput, list);
    if ("error" in built) return err(built.error);
    return await putRuleCard(deps, st, built.body, built.scope, list);
  },
};

async function putRuleCard(deps: Deps, st: TurnState, body: Record<string, unknown>, scope: string, list: RulesList) {
  const rl = parseRuleSave(body);
  const pc = parseRuleConditions(body.conditions, scope);
  if (!rl.ok || !pc.ok) return err(SAID.readFailed);
  const pipe = scope === "pipeline" ? list.pipelines.find((p) => p.id === rl.pipelineId) ?? null : null;
  const pipes = list.pipelines.map((p) => ({ id: p.id, name: p.name ?? "A pipeline" }));
  const actions = rl.actions ?? [];
  const steps = actions.map((a) => stepView(a, pipe, list));
  const outbound = steps.some((x) => x.outbound);
  const sentence = ruleSentence({ triggerKind: rl.triggerKind!, triggerEvent: rl.triggerEvent, elapsedAnchor: rl.elapsedAnchor, elapsedDays: rl.elapsedDays, schedule: rl.schedule, actions });
  const whoFor = audienceLabel({ scopeKind: scope, pipelineId: rl.pipelineId, conditions: pc.conditions as RuleCondition[] }, pipes);
  const name = rl.name ? scrub(rl.name, 120) : null;
  // Rules on the same event run in list order, and this one goes last.
  const runsAfter = rl.triggerKind === "event"
    ? list.rules.filter((x) => x.enabled && x.triggerKind === "event" && x.triggerEvent === rl.triggerEvent).map((x) => x.name ?? ruleSentence(x)).slice(0, 5)
    : [];
  await putCard(deps, st, {
    kind: "automation_rule",
    title: `New rule: ${name ?? sentence}`,
    preview: {
      rule: {
        name, sentence, whoFor, once: onceWords(rl.triggerKind!, rl.oncePerCard ?? true, scope),
        onlyIf: pc.conditions.map((c) => conditionWords(c, pipe, list.team)), steps, outbound,
      },
      runsAfter,
      where: WHERE,
    },
    payload: { save: body, known: list.rules.map((x) => x.id) },
  });
  return ok({
    shown: true, sentence: scrub(sentence, 400), whoFor: scrub(whoFor, 120), messagesCustomers: outbound,
    note: `${SAID.onScreenApprove}${outbound ? " Say that it messages customers by itself once it's on." : ""}`,
  });
}

// ── propose_rule_pause ────────────────────────────────────────────────────────────────────────────

/** Why Jack won't turn a rule on: version 1's two limits, a piece that was removed, or a promotion. */
export type ResumeBlock = "schedule" | "customers" | "stale" | "payment" | "promotion";

/** The one check for every way Jack turns a rule on: a turn-on card when it's proposed, its Approve, and
 *  Undo of a pause. Null means it may go on. The promotion screen is the one a rule Jack writes gets, over
 *  what the rule sends and its name, so Jack never puts a promotion live, even one written by hand; nor a
 *  rule that starts on a deposit or a part payment (11-09), since Jack writes payment rules on paid in
 *  full only. */
export function resumeBlock(rule: ListRule): ResumeBlock | null {
  const v1 = v1Refusal(rule.scopeKind, rule.triggerKind, rule.actions.map((a) => a.kind));
  if (v1) return v1 === RULE_SAID.scheduleTeamOnly ? "schedule" : "customers";
  if (rule.stale.length) return "stale";
  if (rule.triggerKind === "event" && isPaymentEvent(String(rule.triggerEvent ?? "").trim().toLowerCase())) return "payment";
  const sends = rule.actions.filter((a) => isOutboundAction(a.kind)).flatMap((a) => [a.params?.subject, a.params?.body, a.params?.text]).map(s).filter(Boolean);
  // What it sends, not its name: a hand-made rule is often named after the Sales pipeline.
  if (looksPromotional(sends)) return "promotion";
  return null;
}

/** What a turn-on card says to Claude when it's refused. */
const RESUME_REFUSED: Record<ResumeBlock, string> = {
  schedule: RULE_SAID.scheduleTeamOnly, customers: RULE_SAID.customersNoMessages,
  stale: RULE_SAID.staleResume, payment: RULE_SAID.paymentResume, promotion: RULE_SAID.promotionResume,
};

// Why, for a person, in a few words.
const RESUME_WHY: Record<ResumeBlock, string> = {
  schedule: "it runs on a schedule that reaches many cards or customers at once",
  customers: "it texts or emails customers picked by a filter",
  stale: "it points at something that was removed, so it would fail every time",
  payment: "it starts when any payment comes in, a deposit included",
  promotion: "its messages read like a promotion",
};
const byHand = (b: ResumeBlock) => `${b === "stale" ? "fix it and turn it on" : "turn it on"} again by hand in ${WHERE}`;

/** The pause card's note, read before Approve, when Undo couldn't turn the rule back on. */
export const pauseNote = (b: ResumeBlock) => `If you pause it, Undo can't turn it back on, because ${RESUME_WHY[b]}. You would have to ${byHand(b)}.`;
/** Undo's report when it left a paused rule paused. */
export const keptPaused = (b: ResumeBlock) => `It stays paused, because ${RESUME_WHY[b]}. I don't turn rules like that on. You can ${byHand(b)}.`;

const pauseTool: ToolSpec = {
  def: {
    name: "propose_rule_pause",
    description: "Put a card on the person's screen to pause one rule (on false), or turn a paused one back on (on true). It changes nothing until they press Approve. Use the rule's ref from look_at_my_rules.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["ref", "on"],
      properties: { ref: { type: "string" }, on: { type: "boolean", description: "false pauses it; true turns it back on." } },
    },
  },
  needs: [{ area: "settings_crm", level: "edit" }],
  switchKey: "rules",
  proposesChange: true,
  async run(deps, st, input) {
    if (!deps.canEdit("settings_crm")) return err(SAID.noAccess);
    const read = await readList(deps);
    if ("error" in read) return err(read.error);
    const { list } = read;
    if (!list.canManage) return err(SAID.noAccess);
    // deno-lint-ignore no-explicit-any
    const i = (input ?? {}) as any;
    const rule = ruleByRef(list, i.ref);
    if (!rule) return err(RULE_SAID.noRef);
    const on = i.on === true;
    if (rule.enabled === on) return ok({ shown: false, note: on ? "That rule is already on. Nothing to change." : "That rule is already paused. Nothing to change." });
    // Turning on is refused outright. Pausing never is, but if Undo couldn't turn it back on, the card
    // says so before Approve: past this line, a block means a pause card.
    const block = resumeBlock(rule);
    if (on && block) return err(RESUME_REFUSED[block]);
    const oneWay = block;
    const pipe = rule.scopeKind === "pipeline" ? list.pipelines.find((p) => p.id === rule.pipelineId) ?? null : null;
    const steps = rule.actions.map((a) => stepView(a, pipe, list));
    const name = rule.name ? scrub(rule.name, 120) : null;
    const sentence = ruleSentence(rule);
    await putCard(deps, st, {
      kind: "automation_pause",
      title: `${on ? "Turn on" : "Pause"} rule: ${name ?? sentence}`,
      preview: {
        pause: {
          on, name, sentence, steps, outbound: steps.some((x) => x.outbound),
          whoFor: audienceLabel(rule, list.pipelines.map((p) => ({ id: p.id, name: p.name ?? "A pipeline" }))),
          once: onceWords(rule.triggerKind, rule.oncePerCard, rule.scopeKind),
          catchesUp: on && rule.triggerKind === "elapsed",
        },
        where: WHERE,
        ...(oneWay ? { notes: [pauseNote(oneWay)] } : {}),
      },
      payload: { save: { id: rule.id, enabled: on }, ruleId: rule.id, shape: shapeOfListRule(rule) },
    });
    return ok({ shown: true, note: oneWay ? `${SAID.onScreenApprove} Also say that Undo can't turn this one back on, because ${RESUME_WHY[oneWay]}.` : SAID.onScreenApprove });
  },
};

// ── Approve and Undo ──────────────────────────────────────────────────────────────────────────────

// No saved/created counts on these results: the activity page reads those as sizes.
const failedPatch = (failure: string): ApplyOutcome => ({ patch: { status: "failed", failure, result: { rules: 0, reports: [] } } });
const unsurePatch = (p: ProposalRow, reason = RULE_SAID.unsure): ApplyOutcome => ({
  patch: { status: "partly_applied", result: { rules: 0, reports: [{ label: p.title, status: "error", reason }] } },
});
const refused = (r: { status: number; data: Record<string, unknown> | null }) => `${refusalOf(r, "That didn't save.")} Nothing was saved. Ask me again and I'll redo it.`;
const lost = (r: { status: number; data: Record<string, unknown> | null }) => r.status === 0 || r.status >= 500 || (r.status === 200 && !(r.data && typeof r.data.id === "string"));

/** A new rule. ONE crm_rule_save, with exactly the card's body. */
async function applyRule(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const save = (p.payload?.save ?? {}) as Record<string, unknown>;
  const shape = shapeOfBody(save);
  if (!shape) return failedPatch("That rule can't be saved as it is. Ask me again.");
  const no = saveRefusal(save);
  if (no) return failedPatch(`${no} Nothing was saved.`);
  const known = new Set<string>(arr(p.payload?.known).map((x) => String(x).toLowerCase()));
  const startedAt = deps.now();
  const r = await deps.portal("crm_rule_save", save);
  const savedAs = (id: string): ApplyOutcome => ({ patch: { status: "applied", result: { rules: 1, reports: [] }, undo: { ruleId: id.toLowerCase(), shape } } });
  if (r.status === 200 && r.data && typeof r.data.id === "string") return savedAs(r.data.id);
  if (!lost(r)) return failedPatch(refused(r));

  // The answer was lost, or the route failed part way. It may have made the rule, or made it without its
  // steps, so it is never sent again: the list says what landed.
  const again = await readList(deps);
  if ("error" in again) return unsurePatch(p);
  // A rule made by this press: not there when the card was made, and started within these minutes.
  const fresh = again.list.rules.filter((x) => !known.has(x.id) && (!x.appliesFrom || Date.parse(x.appliesFrom) >= startedAt - 5 * 60_000));
  const whole = fresh.filter((x) => shapeOfListRule(x) === shape);
  if (whole.length === 1) return savedAs(whole[0].id);
  if (whole.length > 1) return unsurePatch(p);
  const bareShape = shapeOfBody(save, false);
  const bare = fresh.filter((x) => x.actions.length === 0 && shapeOfListRule(x, false) === bareShape);
  if (bare.length === 1) {
    // A rule with no steps fires and does nothing, and still spends its once per card. Take it away.
    const gone = await deps.portal("crm_rule_save", { id: bare[0].id, archive: true });
    if (gone.status === 200 || gone.status === 404) return failedPatch(RULE_SAID.halfRemoved);
    return unsurePatch(p, RULE_SAID.halfLeft);
  }
  return unsurePatch(p);
}

/** Undo for a new rule: pause it, if what it does is as Jack saved it. */
async function undoRule(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { ruleId?: string; shape?: string };
  const label = p.title;
  const read = await readList(deps);
  if ("error" in read) return { restored: 0, removed: 0, failed: 1, reports: [{ label, status: "error", reason: RULE_SAID.readAgain }] };
  const rule = read.list.rules.find((x) => x.id === String(plan.ruleId ?? "").toLowerCase());
  if (!rule) return { restored: 0, removed: 1, failed: 0, reports: [] };
  if (!plan.shape || shapeOfListRule(rule) !== plan.shape) return { restored: 0, removed: 0, failed: 0, reports: [{ label, status: "changed", reason: RULE_SAID.editedSince }] };
  if (!rule.enabled) return { restored: 1, removed: 0, failed: 0, reports: [] };
  return toggled(deps, label, rule.id, false);
}

async function toggled(deps: Deps, label: string, id: string, enabled: boolean): Promise<UndoOutcome> {
  const r = await deps.portal("crm_rule_save", { id, enabled });
  if (r.status === 200) return { restored: 1, removed: 0, failed: 0, reports: [] };
  if (r.status === 404) return { restored: 0, removed: 1, failed: 0, reports: [] };
  // Pausing twice is harmless, so a lost answer leaves Undo there to press again.
  if (lost(r)) return { restored: 0, removed: 0, failed: 1, reports: [{ label, status: "error", reason: "That didn't go through. Press Undo to try again." }] };
  return { restored: 0, removed: 0, failed: 0, reports: [{ label, status: "refused", reason: refusalOf(r, "That didn't go through.") }] };
}

/** Pause or turn on. It reads the rule first, both ways: Undo puts back what stood at this press, so it
 *  has to know what that was. A rule someone already paused (or turned on) by hand is left alone, with
 *  no Undo, so Undo can never flip a person's own choice. Turning on also checks that the rule still
 *  does what the card showed, and that nothing in it was removed since. */
async function applyPause(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const save = (p.payload?.save ?? {}) as { id?: string; enabled?: boolean };
  const id = String(save.id ?? "");
  const on = save.enabled === true;
  const before = await readList(deps);
  if ("error" in before) return failedPatch(`${before.error} Nothing changed.`);
  const stood = before.list.rules.find((x) => x.id === id);
  if (!stood) return failedPatch(RULE_SAID.gone);
  if (stood.enabled === on) return failedPatch(on ? RULE_SAID.alreadyOn : RULE_SAID.alreadyOff);
  const shape = shapeOfListRule(stood);
  if (on) {
    if (shape !== String(p.payload?.shape ?? "")) return failedPatch(RULE_SAID.changedSinceShown);
    // The turn-on card's own check, again at the press: a rule gone stale since, or one an older Jack
    // made a card for that this one wouldn't turn on (a deposit rule, 11-09), stays paused.
    const block = resumeBlock(stood);
    if (block) return failedPatch(RESUME_REFUSED[block]);
  }
  const r = await deps.portal("crm_rule_save", save);
  const done: ApplyOutcome = { patch: { status: "applied", result: { rules: 1, reports: [] }, undo: { ruleId: id, shape, set: on } } };
  if (r.status === 200) return done;
  if (r.status === 404) return failedPatch(RULE_SAID.gone);
  if (!lost(r)) return failedPatch(refused(r));
  const again = await readList(deps);
  if ("error" in again) return unsurePatch(p);
  const rule = again.list.rules.find((x) => x.id === id);
  return rule && rule.enabled === on ? done : unsurePatch(p);
}

/** Undo for a pause or a turn-on: put it back as it was. Turning it back on waits for it to be as Jack
 *  left it, and for it to pass resumeBlock, as a turn-on card must; a rule that doesn't stays paused and
 *  Undo is spent (failed 0), so a second press has nothing to do. Pausing it again waits for nothing,
 *  because stopping is always the safe way. */
async function undoPause(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { ruleId?: string; shape?: string; set?: boolean };
  const label = p.title;
  const read = await readList(deps);
  if ("error" in read) return { restored: 0, removed: 0, failed: 1, reports: [{ label, status: "error", reason: RULE_SAID.readAgain }] };
  const rule = read.list.rules.find((x) => x.id === String(plan.ruleId ?? ""));
  if (!rule) return { restored: 0, removed: 1, failed: 0, reports: [] };
  const back = plan.set !== true;
  if (rule.enabled === back) return { restored: 1, removed: 0, failed: 0, reports: [] };
  if (back) {
    if (shapeOfListRule(rule) !== plan.shape) return { restored: 0, removed: 0, failed: 0, reports: [{ label, status: "changed", reason: `Someone changed what this rule does since I paused it, so I left it paused. Turn it on in ${WHERE} if you want it.` }] };
    const block = resumeBlock(rule);
    if (block) return { restored: 0, removed: 0, failed: 0, reports: [{ label, status: "kept", reason: keptPaused(block) }] };
  }
  return toggled(deps, label, rule.id, back);
}

const ruleKind: KindSpec = {
  kind: "automation_rule",
  areas: () => ["settings_crm"],
  switches: () => ["rules"],
  where: WHERE,
  nothingToDo: (p) => (arr(p.payload?.save?.actions).length ? null : "There's nothing to save on that one."),
  apply: (deps, _who, p) => applyRule(deps, p),
  undo: (deps, _who, p) => undoRule(deps, p),
};

const pauseKind: KindSpec = {
  kind: "automation_pause",
  areas: () => ["settings_crm"],
  switches: () => ["rules"],
  where: WHERE,
  nothingToDo: (p) => (typeof p.payload?.save?.id === "string" && typeof p.payload?.save?.enabled === "boolean" ? null : "There's nothing to change on that one."),
  apply: (deps, _who, p) => applyPause(deps, p),
  undo: (deps, _who, p) => undoPause(deps, p),
};

export const rulesPiece: Piece = {
  name: "rules",
  can: [
    "Read their when/then rules (Automations) in plain words with look_at_my_rules, and what one did lately with look_at_rule_runs (counts only).",
    "Write a new rule from a sentence with propose_rule, and pause one or turn it back on with propose_rule_pause.",
  ],
  rules: [
    "Rules: you write rules that act on one card or customer at a time, when something happens or some days after. Schedules are only for reminders to their team. A schedule or a customer filter that messages many customers is set up by hand in Automations.",
    "Never write a rule that advertises a sale, discount, special or promotion, by text or by email. Say rule messages can only be about a customer's own estimate and building for now, and that they can write one by hand in Automations.",
    "A rule's message uses only the merge fields {{first_name}}, {{name}}, {{company}}, {{business}} and {{deal_title}}, and never a price, a day, date, time or deadline, a warranty, a guarantee or a promise: it sends the same words to everyone, whenever it runs.",
    "A rule on a payment starts only when it's paid in full. You don't write or turn on a rule that starts when a deposit or a part payment comes in.",
    "Pipelines, stages, statuses, tags and people go into a rule by the names look_at_my_rules gives. If a name could be two things, ask.",
  ],
  tools: [lookTool, runsTool, proposeTool, pauseTool],
  kinds: [ruleKind, pauseKind],
};
