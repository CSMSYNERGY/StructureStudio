// Execute migration 285 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// style_cladding and get_config's claddingOptions block as they are live (275 applied), then check
// what it promises:
//   * style_cladding_cladding_id_check takes exactly five ids: panel, lap, vinyl, batten, agpanel;
//     'barn' (or anything else) is still refused, and a course size on a vinyl row is refused (the
//     exposure_in CHECK stays lap-only and is untouched);
//   * no row is seeded and no other row moves; every tenant's get_config is byte-for-byte what it
//     was; get_config's body is unchanged;
//   * a vinyl row a builder prices reaches get_config on its own, as { id: "vinyl", label: null, ... }
//     (their own name when they set one), and a vinyl row with a blank rate stays absent;
//   * the comments say what is true now (five ids; the course size on the scale of the names);
//   * anon can neither read nor write the table, authenticated cannot write it, and service_role can
//     do portal-settings' save (an upsert) with a vinyl row in it;
//   * a re-apply changes nothing and keeps the vinyl rows; a CRLF checkout applies the same;
//   * THE RECORD, the one row `supabase db query` prints, and a dry run (the last commit; swapped
//     for rollback;) prints the same row and leaves the four-id CHECK;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration285.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/285_cladding_vinyl.sql"), "utf8");

// get_config's claddingOptions key as it is live (pg_get_functiondef, 2026-10-06: 275's exposureIn
// splice included), character for character. The rest of the body is cut to a few keys that read
// the same tables.
const CLAD_LIVE = `    'claddingOptions', coalesce((
      select jsonb_object_agg(st.key, cl.list)
      from public.building_styles st
      cross join lateral (
        select jsonb_agg(jsonb_build_object(
                 'id', sc.cladding_id,
                 'label', nullif(btrim(coalesce(sc.label_override, '')), ''),
                 'basis', sc.basis,
                 'rate', case when coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false) then sc.rate else null end,
                 -- CHARGED IS EMITTED SEPARATELY FROM THE RATE, and it is load-bearing: the same
                 -- split 181 made for electricalItems. The rate is NULLED when a tenant hides
                 -- prices, so "rate is null" cannot ALSO carry "included at no charge" -- and
                 -- every row was seeded at 0 = included, so without this flag a hide-prices
                 -- tenant would get a cladding line on every quote.
                 'charged', coalesce(sc.rate, 0) > 0)
                 || case when coalesce(sc.taxable, true) = false then jsonb_build_object('taxable', false) else '{}'::jsonb end
                 || case when coalesce(sc.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end
                 || case when sc.exposure_in is not null then jsonb_build_object('exposureIn', sc.exposure_in) else '{}'::jsonb end
               order by sc.sort_order, sc.cladding_id) as list
        from public.style_cladding sc
        where sc.style_id = st.id and sc.active and sc.rate is not null
      ) cl
      where st.client_id = cc.client_id and st.active and cl.list is not null), '{}'::jsonb),
`;
const GET_CONFIG = `
create or replace function public.get_config(p_client_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    'branding', jsonb_build_object('companyName', cc.company_name, 'accentColor', cc.accent_color),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),
${CLAD_LIVE}    'sizePricing', coalesce((
        select jsonb_build_object(cc.client_id, cc.company_name)
        where cc.company_name is not null
      ), '{}'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
`;

// The live shapes (information_schema, pg_constraint, pg_policy, relacl; 2026-10-06), cut to the
// columns get_config and 285 read. style_cladding: RLS on, one owner-scoped SELECT policy, ACL
// postgres + authenticated + service_role (anon revoked by 207), its constraints exactly as live,
// 275's exposure_in CHECK included. client_settings: RLS on, no policy, service_role only.
const TABLE_COMMENT_LIVE = "Which cladding types a builder offers per building style, what each costs, and what the customer sees it called. cladding_id is the CLOSED D3_CLADDING set — the 3D renderer keys on it. NULL rate = not offered, 0 = included, > 0 = upcharge.";
const COLUMN_COMMENT_LIVE = "How much of each lap board shows, in inches (Settings → Options → Cladding, \"Course (in)\"). LAP rows only, 3 to 12. NULL = the 3D's standard 6 in. Appearance only: it never prices. get_config emits \"exposureIn\" on the cladding entry only when set (sparse, so every other tenant's config is unchanged). Migration 275.";
const STUBS = () => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create function public.current_client_id() returns text language sql stable
  as $$ select nullif(current_setting('harness.client_id', true), '') $$;

create table public.client_configs (
  client_id text primary key, company_name text, accent_color text
);
revoke all on public.client_configs from anon, authenticated;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  show_pricing boolean
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

create table public.building_styles (
  id uuid primary key default gen_random_uuid(), client_id text not null, key text not null,
  label text, active boolean not null default true
);

create table public.style_cladding (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null,
  style_id       uuid not null references public.building_styles(id) on delete cascade,
  cladding_id    text not null constraint style_cladding_cladding_id_check check (cladding_id in ('panel', 'lap', 'batten', 'agpanel')),
  label_override text,
  rate           numeric constraint style_cladding_rate_check check (rate is null or rate >= 0),
  basis          text not null default 'sqft_option' constraint style_cladding_basis_check check (basis in (
                   'each', 'lineal_ft', 'sqft_option', 'sqft_building', 'perimeter_building', 'pct_building_price', 'pct_estimate_total')),
  taxable        boolean not null default true,
  internal_only  boolean not null default false,
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  exposure_in    numeric constraint style_cladding_exposure_in_check
                   check (exposure_in is null or (cladding_id = 'lap' and exposure_in between 3 and 12)),
  unique (client_id, style_id, cladding_id)
);
alter table public.style_cladding enable row level security;
create policy style_cladding_owner_read on public.style_cladding
  for select to authenticated using (client_id = public.current_client_id());
grant all on public.style_cladding to anon, authenticated, service_role;
revoke all on public.style_cladding from anon;
comment on table public.style_cladding is '${TABLE_COMMENT_LIVE.replace(/'/g, "''")}';
comment on column public.style_cladding.exposure_in is '${COLUMN_COMMENT_LIVE.replace(/'/g, "''")}';

${GET_CONFIG}
`;

// Five tenants; four settings rows (live has a tenant without one); one tenant with no styles. One
// builder already sells its Deluxe lap row renamed "Vinyl Siding" at rate 0 (the case the contract
// leaves alone: their rows are not touched).
const SEED = `
insert into public.client_configs (client_id, company_name, accent_color) values
  ('acme-sheds', 'Acme Sheds', '#1D4ED8'), ('bravo-barns', 'Bravo Barns', '#8B4513'),
  ('charlie-cabins', 'Charlie Cabins', null), ('delta-sheds', 'Delta Sheds', '#000000'), ('echo-barns', null, '#222222');
insert into public.client_settings (client_id, show_pricing, updated_at) values
  ('acme-sheds', true, '2026-09-01 10:00+00'), ('bravo-barns', null, '2026-09-02 10:00+00'),
  ('charlie-cabins', true, '2026-09-03 10:00+00'), ('delta-sheds', false, '2026-09-04 10:00+00');
insert into public.building_styles (client_id, key, label, active) values
  ('acme-sheds', 'deluxe', 'Deluxe Gable', true), ('acme-sheds', 'utility', 'Utility', true), ('acme-sheds', 'old', 'Old', false),
  ('bravo-barns', 'barn', 'Barn', true), ('charlie-cabins', 'cabin', 'Cabin', true), ('delta-sheds', 'shed', 'Shed', true);
insert into public.style_cladding (client_id, style_id, cladding_id, label_override, rate, taxable, internal_only, active, sort_order)
select s.client_id, s.id, r.cid, r.lbl, r.rate, r.tax, r.int, r.act, r.ord
  from public.building_styles s
  join (values
    ('acme-sheds',     'deluxe',  'panel',   'LP Smartsiding', 0::numeric, true,  false, true,  1),
    ('acme-sheds',     'deluxe',  'lap',     'Vinyl Siding',   0,          true,  false, true,  2),
    ('acme-sheds',     'deluxe',  'batten',  null,             null,       true,  false, true,  3),
    ('acme-sheds',     'deluxe',  'agpanel', null,             2.5,        false, true,  true,  4),
    ('acme-sheds',     'utility', 'panel',   null,             0,          true,  false, true,  1),
    ('acme-sheds',     'utility', 'lap',     null,             1.25,       true,  false, true,  2),
    ('acme-sheds',     'old',     'lap',     null,             0,          true,  false, true,  1),
    ('bravo-barns',    'barn',    'panel',   null,             0,          true,  false, true,  1),
    ('bravo-barns',    'barn',    'lap',     null,             0,          true,  false, false, 2),
    ('charlie-cabins', 'cabin',   'lap',     null,             0,          true,  true,  true,  1),
    ('delta-sheds',    'shed',    'panel',   null,             0,          true,  false, true,  1),
    ('delta-sheds',    'shed',    'lap',     null,             3,          true,  false, true,  2)
  ) as r(client_id, skey, cid, lbl, rate, tax, int, act, ord) on r.client_id = s.client_id and r.skey = s.key;
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS());
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
const conDef = async (db, name) => ((await one(db, `select pg_get_constraintdef(oid) as d from pg_constraint
  where conrelid = 'public.style_cladding'::regclass and conname = $1`, [name])) || {}).d || null;
const FOUR_IDS = "CHECK ((cladding_id = ANY (ARRAY['panel'::text, 'lap'::text, 'batten'::text, 'agpanel'::text])))";
const FIVE_IDS = "CHECK ((cladding_id = ANY (ARRAY['panel'::text, 'lap'::text, 'batten'::text, 'agpanel'::text, 'vinyl'::text])))";
const tableComment = async (db) => (await one(db, "select obj_description('public.style_cladding'::regclass, 'pg_class') as c")).c;
const columnComment = async (db) => (await one(db, `select col_description('public.style_cladding'::regclass,
  (select attnum from pg_attribute where attrelid = 'public.style_cladding'::regclass and attname = 'exposure_in')) as c`)).c;
const body = async (db) => (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
// get_config as TEXT, which is what the md5 check and the browser both see.
const configs = async (db) => Object.fromEntries((await rows(db,
  "select client_id, public.get_config(client_id)::text as cfg from public.client_configs order by client_id")).map((r) => [r.client_id, r.cfg]));
const entry = (cfgText, styleKey, id) => ((JSON.parse(cfgText).claddingOptions || {})[styleKey] || []).find((e) => e.id === id) || null;
const styleId = async (db, client, key) => (await one(db, "select id from public.building_styles where client_id = $1 and key = $2", [client, key])).id;
// portal-settings' save_cladding, as the handler makes it: an upsert of named columns, service role.
async function upsert(db, client, key, cid, { label = null, rate = 0, exposure } = {}) {
  const st = await styleId(db, client, key);
  await db.exec("begin");
  await db.exec("set local role service_role");
  let err = null;
  try {
    const cols = ["client_id", "style_id", "cladding_id", "label_override", "rate", "basis", "taxable", "active", "internal_only", "sort_order", "updated_at"];
    const vals = ["$1", "$2", "$3", "$4", "$5", "'sqft_option'", "true", "true", "false", "5", "now()"];
    const params = [client, st, cid, label, rate];
    if (exposure !== undefined) { cols.push("exposure_in"); vals.push("$6"); params.push(exposure); }
    const set = cols.filter((c) => !["client_id", "style_id", "cladding_id"].includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
    await db.query(`insert into public.style_cladding (${cols.join(", ")}) values (${vals.join(", ")})
                    on conflict (client_id, style_id, cladding_id) do update set ${set}`, params);
  } catch (e) { err = e.message; }
  await db.exec(err ? "rollback" : "commit");
  return err;
}
// Did the apply fail with `re`, and leave nothing behind (the four-id CHECK, both comments as live)?
async function refused(db, sql, re) {
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return {
    err, matched: !!err && re.test(err),
    untouched: (await conDef(db, "style_cladding_cladding_id_check")) === FOUR_IDS
      && (await tableComment(db)) === TABLE_COMMENT_LIVE && (await columnComment(db)) === COLUMN_COMMENT_LIVE,
    vinyl: Number((await one(db, "select count(*)::int as n from public.style_cladding where cladding_id = 'vinyl'")).n),
  };
}
// Rewrite the swap's own CHECK line and nothing else (the ROLLBACK note in the header quotes a
// four-id CHECK, so a plain first-match replace could edit a comment and build a mutant that
// changes nothing).
const mutateCheck = (fn) => MIG_TEXT().replace(/^      check \(cladding_id in \('panel', 'lap', 'batten', 'agpanel', 'vinyl'\)\);$/m, (line) => fn(line));
// Text added right after PART 1's DO block, i.e. before the checks run.
const afterSwap = (extra) => MIG_TEXT().replace(/^\$swap\$;$/m, (line) => `${line}\n${extra}`);

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 285: applies on the live shape, seeds nothing, and no tenant's config moves");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const cladBefore = await rows(db, "select * from public.style_cladding order by client_id, sort_order, cladding_id");
    ok((await conDef(db, "style_cladding_cladding_id_check")) === FOUR_IDS, "(the stub's CHECK reads exactly as live)");
    let notices = [];
    try { notices = await apply(db); ok(true, "285 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "285 applied", e.message); }
    ok(notices.some((n) => /now allows vinyl$/.test(n)), "it swapped the CHECK", notices.join(" | "));
    ok(notices.some((n) => /checks hold; the CHECK widened to ids agpanel,batten,lap,panel,vinyl; every tenant's get_config unchanged; vinyl rows: 0; rehearsal: ok$/.test(n)),
      "its own checks held: five ids, no config moved, no vinyl row, the rehearsal ran", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "285", cladding_ids: "agpanel,batten,lap,panel,vinyl", swapped: "yes", tenants_checked: 5, configs_changed: "(none)",
      vinyl_rows: 0, rows_with_size: 0, rehearsal: "ok", anon_reads_get_config: true, anon_reads_cladding: false,
    }), "THE RECORD, the row the CLI prints: five ids, swapped, five tenants unchanged, no vinyl row, no size, rehearsal ok, grants as promised", JSON.stringify(rec));

    ok((await conDef(db, "style_cladding_cladding_id_check")) === FIVE_IDS, "the CHECK reads the five ids, the old four first in their order", await conDef(db, "style_cladding_cladding_id_check"));
    const v = await one(db, `select convalidated from pg_constraint where conrelid = 'public.style_cladding'::regclass and conname = 'style_cladding_cladding_id_check'`);
    ok(v && v.convalidated === true, "and it is validated");
    ok((await conDef(db, "style_cladding_exposure_in_check")) === "CHECK (((exposure_in IS NULL) OR ((cladding_id = 'lap'::text) AND ((exposure_in >= (3)::numeric) AND (exposure_in <= (12)::numeric)))))",
      "exposure_in's CHECK is untouched: lap only, 3 to 12", await conDef(db, "style_cladding_exposure_in_check"));
    // contype 'n' left out: PGlite's Postgres records NOT NULL as constraints too, the live one does not.
    const cons = (await rows(db, "select conname from pg_constraint where conrelid = 'public.style_cladding'::regclass and contype <> 'n' order by 1")).map((r) => r.conname);
    ok(JSON.stringify(cons) === JSON.stringify(["style_cladding_basis_check", "style_cladding_cladding_id_check", "style_cladding_client_id_style_id_cladding_id_key",
      "style_cladding_exposure_in_check", "style_cladding_pkey", "style_cladding_rate_check", "style_cladding_style_id_fkey"]), "the same seven constraints, by name", cons.join(","));
    const cladAfter = await rows(db, "select * from public.style_cladding order by client_id, sort_order, cladding_id");
    ok(JSON.stringify(cladAfter) === JSON.stringify(cladBefore), "no style_cladding row moved, the renamed 'Vinyl Siding' lap row included");
    ok(/CLOSED D3_CLADDING set of five: panel, lap, vinyl, batten, agpanel/.test(await tableComment(db)), "the table says it is five ids now", await tableComment(db));
    const cc = await columnComment(db);
    ok(/NULL = the standard lap, called 7 in \(7" LP Lap Siding\), and 4\.5 draws the courses 4\.5" Vinyl Siding has\. LAP rows only, 3 to 12\./.test(cc) && /Migrations 275 and 285\.$/.test(cc),
      "exposure_in says its scale: NULL is the 7 in lap, 4.5 the vinyl's courses, lap rows only", cc);

    const after = await configs(db);
    ok(JSON.stringify(after) === JSON.stringify(before), "every tenant's get_config TEXT is byte-for-byte what it was", JSON.stringify({ before, after }).slice(0, 400));
    ok(Object.values(after).every((c) => !c.includes("vinyl")), "and no tenant's config names vinyl");
    ok((await body(db)) === fnBefore, "get_config's body is unchanged (nothing spliced)");

    // ── A builder prices vinyl: it reaches get_config on its own ──
    ok(!(await upsert(db, "acme-sheds", "utility", "vinyl", { rate: 0 })), "portal-settings' upsert stores a vinyl row (service role)");
    const on = await configs(db);
    const vin = entry(on["acme-sheds"], "utility", "vinyl");
    ok(vin && vin.label === null && vin.rate === 0 && vin.charged === false && vin.basis === "sqft_option",
      "a vinyl row at 0 appears in claddingOptions as id 'vinyl', label null (the built-in name), included", JSON.stringify(vin));
    ok(Object.keys(vin).join(",") === "id,rate,basis,label,charged", "with exactly the keys every other entry has", Object.keys(vin).join(","));
    ok(JSON.stringify(entry(on["acme-sheds"], "utility", "lap")) === JSON.stringify(entry(before["acme-sheds"], "utility", "lap")), "the lap entry beside it is what it was");
    ok(Object.keys(on).filter((k) => k !== "acme-sheds").every((k) => on[k] === before[k]), "every other tenant is still byte-for-byte unchanged");
    ok(!(await upsert(db, "acme-sheds", "deluxe", "vinyl", { rate: 1.75, label: "Premium Vinyl" })), "a priced, renamed vinyl row on the style that already sells lap as 'Vinyl Siding'");
    const dlx = JSON.parse((await configs(db))["acme-sheds"]).claddingOptions.deluxe;
    ok(entry(JSON.stringify({ claddingOptions: { deluxe: dlx } }), "deluxe", "vinyl").label === "Premium Vinyl"
      && entry(JSON.stringify({ claddingOptions: { deluxe: dlx } }), "deluxe", "vinyl").charged === true
      && entry(JSON.stringify({ claddingOptions: { deluxe: dlx } }), "deluxe", "lap").label === "Vinyl Siding",
      "side by side with that lap row: two entries, each with its own name and price", JSON.stringify(dlx));
    ok(!(await upsert(db, "delta-sheds", "shed", "vinyl", { rate: 4 })), "a tenant hiding prices stores one too");
    const dv = entry((await configs(db))["delta-sheds"], "shed", "vinyl");
    ok(dv && dv.rate === null && dv.charged === true, "and its entry carries charged without the rate, like every other cladding", JSON.stringify(dv));
    ok(!(await upsert(db, "bravo-barns", "barn", "vinyl", { rate: null })), "a vinyl row with a blank rate (not offered)");
    ok(entry((await configs(db))["bravo-barns"], "barn", "vinyl") === null, "stays out of get_config");

    // ── The CHECKs, asked directly ──
    const errBarn = await upsert(db, "acme-sheds", "utility", "barn", { rate: 0 });
    ok(/style_cladding_cladding_id_check/.test(String(errBarn)), "'barn' (an id we ship nothing for) is still refused", String(errBarn));
    for (const bad of ["Vinyl", "vinyl ", "vinylsiding", ""]) {
      const e = await upsert(db, "acme-sheds", "utility", bad, { rate: 0 });
      ok(/style_cladding_cladding_id_check/.test(String(e)), `${JSON.stringify(bad)} is refused (the id is exact)`, String(e));
    }
    const errSize = await upsert(db, "acme-sheds", "utility", "vinyl", { rate: 0, exposure: 4.5 });
    ok(/style_cladding_exposure_in_check/.test(String(errSize)), "a course size on the vinyl row is refused (vinyl is fixed at 4.5)", String(errSize));
    ok(!(await upsert(db, "acme-sheds", "utility", "lap", { rate: 1.25, exposure: 7 })), "a size on a lap row still stores (7 = the standard lap)");
    ok(entry((await configs(db))["acme-sheds"], "utility", "lap").exposureIn === 7, "and still reaches get_config");
    ok(!(await upsert(db, "acme-sheds", "utility", "lap", { rate: 1.25, exposure: null })), "cleared again");

    // ── Grants, asked of Postgres directly ──
    const priv = await one(db, `select
      has_table_privilege('anon', 'public.style_cladding', 'SELECT') as anon_sel,
      has_table_privilege('anon', 'public.style_cladding', 'INSERT') as anon_ins,
      has_table_privilege('anon', 'public.style_cladding', 'UPDATE') as anon_upd,
      has_table_privilege('service_role', 'public.style_cladding', 'SELECT') as svc_sel,
      has_table_privilege('service_role', 'public.style_cladding', 'INSERT') as svc_ins,
      has_table_privilege('service_role', 'public.style_cladding', 'UPDATE') as svc_upd`);
    ok(!priv.anon_sel && !priv.anon_ins && !priv.anon_upd, "anon can neither read nor write the table", JSON.stringify(priv));
    ok(priv.svc_sel && priv.svc_ins && priv.svc_upd, "service_role can read and write it", JSON.stringify(priv));
    await db.exec("set role anon");
    let anonIns = null;
    await db.exec("begin");
    try {
      await db.query("insert into public.style_cladding (client_id, style_id, cladding_id, rate) select 'acme-sheds', id, 'vinyl', 0 from public.building_styles where key = 'cabin'");
      anonIns = "allowed";
    } catch (e) { anonIns = e.message; }
    await db.exec("rollback");
    await db.exec("reset role");
    ok(/permission denied/.test(String(anonIns)), "anon cannot insert a vinyl row", String(anonIns));
    const oldStyle = await styleId(db, "acme-sheds", "old");
    await db.exec("begin");
    await db.exec("set local harness.client_id = 'acme-sheds'");
    await db.exec("set local role authenticated");
    const own = await rows(db, "select client_id, cladding_id from public.style_cladding");
    let authIns = null;
    try {
      await db.query("insert into public.style_cladding (client_id, style_id, cladding_id, rate) values ('acme-sheds', $1, 'vinyl', 0)", [oldStyle]);
      authIns = "allowed";
    } catch (e) { authIns = e.message; }
    await db.exec("rollback");
    ok(own.length > 0 && own.every((r) => r.client_id === "acme-sheds") && own.some((r) => r.cladding_id === "vinyl"), "authenticated reads its own rows, vinyl among them", JSON.stringify(own.map((r) => r.cladding_id)));
    ok(/row-level security/.test(String(authIns)), "and cannot write one (no write policy)", String(authIns));

    // ── Re-apply: nothing to swap, the vinyl rows kept ──
    const cfgBefore = await configs(db);
    const vinylBefore = await rows(db, "select * from public.style_cladding where cladding_id = 'vinyl' order by client_id");
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply with vinyl rows in it runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re.some((n) => /already allows vinyl — nothing to swap/.test(n)), "and says there was nothing to swap", re.join(" | "));
    ok(re.some((n) => /checks hold; the CHECK already allowed ids agpanel,batten,lap,panel,vinyl; .* vinyl rows: 4; rehearsal: ok$/.test(n)), "and counts the vinyl rows", re.join(" | "));
    ok((await conDef(db, "style_cladding_cladding_id_check")) === FIVE_IDS, "the CHECK is unchanged by the re-apply");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(cfgBefore), "and every tenant reads what it read before, the vinyl entries included");
    ok(JSON.stringify(await rows(db, "select * from public.style_cladding where cladding_id = 'vinyl' order by client_id")) === JSON.stringify(vinylBefore), "and the vinyl rows are untouched");
    ok(re.record && re.record.swapped === "no" && re.record.vinyl_rows === 4 && re.record.configs_changed === "(none)" && re.record.rehearsal === "ok",
      "the re-apply's record says so", JSON.stringify(re.record));
    await db.close();
  }

  // ── 2. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 285: a Windows (CRLF) checkout of the file applies the same");
  {
    const lf = await fresh();
    const a = await apply(lf, MIG_TEXT().replace(/\r\n/g, "\n"));
    const crlf = await fresh();
    let err = null, b = null;
    try { b = await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n")); } catch (e) { err = e.message; }
    ok(!err, "the CRLF copy applies", err);
    ok((await conDef(crlf, "style_cladding_cladding_id_check")) === FIVE_IDS && JSON.stringify(a.record) === JSON.stringify(b && b.record),
      "to the same CHECK, with the same record", JSON.stringify(b && b.record));
    ok((await columnComment(lf)) === (await columnComment(crlf)).replace(/\r\n/g, "\n") || (await columnComment(lf)) === (await columnComment(crlf)),
      "and the same comment text");
    await lf.close(); await crlf.close();
  }

  // ── 3. The dry run: the same record, the four-id CHECK left ─────────────────────────────────
  console.log("migration 285: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await configs(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.cladding_ids === "agpanel,batten,lap,panel,vinyl" && notices.record.swapped === "yes"
      && notices.record.configs_changed === "(none)" && notices.record.tenants_checked === 5 && notices.record.rehearsal === "ok" && notices.record.vinyl_rows === 0,
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await conDef(db, "style_cladding_cladding_id_check")) === FOUR_IDS, "and leaves the four-id CHECK", await conDef(db, "style_cladding_cladding_id_check"));
    ok((await tableComment(db)) === TABLE_COMMENT_LIVE && (await columnComment(db)) === COLUMN_COMMENT_LIVE, "and both comments as they were");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "and no tenant's get_config moved");
    ok(/style_cladding_cladding_id_check/.test(String(await upsert(db, "acme-sheds", "utility", "vinyl", { rate: 0 }))), "a vinyl row is still refused after it");
    await db.close();
  }

  // ── 4. Nothing to rehearse on ───────────────────────────────────────────────────────────────
  console.log("migration 285: a database with no active style applies, and says it had nothing to rehearse on");
  {
    const db = await fresh();
    await db.exec("update public.building_styles set active = false");
    let notices = [];
    try { notices = await apply(db); } catch (e) { ok(false, "applied", e.message); }
    ok(notices.record && notices.record.rehearsal === "no active style to rehearse on" && notices.record.swapped === "yes", "the record says so", JSON.stringify(notices.record));
    await db.close();
  }

  // ── 5. Mutants: broken shapes are refused, and the whole file is rolled back ────────────────
  console.log("migration 285: refuses what it should not commit, leaving the four-id CHECK and the comments");
  {
    const cases = [
      ["vinyl misspelt in the new CHECK", mutateCheck((l) => l.replace("'vinyl'", "'vynil'")), /should allow exactly panel, lap, vinyl, batten, agpanel/],
      ["an id too many (barn)", mutateCheck((l) => l.replace("'vinyl')", "'vinyl', 'barn')")), /should allow exactly panel, lap, vinyl, batten, agpanel/],
      // Postgres itself refuses this one first: AG Panel rows exist, and ADD CONSTRAINT validates them.
      ["an id lost (agpanel)", mutateCheck((l) => l.replace("'agpanel', ", "")), /should allow exactly panel, lap, vinyl, batten, agpanel|style_cladding_cladding_id_check" of relation "style_cladding" is violated by some row/],
      ["a CHECK that is not a plain IN list", mutateCheck((l) => l.replace("'vinyl'));", "'vinyl') or cladding_id like 'v%');")), /should allow exactly panel, lap, vinyl, batten, agpanel/],
      // pg_get_constraintdef appends NOT VALID, so the shape check catches it before convalidated does.
      ["a CHECK added NOT VALID", mutateCheck((l) => l.replace("'vinyl'));", "'vinyl')) not valid;")), /should allow exactly .* NOT VALID$|is NOT VALID/],
      ["a file that seeds a vinyl row", afterSwap("insert into public.style_cladding (client_id, style_id, cladding_id, rate) select client_id, id, 'vinyl', 0 from public.building_styles where key = 'cabin';"), /already name vinyl/],
      ["a file that opens a course size to vinyl", afterSwap("alter table public.style_cladding drop constraint style_cladding_exposure_in_check, add constraint style_cladding_exposure_in_check check (exposure_in is null or (cladding_id in ('lap', 'vinyl') and exposure_in between 3 and 12));"), /exposure_in_check should still allow a size on lap rows only/],
      ["a file that shows a key on every entry", afterSwap(`do $x$ begin execute replace(pg_get_functiondef('public.get_config(text)'::regprocedure), '''charged'', coalesce(sc.rate, 0) > 0)', '''charged'', coalesce(sc.rate, 0) > 0, ''v'', 1)'); end $x$;`), /get_config changed for: acme-sheds, bravo-barns, charlie-cabins, delta-sheds$/],
    ];
    for (const [what, sql, re] of cases) {
      ok(sql !== MIG_TEXT(), `(mutant built: ${what})`);
      const db = await fresh();
      const r = await refused(db, sql, re);
      ok(r.matched && r.untouched && r.vinyl === 0, `${what}: refused, the four-id CHECK and both comments left, no vinyl row`, JSON.stringify(r));
      await db.close();
    }

    // The database is not the shape the file expects.
    const shapes = [
      ["no cladding CHECK at all", "alter table public.style_cladding drop constraint style_cladding_cladding_id_check", /style_cladding_cladding_id_check is missing/],
      ["exposure_in's CHECK gone", "alter table public.style_cladding drop constraint style_cladding_exposure_in_check", /exposure_in_check should still allow a size on lap rows only/],
      ["style_cladding readable by anon", "grant select on public.style_cladding to anon", /anon holds SELECT on style_cladding/],
      ["service_role unable to insert", "revoke insert on public.style_cladding from service_role", /service_role lacks INSERT on style_cladding/],
      ["RLS off", "alter table public.style_cladding disable row level security", /RLS is off on style_cladding/],
      ["a write policy", "create policy open_write on public.style_cladding for update to authenticated using (true)", /exactly one policy, a SELECT/],
      ["a second SELECT policy", "create policy everyone_reads on public.style_cladding for select to authenticated using (true)", /exactly one policy, a SELECT/],
      ["get_config closed to anon", "revoke execute on function public.get_config(text) from anon, public", /anon cannot EXECUTE get_config/],
    ];
    for (const [what, setup, re] of shapes) {
      const db = await fresh();
      await db.exec(setup);
      let err = null;
      try { await apply(db); } catch (e) { err = e.message; }
      await db.exec("rollback").catch(() => {});
      const def = await conDef(db, "style_cladding_cladding_id_check");
      ok(!!err && re.test(err) && def !== FIVE_IDS && (await tableComment(db)) === TABLE_COMMENT_LIVE,
        `${what}: refused, nothing of 285 left`, JSON.stringify({ err, def }));
      await db.close();
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
