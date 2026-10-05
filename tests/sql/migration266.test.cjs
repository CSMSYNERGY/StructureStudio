// Execute migration 266 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// tables and functions it builds on, as they will be live after 263, then check what it promises:
// a name and an owner for each number (the name 1 to 40 characters, one LIVE number per person),
// phone_caller_context returning exactly 263's answer plus `numbers` for a business with one number,
// then the caller-ID pick with several: the person's own number first, then a team line (never a
// teammate's own number while one exists), then the texting number, then the oldest; released
// numbers and other businesses' numbers never used or listed; phone_route_for_number answering
// exactly 264's answer plus `number_owner` (null for a team line; the person, their greeting and
// their access on the number's business for someone's own number); every grant; a probe that
// leaves nothing behind; a re-apply that is harmless; a refusal to apply before 263 or before 264;
// and assertions and a probe that really abort a broken copy (mutants). Nothing here touches the live project: no
// network, no Supabase, no Twilio, no number bought.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration266.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every value here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const lf = (s) => s.replace(/\r\n/g, "\n");
const READ = (f) => lf(fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8"));
const MIG_TEXT = () => lf(fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/266_phone_numbers.sql"), "utf8"));

// area_level_for as it is live: 254 PART 4 (219's body with the `phone` area), up to its comment.
function liveAreaLevel() {
  const s = READ("254_sss_phone.sql");
  const a = s.indexOf("create or replace function public.area_level_for(");
  const b = s.indexOf("comment on function public.area_level_for(", a);
  if (a < 0 || b < 0) throw new Error("could not lift 254 PART 4 — re-point liveAreaLevel()");
  return s.slice(a, b);
}

// phone_route_for_number as a migration file left it: its create, comment, revoke and grant.
function routeRpcOf(file) {
  const s = READ(file);
  const a = s.indexOf("create or replace function public.phone_route_for_number(p_e164 text)");
  const end = "grant  execute on function public.phone_route_for_number(text) to service_role;";
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`could not lift phone_route_for_number from ${file} — re-point routeRpcOf()`);
  return s.slice(a, b + end.length);
}

// phone_caller_context as a migration file left it: its create, comment, revoke and grant.
function callerRpcOf(file) {
  const s = READ(file);
  const a = s.indexOf("create or replace function public.phone_caller_context(p_user_id uuid)");
  const end = "grant  execute on function public.phone_caller_context(uuid) to service_role;";
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`could not lift phone_caller_context from ${file} — re-point callerRpcOf()`);
  return s.slice(a, b + end.length);
}

// The live shapes, cut to the columns the RPC and the probe touch. sms_numbers is service-role only,
// as it is live (165); grantBrowser breaks that on purpose for the assertion test. with263 = false
// is the database before 263 (no recording columns, 254's RPCs); with264 = false the database
// after 263 but before 264 (no away-rule columns, 263's route RPC).
const STUBS = ({ grantBrowser = false, with263 = true, with264 = true } = {}) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

-- The live default ACLs: the trap every new table and function falls into.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.client_settings (
  client_id text primary key, updated_at timestamptz not null default now(), business_name text,
  sms_number text, phone_status text not null default 'off'
  ${with263 ? `, phone_record_calls boolean not null default false, phone_recording_notice boolean not null default true,
  phone_recording_notice_text text, phone_transcribe_calls boolean not null default true` : ""}
);
revoke all on public.client_settings from anon, authenticated;
create table public.client_users (
  user_id uuid primary key, client_id text not null, role text not null default 'owner',
  created_at timestamptz not null default now(), full_name text, title text, access jsonb
);
create table public.sms_numbers (
  id uuid primary key default gen_random_uuid(), client_id text not null, phone_number text not null,
  twilio_sid text, messaging_service_sid text,
  registration_status text not null default 'pending_registration', purchased_at timestamptz not null default now(),
  released_at timestamptz, created_at timestamptz not null default now(), voice_enabled boolean not null default false
);
create unique index sms_numbers_live_unique on public.sms_numbers (phone_number) where released_at is null;
revoke all on public.sms_numbers from anon, authenticated;
${grantBrowser ? "grant select on public.sms_numbers to authenticated;" : ""}
create table public.phone_user_settings (
  user_id uuid primary key, client_id text not null, dnd boolean not null default false, dnd_until timestamptz,
  forward_to_cell text, device_generation integer not null default 1, updated_at timestamptz not null default now()
  ${with264 ? `, dnd_cover_user_id uuid, ring_hours jsonb, ring_hours_tz text, greeting_recording_sid text, greeting_updated_at timestamptz` : ""}
);
revoke all on public.phone_user_settings from anon, authenticated;
create table public.phone_routes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  number_id uuid not null unique references public.sms_numbers(id) on delete cascade,
  mode text not null default 'all_at_once', members uuid[] not null default '{}', ring_seconds integer not null default 20,
  no_answer text not null default 'voicemail', forward_to text, business_hours jsonb,
  time_zone text not null default 'America/Chicago', after_hours text not null default 'voicemail', greeting_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
revoke all on public.phone_routes from anon, authenticated;
create table public.phone_calls (
  id uuid primary key default gen_random_uuid(), client_id text not null, number_id uuid,
  direction text not null check (direction in ('in', 'out')), from_e164 text not null default 'unknown',
  to_e164 text not null default 'unknown', placed_by uuid, answered_by uuid, rang_user_ids uuid[] not null default '{}',
  transferred_from uuid, transfer_state text check (transfer_state in ('transferring', 'conference')),
  status text not null default 'ringing', started_at timestamptz not null default now(), is_emergency boolean not null default false
);
revoke all on public.phone_calls from anon, authenticated;
`;

const T = "demo-tenant";
const O = "other-tenant";
const MAIN = "+15555550100";   // the texting number (client_settings.sms_number), bought first
const U = {
  owner: "00000000-0000-4000-8000-000000000001",
  rep: "00000000-0000-4000-8000-000000000002",
  mate: "00000000-0000-4000-8000-000000000003",
  stranger: "00000000-0000-4000-8000-000000000005", // another business
};

const SEED = (with263 = true) => `
insert into public.client_settings (client_id, business_name, phone_status, sms_number) values
  ('${T}', 'Demo Sheds', 'on', '${MAIN}'), ('${O}', 'Other Sheds', 'on', '+15555550150');
${with263 ? `update public.client_settings set phone_record_calls = true where client_id = '${T}';` : ""}
insert into public.client_users (user_id, client_id, role, title, full_name, created_at) values
  ('${U.stranger}', '${O}', 'owner', 'owner', 'Sam Stranger', now() - interval '2 years'),
  ('${U.owner}', '${T}', 'owner', 'owner', 'Olive Owner', now() - interval '1 year'),
  ('${U.rep}', '${T}', 'user', 'sales_rep', 'Rex Rep', now()),
  ('${U.mate}', '${T}', 'user', 'office_staff', 'Mia Mate', now());
insert into public.sms_numbers (client_id, phone_number, registration_status, voice_enabled, messaging_service_sid, purchased_at) values
  ('${T}', '${MAIN}', 'registered', true, 'MG00000000000000000000000000000001', now() - interval '30 days'),
  ('${O}', '+15555550150', 'registered', true, 'MG00000000000000000000000000000002', now() - interval '60 days');
insert into public.phone_user_settings (user_id, client_id, device_generation) values ('${U.rep}', '${T}', 3);
insert into public.phone_routes (client_id, number_id, members)
  select '${T}', n.id, array['${U.owner}']::uuid[] from public.sms_numbers n where n.phone_number = '${MAIN}';
`;

async function makeDb(opts = {}) {
  const db = new PGlite();
  await db.exec(STUBS(opts));
  await db.exec(liveAreaLevel());
  await db.exec(callerRpcOf(opts.with263 === false ? "254_sss_phone.sql" : "263_phone_call_recording.sql"));
  await db.exec(routeRpcOf(opts.with263 === false ? "254_sss_phone.sql" : opts.with264 === false ? "263_phone_call_recording.sql" : "264_phone_away_rules.sql"));
  await db.exec(SEED(opts.with263 !== false));
  return db;
}

async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  return notices;
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 90)})`, e.message); }
  try { await db.exec("reset role"); } catch (_e) { /* not in a role */ }
};

(async () => {
  // ── 1. On the shape 263 leaves ──────────────────────────────────────────────────────
  console.log("migration 266: applies after 263");
  const db = await makeDb();
  const ctxOf = async (u) => (await one(db, `select public.phone_caller_context('${u}') c`)).c;
  const before = { owner: await ctxOf(U.owner), rep: await ctxOf(U.rep), stranger: await ctxOf(U.stranger) };
  const routeOf = async (e164) => (await one(db, `select public.phone_route_for_number('${e164}') r`)).r;
  const routeBefore = await routeOf(MAIN);
  let notices = [];
  try { notices = await apply(db); ok(true, "266 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "266 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /266 probe: a person's own number is their caller ID/.test(n) && /nothing was kept/.test(n)), "the probe ran and rolled back", notices.join(" | "));
  ok(!notices.some((n) => /checks were skipped/.test(n)), "the probe found a client_users row for its caller-context checks", notices.join(" | "));
  const left = await one(db, `select count(*)::int n from public.sms_numbers
    where phone_number in ('+15555550195', '+15555550196', '+15555550197') or client_id = 'phone-numbers-probe-266'`);
  ok(left.n === 0, "the probe left nothing behind", JSON.stringify(left));

  console.log(" one number per business: 263's answer, plus `numbers`");
  for (const who of ["owner", "rep", "stranger"]) {
    const after = await ctxOf(U[who]);
    const { numbers, ...rest } = after;
    ok(JSON.stringify(Object.keys(rest).sort()) === JSON.stringify(Object.keys(before[who]).sort())
      && Object.keys(rest).every((k) => JSON.stringify(rest[k]) === JSON.stringify(before[who][k])),
      `${who}: every key 263 returned, unchanged (number, recording and the rest)`, JSON.stringify(after));
    ok(Array.isArray(numbers) && numbers.length === 1 && numbers[0] === after.number.e164,
      `${who}: numbers is the business's one number`, JSON.stringify(numbers));
  }
  ok((await ctxOf("00000000-0000-4000-8000-0000000000ff")) === null, "someone on no team still reads NULL");

  console.log(" phone_route_for_number: 264's answer, plus number_owner");
  {
    const after = await routeOf(MAIN);
    const { number_owner: owner0, ...rest } = after;
    ok(owner0 === null && JSON.stringify(Object.keys(rest).sort()) === JSON.stringify(Object.keys(routeBefore).sort())
      && Object.keys(rest).every((k) => JSON.stringify(rest[k]) === JSON.stringify(routeBefore[k])),
      "a team line: every key 264 returned, unchanged (members, covers, recording), and number_owner null", JSON.stringify(after));
    ok((await routeOf("+15555550177")) === null, "a number nobody owns at all still reads NULL");
  }

  console.log(" the columns");
  const cols = (await db.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name = 'sms_numbers' and column_name in ('label', 'assigned_user_id') order by column_name`)).rows;
  ok(cols.length === 2 && cols[0].data_type === "uuid" && cols[1].data_type === "text"
    && cols.every((c) => c.is_nullable === "YES" && c.column_default === null), "label text and assigned_user_id uuid, nullable, no default", JSON.stringify(cols));
  ok((await one(db, "select count(*)::int n from public.sms_numbers where label is not null or assigned_user_id is not null")).n === 0,
    "every existing number is a team line with no name");
  await refused(db, `update public.sms_numbers set label = '' where phone_number = '${MAIN}'`, /sms_numbers_label_len/, "an empty name is refused");
  await refused(db, `update public.sms_numbers set label = '${"x".repeat(41)}' where phone_number = '${MAIN}'`, /sms_numbers_label_len/, "a 41-character name is refused");
  await db.exec(`update public.sms_numbers set label = '${"x".repeat(40)}' where phone_number = '${MAIN}'`);
  await db.exec(`update public.sms_numbers set label = 'Main line' where phone_number = '${MAIN}'`);
  ok(true, "a 40-character name, and a short one, are kept");

  console.log(" more numbers, and whose they are");
  // A team line bought later, Rex's own number, and Mia's own number (bought last).
  await db.exec(`insert into public.sms_numbers (client_id, phone_number, purchased_at, label, assigned_user_id) values
    ('${T}', '+15555550101', now() - interval '20 days', 'Sales line', null),
    ('${T}', '+15555550102', now() - interval '10 days', 'Rex cell', '${U.rep}'),
    ('${T}', '+15555550103', now() - interval '5 days', null, '${U.mate}')`);
  let rep = await ctxOf(U.rep);
  ok(rep.number.e164 === "+15555550102", "Rex calls out from his own number", JSON.stringify(rep.number));
  ok(JSON.stringify(rep.numbers) === JSON.stringify([MAIN, "+15555550101", "+15555550102", "+15555550103"]),
    "numbers lists every live number of the business, oldest first", JSON.stringify(rep.numbers));
  ok(!rep.numbers.includes("+15555550150"), "and never another business's");
  ok(Object.keys(rep.number).sort().join(",") === "e164,id,registration_status,voice_enabled", "the number object keeps 263's four keys", JSON.stringify(rep.number));
  ok((await ctxOf(U.mate)).number.e164 === "+15555550103", "Mia calls out from hers, though it is the newest");
  let owner = await ctxOf(U.owner);
  ok(owner.number.e164 === MAIN, "Olive (no number of her own) calls out from the texting number, a team line", JSON.stringify(owner.number));
  ok((await ctxOf(U.stranger)).number.e164 === "+15555550150" && JSON.stringify((await ctxOf(U.stranger)).numbers) === JSON.stringify(["+15555550150"]),
    "the other business is untouched");

  // The texting number given to Mia instead: Olive must not call out from a teammate's own number
  // while a team line exists, even the one texting uses.
  await db.exec(`update public.sms_numbers set assigned_user_id = null where phone_number = '+15555550103'`);
  await db.exec(`update public.sms_numbers set assigned_user_id = '${U.mate}' where phone_number = '${MAIN}'`);
  owner = await ctxOf(U.owner);
  ok(owner.number.e164 === "+15555550101", "with the texting number now Mia's, Olive calls out from the oldest team line", JSON.stringify(owner.number));
  ok((await ctxOf(U.mate)).number.e164 === MAIN, "and Mia from the texting number, her own");

  // No texting number at all: the oldest team line (263 took the newest; CHOICES 4).
  await db.exec(`update public.sms_numbers set assigned_user_id = null where phone_number = '${MAIN}'`);
  await db.exec(`update public.client_settings set sms_number = null where client_id = '${T}'`);
  owner = await ctxOf(U.owner);
  ok(owner.number.e164 === MAIN, "with no texting number, the OLDEST team line", JSON.stringify(owner.number));
  await db.exec(`update public.client_settings set sms_number = '+15555550103' where client_id = '${T}'`);
  ok((await ctxOf(U.owner)).number.e164 === "+15555550103", "a texting number that is a later team line wins over the oldest");
  await db.exec(`update public.client_settings set sms_number = '${MAIN}' where client_id = '${T}'`);

  // Only personal numbers left: someone with none still has a caller ID (a teammate's), rather
  // than no line at all.
  await db.exec(`update public.sms_numbers set released_at = now() where phone_number in ('${MAIN}', '+15555550101', '+15555550103')`);
  owner = await ctxOf(U.owner);
  ok(owner.number.e164 === "+15555550102", "with only Rex's number live, Olive still has a caller ID", JSON.stringify(owner.number));
  ok(JSON.stringify(owner.numbers) === JSON.stringify(["+15555550102"]), "released numbers drop out of the list", JSON.stringify(owner.numbers));
  await db.exec(`insert into public.sms_numbers (client_id, phone_number, purchased_at) values ('${T}', '${MAIN}', now())`);
  ok((await ctxOf(U.owner)).number.e164 === MAIN, "a team line bought again wins over Rex's own number");

  console.log(" whose number was dialled (phone_route_for_number number_owner)");
  {
    const SID = "RE" + "0".repeat(31) + "c";
    await db.exec(`update public.phone_user_settings set greeting_recording_sid = '${SID}', greeting_updated_at = now() where user_id = '${U.rep}'`);
    let r = await routeOf("+15555550102");
    ok(r && r.number_owner && r.number_owner.user_id === U.rep && r.number_owner.greeting_sid === SID && r.number_owner.has_access === true,
      "Rex's own number names Rex, with his greeting, and his access on this business", JSON.stringify(r && r.number_owner));
    ok(r && JSON.stringify(r.members) === "[]", "whoever its answer list names (none saved yet): the owner is reported, not rung", JSON.stringify(r && r.members));
    await db.exec(`update public.client_users set title = 'driver', access = '{"phone":"none"}'::jsonb where user_id = '${U.rep}'`);
    r = await routeOf("+15555550102");
    ok(r.number_owner.has_access === false, "someone whose phone access is gone reads has_access false", JSON.stringify(r.number_owner));
    await db.exec(`update public.client_users set title = 'sales_rep', access = null where user_id = '${U.rep}'`);
    await db.exec(`insert into public.sms_numbers (client_id, phone_number, purchased_at, assigned_user_id) values ('${O}', '+15555550152', now(), '${U.rep}')`);
    r = await routeOf("+15555550152");
    ok(r.number_owner.user_id === U.rep && r.number_owner.has_access === false, "the same person on ANOTHER business's number never has access there", JSON.stringify(r.number_owner));
    await db.exec(`delete from public.sms_numbers where phone_number = '+15555550152'`);
    ok((await routeOf(MAIN)).number_owner === null, "a team line (the main number, bought again): null");
    await db.exec(`update public.phone_user_settings set greeting_recording_sid = null where user_id = '${U.rep}'`);
    ok((await routeOf("+15555550102")).number_owner.greeting_sid === null, "no greeting: null, and the number's own greeting plays");
  }

  console.log(" one live number per person");
  await refused(db, `update public.sms_numbers set assigned_user_id = '${U.rep}' where phone_number = '${MAIN}' and released_at is null`,
    /sms_numbers_one_per_person/, "a second live number for Rex is refused");
  await db.exec(`update public.sms_numbers set assigned_user_id = '${U.mate}' where phone_number = '+15555550103'`);
  ok(true, "a released number keeps its old owner and blocks nobody");
  await db.exec(`update public.sms_numbers set assigned_user_id = '${U.mate}' where phone_number = '${MAIN}' and released_at is null`);
  ok((await ctxOf(U.mate)).number.e164 === MAIN, "Mia can be given a live number while an old released one still names her");
  await db.exec(`insert into public.sms_numbers (client_id, phone_number, purchased_at, assigned_user_id) values ('${O}', '+15555550151', now(), '${U.rep}')`);
  ok(true, "the rule is per business (the index is on client_id too)");
  await db.exec(`delete from public.sms_numbers where phone_number = '+15555550151'`);
  await db.exec(`insert into public.sms_numbers (client_id, phone_number, purchased_at) values ('${T}', '+15555550104', now()), ('${T}', '+15555550105', now())`);
  ok((await one(db, `select count(*)::int n from public.sms_numbers where client_id = '${T}' and released_at is null and assigned_user_id is null`)).n === 2,
    "several team lines live at once");

  console.log(" grants");
  const priv = await one(db, `select
    has_function_privilege('anon','public.phone_caller_context(uuid)','EXECUTE') a,
    has_function_privilege('authenticated','public.phone_caller_context(uuid)','EXECUTE') u,
    has_function_privilege('anon','public.phone_route_for_number(text)','EXECUTE') ra,
    has_function_privilege('authenticated','public.phone_route_for_number(text)','EXECUTE') ru,
    has_column_privilege('authenticated','public.sms_numbers','label','SELECT') ls,
    has_column_privilege('anon','public.sms_numbers','label','UPDATE') lu,
    has_column_privilege('authenticated','public.sms_numbers','assigned_user_id','SELECT') as_,
    has_column_privilege('authenticated','public.sms_numbers','assigned_user_id','UPDATE') au,
    has_column_privilege('anon','public.sms_numbers','assigned_user_id','INSERT') ai`);
  ok(Object.values(priv).every((v) => v === false), "the browser roles hold nothing: the RPC, the columns", JSON.stringify(priv));
  ok((await one(db, "select has_function_privilege('service_role','public.phone_caller_context(uuid)','EXECUTE') s, has_function_privilege('service_role','public.phone_route_for_number(text)','EXECUTE') r")).s === true,
    "the service role still calls them");
  await refused(db, `set role authenticated; select public.phone_caller_context('${U.rep}')`, /permission denied/, "authenticated cannot call the RPC");

  // ⚠️ A re-apply once the probe's natural pick (the oldest team member, Sam) has a live number of
  // their own: the probe gives its person a number, and one live number per person would refuse
  // it and abort the whole apply. It borrows someone with none instead (Olive).
  await db.exec(`update public.sms_numbers set assigned_user_id = '${U.stranger}' where phone_number = '+15555550150' and released_at is null`);
  let again = true;
  let againNotices = [];
  try { againNotices = await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless (with names and owners in the table, the oldest team member's own number included)");
  ok(againNotices.some((n) => /nothing was kept/.test(n)) && !againNotices.some((n) => /checks were skipped/.test(n)),
    "and its probe borrowed someone with no number of their own", againNotices.join(" | "));
  ok((await one(db, "select count(*)::int n from pg_constraint where conrelid = 'public.sms_numbers'::regclass and conname = 'sms_numbers_label_len'")).n === 1,
    "the re-apply added no second copy of the check");
  ok((await one(db, `select assigned_user_id from public.sms_numbers where phone_number = '${MAIN}' and released_at is null`)).assigned_user_id === U.mate,
    "and kept whose numbers they are");
  // Everyone with a number of their own: nobody to borrow, so the caller-context half is skipped,
  // saying so, and the apply still goes through.
  await db.exec(`update public.sms_numbers set assigned_user_id = '${U.owner}' where phone_number = '+15555550104'`);
  againNotices = [];
  try { againNotices = await apply(db); ok(true, "a re-apply with every team member holding a number of their own"); }
  catch (e) { ok(false, "a re-apply with every team member holding a number of their own", e.message); }
  ok(againNotices.some((n) => /checks were skipped/.test(n)) && againNotices.some((n) => /nothing was kept/.test(n)),
    "skips the caller-context half, saying so, and still runs the rest of the probe", againNotices.join(" | "));
  ok((await one(db, `select assigned_user_id from public.sms_numbers where phone_number = '+15555550104' and released_at is null`)).assigned_user_id === U.owner,
    "and kept whose numbers they are");
  await db.close();

  // ── 2. Before 263: refused, nothing left ─────────────────────────────────────────────
  console.log("migration 266: refuses to apply before 263");
  {
    const db2 = await makeDb({ with263: false });
    let err = null;
    try { await apply(db2); } catch (e) { err = e; }
    ok(!!err, "applied before 263 it aborts (the re-issued RPC reads 263's recording columns)", err ? err.message.slice(0, 120) : "applied");
    try { await db2.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db2, `select (select count(*)::int from information_schema.columns where table_name = 'sms_numbers' and column_name in ('label', 'assigned_user_id')) c,
      (select count(*)::int from pg_class where relname = 'sms_numbers_one_per_person') i`);
    ok(gone.c === 0 && gone.i === 0, "and nothing of it is left behind", JSON.stringify(gone));
    await db2.close();
  }

  // ── 2b. Before 264: refused, nothing left ────────────────────────────────────────────
  console.log("migration 266: refuses to apply before 264");
  {
    const db4 = await makeDb({ with264: false });
    let err = null;
    try { await apply(db4); } catch (e) { err = e; }
    ok(!!err && /266: migration 264 is not applied/.test(err.message), "applied before 264 it aborts, saying so", err ? err.message.slice(0, 140) : "applied");
    try { await db4.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db4, `select (select count(*)::int from information_schema.columns where table_name = 'sms_numbers' and column_name in ('label', 'assigned_user_id')) c,
      position('number_owner' in (select prosrc from pg_proc where oid = 'public.phone_route_for_number(text)'::regprocedure)) p`);
    ok(gone.c === 0 && gone.p === 0, "and nothing of it is left behind, 263's route RPC included", JSON.stringify(gone));
    await db4.close();
  }

  // ── 3. The assertions abort the whole migration ─────────────────────────────────────
  console.log("migration 266: the assertions abort the whole migration");
  {
    const db3 = await makeDb({ grantBrowser: true });
    let err = null;
    try { await apply(db3); } catch (e) { err = e; }
    ok(!!err && /266: authenticated can SELECT sms_numbers\.label/.test(err.message), "a browser-readable sms_numbers stops the apply", err && err.message);
    try { await db3.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db3, `select (select count(*)::int from information_schema.columns where table_name = 'sms_numbers' and column_name in ('label', 'assigned_user_id')) c,
      position('''numbers''' in (select prosrc from pg_proc where oid = 'public.phone_caller_context(uuid)'::regprocedure)) p`);
    ok(gone.c === 0 && gone.p === 0, "and nothing of it is left behind, the RPC included", JSON.stringify(gone));
    await db3.close();
  }

  // ── 4. Mutants: each broken copy must be refused by an assertion or the probe ─────────
  console.log("migration 266: broken copies are refused");
  const src = MIG_TEXT();
  const mutants = [
    ["the person's own number not first", "order by coalesce(n.assigned_user_id = cu.user_id, false) desc,", "order by coalesce(n.assigned_user_id = cu.user_id, false) asc,"],
    ["the own-number key not coalesced (NULL sorts first under DESC)", "order by coalesce(n.assigned_user_id = cu.user_id, false) desc,", "order by (n.assigned_user_id = cu.user_id) desc,"],
    ["a teammate's own number ranked with the team lines", "                                           (n.assigned_user_id is null) desc,\n", ""],
    ["263's texting-number rule dropped", "                                           (n.phone_number = cs.sms_number) desc nulls last,\n", ""],
    ["numbers not returned", "           'numbers',           coalesce(", "           'numbersx',          coalesce("],
    ["released numbers listed", "           where n.client_id = cu.client_id\n                                             and n.released_at is null), '[]'::jsonb),",
      "           where n.client_id = cu.client_id), '[]'::jsonb),"],
    ["263's recording lost", "           'recording',         jsonb_build_object(", "           'recordingx',        jsonb_build_object("],
    ["two live numbers for one person", "create unique index if not exists sms_numbers_one_per_person\n  on public.sms_numbers (client_id, assigned_user_id)\n  where released_at is null and assigned_user_id is not null;",
      "create index if not exists sms_numbers_one_per_person\n  on public.sms_numbers (client_id, assigned_user_id)\n  where released_at is null and assigned_user_id is not null;"],
    ["a released number blocks its person for ever", "  where released_at is null and assigned_user_id is not null;", "  where assigned_user_id is not null;"],
    ["an empty name allowed", "check (label is null or char_length(label) between 1 and 40) not valid", "check (label is null or char_length(label) <= 40) not valid"],
    ["the RPC callable from the browser", "revoke execute on function public.phone_caller_context(uuid) from public, anon, authenticated;",
      "grant execute on function public.phone_caller_context(uuid) to authenticated;"],
    ["the RPC's search_path dropped", "language sql\nstable\nset search_path = ''\nas $fn$", "language sql\nstable\nas $fn$"],
    ["the label column has a default", "add column if not exists label            text,", "add column if not exists label            text default 'Line',"],
    ["number_owner not returned", "    'number_owner',          v_owner,\n", ""],
    ["the owner's access read on any business", "      left join public.client_users cu\n             on cu.user_id = v_num.assigned_user_id\n            and cu.client_id = v_num.client_id;",
      "      left join public.client_users cu\n             on cu.user_id = v_num.assigned_user_id;"],
    ["the owner's greeting from the wrong column", "             'greeting_sid', s.greeting_recording_sid,", "             'greeting_sid', s.forward_to_cell,"],
    ["264's covers lost from the route RPC", "'dnd_cover',       s.dnd_cover_user_id,", "'dnd_coverx',      s.dnd_cover_user_id,"],
    ["264's hours lost from the route RPC", "'ring_hours',      s.ring_hours,", "'ring_hoursx',     s.ring_hours,"],
    ["the route RPC callable from the browser", "revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;",
      "grant execute on function public.phone_route_for_number(text) to authenticated;"],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /266/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
