// Who may see which customer, and what counts as "mine" (plan section 7).
//
// The CRM's contacts row scope is reused, not restated: canEdit / ownContactsOnly come from
// _shared/access.ts, and the per-row answer comes from public.crm_visible_contact_ids, the SAME
// predicate portal-settings' visibleContactIds and the 193 RLS policies run. If the meaning of
// contacts:'own' changes, it changes there and this follows.

import { canEdit, effectiveAccess, ownContactsOnly, ownPhoneOnly, type Level as AccessLevel } from "../../../supabase/functions/_shared/access.ts";
import type { Caller } from "./context";
import { must, type CallerContext, type Level } from "./db";

/**
 * May they see the TEAM's calls? The literal check SPEC section 2 asks for (rank puts own ==
 * view), through access.ts's ownPhoneOnly so the Worker, the portal and the realtime policy
 * cannot drift apart. It fails closed: anything but 'view' or 'edit' is "own only".
 */
export function isTeamLevel(level: Level): boolean {
  return !ownPhoneOnly({ phone: level as AccessLevel });
}

/** May they text a saved contact? contacts:'edit', or 'own' (which writes, narrowed per row). */
export function maySendToContacts(ctx: CallerContext): boolean {
  return canEdit({ contacts: ctx.contacts_level as AccessLevel }, "contacts");
}

/** Narrowed to the customers they own or follow? */
export function narrowedToOwn(ctx: CallerContext): boolean {
  return ctx.own_contacts_only || ownContactsOnly({ contacts: ctx.contacts_level as AccessLevel });
}

/**
 * Unknown numbers (no contact yet): contacts `view` or `edit` only. Someone limited to their own
 * customers sees an unknown number once it is saved and assigned to them (plan section 7).
 */
export function mayReadUnknownNumbers(ctx: CallerContext): boolean {
  return (ctx.contacts_level === "view" || ctx.contacts_level === "edit") && !narrowedToOwn(ctx);
}

/**
 * Which of these contact ids may the caller see? Fails CLOSED: a failed check throws (the
 * request answers `internal`) rather than falling back to "show everything", which would turn a
 * transient error into a silent widening (portal-settings' visibleContactIds posture).
 */
export async function visibleContactIds(c: Caller, ids: (string | null | undefined)[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (c.ctx.contacts_level === "none") return new Set();
  if (!narrowedToOwn(c.ctx)) return new Set(want);
  if (!want.length) return new Set();
  const data = must(
    await c.admin.rpc("crm_visible_contact_ids", { p_client_id: c.ctx.client_id, p_user_id: c.userId, p_ids: want }),
    "crm_visible_contact_ids",
  ) as string[] | null;
  return new Set((data ?? []).map(String));
}

// ── "mine" ──────────────────────────────────────────────────────────────────────────

export interface MineCallFacts {
  placed_by: string | null;
  answered_by: string | null;
  rang_user_ids: string[] | null;
  status: string;
  contact_owner: string | null;
}

/**
 * Plan section 7: a call is mine if I placed or answered it. A missed call and its voicemail
 * belong to the contact's assigned owner when there is one, otherwise to everyone the number
 * rang. A call still ringing counts for everyone it is ringing.
 */
export function callIsMine(userId: string, c: MineCallFacts): boolean {
  if (c.placed_by === userId || c.answered_by === userId) return true;
  const unanswered = c.status === "missed" || c.status === "voicemail" || c.status === "ringing";
  if (!unanswered) return false;
  if (c.contact_owner) return c.contact_owner === userId;
  return (c.rang_user_ids ?? []).includes(userId);
}

/** Phone level for one team member, from access.ts (the TS twin of SQL area_level_for). */
export function phoneLevelOf(row: { role: string | null; title: string | null; access: Record<string, unknown> | null }): Level {
  const eff = effectiveAccess(row.role, row.title, row.access) as Record<string, string | undefined>;
  const lvl = eff.phone;
  if (lvl === "own" || lvl === "view" || lvl === "edit") return lvl;
  // Until the `phone` area exists in access.ts, owners are still absolute (they always are).
  return row.role === "owner" ? "edit" : "none";
}

export function contactsLevelOf(row: { role: string | null; title: string | null; access: Record<string, unknown> | null }): Level {
  const eff = effectiveAccess(row.role, row.title, row.access) as Record<string, string | undefined>;
  const lvl = eff.contacts;
  return lvl === "own" || lvl === "view" || lvl === "edit" ? lvl : "none";
}
