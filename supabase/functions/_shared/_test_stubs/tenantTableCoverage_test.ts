// Every tenant table and bucket has a decided fate (2026-10-21, board item "delete_client leaves 7
// per-tenant tables behind, including crm_contacts").
//
// WHY THIS EXISTS. No table has a foreign key to client_configs, so a builder's rows go only if
// delete_client names their table, and nothing noticed when a new table was not named: on 10-21, 62
// of the 105 tables with client_id were neither wiped nor reported. _shared/tenantTables.ts now
// gives every one of them a fate, and this test reads every migration to keep it that way:
//
//   1. A migration that creates a table with client_id (create table, create table ... as, like,
//      alter table ... add column, a rename), or a new storage bucket, fails the push until the table
//      or bucket is classified in tenantTables.ts.
//   2. A registry entry that no migration creates any more (dropped or renamed) fails too, unless it
//      is marked outsideMigrations (made by hand).
//   3. A `cascade` entry whose foreign key is not ON DELETE CASCADE on NOT NULL columns, read from
//      the migrations, fails: a nullable or SET NULL key leaves rows behind that the entry says go.
//   4. delete_client's own wipe calls must be exactly the registry's `now` wipes, and its retained
//      and left-behind counts and its bucket sweep must come from the registry, not a literal list.
//
// The parser is small and deliberately conservative: comments are dropped, string contents masked,
// dollar quotes treated as transparent (so DDL inside a DO block counts). It runs over the real
// migrations and over planted ones below, which is how it proves it can fail.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CHECKED_BUCKETS, COUNTED_AFTER_DELETE, RETAINED_TABLES, SWEPT_BUCKETS, TENANT_BUCKETS, TENANT_TABLES, WIPED_BY_DELETE,
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
  // hand-made backups); 020's hand-applied backup is in the migrations but not live. 105 - 7 + 1.
  const tenant = [...REAL.tables].filter(([, t]) => hasClientId(t)).map(([n]) => n);
  assert(tenant.length >= 99, `only ${tenant.length} tenant tables found in the migrations`);
  for (const t of ["crm_contacts", "style_cladding", "tenant_setup_items", "billing_consents", "building_sizes", "client_configs_styleitem_backup"]) {
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

// ─── The registry's own shape ──────────────────────────────────────────────────────────────────

Deno.test("registry: the lists delete_client reads add up, and every fate is complete", () => {
  const all = Object.keys(TENANT_TABLES);
  assertEquals(new Set([...WIPED_BY_DELETE, ...RETAINED_TABLES, ...COUNTED_AFTER_DELETE]).size, all.length, "a table is in two lists, or none");
  assertEquals(WIPED_BY_DELETE.length + RETAINED_TABLES.length + COUNTED_AFTER_DELETE.length, all.length);
  for (const [n, t] of Object.entries(TENANT_TABLES)) {
    assert(t.why.trim().length > 0, `${n} has no reason`);
    if (t.now) assertEquals(t.fate, "wipe", `${n}: only a wipe can be "now"`);
    if (t.parent) assertEquals(t.fate, "cascade", `${n}: only a cascade has a parent`);
    if (t.proposed) assertEquals(t.fate, "pending", `${n}: only a pending table has a proposal`);
  }
  for (const t of ["orders", "payments", "invoice_sends", "billing_consents", "wallet_transactions", "usage_charges", "design_acceptances"]) {
    assert(RETAINED_TABLES.includes(t), `${t} is a financial or signed record and must be retained`);
  }
  for (const t of ["crm_contacts", "sms_messages", "phone_calls", "email_sends", "customer_sessions"]) {
    assertEquals(TENANT_TABLES[t].fate, "pending", `${t} waits on Carolyn's retention decision`);
  }
  assert(SWEPT_BUCKETS.every((b) => CHECKED_BUCKETS.includes(b)), "a swept bucket is not checked afterwards");
  assert(!CHECKED_BUCKETS.includes("pm-attachments") && !CHECKED_BUCKETS.includes("setup-screens"), "a global bucket is checked per builder");
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

Deno.test("source: delete_client wipes exactly the registry's `now` tables", () => {
  const deleted = new Set([
    ...[...DEL.matchAll(/\bwipe\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...DEL.matchAll(/\.from\("([^"]+)"\)\.delete\(/g)].map((m) => m[1]),
  ]);
  assert(/await forgetTwilioAccount\(sb, clientId, twPlan\.row\)/.test(DEL), "the Twilio account row is no longer removed");
  deleted.add("twilio_accounts");
  const extra = [...deleted].filter((t) => !WIPED_BY_DELETE.includes(t));
  const missing = WIPED_BY_DELETE.filter((t) => !deleted.has(t));
  assertEquals(extra, [], `delete_client deletes tables tenantTables.ts does not mark now: ${extra.join(", ")}`);
  assertEquals(missing, [], `tenantTables.ts marks tables now that delete_client does not delete: ${missing.join(", ")}`);
});

Deno.test("source: retained, leftBehind and the bucket sweep come from the registry", () => {
  assert(/^import \{[^}]*\} from "\.\.\/_shared\/tenantTables\.ts";$/m.test(SRC), "admin-catalog does not import tenantTables.ts");
  assert(!/for \(\s*const \w+ of \[\s*"/.test(DEL), "delete_client loops over a literal list again: take it from tenantTables.ts");
  assert(/countTenantRows\(RETAINED_TABLES\)/.test(DEL), "retained is not counted over RETAINED_TABLES");
  assert(/countTenantRows\(COUNTED_AFTER_DELETE\)/.test(DEL), "leftBehind is not counted over COUNTED_AFTER_DELETE");
  assert(/for \(const bucket of SWEPT_BUCKETS\)/.test(DEL), "the storage sweep does not use SWEPT_BUCKETS");
  assert(/CHECKED_BUCKETS\.map\(async \(bucket\)/.test(DEL), "what is left in storage is not checked over CHECKED_BUCKETS");
  // Counted after the last table wipe and before the logins go, as the 10-05 report was.
  const after = DEL.indexOf("countTenantRows(COUNTED_AFTER_DELETE)");
  assert(after > DEL.lastIndexOf('await wipe("qbo_item_map")') && after > DEL.indexOf('from("phone_number_requests").delete('), "leftBehind is counted before a wipe");
  assert(after < DEL.indexOf('await wipe("client_users")'), "leftBehind is counted after the logins are gone");
});
