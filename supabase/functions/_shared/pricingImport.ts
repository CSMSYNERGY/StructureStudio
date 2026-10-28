// The pricing-sheet importer (import_pricing_csv): ONE copy since 2026-10-28, shared by
// portal-settings (a builder's own Settings → Structures upload) and admin-catalog (both operator
// consoles). Each function used to carry its own copy, and admin-catalog's had drifted: it still
// wrote a Partition Wall column, which 278 took out of a size's price.
//
// rows: [{ style, width, length, price, active, inclusions: { item_key: qty } }].
// Inclusion cells are QUANTITIES (2026-07-07): loft = included sq ft (e.g. 50), doors = count
// (e.g. 1); 0/blank/"no" = not included. Legacy yes-style tokens still import as quantity 1 so
// previously downloaded sheets keep working. clientId is the caller's resolved tenant — never
// trusted from the request body by portal-settings. CREATES the size if a (style, width, length)
// doesn't exist yet, otherwise UPDATES it — keyed on dimensions, so re-uploading the same sheet
// updates prices without creating duplicates. A size is offered only when active AND priced
// (blank price or active=no hides it, per the NULL-base-price contract). Never creates styles.
//
// WHY IT WRITES IN BULK. The copies this replaces walked the sheet a row at a time and a CELL at a
// time: one UPDATE or INSERT per size, then one UPSERT or DELETE per option column, blank cells
// included. A sheet of ~210 sizes with ~38 option columns is ~8,000 sequential round trips, and
// every one costs the isolate CPU (building the request, TLS, parsing the answer) on top of the
// wait. On 2026-10-27 one builder's sheet died seven times in a row after 67-129 s with "CPU Time
// exceeded" (546 WORKER_RESOURCE_LIMIT), part way through, so it could not be imported at all.
// Now the whole sheet is planned in memory first and written in a handful of calls whatever its
// size: sizes in upsert batches, included options in upsert batches, and a DELETE only where an
// inclusion is on file (a blank cell with nothing behind it costs nothing).
//
// WHAT IS UNCHANGED, pinned by _test_stubs/pricingImportBulk_test.ts against a frozen copy of the
// row-at-a-time importer: which rows are skipped and why, the created/updated counts, and what the
// tables hold afterwards. A sheet naming the same size twice still ends as its LAST row says, and
// still counts as created once and then updated, as before.
//
// IF A BATCH FAILS (a constraint the plan cannot see, e.g. a size's new label already taken by a
// size with a hand-made label), that batch is replayed one row at a time with the old calls, so
// the sheet still lands and the builder gets the same per-row "skipped" lines as before.
//
// RETRY-SAFE. Sizes are upserted on their dimensions (building_sizes_client_style_dims_uniq) and
// inclusions on (size_id, item_key), so a sheet sent twice, or re-sent after a timeout the server
// had in fact finished, updates the same rows and never makes a second copy of anything.
//
// Dependency-free (the client is passed in). Two importers: deploy portal-settings AND
// admin-catalog when this file changes.

// deno-lint-ignore-file no-explicit-any

/** Rows per bulk write: ~150 bytes a size row, ~120 an inclusion row, well inside a request body. */
export const PRICING_IMPORT_BATCH = 500;
/** Size ids per DELETE ... in (...). They ride in the URL; 100 uuids keep it near 4 KB. */
const DELETE_IDS_PER_CALL = 100;
/** PostgREST answers at most 1000 rows a read (db-max-rows), so the snapshot is read in pages. */
const READ_PAGE = 1000;
const SIZE_CONFLICT = "client_id,style_id,width_ft,length_ft";
const INCLUSION_CONFLICT = "size_id,item_key";

const YES_WORDS = ["yes", "y", "true", "x", "included"];
const INACTIVE_WORDS = ["no", "n", "0", "false", "inactive"];

// Inclusion cell -> included quantity. 0 = not included (delete the row).
// Numbers win ("50" -> 50 sq ft, "2" -> 2); legacy yes-tokens mean quantity 1;
// anything else (blank, "no", garbage) is 0 — same delete behavior as before.
function parseInclusionQty(v: unknown): number {
  if (v === true) return 1;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "") return 0;
  if (YES_WORDS.includes(s)) return 1;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
const isLegacyYes = (v: unknown) => v === true || YES_WORDS.includes(String(v ?? "").trim().toLowerCase());
const inactiveWord = (v: unknown) => INACTIVE_WORDS.includes(String(v ?? "").trim().toLowerCase());
const num = (v: unknown) => {
  const blank = v === "" || v == null;
  if (blank) return { blank: true, n: NaN };
  return { blank: false, n: Number(String(v).replace(/[$,\s]/g, "")) };
};
const fmt = (n: number) => String(n);
const dimKeyOf = (styleId: unknown, w: unknown, l: unknown) => `${styleId}|${Number(w)}|${Number(l)}`;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every row of one tenant's table, read in pages so a catalog past 1000 rows is not cut short. */
async function readAll(sb: any, table: string, cols: string, order: string[], clientId: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    let q = sb.from(table).select(cols).eq("client_id", clientId);
    for (const col of order) q = q.order(col);
    const { data, error } = await q.range(from, from + READ_PAGE - 1);
    if (error) throw error;
    const page = data ?? [];
    out.push(...page);
    if (page.length < READ_PAGE) return out;
  }
}

/** One distinct size the sheet names, with the sheet rows that named it (in sheet order). */
type SizePlan = {
  dimKey: string;
  styleId: string;
  w: number;
  l: number;
  label: string;
  price: number | null;
  active: boolean;
  existingId: string | null;
  sortOrder: number | null;   // only for a size this sheet creates
  sizeId: string | null;      // known once written
  failed: string | null;      // the write's error message, when it failed
};
type RowRef = { plan: SizePlan; styleName: string; label: string; creates: boolean };
type InclusionOp = { qty: number; styleName: string; label: string };

export async function importPricingRows(sb: any, clientId: string, rows: any[]) {
  const [styles, sizes, inclusions] = await Promise.all([
    readAll(sb, "building_styles", "id, key, label", ["id"], clientId),
    readAll(sb, "building_sizes", "id, style_id, width_ft, length_ft, sort_order", ["id"], clientId),
    readAll(sb, "building_size_inclusions", "id, size_id, item_key, qty", ["size_id", "item_key"], clientId),
  ]);
  // A cell resolves against every style's label OR key, hidden styles included — and nothing
  // makes a label unique (create_style only uniquifies the key). So with a hidden "Barn" and a
  // fresh "Barn", last-writer-wins sent a whole sheet of prices to whichever came back last,
  // possibly the hidden one, while the live style kept quoting the old numbers and the banner
  // reported them imported. A name more than one style answers to now resolves to nobody and
  // its rows are skipped by name. (The portal's Structures upload refuses the same case before
  // sending; both operator consoles reach this function with no such guard.)
  const styleByName = new Map<string, any>();
  const claimedBy = new Map<string, Set<string>>();   // lowercased label/key -> style ids
  for (const s of styles) {
    for (const tok of [s.label, s.key]) {
      const t = String(tok ?? "").trim().toLowerCase();
      if (!t) continue;
      styleByName.set(t, s);
      const ids = claimedBy.get(t) ?? new Set<string>();
      ids.add(String(s.id));
      claimedBy.set(t, ids);
    }
  }
  const sizeByDims = new Map<string, any>();   // `${style_id}|${w}|${l}` -> row
  const maxSort = new Map<string, number>();   // style_id -> highest sort_order
  for (const z of sizes) {
    sizeByDims.set(dimKeyOf(z.style_id, z.width_ft, z.length_ft), { id: z.id });
    const cur = maxSort.get(z.style_id) ?? -1;
    if ((z.sort_order ?? 0) > cur) maxSort.set(z.style_id, z.sort_order ?? 0);
  }
  // Existing inclusion quantities: a legacy "yes" cell (old saved sheet) PRESERVES a
  // configured qty (e.g. loft 50 sq ft) instead of silently downgrading it to 1. Also the
  // list of what is ON FILE, so a blank cell deletes only a row that exists.
  const existingQty = new Map<string, number>();   // `${size_id}|${item_key}` -> qty
  const existingRowId = new Map<string, string>(); // `${size_id}|${item_key}` -> the row's id
  for (const r of inclusions) {
    existingQty.set(`${r.size_id}|${r.item_key}`, Number(r.qty) || 1);
    existingRowId.set(`${r.size_id}|${r.item_key}`, r.id);
  }

  // ── 1. Plan: validate every row and work out what the tables should end up holding ──────────
  const skipped: string[] = [];
  const plans = new Map<string, SizePlan>();          // dimKey -> plan, first-seen order
  const rowRefs: RowRef[] = [];                       // one per row that reaches a write
  const inclusionPlan = new Map<string, Map<string, InclusionOp>>();   // dimKey -> item_key -> last cell
  for (const row of rows) {
    const styleName = String(row?.style ?? "").trim();
    const wv = num(row?.width), lv = num(row?.length);
    if (!styleName && wv.blank && lv.blank) continue;   // wholly blank line
    if ((claimedBy.get(styleName.toLowerCase())?.size ?? 0) > 1) {
      skipped.push(`${styleName}: more than one building style answers to this name (a hidden style counts) — rename one of them, then import again`);
      continue;
    }
    const style = styleByName.get(styleName.toLowerCase());
    if (!style) { skipped.push(`${styleName || "(blank)"}: unknown style`); continue; }
    if (wv.blank && lv.blank) { skipped.push(`${styleName}: missing width & length`); continue; }
    if (!Number.isFinite(wv.n) || !Number.isFinite(lv.n) || wv.n <= 0 || lv.n <= 0) {
      skipped.push(`${styleName} ${row?.width}x${row?.length}: invalid width/length`); continue;
    }
    const w = wv.n, l = lv.n;
    const pr = num(row?.price);
    // Negative is refused with the unparseable: nothing in the product means a building priced
    // below zero: submit-estimate would email it as a negative building line, while the
    // designer's preview clamps the line to $0, so the customer saw one number and got another.
    if (!pr.blank && (!Number.isFinite(pr.n) || pr.n < 0)) { skipped.push(`${styleName} ${w}x${l}: invalid price "${row?.price}"`); continue; }
    const price = pr.blank ? null : pr.n;
    const active = !inactiveWord(row?.active) && price != null;   // active intent AND priced
    const label = `${fmt(w)}x${fmt(l)}`;
    const dimKey = dimKeyOf(style.id, w, l);
    let plan = plans.get(dimKey);
    const creates = !plan && !sizeByDims.has(dimKey);
    if (!plan) {
      const existingId = sizeByDims.get(dimKey)?.id ?? null;
      let sortOrder: number | null = null;
      if (!existingId) { sortOrder = (maxSort.get(style.id) ?? -1) + 1; maxSort.set(style.id, sortOrder); }
      plan = { dimKey, styleId: style.id, w, l, label, price, active, existingId, sortOrder, sizeId: existingId, failed: null };
      plans.set(dimKey, plan);
    } else {
      // The same size named again: the later row's values win, as the sequential writes did.
      plan.label = label; plan.price = price; plan.active = active;
    }
    rowRefs.push({ plan, styleName, label, creates });
    const inc = (row.inclusions && typeof row.inclusions === "object") ? row.inclusions : {};
    const cells = inclusionPlan.get(dimKey) ?? new Map<string, InclusionOp>();
    for (const [itemKey, val] of Object.entries(inc)) {
      // A partition wall is never part of a size's price (278): no inclusion row is written for one,
      // whatever a sheet exported before that change carries in its column.
      if (!itemKey || itemKey === "partitionWall") continue;
      let qty = parseInclusionQty(val);
      if (qty === 1 && isLegacyYes(val)) qty = (plan.existingId ? existingQty.get(`${plan.existingId}|${itemKey}`) : undefined) ?? 1;
      cells.set(itemKey, { qty, styleName, label });
    }
    inclusionPlan.set(dimKey, cells);
  }

  // ── 2. Sizes: existing ones and new ones in separate batches ────────────────────────────────
  // An existing size's write carries no sort_order, so its place in the list is left alone; a new
  // size is placed after its style's last one, in sheet order.
  const all = [...plans.values()];
  const writeSizesOneByOne = async (batch: SizePlan[]) => {
    for (const p of batch) {
      if (p.existingId) {
        const up = await sb.from("building_sizes").update({ label: p.label, base_price: p.price, active: p.active }).eq("id", p.existingId);
        if (up.error) p.failed = up.error.message;
      } else {
        const ins = await sb.from("building_sizes").insert(
          { client_id: clientId, style_id: p.styleId, label: p.label, width_ft: p.w, length_ft: p.l,
            base_price: p.price, active: p.active, sort_order: p.sortOrder }).select("id").maybeSingle();
        if (ins.error) p.failed = ins.error.message;
        else if (!ins.data?.id) p.failed = "the new size could not be read back";
        else p.sizeId = ins.data.id;
      }
    }
  };
  for (const existing of [true, false]) {
    for (const batch of chunks(all.filter((p) => !!p.existingId === existing), PRICING_IMPORT_BATCH)) {
      const payload = batch.map((p) => ({
        client_id: clientId, style_id: p.styleId, label: p.label, width_ft: p.w, length_ft: p.l,
        base_price: p.price, active: p.active, ...(existing ? {} : { sort_order: p.sortOrder }),
      }));
      const res = await sb.from("building_sizes").upsert(payload, { onConflict: SIZE_CONFLICT })
        .select("id, style_id, width_ft, length_ft");
      if (res.error) { await writeSizesOneByOne(batch); continue; }
      const back = new Map<string, string>();
      for (const z of (Array.isArray(res.data) ? res.data : [])) back.set(dimKeyOf(z.style_id, z.width_ft, z.length_ft), z.id);
      for (const p of batch) {
        p.sizeId = back.get(p.dimKey) ?? p.existingId ?? null;
        if (!p.sizeId) p.failed = "the new size could not be read back";
      }
    }
  }

  let created = 0, updated = 0;
  for (const r of rowRefs) {
    if (r.plan.failed != null) { skipped.push(`${r.styleName} ${r.label}: ${r.plan.failed}`); continue; }
    if (r.creates) created++; else updated++;
  }

  // ── 3. Inclusions: upsert what is included, delete what is on file and now is not ───────────
  type Upsert = { row: any; op: InclusionOp; itemKey: string };
  const upserts: Upsert[] = [];
  const deletes: { id: string; sizeId: string; itemKey: string; op: InclusionOp }[] = [];
  for (const [dimKey, cells] of inclusionPlan) {
    const p = plans.get(dimKey)!;
    if (p.failed != null || !p.sizeId) continue;   // its size was not written: nor are its options
    for (const [itemKey, op] of cells) {
      if (op.qty > 0) {
        upserts.push({ itemKey, op, row: { client_id: clientId, size_id: p.sizeId, item_key: itemKey, included: true, qty: op.qty } });
      } else {
        const onFile = existingRowId.get(`${p.sizeId}|${itemKey}`);
        if (onFile) deletes.push({ id: onFile, sizeId: p.sizeId, itemKey, op });
      }
    }
  }
  const failInclusion = (op: InclusionOp, itemKey: string, message: string) =>
    skipped.push(`${op.styleName} ${op.label} / ${itemKey}: ${message}`);
  for (const batch of chunks(upserts, PRICING_IMPORT_BATCH)) {
    const res = await sb.from("building_size_inclusions").upsert(batch.map((u) => u.row), { onConflict: INCLUSION_CONFLICT });
    if (!res.error) continue;
    for (const u of batch) {
      const one = await sb.from("building_size_inclusions").upsert(u.row, { onConflict: INCLUSION_CONFLICT });
      if (one.error) failInclusion(u.op, u.itemKey, one.error.message);
    }
  }
  // By the row's own id: one call per 100 rows, however many different options the sheet clears.
  for (const batch of chunks(deletes, DELETE_IDS_PER_CALL)) {
    const res = await sb.from("building_size_inclusions").delete()
      .eq("client_id", clientId).in("id", batch.map((d) => d.id));
    if (!res.error) continue;
    for (const d of batch) {
      const one = await sb.from("building_size_inclusions").delete().eq("size_id", d.sizeId).eq("item_key", d.itemKey);
      if (one.error) failInclusion(d.op, d.itemKey, one.error.message);
    }
  }
  return { imported: created + updated, created, updated, skipped };
}
