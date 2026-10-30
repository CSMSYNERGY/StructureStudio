// The sizes table's server half (_shared/pricingCells.ts and _shared/pagedRead.ts, 2026-10-30), run
// against pricingImportFake.ts's tables and a stubbed rpc. migration350.test.cjs (tests/sql) runs the
// database function itself; pricingTableWiring_test.ts drives the two portal-settings actions.
//
// WHAT IS PINNED:
//   1. validatePayload refuses, before anything is called: more than 50 entries, more than 2,500
//      boxes, a malformed uuid anywhere, a size entry with no version or a malformed one, an edit whose
//      `from` does not name exactly what its `to` changes, a `to` that changes nothing, a quantity that
//      is not a whole number, a field the table does not save, and one size named twice. It labels a
//      new size the importer's way (10.5x12) and copies out only what the function reads.
//   2. The number rules answer the shared table (pricingParseCases.ts) the browser is held to.
//   3. savePricingCells: the rpc gets the tenant it was given and the checked lists, its answer goes
//      back as it came, a gateway blip is retried and a Postgres error is not, and the audit row holds
//      counts and nothing else.
//   4. readSizeTable: 1,200 inclusions come back whole from a database that answers 1,000 rows a
//      read, in two pages; the counts match; no read carries a list of ids; Real-Time Pricing reads
//      off without a settings row.
//
// Tenants, styles and sizes are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  auditNote, MAX_CALL_CELLS, MAX_CALL_ENTRIES, parseDim, parsePrice, parseQty, readSizeTable, savePricingCells,
  validatePayload,
} from "../pricingCells.ts";
import { countRows, readAllPaged } from "../pagedRead.ts";
import { fakeDb } from "./pricingImportFake.ts";
import { DIM_CASES, PRICE_CASES, QTY_CASES } from "./pricingParseCases.ts";

const T = "acme-sheds";
const OTHER = "bravo-barns";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V = "2026-10-30T14:41:07.123456+00:00";   // a version as PostgREST writes one
const edit = (n: number, extra: Record<string, unknown> = {}) =>
  ({ id: uid(n), base: V, from: { price: 400, cells: { loft: 50 } }, to: { price: 480, cells: { loft: 60 } }, ...extra });

// ─── 1. validatePayload ────────────────────────────────────────────────────────────────────────
Deno.test("validatePayload: a good body passes, labelled the importer's way, with only what the function reads", () => {
  const r = validatePayload({
    action: "save_pricing_cells", targetClientId: OTHER,
    creates: [{ id: uid(1), styleId: uid(2), width: 10.5, length: 12, label: "made up by the browser", extra: true }],
    removes: [uid(3)],
    sizes: [{ id: uid(4), base: V, from: { price: null, active: false }, to: { price: 4800.555, active: true } }],
  });
  assert(r.ok, JSON.stringify(r));
  assertEquals(r.value.creates, [{ id: uid(1), styleId: uid(2), width: 10.5, length: 12, label: "10.5x12" }]);
  assertEquals(r.value.removes, [uid(3)]);
  assertEquals(r.value.sizes, [{ id: uid(4), base: V, from: { price: null, active: false }, to: { price: 4800.555, active: true } }]);
  const whole = validatePayload({ creates: [{ id: uid(1), styleId: uid(2), width: 12, length: 24 }] });
  assertEquals(whole.ok && whole.value.creates[0].label, "12x24", "a whole-foot size has no decimals in its label");
});

Deno.test("validatePayload: 51 entries are refused, 50 pass", () => {
  const fifty = { creates: [{ id: uid(1), styleId: uid(900), width: 8, length: 8 }], removes: [uid(2), uid(3)],
    sizes: Array.from({ length: 47 }, (_, i) => edit(100 + i)) };
  assertEquals(1 + 2 + 47, MAX_CALL_ENTRIES);
  assert(validatePayload(fifty).ok);
  const r = validatePayload({ ...fifty, removes: [...fifty.removes, uid(4)] });
  assert(!r.ok && /At most 50/.test(r.error), JSON.stringify(r));
});

Deno.test("validatePayload: 2,501 boxes are refused, 2,500 pass", () => {
  const box = (n: number, from: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`item${i}`, from]));
  // 50 sizes x 50 boxes = 2,500.
  const sizes = Array.from({ length: 50 }, (_, i) => ({ id: uid(200 + i), base: V, from: { cells: box(50, 0) }, to: { cells: box(50, 1) } }));
  assertEquals(50 * 50, MAX_CALL_CELLS);
  assert(validatePayload({ sizes }).ok);
  sizes[49] = { ...sizes[49], from: { cells: box(51, 0) }, to: { cells: box(51, 1) } };
  const r = validatePayload({ sizes });
  assert(!r.ok && /2500 option boxes/.test(r.error), JSON.stringify(r));
});

Deno.test("validatePayload: a malformed uuid anywhere is refused", () => {
  const bad = "not-a-uuid";
  for (const body of [
    { creates: [{ id: bad, styleId: uid(2), width: 8, length: 8 }] },
    { creates: [{ id: uid(1), styleId: bad, width: 8, length: 8 }] },
    { removes: [bad] },
    { removes: [123] },
    { sizes: [edit(1, { id: bad })] },
    { sizes: [edit(1, { id: `${uid(1)}' or 1=1` })] },
  ]) {
    const r = validatePayload(body);
    assert(!r.ok && /uuid/.test(r.error), JSON.stringify([body, r]));
  }
});

Deno.test("validatePayload: every size entry carries the version it was made against", () => {
  const { base: _gone, ...noBase } = edit(1);
  for (const s of [noBase, edit(1, { base: "" }), edit(1, { base: "yesterday" }), edit(1, { base: 1730000000 }), edit(1, { base: "2026-10-30" })]) {
    const r = validatePayload({ sizes: [s] });
    assert(!r.ok && /base/.test(r.error), JSON.stringify([s, r]));
  }
  for (const base of ["2026-10-30T14:41:07+00:00", "2026-10-30T14:41:07.1+00:00", "2026-10-30 14:41:07.123456+00", "2026-10-30T14:41:07.123Z"]) {
    assert(validatePayload({ sizes: [edit(1, { base })] }).ok, base);
  }
});

Deno.test("validatePayload: from names exactly what to changes, and to changes something", () => {
  const cases: [any, RegExp][] = [
    [{ from: {}, to: { price: 1 } }, /price/],
    [{ from: { price: 1 }, to: { cells: { loft: 1 } } }, /price/],
    [{ from: { active: true }, to: { price: 1, active: false } }, /price/],
    [{ from: { cells: { loft: 1 } }, to: { cells: { loft: 2, shelf: 1 } } }, /same boxes/],
    [{ from: { cells: { loft: 1, shelf: 0 } }, to: { cells: { loft: 2 } } }, /same boxes/],
    [{ from: {}, to: {} }, /changes nothing/],
    [{ from: { cells: {} }, to: { cells: {} } }, /changes nothing/],
    [{ to: { price: 1 } }, /from must be an object/],
    [{ from: { price: 1 }, to: [] }, /to must be an object/],
  ];
  for (const [sides, want] of cases) {
    const r = validatePayload({ sizes: [{ id: uid(1), base: V, ...sides }] });
    assert(!r.ok && want.test(r.error), JSON.stringify([sides, r]));
  }
});

Deno.test("validatePayload: values have their types; the stored-value ranges are the function's", () => {
  const refused: any[] = [
    { from: { price: 1 }, to: { price: "480" } },
    { from: { price: 1 }, to: { price: Number.NaN } },
    { from: { active: true }, to: { active: "false" } },
    { from: { cells: { loft: 0 } }, to: { cells: { loft: 2.5 } } },
    { from: { cells: { loft: 0 } }, to: { cells: { loft: -1 } } },
    { from: { cells: { loft: 0 } }, to: { cells: { loft: "yes" } } },
    { from: { cells: { loft: 0 } }, to: { cells: { loft: 3_000_000_000 } } },
    { from: { cells: { loft: 0.5 } }, to: { cells: { loft: 1 } } },
    { from: { cells: { ["k".repeat(65)]: 0 } }, to: { cells: { ["k".repeat(65)]: 1 } } },
    { from: { label: "10x12" }, to: { label: "12x12" } },
    { from: { price: 1, width_ft: 10 }, to: { price: 2, width_ft: 12 } },
  ];
  for (const sides of refused) {
    const r = validatePayload({ sizes: [{ id: uid(1), base: V, ...sides }] });
    assert(!r.ok, JSON.stringify(sides));
  }
  // A negative price and a quantity past 999,999 are well formed: whether they stand depends on the
  // stored value (a value equal to it is always accepted), so the function refuses them per box.
  assert(validatePayload({ sizes: [{ id: uid(1), base: V, from: { price: -5 }, to: { price: -6 } }] }).ok);
  assert(validatePayload({ sizes: [{ id: uid(1), base: V, from: { cells: { loft: 0 } }, to: { cells: { loft: 1_500_000 } } }] }).ok);
  assert(validatePayload({ sizes: [{ id: uid(1), base: V, from: { price: 400 }, to: { price: null } }] }).ok, "a blank price is null");
});

Deno.test("validatePayload: one size named twice in a save is refused; nothing at all is refused", () => {
  for (const body of [
    { sizes: [edit(1), edit(1)] },
    { creates: [{ id: uid(1), styleId: uid(9), width: 8, length: 8 }], sizes: [edit(1)] },
    { removes: [uid(1)], sizes: [edit(1)] },
    { removes: [uid(1), uid(1).toUpperCase()] },
  ]) {
    const r = validatePayload(body);
    assert(!r.ok && /twice/.test(r.error), JSON.stringify([body, r]));
  }
  for (const body of [{}, { creates: [], removes: [], sizes: [] }, null]) {
    const r = validatePayload(body);
    assert(!r.ok && /Nothing to save/.test(r.error), JSON.stringify(body));
  }
  const r = validatePayload({ sizes: "everything" });
  assert(!r.ok && /lists/.test(r.error));
});

Deno.test("validatePayload: a new size's width and length follow the dimension rule", () => {
  for (const [w, l] of [[0, 12], [10, 501], [10.125, 12], [-8, 8], ["10", 12], [null, 12]]) {
    const r = validatePayload({ creates: [{ id: uid(1), styleId: uid(2), width: w, length: l }] });
    assert(!r.ok && /width|length/.test(r.error), JSON.stringify([w, l, r]));
  }
  const ok = validatePayload({ creates: [{ id: uid(1), styleId: uid(2), width: 500, length: 10.25 }] });
  assert(ok.ok && ok.value.creates[0].label === "500x10.25");
});

// ─── 2. The number rules, from the table the browser is held to ───────────────────────────────
Deno.test("parsePrice / parseQty / parseDim answer the shared parse table", () => {
  for (const [parse, cases] of [[parsePrice, PRICE_CASES], [parseQty, QTY_CASES], [(t: string) => parseDim(t), DIM_CASES]] as const) {
    for (const [text, stored, want] of cases) {
      const r = (parse as (t: string, s?: number | null) => any)(text, stored);
      if (want === "error") assert(!r.ok, `${JSON.stringify(text)} (stored ${stored}) should be refused, got ${JSON.stringify(r)}`);
      else assert(r.ok && Object.is(r.value, want), `${JSON.stringify(text)} (stored ${stored}) should be ${want}, got ${JSON.stringify(r)}`);
    }
  }
  assertEquals(parsePrice("-5"), { ok: false, error: "A price is a number, 0 or more" });
  assertEquals(parseQty("yes"), { ok: false, error: "Whole numbers only, 0 or more" });
});

// ─── 3. savePricingCells ───────────────────────────────────────────────────────────────────────
const ANSWER = {
  created: [{ id: uid(1), status: "created", version: V, row: { price: null, active: false, label: "10.5x12" }, cells: {} }],
  removed: [{ id: uid(3), status: "removed" }, { id: uid(5), status: "refused", reason: "Only a size that was never priced or edited can be removed. Untick Offered to hide it." }],
  results: [
    { id: uid(4), status: "saved", version: V, row: { price: null, active: false, label: "Test Barn 12x24" }, cells: { loft: 0, shelf: 2 }, cellErrors: { ramp: "That option has no column in your sizes table" } },
    { id: uid(6), status: "conflict", version: V, row: { price: 500, active: true, label: "12x16" }, cells: {} },
  ],
};
const PAYLOAD = (() => {
  const r = validatePayload({
    creates: [{ id: uid(1), styleId: uid(2), width: 10.5, length: 12 }],
    removes: [uid(3), uid(5)],
    sizes: [
      { id: uid(4), base: V, from: { price: 400, cells: { loft: 50, shelf: 0, ramp: 0 } }, to: { price: null, cells: { loft: 0, shelf: 2, ramp: 1 } } },
      { id: uid(6), base: V, from: { price: 500 }, to: { price: 520 } },
    ],
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();

function rpcStub(answers: any[]) {
  const calls: { fn: string; args: any }[] = [];
  const sb = {
    rpc: (fn: string, args: any) => {
      calls.push({ fn, args: structuredClone(args) });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      return Promise.resolve(typeof a === "function" ? a() : a);
    },
  };
  return { sb, calls };
}
function auditStub(fail = false) {
  const rows: { action: string; rowCount: number | null | undefined; note: string | null | undefined }[] = [];
  const audit = (action: string, rowCount?: number | null, note?: string | null) => {
    rows.push({ action, rowCount, note });
    return fail ? Promise.reject(new Error("audit insert failed")) : Promise.resolve();
  };
  return { audit, rows };
}

Deno.test("savePricingCells: one rpc for the tenant it was given, the answer mapped through", async () => {
  const { sb, calls } = rpcStub([{ data: ANSWER, error: null }]);
  const { audit } = auditStub();
  const out = await savePricingCells(sb, T, PAYLOAD, audit);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "pricing_cells_apply");
  assertEquals(calls[0].args, { p_client_id: T, p_creates: PAYLOAD.creates, p_removes: PAYLOAD.removes, p_sizes: PAYLOAD.sizes });
  assertEquals(out, ANSWER);
  assertEquals(calls[0].args.p_creates[0].label, "10.5x12");
});

Deno.test("savePricingCells: a gateway blip is retried; a Postgres error is not, and is thrown", async () => {
  {
    const { sb, calls } = rpcStub([{ data: null, error: { message: "<html>502 Bad Gateway</html>" } }, { data: ANSWER, error: null }]);
    const out = await savePricingCells(sb, T, PAYLOAD, auditStub().audit);
    assertEquals(calls.length, 2, "retried once, then answered");
    assertEquals(out.results.length, 2);
  }
  {
    let n = 0;
    const { sb, calls } = rpcStub([() => { n++; throw new TypeError("connection reset"); }, { data: ANSWER, error: null }]);
    await savePricingCells(sb, T, PAYLOAD, auditStub().audit);
    assertEquals([n, calls.length], [1, 2], "a dropped connection throws, and is retried");
  }
  {
    const { sb, calls } = rpcStub([{ data: null, error: { code: "22023", message: "pricing_cells_apply: at most 50 creates, removes and sizes in one call" } }]);
    const { audit, rows } = auditStub();
    const e: any = await assertRejects(() => savePricingCells(sb, T, PAYLOAD, audit));
    assertEquals(calls.length, 1, "a SQLSTATE is the database's answer: never retried");
    assertEquals(e.code, "22023");
    assertEquals(rows.length, 0, "nothing saved, nothing audited");
  }
  {
    const { sb } = rpcStub([{ data: null, error: null }]);
    await assertRejects(() => savePricingCells(sb, T, PAYLOAD, auditStub().audit), Error, "no answer");
  }
});

Deno.test("savePricingCells: one audit row per call, holding counts and nothing else", async () => {
  const { sb } = rpcStub([{ data: ANSWER, error: null }]);
  const { audit, rows } = auditStub();
  await savePricingCells(sb, T, PAYLOAD, audit);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].action, "portal_save_pricing_cells");
  assertEquals(rows[0].rowCount, 3, "saved 1 + created 1 + removed 1");
  const note = String(rows[0].note);
  assert(/^(\w+=\d+)( \w+=\d+)*$/.test(note), note);
  assertEquals(note,
    "saved=1 created=1 removed=1 conflicts=1 refused=1 prices=1 hidden=1 cellsCleared=1 cellsSet=1 duplicates=0 exists=0 missing=0");
  for (const leak of [T, "Test Barn", "12x24", "loft", uid(4)]) assert(!note.includes(leak), `the note carries ${leak}`);
});

Deno.test("savePricingCells: an audit insert that fails does not undo a saved answer", async () => {
  const { sb } = rpcStub([{ data: ANSWER, error: null }]);
  const out = await savePricingCells(sb, T, PAYLOAD, auditStub(true).audit);
  assertEquals(out, ANSWER);
});

Deno.test("auditNote: a refused price is not counted as written, and nothing unsaved counts", () => {
  const note = auditNote(PAYLOAD, {
    created: [{ id: uid(1), status: "duplicate" }], removed: [],
    results: [{ id: uid(4), status: "saved", row: { active: true }, cellErrors: { price: "Real-Time Pricing sets prices on this account", ramp: "x" } },
      { id: uid(6), status: "duplicate" }],
  });
  assertEquals(note, "saved=1 created=0 removed=0 conflicts=0 refused=0 prices=0 hidden=0 cellsCleared=1 cellsSet=1 duplicates=2 exists=0 missing=0");
});

// ─── 4. readSizeTable / pagedRead ──────────────────────────────────────────────────────────────
// 40 sizes x 30 options = 1,200 inclusion rows: past PostgREST's 1,000-row answer.
const KEYS = Array.from({ length: 30 }, (_, i) => `item${String(i).padStart(2, "0")}`);
const STYLES = [{ id: uid(500), client_id: T, key: "test-barn", label: "Test Barn", code: "TB", active: true, sort_order: 0 },
  { id: uid(501), client_id: OTHER, key: "other", label: "Other Barn", code: "OB", active: true, sort_order: 0 }];
const SIZES = [
  ...Array.from({ length: 40 }, (_, i) => ({
    id: uid(1000 + i), client_id: T, style_id: uid(500), label: `10x${10 + i}`, width_ft: 10, length_ft: 10 + i,
    base_price: 1000 + i, active: true, sort_order: i, created_at: "2026-10-01T00:00:00+00:00", updated_at: V,
  })),
  { id: uid(2000), client_id: OTHER, style_id: uid(501), label: "8x8", width_ft: 8, length_ft: 8, base_price: 1, active: true, sort_order: 0 },
];
const INCLUSIONS = [
  ...SIZES.filter((z) => z.client_id === T).flatMap((z) => KEYS.map((k) => ({ client_id: T, size_id: z.id, item_key: k, included: true, qty: 1 }))),
  { client_id: OTHER, size_id: uid(2000), item_key: "loft", included: true, qty: 9 },
];

/** The fake's three tables, plus client_settings (service-role only, one row per builder or none). */
function world(settings: Record<string, any> | null) {
  const db = fakeDb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: INCLUSIONS }, { maxRows: 1000 });
  const sb = {
    from: (table: string) => {
      if (table !== "client_settings") return db.sb.from(table);
      const q: any = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data: settings, error: null });
      return q;
    },
  };
  return { ...db, sb };
}

Deno.test("the fake answers 1,000 rows a read, as PostgREST does, and still refuses a column the table lacks", async () => {
  const { sb } = world(null);
  const { data } = await sb.from("building_size_inclusions").select("size_id, item_key").eq("client_id", T);
  assertEquals(data.length, 1000, "an unpaged read is cut at 1,000 with no error: the bug this guards");
  const noId: any = await sb.from("building_size_inclusions").select("id", { count: "exact", head: true }).eq("client_id", T);
  assertEquals(noId.error?.code, "42703", "building_size_inclusions has no id column: count it on size_id");
});

Deno.test("readSizeTable: 1,200 inclusions in two pages, counts that match, no id list in any read", async () => {
  const { sb, calls, ins } = world(null);
  const t = await readSizeTable(sb, T);
  assertEquals(t.inclusions.length, 1200);
  assertEquals(t.sizes.length, 40);
  assertEquals(t.styles.length, 1);
  assertEquals(t.counts, { sizes: 40, inclusions: 1200 });
  assertEquals(calls.filter((c) => c.table === "building_size_inclusions" && c.verb === "select").length, 3, "two pages and one head count");
  assertEquals(ins, [], "no read carries a list of ids");
  assert(t.inclusions.every((r) => r.size_id !== uid(2000)) && t.sizes.every((z) => z.client_id === T), "only this builder's rows");
  assertEquals(new Set(t.inclusions.map((r) => `${r.size_id}|${r.item_key}`)).size, 1200, "no row twice across the page boundary");
  // The fake hands back whole rows (it does not project), but it refuses any column the live table
  // lacks, so these reads naming only real columns is checked; here, that the page gets every field
  // it draws from, the version included.
  for (const f of ["id", "style_id", "label", "width_ft", "length_ft", "base_price", "active", "sort_order", "created_at", "updated_at"]) {
    assert(f in t.sizes[0], `sizes carry ${f}`);
  }
  for (const f of ["size_id", "item_key", "included", "qty"]) assert(f in t.inclusions[0], `inclusions carry ${f}`);
  for (const f of ["id", "key", "label", "code", "active", "sort_order"]) assert(f in t.styles[0], `styles carry ${f}`);
  assertEquals(t.sizes.find((z) => z.id === uid(1000))?.updated_at, V, "the version travels verbatim");
});

Deno.test("readSizeTable: Real-Time Pricing is off without a settings row, and as the row says otherwise", async () => {
  assertEquals((await readSizeTable(world(null).sb, T)).rtpOn, false);
  assertEquals((await readSizeTable(world({ rtp_enabled: false }).sb, T)).rtpOn, false);
  assertEquals((await readSizeTable(world({ rtp_enabled: true }).sb, T)).rtpOn, true);
});

Deno.test("readSizeTable: a read the database refuses is thrown, not answered with half a table", async () => {
  const db = fakeDb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: INCLUSIONS }, { maxRows: 1000 });
  const sb = {
    from: (table: string) => {
      if (table === "building_size_inclusions") {
        const q: any = {};
        for (const m of ["select", "eq", "order", "range"]) q[m] = () => q;
        q.then = (ok: any) => Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }).then(ok);
        return q;
      }
      if (table === "client_settings") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      return db.sb.from(table);
    },
  };
  const e: any = await assertRejects(() => readSizeTable(sb, T));
  assertEquals(e.code, "57014");
});

Deno.test("pagedRead: exactly 1,000 rows takes a second, empty page; countRows throws on a refused count", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ client_id: T, size_id: uid(1000 + Math.floor(i / 25)), item_key: `item${String(i % 25).padStart(2, "0")}`, qty: 1 }));
  const db = fakeDb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: rows }, { maxRows: 1000 });
  const all = await readAllPaged(db.sb, "building_size_inclusions", "size_id, item_key", ["size_id", "item_key"], T);
  assertEquals(all.length, 1000);
  assertEquals(db.calls.filter((c) => c.verb === "select").length, 2);
  assertEquals(await countRows(db.sb, "building_size_inclusions", "size_id", T), 1000);
  await assertRejects(() => countRows(db.sb, "building_size_inclusions", "id", T));
});
