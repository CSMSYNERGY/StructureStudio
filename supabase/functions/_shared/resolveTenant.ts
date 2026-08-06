// Shared tenant resolution for the three JWT-authenticated portal functions
// (portal-settings, portal-billing, sync-design-status).
//
// WHY THIS EXISTS: each of those functions used to resolve the tenant from the CALLER's
// own client_users row and never from the body — correct for an owner, but it meant an
// operator viewing another tenant in the portal silently read and WROTE their own tenant
// under a banner naming someone else. This module adds one controlled override:
//
//     targetClientId in the body + caller is in app_operators  ->  act as that tenant
//
// It is deliberately ONE module rather than the same twenty lines pasted three times.
// The three gates had already drifted apart (sync-design-status selected no `role`,
// portal-billing worded its 403 differently), and this repo has a live example of where
// that ends: importPricingRows exists twice (admin-catalog + portal-settings) and the
// copies have already diverged. One gate = one place to review, one place to fix.
//
// Shape follows _shared/adminGate.ts: return {ok:false,status,body} rather than a
// Response, so each function keeps its own CORS headers.

// Same specifier every function in this project uses — mixing jsr: and esm.sh would
// bundle two copies of supabase-js into each function.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  canEdit,
  canRead,
  checkGate,
  effectiveAccess,
  type Gate,
  gateIsRead,
  type GateTable,
  type Level,
} from "./access.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export type OperatorCtx = {
  userId: string;
  email: string;
  canWrite: boolean;
  canBill: boolean;
};

export type TenantCtx = {
  /** The tenant to act on. Already validated to exist in client_configs. */
  clientId: string;
  /** "owner" | "admin" | "user" for a normal caller; "operator" in operator mode. */
  role: string;
  /** The signed-in caller's own id/email — the human, NOT the tenant being acted on. */
  userId: string;
  userEmail: string;
  /** Non-null only when acting on ANOTHER tenant via the operator override. */
  operator: OperatorCtx | null;
  /**
   * This caller's RESOLVED per-area access (migration 100): the title's preset with their
   * stored overrides applied. Owners resolve to full edit and operators in view-as are
   * treated the same — an operator's rights come from app_operators, not from a
   * client_users row they do not have.
   *
   * `access` is the raw map; prefer the two helpers, and prefer failing closed:
   * an action with NO access check is an action anyone signed in can call.
   */
  access: Record<string, Level>;
  canRead: (area: string) => boolean;
  canEdit: (area: string) => boolean;
  /** Parsed request body — the resolver owns the single parse. */
  // deno-lint-ignore no-explicit-any
  payload: any;
  action: string;
  /** Best-effort audit: never blocks the request. Use for reads. */
  audit: (action: string, rowCount?: number | null, note?: string | null) => Promise<void>;
  /**
   * Audit that THROWS if it cannot record. Use immediately before an irreversible
   * external side effect (a card charge, a GHL invoice convert): if we cannot record
   * who did it, we must not do it.
   */
  auditStrict: (action: string, rowCount?: number | null, note?: string | null) => Promise<void>;
};

export type Resolved =
  | { ok: true; ctx: TenantCtx }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Slug shape + must exist in client_configs. Lifted verbatim from
 * operator-portal/index.ts (twin of admin-catalog's assertClient).
 *
 * Runs BEFORE any storage path is built from the slug, which is what stops a
 * traversal-shaped value reaching e.g. portal-settings' `${clientId}/logo.png`.
 */
export async function assertClient(admin: Admin, raw: unknown): Promise<string> {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v || !/^[a-z0-9][a-z0-9-]*$/.test(v)) throw new Error("Invalid clientId.");
  const { data, error } = await admin.from("client_configs").select("client_id").eq("client_id", v).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown builder "${v}".`);
  return v;
}

function makeAudit(admin: Admin, actor: { userId: string; email: string } | null, targetClientId: string) {
  return async (action: string, rowCount: number | null = null, note: string | null = null, strict = false) => {
    const row = {
      action,
      target_client_id: targetClientId,
      row_count: rowCount,
      actor_email: actor?.email ?? null,
      actor_user_id: actor?.userId ?? null,
      note,
    };
    const { error } = await admin.from("admin_audit").insert(row);
    if (error && strict) throw new Error(`Could not record this action for audit: ${error.message}`);
  };
}

/**
 * Resolve which tenant this request acts on, and whether the caller may write to it.
 *
 * Gate ORDER is load-bearing:
 *   1. auth.getUser() first. The bare anon key is a valid JWT with no `sub`, so it dies
 *      here — BEFORE targetClientId is ever read. That is the primary defence, not the
 *      operator lookup below.
 *   2. Parse the body (here, not in the caller) so a malformed body from an
 *      unauthenticated caller still 401s rather than 400s — preserving today's precedence.
 *   3. Own-tenant mapping, then the operator override.
 */
export async function resolveTenant(
  req: Request,
  admin: Admin,
  opts: {
    /**
     * The function's action → required-access table (migration 100). When supplied it is
     * THE gate: it decides read-vs-write for the operator capability check, it enforces
     * per-area access, and an action missing from it is refused outright.
     *
     * It also SUPERSEDES readActions/selfActions/staffActions — passing both is a
     * contradiction, and the legacy role gate is skipped when gates are present. Two
     * models would mean a crew leader granted build_schedule:'edit' passing canEdit() and
     * then being 403'd anyway by role !== 'owner'|'admin', which is the whole per-person
     * feature quietly not working.
     */
    gates?: GateTable;
    /** Legacy coarse gate. Only consulted when `gates` is absent. */
    readActions: Set<string>;
    defaultAction?: string;
    requireBilling?: boolean;
    /**
     * Actions ANY authenticated tenant user may perform because they touch only their OWN
     * row — self-service, e.g. editing your own name and phone. Deliberately separate from
     * readActions: these are writes, and calling them "reads" to slip them past the
     * owner/admin gate would make this security check lie about what it permits. The
     * HANDLER is still responsible for scoping the write to ctx.userId.
     */
    selfActions?: Set<string>;
    /**
     * Writes ANY linked account may make because they are part of doing the job the
     * portal already lets every role do — not settings changes. Deliberately a THIRD
     * category rather than stuffing them into readActions: calling a write a "read"
     * would make this gate misdescribe what it permits (the same reasoning as
     * selfActions), and these are not self-scoped either.
     *
     * Motivating case (2026-08-02): a role-"user" salesperson can open Inventory and
     * send a customer an estimate on a lot building — save_design and submit-estimate
     * are both anon-callable, so the quote goes out — but the follow-up
     * link_design_to_unit was owner/admin-gated, so it 403'd and the estimate was never
     * tied to its building. The unit then showed no estimates and never flipped to Sold
     * when that customer accepted. The HANDLER still scopes every such write to the
     * resolved tenant; this only says "role does not decide it".
     */
    staffActions?: Set<string>;
  },
): Promise<Resolved> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // 1. Real user check (the bare anon key passes the gateway but has no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return { ok: false, status: 401, body: { error: "Not signed in." } };

  // 2. Body.
  // deno-lint-ignore no-explicit-any
  let payload: any;
  try { payload = await req.json(); }
  catch { return { ok: false, status: 400, body: { error: "Invalid JSON" } }; }
  const action = String(payload?.action || opts.defaultAction || "status");
  // The gate table, when present, is the authority on everything below — including whether
  // this is a read, which a read-only operator's capability check depends on.
  const gated = !!opts.gates;
  const gate: Gate | undefined = opts.gates?.[action];
  if (gated && !gate) {
    // FAIL CLOSED. Reached only by a typo'd action or by a new branch whose author did not
    // add a gate — and the second one is the case worth protecting: without this, a new
    // action is callable by every signed-in person in the company by default.
    return { ok: false, status: 403, body: { error: `Unrecognised action "${action}".` } };
  }
  const isRead = gated ? gateIsRead(gate) : opts.readActions.has(action);
  // A self-service write is allowed for any role, but ONLY on the caller's own row —
  // enforced by the handler, which must key off ctx.userId and never a body-supplied id.
  const isSelf = Boolean(opts.selfActions?.has(action));
  const isStaff = Boolean(opts.staffActions?.has(action));

  // 3. The caller's own tenant. Service role: client_users has no browser policies and
  //    this lookup must not depend on the caller's own claims.
  //    limit(1) not maybeSingle(): maybeSingle() ERRORS when a duplicate client_users row
  //    exists, which would lock the user out entirely. portal.html already guards this
  //    the same way (its "audit #F6" comment); these functions did not.
  const { data: mapRows, error: mapErr } = await admin
    .from("client_users")
    .select("client_id, role, title, access")
    .eq("user_id", user.id)
    .limit(1);
  if (mapErr) return { ok: false, status: 500, body: { error: mapErr.message } };
  const mapping = mapRows && mapRows[0];

  const rawTarget = payload?.targetClientId;
  const wantsOverride =
    rawTarget !== undefined &&
    rawTarget !== null &&
    rawTarget !== "" &&
    !(mapping && String(rawTarget) === String(mapping.client_id)); // own slug = harmless no-op

  // ── Normal path: unchanged behaviour ─────────────────────────────────────────
  if (!wantsOverride) {
    if (!mapping) return { ok: false, status: 403, body: { error: "No business is linked to this account." } };
    // Resolved once per request from the row we already fetched — no extra round trip.
    const acc = effectiveAccess(mapping.role, mapping.title, mapping.access);

    if (gated) {
      // Per-area gate. Owners short-circuit to full access inside effectiveAccess, so an
      // owner can never be locked out of their own account by a bad table entry here.
      const denied = checkGate(gate, acc);
      if (denied) return { ok: false, status: 403, body: { error: denied } };
    } else if (!isRead && !isSelf && !isStaff && mapping.role !== "owner" && mapping.role !== "admin") {
      return {
        ok: false,
        status: 403,
        body: { error: "Your account can view designs and leads but not change settings. Ask an owner or admin." },
      };
    }
    const a = makeAudit(admin, { userId: user.id, email: user.email ?? "" }, mapping.client_id);
    return {
      ok: true,
      ctx: {
        clientId: mapping.client_id,
        role: mapping.role || "user",
        userId: user.id,
        userEmail: user.email ?? "",
        operator: null,
        access: acc,
        canRead: (area: string) => canRead(acc, area),
        canEdit: (area: string) => canEdit(acc, area),
        payload,
        action,
        audit: (act, n = null, note = null) => a(act, n, note, false).catch(() => {}),
        auditStrict: (act, n = null, note = null) => a(act, n, note, true),
      },
    };
  }

  // ── Operator override ────────────────────────────────────────────────────────
  // MUST be a service-role read: app_operators has RLS on with ZERO policies and
  // `revoke all from anon, authenticated` (051_operators.sql), so a user-JWT client
  // returns no rows for EVERYONE and would silently deny every operator.
  const { data: op, error: opErr } = await admin
    .from("app_operators")
    .select("user_id, email, can_write, can_bill")
    .eq("user_id", user.id)
    .maybeSingle();
  if (opErr) return { ok: false, status: 500, body: { error: opErr.message } };

  // Deliberately a hard 403 rather than "ignore the field and serve your own tenant".
  // A body field honoured for some callers and silently dropped for others is what a
  // later refactor turns into a cross-tenant hole — and silent-ignore would make the
  // negative test pass for the wrong reason (200-with-own-data instead of 403).
  if (!op) return { ok: false, status: 403, body: { error: "Operator access required." } };

  let clientId: string;
  try {
    clientId = await assertClient(admin, rawTarget);
  } catch (e) {
    return { ok: false, status: 400, body: { error: (e as Error).message } };
  }

  // Capability gates. Note these consult app_operators ONLY — never the operator's own
  // client_users role, which is routinely "user" and says nothing about their platform
  // rights. Two separate paths, keyed solely on whether a target was supplied.
  if (!isRead && !op.can_write) {
    return { ok: false, status: 403, body: { error: "This operator account is read-only." } };
  }
  if (opts.requireBilling && !op.can_bill) {
    return { ok: false, status: 403, body: { error: "This operator account cannot change billing." } };
  }

  const actor = { userId: user.id, email: op.email || user.email || "" };
  const a = makeAudit(admin, actor, clientId);
  // An operator in view-as has NO client_users row on the viewed tenant, so there is no
  // title or override map to resolve. Their rights come from app_operators and were already
  // enforced above (can_write / can_bill); per-area access is therefore full, and the
  // read-only operator is still blocked by the can_write gate rather than by this map.
  const opAcc = effectiveAccess("owner", "owner", null);
  return {
    ok: true,
    ctx: {
      clientId,
      role: "operator",
      userId: user.id,
      userEmail: user.email ?? "",
      operator: { userId: actor.userId, email: actor.email, canWrite: !!op.can_write, canBill: !!op.can_bill },
      access: opAcc,
      canRead: () => true,
      canEdit: () => !!op.can_write,
      payload,
      action,
      audit: (act, n = null, note = null) => a(act, n, note, false).catch(() => {}),
      auditStrict: (act, n = null, note = null) => a(act, n, note, true),
    },
  };
}
