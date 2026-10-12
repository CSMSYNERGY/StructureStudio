// Execute migration 303 for real in PGlite (Postgres compiled to WASM, in memory), on top of the REAL
// 301 and 302 applied to stand-in tables shaped like the live ones they read (crm_contacts,
// designs, orders, payments, build_jobs, client_configs, ...), then check what Carolyn asked for on
// the 2026-10-12 call:
//   * "I want quotes gone": every account's Quotes is archived (stages too) and stops taking designs;
//     a card still in it moves to Shed Deals' first open stage with a system history row; nothing
//     seeds a Quotes again, for an old account or a brand-new one.
//   * Shed Deals is where new designs land (New Incoming), and it is first on the board.
//   * "the statuses are system-driven, 100%": a move never changes a status, a status never moves a
//     card, no live stage can carry a status link (CHECK), and the automatic events (a design's
//     status, paid in full, a build job) still set it, forward only.
//   * the file refuses without 302, refuses (changing nothing) when a Quotes card has nowhere to go,
//     re-applies cleanly, and its REVERSE block (with 302's PART 3-5) really puts Quotes back.
// Nothing here touches the live project. Account ids and people are made up (the repo is public).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration303.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const M301 = () => read("301_crm_pipelines.sql");
const M302 = () => read("302_crm_pipeline_designs.sql");
const M303 = () => read("303_crm_retire_quotes.sql");

// 302's PART 3 up to PART 6: the functions the REVERSE block says to run again.
function m302Functions() {
  const s = M302();
  const a = s.indexOf("-- ── PART 3 — starters");
  const b = s.indexOf("-- ── PART 6", a);
  if (a < 0 || b < 0) throw new Error("302's PART 3 / PART 6 anchors moved: re-point the test (and 303's REVERSE note)");
  return s.slice(a, b);
}
// 303's header REVERSE-SQL block, uncommented.
function m303Reverse() {
  const lines = M303().split("\n");
  const a = lines.findIndex((l) => l.trim() === "-- REVERSE-SQL-BEGIN");
  const b = lines.findIndex((l) => l.trim() === "-- REVERSE-SQL-END");
  if (a < 0 || b < a) throw new Error("303's REVERSE-SQL markers moved");
  return lines.slice(a + 1, b).map((l) => l.replace(/^-- ?/, "")).join("\n");
}

const ACME = "acme-sheds";      // a builder with designs
const BRAVO = "bravo-barns";    // a builder with none
const OURS = "harness-ops";     // plays our own account (internal_account: Manufacturer Outreach)

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
create table public.client_configs (client_id text primary key);
create table public.client_settings (client_id text primary key, internal_account boolean not null default false);
create table public.client_users (user_id uuid not null, client_id text not null, primary key (user_id, client_id));
create table public.app_errors (
  id bigserial primary key, client_id text, source text, severity text, code text, message text, context jsonb,
  created_at timestamptz not null default now()
);
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, name text, phone text, phone_digits text,
  email text, email_lower text generated always as (lower(email)) stored, owner_user_id uuid,
  source text not null default 'manual', merged_into uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint crm_contacts_source_check check (source in ('design', 'captured_lead', 'manual', 'import', 'phone', 'ghl_import'))
);
create unique index crm_contacts_phone_once on public.crm_contacts (client_id, phone_digits) where merged_into is null and phone_digits is not null;
create table public.crm_field_changes (
  id bigserial primary key, client_id text, contact_id uuid references public.crm_contacts (id) on delete cascade,
  field text, old_value text, new_value text, changed_by uuid, changed_at timestamptz not null default now()
);
create function public.crm_phone_key(p_phone text) returns text language sql immutable as $f$
  select case when length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 10
              then right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10) end
$f$;
create table public.designs (
  short_code text primary key, client_id text not null, status text not null default 'draft', contact_id uuid,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.orders (id uuid primary key default gen_random_uuid(), client_id text, short_code text, total_cents bigint);
create table public.payments (id uuid primary key default gen_random_uuid(), client_id text, order_id uuid, amount_cents bigint, voided_at timestamptz);
create table public.build_jobs (id uuid primary key default gen_random_uuid(), client_id text, design_short_code text);
insert into public.client_configs values ('${ACME}'), ('${BRAVO}'), ('${OURS}');
insert into public.client_settings values ('${ACME}', false), ('${BRAVO}', false), ('${OURS}', true);
insert into public.designs (short_code, client_id, status) values
  ('SS-AAAA0001', '${ACME}', 'sent'), ('SS-AAAA0002', '${ACME}', 'draft'), ('SS-AAAA0003', '${ACME}', 'inventory');
`;

async function apply(db, sql) {
  const out = await db.exec(sql);
  const rec = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return rec ? rec.rows[0] : null;
}
let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const all = async (db, sql, params) => (await db.query(sql, params)).rows;
const n = async (db, sql, params) => Number((await one(db, sql, params)).n);

/** The 301 + 302 world, as live was on 2026-10-13, plus the cases 303 has to handle. */
async function makeDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  await apply(db, M301());
  await apply(db, M302());
  return db;
}
const pipe = (db, client, kind) => one(db, "select * from public.crm_pipelines where client_id = $1 and seed_kind = $2", [client, kind]);
const stage = (db, pipelineId, name) => one(db, "select * from public.crm_pipeline_stages where pipeline_id = $1 and name = $2 and archived_at is null", [pipelineId, name]);
const status = (db, client, name) => one(db, "select * from public.crm_statuses where client_id = $1 and name = $2", [client, name]);
const card = (db, code) => one(db, "select * from public.crm_deals where short_code = $1", [code]);
const statusName = async (db, id) => (await one(db, "select name from public.crm_statuses where id = $1", [id])).name;
const stageName = async (db, id) => (await one(db, "select name from public.crm_pipeline_stages where id = $1", [id])).name;

(async () => {
  console.log("before 303 (302's world)");
  const db = await makeDb();
  const q0 = await pipe(db, ACME, "quotes");
  ok(q0 && q0.feeds_designs && q0.mirrors_statuses, "302: Quotes takes the designs and mirrors the statuses");
  // A design saved after 302 landed in Quotes; a hand-added lead sat in Quotes and was removed.
  await db.query("insert into public.designs (short_code, client_id, status) values ('SS-AAAA0004', $1, 'draft')", [ACME]);
  const inQuotes = await card(db, "SS-AAAA0004");
  ok(inQuotes.pipeline_id === q0.id, "302: a new design's card lands in Quotes");
  const quotesNewLead = await stage(db, q0.id, "New Lead");
  const lead = await one(db, "select public.crm_create_lead($1, 'Pat Example', null, '(555) 010-4001', null, null, null, 'manual', $2) r", [ACME, quotesNewLead.id]);
  const removedId = lead.r.dealId;
  await db.query("update public.crm_deals set archived_at = now() where id = $1", [removedId]);
  // A builder linked a Shed Deals stage to a status (302's "status link").
  const shed0 = await pipe(db, ACME, "shed_deals");
  const hot0 = await stage(db, shed0.id, "Nurturing - Hot");
  await db.query("update public.crm_pipeline_stages set status_id = $1 where id = $2", [(await status(db, ACME, "Accepted")).id, hot0.id]);
  const statusBefore = inQuotes.status_id;

  console.log("303 refuses without 302");
  {
    const early = new PGlite();
    await early.exec(STUBS);
    await apply(early, M301());
    try { await apply(early, M303()); ok(false, "303 without 302 is refused", "it committed"); }
    catch (e) { ok(/migration 302 not applied/.test(e.message), "303 without 302 is refused", e.message); }
  }

  console.log("303 applied");
  let rec;
  try { rec = await apply(db, M303()); ok(true, "303 applied cleanly on 302's world"); }
  catch (e) { ok(false, "303 applied", e.message); process.exit(1); }
  ok(rec && Number(rec.quotes_retired) === 3 && Number(rec.shed_deals_feeds) === 3 && Number(rec.accounts) === 3,
    "RECORD: 3 Quotes retired, 3 Shed Deals take the designs, 3 accounts", JSON.stringify(rec));
  ok(rec && Number(rec.designs_without_card) === 0 && Number(rec.design_cards) === Number(rec.design_cards_in_shed_deals),
    "RECORD: every design has a card, all in Shed Deals (C15)", JSON.stringify(rec));

  for (const t of [ACME, BRAVO, OURS]) {
    const q = await pipe(db, t, "quotes");
    const s = await pipe(db, t, "shed_deals");
    ok(q.archived_at !== null && !q.feeds_designs && !q.mirrors_statuses, `${t}: Quotes archived, takes nothing, mirrors nothing`);
    ok(await n(db, "select count(*) n from public.crm_pipeline_stages where pipeline_id = $1 and archived_at is distinct from $2", [q.id, q.archived_at]) === 0,
      `${t}: every Quotes stage archived with it (same instant, which is how the reverse finds them)`);
    ok(s.archived_at === null && s.feeds_designs, `${t}: Shed Deals takes the new designs`);
    ok(await n(db, "select count(*) n from public.crm_pipelines where client_id = $1 and archived_at is null and position < $2", [t, s.position]) === 0,
      `${t}: Shed Deals is first on the board`);
  }
  ok(await n(db, "select count(*) n from public.crm_pipelines where archived_at is null and seed_kind = 'quotes'") === 0, "no live Quotes anywhere");
  const outreach = await pipe(db, OURS, "outreach");
  ok(outreach && outreach.archived_at === null && !outreach.feeds_designs, "our own Manufacturer Outreach is untouched");

  const shed = await pipe(db, ACME, "shed_deals");
  const newIncoming = await stage(db, shed.id, "New Incoming");
  const moved = await card(db, "SS-AAAA0004");
  ok(moved.pipeline_id === shed.id && moved.stage_id === newIncoming.id, "the design card that was in Quotes is in Shed Deals → New Incoming");
  ok(moved.status_id === statusBefore, "  with its status untouched");
  const hist = await one(db, "select * from public.crm_deal_stage_changes where deal_id = $1 order by id desc limit 1", [moved.id]);
  ok(hist.to_stage === newIncoming.id && hist.from_stage === inQuotes.stage_id && hist.changed_by === null, "  and a system history row from its Quotes stage");
  const removed = await one(db, "select * from public.crm_deals where id = $1", [removedId]);
  ok(removed.pipeline_id === shed.id && removed.archived_at !== null, "a removed card in Quotes moved too (a restore lands somewhere live), still removed");
  ok(await n(db, "select count(*) n from public.crm_deals where short_code in ('SS-AAAA0001', 'SS-AAAA0002') and stage_id = $1", [(await stage(db, shed.id, "Nurturing - Cool")).id]) === 2,
    "the backfilled design cards stay where they were");

  console.log("statuses are system-driven");
  ok(await n(db, "select count(*) n from public.crm_pipeline_stages where archived_at is null and status_id is not null") === 0, "no live stage carries a status link");
  ok(await n(db, "select count(*) n from public.crm_pipeline_stages s join public.crm_pipelines q on q.id = s.pipeline_id where q.seed_kind = 'quotes' and s.status_id is not null") === 24,
    "the archived Quotes stages keep 302's links (8 x 3), for the reverse");
  try { await db.query("update public.crm_pipeline_stages set status_id = $1 where id = $2", [(await status(db, ACME, "Accepted")).id, hot0.id]); ok(false, "a live stage refuses a status link", "it took one"); }
  catch (e) { ok(/crm_pipeline_stages_no_status_link/.test(e.message), "a live stage refuses a status link (CHECK)", e.message); }
  try { await db.query("insert into public.crm_pipeline_stages (client_id, pipeline_id, name, status_id) values ($1, $2, 'Linked', $3)", [ACME, shed.id, (await status(db, ACME, "Accepted")).id]); ok(false, "a new stage refuses a status link", "it took one"); }
  catch (e) { ok(/crm_pipeline_stages_no_status_link/.test(e.message), "a new stage refuses a status link too", e.message); }

  await db.query("insert into public.designs (short_code, client_id, status) values ('SS-AAAA0005', $1, 'draft')", [ACME]);
  let c5 = await card(db, "SS-AAAA0005");
  ok(c5.pipeline_id === shed.id && c5.stage_id === newIncoming.id, "a new design lands in Shed Deals → New Incoming");
  ok(await statusName(db, c5.status_id) === "New Lead", "  as New Lead");
  await db.query("update public.designs set status = 'sent' where short_code = 'SS-AAAA0005'");
  c5 = await card(db, "SS-AAAA0005");
  ok(await statusName(db, c5.status_id) === "Estimate Sent" && c5.stage_id === newIncoming.id, "the estimate going out sets Estimate Sent; the card stays in its stage");
  const r = await one(db, "select public.crm_move_deal($1, $2, $3, null, null) r", [ACME, c5.id, hot0.id]);
  c5 = await card(db, "SS-AAAA0005");
  ok(c5.stage_id === hot0.id && await statusName(db, c5.status_id) === "Estimate Sent", "dragging to the stage that WAS linked to Accepted leaves the status alone");
  ok(r.r.moved === true && r.r.status_id === c5.status_id, "  and crm_move_deal still answers status_id (unchanged) for a portal that reads it");
  const ord = await one(db, "insert into public.orders (client_id, short_code, total_cents) values ($1, 'SS-AAAA0005', 100000) returning id", [ACME]);
  await db.query("insert into public.payments (client_id, order_id, amount_cents) values ($1, $2, 100000)", [ACME, ord.id]);
  c5 = await card(db, "SS-AAAA0005");
  ok(await statusName(db, c5.status_id) === "Payment Received" && c5.stage_id === hot0.id, "paid in full sets Payment Received; the card stays in its stage");
  await db.query("insert into public.build_jobs (client_id, design_short_code) values ($1, 'SS-AAAA0005')", [ACME]);
  c5 = await card(db, "SS-AAAA0005");
  ok(await statusName(db, c5.status_id) === "Scheduling", "a build job sets Scheduling");
  await db.query("update public.designs set status = 'accepted' where short_code = 'SS-AAAA0005'");
  c5 = await card(db, "SS-AAAA0005");
  ok(await statusName(db, c5.status_id) === "Scheduling", "an earlier event never drags it back (forward only)");
  const set = await one(db, "select public.crm_set_deal_status($1, $2, $3, null, false) r", [ACME, c5.id, (await status(db, ACME, "Delivered")).id]);
  c5 = await card(db, "SS-AAAA0005");
  ok(set.r.moved === false && c5.stage_id === hot0.id && await statusName(db, c5.status_id) === "Delivered", "crm_set_deal_status changes the status only, never the stage");

  console.log("new accounts never get Quotes");
  await db.query("insert into public.client_configs values ('delta-sheds')");
  await db.query("insert into public.designs (short_code, client_id, status) values ('SS-DDDD0001', 'delta-sheds', 'draft')");
  const dShed = await pipe(db, "delta-sheds", "shed_deals");
  ok(dShed && dShed.feeds_designs && await n(db, "select count(*) n from public.crm_pipelines where client_id = 'delta-sheds'") === 1,
    "a new account's first design seeds Shed Deals only, taking the designs");
  ok(await n(db, "select count(*) n from public.crm_statuses where client_id = 'delta-sheds'") === 8, "  and the 8 statuses");
  const d1 = await card(db, "SS-DDDD0001");
  ok(d1.pipeline_id === dShed.id && await stageName(db, d1.stage_id) === "New Incoming", "  and its card sits in New Incoming");
  for (const kind of ["quotes", "sales", "shed_deals"]) {
    const got = await one(db, "select public.crm_seed_pipeline('delta-sheds', $1) id", [kind]);
    ok(got.id === dShed.id, `crm_seed_pipeline('${kind}') answers Shed Deals`);
  }
  ok(await n(db, "select count(*) n from public.crm_pipelines where client_id = 'delta-sheds'") === 1, "  and made nothing");
  await db.query("select public.crm_ensure_pipelines('echo-barns')");
  const eShed = await pipe(db, "echo-barns", "shed_deals");
  ok(eShed && eShed.feeds_designs && await n(db, "select count(*) n from public.crm_pipelines where client_id = 'echo-barns'") === 1,
    "crm_ensure_pipelines (the board's first open) seeds Shed Deals only, as the feed");
  ok(await n(db, "select count(*) n from public.crm_pipelines where client_id like 'm303-rehearsal-%'") === 0
    && await n(db, "select count(*) n from public.crm_contacts where client_id like 'm303-rehearsal-%'") === 0
    && await n(db, "select count(*) n from public.crm_statuses where client_id like 'm303-rehearsal-%'") === 0,
    "the rehearsal left nothing behind");

  console.log("re-apply");
  const before = await all(db, "select id, pipeline_id, stage_id, status_id, archived_at from public.crm_deals order by id");
  const pipesBefore = await all(db, "select id, position, feeds_designs, archived_at from public.crm_pipelines order by id");
  try { await apply(db, M303()); ok(true, "303 re-applies cleanly"); } catch (e) { ok(false, "303 re-applies", e.message); }
  ok(JSON.stringify(await all(db, "select id, pipeline_id, stage_id, status_id, archived_at from public.crm_deals order by id")) === JSON.stringify(before), "  and moves no card");
  ok(JSON.stringify(await all(db, "select id, position, feeds_designs, archived_at from public.crm_pipelines order by id")) === JSON.stringify(pipesBefore), "  and changes no pipeline");

  console.log("a Quotes card with nowhere to go refuses the whole file");
  {
    const bad = await makeDb();
    const bq = await pipe(bad, BRAVO, "quotes");
    const bs = await pipe(bad, BRAVO, "shed_deals");
    await bad.query("update public.crm_pipelines set archived_at = now() where id = $1", [bs.id]);
    await bad.query("select public.crm_create_lead($1, 'Sam Example', null, '(555) 010-4002', null, null, null, 'manual', $2)", [BRAVO, (await stage(bad, bq.id, "New Lead")).id]);
    try { await apply(bad, M303()); ok(false, "303 refuses", "it committed"); }
    catch (e) {
      ok(/^303: /.test(e.message), "303 refuses when a Quotes card has no live Shed Deals", e.message);
      await bad.exec("rollback");
      const after = await pipe(bad, ACME, "quotes");
      ok(after.archived_at === null && after.feeds_designs, "  and nothing changed, in any account");
    }
  }

  console.log("the REVERSE block puts 302 back");
  {
    const rev = await makeDb();
    await apply(rev, M303());
    await rev.query("insert into supabase_migrations.schema_migrations values ('303', '303_crm_retire_quotes')");
    await rev.exec("begin;\n" + m302Functions() + "\n" + m303Reverse() + "\ncommit;");
    for (const t of [ACME, BRAVO, OURS]) {
      const q = await pipe(rev, t, "quotes");
      const s = await pipe(rev, t, "shed_deals");
      ok(q.archived_at === null && q.feeds_designs && q.mirrors_statuses && !s.feeds_designs, `${t}: Quotes is back as the feed and the mirror`);
      ok(await n(rev, "select count(*) n from public.crm_pipeline_stages where pipeline_id = $1 and archived_at is null and status_id is not null", [q.id]) === 8,
        `${t}:   its 8 stages back, still linked`);
      ok(s.position > q.position, `${t}:   Shed Deals after Quotes again`);
    }
    await rev.query("insert into public.designs (short_code, client_id, status) values ('SS-AAAA0009', $1, 'draft')", [ACME]);
    ok((await card(rev, "SS-AAAA0009")).pipeline_id === (await pipe(rev, ACME, "quotes")).id, "  a new design lands in Quotes again");
    ok(await n(rev, "select count(*) n from supabase_migrations.schema_migrations where version = '303'") === 0, "  and the ledger row is gone");
    try { await apply(rev, M303()); ok(true, "303 applies again after the reverse (a round trip)"); } catch (e) { ok(false, "303 after the reverse", e.message); }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
