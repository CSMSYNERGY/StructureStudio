// The portal's read of plans as data (_shared/accessPortal.ts, migrations 386 and 387).
//
// portal-billing adds `modules` to the entitlement, and only for a company whose rollout switch is
// on. The one rule this file holds: ANYTHING that is not a clean, enforced answer is null, and null
// means "the old rules". A failure must never hide a builder's tabs and never hand any out.
//
// Also pinned against the SHIPPED portal-billing source: the field is there, it comes from
// portalAccess, it is asked for `status` alone, and the only two things it may change are the
// `modules` field and the one gate rescue. accessGate_test.ts drives the real handler through both.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { accessFromAnswer, modulesFromAnswer, portalAccess } from "../accessPortal.ts";

Deno.test("an enforced answer comes back as the map", () => {
  const m = modulesFromAnswer({ enforced: true, modules: { contacts: "on", jack: "hidden", repairs: "locked", designer: "off" } });
  assertEquals(m, { contacts: "on", jack: "hidden", repairs: "locked", designer: "off" });
});

const MALFORMED: unknown[] = [
  null, undefined, "on", 7, [], {},
  { enforced: false, modules: { contacts: "on" } },
  { enforced: "true", modules: { contacts: "on" } },
  { enforced: 1, modules: { contacts: "on" } },
  { enforced: true },
  { enforced: true, modules: null },
  { enforced: true, modules: [] },
  { enforced: true, modules: {} },                              // an empty map would hide everything
  { enforced: true, modules: { contacts: "yes" } },             // a state the resolver never gives
  { enforced: true, modules: { contacts: true } },
  { enforced: true, modules: { contacts: "on", jack: null } },  // one bad tab spoils the whole answer
  { enforced: true, modules: { "Customer Hub": "on" } },        // not a catalogue-shaped key
  { enforced: true, modules: JSON.parse('{"__proto__":"on","contacts":"on"}') },
];

Deno.test("not enforced, or anything malformed, is null: the old rules", () => {
  for (const bad of MALFORMED) {
    assertEquals(modulesFromAnswer(bad), null, JSON.stringify(bad));
    assertEquals(accessFromAnswer(bad), null, JSON.stringify(bad));
  }
  // A malformed answer cannot open the gate either, whatever it says about granted.
  assertEquals(accessFromAnswer({ enforced: false, modules: null, granted: true }), null);
  assertEquals(accessFromAnswer({ enforced: true, modules: { contacts: "nope" }, granted: true }), null);
});

Deno.test("the returned map is a plain object with no inherited keys to trip on", () => {
  const m = modulesFromAnswer({ enforced: true, modules: { contacts: "on" } })!;
  assertEquals(Object.keys(m), ["contacts"]);
  assertEquals(m.constructor, Object);
});

Deno.test("granted is strictly true", () => {
  const base = { enforced: true, modules: { contacts: "on" } };
  assertEquals(accessFromAnswer({ ...base, granted: true }), { modules: { contacts: "on" }, granted: true });
  for (const g of [false, undefined, null, "true", 1, {}]) {
    assertEquals(accessFromAnswer({ ...base, granted: g })!.granted, false, JSON.stringify(g));
  }
});

Deno.test("portalAccess asks access_for_portal for the company, and passes a clean answer through", async () => {
  const calls: unknown[] = [];
  const admin = { rpc: (fn: string, args: unknown) => { calls.push([fn, args]); return Promise.resolve({ data: { enforced: true, modules: { contacts: "on" }, granted: true }, error: null }); } };
  assertEquals(await portalAccess(admin, "acme-sheds"), { modules: { contacts: "on" }, granted: true });
  assertEquals(calls, [["access_for_portal", { p_client_id: "acme-sheds" }]]);
});

Deno.test("a database error, a thrown call, a missing rpc and an empty company id are all null", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assertEquals(await portalAccess({ rpc: () => Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } }) }, "a"), null);
    assertEquals(await portalAccess({ rpc: () => { throw new Error("network"); } }, "a"), null);
    assertEquals(await portalAccess({ rpc: () => Promise.reject(new Error("timeout")) }, "a"), null);
    assertEquals(await portalAccess({}, "a"), null);
    assertEquals(await portalAccess(null, "a"), null);
    let asked = false;
    assertEquals(await portalAccess({ rpc: () => { asked = true; return Promise.resolve({ data: { enforced: true, modules: { contacts: "on" } }, error: null }); } }, ""), null);
    assert(!asked, "an empty company id must not reach the database");
  } finally {
    console.error = quiet;
  }
});

Deno.test("portal-billing: asked for status alone, one gate rescue, one entitlement field", async () => {
  const src = (await Deno.readTextFile(new URL("../../portal-billing/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(src.includes('import { portalAccess } from "../_shared/accessPortal.ts";'), "portal-billing no longer imports portalAccess");
  assert(src.includes('const access = action === "status" ? await portalAccess(admin, clientId) : null;'),
    "portal-billing no longer asks, for status alone, about the company on the request");
  // The rescue: locked only, and only on `granted`.
  assert(/if \(entState === "locked" && access && access\.granted\) \{\n    entState = "active";\n    reason = "assigned_plan";\n  \}/.test(src),
    "the assigned-plan gate rescue changed");
  const ent = src.slice(src.indexOf("const entitlement = {"), src.indexOf('if (action === "status") {'));
  assert(/\n    modules: \(access && entState !== "locked"\) \? access\.modules : null,\n  \};\n/.test(ent), "`modules` is not the entitlement's last field, or lost its locked rule");
  // The fields the portal reads today are all still there, untouched by the new one.
  for (const f of ["exempt,", "state: entState,", 'locked: entState === "locked",', "features,", "granted:", "paid:", "advancedMode:", "shedsOn:", "phoneOnly,"]) {
    assert(ent.includes(f), `the entitlement lost "${f}"`);
  }
  // Nothing else in the function reads the answer: `access.` appears in the rescue and the field only.
  const uses = src.split("\n").filter((l) => /\baccess\.(granted|modules)\b/.test(l) && !/^\s*\/\//.test(l));
  assertEquals(uses.length, 2, `something besides the rescue and the field reads the answer:\n${uses.join("\n")}`);
});
