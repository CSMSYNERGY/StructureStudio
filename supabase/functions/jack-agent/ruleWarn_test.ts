import { assert, assertEquals } from "./test_assert.ts";
import type { Deps } from "./types.ts";
import { RULE_WARN_SAID, ruleWarning, SEND_RULE_SAID, sendRuleNotes } from "./ruleWarn.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const rule = (o: Record<string, unknown>): Any => ({
  id: crypto.randomUUID(), name: "A rule", scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: "delivered",
  elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null,
  actions: [{ kind: "add_note", params: {} }], nextRunAt: null, armedCount: null, lastRun: null, stale: [], ...o,
});

function deps(o: { rules?: Any[]; status?: number; error?: string; canSeeRules?: boolean } = {}): Deps {
  const portal: Deps["portal"] = (action) => {
    if (action !== "crm_rules_list") return Promise.resolve({ status: 404, data: null });
    if (o.status && o.status !== 200) return Promise.resolve({ status: o.status, data: o.error ? { error: o.error } : null });
    return Promise.resolve({ status: 200, data: { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: o.rules ?? [], labels: [], timeZone: "America/Chicago" } });
  };
  return { portal, canRead: (a: string) => a !== "settings_crm" || o.canSeeRules !== false } as unknown as Deps;
}

Deno.test("names the rules a change sets off, and says when one messages the customer", async () => {
  const w = await ruleWarning(deps({ rules: [
    rule({ name: "Thank them", actions: [{ kind: "send_sms", params: {} }] }),
    rule({ name: "Paused one", enabled: false }),
    rule({ name: "Other event", triggerEvent: "invoiced" }),
  ] }), ["delivered"]);
  assertEquals(w.named, ["Thank them"]);
  assertEquals(w.messages, true);
  assertEquals(w.sentence, 'This sets off your rule "Thank them", which texts or emails the customer by itself.');
});

Deno.test("a days-after-delivery rule counts for 'delivered'; a rule that only adds a note runs by itself", async () => {
  const w = await ruleWarning(deps({ rules: [rule({ name: "Review ask", triggerKind: "elapsed", triggerEvent: null, elapsedAnchor: "delivered", elapsedDays: 30 })] }), ["delivered"]);
  assertEquals(w.sentence, 'This starts the clock on your rule "Review ask", which runs by itself.');
  assertEquals(w.messages, false);
});

Deno.test("no rule, no sentence; no events, no read", async () => {
  assertEquals((await ruleWarning(deps({ rules: [rule({ triggerEvent: "invoiced" })] }), ["build_scheduled"])).sentence, null);
  assertEquals((await ruleWarning({ portal: () => { throw new Error("no read"); }, canRead: () => true } as unknown as Deps, [])).sentence, null);
});

Deno.test("someone who can't open Automations hears a general sentence and no names", async () => {
  const w = await ruleWarning(deps({ canSeeRules: false, rules: [rule({ name: "Secret", actions: [{ kind: "send_email", params: {} }] })] }), ["delivered"]);
  assertEquals([w.named, w.sentence], [[], RULE_WARN_SAID.general]);
});

Deno.test("a list that can't be read never claims there are no rules; no Customer Hub says nothing", async () => {
  assertEquals((await ruleWarning(deps({ status: 500 }), ["delivered"])).sentence, RULE_WARN_SAID.unread);
  const off = await ruleWarning(deps({ status: 403, error: "Customer Hub isn't on this account's subscription." }), ["delivered"]);
  assertEquals(off.sentence, null);
});

Deno.test("a rule name holding a phone number is scrubbed before it reaches the card or Claude", async () => {
  const w = await ruleWarning(deps({ rules: [rule({ name: "Call 816-555-0100 after delivery" })] }), ["delivered"]);
  assert(!/555-0100/.test(w.sentence ?? ""), w.sentence ?? "");
});

// ── sendRuleNotes: what a message Jack sends can set off ──────────────────────────────────────────

Deno.test("send notes: a text names the contact-made rules and the last-contact clocks, and nothing else", async () => {
  const notes = await sendRuleNotes(deps({ rules: [
    rule({ name: "Made contact", triggerEvent: "contact_made", actions: [{ kind: "set_status", params: {} }] }),
    rule({ name: "Nudge them", triggerKind: "elapsed", triggerEvent: null, elapsedAnchor: "last_contact", elapsedDays: 14 }),
    rule({ name: "Delivered one", triggerEvent: "delivered" }),
    rule({ name: "Opened one", triggerEvent: "email_opened" }),
    rule({ name: "Off one", triggerEvent: "contact_made", enabled: false }),
    rule({ name: "Stale one", triggerEvent: "contact_made", stale: ["stage"] }),
  ] }), "text");
  assertEquals(notes, [
    'This text can set off your rule "Made contact" (it starts when contact is made), which runs by itself.',
    'It restarts the clock on your rule "Nudge them", which counts the days since anyone last spoke to them.',
  ]);
});

Deno.test("send notes: an email and an estimate name the open and bounce rules, each by its own trigger, later, and say when one messages", async () => {
  const rules = [
    rule({ name: "Opened", triggerEvent: "email_opened", actions: [{ kind: "send_sms", params: {} }] }),
    rule({ name: "Bounced", triggerEvent: "email_bounced" }),
    rule({ name: "Made contact", triggerEvent: "contact_made" }),
    rule({ name: "Nudge them", triggerKind: "elapsed", triggerEvent: null, elapsedAnchor: "last_contact", elapsedDays: 14 }),
  ];
  assertEquals(await sendRuleNotes(deps({ rules }), "email"), [
    'If they open this email, that can set off your rule "Opened" later, which texts or emails the customer by itself.',
    'If this email bounces, that can set off your rule "Bounced" later, which runs by itself.',
  ]);
  assertEquals(await sendRuleNotes(deps({ rules }), "estimate"), [
    'If they open the estimate email, that can set off your rule "Opened" later, which texts or emails the customer by itself.',
    'If the estimate email bounces, that can set off your rule "Bounced" later, which runs by itself.',
  ]);
  // Only opened rules: nothing about a bounce. Only bounced rules: nothing about opening it.
  const opened = await sendRuleNotes(deps({ rules: [rules[0], rule({ name: "Opened too", triggerEvent: "email_opened" })] }), "email");
  assertEquals(opened, ['If they open this email, that can set off your rules "Opened" and "Opened too" later, which texts or emails the customer by itself (one or more of them).']);
  assert(!/bounce/i.test(opened.join(" ")), opened.join(" "));
  const bounced = await sendRuleNotes(deps({ rules: [rules[1]] }), "estimate");
  assertEquals(bounced, ['If the estimate email bounces, that can set off your rule "Bounced" later, which runs by itself.']);
  assert(!/open/i.test(bounced.join(" ")), bounced.join(" "));
  // An email never moves the last-contact clock, and a text never sets off an open.
  assertEquals((await sendRuleNotes(deps({ rules: [rules[0]] }), "text")), []);
  assertEquals((await sendRuleNotes(deps({ rules: [rules[2], rules[3]] }), "email")), []);
});

Deno.test("send notes: no names for someone who can't open Automations; an unread list never says there are none; no Customer Hub says nothing", async () => {
  const secret = [rule({ name: "Secret", triggerEvent: "contact_made", actions: [{ kind: "send_email", params: {} }] })];
  for (const what of ["text", "email", "estimate"] as const) {
    const blind = await sendRuleNotes(deps({ canSeeRules: false, rules: secret }), what);
    assertEquals(blind, [SEND_RULE_SAID[what]]);
    assert(!blind.join(" ").includes("Secret"));
    assertEquals(await sendRuleNotes(deps({ status: 500 }), what), [`${SEND_RULE_SAID.unread} ${SEND_RULE_SAID[what]}`]);
    assertEquals(await sendRuleNotes({ portal: () => { throw new Error("down"); }, canRead: () => true } as unknown as Deps, what), [`${SEND_RULE_SAID.unread} ${SEND_RULE_SAID[what]}`]);
    assertEquals(await sendRuleNotes(deps({ status: 403, error: "The Customer Hub is not part of your subscription." }), what), []);
  }
  // The general lines name kinds of rule, never a rule, and carry no dash Claude would copy.
  for (const s of Object.values(SEND_RULE_SAID)) assert(!/[—–]/.test(s), s);
});

Deno.test("send notes: a rule name holding a phone number or an email is scrubbed", async () => {
  const notes = await sendRuleNotes(deps({ rules: [rule({ name: "Text 816-555-0100 or a@example.com", triggerEvent: "contact_made" })] }), "text");
  assertEquals(notes.length, 1);
  assert(!/555-0100|@example/.test(notes[0]), notes[0]);
});
