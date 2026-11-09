// jack-agent: lot buildings, the Inventory tab (inventory_test.ts). Plan 5.9; v2 defaults 11-06, #1.
//
// Jack changes a lot building's asking price and its lot (update_inventory), its Online Shop listing:
// listed or not, price shown or hidden, title and description (save_inventory_listing), and the order of
// its photos and its cover (save_inventory_photos with `order` only). Nothing else: no new buildings, no
// design edits, no photos added or removed, no AI background, no deletes, and never a status.
//
// THE RULES
//   - Claude never saves. propose_inventory_change writes ONE card through putCard. Only a person's
//     Approve sends the card's body, ONCE, through portal-settings with that person's own token, so the
//     route's gate (inventory:edit) and its refusals all still apply.
//   - None of these routes has a version check: the last write wins. So Approve reads list_inventory
//     again first and refuses, sending nothing, when anything the card showed has moved: the fields it
//     changes, the building's updated_at (price and listing cards), whether it sold, its photo order
//     (photo cards: those saves don't move updated_at), the shop's on and hide-all-prices switches when
//     the card's notes depend on them, and the lot it moves to. A small race stays between that read and
//     the write.
//   - A lost answer (status 0 or 5xx) is never sent again. Jack reads the building again: Jack's values
//     there mean it landed; the old values and an unmoved updated_at mean it didn't; anything else is
//     "check the Inventory tab before trying again".
//   - Undo reads again and puts back only the fields that still hold Jack's value. Anything changed since
//     is named and left. A sold-since building keeps its new price and stays off the shop.
//   - Every price card on a building that's listed with its price shown, while the shop is on and shows
//     prices, says the new price goes live publicly at once and that an online deposit or payment is
//     charged against it. A listing card that puts a building on the shop says which of Carolyn's rules a
//     shop request or purchase can start (ruleWarn.ts).
//   - Customer names never reach Claude: list_inventory's estimates and the buyer's first name are never
//     picked. Lot streets aren't either (list_locations). Phone numbers, emails and street lines in the
//     builder's own listing words are scrubbed, and Claude may not put the blanks back in.
//   - Refs, not ids: "u-" or "p-" and the id spelled in letters, so no ref reads as a phone number.

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, TurnState, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { scrub } from "./redact.ts";
import { RULE_WARN_SAID, ruleWarning } from "./ruleWarn.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Report = { label: string; status: string; reason: string };

/** The Jack switch for changing work records (inventory, orders, schedules). */
export const RECORDS_SWITCH = "records";
export const WHERE = "Inventory";
const ROUTE = { page: "inventory", sub: null };
/** A typo guard: $1,000,000, the same ceiling setup.ts puts on a catalog price. A lot building above it is
 *  a slipped digit or a number made up, and a person types it on the Inventory tab if it's real. */
export const PRICE_MAX_CENTS = 100_000_000;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;
/** Buildings in look_at_inventory's list. A search narrows it. */
export const LIST_ROWS = 40;
/** How much of a listing description look_at_inventory's list shows. The full look shows it all. */
export const LIST_DESCRIPTION = 200;
/** A change this far from the price now, either way, gets a line on the card. */
export const BIG_CHANGE_PCT = 50;
/** The events a listed building invites: a shopper's request or purchase, and an "ask about this
 *  building" that adds a customer and tags them (capture-lead). */
export const LISTING_EVENTS = ["shop_request", "shop_purchase", "contact_created", "label_added"];

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

export const INV_SAID = {
  noRef: "I couldn't find that building. Look again with look_at_inventory and use its ref.",
  noPhotoRef: (ref: string) => `${ref ? `"${scrub(ref, 40)}"` : "That"} isn't one of this building's photos. Look at the building again with look_at_inventory and use its photo refs.`,
  photoTwice: "Each photo goes in the order once.",
  fewPhotos: "This building has fewer than two photos, so there's no order to change.",
  pickAction: "Pick what to change: price_and_lot, listing or photos.",
  separate: (action: string) => `Those are a separate card. Call propose_inventory_change again with action ${action} for them.`,
  nothing: "Nothing would change: that's how it stands now. Say so, and don't make a card.",
  askWhat: "Tell me what to change on it.",
  badPrice: "Say the price in dollars, like 8450 or 8,450.00.",
  zero: "An asking price of $0 would show the building as free. To take the price off, use none.",
  tooHigh: "That's over $1,000,000, which looks too high to be right. Check it with the person and ask again. If it's right, they can type it on the Inventory tab.",
  soldPrice: "That building is sold, so its price is on its invoice now. I don't change a sold building's asking price.",
  soldList: "That building is sold, so I won't put it on your Online Shop.",
  blanks: "Those words have a [phone], [email] or [address] blank in them. The blanks stand for details you can't see. Leave them out, or ask the person to type them.",
  descriptionCut: "That has the list's cut-short copy of the description in it, so the rest of the description would be lost. Look at the building with its ref to see the whole description, then write it again.",
  titleLong: (n: number) => `A listing title can be ${TITLE_MAX} characters at most. That one is ${n}.`,
  descriptionLong: (n: number) => `A listing description can be ${DESCRIPTION_MAX.toLocaleString("en-US")} characters at most. That one is ${n.toLocaleString("en-US")}.`,
  shopUnread: "I couldn't check your Online Shop just now, so I won't guess. Please try again.",
  paymentsUnsure: "cardPaymentsSwitchedOn only says card payments are switched on in Settings. Whether a shopper can pay online at checkout depends on more than that, so never tell the person a shopper can or can't pay online.",
  lotsUnread: "I couldn't read your lots just now, so I won't guess. Please try again.",
  // Approve
  emptyCard: "There's nothing on that card I can save. Ask me again.",
  applyRead: "I couldn't check this building just now, so nothing was saved. Ask me again in a moment.",
  gone: "That building isn't in your inventory any more, so nothing was saved.",
  moved: (what: string) => `${what} changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now.`,
  movedAny: "Something on this building changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now.",
  soldSince: "That building sold since I showed you this, so nothing was saved.",
  photosMoved: "Its photos changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now.",
  shopMoved: "Your Online Shop's settings changed since I showed you this, so nothing was saved. Ask me again.",
  shopRead: "I couldn't check your Online Shop just now, so nothing was saved. Ask me again in a moment.",
  lotGone: "That lot isn't on your list of lots any more, so nothing was saved.",
  lotsRead: "I couldn't check your lots just now, so nothing was saved. Ask me again in a moment.",
  notSent: "That didn't go through, and nothing changed. Ask me again.",
  unsure: `I couldn't tell if that saved. Check ${WHERE} before trying again.`,
  partOrder: `Only part of the new photo order saved. Press Undo to put the old order back, or fix it on the ${WHERE} tab.`,
  refused: (said: string) => `${said} Nothing was saved.`,
  // Undo
  undoRead: "I couldn't read your inventory just now. Press Undo to try again.",
  undoAgain: "That didn't go through. Press Undo to try again.",
  undoGone: "That building isn't in your inventory any more.",
  changedSince: "This was changed since, so I left it.",
  photosChangedSince: "The photos were changed since, so I left them as they are.",
  soldKeepPrice: "It sold since, so I left its price as it is.",
  soldKeepOff: "It sold since, so I left it off your Online Shop.",
};

/** What a card says before Approve. */
export const INV_NOTES = {
  priceLive: "This building is listed on your Online Shop with its price shown, so the new price shows publicly as soon as you approve. A deposit or payment taken online is charged against it.",
  priceUndo: "Undo can't take back a deposit or payment someone makes at the new price before then.",
  callForPrice: "It's listed on your Online Shop with its price shown, so the shop will say Call for price instead.",
  lotRecord: "This changes the record only. It doesn't move the building or plan a haul.",
  lotShop: "Your Online Shop shows the new lot, and its checkout uses that lot's tax rate and delivery distance.",
  lotSold: "It's sold, so the Delivery Schedule will pick it up from the new lot.",
  shopOff: "Your Online Shop is off, so this won't show anywhere until the shop is turned on.",
  goesPublic: "Once you approve, anyone can see this building on your Online Shop.",
  priceShown: (price: string) => `Its price, ${price}, shows there. A deposit or payment taken online is charged against it.`,
  priceShownNow: (price: string) => `Its price, ${price}, shows publicly as soon as you approve. A deposit or payment taken online is charged against it.`,
  noPrice: "It has no asking price, so it shows as Call for price.",
  pricesHidden: "Your shop hides all prices right now, so no price shows there.",
  priceStaysHidden: "Its price stays hidden on the shop.",
  priceComesOff: "Its price comes off your Online Shop as soon as you approve, and it shows as Call for price.",
  noPhotos: "It has no photos yet. Listings without photos get far fewer inquiries.",
  listUndo: "Undo takes it off the shop again, but it can't take back a request or purchase made while it was listed.",
  comesOff: "It comes off your Online Shop as soon as you approve.",
  wordsLive: "The new words show on your Online Shop as soon as you approve.",
  contactDropped: "The description there now has a phone number, email or street in it. Check the new one says what you want.",
  coverLive: "The first photo is its cover on your Online Shop, and that changes as soon as you approve.",
  coverMaybe: "If this building is on your Online Shop, the first photo is its cover there.",
  bigChange: (pct: number, lower: boolean, from: string) => `That's ${pct}% ${lower ? "lower" : "higher"} than the price now (${from}).`,
};

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** A listing text as the route stores it: trimmed, and empty is no text. */
const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};
const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const arr = (v: unknown): Any[] => (Array.isArray(v) ? v : []);
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const landed = (r: Res) => r.status === 200 && !!r.data && r.data.ok === true;
/** No answer, or the route fell over: it may have landed, so it's never sent again. */
const lost = (r: Res) => r.status === 0 || r.status >= 500 || (r.status === 200 && !(r.data && r.data.ok === true));
const safe = (p: Promise<Res>): Promise<Res> => p.catch(() => ({ status: 0, data: null }));

/** Cents for a person or Claude: "$8,450", or "$8,450.50" with cents. */
export function money(cents: number | null): string {
  if (cents === null) return "No price";
  const whole = cents % 100 === 0;
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** A price the person gave, in cents, or why not. "none" takes the price off. */
export function parsePrice(raw: string): { cents: number | null } | { error: string } {
  const t = raw.trim();
  if (/^(none|no price|remove|clear)$/i.test(t)) return { cents: null };
  const v = t.replace(/^\$\s*/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v) && !/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(v)) return { error: INV_SAID.badPrice };
  const cents = Math.round(Number(v.replace(/,/g, "")) * 100);
  if (!Number.isFinite(cents)) return { error: INV_SAID.badPrice };
  if (cents <= 0) return { error: INV_SAID.zero };
  if (cents > PRICE_MAX_CENTS) return { error: INV_SAID.tooHigh };
  return { cents };
}

// ── Refs: letters, stable across turns, never the uuid ─────────────────────────────────────────────

const LETTERS = "bcdfghjkmnpqrstv";
const spell = (id: string) => id.replace(/[^0-9a-f]/gi, "").toLowerCase().split("").map((c) => LETTERS[parseInt(c, 16)]).join("");

/** Each id's ref: the prefix, a dash, and the shortest spelling of the id (5 letters or more) that no
 *  other id in the list shares. */
export function refsOf(ids: string[], prefix: "u" | "p"): Map<string, string> {
  const spelled = ids.map(spell);
  const out = new Map<string, string>();
  ids.forEach((id, i) => {
    let n = 5;
    while (n < spelled[i].length && spelled.some((s, j) => j !== i && s.startsWith(spelled[i].slice(0, n)))) n++;
    out.set(id, `${prefix}-${spelled[i].slice(0, n)}`);
  });
  return out;
}

/** The one item a ref names: its spelling must start the id's, and only one may match. */
export function byRef<T extends { id: string }>(items: T[], ref: unknown, prefix: "u" | "p"): T | null {
  const raw = String(ref ?? "").trim().toLowerCase();
  const m = new RegExp(`^${prefix}-?([${LETTERS}]{5,})$`).exec(raw);
  if (!m) return null;
  const hits = items.filter((x) => spell(x.id).startsWith(m[1]));
  return hits.length === 1 ? hits[0] : null;
}

// ── Reads (portal-settings, the caller's own token) ─────────────────────────────────────────────────

export interface Photo { id: string; url: string; aiEdited: boolean }
export interface Unit {
  id: string; serial: number | null; style: string | null; size: string | null;
  locationId: string | null; locationName: string | null; locationCity: string | null;
  askingPriceCents: number | null; lifecycle: string | null; lifecycleLabel: string | null; saleState: string | null;
  updatedAt: string | null; listed: boolean; showPriceOnline: boolean; publicTitle: string | null; publicDescription: string | null;
  photos: Photo[];
}
export interface Shop { enabled: boolean; hideAllPrices: boolean; paymentsLive: boolean }
export interface Lot { id: string; name: string | null; city: string | null }

/** One list_inventory row, picked. Never `estimates` (customers' names), `soldFirstName`, the design
 *  codes or the plan image: only the building, its lot, its price and its listing. */
export function asUnit(r: Any): Unit {
  return {
    id: String(r?.id ?? ""), serial: numOr(r?.serial), style: str(r?.style), size: str(r?.size),
    locationId: str(r?.locationId), locationName: str(r?.locationName), locationCity: str(r?.locationCity),
    askingPriceCents: numOr(r?.askingPriceCents), lifecycle: str(r?.lifecycle), lifecycleLabel: str(r?.lifecycleLabel),
    saleState: str(r?.saleState), updatedAt: str(r?.updatedAt),
    listed: r?.listed === true, showPriceOnline: r?.showPriceOnline !== false,
    publicTitle: txt(r?.publicTitle), publicDescription: txt(r?.publicDescription),
    photos: arr(r?.photos).filter((p) => p && typeof p.id === "string").map((p) => ({ id: String(p.id), url: String(p.url ?? ""), aiEdited: p.aiEdited === true })),
  };
}

export async function readUnits(deps: Deps): Promise<{ units: Unit[] } | { error: string }> {
  const r = await safe(deps.portal("list_inventory", {}));
  if (r.status === 403) return { error: saidBy(r, SAID.noSee) };
  if (r.status !== 200 || !r.data || r.data.ok !== true || !Array.isArray(r.data.units)) return { error: SAID.readFailed };
  return { units: (r.data.units as Any[]).filter((u) => u && typeof u.id === "string" && u.id).map(asUnit) };
}

export async function readShop(deps: Deps): Promise<{ shop: Shop } | { error: string }> {
  const r = await safe(deps.portal("shop_settings", {}));
  const s = r.data?.settings as Any;
  if (r.status !== 200 || !r.data || r.data.ok !== true || !s || typeof s !== "object") return { error: INV_SAID.shopUnread };
  return { shop: { enabled: s.enabled === true, hideAllPrices: s.hideAllPrices === true, paymentsLive: r.data.paymentsLive === true } };
}

/** The active lots. Only id, name and town: list_locations also carries each lot's street. */
export async function readLots(deps: Deps): Promise<{ lots: Lot[] } | { error: string }> {
  const r = await safe(deps.portal("list_locations", {}));
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.locations)) return { error: INV_SAID.lotsUnread };
  return {
    lots: (r.data.locations as Any[]).filter((l) => l && typeof l.id === "string" && l.active !== false)
      .map((l) => ({ id: String(l.id), name: str(l.name), city: str(l.city) })),
  };
}

// ── Saying a building ───────────────────────────────────────────────────────────────────────────

const words = (s: string | null) => (s ? s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);
/** "10x16 Lofted Barn". */
export const buildingOf = (u: Unit) => [u.size, words(u.style)].filter(Boolean).join(" ") || "Building";
/** "#1042 10x16 Lofted Barn": what a card's title calls it. Never a customer's name. */
export const labelOf = (u: Unit) => `${u.serial !== null ? `#${u.serial} ` : ""}${buildingOf(u)}`;
const lotName = (name: string | null, city: string | null) =>
  name ? (city && norm(city) !== norm(name) ? `${name} (${city})` : name) : city ?? "A lot";
const unitLot = (u: Unit) => (u.locationId ? lotName(u.locationName, u.locationCity) : "No lot");
const onShop = (b: unknown) => (b === true ? "Listed" : "Not listed");
const shown = (b: unknown) => (b === true ? "Shown" : "Hidden");

/** A description as look_at_inventory's list shows it: scrubbed, and cut with "…" past LIST_DESCRIPTION. */
const listDescription = (d: string) => scrub(d, LIST_DESCRIPTION);

/** One building for Claude. Every string scrubbed; no ids. */
function unitForClaude(u: Unit, ref: string, full: boolean) {
  const desc = u.publicDescription;
  const shortDesc = desc && !full ? listDescription(desc) : null;
  const photoRefs = refsOf(u.photos.map((p) => p.id), "p");
  return {
    ref,
    serial: u.serial,
    building: scrub(buildingOf(u), 120),
    lot: u.locationId ? scrub(lotName(u.locationName, u.locationCity), 120) : null,
    askingPrice: u.askingPriceCents === null ? "no price" : money(u.askingPriceCents),
    status: u.lifecycleLabel ? scrub(u.lifecycleLabel, 80) : null,
    sold: u.saleState === "sold",
    online: {
      listed: u.listed,
      priceShown: u.showPriceOnline,
      title: u.publicTitle ? scrub(u.publicTitle, TITLE_MAX + 1) : null,
      description: desc ? (shortDesc ?? scrub(desc, DESCRIPTION_MAX + 1)) : null,
      ...(shortDesc && shortDesc !== scrub(desc, DESCRIPTION_MAX + 1) ? { descriptionCut: true } : {}),
    },
    photos: full
      ? u.photos.map((p, i) => ({ ref: photoRefs.get(p.id)!, position: i + 1, cover: i === 0, aiEdited: p.aiEdited }))
      : u.photos.length,
  };
}

// ── look_at_inventory ─────────────────────────────────────────────────────────────────────────────

const lookTool: ToolSpec = {
  def: {
    name: "look_at_inventory",
    description: "Read this builder's lot buildings (the Inventory tab): each one's ref, serial number, size and style, lot, asking price, build status, whether it's sold, its Online Shop listing (listed, price shown, title, description) and how many photos it has. Give one building's ref to see it in full, with its whole description and a ref for each photo in order (the first is the cover). It also lists their lots and says whether the Online Shop is on. Use it before propose_inventory_change.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["unit", "search"],
      properties: {
        unit: { type: "string", description: "One building's ref (u-...) to see it in full, with its photos. Empty for the list." },
        search: { type: "string", description: "Words that narrow the list: a serial number, size, style, lot or title. Empty for every building." },
      },
    },
  },
  needs: [{ area: "inventory", level: "view" }],
  switchKey: RECORDS_SWITCH,
  async run(deps, _s, input) {
    const i = (input ?? {}) as Any;
    const read = await readUnits(deps);
    if ("error" in read) return err(read.error);
    const [shop, lots] = await Promise.all([readShop(deps), readLots(deps)]);
    const refs = refsOf(read.units.map((u) => u.id), "u");
    // paymentsLive is only "card payments switched on, with a merchant". Whether a shopper can pay at
    // checkout also needs invoices kept in Structure Studio and no test mode (shop-checkout payReady),
    // which Jack can't read, so it never goes to Claude as "card payments are on".
    const common = {
      shop: "error" in shop ? null : { on: shop.shop.enabled, pricesHiddenOnShop: shop.shop.hideAllPrices, cardPaymentsSwitchedOn: shop.shop.paymentsLive },
      lots: "error" in lots ? null : lots.lots.map((l) => scrub(lotName(l.name, l.city), 120)),
      notes: [
        "Use a building's ref (u-...) and its photo refs (p-...) with propose_inventory_change, and a lot's name from lots.",
        "[phone], [email] and [address] stand for details you can't see. Never put them in a listing title or description.",
        "A description cut short in the list (descriptionCut) is only part of it. Look at the building with its ref before writing a new description from it.",
        ...("error" in shop ? [] : [INV_SAID.paymentsUnsure]),
        "You can change a building's asking price and lot, its Online Shop listing, and its photo order and cover. Adding or deleting a building, its design, adding or removing photos and the AI background are done by hand on the Inventory tab.",
        ...("error" in shop ? ["I couldn't read the Online Shop's settings just now."] : []),
        ...("error" in lots ? ["I couldn't read the lots just now."] : []),
      ],
    };
    const ref = String(i.unit ?? "").trim();
    if (ref) {
      const u = byRef(read.units, ref, "u");
      if (!u) return err(INV_SAID.noRef);
      return ok({ building: unitForClaude(u, refs.get(u.id)!, true), ...common });
    }
    const tokens = norm(i.search).split(" ").filter(Boolean);
    const hay = (u: Unit) => norm([u.serial ?? "", u.size, u.style, words(u.style), u.locationName, u.locationCity, u.publicTitle, u.lifecycleLabel, u.saleState === "sold" ? "sold" : "unsold"].join(" "));
    const hits = read.units.filter((u) => tokens.every((t) => hay(u).split(" ").some((w) => w === t || w.startsWith(t))));
    // Unsold first: those are the ones on the lot. The route's own order (newest first) otherwise.
    const sorted = [...hits.filter((u) => u.saleState !== "sold"), ...hits.filter((u) => u.saleState === "sold")];
    return ok({
      count: hits.length,
      buildings: sorted.slice(0, LIST_ROWS).map((u) => unitForClaude(u, refs.get(u.id)!, false)),
      ...(hits.length > LIST_ROWS ? { more: hits.length - LIST_ROWS, moreNote: "Narrow it with search to see the rest." } : {}),
      ...common,
    });
  },
};

// ── propose_inventory_change ─────────────────────────────────────────────────────────────────────

type FieldKey = "askingPriceCents" | "locationId" | "listed" | "showPriceOnline" | "publicTitle" | "publicDescription";
/** One field a card changes: what it is now, what Jack writes, and how each reads on the card. */
export interface Field { key: FieldKey; label: string; from: string | number | boolean | null; to: string | number | boolean | null; shownFrom: string; shownTo: string }

const LABEL: Record<FieldKey, string> = {
  askingPriceCents: "Asking price", locationId: "Lot", listed: "On your Online Shop", showPriceOnline: "Price on the shop",
  publicTitle: "Listing title", publicDescription: "Listing description",
};

/** A field as it stands, the way the route stores and list_inventory reads it back. */
function valueOf(u: Unit, key: FieldKey): string | number | boolean | null {
  switch (key) {
    case "askingPriceCents": return u.askingPriceCents;
    case "locationId": return u.locationId;
    case "listed": return u.listed;
    case "showPriceOnline": return u.showPriceOnline;
    case "publicTitle": return u.publicTitle;
    case "publicDescription": return u.publicDescription;
  }
}
/** A field's value in the route's body. The listing words go as text: the route stores "" as nothing. */
const bodyValue = (key: FieldKey, v: unknown) => (key === "publicTitle" || key === "publicDescription" ? String(v ?? "") : v ?? null);

interface ChangeIn { action: string; unit: string; price: string; lot: string; listed: string; showPrice: string; title: string; description: string; cover: string; photoOrder: string[] }
function inputOf(input: unknown): ChangeIn {
  const i = (input ?? {}) as Any;
  const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  // "keep" in a text field is the enums' word for "leave it", never a value to save.
  const t = (v: unknown) => (/^\s*keep\s*$/i.test(s(v)) ? "" : s(v));
  const e = (v: unknown) => (v === "yes" || v === "no" ? v : "keep");
  return {
    action: s(i.action).trim(), unit: s(i.unit).trim(), price: t(i.price).trim(), lot: t(i.lot).trim(),
    listed: e(i.listed), showPrice: e(i.showPrice), title: t(i.title), description: t(i.description),
    cover: t(i.cover).trim(), photoOrder: arr(i.photoOrder).map(s).map((x) => x.trim()).filter(Boolean),
  };
}
const ACTIONS = ["price_and_lot", "listing", "photos"] as const;
/** What a call asks of another action than its own: those are a card of their own. */
function strayOf(i: ChangeIn): string | null {
  const asks = {
    price_and_lot: !!(i.price || i.lot),
    listing: i.listed !== "keep" || i.showPrice !== "keep" || !!i.title.trim() || !!i.description.trim(),
    photos: !!i.cover || i.photoOrder.length > 0,
  };
  const other = ACTIONS.find((a) => a !== i.action && asks[a]);
  return other ? INV_SAID.separate(other) : null;
}

const BLANKS = /\[(phone|email|address)\]/i;

/** Who the card's notes depended on, so Approve can tell if that moved. */
interface Base { updatedAt: string | null; saleState: string | null }

async function priceCard(deps: Deps, s: TurnState, u: Unit, i: ChangeIn) {
  // Nothing asked isn't "that's how it stands": that would have Claude tell the person something
  // (a status, a sale) is already so.
  if (!i.price && !i.lot) return err(INV_SAID.askWhat);
  let cents: number | null | undefined;
  if (i.price) {
    const p = parsePrice(i.price);
    if ("error" in p) return err(p.error);
    cents = p.cents;
  }
  let lot: Lot | null = null;
  if (i.lot) {
    const read = await readLots(deps);
    if ("error" in read) return err(read.error);
    const hit = lotFor(read.lots, i.lot);
    if ("error" in hit) return err(hit.error);
    lot = hit.lot;
  }
  const fields: Field[] = [];
  if (cents !== undefined && !same(cents, u.askingPriceCents)) {
    if (u.saleState === "sold") return err(INV_SAID.soldPrice);
    fields.push({ key: "askingPriceCents", label: LABEL.askingPriceCents, from: u.askingPriceCents, to: cents, shownFrom: money(u.askingPriceCents), shownTo: money(cents) });
  }
  if (lot && lot.id !== u.locationId) {
    fields.push({ key: "locationId", label: LABEL.locationId, from: u.locationId, to: lot.id, shownFrom: unitLot(u), shownTo: lotName(lot.name, lot.city) });
  }
  if (!fields.length) return ok({ shown: false, note: INV_SAID.nothing });

  let shop: Shop | null = null;
  if (u.listed) {
    const read = await readShop(deps);
    if ("error" in read) return err(read.error);
    shop = read.shop;
  }
  const live = !!shop && u.listed && u.showPriceOnline && shop.enabled && !shop.hideAllPrices && u.saleState !== "sold";
  const notes: string[] = [];
  const price = fields.find((f) => f.key === "askingPriceCents");
  if (price && live) {
    notes.push(price.to === null ? INV_NOTES.callForPrice : INV_NOTES.priceLive);
    if (price.to !== null) notes.push(INV_NOTES.priceUndo);
  }
  if (price && typeof price.from === "number" && typeof price.to === "number" && price.from > 0) {
    const pct = Math.round((Math.abs(price.to - price.from) / price.from) * 100);
    if (pct >= BIG_CHANGE_PCT) notes.push(INV_NOTES.bigChange(pct, price.to < price.from, money(price.from)));
  }
  if (fields.some((f) => f.key === "locationId")) {
    notes.push(INV_NOTES.lotRecord);
    if (u.saleState === "sold") notes.push(INV_NOTES.lotSold);
    else if (shop && u.listed && shop.enabled) notes.push(INV_NOTES.lotShop);
  }
  const what = fields.length === 2 ? "Price and lot" : price ? "New asking price" : "Change the lot";
  const body: Record<string, unknown> = { unitId: u.id, ...Object.fromEntries(fields.map((f) => [f.key, bodyValue(f.key, f.to)])) };
  const base: Base = { updatedAt: u.updatedAt, saleState: u.saleState };
  await putCard(deps, s, {
    kind: "inventory_price",
    title: `${what}: ${labelOf(u)}`,
    preview: { unit: unitView(u), lines: linesOf(fields), notes, where: WHERE, route: ROUTE },
    payload: { unitId: u.id, body, fields, base, shop: shop && u.listed ? { enabled: shop.enabled, hideAllPrices: shop.hideAllPrices } : null, lotId: lot && fields.some((f) => f.key === "locationId") ? lot.id : null },
  });
  return answer(u, fields, notes);
}

function lotFor(lots: Lot[], want: string): { lot: Lot } | { error: string } {
  const n = norm(want);
  let hits = lots.filter((l) => norm(l.name) === n || norm(`${l.name ?? ""} ${l.city ?? ""}`) === n);
  if (!hits.length) hits = lots.filter((l) => norm(l.city) === n);
  if (hits.length === 1) return { lot: hits[0] };
  const said = (ls: Lot[]) => ls.map((l) => scrub(lotName(l.name, l.city), 80)).join(", ");
  if (hits.length > 1) return { error: `More than one lot matches "${scrub(want, 60)}": ${said(hits)}. Ask the person which one they mean.` };
  return { error: `There's no lot called "${scrub(want, 60)}". ${lots.length ? `The lots are: ${said(lots)}.` : "There aren't any lots set up."} Ask the person which one they mean, and don't guess.` };
}

async function listingCard(deps: Deps, s: TurnState, u: Unit, i: ChangeIn) {
  const want: Partial<Record<FieldKey, boolean | string | null>> = {};
  if (i.listed !== "keep") want.listed = i.listed === "yes";
  if (i.showPrice !== "keep") want.showPriceOnline = i.showPrice === "yes";
  for (const [key, raw, max, long] of [["publicTitle", i.title, TITLE_MAX, INV_SAID.titleLong], ["publicDescription", i.description, DESCRIPTION_MAX, INV_SAID.descriptionLong]] as const) {
    const t = raw.trim();
    if (!t) continue;
    if (/^none$/i.test(t)) { want[key] = null; continue; }
    if (t.length > max) return err(long(t.length));
    // The list's copy of a long description ends in "…": words built on it would save that cut and
    // drop the rest of the description.
    if (key === "publicDescription" && u.publicDescription) {
      const seen = listDescription(u.publicDescription);
      if (seen.endsWith("…") && t.includes(seen.slice(-20))) return err(INV_SAID.descriptionCut);
    }
    if (BLANKS.test(t)) return err(INV_SAID.blanks);
    want[key] = t;
  }
  if (!Object.keys(want).length) return err(INV_SAID.askWhat);
  const fields: Field[] = [];
  for (const key of ["listed", "showPriceOnline", "publicTitle", "publicDescription"] as const) {
    if (!(key in want)) continue;
    const from = valueOf(u, key), to = want[key] ?? null;
    if (same(from, to)) continue;
    const show = key === "listed" ? onShop : key === "showPriceOnline" ? shown : (v: unknown) => String(v ?? "");
    fields.push({ key, label: LABEL[key], from, to, shownFrom: show(from), shownTo: show(to) });
  }
  if (!fields.length) return ok({ shown: false, note: INV_SAID.nothing });
  const turnsOn = fields.some((f) => f.key === "listed" && f.to === true);
  if (turnsOn && u.saleState === "sold") return err(INV_SAID.soldList);

  const read = await readShop(deps);
  if ("error" in read) return err(read.error);
  const shop = read.shop;
  const after = { listed: (want.listed ?? u.listed) as boolean, showPriceOnline: (want.showPriceOnline ?? u.showPriceOnline) as boolean };
  const priceSet = u.askingPriceCents !== null;
  const notes: string[] = [];
  let rules: string | null = null;
  const changed = (k: FieldKey) => fields.some((f) => f.key === k);
  if (after.listed && !shop.enabled) notes.push(INV_NOTES.shopOff);
  else if (turnsOn) {
    notes.push(INV_NOTES.goesPublic);
    if (!after.showPriceOnline) notes.push(INV_NOTES.priceStaysHidden);
    else if (shop.hideAllPrices) notes.push(INV_NOTES.pricesHidden);
    else if (!priceSet) notes.push(INV_NOTES.noPrice);
    else notes.push(INV_NOTES.priceShown(money(u.askingPriceCents)));
    if (!u.photos.length) notes.push(INV_NOTES.noPhotos);
    rules = await listingRules(deps);
    if (rules) notes.push(rules);
    notes.push(INV_NOTES.listUndo);
  } else if (fields.some((f) => f.key === "listed" && f.to === false)) {
    if (shop.enabled) notes.push(INV_NOTES.comesOff);
  } else if (after.listed && shop.enabled) {
    if (changed("showPriceOnline") && after.showPriceOnline) {
      notes.push(shop.hideAllPrices ? INV_NOTES.pricesHidden : priceSet ? INV_NOTES.priceShownNow(money(u.askingPriceCents)) : INV_NOTES.noPrice);
    }
    if (changed("showPriceOnline") && !after.showPriceOnline) notes.push(INV_NOTES.priceComesOff);
    if (changed("publicTitle") || changed("publicDescription")) notes.push(INV_NOTES.wordsLive);
  }
  if (changed("publicDescription") && u.publicDescription && scrub(u.publicDescription, 100_000) !== u.publicDescription) notes.push(INV_NOTES.contactDropped);
  const title = turnsOn ? "List on your Online Shop" : fields.some((f) => f.key === "listed") ? "Take off your Online Shop" : "Online listing";
  const body: Record<string, unknown> = { unitId: u.id, ...Object.fromEntries(fields.map((f) => [f.key, bodyValue(f.key, f.to)])) };
  const base: Base = { updatedAt: u.updatedAt, saleState: u.saleState };
  await putCard(deps, s, {
    kind: "inventory_listing",
    title: `${title}: ${labelOf(u)}`,
    preview: { unit: unitView(u), lines: linesOf(fields), notes, where: WHERE, route: ROUTE },
    payload: { unitId: u.id, body, fields, base, shop: { enabled: shop.enabled, hideAllPrices: shop.hideAllPrices }, lotId: null },
  });
  return answer(u, fields, notes, rules);
}

/** What a listing invites, in words: Carolyn's rules that a shopper's request, purchase or question can
 *  start once it's on the shop. ruleWarning's own sentence says "this sets off", which a listing doesn't
 *  do by itself, so its findings are said the listing's way. */
async function listingRules(deps: Deps): Promise<string | null> {
  const w = await ruleWarning(deps, LISTING_EVENTS).catch(() => null);
  const what = "a request, purchase or question from your shop";
  if (!w) return `I couldn't check your rules just now. Once it's listed, ${what} may start one of them, and it may text or email the customer by itself.`;
  if (!w.sentence) return null;
  if (w.named.length) {
    const q = w.named.map((n) => `"${n}"`);
    const does = w.messages ? (w.named.length === 1 ? ", which texts or emails the customer by itself" : ". One or more of them texts or emails the customer by itself") : "";
    return `Once it's listed, ${what} can set off your rule${w.named.length === 1 ? "" : "s"} ${listOf(q)}${does}.`;
  }
  if (w.sentence === RULE_WARN_SAID.unread) return `I couldn't check your rules just now. Once it's listed, ${what} may start one of them, and it may text or email the customer by itself.`;
  return `Once it's listed, ${what} may start one of your rules, and it may text or email the customer by itself.`;
}

async function photosCard(deps: Deps, s: TurnState, u: Unit, i: ChangeIn) {
  if (!i.cover && !i.photoOrder.length) return err(INV_SAID.askWhat);
  if (u.photos.length < 2) return err(INV_SAID.fewPhotos);
  const named: Photo[] = [];
  for (const ref of i.photoOrder) {
    const p = byRef(u.photos, ref, "p");
    if (!p) return err(INV_SAID.noPhotoRef(ref));
    if (named.includes(p)) return err(INV_SAID.photoTwice);
    named.push(p);
  }
  let order = [...named, ...u.photos.filter((p) => !named.includes(p))];
  if (i.cover) {
    const c = byRef(u.photos, i.cover, "p");
    if (!c) return err(INV_SAID.noPhotoRef(i.cover));
    order = [c, ...order.filter((p) => p !== c)];
  }
  const from = u.photos.map((p) => p.id), to = order.map((p) => p.id);
  if (sameList(from, to)) return ok({ shown: false, note: INV_SAID.nothing });
  const pos = (p: Photo) => u.photos.indexOf(p) + 1;
  const coverMoves = to[0] !== from[0];
  const onlyCover = coverMoves && sameList(to.slice(1), from.filter((id) => id !== to[0]));
  const lines = [
    ...(coverMoves ? [{ label: "Cover photo", from: `Photo ${pos(u.photos[0])}`, to: `Photo ${pos(order[0])}` }] : []),
    ...(onlyCover ? [] : [{ label: "Order", from: u.photos.map(pos).join(", "), to: order.map(pos).join(", ") }]),
  ];
  const notes: string[] = [];
  if (u.listed && coverMoves) {
    const read = await readShop(deps);
    if ("error" in read) notes.push(INV_NOTES.coverMaybe);
    else if (read.shop.enabled) notes.push(INV_NOTES.coverLive);
  }
  await putCard(deps, s, {
    kind: "inventory_photos",
    title: `${onlyCover ? "New cover photo" : "Photo order"}: ${labelOf(u)}`,
    preview: {
      unit: unitView(u), lines, notes, where: WHERE, route: ROUTE,
      photos: { from: u.photos.map((p) => ({ url: p.url, aiEdited: p.aiEdited })), to: order.map((p) => ({ url: p.url, aiEdited: p.aiEdited })) },
    },
    payload: { unitId: u.id, body: { unitId: u.id, order: to }, from, to },
  });
  return ok({
    shown: true, serial: u.serial, building: scrub(buildingOf(u), 120),
    changing: lines.map((l) => `${l.label}: ${l.from} to ${l.to}`),
    notes,
    note: SAID.onScreenApprove,
  });
}

const unitView = (u: Unit) => ({ label: labelOf(u), lot: unitLot(u), status: u.lifecycleLabel, sold: u.saleState === "sold", listed: u.listed });
const linesOf = (fields: Field[]) => fields.map((f) => ({ label: f.label, from: f.shownFrom, to: f.shownTo, ...(f.key === "publicDescription" ? { long: true } : {}) }));

/** The tool's answer: what the card changes and what its notes say, scrubbed. */
function answer(u: Unit, fields: Field[], notes: string[], rules: string | null = null) {
  // The serial apart from the size: "#10423 12x24" in one string reads as a phone number to scrub().
  return ok({
    shown: true,
    serial: u.serial,
    building: scrub(buildingOf(u), 120),
    changing: fields.map((f) => `${f.label}: ${scrub(f.shownFrom || "blank", 300)} to ${scrub(f.shownTo || "blank", 300)}`),
    notes: notes.map((n) => scrub(n, 400)),
    ...(rules ? { rules: scrub(rules, 400) } : {}),
    note: `${SAID.onScreenApprove}${notes.length ? " Say what its notes say in a sentence, especially anything about the Online Shop or rules." : ""}`,
  });
}

const proposeTool: ToolSpec = {
  def: {
    name: "propose_inventory_change",
    description: "Put a card on the person's screen that changes one lot building. It changes nothing until they press Approve. action price_and_lot: its asking price, the lot it's on, or both. action listing: its Online Shop listing (listed or not, price shown or hidden, title, description). action photos: the order of its photos, or which one is the cover. One action per card: leave the other action's fields empty or keep. Use refs and lot names from look_at_inventory, and only values the person gave you. It can't add or delete a building, change its design, add or remove photos, or set its status.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["action", "unit", "price", "lot", "listed", "showPrice", "title", "description", "cover", "photoOrder"],
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        unit: { type: "string", description: "The building's ref from look_at_inventory (u-...)." },
        price: { type: "string", description: "price_and_lot: the new asking price in dollars, like 8450 or 8,450.00, or none to take the price off. Empty to leave it." },
        lot: { type: "string", description: "price_and_lot: the lot to put it on, by its name from look_at_inventory. Empty to leave it." },
        listed: { type: "string", enum: ["keep", "yes", "no"], description: "listing: yes puts it on the Online Shop, no takes it off. keep otherwise." },
        showPrice: { type: "string", enum: ["keep", "yes", "no"], description: "listing: yes shows its price on the shop, no hides it. keep otherwise." },
        title: { type: "string", description: `listing: the new listing title, ${TITLE_MAX} characters at most, or none to clear it. Empty to leave it.` },
        description: { type: "string", description: `listing: the new listing description, ${DESCRIPTION_MAX} characters at most, or none to clear it. Empty to leave it.` },
        cover: { type: "string", description: "photos: the photo ref (p-...) to make the cover. Empty to leave it." },
        photoOrder: { type: "array", items: { type: "string" }, description: "photos: photo refs in the new order, the first is the cover. Photos left out follow in their order now. Empty to leave the order." },
      },
    },
  },
  needs: [{ area: "inventory", level: "edit" }],
  switchKey: RECORDS_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    if (!deps.canEdit("inventory")) return err(SAID.noAccess);
    const i = inputOf(input);
    if (!(ACTIONS as readonly string[]).includes(i.action)) return err(INV_SAID.pickAction);
    const stray = strayOf(i);
    if (stray) return err(stray);
    const read = await readUnits(deps);
    if ("error" in read) return err(read.error);
    const u = byRef(read.units, i.unit, "u");
    if (!u) return err(INV_SAID.noRef);
    if (i.action === "price_and_lot") return await priceCard(deps, s, u, i);
    if (i.action === "listing") return await listingCard(deps, s, u, i);
    return await photosCard(deps, s, u, i);
  },
};

// ── Approve ───────────────────────────────────────────────────────────────────────────────────────

const BODY_KEYS: Record<string, string[]> = {
  update_inventory: ["unitId", "askingPriceCents", "locationId"],
  save_inventory_listing: ["unitId", "listed", "showPriceOnline", "publicTitle", "publicDescription"],
};
const failed = (failure: string): ApplyOutcome => ({ patch: { status: "failed", failure, result: { saved: 0, created: 0, reports: [] } } });
const unsurePatch = (p: ProposalRow): ApplyOutcome => ({ patch: { status: "partly_applied", result: { saved: 0, created: 0, reports: [{ label: p.title, status: "error", reason: INV_SAID.unsure }] } } });
const routeRefused = (r: Res) => (r.status === 404 ? INV_SAID.gone : INV_SAID.refused(saidBy(r, "That didn't save.")));

/** A card's body holds only its route's keys, a change, and never a status. */
function bodyOk(action: string, body: Any, unitId: unknown, fields: Field[]): boolean {
  if (!body || typeof body !== "object" || typeof unitId !== "string" || body.unitId !== unitId) return false;
  const keys = Object.keys(body);
  return keys.length >= 2 && keys.every((k) => BODY_KEYS[action].includes(k)) && fields.length === keys.length - 1 && fields.every((f) => f.key in body);
}

/** The shop switches a card's notes depended on, read again. Null means they still stand. */
async function shopMoved(deps: Deps, was: { enabled: boolean; hideAllPrices: boolean } | null): Promise<string | null> {
  if (!was) return null;
  const read = await readShop(deps);
  if ("error" in read) return INV_SAID.shopRead;
  return read.shop.enabled !== was.enabled || read.shop.hideAllPrices !== was.hideAllPrices ? INV_SAID.shopMoved : null;
}

/** Price, lot or listing: re-read, compare, then ONE save with exactly the card's body. */
async function applyFields(deps: Deps, p: ProposalRow, action: "update_inventory" | "save_inventory_listing"): Promise<ApplyOutcome> {
  const pay = (p.payload ?? {}) as Any;
  const fields = arr(pay.fields) as Field[];
  const base = (pay.base ?? {}) as Base;
  if (!bodyOk(action, pay.body, pay.unitId, fields)) return failed(INV_SAID.emptyCard);
  const read = await readUnits(deps);
  if ("error" in read) return failed(INV_SAID.applyRead);
  const u = read.units.find((x) => x.id === pay.unitId);
  if (!u) return failed(INV_SAID.gone);
  const moved = fields.filter((f) => !same(valueOf(u, f.key), f.from)).map((f) => f.label);
  if (moved.length) return failed(INV_SAID.moved(listOf(moved)));
  if (u.saleState !== (base.saleState ?? null) && u.saleState === "sold") return failed(INV_SAID.soldSince);
  if (u.updatedAt !== (base.updatedAt ?? null) || u.saleState !== (base.saleState ?? null)) return failed(INV_SAID.movedAny);
  const shop = await shopMoved(deps, pay.shop ?? null);
  if (shop) return failed(shop);
  if (typeof pay.lotId === "string") {
    const lots = await readLots(deps);
    if ("error" in lots) return failed(INV_SAID.lotsRead);
    if (!lots.lots.some((l) => l.id === pay.lotId)) return failed(INV_SAID.lotGone);
  }
  const r = await safe(deps.portal(action, pay.body));
  const done: ApplyOutcome = { patch: { status: "applied", result: { saved: fields.length, created: 0, reports: [] }, undo: { unitId: u.id, fields, saleState: u.saleState } } };
  if (landed(r)) return done;
  if (!lost(r)) return failed(routeRefused(r));
  // The answer was lost. Never sent again: the building says whether it landed.
  const again = await readUnits(deps);
  if ("error" in again) return unsurePatch(p);
  const now = again.units.find((x) => x.id === u.id);
  if (!now) return unsurePatch(p);
  if (fields.every((f) => same(valueOf(now, f.key), f.to))) return done;
  if (fields.every((f) => same(valueOf(now, f.key), f.from)) && now.updatedAt === u.updatedAt) return failed(INV_SAID.notSent);
  return unsurePatch(p);
}

/** Photo order: re-read, compare the order, then ONE save of the whole order. */
async function applyPhotos(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const pay = (p.payload ?? {}) as Any;
  const from = arr(pay.from).map(String), to = arr(pay.to).map(String);
  const body = pay.body as Any;
  const keys = body && typeof body === "object" ? Object.keys(body).sort() : [];
  if (!sameList(keys, ["order", "unitId"]) || body.unitId !== pay.unitId || !sameList(arr(body.order).map(String), to) || to.length < 2 || [...to].sort().join() !== [...from].sort().join()) {
    return failed(INV_SAID.emptyCard);
  }
  const read = await readUnits(deps);
  if ("error" in read) return failed(INV_SAID.applyRead);
  const u = read.units.find((x) => x.id === pay.unitId);
  if (!u) return failed(INV_SAID.gone);
  if (!sameList(u.photos.map((x) => x.id), from)) return failed(INV_SAID.photosMoved);
  const r = await safe(deps.portal("save_inventory_photos", body));
  const done = (stood: string[]): ApplyOutcome => ({ patch: { status: "applied", result: { saved: 1, created: 0, reports: [] }, undo: { unitId: u.id, from, to: stood } } });
  const part = (stood: string[]): ApplyOutcome => ({
    patch: { status: "partly_applied", result: { saved: 0, created: 0, reports: [{ label: p.title, status: "error", reason: INV_SAID.partOrder }] }, undo: { unitId: u.id, from, to: stood } },
  });
  const decide = (stood: string[] | null, unmoved: ApplyOutcome): ApplyOutcome => {
    if (!stood) return unsurePatch(p);
    if (sameList(stood, to)) return done(to);
    if (sameList(stood, from)) return unmoved;
    // The same photos in an order that is neither: part of this press landed. Undo can put it back.
    return [...stood].sort().join() === [...from].sort().join() ? part(stood) : unsurePatch(p);
  };
  // The route answers with the whole list as it now stands, so a 200 says what landed.
  if (landed(r)) {
    const stood = Array.isArray(r.data?.photos) ? (r.data!.photos as Any[]).map((x) => String(x?.id ?? "")) : null;
    return decide(stood, failed(INV_SAID.notSent));
  }
  if (!lost(r)) return failed(routeRefused(r));
  const again = await readUnits(deps);
  const now = "error" in again ? null : again.units.find((x) => x.id === u.id) ?? null;
  return decide(now ? now.photos.map((x) => x.id) : null, failed(INV_SAID.notSent));
}

// ── Undo ──────────────────────────────────────────────────────────────────────────────────────────

const undoFailed = (label: string, reason: string): UndoOutcome => ({ restored: 0, removed: 0, failed: 1, reports: [{ label, status: "error", reason }] });

/** Puts back each field that still holds what the card saved. One save, with only those keys. */
async function undoFields(deps: Deps, p: ProposalRow, action: "update_inventory" | "save_inventory_listing"): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { unitId?: string; fields?: Field[]; saleState?: string | null };
  const read = await readUnits(deps);
  if ("error" in read) return undoFailed(p.title, INV_SAID.undoRead);
  const u = read.units.find((x) => x.id === plan.unitId);
  if (!u) return { restored: 0, removed: 0, failed: 0, reports: [{ label: p.title, status: "gone", reason: INV_SAID.undoGone }] };
  const soldSince = u.saleState === "sold" && (plan.saleState ?? null) !== "sold";
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  const back: Record<string, unknown> = { unitId: u.id };
  const going: Field[] = [];
  for (const f of plan.fields ?? []) {
    const now = valueOf(u, f.key);
    if (same(now, f.to)) {
      if (soldSince && f.key === "askingPriceCents") out.reports.push({ label: f.label, status: "kept", reason: INV_SAID.soldKeepPrice });
      else if (soldSince && f.key === "listed" && f.from === true) out.reports.push({ label: f.label, status: "kept", reason: INV_SAID.soldKeepOff });
      else { back[f.key] = bodyValue(f.key, f.from); going.push(f); }
    } else if (!same(now, f.from)) out.reports.push({ label: f.label, status: "changed", reason: INV_SAID.changedSince });
  }
  if (!going.length) return out;
  const r = await safe(deps.portal(action, back));
  const label = listOf(going.map((f) => f.label));
  if (landed(r)) out.restored += going.length;
  else if (r.status === 404) out.reports.push({ label: p.title, status: "gone", reason: INV_SAID.undoGone });
  else if (lost(r)) { out.failed++; out.reports.push({ label, status: "error", reason: INV_SAID.undoAgain }); }
  else out.reports.push({ label, status: "refused", reason: saidBy(r, "That didn't go back.") });
  return out;
}

/** Puts the old photo order back, only while the order is still the one this card left. */
async function undoPhotos(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { unitId?: string; from?: string[]; to?: string[] };
  const from = arr(plan.from).map(String), to = arr(plan.to).map(String);
  const read = await readUnits(deps);
  if ("error" in read) return undoFailed(p.title, INV_SAID.undoRead);
  const u = read.units.find((x) => x.id === plan.unitId);
  if (!u) return { restored: 0, removed: 0, failed: 0, reports: [{ label: p.title, status: "gone", reason: INV_SAID.undoGone }] };
  const now = u.photos.map((x) => x.id);
  if (sameList(now, from)) return { restored: 0, removed: 0, failed: 0, reports: [] };
  if (!sameList(now, to)) return { restored: 0, removed: 0, failed: 0, reports: [{ label: "Photo order", status: "changed", reason: INV_SAID.photosChangedSince }] };
  const r = await safe(deps.portal("save_inventory_photos", { unitId: u.id, order: from }));
  if (landed(r)) return { restored: 1, removed: 0, failed: 0, reports: [] };
  if (r.status === 404) return { restored: 0, removed: 0, failed: 0, reports: [{ label: p.title, status: "gone", reason: INV_SAID.undoGone }] };
  if (lost(r)) return undoFailed("Photo order", INV_SAID.undoAgain);
  return { restored: 0, removed: 0, failed: 0, reports: [{ label: "Photo order", status: "refused", reason: saidBy(r, "That didn't go back.") }] };
}

// ── The piece ─────────────────────────────────────────────────────────────────────────────────────

const fieldsNothing = (p: ProposalRow) => (arr(p.payload?.fields).length ? null : "Nothing would change, so there's nothing to approve.");

const kinds: KindSpec[] = [
  {
    kind: "inventory_price",
    areas: () => ["inventory"],
    switches: () => [RECORDS_SWITCH],
    where: WHERE,
    nothingToDo: fieldsNothing,
    apply: (deps, _who, p) => applyFields(deps, p, "update_inventory"),
    undo: (deps, _who, p) => undoFields(deps, p, "update_inventory"),
  },
  {
    kind: "inventory_listing",
    areas: () => ["inventory"],
    switches: () => [RECORDS_SWITCH],
    where: WHERE,
    nothingToDo: fieldsNothing,
    apply: (deps, _who, p) => applyFields(deps, p, "save_inventory_listing"),
    undo: (deps, _who, p) => undoFields(deps, p, "save_inventory_listing"),
  },
  {
    kind: "inventory_photos",
    areas: () => ["inventory"],
    switches: () => [RECORDS_SWITCH],
    where: WHERE,
    nothingToDo: (p) => (arr(p.payload?.to).length >= 2 ? null : "Nothing would change, so there's nothing to approve."),
    apply: (deps, _who, p) => applyPhotos(deps, p),
    undo: (deps, _who, p) => undoPhotos(deps, p),
  },
];

export const inventoryPiece: Piece = {
  name: "inventory",
  tools: [lookTool, proposeTool],
  kinds,
  can: [
    "Look at their lot buildings with look_at_inventory: price, lot, build status, Online Shop listing and photos, with a ref for each.",
    "Change a lot building's asking price or its lot, its Online Shop listing (listed or not, price shown or hidden, title, description), or its photo order and cover photo, with propose_inventory_change.",
  ],
  rules: [
    "Inventory: you change a lot building's asking price, its lot, its Online Shop listing and the order of its photos. Adding or deleting a building, changing its design, adding or removing photos and the AI photo background are done by hand on the Inventory tab. Say so plainly.",
    "A building's status follows the Build and Delivery schedules, and it sells when it's invoiced. Never offer to set either.",
    "Use the refs look_at_inventory gives, and lot names from its list. A price, a title or a description comes from what the person said, never from you.",
  ],
};

/** Every card kind this piece writes, for the database's kind list. */
export const INVENTORY_KINDS = kinds.map((k) => k.kind);

/** Exposed for tests. */
export const _test = { inputOf, strayOf, lotFor, valueOf, listingRules };
