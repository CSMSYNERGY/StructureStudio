// The client_users row admin-catalog's link_owner upserts (the operator console's "Link owner").
//
// Access is resolved from title + access (access.ts effectiveAccess), not from role alone, and an
// upsert that writes only `role` leaves both columns as they were. So a login MOVED here from
// another builder kept that builder's title, per-person overrides (an owner-granted Billing switch
// included) and home lot; and a same-builder role change kept the old title — an owner re-linked
// as a Sales Rep (role 'user', title 'owner') still resolved to PRESETS.owner, every area at edit.
//
// Whenever the row is new, moves builder, or changes role, it gets the title its role means
// (migration 100's backfill mapping) and no overrides. A same-builder re-link at the SAME role —
// e.g. to mint a fresh set-password link — leaves title and overrides alone, so the owner's
// Team-screen choices survive it.

export type LinkRole = "owner" | "admin" | "user";

export function linkOwnerRow(
  prior: { client_id?: string | null; role?: string | null } | null | undefined,
  userId: string,
  clientId: string,
  role: LinkRole,
): Record<string, unknown> {
  const moving = !!(prior && prior.client_id && prior.client_id !== clientId);
  const row: Record<string, unknown> = { user_id: userId, client_id: clientId, role };
  if (!prior || moving || prior.role !== role) {
    row.title = role === "owner" ? "owner" : role === "admin" ? "admin" : "sales_rep";
    row.access = null;
  }
  // The home lot is a builder_locations row of the OLD builder (234's FK cannot check the
  // tenant), so keeping it would make delivery measure from another company's lot.
  if (moving) row.location_id = null;
  return row;
}
