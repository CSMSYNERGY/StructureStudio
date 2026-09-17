// The estimate line kinds a tenant can map to a QuickBooks item (qbo_item_map.line_kind).
//
// THREE copies of this list have to agree: the table's CHECK (newest migration that re-adds
// qbo_item_map_line_kind_check), this module (save_item_map's gate), and the portal grid's
// QBO_KINDS (portal/08-integrations.jsx). They did not. Migration 239 widened the CHECK to the
// kinds below and the grid grew a row for each, but save_item_map kept its own 11-kind set, so
// every mapping for wall_height, build_on_site, cladding, insulation, electrical,
// electrical_item and foundation was skipped as "unknown line kind" — and the grid only said
// "N skipped", so those lines kept billing against the fallback item with nobody told why.
// qboLineKinds.test.ts reads the other two copies and fails when either drifts from this one.
//
// Pure: no imports, so the test can load it without a registry.

export const QBO_LINE_KINDS = [
  "building", "paint", "roof", "door", "window", "ramp", "layout_item", "custom_option",
  "discount", "delivery", "fallback",
  // 239
  "wall_height", "build_on_site", "cladding", "insulation", "electrical", "electrical_item",
  "foundation",
] as const;

export type QboLineKind = typeof QBO_LINE_KINDS[number];

const KIND_SET: ReadonlySet<string> = new Set(QBO_LINE_KINDS);

export function isQboLineKind(kind: string): kind is QboLineKind {
  return KIND_SET.has(kind);
}
