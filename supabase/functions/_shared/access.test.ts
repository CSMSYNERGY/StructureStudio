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
 * Run: deno test --allow-read supabase/functions/_shared/access.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs, which grants a repo-scoped
 * --allow-read. The read is for the SQL-mirror test at the bottom, which parses the newest
 * migration that defines area_level_for.)
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
  ownPhoneOnly,
  PRESETS,
  roleForTitle,
  sanitizeAccess,
  seesAllPayouts,
  TITLES,
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
Deno.test("contacts:'own' resolves, reads, and WRITES", () => {
  // Written 2026-09-05 as "...and does NOT write", which was the level's shape for two days.
  // Carolyn made the second decision that comment invited on 2026-09-07 -- "Yes, let dealers
  // edit their own contacts" -- so the third assertion is inverted rather than deleted: the
  // pairing of a true canRead with a canEdit is the thing worth keeping in one place.
  const a = effectiveAccess("user", "sales_rep", { contacts: "own" });
  assertEquals(a.contacts, "own", "a stored 'own' must survive resolution");
  assert(canRead(a, "contacts"), "'own' reads -- the rep sees their own customers");
  assert(canEdit(a, "contacts"), "'own' now satisfies an edit gate; the ROWS are narrowed elsewhere");
  assert(ownContactsOnly(a), "the one place 'own' is compared for this area -- and now the "
    + "only thing standing between a dealer and the whole customer list");
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

// ─── contacts:'own_view' (2026-10-06, migration 286) ─────────────────────────────────────
// Carolyn: "a per-user setting the builder controls: edit or view only." A FIFTH contacts
// level, own customers read-only, beside 'own' (own customers, can edit) which does not move.
// Every property below has a silent failure mode: a level the resolver discards widens the
// person to their title preset (a sales rep's is 'edit' on EVERY customer), and a level that
// passes canEdit is not view-only at all.

Deno.test("contacts:'own_view' resolves on a sales rep and on a dealer", () => {
  assertEquals(effectiveAccess("user", "sales_rep", { contacts: "own_view" }).contacts, "own_view");
  assertEquals(effectiveAccess("user", "dealer", { contacts: "own_view" }).contacts, "own_view");
  assertEquals(effectiveAccess("user", null, { contacts: "own_view" }).contacts, "own_view", "a NULL title (a sales rep)");
  assertEquals(effectiveAccess("user", "crew_leader", { contacts: "own_view" }).contacts, "own_view",
    "a title whose preset omits contacts gains own-only reading");
  assertEquals(AREAS.find((a) => a.key === "contacts")?.levels, ["none", "own_view", "own", "view", "edit"],
    "narrowest first; the order is what preflight compares against migration 286");
});

Deno.test("contacts:'own_view' reads, is narrowed to their own customers, and does NOT write", () => {
  const a = effectiveAccess("user", "sales_rep", { contacts: "own_view" });
  assert(canRead(a, "contacts"), "they see their own customers");
  assertFalse(canEdit(a, "contacts"), "view only: no edits, notes, texts, emails or files");
  assert(ownContactsOnly(a), "the same rows as 'own' — RLS, the edge, the browser and the Worker all narrow on this");
  // Designs and orders keep their own switches: view-only on customers is not view-only on sales.
  assert(canEdit(a, "designs"), "a rep on own_view still builds and sends estimates (designs:edit)");
  assert(canEdit(a, "orders"), "...and works orders (orders:edit)");
});

Deno.test("contacts:'own_view' fails every contacts:'edit' gate and passes contacts:'view'", () => {
  const a = effectiveAccess("user", "dealer", { contacts: "own_view" });
  assertEquals(checkGate({ area: "contacts", level: "edit" }, a),
    "Your access does not let you change Contacts. Ask an owner or admin.");
  assertEquals(checkGate({ area: "contacts", level: "view" }, a), null);
  // crm_record's shape: either half is enough to open the record.
  assertEquals(checkGate({ any: [{ area: "contacts", level: "view" }, { area: "designs", level: "view" }] }, a), null);
});

Deno.test("an owner carrying a stored own_view resolves edit and is not narrowed", () => {
  const a = effectiveAccess("owner", "owner", { contacts: "own_view" });
  assertEquals(a.contacts, "edit");
  assertFalse(ownContactsOnly(a), "owners are absolute in every layer");
  assert(canEdit(a, "contacts"));
});

Deno.test("own_view exists on contacts only: commissions and phone discard it", () => {
  assertEquals(effectiveAccess("user", "sales_rep", { commissions: "own_view" }).commissions, "own", "the preset stands");
  assertEquals(effectiveAccess("user", "sales_rep", { phone: "own_view" }).phone, "own", "the preset stands");
  assertEquals(effectiveAccess("user", "office_staff", { phone: "own_view" }).phone, "view");
  assertEquals(effectiveAccess("user", "sales_rep", { designs: "own_view" }).designs, "edit");
  assertEquals(sanitizeAccess({ contacts: "own_view", commissions: "own_view", phone: "own_view", orders: "own_view" }, "sales_rep"),
    { contacts: "own_view" }, "stored on contacts and nowhere else");
});

Deno.test("mayGrant: who may hand out own_view, and what an own_view holder may hand out", () => {
  const own = effectiveAccess("admin", "admin", { contacts: "own" });
  assert(mayGrant("admin", own, "contacts", "own_view"), "an 'own' holder may narrow someone to view only");
  assert(mayGrant("admin", own, "contacts", "own"));
  assertFalse(mayGrant("admin", own, "contacts", "view"), "re-pinned: an 'own' holder never widens");
  assertFalse(mayGrant("admin", own, "contacts", "edit"));

  const ownView = effectiveAccess("admin", "admin", { contacts: "own_view" });
  assert(mayGrant("admin", ownView, "contacts", "own_view"), "passing on exactly what they hold");
  assert(mayGrant("admin", ownView, "contacts", "none"), "taking it away is always allowed");
  assertFalse(mayGrant("admin", ownView, "contacts", "own"), "own writes; they do not");
  assertFalse(mayGrant("admin", ownView, "contacts", "view"), "rule 3: never wider than their own customers");
  assertFalse(mayGrant("admin", ownView, "contacts", "edit"));

  const viewer = effectiveAccess("admin", "admin", { contacts: "view" });
  assert(mayGrant("admin", viewer, "contacts", "own_view"), "a read-only 'view' holder may hand out read-only own");
  assertFalse(mayGrant("admin", viewer, "contacts", "own"), "...but not the writing 'own'");

  for (const lv of ["none", "own_view", "own", "view", "edit"] as Level[]) {
    assert(mayGrant("owner", {}, "contacts", lv), `an owner may grant ${lv}`);
  }
  // The whole-map door the Team screen calls.
  assertEquals(mayGrantMap("admin", ownView, effectiveAccess("user", "sales_rep", { contacts: "own" })), "Contacts");
  assertEquals(mayGrantMap("owner", effectiveAccess("owner", "owner", null), effectiveAccess("user", "sales_rep", { contacts: "own_view" })), null);
});

Deno.test("the default is today's behaviour: no preset starts view-only", () => {
  assertEquals(PRESETS.dealer.contacts, "own", "the Dealer title stays Own · Edit");
  assert(canEdit(effectiveAccess("user", "dealer", null), "contacts"));
  for (const t of TITLES) {
    assert(PRESETS[t.key].contacts !== "own_view", `${t.key}'s preset must not start view-only`);
  }
  assertEquals(effectiveAccess("user", "sales_rep", null).contacts, "edit");
  // An unknown level still falls back to the preset rather than blanking it.
  assertEquals(effectiveAccess("user", "sales_rep", { contacts: "own-view" }).contacts, "edit");
});

// ── APPROVE CHANGES — a SEPARATE area, not a level above `edit` (2026-09-07) ────────────
// Carolyn: "there should be both the option to give approval for a change order, but they can
// also make the change order if they are given permission." These pin that the two grants are
// genuinely independent in both directions, which is the whole reason it is a second area.

Deno.test("Approve Changes is denied by default to every staff title", () => {
  for (const t of ["sales_rep", "crew_leader", "driver"] as const) {
    assertEquals(effectiveAccess("user", t, null).change_order_approve, "none", t);
  }
});

Deno.test("owners and admins hold Approve Changes without anyone setting it", () => {
  assertEquals(effectiveAccess("owner", "owner", null).change_order_approve, "edit");
  assertEquals(effectiveAccess("user", "admin", null).change_order_approve, "edit");
});

Deno.test("granting Approve does not grant Raise, and granting Raise does not grant Approve", () => {
  const approver = effectiveAccess("user", "crew_leader", { change_order_approve: "edit" });
  assertEquals(approver.change_order_approve, "edit");
  assertEquals(approver.change_orders, "none", "an approver cannot raise unless separately granted");

  const raiser = effectiveAccess("user", "sales_rep", { change_orders: "edit" });
  assertEquals(raiser.change_orders, "edit");
  assertEquals(raiser.change_order_approve, "none", "a raiser cannot approve their own change");
});

Deno.test("one person can hold both", () => {
  const both = effectiveAccess("user", "crew_leader", { change_orders: "edit", change_order_approve: "edit" });
  assertEquals([both.change_orders, both.change_order_approve], ["edit", "edit"]);
});

Deno.test("Approve Changes has two levels — 'view' is not one of them", () => {
  // An out-of-vocabulary override is discarded, not stored through. The SQL mirror asserts
  // the same thing; this is the half that runs in CI.
  assertEquals(effectiveAccess("user", "crew_leader", { change_order_approve: "view" }).change_order_approve, "none");
});

Deno.test("an approver can pass Approve on; a raiser cannot", () => {
  const approver = effectiveAccess("user", "admin", null);
  assertEquals(mayGrant("user", approver, "change_order_approve", "edit"), true);
  const raiser = effectiveAccess("user", "sales_rep", { change_orders: "edit" });
  assertEquals(mayGrant("user", raiser, "change_order_approve", "edit"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The five titles added 2026-09-07 (migration 218)
// ─────────────────────────────────────────────────────────────────────────────
//
// Carolyn asked for nine job titles and for each to seed sensible defaults "but we still
// keep the override access that is already set". The second half is the part that can
// regress invisibly — a preset is easy to eyeball, a preset-plus-override is not — so it is
// pinned per title rather than once.

Deno.test("every TITLE has a preset, and every preset key is a real area", () => {
  // Guards the two directions a title can be half-added: named in TITLES with no preset (it
  // silently resolves to all-none) or given a preset that no pill can select.
  for (const t of TITLES) {
    assert(PRESETS[t.key] !== undefined, `TITLES has ${t.key} but PRESETS does not`);
  }
  for (const key of Object.keys(PRESETS)) {
    assert(TITLES.some((t) => t.key === key), `PRESETS has ${key} but TITLES does not`);
  }
  for (const [title, preset] of Object.entries(PRESETS)) {
    for (const [area, level] of Object.entries(preset)) {
      const a = AREAS.find((x) => x.key === area);
      assert(a, `preset ${title} names unknown area ${area}`);
      assert(
        a.levels.includes(level as Level),
        `preset ${title} gives ${area}=${level}, which is not in that area's vocabulary`,
      );
    }
  }
});

Deno.test("office staff run the paperwork and cannot reshape the product", () => {
  const a = effectiveAccess("user", "office_staff", null);
  assertEquals(a.orders, "edit");
  assertEquals(a.change_orders, "edit");
  assertEquals(a.inventory, "edit");
  assertEquals(a.settings_branding, "edit");
  assertEquals(a.settings_quickbooks, "edit");
  // The designer, since 2026-09-07 (Carolyn, same day she picked the preset): the person
  // answering the phone is the one who builds the quote.
  assertEquals(a.designer, "edit");
  // Sees the boards, moves nothing on them.
  assertEquals(a.build_schedule, "view");
  assertEquals(a.delivery_schedule, "view");
  assertFalse(canEdit(a, "build_schedule"));
  // Deliberately absent — see the preset's own comment.
  assertEquals(a.commissions, "none");
  assertEquals(a.settings_structures, "none");
  assertEquals(a.settings_team, "none");
  assertEquals(a.settings_billing, "none");
});

Deno.test("a sales manager sees everyone's payouts; a rep and a dealer see only their own", () => {
  assert(seesAllPayouts(effectiveAccess("user", "sales_manager", null)));
  assertFalse(seesAllPayouts(effectiveAccess("user", "sales_rep", null)));
  assertFalse(seesAllPayouts(effectiveAccess("user", "dealer", null)));
  // The manager's other two differences from a rep.
  assertEquals(effectiveAccess("user", "sales_manager", null).change_orders, "edit");
  assertEquals(effectiveAccess("user", "sales_manager", null).reports, "edit");
});

Deno.test("a dealer WORKS their own customers and sees nobody else's", () => {
  // Carolyn, 2026-09-07: "Yes, let dealers edit their own contacts." Before that, 'own' was
  // read-only on contacts and this test asserted the opposite of the line below.
  const a = effectiveAccess("user", "dealer", null);
  assert(ownContactsOnly(a));
  assert(canRead(a, "contacts"));
  assert(canEdit(a, "contacts"));
  // Everything else is a sales rep.
  assertEquals(a.designer, "edit");
  assertEquals(a.orders, "edit");
  assertEquals(a.commissions, "own");
  assertFalse(ownContactsOnly(effectiveAccess("user", "sales_rep", null)));
});

Deno.test("'own' writes on contacts and does NOT write on commissions", () => {
  // The whole reason ownWrites is a per-area flag rather than a change to RANK. A rep on
  // commissions:'own' seeing their own payout must never be able to edit it, and that is the
  // confidentiality rule the commissions feature is built on.
  const dealer = effectiveAccess("user", "dealer", null);
  assert(canEdit(dealer, "contacts"));
  assertFalse(canEdit(dealer, "commissions"));
  assertFalse(seesAllPayouts(dealer));
  // And the flag is declared where it is read, not inferred from the level.
  assert(AREAS.find((x) => x.key === "contacts")?.ownWrites);
  assertFalse(!!AREAS.find((x) => x.key === "commissions")?.ownWrites);
});

Deno.test("an own-scoped caller satisfies a contacts:'edit' GATE", () => {
  // The eleven contacts write actions are gated { area: 'contacts', level: 'edit' }, so this
  // is the exact question resolveTenant asks before dispatch. It must now be YES — and the
  // row narrowing is a separate mechanism (portal-settings' CONTACT_ROW_SCOPE) that this
  // module cannot express and must not be assumed to cover.
  const dealer = effectiveAccess("user", "dealer", null);
  assertEquals(checkGate({ area: "contacts", level: "edit" }, dealer), null);
  assertEquals(checkGate({ area: "contacts", level: "view" }, dealer), null);
  // ...while a genuinely read-only person is still refused.
  const viewer = effectiveAccess("user", "crew_leader", { contacts: "view" });
  assert(checkGate({ area: "contacts", level: "edit" }, viewer) !== null);
});

Deno.test("a contacts:'view' holder cannot grant contacts:'own' — it now writes", () => {
  // The hole rule 4 of mayGrant closes. RANK scores 'own' and 'view' the SAME (both read),
  // so `RANK[own] <= RANK[view]` is true and rule 2 alone would wave this through: an admin
  // an owner had narrowed to read-only contacts could hand somebody the ability to edit
  // customer records, notes and SMS — a write the granter does not hold.
  const readOnly = effectiveAccess("admin", "admin", { contacts: "view" });
  assertFalse(canEdit(readOnly, "contacts"));
  assertFalse(mayGrant("admin", readOnly, "contacts", "own"));
  assertFalse(mayGrant("admin", readOnly, "contacts", "edit"));
  assert(mayGrant("admin", readOnly, "contacts", "view"));
  assert(mayGrant("admin", readOnly, "contacts", "none"));
  // Someone who DOES write may still narrow a person to 'own'.
  const writer = effectiveAccess("admin", "admin", null);
  assert(mayGrant("admin", writer, "contacts", "own"));
  // And commissions is untouched by rule 4, because its 'own' does not write.
  const repPay = effectiveAccess("user", "sales_rep", null);
  assert(mayGrant("user", repPay, "commissions", "own"));
  assertFalse(mayGrant("user", repPay, "commissions", "edit"));
});

Deno.test("an 'own' holder still passes on 'own' and never widens it", () => {
  // Rule 3, re-pinned: 'own' is a row scope, not a rank, so a dealer-scoped granter cannot
  // hand out the whole customer list even though they can now write to their slice of it.
  const narrowed = effectiveAccess("admin", "admin", { contacts: "own" });
  assert(canEdit(narrowed, "contacts"));
  assert(mayGrant("admin", narrowed, "contacts", "own"));
  assertFalse(mayGrant("admin", narrowed, "contacts", "view"));
  assertFalse(mayGrant("admin", narrowed, "contacts", "edit"));
});

Deno.test("a scheduler owns all three boards and can change no sale", () => {
  const a = effectiveAccess("user", "scheduler", null);
  assertEquals(a.build_schedule, "edit");
  assertEquals(a.delivery_schedule, "edit");
  assertEquals(a.repairs, "edit");
  assertEquals(a.orders, "view");
  assertEquals(a.designs, "view");
  assertEquals(a.contacts, "view");
  assertFalse(canEdit(a, "orders"));
});

Deno.test("a crew member reads the boards their leader runs, and nothing else", () => {
  const a = effectiveAccess("user", "crew_member", null);
  assertEquals(a.build_schedule, "view");
  assertEquals(a.repairs, "view");
  assertFalse(canEdit(a, "build_schedule"));
  // The difference from a crew leader, stated as a difference.
  const leader = effectiveAccess("user", "crew_leader", null);
  assertEquals(leader.build_schedule, "edit");
  assertEquals(leader.repairs, "edit");
  for (const k of ["designs", "orders", "inventory", "contacts", "designer", "commissions"]) {
    assertEquals(a[k], "none", `crew_member should not hold ${k}`);
  }
});

Deno.test("THE OVERRIDES STILL WIN on every new title", () => {
  // The half of Carolyn's request that must not regress: a preset is a starting point, and
  // a stored deviation layers on top of it exactly as it did on the five older titles.
  assertEquals(effectiveAccess("user", "dealer", { contacts: "edit" }).contacts, "edit");
  assertEquals(effectiveAccess("user", "crew_member", { orders: "view" }).orders, "view");
  assertEquals(effectiveAccess("user", "office_staff", { designer: "none" }).designer, "none");
  assertEquals(effectiveAccess("user", "scheduler", { orders: "edit" }).orders, "edit");
  // ...including taking one AWAY, which is the direction a preset cannot express.
  assertEquals(effectiveAccess("user", "sales_manager", { commissions: "own" }).commissions, "own");
});

Deno.test("the three skips still apply to the new titles", () => {
  for (const t of ["office_staff", "sales_manager", "dealer", "scheduler", "crew_member"]) {
    // Team comes with the title; Billing is holdable only by an admin; an unknown area is
    // never trusted out of the stored blob.
    assertEquals(effectiveAccess("user", t, { settings_team: "edit" }).settings_team, "none");
    assertEquals(effectiveAccess("user", t, { settings_billing: "edit" }).settings_billing, "none");
    assertEquals(effectiveAccess("user", t, { no_such_area: "edit" }).no_such_area, undefined);
    // ...and an out-of-vocabulary level is discarded rather than stored: 'own' is not in
    // orders' vocabulary, so the preset stands.
    const preset = PRESETS[t as keyof typeof PRESETS];
    assertEquals(effectiveAccess("user", t, { orders: "own" }).orders, preset.orders ?? "none");
  }
});

Deno.test("every new title is coarse role 'user' — none of them is a second admin", () => {
  // roleForTitle feeds client_users.role, which older RLS policies read. A new title that
  // resolved to 'admin' would hand out the Billing grant and the Team screen by accident.
  for (const t of ["office_staff", "sales_manager", "dealer", "scheduler", "crew_member"]) {
    assertEquals(roleForTitle(t), "user");
    assertEquals(effectiveAccess("user", t, null).settings_team, "none");
  }
  assertEquals(roleForTitle("admin"), "admin");
  assertEquals(roleForTitle("owner"), "owner");
});

Deno.test("Approve Changes stayed denied by default when five titles were added", () => {
  // 212's rule, re-pinned because 218 rewrote the same preset table: everyone starts at
  // None except owners and admins.
  for (const t of ["office_staff", "sales_manager", "dealer", "scheduler", "crew_member"]) {
    assertEquals(effectiveAccess("user", t, null).change_order_approve, "none");
  }
  assertEquals(effectiveAccess("admin", "admin", null).change_order_approve, "edit");
});

Deno.test("sanitizeAccess accepts the new titles and still refuses Billing on them", () => {
  // A title the sanitizer does not recognise falls back to sales_rep, which would silently
  // rewrite what an owner saved. Checked per title rather than inferred from normTitle.
  for (const t of ["office_staff", "sales_manager", "dealer", "scheduler", "crew_member"]) {
    assertEquals(sanitizeAccess({ orders: "edit" }, t), { orders: "edit" });
    assertEquals(sanitizeAccess({ settings_billing: "edit" }, t), {});
    assertEquals(sanitizeAccess({ settings_team: "edit" }, t), {});
  }
});

Deno.test("an owner may hand out any new title's whole preset; a sales manager may not", () => {
  const owner = effectiveAccess("owner", "owner", null);
  for (const t of ["office_staff", "sales_manager", "dealer", "scheduler", "crew_member"]) {
    assertEquals(mayGrantMap("owner", owner, effectiveAccess("user", t, null)), null);
  }
  // Nobody grants above themselves. A sales manager holds inventory at 'view' and no
  // settings at all, so they cannot mint an office staffer who edits either. mayGrantMap
  // reports the FIRST area it refuses in AREA_KEYS order, and Inventory precedes the
  // settings group — so this asserts both that the refusal happens and where.
  const mgr = effectiveAccess("user", "sales_manager", null);
  assertEquals(
    mayGrantMap("user", mgr, effectiveAccess("user", "office_staff", null)),
    "Inventory",
  );
  // ...and it is not only the first one it names. Asked area by area, a manager holds none
  // of what makes office staff office staff.
  assertFalse(mayGrant("user", mgr, "inventory", "edit"));
  assertFalse(mayGrant("user", mgr, "settings_branding", "edit"));
  assertFalse(mayGrant("user", mgr, "settings_quickbooks", "edit"));
  assertFalse(mayGrant("user", mgr, "build_schedule", "view"));
});

Deno.test("a dealer's narrowed contacts scope cannot be widened by someone who shares it", () => {
  // Rule 3 of mayGrant, exercised on the title the 'own' scope was built for: an admin whom
  // an owner had deliberately narrowed to contacts:'own' cannot hand a dealer the whole list.
  const narrowed = effectiveAccess("admin", "admin", { contacts: "own" });
  assertFalse(mayGrant("admin", narrowed, "contacts", "view"));
  assertFalse(mayGrant("admin", narrowed, "contacts", "edit"));
  assert(mayGrant("admin", narrowed, "contacts", "own"));
});

// ── MY SYNERGY PHONE (migration 254, 2026-09-29) ─────────────────────────────────────────
// Levels none/own/view/edit. The rule worth pinning is the rank trap: RANK scores 'own' and
// 'view' the same, so canRead() says yes to both, and only ownPhoneOnly() can tell "my calls"
// from "the team's calls". Presets are the plan's §7 defaults.

Deno.test("phone presets: owner/admin edit, office staff/sales manager view, reps/dealers own, the rest none", () => {
  const expected: Record<string, Level> = {
    owner: "edit", admin: "edit",
    office_staff: "view", sales_manager: "view",
    sales_rep: "own", dealer: "own",
    scheduler: "none", crew_leader: "none", crew_member: "none", driver: "none",
  };
  // Every title is listed, so a title added tomorrow fails here until somebody decides.
  assertEquals(Object.keys(expected).sort(), TITLES.map((t) => t.key).sort());
  for (const [title, level] of Object.entries(expected)) {
    const role = title === "owner" ? "owner" : title === "admin" ? "admin" : "user";
    assertEquals(effectiveAccess(role, title, null).phone, level, title);
  }
  // Omission is how a preset denies. Spelling 'none' out would suggest the list is exhaustive.
  for (const t of ["scheduler", "crew_leader", "crew_member", "driver"] as const) {
    assertFalse("phone" in PRESETS[t], `${t} should omit phone, not spell out none`);
  }
});

Deno.test("phone: an owner is always edit, whatever is stored", () => {
  for (const stored of ["none", "own", "view"]) {
    const a = effectiveAccess("owner", "owner", { phone: stored });
    assertEquals(a.phone, "edit", `stored ${stored}`);
    assertFalse(ownPhoneOnly(a), "an owner always sees the team");
  }
});

Deno.test("phone: the team check is the LITERAL level, because rank puts own == view", () => {
  const rep = effectiveAccess("user", "sales_rep", null);
  const office = effectiveAccess("user", "office_staff", null);
  // Both may use the phone...
  assert(canRead(rep, "phone"));
  assert(canRead(office, "phone"));
  assertEquals(checkGate({ area: "phone", level: "view" }, rep), null,
    "a gate cannot express 'team', so 'own' passes a view gate — which is why the helper exists");
  // ...and only one of them sees the team.
  assert(ownPhoneOnly(rep));
  assertFalse(ownPhoneOnly(office));
  assertFalse(ownPhoneOnly(effectiveAccess("user", "admin", null)));
  assert(ownPhoneOnly(effectiveAccess("user", "dealer", null)));
});

Deno.test("ownPhoneOnly fails closed: 'none' and a missing key are 'own only' too", () => {
  // The difference from ownContactsOnly, on purpose: `!ownPhoneOnly(a)` must never be true for
  // someone with no phone access, even on a path that forgot the canRead gate.
  assert(ownPhoneOnly({ phone: "none" }));
  assert(ownPhoneOnly({}));
  assert(ownPhoneOnly(effectiveAccess("user", "driver", null)));
  assertFalse(ownPhoneOnly({ phone: "view" }));
  assertFalse(ownPhoneOnly({ phone: "edit" }));
  assertFalse(canRead(effectiveAccess("user", "driver", null), "phone"), "and the gate refuses them");
});

Deno.test("phone: only edit changes phone settings — 'own' does not write", () => {
  // canEdit(phone) is the settings gate. 'own' makes calls but must not re-route the business
  // line, so the area is deliberately NOT ownWrites.
  assertFalse(!!AREAS.find((a) => a.key === "phone")?.ownWrites);
  assertFalse(canEdit(effectiveAccess("user", "sales_rep", null), "phone"));
  assertFalse(canEdit(effectiveAccess("user", "office_staff", null), "phone"));
  assert(canEdit(effectiveAccess("user", "admin", null), "phone"));
  assert(checkGate({ area: "phone", level: "edit" }, effectiveAccess("user", "sales_manager", null)) !== null);
});

Deno.test("phone: overrides layer on the preset, and an unknown level is discarded", () => {
  assertEquals(effectiveAccess("user", "crew_leader", { phone: "own" }).phone, "own");
  assertEquals(effectiveAccess("user", "driver", { phone: "view" }).phone, "view");
  assertEquals(effectiveAccess("user", "sales_rep", { phone: "none" }).phone, "none", "taking it away works");
  assertEquals(effectiveAccess("user", "dealer", { phone: "admin" }).phone, "own", "out-of-vocabulary level keeps the preset");
  assertEquals(sanitizeAccess({ phone: "own" }, "crew_member"), { phone: "own" });
  assertEquals(sanitizeAccess({ phone: "sideways" }, "crew_member"), {});
});

Deno.test("phone: an 'own' holder cannot hand out the team's calls", () => {
  // mayGrant rule 3, on the second area that pairs 'own' with a real 'view'.
  const rep = effectiveAccess("user", "sales_rep", null);
  assertFalse(mayGrant("user", rep, "phone", "view"));
  assertFalse(mayGrant("user", rep, "phone", "edit"));
  assert(mayGrant("user", rep, "phone", "own"));
  // A viewer passes on view or own, never settings.
  const mgr = effectiveAccess("user", "sales_manager", null);
  assert(mayGrant("user", mgr, "phone", "view"));
  assert(mayGrant("user", mgr, "phone", "own"));
  assertFalse(mayGrant("user", mgr, "phone", "edit"));
  // An admin (edit) may set any level; an owner may too.
  assert(mayGrant("admin", effectiveAccess("admin", "admin", null), "phone", "edit"));
  assert(mayGrant("owner", {}, "phone", "view"));
});

Deno.test("phone is offered on every tenant's Team screen", () => {
  // Not internalOnly: every builder's owner hands this out.
  assert(accessMetadata().areas.some((a) => a.key === "phone"));
  assertEquals(AREAS.find((a) => a.key === "phone")?.levels, ["none", "own", "view", "edit"]);
});

// ── OVERRIDE PRICES (migration 277, 2026-10-05) ─────────────────────────────────────────
// A builder's request: a rep with the right permission changes a line's price in the Designer, and the
// quote shows it as that line's price. submit-estimate honours it only for someone canEdit() says
// holds this area. The safe default until Carolyn decides: owners always, admins by preset, every
// other title only when an owner or admin ticks it on for that person.

Deno.test("Override prices: owners and admins hold it; every other title is denied by default", () => {
  assertEquals(effectiveAccess("owner", "owner", null).price_override, "edit");
  assertEquals(effectiveAccess("owner", null, null).price_override, "edit", "an owner with no title (most live owners)");
  assertEquals(effectiveAccess("admin", "admin", null).price_override, "edit");
  assertEquals(effectiveAccess("user", "admin", null).price_override, "edit", "the title decides, not the coarse role");
  // Every non-admin title listed, so a title added tomorrow fails here until somebody decides.
  const denied = TITLES.map((t) => t.key).filter((t) => t !== "owner" && t !== "admin");
  assertEquals(denied.length, 8);
  for (const t of denied) {
    assertEquals(effectiveAccess("user", t, null).price_override, "none", t);
    assertFalse("price_override" in PRESETS[t], `${t} should omit price_override, not spell out none`);
  }
  // A NULL or unknown title is a sales rep (normTitle), and a sales rep does not hold it.
  assertEquals(effectiveAccess("user", null, null).price_override, "none");
  assertEquals(effectiveAccess("user", "wizard", null).price_override, "none");
});

Deno.test("Override prices: the Team switch grants it to one person, and takes it from an admin", () => {
  const rep = effectiveAccess("user", "sales_rep", { price_override: "edit" });
  assertEquals(rep.price_override, "edit");
  assert(canEdit(rep, "price_override"), "submit-estimate asks canEdit — the grant must satisfy it");
  assertFalse(canEdit(effectiveAccess("user", "sales_rep", null), "price_override"));
  // An owner can take it away from an admin: the preset is a starting point, not a ceiling.
  assertEquals(effectiveAccess("admin", "admin", { price_override: "none" }).price_override, "none");
  // ...but never from an owner.
  assertEquals(effectiveAccess("owner", "owner", { price_override: "none" }).price_override, "edit");
  // Two levels only. 'view' would mean nothing, so it is discarded rather than stored through.
  assertEquals(effectiveAccess("user", "dealer", { price_override: "view" }).price_override, "none");
  assertEquals(sanitizeAccess({ price_override: "edit" }, "sales_rep"), { price_override: "edit" });
  assertEquals(sanitizeAccess({ price_override: "view" }, "sales_rep"), {});
});

Deno.test("Override prices: granting it moves nothing else, and nothing else grants it", () => {
  const before = effectiveAccess("user", "sales_rep", null);
  const after = effectiveAccess("user", "sales_rep", { price_override: "edit" });
  for (const k of AREA_KEYS) {
    if (k !== "price_override") assertEquals(after[k], before[k], `granting price_override moved ${k}`);
  }
  // Designer edit, designs edit and a rep's whole kit do not imply it.
  const loaded = effectiveAccess("user", "sales_manager", { designer: "edit", designs: "edit", orders: "edit", change_orders: "edit" });
  assertEquals(loaded.price_override, "none");
});

Deno.test("Override prices: a holder may pass it on; nobody else can mint it", () => {
  assert(mayGrant("owner", {}, "price_override", "edit"));
  assert(mayGrant("admin", effectiveAccess("admin", "admin", null), "price_override", "edit"));
  assert(mayGrant("user", effectiveAccess("user", "sales_rep", { price_override: "edit" }), "price_override", "edit"));
  assertFalse(mayGrant("user", effectiveAccess("user", "sales_manager", null), "price_override", "edit"));
  assertFalse(mayGrant("admin", effectiveAccess("admin", "admin", { price_override: "none" }), "price_override", "edit"),
    "an admin an owner took it from cannot hand it back to themselves or anyone");
});

Deno.test("Override prices is on every builder's Team screen, labelled for a builder", () => {
  const a = accessMetadata().areas.find((x) => x.key === "price_override");
  assert(a, "not internal-only: every builder's owner hands this out");
  assertEquals(a.levels, ["none", "edit"]);
  assertEquals(a.label, "Override prices");
  assertEquals(a.group, "workspace");
  assertFalse(!!a.ownerGranted || !!a.byTitleOnly || !!a.ownWrites, "an ordinary grantable switch");
  // Right after Designer on the grid: it is a power inside the Designer.
  assertEquals(AREA_KEYS.indexOf("price_override"), AREA_KEYS.indexOf("designer") + 1);
});

// ── The SQL twin, read back and compared cell by cell ───────────────────────────────────
// scripts/preflight.mjs compares area KEYS, level VOCABULARIES and TITLE keys between this
// module and area_level_for(), and says in its own header that it cannot compare preset
// LEVELS, because PRESETS.owner is computed and cannot be scanned. A Deno test can evaluate
// it, so this closes that gap: every title x area cell, and the two area flags the SQL reads.
// Migration 219 exists because one such cell (office_staff designer) had to be asserted by
// hand; the sales_rep `orders` drift CLAUDE.md records was exactly this class.
//
// Same discovery rule as preflight: the newest migration that DEFINES the function, never the
// highest number, and the literals are found by their declaration, never by the bare word.
Deno.test("area_level_for's k_areas and k_presets match AREAS and PRESETS exactly", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort().reverse();
  let file = "";
  let src = "";
  for (const n of names) {
    const s = await Deno.readTextFile(new URL(n, dir));
    if (/create\s+or\s+replace\s+function\s+public\.area_level_for/i.test(s)) {
      file = n;
      src = s;
      break;
    }
  }
  assert(src, "no migration defines public.area_level_for");
  const literal = (decl: string) => {
    const at = new RegExp(decl + "\\s+constant\\s+jsonb\\s*:=").exec(src);
    assert(at, `${file}: cannot find the ${decl} declaration`);
    const open = src.indexOf("$j$", at.index);
    const close = src.indexOf("$j$", open + 3);
    assert(open > 0 && close > open, `${file}: cannot read the ${decl} literal`);
    return JSON.parse(src.slice(open + 3, close));
  };
  const sqlAreas = literal("k_areas") as Record<string, { levels: string[]; ownerGranted?: boolean; byTitleOnly?: boolean }>;
  const sqlPresets = literal("k_presets") as Record<string, Record<string, string>>;

  assertEquals(Object.keys(sqlAreas).sort(), [...AREA_KEYS].sort(), `${file}: area keys`);
  for (const a of AREAS) {
    assertEquals(sqlAreas[a.key].levels, a.levels, `${file}: ${a.key} levels`);
    assertEquals(!!sqlAreas[a.key].ownerGranted, !!a.ownerGranted, `${file}: ${a.key} ownerGranted`);
    assertEquals(!!sqlAreas[a.key].byTitleOnly, !!a.byTitleOnly, `${file}: ${a.key} byTitleOnly`);
  }
  assertEquals(Object.keys(sqlPresets).sort(), TITLES.map((t) => t.key).sort(), `${file}: titles`);
  for (const t of TITLES) {
    for (const k of AREA_KEYS) {
      assertEquals(
        sqlPresets[t.key][k] ?? "none",
        PRESETS[t.key][k] ?? "none",
        `${file}: ${t.key}.${k} differs between k_presets and PRESETS`,
      );
    }
    for (const k of Object.keys(sqlPresets[t.key])) {
      assert(AREA_KEYS.includes(k), `${file}: k_presets.${t.key} names unknown area ${k}`);
    }
  }
});
