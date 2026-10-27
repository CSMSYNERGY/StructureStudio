// Settings → Options → Doors → Door looks (migrations 343 and 344; plan "Door looks from a photo",
// 2026-10-24, phase P3): a builder's own 3D door looks, saved, listed and archived here, and the rule
// that puts one on a door row (save_fixture and import_fixtures in index.ts call doorLookForFixture /
// resolveDoorLookWrite).
//
// WHAT IS NOT HERE. Generating a look from a photo (generate_door_look, its recover and the self-check)
// is P4/P5: they call the model and sit behind the DOOR_LOOK_AI_ENABLED kill switch as well. Everything
// here is free and calls no model, so only the tenant flag gates it.
//
// THE TENANT FLAG. client_settings.door_looks_beta gates every action in this file and a doorLookId on
// a door row. It fails closed: a read that errors refuses, and a database without 343 (42703 / 42P01)
// reads as "not available yet". Only structure-studio gets it before promotion.
//
// THE CLEANER. Every spec that is stored goes through _shared/doorLook.ts's sanitizeDoorLook (P1), the
// same cleaner the AI output goes through, so a hand-built save can store nothing a generated look
// could not. It returns the cleaned spec, or null when the input cannot be cleaned.
//
// The tenant is resolveTenant's; nothing here reads a client id from the body. Every row is matched on
// (client_id, id), so another builder's id simply finds nothing. Storage paths are chosen here and
// checked against their exact shape before anything trusts them (a prefix check is beaten by `..`).

import { sanitizeDoorLook } from "../_shared/doorLook.ts";
import { canonicalJson } from "../_shared/styleSaveGuard.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
export type DoorLookCtx = {
  admin: Db; req: Request; clientId: string; userId: string | null;
  action: string; payload: Record<string, unknown>;
  json: (b: unknown, s?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
};
export type Refusal = { status: number; code: string; error: string };

/** The seven bases, the same list as 343's door_looks_base_chk. The cleaner decides; this only lets a
 *  bad answer from it be refused in words instead of as a constraint error. */
export const DOOR_LOOK_BASES: readonly string[] = ["plank", "zbrace", "xbrace", "american", "basic", "classic", "dutch"];
export const DOOR_LOOK_NAME_MAX = 60;
/** 343's door_looks_spec_chk: octet_length(spec::text) <= 4096. */
export const DOOR_LOOK_SPEC_MAX_BYTES = 4096;
export const DOOR_REF_MAX_PHOTOS = 4;
const LOOK_COLS = "id, name, base, spec, spec_version, status, thumb_url, ai_call_id, version, created_at, updated_at";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// ── Refusals, in words ─────────────────────────────────────────────────────────────────────
export const DOOR_LOOKS_OFF: Refusal = { status: 403, code: "door_looks_off", error: "Door looks aren't turned on for your account." };
export const DOOR_LOOKS_UNAVAILABLE: Refusal = { status: 503, code: "door_looks_unavailable", error: "Door looks aren't available yet. Try again later." };
const LOOK_NOT_FOUND: Refusal = { status: 404, code: "door_look_not_found", error: "That 3D look isn't in your catalog any more. Reload the page and pick another." };
const LOOK_ARCHIVED: Refusal = { status: 409, code: "door_look_archived", error: "That 3D look was archived. Reload the page and pick another." };
const LOOK_NOT_READY: Refusal = { status: 409, code: "door_look_not_ready", error: "Save that 3D look first, then put it on your doors." };

/** A database without 343 (or a PostgREST that has not reloaded): the column or table is unknown. */
export const lookSchemaMissing = (err: unknown): boolean =>
  ["42703", "42P01", "PGRST204", "PGRST205"].includes(String((err as { code?: string } | null)?.code ?? ""));

/** client_settings.door_looks_beta. `ready` false = a database without 343, which reads as off. */
export async function readDoorLooksFlag(admin: Db, clientId: string): Promise<{ on: boolean; ready: boolean; error?: unknown }> {
  try {
    const { data, error } = await admin.from("client_settings").select("door_looks_beta").eq("client_id", clientId).maybeSingle();
    if (error) return lookSchemaMissing(error) ? { on: false, ready: false } : { on: false, ready: true, error };
    return { on: data?.door_looks_beta === true, ready: true };
  } catch (e) {
    return { on: false, ready: true, error: e };
  }
}

// ── Paths ──────────────────────────────────────────────────────────────────────────────────
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A reference photo in the private door-refs bucket, exactly as door_ref_upload_url names it. Tenant
 *  ids are text slugs, so the id is escaped, never assumed to be a uuid. */
export const doorRefPathOk = (clientId: string, path: unknown): path is string =>
  typeof path === "string" && new RegExp(`^${escapeRe(clientId)}/door-ref-${UUID}\\.(jpg|png|webp)$`).test(path);
/** A look's tile in the public fixtures bucket, exactly as door_look_thumb_upload_url names it. */
export const doorThumbPathOk = (clientId: string, path: unknown): path is string =>
  typeof path === "string" && new RegExp(`^${escapeRe(clientId)}/door-look-${UUID}\\.png$`).test(path);
const REF_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ── The spec ───────────────────────────────────────────────────────────────────────────────
/** The spec's size AS STORED, which is what 343's check measures: Postgres prints jsonb with a space
 *  after every ':' and ',' between members ({"a": 1, "b": [1, 2]}), so the compact JSON plus one byte
 *  per separator outside strings. The cleaner rounds its numbers, so their text matches too. */
export function doorLookStoredBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? "";
  let extra = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === ":" || c === ",") extra++;
  }
  return new TextEncoder().encode(s).length + extra;
}

/** The cleaner's answer, or a refusal. A spec it cannot clean, one naming a base outside the seven or
 *  another version, and one too big to store are all refused here, in words. `clean` is the cleaner,
 *  a parameter only so a test can hand it one whose answer is too big to store. */
export function cleanSpec(raw: unknown, clean: (raw: unknown) => unknown = sanitizeDoorLook): { spec: Record<string, unknown>; base: string; v: number } | { refuse: Refusal } {
  let cleaned: unknown = null;
  try { cleaned = clean(raw); } catch (_) { cleaned = null; }
  const c = cleaned as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.base !== "string" || !DOOR_LOOK_BASES.includes(c.base) || c.v !== 1) {
    return { refuse: { status: 400, code: "door_look_invalid", error: "We couldn't read that look. Reload the page and try again." } };
  }
  if (doorLookStoredBytes(c) > DOOR_LOOK_SPEC_MAX_BYTES) {
    return { refuse: { status: 400, code: "door_look_too_big", error: "This look has too many parts to save. Remove a part or two, then save again." } };
  }
  return { spec: c, base: c.base, v: 1 };
}

/** What the browser gets for a look: never the ledger row, only whether one exists. */
// deno-lint-ignore no-explicit-any
const lookOut = (r: any, usage?: { rows: number; doors: number }) => ({
  id: r.id, name: r.name, base: r.base, spec: r.spec, v: r.spec_version, status: r.status,
  thumbUrl: r.thumb_url ?? null, version: r.version, fromPhoto: r.ai_call_id != null,
  createdAt: r.created_at, updatedAt: r.updated_at,
  ...(usage ? { usedOn: usage } : {}),
});

// ── A look on a door row (save_fixture and import_fixtures) ───────────────────────────────
export type LookRef = { base: string; status: string };
export type DoorLookWrite = { door_look_id?: string | null; door_style?: string };

/**
 * What a door row's save writes about its look. THE RULE (plan §6), because today's production portal
 * sends doorStyle on EVERY door save and edge functions reach production at once:
 *   * `doorLookId: <id>` puts the look on the row and forces door_style to the look's base. Refused
 *     unless the tenant flag is on and the look is this builder's and READY.
 *   * `doorLookId: null` takes the look off (the row keeps its base as its standard look).
 *   * NO doorLookId key never clears a look, with one exception: a doorStyle that differs from the
 *     look's stored base (the builder picked another standard look). A price edit from the old
 *     portal, which sends the base as doorStyle, keeps the look.
 * `sent` undefined = the key was absent; `styleSent` = the door_style this save writes, if it sent one.
 */
export function resolveDoorLookWrite(x: {
  sent: { id: string | null } | undefined;
  styleSent: string | undefined;
  currentLookId: string | null;
  looks: ReadonlyMap<string, LookRef>;
  flagOn: boolean;
}): { write: DoorLookWrite } | { refuse: Refusal } {
  if (x.sent && x.sent.id !== null) {
    if (!x.flagOn) return { refuse: DOOR_LOOKS_OFF };
    const l = x.looks.get(x.sent.id);
    if (!l) return { refuse: LOOK_NOT_FOUND };
    if (l.status === "archived") return { refuse: LOOK_ARCHIVED };
    if (l.status !== "ready") return { refuse: LOOK_NOT_READY };
    return { write: { door_look_id: x.sent.id, door_style: l.base } };
  }
  if (x.sent) return { write: x.currentLookId ? { door_look_id: null } : {} };
  if (x.styleSent !== undefined && x.currentLookId) {
    const l = x.looks.get(x.currentLookId);
    // An unknown look keeps the row as it is: never clear on what we could not read.
    if (l && x.styleSent !== l.base) return { write: { door_look_id: null } };
  }
  return { write: {} };
}

async function looksById(admin: Db, clientId: string, ids: string[]): Promise<{ looks: Map<string, LookRef>; error?: unknown; missing?: boolean }> {
  const looks = new Map<string, LookRef>();
  if (!ids.length) return { looks };
  const { data, error } = await admin.from("door_looks").select("id, base, status").eq("client_id", clientId).in("id", ids);
  if (error) return { looks, error, missing: lookSchemaMissing(error) };
  for (const r of data ?? []) looks.set(String(r.id), { base: String(r.base), status: String(r.status) });
  return { looks };
}

/**
 * save_fixture's half: reads what the rule needs for ONE row and merges the answer into `rec`. Reads
 * nothing for a non-door, or for a door save that sends neither key that matters. On a database without
 * 343 a row save that never named a look goes through untouched; one that sets a look is refused.
 */
export async function doorLookForFixture(admin: Db, clientId: string, x: {
  category: string; rec: Record<string, unknown>; sent: { id: string | null } | undefined; rowId: string | null;
}): Promise<{ ok: true } | { refuse: Refusal } | { dbError: unknown; where: string }> {
  if (x.category !== "door") return { ok: true };
  const styleSent = "door_style" in x.rec ? String(x.rec.door_style) : undefined;
  if (!x.sent && (styleSent === undefined || !x.rowId)) return { ok: true };
  const setting = !!x.sent && x.sent.id !== null;
  let currentLookId: string | null = null;
  if (x.rowId) {
    const r = await admin.from("fixture_items").select("door_look_id").eq("client_id", clientId).eq("id", x.rowId).eq("category", "door").maybeSingle();
    if (r.error) {
      if (lookSchemaMissing(r.error)) return setting ? { refuse: DOOR_LOOKS_UNAVAILABLE } : { ok: true };
      return { dbError: r.error, where: "check that door's 3D look" };
    }
    currentLookId = r.data?.door_look_id ?? null;
  }
  // Clearing on a row that has no look, or sending the base with no look on file: nothing to write.
  if (!setting && !currentLookId) return { ok: true };
  const ids = [...new Set([setting ? x.sent!.id : null, currentLookId].filter((v): v is string => !!v))];
  const l = await looksById(admin, clientId, ids);
  if (l.error) {
    if (l.missing) return setting ? { refuse: DOOR_LOOKS_UNAVAILABLE } : { ok: true };
    return { dbError: l.error, where: "check that door's 3D look" };
  }
  let flagOn = false;
  if (setting) {
    const f = await readDoorLooksFlag(admin, clientId);
    if (f.error) return { dbError: f.error, where: "check door looks are on for your account" };
    if (!f.ready) return { refuse: DOOR_LOOKS_UNAVAILABLE };
    flagOn = f.on;
  }
  const res = resolveDoorLookWrite({ sent: x.sent, styleSent, currentLookId, looks: l.looks, flagOn });
  if ("refuse" in res) return { refuse: res.refuse };
  Object.assign(x.rec, res.write);
  return { ok: true };
}

export type ImportLookState = { available: boolean; flagOn: boolean; currentById: Map<string, string | null>; looks: Map<string, LookRef> };

/**
 * import_fixtures' half: everything the rule needs for a whole sheet, read ONCE (no query per row).
 * null = nothing to do (not doors, or no row carries doorStyle or doorLookId).
 */
// deno-lint-ignore no-explicit-any
export async function doorLookImportState(admin: Db, clientId: string, category: string, rows: any[]): Promise<{ state: ImportLookState | null } | { dbError: unknown; where: string }> {
  if (category !== "door") return { state: null };
  const hasKey = (r: unknown, k: string) => !!r && typeof r === "object" && Object.prototype.hasOwnProperty.call(r, k) && (r as Record<string, unknown>)[k] !== undefined;
  if (!rows.some((r) => hasKey(r, "doorLookId") || hasKey(r, "doorStyle"))) return { state: null };
  const state: ImportLookState = { available: true, flagOn: false, currentById: new Map(), looks: new Map() };
  const cur = await admin.from("fixture_items").select("id, door_look_id").eq("client_id", clientId).eq("category", "door");
  if (cur.error) {
    if (lookSchemaMissing(cur.error)) return { state: { ...state, available: false } };
    return { dbError: cur.error, where: "read your doors' 3D looks" };
  }
  for (const r of cur.data ?? []) state.currentById.set(String(r.id), r.door_look_id ?? null);
  const lk = await admin.from("door_looks").select("id, base, status").eq("client_id", clientId);
  if (lk.error) {
    if (lookSchemaMissing(lk.error)) return { state: { ...state, available: false } };
    return { dbError: lk.error, where: "read your 3D door looks" };
  }
  for (const r of lk.data ?? []) state.looks.set(String(r.id), { base: String(r.base), status: String(r.status) });
  if (rows.some((r) => hasKey(r, "doorLookId") && r.doorLookId !== null && String(r.doorLookId).trim() !== "")) {
    const f = await readDoorLooksFlag(admin, clientId);
    if (f.error) return { dbError: f.error, where: "check door looks are on for your account" };
    if (!f.ready) return { state: { ...state, available: false } };
    state.flagOn = f.on;
  }
  return { state };
}

/** One import row: the same rule, from the sheet-wide state. A refusal leaves the row's look as it was
 *  and becomes a note; the rest of the row still goes in. */
export function doorLookImportRow(state: ImportLookState, rec: Record<string, unknown>, sent: { id: string | null } | undefined, rowId: string | null): { note?: string } {
  const styleSent = "door_style" in rec ? String(rec.door_style) : undefined;
  if (!state.available) return sent && sent.id !== null ? { note: DOOR_LOOKS_UNAVAILABLE.error } : {};
  const currentLookId = rowId ? state.currentById.get(rowId) ?? null : null;
  const res = resolveDoorLookWrite({ sent, styleSent, currentLookId, looks: state.looks, flagOn: state.flagOn });
  if ("refuse" in res) return { note: res.refuse.error };
  Object.assign(rec, res.write);
  return {};
}

// ── The actions ────────────────────────────────────────────────────────────────────────────
export async function handleDoorLookAction(x: DoorLookCtx): Promise<Response> {
  const { admin, req, clientId, action, payload: p, json, dbFail } = x;
  const refuse = (r: Refusal, extra: Record<string, unknown> = {}) => json({ error: r.error, code: r.code, ...extra }, r.status);

  // The tenant flag first, for every action here. Fails closed.
  const flag = await readDoorLooksFlag(admin, clientId);
  if (flag.error) return dbFail(req, clientId, "check door looks are on for your account", flag.error, 503);
  if (!flag.ready) return refuse(DOOR_LOOKS_UNAVAILABLE);
  if (!flag.on) return refuse(DOOR_LOOKS_OFF);

  // ── list_door_looks ──────────────────────────────────────────────────────────────────────
  // The builder's looks, newest first, each with how many door rows use it ("used on N doors": the
  // rows, and the distinct door names, which is how the "Use on…" ticks group sizes).
  if (action === "list_door_looks") {
    let q = admin.from("door_looks").select(LOOK_COLS).eq("client_id", clientId);
    if (p.includeArchived !== true) q = q.neq("status", "archived");
    const [looks, rows] = await Promise.all([
      q.order("updated_at", { ascending: false }).limit(200),
      admin.from("fixture_items").select("id, name, door_look_id").eq("client_id", clientId).eq("category", "door").not("door_look_id", "is", null),
    ]);
    if (looks.error) return dbFail(req, clientId, "load your door looks", looks.error);
    if (rows.error) return dbFail(req, clientId, "count the doors using your looks", rows.error);
    const use = new Map<string, { rows: number; names: Set<string> }>();
    for (const r of rows.data ?? []) {
      const k = String(r.door_look_id);
      const u = use.get(k) ?? { rows: 0, names: new Set<string>() };
      u.rows++; u.names.add(String(r.name ?? "").trim().toLowerCase());
      use.set(k, u);
    }
    return json({
      ok: true,
      looks: (looks.data ?? []).map((r: { id: string }) => {
        const u = use.get(String(r.id));
        return lookOut(r, { rows: u?.rows ?? 0, doors: u?.names.size ?? 0 });
      }),
    });
  }

  // ── door_ref_upload_url ──────────────────────────────────────────────────────────────────
  // Signed upload URLs for up to four reference photos (the front, and up to three close-ups), into
  // the PRIVATE door-refs bucket at paths chosen here: {tenant}/door-ref-{uuid}.{ext}. No public URL:
  // nothing reads these but the server, through short signed URLs (P4).
  if (action === "door_ref_upload_url") {
    const types: unknown[] = Array.isArray(p.contentTypes) ? p.contentTypes : [p.contentType ?? "image/jpeg"];
    if (!types.length || types.length > DOOR_REF_MAX_PHOTOS) {
      return json({ error: `Send one to ${DOOR_REF_MAX_PHOTOS} photos.`, code: "door_ref_count" }, 400);
    }
    const exts = types.map((t) => REF_EXT[String(t ?? "")]);
    if (exts.some((e) => !e)) return json({ error: "Door photos must be JPG, PNG or WebP.", code: "door_ref_type" }, 400);
    const uploads: { path: string; token: string | undefined; signedUrl: string | undefined }[] = [];
    for (const ext of exts) {
      const path = `${clientId}/door-ref-${crypto.randomUUID()}.${ext}`;
      const { data, error } = await admin.storage.from("door-refs").createSignedUploadUrl(path);
      if (error || !data) return dbFail(req, clientId, "start that photo upload", error);
      uploads.push({ path, token: data.token, signedUrl: data.signedUrl });
    }
    return json({ ok: true, bucket: "door-refs", uploads });
  }

  // ── door_look_thumb_upload_url ───────────────────────────────────────────────────────────
  // One signed upload URL for a look's tile: OUR front render as a PNG, into the public fixtures
  // bucket (the picker shows it to shoppers), at {tenant}/door-look-{uuid}.png. save_door_look takes
  // the PATH back, checks its exact shape, and builds the public URL itself.
  if (action === "door_look_thumb_upload_url") {
    const path = `${clientId}/door-look-${crypto.randomUUID()}.png`;
    const { data, error } = await admin.storage.from("fixtures").createSignedUploadUrl(path);
    if (error || !data) return dbFail(req, clientId, "start that tile upload", error);
    const { data: pub } = admin.storage.from("fixtures").getPublicUrl(path);
    return json({ ok: true, bucket: "fixtures", path, token: data.token, signedUrl: data.signedUrl, url: pub?.publicUrl ?? null });
  }

  // ── save_door_look ───────────────────────────────────────────────────────────────────────
  // With an id: saves the builder's edits and marks the look Ready, behind the late-save guard
  // (`version`, the styleSaveGuard pattern: an older save that lands late gets a 409 and the current
  // look; the same save landing twice is answered as saved and writes nothing).
  // With NO id: a new Ready look, free and with no AI. That is "Start from a standard look": the body
  // names the standard look (`base`, plus `leaves` and `hinge`) or carries the edited spec.
  // `replaceId` (with an id): "Replace <old look>" — the old look's door rows move to this one and the
  // old look is archived.
  if (action === "save_door_look") {
    const id = p.id == null || p.id === "" ? null : p.id;
    if (id !== null && !isUuid(id)) return json({ error: "Which look?", code: "door_look_id" }, 400);
    const name = typeof p.name === "string" ? p.name.trim().replace(/\s+/g, " ") : "";
    if (!name) return json({ error: "Give the look a name.", code: "door_look_name" }, 400);
    if (name.length > DOOR_LOOK_NAME_MAX) return json({ error: `Keep the name to ${DOOR_LOOK_NAME_MAX} characters or fewer.`, code: "door_look_name" }, 400);

    // The spec: the edited one, or for a new look a standard look's own starting point.
    let raw: unknown = undefined;
    if (p.spec !== undefined && p.spec !== null) raw = p.spec;
    else if (id === null) {
      if (typeof p.base !== "string" || !DOOR_LOOK_BASES.includes(p.base)) {
        return json({ error: "Pick the standard look to start from.", code: "door_look_base" }, 400);
      }
      raw = { v: 1, base: p.base, src: { leaves: p.leaves === 2 ? 2 : 1, hinge: p.hinge === "right" ? "right" : "left" } };
    }
    let cleaned: { spec: Record<string, unknown>; base: string; v: number } | null = null;
    if (raw !== undefined) {
      const c = cleanSpec(raw);
      if ("refuse" in c) return refuse(c.refuse);
      cleaned = c;
    }

    // The tile: a path this function handed out, or null to take it off.
    let thumbUrl: string | null | undefined = undefined;
    if (p.thumbPath === null) thumbUrl = null;
    else if (p.thumbPath !== undefined) {
      if (!doorThumbPathOk(clientId, p.thumbPath)) return json({ error: "That tile upload isn't one of yours. Save again.", code: "door_look_thumb" }, 400);
      const { data: pub } = admin.storage.from("fixtures").getPublicUrl(p.thumbPath);
      thumbUrl = pub?.publicUrl ?? null;
    }

    if (id === null) {
      if (p.replaceId !== undefined && p.replaceId !== null) return json({ error: "Save the new look before replacing another with it.", code: "door_look_replace" }, 400);
      const ins = await admin.from("door_looks").insert({
        client_id: clientId, name, base: cleaned!.base, spec: cleaned!.spec, spec_version: cleaned!.v,
        status: "ready", thumb_url: thumbUrl ?? null, created_by: x.userId,
      }).select(LOOK_COLS).single();
      if (ins.error) return dbFail(req, clientId, "save that door look", ins.error);
      return json({ ok: true, look: lookOut(ins.data) });
    }

    const version = Number(p.version);
    if (!Number.isInteger(version) || version < 1) {
      return json({ error: "That save is missing its version. Reload the page and try again.", code: "door_look_version" }, 400);
    }
    const replaceId = p.replaceId == null || p.replaceId === "" ? null : p.replaceId;
    if (replaceId !== null && (!isUuid(replaceId) || replaceId === id)) return json({ error: "Which look does this one replace?", code: "door_look_replace" }, 400);

    const cur = await admin.from("door_looks").select(LOOK_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
    if (cur.error) return dbFail(req, clientId, "load that door look", cur.error);
    if (!cur.data) return refuse(LOOK_NOT_FOUND);
    if (cur.data.status === "archived") return refuse(LOOK_ARCHIVED);
    if (replaceId !== null) {
      const old = await admin.from("door_looks").select("id, status").eq("client_id", clientId).eq("id", replaceId).maybeSingle();
      if (old.error) return dbFail(req, clientId, "load the look you're replacing", old.error);
      if (!old.data || old.data.status === "archived") return json({ error: "The look you're replacing isn't there any more. Reload the page.", code: "door_look_replace" }, 404);
    }

    const same = (r: Record<string, unknown>) => r.status === "ready" && r.name === name
      && (cleaned === null || canonicalJson(r.spec) === canonicalJson(cleaned.spec))
      && (thumbUrl === undefined || (r.thumb_url ?? null) === thumbUrl);
    const conflict = (r: Record<string, unknown>) => json({
      error: "This look was changed somewhere else since you opened it. We've loaded the latest; check it and save again.",
      code: "door_look_conflict", look: lookOut(r),
    }, 409);
    if (cur.data.version !== version) {
      // The same save landing twice (a stalled request and its retry): saved, nothing written.
      if (same(cur.data)) return json({ ok: true, look: lookOut(cur.data), duplicate: true });
      return conflict(cur.data);
    }

    const next: Record<string, unknown> = { name, status: "ready", version: version + 1, updated_at: new Date().toISOString() };
    if (cleaned) { next.spec = cleaned.spec; next.base = cleaned.base; next.spec_version = cleaned.v; }
    if (thumbUrl !== undefined) next.thumb_url = thumbUrl;
    // Compare-and-swap on the version: a save that raced this one past the read above writes nothing.
    // A new base reaches every door row on the look in the same statement (343's trigger).
    const up = await admin.from("door_looks").update(next).eq("client_id", clientId).eq("id", id).eq("version", version).select(LOOK_COLS).maybeSingle();
    if (up.error) return dbFail(req, clientId, "save that door look", up.error);
    if (!up.data) {
      const now = await admin.from("door_looks").select(LOOK_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
      if (now.error || !now.data) return dbFail(req, clientId, "save that door look", now.error ?? { message: "the look went away mid-save" });
      if (same(now.data)) return json({ ok: true, look: lookOut(now.data), duplicate: true });
      return conflict(now.data);
    }

    let moved: number | undefined;
    if (replaceId !== null) {
      // Rows first, then the old look: a failure between the two leaves both looks with valid rows.
      const mv = await admin.from("fixture_items").update({ door_look_id: id, door_style: up.data.base }, { count: "exact" })
        .eq("client_id", clientId).eq("category", "door").eq("door_look_id", replaceId);
      if (mv.error) return dbFail(req, clientId, "move your doors to the new look", mv.error);
      moved = mv.count ?? 0;
      const arch = await admin.from("door_looks").update({ status: "archived", updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("id", replaceId).neq("status", "archived");
      if (arch.error) return dbFail(req, clientId, "archive the look you replaced", arch.error);
    }
    return json({ ok: true, look: lookOut(up.data), ...(moved !== undefined ? { moved } : {}) });
  }

  // ── archive_door_look ────────────────────────────────────────────────────────────────────
  // The look leaves the lists and the shopper's designer, and its door rows go back to its base look
  // (343's trigger, in the same statement). Saved designs keep their doors: they draw the base look.
  // Archiving an archived look answers as done.
  if (action === "archive_door_look") {
    if (!isUuid(p.id)) return json({ error: "Which look?", code: "door_look_id" }, 400);
    const cur = await admin.from("door_looks").select("id, status, version").eq("client_id", clientId).eq("id", p.id).maybeSingle();
    if (cur.error) return dbFail(req, clientId, "load that door look", cur.error);
    if (!cur.data) return refuse(LOOK_NOT_FOUND);
    if (cur.data.status === "archived") return json({ ok: true, id: p.id, rowsReset: 0, already: true });
    const used = await admin.from("fixture_items").select("id").eq("client_id", clientId).eq("door_look_id", p.id);
    if (used.error) return dbFail(req, clientId, "count the doors using that look", used.error);
    const up = await admin.from("door_looks").update({ status: "archived", version: Number(cur.data.version) + 1, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("id", p.id).eq("version", cur.data.version).select("id").maybeSingle();
    if (up.error) return dbFail(req, clientId, "archive that door look", up.error);
    if (!up.data) return json({ error: "That look was changed somewhere else just now. Reload the page and try again.", code: "door_look_conflict" }, 409);
    return json({ ok: true, id: p.id, rowsReset: (used.data ?? []).length });
  }

  return json({ error: "Unknown door look action." }, 400);
}
