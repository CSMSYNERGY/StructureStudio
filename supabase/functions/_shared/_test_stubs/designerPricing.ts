// The designer's pricing rows, LIFTED out of the shipped twins and run as they ship (migration 277).
//
// Shared by priceOverride_test.ts and submitEstimatePriceOverrideWiring_test.ts. Not a test itself
// (no _test suffix), the way pdfText.ts is a helper. The technique is wallHeight_test's: slice the
// real source between stable anchors and run it with `new Function`, so what is tested is the text
// the browser bundle is compiled from — never a copy that keeps passing while the twin drifts. Every
// lifted region is also asserted byte-identical between the two hand-mirrored twins.
//
// The regions carry no JSX. The one free variable they read that lives outside them,
// SUPABASE_URL (ssSafeUrl's host), is handed in.
//
// If an anchor moves, re-point it here; do not delete the tests that use it.

// deno-lint-ignore-file no-explicit-any
const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
export const CMP = await read("../../../../structure-studio.component.js");
export const JSX = await read("../../../../StructureStudio.jsx");
export const PRICE_ROW_KEY_TS = await read("../priceRowKey.ts");

/** A plain slice between two stable anchors, loud when either moves. */
export function lift(src: string, file: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(
      `designerPricing: could not find ${start} .. ${end} in ${file} (start=${i}, end=${j}). ` +
        "The anchors moved — re-point them rather than deleting the tests.",
    );
  }
  return src.slice(i, j);
}

/** The byte-identical key region, inclusive of both marker lines. */
export const KEY_REGION_START = "// ── PRICE ROW KEYS ──\n";
export const KEY_REGION_END = "// ── END PRICE ROW KEYS ──\n";
export function keyRegion(src: string, file: string): string {
  return lift(src, file, KEY_REGION_START, KEY_REGION_END) + KEY_REGION_END;
}

const REGIONS: Array<[string, string]> = [
  ["const SS_RO_KEYS = [", "// The window RO is the only one"],
  ["const LEGACY_LAYOUT_FALLBACK = {", "// Title-case a building-style name"],
  ["function elecItemsOffered(", "function ElectricalItemPicker("],
  ["const SS_WINDOW_DRESSING = [", "function windowDressStamps("],
  ["const D3_CLADDING = {", "// D3_CLADDING_CHOICES and d3CladdingChoicesFor() LIVED HERE"],
  ["const LAYOUT_PRICE_ORDER = [", "// Origin allowlist for the postMessage"],
  // From the wall-height helpers through computeSelectionRows, computeLayoutPricingRows and the
  // price-override helpers beside it.
  ["function d3BaseWallHeightFt(C, styleCfg) {", "// Which placed items does a Details"],
  ["function priceRowMatcher(key, fixtures) {", "let idCounter = 1;"],
  // Partition walls (migration 278): the price rows and priceRowMatcher call into this block.
  ["// ── PARTITION WALLS ──\n", "// ── END PARTITION WALLS ──\n"],
];

export const REGIONS_CMP = REGIONS.map(([a, b]) => ({ a, text: lift(CMP, "structure-studio.component.js", a, b) }));
export const REGIONS_JSX = REGIONS.map(([a, b]) => ({ a, text: lift(JSX, "StructureStudio.jsx", a, b) }));

export type Designer = {
  computeSelectionRows: (sel: any, paintColors: any, C: any, items: any[]) => any[];
  computeLayoutPricingRows: (items: any[], sel: any, customOptions: any[], C: any, paintColors: any) => { rows: any[] };
  ssResolvePctSelectionRows: (rows: any[], base: number) => any[];
  ssApplyPriceOverrides: (rows: any[], ov: any) => any[];
  ssPriceOverrideList: (sel: any, items: any[], customOptions: any[], C: any, paintColors: any) => { rowKey: string; amount: number }[];
  ssPriceOverrideOf: (ov: any, key: string, listUnit: number) => number | null;
  ssRoPrice: (ov: any, ro: any, rate: number) => number;
  ssRoRateOf: (C: any, sel: any, key: string) => number;
  ssPriceRowKey: (kind?: string, id?: any, a?: any, b?: any) => string;
  ssPriceGroupId: (fixtureItemId?: any, name?: string, price?: number) => string;
  priceRowMatcher: (key: string, fixtures?: any[]) => (item: any) => boolean;
  ssPartitionSummary: (items: any[], wallFt: number) => any[];
  pricedWallHeightFt: (C: any, styleCfg: any, styleKey: string, sel: any, widthFt: number) => number;
  ssIsRO: (t: string) => boolean;
  fmtMoney2: (n: number) => string;
};

/** The lifted functions, evaluated from the component twin. */
export function designer(): Designer {
  const body = REGIONS_CMP.map((r) => r.text).join("\n");
  const names = [
    "computeSelectionRows", "computeLayoutPricingRows", "ssResolvePctSelectionRows", "ssApplyPriceOverrides",
    "ssPriceOverrideList", "ssPriceOverrideOf", "ssRoPrice", "ssRoRateOf", "ssPriceRowKey", "ssPriceGroupId",
    "priceRowMatcher", "ssIsRO", "fmtMoney2", "ssPartitionSummary", "pricedWallHeightFt",
  ];
  return new Function("SUPABASE_URL", `${body}\n; return { ${names.join(", ")} };`)("https://stub.supabase.co") as Designer;
}

/**
 * Every total site's arithmetic, as the Details panel does it: selection rows + layout rows +
 * rough openings + positive custom options, the "% of subtotal" selection rows resolved against
 * that base first. Delivery and discounts are left out (neither can take a rep's price).
 */
export function detailsSubtotal(D: Designer, sel: any, items: any[], customOptions: any[], C: any, paintColors: any) {
  const selRows = D.computeSelectionRows(sel, paintColors, C, items);
  const priceRows = C.showPricing ? D.computeLayoutPricingRows(items, sel, customOptions, C, paintColors).rows : [];
  const roList = items.filter((i) => D.ssIsRO(i.type));
  const roTotal = roList.reduce((s, ro) => s + D.ssRoPrice(sel.priceOverrides, ro, D.ssRoRateOf(C, sel, ro.type)), 0);
  const customTotal = (customOptions || []).reduce((s, r) => {
    if (!r || !r.name || !String(r.name).trim()) return s;
    return s + Math.max(0, parseFloat(r.amount) || 0) * (r.qty ? Math.abs(parseInt(r.qty, 10)) || 1 : 1);
  }, 0);
  D.ssResolvePctSelectionRows(selRows,
    selRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
    + priceRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
    + (C.showPricing ? roTotal : 0) + customTotal);
  const subtotal = selRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
    + priceRows.reduce((s, r) => s + (Number(r.total) || 0), 0)
    + (C.showPricing ? roTotal : 0) + customTotal;
  return { selRows, priceRows, roTotal, subtotal };
}
