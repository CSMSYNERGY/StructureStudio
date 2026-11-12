// Execute migration 386 (plans as data) for real in PGlite (Postgres compiled to WASM, in memory)
// on top of the billing and settings tables as they stand, then check what it promises:
//   * the five tables exist, hold the starting rows, and no browser role can read them or execute
//     the resolver;
//   * access_resolve gives each made-up company the tabs the rules in the migration's header say,
//     one case per rule and per order-of-precedence pair;
//   * ON versus NOT ON agrees, company by company, with tests/sql/accessToday.cjs, which works the
//     same answer out the way portal-billing and the account shapes work it out today. That is the
//     "nothing changes for anyone" claim, on made-up data; the live parity run makes it on real data;
//   * a custom plan is rows only: three inserts give a company exactly those tabs;
//   * a re-apply changes nothing.
// Nothing here touches the live project: no network, no Supabase. Tenants are made up (public repo).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration386.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { todayOn } = require("./accessToday.cjs");

const WT = path.resolve(__dirname, "../..");
const SQL = fs.readFileSync(path.join(WT, "supabase/migrations/386_access_plans.sql"), "utf8").replace(/\r/g, "");

// The tables 386 reads, with only the columns it names (shared with the live parity run).
const { STUBS } = require("./accessStubs.cjs");

const FEATURES = ["simple_layout", "schedule_builds", "view_3d", "quickbooks_sync", "on_demand_pricing",
  "smartbuild_sync", "project_management", "crm", "full_suite", "self_serve_displays"];

const SEED = `
insert into public.billing_plans (id, feature, name, billing_interval, operator_grantable)
select f || '_' || i.suffix, f, f, i.suffix, f = 'view_3d'
  from unnest(array[${FEATURES.map((f) => `'${f}'`).join(", ")}]) f
 cross join (values ('monthly'), ('annual')) i(suffix);
-- A retired price point: still means what it meant to whoever holds it.
insert into public.billing_plans (id, feature, name, billing_interval, active) values
  ('simple_layout_legacy', 'simple_layout', 'Simple Layout (old price)', 'monthly', false);

insert into public.client_settings (client_id) values
  ('acme-sheds'), ('big-suite'), ('never-paid'), ('grace-in'), ('grace-out'), ('cancel-in'), ('cancel-out'),
  ('cancel-year'), ('grant-live'), ('grant-dead'), ('legacy-price'), ('two-plans'), ('exc-off'), ('exc-on'),
  ('exc-expired'), ('assigned'), ('assigned-expired'), ('custom-co'), ('draft-co'), ('retired-co');
insert into public.client_settings (client_id, sheds_enabled) values ('post-frame', false), ('post-frame-exc', false);
insert into public.client_settings (client_id, internal_account, jack_on, support_ai_beta, library_beta, door_looks_beta,
    tax_lookup_enabled, payments_online_enabled, phone_status) values
  ('our-own', true, true, true, true, true, true, true, 'on');
insert into public.client_settings (client_id, billing_exempt, phone_status) values ('demo-co', true, 'on');
insert into public.client_settings (client_id, billing_exempt_until) values
  ('free-period', now() + interval '10 days'), ('free-ended', now() - interval '1 day');
insert into public.client_settings (client_id, phone_only, sheds_enabled, phone_status) values
  ('phone-co', true, false, 'on'), ('phone-new', true, false, 'off');
insert into public.client_settings (client_id, phone_only, billing_exempt, jack_on) values ('phone-rich', true, true, true);
insert into public.client_settings (client_id, phone_only) values ('phone-plus', true);
insert into public.client_settings (client_id, advanced_mode, jack_on) values ('switches', true, true);
insert into public.client_settings (client_id, sheds_enabled, payments_online_enabled, tax_lookup_enabled, advanced_mode, jack_on)
  values ('post-frame-sw', false, true, true, true, true);
-- 'no-settings' has no client_settings row at all.

insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at, past_due_since) values
  ('s01', 'acme-sheds',   'simple_layout_annual',   'active',    now() + interval '200 days', null, null),
  ('s02', 'big-suite',    'full_suite_annual',      'active',    now() + interval '200 days', null, null),
  ('s03', 'post-frame',   'crm_annual',             'active',    now() + interval '200 days', null, null),
  ('s04', 'post-frame',   'smartbuild_sync_annual', 'active',    now() + interval '200 days', null, null),
  ('s05', 'grace-in',     'crm_monthly',            'past_due',  null, null, now() - interval '3 days'),
  ('s06', 'grace-out',    'crm_monthly',            'past_due',  null, null, now() - interval '9 days'),
  ('s07', 'cancel-in',    'schedule_builds_monthly','cancelled', now() + interval '12 days', now() - interval '5 days', null),
  ('s08', 'cancel-out',   'schedule_builds_monthly','cancelled', now() - interval '40 days', now() - interval '70 days', null),
  -- First renewal date long past, cancelled a week ago on a yearly plan: the boundary rolls forward a
  -- year at a time to the period that was paid for, which has not ended.
  ('s09', 'cancel-year',  'view_3d_annual',         'cancelled', now() - interval '400 days', now() - interval '7 days', null),
  ('s10', 'grant-live',   'simple_layout_monthly',  'active',    now() + interval '20 days', null, null),
  ('s11', 'grant-dead',   'simple_layout_monthly',  'active',    now() + interval '20 days', null, null),
  ('s12', 'legacy-price', 'simple_layout_legacy',   'active',    now() + interval '20 days', null, null),
  ('s13', 'two-plans',    'simple_layout_annual',   'active',    now() + interval '200 days', null, null),
  ('s14', 'two-plans',    'schedule_builds_annual', 'active',    now() + interval '200 days', null, null),
  ('s15', 'two-plans',    'quickbooks_sync_monthly','paused',    null, null, null),
  ('s16', 'phone-rich',   'crm_annual',             'active',    now() + interval '200 days', null, null),
  ('s17', 'exc-off',      'full_suite_annual',      'active',    now() + interval '200 days', null, null),
  ('s18', 'post-frame-exc','crm_annual',            'active',    now() + interval '200 days', null, null),
  ('s19', 'post-frame-sw','crm_annual',             'active',    now() + interval '200 days', null, null),
  ('s20', 'switches',     'simple_layout_annual',   'active',    now() + interval '200 days', null, null);

insert into public.client_feature_grants (client_id, feature, expires_at) values
  ('grant-live',  'view_3d', null),
  ('grant-dead',  'view_3d', now() - interval '30 days'),
  ('no-settings', 'view_3d', null),
  ('post-frame',  'view_3d', null);
`;

// Rows 386 adds on top of its own starting rows, for the cases that need them.
const AFTER = `
insert into public.client_modules (client_id, module, mode, expires_at) values
  ('exc-off',        'contacts',  'off', null),
  ('our-own',        'jack',      'off', null),
  ('exc-on',         'jack',      'on',  null),
  ('exc-on',         'contacts',  'on',  now() + interval '5 days'),
  ('exc-expired',    'jack',      'on',  now() - interval '1 hour'),
  ('exc-expired',    'designer',  'off', now() - interval '1 hour'),
  ('phone-plus',     'pipelines', 'on',  null),
  ('post-frame-exc', 'designer',  'on',  null);
insert into public.client_access_plans (client_id, plan_key, reason, expires_at) values
  ('assigned',         'crm', 'paid_offline', null),
  ('assigned-expired', 'crm', 'comp',         now() - interval '1 day');
-- A CUSTOM PLAN: one plan row, its tab rows, one assignment. The whole of "a new plan".
insert into public.access_plans (key, name, visibility) values ('gutters_basic', 'Gutters Basic', 'private');
insert into public.access_plan_modules (plan_key, module, state) values
  ('gutters_basic', 'contacts', 'included'), ('gutters_basic', 'pipelines', 'included'),
  ('gutters_basic', 'phone', 'included'), ('gutters_basic', 'meetings', 'teaser');
insert into public.client_access_plans (client_id, plan_key) values ('custom-co', 'gutters_basic');
insert into public.access_plans (key, name, status) values ('draft_plan', 'Not ready', 'draft'), ('old_plan', 'Old', 'retired');
insert into public.access_plan_modules (plan_key, module, state) values
  ('draft_plan', 'jack', 'included'), ('old_plan', 'jack', 'included');
insert into public.client_access_plans (client_id, plan_key) values ('draft-co', 'draft_plan'), ('retired-co', 'old_plan');
`;

let failed = 0;
const ok = (name, pass, note) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "   [" + note + "]" : ""}`);
  if (!pass) failed++;
};
const rows = async (db, q, p) => (await db.query(q, p)).rows;
const sorted = (s) => [...s].sort().join(",");

(async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  await db.exec(SQL);

  // ── the shape ────────────────────────────────────────────────────────────────────────────
  const tables = ["access_modules", "access_plans", "access_plan_modules", "client_access_plans", "client_modules"];
  const rls = await rows(db, `select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relname = any($1)`, [tables]);
  ok("five tables, RLS on each", rls.length === 5 && rls.every((r) => r.relrowsecurity), JSON.stringify(rls));
  const pol = await rows(db, "select count(*)::int n from pg_policies where schemaname = 'public' and tablename = any($1)", [tables]);
  ok("…and no policy on any of them", pol[0].n === 0);
  const grants = await rows(db, `select count(*)::int n from information_schema.role_table_grants
    where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`, [tables]);
  ok("no browser role holds a grant on them", grants[0].n === 0, String(grants[0].n));
  const fnPriv = await rows(db, `select
    has_function_privilege('anon', 'public.access_resolve(text)', 'execute') a,
    has_function_privilege('authenticated', 'public.access_resolve_detail(text)', 'execute') b,
    has_function_privilege('anon', 'public.access_usable_plans(text)', 'execute') c,
    has_function_privilege('service_role', 'public.access_resolve(text)', 'execute') d`);
  ok("browser roles cannot execute the resolver; service_role can",
    fnPriv[0].a === false && fnPriv[0].b === false && fnPriv[0].c === false && fnPriv[0].d === true, JSON.stringify(fnPriv[0]));
  let anonRead = "read";
  try { await db.exec("set role anon; select * from public.access_plans; "); } catch (e) { anonRead = String(e.message); }
  await db.exec("reset role;");
  ok("anon is refused a read of access_plans", /permission denied/.test(anonRead), anonRead);

  const nMod = await rows(db, "select count(*)::int n, count(*) filter (where shed)::int shed from public.access_modules");
  ok("33 catalogue tabs", nMod[0].n === 33, JSON.stringify(nMod[0]));
  const suite = await rows(db, "select replaces from public.access_plans where key = 'full_suite'");
  ok("the Suite names the six plans it replaces", suite[0].replaces.length === 6, JSON.stringify(suite[0]));
  const typo = await db.query("insert into public.access_plan_modules (plan_key, module, state) values ('crm', 'contcats', 'included')").then(() => "saved", (e) => String(e.message));
  ok("a tab that is not in the catalogue cannot be saved on a plan", /foreign key/.test(typo), typo);
  const badState = await db.query("insert into public.access_plan_modules (plan_key, module, state) values ('crm', 'jack', 'maybe')").then(() => "saved", (e) => String(e.message));
  ok("…nor a state that is not included or teaser", /check constraint/.test(badState), badState);

  await db.exec(AFTER);

  // ── the resolver, rule by rule ───────────────────────────────────────────────────────────
  const resolve = async (c) => (await rows(db, "select public.access_resolve($1) m", [c]))[0].m;
  const onOf = (m) => new Set(Object.keys(m).filter((k) => m[k] === "on"));
  const is = async (c, expect, name) => {
    const m = await resolve(c);
    const bad = Object.entries(expect).filter(([k, v]) => m[k] !== v).map(([k, v]) => `${k}=${m[k]} want ${v}`);
    ok(name, bad.length === 0, bad.join("; "));
    return m;
  };
  const BASE = { designer: "on", inventory: "on", orders: "on", commissions: "on", ghl: "on", customer_login: "on" };

  const acme = await is("acme-sheds", { ...BASE, contacts: "locked", build_schedule: "locked", view_3d: "locked",
    quickbooks: "locked", rtp: "locked", conversations: "hidden", pipelines: "hidden", jack: "hidden", phone: "hidden",
    reports: "hidden", advanced: "hidden" }, "one plan: its tabs on, the upsell tabs locked, the rest hidden");
  ok("every catalogue tab gets an answer", Object.keys(acme).length === 33, String(Object.keys(acme).length));
  await is("big-suite", { ...BASE, contacts: "on", pipelines: "on", conversations: "on", meetings: "on", automations: "on",
    forms: "on", sms: "on", email: "on", build_schedule: "on", delivery_schedule: "on", repairs: "on", view_3d: "on",
    quickbooks: "on", rtp: "on", jack: "hidden", projects: "hidden" }, "the Suite: everything its six members include");
  await is("never-paid", { designer: "hidden", contacts: "hidden", commissions: "hidden", view_3d: "hidden" },
    "no plan at all: nothing on, nothing teased");
  await is("post-frame", { contacts: "on", pipelines: "on", commissions: "on", smartbuild_sync: "on", quickbooks: "locked",
    designer: "off", inventory: "off", orders: "off", build_schedule: "off", view_3d: "off", customer_login: "off",
    ghl: "off", rtp: "off" }, "sells no sheds: the hub and Commissions on, every shed tab off (a live 3D comp included)");
  await is("post-frame-sw", { payments: "off", tax: "off", advanced: "off", jack: "on", contacts: "on" },
    "…and its shed-side switches are off too, while Jack is not a shed tab");
  await is("our-own", { ...BASE, contacts: "on", build_schedule: "on", view_3d: "on", quickbooks: "on", rtp: "on",
    projects: "on", smartbuild_sync: "on", self_serve_displays: "on", support_ai: "on", library: "on", door_looks: "on",
    tax: "on", payments: "on", phone: "on", advanced: "on", jack: "off", reports: "hidden", rent_to_own: "hidden" },
    "our own account: every public plan's tabs, its switches, and an off row still wins (Jack)");
  await is("demo-co", { ...BASE, contacts: "on", conversations: "on", build_schedule: "on", view_3d: "on", quickbooks: "on",
    rtp: "on", phone: "on", jack: "hidden", support_ai: "hidden", library: "hidden", door_looks: "hidden", tax: "hidden",
    payments: "hidden", advanced: "hidden" },
    "Non-billable: everything a public plan sells, and NOT Jack, the Support assistant, Library, door looks, Avalara, payments or Advanced");
  await is("free-period", { ...BASE, contacts: "locked", build_schedule: "locked", view_3d: "locked", quickbooks: "locked",
    projects: "on", smartbuild_sync: "on" }, "a dated free period: the base tabs, not the pay-only ones and not 3D");
  await is("free-ended", { designer: "hidden", contacts: "hidden" }, "…and nothing once the date has passed");
  await is("grace-in", { contacts: "on", ...BASE }, "past due inside 7 days: still on");
  await is("grace-out", { contacts: "hidden", designer: "hidden" }, "past due beyond 7 days: gone");
  await is("cancel-in", { build_schedule: "on", repairs: "on" }, "cancelled inside the period paid for: still on");
  await is("cancel-out", { build_schedule: "hidden", designer: "hidden" }, "cancelled and the paid period over: gone");
  await is("cancel-year", { view_3d: "on", designer: "on" }, "a yearly plan cancelled mid-year keeps the year it paid for");
  await is("legacy-price", { ...BASE }, "a subscription on a retired price point still means its plan");
  await is("two-plans", { ...BASE, build_schedule: "on", contacts: "locked", quickbooks: "locked" },
    "two plans: the union of their tabs; a paused subscription confers nothing");
  await is("grant-live", { view_3d: "on", designer: "on" }, "a live 3D comp turns 3D on");
  await is("grant-dead", { view_3d: "locked", designer: "on" }, "an expired 3D comp does not");
  await is("no-settings", { view_3d: "on", designer: "hidden", contacts: "hidden", phone: "hidden" },
    "a company with no settings row still resolves (a comp and nothing else)");
  await is("switches", { advanced: "on", jack: "on", ...BASE }, "a builder's own Advanced switch and Jack come from their columns");

  // phone-only (384): exclusive.
  const PHONE = { contacts: "on", phone: "on", sms: "on", pipelines: "hidden", conversations: "hidden", designer: "hidden",
    commissions: "hidden", jack: "hidden", quickbooks: "hidden", meetings: "hidden", view_3d: "hidden" };
  await is("phone-co", PHONE, "phone-only: the contact list, the phone and texting; nothing else");
  await is("phone-new", PHONE, "…the same before its phone is switched on (the plan allows it; the switch runs it)");
  await is("phone-rich", PHONE, "…and EXCLUSIVE: a paid Customer Hub plan, Non-billable and Jack add nothing while the flag is set");
  await is("phone-plus", { ...PHONE, pipelines: "on" }, "…except a tab an operator turned on for it by hand");

  // exceptions.
  await is("exc-off", { contacts: "off", pipelines: "on", designer: "on" }, "an off row beats a paid plan, for that tab only");
  await is("exc-on", { jack: "on", contacts: "on", designer: "hidden" }, "an on row works with no plan at all");
  await is("exc-expired", { jack: "hidden", designer: "hidden" }, "an expired row counts as no row");
  await is("post-frame-exc", { designer: "on", inventory: "off", contacts: "on" }, "an on row beats the no-sheds shape, for that tab only");

  // operator-assigned plans.
  await is("assigned", { contacts: "on", pipelines: "on", ...BASE }, "a plan assigned by an operator confers its tabs");
  await is("assigned-expired", { contacts: "hidden", designer: "hidden" }, "…until its end date");
  const custom = await is("custom-co", { contacts: "on", pipelines: "on", phone: "on", meetings: "locked", designer: "hidden",
    conversations: "hidden", commissions: "hidden" }, "A CUSTOM PLAN IS ROWS ONLY: exactly its tabs, its teaser locked");
  ok("…and nothing else is on", sorted(onOf(custom)) === "contacts,phone,pipelines", sorted(onOf(custom)));
  await is("draft-co", { jack: "hidden" }, "a draft plan confers nothing");
  await is("retired-co", { jack: "on" }, "a retired plan still means what it meant to whoever holds it");

  const detail = await rows(db, "select module, state, source from public.access_resolve_detail('post-frame') where module in ('contacts', 'designer', 'quickbooks', 'jack') order by module");
  ok("the detail says why", JSON.stringify(detail.map((d) => d.source)) === JSON.stringify(["plan:crm", "shape:no_sheds", "none", "plan:crm"])
    || JSON.stringify(detail.map((d) => `${d.module}:${d.source}`)) === JSON.stringify(["contacts:plan:crm", "designer:shape:no_sheds", "jack:none", "quickbooks:plan:crm"]),
    JSON.stringify(detail));
  const whyDemo = await rows(db, "select source from public.access_resolve_detail('demo-co') where module in ('contacts', 'phone') order by module");
  ok("…Non-billable and a switch are named as such", whyDemo[0].source === "non_billable" && whyDemo[1].source === "switch:phone_status", JSON.stringify(whyDemo));
  ok("an unknown company resolves to nothing on", onOf(await resolve("nobody-here")).size === 0);
  const nul = await rows(db, "select public.access_resolve(null) m");
  ok("a null company id resolves to nothing on", onOf(nul[0].m).size === 0);

  // ── today's rules, read the old way, agree on ON versus NOT ON ───────────────────────────
  // The companies with rows only the NEW tables can express (exceptions, assignments, custom plans)
  // are left out: the old rules cannot see those rows, which is the point of them.
  const NEW_ONLY = new Set(["exc-off", "exc-on", "phone-plus", "post-frame-exc", "assigned", "custom-co", "retired-co", "our-own"]);
  const plans = await rows(db, "select id, feature, billing_interval, active, operator_grantable from public.billing_plans");
  const ids = (await rows(db, `select client_id from public.client_settings union select 'no-settings' union select 'nobody-here'`)).map((r) => r.client_id);
  const now = Date.now();
  let compared = 0;
  for (const c of ids.sort()) {
    if (NEW_ONLY.has(c)) continue;
    const settings = (await rows(db, "select * from public.client_settings where client_id = $1", [c]))[0] || null;
    const subs = await rows(db, "select * from public.billing_subscriptions where client_id = $1", [c]);
    const grantRows = await rows(db, "select * from public.client_feature_grants where client_id = $1", [c]);
    const want = todayOn({ settings, subs, plans, grants: grantRows, now });
    const got = onOf(await resolve(c));
    ok(`today's rules agree for ${c}`, sorted(want) === sorted(got), `today: ${sorted(want)} | resolver: ${sorted(got)}`);
    compared++;
  }
  ok("…compared across every plain company", compared >= 22, String(compared));
  // our-own differs from today by exactly its one off row.
  {
    const settings = (await rows(db, "select * from public.client_settings where client_id = 'our-own'"))[0];
    const want = todayOn({ settings, subs: [], plans, grants: [], now });
    const got = onOf(await resolve("our-own"));
    want.delete("jack");
    ok("our own account agrees with today apart from its off row", sorted(want) === sorted(got), `today: ${sorted(want)} | resolver: ${sorted(got)}`);
  }

  // ── a re-apply changes nothing ───────────────────────────────────────────────────────────
  const snap = async () => JSON.stringify({
    m: await rows(db, "select * from public.access_modules order by key"),
    p: await rows(db, "select key, name, status, visibility, free_period, replaces, sort from public.access_plans order by key"),
    pm: await rows(db, "select * from public.access_plan_modules order by plan_key, module"),
    cp: await rows(db, "select client_id, plan_key, reason from public.client_access_plans order by 1, 2"),
    cm: await rows(db, "select client_id, module, mode from public.client_modules order by 1, 2"),
  });
  const before = await snap();
  await db.exec(SQL);
  ok("a re-apply changes no row (an edited plan is not reset, a custom plan gains no base tabs)", before === await snap());

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
