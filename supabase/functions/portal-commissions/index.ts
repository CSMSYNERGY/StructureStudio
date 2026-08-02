import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { AUTH_PORTAL_URL } from "../_shared/authPortalUrl.ts";

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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
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
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: me, error: meErr } = await admin
    .from("client_users").select("client_id, role").eq("user_id", user.id).maybeSingle();
  if (meErr) return json({ error: meErr.message }, 500);
  if (!me?.client_id) return json({ error: "Your login isn't attached to an account." }, 403);
  const clientId: string = me.client_id;
  const role: string = me.role || "user";
  const isOwner = role === "owner";
  const isAdmin = role === "owner" || role === "admin";

  // The caller's own full_access grant (owner always sees rates regardless).
  const { data: myCm } = await admin
    .from("commission_members").select("full_access").eq("client_id", clientId).eq("user_id", user.id).maybeSingle();
  const canSeeRates = isOwner || myCm?.full_access === true;

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = p?.action;

  const audit = async (note: string) => {
    try { await admin.from("admin_audit").insert({ action: "commissions", target_client_id: clientId, row_count: null, note: `tenant:${user.email || user.id} ${note}`.trim() }); }
    catch { /* best-effort */ }
  };
  // Confirm a userId is a member of THIS tenant before any write touches them.
  const requireMember = async (uid: unknown) => {
    if (!isUuid(uid)) throw new Error("Invalid user id.");
    const { data, error } = await admin.from("client_users").select("user_id, role").eq("client_id", clientId).eq("user_id", uid).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("That person isn't on your team.");
    return data as { user_id: string; role: string };
  };

  try {
    switch (action) {
      // ── list the team (rates only if the caller may see them; grants only for the owner) ──
      case "list": {
        if (!isAdmin) return json({ error: "Only an owner or admin can manage the team." }, 403);
        const { data: rows, error } = await admin
          .from("client_users").select("user_id, role, full_name, created_at").eq("client_id", clientId).order("created_at");
        if (error) throw error;
        const { data: cms } = await admin
          .from("commission_members").select("user_id, commission_percent, sees_all_payouts, full_access").eq("client_id", clientId);
        const cmById = new Map((cms || []).map((c: any) => [c.user_id, c]));
        const members = [];
        for (const r of rows || []) {
          const uid = (r as any).user_id;
          let email = "";
          try { const { data: au } = await admin.auth.admin.getUserById(uid); email = au?.user?.email || ""; } catch { /* one missing auth user must not break the list */ }
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
          });
        }
        return json({ ok: true, clientId, role, canSeeRates, isOwner, members });
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
        if (!isAdmin) return json({ error: "Only an owner or admin can add people." }, 403);
        const email = String(p.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
        // An admin can only add plain users; only the owner can mint admins/owners.
        let wantRole = ["owner", "admin", "user"].includes(String(p.role || "").toLowerCase()) ? String(p.role).toLowerCase() : "user";
        if (!isOwner && wantRole !== "user") wantRole = "user";
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
        // Never silently re-home a login already attached to a DIFFERENT tenant.
        const existing = await admin.from("client_users").select("client_id, role").eq("user_id", au.id).maybeSingle();
        if (existing.error) throw existing.error;
        if (existing.data && existing.data.client_id && existing.data.client_id !== clientId) {
          return json({ error: `"${email}" already belongs to another account and can't be added here.` }, 409);
        }
        if (existing.data && existing.data.client_id === clientId) {
          // Already on this team — update name only, never silently change their role here.
          if (fullName) await admin.from("client_users").update({ full_name: fullName }).eq("user_id", au.id);
          await admin.from("commission_members").upsert({ client_id: clientId, user_id: au.id }, { onConflict: "client_id,user_id", ignoreDuplicates: true });
          return json({ ok: true, userId: au.id, email, alreadyOnTeam: true });
        }
        const link = await admin.from("client_users").upsert(
          { user_id: au.id, client_id: clientId, role: wantRole, ...(fullName ? { full_name: fullName } : {}) }, { onConflict: "user_id" });
        if (link.error) throw link.error;
        // Seed a commission_members row so the person shows up on the team with a blank rate.
        await admin.from("commission_members").upsert({ client_id: clientId, user_id: au.id }, { onConflict: "client_id,user_id", ignoreDuplicates: true });

        let setupLink: string | null = null;
        try { const gl = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: AUTH_PORTAL_URL } }); if (!gl.error) setupLink = gl.data?.properties?.action_link || null; } catch { /* best-effort */ }
        await audit(`add_user ${email} as ${wantRole}`);
        return json({ ok: true, userId: au.id, email, role: wantRole, created, emailSent, setupLink });
      }

      // ── remove a teammate: unlink from this tenant, or fully deactivate the login ──
      case "remove_user": {
        if (!isAdmin) return json({ error: "Only an owner or admin can remove people." }, 403);
        const target = await requireMember(p.userId);
        const mode = p.mode === "deactivate" ? "deactivate" : "unlink";
        if (p.userId === user.id) return json({ error: "You can't remove yourself." }, 400);
        // Owners are protected here — moving/removing an owner belongs to the operator console.
        if (target.role === "owner") return json({ error: "Owners can't be removed here." }, 403);
        // An admin can only remove plain users, not other admins.
        if (!isOwner && target.role !== "user") return json({ error: "Only the owner can remove an admin." }, 403);

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
      // Reconciles commission_entries against current orders WITHOUT disturbing rows the owner
      // has finalized (status='paid') or hand-edited (is_override). The pre-tax base is filled
      // best-effort from the GHL estimate subtotal; if GHL is unreachable the entry is still
      // created with a null base/amount so the order shows on the report to be resolved.
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
          if (ex.some((e) => e.status === "paid" || e.is_override)) continue;   // finalized — never auto-touch
          const autoRow = ex.find((e) => !e.is_override && e.status !== "paid");
          const rowData: any = {
            client_id: clientId, order_id: o.id, earner_user_id: earner,
            base_cents: baseCents, rate_percent: rate, amount_cents: amount,
            earned_on: earnedDate, period_key: period?.key ?? null, kind: "commission", updated_at: new Date().toISOString(),
          };
          if (autoRow) { await admin.from("commission_entries").update(rowData).eq("id", autoRow.id); updated++; }
          else { await admin.from("commission_entries").insert({ ...rowData, status: "pending" }); computed++; }
        }

        if (p.debug && diag.length) {
          try { await admin.from("app_errors").insert({ source: "edge:portal-commissions", severity: "info", code: "compute_diag", message: "pretax diag", client_id: clientId, context: { diag: diag.slice(0, 25) } }); } catch { /* best-effort */ }
        }
        await audit(`compute (${computed} new, ${updated} updated)`);
        return json({ ok: true, orders: ords.length, computed, updated, ...(p.debug ? { diag } : {}) });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Commission request failed." }, 400);
  }
}));
