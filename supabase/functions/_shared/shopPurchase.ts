/**
 * Online Inventory PURCHASE (phase 4, Carolyn 2026-10-17): pay first, sign the invoice after.
 * "When they purchase an online building they go through and purchase it and pay for it and then
 * an invoice is sent to them and they are required to sign the invoice." Estimates are never signed.
 *
 * Pure helpers for shop-checkout's `purchase`, kept here so the money and the words are tested
 * without a database or a gateway.
 */

/** A design short code, the designer's alphabet and length (StructureStudio.jsx genShortCode):
 *  "SS-" + 10 of A-H J-N P-Z 2-9 — what save_design and the code regex accept. */
const SHORT_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genShortCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = "SS-";
  for (const b of bytes) s += SHORT_ALPHA[b % SHORT_ALPHA.length];
  return s;
}

const ITEM_LABELS: Record<string, string> = {
  fixtureDoor: "Door", singleDoor: "Single door", doubleDoor: "Double door", window: "Window",
  ramp: "Ramp", loft: "Loft", workbench: "Workbench", shelf: "Shelf", doubleShelf: "Double shelf",
  roughOpening: "Rough opening", roughOpeningDoor: "Rough opening (door)", roughOpeningWindow: "Rough opening (window)",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP = new Set(["textNote", "line", "prop", ""]);

export interface IncludedRow { name: string; desc: string; qty: number }

/** Group a building's placed items into estimate lines: one per name + size + colour, with a
 *  quantity, each at $0 — they come WITH the building, whose one price is the asking price. The
 *  same labels shop.html shows, so the invoice and the page describe the same building. */
export function includedLines(items: unknown, names: { layout: Record<string, string>; electrical: Record<string, string> }): IncludedRow[] {
  const rows: IncludedRow[] = [];
  const byKey = new Map<string, IncludedRow>();
  for (const raw of Array.isArray(items) ? items : []) {
    const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type = String(it.type ?? "");
    if (SKIP.has(type)) continue;
    const elecId = String(it.electricalItemId ?? "");
    const name = String(it.doorName || it.windowName || names.layout[type] || (UUID.test(elecId) ? names.electrical[elecId] : "") ||
      ITEM_LABELS[type] || (UUID.test(type) ? "Electrical item" : type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())));
    const bits: string[] = [];
    const opening = /door|window/i.test(type);
    const wIn = Number(it.widthIn), hIn = Number(it.heightIn), wFt = Number(it.widthFt);
    if (opening && wIn > 0 && hIn > 0) bits.push(`${Math.round(wIn)}" x ${Math.round(hIn)}"`);
    else if (wFt > 0 && !UUID.test(type)) bits.push(`${+wFt.toFixed(1)} ft`);
    if (it.colorLabel) bits.push(String(it.colorLabel));
    if (it.shutters === true) bits.push("shutters");
    if (it.flowerBox === true) bits.push("flower box");
    const desc = bits.join(" · ");
    const key = name + "|" + desc;
    const hit = byKey.get(key);
    if (hit) hit.qty++;
    else { const r = { name, desc, qty: 1 }; byKey.set(key, r); rows.push(r); }
  }
  return rows;
}

/**
 * The estimate_lines snapshot for a building bought online — submit-estimate's shape
 * (_shared/estimateLines.ts header), so the invoice, the PDF, the books and the acceptance read it
 * with the same code as every other estimate. The building line carries the asking price; what
 * comes with it is listed at $0; delivery is its own line; tax is the figure the shopper was shown
 * (shop-checkout's estimate: the lot's rate, else the company's).
 */
export function purchaseSnapshot(p: {
  buildingName: string; serial: number; lotName: string | null; priceCents: number;
  included: IncludedRow[];
  options: { name: string; desc: string }[];
  deliveryCents: number | null; deliveryNote: string | null; deliveryTaxable: boolean;
  tax: { rate: number; amountCents: number; label: string; basis: "location" | "company"; locationId: string | null } | null;
}): Record<string, unknown> {
  const lines: Record<string, unknown>[] = [
    { kind: "building", itemKey: "", name: p.buildingName, desc: `Stock #${p.serial}${p.lotName ? ` — built and ready on our ${p.lotName} lot` : ""}. Bought online.`, qty: 1, amount: p.priceCents / 100, nonTaxable: false },
    ...p.options.map((o) => ({ kind: "option", itemKey: "", name: o.name, desc: o.desc, qty: 1, amount: 0, nonTaxable: false })),
    ...p.included.map((r) => ({ kind: "item", itemKey: "", name: `${r.name} (included)`, desc: r.desc, qty: r.qty, amount: 0, nonTaxable: false })),
  ];
  if (p.deliveryCents != null) {
    lines.push({ kind: "delivery", itemKey: "", name: "Delivery", desc: p.deliveryNote ?? "", qty: 1, amount: p.deliveryCents / 100, nonTaxable: !p.deliveryTaxable });
  }
  const snap: Record<string, unknown> = { version: 1, discount: 0, lines, source: "online_inventory" };
  if (p.tax) {
    const taxable = (p.priceCents + (p.deliveryCents != null && p.deliveryTaxable ? p.deliveryCents : 0)) / 100;
    const nonTaxable = (p.deliveryCents != null && !p.deliveryTaxable ? p.deliveryCents : 0) / 100;
    snap.discounts = { taxable: 0, nonTaxable: 0, rows: [] };
    snap.tax = {
      rate: p.tax.rate, amount: p.tax.amountCents / 100, label: p.tax.label, basis: p.tax.basis,
      source: "fallback", reason: "online purchase", locationId: p.tax.locationId,
      taxableSubtotal: taxable, nonTaxableSubtotal: nonTaxable, taxableBase: taxable, nonTaxableNet: nonTaxable,
      resolvedAt: new Date().toISOString(), verifiedAt: null, jurisdiction: null,
    };
  }
  return snap;
}

const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What the shopper ticks before paying, and what each acceptance stores verbatim. No signature:
 *  an estimate is accepted, the INVOICE is what gets signed (Carolyn 2026-10-17). */
export function purchaseSentence(p: { business: string; labels: string[]; totalCents: number; dueNowCents: number; payInFull: boolean }): string {
  const biz = p.business || "the builder";
  const what = p.labels.length === 1 ? p.labels[0] : `${p.labels.length} buildings (${p.labels.join(", ")})`;
  const pay = p.payInFull || p.dueNowCents >= p.totalCents ? `paying ${usd(p.dueNowCents)} today` : `paying a ${usd(p.dueNowCents)} deposit today`;
  return `I am buying ${what} from ${biz} for ${usd(p.totalCents)}, ${pay}. I understand ${biz} will send me an invoice to sign.`;
}
