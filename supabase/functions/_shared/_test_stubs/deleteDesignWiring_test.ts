// delete_design, driven through the SHIPPED portal-settings handler against a fake bucket
// (2026-10-05, "Deleting a design is not deleting the estimate").
//
// WHY THIS EXISTS. The CRM half of that bug was fixed on 09-02. What was still left behind was the
// design's own storage: its quote PDF, its CRM-mode formal estimate and every picture card, all of
// them public objects, while the dialog said "the saved PDFs" go. The fix is only worth having if
// all of this holds, and each is pinned here against the real handler:
//
//   1. Deleting a quote nobody invoiced removes the quote, the formal estimate, every plan PDF and
//      EVERY picture pair, including the older pairs no column points at.
//   2. It never removes <code>-invoice.pdf, another design's files (a longer code sharing the
//      prefix included), or another tenant's.
//   3. Once an invoice exists, the quote documents stay. That includes a StructureStudio invoice,
//      which leaves the design 'accepted' with no invoice_id (six such designs were live on 10-05).
//      The CRM estimate keeps its 09-02 rule from the same single ledger read: a StructureStudio
//      invoice was not made from it, so it is still deleted from the CRM.
//   4. The invoice question is asked BEFORE anything is removed, and a failed read stops the delete
//      with nothing touched.
//   5. The audit row says quote=removed|kept|none, and a CRM 404 reads estimate=already_gone while
//      the response keeps estimate:"deleted" for the dialog production still serves.
//   6. A storage failure never makes the design undeletable, and a failed remove is reported and
//      logged (counts only) rather than read as "there was no quote"; a planted URL is refused and
//      logged.
//   7. The confirm-token rule is unchanged, on the server and in the dialog (the old dialog still
//      sends it).
//   8. The dialog says what the server does: its CRM sentence uses the CRM-only rule, and both
//      designs reads that feed it (the owner's own and an operator's view-as) carry the
//      StructureStudio invoice stamp its quote sentence needs.
//
// The key rules themselves are _shared/designStorageKeys.test.ts.
//
// HOW. The aiDraftStreamWiring_test idiom: Deno.serve is stubbed while portal-settings/index.ts is
// imported, so a request goes through withErrorLog, resolveTenant and the delete_design branch as it
// does live. The import map swaps supabase-js for supabase_stub.ts; its stubDb, and the stubStorage
// hook added for this test, route every table and storage call into the fakes below. fetch is the
// CRM's estimate DELETE and nothing else, and no --allow-net is granted, so nothing leaves the box.
//
// ⚠️ THE IMPORT SPECIFIER IS COMPUTED ON PURPOSE (see aiDraftStreamWiring_test): a literal one would
// type-check portal-settings against the stub's partial client type.
//
// Tenants, codes and quote numbers are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubStorage } from "./supabase_stub.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
const SOURCE = await read("../../portal-settings/index.ts");
const DIALOG = await read("../../../../portal/01-core.jsx");

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
const CODE = "SS-ABC234";
const STORAGE = "https://stub.supabase.co/storage/v1/object/public/floor-plans/";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

type World = {
  design?: Record<string, unknown> | null;
  versions?: Record<string, unknown>[];
  inv?: Record<string, unknown> | null;
  invErr?: boolean;
  creds?: Record<string, unknown> | null;
  objects?: string[];
  listFails?: boolean;
  removeFails?: boolean;
  ghlStatus?: number;
};
type Trace = {
  events: string[];                 // every table op, storage call and CRM call, in order
  audit: Record<string, unknown>[]; // admin_audit rows
  rows: Record<string, unknown>[];  // app_errors rows
  removed: string[][];              // every storage.remove() key list
  ghl: { url: string; method: string; body: string }[];
  bucket: Set<string>;
};

// The bucket as Supabase holds it today for this design, beside things that are not its to touch.
const BUCKET = [
  `${T}/${CODE}-1780000000000.pdf`,
  `${T}/${CODE}-1790000000000.pdf`,
  `${T}/${CODE}-plan-1780000000000.jpg`,  // an older submit's pair: no column points at it
  `${T}/${CODE}-3d-1780000000000.jpg`,
  `${T}/${CODE}-plan-1790000000000.jpg`,
  `${T}/${CODE}-3d-1790000000000.jpg`,
  `${T}/${CODE}-quote.pdf`,
  `${T}/${CODE}-estimate.pdf`,
  `${T}/${CODE}-invoice.pdf`,
  `${T}/SS-ABC2345-quote.pdf`,            // a longer code that starts with this one
  `${T}/SS-ABC2345-plan-1790000000000.jpg`,
  `${T}/SS-QQQ777-quote.pdf`,
  `other-sheds/${CODE}-quote.pdf`,         // another tenant's folder
  `other-sheds/SS-ZZZ999-1790000000000.pdf`,
];
const NOT_OURS = BUCKET.filter((k) => !k.startsWith(`${T}/${CODE}-`));
const DESIGN_FILES = BUCKET.filter((k) => k.startsWith(`${T}/${CODE}-`) && !k.endsWith("-invoice.pdf"));
const QUOTE_DOCS = [`${T}/${CODE}-quote.pdf`, `${T}/${CODE}-estimate.pdf`];

const SS_DESIGN = {
  id: "d1", short_code: CODE, status: "accepted", created_at: "2026-09-20T10:00:00Z",
  image_url: STORAGE + `${T}/${CODE}-1790000000000.pdf`,
  plan_image_url: STORAGE + `${T}/${CODE}-plan-1790000000000.jpg`,
  view3d_image_url: STORAGE + `${T}/${CODE}-3d-1790000000000.jpg`,
  ss_quote_number: "SST-1001",
  ss_quote_pdf_url: STORAGE + `${T}/${CODE}-quote.pdf`,
  ss_invoice_sent_at: null,
  ghl_estimate_id: null, ghl_estimate_number: null,
};
const GHL_DESIGN = {
  ...SS_DESIGN, status: "sent", ss_quote_number: null, ss_quote_pdf_url: null, plan_image_url: null, view3d_image_url: null,
  ghl_estimate_id: "est-1", ghl_estimate_number: 1042,
};
const VERSIONS = [{ id: "v1", image_url: STORAGE + `${T}/${CODE}-1780000000000.pdf` }, { id: "v2", image_url: SS_DESIGN.image_url }];
const CREDS = { ghl_location_id: "loc-1", ghl_api_key: "harness-key" };

function answer(world: World, trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  if (table === "client_users") return { data: [{ client_id: T, role: "owner", title: null, access: null, user_id: "u1" }], error: null };
  if (table === "admin_audit") { trace.audit.push(arg("insert")); return { data: null, error: null }; }
  if (table === "designs") {
    if (has("delete")) return { data: null, error: null, count: world.design ? 1 : 0 };
    return { data: world.design ?? null, error: null };
  }
  if (table === "design_versions") {
    if (has("delete")) return { data: null, error: null, count: (world.versions ?? []).length };
    return { data: world.versions ?? [], error: null };
  }
  if (table === "invoice_sends") {
    if (world.invErr) return { data: null, error: { message: "the ledger read timed out" } };
    return { data: world.inv ?? null, error: null };
  }
  if (table === "client_settings") return { data: world.creds ?? null, error: null };
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(world: World, trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(world, trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.rows.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    const verb = ops.find((o) => ["select", "insert", "update", "delete", "upsert"].includes(o[0]))?.[0] ?? "?";
    trace.events.push(`db:${table}:${verb}`);
    return Promise.resolve().then(() => answer(world, trace, table, ops)).then(ok, bad);
  };
  return q;
}

/** Storage with its own list semantics: prefix + search, case-insensitive, one level deep. */
function bucket(world: World, trace: Trace) {
  return (name: string) => {
    if (name !== "floor-plans") throw new Error(`unexpected bucket ${name}`);
    return {
      list(path: string, options: { search?: string; limit?: number } = {}) {
        trace.events.push("storage:list");
        if (world.listFails) return Promise.resolve({ data: null, error: { message: "list failed" } });
        const prefix = `${path}/`;
        const want = (prefix + (options.search ?? "")).toLowerCase();
        const names = [...trace.bucket]
          .filter((k) => k.toLowerCase().startsWith(want) && !k.slice(prefix.length).includes("/"))
          .map((k) => k.slice(prefix.length)).sort().slice(0, options.limit ?? 100);
        return Promise.resolve({ data: names.map((n) => ({ name: n })), error: null });
      },
      remove(keys: string[]) {
        trace.events.push("storage:remove");
        trace.removed.push([...keys]);
        if (world.removeFails) return Promise.resolve({ data: null, error: { message: "remove failed" } });
        const gone = keys.filter((k) => trace.bucket.delete(k));
        return Promise.resolve({ data: gone.map((n) => ({ name: n })), error: null });
      },
    };
  };
}

async function drive(payload: Record<string, unknown>, world: World) {
  const trace: Trace = { events: [], audit: [], rows: [], removed: [], ghl: [], bucket: new Set(world.objects ?? BUCKET) };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  stubAuth.user = { id: "u1", email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(world, trace, table, []);
  stubStorage.from = bucket(world, trace);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://services.leadconnectorhq.com/invoices/estimate/")) throw new Error(`unexpected fetch: ${url}`);
    trace.events.push("crm:estimate");
    trace.ghl.push({ url, method: String(init?.method), body: String(init?.body ?? "") });
    return Promise.resolve(new Response(world.ghlStatus === 404 ? '{"message":"Not found"}' : "{}", { status: world.ghlStatus ?? 200 }));
  }) as typeof fetch;
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-settings", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify({ action: "delete_design", shortCode: CODE, ...payload }),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    globalThis.fetch = realFetch;
    stubDb.from = null;
    stubStorage.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const note = (t: Trace) => String(t.audit.find((r) => r.action === "portal_delete_design")?.note ?? "");
const left = (t: Trace) => [...t.bucket].sort();
const without = (keys: string[]) => BUCKET.filter((k) => !keys.includes(k)).sort();

// ─── 1. A quote nobody invoiced ────────────────────────────────────────────────────────────────
Deno.test("an uninvoiced quote: the quote, the estimate, every plan PDF and every picture pair go", async () => {
  const { status, body, trace } = await drive({ deleteEstimate: true, confirmToken: CODE }, {
    design: SS_DESIGN, versions: VERSIONS,
  });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(left(trace), without(DESIGN_FILES), "only the invoice and other designs' files remain");
  assertEquals(body.quote, "removed");
  assertEquals(body.quotePdfKept, false);
  assertEquals(body.quoteNumber, "SST-1001");
  assertEquals(body.filesRemoved, DESIGN_FILES.length);
  assertEquals(body.estimate, "none");
  assertEquals(trace.ghl.length, 0, "no CRM estimate, no CRM call");
  assert(note(trace).includes(" quote=removed "), note(trace));
  assert(note(trace).endsWith("estimate=none"), note(trace));
  assertEquals(trace.rows.length, 0, "nothing for support to read");
});

Deno.test("the old dialog (no deleteEstimate flag) still gets the PDFs it was promised", async () => {
  const { status, body, trace } = await drive({ confirmToken: CODE }, { design: SS_DESIGN, versions: VERSIONS });
  assertEquals(status, 200);
  assertEquals(body.quote, "removed");
  for (const k of QUOTE_DOCS) assert(!trace.bucket.has(k), k);
});

// ─── 2. Never the invoice, never another design or tenant ──────────────────────────────────────
Deno.test("never the invoice, another design's files or another tenant's, in any state", async () => {
  for (const world of [
    { design: SS_DESIGN, versions: VERSIONS },
    { design: { ...SS_DESIGN, ss_invoice_sent_at: "2026-10-01T12:00:00Z" }, versions: VERSIONS },
    { design: GHL_DESIGN, versions: VERSIONS, creds: CREDS },
    { design: { ...GHL_DESIGN, status: "invoiced" }, versions: VERSIONS, inv: { invoice_id: "inv-1", status: "sent" } },
  ] as World[]) {
    const token = (world.design as any).ghl_estimate_number ? String((world.design as any).ghl_estimate_number) : CODE;
    const { status, trace } = await drive({ deleteEstimate: true, confirmToken: token }, world);
    assert(status === 200, `status ${status}`);
    for (const k of NOT_OURS) assert(trace.bucket.has(k), `${k} survived`);
    assert(trace.bucket.has(`${T}/${CODE}-invoice.pdf`), "the invoice survived");
    for (const keys of trace.removed) {
      for (const k of keys) {
        assert(k.startsWith(`${T}/${CODE}-`) || k.startsWith(`${T}/${CODE}.`), `asked to remove ${k}`);
        assert(!k.endsWith("-invoice.pdf"), `asked to remove ${k}`);
      }
    }
  }
});

// ─── 3. The invoice gate ───────────────────────────────────────────────────────────────────────
Deno.test("a StructureStudio invoice on an 'accepted' design keeps the quote documents", async () => {
  // How a StructureStudio invoice really looks: no invoice_id, a number and a PDF, the design left
  // 'accepted' with ss_invoice_sent_at set (migration 136).
  const { status, body, trace } = await drive({ deleteEstimate: true, confirmToken: CODE }, {
    design: { ...SS_DESIGN, ss_invoice_sent_at: "2026-10-01T12:00:00Z" }, versions: VERSIONS,
    inv: { invoice_id: null, invoice_number: "SSI-1001", invoice_pdf_url: STORAGE + `${T}/${CODE}-invoice.pdf`, status: "sent" },
  });
  assertEquals(status, 200);
  for (const k of QUOTE_DOCS) assert(trace.bucket.has(k), `${k} kept`);
  assertEquals(left(trace), without(DESIGN_FILES.filter((k) => !QUOTE_DOCS.includes(k))));
  assertEquals(body.quote, "kept");
  assertEquals(body.quotePdfKept, true);
  assert(note(trace).includes(" quote=kept "), note(trace));
});

Deno.test("the ledger alone is enough: an SS invoice row keeps the quote even before the stamp", async () => {
  const { body, trace } = await drive({ confirmToken: CODE }, {
    design: SS_DESIGN, versions: VERSIONS,
    inv: { invoice_id: null, invoice_number: "SSI-1002", invoice_pdf_url: null, status: "created" },
  });
  assertEquals(body.quote, "kept");
  for (const k of QUOTE_DOCS) assert(trace.bucket.has(k), k);
});

Deno.test("a CRM invoice keeps the estimate in the CRM and its formal estimate PDF, from one read", async () => {
  const { status, body, trace } = await drive({ deleteEstimate: true, confirmToken: "1042" }, {
    design: { ...GHL_DESIGN, status: "accepted" }, versions: VERSIONS, creds: CREDS,
    inv: { invoice_id: "inv-1", invoice_number: "INV-7", status: "sent" },
  });
  assertEquals(status, 200);
  assertEquals(body.estimate, "skipped_invoiced");
  assertEquals(trace.ghl.length, 0);
  assert(trace.bucket.has(`${T}/${CODE}-estimate.pdf`));
  assertEquals(body.quote, "kept");
  // invoice_sends is read ONCE.
  assertEquals(trace.events.filter((e) => e === "db:invoice_sends:select").length, 1);
});

Deno.test("an old CRM estimate on a design with a StructureStudio invoice still leaves the CRM; the quote stays", async () => {
  // A tenant that switched to StructureStudio paperwork after the CRM estimate was made, then sent a
  // StructureStudio invoice. That invoice came from the StructureStudio quote, so there is no CRM
  // invoice to void and nothing would ever point at the estimate again once the row is gone.
  const { status, body, trace } = await drive({ deleteEstimate: true, confirmToken: "1042" }, {
    design: {
      ...GHL_DESIGN, status: "accepted", ss_quote_number: "SST-1003", ss_quote_pdf_url: STORAGE + `${T}/${CODE}-quote.pdf`,
      ss_invoice_sent_at: "2026-10-01T12:00:00Z",
    },
    versions: VERSIONS, creds: CREDS,
    inv: { invoice_id: null, invoice_number: "SSI-1003", invoice_pdf_url: STORAGE + `${T}/${CODE}-invoice.pdf`, status: "sent" },
  });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.estimate, "deleted");
  assertEquals(trace.ghl.length, 1, "the CRM estimate DELETE was sent");
  assertEquals(body.quote, "kept");
  for (const k of QUOTE_DOCS) assert(trace.bucket.has(k), `${k} kept`);
  assert(trace.bucket.has(`${T}/${CODE}-invoice.pdf`));
  assertEquals(trace.events.filter((e) => e === "db:invoice_sends:select").length, 1);
});

Deno.test("the invoice question is asked before anything is removed, and a failed read stops it all", async () => {
  const ok = await drive({ deleteEstimate: true, confirmToken: "1042" }, { design: GHL_DESIGN, versions: VERSIONS, creds: CREDS });
  const at = (e: string) => ok.trace.events.indexOf(e);
  assert(at("db:invoice_sends:select") >= 0 && at("db:invoice_sends:select") < at("storage:list"), ok.trace.events.join(" > "));
  assert(at("storage:remove") < at("crm:estimate"), ok.trace.events.join(" > "));
  assert(at("crm:estimate") < at("db:designs:delete"), ok.trace.events.join(" > "));

  const { status, trace } = await drive({ deleteEstimate: true, confirmToken: "1042" }, {
    design: GHL_DESIGN, versions: VERSIONS, creds: CREDS, invErr: true,
  });
  assertEquals(status, 500);
  assertEquals(left(trace), [...BUCKET].sort(), "nothing removed");
  assertEquals(trace.ghl.length, 0, "no CRM call");
  assert(!trace.events.some((e) => e.endsWith(":delete")), trace.events.join(" > "));
  assertEquals(trace.audit.length, 0);
});

// ─── 5. The audit and the CRM 404 ──────────────────────────────────────────────────────────────
Deno.test("a CRM 404 reads estimate=already_gone in the audit and stays 'deleted' for the dialog", async () => {
  const { body, trace } = await drive({ deleteEstimate: true }, { design: GHL_DESIGN, versions: VERSIONS, creds: CREDS, ghlStatus: 404 });
  assertEquals(body.estimate, "deleted");
  assertEquals(body.estimateAlreadyGone, true);
  assert(note(trace).includes("estimate=already_gone"), note(trace));
  // The CRM-mode formal estimate PDF goes with it, and there was no StructureStudio quote.
  assert(!trace.bucket.has(`${T}/${CODE}-estimate.pdf`));
  assertEquals(body.quote, "removed");
});

Deno.test("a real CRM delete reads estimate=deleted, with altId in the body", async () => {
  const { body, trace } = await drive({ deleteEstimate: true }, { design: GHL_DESIGN, versions: VERSIONS, creds: CREDS, ghlStatus: 200 });
  assertEquals(body.estimate, "deleted");
  assertEquals(body.estimateAlreadyGone, false);
  assert(note(trace).endsWith("estimate=deleted"), note(trace));
  assertEquals(trace.ghl[0].method, "DELETE");
  assertEquals(JSON.parse(trace.ghl[0].body), { altId: "loc-1", altType: "location" });
});

Deno.test("the audit note keeps its old fields, in order, with quote= before estimate=", async () => {
  const { trace } = await drive({ deleteEstimate: true, confirmToken: CODE }, { design: SS_DESIGN, versions: VERSIONS });
  assert(/^code=SS-ABC234 status=accepted versions=2 files=\d+ kept=0 quote=removed estimate=none$/.test(note(trace)), note(trace));
});

// ─── 6. Failures and planted values ────────────────────────────────────────────────────────────
Deno.test("a failed listing still removes the stored and derived keys, and says so in the audit", async () => {
  const { status, body, trace } = await drive({ confirmToken: CODE }, { design: SS_DESIGN, versions: VERSIONS, listFails: true });
  assertEquals(status, 200);
  assertEquals(body.quote, "removed");
  for (const k of [...QUOTE_DOCS, `${T}/${CODE}-plan-1790000000000.jpg`, `${T}/${CODE}-1780000000000.pdf`]) assert(!trace.bucket.has(k), k);
  assert(trace.bucket.has(`${T}/${CODE}-plan-1780000000000.jpg`), "the unpointed older pair needs the listing");
  assert(note(trace).endsWith(" list=failed"), note(trace));
});

Deno.test("a failed remove still deletes the design rows, says quote=failed, and leaves support a row", async () => {
  const { status, body, trace } = await drive({ confirmToken: CODE }, { design: SS_DESIGN, versions: VERSIONS, removeFails: true });
  assertEquals(status, 200);
  assertEquals(body.filesRemoved, 0);
  // Not "none": the public quote PDF is still there, and the row that named it is about to go.
  assertEquals(body.quote, "failed");
  assertEquals(body.quotePdfKept, false);
  assert(trace.events.includes("db:designs:delete"));
  assert(note(trace).includes(" quote=failed "), note(trace));
  assert(note(trace).endsWith(" remove=failed"), note(trace));
  const row = trace.rows.find((r) => r.code === "delete_design_files_failed") as any;
  assert(row, JSON.stringify(trace.rows));
  assertEquals(row.context.shortCode, CODE);
  assert(row.context.keys > 0, JSON.stringify(row.context));
  // Counts only: no key, no URL and no customer data in the row.
  assert(!JSON.stringify(row).includes("floor-plans") && !JSON.stringify(row).includes(".pdf"), JSON.stringify(row));
});

Deno.test("a planted URL is refused, logged by namespace, and the other tenant's file is untouched", async () => {
  const { body, trace } = await drive({ confirmToken: CODE }, {
    design: { ...SS_DESIGN, view3d_image_url: STORAGE + `other-sheds/${CODE}-quote.pdf` }, versions: VERSIONS,
  });
  assertEquals(body.filesKept, 1);
  assert(trace.bucket.has(`other-sheds/${CODE}-quote.pdf`));
  const row = trace.rows.find((r) => r.code === "delete_design_key_refused") as any;
  assert(row, JSON.stringify(trace.rows));
  assertEquals(row.context.namespaces, ["other-sheds"]);
});

// ─── 7. The confirm token ──────────────────────────────────────────────────────────────────────
Deno.test("a wrong confirm token refuses before anything is read or removed", async () => {
  const { status, body, trace } = await drive({ deleteEstimate: true, confirmToken: "nope" }, { design: SS_DESIGN, versions: VERSIONS });
  assertEquals(status, 409);
  assertEquals(body.expected, CODE);
  assertEquals(left(trace), [...BUCKET].sort());
  assert(!trace.events.includes("db:invoice_sends:select"));
});

Deno.test("the token rule is the same expression on the server and in the dialog", () => {
  const rule = "design.ghl_estimate_number ? String(design.ghl_estimate_number) : design.short_code";
  const i = SOURCE.indexOf('if (action === "delete_design")');
  assert(i > 0, "delete_design branch moved");
  assert(SOURCE.slice(i, i + 4000).includes(`const expected = ${rule};`), "server token rule changed");
  const j = DIALOG.indexOf("function DeleteDesignDialog(");
  assert(j > 0, "DeleteDesignDialog moved");
  const dialog = DIALOG.slice(j, DIALOG.indexOf("\nfunction ", j + 10));
  assert(dialog.includes(`const expected = ${rule};`), "dialog token rule changed");
  assert(dialog.includes("deleteEstimate: true"), "the dialog still opts in to the CRM delete");
});

// ─── 8. The dialog's inputs and rules match the server's ───────────────────────────────────────
Deno.test("the dialog's CRM sentence uses the CRM-only rule; its quote sentence the wider one", () => {
  const j = DIALOG.indexOf("function DeleteDesignDialog(");
  const dialog = DIALOG.slice(j, DIALOG.indexOf("\nfunction ", j + 10));
  // The page cannot read the ledger, so each rule is the status half of the server's.
  assert(dialog.includes('const invoiced = st === "invoiced" || st === "delivered" || !!design.ss_invoice_sent_at;'), "quote rule changed");
  assert(dialog.includes('const crmInvoiced = st === "invoiced" || st === "delivered";'), "CRM rule changed");
  assert(/design\.ghl_estimate_number \? \(\s*crmInvoiced \?/.test(dialog), "the CRM sentence no longer keys on crmInvoiced");
  assert(/quoteNo \? \(\s*invoiced \?/.test(dialog), "the quote sentence no longer keys on invoiced");
});

Deno.test("view-as reads the invoice stamp the dialog needs, as the owner's own read does", async () => {
  const op = await read("../../operator-portal/index.ts");
  const sales = await read("../../../../portal/02-sales.jsx");
  // The reads that feed DesignsTable (the ones carrying the quote columns); the leads list's own
  // designs read never opens the dialog.
  const designsRead = (src: string) => src.split("\n")
    .filter((l) => /\.select\([`"]short_code, created_at, updated_at, status, contact/.test(l) && l.includes("ss_quote_pdf_url"));
  const owner = designsRead(sales);
  const viewAs = designsRead(op);
  assert(owner.length >= 1 && viewAs.length >= 1, `designs reads not found (owner ${owner.length}, view-as ${viewAs.length})`);
  for (const l of owner) assert(l.includes("ss_invoice_sent_at"), `the owner's designs read lost ss_invoice_sent_at: ${l.trim()}`);
  // Without it an operator's dialog promises to delete a quote PDF the server keeps.
  for (const l of viewAs) assert(l.includes("ss_invoice_sent_at"), `the view-as designs read lacks ss_invoice_sent_at: ${l.trim()}`);
});
