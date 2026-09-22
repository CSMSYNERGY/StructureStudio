// THE LATE-SAVE GUARD for building_styles' 3D columns (2026-09-14).
//
// A style save can reach the server LONG after the browser gave up on it. Measured that day on a
// builder's connection: requests to the main Supabase hostname stalled for two minutes and then
// completed, and a stalled request cannot be cancelled once its bytes are in the socket. The
// portal gives up on a save after 25s and retries through a second hostname, so the same save can
// land twice, and an OLD save can land AFTER a newer one — silently putting back what the builder
// had replaced.
//
// ⚠️ VERSION, NOT CONTENT. The first cut compared the row's CONTENT with the content the save was
// edited from, and review (wf_5199a3e0-d65, upheld 2/2) broke it with A -> B -> A: upload photo b
// (stalls, its retry lands [a,b]), then remove b (lands [a]); the stalled original arrives with a
// base of [a], the row holds [a] again, the contents match, and the removed photo comes back. Only
// a version the row carries can tell "never changed" from "changed and changed back". Every
// portal save stamps `updated_at`, so that is the version.
//
//   row version === base version        -> nothing wrote since this save's base: WRITE
//   row content already === this save's  -> the same save landing twice: DUPLICATE, write nothing
//   otherwise                            -> something else wrote since: CONFLICT (409, send current)
//
// Pure and dependency-free so the edge function and its tests share one definition.

// A JSON encoding in which key ORDER cannot make two equal values compare unequal. Postgres jsonb
// reorders keys on the way out, so the value a browser sends and the value the database hands
// back are the same object in a different order. Undefined members are dropped (as JSON does) and
// a non-finite number encodes as null, matching what jsonb could ever have stored.
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") + "}";
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value);
}

// The media columns are nullable jsonb arrays of URLs; a style that never had photos reads NULL
// while the portal treats it as []. Normalised identically wherever content is compared.
export function mediaList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

// Two timestamps as the SAME instant, whatever their formatting. PostgREST prints timestamptz as
// "2026-09-14T12:48:21.123+00:00" while a browser may hold "…21.123Z"; a string compare would call
// every save a conflict. A missing or unparseable value never matches — including missing against
// missing — so "we do not know the version" can never pass as "unchanged".
export function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

export type GuardInput = {
  // What the caller last saw. Absent (undefined) = an unguarded caller: an older bundle, or the
  // operator ?admin=1 page. Those write unconditionally, exactly as before this existed.
  baseVersion: unknown;
  // The row's updated_at as just read. NULL for a row no save has ever stamped.
  currentVersion: unknown;
  // Every column this save writes, as it is now and as the save would leave it.
  columns: { current: unknown; next: unknown }[];
};

export type GuardDecision = "unguarded" | "write" | "duplicate" | "conflict";

export function guardDecision(input: GuardInput): GuardDecision {
  if (input.baseVersion === undefined) return "unguarded";
  // A never-stamped row and a caller who saw it unstamped (base null) agree; that is a first save.
  const unchanged = (input.baseVersion === null && (input.currentVersion === null || input.currentVersion === undefined))
    || sameInstant(input.baseVersion, input.currentVersion);
  if (unchanged) return "write";
  const same = input.columns.every((c) => canonicalJson(c.current) === canonicalJson(c.next));
  return same ? "duplicate" : "conflict";
}
