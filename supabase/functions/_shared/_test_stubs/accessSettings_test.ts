// PLANS AS DATA ON THE SERVER, END TO END THROUGH THE SHIPPED portal-settings HANDLER
// (migrations 386 to 388; _shared/accessEnforce.ts, accessActions.ts, resolveTenant.ts, featureCheck.ts).
//
// portal-settings is where most of the product's actions live and where three older rules already
// sit in front of them: the Customer Hub subscription check on every crm_* action, the RealTime
// Pricing and QuickBooks subscription checks, and the phone-only allow-list. The plan check has to
// work WITH those, in both directions:
//
//   * a tab a plan gives with no subscription behind it must open (a custom plan with the contact
//     list and nothing else of the Customer Hub is the first thing this was built for), and
//   * a tab a plan does not give must be refused even when a subscription would have opened it.
//
// And for a company that is not on the map, or only being watched (report), every answer is the one
// the old rules give. Tenants are made up (public repo).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubPlanRead, stubRpc } from "./supabase_stub.ts";
import { MODULE_REFUSAL } from "../accessEnforce.ts";
import { PHONE_ONLY_REFUSAL } from "../accountShape.ts";
import { ACCESS_MODULE_KEYS } from "../accessModules.ts";

const ENV: Record<string, string> = { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
try {
  await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
} finally {
  (Deno as any).serve = realServe;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
}
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const T = "harness-builder";
const OTHER = "harness-viewed";
type World = {
  access?: unknown;            // access_for_server's answer; undefined = not named (null)
  paid?: string[];             // billing features with an active subscription
  phoneOnly?: boolean;
  operator?: boolean;
};

function answer(world: World, table: string, ops: any[][], reports: any[]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const sel = String((ops.find((o) => o[0] === "select") ?? [])[1] ?? "");
  const eq = (col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
  const one = has("maybeSingle") || has("single");
  if (table === "client_users") return { data: world.operator ? [] : [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1" }], error: null };
  if (table === "app_operators") return { data: world.operator ? { user_id: "u1", email: "op@example.test", can_write: true, can_bill: true, support_only: false } : null, error: null };
  if (table === "client_configs") return { data: { client_id: eq("client_id") ?? OTHER }, error: null };
  if (table === "client_settings" && sel === "phone_only") return { data: { phone_only: world.phoneOnly === true }, error: null };
  if (table === "client_settings") return { data: one ? { internal_account: false, billing_exempt: false } : [], error: null };
  if (table === "billing_plans") {
    const want: string[] = ((ops.find((o) => o[0] === "in" && o[1] === "feature") ?? [])[2] as string[]) ?? [];
    return { data: want.map((f) => ({ id: `${f}_monthly`, feature: f, billing_interval: "monthly" })), error: null };
  }
  if (table === "billing_subscriptions") {
    return { data: (world.paid ?? []).map((f) => ({ plan_id: `${f}_monthly`, status: "active", current_period_end: "2099-01-01T00:00:00Z" })), error: null };
  }
  if (table === "app_errors") {
    const row = (ops.find((o) => o[0] === "insert") ?? [])[1];
    if (row) reports.push(row);
    return { data: null, error: null };
  }
  // Every other table: empty. These cases are about who gets past the gates, not what is behind them.
  return { data: one ? null : [], error: null, count: 0 };
}
function chain(world: World, table: string, ops: any[][], reports: any[]): any {
  const next = (op: any[]) => chain(world, table, [...ops, op], reports);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or",
    "limit", "range", "order", "ilike", "contains", "overlaps", "filter", "match", "single", "maybeSingle", "returns", "abortSignal"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, table, ops, reports)).then(ok, bad);
  return q;
}

const CRM_REFUSAL = /The Customer Hub is not part of your subscription/;
type Verdict = "plan" | "crm" | "phone_only" | "other_403" | "through";
async function drive(action: string, world: World = {}): Promise<{ verdict: Verdict; status: number; body: any; reports: any[] }> {
  const reports: any[] = [];
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, table, [], reports);
  stubPlanRead.on = true;
  stubRpc.rpc = (fn: string) => {
    const data = fn === "access_for_server" ? (world.access ?? null) : fn === "resolve_caller" ? null : [];
    const q: any = { then: (ok: any, bad: any) => Promise.resolve({ data, error: null }).then(ok, bad) };
    for (const m of ["select", "eq", "single", "maybeSingle", "limit"]) q[m] = () => q;
    return q;
  };
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(world.operator ? { action, targetClientId: OTHER } : { action }),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    await new Promise((r) => setTimeout(r, 5));
    const err = String(body?.error ?? "");
    const verdict: Verdict = res.status !== 403 ? "through"
      : body?.code === "module_off" ? "plan"
      : err === PHONE_ONLY_REFUSAL ? "phone_only"
      : CRM_REFUSAL.test(err) ? "crm"
      : "other_403";
    return { verdict, status: res.status, body, reports: reports.filter((r) => r && r.code === "module_would_refuse") };
  } finally {
    [console.error, console.warn, console.log] = quiet;
    stubDb.from = null;
    stubRpc.rpc = null;
    stubPlanRead.on = false;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const tabs = (on: string[], other: Record<string, string> = {}) =>
  ({ ...Object.fromEntries(ACCESS_MODULE_KEYS.map((k) => [k, "hidden"])), ...Object.fromEntries(on.map((k) => [k, "on"])), ...other });
const block = (on: string[], other: Record<string, string> = {}) => ({ mode: "block", modules: tabs(on, other) });
const report = (on: string[], other: Record<string, string> = {}) => ({ mode: "report", modules: tabs(on, other) });
const verdictOf = async (action: string, world: World) => (await drive(action, world)).verdict;

// ── not on the map: the old rules, unchanged ────────────────────────────────────────────────
Deno.test("not on the map: the Customer Hub is opened by its subscription and refused without it, as before", async () => {
  assertEquals(await verdictOf("crm_record", {}), "crm");
  assertEquals(await verdictOf("crm_pipelines_list", {}), "crm");
  assertEquals(await verdictOf("crm_record", { paid: ["crm"] }), "through");
  assertEquals(await verdictOf("crm_pipelines_list", { paid: ["crm"] }), "through");
  for (const a of ["status", "catalog", "list_inventory", "orders_overview"]) assertEquals(await verdictOf(a, {}), "through", a);
});

// ── block: a plan gives a tab with no subscription behind it ────────────────────────────────
Deno.test("block: a plan with the contact list and nothing else of the Customer Hub opens exactly that", async () => {
  const w: World = { access: block(["contacts"]) };       // no crm subscription at all
  for (const a of ["crm_record", "crm_save_contact", "crm_save_note", "crm_fields_list", "contact_activity"]) assertEquals(await verdictOf(a, w), "through", a);
  for (const a of ["crm_pipelines_list", "crm_deal_move", "crm_inbox", "crm_rule_save", "crm_forms_list", "crm_email_tpl_list"]) assertEquals(await verdictOf(a, w), "plan", a);
  // …and the rest of the product it was not given.
  for (const a of ["list_inventory", "orders_overview", "create_style", "save_colors", "qbo_status", "rtp_data"]) assertEquals(await verdictOf(a, w), "plan", a);
  // The phone's settings are never refused by a plan: they are how an operator switches a phone on.
  assertEquals(await verdictOf("phone_settings_get", w), "through");
  // The calls every account makes are never refused by a plan.
  for (const a of ["status", "save_profile", "get_profile", "save_branding", "email_status", "tax_settings"]) {
    const v = await verdictOf(a, w);
    assert(v !== "plan" && v !== "crm", `${a}: ${v}`);
  }
});

Deno.test("block: the whole Customer Hub by plan, with no subscription, opens the boards, the inbox and its settings", async () => {
  const w: World = { access: block(["contacts", "pipelines", "conversations", "automations", "forms", "email"]) };
  for (const a of ["crm_record", "crm_pipelines_list", "crm_deal_move", "crm_inbox", "crm_rule_save", "crm_forms_list", "crm_email_tpl_list"]) assertEquals(await verdictOf(a, w), "through", a);
});

Deno.test("block: QuickBooks and RealTime Pricing open by their tab, with no subscription", async () => {
  assertEquals(await verdictOf("qbo_status", { access: block(["quickbooks"]) }), "through");
  assertEquals(await verdictOf("qbo_status", { access: block(["designer"]) }), "plan");
  const rtpOn = await drive("rtp_data", { access: block(["designer", "rtp"]) });
  assertEquals(rtpOn.verdict, "through", JSON.stringify(rtpOn.body));
  assertEquals(await verdictOf("rtp_data", { access: block(["designer"]) }), "plan");
});

// ── block: a plan does NOT give a tab the company pays for, or an operator switched it off ───
Deno.test("block: a tab switched off is refused even with the subscription that used to open it", async () => {
  const w: World = { access: block(["pipelines"], { contacts: "off" }), paid: ["crm"] };
  assertEquals(await verdictOf("crm_record", w), "plan");
  assertEquals(await verdictOf("crm_pipelines_list", w), "through");
  // Locked (a padlock in the rail) is refused too.
  assertEquals(await verdictOf("qbo_status", { access: block(["designer"], { quickbooks: "locked" }), paid: ["quickbooks_sync"] }), "plan");
});

Deno.test("block: the refusal names the plan, and follows the company for an operator viewing it", async () => {
  const r = await drive("list_inventory", { access: block(["contacts"]) });
  assertEquals([r.status, r.body.code, r.body.error], [403, "module_off", MODULE_REFUSAL]);
  assertEquals(await verdictOf("list_inventory", { access: block(["contacts"]), operator: true }), "plan");
  assertEquals(await verdictOf("list_inventory", { access: block(["inventory"]), operator: true }), "through");
});

// ── a phone-only account on the map ─────────────────────────────────────────────────────────
Deno.test("a phone-only account on the map keeps its own rule first, and its own tabs open", async () => {
  const w: World = { phoneOnly: true, access: block(["contacts", "phone", "sms"]) };
  for (const a of ["crm_record", "crm_save_contact", "phone_settings_get", "status", "save_profile"]) assertEquals(await verdictOf(a, w), "through", a);
  for (const a of ["catalog", "list_inventory", "crm_pipelines_list", "qbo_status"]) assertEquals(await verdictOf(a, w), "phone_only", a);
});

// ── report: nothing changes, and it is written down ─────────────────────────────────────────
Deno.test("report: every answer is the old one, and what the map would have refused is filed", async () => {
  // No subscription: the Customer Hub is refused by the OLD rule, whatever the map says.
  assertEquals(await verdictOf("crm_record", { access: report(["contacts"]) }), "crm");
  // With the subscription and a map that lacks the boards: still through, and reported once.
  const w: World = { access: report(["contacts"]), paid: ["crm"] };
  const first = await drive("crm_deals_list", w);
  assertEquals([first.verdict, first.reports.length], ["through", 1], JSON.stringify(first.reports));
  assertEquals([first.reports[0].severity, first.reports[0].source, first.reports[0].client_id, first.reports[0].context.tabs], ["info", "edge:portal-settings", T, ["pipelines"]]);
  const again = await drive("crm_deals_list", w);
  assertEquals([again.verdict, again.reports.length], ["through", 0]);
  // A tab the company has: nothing filed.
  assertEquals((await drive("crm_feed", w)).reports.length, 0);
  // A page with no tab: nothing filed.
  assertEquals((await drive("status", w)).reports.length, 0);
});
