// Per-pipeline RULES (migration 355): "when ‹this happens› → ‹do this›". The request shapes,
// parsed and refused here so every rule runs in a unit test (crmRules.test.ts) without a
// database. portal-settings owns the gates and the writes; this file owns "what did the browser
// ask for", the same division as crmPipelines.ts.
//
// Carolyn, 2026-11-02, deciding the scope before any of it was written: the triggers are the eight
// events the product already records AND a clock, and an action may reach the customer by text or
// email, not only write inside the Customer Hub.
//
// ⚠️ THERE IS NO MESSAGE TEMPLATE LIBRARY IN THIS PRODUCT, and the plan's wording ("send a text
// from template ‹…›") assumed one. `email_template_copy` is the builder's wording for FIXED
// documents — the estimate, the invoice — keyed by document kind; it cannot hold "the review
// request". So a messaging action carries its own text, with the merge fields below. A real
// template library is a feature of its own, and pretending these pointed at one would mean a
// drop-down with nothing in it.
//
// Self-contained on purpose (no jsr:/npm: imports): preflight runs `_shared/*.test.ts` offline.

import { isUuidLike, type Parsed, STATUS_EVENTS } from "./crmPipelines.ts";

/** The events a rule can fire on. The SAME eight as a status's "set automatically when", from the
 *  same object, because they are the same facts — a second copy would drift. */
export const RULE_EVENTS = STATUS_EVENTS;

/**
 * What a clock counts from. Each is a timestamp the card ALREADY carries, so the sweep is a plain
 * query and there is no new bookkeeping that can fall out of step with the thing it describes.
 *   delivered      — designs.delivered_at, through the card's own design
 *   stage_entered  — crm_deals.stage_entered_at
 *   last_contact   — the newest message or call on the contact
 *   expected_close — crm_deals.expected_close_date, and this one can fire BEFORE the anchor is
 *                    reached, which is why its label is phrased as "after".
 */
export const RULE_ANCHORS: Record<string, string> = {
  delivered: "it was delivered",
  stage_entered: "it moved into its stage",
  last_contact: "anyone last spoke to them",
  expected_close: "the expected close date",
};

/** What a caller asking for a repeating clock rule is told (migration 355's own constraint). */
export const ELAPSED_IS_ONCE =
  "A time rule runs once per card. Once it comes due it stays due, so running it again every time "
  + "would keep sending for ever.";

export const RULE_NAME_MAX = 120;
export const RULE_DAYS_MAX = 3650;
export const RULE_NOTE_MAX = 4000;
/** One segment is 160 characters; three is the most a rule should send unasked, and the carriers
 *  bill per segment. A builder who wants more is writing an email. */
export const RULE_SMS_MAX = 480;
export const RULE_EMAIL_SUBJECT_MAX = 200;
export const RULE_EMAIL_BODY_MAX = 8000;
/** Enough for "set the status, add a note, send the text" and well short of a rule nobody can
 *  read back. The database has no such cap; this is the authored one. */
export const RULE_ACTIONS_MAX = 10;

/**
 * Merge fields a message may carry. Deliberately TINY and all from the contact or the card: the
 * builder's own wording goes in the message, and a field naming anything else (a price, another
 * customer, a URL we build) is a way to leak one customer's data into another's text.
 */
export const RULE_MERGE_FIELDS: Record<string, string> = {
  "{{first_name}}": "The customer's first name",
  "{{name}}": "The customer's full name",
  "{{company}}": "Their company",
  "{{business}}": "Your business name",
  "{{deal_title}}": "The card's title",
};

/** The actions, in the order the editor offers them: inside the Hub first, reaching the customer
 *  last, because that is the order of how much a mistake costs. */
export const RULE_ACTION_KINDS = [
  "set_status", "move_stage", "mark_lost", "reopen",
  "set_follow_up", "set_close_date", "add_note", "create_card",
  "send_sms", "send_email",
] as const;
export type RuleActionKind = typeof RULE_ACTION_KINDS[number];

export const RULE_ACTION_LABELS: Record<RuleActionKind, string> = {
  set_status: "Set the status to…",
  move_stage: "Move the card to stage…",
  mark_lost: "Mark it lost, reason…",
  reopen: "Reopen it if it was lost",
  set_follow_up: "Set a follow-up in… days",
  set_close_date: "Set the expected close date in… days",
  add_note: "Add a note to the customer",
  create_card: "Create a card in another pipeline",
  send_sms: "Send the customer a text",
  send_email: "Send the customer an email",
};

/** An action that reaches the customer. Named rather than tested inline because three places care:
 *  the editor's warning, the outbox, and the tick's opt-out check. */
export const RULE_OUTBOUND: readonly RuleActionKind[] = ["send_sms", "send_email"];
export const isOutboundAction = (k: string): boolean => (RULE_OUTBOUND as readonly string[]).includes(k);

const str = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const days = (v: unknown): number | "bad" => {
  if (v === undefined || v === null || v === "") return "bad";
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > RULE_DAYS_MAX) return "bad";
  return n;
};

export type RuleActionIn = { kind: RuleActionKind; params: Record<string, unknown> };

/**
 * ONE ACTION'S PARAMS, per kind. This is the only validation the params get — migration 355
 * deliberately stores them as unchecked jsonb, because a CHECK spanning ten shapes is unreadable
 * and the evaluator treats a malformed row as a FAILED rule rather than guessing. So anything
 * waved through here becomes a rule that silently never works.
 */
export function parseRuleAction(b: Record<string, unknown>): Parsed<RuleActionIn> {
  const kind = str(b.kind, 32) as RuleActionKind | null;
  if (!kind || !(RULE_ACTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "Pick what the rule should do from the list." };
  }
  const p = (b.params && typeof b.params === "object" ? b.params : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (kind === "set_status") {
    const id = str(p.statusId, 64);
    if (!isUuidLike(id)) return { ok: false, error: "Pick which status to set." };
    out.statusId = id!.toLowerCase();

  } else if (kind === "move_stage") {
    const id = str(p.stageId, 64);
    if (!isUuidLike(id)) return { ok: false, error: "Pick which stage to move the card to." };
    out.stageId = id!.toLowerCase();

  } else if (kind === "mark_lost") {
    // crm_set_deal_lost REQUIRES a reason (353), so a rule without one is a rule that throws on
    // every card. Refused here, where somebody can read the sentence.
    const reason = str(p.reason, 200);
    if (!reason) return { ok: false, error: "Say why the rule marks it lost." };
    out.reason = reason;

  } else if (kind === "reopen") {
    // Nothing to configure.

  } else if (kind === "set_follow_up" || kind === "set_close_date") {
    const n = days(p.days);
    if (n === "bad") return { ok: false, error: `Give a number of days, 0 to ${RULE_DAYS_MAX}.` };
    out.days = n;

  } else if (kind === "add_note") {
    const body = str(p.body, RULE_NOTE_MAX);
    if (!body) return { ok: false, error: "Write the note the rule should add." };
    out.body = body;

  } else if (kind === "create_card") {
    const id = str(p.pipelineId, 64);
    if (!isUuidLike(id)) return { ok: false, error: "Pick the pipeline to create the card in." };
    out.pipelineId = id!.toLowerCase();
    const title = str(p.title, 200);
    if (title) out.title = title;

  } else if (kind === "send_sms") {
    const body = str(p.body, RULE_SMS_MAX + 1);
    if (!body) return { ok: false, error: "Write the text the rule should send." };
    if (body.length > RULE_SMS_MAX) return { ok: false, error: `Keep the text under ${RULE_SMS_MAX} characters.` };
    out.body = body;

  } else if (kind === "send_email") {
    const subject = str(p.subject, RULE_EMAIL_SUBJECT_MAX + 1);
    if (!subject) return { ok: false, error: "Give the email a subject." };
    if (subject.length > RULE_EMAIL_SUBJECT_MAX) return { ok: false, error: `Keep the subject under ${RULE_EMAIL_SUBJECT_MAX} characters.` };
    const body = str(p.body, RULE_EMAIL_BODY_MAX + 1);
    if (!body) return { ok: false, error: "Write the email the rule should send." };
    if (body.length > RULE_EMAIL_BODY_MAX) return { ok: false, error: `Keep the email under ${RULE_EMAIL_BODY_MAX} characters.` };
    out.subject = subject;
    out.body = body;
  }

  return { ok: true, kind, params: out };
}

export type RuleIn = {
  id: string | null;
  pipelineId: string | null;
  name: string | null;
  triggerKind: "event" | "elapsed" | null;
  triggerEvent: string | null;
  elapsedAnchor: string | null;
  elapsedDays: number | null;
  /** undefined = not being edited. */
  oncePerCard?: boolean;
  enabled?: boolean;
  /** undefined = leave the actions alone (a rename); an array REPLACES them whole. */
  actions?: RuleActionIn[];
  archive: boolean;
};

/**
 * One rule from the pipeline editor. A new rule must describe its trigger completely; an edit may
 * send any subset, so a rename does not have to repost the actions.
 *
 * The actions are posted WHOLE when they are posted at all, mirroring how a reorder works
 * elsewhere in this file's sibling: a per-action endpoint would need its own ordering, its own
 * gate and its own 409, for a list of at most ten rows that is always edited as a unit.
 */
export function parseRuleSave(b: Record<string, unknown>): Parsed<RuleIn> {
  const id = str(b.id, 64);
  if (id && !isUuidLike(id)) return { ok: false, error: "That rule wasn't found." };
  const pipelineId = str(b.pipelineId, 64);
  if (pipelineId && !isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline the rule belongs to." };
  if (!id && !isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline the rule belongs to." };

  const name = str(b.name, RULE_NAME_MAX + 1);
  if (name && name.length > RULE_NAME_MAX) return { ok: false, error: `Keep the rule name under ${RULE_NAME_MAX} characters.` };

  const archive = b.archive === true;
  let triggerKind: "event" | "elapsed" | null = null;
  let triggerEvent: string | null = null;
  let elapsedAnchor: string | null = null;
  let elapsedDays: number | null = null;

  const kindRaw = str(b.triggerKind, 16);
  if (kindRaw && kindRaw !== "event" && kindRaw !== "elapsed") {
    return { ok: false, error: "Pick when the rule runs." };
  }
  // A new rule must say; an edit that says nothing about the trigger keeps the one it has. The
  // database's own shape CHECK refuses a half-described row either way, but it answers with a
  // 23514 nobody can read.
  if (!id && !kindRaw && !archive) return { ok: false, error: "Pick when the rule runs." };

  if (kindRaw === "event") {
    triggerKind = "event";
    triggerEvent = str(b.triggerEvent, 32);
    if (!triggerEvent || !(triggerEvent in RULE_EVENTS)) return { ok: false, error: "Pick what happens from the list." };
  } else if (kindRaw === "elapsed") {
    triggerKind = "elapsed";
    elapsedAnchor = str(b.elapsedAnchor, 32);
    if (!elapsedAnchor || !(elapsedAnchor in RULE_ANCHORS)) return { ok: false, error: "Pick what the days are counted from." };
    const n = days(b.elapsedDays);
    if (n === "bad") return { ok: false, error: `Give a number of days, 0 to ${RULE_DAYS_MAX}.` };
    elapsedDays = n;
    // ⛔ AN ELAPSED RULE IS ALWAYS ONCE PER CARD (migration 355's crm_rules_elapsed_is_once).
    // "30 days after delivered" is true of a card from the moment it comes due and stays true, so
    // a rule allowed to run every time would fire on every sweep — a text to the same customer
    // every few minutes. Refused in words rather than left to the constraint's 23514.
    if (b.oncePerCard === false) return { ok: false, error: ELAPSED_IS_ONCE };
  }

  let actions: RuleActionIn[] | undefined = undefined;
  if (b.actions !== undefined) {
    if (!Array.isArray(b.actions)) return { ok: false, error: "Send the actions as a list." };
    if (b.actions.length > RULE_ACTIONS_MAX) return { ok: false, error: `Keep it to ${RULE_ACTIONS_MAX} actions in one rule.` };
    actions = [];
    for (const raw of b.actions) {
      const a = parseRuleAction((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>);
      if (!a.ok) return { ok: false, error: a.error };
      actions.push({ kind: a.kind, params: a.params });
    }
    // A rule with no actions is not a draft, it is a rule that fires and does nothing — and it
    // would still burn its once-per-card guard doing it.
    if (!actions.length && !archive) return { ok: false, error: "Give the rule something to do." };
  }
  if (!id && actions === undefined && !archive) return { ok: false, error: "Give the rule something to do." };

  return {
    ok: true,
    id: id ? id.toLowerCase() : null,
    pipelineId: pipelineId ? pipelineId.toLowerCase() : null,
    name, triggerKind, triggerEvent, elapsedAnchor, elapsedDays,
    oncePerCard: b.oncePerCard === undefined ? undefined : b.oncePerCard === true,
    enabled: b.enabled === undefined ? undefined : b.enabled === true,
    actions,
    archive,
  };
}

/** A full ordering of one pipeline's rules: every id exactly once. The twin of parseStageOrder. */
export function parseRuleOrder(b: Record<string, unknown>): Parsed<{ pipelineId: string; ids: string[] }> {
  const pipelineId = str(b.pipelineId, 64);
  if (!isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline to reorder." };
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100) return { ok: false, error: "Send the rules in their new order." };
  const ids = b.ids.map((v) => String(v).toLowerCase());
  if (ids.some((v) => !isUuidLike(v)) || new Set(ids).size !== ids.length) return { ok: false, error: "Send each rule once." };
  return { ok: true, pipelineId: pipelineId.toLowerCase(), ids };
}

/** One rule, said in a sentence, for the list row and the run log. The editor shows the same words
 *  so a builder reads back what they wrote rather than a form they have to re-interpret. */
export function ruleSentence(r: {
  triggerKind: string; triggerEvent?: string | null; elapsedAnchor?: string | null; elapsedDays?: number | null;
  actions?: { kind: string }[];
}): string {
  const when = r.triggerKind === "elapsed"
    ? `${r.elapsedDays ?? 0} day${r.elapsedDays === 1 ? "" : "s"} after ${RULE_ANCHORS[r.elapsedAnchor ?? ""] ?? "then"}`
    : (RULE_EVENTS[r.triggerEvent ?? ""] ?? "something happens");
  const what = (r.actions ?? []).map((a) => RULE_ACTION_LABELS[a.kind as RuleActionKind] ?? a.kind)
    .map((s) => s.replace(/…$/, "").trim());
  return `When ${when.charAt(0).toLowerCase() + when.slice(1)} → ${what.length ? what.join(", then ") : "nothing yet"}`;
}

/** Substitute the merge fields. Unknown `{{…}}` is LEFT ALONE rather than blanked: a builder who
 *  typed {{price}} should see their own mistake in the preview, not a sentence with a hole in it. */
export function fillMergeFields(text: string, v: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(v, k) ? (v[k] ?? "") : whole;
  });
}
