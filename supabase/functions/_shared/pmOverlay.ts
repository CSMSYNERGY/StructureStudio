// THE WORKING BOARD. Carolyn, 2026-09-08 48:49: "No, I don't want to do our things in bugs
// feature request or roadmap. I think we need another table for that", and at 48:00 the
// reason: "I'm tired of seeing completed in here."
//
// A board opts in by naming source boards in its own settings:
//
//     pm_boards.settings = { "overlay_from": ["bugs", "features"] }
//
// It then shows its OWN items plus every un-finished item from those boards. Nothing moves.
// That is not a shortcut, it is the requirement: a completed item has to drop off this table
// while staying on the board the client filed it on, never deleted and never archived — and
// move_items already refuses cross-board moves for the same reason.
//
// ⚠️ NO BOARD SETS THIS TODAY, so every existing board takes the early return in get_board
// and behaves exactly as before. The feature is inert until somebody opts a board in.
//
// The two things that can go wrong live here, as pure functions, because they are the parts
// that could put a value under the wrong key and they are testable without a session:
//   1. deciding which items are "finished" — see doneLabelIds
//   2. translating one board's column ids into another's — see columnIdMap

export type PmColumn = { id: string; board_id?: string; name: string; type: string; settings?: unknown };
export type PmItem = { id: string; board_id: string; name: string; values?: Record<string, unknown> | null };

/** The label ids on a status column that mean FINISHED. */
export function doneLabelIds(col: PmColumn | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!col || col.type !== "status") return out;
  const s = col.settings as { labels?: Array<{ id?: string; kind?: string }> } | undefined;
  for (const l of (s?.labels || [])) {
    // `kind` is the ONLY machine-readable answer, and reading label TEXT instead is the
    // Monday "Shipped" -> "Completed" rename lesson waiting to repeat. An untagged label
    // makes no claim and is therefore NOT done — the safe direction, because it leaves an
    // item visible on the working table rather than silently hiding it.
    if (l && typeof l.id === "string" && l.kind === "done") out.add(l.id);
  }
  return out;
}

/** Is this item finished, according to its own board's status column? */
export function isItemDone(item: PmItem, statusCol: PmColumn | null | undefined): boolean {
  const done = doneLabelIds(statusCol);
  if (!done.size || !statusCol) return false;
  const v = (item.values || {})[statusCol.id];
  return typeof v === "string" && done.has(v);
}

/** The first status column of a board, which is what a board's "state" means. */
export function statusColumnOf(columns: PmColumn[]): PmColumn | null {
  return columns.find((c) => c.type === "status") || null;
}

/**
 * src column id -> dest column id, matched on NAME + TYPE.
 *
 * ⚠️ EVERY BOARD SEEDS ITS OWN COLUMN UUIDS. Bugs' "Status" and Feature Requests' "Status" are
 * different rows with different ids and the same meaning, so ids cannot be compared across
 * boards and a value copied by id renders blank at best.
 *
 * Matching is on the pair, never the name alone: two columns can share a name and differ in
 * type (a date "Due" and a text "Due"), and writing one into the other puts a string where a
 * date belongs. FAILS CLOSED — an unmatched column is simply absent from the map, and
 * remapValues drops it rather than guessing.
 */
export function columnIdMap(srcColumns: PmColumn[], destColumns: PmColumn[]): Map<string, string> {
  const key = (c: PmColumn) => `${String(c.name || "").trim().toLowerCase()}::${c.type}`;
  const dest = new Map<string, string>();
  for (const c of destColumns) {
    const k = key(c);
    // First wins. A board with two identically named+typed columns is already ambiguous;
    // picking one deterministically beats picking the last one seen.
    if (!dest.has(k)) dest.set(k, c.id);
  }
  const out = new Map<string, string>();
  for (const c of srcColumns) {
    const d = dest.get(key(c));
    if (d) out.set(c.id, d);
  }
  return out;
}

/**
 * The choice ids INSIDE a status or dropdown column, mapped src -> dest by LABEL.
 *
 * ⚠️ RE-KEYING THE COLUMN IS ONLY HALF THE JOB, and missing this half shipped: every board
 * seeds its own choice ids too. Bugs' App column offers "Structure Studio" as `o_fa089f90`
 * and Feature Requests offers the same words as `o_ss`. Carry the value across on the column
 * id alone and the cell holds an id the destination column has never heard of, so it renders
 * BLANK, is invisible to that column's filter, and cannot be searched — which is exactly what
 * fourteen Feature Requests rows did.
 *
 * Matching is on the LABEL because that is the only thing two independently seeded boards
 * share. That is the same reasoning as `columnIdMap`, one level down — and it is why the
 * destination does NOT need to be seeded with a union of every source's ids, a workaround
 * that would rot the first time somebody renamed a label (the Monday rename lesson).
 *
 * FAILS CLOSED: an unmatched choice keeps its original id and renders blank, which is what it
 * did before. It is never guessed at, because a wrong status is worse than a missing one.
 */
export function choiceIdMap(srcCol: PmColumn | null | undefined, destCol: PmColumn | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!srcCol || !destCol) return out;
  const list = (c: PmColumn) => {
    const s = c.settings as { labels?: unknown; options?: unknown } | undefined;
    const arr = (Array.isArray(s?.labels) ? s?.labels : Array.isArray(s?.options) ? s?.options : []) as unknown[];
    return arr as Array<{ id?: unknown; label?: unknown }>;
  };
  const byLabel = new Map<string, string>();
  for (const o of list(destCol)) {
    const l = String(o?.label ?? "").trim().toLowerCase();
    const id = String(o?.id ?? "");
    if (l && id && !byLabel.has(l)) byLabel.set(l, id);
  }
  for (const o of list(srcCol)) {
    const l = String(o?.label ?? "").trim().toLowerCase();
    const id = String(o?.id ?? "");
    const d = l ? byLabel.get(l) : undefined;
    if (id && d && d !== id) out.set(id, d);
  }
  return out;
}

/**
 * Re-key one item's values through a column map, dropping anything unmappable — and re-key the
 * CHOICE ids inside status/dropdown cells too, since those are per-board as well.
 */
export function remapValues(
  values: Record<string, unknown> | null | undefined,
  map: Map<string, string>,
  srcColumns?: PmColumn[],
  destColumns?: PmColumn[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const srcById = new Map((srcColumns || []).map((c) => [c.id, c]));
  const destById = new Map((destColumns || []).map((c) => [c.id, c]));
  for (const [k, v] of Object.entries(values || {})) {
    const d = map.get(k);
    if (!d) continue;
    const sc = srcById.get(k), dc = destById.get(d);
    if (sc && dc && (sc.type === "status" || sc.type === "dropdown")) {
      const cm = choiceIdMap(sc, dc);
      if (cm.size) {
        // A dropdown cell may be multi, so an array is normal here and each entry maps alone.
        out[d] = Array.isArray(v)
          ? v.map((x) => cm.get(String(x)) ?? x)
          : (cm.get(String(v)) ?? v);
        continue;
      }
    }
    out[d] = v;
  }
  return out;
}

/** The slugs a board overlays, or [] when it is an ordinary board. */
export function overlaySlugs(board: { settings?: unknown } | null | undefined): string[] {
  const s = board?.settings as { overlay_from?: unknown } | undefined;
  const raw = s?.overlay_from;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim() && out.length < 8) out.push(v.trim());
  }
  return out;
}

/**
 * Build the foreign rows for an overlay board.
 *
 * Each returned row keeps its REAL id and its REAL board_id — the id is what every write is
 * keyed by. `values` is remapped for DISPLAY only.
 *
 * ⚠️ THIS COMMENT USED TO CLAIM THE REMAP COULD NOT MIS-KEY A WRITE, because update_item
 * resolves columns from the item's own board_id. That was wrong and it shipped: resolving the
 * columns correctly says nothing about which ids the BROWSER sends, and the browser sends the
 * ones it rendered — the destination board's. Not one of them matched, sanitizeValues returned
 * {}, and every edit on an overlay row was a silent no-op that returned 200 while the screen
 * showed the new value. update_item now takes a `fromBoardId` and refuses loudly rather than
 * dropping. Anything reading this file to add a second overlay surface must send it too.
 */
export function buildOverlayItems(args: {
  destColumns: PmColumn[];
  sources: Array<{ board: { id: string; slug: string; name: string }; columns: PmColumn[]; items: PmItem[] }>;
}): Array<PmItem & { overlay: true; home_board_id: string; home_board_slug: string; home_board_name: string }> {
  const out = [];
  for (const src of args.sources) {
    const map = columnIdMap(src.columns, args.destColumns);
    const statusCol = statusColumnOf(src.columns);
    for (const it of src.items) {
      if (isItemDone(it, statusCol)) continue;
      out.push({
        ...it,
        values: remapValues(it.values, map, src.columns, args.destColumns),
        overlay: true as const,
        home_board_id: src.board.id,
        home_board_slug: src.board.slug,
        home_board_name: src.board.name,
      });
    }
  }
  return out;
}
