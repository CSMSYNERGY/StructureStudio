/**
 * contactListPage.ts: one page of a tenant's live contacts for the portal's Contacts list, read
 * by operator-portal's get_portal for an operator's view-as (2026-10-06, batch B8).
 *
 * WHY. The Contacts list (portal/02-sales.jsx, LeadsTable) was built from designs and browsing
 * leads only, so a contact with neither appeared nowhere in it: a contact brought in from
 * GoHighLevel (migration 282), one saved from My Synergy Phone, one added by hand, or one whose
 * design was deleted. They opened as records and showed in the phone's search, but the list a
 * builder works from did not have them. The GoHighLevel import cannot run for real until it does.
 *
 * THE SAME READ ON BOTH PATHS. A builder's own portal reads this page straight from PostgREST
 * under RLS (crm_contacts' tenant policy, 154's area policy, 193's contacts:'own' rule), so
 * someone limited to their own customers gets exactly the contacts they can open. An operator's
 * view-as has no RLS to lean on (service role), so it comes through get_portal, the same audited
 * route the designs already take, and gets the tenant's whole list, as it does for designs.
 * CONTACT_LIST_PAGE and CONTACT_LIST_COLS are repeated in 02-sales.jsx (the browser cannot import
 * this file); contactListPage.test.ts fails the push if the two drift.
 *
 * NEWEST FIRST, BOUNDED. A GoHighLevel import can bring thousands of contacts, so the list asks
 * for one page and a total, never the whole table. Ordered by first_seen_at (a GoHighLevel row's
 * "date added", moved back by the import) and not updated_at, which every import and enrichment
 * stamps with the moment it ran: ordered by that, a whole import would sit above every real
 * customer on the day it ran. `id` breaks ties so a page boundary cannot swap two rows.
 *
 * READS ONLY, AND NAMES NOTHING IN A LOG. The caller audits the read as a count.
 */

/** Contacts per page. Under PostgREST's 1000-row cap, so a page can never come back short silently. */
export const CONTACT_LIST_PAGE = 500;

/** What a contact-only row shows: who, how to reach them, where they came from, and when. */
export const CONTACT_LIST_COLS = "id, name, phone, email, source, first_seen_at, created_at";

/** Far past any tenant's contact list. Bounds what a caller may ask for, not what a tenant may hold. */
export const CONTACT_LIST_MAX_FROM = 200_000;

export interface ContactListRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  first_seen_at: string | null;
  created_at: string | null;
}

/**
 * The `contactsFrom` a view-as request may carry: where the next page starts. Absent (or 0) means
 * the first page, which get_portal sends with everything else. Anything else must be a whole number
 * of rows inside the bound; a malformed value is refused rather than read as 0, so a broken "Show
 * more" cannot quietly answer the first page again forever.
 */
export function parseContactsFrom(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > CONTACT_LIST_MAX_FROM) {
    throw new Error("Invalid contactsFrom.");
  }
  return raw;
}

// deno-lint-ignore no-explicit-any
type Client = any;

/**
 * One page of the tenant's live contacts (merged_into is null), newest first, and how many there
 * are in all. `total` is what the list compares with the contacts it already holds to say how many
 * older ones are not loaded yet. Throws on a database error; get_portal treats this read as
 * additive and answers the designs without it.
 */
export async function readContactListPage(
  admin: Client,
  clientId: string,
  from: number,
): Promise<{ rows: ContactListRow[]; total: number }> {
  const { data, error, count } = await admin.from("crm_contacts")
    .select(CONTACT_LIST_COLS, { count: "exact" })
    .eq("client_id", clientId)
    .is("merged_into", null)
    .order("first_seen_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + CONTACT_LIST_PAGE - 1);
  // PGRST103 (HTTP 416): `from` is past the end, because contacts were merged since the last page.
  // That is the end of the list, answered as an empty page (which the portal reads as "no more"),
  // not an error that every later "Show more" would hit again.
  if (error && (error as { code?: string }).code === "PGRST103") return { rows: [], total: from };
  if (error) throw error;
  const rows = (data || []) as ContactListRow[];
  // A missing count (it should not happen with count=exact) is never read as "no more": the rows
  // in hand are the floor, so the list still shows them and simply offers nothing further.
  const total = typeof count === "number" ? count : from + rows.length;
  return { rows, total };
}
