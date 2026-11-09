import { assert, assertEquals } from "./test_assert.ts";
import {
  BIG_CHANGE_SHARE, chunkEdits, columnsFromCatalog, CUT_MAX_PCT, diffAgainst, PREVIEW_SAID, RAISE_MAX_PCT, readOptionCell, resolveRows, type SizeRule, type SizeTable, wantedFromRules,
} from "./preview.ts";
import type { ReadRow } from "./sheet.ts";

const V = "2026-11-01T00:00:00.000000+00:00";
const size = (id: string, style: string, w: number, l: number, price: number | null, active = price !== null) =>
  ({ id, style_id: style, label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: price, active, updated_at: V });

const table: SizeTable = {
  styles: [{ id: "garden", label: "Garden Shed" }, { id: "barn", label: "Lofted Barn" }],
  sizes: [size("s1", "garden", 10, 12, 4000), size("s2", "garden", 10, 14, 4500), size("s3", "garden", 10, 16, 5000), size("s4", "barn", 12, 24, null), size("s5", "garden", 8, 10, 3000)],
  inclusions: [{ size_id: "s1", item_key: "single", included: true, qty: 1 }],
};
const columns = [{ key: "single", label: "Single door", section: "Doors" }, { key: "loft", label: "Loft", section: "Built-in options" }];
const keys = new Set(columns.map((c) => c.key));
let n = 0;
const makeId = () => `new-${++n}`;
const row = (style: string, w: number, l: number, priceText: string, cells: Record<string, string> = {}): ReadRow => ({ style, width: w, length: l, priceText, cells, where: `S row ${w}${l}` });

function run(rows: ReadRow[], answers = {}) {
  const r = resolveRows(table, rows, keys, answers);
  return { ...r, ...diffAgainst(table, columns, r.wanted, { skipped: r.skipped, questions: r.questions, coveredStyleIds: r.coveredStyleIds, makeId, mayCreate: true }) };
}

Deno.test("a changed price carries its version and its old value, and an unchanged one drops out", () => {
  const { preview, payload } = run([row("Garden Sheds", 10, 12, "$4,200"), row("Garden Shed", 10, 14, "4500")]);
  assertEquals(payload.sizes.length, 1);
  assertEquals(payload.sizes[0], { id: "s1", label: "10x12", base: V, from: { price: 4000 }, to: { price: 4200 }, wasActive: true });
  assertEquals(preview.counts.changed, 1);
  assertEquals(preview.counts.same, 1);
  assertEquals(preview.styles[0].rows[0].price, { from: 4000, to: 4200 });
});

Deno.test("a new size is created, and sizes missing from the sheet are listed and left alone", () => {
  const { preview, payload } = run([row("Garden Shed", 10, 20, "$6,000", { single: "1" })]);
  assertEquals(payload.sizes, []);
  assertEquals(payload.creates.length, 1);
  assertEquals({ ...payload.creates[0], id: "" }, { id: "", styleId: "garden", label: "10x20", width: 10, length: 20, price: 6000, cells: { single: 1 } });
  assertEquals(preview.counts.added, 1);
  assertEquals(preview.leftAlone.map((x) => x.label).sort(), ["10x12", "10x14", "10x16", "8x10"]);
});

Deno.test("words in a price box never become numbers", () => {
  const { preview, payload } = run([row("Garden Shed", 10, 12, "Call for price"), row("Garden Shed", 10, 14, "see note"), row("Garden Shed", 10, 16, "")]);
  assertEquals(payload.sizes, []);
  assertEquals(preview.skipped.length, 2);
  assert(preview.skipped[0].why.includes("call for a price"));
});

Deno.test("N/A takes a size off offer, and a new size with N/A isn't made", () => {
  const { preview, payload } = run([row("Garden Shed", 10, 12, "N/A"), row("Garden Shed", 10, 99, "n/a")]);
  assertEquals(payload.creates, []);
  assertEquals(payload.sizes[0].to, { price: null });
  assertEquals(preview.styles[0].rows[0].flags, ["not_offered"]);
});

Deno.test("$0 asks first, because $0 means free in the designer", () => {
  const first = run([row("Garden Shed", 10, 12, "$0")]);
  assertEquals(first.payload.sizes, []);
  assertEquals(first.preview.questions.map((q) => q.id), ["zero"]);
  const free = run([row("Garden Shed", 10, 12, "$0")], { zero: "free" });
  assertEquals(free.payload.sizes[0].to, { price: 0 });
  assertEquals(free.preview.styles[0].rows[0].flags, ["zero"]);
  assertEquals(free.preview.questions, []);
  const skip = run([row("Garden Shed", 10, 12, "$0")], { zero: "skip" });
  assertEquals(skip.payload.sizes, []);
  assertEquals(skip.preview.questions, []);
});

Deno.test("an unknown style asks, and never gets added here", () => {
  const rows = [row("Dutch Barn", 10, 12, "$5,000"), row("Dutch Barn", 10, 14, "$5,500")];
  const first = run(rows);
  assertEquals(first.payload, { creates: [], sizes: [] });
  assertEquals(first.preview.questions[0].rows, 2);
  assert(first.preview.questions[0].text.includes("Dutch Barn"));
  assertEquals(run(rows, { styles: { "Dutch Barn": "skip" } }).preview.questions, []);
  assertEquals(run(rows, { styles: { "Dutch Barn": "skip" } }).payload.sizes, []);
  const pointed = run(rows, { styles: { "Dutch Barn": "garden" } });
  assertEquals(pointed.preview.questions, []);
  assertEquals(pointed.payload.sizes.map((s) => s.id), ["s1", "s2"]);
  assertEquals(pointed.payload.creates, []);
  // An answer naming somebody else's style is no answer.
  assertEquals(run(rows, { styles: { "Dutch Barn": "someone-elses" } }).preview.questions.length, 1);
});

Deno.test("flags: a longer size priced lower, and a price far from its neighbors", () => {
  const { preview } = run([row("Garden Shed", 10, 14, "$3,900"), row("Garden Shed", 10, 16, "$50,000")]);
  const flags = Object.fromEntries(preview.styles[0].rows.map((r) => [r.label, r.flags]));
  assert(flags["10x14"].includes("below_smaller"), JSON.stringify(flags));
  assert(flags["10x16"].includes("far_from_neighbors"), JSON.stringify(flags));
  assertEquals(preview.counts.flagged, 2);
});

Deno.test("the same size twice: the later row wins, and says so", () => {
  const { payload, preview } = run([row("Garden Shed", 10, 12, "$4,100"), row("Garden Shed", 10, 12, "$4,300")]);
  assertEquals(payload.sizes[0].to, { price: 4300 });
  assert(preview.styles[0].rows[0].flags.includes("same_size_twice"));
});

Deno.test("option boxes: numbers, yes-words, blanks and rubbish", () => {
  assertEquals(readOptionCell("2"), 2);
  assertEquals(readOptionCell("X"), "yes");
  assertEquals(readOptionCell("no"), 0);
  assertEquals(readOptionCell(""), "leave");
  assertEquals(readOptionCell("1,000,000"), null);
  assertEquals(readOptionCell("some"), null);
  const { payload, preview } = run([row("Garden Shed", 10, 12, "", { single: "2", loft: "banana" })]);
  assertEquals(payload.sizes[0].from, { cells: { single: 1 } });
  assertEquals(payload.sizes[0].to, { cells: { single: 2 } });
  assertEquals(preview.skipped.length, 1);
  assertEquals(preview.columns.map((c) => c.key), ["single"]);
});

const rule = (over: Partial<SizeRule>): SizeRule => ({ styles: [], widths: [], minWidth: null, maxWidth: null, minLength: null, maxLength: null, setPrice: null, raisePercent: null, raiseDollars: null, setOptions: [], ...over });

Deno.test("a sentence: every 8 and 10 wide gets one single door", () => {
  const made = wantedFromRules(table, [rule({ widths: [8, 10], setOptions: [{ key: "single", qty: 1 }] })], keys);
  assertEquals(made.error, null);
  const { payload, preview } = diffAgainst(table, columns, made.wanted, { makeId, mayCreate: false });
  // s1 already has it; s2, s3 and s5 change; the 12 wide isn't touched.
  assertEquals(payload.sizes.map((s) => s.id).sort(), ["s2", "s3", "s5"]);
  assertEquals(preview.counts.same, 1);
});

Deno.test("a sentence: raises work from the old price, and skip unpriced sizes", () => {
  const made = wantedFromRules(table, [rule({ raisePercent: 5 })], keys);
  const { payload } = diffAgainst(table, columns, made.wanted, { makeId, mayCreate: false });
  assertEquals(payload.sizes.find((s) => s.id === "s1")?.to, { price: 4200 });
  assert(!payload.sizes.some((s) => s.id === "s4"));
  assertEquals(payload.creates, []);
});

Deno.test("a rule naming a style or a key that isn't theirs is refused", () => {
  assert(wantedFromRules(table, [rule({ styles: ["Dutch Barn"], setPrice: 5 })], keys).error);
  assert(wantedFromRules(table, [rule({ setOptions: [{ key: "nope", qty: 1 }] })], keys).error);
  assert(wantedFromRules(table, [rule({ setPrice: 5, raisePercent: 5 })], keys).error);
  assert(wantedFromRules(table, [rule({})], keys).error);
});

Deno.test("calls stay inside what the save route accepts", () => {
  const edits = Array.from({ length: 120 }, () => ({ to: { cells: { a: 1 } } }));
  assertEquals(chunkEdits(edits).map((c) => c.length), [50, 50, 20]);
  const wide = Array.from({ length: 3 }, () => ({ to: { cells: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, 1])) } }));
  assertEquals(chunkEdits(wide).map((c) => c.length), [1, 1, 1]);
});

Deno.test("option columns match the table's: no ramp, no partition wall, no retired fixture", () => {
  const cols = columnsFromCatalog({
    items: [{ key: "loft", label: "Loft" }, { key: "ramp", label: "Ramp" }, { key: "partitionWall", label: "Wall" }, { key: "old", label: "Old", archived: true }],
    fixtures: [{ id: "d1", name: "Walk door", width_in: 36, height_in: 80 }, { id: "d2", name: "Gone", active: false }, { id: "w1", name: "Window", category: "window" }],
  });
  assertEquals(cols.map((c) => [c.key, c.section]), [["loft", "Built-in options"], ["d1", "Doors"], ["w1", "Windows"]]);
});

// ── What the adversarial review found (11-05). Each of these failed before its fix. ─────────────────

const two = (styles: SizeTable["styles"]): SizeTable => ({ styles, sizes: styles.map((s, i) => size(`z${i}`, s.id, 10, 12, 3000 + i)), inclusions: [] });
const runOn = (t: SizeTable, rows: ReadRow[], answers = {}) => {
  const r = resolveRows(t, rows, keys, answers);
  return { ...r, ...diffAgainst(t, columns, r.wanted, { skipped: r.skipped, questions: r.questions, coveredStyleIds: r.coveredStyleIds, makeId, mayCreate: true }) };
};

Deno.test("two styles with one name (a hidden one counts): nothing is written, whichever sorts last", () => {
  for (const styles of [[{ id: "live", label: "Barn" }, { id: "old", label: "Barn", active: false }], [{ id: "old", label: "Barn", active: false }, { id: "live", label: "Barn" }]]) {
    const r = runOn(two(styles), [row("Barn", 10, 12, "$5,000")]);
    assertEquals(r.payload, { creates: [], sizes: [] });
    assert(r.preview.skipped[0].why.includes("more than one"));
    assert(wantedFromRules(two(styles), [rule({ styles: ["Barn"], setPrice: 5 })], keys).error);
  }
});

Deno.test("a hidden style says so on its buttons and its tab", () => {
  const t = two([{ id: "live", label: "Barn" }, { id: "old", label: "Shed", active: false }]);
  assert(runOn(t, [row("Dutch", 10, 12, "$5,000")]).preview.questions[0].options.some((o) => o.label === "Use my Shed (hidden)"));
  assertEquals(runOn(t, [row("Shed", 10, 12, "$5,000")]).preview.styles[0].label, "Shed (hidden)");
});

Deno.test("Premium+ isn't Premium, and each price lands on its own style", () => {
  const only = two([{ id: "p", label: "Premium" }]);
  assertEquals(runOn(only, [row("Premium+", 10, 12, "$5,000")]).preview.questions.length, 1);
  const both = two([{ id: "p", label: "Premium" }, { id: "pp", label: "Premium+" }]);
  const r = runOn(both, [row("Premium", 10, 12, "$4,100"), row("Premium+", 10, 12, "$5,100")]);
  assertEquals(r.payload.sizes.map((s) => [s.id, s.to.price]), [["z0", 4100], ["z1", 5100]]);
  assertEquals(r.preview.counts.flagged, 0);
});

Deno.test("an exact name wins, and a loose name that fits two styles asks", () => {
  const t = two([{ id: "a", label: "Cabin" }, { id: "b", label: "Cabins" }]);
  assertEquals(runOn(t, [row("Cabins", 10, 12, "$5,000")]).payload.sizes[0].id, "z1");
  assertEquals(runOn(t, [row("CABIN!", 10, 12, "$5,000")]).preview.questions.length, 1);
});

Deno.test("an answer comes before a match: skip skips even once the style exists", () => {
  const t = two([{ id: "a", label: "Dutch Barn" }]);
  assertEquals(runOn(t, [row("Dutch Barn", 10, 12, "$5,000")], { styles: { "Dutch Barn": "skip" } }).payload.sizes, []);
});

Deno.test("price text that isn't plainly a price never becomes one", () => {
  for (const bad of ["1.200,00", "4.200", "4200,00", "$4,200 $4,600", "4200\n4600", "1e3", "0x1F", "4,2", "$4,20", "1,2,3", "4 200"]) {
    const r = run([row("Garden Shed", 10, 12, bad)]);
    assertEquals(r.payload.sizes, [], bad);
    assertEquals(r.preview.skipped.length, 1, bad);
  }
  for (const [good, want] of [["1,200.00", 1200], ["$4,200", 4200], ["$ 4,800", 4800], ["4200", 4200], ["4800.50", 4800.5]] as [string, number][]) {
    assertEquals(run([row("Garden Shed", 10, 12, good)]).payload.sizes[0].to, { price: want }, good);
  }
});

Deno.test("a formula's long decimal is rounded, so the card and the save agree", () => {
  assertEquals(run([row("Garden Shed", 10, 12, "4288.9275")]).payload.sizes[0].to, { price: 4288.93 });
  const noise = run([row("Garden Shed", 10, 12, "4000.0000000000005")]);
  assertEquals(noise.payload.sizes, []);
  assertEquals(noise.preview.counts.same, 1);
  assertEquals(run([row("Garden Shed", 10, 12, "0.0004")]).preview.questions.map((q) => q.id), ["zero"]);
});

Deno.test("option boxes don't glue digits together", () => {
  assertEquals(readOptionCell("1,000"), 1000);
  for (const bad of ["2, 1", "1 2", "1,2"]) assertEquals(readOptionCell(bad), null, bad);
});

Deno.test("a yes-word keeps the quantity on file", () => {
  const t: SizeTable = { ...table, inclusions: [{ size_id: "s1", item_key: "loft", included: true, qty: 50 }] };
  assertEquals(readOptionCell("X"), "yes");
  assertEquals(runOn(t, [row("Garden Shed", 10, 12, "", { loft: "Yes" })]).payload.sizes, []);
  assertEquals(runOn(t, [row("Garden Shed", 10, 14, "", { loft: "x" })]).payload.sizes[0].to, { cells: { loft: 1 } });
  assertEquals(runOn(t, [row("Garden Shed", 10, 12, "", { loft: "3" })]).payload.sizes[0].to, { cells: { loft: 3 } });
  assertEquals(runOn(t, [row("Garden Shed", 10, 40, "$1,000", { loft: "y" })]).payload.creates[0].cells, { loft: 1 });
});

Deno.test("same size twice: what the card says is what gets written", () => {
  const callLater = run([row("Garden Shed", 10, 12, "$5,000"), row("Garden Shed", 10, 12, "Call for price")]);
  assertEquals(callLater.payload.sizes, []);
  assert(callLater.preview.skipped[0].why.includes("old price stays"));
  const callFirst = run([row("Garden Shed", 10, 12, "Call for price"), row("Garden Shed", 10, 12, "$4,100")]);
  assertEquals(callFirst.payload.sizes[0].to, { price: 4100 });
  assertEquals(callFirst.preview.skipped, []);
  assertEquals(callFirst.preview.styles[0].rows[0].flags, ["same_size_twice"]);
  const naFirst = run([row("Garden Shed", 10, 12, "N/A"), row("Garden Shed", 10, 12, "$4,100")]);
  assertEquals(naFirst.preview.styles[0].rows[0].flags, ["same_size_twice"]);
  const zeroLater = run([row("Garden Shed", 10, 12, "$5,000"), row("Garden Shed", 10, 12, "$0")], { zero: "skip" });
  assertEquals(zeroLater.payload.sizes, []);
});

Deno.test("a sentence can't price below zero, and $0 is flagged however it got there", () => {
  assert(wantedFromRules(table, [rule({ raisePercent: -150 })], keys).error);
  assert(wantedFromRules(table, [rule({ raiseDollars: -3500 })], keys).error);
  // A cut to $0 is a cut of more than half, so a sentence can't make it (11-09): a price set to $0 can.
  assertEquals(wantedFromRules(table, [rule({ widths: [8], raiseDollars: -3000 })], keys), { wanted: [], error: PREVIEW_SAID.cutTooBig });
  const set = wantedFromRules(table, [rule({ widths: [8], setPrice: 0 })], keys);
  assertEquals(set.error, null);
  const free = diffAgainst(table, columns, set.wanted, { makeId, mayCreate: false });
  assertEquals(free.payload.sizes[0].to, { price: 0 });
  assert(free.preview.styles[0].rows[0].flags.includes("zero"));
  assertEquals(free.preview.counts.flagged, 1);
});

Deno.test("a raise above 100% or a cut above 50% from a sentence is refused, and points to the table", () => {
  // "Raise everything 500%" is refused whole: nothing is changed.
  for (const pct of [500, 100.5, 101]) assertEquals(wantedFromRules(table, [rule({ raisePercent: pct })], keys), { wanted: [], error: PREVIEW_SAID.raiseTooBig });
  for (const pct of [-51, -50.5, -90]) assertEquals(wantedFromRules(table, [rule({ raisePercent: pct })], keys), { wanted: [], error: PREVIEW_SAID.cutTooBig });
  assertEquals(RAISE_MAX_PCT, 100);
  assertEquals(CUT_MAX_PCT, 50);
  for (const said of [PREVIEW_SAID.raiseTooBig, PREVIEW_SAID.cutTooBig]) {
    assert(said.includes("Sizes & prices table in Settings > Sheds") && said.endsWith("Nothing was changed."), said);
    assert(!/—|quote/i.test(said), said);
  }
  // Doubling, and halving, are the edges, and stand.
  const doubled = wantedFromRules(table, [rule({ widths: [8], raisePercent: 100 })], keys);
  assertEquals([doubled.error, doubled.wanted[0].price], [null, 6000]);
  const halved = wantedFromRules(table, [rule({ widths: [8], raisePercent: -50 })], keys);
  assertEquals([halved.error, halved.wanted[0].price], [null, 1500]);
  // A dollar raise is held to the same limits size by size: $5,000 more is more than double a $3,000 8x10.
  assertEquals(wantedFromRules(table, [rule({ raiseDollars: 5000 })], keys).error, PREVIEW_SAID.raiseTooBig);
  assertEquals(wantedFromRules(table, [rule({ raiseDollars: -2000 })], keys).error, PREVIEW_SAID.cutTooBig);
  // Raises that add up are held to them too: 60% and then 60% again is 156%.
  assertEquals(wantedFromRules(table, [rule({ raisePercent: 60 }), rule({ raisePercent: 60 })], keys).error, PREVIEW_SAID.raiseTooBig);
  // Not a number at all is refused, never worked through.
  assertEquals(wantedFromRules(table, [rule({ raisePercent: Number.NaN })], keys).error, PREVIEW_SAID.badRaise);
  assertEquals(wantedFromRules(table, [rule({ raiseDollars: Number.POSITIVE_INFINITY })], keys).error, PREVIEW_SAID.badRaise);
});

Deno.test("a set price and a raise are held under $1,000,000, a raise on a $0 size too, and Infinity is no price (11-09)", () => {
  const free = { ...table, sizes: [...table.sizes, size("s6", "garden", 6, 8, 0)] };
  // 1e400 in the tool's input parses to Infinity, which would be stored as null and clear the price.
  assertEquals(JSON.parse('{"v":1e400}').v, Number.POSITIVE_INFINITY);
  assertEquals(wantedFromRules(table, [rule({ widths: [8], setPrice: Number.POSITIVE_INFINITY })], keys).error, "A price is a number, 0 or more.");
  assertEquals(wantedFromRules(table, [rule({ widths: [8], setPrice: 1_000_000 })], keys), { wanted: [], error: PREVIEW_SAID.tooHigh });
  assertEquals(wantedFromRules(free, [rule({ widths: [6], raiseDollars: 1_000_000 })], keys), { wanted: [], error: PREVIEW_SAID.tooHigh });
  assertEquals(wantedFromRules(free, [rule({ widths: [6], setPrice: 0 }), rule({ widths: [6], raiseDollars: 999_999.99 })], keys).error, null);
  // Under the ceiling a big set price is flagged, never stopped: a size typed in as $400 can be set to $4,000.
  const big = wantedFromRules(table, [rule({ widths: [8], setPrice: 44_000 })], keys);
  assertEquals([big.error, big.wanted[0].price, big.wanted[0].flags.includes("big_change")], [null, 44_000, true]);
});

Deno.test("a price a sentence moves by more than 25% either way is flagged on the card; 25% or less isn't", () => {
  const flagsOf = (rules: SizeRule[]) => {
    const made = wantedFromRules(table, rules, keys);
    assertEquals(made.error, null);
    const { preview } = diffAgainst(table, columns, made.wanted, { makeId, mayCreate: false });
    return { rows: Object.fromEntries(preview.styles.flatMap((s) => s.rows).map((r) => [r.label, r.flags])), flagged: preview.counts.flagged };
  };
  assertEquals(BIG_CHANGE_SHARE, 0.25);
  const up = flagsOf([rule({ styles: ["Garden Shed"], raisePercent: 30 })]);
  assert(["10x12", "10x14", "10x16", "8x10"].every((l) => up.rows[l].includes("big_change")), JSON.stringify(up.rows));
  assertEquals(up.flagged, 4, "a big change is something to look at");
  const down = flagsOf([rule({ styles: ["Garden Shed"], raisePercent: -30 })]);
  assert(Object.values(down.rows).every((f) => f.includes("big_change")), JSON.stringify(down.rows));
  const small = flagsOf([rule({ styles: ["Garden Shed"], raisePercent: 25 })]);
  assert(!Object.values(small.rows).some((f) => f.includes("big_change")), JSON.stringify(small.rows));
  // A price set from a sentence counts too: $4,000 to $6,000 is 50% more. $4,500 isn't past a quarter.
  assert(flagsOf([rule({ widths: [10], minLength: 12, maxLength: 12, setPrice: 6000 })]).rows["10x12"].includes("big_change"));
  assert(!flagsOf([rule({ widths: [10], minLength: 12, maxLength: 12, setPrice: 4500 })]).rows["10x12"].includes("big_change"));
  // A dollar raise is measured size by size: $1,000 more is 33% on the 8x10 and 20% on the 10x16.
  const dollars = flagsOf([rule({ raiseDollars: 1000 })]);
  assertEquals([dollars.rows["8x10"].includes("big_change"), dollars.rows["10x16"].includes("big_change")], [true, false]);
  // A sheet's prices are read from the builder's own file, so the flag is the sentence's alone.
  const { preview } = run([row("Garden Shed", 10, 12, "$9,000")]);
  assert(!preview.styles[0].rows[0].flags.includes("big_change"));
});

Deno.test("two rules on one size add up", () => {
  const made = wantedFromRules(table, [rule({ widths: [8], setPrice: 1000 }), rule({ widths: [8], raisePercent: 10 })], keys);
  assertEquals(made.wanted[0].price, 1100);
});

Deno.test("a price on an unpriced size says it goes on sale, and doesn't count as a worry", () => {
  const { preview } = run([row("Lofted Barn", 12, 24, "$9,000")]);
  assertEquals(preview.styles[0].rows[0].flags, ["goes_on_sale"]);
  assertEquals(preview.counts.flagged, 0);
});

Deno.test("a new size needs a price or an option above 0", () => {
  const { payload, preview } = run([row("Garden Shed", 10, 30, "", { single: "0" }), row("Garden Shed", 10, 36, "$0", { single: "0" })], { zero: "skip" });
  assertEquals(payload.creates, []);
  assertEquals(preview.counts.added, 0);
});

Deno.test("a size the wrong way round is flagged, and a rounded size finds the real one", () => {
  const flipped = run([row("Garden Shed", 12, 10, "$4,100")]);
  assertEquals(flipped.preview.styles[0].rows[0].flags, ["reversed_size"]);
  const wide = run([row("Garden Shed", 16, 8, "$4,100")]);
  assertEquals(wide.preview.styles[0].rows[0].flags, ["reversed_size"]);
  assert(!run([row("Garden Shed", 10, 20, "$6,000")]).preview.styles[0].rows[0].flags.length);
  const t: SizeTable = { ...table, sizes: [size("x", "garden", 10.6667, 12, 4000)] };
  const r = runOn(t, [row("Garden Shed", 10.67, 12, "$4,100")]);
  assertEquals(r.payload.creates, []);
  assertEquals(r.payload.sizes[0].id, "x");
});

Deno.test("flags: a size priced past a bigger one, and one below a narrower one", () => {
  const t: SizeTable = { styles: [{ id: "g", label: "G" }], inclusions: [], sizes: [size("a", "g", 10, 12, 4200), size("b", "g", 10, 14, 4800), size("c", "g", 10, 16, 5400), size("d", "g", 10, 20, 6600), size("e", "g", 12, 12, 5000), size("f", "g", 12, 16, 6400)] };
  const high = runOn(t, [row("G", 10, 12, "$9,000")]);
  assertEquals(high.preview.styles[0].rows[0].flags, ["above_bigger"]);
  const low = runOn(t, [row("G", 12, 12, "$3,000")]);
  assert(low.preview.styles[0].rows[0].flags.includes("below_smaller"));
  // More building for less isn't flagged when neither is at least as big both ways.
  assertEquals(runOn(t, [row("G", 12, 12, "$5,100")]).preview.styles[0].rows[0].flags, []);
});

Deno.test("Real-Time Pricing: prices go on the list, options still work, and nothing counts as the same", () => {
  const t: SizeTable = { ...table, rtpOn: true };
  const price = runOn(t, [row("Garden Shed", 10, 12, "$4,400")]);
  assertEquals(price.payload.sizes, []);
  assertEquals(price.preview.counts.same, 0);
  assert(price.preview.skipped[0].why.includes("Real-Time Pricing"));
  const both = runOn(t, [row("Garden Shed", 10, 14, "$4,700", { single: "2" })]);
  assertEquals(both.payload.sizes[0].to, { cells: { single: 2 } });
  const created = runOn(t, [row("Garden Shed", 10, 30, "$6,000"), row("Garden Shed", 10, 32, "$6,000", { single: "1" })]);
  assertEquals(created.payload.creates.map((c) => [c.label, c.price]), [["10x32", null]]);
});

Deno.test("$0 only asks about rows that can be written", () => {
  const rows = [row("Dutch Barn", 10, 12, "$0"), row("Garden Shed", 10, 12, "$5,000")];
  assertEquals(run(rows, { styles: { "Dutch Barn": "skip" } }).preview.questions, []);
  assertEquals(run(rows).preview.questions.map((q) => q.kind), ["style"]);
  assertEquals(run(rows, { styles: { "Dutch Barn": "barn" } }).preview.questions.map((q) => q.kind), ["zero"]);
});

Deno.test("door columns read the way the table and its template write them", () => {
  const cols = columnsFromCatalog({ items: [], fixtures: [{ id: "d", name: "Single door", width_in: 36, height_in: 80 }] });
  assertEquals(cols[0].label, `Single door (3'x6'8")`);
});

// ── The second check (11-06) ─────────────────────────────────────────────────────────────────────

Deno.test("a rounded size is the stored size everywhere: flags and yes-words too", () => {
  const t: SizeTable = { styles: [{ id: "g", label: "G" }], sizes: [size("a", "g", 10.6667, 12, 4000), size("b", "g", 10, 12, 3800), size("c", "g", 12, 12, 4800), size("d", "g", 10, 16, 5000)], inclusions: [{ size_id: "a", item_key: "loft", included: true, qty: 50 }] };
  const cut = runOn(t, [row("G", 10.67, 12, "$3,900")]);
  assertEquals(cut.preview.styles[0].rows[0].flags, []);
  const both = runOn(t, [row("G", 10.67, 12, "$4,100"), row("G", 10, 12, "$4,050")]);
  assert(both.preview.styles[0].rows.every((r) => !r.flags.includes("above_bigger")), JSON.stringify(both.preview.styles[0].rows));
  assertEquals(runOn(t, [row("G", 10.67, 12, "", { loft: "Yes" })]).payload.sizes, []);
});

Deno.test("Real-Time Pricing: a $0 or N/A asks nothing and flags nothing", () => {
  const t: SizeTable = { ...table, rtpOn: true };
  const zero = runOn(t, [row("Garden Shed", 10, 12, "$0", { single: "2" })]);
  assertEquals(zero.preview.questions, []);
  assertEquals(zero.preview.styles[0].rows[0].flags, []);
  assertEquals(zero.payload.sizes[0].to, { cells: { single: 2 } });
  const na = runOn(t, [row("Garden Shed", 10, 14, "N/A", { single: "1" })]);
  assertEquals(na.preview.counts.flagged, 0);
});

Deno.test("$0 counts sizes whose last word is $0, and an answer of no says so", () => {
  assertEquals(run([row("Garden Shed", 10, 12, "$0"), row("Garden Shed", 10, 12, "$4,100")]).preview.questions, []);
  assertEquals(run([row("Garden Shed", 10, 12, "$0"), row("Garden Shed", 10, 12, "$0")]).preview.questions[0].rows, 1);
  assert(run([row("Garden Shed", 10, 12, "$0")], { zero: "skip" }).preview.skipped[0].why.includes("isn't free"));
});

Deno.test("a hidden exact name doesn't quietly beat a live near one", () => {
  const t = two([{ id: "old", label: "Barn", active: false }, { id: "live", label: "Barns" }]);
  const r = runOn(t, [row("Barn", 10, 12, "$5,000")]);
  assertEquals(r.payload.sizes, []);
  assertEquals(r.preview.questions.length, 1);
});
