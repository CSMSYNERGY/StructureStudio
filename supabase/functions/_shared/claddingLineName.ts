/**
 * The NAME a quote's cladding line carries (submit-estimate), pulled out here so it can be tested.
 *
 * In order:
 *  1. the builder's own name for it (style_cladding.label_override), always;
 *  2. the name the customer AGREED to, when the design has been accepted and the cladding id is
 *     still the one they agreed to;
 *  3. the designer's built-in label (the submit payload's `cladding`), then the bare id.
 *
 * Why (2) exists. changeOrderDiff matches lines on itemKey + name, and a cladding line has no
 * itemKey, so its name IS its identity. When the built-in label changed ("Metal" became "AG Panel"
 * on 2026-09-15), every resubmit of an order signed before that read as "Removed: Metal / Added:
 * AG Panel": a change order for a change nobody made, which also kept the auto-void from firing and
 * so blocked the invoice behind it. Keeping the agreed words while the product is unchanged makes a
 * relabel a non-event for orders already signed. It is keyed on the ID, so swapping to a different
 * cladding still reads as exactly the change it is, and a new or unsigned quote gets today's name.
 *
 * Deliberately NOT fixed inside changeOrderDiff: that module is bundled into four functions plus
 * invoicePayment, and every one would have to be redeployed together for a naming question that
 * only this function's line builder can cause.
 *
 * Dependency-free on purpose, like the other _shared modules with tests.
 */
// deno-lint-ignore-file no-explicit-any
export function cladLineName(args: {
  override?: string | null;
  browserLabel?: unknown;
  claddingId: string;
  accepted: boolean;
  agreed?: { lines?: any; selections?: any } | null;
}): string {
  const own = String(args.override ?? "").trim();
  if (own) return own;
  if (args.accepted && args.agreed) {
    const agreedId = String(args.agreed.selections?.claddingId ?? "").trim();
    if (agreedId && agreedId === args.claddingId) {
      // agreedBaseline() hands back the snapshot object ({ lines: [...] }); accept a bare array too.
      const snap = args.agreed.lines;
      const lines: any[] = Array.isArray(snap) ? snap : (snap && Array.isArray(snap.lines) ? snap.lines : []);
      const prev = lines.find((l) => String(l?.kind ?? "") === "cladding");
      const prevName = String(prev?.name ?? "").trim();
      if (prevName) return prevName;
    }
  }
  return String(args.browserLabel ?? "").trim() || args.claddingId;
}
