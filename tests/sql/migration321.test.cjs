// Execute migration 321 (tenant_purge, the deleted_clients tombstone, the tenant-exports bucket) for
// real in PGlite (Postgres compiled to WASM, in memory) on a cut-down schema that carries the foreign
// key shapes the live purge meets (read live 2026-10-21):
//   * NO ACTION references from tables that sort AFTER their parent (crm_notes and phone_calls ->
//     crm_contacts), which only a second pass can clear;
//   * a RESTRICT reference that also sorts after its parent (stage_moves -> job_stages);
//   * a composite SET NULL (sales_location_id) that must not empty client_id (designs -> builder_locations);
//   * a CASCADE into a table with no client_id (email_send_events -> email_sends), and a cascade inside
//     the kept set (payments -> orders);
//   * a purged table pointing at a KEPT one (wallet_accounts -> billing_consents), which is fine.
// Then check what the file promises:
//   * the apply's RECORD, and the grants: no browser role can execute the function or touch the
//     tombstone, service_role can;
//   * a dry run counts what would go and what is kept, and deletes nothing;
//   * a purge removes every non-kept row of that builder and nothing of anyone else's, keeps the
//     kept rows, follows the cascades, takes more than one pass, and writes the tombstone;
//   * a purge that a KEPT row blocks raises, and NOTHING of that builder is deleted (one transaction);
//   * the refusals: CSM Synergy's own accounts, an empty keep list, a kept name that is not a tenant
//     table, an id that is not a builder id; the tombstone is never purged;
//   * a re-apply changes nothing; without the savepoint retry the same purge fails (mutant).
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration321.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/321_tenant_purge.sql"), "utf8").replace(/\r/g, "");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);

create table public.client_configs (client_id text primary key);
create table public.client_users (client_id text not null, user_id uuid not null);
-- kept
create table public.orders (id serial primary key, client_id text not null);
create table public.payment_attempts (id serial primary key, client_id text not null);
create table public.payments (id serial primary key, client_id text not null,
  order_id int not null references public.orders (id) on delete cascade,
  attempt_id int references public.payment_attempts (id));
create table public.billing_consents (id serial primary key, client_id text not null);
create table public.sms_consent_log (id serial primary key, client_id text not null);
create table public.invoice_sends (id serial primary key, client_id text not null, contact_id int);
-- purged
create table public.wallet_accounts (client_id text primary key, auto_topup_consent_id int references public.billing_consents (id));
create table public.crm_contacts (id serial primary key, client_id text not null, merged_into int references public.crm_contacts (id));
create table public.crm_notes (id serial primary key, client_id text not null, contact_id int references public.crm_contacts (id));
create table public.sms_numbers (id serial primary key, client_id text not null);
create table public.phone_calls (id serial primary key, client_id text not null,
  contact_id int references public.crm_contacts (id), number_id int references public.sms_numbers (id));
create table public.phone_voicemails (id serial primary key, client_id text not null,
  call_id int not null references public.phone_calls (id) on delete cascade);
create table public.builder_locations (id serial primary key, client_id text not null, unique (client_id, id));
create table public.designs (id serial primary key, client_id text not null, sales_location_id int,
  foreign key (client_id, sales_location_id) references public.builder_locations (client_id, id) on delete set null (sales_location_id));
create table public.job_stages (id serial primary key, client_id text not null);
create table public.stage_moves (id serial primary key, client_id text not null,
  stage_id int not null references public.job_stages (id) on delete restrict);
create table public.email_sends (id serial primary key, client_id text not null);
create table public.email_send_events (id serial primary key, email_send_id int not null references public.email_sends (id) on delete cascade);
create table public.avalara_tax_codes (code text primary key);
create table public.tax_code_assignments (id serial primary key, client_id text not null,
  tax_code text not null references public.avalara_tax_codes (code));
create table public.admin_audit (id serial primary key, target_client_id text, note text);
-- the live auto-RLS event trigger is not reproduced; 321 turns RLS on for its table itself
`;

const KEEP = ["orders", "payments", "payment_attempts", "billing_consents", "sms_consent_log", "invoice_sends"];
const PURGED = ["client_configs", "client_users", "wallet_accounts", "crm_contacts", "crm_notes", "sms_numbers", "phone_calls",
  "phone_voicemails", "builder_locations", "designs", "job_stages", "stage_moves", "email_sends", "tax_code_assignments"];

// One builder's worth of rows. Ids come from serials, so every reference is looked up by client.
const seed = (c) => `
insert into public.client_configs values ('${c}');
insert into public.client_users values ('${c}', gen_random_uuid());
insert into public.orders (client_id) values ('${c}'), ('${c}');
insert into public.payment_attempts (client_id) values ('${c}');
insert into public.payments (client_id, order_id, attempt_id)
  select '${c}', (select min(id) from public.orders where client_id = '${c}'), (select min(id) from public.payment_attempts where client_id = '${c}');
insert into public.billing_consents (client_id) values ('${c}');
insert into public.sms_consent_log (client_id) values ('${c}');
insert into public.wallet_accounts values ('${c}', (select min(id) from public.billing_consents where client_id = '${c}'));
insert into public.crm_contacts (client_id) values ('${c}'), ('${c}');
update public.crm_contacts set merged_into = (select min(id) from public.crm_contacts where client_id = '${c}')
  where client_id = '${c}' and id = (select max(id) from public.crm_contacts where client_id = '${c}');
insert into public.crm_notes (client_id, contact_id) select '${c}', min(id) from public.crm_contacts where client_id = '${c}';
insert into public.sms_numbers (client_id) values ('${c}');
insert into public.phone_calls (client_id, contact_id, number_id)
  select '${c}', (select min(id) from public.crm_contacts where client_id = '${c}'), (select min(id) from public.sms_numbers where client_id = '${c}');
insert into public.phone_voicemails (client_id, call_id) select '${c}', min(id) from public.phone_calls where client_id = '${c}';
insert into public.builder_locations (client_id) values ('${c}');
insert into public.designs (client_id, sales_location_id) select '${c}', min(id) from public.builder_locations where client_id = '${c}';
insert into public.job_stages (client_id) values ('${c}');
insert into public.stage_moves (client_id, stage_id) select '${c}', min(id) from public.job_stages where client_id = '${c}';
insert into public.email_sends (client_id) values ('${c}');
insert into public.email_send_events (email_send_id) select min(id) from public.email_sends where client_id = '${c}';
insert into public.tax_code_assignments (client_id, tax_code) values ('${c}', 'P0000000');
`;
const SEED = `insert into public.avalara_tax_codes values ('P0000000');
${seed("acme-sheds")}${seed("bravo-barns")}${seed("structure-studio")}${seed("cedar-co")}
insert into public.invoice_sends (client_id, contact_id) select 'cedar-co', min(id) from public.crm_contacts where client_id = 'cedar-co';
alter table public.invoice_sends add foreign key (contact_id) references public.crm_contacts (id);`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const opened = [];
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(SEED);
  return db;
}
async function apply(db, sql = MIG()) {
  try {
    const out = await db.exec(sql);
    const record = [...out].reverse().map((r) => r.rows && r.rows[0]).find((r) => r && "tombstone_ready" in r);
    return { err: null, record };
  } catch (e) { await db.exec("rollback").catch(() => {}); return { err: e.message }; }
}
const purge = async (db, c, keep = KEEP, dry = false) => {
  try { return { r: (await one(db, "select public.tenant_purge($1, $2, 'test', $3) r", [c, keep, dry])).r }; } catch (e) { return { err: e.message, code: e.code }; }
};
/** Rows per table for one builder (and the event rows that hang off its email sends). */
async function countsOf(db, c) {
  const out = {};
  for (const t of [...KEEP, ...PURGED]) out[t] = (await one(db, `select count(*)::int n from public.${t} where client_id = $1`, [c])).n;
  out.email_send_events = (await one(db, "select count(*)::int n from public.email_send_events e join public.email_sends s on s.id = e.email_send_id where s.client_id = $1", [c])).n;
  return out;
}
const total = (o) => Object.values(o).reduce((s, n) => s + n, 0);

(async () => {
  console.log("migration 321: apply, the record and the grants");
  const db = await fresh();
  const { err, record } = await apply(db);
  ok(!err, "applies cleanly", err);
  ok(record && record.tombstone_ready === true && Number(record.tombstones) === 0 && record.purge_ready === true && record.export_bucket_private === true,
    "THE RECORD: tombstone ready, 0 tombstones, purge ready, private export bucket", JSON.stringify(record));
  ok(record && Number(record.tenant_tables) === 21, "THE RECORD counts the tenant tables (21 here)", JSON.stringify(record));
  for (const role of ["anon", "authenticated"]) {
    ok((await one(db, "select has_function_privilege($1, 'public.tenant_purge(text, text[], text, boolean)', 'execute') x", [role])).x === false, `${role} cannot execute tenant_purge`);
    ok((await one(db, "select has_table_privilege($1, 'public.deleted_clients', 'select') x", [role])).x === false, `${role} cannot read the tombstones`);
  }
  ok((await one(db, "select has_function_privilege('service_role', 'public.tenant_purge(text, text[], text, boolean)', 'execute') x")).x === true, "service_role can execute it");
  {
    let denied = null;
    try { await db.exec("set role anon; select public.tenant_purge('acme-sheds', array['orders'], 'x', false);"); } catch (e) { denied = e.message; }
    await db.exec("reset role");
    ok(denied && /permission denied/.test(denied), "called as anon, it is refused before it runs", denied);
  }
  ok((await one(db, "select public from storage.buckets where id = 'tenant-exports'")).public === false, "the export bucket is private");

  console.log("migration 321: a dry run counts and deletes nothing");
  const before = await countsOf(db, "acme-sheds");
  const dry = await purge(db, "acme-sheds", KEEP, true);
  ok(!dry.err, "dry run runs", dry.err);
  ok(dry.r && dry.r.dryRun === true && dry.r.tombstoned === false, "it says it is a dry run, not yet tombstoned", JSON.stringify(dry.r));
  ok(dry.r && dry.r.purge.crm_contacts === 2 && dry.r.purge.client_configs === 1 && !("orders" in dry.r.purge), "it counts what would go, and no kept table", JSON.stringify(dry.r && dry.r.purge));
  ok(dry.r && dry.r.kept.orders === 2 && dry.r.kept.payments === 1 && dry.r.kept.billing_consents === 1, "...and what would be kept", JSON.stringify(dry.r && dry.r.kept));
  ok(JSON.stringify(await countsOf(db, "acme-sheds")) === JSON.stringify(before), "nothing was deleted");

  console.log("migration 321: the purge");
  const bravoBefore = await countsOf(db, "bravo-barns");
  const p = await purge(db, "acme-sheds");
  ok(!p.err, "purges", p.err);
  const after = await countsOf(db, "acme-sheds");
  ok(PURGED.every((t) => after[t] === 0) && after.email_send_events === 0, "every non-kept row of that builder is gone, and the events cascaded", JSON.stringify(after));
  ok(KEEP.every((t) => after[t] === before[t]), "every kept row is still there", JSON.stringify(after));
  ok(JSON.stringify(await countsOf(db, "bravo-barns")) === JSON.stringify(bravoBefore), "nothing of another builder moved");
  ok(p.r && p.r.passes >= 2, "it took more than one pass (crm_contacts waits for its notes and calls)", JSON.stringify(p.r));
  ok(p.r && p.r.purged.crm_contacts === 2 && p.r.purged.designs === 1 && p.r.purged.stage_moves === 1, "it reports what it purged", JSON.stringify(p.r && p.r.purged));
  const tomb = await one(db, "select deleted_by, kept, purged from public.deleted_clients where client_id = 'acme-sheds'");
  ok(tomb && tomb.deleted_by === "test" && tomb.kept.orders === 2 && tomb.purged.crm_contacts === 2, "the tombstone is written with the counts", JSON.stringify(tomb));
  const again = await purge(db, "acme-sheds");
  ok(!again.err && JSON.stringify(again.r.purged) === "{}", "a second purge finds nothing", again.err || JSON.stringify(again.r));
  ok((await one(db, "select count(*)::int n from public.deleted_clients where client_id = 'acme-sheds'")).n === 1,
    "the tombstone is never purged, though the keep list does not name it");

  console.log("migration 321: a KEPT row that points at a purged one stops the whole purge");
  const cedarBefore = await countsOf(db, "cedar-co");
  const blocked = await purge(db, "cedar-co");
  ok(blocked.err && /was not purged \(nothing deleted\): still referenced from \{crm_contacts\}/.test(blocked.err) && blocked.code === "23503", "it raises and names the table", blocked.err);
  ok(JSON.stringify(await countsOf(db, "cedar-co")) === JSON.stringify(cedarBefore), "...and NOTHING of that builder was deleted");
  ok((await one(db, "select count(*)::int n from public.deleted_clients where client_id = 'cedar-co'")).n === 0, "...and there is no tombstone");

  console.log("migration 321: refusals");
  const ss = await purge(db, "structure-studio");
  ok(ss.err && ss.code === "42501" && total(await countsOf(db, "structure-studio")) === total(bravoBefore), "structure-studio is refused, nothing touched", ss.err);
  const sd = await purge(db, "support-demo", KEEP, true);
  ok(sd.err && sd.code === "42501", "support-demo is refused, even for a dry run", sd.err);
  const empty = await purge(db, "bravo-barns", []);
  ok(empty.err && empty.code === "22023", "an empty keep list is refused", empty.err);
  const typo = await purge(db, "bravo-barns", [...KEEP, "order"]);
  ok(typo.err && /kept table\(s\) \{order\} are not tenant tables/.test(typo.err), "a kept name that is not a tenant table is refused", typo.err);
  const badId = await purge(db, "Bravo Barns");
  ok(badId.err && badId.code === "22023", "an id that is not a builder id is refused", badId.err);
  ok(JSON.stringify(await countsOf(db, "bravo-barns")) === JSON.stringify(bravoBefore), "none of the refusals moved a row");

  console.log("migration 321: re-apply");
  const re = await apply(db);
  ok(!re.err && re.record && Number(re.record.tombstones) === 1, "re-applies cleanly and keeps the tombstone", re.err || JSON.stringify(re.record));
  ok(!(await purge(db, "bravo-barns", KEEP, true)).err, "...and the function still runs");

  console.log("migration 321: without the savepoint retry, the same purge fails (mutant)");
  {
    const sql = MIG().replace("exception when foreign_key_violation or restrict_violation or not_null_violation then\n        v_blocked := v_blocked || v_t;\n", "");
    ok(sql !== MIG(), "(the mutant formed: no retry)");
    const m = await fresh();
    const a = await apply(m, sql);
    ok(!a.err, "the mutant applies", a.err);
    const mp = await purge(m, "acme-sheds");
    ok(mp.err && /violates foreign key constraint/.test(mp.err), "...and its purge fails on the first reference", mp.err);
  }

  for (const d of opened) await d.close().catch(() => {});
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
