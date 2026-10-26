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
import { agreedBaseline, changeOrderDescription } from "./changeOrderDiff.ts";

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

// ── The lap rename and the fifth cladding (2026-10-06) ──────────────────────────────────────────
// Lap's built-in name became 7" LP Lap Siding with its drawing unchanged, and 4.5" Vinyl Siding
// ("vinyl") joined as its own id. The same property as the Metal → AG Panel relabel above: the
// rename is a non-event for an order already signed, while a real swap to vinyl reads as one.
const SIGNED_LAP = { lines: snapOf([BUILDING, clad("Lap Siding")]), selections: { claddingId: "lap" } };

Deno.test("a signed lap order agreed as \"Lap Siding\" keeps that name when resubmitted under 7\" LP Lap Siding", () => {
  const name = cladLineName({ override: null, browserLabel: '7" LP Lap Siding', claddingId: "lap", accepted: true, agreed: SIGNED_LAP });
  check("keeps the agreed name", name === "Lap Siding", name);
  const text = changeOrderDescription(SIGNED_LAP.lines, snapOf([BUILDING, clad(name)]));
  check("no change order", text === null, String(text));
  const naive = changeOrderDescription(SIGNED_LAP.lines, snapOf([BUILDING, clad('7" LP Lap Siding')]));
  check("the new name alone would have raised one", !!naive && naive.includes("Removed: Lap Siding"), String(naive));
});

Deno.test("an unsigned lap quote gets the new name", () => {
  const name = cladLineName({ override: null, browserLabel: '7" LP Lap Siding', claddingId: "lap", accepted: false, agreed: SIGNED_LAP });
  check("new name", name === '7" LP Lap Siding', name);
});

Deno.test("lap changed to vinyl on a signed order reads as the Added/Removed change it is", () => {
  const name = cladLineName({ override: null, browserLabel: '4.5" Vinyl Siding', claddingId: "vinyl", accepted: true, agreed: SIGNED_LAP });
  check("vinyl's own name", name === '4.5" Vinyl Siding', name);
  const text = changeOrderDescription(SIGNED_LAP.lines, snapOf([BUILDING, clad(name)]));
  check("reported as added", !!text && text.includes('Added: 4.5" Vinyl Siding'), String(text));
  check("and lap as removed, under its agreed name", !!text && text.includes("Removed: Lap Siding"), String(text));
});

// ── The snapshot as production actually stores it (2026-10-06) ──────────────────────────────────
// Every fixture above names the agreed id `claddingId`, the SUBMIT BODY's key. A real signed order's
// accepted_snapshot.selections is designs.selections verbatim (customer-accept stamps it, the
// designer saves `p_selections: sel`), and that object keeps the id under `cladding`; `claddingId`
// is there only after an order-screen attribute change. The guard read `claddingId` alone, so on an
// ordinary signed order it never fired and the rename raised the change order it exists to stop.
// These go through agreedBaseline() itself, from the design row's own shape.
const signedRow = (cladName: string, selections: Record<string, unknown>) => ({
  accepted_at: "2026-10-01T12:00:00Z",
  estimate_lines: snapOf([BUILDING, clad(cladName)]),
  accepted_snapshot: { estimateLines: snapOf([BUILDING, clad(cladName)]), selections, paintColors: {} },
});

Deno.test("a signed lap order in the stored shape (selections.cladding) keeps \"Lap Siding\": no change order", () => {
  const agreed = agreedBaseline(signedRow("Lap Siding", { style: "deluxe", cladding: "lap" }));
  const name = cladLineName({ override: null, browserLabel: '7" LP Lap Siding', claddingId: "lap", accepted: true, agreed });
  check("keeps the agreed name", name === "Lap Siding", name);
  const text = changeOrderDescription(agreed.lines, snapOf([BUILDING, clad(name)]));
  check("no change order", text === null, String(text));
});

Deno.test("the Metal → AG Panel relabel, in the stored shape, is a non-event too", () => {
  const agreed = agreedBaseline(signedRow("Metal", { style: "deluxe", cladding: "agpanel" }));
  const name = cladLineName({ override: null, browserLabel: "AG Panel", claddingId: "agpanel", accepted: true, agreed });
  check("keeps the agreed name", name === "Metal", name);
  check("no change order", changeOrderDescription(agreed.lines, snapOf([BUILDING, clad(name)])) === null);
});

Deno.test("stored shape: a swap to vinyl still reads as one, and an order-screen change (both keys) still matches", () => {
  const agreed = agreedBaseline(signedRow("Lap Siding", { cladding: "lap" }));
  const vinyl = cladLineName({ override: null, browserLabel: '4.5" Vinyl Siding', claddingId: "vinyl", accepted: true, agreed });
  check("vinyl's own name", vinyl === '4.5" Vinyl Siding', vinyl);
  const text = changeOrderDescription(agreed.lines, snapOf([BUILDING, clad(vinyl)]));
  check("added and removed", !!text && text.includes('Added: 4.5" Vinyl Siding') && text.includes("Removed: Lap Siding"), String(text));
  // portal-settings' attribute change writes both keys, equal.
  const both = agreedBaseline(signedRow("Lap Siding", { cladding: "lap", claddingId: "lap" }));
  const kept = cladLineName({ override: null, browserLabel: '7" LP Lap Siding', claddingId: "lap", accepted: true, agreed: both });
  check("both keys", kept === "Lap Siding", kept);
  // A design accepted before 153 has no snapshot: agreedBaseline falls back to the live row.
  const pre153 = agreedBaseline({ accepted_at: "2026-08-01T12:00:00Z", estimate_lines: snapOf([BUILDING, clad("Lap Siding")]), selections: { cladding: "lap" } });
  const old = cladLineName({ override: null, browserLabel: '7" LP Lap Siding', claddingId: "lap", accepted: true, agreed: pre153 });
  check("pre-153 order", old === "Lap Siding", old);
});
