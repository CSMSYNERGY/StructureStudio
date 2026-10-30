// Reads of one tenant's rows in 1000-row pages, for every reader that must see a WHOLE catalog: the
// sizes table's size_table action (portal-settings) and the operator consoles' get_client_catalog
// and tenant clone (admin-catalog). Added with the sizes table, 2026-10-30.
//
// WHY. This project's PostgREST answers at most 1000 rows a read (db-max-rows), whatever limit() asks
// for, and says nothing when it cuts. Past 1000 inclusion rows an unpaged read drops the rest, the
// Excel template shows a dropped row as 0, and the importer then DELETES it on re-upload
// (pricingImport.ts). One fill-down in the sizes table across 210 sizes adds 210 rows, so a builder
// can cross 1000 in a minute.
//
// readAllPaged, attempt and isSqlstate are COPIES of readAll, attempt and isSqlstate in
// _shared/pricingImport.ts, which stays byte-identical (its bulk tests pin it). Fix a bug in both.
// countRows is the head count the browser checks a paged read against (the truncation guard).
//
// Dependency-free (the client is passed in). Importers: portal-settings (through pricingCells.ts)
// and admin-catalog. Deploy both when this file changes.

// deno-lint-ignore-file no-explicit-any

/** PostgREST answers at most 1000 rows a read (db-max-rows), so a table is read in pages. */
export const READ_PAGE = 1000;

/** A Postgres error carries a five-character SQLSTATE. Anything else did not come from the
 *  database: a gateway, a proxy or a dropped connection answered instead, and supabase-js puts
 *  that answer's body (an HTML error page, for one) into error.message with no code at all. */
export const isSqlstate = (c: unknown) => /^[0-9A-Z]{5}$/.test(String(c ?? ""));

/** Run a call, and retry it only when the database never answered. A read changes nothing, so
 *  sending it again is always safe; a write sent through here must be keyed on its own identity
 *  (pricing_cells_apply checks every size's version and starting values, so a resend after a
 *  first try that did commit comes back "duplicate"). A real Postgres error is NOT retried: it
 *  would say the same thing three times. */
export const attempt = async (run: () => any): Promise<{ data?: any; error: any }> => {
  let error: any = null;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, i * 400));
    try {
      const res = await run();
      if (!res?.error) return { data: res?.data, error: null };
      error = res.error;
    } catch (e) { error = e; }   // a dropped connection throws instead of answering
    if (isSqlstate(error?.code)) return { error };
  }
  return { error };
};

/** Every row of one tenant's table, read in pages so a catalog past 1000 rows is not cut short.
 *  `order` must end in a unique key (id, or the table's primary key), so no row sits on a page
 *  boundary twice or not at all. Filters by client_id ONLY: no list of ids ever rides in a URL. */
export async function readAllPaged(sb: any, table: string, cols: string, order: string[], clientId: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    let q = sb.from(table).select(cols).eq("client_id", clientId);
    for (const col of order) q = q.order(col);
    const { data, error } = await attempt(() => q.range(from, from + READ_PAGE - 1));
    if (error) throw error;
    const page = data ?? [];
    out.push(...page);
    if (page.length < READ_PAGE) return out;
  }
}

/** How many rows of one tenant's table exist, from an exact head count (no rows travel). `col`
 *  is any column the table has: building_size_inclusions has no id, so it is counted on size_id. */
export async function countRows(sb: any, table: string, col: string, clientId: string): Promise<number> {
  const { data, error } = await attempt(async () => {
    const res = await sb.from(table).select(col, { count: "exact", head: true }).eq("client_id", clientId);
    return { data: res?.count, error: res?.error ?? null };
  });
  if (error) throw error;
  if (typeof data !== "number") throw new Error(`no row count came back for ${table}`);
  return data;
}
