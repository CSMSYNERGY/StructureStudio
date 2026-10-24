// What a private board must actually keep private.
//
// The interesting case is NOT get_board. It is the forty actions that name an item, a
// column, an update or a storage path and never mention a board — each of those is a way to
// read or write a private board one row at a time, and each of them is one line in
// pmBoardPrivacy's maps. A line that is missing fails this file rather than production.
//
// Run: deno test supabase/functions/_shared/pmBoardPrivacy.test.ts
// (self-contained — no jsr:/npm: imports, so it runs offline in the preflight gate)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { boardsForAction, loadBoardPrivacy, NON_BOARD_ACTIONS } from "./pmBoardPrivacy.ts";

// ── A fake postgrest client, just enough of the chain the module uses ──────────────────────
// Rows are keyed by table; every query the module makes is .select(...).in("id", ids) or
// .eq(...).maybeSingle(), so the builder only has to remember the filters and apply them.
// deno-lint-ignore no-explicit-any
function fakeAdmin(tables: Record<string, any[]>) {
  const calls: string[] = [];
  // deno-lint-ignore no-explicit-any
  const from = (table: string) => {
    calls.push(table);
    // deno-lint-ignore no-explicit-any
    let rows: any[] = (tables[table] || []).slice();
    const b = {
      // deno-lint-ignore no-explicit-any
      select(_cols?: string) { return b as any; },
      // deno-lint-ignore no-explicit-any
      eq(col: string, v: unknown) { rows = rows.filter((r) => r[col] === v); return b as any; },
      // deno-lint-ignore no-explicit-any
      is(col: string, v: unknown) { rows = rows.filter((r) => (r[col] ?? null) === v); return b as any; },
      // deno-lint-ignore no-explicit-any
      in(col: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[col])); return b as any; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      then(res: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(res);
      },
    };
    return b;
  };
  return { admin: { from }, calls };
}

const B_PUB = "11111111-1111-1111-1111-111111111111";
const B_PRIV = "22222222-2222-2222-2222-222222222222";
const ITEM = "33333333-3333-3333-3333-333333333333";

const world = () => fakeAdmin({
  pm_items: [
    { id: ITEM, board_id: B_PRIV },
    { id: "44444444-4444-4444-4444-444444444444", board_id: B_PUB },
  ],
  pm_columns: [{ id: "c1", board_id: B_PRIV }],
  pm_groups: [{ id: "g1", board_id: B_PRIV }],
  pm_views: [{ id: "v1", board_id: B_PRIV }],
  pm_updates: [{ id: "u1", item_id: ITEM }],
}).admin;

Deno.test("an action nobody classified is REFUSED, not waved through", async () => {
  const r = await boardsForAction(world(), "export_everything", {});
  assertEquals(r.ok, false);
});

Deno.test("the non-board actions resolve to no board", async () => {
  for (const a of NON_BOARD_ACTIONS) {
    const r = await boardsForAction(world(), a, { boardId: B_PRIV });
    assert(r.ok);
    assertEquals(r.boardIds, [], `${a} must not be gated on a board`);
  }
});

Deno.test("a board named directly", async () => {
  const a = await boardsForAction(world(), "get_board", { boardId: B_PRIV });
  assert(a.ok && a.boardIds.includes(B_PRIV));
  const b = await boardsForAction(world(), "archive_board", { id: B_PRIV });
  assert(b.ok && b.boardIds.includes(B_PRIV));
});

Deno.test("every row-shaped action reaches the board its row lives on", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["update_item", { id: ITEM }],
    ["get_item", { id: ITEM }],
    ["reorder_item", { id: ITEM }],
    ["restore_item", { id: ITEM }],
    ["archive_items", { ids: [ITEM] }],
    ["add_update", { itemId: ITEM }],
    ["link_feedback", { itemId: ITEM }],
    ["unlink_feedback", { itemId: ITEM }],
    ["upload_attachment", { itemId: ITEM }],
    ["update_column", { id: "c1" }],
    ["delete_column", { id: "c1" }],
    ["update_group", { id: "g1" }],
    ["delete_group", { id: "g1" }],
    ["delete_view", { id: "v1" }],
    ["publish_update", { id: "u1" }],
    ["edit_update", { id: "u1" }],
    ["delete_update", { id: "u1" }],
    ["attach_meta", { updateId: "u1" }],
    ["move_items", { ids: [ITEM], groupId: "g1" }],
    ["sign_attachment", { path: `pm/${ITEM}/8f2a-shot.png` }],
  ];
  for (const [action, payload] of cases) {
    const r = await boardsForAction(world(), action, payload);
    assert(r.ok, `${action} refused`);
    assert(r.boardIds.includes(B_PRIV), `${action} did not reach the private board`);
  }
});

Deno.test("an overlay write is checked on BOTH boards", async () => {
  const r = await boardsForAction(world(), "update_item", { id: ITEM, fromBoardId: B_PUB });
  assert(r.ok);
  assertEquals(new Set(r.boardIds), new Set([B_PUB, B_PRIV]));
});

Deno.test("a row that does not exist resolves to no board — the action's own 404 answers", async () => {
  const r = await boardsForAction(world(), "update_item", { id: "99999999-9999-9999-9999-999999999999" });
  assert(r.ok);
  assertEquals(r.boardIds, []);
});

// ── loadBoardPrivacy ──────────────────────────────────────────────────────────────────────

const ME = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER = "aaaaaaaa-0000-0000-0000-000000000002";

const privacyWorld = () => fakeAdmin({
  pm_boards: [
    { id: B_PUB, visibility: "everyone", archived_at: null },
    { id: B_PRIV, visibility: "private", archived_at: null },
  ],
  pm_board_members: [
    { board_id: B_PRIV, user_id: OWNER, name: "Carolyn", email: "c@x.com", role: "owner" },
  ],
}).admin;

Deno.test("a private board is locked to an outsider, and names its owner", async () => {
  const p = await loadBoardPrivacy(privacyWorld(), ME);
  assertEquals(p.canSee(B_PUB), true);
  assertEquals(p.canSee(B_PRIV), false);
  assertEquals(p.locked.get(B_PRIV), ["Carolyn"]);
});

Deno.test("a member sees their own private board, and it is not in `locked`", async () => {
  const p = await loadBoardPrivacy(privacyWorld(), OWNER);
  assertEquals(p.canSee(B_PRIV), true);
  assertEquals(p.locked.size, 0);
});

Deno.test("with no private boards at all, nothing is locked and no membership is read", async () => {
  const f = fakeAdmin({ pm_boards: [{ id: B_PUB, visibility: "everyone", archived_at: null }] });
  const p = await loadBoardPrivacy(f.admin, ME);
  assertEquals(p.canSee(B_PRIV), true);
  assertEquals(f.calls.includes("pm_board_members"), false);
});
