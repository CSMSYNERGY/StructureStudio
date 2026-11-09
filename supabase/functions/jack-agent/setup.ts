// jack-agent: helping a builder through setup (setup_test.ts). Plan section 5.7.
//
// Jack reads the builder's "Getting set up" checklist (portal-setup `list`, the list Support shows) and
// works through the open steps with them. Some steps it fills in and a person approves; the rest it points
// to, with a Take me there button.
//
// THE RULES
//   - A tool reads, or writes ONE card. Only Approve saves, through the route the page itself uses
//     (portal-settings, portal-setup) with the person's own token, and it saves exactly the card's payload.
//   - Before saving, the card's old values are read again. If any moved since the card was made, nothing
//     is saved and the card says to ask again. Those routes have no version check of their own.
//   - Undo puts a field back only while it still holds what Jack saved. Anything else is left and named.
//   - Starting quote and invoice numbers and the serial start are one-way. The card says so, and Undo
//     leaves them.
//   - Jack deletes only what it made, and only on Undo: a style with no sizes, a door, window or ramp
//     nobody has touched since, a lot with no buildings on it.
//   - An Approve that finishes a step also ticks it (Ahsan, 11-06), through portal-setup with the card's
//     id, so the checklist says "with Jack" and Undo takes back only that tick. The card says so first.
//   - Guide only in version 1: colors (the customer link's accent color too, Ahsan 11-06), add-on prices,
//     the logo, sales tax, team access, billing and automatic top-up, and Customer Hub's email, text and
//     phone settings (Carolyn's; Jack only points).
//   - Phone numbers, emails and street lines never go back to Claude. It hears "set" or "not set", and the
//     town at most. The card a person sees shows the values.
//   - The schemas carry no nullable fields: every strict tool in a request shares one budget of union-typed
//     parameters, so values come as a list of {field, value} instead.

import type { ApplyOutcome, Deps, KindSpec, Piece, ProposalRow, ToolSpec, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { scrub } from "./redact.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Report = { label: string; status: string; reason: string };
type Progress = (patch: Record<string, unknown>) => Promise<void>;

export const SETUP_SWITCH = "setup";

const landed = (r: Res) => r.status === 200 && !!r.data && r.data.ok !== false;
/** A lost answer may mean it landed, so it's never reported as "didn't save". */
const unsure = (r: Res) => r.status === 0 || r.status >= 500;
const UNSURE = (where: string) => `I couldn't tell if that saved. Check ${where} before trying again.`;
const TRY_AGAIN = "That didn't go through. Please try again.";
const readError = (r: Res) => (r.status >= 400 && r.status < 500 ? saidBy(r, SAID.readFailed) : SAID.readFailed);
const t = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};
// Keys sorted first: a card's payload comes back from jsonb, which doesn't keep the order it was written in.
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v ?? null;
};
const sameV = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** Big numbers as "12,000", so a counter never reads as a phone number on its way to Claude. */
const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : null);
const EMPTY = { type: "object", additionalProperties: false, required: [], properties: {} };

// ── Where things are ──────────────────────────────────────────────────────────────────────────────
// Jack's own map, by step key. The template's link_page values are stale (business details moved to
// Company, settings/options opens Wall heights, locations left Team, structures is an alias due to go),
// so a step's route is decided here, never read from the row.

export interface Guide { title: string; where: string; page: string | null; sub: string | null; area: string | null; say: string }

const guide = (title: string, where: string, sub: string | null, area: string | null, say: string, page: string | null = "settings"): Guide =>
  ({ title, where, page: sub ? page : null, sub, area, say });

export const GUIDES: Record<string, Guide> = {
  password: guide("Set your password", "the email we sent you", null, null, "Use the sign-in link in the email we sent, then set a password you'll remember."),
  business: guide("Business details", "Settings > Company > Business Details", "company", "settings_branding", "Your business name, phone, address, logo and estimate terms. They print on every estimate."),
  logo: guide("Your logo", "Settings > Company > Business Details", "company", "settings_branding", "Upload your logo there. I can't save a logo from the chat yet."),
  serial: guide("Serial number start", "Settings > Company > Business Details", "company", "settings_branding", "Where your building serial numbers start counting is on the Business Details tab. It can only go up."),
  branding: guide("Your customer link's look", "Settings > Company > Branding", "branding", "settings_branding", "The name, tagline and colors on your customer design link."),
  show_prices: guide("Whether customers see prices", "Settings > Company > Branding", "branding", "settings_branding", "One switch on the Branding tab: show prices while customers design, or keep them private until you send the estimate."),
  share_link: guide("Share your customer design link", "Settings > Company > Branding", "branding", "settings_branding", "Your link is at the top of the Branding tab. Put it on your website and social pages, and send it to walk-in customers."),
  test_quote: guide("Send yourself a test estimate", "Settings > Company > Branding", "branding", "settings_branding", "Turn on Testing on the Branding tab (beta mode and your test inbox) so nothing reaches a real customer. Then build one design in the Designer and submit it. Turn Testing off when you're happy."),
  styles: guide("Building styles and sizes", "Settings > Sheds", "sheds", "settings_structures", "Your styles, their sizes and base prices."),
  prices: guide("Your prices", "Settings > Sheds", "sheds", "settings_structures", "Download the pricing sheet there, or send me your price list with the paperclip and I'll fill it in."),
  rtp: guide("Real-Time Pricing", "Settings > Sheds", "sheds", "settings_structures", "With the Real-Time Pricing add-on: enter your material costs and build sheets there."),
  d3: guide("3D", "Settings > Designer", "designer", "settings_structures", "Set how each style looks in 3D: roof shape, siding and wall height."),
  catalog_items: guide("Doors, windows, ramps and add-ons", "Settings > Options", "doors", "settings_options", "Doors, windows, ramps and add-ons each have their own tab under Settings > Options."),
  doors: guide("Doors", "Settings > Options > Doors", "doors", "settings_options", "The doors a customer can place, and what each one adds."),
  windows: guide("Windows", "Settings > Options > Windows", "windows", "settings_options", "The windows a customer can place, and their colors."),
  ramps: guide("Ramps", "Settings > Options > Ramps", "ramps", "settings_options", "One simple ramp, or your own list of ramps."),
  addons: guide("Add-on items", "Settings > Options > Interior items", "interior", "settings_options", "Lofts, workbenches, shelving and their prices. I can't change add-on prices yet, so set them there."),
  colors: guide("Colors", "Settings > Colors", "colors", "settings_options", "Paint, shingle and metal colors, with the names your customers know. I can't save colors yet, so set them there."),
  crm: guide("Connect your CRM", "Settings > GHL Connection", "connection", "settings_crm", "Paste your Location ID and API key there. Skip it if Structure Studio sends your paperwork."),
  paperwork: guide("How estimates and invoices go out", "Settings > GHL Connection", "connection", "settings_crm", "Through your CRM, or issued by Structure Studio, with your starting numbers."),
  sales_tax: guide("Sales tax", "Settings > Company > Sales Tax", "tax", "settings_crm", "Set your sales tax rate there. Enter 0% if you don't collect sales tax. I can't change tax settings."),
  email_domain: guide("Email from your own domain", "Settings > Customer Hub > Email Settings", "email", "settings_email", "Add the records shown there at your DNS host, so estimates come from your own address."),
  texting: guide("Text messaging", "Settings > Customer Hub > Text Messaging", "sms", "settings_billing", "Texting from your own number, once the carriers approve your business."),
  phone: guide("Phone", "Settings > Customer Hub > Phone", "phone", "phone", "Who answers your business number, and the phone apps."),
  team: guide("Team and access", "Settings > Company > Team", "team", "settings_team", "Add each person with their email and job title. The access grid decides what each one can see and change."),
  locations: guide("Sales lots", "Settings > Company > Locations", "locations", "settings_team", "Your sales lots, and each lot's own tax rate."),
  commissions: guide("Commissions", "Settings > Company > Commissions", "commissions", "commissions", "How reps earn. An owner sets this up."),
  crews_drivers: guide("Crews and drivers", "Settings > Company > Crews", "crews", "settings_team", "With the Scheduling add-on: your build crews, then drivers on the next tab."),
  quickbooks: guide("QuickBooks", "Settings > QuickBooks", "quickbooks", "settings_quickbooks", "Connect your QuickBooks company, then map each line type to a product."),
  auto_topup: guide("Automatic top-up", "Settings > Billing > Wallet", "wallet", "settings_billing", "Turn on automatic top-up so your wallet refills before it runs out. I can't turn it on for you."),
};

/** How Jack helps with each step it can fill. Every other keyed step is point_to_step. */
const FILLS: Record<string, string> = {
  business: "propose_company_details (the logo is guide only)",
  show_prices: "propose_company_details",
  paperwork: "propose_paperwork (needs a sales tax rate on file first)",
  styles: "propose_styles for styles; look_at_my_catalog and propose_size_changes for sizes",
  prices: "a price list through the paperclip, or propose_size_changes",
  catalog_items: "propose_new_door for doors, propose_catalog_item for windows and ramps; add-on prices are guide only",
  locations: "propose_locations",
  // The live template's own serial step (11-06): propose_locations sets it, with the lots list empty.
  serial: "propose_locations (serialStart, with the lots list empty when they only gave the number)",
};

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────

export interface Step { id: string; ref: string; key: string | null; title: string; section: string | null; done: boolean; withJack: boolean; locked: boolean; needs: string | null }
interface Steps { steps: Step[]; canTick: boolean; counts: { total: number; done: number; open: number } }
interface Tick { id: string; title: string }

/** The checklist as portal-setup gives it to this person: hidden steps never arrive, locked ones say so. */
export async function readSteps(deps: Deps): Promise<Steps | { error: string }> {
  const r = await deps.call("portal-setup", "list", {});
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.items)) return { error: readError(r) };
  const seen = new Set<string>();
  const steps = (r.data.items as Any[]).map((it, i): Step => {
    const key = typeof it.key === "string" && it.key && !seen.has(it.key) ? it.key : null;
    if (key) seen.add(key);
    return {
      id: String(it.id ?? ""), ref: key ?? `s${i + 1}`, key, title: scrub(it.title, 120), section: it.section ? scrub(it.section, 60) : null,
      done: !!it.completed_at, withJack: it.completed_via === "jack", locked: it.locked === true,
      needs: it.locked === true && it.requiresFeature ? scrub(it.requiresFeature, 40) : null,
    };
  });
  const c = (r.data.counts ?? {}) as Any;
  return { steps, canTick: r.data.canEdit === true, counts: { total: Number(c.total) || 0, done: Number(c.done) || 0, open: Number(c.open) || 0 } };
}

/** Whether this builder's checklist has a step of its own for this key. The live template splits the
 *  seed's steps (the logo apart from business details, the serial start apart from the lots), and a card
 *  ticks what its own step needs, never a step's neighbour. */
const hasStep = (read: Steps | { error: string } | null, key: string) => !!read && !("error" in read) && read.steps.some((x) => x.key === key);

/** The step a card would tick, when this person may tick it and it's still open. */
function tickFor(read: Steps | { error: string } | null, key: string): Tick | null {
  if (!read || "error" in read || !read.canTick) return null;
  const st = read.steps.find((x) => x.key === key);
  return st && !st.done && !st.locked && st.id ? { id: st.id, title: st.title } : null;
}

async function readStatus(deps: Deps): Promise<{ d: Any } | { error: string }> {
  const r = await deps.portal("status", {});
  if (r.status !== 200 || !r.data || r.data.ok !== true) return { error: readError(r) };
  return { d: r.data };
}

async function readCatalog(deps: Deps): Promise<{ c: Any } | { error: string }> {
  const r = await deps.portal("catalog", {});
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.styles) || !Array.isArray(r.data.sizes)) return { error: readError(r) };
  return { c: r.data };
}

async function readLots(deps: Deps): Promise<{ lots: Any[]; nextSerial: number | null } | { error: string }> {
  const r = await deps.portal("list_locations", {});
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.locations)) return { error: readError(r) };
  const n = Number(r.data.nextSerial);
  return { lots: r.data.locations as Any[], nextSerial: r.data.nextSerial === null || r.data.nextSerial === undefined || !Number.isFinite(n) || n <= 0 ? null : n };
}

// ── Ticks ─────────────────────────────────────────────────────────────────────────────────────────

/** Ticks a card's steps after its saves all landed. A tick that doesn't take leaves the save standing. */
async function runTicks(deps: Deps, p: ProposalRow, ticks: Tick[]): Promise<{ ticked: Tick[]; notes: string[] }> {
  const ticked: Tick[] = [], notes: string[] = [];
  for (const tk of ticks) {
    const r = await deps.call("portal-setup", "toggle", { id: tk.id, done: true, viaProposal: p.id });
    if (landed(r) && r.data?.already === true) notes.push(`"${tk.title}" was already ticked.`);
    else if (landed(r)) ticked.push(tk);
    else if (unsure(r)) {
      // It may have landed. Undo can still take it back: portal-setup clears only this card's tick.
      ticked.push(tk);
      notes.push(`I couldn't tell if "${tk.title}" got ticked. Check Support > Getting set up.`);
    } else notes.push(`It's saved, but I couldn't tick "${tk.title}": ${saidBy(r, "the checklist refused it.")}`);
  }
  return { ticked, notes };
}

/** Undo's half: takes back only the ticks this card made. A person's own tick stays. */
async function untick(deps: Deps, p: ProposalRow, ticks: Tick[]): Promise<UndoOutcome> {
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  for (const tk of ticks) {
    const r = await deps.call("portal-setup", "toggle", { id: tk.id, done: false, viaProposal: p.id });
    if (landed(r) || r.status === 404) out.restored++;
    else if (r.status === 409) out.reports.push({ label: tk.title, status: "changed", reason: "Someone ticked this step themselves since, so it stays ticked." });
    else if (unsure(r)) { out.failed++; out.reports.push({ label: tk.title, status: "error", reason: TRY_AGAIN }); }
    else out.reports.push({ label: tk.title, status: "refused", reason: saidBy(r, "The checklist didn't take that back.") });
  }
  return out;
}

const addUp = (a: UndoOutcome, b: UndoOutcome): UndoOutcome =>
  ({ restored: a.restored + b.restored, removed: a.removed + b.removed, failed: a.failed + b.failed, reports: [...a.reports, ...b.reports] });

// ── Fields: business details, branding, paperwork ─────────────────────────────────────────────────

interface FieldLine { key: string; call: "save" | "save_branding"; label: string; from: unknown; to: unknown; oneWay: boolean }

const LABEL: Record<string, string> = {
  businessName: "Business name", businessPhone: "Business phone", businessWebsite: "Website", businessAddress: "Business address",
  quoteTerms: "Estimate terms", quoteValidDays: "Estimates are good for (days)", showPricing: "Customers see prices",
  companyName: "Name on your customer link", tagline: "Tagline",
  ssQuoteNext: "Starting estimate number", ssQuotePrefix: "Estimate prefix", ssInvoiceNext: "Next invoice number", ssInvoicePrefix: "Invoice prefix",
  invoiceInGhl: "Estimates and invoices go out",
};

function addrNorm(a: Any): Record<string, string | null> | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const n = { addressLine1: t(a.addressLine1), city: t(a.city), state: t(a.state), postalCode: t(a.postalCode), countryCode: t(a.countryCode) ?? "US" };
  return n.addressLine1 || n.city || n.state || n.postalCode ? n : null;
}
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

/** Each field as `status` has it now, in the shape a card compares. */
const NOW: Record<string, (d: Any) => unknown> = {
  businessName: (d) => t(d.businessName),
  businessPhone: (d) => t(d.businessPhone),
  businessWebsite: (d) => t(d.businessWebsite),
  businessAddress: (d) => addrNorm(d.businessAddress),
  quoteTerms: (d) => t(d.quoteTerms),
  quoteValidDays: (d) => numOrNull(d.quoteValidDays),
  showPricing: (d) => d.showPricing === true,
  companyName: (d) => t(d.branding?.companyName),
  tagline: (d) => t(d.branding?.tagline),
  // No card proposes it any more (colors are guide only), but a card made before that still holds
  // it: its Approve and Undo guard against what's there now.
  accentColor: (d) => t(d.branding?.accentColor),
  ssQuoteNext: (d) => numOrNull(d.ssQuoteNext),
  ssQuotePrefix: (d) => t(d.ssQuotePrefix),
  ssInvoiceNext: (d) => numOrNull(d.ssInvoiceNext),
  ssInvoicePrefix: (d) => t(d.ssInvoicePrefix),
  invoiceInGhl: (d) => (typeof d.invoiceInGhl === "boolean" ? d.invoiceInGhl : null),
};

/** How the card shows a value. */
function shown(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (key === "businessAddress") {
    const a = v as Record<string, string | null>;
    return [a.addressLine1, a.city, [a.state, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }
  if (key === "showPricing") return v ? "Yes, while they design" : "No, not until the estimate";
  if (key === "invoiceInGhl") return v ? "Through your CRM" : "Issued by Structure Studio";
  if (typeof v === "number") return v.toLocaleString("en-US");
  return String(v);
}

/** What the route is sent to put a value back: an empty text box clears to blank, as on the page. */
const sendBack = (key: string, v: unknown) => (key === "businessAddress" || typeof v === "boolean" || typeof v === "number" ? v ?? null : v ?? "");

const yesNo = (v: string): boolean | null => (/^(yes|y|true|on|show|shown)$/i.test(v) ? true : /^(no|n|false|off|hide|hidden)$/i.test(v) ? false : null);

type Change = { field: string; value: string };
function changesOf(input: unknown): Change[] {
  // deno-lint-ignore no-explicit-any
  const list = Array.isArray((input as any)?.changes) ? (input as any).changes : [];
  const last = new Map<string, string>();
  for (const c of list.slice(0, 40)) if (c && typeof c.field === "string") last.set(c.field, String(c.value ?? "").trim());
  return [...last.entries()].map(([field, value]) => ({ field, value }));
}

class Lines {
  lines: FieldLine[] = [];
  problems: string[] = [];
  same: string[] = [];
  // A plain field, not a parameter property: the browser harness runs this file under Node's type
  // stripping, which can't.
  private d: Any;
  constructor(d: Any) { this.d = d; }
  put(key: string, call: FieldLine["call"], to: unknown, oneWay = false) {
    const from = NOW[key](this.d);
    if (sameV(from, to)) this.same.push(LABEL[key]);
    else this.lines.push({ key, call, label: LABEL[key], from, to, oneWay });
  }
  text(want: Map<string, string>, field: string, key: string, call: FieldLine["call"], max: number, check?: (v: string) => string | null) {
    if (!want.has(field)) return;
    const v = want.get(field)!;
    if (!v) return void this.problems.push(`${LABEL[key]}: tell me the new value. I don't clear a box from here.`);
    const why = check?.(v);
    if (why) return void this.problems.push(`${LABEL[key]}: ${why}`);
    this.put(key, call, v.slice(0, max));
  }
}

export const COMPANY_FIELDS = ["businessName", "businessPhone", "businessWebsite", "addressLine1", "city", "state", "postalCode", "quoteTerms", "quoteValidDays", "customerLinkName", "tagline", "showPricing"];
const ADDRESS_CAPS: Record<string, number> = { addressLine1: 200, city: 100, state: 60, postalCode: 12 };
/** Colors are guide only (Ahsan, 11-06). The schema doesn't offer it; if it arrives anyway, it's refused, not dropped. */
const ACCENT_GUIDE_ONLY = `Accent color: I can't change colors from here. You set it in ${GUIDES.branding.where}.`;

function companyLines(changes: Change[], d: Any): Lines {
  const want = new Map(changes.filter((c) => COMPANY_FIELDS.includes(c.field)).map((c) => [c.field, c.value]));
  const L = new Lines(d);
  if (changes.some((c) => c.field === "accentColor")) L.problems.push(ACCENT_GUIDE_ONLY);
  L.text(want, "businessName", "businessName", "save", 200);
  L.text(want, "businessPhone", "businessPhone", "save", 40, (v) => (v.replace(/\D/g, "").length >= 7 ? null : "that doesn't look like a phone number."));
  L.text(want, "businessWebsite", "businessWebsite", "save", 300, (v) => (/\s/.test(v) || !v.includes(".") ? "that doesn't look like a web address." : null));
  const parts = Object.keys(ADDRESS_CAPS).filter((f) => want.has(f));
  if (parts.length) {
    const next: Record<string, string | null> = addrNorm(d.businessAddress) ?? { addressLine1: null, city: null, state: null, postalCode: null, countryCode: "US" };
    let bad = false;
    for (const f of parts) {
      const v = want.get(f)!;
      if (!v) bad = true;
      else next[f] = v.slice(0, ADDRESS_CAPS[f]);
    }
    if (bad) L.problems.push("Business address: tell me each part you want changed. I don't clear a box from here.");
    else L.put("businessAddress", "save", addrNorm(next));
  }
  L.text(want, "quoteTerms", "quoteTerms", "save", 8000);
  if (want.has("quoteValidDays")) {
    const v = want.get("quoteValidDays")!;
    const n = /^\d{1,3}$/.test(v) ? Number(v) : NaN;
    if (NOW.quoteValidDays(d) === null) L.problems.push("I can't read how long your estimates stay good for right now, so I won't change it.");
    else if (!(n >= 1 && n <= 365)) L.problems.push("Estimates stay good for a whole number of days, from 1 to 365.");
    else L.put("quoteValidDays", "save", n);
  }
  L.text(want, "customerLinkName", "companyName", "save_branding", 200);
  L.text(want, "tagline", "tagline", "save_branding", 300);
  if (want.has("showPricing")) {
    const b = yesNo(want.get("showPricing")!);
    if (b === null) L.problems.push("Customers see prices: say yes or no.");
    else L.put("showPricing", "save", b);
  }
  return L;
}

export const PAPERWORK_FIELDS = ["paperworkBy", "quoteStart", "quotePrefix", "invoiceStart", "invoicePrefix"];

function paperworkLines(changes: Change[], d: Any): Lines & { by: boolean | null } {
  const want = new Map(changes.filter((c) => PAPERWORK_FIELDS.includes(c.field)).map((c) => [c.field, c.value]));
  const L = new Lines(d) as Lines & { by: boolean | null };
  L.by = null;
  if (want.has("paperworkBy")) {
    const v = want.get("paperworkBy")!;
    const by = /^(structure ?studio|ss)$/i.test(v) ? false : /^(crm|ghl|gohighlevel|go high level)$/i.test(v) ? true : null;
    if (by === null) L.problems.push("Estimates and invoices go out: say structurestudio or crm.");
    else if (by && d.ghlInvoicingAllowed !== true) L.problems.push("Sending paperwork through your CRM isn't on for this account, so estimates and invoices go out from Structure Studio.");
    else {
      L.by = by;
      // Where CRM paperwork isn't allowed, portal-settings keeps a save of `true` at false and still
      // answers ok, so leaving the CRM there can't be put back: one-way, and the card says so.
      L.put("invoiceInGhl", "save", by, !by && d.invoiceInGhl === true && d.ghlInvoicingAllowed !== true);
    }
  }
  for (const [field, key, what] of [["quoteStart", "ssQuoteNext", "estimate"], ["invoiceStart", "ssInvoiceNext", "invoice"]] as const) {
    if (!want.has(field)) continue;
    const raw = want.get(field)!.replace(/[,\s]/g, "");
    const n = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 1 && n <= 2_000_000_000)) L.problems.push(`The starting ${what} number must be a whole number, 1 or higher.`);
    else L.put(key, "save", n, true);
  }
  for (const [field, key] of [["quotePrefix", "ssQuotePrefix"], ["invoicePrefix", "ssInvoicePrefix"]] as const) {
    if (!want.has(field)) continue;
    const v = want.get(field)!;
    if (!/^[A-Za-z0-9-]{1,12}$/.test(v)) L.problems.push(`${LABEL[key]}: letters, numbers and dashes only, up to 12, like INV-.`);
    else L.put(key, "save", v, true);
  }
  return L;
}

/** The route bodies: exactly the keys that change, in the route's own names. */
function callsOf(lines: FieldLine[]) {
  const body = (call: FieldLine["call"]) => {
    const ls = lines.filter((l) => l.call === call);
    return ls.length ? Object.fromEntries(ls.map((l) => [l.key, l.to])) : null;
  };
  return { save: body("save"), save_branding: body("save_branding") };
}

const listOf = (labels: string[]) => (labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);

/** Saves a fields card: guard, save, then branding, then the ticks. */
async function applyFields(deps: Deps, p: ProposalRow, progress: Progress, where: string): Promise<ApplyOutcome> {
  const lines: FieldLine[] = p.payload?.fields ?? [];
  const calls = (p.payload?.calls ?? {}) as Record<string, Record<string, unknown> | null>;
  const read = await readStatus(deps);
  if ("error" in read) return { patch: { status: "failed", failure: "I couldn't check your settings just now, so nothing was saved. Ask me again in a moment." } };
  const moved = lines.filter((l) => !NOW[l.key] || !sameV(NOW[l.key](read.d), l.from));
  if (moved.length) {
    return { patch: { status: "failed", failure: `${listOf(moved.map((l) => l.label))} changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now.` } };
  }
  // A move to the CRM after it stopped being allowed would "save" and change nothing (see paperworkLines).
  if (lines.some((l) => l.key === "invoiceInGhl" && l.to === true) && read.d.ghlInvoicingAllowed !== true) {
    return { patch: { status: "failed", failure: "Sending paperwork through your CRM isn't on for this account any more, so nothing was saved." } };
  }
  const reports: Report[] = [];
  let saved = 0;
  const kept: FieldLine[] = [];
  const plan = () => (kept.some((l) => !l.oneWay) ? { fields: kept.filter((l) => !l.oneWay), ticks: [] as Tick[] } : null);
  for (const call of ["save", "save_branding"] as const) {
    const body = calls[call];
    if (!body) continue;
    const ls = lines.filter((l) => l.call === call);
    const r = await deps.portal(call, body);
    const label = listOf(ls.map((l) => l.label));
    if (landed(r)) { saved += ls.length; kept.push(...ls); }
    else if (unsure(r)) { kept.push(...ls); reports.push({ label, status: "error", reason: UNSURE(where) }); }
    else reports.push({ label, status: "refused", reason: saidBy(r, "That didn't save.") });
    await progress({ result: { saved, created: 0, reports }, undo: plan() });
  }
  const ticks: Tick[] = p.payload?.ticks ?? [];
  const t2 = !reports.length && ticks.length ? await runTicks(deps, p, ticks) : { ticked: [], notes: ticks.length ? ["I didn't tick the step, since not everything saved."] : [] };
  const undoFields = kept.filter((l) => !l.oneWay);
  return {
    patch: {
      status: reports.length ? "partly_applied" : "applied",
      result: { saved, created: 0, reports, ticked: t2.ticked.map((x) => x.title), tickNotes: t2.notes },
      undo: undoFields.length || t2.ticked.length ? { fields: undoFields, ticks: t2.ticked } : null,
    },
  };
}

/** Puts back each field that still holds what the card saved. */
async function undoFields(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { fields?: FieldLine[]; ticks?: Tick[] };
  const read = await readStatus(deps);
  if ("error" in read) return { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: TRY_AGAIN }] };
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  for (const call of ["save", "save_branding"] as const) {
    const back: Record<string, unknown> = {};
    const going: FieldLine[] = [];
    for (const l of (plan.fields ?? []).filter((x) => x.call === call)) {
      const now = NOW[l.key]?.(read.d);
      // Back to the CRM where that's no longer allowed would land as ok and change nothing.
      if (sameV(now, l.to) && l.key === "invoiceInGhl" && l.from === true && read.d.ghlInvoicingAllowed !== true) {
        out.reports.push({ label: l.label, status: "kept", reason: "Sending paperwork through your CRM isn't on for this account now, so it stays with Structure Studio." });
      } else if (sameV(now, l.to)) { back[l.key] = sendBack(l.key, l.from); going.push(l); }
      else if (!sameV(now, l.from)) out.reports.push({ label: l.label, status: "changed", reason: "This was changed since, so I left it." });
    }
    if (!going.length) continue;
    const r = await deps.portal(call, back);
    if (landed(r)) out.restored += going.length;
    else if (unsure(r)) { out.failed++; out.reports.push({ label: listOf(going.map((l) => l.label)), status: "error", reason: TRY_AGAIN }); }
    else out.reports.push({ label: listOf(going.map((l) => l.label)), status: "refused", reason: saidBy(r, "That didn't go back.") });
  }
  return addUp(out, await untick(deps, p, plan.ticks ?? []));
}

const fieldsNothing = (p: ProposalRow) => ((p.payload?.fields ?? []).length ? null : "Nothing would change, so there's nothing to approve.");

const changesSchema = (fields: string[], valueHelp: string) => ({
  type: "object", additionalProperties: false, required: ["changes"],
  properties: {
    changes: {
      type: "array",
      description: "Only what the person asked to change, each once.",
      items: {
        type: "object", additionalProperties: false, required: ["field", "value"],
        properties: { field: { type: "string", enum: fields }, value: { type: "string", description: valueHelp } },
      },
    },
  },
});

const companyTool: ToolSpec = {
  def: {
    name: "propose_company_details",
    description: "Put a preview on the person's screen that fills in their business details (name, phone, website, address, estimate terms, how many days an estimate stays good for), their customer link's name and tagline, or whether customers see prices while they design. It changes nothing: the person presses Approve. Only use values they gave you. If the change finishes a setup step, the card ticks that step too and says so.",
    strict: true,
    input_schema: changesSchema(COMPANY_FIELDS, "The new value exactly as they gave it. showPricing: yes or no. quoteValidDays: a whole number of days. Address parts each go in their own field."),
  },
  needs: [{ area: "settings_branding", level: "edit" }],
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const changes = changesOf(input);
    if (!changes.length) return err("Tell me what to change.");
    const read = await readStatus(deps);
    if ("error" in read) return err(read.error);
    const L = companyLines(changes, read.d);
    if (L.problems.length) return err(L.problems.join(" "));
    if (!L.lines.length) return ok({ shown: false, alreadyMatching: L.same, note: "Nothing would change: those already match. Say so, and don't make a card." });
    // portal-settings' `save` needs both areas (its GATES.save), and the card's areas say the same.
    if (L.lines.some((l) => l.call === "save") && !deps.canEdit("settings_crm")) return err(SAID.noAccess);
    const steps = await readSteps(deps).catch(() => null);
    const ticks: Tick[] = [];
    const notes: string[] = [];
    const after = (key: string) => L.lines.find((l) => l.key === key)?.to ?? NOW[key](read.d);
    if (L.lines.some((l) => l.call === "save" && l.key !== "showPricing")) {
      const done = !!after("businessName") && !!after("businessPhone") && !!after("businessAddress");
      // Where the logo has its own step, business details don't wait for it.
      const logo = hasStep(steps, "logo") || !!t(read.d.businessLogoUrl) || !!t(read.d.branding?.logoUrl);
      const tk = tickFor(steps, "business");
      if (tk && done && logo) ticks.push(tk);
      else if (tk && done && !logo) notes.push("Your logo still needs adding on Settings > Company > Business Details, so I won't tick that step yet.");
    }
    if (L.lines.some((l) => l.key === "showPricing")) {
      const tk = tickFor(steps, "show_prices");
      if (tk) ticks.push(tk);
    }
    const lines = L.lines;
    const onlyBranding = lines.every((l) => l.call === "save_branding");
    const g = onlyBranding ? GUIDES.branding : GUIDES.business;
    await putCard(deps, s, {
      kind: "setup_company",
      title: onlyBranding ? "Your customer link's look" : lines.every((l) => l.key === "showPricing") ? "Whether customers see prices" : "Your business details",
      preview: { lines: lines.map((l) => ({ label: l.label, from: shown(l.key, l.from), to: shown(l.key, l.to) })), notes, ticks: ticks.map((x) => x.title), where: g.where, route: { page: g.page, sub: g.sub } },
      payload: { fields: lines, calls: callsOf(lines), ticks },
    });
    return ok({ shown: true, changing: lines.map((l) => l.label), alreadyMatching: L.same, ticksStep: ticks.map((x) => x.title), note: SAID.onScreenApprove });
  },
};

const paperworkTool: ToolSpec = {
  def: {
    name: "propose_paperwork",
    description: "Put a preview on the person's screen for how their estimates and invoices go out (issued by Structure Studio, or through their CRM where that's allowed) and their starting estimate and invoice numbers and prefixes. It changes nothing: the person presses Approve. Starting numbers can't be put back once a document uses one, and the card says so. Structure Studio paperwork needs a sales tax rate on file first: without one this shows where to set it instead.",
    strict: true,
    input_schema: changesSchema(PAPERWORK_FIELDS, "paperworkBy: structurestudio or crm. quoteStart and invoiceStart: a whole number. Prefixes: letters, numbers and dashes, like INV-."),
  },
  needs: [{ area: "settings_crm", level: "edit" }, { area: "settings_branding", level: "edit" }],
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const changes = changesOf(input);
    if (!changes.length) return err("Tell me what to change.");
    const read = await readStatus(deps);
    if ("error" in read) return err(read.error);
    const d = read.d;
    if (typeof d.invoiceInGhl !== "boolean") return err(SAID.noSee);
    const L = paperworkLines(changes, d);
    if (L.problems.length) return err(L.problems.join(" "));
    const inGhl = L.by ?? d.invoiceInGhl;
    // portal-settings refuses Structure Studio paperwork with no tax rate on file, and tax is never Jack's.
    if (!inGhl && (d.ssTaxRate === null || d.ssTaxRate === undefined)) {
      const g = GUIDES.sales_tax;
      await putCard(deps, s, { kind: "setup_guide", title: `Where to set: ${g.title}`, status: "applied", hashed: false, preview: { key: "sales_tax", title: g.title, where: g.where, say: g.say, route: { page: g.page, sub: g.sub } } });
      return ok({ shown: false, refused: true, guideShown: true, note: "No sales tax rate is on file, and Structure Studio needs one before it issues estimates and invoices. A card with a Take me there button to Settings > Company > Sales Tax is on their screen. Nothing changed. Tell them to set the rate there (0% is fine if they don't collect tax), then ask again." });
    }
    if (!L.lines.length) return ok({ shown: false, alreadyMatching: L.same, note: "Nothing would change: those already match. Say so, and don't make a card." });
    const notes: string[] = [];
    if (L.lines.some((l) => l.oneWay && l.key !== "invoiceInGhl")) notes.push("Starting numbers and prefixes can't be put back once an estimate or invoice uses them, so Undo leaves them.");
    if (L.lines.some((l) => l.oneWay && l.key === "invoiceInGhl")) notes.push("Sending paperwork through your CRM isn't on for this account, so once it moves to Structure Studio, Undo can't move it back.");
    for (const [key, what] of [["ssQuoteNext", "estimate"], ["ssInvoiceNext", "invoice"]] as const) {
      const l = L.lines.find((x) => x.key === key);
      if (l && typeof l.from === "number" && typeof l.to === "number" && l.to < l.from) notes.push(`That's lower than where your ${what} numbers are now (${num(l.from)}). If one has gone out above it, the save is refused.`);
    }
    if (!inGhl && d.emailReady === false) notes.push("Until email from your own domain is set up, estimates and invoices go out from our address. Set it up on Settings > Customer Hub > Email Settings.");
    const tk = tickFor(await readSteps(deps).catch(() => null), "paperwork");
    const ticks = tk ? [tk] : [];
    const g = GUIDES.paperwork;
    await putCard(deps, s, {
      kind: "setup_paperwork", title: "How estimates and invoices go out",
      preview: { lines: L.lines.map((l) => ({ label: l.label, from: shown(l.key, l.from), to: shown(l.key, l.to) })), notes, ticks: ticks.map((x) => x.title), where: g.where, route: { page: g.page, sub: g.sub } },
      payload: { fields: L.lines, calls: callsOf(L.lines), ticks },
    });
    return ok({ shown: true, changing: L.lines.map((l) => l.label), alreadyMatching: L.same, ticksStep: ticks.map((x) => x.title), note: SAID.onScreenApprove });
  },
};

// ── Styles ────────────────────────────────────────────────────────────────────────────────────────

interface StyleMade { styleId: string | null; label: string; code: string; unsure?: boolean }
interface StyleEdit { styleId: string; name: string; label: string | null; code: string | null; from: { label: string; code: string | null } }
interface StyleFlip { styleId: string; name: string; from: boolean; to: boolean }

const codeOf = (v: string) => v.trim().toUpperCase();
const CODE_OK = /^[A-Z0-9]{1,4}$/;
const styleCode = (st: Any) => (t(st.code) ? String(st.code).toUpperCase() : null);
const isActive = (st: Any) => st.active !== false;

const stylesTool: ToolSpec = {
  def: {
    name: "propose_styles",
    description: "Put a preview on the person's screen that adds building styles, renames them or changes their serial code, or hides or shows them in the designer. It changes nothing: the person presses Approve. A new style needs a name and a serial code of 1 to 4 letters or numbers (like LBA); ask for the code if they didn't give one. Sizes and prices are propose_size_changes. Leave a list empty when there's nothing for it.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["add", "rename", "visibility"],
      properties: {
        add: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "code"], properties: { name: { type: "string" }, code: { type: "string" } } } },
        rename: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["style", "newName", "newCode"],
            properties: { style: { type: "string", description: "The style's name now." }, newName: { type: "string", description: "Empty to keep the name." }, newCode: { type: "string", description: "Empty to keep the code." } },
          },
        },
        visibility: { type: "array", items: { type: "object", additionalProperties: false, required: ["style", "show"], properties: { style: { type: "string" }, show: { type: "boolean" } } } },
      },
    },
  },
  needs: [{ area: "settings_structures", level: "edit" }],
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const i = (input ?? {}) as Any;
    const add: Any[] = Array.isArray(i.add) ? i.add.slice(0, 20) : [];
    const rename: Any[] = Array.isArray(i.rename) ? i.rename.slice(0, 20) : [];
    const vis: Any[] = Array.isArray(i.visibility) ? i.visibility.slice(0, 40) : [];
    if (!add.length && !rename.length && !vis.length) return err("Tell me which styles to add, rename, hide or show.");
    const read = await readCatalog(deps);
    if ("error" in read) return err(read.error);
    const styles: Any[] = read.c.styles;
    const problems: string[] = [];
    const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
    const find = (name: string): Any | null => {
      const hits = styles.filter((st) => lower(st.label) === lower(name));
      if (hits.length === 1) return hits[0];
      problems.push(hits.length ? `Two styles are called "${scrub(name, 60)}", so change it on Settings > Sheds.` : `I can't find a style called "${scrub(name, 60)}".`);
      return null;
    };
    const codes = new Set(styles.map(styleCode).filter(Boolean) as string[]);
    const names = new Set(styles.map((st) => lower(st.label)));
    const creates: { label: string; code: string }[] = [];
    for (const a of add) {
      const label = String(a?.name ?? "").trim().slice(0, 80), code = codeOf(String(a?.code ?? ""));
      if (!label) { problems.push("A new style needs a name."); continue; }
      if (names.has(lower(label))) { problems.push(`You already have a style called "${scrub(label, 60)}".`); continue; }
      if (!CODE_OK.test(code)) { problems.push(`"${scrub(label, 60)}" needs a serial code of 1 to 4 letters or numbers, like LBA.`); continue; }
      if (codes.has(code)) { problems.push(`Another style already uses the code ${code}. Each style needs its own.`); continue; }
      names.add(lower(label)); codes.add(code);
      creates.push({ label, code });
    }
    const updates: StyleEdit[] = [];
    for (const r of rename) {
      const st = find(String(r?.style ?? ""));
      if (!st) continue;
      const newName = String(r?.newName ?? "").trim().slice(0, 80), newCode = String(r?.newCode ?? "").trim() ? codeOf(String(r.newCode)) : "";
      const label = newName && newName !== st.label ? newName : null;
      const code = newCode && newCode !== styleCode(st) ? newCode : null;
      if (label && names.has(lower(label)) && lower(label) !== lower(st.label)) { problems.push(`You already have a style called "${scrub(label, 60)}".`); continue; }
      if (code && !CODE_OK.test(code)) { problems.push("A serial code is 1 to 4 letters or numbers, like LBA."); continue; }
      if (code && codes.has(code)) { problems.push(`Another style already uses the code ${code}. Each style needs its own.`); continue; }
      if (!label && !code) continue;
      if (label) names.add(lower(label));
      if (code) codes.add(code);
      updates.push({ styleId: String(st.id), name: String(st.label), label, code, from: { label: String(st.label), code: styleCode(st) } });
    }
    const actives: StyleFlip[] = [];
    for (const v of vis) {
      const st = find(String(v?.style ?? ""));
      if (!st || isActive(st) === (v?.show === true)) continue;
      actives.push({ styleId: String(st.id), name: String(st.label), from: isActive(st), to: v?.show === true });
    }
    if (problems.length) return err(problems.join(" "));
    if (!creates.length && !updates.length && !actives.length) return ok({ shown: false, note: "Nothing would change: those styles already read that way. Say so, and don't make a card." });
    const lines = [
      ...creates.map((c) => ({ label: "New style", from: "", to: `${c.label}, code ${c.code}` })),
      ...updates.flatMap((u) => [
        ...(u.label ? [{ label: `${u.name}: name`, from: u.name, to: u.label }] : []),
        ...(u.code ? [{ label: `${u.name}: code`, from: u.from.code ?? "", to: u.code }] : []),
      ]),
      ...actives.map((a) => ({ label: a.name, from: a.from ? "Shown in the designer" : "Hidden", to: a.to ? "Shown in the designer" : "Hidden" })),
    ];
    const notes: string[] = [];
    if (creates.length) notes.push("A new style starts with no sizes. Add its sizes and prices next. Undo removes a style I added only while it still has no sizes.");
    const parts = [creates.length ? `add ${creates.length}` : "", updates.length ? `change ${updates.length}` : "", actives.length ? `${actives.every((a) => !a.to) ? "hide" : actives.every((a) => a.to) ? "show" : "hide or show"} ${actives.length}` : ""].filter(Boolean);
    await putCard(deps, s, {
      kind: "setup_styles", title: `Building styles: ${parts.join(", ")}`,
      preview: { lines, notes, ticks: [], where: GUIDES.styles.where, route: { page: GUIDES.styles.page, sub: GUIDES.styles.sub } },
      payload: { creates, updates, actives },
    });
    return ok({ shown: true, adding: creates.length, changing: updates.length, showingOrHiding: actives.length, note: SAID.onScreenApprove });
  },
};

async function applyStyles(deps: Deps, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  const creates: { label: string; code: string }[] = p.payload?.creates ?? [];
  const updates: StyleEdit[] = p.payload?.updates ?? [];
  const actives: StyleFlip[] = p.payload?.actives ?? [];
  const read = await readCatalog(deps);
  if ("error" in read) return { patch: { status: "failed", failure: "I couldn't check your styles just now, so nothing was saved. Ask me again in a moment." } };
  const byId = new Map((read.c.styles as Any[]).map((st) => [String(st.id), st]));
  const taken = (read.c.styles as Any[]);
  const moved = updates.some((u) => { const st = byId.get(u.styleId); return !st || st.label !== u.from.label || styleCode(st) !== u.from.code; })
    || actives.some((a) => { const st = byId.get(a.styleId); return !st || isActive(st) !== a.from; })
    || creates.some((c) => taken.some((st) => String(st.label).trim().toLowerCase() === c.label.toLowerCase() || styleCode(st) === c.code));
  if (moved) return { patch: { status: "failed", failure: "Your styles changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now." } };
  const where = GUIDES.styles.where;
  const reports: Report[] = [];
  const made: StyleMade[] = [], edited: StyleEdit[] = [], flipped: StyleFlip[] = [];
  let saved = 0, created = 0;
  const plan = () => (made.length || edited.length || flipped.length ? { made, edited, flipped } : null);
  const step = async () => { await progress({ result: { saved, created, reports }, undo: plan() }); };
  for (const c of creates) {
    const r = await deps.portal("create_style", { label: c.label, code: c.code });
    if (landed(r) && typeof r.data?.styleId === "string") { made.push({ styleId: r.data.styleId, label: c.label, code: c.code }); created++; }
    else if (unsure(r)) { made.push({ styleId: null, label: c.label, code: c.code, unsure: true }); reports.push({ label: c.label, status: "error", reason: UNSURE(where) }); }
    else reports.push({ label: c.label, status: "refused", reason: saidBy(r, "That didn't save.") });
    await step();
  }
  for (const u of updates) {
    const r = await deps.portal("update_style", { styleId: u.styleId, ...(u.label ? { label: u.label } : {}), ...(u.code ? { code: u.code } : {}) });
    if (landed(r)) { edited.push(u); saved++; }
    else if (unsure(r)) { edited.push(u); reports.push({ label: u.name, status: "error", reason: UNSURE(where) }); }
    else reports.push({ label: u.name, status: "refused", reason: saidBy(r, "That didn't save.") });
    await step();
  }
  for (const a of actives) {
    const r = await deps.portal("set_style_active", { styleId: a.styleId, active: a.to });
    if (landed(r)) { flipped.push(a); saved++; }
    else if (unsure(r)) { flipped.push(a); reports.push({ label: a.name, status: "error", reason: UNSURE(where) }); }
    else reports.push({ label: a.name, status: "refused", reason: saidBy(r, "That didn't save.") });
    await step();
  }
  return { patch: { status: reports.length ? "partly_applied" : "applied", result: { saved, created, reports }, undo: plan() } };
}

async function undoStyles(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { made?: StyleMade[]; edited?: StyleEdit[]; flipped?: StyleFlip[] };
  const read = await readCatalog(deps);
  if ("error" in read) return { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: TRY_AGAIN }] };
  const styles = read.c.styles as Any[];
  const byId = new Map(styles.map((st) => [String(st.id), st]));
  const sizesOf = (id: string) => (read.c.sizes as Any[]).filter((z) => String(z.style_id) === id).length;
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  const outcome = (r: Res, label: string, ok: () => void) => {
    if (landed(r)) ok();
    else if (unsure(r)) { out.failed++; out.reports.push({ label, status: "error", reason: TRY_AGAIN }); }
    else out.reports.push({ label, status: "refused", reason: saidBy(r, "That didn't go back.") });
  };
  for (const m of plan.made ?? []) {
    // A create that never answered is found by its code, which is unique per builder, and its name.
    const st = m.styleId ? byId.get(m.styleId) : styles.find((x) => styleCode(x) === m.code && x.label === m.label);
    if (!st) { if (m.styleId) out.removed++; continue; }
    if (st.label !== m.label || styleCode(st) !== m.code) { out.reports.push({ label: m.label, status: "changed", reason: "This style was changed since I added it, so I left it. Hide it on Settings > Sheds if you don't want it." }); continue; }
    // Deleting a style takes its sizes with it, so a style with any is never deleted from here.
    if (sizesOf(String(st.id))) { out.reports.push({ label: m.label, status: "kept", reason: "This style has sizes now, so I left it. Hide it on Settings > Sheds if you don't want it." }); continue; }
    const r = await deps.portal("delete_style", { styleId: String(st.id) });
    if (r.status === 404) out.removed++;
    else outcome(r, m.label, () => out.removed++);
  }
  for (const u of plan.edited ?? []) {
    const st = byId.get(u.styleId);
    if (!st) { out.reports.push({ label: u.name, status: "changed", reason: "This style isn't on the account any more." }); continue; }
    const body: Record<string, unknown> = { styleId: u.styleId };
    if (u.label) {
      if (st.label === u.label) body.label = u.from.label;
      else out.reports.push({ label: u.name, status: "changed", reason: "Its name was changed since, so I left it." });
    }
    if (u.code) {
      if (styleCode(st) !== u.code) out.reports.push({ label: u.name, status: "changed", reason: "Its code was changed since, so I left it." });
      else if (u.from.code) body.code = u.from.code;
      else out.reports.push({ label: u.name, status: "kept", reason: `A style's serial code can be changed but not taken off, so it stays ${u.code}.` });
    }
    if (!("label" in body) && !("code" in body)) continue;
    const r = await deps.portal("update_style", body);
    outcome(r, u.name, () => out.restored++);
  }
  for (const f of plan.flipped ?? []) {
    const st = byId.get(f.styleId);
    if (!st) continue;
    if (isActive(st) !== f.to) { out.reports.push({ label: f.name, status: "changed", reason: "This was changed since, so I left it." }); continue; }
    const r = await deps.portal("set_style_active", { styleId: f.styleId, active: f.from });
    outcome(r, f.name, () => out.restored++);
  }
  return out;
}

// ── Doors, windows and ramps ──────────────────────────────────────────────────────────────────────
// The door tool, generalized. Same save (save_fixture by category), same Undo: delete only while the
// row's updated_at still reads what it did right after the save (deps.store.fixtureStamp).

const FIXTURE_GUIDE: Record<string, Guide> = { door: GUIDES.doors, window: GUIDES.windows, ramp: GUIDES.ramps };

const fixtureTool: ToolSpec = {
  def: {
    name: "propose_catalog_item",
    description: "Put a preview on the person's screen that adds a window or a ramp to Settings > Options. A door goes through propose_new_door instead. It changes nothing: the person presses Approve. It needs a name, a width, a height (for a ramp, its length) in inches and a price in dollars, all from what they told you: ask for any that's missing.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["category", "name", "widthInches", "heightInches", "price"],
      properties: {
        category: { type: "string", enum: ["window", "ramp"] },
        name: { type: "string" },
        widthInches: { type: "number" },
        heightInches: { type: "number", description: "For a ramp, its length in inches." },
        price: { type: "number", description: "In dollars." },
      },
    },
  },
  needs: [{ area: "settings_options", level: "edit" }],
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const i = (input ?? {}) as Any;
    const category = String(i.category ?? "");
    // One door tool, so Claude is never offered two: doors keep their own switch (propose_new_door).
    if (category === "door") return err("A door goes through propose_new_door.");
    if (!FIXTURE_GUIDE[category]) return err("Say window or ramp.");
    const name = String(i.name ?? "").trim().slice(0, 120);
    const w = Number(i.widthInches), h = Number(i.heightInches), price = Number(i.price);
    const longWord = category === "ramp" ? "length" : "height";
    if (!name || !(w > 0 && w < 2000) || !(h > 0 && h < 2000) || !(price >= 0 && price < 1_000_000)) return err(`A ${category} needs a name, a width, a ${longWord} and a price.`);
    const notes: string[] = [];
    // Best effort: the save is an insert, so a failed read only loses these two checks.
    const cat = await readCatalog(deps).catch(() => null);
    if (cat && !("error" in cat)) {
      const twin = ((cat.c.fixtures ?? []) as Any[]).find((f) => f.category === category && f.archived !== true && String(f.name ?? "").trim().toLowerCase() === name.toLowerCase() && Number(f.width_in) === w && Number(f.height_in) === h);
      if (twin) return err(`You already have that ${category}: ${scrub(name, 80)}, ${w} by ${h} inches.`);
      const rs = cat.c.rampSettings ?? {};
      if (category === "ramp" && rs.enabled === false) notes.push("Ramps are switched off for customers right now. Turn them on at Settings > Options > Ramps.");
      else if (category === "ramp" && rs.mode !== "custom") notes.push("Ramps are set to the one simple ramp right now. This one is offered once Ramps is switched to your own list on Settings > Options > Ramps.");
    }
    if (category === "door") notes.push("It swings out with a right hinge, the way a new door starts on the Doors tab.");
    const row = { name, widthIn: w, heightIn: h, price, ...(category === "door" ? { swingOut: true, opRight: true } : {}) };
    const g = FIXTURE_GUIDE[category];
    const size = category === "ramp" ? `${w} inches wide, ${h} long` : `${w} by ${h} inches`;
    await putCard(deps, s, {
      kind: "setup_fixture", title: `Add a ${category}: ${name}`,
      preview: {
        fixture: { category, ...row },
        lines: [{ label: `New ${category}`, from: "", to: `${name}, ${size}, $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` }],
        notes, ticks: [], where: g.where, route: { page: g.page, sub: g.sub },
      },
      payload: { category, row },
    });
    return ok({ shown: true, note: SAID.onScreenApprove });
  },
};

async function applyFixture(deps: Deps, who: { clientId: string }, p: ProposalRow): Promise<ApplyOutcome> {
  const category = String(p.payload?.category ?? "");
  const where = (FIXTURE_GUIDE[category] ?? GUIDES.catalog_items).where;
  const r = await deps.portal("save_fixture", { category, ...(p.payload?.row ?? {}) });
  const id = r.status === 200 && r.data && typeof r.data.id === "string" ? r.data.id : null;
  if (id) {
    const fixtureBase = await deps.store.fixtureStamp(who.clientId, id).catch(() => null);
    return { patch: { status: "applied", result: { saved: 0, created: 1, reports: [] }, undo: { fixtureId: id, fixtureBase, category } } };
  }
  return { patch: { status: "partly_applied", result: { saved: 0, created: 0, reports: [{ label: p.title, status: unsure(r) ? "error" : "refused", reason: unsure(r) ? UNSURE(where) : saidBy(r, "That didn't save.") }] } } };
}

async function undoFixture(deps: Deps, who: { clientId: string }, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { fixtureId?: string; fixtureBase?: string | null; category?: string };
  const what = plan.category ?? "item";
  const where = (FIXTURE_GUIDE[what] ?? GUIDES.catalog_items).where;
  let stamp: string | null;
  try {
    stamp = await deps.store.fixtureStamp(who.clientId, String(plan.fixtureId ?? ""));
  } catch {
    return { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: TRY_AGAIN }] };
  }
  if (stamp === null) return { restored: 0, removed: 1, failed: 0, reports: [] };
  if (!plan.fixtureBase) return { restored: 0, removed: 0, failed: 0, reports: [{ label: p.title, status: "refused", reason: `I couldn't check this ${what} when it was added, so I left it. Delete it on ${where} if you don't want it.` }] };
  if (stamp !== plan.fixtureBase) return { restored: 0, removed: 0, failed: 0, reports: [{ label: p.title, status: "changed", reason: `This ${what} was edited or moved since it was added, so I left it. Delete it on ${where} if you don't want it.` }] };
  const r = await deps.portal("delete_fixture", { id: plan.fixtureId });
  if (r.status === 200 || r.status === 404) return { restored: 0, removed: 1, failed: 0, reports: [] };
  return { restored: 0, removed: 0, failed: unsure(r) ? 1 : 0, reports: [{ label: p.title, status: unsure(r) ? "error" : "refused", reason: saidBy(r, "That didn't undo.") }] };
}

// ── Sales lots and the serial start ───────────────────────────────────────────────────────────────

interface Lot { name: string; street: string | null; city: string | null; state: string | null; zip: string | null }
interface LotMade extends Lot { id: string | null; unsure?: boolean }

const lotOf = (l: Any): Lot => ({ name: String(t(l.name) ?? ""), street: t(l.street), city: t(l.city), state: t(l.state), zip: t(l.zip) });
const sameLot = (a: Lot, b: Lot) => sameV(lotOf(a), lotOf(b));
const lotLine = (l: Lot) => [l.name, l.street, l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

const lotsTool: ToolSpec = {
  def: {
    name: "propose_locations",
    description: "Put a preview on the person's screen that adds sales lots (where inventory buildings sit), and sets where building serial numbers start counting when that isn't set yet. It changes nothing: the person presses Approve. Use only what they gave you; leave a part of an address empty when they didn't say it. The serial start can only be set once from here, can't be put back, and can only go up after that.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["lots", "serialStart"],
      properties: {
        lots: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["name", "street", "city", "state", "zip"],
            properties: { name: { type: "string" }, street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" } },
          },
        },
        serialStart: { type: "integer", description: "The first serial number, or 0 to leave it as it is." },
      },
    },
  },
  needs: [{ area: "settings_branding", level: "edit" }],
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const i = (input ?? {}) as Any;
    const asked: Any[] = Array.isArray(i.lots) ? i.lots.slice(0, 20) : [];
    const serial = Number(i.serialStart) || 0;
    if (!asked.length && !serial) return err("Tell me the lots to add, or where serial numbers should start.");
    const read = await readLots(deps);
    if ("error" in read) return err(read.error);
    const problems: string[] = [];
    const names = new Set(read.lots.map((l) => String(l.name ?? "").trim().toLowerCase()));
    const cap = (v: unknown, n: number) => t(String(v ?? "").slice(0, n));
    const lots: Lot[] = [];
    for (const a of asked) {
      const lot: Lot = { name: String(a?.name ?? "").trim().slice(0, 120), street: cap(a?.street, 200), city: cap(a?.city, 100), state: cap(a?.state, 60), zip: cap(a?.zip, 12) };
      if (!lot.name) { problems.push("Each lot needs a name."); continue; }
      if (names.has(lot.name.toLowerCase())) { problems.push(`You already have a lot called "${scrub(lot.name, 60)}".`); continue; }
      names.add(lot.name.toLowerCase());
      lots.push(lot);
    }
    if (serial) {
      if (read.nextSerial !== null) problems.push("Your serial numbers already have a starting number. It can only go up, on Settings > Company > Business Details.");
      else if (!(Number.isInteger(serial) && serial >= 1 && serial <= 999_999_999)) problems.push("The serial start must be a whole number from 1 to 999,999,999.");
    }
    if (problems.length) return err(problems.join(" "));
    const notes: string[] = [];
    if (lots.length) notes.push("I don't set a lot's tax rate. Check each lot on Settings > Company > Locations.");
    if (serial) notes.push("The serial start can't be put back once a building uses a number, so Undo leaves it.");
    const steps = await readSteps(deps).catch(() => null);
    // One step for both (the seed's), or a step each (the live template's).
    const own = hasStep(steps, "serial");
    const hasLots = read.lots.length + lots.length > 0, hasSerial = read.nextSerial !== null || !!serial;
    const tk = hasLots && (own || hasSerial) ? tickFor(steps, "locations") : null;
    const tkSerial = own && hasSerial ? tickFor(steps, "serial") : null;
    const ticks = [tk, tkSerial].filter((x): x is Tick => !!x);
    await putCard(deps, s, {
      kind: "setup_locations",
      title: lots.length ? `Sales lots: add ${lots.length}${serial ? ", and the serial start" : ""}` : "Where serial numbers start",
      preview: {
        lines: [...lots.map((l) => ({ label: "New lot", from: "", to: lotLine(l) })), ...(serial ? [{ label: "Serial numbers start at", from: "", to: serial.toLocaleString("en-US") }] : [])],
        notes, ticks: ticks.map((x) => x.title), where: GUIDES.locations.where, route: { page: GUIDES.locations.page, sub: GUIDES.locations.sub },
      },
      payload: { lots, nextSerial: serial || null, ticks },
    });
    return ok({ shown: true, lotsAdding: lots.length, serialStartSet: !!serial, ticksStep: ticks.map((x) => x.title), note: SAID.onScreenApprove });
  },
};

async function applyLots(deps: Deps, p: ProposalRow, progress: Progress): Promise<ApplyOutcome> {
  const lots: Lot[] = p.payload?.lots ?? [];
  const serial: number | null = p.payload?.nextSerial ?? null;
  const read = await readLots(deps);
  if ("error" in read) return { patch: { status: "failed", failure: "I couldn't check your lots just now, so nothing was saved. Ask me again in a moment." } };
  const names = new Set(read.lots.map((l) => String(l.name ?? "").trim().toLowerCase()));
  if (lots.some((l) => names.has(l.name.toLowerCase())) || (serial !== null && read.nextSerial !== null)) {
    return { patch: { status: "failed", failure: "Your lots or serial numbers changed since I showed you this, so nothing was saved. Ask me again and I'll start from what's there now." } };
  }
  const where = GUIDES.locations.where;
  const reports: Report[] = [];
  const made: LotMade[] = [];
  let saved = 0, created = 0;
  const plan = () => (made.length ? { lots: made, ticks: [] as Tick[] } : null);
  for (const l of lots) {
    const r = await deps.portal("save_location", { name: l.name, street: l.street ?? "", city: l.city ?? "", state: l.state ?? "", zip: l.zip ?? "" });
    if (landed(r) && typeof r.data?.id === "string") { made.push({ ...l, id: r.data.id }); created++; }
    else if (unsure(r)) { made.push({ ...l, id: null, unsure: true }); reports.push({ label: l.name, status: "error", reason: UNSURE(where) }); }
    else reports.push({ label: l.name, status: "refused", reason: saidBy(r, "That didn't save.") });
    await progress({ result: { saved, created, reports }, undo: plan() });
  }
  // Only a serial start that landed is named on Undo ("keeps starting at"): a refused one never did.
  let serialSet: number | null = null;
  if (serial !== null) {
    const r = await deps.portal("save_serial_start", { nextSerial: serial });
    if (landed(r)) { saved++; serialSet = serial; }
    else reports.push({ label: "Serial start", status: unsure(r) ? "error" : "refused", reason: unsure(r) ? UNSURE("Settings > Company > Business Details") : saidBy(r, "That didn't save.") });
  }
  const ticks: Tick[] = p.payload?.ticks ?? [];
  const t2 = !reports.length && ticks.length ? await runTicks(deps, p, ticks) : { ticked: [], notes: ticks.length ? ["I didn't tick the step, since not everything saved."] : [] };
  return {
    patch: {
      status: reports.length ? "partly_applied" : "applied",
      result: { saved, created, reports, ticked: t2.ticked.map((x) => x.title), tickNotes: t2.notes },
      undo: made.length || t2.ticked.length ? { lots: made, ticks: t2.ticked, serial: serialSet } : null,
    },
  };
}

async function undoLots(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { lots?: LotMade[]; ticks?: Tick[]; serial?: number | null };
  const read = await readLots(deps);
  if ("error" in read) return { restored: 0, removed: 0, failed: 1, reports: [{ label: p.title, status: "error", reason: TRY_AGAIN }] };
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  for (const m of plan.lots ?? []) {
    const lot = m.id ? read.lots.find((l) => String(l.id) === m.id) : read.lots.find((l) => sameLot(l, m));
    if (!lot) { if (m.id) out.removed++; continue; }
    if (!sameLot(lot, m)) { out.reports.push({ label: m.name, status: "changed", reason: "This lot was changed since I added it, so I left it." }); continue; }
    if (Number(lot.buildings) > 0) { out.reports.push({ label: m.name, status: "kept", reason: "There are buildings on this lot now, so I left it." }); continue; }
    const r = await deps.portal("delete_location", { id: String(lot.id) });
    if (landed(r) || r.status === 404) out.removed++;
    else if (unsure(r)) { out.failed++; out.reports.push({ label: m.name, status: "error", reason: TRY_AGAIN }); }
    else out.reports.push({ label: m.name, status: "refused", reason: saidBy(r, "That didn't go back.") });
  }
  if (plan.serial) out.reports.push({ label: "Serial start", status: "kept", reason: `Serial numbers keep starting at ${plan.serial.toLocaleString("en-US")}. Numbers can't go back once they're used.` });
  return addUp(out, await untick(deps, p, plan.ticks ?? []));
}

// ── A step done by hand ───────────────────────────────────────────────────────────────────────────

const tickTool: ToolSpec = {
  def: {
    name: "propose_setup_tick",
    description: "Put a card on the person's screen that marks one setup step done, for a step they finished by hand. The checklist then says it was done with Jack. It changes nothing until they press Approve. Use the step's ref from look_at_my_setup, and only for a step they told you is finished.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["step"], properties: { step: { type: "string", description: "The step's ref from look_at_my_setup." } } },
  },
  switchKey: SETUP_SWITCH,
  proposesChange: true,
  async run(deps, s, input) {
    const ref = String((input as Any)?.step ?? "").trim();
    const read = await readSteps(deps);
    if ("error" in read) return err(read.error);
    if (!read.canTick) return err("Ticking a setup step is for an owner or admin.");
    const st = read.steps.find((x) => x.ref === ref);
    if (!st) return err("I can't find that step. Look at the setup list again.");
    if (st.done) return ok({ shown: false, alreadyDone: true, note: "That step is already ticked. Say so, and don't make a card." });
    if (st.locked) return err(`That step needs ${st.needs ?? "an add-on"} first, so it can't be ticked yet.`);
    await putCard(deps, s, {
      kind: "setup_tick", title: `Mark done: ${st.title}`,
      preview: { step: { title: st.title, section: st.section }, lines: [{ label: "Mark done", from: "", to: st.title }], notes: [], ticks: [st.title], where: "Support > Getting set up", route: { page: "support", sub: "setup" } },
      payload: { ticks: [{ id: st.id, title: st.title }] },
    });
    return ok({ shown: true, note: SAID.onScreenApprove });
  },
};

async function applyTick(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const ticks: Tick[] = p.payload?.ticks ?? [];
  const reports: Report[] = [];
  const ticked: Tick[] = [], maybe: Tick[] = [];
  const notes: string[] = [];
  for (const tk of ticks) {
    const r = await deps.call("portal-setup", "toggle", { id: tk.id, done: true, viaProposal: p.id });
    if (landed(r) && r.data?.already === true) notes.push("It was already ticked.");
    else if (landed(r)) ticked.push(tk);
    // It may have landed: Undo can still take it back, since portal-setup clears only this card's tick.
    else if (unsure(r)) { maybe.push(tk); reports.push({ label: tk.title, status: "error", reason: UNSURE("Support > Getting set up") }); }
    else reports.push({ label: tk.title, status: "refused", reason: saidBy(r, "The checklist didn't take that.") });
  }
  return {
    patch: {
      status: reports.length ? "partly_applied" : "applied",
      result: { saved: ticked.length, created: 0, reports, ticked: ticked.map((x) => x.title), tickNotes: notes },
      undo: ticked.length || maybe.length ? { ticks: [...ticked, ...maybe] } : null,
    },
  };
}

// ── Pointing to a page ────────────────────────────────────────────────────────────────────────────

const pointTool: ToolSpec = {
  def: {
    name: "point_to_step",
    description: "Show the person where to do a setup step you can't fill in for them, with a Take me there button: colors, add-on prices, the logo, sales tax, team and access, email from their own domain, texting, phone, QuickBooks, commissions, crews and drivers, 3D, Real-Time Pricing, sharing their link, a test estimate, automatic top-up, and the rest. It changes nothing.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", enum: Object.keys(GUIDES) } } },
  },
  switchKey: SETUP_SWITCH,
  async run(deps, s, input) {
    const key = String((input as Any)?.key ?? "");
    const g = GUIDES[key];
    if (!g) return err("I don't know that step.");
    if (g.area && !deps.canRead(g.area)) return ok({ shown: false, where: g.where, note: "That page isn't part of this person's access. Tell them an owner or admin does this step, and don't send them there." });
    if (!g.page) return ok({ shown: false, say: g.say, note: "Tell them this in a sentence. There's no page for it." });
    await putCard(deps, s, { kind: "setup_guide", title: `Where to set: ${g.title}`, status: "applied", hashed: false, preview: { key, title: g.title, where: g.where, say: g.say, route: { page: g.page, sub: g.sub } } });
    return ok({ shown: true, where: g.where, say: g.say, note: "A card with a Take me there button is on their screen. Tell them where it is in a sentence." });
  },
};

// ── The look ──────────────────────────────────────────────────────────────────────────────────────

function facts(d: Any) {
  const crm = typeof d.invoiceInGhl === "boolean";
  const addr = addrNorm(d.businessAddress);
  const town = addr ? [addr.city, addr.state].filter(Boolean).join(", ") : "";
  return {
    businessName: t(d.businessName) ? scrub(d.businessName, 120) : null,
    businessPhone: t(d.businessPhone) ? "set" : "not set",
    businessAddress: addr ? (town ? `set (${scrub(town, 80)})` : "set") : "not set",
    website: t(d.businessWebsite) ? "set" : "not set",
    logo: t(d.businessLogoUrl) || t(d.branding?.logoUrl) ? "set" : "not set",
    quoteTerms: t(d.quoteTerms) ? "set" : "not set",
    quoteValidDays: numOrNull(d.quoteValidDays),
    customerLinkName: t(d.branding?.companyName) ? scrub(d.branding.companyName, 120) : null,
    tagline: t(d.branding?.tagline) ? scrub(d.branding.tagline, 160) : null,
    accentColor: /^#[0-9a-fA-F]{3,8}$/.test(String(d.branding?.accentColor ?? "")) ? d.branding.accentColor : t(d.branding?.accentColor) ? "set" : "not set",
    customersSeePrices: d.showPricing === true,
    ...(crm
      ? {
        quotesAndInvoices: d.invoiceInGhl ? "through their CRM" : "issued by Structure Studio",
        crmInvoicingAllowed: d.ghlInvoicingAllowed === true,
        salesTaxRate: d.ssTaxRate === null || d.ssTaxRate === undefined ? "not set" : "set",
        nextQuoteNumber: num(numOrNull(d.ssQuoteNext)) ?? "not chosen (starts at 1,000)",
        nextInvoiceNumber: num(numOrNull(d.ssInvoiceNext)) ?? "not chosen (starts at 1,000)",
        emailFromOwnDomain: d.emailReady === true ? "ready" : "not set up",
      }
      : { quotesAndInvoices: "not part of this person's access" }),
  };
}

const lookTool: ToolSpec = {
  def: {
    name: "look_at_my_setup",
    description: "Read this builder's setup checklist (Support > Getting set up): each step with a ref, whether it's done, whether an add-on locks it, and how you can help with it. Also what's filled in on their business details, customer link and paperwork, and their sales lots. Use it when they ask for help setting up, and before proposing a setup change.",
    strict: true,
    input_schema: EMPTY,
  },
  switchKey: SETUP_SWITCH,
  async run(deps) {
    const [steps, st, lots] = await Promise.all([
      readSteps(deps),
      readStatus(deps).catch(() => ({ error: SAID.readFailed })),
      deps.canRead("settings_branding") || deps.canRead("inventory") ? readLots(deps).catch(() => ({ error: SAID.readFailed })) : Promise.resolve(null),
    ]);
    if ("error" in steps) return err(steps.error);
    return ok({
      counts: steps.counts,
      canTick: steps.canTick,
      steps: steps.steps.map((x) => ({
        ref: x.ref, title: x.title, section: x.section, done: x.done, withJack: x.withJack, locked: x.locked, needs: x.needs,
        help: x.key && FILLS[x.key] ? `fill with ${FILLS[x.key]}` : x.key && GUIDES[x.key] ? `guide with point_to_step (key ${x.key})` : "written for this builder: read the title and help in words",
      })),
      company: "error" in st ? null : facts(st.d),
      lots: lots && !("error" in lots) ? { count: lots.lots.length, serialStart: lots.nextSerial === null ? "not set" : num(lots.nextSerial) } : null,
      note: "Counts are the steps they can do now: a locked step isn't counted. Work through the open steps in order, one at a time. Values marked set are on file; you don't see phone numbers or street lines.",
    });
  },
};

// ── The piece ─────────────────────────────────────────────────────────────────────────────────────

const kinds: KindSpec[] = [
  {
    kind: "setup_company",
    // Business details and the show-prices switch save through `save`, which needs both areas
    // (portal-settings GATES.save). A card of branding only needs Branding.
    areas: (p) => (p.payload?.calls?.save ? ["settings_crm", "settings_branding"] : ["settings_branding"]),
    switches: () => [SETUP_SWITCH],
    where: "Settings > Company",
    nothingToDo: fieldsNothing,
    apply: (deps, _who, p, progress) => applyFields(deps, p, progress, "Settings > Company"),
    undo: (deps, _who, p) => undoFields(deps, p),
  },
  {
    kind: "setup_paperwork",
    areas: () => ["settings_crm", "settings_branding"],
    switches: () => [SETUP_SWITCH],
    where: "Settings > GHL Connection",
    nothingToDo: fieldsNothing,
    apply: (deps, _who, p, progress) => applyFields(deps, p, progress, "Settings > GHL Connection"),
    undo: (deps, _who, p) => undoFields(deps, p),
  },
  {
    kind: "setup_styles",
    areas: () => ["settings_structures"],
    switches: () => [SETUP_SWITCH],
    where: "Settings > Sheds",
    nothingToDo: (p) => ((p.payload?.creates ?? []).length || (p.payload?.updates ?? []).length || (p.payload?.actives ?? []).length ? null : "Nothing would change, so there's nothing to approve."),
    apply: (deps, _who, p, progress) => applyStyles(deps, p, progress),
    undo: (deps, _who, p) => undoStyles(deps, p),
  },
  {
    kind: "setup_fixture",
    areas: () => ["settings_options"],
    // A door card also needs the doors switch, as propose_new_door's does.
    switches: (p) => (p.payload?.category === "door" ? [SETUP_SWITCH, "doors"] : [SETUP_SWITCH]),
    where: "Settings > Options",
    nothingToDo: (p) => (p.payload?.row?.name ? null : "Nothing would change, so there's nothing to approve."),
    apply: (deps, who, p) => applyFixture(deps, who, p),
    undo: (deps, who, p) => undoFixture(deps, who, p),
  },
  {
    kind: "setup_locations",
    areas: () => ["settings_branding"],
    switches: () => [SETUP_SWITCH],
    where: "Settings > Company > Locations",
    nothingToDo: (p) => ((p.payload?.lots ?? []).length || p.payload?.nextSerial ? null : "Nothing would change, so there's nothing to approve."),
    apply: (deps, _who, p, progress) => applyLots(deps, p, progress),
    undo: (deps, _who, p) => undoLots(deps, p),
  },
  {
    kind: "setup_tick",
    // portal-setup's own gate decides who may tick (an owner or admin, or the team with write access).
    areas: () => [],
    switches: () => [SETUP_SWITCH],
    where: "Support > Getting set up",
    nothingToDo: (p) => ((p.payload?.ticks ?? []).length ? null : "Nothing would change, so there's nothing to approve."),
    apply: (deps, _who, p) => applyTick(deps, p),
    undo: (deps, _who, p) => untick(deps, p, (p.undo?.ticks ?? []) as Tick[]),
  },
  { kind: "setup_guide", areas: () => [], switches: () => [], showOnly: true },
];

export const setupPiece: Piece = {
  name: "setup",
  tools: [lookTool, companyTool, paperworkTool, stylesTool, fixtureTool, lotsTool, tickTool, pointTool],
  kinds,
  can: [
    "Help them finish setting up: look_at_my_setup reads their Getting set up checklist and what's filled in.",
    "Fill in business details, their customer link's name and tagline, and whether customers see prices, with propose_company_details.",
    "Set how estimates and invoices go out and their starting numbers with propose_paperwork.",
    "Add, rename, hide or show building styles with propose_styles.",
    "Add a window or a ramp with propose_catalog_item (a door goes through propose_new_door).",
    "Add sales lots and set where serial numbers start with propose_locations.",
    "Mark a step done that they finished themselves with propose_setup_tick.",
    "Point them to the right page, with a button, for the steps you can't fill with point_to_step.",
  ],
  rules: [
    "Setup: work through the open steps in order, one at a time, and say how many are done (\"8 of 17 done\"). Fill only with values the person gave you: never make up a business detail, a code, a starting number or a price.",
    "Colors, add-on prices, the logo, sales tax, team access, billing and automatic top-up, and Customer Hub's email, text and phone settings are guide only. Use point_to_step for those. The customer link's accent color is guide only too, and it is on the Branding tab: point_to_step with branding, not colors (Settings > Colors is paint, shingle and metal).",
    "A setup card that finishes its step ticks it too, and the card says so. Don't tick a step they haven't told you is finished.",
  ],
};

/** For tests and the integration notes: every card kind this piece writes. */
export const SETUP_KINDS = kinds.map((k) => k.kind);

/** Exposed for tests. */
export const _test = { companyLines, paperworkLines, facts, NOW };
