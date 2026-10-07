// Execute migration 286 for real in PGlite (Postgres compiled to WASM, in memory) on top of the
// three functions as they are live (area_level_for from 277, crm_contact_scope and its helpers and
// policies from 193, design_versions' policy from 207, phone_caller_context from 266; each body was
// compared with pg_get_functiondef on 2026-10-07 and is identical apart from line endings), then
// check what it promises:
//   * a stored contacts:'own_view' resolves (sales rep, dealer, NULL title, a title whose preset
//     omits contacts); an owner carrying one still resolves 'edit'; commissions and phone discard
//     it; the Dealer preset stays 'own' and nobody's preset moved;
//   * NOTHING ELSE MOVED: for every title x every area x a set of stored maps, 286's answer is
//     277's answer, except contacts on a map that stores own_view;
//   * the SQL agrees with the REAL _shared/access.ts effectiveAccess on every one of those cells,
//     and crm_contact_scope() says 'own' exactly where access.ts's ownContactsOnly() says yes;
//   * crm_contact_scope returns 'own' for own and own_view, and 'all' for view, edit, an owner
//     with a stored own_view, a signed-in user with no team row, and no JWT at all;
//   * as a signed-in own_view person, crm_contacts / designs / captured_leads / design_versions
//     return only their own, followed and unassigned customers' rows (a design or lead with no
//     customer is hidden); 'own' sees the same; 'view' and an owner see the whole tenant;
//   * phone_caller_context reports own_contacts_only true and contacts_level 'own_view';
//   * grants, SECURITY DEFINER, search_path and the four policies are what they were;
//   * a re-apply changes nothing, a CRLF checkout applies the same, and a copy whose edit or
//     assertion target went wrong is REFUSED with the whole file rolled back.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants and people are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration286.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/286_contacts_own_view.sql"), "utf8");

/** The text between two anchors (start inclusive, end exclusive), refusing quietly-moved anchors. */
function between(src, start, end, what) {
  const a = src.indexOf(start);
  const b = a < 0 ? -1 : src.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`migration286.test: the ${what} anchors moved (start=${a}, end=${b}) — re-point them`);
  return src.slice(a, b);
}

// The live functions, each from the file that defines it live, with their live grants.
function liveSql() {
  const m277 = MIG("277_price_override_area.sql");
  const m193 = MIG("193_contacts_own_scope.sql");
  const m207 = MIG("207_design_versions_own_scope.sql");
  const m266 = MIG("266_phone_numbers.sql");
  const alf = between(m277, "create or replace function public.area_level_for(", "\n-- ═══", "277 area_level_for");
  // 193 PART 2: the predicate, its two call forms, the scope resolver and the batch form, with grants.
  const helpers = between(m193, "create or replace function public.crm_contact_visible_to(", "-- ═══════", "193 PART 2");
  // 193 PART 3: the three restrictive policies. Anchored on the create, not the drop: the header's
  // ROLLBACK comment names the same drop first, and a slice from there re-creates 193's own
  // area_level_for (without price_override) over 277's.
  const policies = between(m193, "drop policy if exists crm_contacts_own_select on public.crm_contacts;\ncreate policy",
    "-- NOT POLICIED HERE", "193 PART 3");
  // 207: design_versions' helper and policy.
  const dv = between(m207, "create or replace function public.crm_design_mine(", "-- ── Assertions", "207");
  const pcc = between(m266, "create or replace function public.phone_caller_context(p_user_id uuid)", "\n-- ═══", "266 phone_caller_context");
  if (/function\s+public\.area_level_for\(/.test(helpers + policies + dv + pcc)) {
    throw new Error("migration286.test: a slice other than 277's carries an area_level_for — re-point the anchors");
  }
  return [alf, helpers, policies, dv, pcc].join("\n");
}

const ACME = "acme-sheds";
const OTHER = "barn-co-test";
const U = (n) => `00000000-0000-4000-8000-0000000000${n}`;
const C = (n) => `00000000-0000-4000-8000-00000000c${String(n).padStart(3, "0")}`;
const OWNER = U("01"), REP_OWN_VIEW = U("02"), REP_OWN = U("03"), VIEWER = U("04"), EDITOR = U("05");
const OWNER_OV = U("06"), NO_ROW = U("99"), OTHER_TENANT = U("07"), DEALER_OV = U("08");

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- The live default ACLs: every new function is executable by the browser roles until revoked.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

create table public.client_users (
  user_id uuid not null, client_id text not null, role text not null default 'user',
  title text, access jsonb, full_name text, created_at timestamptz default now(),
  primary key (user_id, client_id)
);
-- Nobody stores own_view at apply time (PART 5 refuses if anyone does); the own_view people are
-- added after the apply, the way a Team-screen save would add them.
insert into public.client_users (user_id, client_id, role, title, access, full_name) values
  ('${OWNER}',        '${ACME}',  'owner', 'owner',       null,                     'Olive Owner'),
  ('${REP_OWN}',      '${ACME}',  'user',  'sales_rep',   '{"contacts":"own"}',     'Rory Rep'),
  ('${VIEWER}',       '${ACME}',  'user',  'crew_leader', '{"contacts":"view"}',    'Vic Viewer'),
  ('${EDITOR}',       '${ACME}',  'user',  'sales_rep',   null,                     'Eddie Editor'),
  ('${OTHER_TENANT}', '${OTHER}', 'user',  'sales_rep',   null,                     'Pat Elsewhere');

-- The tenant resolver every permissive tenant policy uses (001's shape: first row wins).
create function public.current_client_id() returns text language sql stable security definer set search_path = '' as $f$
  select cu.client_id from public.client_users cu where cu.user_id = (select auth.uid()) limit 1
$f$;

create table public.crm_contacts (id uuid primary key, client_id text not null, name text, owner_user_id uuid);
create table public.crm_contact_followers (contact_id uuid not null, user_id uuid not null);
create table public.designs (short_code text primary key, client_id text not null, contact_id uuid);
create table public.captured_leads (id int primary key, client_id text not null, contact_id uuid);
create table public.design_versions (short_code text not null, client_id text not null, version int not null);

create table public.client_settings (
  client_id text primary key, phone_status text, sms_number text, phone_record_calls boolean,
  phone_recording_notice boolean, phone_recording_notice_text text, phone_transcribe_calls boolean
);
create table public.phone_user_settings (user_id uuid primary key, device_generation int);
create table public.sms_numbers (
  id uuid primary key, client_id text not null, phone_number text not null, voice_enabled boolean default true,
  registration_status text, released_at timestamptz, assigned_user_id uuid, purchased_at timestamptz default now()
);
insert into public.client_settings (client_id, phone_status, sms_number) values ('${ACME}', 'on', '+15555550100');
insert into public.sms_numbers (id, client_id, phone_number, registration_status)
  values ('00000000-0000-4000-8000-00000000a001', '${ACME}', '+15555550100', 'registered');

-- The customers. 1 is the rep's own, 2 a colleague's, 3 unassigned (193 edge case 1: everyone's),
-- 4 a colleague's the own_view rep FOLLOWS, 5 a colleague's the 'own' rep follows; 9 another tenant.
insert into public.crm_contacts (id, client_id, name, owner_user_id) values
  ('${C(1)}', '${ACME}',  'Jordan Mine',      '${REP_OWN_VIEW}'),
  ('${C(2)}', '${ACME}',  'Casey Colleague',  '${EDITOR}'),
  ('${C(3)}', '${ACME}',  'Una Unassigned',   null),
  ('${C(4)}', '${ACME}',  'Fran Followed',    '${EDITOR}'),
  ('${C(5)}', '${ACME}',  'Rae RepsOwn',      '${REP_OWN}'),
  ('${C(9)}', '${OTHER}', 'Elsewhere Person', null);
insert into public.crm_contact_followers (contact_id, user_id) values ('${C(4)}', '${REP_OWN_VIEW}'), ('${C(4)}', '${REP_OWN}');
insert into public.designs (short_code, client_id, contact_id) values
  ('SS-MINE001', '${ACME}', '${C(1)}'), ('SS-COLL002', '${ACME}', '${C(2)}'), ('SS-UNAS003', '${ACME}', '${C(3)}'),
  ('SS-FOLL004', '${ACME}', '${C(4)}'), ('SS-REPS005', '${ACME}', '${C(5)}'), ('SS-NOCU006', '${ACME}', null),
  ('SS-ELSE009', '${OTHER}', '${C(9)}');
insert into public.captured_leads (id, client_id, contact_id) values
  (1, '${ACME}', '${C(1)}'), (2, '${ACME}', '${C(2)}'), (3, '${ACME}', '${C(3)}'), (4, '${ACME}', '${C(4)}'),
  (5, '${ACME}', '${C(5)}'), (6, '${ACME}', null), (9, '${OTHER}', '${C(9)}');
insert into public.design_versions (short_code, client_id, version) values
  ('SS-MINE001', '${ACME}', 1), ('SS-MINE001', '${ACME}', 2), ('SS-COLL002', '${ACME}', 1), ('SS-UNAS003', '${ACME}', 1),
  ('SS-FOLL004', '${ACME}', 1), ('SS-REPS005', '${ACME}', 1), ('SS-NOCU006', '${ACME}', 1), ('SS-ELSE009', '${OTHER}', 1);

-- RLS as live: enabled, a PERMISSIVE tenant policy for the signed-in user, read grants.
do $rls$
declare t text;
begin
  foreach t in array array['crm_contacts', 'designs', 'captured_leads', 'design_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (client_id = (select public.current_client_id()))',
                   t || '_tenant_select', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$rls$;
`;

const TITLES = ["owner", "admin", "office_staff", "sales_manager", "sales_rep", "dealer", "scheduler",
  "crew_leader", "crew_member", "driver", "nonsense", null];
const ROLES_FOR = (t) => (t === "owner" ? ["owner", "user"] : t === "admin" ? ["admin", "user"] : ["user", "owner"]);
const MAPS = [
  null,
  {},
  { contacts: "own_view" },
  { contacts: "own" },
  { contacts: "view" },
  { contacts: "edit" },
  { contacts: "none" },
  { contacts: "own-view" },
  { contacts: "own_view", commissions: "own_view", phone: "own_view", designs: "view" },
  { commissions: "own_view" },
  { phone: "own_view", price_override: "edit" },
  { designer: "none", phone: "view", contacts: "own", settings_billing: "edit" },
  { settings_team: "none", projects: "edit", commissions: "own", contacts: "own_view" },
];
const storesOwnView = (m) => !!m && m.contacts === "own_view";

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

async function fresh() {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(liveSql());
  return db;
}
const level = async (db, role, title, access, area) =>
  (await one(db, "select public.area_level_for($1, $2, $3::jsonb, $4) as l",
    [role, title, access == null ? null : JSON.stringify(access), area])).l;
const md5 = async (db, sig) => (await one(db, `select md5(pg_get_functiondef('${sig}'::regprocedure)) as h`)).h;
const FN = {
  alf: "public.area_level_for(text,text,jsonb,text)",
  scope: "public.crm_contact_scope()",
  pcc: "public.phone_caller_context(uuid)",
  mine: "public.crm_contact_mine(uuid)",
  vis: "public.crm_contact_visible_to(uuid,uuid)",
  batch: "public.crm_visible_contact_ids(text,uuid,uuid[])",
  dmine: "public.crm_design_mine(text,text)",
};
const allMd5 = async (db) => Object.fromEntries(await Promise.all(Object.entries(FN).map(async ([k, s]) => [k, await md5(db, s)])));
const posture = async (db) => (await db.query(
  `select p.proname, p.prosecdef, p.proconfig::text as cfg, p.proacl::text as acl
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('area_level_for','crm_contact_scope','phone_caller_context',
          'crm_contact_mine','crm_contact_visible_to','crm_visible_contact_ids','crm_design_mine') order by 1`)).rows;
const policies = async (db) => (await db.query(
  `select tablename, policyname, permissive, cmd, roles::text as roles, qual from pg_policies
    where schemaname = 'public' order by 1, 2`)).rows;

// Run `sql` as a signed-in user (or anon / no JWT), returning its rows.
async function as(db, who, sql, params) {
  const claims = who ? JSON.stringify({ sub: who, role: "authenticated" }) : "";
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${who ? "authenticated" : "anon"}`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}
async function scopeOf(db, who) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [who ? JSON.stringify({ sub: who, role: "authenticated" }) : ""]);
  await db.exec("set role authenticated");
  try { return (await one(db, "select public.crm_contact_scope() as s")).s; }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims', '', false)"); }
}
// What each table shows the signed-in person.
async function seen(db, who) {
  const ids = async (sql) => (await as(db, who, sql)).map((r) => Object.values(r)[0]).sort();
  return {
    contacts: await ids("select name from public.crm_contacts"),
    designs: await ids("select short_code from public.designs"),
    leads: (await ids("select id from public.captured_leads")).map(Number).sort((a, b) => a - b),
    versions: await ids("select short_code || '#' || version as k from public.design_versions"),
  };
}

function areaKeysOf(sql) {
  const at = /k_areas\s+constant\s+jsonb\s*:=/.exec(sql);
  const open = sql.indexOf("$j$", at.index), close = sql.indexOf("$j$", open + 3);
  return Object.keys(JSON.parse(sql.slice(open + 3, close)));
}

(async () => {
  // The real permission model, imported as TypeScript (Node strips the types).
  const access = await import(pathToFileURL(path.join(WT, "supabase/functions/_shared/access.ts")).href);
  const AREAS = [...new Set([...areaKeysOf(MIG("277_price_override_area.sql")), ...areaKeysOf(MIG_TEXT()), ...access.AREA_KEYS, "no_such_area"])];

  console.log("migration 286: before — a stored own_view is DISCARDED (the widening the ship order exists for)");
  const db = await fresh();
  ok(await level(db, "user", "sales_rep", { contacts: "own_view" }, "contacts") === "edit",
    "(before 286: a sales rep storing own_view resolves 'edit', every customer — the live answer on 2026-10-07)");
  const md0 = await allMd5(db);
  const post0 = await posture(db);
  const pol0 = await policies(db);
  const cells = [];
  for (const t of TITLES) for (const role of ROLES_FOR(t)) for (const m of MAPS) for (const a of AREAS) {
    cells.push({ role, t, m, a, was: await level(db, role, t, m, a) });
  }

  console.log("migration 286: the apply, and what it prints");
  const res = await db.exec(MIG_TEXT()).catch((e) => ({ err: e }));
  ok(!res.err, "applies cleanly", res.err && res.err.message);
  const record = await one(db, `select public.area_level_for('user', 'sales_rep', '{"contacts":"own_view"}'::jsonb, 'contacts') as a,
    public.area_level_for('user', 'dealer', null, 'contacts') as b,
    public.area_level_for('owner', 'owner', '{"contacts":"own_view"}'::jsonb, 'contacts') as c,
    (select count(*) from public.client_users where access->>'contacts' = 'own_view')::int as d`);
  ok(record.a === "own_view" && record.b === "own" && record.c === "edit" && record.d === 0,
    "THE RECORD reads own_view, own, edit, 0", JSON.stringify(record));

  console.log("migration 286: how own_view resolves");
  ok(await level(db, "user", "sales_rep", { contacts: "own_view" }, "contacts") === "own_view", "a sales rep");
  ok(await level(db, "user", "dealer", { contacts: "own_view" }, "contacts") === "own_view", "a dealer");
  ok(await level(db, "user", null, { contacts: "own_view" }, "contacts") === "own_view", "a NULL title (a sales rep)");
  ok(await level(db, "user", "crew_leader", { contacts: "own_view" }, "contacts") === "own_view", "a crew leader, whose preset omits contacts");
  ok(await level(db, "owner", "owner", { contacts: "own_view" }, "contacts") === "edit", "an owner storing it is still 'edit' (owners absolute)");
  ok(await level(db, "user", "dealer", null, "contacts") === "own", "the Dealer preset is still 'own' (Own · Edit)");
  ok(await level(db, "user", "sales_rep", null, "contacts") === "edit", "the sales rep preset is still 'edit'");
  ok(await level(db, "user", "sales_rep", { commissions: "own_view" }, "commissions") === "own", "commissions discards it (the preset stands)");
  ok(await level(db, "user", "sales_rep", { phone: "own_view" }, "phone") === "own", "phone discards it (the preset stands)");
  ok(await level(db, "user", "sales_rep", { contacts: "own-view" }, "contacts") === "edit", "an unknown level still falls back to the preset");

  console.log("migration 286: nothing else moved, and the SQL agrees with access.ts on every cell");
  let moved = 0, drift = 0, checked = 0, changed = 0;
  const firstMoved = [], firstDrift = [];
  for (const c of cells) {
    const now = await level(db, c.role, c.t, c.m, c.a);
    checked++;
    const expectChange = c.a === "contacts" && storesOwnView(c.m) && c.role !== "owner";
    if (expectChange) { if (now === "own_view" && c.was !== "own_view") changed++; else { moved++; firstMoved.push({ ...c, now }); } }
    else if (now !== c.was) { moved++; if (firstMoved.length < 5) firstMoved.push({ ...c, now }); }
    if (c.a !== "no_such_area") {
      const ts = access.effectiveAccess(c.role, c.t, c.m)[c.a] ?? "none";
      if (ts !== now) { drift++; if (firstDrift.length < 5) firstDrift.push({ ...c, now, ts }); }
    }
  }
  ok(moved === 0, `only contacts on a map storing own_view changed answer, and to own_view (${checked} cells)`, JSON.stringify(firstMoved.slice(0, 5)));
  ok(changed > 0, `(${changed} contacts cells moved to own_view)`);
  ok(drift === 0, `area_level_for == effectiveAccess on every cell (${checked} cells)`, JSON.stringify(firstDrift));

  console.log("migration 286: crm_contact_scope");
  // The own_view people arrive after the apply, as a Team-screen save would put them there.
  await db.exec(`insert into public.client_users (user_id, client_id, role, title, access, full_name) values
    ('${REP_OWN_VIEW}', '${ACME}', 'user',  'sales_rep', '{"contacts":"own_view"}', 'Vera Viewonly'),
    ('${DEALER_OV}',    '${ACME}', 'user',  'dealer',    '{"contacts":"own_view"}', 'Dee Dealer'),
    ('${OWNER_OV}',     '${ACME}', 'owner', 'owner',     '{"contacts":"own_view"}', 'Otto Owner')`);
  const scopes = {};
  for (const [who, label] of [[REP_OWN_VIEW, "own_view rep"], [DEALER_OV, "own_view dealer"], [REP_OWN, "own rep"], [VIEWER, "view"],
    [EDITOR, "edit"], [OWNER, "owner"], [OWNER_OV, "owner storing own_view"], [NO_ROW, "a user with no team row"], [null, "no JWT"]]) {
    scopes[label] = await scopeOf(db, who);
  }
  ok(scopes["own_view rep"] === "own" && scopes["own_view dealer"] === "own", "'own' for own_view (rep and dealer)", JSON.stringify(scopes));
  ok(scopes["own rep"] === "own", "'own' for own, as before");
  ok(["view", "edit", "owner", "owner storing own_view", "a user with no team row", "no JWT"].every((k) => scopes[k] === "all"),
    "'all' for view, edit, an owner, an owner storing own_view, no team row and no JWT", JSON.stringify(scopes));
  // The same question access.ts asks, per stored map: SQL narrows exactly where ownContactsOnly does.
  let scopeDrift = 0;
  const probe = U("50");
  for (const t of TITLES) for (const role of ROLES_FOR(t)) for (const m of MAPS) {
    await db.query("delete from public.client_users where user_id = $1", [probe]);
    await db.query("insert into public.client_users (user_id, client_id, role, title, access) values ($1, $2, $3, $4, $5::jsonb)",
      [probe, ACME, role, t, m == null ? null : JSON.stringify(m)]);
    const sql = await scopeOf(db, probe);
    const ts = access.ownContactsOnly(access.effectiveAccess(role, t, m)) ? "own" : "all";
    if (sql !== ts) { scopeDrift++; if (scopeDrift < 4) console.log("      drift", role, t, JSON.stringify(m), sql, ts); }
  }
  await db.query("delete from public.client_users where user_id = $1", [probe]);
  ok(scopeDrift === 0, "crm_contact_scope() = 'own' exactly where access.ts ownContactsOnly() is true, on every title x role x map");

  console.log("migration 286: what each person reads through RLS");
  const vRep = await seen(db, REP_OWN_VIEW);
  const MINE = { contacts: ["Fran Followed", "Jordan Mine", "Una Unassigned"], designs: ["SS-FOLL004", "SS-MINE001", "SS-UNAS003"],
    leads: [1, 3, 4], versions: ["SS-FOLL004#1", "SS-MINE001#1", "SS-MINE001#2", "SS-UNAS003#1"] };
  ok(JSON.stringify(vRep) === JSON.stringify(MINE),
    "own_view: their own, followed and unassigned customers only, with those customers' designs, leads and versions (no customerless design or lead)",
    JSON.stringify(vRep));
  const vOwn = await seen(db, REP_OWN);
  ok(JSON.stringify(vOwn.contacts) === JSON.stringify(["Fran Followed", "Rae RepsOwn", "Una Unassigned"]) && vOwn.designs.length === 3 && vOwn.versions.length === 3,
    "own: the same rule for their own rows, unchanged", JSON.stringify(vOwn));
  const ALL = { contacts: 5, designs: 6, leads: 6, versions: 7 };
  for (const [who, label] of [[VIEWER, "view"], [EDITOR, "edit"], [OWNER, "an owner"], [OWNER_OV, "an owner storing own_view"]]) {
    const v = await seen(db, who);
    ok(v.contacts.length === ALL.contacts && v.designs.length === ALL.designs && v.leads.length === ALL.leads && v.versions.length === ALL.versions
      && !v.contacts.includes("Elsewhere Person"),
      `${label}: the whole tenant (and nothing of another)`, JSON.stringify(v));
  }
  const dealer = await seen(db, DEALER_OV);
  ok(JSON.stringify(dealer.contacts) === JSON.stringify(["Una Unassigned"]), "an own_view dealer who owns and follows nothing sees only the unassigned customer", JSON.stringify(dealer));

  console.log("migration 286: phone_caller_context");
  const ctx = async (who) => (await one(db, "select public.phone_caller_context($1::uuid) as c", [who])).c;
  const cv = await ctx(REP_OWN_VIEW);
  ok(cv.contacts_level === "own_view" && cv.own_contacts_only === true, "own_view: contacts_level own_view, own_contacts_only true", JSON.stringify(cv));
  ok((await ctx(REP_OWN)).own_contacts_only === true, "own: still true");
  ok((await ctx(VIEWER)).own_contacts_only === false && (await ctx(EDITOR)).own_contacts_only === false, "view and edit: false");
  const co = await ctx(OWNER_OV);
  ok(co.contacts_level === "edit" && co.own_contacts_only === false, "an owner storing own_view: edit, not narrowed", JSON.stringify(co));
  ok(cv.number && cv.number.e164 === "+15555550100" && Array.isArray(cv.numbers) && cv.recording && cv.recording.on === false,
    "266's number, numbers and recording are unchanged", JSON.stringify(cv));

  console.log("migration 286: grants, posture and policies");
  const priv = async (role, fn) => (await one(db, `select has_function_privilege('${role}', '${fn}', 'EXECUTE') as x`)).x;
  ok(!(await priv("anon", FN.alf)) && await priv("authenticated", FN.alf) && await priv("service_role", FN.alf), "area_level_for: authenticated and service_role, never anon");
  ok(!(await priv("anon", FN.scope)) && await priv("authenticated", FN.scope) && await priv("service_role", FN.scope), "crm_contact_scope: authenticated and service_role, never anon");
  ok(!(await priv("anon", FN.pcc)) && !(await priv("authenticated", FN.pcc)) && await priv("service_role", FN.pcc), "phone_caller_context: the service role's alone");
  const post1 = await posture(db);
  ok(JSON.stringify(post1) === JSON.stringify(post0), "SECURITY DEFINER, search_path and ACLs of all seven functions are what they were", JSON.stringify({ post0, post1 }));
  ok(JSON.stringify(await policies(db)) === JSON.stringify(pol0), "every policy is byte-for-byte what it was (the four own_select policies were not touched)");
  const md1 = await allMd5(db);
  ok(md1.mine === md0.mine && md1.vis === md0.vis && md1.batch === md0.batch && md1.dmine === md0.dmine,
    "the helpers 286 does not re-issue are untouched");
  ok(md1.alf !== md0.alf && md1.scope !== md0.scope && md1.pcc !== md0.pcc, "(the three it does re-issue changed)");
  const def = async (fn) => (await one(db, `select pg_get_functiondef('${fn}'::regprocedure) as d`)).d;
  ok((await def(FN.alf)).includes("286:") && (await def(FN.scope)).includes("286:") && (await def(FN.pcc)).includes("286:"),
    "each re-issued body carries the 286 marker the after-apply check greps for");

  console.log("migration 286: re-apply, CRLF");
  await db.exec(MIG_TEXT());
  ok(JSON.stringify(await allMd5(db)) === JSON.stringify(md1),
    "a re-apply, with people now stored on own_view, passes the precondition and leaves all seven functions byte-identical");
  await db.close();

  const crlf = await fresh();
  const cr = await crlf.exec(MIG_TEXT().replace(/\r?\n/g, "\r\n")).catch((e) => ({ err: e }));
  ok(!cr.err && await level(crlf, "user", "sales_rep", { contacts: "own_view" }, "contacts") === "own_view"
    && await level(crlf, "user", "dealer", null, "contacts") === "own",
    "a CRLF checkout of the file applies the same", cr.err && cr.err.message);
  await crlf.close();

  console.log("migration 286: a broken copy is refused and the whole file is taken back");
  const src = MIG_TEXT().replace(/\r\n/g, "\n");
  const refused = async (text, re, label, setup = null) => {
    const d = await fresh();
    if (setup) await d.exec(setup);
    const h0 = await allMd5(d);
    let err = null;
    // The file opens its own transaction, so a RAISE leaves the session aborted inside it; end it
    // the way the connection would, then read what is left.
    try { await d.exec(text); } catch (e) { err = e; await d.exec("rollback"); }
    const h = await allMd5(d);
    ok(!!err && re.test(String(err.message)) && JSON.stringify(h) === JSON.stringify(h0), label, err ? err.message : "applied without error");
    await d.close();
  };
  const noLevel = src.replace('{"levels": ["none","own_view","own","view","edit"]}', '{"levels": ["none","own","view","edit"]}');
  ok(noLevel !== src, "(mutant built: own_view dropped from k_areas)");
  await refused(noLevel, /286: a stored contacts=own_view does not resolve on a sales rep/, "without the vocabulary edit: refused, all three functions left as they were");
  const noScope = src.replace("'contacts') in ('own', 'own_view') then", "'contacts') = 'own' then");
  ok(noScope !== src, "(mutant built: crm_contact_scope not narrowing own_view)");
  await refused(noScope, /286: crm_contact_scope does not narrow own_view/, "a scope that leaves own_view un-narrowed: refused, nothing left behind");
  const scopeSaysOwnView = src.replace("  if public.area_level_for(v_role, v_title, v_access, 'contacts') in ('own', 'own_view') then\n    return 'own';",
    "  if public.area_level_for(v_role, v_title, v_access, 'contacts') = 'own_view' then\n    return 'own_view';\n  end if;\n  if public.area_level_for(v_role, v_title, v_access, 'contacts') in ('own', 'own_view') then\n    return 'own';");
  ok(scopeSaysOwnView !== src, "(mutant built: crm_contact_scope answering 'own_view', which no policy compares to)");
  await refused(scopeSaysOwnView, /286: crm_contact_scope must still answer only own or all/, "a scope that answers 'own_view' (the policies would read it as 'all'): refused");
  const pccOpen = src.replace("grant  execute on function public.phone_caller_context(uuid) to service_role;",
    "grant  execute on function public.phone_caller_context(uuid) to service_role, authenticated;");
  ok(pccOpen !== src, "(mutant built: phone_caller_context left callable by authenticated)");
  await refused(pccOpen, /286: public\.phone_caller_context\(uuid\) is callable from the browser/, "phone_caller_context reachable from the browser: refused");
  const dealerOwnView = src.replace('"designer":"edit","designs":"edit","contacts":"own",\n      "inventory":"view","orders":"edit","commissions":"own","phone":"own"',
    '"designer":"edit","designs":"edit","contacts":"own_view",\n      "inventory":"view","orders":"edit","commissions":"own","phone":"own"');
  ok(dealerOwnView !== src, "(mutant built: the Dealer preset started view-only)");
  await refused(dealerOwnView, /286: the dealer contacts preset moved/, "a Dealer preset that starts view-only: refused (the default is today's behaviour)");
  const lostPhone = src.replace('"reports":"edit","phone":"edit","settings_structures":"edit","settings_options":"edit",\n      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",\n      "settings_email":"edit","settings_team":"edit","settings_billing":"none"',
    '"reports":"edit","settings_structures":"edit","settings_options":"edit",\n      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",\n      "settings_email":"edit","settings_team":"edit","settings_billing":"none"');
  ok(lostPhone !== src, "(mutant built: the admin phone cell lost in the copy)");
  await refused(lostPhone, /286: admin phone/, "a cell 254 added, lost in the copy: refused");
  const droppedPolicy = "drop policy design_versions_own_select on public.design_versions;";
  await refused(src, /286: policy design_versions\.design_versions_own_select is missing/, "with 207's design_versions policy gone: refused (own_view's narrowing rests on it)", droppedPolicy);
  const storedAlready = `insert into public.client_users (user_id, client_id, role, title, access) values ('${U("60")}', '${ACME}', 'user', 'sales_rep', '{"contacts":"own_view"}');`;
  await refused(src, /286: somebody already stores contacts=own_view while the database discards it/, "somebody storing own_view BEFORE the readers shipped: refused, so a human looks first", storedAlready);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  // exitCode, not process.exit(): see migration270.test.cjs (a libuv assertion on Windows after a
  // .ts import). Every PGlite here is closed, so the event loop drains on its own.
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
