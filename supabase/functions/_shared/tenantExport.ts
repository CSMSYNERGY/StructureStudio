// The delete-time export of a builder's customer data (Track G part 2, 2026-10-21).
//
// WHY. Ahsan's retention answer for CRM contacts, texts, emails, calls, voicemails and customer logins
// is "export, then delete". delete_client builds ONE ZIP (a CSV per table in tenantTables.ts
// EXPORT_TABLES, the files in EXPORTED_BUCKETS, and a README), puts it in the private tenant-exports
// bucket (migration 321) and hands the operator a signed link, all BEFORE anything is deleted. If the
// export cannot be written, the delete is refused with nothing deleted: customer data is never
// destroyed without its copy.
//
// What never leaves: the columns tenantTables.ts names in exportDrop (login token hashes). Cells that
// a spreadsheet would run as a formula are prefixed with ' (a phone number like +1 555 is left alone).
//
// Size. The ZIP is built in memory (store only: CSV is small, photos do not compress). Rows over
// MAX_ROW_BYTES refuse the delete (ExportTooLarge). Files over MAX_FILE_BYTES, or more than
// MAX_FILES, are NOT put in the ZIP: the result says so, and delete_client then keeps those files
// instead of sweeping them, so nothing is lost unexported.
//
// Kept for EXPORT_KEEP_DAYS: delete_client removes older exports each time it runs (there is no
// scheduler in this project; see the work log).
//
// Importers: admin-catalog (delete_client).

// deno-lint-ignore-file no-explicit-any

import { listTree, type StoredObject } from "./storageTree.ts";

export const EXPORT_BUCKET = "tenant-exports";
export const EXPORT_KEEP_DAYS = 30;
/** How long the signed link in the delete report works. */
export const EXPORT_LINK_SECONDS = 7 * 24 * 3600;
export const MAX_ROW_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_FILES = 5000;
const PAGE = 1000;

export class ExportTooLarge extends Error {}

// ─── CSV ──────────────────────────────────────────────────────────────────────────────────────

const FORMULA = /^[=@\t\r]|^[+-](?![\d .()/-]*$)/;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a header row: the union of the rows' keys in first-seen order, minus `drop`.
 *  Starts with a BOM so a spreadsheet reads it as UTF-8. */
export function csvOf(rows: Record<string, unknown>[], drop: readonly string[] = []): string {
  const cols: string[] = [];
  const seen = new Set<string>(drop);
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const lines = [cols.map(cell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ─── ZIP (store only) ─────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A ZIP with every entry STORED (no compression), UTF-8 names. Under 65,535 entries and 4 GB. */
export function zipStore(entries: ZipEntry[], modified = new Date()): Uint8Array {
  if (entries.length > 65535) throw new Error("zipStore: too many entries");
  const enc = new TextEncoder();
  const time = (modified.getUTCHours() << 11) | (modified.getUTCMinutes() << 5) | Math.floor(modified.getUTCSeconds() / 2);
  const date = ((modified.getUTCFullYear() - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, e.data);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

// ─── The export ───────────────────────────────────────────────────────────────────────────────

export interface ExportResult {
  /** Path in EXPORT_BUCKET, or null when there was nothing to export. */
  path: string | null;
  url: string | null;
  expiresAt: string | null;
  rows: number;
  /** Rows per table, tables with rows only. */
  tables: Record<string, number>;
  files: number;
  bytes: number;
  /** Buckets whose files were too many or too big to put in the ZIP: delete_client keeps them. */
  filesNotExported: { bucket: string; count: number; bytes: number }[];
}

async function rowsOf(sb: any, table: string, clientId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select("*").eq("client_id", clientId).order("id").range(from, from + PAGE - 1);
    if (error) {
      // A table this database does not have yet has nothing to export (migration not applied).
      if (["42P01", "PGRST205"].includes(String(error.code ?? ""))) return out;
      throw new Error(`export: ${table}: ${error.message}`);
    }
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** Build and store the export. Throws ExportTooLarge, or Error when a read or the upload fails:
 *  either way the caller deletes nothing. */
export async function buildTenantExport(
  sb: any,
  clientId: string,
  opts: { tables: readonly { table: string; drop: readonly string[] }[]; buckets: readonly string[]; now?: Date },
): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const tables: Record<string, number> = {};
  let rows = 0;
  let rowBytes = 0;
  for (const { table, drop } of opts.tables) {
    const r = await rowsOf(sb, table, clientId);
    if (!r.length) continue;
    const data = enc.encode(csvOf(r, drop));
    rowBytes += data.length;
    if (rowBytes > MAX_ROW_BYTES) {
      throw new ExportTooLarge(`This builder's customer records are too large to export in one file (over ${Math.round(MAX_ROW_BYTES / 1048576)} MB).`);
    }
    entries.push({ name: `${table}.csv`, data });
    tables[table] = r.length;
    rows += r.length;
  }

  const filesNotExported: ExportResult["filesNotExported"] = [];
  let files = 0;
  for (const bucket of opts.buckets) {
    const tree = await listTree(sb, bucket, clientId);
    if (!tree.complete) throw new Error(`export: could not list ${bucket}`);
    if (!tree.objects.length) continue;
    const bytes = tree.objects.reduce((s: number, o: StoredObject) => s + o.size, 0);
    if (bytes > MAX_FILE_BYTES || tree.objects.length > MAX_FILES) {
      filesNotExported.push({ bucket, count: tree.objects.length, bytes });
      continue;
    }
    for (const o of tree.objects) {
      const { data, error } = await sb.storage.from(bucket).download(o.path);
      if (error || !data) throw new Error(`export: could not read ${bucket}/${o.path}`);
      entries.push({ name: `files/${bucket}/${o.path.slice(clientId.length + 1)}`, data: new Uint8Array(await data.arrayBuffer()) });
      files++;
    }
  }

  if (!entries.length && !filesNotExported.length) {
    return { path: null, url: null, expiresAt: null, rows: 0, tables: {}, files: 0, bytes: 0, filesNotExported };
  }

  const readme = [
    `Customer data of builder "${clientId}", exported by StructureStudio on ${now.toISOString()} before the builder was deleted.`,
    "",
    "One CSV per table (UTF-8, comma separated, a header row). Times are UTC. A cell a spreadsheet would",
    "run as a formula starts with an apostrophe.",
    ...Object.entries(tables).map(([t, n]) => `  ${t}.csv: ${n} row${n === 1 ? "" : "s"}`),
    ...(files ? ["", `files/: ${files} file${files === 1 ? "" : "s"} customers sent the builder, and CRM files.`] : []),
    ...filesNotExported.map((f) => `NOT in this file: ${f.count} file(s), ${Math.round(f.bytes / 1048576)} MB, in ${f.bucket}. They were kept in storage, not deleted.`),
    "",
    "Not included: login token hashes and one-time login codes. Call recordings and voicemail audio were",
    "held by Twilio; their transcripts and summaries are in the CSVs.",
    `This file is removed ${EXPORT_KEEP_DAYS} days after the delete.`,
    "",
  ].join("\r\n");
  entries.unshift({ name: "README.txt", data: enc.encode(readme) });

  const zip = zipStore(entries, now);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const path = `${clientId}/${stamp}-${rand}.zip`;
  const up = await sb.storage.from(EXPORT_BUCKET).upload(path, zip, { contentType: "application/zip", upsert: false });
  if (up.error) throw new Error(`export: could not save the file (${up.error.message})`);
  const signed = await sb.storage.from(EXPORT_BUCKET).createSignedUrl(path, EXPORT_LINK_SECONDS, { download: `${clientId}-customer-data.zip` });
  return {
    path,
    url: signed?.data?.signedUrl ?? null,
    expiresAt: new Date(now.getTime() + EXPORT_LINK_SECONDS * 1000).toISOString(),
    rows,
    tables,
    files,
    bytes: zip.length,
    filesNotExported,
  };
}

/** Remove exports older than EXPORT_KEEP_DAYS. Best-effort: returns how many went, null on a failure. */
export async function sweepOldExports(sb: any, now = new Date()): Promise<number | null> {
  const cutoff = now.getTime() - EXPORT_KEEP_DAYS * 24 * 3600 * 1000;
  const top = await sb.storage.from(EXPORT_BUCKET).list("", { limit: 1000 });
  if (top.error) return null;
  const old: string[] = [];
  for (const f of (top.data ?? []) as any[]) {
    if (f.id != null) continue; // exports live one folder down, under the builder id
    const tree = await listTree(sb, EXPORT_BUCKET, f.name);
    for (const o of tree.objects) if (o.createdAt && Date.parse(o.createdAt) < cutoff) old.push(o.path);
  }
  if (!old.length) return 0;
  const rm = await sb.storage.from(EXPORT_BUCKET).remove(old);
  return rm.error ? null : old.length;
}
