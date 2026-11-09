import { assert, assertEquals, assertThrows } from "./test_assert.ts";
import { type Block, cleanSheets, compareReads, normStyle, parseFeet, parseSizeText, readBlock, type Sheet, sheetsForPrompt } from "./sheet.ts";

const block = (over: Partial<Block>): Block => ({
  kind: "list", sheet: 0, firstRow: 1, lastRow: 1, styleCol: null, styleFixed: null, sizeCol: null, widthCol: null, lengthCol: null,
  priceCol: null, stylesAcross: [], lengthHeaderRow: null, firstPriceCol: null, lastPriceCol: null, options: [], ...over,
});

Deno.test("sizes read the ways builders write them", () => {
  for (const s of ["10x12", "10 x 12", "10'x12'", "10' X 12'", "10 by 12", "10×12", "10 ft x 12 ft"]) {
    assertEquals(parseSizeText(s), { width: 10, length: 12 }, s);
  }
  assertEquals(parseSizeText(`10'6" x 12'`), { width: 10.5, length: 12 });
  for (const s of ["", "10", "garden shed", "10x", "x12", "10x12x8"]) assertEquals(parseSizeText(s), null, s);
  assertEquals(parseFeet("0"), null);
  assertEquals(parseFeet("501"), null);
  assertEquals(parseFeet("12"), 12);
});

Deno.test("style names ignore case, punctuation and a trailing s", () => {
  assertEquals(normStyle("Garden Sheds"), normStyle("garden shed"));
  assertEquals(normStyle("Lofted-Barn"), normStyle("lofted barn"));
  assert(normStyle("Dutch Barn") !== normStyle("Lofted Barn"));
  assertEquals(normStyle("Glass"), "glass");
});

Deno.test("a list block reads the digits from the cells it points at", () => {
  const sheets: Sheet[] = [{ name: "Prices", rows: [
    ["Style", "Size", "Price", "Single door"],
    ["Garden Sheds", "10x12", "$4,200", "1"],
    ["", "10x14", "4,600", ""],
    [],
    ["Lofted Barn", "12x24", "9000.50", "x"],
    ["Lofted Barn", "not a size", "1", ""],
  ] }];
  const { rows, problems } = readBlock(sheets, block({ lastRow: 5, styleCol: 0, sizeCol: 1, priceCol: 2, options: [{ col: 3, itemKey: "door1" }, { col: 3, itemKey: "not-theirs" }] }), new Set(["door1"]));
  assertEquals(rows.length, 3);
  // A style written once carries down, and the text stays exactly as the sheet has it.
  assertEquals(rows[1], { style: "Garden Sheds", width: 10, length: 14, priceText: "4,600", cells: { door1: "" }, where: "Prices row 3" });
  assertEquals(rows[2].priceText, "9000.50");
  // A key that isn't theirs is dropped, whatever the AI said.
  assertEquals(Object.keys(rows[0].cells), ["door1"]);
  assertEquals(problems, [{ where: "Prices row 6", text: "not a size", why: "couldn't read a size" }]);
});

Deno.test("styles across and a size grid read too", () => {
  const across: Sheet[] = [{ name: "A", rows: [["Size", "Garden", "Barn"], ["8x10", "$3,000", "$3,500"], ["8x12", "", "N/A"]] }];
  const a = readBlock(across, block({ kind: "styles_across", lastRow: 2, sizeCol: 0, stylesAcross: [{ col: 1, style: "Garden" }, { col: 2, style: "Barn" }] }), new Set());
  assertEquals(a.rows.map((r) => [r.style, r.width, r.length, r.priceText]), [["Garden", 8, 10, "$3,000"], ["Barn", 8, 10, "$3,500"], ["Barn", 8, 12, "N/A"]]);

  const grid: Sheet[] = [{ name: "Garden", rows: [["", "10'", "12'"], ["8'", "3000", "3400"], ["10'", "", "4100"]] }];
  const g = readBlock(grid, block({ kind: "size_grid", lastRow: 2, styleFixed: "Garden", widthCol: 0, lengthHeaderRow: 0, firstPriceCol: 1, lastPriceCol: 2 }), new Set());
  assertEquals(g.rows.map((r) => [r.width, r.length, r.priceText]), [[8, 10, "3000"], [8, 12, "3400"], [10, 12, "4100"]]);
});

Deno.test("a block that doesn't fit the sheet is refused, not guessed at", () => {
  const sheets: Sheet[] = [{ name: "A", rows: [["x"], ["y"]] }];
  assertThrows(() => readBlock(sheets, block({ sheet: 3, styleFixed: "S", sizeCol: 0, priceCol: 0 }), new Set()));
  assertThrows(() => readBlock(sheets, block({ lastRow: 9, styleFixed: "S", sizeCol: 0, priceCol: 0 }), new Set()));
  assertThrows(() => readBlock(sheets, block({ sizeCol: 0, priceCol: 0 }), new Set()));
  assertThrows(() => readBlock(sheets, block({ kind: "size_grid", styleFixed: "S" }), new Set()));
});

Deno.test("what the browser sends is capped and cleaned", () => {
  assert(cleanSheets([]).error);
  assert(cleanSheets([{ name: "A", rows: [["", ""]] }]).error);
  assert(cleanSheets([{ name: "A", rows: new Array(3001).fill(["x"]) }]).error);
  const ok = cleanSheets([{ name: "A", rows: [[" 10x12 ", 5, null]] }]);
  assertEquals(ok.error, null);
  assertEquals(ok.sheets[0].rows[0], ["10x12", "5", ""]);
});

Deno.test("the prompt gives every cell its coordinates and skips empties", () => {
  const text = sheetsForPrompt([{ name: "A", rows: [["10x12", "", "$5"], []] }]);
  assert(text.includes(`r0: c0="10x12" c2="$5"`));
  assert(!text.includes("r1:"));
});

Deno.test("two reads: only what both saw goes through, and any difference goes to a person", () => {
  const one = [
    { style: "Garden", size: "10x12", price: "$4,200" },
    { style: "Garden", size: "10x14", price: "$4,600" },
    { style: "Garden", size: "10x16", price: "$5,000" },
  ];
  const two = [
    { style: "Garden", size: "10 x 12", price: "4200" },
    { style: "Garden", size: "10x14", price: "$4,800" },
    { style: "Garden", size: "10x20", price: "$6,000" },
  ];
  const { rows, problems } = compareReads(one, two, "list.pdf");
  assertEquals(rows.map((r) => [r.width, r.length, r.priceText]), [[10, 12, "$4,200"]]);
  assertEquals(problems.length, 3);
  assert(problems[0].why.includes("$4,600") && problems[0].why.includes("$4,800"));
});

Deno.test("a plus keeps a style apart, in the reads too", () => {
  assert(normStyle("Premium+") !== normStyle("Premium"));
  assertEquals(normStyle("Premium+"), normStyle("Premium Plus"));
  const both = [{ style: "Premium", size: "10x12", price: "1" }, { style: "Premium+", size: "10x12", price: "2" }];
  assertEquals(compareReads(both, both, "x").rows.length, 2);
});

Deno.test("a grid column whose length can't be read is reported, not lost", () => {
  const sheets: Sheet[] = [{ name: "G", rows: [["", "8", "10", "12*", "14 (special)", "16", ""], ["10", "1000", "1100", "1200", "1300", "1400", ""]] }];
  const { rows, problems } = readBlock(sheets, block({ kind: "size_grid", lastRow: 1, styleFixed: "Garden", widthCol: 0, lengthHeaderRow: 0, firstPriceCol: 1, lastPriceCol: 6 }), new Set());
  assertEquals(rows.map((r) => r.length), [8, 10, 16]);
  assertEquals(problems.length, 2);
  assertEquals(problems[0].why, "couldn't read a length, so 1 price in this column wasn't read");
});

Deno.test("two reads: a size neither can parse is reported once", () => {
  const read = [{ style: "Garden", size: "10x14 (140 sq ft)", price: "$4,600" }];
  const { rows, problems } = compareReads(read, read, "list.pdf");
  assertEquals(rows, []);
  assertEquals(problems.length, 1);
  assertEquals(problems[0].why, "couldn't read a size");
});

Deno.test("past the column limit is refused, but blanks out there aren't", () => {
  const wide = new Array(120).fill("x");
  assert(cleanSheets([{ name: "A", rows: [[...wide, "past"]] }]).error);
  assertEquals(cleanSheets([{ name: "A", rows: [[...wide, "", " "]] }]).error, null);
});

Deno.test("only filled rows count toward the limit, and blank rows keep their place", () => {
  const rows: unknown[][] = [["Style", "Size"], ...new Array(3500).fill([]), ["Barn", "10x12"]];
  const ok = cleanSheets([{ name: "A", rows }]);
  assertEquals(ok.error, null);
  assertEquals(ok.sheets[0].rows.length, 3502);
  assertEquals(ok.sheets[0].rows[3501], ["Barn", "10x12"]);
});
