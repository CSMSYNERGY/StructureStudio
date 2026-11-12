// PLANS AS DATA IN THE PORTAL (migrations 386 and 387), tested against the SHIPPED portal source.
//
// portal-billing sends entitlement.modules, { tab: on | locked | hidden | off }, and only for a
// company whose rollout switch is on. 01-core.jsx's helpers read it, and the shell asks them in the
// rail, the two route clamps, the Settings lists and the paid add-ons.
//
// WHAT THIS FILE HOLDS
//   1. OFF THE MAP, NOTHING MOVES. With `mods` null every helper hands back the answer it was given,
//      and ssClampTab is ssClampTabBase, argument for argument. That is what makes it safe to ship
//      the code before any company is switched on (and to promote it to production).
//   2. PARITY ON THE MAP. For each kind of company that exists today, the page guard run with the
//      map the resolver gives it lands where the old rules land, except for the differences listed
//      by name below. A difference that is not on that list fails.
//   3. WHAT THE MAP ADDS: any single tab on or off, a padlock only where a page has a card of its
//      own, and a landing page that is always one the company is offered.
//   4. The portal's tab keys are catalogue keys (_shared/accessModules.ts), so a plan can name
//      every tab the portal asks about.
//
// Lifted from the source rather than copied, like tabClamp_test: a drift fails the push.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACCESS_MODULES, ACCESS_MODULE_KEYS } from "../accessModules.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const CORE = await read("../../../../portal/01-core.jsx");
const SHELL = await read("../../../../portal/12-shell.jsx");
const SETTINGS = await read("../../../../portal/08-integrations.jsx");

const i0 = CORE.indexOf("function ssIsBetaHost()");
const j0 = CORE.indexOf("const ACCENT =", i0);
if (i0 < 0 || j0 < 0) throw new Error("accessShell_test: could not find the clamp block in portal/01-core.jsx. The anchors moved: re-point them.");
const BLOCK = CORE.slice(i0, j0);

type Access = Record<string, string>;
type Mods = Record<string, string> | null;
type Clamp = (tab: string, isOperator: boolean, canAdmin: boolean, access: Access | null, supportView?: boolean, canProjects?: boolean,
  advancedOn?: boolean, sub?: string | null, shedsOn?: boolean, jackOn?: boolean, phoneOnly?: boolean, mods?: Mods) => string;
const lifted = new Function("window", `${BLOCK}; return { ssClampTab, ssClampTabBase, ssModules, ssModuleOn, ssModuleOffered, ssTabOffered,
  ssModulesFallback, SS_TAB_MODULE, SS_SETTINGS_MODULE, SS_TEASER_MODULES, SS_SHED_MODULES, SS_FEATURE_MODULE, SS_SHED_TABS, SS_PHONE_ONLY_TABS };`)(
  { location: { hostname: "app.structurestudiosuite.com" } },
) as {
  ssClampTab: Clamp; ssClampTabBase: Clamp;
  ssModules: (e: unknown) => Mods; ssModuleOn: (m: Mods, k: string, legacy: boolean) => boolean;
  ssModuleOffered: (m: Mods, k: string, legacy: boolean) => boolean; ssTabOffered: (m: Mods, tab: string, legacy: boolean) => boolean;
  ssModulesFallback: (m: Mods, access: Access | null, canAdmin: boolean) => string;
  SS_TAB_MODULE: Record<string, string>; SS_SETTINGS_MODULE: Record<string, string>; SS_TEASER_MODULES: string[];
  SS_SHED_MODULES: string[]; SS_FEATURE_MODULE: Record<string, string>; SS_SHED_TABS: string[]; SS_PHONE_ONLY_TABS: string[];
};
const { ssClampTab, ssClampTabBase, ssModules, ssModuleOn, ssModuleOffered, ssTabOffered, ssModulesFallback,
  SS_TAB_MODULE, SS_SETTINGS_MODULE, SS_TEASER_MODULES, SS_SHED_MODULES, SS_FEATURE_MODULE } = lifted;

// Every catalogue tab hidden, then the given states: the shape of the resolver's answer.
const map = (states: Record<string, string>): Record<string, string> =>
  ({ ...Object.fromEntries(ACCESS_MODULE_KEYS.map((k) => [k, "hidden"])), ...states });
const on = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, "on"]));
const locked = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, "locked"]));
const off = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, "off"]));

const BASE = ["designer", "inventory", "orders", "commissions", "ghl", "customer_login"];
const HUB = ["contacts", "pipelines", "conversations", "sms", "email", "meetings", "automations", "forms"];
const SCHED = ["build_schedule", "delivery_schedule", "repairs"];
const SHED_KEYS = ACCESS_MODULES.filter((m) => m.shed).map((m) => m.key);
const TEASED = ["contacts", "build_schedule", "delivery_schedule", "repairs", "view_3d", "quickbooks", "rtp"];

const ROUTES = ["jack", "designer", "advanced", "view-3d", "contacts", "conversations", "inventory", "orders", "build-schedule",
  "delivery-schedule", "repairs", "commissions", "calls", "quickbooks", "settings", "support", "accounts", "admin", "workbench",
  "reports", "projects", "rent-to-own-contracts", "self-serve-display-units", "on-demand-pricing", "nonsense"];

// ── 1. off the map, nothing moves ───────────────────────────────────────────────────────────
Deno.test("no map: every helper hands back the answer it was given", () => {
  for (const legacy of [true, false]) {
    assertEquals(ssModuleOn(null, "contacts", legacy), legacy);
    assertEquals(ssModuleOffered(null, "contacts", legacy), legacy);
    assertEquals(ssTabOffered(null, "contacts", legacy), legacy);
    assertEquals(ssTabOffered(null, "settings", legacy), legacy);
  }
});

Deno.test("ssModules: only a real object is a map; anything else is no map", () => {
  assertEquals(ssModules({ modules: { contacts: "on" } }), { contacts: "on" });
  for (const e of [null, undefined, {}, { modules: null }, { modules: "on" }, { modules: [] }, { modules: 0 }, { modules: false }]) {
    assertEquals(ssModules(e), null, JSON.stringify(e));
  }
});

Deno.test("no map: the page guard IS the old guard, for every route, shape and kind of person", () => {
  const people: [string, boolean, boolean, Access | null][] = [
    ["owner", false, true, null], ["operator", true, true, null],
    ["rep with contacts", false, false, { contacts: "own", phone: "own" }], ["driver", false, false, { delivery_schedule: "view" }],
    ["nothing at all", false, false, {}],
  ];
  let n = 0;
  for (const tab of ROUTES) for (const [who, isOp, canAdmin, access] of people) {
    for (const shedsOn of [true, false]) for (const phoneOnly of [true, false]) for (const jackOn of [true, false]) for (const advancedOn of [true, false]) {
      const a = ssClampTab(tab, isOp, canAdmin, access, false, isOp, advancedOn, null, shedsOn, jackOn, phoneOnly);
      const b = ssClampTabBase(tab, isOp, canAdmin, access, false, isOp, advancedOn, null, shedsOn, jackOn, phoneOnly);
      const c = ssClampTab(tab, isOp, canAdmin, access, false, isOp, advancedOn, null, shedsOn, jackOn, phoneOnly, null);
      assertEquals([a, c], [b, b], `${tab} for ${who} (sheds ${shedsOn}, phoneOnly ${phoneOnly}, jack ${jackOn}, advanced ${advancedOn})`);
      n++;
    }
  }
  assert(n >= 2000, `only ${n} cases ran`);
});

// ── 2. parity for the kinds of company that exist today ─────────────────────────────────────
// Each: the shape flags the old rules read, and the map the resolver gives the same company
// (tests/sql/migration386.test.cjs holds the resolver to these answers).
const COMPANIES: Record<string, { shedsOn: boolean; phoneOnly: boolean; jackOn: boolean; advancedOn: boolean; mods: Record<string, string> }> = {
  "a shed builder on the base plan": { shedsOn: true, phoneOnly: false, jackOn: false, advancedOn: false,
    mods: map({ ...on(...BASE), ...locked(...TEASED) }) },
  "a shed builder with the Customer Hub and scheduling": { shedsOn: true, phoneOnly: false, jackOn: false, advancedOn: false,
    mods: map({ ...on(...BASE, ...HUB, ...SCHED, "view_3d"), ...locked("quickbooks", "rtp") }) },
  "a builder on the Suite": { shedsOn: true, phoneOnly: false, jackOn: false, advancedOn: false,
    mods: map(on(...BASE, ...HUB, ...SCHED, "view_3d", "quickbooks", "rtp")) },
  "a builder who sells no sheds, with the Customer Hub": { shedsOn: false, phoneOnly: false, jackOn: false, advancedOn: false,
    mods: map({ ...on("commissions", ...HUB, "smartbuild_sync"), ...locked("quickbooks"), ...off(...SHED_KEYS) }) },
  "a phone-only account": { shedsOn: false, phoneOnly: true, jackOn: false, advancedOn: false,
    mods: map(on("contacts", "phone", "sms")) },
  "our own account": { shedsOn: true, phoneOnly: false, jackOn: true, advancedOn: true,
    mods: map(on(...BASE, ...HUB, ...SCHED, "view_3d", "quickbooks", "rtp", "phone", "jack", "advanced", "payments", "tax", "support_ai", "library", "door_looks", "projects", "smartbuild_sync", "self_serve_displays")) },
  "a Non-billable demo with the phone on": { shedsOn: true, phoneOnly: false, jackOn: false, advancedOn: false,
    mods: map(on(...BASE, ...HUB, ...SCHED, "view_3d", "quickbooks", "rtp", "phone", "projects", "smartbuild_sync", "self_serve_displays")) },
};

// THE DIFFERENCES WE CHOSE. Off the map, four routes resolve for a company that has not got the
// page (each then shows a card, a "Checking…" or a list of zeros), or bounce to the Designer. On the
// map a page the company is not offered lands on the first page it IS offered. Nothing else differs.
//   conversations   was: resolves, and the page shows the Customer Hub card.
//   calls           was: resolves for anyone with phone access ("for old links"), a list of zeros.
//   jack, advanced  was: bounced to the Designer. A phone-only or no-sheds company kept the Designer
//                   answer only by accident of the shape rule running first; now it is the first
//                   offered page for everyone.
const CHOSEN = new Set(["conversations", "calls", "jack", "advanced"]);

Deno.test("PARITY: on the map, every company that exists today lands where it landed, bar the chosen differences", () => {
  const owner: [boolean, boolean, Access | null] = [false, true, null];
  const rep: [boolean, boolean, Access | null] = [false, false, { contacts: "own", designer: "view", designs: "own", orders: "view", phone: "own" }];
  for (const [name, c] of Object.entries(COMPANIES)) {
    for (const [isOp, canAdmin, access] of [owner, rep]) {
      for (const tab of ROUTES) {
        const before = ssClampTab(tab, isOp, canAdmin, access, false, isOp, c.advancedOn, null, c.shedsOn, c.jackOn, c.phoneOnly, null);
        const after = ssClampTab(tab, isOp, canAdmin, access, false, isOp, c.advancedOn, null, c.shedsOn, c.jackOn, c.phoneOnly, c.mods);
        if (before === after) continue;
        assert(CHOSEN.has(tab), `${name}, ${canAdmin ? "owner" : "rep"}: /${tab} landed on "${before}" and now lands on "${after}"`);
        // …and a chosen difference only ever happens for a page the map does not offer.
        assert(!ssTabOffered(c.mods, tab, true), `${name}: /${tab} is offered by the map and still moved`);
      }
    }
  }
});

Deno.test("PARITY: the rail's shed pages and the Calls item follow the map exactly as they followed the shapes", () => {
  for (const [name, c] of Object.entries(COMPANIES)) {
    // shedsOn on the map = offered at least one shed page (12-shell.jsx).
    const shedsOnMap = SS_SHED_MODULES.some((m) => ssModuleOffered(c.mods, m, false));
    assertEquals(shedsOnMap, c.shedsOn, `${name}: "sells sheds"`);
    // The six shed rail items, drawn when shedsOn and not hidden by the map.
    for (const tab of ["designer", "inventory", "orders", "build-schedule", "delivery-schedule", "repairs"]) {
      assertEquals(shedsOnMap && ssTabOffered(c.mods, tab, true), c.shedsOn, `${name}: the ${tab} rail item`);
    }
    // Customer Hub is always drawn off the map, and Commissions for everyone but phone-only.
    assertEquals(ssTabOffered(c.mods, "contacts", true), true, `${name}: the Customer Hub item`);
    assertEquals(!c.phoneOnly && ssTabOffered(c.mods, "commissions", true), !c.phoneOnly, `${name}: the Commissions item`);
  }
});

// ── 3. what the map adds ────────────────────────────────────────────────────────────────────
Deno.test("a padlock is offered only where the page has a card of its own; elsewhere locked is hidden", () => {
  const m = map({ ...locked("contacts", "build_schedule", "view_3d", "quickbooks", "designer", "inventory", "commissions", "phone", "jack", "conversations") });
  for (const k of ["contacts", "build_schedule", "view_3d", "quickbooks"]) assertEquals(ssModuleOffered(m, k, false), true, k);
  for (const k of ["designer", "inventory", "commissions", "phone", "jack", "conversations"]) assertEquals(ssModuleOffered(m, k, true), false, k);
  // Locked is never ON: the page shows its card, it does not open.
  for (const k of ["contacts", "designer"]) assertEquals(ssModuleOn(m, k, true), false, k);
  // …and a typed address to a locked page with no card lands elsewhere.
  assertEquals(ssClampTab("designer", false, true, null, false, false, false, null, true, false, false, m), "contacts");
});

Deno.test("a custom plan: exactly its pages resolve, for an owner too, and the rest land on one it has", () => {
  const m = map(on("contacts", "pipelines", "phone"));
  const go = (tab: string) => ssClampTab(tab, false, true, null, false, false, false, null, true, false, false, m);
  assertEquals(["contacts", "calls", "settings", "support"].map(go), ["contacts", "calls", "settings", "support"]);
  for (const t of ["designer", "inventory", "orders", "build-schedule", "repairs", "commissions", "conversations", "quickbooks", "view-3d", "jack", "advanced"]) {
    assertEquals(go(t), "contacts", t);
  }
});

Deno.test("an exception: one shed page switched on for a company that sells no sheds resolves; its neighbours do not", () => {
  const m = map({ ...on("contacts", "commissions", "designer"), ...off(...SHED_KEYS.filter((k) => k !== "designer")) });
  const go = (tab: string) => ssClampTab(tab, false, true, null, false, false, false, null, /* shedsOn by the map */ true, false, false, m);
  assertEquals(go("designer"), "designer");
  assertEquals(go("inventory"), "contacts");
  assertEquals(go("build-schedule"), "contacts");
});

Deno.test("the landing page is always one the company is offered AND the person may open", () => {
  // No Customer Hub: an owner lands on the Designer, never on a hub the plan does not have.
  const shedsOnly = map(on("designer", "inventory", "orders"));
  assertEquals(ssClampTab("contacts", false, true, null, false, false, false, null, true, false, false, shedsOnly), "designer");
  assertEquals(ssModulesFallback(shedsOnly, null, true), "designer");
  // A rep who may only see Orders lands on Orders.
  assertEquals(ssModulesFallback(shedsOnly, { orders: "view" }, false), "orders");
  // The base rules' own fallback is checked too: a team member asking for the operator consoles is
  // sent to ssFallbackTab's page, and if the map bars that one they get the map's landing page.
  assertEquals(ssClampTab("accounts", false, false, { orders: "view" }, false, false, false, null, true, false, false, shedsOnly), "orders");
  assertEquals(ssClampTab("admin", false, false, { contacts: "edit", orders: "view" }, false, false, false, null, true, false, false, shedsOnly), "orders");
  // A company offered nothing lands on Support, which is never refused.
  assertEquals(ssClampTab("designer", false, true, null, false, false, false, null, true, false, false, map({})), "support");
  // Phone only by plan: a rep with the phone and no contacts lands on Calls.
  assertEquals(ssModulesFallback(map(on("contacts", "phone")), { phone: "own" }, false), "calls");
});

Deno.test("the map never opens a console or a page the person's own access bars", () => {
  const m = map(on(...BASE, ...HUB));
  assertEquals(ssClampTab("admin", false, true, null, false, false, false, null, true, false, false, m), "contacts");
  assertEquals(ssClampTab("accounts", false, true, null, false, false, false, null, true, false, false, m), "contacts");
  assertEquals(ssClampTab("orders", false, false, { contacts: "own" }, false, false, false, null, true, false, false, m), "contacts");
  // …and it does not take the consoles away from an operator viewing a company on a small plan.
  const small = map(on("contacts", "phone"));
  assertEquals(ssClampTab("accounts", true, true, null, false, true, false, null, true, false, false, small), "accounts");
  assertEquals(ssClampTab("admin", true, true, null, false, true, false, null, true, false, false, small), "admin");
  assertEquals(ssClampTab("settings", false, false, { phone: "own" }, false, false, false, "myprofile", true, false, false, small), "settings");
});

Deno.test("Jack and Advanced keep their own switch: the map can take them away, never hand them out", () => {
  const m = map(on(...BASE, "jack", "advanced"));
  // On in the map, but the company's own switch (jackOn / advancedOn, passed by the shell) is off: not opened.
  assertEquals(ssClampTab("jack", false, true, null, false, false, false, null, true, false, false, m), "designer");
  assertEquals(ssClampTab("advanced", false, true, null, false, false, false, null, true, true, false, m), "designer");
  // Switch on and map on: opened. Switch on and map off: gone.
  assertEquals(ssClampTab("jack", false, true, null, false, false, false, null, true, true, false, m), "jack");
  const without = map({ ...on(...BASE), ...off("jack") });
  assertEquals(ssClampTab("jack", false, true, null, false, false, false, null, true, true, false, without), "designer");
  assertEquals(ssTabOffered(without, "jack", true), false);
});

// ── 4. the portal's keys are the catalogue's ────────────────────────────────────────────────
Deno.test("every tab key the portal asks about is in the catalogue", () => {
  const known = new Set(ACCESS_MODULE_KEYS);
  for (const [tab, k] of Object.entries(SS_TAB_MODULE)) assert(known.has(k), `SS_TAB_MODULE.${tab} = "${k}" is not a catalogue tab`);
  for (const [tab, k] of Object.entries(SS_SETTINGS_MODULE)) assert(known.has(k), `SS_SETTINGS_MODULE.${tab} = "${k}" is not a catalogue tab`);
  for (const [f, k] of Object.entries(SS_FEATURE_MODULE)) assert(known.has(k), `SS_FEATURE_MODULE.${f} = "${k}" is not a catalogue tab`);
  for (const k of [...SS_TEASER_MODULES, ...SS_SHED_MODULES]) assert(known.has(k), `"${k}" is not a catalogue tab`);
  // The shed pages are shed tabs in the catalogue too, so "sells no sheds" means the same thing in both places.
  const shed = new Set(SHED_KEYS);
  for (const k of SS_SHED_MODULES) assert(shed.has(k), `"${k}" is a shed page in the portal but not a shed tab in the catalogue`);
  // The Coming Soon pages are deliberately not mapped: they are teasers, shown by host alone.
  for (const t of ["reports", "projects", "rent-to-own-contracts", "self-serve-display-units"]) assertEquals(SS_TAB_MODULE[t], undefined, t);
  // The pages no plan may take away have no key either.
  for (const t of ["settings", "support", "accounts", "admin", "workbench"]) assertEquals(SS_TAB_MODULE[t], undefined, t);
  for (const t of ["billing", "company", "pipelines", "myprofile"]) assertEquals(SS_SETTINGS_MODULE[t], undefined, t);
});

// ── the shell and Settings ask the helpers, read from the shipped source ────────────────────
Deno.test("the shell reads the map off the entitlement on screen, and asks it in the rail, the clamps and the add-ons", () => {
  assert(SHELL.includes("const mods = ssModules(advancedEnt);"), "the shell no longer reads the map off the entitlement the shapes read");
  assert(/const shedsOn = mods\n\s*\? SS_SHED_MODULES\.some\(\(m\) => ssModuleOffered\(mods, m, false\)\)\n\s*: ssShedsOn\(advancedEnt\);/.test(SHELL), "shedsOn lost its map rule or its old rule");
  assert(/const navHidden = \(id\) => !ssTabOffered\(mods, id, true\)\n\s*\|\| \(id !== "accounts" && id !== "admin" && id !== "workbench" && !canAdmin && !ssCanSeeTab\(id, myAccess\)\);/.test(SHELL),
    "navHidden no longer asks the map, or lost the person rule");
  assert(/const resolvedTab = ssClampTab\([^;]*phoneOnly, mods\);/.test(SHELL), "the URL clamp is not handed the map");
  assert(/const activeTab = ssClampTab\([^;]*phoneOnly, mods\);/.test(SHELL), "the render clamp is not handed the map");
  assertEquals(SHELL.split('phoneOnly, mods) === "orders"').length - 1, 2, "the two order-opening clamps are not handed the map");
  assert(SHELL.includes("const featureOn = (key) => ((mods && SS_FEATURE_MODULE[key])\n    ? ssModuleOn(mods, SS_FEATURE_MODULE[key], false)"), "featureOn no longer asks the map first");
  assert(SHELL.includes('const schedOnFor = (moduleKey) => ssModuleOn(mods, moduleKey, featureOn("schedule_builds"));'), "the scheduling pages lost their per-page rule");
  for (const [tab, key] of [["build-schedule", "build_schedule"], ["delivery-schedule", "delivery_schedule"], ["repairs", "repairs"]]) {
    assert(SHELL.includes(`{!gateLocked && activeTab === "${tab}" && (\n              schedOnFor("${key}") ? (`), `the ${tab} page no longer asks for its own tab`);
  }
  assert(SHELL.includes('const contactsUnlocked = ssModuleOn(mods, "contacts", crmUnlocked || phoneOnly);'), "the contact list lost its rule");
  assert(SHELL.includes('const phoneOffered = ssModuleOffered(mods, "phone", ssPhoneOffered(effPhoneStatus, !!viewing));'), "the phone lost its rule");
  assert(SHELL.includes('const advancedOn = ssAdvancedOn(advancedEnt) && ssModuleOn(mods, "advanced", true) && advancedMayRun;'), "Advanced lost its launch rule or its map rule");
  assert(/phoneOnly=\{phoneOnly\}\n[\s\S]{0,200}mods=\{mods\} \/>/.test(SHELL), "SettingsShell is not handed the map");
});

Deno.test("Settings: the rail and the body read one list, and a page follows its tab above the admin bypass", () => {
  assert(SHELL.includes("ssSettingsTabs({ isOwner: settingsIsOwner, isAdmin: settingsIsAdmin, access: settingsAccess, phoneOffered, shedsOn, phoneOnly, mods })"), "the Settings rail is not handed the map");
  assert(SETTINGS.includes("const TABS = ssSettingsTabs({ isOwner, isAdmin, access, phoneOffered, shedsOn, phoneOnly, mods });"), "the Settings body is not handed the map");
  assert(SHELL.includes("ssSettingsHubs({ isOwner: settingsIsOwner, isAdmin: settingsIsAdmin, access: settingsAccess, schedUnlocked, phoneOffered, shedsOn, phoneOnly, mods })"), "the Settings hubs (rail) are not handed the map");
  assert(SETTINGS.includes("const hubs = ssSettingsHubs({ isOwner, isAdmin, access, schedUnlocked, phoneOffered, shedsOn, phoneOnly, mods });"), "the Settings hubs (body) are not handed the map");
  const rule = "if (mods && SS_SETTINGS_MODULE[id] && !ssModuleOffered(mods, SS_SETTINGS_MODULE[id], true)) return false;";
  const at = CORE.indexOf(rule);
  const bypass = CORE.indexOf("if (isAdmin || !access) return true;", at);
  assert(at > 0 && bypass > at && bypass - at < 400, "the Settings map rule is gone, or no longer sits just above the admin bypass");
  assert(CORE.includes('const catalogOn = ssModuleOffered(mods, "designer", shedsOn);'), "the catalogue hubs lost their rule");
  assert(CORE.includes("colors: catalogOn ? ssColorTabs() : [],") && CORE.includes("options: catalogOn ? ssOptionTabs() : [],"), "Options or Colors no longer follows the Designer tab");
});
