// submit-estimate's declined-included-item credit, run against the SHIPPED source.
//
// Why this test exists. `declinedItems` is body-supplied on an endpoint the public anon key
// reaches, and each declined key is credited the size's WHOLE included quantity, baked into the
// building line (any excess spills into the invoice discount). The designer toggles keys as a set,
// so it never sends one twice — but nothing on the server said so, and a hand-built POST repeating
// ["window", "window", …] collected the credit once per copy until the quote reached $0.
//
// Same technique as captureLeadGuards_test / crmRecordGate_test: lift the real loop out of the
// shipped file between stable anchors, guard loudly if they move, then run it. A copy of the
// logic here would keep passing while the real file drifted.

import { assertEquals } from "jsr:@std/assert";

const SRC = (await Deno.readTextFile(
  new URL("../../submit-estimate/index.ts", import.meta.url),
)).replace(/\r\n/g, "\n");

const LOOP = "for (const d of declinedItems) {";
const loopAt = SRC.indexOf(LOOP);
if (loopAt < 0) {
  throw new Error(
    "declinedCredit_test: could not find `for (const d of declinedItems) {` in " +
      "supabase/functions/submit-estimate/index.ts. The anchor moved — re-point it rather than deleting this test.",
  );
}
// The dedupe set is declared just above the loop; include it when it is there.
const SET_DECL = "const creditedKeys = new Set<string>();";
const setAt = SRC.lastIndexOf(SET_DECL, loopAt);
const start = setAt >= 0 && loopAt - setAt < 200 ? setAt : loopAt;
// Walk to the loop's matching close brace.
let depth = 0, end = -1;
for (let k = loopAt + LOOP.length - 1; k < SRC.length; k++) {
  if (SRC[k] === "{") depth++;
  else if (SRC[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
}
if (end < 0) throw new Error("declinedCredit_test: the declined-items loop never closed — the anchor moved.");

// The two TypeScript-only spellings in that block, removed so it runs as plain JS.
const BODY = SRC.slice(start, end + 1)
  .replace(/new Set<[^>]+>\(/g, "new Set(")
  .replace(/\)!/g, ")");

// deno-lint-ignore no-explicit-any
const run = new Function(
  "declinedItems", "placedKeys", "declFxPrice", "includedMap", "layoutRates",
  "buildingArea", "buildingPerimeter", "buildingPrice",
  `let bakedCredit = 0; const creditNotes = [];\n${BODY}\nreturn { bakedCredit, creditNotes };`,
) as (...a: unknown[]) => { bakedCredit: number; creditNotes: string[] };

const ctx = () => ({
  placedKeys: new Set<string>(),
  declFxPrice: new Map<string, number>([["fx-door-uuid", 400]]),
  // The size includes 2 windows and 1 catalog door.
  includedMap: new Map<string, number>([["window", 2], ["fx-door-uuid", 1]]),
  layoutRates: new Map<string, { rate: number; method: string }>([["window", { rate: 150, method: "each" }]]),
});
const go = (declined: unknown[]) => {
  const c = ctx();
  return run(declined, c.placedKeys, c.declFxPrice, c.includedMap, c.layoutRates, 120, 44, 5000);
};

Deno.test("a declined inclusion is credited once: its whole included quantity", () => {
  const r = go([{ key: "window", label: "Window" }]);
  assertEquals(r.bakedCredit, 300);
  assertEquals(r.creditNotes.length, 1);
});

Deno.test("repeating a declined key in the body does NOT repeat the credit", () => {
  const r = go(Array.from({ length: 20 }, () => ({ key: "window", label: "Window" })));
  assertEquals(r.bakedCredit, 300, "twenty copies of one decline are one decline");
  assertEquals(r.creditNotes.length, 1);
});

Deno.test("a repeated catalog-fixture decline is credited once too", () => {
  const r = go([{ key: "fx-door-uuid" }, { key: "fx-door-uuid" }, { key: " fx-door-uuid " }]);
  assertEquals(r.bakedCredit, 400);
});

Deno.test("two different declined inclusions still each get their credit", () => {
  const r = go([{ key: "window" }, { key: "fx-door-uuid" }, { key: "window" }]);
  assertEquals(r.bakedCredit, 700);
});
