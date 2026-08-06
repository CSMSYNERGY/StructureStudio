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
  canEdit,
  canRead,
  checkGate,
  effectiveAccess,
  type Gate,
  gateIsRead,
  type Level,
  mayGrant,
  mayGrantMap,
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

Deno.test("billing is owner-only through every door", () => {
  // preset
  assertEquals(PRESETS.admin.settings_billing, "none");
  // stored override — even a hand-edited database row cannot grant it
  const admin = effectiveAccess("admin", "admin", { settings_billing: "edit" });
  assertEquals(admin.settings_billing, "none");
  // grant — not even by an admin who somehow shows edit on it
  assertFalse(mayGrant("admin", { settings_billing: "edit" } as Record<string, Level>, "settings_billing", "view"));
  // ...but an owner may
  assert(mayGrant("owner", {} as Record<string, Level>, "settings_billing", "edit"));
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

Deno.test("billing cannot be granted to anyone by anyone but an owner", () => {
  const admin = effectiveAccess("admin", "admin", null);
  // sanitizeAccess drops it at the door...
  assertFalse("settings_billing" in sanitizeAccess({ settings_billing: "view" }));
  // ...and even if it reached the resolver, effectiveAccess ignores it for a non-owner.
  assertEquals(effectiveAccess("user", "admin", { settings_billing: "edit" }).settings_billing, "none");
  assertFalse(mayGrant("admin", admin, "settings_billing", "view"));
});
