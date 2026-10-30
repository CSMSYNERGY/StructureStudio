// admin-catalog's whole-tenant reads of sizes and inclusions go through _shared/pagedRead.ts
// (2026-10-30, with the sizes table), driven through the SHIPPED handler.
//
// WHY. PostgREST answers at most 1,000 rows a read and says nothing when it cuts. Both operator
// consoles build their pricing sheet from get_client_catalog: past 1,000 inclusion rows a row cut off
// showed as 0 in the sheet, and the importer deletes a 0 on re-upload. The tenant clone in
// create_client read the template's sizes and inclusions the same way, so a big template cloned short.
// The sizes table makes 1,000 easy to cross: one fill-down of a door across 210 sizes is 210 rows.
//
// WHAT IS PINNED: get_client_catalog returns all 1,200 of a builder's inclusions and all their sizes,
// and only theirs, the sizes in list order though they are paged by id; create_client's clone copies
// all 1,200 of a template's inclusions onto the new builder's sizes. The fake answers 1,000 rows a read, as PostgREST does, so the unpaged reads this
// replaced fail both.
//
// HOW. deleteClientHarness's idiom: Deno.serve is stubbed while admin-catalog/index.ts is imported,
// the import map swaps supabase-js for supabase_stub.ts, and stubDb routes every table into
// pricingImportFake.ts (the three catalog tables) or a quiet generic answer (everything else). The
// caller uses the ADMIN_PASSWORD break-glass path. No --allow-net, and TWILIO_SUBACCOUNTS is unset,
// so create_client's phone account step is skipped. Tenants are made up; the repo is public.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubDb, stubRpc } from "./supabase_stub.ts";
import { fakeDb } from "./pricingImportFake.ts";

const ADMIN_PASSWORD = "admin-password-test";
const ENV: Record<string, string> = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", ADMIN_PASSWORD };
const CLEARED = ["TWILIO_SUBACCOUNTS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];

const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../admin-catalog/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("admin-catalog did not hand Deno.serve a handler");
const ADMIN = handler as (req: Request) => Promise<Response>;

const TEMPLATE = "test-template";
const NEWBIE = "test-newbie";
const OTHER = "bravo-barns";
// Seeded ids live apart from the ones the fake mints for new rows (00000000-…-000000000001 upward).
const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The template: 2 styles, 40 sizes, 30 options on each = 1,200 inclusion rows. Plus another builder's
// rows, which must never come along.
const KEYS = Array.from({ length: 30 }, (_, i) => `item${String(i).padStart(2, "0")}`);
const STYLES = [
  { id: uid(1), client_id: TEMPLATE, key: "test-barn", label: "Test Barn", image_url: null, sort_order: 0, active: true, taxable: true, show_image_on_estimate: true },
  { id: uid(2), client_id: TEMPLATE, key: "test-shed", label: "Test Shed", image_url: null, sort_order: 1, active: true, taxable: false, show_image_on_estimate: true },
  { id: uid(3), client_id: OTHER, key: "other-barn", label: "Other Barn", image_url: null, sort_order: 0, active: true, taxable: true, show_image_on_estimate: true },
];
const SIZES = [
  ...Array.from({ length: 40 }, (_, i) => ({
    id: uid(100 + i), client_id: TEMPLATE, style_id: i < 20 ? uid(1) : uid(2), label: `10x${10 + i}`,
    width_ft: 10, length_ft: 10 + i, base_price: 1000 + i, sort_order: i % 20, active: true,
  })),
  { id: uid(900), client_id: OTHER, style_id: uid(3), label: "8x8", width_ft: 8, length_ft: 8, base_price: 1, sort_order: 0, active: true },
];
const INCLUSIONS = [
  ...SIZES.filter((z) => z.client_id === TEMPLATE).flatMap((z, i) => KEYS.map((k) => ({ client_id: TEMPLATE, size_id: z.id, item_key: k, included: true, qty: 1 + (i % 5) }))),
  { client_id: OTHER, size_id: uid(900), item_key: "loft", included: true, qty: 9 },
];

async function call(body: Record<string, unknown>) {
  const db = fakeDb({ building_styles: STYLES, building_sizes: SIZES, building_size_inclusions: INCLUSIONS }, { maxRows: 1000 });
  const generic = (table: string) => {
    const build = (ops: any[][]): any => {
      const q: any = {};
      for (const m of ["select", "eq", "neq", "lt", "is", "in", "not", "or", "limit", "order", "range", "insert", "update", "upsert", "delete"]) {
        q[m] = (...a: unknown[]) => build([...ops, [m, ...a]]);
      }
      const answer = (one: boolean) => {
        const eqv = (c: string) => (ops.find((o) => o[0] === "eq" && o[1] === c) ?? [])[2];
        if (table === "client_configs" && !ops.some((o) => ["insert", "update", "upsert", "delete"].includes(o[0]))) {
          const id = eqv("client_id");
          if (id === TEMPLATE) return { data: { client_id: TEMPLATE, contact_fields: ["name", "email"], default_sizes: [], options: [] }, error: null };
          return { data: one ? null : [], error: null };
        }
        return { data: one ? null : [], count: 0, error: null };
      };
      q.maybeSingle = () => Promise.resolve(answer(true));
      q.single = () => Promise.resolve(answer(true));
      q.then = (ok: any, bad: any) => Promise.resolve(answer(false)).then(ok, bad);
      return q;
    };
    return build([]);
  };
  const prior = Object.fromEntries([...Object.keys(ENV), ...CLEARED].map((k) => [k, Deno.env.get(k)]));
  for (const k of CLEARED) Deno.env.delete(k);
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubDb.from = (table: string) => table.startsWith("building_") ? db.sb.from(table) : generic(table);
  stubRpc.rpc = (fn: string) => Promise.reject(new Error(`adminCatalogPaging: unexpected rpc ${fn}`));
  try {
    const res = await ADMIN(new Request("http://localhost/functions/v1/admin-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ ...body, adminPassword: ADMIN_PASSWORD }),
    }));
    return { status: res.status, body: await res.json(), db };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("get_client_catalog returns all 1,200 inclusions and all 40 sizes, and only that builder's", async () => {
  const r = await call({ action: "get_client_catalog", clientId: TEMPLATE });
  assertEquals(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  assertEquals(r.body.inclusions.length, 1200);
  assertEquals(r.body.buildingSizes.length, 40);
  assertEquals(r.body.buildingStyles.length, 2);
  assert(r.body.inclusions.every((i: any) => i.size_id !== uid(900)), "another builder's inclusion came along");
  assertEquals(new Set(r.body.inclusions.map((i: any) => `${i.size_id}|${i.item_key}`)).size, 1200, "no row twice across the page boundary");
  assertEquals(r.db.ins, [], "no read carries a list of ids");
  // Keyset pages (pagedRead.ts): the first stops 10 boxes into the 34th size, so the rest of that
  // size is read by item_key before the sizes after it.
  const pages = r.db.calls.filter((c) => c.table === "building_size_inclusions" && c.verb === "select").length;
  assertEquals(pages, 3, "two pages and the rest of the size the first one stopped inside");
  // Paged by id, then put back in list order: sort_order by value, then id (the two styles' sizes
  // share places 0-19 here).
  const order = r.body.buildingSizes.map((z: any) => [z.sort_order, z.id]);
  const want = [...order].sort((a: any, b: any) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  assertEquals(order, want, "sizes come back in list order");
  assertEquals(order.slice(0, 2), [[0, uid(100)], [0, uid(120)]]);
});

Deno.test("create_client's clone copies all 1,200 of the template's inclusions onto the new builder's sizes", async () => {
  const r = await call({ action: "create_client", clientId: NEWBIE, companyName: "Test Newbie Sheds", templateClientId: TEMPLATE });
  assertEquals(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  assertEquals(r.body.cloned?.building_styles, 2, JSON.stringify(r.body.cloned));
  assertEquals(r.body.cloned?.building_sizes, 40);
  assertEquals(r.body.cloned?.building_size_inclusions, 1200);
  const newSizes = new Set(r.db.tables.building_sizes.filter((z: any) => z.client_id === NEWBIE).map((z: any) => z.id));
  const copied = r.db.tables.building_size_inclusions.filter((i: any) => i.client_id === NEWBIE);
  assertEquals(newSizes.size, 40);
  assertEquals(copied.length, 1200);
  assert(copied.every((i: any) => newSizes.has(i.size_id)), "every copied inclusion points at one of the new builder's sizes");
  // Quantities travel with the rows: the template's 1..5 pattern, 240 of each.
  const byQty = new Map<number, number>();
  for (const i of copied) byQty.set(Number(i.qty), (byQty.get(Number(i.qty)) ?? 0) + 1);
  assertEquals([...byQty.entries()].sort((a, b) => a[0] - b[0]), [[1, 240], [2, 240], [3, 240], [4, 240], [5, 240]]);
  assert(!r.db.tables.building_sizes.some((z: any) => z.client_id === NEWBIE && z.label === "8x8"), "another builder's size came along");
  assertEquals(r.db.ins, [], "no read of the catalog tables carries a list of ids");
});
