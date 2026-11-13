// WHICH TAB A SERVER ACTION BELONGS TO (_shared/accessActions.ts, plans as data stage C), held
// against every function's own gate table, read from the SHIPPED source.
//
// For a company whose server switch is on, resolveTenant refuses an action whose tab the company
// has not got. The tab comes from the action's access area (AREA_MODULE) or, where one area covers
// several tabs, from a named entry (ACTION_MODULE). A wrong tab is not a crash: it is a company
// refused something it has always been able to do. So this file pins:
//
//   1. every tab the mapping names is a catalogue tab, and every access area has a decision;
//   2. every Customer Hub action is named (its areas, contacts and settings_crm, cannot say which
//      of six tabs it is), and no named action has gone stale;
//   3. a company that has EVERYTHING sold today is refused nothing but Jack, which his own switch
//      already refuses; and what a base-plan shed builder newly loses is exactly the scheduling
//      function's actions and nothing else;
//   4. a phone-only account's own allow-list resolves only to the tabs its plan includes;
//   5. each function tells resolveTenant its own name.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ACTION_MODULE, AREA_MODULE, FEATURE_MODULES, modulesForAction, namedModules } from "../accessActions.ts";
import { ACCESS_MODULE_KEYS, isAccessModule } from "../accessModules.ts";
import { AREA_KEYS, type Gate, type GateTable } from "../access.ts";
import { PHONE_ONLY_PORTAL_SETTINGS } from "../accountShape.ts";
import { anyModuleOn } from "../accessEnforce.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");

/** A function's GATES table, evaluated from its source: the object literal, with the few constants
 *  it names (`const X = { area: ..., level: ... }`) resolved from the same file. */
async function gatesOf(file: string): Promise<GateTable> {
  const src = await read(`../../${file}`);
  const start = src.search(/(?:export )?const GATES: GateTable = \{/);
  assert(start >= 0, `${file}: no GATES table found. Re-point this test.`);
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === '"') { i = src.indexOf('"', i + 1); continue; }
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end > open, `${file}: the GATES table does not close.`);
  // The tables are plain object literals apart from `as const` on a few level strings and constants.
  const plain = (code: string) => code.replace(/\s+as\s+const\b/g, "");
  const literal = plain(src.slice(open, end + 1));
  const consts = [...new Set([...literal.matchAll(/:\s*([A-Z][A-Z0-9_]{1,})\s*[,}]/g)].map((m) => m[1]))];
  let prelude = "";
  for (const name of consts) {
    const m = new RegExp(`const ${name}(?::[^=]+)? = (\\{[^;]*\\})(?:\\s+as\\s+const)?;`).exec(src);
    assert(m, `${file}: GATES names ${name}, and its one-line definition was not found.`);
    prelude += `const ${name} = ${plain(m[1])};\n`;
  }
  return new Function(`${prelude}return ${literal};`)() as GateTable;
}

const FUNCTIONS: Record<string, string> = {
  "portal-settings": "portal-settings/index.ts",
  "portal-schedule": "portal-schedule/index.ts",
  "portal-meetings": "portal-meetings/index.ts",
  "portal-sms": "portal-sms/index.ts",
  "portal-billing": "portal-billing/index.ts",
  "portal-payments": "portal-payments/index.ts",
  "sync-design-status": "sync-design-status/index.ts",
  "support-agent": "support-agent/index.ts",
  "jack-agent": "jack-agent/handler.ts",
};
const GATES: Record<string, GateTable> = {};
for (const [fn, file] of Object.entries(FUNCTIONS)) GATES[fn] = await gatesOf(file);
GATES["qbo-oauth-connect"] = { status: { area: "settings_quickbooks", level: "edit" } } as GateTable;

const tabsOf = (fn: string, action: string) => modulesForAction(fn, action, GATES[fn][action] as Gate);
const every = () => Object.entries(GATES).flatMap(([fn, t]) => Object.keys(t).map((a) => [fn, a] as const));

Deno.test("the reader found every function's table", () => {
  const n = Object.fromEntries(Object.entries(GATES).map(([fn, t]) => [fn, Object.keys(t).length]));
  assert(n["portal-settings"] >= 240, JSON.stringify(n));
  assert(n["portal-schedule"] >= 30 && n["portal-meetings"] >= 9 && n["portal-sms"] >= 8 && n["jack-agent"] >= 14, JSON.stringify(n));
  assert(every().length >= 340, `only ${every().length} actions read`);
});

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("every tab the mapping names is in the catalogue, and every access area has a decision", () => {
  for (const m of namedModules()) assert(isAccessModule(m), `"${m}" is not a catalogue tab`);
  for (const [fn, a] of every()) for (const m of tabsOf(fn, a)) assert(isAccessModule(m), `${fn}.${a} resolves to "${m}", not a catalogue tab`);
  assertEquals(Object.keys(AREA_MODULE).sort(), [...AREA_KEYS].sort(), "AREA_MODULE and the access areas differ: a new area needs a decision here (a tab, or null)");
  for (const f of Object.keys(FEATURE_MODULES)) assert(FEATURE_MODULES[f].length > 0, f);
});

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("every Customer Hub action is named, and no named action is stale", () => {
  const named = ACTION_MODULE["portal-settings"];
  const hub = Object.keys(GATES["portal-settings"]).filter((a) => a.startsWith("crm_"));
  assert(hub.length >= 70, `only ${hub.length} crm_ actions read`);
  const missing = hub.filter((a) => !Object.prototype.hasOwnProperty.call(named, a));
  assertEquals(missing, [], "a Customer Hub action has no tab: add it to ACTION_MODULE['portal-settings']");
  for (const [fn, table] of Object.entries(ACTION_MODULE)) {
    assert(GATES[fn], `ACTION_MODULE names a function this test does not read: ${fn}`);
    const stale = Object.keys(table).filter((a) => !Object.prototype.hasOwnProperty.call(GATES[fn], a));
    assertEquals(stale, [], `${fn}: ACTION_MODULE names actions its gate table no longer has`);
  }
});

Deno.test("the mapping, action by action, for the ones that matter most", () => {
  const want: [string, string, string[]][] = [
    ["portal-settings", "status", []], ["portal-settings", "save_profile", []], ["portal-settings", "save", []],
    ["portal-settings", "catalog", []], ["portal-settings", "email_status", []], ["portal-settings", "save_branding", []],
    ["portal-settings", "tax_settings", []], ["portal-settings", "delete_design", []], ["portal-settings", "list_locations", []],
    ["portal-settings", "crm_record", ["contacts"]], ["portal-settings", "contact_activity", ["contacts"]],
    ["portal-settings", "crm_inbox", ["conversations"]], ["portal-settings", "crm_deal_move", ["pipelines"]],
    ["portal-settings", "crm_rule_save", ["automations"]], ["portal-settings", "crm_form_publish", ["forms"]],
    ["portal-settings", "crm_email_tpl_save", ["email"]], ["portal-settings", "crm_fields_list", ["contacts"]],
    // The phone's settings are how it gets switched on: never refused by a plan (accessActions.ts).
    ["portal-settings", "phone_settings_get", []], ["portal-settings", "phone_status_set", []], ["portal-settings", "phone_buy_number", []],
    ["portal-settings", "list_inventory", ["inventory"]], ["portal-settings", "delete_inventory", ["inventory"]],
    ["portal-settings", "orders_overview", ["orders"]], ["portal-settings", "send_change_order", ["orders"]],
    ["portal-settings", "text_sign_link", ["orders"]],
    ["portal-settings", "create_style", ["designer"]], ["portal-settings", "save_colors", ["designer"]],
    ["portal-settings", "rtp_data", ["rtp"]], ["portal-settings", "set_rtp_enabled", ["rtp"]],
    ["portal-settings", "qbo_status", ["quickbooks"]], ["qbo-oauth-connect", "status", ["quickbooks"]],
    ["portal-schedule", "build_board", ["build_schedule"]],
    ["portal-meetings", "overview", ["meetings"]], ["portal-meetings", "contact_meetings", ["meetings"]],
    ["portal-sms", "status", []], ["portal-sms", "save_intake", []],
    ["portal-payments", "charge", ["orders"]], ["portal-billing", "status", []],
    ["jack-agent", "enabled", []], ["jack-agent", "send", ["jack"]], ["jack-agent", "sheet_start", ["jack"]],
    ["jack-agent", "proposal_approve", ["jack"]],
    // The record of what Jack did, and the way back out of it: never refused at Jack's door (stage D).
    // An Undo's put-back is still a save behind another door, which keeps its tab: accessActions.ts.
    ["jack-agent", "status", []], ["jack-agent", "activity", []], ["jack-agent", "proposal_get", []],
    ["jack-agent", "proposal_cancel", []], ["jack-agent", "proposal_undo", []],
    ["support-agent", "status", []],
  ];
  for (const [fn, a, tabs] of want) {
    assert(Object.prototype.hasOwnProperty.call(GATES[fn], a), `${fn} has no action ${a}: re-point this test`);
    assertEquals(tabsOf(fn, a), tabs, `${fn}.${a}`);
  }
  // An action two boards share is allowed with either.
  const shared = Object.keys(GATES["portal-schedule"]).filter((a) => tabsOf("portal-schedule", a).length > 1);
  assert(shared.length >= 1, "no scheduling action is shared by two boards any more: re-point this test");
});

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────
const map = (onKeys: string[], lockedKeys: string[] = []): Record<string, string> => ({
  ...Object.fromEntries(ACCESS_MODULE_KEYS.map((k) => [k, "hidden"])),
  ...Object.fromEntries(lockedKeys.map((k) => [k, "locked"])),
  ...Object.fromEntries(onKeys.map((k) => [k, "on"])),
});
const BASE = ["designer", "inventory", "orders", "commissions", "ghl", "customer_login"];
const HUB = ["contacts", "pipelines", "conversations", "sms", "email", "meetings", "automations", "forms"];
const SCHED = ["build_schedule", "delivery_schedule", "repairs"];
const refused = (m: Record<string, string>) => every().filter(([fn, a]) => { const t = tabsOf(fn, a); return t.length > 0 && !anyModuleOn(m, t); });

Deno.test("a company with everything sold today is refused nothing but Jack", () => {
  const suite = map([...BASE, ...HUB, ...SCHED, "view_3d", "quickbooks", "rtp"]);
  const lost = refused(suite);
  const tabs = new Set(lost.flatMap(([fn, a]) => tabsOf(fn, a)));
  // Jack's NEW work is refused today too, by his own switch (jack-agent's handler asks jack_on before a
  // turn, a price list or an approve). What his switch never refused, the plan does not either: the
  // record of what he did, dismissing a card, and Undo (ACTION_MODULE["jack-agent"]).
  assertEquals([...tabs].sort(), ["jack"], `refused: ${lost.slice(0, 12).map((x) => x.join(".")).join(", ")}`);
  assert(lost.every(([fn]) => fn === "jack-agent"), "something outside jack-agent is refused");
  const lostJack = lost.map(([, a]) => a);
  for (const a of ["status", "activity", "proposal_get", "proposal_cancel", "proposal_undo", "enabled"]) {
    assert(!lostJack.includes(a), `a company without the Jack tab is refused ${a}: it could not read or undo what Jack already did`);
  }
  for (const a of ["send", "sheet_start", "proposal_approve"]) assert(lostJack.includes(a), `${a} is new work and must need the Jack tab`);
  // …and with his switch on, nothing at all.
  assertEquals(refused(map([...BASE, ...HUB, ...SCHED, "view_3d", "quickbooks", "rtp", "jack"])), []);
});

Deno.test("the phone's settings actions are never refused by a plan: they are how the phone is switched on", () => {
  const nothing = map([]);
  const phone = Object.keys(GATES["portal-settings"]).filter((a) => a.startsWith("phone_"));
  assert(phone.length >= 12, `only ${phone.length} phone actions read`);
  for (const a of phone) assertEquals(tabsOf("portal-settings", a), [], a);
  assert(!refused(nothing).some(([fn, a]) => fn === "portal-settings" && a.startsWith("phone_")));
});

Deno.test("a base-plan shed builder: what the server newly refuses is the scheduling function, and nothing else", () => {
  const base = map(BASE, ["contacts", "build_schedule", "delivery_schedule", "repairs", "view_3d", "quickbooks", "rtp"]);
  const lost = refused(base);
  // Today's server already refuses these to a company without the subscription or the switch:
  // the Customer Hub (crm_* and meetings), QuickBooks, RealTime Pricing, Jack and the phone.
  const alreadyRefusedTabs = new Set(["contacts", "pipelines", "conversations", "automations", "forms", "email", "meetings", "quickbooks", "rtp", "jack"]);
  const fresh = lost.filter(([fn, a]) => !tabsOf(fn, a).every((t) => alreadyRefusedTabs.has(t)));
  assert(fresh.length > 0, "nothing new is refused: re-point this test");
  assertEquals([...new Set(fresh.map(([fn]) => fn))], ["portal-schedule"], `new refusals outside the scheduler: ${fresh.filter(([fn]) => fn !== "portal-schedule").map((x) => x.join(".")).join(", ")}`);
  // Nothing on a page the company HAS is refused.
  for (const [fn, a] of lost) for (const t of tabsOf(fn, a)) assert(base[t] !== "on", `${fn}.${a} is refused though ${t} is on`);
});

Deno.test("locked is refused: a padlock is an offer, not access", () => {
  const m = map(BASE, ["quickbooks"]);
  assert(refused(m).some(([fn, a]) => fn === "portal-settings" && a === "qbo_status"));
});

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("a phone-only account's own allow-list resolves only to tabs its plan includes", () => {
  const plan = new Set(["contacts", "phone", "sms"]);     // migration 386's phone_contacts (its phone actions carry no tab at all)
  for (const a of PHONE_ONLY_PORTAL_SETTINGS) {
    assert(Object.prototype.hasOwnProperty.call(GATES["portal-settings"], a), `the phone-only list names ${a}, which portal-settings does not have`);
    for (const t of tabsOf("portal-settings", a)) assert(plan.has(t), `a phone-only account may call ${a}, but its plan has no "${t}" tab`);
  }
});

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────
Deno.test("each function tells resolveTenant its own name, and resolveTenant asks once, after the phone-only rule", async () => {
  for (const [fn, file] of [...Object.entries(FUNCTIONS), ["qbo-oauth-connect", "qbo-oauth-connect/index.ts"]]) {
    const src = await read(`../../${file}`);
    // In the resolveTenant call itself (other code in these files names the function too, for logs).
    const call = new RegExp(`resolveTenant\\(req, admin, \\{[^;]{0,900}?\\bfn: "([a-z-]+)"`).exec(src);
    assert(call, `${file} does not pass fn to resolveTenant`);
    assertEquals(call![1], fn, `${file} passes another function's name to resolveTenant`);
  }
  const rt = await read("../resolveTenant.ts");
  const phone = rt.indexOf("return { ok: false, status: 403, body: { error: PHONE_ONLY_REFUSAL } };");
  const plan = rt.indexOf('return { ok: false, status: 403, body: { error: MODULE_REFUSAL, code: "module_off" } };');
  assert(phone > 0 && plan > phone, "the plan refusal is gone, or no longer comes after the phone-only one");
  assert(rt.includes("if (opts.fn && opts.gates) {"), "resolveTenant no longer needs BOTH a name and a gate table before it asks");
  assert(rt.includes('if (acc.mode === "block") {'), "report mode can refuse");
});
