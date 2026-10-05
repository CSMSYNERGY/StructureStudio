// admin-catalog link_owner: the row it writes must not let access survive a move or a role change.
// Run: deno test supabase/functions/_shared/linkOwnerRow.test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { effectiveAccess, PRESETS } from "./access.ts";
import { linkOwnerRow } from "./linkOwnerRow.ts";

/** What an upsert ON CONFLICT (user_id) leaves in the row: the old row, overwritten only by the
 *  columns the payload carries — exactly how PostgREST's merge-duplicates upsert behaves. */
const upsert = (old: Record<string, unknown>, payload: Record<string, unknown>) => ({ ...old, ...payload });
const accessOf = (r: Record<string, unknown>) =>
  effectiveAccess(r.role as string, r.title, r.access as Record<string, unknown> | null);

Deno.test("a login MOVED from another builder as a Sales Rep gets the Sales Rep preset, not its old admin grants", () => {
  // At builder A: an admin whose owner granted them the Billing switch, with a home lot at A.
  const atA = { user_id: "u1", client_id: "a", role: "admin", title: "admin", access: { settings_billing: "edit" }, location_id: "lot-at-a" };
  assertEquals(accessOf(atA).settings_billing, "edit");
  const atB = upsert(atA, linkOwnerRow({ client_id: "a", role: "admin" }, "u1", "b", "user"));
  assertEquals(atB.client_id, "b");
  assertEquals(atB.title, "sales_rep");
  assertEquals(atB.access, null);
  assertEquals(atB.location_id, null);
  assertEquals(accessOf(atB), effectiveAccess("user", "sales_rep", null));
  assertEquals(accessOf(atB).settings_billing, "none");
  assertEquals(accessOf(atB).settings_team, PRESETS.sales_rep.settings_team ?? "none");
  // The role-only payload this replaced would have carried all of it to B.
  const before = upsert(atA, { user_id: "u1", client_id: "b", role: "user" });
  assertEquals(accessOf(before).settings_billing, "edit");
});

Deno.test("an owner re-linked on the same builder as a Sales Rep is really demoted", () => {
  const owner = { user_id: "u2", client_id: "a", role: "owner", title: "owner", access: null };
  const after = upsert(owner, linkOwnerRow({ client_id: "a", role: "owner" }, "u2", "a", "user"));
  assertEquals(after.title, "sales_rep");
  assertFalse(Object.values(accessOf(after)).every((l) => l === "edit"), "still every area at edit");
  // Role-only, as before: title 'owner' with role 'user' resolved to PRESETS.owner.
  const before = upsert(owner, { user_id: "u2", client_id: "a", role: "user" });
  assert(Object.values(accessOf(before)).every((l) => l === "edit"));
});

Deno.test("a same-builder re-link at the same role leaves the owner's Team-screen choices alone", () => {
  const crew = { user_id: "u3", client_id: "a", role: "user", title: "crew_leader", access: { reports: "view" }, location_id: "lot-1" };
  const row = linkOwnerRow({ client_id: "a", role: "user" }, "u3", "a", "user");
  assertFalse("title" in row);
  assertFalse("access" in row);
  assertFalse("location_id" in row);
  assertEquals(upsert(crew, row), crew);
});

Deno.test("a brand-new link carries the title its role means", () => {
  assertEquals(linkOwnerRow(null, "u4", "a", "owner").title, "owner");
  assertEquals(linkOwnerRow(null, "u5", "a", "user").title, "sales_rep");
  assertEquals(linkOwnerRow(null, "u6", "a", "admin").title, "admin");
  assertEquals(linkOwnerRow(null, "u6", "a", "admin").access, null);
});
