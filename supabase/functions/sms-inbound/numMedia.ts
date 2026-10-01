// How many photos came with an inbound text, and storing it without ever losing the text.
//
// My Synergy Phone (plan section 6, release 1): "a text that came with photos shows 'Photo received.
// Viewing photos arrives in release 2.' so nothing looks empty." A photo-only MMS has an EMPTY
// Body, so without this count the app would show a blank bubble and the builder would think the
// customer sent nothing. Twilio posts NumMedia on every inbound message; sms_messages.num_media
// (migration 254, `not null default 0`) is where it lands.

/** Twilio's NumMedia → a count we store. Twilio allows at most 10 media per message; anything
 *  that is not a whole number in 0..10 is treated as none rather than trusted. */
export function parseNumMedia(v: unknown): number {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0;
}

/** The PostgREST / Postgres codes for "that column does not exist (yet)". */
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

// deno-lint-ignore no-explicit-any
type Admin = any;
type InsertResult = { error: { code?: string; message?: string } | null; retriedWithoutMedia: boolean };

/**
 * Insert the inbound row WITH num_media, and if the database has not had migration 254 yet,
 * insert it again WITHOUT it.
 *
 * ⚠️ THE RETRY IS THE WHOLE POINT. This function and that migration ship separately, and a
 * customer's text is the one thing this webhook must never drop ("a customer's words are worth
 * more than our ability to file them" — the rule the Store block already follows). Deployed a
 * minute ahead of the migration, the first insert fails on the unknown column; without the
 * retry every inbound text in that minute is logged and lost. With it, the text is stored and
 * only the photo count is missing — the same answer as a text with no photos.
 *
 * Any other error is returned untouched for the caller's existing handling (23505 = a Twilio
 * retry of a message already stored, which the caller treats as success).
 */
export async function insertInbound(admin: Admin, row: Record<string, unknown>, numMedia: number): Promise<InsertResult> {
  const first = await admin.from("sms_messages").insert({ ...row, num_media: numMedia });
  if (!first.error || !MISSING_COLUMN.has(String(first.error.code ?? ""))) {
    return { error: first.error ?? null, retriedWithoutMedia: false };
  }
  const second = await admin.from("sms_messages").insert(row);
  return { error: second.error ?? null, retriedWithoutMedia: true };
}
