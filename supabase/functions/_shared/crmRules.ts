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
// Carolyn, 2026-11-04 (migration 363): a rule is no longer the property of one pipeline. It says
// WHO it is for — cards in one pipeline, cards in every pipeline, customers matching a filter, or
// nobody — and may carry "only if" conditions. Round 1 ships the first two scopes; the parser
// refuses the other two in words until round 2 builds what they need.
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

// ── WHO A RULE IS FOR (migration 363) ─────────────────────────────────────────────────────────

/** The "runs on" picker, in the order the editor shows it. Mirrored in portal/02-sales.jsx as
 *  SS_RULE_SCOPES; preflight's checkRuleMirror compares the two. */
export const RULE_SCOPES = ["pipeline", "all_pipelines", "contacts", "none"] as const;
export type RuleScope = typeof RULE_SCOPES[number];

/** The scopes a builder may SAVE today. 'contacts' needs the audience query and 'none' needs the
 *  schedule; both arrive in round 2, and the database already admits them (363). */
export const RULE_SCOPES_LIVE: readonly RuleScope[] = ["pipeline", "all_pipelines"];
export const RULE_SCOPE_NOT_YET = "Rules for customers and for your team are coming in the next update.";

/** What a subject is able to give an action or a condition. A rule on one pipeline knows the card,
 *  the customer AND which pipeline's statuses and stages are meant; an every-pipeline rule knows
 *  the card and the customer but not the ladder; a customer rule knows only the customer. */
export type RuleNeed = "pipeline" | "deal" | "contact" | "any";
const SCOPE_PROVIDES: Record<RuleScope, readonly RuleNeed[]> = {
  pipeline: ["pipeline", "deal", "contact", "any"],
  all_pipelines: ["deal", "contact", "any"],
  contacts: ["contact", "any"],
  none: ["any"],
};
const scopeProvides = (scope: string, need: RuleNeed): boolean =>
  ((SCOPE_PROVIDES as Record<string, readonly RuleNeed[]>)[scope] ?? []).includes(need);

/**
 * What each action needs from its subject. Mirrored as SS_RULE_ACTION_NEEDS and compared VALUE by
 * value by preflight, because a browser that thought "set the status" worked on every pipeline
 * would offer it there — and a status belongs to exactly one pipeline (354), so it cannot.
 */
export const RULE_ACTION_NEEDS: Record<RuleActionKind, RuleNeed> = {
  set_status: "pipeline",
  move_stage: "pipeline",
  mark_lost: "deal",
  reopen: "deal",
  set_follow_up: "deal",
  set_close_date: "deal",
  add_note: "contact",
  create_card: "contact",
  send_sms: "contact",
  send_email: "contact",
};

export const actionAllowedForScope = (kind: string, scope: string): boolean => {
  const need = (RULE_ACTION_NEEDS as Record<string, RuleNeed>)[kind];
  return !!need && scopeProvides(scope, need);
};

/** A trigger a scope can hear. Every clock in round 1 counts from something on the CARD, so a
 *  customer rule cannot wait for one; an event reaches every subject scope (363's fan-out). */
export function triggerAllowedForScope(t: { triggerKind: string | null }, scope: string): boolean {
  if (scope === "none") return false;                     // round 2: schedules only
  if (t.triggerKind === "elapsed") return scopeProvides(scope, "deal");
  return t.triggerKind === "event";
}

// ── "ONLY IF" (migration 363) ─────────────────────────────────────────────────────────────────

/** How a condition compares. Mirrored as SS_RULE_CONDITION_OPS. */
export const RULE_CONDITION_OPS = ["eq", "neq", "gt", "lt", "has", "lacks", "is_empty", "not_empty"] as const;
export type RuleConditionOp = typeof RULE_CONDITION_OPS[number];

export type RuleConditionType = "money" | "status" | "stage" | "bool" | "choice" | "owner" | "label";
export type RuleConditionField = { label: string; type: RuleConditionType; needs: RuleNeed; ops: readonly RuleConditionOp[] };

/** Where a card came from — crm_deals.source's own list (325). */
export const RULE_DEAL_SOURCES: Record<string, string> = {
  manual: "Added by hand",
  import: "Imported",
  booking: "A booking",
  phone: "A phone call",
  design: "A design",
  form: "A lead form",
};

/**
 * THE CLOSED VOCABULARY, keyed EXACTLY as migration 363's crm_rule_facts builds its object — the
 * database compares by these names and knows no others (an unknown one reads FALSE there, so a
 * rename here that missed the SQL would silently stop every rule that used it). Mirrored as
 * SS_RULE_CONDITION_FIELDS in the browser.
 */
export const RULE_CONDITION_FIELDS: Record<string, RuleConditionField> = {
  "deal.value": { label: "The card's value", type: "money", needs: "deal", ops: ["gt", "lt", "eq", "neq"] },
  "deal.status": { label: "The card's status", type: "status", needs: "pipeline", ops: ["eq", "neq"] },
  "deal.stage": { label: "The card's stage", type: "stage", needs: "pipeline", ops: ["eq", "neq"] },
  "deal.lost": { label: "The card is lost", type: "bool", needs: "deal", ops: ["eq"] },
  "deal.source": { label: "Where the card came from", type: "choice", needs: "deal", ops: ["eq", "neq"] },
  "contact.has_phone": { label: "The customer has a phone number", type: "bool", needs: "contact", ops: ["eq"] },
  "contact.has_email": { label: "The customer has an email address", type: "bool", needs: "contact", ops: ["eq"] },
  "contact.owner": { label: "The customer's owner", type: "owner", needs: "contact", ops: ["eq", "neq", "is_empty", "not_empty"] },
  "contact.label": { label: "The customer's tags", type: "label", needs: "contact", ops: ["has", "lacks"] },
};
export const RULE_CONDITIONS_MAX = 10;
export const RULE_LABEL_MAX = 60;

export type RuleCondition = { field: string; op: RuleConditionOp; value: unknown };

/**
 * A rule's conditions, whole. ALL must hold. Refused here rather than at run time, because the
 * evaluator reads anything it does not understand as FALSE — a rule that quietly never fires.
 */
export function parseRuleConditions(raw: unknown, scope: string): Parsed<{ conditions: RuleCondition[] }> {
  if (raw === undefined || raw === null) return { ok: true, conditions: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Send the conditions as a list." };
  if (raw.length > RULE_CONDITIONS_MAX) return { ok: false, error: `Keep it to ${RULE_CONDITIONS_MAX} conditions in one rule.` };
  const out: RuleCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = (raw[i] && typeof raw[i] === "object" ? raw[i] : {}) as Record<string, unknown>;
    const n = i + 1;
    const field = str(c.field, 64);
    const spec = field ? RULE_CONDITION_FIELDS[field] : undefined;
    if (!field || !spec) return { ok: false, error: `Condition ${n}: pick what it checks from the list.` };
    if (!scopeProvides(scope, spec.needs)) {
      return {
        ok: false,
        error: spec.needs === "pipeline"
          ? `Condition ${n} (${spec.label}) needs one pipeline — a status or stage belongs to one pipeline.`
          : `Condition ${n} (${spec.label}) needs a card, and this rule runs on customers.`,
      };
    }
    const op = str(c.op, 16) as RuleConditionOp | null;
    if (!op || !spec.ops.includes(op)) return { ok: false, error: `Condition ${n}: pick how it compares.` };
    let value: unknown = null;
    if (op === "is_empty" || op === "not_empty") {
      value = null;
    } else if (spec.type === "money") {
      const v = Number(c.value);
      if (c.value === "" || c.value === null || c.value === undefined || !Number.isFinite(v) || v < 0 || v > 100_000_000) {
        return { ok: false, error: `Condition ${n}: give an amount in dollars.` };
      }
      value = Math.round(v * 100) / 100;
    } else if (spec.type === "status" || spec.type === "stage" || spec.type === "owner") {
      const v = str(c.value, 64);
      if (!isUuidLike(v)) return { ok: false, error: `Condition ${n}: pick ${spec.type === "owner" ? "a person" : `a ${spec.type}`}.` };
      value = v!.toLowerCase();
    } else if (spec.type === "bool") {
      if (c.value !== true && c.value !== false) return { ok: false, error: `Condition ${n}: pick yes or no.` };
      value = c.value;
    } else if (spec.type === "choice") {
      const v = str(c.value, 32);
      if (!v || !(v in RULE_DEAL_SOURCES)) return { ok: false, error: `Condition ${n}: pick one from the list.` };
      value = v;
    } else if (spec.type === "label") {
      const v = str(c.value, RULE_LABEL_MAX + 1);
      if (!v) return { ok: false, error: `Condition ${n}: name the tag.` };
      if (v.length > RULE_LABEL_MAX) return { ok: false, error: `Condition ${n}: keep the tag under ${RULE_LABEL_MAX} characters.` };
      value = v;
    }
    out.push({ field, op, value });
  }
  return { ok: true, conditions: out };
}

/** Who a rule is for, in the words the list shows on each row. */
export function audienceLabel(
  r: { scopeKind?: string | null; pipelineId?: string | null; conditions?: { field: string; op: string; value: unknown }[] },
  pipelines: { id: string; name: string }[],
): string {
  const scope = r.scopeKind || "pipeline";
  if (scope === "pipeline") {
    const p = pipelines.find((x) => x.id === r.pipelineId);
    return p ? p.name : "A pipeline that was removed";
  }
  if (scope === "all_pipelines") return "Every pipeline";
  if (scope === "none") return "Your team";
  const tag = (r.conditions ?? []).find((c) => c.field === "contact.label" && c.op === "has");
  if (tag) return `Customers tagged ${String(tag.value)}`;
  const n = (r.conditions ?? []).length;
  return n ? `Customers matching ${n} condition${n === 1 ? "" : "s"}` : "All customers";
}

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
  /** null on an edit that does not change who the rule is for. */
  scopeKind: RuleScope | null;
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
  /** Same: undefined = leave them alone; an array replaces them whole. Shape only here — the
   *  HANDLER validates them with parseRuleConditions against the effective scope, which on an
   *  edit that posts no scope only it knows. */
  conditions?: unknown[];
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
  if (pipelineId && !isUuidLike(pipelineId)) return { ok: false, error: "Pick the pipeline the rule runs on." };

  // WHO IT IS FOR (363). A caller that names only a pipeline — the bundle that shipped with 355 —
  // means a one-pipeline rule, so that is the default rather than a refusal.
  const scopeRaw = str(b.scopeKind, 32);
  if (scopeRaw && !(RULE_SCOPES as readonly string[]).includes(scopeRaw)) {
    return { ok: false, error: "Pick who the rule is for." };
  }
  const scopeKind: RuleScope | null = (scopeRaw as RuleScope | null) ?? (pipelineId ? "pipeline" : null);
  if (!id && !scopeKind) return { ok: false, error: "Pick who the rule is for." };
  if (scopeKind && !RULE_SCOPES_LIVE.includes(scopeKind)) return { ok: false, error: RULE_SCOPE_NOT_YET };
  // Onto a pipeline means naming it; off one drops whatever id came along (the database refuses
  // the pair outright, 363's crm_rules_scope_pipeline).
  if (scopeKind === "pipeline" && !pipelineId) return { ok: false, error: "Pick the pipeline the rule runs on." };

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

  // What a subject cannot carry is refused here when the request says who the rule is for. An
  // edit that posts no scope is checked by the handler against the STORED one.
  if (scopeKind && actions) {
    const i = actions.findIndex((a) => !actionAllowedForScope(a.kind, scopeKind));
    if (i >= 0) return { ok: false, error: actionScopeError(i, actions[i].kind) };
  }
  if (scopeKind && triggerKind && !triggerAllowedForScope({ triggerKind }, scopeKind)) {
    return { ok: false, error: "That kind of trigger doesn't work for who this rule is for." };
  }

  let conditions: unknown[] | undefined = undefined;
  if (b.conditions !== undefined) {
    if (!Array.isArray(b.conditions)) return { ok: false, error: "Send the conditions as a list." };
    if (b.conditions.length > RULE_CONDITIONS_MAX) return { ok: false, error: `Keep it to ${RULE_CONDITIONS_MAX} conditions in one rule.` };
    conditions = b.conditions;
  }

  return {
    ok: true,
    id: id ? id.toLowerCase() : null,
    scopeKind,
    pipelineId: scopeKind && scopeKind !== "pipeline" ? null : (pipelineId ? pipelineId.toLowerCase() : null),
    name, triggerKind, triggerEvent, elapsedAnchor, elapsedDays,
    oncePerCard: b.oncePerCard === undefined ? undefined : b.oncePerCard === true,
    enabled: b.enabled === undefined ? undefined : b.enabled === true,
    actions,
    conditions,
    archive,
  };
}

/** "Action 2 (Set the status to) needs one pipeline …" — the sentence the save refuses with, in
 *  one place so the parser and the handler (which checks STORED actions on an edit) agree. */
export function actionScopeError(index: number, kind: string): string {
  const label = (RULE_ACTION_LABELS[kind as RuleActionKind] ?? kind).replace(/…$/, "").trim();
  return RULE_ACTION_NEEDS[kind as RuleActionKind] === "pipeline"
    ? `Action ${index + 1} (${label}) needs one pipeline — a status or stage belongs to one pipeline. Pick a pipeline, or a different action.`
    : `Action ${index + 1} (${label}) needs a card, and this rule runs on customers.`;
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
