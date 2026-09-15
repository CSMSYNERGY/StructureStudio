// Unit tests for cladLineName (2026-09-15): the NAME a resubmitted quote's cladding line carries.
//
// WHY THESE EXIST. A cladding line has no itemKey, so changeOrderDiff matches it on its name.
// Relabelling the built-in "Metal" to "AG Panel" therefore turned every resubmit of an order signed
// before the relabel into "Removed: Metal / Added: AG Panel" -- a change order nobody made, which
// also kept the auto-void from firing and so blocked the invoice. The property pinned here is that
// a relabel is a non-event for a signed order, while a real cladding swap still reads as one.
//
// Deliberately dependency-free (no jsr:/npm: imports), the same rule the other _shared tests follow.
import { cladLineName } from "./claddingLineName.ts";
import { changeOrderDescription } from "./changeOrderDiff.ts";

function check(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

const BUILDING = { kind: "building", itemKey: "", name: "12x24 Utility", desc: "", qty: 1, amount: 9000 };
const clad = (name: string, qty = 960, amount = 2) =>
  ({ kind: "cladding", itemKey: "", name, desc: `${qty} sq ft of wall at $2.00 each`, qty, amount });
const snapOf = (lines: unknown[]) => ({ version: 1, discount: 0, lines });
// What agreedBaseline() hands back for an order signed while the built-in label was still "Metal".
const SIGNED = { lines: snapOf([BUILDING, clad("Metal")]), selections: { claddingId: "agpanel" } };

Deno.test("a signed order keeps its agreed cladding name, so a relabel raises no change order", () => {
  const name = cladLineName({ override: null, browserLabel: "AG Panel", claddingId: "agpanel", accepted: true, agreed: SIGNED });
  check("keeps the agreed name", name === "Metal", name);
  const text = changeOrderDescription(SIGNED.lines, snapOf([BUILDING, clad(name)]));
  check("no change order", text === null, String(text));
  // The failure this prevents, pinned so the test cannot pass for a reason that has nothing to do with it.
  const naive = changeOrderDescription(SIGNED.lines, snapOf([BUILDING, clad("AG Panel")]));
  check("the relabelled name alone does raise one", !!naive && naive.includes("Removed: Metal"), String(naive));
});

Deno.test("swapping to a different cladding still reads as the change it is", () => {
  const name = cladLineName({ override: null, browserLabel: "Lap Siding", claddingId: "lap", accepted: true, agreed: SIGNED });
  check("today's name for the new cladding", name === "Lap Siding", name);
  const text = changeOrderDescription(SIGNED.lines, snapOf([BUILDING, clad(name)]));
  check("reported as added", !!text && text.includes("Added: Lap Siding"), String(text));
  check("and the old one as removed", !!text && text.includes("Removed: Metal"), String(text));
});

Deno.test("a price change on the agreed cladding is still reported under its agreed name", () => {
  const name = cladLineName({ override: null, browserLabel: "AG Panel", claddingId: "agpanel", accepted: true, agreed: SIGNED });
  const text = changeOrderDescription(SIGNED.lines, snapOf([BUILDING, clad(name, 1040)]));
  check("quantity move named", !!text && text.includes("Metal: quantity 960 → 1040"), String(text));
  check("no phantom add/remove", !!text && !text.includes("Added:") && !text.includes("Removed:"), String(text));
});

Deno.test("the builder's own name always wins", () => {
  const name = cladLineName({ override: "  Steel Siding ", browserLabel: "AG Panel", claddingId: "agpanel", accepted: true, agreed: SIGNED });
  check("override", name === "Steel Siding", name);
});

Deno.test("an unsigned quote, or a signed one with no cladding line, gets today's name", () => {
  const unsigned = cladLineName({ override: null, browserLabel: "AG Panel", claddingId: "agpanel", accepted: false, agreed: SIGNED });
  check("unsigned", unsigned === "AG Panel", unsigned);
  // Included at $0 when it was signed, so there was no line to take a name from.
  const noLine = cladLineName({ override: "", browserLabel: "AG Panel", claddingId: "agpanel", accepted: true,
    agreed: { lines: snapOf([BUILDING]), selections: { claddingId: "agpanel" } } });
  check("no agreed line", noLine === "AG Panel", noLine);
  const bare = cladLineName({ override: null, browserLabel: "  ", claddingId: "agpanel", accepted: false, agreed: null });
  check("falls back to the id", bare === "agpanel", bare);
});
