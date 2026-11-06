// tenantExport.ts: the delete-time export's CSV and ZIP writers, and the export itself against a fake
// database and storage (2026-10-21, Track G part 2). The export is the only copy of a deleted
// builder's customer data, so every mistake here is quiet data loss or a leak:
//   * a CSV that a spreadsheet misreads (a comma, quote or newline in a cell; a formula run on open),
//     or that carries a column the registry says never leaves (a login token hash);
//   * a ZIP no unzip tool opens (a wrong CRC, offset or size);
//   * files left out of the ZIP but still deleted (the export must say which buckets it did not take);
//   * an empty export written as a file nobody needs, or a failed upload that does not throw.
// Self-contained: no network, no Supabase.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { buildTenantExport, crc32, csvOf, EXPORT_BUCKET, MAX_FILE_BYTES, sweepOldExports, zipStore } from "./tenantExport.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

Deno.test("crc32: the standard check value", () => {
  assertEquals(crc32(enc.encode("123456789")), 0xcbf43926);
  assertEquals(crc32(enc.encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assertEquals(crc32(new Uint8Array()), 0);
});

Deno.test("csvOf: header from every row's keys, quoting, formulas, dropped columns", () => {
  const csv = csvOf([
    { id: 1, name: 'Ann "A" Smith', note: "line1\nline2", phone: "+1 (555) 010-0000", token_hash: "secret" },
    { id: 2, name: "=HYPERLINK(\"x\")", extra: { a: 1 }, phone: "-cmd|calc", token_hash: "secret2" },
  ], ["token_hash"]);
  assert(csv.startsWith("﻿"), "UTF-8 BOM");
  const lines = csv.slice(1).split("\r\n");
  assertEquals(lines[0], "id,name,note,phone,extra");
  assertEquals(lines[1], '1,"Ann ""A"" Smith","line1\nline2",+1 (555) 010-0000,');
  assertEquals(lines[2], `2,"'=HYPERLINK(""x"")",,'-cmd|calc,"{""a"":1}"`);
  assert(!csv.includes("secret"), "a dropped column leaked");
});

/** Read a stored ZIP back: every entry's name and bytes, checking CRC and both headers agree. */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assertEquals(v.getUint32(end, true), 0x06054b50, "end of central directory");
  const count = v.getUint16(end + 10, true);
  let cd = v.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    assertEquals(v.getUint32(cd, true), 0x02014b50, "central header");
    const crc = v.getUint32(cd + 16, true);
    const size = v.getUint32(cd + 20, true);
    const nameLen = v.getUint16(cd + 28, true);
    const local = v.getUint32(cd + 42, true);
    const name = dec.decode(zip.subarray(cd + 46, cd + 46 + nameLen));
    assertEquals(v.getUint32(local, true), 0x04034b50, `local header of ${name}`);
    assertEquals(v.getUint32(local + 14, true), crc, `${name}: the two headers disagree on the CRC`);
    const lnameLen = v.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + lnameLen, local + 30 + lnameLen + size);
    assertEquals(crc32(data), crc, `${name}: CRC`);
    out.set(name, data);
    cd += 46 + nameLen;
  }
  return out;
}

Deno.test("zipStore: entries read back byte for byte, UTF-8 names included", () => {
  const zip = zipStore([
    { name: "README.txt", data: enc.encode("hello") },
    { name: "files/customer-uploads/plan é.pdf", data: new Uint8Array([0, 1, 2, 255]) },
    { name: "empty.csv", data: new Uint8Array() },
  ], new Date(Date.UTC(2026, 9, 21, 3, 30, 10)));
  const back = unzip(zip);
  assertEquals([...back.keys()], ["README.txt", "files/customer-uploads/plan é.pdf", "empty.csv"]);
  assertEquals(dec.decode(back.get("README.txt")), "hello");
  assertEquals([...back.get("files/customer-uploads/plan é.pdf")!], [0, 1, 2, 255]);
});

// ─── The export, against a fake ────────────────────────────────────────────────────────────────

function fake(opts: { rows?: Record<string, Record<string, unknown>[]>; files?: Record<string, { path: string; size: number }[]>; uploadError?: string } = {}) {
  const uploads: { bucket: string; path: string; bytes: Uint8Array }[] = [];
  const reads: string[] = [];
  const sb = {
    from: (table: string) => {
      const q: any = { range: [0, 999] };
      const b: any = {
        select: () => b, eq: () => b, order: () => b,
        range: (a: number, z: number) => { q.range = [a, z]; return b; },
        then: (res: any, rej: any) => {
          reads.push(table);
          const all = opts.rows?.[table] ?? [];
          return Promise.resolve({ data: all.slice(q.range[0], q.range[1] + 1), error: null }).then(res, rej);
        },
      };
      return b;
    },
    storage: {
      from: (bucket: string) => ({
        list: (dir: string) => {
          const files = (opts.files?.[bucket] ?? []).filter((f) => f.path.startsWith(`${dir}/`));
          const names = new Map<string, any>();
          for (const f of files) {
            const rest = f.path.slice(dir.length + 1);
            const i = rest.indexOf("/");
            names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? { name: rest, id: "x", metadata: { size: f.size } } : { name: rest.slice(0, i), id: null });
          }
          return Promise.resolve({ data: [...names.values()], error: null });
        },
        download: (path: string) => Promise.resolve({ data: new Blob([`bytes:${path}`]), error: null }),
        upload: (path: string, bytes: Uint8Array) => {
          if (opts.uploadError) return Promise.resolve({ data: null, error: { message: opts.uploadError } });
          uploads.push({ bucket, path, bytes });
          return Promise.resolve({ data: { path }, error: null });
        },
        createSignedUrl: (path: string) => Promise.resolve({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
      }),
    },
  };
  return { sb, uploads, reads };
}

const TABLES = [{ table: "crm_contacts", drop: [] }, { table: "customer_sessions", drop: ["token_hash"] }, { table: "sms_messages", drop: [] }];
const NOW = new Date(Date.UTC(2026, 9, 21, 3, 30, 0));

Deno.test("the export: one ZIP with a CSV per table that has rows, the files, a README, and a signed link", async () => {
  const contacts = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, client_id: "acme-sheds", name: `Contact ${i + 1}` }));
  const f = fake({
    rows: { crm_contacts: contacts, customer_sessions: [{ id: "s1", client_id: "acme-sheds", email_lower: "a@example.test", token_hash: "h" }] },
    files: { "customer-uploads": [{ path: "acme-sheds/c1/site.jpg", size: 10 }, { path: "acme-sheds/permit.pdf", size: 5 }] },
  });
  const r = await buildTenantExport(f.sb, "acme-sheds", { tables: TABLES, buckets: ["customer-uploads"], now: NOW });
  assertEquals(r.rows, 1501);
  assertEquals(r.tables, { crm_contacts: 1500, customer_sessions: 1 }, "sms_messages had no rows: no file for it");
  assertEquals(r.files, 2);
  assertEquals(r.filesNotExported, []);
  assertEquals(f.uploads.length, 1);
  assertEquals(f.uploads[0].bucket, EXPORT_BUCKET);
  assert(/^acme-sheds\/2026-10-21T03-30-00-000Z-[0-9a-f]{8}\.zip$/.test(f.uploads[0].path), f.uploads[0].path);
  assertEquals(r.path, f.uploads[0].path);
  assertEquals(r.url, `https://signed.test/${r.path}`);
  assertEquals(r.expiresAt, "2026-10-28T03:30:00.000Z", "the link works for 7 days");
  const back = unzip(f.uploads[0].bytes);
  assertEquals([...back.keys()].sort(), ["README.txt", "crm_contacts.csv", "customer_sessions.csv", "files/customer-uploads/c1/site.jpg", "files/customer-uploads/permit.pdf"]);
  assertEquals(dec.decode(back.get("crm_contacts.csv")).split("\r\n").length - 2, 1500, "all 1500 rows, past the 1000-row page");
  assert(!dec.decode(back.get("customer_sessions.csv")).includes("token_hash"), "a token hash left the database");
  assertEquals(dec.decode(back.get("files/customer-uploads/permit.pdf")), "bytes:acme-sheds/permit.pdf");
  assert(/removed 30 days after the delete/.test(dec.decode(back.get("README.txt"))));
});

Deno.test("the export: nothing to export writes nothing", async () => {
  const f = fake();
  const r = await buildTenantExport(f.sb, "acme-sheds", { tables: TABLES, buckets: ["customer-uploads"], now: NOW });
  assertEquals([r.path, r.rows, r.files, f.uploads.length], [null, 0, 0, 0]);
});

Deno.test("the export: files too big for the ZIP are named, not taken (and so not deleted)", async () => {
  const f = fake({ files: { "customer-uploads": [{ path: "acme-sheds/huge.mov", size: MAX_FILE_BYTES + 1 }] }, rows: { crm_contacts: [{ id: 1 }] } });
  const r = await buildTenantExport(f.sb, "acme-sheds", { tables: TABLES, buckets: ["customer-uploads"], now: NOW });
  assertEquals(r.filesNotExported, [{ bucket: "customer-uploads", count: 1, bytes: MAX_FILE_BYTES + 1 }]);
  assertEquals(r.files, 0);
  assert(/NOT in this file: 1 file\(s\)/.test(dec.decode(unzip(f.uploads[0].bytes).get("README.txt"))));
});

Deno.test("the export: a failed upload throws, so the delete stops", async () => {
  const f = fake({ rows: { crm_contacts: [{ id: 1 }] }, uploadError: "bucket not found" });
  await assertRejects(() => buildTenantExport(f.sb, "acme-sheds", { tables: TABLES, buckets: [], now: NOW }), Error, "could not save the file (bucket not found)");
});

Deno.test("sweepOldExports: removes exports older than 30 days, keeps the rest", async () => {
  const removed: string[] = [];
  const sb = {
    storage: {
      from: () => ({
        list: (dir: string) => Promise.resolve({
          data: dir === ""
            ? [{ name: "acme-sheds", id: null }, { name: "stray.zip", id: "f" }]
            : [
              { name: "old.zip", id: "1", metadata: { size: 1 }, created_at: "2026-09-01T00:00:00Z" },
              { name: "new.zip", id: "2", metadata: { size: 1 }, created_at: "2026-10-20T00:00:00Z" },
            ],
          error: null,
        }),
        remove: (paths: string[]) => { removed.push(...paths); return Promise.resolve({ data: paths, error: null }); },
      }),
    },
  };
  assertEquals(await sweepOldExports(sb, NOW), 1);
  assertEquals(removed, ["acme-sheds/old.zip"]);
});
