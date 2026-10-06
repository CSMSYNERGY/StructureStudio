// Which QuickBooks company a stored mapping, or a pushed invoice, belongs to (migration 265).
//
// QuickBooks item ids are per-company: item 16 in one company's books has nothing to do with
// item 16 in another's. Before 265 a qbo_item_map row did not say which company it came from,
// so the only protection was qbo-oauth-callback wiping the map when client_settings.qbo_realm_id
// CHANGED. That compare missed the two ways a tenant ends up with no realm on file while its
// map survives: another account taking the company over (084's qbo_displace_realm nulls the
// realm and keeps the map on purpose) and an operator clearing the realm by hand. Connecting a
// different company after either one read as a first connect, nothing was wiped, and the old
// company's ids billed lines against whatever shared those ids in the new books: a
// wrong-but-plausible invoice, the worst outcome this code can produce.
//
// Every row now carries realm_id, and every reader keeps only the rows for the company it is
// talking to. A row from another company, or one nobody stamped, reads as NOT MAPPED. The push
// then stops with "unmapped: … then Retry", which is loud and fixable, never a wrong item.
//
// Pure: no imports, so the test can load it without a registry.

/** The mapping rows that name items in the QuickBooks company `realmId`.
 *
 *  No company (not connected, displaced, never connected) means NO rows, never "all of them":
 *  a mapping is only meaningful against the books it was picked from. A row with no realm_id
 *  (saved before 265 reached it) is likewise nobody's. Exact match only; realm ids are Intuit's
 *  opaque strings and are compared as given. */
export function mapRowsForRealm<T extends { realm_id?: string | null }>(
  rows: readonly T[] | null | undefined,
  realmId: string | null | undefined,
): T[] {
  if (typeof realmId !== "string" || realmId === "") return [];
  return (rows ?? []).filter((r) => r != null && r.realm_id === realmId);
}

/** True when an invoice already went into a QuickBooks company OTHER than the one on file now.
 *
 *  Unknown on either side is NOT "other": an invoice nobody stamped (one 265's backfill could not
 *  place) or a tenant with no company on file keeps the answer it always had, "already in
 *  QuickBooks". The answer only changes when both companies are known and differ. That invoice
 *  stays where it is: re-pushing it into the new books is a bookkeeper's call, not ours. */
export function pushedToOtherCompany(
  invoiceRealm: string | null | undefined,
  currentRealm: string | null | undefined,
): boolean {
  return typeof invoiceRealm === "string" && invoiceRealm !== ""
    && typeof currentRealm === "string" && currentRealm !== ""
    && invoiceRealm !== currentRealm;
}

/** An opaque stand-in for the company a page was loaded against, safe to hand the browser.
 *
 *  save_item_map stamps each row with the company on file WHEN SAVE IS PRESSED, but the item ids
 *  it is handed were picked from the list the page loaded earlier. A page left open across a
 *  company switch (another tab, or a teammate) could therefore write company A's item ids
 *  stamped as company B's, and the push would bill them: the wrong-but-plausible invoice the
 *  stamp exists to prevent. list_item_map hands the page this tag, the page sends it back with
 *  the save, and a save whose tag no longer matches the company on file is refused.
 *
 *  The first 12 hex characters of SHA-256 over the realm id, so the full realm id still never
 *  reaches the browser (qbo_status only shows it masked). Not a secret and not a security
 *  boundary, just a "same company?" check. No company gives null, and null only matches null. */
export async function companyTagOf(realmId: string | null | undefined): Promise<string | null> {
  if (typeof realmId !== "string" || realmId === "") return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(realmId));
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}
