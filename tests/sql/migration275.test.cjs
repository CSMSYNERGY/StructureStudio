// Execute migration 275 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// get_config's live claddingOptions block and style_cladding as it is live, then check what it
// promises:
//   * style_cladding.exposure_in arrives numeric, nullable, no default, NULL on every row, with its
//     named CHECK: lap rows only, 3 to 12 in; and nothing else on any row moves;
//   * every tenant's get_config is byte-for-byte what it was (no row has a size, and the key is
//     SPARSE: no `"exposureIn": null` anywhere);
//   * a size typed on a lap row reaches that style's lap entry, and only it, whether or not the
//     tenant shows prices (it is appearance, not price); cleared, the key is gone again; a row the
//     designer is not offered (inactive, no rate, an inactive style) carries nothing;
//   * anon can neither read nor write it, authenticated cannot write it (no write policy), and
//     service_role can do portal-settings' save (an upsert);
//   * a re-apply changes nothing and keeps the sizes; a CRLF checkout applies the same; 275 and 276
//     (the same batch, both splicing get_config) apply in either order to the same function;
//   * THE RECORD, the one row `supabase db query` prints, and a dry run (the last commit; swapped
//     for rollback;) prints the same row and leaves nothing;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration275.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/275_cladding_exposure.sql"), "utf8");
const MIG_276 = () => fs.readFileSync(path.join(WT, "supabase/migrations/276_quote_corner_views.sql"), "utf8");

// get_config's claddingOptions key as it is live (pg_get_functiondef, 2026-10-05), character for
// character, comments included, because the splice anchors inside it. The rest of the 17.8 KB body
// is cut to a few keys that read the same tables, and the TAIL is the live one too, so 276's anchor
// can be exercised beside this one. `extra` adds keys ahead of the block; `clad` swaps the block.
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
               order by sc.sort_order, sc.cladding_id) as list
        from public.style_cladding sc
        where sc.style_id = st.id and sc.active and sc.rate is not null
      ) cl
      where st.client_id = cc.client_id and st.active and cl.list is not null), '{}'::jsonb),
`;
const GET_CONFIG = (extra = "", clad = CLAD_LIVE) => `
create or replace function public.get_config(p_client_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    'branding', jsonb_build_object('companyName', cc.company_name, 'accentColor', cc.accent_color),
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),${extra}
${clad}    'sizePricing', coalesce((
        select jsonb_build_object(cc.client_id, cc.company_name)
        where cc.company_name is not null
      ), '{}'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;
$function$;
`;

// The live shapes (information_schema, pg_constraint, pg_policy, relacl; 2026-10-05), cut to the
// columns 275, 276 and the stub read. style_cladding: RLS on, one owner-scoped SELECT policy,
// ACL postgres + authenticated + service_role (anon revoked by 207). client_settings: RLS on, no
// policy, postgres + service_role only.
const STUBS = (extra, clad) => `
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
  ghl_api_key text, show_pricing boolean, quote_valid_days integer not null default 30,
  advanced_mode boolean not null default false
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
  unique (client_id, style_id, cladding_id)
);
alter table public.style_cladding enable row level security;
create policy style_cladding_owner_read on public.style_cladding
  for select to authenticated using (client_id = public.current_client_id());
grant all on public.style_cladding to anon, authenticated, service_role;
revoke all on public.style_cladding from anon;

${GET_CONFIG(extra, clad)}
`;

// Five tenants; four settings rows (live has a tenant without one); one tenant with no styles.
const SEED = `
insert into public.client_configs (client_id, company_name, accent_color) values
  ('acme-sheds', 'Acme Sheds', '#1D4ED8'), ('bravo-barns', 'Bravo Barns', '#8B4513'),
  ('charlie-cabins', 'Charlie Cabins', null), ('delta-sheds', 'Delta Sheds', '#000000'), ('echo-barns', null, '#222222');
insert into public.client_settings (client_id, ghl_api_key, show_pricing, updated_at) values
  ('acme-sheds', 'harness-key', true, '2026-09-01 10:00+00'), ('bravo-barns', null, null, '2026-09-02 10:00+00'),
  ('charlie-cabins', null, true, '2026-09-03 10:00+00'), ('delta-sheds', null, false, '2026-09-04 10:00+00');
insert into public.building_styles (client_id, key, label, active) values
  ('acme-sheds', 'deluxe', 'Deluxe Gable', true), ('acme-sheds', 'utility', 'Utility', true), ('acme-sheds', 'old', 'Old', false),
  ('bravo-barns', 'barn', 'Barn', true), ('charlie-cabins', 'cabin', 'Cabin', true), ('delta-sheds', 'shed', 'Shed', true);
insert into public.style_cladding (client_id, style_id, cladding_id, label_override, rate, taxable, internal_only, active, sort_order)
select s.client_id, s.id, r.cid, r.lbl, r.rate, r.tax, r.int, r.act, r.ord
  from public.building_styles s
  join (values
    ('acme-sheds',     'deluxe',  'panel',   null,           0::numeric, true,  false, true,  1),
    ('acme-sheds',     'deluxe',  'lap',     'Vinyl Siding', 0,          true,  false, true,  2),
    ('acme-sheds',     'deluxe',  'batten',  null,           null,       true,  false, true,  3),
    ('acme-sheds',     'deluxe',  'agpanel', null,           2.5,        false, true,  true,  4),
    ('acme-sheds',     'utility', 'panel',   null,           0,          true,  false, true,  1),
    ('acme-sheds',     'utility', 'lap',     null,           1.25,       true,  false, true,  2),
    ('acme-sheds',     'old',     'lap',     null,           0,          true,  false, true,  1),
    ('bravo-barns',    'barn',    'panel',   null,           0,          true,  false, true,  1),
    ('bravo-barns',    'barn',    'lap',     null,           0,          true,  false, false, 2),
    ('charlie-cabins', 'cabin',   'lap',     null,           0,          true,  true,  true,  1),
    ('delta-sheds',    'shed',    'panel',   null,           0,          true,  false, true,  1),
    ('delta-sheds',    'shed',    'lap',     null,           3,          true,  false, true,  2)
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

async function fresh(extra = "", clad = CLAD_LIVE) {
  const db = new PGlite();
  await db.exec(STUBS(extra, clad));
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
const column = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'style_cladding' and column_name = 'exposure_in'`)) || null;
const body = async (db) => (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
// get_config as TEXT, which is what the md5 check and the browser both see.
const configs = async (db) => Object.fromEntries((await rows(db,
  "select client_id, public.get_config(client_id)::text as cfg from public.client_configs order by client_id")).map((r) => [r.client_id, r.cfg]));
const lapEntry = (cfgText, styleKey) => ((JSON.parse(cfgText).claddingOptions || {})[styleKey] || []).find((e) => e.id === "lap") || null;
const setSize = (db, client, styleKey, cid, v) => db.query(`update public.style_cladding sc set exposure_in = $4
  from public.building_styles st where st.id = sc.style_id and sc.client_id = $1 and st.key = $2 and sc.cladding_id = $3`, [client, styleKey, cid, v]);
// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const spliced = (await body(db)).includes("exposureIn");
  return { err, matched: !!err && re.test(err), spliced, column: !!(await column(db)) };
}

// Rewrite the splice's own `v_add` line and nothing else. The ROLLBACK note in the header quotes the
// same expression, so a plain first-match replace would edit the comment and build a mutant that
// changes nothing.
const mutateAdd = (fn) => MIG_TEXT().replace(/^  v_add    text := chr\(10\) \|\| \$a\$.*$/m, (line) => fn(line));
const mutateCheck = (fn) => MIG_TEXT().replace(/^    check \(exposure_in is null or .*$/m, (line) => fn(line));

const SPLICE = "\n                 || case when sc.exposure_in is not null then jsonb_build_object('exposureIn', sc.exposure_in) else '{}'::jsonb end";
const INTERNAL_LINE = "                 || case when coalesce(sc.internal_only, false) then jsonb_build_object('internalOnly', true) else '{}'::jsonb end";

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 275: applies on the live shape, empty everywhere, and no tenant's config moves");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const cladBefore = await rows(db, "select * from public.style_cladding order by client_id, sort_order, cladding_id");
    let notices = [];
    try { notices = await apply(db); ok(true, "275 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "275 applied", e.message); }
    ok(notices.some((n) => /spliced exposureIn into get_config/.test(n)), "it spliced", notices.join(" | "));
    ok(notices.some((n) => /checks hold; exposure_in added, empty, on style_cladding; every tenant's get_config unchanged; rows with a size: 0; rehearsal: ok$/.test(n)),
      "its own checks held: added, empty, no config moved, the rehearsal ran", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "275", get_config_splices: 1, tenants_checked: 5, configs_changed: "(none)", rows_with_size: 0,
      rehearsal: "ok", anon_reads_get_config: true, anon_can_read_size: false,
    }), "THE RECORD, the row the CLI prints: one splice, five tenants unchanged, no sizes, rehearsal ok, grants as promised", JSON.stringify(rec));

    const col = await column(db);
    ok(col && col.data_type === "numeric" && col.is_nullable === "YES" && col.column_default === null, "the column is numeric, nullable, no default", JSON.stringify(col));
    const con = await one(db, `select pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid = 'public.style_cladding'::regclass and conname = 'style_cladding_exposure_in_check'`);
    ok(con && /cladding_id = 'lap'/.test(con.d) && /exposure_in >= \(?3\)?/.test(con.d.replace(/::numeric/g, "")) && /exposure_in <= \(?12\)?/.test(con.d.replace(/::numeric/g, "")),
      "its CHECK is named and says lap only, 3 to 12", con && con.d);
    const cladAfter = await rows(db, "select * from public.style_cladding order by client_id, sort_order, cladding_id");
    ok(cladAfter.every((r) => r.exposure_in === null), "NULL on every row");
    ok(JSON.stringify(cladAfter.map(({ exposure_in: _e, ...r }) => r)) === JSON.stringify(cladBefore), "no other style_cladding value moved");
    const comment = await one(db, `select col_description('public.style_cladding'::regclass,
      (select attnum from pg_attribute where attrelid = 'public.style_cladding'::regclass and attname = 'exposure_in')) as c`);
    ok(/lap board shows, in inches/.test(comment.c || "") && /Migration 275\./.test(comment.c || ""), "the column says what it is", comment.c);

    const after = await configs(db);
    ok(JSON.stringify(after) === JSON.stringify(before), "every tenant's get_config TEXT is byte-for-byte what it was", JSON.stringify({ before, after }));
    ok(Object.values(after).every((c) => !c.includes("exposureIn")), "and no tenant carries the key at all (sparse, not null)");

    const fnAfter = await body(db);
    const expected = fnBefore.replace(INTERNAL_LINE + "\n               order by sc.sort_order, sc.cladding_id) as list",
      INTERNAL_LINE + SPLICE + "\n               order by sc.sort_order, sc.cladding_id) as list");
    ok(expected !== fnBefore && fnAfter === expected, "get_config gained exactly the one expression, after internalOnly and before the order by", fnAfter.slice(0, 400));
    const attrs = await one(db, `select p.prosecdef, p.provolatile, p.proconfig::text as cfg, has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p where p.oid = 'public.get_config(text)'::regprocedure`);
    ok(attrs.prosecdef && attrs.provolatile === "s" && attrs.cfg === '{"search_path=\\"\\""}' && attrs.anon,
      "get_config is still STABLE SECURITY DEFINER, search_path '', and anon may call it", JSON.stringify(attrs));

    // ── A size typed, read back, cleared ──
    await setSize(db, "acme-sheds", "deluxe", "lap", 4.5);
    const on = await configs(db);
    const acme = JSON.parse(on["acme-sheds"]);
    const lap = lapEntry(on["acme-sheds"], "deluxe");
    ok(lap && lap.exposureIn === 4.5 && lap.label === "Vinyl Siding", "4.5 on the Deluxe lap row: its entry carries exposureIn 4.5", JSON.stringify(lap));
    ok(Object.keys(lap).join(",") === "id,rate,basis,label,charged,exposureIn", "the key is added at the end and nothing else in the entry moved", Object.keys(lap).join(","));
    const { exposureIn: _x, ...lapRest } = lap;
    ok(JSON.stringify(lapRest) === JSON.stringify(lapEntry(before["acme-sheds"], "deluxe")), "the rest of that entry is what it was");
    ok(acme.claddingOptions.deluxe.filter((e) => "exposureIn" in e).length === 1 && !acme.claddingOptions.utility.some((e) => "exposureIn" in e),
      "only that entry: not the style's other claddings, not the tenant's other style");
    ok(Object.keys(on).filter((k) => k !== "acme-sheds").every((k) => on[k] === before[k]), "every other tenant is still byte-for-byte unchanged");
    // Appearance, not price: emitted whether or not the tenant shows prices, beside internalOnly.
    await setSize(db, "delta-sheds", "shed", "lap", 5);
    await setSize(db, "charlie-cabins", "cabin", "lap", 12);
    const on2 = await configs(db);
    ok(lapEntry(on2["delta-sheds"], "shed").exposureIn === 5 && lapEntry(on2["delta-sheds"], "shed").rate === null,
      "a tenant hiding prices still gets the size (rate null, exposureIn 5)", JSON.stringify(lapEntry(on2["delta-sheds"], "shed")));
    const ch = lapEntry(on2["charlie-cabins"], "cabin");
    ok(ch.exposureIn === 12 && ch.internalOnly === true, "an internal-only lap row carries both keys", JSON.stringify(ch));
    // Rows the designer is not offered carry nothing, size or no size.
    await setSize(db, "acme-sheds", "old", "lap", 4.5);
    await setSize(db, "bravo-barns", "barn", "lap", 4.5);
    const on3 = await configs(db);
    ok(!("old" in JSON.parse(on3["acme-sheds"]).claddingOptions), "an inactive style is still absent");
    ok(on3["bravo-barns"] === before["bravo-barns"], "an inactive lap row is still absent, size or not");
    // Anon reads it through get_config (as the function's owner), never directly.
    await db.exec("set role anon");
    let anonCfg = null, anonErr = null, anonDirect = null;
    try { anonCfg = (await one(db, "select public.get_config('acme-sheds') as v")).v; } catch (e) { anonErr = e.message; }
    await db.exec("begin");
    try { await one(db, "select exposure_in from public.style_cladding"); anonDirect = "allowed"; } catch (e) { anonDirect = e.message; }
    await db.exec("rollback");
    await db.exec("reset role");
    ok(anonCfg && lapEntry(JSON.stringify(anonCfg), "deluxe").exposureIn === 4.5, "anon's get_config sees it", anonErr || "");
    ok(/permission denied/.test(String(anonDirect)), "anon cannot read the column itself", String(anonDirect));
    for (const [c, s] of [["acme-sheds", "deluxe"], ["delta-sheds", "shed"], ["charlie-cabins", "cabin"], ["acme-sheds", "old"], ["bravo-barns", "barn"]]) {
      await setSize(db, c, s, "lap", null);
    }
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "cleared again: the key is gone, every config is what it was");
    ok((await one(db, "select public.get_config('nobody-here') is null as n")).n, "an unknown tenant still reads NULL (the designer's 'Configuration not found')");

    // ── The CHECK, asked directly ──
    const tryUpdate = async (client, styleKey, cid, v) => {
      try { await setSize(db, client, styleKey, cid, v); return "stored"; } catch (e) { return /exposure_in_check/.test(e.message) ? "refused" : e.message; }
    };
    ok(await tryUpdate("acme-sheds", "deluxe", "panel", 4.5) === "refused", "a panel row cannot hold a size");
    ok(await tryUpdate("acme-sheds", "deluxe", "agpanel", 6) === "refused", "an AG Panel row cannot hold a size");
    ok(await tryUpdate("acme-sheds", "deluxe", "lap", 2.99) === "refused", "2.99 in is refused");
    ok(await tryUpdate("acme-sheds", "deluxe", "lap", 12.01) === "refused", "12.01 in is refused");
    ok(await tryUpdate("acme-sheds", "deluxe", "lap", 3) === "stored" && await tryUpdate("acme-sheds", "deluxe", "lap", 12) === "stored", "3 and 12 are both allowed");
    await setSize(db, "acme-sheds", "deluxe", "lap", null);

    // ── Grants, asked of Postgres directly ──
    const priv = await one(db, `select
      has_column_privilege('anon', 'public.style_cladding', 'exposure_in', 'SELECT') as anon_sel,
      has_column_privilege('anon', 'public.style_cladding', 'exposure_in', 'UPDATE') as anon_upd,
      has_column_privilege('service_role', 'public.style_cladding', 'exposure_in', 'SELECT') as svc_sel,
      has_column_privilege('service_role', 'public.style_cladding', 'exposure_in', 'INSERT') as svc_ins,
      has_column_privilege('service_role', 'public.style_cladding', 'exposure_in', 'UPDATE') as svc_upd`);
    ok(!priv.anon_sel && !priv.anon_upd, "anon can neither read nor write it", JSON.stringify(priv));
    ok(priv.svc_sel && priv.svc_ins && priv.svc_upd, "service_role can read and write it", JSON.stringify(priv));
    // authenticated: the owner can READ its own rows (207's policy) and can write nothing (no write
    // policy), the new column included.
    await db.exec("begin");
    await db.exec("set local harness.client_id = 'acme-sheds'");
    await db.exec("set local role authenticated");
    const own = await rows(db, "select client_id, exposure_in from public.style_cladding");
    const upd = await db.query("update public.style_cladding set exposure_in = 4.5 where cladding_id = 'lap'");
    await db.exec("rollback");
    ok(own.length > 0 && own.every((r) => r.client_id === "acme-sheds"), "authenticated reads its own rows only", JSON.stringify(own.map((r) => r.client_id)));
    ok(upd.affectedRows === 0, "and writes none of them (no write policy)", String(upd.affectedRows));

    // portal-settings' save, as service_role and as the handler makes it: an upsert of named columns.
    const st = await one(db, "select id from public.building_styles where client_id = 'acme-sheds' and key = 'deluxe'");
    await db.exec("begin");
    await db.exec("set local role service_role");
    let upErr = null;
    try {
      await db.query(`insert into public.style_cladding (client_id, style_id, cladding_id, label_override, rate, basis, taxable, active, internal_only, sort_order, exposure_in, updated_at)
                      values ('acme-sheds', $1, 'lap', '4.5" Vinyl Siding', 0, 'sqft_option', true, true, false, 1, 4.5, now())
                      on conflict (client_id, style_id, cladding_id) do update set label_override = excluded.label_override, rate = excluded.rate,
                        basis = excluded.basis, taxable = excluded.taxable, active = excluded.active, internal_only = excluded.internal_only,
                        sort_order = excluded.sort_order, exposure_in = excluded.exposure_in, updated_at = excluded.updated_at`, [st.id]);
    } catch (e) { upErr = e.message; }
    await db.exec(upErr ? "rollback" : "commit");
    ok(!upErr, "service_role's upsert (the Cladding save) works with the size in it", upErr);
    const saved = lapEntry((await configs(db))["acme-sheds"], "deluxe");
    ok(saved.exposureIn === 4.5 && saved.label === '4.5" Vinyl Siding', "and get_config carries what it saved", JSON.stringify(saved));

    // ── Re-apply: nothing to splice, and the sizes kept ──
    const sizedBefore = await configs(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply with a size in it runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re.some((n) => /already emits exposureIn — nothing to splice/.test(n)), "and says there was nothing to splice", re.join(" | "));
    ok(re.some((n) => /exposure_in kept on style_cladding; .* rows with a size: 1; rehearsal: ok$/.test(n)), "and counts the row with a size", re.join(" | "));
    ok((await body(db)) === fnAfter, "get_config is unchanged by the re-apply (still one splice)");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(sizedBefore), "and every tenant reads what it read before, the sized row included");
    ok(re.record && re.record.rows_with_size === 1 && re.record.configs_changed === "(none)", "the re-apply's record counts it", JSON.stringify(re.record));
    await db.close();
  }

  // ── 2. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 275: a Windows (CRLF) checkout of the file splices the same body");
  {
    const lf = await fresh();
    await apply(lf, MIG_TEXT().replace(/\r\n/g, "\n"));
    const crlf = await fresh();
    let err = null;
    try { await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n")); } catch (e) { err = e.message; }
    ok(!err, "the CRLF copy applies", err);
    const a = await body(lf);
    const b = await body(crlf);
    ok(a === b && a.includes(INTERNAL_LINE + SPLICE + "\n               order by"), "both produce the same get_config, spliced in the same place");
    await lf.close(); await crlf.close();
  }

  // ── 3. 275 and 276 in either order ──────────────────────────────────────────────────────────
  console.log("migration 275: 275 and 276 (both splice get_config) apply in either order to the same function");
  {
    const a = await fresh();
    let errA = null;
    try { await apply(a, MIG_TEXT()); await apply(a, MIG_276()); } catch (e) { errA = e.message; }
    const b = await fresh();
    let errB = null;
    try { await apply(b, MIG_276()); await apply(b, MIG_TEXT()); } catch (e) { errB = e.message; }
    ok(!errA && !errB, "275 then 276, and 276 then 275, both apply", errA || errB);
    const fa = await body(a), fb = await body(b);
    ok(fa === fb && fa.includes("exposureIn") && fa.includes("quoteCornerViews"), "to the same body, carrying both keys");
    await a.close(); await b.close();
  }

  // ── 4. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 275: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.get_config_splices === 1 && notices.record.configs_changed === "(none)" && notices.record.tenants_checked === 5 && notices.record.rehearsal === "ok",
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok(!(await column(db)) && (await body(db)) === fnBefore, "and leaves no column and no splice behind");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "and no tenant's get_config moved");
    await db.close();
  }

  // ── 5. Nothing to rehearse on ───────────────────────────────────────────────────────────────
  console.log("migration 275: a database with no offered lap row applies, and says it had nothing to rehearse on");
  {
    const db = await fresh();
    await db.exec("update public.style_cladding set rate = null where cladding_id = 'lap'");
    let notices = [];
    try { notices = await apply(db); } catch (e) { ok(false, "applied", e.message); }
    ok(notices.record && notices.record.rehearsal === "no offered lap row to rehearse on", "the record says so", JSON.stringify(notices.record));
    await db.close();
  }

  // ── 6. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 275: refuses what it cannot splice or check");
  {
    // The anchor twice: the same text inside a string earlier in the body.
    let db = await fresh(`\n    'note', $q$${INTERNAL_LINE}\n               order by sc.sort_order, sc.cladding_id) as list$q$,`);
    let r = await refused(db, MIG_TEXT(), /anchor found 2 time\(s\)/);
    ok(r.matched && !r.spliced && !r.column, "the anchor twice: refused, no splice, no column", JSON.stringify(r));
    await db.close();

    // The anchor gone: the order by pulled up onto the internalOnly line.
    db = await fresh("", CLAD_LIVE.replace(INTERNAL_LINE + "\n               order by", INTERNAL_LINE + " order by"));
    r = await refused(db, MIG_TEXT(), /anchor found 0 time\(s\)/);
    ok(r.matched && !r.spliced && !r.column, "the anchor missing: refused, no splice, no column", JSON.stringify(r));
    await db.close();

    // A splice that is not sparse: a key on every entry. The md5 check catches it.
    db = await fresh();
    const dense = mutateAdd((l) => l.replace("else '{}'::jsonb end$a$;", "else jsonb_build_object('courseIn', 6) end$a$;"));
    ok(dense !== MIG_TEXT(), "(mutant built: a key emitted on every entry)");
    r = await refused(db, dense, /get_config changed for: acme-sheds, bravo-barns, charlie-cabins, delta-sheds$/);
    ok(r.matched && !r.spliced && !r.column, "a dense splice: refused by the apply's own md5 check, naming who would have moved", JSON.stringify(r));
    await db.close();

    // A splice that never emits: the rehearsal catches it.
    db = await fresh();
    const mute = mutateAdd((l) => l.replace("is not null then", "is not null and false then"));
    ok(mute !== MIG_TEXT(), "(mutant built: a splice that can never be true)");
    r = await refused(db, mute, /setting 4\.5 on a lap row did not make its get_config entry emit "exposureIn": 4\.5/);
    ok(r.matched && !r.spliced && !r.column, "a size that never reaches get_config: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A CHECK that lets a non-lap row hold a size.
    db = await fresh();
    const anyRow = mutateCheck((l) => l.replace("(cladding_id = 'lap' and exposure_in between 3 and 12)", "exposure_in between 3 and 12"));
    ok(anyRow !== MIG_TEXT(), "(mutant built: CHECK without lap-only)");
    r = await refused(db, anyRow, /the CHECK let something through \(refused only: below3 above12\)/);
    ok(r.matched && !r.spliced && !r.column, "a CHECK that is not lap-only: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A CHECK with the wrong range.
    db = await fresh();
    const wide = mutateCheck((l) => l.replace("between 3 and 12", "between 1 and 20"));
    ok(wide !== MIG_TEXT(), "(mutant built: CHECK 1..20)");
    r = await refused(db, wide, /the CHECK let something through \(refused only: notlap\)/);
    ok(r.matched && !r.spliced && !r.column, "a CHECK with the wrong range: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // A column added by hand with no CHECK: the re-run path must not trust it.
    db = await fresh();
    await db.exec("alter table public.style_cladding add column exposure_in numeric");
    r = await refused(db, MIG_TEXT(), /style_cladding_exposure_in_check is missing/);
    ok(r.matched && !r.spliced, "an unchecked exposure_in already there: refused, no splice", JSON.stringify(r));
    await db.close();

    // A column with a default: every lap row would change size at once (and every other row break the CHECK).
    db = await fresh();
    const dflt = MIG_TEXT().replace("add column if not exists exposure_in numeric\n", "add column if not exists exposure_in numeric default 4.5\n")
      .replace("add column if not exists exposure_in numeric\r\n", "add column if not exists exposure_in numeric default 4.5\r\n");
    ok(dflt !== MIG_TEXT(), "(mutant built: default 4.5)");
    r = await refused(db, dflt, /exposure_in_check|should be numeric, nullable, no default/);
    ok(r.matched && !r.spliced && !r.column, "a column with a default: refused, nothing of 275 left", JSON.stringify(r));
    await db.close();

    // The table open to anon: adding a column to it would publish the column too.
    db = await fresh();
    await db.exec("grant select on public.style_cladding to anon");
    r = await refused(db, MIG_TEXT(), /anon holds SELECT on style_cladding\.exposure_in/);
    ok(r.matched && !r.spliced && !r.column, "style_cladding readable by anon: refused, nothing of 275 left", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: the Cladding save would fail for every builder.
    db = await fresh();
    await db.exec("revoke update on public.style_cladding from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on style_cladding\.exposure_in/);
    ok(r.matched && !r.spliced && !r.column, "service_role without UPDATE: refused, nothing of 275 left", JSON.stringify(r));
    await db.close();

    // RLS switched off, or a write policy added: writes no longer go through portal-settings only.
    db = await fresh();
    await db.exec("alter table public.style_cladding disable row level security");
    r = await refused(db, MIG_TEXT(), /RLS is off on style_cladding/);
    ok(r.matched && !r.spliced && !r.column, "RLS off: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("create policy open_write on public.style_cladding for update to authenticated using (true)");
    r = await refused(db, MIG_TEXT(), /style_cladding has a write policy/);
    ok(r.matched && !r.spliced && !r.column, "a write policy on style_cladding: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
