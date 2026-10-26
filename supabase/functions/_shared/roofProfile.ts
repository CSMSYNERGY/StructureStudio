/**
 * THE METAL ROOF PROFILE, PER DESIGN (2026-10-06). Pure, no I/O.
 *
 * Which metal a metal roof is: AG Panel or Standing Seam. Until 2026-10-06 that was a property of
 * the STYLE alone (building_styles.d3.roofProfile, set in Settings > Designer > 3D), on the premise
 * that a builder does not sell both profiles on one building. Carolyn answered on 10-06: "there is
 * no standard it is per individual design". So a design now carries its own pick, as
 * designs.selections.roofProfile, and the style's value is only the STARTING value for a design
 * that has not picked. AG Panel stays the default everywhere: absent on both means AG Panel.
 *
 * A SIGNED design that never picked takes the profile its agreed Roof line names, never the live
 * style (review 2026-10-07). The style's value is a starting value, not a live default: a builder
 * who sets a style to Standing Seam for future quotes must not reword the Roof line of every order
 * already signed on it, or the next paint change or resubmit on one of them raises "Roof: options
 * updated" for a roof nobody touched, and its crew card names a roof the customer did not buy.
 *
 * v1 is a LABEL, never a price: the Roof line keeps the roof colour's rate and its taxability, and a
 * rep adjusts the price by hand when a standing seam roof costs more. What changes is the words:
 * the Roof line reads "Metal (Standing Seam) — Black" ONLY when the effective profile is standing
 * seam, and every other design keeps today's string byte for byte. That matters because a Roof
 * description that changes on a signed order raises "Roof: options updated" (changeOrderDiff.ts),
 * and no design or style on the platform is standing seam today.
 *
 * The designer mirrors these rules in both twins: d3CustomerRoofProfile (beside
 * d3NormalizeRoofProfile) for the 3D, and computeSelectionRows' roof row for the Details panel.
 *
 * ⚠️ NAMING. "roofProfile" also names two unrelated things: the roof SHAPE self-check key in
 * styleD3.ts (the AI's "is the roof's cross-section right" answer) and the designer's d3RoofProfile()
 * geometry. Neither is the metal. The helpers here are normRoofProfile / effectiveRoofProfile /
 * roofLineDesc, and the designer's is d3CustomerRoofProfile, so a search for one never lands on the
 * others.
 *
 * Imported by submit-estimate (the quote's Roof line), attributeLines.ts (the order screen's
 * attribute change orders, so portal-settings) and portal-schedule (the crew card's roof type).
 * Bundled per function: a change here means redeploying all three.
 */

export type MetalRoofProfile = "agpanel" | "standingseam";

/** A profile id from anything a design, a style or a request body may hold: lowercased, with spaces,
 *  "_" and "-" taken out ("Standing Seam", "standing-seam", "AG_Panel"). Anything else is null, NOT
 *  AG Panel: a junk pick must fall through to the style's own value, never override it. */
export function normRoofProfile(v: unknown): MetalRoofProfile | null {
  const s = String(v ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return s === "agpanel" ? "agpanel" : s === "standingseam" ? "standingseam" : null;
}

/** The profile a metal roof on this design is: the design's own pick, else (a signed design only)
 *  the profile its agreed Roof line names, else the style's starting value
 *  (building_styles.d3.roofProfile), else AG Panel. It says nothing about WHETHER the roof is metal;
 *  roofLineDesc and roofTypeLabel ask that.
 *
 *  `agreedLines` is agreedBaseline(design).lines, and the caller passes it ONLY for a signed design
 *  (accepted_at or accepted_snapshot set): an unsigned quote has agreed to nothing, and its last
 *  quote is no agreement. Left out, the rule is the pick, then the style. */
export function effectiveRoofProfile(pick: unknown, styleD3: unknown, agreedLines?: unknown): MetalRoofProfile {
  const fromStyle = styleD3 && typeof styleD3 === "object" ? (styleD3 as Record<string, unknown>).roofProfile : null;
  return normRoofProfile(pick) ?? agreedRoofProfile(agreedLines) ?? normRoofProfile(fromStyle) ?? "agpanel";
}

const SS_SUFFIX = " (Standing Seam)";
const isMetalType = (roofType: string) => roofType.toLowerCase().replace(/\s+/g, "") === "metal";

/** The profile a signed design's metal roof was AGREED as, read off the Roof line the customer signed
 *  (agreedBaseline(design).lines: the snapshot object, or a bare array of lines). roofLineDesc wrote
 *  that line, so its type part (before " — ") says it: "Metal (Standing Seam)" is standing seam and
 *  plain "Metal" is AG Panel. Null when there is no snapshot, no Roof line, "No roof selected", or a
 *  roof that was not metal: a design switched to metal after signing starts from its style like any
 *  other, and a junk line never decides anything. */
export function agreedRoofProfile(agreedLines: unknown): MetalRoofProfile | null {
  const snap = agreedLines as { lines?: unknown } | unknown[] | null | undefined;
  const lines: unknown[] = Array.isArray(snap) ? snap : (snap && Array.isArray(snap.lines) ? snap.lines : []);
  const roof = lines.find((l) => !!l && typeof l === "object" && String((l as Record<string, unknown>).kind ?? "") === "roof") as
    Record<string, unknown> | undefined;
  const desc = String(roof?.desc ?? "");
  const cut = desc.indexOf(" — ");
  if (cut < 0) return null;
  const type = desc.slice(0, cut).trim();
  if (type.endsWith(SS_SUFFIX)) return isMetalType(type.slice(0, -SS_SUFFIX.length)) ? "standingseam" : null;
  return isMetalType(type) ? "agpanel" : null;
}

/** The roof TYPE as it is printed: "Metal (Standing Seam)" for a metal roof whose profile is standing
 *  seam, else the type exactly as given. The one rule the quote's Roof line and the crew card share. */
export function roofTypeLabel(roofType: string, profile?: unknown): string {
  return profile === "standingseam" && isMetalType(roofType)
    ? `${roofType}${SS_SUFFIX}`
    : roofType;
}

/** The Roof line's description, the quote's and the order screen's alike. Every input but a metal
 *  roof on standing seam gives the string these lines have always carried:
 *    no type          → "No roof selected"
 *    type and colour  → "Metal — Black"
 *    type, no colour  → "Metal — (color TBD)"
 *  and a metal roof on standing seam names it: "Metal (Standing Seam) — Black". */
export function roofLineDesc(roofType: unknown, roofColor: unknown, profile?: unknown): string {
  const type = String(roofType ?? "").trim();
  const color = String(roofColor ?? "").trim();
  if (!type) return "No roof selected";
  const shown = roofTypeLabel(type, profile);
  return color ? `${shown} — ${color}` : `${shown} — (color TBD)`;
}
