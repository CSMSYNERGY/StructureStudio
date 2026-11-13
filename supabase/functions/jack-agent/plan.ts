// jack-agent: which TAB of the product each of Jack's tools and cards belongs to (plans as data,
// migrations 386 to 388; stage D).
//
// WHY. Jack's door already obeys the map: resolveTenant refuses a company without the `jack` tab.
// But inside the door, his tools were offered to every company alike. A company whose plan has no
// Orders page was still told "I can look up who owes you", and Jack only found out at the first
// downstream call, where portal-settings refused it in words about the PERSON's access. Some tools
// were never refused at all (the catalog reads). So the same map now decides
// which tools Claude is sent and which cards a press may run.
//
// THE THREE ANSWERS (as everywhere, _shared/accessEnforce.ts):
//   null     the company is not named, or the map could not be read: Jack is EXACTLY as he was.
//            The tool list is the same list, and nothing here refuses or files anything.
//   report   nothing is hidden and nothing is refused. Each tool that WOULD have been hidden, and
//            each press that would have been refused, is filed once per isolate as an info row
//            (code module_would_refuse), awaited.
//   block    a tool whose tabs are all not "on" is not sent to Claude, and answers "That isn't
//            available here right now." if it is called anyway. A press on a card whose tabs are
//            all not "on" is 403 module_off before anything is saved. "locked" is not "on".
//
// ⚠️ BE CONSERVATIVE: WHEN IN DOUBT, []. An empty list means "part of every account": it is never
// hidden and never refused by a plan. A wrong tab takes a tool away from a company that has always
// had it, the moment its server switch is turned on.
//
// ⚠️ A PLAN ONLY STOPS NEW WORK. Undo and cancel never ask this file (agent.ts): Jack's own door
// never refuses a person dismissing a card or pressing Undo, whatever their plan became since.
//
// ⚠️ THAT IS JACK'S DOOR ONLY, AND FOR UNDO IT IS NOT YET THE WHOLE WAY (open, stage D review).
// A put-back saves through the same routes a person's screen uses (apply.ts save_pricing_cells and
// delete_fixture; the pieces' move_job, crm_rule_save and the rest), with that person's own token.
// Those functions hand resolveTenant their own gate table, and in block mode it refuses the action
// when its tab is gone, put-back or not. So a company that approved a sizes card and then lost the
// Designer presses Undo, gets through here, and every line comes back "This isn't part of your
// plan": nothing is put back, the card stays applied, and its Undo is NOT spent (it works the
// moment the tab is back). plan_test.ts pins exactly that, so it is not mistaken for working.
// The cure is not in this function: the downstream door has to recognise a put-back, and a mark
// Jack adds to the call would be a mark anyone with a login could add to a call of their own.
// (A put-back whose route carries no tab does land whatever the plan: a commission rate's set_rate,
// and the setup cards that are every account's.)
//
// A NEW TOOL OR CARD KIND MUST BE DECIDED HERE. plan_test.ts holds both tables to the tools and
// kinds the pieces define, both ways, and every tab to the catalogue: a tool added without an entry
// fails the push, so it cannot ship offered to everyone by accident (or hidden from everyone).
//
// Pure data and pure helpers. It imports only the two dependency-free _shared files, never agent.ts
// or a piece, so every piece may import it without a cycle.

import { anyModuleOn, type ServerAccess } from "../_shared/accessEnforce.ts";
import { ACCESS_MODULES } from "../_shared/accessModules.ts";
import type { Deps } from "./types.ts";

export type { ServerAccess };

/** The function name report rows are keyed and filed under (handler.ts FN, written out here so this
 *  file needs nothing of the handler's). */
export const PLAN_FN = "jack-agent";

const NONE: readonly string[] = [];
const DESIGNER = ["designer"] as const;
const AUTOMATIONS = ["automations"] as const;
const CONTACTS = ["contacts"] as const;
const CONVERSATIONS = ["conversations"] as const;
const ORDERS = ["orders"] as const;
const INVENTORY = ["inventory"] as const;
const BUILD = ["build_schedule"] as const;
const DELIVERY = ["delivery_schedule"] as const;

/** Every tool Claude can be sent -> the tabs it belongs to. Allowed when ANY is on; [] = every
 *  account. The tab is the page the tool's work lives on, which is also the tab its first
 *  downstream call is refused for (_shared/accessActions.ts), where it has one. */
export const TOOL_MODULE: Readonly<Record<string, readonly string[]>> = {
  // ── agent.ts: the sizes table and doors (size_table and save_pricing_cells are settings_structures,
  //    save_fixture is settings_options: both the Shed Designer's settings) ──
  look_at_my_catalog: DESIGNER,
  propose_size_changes: DESIGNER,
  propose_new_door: DESIGNER,

  // ── memory.ts: Jack's own question card. No page, no data of the builder's. ──
  ask_to_be_sure: NONE,

  // ── setup.ts. The checklist, company details, paperwork and locations are every account's
  //    (settings_branding and the setup checklist carry no tab). Styles, windows and ramps are the
  //    Designer's catalog: create_style and save_fixture are refused without it downstream. ──
  look_at_my_setup: NONE,
  propose_company_details: NONE,
  propose_paperwork: NONE,
  propose_styles: DESIGNER,
  propose_catalog_item: DESIGNER,
  propose_locations: NONE,
  propose_setup_tick: NONE,
  point_to_step: NONE,

  // ── rules.ts: Automations (crm_rules_list, crm_rule_log, crm_rule_save) ──
  look_at_my_rules: AUTOMATIONS,
  look_at_rule_runs: AUTOMATIONS,
  propose_rule: AUTOMATIONS,
  propose_rule_pause: AUTOMATIONS,

  // ── lookups.ts. By the page each list is about: customers (crm_customer_facts), the inbox
  //    (crm_inbox), orders (orders_overview), the lot (list_inventory). ──
  find_quiet_customers: CONTACTS,
  find_not_bought: CONTACTS,
  what_came_in: CONVERSATIONS,
  look_up_customer: CONTACTS,
  find_who_owes: ORDERS,
  find_sold_not_scheduled: ORDERS,
  find_built_not_delivered: ORDERS,
  find_lot_inventory: INVENTORY,

  // ── drafts.ts and sends.ts: one customer's record (crm_record), and a message to them ──
  look_at_customer_for_reply: CONTACTS,
  propose_reply_draft: CONTACTS,
  propose_estimate_resend: CONTACTS,

  // ── reads.ts. Billing is every account's: a builder must always be able to ask what they pay. ──
  look_at_billing: NONE,
  find_conversations: CONVERSATIONS,

  // ── the record pieces: each is its own page ──
  look_at_order_for_change: ORDERS,
  propose_change_order: ORDERS,
  look_at_inventory: INVENTORY,
  propose_inventory_change: INVENTORY,
  look_at_build_schedule: BUILD,
  propose_build_schedule: BUILD,
  look_at_delivery_loads: DELIVERY,
  find_to_be_loaded: DELIVERY,
  propose_delivery_change: DELIVERY,
  // commissions.ts: NO tab, on purpose. A commission rate is set on the Team screen (Settings >
  // Company > Team), and the route behind it (portal-commissions set_rate and list) carries no tab:
  // a company without the Commissions tab still types a rate there by hand. Jack must not be
  // stricter than the screen. (Who may set a rate is the person's Team access, as before.)
  propose_commission_rate: NONE,

  // ── insulation.ts and options.ts: the Designer's option prices ──
  look_at_my_insulation: DESIGNER,
  propose_insulation_prices: DESIGNER,
  look_at_my_option_prices: DESIGNER,
  propose_option_prices: DESIGNER,
};

/** Every kind of card -> the tabs a press on its Approve belongs to. A card follows the tool that
 *  makes it. [] = never refused by a plan: a card of every account's (setup, memory), or one that is
 *  only ever shown (a look-up list, a guide). */
export const KIND_MODULE: Readonly<Record<string, readonly string[]>> = {
  // agent.ts's own three: the sizes table and a door.
  price_sheet: DESIGNER,
  size_rule: DESIGNER,
  new_fixture: DESIGNER,
  // memory.ts
  memory: NONE,
  // setup.ts: styles and catalog items follow their tools into the Designer; the rest is every account's.
  setup_company: NONE,
  setup_paperwork: NONE,
  setup_styles: DESIGNER,
  setup_fixture: DESIGNER,
  setup_locations: NONE,
  setup_tick: NONE,
  setup_guide: NONE,
  // rules.ts
  automation_rule: AUTOMATIONS,
  automation_pause: AUTOMATIONS,
  // lookups.ts: shown only. Its tool is already hidden where the tab is off, and a list made before
  // then is the person's own record of what they asked.
  lookup: NONE,
  // drafts.ts and sends.ts
  reply_draft: CONTACTS,
  reply_send: CONTACTS,
  estimate_resend: CONTACTS,
  // changeorders.ts
  changeorder_attrs: ORDERS,
  changeorder_unlock: ORDERS,
  // inventory.ts
  inventory_price: INVENTORY,
  inventory_listing: INVENTORY,
  inventory_photos: INVENTORY,
  // buildschedule.ts
  build_job_add: BUILD,
  build_job_change: BUILD,
  build_job_built: BUILD,
  // delivery.ts
  delivery_load_create: DELIVERY,
  delivery_stop_add: DELIVERY,
  delivery_stop_reorder: DELIVERY,
  delivery_load_out: DELIVERY,
  delivery_stop_delivered: DELIVERY,
  delivery_load_delivered: DELIVERY,
  // commissions.ts: the Team screen's, like its tool above. No tab, so its Approve is never refused
  // by a plan and its Undo (set_rate again) lands whatever the plan.
  commission_rate: NONE,
  // insulation.ts and options.ts
  insulation_price: DESIGNER,
  option_price: DESIGNER,
};

/** Jack's own tab: the one every action that starts new work with him belongs to (a message, a
 *  price list, an approve), which resolveTenant checks at the door through the `jack` area
 *  (_shared/accessActions.ts). Written out here for `status`, which carries no tab (it is the record,
 *  and is never refused) but tells the page whether a message would be: agent.ts handleStatus.
 *  plan_test.ts holds it to what the door works out for `send`. */
export const JACK_TABS: readonly string[] = ["jack"];

/** A price list sent with the paperclip (the sheet_start action) reads and then changes the sizes
 *  table: besides the Jack tab, which resolveTenant has already checked, it is the Designer's. */
export const SHEET_START_TABS: readonly string[] = DESIGNER;
/** The key that press is reported under. NOT the route's own name: resolveTenant files its report
 *  for the Jack tab under (company, "jack-agent", "sheet_start"), and firstReport lets each key
 *  through once per isolate, so the same key here would be silenced by resolveTenant's row, which
 *  always comes first. A company in report mode without the Jack tab AND without the Designer would
 *  then never show that a price list also needs the Designer. plan_test.ts holds every key this
 *  file's callers use apart from the route names. */
export const SHEET_START_KEY = "press:sheet_start";

/** A tool's tabs. An unknown tool has none: it is not a plan's to refuse (runTool answers
 *  "Unknown tool" for it), and the test keeps a real tool from being unknown here. */
export function tabsOfTool(name: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(TOOL_MODULE, name) ? TOOL_MODULE[name] : NONE;
}
/** A card kind's tabs, the same way. */
export function tabsOfKind(kind: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(KIND_MODULE, kind) ? KIND_MODULE[kind] : NONE;
}

/** Does the company's map leave these tabs out? True only for a named company (block or report)
 *  whose map has NONE of them exactly "on". No tabs, or no map, is never "lacks". */
export function lacks(plan: ServerAccess | null | undefined, tabs: readonly string[]): boolean {
  return !!plan && tabs.length > 0 && !anyModuleOn(plan.modules, tabs);
}
/** BLOCK mode and the tabs are not had: hide the tool, refuse the press. */
export const blockedBy = (plan: ServerAccess | null | undefined, tabs: readonly string[]): boolean =>
  !!plan && plan.mode === "block" && lacks(plan, tabs);
/** REPORT mode and the tabs are not had: nothing changes, and a row says what would have. */
export const wouldBlock = (plan: ServerAccess | null | undefined, tabs: readonly string[]): boolean =>
  !!plan && plan.mode === "report" && lacks(plan, tabs);

/** The company's server answer for this request, or null (the old rules). Deps.plan is optional so
 *  a test's Deps need not know about plans; absent, or a read that throws, is null. */
export async function planOf(deps: Deps): Promise<ServerAccess | null> {
  if (typeof deps.plan !== "function") return null;
  try {
    return (await deps.plan()) ?? null;
  } catch {
    return null;
  }
}

/** planOf for a caller that only DISPLAYS the answer (agent.ts handleStatus): null, the old rules,
 *  once `ms` has passed. Before stage D `status` read no map at all, so a read that stalls must not
 *  hang the panel. The read itself is not stopped and may still land and fill the cache for the
 *  next ask (the runtime may also drop it once the response has gone). Not for send, approve or a
 *  price list: they act on the answer and wait for it. The timer is cleared either way, so nothing
 *  is left running behind an answer. */
export function planSoon(deps: Deps, ms = 1000): Promise<ServerAccess | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([planOf(deps), late]).finally(() => clearTimeout(timer));
}

/** The report row for one would-be refusal, in the words and shape resolveTenant files its own
 *  (code module_would_refuse, context { action, tabs, states }). `key` is "tool:<name>",
 *  "approve:<kind>" or SHEET_START_KEY: never a bare route name, which is resolveTenant's own key. */
export function reportRow(plan: ServerAccess, key: string, tabs: readonly string[]) {
  return {
    code: "module_would_refuse",
    severity: "info" as const,
    message: `Report only: ${key} would be refused (needs ${tabs.join(" or ")}).`,
    context: { action: key, tabs: [...tabs], states: Object.fromEntries(tabs.map((t) => [t, plan.modules[t] ?? null])) },
  };
}

const LABEL = new Map(ACCESS_MODULES.map((m) => [m.key, m.label]));
const ORDER = new Map(ACCESS_MODULES.map((m, i) => [m.key, i]));

/** The areas of the product this company's plan leaves out, as far as Jack's tools go: the
 *  catalogue's own labels, in the catalogue's order, so the line is the same on every turn of a
 *  company. Empty unless the server BLOCKS by the map and at least one tool is hidden by it. */
export function missingAreas(plan: ServerAccess | null | undefined): string[] {
  if (!plan || plan.mode !== "block") return [];
  const keys = new Set<string>();
  for (const tabs of Object.values(TOOL_MODULE)) if (blockedBy(plan, tabs)) for (const t of tabs) keys.add(t);
  return [...keys].sort((a, b) => (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999)).map((k) => LABEL.get(k) ?? k);
}

/** One short line for Claude, per request and AFTER the cached system block (agent.ts systemText is
 *  one block shared by every company and must not change per company): which areas this account's
 *  plan leaves out, so Jack says so instead of offering them. Null when nothing is hidden. */
export function planLine(plan: ServerAccess | null | undefined): string | null {
  const areas = missingAreas(plan);
  if (!areas.length) return null;
  return [
    `This account's plan does not include: ${areas.join(", ")}.`,
    "You have no tools for those areas here, so don't offer that work. If the person asks for it, say it isn't part of their account's plan and that Structure Studio can add it. Everything else works as usual.",
  ].join("\n");
}
