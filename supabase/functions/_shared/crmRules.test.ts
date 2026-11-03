// Unit tests for _shared/crmRules.ts (migration 355). Self-contained: no registry imports.
//
// These matter more than the usual parser tests, because migration 355 stores an action's params
// as UNCHECKED jsonb on purpose — a CHECK spanning ten shapes is unreadable — and the evaluator
// records a malformed action as a FAILED rule rather than guessing. So anything this file lets
// through becomes a rule that silently never works, on a feature whose whole point is that it
// works while nobody is watching.
import {
  fillMergeFields, isOutboundAction, parseRuleAction, parseRuleOrder, parseRuleSave,
  RULE_ACTION_KINDS, RULE_ACTIONS_MAX, RULE_ANCHORS, RULE_DAYS_MAX, RULE_EVENTS, RULE_SMS_MAX,
  ruleSentence,
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

Deno.test("a reorder names its pipeline and sends each rule once", () => {
  bad(parseRuleOrder({ ids: [R] }), "no pipeline");
  bad(parseRuleOrder({ pipelineId: P, ids: [] }), "empty");
  bad(parseRuleOrder({ pipelineId: P, ids: [R, R] }), "duplicate");
  bad(parseRuleOrder({ pipelineId: P, ids: ["nope"] }), "junk id");
  good(parseRuleOrder({ pipelineId: P, ids: [R, S] }), "two rules");
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
