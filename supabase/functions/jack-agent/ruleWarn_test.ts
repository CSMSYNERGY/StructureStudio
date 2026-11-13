import { assert, assertEquals } from "./test_assert.ts";
import type { Deps } from "./types.ts";
import { RULE_WARN_SAID, ruleWarning, SEND_RULE_SAID, sendRuleNotes } from "./ruleWarn.ts";
import type { ServerAccess } from "./plan.ts";
import { MODULE_REFUSAL } from "../_shared/accessEnforce.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const rule = (o: Record<string, unknown>): Any => ({
  id: crypto.randomUUID(), name: "A rule", scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: "delivered",
  elapsedAnchor: null, elapsedDays: null, schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null,
  actions: [{ kind: "add_note", params: {} }], nextRunAt: null, armedCount: null, lastRun: null, stale: [], ...o,
});

/** `plan`: left out, Deps has no plan (as before plans existed); anything else is what the company's
 *  map read answers. `asked` collects every portal action, to show when the list is not read. */
function deps(o: { rules?: Any[]; status?: number; error?: string; canSeeRules?: boolean; plan?: ServerAccess | null | "throws"; asked?: string[] } = {}): Deps {
  const portal: Deps["portal"] = (action) => {
    o.asked?.push(action);
    if (action !== "crm_rules_list") return Promise.resolve({ status: 404, data: null });
    if (o.status && o.status !== 200) return Promise.resolve({ status: o.status, data: o.error ? { error: o.error } : null });
    return Promise.resolve({ status: 200, data: { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: o.rules ?? [], labels: [], timeZone: "America/Chicago" } });
  };
  return {
    portal, canRead: (a: string) => a !== "settings_crm" || o.canSeeRules !== false,
    ...(o.plan === undefined ? {} : { plan: () => (o.plan === "throws" ? Promise.reject(new Error("the map read threw")) : Promise.resolve(o.plan)) }),
  } as unknown as Deps;
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

// ── A company whose plan has no Automations (plans as data, stage D) ──────────────────────────────
//
// crm-rules-tick skips every send for a company the server BLOCKS by its map from Automations, so
// for that company no rule texts or emails anyone and a card has nothing to warn about: the same as
// "no Customer Hub on this account". Before this the list read (crm_rules_list, the Automations
// tab's) came back 403 "This isn't part of your plan", which is neither of the Customer Hub
// sentences, so every build, delivery, change-order and message card said "I couldn't check your
// rules just now", about rules that cannot send. The portal below answers what that door answers.

const planOff = (state: string | null): ServerAccess =>
  ({ mode: "block", modules: { contacts: "on", build_schedule: "on", ...(state ? { automations: state } : {}) } });
const DOOR_SAYS_NO = { status: 403, error: MODULE_REFUSAL };
const texts = [rule({ name: "Thank them", triggerEvent: "delivered", actions: [{ kind: "send_sms", params: {} }] }), rule({ name: "Made contact", triggerEvent: "contact_made" }), rule({ name: "Opened", triggerEvent: "email_opened" })];
/** The plans that change nothing: no plan at all, not named, a read that failed, REPORT mode without
 *  the tab (it refuses nothing, and the tick still sends), and block mode WITH the tab. */
const UNCHANGED: [string, ServerAccess | null | "throws" | undefined][] = [
  ["no plan", undefined], ["not named", null], ["a failed read", "throws"],
  ["report mode", { mode: "report", modules: { contacts: "on", automations: "hidden" } }],
  ["block with the tab on", planOff("on")],
];

Deno.test("a card for a company its plan blocks from Automations says nothing about rules, and the list is not read", async () => {
  for (const state of ["hidden", "locked", "off", null]) {
    for (const canSeeRules of [true, false]) {
      const asked: string[] = [];
      const w = await ruleWarning(deps({ ...DOOR_SAYS_NO, canSeeRules, asked, plan: planOff(state) }), ["delivered"]);
      assertEquals(w, { named: [], messages: false, sentence: null }, `${state}, canSeeRules ${canSeeRules}`);
      assertEquals(asked, [], "nothing is read: there is nothing to warn about");
    }
  }
});

Deno.test("a card's rule sentence is unchanged with no plan, a failed map read, report mode, and block mode with Automations on", async () => {
  // Each world as it was before plans, then the same world under every plan that must change nothing.
  const worlds = [{ rules: texts }, { rules: texts, canSeeRules: false }, { status: 500 }, { rules: [] }, { status: 403, error: "The Customer Hub is not part of your subscription." }];
  for (const world of worlds) {
    const before = await ruleWarning(deps(world), ["delivered"]);
    for (const [name, plan] of UNCHANGED) assertEquals(await ruleWarning(deps({ ...world, plan }), ["delivered"]), before, `${name}: ${JSON.stringify(world).slice(0, 60)}`);
  }
  assertEquals((await ruleWarning(deps({ rules: texts }), ["delivered"])).named, ["Thank them"]);
  // No events is still no read of anything, the map included.
  let mapAsked = 0;
  const none = { portal: () => { throw new Error("no read"); }, canRead: () => true, plan: () => { mapAsked++; return Promise.resolve(planOff("hidden")); } } as unknown as Deps;
  assertEquals([(await ruleWarning(none, [])).sentence, mapAsked], [null, 0]);
});

Deno.test("send notes for a company its plan blocks from Automations: none, and the list is not read", async () => {
  for (const what of ["text", "email", "estimate"] as const) {
    for (const state of ["hidden", "locked", "off", null]) {
      for (const canSeeRules of [true, false]) {
        const asked: string[] = [];
        assertEquals(await sendRuleNotes(deps({ ...DOOR_SAYS_NO, canSeeRules, asked, plan: planOff(state) }), what), [], `${what}, ${state}, canSeeRules ${canSeeRules}`);
        assertEquals(asked, []);
      }
    }
  }
});

Deno.test("send notes are unchanged with no plan, a failed map read, report mode, and block mode with Automations on", async () => {
  const worlds = [{ rules: texts }, { rules: texts, canSeeRules: false }, { status: 500 }, { rules: [] }, { status: 403, error: "The Customer Hub is not part of your subscription." }];
  for (const what of ["text", "email", "estimate"] as const) {
    for (const world of worlds) {
      const before = await sendRuleNotes(deps(world), what);
      for (const [name, plan] of UNCHANGED) assertEquals(await sendRuleNotes(deps({ ...world, plan }), what), before, `${what}, ${name}: ${JSON.stringify(world).slice(0, 60)}`);
    }
  }
  assertEquals((await sendRuleNotes(deps({ rules: texts }), "text")).length, 1);
});
