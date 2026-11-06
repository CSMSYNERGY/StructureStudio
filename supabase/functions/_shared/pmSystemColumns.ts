// CREATED AND REQUESTOR ARE NOT DATA — they are the row, read back.
//
// Carolyn 2026-11-01: "I need to see all the dates things were added. this should be a static
// field and not changeable. I also need to see who added it. ... Created is already a static
// field in bugs and feature requests. both also say CLIENT ... I want the title of it changed
// to requestor and then if ahsan creates something it is from him, or if I do it is from me.
// I need the created date in Ongoing projects as well and all of this in the roadmap and
// support."
//
// It LOOKED static and was not. "Created" was an ordinary `date` column on four boards: a cell
// anyone could retype, filled in by mirrorToProjects for a client submission and by
// defaultValues for a hand-added card — so the roadmap board had no such column at all, and
// nothing anywhere connected the cell to `pm_items.created_at`. "Client" was an ordinary text
// column holding the builder's slug, blank for everything the team added itself.
//
// So both are now SYNTHETIC columns served on EVERY board, derived on read from the row
// (`created_at` / `source_created_at`, `created_by_email`, the linked submission) and written
// into the item's `values` under reserved ids. Three consequences worth knowing:
//   * They cannot be edited, renamed, reordered or deleted — `sanitizeValues` rebuilds a write
//     against the board's REAL pm_columns, so a reserved id is dropped before it reaches the
//     database, and the browser marks them `readOnly` so no editor ever opens.
//   * They need no backfill and can never drift from the row they describe.
//   * Their ids are the SAME on every board, which is the one place the overlay's per-board
//     uuid remapping (pmOverlay.ts) is not needed.
//
// The id prefix `sys_` cannot collide with a pm_columns uuid.

export const PM_SYS_CREATED = "sys_created";
export const PM_SYS_REQUESTOR = "sys_requestor";

/** Reserved ids, for callers that need to refuse or allow them in bulk. */
export const PM_SYSTEM_COLUMN_IDS: ReadonlySet<string> = new Set([PM_SYS_CREATED, PM_SYS_REQUESTOR]);

export type PmSystemColumn = {
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  width: number;
  system: true;
  readOnly: true;
};

// `date` and `text`, deliberately, rather than two new types: the table engine, the WHEN date
// filter, sorting and search already know those two shapes, and `readOnly` is the only new
// thing any of them has to learn. Created leads every board (it is what she scans for) and
// Requestor follows it.
export function pmSystemColumns(): PmSystemColumn[] {
  return [
    { id: PM_SYS_CREATED, name: "Created", type: "date", settings: {}, width: 118, system: true, readOnly: true },
    { id: PM_SYS_REQUESTOR, name: "Requestor", type: "text", settings: {}, width: 170, system: true, readOnly: true },
  ];
}

// deno-lint-ignore no-explicit-any
type Row = any;

const who = (email: string) => (email.includes("@") ? email.split("@")[0] : email);

/**
 * The date the thing was ADDED, as YYYY-MM-DD.
 *
 * `source_created_at` (migration 352) is the escape hatch for history we did not make: the 21
 * items imported from monday.com carry their ORIGINAL monday creation date there, because
 * `pm_items.created_at` for those rows is 2026-08-27 — the day of the import — and reading the
 * import date as "created" would have silently rewritten three months of history on the day
 * this shipped. Nothing writes that column except the backfill; for every row born here it is
 * null and `created_at` is the truth.
 */
export function pmCreatedOn(item: Row): string | null {
  const raw = item?.source_created_at || item?.created_at;
  if (!raw) return null;
  const s = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * WHO asked for it — one short name for the cell, not a sentence (`originOf` in
 * portal-projects writes the sentence for the item drawer).
 *
 * Order is most-specific-first, the same order and the same reasoning as `originOf`: a linked
 * submission names a real person who was using a real product, while a monday id only says
 * "this was imported", which is also true of rows with a better answer to give.
 *
 * `names` maps a lower-cased operator email to that person's roster name, so a card Ahsan
 * added reads "Ahsan" and not "ahsan". An email we have no roster row for degrades to its
 * local part rather than printing a whole address into a 170px cell.
 */
export function pmRequestorOf(item: Row, sub: Row | null, names?: Map<string, string>): string {
  if (sub) {
    const name = String(sub.submitter_name || "").trim() || who(String(sub.submitter_email || "")).trim();
    // Cross-app rows (migration 161) carry no tenant at all, so the person's name is the
    // whole answer there; a builder's own report keeps falling back to the slug, which is
    // what the retired "Client" column held and what triage reads.
    return name || String(sub.client_id || "").trim() || "Client";
  }
  const by = String(item?.created_by_email || "").trim();
  if (item?.release_note_id || by === "roadmap") return "Roadmap";
  if (by === "expo-runway") return "Expo Runway";
  if (by) {
    const n = names ? names.get(by.toLowerCase()) : undefined;
    return (n || "").trim() || who(by);
  }
  if (item?.monday_item_id) return "monday.com";
  return "";
}

/**
 * The two derived cells for one item, ready to merge over its stored `values`.
 *
 * MERGED OVER, never under: a retired "Created"/"Client" cell can still sit in the jsonb of an
 * older row (migration 352 drops the COLUMNS and deliberately leaves the values alone, so the
 * change is reversible), and those keys are different ids anyway. What this must not do is let
 * a stored key win over the derived one under a reserved id.
 */
export function pmSystemValues(item: Row, sub: Row | null, names?: Map<string, string>): Record<string, unknown> {
  return {
    [PM_SYS_CREATED]: pmCreatedOn(item),
    [PM_SYS_REQUESTOR]: pmRequestorOf(item, sub, names) || null,
  };
}

/** One item with its derived cells applied. */
// deno-lint-ignore no-explicit-any
export function pmWithSystemValues(item: Row, sub: Row | null, names?: Map<string, string>): any {
  if (!item) return item;
  return { ...item, values: { ...(item.values || {}), ...pmSystemValues(item, sub, names) } };
}

/**
 * A whole list, with the submissions looked up by id.
 *
 * `subsById` is what the caller got back from ONE `in(...)` read over feedback_submissions —
 * per-item lookups would be 47 round trips on the Feature Requests board.
 */
// deno-lint-ignore no-explicit-any
export function pmDecorateItems(items: Row[], subsById: Map<string, Row>, names?: Map<string, string>): any[] {
  return (items || []).map((it) =>
    pmWithSystemValues(it, (it?.feedback_submission_id && subsById.get(String(it.feedback_submission_id))) || null, names)
  );
}
