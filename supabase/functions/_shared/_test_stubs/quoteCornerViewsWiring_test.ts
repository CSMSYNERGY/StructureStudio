// The four-corner page switch, driven through the SHIPPED portal-settings handler (migration 276;
// Carolyn 2026-08-20 "optional for them", 2026-09-08 "4 images... one from each corner").
//
// WHAT THIS PINS, against the real handler:
//
//   1. status hands the Settings card quoteCornerViews from its own tolerant read: the stored
//      boolean; false for a tenant with no settings row (the column's default); and null when the
//      database has no such column yet, which hides the switch while every other field still loads.
//   2. save writes quote_corner_views only when asked, and only a real boolean: a "true" string, a
//      1 or a null is refused with a sentence and NO write (a truthy "false" must never turn every
//      customer's page 2 into something the builder did not choose).
//   3. A save that does not mention it never names the column, so the page and the function can ship
//      ahead of 276 without breaking anyone's Business Details save.
//
// HOW. quoteDocsWiring_test's idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the action's branch as it
// does live. The import map swaps supabase-js for supabase_stub.ts, whose stubDb routes every table
// call into the fake below. No --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb } from "./supabase_stub.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-settings/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-settings did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── The world one request runs in ─────────────────────────────────────────────────────────────
const T = "acme-sheds";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};
const SETTINGS = {
  business_name: "Acme Sheds", business_phone: "(555) 010-0100", quote_terms: "Deposit due at signing.",
  invoice_in_ghl: false, ghl_invoicing_allowed: false, show_pricing: true,
};

type World = {
  corner?: boolean;      // client_settings.quote_corner_views
  noRow?: boolean;       // the tenant has no client_settings row at all
  noColumn?: boolean;    // the database has no quote_corner_views (a deploy ahead of 276)
};
type Trace = { upserts: Record<string, unknown>[]; cornerReads: number; rows: Record<string, unknown>[] };

const MISSING = { code: "42703", message: "column client_settings.quote_corner_views does not exist" };

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const cols = String(arg("select") ?? "");
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1", prefs: null }], error: null };
  if (table === "admin_audit") return { data: null, error: null };
  if (table === "client_settings") {
    if (has("upsert")) {
      trace.upserts.push(arg("upsert"));
      return { data: null, error: world.noColumn && "quote_corner_views" in arg("upsert") ? MISSING : null };
    }
    if (/\bquote_corner_views\b/.test(cols)) {
      trace.cornerReads++;
      if (world.noColumn) return { data: null, error: MISSING };
      return { data: world.noRow ? null : { quote_corner_views: world.corner ?? false }, error: null };
    }
    if (/\bquote_valid_days\b/.test(cols)) return { data: world.noRow ? null : { quote_valid_days: 30 }, error: null };
    return { data: world.noRow ? null : SETTINGS, error: null };
  }
  if (table === "client_configs") return { data: { company_name: "Acme Sheds" }, error: null };
  // Anything else answers empty rather than throwing: these tests are about one switch, and a read
  // this file does not model must not be mistaken for one that failed.
  return { data: has("maybeSingle") || has("single") ? null : [], error: null };
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.rows.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

async function drive(payload: Record<string, unknown>, world: World = {}) {
  const trace: Trace = { upserts: [], cornerReads: 0, rows: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(payload),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// ─── 1. status ─────────────────────────────────────────────────────────────────────────────────
Deno.test("status hands the Settings card the switch as stored", async () => {
  for (const corner of [true, false]) {
    const { status, body, trace } = await drive({ action: "status" }, { corner });
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(body.quoteCornerViews, corner);
    assertEquals(trace.cornerReads, 1, "its own read, once");
    assertEquals(body.quoteTerms, "Deposit due at signing.", "the rest of the card still loads");
  }
});

Deno.test("status for a tenant with no settings row: off, the column's default (the switch shows)", async () => {
  const { status, body } = await drive({ action: "status" }, { noRow: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.quoteCornerViews, false);
});

Deno.test("status on a database without 276: null (the switch hides) and the rest of the portal still boots", async () => {
  const { status, body, trace } = await drive({ action: "status" }, { noColumn: true });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.quoteCornerViews, null);
  assertEquals(body.businessName, "Acme Sheds");
  assertEquals(body.quoteValidDays, 30, "its neighbour's read is untouched");
  assertEquals(trace.rows.length, 0, "a column that is not there yet is not an error for support");
});

// ─── 2. save ───────────────────────────────────────────────────────────────────────────────────
Deno.test("save writes quote_corner_views when asked, on and off", async () => {
  for (const sent of [true, false]) {
    const { status, body, trace } = await drive({ action: "save", quoteCornerViews: sent });
    assertEquals(status, 200, `${JSON.stringify(sent)}: ${JSON.stringify(body)}`);
    assertEquals(trace.upserts.length, 1);
    assertEquals(trace.upserts[0].quote_corner_views, sent, `sent ${JSON.stringify(sent)}`);
  }
});

Deno.test("save refuses anything but a real boolean, with a sentence and no write", async () => {
  for (const sent of ["true", "false", 1, 0, null, "on", {}]) {
    const { status, body, trace } = await drive({ action: "save", quoteCornerViews: sent });
    assertEquals(status, 400, `${JSON.stringify(sent)}: ${JSON.stringify(body)}`);
    assertEquals(body.error, "The four-corner page setting has to be on or off.");
    assertEquals(trace.upserts.length, 0, `${JSON.stringify(sent)} wrote nothing`);
  }
});

Deno.test("a save that does not mention it never names the column (the page and server can ship ahead of 276)", async () => {
  const { status, trace } = await drive({ action: "save", quoteTerms: "New terms." }, { noColumn: true });
  assertEquals(status, 200);
  assertEquals(trace.upserts.length, 1);
  assert(!("quote_corner_views" in trace.upserts[0]), JSON.stringify(trace.upserts[0]));
});
