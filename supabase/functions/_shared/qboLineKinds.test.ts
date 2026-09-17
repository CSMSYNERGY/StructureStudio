// The three copies of the QuickBooks line-kind list must agree (see qboLineKinds.ts for the
// 2026-09-17 drift this pins). Reads the newest migration that re-adds the table's CHECK and the
// portal grid's QBO_KINDS, and compares both with QBO_LINE_KINDS in both directions.
//
// Dependency-free like the other _shared tests. The two file-reading cases need --allow-read on
// the repo (preflight passes it); without it they report ignored rather than failing.

import { QBO_LINE_KINDS, isQboLineKind } from "./qboLineKinds.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function sameSet(label: string, got: string[], want: readonly string[]) {
  const g = new Set(got), w = new Set(want);
  const missing = [...w].filter((k) => !g.has(k));
  const extra = [...g].filter((k) => !w.has(k));
  assert(missing.length === 0 && extra.length === 0,
    `${label} disagrees with QBO_LINE_KINDS — missing: [${missing.join(", ")}], extra: [${extra.join(", ")}]`);
}

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PORTAL_GRID = new URL("../../../portal/08-integrations.jsx", import.meta.url);
const canRead = (u: URL) => Deno.permissions.querySync({ name: "read", path: u }).state === "granted";

Deno.test("isQboLineKind accepts every listed kind and nothing else", () => {
  for (const k of QBO_LINE_KINDS) assert(isQboLineKind(k), `${k} should be accepted`);
  for (const k of ["", "Building", "discounts", "change_order", "change_order_fee", "adjustment", "vent"]) {
    assert(!isQboLineKind(k), `${JSON.stringify(k)} should be refused`);
  }
  assert(new Set(QBO_LINE_KINDS).size === QBO_LINE_KINDS.length, "QBO_LINE_KINDS has a duplicate");
});

Deno.test({
  name: "QBO_LINE_KINDS matches the newest qbo_item_map_line_kind_check in the migrations",
  ignore: !canRead(MIGRATIONS),
  fn: async () => {
    // The newest file that ADDS the constraint is the live definition — never the highest NNN
    // prefix overall, most of which do not touch this table.
    const files: string[] = [];
    for await (const e of Deno.readDir(MIGRATIONS)) {
      if (e.isFile && /^\d+_.*\.sql$/.test(e.name)) files.push(e.name);
    }
    files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || (a < b ? -1 : a > b ? 1 : 0));
    let newest: { name: string; kinds: string[] } | null = null;
    for (const name of files) {
      const sql = (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n")
        .replace(/--[^\n]*/g, "");
      const m = sql.match(/add\s+constraint\s+qbo_item_map_line_kind_check\s+check\s*\(\s*line_kind\s+in\s*\(([^)]*)\)/i);
      if (m) newest = { name, kinds: [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) };
    }
    assert(newest, "no migration adds qbo_item_map_line_kind_check — the test cannot find the CHECK");
    sameSet(`the CHECK in ${newest!.name}`, newest!.kinds, QBO_LINE_KINDS);
  },
});

Deno.test({
  name: "QBO_LINE_KINDS matches the portal grid's QBO_KINDS rows",
  ignore: !canRead(PORTAL_GRID),
  fn: async () => {
    const src = (await Deno.readTextFile(PORTAL_GRID)).replace(/\r\n/g, "\n");
    const start = src.indexOf("const QBO_KINDS = [");
    assert(start >= 0, "portal/08-integrations.jsx no longer declares QBO_KINDS — update this test with it");
    const end = src.indexOf("\n];", start);
    assert(end > start, "could not find the end of QBO_KINDS");
    const block = src.slice(start, end).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const kinds = [...block.matchAll(/\[\s*"([a-z_]+)"\s*,/g)].map((x) => x[1]);
    assert(kinds.length > 0, "QBO_KINDS parsed as empty");
    sameSet("portal QBO_KINDS", kinds, QBO_LINE_KINDS);
  },
});
