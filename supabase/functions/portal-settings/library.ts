// Settings → Options → Cladding / Doors / Windows → Library (migration 339; Carolyn's 10-26 call, plan
// §1 step 5): the StructureStudio templates, the builder's own copies of them, the links from their
// style and door/window rows, and requests for what is not there.
//
// THE MODEL (Ahsan 2026-10-27). Everything lives in the StructureStudio library (library_items). A
// builder USES a template under any name and may EDIT their copy (a lap course, a window grid, a door
// look); the edit changes their copy only (client_library), never the template. A style's cladding row,
// a door row or a window row may point at one of their entries, and 339's triggers write the entry's
// values through to the columns the designer already reads, so get_config, get_fixtures, the designer
// and submit-estimate never change.
//
// THE LIBRARY IS A FILTER ON THE PICKERS, NEVER A SAVE RULE. Production's older portal sends doorStyle
// and a cladding label on every save, and edge functions reach production the moment they deploy. So
// nothing here refuses a save that does not mention the library: an ABSENT clientLibraryId leaves the
// link alone, and a save whose values disagree with the entry unlinks the row in the database (339)
// rather than being refused. Only a save that NAMES an entry is checked.
//
// THE TENANT FLAG. client_settings.library_beta gates every action in this file and a clientLibraryId
// on a save. It fails closed: a read that errors refuses, and a database without 339 (42703 / 42P01)
// reads as "not available yet".
//
// The tenant is resolveTenant's; nothing here reads a client id from the body. Every row is matched on
// (client_id, id), so another builder's id finds nothing (404). Storage paths are minted here and
// checked against their exact shape before anything trusts them (a prefix check is beaten by `..`).

import { runAutoTopup } from "../_shared/walletAutoTopup.ts";
import {
  type Category, CLADDING_PROFILES, cleanLook, cleanName, DOOR_STYLES, ENTRY_NAME_MAX, isDoorLookEntry, isLibraryId, LIBRARY_CATEGORIES, type Look,
  lookKey, rowValuesFor, templateOut, UUID,
} from "../_shared/libraryLook.ts";
export { cleanLook, isLibraryId, templateOut };
export type { Category, Look };

// deno-lint-ignore no-explicit-any
type Db = any;
export type LibraryCtx = {
  admin: Db; req: Request; clientId: string; userId: string | null;
  action: string; payload: Record<string, unknown>;
  json: (b: unknown, s?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
  audit: (action: string, affected?: number, detail?: string) => Promise<unknown>;
};
export type Refusal = { status: number; code: string; error: string };
export const REQUEST_NAME_MAX = 80;
export const REQUEST_MAX_PHOTOS = 4;
export const REQUEST_METER = "library_request";
const REQUEST_PHOTO_ROLES = new Set(["front", "open", "hinge", "handle", "detail"]);
const isCategory = (v: unknown): v is Category => typeof v === "string" && (LIBRARY_CATEGORIES as readonly string[]).includes(v);

// ── Refusals, in words ─────────────────────────────────────────────────────────────────────
export const LIBRARY_OFF: Refusal = { status: 403, code: "library_off", error: "The library isn't turned on for your account." };
export const LIBRARY_UNAVAILABLE: Refusal = { status: 503, code: "library_unavailable", error: "The library isn't available yet. Try again later." };
const ENTRY_NOT_FOUND: Refusal = { status: 404, code: "library_entry_not_found", error: "That isn't in your library any more. Reload the page and pick another." };
const TEMPLATE_NOT_FOUND: Refusal = { status: 404, code: "library_template_not_found", error: "That isn't in the StructureStudio library any more. Reload the page and pick another." };
// A door made from a photo (345): one of the builder's own door looks (343), saved Ready first.
const DOOR_LOOK_NOT_FOUND: Refusal = { status: 404, code: "library_door_look_not_found", error: "That 3D door isn't in your catalog any more. Reload the page and try again." };
const DOOR_LOOK_NOT_READY: Refusal = { status: 409, code: "library_door_look_not_ready", error: "Save that 3D door first, then add it to your library." };
const DOOR_LOOK_FIXED: Refusal = { status: 400, code: "library_door_look_fixed", error: "A door made from your photo keeps its look. Rename it here, or make a new one from a photo." };
const DOOR_LOOKS_NOT_YET: Refusal = { status: 503, code: "library_door_looks_unavailable", error: "Doors made from photos can't go in the library yet. Try again later." };
/** 345's guards and check, in the builder's words: a database without 345 refuses the shape (23514 on
 *  client_library_look_chk), and its triggers refuse a look that is not this builder's or not ready. */
const doorLookDbRefusal = (err: unknown): Refusal | null => {
  const e = err as { code?: string; message?: string } | null;
  const code = String(e?.code ?? ""), msg = String(e?.message ?? "");
  if (code === "23514" && /client_library_look_chk/.test(msg)) return DOOR_LOOKS_NOT_YET;
  if (code === "23514" && /keeps its look/.test(msg)) return DOOR_LOOK_FIXED;
  if (code === "23514" && /Save that 3D door look/.test(msg)) return DOOR_LOOK_NOT_READY;
  if (code === "23503" && /isn't in this catalog/.test(msg)) return DOOR_LOOK_NOT_FOUND;
  return null;
};

/** A database without 339 (or a PostgREST that has not reloaded): the column or table is unknown. */
export const librarySchemaMissing = (err: unknown): boolean =>
  ["42703", "42P01", "PGRST204", "PGRST205"].includes(String((err as { code?: string } | null)?.code ?? ""));

/** client_settings.library_beta. `ready` false = a database without 339, which reads as off. */
export async function readLibraryFlag(admin: Db, clientId: string): Promise<{ on: boolean; ready: boolean; error?: unknown }> {
  try {
    const { data, error } = await admin.from("client_settings").select("library_beta").eq("client_id", clientId).maybeSingle();
    if (error) return librarySchemaMissing(error) ? { on: false, ready: false } : { on: false, ready: true, error };
    return { on: data?.library_beta === true, ready: true };
  } catch (e) {
    return { on: false, ready: true, error: e };
  }
}
const flagRefusal = (f: { on: boolean; ready: boolean; error?: unknown }): Refusal | null =>
  f.error ? LIBRARY_UNAVAILABLE : !f.ready ? LIBRARY_UNAVAILABLE : !f.on ? LIBRARY_OFF : null;

// ── Shapes for the browser ─────────────────────────────────────────────────────────────────
const TEMPLATE_COLS = "id, category, slug, name, description, search_terms, look, recolourable, leaves, thumb_url, status, version, sort_order";
const ENTRY_COLS = "id, category, library_item_id, template_version, name, look, active, sort_order, created_at, updated_at";
const REQUEST_COLS = "id, category, status, name, width_in, height_in, photos, supplier_url, notes, charged_cents, refunded_cents, refund_reason, result_note, result_client_library_id, created_at, updated_at, decided_at";
// deno-lint-ignore no-explicit-any
export const entryOut = (r: any, usedOn: string[] = [], doorLook?: DoorLookInfo | null) => ({
  id: r.id, category: r.category, name: r.name, look: r.look ?? {}, templateId: r.library_item_id ?? null,
  templateVersion: r.template_version ?? null, active: r.active !== false, sortOrder: r.sort_order ?? 0,
  usedOn,
  // A door made from a photo (345): its tile and whether its look still draws. Only on such entries.
  ...(doorLook !== undefined ? { doorLook } : {}),
});
type DoorLookInfo = { thumbUrl: string | null; status: string; name: string };
/** The looks the builder's photo-made door entries name, by look id. A database without 343 has none. */
// deno-lint-ignore no-explicit-any
async function doorLooksOf(admin: Db, clientId: string, entries: any[]): Promise<{ map: Map<string, DoorLookInfo>; error?: unknown }> {
  const map = new Map<string, DoorLookInfo>();
  const ids = [...new Set(entries.filter((e) => e.category === "door" && isDoorLookEntry(e.look)).map((e) => String(e.look.doorLookId)))];
  if (!ids.length) return { map };
  const { data, error } = await admin.from("door_looks").select("id, name, status, thumb_url").eq("client_id", clientId).in("id", ids);
  if (error) return librarySchemaMissing(error) ? { map } : { map, error };
  for (const r of data ?? []) map.set(String(r.id), { thumbUrl: r.thumb_url ?? null, status: String(r.status), name: String(r.name ?? "") });
  return { map };
}
// deno-lint-ignore no-explicit-any
const doorLookFor = (map: Map<string, DoorLookInfo>, r: any): DoorLookInfo | null | undefined =>
  r.category === "door" && isDoorLookEntry(r.look) ? map.get(String(r.look.doorLookId)) ?? null : undefined;
// deno-lint-ignore no-explicit-any
const requestOut = (r: any) => ({
  id: r.id, category: r.category, status: r.status, name: r.name, widthIn: r.width_in ?? null, heightIn: r.height_in ?? null,
  photos: Array.isArray(r.photos) ? r.photos.length : 0, supplierUrl: r.supplier_url ?? null, notes: r.notes ?? null,
  chargedCents: r.charged_cents ?? 0, refundedCents: r.refunded_cents ?? 0, refundReason: r.refund_reason ?? null,
  resultNote: r.result_note ?? null, resultEntryId: r.result_client_library_id ?? null,
  createdAt: r.created_at, decidedAt: r.decided_at ?? null,
});

/** Where each entry is used: "Utility" for a style's cladding row, the row's own name for a door or
 *  window. One read of each table, linked rows only. */
async function usageOf(admin: Db, clientId: string): Promise<{ map: Map<string, string[]>; error?: unknown }> {
  const map = new Map<string, string[]>();
  const add = (id: string, what: string) => { const l = map.get(id) ?? []; l.push(what); map.set(id, l); };
  const [sc, fx, st] = await Promise.all([
    admin.from("style_cladding").select("style_id, client_library_id").eq("client_id", clientId).not("client_library_id", "is", null),
    admin.from("fixture_items").select("name, category, client_library_id").eq("client_id", clientId).not("client_library_id", "is", null),
    admin.from("building_styles").select("id, label").eq("client_id", clientId),
  ]);
  for (const r of [sc, fx, st]) if (r.error) return { map, error: r.error };
  const styleName = new Map<string, string>((st.data ?? []).map((s: { id: string; label: string }) => [String(s.id), String(s.label ?? "a style")]));
  for (const r of sc.data ?? []) add(String(r.client_library_id), styleName.get(String(r.style_id)) ?? "a style");
  for (const r of fx.data ?? []) add(String(r.client_library_id), String(r.name ?? "a line"));
  return { map };
}

/** Request money: the meter, and whether this builder is charged at all. */
async function requestPrice(admin: Db, clientId: string): Promise<{ priceCents: number | null; active: boolean; exempt: boolean; visible: boolean } | null> {
  try {
    const [meter, cs, wallet] = await Promise.all([
      admin.from("usage_prices").select("price_cents, active, visible").eq("kind", REQUEST_METER).maybeSingle(),
      admin.from("client_settings").select("billing_exempt").eq("client_id", clientId).maybeSingle(),
      admin.from("wallet_accounts").select("metered_exempt").eq("client_id", clientId).maybeSingle(),
    ]);
    if (meter.error || cs.error || wallet.error || !meter.data) return null;
    // Non-billable builders get metered work free (migration 228's promise); wallet_hold itself only
    // honours metered_exempt, so billing_exempt is read here and the hold skipped, as photo_bg does.
    return {
      priceCents: Number(meter.data.price_cents), active: meter.data.active === true, visible: meter.data.visible !== false,
      exempt: cs.data?.billing_exempt === true || wallet.data?.metered_exempt === true,
    };
  } catch (_) { return null; }
}

// ── The catalog's share (the Options pickers) ──────────────────────────────────────────────
/**
 * What `catalog` adds for the pickers: the flag, and when it is on, the builder's entries and which
 * rows point at which entry. Read on its own, never in the catalog's error loop: it never rejects, a
 * database without 339 reads as off, and a failed read hides the library rather than fail the page.
 */
export async function catalogLibrary(admin: Db, clientId: string): Promise<{ libraryBeta: boolean; library: unknown }> {
  try {
    const f = await readLibraryFlag(admin, clientId);
    if (!f.on || f.error) return { libraryBeta: false, library: null };
    const [entries, sc, fx] = await Promise.all([
      admin.from("client_library").select(ENTRY_COLS).eq("client_id", clientId).order("category").order("sort_order").order("name"),
      admin.from("style_cladding").select("id, client_library_id").eq("client_id", clientId).not("client_library_id", "is", null),
      admin.from("fixture_items").select("id, client_library_id").eq("client_id", clientId).not("client_library_id", "is", null),
    ]);
    if (entries.error || sc.error || fx.error) return { libraryBeta: false, library: null };
    const links = (rows: { id: string; client_library_id: string }[]) =>
      Object.fromEntries(rows.map((r) => [String(r.id), String(r.client_library_id)]));
    return {
      libraryBeta: true,
      library: { entries: (entries.data ?? []).map((r: unknown) => entryOut(r)), claddingLinks: links(sc.data ?? []), fixtureLinks: links(fx.data ?? []) },
    };
  } catch (_) { return { libraryBeta: false, library: null }; }
}

// ── A link on a save (save_cladding, save_fixture) ─────────────────────────────────────────
type Entry = { id: string; category: Category; name: string; look: Look };
async function readEntry(admin: Db, clientId: string, id: string): Promise<{ entry: Entry | null; error?: unknown }> {
  const { data, error } = await admin.from("client_library").select("id, category, name, look").eq("client_id", clientId).eq("id", id).maybeSingle();
  if (error) return { entry: null, error };
  return { entry: data ? { id: String(data.id), category: data.category, name: String(data.name), look: (data.look ?? {}) as Look } : null };
}

export type LinkWrite = Record<string, unknown>;
/**
 * The library half of one cladding row's save. `sent` is the row's clientLibraryId: undefined = the key
 * was absent (leave the link alone: the old portal), null = take it off, an id = put this entry on.
 * Putting one on is refused unless the flag is on, the entry is this builder's, is a cladding, and is the
 * row's own profile; then the row takes the entry's name and course (the values 339 writes anyway, so
 * the save and the trigger agree and the link holds).
 */
export async function claddingLinkFor(admin: Db, clientId: string, claddingId: string, sent: unknown):
  Promise<{ write: LinkWrite } | { refuse: Refusal } | { dbError: unknown; where: string }> {
  if (sent === undefined) return { write: {} };
  // Taking a link off is never refused, and on a database without 339 there is nothing to take off
  // (naming the column there would fail the whole save).
  if (sent === null || String(sent).trim() === "") return (await readLibraryFlag(admin, clientId)).ready ? { write: { client_library_id: null } } : { write: {} };
  const id = String(sent).trim().toLowerCase();
  if (!isLibraryId(id)) return { refuse: ENTRY_NOT_FOUND };
  const f = await readLibraryFlag(admin, clientId);
  const off = flagRefusal(f);
  if (off) return { refuse: off };
  const r = await readEntry(admin, clientId, id);
  if (r.error) return librarySchemaMissing(r.error) ? { refuse: LIBRARY_UNAVAILABLE } : { dbError: r.error, where: "read that library entry" };
  if (!r.entry) return { refuse: ENTRY_NOT_FOUND };
  if (r.entry.category !== "cladding") return { refuse: { status: 400, code: "library_wrong_kind", error: `"${r.entry.name}" isn't a cladding.` } };
  if (r.entry.look.profile !== claddingId) {
    return { refuse: { status: 400, code: "library_wrong_profile", error: `"${r.entry.name}" is drawn as a different cladding. Pick it on that cladding's row.` } };
  }
  return {
    write: {
      client_library_id: id, label_override: r.entry.name,
      ...(claddingId === "lap" ? { exposure_in: r.entry.look.exposureIn ?? null } : {}),
    },
  };
}

/** The same for a door or window row's save (save_fixture). Other categories ignore the key. */
export async function fixtureLinkFor(admin: Db, clientId: string, category: string, sent: unknown):
  Promise<{ write: LinkWrite } | { refuse: Refusal } | { dbError: unknown; where: string }> {
  if (sent === undefined || (category !== "door" && category !== "window")) return { write: {} };
  if (sent === null || String(sent).trim() === "") return (await readLibraryFlag(admin, clientId)).ready ? { write: { client_library_id: null } } : { write: {} };
  const id = String(sent).trim().toLowerCase();
  if (!isLibraryId(id)) return { refuse: ENTRY_NOT_FOUND };
  const f = await readLibraryFlag(admin, clientId);
  const off = flagRefusal(f);
  if (off) return { refuse: off };
  const r = await readEntry(admin, clientId, id);
  if (r.error) return librarySchemaMissing(r.error) ? { refuse: LIBRARY_UNAVAILABLE } : { dbError: r.error, where: "read that library entry" };
  if (!r.entry) return { refuse: ENTRY_NOT_FOUND };
  if (r.entry.category !== category) return { refuse: { status: 400, code: "library_wrong_kind", error: `"${r.entry.name}" isn't a ${category}.` } };
  return { write: { client_library_id: id, ...rowValuesFor(category, r.entry.look) } };
}

// ── Seeding a builder's library from what they use today ───────────────────────────────────
type Template = { id: string; category: Category; slug: string; name: string; look: Look; version: number; status: string };
/** The name a seeded entry takes: the row's own label if it has one, else the template's (the name the
 *  builder already sees), made unique against `taken` with a counter. */
function uniqueName(base: string, taken: Set<string>): string {
  let n = base.slice(0, ENTRY_NAME_MAX), k = 2;
  while (taken.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, ENTRY_NAME_MAX - suf.length) + suf; }
  taken.add(n.toLowerCase());
  return n;
}
const gridName = (look: Look) => (look.liteRows == null ? "Standard window" : `${look.liteRows} x ${look.liteCols} grid`);

/**
 * Fill the builder's library from what they use today, and link those rows. IDEMPOTENT: an entry with
 * the same category, look and name is reused, so a second run creates nothing and links nothing new.
 * Offered cladding rows only (a NULL rate is "not offered"); every door and window row; plus "Use the
 * door's photo" (the plan's default). Rows already linked are left alone.
 */
export async function seedMine(admin: Db, clientId: string): Promise<{ created: number; linked: number; skipped: number } | { dbError: unknown; where: string }> {
  const [tpl, ent, sc, fx] = await Promise.all([
    admin.from("library_items").select("id, category, slug, name, look, version, status"),
    admin.from("client_library").select("id, category, name, look").eq("client_id", clientId),
    admin.from("style_cladding").select("id, cladding_id, label_override, exposure_in, rate, active").eq("client_id", clientId).is("client_library_id", null),
    admin.from("fixture_items").select("id, category, door_style, lite_rows, lite_cols").eq("client_id", clientId).in("category", ["door", "window"]).is("client_library_id", null),
  ]);
  for (const r of [tpl, ent, sc, fx]) if (r.error) return { dbError: r.error, where: "read your catalog" };
  const templates: Template[] = (tpl.data ?? []) as Template[];
  const entries: Entry[] = (ent.data ?? []).map((e: Entry) => ({ ...e, look: (e.look ?? {}) as Look }));
  const taken: Record<Category, Set<string>> = { cladding: new Set(), door: new Set(), window: new Set() };
  for (const e of entries) taken[e.category].add(e.name.toLowerCase());
  const findTemplate = (cat: Category, look: Look) =>
    templates.find((t) => t.category === cat && lookKey(cleanLook(cat, t.look) ?? {}) === lookKey(look) && t.status === "active")
    ?? templates.find((t) => t.category === cat && lookKey(cleanLook(cat, t.look) ?? {}) === lookKey(look))
    ?? null;
  let created = 0, linked = 0, skipped = 0;
  // One entry per (category, look, wanted name): an existing one is reused by that exact pair.
  const entryFor = async (cat: Category, look: Look, wantName: string): Promise<string | { dbError: unknown; where: string }> => {
    const same = entries.find((e) => e.category === cat && lookKey(cleanLook(cat, e.look) ?? {}) === lookKey(look)
      && e.name.toLowerCase() === wantName.toLowerCase());
    if (same) return same.id;
    const t = findTemplate(cat, look);
    const name = uniqueName(wantName, taken[cat]);
    const ins = await admin.from("client_library").insert({
      client_id: clientId, category: cat, library_item_id: t?.id ?? null, template_version: t?.version ?? null, name, look,
    }).select("id").single();
    if (ins.error) return { dbError: ins.error, where: "add that to your library" };
    const e: Entry = { id: String(ins.data.id), category: cat, name, look };
    entries.push(e);
    created++;
    return e.id;
  };
  const tplName = (cat: Category, look: Look, fallback: string) => findTemplate(cat, look)?.name ?? fallback;

  for (const r of sc.data ?? []) {
    if (r.rate == null || r.active === false || !CLADDING_PROFILES.includes(String(r.cladding_id))) continue;
    const look = cleanLook("cladding", { profile: r.cladding_id, exposureIn: r.cladding_id === "lap" ? r.exposure_in : undefined });
    if (!look) continue;
    const label = cleanName(r.label_override) ?? tplName("cladding", { profile: r.cladding_id }, String(r.cladding_id));
    // A cladding entry's NAME is the row's customer-facing label (339 writes it through). If that name is
    // already taken by an entry of another look (two styles showing one name over two courses), a new
    // entry would need another name and the customer would see it change. Such a row stays unlinked
    // (the Cladding page marks it "not in your library"); the builder links it by hand.
    if (entries.some((e) => e.category === "cladding" && e.name.toLowerCase() === label.toLowerCase()
      && lookKey(cleanLook("cladding", e.look) ?? {}) !== lookKey(look))) { skipped++; continue; }
    const id = await entryFor("cladding", look, label);
    if (typeof id !== "string") return id;
    const u = await admin.from("style_cladding").update({ client_library_id: id }).eq("client_id", clientId).eq("id", r.id);
    if (u.error) return { dbError: u.error, where: "link your cladding to your library" };
    linked++;
  }
  for (const r of fx.data ?? []) {
    const cat = r.category as "door" | "window";
    const look = cat === "door"
      ? cleanLook("door", { doorStyle: DOOR_STYLES.includes(String(r.door_style)) ? r.door_style : "auto" })
      : cleanLook("window", r.lite_rows == null ? {} : { liteRows: r.lite_rows, liteCols: r.lite_cols });
    if (!look) continue;
    const id = await entryFor(cat, look, tplName(cat, look, cat === "door" ? String(look.doorStyle) : gridName(look)));
    if (typeof id !== "string") return id;
    const u = await admin.from("fixture_items").update({ client_library_id: id }).eq("client_id", clientId).eq("id", r.id);
    if (u.error) return { dbError: u.error, where: "link your doors and windows to your library" };
    linked++;
  }
  // "Use the door's photo", always there to pick (the plan's default for what a library starts with).
  if (!entries.some((e) => e.category === "door" && e.look.doorStyle === "auto")) {
    const look = { doorStyle: "auto" };
    const id = await entryFor("door", look, tplName("door", look, "Use the door's photo"));
    if (typeof id !== "string") return id;
  }
  return { created, linked, skipped };
}

// ── Request photos ─────────────────────────────────────────────────────────────────────────
export const REQUEST_BUCKET = "library-refs";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A request photo exactly as library_request_upload_url names it. Tenant ids are text slugs, so the id
 *  is escaped, never assumed to be a uuid. */
export const requestPhotoPathOk = (clientId: string, path: unknown): path is string =>
  typeof path === "string" && new RegExp(`^${escapeRe(clientId)}/requests/${UUID}\\.(jpg|png|webp)$`).test(path);
const PHOTO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ── The actions ────────────────────────────────────────────────────────────────────────────
export async function handleLibraryAction(c: LibraryCtx): Promise<Response> {
  const { admin, req, clientId, userId, action, payload, json, dbFail, audit } = c;
  const refuse = (r: Refusal) => json({ error: r.error, code: r.code }, r.status);
  const f = await readLibraryFlag(admin, clientId);
  const off = flagRefusal(f);
  if (off) return refuse(off);
  const failOr = (err: unknown, where: string) => (librarySchemaMissing(err) ? refuse(LIBRARY_UNAVAILABLE) : dbFail(req, clientId, where, err));

  if (action === "library") {
    const [tpl, ent, req0, usage, price] = await Promise.all([
      admin.from("library_items").select(TEMPLATE_COLS).eq("status", "active").order("category").order("sort_order").order("name"),
      admin.from("client_library").select(ENTRY_COLS).eq("client_id", clientId).order("category").order("sort_order").order("name"),
      admin.from("library_requests").select(REQUEST_COLS).eq("client_id", clientId).order("created_at", { ascending: false }).limit(50),
      usageOf(admin, clientId),
      requestPrice(admin, clientId),
    ]);
    for (const r of [tpl, ent, req0]) if (r.error) return failOr(r.error, "load your library");
    if (usage.error) return failOr(usage.error, "load your library");
    const looks = await doorLooksOf(admin, clientId, ent.data ?? []);
    if (looks.error) return failOr(looks.error, "load your library");
    return json({
      ok: true,
      templates: (tpl.data ?? []).map(templateOut),
      // deno-lint-ignore no-explicit-any
      entries: (ent.data ?? []).map((r: any) => entryOut(r, usage.map.get(String(r.id)) ?? [], doorLookFor(looks.map, r))),
      requests: (req0.data ?? []).map(requestOut),
      // null = say nothing about money (a failed read must not promise "free").
      requestPrice: price ? { priceCents: price.visible ? price.priceCents : null, active: price.active, exempt: price.exempt } : null,
    });
  }

  if (action === "library_seed_mine") {
    const r = await seedMine(admin, clientId);
    if ("dbError" in r) return failOr(r.dbError, r.where);
    await audit("portal_library_seed_mine", r.created + r.linked, `created=${r.created} linked=${r.linked} skipped=${r.skipped}`).catch(() => {});
    return json({ ok: true, ...r });
  }

  if (action === "library_add" && payload.doorLookId !== undefined && payload.templateId === undefined) {
    // A door made from a photo (345): the builder's own Ready look becomes a library entry, drawn over
    // the look's base, so it shows in every door's "How it looks in 3D" like any other library door.
    const doorLookId = String(payload.doorLookId ?? "").trim().toLowerCase();
    if (!isLibraryId(doorLookId)) return refuse(DOOR_LOOK_NOT_FOUND);
    const l = await admin.from("door_looks").select("id, name, base, status, thumb_url").eq("client_id", clientId).eq("id", doorLookId).maybeSingle();
    if (l.error) return librarySchemaMissing(l.error) ? refuse(DOOR_LOOKS_NOT_YET) : failOr(l.error, "read that 3D door");
    if (!l.data || l.data.status === "archived") return refuse(DOOR_LOOK_NOT_FOUND);
    if (l.data.status !== "ready") return refuse(DOOR_LOOK_NOT_READY);
    const look = cleanLook("door", { doorStyle: l.data.base, doorLookId }, { doorLook: true });
    if (!look) return json({ error: "That 3D door can't be saved. Reload the page and try again.", code: "library_bad_look" }, 400);
    const name = cleanName(payload.name ?? l.data.name);
    if (!name) return json({ error: `Give it a name of 1 to ${ENTRY_NAME_MAX} characters.`, code: "library_bad_name" }, 400);
    const ins = await admin.from("client_library").insert({ client_id: clientId, category: "door", library_item_id: null, template_version: null, name, look })
      .select(ENTRY_COLS).single();
    if (ins.error) {
      if (String(ins.error.code ?? "") === "23505") return json({ error: `You already have "${name}". Pick another name.`, code: "library_name_taken" }, 409);
      const r = doorLookDbRefusal(ins.error);
      if (r) return refuse(r);
      return failOr(ins.error, "add that to your library");
    }
    await audit("portal_library_add", 1, `entry=${ins.data.id} doorLook=${doorLookId}`).catch(() => {});
    return json({ ok: true, entry: entryOut(ins.data, [], { thumbUrl: l.data.thumb_url ?? null, status: "ready", name: String(l.data.name ?? "") }) });
  }

  if (action === "library_add") {
    const templateId = String(payload.templateId ?? "").trim().toLowerCase();
    if (!isLibraryId(templateId)) return refuse(TEMPLATE_NOT_FOUND);
    const t = await admin.from("library_items").select("id, category, name, look, version, status").eq("id", templateId).maybeSingle();
    if (t.error) return failOr(t.error, "read that template");
    if (!t.data || t.data.status !== "active") return refuse(TEMPLATE_NOT_FOUND);
    const cat = t.data.category as Category;
    // The builder's copy: the template's look, with their edit on top when they made one.
    const look = cleanLook(cat, payload.look === undefined ? t.data.look : payload.look);
    if (!look) return json({ error: "That look can't be saved. Reload the page and try again.", code: "library_bad_look" }, 400);
    if (cat === "cladding" && look.profile !== (t.data.look as Look).profile) {
      return json({ error: "A cladding keeps its template's look. Pick that template instead.", code: "library_wrong_profile" }, 400);
    }
    const name = cleanName(payload.name ?? t.data.name);
    if (!name) return json({ error: `Give it a name of 1 to ${ENTRY_NAME_MAX} characters.`, code: "library_bad_name" }, 400);
    const ins = await admin.from("client_library").insert({
      client_id: clientId, category: cat, library_item_id: t.data.id, template_version: t.data.version, name, look,
    }).select(ENTRY_COLS).single();
    if (ins.error) {
      if (String(ins.error.code ?? "") === "23505") return json({ error: `You already have "${name}". Pick another name.`, code: "library_name_taken" }, 409);
      return failOr(ins.error, "add that to your library");
    }
    await audit("portal_library_add", 1, `entry=${ins.data.id} template=${t.data.id}`).catch(() => {});
    return json({ ok: true, entry: entryOut(ins.data) });
  }

  if (action === "library_edit") {
    const id = String(payload.id ?? "").trim().toLowerCase();
    if (!isLibraryId(id)) return refuse(ENTRY_NOT_FOUND);
    const cur = await admin.from("client_library").select(ENTRY_COLS).eq("client_id", clientId).eq("id", id).maybeSingle();
    if (cur.error) return failOr(cur.error, "read that library entry");
    if (!cur.data) return refuse(ENTRY_NOT_FOUND);
    const cat = cur.data.category as Category;
    const patch: Record<string, unknown> = {};
    if (payload.name !== undefined) {
      const name = cleanName(payload.name);
      if (!name) return json({ error: `Give it a name of 1 to ${ENTRY_NAME_MAX} characters.`, code: "library_bad_name" }, 400);
      patch.name = name;
    }
    // A door made from a photo keeps its look (345): a rename only. The Rename form sends the look it
    // was opened with, so the SAME look is a rename; any other is refused in words.
    if (payload.look !== undefined && isDoorLookEntry(cur.data.look)) {
      const same = cleanLook(cat, payload.look, { doorLook: true });
      if (!same || lookKey(same) !== lookKey(cur.data.look as Look)) return refuse(DOOR_LOOK_FIXED);
    } else if (payload.look !== undefined) {
      const look = cleanLook(cat, payload.look);
      if (!look) return json({ error: "That look can't be saved. Reload the page and try again.", code: "library_bad_look" }, 400);
      if (cat === "cladding" && look.profile !== (cur.data.look as Look).profile) {
        return json({ error: "A cladding entry keeps its look. Add a new entry for a different one.", code: "library_wrong_profile" }, 400);
      }
      patch.look = look;
    }
    if (payload.active !== undefined) patch.active = payload.active !== false;
    if (!Object.keys(patch).length) return json({ ok: true, entry: entryOut(cur.data) });
    // 339's write-through moves every row on this entry in the same statement.
    const up = await admin.from("client_library").update(patch).eq("client_id", clientId).eq("id", id).select(ENTRY_COLS).single();
    if (up.error) {
      if (String(up.error.code ?? "") === "23505") return json({ error: `You already have "${patch.name}". Pick another name.`, code: "library_name_taken" }, 409);
      const r = doorLookDbRefusal(up.error);
      if (r) return refuse(r);
      return failOr(up.error, "save that library entry");
    }
    await audit("portal_library_edit", 1, `entry=${id} fields=${Object.keys(patch).join(",")}`).catch(() => {});
    return json({ ok: true, entry: entryOut(up.data) });
  }

  if (action === "library_remove") {
    const id = String(payload.id ?? "").trim().toLowerCase();
    if (!isLibraryId(id)) return refuse(ENTRY_NOT_FOUND);
    const cur = await admin.from("client_library").select("id, name").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (cur.error) return failOr(cur.error, "read that library entry");
    if (!cur.data) return refuse(ENTRY_NOT_FOUND);
    // Refused while in use, and the refusal names the rows, so the builder knows what to change first.
    const usage = await usageOf(admin, clientId);
    if (usage.error) return failOr(usage.error, "check where that is used");
    const used = usage.map.get(id) ?? [];
    if (used.length) {
      const shown = used.slice(0, 5).join(", ") + (used.length > 5 ? ` and ${used.length - 5} more` : "");
      return json({ error: `"${cur.data.name}" is still used on ${shown}. Pick something else there first.`, code: "library_in_use", usedOn: used }, 409);
    }
    const del = await admin.from("client_library").delete().eq("client_id", clientId).eq("id", id);
    if (del.error) return failOr(del.error, "remove that library entry");
    await audit("portal_library_remove", 1, `entry=${id}`).catch(() => {});
    return json({ ok: true });
  }

  if (action === "library_request_upload_url") {
    const ext = PHOTO_EXT[String(payload.contentType || "image/jpeg")];
    if (!ext) return json({ error: "Use a JPG, PNG or WEBP photo." }, 400);
    const path = `${clientId}/requests/${crypto.randomUUID()}.${ext}`;
    const { data: signed, error } = await admin.storage.from(REQUEST_BUCKET).createSignedUploadUrl(path);
    if (error) return dbFail(req, clientId, "start that upload", error);
    return json({ ok: true, path, token: signed?.token ?? null });
  }

  if (action === "library_request") {
    const category = payload.category;
    if (!isCategory(category)) return json({ error: "Pick cladding, a door or a window." }, 400);
    if (category === "door") {
      return json({ error: "Doors are requested with a photo from the Doors page, which isn't open yet.", code: "library_door_requests_closed" }, 409);
    }
    const name = cleanName(payload.name, REQUEST_NAME_MAX);
    if (!name) return json({ error: `Name it (1 to ${REQUEST_NAME_MAX} characters), e.g. the product's name.` }, 400);
    const size = (k: string) => {
      const raw = payload[k];
      if (raw == null || String(raw).trim() === "") return { v: null };
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 && n <= 600 ? { v: Math.round(n * 100) / 100 } : { bad: true };
    };
    const w = size("widthIn"), h = size("heightIn");
    if ("bad" in w || "bad" in h) return json({ error: "Sizes are in inches, from 1 to 600." }, 400);
    const photosRaw = Array.isArray(payload.photos) ? payload.photos : [];
    if (photosRaw.length > REQUEST_MAX_PHOTOS) return json({ error: `Up to ${REQUEST_MAX_PHOTOS} photos.` }, 400);
    const photos: { path: string; role: string }[] = [];
    for (const p of photosRaw as Record<string, unknown>[]) {
      if (!requestPhotoPathOk(clientId, p?.path)) return json({ error: "A photo didn't upload. Remove it and add it again." }, 400);
      const role = REQUEST_PHOTO_ROLES.has(String(p?.role)) ? String(p.role) : "front";
      photos.push({ path: p.path as string, role });
    }
    const urlRaw = String(payload.supplierUrl ?? "").trim();
    if (urlRaw && (!/^https:\/\/[^\s]+$/i.test(urlRaw) || urlRaw.length > 500)) return json({ error: "The link must start with https:// (500 characters at most)." }, 400);
    const notes = String(payload.notes ?? "").trim();
    if (notes.length > 2000) return json({ error: "Notes are 2,000 characters at most." }, 400);
    if (!photos.length && !urlRaw) return json({ error: "Add a photo or a link to the product, so we know what to build." }, 400);
    const key = String(payload.idempotencyKey ?? "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return json({ error: "Missing request key. Reload the page and try again." }, 400);

    // Money (Ahsan 2026-10-27: $2 a window or cladding request), charged at submit when the meter is
    // armed: a hold, then the capture straight away. A refusal or a cancel is credited back.
    const price = await requestPrice(admin, clientId);
    if (!price) return dbFail(req, clientId, "check what a request costs", new Error("usage_prices / wallet read failed"));
    let holdId: number | null = null;
    let charged = 0;
    if (price.active && !price.exempt && price.priceCents) {
      const { data: hold, error: hErr } = await admin
        .rpc("wallet_hold", { p_client_id: clientId, p_kind: REQUEST_METER, p_idem: `libreq:${key}`, p_user: userId ?? null })
        // deno-lint-ignore no-explicit-any
        .maybeSingle() as { data: any; error: any };
      if (hErr) return dbFail(req, clientId, "check your wallet", hErr);
      const err = hold?.err ?? null;
      if (err === "insufficient_funds") {
        return json({ error: `A request costs $${((hold?.price_cents ?? 0) / 100).toFixed(2)} and your wallet has $${((hold?.balance_after ?? 0) / 100).toFixed(2)}. Add funds in Settings → Billing, then send it again.`, code: "insufficient_funds" }, 402);
      }
      if (err === "hold_in_flight") return json({ error: "Another request is being sent. Wait a moment and try again." }, 409);
      if (err === "hold_replayed") return json({ error: "That request was already sent. Reload to see it.", code: "already_charged" }, 409);
      if (err) return json({ error: "Requests aren't open yet. Try again later." }, 503);
      holdId = hold?.hold_id ?? null;
      charged = Number(hold?.price_cents ?? 0);
    }
    const release = async (why: string) => {
      if (holdId) await admin.rpc("wallet_release", { p_hold_id: holdId, p_reason: why.slice(0, 200) }).then(() => {}, () => {});
    };
    const ins = await admin.from("library_requests").insert({
      client_id: clientId, category, name, width_in: w.v, height_in: h.v, photos, supplier_url: urlRaw || null, notes: notes || null,
      charged_cents: charged, requested_by: userId ?? null,
    }).select(REQUEST_COLS).single();
    if (ins.error) { await release("library request not stored"); return failOr(ins.error, "send that request"); }
    if (holdId) {
      const { error: capErr } = await admin.rpc("wallet_capture", { p_hold_id: holdId, p_cost_cents: 0, p_usage: { request_id: ins.data.id }, p_ref_id: String(ins.data.id) });
      if (capErr) {
        // Not charged after all: the request stands, free, and the row says so.
        await release("capture failed");
        await admin.from("library_requests").update({ charged_cents: 0 }).eq("client_id", clientId).eq("id", ins.data.id);
        ins.data.charged_cents = 0;
      } else {
        await admin.from("library_requests").update({ charge_tx_id: holdId }).eq("client_id", clientId).eq("id", ins.data.id);
        await runAutoTopup(admin, clientId, req, { fn: "portal-settings" }).catch(() => {});
      }
    }
    await audit("portal_library_request", 1, `request=${ins.data.id} category=${category} charged=${ins.data.charged_cents}`).catch(() => {});
    return json({ ok: true, request: requestOut(ins.data) });
  }

  if (action === "library_request_cancel") {
    const id = String(payload.id ?? "").trim().toLowerCase();
    if (!isLibraryId(id)) return json({ error: "That request isn't yours any more. Reload the page." }, 404);
    const cur = await admin.from("library_requests").select("id, status, charged_cents, refunded_cents").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (cur.error) return failOr(cur.error, "read that request");
    if (!cur.data) return json({ error: "That request isn't yours any more. Reload the page." }, 404);
    if (cur.data.status !== "submitted") return json({ error: "CSM has started on that request, so it can't be cancelled here. Ask support.", code: "library_request_started" }, 409);
    // The status flips first and only from 'submitted', so two cancels cannot credit twice; the credit
    // carries its own idempotency key as well.
    const up = await admin.from("library_requests").update({ status: "cancelled", decided_at: new Date().toISOString(), decided_by: userId ?? null, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("id", id).eq("status", "submitted").select("id").maybeSingle();
    if (up.error) return failOr(up.error, "cancel that request");
    if (!up.data) return json({ error: "CSM has started on that request, so it can't be cancelled here. Ask support.", code: "library_request_started" }, 409);
    const owed = Number(cur.data.charged_cents ?? 0) - Number(cur.data.refunded_cents ?? 0);
    if (owed > 0) {
      const { error: crErr } = await admin.rpc("wallet_credit", {
        p_client_id: clientId, p_amount_cents: owed, p_kind: "refund", p_ref_type: "library_request", p_ref_id: id,
        p_memo: "Library request cancelled", p_idem: `libreq-refund:${id}`, p_actor: userId ?? null,
      });
      if (crErr) return dbFail(req, clientId, "credit that request back", crErr);
      await admin.from("library_requests").update({ refunded_cents: Number(cur.data.charged_cents ?? 0), refund_reason: "Cancelled before work started" })
        .eq("client_id", clientId).eq("id", id);
    }
    await audit("portal_library_request_cancel", 1, `request=${id} refunded=${Math.max(0, owed)}`).catch(() => {});
    return json({ ok: true, refundedCents: Math.max(0, owed) });
  }

  return json({ error: "Unknown library action." }, 400);
}
