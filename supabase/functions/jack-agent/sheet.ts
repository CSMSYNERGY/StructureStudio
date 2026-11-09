// jack-agent: reading a price list. Pure: no network, no database (sheet_test.ts).
//
// THE RULE THAT MATTERS (plan 5.1): for Excel and CSV, the AI only decides which column means what.
// Claude answers with a Block (a sheet, a row range, column numbers) and this file reads the digits, so
// it cannot change a number. A PDF or a photo has no cells to point at, so the AI reads it twice,
// separately, and compareReads flags every box where the two reads disagree.
//
// Sheet text is data. A Block holds numbers and style names; a style name it gives is only ever matched
// against this builder's own styles (preview.ts), and an option key must be one of theirs.

export interface Sheet {
  name: string;
  rows: string[][];
}

export type BlockKind = "list" | "styles_across" | "size_grid";

/** How one rectangle of a sheet is laid out. Row and column numbers count from 0, as the prompt shows. */
export interface Block {
  kind: BlockKind;
  sheet: number;
  firstRow: number;
  lastRow: number;
  /** list: the column naming the style, or styleFixed when the whole block is one style. */
  styleCol: number | null;
  styleFixed: string | null;
  /** list and styles_across: one "10x12" column, or width and length apart. size_grid: widthCol only. */
  sizeCol: number | null;
  widthCol: number | null;
  lengthCol: number | null;
  /** list: the price column. */
  priceCol: number | null;
  /** styles_across: one price column per style. */
  stylesAcross: { col: number; style: string }[];
  /** size_grid: the row holding the lengths, and the columns they run across. */
  lengthHeaderRow: number | null;
  firstPriceCol: number | null;
  lastPriceCol: number | null;
  /** list: columns that are option quantities, by the builder's option key. */
  options: { col: number; itemKey: string }[];
}

export interface ReadRow {
  style: string;
  width: number;
  length: number;
  priceText: string;
  /** Option key to the cell's text, only for columns the sheet maps. */
  cells: Record<string, string>;
  /** "Sheet1 row 13", for the person. 1-based, the way a spreadsheet numbers rows. */
  where: string;
}

export interface Problem {
  where: string;
  text: string;
  why: string;
}

/** A width or length in feet: 10, 10.5, 10', 10'6", 10 ft. Null when it isn't one. */
export function parseFeet(raw: unknown): number | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft\.?|feet)?$/);
  if (m) return ok(Number(m[1]));
  m = s.match(/^(\d+)\s*(?:'|ft\.?|feet)\s*-?\s*(\d+(?:\.\d+)?)\s*(?:"|in\.?|inches)?$/);
  if (m && Number(m[2]) < 12) return ok(Number(m[1]) + Number(m[2]) / 12);
  return null;
}
const ok = (n: number) => (Number.isFinite(n) && n > 0 && n <= 500 ? Math.round(n * 100) / 100 : null);

/** "10x12", "10 x 12", "10'x12'", "10' X 12'", "10 by 12", "10×12". Null when it isn't a size. */
export function parseSizeText(raw: unknown): { width: number; length: number } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:x|×|\*|\bby\b)\s*/i);
  if (parts.length !== 2) return null;
  const width = parseFeet(parts[0]), length = parseFeet(parts[1]);
  return width && length ? { width, length } : null;
}

const blank = (s: unknown) => String(s ?? "").trim() === "";

/** Reads one block. Throws a plain sentence when the block doesn't fit the sheet: that is the AI's
 *  mistake, and the caller answers it as "couldn't work out this sheet" rather than guessing. */
export function readBlock(sheets: Sheet[], b: Block, allowedKeys: Set<string>): { rows: ReadRow[]; problems: Problem[] } {
  const sheet = sheets[b.sheet];
  if (!sheet) throw new Error("names a sheet that isn't there");
  if (b.firstRow < 0 || b.lastRow < b.firstRow || b.lastRow >= sheet.rows.length) throw new Error("names rows that aren't there");
  const rows: ReadRow[] = [], problems: Problem[] = [];
  const at = (r: number) => `${sheet.name} row ${r + 1}`;
  const cell = (r: number, c: number | null) => (c === null || c < 0 ? "" : String(sheet.rows[r]?.[c] ?? "").trim());

  const sizeOf = (r: number): { width: number; length: number } | null => {
    if (b.sizeCol !== null) return parseSizeText(cell(r, b.sizeCol));
    const width = parseFeet(cell(r, b.widthCol)), length = parseFeet(cell(r, b.lengthCol));
    return width && length ? { width, length } : null;
  };
  const sizeText = (r: number) => (b.sizeCol !== null ? cell(r, b.sizeCol) : `${cell(r, b.widthCol)} x ${cell(r, b.lengthCol)}`.trim());

  if (b.kind === "list") {
    if (b.priceCol === null && !b.options.length) throw new Error("gives no price or option columns");
    if (b.styleCol === null && blank(b.styleFixed)) throw new Error("doesn't say which style");
    if (b.sizeCol === null && (b.widthCol === null || b.lengthCol === null)) throw new Error("doesn't say which column holds the size");
    const options = b.options.filter((o) => allowedKeys.has(o.itemKey));
    let lastStyle = "";
    for (let r = b.firstRow; r <= b.lastRow; r++) {
      const row = sheet.rows[r] ?? [];
      if (row.every(blank)) continue;
      // A style written once above its rows (a merged cell) carries down.
      const named = b.styleCol !== null ? cell(r, b.styleCol) : String(b.styleFixed);
      if (named) lastStyle = named;
      const size = sizeOf(r);
      if (!size) {
        problems.push({ where: at(r), text: sizeText(r).slice(0, 60), why: "couldn't read a size" });
        continue;
      }
      if (!lastStyle) {
        problems.push({ where: at(r), text: sizeText(r).slice(0, 60), why: "no style on this row" });
        continue;
      }
      const cells: Record<string, string> = {};
      for (const o of options) cells[o.itemKey] = cell(r, o.col);
      rows.push({ style: lastStyle, width: size.width, length: size.length, priceText: cell(r, b.priceCol), cells, where: at(r) });
    }
    return { rows, problems };
  }

  if (b.kind === "styles_across") {
    if (!b.stylesAcross.length) throw new Error("names no style columns");
    if (b.sizeCol === null && (b.widthCol === null || b.lengthCol === null)) throw new Error("doesn't say which column holds the size");
    for (let r = b.firstRow; r <= b.lastRow; r++) {
      if ((sheet.rows[r] ?? []).every(blank)) continue;
      const size = sizeOf(r);
      if (!size) {
        problems.push({ where: at(r), text: sizeText(r).slice(0, 60), why: "couldn't read a size" });
        continue;
      }
      for (const a of b.stylesAcross) {
        const priceText = cell(r, a.col);
        if (!priceText) continue;
        rows.push({ style: a.style, width: size.width, length: size.length, priceText, cells: {}, where: at(r) });
      }
    }
    return { rows, problems };
  }

  // size_grid: widths down one column, lengths across one row, a price where they meet.
  if (blank(b.styleFixed)) throw new Error("doesn't say which style this grid is");
  if (b.widthCol === null || b.lengthHeaderRow === null || b.firstPriceCol === null || b.lastPriceCol === null || b.lastPriceCol < b.firstPriceCol) {
    throw new Error("doesn't say where the grid's widths and lengths are");
  }
  const lengths = new Map<number, number>();
  const badHeaders: number[] = [];
  for (let c = b.firstPriceCol; c <= b.lastPriceCol; c++) {
    const l = parseFeet(cell(b.lengthHeaderRow, c));
    if (l) lengths.set(c, l);
    else badHeaders.push(c);
  }
  if (!lengths.size) throw new Error("points at a row with no lengths in it");
  // A column whose length can't be read is never guessed at, and it never disappears without a word.
  for (const c of badHeaders) {
    let priced = 0;
    for (let r = b.firstRow; r <= b.lastRow; r++) if (cell(r, c)) priced++;
    if (priced) problems.push({ where: `${at(b.lengthHeaderRow)}, column ${c + 1}`, text: cell(b.lengthHeaderRow, c).slice(0, 60) || "(blank header)", why: `couldn't read a length, so ${priced} ${priced === 1 ? "price in this column wasn't" : "prices in this column weren't"} read` });
  }
  for (let r = b.firstRow; r <= b.lastRow; r++) {
    if ((sheet.rows[r] ?? []).every(blank)) continue;
    const width = parseFeet(cell(r, b.widthCol));
    if (!width) {
      problems.push({ where: at(r), text: cell(r, b.widthCol).slice(0, 60), why: "couldn't read a width" });
      continue;
    }
    for (const [c, length] of lengths) {
      const priceText = cell(r, c);
      if (!priceText) continue;
      rows.push({ style: String(b.styleFixed), width, length, priceText, cells: {}, where: `${at(r)}, ${length}' column` });
    }
  }
  return { rows, problems };
}

/** The most a sheet may hold and still go to the AI whole. Past a sheet, row or column limit we say so
 *  rather than trim it. Long cell text is shortened, because no price or size is that long. */
export const MAX_SHEETS = 40;
export const MAX_TOTAL_ROWS = 3000;
export const MAX_COLS = 120;
export const MAX_CELL_CHARS = 200;

/** Cleans what the browser sent. Null means it's over a limit. */
export function cleanSheets(raw: unknown): { sheets: Sheet[]; error: string | null } {
  if (!Array.isArray(raw) || !raw.length) return { sheets: [], error: "That file has no sheets in it." };
  if (raw.length > MAX_SHEETS) return { sheets: [], error: `That workbook has ${raw.length} sheets. Please send at most ${MAX_SHEETS} at a time.` };
  const sheets: Sheet[] = [];
  let total = 0;
  for (const s of raw) {
    const given: unknown[] = Array.isArray(s?.rows) ? s.rows : [];
    if (given.some((r) => Array.isArray(r) && r.slice(MAX_COLS).some((c) => !blank(c)))) {
      return { sheets: [], error: `That file has cells past column ${MAX_COLS}. Please split it and send one part at a time.` };
    }
    const rows: string[][] = given.map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLS) : []).map((c) => String(c ?? "").trim().slice(0, MAX_CELL_CHARS)));
    // Blank rows stay in the sheet, because a row number is a place in it, and only filled rows count.
    total += rows.filter((r) => r.some((c) => c !== "")).length;
    if (total > MAX_TOTAL_ROWS) return { sheets: [], error: `That file has more than ${MAX_TOTAL_ROWS.toLocaleString("en-US")} rows. Please split it and send one part at a time.` };
    sheets.push({ name: String(s?.name ?? `Sheet ${sheets.length + 1}`).slice(0, 80), rows });
  }
  if (!sheets.some((s) => s.rows.some((r) => r.some((c) => c !== "")))) return { sheets: [], error: "That file looks empty." };
  return { sheets, error: null };
}

/** The sheet as Claude sees it: every non-empty cell with its coordinates, so a Block can name them. */
export function sheetsForPrompt(sheets: Sheet[]): string {
  const out: string[] = [];
  sheets.forEach((s, i) => {
    out.push(`<sheet index="${i}" name=${JSON.stringify(s.name)} rows="${s.rows.length}">`);
    s.rows.forEach((row, r) => {
      const cells = row.map((c, k) => (c === "" ? null : `c${k}=${JSON.stringify(c)}`)).filter(Boolean);
      if (cells.length) out.push(`r${r}: ${cells.join(" ")}`);
    });
    out.push("</sheet>");
  });
  return out.join("\n");
}

// ── A PDF or a photo: two separate reads ──────────────────────────────────────────────────────────

export interface ImageRead {
  style: string;
  size: string;
  price: string;
}

const readKey = (style: string, w: number, l: number) => `${normStyle(style)}|${w}|${l}`;

/** A style name reduced to what matters: case, punctuation and a trailing S don't. A plus does:
 *  Premium+ is a different style from Premium, and the same one as Premium Plus. */
export function normStyle(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, " ").trim();
  return s.split(" ").map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).join(" ");
}

/** Keeps the boxes both reads agree on. Every other box goes on the problems list for a person; it is
 *  never written, because a misread number on a price list is the most expensive mistake there is. */
export function compareReads(a: ImageRead[], b: ImageRead[], label: string): { rows: ReadRow[]; problems: Problem[] } {
  // A size neither read can parse is said out loud, once, however many reads saw it.
  const unread = new Map<string, ImageRead>();
  const index = (list: ImageRead[]) => {
    const m = new Map<string, { style: string; width: number; length: number; price: string }>();
    for (const r of list) {
      const size = parseSizeText(r.size);
      if (!size) {
        unread.set(`${normStyle(r.style)}|${String(r.size ?? "").trim()}`, r);
        continue;
      }
      m.set(readKey(r.style, size.width, size.length), { style: r.style, width: size.width, length: size.length, price: String(r.price ?? "").trim() });
    }
    return m;
  };
  const first = index(a), second = index(b);
  const rows: ReadRow[] = [], problems: Problem[] = [];
  const digits = (s: string) => s.replace(/[$,\s]/g, "").replace(/\.0+$/, "").toLowerCase();
  for (const [k, x] of first) {
    const y = second.get(k);
    const name = `${x.style} ${x.width}x${x.length}`;
    if (!y) {
      problems.push({ where: label, text: name, why: `only one read saw this size (${x.price || "no price"})` });
      continue;
    }
    if (digits(x.price) !== digits(y.price)) {
      problems.push({ where: label, text: name, why: `the two reads disagree: ${x.price || "blank"} or ${y.price || "blank"}` });
      continue;
    }
    rows.push({ style: x.style, width: x.width, length: x.length, priceText: x.price, cells: {}, where: label });
  }
  for (const [k, y] of second) {
    if (!first.has(k)) problems.push({ where: label, text: `${y.style} ${y.width}x${y.length}`, why: `only one read saw this size (${y.price || "no price"})` });
  }
  for (const r of unread.values()) problems.push({ where: label, text: `${r.style} ${r.size}`.slice(0, 60), why: "couldn't read a size" });
  return { rows, problems };
}
