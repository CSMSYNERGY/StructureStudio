// Execute migration 262 for real in PGlite (Postgres compiled to WASM, in memory) on top of
// email_sends and 261's broadcast trigger as they are live, then check what it promises: an open
// column and a count that start empty, record_email_event applying each of Resend's five events
// once per event id (a retry or a replay changes nothing), the earliest time kept, a bounce that a
// late delivery cannot undo, opens that stop counting at 25, a complaint kept apart from a bounce,
// a send that failed after Resend accepted it marked failed (and only while it read sent),
// an unknown email id that writes nothing, an open reaching the phone
// through 261's trigger, nothing the browser roles can read or call, a probe that leaves nothing
// behind, a harmless re-apply, and assertions and a probe that really abort a broken copy
// (mutants). Nothing here touches the live project: no network, no Supabase, no email.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration262.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/262_email_opens.sql"), "utf8");

// phone_realtime_notify as 261 left it (PART 2), lifted from the file rather than copied, and the
// email_sends trigger PART 3 hangs on it.
function live261() {
  const s = fs.readFileSync(path.join(WT, "supabase/migrations/261_phone_email_thread.sql"), "utf8").replace(/\r\n/g, "\n");
  const a = s.indexOf("create or replace function public.phone_realtime_notify()\nreturns trigger");
  const b = s.indexOf("comment on function public.phone_realtime_notify()", a);
  if (a < 0 || b < 0) throw new Error("could not lift 261 PART 2 — re-point live261()");
  return s.slice(a, b) + `
drop trigger if exists email_sends_phone_realtime on public.email_sends;
create trigger email_sends_phone_realtime
  after insert or update on public.email_sends
  for each row execute function public.phone_realtime_notify();
`;
}

// realtime.send verbatim from the live project (as tests/sql/migration261.test.cjs has it).
const REALTIME_SEND = `
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
 returns void language plpgsql as $function$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();
    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$function$;
`;

// The live shapes (information_schema / pg_constraint / pg_indexes on 2026-10-04), cut to what 262
// and the trigger touch. email_sends is whole: its column list is the point.
const STUBS = (grantBrowser) => `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema realtime;
grant usage on schema public, realtime to anon, authenticated, service_role;

-- The live default ACLs: the trap every new table and function falls into.
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant select, maintain on tables to anon;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table realtime.messages (
  topic text not null, extension text not null, payload jsonb, event text,
  private boolean default false, updated_at timestamp not null default now(),
  inserted_at timestamp not null default now(), id uuid not null default gen_random_uuid(),
  binary_payload bytea,
  primary key (id, inserted_at)
) partition by range (inserted_at);

create table public.client_settings (
  client_id text primary key, business_name text, phone_status text not null default 'off'
);
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(), client_id text not null, owner_user_id uuid
);
create table public.designs (
  id uuid primary key default gen_random_uuid(), short_code text not null unique, client_id text not null, contact_id uuid
);

-- 107 + 113 + 124/134/167 (kind) + 134 (contact_id) + 261, RLS on, browser roles revoked.
create table public.email_sends (
  id uuid primary key default gen_random_uuid(), client_id text not null, short_code text,
  kind text not null, to_email text not null, intended_email text, from_email text not null, subject text,
  status text not null default 'claimed', error text, postmark_message_id text, delivered_at timestamptz,
  bounced_at timestamptz, bounce_reason text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), provider_message_id text, contact_id uuid,
  body_text text, sent_by uuid, client_temp_id text,
  constraint email_sends_kind_check check (kind = any (array['estimate','invoice','test','acceptance','change_order','conversation','login_code'])),
  constraint email_sends_status_check check (status = any (array['claimed','sent','failed','delivered','bounced'])),
  constraint email_sends_body_text_chk check (body_text is null or char_length(body_text) <= 20000),
  constraint email_sends_client_temp_id_chk check (client_temp_id is null or char_length(client_temp_id) <= 64)
);
create index email_sends_provider_message_id_idx on public.email_sends (provider_message_id) where provider_message_id is not null;
alter table public.email_sends enable row level security;
revoke all on public.email_sends from anon, authenticated;
${grantBrowser ? "grant select on public.email_sends to anon;" : ""}
`;

// The data the apply has to live with: rows sent before 262, one of them on a contact whose
// tenant has the phone switched on.
const SEED = `
insert into public.client_settings (client_id, business_name, phone_status) values ('demo-tenant', 'Demo Sheds', 'on');
insert into public.crm_contacts (id, client_id, owner_user_id) values
  ('00000000-0000-4000-8000-0000000000c1', 'demo-tenant', '00000000-0000-4000-8000-000000000001');
insert into public.email_sends (client_id, kind, to_email, from_email, subject, status, provider_message_id)
  select 'demo-tenant', 'estimate', 'cam@example.test', 'info@example.test', 'Quote ' || g, 'sent', 'rs-old-' || g
    from generate_series(1, 4) g;
insert into public.email_sends (id, client_id, contact_id, kind, to_email, from_email, subject, status, provider_message_id, sent_by) values
  ('00000000-0000-4000-8000-0000000000e1', 'demo-tenant', '00000000-0000-4000-8000-0000000000c1', 'conversation',
   'cam@example.test', 'info@example.test', 'Your shed', 'sent', 'rs-live-1', '00000000-0000-4000-8000-000000000002');
`;

const SEND = "00000000-0000-4000-8000-0000000000e1";
const FN = "public.record_email_event(text, text, timestamptz, text, text)";

async function makeDb({ grantBrowser = false, with261 = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS(grantBrowser));
  await db.exec(REALTIME_SEND);
  if (with261) await db.exec(live261());
  await db.exec(SEED);
  await db.exec(`do $$ begin execute format(
    'create table realtime.messages_probe partition of realtime.messages for values from (%L) to (%L)',
    current_date - 1, current_date + 2); end $$;`);
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

(async () => {
  console.log("migration 262: applies on the live shape");
  const db = await makeDb();
  let notices = [];
  try { notices = await apply(db); ok(true, "262 applied cleanly, assertions and probe included"); }
  catch (e) { ok(false, "262 applied", e.message); process.exit(1); }
  ok(notices.some((n) => /262 probe: deliveries, opens, bounces, complaints and failures recorded once each/.test(n)), "the probe ran and rolled back", notices.join(" | "));
  const left = await one(db, `select
    (select count(*)::int from public.email_sends where client_id = 'email-opens-probe-262') s,
    (select count(*)::int from public.email_send_events) e,
    (select count(*)::int from realtime.messages) m`);
  ok(left.s === 0 && left.e === 0 && left.m === 0, "the probe left nothing behind, and told no phone anything", JSON.stringify(left));

  const cols = (await db.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'email_sends' and column_name in ('complained_at','opened_at','open_count') order by 1`)).rows;
  ok(cols.length === 3 && cols[0].column_name === "complained_at" && cols[0].data_type === "timestamp with time zone" && cols[0].is_nullable === "YES"
    && cols[1].column_name === "open_count" && cols[1].is_nullable === "NO" && cols[1].column_default === "0"
    && cols[2].data_type === "timestamp with time zone" && cols[2].is_nullable === "YES",
    "complained_at and opened_at nullable, open_count not null default 0", JSON.stringify(cols));
  const pre = await one(db, "select count(*)::int n, bool_and(opened_at is null and open_count = 0 and complained_at is null) fresh from public.email_sends");
  ok(pre.n === 5 && pre.fresh, "the five rows from before 262 start unopened and unreported", JSON.stringify(pre));

  let again = true;
  try { await apply(db); } catch (e) { again = false; ok(false, "re-apply", e.message); }
  ok(again, "a second apply is harmless");

  console.log(" record_email_event, as the service role (postmark-events)");
  const rec = async (pid, ev, at, reason, id) => {
    await db.exec("set role service_role");
    try {
      return (await db.query(`select ${FN.replace(/\(.*/, "")}($1, $2, $3::timestamptz, $4, $5) r`, [pid, ev, at, reason, id])).rows[0].r;
    } finally { await db.exec("reset role"); }
  };
  const row = () => one(db, "select status, delivered_at, opened_at, open_count, bounced_at, bounce_reason from public.email_sends where id = $1", [SEND]);
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const broadcasts = async () => (await db.query("select topic, event, payload from realtime.messages where payload ->> 'id' = $1 order by topic", [SEND])).rows;

  ok(await rec("rs-live-1", "delivered", "2026-10-04T12:00:00Z", null, "msg_d1") === "recorded", "a delivery is recorded");
  ok(await rec("rs-live-1", "delivered", "2026-10-04T12:30:00Z", null, "msg_d1") === "duplicate", "the same event id again is a duplicate");
  let r = await row();
  ok(r.status === "delivered" && iso(r.delivered_at) === "2026-10-04T12:00:00.000Z", "sent → delivered, at the event's time, untouched by the replay", JSON.stringify(r));

  await db.exec("delete from realtime.messages");
  ok(await rec("rs-live-1", "opened", "2026-10-04T14:00:00Z", null, "msg_o1") === "recorded", "an open is recorded");
  const told = await broadcasts();
  ok(told.length === 3 && told.every((b) => b.event === "email" && b.payload.op === "UPDATE" && b.payload.contact_id === "00000000-0000-4000-8000-0000000000c1"
    && Object.keys(b.payload).sort().join() === "contact_id,id,op,table"),
    "the open reaches the phone through 261's trigger: team, owner and writer, ids only", JSON.stringify(told.map((b) => b.topic)));
  ok(await rec("rs-live-1", "opened", "2026-10-04T13:00:00Z", null, "msg_o2") === "recorded", "a second open (arriving late, but earlier) is recorded");
  ok(await rec("rs-live-1", "opened", "2026-10-04T14:00:00Z", null, "msg_o1") === "duplicate", "a retried open is a duplicate");
  r = await row();
  ok(r.open_count === 2 && iso(r.opened_at) === "2026-10-04T13:00:00.000Z" && r.status === "delivered",
    "two opens counted once each, the earliest time kept, status left at delivered", JSON.stringify(r));
  await rec("rs-live-1", "opened", "2026-10-04T15:00:00Z", null, null);
  ok((await row()).open_count === 3, "an event with no id still counts (it simply has no replay protection)");

  ok(await rec("rs-live-1", "bounced", "2026-10-04T16:00:00Z", "Permanent/General: mailbox does not exist", "msg_b1") === "recorded", "a bounce is recorded");
  ok(await rec("rs-live-1", "delivered", "2026-10-04T16:05:00Z", null, "msg_d2") === "recorded", "a late delivery is recorded");
  r = await row();
  ok(r.status === "bounced" && iso(r.bounced_at) === "2026-10-04T16:00:00.000Z" && r.bounce_reason === "Permanent/General: mailbox does not exist"
    && iso(r.delivered_at) === "2026-10-04T12:00:00.000Z", "the bounce stands; the late delivery keeps the earliest delivered_at", JSON.stringify(r));

  // A complaint is NOT a bounce: the email arrived (often it was opened first). It is kept in
  // complained_at, the earliest seen, and the status and bounce fields do not move.
  ok(await rec("rs-old-1", "delivered", "2026-10-04T16:50:00Z", null, "msg_c0") === "recorded", "the complained-about email was delivered first");
  ok(await rec("rs-old-1", "complained", "2026-10-04T17:00:00Z", null, "msg_c1") === "recorded", "a complaint is recorded");
  ok(await rec("rs-old-1", "complained", "2026-10-04T16:55:00Z", null, "msg_c2") === "recorded", "a second report (arriving late, but earlier) is recorded");
  const c = await one(db, "select status, bounced_at, bounce_reason, complained_at from public.email_sends where provider_message_id = 'rs-old-1'");
  ok(c.status === "delivered" && c.bounced_at === null && c.bounce_reason === null && iso(c.complained_at) === "2026-10-04T16:55:00.000Z",
    "a complaint is recorded as complained, not bounced: still delivered, no bounce fields, the earliest report kept", JSON.stringify(c));

  ok(await rec("rs-nobody", "opened", "2026-10-04T12:00:00Z", null, "msg_x1") === "unknown", "an email id nobody sent is unknown");
  ok(await rec("", "opened", "2026-10-04T12:00:00Z", null, "msg_x2") === "unknown", "an empty email id is unknown");
  ok((await one(db, "select count(*)::int n from public.email_send_events where event_id in ('msg_x1','msg_x2')")).n === 0, "and neither kept its event id");
  let refused = null;
  try { await rec("rs-live-1", "clicked", "2026-10-04T12:00:00Z", null, "msg_k1"); } catch (e) { refused = e; }
  ok(!!refused && /unknown event/.test(refused.message), "an event type it does not know is refused", refused && refused.message);
  const kinds = (await db.query("select event, count(*)::int n from public.email_send_events group by 1 order by 1")).rows;
  ok(JSON.stringify(kinds) === JSON.stringify([{ event: "bounced", n: 1 }, { event: "complained", n: 2 }, { event: "delivered", n: 3 }, { event: "opened", n: 2 }]),
    "email_send_events holds each applied id once", JSON.stringify(kinds));

  // email.failed: Resend accepted the email (the row reads 'sent'), then could not send it. The
  // row says failed, with the reason in `error`, and a late delivery does not undo it. A row that
  // already has a better answer (a bounce here) is left alone. (email.suppressed arrives as a
  // bounce, mapped in postmark-events.)
  ok(await rec("rs-old-3", "failed", "2026-10-04T18:00:00Z", "Not sent: reached_daily_quota", "msg_f1") === "recorded", "a failure after acceptance is recorded");
  ok(await rec("rs-old-3", "failed", "2026-10-04T18:00:00Z", "Not sent: reached_daily_quota", "msg_f1") === "duplicate", "and its retry is a duplicate");
  ok(await rec("rs-old-3", "delivered", "2026-10-04T18:01:00Z", null, "msg_f2") === "recorded", "a late delivery for it is recorded");
  const f = await one(db, "select status, error, bounced_at from public.email_sends where provider_message_id = 'rs-old-3'");
  ok(f.status === "failed" && f.error === "Not sent: reached_daily_quota" && f.bounced_at === null,
    "sent → failed with the reason, not a bounce, and the late delivery does not undo it", JSON.stringify(f));
  ok(await rec("rs-live-1", "failed", "2026-10-04T18:05:00Z", "Not sent: late", "msg_f3") === "recorded", "a failure for a row that already bounced is recorded");
  const fb = await one(db, "select status, error from public.email_sends where id = $1", [SEND]);
  ok(fb.status === "bounced" && fb.error === null, "and leaves the bounce as it was", JSON.stringify(fb));

  // Anyone with the email can fetch its tracking image in a loop, each fetch a fresh event id.
  // On a contact, so an open that IS recorded reaches the phone and the "tells no phone" check
  // below is not vacuous.
  const capId = (await one(db, `update public.email_sends set contact_id = '00000000-0000-4000-8000-0000000000c1'
    where provider_message_id = 'rs-old-2' returning id`)).id;
  const capAnswers = [];
  let toldBefore = 0;
  for (let i = 1; i <= 30; i++) {
    if (i === 26) {
      toldBefore = (await one(db, "select count(*)::int n from realtime.messages where payload ->> 'id' = $1", [capId])).n;
      await db.exec("delete from realtime.messages");
    }
    // The capped five arrive with EARLIER times: a capped open must not move opened_at either.
    const at = i <= 25 ? `2026-10-04T12:${String(i).padStart(2, "0")}:00Z` : `2026-10-04T11:${String(i).padStart(2, "0")}:00Z`;
    capAnswers.push(await rec("rs-old-2", "opened", at, null, `msg_cap_${i}`));
  }
  const cap = await one(db, `select e.open_count, e.opened_at,
    (select count(*)::int from public.email_send_events v where v.email_send_id = e.id and v.event = 'opened') ev,
    (select count(*)::int from realtime.messages m where m.payload ->> 'id' = e.id::text) told
    from public.email_sends e where e.id = $1`, [capId]);
  ok(capAnswers.slice(0, 25).every((a) => a === "recorded") && capAnswers.slice(25).every((a) => a === "capped"),
    "30 opens: the first 25 are recorded, the last 5 answer capped", JSON.stringify(capAnswers.slice(23)));
  ok(cap.open_count === 25 && cap.ev === 25 && iso(cap.opened_at) === "2026-10-04T12:01:00.000Z",
    "opens stop at 25: count 25, 25 event rows, the earliest counted time kept", JSON.stringify(cap));
  ok(toldBefore > 0 && cap.told === 0, "a recorded open reaches the phone; a capped one tells no phone anything", JSON.stringify({ toldBefore, ...cap }));
  ok(await rec("rs-old-2", "opened", "2026-10-04T13:00:00Z", null, "msg_cap_26") === "capped", "a retry of a capped open is capped too, still nothing written");
  ok(await rec("rs-old-2", "delivered", "2026-10-04T12:00:30Z", null, "msg_cap_d") === "recorded", "the cap is for opens only: a delivery still records");

  console.log(" grants");
  const priv = await one(db, `select
    has_function_privilege('anon', '${FN}', 'EXECUTE') fa, has_function_privilege('authenticated', '${FN}', 'EXECUTE') fu,
    has_function_privilege('service_role', '${FN}', 'EXECUTE') fs,
    has_table_privilege('anon', 'public.email_send_events', 'SELECT') ea, has_table_privilege('authenticated', 'public.email_send_events', 'SELECT') eu,
    has_column_privilege('authenticated', 'public.email_sends', 'opened_at', 'SELECT') cu,
    has_column_privilege('anon', 'public.email_sends', 'complained_at', 'SELECT') ca`);
  ok(!priv.fa && !priv.fu && priv.fs, "only the service role can call record_email_event", JSON.stringify(priv));
  ok(!priv.ea && !priv.eu && !priv.cu && !priv.ca, "the browser roles cannot read the events, the opens or the complaints", JSON.stringify(priv));
  let denied = null;
  try { await db.exec(`set role authenticated; select ${FN.replace(/\(.*/, "")}('rs-live-1', 'opened', now(), null, 'msg_evil');`); } catch (e) { denied = e; }
  try { await db.exec("reset role"); } catch (_e) { /* not in a role */ }
  ok(!!denied && /permission denied/.test(denied.message), "a signed-in browser cannot record an open", denied && denied.message);
  await db.close();

  console.log("migration 262: the assertions abort the whole migration");
  {
    const db2 = await makeDb({ grantBrowser: true });
    let err = null;
    try { await apply(db2); } catch (e) { err = e; }
    ok(!!err && /262: anon holds SELECT on email_sends/.test(err.message), "a browser-readable email_sends stops the apply", err && err.message);
    try { await db2.exec("rollback"); } catch (_e) { /* already rolled back */ }
    const n = await one(db2, "select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'email_sends' and column_name = 'opened_at'");
    ok(n.n === 0, "and nothing of it is left behind", JSON.stringify(n));
    await db2.close();
  }
  {
    const db3 = await makeDb({ with261: false });
    let err = null;
    try { await apply(db3); } catch (e) { err = e; }
    ok(!!err && /apply 261 first/.test(err.message), "without 261's trigger the apply stops (an open would never reach the phone)", err && err.message);
    await db3.close();
  }

  console.log("migration 262: broken copies are refused");
  const src = MIG_TEXT().replace(/\r\n/g, "\n");
  const mutants = [
    ["a replay counts again", "    if not found then\n      return 'duplicate';\n    end if;", "    null;"],
    ["the latest open time wins", "set opened_at  = least(opened_at, v_at),", "set opened_at  = v_at,"],
    ["the first open to arrive wins", "set opened_at  = least(opened_at, v_at),", "set opened_at  = coalesce(opened_at, v_at),"],
    ["a late delivery undoes a bounce", "status       = case when status in ('claimed', 'sent') then 'delivered' else status end,", "status       = 'delivered',"],
    ["opens are not counted", "open_count = open_count + 1,", "open_count = open_count,"],
    ["opens are never capped", "if p_event = 'opened' and v_opens >= 25 then", "if false then"],
    ["a complaint is filed as a bounce", "       set complained_at = least(complained_at, v_at),\n", "       set complained_at = least(complained_at, v_at),\n           status        = 'bounced',\n"],
    ["the latest complaint time wins", "set complained_at = least(complained_at, v_at),", "set complained_at = v_at,"],
    ["the first complaint to arrive wins", "set complained_at = least(complained_at, v_at),", "set complained_at = coalesce(complained_at, v_at),"],
    ["a failure is not recorded", "       set status     = 'failed',\n", "       set status     = status,\n"],
    ["a failure undoes a delivery", "     where id = v_id\n       and status in ('claimed', 'sent');", "     where id = v_id;"],
    ["the events table is readable from the browser", "revoke all on public.email_send_events from public, anon, authenticated;", "grant select on public.email_send_events to anon;"],
    ["the function is callable from the browser", "revoke execute on function public.record_email_event(text, text, timestamptz, text, text) from public, anon, authenticated;", ""],
    ["the function runs as its owner", "security invoker\nset search_path = ''", "security definer\nset search_path = ''"],
    ["an unknown event type is accepted", "raise exception 'record_email_event: unknown event %', p_event using errcode = '22023';", "return 'unknown';"],
  ];
  for (const [label, from, to] of mutants) {
    if (!src.includes(from)) { ok(false, `mutant "${label}": anchor not found — re-point it`); continue; }
    const mdb = await makeDb();
    let err = null;
    try { await apply(mdb, src.replace(from, to)); } catch (e) { err = e; }
    ok(!!err && /262/.test(err.message), `refused: ${label}`, err ? err.message.slice(0, 160) : "applied cleanly");
    await mdb.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e); process.exit(1); });
