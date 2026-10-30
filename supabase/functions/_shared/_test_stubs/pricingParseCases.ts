// The sizes table's number rules as ONE input table (plan §4.10, 2026-10-30), so the browser's parsers
// (ssPgParsePrice / ssPgParseQty / ssPgParseDim, portal/03-catalog.jsx) and the server's
// (_shared/pricingCells.ts parsePrice / parseQty / parseDim) are held to the same answers. A box the
// browser lets through and the server refuses is a 400 for the whole save, and the other way round a
// box the builder cannot type. pricingCells_test.ts runs the server half; the browser's lift test runs
// the same rows through the lifted helpers.
//
// Not a test file itself (no _test suffix). Each row: [typed text, stored value (or undefined), the
// value it parses to, or "error"].

export type ParseCase = [text: string, stored: number | null | undefined, expect: number | null | "error"];

/** Price: blank is NULL (not offered); the importer's rule otherwise: finite and 0 or more once `$`,
 *  commas and spaces are stripped; a value equal to the stored one is always accepted. */
export const PRICE_CASES: ParseCase[] = [
  ["4800", undefined, 4800],
  ["$4,800", undefined, 4800],
  ["4800.50", undefined, 4800.5],
  ["4800.555", undefined, 4800.555],
  [" $ 4,800 ", undefined, 4800],
  ["0", undefined, 0],
  ["$0", undefined, 0],
  ["", undefined, null],
  ["   ", undefined, null],
  ["-5", undefined, "error"],
  ["$-5", undefined, "error"],
  ["abc", undefined, "error"],
  ["4.8k", undefined, "error"],
  ["Infinity", undefined, "error"],
  ["-5", -5, -5],               // what is stored is always accepted
];

/** Included quantity: a whole number from 0 to 999,999, blank meaning 0; stricter than the importer
 *  (no yes-words, no rounding, no garbage read as 0); a value equal to the stored one is accepted. */
export const QTY_CASES: ParseCase[] = [
  ["50", undefined, 50],
  ["1,200", undefined, 1200],
  [" 7 ", undefined, 7],
  ["", undefined, 0],
  ["0", undefined, 0],
  ["999999", undefined, 999999],
  ["1000000", undefined, "error"],
  ["1000000", 1000000, 1000000],  // what is stored is always accepted
  ["2.5", undefined, "error"],
  ["-1", undefined, "error"],
  ["yes", undefined, "error"],
  ["x", undefined, "error"],
  ["abc", undefined, "error"],
  ["1e3", undefined, "error"],    // Number() reads these as whole numbers; a box of counts does not
  ["0x1F", undefined, "error"],
  ["+5", undefined, "error"],
];

/** A new size's width or length, in feet: above 0, at most 500, at most 2 decimals. */
export const DIM_CASES: ParseCase[] = [
  ["12", undefined, 12],
  ["10.5", undefined, 10.5],
  ["10.25", undefined, 10.25],
  ["500", undefined, 500],
  ["10.125", undefined, "error"],
  ["0", undefined, "error"],
  ["-1", undefined, "error"],
  ["501", undefined, "error"],
  ["abc", undefined, "error"],
  ["", undefined, "error"],
  ["1e1", undefined, "error"],    // plain decimals only
  ["0x10", undefined, "error"],
];
