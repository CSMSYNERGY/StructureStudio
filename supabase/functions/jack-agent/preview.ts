// jack-agent: what a sheet or a sentence would change. Pure: no network, no database (preview_test.ts).
//
// Two inputs reach one shape. A price list arrives as ReadRows (sheet.ts); a sentence such as "every 8
// and 10 wide comes with one single door" arrives as rules. Both become Wanted lines, and diffAgainst
// compares those with the builder's table and answers two things:
//   preview  what the person is shown: the new number beside the old one, what looks wrong, what asks
//            a question, what was left alone;
//   payload  exactly what Approve will send, and nothing else. The server stores it and runs only it.
//
// Nothing here writes. Sizes the sheet doesn't mention are listed and left alone, a blank price box
// changes nothing, and text in a price box never becomes a number.

import { MAX_QTY, parsePrice, sizeLabel } from "../_shared/pricingCells.ts";
import { normStyle, parseFeet, type Problem, type ReadRow } from "./sheet.ts";

// ── The builder's table, as portal-settings' size_table and catalog answer it ─────────────────────

export interface TableStyle { id: string; label: string; active?: boolean }
export interface TableSize { id: string; style_id: string; label: string; width_ft: number; length_ft: number; base_price: number | null; active: boolean; updated_at: string }
export interface TableInclusion { size_id: string; item_key: string; included: boolean; qty: number }
export interface SizeTable { styles: TableStyle[]; sizes: TableSize[]; inclusions: TableInclusion[]; counts?: { sizes: number; inclusions: number }; rtpOn?: boolean }
export interface OptionColumn { key: string; label: string; section: string }

/** Real-Time Pricing owns the price column on this account, and the save route refuses any price. */
const RTP_WHY = "Real-Time Pricing sets prices on this account, so the old price stays";

/** Feet and inches the way the table and the Excel template write a door's size (fmtFtIn, 03-catalog). */
function fmtFtIn(inches: unknown): string {
  const n = Number(inches);
  if (!isFinite(n) || n <= 0) return "";
  const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100;
  if (ft === 0) return inch + '"';
  if (inch === 0) return ft + "'";
  return ft + "'" + inch + '"';
}

/** The option columns the sizes table shows. The server's twin of ssPricingColumns (03-catalog.jsx):
 *  no ramp and no partition wall, active fixtures only, and an unknown category reads as a door. */
// deno-lint-ignore no-explicit-any
export function columnsFromCatalog(cat: any): OptionColumn[] {
  const out: OptionColumn[] = [];
  for (const it of Array.isArray(cat?.items) ? cat.items : []) {
    if (!it || it.archived || it.key === "ramp" || it.key === "partitionWall") continue;
    out.push({ key: String(it.key), label: String(it.label ?? it.key), section: "Built-in options" });
  }
  const sections: Record<string, string> = { door: "Doors", window: "Windows", vent: "Vents", ramp: "Ramps" };
  for (const f of Array.isArray(cat?.fixtures) ? cat.fixtures : []) {
    if (!f || f.active === false || f.archived === true) continue;
    const size = f.width_in && f.height_in ? ` (${fmtFtIn(f.width_in)}x${fmtFtIn(f.height_in)})` : "";
    out.push({ key: String(f.id), label: `${f.name || "Item"}${size}`, section: sections[f.category || "door"] ?? "Other" });
  }
  return out;
}

// ── What a person sees ────────────────────────────────────────────────────────────────────────────

/** big_change: a price a sentence changed by more than BIG_CHANGE_SHARE either way (wantedFromRules). */
export type Flag = "below_smaller" | "above_bigger" | "far_from_neighbors" | "zero" | "not_offered" | "same_size_twice" | "reversed_size" | "goes_on_sale" | "big_change";

export interface PreviewRow {
  sizeId: string;
  label: string;
  isNew: boolean;
  price: { from: number | null; to: number | null } | null;
  cells: Record<string, { from: number; to: number }>;
  flags: Flag[];
  where: string | null;
}
export interface Question {
  id: string;
  kind: "style" | "zero";
  text: string;
  rows: number;
  options: { value: string; label: string }[];
  /** The option Jack would pick. A person still has to press it. */
  suggestion: string | null;
}
export interface Preview {
  styles: { id: string; label: string; rows: PreviewRow[] }[];
  columns: { key: string; label: string; section: string }[];
  counts: { changed: number; added: number; same: number; flagged: number; leftAlone: number; skipped: number };
  /** In a style the sheet covers, but not on the sheet: listed and left alone. */
  leftAlone: { style: string; label: string }[];
  skipped: Problem[];
  questions: Question[];
}

// ── What Approve sends ────────────────────────────────────────────────────────────────────────────

export interface CreateLine { id: string; styleId: string; label: string; width: number; length: number; price: number | null; cells: Record<string, number> }
export interface EditLine {
  id: string;
  label: string;
  base: string;
  from: { price?: number | null; cells?: Record<string, number> };
  to: { price?: number | null; cells?: Record<string, number> };
  /** Whether the size was offered before, so Undo can put that back too. */
  wasActive: boolean;
}
export interface Payload { creates: CreateLine[]; sizes: EditLine[] }

export interface Answers { styles?: Record<string, string>; zero?: string }

/** One size someone wants to be a certain way. `price` absent means leave it; null means not offered. */
export interface Wanted {
  styleId: string;
  width: number;
  length: number;
  price?: number | null;
  cells?: Record<string, number>;
  flags: Flag[];
  where: string | null;
}

// ── A sheet's rows → Wanted ───────────────────────────────────────────────────────────────────────

const NOT_OFFERED = /^(n\s*\/?\s*a|not\s+(offered|available)|none|unavailable|-+|–|—)$/i;
const CALL_FOR_PRICE = /\b(call|tbd|quote|ask|varies|custom)\b/i;
const YES = /^(yes|y|x|true|included|✓|✔)$/i;
const NO = /^(no|n|false|-+|–|—)$/i;

/** An option box: a whole number, a yes-word (included, keep the quantity on file), a no-word for 0, or
 *  a blank for "this sheet says nothing". Null means text we can't read, which changes nothing and is
 *  reported. Only a real thousands comma counts: "2, 1" isn't 21. */
export function readOptionCell(raw: string): number | "yes" | "leave" | null {
  const s = raw.trim();
  if (s === "") return "leave";
  if (YES.test(s)) return "yes";
  if (NO.test(s)) return 0;
  if (/^(\d{1,3}(,\d{3})+|\d+)$/.test(s)) {
    const n = Number(s.replace(/,/g, ""));
    return n <= MAX_QTY ? n : null;
  }
  return null;
}

/** A price box's number, in cents' worth of digits, or null when the text isn't plainly a price. parsePrice
 *  strips commas and spaces and hands the rest to Number(), which turns 4.200,00 into 4.2, "$4,200 $4,600"
 *  into 42004600 and 1e3 into 1000. So the shape is checked first. 4.200 could be either, and is refused.
 *  Rounded because a formula's cell arrives as 3300.0000000000005, and the card and the save must agree. */
function readPrice(text: string): number | null {
  if (!/^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text) || /^\$?\s*\d{1,3}\.\d{3}$/.test(text)) return null;
  const p = parsePrice(text);
  return p.ok && p.value !== null ? Math.round(p.value * 100) / 100 : null;
}

/** What a name on a sheet or in a sentence means on this account. An exact name wins, then a loose match
 *  when only one style fits it. "same" means two styles really carry that name (a hidden one counts), and
 *  "many" means the loose match fits more than one, so neither can be chosen for the person. */
function findStyle(table: SizeTable, name: string): TableStyle | "same" | "many" | null {
  const exact = name.trim().toLowerCase();
  const named = table.styles.filter((s) => s.label.trim().toLowerCase() === exact);
  const loose = table.styles.filter((s) => normStyle(s.label) === normStyle(name));
  if (named.length > 1) return "same";
  // A hidden style with the exact name doesn't quietly win over a live one with nearly that name.
  if (named.length === 1) return named[0].active === false && loose.some((s) => s !== named[0] && s.active !== false) ? "many" : named[0];
  if (loose.length === 1) return loose[0];
  return loose.length > 1 ? "many" : null;
}
const styleName = (s: TableStyle) => `${s.label}${s.active === false ? " (hidden)" : ""}`;

export interface RowsResolved {
  wanted: Wanted[];
  skipped: Problem[];
  questions: Question[];
  coveredStyleIds: Set<string>;
}

export function resolveRows(
  table: SizeTable, rows: ReadRow[], columnKeys: Set<string>, answers: Answers, suggestions: Record<string, string> = {},
): RowsResolved {
  const skipped: Problem[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.style, (counts.get(r.style) ?? 0) + 1);

  // A style the sheet names that isn't one of theirs asks a question. Styles come first (Carolyn,
  // 11-04, 36:48): Jack never adds one here, so the person skips those rows, or points them at a style
  // they do have, or adds it in Settings and checks again. A person's answer comes before any match.
  const styleOf = new Map<string, string | null>();
  const questions: Question[] = [];
  const options = [
    ...table.styles.map((s) => ({ value: s.id, label: `Use my ${styleName(s)}` })),
    { value: "skip", label: "Skip these rows" },
  ];
  for (const [name, n] of counts) {
    const answer = answers.styles?.[name];
    if (answer === "skip") { styleOf.set(name, null); continue; }
    if (answer && table.styles.some((s) => s.id === answer)) { styleOf.set(name, answer); continue; }
    const found = findStyle(table, name);
    if (found && typeof found === "object") { styleOf.set(name, found.id); continue; }
    styleOf.set(name, null);
    if (found === "same") {
      skipped.push({ where: "Your sheet", text: name, why: "more than one of your styles has this name (a hidden style counts). Rename one in Settings, then press Check again" });
      continue;
    }
    const hint = suggestions[name];
    const those = n === 1 ? "that row" : `those ${n} rows`;
    questions.push({
      id: `style:${name}`, kind: "style", rows: n, options,
      text: found === "many"
        ? `Your sheet has ${name}, and more than one of your styles could be that. Which one should ${those} go on, or should I skip ${n === 1 ? "it" : "them"}?`
        : `Your sheet has ${name} and you don't have that style. Skip ${those}, or use one you do have? To add it, make the style in Settings, then press Check again.`,
      suggestion: hint && table.styles.some((s) => s.id === hint) ? hint : "skip",
    });
  }

  // $0 means free in the designer. On Real-Time Pricing no price lands anyway, so it neither asks nor
  // flags; diffAgainst lists those prices as staying.
  const rtp = table.rtpOn === true;
  const keepZeros = answers.zero === "free" || rtp;
  const ZERO_WHY = answers.zero === "skip" ? "you said $0 isn't free, so the old price stays" : "left alone until you say whether $0 means free";

  // A sheet's size is the stored one when they round to the same number: a size stored as 10.6667 is the
  // 10.67 a sheet reads as. Worked out once, here, so every later step sees the stored size.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const exactSize = new Map(table.sizes.map((s) => [`${s.style_id}|${Number(s.width_ft)}|${Number(s.length_ft)}`, s]));
  const roundSize = new Map<string, TableSize>();
  for (const s of table.sizes) {
    const key = `${s.style_id}|${r2(Number(s.width_ft))}|${r2(Number(s.length_ft))}`;
    if (!roundSize.has(key)) roundSize.set(key, s);
  }
  // A yes-word means "included": keep the quantity on file, or 1 when there's none.
  const storedQty = new Map(table.inclusions.filter((i) => i.included).map((i) => [`${i.size_id}|${i.item_key}`, Number(i.qty)]));

  const wanted: Wanted[] = [];
  const covered = new Set<string>();
  const seen = new Map<string, Wanted>();
  // A price box that held back the old price, by size: a later row on the same size can overrule it.
  const priceSkips = new Map<string, Problem>();
  for (const r of rows) {
    const styleId = styleOf.get(r.style) ?? null;
    if (!styleId) continue;
    covered.add(styleId);
    const hit = exactSize.get(`${styleId}|${r.width}|${r.length}`) ?? roundSize.get(`${styleId}|${r.width}|${r.length}`);
    const width = hit ? Number(hit.width_ft) : r.width, length = hit ? Number(hit.length_ft) : r.length;
    const k = `${styleId}|${width}|${length}`;
    const w: Wanted = { styleId, width, length, flags: [], where: r.where };
    const text = r.priceText.trim();
    const price = readPrice(text);
    if (text === "") {
      // A blank price box changes nothing.
    } else if (NOT_OFFERED.test(text)) {
      w.price = null;
      if (!rtp) w.flags.push("not_offered");
    } else if (price !== null) {
      if (price === 0) {
        if (keepZeros) { w.price = 0; if (!rtp) w.flags.push("zero"); }
        else priceSkips.set(k, { where: r.where, text: `${sizeLabel(r.width, r.length)}: $0`, why: ZERO_WHY });
      } else {
        w.price = price;
      }
    } else {
      priceSkips.set(k, {
        where: r.where, text: `${sizeLabel(r.width, r.length)}: ${text.slice(0, 40)}`,
        why: CALL_FOR_PRICE.test(text) ? "says to call for a price, so the old price stays" : "isn't a price, so the old price stays",
      });
    }
    const cells: Record<string, number> = {};
    for (const [key, raw] of Object.entries(r.cells)) {
      if (!columnKeys.has(key)) continue;
      const q = readOptionCell(raw);
      if (q === "leave") continue;
      if (q === null) {
        skipped.push({ where: r.where, text: `${sizeLabel(r.width, r.length)}: ${raw.slice(0, 40)}`, why: "isn't a number of options, so that box stays" });
        continue;
      }
      cells[key] = q === "yes" ? (hit && storedQty.get(`${hit.id}|${key}`)) || 1 : q;
    }
    if (Object.keys(cells).length) w.cells = cells;

    // The same size twice on a sheet: the later row wins wherever it has a value, as it does in the
    // Excel upload, and says so. A later box that held the price back wins too, so the words on the
    // card are what gets written.
    if (w.price !== undefined) priceSkips.delete(k);
    const heldBack = text !== "" && w.price === undefined;
    if (w.price === undefined && !w.cells && !heldBack) continue;
    const before = seen.get(k);
    if (before) {
      if (w.price !== undefined || heldBack) { before.price = w.price; before.flags = w.flags; }
      if (w.cells) before.cells = { ...before.cells, ...w.cells };
      before.flags = [...new Set([...before.flags, "same_size_twice" as Flag])];
      before.where = r.where;
    } else {
      seen.set(k, w);
      wanted.push(w);
    }
  }

  // A $0 is a question, once for the whole sheet, about the sizes whose last word on the sheet is $0.
  // Counted after the rows, so a $0 a later row overrules doesn't ask, and a size listed twice counts once.
  const zeroSizes = [...priceSkips.values()].filter((p) => p.why === ZERO_WHY && !answers.zero).length;
  if (zeroSizes) {
    questions.push({
      id: "zero", kind: "zero", rows: zeroSizes, suggestion: "skip",
      text: `${zeroSizes} ${zeroSizes === 1 ? "size is" : "sizes are"} priced at $0, and $0 means free in the designer. Are they free?`,
      options: [{ value: "free", label: "Yes, they are free" }, { value: "skip", label: "No, leave those prices alone" }],
    });
  }
  return { wanted: wanted.filter((w) => w.price !== undefined || w.cells), skipped: [...skipped, ...priceSkips.values()], questions, coveredStyleIds: covered };
}

// ── A sentence's rules → Wanted ───────────────────────────────────────────────────────────────────

/** One rule, as the AI hands it over. Code picks the sizes and works out the numbers, so the AI never
 *  types a price for a size it hasn't been told about. */
export interface SizeRule {
  styles: string[];
  widths: number[];
  minWidth: number | null;
  maxWidth: number | null;
  minLength: number | null;
  maxLength: number | null;
  setPrice: number | null;
  raisePercent: number | null;
  raiseDollars: number | null;
  setOptions: { key: string; qty: number }[];
}

/** A raise or cut from a sentence is a number Claude took from the conversation. Past these it is refused
 *  (a typo, or "raise everything 500%"), and a person makes it on the table, where each price shows. */
export const RAISE_MAX_PCT = 100;
export const CUT_MAX_PCT = 50;
/** A price a sentence moves by more than this share, either way, is flagged on the card. */
export const BIG_CHANGE_SHARE = 0.25;
export const PREVIEW_SAID = {
  raiseTooBig: "That more than doubles those prices, and I won't make a change that big from a sentence. Change them on the Sizes & prices table in Settings > Sheds, where you can see each price. Nothing was changed.",
  cutTooBig: "That cuts those prices by more than half, and I won't make a change that big from a sentence. Change them on the Sizes & prices table in Settings > Sheds, where you can see each price. Nothing was changed.",
  badRaise: "A raise or a cut is a number, like 5 for 5% or -200 for $200 off.",
  tooHigh: "That puts a size at $1,000,000 or more, which looks too high to be right. Check it with them. If it's right, they can type it on the Sizes & prices table in Settings > Sheds. Nothing was changed.",
};
/** No size is priced at this or more from a sentence: the ceiling propose_new_door and Inventory keep. It
 *  holds a set price and a raise alike, so a raise on a $0 size has a limit too (11-09). */
export const PRICE_CEILING = 1_000_000;

export function wantedFromRules(table: SizeTable, rules: SizeRule[], columnKeys: Set<string>): { wanted: Wanted[]; error: string | null } {
  const wantedBy = new Map<string, Wanted>();
  // Each size's price before the first raise or cut in this request (its price now, or what an earlier
  // rule here set it to), so raises that add up are held to the same limits as one.
  const raisedFrom = new Map<string, number>();
  for (const rule of rules) {
    const styleIds = new Set<string>();
    for (const name of rule.styles) {
      const s = findStyle(table, name);
      if (s === "same" || s === "many") return { wanted: [], error: `More than one style could be ${name} (a hidden style counts). Ask them which, or have them rename one. Nothing was changed.` };
      if (!s) return { wanted: [], error: `There's no style called ${name} on this account.` };
      styleIds.add(s.id);
    }
    for (const o of rule.setOptions) {
      if (!columnKeys.has(o.key)) return { wanted: [], error: `There's no option column with the key ${o.key}.` };
      if (!Number.isInteger(o.qty) || o.qty < 0 || o.qty > MAX_QTY) return { wanted: [], error: "An option quantity is a whole number, 0 or more." };
    }
    const priceRules = [rule.setPrice, rule.raisePercent, rule.raiseDollars].filter((v) => v !== null).length;
    if (priceRules > 1) return { wanted: [], error: "One rule can set a price or raise it, not both." };
    // Infinity (1e400 in the tool's input) is no price: it would be stored as null and clear the size.
    if (rule.setPrice !== null && !(Number.isFinite(rule.setPrice) && rule.setPrice >= 0)) return { wanted: [], error: "A price is a number, 0 or more." };
    if (rule.setPrice !== null && !(rule.setPrice < PRICE_CEILING)) return { wanted: [], error: PREVIEW_SAID.tooHigh };
    if (!priceRules && !rule.setOptions.length) return { wanted: [], error: "That rule doesn't change anything." };
    for (const v of [rule.raisePercent, rule.raiseDollars]) if (v !== null && !Number.isFinite(v)) return { wanted: [], error: PREVIEW_SAID.badRaise };
    if (rule.raisePercent !== null && rule.raisePercent > RAISE_MAX_PCT) return { wanted: [], error: PREVIEW_SAID.raiseTooBig };
    if (rule.raisePercent !== null && rule.raisePercent < -CUT_MAX_PCT) return { wanted: [], error: PREVIEW_SAID.cutTooBig };

    for (const size of table.sizes) {
      if (styleIds.size && !styleIds.has(size.style_id)) continue;
      const w = Number(size.width_ft), l = Number(size.length_ft);
      if (rule.widths.length && !rule.widths.includes(w)) continue;
      if (rule.minWidth !== null && w < rule.minWidth) continue;
      if (rule.maxWidth !== null && w > rule.maxWidth) continue;
      if (rule.minLength !== null && l < rule.minLength) continue;
      if (rule.maxLength !== null && l > rule.maxLength) continue;
      const line = wantedBy.get(size.id) ?? { styleId: size.style_id, width: w, length: l, flags: [], where: null };
      const old = size.base_price === null ? null : Number(size.base_price);
      if (rule.setPrice !== null) line.price = rule.setPrice;
      // A raise needs a price to raise: an unpriced size stays unpriced. It works from what an earlier
      // rule in this same request set, so two rules on one size add up. Below $0 refuses the lot.
      const basis = typeof line.price === "number" ? line.price : old;
      if (basis !== null && (rule.raisePercent !== null || rule.raiseDollars !== null)) {
        const next = rule.raisePercent !== null ? Math.round(basis * (100 + rule.raisePercent)) / 100 : Math.round((basis + rule.raiseDollars!) * 100) / 100;
        if (next < 0) return { wanted: [], error: `That would put ${size.label} below $0 (it's $${basis} now). Nothing was changed.` };
        if (!(next < PRICE_CEILING)) return { wanted: [], error: PREVIEW_SAID.tooHigh };
        // A dollar raise is held to the same limits, size by size, and so are raises that add up.
        if (!raisedFrom.has(size.id)) raisedFrom.set(size.id, basis);
        const from = raisedFrom.get(size.id)!;
        if (from > 0 && next > from * (1 + RAISE_MAX_PCT / 100)) return { wanted: [], error: PREVIEW_SAID.raiseTooBig };
        if (from > 0 && next < from * (1 - CUT_MAX_PCT / 100)) return { wanted: [], error: PREVIEW_SAID.cutTooBig };
        line.price = next;
      }
      if (rule.setOptions.length) {
        line.cells = { ...line.cells };
        for (const o of rule.setOptions) line.cells[o.key] = o.qty;
      }
      wantedBy.set(size.id, line);
    }
  }
  // Any price this moves by more than a quarter, either way, says so on the card (a set price too: it is
  // a number from the conversation as well). A free size given a price counts. It never stops anything.
  const oldOf = new Map(table.sizes.map((s) => [s.id, s.base_price === null ? null : Number(s.base_price)]));
  for (const [id, line] of wantedBy) {
    const old = oldOf.get(id) ?? null;
    if (typeof line.price !== "number" || old === null || line.price === old) continue;
    const big = old > 0 ? Math.abs(line.price - old) / old > BIG_CHANGE_SHARE : line.price > 0;
    if (big && !line.flags.includes("big_change")) line.flags = [...line.flags, "big_change"];
  }
  return { wanted: [...wantedBy.values()], error: null };
}

// ── Wanted vs the table ───────────────────────────────────────────────────────────────────────────

export function diffAgainst(
  table: SizeTable, columns: OptionColumn[], wanted: Wanted[], opts: {
    skipped?: Problem[]; questions?: Question[]; coveredStyleIds?: Set<string>; makeId: () => string; mayCreate: boolean;
  },
): { preview: Preview; payload: Payload } {
  const sizeBy = new Map(table.sizes.map((s) => [`${s.style_id}|${Number(s.width_ft)}|${Number(s.length_ft)}`, s]));
  const stored = new Map<string, Record<string, number>>();
  for (const i of table.inclusions) {
    if (!i.included) continue;
    const m = stored.get(i.size_id) ?? {};
    m[i.item_key] = Number(i.qty);
    stored.set(i.size_id, m);
  }
  const byStyle = new Map<string, PreviewRow[]>();
  const push = (styleId: string, row: PreviewRow) => {
    const list = byStyle.get(styleId) ?? [];
    list.push(row);
    byStyle.set(styleId, list);
  };
  const usedKeys = new Set<string>();
  const payload: Payload = { creates: [], sizes: [] };
  const skipped = [...(opts.skipped ?? [])];
  let same = 0;
  const seenSizes = new Set<string>();

  for (const w of wanted) {
    const label = sizeLabel(w.width, w.length);
    // Sheet rows arrive already matched to the stored size (resolveRows), so this is exact.
    const size = sizeBy.get(`${w.styleId}|${w.width}|${w.length}`);
    if (!size) {
      if (!opts.mayCreate) continue;
      // A new size is only worth making with a price or an option on it. "Not offered" isn't one, and
      // neither is a 0 in an option box.
      const hasOption = Object.values(w.cells ?? {}).some((q) => q > 0);
      if (w.price === null || (w.price === undefined && !hasOption)) continue;
      // On Real-Time Pricing the price can't land: an option still makes the size, and a price alone
      // goes on the list.
      const blockedPrice = table.rtpOn && w.price !== undefined;
      if (blockedPrice) {
        skipped.push({ where: w.where ?? "Your sheet", text: label, why: RTP_WHY });
        if (!hasOption) continue;
      }
      const price = blockedPrice ? undefined : w.price;
      const id = opts.makeId();
      const cells: PreviewRow["cells"] = {};
      for (const [k, q] of Object.entries(w.cells ?? {})) {
        if (q > 0) { cells[k] = { from: 0, to: q }; usedKeys.add(k); }
      }
      payload.creates.push({
        id, styleId: w.styleId, label, width: w.width, length: w.length, price: price ?? null,
        cells: Object.fromEntries(Object.entries(w.cells ?? {}).filter(([, q]) => q > 0)),
      });
      // 12x10 beside a real 10x12, or 16x8 on a style with no wider-than-long size: the sheet may have
      // its width and length the other way round. A flag, not a stop: such sizes can be real.
      const flipped = sizeBy.has(`${w.styleId}|${w.length}|${w.width}`) ||
        (w.width > w.length && !table.sizes.some((s) => s.style_id === w.styleId && Number(s.width_ft) > Number(s.length_ft)));
      push(w.styleId, {
        sizeId: id, label, isNew: true, cells, flags: flipped ? [...w.flags, "reversed_size"] : w.flags, where: w.where,
        price: price === undefined ? null : { from: null, to: price },
      });
      continue;
    }
    seenSizes.add(size.id);
    const oldPrice = size.base_price === null ? null : Number(size.base_price);
    const edit: EditLine = { id: size.id, label, base: size.updated_at, from: {}, to: {}, wasActive: size.active };
    const row: PreviewRow = { sizeId: size.id, label, isNew: false, price: null, cells: {}, flags: w.flags, where: w.where };
    let priceBlocked = false;
    if (w.price !== undefined && w.price !== oldPrice) {
      if (table.rtpOn) {
        priceBlocked = true;
        skipped.push({ where: w.where ?? "Your sheet", text: label, why: RTP_WHY });
      } else {
        edit.from.price = oldPrice;
        edit.to.price = w.price;
        row.price = { from: oldPrice, to: w.price };
        // $0 is free in the designer, however it got here. A price on an unpriced size puts it on sale.
        if (w.price === 0 && !row.flags.includes("zero")) row.flags = [...row.flags, "zero"];
        if (oldPrice === null) row.flags = [...row.flags, "goes_on_sale"];
      }
    }
    const have = stored.get(size.id) ?? {};
    for (const [k, q] of Object.entries(w.cells ?? {})) {
      const was = have[k] ?? 0;
      if (q === was) continue;
      (edit.from.cells ??= {})[k] = was;
      (edit.to.cells ??= {})[k] = q;
      row.cells[k] = { from: was, to: q };
      usedKeys.add(k);
    }
    if (row.price === null && !Object.keys(row.cells).length) { if (!priceBlocked) same++; continue; }
    payload.sizes.push(edit);
    push(w.styleId, row);
  }

  // What looks wrong. Flags never stop anything: they tell the person where to look. Real-Time Pricing
  // sets the prices itself, so none of these numbers would land.
  if (!table.rtpOn) for (const [styleId, rows] of byStyle) flagPrices(table, styleId, rows, wanted);

  const leftAlone: Preview["leftAlone"] = [];
  const labelOf = new Map(table.styles.map((s) => [s.id, styleName(s)]));
  for (const id of opts.coveredStyleIds ?? []) {
    for (const s of table.sizes) {
      if (s.style_id === id && !seenSizes.has(s.id)) leftAlone.push({ style: labelOf.get(id) ?? "", label: s.label });
    }
  }

  const styles = [...byStyle.entries()].map(([id, rows]) => ({
    id, label: labelOf.get(id) ?? "",
    rows: rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  }));
  const all = styles.flatMap((s) => s.rows);
  return {
    payload,
    preview: {
      styles,
      columns: columns.filter((c) => usedKeys.has(c.key)),
      counts: {
        changed: all.filter((r) => !r.isNew).length,
        added: all.filter((r) => r.isNew).length,
        same,
        // Going on sale is a note, not a worry: a first upload onto a blank table is all of them.
        flagged: all.filter((r) => r.flags.some((f) => f !== "goes_on_sale")).length,
        leftAlone: leftAlone.length,
        skipped: skipped.length,
      },
      leftAlone: leftAlone.slice(0, 300),
      skipped: skipped.slice(0, 300),
      questions: opts.questions ?? [],
    },
  };
}

/** A bigger size priced below a smaller one, and a price far from its neighbors, judged on the prices
 *  the style would hold after this change. */
function flagPrices(table: SizeTable, styleId: string, rows: PreviewRow[], wanted: Wanted[]) {
  type P = { width: number; length: number; price: number; row: PreviewRow | null };
  const after = new Map<string, P>();
  for (const s of table.sizes) {
    if (s.style_id !== styleId || s.base_price === null) continue;
    after.set(`${Number(s.width_ft)}x${Number(s.length_ft)}`, { width: Number(s.width_ft), length: Number(s.length_ft), price: Number(s.base_price), row: null });
  }
  const rowByLabel = new Map(rows.map((r) => [r.label, r]));
  for (const w of wanted) {
    if (w.styleId !== styleId || w.price === undefined) continue;
    const k = `${w.width}x${w.length}`;
    if (w.price === null) { after.delete(k); continue; }
    after.set(k, { width: w.width, length: w.length, price: w.price, row: rowByLabel.get(sizeLabel(w.width, w.length)) ?? null });
  }
  const list = [...after.values()].filter((p) => p.price > 0);
  const add = (r: PreviewRow | null, f: Flag) => { if (r && !r.flags.includes(f)) r.flags = [...r.flags, f]; };
  const perFoot = list.map((p) => p.price / (p.width * p.length)).sort((a, b) => a - b);
  const median = perFoot.length ? perFoot[Math.floor(perFoot.length / 2)] : 0;
  for (const p of list) {
    if (list.length >= 4) {
      const rate = p.price / (p.width * p.length);
      if (rate > median * 2.5 || rate < median * 0.4) add(p.row, "far_from_neighbors");
    }
    for (const q of list) {
      // At least as wide and at least as long, and bigger one way: it should not cost less. Say so on
      // whichever of the two this change touches. (Only that test: a 12x12 can fairly cost less than a
      // 10x20, which is more building.)
      if (q.width >= p.width && q.length >= p.length && (q.width > p.width || q.length > p.length) && q.price < p.price) {
        add(q.row, "below_smaller");
        add(p.row, "above_bigger");
      }
    }
  }
}

// ── Sending it ────────────────────────────────────────────────────────────────────────────────────

/** Splits a list into calls the save route accepts: at most 50 entries and 2500 option boxes. */
export function chunkEdits<T extends { to?: { cells?: Record<string, number> } }>(list: T[], maxEntries = 50, maxCells = 2500): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let cells = 0;
  for (const e of list) {
    const n = Object.keys(e.to?.cells ?? {}).length;
    if (cur.length && (cur.length >= maxEntries || cells + n > maxCells)) {
      out.push(cur);
      cur = [];
      cells = 0;
    }
    cur.push(e);
    cells += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export { parseFeet };
