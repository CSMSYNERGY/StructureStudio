// Execute migration 255 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// sms_numbers as 165 + 254 PART 2 left it live, then check what it promises: six nullable
// columns, checks that refuse anything outside Twilio's TrustProduct vocabulary, the setup's
// single-flight claim (caller_id_lock_until, review BE-2) behaving as portal-settings sends it,
// the probe that leaves nothing behind, a re-apply that is a no-op, and assertions that really
// abort (a table the browser roles can read makes the whole migration roll back). Nothing here touches the
// live project: no network, no Supabase, no Twilio.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration255.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/255_sss_phone_followups.sql"), "utf8");

// sms_numbers exactly as live on 2026-09-29: 165's table, 254 PART 2's three columns, 165's
// revoke from the browser roles, and the project's default ACLs (which would otherwise grant
// the browser roles everything on a NEW table, the trap 254 revokes against).
const STUBS = (grantBrowser) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text,
  registration_status text not null default 'pending_registration',
  purchased_at timestamptz not null default now(), released_at timestamptz,
  created_at timestamptz not null default now(),
  voice_enabled boolean not null default false, voice_configured_at timestamptz, emergency_address_sid text
);
create unique index sms_numbers_live_unique on public.sms_numbers (phone_number) where released_at is null;
alter table public.sms_numbers enable row level security;
revoke all on public.sms_numbers from anon, authenticated;
${grantBrowser ? "grant select on public.sms_numbers to anon;" : ""}
insert into public.sms_numbers (client_id, phone_number, registration_status, voice_enabled)
values ('demo-tenant', '+15555550100', 'registered', true);
`;

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql) => (await db.query(sql)).rows[0];
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 90)})`); }
};

(async () => {
  console.log("migration 255: applies on the live shape");
  {
    const db = new PGlite();
    await db.exec(STUBS(false));
    let applied = true;
    try { await db.exec(MIG()); } catch (e) { applied = false; ok(false, "255 applied", e.message); }
    ok(applied, "255 applied cleanly, assertions and probe included");

    const cols = (await db.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'sms_numbers' and column_name in
      ('shaken_trust_product_sid','shaken_status','voice_integrity_trust_product_sid','voice_integrity_status','caller_id_checked_at',
       'caller_id_lock_until')
      order by column_name`)).rows;
    ok(cols.length === 6 && cols.every((c) => c.is_nullable === "YES" && c.column_default === null), "six nullable columns, no defaults", JSON.stringify(cols));
    ok(cols.find((c) => c.column_name === "caller_id_checked_at")?.data_type === "timestamp with time zone", "caller_id_checked_at is a timestamptz");
    ok(cols.find((c) => c.column_name === "caller_id_lock_until")?.data_type === "timestamp with time zone", "caller_id_lock_until is a timestamptz");

    const row = await one(db, "select count(*)::int n, bool_and(shaken_status is null and voice_integrity_status is null) untouched from public.sms_numbers");
    ok(row.n === 1 && row.untouched === true, "the probe row is gone and the real row is untouched", JSON.stringify(row));

    // What portal-settings writes is accepted…
    await db.exec(`update public.sms_numbers set shaken_trust_product_sid = 'BU${"0123456789abcdef".repeat(2)}',
      shaken_status = 'pending-review', voice_integrity_trust_product_sid = 'BU${"A".repeat(32)}', voice_integrity_status = 'twilio-approved',
      caller_id_checked_at = now()`);
    ok((await one(db, "select shaken_status s from public.sms_numbers")).s === "pending-review", "Twilio's own status words are stored");
    for (const s of ["draft", "in-review", "twilio-rejected", "twilio-approved"]) {
      await db.exec(`update public.sms_numbers set shaken_status = '${s}', voice_integrity_status = '${s}'`);
    }
    ok(true, "every TrustProduct enum value is accepted on both columns");
    // …and anything else is not.
    await refused(db, "update public.sms_numbers set shaken_status = 'approved'", /sms_numbers_shaken_status_chk/, "a status outside the enum is refused");
    await refused(db, "update public.sms_numbers set voice_integrity_status = 'PENDING-REVIEW'", /sms_numbers_voice_integrity_status_chk/, "the enum is case-sensitive, like Twilio's");
    await refused(db, `update public.sms_numbers set shaken_trust_product_sid = 'PN${"a".repeat(32)}'`, /sms_numbers_trust_product_sids_chk/, "a number SID is not a Trust Product SID");
    await refused(db, `update public.sms_numbers set voice_integrity_trust_product_sid = 'BU123'`, /sms_numbers_trust_product_sids_chk/, "a short SID is refused");

    // The single-flight claim, as portal-settings' phone_trust_setup sends it (one conditional
    // UPDATE; a row back is the claim) and releases it (only its own value). Two presses: the
    // second gets nothing back while the first holds it, and can claim once it is released or
    // has expired. A release carrying another run's value clears nothing.
    const claim = async (until) => (await db.query(
      `update public.sms_numbers set caller_id_lock_until = $1::timestamptz
        where client_id = 'demo-tenant' and (caller_id_lock_until is null or caller_id_lock_until < now()) returning id`, [until])).rows.length;
    const release = async (until) => (await db.query(
      `update public.sms_numbers set caller_id_lock_until = null
        where client_id = 'demo-tenant' and caller_id_lock_until = $1::timestamptz returning id`, [until])).rows.length;
    const inFive = () => new Date(Date.now() + 5 * 60_000).toISOString();
    const first = inFive();
    ok(await claim(first) === 1, "a free number is claimed");
    ok(await claim(inFive()) === 0, "a second press while it is held gets nothing back (portal-settings answers 409)");
    ok(await release(new Date(Date.now() + 9 * 60_000).toISOString()) === 0, "a release carrying another run's value clears nothing");
    ok(await release(first) === 1, "the run's own release clears it");
    ok(await claim(inFive()) === 1, "and the next press claims it");
    await db.exec("update public.sms_numbers set caller_id_lock_until = now() - interval '1 second'");
    ok(await claim(inFive()) === 1, "an expired claim (a run that died) is taken again");
    await db.exec("update public.sms_numbers set caller_id_lock_until = null");

    // Applying twice is a no-op (every add is `if not exists`; the assertions and probe run again).
    let again = true;
    try { await db.exec(MIG()); } catch (e) { again = false; ok(false, "re-apply", e.message); }
    ok(again, "a second apply is harmless");

    // The browser roles still cannot see the table (165's posture), new columns included.
    const priv = await one(db, `select has_table_privilege('anon','public.sms_numbers','SELECT') a,
      has_table_privilege('authenticated','public.sms_numbers','SELECT') u,
      has_column_privilege('authenticated','public.sms_numbers','shaken_status','SELECT') c`);
    ok(!priv.a && !priv.u && !priv.c, "anon and authenticated hold nothing on sms_numbers", JSON.stringify(priv));
    await db.close();
  }

  console.log("migration 255: the assertions abort the whole migration");
  {
    const db = new PGlite();
    await db.exec(STUBS(true));
    let err = null;
    try { await db.exec(MIG()); } catch (e) { err = e; }
    ok(!!err && /255: anon holds SELECT on sms_numbers/.test(err.message), "a browser-readable sms_numbers stops the apply", err && err.message);
    // The transaction took the columns with it.
    try { await db.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db, `select count(*)::int n from information_schema.columns where table_schema = 'public'
      and table_name = 'sms_numbers' and column_name = 'shaken_status'`);
    ok(n.n === 0, "and nothing of it is left behind", JSON.stringify(n));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
