/**
 * Unit tests for per-person access (migration 100 + _shared/access.ts).
 *
 * WHY THESE EXIST. Every other guard in this product fails loudly — a broken query 500s, a
 * bad type fails `deno check`. A permission bug does the opposite: it returns 200 with data
 * someone should not have seen, and nothing anywhere looks wrong. There is also no way to
 * exercise the interesting cases by hand without creating real staff logins on a real
 * tenant and signing in as each of them, which is precisely what nobody will redo after
 * every future edit. So the rules are pinned here, where they run on every push.
 *
 * The four properties worth losing sleep over:
 *   1. An owner can never be locked out — their stored map is ignored entirely.
 *   2. A NEW area is denied to everyone but owners until somebody grants it (deny by
 *      default). Adding an area must never quietly hand it to every existing admin.
 *   3. Billing is owner-only through EVERY door — preset, stored override, and grant.
 *   4. Nobody grants above themselves, so an admin cannot self-promote.
 *
 * Run: deno test supabase/functions/_shared/access.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  AREA_KEYS,
  AREAS,
  accessMetadata,
  canEdit,
  canRead,
  checkGate,
  effectiveAccess,
  type Gate,
  gateIsRead,
  type Level,
  mayGrant,
  mayGrantMap,
  ownContactsOnly,
  PRESETS,
  roleForTitle,
  sanitizeAccess,
  seesAllPayouts,
} from "./access.ts";

Deno.test("owner is absolute — stored overrides cannot reduce them", () => {
  // A hostile or simply corrupted map must not be able to lock the account's owner out of
  // their own billing page.
  const hostile = Object.fromEntries(AREA_KEYS.map((k) => [k, "none"]));
  const acc = effectiveAccess("owner", "driver", hostile);
  for (const k of AREA_KEYS) assertEquals(acc[k], "edit", `owner lost ${k}`);
});

Deno.test("a title's preset applies when nothing is overridden", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  assertEquals(rep.designs, "edit");
  assertEquals(rep.contacts, "edit");
  assertEquals(rep.inventory, "view");
  assertEquals(rep.commissions, "own");
  // Anything the preset omits is denied, not inherited from somewhere.
  assertEquals(rep.build_schedule, "none");
  assertEquals(rep.settings_billing, "none");
  assertEquals(rep.settings_team, "none");
});

Deno.test("overrides layer on top of the preset, and only where valid", () => {
  const acc = effectiveAccess("user", "sales_rep", {
    build_schedule: "view",     // add something the preset omits
    designs: "view",            // reduce something the preset grants
    made_up_area: "edit",       // unknown key → ignored, never trusted
    contacts: "sideways",       // invalid level → ignored, keeps the preset
  });
  assertEquals(acc.build_schedule, "view");
  assertEquals(acc.designs, "view");
  assertEquals(acc.contacts, "edit", "an invalid level must not blank the preset");
  assertFalse("made_up_area" in acc, "unknown areas must not enter the resolved map");
});

Deno.test("billing is owner-GRANTED: default off, owner grants it, only admins hold it", () => {
  // (Was "owner-only through every door" until 2026-08-08 — Carolyn's audit decision made
  // it grantable per admin. The doors this test guards changed meaning, not owners.)
  // Default: no admin has it until an owner acts.
  assertEquals(PRESETS.admin.settings_billing, "none");
  // The grant now WORKS on an admin — this is the feature.
  const granted = effectiveAccess("admin", "admin", { settings_billing: "edit" });
  assertEquals(granted.settings_billing, "edit");
  // ...and resolves to nothing on every other title, so a demotion revokes it structurally
  // and a hand-edited row cannot put Billing on a driver.
  for (const t of ["sales_rep", "crew_leader", "driver", "wizard"]) {
    assertEquals(effectiveAccess("user", t, { settings_billing: "edit" }).settings_billing, "none", t);
  }
  // Holding it is not the right to pass it on: a granted admin cannot give Billing away —
  // not even 'view', not even (via the self-door mayGrant also guards) to themselves.
  assertFalse(mayGrant("admin", granted, "settings_billing", "view"));
  assertFalse(mayGrant("admin", granted, "settings_billing", "edit"));
  // Owners grant it.
  assert(mayGrant("owner", {} as Record<string, Level>, "settings_billing", "edit"));
  // And the gate itself opens for a granted admin — the point of the whole change.
  assertEquals(checkGate({ area: "settings_billing", level: "edit" }, granted), null);
});

Deno.test("sanitizeAccess stores a billing grant only on an admin row", () => {
  // Title-aware: the same submitted map keeps Billing for an admin, drops it for a rep.
  assertEquals(sanitizeAccess({ settings_billing: "edit" }, "admin").settings_billing, "edit");
  assertFalse("settings_billing" in sanitizeAccess({ settings_billing: "edit" }, "sales_rep"));
  // Caller that doesn't say who the map is for gets the safe direction: dropped.
  assertFalse("settings_billing" in sanitizeAccess({ settings_billing: "edit" }));
  // Team stays by-title for everyone, admin included.
  assertFalse("settings_team" in sanitizeAccess({ settings_team: "edit" }, "admin"));
});

Deno.test("nobody grants above their own level", () => {
  const admin = effectiveAccess("admin", "admin", { settings_quickbooks: "view" });
  assert(mayGrant("admin", admin, "settings_quickbooks", "view"), "may pass on what they hold");
  assertFalse(mayGrant("admin", admin, "settings_quickbooks", "edit"), "must not grant above themselves");

  const noQbo = effectiveAccess("admin", "admin", { settings_quickbooks: "none" });
  assertFalse(mayGrant("admin", noQbo, "settings_quickbooks", "view"), "cannot grant what they lack");

  // The escalation that matters: an admin cannot mint access for themselves either, because
  // granting runs through this same check whoever the target is.
  assertFalse(mayGrant("admin", noQbo, "settings_quickbooks", "edit"));
});

Deno.test("a newly added area defaults to denied for non-owners", () => {
  // Simulates tomorrow's area: absent from every preset. Owners keep working, everyone
  // else must be granted it explicitly.
  const future = "settings_payroll";
  assertFalse(AREA_KEYS.includes(future), "rename this test's fixture if payroll ever ships");
  const admin = effectiveAccess("admin", "admin", null);
  assertEquals(admin[future] ?? "none", "none");
  const owner = effectiveAccess("owner", "admin", null);
  assertEquals(owner[future] ?? "edit", "edit", "owners are unaffected by new areas");
});

Deno.test("read/edit/own semantics", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  assert(canRead(rep, "inventory"), "view implies read");
  assertFalse(canEdit(rep, "inventory"), "view is not edit");
  assert(canRead(rep, "commissions"), "'own' implies read");
  assertFalse(canEdit(rep, "commissions"), "'own' is not edit");
  assertFalse(seesAllPayouts(rep), "a rep on 'own' must not see other people's payouts");

  const admin = effectiveAccess("admin", "admin", null);
  assert(seesAllPayouts(admin));
  assertFalse(canRead(rep, "settings_billing"));
});

Deno.test("an unknown title falls back to the least-privileged preset, not to everything", () => {
  const junk = effectiveAccess("user", "wizard", null);
  assertEquals(junk.designs, PRESETS.sales_rep.designs);
  assertEquals(junk.settings_billing, "none");
});

// ── Action gates ────────────────────────────────────────────────────────────
// The gate table is only a security control if a MISSING entry denies. Every test below
// exists because the opposite behaviour is silent: it returns 200 with someone else's data.

Deno.test("an action with no gate is refused, not allowed", () => {
  // The whole design rests on this. If an ungated action fell through to "allowed", adding
  // a branch and forgetting the table entry would publish it to every employee.
  const owner = effectiveAccess("owner", "owner", null);
  assertEquals(checkGate(undefined, owner), "Unrecognised action.");
});

Deno.test("gates enforce the minimum level, and 'view' is satisfied by edit", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  assertEquals(checkGate({ area: "designs", level: "view" }, rep), null);
  assertEquals(checkGate({ area: "designs", level: "edit" }, rep), null, "edit satisfies edit");
  assertEquals(checkGate({ area: "inventory", level: "view" }, rep), null);
  assert(checkGate({ area: "inventory", level: "edit" }, rep), "view must not satisfy edit");
  assert(checkGate({ area: "build_schedule", level: "view" }, rep), "an area they lack");
});

Deno.test("'any' needs one, 'all' needs every one", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  // catalog: a rep holds neither settings area, so the real table entry denies them.
  const catalog: Gate = {
    any: [{ area: "settings_structures", level: "view" }, { area: "settings_options", level: "view" }],
  };
  assert(checkGate(catalog, rep));
  const partial = effectiveAccess("user", "sales_rep", { settings_options: "view" });
  assertEquals(checkGate(catalog, partial), null, "one of the two is enough for 'any'");

  // delete_inventory: deleting a unit also deletes its design, so both are required.
  const del: Gate = { all: [{ area: "inventory", level: "edit" }, { area: "designs", level: "edit" }] };
  const invOnly = effectiveAccess("user", "sales_rep", { inventory: "edit", designs: "none" });
  assert(checkGate(del, invOnly), "holding one half must not pass an 'all' gate");
  assertEquals(checkGate(del, effectiveAccess("owner", "owner", null)), null);
});

Deno.test("owners pass every gate, including the owner-only ones", () => {
  const owner = effectiveAccess("owner", "owner", null);
  assertEquals(checkGate({ area: "settings_billing", level: "edit" }, owner), null);
  const admin = effectiveAccess("admin", "admin", null);
  assert(checkGate({ area: "settings_billing", level: "edit" }, admin), "admins are not owners here");
});

Deno.test("read/write classification comes from the gate, not a second list", () => {
  // This drives the read-only OPERATOR check: misclassifying a write as a read would let a
  // read-only operator change a tenant's data.
  assert(gateIsRead("open"));
  assertFalse(gateIsRead("self"), "a self-service write is still a write");
  assert(gateIsRead({ area: "designs", level: "view" }));
  assertFalse(gateIsRead({ area: "designs", level: "edit" }));
  assert(gateIsRead({ any: [{ area: "a", level: "view" }, { area: "b", level: "view" }] }));
  assertFalse(
    gateIsRead({ all: [{ area: "a", level: "view" }, { area: "b", level: "edit" }] }),
    "one edit anywhere makes the whole action a write",
  );
  assertFalse(gateIsRead(undefined));
});

Deno.test("a denial names the area a human can ask for, not the action", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  const msg = checkGate({ area: "settings_billing", level: "view" }, rep) ?? "";
  assert(msg.includes("Billing"), `expected the area label, got: ${msg}`);
  assertFalse(msg.includes("settings_billing"), "no database keys in a message a person reads");
});

// ── The Team screen's write path ────────────────────────────────────────────
// These pin the rules that stand between "an admin manages the team" and "an admin can
// promote themselves to owner". Each one is a real request someone can make with curl.

Deno.test("title and role can never disagree", () => {
  // A person whose title says Admin but whose role still says user passes this module's
  // checks and is then refused by an RLS policy — which reads on screen as "the app is
  // broken" and is close to undiagnosable. Every title write carries the role with it.
  assertEquals(roleForTitle("owner"), "owner");
  assertEquals(roleForTitle("admin"), "admin");
  for (const t of ["sales_rep", "crew_leader", "driver"]) {
    assertEquals(roleForTitle(t), "user", `${t} must stay a plain user`);
  }
  assertEquals(roleForTitle("wizard"), "user", "an unknown title must not mint an admin");
  assertEquals(roleForTitle(null), "user");
});

Deno.test("only real deviations are stored", () => {
  const clean = sanitizeAccess({
    designs: "view",
    settings_billing: "edit",   // owner-only: must never be storable, by anyone
    made_up: "edit",            // unknown area
    contacts: "sideways",       // invalid level
    commissions: "own",         // area-specific vocabulary is allowed
  });
  assertEquals(clean, { designs: "view", commissions: "own" });
  assertEquals(sanitizeAccess(null), {});
  assertEquals(sanitizeAccess("nope"), {});
});

Deno.test("an admin cannot promote someone past themselves — via the ACCESS blob", () => {
  const admin = effectiveAccess("admin", "admin", { settings_quickbooks: "none" });
  const resulting = effectiveAccess("user", "sales_rep", { settings_quickbooks: "edit" });
  assertEquals(mayGrantMap("admin", admin, resulting), "QuickBooks");
});

Deno.test("an admin cannot promote someone past themselves — via the TITLE", () => {
  // The escalation the overrides check alone would miss: submit an EMPTY access object and
  // set the title to Owner. Because access is stored as deviations, nothing in the payload
  // looks suspicious — the privilege comes from the preset. mayGrantMap resolves first, so
  // it sees the owner preset and refuses.
  const admin = effectiveAccess("admin", "admin", null);
  const asOwner = effectiveAccess("owner", "owner", {});
  assert(mayGrantMap("admin", admin, asOwner), "an admin must not be able to mint an owner");
  // The same admin CAN create an ordinary rep, which is the everyday case.
  assertEquals(mayGrantMap("admin", admin, effectiveAccess("user", "sales_rep", null)), null);
  // ...and an owner can do both.
  assertEquals(mayGrantMap("owner", effectiveAccess("owner", "owner", null), asOwner), null);
});

Deno.test("taking access away is always allowed", () => {
  // An admin with no QuickBooks must still be able to REMOVE QuickBooks from someone who
  // has it — otherwise a departing employee cannot be locked out by the person on shift.
  const admin = effectiveAccess("admin", "admin", { settings_quickbooks: "none" });
  const stripped = effectiveAccess("user", "driver", { delivery_schedule: "none", inventory: "none", orders: "none" });
  assertEquals(mayGrantMap("admin", admin, stripped), null);
});

Deno.test("billing is granted by owners and nobody else, whatever the granter holds", () => {
  // The granter door, specifically. mayGrant's generic rule is "you may pass on what you
  // hold" — billing is the exception, so test it at every holding level a non-owner can
  // reach, not just the default. A granted admin (edit) is the tempting case: they HOLD
  // edit, and the generic rule would wave the grant through.
  for (const holding of ["none", "view", "edit"] as Level[]) {
    const granter = { settings_billing: holding } as Record<string, Level>;
    assertFalse(mayGrant("admin", granter, "settings_billing", "view"), `admin holding ${holding}`);
    assertFalse(mayGrant("user", granter, "settings_billing", "view"), `user holding ${holding}`);
  }
  assert(mayGrant("owner", {} as Record<string, Level>, "settings_billing", "edit"));
  // And mayGrantMap (the whole-map door set_access actually calls) refuses an admin
  // producing a billing-bearing map, while an owner's same map passes.
  const withBilling = effectiveAccess("admin", "admin", { settings_billing: "edit" });
  assertEquals(mayGrantMap("owner", effectiveAccess("owner", "owner", null), withBilling), null);
  assertEquals(mayGrantMap("admin", withBilling, withBilling), "Billing");
});

Deno.test("Team comes with the title and can never be granted as a switch", () => {
  // Team is the area that hands out every OTHER area, so a per-person override on it is a
  // back door around "only an owner may set the Admin title". The screen renders it locked;
  // this is the half that matters, because the screen is not the control.
  assertEquals(sanitizeAccess({ settings_team: "edit", designs: "view" }), { designs: "view" });
  // Even a hand-edited database row cannot grant it.
  assertEquals(effectiveAccess("user", "sales_rep", { settings_team: "edit" }).settings_team, "none");
  // An ADMIN still holds it, because their title says so — otherwise no admin could manage
  // people at all, which is most of the feature.
  assertEquals(effectiveAccess("admin", "admin", null).settings_team, "edit");
  assertEquals(effectiveAccess("owner", "owner", null).settings_team, "edit");
  // And an owner can still create an admin: mayGrantMap must not refuse the resulting map.
  const owner = effectiveAccess("owner", "owner", null);
  assertEquals(mayGrantMap("owner", owner, effectiveAccess("admin", "admin", null)), null);
});

// ── PROJECTS: CSM SYNERGY'S OWN BOARDS, GRANTED FROM THE TEAM SCREEN ──────────────────
// Carolyn, 2026-09-02: "I feel like THIS should be where we add them. And here we say ...
// we give them access to projects."
//
// The area is the grant. What makes it safe is that it is omitted from every preset (so it
// denies by default, property 2 above) AND that portal-projects establishes the tenant is
// ours before it consults the area at all — every builder's OWNER resolves projects=edit,
// because owners are absolute, so the area could never be the tenancy boundary.

Deno.test("projects is denied by default to every staff title", () => {
  for (const title of ["admin", "sales_rep", "crew_leader", "driver"] as const) {
    const acc = effectiveAccess("user", title, null);
    assertEquals(acc.projects, "none", `${title} must not get the internal board by title`);
  }
});

Deno.test("an owner resolves projects=edit — including a BUILDER's owner", () => {
  // Not a bug, and worth pinning so nobody "fixes" it: owners are absolute by construction.
  // Junior Barns' owner holds projects=edit in their map and still cannot open the console,
  // because the internal_account check runs first. If this ever asserted 'none' instead,
  // somebody has moved the tenancy boundary into the area, where it does not belong.
  assertEquals(effectiveAccess("owner", "owner", null).projects, "edit");
});

Deno.test("the Team switch actually grants it, at both levels", () => {
  assertEquals(effectiveAccess("user", "sales_rep", { projects: "view" }).projects, "view");
  assertEquals(effectiveAccess("user", "admin", { projects: "edit" }).projects, "edit");
  // view/edit is the split portal-projects already has (READ_ACTIONS vs can_write), which is
  // why an area was the right shape and a boolean was not.
  assert(canRead(effectiveAccess("user", "sales_rep", { projects: "view" }), "projects"));
  assertFalse(canEdit(effectiveAccess("user", "sales_rep", { projects: "view" }), "projects"));
  assert(canEdit(effectiveAccess("user", "admin", { projects: "edit" }), "projects"));
});

Deno.test("nobody grants projects above what they hold", () => {
  const viewer = effectiveAccess("user", "admin", { projects: "view" });
  assertFalse(mayGrant("admin", viewer, "projects", "edit"), "cannot grant beyond your own level");
  assert(mayGrant("admin", viewer, "projects", "view"));
  assert(mayGrant("admin", viewer, "projects", "none"), "taking it away is always allowed");
});

Deno.test("accessMetadata HIDES internal-only areas by default", () => {
  // ⚠️ This ships to every tenant's browser. The default has to be the answer that cannot
  // leak, because a caller that has not thought about whose screen it is building will take
  // it. A builder seeing a "Projects" switch would be told about an internal tool they can
  // never reach, and would raise a support question about a permission that does nothing.
  const shown = accessMetadata().areas.map((a) => a.key);
  assertFalse(shown.includes("projects"), "a builder must not be offered the Projects switch");
  assert(shown.includes("designs"), "ordinary areas are unaffected");

  const ours = accessMetadata({ internal: true }).areas.map((a) => a.key);
  assert(ours.includes("projects"), "our own tenant must be offered it");
  assertEquals(ours.length, AREAS.length, "nothing else is filtered");
  assertEquals(shown.length, AREAS.length - 1, "exactly one area is internal-only today");

  // The filter is presentation, not resolution: the area still exists for everyone, which is
  // what lets the server resolve a stored grant regardless of who asked for the grid.
  assert(AREA_KEYS.includes("projects"));
  assertEquals(accessMetadata({ internal: false }).areas.map((a) => a.key).includes("projects"), false);
});

// ─── contacts:'own' (2026-09-05, migration 193) ──────────────────────────────────────────
// The FIRST level that narrows ROWS rather than tabs, which is why it gets its own block.
// Carolyn's dealer client, 09-04 @1:02:16: "he also doesn't want them to see each other's
// quotes either." The rule is enforced in three places -- RLS, the edge functions' own
// filters, and the client -- and these pin the resolver half the other two read from.
Deno.test("contacts:'own' resolves, reads, and does NOT write", () => {
  const a = effectiveAccess("user", "sales_rep", { contacts: "own" });
  assertEquals(a.contacts, "own", "a stored 'own' must survive resolution");
  assert(canRead(a, "contacts"), "'own' is a READ level -- the rep sees their own customers");
  assertFalse(canEdit(a, "contacts"), "'own' must never satisfy an edit gate");
  assert(ownContactsOnly(a), "the one place 'own' is compared for this area");
});

// The reason 'own' was ADDED beside 'view' instead of replacing it: every stored
// {"contacts":"view"} would otherwise fall back to the title preset with nothing logged --
// 'none' for a crew leader, i.e. a silent revocation dressed as a refactor.
Deno.test("contacts:'view' still resolves after 'own' was added", () => {
  const a = effectiveAccess("user", "crew_leader", { contacts: "view" });
  assertEquals(a.contacts, "view");
  assert(canRead(a, "contacts"));
  assertFalse(ownContactsOnly(a), "'view' is everyone's customers, not own-only");
});

// Property 1 from the header, at the one place a new level could break it: an owner's stored
// map is ignored ENTIRELY. A hostile or stale {"contacts":"own"} on an owner must not narrow
// the person who is supposed to be able to see "this customer went through employee B and C".
Deno.test("an owner carrying a stored contacts:'own' is still unrestricted", () => {
  const a = effectiveAccess("owner", "owner", { contacts: "own" });
  assertEquals(a.contacts, "edit");
  assertFalse(ownContactsOnly(a), "owners are absolute in every layer, this one included");
});

// RANK scores 'own' and 'view' equally, so the generic "you may pass on what you hold" rule
// would have let an admin an owner had narrowed to 'own' hand a rep the FULL list -- widening
// by delegation, which is the escalation nobody looks for.
Deno.test("an 'own' holder cannot grant 'view' on contacts", () => {
  assertFalse(mayGrant("user", { contacts: "own" }, "contacts", "view"),
    "passing on more than you hold is the whole thing mayGrant exists to stop");
  assert(mayGrant("user", { contacts: "own" }, "contacts", "own"),
    "passing on exactly what you hold stays allowed");
  assert(mayGrant("owner", {}, "contacts", "view"), "an owner is unaffected");
});
