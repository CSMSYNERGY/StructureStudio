// _shared/accessActions.ts — which TAB a server action belongs to (plans as data, stage C).
//
// The edge functions already hold one table per function, action -> the access a PERSON needs
// (GATES, _shared/access.ts), and an action missing from its table is refused. This file turns that
// same table into "which tab of the product is this action part of", so that for a company on the
// tab map (accessEnforce.ts) an action whose tab the company has not got is refused in one place,
// resolveTenant, instead of in 362 remembered checks.
//
// HOW AN ACTION GETS ITS TAB
//   1. ACTION_MODULE[function][action], when the function names it. Used where one access area
//      covers several tabs: every Customer Hub action sits on `contacts` or `settings_crm`, and the
//      tab is pipelines, automations, forms, email templates or the inbox.
//   2. Otherwise the action's access area, through AREA_MODULE.
//   3. An "open" or "self" action (the portal's first call, a person's own profile) has no tab.
//
// ⚠️ BE CONSERVATIVE: WHEN IN DOUBT, NO TAB. A null here means "part of every account" or "shared by
// too many pages to block", and it changes nothing for anyone. A wrong tab refuses a company
// something it has always been able to do, the moment its server switch is turned on. So an area is
// mapped only when every action on it is clearly one page's:
//   * `designs` (a customer's saved designs and estimates) is NOT mapped: the Customer Hub's own
//     record reads a contact's design history, with or without the Designer.
//   * `settings_email` is NOT mapped: a shed builder with no Customer Hub sends estimates and
//     invoices from their own domain through these actions.
//   * `settings_crm` is NOT mapped by area: besides the Customer Hub it carries the GHL connection
//     and the sales tax settings. Its crm_* actions are mapped one by one below.
//   * `phone` is NOT mapped: the phone's settings actions answer today whether or not calling is
//     switched on, because they are HOW it gets switched on (an operator opens a builder's Phone
//     page and turns it on; self-serve is the same page later). Refusing them to a company without
//     the phone tab would make the tab impossible to start. What a company without the phone must
//     not do is CALL, and that is the phone Worker's check (phone_status, and the tab in stage D).
//   * `settings_branding`, `settings_team`, `settings_billing`, `reports`, `projects`: every account.
//
// AN ACTION ON SEVERAL AREAS
//   `any` gate (a payload two pages share): allowed when the company has ANY of the tabs. The Orders
//         page asks the scheduler whether a building is scheduled, and must not be refused for it by
//         a company that has only one of the two boards.
//   `all` gate (an action whose side effects cross areas): the tab is the FIRST area's that has
//         one. The first area is the page the action lives on; the others are what it also touches.
//
// _test_stubs/accessActions_test.ts reads every function's GATES table from the shipped source and
// fails the push when an action resolves to a tab that is not in the catalogue, or when a Customer
// Hub action is not named here.
//
// Dependency-free apart from the catalogue. Importers: resolveTenant.ts, featureCheck.ts.

import type { Gate } from "./access.ts";
import { isAccessModule } from "./accessModules.ts";

/** A person's access area -> the tab every action on it belongs to. null = no tab. */
export const AREA_MODULE: Readonly<Record<string, string | null>> = {
  designer: "designer",
  price_override: "designer",
  jack: "jack",
  designs: null,
  contacts: "contacts",
  inventory: "inventory",
  orders: "orders",
  change_orders: "orders",
  change_order_approve: "orders",
  build_schedule: "build_schedule",
  delivery_schedule: "delivery_schedule",
  repairs: "repairs",
  commissions: "commissions",
  reports: null,
  meetings: "meetings",
  phone: null,
  projects: null,
  settings_structures: "designer",
  settings_options: "designer",
  settings_branding: null,
  settings_crm: null,
  settings_quickbooks: "quickbooks",
  settings_email: null,
  settings_team: null,
  settings_billing: null,
};

type Tabs = string | readonly string[] | null;

// The Customer Hub's actions in portal-settings, by what they are part of.
const HUB_PIPELINES = [
  "crm_pipelines_list", "crm_deals_list", "crm_contact_deals", "crm_create_lead", "crm_import_leads",
  "crm_deal_create", "crm_deal_update", "crm_deal_move", "crm_deal_mark_lost", "crm_deal_reopen", "crm_deal_archive",
  "crm_deal_custom_save", "crm_deal_set_status", "crm_deal_account_summary", "crm_account_options",
  "crm_deal_account_link", "crm_deal_account_unlink",
  "crm_pipeline_save", "crm_pipeline_add_starter", "crm_stage_save", "crm_stages_reorder", "crm_status_save", "crm_statuses_reorder",
];
const HUB_AUTOMATIONS = ["crm_rules_list", "crm_rule_audience", "crm_rules_time_zone", "crm_rule_save", "crm_rules_reorder", "crm_rule_log"];
const HUB_FORMS = [
  "crm_forms_list", "crm_form_get", "crm_form_submissions", "crm_form_stats", "crm_form_create", "crm_form_save",
  "crm_form_publish", "crm_form_unpublish", "crm_form_duplicate", "crm_form_archive", "crm_form_delete",
  "crm_form_upload_url", "crm_form_test_email",
];
const HUB_EMAIL = [
  "crm_email_tpl_list", "crm_email_tpl_get", "crm_email_tpl_preview", "crm_email_tpl_create", "crm_email_tpl_save",
  "crm_email_tpl_duplicate", "crm_email_tpl_delete", "crm_email_tpl_test",
];
// The contact list and one contact's record: what a phone-only account has too (accountShape.ts).
const HUB_CONTACTS = [
  "crm_record", "crm_feed", "crm_create_contact", "crm_save_contact", "crm_contact_custom_save", "crm_import_ghl_contacts",
  "crm_fields_list", "crm_field_create", "crm_field_save", "crm_field_delete", "crm_fields_reorder", "crm_builtin_field_save",
  "crm_save_note", "crm_delete_note", "crm_save_activity", "crm_complete_activity", "crm_contact_tag", "crm_contact_dnd",
  "crm_record_consent", "crm_file_sign", "crm_file_attach", "crm_file_delete", "crm_send_sms", "crm_send_email", "crm_customer_facts",
];
const tabFor = (tab: string, actions: readonly string[]): Record<string, string> => Object.fromEntries(actions.map((a) => [a, tab]));

/** Per function: the actions whose tab is not simply their area's. null = deliberately no tab. */
export const ACTION_MODULE: Readonly<Record<string, Readonly<Record<string, Tabs>>>> = {
  "portal-settings": {
    ...tabFor("pipelines", HUB_PIPELINES),
    ...tabFor("automations", HUB_AUTOMATIONS),
    ...tabFor("forms", HUB_FORMS),
    ...tabFor("email", HUB_EMAIL),
    ...tabFor("contacts", HUB_CONTACTS),
    crm_inbox: "conversations",
    // RealTime Pricing's own actions sit on settings_structures; they are the RealTime Pricing tab.
    rtp_data: "rtp", save_rtp_bom: "rtp", save_rtp_material: "rtp", delete_rtp_material: "rtp",
    reorder_rtp_materials: "rtp", save_rtp_overhead: "rtp", set_rtp_enabled: "rtp", import_rtp_workbook: "rtp",
    // The catalogue read both the Designer's settings and its options pages share: no tab, the
    // public designer and the Customer Hub's design list read styles too.
    catalog: null,
    // Deleting a lot building also deletes its design: the building is the page.
    delete_inventory: "inventory",
    // A location is shared by Branding and Inventory.
    list_locations: null,
  },
  "portal-sms": {
    // "Is texting set up for this business?" Asked by more than the Customer Hub (it sits on the
    // contacts area only because a rep needs to read it), and it reveals nothing but a status.
    status: null,
  },
  // jack-agent needs no entry: every action but `enabled` is on the `jack` area, and `enabled` is
  // "open" on purpose (the portal asks it for every builder to learn whether to draw Jack at all).
};

/** The billing features the server checks today, and the tabs that answer for each on the map:
 *  a company "has the feature" when it has ANY of them, and resolveTenant then decides tab by tab. */
export const FEATURE_MODULES: Readonly<Record<string, readonly string[]>> = {
  crm: ["contacts", "pipelines", "conversations", "sms", "email", "meetings", "automations", "forms"],
  schedule_builds: ["build_schedule", "delivery_schedule", "repairs"],
  quickbooks_sync: ["quickbooks"],
  on_demand_pricing: ["rtp"],
  view_3d: ["view_3d"],
};

/** The tabs an action belongs to: [] = none (never refused by a plan). Allowed when ANY is on. */
export function modulesForAction(fn: string, action: string, gate: Gate | undefined): string[] {
  const table = ACTION_MODULE[fn];
  if (table && Object.prototype.hasOwnProperty.call(table, action)) {
    const t = table[action];
    return t === null ? [] : (typeof t === "string" ? [t] : [...t]);
  }
  if (!gate || gate === "open" || gate === "self") return [];
  // deno-lint-ignore no-explicit-any
  const g = gate as any;
  const tabOf = (n: { area?: unknown }): string | null => AREA_MODULE[String(n?.area ?? "")] ?? null;
  if (Array.isArray(g.all)) {
    const first = (g.all as { area?: unknown }[]).map(tabOf).find((m): m is string => typeof m === "string");
    return first ? [first] : [];
  }
  const list: { area?: unknown }[] = Array.isArray(g.any) ? g.any : [g];
  return [...new Set(list.map(tabOf).filter((m): m is string => typeof m === "string"))];
}

/** Every tab key this file names. The test holds each one to the catalogue. */
export function namedModules(): string[] {
  const out = new Set<string>();
  for (const m of Object.values(AREA_MODULE)) if (m) out.add(m);
  for (const t of Object.values(ACTION_MODULE)) {
    for (const v of Object.values(t)) {
      if (typeof v === "string") out.add(v);
      else if (v) for (const k of v) out.add(k);
    }
  }
  for (const list of Object.values(FEATURE_MODULES)) for (const k of list) out.add(k);
  return [...out];
}

/** True when every tab this file names is a catalogue tab. Used at module load by nothing; the test calls it. */
export function namedModulesAreKnown(): boolean {
  return namedModules().every((m) => isAccessModule(m));
}
