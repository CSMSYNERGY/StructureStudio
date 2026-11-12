// Execute migrations 386, 387 and 388 for real in PGlite (Postgres compiled to WASM, in memory),
// then check what 388 (the server's rollout switch for plans as data) promises:
//   * access_for_server answers null for every company until it is named for the server;
//   * a company named in server_report gets { mode: "report", modules }, one named in server_clients
//     gets { mode: "block", modules }, block wins when it is in both, and server_all blocks everyone;
//   * naming a company for the PORTAL (387's `clients`, or `all`) does NOT switch the server on;
//   * a missing row, malformed values and a null id all read as null;
//   * no browser role can execute it; a re-apply changes nothing.
// Nothing here touches the live project: no network, no Supabase. Tenants are made up (public repo).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration388.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { STUBS } = require("./accessStubs.cjs");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const SQL388 = read("388_access_server_switch.sql");

const SEED = `
insert into public.billing_plans (id, feature, name, billing_interval)
select f || '_annual', f, f, 'annual'
  from unnest(array['simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing',
                    'smartbuild_sync', 'project_management', 'crm', 'full_suite', 'self_serve_displays']) f;
insert into public.client_settings (client_id) values ('acme-sheds'), ('ridge-co');
insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end) values
  ('s1', 'acme-sheds', 'crm_annual', 'active', now() + interval '200 days');
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
  await db.exec(read("386_access_plans.sql"));
  await db.exec(read("387_access_rollout.sql"));
  await db.exec(SQL388);

  const priv = await rows(db, `select has_function_privilege('anon', 'public.access_for_server(text)', 'execute') a,
    has_function_privilege('authenticated', 'public.access_for_server(text)', 'execute') b,
    has_function_privilege('service_role', 'public.access_for_server(text)', 'execute') c`);
  ok("browser roles cannot execute access_for_server; service_role can", priv[0].a === false && priv[0].b === false && priv[0].c === true, JSON.stringify(priv[0]));

  const server = async (c) => (await rows(db, "select public.access_for_server($1) a", [c]))[0].a;
  const portal = async (c) => (await rows(db, "select public.access_for_portal($1) a", [c]))[0].a;
  const resolved = async (c) => (await rows(db, "select public.access_resolve($1) m", [c]))[0].m;
  const setEnforce = (v) => db.query("update public.access_config set value = $1::jsonb where key = 'enforce'", [JSON.stringify(v)]);

  ok("nobody named: null", (await server("acme-sheds")) === null);

  await setEnforce({ all: false, clients: ["acme-sheds"] });
  ok("named for the PORTAL only: the server answer is still null", (await server("acme-sheds")) === null && (await portal("acme-sheds")).enforced === true);
  await setEnforce({ all: true, clients: [] });
  ok("the portal's `all` does not switch the server on either", (await server("acme-sheds")) === null);

  await setEnforce({ all: false, clients: [], server_report: ["acme-sheds"] });
  let a = await server("acme-sheds");
  ok("named in server_report: report, with the resolver's answer", a && a.mode === "report" && JSON.stringify(a.modules) === JSON.stringify(await resolved("acme-sheds")), JSON.stringify(a && a.mode));
  ok("…and the portal is not switched on by it", (await portal("acme-sheds")).enforced === false);
  ok("…and another company is untouched", (await server("ridge-co")) === null);

  await setEnforce({ all: false, clients: [], server_clients: ["acme-sheds"] });
  a = await server("acme-sheds");
  ok("named in server_clients: block", a && a.mode === "block" && a.modules.contacts === "on" && a.modules.build_schedule === "locked", JSON.stringify(a && a.mode));

  await setEnforce({ all: false, clients: [], server_clients: ["acme-sheds"], server_report: ["acme-sheds", "ridge-co"] });
  ok("in both lists: block wins", (await server("acme-sheds")).mode === "block" && (await server("ridge-co")).mode === "report");

  await setEnforce({ all: false, clients: [], server_all: true, server_report: ["ridge-co"] });
  ok("server_all: everyone is blocked by the map, a reported company included", (await server("acme-sheds")).mode === "block" && (await server("ridge-co")).mode === "block");
  ok("…an unknown company too (every tab hidden)", Object.values((await server("nobody-here")).modules).every((s) => s === "hidden"));
  ok("a null id is never enforced, even under server_all", (await server(null)) === null);

  for (const [name, v] of [
    ["server_all as a string", { server_all: "true" }], ["server_clients as a string", { server_clients: "acme-sheds" }],
    ["server_clients as an object", { server_clients: { "acme-sheds": true } }], ["server_report as a string", { server_report: "acme-sheds" }],
    ["an empty object", {}], ["a bare array", ["acme-sheds"]], ["server_all as 1", { server_all: 1 }],
  ]) {
    await setEnforce(v);
    ok(`malformed (${name}) reads as null`, (await server("acme-sheds")) === null);
  }
  await db.exec("delete from public.access_config where key = 'enforce'");
  ok("a missing row reads as null", (await server("acme-sheds")) === null);

  // The rehearsal's own promise: a company named only for the portal never reads as enforced here.
  await db.exec(`insert into public.access_config (key, value) values ('enforce', '{"all": false, "clients": ["acme-sheds", "ridge-co"], "server_report": ["ridge-co"]}')`);
  let reapply = "ok";
  try { await db.exec(SQL388); } catch (e) { reapply = String(e.message); }
  ok("a re-apply passes its rehearsal with companies named, and changes no row", reapply === "ok"
    && JSON.stringify((await rows(db, "select value from public.access_config where key = 'enforce'"))[0].value.clients) === JSON.stringify(["acme-sheds", "ridge-co"]), reapply);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
