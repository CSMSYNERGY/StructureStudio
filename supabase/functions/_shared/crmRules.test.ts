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
  parseRuleSchedule, RULE_CONTACT_EVENTS, RULE_SCHEDULE_FREQS, scheduleWords,
  needsArmAction, RULE_ARMED, RULE_GHL_TAGS_MAX,
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
  eq(Object.keys(RULE_ANCHORS).sort(), ["contact_created", "delivered", "expected_close", "last_contact", "stage_entered"], "anchors");
  // 365's and 367's facts — pinned against the CHECK on crm_rules.trigger_event.
  eq(Object.keys(RULE_CONTACT_EVENTS).sort(), [
    "call_missed", "contact_created", "deal_lost", "deal_reopened", "form_submitted", "label_added",
    "meeting_booked", "meeting_cancelled", "meeting_completed", "meeting_no_show",
    "stage_changed", "text_received", "voicemail_left",
    // 367
    "build_completed", "change_order_sent", "change_order_signed", "delivery_scheduled",
    "email_bounced", "email_opened", "email_received", "lot_sold", "payment_received",
    "repair_completed", "repair_requested", "shop_purchase", "shop_request",
  ].sort(), "365 + 367 events");
  eq([...RULE_SCHEDULE_FREQS], ["daily", "weekly", "monthly", "yearly", "date_field"], "schedule freqs");
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
    ["add_note", "create_card", "add_label", "remove_label", "assign_owner", "create_task", "notify_team",
     "webhook", "ghl_push", "send_sms", "send_email"], "customers");
  // NOBODY: telling the team, or (370) telling another system.
  eq(RULE_ACTION_KINDS.filter((k) => actionAllowedForScope(k, "none")), ["notify_team", "webhook"], "nobody");
  eq(actionAllowedForScope("nope", "pipeline"), false, "an unknown action is never allowed");
});

Deno.test("a trigger fits who the rule is for", () => {
  eq(triggerAllowedForScope({ triggerKind: "event" }, "all_pipelines"), true, "event, every pipeline");
  eq(triggerAllowedForScope({ triggerKind: "event" }, "contacts"), true, "event, customers");
  eq(triggerAllowedForScope({ triggerKind: "elapsed" }, "all_pipelines"), true, "clock, every pipeline");
  // A customer clock counts only from a customer's own dates; a card clock never from "added".
  eq(triggerAllowedForScope({ triggerKind: "elapsed", elapsedAnchor: "delivered" }, "contacts"), false, "delivered, customers");
  eq(triggerAllowedForScope({ triggerKind: "elapsed", elapsedAnchor: "last_contact" }, "contacts"), true, "no contact, customers");
  eq(triggerAllowedForScope({ triggerKind: "elapsed", elapsedAnchor: "contact_created" }, "pipeline"), false, "added, a card");
  eq(triggerAllowedForScope({ triggerKind: "event" }, "none"), false, "nobody hears an event");
  eq(triggerAllowedForScope({ triggerKind: "schedule", scheduleFreq: "weekly" }, "none"), true, "nobody, weekly");
  // "On the date in their record" is a customer's record.
  eq(triggerAllowedForScope({ triggerKind: "schedule", scheduleFreq: "date_field" }, "contacts"), true, "date field, customers");
  eq(triggerAllowedForScope({ triggerKind: "schedule", scheduleFreq: "date_field" }, "pipeline"), false, "date field, cards");
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
  // 365: customers is live; nobody is, but only on a schedule.
  good(parseRuleSave({ ...ev, scopeKind: "contacts", actions: [{ kind: "add_note", params: { body: "x" } }] }), "customers");
  bad(parseRuleSave({ ...ev, scopeKind: "none" }), "nobody hears an event");
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
    "contact.days_since_contact", "contact.days_since_created",
    "contact.has_email", "contact.has_phone", "contact.label", "contact.owner", "contact.source",
    "deal.lost", "deal.source", "deal.stage", "deal.status", "deal.value", "event.label",
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

// ── ROUND 2a (migration 365) ───────────────────────────────────────────────────────────────────

Deno.test("a schedule is refused when the sweep could never run it", () => {
  bad(parseRuleSchedule({}), "nothing");
  bad(parseRuleSchedule({ freq: "hourly", at: "08:00" }), "unknown freq");
  bad(parseRuleSchedule({ freq: "daily", at: "8:00" }), "not HH:MM");
  bad(parseRuleSchedule({ freq: "daily", at: "24:00" }), "no 24:00");
  bad(parseRuleSchedule({ freq: "weekly", at: "08:00", days: [] }), "a week with no days");
  bad(parseRuleSchedule({ freq: "weekly", at: "08:00", days: [8] }), "day 8");
  bad(parseRuleSchedule({ freq: "monthly", at: "08:00", dayOfMonth: 32 }), "the 32nd");
  bad(parseRuleSchedule({ freq: "yearly", at: "08:00", month: 13, day: 1 }), "month 13");
  bad(parseRuleSchedule({ freq: "date_field", at: "08:00", field: "birthday" }), "a field that is not a custom one");
  eq((parseRuleSchedule({ freq: "weekly", at: "08:00", days: [4, 1, 4], extra: "x" }) as any).schedule,
    { freq: "weekly", at: "08:00", days: [1, 4], every: 1 }, "canonical");
  eq((parseRuleSchedule({ freq: "date_field", at: "09:30", field: "custom:install_date", offsetDays: -3, yearly: true }) as any).schedule,
    { freq: "date_field", at: "09:30", field: "custom:install_date", offsetDays: -3, yearly: true }, "date field");
});

Deno.test("a schedule reads back the way a person says it", () => {
  eq(scheduleWords({ freq: "daily", at: "08:00" }), "every day at 8:00 am", "daily");
  eq(scheduleWords({ freq: "weekly", at: "13:30", days: [1, 4], every: 1 }), "every Monday and Thursday at 1:30 pm", "weekly");
  eq(scheduleWords({ freq: "weekly", at: "08:00", days: [5], every: 2 }), "every 2 weeks on Friday at 8:00 am", "fortnightly");
  eq(scheduleWords({ freq: "monthly", at: "09:00", dayOfMonth: 1 }), "on the 1st of every month at 9:00 am", "monthly");
  eq(scheduleWords({ freq: "date_field", at: "09:00", field: "custom:bday", offsetDays: 0, yearly: true }),
    "on the date in their record, every year, at 9:00 am", "birthday");
  eq(ruleSentence({ triggerKind: "schedule", schedule: { freq: "weekly", at: "08:00", days: [1], every: 1 }, actions: [{ kind: "send_sms" }] }),
    "When every Monday at 8:00 am → Send the customer a text", "the row's sentence");
});

Deno.test("a scheduled rule: once per run, team-only allowed, and email since 366", () => {
  const sch = { triggerKind: "schedule", schedule: { freq: "weekly", at: "08:00", days: [1] } };
  good(parseRuleSave({ ...sch, scopeKind: "contacts", actions: [{ kind: "send_sms", params: { body: "Hi" } }] }), "a Monday text");
  bad(parseRuleSave({ ...sch, scopeKind: "contacts", oncePerCard: false, actions: [{ kind: "send_sms", params: { body: "Hi" } }] }), "repeating");
  good(parseRuleSave({ ...sch, scopeKind: "none", actions: [{ kind: "notify_team", params: { subject: "Lot", body: "Walk it" } }] }), "team only");
  bad(parseRuleSave({ ...sch, scopeKind: "none", actions: [{ kind: "send_sms", params: { body: "Hi" } }] }), "nobody cannot text a customer");
  // 366: every automated email carries a working unsubscribe link, so a scheduled one is allowed.
  good(parseRuleSave({ ...sch, scopeKind: "contacts", actions: [{ kind: "send_email", params: { subject: "Hi", body: "Hi" } }] }), "a scheduled email");
  // The arm: a count, or nothing.
  const armed = parseRuleSave({ id: R, arm: true, armedCount: 12 });
  eq([(armed as any).arm, (armed as any).armedCount], [true, 12], "armed");
  bad(parseRuleSave({ id: R, arm: true }), "armed with no count");
  eq((parseRuleSave({ id: R, arm: false }) as any).arm, false, "disarmed");
});

Deno.test("the new actions are refused when they would fail on every customer", () => {
  bad(parseRuleAction({ kind: "add_label", params: {} }), "no tag");
  good(parseRuleAction({ kind: "remove_label", params: { label: " Lot visitor " } }), "remove a tag");
  bad(parseRuleAction({ kind: "assign_owner", params: { userId: "Pat" } }), "an owner by name");
  good(parseRuleAction({ kind: "assign_owner", params: { userId: P } }), "an owner by id");
  bad(parseRuleAction({ kind: "create_task", params: {} }), "a task with no title");
  eq((parseRuleAction({ kind: "create_task", params: { title: "Call them" } }) as any).params, { title: "Call them", dueDays: 0 }, "due today by default");
  bad(parseRuleAction({ kind: "notify_team", params: { subject: "x" } }), "no body");
  bad(parseRuleAction({ kind: "notify_team", params: { subject: "x", body: "y", userIds: ["nope"] } }), "a junk person");
  good(parseRuleAction({ kind: "notify_team", params: { subject: "x", body: "y" } }), "owners and admins by default");
});

Deno.test("365's condition fields read days and sources", () => {
  good(parseRuleConditions([{ field: "contact.days_since_contact", op: "gt", value: "30" }], "contacts"), "no contact for 30 days");
  bad(parseRuleConditions([{ field: "contact.days_since_contact", op: "gt", value: 2.5 }], "contacts"), "half a day");
  good(parseRuleConditions([{ field: "contact.source", op: "eq", value: "form" }], "contacts"), "came from a form");
  bad(parseRuleConditions([{ field: "contact.source", op: "eq", value: "carrier pigeon" }], "contacts"), "a source not in the list");
  good(parseRuleConditions([{ field: "event.label", op: "eq", value: "Hot" }], "contacts"), "the tag that was added");
});

// ── 370: webhook, GoHighLevel push, a saved email ─────────────────────────────────────────────

const T = "44444444-5555-4666-8777-888888888888";
const HEX = "0123456789abcdef".repeat(4);

Deno.test("370: a schedule for a group must be armed to message them OR hand them to another system", () => {
  eq([...RULE_ARMED], ["send_sms", "send_email", "webhook", "ghl_push"], "armed set");
  eq(RULE_ACTION_KINDS.filter((k) => needsArmAction(k)), ["webhook", "ghl_push", "send_sms", "send_email"], "in editor order");
  // The customer-messaging set is unchanged: the editor's "it messages the customer" warning reads it.
  eq(RULE_ACTION_KINDS.filter((k) => isOutboundAction(k)), ["send_sms", "send_email"], "outbound set unchanged");
});

Deno.test("370: a webhook address goes through the guard at save", () => {
  const ok = parseRuleAction({ kind: "webhook", params: { url: "  https://hooks.zapier.com/hooks/catch/1/abc/  " } });
  good(ok, "a zapier hook");
  eq((ok as { params: Record<string, unknown> }).params, { url: "https://hooks.zapier.com/hooks/catch/1/abc/" }, "normalised, no secret yet");
  for (const url of ["", "http://hooks.zapier.com/x", "https://10.0.0.1/x", "https://hooks.example.com:8080/x",
                     "https://user:pw@hooks.example.com/", "https://localhost/x", "https://printer.local/x", "file:///etc/passwd", "javascript:alert(1)"]) {
    bad(parseRuleAction({ kind: "webhook", params: { url } }), `refused: ${url}`);
  }
});

Deno.test("370: a webhook's secret is kept only in its own shape", () => {
  const kept = parseRuleAction({ kind: "webhook", params: { url: "https://h.example.com/x", secret: HEX } }) as { params: Record<string, unknown> };
  eq(kept.params.secret, HEX, "kept");
  for (const secret of ["short", HEX.toUpperCase(), HEX + "0", { a: 1 }]) {
    const r = parseRuleAction({ kind: "webhook", params: { url: "https://h.example.com/x", secret } }) as { params: Record<string, unknown> };
    eq("secret" in r.params, false, `dropped: ${JSON.stringify(secret)}`);
  }
});

Deno.test("370: GoHighLevel tags are trimmed, de-duplicated and capped", () => {
  const r = parseRuleAction({ kind: "ghl_push", params: { tags: [" lot-buyer ", "Lot-Buyer", "", 7, "review"] } }) as { ok: boolean; params: Record<string, unknown> };
  good(r, "tags");
  eq(r.params.tags, ["lot-buyer", "review"], "cleaned");
  good(parseRuleAction({ kind: "ghl_push", params: {} }), "no tags is just a push");
  bad(parseRuleAction({ kind: "ghl_push", params: { tags: ["x".repeat(61)] } }), "a long tag");
  bad(parseRuleAction({ kind: "ghl_push", params: { tags: Array.from({ length: RULE_GHL_TAGS_MAX + 1 }, (_v, i) => `t${i}`) } }), "too many tags");
});

Deno.test("370: an email is EITHER a saved template OR typed words", () => {
  const t = parseRuleAction({ kind: "send_email", params: { templateId: T.toUpperCase(), subject: "ignored", body: "ignored" } }) as { ok: boolean; params: Record<string, unknown> };
  good(t, "a template");
  eq(t.params, { templateId: T }, "only the template is kept");
  bad(parseRuleAction({ kind: "send_email", params: { templateId: "not-a-uuid" } }), "a junk template id");
  // An empty templateId is the typed kind, with its own refusals.
  bad(parseRuleAction({ kind: "send_email", params: { templateId: "", subject: "Hi" } }), "typed, no body");
  good(parseRuleAction({ kind: "send_email", params: { templateId: "", subject: "Hi", body: "Hello" } }), "typed");
});

Deno.test("370: who the new actions are for", () => {
  eq([actionAllowedForScope("webhook", "none"), actionAllowedForScope("ghl_push", "none")], [true, false], "nobody");
  eq([actionAllowedForScope("webhook", "contacts"), actionAllowedForScope("ghl_push", "contacts")], [true, true], "customers");
});
