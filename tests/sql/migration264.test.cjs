// Execute migration 264 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// tables and functions it builds on, as they will be live after 263, then check what it promises:
// the cover column and its "never yourself" check, phone_route_for_number returning exactly 263's
// answer plus `dnd_cover` / `cover_only` / `ring_hours` / `hours_tz` / `greeting_sid` while nobody
// has chosen a cover, hours or a greeting, then the covers (once each, after the members, built
// like a member, never with access across businesses, no chains), each person's own hours (an
// object or nothing, returned as stored on a member's row and a cover's), each person's own
// greeting (a Twilio recording sid or nothing), every grant, a probe that leaves nothing behind, a
// re-apply that is harmless, a refusal to apply before 263, and assertions and a probe that
// really abort a broken copy (mutants). Nothing here touches the live project: no network, no
// Supabase, no Twilio, no call placed.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration264.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
//
// Every value here is an obviously fake fixture: this repo is public.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const lf = (s) => s.replace(/\r\n/g, "\n");
const READ = (f) => lf(fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8"));
const MIG_TEXT = () => lf(fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/264_phone_away_rules.sql"), "utf8"));

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

// The live shapes (information_schema / pg_constraint), cut to the columns the RPC reads.
// phone_user_settings is service-role only, as it is live (254 PART 3); grantBrowser breaks that
// on purpose for the assertion test. with263 = false is the database before 263 (no recording
// columns, 254's RPC).
const STUBS = ({ grantBrowser = false, with263 = true } = {}) => `
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
  registration_status text not null default 'pending_registration', purchased_at timestamptz not null default now(),
  released_at timestamptz, voice_enabled boolean not null default false
);
create table public.phone_routes (
  id uuid primary key default gen_random_uuid(), client_id text not null,
  number_id uuid not null unique references public.sms_numbers(id) on delete cascade,
  mode text not null default 'all_at_once', members uuid[] not null default '{}', ring_seconds integer not null default 20,
  no_answer text not null default 'voicemail', forward_to text, business_hours jsonb,
  time_zone text not null default 'America/Chicago', after_hours text not null default 'voicemail', greeting_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.phone_user_settings (
  user_id uuid primary key, client_id text not null, dnd boolean not null default false, dnd_until timestamptz,
  forward_to_cell text, device_generation integer not null default 1, updated_at timestamptz not null default now(),
  constraint phone_user_settings_generation_positive check (device_generation >= 1),
  constraint phone_user_settings_cell_e164 check (forward_to_cell is null or forward_to_cell ~ '^\\+[1-9][0-9]{6,14}$')
);
revoke all on public.phone_user_settings from anon, authenticated;
${grantBrowser ? "grant select on public.phone_user_settings to authenticated;" : ""}
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
const NUMBER = "00000000-0000-4000-8000-00000000a001";
const E164 = "+15555550100";
const BARE_E164 = "+15555550101"; // a number with no route row
const U = {
  owner: "00000000-0000-4000-8000-000000000001",
  rep: "00000000-0000-4000-8000-000000000002",
  mate: "00000000-0000-4000-8000-000000000003",    // same business, phone access, NOT on the list
  driver: "00000000-0000-4000-8000-000000000004",  // same business, no phone access
  stranger: "00000000-0000-4000-8000-000000000005", // another business
  ghost: "00000000-0000-4000-8000-000000000006",   // no client_users row at all (left the team)
};

const SEED = `
insert into public.client_settings (client_id, business_name, phone_status, sms_number) values
  ('${T}', 'Demo Sheds', 'on', '${E164}'), ('other-tenant', 'Other Sheds', 'on', null);
insert into public.client_users (user_id, client_id, role, title, full_name, created_at) values
  ('${U.stranger}', 'other-tenant', 'owner', 'owner', 'Sam Stranger', now() - interval '2 years'),
  ('${U.owner}', '${T}', 'owner', 'owner', 'Olive Owner', now() - interval '1 year'),
  ('${U.rep}', '${T}', 'user', 'sales_rep', 'Rex Rep', now()),
  ('${U.mate}', '${T}', 'user', 'office_staff', 'Mia Mate', now()),
  ('${U.driver}', '${T}', 'user', 'driver', 'Dan Driver', now());
insert into public.sms_numbers (id, client_id, phone_number, voice_enabled) values ('${NUMBER}', '${T}', '${E164}', true);
insert into public.sms_numbers (client_id, phone_number, voice_enabled) values ('${T}', '${BARE_E164}', true);
insert into public.phone_routes (client_id, number_id, members) values ('${T}', '${NUMBER}', array['${U.owner}', '${U.rep}']::uuid[]);
insert into public.phone_user_settings (user_id, client_id, dnd, forward_to_cell, device_generation) values
  ('${U.owner}', '${T}', true, null, 2), ('${U.rep}', '${T}', false, '+15555550177', 1),
  ('${U.mate}', '${T}', false, '+15555550178', 3);
`;

async function makeDb(opts = {}) {
  const db = new PGlite();
  await db.exec(STUBS(opts));
  await db.exec(liveAreaLevel());
  await db.exec(routeRpcOf(opts.with263 === false ? "254_sss_phone.sql" : "263_phone_call_recording.sql"));
  await db.exec(SEED);
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
// jsonb hands keys back in its own order (shortest first), so objects are compared key-sorted.
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
const refused = async (db, sql, re, msg) => {
  try { await db.exec(sql); ok(false, msg, "no error"); } catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 90)})`, e.message); }
  try { await db.exec("reset role"); } catch (_e) { /* not in a role */ }
};

(async () => {
  // ── 1. On the shape 263 leaves ──────────────────────────────────────────────────────
  console.log("migration 264: applies after 263");
  const db = await makeDb();
  const route = async (e164 = E164) => (await one(db, `select public.phone_route_for_number('${e164}') r`)).r;
  const before = await route();
  let notices = [];
  try { notices = await apply(db); ok(true, "264 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "264 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /264 probe: nobody covers for themselves/.test(n) && /nothing was kept/.test(n)), "the probe ran and rolled back", notices.join(" | "));
  ok(!notices.some((n) => /check was skipped/.test(n)), "the probe found a client_users row for its other-business check", notices.join(" | "));
  const left = await one(db, `select
    (select count(*)::int from public.client_settings where client_id like 'phone-away-probe%') cs,
    (select count(*)::int from public.sms_numbers where client_id like 'phone-away-probe%') n,
    (select count(*)::int from public.phone_routes where client_id like 'phone-away-probe%') r,
    (select count(*)::int from public.phone_user_settings where client_id like 'phone-away-probe%') s`);
  ok(Object.values(left).every((v) => v === 0), "the probe left nothing behind", JSON.stringify(left));

  console.log(" nobody has chosen a cover, hours or a greeting: 263's answer, five keys more");
  let after = await route();
  const { members: bm, ...bHead } = before;
  const { members: am, ...aHead } = after;
  ok(JSON.stringify(aHead) === JSON.stringify(bHead), "everything but the members is 263's, recording included", JSON.stringify(aHead));
  ok(am.length === bm.length && am.every((m, i) => canon(m) === canon({ ...bm[i], dnd_cover: null, cover_only: false, ring_hours: null, hours_tz: null, greeting_sid: null })),
    "each member is 263's member plus dnd_cover null, cover_only false, ring_hours null, hours_tz null and greeting_sid null, in the same order", JSON.stringify(am));
  ok((await route(BARE_E164)).members.length === 0, "a number with no route still rings nobody");

  console.log(" the cover column");
  const cols = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
    where table_name = 'phone_user_settings' and column_name = 'dnd_cover_user_id'`);
  ok(cols.data_type === "uuid" && cols.is_nullable === "YES" && cols.column_default === null, "a nullable uuid with no default", JSON.stringify(cols));
  await refused(db, `update public.phone_user_settings set dnd_cover_user_id = user_id where user_id = '${U.rep}'`,
    /phone_user_settings_cover_not_self/, "nobody can be their own cover");
  await db.exec(`insert into public.phone_user_settings (user_id, client_id, dnd_cover_user_id) values ('${U.driver}', '${T}', '${U.ghost}')`);
  ok(true, "a cover who left the team can still be stored (no FK, like the rest of the row)");

  console.log(" the covers");
  // The owner (on the list, on DND) chose Mia, who is not on the list.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.mate}' where user_id = '${U.owner}'`);
  after = await route();
  ok(after.members.map((m) => m.user_id).join() === [U.owner, U.rep, U.mate].join(), "the members in order, then the cover", after.members.map((m) => m.user_id).join());
  let cover = after.members[2];
  ok(cover.cover_only === true && cover.has_access === true && cover.identity === `u_${U.mate.replace(/-/g, "")}_g3`
    && cover.forward_to_cell === "+15555550178" && cover.full_name === "Mia Mate" && cover.dnd === false && cover.busy === false && cover.dnd_cover === null,
    "the cover is built like a member: identity at their generation, their cell, their name, access on this business", JSON.stringify(cover));
  ok(after.members[0].dnd_cover === U.mate && after.members[0].dnd === true && after.members[0].cover_only === false, "the owner's row names their cover", JSON.stringify(after.members[0]));

  // Rex chose Olive, who is on the list: no second row for her.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.owner}' where user_id = '${U.rep}'`);
  after = await route();
  ok(after.members.length === 3 && after.members.filter((m) => m.user_id === U.owner).length === 1 && !after.members.find((m) => m.user_id === U.owner).cover_only,
    "a cover who is on the list already gets no extra row", JSON.stringify(after.members.map((m) => [m.user_id, m.cover_only])));

  // Both chose Mia: she is listed once.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.mate}' where user_id = '${U.rep}'`);
  after = await route();
  ok(after.members.filter((m) => m.user_id === U.mate).length === 1, "two members with the same cover list them once");

  // Mia's own cover is not read: no chains.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.driver}' where user_id = '${U.mate}'`);
  after = await route();
  ok(!after.members.some((m) => m.user_id === U.driver) && after.members.find((m) => m.user_id === U.mate).dnd_cover === U.driver,
    "a cover's own cover is not added (one level only)", JSON.stringify(after.members.map((m) => m.user_id)));

  // What the Worker checks on the cover reads the same as for a member: their DND, busy, access.
  await db.exec(`update public.phone_user_settings set dnd = true, dnd_until = now() + interval '1 hour' where user_id = '${U.mate}'`);
  ok((await route()).members.find((m) => m.user_id === U.mate).dnd === true, "a cover on DND reads dnd");
  await db.exec(`update public.phone_user_settings set dnd_until = now() - interval '1 minute' where user_id = '${U.mate}'`);
  ok((await route()).members.find((m) => m.user_id === U.mate).dnd === false, "and a DND that ran out does not");
  await db.exec(`insert into public.phone_calls (client_id, number_id, direction, answered_by, status) values ('${T}', '${NUMBER}', 'in', '${U.mate}', 'in_progress')`);
  ok((await route()).members.find((m) => m.user_id === U.mate).busy === true, "a cover on a call reads busy");
  await db.exec(`delete from public.phone_calls`);

  for (const [who, label] of [[U.driver, "a teammate without phone access"], [U.stranger, "someone from ANOTHER business"], [U.ghost, "someone no longer on any team"]]) {
    await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${who}' where user_id = '${U.owner}'`);
    await db.exec(`update public.phone_user_settings set dnd_cover_user_id = null where user_id = '${U.rep}'`);
    cover = (await route()).members.find((m) => m.user_id === who);
    ok(!!cover && cover.cover_only === true && cover.has_access === false, `${label} as a cover reads has_access false`, JSON.stringify(cover));
  }
  ok((await route()).members.find((m) => m.user_id === U.ghost).identity === `u_${U.ghost.replace(/-/g, "")}_g1`, "a cover with no settings row is generation 1");

  // A route filed under another business is still ignored, covers and all.
  await db.exec(`update public.phone_routes set client_id = 'other-tenant' where number_id = '${NUMBER}'`);
  ok((await route()).members.length === 0, "a route on the wrong business rings nobody, covers included");
  await db.exec(`update public.phone_routes set client_id = '${T}' where number_id = '${NUMBER}'`);

  console.log(" each person's own hours");
  for (const [col, type] of [["ring_hours", "jsonb"], ["ring_hours_tz", "text"]]) {
    const c = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'phone_user_settings' and column_name = '${col}'`);
    ok(c && c.data_type === type && c.is_nullable === "YES" && c.column_default === null, `${col}: a nullable ${type} with no default`, JSON.stringify(c));
  }
  await refused(db, `update public.phone_user_settings set ring_hours = '[["08:00","17:00"]]' where user_id = '${U.rep}'`,
    /phone_user_settings_ring_hours_object/, "hours that aren't an object are refused");
  await refused(db, `update public.phone_user_settings set ring_hours = '"always"' where user_id = '${U.rep}'`,
    /phone_user_settings_ring_hours_object/, "a bare string is refused too");
  await refused(db, `update public.phone_user_settings set ring_hours_tz = '' where user_id = '${U.rep}'`,
    /phone_user_settings_ring_hours_tz_len/, "an empty zone is refused");
  await refused(db, `update public.phone_user_settings set ring_hours_tz = '${"A".repeat(65)}' where user_id = '${U.rep}'`,
    /phone_user_settings_ring_hours_tz_len/, "a zone name longer than 64 is refused");
  const HOURS = { mon: [["08:00", "12:00"], ["13:00", "17:00"]], fri: [["08:00", "15:00"]] };
  const sameHours = (a) => !!a && typeof a === "object" && canon(a) === canon(HOURS);
  // Rex (a member) and Mia (the owner's cover, not a member) set their hours; Olive leaves hers.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.mate}' where user_id = '${U.owner}'`);
  await db.exec(`update public.phone_user_settings set ring_hours = '${JSON.stringify(HOURS)}', ring_hours_tz = 'America/Denver' where user_id in ('${U.rep}', '${U.mate}')`);
  after = await route();
  const byId = (id) => after.members.find((m) => m.user_id === id);
  ok(sameHours(byId(U.rep).ring_hours) && byId(U.rep).hours_tz === "America/Denver",
    "a member's own hours and zone come back as stored", JSON.stringify(byId(U.rep)));
  ok(byId(U.mate).cover_only === true && sameHours(byId(U.mate).ring_hours) && byId(U.mate).hours_tz === "America/Denver",
    "a cover's own hours come back on the cover row, read like a member's", JSON.stringify(byId(U.mate)));
  ok(byId(U.owner).ring_hours === null && byId(U.owner).hours_tz === null, "someone who set none reads null: always", JSON.stringify(byId(U.owner)));
  await db.exec(`update public.phone_user_settings set ring_hours = '{}', ring_hours_tz = null where user_id = '${U.rep}'`);
  after = await route();
  ok(JSON.stringify(byId(U.rep).ring_hours) === "{}" && byId(U.rep).hours_tz === null, "{} (no day ticked) is kept as {}, never collapsed into null", JSON.stringify(byId(U.rep)));
  ok(JSON.stringify(after.route.business_hours) === JSON.stringify(before.route.business_hours) && after.route.time_zone === before.route.time_zone,
    "the number's own business hours and zone are untouched", JSON.stringify(after.route));
  await db.exec(`update public.phone_user_settings set ring_hours = '${JSON.stringify(HOURS)}', ring_hours_tz = 'America/Denver' where user_id = '${U.rep}'`);

  console.log(" each person's own greeting");
  {
    const c1 = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'phone_user_settings' and column_name = 'greeting_recording_sid'`);
    ok(c1 && c1.data_type === "text" && c1.is_nullable === "YES" && c1.column_default === null, "greeting_recording_sid: a nullable text with no default", JSON.stringify(c1));
    const c2 = await one(db, `select data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'phone_user_settings' and column_name = 'greeting_updated_at'`);
    ok(c2 && c2.data_type === "timestamp with time zone" && c2.is_nullable === "YES" && c2.column_default === null, "greeting_updated_at: a nullable timestamptz with no default", JSON.stringify(c2));
  }
  for (const [bad, label] of [
    ["https://cdn.example.test/hi.mp3", "a link"],
    ["RE" + "A".repeat(32), "upper-case hex"],
    ["RE" + "0".repeat(31), "a sid one digit short"],
    ["CA" + "0".repeat(32), "a call sid"],
    ["", "an empty string"],
  ]) {
    await refused(db, `update public.phone_user_settings set greeting_recording_sid = '${bad}' where user_id = '${U.rep}'`,
      /phone_user_settings_greeting_sid_shape/, `a greeting that isn't a recording sid is refused: ${label}`);
  }
  const SID = "RE" + "0".repeat(31) + "9";
  const SID2 = "RE" + "0".repeat(31) + "a";
  // Rex (a member) and Mia (the owner's cover, not a member) record greetings; Olive has none.
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.mate}' where user_id = '${U.owner}'`);
  await db.exec(`update public.phone_user_settings set greeting_recording_sid = '${SID}', greeting_updated_at = now() where user_id = '${U.rep}'`);
  await db.exec(`update public.phone_user_settings set greeting_recording_sid = '${SID2}', greeting_updated_at = now() where user_id = '${U.mate}'`);
  after = await route();
  ok(byId(U.rep).greeting_sid === SID, "a member's own greeting comes back as its sid", JSON.stringify(byId(U.rep)));
  ok(byId(U.mate).cover_only === true && byId(U.mate).greeting_sid === SID2, "a cover row carries the cover's own greeting, read like a member's", JSON.stringify(byId(U.mate)));
  ok(byId(U.owner).greeting_sid === null, "someone with no greeting reads null", JSON.stringify(byId(U.owner)));
  ok(after.route.greeting_url === before.route.greeting_url, "the number's own greeting link is untouched", JSON.stringify(after.route));
  ok(!Object.prototype.hasOwnProperty.call(byId(U.rep), "greeting_updated_at"), "the RPC hands the Worker the sid only, not when it was recorded", JSON.stringify(byId(U.rep)));
  // Cleared: the Worker nulls the sid and stamps the time (routes/greeting.ts clearGreeting).
  await db.exec(`update public.phone_user_settings set greeting_recording_sid = null, greeting_updated_at = now() where user_id = '${U.mate}'`);
  after = await route();
  ok(byId(U.mate).greeting_sid === null, "a cleared greeting reads null");
  await db.exec(`update public.phone_user_settings set dnd_cover_user_id = '${U.ghost}' where user_id = '${U.owner}'`);

  console.log(" grants");
  const priv = await one(db, `select
    has_function_privilege('anon','public.phone_route_for_number(text)','EXECUTE') a,
    has_function_privilege('authenticated','public.phone_route_for_number(text)','EXECUTE') u,
    has_column_privilege('authenticated','public.phone_user_settings','dnd_cover_user_id','SELECT') cs,
    has_column_privilege('anon','public.phone_user_settings','dnd_cover_user_id','UPDATE') cu,
    has_column_privilege('authenticated','public.phone_user_settings','ring_hours','SELECT') hs,
    has_column_privilege('authenticated','public.phone_user_settings','ring_hours','UPDATE') hu,
    has_column_privilege('anon','public.phone_user_settings','ring_hours_tz','SELECT') zs,
    has_column_privilege('authenticated','public.phone_user_settings','ring_hours_tz','INSERT') zi,
    has_column_privilege('authenticated','public.phone_user_settings','greeting_recording_sid','SELECT') gs,
    has_column_privilege('authenticated','public.phone_user_settings','greeting_recording_sid','UPDATE') gu,
    has_column_privilege('anon','public.phone_user_settings','greeting_recording_sid','SELECT') ga,
    has_column_privilege('authenticated','public.phone_user_settings','greeting_updated_at','INSERT') gi`);
  ok(Object.values(priv).every((v) => v === false), "the browser roles hold nothing: the RPC, the columns", JSON.stringify(priv));
  ok((await one(db, "select has_function_privilege('service_role','public.phone_route_for_number(text)','EXECUTE') s")).s === true, "the service role still calls it");
  await refused(db, `set role authenticated; select public.phone_route_for_number('${E164}')`, /permission denied/, "authenticated cannot call the RPC");

  let again = true;
  try { await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless (with covers in the table)");
  ok((await one(db, "select count(*)::int n from pg_constraint where conrelid = 'public.phone_user_settings'::regclass and conname = 'phone_user_settings_cover_not_self'")).n === 1,
    "the re-apply added no second copy of the check");
  ok((await one(db, `select dnd_cover_user_id from public.phone_user_settings where user_id = '${U.owner}'`)).dnd_cover_user_id === U.ghost, "and kept what people chose");
  const keptHours = await one(db, `select ring_hours, ring_hours_tz from public.phone_user_settings where user_id = '${U.rep}'`);
  ok(sameHours(keptHours.ring_hours) && keptHours.ring_hours_tz === "America/Denver", "hours included", JSON.stringify(keptHours));
  ok((await one(db, `select count(*)::int n from pg_constraint where conrelid = 'public.phone_user_settings'::regclass
    and conname in ('phone_user_settings_ring_hours_object', 'phone_user_settings_ring_hours_tz_len')`)).n === 2, "and no second copy of the hours checks");
  ok((await one(db, `select greeting_recording_sid from public.phone_user_settings where user_id = '${U.rep}'`)).greeting_recording_sid === SID, "greetings included");
  ok((await one(db, `select count(*)::int n from pg_constraint where conrelid = 'public.phone_user_settings'::regclass
    and conname = 'phone_user_settings_greeting_sid_shape'`)).n === 1, "and no second copy of the greeting check");
  await db.close();

  // ── 2. Before 263: refused, nothing left ─────────────────────────────────────────────
  console.log("migration 264: refuses to apply before 263");
  {
    const db2 = await makeDb({ with263: false });
    let err = null;
    try { await apply(db2); } catch (e) { err = e; }
    ok(!!err, "applied before 263 it aborts (the probe calls the re-issued RPC, which reads 263's columns)", err ? err.message.slice(0, 120) : "applied");
    try { await db2.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db2, "select count(*)::int c from information_schema.columns where table_name = 'phone_user_settings' and column_name in ('dnd_cover_user_id', 'ring_hours', 'ring_hours_tz', 'greeting_recording_sid', 'greeting_updated_at')");
    ok(gone.c === 0, "and nothing of it is left behind", JSON.stringify(gone));
    await db2.close();
  }

  // ── 3. The assertions abort the whole migration ─────────────────────────────────────
  console.log("migration 264: the assertions abort the whole migration");
  {
    const db3 = await makeDb({ grantBrowser: true });
    let err = null;
    try { await apply(db3); } catch (e) { err = e; }
    ok(!!err && /264: authenticated can SELECT phone_user_settings\.dnd_cover_user_id/.test(err.message), "a browser-readable phone_user_settings stops the apply", err && err.message);
    try { await db3.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const gone = await one(db3, `select (select count(*)::int from information_schema.columns where table_name = 'phone_user_settings' and column_name in ('dnd_cover_user_id', 'ring_hours', 'ring_hours_tz', 'greeting_recording_sid', 'greeting_updated_at')) c,
      position('cover_only' in (select prosrc from pg_proc where oid = 'public.phone_route_for_number(text)'::regprocedure)) p`);
    ok(gone.c === 0 && gone.p === 0, "and nothing of it is left behind, the RPC included", JSON.stringify(gone));
    await db3.close();
  }

  // ── 4. Mutants: each broken copy must be refused by an assertion or the probe ─────────
  console.log("migration 264: broken copies are refused");
  const src = MIG_TEXT();
  const mutants = [
    ["a cover from another business has access", "    left join public.client_users cu\n           on cu.user_id = m.user_id\n          and cu.client_id = v_num.client_id;",
      "    left join public.client_users cu\n           on cu.user_id = m.user_id;"],
    ["cover rows not marked", "select cs.dnd_cover_user_id, min(cm.ord), true", "select cs.dnd_cover_user_id, min(cm.ord), false"],
    ["a cover listed once per member who chose them", "\n       group by cs.dnd_cover_user_id\n    ) m", "\n       group by cs.dnd_cover_user_id, cm.ord\n    ) m"],
    ["a member who is also a cover listed twice", "\n         and array_position(v_route.members, cs.dnd_cover_user_id) is null", ""],
    ["covers before the members", "order by m.cover_only, m.ord), '[]'::jsonb)", "order by m.cover_only desc, m.ord), '[]'::jsonb)"],
    ["the member rows lost dnd_cover", "'dnd_cover',       s.dnd_cover_user_id,", "'dnd_coverx',      s.dnd_cover_user_id,"],
    ["someone may cover for themselves", "check (dnd_cover_user_id is null or dnd_cover_user_id <> user_id) not valid", "check (true) not valid"],
    ["the RPC callable from the browser", "revoke execute on function public.phone_route_for_number(text) from public, anon, authenticated;",
      "grant execute on function public.phone_route_for_number(text) to authenticated;"],
    ["263's recording lost", "    'recent_emergency_user', v_emergency,\n    'recording',", "    'recent_emergency_user', v_emergency,\n    'recordingx',"],
    ["the RPC's search_path dropped", "stable\nset search_path = ''\nas $fn$", "stable\nas $fn$"],
    ["the member rows lost ring_hours", "'ring_hours',      s.ring_hours,", "'ring_hoursx',     s.ring_hours,"],
    ["hours_tz read from the wrong column", "'hours_tz',        s.ring_hours_tz", "'hours_tz',        s.forward_to_cell"],
    ["ring_hours takes any json", "check (ring_hours is null or jsonb_typeof(ring_hours) = 'object') not valid", "check (true) not valid"],
    ["ring_hours_tz takes an empty zone", "check (ring_hours_tz is null or char_length(ring_hours_tz) between 1 and 64) not valid", "check (true) not valid"],
    ["the member rows lost greeting_sid", "'greeting_sid',    s.greeting_recording_sid", "'greeting_sidx',   s.greeting_recording_sid"],
    ["greeting_sid read from the wrong column", "'greeting_sid',    s.greeting_recording_sid", "'greeting_sid',    s.forward_to_cell"],
    ["a greeting takes any text", "check (greeting_recording_sid is null or greeting_recording_sid ~ '^RE[0-9a-f]{32}$') not valid", "check (true) not valid"],
    ["the greeting column has a default", "add column if not exists greeting_recording_sid text,", "add column if not exists greeting_recording_sid text default 'RE00000000000000000000000000000000',"],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /264/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
