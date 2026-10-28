// An in-memory stand-in for the three tables the pricing-sheet importer touches, behind just enough
// of supabase-js's query builder: select / eq / in / order / range / maybeSingle, update, insert,
// upsert (onConflict) and delete, with `.select()` after a write returning the written rows.
//
// It keeps the constraints that decide what an import can do (building_sizes is unique on
// (client_id, style_id, width_ft, length_ft) and on (style_id, label); an inclusion is unique on
// (size_id, item_key) and needs its size), runs enforce_size_pricing (no price → inactive), applies
// every statement all-or-nothing, and refuses an upsert that hits one row twice, as Postgres does.
// Every awaited statement is one entry in `calls`, so a test can count round trips.
//
// `maxRows` mimics PostgREST's db-max-rows: a read answers at most that many rows.
// `failOn` lets a test make a chosen statement fail with a chosen message.

// deno-lint-ignore-file no-explicit-any

export type Tables = {
  building_styles: any[];
  building_sizes: any[];
  building_size_inclusions: any[];
};
export type Call = { table: string; verb: string; rows: number; bulk: boolean };
type Opts = {
  maxRows?: number;
  failOn?: (c: { table: string; verb: string; payload: any[]; bulk: boolean }) => string | null;
};

// The live columns (information_schema, 2026-10-28; building_styles trimmed to what matters here).
// A statement naming any other column fails the way PostgREST does (42703). That matters:
// building_size_inclusions has NO id column — its key is (size_id, item_key) — and a first cut of
// the bulk importer that read and deleted inclusions by id passed every test against a fake that
// handed each row an id, then failed on the real table.
const SCHEMA: Record<string, Set<string>> = {
  building_styles: new Set(["id", "client_id", "key", "label", "image_url", "sort_order", "active", "code", "taxable"]),
  building_sizes: new Set(["id", "client_id", "style_id", "label", "width_ft", "length_ft", "base_price", "sort_order", "active", "created_at", "updated_at", "wall_height_ft", "manual_base_price"]),
  building_size_inclusions: new Set(["client_id", "size_id", "item_key", "included", "qty", "created_at", "updated_at"]),
};
const NUMERIC = new Set(["width_ft", "length_ft", "base_price", "qty", "sort_order"]);
const same = (col: string, a: any, b: any) => NUMERIC.has(col) ? Number(a) === Number(b) : String(a) === String(b);
const UNIQUE: Record<string, string[][]> = {
  building_sizes: [["client_id", "style_id", "width_ft", "length_ft"], ["style_id", "label"]],
  building_size_inclusions: [["size_id", "item_key"]],
  building_styles: [],
};
const DEFAULTS: Record<string, Record<string, any>> = {
  building_sizes: { sort_order: 0, active: true, base_price: null },
  building_size_inclusions: { included: true, qty: 1 },
  building_styles: {},
};

export function fakeDb(seed: Partial<Tables>, opts: Opts = {}) {
  let seq = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  // A table with an id column gives every row one (gen_random_uuid()); a seed may leave it out.
  const withId = (table: string, r: any) => SCHEMA[table].has("id") ? { id: r.id ?? newId(), ...r } : { ...r };
  const rowsOf = (table: keyof Tables) => (seed[table] ?? []).map((r) => withId(table, r));
  const tables: Tables = {
    building_styles: rowsOf("building_styles"),
    building_sizes: rowsOf("building_sizes"),
    building_size_inclusions: rowsOf("building_size_inclusions"),
  };
  for (const [table, rows] of Object.entries(tables)) {
    for (const r of rows) for (const c of Object.keys(r)) if (!SCHEMA[table].has(c)) throw new Error(`pricingImportFake: seed column ${table}.${c} does not exist`);
  }
  const calls: Call[] = [];

  const trigger = (table: string, row: any) => {
    if (table === "building_sizes" && row.base_price == null) row.active = false;   // enforce_size_pricing
    return row;
  };
  const check = (table: keyof Tables, rows: any[]): string | null => {
    for (const cols of UNIQUE[table]) {
      const seen = new Set<string>();
      for (const r of rows) {
        const k = cols.map((c) => NUMERIC.has(c) ? Number(r[c]) : String(r[c])).join("|");
        if (seen.has(k)) return `duplicate key value violates unique constraint "${table}_${cols.join("_")}"`;
        seen.add(k);
      }
    }
    if (table === "building_size_inclusions") {
      const ids = new Set(tables.building_sizes.map((z) => z.id));
      if (rows.some((r) => !ids.has(r.size_id))) return 'insert or update on table "building_size_inclusions" violates foreign key constraint';
    }
    return null;
  };

  const run = (table: keyof Tables, ops: any[][]) => {
    const find = (name: string) => ops.find((o) => o[0] === name);
    const verb = ["update", "insert", "upsert", "delete"].find((v) => find(v)) ?? "select";
    const filters = ops.filter((o) => o[0] === "eq" || o[0] === "in");
    const matches = (r: any) => filters.every(([op, col, v]) => op === "eq" ? same(col, r[col], v) : (v as any[]).some((x) => same(col, r[col], x)));
    const one = !!(find("maybeSingle") || find("single"));
    const returning = verb !== "select" && !!find("select");
    const payloadOf = (v: any) => Array.isArray(v) ? v : [v];
    const writeArg = verb === "select" || verb === "delete" ? null : find(verb)![1];
    const payload = writeArg == null ? [] : payloadOf(writeArg);
    const bulk = Array.isArray(writeArg) || (verb === "delete" && filters.some((f) => f[0] === "in"));
    calls.push({ table, verb, rows: payload.length, bulk });
    const named = [
      ...ops.filter((o) => o[0] === "select" && typeof o[1] === "string").flatMap((o) => String(o[1]).split(",").map((c) => c.trim())),
      ...filters.map((f) => f[1] as string),
      ...ops.filter((o) => o[0] === "order").map((o) => o[1] as string),
      ...payload.flatMap((p) => Object.keys(p)),
      ...(verb === "upsert" ? String(find("upsert")![2]?.onConflict ?? "id").split(",").map((c) => c.trim()) : []),
    ];
    const unknown = named.find((c) => c && c !== "*" && !SCHEMA[table].has(c));
    if (unknown) return { data: null, error: { code: "42703", message: `column ${table}.${unknown} does not exist` } };
    const injected = verb === "select" ? null : opts.failOn?.({ table, verb, payload, bulk }) ?? null;
    if (injected) return { data: null, error: { message: injected } };

    const cur = tables[table];
    if (verb === "select") {
      let rows = cur.filter(matches).map((r) => ({ ...r }));
      const orders = ops.filter((o) => o[0] === "order").map((o) => o[1] as string);
      if (orders.length) rows.sort((a, b) => { for (const c of orders) { const x = String(a[c]), y = String(b[c]); if (x !== y) return x < y ? -1 : 1; } return 0; });
      const range = find("range");
      if (range) rows = rows.slice(range[1], range[2] + 1);
      rows = rows.slice(0, opts.maxRows ?? Infinity);
      return { data: one ? (rows[0] ?? null) : rows, error: null };
    }

    // Writes: build the table as it would be, check it, then commit — all or nothing.
    let next = cur.map((r) => ({ ...r }));
    let written: any[] = [];
    if (verb === "delete") {
      next = next.filter((r) => !matches(r));
    } else if (verb === "update") {
      next = next.map((r) => matches(r) ? (written.push(trigger(table, { ...r, ...payload[0] })), written[written.length - 1]) : r);
    } else if (verb === "insert") {
      written = payload.map((p) => trigger(table, withId(table, { ...DEFAULTS[table], ...p })));
      next.push(...written);
    } else {
      const target = String(find("upsert")![2]?.onConflict ?? "id").split(",").map((s) => s.trim());
      const hit = new Set<any>();
      for (const p of payload) {
        const i = next.findIndex((r) => target.every((c) => same(c, r[c], p[c])));
        if (i >= 0) {
          if (hit.has(next[i])) return { data: null, error: { message: "ON CONFLICT DO UPDATE command cannot affect row a second time" } };
          next[i] = trigger(table, { ...next[i], ...p });
          hit.add(next[i]);
          written.push(next[i]);
        } else {
          const r = trigger(table, withId(table, { ...DEFAULTS[table], ...p }));
          next.push(r); hit.add(r); written.push(r);
        }
      }
    }
    const bad = check(table, next);
    if (bad) return { data: null, error: { message: bad } };
    tables[table] = next as any;
    if (!returning) return { data: null, error: null };
    const back = written.map((r) => ({ ...r }));
    return { data: one ? (back[0] ?? null) : back, error: null };
  };

  const from = (table: string) => {
    const build = (ops: any[][]): any => {
      const q: any = {};
      for (const m of ["select", "eq", "in", "order", "range", "maybeSingle", "single", "update", "insert", "upsert", "delete"]) {
        q[m] = (...a: unknown[]) => build([...ops, [m, ...a]]);
      }
      q.then = (ok: any, bad: any) => Promise.resolve().then(() => run(table as keyof Tables, ops)).then(ok, bad);
      return q;
    };
    if (!(table in tables)) throw new Error(`pricingImportFake: no table ${table}`);
    return build([]);
  };
  return { sb: { from }, tables, calls };
}

/** What the tables hold, without generated ids: sizes by (style, w, l), inclusions by size + item. */
export function snapshot(t: Tables) {
  const dims = new Map(t.building_sizes.map((z) => [z.id, `${z.style_id}|${Number(z.width_ft)}|${Number(z.length_ft)}`]));
  const sizes = t.building_sizes
    .map((z) => [dims.get(z.id), { label: z.label, base_price: z.base_price == null ? null : Number(z.base_price), active: z.active, sort_order: z.sort_order }] as const)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const inclusions = t.building_size_inclusions
    .map((i) => [`${dims.get(i.size_id)}|${i.item_key}`, { qty: Number(i.qty), included: i.included }] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { sizes, inclusions };
}
