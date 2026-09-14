// customer-designs: a signed-in customer's SAVED DESIGNS (migration 231).
//
// Carolyn, 2026-09-14: refreshing the designer must not lose the building, and a customer who logs
// in should find what they were working on. Ahsan, 2026-09-15 (expo plan 3.6): saved designs are
// tied to the VERIFIED login. The designer autosaves a draft while the shopper designs; once they
// are signed in it LINKS each autosaved code here, and the Quotes tab lists those links as
// "Saved designs" (Open / Remove).
//
// Three actions, each authenticated by the customer_sessions bearer token customer-auth minted
// (the anon key passes the gateway; the token is the real gate — the customer-quotes posture):
//   link {token, code}   save this draft under the identities the session proved AND the design's
//                        contact names. 404 for anything that is not theirs.
//   list {token}         their linked, non-hidden DRAFTS → {ref, style, size, createdAt, updatedAt,
//                        view3dImageUrl}. Sent quotes are customer-quotes' list, not this one.
//   hide {token, code}   "Remove" — hides the caller's own links to that code. The design is untouched.
//
// ⚠️ A STRANGER MUST NOT BE ABLE TO PUT A DESIGN INTO YOUR ACCOUNT. designs.contact is written by
// save_design, anon included, so anyone can create a draft carrying your phone. Two rules close it:
//   1. LINKING needs a session that PROVED the identity the design names (matchedIdentities). A
//      stranger's session never proved your phone, so they cannot create a link keyed on it.
//   2. LISTING reads links only — never "every draft whose contact has my phone" — and re-checks
//      that the design's contact still names the identity each link was made under. A design whose
//      contact was rewritten after it was saved drops out of the list instead of following it.
//
// The handler lives apart from index.ts so it can be tested against an in-memory database with no
// network (handler.test.ts). Its dependencies are handed in; nothing here imports jsr:/npm:.

// deno-lint-ignore-file no-explicit-any

import { checkSession, type CustomerIdentity } from "../_shared/customerSession.ts";
import {
  type IdentityColumn,
  matchedIdentities,
  provenIdentityColumns,
} from "../_shared/customerIdentity.ts";

/** Links one identity may keep visible per builder. Every autosave of a NEW design is a link, and
 *  every design_versions row behind it is real storage, so the list is bounded like the designer's
 *  own 200-saves-per-page-load cap. Hidden links do not count: "Remove" is how a customer at the
 *  cap makes room. */
export const MAX_LINKS_PER_IDENTITY = 200;

/** The short-code shape customer-accept and customer-pay accept for quoteRef. */
const CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** PostgREST `in.(…)` rides in the URL; 100 codes is ~1.3 KB, well inside any proxy's limit. */
const IN_CHUNK = 100;

/** Visible links read per identity by the cap and the list (review, 2026-09-15). A link outlives
 *  its draft becoming a quote, and link accepts 'sent' designs, so an identity's visible links are
 *  drafts AND issued quotes. Both readers look past the quotes to the drafts, which is what the cap
 *  and the Saved designs list are about. Kept under PostgREST's 1000-row cap so a read never comes
 *  back silently short. */
export const LINK_SCAN_LIMIT = 1000;

/**
 * How many of this identity's visible links still point at a DRAFT. That is what the cap counts:
 * a customer's issued quotes are listed by customer-quotes, never under Saved designs, so they
 * have no Remove button, and counting them would lock a repeat customer out of saving new drafts
 * once they had 200 quotes. The newest LINK_SCAN_LIMIT links are counted, which is only ever an
 * under-count for someone with more than a thousand visible links.
 */
async function visibleDraftLinkCount(admin: any, clientId: string, id: IdentityColumn): Promise<{ count: number; error: any }> {
  const { data: links, error: lErr } = await admin.from("customer_design_links")
    .select("short_code")
    .eq("client_id", clientId)
    .eq(id.column, id.value)
    .is("hidden_at", null)
    .order("created_at", { ascending: false })
    .limit(LINK_SCAN_LIMIT);
  if (lErr) return { count: 0, error: lErr };
  const codes = (links ?? []).map((l: any) => String(l.short_code));
  let count = 0;
  for (let i = 0; i < codes.length; i += IN_CHUNK) {
    const { count: n, error } = await admin.from("designs")
      .select("short_code", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("status", "draft")
      .in("short_code", codes.slice(i, i + IN_CHUNK));
    if (error) return { count: 0, error };
    count += n ?? 0;
  }
  return { count, error: null };
}

export type LogInput = {
  fn: string;
  req: Request;
  clientId: string | null;
  code: string | number;
  message: string;
  context?: Record<string, unknown>;
};

export type Deps = {
  /** The service-role client. A factory, so a warm-up ping or a bad request builds nothing. */
  admin: () => any;
  /** logEdgeError in production; a recorder in tests. Must not throw. */
  log: (input: LogInput) => Promise<void>;
  /** SUPABASE_URL. Thumbnails leave only when they name this project's own public storage. */
  storageOrigin: string;
};

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // The customer-quotes ping, for the same reasons: answered before any client, auth or body read,
  // so a boot ping costs no round trip, logs nothing, needs no action name and leaves the single
  // parse of the body stream to the real call below.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = typeof body?.action === "string" ? body.action : "";
  if (action !== "link" && action !== "list" && action !== "hide") {
    return json({ error: "Unknown action" }, 400);
  }

  const admin = deps.admin();

  // The session IS the identity: tenant + proven phone and/or email. Never from the body.
  const identity = await checkSession(admin, body?.token);
  if (!identity) return json({ error: "Session expired — sign in again." }, 401);

  // Authored sentence out, raw Postgres text (which can carry row values) to app_errors only —
  // portal-settings' dbFail contract.
  const dbFail = (where: string, err: any) => {
    deps.log({
      fn: "customer-designs",
      req,
      clientId: identity.clientId,
      code: err?.code ?? 500,
      message: `${where}: ${err?.message ?? "unknown database error"}`,
      context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
    }).catch(() => {});
    return json({ error: "Couldn't reach your saved designs. Please try again in a moment." }, 500);
  };

  if (action === "list") return listDesigns(admin, identity, deps, dbFail);

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!CODE_RE.test(code)) return json({ error: "Invalid design reference." }, 400);

  if (action === "hide") return hideDesign(admin, identity, code, dbFail);
  return linkDesign(admin, identity, code, dbFail);
}

type DbFail = (where: string, err: any) => Response;

// ═══ link ═══════════════════════════════════════════════════════════════════════════════════
async function linkDesign(admin: any, identity: CustomerIdentity, code: string, dbFail: DbFail): Promise<Response> {
  const { data: d, error: dErr } = await admin.from("designs")
    .select("short_code, status, contact")
    .eq("client_id", identity.clientId)
    .eq("short_code", code)
    .maybeSingle();
  if (dErr) return dbFail("load the design", dErr);

  // One answer for "no such code", "another builder's design", "the builder's stock" and "not your
  // contact", so a probe cannot tell which — the sign_invoice posture.
  const notYours = json({ error: "That design wasn't found on your account." }, 404);
  if (!d || d.status === "inventory") return notYours;
  const matched = matchedIdentities(identity, d.contact);
  if (matched.length === 0) return notYours;

  // Theirs, but already an order: it lives under Quotes / Invoices (customer-quotes), and a saved
  // draft of it would be a second card for the same building. Nothing to do, and not an error —
  // the designer links on autosave and must not show a failure for it.
  if (d.status !== "draft" && d.status !== "sent") {
    return json({ ok: true, linked: false, reason: "order" });
  }

  let visible = false;
  let hiddenSeen = false;
  const toInsert: IdentityColumn[] = [];
  for (const id of matched) {
    const { data: existing, error: exErr } = await admin.from("customer_design_links")
      .select("id, hidden_at")
      .eq("client_id", identity.clientId)
      .eq(id.column, id.value)
      .eq("short_code", code)
      .maybeSingle();
    if (exErr) return dbFail("read your saved designs", exErr);
    if (!existing) toInsert.push(id);
    // ⚠️ A re-link does NOT bring a removed design back. The designer re-links on every page load
    // that restores the draft, so un-hiding here would make "Remove" undo itself on the next refresh.
    else if (existing.hidden_at) hiddenSeen = true;
    else visible = true;
  }

  // The cap, checked for every identity about to gain a row, BEFORE any insert — so a refusal
  // leaves nothing half-written. An already-linked code never hits it.
  for (const id of toInsert) {
    const { count, error: cErr } = await visibleDraftLinkCount(admin, identity.clientId, id);
    if (cErr) return dbFail("count your saved designs", cErr);
    if (count >= MAX_LINKS_PER_IDENTITY) {
      return json({
        error: `You have ${MAX_LINKS_PER_IDENTITY} saved designs, which is as many as we can keep. Remove some under Saved designs to save this one.`,
        reason: "cap",
      }, 409);
    }
  }

  for (const id of toInsert) {
    const { error: iErr } = await admin.from("customer_design_links").insert({
      client_id: identity.clientId,
      short_code: code,
      phone_digits: id.column === "phone_digits" ? id.value : null,
      email_lower: id.column === "email_lower" ? id.value : null,
    });
    // 23505: a concurrent link (two tabs autosaving) landed first. That IS the outcome we wanted.
    if (iErr && String(iErr.code) !== "23505") return dbFail("save the design to your account", iErr);
    visible = true;
  }

  return json({ ok: true, linked: true, hidden: !visible && hiddenSeen });
}

// ═══ list ═══════════════════════════════════════════════════════════════════════════════════
async function listDesigns(admin: any, identity: CustomerIdentity, deps: Deps, dbFail: DbFail): Promise<Response> {
  // One read per proven identity rather than one `or=(…)`: an address may legally contain the
  // commas and parentheses PostgREST's or-syntax is built from.
  const linksByCode = new Map<string, IdentityColumn[]>();
  for (const id of provenIdentityColumns(identity)) {
    const { data: links, error: lErr } = await admin.from("customer_design_links")
      .select("short_code")
      .eq("client_id", identity.clientId)
      .eq(id.column, id.value)
      .is("hidden_at", null)
      .order("created_at", { ascending: false })
      // LINK_SCAN_LIMIT, not the cap (review, 2026-09-15): the newest 200 links can all be drafts
      // that have since become quotes, and reading only those hid every real draft behind them.
      .limit(LINK_SCAN_LIMIT);
    if (lErr) return dbFail("read your saved designs", lErr);
    for (const l of links ?? []) {
      const code = String(l.short_code);
      const ids = linksByCode.get(code) ?? [];
      ids.push(id);
      linksByCode.set(code, ids);
    }
  }
  if (linksByCode.size === 0) return json({ ok: true, designs: [] });

  const codes = [...linksByCode.keys()];
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let i = 0; i < codes.length; i += IN_CHUNK) {
    const { data, error } = await admin.from("designs")
      .select("short_code, status, contact, selections, created_at, updated_at, view3d_image_url")
      .eq("client_id", identity.clientId)
      // Drafts only, in the query: most links behind a repeat customer are issued quotes, and
      // their selections blobs are not worth carrying just to be filtered out below.
      .eq("status", "draft")
      .in("short_code", codes.slice(i, i + IN_CHUNK));
    if (error) return dbFail("load your saved designs", error);
    rows.push(...(data ?? []));
  }

  const ownPrefix = deps.storageOrigin ? `${deps.storageOrigin}/storage/v1/object/public/` : "";
  const ownStorageUrl = (u: unknown): string | null => {
    const s = typeof u === "string" ? u.trim() : "";
    return ownPrefix && s.startsWith(ownPrefix) ? s : null;
  };
  const when = (r: any) => Date.parse(String(r.updated_at || r.created_at || "")) || 0;

  const designs = rows
    .filter((d) => {
      // Drafts only: once issued it is a quote, and customer-quotes lists it under Quotes.
      if (d?.status !== "draft") return false;
      // Still named by an identity it was SAVED under (rule 2 in the header). Matching some other
      // identity the session happens to hold is not enough — that identity never saved it.
      const linkedAs = linksByCode.get(String(d.short_code)) ?? [];
      return matchedIdentities(identity, d.contact)
        .some((m) => linkedAs.some((l) => l.column === m.column && l.value === m.value));
    })
    .sort((a, b) => when(b) - when(a))
    // The list reads past the cap (LINK_SCAN_LIMIT) to reach drafts behind issued quotes, but it
    // still shows at most the cap: the newest-edited 200.
    .slice(0, MAX_LINKS_PER_IDENTITY)
    // NARROW projection (the migration-048 rule customer-quotes keeps): no contact, no lines, no
    // prices. Only what a "Saved designs" card renders.
    .map((d) => ({
      ref: String(d.short_code),
      style: d?.selections?.style ?? null,
      size: d?.selections?.size ?? null,
      createdAt: d.created_at ?? null,
      updatedAt: d.updated_at ?? d.created_at ?? null,
      view3dImageUrl: ownStorageUrl(d.view3d_image_url),
    }));

  return json({ ok: true, designs });
}

// ═══ hide ═══════════════════════════════════════════════════════════════════════════════════
async function hideDesign(admin: any, identity: CustomerIdentity, code: string, dbFail: DbFail): Promise<Response> {
  // Only the caller's own links: another person's link to the same design (a partner who saved it
  // under their own phone) is theirs to remove. Always {ok:true} — hiding something that was never
  // saved, or is already hidden, leaves the list exactly as asked, and the answer reveals nothing.
  const now = new Date().toISOString();
  for (const id of provenIdentityColumns(identity)) {
    const { error } = await admin.from("customer_design_links")
      .update({ hidden_at: now })
      .eq("client_id", identity.clientId)
      .eq(id.column, id.value)
      .eq("short_code", code)
      .is("hidden_at", null);
    if (error) return dbFail("remove the saved design", error);
  }
  return json({ ok: true });
}
