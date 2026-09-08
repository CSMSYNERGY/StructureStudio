// Dual-credential gate for the two ADMIN_PASSWORD functions (admin-catalog,
// admin-save-settings): accept EITHER a valid operator JWT OR the shared password.
//
// WHY: admin.html is being embedded in portal.html as an operator-only Admin tab. Both
// pages create their Supabase client the same way on the same origin, so the framed
// console already carries the operator's session — meaning we can authorize it by
// identity and stop asking an already-signed-in operator for a second, shared secret.
//
// checkAdminPassword itself is deliberately NOT modified. Its header states the property
// the whole throttle design rests on — admin-catalog and admin-save-settings share one
// secret, so throttling only one leaves the other as a free guessing oracle — and that
// sentence must stay literally true. This module wraps it instead.
//
// The ordering below is the load-bearing part:
//
//   no Authorization header            -> password path (unchanged)
//   header, but no resolvable user     -> password path (unchanged)  ← the anon-key case
//   header, user IS in app_operators   -> authorized; password never compared
//   header, user NOT in app_operators  -> HARD 403; never falls through
//
// That last line is the one that matters. Falling through would let anyone holding ANY
// tenant login pair their JWT with {adminPassword: guess} and probe the shared secret —
// exactly the oracle adminGate exists to prevent. Hard-failing keeps the password path
// reachable only by the same population as before: callers with no resolvable user.
//
// The anon-key case is what preserves today's behaviour end to end: admin.html sends the
// anon key as its Authorization header, /auth/v1/user rejects it (a valid JWT with no
// `sub`), so it lands in the password path with the same throttling, delay and audit as
// it has always had.

// deno-lint-ignore-file no-explicit-any

import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkAdminPassword, type GateOutcome } from "./adminGate.ts";

export type AdminIdentity =
  // `canWrite` mirrors app_operators.can_write (migration 056, default FALSE). It is
  // reported here rather than enforced here, because only the caller knows whether the
  // action it is about to run reads or writes.
  | { via: "operator"; userId: string; email: string; canWrite: boolean; canBill: boolean }
  // The password path has no operator row and therefore no per-operator rights. Callers
  // MUST gate on `via === "operator"` before consulting canWrite — reading it off this
  // variant yields undefined, and a naive `if (!identity.canWrite) 403` would lock the
  // break-glass console out of every write while claiming the account is read-only.
  | { via: "password" };

export type AdminAuthOutcome =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; status: number; body: Record<string, unknown> };

async function auditNote(admin: any, action: string, note: string) {
  try { await admin.from("admin_audit").insert({ action, note }); } catch (_e) { /* best-effort */ }
}

/**
 * Authorize an admin-console call by operator identity or by the shared password.
 * `admin` must be a service-role client (the operator roster and the throttle ledger are
 * both service-role-only).
 */
export async function checkAdminAuth(
  req: Request,
  suppliedPassword: unknown,
  admin: any,
  attemptedAction = "",
): Promise<AdminAuthOutcome> {
  const authHeader = req.headers.get("Authorization") || "";

  if (authHeader) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;

    if (user) {
      // Service role: app_operators has RLS on with zero policies and revokes anon +
      // authenticated, so a user-JWT client sees no rows for anyone.
      const { data: op, error: opErr } = await admin
        .from("app_operators")
        // can_write / can_bill were added by migration 056 with default FALSE, and were
        // NOT selected here until 2026-07-30 — so every JWT-authorized operator could
        // perform every catalog write regardless. It went unnoticed because the console
        // was iframed behind the shared password, which incidentally gated the same
        // actions; bringing Admin in natively removes that accident, so the real check
        // has to exist. `_shared/resolveTenant.ts:197` has always selected all four.
        .select("user_id, email, can_write, can_bill, support_only")
        .eq("user_id", user.id)
        .maybeSingle();
      if (opErr) return { ok: false, status: 500, body: { error: opErr.message } };

      // ⛔ A SUPPORT OPERATOR IS NOT AN ADMIN, AND THIS CONSOLE IS NOT THEIRS (migration 176).
      // support_only exists so somebody answering a builder's question sees that builder's
      // portal the way its OWNER does. This console is the opposite of that: it is
      // cross-tenant and it is ours — `delete_client` lives here, so do `set_billing`,
      // `wallet_credit` and `get_billing_overview`, which reads every tenant's revenue.
      // Nothing in "mirror the owner" grants any of it.
      //
      // ENFORCED HERE RATHER THAN IN THE BROWSER, and that distinction is the whole point.
      // 12-shell hides the Admin tab and ssClampTab refuses the route for a support account,
      // but this repo has written the lesson down more than once: the UI hiding a tab is a
      // COURTESY, NOT A CONTROL (portal-commissions' 403 carries the same note). The function
      // is directly callable with nothing but a session, so the refusal has to live at the
      // gate. Audited like the non-operator case below, because a support account reaching
      // for the admin console is worth being able to see after the fact.
      //
      // The PASSWORD path is deliberately untouched: it is the break-glass route and carries
      // no operator row at all. A support operator is not expected to hold ADMIN_PASSWORD.
      if (op && op.support_only) {
        await auditNote(
          admin,
          "admin_auth_support_operator_denied",
          `user=${op.email || user.email || user.id} action=${attemptedAction}`,
        );
        return { ok: false, status: 403, body: { error: "Operator access required." } };
      }

      if (op) {
        return {
          ok: true,
          identity: {
            via: "operator",
            userId: user.id,
            email: op.email || user.email || "",
            canWrite: Boolean(op.can_write),
            canBill: Boolean(op.can_bill),
          },
        };
      }

      // A real, signed-in, NON-operator user. Do not fall through to the password path.
      await auditNote(
        admin,
        "admin_auth_nonoperator_jwt",
        `user=${user.email || user.id} action=${attemptedAction}`,
      );
      return { ok: false, status: 403, body: { error: "Operator access required." } };
    }
  }

  const gate: GateOutcome = await checkAdminPassword(req, suppliedPassword, admin, attemptedAction);
  if (!gate.ok) return gate;
  return { ok: true, identity: { via: "password" } };
}
