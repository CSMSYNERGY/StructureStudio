// jack-agent: option prices (options_test.ts). Carolyn, 11-09 call: Jack should be able to change "every
// option". This covers the three tabs that were guide only: Interior items (Settings > Options > Interior
// items), colors (Settings > Colors: paint, shingles, metal) and Electrical (Settings > Options > Electrical).
//
// PRICES ONLY. A card changes prices that are already set, in the unit the item already has. Adding or
// removing an item or a colour, renaming, a colour's serial code, a pricing method, the electrical
// package, and pricing an item for the first time stay on the page (point_to_step).
//
// THE RULES
//   - A tool reads, or writes ONE card. Only Approve saves, with the person's own token:
//       interior items: save_layout_pricing, the tab's own save, which writes only the rows it is sent and
//         only their method and rate (no image or size key is sent, so those stay);
//       colours and electrical items: set_color_prices / set_electrical_prices, which write only price
//         columns by id. Never save_colors or save_electrical_items: those save a whole list and delete
//         whatever is left out.
//   - Before saving, every price is read again. If one moved since the card was made, nothing is saved and
//     the card says to ask again. Colours and electrical are also compare-and-set on the server, so a change
//     made in the moment between the read and the save is never overwritten.
//   - Undo puts a price back only while it still holds what Jack saved.
//   - A correction is a new card: an older card still waiting in this chat for the SAME price is put away.
//     A card for a different price stays.

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { replaceOlder } from "./drafts.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const OPTION_KIND = "option_price";
/** The price switch: an option's price is a price, as a size's base price is. */
const PRICES_SWITCH = "prices";
const AREA = "settings_options";
export const AREAS = ["interior", "colors", "electrical"] as const;
export type OptArea = typeof AREAS[number];
/** Which price of an item. Interior items have one; a colour has its own and, if it's offered on doors, a
 *  door price; an electrical item has one with the package and one on its own. */
export const PRICES = ["price", "door_price", "with_package", "standalone"] as const;
export type PriceKey = typeof PRICES[number];
const ALLOWED: Record<OptArea, PriceKey[]> = { interior: ["price"], colors: ["price", "door_price"], electrical: ["with_package", "standalone"] };
export const OPTION_REPLACED = "Replaced by your newer card for this price.";
const MAX_DOLLARS = 100000;
const MAX_CHANGES = 20;

type Section = "paint" | "shingle" | "metal";
const SECTION_PAGE: Record<Section, { where: string; sub: string; word: string }> = {
  paint: { where: "Settings > Colors > Paint", sub: "colors", word: "paint" },
  shingle: { where: "Settings > Colors > Shingles", sub: "shingles", word: "shingle" },
  metal: { where: "Settings > Colors > Metal", sub: "metal", word: "metal" },
};
const WHERE_OF: Record<OptArea, string> = { interior: "Settings > Options > Interior items", colors: "Settings > Colors", electrical: "Settings > Options > Electrical" };
const SUB_OF: Record<OptArea, string> = { interior: "interior", colors: "colors", electrical: "electrical" };

/** One price as it is now. `ref` is what a card names: an interior item's key, a colour's or an item's id. */
export interface Price {
  area: OptArea; ref: string; price: PriceKey; name: string;
  /** null = not set (an interior item with no price; an electrical item not offered that way). */
  value: number | null;
  /** How it's charged (interior items and colours' own price). Door prices are flat a door; electrical each. */
  method: string;
  section?: Section; off: boolean; teamOnly: boolean; archived?: boolean; door?: boolean;
  /** Interior items: kept off the designer's palette until it has a price (171's noPalette). An unpriced
   *  item WITHOUT it can still be placed, and adds nothing to the price. */
  hiddenUntilPriced?: boolean;
}
interface CardChange { ref: string; price: PriceKey; label: string; method: string; section?: Section; from: number | null; to: number }

const PER: Record<string, string> = {
  each: "each", lineal_ft: "a lineal ft", sqft_option: "a sq ft", sqft_building: "a sq ft of the building",
  perimeter_building: "a ft of the building's perimeter", pct_building_price: "of the building price", pct_estimate_total: "of the estimate total",
};
const isPct = (method: string) => method.startsWith("pct_");
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** "$300 each", "$8 a sq ft", "5% of the building price", "$75 a door". */
export function priceWords(n: number, method: string, price: PriceKey): string {
  if (price === "door_price") return `$${num(n)} a door`;
  if (isPct(method)) return `${num(n)}% ${PER[method]}`;
  return `$${num(n)} ${PER[method] ?? "each"}`;
}
const labelOf = (p: { name: string; price: PriceKey; section?: Section }) =>
  p.price === "door_price" ? `${p.name}, on a door`
  : p.price === "with_package" ? `${p.name}, with the package`
  : p.price === "standalone" ? `${p.name}, on its own`
  : p.section ? `${p.name} (${SECTION_PAGE[p.section].word} color)` : p.name;
const keyOf = (c: { ref: string; price: string }) => `${c.ref}/${c.price}`;
/** Two prices are the same to the cent: the columns are numeric, and a float read back can carry noise. */
const samePrice = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.round(a * 100) === Math.round(b * 100));
const landed = (r: { status: number; data: Record<string, unknown> | null }) => r.status === 200 && !!r.data && r.data.ok !== false;
const unsure = (r: { status: number }) => r.status === 0 || r.status >= 500;
const numOrNull = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** What customers get from an interior item with no price yet (migration 171): one kept off the palette
 *  until priced isn't offered; any other can still be placed and adds nothing to the price. */
const unpricedWords = (p: { hiddenUntilPriced?: boolean }) =>
  p.hiddenUntilPriced ? "customers aren't offered it until it's priced" : "customers can still place it, and it adds nothing to the price until it's priced";
const sectionOf = (c: Any): Section => (c?.shingle === true ? "shingle" : c?.metal === true ? "metal" : "paint");

/** Every price in one area, from the page's own catalog read. */
export async function readPrices(deps: Deps, area: OptArea): Promise<{ prices: Price[] } | { error: string }> {
  const r = await deps.portal("catalog", {});
  if (r.status === 403) return { error: SAID.noSee };
  const d = r.data as Any;
  if (r.status !== 200 || !d) return { error: SAID.readFailed };
  const prices: Price[] = [];
  if (area === "interior") {
    if (!Array.isArray(d.items) || !Array.isArray(d.layoutPricing)) return { error: SAID.readFailed };
    const priced = new Map<string, Any>();
    for (const lp of d.layoutPricing as Any[]) if (lp && lp.item_key) priced.set(String(lp.item_key), lp);
    for (const it of d.items as Any[]) {
      // Only the Interior items tab's own rows. Rough openings are priced on Doors and Windows, and an
      // interior wall on its own tab (save_layout_pricing refuses it).
      if (!it || (it.paletteGroup ?? "interior") !== "interior" || it.key === "partitionWall") continue;
      const lp = priced.get(String(it.key));
      prices.push({
        area, ref: String(it.key), price: "price", name: String(it.label ?? it.key),
        value: lp ? numOrNull(lp.rate) : null, method: String(lp?.pricing_method ?? "each"),
        off: false, teamOnly: it.internalOnly === true, archived: it.archived === true, hiddenUntilPriced: it.hiddenUntilPriced === true,
      });
    }
  } else if (area === "colors") {
    if (!Array.isArray(d.colors)) return { error: SAID.readFailed };
    for (const c of d.colors as Any[]) {
      if (!c || !c.id) continue;
      const base = { area, ref: String(c.id), name: String(c.label ?? ""), section: sectionOf(c), off: c.active === false, teamOnly: false, door: c.door === true };
      prices.push({ ...base, price: "price", value: numOrNull(c.rate) ?? 0, method: String(c.pricing_method ?? "each") });
      if (c.door === true) prices.push({ ...base, price: "door_price", value: numOrNull(c.door_rate) ?? 0, method: "each" });
    }
  } else {
    if (!Array.isArray(d.electricalItems)) return { error: SAID.readFailed };
    for (const e of d.electricalItems as Any[]) {
      if (!e || !e.id) continue;
      const base = { area, ref: String(e.id), name: String(e.name ?? ""), method: "each", off: e.active === false, teamOnly: e.internal_only === true };
      prices.push({ ...base, price: "with_package", value: numOrNull(e.price_with_package) });
      prices.push({ ...base, price: "standalone", value: numOrNull(e.price_standalone) });
    }
  }
  return { prices };
}

const lookTool: ToolSpec = {
  def: {
    name: "look_at_my_option_prices",
    description: "Read this builder's prices on one area: interior (Settings > Options > Interior items: lofts, workbenches, shelving and the like), colors (Settings > Colors: paint, shingle and metal colors, and a door price for colors offered on doors), or electrical (Settings > Options > Electrical: each item's price with the electrical package and on its own). Use it before proposing an option price, and whenever they ask about these prices. Each price has a ref to pass to propose_option_prices.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["area"], properties: { area: { type: "string", enum: [...AREAS] } } },
  },
  needs: [{ area: AREA, level: "view" }],
  async run(deps, _s, input) {
    const area = String((input as Any)?.area ?? "") as OptArea;
    if (!AREAS.includes(area)) return err("Say interior, colors or electrical.");
    const got = await readPrices(deps, area);
    if ("error" in got) return err(got.error);
    const rows = got.prices.map((p) => ({
      ref: p.ref, name: p.name, price: p.price,
      now: p.value === null ? null : priceWords(p.value, p.method, p.price),
      ...(p.section ? { page: SECTION_PAGE[p.section].word } : {}),
      ...(p.off ? { turnedOff: true } : {}), ...(p.teamOnly ? { teamOnly: true } : {}), ...(p.archived ? { archived: true } : {}),
      ...(p.value === null && p.area === "interior" ? { untilPriced: unpricedWords(p) } : {}),
    }));
    const note = area === "interior"
      ? "now is null when an item has no price yet; untilPriced says what customers get meanwhile. Its first price and how it's charged are set on the tab (point_to_step addons). The unit is the item's own; a card can't change how an item is charged."
      : area === "colors"
      ? "A color's price is in its own unit (usually each, an upcharge for picking it). price door_price is the flat price a door painted that color adds. The same color name can be on two pages (paint and metal, say): ask which when it is."
      : "with_package is the item's price when they take the electrical package, standalone is its price on its own. now null means it isn't offered that way yet: a card can set it, and the card says customers will be offered it. When they name only the item and both are set, ask which (or both). The package's own price is on the tab (point_to_step electrical).";
    return ok({ area, prices: rows, note });
  },
};

const proposeTool: ToolSpec = {
  def: {
    name: "propose_option_prices",
    description: "Put a preview on the person's screen that changes prices on one area: interior (Interior items, prices already set), colors (paint, shingle and metal colors, and their door price) or electrical (each item with the package, and on its own; a blank one can be set, which starts offering the item that way). It changes nothing: the person presses Approve. Read look_at_my_option_prices for the area first and pass each price's ref and price key, with the new amount in the item's own unit (dollars, or a percent for a percent item). It can't add or remove an item or a color, rename one, set an interior item's first price, or change how something is charged: point_to_step for those. To change a card you made, call this again: the new card replaces the old one for the same price.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["area", "changes"],
      properties: {
        area: { type: "string", enum: [...AREAS] },
        changes: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["ref", "price", "to"],
            properties: {
              ref: { type: "string", description: "The ref from look_at_my_option_prices." },
              price: { type: "string", enum: [...PRICES] },
              to: { type: "number", description: "The new amount in the item's own unit, e.g. 300 for $300 each, 5 for 5%." },
            },
          },
        },
      },
    },
  },
  needs: [{ area: AREA, level: "edit" }],
  switchKey: PRICES_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const area = String((input as Any)?.area ?? "") as OptArea;
    if (!AREAS.includes(area)) return err("Say interior, colors or electrical.");
    const asked = Array.isArray((input as Any)?.changes) ? (input as Any).changes as Any[] : [];
    if (!asked.length) return err("No changes were given.");
    if (asked.length > MAX_CHANGES) return err(`That's more than ${MAX_CHANGES} prices for one card. Make it in two.`);
    const got = await readPrices(deps, area);
    if ("error" in got) return err(got.error);
    // Later lines win, so a price named twice takes its last amount.
    const want = new Map<string, CardChange>();
    for (const a of asked) {
      const ref = String(a?.ref ?? "").trim();
      const price = String(a?.price ?? "") as PriceKey;
      const to = Number(a?.to);
      if (!ALLOWED[area].includes(price)) return err(`On ${area}, the price is ${ALLOWED[area].join(" or ")}.`);
      const now = got.prices.find((p) => p.ref === ref && p.price === price);
      if (!now) {
        const sameRef = got.prices.find((p) => p.ref === ref);
        if (sameRef && price === "door_price") return err(`${sameRef.name} isn't offered on doors, so it has no door price. That's set on ${WHERE_OF.colors}.`);
        return err("I don't have that one. Read look_at_my_option_prices again and use its ref.");
      }
      if (now.archived) return err(`${now.name} is archived. Bring it back on ${WHERE_OF.interior} first.`);
      if (area === "interior" && now.value === null) return err(`${now.name} has no price yet: ${unpricedWords(now)}. Its first price and how it's charged are set on ${WHERE_OF.interior}.`);
      if (!Number.isFinite(to) || to < 0) return err("A price needs to be zero or more.");
      if (isPct(now.method) && price === "price" && to > 100) return err(`${now.name} is charged as a percent ${PER[now.method]}, so it needs to be 100 or less.`);
      if (!(to < MAX_DOLLARS)) return err(`That price looks off. It needs to be under $${MAX_DOLLARS.toLocaleString("en-US")}. Check the number with them.`);
      want.set(keyOf(now), { ref, price, label: labelOf(now), method: now.method, ...(now.section ? { section: now.section } : {}), from: now.value, to: Math.round(to * 100) / 100 });
    }
    const changes = [...want.values()].filter((c) => !samePrice(c.from, c.to));
    if (!changes.length) return err("Those prices are already set, so nothing would change.");

    const notes: string[] = [];
    const named = (refs: Set<string>) => [...new Set(got.prices.filter((p) => refs.has(p.ref)).map((p) => p.name))].join(", ");
    const refsOf = (pred: (p: Price) => boolean) => new Set(changes.map((c) => got.prices.find((p) => p.ref === c.ref && p.price === c.price)!).filter(pred).map((p) => p.ref));
    const off = refsOf((p) => p.off);
    if (off.size) notes.push(`${named(off)} ${off.size === 1 ? "is" : "are"} turned off, so customers won't see the new price until ${off.size === 1 ? "it's" : "they're"} turned on.`);
    const team = refsOf((p) => p.teamOnly);
    if (team.size) notes.push(`${named(team)} ${team.size === 1 ? "is" : "are"} for your team only, so customers don't see ${team.size === 1 ? "it" : "them"}.`);
    const fresh = changes.filter((c) => c.from === null);
    if (fresh.length) notes.push(`Customers will be offered ${fresh.map((c) => c.label).join(", ")}, which isn't offered now.`);

    const sections = [...new Set(changes.map((c) => c.section).filter(Boolean))] as Section[];
    const page = area === "colors" && sections.length === 1 ? SECTION_PAGE[sections[0]] : null;
    const where = page ? page.where : WHERE_OF[area];
    const route = { page: "settings", sub: page ? page.sub : SUB_OF[area] };
    const head = area === "interior" ? "Interior items" : area === "colors" ? "Colors" : "Electrical";
    const title = changes.length === 1 ? `${head}: ${changes[0].label} to ${priceWords(changes[0].to, changes[0].method, changes[0].price)}` : `${head}: ${changes.length} prices`;
    const card = await putCard(deps, s, {
      kind: OPTION_KIND, title,
      preview: {
        lines: changes.map((c) => ({ label: c.label, from: c.from === null ? "" : priceWords(c.from, c.method, c.price), to: priceWords(c.to, c.method, c.price) })),
        notes, ticks: [], where, route,
      },
      payload: { area, changes },
    });
    const mine = new Set(changes.map(keyOf));
    const samePriceCard = (p: ProposalRow) =>
      p.kind === OPTION_KIND && p.payload?.area === area && Array.isArray(p.payload?.changes) && (p.payload.changes as CardChange[]).some((c) => mine.has(keyOf(c)));
    const { replaced, replacedByNewer, yielded, unchecked } = await replaceOlder(deps, s, card, samePriceCard, OPTION_REPLACED);
    if (replacedByNewer) return ok({ shown: true, putAway: true, note: "A newer card for the same price, made at the same time, replaces this one. Tell them only about the newer card." });
    if (yielded || unchecked) {
      return ok({ shown: true, putAway: true, note: yielded
        ? "Their earlier card for this price was being saved at that moment, so this one was put away. Tell them in a sentence, and to ask again once it has saved."
        : "The earlier card for this price couldn't be checked, so this one was put away to keep two versions from both being approved. Tell them to cancel the earlier card and ask again." });
    }
    return ok({
      shown: true, changing: changes.map((c) => ({ name: c.label, from: c.from === null ? null : priceWords(c.from, c.method, c.price), to: priceWords(c.to, c.method, c.price) })),
      ...(replaced ? { replacedOlderCard: true } : {}),
      note: `${SAID.onScreenApprove}${replaced ? " It replaces their earlier card for the same price, which is put away." : ""}`,
    });
  },
};

/** What one save sends, per area. Interior: the tab's own save with each row's method as it is now. Colours
 *  and electrical: the price-only routes, one row per item, each price with what it should be now. */
function saveCall(area: OptArea, set: { c: CardChange; value: number | null; expect: number | null }[], now: Price[]): { action: string; body: Record<string, unknown> } {
  if (area === "interior") {
    return { action: "save_layout_pricing", body: { rows: set.map(({ c, value }) => ({ item_key: c.ref, pricing_method: now.find((p) => p.ref === c.ref)?.method ?? c.method, rate: value })) } };
  }
  const rows = new Map<string, Record<string, unknown>>();
  const FIELD: Record<PriceKey, [string, string]> = {
    price: ["rate", "expectRate"], door_price: ["doorRate", "expectDoorRate"],
    with_package: ["priceWithPackage", "expectWithPackage"], standalone: ["priceStandalone", "expectStandalone"],
  };
  for (const { c, value, expect } of set) {
    const row = rows.get(c.ref) ?? { id: c.ref };
    const [f, e] = FIELD[c.price];
    row[f] = value === null ? "" : value;
    row[e] = expect;
    rows.set(c.ref, row);
  }
  return { action: area === "colors" ? "set_color_prices" : "set_electrical_prices", body: { rows: [...rows.values()] } };
}

/** Which of a save's changes didn't land: the interior save's skipped lines start with the item key; the
 *  price routes name the ids they left alone. */
function missedBy(area: OptArea, r: { data: Record<string, unknown> | null }, set: CardChange[]): CardChange[] {
  if (area === "interior") {
    const skipped = r.data && Array.isArray(r.data.skipped) ? (r.data.skipped as unknown[]).map(String) : [];
    return set.filter((c) => skipped.some((x) => x.startsWith(c.ref + ":")));
  }
  const notSaved = new Set(r.data && Array.isArray(r.data.notSaved) ? (r.data.notSaved as unknown[]).map(String) : []);
  return set.filter((c) => notSaved.has(c.ref));
}

async function applyOptions(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const area = p.payload?.area as OptArea;
  const changes = (p.payload?.changes ?? []) as CardChange[];
  if (!AREAS.includes(area)) return { patch: { status: "failed", failure: "This card is damaged, so I saved nothing. Ask me again." } };
  const got = await readPrices(deps, area);
  if ("error" in got) return { patch: { status: "failed", failure: `${got.error} Nothing changed.` } };
  const at = (c: CardChange) => got.prices.find((x) => x.ref === c.ref && x.price === c.price);
  const moved = changes.filter((c) => {
    const now = at(c);
    return !now || !samePrice(now.value, c.from) || now.method !== c.method;
  });
  if (moved.length) {
    return { patch: { status: "failed", failure: `${moved.map((c) => c.label).join(", ")} changed since I made this card, so I saved nothing. Ask me again and I'll start from what's there now.` } };
  }
  const { action, body } = saveCall(area, changes.map((c) => ({ c, value: c.to, expect: c.from })), got.prices);
  const r = await deps.portal(action, body);
  const undoOf = (set: CardChange[]) => ({ area, changes: set.map((c) => ({ ref: c.ref, price: c.price, label: c.label, method: c.method, before: c.from, after: c.to })) });
  if (!landed(r)) {
    const where = String(p.preview?.where ?? WHERE_OF[area]);
    const reason = unsure(r) ? `I couldn't tell if that saved. Check ${where} before trying again.` : saidBy(r, "That didn't save.");
    // A lost answer may have saved, so Undo stays: it puts a price back only where it reads what this saved.
    return { patch: { status: "partly_applied", result: { saved: 0, created: 0, reports: [{ label: p.title, status: unsure(r) ? "error" : "refused", reason }] }, undo: unsure(r) ? undoOf(changes) : null } };
  }
  const missed = missedBy(area, r, changes);
  const saved = changes.filter((c) => !missed.includes(c));
  // The price routes leave a row only when it moved (compare and set). The Interior items save has no such
  // check: a skipped row there is the server refusing it, in its own words after the key.
  const skipped = r.data && Array.isArray(r.data.skipped) ? (r.data.skipped as unknown[]).map(String) : [];
  const whyNot = (c: CardChange) => skipped.find((x) => x.startsWith(c.ref + ":"))?.slice(c.ref.length + 1).trim();
  return {
    patch: {
      status: missed.length ? "partly_applied" : "applied",
      result: {
        saved: saved.length, created: 0,
        reports: missed.map((c) => area === "interior"
          ? { label: c.label, status: "refused", reason: `That one didn't save${whyNot(c) ? ` (${whyNot(c)})` : ""}. Check it on ${WHERE_OF.interior}.` }
          : { label: c.label, status: "changed", reason: "That one changed on the page just now, so I left it." }),
      },
      undo: saved.length ? undoOf(saved) : null,
    },
  };
}

async function undoOptions(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { area?: OptArea; changes?: (CardChange & { before: number | null; after: number })[] };
  const area = plan.area as OptArea;
  const steps = plan.changes ?? [];
  if (!AREAS.includes(area)) return { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: "I can't tell what to put back on this card." }] };
  const got = await readPrices(deps, area);
  if ("error" in got) return { restored: 0, removed: 0, failed: steps.length || 1, reports: [{ label: p.title, status: "error", reason: "I couldn't read those prices just now. Please try again." }] };
  const where = String(p.preview?.where ?? WHERE_OF[area]);
  const reports: UndoOutcome["reports"] = [];
  const back = steps.filter((c) => {
    const now = got.prices.find((x) => x.ref === c.ref && x.price === c.price)?.value ?? null;
    if (samePrice(now, c.before)) return false; // already back
    if (!samePrice(now, c.after)) {
      reports.push({ label: c.label, status: "changed", reason: `This was changed since I saved it, so I left it. Set it on ${where} if you need to.` });
      return false;
    }
    return true;
  });
  const already = steps.length - back.length - reports.length;
  if (!back.length) return { restored: already, removed: 0, failed: 0, reports };
  const { action, body } = saveCall(area, back.map((c) => ({ c, value: c.before, expect: c.after })), got.prices);
  const r = await deps.portal(action, body);
  if (!landed(r)) {
    return { restored: already, removed: 0, failed: unsure(r) ? back.length : 0, reports: [...reports, ...back.map((c) => ({ label: c.label, status: unsure(r) ? "error" : "refused", reason: saidBy(r, "That didn't undo.") }))] };
  }
  const missed = missedBy(area, r, back);
  const done = back.filter((c) => !missed.includes(c));
  return {
    restored: already + done.length,
    removed: 0,
    failed: missed.length,
    reports: [...reports, ...missed.map((c) => (area === "interior"
      ? { label: c.label, status: "error", reason: "That one didn't go back. Press Undo to try again." }
      : { label: c.label, status: "changed", reason: `This was changed since I saved it, so I left it. Set it on ${where} if you need to.` }))],
  };
}

const kind: KindSpec = {
  kind: OPTION_KIND,
  areas: () => [AREA],
  switches: () => [PRICES_SWITCH],
  where: "Settings > Options or Settings > Colors",
  nothingToDo: (p) => ((p.payload?.changes ?? []).length ? null : "Nothing would change, so there's nothing to approve."),
  apply: (deps, _who, p) => applyOptions(deps, p),
  undo: (deps, _who, p) => undoOptions(deps, p),
};

export const optionsPiece: Piece = {
  name: "options",
  tools: [lookTool, proposeTool],
  kinds: [kind],
  can: [
    "Read and change prices on Interior items, colors (paint, shingle, metal, and a color's door price) and Electrical items with look_at_my_option_prices and propose_option_prices.",
  ],
  rules: [
    "Interior items, color prices and electrical item prices: read look_at_my_option_prices for the area, then propose_option_prices. A card changes prices already set, in the item's own unit. Adding or removing an item or a color, renaming, serial codes, how an item is charged, the electrical package's price, and an interior item's first price are set on the page: point_to_step. An electrical item not offered with the package or on its own yet can be given that price with a card.",
    "If they give a price in a different unit than the item's (per square foot for an item charged each, say), don't convert it: say how the item is charged now and ask, or point_to_step to change how it's charged.",
  ],
};

/** Exposed for tests. */
export const _test = { saveCall, missedBy, samePrice, labelOf };
