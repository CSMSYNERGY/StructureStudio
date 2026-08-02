import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { AUTH_PORTAL_URL } from "../_shared/authPortalUrl.ts";

// Operator account-switcher backend (portal.html "Accounts" tab): lets a platform
// operator (app_operators row — Carolyn / Ahsan / support) open any tenant's portal
// read-only, GHL-subaccounts style.
//
// Auth model (two layers, both server-side):
//   1. Real signed-in user via auth.getUser() — verify_jwt alone is NOT auth, the
//      bare anon key passes the gateway (same rule as portal-settings).
//   2. Operator membership via a service-role app_operators lookup. client_users is
//      irrelevant here — operators are cross-tenant by design.
// RLS can never yield another tenant's rows to a user JWT (current_client_id() is
// the policy anchor), so every cross-tenant read below is a service-role read that
// happens ONLY after both checks pass — never a faked session or weakened policy
// (same rule as admin-catalog's get_client_portal).
//
// Actions:
//   { action: "list_clients" }            → [{ clientId, companyName }] for the picker
//   { action: "get_portal", clientId }    → the tenant's designs + versions + name,
//     byte-compatible with what portal.html's DesignsTable/LeadsTable read for the
//     owner's own tenant. Every call is audit-logged to admin_audit (cross-tenant PII).
//   { action: "list_users", clientId }    → the people under one tenant
//   { action: "save_user", … }            → correct a user's name/phone
//   { action: "send_reset_link", clientId, userId } → email that user a set-password link
//     and hand back a copyable one. Write actions require app_operators.can_write.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Same shape as admin-catalog's assertClient: slug + must exist in client_configs.
// deno-lint-ignore no-explicit-any
async function assertClient(admin: any, raw: unknown): Promise<string> {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v || !/^[a-z0-9][a-z0-9-]*$/.test(v)) throw new Error("Invalid clientId.");
  const { data, error } = await admin.from("client_configs").select("client_id").eq("client_id", v).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown builder "${v}".`);
  return v;
}

Deno.serve(withErrorLog("operator-portal", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Real user check (the bare anon key passes the gateway but has no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // 2. Operator membership — service role (app_operators has no browser policies).
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: op, error: opErr } = await admin
    .from("app_operators")
    .select("user_id, email, can_write")   // can_write gates the write actions below
    .eq("user_id", user.id)
    .maybeSingle();
  if (opErr) return json({ error: opErr.message }, 500);
  if (!op) return json({ error: "Operator access required." }, 403);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = payload?.action;

  const audit = async (action: string, targetClientId: string | null, rowCount: number | null) => {
    try {
      await admin.from("admin_audit").insert({
        action,
        target_client_id: targetClientId,
        row_count: rowCount,
        note: `operator:${op.email || user.email || user.id}`,
      });
    } catch (_) { /* audit is best-effort — never block the view on a log failure */ }
  };

  // Writes get a DURABLE record: if we cannot log who changed a tenant's data, we don't change
  // it. Same reasoning as portal-billing's auditStrict — best-effort is right for a read, where
  // failing the request would block legitimate work, and wrong for a mutation.
  const auditStrict = async (action: string, targetClientId: string | null, note: string) => {
    const { error } = await admin.from("admin_audit").insert({
      action, target_client_id: targetClientId, row_count: null,
      note: `operator:${op.email || user.email || user.id} ${note}`.trim(),
    });
    if (error) throw new Error(`Could not record this change in the audit log: ${error.message}`);
  };

  try {
    switch (action) {
      case "list_clients": {
        const { data, error } = await admin
          .from("client_configs")
          .select("client_id, company_name")
          .order("client_id");
        if (error) throw error;
        // A COUNT per tenant, not the people. The Accounts list shows "3 users" on a collapsed
        // row and fetches the actual names/emails/phones only when one is expanded, so simply
        // opening the tab does not pull every user's personal details into the browser — and
        // each expansion is audit-logged against the tenant it belongs to.
        const { data: cu, error: cuErr } = await admin.from("client_users").select("client_id");
        if (cuErr) throw cuErr;
        const counts = new Map<string, number>();
        for (const r of cu || []) counts.set((r as any).client_id, (counts.get((r as any).client_id) || 0) + 1);
        await audit("operator_list_clients", null, (data || []).length);
        return json({
          ok: true,
          clients: (data || []).map((r: any) => ({
            clientId: r.client_id,
            companyName: r.company_name || r.client_id,
            userCount: counts.get(r.client_id) || 0,
          })),
        });
      }
      case "list_users": {
        // The people under ONE tenant. client_users holds no email, and its RLS lets a browser
        // read only its own row, so this has to be a service-role read joined to auth.users.
        const clientId = await assertClient(admin, payload.clientId);
        const { data: rows, error } = await admin
          .from("client_users")
          .select("user_id, role, full_name, phone, created_at")
          .eq("client_id", clientId)
          .order("created_at");
        if (error) throw error;
        // Operator status is cross-tenant (app_operators), NOT a role within this client — a
        // person can be an operator AND an owner here, so it is reported as a separate flag
        // rather than folded into `role`, which would misstate who they are.
        const { data: ops } = await admin.from("app_operators").select("user_id, can_write, can_bill");
        const opById = new Map((ops || []).map((o: any) => [o.user_id, o]));
        const users = [];
        for (const r of rows || []) {
          const uid = (r as any).user_id;
          // No bulk join to auth.users is available through the client, so fetch per user.
          // Tenants have single-digit user counts, so this stays a handful of calls.
          let email = "", lastSignInAt = null, emailConfirmed = false, invitedAt = null;
          try {
            const { data: au } = await admin.auth.admin.getUserById(uid);
            const u: any = au?.user;
            if (u) {
              email = u.email || "";
              lastSignInAt = u.last_sign_in_at || null;
              emailConfirmed = Boolean(u.email_confirmed_at);
              invitedAt = u.invited_at || null;
            }
          } catch { /* a missing auth user must not break the whole list */ }
          // NOT named `op` — that is the authenticated CALLER above, and shadowing it here is
          // how a future `if (!op.can_write)` inside this loop would end up checking the
          // listed user's rights instead of the caller's.
          const listedOp: any = opById.get(uid);
          users.push({
            userId: uid,
            email,
            fullName: (r as any).full_name || "",
            phone: (r as any).phone || "",
            role: (r as any).role || "user",
            isOperator: Boolean(listedOp),
            operatorCanWrite: Boolean(listedOp?.can_write),
            operatorCanBill: Boolean(listedOp?.can_bill),
            lastSignInAt, emailConfirmed, invitedAt,
            createdAt: (r as any).created_at,
          });
        }
        await audit("operator_list_users", clientId, users.length);
        return json({ ok: true, clientId, users });
      }
      case "save_user": {
        // Operator fills in / corrects a user's name and phone. Contact details only — role and
        // tenant are deliberately NOT editable here, because changing either grants or moves
        // access and belongs with the deliberate link_owner flow, not an inline edit.
        if (!op.can_write) return json({ error: "This operator account is read-only." }, 403);
        const clientId = await assertClient(admin, payload.clientId);
        const userId = String(payload.userId || "").trim();
        if (!userId) return json({ error: "userId is required." }, 400);
        const fullName = String(payload.fullName ?? "").trim().slice(0, 120);
        const phone = String(payload.phone ?? "").trim().slice(0, 40);
        // Scoped by BOTH ids: a userId from another tenant matches nothing rather than
        // being edited across the boundary.
        const { data: updated, error } = await admin.from("client_users")
          .update({ full_name: fullName || null, phone: phone || null })
          .eq("user_id", userId).eq("client_id", clientId)
          .select("user_id").maybeSingle();
        if (error) throw error;
        if (!updated) return json({ error: "That user is not in this account." }, 404);
        await auditStrict("operator_save_user", clientId, `user=${userId}`);
        return json({ ok: true });
      }
      case "send_reset_link": {
        // Email one of a tenant's users a set-password link. Carolyn asked for this on
        // 2026-07-29 ("Reset — reset password, all of that. Yes, absolutely."), and it earns its
        // keep: the invite/reset journey has broken twice in onboarding, both times over where
        // the link LANDS, which is why the destination is not a parameter — see AUTH_PORTAL_URL.
        if (!op.can_write) return json({ error: "This operator account is read-only." }, 403);
        const clientId = await assertClient(admin, payload.clientId);
        const userId = String(payload.userId || "").trim();
        if (!userId) return json({ error: "userId is required." }, 400);

        // Scoped by BOTH ids, same as save_user: the caller supplies a userId, and without the
        // client_id predicate an operator could send a reset for someone in another tenant just
        // by pasting their id. Membership is checked BEFORE we look the email up, so a
        // wrong-tenant id cannot even leak whether that user exists.
        const { data: member, error: memberErr } = await admin.from("client_users")
          .select("user_id").eq("user_id", userId).eq("client_id", clientId).maybeSingle();
        if (memberErr) throw memberErr;
        if (!member) return json({ error: "That user is not in this account." }, 404);

        // The email is auth's, not client_users' — deliberately read from the auth record rather
        // than accepted from the caller, so the link can only ever go to the address that
        // actually signs in.
        const { data: au, error: auErr } = await admin.auth.admin.getUserById(userId);
        if (auErr) throw auErr;
        const email = String(au?.user?.email || "").trim();
        if (!email) return json({ error: "That user has no email address on their login, so no reset can be sent." }, 400);

        // No custom-SMTP precondition here, unlike admin-catalog's `test_email`. That guard
        // exists to stop a *test* passing via Supabase's default sender and proving nothing —
        // applying it here would refuse a real reset the default sender would have delivered.
        const { error: sendErr } = await admin.auth.resetPasswordForEmail(email, { redirectTo: AUTH_PORTAL_URL });

        // A copyable link regardless, for the case that has actually bitten us: SMTP down or
        // unconfigured, so the email never arrives and the operator needs something to paste
        // into a chat. Best-effort — a missing link must not fail a reset that WAS emailed.
        let resetLink: string | null = null;
        try {
          const gl = await admin.auth.admin.generateLink({
            type: "recovery", email, options: { redirectTo: AUTH_PORTAL_URL },
          });
          if (!gl.error) resetLink = gl.data?.properties?.action_link || null;
        } catch (_) { /* link is best-effort */ }

        // Report the email failure only after the fallback link is in hand — otherwise an SMTP
        // outage would throw away the one thing that still works.
        if (sendErr && !resetLink) throw sendErr;

        await auditStrict("operator_send_reset_link", clientId, `user=${userId}`);
        return json({
          ok: true,
          email,
          emailSent: !sendErr,
          resetLink,
          // GoTrue rate-limits recovery per email per hour; a second click inside that window
          // fails at Supabase, not here, so say so rather than letting it look like our bug.
          note: sendErr
            ? `Could not send the email (${sendErr.message}) — use the link below instead.`
            : "Sent. Supabase limits reset emails to a few per address per hour; the link below works either way.",
        });
      }
      case "get_portal": {
        const clientId = await assertClient(admin, payload.clientId);
        // Same columns/shape as the owner portal's own reads (and as admin-catalog's
        // get_client_portal) so DesignsTable/LeadsTable render unchanged.
        const [designs, versions, cfg, leads] = await Promise.all([
          admin.from("designs")
            .select("short_code, created_at, updated_at, status, contact, selections, ghl_estimate_number, image_url")
            .eq("client_id", clientId).order("created_at", { ascending: false }),
          admin.from("design_versions")
            .select("short_code, version, created_at, selections, image_url")
            .eq("client_id", clientId).order("version", { ascending: false }),
          admin.from("client_configs").select("company_name").eq("client_id", clientId).maybeSingle(),
          // Browsing leads (migration 062) so the operator's view-as Contacts matches what
          // the tenant themselves sees. Additive: an error here must not break the portal.
          admin.from("captured_leads")
            .select("id, name, phone, phone_digits, email, source, created_at, updated_at")
            .eq("client_id", clientId).order("updated_at", { ascending: false }),
        ]);
        if (designs.error) throw designs.error;
        if (versions.error) throw versions.error;
        await audit("operator_get_portal", clientId, (designs.data || []).length);
        return json({
          ok: true, clientId,
          companyName: (cfg.data && (cfg.data as any).company_name) || clientId,
          designs: designs.data || [], versions: versions.data || [],
          capturedLeads: leads.error ? [] : (leads.data || []),
        });
      }
      default:
        return json({ error: `Unknown action "${action}".` }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Unexpected error" }, 400);
  }
}));
