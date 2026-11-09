// jack-agent: change orders on signed Structure Studio orders (changeorders_test.ts). Plan 5.9, and the
// cautious defaults Ahsan confirmed on 11-06 ("Change orders: only the ones the server prices, and never a
// second one").
//
// Jack changes the roof (type and color), the cladding or the paint (painted or not, body and trim colors)
// on a signed order. That is the order screen's live dropdowns: portal-settings stage_order_attribute_change
// prices the change from the builder's own catalog and raises a change order, and send_change_order emails
// it to the customer to sign. On a locked order Jack may ask for it to be unlocked (request_order_unlock),
// as its own card. Nothing else.
//
// THE RULES
//   - A tool reads, or writes ONE card. Only a person's Approve stages and sends, through the routes the
//     order screen uses, with that person's token, so today's gates apply: change_orders edit, the dealer
//     row scope ("That design is not one of yours."), the amendment gate, the one-live-change rule.
//   - Never a second change order. Any change order open (a draft) or waiting on the customer stops the
//     card, and stops Approve: staging would otherwise fold into it and rewrite one the customer may
//     already have been emailed. A person finishes or voids it first.
//   - No manual change orders (words and a typed total): they have no server route. No invoices, no money,
//     no fee decisions, no unlocking. decide_order_unlock, open_amendment, finalize_amendment,
//     attest_change_order, apply_change_order_money and every invoice and payment route are never called.
//   - Staging has no version check of its own, so Approve does it: it reads the gate, the design and the
//     order again, prices the change again (dryRun), and refuses (nothing staged) if anything the card
//     showed has moved: the six values, the wording the customer signs, the totals, the fee, the order total.
//   - The order screen's money check is repeated here: an order whose total isn't what its design prices
//     out at is refused, because signing would write over the money that was moved by hand.
//   - A lost answer is never sent again. A lost stage is read back from amendment_status; a lost send may
//     have emailed, so it gets no Undo and the card says to check before sending again.
//   - The change card is a send card (sends: true): Approve emails the customer, so it runs only from a
//     page that shows the words they sign (the press says send: true), like a reply or an estimate.
//   - It needs two switches: records, and sends (11-09, the cautious side, decided for Ahsan). With
//     sending off no change card is made, and one made before is refused at Approve. The unlock request
//     sends nothing and needs records only.
//   - Undo voids the change order, and only while it was never emailed (the send failed after staging).
//     It reads again first and voids only Jack's own change order, still waiting, still saying what Jack
//     staged, on a building still carrying Jack's values. After the email there is no Undo: the card says
//     a person voids it and speaks to the customer.
//   - Staging inserts the change order at pending_ack, which fires Carolyn's change_order_sent rule event
//     at once (even if the email fails), and the email can later fire email_opened and email_bounced. The
//     card says so (ruleWarn.ts).
//   - No customer name, phone, email, street or design code reaches Claude. Claude names an order by its
//     number, or by a look-up's list and row ref (lookups.ts lookupTarget).

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolOut, ToolSpec, TurnState, UndoOutcome } from "./types.ts";
import { dollars, err, ok, putCard, SAID, saidBy } from "./common.ts";
import { scrub } from "./redact.ts";
import { lookupTarget } from "./lookups.ts";
import { RULE_WARN_SAID, ruleWarning } from "./ruleWarn.ts";
import { SENDS_SWITCH } from "./drafts.ts";
import { designTotalCents } from "../_shared/estimateLines.ts";
import { CLADDING_OPTIONS, norm as attrNorm } from "../_shared/attributeLines.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Report = { label: string; status: string; reason: string };
type Progress = (patch: Record<string, unknown>) => Promise<void>;

/** The Jack switch for record changes (v2). */
export const CO_SWITCH = "records";
/** A change order emails the customer on Approve, so it also needs the switch that lets Approve send
 *  (drafts.ts SENDS_SWITCH, "Send replies, estimates and change orders when you press Approve"). Ahsan's
 *  cautious side, 11-09: an owner who turned sending off gets no change order emailed. An unlock request
 *  sends nothing and needs records only. */
export const CO_SEND_SWITCH = SENDS_SWITCH;
export const CO_WHERE = "the order's Change orders on the Orders tab";
/** What staging and the email can set off: the insert at pending_ack, then the email's open or bounce. */
export const CO_EVENTS = ["change_order_sent", "email_opened", "email_bounced"];
/** A row made this long before the press still counts as made by it (clocks differ a little). */
const SLACK_MS = 5 * 60_000;

export const CO_SAID = {
  noOrder: "Say which order: its number, or a row from a list you put on the screen.",
  notFound: (n: number) => `I can't find order #${n} among the orders you can see.`,
  notOnList: "I can't find that one on your list. Look it up again, then ask me.",
  customerRow: "That row is a customer, not an order. Use the order number from their orders.",
  unitRow: "That row is a building on the lot, not an order.",
  noDesign: "That order has no design behind it, so there's no building to change here.",
  listCut: "I couldn't read your whole order list just now. Look the customer up first, then use the order number it shows.",
  noOrders: "Opening orders isn't part of your access, so I can't look at this order.",
  noSS: "This order has no Structure Studio estimate, so it can't be changed from here.",
  noLines: "This order has no priced estimate on file. It has to be sent again from the designer first.",
  crm: "This account sends its paperwork through the CRM, so change orders aren't raised from the order screen here.",
  // The sends switch is off (CO_SEND_SWITCH): a change order emails the customer, so no card is made.
  sendsOff: "Sending is switched off for Jack on this account, and a change order emails the customer, so I can't put one on the screen. An owner or admin can turn sending back on from the Jack tab.",
  notSigned: "The customer hasn't signed this estimate yet, so there's no change order to raise. Change the estimate itself in the designer.",
  gateUnread: "I couldn't check whether this order is open for changes, so I won't guess. Please try again.",
  locked: "This order is signed and locked. Someone who approves changes has to unlock it first. I can ask for it to be unlocked.",
  askedAlready: "Someone has already asked for this order to be unlocked. Whoever approves changes decides it.",
  notLocked: "This order is open for changes, so it doesn't need unlocking. I can put the change itself on the screen.",
  noReason: "Say what needs changing, in a sentence. Whoever unlocks it reads this.",
  same: "That's what the order already has, so there's nothing to change.",
  nothing: "Say what to change: the roof type or color, the cladding, or the paint.",
  pickAction: "Pick change or ask_unlock.",
  noRoofLine: "This order's estimate has no roof line, so a roof change can't be priced here.",
  noPaintLine: "This order's estimate has no paint line, so a paint change can't be priced here.",
  noBuildingLine: "This order's estimate has no building line, so the cladding can't be changed here.",
  roofTypeFirst: "Say the roof type too: Shingle or Metal.",
  paintNeedsColors: "A painted building needs a body color and a trim color. Ask which ones.",
  unpaintedNoColors: "An unpainted building has no body or trim color. Leave those empty.",
  priceMissing: "I couldn't work out the totals for this change, so I won't show it. Please try again.",
  live: (n: unknown, draft: boolean) => draft
    ? `Change order CO-${n} is still open on this order. A person finishes it or voids it under ${CO_WHERE} first.`
    : `Change order CO-${n} is still waiting on the customer. A person records their answer or voids it under ${CO_WHERE} first.`,
  drift: (order: string, design: string) =>
    `This order's total (${order}) isn't what its design prices out at (${design}). A change from here would write over that difference, so I won't stage it. Sort it out on the order screen first.`,
  // At Approve.
  moved: (what: string) => `${what} changed since I showed you this, so nothing was saved. Ask me again and I'll start from the order as it is now.`,
  lockedNow: "This order was locked since I showed you this, so nothing was saved. I can ask for it to be unlocked.",
  repriceFailed: "I couldn't price the change again just now, so nothing was saved. Ask me again in a moment.",
  unsure: `I couldn't tell if that saved. Check ${CO_WHERE} before trying again.`,
  designNoCo: `The building shows the new choice, but no change order came back. Check ${CO_WHERE} before trying again.`,
  noCo: "The customer's signature wasn't on file any more, so the estimate itself changed and no change order was raised. Check the order.",
  race: `Another change order was opened on this order at the same moment, so the building may show the new choice with no change order behind it. Check ${CO_WHERE} before trying again.`,
  folded: (n: unknown) => `This change went into CO-${n}, which was already open, so I didn't email it. Check it under ${CO_WHERE}.`,
  notAsShown: (n: unknown) => `CO-${n} doesn't read the way the card showed, so I didn't email it. Check it under ${CO_WHERE}. Undo discards it.`,
  notChecked: (n: unknown) => `CO-${n} is staged, but I couldn't check it afterwards, so I didn't email it. Look at it under ${CO_WHERE}. Undo discards it.`,
  emailFailed: (n: unknown, why: string) => `CO-${n} is staged, but the email didn't go${why ? ` (${why})` : ""}. The customer can still sign it from their estimate page. Undo discards it.`,
  emailRefused: (n: unknown, why: string) => `CO-${n} is staged, but the email was refused: ${why} Undo discards it.`,
  emailUnsure: (n: unknown) => `CO-${n} is staged, but I couldn't tell if the email went to the customer. Check ${CO_WHERE} before sending it again. If it shouldn't stand, a person voids it there and speaks to the customer.`,
  unlockUnsure: "I couldn't tell if the request went. Check the order before asking again.",
  // A press that stalled or threw part way may have staged it and emailed the customer (types.ts gaveUp).
  gaveUp: `I couldn't tell if the change order was staged or emailed to the customer. Check ${CO_WHERE} before trying again.`,
  // Jack's line when this is the one card a turn made and Claude wrote no words (types.ts onScreen).
  onScreen: "It's on the screen. Check it over and press Approve to email the change order to the customer when it looks right.",
  // At Undo.
  undoRead: "I couldn't read the order just now. Press Undo to try again.",
  undoLost: "That didn't go through. Press Undo to try again.",
  notWaiting: (n: unknown) => `CO-${n} isn't waiting on the customer any more (it was signed or discarded), so I left it.`,
  changedSince: (n: unknown) => `CO-${n} or the building changed since I staged it, so I left it. A person can void it under ${CO_WHERE}.`,
  signedMeanwhile: (n: unknown) => `The customer answered CO-${n} while I was putting it back, so it may not match the building any more. Check the order under ${CO_WHERE} now.`,
  voidReason: "Undone with Jack before it was emailed to the customer.",
};

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => String(v ?? "").trim();
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cents = (dollarsIn: unknown): number | null => (num(dollarsIn) === null ? null : Math.round((dollarsIn as number) * 100));
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const lost = (r: Res) => r.status === 0 || r.status >= 500;
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const money = (c: number | null) => (c === null ? "no total" : dollars(c) ?? "no total");
/** Made at or after `fromMs`: a time that can't be read never counts. */
/** Whether two values differ the way the route tells a change from a no-op (attributeLines norm). */
const differs = (a: string, b: string) => attrNorm(a) !== attrNorm(b);
const madeSince = (iso: string | null | undefined, fromMs: number) => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) && t >= fromMs; };

/** A route's sentence, plain for a person: a dash is a pause, and a price sent to a customer is an
 *  estimate here whatever the route calls it. */
export function plainWords(s: string): string {
  return s.replace(/\s*(—|--)\s*/g, ": ").replace(/\bquotes\b/gi, "estimates").replace(/\bquote\b/gi, "estimate").replace(/\s+/g, " ").trim();
}
const routeSaid = (r: Res, fallback: string) => plainWords(saidBy(r, fallback));
/** The email's reason without the customer's address in it. */
const emailWhy = (v: unknown) => plainWords(scrub(v, 200)).replace(/\s*\(\s*\[email\]\s*\)/g, "").trim();

// ── What the routes answer ────────────────────────────────────────────────────────────────────────

export interface Attrs { roofType: string; roofColor: string; cladding: string; paintStatus: "Paint" | "Unpaint"; paintBody: string; paintTrim: string }
const ATTR_KEYS: (keyof Attrs)[] = ["roofType", "roofColor", "cladding", "paintStatus", "paintBody", "paintTrim"];

interface OrderRow { id: string; orderNo: number | null; code: string | null; building: string | null; totalCents: number | null }
interface Design { acceptedAt: string | null; quoteNumber: string | null; lines: Any[] | null; estimate: unknown; cur: Attrs }
interface Gate { signed: boolean; open: boolean; authority: string | null; feeCents: number; feeTaxable: boolean; coNo: unknown }
interface Amendment { id: string; coNo: unknown; status: string; source: string; description: string; totalAfterCents: number | null; createdAt: string | null }
interface Unlock { decision: string | null; requestedAt: string | null; expiresAt: string | null; reason: string }
interface Amend { gate: Gate; amendment: Amendment | null; unlock: Unlock | null; feeLabel: string }
interface Color { label: string; siding: boolean; trim: boolean; shingle: boolean; metal: boolean; custom: boolean }
interface Paperwork { colors: Color[]; cladding: { id: string; label: string | null }[] }

/** The six values as the order screen reads them off the design (portal/04-orders.jsx `cur`). */
export function curOf(d: Any): Attrs {
  const sel = d?.selections && typeof d.selections === "object" ? d.selections : {};
  const pc = d?.paint_colors && typeof d.paint_colors === "object" ? d.paint_colors : {};
  return {
    roofType: str(sel.roofType), roofColor: str(sel.roofColor), cladding: String(sel.cladding ?? ""),
    paintStatus: sel.paint && String(sel.paint).toLowerCase() === "painted" ? "Paint" : "Unpaint",
    paintBody: str(pc.body), paintTrim: str(pc.trim),
  };
}
/** The six values the design carries once the change is staged: the route's `next`, with an unpainted
 *  building's colors cleared as the route stores them. */
export function afterOf(cur: Attrs, attrs: Partial<Attrs>): Attrs {
  const next: Attrs = { ...cur, ...attrs };
  return next.paintStatus === "Paint" ? next : { ...next, paintBody: "", paintTrim: "" };
}
const sameAttrs = (a: Attrs, b: Attrs | null | undefined) => !!b && ATTR_KEYS.every((k) => a[k] === b[k]);

async function readOrders(deps: Deps, body: Record<string, unknown>): Promise<{ orders: OrderRow[] } | { error: string }> {
  const r = await deps.portal("orders_overview", body).catch(() => ({ status: 0, data: null }));
  if (r.status === 403 || r.status === 400) return { error: routeSaid(r, SAID.readFailed) };
  if (r.status !== 200 || !r.data || r.data.ok !== true) return { error: SAID.readFailed };
  if (r.data.complete !== true || !Array.isArray(r.data.orders)) return { error: CO_SAID.listCut };
  return {
    orders: (r.data.orders as Any[]).filter((o) => o && typeof o.id === "string").map((o) => ({
      // The customer's name is on this row and stays here: only the number and the building go on.
      id: o.id, orderNo: num(o.orderNo), code: typeof o.shortCode === "string" && o.shortCode.trim() ? o.shortCode.trim() : null,
      building: typeof o.building === "string" && o.building.trim() ? scrub(o.building, 80) : null, totalCents: num(o.totalCents),
    })),
  };
}
async function readOrder(deps: Deps, code: string): Promise<{ order: OrderRow } | { error: string }> {
  const read = await readOrders(deps, { shortCodes: [code] });
  if ("error" in read) return read;
  const order = read.orders.find((o) => o.code === code);
  return order ? { order } : { error: "I can't find that order among the ones you can see." };
}

async function readDesign(deps: Deps, code: string): Promise<{ design: Design } | { error: string }> {
  const r = await deps.portal("orders_designs", { shortCodes: [code], detail: true }).catch(() => ({ status: 0, data: null }));
  if (r.status === 403 || r.status === 400) return { error: routeSaid(r, SAID.readFailed) };
  if (r.status !== 200 || !r.data || r.data.ok !== true || !Array.isArray(r.data.designs)) return { error: SAID.readFailed };
  const d = (r.data.designs as Any[]).find((x) => x && x.short_code === code);
  if (!d) return { error: "I can't find that order's building among the ones you can see." };
  // Only what the change needs: never the contact blob, which holds the customer's phone and email.
  const est = d.estimate_lines && typeof d.estimate_lines === "object" ? d.estimate_lines : null;
  return {
    design: {
      acceptedAt: typeof d.accepted_at === "string" && d.accepted_at ? d.accepted_at : null,
      quoteNumber: typeof d.ss_quote_number === "string" && d.ss_quote_number ? d.ss_quote_number : null,
      lines: est && Array.isArray(est.lines) ? est.lines : null, estimate: est, cur: curOf(d),
    },
  };
}

async function readAmend(deps: Deps, code: string): Promise<{ amend: Amend } | { error: string }> {
  const r = await deps.portal("amendment_status", { shortCode: code }).catch(() => ({ status: 0, data: null }));
  if (r.status === 403 || r.status === 404 || r.status === 400) return { error: routeSaid(r, SAID.noSee) };
  if (r.status !== 200 || !r.data || r.data.ok !== true || !r.data.gate || typeof r.data.gate !== "object") return { error: SAID.readFailed };
  const g = r.data.gate as Any, a = r.data.amendment as Any, u = r.data.unlock as Any, pol = r.data.policy as Any;
  return {
    amend: {
      gate: {
        signed: g.signed === true, open: g.open === true, authority: typeof g.authority === "string" ? g.authority : null,
        feeCents: Number(g.fee_cents ?? 0) || 0, feeTaxable: g.fee_taxable === true, coNo: g.co_no ?? null,
      },
      amendment: a && typeof a === "object" && typeof a.id === "string"
        ? { id: a.id, coNo: a.co_no ?? null, status: String(a.status ?? ""), source: String(a.source ?? ""), description: String(a.description ?? ""), totalAfterCents: num(a.total_after_cents), createdAt: typeof a.created_at === "string" ? a.created_at : null }
        : null,
      unlock: u && typeof u === "object"
        ? { decision: typeof u.decision === "string" ? u.decision : null, requestedAt: typeof u.requested_at === "string" ? u.requested_at : null, expiresAt: typeof u.expires_at === "string" ? u.expires_at : null, reason: String(u.reason ?? "") }
        : null,
      feeLabel: pol && typeof pol.feeLabel === "string" && pol.feeLabel.trim() ? pol.feeLabel.trim() : "Change order fee",
    },
  };
}

async function readPaperwork(deps: Deps, code: string): Promise<{ paper: Paperwork } | { error: string }> {
  const r = await deps.portal("order_paperwork", { shortCode: code }).catch(() => ({ status: 0, data: null }));
  if (r.status === 400 && /CRM/i.test(String(r.data?.error ?? ""))) return { error: CO_SAID.crm };
  if (r.status === 403 || r.status === 404 || r.status === 400) return { error: routeSaid(r, SAID.readFailed) };
  if (r.status !== 200 || !r.data || r.data.ok !== true) return { error: SAID.readFailed };
  const colors = (Array.isArray(r.data.colors) ? r.data.colors as Any[] : []).filter((c) => c && typeof c.label === "string" && c.label.trim()).map((c) => ({
    label: String(c.label).trim(), siding: c.siding === true, trim: c.trim === true, shingle: c.shingle === true, metal: c.metal === true, custom: c.allow_custom === true,
  }));
  const cladding = (Array.isArray(r.data.cladding) ? r.data.cladding as Any[] : []).filter((c) => c && typeof c.id === "string").map((c) => ({ id: String(c.id), label: typeof c.label === "string" && c.label.trim() ? c.label.trim() : null }));
  return { paper: { colors, cladding } };
}

// ── Which order ───────────────────────────────────────────────────────────────────────────────────

interface Target { code: string; order: OrderRow }

/** The order Claude named: by its number, or by a row on one of this person's own look-up lists. */
async function targetOf(deps: Deps, s: TurnState, i: Any): Promise<Target | { error: string }> {
  const list = typeof i?.list === "string" ? i.list.trim() : "";
  const ref = typeof i?.ref === "string" ? i.ref.trim().toLowerCase() : "";
  if (list && ref) {
    if (/^c\d+$/.test(ref)) return { error: CO_SAID.customerRow };
    if (/^u\d+$/.test(ref)) return { error: CO_SAID.unitRow };
    const t = await lookupTarget(deps, s.who, list, ref).catch(() => null);
    if (!t) return { error: CO_SAID.notOnList };
    if (!t.shortCode) return { error: CO_SAID.noDesign };
    const read = await readOrder(deps, t.shortCode);
    return "error" in read ? read : { code: t.shortCode, order: read.order };
  }
  const n = typeof i?.orderNo === "number" && Number.isInteger(i.orderNo) && i.orderNo > 0 ? i.orderNo : 0;
  if (!n) return { error: CO_SAID.noOrder };
  const read = await readOrders(deps, {});
  if ("error" in read) return read;
  const hits = read.orders.filter((o) => o.orderNo === n);
  if (!hits.length) return { error: CO_SAID.notFound(n) };
  if (hits.length > 1) return { error: `More than one order is numbered #${n}. Look the customer up first and use the row it shows.` };
  if (!hits[0].code) return { error: CO_SAID.noDesign };
  return { code: hits[0].code, order: hits[0] };
}
const orderName = (o: OrderRow) => (o.orderNo !== null ? `#${o.orderNo}` : "this order");

// ── Where an order stands ─────────────────────────────────────────────────────────────────────────

const hasLine = (d: Design, kind: string) => (d.lines ?? []).some((l) => l && l.kind === kind);
/** An unlock somebody granted that ran out unused: a new request may go in (the route releases it). */
const unlockOver = (u: Unlock, now: number) => u.decision === "granted" && !!u.expiresAt && Date.parse(u.expiresAt) < now;

interface Standing {
  /** Why it can't be changed now, or null. */
  block: string | null;
  /** Whether a request to unlock it may be filed. */
  canAsk: boolean;
}

/** The order screen's own checks, in its order, plus the ones its dropdowns make in the browser. */
export function standing(order: OrderRow, d: Design, a: Amend, now: number): Standing {
  const no = (block: string, canAsk = false): Standing => ({ block, canAsk });
  if (!d.quoteNumber) return no(CO_SAID.noSS);
  if (!d.acceptedAt) return no(CO_SAID.notSigned);
  // The gate fails open on a read error (signed false, open true). The design is signed, so a gate that
  // says otherwise is a read that failed.
  if (!a.gate.signed) return no(CO_SAID.gateUnread);
  if (a.amendment) return no(CO_SAID.live(a.amendment.coNo, a.amendment.status === "draft"));
  if (a.gate.authority === "amendment") return no(CO_SAID.live(a.gate.coNo, false));
  if (!a.gate.open) {
    const u = a.unlock;
    if (u && u.decision === null) return no(CO_SAID.askedAlready);
    return no(CO_SAID.locked, !u || u.decision === "declined" || unlockOver(u, now));
  }
  if (a.gate.authority !== "free_window" && a.gate.authority !== "unlock") return no(CO_SAID.gateUnread);
  if (!d.lines || !d.lines.length) return no(CO_SAID.noLines);
  const designCents = designTotalCents(d.estimate);
  if (designCents !== null && order.totalCents !== null && designCents !== order.totalCents) return no(CO_SAID.drift(money(order.totalCents), money(designCents)));
  return { block: null, canAsk: false };
}

/** The fee sentence a person reads before Approve, or null. */
function feeLine(label: string, feeCents: number, taxable: boolean, ifUnlocked = false): string | null {
  if (!(feeCents > 0)) return null;
  const what = `${ifUnlocked ? "If it's unlocked, your" : "Your"} ${label.toLowerCase()} of ${dollars(feeCents)}${taxable ? " plus tax" : ""}`;
  return `${what} goes on this change and is added to what the customer owes when they sign.`;
}

// ── Names to values ───────────────────────────────────────────────────────────────────────────────

const shown = (v: string) => v || "none";
/** The palette's own spelling of a color for one use, or the sentence for why not. Custom-allowed rows
 *  aren't offered, as the order screen's dropdowns don't offer them. */
function colorFor(p: Paperwork, flag: "siding" | "trim" | "shingle" | "metal", asked: string, what: string): { label: string } | { error: string } {
  const offered = p.colors.filter((c) => c[flag] && !c.custom).map((c) => c.label);
  const hit = offered.find((l) => norm(l) === norm(asked));
  if (hit) return { label: hit };
  return { error: `There's no ${what} color called "${scrub(asked, 60)}". ${offered.length ? `The ones offered are: ${offered.slice(0, 40).map((l) => scrub(l, 40)).join(", ")}.` : "None are set up."} Ask which one they mean, and don't guess.` };
}
/** A cladding's name as the order screen shows it: the builder's own, else the built-in one, else its id. */
const cladName = (id: string, overrides: Record<string, string>) =>
  !id ? CLADDING_OPTIONS[0].label : overrides[id] || CLADDING_OPTIONS.find((c) => c.id === id)?.label || id;
/** The cladding this design's style offers, by id and name (portal ssCladdingOpts): the style's own list,
 *  or the built-in ones when the builder set none, and the design's current one kept on the list. */
function claddingChoices(p: Paperwork, current: string): { id: string; label: string }[] {
  const overrides: Record<string, string> = Object.fromEntries(p.cladding.filter((c) => c.label).map((c) => [c.id, c.label as string]));
  const ids = p.cladding.length ? p.cladding.map((c) => c.id) : CLADDING_OPTIONS.map((c) => c.id);
  const out = [{ id: "", label: cladName("", overrides) }, ...ids.filter(Boolean).map((id) => ({ id, label: cladName(id, overrides) }))];
  if (current && !out.some((r) => r.id === current)) out.push({ id: current, label: cladName(current, overrides) });
  return out;
}
const claddingName = (p: Paperwork, id: string) => claddingChoices(p, id).find((c) => c.id === id)?.label ?? cladName(id, {});

export interface ChangeIn { roofType: string; roofColor: string; cladding: string; paint: string; paintBody: string; paintTrim: string }
export interface Line { label: string; from: string; to: string }

/** The change, from names, against the design as it stands. Only the parts that change are sent, and a
 *  roof type always goes with its color. Exported for the tests. */
export function buildChange(d: Design, p: Paperwork, i: ChangeIn): { attrs: Partial<Attrs>; lines: Line[] } | { error: string } {
  const cur = d.cur;
  const attrs: Partial<Attrs> = {};
  const lines: Line[] = [];
  const wantType = i.roofType === "Shingle" || i.roofType === "Metal" ? i.roofType : null;
  const askedColor = str(i.roofColor);
  if (wantType || askedColor) {
    const type = wantType ?? cur.roofType;
    if (!type) return { error: CO_SAID.roofTypeFirst };
    const flag = norm(type) === "metal" ? "metal" : "shingle";
    if (!p.colors.some((c) => c[flag] && !c.custom)) return { error: `There are no ${type.toLowerCase()} roof colors set up, so the roof can't be ${type.toLowerCase()}.` };
    const typeChanges = differs(type, cur.roofType);
    let color = cur.roofColor;
    if (askedColor) {
      const hit = colorFor(p, flag, askedColor, `${type.toLowerCase()} roof`);
      if ("error" in hit) return hit;
      color = hit.label;
    } else if (typeChanges) {
      const offered = p.colors.filter((c) => c[flag] && !c.custom).map((c) => scrub(c.label, 40));
      return { error: `Which ${type.toLowerCase()} roof color? The ones offered are: ${offered.slice(0, 40).join(", ")}. Ask them, and don't pick one for them.` };
    }
    if (typeChanges || differs(color, cur.roofColor)) {
      if (!hasLine(d, "roof")) return { error: CO_SAID.noRoofLine };
      attrs.roofType = type;
      attrs.roofColor = color;
      if (typeChanges) lines.push({ label: "Roof type", from: shown(cur.roofType), to: type });
      if (differs(color, cur.roofColor)) lines.push({ label: "Roof color", from: shown(cur.roofColor), to: color });
    }
  }
  const askedClad = str(i.cladding);
  if (askedClad) {
    const choices = claddingChoices(p, cur.cladding);
    const hit = choices.find((c) => norm(c.label) === norm(askedClad) || (c.id && norm(c.id) === norm(askedClad)));
    if (!hit) return { error: `There's no cladding called "${scrub(askedClad, 60)}" on this building's style. The ones offered are: ${choices.map((c) => scrub(c.label, 40)).join(", ")}. Ask which one they mean, and don't guess.` };
    if (hit.id !== cur.cladding) {
      if (!hasLine(d, "building")) return { error: CO_SAID.noBuildingLine };
      attrs.cladding = hit.id;
      lines.push({ label: "Cladding", from: claddingName(p, cur.cladding), to: hit.label });
    }
  }
  const wantPaint = i.paint === "Painted" ? "Paint" : i.paint === "Unpainted" ? "Unpaint" : null;
  const askedBody = str(i.paintBody), askedTrim = str(i.paintTrim);
  if (wantPaint || askedBody || askedTrim) {
    const status = wantPaint ?? cur.paintStatus;
    // An unpainted building has no colors, whatever an old save left in paint_colors: look_at_order_for_change
    // never shows those, so painting it takes both colors by name rather than ones nobody chose.
    const curBody = cur.paintStatus === "Paint" ? cur.paintBody : "", curTrim = cur.paintStatus === "Paint" ? cur.paintTrim : "";
    let body = curBody, trim = curTrim;
    if (status === "Unpaint") {
      if (askedBody || askedTrim) return { error: CO_SAID.unpaintedNoColors };
    } else {
      if (askedBody) {
        const hit = colorFor(p, "siding", askedBody, "body");
        if ("error" in hit) return hit;
        body = hit.label;
      }
      if (askedTrim) {
        const hit = colorFor(p, "trim", askedTrim, "trim");
        if ("error" in hit) return hit;
        trim = hit.label;
      }
      if (!body || !trim) return { error: CO_SAID.paintNeedsColors };
    }
    const statusChanges = status !== cur.paintStatus;
    const colorsChange = status === "Paint" && (differs(body, curBody) || differs(trim, curTrim));
    if (statusChanges || colorsChange) {
      if (!hasLine(d, "paint")) return { error: CO_SAID.noPaintLine };
      attrs.paintStatus = status;
      if (status === "Paint") { attrs.paintBody = body; attrs.paintTrim = trim; }
      if (statusChanges) lines.push({ label: "Paint", from: cur.paintStatus === "Paint" ? "Painted" : "Unpainted", to: status === "Paint" ? "Painted" : "Unpainted" });
      if (status === "Paint" && differs(body, curBody)) lines.push({ label: "Body color", from: shown(curBody), to: body });
      if (status === "Paint" && differs(trim, curTrim)) lines.push({ label: "Trim color", from: shown(curTrim), to: trim });
    }
  }
  if (!wantType && !askedColor && !askedClad && !wantPaint && !askedBody && !askedTrim) return { error: CO_SAID.nothing };
  if (!lines.length) return { error: CO_SAID.same };
  return { attrs, lines };
}

interface Priced { totalBefore: number; totalAfter: number; description: string }

/** The route prices it without writing anything (dryRun). */
async function priceIt(deps: Deps, code: string, attrs: Partial<Attrs>): Promise<{ priced: Priced } | { error: string; lost?: boolean }> {
  const r = await deps.portal("stage_order_attribute_change", { shortCode: code, attrs, dryRun: true }).catch(() => ({ status: 0, data: null }));
  if (lost(r)) return { error: SAID.readFailed, lost: true };
  if (r.status !== 200) return { error: routeSaid(r, SAID.readFailed) };
  const d = r.data ?? {};
  const before = num(d.totalBefore), after = num(d.totalAfter);
  if (d.ok !== true || before === null || after === null || typeof d.description !== "string") return { error: CO_SAID.priceMissing };
  return { priced: { totalBefore: before, totalAfter: after, description: d.description } };
}

// ── look_at_order_for_change ──────────────────────────────────────────────────────────────────────

const orderFields = {
  orderNo: { type: "integer", description: "The order's number, like 1042 (look_up_customer shows them). 0 when you name it by list and ref." },
  list: { type: "string", description: "The list id a look-up gave you, used with ref. Empty when you use orderNo." },
  ref: { type: "string", description: "The order's row on that list, like o2. Empty when you use orderNo." },
};

const lookTool: ToolSpec = {
  def: {
    name: "look_at_order_for_change",
    description: "Read one signed order before changing its roof, cladding or paint: what the building has now, the colors and cladding it can take, whether a change order is already open or waiting on the customer, whether the order is locked, and the change order fee. Name it by its order number, or by a list and ref a look-up gave you. No customer details.",
    input_schema: { type: "object", additionalProperties: false, required: ["orderNo", "list", "ref"], properties: orderFields },
  },
  needs: [{ area: "change_orders", level: "view" }, { area: "orders", level: "view" }],
  switchKey: CO_SWITCH,
  async run(deps, s, input) {
    if (s.off.includes(CO_SWITCH)) return err(SAID.switchedOff);
    if (!deps.canRead("orders")) return err(CO_SAID.noOrders);
    if (!deps.canRead("change_orders")) return err(SAID.noSee);
    const t = await targetOf(deps, s, input);
    if ("error" in t) return err(t.error);
    const [dr, ar] = await Promise.all([readDesign(deps, t.code), readAmend(deps, t.code)]);
    if ("error" in dr) return err(dr.error);
    if ("error" in ar) return err(ar.error);
    const d = dr.design, a = ar.amend;
    const st = standing(t.order, d, a, deps.now());
    const facts: Record<string, unknown> = {
      order: orderName(t.order), orderNo: t.order.orderNo, building: t.order.building, total: money(t.order.totalCents), signed: !!d.acceptedAt,
    };
    const unlockFee = !a.gate.open && a.gate.signed ? feeLine(a.feeLabel, a.gate.feeCents, a.gate.feeTaxable, true) : null;
    if (st.block) {
      return ok({
        ...facts, canChange: false, why: st.block, canAskUnlock: st.canAsk && deps.canEdit("change_orders"),
        ...(unlockFee ? { fee: unlockFee } : {}),
        ...(a.unlock?.decision === "declined" ? { lastUnlock: "An earlier request to unlock it was declined." } : {}),
        note: st.canAsk ? "Say why in a sentence. If they want it unlocked, propose_change_order with action ask_unlock and what needs changing." : "Say why in a sentence, and point them to the order screen.",
      });
    }
    const pr = await readPaperwork(deps, t.code);
    if ("error" in pr) return err(pr.error);
    const p = pr.paper;
    const names = (flag: "siding" | "trim" | "shingle" | "metal") => p.colors.filter((c) => c[flag] && !c.custom).map((c) => scrub(c.label, 40)).slice(0, 60);
    const cur = d.cur;
    const fee = a.gate.authority === "unlock" ? feeLine(a.feeLabel, a.gate.feeCents, a.gate.feeTaxable) : null;
    // A change order emails the customer, so with sending switched off none can go on the screen.
    const sendsOff = s.off.includes(CO_SEND_SWITCH);
    const why = !deps.canEdit("change_orders") ? SAID.noAccess : sendsOff ? CO_SAID.sendsOff : null;
    return ok({
      ...facts,
      canChange: !why,
      ...(why ? { why } : {}),
      now: {
        roofType: shown(cur.roofType), roofColor: shown(scrub(cur.roofColor, 40)), cladding: scrub(claddingName(p, cur.cladding), 40),
        paint: cur.paintStatus === "Paint" ? "Painted" : "Unpainted",
        ...(cur.paintStatus === "Paint" ? { bodyColor: shown(scrub(cur.paintBody, 40)), trimColor: shown(scrub(cur.paintTrim, 40)) } : {}),
      },
      canTake: {
        ...(hasLine(d, "roof") ? { roofTypes: [...(names("shingle").length ? ["Shingle"] : []), ...(names("metal").length ? ["Metal"] : [])], shingleColors: names("shingle"), metalColors: names("metal") } : {}),
        ...(hasLine(d, "building") ? { cladding: claddingChoices(p, cur.cladding).map((c) => scrub(c.label, 40)) } : {}),
        ...(hasLine(d, "paint") ? { bodyColors: names("siding"), trimColors: names("trim") } : {}),
      },
      ...(fee ? { fee } : {}),
      note: why === CO_SAID.sendsOff
        ? "Say why in a sentence: sending is switched off for Jack here, so no change order can go on the screen. An owner or admin can turn sending back on from the Jack tab."
        : s.customerWordsRead
        // propose_change_order isn't offered once a customer's words are in the answer (a change order
        // changes a price): say the order number, and make the card when they reply.
        ? "Only the parts in canTake can change from here. A customer's words are in this answer, so the change order card can't go up in it: tell the person what can change and this order's number, and when they reply, use propose_change_order with action change and that order number. Use the names exactly as given here."
        : "Only the parts in canTake can change from here. To change it, use propose_change_order with action change and this order's number (or the same list and ref). Use the names exactly as given here, and ask which one when they don't say.",
    });
  },
};

// ── propose_change_order ──────────────────────────────────────────────────────────────────────────

const proposeTool: ToolSpec = {
  def: {
    name: "propose_change_order",
    description: "Put a change order for one signed order on the person's screen. It changes nothing: the person presses Approve, and then the change is staged, priced from their catalog and emailed to the customer to sign. action change: the roof type and color, the cladding, or the paint (painted or not, body and trim colors), by the names look_at_order_for_change gives. action ask_unlock: on a locked order, ask whoever approves changes to unlock it, with a sentence saying what needs changing. Never a change in words with a new total, never a second change while one is open or waiting on the customer, and never an invoice or money. Because action change emails the customer, it makes no card while sending is switched off for Jack, and says so. ask_unlock sends nothing and still works then.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["action", "orderNo", "list", "ref", "roofType", "roofColor", "cladding", "paint", "paintBody", "paintTrim", "reason"],
      properties: {
        action: { type: "string", enum: ["change", "ask_unlock"] },
        ...orderFields,
        roofType: { type: "string", enum: ["Shingle", "Metal", "same"], description: "The new roof type, or same to keep it." },
        roofColor: { type: "string", description: "The new roof color by its name. Needed when the roof type changes. Empty to keep it." },
        cladding: { type: "string", description: "The new cladding by its name. Empty to keep it." },
        paint: { type: "string", enum: ["Painted", "Unpainted", "same"], description: "Painted or Unpainted, or same to keep it." },
        paintBody: { type: "string", description: "The new body color by its name, for a painted building. Empty to keep it." },
        paintTrim: { type: "string", description: "The new trim color by its name, for a painted building. Empty to keep it." },
        reason: { type: "string", description: "ask_unlock only: what needs changing, in a sentence, for whoever unlocks it. 500 characters at most. Empty for change." },
      },
    },
  },
  needs: [{ area: "change_orders", level: "edit" }, { area: "orders", level: "view" }],
  switchKey: CO_SWITCH,
  // A change order changes what the customer pays: like a price card, not offered once a customer's words
  // are in the turn (agent.ts offered()). look_at_order_for_change carries no customer words.
  proposesChange: true,
  async run(deps, s, input) {
    if (s.off.includes(CO_SWITCH)) return err(SAID.switchedOff);
    if (!deps.canEdit("change_orders")) return err(SAID.noAccess);
    if (!deps.canRead("orders")) return err(CO_SAID.noOrders);
    const i = (input && typeof input === "object" ? input : {}) as Any;
    if (i.action === "ask_unlock") return await proposeUnlock(deps, s, i);
    if (i.action !== "change") return err(CO_SAID.pickAction);
    // Before anything is read: a change order card is a send card, and sending is switched off.
    if (s.off.includes(CO_SEND_SWITCH)) return err(CO_SAID.sendsOff);
    return await proposeChange(deps, s, i);
  },
};

async function proposeChange(deps: Deps, s: TurnState, i: Any): Promise<ToolOut> {
  const want: ChangeIn = { roofType: str(i.roofType), roofColor: str(i.roofColor), cladding: str(i.cladding), paint: str(i.paint), paintBody: str(i.paintBody), paintTrim: str(i.paintTrim) };
  const t = await targetOf(deps, s, i);
  if ("error" in t) return err(t.error);
  const [dr, ar] = await Promise.all([readDesign(deps, t.code), readAmend(deps, t.code)]);
  if ("error" in dr) return err(dr.error);
  if ("error" in ar) return err(ar.error);
  const d = dr.design, a = ar.amend;
  const st = standing(t.order, d, a, deps.now());
  if (st.block) return err(st.block);
  const pr = await readPaperwork(deps, t.code);
  if ("error" in pr) return err(pr.error);
  const built = buildChange(d, pr.paper, want);
  if ("error" in built) return err(built.error);
  const priced = await priceIt(deps, t.code, built.attrs);
  if ("error" in priced) return err(scrub(priced.error, 400));
  const pc = priced.priced;
  const warn = await ruleWarning(deps, CO_EVENTS);
  const beforeCents = cents(pc.totalBefore)!, afterCents = cents(pc.totalAfter)!;
  const feeCents = a.gate.authority === "unlock" ? a.gate.feeCents : 0;
  const fee = feeCents > 0 ? { cents: feeCents, taxable: a.gate.feeTaxable, label: a.feeLabel } : null;
  const feeSay = feeLine(a.feeLabel, feeCents, a.gate.feeTaxable);
  const notes = [
    ...(warn.sentence ? [warn.sentence] : []),
    "Approve stages it and emails it to the customer to sign. It is on their estimate page to sign at once, even if the email doesn't go.",
    "Until they sign it or a person voids it, this order can't be invoiced.",
    "Undo works only if the email doesn't go. Once it's emailed, a person voids it under Change orders and speaks to the customer.",
  ];
  const parts = [...new Set(built.lines.map((l) => (l.label.startsWith("Roof") ? "roof" : l.label === "Cladding" ? "cladding" : "paint")))];
  await putCard(deps, s, {
    kind: "changeorder_attrs",
    // Teammates see titles on the activity page, so a title never names the customer.
    title: `Change order for order ${orderName(t.order)}: ${listOf(parts)}`,
    preview: {
      order: { no: t.order.orderNo, building: t.order.building, totalCents: t.order.totalCents },
      lines: built.lines,
      totals: { beforeCents, afterCents },
      description: pc.description,
      fee, ...(feeSay ? { feeSay } : {}),
      notes,
      rules: warn.named, rulesSay: warn.sentence,
      link: { page: "orders", sub: `o-${t.order.id}` },
      where: CO_WHERE,
    },
    payload: {
      shortCode: t.code, orderId: t.order.id, attrs: built.attrs,
      expect: {
        from: d.cur, after: afterOf(d.cur, built.attrs), description: pc.description, totalBefore: pc.totalBefore, totalAfter: pc.totalAfter,
        orderTotalCents: t.order.totalCents, authority: a.gate.authority, feeCents: a.gate.feeCents, feeTaxable: a.gate.feeTaxable,
        rulesSay: warn.sentence,
      },
    },
  });
  const change = afterCents - beforeCents;
  return ok({
    shown: true, order: orderName(t.order),
    changes: built.lines.map((l) => scrub(`${l.label}: ${l.from} to ${l.to}`, 120)),
    total: `${money(beforeCents)} to ${money(afterCents)} (${change >= 0 ? "+" : "-"}${money(Math.abs(change))})`,
    ...(feeSay ? { fee: feeSay } : {}),
    ...(warn.sentence ? { rules: warn.sentence } : {}),
    note: `${SAID.onScreenApprove} Say that Approve also emails the customer a change order to sign, and that it's on their estimate page to sign at once.${warn.sentence ? " Say what the card says about their rules." : ""}`,
  });
}

async function proposeUnlock(deps: Deps, s: TurnState, i: Any): Promise<ToolOut> {
  // Trimmed after the cut, as the route stores it (trim, then 500), so a lost answer's read-back matches.
  const reason = str(i.reason).replace(/\s+/g, " ").slice(0, 500).trim();
  if (!reason) return err(CO_SAID.noReason);
  const t = await targetOf(deps, s, i);
  if ("error" in t) return err(t.error);
  const [dr, ar] = await Promise.all([readDesign(deps, t.code), readAmend(deps, t.code)]);
  if ("error" in dr) return err(dr.error);
  if ("error" in ar) return err(ar.error);
  const d = dr.design, a = ar.amend;
  const st = standing(t.order, d, a, deps.now());
  if (!st.block) return err(CO_SAID.notLocked);
  if (!st.canAsk) return err(st.block);
  const feeSay = feeLine(a.feeLabel, a.gate.feeCents, a.gate.feeTaxable, true);
  await putCard(deps, s, {
    kind: "changeorder_unlock",
    title: `Ask to unlock order ${orderName(t.order)}`,
    preview: {
      order: { no: t.order.orderNo, building: t.order.building, totalCents: t.order.totalCents },
      reason,
      notes: [
        "Whoever approves changes sees this on the order and decides it. Jack never unlocks an order itself.",
        ...(feeSay ? [feeSay] : []),
        "A request can't be taken back from here. Whoever approves changes can decline it.",
      ],
      link: { page: "orders", sub: `o-${t.order.id}` },
      where: CO_WHERE,
    },
    payload: { shortCode: t.code, reason },
  });
  return ok({
    shown: true, order: orderName(t.order), ...(feeSay ? { fee: feeSay } : {}),
    note: `${SAID.onScreenApprove} Say that whoever approves changes decides it, and that you never unlock an order yourself.`,
  });
}

// ── Approve ───────────────────────────────────────────────────────────────────────────────────────

// No saved or created counts: the activity page reads those as sizes.
const failed = (failure: string): ApplyOutcome => ({ patch: { status: "failed", failure, result: { changeOrders: 0, reports: [] } } });
const partly = (p: ProposalRow, reason: string, extra: Record<string, unknown> = {}, undo: unknown = null): ApplyOutcome => ({
  patch: { status: "partly_applied", result: { changeOrders: 0, reports: [{ label: p.title, status: "error", reason }], ...extra }, undo },
});

interface UndoPlan { shortCode: string; changeOrderId: string; coNo: unknown; description: string; totalAfterCents: number | null; after: Attrs; stagedFrom: number }

/** Approve for a change: read everything again, price it again, stage it ONCE with exactly the card's
 *  body, check what landed, then email it ONCE. */
async function applyChange(deps: Deps, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  const pl = (p.payload ?? {}) as Any;
  const code = String(pl.shortCode ?? "");
  const attrs = (pl.attrs ?? {}) as Partial<Attrs>;
  const ex = (pl.expect ?? {}) as Any;
  if (!deps.canRead("orders")) return failed(`${CO_SAID.noOrders} Nothing changed.`);

  // 1. Everything the card showed, read again.
  const [ar, dr, or] = await Promise.all([readAmend(deps, code), readDesign(deps, code), readOrder(deps, code)]);
  if ("error" in ar) return failed(`${ar.error} Nothing changed.`);
  if ("error" in dr) return failed(`${dr.error} Nothing changed.`);
  if ("error" in or) return failed(`${or.error} Nothing changed.`);
  const a = ar.amend, d = dr.design, order = or.order;
  const st = standing(order, d, a, deps.now());
  if (st.block) return failed(st.block === CO_SAID.locked ? CO_SAID.lockedNow : `${st.block} Nothing was saved.`);
  if (a.gate.authority !== ex.authority || a.gate.feeCents !== ex.feeCents || a.gate.feeTaxable !== ex.feeTaxable) return failed(CO_SAID.moved("What this change would cost, or what lets it happen,"));
  if (!sameAttrs(d.cur, ex.from)) return failed(CO_SAID.moved("The building's roof, cladding or paint"));
  if (order.totalCents !== ex.orderTotalCents) return failed(CO_SAID.moved("The order's total"));

  // 2. Priced again: the words and totals the customer signs must be the ones on the card.
  const again = await priceIt(deps, code, attrs);
  if ("error" in again) return failed(again.lost ? CO_SAID.repriceFailed : `${again.error} Nothing was saved.`);
  if (again.priced.description !== ex.description || again.priced.totalBefore !== ex.totalBefore || again.priced.totalAfter !== ex.totalAfter) {
    return failed(CO_SAID.moved("The price or the wording of this change"));
  }
  // The rules the card warned about. Refused only when the list, read now, says something the card
  // didn't. A list that can't be read now, or that this person can't open (the general sentence),
  // leaves what the card said standing, as a person's own button doesn't wait on that read either. And
  // a card that couldn't name them (it couldn't read the list, or its asker can't open Automations)
  // missed nothing when the list now reads with no rule on this.
  const warn = await ruleWarning(deps, CO_EVENTS);
  const ruleNow = warn.sentence ?? null, ruleShown = ex.rulesSay ?? null;
  const vague = (x: string | null) => x === RULE_WARN_SAID.unread || x === RULE_WARN_SAID.general;
  if (!vague(ruleNow) && ruleNow !== ruleShown && !(ruleNow === null && vague(ruleShown))) {
    return failed(CO_SAID.moved("Which of your rules this sets off"));
  }

  // 3. Staged, once.
  const stagedFrom = deps.now() - SLACK_MS;
  const r = await deps.portal("stage_order_attribute_change", { shortCode: code, attrs }).catch(() => ({ status: 0, data: null }));
  let coId: string | null = null;
  let coNo: unknown = null;
  let landed: { description: string; totalAfterCents: number | null } | null = null;
  if (r.status === 200 && r.data && r.data.ok === true) {
    if (!isUuid(r.data.changeOrderId)) return partly(p, CO_SAID.noCo);
    coId = String(r.data.changeOrderId);
    coNo = r.data.coNo ?? null;
    if (r.data.draft === true) return partly(p, CO_SAID.folded(coNo), { coNo });
    landed = { description: String(r.data.description ?? ""), totalAfterCents: cents(r.data.totalAfter) };
  } else if (r.status === 409 && r.data?.reason === "co_pending" && /same moment/i.test(String(r.data?.error ?? ""))) {
    return partly(p, CO_SAID.race);
  } else if (!lost(r)) {
    return failed(`${routeSaid(r, "That didn't save.")} Nothing was saved.`);
  } else {
    // The answer was lost. It is never sent again: what landed says what to do.
    const back = await readAmend(deps, code);
    const live = "amend" in back ? back.amend.amendment : null;
    if (live && live.status === "pending_ack" && live.description === ex.description && madeSince(live.createdAt, stagedFrom)) {
      coId = live.id;
      coNo = live.coNo;
      landed = { description: live.description, totalAfterCents: live.totalAfterCents };
    } else {
      const now = await readDesign(deps, code);
      if ("design" in now && sameAttrs(now.design.cur, ex.after) && !live) return partly(p, CO_SAID.designNoCo);
      return partly(p, CO_SAID.unsure);
    }
  }
  const plan: UndoPlan = { shortCode: code, changeOrderId: coId!, coNo, description: landed!.description, totalAfterCents: landed!.totalAfterCents, after: ex.after, stagedFrom };
  const staged = { changeOrders: 1, coNo, emailed: false };
  // Saved as soon as it's staged, so a worker that dies before the email still leaves Undo.
  await progress({ result: { ...staged, reports: [] }, undo: plan });

  // 4. What landed is Jack's own change order, waiting on the customer, saying what the card said.
  const check = await readAmend(deps, code);
  if ("error" in check) return partly(p, CO_SAID.notChecked(coNo), staged, plan);
  const live = check.amend.amendment;
  if (!live || live.id !== coId) return partly(p, CO_SAID.notChecked(coNo), staged, plan);
  // Made before this press: the route folded the change into one that was already there.
  if (!madeSince(live.createdAt, stagedFrom)) return partly(p, CO_SAID.folded(coNo), staged);
  if (live.status !== "pending_ack" || live.description !== ex.description || live.totalAfterCents !== cents(ex.totalAfter)) {
    return partly(p, CO_SAID.notAsShown(coNo), staged, plan);
  }

  // 5. Emailed, once. A lost answer may have sent it, so it is never sent again and gets no Undo.
  // The Undo saved above comes off the row first: a worker that dies while the email is going out, or
  // a last write that doesn't land, would otherwise leave an Undo that voids a change order the
  // customer may already have. Each answer below puts it back only when the email surely didn't go.
  await progress({ undo: null });
  const sent = await deps.portal("send_change_order", { changeOrderId: coId }).catch(() => ({ status: 0, data: null }));
  if (sent.status === 200 && sent.data && sent.data.ok === true && sent.data.sent === true) {
    return { patch: { status: "applied", result: { ...staged, emailed: true, reports: [] }, undo: null } };
  }
  if (sent.status === 200 && sent.data && sent.data.ok === true && sent.data.sent === false) {
    return partly(p, CO_SAID.emailFailed(coNo, emailWhy(sent.data.reason)), staged, plan);
  }
  if (lost(sent) || sent.status === 200) return partly(p, CO_SAID.emailUnsure(coNo), staged);
  return partly(p, CO_SAID.emailRefused(coNo, routeSaid(sent, "That didn't go through.")), staged, plan);
}

/** Approve for an unlock request: ONE request_order_unlock, only while the order is still locked and
 *  nobody has asked. */
async function applyUnlock(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const pl = (p.payload ?? {}) as Any;
  const code = String(pl.shortCode ?? "");
  const reason = String(pl.reason ?? "");
  const before = await readAmend(deps, code);
  if ("error" in before) return failed(`${before.error} Nothing was sent.`);
  const g = before.amend.gate;
  // A live change order opens the gate too (authority "amendment"), but a change can't be asked for
  // while it stands, so it is said first.
  if (before.amend.amendment) return failed(CO_SAID.live(before.amend.amendment.coNo, before.amend.amendment.status === "draft"));
  if (g.open && g.signed) return failed("This order is open for changes now, so no request was needed. Ask me for the change itself.");
  if (!g.signed) return failed(CO_SAID.gateUnread);
  const u = before.amend.unlock;
  if (u && u.decision === null) return failed(`${CO_SAID.askedAlready} I didn't ask again.`);
  const askedFrom = deps.now() - SLACK_MS;
  const r = await deps.portal("request_order_unlock", { shortCode: code, reason }).catch(() => ({ status: 0, data: null }));
  const done: ApplyOutcome = { patch: { status: "applied", result: { requests: 1, reports: [] }, undo: null } };
  if (r.status === 200 && r.data && r.data.ok === true) {
    if (r.data.requested === true) return done;
    if (r.data.already === true) return failed(`${plainWords(String(r.data.message ?? CO_SAID.askedAlready))} I didn't ask again.`);
    if (r.data.needed === false) return failed("This order is open for changes now, so no request was needed. Ask me for the change itself.");
  }
  if (!lost(r) && r.status !== 200) return failed(`${routeSaid(r, "That didn't go through.")} Nothing was sent.`);
  // Lost: never sent again. The request is there, or it isn't.
  const after = await readAmend(deps, code);
  const nu = "amend" in after ? after.amend.unlock : null;
  if (nu && nu.decision === null && nu.reason === reason && madeSince(nu.requestedAt, askedFrom)) return done;
  return partly(p, CO_SAID.unlockUnsure);
}

// ── Undo ──────────────────────────────────────────────────────────────────────────────────────────

const report = (label: string, status: string, reason: string, failedN = 0): UndoOutcome => ({ restored: 0, removed: 0, failed: failedN, reports: [{ label, status, reason }] });

/** Undo: void Jack's own change order, never emailed, still as Jack staged it. */
async function undoChange(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as UndoPlan;
  const label = p.title;
  const ar = await readAmend(deps, plan.shortCode);
  if ("error" in ar) return report(label, "error", CO_SAID.undoRead, 1);
  const live = ar.amend.amendment;
  if (!live || live.id !== plan.changeOrderId || live.status !== "pending_ack") return report(label, "changed", CO_SAID.notWaiting(plan.coNo));
  if (live.description !== plan.description || live.totalAfterCents !== plan.totalAfterCents || !madeSince(live.createdAt, Number(plan.stagedFrom))) {
    return report(label, "changed", CO_SAID.changedSince(plan.coNo));
  }
  const dr = await readDesign(deps, plan.shortCode);
  if ("error" in dr) return report(label, "error", CO_SAID.undoRead, 1);
  if (!sameAttrs(dr.design.cur, plan.after)) return report(label, "changed", CO_SAID.changedSince(plan.coNo));
  const r = await deps.portal("void_change_order", { changeOrderId: plan.changeOrderId, reason: CO_SAID.voidReason }).catch(() => ({ status: 0, data: null }));
  if (r.status === 200 && r.data && r.data.ok === true) return { restored: 1, removed: 0, failed: 0, reports: [] };
  // void restores the design BEFORE its status check, so a 409 is not "nothing happened" and not "left
  // as it was" either: "moved" tells the card to say check the order now.
  if (r.status === 409) return report(label, "moved", CO_SAID.signedMeanwhile(plan.coNo));
  if (lost(r)) return report(label, "error", CO_SAID.undoLost, 1);
  return report(label, "refused", routeSaid(r, "That didn't go back."));
}

// ── The piece ─────────────────────────────────────────────────────────────────────────────────────

const changeKind: KindSpec = {
  kind: "changeorder_attrs",
  // Raising, sending and voiding a change order are change_orders edit (portal-settings GATES). Opening the
  // card shows the order's figures, so it needs orders too.
  areas: () => ["change_orders"],
  readAreas: () => ["change_orders", "orders"],
  // Records, and sending: Approve emails the customer. A card made while sending was on is refused at
  // Approve once it's off (agent.ts approvePiece), with the switched-off sentence and nothing staged.
  switches: () => [CO_SWITCH, CO_SEND_SWITCH],
  where: CO_WHERE,
  // Approve emails the customer the change order to sign, so it is a send card: it runs only from a page
  // that shows the words the customer signs (its Approve says send: true), and a press that stalled says
  // it may have gone, never "saved". The team in view-as may still approve it: it's an email, not a text.
  sends: true,
  gaveUp: CO_SAID.gaveUp,
  onScreen: CO_SAID.onScreen,
  nothingToDo: (p) => (typeof p.payload?.shortCode === "string" && p.payload.shortCode && p.payload?.attrs && Object.keys(p.payload.attrs).length ? null : "Nothing would change, so there's nothing to approve."),
  apply: (deps, _who, p, progress) => applyChange(deps, p, progress),
  undo: (deps, _who, p) => undoChange(deps, p),
};

const unlockKind: KindSpec = {
  kind: "changeorder_unlock",
  areas: () => ["change_orders"],
  readAreas: () => ["change_orders", "orders"],
  switches: () => [CO_SWITCH],
  where: CO_WHERE,
  nothingToDo: (p) => (typeof p.payload?.shortCode === "string" && p.payload.shortCode && str(p.payload?.reason) ? null : "There's nothing to ask for on that one."),
  apply: (deps, _who, p) => applyUnlock(deps, p),
};

export const changeOrdersPiece: Piece = {
  name: "changeorders",
  tools: [lookTool, proposeTool],
  kinds: [changeKind, unlockKind],
  can: [
    "Change the roof, cladding or paint on a signed order with a change order the customer signs: read the order with look_at_order_for_change, then put the change on the screen with propose_change_order (action change). Approve stages it, prices it from their catalog and emails it to the customer.",
    "On a locked order, ask for it to be unlocked with propose_change_order (action ask_unlock). You never unlock an order yourself.",
  ],
  rules: [
    "Change orders: only the roof type and color, the cladding, and the paint. A change written in words with a new total, a second change while one is open or waiting on the customer, invoices and money are for a person on the order screen.",
    "Colors and cladding go into a change order by the names look_at_order_for_change gives. If they don't say which color, ask. Never pick one for them.",
    "A change order emails the customer, so it needs sending switched on for Jack as well as record changes. Asking for an unlock sends nothing and needs record changes only.",
  ],
};

/** For the tests and the integration notes: every card kind this piece writes. */
export const CHANGEORDER_KINDS = changeOrdersPiece.kinds.map((k) => k.kind);
