// A PHONE-ONLY ACCOUNT (migration 384), server side: _shared/accountShape.ts's rules, and the two
// places they are enforced, driven through the SHIPPED portal-settings handler.
//
// Carolyn, 2026-11-10: "So it'll say customer hub, but all they have access to is contacts."
//
//   1. resolveTenant refuses a phone-only account every action outside its function's allow-list
//      (deny by default), for its own login and for an operator viewing it.
//   2. portal-settings gives a phone-only account the CONTACT actions without the Customer Hub
//      subscription, and nothing else of the CRM.
//   3. Neither touches anybody else: an ordinary builder gets exactly what it got before 384, and a
//      lost read of the flag means "not phone-only" (refuses nothing, grants nothing).
//
// HOW: deleteDesignWiring_test's idiom. Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the real branches; the import
// map swaps supabase-js for supabase_stub.ts and every table read lands in the fake below. Tenants
// and people are made up: the repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import {
  accountTypeOf,
  PHONE_ONLY_CONTACT_ACTIONS,
  PHONE_ONLY_PORTAL_SETTINGS,
  PHONE_ONLY_REFUSAL,
  phoneOnlyAllows,
  phoneOnlyOf,
} from "../accountShape.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");

// ─── The rules, pure ───────────────────────────────────────────────────────────────────────────
Deno.test("the allow-list helper: 'all', a set, and nothing (deny by default)", () => {
  assert(phoneOnlyAllows("all", "anything"));
  assert(phoneOnlyAllows(new Set(["status"]), "status"));
  assert(!phoneOnlyAllows(new Set(["status"]), "catalog"));
  assert(!phoneOnlyAllows(undefined, "status"), "a function that names nothing refuses a phone-only account everything");
});

Deno.test("the account type: phone wins, then an explicit sheds_enabled false, else a shed builder", () => {
  assertEquals(accountTypeOf({ phone_only: true, sheds_enabled: true }), "phone");
  assertEquals(accountTypeOf({ phone_only: true, sheds_enabled: false }), "phone");
  assertEquals(accountTypeOf({ phone_only: false, sheds_enabled: false }), "smartbuild");
  assertEquals(accountTypeOf({ sheds_enabled: null }), "sheds");
  assertEquals(accountTypeOf(null), "sheds");
});

const flagAdmin = (answer: { data?: any; error?: any } | "throw") => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
    if (answer === "throw") throw new Error("network");
    return answer;
  } }) }) }),
});
Deno.test("the flag reads only an explicit true, and a lost read is NOT phone-only", async () => {
  assertEquals(await phoneOnlyOf(flagAdmin({ data: { phone_only: true } }), "a"), true);
  assertEquals(await phoneOnlyOf(flagAdmin({ data: { phone_only: false } }), "a"), false);
  assertEquals(await phoneOnlyOf(flagAdmin({ data: { phone_only: "true" } }), "a"), false);
  assertEquals(await phoneOnlyOf(flagAdmin({ data: null }), "a"), false, "no settings row");
  assertEquals(await phoneOnlyOf(flagAdmin({ error: { code: "42703", message: "column does not exist" } }), "a"), false, "a database without 384");
  assertEquals(await phoneOnlyOf(flagAdmin("throw"), "a"), false);
  assertEquals(await phoneOnlyOf(flagAdmin({ data: { phone_only: true } }), ""), false, "no tenant, nothing to ask");
});

Deno.test("the lists name real portal-settings actions, and the contact half is contacts only", async () => {
  const src = await read("../../portal-settings/index.ts");
  const gates = src.slice(src.indexOf("const GATES: GateTable = {"), src.indexOf("\n};\n", src.indexOf("const GATES: GateTable = {")));
  const missing = [...PHONE_ONLY_PORTAL_SETTINGS].filter((a) => !new RegExp(`\\n  ${a}:`).test(gates));
  assertEquals(missing, [], "every allowed action is one GATES knows (a typo would quietly refuse it)");
  for (const a of PHONE_ONLY_CONTACT_ACTIONS) assert(a.startsWith("crm_"), a);
  // The CRM's other half stays the subscription's, by name.
  for (const a of ["crm_pipelines_list", "crm_deals_list", "crm_deal_create", "crm_inbox", "crm_rule_save", "crm_rules_list",
    "crm_forms_list", "crm_form_save", "crm_email_tpl_list", "crm_field_create", "crm_import_leads", "crm_import_ghl_contacts",
    "crm_create_lead", "crm_pipeline_save"]) {
    assert(!PHONE_ONLY_PORTAL_SETTINGS.has(a), `${a} must not be a phone-only account's`);
  }
  // Nothing of the shed product, the catalog or the paperwork.
  for (const a of ["catalog", "create_style", "list_inventory", "save_inventory", "send_invoice", "orders_overview",
    "save_branding", "save_location", "tax_settings", "qbo_status", "verify_save_ghl", "email_connect_domain", "delete_design"]) {
    assert(!PHONE_ONLY_PORTAL_SETTINGS.has(a), `${a} must not be a phone-only account's`);
  }
});

Deno.test("every function that resolves its tenant says what a phone-only account may call, or nothing", async () => {
  // "all" where the whole function is part of the account; a set for portal-settings; absent (refuse
  // all) for the rest. Pinned so a new resolveTenant caller is a decision, not an accident.
  const want: Record<string, string | null> = {
    "portal-billing": 'phoneOnly: "all"', "portal-setup": 'phoneOnly: "all"', "portal-sms": 'phoneOnly: "all"',
    "support-agent": 'phoneOnly: "all"', "portal-settings": "phoneOnly: PHONE_ONLY_PORTAL_SETTINGS",
    "portal-meetings": null, "portal-payments": null, "portal-schedule": null, "qbo-oauth-connect": null, "sync-design-status": null,
  };
  for (const [fn, opt] of Object.entries(want)) {
    const src = await read(`../../${fn}/index.ts`);
    assert(src.includes("resolveTenant("), `${fn} no longer resolves its tenant there; re-point this test`);
    if (opt) assert(src.includes(opt), `${fn} should pass ${opt}`);
    else assert(!/phoneOnly:/.test(src), `${fn} should refuse a phone-only account (pass no phoneOnly)`);
  }
  // jack-agent resolves in handler.ts (index.ts hands it the real resolveTenant): only `enabled`, which
  // the portal asks on every load and which answers off.
  const jack = await read("../../jack-agent/handler.ts");
  assert(jack.includes('const JACK_PHONE_ONLY: ReadonlySet<string> = new Set(["enabled"]);'), "Jack answers a phone-only account `enabled` and nothing else");
  assert(jack.includes("phoneOnly: JACK_PHONE_ONLY"), "jack-agent passes its phone-only list");
});

// ─── The shipped portal-settings handler ───────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const T = "harness-phone";
const OTHER = "harness-viewed";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
type World = { phoneOnly?: boolean | "fails"; crmPaid?: boolean; operator?: boolean };

function answer(world: World, flagReads: string[], table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const sel = String((ops.find((o) => o[0] === "select") ?? [])[1] ?? "");
  const eq = (col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
  const one = has("maybeSingle") || has("single");
  if (table === "client_users") {
    return { data: world.operator ? [] : [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1" }], error: null };
  }
  if (table === "app_operators") {
    return { data: world.operator ? { user_id: "u1", email: "op@example.test", can_write: true, can_bill: true, support_only: false } : null, error: null };
  }
  if (table === "client_configs") return { data: { client_id: eq("client_id") ?? OTHER }, error: null };
  if (table === "client_settings" && sel === "phone_only") {
    flagReads.push(String(eq("client_id")));
    if (world.phoneOnly === "fails") return { data: null, error: { code: "57014", message: "statement timeout" } };
    return { data: { phone_only: world.phoneOnly === true }, error: null };
  }
  if (table === "client_settings") {
    return { data: one ? { internal_account: false, billing_exempt: false } : [], error: null };
  }
  if (table === "billing_plans") return { data: [{ id: "crm_monthly", feature: "crm", billing_interval: "monthly" }], error: null };
  if (table === "billing_subscriptions") {
    return { data: world.crmPaid ? [{ plan_id: "crm_monthly", status: "active", current_period_end: "2099-01-01T00:00:00Z" }] : [], error: null };
  }
  // Every other table: empty. These cases are about who gets past the gates, not what is behind them.
  return { data: one ? null : [], error: null, count: 0 };
}
function chain(world: World, flagReads: string[], table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, flagReads, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "not", "or",
    "limit", "range", "order", "ilike", "contains", "overlaps", "filter", "match", "single", "maybeSingle", "returns", "abortSignal"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => Promise.resolve().then(() => answer(world, flagReads, table, ops)).then(ok, bad);
  return q;
}
async function drive(payload: Record<string, unknown>, world: World = {}) {
  const flagReads: string[] = [];
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, flagReads, table, []);
  stubRpc.rpc = (fn: string) => {
    const q: any = { then: (ok: any, bad: any) => Promise.resolve({ data: fn === "resolve_caller" ? null : [], error: null }).then(ok, bad) };
    for (const m of ["select", "eq", "single", "maybeSingle", "limit"]) q[m] = () => q;
    return q;
  };
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(world.operator ? { ...payload, targetClientId: OTHER } : payload),
    }));
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, flagReads };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const CRM_REFUSAL = /The Customer Hub is not part of your subscription/;
const refusedPhoneOnly = (r: { status: number; body: any }) => r.status === 403 && r.body?.error === PHONE_ONLY_REFUSAL;

Deno.test("a phone-only account is refused the shed product, the catalog, the paperwork and the CRM's other half", async () => {
  for (const action of ["catalog", "list_inventory", "send_invoice", "save_branding", "qbo_status", "crm_pipelines_list", "crm_inbox", "crm_rule_save", "crm_forms_list"]) {
    const r = await drive({ action }, { phoneOnly: true });
    assert(refusedPhoneOnly(r), `${action}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

Deno.test("…the same for an operator viewing one (the refusal follows the account, not the caller)", async () => {
  const r = await drive({ action: "catalog" }, { phoneOnly: true, operator: true });
  assert(refusedPhoneOnly(r), `${r.status} ${JSON.stringify(r.body)}`);
});

Deno.test("a phone-only account's own actions pass, and pay no flag read", async () => {
  for (const action of ["status", "get_profile", "phone_settings_get", "phone_calls_report"]) {
    const r = await drive({ action }, { phoneOnly: true });
    assert(!refusedPhoneOnly(r), `${action}: ${r.status} ${JSON.stringify(r.body)}`);
    assertEquals(r.flagReads, [], `${action} is on the allow-list, so resolveTenant never asks the flag`);
  }
});

Deno.test("its contacts need no Customer Hub subscription; an ordinary builder's still do", async () => {
  for (const action of ["crm_save_note", "crm_save_contact", "crm_contact_tag"]) {
    const phone = await drive({ action, contactId: "00000000-0000-4000-8000-0000000000c1", body: "Called back" }, { phoneOnly: true });
    assert(!refusedPhoneOnly(phone) && !CRM_REFUSAL.test(String(phone.body?.error ?? "")), `${action} phone-only: ${phone.status} ${JSON.stringify(phone.body)}`);
    const shed = await drive({ action, contactId: "00000000-0000-4000-8000-0000000000c1", body: "Called back" }, { phoneOnly: false });
    assertEquals(shed.status, 403, `${action} ordinary builder: ${JSON.stringify(shed.body)}`);
    assert(CRM_REFUSAL.test(String(shed.body?.error ?? "")), JSON.stringify(shed.body));
  }
});

Deno.test("an ordinary builder is never refused by the shape, and one that pays for the CRM is untouched", async () => {
  const shed = await drive({ action: "catalog" }, { phoneOnly: false });
  assert(!refusedPhoneOnly(shed), `${shed.status} ${JSON.stringify(shed.body)}`);
  assertEquals(shed.flagReads, [T], "one read of the flag, for the account itself");
  const paid = await drive({ action: "crm_save_note", contactId: "00000000-0000-4000-8000-0000000000c1", body: "x" }, { phoneOnly: false, crmPaid: true });
  assert(!CRM_REFUSAL.test(String(paid.body?.error ?? "")) && !refusedPhoneOnly(paid), `${paid.status} ${JSON.stringify(paid.body)}`);
});

Deno.test("a lost read of the flag refuses nothing and grants nothing", async () => {
  const cat = await drive({ action: "catalog" }, { phoneOnly: "fails" });
  assert(!refusedPhoneOnly(cat), `${cat.status} ${JSON.stringify(cat.body)}`);
  const note = await drive({ action: "crm_save_note", contactId: "00000000-0000-4000-8000-0000000000c1", body: "x" }, { phoneOnly: "fails" });
  assertEquals(note.status, 403);
  assert(CRM_REFUSAL.test(String(note.body?.error ?? "")), JSON.stringify(note.body));
});
