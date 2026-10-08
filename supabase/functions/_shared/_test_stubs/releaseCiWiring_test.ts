// release-ci (the commit -> What's New / On Beta function) pinned two ways:
//   1. against its SHIPPED SOURCE: every write sits behind the writes gate, the note's status is the
//      literal 'beta', its kind/title/detail come only from the trailer parser, the secret is a
//      header compared with timingSafeEqual behind the empty-secret gate, and portal-projects keeps
//      no local copy of propagateStatus (both share _shared/pmStatus.ts);
//   2. by DRIVING THE REAL HANDLER against an in-memory database (supabase_stub's stubDb): dark by
//      default, the hold results, idempotent re-delivery, item moves and promotion, and a response
//      that never names a builder.
// Builders, boards, items and shas are MADE UP. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubDb } from "./supabase_stub.ts";

const FUNCTIONS = new URL("../../", import.meta.url);
const code = (src: string) => src.replace(/\r\n/g, "\n").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const RAW_CI = (await Deno.readTextFile(new URL("release-ci/index.ts", FUNCTIONS))).replace(/\r\n/g, "\n");
const CI = code(RAW_CI);
const PROJECTS = code(await Deno.readTextFile(new URL("portal-projects/index.ts", FUNCTIONS)));
const CONFIG = (await Deno.readTextFile(new URL("../config.toml", FUNCTIONS))).replace(/\r\n/g, "\n");

// ── 1. The source ────────────────────────────────────────────────────────────────────────

/** Every top-level `async function write*(` block, declaration to the closing brace in column 0. */
function writeBlocks(src: string): Array<{ name: string; start: number; end: number; body: string }> {
  const out = [];
  for (const m of src.matchAll(/^async function (write\w+)\(/gm)) {
    const start = m.index!;
    const end = src.indexOf("\n}\n", start);
    if (end < 0) throw new Error(`releaseCiWiring_test: ${m[1]} has no closing brace in column 0`);
    out.push({ name: m[1], start, end, body: src.slice(start, end) });
  }
  return out;
}

Deno.test("every database write in release-ci is inside a write*() whose FIRST statement is mustWrite(ctx)", () => {
  const blocks = writeBlocks(CI);
  assertEquals(blocks.map((b) => b.name).sort(), ["writeActivity", "writeMove", "writeNote"]);
  for (const b of blocks) {
    const firstStatement = b.body.slice(b.body.indexOf("{", b.body.indexOf(")")) + 1).trim().split("\n")[0].trim();
    assertEquals(firstStatement, "mustWrite(ctx);", `${b.name} does not open with the writes gate`);
  }
  // Outside those blocks: no write of any kind, and no shared mover.
  let outside = CI;
  for (const b of [...blocks].reverse()) outside = outside.slice(0, b.start) + outside.slice(b.end);
  for (const w of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "propagateStatus("]) {
    assert(!outside.includes(w), `release-ci calls ${w} outside a gated write*() function`);
  }
  // And the gate itself: it throws on a dry run, and a dry run is the default.
  assert(/function mustWrite\(ctx: Ctx\) \{\n\s*if \(ctx\.dryRun\) throw new Error\(/.test(CI), "mustWrite no longer throws on ctx.dryRun");
  assert(CI.includes('const writes = Deno.env.get("RELEASE_CI_WRITES") === "1";'), "writes must be exactly RELEASE_CI_WRITES === \"1\"");
  assert(CI.includes("const dryRun = !writes || payload?.dryRun === true;"), "dryRun must be the default unless RELEASE_CI_WRITES=1, and a request can always ask for one");
  assert(CI.includes('const moves = Deno.env.get("RELEASE_CI_MOVE_ITEMS") === "1";'), "item moves must be exactly RELEASE_CI_MOVE_ITEMS === \"1\"");
  // Each call site of a mover also checks both switches (belt and braces: mustWrite would throw).
  for (const m of CI.matchAll(/await writeMove\(/g)) {
    const line = CI.slice(CI.lastIndexOf("\n", m.index!), m.index!);
    assert(/if \(ctx\.moves && !ctx\.dryRun\)/.test(line), "a writeMove call is not guarded by ctx.moves && !ctx.dryRun");
  }
  assert(/ctx\.dryRun \? "inserted" : await writeNote\(/.test(CI), "writeNote is not guarded by ctx.dryRun at its call site");
});

Deno.test("a note is inserted as the literal status 'beta', its words straight from the parser", () => {
  const note = writeBlocks(CI).find((b) => b.name === "writeNote")!.body;
  assert(/note: ReleaseNote/.test(note), "writeNote no longer takes the parser's ReleaseNote");
  for (const f of ['status: "beta",', "kind: note.kind,", "title: note.title,", "detail: note.detail,", "source_commit: sha,"]) {
    assert(note.includes(f), `writeNote's insert lost \`${f}\``);
  }
  assertEquals((note.match(/status:/g) || []).length, 1, "writeNote must set status exactly once, to 'beta'");
  assertEquals((CI.match(/writeNote\(/g) || []).length, 2, "writeNote has one definition and ONE call site");
  assert(/const parsed = parseReleaseTrailers\(c\.message\);/.test(CI) && /writeNote\(ctx, sha, parsed\.note, section\)/.test(CI),
    "the note written is not the one parseReleaseTrailers returned");
  assert(!/kind: ["'`]/.test(CI) && !/title: [^n]/.test(note), "a kind or title is invented somewhere instead of parsed");
});

Deno.test("the secret is a HEADER, behind the empty-secret gate, compared with timingSafeEqual, before the body is read", () => {
  assert(CI.includes('import { timingSafeEqual } from "../_shared/emailInbound.ts";'), "timingSafeEqual must be the shared one");
  const gate = 'if (!secret || !timingSafeEqual(key, secret)) return json({ error: "unauthorized" }, 401);';
  assert(CI.includes('const secret = Deno.env.get("RELEASE_CI_SECRET") ?? "";'), "the secret must come from RELEASE_CI_SECRET");
  assert(CI.includes('const key = req.headers.get("x-release-ci-key") ?? "";'), "the key must come from the x-release-ci-key header");
  assert(CI.includes(gate), "the empty-secret + timingSafeEqual gate is gone");
  assert(CI.indexOf(gate) < CI.indexOf("await req.json()"), "the body is read before the caller is authenticated");
  assert(!/searchParams/.test(CI), "a key in the URL lands in logs: release-ci must not read searchParams");
  assert(!/(?:===|!==)\s*secret\b|\bsecret\s*(?:===|!==)/.test(CI), "the secret is compared with === somewhere");
});

Deno.test("config.toml pins release-ci to verify_jwt = false, with the comment saying how it authenticates", () => {
  const m = /\[functions\.release-ci\]\n((?:#[^\n]*\n)+)verify_jwt = false\n/.exec(CONFIG);
  assert(m, "config.toml has no [functions.release-ci] block with a comment and verify_jwt = false");
  assert(/x-release-ci-key/.test(m![1]) && /RELEASE_CI_SECRET/.test(m![1]) && /constant time/.test(m![1]),
    "the release-ci block's comment must name the header, the secret and the constant-time compare");
});

Deno.test("portal-projects keeps no local copy of propagateStatus or CLIENT_STATUSES; both functions share _shared/pmStatus.ts", () => {
  assert(PROJECTS.includes('import { CLIENT_STATUSES, propagateStatus as propagateStatusShared } from "../_shared/pmStatus.ts";'),
    "portal-projects no longer imports the shared propagateStatus");
  assert(/const propagateStatus = \(item: any, columns: any\[\], newValues: Record<string, unknown>, oldValues: Record<string, unknown>\) =>\n\s*propagateStatusShared\(admin, act, item, columns, newValues, oldValues\);/.test(PROJECTS),
    "portal-projects' propagateStatus is no longer a thin wrapper over the shared one");
  assert(!/from\("feedback_submissions"\)\s*\n?\s*\.update\(\{ status: label\.client_status/.test(PROJECTS), "a local copy of propagateStatus' mirror write is back in portal-projects");
  assert(!/const CLIENT_STATUSES = new Set/.test(PROJECTS), "a local CLIENT_STATUSES is back in portal-projects");
  assert(CI.includes('import { propagateStatus } from "../_shared/pmStatus.ts";'), "release-ci must move items through the shared propagateStatus");
});

// ── 2. The real handler ──────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);

/** A test's window into the fake, called as each query runs (before its filters are applied): it
 *  can change `tables` to play a person editing at that moment, or return an error to fail the
 *  query. `cols` is the select list of a read (null for a write). Reset to null after each test. */
type Hook = (table: string, op: string, cols: string | null, payload: any) => { code: string; message: string } | void;
let hook: Hook | null = null;

/** A small in-memory stand-in for the PostgREST builder: the filters release-ci uses, in order. */
function fakeFrom(tables: Tables, writes: Array<[string, string, any]>) {
  return (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let cols: string | null = null;
    let payload: any = null;
    let order: [string, boolean] | null = null;
    let lim: number | null = null;
    let rng: [number, number] | null = null;
    const q: any = {
      // A select after an update only asks for the written rows back (the compare-and-swap).
      select: (c?: string) => ((op === "select" ? (cols = c ?? "*") : null), q),
      // `col->>key` is PostgREST's json path filter (release-ci reads pm_activity.detail->>sha).
      eq: (c: string, v: unknown) => (filters.push((r) => {
        const [col, key] = c.split("->>");
        return (key ? r[col]?.[key] : r[c]) === v;
      }), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
      lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      order: (c: string, o?: { ascending?: boolean }) => ((order = [c, o?.ascending !== false]), q),
      limit: (n: number) => ((lim = n), q),
      range: (a: number, b: number) => ((rng = [a, b]), q),
      insert: (row: Row) => ((op = "insert"), (payload = row), q),
      update: (row: Row) => ((op = "update"), (payload = row), q),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    const run = () => {
      const t = (tables[table] ||= []);
      const forced = hook?.(table, op, op === "select" ? cols : null, payload);
      if (forced) return { data: null, error: forced };
      if (WRITE_OPS.has(op)) writes.push([table, op, structuredClone(payload)]);
      if (op === "insert") {
        if (table === "release_notes" && payload.source_commit && t.some((r) => r.source_commit === payload.source_commit)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        // pm_activity.id is a bigserial: strictly increasing across calls, which `released` relies on.
        const id = table === "pm_activity" ? Math.max(0, ...t.map((r) => Number(r.id) || 0)) + 1 : crypto.randomUUID();
        t.push({ id, ...structuredClone(payload) });
        return { data: null, error: null };
      }
      let rows = t.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of rows) Object.assign(r, structuredClone(payload));
        return { data: structuredClone(rows), error: null };
      }
      if (order) {
        const [c, asc] = order;
        rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      return { data: structuredClone(rows), error: null };
    };
    return q;
  };
}

const CANON = [
  { id: "l_new", label: "New", client_status: "submitted", intake: true },
  { id: "l_review", label: "Under Review", client_status: "in_review" },
  { id: "l_missinfo", label: "Missing Info", client_status: "needs_info", kind: "stuck" },
  { id: "l_planned", label: "Planned", client_status: "planned" },
  { id: "l_inprogress", label: "In Progress", client_status: "in_progress", kind: "working" },
  { id: "l_onbeta", label: "On Beta", client_status: "in_progress", kind: "working" },
  { id: "l_done", label: "Done", client_status: "shipped", kind: "done" },
  { id: "l_declined", label: "Declined", client_status: "declined", kind: "done" },
  { id: "l_dup", label: "Duplicate", client_status: "duplicate", kind: "done" },
];
const uid = (p: string, n: number) => `${p}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const I = {
  linked: uid("3f2a9c1e", 1),      // bugs, Under Review, linked to a submission
  twinA: uid("5e5e5e5e", 2),       // two items sharing a prefix: "5e5e5e5e" is ambiguous
  twinB: uid("5e5e5e5e", 3),
  done: uid("aaaa0001", 4),        // already Done
  archived: uid("bbbb0001", 5),
  feature: uid("cccc0001", 6),     // features, New, unlinked
  byHand: uid("dddd0001", 7),      // On Beta set by hand: no release-ci activity
  roadmap: uid("eeee0001", 8),     // on the roadmap board: not release-ci's to move
};
function world(): Tables {
  const col = (id: string, board: string, labels: unknown[]) => ({ id, board_id: board, type: "status", name: "Status", position: 1024, settings: { labels } });
  const item = (id: string, board: string, status: string, extra: Row = {}) => ({
    id, board_id: board, values: { [`c-${board}`]: status }, feedback_submission_id: null, archived_at: null,
    updated_at: "2026-10-01T00:00:00.000Z", ...extra,
  });
  return {
    pm_boards: [{ id: "b-bugs", slug: "bugs" }, { id: "b-feat", slug: "features" }, { id: "b-work", slug: "working" }, { id: "b-road", slug: "roadmap" }],
    pm_columns: [
      col("c-b-bugs", "b-bugs", CANON), col("c-b-feat", "b-feat", CANON), col("c-b-work", "b-work", CANON),
      col("c-b-road", "b-road", [{ id: "l_idea", label: "Idea" }, { id: "l_onbeta", label: "On Beta" }]),
    ],
    pm_items: [
      item(I.linked, "b-bugs", "l_review", { feedback_submission_id: "sub-1" }),
      item(I.twinA, "b-bugs", "l_new"), item(I.twinB, "b-feat", "l_new"),
      item(I.done, "b-bugs", "l_done"), item(I.archived, "b-bugs", "l_new", { archived_at: "2026-09-01T00:00:00Z" }),
      item(I.feature, "b-feat", "l_new"), item(I.byHand, "b-bugs", "l_onbeta"), item(I.roadmap, "b-road", "l_idea"),
    ],
    feedback_submissions: [{ id: "sub-1", status: "in_review" }],
    pm_updates: [], pm_activity: [],
    release_notes: [
      { id: "n-1", title: "An older note somebody wrote by hand", section: "Contacts", status: "shipped", source_commit: null },
      { id: "n-2", title: "Copied earlier from a commit trailer", section: "", status: "beta", source_commit: "e".repeat(40) },
      { id: "n-3", title: "Saved views on every board", section: "", status: "roadmap", source_commit: null },
    ],
    client_settings: [
      { client_id: "acme-sheds", business_name: "Acme Sheds & Barns", internal_account: false },
      { client_id: "our-house", business_name: "Our House Studio", internal_account: true },
    ],
    client_configs: [{ client_id: "acme-sheds", company_name: "Acme Sheds" }, { client_id: "bravo-barns", company_name: "Bravo Barns LLC" }],
  };
}

// Load the handler with Deno.serve stubbed (the foundingAnnualOnly_test idiom).
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
try {
  await import(new URL("release-ci/index.ts", FUNCTIONS).href);
} finally {
  (Deno as any).serve = realServe;
}
if (!handler) throw new Error("release-ci did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

const SECRET = "harness-release-ci-secret";
async function call(tables: Tables, body: unknown, env: Record<string, string | undefined>, key: string | null = SECRET) {
  const writes: Array<[string, string, any]> = [];
  const keys = ["RELEASE_CI_SECRET", "RELEASE_CI_WRITES", "RELEASE_CI_MOVE_ITEMS", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  const set = { SUPABASE_URL: "https://harness.example.test", SUPABASE_SERVICE_ROLE_KEY: "harness-service-key", ...env };
  for (const k of keys) {
    const v = (set as Record<string, string | undefined>)[k];
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  stubDb.from = fakeFrom(tables, writes);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers["x-release-ci-key"] = key;
    const res = await HANDLER(new Request("https://harness.example.test/functions/v1/release-ci", { method: "POST", headers, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text), writes };
  } finally {
    stubDb.from = null;
    hook = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

const sha = (c: string) => c.repeat(40);
const CO = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const commit = (s: string, ...trailers: string[]) => ({ sha: s, message: `Subject\n\nBody.\n\n${[...trailers, CO].join("\n")}\n` });
const COMMITS = [
  commit(sha("1"), "Release-note: feature: Estimates can now carry a second contact", "Release-section: contacts", "Projects: 3f2a9c1e-0000-4000-8000-000000000001"),
  commit(sha("2"), "Release-note: fix: New price list loads faster for everyone"),
  commit(sha("3"), "Release-note: fix: The door picker works again for Acme Sheds"),
  commit(sha("4"), "Release-note: fix: An older note somebody wrote by hand"),
  commit(sha("5"), "Release-note: fix: short"),
  commit(sha("6"), "Release-note: none", "Projects: 5e5e5e5e, aaaa0001, bbbb0001, 99999999"),
  commit(sha("e"), "Release-note: fix: Copied earlier from a commit trailer"),
  commit(sha("7"), "Release-note: feature: Our House Studio themes reach every page", "Projects: cccc0001"),
];
const ON = { RELEASE_CI_SECRET: SECRET, RELEASE_CI_WRITES: "1", RELEASE_CI_MOVE_ITEMS: "1" };

Deno.test("no secret configured, no key, or a wrong key: 401 and nothing read or written", async () => {
  for (const [env, key] of [[{ RELEASE_CI_SECRET: undefined }, ""], [{ RELEASE_CI_SECRET: "" }, ""], [ON, null], [ON, "wrong"], [ON, SECRET + "x"]] as const) {
    const r = await call(world(), { action: "on_beta", commits: COMMITS }, env, key);
    assertEquals(r.status, 401);
    assertEquals(r.writes.length, 0);
  }
});

Deno.test("dark by default: with the secret but RELEASE_CI_WRITES unset, a full push is decided and NOTHING is written", async () => {
  for (const env of [{ RELEASE_CI_SECRET: SECRET, RELEASE_CI_MOVE_ITEMS: "1" }, { ...ON, RELEASE_CI_WRITES: "true" }]) {
    const r = await call(world(), { action: "on_beta", commits: COMMITS }, env);
    assertEquals(r.status, 200);
    assertEquals([r.body.dryRun, r.body.writes], [true, false]);
    assertEquals(r.writes, []);
    assertEquals(r.body.commits[0].result, "inserted", "a dry run still says what it WOULD do");
  }
  const asked = await call(world(), { action: "on_beta", commits: COMMITS, dryRun: true }, ON);
  assertEquals([asked.body.dryRun, asked.writes.length], [true, 0], "a request can always ask for a dry run");
  const rel = await call(world(), { action: "released", mergedShas: [sha("1")] }, { RELEASE_CI_SECRET: SECRET, RELEASE_CI_MOVE_ITEMS: "1" });
  assertEquals([rel.status, rel.body.dryRun, rel.writes.length], [200, true, 0]);
});

Deno.test("on_beta with writes on: every result, the note copied verbatim as 'beta', and no builder named back", async () => {
  const t = world();
  const r = await call(t, { action: "on_beta", commits: COMMITS }, ON);
  assertEquals(r.status, 200);
  assertEquals(r.body.commits.map((c: Row) => [c.sha, c.result]), [
    ["1111111", "inserted"], ["2222222", "held_commercial"], ["3333333", "held_names_builder"], ["4444444", "duplicate_title"],
    ["5555555", "refused"], ["6666666", "none"], ["eeeeeee", "exists"], ["7777777", "inserted"],
  ]);
  const notes = t.release_notes.filter((n) => n.source_commit && n.source_commit !== sha("e"));
  assertEquals(notes.map((n) => [n.kind, n.title, n.status, n.section, n.source_commit]), [
    ["feature", "Estimates can now carry a second contact", "beta", "Contacts", sha("1")],
    ["feature", "Our House Studio themes reach every page", "beta", "", sha("7")],
  ], "copied word for word, status beta; the section takes the existing chip's spelling; our own tenant is not a builder");
  // The response goes to PUBLIC Actions logs: no builder, no title.
  for (const s of ["acme", "bravo", "door picker", "second contact", "price list"]) {
    assert(!r.text.toLowerCase().includes(s), `the response echoes "${s}"`);
  }
  assertEquals(r.body.commits[2].why, "names a builder");
  assert(/pricing/.test(r.body.commits[1].why));
  assertEquals(r.body.commits[3].why, "the same words as an existing note");
  assertEquals(r.body.commits[0].newSection, undefined, "\"contacts\" is the existing Contacts chip, not a new one");
});

Deno.test("the holds read the detail and the section, not only the title", async () => {
  // The source: the held text is title + detail + section, and both holds read that text.
  assert(CI.includes('const text = [note.title, note.detail || "", note.section || ""].join(" \\n ");'),
    "the held text no longer joins title, detail and section");
  assert(CI.includes("const held = heldReason(text);") && CI.includes("namesBuilder(text, needles)"),
    "a hold no longer reads the joined text");
  // The behaviour: a clean title, with the builder's name or the price only in the detail or section.
  const clean = "Release-note: fix: The door picker opens on the first click";
  const r = await call(world(), {
    action: "on_beta", commits: [
      commit(sha("a"), clean, "Release-detail: Asked for by Acme Sheds last week"),
      commit(sha("b"), clean, "Release-detail: Saves $5 on every order"),
      commit(sha("c"), clean, "Release-section: Acme Sheds"),
      commit(sha("d"), clean, "Release-detail: Price lookups are faster too"),
    ],
  }, ON);
  assertEquals(r.status, 200);
  assertEquals(r.body.commits.map((c: Row) => c.result), ["held_names_builder", "held_commercial", "held_names_builder", "held_commercial"]);
  assertEquals(r.writes, [], "a held note is never written");
  assert(!r.text.toLowerCase().includes("acme"), "the response names the builder");
});

Deno.test("a roadmap entry's words answer duplicate_title and say so; a new section is copied and flagged", async () => {
  const t = world();
  const r = await call(t, {
    action: "on_beta", commits: [
      commit(sha("a"), "Release-note: feature: Saved views on every board"),
      commit(sha("b"), "Release-note: feature: Turn the 3D view with one finger", "Release-section: 3D Design"),
      commit(sha("c"), "Release-note: fix: The 3D view keeps its zoom on reload", "Release-section: 3d design"),
    ],
  }, ON);
  assertEquals(r.body.commits.map((c: Row) => [c.result, c.why ?? null, c.newSection ?? null]), [
    ["duplicate_title", "the same words as a roadmap entry: a person moves that entry to beta", null],
    ["inserted", null, true],
    ["inserted", null, true],
  ]);
  assertEquals(t.release_notes.filter((n) => n.source_commit === sha("b") || n.source_commit === sha("c")).map((n) => n.section),
    ["3D Design", "3D Design"], "the second note takes the first one's spelling, so the chips group");
  assertEquals(t.release_notes.find((n) => n.id === "n-3")!.status, "roadmap", "release-ci never touches a roadmap row");
});

Deno.test("on_beta moves Projects refs through the shared propagateStatus, and refuses what it cannot be sure of", async () => {
  const t = world();
  const r = await call(t, { action: "on_beta", commits: COMMITS }, ON);
  assertEquals(r.body.commits[0].refs, [{ ref: "3f2a9c1e000040008000000000000001", result: "moved" }]);
  assertEquals(r.body.commits[5].refs, [
    { ref: "5e5e5e5e", result: "ambiguous" }, { ref: "aaaa0001", result: "done_already" },
    { ref: "bbbb0001", result: "archived" }, { ref: "99999999", result: "not_found" },
  ]);
  const linked = t.pm_items.find((i) => i.id === I.linked)!;
  assertEquals(linked.values["c-b-bugs"], "l_onbeta");
  assertEquals(t.feedback_submissions[0].status, "in_progress", "the builder sees In progress");
  assert(t.pm_updates.some((u) => u.item_id === I.linked && u.body === "On beta in 1111111" && u.client_visible === false));
  assert(t.pm_activity.some((a) => a.item_id === I.linked && a.action === "release_ci_on_beta" && a.detail.sha === sha("1")));
  const statusOf = (id: string) => { const it = t.pm_items.find((i) => i.id === id)!; return it.values[`c-${it.board_id}`]; };
  assertEquals([I.twinA, I.twinB, I.done, I.archived].map(statusOf), ["l_new", "l_new", "l_done", "l_new"],
    "an ambiguous, done or archived ref moves nothing");
  assertEquals(r.writes.filter(([table]) => table === "pm_items").length, 2, "exactly the two resolvable items were written (sha 1's bug, sha 7's feature)");

  // With moves OFF: notes still go in, items are decided but stay put.
  const t2 = world();
  const r2 = await call(t2, { action: "on_beta", commits: COMMITS }, { ...ON, RELEASE_CI_MOVE_ITEMS: undefined });
  assertEquals([r2.body.moves, r2.body.commits[0].refs[0].result], [false, "moved"]);
  assertEquals(t2.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"], "l_review");
  assert(!r2.writes.some(([table]) => table === "pm_items" || table === "pm_updates" || table === "pm_activity" || table === "feedback_submissions"));
  assertEquals(r2.writes.filter(([table]) => table === "release_notes").length, 2);
});

Deno.test("a board without l_onbeta is reported, never guessed", async () => {
  const t = world();
  t.pm_columns.find((c) => c.id === "c-b-feat")!.settings.labels = CANON.filter((l) => l.id !== "l_onbeta");
  const r = await call(t, { action: "on_beta", commits: [commit(sha("8"), "Release-note: none", "Projects: cccc0001")] }, ON);
  assertEquals(r.body.commits[0].refs, [{ ref: "cccc0001", result: "no_onbeta_label" }]);
  assertEquals(r.writes, []);
});

Deno.test("the same push delivered twice writes nothing the second time, moves included", async () => {
  const t = world();
  await call(t, { action: "on_beta", commits: COMMITS }, ON);
  const again = await call(t, { action: "on_beta", commits: COMMITS }, ON);
  assertEquals(again.body.commits[0].result, "exists");
  assertEquals(again.body.commits[7].result, "exists");
  assertEquals(again.body.commits[0].refs, [{ ref: "3f2a9c1e000040008000000000000001", result: "exists" }]);
  assertEquals(again.writes, []);
  // ...and a commit that already moved an item never moves it BACK after a person moved it on.
  t.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"] = "l_inprogress";
  const third = await call(t, { action: "on_beta", commits: COMMITS }, ON);
  assertEquals(third.body.commits[0].refs[0].result, "exists");
  assertEquals(t.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"], "l_inprogress");
  assertEquals(third.writes, []);
});

Deno.test("released moves On Beta items to Done ONLY when their newest on-beta commit is in the promotion", async () => {
  const t = world();
  // sha 1 puts the linked bug on beta; sha 7 the feature; sha 9 puts the linked bug on beta AGAIN.
  await call(t, { action: "on_beta", commits: COMMITS }, ON);
  await call(t, { action: "on_beta", commits: [commit(sha("9"), "Release-note: none", "Projects: 3f2a9c1e-0000-4000-8000-000000000001")] }, ON);
  assertEquals(t.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"], "l_onbeta");

  // A promotion that carried 1 and 7 but not 9: the feature is released; the bug is NOT (its newest
  // work is not in the promotion); the hand-set item stays.
  const r = await call(t, { action: "released", mergedShas: [sha("1"), sha("7")] }, ON);
  assertEquals(r.status, 200);
  const byItem = Object.fromEntries(r.body.items.map((x: Row) => [x.item, x.result]));
  assertEquals(byItem, { [I.linked.slice(0, 8)]: "not_in_merge", [I.feature.slice(0, 8)]: "moved", [I.byHand.slice(0, 8)]: "set_by_hand" });
  assertEquals(t.pm_items.find((i) => i.id === I.feature)!.values["c-b-feat"], "l_done");
  assertEquals(t.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"], "l_onbeta");
  assertEquals(t.pm_items.find((i) => i.id === I.byHand)!.values["c-b-bugs"], "l_onbeta");
  assertEquals(t.pm_items.find((i) => i.id === I.roadmap)!.values["c-b-road"], "l_idea", "the roadmap board is not release-ci's");
  assertEquals(t.feedback_submissions[0].status, "in_progress");

  // The next promotion carries 9: now the bug is released, and its builder sees Completed (shipped).
  const r2 = await call(t, { action: "released", mergedShas: [sha("9")] }, ON);
  assertEquals(r2.body.items.find((x: Row) => x.item === I.linked.slice(0, 8)).result, "moved");
  assertEquals(t.pm_items.find((i) => i.id === I.linked)!.values["c-b-bugs"], "l_done");
  assertEquals(t.feedback_submissions[0].status, "shipped");
  assert(t.pm_updates.some((u) => u.item_id === I.linked && u.body === "Released in 9999999"));
});

Deno.test("an operator's edit made while release-ci works is never undone", async () => {
  const onBetaThen = async () => {
    const t = world();
    await call(t, { action: "on_beta", commits: [commit(sha("1"), "Release-note: none", "Projects: 3f2a9c1e")] }, ON);
    return t;
  };
  const linked = (t: Tables) => t.pm_items.find((i) => i.id === I.linked)!;
  const releasedRead = (cols: string | null) => cols === "id, item_id, detail";

  // 1. An edit to ANOTHER column after `released` took its snapshot: the re-read keeps it.
  let t = await onBetaThen();
  hook = (table, op, cols) => {
    if (table === "pm_activity" && op === "select" && releasedRead(cols)) {
      linked(t).values = { ...linked(t).values, "c-priority": "high" };
      linked(t).updated_at = "2026-10-09T09:00:00.000Z";
    }
  };
  let r = await call(t, { action: "released", mergedShas: [sha("1")] }, ON);
  assertEquals(r.body.items.find((x: Row) => x.item === I.linked.slice(0, 8)).result, "moved");
  assertEquals(linked(t).values, { "c-b-bugs": "l_done", "c-priority": "high" });

  // 2. An edit landing between the re-read and the write: the compare-and-swap refuses, nothing written.
  t = await onBetaThen();
  const notesBefore = t.pm_updates.length;
  hook = (table, op) => {
    if (table === "pm_items" && op === "update") {
      linked(t).values = { ...linked(t).values, "c-priority": "high" };
      linked(t).updated_at = "2026-10-09T09:00:01.000Z";
    }
  };
  r = await call(t, { action: "released", mergedShas: [sha("1")] }, ON);
  assertEquals(r.body.items.find((x: Row) => x.item === I.linked.slice(0, 8)).result, "changed_meanwhile");
  assertEquals(linked(t).values, { "c-b-bugs": "l_onbeta", "c-priority": "high" });
  assertEquals(t.feedback_submissions[0].status, "in_progress", "the builder is not told Completed");
  assertEquals(t.pm_updates.length, notesBefore);
  assert(!t.pm_activity.some((a) => a.action === "release_ci_released"));

  // 3. The STATUS changed after the snapshot: the decision is stale, so nothing is written.
  t = await onBetaThen();
  hook = (table, op, cols) => {
    if (table === "pm_activity" && op === "select" && releasedRead(cols)) {
      linked(t).values = { ...linked(t).values, "c-b-bugs": "l_inprogress" };
    }
  };
  r = await call(t, { action: "released", mergedShas: [sha("1")] }, ON);
  assertEquals(r.body.items.find((x: Row) => x.item === I.linked.slice(0, 8)).result, "changed_meanwhile");
  assertEquals(linked(t).values["c-b-bugs"], "l_inprogress");
  assertEquals(r.writes, []);
});

Deno.test("a move whose activity row failed is completed by re-running, with one note", async () => {
  const t = world();
  const push = { action: "on_beta", commits: [commit(sha("1"), "Release-note: none", "Projects: 3f2a9c1e")] };
  hook = (table, op, _cols, payload) => {
    if (table === "pm_activity" && op === "insert" && payload?.action === "release_ci_on_beta") {
      return { code: "08006", message: "connection lost" };
    }
  };
  let threw = false;
  try { await call(t, push, ON); } catch { threw = true; }
  assert(threw, "a failed activity write must fail the run, so the workflow shows it");
  const linked = t.pm_items.find((i) => i.id === I.linked)!;
  assertEquals(linked.values["c-b-bugs"], "l_onbeta", "the item moved before the failure");
  assertEquals(t.pm_activity.filter((a) => a.action === "release_ci_on_beta").length, 0);

  // Re-running the workflow run: the item is not moved again, the key is recorded, one note in all.
  const again = await call(t, push, ON);
  assertEquals(again.body.commits[0].refs, [{ ref: "3f2a9c1e", result: "already_on_beta" }]);
  assertEquals(again.writes.filter(([table]) => table === "pm_items").length, 0);
  assertEquals(t.pm_activity.filter((a) => a.action === "release_ci_on_beta" && a.detail.sha === sha("1")).length, 1);
  assertEquals(t.pm_updates.filter((u) => u.item_id === I.linked && u.body === "On beta in 1111111").length, 1);
  // ...so promotion moves it on, instead of calling it set by hand.
  const rel = await call(t, { action: "released", mergedShas: [sha("1")] }, ON);
  assertEquals(rel.body.items.find((x: Row) => x.item === I.linked.slice(0, 8)).result, "moved");
  // And a third delivery of the same push writes nothing at all.
  const third = await call(t, push, ON);
  assertEquals(third.writes, []);
});

Deno.test("bad requests are refused before anything is read", async () => {
  for (const body of [
    { action: "on_beta", commits: "nope" },
    { action: "on_beta", commits: Array.from({ length: 201 }, (_, i) => commit(i.toString(16).padStart(40, "0"), "Release-note: none")) },
    { action: "on_beta", commits: [{ sha: "ABC", message: "x" }] },
    { action: "released", mergedShas: ["not-a-sha"] },
    { action: "something_else" },
  ]) {
    const r = await call(world(), body, ON);
    assertEquals(r.status, 400, JSON.stringify(body).slice(0, 60));
    assertEquals(r.writes, []);
  }
});
