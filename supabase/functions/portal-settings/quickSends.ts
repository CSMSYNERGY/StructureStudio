// Quick sends in the portal: each person's saved messages, beside the CRM record's Email and SMS
// boxes. Carolyn 2026-09-30: "I think I want to call it quick sends, okay, for them to do quick
// sends on text and email, both of them". The vault's _Extras/My Synergy Phone Quick Sends Plan
// 2026-10-01.md, decision 1: "Email quick sends come later in the StructureStudio CRM Email tab
// and read the same list."
//
// THE SAME LIST AS MY SYNERGY PHONE. Migration 258's phone_quick_sends, keyed by (user_id,
// client_id), seeded once ever by phone_seed_quick_sends and counted by phone_quick_send_used,
// exactly as the phone-api Worker's routes/quickSends.ts does it. It is read HERE, not through
// the Worker, because the Worker's requireCaller refuses anyone whose phone access is none, and a
// CRM user without the phone still writes emails.
//
// NOTHING HERE SENDS. The portal's Insert fills the box; the person presses Send, and the email
// or text goes through crm_send_email / crm_send_sms with every one of their checks.
//
// EACH PERSON OWNS THEIR OWN LIST. The service role bypasses RLS, so both reads and the count are
// narrowed by hand to the caller's userId AND the resolved clientId, both from the verified
// session (resolveTenant), never from the body. The only body field is the one quick send's id,
// which the RPC matches against that same pair: someone else's id answers "not found", word for
// word what an id that does not exist answers. index.ts refuses an operator in view-as before
// either runs (the list would be the operator's own, seeded under the builder's account).
//
// Injected (`db` is the service-role client, or a stub in tests/phone/quickSends_test.ts), so
// every rule above is driven without a database.

import { isUuid } from "./phone.ts";

/** Far above the app's 100-per-person cap, so a list the starter set pushed past it shows whole (the Worker's LIST_LIMIT). */
export const QUICK_SEND_LIST_LIMIT = 500;
/** What the portal reads of each one. Sent as they are stored; the portal fills them in. */
export const QUICK_SEND_COLUMNS = "id, name, body, category, sort_order, usage_count";
/** The Worker's notFound sentence, word for word. */
export const QUICK_SEND_NOT_FOUND = "That quick send wasn't found.";
/** The view-as refusal (index.ts). */
export const QUICK_SENDS_VIEW_AS =
  "Quick sends belong to the person signed in, so they aren't available while you're viewing another account.";

export type QuickSendRow = {
  id: string;
  name: string;
  body: string;
  category: string | null;
  sort_order: number;
  usage_count: number;
};

/** One quick send as the portal sees it (the Worker's quickSendOut, without updated_at). */
export function quickSendOut(r: Partial<QuickSendRow>): QuickSendRow {
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    body: String(r.body ?? ""),
    category: typeof r.category === "string" ? r.category : null,
    sort_order: Number(r.sort_order) || 0,
    usage_count: Number(r.usage_count) || 0,
  };
}

/** The verified caller: the session's user and the tenant resolveTenant settled on. */
export type QuickSendCaller = { userId: string; clientId: string };

// deno-lint-ignore no-explicit-any
export type QuickSendDb = { rpc: (...a: any[]) => any; from: (...a: any[]) => any };

/**
 * quick_sends_list. The starter set first, once ever per person and team (phone_seed_quick_sends
 * claims a marker before it copies, so two first opens at once copy it once). That is the phone's
 * seed() rule: a nicety, not the list, so a failure is reported through `onSeedFailed` and the
 * person still gets what they have; the next open tries again. Then the list, in the person's
 * own order, and their full name for {my_name} (a failed name read costs only the fill-in).
 * → { quick_sends, my_name }, or { dbError } when the list itself could not be read.
 */
export async function readQuickSends(
  db: QuickSendDb,
  who: QuickSendCaller,
  onSeedFailed: (why: string) => Promise<void> | void,
): Promise<{ quick_sends: QuickSendRow[]; my_name: string } | { dbError: unknown }> {
  let failure: string | null = null;
  try {
    const { error } = await db.rpc("phone_seed_quick_sends", { p_user: who.userId, p_client: who.clientId });
    if (error) failure = String(error?.message ?? "unknown");
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
  }
  if (failure !== null) {
    try { await onSeedFailed(failure); } catch (_) { /* logging never costs the list */ }
  }

  const [list, me] = await Promise.all([
    db.from("phone_quick_sends").select(QUICK_SEND_COLUMNS)
      .eq("user_id", who.userId).eq("client_id", who.clientId)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: true })
      .limit(QUICK_SEND_LIST_LIMIT),
    // limit(1): one row per (user, tenant) by the table's own key, but a maybeSingle() that ever
    // met two would fail and take the name with it.
    db.from("client_users").select("full_name")
      .eq("user_id", who.userId).eq("client_id", who.clientId)
      .limit(1).maybeSingle(),
  ]);
  if (list?.error) return { dbError: list.error };
  const rows = Array.isArray(list?.data) ? list.data as Partial<QuickSendRow>[] : [];
  const name = me && !me.error ? String((me.data as { full_name?: unknown } | null)?.full_name ?? "").trim() : "";
  return { quick_sends: rows.map(quickSendOut), my_name: name };
}

/**
 * quick_send_used: "used N×", one Insert counted in the database (usage_count + 1 in one statement,
 * so two at once both count), and only on the caller's own row. Anything that is not a uuid cannot
 * be a quick send, so it is "not_found" before Postgres sees it, never a 22P02.
 */
export async function countQuickSendUse(
  db: QuickSendDb,
  rawId: unknown,
  who: QuickSendCaller,
): Promise<"counted" | "not_found" | { dbError: unknown }> {
  if (!isUuid(rawId)) return "not_found";
  const { data, error } = await db.rpc("phone_quick_send_used", { p_id: rawId, p_user: who.userId, p_client: who.clientId });
  if (error) return { dbError: error };
  return data === true ? "counted" : "not_found";
}
