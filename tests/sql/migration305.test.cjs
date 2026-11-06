// Execute migration 305 for real in PGlite (Postgres compiled to WASM, in memory) on sms_messages,
// crm_contacts, phone_calls and phone_voicemails shaped like the live ones (130, 150, 254), in a
// database whose default privileges hand every new function to anon and authenticated (as
// Supabase's do), then check what it promises:
//   * grants: only service_role may execute public.phone_list_search; PUBLIC, anon and
//     authenticated are refused (a browser session can never call it);
//   * every kind finds exactly what the phone-api Worker's old PostgREST read found: the texts, the
//     contacts and the conversations of POST /threads/search, the calls of POST /calls/search (by
//     name, the customer's number, a voicemail's transcript; My; the Voicemail tab), and GET
//     /search's two reads;
//   * client isolation: only p_client_id's rows, joins included (another tenant's contact or
//     voicemail tied to a call never matches);
//   * the term is matched as itself: %, _ and \ are escaped, and a term under 2 characters finds
//     nothing (never everything);
//   * the voicemail filter: only calls with a voicemail that isn't deleted, and a deleted
//     voicemail's words are never searched;
//   * the same answers with 304's trigram indexes as without; a re-apply is harmless; the
//     rehearsal (last commit swapped for rollback) leaves nothing; the REVERSE block drops it;
//     broken copies are refused (mutants), and a copy without the escaping is caught by the
//     checks above (the control).
// Nothing here touches the live project. Tenants, people and numbers are made up (the repo is public).
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration305.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");

const WT = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r/g, "");
const M304 = () => read("304_phone_list_search_trgm.sql");
const M305 = () => read("305_phone_list_search.sql");
const SIG = "public.phone_list_search(text, text, text, text, timestamptz, timestamptz, integer, boolean, uuid, boolean, uuid[], text[])";

// 305's header REVERSE-SQL block, uncommented.
function m305Reverse() {
  const lines = M305().split("\n");
  const a = lines.findIndex((l) => l.trim() === "-- REVERSE-SQL-BEGIN");
  const b = lines.findIndex((l) => l.trim() === "-- REVERSE-SQL-END");
  if (a < 0 || b < a) throw new Error("305's REVERSE-SQL markers moved");
  return lines.slice(a + 1, b).map((l) => l.replace(/^-- ?/, "")).join("\n");
}

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's: every new table and function is handed to the API roles.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema extensions;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);
create table public.crm_contacts (
  id uuid primary key, client_id text not null, name text, phone text, phone_digits text, email text,
  email_lower text generated always as (lower(btrim(email))) stored, merged_into uuid, owner_user_id uuid,
  updated_at timestamptz not null default now()
);
create table public.sms_messages (
  id uuid primary key, client_id text not null, contact_id uuid,
  direction text not null check (direction in ('out', 'in')), body text, status text not null default 'received',
  created_at timestamptz not null, from_number text not null, to_number text not null, sent_by uuid
);
create table public.phone_calls (
  id uuid primary key, client_id text not null, contact_id uuid references public.crm_contacts(id),
  direction text not null check (direction in ('out', 'in')), from_e164 text not null, to_e164 text not null,
  started_at timestamptz not null, status text not null default 'completed',
  placed_by uuid, answered_by uuid, transferred_from uuid, rang_user_ids uuid[] not null default '{}'
);
create table public.phone_voicemails (
  id uuid primary key default gen_random_uuid(), call_id uuid not null unique references public.phone_calls(id) on delete cascade,
  client_id text not null, transcript text, deleted_at timestamptz
);
`;

// ── The world ─────────────────────────────────────────────────────────────────────────────────
const ACME = "acme-sheds";
const OTHER = "bravo-barns";
const u = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ME = u(0xa1);
const TEAMMATE = u(0xb2);
const BUSINESS = "+15555550100";
const UNKNOWN = "+15555550150";
const T = (min) => new Date(Date.UTC(2026, 9, 12, 15, 0) - min * 60_000).toISOString();

const C = { jordan: u(0xc001), casey: u(0xc002), riley: u(0xc003), merged: u(0xc004), elsewhere: u(0xc009) };
const CONTACTS = [
  { id: C.jordan, client_id: ACME, name: "Jordan Demo", phone: "(555) 555-0142", phone_digits: "5555550142", email: "jordan@example.com", owner_user_id: ME, updated_at: T(1) },
  { id: C.casey, client_id: ACME, name: "Casey Lean", phone: "(555) 555-0143", phone_digits: "5555550143", email: "casey_lean@example.com", owner_user_id: TEAMMATE, updated_at: T(2) },
  { id: C.riley, client_id: ACME, name: "Riley", phone: "(555) 555-0144", phone_digits: "5555550144", email: "caseyxlean@example.com", owner_user_id: null, updated_at: T(3) },
  { id: C.merged, client_id: ACME, name: "Jordan Merged", phone: "(555) 555-0145", phone_digits: "5555550145", email: "jordan.m@example.com", owner_user_id: ME, updated_at: T(0), merged_into: C.jordan },
  // Another business's: the same name, the same digits, the same address as Jordan.
  { id: C.elsewhere, client_id: OTHER, name: "Jordan Elsewhere", phone: "(555) 555-0142", phone_digits: "5555550142", email: "jordan@example.com", owner_user_id: ME, updated_at: T(0) },
];

const TEXTS = {};
const text = (label, client, contact, direction, customer, body, at, sentBy = null) => {
  TEXTS[label] = {
    id: u(0x5000 + Object.keys(TEXTS).length), client_id: client, contact_id: contact, direction, body, created_at: at,
    from_number: direction === "in" ? customer : BUSINESS, to_number: direction === "in" ? BUSINESS : customer, sent_by: sentBy,
  };
};
text("s1", ACME, C.jordan, "in", "+15555550142", "See you Tuesday", T(1));
text("s2", ACME, C.jordan, "out", "+15555550142", "Can you send the lean-to price for the barn?", T(30), ME);
text("s3", ACME, C.casey, "in", "+15555550143", "The lean-to looks great", T(5));
text("s4", ACME, null, "in", UNKNOWN, "Do you build a lean-to?", T(12));
text("s12", ACME, null, "out", UNKNOWN, "Sure, we do", T(11), TEAMMATE);
// What a term made of LIKE's own characters must find, and must not.
text("pct", ACME, C.riley, "in", "+15555550144", "100% sure", T(40));
text("nopct", ACME, C.riley, "in", "+15555550144", "100 sure", T(41));
text("under", ACME, C.riley, "in", "+15555550144", "a_b here", T(42));
text("nounder", ACME, C.riley, "in", "+15555550144", "axb here", T(43));
text("bslash", ACME, C.riley, "in", "+15555550144", "back\\slash", T(44));
text("nobslash", ACME, C.riley, "in", "+15555550144", "backslash", T(45));
text("pctpct", ACME, C.riley, "in", "+15555550144", "%% literal", T(46));
// Another business's: Jordan's id and the unknown number, saying lean-to.
text("x1", OTHER, C.jordan, "in", "+15555550142", "lean-to elsewhere", T(0.5));
text("x2", OTHER, null, "in", UNKNOWN, "lean-to elsewhere", T(0.5));

const CALLS = {};
const callRow = (label, over) => {
  CALLS[label] = {
    id: u(0x6000 + Object.keys(CALLS).length), client_id: ACME, contact_id: null, direction: "in", from_e164: UNKNOWN, to_e164: BUSINESS,
    started_at: T(1), status: "completed", placed_by: null, answered_by: null, transferred_from: null, rang_user_ids: [], vm: null, ...over,
  };
};
callRow("k1", { contact_id: C.jordan, from_e164: "+15555550142", answered_by: ME, started_at: T(1) });
callRow("k2", { contact_id: C.casey, direction: "out", from_e164: BUSINESS, to_e164: "+15555550143", placed_by: TEAMMATE, started_at: T(2) });
callRow("k3", { status: "voicemail", rang_user_ids: [ME], started_at: T(3), vm: { transcript: "Hi, it's about the lean-to price. Call me back." } });
// Retention deleted this voicemail and its words.
callRow("k4", { from_e164: "+15555550151", status: "voicemail", rang_user_ids: [TEAMMATE], started_at: T(4), vm: { transcript: "lean-to too", deleted_at: T(1) } });
// A voicemail on MY customer that rang a teammate: mine (section 7: the owner's).
callRow("k5", { contact_id: C.jordan, from_e164: "+15555550142", status: "voicemail", rang_user_ids: [TEAMMATE], started_at: T(5), vm: { transcript: "Jordan again" } });
callRow("k6", { contact_id: C.casey, from_e164: "+15555550143", status: "missed", rang_user_ids: [TEAMMATE], started_at: T(6) });
// Broken links across tenants: this business's call tied to another's contact, and to another's voicemail row.
callRow("k7", { contact_id: C.elsewhere, from_e164: "+15555550160", started_at: T(7) });
callRow("k8", { from_e164: "+15555550170", status: "voicemail", started_at: T(8), vm: { transcript: "lean-to secret", client_id: OTHER } });
callRow("y1", { client_id: OTHER, contact_id: C.elsewhere, from_e164: "+15555550142", status: "voicemail", started_at: T(0.2), vm: { transcript: "lean-to elsewhere, Jordan" } });

const LABEL = new Map([...Object.entries(TEXTS), ...Object.entries(CALLS)].map(([k, v]) => [v.id, k]));
for (const [k, v] of Object.entries(C)) LABEL.set(v, k);

// Every database is closed at the end and the process then exits by itself (process.exitCode, not
// process.exit): on Windows, process.exit() with PGlite still winding down tripped libuv's
// "UV_HANDLE_CLOSING" assertion after ALL CHECKS PASSED (migration298.test.cjs).
const opened = [];
async function makeDb({ trgm = false } = {}) {
  const db = new PGlite(trgm ? { extensions: { pg_trgm } } : undefined);
  opened.push(db);
  await db.exec(STUBS);
  return db;
}
async function seed(db) {
  for (const r of CONTACTS) {
    await db.query(
      "insert into public.crm_contacts (id, client_id, name, phone, phone_digits, email, merged_into, owner_user_id, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [r.id, r.client_id, r.name, r.phone, r.phone_digits, r.email, r.merged_into ?? null, r.owner_user_id, r.updated_at],
    );
  }
  for (const m of Object.values(TEXTS)) {
    await db.query(
      "insert into public.sms_messages (id, client_id, contact_id, direction, body, created_at, from_number, to_number, sent_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [m.id, m.client_id, m.contact_id, m.direction, m.body, m.created_at, m.from_number, m.to_number, m.sent_by],
    );
  }
  for (const k of Object.values(CALLS)) {
    await db.query(
      "insert into public.phone_calls (id, client_id, contact_id, direction, from_e164, to_e164, started_at, status, placed_by, answered_by, rang_user_ids) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[])",
      [k.id, k.client_id, k.contact_id, k.direction, k.from_e164, k.to_e164, k.started_at, k.status, k.placed_by, k.answered_by, `{${k.rang_user_ids.join(",")}}`],
    );
    if (k.vm) {
      await db.query("insert into public.phone_voicemails (call_id, client_id, transcript, deleted_at) values ($1,$2,$3,$4)",
        [k.id, k.vm.client_id ?? k.client_id, k.vm.transcript, k.vm.deleted_at ?? null]);
    }
  }
  await db.exec("analyze");
}
async function apply(db, sql) {
  const notices = [];
  const out = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  const record = [...out].reverse().find((r) => r.rows && r.rows.length && r.fields.some((f) => f.name === "migration"));
  return { notices, record: record ? record.rows[0] : null };
}

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
async function as(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}

const TYPES = {
  p_client_id: "text", p_kind: "text", p_term: "text", p_digits: "text", p_before: "timestamptz", p_after: "timestamptz",
  p_limit: "integer", p_voicemail: "boolean", p_user_id: "uuid", p_customers: "boolean", p_ids: "uuid[]", p_numbers: "text[]",
};
const pgArray = (a) => `{${a.map((x) => `"${String(x).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
/** The function, called the way PostgREST calls it for the Worker's rpc: by named arguments. */
async function find(db, args) {
  const keys = Object.keys(args);
  const sql = `select public.phone_list_search(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k]}`).join(", ")}) as r`;
  const vals = keys.map((k) => (Array.isArray(args[k]) ? pgArray(args[k]) : args[k]));
  return (await db.query(sql, vals)).rows[0].r;
}
const labels = (rows) => rows.map((r) => LABEL.get(r.id) ?? r.id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log("migration 305: applies");
  const db = await makeDb();
  await seed(db);
  let res;
  try { res = await apply(db, M305()); ok(true, "305 applied cleanly, checks included"); }
  catch (e) { ok(false, "305 applied", e.message); process.exitCode = 1; return; }
  ok(res.notices.some((n) => /305: checks hold/.test(n)), "the checks ran to their notice", res.notices.join(" | "));
  const R = res.record || {};
  ok(String(R.function).replace(/^public\./, "") === "phone_list_search(text,text,text,text,timestamp with time zone,timestamp with time zone,integer,boolean,uuid,boolean,uuid[],text[])",
    "RECORD: the function, by its full signature", R.function);
  ok(R.security_definer === true && R.empty_search_path === true, "RECORD: security definer, empty search_path", JSON.stringify(R));
  ok(R.public_execute === false && R.anon_execute === false && R.authenticated_execute === false && R.service_role_execute === true,
    "RECORD: execute for service_role only", JSON.stringify(R));
  ok(R.probes === "7", "RECORD: every kind and branch probed on an empty tenant", R.probes);

  console.log("grants: service_role only, whatever the default privileges hand out");
  for (const role of ["anon", "authenticated"]) {
    let msg = "(it ran)";
    try { await as(db, role, () => find(db, { p_client_id: ACME, p_kind: "texts", p_term: "lean-to" })); }
    catch (e) { msg = e.message; }
    ok(/permission denied/.test(msg), `${role} cannot execute it`, msg);
  }
  // service_role holds no table grant here, so rows can only come through the definer's rights.
  await db.exec("revoke all on public.sms_messages, public.crm_contacts, public.phone_calls, public.phone_voicemails from service_role");
  const asService = await as(db, "service_role", () => find(db, { p_client_id: ACME, p_kind: "texts", p_term: "lean-to" }));
  ok(same(labels(asService), ["s3", "s4", "s2"]), "service_role executes it, with the definer's rights", JSON.stringify(labels(asService)));
  ok((await one(db, `select has_function_privilege('public', '${SIG}'::regprocedure, 'execute') v`)).v === false, "PUBLIC holds no EXECUTE");

  console.log("texts (POST /threads/search's candidates)");
  {
    const rows = await find(db, { p_client_id: ACME, p_kind: "texts", p_term: "LEAN-TO", p_limit: 500 });
    ok(same(labels(rows), ["s3", "s4", "s2"]), "every text that says it (not only a conversation's newest), newest first, case aside; never another tenant's", JSON.stringify(labels(rows)));
    ok(same(Object.keys(rows[0]).sort(), ["body", "contact_id", "created_at", "direction", "from_number", "id", "to_number"]), "the columns the Worker's GET selected", Object.keys(rows[0]).join());
    ok(Date.parse(rows[0].created_at) === Date.parse(TEXTS.s3.created_at) && /T/.test(rows[0].created_at), "times as PostgREST writes them (ISO 8601)", rows[0].created_at);
    const byNumber = await find(db, { p_client_id: ACME, p_kind: "texts", p_term: "555 0150", p_digits: "5550150" });
    ok(same(labels(byNumber), ["s12", "s4"]), "a number-like term matches the CUSTOMER's side, in and out", JSON.stringify(labels(byNumber)));
    const ours = await find(db, { p_client_id: ACME, p_kind: "texts", p_term: "555 555 0100", p_digits: "5555550100" });
    ok(same(ours, []), "the business's own number matches nothing", JSON.stringify(labels(ours)));
    const two = await find(db, { p_client_id: ACME, p_kind: "texts", p_term: "lean-to", p_limit: 2 });
    ok(same(labels(two), ["s3", "s4"]), "p_limit: the newest only", JSON.stringify(labels(two)));
    const theirs = await find(db, { p_client_id: OTHER, p_kind: "texts", p_term: "lean-to" });
    ok(same(labels(theirs).sort(), ["x1", "x2"]), "the other tenant finds its own, and only its own", JSON.stringify(labels(theirs)));
  }

  console.log("the term is itself: LIKE's wildcards and escape are escaped");
  const word = async (term) => labels(await find(db, { p_client_id: ACME, p_kind: "texts", p_term: term }));
  ok(same(await word("0%"), ["pct"]), "'0%' finds '100% sure', not '100 sure'", JSON.stringify(await word("0%")));
  ok(same(await word("a_b"), ["under"]), "'a_b' finds 'a_b here', not 'axb here'", JSON.stringify(await word("a_b")));
  ok(same(await word("k\\s"), ["bslash"]), "'k\\s' finds 'back\\slash', not 'backslash'", JSON.stringify(await word("k\\s")));
  ok(same(await word("%%"), ["pctpct"]), "'%%' finds only the text that says it, not every text", JSON.stringify(await word("%%")));
  ok(same(await word("__"), []), "'__' finds nothing", JSON.stringify(await word("__")));
  for (const t of [null, "", "  ", "%", "_", "a", " b "]) {
    ok(same(await word(t), []), `a term under 2 characters (${JSON.stringify(t)}) finds nothing, never everything`);
  }
  {
    const bad = await find(db, { p_client_id: ACME, p_kind: "texts", p_term: "lean-to", p_digits: "55%" });
    ok(same(labels(bad), ["s3", "s4", "s2"]), "p_digits that aren't 3+ digits match no number (and break nothing)", JSON.stringify(labels(bad)));
  }

  console.log("contacts (POST /threads/search's candidates)");
  {
    const named = await find(db, { p_client_id: ACME, p_kind: "contacts", p_term: "jordan", p_limit: 100 });
    ok(same(labels(named), ["jordan"]), "by name; never one merged away or another tenant's", JSON.stringify(labels(named)));
    ok(same(Object.keys(named[0]), ["id"]), "ids only");
    const cc = await find(db, { p_client_id: ACME, p_kind: "contacts", p_term: "15555550143", p_digits: "15555550143" });
    ok(same(labels(cc), ["casey"]), "a typed country code: 1 + the ten digits finds them", JSON.stringify(labels(cc)));
    const prefix = await find(db, { p_client_id: ACME, p_kind: "contacts", p_term: "1555", p_digits: "1555" });
    ok(same(labels(prefix), ["jordan", "casey", "riley"]), "  and '1555' is '555' at the start of the ten digits, most recently updated first", JSON.stringify(labels(prefix)));
    const mid = await find(db, { p_client_id: ACME, p_kind: "contacts", p_term: "550143", p_digits: "550143" });
    ok(same(labels(mid), ["casey"]), "digits anywhere in the number", JSON.stringify(labels(mid)));
  }

  console.log("conversations (POST /threads/search's walk over what it found)");
  {
    const mine = await find(db, { p_client_id: ACME, p_kind: "conversations", p_ids: [C.jordan], p_limit: 500 });
    ok(same(labels(mine), ["s1", "s2"]), "a contact's texts, newest first; never another tenant's text filed under the same id", JSON.stringify(labels(mine)));
    ok(same(Object.keys(mine[0]).sort(), ["body", "contact_id", "created_at", "direction", "from_number", "id", "sent_by", "status", "to_number"]), "the walk's columns", Object.keys(mine[0]).join());
    const nums = await find(db, { p_client_id: ACME, p_kind: "conversations", p_numbers: [UNKNOWN] });
    ok(same(labels(nums), ["s12", "s4"]), "an unknown number's texts, both ways; never another tenant's", JSON.stringify(labels(nums)));
    const filed = await find(db, { p_client_id: ACME, p_kind: "conversations", p_numbers: ["+15555550142"] });
    ok(same(filed, []), "a number's texts filed under a contact are not an unknown number's", JSON.stringify(labels(filed)));
    const below = await find(db, { p_client_id: ACME, p_kind: "conversations", p_ids: [C.jordan], p_before: T(1) });
    ok(same(labels(below), ["s2"]), "p_before: strictly older", JSON.stringify(labels(below)));
    const since = await find(db, { p_client_id: ACME, p_kind: "conversations", p_ids: [C.jordan], p_numbers: [UNKNOWN], p_after: T(11) });
    ok(same(labels(since), ["s1", "s12"]), "p_after: at or after (the 'already shown' check)", JSON.stringify(labels(since)));
    ok(same(await find(db, { p_client_id: ACME, p_kind: "conversations" }), []), "no conversations named: nothing");
  }

  console.log("calls (POST /calls/search)");
  const calls = async (args) => labels(await find(db, { p_client_id: ACME, p_kind: "calls", p_limit: 50, ...args }));
  ok(same(await calls({ p_term: "jordan" }), ["k1", "k5"]), "by the contact's name; never another tenant's contact tied to this tenant's call", JSON.stringify(await calls({ p_term: "jordan" })));
  ok(same(await calls({ p_term: "lean-to" }), ["k3"]), "by a voicemail's words; never a deleted voicemail's, nor another tenant's voicemail row", JSON.stringify(await calls({ p_term: "lean-to" })));
  ok(same(await calls({ p_term: "555 0142", p_digits: "5550142" }), ["k1", "k5"]), "by the customer's number", JSON.stringify(await calls({ p_term: "555 0142", p_digits: "5550142" })));
  ok(same(await calls({ p_term: "555 555 0100", p_digits: "5555550100" }), []), "never by the business's own number");
  ok(same(await calls({ p_term: "555555", p_digits: "555555" }), ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"]), "Team: every call of the business, a deleted voicemail's call too (it is still a call)");
  ok(same(await calls({ p_term: "555555", p_digits: "555555", p_voicemail: true }), ["k3", "k5"]), "the Voicemail tab: only calls with a voicemail that isn't deleted (and is this tenant's)", JSON.stringify(await calls({ p_term: "555555", p_digits: "555555", p_voicemail: true })));
  ok(same(await calls({ p_term: "jordan", p_voicemail: true }), ["k5"]), "  by name too");
  ok(same(await calls({ p_term: "555555", p_digits: "555555", p_user_id: ME }), ["k1", "k3", "k5"]),
    "My: answered, rang me, and the voicemail on my customer that rang a teammate", JSON.stringify(await calls({ p_term: "555555", p_digits: "555555", p_user_id: ME })));
  ok(same(await calls({ p_term: "555555", p_digits: "555555", p_user_id: TEAMMATE }), ["k2", "k4", "k5", "k6"]),
    "  a teammate's My: placed, rang them, and the missed call on their customer", JSON.stringify(await calls({ p_term: "555555", p_digits: "555555", p_user_id: TEAMMATE })));
  ok(same(await calls({ p_term: "555555", p_digits: "555555", p_user_id: ME, p_customers: false }), ["k1", "k3"]), "contacts none: no 'my customers'");
  ok(same(await calls({ p_term: "jordan", p_customers: false }), ["k5"]), "contacts none: no name match (the transcript still matches)", JSON.stringify(await calls({ p_term: "jordan", p_customers: false })));
  ok(same(await calls({ p_term: "555555", p_digits: "555555", p_before: T(3), p_limit: 2 }), ["k4", "k5"]), "p_before and p_limit: the next page", JSON.stringify(await calls({ p_term: "555555", p_digits: "555555", p_before: T(3), p_limit: 2 })));
  {
    const rows = await find(db, { p_client_id: ACME, p_kind: "calls", p_term: "jordan" });
    ok(same(Object.keys(rows[0]).sort(), ["id", "started_at"]), "ids and times only: the Worker reads the rows back by id");
    const theirs = labels(await find(db, { p_client_id: OTHER, p_kind: "calls", p_term: "lean-to" }));
    ok(same(theirs, ["y1"]), "the other tenant finds its own", JSON.stringify(theirs));
  }

  console.log("directory (GET /search)");
  {
    const both = await find(db, { p_client_id: ACME, p_kind: "directory", p_term: "jord", p_digits: "5550144", p_limit: 60 });
    ok(same(labels(both), ["jordan", "riley"]), "by name or digits, most recently updated first; never merged or another tenant's", JSON.stringify(labels(both)));
    ok(same(Object.keys(both[0]).sort(), ["email", "id", "name", "phone", "phone_digits"]), "the columns GET /search shows", Object.keys(both[0]).join());
    const digitsOnly = await find(db, { p_client_id: ACME, p_kind: "directory", p_digits: "1555" });
    ok(same(digitsOnly, []), "no country-code rule here (GET /search's own digits rule is unchanged)", JSON.stringify(labels(digitsOnly)));
    const mail = await find(db, { p_client_id: ACME, p_kind: "directory_email", p_term: "y_l" });
    ok(same(labels(mail), ["casey"]), "by address, '_' as itself: casey_lean, not caseyxlean", JSON.stringify(labels(mail)));
    const at = await find(db, { p_client_id: ACME, p_kind: "directory_email", p_term: "JORDAN@" });
    ok(same(labels(at), ["jordan"]), "case aside; never another tenant's", JSON.stringify(labels(at)));
  }

  console.log("refusals");
  for (const [label, args, re] of [
    ["a blank tenant", { p_client_id: " ", p_kind: "texts", p_term: "lean-to" }, /a tenant is required/],
    ["no tenant", { p_client_id: null, p_kind: "texts", p_term: "lean-to" }, /a tenant is required/],
    ["an unknown kind", { p_client_id: ACME, p_kind: "everything", p_term: "lean-to" }, /unknown kind/],
  ]) {
    let msg = "(it ran)";
    try { await find(db, args); } catch (e) { msg = e.message; }
    ok(re.test(msg), `${label} is refused`, msg);
  }

  console.log("with 304's trigram indexes, the same answers");
  {
    const idx = await makeDb({ trgm: true });
    await apply(idx, M304());
    await seed(idx);
    await apply(idx, M305());
    const cases = [
      { p_kind: "texts", p_term: "lean-to" }, { p_kind: "texts", p_term: "0%" }, { p_kind: "texts", p_term: "555 0150", p_digits: "5550150" },
      { p_kind: "contacts", p_term: "jordan" }, { p_kind: "calls", p_term: "lean-to" }, { p_kind: "calls", p_term: "jordan", p_user_id: ME },
      { p_kind: "directory", p_term: "jord" }, { p_kind: "directory_email", p_term: "y_l" },
    ];
    await idx.exec("set enable_seqscan = off");
    for (const c of cases) {
      const a = await find(db, { p_client_id: ACME, ...c });
      const b = await find(idx, { p_client_id: ACME, ...c });
      ok(same(labels(a), labels(b)) && a.length > 0, `${c.p_kind} '${c.p_term}': ${a.length} rows either way`, `${JSON.stringify(labels(a))} vs ${JSON.stringify(labels(b))}`);
    }
    await idx.exec("reset enable_seqscan");
  }

  console.log("re-apply, rehearsal, reverse");
  try { await apply(db, M305()); ok(true, "305 re-applies cleanly"); } catch (e) { ok(false, "305 re-applies", e.message); }
  ok((await one(db, "select count(*)::int n from pg_proc where proname = 'phone_list_search'")).n === 1, "still one function (no second overload)");
  {
    const dry = await makeDb();
    const rehearsal = M305().replace(/commit;\s*$/, "rollback;\n");
    ok(rehearsal !== M305(), "the rehearsal swaps the last commit");
    const dr = await apply(dry, rehearsal);
    ok(dr.record && dr.record.service_role_execute === true && dr.record.probes === "7", "the rehearsal prints the same record", JSON.stringify(dr.record));
    ok((await one(dry, "select count(*)::int n from pg_proc where proname = 'phone_list_search'")).n === 0, "and leaves no function");
  }
  {
    await db.exec("insert into supabase_migrations.schema_migrations (version, name) values ('305', '305_phone_list_search')");
    await db.exec(m305Reverse());
    ok((await one(db, "select count(*)::int n from pg_proc where proname = 'phone_list_search'")).n === 0, "the REVERSE block drops the function");
    ok((await one(db, "select count(*)::int n from supabase_migrations.schema_migrations where version = '305'")).n === 0, "  and the ledger row");
  }

  console.log("305 mutants");
  const src = M305();
  for (const [label, mutate, re] of [
    ["PUBLIC keeps EXECUTE", (s) => s.replace("uuid[], text[]) from public, anon, authenticated;", "uuid[], text[]) from anon, authenticated;"), /public can execute phone_list_search/],
    ["the browser roles keep the default grant", (s) => s.replace("uuid[], text[]) from public, anon, authenticated;", "uuid[], text[]) from public;"), /anon can execute phone_list_search/],
    ["not security definer", (s) => s.replace("stable\nsecurity definer\nset search_path", "stable\nsecurity invoker\nset search_path"), /should be SECURITY DEFINER/],
    ["search_path not pinned", (s) => s.replace("security definer\nset search_path to ''\nas $fn$", "security definer\nas $fn$"), /empty search_path/],
    ["a branch that names a column the table doesn't have", (s) => s.replace("'k.phone_digits like $5'", "'k.phone_digits_typo like $5'"), /phone_digits_typo/],
  ]) {
    const mm = mutate(src);
    if (mm === src) { ok(false, `mutant "${label}" changed nothing (the source moved; update the test)`); continue; }
    const mdb = await makeDb();
    try { await apply(mdb, mm); ok(false, `mutant "${label}" was refused`, "it committed"); }
    catch (e) {
      ok(re.test(e.message), `mutant "${label}" was refused`, e.message);
      await mdb.exec("rollback");
      ok((await one(mdb, "select count(*)::int n from pg_proc where proname = 'phone_list_search'")).n === 0, "  and left nothing behind");
    }
  }
  {
    const bare = await makeDb();
    await bare.exec("alter table public.phone_voicemails drop column deleted_at");
    try { await apply(bare, M305()); ok(false, "a database without phone_voicemails.deleted_at is refused", "it committed"); }
    catch (e) {
      ok(/public\.phone_voicemails\.deleted_at is missing/.test(e.message), "a database without phone_voicemails.deleted_at is refused before anything changes", e.message);
      await bare.exec("rollback");
    }
  }
  {
    // The control: a copy that passes the term to LIKE as it came. Its own checks can't see that,
    // so the wildcard checks above must: here '%%' would find every text.
    const raw = src.replace(
      "v_like := '%' || replace(replace(replace(left(v_term, 60), v_bs, v_bs || v_bs), '%', v_bs || '%'), '_', v_bs || '_') || '%';",
      "v_like := '%' || left(v_term, 60) || '%';",
    );
    if (raw === src) ok(false, "the control changed nothing (the source moved; update the test)");
    else {
      const cdb = await makeDb();
      await seed(cdb);
      await apply(cdb, raw);
      const all = labels(await find(cdb, { p_client_id: ACME, p_kind: "texts", p_term: "%%" }));
      ok(all.length > 1 && !same(all, ["pctpct"]), "control: without the escaping, '%%' finds every text, which the checks above refuse", JSON.stringify(all));
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { for (const db of opened) await db.close().catch(() => {}); });
