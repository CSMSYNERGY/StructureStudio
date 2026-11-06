// Execute migration 322 for real in PGlite (Postgres compiled to WASM, in memory), on top of the
// REAL 276 file applied to get_config's live tail and client_settings as it is live, then check
// what it promises:
//   * client_settings.quote_corner_views becomes DEFAULT true, every row that read off reads on,
//     and nothing else on any row moves (updated_at included);
//   * get_config carries `"quoteCornerViews": true` for every tenant, the one with NO settings row
//     included (the fallback reads the default), and nothing else in any tenant's config moves;
//   * a new tenant reads on with no row, and again once a portal-settings-style upsert that does
//     not name the column makes one; a builder who unticks it loses the key, and only that builder;
//   * a re-apply changes nothing and keeps a builder's untick; a CRLF checkout applies the same;
//   * THE RECORD, the one row `supabase db query` prints, and a dry run (the last commit; swapped
//     for rollback;) prints the same row and leaves nothing;
//   * broken shapes are refused with the WHOLE file rolled back (mutants).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration322.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of 322 (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/322_quote_corner_views_on.sql"), "utf8");
const MIG_276 = () => fs.readFileSync(path.join(WT, "supabase/migrations/276_quote_corner_views.sql"), "utf8");

// get_config as it is live, cut down the way migration276.test.cjs cuts it: the live tail (276
// anchors on it) and a few keys that read client_settings, so "nothing else moved" has something
// to be wrong about.
const TAIL_LIVE = `      ), '{}'::jsonb)
  ) end
  from public.client_configs cc where cc.client_id = p_client_id;`;
const GET_CONFIG = `
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
    'showPricing', coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false),
    'sizePricing', coalesce((
        select jsonb_build_object(cc.client_id, cc.company_name)
        where cc.company_name is not null
${TAIL_LIVE}
$function$;
`;

// The live shapes, as migration276.test.cjs has them: client_settings is RLS on with no policy and
// an ACL of postgres + service_role only.
const STUBS = `
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

${GET_CONFIG}
`;

// Five tenants, four settings rows (echo-barns has none, the create_client case), and after 276
// one builder already ticked it, as structure-studio had on 2026-10-21.
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
const OLD = "cs.client_id = cc.client_id), false) then jsonb_build_object('quoteCornerViews', true)";
const NEW = "cs.client_id = cc.client_id), true) then jsonb_build_object('quoteCornerViews', true)";

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

// The live shape on 2026-10-21: 276 applied, one builder on. `with276: false` is the database
// before 276, for the mutant that says "apply 276 first".
async function fresh({ with276 = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(SEED);
  if (with276) {
    await db.exec(MIG_276());
    await db.exec("update public.client_settings set quote_corner_views = true where client_id = 'acme-sheds'");
  }
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
const DRY_RUN = () => {
  const t = MIG_TEXT();
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
const column = async (db) => (await one(db, `select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_corner_views'`)) || null;
const body = async (db) => (await one(db, "select pg_get_functiondef('public.get_config(text)'::regprocedure) as s")).s;
const settings = async (db) => rows(db, "select * from public.client_settings order by client_id");
// Each tenant's config, whole and with the key taken out (jsonb text, so key order is Postgres's).
const configs = async (db) => Object.fromEntries((await rows(db,
  `select client_id, public.get_config(client_id)::text as cfg, (public.get_config(client_id) - 'quoteCornerViews')::text as rest,
          public.get_config(client_id) -> 'quoteCornerViews' as key
     from public.client_configs order by client_id`)).map((r) => [r.client_id, r]));
// Re-create get_config from its current body with `fn` applied, for the mutants.
async function rewriteGetConfig(db, fn) {
  const s = await body(db);
  const t = fn(s);
  if (t === s) throw new Error("mutant did not change get_config");
  await db.exec(t);
}
async function refused(db, sql, re) {
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  const col = await column(db);
  return { err, matched: !!err && re.test(err), defaultTrue: !!col && col.column_default === "true", fallbackOn: (await body(db)).includes(NEW) };
}

(async () => {
  // ── 1. The apply on the live shape ──────────────────────────────────────────────────────────
  console.log("migration 322: on by default, on for everyone, and only the key moves in get_config");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const settingsBefore = await settings(db);
    ok(fnBefore.includes(OLD) && before["acme-sheds"].key === true && before["bravo-barns"].key === null && before["echo-barns"].key === null,
      "(the base is the live shape: 276 spliced, acme-sheds on, everyone else off, echo-barns has no row)");
    let notices = [];
    try { notices = await apply(db); ok(true, "322 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "322 applied", e.message); }
    ok(notices.some((n) => /get_config now reads a missing settings row as on/.test(n)), "it re-spliced the fallback", notices.join(" | "));
    ok(notices.some((n) => /checks hold; default true; every row on;/.test(n)), "its own checks held", notices.join(" | "));
    const rec = notices.record || {};
    ok(JSON.stringify(rec) === JSON.stringify({
      migration: "322", column_default: "true", first_apply: true, rows_off: 0, rows_on: 4,
      turned_on: "bravo-barns, charlie-cabins, delta-sheds", tenants_checked: 5, tenants_with_key: 5,
      missing_row_reads_on: true, anon_reads_get_config: true, browser_can_read_switch: false,
    }), "THE RECORD: default true, three turned on, five tenants with the key, grants as promised", JSON.stringify(rec));

    const col = await column(db);
    ok(col && col.data_type === "boolean" && col.is_nullable === "NO" && col.column_default === "true", "the column is boolean NOT NULL DEFAULT true", JSON.stringify(col));
    const settingsAfter = await settings(db);
    ok(settingsAfter.every((r) => r.quote_corner_views === true), "on for every row");
    ok(JSON.stringify(settingsAfter.map(({ quote_corner_views: _q, ...r }) => r)) === JSON.stringify(settingsBefore.map(({ quote_corner_views: _q, ...r }) => r)),
      "no other client_settings value moved, updated_at included");
    const comment = await one(db, `select col_description('public.client_settings'::regclass,
      (select attnum from pg_attribute where attrelid = 'public.client_settings'::regclass and attname = 'quote_corner_views')) as c`);
    ok(/On by default since migration 322/.test(comment.c || "") && /unticking it turns it off/.test(comment.c || ""), "the column says it is on by default", comment.c);

    const after = await configs(db);
    ok(Object.values(after).every((c) => c.key === true), "every tenant's get_config carries quoteCornerViews: true", JSON.stringify(after));
    ok(after["echo-barns"].key === true, "the tenant with NO settings row included");
    ok(Object.keys(before).every((k) => after[k].rest === before[k].rest), "and nothing else in any tenant's config moved");
    ok(after["acme-sheds"].cfg === before["acme-sheds"].cfg, "acme-sheds, already on, is byte-for-byte what it was");

    const fnAfter = await body(db);
    ok(fnAfter === fnBefore.replace(OLD, NEW) && fnAfter.length === fnBefore.length - 1, "get_config changed by exactly one word: the fallback false → true");
    const attrs = await one(db, `select p.prosecdef, p.provolatile, p.proconfig::text as cfg, has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p where p.oid = 'public.get_config(text)'::regprocedure`);
    ok(attrs.prosecdef && attrs.provolatile === "s" && attrs.cfg === '{"search_path=\\"\\""}' && attrs.anon,
      "get_config is still STABLE SECURITY DEFINER, search_path '', and anon may call it", JSON.stringify(attrs));
    ok((await one(db, "select public.get_config('nobody-here') is null as n")).n, "an unknown tenant still reads NULL");

    // ── A new builder (create_client: a config row, no settings row) ──
    await db.exec("insert into public.client_configs (client_id, company_name, options) values ('foxtrot-sheds', 'Foxtrot Sheds', '[]')");
    ok((await configs(db))["foxtrot-sheds"].key === true, "a new builder with no settings row reads on");
    // portal-settings' save, as service_role and as the handler makes it for an ordinary Business
    // Details save: an upsert of named columns that does NOT name the switch (the card sends it
    // only when it differs from status).
    await db.exec("begin");
    await db.exec("set local role service_role");
    let upErr = null;
    try {
      await db.query(`insert into public.client_settings (client_id, show_pricing, updated_at) values ('foxtrot-sheds', true, now())
                      on conflict (client_id) do update set show_pricing = excluded.show_pricing, updated_at = excluded.updated_at`);
    } catch (e) { upErr = e.message; }
    await db.exec("reset role");
    await db.exec("commit");
    ok(!upErr, "service_role's upsert makes the row", upErr);
    const fox = await one(db, "select quote_corner_views from public.client_settings where client_id = 'foxtrot-sheds'");
    ok(fox && fox.quote_corner_views === true, "and the row it makes reads on (the default), so the page stays", JSON.stringify(fox));
    await db.exec("delete from public.client_settings where client_id = 'foxtrot-sheds'; delete from public.client_configs where client_id = 'foxtrot-sheds'");

    // ── A builder unticks it ──
    const allOn = await configs(db);
    await db.exec("update public.client_settings set quote_corner_views = false where client_id = 'bravo-barns'");
    const off = await configs(db);
    ok(off["bravo-barns"].key === null && off["bravo-barns"].rest === allOn["bravo-barns"].rest, "unticked: bravo-barns loses the key and nothing else");
    ok(Object.keys(off).filter((k) => k !== "bravo-barns").every((k) => off[k].cfg === allOn[k].cfg), "every other tenant is unchanged");

    // ── Re-apply: nothing to splice, and the untick is kept ──
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply with an untick in it runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(re.some((n) => /already reads a missing settings row as on — nothing to splice/.test(n)), "and says there was nothing to splice", re.join(" | "));
    ok(re.some((n) => /re-apply, builders' choices kept/.test(n)), "and that it kept builders' choices", re.join(" | "));
    ok((await body(db)) === fnAfter, "get_config is unchanged by the re-apply");
    const reCfg = await configs(db);
    ok(JSON.stringify(reCfg) === JSON.stringify(off), "every tenant reads what it read before; bravo-barns stays off");
    ok(re.record && re.record.first_apply === false && re.record.rows_off === 1 && re.record.turned_on === "(none)" && re.record.tenants_with_key === 4,
      "the re-apply's record says so", JSON.stringify(re.record));
    await db.close();
  }

  // ── 2. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 322: a Windows (CRLF) checkout of the file does the same");
  {
    const lf = await fresh();
    await apply(lf, MIG_TEXT().replace(/\r\n/g, "\n"));
    const crlf = await fresh();
    let err = null;
    try { await apply(crlf, MIG_TEXT().replace(/\r?\n/g, "\r\n")); } catch (e) { err = e.message; }
    ok(!err, "the CRLF copy applies", err);
    ok((await body(lf)) === (await body(crlf)) && (await body(crlf)).includes(NEW), "both produce the same get_config");
    ok(JSON.stringify(await settings(lf)) === JSON.stringify(await settings(crlf)), "and the same rows");
    await lf.close(); await crlf.close();
  }

  // ── 3. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 322: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await configs(db);
    const fnBefore = await body(db);
    const settingsBefore = await settings(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(notices.record && notices.record.rows_on === 4 && notices.record.turned_on === "bravo-barns, charlie-cabins, delta-sheds" && notices.record.tenants_with_key === 5,
      "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await column(db)).column_default === "false" && (await body(db)) === fnBefore, "and leaves the default false and get_config as it was");
    ok(JSON.stringify(await settings(db)) === JSON.stringify(settingsBefore) && JSON.stringify(await configs(db)) === JSON.stringify(before),
      "and no row and no tenant's get_config moved");
    await db.close();
  }

  // ── 4. Mutants: broken shapes are refused, and nothing is left behind ───────────────────────
  console.log("migration 322: refuses what it cannot change or check");
  {
    // 276 never applied: no column to default.
    let db = await fresh({ with276: false });
    let r = await refused(db, MIG_TEXT(), /quote_corner_views is missing — apply 276 first/);
    ok(r.matched && !r.fallbackOn, "no 276: refused", JSON.stringify(r));
    await db.close();

    // The fallback twice: the same text in a literal earlier in the body.
    db = await fresh();
    await rewriteGetConfig(db, (s) => s.replace("    'options',", `    'note', $x$${OLD}$x$,\n    'options',`));
    let rowsBefore = JSON.stringify(await settings(db));
    r = await refused(db, MIG_TEXT(), /fallback found 2 time\(s\)/);
    ok(r.matched && !r.defaultTrue && !r.fallbackOn && JSON.stringify(await settings(db)) === rowsBefore,
      "the fallback twice: refused, default still false, no row moved", JSON.stringify(r));
    await db.close();

    // The fallback gone: someone changed 276's expression since.
    db = await fresh();
    await rewriteGetConfig(db, (s) => s.replace(OLD, OLD.replace("), false) then", "), null) then")));
    rowsBefore = JSON.stringify(await settings(db));
    r = await refused(db, MIG_TEXT(), /fallback found 0 time\(s\)/);
    ok(r.matched && !r.defaultTrue && JSON.stringify(await settings(db)) === rowsBefore, "the fallback missing: refused, nothing moved", JSON.stringify(r));
    await db.close();

    // An update that moves another column: get_config's showPricing would change for two tenants.
    db = await fresh();
    const greedy = MIG_TEXT().replace("   set quote_corner_views = true\n", "   set quote_corner_views = true, show_pricing = true\n")
      .replace("   set quote_corner_views = true\r\n", "   set quote_corner_views = true, show_pricing = true\r\n");
    ok(greedy !== MIG_TEXT(), "(mutant built: the update also sets show_pricing)");
    r = await refused(db, greedy, /get_config is wrong for: bravo-barns, delta-sheds$/);
    ok(r.matched && !r.defaultTrue && !r.fallbackOn, "an update that moves anything else: refused, naming who would have moved", JSON.stringify(r));
    await db.close();

    // An update that does nothing: the switch would stay off for everyone who had it off.
    db = await fresh();
    const lazy = MIG_TEXT().replace("   and current_setting('ss.m322_first_apply', true) = 'true';", "   and false;");
    ok(lazy !== MIG_TEXT(), "(mutant built: the update matches no row)");
    r = await refused(db, lazy, /still off after the update for: bravo-barns, charlie-cabins, delta-sheds$/);
    ok(r.matched && !r.defaultTrue, "an update that turns nobody on: refused", JSON.stringify(r));
    await db.close();

    // The fallback left alone: a tenant with no row would still read off.
    db = await fresh();
    const noSplice = MIG_TEXT().replace("  execute v_out;\n", "  null;\n").replace("  execute v_out;\r\n", "  null;\r\n");
    ok(noSplice !== MIG_TEXT(), "(mutant built: the splice never executes)");
    r = await refused(db, noSplice, /get_config does not read a missing settings row as on/);
    ok(r.matched && !r.defaultTrue, "get_config not re-spliced: refused", JSON.stringify(r));
    await db.close();

    // The table open to the browser.
    db = await fresh();
    await db.exec("grant select on public.client_settings to authenticated");
    r = await refused(db, MIG_TEXT(), /authenticated holds SELECT on client_settings\.quote_corner_views/);
    ok(r.matched && !r.defaultTrue && !r.fallbackOn, "client_settings readable by authenticated: refused, nothing of 322 left", JSON.stringify(r));
    await db.close();

    // service_role unable to write it: portal-settings' save would fail on every builder.
    db = await fresh();
    await db.exec("revoke update on public.client_settings from service_role");
    r = await refused(db, MIG_TEXT(), /service_role lacks UPDATE on client_settings\.quote_corner_views/);
    ok(r.matched && !r.defaultTrue, "service_role without UPDATE: refused", JSON.stringify(r));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
