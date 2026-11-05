// Unit tests for _shared/crmRules.ts (migration 355). Self-contained: no registry imports.
//
// These matter more than the usual parser tests, because migration 355 stores an action's params
// as UNCHECKED jsonb on purpose — a CHECK spanning ten shapes is unreadable — and the evaluator
// records a malformed action as a FAILED rule rather than guessing. So anything this file lets
// through becomes a rule that silently never works, on a feature whose whole point is that it
// works while nobody is watching.
import {
  actionAllowedForScope, actionScopeError, audienceLabel, fillMergeFields, isOutboundAction,
  parseRuleAction, parseRuleConditions, parseRuleSave, RULE_ACTION_KINDS, RULE_ACTION_NEEDS,
  RULE_ACTIONS_MAX, RULE_ANCHORS, RULE_CONDITION_FIELDS, RULE_CONDITION_OPS, RULE_CONDITIONS_MAX,
  RULE_DAYS_MAX, RULE_EVENTS, RULE_SCOPES, RULE_SMS_MAX, ruleSentence, triggerAllowedForScope,
} from "./crmRules.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function bad(r: { ok: boolean }, msg: string) {
  if (r.ok) throw new Error(`${msg}: expected a refusal, got ${JSON.stringify(r)}`);
}
function good(r: { ok: boolean }, msg: string) {
  if (!r.ok) throw new Error(`${msg}: expected ok, got ${JSON.stringify(r)}`);
}

const P = "11111111-2222-4333-8444-555555555555";
const S = "22222222-3333-4444-8555-666666666666";
const R = "33333333-4444-4555-8666-777777777777";

Deno.test("the event vocabulary is the SAME eight a status uses", () => {
  // Not a copy: a second list is the drift this product has already paid for twice (the Monday
  // label map, and area_level_for's SQL mirror). If this fails, someone forked it.
  eq(Object.keys(RULE_EVENTS).sort(), [
    "build_scheduled", "contact_made", "delivered", "design_submitted",
    "estimate_accepted", "estimate_sent", "invoiced", "paid_in_full",
  ], "events");
  eq(Object.keys(RULE_ANCHORS).sort(), ["delivered", "expected_close", "last_contact", "stage_entered"], "anchors");
});

Deno.test("an action's params are refused when they would make the rule throw", () => {
  bad(parseRuleAction({ kind: "nope" }), "unknown kind");
  bad(parseRuleAction({ kind: "set_status", params: {} }), "no status");
  bad(parseRuleAction({ kind: "set_status", params: { statusId: "not-a-uuid" } }), "junk status");
  good(parseRuleAction({ kind: "set_status", params: { statusId: S.toUpperCase() } }), "status");
  eq((parseRuleAction({ kind: "set_status", params: { statusId: S.toUpperCase() } }) as any).params.statusId, S, "lowercased");

  // crm_set_deal_lost raises without a reason, so a reasonless rule is one that fails on every
  // card it touches. Refused where a person can read the sentence.
  bad(parseRuleAction({ kind: "mark_lost", params: {} }), "lost with no reason");
  good(parseRuleAction({ kind: "mark_lost", params: { reason: "No answer" } }), "lost");

  good(parseRuleAction({ kind: "reopen" }), "reopen needs nothing");
  eq((parseRuleAction({ kind: "reopen" }) as any).params, {}, "reopen params");

  bad(parseRuleAction({ kind: "set_follow_up", params: {} }), "no days");
  bad(parseRuleAction({ kind: "set_follow_up", params: { days: -1 } }), "negative days");
  bad(parseRuleAction({ kind: "set_follow_up", params: { days: RULE_DAYS_MAX + 1 } }), "too many days");
  bad(parseRuleAction({ kind: "set_follow_up", params: { days: 1.5 } }), "fractional days");
  good(parseRuleAction({ kind: "set_follow_up", params: { days: 0 } }), "today is a valid follow-up");

  bad(parseRuleAction({ kind: "add_note", params: { body: "   " } }), "blank note");
  good(parseRuleAction({ kind: "add_note", params: { body: "Called, no answer" } }), "note");

  bad(parseRuleAction({ kind: "create_card", params: {} }), "no pipeline");
  good(parseRuleAction({ kind: "create_card", params: { pipelineId: P } }), "create card");
  eq((parseRuleAction({ kind: "create_card", params: { pipelineId: P, title: " Review " } }) as any).params.title, "Review", "trimmed title");
});

Deno.test("a message is refused when empty and capped when long", () => {
  bad(parseRuleAction({ kind: "send_sms", params: {} }), "no text");
  bad(parseRuleAction({ kind: "send_sms", params: { body: "x".repeat(RULE_SMS_MAX + 1) } }), "over the segment cap");
  good(parseRuleAction({ kind: "send_sms", params: { body: "Hi {{first_name}}!" } }), "text");

  bad(parseRuleAction({ kind: "send_email", params: { body: "hello" } }), "no subject");
  bad(parseRuleAction({ kind: "send_email", params: { subject: "Hi" } }), "no body");
  good(parseRuleAction({ kind: "send_email", params: { subject: "Hi", body: "hello" } }), "email");

  eq(RULE_OUTBOUND_CHECK(), ["send_sms", "send_email"], "outbound set");
});
function RULE_OUTBOUND_CHECK() {
  return RULE_ACTION_KINDS.filter((k) => isOutboundAction(k));
}

Deno.test("a rule must describe its trigger completely", () => {
  bad(parseRuleSave({}), "nothing at all");
  bad(parseRuleSave({ pipelineId: P }), "no trigger");
  bad(parseRuleSave({ pipelineId: P, triggerKind: "someday" }), "unknown kind");
  // An event rule with no event, and an elapsed rule with no anchor or no days: each is the
  // half-described row migration 355's shape CHECK refuses with an unreadable 23514.
  bad(parseRuleSave({ pipelineId: P, triggerKind: "event" }), "event kind, no event");
  bad(parseRuleSave({ pipelineId: P, triggerKind: "event", triggerEvent: "shipped" }), "event not in the list");
  bad(parseRuleSave({ pipelineId: P, triggerKind: "elapsed", elapsedDays: 30 }), "elapsed, no anchor");
  bad(parseRuleSave({ pipelineId: P, triggerKind: "elapsed", elapsedAnchor: "delivered" }), "elapsed, no days");

  const ok = parseRuleSave({
    pipelineId: P, triggerKind: "elapsed", elapsedAnchor: "delivered", elapsedDays: 30,
    actions: [{ kind: "send_sms", params: { body: "How is the shed?" } }],
  });
  good(ok, "Carolyn's reviews rule");
  eq((ok as any).elapsedDays, 30, "days");
  eq((ok as any).triggerEvent, null, "no event on an elapsed rule");
  // The defaults the database applies are left ALONE when not sent, so a caller that omits them
  // gets once-per-card and enabled from the column defaults rather than from here.
  eq((ok as any).oncePerCard, undefined, "once left to the column default");
  eq((ok as any).enabled, undefined, "enabled left to the column default");
});

Deno.test("a time rule may not be asked to repeat", () => {
  // The hazard migration 355 made a CHECK: once a clock rule comes due it STAYS due, so one
  // allowed to run every time fires on every sweep — the same customer texted every few minutes.
  bad(parseRuleSave({
    pipelineId: P, triggerKind: "elapsed", elapsedAnchor: "delivered", elapsedDays: 30,
    oncePerCard: false, actions: [{ kind: "reopen" }],
  }), "a repeating clock rule");
  good(parseRuleSave({
    pipelineId: P, triggerKind: "elapsed", elapsedAnchor: "delivered", elapsedDays: 30,
    oncePerCard: true, actions: [{ kind: "reopen" }],
  }), "once is fine");
  // An EVENT happens and is over, so repeating is meaningful there.
  good(parseRuleSave({
    pipelineId: P, triggerKind: "event", triggerEvent: "contact_made",
    oncePerCard: false, actions: [{ kind: "reopen" }],
  }), "a repeating event rule");
});

Deno.test("a rule with nothing to do is refused, and ten actions is the cap", () => {
  bad(parseRuleSave({ pipelineId: P, triggerKind: "event", triggerEvent: "delivered" }), "no actions on a new rule");
  bad(parseRuleSave({ pipelineId: P, triggerKind: "event", triggerEvent: "delivered", actions: [] }), "empty action list");
  bad(parseRuleSave({
    pipelineId: P, triggerKind: "event", triggerEvent: "delivered",
    actions: Array.from({ length: RULE_ACTIONS_MAX + 1 }, () => ({ kind: "reopen" })),
  }), "over the action cap");
  bad(parseRuleSave({
    pipelineId: P, triggerKind: "event", triggerEvent: "delivered",
    actions: [{ kind: "reopen" }, { kind: "set_status", params: {} }],
  }), "one bad action refuses the whole rule");
  // An EDIT may send a subset: renaming a rule must not mean reposting its actions.
  good(parseRuleSave({ id: R, name: "Review nudge" }), "a rename");
  eq((parseRuleSave({ id: R, name: "Review nudge" }) as any).actions, undefined, "actions untouched");
  good(parseRuleSave({ id: R, archive: true }), "archiving needs nothing else");
});

// ── WHO A RULE IS FOR (migration 363) ──────────────────────────────────────────────────────────

Deno.test("every action says what it needs, and every scope gives what it should", () => {
  // A second list would drift; this one is compared to the browser's VALUE by value in preflight.
  eq(Object.keys(RULE_ACTION_NEEDS).sort(), [...RULE_ACTION_KINDS].sort(), "a need for every action");
  eq([...RULE_SCOPES], ["pipeline", "all_pipelines", "contacts", "none"], "the picker's order");
  // ONE PIPELINE: everything.
  for (const k of RULE_ACTION_KINDS) eq(actionAllowedForScope(k, "pipeline"), true, `pipeline + ${k}`);
  // EVERY PIPELINE: a status or a stage belongs to ONE pipeline (354), so those two cannot be named.
  eq(RULE_ACTION_KINDS.filter((k) => !actionAllowedForScope(k, "all_pipelines")), ["set_status", "move_stage"], "every pipeline");
  // CUSTOMERS: nothing that writes to a card.
  eq(RULE_ACTION_KINDS.filter((k) => actionAllowedForScope(k, "contacts")),
    ["add_note", "create_card", "send_sms", "send_email"], "customers");
  // NOBODY: nothing a round-1 action can do.
  eq(RULE_ACTION_KINDS.filter((k) => actionAllowedForScope(k, "none")), [], "nobody");
  eq(actionAllowedForScope("nope", "pipeline"), false, "an unknown action is never allowed");
});

Deno.test("a trigger fits who the rule is for", () => {
  eq(triggerAllowedForScope({ triggerKind: "event" }, "all_pipelines"), true, "event, every pipeline");
  eq(triggerAllowedForScope({ triggerKind: "event" }, "contacts"), true, "event, customers");
  eq(triggerAllowedForScope({ triggerKind: "elapsed" }, "all_pipelines"), true, "clock, every pipeline");
  // Every round-1 clock counts from something on the CARD.
  eq(triggerAllowedForScope({ triggerKind: "elapsed" }, "contacts"), false, "clock, customers");
  eq(triggerAllowedForScope({ triggerKind: "event" }, "none"), false, "nobody hears an event");
});

Deno.test("a rule says who it is for — and the bundle that only knew pipelines still works", () => {
  const ev = { triggerKind: "event", triggerEvent: "delivered", actions: [{ kind: "reopen" }] };
  bad(parseRuleSave({ ...ev }), "no scope and no pipeline");
  bad(parseRuleSave({ ...ev, scopeKind: "somewhere" }), "unknown scope");
  // The 355 bundle posts a pipeline and no scope: that IS a one-pipeline rule.
  const legacy = parseRuleSave({ ...ev, pipelineId: P });
  good(legacy, "pipeline only");
  eq((legacy as any).scopeKind, "pipeline", "defaults to one pipeline");
  bad(parseRuleSave({ ...ev, scopeKind: "pipeline" }), "one pipeline, but which?");
  // Every pipeline drops a stray pipeline id rather than letting the database refuse the pair.
  const all = parseRuleSave({ ...ev, scopeKind: "all_pipelines", pipelineId: P });
  good(all, "every pipeline");
  eq((all as any).pipelineId, null, "the stray id is dropped");
  // Round 2's scopes are refused in words, not with a constraint error.
  bad(parseRuleSave({ ...ev, scopeKind: "contacts" }), "customers, not yet");
  bad(parseRuleSave({ ...ev, scopeKind: "none" }), "nobody, not yet");
});

Deno.test("an action the scope cannot carry is refused, and says which one", () => {
  const base = { scopeKind: "all_pipelines", triggerKind: "event", triggerEvent: "delivered" };
  const r = parseRuleSave({ ...base, actions: [{ kind: "reopen" }, { kind: "set_status", params: { statusId: S } }] });
  bad(r, "a status on every pipeline");
  if (!/Action 2 \(Set the status to\)/.test((r as any).error)) throw new Error(`names the action: ${(r as any).error}`);
  good(parseRuleSave({ ...base, actions: [{ kind: "reopen" }, { kind: "send_sms", params: { body: "Hi" } }] }), "card + customer actions");
  // A clock rule on every pipeline is fine; the anchor is on each card.
  good(parseRuleSave({
    scopeKind: "all_pipelines", triggerKind: "elapsed", elapsedAnchor: "stage_entered", elapsedDays: 7,
    actions: [{ kind: "set_follow_up", params: { days: 1 } }],
  }), "a clock on every pipeline");
  if (!/needs one pipeline/.test(actionScopeError(0, "move_stage"))) throw new Error("move_stage sentence");
  if (!/needs a card/.test(actionScopeError(2, "mark_lost"))) throw new Error("mark_lost sentence");
  // An edit that does not say who the rule is for is NOT checked here — only the handler knows
  // the stored scope — but it is not refused either.
  good(parseRuleSave({ id: R, actions: [{ kind: "set_status", params: { statusId: S } }] }), "an edit with no scope");
  eq((parseRuleSave({ id: R, name: "x" }) as any).scopeKind, null, "an edit leaves the scope alone");
});

// ── "ONLY IF" (migration 363) ──────────────────────────────────────────────────────────────────

Deno.test("the condition vocabulary is the one migration 363's crm_rule_facts builds", () => {
  // Rename one of these without the SQL and every rule using it silently stops: the database reads
  // a field it does not know as FALSE. So the list is pinned, and so is the SQL (363 PART 6).
  eq(Object.keys(RULE_CONDITION_FIELDS).sort(), [
    "contact.has_email", "contact.has_phone", "contact.label", "contact.owner",
    "deal.lost", "deal.source", "deal.stage", "deal.status", "deal.value",
  ], "fields");
  eq([...RULE_CONDITION_OPS], ["eq", "neq", "gt", "lt", "has", "lacks", "is_empty", "not_empty"], "ops");
  for (const [k, f] of Object.entries(RULE_CONDITION_FIELDS)) {
    for (const op of f.ops) if (!(RULE_CONDITION_OPS as readonly string[]).includes(op)) throw new Error(`${k}: ${op}`);
  }
});

Deno.test("a condition is refused when the database could only read it as false", () => {
  good(parseRuleConditions(undefined, "pipeline"), "none at all");
  bad(parseRuleConditions({ field: "deal.value" }, "pipeline"), "not a list");
  bad(parseRuleConditions([{ field: "deal.colour", op: "eq", value: "red" }], "pipeline"), "unknown field");
  bad(parseRuleConditions([{ field: "deal.value", op: "has", value: 1 }], "pipeline"), "an op that field does not take");
  bad(parseRuleConditions([{ field: "deal.value", op: "gt", value: "lots" }], "pipeline"), "not an amount");
  bad(parseRuleConditions([{ field: "deal.value", op: "gt", value: -5 }], "pipeline"), "a negative amount");
  bad(parseRuleConditions([{ field: "deal.value", op: "gt", value: "" }], "pipeline"), "a blank amount");
  bad(parseRuleConditions([{ field: "deal.stage", op: "eq", value: "Stage One" }], "pipeline"), "a stage by name");
  bad(parseRuleConditions([{ field: "deal.lost", op: "eq", value: "yes" }], "pipeline"), "yes as a word");
  bad(parseRuleConditions([{ field: "deal.source", op: "eq", value: "carrier pigeon" }], "pipeline"), "a source not in the list");
  bad(parseRuleConditions([{ field: "contact.label", op: "has", value: "  " }], "pipeline"), "a blank tag");
  bad(parseRuleConditions(Array.from({ length: RULE_CONDITIONS_MAX + 1 }, () => ({ field: "deal.lost", op: "eq", value: false })), "pipeline"), "over the cap");

  const ok = parseRuleConditions([
    { field: "deal.value", op: "gt", value: "10000" },
    { field: "deal.stage", op: "eq", value: S.toUpperCase() },
    { field: "contact.label", op: "has", value: " Lot visitor " },
    { field: "contact.owner", op: "is_empty", value: "ignored" },
  ], "pipeline");
  good(ok, "four conditions");
  eq((ok as any).conditions, [
    { field: "deal.value", op: "gt", value: 10000 },
    { field: "deal.stage", op: "eq", value: S },
    { field: "contact.label", op: "has", value: "Lot visitor" },
    { field: "contact.owner", op: "is_empty", value: null },
  ], "normalised");
});

Deno.test("a condition must fit who the rule is for", () => {
  const stage = [{ field: "deal.stage", op: "eq", value: S }];
  good(parseRuleConditions(stage, "pipeline"), "a stage on one pipeline");
  const r = parseRuleConditions(stage, "all_pipelines");
  bad(r, "a stage on every pipeline");
  if (!/needs one pipeline/.test((r as any).error)) throw new Error((r as any).error);
  good(parseRuleConditions([{ field: "deal.value", op: "gt", value: 1 }], "all_pipelines"), "a value on every pipeline");
  bad(parseRuleConditions([{ field: "deal.value", op: "gt", value: 1 }], "contacts"), "a card field on customers");
  good(parseRuleConditions([{ field: "contact.has_phone", op: "eq", value: true }], "contacts"), "a customer field on customers");
});

Deno.test("each row says who its rule is for", () => {
  const pipes = [{ id: P, name: "Shed Deals" }];
  eq(audienceLabel({ scopeKind: "pipeline", pipelineId: P }, pipes), "Shed Deals", "one pipeline");
  eq(audienceLabel({ pipelineId: P }, pipes), "Shed Deals", "a 355 rule with no scope");
  eq(audienceLabel({ scopeKind: "pipeline", pipelineId: S }, pipes), "A pipeline that was removed", "gone");
  eq(audienceLabel({ scopeKind: "all_pipelines" }, pipes), "Every pipeline", "every");
  eq(audienceLabel({ scopeKind: "contacts", conditions: [{ field: "contact.label", op: "has", value: "Lot visitor" }] }, pipes),
    "Customers tagged Lot visitor", "a tag");
  eq(audienceLabel({ scopeKind: "contacts", conditions: [] }, pipes), "All customers", "everyone");
  eq(audienceLabel({ scopeKind: "none" }, pipes), "Your team", "nobody");
});

Deno.test("the sentence reads back what was written", () => {
  eq(ruleSentence({
    triggerKind: "elapsed", elapsedAnchor: "delivered", elapsedDays: 30,
    actions: [{ kind: "set_status" }, { kind: "send_sms" }],
  }), "When 30 days after it was delivered → Set the status to, then Send the customer a text", "elapsed");
  eq(ruleSentence({ triggerKind: "elapsed", elapsedAnchor: "delivered", elapsedDays: 1, actions: [] }),
    "When 1 day after it was delivered → nothing yet", "one day, no actions");
  eq(ruleSentence({ triggerKind: "event", triggerEvent: "delivered", actions: [{ kind: "reopen" }] }),
    "When it is delivered → Reopen it if it was lost", "event");
});

Deno.test("merge fields fill, and an unknown one is left visible", () => {
  const v = { first_name: "Dale", name: "Dale Smith", company: "", business: "Junior Barns", deal_title: "20x30" };
  eq(fillMergeFields("Hi {{first_name}}, this is {{business}}.", v), "Hi Dale, this is Junior Barns.", "filled");
  eq(fillMergeFields("Hi {{ FIRST_NAME }}", v), "Hi Dale", "spaced and upper-cased");
  eq(fillMergeFields("Your {{company}} order", v), "Your  order", "a known field that is blank");
  // Left alone deliberately: a builder who typed {{price}} must see their own mistake in the
  // preview rather than a sentence with a hole in it.
  eq(fillMergeFields("It costs {{price}}", v), "It costs {{price}}", "unknown field survives");
});
