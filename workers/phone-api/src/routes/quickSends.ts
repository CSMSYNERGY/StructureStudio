// Quick sends: saved messages a person picks from a list instead of typing (the vault's
// _Extras/My Synergy Phone Quick Sends Plan 2026-10-01.md, section 2; tables in migration 258).
//
//   GET  /quick-sends               the caller's list, after giving them the starter set (once ever)
//   POST /quick-sends               {name, body, category?}     add one
//   POST /quick-sends/:id           {name?, body?, category?}   change one
//   POST /quick-sends/:id/delete
//   POST /quick-sends/:id/used      "used N×": counts an Insert, not a send
//
// EACH PERSON OWNS THEIR OWN LIST. The service role bypasses RLS (db.ts), so every query below
// is narrowed by hand to the caller's user_id AND client_id. Someone else's id answers
// not_found, word for word the same as an id that does not exist, so the answer confirms nothing.
//
// NOTHING HERE SENDS A TEXT. Insert fills the app's text box; the person presses Send, and the
// text goes through /sms/send with all of its checks. So these need phone access but not the
// tenant's switch (needOn: false): a builder can set up their list before the phone goes live.

import type { Ctx, Env } from "../env";
import { requireCaller, type Caller } from "../context";
import { must } from "../db";
import { ApiError, ok, readJson, UUID_RE } from "../http";
import { logFault } from "../log";

// Migration 258's checks, so a refusal here is a sentence instead of a database error.
export const NAME_MAX = 60;
export const BODY_MAX = 1600;
export const CATEGORY_MAX = 30;
/** Per person, on adding one. The starter set may take someone a little past it (258, choice 5). */
export const MAX_PER_PERSON = 100;
/** Far above the cap, so a list the starter set pushed past it still shows whole. */
const LIST_LIMIT = 500;

const COLUMNS = "id, name, body, category, sort_order, usage_count, updated_at";

export interface QuickSendRow {
  id: string;
  name: string;
  body: string;
  category: string | null;
  sort_order: number;
  usage_count: number;
  updated_at: string;
}

const notFound = () => new ApiError("not_found", "That quick send wasn't found.");

/** One quick send as the apps see it. */
export function quickSendOut(r: QuickSendRow) {
  return {
    id: r.id,
    name: r.name,
    body: r.body,
    category: r.category ?? null,
    sort_order: Number(r.sort_order) || 0,
    usage_count: Number(r.usage_count) || 0,
    updated_at: r.updated_at,
  };
}

// ── validation ──────────────────────────────────────────────────────────────────────

/** Characters the way Postgres's char_length counts them (code points: an emoji is one). */
const chars = (s: string) => [...s].length;

function nameOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || chars(s) > NAME_MAX) throw new ApiError("bad_request", `Give the quick send a name (up to ${NAME_MAX} characters).`);
  return s;
}

function bodyOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new ApiError("bad_request", "Write the message this quick send puts in the text box.");
  if (chars(s) > BODY_MAX) throw new ApiError("bad_request", "That message is too long. Keep it to 1,600 characters.");
  return s;
}

/**
 * Optional: missing, null or blank means none. Runs of spaces become one, because the category
 * is what the app groups the chips by, and "Follow  ups" must not become a second chip.
 */
function categoryOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiError("bad_request", "The category must be text.");
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (chars(s) > CATEGORY_MAX) throw new ApiError("bad_request", `Keep the category to ${CATEGORY_MAX} characters or fewer.`);
  return s;
}

/** A path id. Anything that is not a uuid cannot be a quick send, so it is not_found, never a DB error. */
function idOf(raw: string): string {
  if (!UUID_RE.test(raw)) throw notFound();
  return raw;
}

// ── GET /quick-sends ────────────────────────────────────────────────────────────────

export async function listQuickSends(env: Env, ec: Ctx, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  await seed(c, ec, req);
  const rows = (must(
    await c.admin.from("phone_quick_sends").select(COLUMNS)
      .eq("user_id", c.userId).eq("client_id", c.ctx.client_id)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: true })
      .limit(LIST_LIMIT),
    "list quick sends",
  ) as QuickSendRow[] | null) ?? [];
  return ok({ quick_sends: rows.map(quickSendOut) });
}

/**
 * The starter set, once ever per person and team: phone_seed_quick_sends claims a marker before
 * it copies, so two first opens at once copy it once, and deleting everything never brings it
 * back. It is a nicety, not the list: if it fails, the person still gets what they have, the
 * fault is logged, and the next open tries again.
 */
async function seed(c: Caller, ec: Ctx, req: Request): Promise<void> {
  let failure: string | null = null;
  try {
    const { error } = await c.admin.rpc("phone_seed_quick_sends", { p_user: c.userId, p_client: c.ctx.client_id });
    if (error) failure = error.message ?? "unknown";
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
  }
  if (failure !== null) {
    ec.waitUntil(logFault({
      code: "quick_send_seed_failed", message: `phone_seed_quick_sends failed: ${failure}`,
      req, clientId: c.ctx.client_id, throttleMs: 60_000,
    }));
  }
}

// ── POST /quick-sends ───────────────────────────────────────────────────────────────

export async function createQuickSend(env: Env, req: Request): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const body = await readJson(req);
  const fields = { name: nameOf(body.name), body: bodyOf(body.body), category: categoryOf(body.category) };

  // Highest sort_order first: the new one goes after it, and the row count says whether there is
  // room. Two saves at the same moment could both see 99 and land 101; the cap stops a runaway
  // list, it is not a quota, so that is fine.
  const top = (must(
    await c.admin.from("phone_quick_sends").select("sort_order")
      .eq("user_id", c.userId).eq("client_id", c.ctx.client_id)
      .order("sort_order", { ascending: false }).limit(MAX_PER_PERSON),
    "count quick sends",
  ) as { sort_order: number }[] | null) ?? [];
  if (top.length >= MAX_PER_PERSON) {
    throw new ApiError("bad_request", `You have ${MAX_PER_PERSON} quick sends, which is the most you can keep. Delete one you don't use, then add this one.`);
  }

  const saved = must(
    await c.admin.from("phone_quick_sends").insert({
      ...fields,
      user_id: c.userId,
      client_id: c.ctx.client_id,
      sort_order: top.length ? (Number(top[0].sort_order) || 0) + 1 : 0,
    }).select(COLUMNS).single(),
    "add quick send",
  ) as QuickSendRow | null;
  if (!saved) throw new ApiError("internal", "The quick send couldn't be saved. Please try again.");
  return ok({ quick_send: quickSendOut(saved) });
}

// ── POST /quick-sends/:id ───────────────────────────────────────────────────────────

/** Changes only the fields sent. `category: null` (or blank) takes the category away. */
export async function updateQuickSend(env: Env, req: Request, rawId: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const id = idOf(rawId);
  const body = await readJson(req);
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = nameOf(body.name);
  if (body.body !== undefined) patch.body = bodyOf(body.body);
  if (body.category !== undefined) patch.category = categoryOf(body.category);
  if (!Object.keys(patch).length) throw new ApiError("bad_request", "There's nothing to change. Send a new name, message or category.");
  patch.updated_at = new Date().toISOString();

  const rows = (must(
    await c.admin.from("phone_quick_sends").update(patch)
      .eq("id", id).eq("user_id", c.userId).eq("client_id", c.ctx.client_id)
      .select(COLUMNS),
    "save quick send",
  ) as QuickSendRow[] | null) ?? [];
  if (!rows.length) throw notFound();
  return ok({ quick_send: quickSendOut(rows[0]) });
}

// ── POST /quick-sends/:id/delete ────────────────────────────────────────────────────

export async function deleteQuickSend(env: Env, req: Request, rawId: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const id = idOf(rawId);
  const gone = (must(
    await c.admin.from("phone_quick_sends").delete()
      .eq("id", id).eq("user_id", c.userId).eq("client_id", c.ctx.client_id)
      .select("id"),
    "delete quick send",
  ) as { id: string }[] | null) ?? [];
  if (!gone.length) throw notFound();
  return ok();
}

// ── POST /quick-sends/:id/used ──────────────────────────────────────────────────────

/**
 * One Insert, counted in the database (usage_count + 1 in one statement, so two at once both
 * count). The app sends this in the background after it fills the box and ignores a failure.
 */
export async function quickSendUsed(env: Env, req: Request, rawId: string): Promise<Response> {
  const c = await requireCaller(env, req, { needOn: false });
  const id = idOf(rawId);
  const counted = must(
    await c.admin.rpc("phone_quick_send_used", { p_id: id, p_user: c.userId, p_client: c.ctx.client_id }),
    "count quick send use",
  );
  if (counted !== true) throw notFound();
  return ok();
}
