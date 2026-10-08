// The commit trailers release-ci copies into What's New, and the holds it applies first.
//
// THE RULE THIS SERVES (CLAUDE.md, "What's New changelog"): the words of a release note are
// always written by a PERSON — in the commit's `Release-note:` trailer, or by a hand INSERT for
// work with no commit. release-ci copies the trailer WORD FOR WORD; nothing generates, summarises
// or rewrites an entry. So everything here either accepts the person's text as it stands or
// refuses it with a reason; nothing in this file edits a title.
//
// THE TRAILERS (the final paragraph of the commit message, the same block as Co-Authored-By):
//
//     Release-note: feature: Estimates can now carry a second contact      (or `fix: ...`)
//     Release-section: Contacts                                            (optional)
//     Release-detail: Add a co-buyer from the contact card; both get it.   (optional)
//     Projects: 3f2a9c1e                                                   (optional, repeatable)
//     Co-Authored-By: ...
//
//   or `Release-note: none` when nothing a builder sees changed.
//
//   * Release-note: `feature` or `fix` (release_notes.kind, 045), then the title: ONE line of
//     10-120 characters, no URL (the beta address never goes in a note; tell people directly).
//   * Release-section: the product area chip the Support page draws first on the line
//     (release_notes.section, 114; rendered upper-case, so "Contacts" shows as CONTACTS). Free
//     text by design (114 is not an enum): letters, digits ("3D Design" is a real area), spaces
//     and & / + -, with at least one letter. release-ci reuses an existing section's spelling
//     when only the case differs, so the chips group, and marks a section no note has used
//     before as `newSection` in its result, so a misspelt chip is seen in the run summary.
//   * Release-detail: the optional longer line under the title (release_notes.detail), up to 1000
//     characters, no URL.
//   * Projects: a Projects item id, whole or its first 8+ hex characters (the drawer's "copy ref"),
//     comma- or space-separated, up to 10. release-ci moves each to On Beta when switched on.
//
// THE PUBLIC REPO: a trailer is public the moment it is pushed. Never put a builder's name, a slug,
// or anything about pricing in one. The holds below keep such a note out of What's New; they
// cannot take it back out of git history.
//
// Pure functions only (no I/O, no jsr:/npm: imports): releaseTrailer.test.ts runs in preflight's
// dependency-free `_shared` group.

export type ReleaseKind = "feature" | "fix";
export type ReleaseNote = { kind: ReleaseKind; title: string; section: string | null; detail: string | null };
export type ParsedTrailers = {
  /** null = no Release-note trailer at all; "none" = the author said no note. */
  note: ReleaseNote | "none" | null;
  /** Why the release trailers cannot be used, as a FIXED sentence (never echoes the text). */
  refused: string | null;
  /** Projects refs, normalised to lowercase hex without dashes, 8-32 characters, de-duplicated. */
  projects: string[];
  /** Projects tokens that were not a uuid or an 8+ hex prefix (or past the 10th). */
  badProjects: number;
};

export const TITLE_MIN = 10;
export const TITLE_MAX = 120;
export const DETAIL_MAX = 1000;
export const SECTION_MAX = 32;
export const PROJECTS_MAX = 10;

const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;
const CONTINUATION = /^[ \t]+\S/;
// http(s)://, www., or a bare host on a TLD a product URL would use (structurestudio.app, x.com).
const URLISH = /(?:https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:app|com|net|org|io|dev|co|us)\b)/i;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// A letter or digit first ("3D Design"), at least one letter somewhere (a bare "2026" is no area).
const SECTION_SHAPE = /^(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9 &/+-]*$/;

/** Length in characters (code points), not UTF-16 units, so an accent counts once. */
const chars = (s: string) => Array.from(s).length;

/**
 * The commit's trailer block as [key, value, continuationLines] triples, or [] when it has none.
 *
 * Git's shape, kept strict: the LAST paragraph of a message that has more than one, and only when
 * every line in it is `Key: value` or an indented continuation of the line above. A last paragraph
 * that is prose (or the subject of a one-paragraph message) carries no trailers.
 */
export function trailerBlock(message: string): Array<[string, string, number]> {
  const text = String(message ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const paras = text.split(/\n[ \t]*\n/).filter((p) => p.trim() !== "");
  if (paras.length < 2) return [];
  const lines = paras[paras.length - 1].split("\n");
  const out: Array<[string, string, number]> = [];
  for (const line of lines) {
    if (CONTINUATION.test(line) && out.length) {
      const last = out[out.length - 1];
      last[1] = `${last[1]} ${line.trim()}`.trim();
      last[2] += 1;
      continue;
    }
    const m = TRAILER_LINE.exec(line);
    if (!m) return [];
    out.push([m[1].toLowerCase(), m[2].trim(), 0]);
  }
  return out;
}

/** Turn a Projects token into lowercase hex (8-32), or null when it is not a uuid / uuid prefix. */
export function projectRef(token: string): string | null {
  const t = String(token ?? "").trim().toLowerCase();
  const hex = t.replace(/-/g, "");
  if (!/^[0-9a-f]{8,32}$/.test(hex)) return null;
  // Dashes are allowed only where a uuid has them (8-4-4-4-12), so "3f2a9c1e-1b2c" is a prefix
  // and "3f2a-9c1e" is not.
  if (t.includes("-") && t !== uuidShape(hex)) return null;
  return hex;
}
function uuidShape(hex: string): string {
  const cuts = [8, 12, 16, 20];
  let out = "";
  let at = 0;
  for (const c of cuts) {
    if (hex.length <= c) break;
    out += hex.slice(at, c) + "-";
    at = c;
  }
  return out + hex.slice(at);
}

/** The inclusive uuid range a hex prefix covers — PostgREST cannot `like` a uuid column. */
export function uuidPrefixRange(hex: string): { lo: string; hi: string } | null {
  const h = projectRef(hex);
  if (!h) return null;
  const fmt = (x: string) => `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  return { lo: fmt(h.padEnd(32, "0")), hi: fmt(h.padEnd(32, "f")) };
}

/** Parse the release trailers of one commit message. Never edits the person's words. */
export function parseReleaseTrailers(message: string): ParsedTrailers {
  const block = trailerBlock(message);
  const notes = block.filter(([k]) => k === "release-note");
  const sections = block.filter(([k]) => k === "release-section");
  const details = block.filter(([k]) => k === "release-detail");

  const projects: string[] = [];
  let badProjects = 0;
  for (const [, v] of block.filter(([k]) => k === "projects")) {
    for (const tok of v.split(/[\s,]+/).filter(Boolean)) {
      const ref = projectRef(tok);
      if (!ref || projects.length >= PROJECTS_MAX) { badProjects++; continue; }
      if (!projects.includes(ref)) projects.push(ref);
    }
  }
  const out = (note: ParsedTrailers["note"], refused: string | null): ParsedTrailers => ({ note, refused, projects, badProjects });

  if (!notes.length) {
    return out(null, sections.length || details.length ? "Release-section or Release-detail without a Release-note trailer." : null);
  }
  if (notes.length > 1) return out(null, "More than one Release-note trailer.");
  const [, value, cont] = notes[0];
  if (/^none$/i.test(value)) return out("none", null);
  const m = /^(feature|fix)[ \t]*:[ \t]*(.*)$/i.exec(value);
  if (!m) return out(null, "Release-note must be `feature: <title>`, `fix: <title>` or `none`.");
  const kind = m[1].toLowerCase() as ReleaseKind;
  const title = m[2].trim();
  if (cont) return out(null, "The Release-note title must be one line.");
  if (CONTROL.test(title)) return out(null, "The Release-note title has a control character.");
  if (chars(title) < TITLE_MIN || chars(title) > TITLE_MAX) {
    return out(null, `The Release-note title must be ${TITLE_MIN}-${TITLE_MAX} characters.`);
  }
  if (URLISH.test(title)) return out(null, "The Release-note title has a URL or web address in it.");

  if (sections.length > 1) return out(null, "More than one Release-section trailer.");
  let section: string | null = null;
  if (sections.length) {
    section = sections[0][1].trim();
    if (sections[0][2] || chars(section) < 2 || chars(section) > SECTION_MAX || !SECTION_SHAPE.test(section)) {
      return out(null, `Release-section must be a product area of 2-${SECTION_MAX} characters, such as Designer, Contacts or 3D Design.`);
    }
  }
  if (details.length > 1) return out(null, "More than one Release-detail trailer.");
  let detail: string | null = null;
  if (details.length) {
    detail = details[0][1].trim();
    if (CONTROL.test(detail)) return out(null, "The Release-detail has a control character.");
    if (!detail || chars(detail) > DETAIL_MAX) return out(null, `The Release-detail must be 1-${DETAIL_MAX} characters.`);
    if (URLISH.test(detail)) return out(null, "The Release-detail has a URL or web address in it.");
  }
  return out({ kind, title, section, detail }, null);
}

// ── Holds ────────────────────────────────────────────────────────────────────────────────
// CLAUDE.md: commercial and internal-posture changes are NOT release notes (the 2026-07-26 rule:
// announcing a pricing change tells every builder to go and look). A note that mentions money is
// held for a person to read; it is never published by a machine.
const PRICING = /\b(prices?|priced|pricing|costs?|costing|billing|billed|discounts?|discounted|margins?|fees?)\b/i;
const MONEY = /\$\s?\d/;

/** Why this text must be held for a person, or null. The reason names the WORD, never a builder. */
export function heldReason(text: string): string | null {
  const t = String(text ?? "");
  const m = PRICING.exec(t);
  if (m) return `mentions pricing ("${m[1].toLowerCase()}")`;
  if (MONEY.test(t)) return "mentions a dollar amount";
  return null;
}

/** Lowercase, every run of non-letters/digits collapsed to one space: words stand alone. */
function words(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Builder rows -> the strings a note must not contain. Slugs both as written and with their
 *  hyphens read as spaces; names as written. Anything under 4 characters is dropped, because a
 *  short slug on word boundaries would still hold ordinary words. */
export function builderNeedles(rows: Array<{ client_id?: string | null; names?: Array<string | null | undefined> }>): string[] {
  const out = new Set<string>();
  for (const r of rows || []) {
    for (const s of [r.client_id, ...(r.names || [])]) {
      const w = words(s ?? "");
      if (chars(w) >= 4) out.add(w);
    }
  }
  return [...out];
}

/** Does the text name a builder? Whole words only ("acme" never matches "acmesheds" or "macme").
 *  Returns a boolean on purpose: the caller must never be able to echo WHICH name matched, because
 *  the answer is written to public Actions logs. */
export function namesBuilder(text: string, needles: string[]): boolean {
  const hay = ` ${words(text)} `;
  return (needles || []).some((n) => n && hay.includes(` ${n} `));
}

/** For duplicate_title: the same words, whatever the case or spacing. */
export function normTitle(t: string): string {
  return String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A full commit sha (sha1 or sha256), lowercase hex. */
export function isFullSha(s: unknown): s is string {
  return typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}
