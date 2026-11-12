// The live parity run for migration 386 ("plans as data"): does the resolver give every REAL company
// what it has today?
//
// tests/sql/migration386.test.cjs proves the rules on made-up companies. This proves the claim that
// matters before any reader is switched over, on the real rows, without touching the live database:
//
//   1. Take a SNAPSHOT of the live inputs (the query is printed by --query; run it read-only and
//      save its one JSON value to a file OUTSIDE the repo: it holds client ids).
//   2. This script loads the snapshot into PGlite, applies migration 386 there, and compares, company
//      by company, the tabs the resolver turns ON with the tabs tests/sql/accessToday.cjs says the
//      company has today (portal-billing's rules, the account shapes and the switch columns, read the
//      old way). Any difference is a company that would change, and the run fails.
//   3. Optional second file: the LIVE resolver's answers after the migration is applied
//      (--resolved-query prints that query). Every state must equal the PGlite answer, which proves
//      the live function is the one that was tested.
//
// Usage (from the repo root):
//   node tests/sql/accessParity.cjs --query
//   node tests/sql/accessParity.cjs --resolved-query
//   node tests/sql/accessParity.cjs <snapshot.json> [<live-resolved.json>]
// Exit 0 = every company agrees. Not a test file: the gate does not run it (it needs live data).
// Nothing in this file names a client (public repo); the snapshot never enters the repo.
const fs = require("fs");
const path = require("path");

const SNAPSHOT_QUERY = `select jsonb_build_object(
  'taken_at', now(),
  'clients',  (select jsonb_agg(client_id order by client_id) from public.client_configs),
  'settings', (select jsonb_agg(jsonb_build_object(
                 'client_id', client_id, 'internal_account', internal_account, 'billing_exempt', billing_exempt,
                 'billing_exempt_until', billing_exempt_until, 'phone_only', phone_only, 'sheds_enabled', sheds_enabled,
                 'jack_on', jack_on, 'support_ai_beta', support_ai_beta, 'library_beta', library_beta,
                 'door_looks_beta', door_looks_beta, 'tax_lookup_enabled', tax_lookup_enabled,
                 'payments_online_enabled', payments_online_enabled, 'advanced_mode', advanced_mode,
                 'phone_status', phone_status) order by client_id) from public.client_settings),
  'plans',    (select jsonb_agg(jsonb_build_object('id', id, 'feature', feature, 'billing_interval', billing_interval,
                 'active', active, 'operator_grantable', operator_grantable) order by id) from public.billing_plans),
  'subs',     (select jsonb_agg(jsonb_build_object('id', id, 'client_id', client_id, 'plan_id', plan_id, 'status', status,
                 'current_period_end', current_period_end, 'canceled_at', canceled_at, 'past_due_since', past_due_since)
                 order by id) from public.billing_subscriptions),
  'grants',   (select jsonb_agg(jsonb_build_object('client_id', client_id, 'feature', feature, 'expires_at', expires_at)
                 order by client_id, feature) from public.client_feature_grants)
) as snapshot;`;

const RESOLVED_QUERY = `select jsonb_object_agg(c.client_id, public.access_resolve(c.client_id)) as resolved
  from public.client_configs c;`;

if (process.argv.includes("--query")) { console.log(SNAPSHOT_QUERY); process.exit(0); }
if (process.argv.includes("--resolved-query")) { console.log(RESOLVED_QUERY); process.exit(0); }

const [snapPath, livePath] = process.argv.slice(2);
if (!snapPath) {
  console.error("usage: node tests/sql/accessParity.cjs <snapshot.json> [<live-resolved.json>]   (or --query / --resolved-query)");
  process.exit(2);
}

const { PGlite } = require("@electric-sql/pglite");
const { STUBS } = require("./accessStubs.cjs");
const { todayOn } = require("./accessToday.cjs");

const WT = path.resolve(__dirname, "../..");
const SQL = fs.readFileSync(path.join(WT, "supabase/migrations/386_access_plans.sql"), "utf8").replace(/\r/g, "");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
const sorted = (s) => [...s].sort().join(",");

(async () => {
  const snap = readJson(snapPath);
  const settings = snap.settings || [];
  const plans = snap.plans || [];
  const subs = snap.subs || [];
  const grants = snap.grants || [];
  const clients = [...new Set([...(snap.clients || []), ...settings.map((s) => s.client_id), ...subs.map((s) => s.client_id), ...grants.map((g) => g.client_id)])].sort();

  const db = new PGlite();
  await db.exec(STUBS);
  const ins = async (table, cols, list) => {
    for (const r of list) {
      await db.query(`insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => r[c] ?? null));
    }
  };
  // The stub's columns are NOT NULL with defaults; a snapshot null for one of them means "not set".
  const SETTING_COLS = ["client_id", "internal_account", "billing_exempt", "billing_exempt_until", "phone_only", "sheds_enabled",
    "jack_on", "support_ai_beta", "library_beta", "door_looks_beta", "tax_lookup_enabled", "payments_online_enabled", "advanced_mode", "phone_status"];
  const DEFAULTS = { internal_account: false, billing_exempt: false, phone_only: false, sheds_enabled: true, jack_on: false, support_ai_beta: false,
    library_beta: false, door_looks_beta: false, tax_lookup_enabled: false, payments_online_enabled: false, advanced_mode: false, phone_status: "off" };
  await ins("client_settings", SETTING_COLS, settings.map((s) => {
    const o = { ...s };
    for (const [k, v] of Object.entries(DEFAULTS)) if (o[k] === null || o[k] === undefined) o[k] = v;
    return o;
  }));
  await ins("billing_plans", ["id", "feature", "billing_interval", "active", "operator_grantable"], plans.map((p) => ({ ...p, active: p.active !== false, operator_grantable: p.operator_grantable === true })));
  await ins("billing_subscriptions", ["id", "client_id", "plan_id", "status", "current_period_end", "canceled_at", "past_due_since"], subs);
  await ins("client_feature_grants", ["client_id", "feature", "expires_at"], grants);
  await db.exec(SQL);

  const now = Date.now();
  let failed = 0;
  const resolvedLocal = {};
  console.log(`snapshot taken ${snap.taken_at || "(no time recorded)"}: ${clients.length} companies, ${subs.length} subscriptions, ${grants.length} comps\n`);
  for (const c of clients) {
    const m = (await db.query("select public.access_resolve($1) m", [c])).rows[0].m;
    resolvedLocal[c] = m;
    const got = new Set(Object.keys(m).filter((k) => m[k] === "on"));
    const want = todayOn({
      settings: settings.find((s) => s.client_id === c) || null,
      subs: subs.filter((s) => s.client_id === c),
      plans,
      grants: grants.filter((g) => g.client_id === c),
      now,
    });
    const same = sorted(got) === sorted(want);
    if (!same) failed++;
    const locked = Object.keys(m).filter((k) => m[k] === "locked").sort();
    const off = Object.keys(m).filter((k) => m[k] === "off").sort();
    console.log(`${same ? "SAME" : "DIFF"}  ${c}`);
    console.log(`      on (${got.size}): ${sorted(got) || "-"}`);
    if (!same) {
      console.log(`      today has but the resolver does not: ${[...want].filter((k) => !got.has(k)).sort().join(",") || "-"}`);
      console.log(`      the resolver has but today does not: ${[...got].filter((k) => !want.has(k)).sort().join(",") || "-"}`);
    }
    console.log(`      locked: ${locked.join(",") || "-"}   off: ${off.join(",") || "-"}`);
  }

  if (livePath) {
    const live = readJson(livePath);
    console.log("\nlive resolver against the tested one:");
    for (const c of clients) {
      const a = resolvedLocal[c] || {};
      const b = live[c];
      if (!b) { console.log(`MISSING  ${c}: the live answer has no entry`); failed++; continue; }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      const diff = keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: tested ${a[k]}, live ${b[k]}`);
      console.log(`${diff.length ? "DIFF" : "SAME"}  ${c}${diff.length ? "   " + diff.join("; ") : ""}`);
      if (diff.length) failed++;
    }
  }

  console.log(failed ? `\n${failed} COMPANY CHECK(S) DIFFER` : "\nEVERY COMPANY AGREES");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
