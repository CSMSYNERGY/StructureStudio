// Execute migration 375 for real in PGlite (Postgres compiled to WASM, in memory), on top of
// area_level_for as 326 defines it, then check what it promises:
//   * owners and admins resolve 'edit' on jack; every other title, a NULL title and an unknown title
//     resolve 'none'; a stored grant gives it to one person, and a stored 'none' takes it from an admin,
//     never from an owner;
//   * NOTHING ELSE MOVED: for every title x every area x a set of stored maps, 375's answer is 326's,
//     except on jack itself;
//   * the SQL agrees with the REAL _shared/access.ts effectiveAccess on every one of those cells;
//   * the switch is off by default, on every existing row and every new one;
//   * the three tables are service-role only: anon and authenticated can't read or write them, and they
//     can't run jack_usage;
//   * jack_usage counts the right things, and the month's cost is every builder's together;
//   * deleting a chat takes its messages and leaves a proposal, with its link cleared;
//   * a re-apply changes nothing.
// Nothing here touches the live project: no network, no Supabase.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration375.test.cjs  exit 0 = ALL CHECKS PASSED
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
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

(async () => {
  const access = await import(pathToFileURL(path.join(WT, "supabase/functions/_shared/access.ts")).href);
  const db = new PGlite();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.client_settings (client_id text primary key);
    insert into public.client_settings (client_id) values ('harness-existing');
  `);
  await db.exec(areaLevelFrom326());

  const TITLES = ["owner", "admin", "office_staff", "sales_manager", "sales_rep", "dealer", "scheduler", "crew_leader", "crew_member", "driver", null, "made_up_title"];
  const AREAS = access.AREA_KEYS;
  const MAPS = [{}, { designs: "none" }, { contacts: "own" }, { reports: "edit", designer: "view" }, { settings_billing: "edit" }];
  const roleOf = (t) => (t === "owner" ? "owner" : t === "admin" ? "admin" : "user");
  const level = (role, title, map, area) => one("select public.area_level_for($1, $2, $3::jsonb, $4) as v", [role, title, JSON.stringify(map), area]).then((r) => r.v);

  const before = new Map();
  for (const t of TITLES) for (const m of MAPS) for (const a of AREAS) {
    if (a === "jack") continue;
    before.set(JSON.stringify([t, m, a]), await level(roleOf(t), t, m, a));
  }
  check("before 375, jack isn't an area", (await level("admin", "admin", {}, "jack")) === "none");

  await db.exec(MIG("375_jack_agent.sql"));

  // ── jack resolves as access.ts says ──
  check("an owner holds it", (await level("owner", "owner", {}, "jack")) === "edit");
  check("an admin holds it", (await level("admin", "admin", {}, "jack")) === "edit");
  for (const t of ["office_staff", "sales_manager", "sales_rep", "dealer", "scheduler", "crew_leader", "crew_member", "driver", null, "made_up_title"]) {
    check(`${t} doesn't, by preset`, (await level("user", t, {}, "jack")) === "none");
  }
  check("a stored grant gives it to one person", (await level("user", "sales_rep", { jack: "edit" }, "jack")) === "edit");
  check("a stored none takes it from an admin", (await level("admin", "admin", { jack: "none" }, "jack")) === "none");
  check("a stored none can't take it from an owner", (await level("owner", "owner", { jack: "none" }, "jack")) === "edit");
  check("a level that isn't one is ignored", (await level("user", "sales_rep", { jack: "view" }, "jack")) === "none");

  // ── nothing else moved, and the SQL agrees with the TypeScript ──
  let moved = 0, disagree = 0, cells = 0;
  for (const t of TITLES) for (const m of MAPS) {
    const ts = access.effectiveAccess(roleOf(t), t, m);
    for (const a of AREAS) {
      const now = await level(roleOf(t), t, m, a);
      cells++;
      if (a !== "jack" && before.get(JSON.stringify([t, m, a])) !== now) moved++;
      if ((ts[a] ?? "none") !== now) { disagree++; if (disagree < 4) console.log("   differs:", t, a, ts[a], now); }
    }
  }
  check(`no other area moved (${cells} cells)`, moved === 0, String(moved));
  check("the SQL agrees with access.ts on every cell", disagree === 0, String(disagree));

  // ── the switch ──
  check("the switch is off on an existing row", (await one("select jack_on, jack_off from public.client_settings where client_id = 'harness-existing'")).jack_on === false);
  await db.exec("insert into public.client_settings (client_id) values ('harness-new')");
  const fresh = await one("select jack_on, jack_off from public.client_settings where client_id = 'harness-new'");
  check("the switch is off on a new row, with nothing switched off", fresh.jack_on === false && Array.isArray(fresh.jack_off) && fresh.jack_off.length === 0);

  // ── service-role only ──
  const refused = async (role, sql) => {
    await db.exec(`set role ${role}`);
    try { await db.exec(sql); return false; } catch (e) { return /permission denied/.test(String(e.message)); } finally { await db.exec("reset role"); }
  };
  for (const t of ["jack_conversations", "jack_messages", "jack_proposals"]) {
    check(`${t} has row level security on`, (await one("select relrowsecurity as v from pg_class where oid = $1::regclass", [`public.${t}`])).v === true);
    for (const r of ["anon", "authenticated"]) {
      check(`${r} can't read ${t}`, await refused(r, `select * from public.${t}`));
      check(`${r} can't write ${t}`, await refused(r, `delete from public.${t}`));
    }
  }
  const U1 = "00000000-0000-4000-8000-000000000001", U2 = "00000000-0000-4000-8000-000000000002";
  for (const r of ["anon", "authenticated"]) {
    check(`${r} can't run jack_usage`, await refused(r, `select public.jack_usage('a', '${U1}')`));
  }

  // ── what the caps read ──
  const chat = (await one("insert into public.jack_conversations (client_id, user_id) values ('a', $1) returning id", [U1])).id;
  const say = (c, cost, user = U1, client = "a") => db.query("insert into public.jack_messages (conversation_id, client_id, user_id, role, body, cost_micros) values ($1, $2, $3, 'user', 'x', $4)", [c, client, user, cost]);
  await say(chat, 100); await say(chat, 200);
  const other = (await one("insert into public.jack_conversations (client_id, user_id) values ('b', $1) returning id", [U2])).id;
  await say(other, 1000, U2, "b");
  await db.query("update public.jack_messages set created_at = now() - interval '30 minutes' where cost_micros = 200");
  await db.query("insert into public.jack_proposals (client_id, user_id, conversation_id, kind, status, title, cost_micros) values ('a', $1, $2, 'price_sheet', 'ready', 'x', 5000)", [U1, chat]);
  const u = (await one("select public.jack_usage('a', $1) as v", [U1])).v;
  check("the month's cost is every builder's, messages and sheets", Number(u.month_cost_micros) === 6300, JSON.stringify(u));
  check("24 hours counts this builder only", Number(u.tenant_24h) === 2, JSON.stringify(u));
  check("10 minutes counts this person only", Number(u.user_10m) === 1, JSON.stringify(u));
  check("sheets count this builder only", Number(u.sheets_24h) === 1, JSON.stringify(u));

  // ── deleting ──
  await db.query("delete from public.jack_conversations where id = $1", [chat]);
  check("a chat takes its messages with it", (await one("select count(*)::int as n from public.jack_messages where conversation_id = $1", [chat])).n === 0);
  const kept = await one("select conversation_id from public.jack_proposals where client_id = 'a'");
  check("and leaves the proposal, its link cleared", kept && kept.conversation_id === null);

  // ── a bad status is refused ──
  let badStatus = false;
  try { await db.query("insert into public.jack_proposals (client_id, user_id, kind, status, title) values ('a', $1, 'price_sheet', 'sent_anyway', 'x')", [U1]); } catch (_e) { badStatus = true; }
  check("a status that isn't one is refused", badStatus);

  // ── again ──
  await db.exec(MIG("375_jack_agent.sql"));
  check("a re-apply changes nothing", (await level("admin", "admin", {}, "jack")) === "edit" && (await one("select count(*)::int as n from public.jack_proposals")).n === 1);

  await db.close();
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
