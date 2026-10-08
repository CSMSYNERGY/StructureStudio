// portal-projects update_item from an OVERLAY board, driven through the SHIPPED handler (2026-10-09).
//
// WHY THIS EXISTS. Ongoing Projects (the working board, overlay_from bugs + features) shows rows that
// live on Bugs and Feature Requests, and the browser writes a cell back with the ids IT rendered: the
// working board's column ids AND the working board's choice ids. update_item re-keyed the column and
// stopped there, so any choice id the home board seeds differently was dropped by sanitizeValues:
//   * a status label came back as a 400, even when the home board has the same words;
//   * a dropdown was worse. sanitizeValues keeps a dropdown key with whatever survives, so the App
//     of a Feature row was WRITTEN as [] with a 200, while the cell showed the new value.
// The fix translates choice ids by label text through _shared/pmOverlay.ts remapValues, and keeps
// the refusals for anything that cannot be carried across. Pinned here against the real handler:
//   1. a Feature row's App, written with the working board's option id, lands as Features' own id;
//   2. a status label the home board has BY TEXT saves, as the home board's id;
//   3. a choice the home board does not have, a value that is no choice at all, or more choices
//      than the home column takes is a 400, and nothing is written;
//   4. no cross-board write is ever a 200 that did not write what it was asked to write.
//
// ⚠️ (4) IS THE TRAP THE DESIGN REVIEW CAUGHT. remapValues re-keys the COLUMN itself, so handing it
// values already re-keyed to the home board returns {} (every key misses). The old backstop compared
// what survived against that empty object, found nothing lost, and wrote nothing with a 200. A text
// marker in the source cannot see that; a request through the handler can.
//
// HOW. The deleteDesignWiring_test idiom: Deno.serve is stubbed while portal-projects/index.ts is
// imported, so a request goes through withErrorLog, verifyCaller, resolveProjectsAccess and the
// update_item branch as it does live. The import map swaps supabase-js for supabase_stub.ts, whose
// stubDb routes every table into the fake below. Nothing calls fetch and no --allow-net is granted.
// The import specifier is computed for the reason given in aiDraftStreamWiring_test.
//
// Boards, labels, option ids and people are made up. The repo is public.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubAuth, stubDb } from "./supabase_stub.ts";

// ─── The real handler ──────────────────────────────────────────────────────────────────────────
const realServe = Deno.serve;
let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => {
  handler = h;
  return { finished: Promise.resolve() };
};
await import(new URL("../../portal-projects/index.ts", import.meta.url).href);
(Deno as any).serve = realServe;
if (!handler) throw new Error("portal-projects did not hand Deno.serve a handler");
const HANDLER = handler as (req: Request) => Promise<Response>;

// ─── Three boards, seeded the way the live ones are: every board mints its own ids ─────────────
const WORKING = "board-working", BUGS = "board-bugs", FEATURES = "board-features";

const status = (id: string, labels: Array<[string, string]>) =>
  ({ id, name: "Status", type: "status", settings: { labels: labels.map(([lid, label]) => ({ id: lid, label })) } });
const dropdown = (id: string, name: string, options: Array<[string, string]>, multi = false) =>
  ({ id, name, type: "dropdown", settings: { options: options.map(([oid, label]) => ({ id: oid, label })), multi } });
const notes = (id: string) => ({ id, name: "Notes", type: "long_text", settings: {} });

// Bugs' App options. The working board's App column uses THESE ids (it was seeded from Bugs).
const APP_BUGS: Array<[string, string]> = [["o_fa01", "Structure Studio"], ["o_fa02", "CSM Studio"], ["o_fa03", "BuildBridge"]];

const COLUMNS: Record<string, any[]> = {
  [WORKING]: [
    // Its own three, then labels carried over from the two source boards with their ids.
    status("w-status", [
      ["l_todo", "To Do"], ["l_doing", "In Progress"], ["l_blocked", "Blocked"], ["l_wk_planned", "Planned"],
      ["l_fixed", "Fixed"], ["l_done", "Completed"],
    ]),
    // Multi-select here and single-choice on both homes: the worst case, since the page decides
    // single or multi from the column it SHOWS and so can send two Apps to a home that keeps one.
    dropdown("w-app", "App", APP_BUGS, true),
    dropdown("w-tags", "Tags", [["o_wk_mobile", "Mobile"], ["o_wk_web", "Web"]], true),
    notes("w-notes"),
    { id: "w-sprint", name: "Sprint", type: "text", settings: {} },   // nothing like it on Bugs or Features
  ],
  [BUGS]: [
    status("b-status", [["l_readydev", "Ready for Dev"], ["l_fixing", "In Progress"], ["l_fixed", "Fixed"], ["l_missinfo", "Missing Info"]]),
    dropdown("b-app", "App", APP_BUGS),
    notes("b-notes"),
  ],
  [FEATURES]: [
    status("f-status", [["l_new", "New"], ["l_review", "Under Review"], ["l_planned", "Planned"], ["l_done", "Completed"]]),
    // No BuildBridge, so there is a choice to refuse. Made up: the live Features board offers it.
    dropdown("f-app", "App", [["o_ss", "Structure Studio"], ["o_csm", "CSM Studio"]]),
    dropdown("f-tags", "Tags", [["o_mobile", "Mobile"], ["o_web", "Web"]], true),
    notes("f-notes"),
  ],
};

const FEATURE_ROW = {
  id: "item-feature", board_id: FEATURES, name: "Side nav", feedback_submission_id: null,
  // o_gone was an option somebody since deleted. It is still in the cell, as old values are.
  values: { "f-status": "l_review", "f-app": ["o_ss"], "f-tags": ["o_gone"], "f-notes": "keep me" },
};
const BUG_ROW = {
  id: "item-bug", board_id: BUGS, name: "Wall height off by an inch", feedback_submission_id: null,
  values: { "b-status": "l_readydev", "b-app": ["o_fa01"], "b-notes": "keep me too" },
};
const ROWS: Record<string, any> = { [FEATURE_ROW.id]: FEATURE_ROW, [BUG_ROW.id]: BUG_ROW };

const ENV: Record<string, string> = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "stub-anon",
  SUPABASE_SERVICE_ROLE_KEY: "stub-service",
};

type Trace = { writes: Record<string, any>[]; errors: unknown[] };

function answer(trace: Trace, table: string, ops: any[][]) {
  const has = (op: string) => ops.some((o) => o[0] === op);
  const arg = (op: string) => (ops.find((o) => o[0] === op) ?? [])[1];
  const eqv = (col: string) => ops.find((o) => o[0] === "eq" && o[1] === col)?.[2];
  if (table === "app_operators") {
    return { data: { user_id: "u-op", email: "operator@example.test", can_write: true, display_name: "Op", support_only: false }, error: null };
  }
  if (table === "pm_columns") return { data: COLUMNS[String(eqv("board_id"))] ?? [], error: null };
  if (table === "pm_people") return { data: [{ id: "p_1" }], error: null };
  if (table === "pm_activity") return { data: null, error: null };
  if (table === "pm_items") {
    const row = ROWS[String(eqv("id"))] ?? null;
    if (has("update")) {
      trace.writes.push(arg("update"));
      return { data: { ...row, ...arg("update") }, error: null };
    }
    return { data: row, error: null };
  }
  throw new Error(`the fake database has no answer for ${table} ${JSON.stringify(ops)}`);
}

function chain(trace: Trace, table: string, ops: any[][]): any {
  const next = (op: any[]) => chain(trace, table, [...ops, op]);
  const q: any = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "neq", "is", "in", "limit", "order", "single", "maybeSingle"]) {
    q[m] = (...a: unknown[]) => next([m, ...a]);
  }
  q.then = (ok: any, bad: any) => {
    if (table === "app_errors") {
      trace.errors.push((ops.find((o) => o[0] === "insert") ?? [])[1]);
      return Promise.resolve({ error: null }).then(ok, bad);
    }
    return Promise.resolve().then(() => answer(trace, table, ops)).then(ok, bad);
  };
  return q;
}

/** One update_item through the real handler. `fromBoardId` is what the browser sends, the board it is
 *  LOOKING at; null leaves it out of the body, as a page from before overlay boards did. */
async function updateItem(row: { id: string }, values: Record<string, unknown>, fromBoardId: string | null = WORKING) {
  const trace: Trace = { writes: [], errors: [] };
  const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  stubAuth.user = { id: "u-op", email: "operator@example.test" };
  stubAuth.error = null;
  stubDb.from = (table: string) => chain(trace, table, []);
  try {
    const res = await HANDLER(new Request("https://stub.supabase.co/functions/v1/portal-projects", {
      method: "POST",
      headers: { authorization: "Bearer harness", "content-type": "application/json" },
      body: JSON.stringify({ action: "update_item", id: row.id, ...(fromBoardId ? { fromBoardId } : {}), values }),
    }));
    return { status: res.status, body: await res.json(), trace };
  } finally {
    stubDb.from = null;
    stubAuth.user = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** The values the one pm_items write stored. Fails the test if there was not exactly one. */
const written = (t: Trace) => {
  assertEquals(t.writes.length, 1, "expected exactly one pm_items write");
  return t.writes[0].values as Record<string, unknown>;
};

// ─── 1. App on a Feature row ───────────────────────────────────────────────────────────────────
Deno.test("a Feature row's App, written with the working board's option id, lands as the Features option id", async () => {
  // The page always sends an array (the cell editor, and a bucket drop wraps the key too). The bare
  // id is defensive input: the handler accepts both shapes, so both are pinned.
  for (const sent of [["o_fa02"], "o_fa02"]) {
    const { status, body, trace } = await updateItem(FEATURE_ROW, { "w-app": sent });
    assertEquals(status, 200, JSON.stringify(body));
    assertEquals(written(trace), { ...FEATURE_ROW.values, "f-app": ["o_csm"] }, "only App changed, to Features' own id");
  }
});

Deno.test("a Bug row's App needs no translation and still saves", async () => {
  const { status, trace } = await updateItem(BUG_ROW, { "w-app": ["o_fa03"] });
  assertEquals(status, 200);
  assertEquals(written(trace), { ...BUG_ROW.values, "b-app": ["o_fa03"] });
});

// ─── 2. Status by label text ───────────────────────────────────────────────────────────────────
Deno.test("a status label the home board has BY TEXT saves, as the home board's own id", async () => {
  const bug = await updateItem(BUG_ROW, { "w-status": "l_doing" });             // "In Progress"
  assertEquals(bug.status, 200, JSON.stringify(bug.body));
  assertEquals(written(bug.trace)["b-status"], "l_fixing");

  const feature = await updateItem(FEATURE_ROW, { "w-status": "l_wk_planned" }); // "Planned"
  assertEquals(feature.status, 200, JSON.stringify(feature.body));
  assertEquals(written(feature.trace)["f-status"], "l_planned");

  // A label both boards share by id was already fine, and stays fine.
  const same = await updateItem(BUG_ROW, { "w-status": "l_fixed" });
  assertEquals(same.status, 200);
  assertEquals(written(same.trace)["b-status"], "l_fixed");
});

// ─── 3. A choice the home board does not have ──────────────────────────────────────────────────
Deno.test("a choice the home board does not have is refused, and nothing is written", async () => {
  const refusals: Array<[string, { id: string }, Record<string, unknown>]> = [
    ["Completed on a Bug row (Bugs has no such label)", BUG_ROW, { "w-status": "l_done" }],
    ["To Do on a Feature row (the working board's own label)", FEATURE_ROW, { "w-status": "l_todo" }],
    ["BuildBridge as a Feature row's App (Features has no such option)", FEATURE_ROW, { "w-app": ["o_fa03"] }],
    ["the same, as a bare id (defensive input: the page sends an array)", FEATURE_ROW, { "w-app": "o_fa03" }],
    // Shapes the page never sends. sanitizeValues made each of them [] with a 200.
    ["an object as App", FEATURE_ROW, { "w-app": { x: 1 } }],
    ["a null entry in App", FEATURE_ROW, { "w-app": [null] }],
    ["an empty-string entry in App", FEATURE_ROW, { "w-app": [""] }],
    ["a number as App", FEATURE_ROW, { "w-app": 5 }],
    ["a real choice beside a non-string one", FEATURE_ROW, { "w-app": ["o_fa02", 7] }],
  ];
  for (const [label, row, values] of refusals) {
    const { status, body, trace } = await updateItem(row, values);
    assertEquals(status, 400, `${label}: ${JSON.stringify(body)}`);
    assert(/That choice does not exist on the board this item lives on/.test(body.error), `${label}: ${body.error}`);
    assertEquals(trace.writes.length, 0, `${label}: refused, so nothing may be written`);
  }
});

Deno.test("two Apps sent to a home App that takes one are refused, never trimmed to the first", async () => {
  // Every id here exists on the home board, so nothing is "lost"; sanitizeValues just keeps one of
  // them, and that was a 200 storing Structure Studio while the cell showed both.
  for (const [row, values] of [
    [FEATURE_ROW, { "w-app": ["o_fa01", "o_fa02"] }],
    [BUG_ROW, { "w-app": ["o_fa01", "o_fa02"] }],
  ] as Array<[{ id: string }, Record<string, unknown>]>) {
    const { status, body, trace } = await updateItem(row, values);
    assertEquals(status, 400, `${row.id}: ${JSON.stringify(body)}`);
    assert(body.error.includes("App takes one choice"), body.error);
    assertEquals(trace.writes.length, 0, `${row.id}: refused, so nothing may be written`);
  }
  // The same choice twice is still one choice.
  const twice = await updateItem(FEATURE_ROW, { "w-app": ["o_fa02", "o_fa02"] });
  assertEquals(twice.status, 200, JSON.stringify(twice.body));
  assertEquals(written(twice.trace)["f-app"], ["o_csm"]);
});

Deno.test("a column the home board does not have is still a 400 naming it", async () => {
  const { status, body, trace } = await updateItem(FEATURE_ROW, { "w-sprint": "Sprint 4" });
  assertEquals(status, 400);
  assert(body.error.includes('"Sprint" does not exist on the board this item lives on'), body.error);
  assertEquals(trace.writes.length, 0);
});

// ─── 4. Never a 200 that wrote nothing ─────────────────────────────────────────────────────────
Deno.test("every cross-board write either stores what it asked for or is refused, never a quiet 200", async () => {
  const cases: Array<[{ id: string; values: Record<string, unknown> }, Record<string, unknown>, Record<string, unknown> | null]> = [
    [FEATURE_ROW, { "w-status": "l_wk_planned", "w-app": ["o_fa02"] }, { "f-status": "l_planned", "f-app": ["o_csm"] }],
    [FEATURE_ROW, { "w-status": "l_done", "w-notes": "moved on" }, { "f-status": "l_done", "f-notes": "moved on" }],
    [BUG_ROW, { "w-status": "l_doing", "w-notes": "picked up", "w-app": ["o_fa02"] },
      { "b-status": "l_fixing", "b-notes": "picked up", "b-app": ["o_fa02"] }],
    [BUG_ROW, { "w-notes": "" }, { "b-notes": null }],
    [FEATURE_ROW, { "w-app": [] }, { "f-app": [] }],                    // clearing App is a real edit
    [FEATURE_ROW, { "w-app": null }, { "f-app": null }],                // and so is clearing it with null
    [FEATURE_ROW, { "w-tags": ["o_wk_mobile", "o_wk_web"] }, { "f-tags": ["o_mobile", "o_web"] }], // multi keeps all
    [FEATURE_ROW, { "w-status": "l_blocked" }, null],
    [BUG_ROW, { "w-status": "l_done", "w-notes": "half of this is fine" }, null], // all or nothing
  ];
  for (const [row, values, want] of cases) {
    const { status, body, trace } = await updateItem(row, values);
    const what = `${row.id} ${JSON.stringify(values)}`;
    if (!want) {
      assertEquals(status, 400, `${what}: ${JSON.stringify(body)}`);
      assertEquals(trace.writes.length, 0, `${what}: a refusal writes nothing`);
      continue;
    }
    assertEquals(status, 200, `${what}: ${JSON.stringify(body)}`);
    const stored = written(trace);
    for (const [col, v] of Object.entries(want)) {
      assertEquals(stored[col], v, `${what}: ${col} was not stored`);
    }
    // The silent no-op wrote the row's own values back unchanged.
    assert(Object.keys(want).some((c) => JSON.stringify(stored[c]) !== JSON.stringify(row.values[c])),
      `${what}: a 200 that changed nothing`);
    assertEquals(trace.errors.length, 0);
  }
});

Deno.test("a multi dropdown keeps working when the row already holds an option that was since deleted", async () => {
  // The working board shows f-tags' o_gone as it is (it has no label to translate by), and the
  // multi-select editor sends it back alongside the new pick. The new pick is translated; the dead
  // id is dropped the way sanitizeValues always dropped it. Refusing here would make the row
  // uneditable from the working board for a reason the operator cannot see or fix there.
  const { status, body, trace } = await updateItem(FEATURE_ROW, { "w-tags": ["o_gone", "o_wk_mobile"] });
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(written(trace)["f-tags"], ["o_mobile"]);
});

// ─── The ordinary board is untouched ───────────────────────────────────────────────────────────
Deno.test("an edit on the item's own board, or with no fromBoardId (older pages), behaves exactly as before", async () => {
  for (const from of [BUGS, null]) {
    const { status, trace } = await updateItem(BUG_ROW, { "b-status": "l_fixing", "b-app": ["o_fa02"] }, from);
    assertEquals(status, 200);
    assertEquals(written(trace), { ...BUG_ROW.values, "b-status": "l_fixing", "b-app": ["o_fa02"] });
  }
  const own = await updateItem(FEATURE_ROW, { "f-app": ["o_csm"], "f-status": "l_planned" }, FEATURES);
  assertEquals(own.status, 200);
  assertEquals(written(own.trace), { ...FEATURE_ROW.values, "f-app": ["o_csm"], "f-status": "l_planned" });
});
