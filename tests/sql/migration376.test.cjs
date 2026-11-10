// Execute migrations 375 and 376 for real in PGlite (Postgres compiled to WASM, in memory), on stand-in
// tables shaped like the live ones 376 touches (read from the live schema 11-06), then check what 376
// promises:
//   * it applies, its proof blocks pass, and a re-apply changes nothing;
//   * jack_memory, Jack's tables, the look-ups function and the marker trigger stay service-role only;
//   * the jack_ai meter ships INACTIVE, cost_plus, x1.5, and the markup check refuses 0.5 and 11;
//   * every card kind the code writes is accepted, and a made-up one is refused; same for charge states;
//   * setup steps get their jack_key by the seed titles and the live ones, never over a key already set;
//   * "done with Jack" needs its card id, and any tick that doesn't set the marker clears it;
//   * crm_contact_touch_facts says when each side last spoke, and counts calls only when asked.
// Then 377 (the record-change kinds) and 378 (the send kinds, the four-kind sweep and sent_with on
// sms_messages and email_sends) on top, each with its own re-apply.
// Nothing here touches the live project: no network, no Supabase.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration376.test.cjs  exit 0 = ALL CHECKS PASSED
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

/** The kinds the code writes: 375's three, and every KindSpec in the pieces (read from the source, so
 *  this test needs no Deno). */
function codeKinds() {
  const dir = path.join(WT, "supabase/functions/jack-agent");
  const out = new Set(["price_sheet", "size_rule", "new_fixture"]);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith("_test.ts")) continue;
    const s = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of s.matchAll(/^\s*\{?\s*kind: "([a-z_]+)",\s*(?:\/\/.*)?$|\{ kind: "([a-z_]+)", areas:/gm)) out.add(m[1] || m[2]);
  }
  return out;
}

let failed = 0;
function check(name, ok, note) {
  if (ok) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}${note ? "   [" + note + "]" : ""}`); }
}
async function refused(db, sql, params) {
  try { await db.query(sql, params); return false; } catch (_e) { return true; }
}

(async () => {
  const db = new PGlite();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    -- What Supabase does to every new table and function in public, so a revoke in 375/376 is really tested.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create table public.client_settings (client_id text primary key);
    create table public.usage_prices (
      kind text primary key, label text, unit_label text, price_cents integer not null default 0 check (price_cents >= 0),
      active boolean not null default false, visible boolean not null default true, sort_order integer, note text,
      pricing text not null default 'fixed' check (pricing in ('fixed', 'cost_plus'))
    );
    insert into public.usage_prices (kind, label, unit_label, price_cents, active, pricing) values ('sms_out', 'Texts', 'text', 0, true, 'cost_plus');
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
  // The seed titles, the live titles, one step an operator wrote, and one key already set by hand.
  await db.exec(`
    insert into public.setup_template_items (title, position) values
      ('Set your password and sign in', 1), ('Add your business details', 2), ('Set up your logo and branding', 3),
      ('Add your sales locations', 4), ('Set where your building serial numbers start', 5), ('Connect GoHighLevel (optional)', 6),
      ('Decide if customers see prices', 7), ('Choose and price your cladding', 8), ('Check your building styles and sizes', 9);
    insert into public.setup_template_items (title, position, account_type) values ('Add your business details', 20, 'smartbuild');
  `);
  await db.exec(areaLevelFrom326());
  await db.exec(MIG("375_jack_agent.sql"));

  let applied = true;
  try { await db.exec(MIG("376_jack_v1.sql")); } catch (e) { applied = false; console.log(String(e && e.message)); }
  check("376 applies on top of 375, and its proof blocks pass", applied);
  if (!applied) { await db.close(); process.exitCode = 1; return; }

  // ── the meter ──
  const m = await one("select active, pricing, markup::text as markup, price_cents from public.usage_prices where kind = 'jack_ai'");
  check("the jack_ai meter ships inactive, cost_plus, x1.5", m && m.active === false && m.pricing === "cost_plus" && m.markup === "1.500" && m.price_cents === 0, JSON.stringify(m));
  check("the phone meters' markup stays null", (await one("select markup from public.usage_prices where kind = 'sms_out'")).markup === null);
  check("a markup under 1 is refused", await refused(db, "update public.usage_prices set markup = 0.5 where kind = 'jack_ai'"));
  check("a markup over 10 is refused", await refused(db, "update public.usage_prices set markup = 11 where kind = 'jack_ai'"));

  // ── who can reach what ──
  const priv = async (role, obj, what) => (await one(`select has_table_privilege($1, $2, $3) as v`, [role, obj, what])).v;
  const fpriv = async (role, fn) => (await one(`select has_function_privilege($1, $2, 'execute') as v`, [role, fn])).v;
  for (const role of ["anon", "authenticated"]) {
    check(`${role} can't read jack_memory`, !(await priv(role, "public.jack_memory", "select")));
    check(`${role} can't write jack_memory`, !(await priv(role, "public.jack_memory", "insert")));
    check(`${role} can't run crm_contact_touch_facts`, !(await fpriv(role, "public.crm_contact_touch_facts(text, uuid[], boolean)")));
  }
  check("the service role can run crm_contact_touch_facts", await fpriv("service_role", "public.crm_contact_touch_facts(text, uuid[], boolean)"));
  check("the service role holds jack_memory", await priv("service_role", "public.jack_memory", "insert"));

  // ── kinds and charge states ──
  const U = "00000000-0000-4000-8000-000000000001";
  // The v1 kinds: what 376's own constraint lists (377 adds v2's; jack-agent kinds_test.ts matches the
  // newest list to the code). The code scan only proves those v1 kinds are still written somewhere.
  const kinds376 = (() => {
    const s = MIG("376_jack_v1.sql");
    const a = s.indexOf("add constraint jack_proposals_kind_check check (kind in (");
    return new Set([...s.slice(a, s.indexOf("));", a)).replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  })();
  const inCode = codeKinds();
  const kinds = new Set([...kinds376].filter((k) => inCode.has(k)));
  check("376 lists the 15 v1 kinds, and the code still writes each", kinds376.size === 15 && kinds.size === 15, [...kinds376].join(","));
  for (const k of kinds) {
    const ok = !(await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, $2, 'ready', 'x')", [U, k]));
    check(`kind ${k} is accepted`, ok);
  }
  check("a made-up kind is refused", await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'contact', 'ready', 'x')", [U]));
  const p1 = (await one("select id from public.jack_proposals where kind = 'lookup'")).id;
  check("every charge state billing.ts writes is accepted", !(await refused(db, `
    do $t$ declare s text; begin
      foreach s in array array['shadow','pending','charged','exempt','not_billable','failed'] loop
        update public.jack_proposals set charge_state = s, charge_micros = 10 where id = '${p1}';
      end loop;
    end $t$;`)));
  check("a made-up charge state is refused", await refused(db, "update public.jack_proposals set charge_state = 'free' where id = $1", [p1]));
  check("a negative charge is refused", await refused(db, "update public.jack_proposals set charge_micros = -1 where id = $1", [p1]));

  // ── memory ──
  await db.query("insert into public.jack_memory (client_id, key, value) values ('a', 'quote_quiet_days', '14'::jsonb)");
  check("a memory key that isn't snake case is refused", await refused(db, "insert into public.jack_memory (client_id, key, value) values ('a', 'Quote Days', '1'::jsonb)"));
  check("one value per key per builder", await refused(db, "insert into public.jack_memory (client_id, key, value) values ('a', 'quote_quiet_days', '7'::jsonb)"));

  // ── setup keys ──
  const keyOf = async (title) => (await one("select jack_key from public.setup_template_items where title = $1 and account_type = 'all'", [title])).jack_key;
  check("a seed title gets its key", (await keyOf("Decide if customers see prices")) === "show_prices");
  check("the live business step gets business", (await keyOf("Add your business details")) === "business");
  check("the live logo step gets logo", (await keyOf("Set up your logo and branding")) === "logo");
  check("the live lots step gets locations", (await keyOf("Add your sales locations")) === "locations");
  check("the live serial step gets serial", (await keyOf("Set where your building serial numbers start")) === "serial");
  check("the live GoHighLevel step gets crm", (await keyOf("Connect GoHighLevel (optional)")) === "crm");
  check("an operator's own step has no key", (await keyOf("Choose and price your cladding")) === null);
  check("a key is used once per account shape", await refused(db, "update public.setup_template_items set jack_key = 'business' where title = 'Choose and price your cladding'"));
  check("the SmartBuild copy of a step gets the same key on its own list",
    (await one("select jack_key from public.setup_template_items where title = 'Add your business details' and account_type = 'smartbuild'")).jack_key === "business");
  check("a key must be snake case", await refused(db, "update public.setup_template_items set jack_key = 'Bad Key' where title = 'Choose and price your cladding'"));

  // ── done with Jack ──
  const step = (await one("insert into public.tenant_setup_items (client_id) values ('a') returning id")).id;
  check("a marker with no card is refused", await refused(db, "update public.tenant_setup_items set completed_at = now(), completed_via = 'jack' where id = $1", [step]));
  check("a marker that isn't jack is refused", await refused(db, "update public.tenant_setup_items set completed_at = now(), completed_via = 'robot', completed_proposal_id = $2 where id = $1", [step, p1]));
  await db.query("update public.tenant_setup_items set completed_at = now(), completed_via = 'jack', completed_proposal_id = $2 where id = $1", [step, p1]);
  let r = await one("select completed_via, completed_proposal_id from public.tenant_setup_items where id = $1", [step]);
  check("Jack's tick keeps its marker", r.completed_via === "jack" && r.completed_proposal_id === p1);
  await db.query("update public.tenant_setup_items set completed_by = $2 where id = $1", [step, U]);
  r = await one("select completed_via from public.tenant_setup_items where id = $1", [step]);
  check("an update that doesn't touch the tick leaves the marker", r.completed_via === "jack");
  await db.query("update public.tenant_setup_items set completed_at = null where id = $1", [step]);
  r = await one("select completed_via, completed_proposal_id from public.tenant_setup_items where id = $1", [step]);
  check("an untick that doesn't mention the marker clears it", r.completed_via === null && r.completed_proposal_id === null);
  await db.query("update public.tenant_setup_items set completed_at = now(), completed_via = 'jack', completed_proposal_id = $2 where id = $1", [step, p1]);
  await db.query("update public.tenant_setup_items set completed_at = now() - interval '1 minute' where id = $1", [step]);
  r = await one("select completed_via from public.tenant_setup_items where id = $1", [step]);
  check("an operator's re-tick clears it too", r.completed_via === null);

  // ── when each side last spoke ──
  const C1 = "10000000-0000-4000-8000-000000000001", C2 = "10000000-0000-4000-8000-000000000002";
  await db.query(`insert into public.sms_messages values
      ('a', $1, '2026-11-01T10:00:00Z', 'in', 'received'),
      ('a', $1, '2026-11-02T10:00:00Z', 'out', 'failed'),
      ('b', $1, '2026-11-05T10:00:00Z', 'in', 'received')`, [C1]);
  await db.query("insert into public.email_sends values ('a', $1, '2026-11-03T10:00:00Z', 'conversation', 'delivered'), ('a', $1, '2026-11-04T10:00:00Z', 'quote', 'sent')", [C1]);
  await db.query("insert into public.email_inbound values ('a', $1, '2026-11-01T09:00:00Z')", [C2]);
  await db.query("insert into public.phone_calls (client_id, contact_id, started_at, direction, answered_at, answered_by, status) values ('a', $1, '2026-11-04T12:00:00Z', 'out', null, null, 'completed')", [C2]);
  const facts = async (calls) => {
    const rows = (await db.query("select contact_id, last_in_at, last_in_channel, last_out_at, last_out_channel from public.crm_contact_touch_facts('a', $1::uuid[], $2)", [[C1, C2], calls])).rows;
    return Object.fromEntries(rows.map((x) => [x.contact_id, x]));
  };
  const noCalls = await facts(false), withCalls = await facts(true);
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  check("their last text in is theirs, this builder's only", iso(noCalls[C1].last_in_at) === "2026-11-01T10:00:00.000Z" && noCalls[C1].last_in_channel === "sms", JSON.stringify(noCalls[C1]));
  check("a failed text and a quote email aren't a reply; a conversation email is", iso(noCalls[C1].last_out_at) === "2026-11-03T10:00:00.000Z" && noCalls[C1].last_out_channel === "email", JSON.stringify(noCalls[C1]));
  check("calls count for nothing unless asked", noCalls[C2].last_out_at === null && iso(noCalls[C2].last_in_at) === "2026-11-01T09:00:00.000Z", JSON.stringify(noCalls[C2]));
  check("and count when asked", iso(withCalls[C2].last_out_at) === "2026-11-04T12:00:00.000Z" && withCalls[C2].last_out_channel === "call", JSON.stringify(withCalls[C2]));

  // ── clearing old private cards ──
  const ins = (client, kind, status, title, preview, payload, days) => db.query(
    "insert into public.jack_proposals (client_id, user_id, kind, status, title, preview, payload, created_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now() - make_interval(days => $8))",
    [client, U, kind, status, title, JSON.stringify(preview), JSON.stringify(payload), days]);
  await ins("a", "lookup", "applied", "old list", { groups: [{ rows: [{ name: "Dana Rivers" }] }] }, { area: "contacts" }, 31);
  await ins("a", "reply_draft", "expired", "old draft", { body: "Hi Dana" }, { body: "Hi Dana" }, 45);
  await ins("a", "lookup", "applied", "new list", { groups: [] }, { area: "orders" }, 2);
  await ins("a", "size_rule", "ready", "old sizes", { counts: { changed: 1 } }, { sizes: [] }, 40);
  await ins("b", "lookup", "applied", "another builder", { groups: [] }, { area: "contacts" }, 40);
  const swept = (await one("select public.jack_clear_old_private('a', now() - interval '30 days') as n")).n;
  check("the sweep clears one builder's private cards past the window, and says how many", swept === 2, String(swept));
  const row = (title) => one("select preview, payload, title, status from public.jack_proposals where title = $1", [title]);
  const old = await row("old list");
  check("a cleared card keeps its title and status, and no contents", JSON.stringify(old.preview) === '{"cleared":true}' && JSON.stringify(old.payload) === '{"cleared":true}' && old.status === "applied", JSON.stringify(old));
  check("a draft past the window is cleared too", JSON.stringify((await row("old draft")).preview) === '{"cleared":true}');
  check("a card inside the window is left", JSON.stringify((await row("new list")).payload) === '{"area":"orders"}');
  check("a card that isn't private is left, however old", JSON.stringify((await row("old sizes")).payload) === '{"sizes":[]}');
  check("another builder's cards are left", JSON.stringify((await row("another builder")).payload) === '{"area":"contacts"}');
  check("a second sweep has nothing to do", (await one("select public.jack_clear_old_private('a', now() - interval '30 days') as n")).n === 0);
  for (const role of ["anon", "authenticated"]) {
    check(`${role} can't run the sweep`, !(await fpriv(role, "public.jack_clear_old_private(text, timestamptz)")));
  }

  // ── again ──
  let again = true;
  try { await db.exec(MIG("376_jack_v1.sql")); } catch (e) { again = false; console.log(String(e && e.message)); }
  const after = await one("select (select count(*)::int from public.jack_memory) as mem, (select count(*)::int from public.usage_prices where kind = 'jack_ai') as meters, (select jack_key from public.setup_template_items where title = 'Add your business details' and account_type = 'all') as key");
  check("a re-apply changes nothing", again && after.mem === 1 && after.meters === 1 && after.key === "business", JSON.stringify(after));

  // ── 377 (Jack v2): the record-change kinds, on top of 376 ──
  let v2 = true;
  try { await db.exec(MIG("377_jack_v2.sql")); } catch (e) { v2 = false; console.log(String(e && e.message)); }
  check("377 applies after 376, and its proof passes", v2);
  const list377 = (() => {
    const s = MIG("377_jack_v2.sql");
    const a = s.indexOf("add constraint jack_proposals_kind_check check (kind in (");
    return [...s.slice(a, s.indexOf("));", a)).replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  })();
  check("377 lists the v1 kinds and the 15 v2 kinds", list377.length === 30 && list377.includes("commission_rate") && list377.includes("reply_draft"), String(list377.length));
  for (const k of ["inventory_price", "inventory_listing", "inventory_photos", "changeorder_attrs", "changeorder_unlock",
    "build_job_add", "build_job_change", "build_job_built", "delivery_load_create", "delivery_stop_add", "delivery_stop_reorder",
    "delivery_load_out", "delivery_stop_delivered", "delivery_load_delivered", "commission_rate", "price_sheet", "lookup"]) {
    check(`after 377, kind ${k} is accepted`, !(await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, $2, 'ready', 'v2')", [U, k])));
  }
  check("after 377, a made-up kind is still refused", await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'delete_everything', 'ready', 'x')", [U]));
  const commission = (await one("select id from public.jack_proposals where kind = 'commission_rate' limit 1")).id;
  await db.query("update public.jack_proposals set created_at = now() - interval '90 days', preview = '{\"rate\": 7}'::jsonb where id = $1", [commission]);
  await db.query("select public.jack_clear_old_private('a', now() - interval '30 days')");
  check("a commission card is never cleared by the 30-day sweep", JSON.stringify((await one("select preview from public.jack_proposals where id = $1", [commission])).preview) === '{"rate":7}');
  let v2again = true;
  try { await db.exec(MIG("377_jack_v2.sql")); } catch (e) { v2again = false; console.log(String(e && e.message)); }
  check("a re-apply of 377 changes nothing", v2again);

  // ── 378 (Jack v2, round 2): the send kinds, the four-kind sweep, and sent_with ──
  let v3 = true;
  try { await db.exec(MIG("378_jack_sends.sql")); } catch (e) { v3 = false; console.log(String(e && e.message)); }
  check("378 applies after 377, and its proof passes", v3);
  if (!v3) { await db.close(); process.exitCode = 1; return; }
  const list378 = (() => {
    const s = MIG("378_jack_sends.sql");
    const a = s.indexOf("add constraint jack_proposals_kind_check check (kind in (");
    return [...s.slice(a, s.indexOf("));", a)).replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  })();
  check("378 lists 377's 30 kinds and the 2 send kinds, each once",
    list378.length === 32 && new Set(list378).size === 32 && list377.every((k) => list378.includes(k))
      && list378.includes("reply_send") && list378.includes("estimate_resend"), String(list378.length));
  for (const k of ["reply_send", "estimate_resend", "reply_draft", "lookup", "commission_rate", "delivery_load_delivered", "memory", "price_sheet"]) {
    check(`after 378, kind ${k} is accepted`, !(await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, $2, 'ready', 'v3')", [U, k])));
  }
  check("after 378, a made-up kind is still refused", await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'send_everyone', 'ready', 'x')", [U]));

  // The sweep is 376's function word for word, with only the kind list widened.
  const sweepOf = (f) => {
    const s = MIG(f);
    const a = s.indexOf("create or replace function public.jack_clear_old_private(");
    const b = s.indexOf("comment on function public.jack_clear_old_private(", a);
    return a < 0 || b < 0 ? null : s.slice(a, b).trim();
  };
  const sweep376 = sweepOf("376_jack_v1.sql"), sweep378 = sweepOf("378_jack_sends.sql");
  check("378's sweep is 376's, security and grants included, with only the kind list changed",
    !!sweep376 && !!sweep378
      && sweep378 === sweep376.replace("kind in ('lookup', 'reply_draft')", "kind in ('lookup', 'reply_draft', 'reply_send', 'estimate_resend')")
      && sweep378 !== sweep376);
  const fn = await one("select prosecdef, proconfig from pg_proc where oid = 'public.jack_clear_old_private(text, timestamptz)'::regprocedure");
  check("the sweep is still security definer with an empty search path", fn.prosecdef === true && JSON.stringify(fn.proconfig) === '["search_path=\\"\\""]', JSON.stringify(fn));
  for (const role of ["anon", "authenticated"]) {
    check(`after 378, ${role} can't run the sweep`, !(await fpriv(role, "public.jack_clear_old_private(text, timestamptz)")));
  }
  check("after 378, the service role can run the sweep", await fpriv("service_role", "public.jack_clear_old_private(text, timestamptz)"));

  // Builder "c": one old card of each private kind, an old commission card, a new send, and builder "d"'s old send.
  await ins("c", "lookup", "applied", "c old list", { groups: [{ rows: [{ name: "Dana Rivers" }] }] }, { area: "contacts" }, 31);
  await ins("c", "reply_draft", "expired", "c old draft", { body: "Hi Dana" }, { body: "Hi Dana" }, 40);
  await ins("c", "reply_send", "applied", "c old text", { firstName: "Dana", body: "Your shed is ready" }, { body: "Your shed is ready", nonce: "n1" }, 35);
  await ins("c", "estimate_resend", "applied", "c old estimate", { firstName: "Dana", estimateNumber: "SS-1001" }, { shortCode: "SS-DEMO2345", nonce: "n2" }, 60);
  await ins("c", "commission_rate", "applied", "c old rate", { rate: 7 }, { rate: 7 }, 90);
  await ins("c", "reply_send", "ready", "c new text", { body: "Still thinking?" }, { body: "Still thinking?", nonce: "n3" }, 2);
  await ins("d", "reply_send", "applied", "d old text", { body: "Hello" }, { body: "Hello", nonce: "n4" }, 50);
  const swept378 = (await one("select public.jack_clear_old_private('c', now() - interval '30 days') as n")).n;
  check("the sweep clears all four private kinds past the window, and says how many", swept378 === 4, String(swept378));
  for (const t of ["c old list", "c old draft", "c old text", "c old estimate"]) {
    const r3 = await row(t);
    check(`"${t}" is cleared, keeping its title and status`, JSON.stringify(r3.preview) === '{"cleared":true}' && JSON.stringify(r3.payload) === '{"cleared":true}' && r3.status !== null, JSON.stringify(r3));
  }
  check("a commission card is still never cleared", JSON.stringify((await row("c old rate")).payload) === '{"rate":7}');
  check("a send inside the window is left", JSON.stringify((await row("c new text")).payload) === '{"body":"Still thinking?","nonce":"n3"}');
  check("another builder's old send is left", JSON.stringify((await row("d old text")).payload) === '{"body":"Hello","nonce":"n4"}');
  check("a second sweep has nothing to do", (await one("select public.jack_clear_old_private('c', now() - interval '30 days') as n")).n === 0);

  // sent_with: null or 'jack', nothing else, on both tables. Rows from before 378 stay null.
  check("texts from before 378 have no sent_with", (await one("select count(*)::int as n from public.sms_messages where sent_with is not null")).n === 0
    && (await one("select count(*)::int as n from public.sms_messages")).n === 3);
  check("emails from before 378 have no sent_with", (await one("select count(*)::int as n from public.email_sends where sent_with is not null")).n === 0
    && (await one("select count(*)::int as n from public.email_sends")).n === 2);
  for (const t of ["sms_messages", "email_sends"]) {
    const cols = t === "sms_messages" ? "(client_id, contact_id, created_at, direction, status, sent_with)" : "(client_id, contact_id, created_at, kind, status, sent_with)";
    const vals = (v) => t === "sms_messages" ? ["a", C1, "2026-11-06T10:00:00Z", "out", "sent", v] : ["a", C1, "2026-11-06T10:00:00Z", "conversation", "sent", v];
    check(`${t}.sent_with takes null`, !(await refused(db, `insert into public.${t} ${cols} values ($1, $2, $3, $4, $5, $6)`, vals(null))));
    check(`${t}.sent_with takes 'jack'`, !(await refused(db, `insert into public.${t} ${cols} values ($1, $2, $3, $4, $5, $6)`, vals("jack"))));
    for (const bad of ["Jack", "portal", "", "jack "]) {
      check(`${t}.sent_with refuses ${JSON.stringify(bad)}`, await refused(db, `insert into public.${t} ${cols} values ($1, $2, $3, $4, $5, $6)`, vals(bad)));
    }
    check(`${t}: a stamp on an existing row takes 'jack'`, !(await refused(db, `update public.${t} set sent_with = 'jack' where created_at = '2026-11-03T10:00:00Z' or created_at = '2026-11-02T10:00:00Z'`)));
    check(`${t}: a stamp of anything else is refused`, await refused(db, `update public.${t} set sent_with = 'robot' where sent_with = 'jack'`));
    const col = await one("select is_nullable, column_default, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'sent_with'", [t]);
    check(`${t}.sent_with is nullable text with no default`, col && col.is_nullable === "YES" && col.column_default === null && col.data_type === "text", JSON.stringify(col));
    const chk = await one("select convalidated, pg_get_constraintdef(oid) as def from pg_constraint where conname = $1 and conrelid = $2::regclass", [`${t}_sent_with_chk`, `public.${t}`]);
    check(`${t}_sent_with_chk is the named, validated check`, chk && chk.convalidated === true && /'jack'/.test(chk.def), JSON.stringify(chk));
  }

  // ── a re-apply of 378 changes nothing ──
  const snapshot = async () => JSON.stringify({
    kinds: (await one("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'jack_proposals_kind_check'")).d,
    fn: (await one("select pg_get_functiondef('public.jack_clear_old_private(text, timestamptz)'::regprocedure) as d")).d,
    checks: (await db.query("select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d, convalidated from pg_constraint where conname like '%sent_with%' order by 1, 2")).rows,
    cols: (await db.query("select table_name, column_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and column_name = 'sent_with' order by 1")).rows,
    sms: (await db.query("select sent_with, count(*)::int as n from public.sms_messages group by 1 order by 1 nulls first")).rows,
    email: (await db.query("select sent_with, count(*)::int as n from public.email_sends group by 1 order by 1 nulls first")).rows,
    cards: (await db.query("select title, preview, payload from public.jack_proposals where client_id in ('c', 'd') order by title")).rows,
    roles: [await fpriv("anon", "public.jack_clear_old_private(text, timestamptz)"), await fpriv("authenticated", "public.jack_clear_old_private(text, timestamptz)")],
  });
  const before378 = await snapshot();
  let v3again = true;
  try { await db.exec(MIG("378_jack_sends.sql")); } catch (e) { v3again = false; console.log(String(e && e.message)); }
  const after378 = await snapshot();
  check("a re-apply of 378 changes nothing", v3again && before378 === after378, v3again ? "the schema or the data moved" : "the re-apply failed");
  check("and leaves one sent_with check per table", (await one("select count(*)::int as n from pg_constraint where conname like '%sent_with%'")).n === 2);

  // ── 379: the insulation price kind, on top of 378 ──
  check("before 379, an insulation card is refused", await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'insulation_price', 'ready', 'ins')", [U]));
  const cardsBefore379 = (await one("select count(*)::int as n from public.jack_proposals")).n;
  let v379 = true;
  try { await db.exec(MIG("379_jack_insulation.sql")); } catch (e) { v379 = false; console.log(String(e && e.message)); }
  check("379 applies after 378, and its proof passes", v379);
  const list379 = (() => {
    const s = MIG("379_jack_insulation.sql");
    const a = s.indexOf("add constraint jack_proposals_kind_check check (kind in (");
    return [...s.slice(a, s.indexOf("));", a)).replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  })();
  check("379 lists every 378 kind and insulation_price", list379.length === 33 && list379.includes("insulation_price") && list379.includes("estimate_resend"), String(list379.length));
  for (const k of list379) {
    check(`after 379, kind ${k} is accepted`, !(await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, $2, 'ready', '379')", [U, k])));
  }
  check("after 379, a made-up kind is still refused", await refused(db, "insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'insulation', 'ready', 'x')", [U]));
  check("379 keeps every card that was there", (await one("select count(*)::int as n from public.jack_proposals where title <> '379'")).n === cardsBefore379);
  check("after 379, the sweep still never clears an insulation card", (await one("select pg_get_functiondef('public.jack_clear_old_private(text, timestamptz)'::regprocedure) as d")).d.indexOf("insulation_price") < 0);
  let v379again = true;
  try { await db.exec(MIG("379_jack_insulation.sql")); } catch (e) { v379again = false; console.log(String(e && e.message)); }
  check("a re-apply of 379 changes nothing", v379again && (await one("select count(*)::int as n from pg_constraint where conname = 'jack_proposals_kind_check'")).n === 1);

  await db.close();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
