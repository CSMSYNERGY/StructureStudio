// The library's look rules (migration 339), shared by portal-settings (a builder's own entries) and
// admin-catalog (the StructureStudio templates), so the two can never accept different looks. The same
// rule as 339's public.library_look_ok, so a look this accepts the database accepts.

export type Category = "cladding" | "door" | "window";
export type Look = Record<string, unknown>;

export const LIBRARY_CATEGORIES: readonly Category[] = ["cladding", "door", "window"];
export const CLADDING_PROFILES: readonly string[] = ["panel", "lap", "vinyl", "batten", "agpanel"];
export const DOOR_STYLES: readonly string[] = ["auto", "plank", "zbrace", "xbrace", "rollup", "american", "basic", "classic", "dutch"];
export const ENTRY_NAME_MAX = 60;
export const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`, "i");
export const isLibraryId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
// ── Looks ──────────────────────────────────────────────────────────────────────────────────
/** The seven built looks a door made from a photo is drawn over (343's door_looks_base_chk). */
export const DOOR_LOOK_BASES: readonly string[] = ["plank", "zbrace", "xbrace", "american", "basic", "classic", "dutch"];
const LOWER_UUID_RE = new RegExp(`^${UUID}$`);
/**
 * The cleaned look, or null. The same rule as 339's library_look_ok (345's for a door that names one of
 * the builder's own looks), so a look this accepts the database accepts. Canonical: a lap course only
 * when set, a window grid only as a pair. `doorLook` lets a door look carry a doorLookId (a builder's
 * entry made from a photo); it is never set for a StructureStudio template, which is everyone's.
 */
export function cleanLook(category: Category, raw: unknown, opts: { doorLook?: boolean } = {}): Look | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).filter((k) => r[k] !== undefined);
  if (category === "cladding") {
    if (keys.some((k) => k !== "profile" && k !== "exposureIn")) return null;
    const profile = String(r.profile ?? "");
    if (!CLADDING_PROFILES.includes(profile)) return null;
    if (r.exposureIn == null || r.exposureIn === "") return { profile };
    const n = Number(r.exposureIn);
    if (profile !== "lap" || !Number.isFinite(n) || n < 3 || n > 12) return null;
    return { profile, exposureIn: Math.round(n * 100) / 100 };
  }
  if (category === "door") {
    if (keys.some((k) => k !== "doorStyle" && !(opts.doorLook && k === "doorLookId"))) return null;
    const s = String(r.doorStyle ?? "");
    if (r.doorLookId !== undefined) {
      const id = r.doorLookId;
      return typeof id === "string" && LOWER_UUID_RE.test(id) && DOOR_LOOK_BASES.includes(s) ? { doorStyle: s, doorLookId: id } : null;
    }
    return DOOR_STYLES.includes(s) ? { doorStyle: s } : null;
  }
  if (keys.some((k) => k !== "liteRows" && k !== "liteCols")) return null;
  if (r.liteRows == null && r.liteCols == null) return {};
  const rows = Number(r.liteRows), cols = Number(r.liteCols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || rows > 8 || cols < 1 || cols > 8) return null;
  return { liteRows: rows, liteCols: cols };
}
/** The same look, as a key for "is this the same look?" (order-independent). */
export const lookKey = (look: Look): string => JSON.stringify(Object.keys(look).sort().map((k) => [k, look[k]]));

/** A builder's name for an entry: trimmed, spaces collapsed, 1 to 60 characters; null if empty. */
export function cleanName(raw: unknown, max = ENTRY_NAME_MAX): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? null : s;
}

/** A builder's door entry made from a photo (345): it names one of their own looks. */
export const isDoorLookEntry = (look: unknown): boolean =>
  !!look && typeof look === "object" && typeof (look as Record<string, unknown>).doorLookId === "string";

/** What a door row or a window row draws for a look (the values 339's trigger writes). */
export function rowValuesFor(category: "door" | "window", look: Look): Record<string, unknown> {
  if (category === "door") return { door_style: String(look.doorStyle ?? "auto") };
  return { lite_rows: look.liteRows ?? null, lite_cols: look.liteCols ?? null };
}

// What the browser gets for a template.
// deno-lint-ignore no-explicit-any
export const templateOut = (r: any) => ({
  id: r.id, category: r.category, slug: r.slug, name: r.name, description: r.description ?? null,
  searchTerms: Array.isArray(r.search_terms) ? r.search_terms : [], look: r.look ?? {},
  recolourable: r.recolourable !== false, leaves: r.leaves ?? null, thumbUrl: r.thumb_url ?? null,
  status: r.status, version: r.version, sortOrder: r.sort_order ?? 0,
});
