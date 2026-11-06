// PRIVATE BOARDS — who may see one, and how every action is pinned to a board.
//
// Carolyn, 2026-10-23: "Board settings in projects should have privacy settings so admins
// can create a board for themselves that others can't see. Somehow we need to easily see
// who all has access to see a board."
//
// Migration 334 adds pm_boards.visibility ('everyone' | 'private') and pm_board_members.
// This module is the rule those columns describe. It lives beside projectsAccess.ts for the
// same reason that one was extracted: a boundary nobody can exercise without signing in as
// four different people is a boundary nobody re-checks after the next edit.
//
// ── VISIBLE BUT LOCKED ───────────────────────────────────────────────────────────────────
// A private board still appears in the tab strip, with a padlock and its owners' names, and
// opening it is refused. Carolyn chose that over hiding it outright: on a console this small
// a board you cannot see is a board you cannot ask to join. The NAME is not the secret.
// list_boards therefore answers a stub for a locked board — id, slug, name, owners — and no
// counts, no columns, no items, no saved views.
//
// ── THE PART THAT IS ACTUALLY THE SECURITY ───────────────────────────────────────────────
// Gating get_board would be the obvious change and would be close to useless: forty other
// actions in portal-projects take an item id, a column id, an update id or a storage path
// and never mention a board at all. update_item on a card that lives on a private board is
// the same leak as opening it, one row at a time.
//
// So the guard is FAIL-CLOSED and sits at the door, before the switch: every action either
// appears in NON_BOARD_ACTIONS (the roster, the operator toggles, Client Setup, list_boards,
// create_board — none of which are about one board) or it MUST resolve to a board, through
// whichever id it happens to carry. An action that does neither is refused. That is
// deliberately inconvenient: a new board action added later and not classified here fails
// loudly on the first call instead of quietly skipping the check.
//
// Rows that do not exist resolve to no board and are let through — the action's own 404 is
// the right answer, and inventing a 403 for a missing id would leak which ids exist.

import { canRead, effectiveAccess, type Level } from "./access.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

const s = (v: unknown, max = 40): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Actions that are not about one board. Everything else must resolve one. */
export const NON_BOARD_ACTIONS = new Set([
  // The board list itself: it answers FOR each board, so it does its own filtering.
  "list_boards",
  // A board that does not exist yet cannot be private.
  "create_board",
  // The roster and the operator toggles (already operator-only at the door above).
  "list_people", "add_person", "save_person", "remove_person",
  "set_operator_access", "set_operator_support", "set_operator_write",
]);

interface Lookup { table: string; key: string; many?: boolean }

/** Actions whose payload names the board directly, as `boardId`. */
const BY_BOARD_ID = new Set([
  "get_board", "create_column", "reorder_columns", "create_group", "reorder_groups",
  "create_item", "save_view",
  // Privacy itself. Reading or changing a private board's access list is something you can
  // only do from inside it — which is exactly the check this map performs.
  "board_access", "set_board_visibility",
  "add_board_member", "remove_board_member", "set_board_member_role",
]);

/** Actions whose payload names the board as `id`. */
const BOARD_IS_ID = new Set(["update_board", "archive_board"]);

/** Actions that carry a row id belonging to a board. */
const LOOKUPS: Record<string, Lookup> = {
  update_column:     { table: "pm_columns", key: "id" },
  delete_column:     { table: "pm_columns", key: "id" },
  update_group:      { table: "pm_groups",  key: "id" },
  delete_group:      { table: "pm_groups",  key: "id" },
  delete_view:       { table: "pm_views",   key: "id" },
  get_item:          { table: "pm_items",   key: "id" },
  update_item:       { table: "pm_items",   key: "id" },
  reorder_item:      { table: "pm_items",   key: "id" },
  restore_item:      { table: "pm_items",   key: "id" },
  archive_items:     { table: "pm_items",   key: "ids", many: true },
  link_feedback:     { table: "pm_items",   key: "itemId" },
  unlink_feedback:   { table: "pm_items",   key: "itemId" },
  add_update:        { table: "pm_items",   key: "itemId" },
  upload_attachment: { table: "pm_items",   key: "itemId" },
};

/** Actions that reach a board through pm_updates → pm_items. */
const VIA_UPDATE: Record<string, string> = {
  publish_update: "id", edit_update: "id", delete_update: "id", attach_meta: "updateId",
};

export type BoardsForAction =
  | { ok: true; boardIds: string[] }
  | { ok: false; error: string };

/**
 * Every board this request touches. The caller refuses the request if ANY of them is one
 * the caller may not see — move_items and the overlay writes legitimately name two.
 */
export async function boardsForAction(
  admin: Admin,
  action: string,
  // deno-lint-ignore no-explicit-any
  payload: any,
): Promise<BoardsForAction> {
  const ids = new Set<string>();

  // An overlay board's writes carry the board the BROWSER was looking at as well as the
  // board the row lives on. Both have to be allowed, or a private board could be used as a
  // window onto a public one (and, worse, the other way round).
  const from = s(payload?.fromBoardId);
  if (from) ids.add(from);

  if (NON_BOARD_ACTIONS.has(action)) return { ok: true, boardIds: [...ids] };

  const add = (v: unknown) => { const id = s(v); if (id) ids.add(id); };

  if (BY_BOARD_ID.has(action)) { add(payload?.boardId); return { ok: true, boardIds: [...ids] }; }
  if (BOARD_IS_ID.has(action)) { add(payload?.id); return { ok: true, boardIds: [...ids] }; }

  const rowBoard = async (table: string, rowIds: string[]) => {
    if (!rowIds.length) return;
    const { data, error } = await admin.from(table).select("board_id").in("id", rowIds);
    if (error) throw new Error(error.message);
    for (const r of data || []) add(r.board_id);
  };

  const lk = LOOKUPS[action];
  if (lk) {
    const raw = payload?.[lk.key];
    const rowIds = (lk.many ? (Array.isArray(raw) ? raw : []) : [raw])
      .map((x: unknown) => s(x)).filter(Boolean);
    await rowBoard(lk.table, rowIds);
    return { ok: true, boardIds: [...ids] };
  }

  const upKey = VIA_UPDATE[action];
  if (upKey) {
    const upId = s(payload?.[upKey]);
    if (upId) {
      const { data: u, error } = await admin.from("pm_updates").select("item_id").eq("id", upId).maybeSingle();
      if (error) throw new Error(error.message);
      if (u?.item_id) await rowBoard("pm_items", [String(u.item_id)]);
    }
    return { ok: true, boardIds: [...ids] };
  }

  // Moving a card BETWEEN boards names both ends: the board the cards live on (through the
  // ids) and the board they are headed for. Both have to be open to the caller, or a move
  // becomes a way to read a private board (send a card in and read it back) or to write
  // into one (send a card in and leave it there).
  if (action === "move_plan" || action === "move_to_board") {
    const rowIds = (Array.isArray(payload?.ids) ? payload.ids : []).map((x: unknown) => s(x)).filter(Boolean);
    await rowBoard("pm_items", rowIds);
    add(payload?.toBoardId);
    return { ok: true, boardIds: [...ids] };
  }

  // move_items: the items being moved AND the group they land in — a cross-board move is
  // refused by the action itself, but the check must not depend on that staying true.
  if (action === "move_items") {
    const rowIds = (Array.isArray(payload?.ids) ? payload.ids : []).map((x: unknown) => s(x)).filter(Boolean);
    await rowBoard("pm_items", rowIds);
    const groupId = s(payload?.groupId);
    if (groupId) await rowBoard("pm_groups", [groupId]);
    return { ok: true, boardIds: [...ids] };
  }

  // sign_attachment hands out a signed URL for a storage path, which is the only action
  // that names no row at all. The bucket's path shape is pm/{itemId}/{file} (see
  // upload_attachment), so the item — and the board — is in the path.
  if (action === "sign_attachment") {
    const m = /^pm\/([0-9a-fA-F-]{36})\//.exec(s(payload?.path, 300));
    if (m) await rowBoard("pm_items", [m[1]]);
    return { ok: true, boardIds: [...ids] };
  }

  // Client Setup reads and writes builders' onboarding, not boards. Operator-only already.
  if (action.startsWith("setup_")) return { ok: true, boardIds: [...ids] };

  return { ok: false, error: `Unknown action "${action}".` };
}

export interface BoardPrivacy {
  /** board id → the owners' display names, for boards this login may NOT open. */
  locked: Map<string, string[]>;
  /** Can this login open that board? */
  canSee: (boardId: string) => boolean;
}

/**
 * Which boards are closed to this login, and who to ask about them.
 *
 * One query for the private boards and one for this login's memberships — not a per-board
 * check — because list_boards runs this on every load of the console.
 */
export async function loadBoardPrivacy(admin: Admin, userId: string): Promise<BoardPrivacy> {
  const { data: priv, error } = await admin.from("pm_boards")
    .select("id").eq("visibility", "private").is("archived_at", null);
  if (error) throw new Error(error.message);
  const privateIds = (priv || []).map((b: { id: string }) => String(b.id));

  const locked = new Map<string, string[]>();
  if (!privateIds.length) return { locked, canSee: () => true };

  const { data: mem, error: mErr } = await admin.from("pm_board_members")
    .select("board_id, user_id, name, email, role").in("board_id", privateIds);
  if (mErr) throw new Error(mErr.message);

  const mine = new Set<string>();
  const owners = new Map<string, string[]>();
  for (const r of mem || []) {
    const bid = String(r.board_id);
    if (String(r.user_id) === userId) mine.add(bid);
    if (r.role === "owner") {
      const list = owners.get(bid) || [];
      list.push(String(r.name || r.email || "someone"));
      owners.set(bid, list);
    }
  }
  for (const id of privateIds) if (!mine.has(id)) locked.set(id, owners.get(id) || []);

  return { locked, canSee: (boardId: string) => !locked.has(boardId) };
}

export interface AudienceMember {
  user_id: string;
  email: string | null;
  name: string;
  /** How they reach Projects: a platform operator, or an internal team member. */
  via: "operator" | "team";
  /** What they can do once they are in: 'edit' writes, 'view' reads. */
  level: "edit" | "view";
}

/**
 * EVERYONE WHO CAN REACH THE PROJECTS CONSOLE — projectsAccess.ts's two doors, enumerated.
 *
 * This is the other half of what Carolyn asked for. On a board set to "everyone", the
 * access list is not a property of the board at all: it is this roster, and showing it on
 * the board settings screen is the only way to answer "who all has access" without making
 * someone cross-reference the operator list against Settings → Team by hand.
 *
 * Support operators are excluded: the door refuses them outright, so listing them as people
 * who can see the board would be a lie.
 */
export async function projectsAudience(admin: Admin): Promise<AudienceMember[]> {
  const out: AudienceMember[] = [];
  const seen = new Set<string>();

  const { data: ops, error: oErr } = await admin.from("app_operators")
    .select("user_id, email, display_name, can_write, support_only");
  if (oErr) throw new Error(oErr.message);
  for (const o of ops || []) {
    if (o.support_only) continue;
    const uid = String(o.user_id);
    seen.add(uid);
    out.push({
      user_id: uid,
      email: o.email ? String(o.email) : null,
      name: String(o.display_name || o.email || "Operator"),
      via: "operator",
      level: o.can_write ? "edit" : "view",
    });
  }

  // Door 2: a client_users row on an INTERNAL tenant whose resolved `projects` level reads.
  // The internal tenants are read first — the area alone would admit every builder's owner,
  // which is the trap projectsAccess.ts warns about twice.
  const { data: internals, error: iErr } = await admin.from("client_settings")
    .select("client_id").eq("internal_account", true);
  if (iErr) throw new Error(iErr.message);
  const internalIds = (internals || []).map((r: { client_id: string }) => String(r.client_id));
  if (internalIds.length) {
    const { data: cus, error: cErr } = await admin.from("client_users")
      .select("user_id, role, title, access").in("client_id", internalIds);
    if (cErr) throw new Error(cErr.message);
    // pm_people already holds a name and an email for most of these logins (pmRoster.ts
    // keeps it in step with Settings → Team), so it answers first and auth is the fallback.
    const { data: people } = await admin.from("pm_people")
      .select("user_id, name, email").not("user_id", "is", null);
    const byUser = new Map<string, { name?: string; email?: string }>();
    for (const p of people || []) byUser.set(String(p.user_id), { name: p.name, email: p.email });

    for (const cu of cus || []) {
      const uid = String(cu.user_id || "");
      if (!uid || seen.has(uid)) continue;
      const acc = effectiveAccess(cu.role, cu.title, cu.access ?? null) as Record<string, Level>;
      if (!canRead(acc, "projects")) continue;
      seen.add(uid);
      const known = byUser.get(uid);
      let email = known?.email || null;
      let name = known?.name || "";
      if (!email || !name) {
        try {
          const { data: au } = await admin.auth.admin.getUserById(uid);
          email = email || au?.user?.email || null;
          name = name || String(au?.user?.user_metadata?.full_name || "")
            || (email ? String(email).split("@")[0] : "Team member");
        } catch (_) { name = name || "Team member"; }
      }
      out.push({
        user_id: uid,
        email,
        name,
        via: "team",
        level: acc.projects === "edit" ? "edit" : "view",
      });
    }
  }

  out.sort((a, b) => (a.via === b.via ? a.name.localeCompare(b.name) : a.via === "operator" ? -1 : 1));
  return out;
}
