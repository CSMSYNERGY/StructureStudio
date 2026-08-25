/**
 * Paint + roof line pricing, extracted from submit-estimate (migration 127 slice).
 *
 * The invoice-style order screen lets a rep change roof type/color, cladding, and paint
 * body/trim on a signed order; the resulting change order must carry the price difference
 * from the SAME catalog math the quote was built with. That math lived inline in
 * submit-estimate's line-building (colorAmount + the Line-2/Line-3 builders, index.ts
 * ~:648-726) — it is extracted here VERBATIM so the two can never disagree. submit-estimate
 * still runs its own inline copy in v1 (its steps are load-bearing and deliberately
 * untouched); a pointer comment there names this file, and any change to the math must
 * land in both until submit-estimate is refactored onto this module.
 *
 * Everything here is pure over inputs the caller loads (the colors palette, the building
 * context) — no I/O except resolveBuildingContext's two catalog reads.
 */

// deno-lint-ignore-file no-explicit-any

/** The designer/config and the catalog render sizes with × vs x — normalize both sides
 *  (lowercase, ×→x, strip spaces), match by key OR label. Same as submit-estimate:398. */
export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[×✕]/g, "x").replace(/\s+/g, "");

export interface BuildingContext {
  buildingPrice: number;
  buildingArea: number;      // width × depth (sqft_building)
  buildingPerimeter: number; // 2 × (width + depth) (perimeter_building)
  styleLabel: string;
}

/**
 * Resolve the priced building context for a style+size. Returns null when the style or
 * size can't be matched or has no price — the caller must fail LOUDLY (400), never price
 * an attribute change against a $0 building (submit-estimate:425 precedent).
 */
export async function resolveBuildingContext(
  supabase: any,
  clientId: string,
  style: unknown,
  size: unknown,
): Promise<BuildingContext | null> {
  try {
    const stRes = await supabase.from("building_styles").select("id, key, label").eq("client_id", clientId);
    const styleRow = (stRes.data || []).find((r: any) => norm(r.key) === norm(style) || norm(r.label) === norm(style));
    if (!styleRow) return null;
    const szRes = await supabase.from("building_sizes")
      .select("id, base_price, label, width_ft, length_ft")
      .eq("client_id", clientId).eq("style_id", styleRow.id);
    const sizeRow = (szRes.data || []).find((z: any) => norm(z.label) === norm(size));
    if (!sizeRow || sizeRow.base_price == null) return null;
    const w = Number(sizeRow.width_ft) || 0;
    const d = Number(sizeRow.length_ft) || 0;
    return {
      buildingPrice: Number(sizeRow.base_price) || 0,
      buildingArea: w * d,
      buildingPerimeter: 2 * (w + d),
      styleLabel: styleRow.label || String(style),
    };
  } catch {
    return null;
  }
}

/** Price a single color (paint or roof) by its catalog rate + pricing_method — same math
 *  as layout add-ons. pct_estimate_total isn't supported on a combined color line, so it
 *  falls back to 0. Verbatim from submit-estimate:651-661. */
export function colorAmount(row: any, ctx: BuildingContext): number {
  const rate = Number(row?.rate) || 0;
  if (rate <= 0) return 0;
  switch (String(row?.pricing_method || "each")) {
    case "sqft_building":      return rate * ctx.buildingArea;
    case "perimeter_building": return rate * ctx.buildingPerimeter;
    case "pct_building_price": return (rate / 100) * ctx.buildingPrice;
    case "pct_estimate_total": return 0;
    default:                   return rate;   // each / lineal_ft / sqft_option → flat
  }
}

/**
 * The Paint Colors line: Body + Trim in the description; amount is the sum of the selected
 * colors' rates (a color used for both sides is charged once). A named color matches by
 * label; a blank/"TBD" value under "Paint" still charges the tenant's allow-custom rate;
 * only an explicit "No Paint" (or paintStatus "Unpaint") is free. Mirrors
 * submit-estimate:663-698 over a preloaded active-colors palette.
 */
export function computePaintLine(
  palette: any[],
  ctx: BuildingContext,
  paintStatus: "Paint" | "Unpaint",
  bodyLabel: unknown,
  trimLabel: unknown,
): { amount: number; desc: string } {
  if (paintStatus !== "Paint") return { amount: 0, desc: "Unpainted" };
  const b = String(bodyLabel || "TBD");
  const t = String(trimLabel || "TBD");
  const customRow = palette.find((c) => c.allow_custom);
  const resolve = (val: unknown) => {
    const v = String(val ?? "").trim();
    if (norm(v) === norm("No Paint")) return null;
    return palette.find((c) => norm(c.label) === norm(v)) || customRow || null;
  };
  let amount = 0;
  const seen = new Set<string>();
  for (const row of [resolve(bodyLabel), resolve(trimLabel)]) {
    if (row && !seen.has(row.id)) { seen.add(row.id); amount += colorAmount(row, ctx); }
  }
  return { amount, desc: `Body: ${b}, Trim: ${t}` };
}

/**
 * The Roof line: Type + Color in the description; amount is the roof color's rate,
 * resolved ONLY among colors flagged for that roof type (shingle/metal), with the
 * allow-custom fallback. Mirrors submit-estimate:700-726 over the preloaded palette.
 */
export function computeRoofLine(
  palette: any[],
  ctx: BuildingContext,
  roofType: unknown,
  roofColor: unknown,
): { amount: number; desc: string } {
  const type = String(roofType ?? "").trim();
  const color = String(roofColor ?? "").trim();
  if (!type) return { amount: 0, desc: "No roof selected" };
  const desc = color ? `${type} — ${color}` : `${type} — (color TBD)`;
  let amount = 0;
  if (color && norm(color) !== norm("TBD")) {
    const flag = norm(type) === norm("Metal") ? "metal" : "shingle";
    const flagged = palette.filter((c) => c[flag] === true);
    const customRow = flagged.find((c) => c.allow_custom);
    const row = flagged.find((c) => norm(c.label) === norm(color)) || customRow || null;
    amount = colorAmount(row, ctx);
  }
  return { amount, desc };
}

/** The fixed cladding vocabulary — visual-only, no price, no estimate line (the designer's
 *  D3_CLADDING list). id ↔ label both directions for validation and display. */
export const CLADDING_OPTIONS: { id: string; label: string }[] = [
  { id: "", label: "Builder's standard" },
  { id: "lap", label: "Lap Siding" },
  { id: "panel", label: "Panel Siding" },
  { id: "agpanel", label: "Metal" },
];
export const claddingLabel = (id: unknown): string =>
  (CLADDING_OPTIONS.find((c) => c.id === String(id ?? "")) || CLADDING_OPTIONS[0]).label;
