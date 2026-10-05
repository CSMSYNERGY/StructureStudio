// "Offered on": which building styles a catalog door, window, ramp or vent is sold on (migration
// 272, fixture_items.style_ids).
//
// Feature request 2026-10-02: "I need my louvered vents to only be for greenhouse style
// buildings." Every catalog fixture was offered on every style, with no way to say otherwise. Now
// a fixture carries the styles it is sold on, the same shape window_color_ids gave windows their
// colours (119): NULL means every style, including any added later (the living default, and every
// row there was before 272); a list means exactly those. get_fixtures sends the list as style
// keys, and the designer's pickers offer the fixture only on those styles. Visibility only: a
// placed item still prices from the catalog, the internalOnly precedent.
//
// An EMPTY list is refused rather than stored. It would hide the item on every style while the
// catalog still shows it as active and priced, which is "Active unticked" said in a way nobody can
// see. A builder who wants it offered nowhere unticks Active.
//
// Pure and dependency-free, so `_shared/fixtureStyleIds.test.ts` imports it directly.
// portal-settings' validateFixtureRow reads the field with readStyleIds; save_fixture and
// import_fixtures then keep only this tenant's styles with keepTenantStyleIds, because the uuid[]
// column has no foreign key and another tenant's style id would sit there doing nothing.
// admin-catalog's create_client carries a template's lists into the new client with
// cloneStyleIds. Two importers: deploy portal-settings AND admin-catalog when this file changes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The words a save is refused with when no style is left ticked. */
export const NO_STYLE_TICKED =
  "tick at least one building style it is offered on (to stop offering it everywhere, untick Active instead)";

/**
 * The `styleIds` a caller sent, read into what fixture_items.style_ids should become.
 *   null              → { value: null }        every style
 *   an array          → { value: [ids] }       uuid-shaped, trimmed, de-duplicated, in order
 *   an empty array    → { err }                (also when nothing uuid-shaped is left)
 *   anything else     → {}                     ignored, the field is left as it is
 */
export function readStyleIds(raw: unknown): { value?: string[] | null; err?: string } {
  if (raw === null) return { value: null };
  if (!Array.isArray(raw)) return {};
  const ids: string[] = [];
  for (const x of raw) {
    const s = String(x ?? "").trim().toLowerCase();
    if (UUID_RE.test(s) && !ids.includes(s)) ids.push(s);
  }
  return ids.length ? { value: ids } : { err: NO_STYLE_TICKED };
}

/** The ids that are this tenant's styles, in the order sent. Empty means none of them were. */
export function keepTenantStyleIds(ids: string[], tenantStyleIds: Set<string>): string[] {
  return ids.filter((id) => tenantStyleIds.has(String(id).toLowerCase()));
}

/**
 * A template fixture's list as it should land on a client cloned from that template. style_ids
 * names the TEMPLATE's building_styles ids and the clone has its own, so each id goes through the
 * clone's old → new style map (admin-catalog's styleIdMap, the one the sizes use). Copied as it is,
 * the list would name another tenant's styles, get_fixtures would send no style keys, and the item
 * would be offered on no style at all, the template's own included.
 *
 * An id with no new style (that style was deleted from the template) is dropped. A list left with
 * nothing becomes null, every style, and `dropped` says so for the clone's counts: never [], which
 * is the "offered nowhere" portal-settings refuses to save.
 */
export function cloneStyleIds(
  ids: readonly unknown[],
  styleIdMap: ReadonlyMap<string, string>,
): { value: string[] | null; dropped: boolean } {
  const out: string[] = [];
  for (const x of ids) {
    const id = styleIdMap.get(String(x ?? ""));
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? { value: out, dropped: false } : { value: null, dropped: true };
}
