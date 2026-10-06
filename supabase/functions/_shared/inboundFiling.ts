// Two small rules email-inbound files a customer's reply by. Pure (no env, no jsr:/npm: imports)
// so _shared/inboundFiling.test.ts can pin them. Importers: email-inbound only; deploy it when
// this file changes.
//
// WHY THEY EXIST (2026-10-07). Until reply copies became opt-in (repReplyTo.ts / emailSend.ts),
// every customer reply also reached the rep's own inbox, because the Reply-To header named them.
// That inbox copy quietly covered two gaps on the record:
//
//   1. A reply to a contact that was MERGED AWAY after the email went out. The c.<contactId>
//      token still names the old contact, crm_merge_contacts (migration 254) only moves the rows
//      that already exist, and every read in the product filters a merged contact out. The reply
//      was filed on a record nobody can open.
//   2. The FILES a customer attaches. email_inbound (migration 135) has no column for them, the
//      Resend fetch (rsGetReceivedEmail) returns text, html and headers only, and nothing writes
//      them to storage or crm_files. They were never on the record; only the inbox had them.
//
// With copies OFF by default the record is the only place most replies land, so (1) is now
// followed to the live contact, and (2) is said out loud on the reply itself until attachments
// are actually stored. Full attachment ingestion is a separate piece of work; when it lands,
// attachmentNote goes.

/** One crm_contacts row as followMerged needs it. */
export type ContactLink = { id: string; merged_into: string | null };

/**
 * The live contact a reply should be filed on: the token's contact, or, when that one was merged
 * into another, the contact it was folded into, following the chain at most `maxHops` steps.
 *
 * `lookup` reads ONE crm_contacts row and MUST be scoped to the tenant Stage A proved (the caller's
 * `.eq("client_id", clientId)`); nothing here widens it, so a merged_into that points outside the
 * tenant simply isn't found. Returns:
 *   - null when the token's own contact isn't found (exactly as before: nothing is linked);
 *   - the first contact on the chain with no merged_into;
 *   - otherwise the last contact that WAS found (a broken link, a loop, or a chain longer than
 *     maxHops), which is never worse than before, when the reply was filed on the token's contact.
 *
 * crm_merge_contacts refuses a tombstone at either end, so a real chain is short and has no loops;
 * the bound and the seen-set are there so a hand-edited row can't make a webhook spin.
 */
export async function followMerged(
  lookup: (id: string) => Promise<ContactLink | null>,
  id: string,
  maxHops = 5,
): Promise<string | null> {
  let cur = await lookup(id);
  if (!cur) return null;
  const seen = new Set<string>([cur.id]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = cur.merged_into;
    if (!next || seen.has(next)) return cur.id;
    const row = await lookup(next);
    if (!row) return cur.id;
    seen.add(row.id);
    cur = row;
  }
  return cur.id;
}

// The webhook's attachment descriptors carry a file name under one of these, depending on the
// provider (Resend: filename; Postmark: Name).
const NAME_KEYS = ["filename", "name", "Name", "file_name"] as const;
const MAX_NAMES = 5;
const MAX_NAME_LEN = 80;

function fileName(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  for (const k of NAME_KEYS) {
    const v = (entry as Record<string, unknown>)[k];
    if (typeof v === "string") {
      // Customer-supplied text going into the stored body: no control characters, no newlines,
      // and short enough that one silly name can't bury the reply.
      const clean = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
      if (clean) return clean.length > MAX_NAME_LEN ? clean.slice(0, MAX_NAME_LEN - 1) + "…" : clean;
    }
  }
  return "";
}

/**
 * How many files a reply carried, and the line that says they weren't kept, for the end of the
 * stored body_text (what the record and the conversation feed show). `attachments` is the
 * webhook's own list, whatever its shape; anything that isn't an array is no files.
 *
 * Every entry counts, inline ones too (a pasted photo is inline as well as a signature logo): an
 * honest line on a logo costs less than a silent loss of a site photo.
 */
export function attachmentNote(attachments: unknown): { count: number; note: string | null } {
  if (!Array.isArray(attachments) || attachments.length === 0) return { count: 0, note: null };
  const count = attachments.length;
  const names = attachments.map(fileName).filter(Boolean);
  const shown = names.slice(0, MAX_NAMES);
  const more = count - shown.length;
  const list = shown.length
    ? ": " + shown.join(", ") + (more > 0 ? ` and ${more} more` : "")
    : "";
  const one = count === 1;
  return {
    count,
    note: `[${count} attached file${one ? "" : "s"} ${one ? "wasn't" : "weren't"} kept${list}. ` +
      `Ask CSM Synergy if you need ${one ? "it" : "them"}.]`,
  };
}
