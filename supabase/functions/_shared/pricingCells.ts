// The sizes table's server half (Settings → Sheds → "Open sizes & prices table", Carolyn 2026-10-29):
// portal-settings' size_table (the read) and save_pricing_cells (the write). The plan is
// _Extras/StructureStudio Pricing Table Editor Plan 2026-10-30.md, sections 4.1-4.4 and 4.10.
//
// THE READ (readSizeTable). Styles, sizes and inclusions of the caller's tenant, each read in 1000-row
// keyset pages by client_id only (pagedRead.ts), so no list of ids ever rides in a URL and a save
// landing between two pages cannot push a stored row out of both, plus exact head counts of sizes
// and inclusions. The browser compares the counts with what came back and opens the table view-only
// when they differ after one re-read (the truncation guard): a cut-short read must never become the
// base of an edit, and must never become an Excel template either, because the importer deletes a
// box the sheet shows as 0.
//
// THE WRITE (validatePayload, then savePricingCells). One call to pricing_cells_apply (migration 350),
// which writes each size's price, Offered and included options together, after checking both the
// size's version and every value the edit was made against. This file checks the request's SHAPE
// first and answers 400 without calling the database when it is wrong; the browser runs the same
// rules before sending, so a 400 here is a parity bug and the page logs it. What needs the database
// is the function's: which style is the tenant's, which option keys are columns, and the two range
// rules a stored value can override (a price below 0, a quantity past 999,999: a value equal to what
// is stored is always accepted, plan §4.10). The function also re-checks both caps.
//
// The caps. At most MAX_CALL_ENTRIES creates, removes and sizes together, and MAX_CALL_CELLS option
// boxes, per call. Each entry is one exception block in the function, a subtransaction, and Postgres
// caches 64 subtransaction ids per backend before every snapshot falls back to pg_subtrans. The
// browser splits bigger work into queued calls (a 210-size paste is 5).
//
// RETRIES. The rpc goes through attempt() (pagedRead.ts): retried only when the database never
// answered. A retry after a first try that did commit is safe: the function checks every size again
// and answers duplicate (creates and sizes) or removed with gone (removes). A lock wait past the
// function's lock_timeout or a deadlock is never answered per size: the function raises it, the
// whole call rolls back, and it comes back here with its SQLSTATE, so it is thrown (dbFail, a 500)
// and the browser resends the call after its backoff (migration 350's header).
//
// THE AUDIT ROW. One best-effort admin_audit row per call, COUNTS ONLY (the repo is public: no style
// or size names). Not auditStrict: the write has committed by then, and a strict failure would turn a
// saved batch into an error and a resend. An operator's call also gets operator_save_pricing_cells
// from portal-settings' dispatcher. A remove answered gone deleted nothing in this call (a resend of
// one that landed), so it is counted as gone, never as removed.
//
// Dependency-free (the client is passed in), so _test_stubs/pricingCells_test.ts runs it against
// pricingImportFake.ts and a stubbed rpc.

// deno-lint-ignore-file no-explicit-any
import { attempt, countRows, readAllPaged, sortRows } from "./pagedRead.ts";

/** Creates, removes and sizes in one call, together (one subtransaction each in the function). */
export const MAX_CALL_ENTRIES = 50;
/** Option boxes in one call, summed over every size entry's `to.cells`. */
export const MAX_CALL_CELLS = 2500;
/** The largest included quantity the table takes (sq ft of loft, or a count). */
export const MAX_QTY = 999_999;
/** The largest width or length a new size may have, in feet. */
export const MAX_DIM_FT = 500;
/** building_size_inclusions.qty is int (022): nothing past this can be stored at all. */
const MAX_INT = 2_147_483_647;
/** An option key is a built-in item_key (a short word) or a fixture id (36 characters). */
const MAX_KEY = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** A version as PostgREST and the function hand it out: timestamptz as ISO text, microseconds kept.
 *  The browser sends it back verbatim and the function compares it as a timestamptz. */
const VERSION = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

// ── The number rules (plan §4.10), one set for the browser and the server ───────────────────────
// The browser's twins are ssPgParsePrice / ssPgParseQty / ssPgParseDim in portal/03-catalog.jsx; the
// parity cases both must answer alike are _test_stubs/pricingParseCases.ts.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export const PRICE_ERROR = "A price is a number, 0 or more";
export const QTY_ERROR = "Whole numbers only, 0 or more";
export const QTY_MAX_ERROR = "Whole numbers from 0 to 999,999";
export const DIM_ERROR = "A width or length is a number above 0, at most 500, with at most 2 decimals";

/** A price box's text. Blank is NULL (the size is not offered); otherwise the importer's rule
 *  (pricingImport.ts num(), plus its negative refusal): finite and 0 or more once `$`, commas and
 *  spaces are stripped. A value equal to the stored one is always accepted. */
export function parsePrice(v: unknown, stored?: number | null): Parsed<number | null> {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: PRICE_ERROR };
  if (n >= 0 || (stored != null && n === Number(stored))) return { ok: true, value: n };
  return { ok: false, error: PRICE_ERROR };
}

/** An option box's text: a whole number from 0 to 999,999, blank meaning 0 (not included).
 *  Stricter than the importer on purpose: it turns yes-words into 1, rounds fractions and reads
 *  garbage as 0, which DELETES (pricingImport.ts parseInclusionQty). Digits only once `$`, commas and
 *  spaces are stripped, so Number()'s other spellings ("1e3", "0x1F", "+5") are refused too. A value
 *  equal to the stored one is always accepted. */
export function parseQty(v: unknown, stored?: number | null): Parsed<number> {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "") return { ok: true, value: 0 };
  if (!/^\d+$/.test(s)) return { ok: false, error: QTY_ERROR };
  const n = Number(s);
  if (n <= MAX_QTY || (stored != null && n === Number(stored))) return { ok: true, value: n };
  return { ok: false, error: QTY_MAX_ERROR };
}

/** A new size's width or length, in feet: above 0, at most 500, at most 2 decimals. Written in
 *  plain decimals ("10.5"), never Number()'s other spellings ("1e1", "0x10"). */
export function parseDim(v: unknown): Parsed<number> {
  const s = String(v ?? "").replace(/\s/g, "");
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= MAX_DIM_FT && Number(n.toFixed(2)) === n) return { ok: true, value: n };
  return { ok: false, error: DIM_ERROR };
}

/** A size's label, the importer's form (pricingImport.ts `${fmt(w)}x${fmt(l)}`): 10.5x12, never 10.50x12. */
export const sizeLabel = (w: number, l: number) => `${String(w)}x${String(l)}`;

// ── The request (plan §4.3) ──────────────────────────────────────────────────────────────────────

/** What an edit sends for one side: only what the builder changed. */
export type CellSide = { price?: number | null; active?: boolean; cells?: Record<string, number> };
export type CreateEntry = { id: string; styleId: string; width: number; length: number; label: string };
export type SizeEntry = { id: string; base: string; from: CellSide; to: CellSide };
export type PricingCellsPayload = { creates: CreateEntry[]; removes: string[]; sizes: SizeEntry[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One side of a size entry, checked and copied (only the three known fields travel on). */
function side(raw: unknown, where: string, isTo: boolean): Parsed<CellSide> {
  if (!isPlainObject(raw)) return { ok: false, error: `${where} must be an object` };
  const out: CellSide = {};
  for (const k of Object.keys(raw)) {
    if (k !== "price" && k !== "active" && k !== "cells") return { ok: false, error: `${where}.${k} is not something the table saves` };
  }
  if ("price" in raw) {
    const p = raw.price;
    if (p !== null && (typeof p !== "number" || !Number.isFinite(p))) return { ok: false, error: `${where}.price must be a number or null` };
    out.price = p as number | null;
  }
  if ("active" in raw) {
    if (typeof raw.active !== "boolean") return { ok: false, error: `${where}.active must be true or false` };
    out.active = raw.active;
  }
  if ("cells" in raw) {
    if (!isPlainObject(raw.cells)) return { ok: false, error: `${where}.cells must be an object` };
    const cells: Record<string, number> = {};
    for (const [key, q] of Object.entries(raw.cells)) {
      if (!key || key.length > MAX_KEY) return { ok: false, error: `${where}.cells has a key that is not an option key` };
      // The range rule (999,999) needs the stored value, so the function applies it per box. Here:
      // a whole number that can be stored at all.
      if (typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > MAX_INT) {
        return { ok: false, error: `${where}.cells.${key}: ${isTo ? QTY_ERROR : "the starting quantity must be a whole number, 0 or more"}` };
      }
      cells[key] = q;
    }
    out.cells = cells;
  }
  return { ok: true, value: out };
}

/** Check a save_pricing_cells body and copy out what the function needs. Anything malformed is a
 *  400 and nothing is called. Every edit must name its starting value (`from`) for exactly what it
 *  changes (`to`), and every size entry must carry the version (`base`) it was made against: the
 *  function's two checks (migration 350, rule 3) have nothing to compare otherwise. */
export function validatePayload(body: any): Parsed<PricingCellsPayload> {
  const listOf = (k: string): unknown[] | null => body?.[k] == null ? [] : Array.isArray(body[k]) ? body[k] : null;
  const rawCreates = listOf("creates"), rawRemoves = listOf("removes"), rawSizes = listOf("sizes");
  if (!rawCreates || !rawRemoves || !rawSizes) return { ok: false, error: "creates, removes and sizes must be lists" };
  const entries = rawCreates.length + rawRemoves.length + rawSizes.length;
  if (entries === 0) return { ok: false, error: "Nothing to save" };
  if (entries > MAX_CALL_ENTRIES) {
    return { ok: false, error: `At most ${MAX_CALL_ENTRIES} sizes can be added, removed or changed in one save (this one had ${entries})` };
  }
  const seen = new Set<string>();
  const once = (id: string) => { const k = id.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; };

  const creates: CreateEntry[] = [];
  for (let i = 0; i < rawCreates.length; i++) {
    const c: any = rawCreates[i];
    const where = `creates[${i}]`;
    if (!isPlainObject(c)) return { ok: false, error: `${where} must be an object` };
    if (!isUuid(c.id)) return { ok: false, error: `${where}.id must be a uuid` };
    if (!isUuid(c.styleId)) return { ok: false, error: `${where}.styleId must be a uuid` };
    if (typeof c.width !== "number" || typeof c.length !== "number") return { ok: false, error: `${where}: width and length must be numbers` };
    const w = parseDim(c.width), l = parseDim(c.length);
    if (!w.ok || !l.ok) return { ok: false, error: `${where}: ${DIM_ERROR}` };
    if (!once(c.id)) return { ok: false, error: `${where}: the same size is named twice in one save` };
    creates.push({ id: c.id, styleId: c.styleId, width: w.value, length: l.value, label: sizeLabel(w.value, l.value) });
  }

  const removes: string[] = [];
  for (let i = 0; i < rawRemoves.length; i++) {
    const id = rawRemoves[i];
    if (!isUuid(id)) return { ok: false, error: `removes[${i}] must be a uuid` };
    if (!once(id)) return { ok: false, error: `removes[${i}]: the same size is named twice in one save` };
    removes.push(id);
  }

  const sizes: SizeEntry[] = [];
  let cells = 0;
  for (let i = 0; i < rawSizes.length; i++) {
    const s: any = rawSizes[i];
    const where = `sizes[${i}]`;
    if (!isPlainObject(s)) return { ok: false, error: `${where} must be an object` };
    if (!isUuid(s.id)) return { ok: false, error: `${where}.id must be a uuid` };
    if (typeof s.base !== "string" || !VERSION.test(s.base)) {
      return { ok: false, error: `${where}.base must be the size's version (updated_at) exactly as it was last read` };
    }
    const from = side(s.from, `${where}.from`, false);
    if (!from.ok) return from;
    const to = side(s.to, `${where}.to`, true);
    if (!to.ok) return to;
    const changes = ("price" in to.value ? 1 : 0) + ("active" in to.value ? 1 : 0) + Object.keys(to.value.cells ?? {}).length;
    if (changes === 0) return { ok: false, error: `${where}.to changes nothing` };
    // Every changed field names its starting value, and nothing else is named.
    for (const f of ["price", "active"] as const) {
      if ((f in to.value) !== (f in from.value)) return { ok: false, error: `${where}: from and to must both carry ${f}, or neither` };
    }
    const toKeys = Object.keys(to.value.cells ?? {}).sort(), fromKeys = Object.keys(from.value.cells ?? {}).sort();
    if (toKeys.join("\n") !== fromKeys.join("\n")) return { ok: false, error: `${where}: from.cells and to.cells must name the same boxes` };
    if (!once(s.id)) return { ok: false, error: `${where}: the same size is named twice in one save` };
    cells += toKeys.length;
    sizes.push({ id: s.id, base: s.base, from: from.value, to: to.value });
  }
  if (cells > MAX_CALL_CELLS) {
    return { ok: false, error: `At most ${MAX_CALL_CELLS} option boxes can be saved in one go (this one had ${cells})` };
  }
  return { ok: true, value: { creates, removes, sizes } };
}

// ── The read (plan §4.1) ─────────────────────────────────────────────────────────────────────────

export type SizeTable = {
  styles: any[];
  sizes: any[];
  inclusions: any[];
  counts: { sizes: number; inclusions: number };
  rtpOn: boolean;
};

/** Everything the table draws from the tenant's catalog, read whole. Throws the database's error;
 *  the caller answers it with dbFail. The option COLUMNS are not here: the page reads them from the
 *  catalog action, through ssPricingColumns, the same list the Excel template uses. */
export async function readSizeTable(sb: any, clientId: string): Promise<SizeTable> {
  // Paged by each table's unique key (pagedRead.ts says why), then put in the plan's order.
  const byPlace = (rows: any[]) => sortRows(rows, ["sort_order", "id"]);
  const [styles, sizes, inclusions, sizeCount, inclusionCount, settings] = await Promise.all([
    readAllPaged(sb, "building_styles", "id, key, label, code, active, sort_order", ["id"], clientId).then(byPlace),
    readAllPaged(sb, "building_sizes", "id, style_id, label, width_ft, length_ft, base_price, active, sort_order, created_at, updated_at", ["id"], clientId).then(byPlace),
    // No id column on this table: its key is (size_id, item_key), which is also the order it comes in.
    readAllPaged(sb, "building_size_inclusions", "size_id, item_key, included, qty", ["size_id", "item_key"], clientId),
    countRows(sb, "building_sizes", "id", clientId),
    countRows(sb, "building_size_inclusions", "size_id", clientId),
    // client_settings is service-role only; no row means Real-Time Pricing was never turned on.
    attempt(() => sb.from("client_settings").select("rtp_enabled").eq("client_id", clientId).maybeSingle()),
  ]);
  if (settings.error) throw settings.error;
  return {
    styles, sizes, inclusions,
    counts: { sizes: sizeCount, inclusions: inclusionCount },
    rtpOn: settings.data?.rtp_enabled === true,
  };
}

// ── The write (plan §4.3-4.4) ────────────────────────────────────────────────────────────────────

export type Audit = (action: string, rowCount?: number | null, note?: string | null) => Promise<void>;
export type PricingCellsAnswer = { created: any[]; removed: any[]; results: any[] };

/** A remove that deleted a size in this call. "removed" with gone: true deleted nothing: the size
 *  was not on the account (a resend of a remove that landed). */
const removedNow = (r: any) => r?.status === "removed" && r?.gone !== true;

/** The audit note: counts only. saved / created / removed / conflicts / refused first (the plan's
 *  shape), then what the saved sizes changed: prices written, sizes hidden from the designer, boxes
 *  cleared and set. Hidden means taken out by this call: Offered unticked from ticked, or a price
 *  cleared. A first price sent with Offered left unticked (a paste's "no") was never in it. */
export function auditNote(v: PricingCellsPayload, out: PricingCellsAnswer): string {
  const n = (list: any[], status: string) => list.filter((x) => x?.status === status).length;
  const sent = new Map(v.sizes.map((s) => [s.id, s]));
  let prices = 0, hidden = 0, cleared = 0, set = 0;
  for (const r of out.results) {
    if (r?.status !== "saved") continue;
    const s = sent.get(r.id);
    if (!s) continue;
    const errs = r.cellErrors ?? {};
    if ("price" in s.to && !("price" in errs)) prices++;
    const unticked = s.to.active === false && s.from.active === true;
    const priceGone = "price" in s.to && s.to.price === null && s.from.price != null;
    if (r.row?.active === false && (unticked || priceGone)) hidden++;
    for (const [k, q] of Object.entries(s.to.cells ?? {})) {
      if (k in errs) continue;
      if (q === 0) cleared++; else set++;
    }
  }
  const refused = n(out.results, "refused") + n(out.created, "refused") + n(out.removed, "refused");
  return [
    `saved=${n(out.results, "saved")}`, `created=${n(out.created, "created")}`, `removed=${out.removed.filter(removedNow).length}`,
    `conflicts=${n(out.results, "conflict")}`, `refused=${refused}`,
    `prices=${prices}`, `hidden=${hidden}`, `cellsCleared=${cleared}`, `cellsSet=${set}`,
    `duplicates=${n(out.results, "duplicate") + n(out.created, "duplicate")}`, `exists=${n(out.created, "exists")}`,
    `missing=${n(out.results, "missing")}`, `gone=${out.removed.filter((r) => r?.status === "removed" && r?.gone === true).length}`,
  ].join(" ");
}

/** One call to pricing_cells_apply for the caller's tenant, then the audit row. `clientId` is the
 *  tenant resolveTenant took from the token, never a body field. Throws the database's error (the
 *  caller answers it with dbFail); otherwise returns the function's three lists as they came. */
export async function savePricingCells(sb: any, clientId: string, v: PricingCellsPayload, audit: Audit): Promise<PricingCellsAnswer> {
  const { data, error } = await attempt(() => sb.rpc("pricing_cells_apply", {
    p_client_id: clientId, p_creates: v.creates, p_removes: v.removes, p_sizes: v.sizes,
  }));
  if (error) throw error;
  if (!data || typeof data !== "object") throw new Error("pricing_cells_apply gave no answer");
  const list = (x: unknown) => Array.isArray(x) ? x : [];
  const out: PricingCellsAnswer = { created: list(data.created), removed: list(data.removed), results: list(data.results) };
  const rows = out.results.filter((r) => r?.status === "saved").length
    + out.created.filter((r) => r?.status === "created").length
    + out.removed.filter(removedNow).length;
  await audit("portal_save_pricing_cells", rows, auditNote(v, out)).catch(() => {});
  return out;
}
