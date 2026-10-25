// A builder's brand palette (migration 336, Carolyn 2026-10-25): "in the company settings I want
// to be able to add additional brand colors and then those colors to show in the forms as easy
// selections and also to show in the email as easy selection."
//
// ONE SHAPE, THREE READERS, like leadForms.ts: Settings → Branding edits the list, the form
// designer draws it as swatches under every color control, and the email editor draws the same
// swatches. Everything that reaches client_configs.brand_colors — or comes back out of it —
// goes through brandColorList first: a WHITELIST REBUILD, never a spread, so a key nobody
// designed cannot ride into a tenant's stylesheet or an email's HTML.
//
// Pure: no Deno, no network, so brandColors.test.ts runs offline.

export const BRAND_COLOR_MAX = 12;
export const BRAND_COLOR_NAME_MAX = 40;

export type BrandColor = { name: string; hex: string };

/** #RGB and #RRGGBB in, #RRGGBB upper-case out; anything else null.
 *
 *  Normalised on the way IN, not on the way out, so two spellings of one color
 *  ("#fff" and "#FFFFFF") can't both sit in a palette looking like two colors. Six digits only:
 *  an 8-digit #RRGGBBAA would lose its alpha silently in an email, where no inbox honours it. */
export function normalizeHex(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toUpperCase();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  return null;
}

/** Rebuild a palette from anything. A bad entry is DROPPED, not refused: the Branding card
 *  already stops a bad hex at the control, so a drop here means something hand-rolled the
 *  request — and half a palette is better than a 400 on an otherwise good branding save.
 *
 *  Duplicates collapse to the FIRST spelling, which keeps the swatch row honest: a row of
 *  twelve identical swatches is a palette nobody can use. */
export function brandColorList(v: unknown): BrandColor[] {
  if (!Array.isArray(v)) return [];
  const out: BrandColor[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const hex = normalizeHex((raw as Record<string, unknown>).hex);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ name: String((raw as Record<string, unknown>).name ?? "").trim().slice(0, BRAND_COLOR_NAME_MAX), hex });
    if (out.length >= BRAND_COLOR_MAX) break;
  }
  return out;
}
