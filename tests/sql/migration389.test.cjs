// Execute migrations 386 to 389 for real in PGlite (Postgres compiled to WASM, in memory), with
// get_public_shop built from 314's own statement (the live body, md5-checked below), then check what
// 389 (the public side of plans as data) promises:
//   * access_for_public answers null for every company until it is named for the SERVER (388's
//     lists); naming it for the portal does nothing; a malformed value, a missing row, a null id are
//     all null;
//   * the public rule, company by company: a tab is blocked when it is "off", or when the company
//     HOLDS a plan and the tab is not "on". A lapsed builder (holds nothing) keeps its public pages;
//   * "holds a plan" comes from what the company HOLDS (386's own rule: a usable subscription, an
//     unexpired assignment, a running free period, ours / Non-billable, phone-only), never from
//     which reasons survived on its tabs: the same plan gives the same answer whether its tabs are
//     claimed by the plan, by an older switch, by an operator's ON or by the no-sheds shape;
//   * report mode works the answer out and blocks nothing in the database;
//   * access_public_blocked cannot raise: nulls, an unknown tab, an unknown company, and a plan read
//     that is broken outright all answer false, and the shop still loads;
//   * no browser role can execute either function, and anon can still load a shop;
//   * get_public_shop is changed by exactly one condition: an unnamed company's shop answers the
//     SAME json as before, a blocked one answers the not_found a switched-off shop answers, a
//     report-mode one is unchanged;
//   * a re-apply changes nothing; a live body where the line is missing or doubled stops the apply
//     and leaves nothing behind; a splice that moves anything else stops it too;
//   * a shop edited while the file applies stops it with a message that says so (and that applying
//     again is safe), not one that blames the splice;
//   * the apply itself closes no shop: with a company ALREADY named in block mode whose open shop it
//     would close, it stops and names the company, unless the apply was told the exact count;
//   * the header's COST note: a named company's subscriptions are read twice per call (once in the
//     resolver, once for holds), and a company that is not named reads none;
//   * the header's "look first" query runs and shows what a named company's customers would lose;
//   * the header's rollback leaves exactly the body it started from, and the file applies again.
// Nothing here touches the live project: no network, no Supabase. Tenants are made up (public repo).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration389.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { STUBS } = require("./accessStubs.cjs");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const SQL389 = read("389_access_public.sql");

// get_public_shop as it is LIVE. The body dumped on 2026-11-13 is 314's statement unchanged, so the
// statement is lifted from that file (only the statement: the file's tail calls the function).
const LIVE_DEF = { length: 5111, md5: "173586fb0d1bfb62659a6cb4b2355704" };
// ...and the body 389's header says it leaves behind.
const SPLICED_DEF = { length: 5169, md5: "c9032d3d7f9f726a5505012f18dba4d6" };
const SHOP_314 = (() => {
  const t = fs.readFileSync(path.join(WT, "supabase/migrations/314_shop_included_items.sql"), "utf8").replace(/\r/g, "");
  const i = t.indexOf("create or replace function public.get_public_shop(p_client_id text)");
  const j = t.indexOf("\n$$;", i);
  if (i < 0 || j < 0) throw new Error("314's get_public_shop statement moved; re-point SHOP_314");
  return t.slice(i, j + "\n$$;".length);
})();
const ANCHOR = "if not found or not v_shop.enabled then";
const SPLICED = "if not found or not v_shop.enabled or public.access_public_blocked(p_client_id, 'inventory') then";

// The tables get_public_shop reads, with only the columns it names. Kept here, not in accessStubs.cjs:
// that file is also the stand-in for the live parity run, which has the real tables.
const SHOP_STUBS = `
alter table public.client_settings add column cardpointe_merchid text;
create table public.shop_settings (
  client_id text primary key, enabled boolean not null default false, hide_all_prices boolean not null default false,
  deposit_mode text not null default 'percent', deposit_value numeric(10,2) not null default 10,
  allow_pay_in_full boolean not null default true, gtm_container_id text, heading text, intro text, terms_url text
);
create table public.client_configs (client_id text primary key, company_name text, tagline text, logo_url text, header_bg text, accent_color text);
create table public.designs (short_code text primary key, client_id text not null, selections jsonb, paint_colors jsonb, items jsonb);
create table public.builder_locations (id uuid primary key, name text, city text, state text);
create table public.building_styles (client_id text not null, key text not null, label text);
create table public.client_layout_items (client_id text not null, item_key text not null, label_override text);
create table public.electrical_items (id uuid primary key, client_id text not null, name text);
create table public.inventory_units (
  id uuid primary key, client_id text not null, serial integer, public_title text, public_description text,
  design_short_code text, location_id uuid, show_price_online boolean not null default true, asking_price_cents integer,
  sale_state text not null default 'unsold', sold_at timestamptz, created_at timestamptz not null default now(), listed boolean not null default true
);
create table public.inventory_unit_photos (unit_id uuid not null, storage_key text not null, sort_order integer not null default 0, created_at timestamptz not null default now());
`;
// 310's grants: closed to PUBLIC, open to the three roles a page or a function calls it as.
const SHOP_GRANTS = `
revoke execute on function public.get_public_shop(text) from public;
grant execute on function public.get_public_shop(text) to anon, authenticated, service_role;
`;

const SEED = `
insert into public.billing_plans (id, feature, name, billing_interval)
select f || '_annual', f, f, 'annual'
  from unnest(array['simple_layout', 'schedule_builds', 'view_3d', 'quickbooks_sync', 'on_demand_pricing',
                    'smartbuild_sync', 'project_management', 'crm', 'full_suite', 'self_serve_displays']) f;
-- acme-sheds holds the Customer Hub. base-only holds the base plan and nothing else. Everyone else
-- on this line has never paid or has lapsed: they hold nothing.
insert into public.client_settings (client_id) values
  ('acme-sheds'), ('base-only'), ('ridge-co'), ('lapsed-off'), ('lapsed-on'), ('exc-expired'),
  ('assigned-co'), ('assigned-expired'), ('teaser-co');
insert into public.client_settings (client_id, jack_on, phone_status) values ('lapsed-switch', true, 'on');
-- Held plans whose tabs an EARLIER resolver step claims (their rows are in AFTER_386). sw-off,
-- sw-on and sw-exc are on the same assigned plan; only sw-on has the two older switches on too.
insert into public.client_settings (client_id) values
  ('sw-off'), ('sw-exc'), ('draft-co'), ('retired-co'), ('bare-co'), ('sub-draft');
insert into public.client_settings (client_id, jack_on, phone_status) values ('sw-on', true, 'on');
insert into public.client_settings (client_id, sheds_enabled) values ('post-frame-lot', false);
insert into public.client_settings (client_id, phone_only, sheds_enabled, phone_status) values ('phone-co', true, false, 'on');
insert into public.client_settings (client_id, sheds_enabled) values ('post-frame', false), ('post-frame-lapsed', false);
insert into public.client_settings (client_id, billing_exempt) values ('demo-co', true);
insert into public.client_settings (client_id, internal_account) values ('our-own', true);
insert into public.client_settings (client_id, billing_exempt_until) values
  ('free-period', now() + interval '10 days'), ('free-ended', now() - interval '1 day');
insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at) values
  ('s1', 'acme-sheds', 'crm_annual',           'active',    now() + interval '200 days', null),
  ('s2', 'base-only',  'simple_layout_annual', 'active',    now() + interval '200 days', null),
  ('s3', 'post-frame', 'crm_annual',           'active',    now() + interval '200 days', null),
  ('s4', 'ridge-co',   'crm_annual',           'cancelled', now() - interval '400 days', now() - interval '400 days');
insert into public.client_feature_grants (client_id, feature, expires_at) values ('lapsed-switch', 'view_3d', null);
`;
// Rows on 386's own tables.
const AFTER_386 = `
insert into public.client_modules (client_id, module, mode, expires_at) values
  ('lapsed-off',  'inventory', 'off', null),
  ('lapsed-on',   'forms',     'on',  null),
  ('exc-expired', 'inventory', 'off', now() - interval '1 hour');
insert into public.client_access_plans (client_id, plan_key, reason, expires_at) values
  ('assigned-co',      'crm', 'paid_offline', null),
  ('assigned-expired', 'crm', 'comp',         now() - interval '1 day');
-- A custom plan that TEASES meetings (no starting plan teases one of the three public tabs).
insert into public.access_plans (key, name, visibility) values ('gutters_basic', 'Gutters Basic', 'private');
insert into public.access_plan_modules (plan_key, module, state) values
  ('gutters_basic', 'contacts', 'included'), ('gutters_basic', 'forms', 'included'), ('gutters_basic', 'meetings', 'teaser');
insert into public.client_access_plans (client_id, plan_key) values ('teaser-co', 'gutters_basic');
-- A custom plan made ONLY of tabs that have an older switch of their own (jack_on, phone_status).
-- sw-off has its tabs through the plan, sw-on through the switches, sw-exc through an operator's ON
-- on each tab: one plan, three reasons, and it must read as held all three times.
insert into public.access_plans (key, name, visibility) values
  ('jack_phone', 'Jack and Phone', 'private'), ('lot_only', 'Lot Only', 'private'), ('bare_plan', 'Bare Plan', 'private');
insert into public.access_plans (key, name, visibility, status) values
  ('draft_one', 'Draft One', 'private', 'draft'), ('old_hub', 'Old Hub', 'private', 'retired');
insert into public.access_plan_modules (plan_key, module, state) values
  ('jack_phone', 'jack', 'included'), ('jack_phone', 'phone', 'included'),
  ('lot_only', 'inventory', 'included'),
  ('draft_one', 'forms', 'included'),
  ('old_hub', 'contacts', 'included'), ('old_hub', 'forms', 'included');
-- lot_only's one tab is a shed tab and post-frame-lot sells no sheds, so the shape claims it.
-- bare_plan has no tab rows at all. draft_one is a draft: assigned or subscribed to, it is not held.
-- old_hub is retired: still held by whoever has it.
insert into public.client_access_plans (client_id, plan_key) values
  ('sw-off', 'jack_phone'), ('sw-on', 'jack_phone'), ('sw-exc', 'jack_phone'),
  ('post-frame-lot', 'lot_only'), ('draft-co', 'draft_one'), ('retired-co', 'old_hub'), ('bare-co', 'bare_plan'),
  ('no-settings-co', 'jack_phone');   -- a company with no client_settings row at all
insert into public.client_modules (client_id, module, mode) values ('sw-exc', 'jack', 'on'), ('sw-exc', 'phone', 'on');
insert into public.billing_plans (id, feature, name, billing_interval) values ('draft_one_annual', 'draft_one', 'draft_one', 'annual');
insert into public.billing_subscriptions (id, client_id, plan_id, status, current_period_end, canceled_at) values
  ('s5', 'sub-draft', 'draft_one_annual', 'active', now() + interval '200 days', null);
`;
// Whether each seeded company HOLDS a plan, written out by hand from the seed above: the answer
// 389 must give, not one worked out from the resolver's reasons or from 389's own SQL.
const HOLDS = {
  "acme-sheds": true, "base-only": true, "post-frame": true,             // a usable subscription
  "assigned-co": true, "teaser-co": true, "retired-co": true,            // an operator's assignment (a retired plan is still held)
  "sw-off": true, "sw-on": true, "sw-exc": true, "post-frame-lot": true, // ...whichever resolver step claims its tabs
  "bare-co": true,                                                       // ...and even when the plan has no tab rows
  "free-period": true, "demo-co": true, "our-own": true, "phone-co": true,
  "ridge-co": false, "lapsed-off": false, "lapsed-on": false, "exc-expired": false, "lapsed-switch": false,
  "post-frame-lapsed": false, "assigned-expired": false, "free-ended": false,
  "draft-co": false, "sub-draft": false,                                 // a draft plan confers nothing, assigned or paid for
};
const SHOPS = ["acme-sheds", "ridge-co", "lapsed-off", "phone-co", "post-frame-lapsed", "exc-expired"];
const SHOP_SEED = `
insert into public.client_configs (client_id, company_name, tagline, accent_color)
select c, initcap(replace(c, '-', ' ')), 'Built to last', '#225577' from unnest(array[${SHOPS.map((c) => `'${c}'`).join(", ")}, 'shop-off']) c;
insert into public.shop_settings (client_id, enabled, heading)
select c, true, 'On the lot now' from unnest(array[${SHOPS.map((c) => `'${c}'`).join(", ")}]) c;
insert into public.shop_settings (client_id, enabled) values ('shop-off', false);
insert into public.builder_locations (id, name, city, state) values ('00000000-0000-4000-8000-0000000000a1', 'Main lot', 'Springfield', 'OH');
insert into public.building_styles (client_id, key, label) values ('acme-sheds', 'barn', 'Lofted Barn');
insert into public.designs (short_code, client_id, selections, paint_colors, items)
select 'D' || row_number() over (), c, '{"style": "barn", "size": "10x16", "roofType": "metal", "cladding": "lp"}'::jsonb, '{"body": "Red"}'::jsonb,
       '[{"id": "i1", "type": "door", "doorName": "Double door", "widthFt": 6}, {"id": "i2", "type": "textNote"}]'::jsonb
  from unnest(array[${SHOPS.map((c) => `'${c}'`).join(", ")}]) c;
insert into public.inventory_units (id, client_id, serial, public_title, design_short_code, location_id, asking_price_cents, created_at)
select ('00000000-0000-4000-8000-00000000010' || row_number() over ())::uuid, d.client_id, 4000 + row_number() over (), 'Lofted barn, ready now',
       d.short_code, '00000000-0000-4000-8000-0000000000a1', 549900, '2026-11-01T12:00:00Z'
  from public.designs d;
insert into public.inventory_unit_photos (unit_id, storage_key) select u.id, u.client_id || '/front.jpg' from public.inventory_units u;
`;

let failed = 0;
const ok = (name, pass, note) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "   [" + note + "]" : ""}`);
  if (!pass) failed++;
};
const rows = async (db, q, p) => (await db.query(q, p)).rows;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NOT_FOUND = { ok: false, reason: "not_found" };

/** A database as it stands before 389: 386 to 388 applied, the shop tables seeded, get_public_shop as live
 *  (or `shopBody`, a deliberately different one). */
async function before389(shopBody) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  await db.exec(read("386_access_plans.sql"));
  await db.exec(AFTER_386);
  await db.exec(read("387_access_rollout.sql"));
  await db.exec(read("388_access_server_switch.sql"));
  await db.exec(SHOP_STUBS);
  await db.exec(SHOP_SEED);
  await db.exec(shopBody || SHOP_314);
  await db.exec(SHOP_GRANTS);
  return db;
}
const helpers = (db) => ({
  pub: async (c) => (await rows(db, "select public.access_for_public($1) a", [c]))[0].a,
  blocked: async (c, m) => (await rows(db, "select public.access_public_blocked($1, $2) b", [c, m]))[0].b,
  shop: async (c) => (await rows(db, "select public.get_public_shop($1) s", [c]))[0].s,
  def: async () => (await rows(db, "select pg_get_functiondef('public.get_public_shop(text)'::regprocedure) d, md5(pg_get_functiondef('public.get_public_shop(text)'::regprocedure)) m"))[0],
  setEnforce: (v) => db.query("update public.access_config set value = $1::jsonb where key = 'enforce'", [JSON.stringify(v)]),
  apply: async (sql) => { try { await db.exec(sql); return "ok"; } catch (e) { return String(e.message); } },
});
const block = (...c) => ({ all: false, clients: [], server_clients: c });

(async () => {
  const db = await before389();
  const { pub, blocked, shop, def, setEnforce, apply } = helpers(db);

  // ── the body this test splices is the live one ──────────────────────────────────────────────
  const live = await def();
  ok("get_public_shop here is the body dumped live (length and md5)", live.d.length === LIVE_DEF.length && live.m === LIVE_DEF.md5, `${live.d.length} ${live.m}`);
  ok("…and the line to change is in it exactly once", live.d.split(ANCHOR).length - 1 === 1);
  const shopsBefore = {};
  for (const c of [...SHOPS, "shop-off", "nobody-here"]) shopsBefore[c] = await shop(c);
  ok("before 389: an open shop answers its units, a switched-off or unknown one answers not_found",
    shopsBefore["acme-sheds"].ok === true && shopsBefore["acme-sheds"].units.length === 1 && shopsBefore["acme-sheds"].units[0].included.length === 1
    && same(shopsBefore["shop-off"], NOT_FOUND) && same(shopsBefore["nobody-here"], NOT_FOUND), JSON.stringify(shopsBefore["acme-sheds"]).slice(0, 120));

  ok("389 applies", (await apply(SQL389)) === "ok");
  const spliced = await def();
  ok("the body is the live one with exactly that one line changed", spliced.d === live.d.replace(ANCHOR, SPLICED), `${spliced.d.length} ${spliced.m}`);
  ok("…and it is the body 389's header says it writes (length and md5)", spliced.d.length === SPLICED_DEF.length && spliced.m === SPLICED_DEF.md5, `${spliced.d.length} ${spliced.m}`);

  // ── who may call what ───────────────────────────────────────────────────────────────────────
  const priv = (await rows(db, `select
    has_function_privilege('anon', 'public.access_for_public(text)', 'execute') a1,
    has_function_privilege('authenticated', 'public.access_for_public(text)', 'execute') a2,
    has_function_privilege('service_role', 'public.access_for_public(text)', 'execute') a3,
    has_function_privilege('anon', 'public.access_public_blocked(text, text)', 'execute') b1,
    has_function_privilege('authenticated', 'public.access_public_blocked(text, text)', 'execute') b2,
    has_function_privilege('anon', 'public.get_public_shop(text)', 'execute') s1,
    has_function_privilege('authenticated', 'public.get_public_shop(text)', 'execute') s2`))[0];
  ok("browser roles cannot execute access_for_public or access_public_blocked; service_role reads the first", !priv.a1 && !priv.a2 && priv.a3 === true && !priv.b1 && !priv.b2, JSON.stringify(priv));
  ok("anon and authenticated can still execute get_public_shop", priv.s1 === true && priv.s2 === true);
  const asAnon = async (q, p) => {
    await db.exec("set role anon");
    try { return { rows: await rows(db, q, p) }; } catch (e) { return { error: String(e.message) }; } finally { await db.exec("reset role"); }
  };
  ok("as anon, asking either function directly is refused", /permission denied/.test((await asAnon("select public.access_for_public('acme-sheds')")).error || "")
    && /permission denied/.test((await asAnon("select public.access_public_blocked('acme-sheds', 'inventory')")).error || ""));

  // ── nobody named ────────────────────────────────────────────────────────────────────────────
  const tabs = (await rows(db, "select key from public.access_modules order by sort")).map((r) => r.key);
  ok("the catalogue has its 33 tabs", tabs.length === 33, String(tabs.length));
  let anyBlocked = 0;
  for (const c of ["acme-sheds", "phone-co", "lapsed-off", "nobody-here"]) {
    for (const t of tabs) if ((await blocked(c, t)) !== false) anyBlocked++;
  }
  ok("nobody named: null, and nothing is blocked for anyone on any tab", (await pub("acme-sheds")) === null && (await pub("phone-co")) === null && anyBlocked === 0, String(anyBlocked));
  const moved = [];
  for (const c of [...SHOPS, "shop-off", "nobody-here"]) if (!same(await shop(c), shopsBefore[c])) moved.push(c);
  ok("nobody named: every shop answers the SAME json as before the splice", moved.length === 0, moved.join(","));

  await setEnforce({ all: false, clients: ["phone-co", "lapsed-off"] });
  ok("named for the PORTAL only: null here, nothing blocked, the shop unchanged", (await pub("phone-co")) === null && (await blocked("phone-co", "inventory")) === false
    && same(await shop("phone-co"), shopsBefore["phone-co"]));
  await setEnforce({ all: true, clients: [] });
  ok("the portal's `all` does not name anyone here either", (await pub("lapsed-off")) === null && (await blocked("lapsed-off", "inventory")) === false);

  // ── report mode: worked out, never blocked in the database ──────────────────────────────────
  await setEnforce({ all: false, clients: [], server_report: ["phone-co", "lapsed-off"] });
  let a = await pub("phone-co");
  ok("report mode: the answer is worked out (mode report, inventory blocked, every tab present)", a && a.mode === "report" && a.holds === true && a.blocked.inventory === true
    && same(Object.keys(a.blocked).sort(), [...tabs].sort()) && Object.values(a.blocked).every((v) => typeof v === "boolean"), JSON.stringify(a && a.mode));
  ok("…but access_public_blocked is false, and the shop is unchanged", (await blocked("phone-co", "inventory")) === false && (await blocked("lapsed-off", "inventory")) === false
    && same(await shop("phone-co"), shopsBefore["phone-co"]) && same(await shop("lapsed-off"), shopsBefore["lapsed-off"]));
  ok("…and a company not in the list is still null", (await pub("acme-sheds")) === null);

  // ── block mode: the public rule, company by company ─────────────────────────────────────────
  await setEnforce({ all: false, clients: [], server_all: true });
  const state = async (c) => (await rows(db, "select public.access_resolve($1) m", [c]))[0].m;
  const want = async (name, c, holds, expect) => {
    const p = await pub(c);
    const got = Object.fromEntries(Object.keys(expect).map((t) => [t, p.blocked[t]]));
    let helperAgrees = true;
    for (const t of Object.keys(expect)) if ((await blocked(c, t)) !== expect[t]) helperAgrees = false;
    ok(name, p.mode === "block" && p.holds === holds && same(got, expect) && helperAgrees, `holds ${p.holds} ${JSON.stringify(got)}`);
  };
  await want("holds the Customer Hub: shop, forms and meetings open; a padlocked tab (build schedule) is blocked", "acme-sheds", true,
    { inventory: false, forms: false, meetings: false, contacts: false, build_schedule: true, jack: true });
  await want("holds the base plan only: the shop is open, forms and meetings (not in the plan) are blocked, and so is the teased contact list", "base-only", true,
    { inventory: false, forms: true, meetings: true, contacts: true });
  const ridge = await state("ridge-co");
  ok("the lapsed builder resolves its tabs hidden (which the SERVER rule would refuse)", ridge.inventory === "hidden" && ridge.forms === "hidden" && ridge.meetings === "hidden");
  const lapsed = await pub("ridge-co");
  ok("lapsed (holds nothing): NOTHING is blocked for the public, on any tab", lapsed.mode === "block" && lapsed.holds === false && Object.values(lapsed.blocked).every((v) => v === false), JSON.stringify(lapsed.holds));
  await want("lapsed, with an operator's OFF on inventory: the shop is blocked and nothing else is", "lapsed-off", false,
    { inventory: true, forms: false, meetings: false, designer: false });
  await want("lapsed, with only older switches and a 3D comp: those are not a plan, nothing is blocked", "lapsed-switch", false,
    { inventory: false, forms: false, meetings: false, jack: false, view_3d: false, contacts: false });
  await want("lapsed, with an operator's ON for forms: an exception is not a plan either", "lapsed-on", false,
    { inventory: false, forms: false, meetings: false });
  await want("an expired OFF does not count: the shop stays open", "exc-expired", false, { inventory: false, forms: false, meetings: false });
  await want("a plan an operator assigned is held: its tabs are open and the rest are blocked", "assigned-co", true,
    { inventory: false, forms: false, meetings: false, build_schedule: true });
  await want("an assignment that has ended is not held", "assigned-expired", false, { inventory: false, forms: false, meetings: false });
  const teaser = await state("teaser-co");
  await want("a custom plan that TEASES meetings (locked): meetings is blocked, its included forms are open, the shop (not in the plan) is blocked", "teaser-co", true,
    { meetings: true, forms: false, contacts: false, inventory: true });
  ok("…and that tab really is the padlock state", teaser.meetings === "locked" && teaser.forms === "on" && teaser.inventory === "hidden", JSON.stringify([teaser.meetings, teaser.forms, teaser.inventory]));
  await want("phone-only: shop, forms and meetings are all blocked; its own three tabs are not", "phone-co", true,
    { inventory: true, forms: true, meetings: true, contacts: false, phone: false, sms: false });
  await want("sells no sheds, holds the Customer Hub: the shop is blocked by its shape, forms and meetings follow the plan", "post-frame", true,
    { inventory: true, designer: true, forms: false, meetings: false });
  await want("sells no sheds and lapsed: the shape's OFF still blocks the shop, and nothing else is blocked", "post-frame-lapsed", false,
    { inventory: true, forms: false, meetings: false, contacts: false });
  await want("Non-billable: every tab a public plan includes is open; what no plan sells (Jack) is not theirs", "demo-co", true,
    { inventory: false, forms: false, meetings: false, contacts: false, build_schedule: false, jack: true });
  await want("our own account: the same", "our-own", true, { inventory: false, forms: false, meetings: false });
  await want("inside a dated free period: holds the free plans, so the shop is open and forms are blocked", "free-period", true, { inventory: false, forms: true, meetings: true });
  await want("a free period that has ended is not held", "free-ended", false, { inventory: false, forms: false, meetings: false });

  // "Holds a plan" is what the company HOLDS, not which reasons survived on its tabs. The same
  // assigned plan (jack + phone, both tabs with an older switch of their own), three ways.
  const swOff = await pub("sw-off"), swOn = await pub("sw-on"), swExc = await pub("sw-exc");
  const why = async (c, t) => (await rows(db, "select source from public.access_resolve_detail($1) where module = $2", [c, t]))[0].source;
  ok("the switch-only plan really is claimed three different ways (the plan, the older switches, an operator's ON)",
    (await why("sw-off", "jack")) === "assigned:jack_phone" && (await why("sw-off", "phone")) === "assigned:jack_phone"
    && (await why("sw-on", "jack")) === "switch:jack_on" && (await why("sw-on", "phone")) === "switch:phone_status"
    && (await why("sw-exc", "jack")) === "exception" && (await why("sw-exc", "phone")) === "exception");
  await want("a plan made only of switch-backed tabs, switches OFF: held, so shop, forms and meetings are blocked", "sw-off", true,
    { inventory: true, forms: true, meetings: true, jack: false, phone: false, contacts: true });
  await want("the SAME plan with the older switches ON: still held, the same answers", "sw-on", true,
    { inventory: true, forms: true, meetings: true, jack: false, phone: false, contacts: true });
  await want("the SAME plan with an operator's ON on each of its tabs: still held, the same answers", "sw-exc", true,
    { inventory: true, forms: true, meetings: true, jack: false, phone: false, contacts: true });
  ok("…and all three answer the SAME thing on every one of the 33 tabs", same(swOff, swOn) && same(swOff, swExc) && Object.keys(swOff.blocked).length === 33,
    `${swOff.holds} ${swOn.holds} ${swExc.holds}`);
  await want("sells no sheds, on a plan of shed tabs only (the shape claims every tab of it): still held", "post-frame-lot", true,
    { inventory: true, forms: true, meetings: true });
  await want("a retired plan is still held by whoever has it", "retired-co", true, { forms: false, contacts: false, inventory: true, meetings: true });
  await want("a held plan with no tab rows at all is still held: every tab that is not on is blocked", "bare-co", true,
    { inventory: true, forms: true, meetings: true });
  await want("a company with no settings row holds what it was assigned, like any other", "no-settings-co", true,
    { inventory: true, forms: true, meetings: true, jack: false, phone: false });
  await want("a DRAFT plan assigned is not held", "draft-co", false, { inventory: false, forms: false, meetings: false });
  await want("a usable subscription to a DRAFT plan is not held either", "sub-draft", false, { inventory: false, forms: false, meetings: false });
  // Holding nothing: not one of the 33 tabs is blocked (none of these has a tab that is off).
  const stillBlocked = [];
  for (const c of ["ridge-co", "lapsed-switch", "lapsed-on", "draft-co", "sub-draft", "assigned-expired", "free-ended", "exc-expired"]) {
    const p = await pub(c);
    if (p.mode !== "block" || p.holds !== false || Object.keys(p.blocked).length !== 33 || !Object.values(p.blocked).every((v) => v === false)) stillBlocked.push(c);
    for (const t of tabs) if ((await blocked(c, t)) !== false) stillBlocked.push(`${c}.${t}`);
  }
  ok("lapsed, older switches only, an operator's ON only, a draft plan (assigned or paid for), an expired assignment, an ended free period: holds nothing, and nothing is blocked on any tab",
    stillBlocked.length === 0, stillBlocked.slice(0, 5).join(","));

  // 386's rule status for status, each in a transaction that is rolled back.
  await db.exec("begin");
  await db.exec("update public.access_plans set status = 'draft' where free_period");
  const freeDraft = await pub("free-period");
  await db.exec("rollback");
  ok("a free period confers the plans marked free_period: with every one of them a draft, it holds nothing", freeDraft.holds === false && Object.values(freeDraft.blocked).every((v) => v === false));
  await db.exec("begin");
  await db.exec("update public.access_plans set status = 'retired' where visibility = 'public'");
  const demoBare = await pub("demo-co"), oursBare = await pub("our-own"), hubRetired = await pub("acme-sheds"), phoneStill = await pub("phone-co");
  await db.exec("rollback");
  ok("Non-billable and our own account hold what the ACTIVE PUBLIC plans include: with none active, they hold nothing and nothing is blocked",
    demoBare.holds === false && oursBare.holds === false && Object.values(demoBare.blocked).every((v) => v === false) && Object.values(oursBare.blocked).every((v) => v === false),
    `${demoBare.holds} ${oursBare.holds}`);
  ok("…while a subscription to a plan that was retired is still held, and so is phone-only", hubRetired.holds === true && hubRetired.blocked.forms === false && phoneStill.holds === true);
  await db.exec("begin");
  await db.exec("delete from public.access_plan_modules pm using public.access_plans p where p.key = pm.plan_key and p.visibility = 'public' and pm.state = 'included'");
  const demoTeased = await pub("demo-co");
  await db.exec("rollback");
  ok("…and public plans that only TEASE tabs confer nothing on Non-billable either (386's step 6 reads included tabs)", demoTeased.holds === false && Object.values(demoTeased.blocked).every((v) => v === false), String(demoTeased.holds));
  await db.exec("begin");
  await db.exec("update public.client_access_plans set expires_at = now() + interval '1 hour' where client_id = 'sw-on'");
  const soon = await pub("sw-on");
  await db.exec("rollback");
  await db.exec("begin");
  await db.exec("update public.client_access_plans set expires_at = now() - interval '1 second' where client_id = 'sw-on'");
  const ended = await pub("sw-on");
  await db.exec("rollback");
  ok("an assignment with an end date is held until that date and not after (the switches then keep their own tabs, and nothing is blocked)",
    soon.holds === true && soon.blocked.forms === true && ended.holds === false && Object.values(ended.blocked).every((v) => v === false), `${soon.holds} ${ended.holds}`);

  // A catalogue with no tabs: the resolver has no rows. The answer is still a well-formed object
  // with an EMPTY map (which accessPublic.ts reads as null = the old rules), never an error.
  await db.exec("begin");
  await db.exec("delete from public.access_plan_modules; delete from public.client_modules; delete from public.access_modules;");
  let bare = null, bareErr = "";
  await db.exec("savepoint s0");
  try { bare = await pub("acme-sheds"); } catch (e) { bareErr = String(e.message); await db.exec("rollback to savepoint s0"); }
  const bareBlocked = await blocked("acme-sheds", "inventory");
  const bareShop = await shop("acme-sheds");
  await db.exec("rollback");
  ok("no resolver rows at all: { mode, holds, blocked: {} }, no error, nothing blocked, and the shop loads",
    !bareErr && bare && bare.mode === "block" && bare.holds === true && same(bare.blocked, {}) && bareBlocked === false && same(bareShop, shopsBefore["acme-sheds"]), bareErr || JSON.stringify(bare));

  const unknown = await pub("nobody-here");
  ok("an unknown company under server_all: block, holds nothing, nothing blocked", unknown.mode === "block" && unknown.holds === false && Object.values(unknown.blocked).every((v) => v === false));
  ok("a null id is never named, even under server_all", (await pub(null)) === null && (await blocked(null, "inventory")) === false);

  // The rule itself, for every seeded company and every tab. `holds` is the hand-written HOLDS
  // above, never the resolver's reasons: a plan whose every tab an earlier step claims leaves no
  // plan reason on any row, and it is held all the same.
  let ruleBreaks = [];
  const seeded = (await rows(db, "select client_id from public.client_settings")).map((r) => r.client_id).sort();
  ok("every seeded company has a hand-written holds answer, and no other", same(seeded, Object.keys(HOLDS).sort()), seeded.filter((c) => !(c in HOLDS)).join(","));
  for (const c of seeded) {
    const p = await pub(c);
    const d = await rows(db, "select module, state from public.access_resolve_detail($1)", [c]);
    const holds = HOLDS[c];
    for (const r of d) if (p.blocked[r.module] !== (r.state === "off" || (holds && r.state !== "on"))) ruleBreaks.push(`${c}.${r.module}`);
    if (p.holds !== holds) ruleBreaks.push(`${c}.holds`);
  }
  ok("for every company and tab: blocked = off, or (holds a plan and not on)", ruleBreaks.length === 0, ruleBreaks.slice(0, 5).join(","));

  // ── the shop, in block mode ─────────────────────────────────────────────────────────────────
  ok("block + inventory blocked: the shop answers exactly what a switched-off shop answers", same(await shop("phone-co"), NOT_FOUND) && same(await shop("lapsed-off"), NOT_FOUND)
    && same(await shop("post-frame-lapsed"), NOT_FOUND) && same(await shop("phone-co"), await shop("shop-off")), JSON.stringify(await shop("phone-co")));
  ok("block + inventory not blocked: the shop is unchanged (a plan holder, a lapsed builder, an expired OFF)", same(await shop("acme-sheds"), shopsBefore["acme-sheds"])
    && same(await shop("ridge-co"), shopsBefore["ridge-co"]) && same(await shop("exc-expired"), shopsBefore["exc-expired"]));
  const anonShop = await asAnon("select public.get_public_shop('acme-sheds') s, public.get_public_shop('phone-co') b");
  ok("as anon: the open shop loads and the blocked one is not_found (the helper runs as the function's owner)", !anonShop.error && same(anonShop.rows[0].s, shopsBefore["acme-sheds"]) && same(anonShop.rows[0].b, NOT_FOUND), anonShop.error || "");

  await setEnforce(block("phone-co"));
  ok("named one at a time: the named company is blocked, another blocked-looking one is untouched", same(await shop("phone-co"), NOT_FOUND) && same(await shop("lapsed-off"), shopsBefore["lapsed-off"])
    && (await pub("lapsed-off")) === null);
  await setEnforce({ all: false, clients: [], server_clients: ["phone-co"], server_report: ["phone-co", "lapsed-off"] });
  ok("in both lists: block wins", (await pub("phone-co")).mode === "block" && (await pub("lapsed-off")).mode === "report" && (await blocked("phone-co", "inventory")) === true);

  // ── malformed switch values ─────────────────────────────────────────────────────────────────
  for (const [name, v] of [
    ["server_all as a string", { server_all: "true" }], ["server_clients as a string", { server_clients: "phone-co" }],
    ["server_clients as an object", { server_clients: { "phone-co": true } }], ["server_report as a string", { server_report: "phone-co" }],
    ["an empty object", {}], ["a bare array", ["phone-co"]], ["server_all as 1", { server_all: 1 }],
  ]) {
    await setEnforce(v);
    ok(`malformed (${name}) reads as null, blocks nothing, and the shop is open`, (await pub("phone-co")) === null && (await blocked("phone-co", "inventory")) === false && same(await shop("phone-co"), shopsBefore["phone-co"]));
  }

  // ── the helper cannot raise ─────────────────────────────────────────────────────────────────
  await setEnforce(block("phone-co"));
  const odd = [];
  for (const [c, m] of [[null, null], [null, "inventory"], ["phone-co", null], ["phone-co", "no_such_tab"], ["phone-co", ""], ["nobody-here", "inventory"], ["", "inventory"], ["phone-co", "INVENTORY"]]) {
    try { if ((await blocked(c, m)) !== false) odd.push(JSON.stringify([c, m])); } catch (e) { odd.push(`${JSON.stringify([c, m])} raised`); }
  }
  ok("nulls, an unknown tab, an unknown company, an empty id: false every time, never an error", odd.length === 0, odd.join(" "));
  // The handler itself: make the inner read FAIL, in a transaction that is then rolled back.
  await db.exec("begin");
  await db.exec(`create or replace function public.access_for_public(p_client_id text) returns jsonb language plpgsql stable security definer set search_path to '' as $f$ begin raise exception 'the plan read is broken'; end $f$`);
  let innerRaises = false;
  await db.exec("savepoint s1");
  try { await pub("phone-co"); } catch (_) { innerRaises = true; }
  await db.exec("rollback to savepoint s1");
  const whenBroken = await blocked("phone-co", "inventory");
  const shopWhenBroken = await shop("phone-co");
  await db.exec("rollback");
  ok("a plan read that RAISES: the helper answers false, and the shop loads as before", innerRaises && whenBroken === false && same(shopWhenBroken, shopsBefore["phone-co"]), `${innerRaises} ${whenBroken}`);
  await db.exec("begin");
  await db.exec("drop table public.access_config");
  const whenGone = await blocked("phone-co", "inventory");
  const shopWhenGone = await shop("acme-sheds");
  await db.exec("rollback");
  ok("the switch table missing outright: false again, and the shop loads", whenGone === false && same(shopWhenGone, shopsBefore["acme-sheds"]));
  ok("…and after the rollback the block is back", (await blocked("phone-co", "inventory")) === true);
  await db.exec("delete from public.access_config where key = 'enforce'");
  ok("a missing row reads as null and blocks nothing", (await pub("phone-co")) === null && (await blocked("phone-co", "inventory")) === false);

  // ── a re-apply is a no-op, with companies named and a shop blocked ──────────────────────────
  await db.exec(`insert into public.access_config (key, value) values ('enforce', '{"all": false, "clients": ["acme-sheds", "ridge-co"], "server_clients": ["phone-co"], "server_report": ["lapsed-off"]}')`);
  const again = await apply(SQL389);
  const afterAgain = await def();
  ok("a re-apply passes its checks and changes nothing (body, grants, the switch row)", again === "ok" && afterAgain.m === spliced.m
    && same((await rows(db, "select value from public.access_config where key = 'enforce'"))[0].value.server_clients, ["phone-co"])
    && (await rows(db, "select has_function_privilege('anon', 'public.get_public_shop(text)', 'execute') a, has_function_privilege('anon', 'public.access_public_blocked(text, text)', 'execute') b"))[0].a === true, again);
  ok("…and the blocked shop is still blocked, the open one still open", same(await shop("phone-co"), NOT_FOUND) && same(await shop("acme-sheds"), shopsBefore["acme-sheds"]));

  // ── the header's "look first" query, as an operator would paste it ──────────────────────────
  const LOOK_FIRST = (() => {
    const lines = SQL389.split("\n");
    const i = lines.findIndex((l) => /^--\s+select k as company/.test(l));
    const j = lines.findIndex((l, n) => n >= i && /where c\.key = 'enforce';$/.test(l));
    if (i < 0 || j < 0) throw new Error("389's look-first query moved; re-point LOOK_FIRST");
    return lines.slice(i, j + 1).map((l) => l.replace(/^--/, "")).join("\n");
  })();
  const looked = await rows(db, LOOK_FIRST);
  ok("the header's look-first query lists each company named in block mode and what its customers would lose", looked.length === 1
    && same(looked[0], { company: "phone-co", holds: true, shop: true, forms: true, booking: true }), JSON.stringify(looked));

  // ── the header's rollback ───────────────────────────────────────────────────────────────────
  const ROLLBACK = (() => {
    const lines = SQL389.split("\n");
    const i = lines.findIndex((l) => l.startsWith("-- Rollback"));
    const j = lines.findIndex((l, n) => n > i && l.startsWith("-- After step 1"));
    if (i < 0 || j < 0) throw new Error("389's rollback block moved; re-point ROLLBACK");
    return lines.slice(i + 2, j).map((l) => l.replace(/^--\s{3}(\d\.\s)?/, "").replace(/^--\s*/, "")).join("\n");
  })();
  ok("the rollback in the header is the un-splice, then the two drops, in that order", /^do \$\$/.test(ROLLBACK.trim())
    && ROLLBACK.indexOf("execute replace(s, a, '')") < ROLLBACK.indexOf("drop function if exists public.access_public_blocked(text, text);")
    && ROLLBACK.indexOf("drop function if exists public.access_public_blocked(text, text);") < ROLLBACK.indexOf("drop function if exists public.access_for_public(text);"), ROLLBACK.slice(0, 60));
  const rolled = await apply(ROLLBACK);
  const afterRollback = await def();
  ok("after the rollback the body is the live one again, the two functions are gone, and a shop still loads", rolled === "ok" && afterRollback.m === LIVE_DEF.md5 && afterRollback.d.length === LIVE_DEF.length
    && (await rows(db, "select to_regprocedure('public.access_for_public(text)') a, to_regprocedure('public.access_public_blocked(text, text)') b"))[0].a === null
    && same(await shop("phone-co"), shopsBefore["phone-co"]) && (await rows(db, "select has_function_privilege('anon', 'public.get_public_shop(text)', 'execute') a"))[0].a === true, rolled);
  // ── the apply itself closes no shop ─────────────────────────────────────────────────────────
  // phone-co is still named in block mode and, after the rollback, its shop is open again. Applying
  // the file now would close that shop the moment it commits: on the live database that is a
  // customer-facing change made by a migration, with only a notice to show for it. So it stops.
  const gone = async () => {
    const r = (await rows(db, "select to_regprocedure('public.access_for_public(text)') a, to_regprocedure('public.access_public_blocked(text, text)') b"))[0];
    return r.a === null && r.b === null && (await def()).m === LIVE_DEF.md5;
  };
  const refused = await apply(SQL389);
  ok("with a company already named in block mode, the apply stops rather than close its open shop, and names it",
    /389: applying this would close 1 open shop\(s\) at once \(phone-co\)/.test(refused) && /Nothing changed/.test(refused)
    && refused.includes("select set_config('ss.m389_shops_may_close', '1', true);"), refused.slice(0, 110));
  ok("…nothing of 389 is left behind, and that shop still loads", (await gone()) && same(await shop("phone-co"), shopsBefore["phone-co"]));
  const ack = (n) => `select set_config('ss.m389_shops_may_close', '${n}', true);\n`;
  const wrongCount = await apply(ack(2) + SQL389);
  ok("…an acknowledgement for a different count is not one", /389: applying this would close 1 open shop/.test(wrongCount) && (await gone()), wrongCount.slice(0, 80));
  // Told the exact count, in the same call: it applies, and reports the shop it closes.
  ok("…told the exact count in the same call, the file applies: that shop is closed and every other is left alone", (await apply(ack(1) + SQL389)) === "ok" && (await def()).m === spliced.m
    && same(await shop("phone-co"), NOT_FOUND) && same(await shop("acme-sheds"), shopsBefore["acme-sheds"]) && same(await shop("lapsed-off"), shopsBefore["lapsed-off"]));
  ok("…and the acknowledgement does not outlive that call", (await rows(db, "select coalesce(current_setting('ss.m389_shops_may_close', true), '') s"))[0].s === "");

  // ── mutants: a live body this splice was not derived from stops the apply ───────────────────
  for (const [name, body] of [
    ["the line is MISSING", SHOP_314.replace(ANCHOR, "if not found or v_shop.enabled is not true then")],
    ["the line is there TWICE", SHOP_314.replace(ANCHOR, `${ANCHOR}\n    return jsonb_build_object('ok', false, 'reason', 'not_found');\n  end if;\n  ${ANCHOR}`)],
  ]) {
    const m = await before389(body);
    const h = helpers(m);
    const was = await h.def();
    const res = await h.apply(SQL389);
    const now = await h.def();
    const left = (await rows(m, "select to_regprocedure('public.access_for_public(text)') a, to_regprocedure('public.access_public_blocked(text, text)') b"))[0];
    ok(`mutant, ${name}: the apply stops and says the line count`, /389: the line .* time\(s\), expected exactly 1/.test(res), res.slice(0, 110));
    ok("…the shop function is untouched, and nothing of 389 is left behind", now.m === was.m && left.a === null && left.b === null && (await h.shop("acme-sheds")).ok === true, JSON.stringify(left));
    await m.close();
  }
  {
    // A splice that changes more than it says (here: the condition turned inside out) must not land.
    const wrong = SQL389.replace("$l$" + SPLICED + "$l$", "$l$" + SPLICED.replace("or public.", "or not public.") + "$l$");
    const m = await before389();
    const h = helpers(m);
    const was = await h.def();
    const res = wrong === SQL389 ? "the mutant did not change the file" : await h.apply(wrong);
    ok("mutant, a splice that closes shops it should not: the apply stops", /389: get_public_shop changed for \d+ shop\(s\)/.test(res), res.slice(0, 110));
    ok("…and the shop function is untouched", (await h.def()).m === was.m && same(await h.shop("acme-sheds"), shopsBefore["acme-sheds"]));
    await m.close();
  }
  {
    // On the live database "before" and "after" are two statements, so two snapshots: a builder's
    // edit that commits between them looks like a change the splice made. One connection cannot
    // race itself, so the edit is written into the apply at that very point. The apply still stops
    // (it cannot tell the two apart), but it must SAY this is the likely cause and that applying
    // again is safe, and the same file must then apply.
    const edit = "    update public.inventory_units set public_title = 'Edited while 389 was applying' where client_id = 'acme-sheds';\n";
    const raced = SQL389.replace("    execute v_new;\n", "    execute v_new;\n" + edit);
    const m = await before389();
    const h = helpers(m);
    const was = await h.def();
    const res = raced === SQL389 ? "the mutant did not change the file" : await h.apply(raced);
    ok("a shop edited while the file applies: the apply stops, names the shop, and says an edit is a likely cause and applying again is safe",
      /389: get_public_shop changed for 1 shop\(s\) this does not block \(acme-sheds\)/.test(res) && /edited, or a unit in it sold, while this was applying/.test(res)
      && /Nothing changed\. Apply again: it is safe/.test(res), res.slice(0, 110));
    const left = (await rows(m, "select to_regprocedure('public.access_for_public(text)') a, to_regprocedure('public.access_public_blocked(text, text)') b"))[0];
    ok("…nothing is left behind (the edit made inside the apply included)", (await h.def()).m === was.m && left.a === null && left.b === null && same(await h.shop("acme-sheds"), shopsBefore["acme-sheds"]));
    ok("…and the same file then applies", (await h.apply(SQL389)) === "ok" && (await h.def()).m === spliced.m && same(await h.shop("acme-sheds"), shopsBefore["acme-sheds"]));
    await m.close();
  }
  {
    // The header's COST note, counted. `holds` is read in two places (the "holds" key, and every
    // tab's blocked answer). Left to itself the planner copies the one-row subquery that works it
    // out into both, so the whole held rule, subscription read included, runs twice on every shop
    // load of a named company. The `offset 0` in 389 is what stops that. Each call of 386's
    // access_usable_plans raises a notice here, and the notices are counted.
    const m = await before389();
    const h = helpers(m);
    const applied = await h.apply(SQL389);
    await h.setEnforce({ all: false, clients: [], server_clients: ["acme-sheds", "ridge-co", "sw-on"], server_report: ["phone-co"] });
    const NAMES = ["acme-sheds", "ridge-co", "sw-on", "phone-co", "lapsed-off"];
    const uncounted = {};
    for (const c of NAMES) uncounted[c] = await h.pub(c);
    await m.exec(`alter function public.access_usable_plans(text) rename to access_usable_plans_real;
      create function public.access_usable_plans(p_client_id text) returns setof text language plpgsql stable security definer set search_path to '' as $f$
      begin raise notice 'USABLE_READ'; return query select * from public.access_usable_plans_real(p_client_id); end $f$;`);
    const reads = async (q, c) => {
      let n = 0;
      await m.query(q, [c], { onNotice: (x) => { if (/USABLE_READ/.test(String(x.message))) n++; } });
      return n;
    };
    const FOR_PUBLIC = "select public.access_for_public($1) a", SHOP = "select public.get_public_shop($1) s";
    const counted = {};
    for (const c of NAMES) counted[c] = await reads(FOR_PUBLIC, c);
    ok("the counting wrapper is in place: the resolver alone reads the subscriptions exactly once", applied === "ok"
      && (await reads("select count(*) from public.access_resolve_detail($1)", "acme-sheds")) === 1);
    ok("a named company (a subscriber, a lapsed builder, a switch-backed plan, report mode): the subscription read runs TWICE, once in the resolver and once for holds",
      counted["acme-sheds"] === 2 && counted["ridge-co"] === 2 && counted["sw-on"] === 2 && counted["phone-co"] === 2, JSON.stringify(counted));
    ok("…a company that is not named reads no subscriptions at all, and neither does its shop load", counted["lapsed-off"] === 0 && (await reads(SHOP, "lapsed-off")) === 0, String(counted["lapsed-off"]));
    ok("…and a named company's shop load costs the same two reads", (await reads(SHOP, "acme-sheds")) === 2);
    let sameAnswers = true;
    for (const c of NAMES) if (!same(await h.pub(c), uncounted[c])) sameAnswers = false;
    ok("…and counting changes no answer (not named is null, the switch-backed plan is held, the lapsed builder holds nothing)", sameAnswers && uncounted["lapsed-off"] === null
      && uncounted["sw-on"].holds === true && uncounted["ridge-co"].holds === false && uncounted["phone-co"].mode === "report");
    await m.close();
  }
  {
    // 389 before 310/314: there is nothing to splice, so nothing is applied at all.
    const m = new PGlite();
    await m.exec(STUBS);
    await m.exec(read("386_access_plans.sql"));
    await m.exec(read("387_access_rollout.sql"));
    await m.exec(read("388_access_server_switch.sql"));
    const res = await helpers(m).apply(SQL389);
    ok("without get_public_shop the apply stops and leaves nothing behind", /389: public\.get_public_shop\(text\) is not there/.test(res)
      && (await rows(m, "select to_regprocedure('public.access_for_public(text)') a"))[0].a === null, res.slice(0, 90));
    await m.close();
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
