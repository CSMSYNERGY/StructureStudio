/**
 * contactTags.ts: a customer's tags (crm_contacts.labels, text[]), added and removed by a person on
 * the customer's record (portal-settings crm_contact_tag, 2026-11-11). Until then a tag could be
 * written by an import (381, 282) and by an automation (370's add_label), and read by automations,
 * but no screen showed one: Carolyn imported a file with a Tags column and asked where to see them.
 *
 * THE SAME RULES AS EVERY OTHER WRITER. A tag is trimmed and at most 60 characters (370's
 * `left(btrim(label), 60)`, the import's LEAD_CAPS.label). Tags compare without case, so "VIP" and
 * "vip" are one tag: adding one already there changes nothing, which also means no "tag added"
 * automation runs for it (365's trigger fires only on a tag that is new, compared the same way). A
 * typed "a, b; c" is three tags, the import's split, so a list pasted from a spreadsheet lands the
 * way the import would have put it.
 *
 * Pure: the handler reads the row, asks this what the new list is, and writes it back only when the
 * row is still the one it read.
 */

export const TAG_MAX_LEN = 60;
/** Far past what a person keeps on one customer; bounds a runaway, not a habit. */
export const TAGS_PER_CONTACT_MAX = 50;

const cut = (v: unknown) => String(v ?? "").trim().slice(0, TAG_MAX_LEN).trim();
const key = (s: string) => s.trim().toLowerCase();

/** The tags a typed value names: split on commas and semicolons, trimmed, capped, once each. */
export function tagsFromInput(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(/[,;]/)) {
    const s = cut(part);
    if (!s || seen.has(key(s))) continue;
    seen.add(key(s));
    out.push(s);
  }
  return out;
}

/** A stored list as text: anything that is not a non-blank string is dropped. */
export function storedTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

export type TagChange =
  | { ok: true; labels: string[]; added: string[]; removed: string[] }
  | { ok: false; code: "no_tag" | "too_many" };

/**
 * The list after adding `tags` (on) or removing them (off). Adding keeps the stored order and
 * spelling and appends what is new; removing drops every stored tag equal to one named, whatever
 * its case. `added` / `removed` say what really changed, so a no-op is visible to the caller.
 */
export function changeTags(current: unknown, tags: readonly string[], on: boolean): TagChange {
  const have = storedTags(current);
  const named = tags.map(cut).filter(Boolean);
  if (!named.length) return { ok: false, code: "no_tag" };
  if (on) {
    const keys = new Set(have.map(key));
    const added: string[] = [];
    for (const t of named) {
      if (keys.has(key(t))) continue;
      keys.add(key(t));
      added.push(t);
    }
    if (have.length + added.length > TAGS_PER_CONTACT_MAX) return { ok: false, code: "too_many" };
    return { ok: true, labels: have.concat(added), added, removed: [] };
  }
  const drop = new Set(named.map(key));
  const removed = have.filter((t) => drop.has(key(t)));
  return { ok: true, labels: have.filter((t) => !drop.has(key(t))), added: [], removed };
}

/** How the Changelog line words a list: the tags in order, or nothing. */
export function tagsText(labels: readonly string[]): string | null {
  return labels.length ? labels.join(", ") : null;
}
