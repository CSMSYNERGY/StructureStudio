// Execute migration 383 for real in PGlite (Postgres compiled to WASM, in memory), on
// client_settings and email_sends as the earlier email migrations made them (107, 113, 137, 142
// and 262 are run from their files, not copied), then check what it promises:
//   * the three client_settings columns and email_sends.idem_key arrive, with their checks;
//   * the backfill pins every builder who holds a Resend domain to 'resend' and nobody to 'ses',
//     and leaves a builder with nothing at Resend unpinned;
//   * one builder per SES identity;
//   * adopt_email_send gives a row with no provider id SES's id and marks it sent, exactly once,
//     and record_email_event (262) then finds the row it could not find before;
//   * only the service role may call it;
//   * a re-apply is harmless, including after an operator's cutover (a builder on 'ses' who still
//     holds their Resend domain is NOT moved back), a rehearsal leaves nothing behind, a CRLF
//     checkout applies the same, and the assertion really aborts a broken copy (mutant).
// Nothing here touches the live project: no network, no Supabase, no email.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration383.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n");
const RAW383 = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/383_email_ses_transport.sql"), "utf8");
const M383 = () => RAW383().replace(/\r\n/g, "\n");

// The roles the earlier migrations grant to and revoke from, and client_settings as it stood
// before 107 (one key column is all they need of it).
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table public.client_settings (client_id text primary key, updated_at timestamptz default now());
`;

// 107 makes the email columns and email_sends; 113 adds resend_domain_id; 137 and 142 the reply
// columns (resend_inbound_domain_id). Run whole, from their files.
const BEFORE = ["107_email_sending.sql", "113_email_resend.sql", "137_inbound_domain.sql", "142_inbound_dns_snapshot.sql"];

// 262's three parts that matter here, lifted from the file rather than copied: the open and
// complaint columns, the events table, and record_email_event itself. The file as a whole also
// asserts 261's phone trigger is in place, which is another migration's business (its own test,
// migration262.test.cjs, builds that).
function lift262() {
  const s = read("262_email_opens.sql");
  const cut = (from, to, what) => {
    const a = s.indexOf(from);
    const b = a < 0 ? -1 : s.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`could not lift 262's ${what}: re-point lift262()`);
    return s.slice(a, b + to.length);
  };
  return [
    cut("alter table public.email_sends\n  add column if not exists delivered_at timestamptz,", ";", "columns"),
    cut("create table if not exists public.email_send_events (", "\n);", "events table"),
    "grant select, insert on public.email_send_events to service_role;",
    cut("create or replace function public.record_email_event(", "$fn$;", "function"),
    "grant execute on function public.record_email_event(text, text, timestamptz, text, text) to service_role;",
  ].join("\n");
}

const HOLDS = "holds-resend-383";
const HOLDS_REPLY = "holds-reply-only-383";
const NOTHING = "nothing-383";
const BLANK = "blank-id-383";
const SEND_TIMED_OUT = "00000000-0000-4000-8000-000000000385";
const SEND_CLAIMED = "00000000-0000-4000-8000-000000000382";
const SEND_DELIVERED = "00000000-0000-4000-8000-000000000383";
const SEND_HAS_ID = "00000000-0000-4000-8000-000000000384";
const SES_ID = "010f01a1c6ab6244-97c93344-1283-410a-bb48-6ec62d26202b-000000";

const SEED = `
insert into public.client_settings (client_id, resend_domain_id, resend_inbound_domain_id) values
  ('${HOLDS}', 'rs-dom-1', 'rs-dom-2'),
  ('${HOLDS_REPLY}', null, 'rs-dom-3'),
  ('${NOTHING}', null, null),
  ('${BLANK}', '', '');
insert into public.email_sends (id, client_id, kind, to_email, from_email, subject, status, error, provider_message_id) values
  ('${SEND_TIMED_OUT}', '${HOLDS}', 'estimate', 'a@example.test', 'info@example.test', 's', 'failed',    'ses 0/timeout', null),
  ('${SEND_CLAIMED}',   '${HOLDS}', 'estimate', 'b@example.test', 'info@example.test', 's', 'claimed',   null,            null),
  ('${SEND_DELIVERED}', '${HOLDS}', 'estimate', 'c@example.test', 'info@example.test', 's', 'delivered', null,            null),
  ('${SEND_HAS_ID}',    '${HOLDS}', 'estimate', 'd@example.test', 'info@example.test', 's', 'sent',      null,            'already-has-one');
`;

let failures = 0;
const ok = (cond, name, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail && !cond ? `   [${detail}]` : ""}`);
};
// Closed at the end and exited by process.exitCode: forcing exit with PGlite's handles in flight
// trips a libuv assertion on Windows (see migration374.test.cjs).
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };
async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  for (const f of BEFORE) await db.exec(read(f));
  await db.exec(lift262());
  await db.exec(SEED);
  return db;
}
const rows = async (db, sql) => (await db.query(sql)).rows;
const tryExec = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };
async function as(db, role, sql) {
  await db.exec(`set role ${role}`);
  try { return { rows: (await db.query(sql)).rows, error: null }; }
  catch (e) { return { rows: null, error: e }; }
  finally { await db.exec("reset role"); }
}
const pins = async (db) => Object.fromEntries((await rows(db, "select client_id, email_transport from public.client_settings")).map((r) => [r.client_id, r.email_transport]));
const newCols = async (db) => (await rows(db, `select table_name || '.' || column_name c from information_schema.columns
  where table_schema = 'public' and ((table_name = 'client_settings' and column_name in ('email_transport','ses_identity','ses_dns_records'))
     or (table_name = 'email_sends' and column_name = 'idem_key')) order by 1`)).map((r) => r.c);

(async () => {
  // ── 1. Before, then apply ────────────────────────────────────────────────────────
  const db = await fresh();
  ok((await newCols(db)).length === 0, "before: none of the four columns exist");
  const applied = await tryExec(db, M383());
  ok(!applied, "the migration applies", applied ? applied.message : "");
  ok(JSON.stringify(await newCols(db)) === JSON.stringify(["client_settings.email_transport", "client_settings.ses_dns_records", "client_settings.ses_identity", "email_sends.idem_key"]),
    "after: the three client_settings columns and email_sends.idem_key exist", JSON.stringify(await newCols(db)));

  // ── 2. The backfill ───────────────────────────────────────────────────────────────
  const p = await pins(db);
  ok(p[HOLDS] === "resend", "a builder holding a Resend sending domain is pinned to resend", JSON.stringify(p));
  ok(p[HOLDS_REPLY] === "resend", "...and so is one holding only a Resend reply domain");
  ok(p[NOTHING] === null, "a builder with nothing at Resend has no pin (follows the platform default)");
  ok(p[BLANK] === null, "an empty-string id is not a domain: no pin");
  ok(!Object.values(p).includes("ses"), "nobody comes out of the migration on ses");
  const untouched = await rows(db, "select count(*)::int n from public.email_sends where idem_key is not null");
  ok(untouched[0].n === 0, "no existing email row gained a key");

  // ── 3. The checks ─────────────────────────────────────────────────────────────────
  ok(!!(await tryExec(db, `update public.client_settings set email_transport = 'mailgun' where client_id = '${NOTHING}'`)), "email_transport refuses anything but resend, ses or NULL");
  ok(!(await tryExec(db, `update public.client_settings set email_transport = 'ses', ses_identity = 'example.test' where client_id = '${NOTHING}'`)), "...and takes ses");
  const dup = await tryExec(db, `update public.client_settings set ses_identity = 'example.test' where client_id = '${BLANK}'`);
  ok(!!dup && /duplicate key|unique/i.test(dup.message), "two builders cannot hold one SES identity", dup ? dup.message : "it was allowed");
  ok(!(await tryExec(db, `update public.client_settings set ses_identity = '' where client_id in ('${BLANK}', '${HOLDS_REPLY}')`)), "...but any number may hold none (an empty string is not an identity)");
  ok(!!(await tryExec(db, `update public.email_sends set idem_key = '' where id = '${SEND_CLAIMED}'`)), "idem_key refuses an empty string");
  ok(!!(await tryExec(db, `update public.email_sends set idem_key = repeat('k', 257) where id = '${SEND_CLAIMED}'`)), "...and anything over 256 characters");
  ok(!(await tryExec(db, `update public.email_sends set idem_key = repeat('k', 256) where id = '${SEND_HAS_ID}'`)), "...and takes 256");
  const idx = await rows(db, "select indexname from pg_indexes where schemaname = 'public' and indexname in ('email_sends_idem_key_idx', 'client_settings_ses_identity_uniq') order by 1");
  ok(idx.length === 2, "both indexes exist", JSON.stringify(idx));

  // ── 4. adopt_email_send ───────────────────────────────────────────────────────────
  const before = await as(db, "service_role", `select public.record_email_event('${SES_ID}', 'delivered', now(), null, 'evt-1') r`);
  ok(!before.error && before.rows[0].r === "unknown", "before adopting, record_email_event cannot find a send whose call timed out", before.error ? before.error.message : JSON.stringify(before.rows));
  const adopt = await as(db, "service_role", `select public.adopt_email_send('${SEND_TIMED_OUT}', '${SES_ID}') r`);
  ok(!adopt.error && adopt.rows[0].r === true, "the service role adopts SES's id onto the timed-out row", adopt.error ? adopt.error.message : JSON.stringify(adopt.rows));
  const a1 = (await rows(db, `select status, error, provider_message_id from public.email_sends where id = '${SEND_TIMED_OUT}'`))[0];
  ok(a1.status === "sent" && a1.error === null && a1.provider_message_id === SES_ID, "...the row now says sent, with the id and no error", JSON.stringify(a1));
  const after = await as(db, "service_role", `select public.record_email_event('${SES_ID}', 'delivered', now(), null, 'evt-1') r`);
  ok(!after.error && after.rows[0].r === "recorded", "...and the same event is now recorded", after.error ? after.error.message : JSON.stringify(after.rows));
  const a2 = (await rows(db, `select status, delivered_at is not null d from public.email_sends where id = '${SEND_TIMED_OUT}'`))[0];
  ok(a2.status === "delivered" && a2.d === true, "...leaving the row delivered: the retry check in emailSend.ts will find it", JSON.stringify(a2));

  const again = await as(db, "service_role", `select public.adopt_email_send('${SEND_TIMED_OUT}', 'another-id') r`);
  ok(!again.error && again.rows[0].r === false, "an id is adopted once: a second one is refused");
  const kept = (await rows(db, `select provider_message_id from public.email_sends where id = '${SEND_TIMED_OUT}'`))[0];
  ok(kept.provider_message_id === SES_ID, "...and the first id stays");
  const hasId = await as(db, "service_role", `select public.adopt_email_send('${SEND_HAS_ID}', 'another-id') r`);
  const hasIdRow = (await rows(db, `select provider_message_id from public.email_sends where id = '${SEND_HAS_ID}'`))[0];
  ok(hasId.rows[0].r === false && hasIdRow.provider_message_id === "already-has-one", "a row that already has a provider id is never touched");

  await as(db, "service_role", `select public.adopt_email_send('${SEND_CLAIMED}', 'ses-id-claimed')`);
  const claimed = (await rows(db, `select status, provider_message_id from public.email_sends where id = '${SEND_CLAIMED}'`))[0];
  ok(claimed.status === "sent" && claimed.provider_message_id === "ses-id-claimed", "a row stuck at claimed (the sent-write was lost) is un-stuck", JSON.stringify(claimed));
  await as(db, "service_role", `select public.adopt_email_send('${SEND_DELIVERED}', 'ses-id-delivered')`);
  const delivered = (await rows(db, `select status, provider_message_id from public.email_sends where id = '${SEND_DELIVERED}'`))[0];
  ok(delivered.status === "delivered" && delivered.provider_message_id === "ses-id-delivered", "a row that already says more than sent keeps its status and gains the id", JSON.stringify(delivered));

  const nulls = await as(db, "service_role", `select public.adopt_email_send(null, 'x') a, public.adopt_email_send('${SEND_CLAIMED}', '') b, public.adopt_email_send('00000000-0000-4000-8000-00000000ffff', 'x') c`);
  ok(!nulls.error && nulls.rows[0].a === false && nulls.rows[0].b === false && nulls.rows[0].c === false, "no id, no row or an unknown row: false, nothing written", nulls.error ? nulls.error.message : JSON.stringify(nulls.rows));

  for (const role of ["anon", "authenticated"]) {
    const r = await as(db, role, `select public.adopt_email_send('${SEND_CLAIMED}', 'x')`);
    ok(!!r.error && /permission denied/i.test(r.error.message), `${role} cannot call adopt_email_send`, r.error ? r.error.message : "it ran");
  }

  // ── 5. Re-apply, including after a cutover ────────────────────────────────────────
  // An operator's cutover leaves a builder on 'ses' who still holds their Resend domain (the way
  // back). A re-apply must not move them, and must not trip its own assertion over them.
  await db.exec(`update public.client_settings set email_transport = 'ses', ses_identity = 'cutover.example.test' where client_id = '${HOLDS}'`);
  const re = await tryExec(db, M383());
  ok(!re, "a re-apply runs, with a cut-over builder present", re ? re.message : "");
  const p2 = await pins(db);
  ok(p2[HOLDS] === "ses", "...and the cut-over builder stays on ses", JSON.stringify(p2));
  ok(p2[HOLDS_REPLY] === "resend" && p2[BLANK] === null, "...and everyone else is as they were");
  const keptKey = await rows(db, `select idem_key is not null k from public.email_sends where id = '${SEND_HAS_ID}'`);
  ok(keptKey[0].k === true, "...and a key written since the first apply is still there");

  // ── 6. Rehearsal: commit swapped for rollback leaves nothing behind ───────────────
  const r = await fresh();
  const rehearsal = M383().replace(/\ncommit;\s*$/, "\nrollback;\n");
  ok(rehearsal !== M383(), "the rehearsal copy differs (the file ends with commit;)");
  const rr = await tryExec(r, rehearsal);
  ok(!rr, "the rehearsal runs", rr ? rr.message : "");
  ok((await newCols(r)).length === 0, "...and leaves no column: nothing escaped the transaction");
  const fn = await rows(r, "select count(*)::int n from pg_proc where proname = 'adopt_email_send'");
  ok(fn[0].n === 0, "...and no function");

  // ── 7. CRLF ───────────────────────────────────────────────────────────────────────
  const c = await fresh();
  const cr = await tryExec(c, M383().replace(/\n/g, "\r\n"));
  ok(!cr, "a CRLF copy applies", cr ? cr.message : "");
  ok((await pins(c))[HOLDS] === "resend" && (await newCols(c)).length === 4, "...with the same result");

  // ── 8. Mutant: without the backfill, the assertion aborts and nothing is left ─────
  const m = await fresh();
  const text = M383().replace("   set email_transport = 'resend'\n where email_transport is null", "   set email_transport = email_transport\n where email_transport is null");
  if (text === M383()) ok(false, "the mutant changed the text", "the replace found nothing: re-point it");
  else {
    const err = await tryExec(m, text);
    ok(!!err && /hold a Resend domain without a pin/.test(err.message || ""), "a copy whose backfill pins nobody is refused by the assertion", err ? err.message : "it applied");
    try { await m.exec("rollback"); } catch (_e) { /* the failed transaction is already gone */ }
    ok((await newCols(m)).length === 0, "...and leaves the tables as they were");
  }

  await closeAll();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
