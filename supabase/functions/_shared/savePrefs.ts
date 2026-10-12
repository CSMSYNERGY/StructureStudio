// One person's own portal preferences (client_users.prefs, migration 165), as save_prefs in
// portal-settings keeps them. Pure, so the two rules that matter are unit-tested
// (savePrefs.test.ts) rather than trusted:
//
//   1. WHICH TAB CONTACTS OPENS ON (Carolyn 2026-10-12): "we need them to set the default of what
//      they want the default to be." contactsView is the contact list ("people"), the Design list
//      ("designs") or one pipeline ("p-<uuid>"). Only that shape is kept. A pipeline id is never
//      looked up: one that is later removed, or that belongs to another account (an operator's
//      prefs follow them into view-as), reads as "never picked" in the portal's own rule
//      (ssHubResolve), which is the right answer and needs no write.
//
//   2. A SAVE MERGES, IT DOES NOT REPLACE (2026-10-12). save_prefs used to write its whitelist-
//      rebuilt blob over the whole column, so a save that named one key wiped every key it did not
//      name: a screen that knows only some prefs (an older build of the portal, which production
//      runs until its next promotion) would erase another card's choice. Now a key the save NAMES
//      is decided by the save alone: kept when it passed its check, cleared when it did not (an
//      empty string or false is how a card clears one). A key it does NOT name keeps what is
//      stored. Stored values were written through this same whitelist, so they are copied as they
//      are; only listed keys are carried, so anything else in the column drops on the next save.

// Every key save_prefs keeps. A new per-user pref goes here AND gets its check in save_prefs, or
// the next save from any screen destroys it.
export const PREF_KEYS = ["designsView", "contactsView", "replyToEmail", "replyCopy", "emailSignature", "cardOrder"] as const;

const CONTACTS_VIEW_RE = /^(people|designs|p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// The contactsView to keep, or null to keep none.
export function cleanContactsView(v: unknown): string | null {
  return typeof v === "string" && CONTACTS_VIEW_RE.test(v) ? v.toLowerCase() : null;
}

// `clean`: what this save decided, already through save_prefs' checks. `raw`: the save's own body
// (which keys it NAMED). `stored`: the column as it is now. Returns the blob to write.
export function mergePrefs(
  clean: Record<string, unknown>,
  raw: Record<string, unknown>,
  stored: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...clean };
  const was = (stored && typeof stored === "object" && !Array.isArray(stored)) ? stored as Record<string, unknown> : {};
  for (const k of PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) continue;
    if (was[k] !== undefined && was[k] !== null) out[k] = was[k];
  }
  return out;
}
