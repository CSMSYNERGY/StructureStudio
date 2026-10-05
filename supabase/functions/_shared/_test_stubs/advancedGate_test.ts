// The Advanced page's gate (2026-09-28), pinned against the SHIPPED portal sources.
//
// Carolyn: "an advanced tab that is only available in Structure Studio for us yet", later a
// per-builder "advanced mode". The rule is ONE function, ssAdvancedOn (01-core.jsx), fed the
// entitlement of the tenant ON SCREEN; the shell derives three values from it above the URL clamp
// (12-shell.jsx) and draws the nav item and mounts the page only on a real yes.
//
// The entitlement arrives AFTER the tenant, and that is the whole difficulty. Refused too early,
// our own account's cold /portal/advanced would be bounced to the Designer for good; allowed too
// early, the item would flash for every builder. So:
//   * advancedOn     — a real yes, from the RIGHT tenant (the viewed one in view-as, never the
//                      operator's own, and never the LAST viewed one's stale answer), for someone
//                      who may run the account (owner/admin, or a platform operator in view-as).
//   * advancedAsked  — has that tenant's answer arrived at all? (Or has the hold run out.)
//   * advancedClampOn — what the route clamps get: yes, or "still asking" while the tab IS advanced.
// Lifted, not copied, so a drift fails the push. Same technique as supportConsoles_test.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");

function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`advancedGate_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}

const CLAMP_BLOCK = between(CORE, "function ssIsBetaHost()", "const ACCENT =", "the clamp block in 01-core.jsx");
const { ssAdvancedOn } = new Function("window", `${CLAMP_BLOCK}; return { ssAdvancedOn };`)(
  { location: { hostname: "app.structurestudiosuite.com" } },
) as { ssAdvancedOn: (e: unknown) => boolean };

// advancedCtx … advancedClampOn, whole, ending where the URL clamp begins.
const GATE = between(SHELL, "const advancedCtx =", "const resolvedTab = ssClampTab(", "the Advanced gate in 12-shell.jsx");
for (const name of ["advancedCtx", "advancedEnt", "advancedMayRun", "advancedOn", "advancedAnswered", "advancedAsked", "advancedClampOn"]) {
  assert(new RegExp(`const ${name} =`).test(GATE), `the lifted gate is missing ${name}`);
}

// The defaults are the case every older test here was written for: an owner on their own portal,
// or a platform operator (isSupportOp false) in view-as, with the hold not yet run out.
interface W {
  viewing?: { clientId: string } | null; viewedCtx?: { entitlement: unknown; clientId?: string } | null; entitlement?: unknown; tab?: string;
  canAdminForUrl?: boolean; isOperator?: boolean; isSupportOp?: boolean | null; advancedHoldOver?: boolean;
}
function gate(w: W) {
  const f = new Function("ssAdvancedOn", "viewing", "viewedCtx", "entitlement", "tab", "canAdminForUrl", "isOperator", "isSupportOp", "advancedHoldOver",
    `${GATE}\nreturn { advancedOn, advancedAsked, advancedClampOn };`);
  return f(ssAdvancedOn, w.viewing ?? null, w.viewedCtx ?? null, w.entitlement ?? null, w.tab ?? "designs",
    w.canAdminForUrl ?? true, w.isOperator ?? !!w.viewing, w.isSupportOp === undefined ? false : w.isSupportOp, w.advancedHoldOver ?? false) as
    { advancedOn: boolean; advancedAsked: boolean; advancedClampOn: boolean };
}
const INTERNAL = { reason: "internal", exempt: true, state: "exempt", granted: ["view_3d"] };
const EXEMPT = { reason: "exempt", exempt: true, state: "exempt", granted: ["view_3d"] };
const VIEW = { clientId: "some-builder" };
// A view-as answer is tagged with the tenant it is for; one tagged with another is not an answer.
const ctx = (entitlement: unknown, clientId = VIEW.clientId) => ({ entitlement, clientId });

Deno.test("our own account: on once the entitlement says internal", () => {
  assertEquals(gate({ entitlement: INTERNAL }), { advancedOn: true, advancedAsked: true, advancedClampOn: true });
});

Deno.test("before the entitlement answers: nothing drawn, but a cold /portal/advanced is HELD, not refused", () => {
  assertEquals(gate({ entitlement: null, tab: "advanced" }), { advancedOn: false, advancedAsked: false, advancedClampOn: true });
  // Only the Advanced route is held: on any other page there is nothing to hold.
  assertEquals(gate({ entitlement: null, tab: "designs" }).advancedClampOn, false);
});

Deno.test("any other builder: off, and refused once answered — exempt included", () => {
  // Exempt is the dangerous one: portal-billing grants it every grantable feature (migration
  // 228), so a gate on `granted` or `features` would have opened Advanced for every exempt tenant.
  for (const e of [EXEMPT, { reason: "never_paid", locked: true }, { reason: "active", granted: ["view_3d"], features: { view_3d: true } }]) {
    assertEquals(gate({ entitlement: e, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false }, JSON.stringify(e));
  }
});

// The builder's own switch (2026-10-05, migration 270): portal-billing sends `advancedMode`.
const SWITCHED_ON = { reason: "active", granted: [], paid: ["simple_layout", "view_3d"], advancedMode: true };
const SWITCHED_OFF = { ...SWITCHED_ON, advancedMode: false };

Deno.test("a builder who turned Advanced mode on: on for an owner or admin, held and then opened on a cold link", () => {
  assertEquals(gate({ entitlement: SWITCHED_ON }), { advancedOn: true, advancedAsked: true, advancedClampOn: true });
  assertEquals(gate({ entitlement: SWITCHED_ON, tab: "advanced" }).advancedClampOn, true);
  // Exempt with the switch on is on too: the switch is the builder's, not a billing state.
  assertEquals(gate({ entitlement: { ...EXEMPT, advancedMode: true } }).advancedOn, true);
});

Deno.test("a builder with the switch off (or a server that predates it): off, and refused once answered", () => {
  for (const e of [SWITCHED_OFF, { reason: "active", granted: [], paid: ["view_3d"] }]) {
    assertEquals(gate({ entitlement: e, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false }, JSON.stringify(e));
  }
});

Deno.test("the switch does not widen WHO gets the page: still owner/admin, or a platform operator in view-as", () => {
  // A team member of a builder who turned it on: off, and a cold link is refused.
  assertEquals(gate({ entitlement: SWITCHED_ON, canAdminForUrl: false, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
  // A platform operator viewing that builder: on. A support operator: off.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON) }).advancedOn, true);
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON), isSupportOp: true }).advancedOn, false);
  // An operator whose OWN account switched it on, viewing a builder who did not: off.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(SWITCHED_OFF), entitlement: SWITCHED_ON }).advancedOn, false);
  // The last builder's "on" is not the next one's.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON, "another-builder") }).advancedOn, false);
});

// The Settings switch is built from the SAME three values (12-shell.jsx advancedSwitch), so the card
// and the menu item cannot disagree about whose answer it is or who may change it.
const SWITCH = between(SHELL, "const advancedSwitch =", "// Accounts and Admin moved INTO this rail", "advancedSwitch in 12-shell.jsx");
function switchFor(w: W & { advancedDirty?: boolean; confirmAnswer?: boolean }) {
  const g = new Function("ssAdvancedOn", "viewing", "viewedCtx", "entitlement", "tab", "canAdminForUrl", "isOperator", "isSupportOp", "advancedHoldOver", "advancedDirtyRef", "navigate", "window",
    `${GATE}\n${SWITCH}\nreturn advancedSwitch;`);
  const nav: string[] = [];
  const asked: string[] = [];
  const s = g(ssAdvancedOn, w.viewing ?? null, w.viewedCtx ?? null, w.entitlement ?? null, w.tab ?? "designs",
    w.canAdminForUrl ?? true, w.isOperator ?? !!w.viewing, w.isSupportOp === undefined ? false : w.isSupportOp, false,
    { current: !!w.advancedDirty }, (p: string) => nav.push(p), { confirm: (m: string) => { asked.push(m); return w.confirmAnswer ?? true; } });
  return { s, nav, asked };
}

Deno.test("advancedSwitch: shown to whoever may run the account, for the tenant on screen, once it has answered", () => {
  assertEquals(switchFor({ entitlement: SWITCHED_ON }).s?.on, true);
  assertEquals(switchFor({ entitlement: SWITCHED_OFF }).s?.on, false);
  assertEquals(switchFor({ entitlement: SWITCHED_OFF }).s?.locked, false);
  // Our own account: on and locked, whatever its column says.
  const ours = switchFor({ entitlement: { ...INTERNAL, advancedMode: false } }).s;
  assertEquals([ours?.on, ours?.locked], [true, true]);
  // Not answered, a server with no field, a team member, a support operator: no card at all.
  assertEquals(switchFor({ entitlement: null }).s, null);
  assertEquals(switchFor({ entitlement: { reason: "active", granted: ["view_3d"] } }).s, null, "a server that predates advancedMode");
  assertEquals(switchFor({ entitlement: SWITCHED_ON, canAdminForUrl: false }).s, null);
  assertEquals(switchFor({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON), isSupportOp: true }).s, null);
  assertEquals(switchFor({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON), isSupportOp: null }).s, null, "still asking whether this operator is support");
  // View-as: the viewed builder's answer, never the operator's own or the last builder's.
  assertEquals(switchFor({ viewing: VIEW, viewedCtx: ctx(SWITCHED_OFF), entitlement: SWITCHED_ON }).s?.on, false);
  assertEquals(switchFor({ viewing: VIEW, viewedCtx: ctx(SWITCHED_ON, "another-builder"), entitlement: SWITCHED_ON }).s, null);
});

Deno.test("advancedSwitch: turning it off asks first only when the Advanced page holds unsaved work", () => {
  const clean = switchFor({ entitlement: SWITCHED_ON });
  assertEquals(clean.s?.confirmOff(), true);
  assertEquals(clean.asked.length, 0, "nothing unsaved: no question");
  const dirtyNo = switchFor({ entitlement: SWITCHED_ON, advancedDirty: true, confirmAnswer: false });
  assertEquals(dirtyNo.s?.confirmOff(), false, "No keeps it on");
  assert(/discard the building you haven't saved on the Advanced page/.test(dirtyNo.asked[0] ?? ""), dirtyNo.asked.join(" | "));
  assertEquals(switchFor({ entitlement: SWITCHED_ON, advancedDirty: true, confirmAnswer: true }).s?.confirmOff(), true);
  const open = switchFor({ entitlement: SWITCHED_ON });
  open.s?.onOpen();
  assertEquals(open.nav, ["advanced"]);
});

Deno.test("view-as reads the VIEWED tenant, never the operator's own", () => {
  // An operator whose own account is ours, viewing a builder: off.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(EXEMPT), entitlement: INTERNAL, tab: "advanced" }).advancedOn, false);
  // Viewing ours from any account: on.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(INTERNAL), entitlement: EXEMPT }).advancedOn, true);
  // The viewed context still loading holds the route; an answer with no entitlement is an answer (off).
  assertEquals(gate({ viewing: VIEW, viewedCtx: null, entitlement: INTERNAL, tab: "advanced" }), { advancedOn: false, advancedAsked: false, advancedClampOn: true });
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(null), entitlement: INTERNAL, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
});

Deno.test("view-as: the LAST viewed tenant's answer is not this one's (review 2026-09-29)", () => {
  // Straight from our account to another builder: viewedCtx still holds OURS until theirs lands.
  // Read as not answered — off, and a held route stays held — never as their "yes".
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(INTERNAL, "our-account"), tab: "advanced" }), { advancedOn: false, advancedAsked: false, advancedClampOn: true });
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(INTERNAL, "our-account") }).advancedOn, false);
  // An untagged answer is nobody's.
  assertEquals(gate({ viewing: VIEW, viewedCtx: { entitlement: INTERNAL } }).advancedOn, false);
});

Deno.test("only someone who may run the account gets it (review 2026-09-29)", () => {
  // A team member of our own account: answered, off, refused — not a page that can only say no.
  assertEquals(gate({ entitlement: INTERNAL, canAdminForUrl: false, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
  // A support operator viewing ours wears the builder's map, not the owner's chair: off.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(INTERNAL), isSupportOp: true, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
  // Whether this operator IS support is still being asked: not a yes yet, and the route is held.
  assertEquals(gate({ viewing: VIEW, viewedCtx: ctx(INTERNAL), isSupportOp: null, tab: "advanced" }), { advancedOn: false, advancedAsked: false, advancedClampOn: true });
});

Deno.test("the hold has a time limit: an answer that never comes ends on the Designer (review 2026-09-29)", () => {
  // Billing failed (entitlement stays null) and the hold ran out: refused like any other "no".
  assertEquals(gate({ entitlement: null, tab: "advanced", advancedHoldOver: true }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
  assertEquals(gate({ viewing: VIEW, viewedCtx: null, tab: "advanced", advancedHoldOver: true }).advancedClampOn, false);
  // …but a real yes still opens it.
  assertEquals(gate({ entitlement: INTERNAL, tab: "advanced", advancedHoldOver: true }).advancedClampOn, true);
});

Deno.test("the hold's timer restarts per hold and lets a late yes win", () => {
  const block = between(SHELL, "// The hold's time limit (see advancedHoldOver).", "const viewingFetch", "the hold timer in 12-shell.jsx");
  assert(/setAdvancedHoldOver\(false\);\s*if \(tab !== "advanced" \|\| advancedAnswered\) return;/.test(block), "each hold must start from not-over, and end on a real answer");
  assert(/\}, \[tab, advancedAnswered\]\);/.test(block), "the timer is keyed on the tab and the real answer, never on the held value");
});

Deno.test("the nav item and the page mount both ask advancedOn, never the held clamp value", () => {
  // advancedClampOn is true while still asking; drawing from it would flash the item for everyone.
  assert(/\{advancedOn && navItem\("advanced", "Advanced"\)\}/.test(SHELL), "the nav item must be gated on advancedOn");
  assert(/\{advancedOpened && advancedOn && !gateLocked && \(/.test(SHELL), "the page mount must be gated on advancedOn");
  // …and the item sits directly under Designer.
  assert(/\{navItem\("designer", "Designer"\)\}\s*(\{\/\*[\s\S]*?\*\/\}\s*)?\{advancedOn && navItem\("advanced", "Advanced"\)\}/.test(SHELL),
    "the Advanced item must come straight after Designer");
});

Deno.test("both route clamps are handed the gate", () => {
  assert(/const resolvedTab = ssClampTab\([^;]*advancedClampOn, sub\);/.test(SHELL), "the URL clamp must pass advancedClampOn");
  assert(/const activeTab = ssClampTab\([^;]*advancedClampOn, sub\);/.test(SHELL), "the render clamp must pass advancedClampOn");
});
