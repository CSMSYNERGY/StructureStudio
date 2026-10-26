// Every tenant table and bucket has a decided fate (2026-10-21, board item "delete_client leaves 7
// per-tenant tables behind, including crm_contacts").
//
// WHY THIS EXISTS. No table has a foreign key to client_configs. Until 10-21 a builder's rows went
// only if delete_client named their table, and 62 of the 105 tables with client_id were neither
// wiped nor reported. Since migration 321, tenant_purge() deletes from EVERY table with a client_id
// column except the ones _shared/tenantTables.ts retains: deny by default. So an unclassified table
// is no longer left behind, it is purged, and a table that should have been kept (a new ledger, a
// new signed record) would be destroyed silently. This test reads every migration to stop that:
//
//   1. A migration that creates a table with client_id (create table, create table ... as, like,
//      alter table ... add column, a rename), or a new storage bucket, fails the push until the table
//      or bucket is classified in tenantTables.ts.
//   2. A registry entry that no migration creates any more (dropped or renamed) fails too, unless it
//      is marked outsideMigrations (older than the migrations, or made by hand).
//   3. A `cascade` entry whose foreign key is not ON DELETE CASCADE on NOT NULL columns fails.
//   4. A RETAINED table with a CASCADE, NO ACTION or RESTRICT reference to a purged table fails: the
//      purge would delete the kept rows, or refuse every delete of that builder.
//   5. An exported table with a column that looks like a secret (token, hash, password, otp) that is
//      not in its exportDrop fails, and so does an exportDrop naming a column that is not there.
//   6. delete_client must purge through tenant_purge with RETAINED_TABLES, export EXPORT_TABLES
//      first, delete no table itself but billing_customers (the gateway step's hook), and take its
//      reports and its bucket sweep from the registry, not a literal list.
//
// The parser is small and deliberately conservative: comments are dropped, string contents masked,
// dollar quotes treated as transparent (so DDL inside a DO block counts). It runs over the real
// migrations and over planted ones below, which is how it proves it can fail.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CHECKED_BUCKETS, COUNTED_AFTER_DELETE, EXPORT_TABLES, EXPORTED_BUCKETS, RETAINED_TABLES, SWEPT_BUCKETS, TENANT_BUCKETS, TENANT_TABLES,
} from "../tenantTables.ts";

// ─── The migration reader ──────────────────────────────────────────────────────────────────────

interface Col { notNull: boolean }
interface Fk { name: string; cols: string[]; parent: string; onDelete: string }
interface Table { cols: Map<string, Col>; fks: Fk[]; file: string; ctasClientId?: boolean }
export interface Schema { tables: Map<string, Table>; buckets: Map<string, string> }

/** Comments removed, string contents masked as '#n' (values kept in `strs`), $tag$ markers dropped,
 *  double-quoted identifiers unquoted. Lower-cased: every identifier here is lower case. */
function scrub(sql: string): { text: string; strs: string[] } {
  const strs: string[] = [];
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "-" && n === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const j = sql.indexOf("*/", i + 2); i = j < 0 ? sql.length : j + 2; out += " "; continue; }
    if (c === "'") {
      let j = i + 1, s = "";
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        s += sql[j++];
      }
      out += `'#${strs.length}'`;
      strs.push(s);
      i = j + 1;
      continue;
    }
    if (c === '"') { const j = sql.indexOf('"', i + 1); out += sql.slice(i + 1, j < 0 ? sql.length : j); i = j < 0 ? sql.length : j + 1; continue; }
    if (c === "$") {
      const m = /^\$[a-zA-Z_0-9]*\$/.exec(sql.slice(i, i + 64));
      if (m) { out += " "; i += m[0].length; continue; }
    }
    out += c;
    i++;
  }
  return { text: out.toLowerCase(), strs };
}

/** Split at commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** The text between the parenthesis at `open` and its match. */
function balanced(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
}

/** Parenthesised contents removed, so a check (x is not null) or a default f() says nothing. */
const flat = (seg: string) => { let s = seg, prev = ""; while (s !== prev) { prev = s; s = s.replace(/\([^()]*\)/g, " "); } return s; };

const NAME = String.raw`((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)`;
/** public.x -> x; another schema -> null (not ours to classify). */
const pub = (raw: string): string | null => {
  const [a, b] = raw.split(".");
  return b === undefined ? a : a === "public" ? b : null;
};
const cols = (list: string) => list.split(",").map((c) => c.trim()).filter(Boolean);
const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|exclude)\b/;

function fkIn(seg: string, table: string, colsOf: string[], name?: string): Fk | null {
  const m = new RegExp(String.raw`\breferences\s+${NAME}`).exec(seg);
  if (!m) return null;
  const parent = pub(m[1]);
  if (!parent) return null;
  const del = /\bon\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)/.exec(seg.slice(m.index));
  return { name: name ?? `${table}_${colsOf.join("_")}_fkey`, cols: colsOf, parent, onDelete: (del?.[1] ?? "no action").replace(/\s+/g, " ") };
}

function addColumn(t: Table, table: string, seg: string) {
  const m = /^([a-z_][a-z0-9_]*)\s*(.*)$/s.exec(seg);
  if (!m) return;
  const name = m[1], rest = flat(m[2]);
  t.cols.set(name, { notNull: /\bnot\s+null\b|\bprimary\s+key\b/.test(rest) });
  const fk = fkIn(seg, table, [name]);
  if (fk) t.fks.push(fk);
}

function addConstraint(t: Table, table: string, seg: string) {
  const named = /^constraint\s+([a-z_][a-z0-9_]*)\s+(.*)$/s.exec(seg);
  const body = named ? named[2] : seg;
  const pk = /^primary\s+key\s*\(([^)]*)\)/.exec(body);
  if (pk) for (const c of cols(pk[1])) { const col = t.cols.get(c); if (col) col.notNull = true; }
  const fk = /^foreign\s+key\s*\(([^)]*)\)\s*(.*)$/s.exec(body);
  if (fk) { const f = fkIn(fk[2], table, cols(fk[1]), named?.[1]); if (f) t.fks.push(f); }
}

export function readMigrations(files: { name: string; sql: string }[]): Schema {
  const tables = new Map<string, Table>();
  const buckets = new Map<string, string>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const { text, strs } = scrub(f.sql);
    for (const raw of text.split(";")) {
      const st = raw.replace(/\s+/g, " ").trim();
      const at = st.search(/\b(create (?:unlogged )?table|alter table|drop table|insert into storage\.buckets|delete from storage\.buckets)\b/);
      if (at < 0) continue;
      const s = st.slice(at);

      let m = new RegExp(String.raw`^create (?:unlogged )?table (if not exists )?${NAME}\s*(.*)$`).exec(s);
      if (m) {
        const name = pub(m[2]);
        // "if not exists" on a table that is already there changes nothing.
        if (!name || (m[1] && tables.has(name))) continue;
        const rest = m[3];
        const t: Table = { cols: new Map(), fks: [], file: f.name };
        if (rest.startsWith("(")) {
          for (const seg of splitTop(balanced(rest, 0))) {
            const like = new RegExp(String.raw`^like ${NAME}`).exec(seg);
            if (like) {
              const src = tables.get(pub(like[1]) ?? "");
              if (src) for (const [k, v] of src.cols) t.cols.set(k, { ...v });
            } else if (CONSTRAINT_START.test(seg)) addConstraint(t, name, seg);
            else addColumn(t, name, seg);
          }
        } else if (/^as\b/.test(rest)) {
          // create table ... as select: the select list is all we can see.
          const sel = /^as (?:\(\s*)?select (.*?)(?: from |$)/.exec(rest);
          t.ctasClientId = !!sel && (/\bclient_id\b/.test(sel[1]) || /(^|[\s,.])\*/.test(sel[1]));
        } else if (/^partition of\b/.test(rest)) continue;
        tables.set(name, t);
        continue;
      }

      m = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${NAME}\s+(.*)$`).exec(s);
      if (m) {
        let name = pub(m[1]);
        if (!name) continue;
        for (const act of splitTop(m[2])) {
          const t = tables.get(name);
          let a: RegExpExecArray | null;
          if ((a = new RegExp(String.raw`^rename to ${NAME}`).exec(act))) {
            const to = pub(a[1]) ?? a[1];
            if (t) { tables.delete(name); tables.set(to, t); }
            name = to;
            continue;
          }
          if (!t) continue;
          if ((a = /^add (constraint|primary|foreign|unique|check|exclude)\b/.exec(act))) addConstraint(t, name, act.slice(4));
          else if ((a = /^add (?:column )?(?:if not exists )?(.*)$/s.exec(act))) {
            const colName = /^([a-z_][a-z0-9_]*)/.exec(a[1])?.[1];
            if (colName && !t.cols.has(colName)) addColumn(t, name, a[1]);
          } else if ((a = /^drop constraint (?:if exists )?([a-z_][a-z0-9_]*)/.exec(act))) t.fks = t.fks.filter((k) => k.name !== a![1]);
          else if ((a = /^drop (?:column )?(?:if exists )?([a-z_][a-z0-9_]*)/.exec(act))) {
            t.cols.delete(a[1]);
            t.fks = t.fks.filter((k) => !k.cols.includes(a![1]));
          } else if ((a = /^alter (?:column )?([a-z_][a-z0-9_]*) (set|drop) not null/.exec(act))) {
            const col = t.cols.get(a[1]);
            if (col) col.notNull = a[2] === "set";
          } else if ((a = /^rename constraint ([a-z_][a-z0-9_]*) to ([a-z_][a-z0-9_]*)/.exec(act))) {
            for (const k of t.fks) if (k.name === a[1]) k.name = a[2];
          } else if ((a = /^rename (?:column )?([a-z_][a-z0-9_]*) to ([a-z_][a-z0-9_]*)/.exec(act))) {
            const col = t.cols.get(a[1]);
            if (col) { t.cols.delete(a[1]); t.cols.set(a[2], col); }
            for (const k of t.fks) k.cols = k.cols.map((c) => (c === a![1] ? a![2] : c));
          }
        }
        continue;
      }

      m = /^drop table (?:if exists )?(.*?)(?: cascade| restrict)?$/.exec(s);
      if (m) { for (const n of cols(m[1])) { const p = pub(n); if (p) tables.delete(p); } continue; }

      m = /^insert into storage\.buckets \(([^)]*)\) values (.*)$/.exec(s);
      if (m) {
        const idAt = cols(m[1]).indexOf("id");
        let rest = m[2];
        for (let open = rest.indexOf("("); open >= 0; open = rest.indexOf("(")) {
          const tuple = balanced(rest, open);
          const v = /^'#(\d+)'$/.exec(splitTop(tuple)[idAt] ?? "");
          if (v) buckets.set(strs[Number(v[1])], f.name);
          rest = rest.slice(open + tuple.length + 2);
          if (!/^\s*,/.test(rest)) break;
        }
        continue;
      }

      m = /^delete from storage\.buckets where id = '#(\d+)'/.exec(s);
      if (m) buckets.delete(strs[Number(m[1])]);
    }
  }
  return { tables, buckets };
}

const hasClientId = (t: Table) => t.cols.has("client_id") || !!t.ctasClientId;

/** Everything the registry is missing, or claims wrongly, given what the migrations build. */
export function coverageProblems(schema: Schema): string[] {
  const problems: string[] = [];
  const tenant = [...schema.tables].filter(([, t]) => hasClientId(t));
  for (const [name, t] of tenant) {
    if (!TENANT_TABLES[name]) {
      problems.push(`${name} (${t.file}) has client_id but no fate in _shared/tenantTables.ts: classify it as wipe, cascade, retain, pending or special.`);
    }
  }
  for (const [name, e] of Object.entries(TENANT_TABLES)) {
    if (e.outsideMigrations) continue;
    const t = schema.tables.get(name);
    if (!t) problems.push(`${name} is in tenantTables.ts but no migration creates it any more: remove it, or mark it outsideMigrations.`);
    else if (!hasClientId(t)) problems.push(`${name} is in tenantTables.ts but has no client_id column in the migrations.`);
  }
  for (const [name, e] of Object.entries(TENANT_TABLES)) {
    if (e.fate !== "cascade") continue;
    if (!e.parent || !TENANT_TABLES[e.parent]) { problems.push(`${name}: cascade parent "${e.parent}" is not in tenantTables.ts.`); continue; }
    const t = schema.tables.get(name);
    if (!t) continue;
    const ok = t.fks.some((k) => k.parent === e.parent && k.onDelete === "cascade" && k.cols.every((c) => t.cols.get(c)?.notNull));
    if (!ok) {
      const seen = t.fks.filter((k) => k.parent === e.parent).map((k) => `(${k.cols.join(", ")}) on delete ${k.onDelete}${k.cols.every((c) => t.cols.get(c)?.notNull) ? "" : ", nullable"}`);
      problems.push(`${name}: marked cascade from ${e.parent}, but the migrations give ${seen.length ? seen.join("; ") : "no foreign key to it"}.`);
    }
  }
  // A kept row must not hang off a purged one: CASCADE would delete it, NO ACTION / RESTRICT would
  // make tenant_purge refuse every delete of a builder who has one. SET NULL only blanks a pointer.
  for (const name of RETAINED_TABLES) {
    const t = schema.tables.get(name);
    if (!t) continue;
    for (const k of t.fks) {
      const parent = TENANT_TABLES[k.parent];
      if (!parent || parent.fate === "retain" || k.onDelete === "set null" || k.onDelete === "set default") continue;
      problems.push(`${name} is retained but references ${k.parent} (${k.cols.join(", ")}) on delete ${k.onDelete}, and ${k.parent} is purged: retain ${k.parent} too, or change the key.`);
    }
  }
  const SECRET = /(^|_)(token|hash|secret|password|otp)(_|$)/;
  for (const { table, drop } of EXPORT_TABLES) {
    const t = schema.tables.get(table);
    if (!t) continue;
    if (!t.cols.has("id")) problems.push(`${table} is exported but has no id column: the export pages by id (tenantExport.ts rowsOf).`);
    for (const c of drop) if (!t.cols.has(c)) problems.push(`${table}: exportDrop names ${c}, which the migrations do not have (renamed? the secret would now be exported).`);
    for (const c of t.cols.keys()) {
      if (SECRET.test(c) && !drop.includes(c)) problems.push(`${table}.${c} looks like a secret and would go into the delete-time export: add it to exportDrop, or rename it.`);
    }
  }
  for (const [id, file] of schema.buckets) {
    if (!TENANT_BUCKETS[id]) problems.push(`storage bucket ${id} (${file}) has no fate in _shared/tenantTables.ts.`);
  }
  for (const [id, b] of Object.entries(TENANT_BUCKETS)) {
    if (!b.outsideMigrations && !schema.buckets.has(id)) problems.push(`bucket ${id} is in tenantTables.ts but no migration creates it: remove it, or mark it outsideMigrations.`);
  }
  return problems;
}

const MIG_DIR = new URL("../../../migrations/", import.meta.url);
const MIGRATIONS: { name: string; sql: string }[] = [];
for await (const e of Deno.readDir(MIG_DIR)) {
  if (e.isFile && e.name.endsWith(".sql")) MIGRATIONS.push({ name: e.name, sql: await Deno.readTextFile(new URL(e.name, MIG_DIR)) });
}
const REAL = readMigrations(MIGRATIONS);

// ─── Coverage ──────────────────────────────────────────────────────────────────────────────────

Deno.test("every table with client_id, and every bucket, has a fate in tenantTables.ts", () => {
  const problems = coverageProblems(REAL);
  assertEquals(problems, [], `\n${problems.join("\n")}`);
});

Deno.test("the reader sees what the live database had on 10-21", () => {
  // Pinned so a reader that silently stops seeing tables cannot pass the test above by seeing
  // nothing. Live: 105 tables with client_id. 7 of them no migration creates (designs,
  // client_configs, client_settings, orders and payments are older than the migrations, plus two
  // hand-made backups); 020's hand-applied backup is in the migrations but not live; 321 adds
  // deleted_clients. 105 - 7 + 1 + 1.
  const tenant = [...REAL.tables].filter(([, t]) => hasClientId(t)).map(([n]) => n);
  assert(tenant.length >= 100, `only ${tenant.length} tenant tables found in the migrations`);
  for (const t of ["crm_contacts", "style_cladding", "tenant_setup_items", "billing_consents", "building_sizes", "client_configs_styleitem_backup", "deleted_clients"]) {
    assert(tenant.includes(t), `${t} was not found`);
  }
  assert(!REAL.tables.has("building_sizes_new"), "011's rename was not followed");
  assert(!REAL.tables.has("options"), "008's drop was not followed");
  assertEquals(REAL.tables.get("crm_deals")?.cols.get("contact_id")?.notNull, false, "a later drop not null was not followed");
  assertEquals([...REAL.buckets.keys()].sort(), Object.keys(TENANT_BUCKETS).filter((b) => b !== "floor-plans").sort());
});

Deno.test("PLANTED: a new tenant table, a client_id added later, and a new bucket all fail", () => {
  const planted = readMigrations([
    ...MIGRATIONS,
    {
      name: "999_planted.sql",
      sql: [
        "-- create table public.zz_commented (client_id text);  (a comment never counts)",
        "create table if not exists public.zz_planted (",
        "  id uuid primary key default gen_random_uuid(),",
        "  client_id text not null check (client_id <> 'x; y'),",
        "  note text",
        ");",
        "create table public.zz_later (id uuid primary key);",
        "do $$ begin alter table public.zz_later add column if not exists client_id text; end $$;",
        "create table public.zz_copy (like public.crm_contacts including all);",
        "create table public.zz_renamed_from (client_id text);",
        "alter table public.zz_renamed_from rename to zz_renamed;",
        "create table public.zz_gone (client_id text); drop table if exists public.zz_gone;",
        "insert into storage.buckets (id, name, public) values ('zz-bucket', 'zz-bucket', false) on conflict do nothing;",
      ].join("\n"),
    },
  ]);
  const problems = coverageProblems(planted).join("\n");
  for (const t of ["zz_planted (999_planted.sql)", "zz_later", "zz_copy", "zz_renamed (999", "storage bucket zz-bucket"]) {
    assert(problems.includes(t), `the planted ${t} was not reported:\n${problems}`);
  }
  for (const t of ["zz_commented", "zz_gone", "zz_renamed_from"]) assert(!problems.includes(t), `${t} should not be reported:\n${problems}`);
});

Deno.test("PLANTED: a dropped table, a nullable cascade and a SET NULL cascade are claims that fail", () => {
  const planted = readMigrations([
    ...MIGRATIONS,
    {
      name: "999_planted.sql",
      sql: [
        "drop table public.tenant_setup_items;",
        "alter table public.style_cladding alter column style_id drop not null;",
        "alter table public.customer_design_links drop constraint customer_design_links_short_code_fkey;",
        "alter table public.customer_design_links add constraint cdl_fk foreign key (short_code) references public.designs (short_code) on delete set null;",
      ].join("\n"),
    },
  ]);
  const problems = coverageProblems(planted).join("\n");
  assert(problems.includes("tenant_setup_items is in tenantTables.ts but no migration creates it"), problems);
  assert(problems.includes("style_cladding: marked cascade from building_styles"), problems);
  assert(problems.includes("customer_design_links: marked cascade from designs, but the migrations give (short_code) on delete set null"), problems);
});

Deno.test("PLANTED: a kept table hanging off a purged one, and a secret in the export, both fail", () => {
  const planted = readMigrations([
    ...MIGRATIONS,
    {
      name: "999_planted.sql",
      sql: [
        "alter table public.invoice_sends add column zz_contact_id uuid references public.crm_contacts (id) on delete cascade;",
        "alter table public.billing_consents add column zz_location_id uuid references public.builder_locations (id) on delete set null;",
        "alter table public.crm_contacts add column api_token text;",
        "alter table public.customer_sessions rename column token_hash to session_token_hash;",
      ].join("\n"),
    },
  ]);
  const problems = coverageProblems(planted).join("\n");
  assert(problems.includes("invoice_sends is retained but references crm_contacts (zz_contact_id) on delete cascade"), problems);
  assert(!problems.includes("billing_consents is retained"), `a SET NULL reference only blanks a pointer:\n${problems}`);
  assert(problems.includes("crm_contacts.api_token looks like a secret"), problems);
  assert(problems.includes("customer_sessions: exportDrop names token_hash, which the migrations do not have"), problems);
  assert(problems.includes("customer_sessions.session_token_hash looks like a secret"), problems);
});

// ─── The registry's own shape ──────────────────────────────────────────────────────────────────

Deno.test("registry: Ahsan's 10-21 retention answers, and lists that add up", () => {
  const all = Object.keys(TENANT_TABLES);
  assertEquals(new Set([...RETAINED_TABLES, ...COUNTED_AFTER_DELETE]).size, all.length, "a table is in both lists, or neither");
  assertEquals(RETAINED_TABLES.length + COUNTED_AFTER_DELETE.length, all.length);
  for (const [n, t] of Object.entries(TENANT_TABLES)) {
    assert(["wipe", "cascade", "retain"].includes(t.fate), `${n}: unknown fate ${t.fate}`);
    assert(t.why.trim().length > 0, `${n} has no reason`);
    if (t.parent) assertEquals(t.fate, "cascade", `${n}: only a cascade has a parent`);
    if (t.export) assert(t.fate !== "retain", `${n}: a kept table is not exported (it is not deleted)`);
  }
  // Money and signed records: kept forever. SMS consent and opt-outs: kept as proof. The tombstone.
  for (
    const t of [
      "orders", "payments", "payment_attempts", "invoice_sends", "change_orders", "order_unlocks", "design_acceptances",
      "billing_charge_attempts", "billing_consents", "wallet_transactions", "usage_charges", "sms_consent_log", "sms_opt_outs", "deleted_clients",
    ]
  ) assert(RETAINED_TABLES.includes(t), `${t} must be retained`);
  // Customer data: exported, then deleted.
  for (
    const t of [
      "crm_contacts", "crm_notes", "crm_activities", "crm_deals", "sms_messages", "phone_calls", "phone_voicemails",
      "phone_call_recordings", "email_sends", "email_inbound", "customer_sessions",
    ]
  ) {
    assert(EXPORT_TABLES.some((e) => e.table === t), `${t} is customer data: it is exported before the purge`);
    assert(COUNTED_AFTER_DELETE.includes(t), `${t} is deleted after the export`);
  }
  assertEquals(EXPORT_TABLES.find((e) => e.table === "customer_sessions")?.drop, ["token_hash"], "a login token hash never leaves");
  assertEquals(EXPORTED_BUCKETS, ["customer-uploads"]);
  assert(EXPORTED_BUCKETS.every((b) => SWEPT_BUCKETS.includes(b)), "an exported bucket is not swept");
  assert(!SWEPT_BUCKETS.includes("signatures"), "the signature images are kept");
  assert(SWEPT_BUCKETS.every((b) => CHECKED_BUCKETS.includes(b)), "a swept bucket is not checked afterwards");
  for (const g of ["pm-attachments", "setup-screens", "tenant-exports"]) assert(!CHECKED_BUCKETS.includes(g), `${g} is checked per builder`);
});

// ─── delete_client reads the registry ──────────────────────────────────────────────────────────

const SRC = (await Deno.readTextFile(new URL("../../admin-catalog/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
const CODE = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const DEL = (() => {
  const i = CODE.indexOf('case "delete_client": {');
  const j = CODE.indexOf("\n      default:", i);
  if (i < 0 || j < 0) throw new Error("tenantTableCoverage_test: delete_client block not found — re-point the anchors");
  return CODE.slice(i, j);
})();

Deno.test("source: delete_client purges through tenant_purge with the registry's keep list, and deletes no table itself", () => {
  assert(/^import \{[^}]*\} from "\.\.\/_shared\/tenantTables\.ts";$/m.test(SRC), "admin-catalog does not import tenantTables.ts");
  const calls = [...DEL.matchAll(/sb\.rpc\("tenant_purge", \{ p_client_id: clientId, p_keep: (\w+), p_actor: actor, p_dry_run: (true|false) \}\)/g)];
  assertEquals(calls.map((m) => [m[1], m[2]]), [["RETAINED_TABLES", "true"], ["RETAINED_TABLES", "false"]], "a dry run, then the purge, both keeping RETAINED_TABLES");
  assertEquals([...DEL.matchAll(/\.from\("([^"]+)"\)\.delete\(/g)].map((m) => m[1]), [], "delete_client deletes a table itself again");
  assertEquals([...DEL.matchAll(/\bwipe\("([^"]+)"\)/g)].map((m) => m[1]), ["billing_customers"], "only the gateway step's hook deletes directly");
  assert(/await forgetTwilioAccount\(sb, clientId, twPlan\.row\)/.test(DEL), "the Twilio account row is no longer removed (with its Vault secrets) before the purge");
});

Deno.test("source: the export, the reports and the storage sweep come from the registry", () => {
  assert(!/for \(\s*const \w+ of \[\s*"/.test(DEL), "delete_client loops over a literal list again: take it from tenantTables.ts");
  assert(/buildTenantExport\(sb, clientId, \{ tables: EXPORT_TABLES, buckets: EXPORTED_BUCKETS \}\)/.test(DEL), "the export does not use EXPORT_TABLES and EXPORTED_BUCKETS");
  assert(/countTenantRows\(RETAINED_TABLES\.filter/.test(DEL), "retained is not counted over RETAINED_TABLES");
  assert(/countTenantRows\(COUNTED_AFTER_DELETE\)/.test(DEL), "leftBehind is not counted over COUNTED_AFTER_DELETE");
  assert(/for \(const bucket of SWEPT_BUCKETS\) \{\s*if \(notExported\.has\(bucket\)\) continue;/.test(DEL), "the sweep does not use SWEPT_BUCKETS, or sweeps files the export could not take");
  assert(/await sweepPrefix\(sb, bucket, clientId\)/.test(DEL), "the sweep is not recursive (storageTree.ts sweepPrefix)");
  assert(/CHECKED_BUCKETS\.map\(async \(bucket\)/.test(DEL), "what is left in storage is not checked over CHECKED_BUCKETS");
  const purgeAt = DEL.indexOf("p_dry_run: false");
  for (const read of ['from("client_users").select("user_id").eq("client_id", clientId)', 'from("client_settings")', 'from("sms_numbers").select("phone_number")']) {
    const i = DEL.indexOf(read);
    assert(i > 0 && i < purgeAt, `${read} must be read BEFORE the purge takes the rows`);
  }
  for (const after of ["countTenantRows(COUNTED_AFTER_DELETE)", "await sweepPrefix(", "await rsDeleteDomain(", "await qboEndpoints()"]) {
    assert(DEL.indexOf(after) > purgeAt, `${after} must come after the purge committed`);
  }
});

Deno.test("source: create_client refuses a deleted builder's id", () => {
  const i = CODE.indexOf('case "create_client": {');
  const create = CODE.slice(i, CODE.indexOf("\n      case ", i + 10));
  assert(/sb\.from\("deleted_clients"\)\.select\("deleted_at"\)\.eq\("client_id", clientId\)\.maybeSingle\(\)/.test(create), "create_client does not read the tombstone");
  assert(/RETAINED_TABLES\.filter/.test(create), "create_client does not look for kept rows under the id");
  const refuse = create.indexOf("can't be used again");
  assert(refuse > 0 && refuse < create.indexOf('.from("client_configs").insert('), "the refusal is not ahead of the tenant row's insert");
});
