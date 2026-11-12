// _shared/accessModules.ts — the catalogue of switchable tabs (migration 386, "plans as data").
//
// Ahsan, 2026-11-12: every tab selectable, plans he can add, edit and remove himself, and a new
// plan in 5 to 15 minutes. That only works if a plan is ROWS, so the split is:
//
//   CODE (this file)   the fixed list of tabs. One key per thing an operator would switch. A tab is
//                      code because a page is code: it exists or it does not.
//   DATA (386's tables) which tabs a plan includes, which plans a company is on, and the per-company
//                      exceptions. Nothing about a plan lives in code any more.
//
// The same list is in the database as public.access_modules, so a plan cannot be saved with a tab
// that does not exist (a foreign key refuses the typo). _test_stubs/accessModulesMirror_test.ts
// reads migration 386 and fails the push when this list and that table's rows differ: add a key in
// BOTH places, in one commit, with the migration that inserts the row.
//
// WHAT A STATE MEANS (public.access_resolve, the one copy of the rule):
//   on      the company has the tab.
//   locked  shown with a padlock and a "see Billing" card: a plan it holds teases it.
//   hidden  not offered.
//   off     an operator switched it off for this company, or the company's shape excludes it (it
//           sells no sheds). Hidden AND blocked; the data stays where it is.
//
// STAGE A: nothing reads this file but admin-catalog's plan actions, which use it to validate a tab
// key before a write. The routes, settings pages, server actions and Jack tools that belong to each
// key are added here by the stages that start enforcing them, not before.
//
// Dependency-free. Importers: admin-catalog (accessPlans.ts). Deploy it when this file changes.

export type AccessGroup = "hub" | "sheds" | "integrations" | "soon" | "beta";
export type AccessState = "on" | "locked" | "hidden" | "off";

export interface AccessModule {
  key: string;
  label: string;
  group: AccessGroup;
  /** Part of the shed product: a company that sells no sheds (364) never has it. */
  shed: boolean;
  sort: number;
}

// ⚠️ Keep in step with migration 386's `insert into public.access_modules` block.
export const ACCESS_MODULES: readonly AccessModule[] = [
  { key: "contacts", label: "Customer Hub: contacts", group: "hub", shed: false, sort: 10 },
  { key: "pipelines", label: "Pipelines", group: "hub", shed: false, sort: 20 },
  { key: "conversations", label: "Conversations", group: "hub", shed: false, sort: 30 },
  { key: "phone", label: "Calls and the phone", group: "hub", shed: false, sort: 40 },
  { key: "sms", label: "Business texting", group: "hub", shed: false, sort: 50 },
  { key: "email", label: "Email settings and templates", group: "hub", shed: false, sort: 60 },
  { key: "meetings", label: "Meetings", group: "hub", shed: false, sort: 70 },
  { key: "automations", label: "Automations", group: "hub", shed: false, sort: 80 },
  { key: "forms", label: "Forms", group: "hub", shed: false, sort: 90 },
  { key: "customer_login", label: "Customer login", group: "hub", shed: true, sort: 100 },
  { key: "jack", label: "Jack", group: "hub", shed: false, sort: 110 },
  { key: "designer", label: "Shed Designer", group: "sheds", shed: true, sort: 200 },
  { key: "advanced", label: "Advanced", group: "sheds", shed: true, sort: 210 },
  { key: "view_3d", label: "3D View", group: "sheds", shed: true, sort: 220 },
  { key: "inventory", label: "Inventory", group: "sheds", shed: true, sort: 230 },
  { key: "orders", label: "Orders", group: "sheds", shed: true, sort: 240 },
  { key: "build_schedule", label: "Build Schedule", group: "sheds", shed: true, sort: 250 },
  { key: "delivery_schedule", label: "Delivery Schedule", group: "sheds", shed: true, sort: 260 },
  { key: "repairs", label: "Repairs", group: "sheds", shed: true, sort: 270 },
  { key: "commissions", label: "Commissions", group: "sheds", shed: false, sort: 280 },
  { key: "rtp", label: "RealTime Pricing", group: "sheds", shed: true, sort: 290 },
  { key: "quickbooks", label: "QuickBooks", group: "integrations", shed: false, sort: 300 },
  { key: "ghl", label: "GHL connection", group: "integrations", shed: true, sort: 310 },
  { key: "payments", label: "Card payments", group: "integrations", shed: true, sort: 320 },
  { key: "tax", label: "Automatic sales tax", group: "integrations", shed: true, sort: 330 },
  { key: "reports", label: "Reports", group: "soon", shed: false, sort: 400 },
  { key: "projects", label: "Project Management", group: "soon", shed: false, sort: 410 },
  { key: "rent_to_own", label: "Rent to Own", group: "soon", shed: true, sort: 420 },
  { key: "self_serve_displays", label: "Self Serve Displays", group: "soon", shed: true, sort: 430 },
  { key: "smartbuild_sync", label: "SmartBuild Sync", group: "soon", shed: false, sort: 440 },
  { key: "support_ai", label: "Support assistant", group: "beta", shed: false, sort: 500 },
  { key: "library", label: "Library", group: "beta", shed: false, sort: 510 },
  { key: "door_looks", label: "Door looks from a photo", group: "beta", shed: false, sort: 520 },
];

export const ACCESS_MODULE_KEYS: readonly string[] = ACCESS_MODULES.map((m) => m.key);
const KEY_SET: ReadonlySet<string> = new Set(ACCESS_MODULE_KEYS);

/** Is `key` a tab in the catalogue? Checked before every write that names one. */
export function isAccessModule(key: unknown): key is string {
  return typeof key === "string" && KEY_SET.has(key);
}

/** What a plan may say about a tab. No row at all means hidden. */
export const PLAN_MODULE_STATES: readonly string[] = ["included", "teaser"];

/** The shape of a plan key and of a tab key: lower-case snake, 2 to 40 characters (386's CHECK). */
export const ACCESS_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** The plan a phone-only account (384) is read as holding. The resolver names it, so it cannot be
 *  made a draft: that would empty every phone-only account. */
export const PHONE_ONLY_PLAN = "phone_contacts";
