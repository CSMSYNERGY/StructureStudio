// How long a builder's quotes stay good for — client_settings.quote_valid_days (migration 269).
//
// Carolyn, 2026-08-06 (Fathom 775681234, 1:00:07): the printed estimate should say "estimate good
// for X amount of days", per builder. The formal estimate PDF already printed a "Valid until" line,
// but at a fixed 30 days; this is the one place the per-builder number is read, cleaned and
// defaulted, so the PDF, the CRM estimate's expiry date and the Settings box cannot disagree about
// what "not set" or "out of range" means.
//
// THE READ NEVER THROWS AND NEVER FAILS ITS CALLER. Every reader is on a path that issues or
// re-prints a quote, and the setting is one line on the document: a missing row, a read error, or a
// function deployed a minute ahead of 269 (PostgREST answers the unknown column with 42703 /
// PGRST204) all print the default, which is exactly what every quote printed before 269.
//
// Deliberately dependency-free (no jsr:/npm: imports): quoteValidity.test.ts runs in the
// self-contained _shared group.

/** The column's default, and what every quote printed before migration 269. */
export const QUOTE_VALID_DAYS_DEFAULT = 30;
/** The column's CHECK, restated so the Settings save refuses with a sentence first. */
export const QUOTE_VALID_DAYS_MIN = 1;
export const QUOTE_VALID_DAYS_MAX = 365;

/** A stored value as the documents read it: a whole number in range, else the default. */
export function quoteValidDaysOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= QUOTE_VALID_DAYS_MIN && n <= QUOTE_VALID_DAYS_MAX ? n : QUOTE_VALID_DAYS_DEFAULT;
}

/**
 * What a Settings save writes. Blank (or null) puts the default back, since the column is NOT NULL
 * and "not set" means 30 anyway. A whole number from 1 to 365 is kept. Anything else returns null,
 * which the save turns into a refusal: a boolean is not a number of days (Number(true) is 1), and a
 * quiet 7.5 or 400 would print a date the builder never chose.
 */
export function parseQuoteValidDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return QUOTE_VALID_DAYS_DEFAULT;
  if (typeof raw === "string" && raw.trim() === "") return QUOTE_VALID_DAYS_DEFAULT;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= QUOTE_VALID_DAYS_MIN && n <= QUOTE_VALID_DAYS_MAX ? n : null;
}

/**
 * The tenant's setting, or the default. Its own small read rather than a column added to a
 * caller's settings select: naming quote_valid_days in submit-estimate's settings read, or in the
 * portal's boot read, would fail EVERY quote or every portal load if the function were deployed
 * before 269. Here that costs one line on a document, and only until the migration is applied.
 *
 * `ok` says whether the column could be read, so the Settings card can tell "30 because that is
 * the setting" from "30 because the database has no such setting yet".
 */
export async function readQuoteValidDays(
  // deno-lint-ignore no-explicit-any
  db: any,
  clientId: string,
): Promise<{ days: number; ok: boolean }> {
  try {
    const { data, error } = await db.from("client_settings")
      .select("quote_valid_days").eq("client_id", clientId).maybeSingle();
    if (error) return { days: QUOTE_VALID_DAYS_DEFAULT, ok: false };
    return { days: quoteValidDaysOf(data?.quote_valid_days), ok: true };
  } catch (_e) {
    return { days: QUOTE_VALID_DAYS_DEFAULT, ok: false };
  }
}
