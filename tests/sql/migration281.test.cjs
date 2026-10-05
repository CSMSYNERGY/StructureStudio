// Execute migration 281 for real in PGlite (Postgres compiled to WASM, in memory) on
// billing_webhook_events as 050 defines it (the live shape: information_schema, 2026-10-05), seeded
// with rows shaped like the live NMI body plus the two older shapes, then check what it promises:
//   * every row that carried card or contact details is scrubbed of card, billing_address, shipping
//     and merchant, in all three container shapes, and no row's text still names a card or contact
//     key or holds a masked card number or an email address;
//   * what a triage reads is still there (subscription_id, order_id, plan, next_charge_date, …), and
//     id, event_type, status, error, created_at and processed_at did not move on any row;
//   * a row the REDACTING webhook writes (the real _shared/billingWebhookRedact.ts output) is left
//     byte-for-byte, and so are rows with odd shapes (an array container, a scalar payload);
//   * THE RECORD, the one row `supabase db query` prints, says so, and a dry run (the last commit;
//     swapped for rollback;) prints the same row and changes nothing;
//   * a re-apply changes nothing, a CRLF checkout of the file applies the same, and the two pg_temp
//     helpers are gone afterwards;
//   * MUTANTS: a copy WITHOUT the DO-block guard commits a leak the real file refuses; a scrub that
//     misses billing_address, and one that touches another column, are refused with the whole file
//     rolled back.
// Nothing here touches the live project: no network, no Supabase.
//
// Payers, cards, merchants and tenants are made up. The repo is public: no real client id, payer or
// card belongs in a fixture.
//
// Run (from the repo root):
//   npm install --prefix tests/sql        once (@electric-sql/pglite only)
//   node tests/sql/migration281.test.cjs  exit 0 = ALL CHECKS PASSED
// MIG_FILE=<path> applies another copy of the migration (e.g. a deliberately broken one).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { PGlite } = require("@electric-sql/pglite");

const WT = path.resolve(__dirname, "../..");
// Read as LF: a Windows checkout is CRLF, and section 3 tries that copy on purpose.
const MIG_TEXT = () => fs.readFileSync(process.env.MIG_FILE || path.join(WT, "supabase/migrations/281_billing_webhook_redact.sql"), "utf8")
  .replace(/\r\n/g, "\n");

// 050's table, its RLS and its grants, exactly.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create table public.billing_webhook_events (
  id           text primary key,
  event_type   text not null,
  payload      jsonb not null,
  status       text not null default 'received'
                 check (status in ('received','processed','failed')),
  error        text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_webhook_events from anon, authenticated;
grant all on public.billing_webhook_events to service_role;
`;

// Every key the live NMI body carried on 2026-10-05, values invented.
const CARD = {
  cc_number: "411111******1111", cc_bin: "411111", cc_exp: "1229", cc_type: "visa",
  cc_issue_number: "", cc_start_date: "", avs_response: "Y", csc_response: "M",
  cavv: "", cavv_result: "", xid: "", eci: "", entry_mode: "keyed", cardholder_auth: "",
  card_balance: "", card_available_balance: "",
};
const PAYER = (first, email, phone) => ({
  first_name: first, last_name: "Example", company: "", address_1: "1 Example Road", address_2: "",
  city: "Springfield", state: "IL", postal_code: "62704", country: "US", email, phone, cell_phone: phone, fax: "",
});
const nmiBody = (orderId, extra = {}) => ({
  subscription_id: "9000000001", order_id: orderId, order_description: "StructureStudio Simple Layout (annual)",
  ponumber: "", processor_id: "proc-1", subscription_type: "cc", next_charge_date: "2027-10-05",
  attempted_payments: "1", completed_payments: "1", remaining_payments: "0",
  plan: { id: "SS_SIMPLE_LAYOUT_ANNUAL", name: "Simple Layout annual", amount: "499.00", payments: "0", day_of_month: "5", month_frequency: "12", day_frequency: "" },
  card: CARD,
  billing_address: PAYER("Pat", "pat@example.com", "5555550123"),
  merchant: { id: "merch-7781", name: "Example Merchant", external_identifier: "ext-31" },
  shipping: "0.00", tax: "0.00", features: { is_test_mode: false }, website: "",
  ...extra,
});

// What a triage reads, per container, and must survive.
const KEPT = ["subscription_id", "order_id", "order_description", "plan", "next_charge_date", "attempted_payments",
  "completed_payments", "remaining_payments", "processor_id", "subscription_type", "ponumber", "tax", "features", "website"];
const DROPPED = ["card", "billing_address", "shipping", "merchant"];
// Anything that identifies a payer or a card, as it appears in jsonb text.
const SECRETS = ["411111", "1229", "Pat", "Sam", "Example Road", "62704", "@example", "5555550123", "5555550199", "merch-7781", "Example Merchant"];

let redact;   // the REAL webhook redactor, loaded below
async function seedRows() {
  return [
    // An add of ours, stored raw before the redeploy.
    { id: "evt-ss-add", event_type: "recurring.subscription.add", status: "processed", error: null,
      created_at: "2026-07-28 10:00+00", processed_at: "2026-07-28 10:00:01+00",
      payload: { event_id: "evt-ss-add", event_type: "recurring.subscription.add", event_body: nmiBody("ss_acme-sheds_simple_layout_annual") } },
    // Another product's customer on the shared gateway: acked as foreign, but kept.
    { id: "evt-foreign", event_type: "recurring.subscription.add", status: "processed",
      error: "ignored: foreign-product subscription (order_id=cs_user-1_plan)",
      created_at: "2026-10-05 16:27+00", processed_at: "2026-10-05 16:27:01+00",
      payload: { event_id: "evt-foreign", event_type: "recurring.subscription.add",
        event_body: nmiBody("cs_user-1_plan", { billing_address: PAYER("Sam", "sam@example.net", "5555550199") }) } },
    // Still 'received' (never processed): status and processed_at must stay exactly so.
    { id: "evt-received", event_type: "recurring.subscription.update", status: "received", error: null,
      created_at: "2026-08-24 09:00+00", processed_at: null,
      payload: { event_id: "evt-received", event_type: "recurring.subscription.update", event_body: nmiBody("ss_bravo-barns_crm_monthly") } },
    // The older Deposyt shape: data.subscription.
    { id: "evt-legacy-data", event_type: "recurring.subscription.update", status: "failed",
      error: "No billing_subscriptions row for 9000000002 — retry once the add lands",
      created_at: "2026-07-25 08:00+00", processed_at: "2026-07-25 08:00:02+00",
      payload: { id: "evt-legacy-data", type: "recurring.subscription.update",
        data: { subscription: { id: "9000000002", status: "past_due", metadata: { clientId: "acme-sheds" },
          card: CARD, billing_address: PAYER("Pat", "pat@example.com", "5555550123"),
          shipping: { address_1: "1 Example Road", email: "pat@example.com" } } } } },
    // The other older shape: subscription, with a merchant block.
    { id: "evt-legacy-sub", event_type: "recurring.subscription.delete", status: "processed", error: null,
      created_at: "2026-07-26 08:00+00", processed_at: "2026-07-26 08:00:02+00",
      payload: { id: "evt-legacy-sub", type: "recurring.subscription.delete",
        subscription: { subscription_id: "9000000003", order_id: "ss_acme-sheds_crm_annual", card: CARD,
          billing_address: PAYER("Pat", "pat@example.com", "5555550123"), merchant: { id: "merch-7781", name: "Example Merchant" } } } },
    // A row the REDACTING webhook writes: the real module's output. Must not move at all.
    { id: "evt-redacted", event_type: "recurring.subscription.add", status: "processed", error: null,
      created_at: "2026-10-06 10:00+00", processed_at: "2026-10-06 10:00:01+00",
      payload: redact({ event_id: "evt-redacted", event_type: "recurring.subscription.add", event_body: nmiBody("ss_charlie-cabins_scheduler_annual") }) },
    // Odd shapes nobody writes, but which must not take the file down.
    { id: "evt-odd-array", event_type: "x", status: "failed", error: "odd", created_at: "2026-09-01 00:00+00", processed_at: null,
      payload: { id: "evt-odd-array", event_body: [1, 2], subscription: "none" } },
    { id: "evt-odd-scalar", event_type: "x", status: "failed", error: null, created_at: "2026-09-02 00:00+00", processed_at: null,
      payload: "just a string" },
  ];
}
const RAW_IDS = ["evt-foreign", "evt-legacy-data", "evt-legacy-sub", "evt-received", "evt-ss-add"];

let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log("  ok   " + msg);
  else { failures++; console.log("  FAIL " + msg + (detail ? " :: " + detail : "")); }
  return cond;
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

async function fresh(extraRows = []) {
  const db = new PGlite();
  await db.exec(STUBS);
  for (const r of [...(await seedRows()), ...extraRows]) {
    await db.query(`insert into public.billing_webhook_events (id, event_type, payload, status, error, created_at, processed_at)
                    values ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [r.id, r.event_type, JSON.stringify(r.payload), r.status, r.error, r.created_at, r.processed_at]);
  }
  return db;
}
async function apply(db, sql = MIG_TEXT()) {
  const notices = [];
  const results = await db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
  // THE RECORD: what `supabase db query` prints is the rows of the last statement that returns any.
  const last = [...results].reverse().find((r) => r.rows && r.rows.length);
  notices.record = last ? last.rows[0] : null;
  return notices;
}
const DRY_RUN = (t = MIG_TEXT()) => {
  const i = t.lastIndexOf("\ncommit;");
  return t.slice(0, i) + "\nrollback;" + t.slice(i + "\ncommit;".length);
};
// The whole table, as text, in a stable order: "nothing changed" is this, byte for byte.
const snapshot = async (db) => JSON.stringify(await rows(db, `select id, event_type, payload::text as p, status, error,
  created_at::text as c, processed_at::text as pr from public.billing_webhook_events order by id`));
const payloads = async (db) => Object.fromEntries((await rows(db, "select id, payload from public.billing_webhook_events order by id")).map((r) => [r.id, r.payload]));
const tableText = async (db) => (await one(db, "select string_agg(payload::text, ' ' order by id) as t from public.billing_webhook_events")).t;
const helpersLeft = async (db) => Number((await one(db, "select count(*)::int as n from pg_proc where proname in ('m281_carries', 'm281_scrub')")).n);
// The read-only read-back from the file's header, run as written.
const readBack = async (db) => {
  const t = MIG_TEXT();
  const line = t.split("\n").find((l) => l.startsWith("--   select count(*) filter (where payload::text ~"));
  if (!line) throw new Error("281's header read-back query moved");
  return one(db, line.replace(/^--\s+/, ""));
};
async function refused(db, sql, re) {
  const before = await snapshot(db);
  let err = null;
  try { await apply(db, sql); } catch (e) { err = e.message; }
  await db.exec("rollback").catch(() => {});   // the file's own begin; is still open after a raise
  return { err, matched: !!err && re.test(err), unchanged: (await snapshot(db)) === before, helpers: await helpersLeft(db) };
}

(async () => {
  redact = (await import(pathToFileURL(path.join(WT, "supabase/functions/_shared/billingWebhookRedact.ts")).href)).redactWebhookPayload;

  // ── 1. The apply ────────────────────────────────────────────────────────────────────────────
  console.log("migration 281: scrubs card and contact details from every stored shape, and nothing else");
  {
    const db = await fresh();
    const before = await payloads(db);
    const metaBefore = await rows(db, "select id, event_type, status, error, created_at, processed_at from public.billing_webhook_events order by id");
    const rbBefore = await readBack(db);
    ok(rbBefore.carrying === 5 && rbBefore.total === 8, "the header's read-back counts the five raw rows before", JSON.stringify(rbBefore));

    let notices = [];
    try { notices = await apply(db); ok(true, "281 applied cleanly, its own checks included"); }
    catch (e) { ok(false, "281 applied", e.message); }
    ok(notices.some((n) => /281: checks hold; 5 of 8 row\(s\) scrubbed; none still carries card or contact details$/.test(n)),
      "its own checks held: 5 of 8 scrubbed", notices.join(" | "));
    ok(JSON.stringify(notices.record) === JSON.stringify({
      migration: "281", rows_total: 8, carried_before: 5, rows_scrubbed: 5, carried_after: 0, other_columns_moved: 0,
    }), "THE RECORD, the row the CLI prints: 8 rows, 5 carried and were scrubbed, none carries now, no other column moved", JSON.stringify(notices.record));

    const after = await payloads(db);
    const text = await tableText(db);
    for (const s of SECRETS) ok(!text.includes(s), `no "${s}" left anywhere in the table`);
    const rbAfter = await readBack(db);
    ok(rbAfter.carrying === 0 && rbAfter.total === 8, "the header's read-back reads 0 of 8 after", JSON.stringify(rbAfter));

    // Per shape: the four blocks gone, everything else in the container exactly as it was.
    const containerOf = (p) => p.event_body || (p.data && p.data.subscription) || p.subscription;
    for (const id of RAW_IDS) {
      const b = containerOf(before[id]);
      const a = containerOf(after[id]);
      ok(DROPPED.every((k) => !(k in a)), `${id}: card, billing_address, shipping and merchant are gone`, JSON.stringify(a));
      const expect = Object.fromEntries(Object.entries(b).filter(([k]) => !DROPPED.includes(k)));
      ok(JSON.stringify(a) === JSON.stringify(expect), `${id}: every other key in the container is exactly as it was`, JSON.stringify(a));
      const { event_body: _e, data: _d, subscription: _s, ...topB } = before[id];
      const { event_body: _e2, data: _d2, subscription: _s2, ...topA } = after[id];
      ok(JSON.stringify(topA) === JSON.stringify(topB), `${id}: the event's own id and type are untouched`);
    }
    const ss = after["evt-ss-add"].event_body;
    ok(KEPT.every((k) => k in ss) && ss.subscription_id === "9000000001" && ss.order_id === "ss_acme-sheds_simple_layout_annual"
      && ss.plan.id === "SS_SIMPLE_LAYOUT_ANNUAL" && ss.next_charge_date === "2027-10-05",
      "the live shape keeps what a triage reads: subscription id, order id, plan, next charge date, counts", JSON.stringify(ss));
    ok(after["evt-legacy-data"].data.subscription.metadata.clientId === "acme-sheds" && after["evt-legacy-data"].data.subscription.status === "past_due",
      "the data.subscription shape keeps its tenant and status");

    for (const id of ["evt-redacted", "evt-odd-array", "evt-odd-scalar"]) {
      ok(JSON.stringify(after[id]) === JSON.stringify(before[id]), `${id}: byte-for-byte untouched`);
    }
    ok(!JSON.stringify(after["evt-redacted"]).includes('"card"') && after["evt-redacted"].event_body.subscription_id === "9000000001",
      "and the redacting webhook's own row was clean to begin with");

    const metaAfter = await rows(db, "select id, event_type, status, error, created_at, processed_at from public.billing_webhook_events order by id");
    ok(JSON.stringify(metaAfter) === JSON.stringify(metaBefore), "id, event_type, status, error, created_at and processed_at did not move on any row");
    ok((await helpersLeft(db)) === 0, "the two pg_temp helpers are dropped at the end");
    const rls = await one(db, "select relrowsecurity from pg_class where oid = 'public.billing_webhook_events'::regclass");
    ok(rls.relrowsecurity === true, "RLS is still on (no schema change)");

    // ── Re-apply: nothing left to do ──
    const snap = await snapshot(db);
    let re = [];
    try { re = await apply(db); ok(true, "a re-apply runs clean"); } catch (e) { ok(false, "a re-apply runs clean", e.message); }
    ok(JSON.stringify(re.record) === JSON.stringify({
      migration: "281", rows_total: 8, carried_before: 0, rows_scrubbed: 0, carried_after: 0, other_columns_moved: 0,
    }), "and its record says there was nothing to scrub", JSON.stringify(re.record));
    ok((await snapshot(db)) === snap, "and the table is byte-for-byte what the first apply left");
    await db.close();
  }

  // ── 2. The dry run: the same record, nothing left behind ────────────────────────────────────
  console.log("migration 281: a dry run (commit swapped for rollback) prints the record and changes nothing");
  {
    const db = await fresh();
    const before = await snapshot(db);
    const dry = DRY_RUN();
    ok((dry.match(/\ncommit;/g) || []).length === 0 && (dry.match(/\nrollback;/g) || []).length === 1, "the dry run has no commit left in it, and one rollback");
    let notices = [];
    try { notices = await apply(db, dry); } catch (e) { ok(false, "the dry run ran", e.message); }
    ok(JSON.stringify(notices.record) === JSON.stringify({
      migration: "281", rows_total: 8, carried_before: 5, rows_scrubbed: 5, carried_after: 0, other_columns_moved: 0,
    }), "it prints the same record the apply would", JSON.stringify(notices.record));
    ok((await snapshot(db)) === before, "and the table is exactly as it was");
    ok((await helpersLeft(db)) === 0, "and no helper survives it");
    await db.close();
  }

  // ── 3. A CRLF checkout of the file applies the same ─────────────────────────────────────────
  console.log("migration 281: a Windows (CRLF) checkout of the file scrubs the same");
  {
    const lf = await fresh();
    await apply(lf);
    const crlf = await fresh();
    let err = null, rec = null;
    try { rec = (await apply(crlf, MIG_TEXT().replace(/\n/g, "\r\n"))).record; } catch (e) { err = e.message; }
    ok(!err && rec && rec.carried_after === 0 && rec.rows_scrubbed === 5, "the CRLF copy applies", err || JSON.stringify(rec));
    ok((await snapshot(lf)) === (await snapshot(crlf)), "and leaves the same table, byte for byte");
    await lf.close(); await crlf.close();
  }

  // ── 4. Mutants ──────────────────────────────────────────────────────────────────────────────
  console.log("migration 281: the guard is what stops a leak the scrub does not reach");
  {
    // A card block under a key the scrub does not list. The real file must refuse it; the same file
    // with the DO-block guard cut out commits it — which is the whole case for the guard.
    const stray = [{ id: "evt-stray", event_type: "recurring.subscription.add", status: "processed", error: null,
      created_at: "2026-09-03 00:00+00", processed_at: null,
      payload: { event_id: "evt-stray", event_body: { subscription_id: "9000000009", payment: { cc_number: "411111******1111" } } } }];

    let db = await fresh(stray);
    let r = await refused(db, MIG_TEXT(), /281: 1 row\(s\) of billing_webhook_events still carry card or contact details after the scrub \(first: evt-stray\) — nothing was changed/);
    ok(r.matched && r.unchanged && r.helpers === 0, "the real file REFUSES a card under an unlisted key, and changes nothing (the five raw rows stay raw too)", JSON.stringify(r));
    await db.close();

    const t = MIG_TEXT();
    const a = t.indexOf("do $check$");
    const b = t.indexOf("$check$;", a) + "$check$;".length;
    const noGuard = t.slice(0, a) + t.slice(b);
    ok(a > 0 && b > a && noGuard !== t && !noGuard.includes("still carry card"), "(mutant built: the DO-block guard cut out)");
    db = await fresh(stray);
    let rec = null, err = null;
    try { rec = (await apply(db, noGuard)).record; } catch (e) { err = e.message; }
    const leaked = (await tableText(db)).includes("411111");
    ok(!err && leaked && rec && rec.carried_after === 1,
      "WITHOUT the guard the same file commits, leaving the card number in the table (so the guard is load-bearing)", err || JSON.stringify(rec));
    await db.close();

    // A scrub that forgets billing_address.
    db = await fresh();
    const lazy = t.replace("k_drop constant text[] := array['card', 'billing_address', 'shipping', 'merchant'];",
      "k_drop constant text[] := array['card', 'shipping', 'merchant'];");
    ok(lazy !== t, "(mutant built: billing_address left out of the scrub)");
    r = await refused(db, lazy, /281: 5 row\(s\) of billing_webhook_events still carry card or contact details/);
    ok(r.matched && r.unchanged && r.helpers === 0, "a scrub that misses billing_address: refused, nothing changed", JSON.stringify(r));
    await db.close();

    // A scrub that reaches past payload.
    db = await fresh();
    const greedy = t.replace("   set payload = pg_temp.m281_scrub(payload)\n", "   set payload = pg_temp.m281_scrub(payload), error = null\n");
    ok(greedy !== t, "(mutant built: the update also clears error)");
    r = await refused(db, greedy, /281: \d+ row\(s\) of billing_webhook_events changed outside payload/);
    ok(r.matched && r.unchanged && r.helpers === 0, "an update that touches another column: refused, nothing changed", JSON.stringify(r));
    await db.close();

    // Patterns that went blind (always false): the checks pass, but THE RECORD is what an operator
    // reads, and its carried_before would read 0 on a table that plainly carried — caught here.
    db = await fresh();
    const blind = t.replace(/(create or replace function pg_temp\.m281_carries[\s\S]*?as \$fn\$\n)[\s\S]*?(\$fn\$;)/, "$1  select false\n$2");
    ok(blind !== t, "(mutant built: m281_carries always false)");
    rec = (await apply(db, blind)).record;
    ok(rec.carried_before === 0, "a blind pattern set shows up as carried_before 0 on a table with five raw rows — the expected record (5) would not match", JSON.stringify(rec));
    await db.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
