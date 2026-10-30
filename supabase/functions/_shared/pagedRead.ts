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
// KEYSET PAGES, NOT OFFSETS (review, 2026-10-30). Each page is its own request, so its own snapshot.
// With offsets (range 0-999, then 1000-1999), a save that deletes a row the first page already read
// shifts every later row back by one, and the row that sat at offset 1000 is in neither page; one
// more row added further down evens the length out, so it even matches the head count and the
// browser's truncation guard passes a read with a stored row missing. Here every page starts after
// the last KEY the page before ended on, and the key is the table's unique key, which never changes
// on a row. A row that is there for the whole read is read exactly once, whatever is added or taken
// away around it. That departs from the plan's "a copy of readAll": pricingImport.ts's readAll still
// pages by offset (its bulk tests pin it byte-identical); it reads only inside its own import.
//
// attempt and isSqlstate are COPIES of attempt and isSqlstate in _shared/pricingImport.ts, which
// stays byte-identical. Fix a bug in both. countRows is the head count the browser checks a paged
// read against (the truncation guard).
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

/** Every row of one tenant's table, read in keyset pages so a catalog past 1000 rows is not cut
 *  short and a row is never skipped by a page boundary that moved. `key` is the table's unique
 *  key, one column or two (building_size_inclusions has no id: its key is size_id, item_key), and
 *  `cols` must name it. Rows come back in key order; sortRows puts them in a display order.
 *  Filters by client_id ONLY: no list of ids ever rides in a URL. */
export async function readAllPaged(sb: any, table: string, cols: string, key: string[], clientId: string): Promise<any[]> {
  const [k1, k2] = key;
  const page = async (narrow: (q: any) => any, by: string[]): Promise<any[]> => {
    let q = narrow(sb.from(table).select(cols).eq("client_id", clientId));
    for (const col of by) q = q.order(col);
    const { data, error } = await attempt(() => q.limit(READ_PAGE));
    if (error) throw error;
    const rows = data ?? [];
    const last = rows[rows.length - 1];
    if (last && by.some((c) => last[c] == null)) throw new Error(`readAllPaged: ${table} rows came back without their key (${by.join(", ")})`);
    return rows;
  };
  const out: any[] = [];
  let after: unknown = undefined;   // the last k1 read
  for (;;) {
    const rows = await page((q) => after === undefined ? q : q.gt(k1, after), key);
    out.push(...rows);
    if (rows.length < READ_PAGE) return out;
    const last = rows[rows.length - 1];
    if (k2 !== undefined) {
      // The page may have stopped inside one k1's rows: read the rest of them by k2 before going
      // past that k1 (a single k1 can hold more than a page).
      let after2 = last[k2];
      for (;;) {
        const rest = await page((q) => q.eq(k1, last[k1]).gt(k2, after2), [k2]);
        out.push(...rest);
        if (rest.length < READ_PAGE) break;
        after2 = rest[rest.length - 1][k2];
      }
    }
    after = last[k1];
  }
}

/** Rows in the order `order by c1, c2, …` gives them in Postgres, for the columns the callers sort
 *  on: numbers (sort_order) by value, uuids as their lowercase text (the byte order Postgres uses),
 *  NULLs last. A new array; the rows themselves are not copied. */
export function sortRows(rows: any[], order: string[]): any[] {
  const cmp = (a: unknown, b: unknown) => {
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const x = String(a), y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return [...rows].sort((a, b) => { for (const c of order) { const d = cmp(a[c], b[c]); if (d) return d; } return 0; });
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
