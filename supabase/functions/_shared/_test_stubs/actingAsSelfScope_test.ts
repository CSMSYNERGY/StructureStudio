// Acting as a person makes every "my ..." read follow THEM — pinned against the shipped sources.
//
// Carolyn, 2026-10-23: "I need you to double check that the settings that we see are exactly how
// they see them. for instance I logged in as brent and went to meetings and I see the meetings for
// Carolyn."
//
// She was right, and the cause was one field answering two different questions. `ctx.userId` had
// always meant "the signed-in human" — correct for attribution (created_by, cancelled_by, the
// activity log) and correct for everything while nobody could be worn. The day acting-as shipped,
// every self-scoped read keyed on it started answering about the OPERATOR instead of the person
// whose screen it was: their booking calendar, their profile, their inbox, their own-customers row
// scope. `ctx.selfUserId` is the second question, and these tests are what keep the two apart.
//
// Why source-text pinning rather than behaviour: the failure is SILENT. Nothing throws, no status
// changes, the screen renders a complete and plausible answer about the wrong person — which is
// precisely why it shipped. Reverting one identifier is a one-character edit, so the guard has to
// live at the identifier. Same technique as operatorMirror_test / tabClamp_test.

import { assert } from "jsr:@std/assert";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));

const RESOLVE = await read("../resolveTenant.ts");
const MEETINGS = await read("../../portal-meetings/index.ts");
const SETTINGS = await read("../../portal-settings/index.ts");
const SCHEDULE = await read("../../portal-schedule/index.ts");
const CORE = await read("../../../../portal/01-core.jsx");

/** Source with comment lines stripped, so a comment NAMING the old shape cannot pass or fail a
 *  test the way the code would. Every assertion below runs against this. */
function code(src: string): string {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

const RESOLVE_C = code(RESOLVE);
const MEETINGS_C = code(MEETINGS);
const SETTINGS_C = code(SETTINGS);
const SCHEDULE_C = code(SCHEDULE);
const CORE_C = code(CORE);

Deno.test("resolveTenant answers both questions, and the operator path separates them", () => {
  assert(/selfUserId:\s*string;/.test(RESOLVE_C), "OperatorCtx lost its selfUserId field");
  // The normal path: nobody is worn, so the two answers are the same person.
  assert(RESOLVE_C.includes("selfUserId: user.id,"), "the non-operator path must set selfUserId to the caller");
  // The operator path: this is the whole point of the split.
  assert(
    RESOLVE_C.includes("selfUserId: asUserId ?? user.id,"),
    "the operator path must follow the acted-as person for selfUserId",
  );
  // And attribution must NOT follow them: the operator did the thing.
  assert(
    !/userId:\s*asUserId/.test(RESOLVE_C),
    "userId has started following the acted-as person — actions would be attributed to someone who did not take them",
  );
});

Deno.test("portal-meetings resolves MY host row by selfUserId", () => {
  // The exact line Carolyn's bug was on.
  assert(
    /from\("meeting_hosts"\)[\s\S]{0,160}?\.eq\("user_id", selfUserId\)/.test(MEETINGS_C),
    'the "my host row" read must key on selfUserId — on userId it shows the operator their own calendar',
  );
  assert(
    !/from\("meeting_hosts"\)[\s\S]{0,160}?\.eq\("user_id", userId\)/.test(MEETINGS_C),
    "the my-host-row read is back on userId",
  );
  // The own-calendar write scope, same question.
  assert(
    MEETINGS_C.includes("p.userId : selfUserId") && MEETINGS_C.includes("forUserId !== selfUserId"),
    "save_host's own-calendar scope must key on selfUserId",
  );
});

Deno.test("portal-meetings still attributes bookings and cancellations to the operator", () => {
  assert(MEETINGS_C.includes("p_created_by: userId"), "a booking must be attributed to whoever really made it");
  assert(MEETINGS_C.includes("cancelled_by: userId"), "a cancellation must be attributed to whoever really made it");
});

Deno.test("a self-scoped WRITE is refused while wearing somebody, not silently redirected", () => {
  // Reading as them is the feature. Rewriting their own record under their name is not, and the
  // audit trail would read as the operator having done it to themselves.
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["portal-meetings", MEETINGS_C],
    ["portal-settings", SETTINGS_C],
  ];
  for (const [label, src] of pairs) {
    assert(
      src.includes('code: "acting_as_read_only"'),
      `${label} must refuse a self-scoped write while acting as somebody`,
    );
  }
});

Deno.test("the own-customers row scope is measured against the acted-as person", () => {
  // contacts:'own' is what makes a dealer see their own customers. Measured against the wrong
  // person the narrowing is still real — which is worse than no narrowing, because it looks right.
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["portal-settings", SETTINGS_C],
    ["portal-schedule", SCHEDULE_C],
  ];
  for (const [label, src] of pairs) {
    assert(
      /crm_visible_contact_ids"[\s\S]{0,200}?p_user_id:\s*selfUserId/.test(src),
      `${label}'s crm_visible_contact_ids must pass selfUserId`,
    );
    assert(
      !/crm_visible_contact_ids"[\s\S]{0,200}?p_user_id:\s*userId\b/.test(src),
      `${label}'s crm_visible_contact_ids is back on userId`,
    );
  }
});

Deno.test("portal-settings answers every me about the person whose screen it is", () => {
  // My profile.
  assert(
    /from\("client_users"\)\.select\("full_name, phone, role, prefs"\)\.eq\("user_id", selfUserId\)/.test(SETTINGS_C),
    "get_profile must read the acted-as person's row",
  );
  // The record timeline's call scope, the inbox, the phone status slice, and the roster's
  // "which row is me".
  const needles = [
    'userId: isUuid(String(selfUserId ?? "")) ? String(selfUserId).toLowerCase() : null,',
    'const me = isUuid(String(selfUserId ?? "")) ? String(selfUserId).toLowerCase() : null;',
    "callerNumberFor(rows, selfUserId,",
    "me: selfUserId ?? null,",
  ];
  for (const needle of needles) {
    assert(SETTINGS_C.includes(needle), `a self-scoped read lost selfUserId: ${needle}`);
  }
  // Three `const me = String(selfUserId...)` sites: crm_create_lead, crm_create_contact, the
  // Calls report's MY default.
  const mes = SETTINGS_C.match(/const me = String\(selfUserId \?\? ""\)\.toLowerCase\(\);/g) ?? [];
  assert(mes.length === 3, `expected 3 selfUserId "me" locals in portal-settings, found ${mes.length}`);
  assert(
    !/const me = String\(userId \?\? ""\)\.toLowerCase\(\);/.test(SETTINGS_C),
    "a me local is back on userId",
  );
});

Deno.test("portal preferences deliberately stay the OPERATOR's own", () => {
  // The one place userId is the right answer: which tab opens first is the operator's habit, not
  // the other person's access. Inheriting it would reset their remembered view on every look-in.
  // Read and write must agree, or a save would file the operator's choice under someone else.
  assert(
    /from\("client_users"\)\.select\("prefs"\)\.eq\("user_id", userId\)/.test(SETTINGS_C),
    "the prefs read must stay on userId (see its comment) — and match the write below it",
  );
  assert(
    /\.update\(\{ prefs:[^}]*\}\)\s*\n?\s*\.eq\("user_id", userId\)/.test(SETTINGS_C),
    "the prefs write must stay on userId, matching the read",
  );
});

Deno.test("the acted-as id reaches the server through BOTH injection doors", () => {
  // Door 1: the body carries no targetClientId and the shell injects both together.
  assert(
    CORE_C.includes("...(ssTargetUserId ? { targetUserId: ssTargetUserId } : {}),"),
    "the shell no longer pairs targetUserId with the injected targetClientId",
  );
  // Door 2: the caller scoped itself (03-catalog's `scoped()`), so door 1 stands down. Without
  // this, those calls arrive view-as'd with no person named and selfUserId falls back to the
  // operator — Carolyn's bug, reappearing on whichever screens scope themselves by hand.
  assert(
    CORE_C.includes("opts.body.targetClientId === ssTargetClientId") &&
      CORE_C.includes("opts.body.targetUserId === undefined") &&
      CORE_C.includes("body: { ...opts.body, targetUserId: ssTargetUserId }"),
    "the second injection door is gone: hand-scoped calls would lose the acted-as person",
  );
  // Pairing rule: a person is meaningless without the account they are on.
  assert(
    CORE_C.includes("ssTargetUserId && ssTargetClientId"),
    "door 2 must require an armed tenant, not send a person on their own",
  );
});
