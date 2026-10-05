// A REP'S OWN PRICE FOR A LINE — the server half (a builder's request, migration 277).
//
// The ask, from the builder: a salesperson with the right permission changes the charge on any line
// right in the Designer — up for an extra-large rough opening, down to close a sale — and the
// customer's quote shows the new number as that line's price. Not a "Custom" fee, not a "Discount":
// silent. A pre-priced item pre-fills the field with its list price.
//
// WHO. The `price_override` area in _shared/access.ts. Owners always; admins by preset; nobody else
// until an owner or admin ticks it on for them in Settings → Team. There is no floor: a rep may go
// as low as they like. Both are Carolyn's open decision and this is the safe default until she
// answers; a floor would be one clamp in applyPriceOverrides below.
//
// TRUST. The body is attacker-controlled on an endpoint the public anon key reaches, so the field
// is only ever HONOURED for a caller submit-estimate has verified holds the area (or a platform
// operator who may write). Everyone else has it stripped and logged — see step 2c there. Where the
// numbers came FROM is guarded too: the designer sends the prices stored on the design, and since
// migration 277 PART 3 save_design stores them only from someone holding the area, so a shopper's
// share-link save cannot plant one for the next owner's submit to carry. This module never decides
// who may; it only parses what arrived and applies what was allowed.
//
// WHAT IS KEPT. The catalog amount the rep replaced is kept on the line's provenance as `listAmount`
// and written into designs.estimate_lines, so an under-priced quote can always be audited against
// the list. It is never printed: every document, email and customer screen reads named fields
// (name, desc, qty, amount), and the CRM payload never sees provenance at all.

import { round2 } from "./estimateLines.ts";

/** A line can be priced at most this much per unit — the same order of sanity bound the designer
 *  applies, so a stray keystroke cannot put a seven-figure line on a customer's quote. */
export const PRICE_OVERRIDE_MAX = 1_000_000;
/** More entries than any real design has lines; anything beyond is ignored, never an error. */
export const PRICE_OVERRIDE_MAX_ROWS = 500;
const ROW_KEY_MAX = 300;

/**
 * The body's `priceOverrides` — `[{ rowKey, amount }]`, unit dollars — read defensively into a map.
 * A malformed entry is DROPPED, never refused: a shopper must never be blocked by a field they did
 * not knowingly send, and a rep's bad entry should cost that one line its override, not the quote.
 * Amounts are clamped to [0, PRICE_OVERRIDE_MAX] and rounded to cents. A later entry for the same
 * key wins, the way a map assignment would in the browser.
 */
export function parsePriceOverrides(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const e of raw.slice(0, PRICE_OVERRIDE_MAX_ROWS)) {
    if (!e || typeof e !== "object") continue;
    const { rowKey, amount } = e as { rowKey?: unknown; amount?: unknown };
    if (typeof rowKey !== "string" || !rowKey || rowKey.length > ROW_KEY_MAX) continue;
    // Only a real number or a numeric string. Number(null), Number("") and Number(true) are all
    // finite, and none of them is a price anybody typed.
    if (!(typeof amount === "number" || (typeof amount === "string" && amount.trim() !== ""))) continue;
    const n = Number(amount);
    if (!Number.isFinite(n)) continue;
    out.set(rowKey, round2(Math.min(PRICE_OVERRIDE_MAX, Math.max(0, n))));
  }
  return out;
}

/** The provenance fields this module reads and writes. submit-estimate's lineProv entries carry
 *  more; only these matter here. */
export type OverrideProv = { kind?: string; rowKey?: string; listAmount?: number };

/**
 * Apply the allowed overrides to the finished lines, in place. Call it once every line exists and
 * its list amount is final (credits baked into the building line) and BEFORE the
 * percentage-of-the-quote pass, so those lines are worked out on what the customer is charged.
 *
 * A line takes an override only when its provenance carries a rowKey that is in the map and it is
 * not one of the deferred percentage lines (`isDeferred`). Lines that must never take one — tax,
 * discounts, delivery, custom options, "(included)" $0 lines, percentage lines — are simply never
 * given a rowKey where they are built. An unknown key matches nothing and is ignored.
 *
 * The amount replaces the line's UNIT price; qty never changes. Where the description spells the
 * list rate ("72 ft of wall at $2.00 per foot", "… billable @ $5.00/ft"), that figure is rewritten
 * to the new one, because a description quoting the old rate beside a different price would hand
 * the customer the list price the rep chose not to show. The building's description is the
 * declined-item credit breakdown, which opens with the original building price, so it is dropped:
 * the rep's figure replaces the whole computed amount.
 *
 * Returns how many lines took an override.
 */
export function applyPriceOverrides(
  // deno-lint-ignore no-explicit-any
  lines: any[],
  // deno-lint-ignore no-explicit-any
  prov: Map<any, OverrideProv>,
  overrides: Map<string, number>,
  // deno-lint-ignore no-explicit-any
  isDeferred: (line: any) => boolean,
): number {
  if (!overrides.size) return 0;
  let applied = 0;
  for (const line of lines) {
    const p = prov.get(line);
    if (!p || !p.rowKey || !overrides.has(p.rowKey)) continue;
    if (isDeferred(line)) continue;
    const list = Number(line.amount) || 0;
    const next = overrides.get(p.rowKey) as number;
    p.listAmount = round2(list);
    line.amount = next;
    if (p.kind === "building") {
      line.description = "";
    } else if (typeof line.description === "string" && line.description) {
      line.description = line.description.split(`$${list.toFixed(2)}`).join(`$${next.toFixed(2)}`);
    }
    applied++;
  }
  return applied;
}
