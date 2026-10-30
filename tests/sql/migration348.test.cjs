// Execute migration 348 (👍/👎 on the Studio Assistant's answers and its "didn't know" notes) for real
// in PGlite (Postgres compiled to WASM, in memory), on top of 340 itself, then check what it promises:
//   * the seven columns exist with their types; THE RECORD reads columns 7, triggers 2;
//   * a 👍 on an answer counts on its chat, a 👍 changed to a 👎 moves the count, a cleared rating
//     takes it off; a gap note counts; another chat's numbers never move;
//   * a rating or a gap on the builder's own words is refused, and so are a rating of 2, a note or
//     a gap over 300 characters, and a note without a rating;
//   * both tables are still service-role only: no policy, nothing a browser role can read or update;
//   * a re-apply keeps every rating and count; the header's ROLLBACK undoes it and the file applies
//     again after it;
//   * a file without its tally triggers aborts the whole batch (a mutant), leaving nothing behind.
// Nothing here touches the live project: no network, no Supabase.
//
// Tenants are made up. The repo is public: no real client id belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration348.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const FILE = path.join(WT, "supabase/migrations/348_support_feedback.sql");
const MIG = () => fs.readFileSync(process.env.MIG_FILE || FILE, "utf8").replace(/\r/g, "");
const M340 = () => fs.readFileSync(path.join(WT, "supabase/migrations/340_support_agent.sql"), "utf8").replace(/\r/g, "");

// The header's ROLLBACK, lifted from the file itself so the test runs the text a person would.
const ROLLBACK = (() => {
  const t = MIG();
  const i = t.indexOf("-- ── ROLLBACK");
  const j = t.indexOf("\n\n", i);
  if (i < 0 || j < 0) throw new Error("348's ROLLBACK block moved; re-point the test");
  return t.slice(i, j).split("\n").slice(1).map((l) => l.replace(/^--\s?/, "")).join("\n")
    .replace(/delete from supabase_migrations[^\n]*\n/, "");
})();

// The two tables 340 alters, cut to the columns it needs, with this project's default privileges.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create table public.client_settings (
  client_id text primary key,
  internal_account boolean not null default false
);
create table public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  client_id text,
  kind text not null check (kind in ('bug','feature')),
  title text not null,
  created_at timestamptz not null default now()
);
grant all on all tables in schema public to public;
alter default privileges in schema public grant all on tables to public;
alter default privileges in schema public grant execute on functions to public;
insert into public.client_settings (client_id) values ('builder-a'), ('builder-b');
`;

const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000b1";

let fails = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `   [${detail}]` : ""}`); if (!ok) fails++; };
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const refused = async (db, sql, params) => { try { await db.query(sql, params); return false; } catch { return true; } };
const opened = [];
const closeAll = async () => { for (const d of opened) await d.close().catch(() => {}); };

async function fresh() {
  const db = new PGlite();
  opened.push(db);
  await db.exec(STUBS);
  await db.exec(M340());
  return db;
}
const record = (res) => res.filter((r) => r.rows && r.rows.length).pop()?.rows?.[0];
const tally = (db, id) => one(db, "select up_count as up, down_count as down, gap_count as gaps from public.support_conversations where id = $1", [id]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ── 1. Apply ────────────────────────────────────────────────────────────────────────────
  const db = await fresh();
  const c1 = (await one(db, "insert into public.support_conversations (client_id, user_id) values ('builder-a', $1) returning id", [U1])).id;
  const c2 = (await one(db, "insert into public.support_conversations (client_id, user_id) values ('builder-b', $1) returning id", [U2])).id;
  const msg = async (conv, who, role, body, extra = "") =>
    (await one(db, `insert into public.support_messages (conversation_id, client_id, user_id, role, body${extra ? ", gap" : ""})
       values ($1, $2, $3, $4, $5${extra ? ", $6" : ""}) returning id`,
      extra ? [conv, conv === c1 ? "builder-a" : "builder-b", who, role, body, extra] : [conv, conv === c1 ? "builder-a" : "builder-b", who, role, body])).id;
  const q1 = await msg(c1, U1, "user", "How do I change my logo?");
  const a1 = await msg(c1, U1, "assistant", "Settings > Company > Branding.");
  const a2 = await msg(c1, U1, "assistant", "I'm not sure.");
  const b1 = await msg(c2, U2, "assistant", "Another builder's answer.");

  let rec;
  try { rec = record(await db.exec(MIG())); check(true, "348 applied on top of 340"); }
  catch (e) { check(false, "348 applied on top of 340", e.message); await closeAll(); process.exitCode = 1; return; }
  check(rec && rec.migration === "348" && rec.columns === 7 && rec.triggers === 2 && rec.rated === 0 && rec.gaps === 0 && rec.chats === 2,
    "THE RECORD reads columns 7, triggers 2, rated 0, gaps 0, chats 2", JSON.stringify(rec));
  const cols = (await db.query(`select table_name || '.' || column_name || ':' || data_type as c from information_schema.columns
     where table_schema = 'public' and column_name in ('rating','rating_note','rated_at','gap','up_count','down_count','gap_count') order by 1`)).rows.map((r) => r.c);
  check(same(cols, ["support_conversations.down_count:integer", "support_conversations.gap_count:integer", "support_conversations.up_count:integer",
    "support_messages.gap:text", "support_messages.rated_at:timestamp with time zone", "support_messages.rating:smallint", "support_messages.rating_note:text"]),
    "the seven columns, with their types", JSON.stringify(cols));
  check(same(await tally(db, c1), { up: 0, down: 0, gaps: 0 }), "existing chats start at 0 / 0 / 0");

  // ── 2. The tallies ──────────────────────────────────────────────────────────────────────
  await db.query("update public.support_messages set rating = 1, rated_at = now() where id = $1", [a1]);
  check(same(await tally(db, c1), { up: 1, down: 0, gaps: 0 }), "a 👍 counts on its chat");
  await db.query("update public.support_messages set rating = -1, rating_note = 'Wrong page', rated_at = now() where id = $1", [a1]);
  check(same(await tally(db, c1), { up: 0, down: 1, gaps: 0 }), "a 👍 changed to a 👎 moves the count");
  await db.query("update public.support_messages set rating = 1 where id = $1", [a2]);
  check(same(await tally(db, c1), { up: 1, down: 1, gaps: 0 }), "two answers, one of each");
  await db.query("update public.support_messages set rating = null, rating_note = null where id = $1", [a1]);
  check(same(await tally(db, c1), { up: 1, down: 0, gaps: 0 }), "a cleared rating comes off");
  await msg(c1, U1, "assistant", "I don't know that one.", "How to export a price list");
  check(same(await tally(db, c1), { up: 1, down: 0, gaps: 1 }), "an answer with a gap note counts as didn't know");
  await db.query("update public.support_messages set gap = 'Exporting a price list' where id = $1", [a2]);
  check(same(await tally(db, c1), { up: 1, down: 0, gaps: 2 }), "a gap set later counts too");
  check(same(await tally(db, c2), { up: 0, down: 0, gaps: 0 }), "another chat's numbers never move");
  await db.query("update public.support_messages set body = body where id = $1", [b1]);
  check(same(await tally(db, c2), { up: 0, down: 0, gaps: 0 }), "an edit that touches no rating or gap leaves the tally alone");

  // ── 3. Refusals ─────────────────────────────────────────────────────────────────────────
  check(await refused(db, "update public.support_messages set rating = 1 where id = $1", [q1]), "a rating on the builder's own words is refused");
  check(await refused(db, "update public.support_messages set gap = 'x' where id = $1", [q1]), "a gap on the builder's own words is refused");
  check(await refused(db, "update public.support_messages set rating = 2 where id = $1", [a1]), "a rating of 2 is refused");
  check(await refused(db, "update public.support_messages set rating = 0 where id = $1", [a1]), "a rating of 0 is refused (cleared is NULL)");
  check(await refused(db, "update public.support_messages set rating = -1, rating_note = repeat('x', 301) where id = $1", [a1]), "a note over 300 characters is refused");
  check(await refused(db, "update public.support_messages set gap = repeat('x', 301) where id = $1", [a1]), "a gap over 300 characters is refused");
  check(await refused(db, "update public.support_messages set rating_note = 'x' where id = $1 and role = 'user'", [q1]), "a note on the builder's own words is refused");

  // ── 4. Still service-role only ──────────────────────────────────────────────────────────
  const priv = await one(db, `select
      has_table_privilege('anon', 'public.support_messages', 'select') or has_table_privilege('authenticated', 'public.support_messages', 'select')
      or has_table_privilege('anon', 'public.support_messages', 'update') or has_table_privilege('authenticated', 'public.support_messages', 'update')
      or has_table_privilege('anon', 'public.support_conversations', 'select') or has_table_privilege('authenticated', 'public.support_conversations', 'select') as open,
      (select count(*)::int from pg_policies where tablename in ('support_messages', 'support_conversations')) as policies`);
  check(priv.open === false && priv.policies === 0, "no browser role reaches either table; no policy", JSON.stringify(priv));
  const fnPriv = await one(db, "select has_function_privilege('anon', 'public.support_message_tally()', 'execute') as anon");
  check(fnPriv.anon === false, "the tally function is not the browser's");

  // ── 5. Re-apply, rollback, apply again ──────────────────────────────────────────────────
  const beforeRe = [await tally(db, c1), (await one(db, "select count(*)::int as n from public.support_messages where rating is not null")).n];
  rec = record(await db.exec(MIG()));
  check(same([await tally(db, c1), (await one(db, "select count(*)::int as n from public.support_messages where rating is not null")).n], beforeRe)
    && rec.rated === 1 && rec.gaps === 2, "a re-apply keeps every rating and count", JSON.stringify(rec));
  await db.exec(ROLLBACK);
  const left = await one(db, `select count(*)::int as n from information_schema.columns where table_schema = 'public'
     and column_name in ('rating','rating_note','rated_at','gap','up_count','down_count','gap_count')`);
  const trig = await one(db, "select count(*)::int as n from pg_trigger where tgname like 'support_messages_tally_%'");
  check(left.n === 0 && trig.n === 0, "the header's ROLLBACK takes every column and trigger off", JSON.stringify({ left, trig }));
  check((await one(db, "select count(*)::int as n from public.support_messages")).n === 5, "…and keeps every message");
  rec = record(await db.exec(MIG()));
  check(rec.columns === 7 && rec.triggers === 2, "the file applies again after the rollback", JSON.stringify(rec));

  // ── 6. A mutant without its triggers aborts, leaving nothing ────────────────────────────
  const mut = await fresh();
  const broken = MIG().replace(/create trigger support_messages_tally_upd[\s\S]*?execute function public\.support_message_tally\(\);/, "");
  check(broken !== MIG(), "the mutant differs from the file");
  let msgErr = "";
  try { await mut.exec(broken); } catch (e) { msgErr = String(e.message); }
  await mut.exec("rollback;").catch(() => {});
  const mutLeft = await one(mut, `select count(*)::int as n from information_schema.columns where table_schema = 'public' and column_name in ('rating','gap','up_count')`);
  check(/348 did not apply cleanly/.test(msgErr) && mutLeft.n === 0, "a file without its tally triggers aborts and leaves no column behind", msgErr || JSON.stringify(mutLeft));

  await closeAll();
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = fails ? 1 : 0;
})().catch(async (e) => { console.error(e); await closeAll(); process.exitCode = 1; });
