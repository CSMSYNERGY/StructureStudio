import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { AUTH_PORTAL_URL } from "../_shared/authPortalUrl.ts";
import {
  accessMetadata,
  canEdit as accCanEdit,
  canRead as accCanRead,
  effectiveAccess,
  type Level,
  mayGrantMap,
  roleForTitle,
  sanitizeAccess,
  TITLES,
} from "../_shared/access.ts";

// Commission team + rates backend (portal.html Settings → "Team & commissions").
//
// Confidentiality is the whole point: commission_members (rates + the two grants) is a
// SERVICE-ROLE-ONLY table with browser grants revoked, so it can only ever be read/written
// here, behind server-side gating. A rep never sees a %, and an admin never sees a rate
// unless the owner granted them full_access.
//
// Auth (server-side, same rule as portal-settings): verify_jwt alone is NOT auth — the bare
// anon key passes the gateway. We resolve a REAL user via auth.getUser(), then map them
// through client_users to their tenant + role. clientId is NEVER read from the body.
//
// Gating:
//   - isAdmin  (owner|admin)         → list, add_user, remove_user
//   - canSeeRates (owner|full_access) → rates visible in list + set_rate
//   - isOwner                         → the two grants (sees_all_payouts, full_access)
//
// Actions:
//   { action: "list" }
//   { action: "set_rate",   userId, percent }            // percent: 0..100 or null
//   { action: "set_grants", userId, seesAllPayouts?, fullAccess? }   // owner only
//   { action: "add_user",   email, fullName?, role }     // invite by email (reuses link_owner flow)
//   { action: "remove_user", userId, mode }              // mode: "unlink" | "deactivate"
//   { action: "compute", debug? }                        // refresh the ledger from orders×settings×rates (owner|full_access)
//   { action: "list_entries" }                           // the report (rep=own, owner/sees_all=everyone)
//   { action: "assign_earner", entryId, userId? }        // set/clear an entry's earner (owner|full_access)
//   { action: "approve_period", periodKey }              // pending → payable, the review gate (owner)
//   { action: "unapprove_period", periodKey }            // payable → pending while unpaid (owner)
//   { action: "mark_paid", periodKey? | entryIds? }      // mark APPROVED (payable) lines paid (owner)
//   { action: "split_entry", entryId, splits:[{userId,sharePercent}] }  // per-sale split (owner|full_access)
//   { action: "adjust_amount", entryId, amountCents }    // override an amount (owner|full_access)
//   { action: "set_excluded", entryId, excluded }        // exclude/restore a line (owner|full_access)
//   { action: "clawback", entryId, note? }               // negative line for one paid+cancelled line (owner)
//   { action: "cancel_order", orderId }                   // cancel a whole order: claw back paid + exclude unpaid (owner)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
// One answer for every reason an address is refused, so the response can never be used to
// discover who else uses StructureStudio. See add_user.
const OPAQUE_ADD_FAILURE = "That email can't be added here. If they already use StructureStudio at another company, contact support.";

const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const enc = encodeURIComponent;

// Bounded GHL estimate list. This is the ONLY estimate read GHL offers that works — there is
// no single-estimate GET (/invoices/estimate/:id 404s), and the list carries the total but no
// pre-tax subtotal. Returns [] on any failure — a missing base reads as "not yet known", never zero.
async function listEstimates(locationId: string, apiKey: string): Promise<any[]> {
  const headers = { Authorization: `Bearer ${apiKey}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };
  const out: any[] = []; const limit = 100;
  for (let offset = 0; offset < 2000; offset += limit) {
    let r: Response;
    try { r = await fetch(`https://services.leadconnectorhq.com/invoices/estimate/list?altId=${enc(locationId)}&altType=location&limit=${limit}&offset=${offset}`, { headers }); }
    catch { break; }
    if (!r.ok) break;
    const d = await r.json().catch(() => null);
    const arr = Array.isArray(d?.estimates) ? d.estimates : (Array.isArray(d?.data) ? d.data : []);
    out.push(...arr);
    if (arr.length < limit) break;
  }
  return out;
}

// The pay period a date falls into, per the tenant's cadence + anchor. Monthly = calendar month;
// weekly/biweekly/custom = fixed-length day buckets counted forward from the anchor.
function periodKey(dateStr: string, freq: string, anchor: string, customDays: number | null): { key: string; start: string; end: string } {
  const d = new Date(dateStr + "T00:00:00Z");
  if (freq === "monthly") {
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const end = new Date(Date.UTC(y, m + 1, 0));
    return { key: `${y}-${String(m + 1).padStart(2, "0")}`, start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const len = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : Math.max(1, Number(customDays) || 14);
  const a = new Date((anchor || dateStr) + "T00:00:00Z");
  const bucket = Math.floor((d.getTime() - a.getTime()) / 86400000 / len);
  const start = new Date(a.getTime() + bucket * len * 86400000);
  const s = start.toISOString().slice(0, 10);
  return { key: `${freq}:${s}`, start: s, end: new Date(start.getTime() + (len - 1) * 86400000).toISOString().slice(0, 10) };
}

// The date cumulative non-voided payments first reach the order total (the money-collected
// trigger). Null until the order is fully collected — an un-collected order earns no commission yet.
function collectedDate(pays: any[], totalCents: number | null): string | null {
  if (totalCents == null) return null;
  const sorted = pays.filter((p) => !p.voided_at).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  let sum = 0;
  for (const p of sorted) { sum += p.amount_cents || 0; if (sum >= totalCents) return String(p.received_at).slice(0, 10); }
  return null;
}

// Human label for a period_key ("YYYY-MM" monthly, or "freq:startdate" for day-bucket cadences).
function periodLabel(key: string, freq: string, customDays: number | null): string {
  if (/^\d{4}-\d{2}$/.test(key)) { const [y, m] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }); }
  const start = key.includes(":") ? key.split(":")[1] : key;
  const s = new Date(start + "T00:00:00Z");
  if (isNaN(s.getTime())) return key;
  const len = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : Math.max(1, Number(customDays) || 14);
  const e = new Date(s.getTime() + (len - 1) * 86400000);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(s)} – ${f(e)}, ${e.getUTCFullYear()}`;
}

Deno.serve(withErrorLog("portal-commissions", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Real signed-in user (bare anon key passes the gateway but carries no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // 2. Map the caller to their tenant + role (service role; client_id is never trusted from the body).
  //    limit(1) not maybeSingle(): maybeSingle() ERRORS when a duplicate client_users row
  //    exists, which would lock the user out entirely. portal.html already guards this
  //    the same way (its "audit #F6" comment), as does _shared/resolveTenant.ts.
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: meRows, error: meErr } = await admin
    .from("client_users").select("client_id, role, title, access").eq("user_id", user.id).limit(1);
  if (meErr) return json({ error: meErr.message }, 500);
  const me = meRows && meRows[0];
  if (!me?.client_id) return json({ error: "Your login isn't attached to an account." }, 403);
  const clientId: string = me.client_id;
  const role: string = me.role || "user";
  const isOwner = role === "owner";
  const isAdmin = role === "owner" || role === "admin";
  // The caller's resolved per-area access (migration 100). The TEAM actions below gate on
  // settings_team rather than on role, so that "as dynamic as possible per individual"
  // actually reaches the screen where people are managed — an office manager can be given
  // Team without being made an admin. Owners resolve to full access inside effectiveAccess.
  const myAccess = effectiveAccess(role, me.title, me.access as Record<string, unknown> | null);
  const canManageTeam = accCanEdit(myAccess, "settings_team");
  const canViewTeam = accCanRead(myAccess, "settings_team");

  // The caller's own grants. Owner always sees rates + all payouts regardless.
  const { data: myCm } = await admin
    .from("commission_members").select("full_access, sees_all_payouts").eq("client_id", clientId).eq("user_id", user.id).maybeSingle();
  const canSeeRates = isOwner || myCm?.full_access === true;
  const seesAll = isOwner || myCm?.sees_all_payouts === true;

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = p?.action;

  // Operators may NOT act on a builder's commissions — Carolyn, 2026-08-07: "Operators
  // should not be able to change commissions in builders pages."
  //
  // Stated HERE, server-side, rather than left to the UI. The rule already held, but only
  // because portal.html hides the Commissions and Team sub-tabs while viewing another
  // tenant — a courtesy, not a control, and one a later layout change could drop without
  // anyone noticing. Two further reasons it could not be relied on:
  //
  //   * This function is deliberately absent from portal.html's SS_TENANT_SCOPED_FNS
  //     allow-list, so the "view as" override is never injected into its calls. That is an
  //     omission, and the allow-list's own comment warns that a function added later gets
  //     no injection until someone names it — so the next person to "complete" that list
  //     would silently hand operators the keys.
  //   * It returns no `clientId`, so the wrapper's cross-tenant tripwire cannot fire either.
  //
  // A hard refusal rather than a silent ignore, for the same reason resolveTenant 403s an
  // unauthorised override: a body field honoured for some callers and quietly dropped for
  // others is what a later refactor turns into a cross-tenant hole, and silent-ignore makes
  // the negative test pass for the wrong reason (200-with-own-data instead of a refusal).
  // NOT an operator check — nobody may redirect this function at another tenant, so there
  // is no capability that unlocks it and no need to consult app_operators.
  if (p?.targetClientId !== undefined && p?.targetClientId !== null && p?.targetClientId !== "") {
    return json({
      error: "Commissions are per-builder and cannot be changed on another account's behalf. Ask that builder's owner to make the change.",
    }, 403);
  }

  const audit = async (note: string) => {
    try { await admin.from("admin_audit").insert({ action: "commissions", target_client_id: clientId, row_count: null, note: `tenant:${user.email || user.id} ${note}`.trim() }); }
    catch { /* best-effort */ }
  };
  // Confirm a userId is a member of THIS tenant before any write touches them.
  const requireMember = async (uid: unknown) => {
    if (!isUuid(uid)) throw new Error("Invalid user id.");
    const { data, error } = await admin.from("client_users").select("user_id, role, title, access").eq("client_id", clientId).eq("user_id", uid).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("That person isn't on your team.");
    return data as { user_id: string; role: string; title: string | null; access: Record<string, unknown> | null };
  };

  try {
    switch (action) {
      // ── list the team (rates only if the caller may see them; grants only for the owner) ──
      case "list": {
        if (!canViewTeam) return json({ error: "You don't have access to the team list." }, 403);
        const { data: rows, error } = await admin
          .from("client_users").select("user_id, role, title, access, full_name, created_at").eq("client_id", clientId).order("created_at");
        if (error) throw error;
        const { data: cms } = await admin
          .from("commission_members").select("user_id, commission_percent, sees_all_payouts, full_access").eq("client_id", clientId);
        const cmById = new Map((cms || []).map((c: any) => [c.user_id, c]));
        // Truck summary for the Driver callout in the access editor. Read-only here: the
        // record itself is written in exactly one place (portal-schedule's save_driver), so
        // the editor shows what is on file and points at that card rather than becoming a
        // second writer of the same row.
        const { data: dps } = await admin.from("driver_profiles")
          .select("user_id, truck_name, deck_length_ft, max_width_ft, is_driver, active")
          .eq("client_id", clientId).eq("is_driver", true).eq("active", true);
        const dpById = new Map((dps || []).map((d: any) => [d.user_id, d]));
        const members = [];
        for (const r of rows || []) {
          const uid = (r as any).user_id;
          let email = "";
          let lastActive: string | null = null;
          let deactivated = false;
          try {
            const { data: au } = await admin.auth.admin.getUserById(uid);
            email = au?.user?.email || "";
            lastActive = au?.user?.last_sign_in_at || null;
            // A ~100-year ban is how remove_user deactivates a login. Surfacing it on the
            // roster is what stops "I re-added them and they still can't get in" being an
            // invisible state — see the ban-clearing in add_user.
            const b = au?.user?.banned_until;
            deactivated = !!b && new Date(b).getTime() > Date.now();
          } catch { /* one missing auth user must not break the list */ }
          const cm: any = cmById.get(uid) || {};
          members.push({
            userId: uid,
            email,
            fullName: (r as any).full_name || "",
            role: (r as any).role || "user",
            isSelf: uid === user.id,
            // Rate is confidential: present only when the caller may see it.
            commissionPercent: canSeeRates ? (cm.commission_percent == null ? null : Number(cm.commission_percent)) : undefined,
            rateHidden: canSeeRates ? undefined : true,
            // Grants are managed by the owner only.
            seesAllPayouts: isOwner ? !!cm.sees_all_payouts : undefined,
            fullAccess: isOwner ? !!cm.full_access : undefined,
            // Per-person access (migration 100). `title` is the job label and the preset it
            // seeds; `access` is only their deviations from it; `effective` is what the
            // server will actually enforce. The screen shows `effective` so nobody has to
            // do the preset-plus-overrides arithmetic in their head to answer "can Dana see
            // pricing?" — the honest answer is the resolved one.
            lastActive,
            deactivated,
            driver: (() => {
              const d: any = dpById.get(uid);
              if (!d) return null;
              return [d.truck_name, d.deck_length_ft ? d.deck_length_ft + "' deck" : null,
                d.max_width_ft ? "max " + d.max_width_ft + "' wide" : null].filter(Boolean).join(" · ") || null;
            })(),
            title: (r as any).title || null,
            access: ((r as any).access as Record<string, Level> | null) || null,
            effective: effectiveAccess((r as any).role, (r as any).title, (r as any).access),
          });
        }
        return json({
          ok: true, clientId, role, canSeeRates, isOwner, members,
          // The grid is rendered from what the server sends, never from a hard-coded list in
          // portal.html — a second copy of the areas would drift the day one is added, and a
          // permission table that drifts is a permission table that lies.
          meta: accessMetadata(),
          canManageTeam,
          myAccess,
        });
      }

      // ── set a person's commission rate (owner or full_access) ──
      case "set_rate": {
        if (!canSeeRates) return json({ error: "You don't have access to commission rates." }, 403);
        await requireMember(p.userId);
        let percent: number | null = null;
        if (p.percent !== null && p.percent !== "" && p.percent !== undefined) {
          const n = Number(p.percent);
          if (!Number.isFinite(n) || n < 0 || n > 100) return json({ error: "Rate must be between 0 and 100." }, 400);
          percent = Math.round(n * 1000) / 1000;
        }
        const { error } = await admin.from("commission_members").upsert(
          { client_id: clientId, user_id: p.userId, commission_percent: percent, updated_at: new Date().toISOString(), updated_by: user.id },
          { onConflict: "client_id,user_id" });
        if (error) throw error;
        await audit(`set_rate ${p.userId}`);
        return json({ ok: true });
      }

      // ── set a person's confidentiality grants (OWNER ONLY) ──
      case "set_grants": {
        if (!isOwner) return json({ error: "Only the owner can grant commission access." }, 403);
        await requireMember(p.userId);
        const patch: any = { client_id: clientId, user_id: p.userId, updated_at: new Date().toISOString(), updated_by: user.id };
        if (typeof p.seesAllPayouts === "boolean") patch.sees_all_payouts = p.seesAllPayouts;
        if (typeof p.fullAccess === "boolean") patch.full_access = p.fullAccess;
        const { error } = await admin.from("commission_members").upsert(patch, { onConflict: "client_id,user_id" });
        if (error) throw error;
        await audit(`set_grants ${p.userId}`);
        return json({ ok: true });
      }

      // ── invite a teammate by email (reuses admin-catalog's link_owner flow, re-gated to owner/admin) ──
      case "add_user": {
        if (!canManageTeam) return json({ error: "You don't have access to add people." }, 403);
        const email = String(p.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
        // Titles (migration 100), not the three legacy roles. `role` is derived from the
        // title and written alongside it so the coarse column RLS still reads can never
        // disagree with the title on screen. Falls back to Sales Rep — the least-privileged
        // preset — rather than to anything inherited.
        const wantTitle = TITLES.some((t) => t.key === p.title) ? String(p.title) : "sales_rep";
        const wantRole = roleForTitle(wantTitle);
        // Only an owner mints owners and admins; everything else runs through mayGrantMap
        // below, which also catches "make them an Owner" as the escalation it is.
        if (!isOwner && (wantTitle === "owner" || wantTitle === "admin")) {
          return json({ error: "Only an owner can add another owner or admin." }, 403);
        }
        // Title-aware so a billing seed survives only on an admin (owner-added, per the
        // gate two lines up) — anything else is dropped here and refused by mayGrantMap.
        const seedAccess = sanitizeAccess(p.access, wantTitle);
        const tooHigh = mayGrantMap(role, myAccess, effectiveAccess(wantRole, wantTitle, seedAccess));
        if (tooHigh) return json({ error: `You can't give someone access to ${tooHigh} that you don't have yourself.` }, 403);
        const fullName = typeof p.fullName === "string" ? p.fullName.trim().slice(0, 120) : null;

        // find existing auth user by email (paginated admin list)
        let au: any = null;
        for (let page = 1; page <= 20 && !au; page++) {
          const list = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (list.error) throw list.error;
          const users = list.data?.users || [];
          au = users.find((u: any) => String(u.email || "").toLowerCase() === email) || null;
          if (users.length < 1000) break;
        }
        let created = false, emailSent = false;
        if (!au) {
          const inv = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: AUTH_PORTAL_URL });
          if (!inv.error && inv.data?.user) { au = inv.data.user; created = true; emailSent = true; }
          else {
            const cu = await admin.auth.admin.createUser({ email, email_confirm: true });
            if (cu.error && !/already|registered|exist/i.test(cu.error.message || "")) throw cu.error;
            au = cu.data?.user || null;
            if (!au) { const rl = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }); au = (rl.data?.users || []).find((u: any) => String(u.email || "").toLowerCase() === email) || null; }
            if (!au) throw new Error(`Could not create a login for "${email}".`);
            created = !cu.error;
          }
        }
        // A StructureStudio OPERATOR login must never be adoptable into a tenant. It has no
        // client_users row at all (cross-tenant access lives in app_operators), so the
        // "belongs to another account" guard below cannot see it — without this check a
        // tenant admin could link a support login into their own team and be handed a
        // password-setup link for it. Service-role read: app_operators has RLS on with zero
        // policies (051), so a user-scoped client returns nothing for everyone.
        const { data: opRow } = await admin.from("app_operators").select("user_id").eq("user_id", au.id).maybeSingle();
        if (opRow) return json({ error: OPAQUE_ADD_FAILURE }, 409);

        // Never silently re-home a login already attached to a DIFFERENT tenant. The message
        // is deliberately the SAME one used for every other rejection: echoing "already
        // belongs to another account" back at the caller turns this endpoint into a
        // platform-wide existence oracle — loop it over a competitor's staff addresses and
        // you learn which of them are StructureStudio users. One answer for every refusal.
        const existing = await admin.from("client_users").select("client_id, role").eq("user_id", au.id).maybeSingle();
        if (existing.error) throw existing.error;
        if (existing.data && existing.data.client_id && existing.data.client_id !== clientId) {
          return json({ error: OPAQUE_ADD_FAILURE }, 409);
        }
        // Re-adding someone who was removed with "Deactivate login" has to actually let them
        // back in. The ban lives on the auth record, not on the membership, so without this
        // they rejoin the team, get a working-looking setup link, set a password, and then
        // every sign-in fails with nothing anywhere explaining why.
        if (!created) { try { await admin.auth.admin.updateUserById(au.id, { ban_duration: "none" }); } catch { /* best-effort */ } }
        if (existing.data && existing.data.client_id === clientId) {
          // Already on this team — update name only, never silently change their role here.
          if (fullName) await admin.from("client_users").update({ full_name: fullName }).eq("user_id", au.id);
          await admin.from("commission_members").upsert({ client_id: clientId, user_id: au.id }, { onConflict: "client_id,user_id", ignoreDuplicates: true });
          return json({ ok: true, userId: au.id, email, alreadyOnTeam: true });
        }
        const link = await admin.from("client_users").upsert(
          { user_id: au.id, client_id: clientId, role: wantRole, title: wantTitle,
            access: Object.keys(seedAccess).length ? seedAccess : null,
            ...(fullName ? { full_name: fullName } : {}) }, { onConflict: "user_id" });
        if (link.error) throw link.error;
        // Seed a commission_members row so the person shows up on the team with a blank rate.
        await admin.from("commission_members").upsert({ client_id: clientId, user_id: au.id }, { onConflict: "client_id,user_id", ignoreDuplicates: true });

        // The setup link is a BEARER CREDENTIAL: whoever opens it first gets a session as
        // that person and sets their password. That is the right trade for a brand-new
        // passwordless account, where it is the only way in. It is the wrong trade for an
        // account that already has a password — there it is a silent password reset, mintable
        // by anyone holding Team access and handed back in the response body. So it is only
        // ever issued to a login that has NEVER signed in. Everyone else uses "Forgot
        // password" from the sign-in page, which mails the link to them rather than to
        // whoever asked for it.
        let setupLink: string | null = null;
        if (!au.last_sign_in_at) {
          try { const gl = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: AUTH_PORTAL_URL } }); if (!gl.error) setupLink = gl.data?.properties?.action_link || null; } catch { /* best-effort */ }
        }
        await audit(`add_user ${email} as ${wantTitle}`);
        return json({ ok: true, userId: au.id, email, role: wantRole, title: wantTitle, created, emailSent, setupLink });
      }

      // ── set one person's job title and per-area access (migration 100) ──────────
      //
      // Carolyn: "I want the access to each to be as dynamic as possible per individual.
      //  Admins and Owners should assign each user the access they want to give them
      //  (tab by tab) and they may choose Read or Edit."
      //
      // The order of the checks below is the security design; each one closes a specific
      // way this endpoint could be turned into a privilege-escalation tool.
      case "set_access": {
        if (!canManageTeam) return json({ error: "You don't have access to change people's access." }, 403);
        const target = await requireMember(p.userId);

        // 1. NOT YOURSELF. Without this, anyone who can manage the team can hand themselves
        //    every area in two clicks, and mayGrantMap below would happily allow it one
        //    area at a time (grant yourself what you already have... then use it). Access is
        //    something you receive, never something you write for yourself.
        if (String(p.userId) === user.id) {
          return json({ error: "You can't change your own access. Ask an owner." }, 403);
        }

        // 2. OWNERS ARE UNTOUCHABLE HERE, same as remove_user. Owners resolve to full access
        //    unconditionally, so "editing" one would silently do nothing — and demoting the
        //    last owner would strand the account with nobody able to reach Billing. Changing
        //    an owner belongs to the operator console, where it is audited as such.
        if (target.role === "owner") {
          return json({ error: "Owners always have full access and can't be changed here." }, 403);
        }

        // 2b. ADMINS ARE PEERS, AND PEERS DON'T EDIT EACH OTHER. mayGrantMap in step 6 lets
        //     "none" through unconditionally — taking access away has to stay possible, or a
        //     departing employee could not be locked out by whoever is on shift. But that
        //     also means one admin could strip a peer admin down to a Driver, Team access
        //     included, and end up the only person who can manage people. Subtraction is the
        //     escalation nobody thinks to look for. Only an owner settles it between admins.
        if (!isOwner && target.role === "admin") {
          return json({ error: "Only an owner can change another admin's access." }, 403);
        }

        // 3. A VALID TITLE, or keep the one they have. Never fall through to "everything".
        const nextTitle = TITLES.some((t) => t.key === p.title) ? String(p.title) : (target.title || "sales_rep");
        if (p.title !== undefined && !TITLES.some((t) => t.key === p.title)) {
          return json({ error: "Unknown job title." }, 400);
        }
        // 4. Only an owner mints owners and admins.
        if (!isOwner && (nextTitle === "owner" || nextTitle === "admin")) {
          return json({ error: "Only an owner can make someone an owner or admin." }, 403);
        }

        // 4b. Billing goes to ADMINS, by an OWNER (ownerGranted — Carolyn 2026-08-08).
        //     A loud refusal, not the silent drop sanitizeAccess would do: the grid updates
        //     from this response, so a silently-dropped switch snaps back with no
        //     explanation, which reads as "the save is broken". mayGrantMap in step 6
        //     already refuses non-owner granters; this is the target-side half.
        const wantsBilling = p.access !== undefined &&
          ["view", "edit"].includes((p.access as Record<string, unknown>)?.settings_billing as string);
        if (wantsBilling && nextTitle !== "admin") {
          return json({ error: "Billing can only be granted to an Admin. Change their job title first." }, 400);
        }

        // 5. Store only real deviations, so the row never contains a claim the resolver
        //    ignores — what the owner sees on the grid is what is saved. Title-aware so an
        //    owner-granted area is stored only on a row whose title may hold it.
        const nextAccess = p.access === undefined ? ((target.access as Record<string, Level> | null) || {}) : sanitizeAccess(p.access, nextTitle);
        const nextRole = roleForTitle(nextTitle);

        // 6. NOBODY GRANTS ABOVE THEMSELVES — checked against the RESOLVED result, not the
        //    submitted overrides. Access is stored as deviations from a preset, so an admin
        //    could otherwise hand out the entire Owner preset while submitting an empty
        //    overrides object, just by setting the title. Resolving first catches both doors.
        const resulting = effectiveAccess(nextRole, nextTitle, nextAccess);
        const tooHigh = mayGrantMap(role, myAccess, resulting);
        if (tooHigh) {
          return json({ error: `You can't give someone access to ${tooHigh} that you don't have yourself.` }, 403);
        }

        // 7. role travels with title — see roleForTitle. Scoped to (client_id, user_id) so a
        //    forged userId from another tenant cannot be written even if step 0 were removed.
        const upd = await admin.from("client_users")
          .update({ title: nextTitle, role: nextRole, access: Object.keys(nextAccess).length ? nextAccess : null })
          .eq("client_id", clientId).eq("user_id", p.userId);
        if (upd.error) throw upd.error;
        await audit(`set_access ${p.userId} title=${nextTitle} areas=${Object.keys(nextAccess).length}`);
        return json({ ok: true, userId: p.userId, title: nextTitle, role: nextRole, access: nextAccess, effective: resulting });
      }

      // ── remove a teammate: unlink from this tenant, or fully deactivate the login ──
      case "remove_user": {
        if (!canManageTeam) return json({ error: "You don't have access to remove people." }, 403);
        const target = await requireMember(p.userId);
        const mode = p.mode === "deactivate" ? "deactivate" : "unlink";
        if (p.userId === user.id) return json({ error: "You can't remove yourself." }, 400);
        // Owners are protected here — moving/removing an owner belongs to the operator console.
        if (target.role === "owner") return json({ error: "Owners can't be removed here." }, 403);
        // An admin can only remove plain users, not other admins.
        if (!isOwner && target.role !== "user") return json({ error: "Only the owner can remove an admin." }, 403);

        // Two references to this person live OUTSIDE client_users, neither protected by a
        // foreign key, and both became load-bearing in the last few days:
        //
        //  * driver_profiles.user_id is NOT NULL as of migration 101, and save_driver now
        //    refuses to create or unlink a login-less driver. Delete the client_users row
        //    alone and the profile survives with is_driver=true: the delivery board keeps
        //    offering a driver who cannot sign in, and the tenant cannot even fix the ghost,
        //    because save_driver requires a userId that is on the team. ARCHIVE rather than
        //    delete — delivery_loads.driver_id is ON DELETE SET NULL, so removing the row
        //    would silently blank who drove every past and scheduled load for that person.
        //
        //  * build_crews.member_user_ids is a bare uuid[], and save_crew now validates every
        //    id against client_users. A stale id makes that crew permanently UNSAVABLE — the
        //    tenant cannot rename, recolor or re-staff it without a hand-edit to the array.
        //
        // Both are consequences of tightening those two paths, so both are cleaned up here.
        await admin.from("driver_profiles")
          .update({ is_driver: false, active: false })
          .eq("client_id", clientId).eq("user_id", p.userId);
        const { data: crewRows } = await admin.from("build_crews")
          .select("id, member_user_ids").eq("client_id", clientId).contains("member_user_ids", [p.userId]);
        for (const c of crewRows || []) {
          const kept = (((c as any).member_user_ids) || []).filter((x: string) => x !== p.userId);
          await admin.from("build_crews").update({ member_user_ids: kept })
            .eq("id", (c as any).id).eq("client_id", clientId);
        }
        await admin.from("commission_members").delete().eq("client_id", clientId).eq("user_id", p.userId);
        await admin.from("client_users").delete().eq("client_id", clientId).eq("user_id", p.userId);
        if (mode === "deactivate") {
          // ~100-year ban disables the login without destroying the auth record (reversible).
          const b = await admin.auth.admin.updateUserById(p.userId, { ban_duration: "876000h" });
          if (b.error) throw b.error;
        }
        await audit(`remove_user ${p.userId} (${mode})`);
        return json({ ok: true, mode });
      }

      // ── compute/refresh the ledger from orders × settings × rates (owner or full_access) ──
      // Reconciles commission_entries against current orders WITHOUT disturbing rows the owner has
      // approved (status='payable'), finalized (status='paid') or hand-edited (is_override). The
      // pre-tax base is filled best-effort from the GHL estimate subtotal; if GHL is unreachable the
      // entry is still created with a null base/amount so the order shows on the report to be resolved.
      case "compute": {
        if (!canSeeRates) return json({ error: "Only the owner or a full-access admin can run commissions." }, 403);
        const { data: settings } = await admin.from("commission_settings").select("*").eq("client_id", clientId).maybeSingle();
        if (!settings || !settings.enabled) return json({ ok: true, enabled: false, computed: 0, updated: 0 });
        const baseType: string = settings.base_type;
        const earnedOn: string = settings.earned_on;
        const freq: string = settings.payout_frequency;
        const anchor: string = settings.period_anchor;
        const customDays: number | null = settings.custom_days;

        const { data: orders } = await admin.from("orders")
          .select("id, short_code, total_cents, pretax_subtotal_cents, ordered_at").eq("client_id", clientId);
        const ords = orders || [];
        if (ords.length === 0) return json({ ok: true, orders: 0, computed: 0, updated: 0 });
        const codes = ords.map((o: any) => o.short_code).filter(Boolean);

        // designs → ghl_estimate_id (for the pre-tax fetch); invoice_sends → earner; members → rate; team → still-valid earners.
        const { data: designs } = await admin.from("designs").select("short_code, ghl_estimate_id").eq("client_id", clientId).in("short_code", codes);
        const estIdByCode = new Map<string, string>((designs || []).map((d: any) => [d.short_code, d.ghl_estimate_id]));
        const { data: invs } = await admin.from("invoice_sends").select("short_code, sender_user_id, sent_by_operator").eq("client_id", clientId);
        const senderByCode = new Map<string, string>();
        for (const iv of invs || []) if (iv.sender_user_id && !iv.sent_by_operator) senderByCode.set(iv.short_code, String(iv.sender_user_id));
        const { data: mems } = await admin.from("commission_members").select("user_id, commission_percent").eq("client_id", clientId);
        const rateByUser = new Map<string, number | null>((mems || []).map((m: any) => [m.user_id, m.commission_percent == null ? null : Number(m.commission_percent)]));
        const { data: teamRows } = await admin.from("client_users").select("user_id").eq("client_id", clientId);
        const teamSet = new Set<string>((teamRows || []).map((t: any) => t.user_id));

        let paysByOrder = new Map<string, any[]>();
        if (earnedOn === "collected") {
          const { data: pays } = await admin.from("payments").select("order_id, amount_cents, received_at, voided_at").eq("client_id", clientId);
          for (const pmt of pays || []) if (!pmt.voided_at) { const a = paysByOrder.get(pmt.order_id) || []; a.push(pmt); paysByOrder.set(pmt.order_id, a); }
        }

        // One bounded estimate-list call, only when some order still lacks a stored base.
        const estById = new Map<string, any>();
        if (baseType === "pretax_subtotal" && ords.some((o: any) => o.pretax_subtotal_cents == null && estIdByCode.get(o.short_code))) {
          const { data: cs } = await admin.from("client_settings").select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
          if (cs?.ghl_location_id && cs?.ghl_api_key) {
            for (const e of await listEstimates(cs.ghl_location_id, cs.ghl_api_key)) { const id = String(e?._id ?? e?.id ?? ""); if (id) estById.set(id, e); }
          }
        }

        const existing = (await admin.from("commission_entries").select("id, order_id, status, is_override").eq("client_id", clientId).eq("kind", "commission")).data || [];
        const existByOrder = new Map<string, any[]>();
        for (const e of existing) { const a = existByOrder.get(e.order_id) || []; a.push(e); existByOrder.set(e.order_id, a); }

        const diag: any[] = [];
        let computed = 0, updated = 0;
        for (const o of ords) {
          // Pre-tax base: stored value, else derive from the GHL estimate subtotal (scale verified
          // against the order's known cents total, since GHL reports money in dollars).
          let baseCents: number | null = o.pretax_subtotal_cents ?? null;
          if (baseCents == null && baseType === "pretax_subtotal") {
            const est = estById.get(String(estIdByCode.get(o.short_code) || ""));
            if (est) {
              // GHL exposes only the total (no pre-tax subtotal, no single-estimate GET). These
              // builders rarely charge sales tax, so the total IS the pre-tax base; the owner adjusts
              // the rare taxed order on the report. GHL money is dollars → cents (scale verified).
              const tot = num(est.total ?? est.totalamountInUSD ?? est.invoiceTotal);
              let scale = 100;
              if (tot != null && o.total_cents != null) {
                if (Math.abs(tot * 100 - o.total_cents) <= 2) scale = 100;
                else if (Math.abs(tot - o.total_cents) <= 2) scale = 1;
              }
              if (tot != null) {
                baseCents = Math.round(tot * scale);
                await admin.from("orders").update({ pretax_subtotal_cents: baseCents, updated_at: new Date().toISOString() }).eq("id", o.id);
              }
              if (p.debug) diag.push({ code: o.short_code, tot, orderTotalCents: o.total_cents, scale, baseCents });
            }
          }
          // Earner = the rep who sent the invoice (skip operator-sent), and only if still on the team.
          let earner: string | null = senderByCode.get(o.short_code) || null;
          if (earner && !teamSet.has(earner)) earner = null;
          // Earned-on date → pay period. Delivered isn't tracked yet, so it falls back to the sold date.
          const earnedDate = earnedOn === "collected"
            ? collectedDate(paysByOrder.get(o.id) || [], o.total_cents)
            : (o.ordered_at ? String(o.ordered_at).slice(0, 10) : null);
          const period = earnedDate ? periodKey(earnedDate, freq, anchor, customDays) : null;
          const rate = earner ? (rateByUser.get(earner) ?? null) : null;
          const amount = (baseCents != null && rate != null) ? Math.round(baseCents * rate / 100) : null;

          const ex = existByOrder.get(o.id) || [];
          // `payable` is finalized too, not just `paid`: approving a period is the owner committing to
          // those exact amounts, and this runs on every mount of the Commissions tab — a rate correction
          // between Approve and "Mark period paid" used to rewrite the approved line in place (status and
          // approved_at left untouched), so the rep was paid a number nobody approved. The same UPDATE
          // also moved period_key, which could strand an approved line where mark_paid never found it.
          // Un-approve the period to hand a line back to compute.
          if (ex.some((e) => e.status === "paid" || e.status === "payable" || e.is_override)) continue;   // finalized — never auto-touch
          const autoRow = ex.find((e) => !e.is_override && e.status !== "paid");
          const rowData: any = {
            client_id: clientId, order_id: o.id, earner_user_id: earner,
            base_cents: baseCents, rate_percent: rate, amount_cents: amount,
            earned_on: earnedDate, period_key: period?.key ?? null, kind: "commission", updated_at: new Date().toISOString(),
          };
          if (autoRow) { await admin.from("commission_entries").update(rowData).eq("id", autoRow.id); updated++; }
          else {
            // 23505 here is NOT a failure — it is the database holding the one invariant this
            // function cannot hold itself. `existing` was snapshotted before this loop, so a
            // compute that started while ours was running may already have inserted this
            // order's line; migration 148's partial unique index refuses the duplicate. The
            // desired end state (exactly one auto row for the order) is satisfied either way,
            // so skip it rather than aborting a compute that is otherwise correct. Anything
            // else is a real error and still surfaces.
            const { error: insErr } = await admin.from("commission_entries").insert({ ...rowData, status: "pending" });
            if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
            if (!insErr) computed++;
          }
        }

        if (p.debug && diag.length) {
          try { await admin.from("app_errors").insert({ source: "edge:portal-commissions", severity: "info", code: "compute_diag", message: "pretax diag", client_id: clientId, context: { diag: diag.slice(0, 25) } }); } catch { /* best-effort */ }
        }
        await audit(`compute (${computed} new, ${updated} updated)`);
        return json({ ok: true, orders: ords.length, computed, updated, ...(p.debug ? { diag } : {}) });
      }

      // ── the report: entries scoped to what the caller may see (rep = own; owner/sees_all = everyone) ──
      case "list_entries": {
        const { data: settings } = await admin.from("commission_settings").select("enabled, payout_frequency, custom_days").eq("client_id", clientId).maybeSingle();
        const freq = settings?.payout_frequency || "biweekly";
        const customDays = settings?.custom_days ?? null;
        let q = admin.from("commission_entries").select("*").eq("client_id", clientId);
        if (!seesAll) q = q.eq("earner_user_id", user.id);
        const entries = (await q).data || [];

        const orderIds = [...new Set(entries.map((e: any) => e.order_id))];
        const ords = orderIds.length ? (await admin.from("orders").select("id, order_no, short_code").in("id", orderIds)).data || [] : [];
        const ordById = new Map(ords.map((o: any) => [o.id, o]));
        const codes = [...new Set(ords.map((o: any) => o.short_code).filter(Boolean))] as string[];
        const dsns = codes.length ? (await admin.from("designs").select("short_code, contact, selections").eq("client_id", clientId).in("short_code", codes)).data || [] : [];
        const dByCode = new Map(dsns.map((d: any) => [d.short_code, d]));
        const earnerIds = [...new Set(entries.map((e: any) => e.earner_user_id).filter(Boolean))] as string[];
        const nameById = new Map<string, string>();
        if (earnerIds.length) {
          const cu = (await admin.from("client_users").select("user_id, full_name").in("user_id", earnerIds)).data || [];
          for (const u of cu) nameById.set(u.user_id, u.full_name || "");
          for (const id of earnerIds) if (!nameById.get(id)) { try { const { data: au } = await admin.auth.admin.getUserById(id); nameById.set(id, au?.user?.email || "—"); } catch { nameById.set(id, "—"); } }
        }
        const enriched = entries.map((e: any) => {
          const o: any = ordById.get(e.order_id) || {};
          const d: any = o.short_code ? dByCode.get(o.short_code) : null;
          const sel: any = d?.selections || {};
          return {
            id: e.id, orderId: e.order_id, orderNo: o.order_no ?? null,
            customer: d?.contact?.name || "—",
            building: [sel.style, sel.size].filter(Boolean).join(" ") || "—",
            earnerUserId: e.earner_user_id,
            earnerName: e.earner_user_id ? (nameById.get(e.earner_user_id) || "—") : null,
            baseCents: e.base_cents, ratePercent: e.rate_percent == null ? null : Number(e.rate_percent),
            amountCents: e.amount_cents, earnedOn: e.earned_on,
            periodKey: e.period_key, periodLabel: e.period_key ? periodLabel(e.period_key, freq, customDays) : "Unscheduled",
            status: e.status, kind: e.kind, isOverride: e.is_override,
            splitShare: e.split_share == null ? null : Number(e.split_share),
          };
        });
        // The assignable team (names) — only for someone who may edit commissions.
        let team: any = undefined;
        if (canSeeRates) {
          const tRows = (await admin.from("client_users").select("user_id, full_name").eq("client_id", clientId).order("created_at")).data || [];
          team = [];
          for (const t of tRows) { let email = ""; try { const { data: au } = await admin.auth.admin.getUserById(t.user_id); email = au?.user?.email || ""; } catch { /* skip */ } team.push({ userId: t.user_id, name: t.full_name || email || "—", email }); }
        }
        return json({ ok: true, isOwner, seesAll, canSeeRates, enabled: !!settings?.enabled, entries: enriched, team });
      }

      // ── assign/reassign an earner on one entry (owner or full_access); recomputes its amount ──
      case "assign_earner": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const entryId = Number(p.entryId);
        if (!Number.isFinite(entryId)) return json({ error: "Invalid entry." }, 400);
        const { data: entry } = await admin.from("commission_entries").select("*").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.status === "paid") return json({ error: "This commission is already paid — reverse the payment first." }, 409);
        let earnerId: string | null = null, rate: number | null = null;
        if (p.userId) {
          await requireMember(p.userId);
          earnerId = String(p.userId);
          const { data: m } = await admin.from("commission_members").select("commission_percent").eq("client_id", clientId).eq("user_id", earnerId).maybeSingle();
          rate = m?.commission_percent == null ? null : Number(m.commission_percent);
        }
        const amount = (entry.base_cents != null && rate != null) ? Math.round(entry.base_cents * rate / 100) : null;
        const { error } = await admin.from("commission_entries")
          .update({ earner_user_id: earnerId, rate_percent: rate, amount_cents: amount, is_override: true, updated_at: new Date().toISOString() })
          .eq("client_id", clientId).eq("id", entryId);
        if (error) throw error;
        await audit(`assign_earner entry=${entryId} → ${earnerId || "unassigned"}`);
        return json({ ok: true });
      }

      // ── split one sale between reps (owner|full_access) — replaces the entry with N override rows ──
      case "split_entry": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const entryId = Number(p.entryId);
        const { data: entry } = await admin.from("commission_entries").select("*").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.status === "paid" || entry.kind === "clawback") return json({ error: "A paid or clawback line can't be split." }, 409);
        const clean: { userId: string; share: number }[] = [];
        let sum = 0;
        for (const s of (Array.isArray(p.splits) ? p.splits : [])) {
          const share = Number(s?.sharePercent);
          if (isUuid(s?.userId) && Number.isFinite(share) && share > 0 && share <= 100) { clean.push({ userId: String(s.userId), share }); sum += share; }
        }
        if (clean.length < 2) return json({ error: "A split needs at least two people." }, 400);
        if (Math.abs(sum - 100) > 0.01) return json({ error: "Split shares must add up to 100%." }, 400);
        const teamIds = new Set(((await admin.from("client_users").select("user_id").eq("client_id", clientId)).data || []).map((r: any) => r.user_id));
        for (const cs of clean) if (!teamIds.has(cs.userId)) return json({ error: "A selected person isn't on your team." }, 400);
        const rateBy = new Map(((await admin.from("commission_members").select("user_id, commission_percent").eq("client_id", clientId)).data || []).map((m: any) => [m.user_id, m.commission_percent == null ? null : Number(m.commission_percent)]));
        const now = new Date().toISOString();
        await admin.from("commission_entries").delete().eq("client_id", clientId).eq("id", entryId);
        const rows = clean.map((cs) => {
          const baseShare = entry.base_cents != null ? Math.round(entry.base_cents * cs.share / 100) : null;
          const rate = (rateBy.get(cs.userId) ?? null) as number | null;
          return { client_id: clientId, order_id: entry.order_id, earner_user_id: cs.userId, base_cents: baseShare, rate_percent: rate, split_share: cs.share, amount_cents: (baseShare != null && rate != null) ? Math.round(baseShare * rate / 100) : null, earned_on: entry.earned_on, period_key: entry.period_key, kind: "commission", status: "pending", is_override: true, updated_at: now };
        });
        const { error } = await admin.from("commission_entries").insert(rows);
        if (error) throw error;
        await audit(`split_entry ${entryId} → ${rows.length} parts`);
        return json({ ok: true, parts: rows.length });
      }
      // NOTE: split_entry above is LEGACY (kept for older cached portals). The UI now uses
      // split_order below — splitting a LINE quartered an already-halved base when a split
      // was split again (Carolyn hit this on order #1003, 2026-08-05); an ORDER-level
      // allocation can be re-edited forever without compounding.

      // ── completely remove ONE line (owner|full_access). Distinct from Exclude: an excluded
      // line stays visible on the rep's report at $0; delete makes it as if it never existed.
      // Paid lines and clawbacks are immutable, and a line a clawback points at can't go
      // (the clawback would orphan) — exclude those instead.
      case "delete_entry": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const entryId = Number(p.entryId);
        const { data: entry } = await admin.from("commission_entries").select("id, status, kind").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.status === "paid" || entry.kind === "clawback") return json({ error: "Paid lines and clawbacks can't be deleted." }, 409);
        const { data: cb } = await admin.from("commission_entries").select("id").eq("client_id", clientId).eq("clawback_of", entryId).limit(1);
        if (cb && cb.length) return json({ error: "A clawback references this line — exclude it instead." }, 409);
        await admin.from("commission_entries").delete().eq("client_id", clientId).eq("id", entryId);
        await audit(`delete_entry ${entryId}`);
        return json({ ok: true });
      }

      // ── ORDER-level split: the modal shows everyone on the order; saving REPLACES the
      // order's unpaid commission lines with one line per person, each a share of the ORDER'S
      // FULL base — so re-editing an allocation never compounds. One person at 100% is legal
      // (that's "give the whole order to X"). Paid lines block the edit; clawbacks untouched.
      case "split_order": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const orderId = String(p.orderId || "");
        const { data: ord } = await admin.from("orders").select("id, short_code, total_cents, pretax_subtotal_cents, ordered_at").eq("client_id", clientId).eq("id", orderId).maybeSingle();
        if (!ord) return json({ error: "Order not found." }, 404);
        const clean: { userId: string; share: number }[] = [];
        let sum = 0;
        for (const s of (Array.isArray(p.splits) ? p.splits : [])) {
          const share = Number(s?.sharePercent);
          if (isUuid(s?.userId) && Number.isFinite(share) && share > 0 && share <= 100) { clean.push({ userId: String(s.userId), share }); sum += share; }
        }
        if (clean.length < 1) return json({ error: "Pick at least one person." }, 400);
        if (Math.abs(sum - 100) > 0.01) return json({ error: "Shares must add up to 100%." }, 400);
        if (new Set(clean.map((c) => c.userId)).size !== clean.length) return json({ error: "The same person is listed twice." }, 400);
        const teamIds = new Set(((await admin.from("client_users").select("user_id").eq("client_id", clientId)).data || []).map((r: any) => r.user_id));
        for (const cs of clean) if (!teamIds.has(cs.userId)) return json({ error: "A selected person isn't on your team." }, 400);
        const { data: exRows } = await admin.from("commission_entries").select("id, status, kind, base_cents, split_share, earned_on, period_key").eq("client_id", clientId).eq("order_id", ord.id).eq("kind", "commission");
        if ((exRows || []).some((r: any) => r.status === "paid")) return json({ error: "This order has a paid line — its allocation can't be edited." }, 409);
        // Full-order base: the stored pre-tax subtotal; else reconstruct from an existing line
        // (a line's base = full × share, so full = base ÷ share); else the order total.
        let fullBase: number | null = ord.pretax_subtotal_cents ?? null;
        if (fullBase == null) {
          const withBase = (exRows || []).filter((r: any) => r.base_cents != null).sort((a: any, b: any) => b.base_cents - a.base_cents);
          if (withBase.length) { const r0 = withBase[0]; fullBase = r0.split_share ? Math.round(r0.base_cents * 100 / Number(r0.split_share)) : r0.base_cents; }
          else fullBase = ord.total_cents ?? null;
        }
        const keep = (exRows || []).find((r: any) => r.period_key) || (exRows || [])[0] || null;
        const rateBy = new Map(((await admin.from("commission_members").select("user_id, commission_percent").eq("client_id", clientId)).data || []).map((m: any) => [m.user_id, m.commission_percent == null ? null : Number(m.commission_percent)]));
        const now = new Date().toISOString();
        await admin.from("commission_entries").delete().eq("client_id", clientId).eq("order_id", ord.id).eq("kind", "commission").neq("status", "paid");
        const rows = clean.map((cs) => {
          const baseShare = fullBase != null ? Math.round(fullBase * cs.share / 100) : null;
          const rate = (rateBy.get(cs.userId) ?? null) as number | null;
          return { client_id: clientId, order_id: ord.id, earner_user_id: cs.userId, base_cents: baseShare, rate_percent: rate, split_share: cs.share, amount_cents: (baseShare != null && rate != null) ? Math.round(baseShare * rate / 100) : null, earned_on: keep?.earned_on ?? (ord.ordered_at ? String(ord.ordered_at).slice(0, 10) : null), period_key: keep?.period_key ?? null, kind: "commission", status: "pending", is_override: true, updated_at: now };
        });
        const { error: insErr } = await admin.from("commission_entries").insert(rows);
        if (insErr) throw insErr;
        await audit(`split_order ${ord.id} → ${rows.length} people`);
        return json({ ok: true, parts: rows.length });
      }

      // ── rebuild an order's commission to the default single line (owner|full_access):
      // wipes the unpaid lines (splits, overrides, excluded — all of them) and re-materializes
      // what compute would create — earner = invoice sender, their standard rate, full base.
      // The rebuilt row is NOT an override, so the next compute keeps maintaining it. Paid
      // lines block (the money is out the door); clawbacks are left untouched.
      case "reset_order": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const orderId = String(p.orderId || "");
        const { data: ord } = await admin.from("orders").select("id, short_code, total_cents, pretax_subtotal_cents, ordered_at").eq("client_id", clientId).eq("id", orderId).maybeSingle();
        if (!ord) return json({ error: "Order not found." }, 404);
        const { data: exRows } = await admin.from("commission_entries").select("id, status, kind").eq("client_id", clientId).eq("order_id", ord.id).eq("kind", "commission");
        if ((exRows || []).some((r: any) => r.status === "paid")) return json({ error: "This order has a paid line — it can't be reset." }, 409);
        const { data: settings } = await admin.from("commission_settings").select("*").eq("client_id", clientId).maybeSingle();
        if (!settings || !settings.enabled) return json({ error: "Commission tracking isn't enabled." }, 409);
        const { data: iv } = await admin.from("invoice_sends").select("sender_user_id, sent_by_operator").eq("client_id", clientId).eq("short_code", ord.short_code).maybeSingle();
        let earner: string | null = (iv && !iv.sent_by_operator && iv.sender_user_id) ? String(iv.sender_user_id) : null;
        if (earner) {
          const { data: t } = await admin.from("client_users").select("user_id").eq("client_id", clientId).eq("user_id", earner).maybeSingle();
          if (!t) earner = null;
        }
        let rate: number | null = null;
        if (earner) {
          const { data: m } = await admin.from("commission_members").select("commission_percent").eq("client_id", clientId).eq("user_id", earner).maybeSingle();
          rate = m?.commission_percent == null ? null : Number(m.commission_percent);
        }
        const baseCents: number | null = ord.pretax_subtotal_cents ?? ord.total_cents ?? null;
        let earnedDate: string | null = ord.ordered_at ? String(ord.ordered_at).slice(0, 10) : null;
        if (settings.earned_on === "collected") {
          const { data: pays } = await admin.from("payments").select("amount_cents, received_at, voided_at").eq("client_id", clientId).eq("order_id", ord.id);
          earnedDate = collectedDate((pays || []).filter((x: any) => !x.voided_at), ord.total_cents);
        }
        const period = earnedDate ? periodKey(earnedDate, settings.payout_frequency, settings.period_anchor, settings.custom_days) : null;
        await admin.from("commission_entries").delete().eq("client_id", clientId).eq("order_id", ord.id).eq("kind", "commission").neq("status", "paid");
        const { error: insErr } = await admin.from("commission_entries").insert({
          client_id: clientId, order_id: ord.id, earner_user_id: earner,
          base_cents: baseCents, rate_percent: rate, amount_cents: (baseCents != null && rate != null) ? Math.round(baseCents * rate / 100) : null,
          earned_on: earnedDate, period_key: period?.key ?? null, kind: "commission", status: "pending", is_override: false, updated_at: new Date().toISOString(),
        });
        if (insErr) throw insErr;
        await audit(`reset_order ${ord.id}`);
        return json({ ok: true });
      }

      // ── override the amount on one entry, e.g. a rep's mistake (owner|full_access) ──
      case "adjust_amount": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const entryId = Number(p.entryId);
        const amt = Math.round(Number(p.amountCents));
        if (!Number.isFinite(amt)) return json({ error: "Enter a dollar amount." }, 400);
        const { data: entry } = await admin.from("commission_entries").select("status").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.status === "paid") return json({ error: "This commission is already paid." }, 409);
        const { error } = await admin.from("commission_entries").update({ amount_cents: amt, is_override: true, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("id", entryId);
        if (error) throw error;
        await audit(`adjust_amount ${entryId} = ${amt}`);
        return json({ ok: true });
      }

      // ── exclude a line from payout, or restore it (owner|full_access) ──
      case "set_excluded": {
        if (!canSeeRates) return json({ error: "You don't have access to change commissions." }, 403);
        const entryId = Number(p.entryId);
        const { data: entry } = await admin.from("commission_entries").select("status").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.status === "paid") return json({ error: "This commission is already paid." }, 409);
        const { error } = await admin.from("commission_entries").update({ status: p.excluded === true ? "excluded" : "pending", is_override: true, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("id", entryId);
        if (error) throw error;
        await audit(`set_excluded ${entryId} = ${p.excluded === true}`);
        return json({ ok: true });
      }

      // ── claw back an already-PAID commission when its order cancels+refunds (OWNER ONLY) ──
      // Adds a NEGATIVE line in the pay period the cancellation lands in (today's period), linked
      // to the original via clawback_of, so it deducts from the rep's next payout.
      case "clawback": {
        if (!isOwner) return json({ error: "Only the owner can claw back a commission." }, 403);
        const entryId = Number(p.entryId);
        const { data: entry } = await admin.from("commission_entries").select("*").eq("client_id", clientId).eq("id", entryId).maybeSingle();
        if (!entry) return json({ error: "Entry not found." }, 404);
        if (entry.kind === "clawback") return json({ error: "That's already a clawback line." }, 409);
        if (entry.status !== "paid") return json({ error: "Clawback is for an already-paid commission — for an unpaid one, just exclude it." }, 409);
        if ((await admin.from("commission_entries").select("id").eq("client_id", clientId).eq("clawback_of", entryId).maybeSingle()).data) return json({ error: "This commission was already clawed back." }, 409);
        const { data: st } = await admin.from("commission_settings").select("payout_frequency, custom_days, period_anchor").eq("client_id", clientId).maybeSingle();
        const today = new Date().toISOString().slice(0, 10);
        const period = periodKey(today, st?.payout_frequency || "biweekly", st?.period_anchor || today, st?.custom_days ?? null);
        const { error } = await admin.from("commission_entries").insert({
          client_id: clientId, order_id: entry.order_id, earner_user_id: entry.earner_user_id,
          base_cents: entry.base_cents != null ? -entry.base_cents : null, rate_percent: entry.rate_percent, split_share: entry.split_share,
          amount_cents: entry.amount_cents != null ? -entry.amount_cents : null,
          earned_on: today, period_key: period.key, kind: "clawback", status: "pending", is_override: true,
          clawback_of: entryId, note: (p.note ? String(p.note).slice(0, 200) : "Order cancelled / refunded"), updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        await audit(`clawback of ${entryId}`);
        return json({ ok: true });
      }

      // ── cancel a whole order ("deal fell through"): claw back its PAID commissions (when the
      //    tenant's clawback-on-cancel is on) and exclude its unpaid ones — across every line of the
      //    order, splits included. OWNER only. The discoverable version of the per-line clawback. ──
      case "cancel_order": {
        if (!isOwner) return json({ error: "Only the owner can cancel an order's commissions." }, 403);
        if (!isUuid(p.orderId)) return json({ error: "Invalid order." }, 400);
        const { data: rows } = await admin.from("commission_entries").select("*").eq("client_id", clientId).eq("order_id", p.orderId).eq("kind", "commission");
        if (!rows || !rows.length) return json({ error: "That order has no commission to cancel." }, 404);
        const { data: st } = await admin.from("commission_settings").select("clawback_on_cancel, payout_frequency, custom_days, period_anchor").eq("client_id", clientId).maybeSingle();
        const clawEnabled = st?.clawback_on_cancel !== false;
        const today = new Date().toISOString().slice(0, 10);
        const period = periodKey(today, st?.payout_frequency || "biweekly", st?.period_anchor || today, st?.custom_days ?? null);
        const now = new Date().toISOString();
        let clawed = 0, excluded = 0;
        for (const e of rows) {
          if (e.status === "paid") {
            if (!clawEnabled) continue;   // owner chose not to claw back already-paid commissions
            if ((await admin.from("commission_entries").select("id").eq("client_id", clientId).eq("clawback_of", e.id).maybeSingle()).data) continue; // already clawed
            await admin.from("commission_entries").insert({
              client_id: clientId, order_id: e.order_id, earner_user_id: e.earner_user_id,
              base_cents: e.base_cents != null ? -e.base_cents : null, rate_percent: e.rate_percent, split_share: e.split_share,
              amount_cents: e.amount_cents != null ? -e.amount_cents : null,
              earned_on: today, period_key: period.key, kind: "clawback", status: "pending", is_override: true,
              clawback_of: e.id, note: "Order cancelled", updated_at: now,
            });
            clawed++;
          } else if (e.status !== "excluded") {
            await admin.from("commission_entries").update({ status: "excluded", is_override: true, updated_at: now }).eq("client_id", clientId).eq("id", e.id);
            excluded++;
          }
        }
        await audit(`cancel_order ${p.orderId} (clawed ${clawed}, excluded ${excluded})`);
        return json({ ok: true, clawed, excluded, clawbackDisabled: !clawEnabled });
      }

      // ── approve a period: its pending lines become "payable" — the review gate before paying (OWNER) ──
      case "approve_period": {
        if (!isOwner) return json({ error: "Only the owner can approve commissions." }, 403);
        if (!p.periodKey) return json({ error: "No period specified." }, 400);
        const stamp = new Date().toISOString();
        const approved = ((await admin.from("commission_entries")
          .update({ status: "payable", approved_at: stamp, updated_at: stamp })
          .eq("client_id", clientId).eq("period_key", String(p.periodKey)).eq("status", "pending").not("amount_cents", "is", null)
          .select("id")).data || []).length;
        await audit(`approve_period ${p.periodKey} (${approved})`);
        return json({ ok: true, approved });
      }

      // ── pull an approved period back to pending (only while still unpaid) (OWNER) ──
      case "unapprove_period": {
        if (!isOwner) return json({ error: "Only the owner can change approvals." }, 403);
        if (!p.periodKey) return json({ error: "No period specified." }, 400);
        const stamp = new Date().toISOString();
        const reverted = ((await admin.from("commission_entries")
          .update({ status: "pending", approved_at: null, updated_at: stamp })
          .eq("client_id", clientId).eq("period_key", String(p.periodKey)).eq("status", "payable")
          .select("id")).data || []).length;
        await audit(`unapprove_period ${p.periodKey} (${reverted})`);
        return json({ ok: true, reverted });
      }

      // ── mark a period (or specific entries) paid — OWNER ONLY. Pays only APPROVED (payable) lines. ──
      case "mark_paid": {
        if (!isOwner) return json({ error: "Only the owner can mark commissions paid." }, 403);
        const stamp = new Date().toISOString();
        let q = admin.from("commission_entries")
          .update({ status: "paid", paid_at: stamp, paid_batch: stamp, updated_at: stamp })
          .eq("client_id", clientId).eq("status", "payable").not("amount_cents", "is", null);
        if (Array.isArray(p.entryIds) && p.entryIds.length) q = q.in("id", p.entryIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n)));
        else if (p.periodKey) q = q.eq("period_key", String(p.periodKey));
        else return json({ error: "Nothing specified to mark paid." }, 400);
        const paid = ((await q.select("id")).data || []).length;
        await audit(`mark_paid ${paid} entries`);
        return json({ ok: true, paid });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Commission request failed." }, 400);
  }
}));
