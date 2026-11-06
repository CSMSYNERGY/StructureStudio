// Execute migration 357 (the quote email check's queue) for real in PGlite (Postgres compiled to
// WASM, in memory), then check what its header promises:
//   * the file re-applies;
//   * a browser role can neither read nor write the table, and service_role can do both;
//   * RLS is on with no policies, and `from public` is revoked too;
//   * an unknown state is refused, and a new row starts pending with no looks;
//   * one email belongs to one check per tenant, the same id at another tenant is fine, and any
//     number of checks can wait with no email id yet;
//   * the due index covers pending rows only.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants and ids are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration357.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = fs.readFileSync(path.join(WT, "supabase/migrations/357_ghl_email_checks.sql"), "utf8").replace(/\r/g, "");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
-- What Supabase's default privileges do to a new table, which is what the migration has to undo.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
};
async function refuses(db, sql) {
  try {
    await db.query(sql);
    return false;
  } catch {
    return true;
  }
}
const ROW = `('acme-sheds', 'SS-1', 'est-1', 'contact-1', now(), now())`;
const COLS = `(client_id, short_code, ghl_estimate_id, ghl_contact_id, send_started_at, next_check_at)`;
const INSERT = `insert into public.ghl_email_checks ${COLS} values ${ROW}`;

(async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(MIG);
  await db.exec(MIG);
  check("the file re-applies", true);

  const rls = await db.query(`select relrowsecurity from pg_class where oid = 'public.ghl_email_checks'::regclass`);
  check("RLS is on", rls.rows[0].relrowsecurity === true);
  const policies = await db.query(`select count(*)::int as n from pg_policies where tablename = 'ghl_email_checks'`);
  check("no policies, so only the service role gets through", policies.rows[0].n === 0);

  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    check(`${role} cannot read`, await refuses(db, `select * from public.ghl_email_checks`));
    check(`${role} cannot write`, await refuses(db, INSERT));
    await db.exec(`reset role`);
  }
  const pub = await db.query(`
    select count(*)::int as n from information_schema.role_table_grants
     where table_name = 'ghl_email_checks' and grantee in ('PUBLIC', 'anon', 'authenticated')`);
  check("no grant is left to PUBLIC or a browser role", pub.rows[0].n === 0);

  await db.exec(`set role service_role`);
  await db.exec(INSERT);
  const row = await db.query(`select * from public.ghl_email_checks`);
  check("service_role can write and read", row.rows.length === 1);
  await db.query(`update public.ghl_email_checks set looks = 1 where id = $1`, [row.rows[0].id]);
  await db.exec(`reset role`);
  check("a new row starts pending with no looks", row.rows[0].state === "pending" && row.rows[0].looks === 0);
  check("test_inbox defaults off", row.rows[0].test_inbox === false);

  check("an unknown state is refused", await refuses(db, `update public.ghl_email_checks set state = 'whatever'`));
  for (const state of ["ok", "failed", "no_delivery", "not_found", "unreadable", "pending"]) {
    await db.query(`update public.ghl_email_checks set state = $1`, [state]);
  }
  check("every state the module writes is allowed", true);
  check("a client id is required", await refuses(db, `insert into public.ghl_email_checks (short_code, ghl_estimate_id, ghl_contact_id, send_started_at, next_check_at) values ('x','e','c',now(),now())`));

  await db.exec(INSERT);
  check("two checks can wait with no email id yet", true);
  await db.exec(`update public.ghl_email_checks set ghl_email_id = 'email-1' where id = (select min(id) from public.ghl_email_checks)`);
  check(
    "one email belongs to one check at a tenant",
    await refuses(db, `update public.ghl_email_checks set ghl_email_id = 'email-1' where id = (select max(id) from public.ghl_email_checks)`),
  );
  await db.exec(`insert into public.ghl_email_checks ${COLS} values ('other-sheds', 'SS-2', 'est-2', 'contact-2', now(), now())`);
  await db.exec(`update public.ghl_email_checks set ghl_email_id = 'email-1' where client_id = 'other-sheds'`);
  check("the same id at another tenant is fine", true);

  const idx = await db.query(`select indexdef from pg_indexes where indexname = 'ghl_email_checks_due_idx'`);
  check("the due index covers pending rows only", /where \(state = 'pending'/i.test(idx.rows[0]?.indexdef ?? ""), idx.rows[0]?.indexdef);

  await db.close();
  if (failures) {
    console.error(`${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("ALL CHECKS PASSED");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
