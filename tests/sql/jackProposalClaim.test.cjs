// The double-press guard, on Postgres (PGlite: Postgres compiled to WASM, in memory). Approve and Undo
// claim a card with ONE conditional UPDATE (jack-agent/handler.ts makeStore.updateProposal: .eq id,
// .eq client_id, .in status, and .eq updated_at for a give-up and an Approve), and only the press that gets the row back
// runs anything (agent.ts handleProposalApprove, approvePiece, handleProposalUndo). Until 11-09 only
// in-memory fakes ran that claim. Here it runs on jack_proposals as migrations 375-378 make it:
//   * two presses that both read the card while it was ready: the first claim gets the row, the second
//     gets none, and the row names the first presser;
//   * two claims sent at once: exactly one row comes back;
//   * a claim on a ready card nobody wrote since lands once;
//   * another builder's claim on the row claims nothing;
//   * Undo's claim (applied to undoing) lands once;
//   * a give-up write lands only on the row as it was read, compared by the updated_at text PostgREST
//     hands back (microseconds included);
//   * an Approve claim lands only on the row as it was read too (11-09): a card written since isn't
//     claimed from the older read.
// The hash a press echoes is checked in agent.ts handleProposalApprove, before any claim, not in this SQL:
// the UPDATE matches on id, client_id, status and updated_at only. That check runs against the real handler
// in agent_test.ts ("a proposal changes nothing": a wrong hash, and one off by case or a space),
// inventory_test.ts and rules_test.ts; the source pin below keeps it before the claim. (Until 11-09 this
// file also "tested" it through a copy of the check written here, which proved nothing about agent.ts.)
// Nothing here touches the live project: no network, no Supabase.
//
// Run (from the repo root):
//   npm install --prefix tests/sql            once (@electric-sql/pglite only)
//   node tests/sql/jackProposalClaim.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG = (f) => fs.readFileSync(path.join(WT, "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n");

function areaLevelFrom326() {
  const s = MIG("326_meetings.sql");
  const a = s.indexOf("create or replace function public.area_level_for(");
  const b = s.indexOf("$fn$;", a) + 5;
  if (a < 0 || b < 5) throw new Error("326's area_level_for anchor moved");
  return s.slice(a, b);
}

let failed = 0;
function check(name, ok, note) {
  if (ok) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}${note ? "   [" + note + "]" : ""}`); }
}

const A = "builder-a", B = "builder-b";
const U1 = "00000000-0000-4000-8000-000000000001", U2 = "00000000-0000-4000-8000-000000000002";
const JSONB = new Set(["source", "preview", "payload", "answers", "result", "undo"]);

(async () => {
  const db = new PGlite();
  // The project's database runs in UTC, so PostgREST's timestamps end in +00:00.
  await db.exec("set timezone = 'UTC'");
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  // The stand-in tables 375-378 touch, as migration376.test.cjs makes them.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create table public.client_settings (client_id text primary key);
    create table public.usage_prices (
      kind text primary key, label text, unit_label text, price_cents integer not null default 0 check (price_cents >= 0),
      active boolean not null default false, visible boolean not null default true, sort_order integer, note text,
      pricing text not null default 'fixed' check (pricing in ('fixed', 'cost_plus'))
    );
    create function public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text) returns void language sql as $$ select $$;
    create function public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text) returns bigint language sql as $$ select 0::bigint $$;
    revoke execute on function public.wallet_usage_debit(text, text, bigint, bigint, text, text, text, jsonb, text) from public, anon, authenticated;
    revoke execute on function public.wallet_credit(text, bigint, text, text, text, text, text, uuid, text) from public, anon, authenticated;
    create table public.setup_template_items (id uuid primary key default gen_random_uuid(), title text not null, active boolean not null default true, position integer not null default 0,
      account_type text not null default 'all' check (account_type in ('all', 'sheds', 'smartbuild')));
    create table public.tenant_setup_items (
      id uuid primary key default gen_random_uuid(), client_id text not null, template_item_id uuid,
      completed_at timestamptz, completed_by uuid
    );
    create table public.sms_messages (client_id text, contact_id uuid, created_at timestamptz, direction text, status text);
    create table public.email_inbound (client_id text, contact_id uuid, received_at timestamptz);
    create table public.email_sends (client_id text, contact_id uuid, created_at timestamptz, kind text, status text);
    create table public.phone_calls (id uuid primary key default gen_random_uuid(), client_id text, contact_id uuid, started_at timestamptz, direction text, answered_at timestamptz, answered_by uuid, status text);
    create table public.phone_voicemails (call_id uuid);
  `);
  await db.exec(areaLevelFrom326());
  let applied = true;
  try {
    for (const f of ["375_jack_agent.sql", "376_jack_v1.sql", "377_jack_v2.sql", "378_jack_sends.sql"]) await db.exec(MIG(f));
  } catch (e) { applied = false; console.log(String(e && e.message)); }
  check("375 to 378 apply", applied);
  if (!applied) { await db.close(); process.exitCode = 1; return; }

  // The statement below is the one handler.ts builds, and the presses claim with it from the statuses
  // they say. Read from the source, so a change there fails here until this file follows it.
  const handler = fs.readFileSync(path.join(WT, "supabase/functions/jack-agent/handler.ts"), "utf8").replace(/\r\n/g, "\n");
  const agent = fs.readFileSync(path.join(WT, "supabase/functions/jack-agent/agent.ts"), "utf8").replace(/\r\n/g, "\n");
  const upd = (() => { const a = handler.indexOf("async updateProposal("); return a < 0 ? "" : handler.slice(a, handler.indexOf("\n    },", a)); })();
  check("handler.ts's updateProposal is the statement mirrored here",
    upd.includes('admin.from("jack_proposals").update({ ...jsonSafe(patch), updated_at: new Date().toISOString() }).eq("id", id).eq("client_id", clientId)')
      && upd.includes('if (whenStatus) q = q.in("status", whenStatus);') && upd.includes('if (whenUpdatedAt) q = q.eq("updated_at", whenUpdatedAt);')
      && upd.includes('await q.select("*")') && upd.includes("return (data && data[0]) ? data[0] as ProposalRow : null;"), upd.slice(0, 120));
  // From ready only, and on the row as it was read and hash-checked (its updated_at, 11-09).
  const approveClaims = [...agent.matchAll(/updateProposal\(who\.clientId, id, \{\n?\s*status: "applying",[^}]*\}, \["ready"\], now\.updated_at\)/g)].length;
  check("both Approve paths claim from ready only, on the row as it was read", approveClaims === 2, String(approveClaims));
  check("Undo claims from the status it read", agent.includes('updateProposal(who.clientId, id, { status: "undoing" }, [stoodAt])'));
  check("a press checks the card's hash against the row as read, before the claim",
    agent.includes('now.shown_hash !== String(payload.hash ?? "")') && agent.indexOf('now.shown_hash !== String(payload.hash ?? "")') < agent.indexOf('status: "applying", approved_by: who.userId'));

  /** makeStore.updateProposal, as PostgREST runs it: set the patch and updated_at, on this id and this
   *  builder, only at one of whenStatus, and with whenUpdatedAt only if nothing wrote the row since. The
   *  rows it answers with; none means the row had moved on. */
  const updateProposal = async (clientId, id, patch, whenStatus, whenUpdatedAt) => {
    const cols = Object.keys(patch);
    const vals = cols.map((c) => (JSONB.has(c) && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c]));
    const params = [...vals, new Date().toISOString(), id, clientId];
    let sql = `update public.jack_proposals set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1}`
      + ` where id = $${cols.length + 2} and client_id = $${cols.length + 3}`;
    if (whenStatus) {
      sql += ` and status in (${whenStatus.map((_, i) => `$${params.length + i + 1}`).join(", ")})`;
      params.push(...whenStatus);
    }
    if (whenUpdatedAt) { params.push(whenUpdatedAt); sql += ` and updated_at = $${params.length}`; }
    return (await db.query(`${sql} returning *, to_json(updated_at) #>> '{}' as updated_at_text`, params)).rows;
  };
  /** makeStore.getProposal: the row, read as PostgREST answers it (updated_at as its JSON text). */
  const getProposal = (clientId, id) => one("select *, to_json(updated_at) #>> '{}' as updated_at_text from public.jack_proposals where id = $1 and client_id = $2", [id, clientId]);
  /** A press's claim. `at` is the updated_at text of the row as that press read it (agent.ts passes
   *  now.updated_at); left out, the claim checks the status alone. */
  const claim = (clientId, id, by, at) => updateProposal(clientId, id, { status: "applying", approved_by: by, approved_by_operator: null, approved_at: new Date().toISOString() }, ["ready"], at);
  const card = async (over = {}) => (await one(
    `insert into public.jack_proposals (client_id, user_id, kind, status, title, shown_hash, payload) values ($1, $2, $3, $4, 'Raise 5%', $5, $6) returning id`,
    [over.client ?? A, U1, over.kind ?? "size_rule", over.status ?? "ready", over.hash ?? "h1", JSON.stringify({ creates: [], sizes: [{ id: "s1" }] })],
  )).id;

  // ── two presses on one card ──
  const p1 = await card();
  const readByFirst = await getProposal(A, p1), readBySecond = await getProposal(A, p1);
  check("both presses read the card while it was ready, with its hash on the row", [readByFirst, readBySecond].every((r) => r.status === "ready" && r.shown_hash === "h1"));
  const first = await claim(A, p1, U1, readByFirst.updated_at_text);
  const second = await claim(A, p1, U2, readBySecond.updated_at_text);
  check("the first claim gets the row, now applying", first.length === 1 && first[0].status === "applying" && first[0].approved_by === U1, JSON.stringify(first.map((r) => r.status)));
  check("the second claim gets no row", second.length === 0, String(second.length));
  const after = await getProposal(A, p1);
  check("the card names the first presser, and only once", after.status === "applying" && after.approved_by === U1);

  // ── two claims at once ──
  const p2 = await card();
  const both = await Promise.all([claim(A, p2, U1), claim(A, p2, U2)]);
  check("two claims sent at once: exactly one gets the row", both.filter((r) => r.length === 1).length === 1 && both.filter((r) => r.length === 0).length === 1, JSON.stringify(both.map((r) => r.length)));

  // ── a ready card nobody wrote since ──
  const p3 = await card({ hash: "h3" });
  const read3 = await getProposal(A, p3);
  const landed3 = await claim(A, p3, U1, read3.updated_at_text);
  check("a claim on a ready card nobody wrote since lands once", landed3.length === 1 && landed3[0].status === "applying" && landed3[0].approved_by === U1);

  // ── another builder ──
  const p4 = await card();
  check("another builder's claim on the row claims nothing", (await claim(B, p4, U2)).length === 0 && (await getProposal(A, p4)).status === "ready");
  check("and another builder can't read it to press", (await getProposal(B, p4)) === undefined);

  // ── Undo's claim ──
  const p5 = await card({ status: "applied" });
  const undo = await Promise.all([updateProposal(A, p5, { status: "undoing" }, ["applied"]), updateProposal(A, p5, { status: "undoing" }, ["applied"])]);
  check("Undo's claim, applied to undoing, lands once", undo.filter((r) => r.length === 1).length === 1 && (await getProposal(A, p5)).status === "undoing");
  check("a card already undoing can't be claimed for Approve", (await claim(A, p5, U1)).length === 0);

  // ── a give-up, on the row as it was read ──
  // PostgREST answers updated_at as its JSON text, microseconds included, and settled() hands that text
  // back as whenUpdatedAt. A stamp with microseconds shows the round trip is exact.
  const STAMP = "2026-11-09 10:00:00.123456+00";
  const stamped = async (id) => { await db.query("update public.jack_proposals set updated_at = $1 where id = $2", [STAMP, id]); return (await getProposal(A, id)).updated_at_text; };
  const p6 = await card({ status: "applying" });
  const seenAt = await stamped(p6);
  check("PostgREST's updated_at text keeps the microseconds", seenAt === "2026-11-09T10:00:00.123456+00:00", seenAt);
  const fresh = await updateProposal(A, p6, { result: { reports: [{ label: "x", status: "error", reason: "progress" }] } }, ["applying"]);
  check("a fresh press's progress write moves updated_at", fresh.length === 1 && fresh[0].updated_at_text !== seenAt);
  const gaveUp = await updateProposal(A, p6, { status: "partly_applied" }, ["applying"], seenAt);
  check("a give-up based on the older read lands nothing", gaveUp.length === 0 && (await getProposal(A, p6)).status === "applying");
  const p7 = await card({ status: "applying" });
  const readAt = await stamped(p7);
  const gaveUpNow = await updateProposal(A, p7, { status: "partly_applied" }, ["applying"], readAt);
  check("a give-up based on the row as it was read, to the microsecond, lands once", gaveUpNow.length === 1 && gaveUpNow[0].status === "partly_applied");
  check("and a second one finds nothing to move", (await updateProposal(A, p7, { status: "partly_applied" }, ["applying"], readAt)).length === 0);

  // ── a claim on the row as it was read (11-09) ──
  // A card written between the press's read and its claim (an answer that worked the preview out again, a
  // give-up) isn't claimed from the older read: the press says it changed, and nothing runs.
  const p8 = await card();
  const readAt8 = await stamped(p8);
  const rewritten = await updateProposal(A, p8, { preview: { counts: { changed: 2 } } }, ["ready"]);
  check("another write lands on the ready card and moves its updated_at", rewritten.length === 1 && rewritten[0].updated_at_text !== readAt8);
  const lateClaim = await claim(A, p8, U1, readAt8);
  const after8 = await getProposal(A, p8);
  check("a claim from the read before that write lands nothing, and the card stays ready", lateClaim.length === 0 && after8.status === "ready" && after8.approved_by === null);
  const freshClaim = await claim(A, p8, U1, after8.updated_at_text);
  check("read again, the card is claimed once, on the row as it is now", freshClaim.length === 1 && freshClaim[0].status === "applying" && freshClaim[0].approved_by === U1);
  const p9 = await card();
  const both9 = await getProposal(A, p9);
  const race9 = await Promise.all([claim(A, p9, U1, both9.updated_at_text), claim(A, p9, U2, both9.updated_at_text)]);
  check("two presses on the same read, at once: exactly one claims it", race9.filter((r) => r.length === 1).length === 1 && race9.filter((r) => r.length === 0).length === 1, JSON.stringify(race9.map((r) => r.length)));

  await db.close();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
