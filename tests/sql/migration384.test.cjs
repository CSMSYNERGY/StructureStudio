// Execute migration 384 (the phone-only account) for real in PGlite (Postgres compiled to WASM, in
// memory) on top of client_settings and setup_template_items as migrations 364 and 368 left them,
// then check what it promises:
//   * client_settings.phone_only is boolean NOT NULL default false, every existing account reads
//     false, and nothing else on any row moves;
//   * the browser roles still cannot read client_settings (RLS on, no policy), so a tenant can
//     neither read nor set its own shape;
//   * setup_template_items accepts 'phone' as a fourth audience, still refuses an unknown one, and
//     holds the six phone steps; the other audiences' steps are untouched;
//   * a re-apply changes nothing.
// Nothing here touches the live project: no network, no Supabase. Tenants are made up (public repo).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration384.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const SQL = fs.readFileSync(path.join(WT, "supabase/migrations/384_phone_only_account.sql"), "utf8").replace(/\r/g, "");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create table public.client_settings (
  client_id text primary key,
  sheds_enabled boolean not null default true,
  billing_exempt boolean not null default false,
  business_name text,
  updated_at timestamptz not null default now()
);
alter table public.client_settings enable row level security;
revoke all on public.client_settings from anon, authenticated;
grant all on public.client_settings to service_role;

-- setup_template_items as 368 left it (only the columns 384 names).
create table public.setup_template_items (
  id uuid primary key,
  title text not null,
  detail text,
  link_page text,
  section text,
  position double precision not null default 0,
  active boolean not null default true,
  account_type text not null default 'all',
  requires_feature text,
  builder_visible boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.setup_template_items add constraint setup_template_items_account_type_check
  check (account_type in ('all', 'sheds', 'smartbuild'));
`;

const SEED = `
insert into public.client_settings (client_id, sheds_enabled, billing_exempt, business_name, updated_at) values
  ('acme-sheds',  true,  false, 'Acme Sheds',  '2026-09-01 10:00+00'),
  ('post-frame',  false, false, 'Post Frame',  '2026-09-02 10:00+00'),
  ('our-own',     true,  true,  'Our Own',     '2026-09-03 10:00+00');
insert into public.setup_template_items (id, title, link_page, section, position, account_type) values
  ('00000000-0000-4000-8000-0000000000a1', 'Set your password and sign in', null, 'The basics', 1024, 'all'),
  ('00000000-0000-4000-8000-0000000000a2', 'Check your building styles', 'settings/sheds', 'Your catalog', 4096, 'sheds'),
  ('00000000-0000-4000-8000-0000000000a3', 'Check your SmartBuild Jobs pipeline', 'settings/pipelines', 'Your Customer Hub', 12400, 'smartbuild');
`;

let failed = 0;
const ok = (name, pass, note) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "   [" + note + "]" : ""}`);
  if (!pass) failed++;
};
const rows = async (db, q) => (await db.query(q)).rows;

(async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  const before = await rows(db, "select client_id, sheds_enabled, billing_exempt, business_name, updated_at from public.client_settings order by 1");
  const tplBefore = await rows(db, "select id, title, account_type, position from public.setup_template_items order by id");

  await db.exec(SQL);

  const col = await rows(db, `select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'client_settings' and column_name = 'phone_only'`);
  ok("phone_only is a boolean", col.length === 1 && col[0].data_type === "boolean", JSON.stringify(col));
  ok("…NOT NULL, default false", col[0] && col[0].is_nullable === "NO" && /false/.test(String(col[0].column_default)), JSON.stringify(col));
  const flags = await rows(db, "select client_id, phone_only from public.client_settings order by 1");
  ok("every existing account reads false", flags.every((r) => r.phone_only === false), JSON.stringify(flags));
  const after = await rows(db, "select client_id, sheds_enabled, billing_exempt, business_name, updated_at from public.client_settings order by 1");
  ok("nothing else on any row moved", JSON.stringify(after) === JSON.stringify(before));
  await db.exec("insert into public.client_settings (client_id) values ('new-builder')");
  const fresh = await rows(db, "select phone_only from public.client_settings where client_id = 'new-builder'");
  ok("a new row is not phone-only", fresh[0].phone_only === false);

  // The browser roles: RLS on and nothing granted, as before.
  let anonRead = "allowed";
  try { await db.exec("set role authenticated"); await db.query("select phone_only from public.client_settings"); }
  catch (e) { anonRead = "refused"; }
  finally { await db.exec("reset role"); }
  ok("a signed-in browser cannot read client_settings (or its shape)", anonRead === "refused");
  let anonWrite = "allowed";
  try { await db.exec("set role authenticated"); await db.query("update public.client_settings set phone_only = true"); }
  catch (e) { anonWrite = "refused"; }
  finally { await db.exec("reset role"); }
  ok("…nor make itself phone-only", anonWrite === "refused");

  // The setup list's fourth audience.
  const phone = await rows(db, "select id, title, link_page, section, account_type, active, builder_visible, requires_feature from public.setup_template_items where account_type = 'phone' order by position");
  ok("six phone steps", phone.length === 6, phone.map((r) => r.title).join(" | "));
  ok("…all active, shown, needing no add-on", phone.every((r) => r.active && r.builder_visible && r.requires_feature === null));
  const links = phone.map((r) => r.link_page);
  ok("…pointing at the pages a phone-only account has",
    JSON.stringify(links) === JSON.stringify([null, "settings/company", "settings/wallet", "settings/phone", "settings/sms", "settings/team"]), JSON.stringify(links));
  const tplAfter = await rows(db, "select id, title, account_type, position from public.setup_template_items where account_type <> 'phone' order by id");
  ok("the other audiences' steps are untouched", JSON.stringify(tplAfter) === JSON.stringify(tplBefore));
  let bogus = "accepted";
  try { await db.exec("insert into public.setup_template_items (id, title, account_type) values ('00000000-0000-4000-8000-0000000000ff', 'x', 'bogus')"); }
  catch (e) { bogus = "refused"; }
  ok("an unknown audience is still refused", bogus === "refused");

  // Re-apply.
  const snap = async () => JSON.stringify([
    await rows(db, "select * from public.client_settings order by client_id"),
    await rows(db, "select id, title, account_type from public.setup_template_items order by id"),
  ]);
  const s1 = await snap();
  await db.exec(SQL);
  ok("a re-apply changes nothing", (await snap()) === s1);

  await db.close();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
