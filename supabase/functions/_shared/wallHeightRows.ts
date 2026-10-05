// Wall-height rows per style: one hauled and one built-on-site row per increase (migration 272).
//
// A builder sells +12" as a normal hauled upgrade on the 8, 10 and 12 wide, and the same +12" on
// the 14 wide only as a building assembled on site (bug report 2026-10-02; Carolyn's rule from
// 2026-09-01: "if they build it on site ... allow them to raise the wall height more, but then it
// becomes a build on site building"). So an increase may now appear twice on a style, once with
// Built on site unticked and once ticked, and the two rows may NOT share a width. The width is
// what tells them apart: at any building width an increase resolves to at most one row, which is
// what the designer's resolveWallHeight and submit-estimate both rely on to price the same row.
//
// Pure and dependency-free, so `_shared/wallHeightRows.test.ts` imports it directly. The portal's
// Wall Height Upgrades card (portal/03-catalog.jsx) checks the same rule before it sends a save,
// so a builder reads the problem as a sentence rather than as a refused save; keep the two alike.
//
// ⚠️ THE PAIR SHIPS SWITCHED OFF. portal-settings allows the second row only while its secret
// WALL_HEIGHT_SITE_PAIRS is "on" (wallHeightListedTwice below is the rule while it is not). A
// designer from before 272 prices the FIRST row it finds for an increase, so a pair saved while
// production still runs one would preview one price and bill another. Switch it on once
// production runs the new resolveWallHeight: `supabase secrets set WALL_HEIGHT_SITE_PAIRS=on`,
// no redeploy, and it does not matter which batch's tree deployed portal-settings.

export type WallHeightRowShape = {
  deltaIn: number;
  buildOnSite: boolean;
  /** NULL = every width the style sells (a living default; portal writes are explicit since 174). */
  widthsFt: number[] | null;
};

/** The database's unique key past the client and style (272): one row per increase and flag. */
export function wallHeightKey(deltaIn: number, buildOnSite: boolean): string {
  return `${deltaIn}:${buildOnSite ? "site" : "haul"}`;
}

/**
 * The first reason this set of rows cannot be saved for one style, in plain words, or null.
 *
 * `rows` is the style's whole list AS IT WILL BE after the save: every row being written, and every
 * row the save leaves alone. `styleWidths` is what the style sells today; a NULL widthsFt reads as
 * all of them, and on a style with no sizes yet as "every width", which overlaps anything.
 *
 * Two rules, in this order:
 *   1. one hauled and one built-on-site row per increase, never two of the same kind;
 *   2. the two rows of one increase share no width.
 */
export function wallHeightClash(rows: WallHeightRowShape[], styleWidths: number[]): string | null {
  const seen = new Map<string, WallHeightRowShape>();
  for (const r of rows) {
    const k = wallHeightKey(r.deltaIn, r.buildOnSite);
    if (seen.has(k)) {
      return `+${r.deltaIn} in is listed twice${r.buildOnSite ? " as built on site" : ""}. ` +
        `An increase can be listed once for hauled buildings and once ticked Built on site.`;
    }
    seen.set(k, r);
  }
  for (const r of rows) {
    if (r.buildOnSite) continue;
    const site = seen.get(wallHeightKey(r.deltaIn, true));
    if (!site) continue;
    const shared = sharedWidths(r.widthsFt, site.widthsFt, styleWidths);
    if (shared === null) continue;
    const where = shared.length ? `${shared.join(", ")} ft wide` : "every width";
    return `+${r.deltaIn} in is offered both hauled and built on site at ${where}. ` +
      `Untick ${shared.length === 1 ? "that width" : "those widths"} on one of the two rows.`;
  }
  return null;
}

/**
 * The rule while the pair is switched off (WALL_HEIGHT_SITE_PAIRS not "on"): an increase is listed
 * once per style, hauled or built on site, never both, which is the rule from before 272. Same
 * `rows` as wallHeightClash, the whole list as it will be. The first reason, or null.
 */
export function wallHeightListedTwice(rows: WallHeightRowShape[]): string | null {
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.deltaIn)) return `+${r.deltaIn} in is listed twice. For now, list each increase once.`;
    seen.add(r.deltaIn);
  }
  return null;
}

// The widths two rows share, ascending; [] = they share "every width" (both NULL on a style with no
// sizes); null = they share none.
function sharedWidths(a: number[] | null, b: number[] | null, styleWidths: number[]): number[] | null {
  const all = [...new Set(styleWidths.map(Number).filter((w) => Number.isFinite(w)))].sort((x, y) => x - y);
  if (a === null && b === null && !all.length) return [];
  const wa = a === null ? (all.length ? all : null) : a.map(Number);
  const wb = b === null ? (all.length ? all : null) : b.map(Number);
  // One side NULL on a style with no sizes = every width: it shares whatever the other one lists.
  const both = wa === null ? (wb ?? []) : wb === null ? wa : wa.filter((w) => wb.includes(w));
  const out = [...new Set(both)].sort((x, y) => x - y);
  return out.length ? out : null;
}

/**
 * Which existing row each planned write lands on, so a save never collides with the unique key
 * half-way through. Returns one target per plan: an existing row's id, or null to insert.
 *
 * The key is (increase, built on site), and a save can legitimately MOVE keys between rows: tick
 * Built on site on the hauled +12 and untick it on the on-site +12 in one go, and writing the rows
 * one by one hits the key on the first update, because the other row still holds it. Nothing
 * outside this table points at a row's id (designs store the increase in inches, not a row), so the
 * fix is to write each plan onto the existing row that ALREADY holds its key:
 *   1. a plan whose key an existing row holds goes onto that row, so that write never moves a key;
 *   2. the rest go onto their own row if it is still free, else onto any free row, else insert.
 * A write in step 2 moves a row to a key no surviving row holds (step 1 would have claimed it), so
 * no write can collide, in any order. `pool` is the existing rows the save is rewriting (rows it
 * leaves alone or deletes are not in it); `plans` have already passed wallHeightClash, so no two
 * share a key.
 */
export function bindWallHeightWrites(
  pool: { id: string; deltaIn: number; buildOnSite: boolean }[],
  plans: { rid: string; deltaIn: number; buildOnSite: boolean }[],
): (string | null)[] {
  const holder = new Map(pool.map((r) => [wallHeightKey(r.deltaIn, r.buildOnSite), r.id]));
  const taken = new Set<string>();
  const out: (string | null)[] = plans.map((p) => {
    const id = holder.get(wallHeightKey(p.deltaIn, p.buildOnSite));
    if (id === undefined || taken.has(id)) return null;
    taken.add(id);
    return id;
  });
  const free = () => pool.find((r) => !taken.has(r.id))?.id;
  plans.forEach((p, i) => {
    if (out[i] !== null) return;
    const own = p.rid && pool.some((r) => r.id === p.rid) && !taken.has(p.rid) ? p.rid : free();
    if (own === undefined) return;   // no free row: insert
    taken.add(own);
    out[i] = own;
  });
  return out;
}
