// The portal's tab clamp, tested against the SHIPPED portal source.
//
// `ssClampTab` decides which routes resolve for whom. It is a courtesy layer — every edge
// function re-checks — but it is the layer that decides whether a SUPPORT operator (migration
// 176) can reach the two consoles that are ours and not the builder's: /portal/admin, where
// `delete_client` lives, and /portal/projects, our internal bug board carrying every client's
// reports. Getting that wrong does not throw; it silently offers a support account a page it
// should never see, and typing the URL is all it takes.
//
// Lifted from the source rather than copied, so a drift fails the push. Same technique as
// wallSlab_test / resolveTenant_test.

import { assert, assertEquals } from "jsr:@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../../../portal/01-core.jsx", import.meta.url),
);

const START = "function ssIsBetaHost()";
const END = "const ACCENT =";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END, i);
if (i < 0 || j < 0) {
  throw new Error(
    "tabClamp_test: could not find the clamp block in portal/01-core.jsx " +
      `(start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`,
  );
}
const BLOCK = SRC.slice(i, j);

for (const name of ["ssClampTab", "ssCanSeeTab", "ssFallbackTab", "supportView"]) {
  assert(BLOCK.includes(name), `extracted block is missing ${name}`);
}

type Access = Record<string, string>;
type Clamp = (tab: string, isOperator: boolean, canAdmin: boolean, access: Access | null, supportView?: boolean) => string;

// `window` is injected because ssIsBetaHost reads `window.location.hostname`. Pinned to a
// NON-beta host so the coming-soon routes behave as they do in production — that branch runs
// before every role check, and a beta-host default would quietly skip it. (Deno 2 has no
// `window` global, so the parameter is also what keeps the slice runnable at all.)
const factory = new Function("window", `${BLOCK}; return { ssClampTab, ssFallbackTab };`);
const { ssClampTab, ssFallbackTab } = factory(
  { location: { hostname: "app.structurestudiosuite.com" } },
) as { ssClampTab: Clamp; ssFallbackTab: (a: Access | null) => string };

// An owner's resolved map: edit everywhere. The support operator wears exactly this, which is
// what makes "and yet admin/projects are still refused" a real assertion rather than a
// side effect of a narrow map.
const OWNER_MAP: Access = {
  designer: "edit", designs: "edit", contacts: "edit", inventory: "edit", orders: "edit",
  build_schedule: "edit", delivery_schedule: "edit", repairs: "edit", commissions: "edit",
  reports: "edit", settings_structures: "edit", settings_options: "edit",
  settings_branding: "edit", settings_crm: "edit", settings_quickbooks: "edit",
  settings_email: "edit", settings_team: "edit",
  // Forced off for support by resolveTenant — see migration 176.
  settings_billing: "none",
};

Deno.test("a platform operator keeps both consoles", () => {
  for (const tab of ["accounts", "admin", "projects"]) {
    assertEquals(ssClampTab(tab, true, true, OWNER_MAP, false), tab);
  }
});

Deno.test("a SUPPORT operator keeps Accounts but loses Admin and Projects", () => {
  // Accounts is the switcher — without it support cannot reach the next builder at all.
  assertEquals(ssClampTab("accounts", true, false, OWNER_MAP, true), "accounts");
  for (const tab of ["admin", "projects"]) {
    const got = ssClampTab(tab, true, false, OWNER_MAP, true);
    assert(got !== tab, `${tab} must not resolve for a support operator, got "${got}"`);
    assertEquals(got, ssFallbackTab(OWNER_MAP));
  }
});

Deno.test("support still reaches every tab the owner's map allows", () => {
  // The narrowing is about OUR consoles, not about the builder's own product. A support
  // operator who could not open Designs or Orders could not answer a support call.
  for (const tab of ["designs", "orders", "inventory", "build-schedule", "settings"]) {
    assertEquals(ssClampTab(tab, true, false, OWNER_MAP, true), tab);
  }
});

Deno.test("a non-operator never reaches the operator routes, support flag or not", () => {
  for (const supportView of [false, true]) {
    for (const tab of ["accounts", "admin", "projects"]) {
      assert(ssClampTab(tab, false, false, OWNER_MAP, supportView) !== tab);
    }
  }
});

Deno.test("supportView defaults to FALSE so every existing caller is unchanged", () => {
  // The 4-argument call shape still exists in the codebase; a default of true would have
  // silently taken the consoles away from every operator.
  assertEquals((ssClampTab as (t: string, o: boolean, c: boolean, a: Access) => string)("admin", true, true, OWNER_MAP), "admin");
  assertEquals((ssClampTab as (t: string, o: boolean, c: boolean, a: Access) => string)("projects", true, true, OWNER_MAP), "projects");
});

Deno.test("canAdmin still unclamps everything, which is why support must not hold it", () => {
  // This is the coupling that makes canAdmin load-bearing: with it true, the access map is
  // not consulted at all. resolveTenant narrows the map; 12-shell must also deny canAdmin,
  // or the narrowing governs nothing in the browser.
  const noAccess: Access = {};
  assertEquals(ssClampTab("orders", false, true, noAccess), "orders");
  assert(ssClampTab("orders", false, false, noAccess) !== "orders");
});

Deno.test("coming-soon routes are refused on a production host before any role check", () => {
  // Checked first on purpose — an operator bookmark to /portal/reports must land on a real
  // page rather than an unreleased teaser.
  for (const tab of ["reports", "rent-to-own-contracts"]) {
    assert(ssClampTab(tab, true, true, OWNER_MAP, false) !== tab);
  }
});
