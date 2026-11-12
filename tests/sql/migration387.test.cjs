// Execute migrations 386 and 387 for real in PGlite (Postgres compiled to WASM, in memory), then
// check what 387 (the rollout switch for plans as data) promises:
//   * access_config exists, is service-role only, and starts with nobody enforced;
//   * access_for_portal answers { enforced: false, modules: null } for every company until it is
//     named, { enforced: true, modules: <the resolver's answer> } once it is, and the same for
//     everyone when `all` is true;
//   * a missing row, a malformed value, an unknown company and a null id all read as NOT enforced;
//   * no browser role can execute it; a re-apply resets nothing.
// Nothing here touches the live project: no network, no Supabase. Tenants are made up (public repo).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration387.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { STUBS } = require("./accessStubs.cjs");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const SQL386 = read("386_access_plans.sql");
const SQL387 = read("387_access_rollout.sql");

const SEED = `
insert into public.billing_plans (id, feature, name, billing_interval)
select f || '_annual', f, f, 'annual'
  from unnest(array['simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing',
                    'smartbuild_sync', 'project_management', 'crm', 'full_suite', 'self_serve_displays']) f;
insert into public.client_settings (client_id) values ('acme-sheds'), ('ridge-co');
insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end) values
  ('s1', 'acme-sheds', 'crm_annual', 'active', now() + interval '200 days'),
  ('s2', 'ridge-co', 'simple_layout_annual', 'active', now() + interval '200 days');
`;

let failed = 0;
const ok = (name, pass, note) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "   [" + note + "]" : ""}`);
  if (!pass) failed++;
};
const rows = async (db, q, p) => (await db.query(q, p)).rows;

(async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  await db.exec(SQL386);
  await db.exec(SQL387);

  const rls = await rows(db, "select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'access_config'");
  ok("access_config exists with RLS on", rls.length === 1 && rls[0].relrowsecurity === true);
  const pol = await rows(db, "select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'access_config'");
  const gr = await rows(db, `select count(*)::int n from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'access_config' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  ok("…no policy and no browser grant", pol[0].n === 0 && gr[0].n === 0, `${pol[0].n} policies, ${gr[0].n} grants`);
  const priv = await rows(db, `select has_function_privilege('anon', 'public.access_for_portal(text)', 'execute') a,
    has_function_privilege('authenticated', 'public.access_for_portal(text)', 'execute') b,
    has_function_privilege('service_role', 'public.access_for_portal(text)', 'execute') c`);
  ok("browser roles cannot execute access_for_portal; service_role can", priv[0].a === false && priv[0].b === false && priv[0].c === true, JSON.stringify(priv[0]));
  const start = await rows(db, "select value from public.access_config where key = 'enforce'");
  ok("it starts with nobody enforced", start[0].value.all === false && Array.isArray(start[0].value.clients) && start[0].value.clients.length === 0, JSON.stringify(start[0].value));

  const portal = async (c) => (await rows(db, "select public.access_for_portal($1) a", [c]))[0].a;
  const resolved = async (c) => (await rows(db, "select public.access_resolve($1) m", [c]))[0].m;
  const setEnforce = (v) => db.query("update public.access_config set value = $1::jsonb where key = 'enforce'", [JSON.stringify(v)]);

  let a = await portal("acme-sheds");
  ok("not named: enforced false, modules null", a.enforced === false && a.modules === null, JSON.stringify(a));

  await setEnforce({ all: false, clients: ["acme-sheds"] });
  a = await portal("acme-sheds");
  ok("named: enforced true, and modules is the resolver's answer", a.enforced === true && JSON.stringify(a.modules) === JSON.stringify(await resolved("acme-sheds")));
  ok("…with the company's own tabs in it", a.modules.contacts === "on" && a.modules.build_schedule === "locked" && a.modules.jack === "hidden", JSON.stringify(a.modules));
  const b = await portal("ridge-co");
  ok("…and another company is untouched", b.enforced === false && b.modules === null, JSON.stringify(b));
  ok("a company id that only starts the same is not named", (await portal("acme")).enforced === false && (await portal("acme-sheds-2")).enforced === false);

  await setEnforce({ all: true, clients: [] });
  ok("all: every company is enforced", (await portal("ridge-co")).enforced === true && (await portal("acme-sheds")).enforced === true);
  const unknown = await portal("nobody-here");
  ok("…an unknown company too, with nothing on", unknown.enforced === true && Object.values(unknown.modules).every((s) => s === "hidden"), JSON.stringify(unknown.enforced));
  ok("a null id is never enforced, even under all", (await portal(null)).enforced === false);

  // ── granted: what opens the billing gate for a company with no card subscription ──────────
  // Enforced AND an operator gave it something directly. Never "has a tab on": a 3D comp or a phone
  // switch did not open the gate before.
  await db.exec(`
    insert into public.client_settings (client_id, phone_status) values ('gate-none', 'on'), ('gate-plan', 'off'), ('gate-ended', 'off'),
      ('gate-draft', 'off'), ('gate-tab', 'off'), ('gate-tab-off', 'off'), ('gate-tab-ended', 'off'), ('gate-not-named', 'off');
    insert into public.client_feature_grants (client_id, feature) values ('gate-none', 'view_3d');
    insert into public.access_plans (key, name, status) values ('wip_plan', 'Not ready', 'draft');
    insert into public.client_access_plans (client_id, plan_key, expires_at) values
      ('gate-plan', 'phone_contacts', null), ('gate-ended', 'phone_contacts', now() - interval '1 day'),
      ('gate-draft', 'wip_plan', null), ('gate-not-named', 'phone_contacts', null);
    insert into public.client_modules (client_id, module, mode, expires_at) values
      ('gate-tab', 'jack', 'on', null), ('gate-tab-off', 'jack', 'off', null), ('gate-tab-ended', 'jack', 'on', now() - interval '1 hour');
  `);
  await setEnforce({ all: false, clients: ["gate-none", "gate-plan", "gate-ended", "gate-draft", "gate-tab", "gate-tab-off", "gate-tab-ended", "acme-sheds"] });
  const granted = async (c) => (await portal(c)).granted;
  const none = await portal("gate-none");
  ok("a 3D comp and a phone switch turn tabs on but are NOT granted", none.granted === false && none.modules.view_3d === "on" && none.modules.phone === "on", JSON.stringify({ g: none.granted, v: none.modules.view_3d, p: none.modules.phone }));
  ok("a card subscription alone is not `granted` either (the gate already sees it)", (await granted("acme-sheds")) === false);
  ok("an assigned plan is granted", (await granted("gate-plan")) === true);
  ok("…until it ends", (await granted("gate-ended")) === false);
  ok("…and a draft plan grants nothing", (await granted("gate-draft")) === false);
  ok("a tab switched on is granted", (await granted("gate-tab")) === true);
  ok("…a tab switched OFF is not, and neither is an ended one", (await granted("gate-tab-off")) === false && (await granted("gate-tab-ended")) === false);
  const notNamed = await portal("gate-not-named");
  ok("a company that is not enforced is never granted, whatever it was assigned", notNamed.enforced === false && notNamed.granted === false && notNamed.modules === null, JSON.stringify(notNamed));
  ok("a null id is never granted", (await portal(null)).granted === false);

  // Malformed values read as NOT enforced: the switch can only move a company onto the map by naming it.
  for (const [name, v] of [
    ["all as a string", { all: "true", clients: [] }], ["clients as a string", { all: false, clients: "acme-sheds" }],
    ["clients as an object", { all: false, clients: { "acme-sheds": true } }], ["an empty object", {}],
    ["a bare array", ["acme-sheds"]], ["all as 1", { all: 1, clients: [] }],
  ]) {
    await setEnforce(v);
    const r = await portal("acme-sheds");
    ok(`malformed (${name}) reads as not enforced`, r.enforced === false && r.modules === null, JSON.stringify(r));
  }
  await db.exec("delete from public.access_config where key = 'enforce'");
  ok("a missing row reads as not enforced", (await portal("acme-sheds")).enforced === false);

  // A re-apply puts the row back when it is missing and resets nothing when it is there.
  await db.exec(SQL387);
  ok("a re-apply restores a missing row to nobody enforced", (await rows(db, "select value from public.access_config where key = 'enforce'"))[0].value.clients.length === 0);
  await setEnforce({ all: false, clients: ["acme-sheds", "ridge-co"] });
  await db.exec(SQL387);
  ok("a re-apply does not reset who is enforced", (await rows(db, "select value from public.access_config where key = 'enforce'"))[0].value.clients.length === 2);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
