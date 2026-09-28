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
//                      operator's own).
//   * advancedAsked  — has that tenant's answer arrived at all?
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

// advancedEnt … advancedClampOn, whole, ending where the URL clamp begins.
const GATE = between(SHELL, "const advancedEnt =", "const resolvedTab = ssClampTab(", "the Advanced gate in 12-shell.jsx");
for (const name of ["advancedEnt", "advancedOn", "advancedAsked", "advancedClampOn"]) {
  assert(new RegExp(`const ${name} =`).test(GATE), `the lifted gate is missing ${name}`);
}

interface W { viewing?: { clientId: string } | null; viewedCtx?: { entitlement: unknown } | null; entitlement?: unknown; tab?: string }
function gate(w: W) {
  const f = new Function("ssAdvancedOn", "viewing", "viewedCtx", "entitlement", "tab",
    `${GATE}\nreturn { advancedOn, advancedAsked, advancedClampOn };`);
  return f(ssAdvancedOn, w.viewing ?? null, w.viewedCtx ?? null, w.entitlement ?? null, w.tab ?? "designs") as
    { advancedOn: boolean; advancedAsked: boolean; advancedClampOn: boolean };
}
const INTERNAL = { reason: "internal", exempt: true, state: "exempt", granted: ["view_3d"] };
const EXEMPT = { reason: "exempt", exempt: true, state: "exempt", granted: ["view_3d"] };
const VIEW = { clientId: "some-builder" };

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

Deno.test("view-as reads the VIEWED tenant, never the operator's own", () => {
  // An operator whose own account is ours, viewing a builder: off.
  assertEquals(gate({ viewing: VIEW, viewedCtx: { entitlement: EXEMPT }, entitlement: INTERNAL, tab: "advanced" }).advancedOn, false);
  // Viewing ours from any account: on.
  assertEquals(gate({ viewing: VIEW, viewedCtx: { entitlement: INTERNAL }, entitlement: EXEMPT }).advancedOn, true);
  // The viewed context still loading holds the route; an answer with no entitlement is an answer (off).
  assertEquals(gate({ viewing: VIEW, viewedCtx: null, entitlement: INTERNAL, tab: "advanced" }), { advancedOn: false, advancedAsked: false, advancedClampOn: true });
  assertEquals(gate({ viewing: VIEW, viewedCtx: { entitlement: null }, entitlement: INTERNAL, tab: "advanced" }), { advancedOn: false, advancedAsked: true, advancedClampOn: false });
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
  assert(/const resolvedTab = ssClampTab\([^;]*advancedClampOn\);/.test(SHELL), "the URL clamp must pass advancedClampOn");
  assert(/const activeTab = ssClampTab\([^;]*advancedClampOn\);/.test(SHELL), "the render clamp must pass advancedClampOn");
});
