// Execute migration 270 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// get_config's live view3d block and the billing tables as they are live, then check what it
// promises:
//   * a tenant that pays for 3D (or the Suite) and holds no grant gets view3d = true from get_config,
//     and only that changes; a payer who already holds a hand grant, a comp, and a tenant with
//     nothing all read exactly what they read before (the apply's own before/after check, and ours);
//   * the rehearsal from the item contract: insert a subscription, get_config says true, roll back,
//     it says false again;
//   * ss_view3d_paid is featureState's rule case by case (active; past_due inside and outside the
//     7-day grace; cancelled inside and outside the prepaid period; paused; the Suite; a retired
//     plan; the wrong feature; another tenant's row);
//   * it agrees with the REAL _shared/billingPeriods.ts paidThroughOf on hundreds of random
//     cancelled subscriptions, end-of-month dates included, in two session time zones;
//   * the browser roles cannot call it, and anon still reads get_config through it;
//   * a re-apply changes nothing, a CRLF checkout of the file applies the same, and broken shapes
//     are refused with nothing left behind (mutants).
//   * THE RECORD, the one row `supabase db query` prints (it never prints a NOTICE): who gained 3D
//     by paying, the payers with a hand grant, the splice count, the grants and the Advanced count;
//     and a dry run (the last commit; swapped for rollback;) prints the same row and leaves nothing.
//   * PART 5, the Advanced switch: client_settings.advanced_mode arrives boolean NOT NULL DEFAULT
//     false, off on every row (our own account included); the browser roles can neither read nor
//     write it while service_role can do portal-settings' save (an update, and on a tenant with no
//     row an insert that keeps ramp_enabled false, as get_fixtures reads no row); a re-apply keeps
//     what builders chose; no tenant's get_config moves; and a wrong default, a nullable leftover or
//     an open table is refused with the WHOLE file rolled back.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration270.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/270_paid_3d_unlock.sql"), "utf8");

// get_config's head as it is live (pg_get_functiondef, 2026-10-05): the signature, the attributes
// and the view3d block are the live text character for character, because the splice anchors on
// them. The rest of the 17.7 KB body is cut to a few keys that read other tables, so "nothing else
// changed" has something to be wrong about. `extra` replaces the view3d block for the mutants.
const VIEW3D_LIVE = `    'view3d', exists (
      select 1 from public.client_feature_grants g
      where g.client_id = cc.client_id
        and g.feature = 'view_3d'
        and (g.expires_at is null or g.expires_at > now())
    ),`;
const GET_CONFIG = (view3dBlock = VIEW3D_LIVE) => `
create or replace function public.get_config(p_client_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
${view3dBlock}
    'branding', jsonb_build_object('companyName', cc.company_name, 'tagline', cc.tagline,
      'logo', cc.logo_url, 'headerBg', cc.header_bg, 'accentColor', cc.accent_color),
    'options',       cc.options,
    'grantCount', (select count(*) from public.client_feature_grants g2 where g2.client_id = cc.client_id),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
`;

// The live shapes (information_schema, 2026-10-05), cut to the columns 270 and the stub read.
const STUBS = (view3dBlock) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

-- The live default ACLs: every new function is executable by the browser roles until revoked.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.client_configs (
  client_id text primary key, company_name text, tagline text, logo_url text, header_bg text,
  accent_color text, options jsonb
);
create table public.client_feature_grants (
  client_id text not null, feature text not null, granted_by uuid, granted_at timestamptz not null default now(),
  expires_at timestamptz, note text
);
create table public.billing_plans (
  id text primary key, name text not null, price_cents integer, billing_interval text not null,
  gateway_plan_id text not null default '', active boolean not null default true, feature text,
  operator_grantable boolean not null default false,
  constraint billing_plans_billing_interval_check check (billing_interval = any (array['monthly','annual']))
);
create table public.billing_subscriptions (
  id text primary key, client_id text not null, plan_id text references public.billing_plans(id),
  status text not null default 'active', current_period_start timestamptz, current_period_end timestamptz,
  canceled_at timestamptz, created_at timestamptz not null default now(), past_due_since timestamptz,
  constraint billing_subscriptions_status_check check (status = any (array['active','paused','past_due','cancelled']))
);
revoke all on public.client_configs, public.client_feature_grants, public.billing_plans, public.billing_subscriptions from anon, authenticated;

-- client_settings as live (99 columns, cut to a few): RLS on with no policies, and an ACL of
-- postgres + service_role only. Granted to everyone first and then revoked, which is how Supabase's
-- default privileges and the migrations that closed it left it. get_config reads show_pricing.
-- ramp_enabled defaults to TRUE as it does live, while get_fixtures reads a missing row as OFF.
create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  billing_exempt boolean not null default false, internal_account boolean not null default false,
  insulation_enabled boolean not null default false, show_pricing boolean,
  ramp_enabled boolean not null default true
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

insert into public.billing_plans (id, name, billing_interval, feature, operator_grantable, active) values
  ('view_3d_monthly',       '3D View',                'monthly', 'view_3d',       true,  true),
  ('view_3d_annual',        '3D View',                'annual',  'view_3d',       true,  true),
  ('view_3d_retired',       '3D View (old price)',    'annual',  'view_3d',       true,  false),
  ('full_suite_annual',     'Structure Studio Suite', 'annual',  'full_suite',    false, true),
  ('simple_layout_annual',  'Simple Layout',          'annual',  'simple_layout', false, true);

${GET_CONFIG(view3dBlock)}
`;

// Four tenants in the shapes live has: a payer with a hand grant (both payers to date), a comp, a
// tenant whose grant ran out, and a tenant with nothing. Plus a payer WITHOUT a grant, which live
// does not have yet — the next buyer.
const SEED = `
insert into public.client_configs (client_id, company_name, accent_color, options) values
  ('acme-sheds',     'Acme Sheds',     '#1D4ED8', '[{"k":1}]'),
  ('bravo-barns',    'Bravo Barns',    '#8B4513', '[]'),
  ('charlie-cabins', 'Charlie Cabins', null,      null),
  ('delta-sheds',    'Delta Sheds',    '#000000', '[]'),
  ('echo-barns',     'Echo Barns',     '#222222', '[]');
insert into public.client_feature_grants (client_id, feature, expires_at, note) values
  ('acme-sheds',     'view_3d', null,                         'switched on by hand after paying'),
  ('charlie-cabins', 'view_3d', null,                         'comp'),
  ('delta-sheds',    'view_3d', now() - interval '1 day',     'expired comp');
insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end) values
  ('sub-acme-3d',   'acme-sheds',  'view_3d_annual',       'active', now() + interval '300 days'),
  ('sub-acme-base', 'acme-sheds',  'simple_layout_annual', 'active', now() + interval '300 days'),
  ('sub-echo-base', 'echo-barns',  'simple_layout_annual', 'active', now() + interval '300 days');
-- client_settings: four rows and one tenant without a row (live has one such). charlie-cabins plays
-- our own account (internal_account), which PART 5 must leave alone like everyone else.
insert into public.client_settings (client_id, internal_account, billing_exempt, insulation_enabled, show_pricing) values
  ('acme-sheds',     false, false, true,  true),
  ('bravo-barns',    false, false, false, null),
  ('charlie-cabins', true,  true,  false, true),
  ('delta-sheds',    false, true,  false, false);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh(view3dBlock) {
  const db = new PGlite();
  await db.exec(STUBS(view3dBlock));
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const results = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  // THE RECORD: what `supabase db query` prints is the rows of the last statement that returns any.
  const last = [...results].reverse().find((r) => r.rows && r.rows.length);
  notices.record = last ? last.rows[0] : null;
  return notices;
}
// The file as a dry run: its last `commit;` swapped for `rollback;`.
const DRY_RUN = () => {
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const helper = await one(db, "select to_regprocedure('public.ss_view3d_paid(text)') is not null as there");
  const spliced = await one(db, "select position('ss_view3d_paid' in pg_get_functiondef('public.get_config(text)'::regprocedure)) > 0 as s");
  const column = await advColumn(db);
  return { err: err ? err.message : null, matched: !!err && re.test(err.message), helper: helper.there, spliced: spliced.s, column: !!column };
}
// client_settings.advanced_mode's shape, or null when the column is not there.
const advColumn = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'advanced_mode'`)) || null;
const configs = async (db) => Object.fromEntries((await rows(db,
  "select client_id, public.get_config(client_id) as cfg from public.client_configs order by client_id")).map((r) => [r.client_id, r.cfg]));
const paid = async (db, client) => (await one(db, "select public.ss_view3d_paid($1) as p", [client])).p;
const view3dOf = async (db, client) => (await one(db, "select public.get_config($1) -> 'view3d' as v", [client])).v;

// One subscription row for a one-row tenant, as the owner, and ss_view3d_paid's answer for it —
// inside a transaction that is rolled back, so the cases cannot see each other.
async function verdict(db, sub, client = "case-tenant") {
  await db.exec("begin");
  try {
    await db.query(
      `insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at, past_due_since)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["case-sub", sub.client || client, sub.plan, sub.status, sub.cpe ?? null, sub.canceled ?? null, sub.pastDueSince ?? null]);
    return await paid(db, client);
  } finally {
    await db.exec("rollback");
  }
}

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 270: applies on the live shape and changes no tenant's config but a paying one without a grant");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
    let notices = [];
    try { notices = await apply(db); ok(true, "270 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "270 applied", e.message); }
    ok(notices.some((n) => /view3d flips false -> true for 0 tenant\(s\): \(none\)/.test(n)), "the blast-radius notice names no flip (every payer already holds a grant)", notices.join(" | "));
    ok(notices.some((n) => /paying AND holding a hand grant .*: acme-sheds$/.test(n)), "and names the payer whose hand grant would outlive a cancellation", notices.join(" | "));
    ok(notices.some((n) => /checks hold; .* view3d now true for: \(none\)/.test(n)), "the apply's own before/after check passed with no flip", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "270", view3d_gained_by_paying: "(none)", paying_and_hand_granted: "acme-sheds",
      get_config_splices: 1, anon_reads_get_config: true, browser_can_call_helper: false, advanced_mode_on: 0,
    }), "THE RECORD, the row the CLI prints: no flip, the hand-granted payer, one splice, grants as promised, Advanced off", JSON.stringify(rec));

    const after = await configs(db);
    ok(JSON.stringify(after) === JSON.stringify(before), "every tenant's get_config is byte-for-byte what it was", JSON.stringify({ before, after }));
    ok(before["acme-sheds"].view3d === true && before["charlie-cabins"].view3d === true
      && before["bravo-barns"].view3d === false && before["delta-sheds"].view3d === false && before["echo-barns"].view3d === false,
    "the seed covers payer-with-grant, comp, nothing, an expired comp and a base-only payer", JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.view3d]))));

    const fnAfter = (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
    const expected = fnBefore.replace(
      "and (g.expires_at is null or g.expires_at > now())\n    )",
      "and (g.expires_at is null or g.expires_at > now())\n    ) or public.ss_view3d_paid(cc.client_id)");
    ok(fnAfter === expected, "get_config's body gained exactly ' or public.ss_view3d_paid(cc.client_id)' after the grant EXISTS, nothing else",
      fnAfter.slice(0, 600));
    const attrs = await one(db, `select p.prosecdef, p.provolatile, p.proconfig::text as cfg, p.proowner::regrole::text as owner
      from pg_proc p where p.oid = 'public.get_config(text)'::regprocedure`);
    ok(attrs.prosecdef && attrs.provolatile === "s" && attrs.cfg === '{"search_path=\\"\\""}', "get_config is still STABLE SECURITY DEFINER with an empty search_path", JSON.stringify(attrs));

    const helper = await one(db, `select p.prosecdef, p.provolatile, p.proconfig::text as cfg,
        has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as svc,
        exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as pub
      from pg_proc p where p.oid = 'public.ss_view3d_paid(text)'::regprocedure`);
    ok(helper && helper.prosecdef && helper.provolatile === "s" && helper.cfg === '{"search_path=\\"\\""}', "ss_view3d_paid is STABLE SECURITY DEFINER, search_path ''", JSON.stringify(helper));
    ok(helper && !helper.anon && !helper.auth && !helper.pub && helper.svc, "ss_view3d_paid: not PUBLIC, anon or authenticated; service_role yes", JSON.stringify(helper));

    // ── The rehearsal from the item contract ──
    await db.exec("begin");
    await db.exec(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end)
                   values ('sub-bravo-3d', 'bravo-barns', 'view_3d_monthly', 'active', now() + interval '20 days')`);
    ok(await view3dOf(db, "bravo-barns") === true, "rehearsal: a 3D subscription with no grant turns get_config view3d on");
    const flipped = await one(db, "select (public.get_config('bravo-barns') - 'view3d') = ($1::jsonb - 'view3d') as same", [JSON.stringify(before["bravo-barns"])]);
    ok(flipped.same, "and nothing else in that tenant's config moves");
    // anon is who the public designer calls get_config as; it reaches the helper through get_config.
    await db.exec("set role anon");
    let anonView = null, anonErr = null, anonDirect = null;
    try { anonView = (await one(db, "select public.get_config('bravo-barns') -> 'view3d' as v")).v; } catch (e) { anonErr = e.message; }
    await db.exec("savepoint direct");
    try { await one(db, "select public.ss_view3d_paid('bravo-barns') as p"); anonDirect = "allowed"; }
    catch (e) { anonDirect = e.message; await db.exec("rollback to savepoint direct"); }
    await db.exec("reset role");
    ok(anonView === true, "anon's get_config sees it too (the helper runs as get_config's owner)", anonErr || String(anonView));
    ok(/permission denied/.test(String(anonDirect)), "anon cannot call ss_view3d_paid itself", String(anonDirect));
    await db.exec("rollback");
    ok(await view3dOf(db, "bravo-barns") === false, "rehearsal rolled back: view3d is false again");

    // The Suite confers 3D.
    await db.exec("begin");
    await db.exec(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end)
                   values ('sub-echo-suite', 'echo-barns', 'full_suite_annual', 'active', now() + interval '200 days')`);
    ok(await view3dOf(db, "echo-barns") === true, "a Suite subscription turns view3d on");
    await db.exec("rollback");
    ok(await view3dOf(db, "echo-barns") === false, "Simple Layout alone does not");

    // ── Re-apply ──
    let reNotices = [];
    try { reNotices = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(reNotices.some((n) => /already reads ss_view3d_paid — nothing to splice/.test(n)), "and says there was nothing to splice", reNotices.join(" | "));
    const fnAgain = (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
    ok(fnAgain === fnAfter, "get_config is unchanged by the re-apply (still one splice)");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "and every tenant still reads what it read before");

    // ── The rule, case by case (featureState / usableSub) ──
    console.log("ss_view3d_paid: featureState's rule");
    const DAY = 86400000;
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    const cases = [
      ["active 3D, monthly",                                 { plan: "view_3d_monthly", status: "active", cpe: at(10 * DAY) },             true],
      ["active 3D with no period end at all",                { plan: "view_3d_annual", status: "active" },                                 true],
      ["active Suite",                                       { plan: "full_suite_annual", status: "active", cpe: at(100 * DAY) },          true],
      ["active 3D on a RETIRED plan row",                    { plan: "view_3d_retired", status: "active", cpe: at(100 * DAY) },            true],
      ["active, but Simple Layout (wrong feature)",          { plan: "simple_layout_annual", status: "active", cpe: at(100 * DAY) },       false],
      ["active 3D, but ANOTHER tenant's row",                { plan: "view_3d_annual", status: "active", cpe: at(100 * DAY), client: "someone-else" }, false],
      ["past_due 3 days (inside the 7-day grace)",           { plan: "view_3d_annual", status: "past_due", pastDueSince: at(-3 * DAY) },   true],
      ["past_due 6 days 23 hours",                           { plan: "view_3d_annual", status: "past_due", pastDueSince: at(-7 * DAY + 3600000) }, true],
      ["past_due 7 days 1 minute (grace over)",              { plan: "view_3d_annual", status: "past_due", pastDueSince: at(-7 * DAY - 60000) }, false],
      ["past_due 30 days",                                   { plan: "view_3d_monthly", status: "past_due", pastDueSince: at(-30 * DAY) }, false],
      ["past_due with no timestamp (grace from now)",        { plan: "view_3d_monthly", status: "past_due" },                              true],
      ["cancelled, period end still ahead",                  { plan: "view_3d_annual", status: "cancelled", cpe: at(40 * DAY), canceled: at(-2 * DAY) }, true],
      ["cancelled before its first period ended, now past",  { plan: "view_3d_annual", status: "cancelled", cpe: at(-2 * DAY), canceled: at(-40 * DAY) }, false],
      ["cancelled monthly: renewed once, then cancelled",    { plan: "view_3d_monthly", status: "cancelled", cpe: at(-40 * DAY), canceled: at(-5 * DAY) }, true],
      ["cancelled monthly: renewed, cancelled, period over", { plan: "view_3d_monthly", status: "cancelled", cpe: at(-100 * DAY), canceled: at(-60 * DAY) }, false],
      ["cancelled annual: renewed once, still paid up",      { plan: "view_3d_annual", status: "cancelled", cpe: at(-400 * DAY), canceled: at(-10 * DAY) }, true],
      ["cancelled Suite inside its paid year",               { plan: "full_suite_annual", status: "cancelled", cpe: at(200 * DAY), canceled: at(-1 * DAY) }, true],
      ["cancelled, no period end (bill-in-arrears row)",     { plan: "view_3d_annual", status: "cancelled", canceled: at(-1 * DAY) },      false],
      ["paused",                                             { plan: "view_3d_annual", status: "paused", cpe: at(100 * DAY) },             false],
    ];
    for (const [name, sub, want] of cases) {
      const got = await verdict(db, sub);
      ok(got === want, `${name}: ${want ? "usable" : "not usable"}`, `got ${got}`);
    }
    ok(await paid(db, null) === false, "a null tenant is not paying");

    // Boundary: a cancelled row whose paid-through lands EXACTLY on now() is over (strict >, as
    // paidUntil > now in billingPeriods' callers); one microsecond later it is still on.
    await db.exec("begin");
    const b = await one(db, `select (now() at time zone 'UTC' - interval '1 year') + interval '1 year' = now() at time zone 'UTC' as round_trips`);
    if (b.round_trips) {
      await db.exec(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at) values
        ('edge-0', 'edge-on',  'view_3d_annual', 'cancelled', ((now() at time zone 'UTC' - interval '1 year') at time zone 'UTC'), ((now() at time zone 'UTC' - interval '1 year') at time zone 'UTC')),
        ('edge-1', 'edge-off', 'view_3d_annual', 'cancelled', ((now() at time zone 'UTC' - interval '1 year' + interval '1 microsecond') at time zone 'UTC'), ((now() at time zone 'UTC' - interval '1 year' + interval '1 microsecond') at time zone 'UTC'))`);
      ok(await paid(db, "edge-on") === false, "paid-through exactly now: over");
      ok(await paid(db, "edge-off") === true, "paid-through one microsecond after now: still on");
    } else {
      console.log("  skip the exact-boundary pair: today minus a year plus a year is not today (Feb 29)");
    }
    await db.exec("rollback");

    // ── Parity with the real paidThroughOf ──
    console.log("ss_view3d_paid: agrees with _shared/billingPeriods.ts paidThroughOf");
    if (!process.features || !process.features.typescript) {
      console.log("  SKIP this Node cannot import .ts (needs type stripping, Node 22.18+ / 23.6+)");
    } else {
      const { paidThroughOf } = await import(pathToFileURL(path.join(WT, "supabase/functions/_shared/billingPeriods.ts")).href);
      // mulberry32: a fixed seed, so a failure names a case that can be run again.
      let seed = 0x270;
      const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pick = (a) => a[Math.floor(rand() * a.length)];
      for (const tz of ["UTC", "Pacific/Auckland", "America/New_York"]) {
        await db.exec("begin");
        await db.exec(`set local timezone = '${tz}'`);
        const nowMs = Number((await one(db, "select (extract(epoch from now()) * 1000)::float8 as ms")).ms);
        const N = 400;
        const subs = [];
        for (let i = 0; i < N; i++) {
          // Whole seconds, and end-of-month days on purpose: that is where calendar arithmetic bites.
          const base = new Date(nowMs + Math.round((rand() * 6 - 3) * 365) * 86400000);
          const day = rand() < 0.5 ? pick([28, 29, 30, 31]) : 1 + Math.floor(rand() * 28);
          const cpe = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1, Math.floor(rand() * 24), Math.floor(rand() * 60), Math.floor(rand() * 60));
          const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
          const cpeMs = cpe + (Math.min(day, lastDay) - 1) * 86400000;
          const canMs = cpeMs + Math.round((rand() * 6 - 4) * 365 * 86400000 / 1000) * 1000;
          const interval = rand() < 0.5 ? "monthly" : "annual";
          subs.push({ id: `fz-${i}`, client: `fz-${i}`, plan: `view_3d_${interval}`, interval, cpe: new Date(cpeMs).toISOString(), canceled: new Date(canMs).toISOString() });
        }
        for (const s of subs) {
          await db.query(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at)
                          values ($1, $2, $3, 'cancelled', $4, $5)`, [s.id, s.client, s.plan, s.cpe, s.canceled]);
        }
        const got = Object.fromEntries((await rows(db, "select client_id, public.ss_view3d_paid(client_id) as p from public.billing_subscriptions where id like 'fz-%'")).map((r) => [r.client_id, r.p]));
        const wrong = [];
        let on = 0;
        for (const s of subs) {
          const end = paidThroughOf({ current_period_end: s.cpe, canceled_at: s.canceled }, s.interval);
          const want = Number.isFinite(end) && end > nowMs;
          if (want) on++;
          if (got[s.client] !== want) wrong.push({ ...s, want, got: got[s.client], paidThrough: new Date(end).toISOString() });
        }
        ok(wrong.length === 0, `${N} random cancelled subscriptions, session time zone ${tz}: SQL and paidThroughOf agree (${on} usable, ${N - on} not)`,
          JSON.stringify(wrong.slice(0, 3)));
        ok(on > N * 0.1 && on < N * 0.9, `the ${tz} sample has both answers in it`, `${on} of ${N} usable`);
        await db.exec("rollback");
      }
    }
    await db.close();
  }

  // ── 2. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 270: a Windows (CRLF) checkout of the file splices the same body");
  {
    const lf = await fresh();
    await apply(lf, MIG_TEXT().replace(/\r\n/g, "\n"));
    const crlf = await fresh();
    let err = null;
    try { await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n")); } catch (e) { err = e.message; }
    ok(!err, "the CRLF copy applies", err);
    const a = (await one(lf, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
    const b = (await one(crlf, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
    ok(a === b && a.includes("    ) or public.ss_view3d_paid(cc.client_id),"), "both produce the same get_config, spliced in the same place");
    await lf.close(); await crlf.close();
  }

  // ── 3. A payer without a grant, as the apply sees it ────────────────────────────────────────
  console.log("migration 270: a paying tenant with no grant flips, and only it");
  {
    const db = await fresh();
    await db.exec(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end)
                   values ('sub-bravo-3d', 'bravo-barns', 'view_3d_annual', 'active', now() + interval '300 days')`);
    const before = await configs(db);
    let notices = [];
    try { notices = await apply(db); } catch (e) { ok(false, "270 applied", e.message); }
    ok(notices.some((n) => /view3d flips false -> true for 1 tenant\(s\): bravo-barns$/.test(n)), "the blast-radius notice names it", notices.join(" | "));
    ok(notices.some((n) => /view3d now true for: bravo-barns$/.test(n)), "the apply's own check accepts exactly that flip", notices.join(" | "));
    ok(notices.record && notices.record.view3d_gained_by_paying === "bravo-barns", "and THE RECORD names it, where the CLI shows it", JSON.stringify(notices.record));
    const after = await configs(db);
    ok(after["bravo-barns"].view3d === true && before["bravo-barns"].view3d === false, "bravo-barns: view3d false -> true");
    const others = Object.keys(before).filter((k) => k !== "bravo-barns");
    ok(others.every((k) => JSON.stringify(after[k]) === JSON.stringify(before[k])), "every other tenant is byte-for-byte unchanged");
    const { view3d: _a, ...restBefore } = before["bravo-barns"];
    const { view3d: _b, ...restAfter } = after["bravo-barns"];
    ok(JSON.stringify(restAfter) === JSON.stringify(restBefore), "and nothing else in bravo-barns' config moved");
    // Cancelling inside the paid year keeps it; the period running out takes it away.
    await db.exec("begin");
    await db.exec("update public.billing_subscriptions set status = 'cancelled', canceled_at = now() where id = 'sub-bravo-3d'");
    ok(await view3dOf(db, "bravo-barns") === true, "cancelled with the year still paid: 3D stays on");
    await db.exec("update public.billing_subscriptions set current_period_end = now() - interval '1 day', canceled_at = now() - interval '2 days' where id = 'sub-bravo-3d'");
    ok(await view3dOf(db, "bravo-barns") === false, "cancelled and the paid period over: 3D goes off (no grant to hold it)");
    await db.exec("rollback");
    await db.close();
  }

  // ── 3b. The dry run: the same record, nothing left behind ───────────────────────────────────
  console.log("migration 270: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    await db.exec(`insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end)
                   values ('sub-bravo-3d', 'bravo-barns', 'view_3d_annual', 'active', now() + interval '300 days')`);
    const before = await configs(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.view3d_gained_by_paying === "bravo-barns" && notices.record.get_config_splices === 1,
      "it prints the same record the apply would", JSON.stringify(notices.record));
    const helper = await one(db, "select to_regprocedure('public.ss_view3d_paid(text)') is not null as there");
    ok(!helper.there && !(await advColumn(db)), "and leaves no helper and no column behind", JSON.stringify(helper));
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "and no tenant's get_config moved");
    await db.close();
  }

  // ── 4. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 270: refuses what it cannot splice safely");
  {
    // The anchor twice: a second block ending the same way.
    const twice = VIEW3D_LIVE + "\n" + VIEW3D_LIVE.replace("'view3d'", "'view3dAgain'");
    let db = await fresh(twice);
    let r = await refused(db, MIG_TEXT(), /anchor found 2 time\(s\)/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "the anchor twice: refused, no helper, no splice", JSON.stringify(r));
    await db.close();

    // The anchor gone: the block reformatted onto one line.
    db = await fresh("    'view3d', exists (select 1 from public.client_feature_grants g where g.client_id = cc.client_id and g.feature = 'view_3d' and (g.expires_at is null or g.expires_at > now())),");
    r = await refused(db, MIG_TEXT(), /anchor found 0 time\(s\)/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "the anchor missing: refused, no helper, no splice", JSON.stringify(r));
    await db.close();

    // The anchor present, but not in the view3d block.
    db = await fresh(VIEW3D_LIVE.replace("'view3d'", "'grantCheck'"));
    r = await refused(db, MIG_TEXT(), /not inside the view3d block/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "the anchor outside view3d: refused", JSON.stringify(r));
    await db.close();

    // A splice that changes something it should not: PART 4's before/after check catches it.
    db = await fresh();
    const sneaky = MIG_TEXT().replace("v_add    text := ' or public.ss_view3d_paid(cc.client_id)';",
      "v_add    text := ' or public.ss_view3d_paid(cc.client_id) or cc.client_id = ''bravo-barns''';");
    ok(sneaky !== MIG_TEXT(), "(mutant built: the splice also turns 3D on for a tenant that pays nothing)");
    r = await refused(db, sneaky, /changed beyond a false -> true view3d for: bravo-barns/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "a splice that flips a non-payer: refused by the apply's own check", JSON.stringify(r));
    await db.close();

    // The revoke left out: the browser roles could call the helper.
    db = await fresh();
    const open = MIG_TEXT().replace("revoke execute on function public.ss_view3d_paid(text) from public, anon, authenticated;", "");
    ok(open !== MIG_TEXT(), "(mutant built: no revoke)");
    r = await refused(db, open, /PUBLIC can still EXECUTE|a browser role can EXECUTE/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "the helper left open to the browser: refused", JSON.stringify(r));
    await db.close();

    // A helper that anon's get_config could not reach: revoked from the owner's side too.
    db = await fresh();
    await db.exec("create role cfg_owner nologin; alter function public.get_config(text) owner to cfg_owner; grant select on all tables in schema public to cfg_owner;");
    r = await refused(db, MIG_TEXT(), /get_config runs as cfg_owner, who cannot EXECUTE ss_view3d_paid/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "get_config owned by someone who cannot call the helper: refused", JSON.stringify(r));
    await db.close();
  }

  // ── 5. PART 5: client_settings.advanced_mode, the Advanced switch ───────────────────────────
  console.log("migration 270 PART 5: advanced_mode arrives off for everyone, closed to the browser, and re-runs keep it");
  {
    const db = await fresh();
    const before = await configs(db);
    const settingsBefore = await rows(db, "select * from public.client_settings order by client_id");
    let notices = [];
    try { notices = await apply(db); } catch (e) { ok(false, "270 applied", e.message); }
    const col = await advColumn(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false",
      "the column is boolean NOT NULL DEFAULT false", JSON.stringify(col));
    ok((await one(db, "select count(*)::int as n from public.client_settings where advanced_mode")).n === 0, "off on every row, our own account included");
    ok(notices.some((n) => /advanced_mode added, off, on client_settings \(4 row\(s\)\); Advanced mode is on for: \(none\)$/.test(n)), "the apply says it added it, off, and on for nobody", notices.join(" | "));
    const settingsAfter = await rows(db, "select * from public.client_settings order by client_id");
    ok(JSON.stringify(settingsAfter.map(({ advanced_mode: _a, ...r }) => r)) === JSON.stringify(settingsBefore), "no other client_settings value moved");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "no tenant's get_config moved (it reads client_settings, and the PUBLIC page has no Advanced)");
    const comment = await one(db, `select col_description('public.client_settings'::regclass,
      (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'advanced_mode')) as c`);
    ok(/Advanced mode switch/.test(comment.c || "") && /save_advanced_mode/.test(comment.c || "") && /Off by default\. Free\./.test(comment.c || ""), "the column says what it is", comment.c);

    // The privileges the checks claim, asked of Postgres directly.
    const priv = await one(db, `select
      has_column_privilege('anon', 'public.client_settings', 'advanced_mode', 'SELECT') as anon_sel,
      has_column_privilege('anon', 'public.client_settings', 'advanced_mode', 'UPDATE') as anon_upd,
      has_column_privilege('authenticated', 'public.client_settings', 'advanced_mode', 'SELECT') as auth_sel,
      has_column_privilege('authenticated', 'public.client_settings', 'advanced_mode', 'INSERT') as auth_ins,
      has_column_privilege('authenticated', 'public.client_settings', 'advanced_mode', 'UPDATE') as auth_upd,
      has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'SELECT') as svc_sel,
      has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'INSERT') as svc_ins,
      has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'UPDATE') as svc_upd`);
    ok(!priv.anon_sel && !priv.anon_upd && !priv.auth_sel && !priv.auth_ins && !priv.auth_upd, "anon and authenticated can neither read nor write it", JSON.stringify(priv));
    ok(priv.svc_sel && priv.svc_ins && priv.svc_upd, "service_role can read it and do portal-settings' upsert", JSON.stringify(priv));
    for (const role of ["anon", "authenticated"]) {
      await db.exec("begin");
      await db.exec(`set local role ${role}`);
      let err = null;
      try { await db.query("select advanced_mode from public.client_settings"); } catch (e) { err = e.message; }
      await db.exec("rollback");
      ok(/permission denied/.test(String(err)), `${role}: reading it is refused`, String(err));
    }

    // portal-settings' save, as service_role and as the handler makes it: an UPDATE of the switch; and
    // on a tenant with no row, turning it on, an insert that names ramp_enabled false (the column
    // defaults to true, get_fixtures reads no row as off, and the switch must not turn ramps on).
    await db.exec("begin");
    await db.exec("set local role service_role");
    const update = (client, on) => db.query("update public.client_settings set advanced_mode = $2, updated_at = now() where client_id = $1 returning client_id", [client, on]);
    let upErr = null, matched = null;
    try {
      await update("acme-sheds", true);
      matched = (await update("echo-barns", true)).rows.length;
      await db.query("insert into public.client_settings (client_id, advanced_mode, ramp_enabled, updated_at) values ($1, true, false, now())", ["echo-barns"]);
    } catch (e) { upErr = e.message; }
    await db.exec("reset role");
    ok(!upErr, "service_role's save works: the update on an existing row, the insert on a missing one", upErr);
    ok(matched === 0, "a tenant with no row: the update matches nothing (which is why the handler asks for the rows back)", String(matched));
    const acme = await one(db, "select advanced_mode, insulation_enabled, show_pricing, ramp_enabled from public.client_settings where client_id = 'acme-sheds'");
    ok(acme.advanced_mode === true && acme.insulation_enabled === true && acme.show_pricing === true && acme.ramp_enabled === true, "the update touched only the switch", JSON.stringify(acme));
    const echo = await one(db, "select advanced_mode, internal_account, billing_exempt, insulation_enabled, ramp_enabled from public.client_settings where client_id = 'echo-barns'");
    ok(echo && echo.advanced_mode === true && !echo.internal_account && !echo.billing_exempt && !echo.insulation_enabled && echo.ramp_enabled === false,
      "the created row is defaults plus the switch, with ramps kept off as they read with no row", JSON.stringify(echo));
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "turning it on moves no tenant's get_config either");
    await db.exec("commit");

    // A re-apply keeps what builders chose and says so.
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply with builders' choices in it runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re.some((n) => /client_settings\.advanced_mode is already there — every value in it is kept/.test(n)), "and says it kept the column", re.join(" | "));
    ok(re.some((n) => /advanced_mode kept on client_settings \(5 row\(s\)\); Advanced mode is on for: acme-sheds, echo-barns$/.test(n)), "and names who has it on", re.join(" | "));
    ok((await one(db, "select string_agg(client_id, ',' order by client_id) as on from public.client_settings where advanced_mode")).on === "acme-sheds,echo-barns", "both builders still have it on");
    await db.close();
  }

  console.log("migration 270 PART 5: refuses a wrong shape or an open table, and takes the whole file back");
  {
    // The default flipped: every builder would get Advanced at once.
    let db = await fresh();
    const on = MIG_TEXT().replace("add column advanced_mode boolean not null default false;", "add column advanced_mode boolean not null default true;");
    ok(on !== MIG_TEXT(), "(mutant built: default true)");
    let r = await refused(db, on, /advanced_mode is not boolean NOT NULL DEFAULT false/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "a column that would switch Advanced on for everyone: refused, and nothing of 270 is left", JSON.stringify(r));
    await db.close();

    // A nullable leftover from a hand-run experiment: the re-run path must not accept it.
    db = await fresh();
    await db.exec("alter table public.client_settings add column advanced_mode boolean");
    r = await refused(db, MIG_TEXT(), /advanced_mode is not boolean NOT NULL DEFAULT false/);
    ok(r.matched && !r.helper && !r.spliced, "a nullable advanced_mode already there: refused, no helper, no splice", JSON.stringify(r));
    await db.close();

    // The table open to the browser: adding a column to it would publish the column too.
    db = await fresh();
    await db.exec("grant select on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated can read or write client_settings\.advanced_mode/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "client_settings readable by authenticated: refused, and nothing of 270 is left", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: portal-settings' save would fail on every builder.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role cannot read and write client_settings\.advanced_mode/);
    ok(r.matched && !r.helper && !r.spliced && !r.column, "service_role without UPDATE: refused, and nothing of 270 is left", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  // exitCode, not process.exit(): on Windows, exiting that way after the .ts import above trips a
  // libuv assertion (UV_HANDLE_CLOSING) and the process dies with 127 right after printing a pass.
  // Every PGlite here is closed, so the event loop drains and the process ends on its own.
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
