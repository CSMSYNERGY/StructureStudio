// The pricing-sheet importer (importPricingRows) exists twice — admin-catalog (both operator
// consoles) and portal-settings (the builder's Structures upload). Each copy is LIFTED from the
// shipped source and run against a fake client, so a drift in either fails the push.
//
// What is pinned: a style name that more than one building style answers to (label OR key,
// hidden styles included) must not resolve to one of them. Last-writer-wins used to send the
// whole sheet's prices to whichever row the unordered select returned last — possibly a HIDDEN
// style — while the live style kept quoting its old prices and the banner reported success.

import { assert, assertEquals } from "jsr:@std/assert";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");

async function lift(rel: string): Promise<(sb: unknown, clientId: string, rows: unknown[]) => Promise<any>> {
  const src = await read(rel);
  const i = src.indexOf("async function importPricingRows(");
  const j = i < 0 ? -1 : src.indexOf("\n}\n", i);
  if (i < 0 || j < 0) throw new Error(`importPricingStyleMatch_test: importPricingRows not found in ${rel} — re-point the anchors rather than deleting this test.`);
  const body = `export ${src.slice(i, j + 2)}`;
  const mod = await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(body)))}`);
  return mod.importPricingRows;
}

/** Just enough of supabase-js for importPricingRows: selects resolve to fixed rows, writes are recorded. */
function fakeSb(tables: Record<string, any[]>) {
  const writes: { table: string; op: string; row?: any; id?: string }[] = [];
  const from = (table: string) => {
    const q: any = {
      _op: "select", _row: null as any, _id: null as any,
      select() { return q; },
      eq(col: string, v: string) { if (col === "id") q._id = v; return q; },
      update(row: any) { q._op = "update"; q._row = row; return q; },
      insert(row: any) { q._op = "insert"; q._row = row; return q; },
      upsert(row: any) { writes.push({ table, op: "upsert", row }); return Promise.resolve({ error: null }); },
      delete() { q._op = "delete"; return q; },
      maybeSingle() {
        writes.push({ table, op: q._op, row: q._row });
        return Promise.resolve({ data: { id: `new-${writes.length}` }, error: null });
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        if (q._op === "select") return Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
        writes.push({ table, op: q._op, row: q._row, id: q._id });
        return Promise.resolve({ error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { sb: { from }, writes };
}

const STYLES = [
  { id: "st-hidden", key: "barn", label: "Barn" },     // the old one, hidden by the builder
  { id: "st-live", key: "barn-2", label: "Barn" },     // the fresh one customers see
  { id: "st-shed", key: "shed", label: "Shed" },
];
const SIZES = [
  { id: "sz-h", style_id: "st-hidden", width_ft: 10, length_ft: 12, sort_order: 0 },
  { id: "sz-l", style_id: "st-live", width_ft: 10, length_ft: 12, sort_order: 0 },
  { id: "sz-s", style_id: "st-shed", width_ft: 8, length_ft: 10, sort_order: 0 },
];

for (const rel of ["../../admin-catalog/index.ts", "../../portal-settings/index.ts"]) {
  Deno.test(`${rel.split("/")[2]}: an ambiguous style name is skipped by name, never written to one of them`, async () => {
    const importPricingRows = await lift(rel);
    const { sb, writes } = fakeSb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: [] });
    const out = await importPricingRows(sb, "acme", [
      { style: "Barn", width: "10", length: "12", price: "5000", active: "yes", inclusions: {} },
      { style: "Shed", width: "8", length: "10", price: "2500", active: "yes", inclusions: {} },
    ]);
    const sizeWrites = writes.filter((w) => w.table === "building_sizes");
    assertEquals(sizeWrites.length, 1, "only the unambiguous Shed row may write");
    assertEquals(sizeWrites[0].id, "sz-s");
    assertEquals(sizeWrites[0].row.base_price, 2500);
    assertEquals(out.updated, 1);
    assert(out.skipped.length === 1 && /more than one building style/.test(out.skipped[0]), JSON.stringify(out.skipped));
  });

  Deno.test(`${rel.split("/")[2]}: a style's own label and key are one claim, not two`, async () => {
    const importPricingRows = await lift(rel);
    const { sb, writes } = fakeSb({ building_styles: [{ id: "st-1", key: "shed", label: "Shed" }], building_sizes: [], building_size_inclusions: [] });
    const out = await importPricingRows(sb, "acme", [{ style: "shed", width: "8", length: "10", price: "", active: "", inclusions: {} }]);
    assertEquals(out.skipped, []);
    const ins = writes.find((w) => w.table === "building_sizes" && w.op === "insert");
    assert(ins, "the size should be created");
    // NULL-base-price contract: a blank price is NULL and never offered.
    assertEquals(ins.row.base_price, null);
    assertEquals(ins.row.active, false);
  });
}
