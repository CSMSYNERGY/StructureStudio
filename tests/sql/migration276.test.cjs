// Execute migration 276 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// get_config's live tail and client_settings as it is live, then check what it promises:
//   * client_settings.quote_corner_views arrives boolean NOT NULL DEFAULT false, off on every row,
//     and nothing else on any row moves;
//   * every tenant's get_config is byte-for-byte what it was (the switch is off for everyone, and
//     the key is SPARSE: no `"quoteCornerViews": false` anywhere);
//   * switched on, get_config carries `"quoteCornerViews": true` for that tenant only, and for anon
//     too (get_config reads the column as its owner); switched off, the key is gone again; a tenant
//     with no settings row has no key; an unknown tenant still reads NULL;
//   * the browser roles can neither read nor write the column, and service_role can do
//     portal-settings' save (an upsert);
//   * a re-apply changes nothing and keeps what builders chose; a CRLF checkout applies the same;
//   * THE RECORD, the one row `supabase db query` prints, and a dry run (the last commit; swapped
//     for rollback;) prints the same row and leaves nothing;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration276.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/276_quote_corner_views.sql"), "utf8");

// get_config as it is live (pg_get_functiondef, 2026-10-05): the signature, the attributes, the
// head and the TAIL are the live text character for character, because the splice anchors on the
// tail. The middle of the 17.8 KB body is cut to a few keys that read client_settings, so "nothing
// else changed" has something to be wrong about. `extra` adds keys before the tail, for mutants.
const TAIL_LIVE = `      ), '{}'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;`;
const GET_CONFIG = (extra = "", tail = TAIL_LIVE) => `
create or replace function public.get_config(p_client_id text)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case when cc.client_id is null then null else jsonb_build_object(
    'clientId', cc.client_id,
    'branding', jsonb_build_object('companyName', cc.company_name, 'tagline', cc.tagline,
      'logo', cc.logo_url, 'headerBg', cc.header_bg, 'accentColor', cc.accent_color),
    'options',       cc.options,
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),${extra}
    'sizePricing', coalesce((
        select jsonb_build_object(cc.client_id, cc.company_name)
        where cc.company_name is not null
${tail}
$function$;
`;

// The live shapes (information_schema, 2026-10-05), cut to the columns 276 and the stub read.
// client_settings: RLS on with no policies, and an ACL of postgres + service_role only — granted to
// everyone first and then revoked, which is how Supabase's default privileges and the migrations
// that closed it left it.
const STUBS = (extra, tail) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.client_configs (
  client_id text primary key, company_name text, tagline text, logo_url text, header_bg text,
  accent_color text, options jsonb
);
revoke all on public.client_configs from anon, authenticated;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(),
  ghl_api_key text, show_pricing boolean, quote_valid_days integer not null default 30,
  advanced_mode boolean not null default false, ramp_enabled boolean not null default true
);
alter table public.client_settings enable row level security;
grant all on public.client_settings to anon, authenticated, service_role;
revoke all on public.client_settings from anon, authenticated;

${GET_CONFIG(extra, tail)}
`;

// Five tenants, four settings rows: live has one tenant without a row.
const SEED = `
insert into public.client_configs (client_id, company_name, accent_color, options) values
  ('acme-sheds',     'Acme Sheds',     '#1D4ED8', '[{"k":1}]'),
  ('bravo-barns',    'Bravo Barns',    '#8B4513', '[]'),
  ('charlie-cabins', 'Charlie Cabins', null,      null),
  ('delta-sheds',    'Delta Sheds',    '#000000', '[]'),
  ('echo-barns',     null,             '#222222', '[]');
insert into public.client_settings (client_id, ghl_api_key, show_pricing, quote_valid_days, advanced_mode, updated_at) values
  ('acme-sheds',     'harness-key', true,  14, true,  '2026-09-01 10:00+00'),
  ('bravo-barns',    null,          null,  30, false, '2026-09-02 10:00+00'),
  ('charlie-cabins', null,          true,  60, false, '2026-09-03 10:00+00'),
  ('delta-sheds',    null,          false, 30, false, '2026-09-04 10:00+00');
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh(extra = "", tail = TAIL_LIVE) {
  const db = new PGlite();
  await db.exec(STUBS(extra, tail));
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
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_corner_views'`)) || null;
const body = async (db) => (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
// get_config as TEXT, which is what the md5 check and the browser both see.
const configs = async (db) => Object.fromEntries((await rows(db,
  "select client_id, public.get_config(client_id)::text as cfg from public.client_configs order by client_id")).map((r) => [r.client_id, r.cfg]));
// Did the apply fail with `re`, and leave nothing behind?
async function refused(db, sql, re) {
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const spliced = (await body(db)).includes("quoteCornerViews");
  return { err, matched: !!err && re.test(err), spliced, column: !!(await column(db)) };
}

// Rewrite the splice's own `v_add` line and nothing else. The ROLLBACK note in the header quotes the
// same expression, so a plain first-match replace would edit the comment and build a mutant that
// changes nothing.
const mutateAdd = (fn) => MIG_TEXT().replace(/^  v_add    text := \$a\$.*$/m, (line) => fn(line));

const SPLICE = " || case when coalesce((select cs.quote_corner_views from public.client_settings cs where cs.client_id = cc.client_id), false) then jsonb_build_object('quoteCornerViews', true) else '{}'::jsonb end";

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 276: applies on the live shape, off for everyone, and no tenant's config moves");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const settingsBefore = await rows(db, "select * from public.client_settings order by client_id");
    let notices = [];
    try { notices = await apply(db); ok(true, "276 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "276 applied", e.message); }
    ok(notices.some((n) => /spliced quoteCornerViews into get_config/.test(n)), "it spliced", notices.join(" | "));
    ok(notices.some((n) => /checks hold; quote_corner_views added, off, on client_settings; every tenant's get_config unchanged; on for: \(none\)$/.test(n)),
      "its own checks held: added, off, no config moved", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "276", get_config_splices: 1, tenants_checked: 5, configs_changed: "(none)", switched_on: 0,
      anon_reads_get_config: true, browser_can_read_switch: false,
    }), "THE RECORD, the row the CLI prints: one splice, five tenants unchanged, nobody on, grants as promised", JSON.stringify(rec));

    const col = await column(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "false", "the column is boolean NOT NULL DEFAULT false", JSON.stringify(col));
    const settingsAfter = await rows(db, "select * from public.client_settings order by client_id");
    ok(settingsAfter.every((r) => r.quote_corner_views === false), "off on every row");
    ok(JSON.stringify(settingsAfter.map(({ quote_corner_views: _q, ...r }) => r)) === JSON.stringify(settingsBefore), "no other client_settings value moved");
    const comment = await one(db, `select col_description('public.client_settings'::regclass,
      (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'quote_corner_views')) as c`);
    ok(/all four corners/.test(comment.c || "") && /Off by default\. Migration 276\./.test(comment.c || ""), "the column says what it is", comment.c);

    const after = await configs(db);
    ok(JSON.stringify(after) === JSON.stringify(before), "every tenant's get_config TEXT is byte-for-byte what it was", JSON.stringify({ before, after }));
    ok(Object.values(after).every((c) => !c.includes("quoteCornerViews")), "and no tenant carries the key at all (sparse, not false)");

    const fnAfter = await body(db);
    const expected = fnBefore.replace("\n  ) end\n  from public.client_configs cc where cc.client_id = p_client_id;",
      "\n  )" + SPLICE + " end\n  from public.client_configs cc where cc.client_id = p_client_id;");
    ok(expected !== fnBefore && fnAfter === expected, "get_config gained exactly the one expression, between the object's `)` and the CASE's `end`", fnAfter.slice(-500));
    const attrs = await one(db, `select p.prosecdef, p.provolatile, p.proconfig::text as cfg, has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p where p.oid = 'public.get_config(text)'::regprocedure`);
    ok(attrs.prosecdef && attrs.provolatile === "s" && attrs.cfg === '{"search_path=\\"\\""}' && attrs.anon,
      "get_config is still STABLE SECURITY DEFINER, search_path '', and anon may call it", JSON.stringify(attrs));

    // ── Switched on, off, missing rows, unknown tenants ──
    await db.exec("update public.client_settings set quote_corner_views = true where client_id = 'bravo-barns'");
    const on = await configs(db);
    const bravo = JSON.parse(on["bravo-barns"]);
    ok(bravo.quoteCornerViews === true, "switched on: bravo-barns' get_config carries quoteCornerViews: true", on["bravo-barns"]);
    const { quoteCornerViews: _k, ...bravoRest } = bravo;
    ok(JSON.stringify(bravoRest) === JSON.stringify(JSON.parse(before["bravo-barns"])), "and nothing else in bravo-barns' config moved");
    ok(Object.keys(on).filter((k) => k !== "bravo-barns").every((k) => on[k] === before[k]), "every other tenant is still byte-for-byte unchanged");
    // anon is who the public designer calls get_config as; the column is closed to it, and get_config
    // reads it as its owner.
    await db.exec("set role anon");
    let anonCfg = null, anonErr = null, anonDirect = null;
    try { anonCfg = (await one(db, "select public.get_config('bravo-barns') -> 'quoteCornerViews' as v")).v; } catch (e) { anonErr = e.message; }
    await db.exec("begin");
    try { await one(db, "select quote_corner_views from public.client_settings"); anonDirect = "allowed"; } catch (e) { anonDirect = e.message; }
    await db.exec("rollback");
    await db.exec("reset role");
    ok(anonCfg === true, "anon's get_config sees it (read as get_config's owner)", anonErr || String(anonCfg));
    ok(/permission denied/.test(String(anonDirect)), "anon cannot read the column itself", String(anonDirect));
    await db.exec("update public.client_settings set quote_corner_views = false where client_id = 'bravo-barns'");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "switched off again: the key is gone, every config is what it was");
    ok(!(await configs(db))["echo-barns"].includes("quoteCornerViews"), "a tenant with no settings row has no key");
    ok((await one(db, "select public.get_config('nobody-here') is null as n")).n, "an unknown tenant still reads NULL (the designer's 'Configuration not found')");

    // ── Grants, asked of Postgres directly ──
    const priv = await one(db, `select
      has_column_privilege('anon', 'public.client_settings', 'quote_corner_views', 'SELECT') as anon_sel,
      has_column_privilege('anon', 'public.client_settings', 'quote_corner_views', 'UPDATE') as anon_upd,
      has_column_privilege('authenticated', 'public.client_settings', 'quote_corner_views', 'SELECT') as auth_sel,
      has_column_privilege('authenticated', 'public.client_settings', 'quote_corner_views', 'INSERT') as auth_ins,
      has_column_privilege('authenticated', 'public.client_settings', 'quote_corner_views', 'UPDATE') as auth_upd,
      has_column_privilege('service_role', 'public.client_settings', 'quote_corner_views', 'SELECT') as svc_sel,
      has_column_privilege('service_role', 'public.client_settings', 'quote_corner_views', 'INSERT') as svc_ins,
      has_column_privilege('service_role', 'public.client_settings', 'quote_corner_views', 'UPDATE') as svc_upd`);
    ok(!priv.anon_sel && !priv.anon_upd && !priv.auth_sel && !priv.auth_ins && !priv.auth_upd, "anon and authenticated can neither read nor write it", JSON.stringify(priv));
    ok(priv.svc_sel && priv.svc_ins && priv.svc_upd, "service_role can read and write it", JSON.stringify(priv));

    // portal-settings' save, as service_role and as the handler makes it: an upsert of named columns,
    // here on an existing row and on the tenant that has none.
    await db.exec("begin");
    await db.exec("set local role service_role");
    let upErr = null;
    try {
      for (const id of ["acme-sheds", "echo-barns"]) {
        await db.query(`insert into public.client_settings (client_id, quote_corner_views, updated_at) values ($1, true, now())
                        on conflict (client_id) do update set quote_corner_views = excluded.quote_corner_views, updated_at = excluded.updated_at`, [id]);
      }
    } catch (e) { upErr = e.message; }
    await db.exec("reset role");
    ok(!upErr, "service_role's upsert works on an existing row and a missing one", upErr);
    const acme = await one(db, "select quote_corner_views, show_pricing, quote_valid_days, advanced_mode, ghl_api_key from public.client_settings where client_id = 'acme-sheds'");
    ok(acme.quote_corner_views === true && acme.show_pricing === true && acme.quote_valid_days === 14 && acme.advanced_mode === true && acme.ghl_api_key === "harness-key",
      "the upsert touched only the switch", JSON.stringify(acme));
    await db.exec("commit");

    // ── Re-apply: nothing to splice, and builders' choices kept ──
    const onBefore = await configs(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply with builders' choices in it runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re.some((n) => /already emits quoteCornerViews — nothing to splice/.test(n)), "and says there was nothing to splice", re.join(" | "));
    ok(re.some((n) => /quote_corner_views kept on client_settings; .* on for: acme-sheds, echo-barns$/.test(n)), "and names who has it on", re.join(" | "));
    ok((await body(db)) === fnAfter, "get_config is unchanged by the re-apply (still one splice)");
    const reCfg = await configs(db);
    ok(JSON.stringify(reCfg) === JSON.stringify(onBefore) && JSON.parse(reCfg["acme-sheds"]).quoteCornerViews === true,
      "and every tenant reads what it read before, the two switched on included");
    ok(re.record && re.record.switched_on === 2 && re.record.configs_changed === "(none)", "the re-apply's record counts them", JSON.stringify(re.record));
    await db.close();
  }

  // ── 2. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 276: a Windows (CRLF) checkout of the file splices the same body");
  {
    const lf = await fresh();
    await apply(lf, MIG_TEXT().replace(/\r\n/g, "\n"));
    const crlf = await fresh();
    let err = null;
    try { await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n")); } catch (e) { err = e.message; }
    ok(!err, "the CRLF copy applies", err);
    const a = await body(lf);
    const b = await body(crlf);
    ok(a === b && a.includes("\n  )" + SPLICE + " end\n"), "both produce the same get_config, spliced in the same place");
    await lf.close(); await crlf.close();
  }

  // ── 3. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 276: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.get_config_splices === 1 && notices.record.configs_changed === "(none)" && notices.record.tenants_checked === 5,
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok(!(await column(db)) && (await body(db)) === fnBefore, "and leaves no column and no splice behind");
    ok(JSON.stringify(await configs(db)) === JSON.stringify(before), "and no tenant's get_config moved");
    await db.close();
  }

  // ── 4. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 276: refuses what it cannot splice or check");
  {
    // The anchor twice: the same text inside a string literal earlier in the body.
    let db = await fresh(`\n    'note', '\n  ) end\n  from public.client_configs cc where cc.client_id = p_client_id;',`);
    let r = await refused(db, MIG_TEXT(), /anchor found 2 time\(s\)/);
    ok(r.matched && !r.spliced && !r.column, "the anchor twice: refused, no splice, no column", JSON.stringify(r));
    await db.close();

    // The anchor gone: the tail reformatted onto one line.
    db = await fresh("", `      ), '{}'::jsonb)\n  ) end from public.client_configs cc where cc.client_id = p_client_id;`);
    r = await refused(db, MIG_TEXT(), /anchor found 0 time\(s\)/);
    ok(r.matched && !r.spliced && !r.column, "the anchor missing: refused, no splice, no column", JSON.stringify(r));
    await db.close();

    // A splice that is not sparse: a key on every tenant. The md5 check catches it.
    db = await fresh();
    const dense = mutateAdd((l) => l.replace("else '{}'::jsonb end$a$;", "else jsonb_build_object('cornerViews', false) end$a$;"));
    ok(dense !== MIG_TEXT(), "(mutant built: a key emitted for everyone)");
    r = await refused(db, dense, /get_config changed for: acme-sheds, bravo-barns, charlie-cabins, delta-sheds, echo-barns$/);
    ok(r.matched && !r.spliced && !r.column, "a dense splice: refused by the apply's own md5 check", JSON.stringify(r));
    await db.close();

    // A splice that reads the wrong column: on for every tenant that shows prices.
    db = await fresh();
    const wrong = mutateAdd((l) => l.replace("select cs.quote_corner_views from", "select cs.show_pricing from"));
    ok(wrong !== MIG_TEXT(), "(mutant built: keyed on show_pricing)");
    r = await refused(db, wrong, /get_config changed for: acme-sheds, charlie-cabins$/);
    ok(r.matched && !r.spliced && !r.column, "a splice keyed on the wrong column: refused, naming who would have moved", JSON.stringify(r));
    await db.close();

    // A splice that never emits: the rehearsal catches it.
    db = await fresh();
    const mute = mutateAdd((l) => l.replace("false) then", "false) and false then"));
    ok(mute !== MIG_TEXT(), "(mutant built: a splice that can never be true)");
    r = await refused(db, mute, /switching it on for acme-sheds did not make get_config emit "quoteCornerViews": true/);
    ok(r.matched && !r.spliced && !r.column, "a switch that never reaches get_config: refused by the rehearsal", JSON.stringify(r));
    await db.close();

    // The default flipped: every builder's quote would change at once.
    db = await fresh();
    const allOn = MIG_TEXT().replace("add column if not exists quote_corner_views boolean not null default false;",
      "add column if not exists quote_corner_views boolean not null default true;");
    ok(allOn !== MIG_TEXT(), "(mutant built: default true)");
    r = await refused(db, allOn, /should be boolean NOT NULL DEFAULT false/);
    ok(r.matched && !r.spliced && !r.column, "a column that would switch it on for everyone: refused, nothing of 276 left", JSON.stringify(r));
    await db.close();

    // A nullable leftover from a hand-run experiment: the re-run path must not accept it.
    db = await fresh();
    await db.exec("alter table public.client_settings add column quote_corner_views boolean");
    r = await refused(db, MIG_TEXT(), /should be boolean NOT NULL DEFAULT false/);
    ok(r.matched && !r.spliced, "a nullable quote_corner_views already there: refused, no splice", JSON.stringify(r));
    await db.close();

    // The table open to the browser: adding a column to it would publish the column too.
    db = await fresh();
    await db.exec("grant select on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on client_settings\.quote_corner_views/);
    ok(r.matched && !r.spliced && !r.column, "client_settings readable by authenticated: refused, nothing of 276 left", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: portal-settings' save would fail on every builder.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on client_settings\.quote_corner_views/);
    ok(r.matched && !r.spliced && !r.column, "service_role without UPDATE: refused, nothing of 276 left", JSON.stringify(r));
    await db.close();

    // RLS switched off, or a policy added: the table is no longer service-role only.
    db = await fresh();
    await db.exec("alter table public.client_settings disable row level security");
    r = await refused(db, MIG_TEXT(), /RLS is off on client_settings/);
    ok(r.matched && !r.spliced && !r.column, "RLS off: refused", JSON.stringify(r));
    await db.close();
    db = await fresh();
    await db.exec("create policy open_read on public.client_settings for select using (true)");
    r = await refused(db, MIG_TEXT(), /client_settings has a policy/);
    ok(r.matched && !r.spliced && !r.column, "a policy on client_settings: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
