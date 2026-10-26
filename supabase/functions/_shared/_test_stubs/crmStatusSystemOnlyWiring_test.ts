// Carolyn's 2026-10-12 call, the server half (migration 303), driven through the SHIPPED
// portal-settings handler and pinned against the SHIPPED portal source:
//
//   * "the statuses are system-driven, 100%" — crm_deal_set_status refuses EVERY caller, an owner
//     included, with a sentence and before anything is read or written; a stage can no longer be
//     linked to a status (a stale editor's link is refused, a blank one ignored, and nothing writes
//     status_id); renaming, adding, removing and reordering statuses touches crm_statuses alone (302
//     mirrored them into Quotes' stages); a status cards still have can't be removed, and the
//     refusal says to rename it, never "give them another status first".
//   * "I want quotes gone" — the pipeline list no longer carries 302's mirror flag or stage links,
//     a new account's first open seeds through crm_ensure_pipelines (Shed Deals only, since 303),
//     and the pipeline new designs land in can't be removed (a new design would get no card).
//   * Settings → Pipelines and the stage editor offer no hand-set and no stage link, and the copy
//     no longer names Quotes' mirror.
//
// tests/sql/migration303.test.cjs holds the database half (the move, the triggers, the CHECK).
//
// HOW. ghlContactImportWiring_test's idiom: Deno.serve is stubbed while index.ts is imported, so a
// request runs through withErrorLog, resolveTenant, the gates and the branch as it does live; the
// import map swaps supabase-js for supabase_stub.ts, whose stubDb / stubRpc route every table and
// rpc call into the fakes below. No --allow-net. Tenants and ids are made up (the repo is public).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { stubAuth, stubDb, stubRpc } from "./supabase_stub.ts";
import {
  DESIGN_FEED_STAYS, STAGE_STATUS_LINK_RETIRED, STATUS_IS_SYSTEM_SET, statusArchiveRefusal,
} from "../crmPipelines.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
async function captureHandler(rel: string): Promise<(req: Request) => Promise<Response>> {
  const realServe = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(new URL(rel, import.meta.url).href);
  } finally {
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${rel} did not hand Deno.serve a handler`);
  return handler;
}
const HANDLER = await captureHandler("../../portal-settings/index.ts");
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\r\n/g, "\n");
const SETTINGS_SRC = await read("../../portal-settings/index.ts");
const SALES_SRC = await read("../../../../portal/02-sales.jsx");

/** Whole-line comments dropped, so a comment naming a token cannot satisfy (or fail) a check. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");
function between(src: string, start: string, end: string, label: string): string {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) {
    throw new Error(`crmStatusSystemOnlyWiring_test: could not find ${label} (start=${i}, end=${j}). The anchors moved — re-point them rather than deleting this test.`);
  }
  return src.slice(i, j);
}

const TENANT = "acme-sheds";
const USER = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "https://stub.supabase.co";
const ENV: Record<string, string> = { SUPABASE_URL: PROJECT, SUPABASE_ANON_KEY: "stub-anon", SUPABASE_SERVICE_ROLE_KEY: "stub-service" };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEAL = U(11), STATUS = U(21), STATUS_B = U(22), STAGE = U(31), FEED = U(41), OTHER = U(42);

type World = {
  /** crm_pipelines rows (live) the board reads; null = the tenant has none yet. */
  pipelines: any[] | null;
  stages: any[];
  statuses: any[];
  /** What a crm_deals count answers. */
  dealCount: number;
  /** What the rpc crm_ensure_pipelines seeds (becomes `pipelines`). */
  seeded?: any[];
};
type Trace = { reads: string[]; writes: { table: string; verb: string; row: any; ops: any[][] }[]; rpc: { fn: string; args: any }[]; selects: string[] };

function chain(w: World, t: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(w, t, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "not", "gte", "lte", "gt", "lt", "or", "limit", "order", "range", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    const has = (op: string) => ops.some((o) => o[0] === op);
    const arg = (op: string, i = 1) => (ops.find((o) => o[0] === op) ?? [])[i];
    const eqVal = (col: string) => (ops.find((o) => o[0] === "eq" && o[1] === col) ?? [])[2];
    const single = has("maybeSingle") || has("single");
    const verb = ["insert", "update", "delete", "upsert"].find((v) => has(v));
    const answer = () => {
      if (table === "app_errors" || table === "admin_audit") return { data: null, error: null };
      if (table === "client_users") {
        return { data: [{ user_id: USER, client_id: TENANT, role: "owner", title: null, access: null, prefs: null, location_id: null, full_name: "Pat Owner" }], error: null };
      }
      if (table === "app_operators") return { data: null, error: null };
      if (table === "client_configs") return { data: { client_id: eqVal("client_id") ?? TENANT }, error: null };
      if (table === "client_settings") return { data: { internal_account: false, billing_exempt: true }, error: null };
      if (verb) {
        t.writes.push({ table, verb, row: arg(verb), ops });
        if (verb === "insert") return { data: { id: U(99) }, error: null };
        return { data: has("select") ? [{ id: eqVal("id") ?? U(98) }] : null, error: null };
      }
      t.reads.push(table);
      t.selects.push(`${table}:${String(arg("select") ?? "")}`);
      if (table === "crm_deals") return { data: null, error: null, count: w.dealCount };
      if (table === "crm_pipelines") {
        const opts = arg("select", 2);
        if (opts && opts.head) return { data: null, error: null, count: (w.pipelines ?? []).length };
        if (single) return { data: (w.pipelines ?? []).find((p) => p.id === eqVal("id")) ?? null, error: null };
        return { data: w.pipelines ?? [], error: null };
      }
      if (table === "crm_pipeline_stages") return { data: single ? (w.stages[0] ?? null) : w.stages, error: null };
      if (table === "crm_statuses") {
        const opts = arg("select", 2);
        if (opts && opts.head) return { data: null, error: null, count: w.statuses.length };
        return { data: single ? (w.statuses.at(-1) ?? null) : w.statuses, error: null };
      }
      return { data: single ? null : [], error: null };
    };
    return Promise.resolve().then(answer).then(ok, bad);
  };
  return q;
}

async function call(w: World, body: Record<string, unknown>) {
  const t: Trace = { reads: [], writes: [], rpc: [], selects: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: USER, email: "owner@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(w, t, table, []);
  stubRpc.rpc = (fn: string, args: any) => {
    t.rpc.push({ fn, args });
    if (fn === "crm_ensure_pipelines") { w.pipelines = w.seeded ?? []; return Promise.resolve({ data: null, error: null }); }
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
  };
  try {
    const res = await HANDLER(new Request(`${PROJECT}/functions/v1/portal-settings`, {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json", "user-agent": "harness/1.0" },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, t };
  } finally {
    stubDb.from = null;
    stubRpc.rpc = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const SHED = { id: FEED, name: "Shed Deals", position: 1024, lost_reasons: [], seed_kind: "shed_deals", feeds_designs: true };
const OUTREACH = { id: OTHER, name: "Dealer recruiting", position: 2048, lost_reasons: [], seed_kind: null, feeds_designs: false };
const world = (over: Partial<World> = {}): World => ({
  pipelines: [SHED, OUTREACH],
  stages: [{ id: STAGE, pipeline_id: FEED, name: "New Incoming", color: "#64748B", kind: "open", position: 1024 }],
  statuses: [{ id: STATUS, name: "New Lead", color: "#64748B", position: 1024, trigger_event: "design_submitted" },
             { id: STATUS_B, name: "Appt Set", color: "#0EA5E9", position: 2048, trigger_event: null }],
  dealCount: 0,
  ...over,
});

// ─── A card's status: nobody sets it ──────────────────────────────────────────────────────────
Deno.test("crm_deal_set_status refuses an owner with the sentence, before anything is read or written", async () => {
  for (const body of [{ id: DEAL, statusId: STATUS }, { id: DEAL, statusId: "" }, {}]) {
    const { status, body: out, t } = await call(world(), { action: "crm_deal_set_status", ...body });
    assertEquals(status, 409, JSON.stringify(body));
    assertEquals(out.error, STATUS_IS_SYSTEM_SET);
    assertEquals(t.rpc, [], "crm_set_deal_status is never called from the portal");
    assertEquals(t.writes, [], "nothing written");
    assert(!t.reads.some((r) => r.startsWith("crm_")), `no CRM row read: ${t.reads}`);
  }
});

Deno.test("the branch is the refusal alone, and the gate is kept so a pre-303 tab gets words, not a 404", () => {
  const src = code(SETTINGS_SRC);
  assert(!/rpc\("crm_set_deal_status"/.test(src), "portal-settings calls crm_set_deal_status again: a person could set a status");
  const branch = between(src, 'if (action === "crm_deal_set_status") {', "\n  }\n", "the crm_deal_set_status branch");
  assert(/return json\(\{ error: STATUS_IS_SYSTEM_SET \}, 409\);/.test(branch), branch);
  assertEquals(branch.split("\n").filter((l) => l.trim()).length, 2, "the branch does nothing but refuse");
  assert(/crm_deal_set_status:\s*\{ area: "contacts", level: "edit" \}/.test(src), "its GATES line is gone (preflight would flag the branch)");
  assert(!/mirrors_statuses|mirrorIds/.test(src), "302's status mirror is back in portal-settings");
  assert(!/status_id: s\.statusId|patch\.status_id/.test(src), "a stage save writes status_id again");
});

// ─── Stages ───────────────────────────────────────────────────────────────────────────────────
Deno.test("a stage can't be linked to a status: a link is refused, a blank one is ignored, nothing writes status_id", async () => {
  const linked = await call(world(), { action: "crm_stage_save", id: STAGE, statusId: STATUS });
  assertEquals([linked.status, linked.body.error], [400, STAGE_STATUS_LINK_RETIRED]);
  assertEquals(linked.t.writes, []);

  const renamed = await call(world(), { action: "crm_stage_save", id: STAGE, name: "Called", statusId: "" });
  assertEquals(renamed.status, 200, renamed.text);
  const upd = renamed.t.writes.filter((x) => x.table === "crm_pipeline_stages");
  assertEquals(upd.length, 1);
  assertEquals(upd[0].row.name, "Called");
  assert(!("status_id" in upd[0].row), JSON.stringify(upd[0].row));

  const added = await call(world(), { action: "crm_stage_save", pipelineId: FEED, name: "Site visit" });
  assertEquals(added.status, 200, added.text);
  const ins = added.t.writes.filter((x) => x.table === "crm_pipeline_stages" && x.verb === "insert");
  assertEquals(ins.length, 1);
  assert(!("status_id" in ins[0].row), JSON.stringify(ins[0].row));
});

// ─── The status list (Settings → Pipelines) ───────────────────────────────────────────────────
Deno.test("renaming, adding and reordering statuses touches crm_statuses alone (no Quotes mirror)", async () => {
  for (const body of [
    { action: "crm_status_save", id: STATUS, name: "Booked", color: "#0EA5E9" },
    { action: "crm_status_save", name: "Site visit" },
    { action: "crm_status_save", id: STATUS_B, triggerEvent: "estimate_sent" },
    { action: "crm_statuses_reorder", ids: [STATUS_B, STATUS] },
  ]) {
    const { status, text, t } = await call(world(), body);
    assertEquals(status, 200, `${JSON.stringify(body)} ${text}`);
    assert(t.writes.length > 0 && t.writes.every((x) => x.table === "crm_statuses"), `${JSON.stringify(body)} wrote ${t.writes.map((x) => x.table)}`);
    assert(!t.reads.includes("crm_pipelines") && !t.reads.includes("crm_pipeline_stages"), `${JSON.stringify(body)} read ${t.reads}`);
  }
});

Deno.test("a status cards still have can't be removed, and the answer is to rename it", async () => {
  const { status, body, t } = await call(world({ dealCount: 3 }), { action: "crm_status_save", id: STATUS, archive: true });
  assertEquals([status, body.error], [409, statusArchiveRefusal(3)]);
  assertEquals(t.writes, []);
  const none = await call(world({ dealCount: 0 }), { action: "crm_status_save", id: STATUS_B, archive: true });
  assertEquals(none.status, 200, none.text);
  assertEquals(none.t.writes.map((x) => `${x.table}:${x.verb}`), ["crm_statuses:update"], "no stage is unlinked or archived with it");
  assert(none.t.writes[0].row.archived_at, "archived");
});

// ─── Pipelines ────────────────────────────────────────────────────────────────────────────────
Deno.test("the pipeline new designs land in can't be removed; another empty one can", async () => {
  const feed = await call(world(), { action: "crm_pipeline_save", id: FEED, archive: true });
  assertEquals([feed.status, feed.body.error], [409, DESIGN_FEED_STAYS]);
  assertEquals(feed.t.writes, []);
  const other = await call(world(), { action: "crm_pipeline_save", id: OTHER, archive: true });
  assertEquals(other.status, 200, other.text);
  assertEquals(other.t.writes.map((x) => `${x.table}:${x.verb}`), ["crm_pipelines:update"]);
});

Deno.test("the board's pipeline list: seeded through crm_ensure_pipelines, no mirror flag, no stage links", async () => {
  const fresh = world({ pipelines: null, seeded: [SHED] });
  const { status, body, text, t } = await call(fresh, { action: "crm_pipelines_list" });
  assertEquals(status, 200, text);
  assertEquals(t.rpc.map((r) => r.fn), ["crm_ensure_pipelines"], "a new account seeds once, through 303's Shed-Deals-only function");
  assertEquals(t.rpc[0].args, { p_client_id: TENANT });
  assertEquals(body.pipelines.map((p: any) => [p.name, p.feedsDesigns]), [["Shed Deals", true]]);
  for (const p of body.pipelines) {
    assert(!("mirrorsStatuses" in p), "302's mirror flag is answered again");
    for (const s of p.stages) assert(!("statusId" in s), "a stage answers a status link again");
  }
  assert(!t.selects.some((x) => /mirrors_statuses|status_id/.test(x) && /^crm_pipeline/.test(x)), t.selects.join(" | "));
  assertEquals(body.statuses.map((s: any) => s.name), ["New Lead", "Appt Set"], "the statuses are still listed");
});

// ─── The portal: nothing offers a hand-set or a stage link ────────────────────────────────────
Deno.test("Settings → Pipelines and the stage editor: no hand-set, no stage link, no Quotes mirror copy", () => {
  const editor = between(SALES_SRC, "function SsPipelineEditor(", "\n}\n", "SsPipelineEditor");
  const settings = between(SALES_SRC, "function PipelineSettings(", "\n}\n", "PipelineSettings");
  for (const [label, src] of [["the stage editor", editor], ["Settings → Pipelines", settings]] as const) {
    assert(!/statusId|Linked status|No status link|Link a stage|mirrorsStatuses/.test(code(src)), `${label} offers a stage→status link again`);
    assert(!/set by hand\)|can still change a status by hand|by hand, or automatically/.test(src), `${label} says a status can be set by hand`);
    assert(!/crm_deal_set_status/.test(src), `${label} sets a status`);
    assert(!/\bQuotes\b/.test(src), `${label} names the retired Quotes pipeline`);
  }
  assert(/nobody\s+changes one by hand/.test(settings), "the Statuses card says nobody changes a status by hand");
  assert(/Moving a card between stages never changes its\s+status/.test(editor), "the stage editor says a move never changes the status");
});
