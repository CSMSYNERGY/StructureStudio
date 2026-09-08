// KEEPING THE PROJECTS ROSTER IN STEP WITH SETTINGS → TEAM.
//
// Carolyn, 2026-09-02: "the user in the structure studio and the board should be the same,
// and a user will be added to the board if they are added in the structure studio
// subaccount." Before this the two lists were not connected in any way — no trigger on
// client_users or pm_people across 210 migrations, no shared column, nothing — so they had
// simply drifted: structure-studio's Team held four people, two of whom (a driver and a
// sales rep) appeared on no board at all.
//
// ── WHY NOT A DATABASE TRIGGER ───────────────────────────────────────────────────────────
// It was the obvious shape and it is the wrong one, for three reasons that are all about
// this codebase rather than about triggers in general:
//   * No audit actor. Every pm_* write in this product is either admin_audit'd or
//     pm_activity'd, and a trigger has no idea who was holding the session.
//   * client_users has no email column, so a trigger would need security definer reach into
//     auth.users just to name the person.
//   * Changing it needs a migration, where an edge-function module is unit-tested and read
//     in review.
// And remove_user already carries exactly this shape of code — a block cleaning up the two
// references to a person that "live OUTSIDE client_users, neither protected by a foreign
// key". pm_people is the third. It belongs beside them.
//
// ── SCOPE ────────────────────────────────────────────────────────────────────────────────
// Callers must only invoke this for an INTERNAL tenant (migration 169's internal_account).
// pm_people is one global list with no client_id: mirroring a builder's staff into it would
// put a customer's employees on CSM Synergy's own board. portal-commissions establishes that
// once, up front, and these functions trust it — they cannot check it themselves, because by
// the time you have a userId the tenant is no longer in the argument list.

import { canRead, type Level } from "./access.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export type SyncOutcome =
  | { kind: "linked"; personId: string }     // an existing row now points at this login
  | { kind: "created"; personId: string }    // a new roster row
  | { kind: "refreshed"; personId: string }  // already correct; name kept current
  | { kind: "conflict"; personId: string };  // that login is already on ANOTHER row

/**
 * Put this person on the Projects roster, or refresh the row they already have.
 *
 * ⚠️ FIND-THEN-INSERT, never a blind upsert, because `pm_people.user_id` is UNIQUE with no
 * foreign key. A login already claimed by a different roster row is a CONFLICT, not an
 * error to throw: add_person has always answered that case with a 409 ("Someone with that
 * login is already on the list"), and a team add must not fail wholesale because of it — the
 * person really was added to the tenant, and reporting otherwise would send an admin looking
 * for a failure that did not happen.
 */
export async function syncRosterMember(
  admin: Admin,
  p: { userId: string; email?: string | null; fullName?: string | null },
): Promise<SyncOutcome> {
  const name = (p.fullName || "").trim()
    || (p.email ? String(p.email).split("@")[0] : "")
    || "Team member";
  const email = p.email ? String(p.email).toLowerCase() : null;

  // 1. Already linked to this login? Refresh the display name and leave everything else.
  const linked = await admin.from("pm_people").select("id").eq("user_id", p.userId).maybeSingle();
  if (linked.error) throw new Error(`pm_people read failed: ${linked.error.message}`);
  if (linked.data) {
    const up = await admin.from("pm_people")
      .update({ name, active: true, email, updated_at: new Date().toISOString() })
      .eq("id", linked.data.id);
    if (up.error) throw new Error(`pm_people update failed: ${up.error.message}`);
    return { kind: "refreshed", personId: linked.data.id };
  }

  // 2. An UNLINKED row with the same address — the login-less person somebody typed in by
  //    hand before this login existed. Adopt it rather than creating a duplicate, so their
  //    existing assignments stay attached to the same pm_people.id.
  if (email) {
    // Matched against a LOWERCASED needle, which is safe because both writers of this column
    // (add_person and save_person) lowercase on the way in. A row seeded before that — 148
    // copied its first four from app_operators.email — could in principle carry mixed case
    // and simply not match here; the cost is a second roster row rather than a wrong link,
    // which is the right way for this to fail.
    //
    // Ordered for the same reason resolveTenant's owner lookup is: this filter is NOT on a
    // primary key, so two login-less rows could share an address, and an unordered limit(1)
    // would adopt whichever one Postgres happened to return that time. `position` picks the
    // one nearest the top of the roster — the one a person looking at the screen would have
    // meant — and, more to the point, picks the SAME one every time.
    const byEmail = await admin.from("pm_people")
      .select("id, user_id").eq("email", email).is("user_id", null)
      .order("position", { ascending: true }).limit(1);
    if (byEmail.error) throw new Error(`pm_people read failed: ${byEmail.error.message}`);
    const hit = byEmail.data && byEmail.data[0];
    if (hit) {
      const up = await admin.from("pm_people")
        .update({ user_id: p.userId, name, active: true, updated_at: new Date().toISOString() })
        .eq("id", hit.id).is("user_id", null);          // re-check: another writer may have won
      if (up.error) return { kind: "conflict", personId: hit.id };
      return { kind: "linked", personId: hit.id };
    }
  }

  // 3. Nobody by that login or address — a new roster row, at the end. `max + 1024` is
  //    add_person's own convention; the column is a float precisely so a later drag can
  //    insert between two neighbours without renumbering the list.
  const maxRow = await admin.from("pm_people").select("position")
    .order("position", { ascending: false }).limit(1).maybeSingle();
  if (maxRow.error) throw new Error(`pm_people read failed: ${maxRow.error.message}`);
  const ins = await admin.from("pm_people")
    .insert({ name, email, user_id: p.userId, position: ((maxRow.data && maxRow.data.position) || 0) + 1024 })
    .select("id").single();
  if (ins.error) {
    // The UNIQUE index is the last word — another request may have inserted between the read
    // above and this write.
    const again = await admin.from("pm_people").select("id").eq("user_id", p.userId).maybeSingle();
    if (again.data) return { kind: "conflict", personId: again.data.id };
    throw new Error(`pm_people insert failed: ${ins.error.message}`);
  }
  return { kind: "created", personId: ins.data.id };
}

/**
 * Take this person off the roster.
 *
 * ⚠️ DEACTIVATE, NEVER DELETE. remove_person's own rule, and it is not politeness: assignments
 * live in `pm_items.values` as a bare array of pm_people.id, with no foreign key. Delete the
 * row and every card they were ever assigned renders a bare uuid instead of a name — and
 * migration 148 already had to rewrite those blobs once, from auth.users.id to pm_people.id.
 * Nobody should have to do that a second time to recover a name.
 *
 * A no-op when they were never on the roster, so a caller need not check first.
 */
export async function deactivateRosterMember(admin: Admin, userId: string): Promise<boolean> {
  const found = await admin.from("pm_people").select("id").eq("user_id", userId).maybeSingle();
  if (found.error) throw new Error(`pm_people read failed: ${found.error.message}`);
  if (!found.data) return false;
  const up = await admin.from("pm_people")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", found.data.id);
  if (up.error) throw new Error(`pm_people update failed: ${up.error.message}`);
  return true;
}

/** Should this person be ON the roster, given the access map Settings → Team resolved? */
export function wantsRoster(acc: Record<string, Level> | null | undefined): boolean {
  return !!acc && canRead(acc, "projects");
}
