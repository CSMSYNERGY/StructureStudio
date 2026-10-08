// propagateStatus against a fake client: the one rule by which a Projects status reaches a builder.
// Self-contained on purpose: no jsr:/npm: imports, so the gate does not need a registry fetch.
// Preflight runs this group.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CLIENT_STATUSES, propagateStatus } from "./pmStatus.ts";

type Call = { table: string; row: Record<string, unknown>; col: string; val: unknown };
function fakeAdmin(fail = false) {
  const calls: Call[] = [];
  const admin = {
    from: (table: string) => ({
      update: (row: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => {
          calls.push({ table, row, col, val });
          return Promise.resolve({ error: fail ? { message: "boom" } : null });
        },
      }),
    }),
  };
  return { admin, calls };
}
function fakeAct() {
  const acts: Array<{ board: string | null; item: string | null; action: string; detail: Record<string, unknown> }> = [];
  const act = (board: string | null, item: string | null, action: string, detail: Record<string, unknown> = {}) => {
    acts.push({ board, item, action, detail });
    return Promise.resolve();
  };
  return { act, acts };
}

// The canonical list's shape (migration 293), on a made-up column id.
const COLS = [
  { id: "c-notes", type: "long_text", settings: {} },
  {
    id: "c-status", type: "status", settings: {
      labels: [
        { id: "l_new", label: "New", client_status: "submitted", intake: true },
        { id: "l_onbeta", label: "On Beta", client_status: "in_progress", kind: "working" },
        { id: "l_done", label: "Done", client_status: "shipped", kind: "done" },
        { id: "l_internal", label: "Internal only" },
        { id: "l_bogus", label: "Bogus", client_status: "live" },
      ],
    },
  },
];
const LINKED = { id: "item-1", board_id: "board-1", feedback_submission_id: "sub-1" };

Deno.test("CLIENT_STATUSES is 054's eight states, no more", () => {
  assertEquals([...CLIENT_STATUSES].sort(),
    ["declined", "duplicate", "in_progress", "in_review", "needs_info", "planned", "shipped", "submitted"]);
});

Deno.test("a linked item moved to On Beta mirrors in_progress to its submission and logs client_status", async () => {
  const { admin, calls } = fakeAdmin();
  const { act, acts } = fakeAct();
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_onbeta" }, { "c-status": "l_new" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "feedback_submissions");
  assertEquals(calls[0].row.status, "in_progress");
  assert(typeof calls[0].row.status_changed_at === "string" && typeof calls[0].row.updated_at === "string");
  assertEquals([calls[0].col, calls[0].val], ["id", "sub-1"]);
  assertEquals(acts, [{ board: "board-1", item: "item-1", action: "client_status", detail: { to: "in_progress", label: "On Beta" } }]);
});

Deno.test("Done reaches the builder as shipped", async () => {
  const { admin, calls } = fakeAdmin();
  const { act } = fakeAct();
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_done" }, { "c-status": "l_onbeta" });
  assertEquals(calls.map((c) => c.row.status), ["shipped"]);
});

Deno.test("an UNLINKED item touches nothing and logs nothing", async () => {
  const { admin, calls } = fakeAdmin();
  const { act, acts } = fakeAct();
  await propagateStatus(admin, act, { id: "i2", board_id: "b", feedback_submission_id: null }, COLS, { "c-status": "l_done" }, {});
  assertEquals(calls.length, 0);
  assertEquals(acts.length, 0);
});

Deno.test("no change, a non-status column, an unknown label: nothing written", async () => {
  const { admin, calls } = fakeAdmin();
  const { act, acts } = fakeAct();
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_new" }, { "c-status": "l_new" });
  await propagateStatus(admin, act, LINKED, COLS, { "c-notes": "hello" }, {});
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_gone" }, {});
  assertEquals(calls.length, 0);
  assertEquals(acts.length, 0);
});

Deno.test("an internal-only label, or a client_status off the ladder, logs a plain status change and never writes the mirror", async () => {
  const { admin, calls } = fakeAdmin();
  const { act, acts } = fakeAct();
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_internal" }, {});
  await propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_bogus" }, {});
  assertEquals(calls.length, 0);
  assertEquals(acts.map((a) => [a.action, a.detail.label]), [["status", "Internal only"], ["status", "Bogus"]]);
});

Deno.test("a failed mirror write throws, and logs no activity", async () => {
  const { admin } = fakeAdmin(true);
  const { act, acts } = fakeAct();
  await assertRejects(() => propagateStatus(admin, act, LINKED, COLS, { "c-status": "l_done" }, {}));
  assertEquals(acts.length, 0);
});
