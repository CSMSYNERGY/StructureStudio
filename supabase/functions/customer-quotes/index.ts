import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { estimateUrl } from "../_shared/ghlLinks.ts";

// customer-quotes: the authenticated quote list for the CUSTOMER portal (the shed
// shopper's own view, not the tenant owner's). The caller presents the opaque bearer
// token minted by customer-auth after Twilio Verify approved their phone OTP
// (migration 108); identity — tenant + verified phone — comes entirely from that
// session row, never from the request body.
//
// This function serves ONE action, `list`. Logout is deliberately NOT here:
// customer-auth minted the session, so customer-auth revokes it — one owner for the
// session lifecycle.
//
// Everything here is read-only and the projection is deliberately NARROW — see the
// mapping below for why.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Same posture as portal-settings' dbFail: the browser gets an authored sentence, the
// raw Postgres message (which can carry row values) goes to app_errors only.
// deno-lint-ignore no-explicit-any
function dbFail(req: Request, clientId: string | null, where: string, err: any) {
  logEdgeError({
    fn: "customer-quotes",
    req,
    clientId,
    code: err?.code ?? 500,
    message: `${where}: ${err?.message ?? "unknown database error"}`,
    context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
  }).catch(() => {});
  return json({ error: "Couldn't load your quotes. Please try again in a moment." }, 500);
}

const round2 = (n: number) => Math.round(n * 100) / 100; // same as estimatePdf.ts / qboInvoice.ts

/** The customer-facing status ladder. Anything else (null, a future internal state)
 *  renders as "sent" — the safe floor — rather than leaking internal vocabulary. */
const CUSTOMER_STATUSES = new Set(["sent", "accepted", "invoiced", "delivered"]);

/**
 * Total from the designs.estimate_lines snapshot — submit-estimate step 11's shape:
 *   { version, discount, lines: [{ kind, itemKey, name, desc, qty, amount, nonTaxable }] }
 * `amount` is the UNIT price; a line's total is qty * amount. The math mirrors
 * _shared/estimatePdf.ts (round each line total, sum, subtract a positive discount,
 * round 2dp) so the number shown here always agrees with the PDF and the books.
 * Returns null when there is no snapshot — older designs predate it, and null renders
 * honestly as "—" instead of a fabricated $0.00.
 */
// deno-lint-ignore no-explicit-any
function totalFromSnapshot(snap: any): number | null {
  if (!snap || !Array.isArray(snap.lines)) return null;
  let subtotal = 0;
  for (const li of snap.lines) {
    const qty = Number(li?.qty) || 0;
    const unit = Number(li?.amount) || 0;
    subtotal += round2(qty * unit);
  }
  subtotal = round2(subtotal);
  const discount = Number(snap.discount) || 0;
  if (discount > 0) subtotal = round2(subtotal - discount);
  return subtotal;
}

Deno.serve(withErrorLog("customer-quotes", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = typeof body?.action === "string" ? body.action : "";
  // Logout belongs to customer-auth (it owns the session lifecycle) — not an action here.
  if (action !== "list") return json({ error: "Unknown action" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // The session IS the identity: tenant + phone were proven by the OTP check that minted
  // it. checkSession never throws; null covers absent, garbage, expired and revoked alike.
  const identity = await checkSession(admin, body?.token);
  if (!identity) return json({ error: "Session expired — sign in again." }, 401);

  // White-label header: the tenant's business name, falling back to their portal config's
  // company name (same pair portal-settings reads — business_name is the customer-facing
  // one, company_name the config row's label). Both nullable; the frontend has its own
  // last-resort fallback.
  const [settingsRes, cfgRes] = await Promise.all([
    admin.from("client_settings").select("business_name").eq("client_id", identity.clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", identity.clientId).maybeSingle(),
  ]);
  if (settingsRes.error) return dbFail(req, identity.clientId, "read business settings", settingsRes.error);
  if (cfgRes.error) return dbFail(req, identity.clientId, "read tenant config", cfgRes.error);
  const businessName = settingsRes.data?.business_name || cfgRes.data?.company_name || null;

  // Tenant-wide select, phone match applied IN CODE below. PostgREST cannot filter on the
  // regexp_replace expression the phone comparison needs (contact->>'phone' is a formatted
  // display string, so both sides must normalize to digits), and a tenant-wide read matches
  // existing practice — portal.html loads all tenant designs the same way. Migration 108's
  // expression index (designs_client_phone_digits_idx) serves future SQL paths that can
  // state the expression; this path pays one tenant scan instead.
  const { data: rows, error: designsErr } = await admin
    .from("designs")
    .select("short_code, created_at, status, contact, selections, ghl_estimate_number, ghl_estimate_id, image_url, estimate_lines")
    .eq("client_id", identity.clientId)
    .order("created_at", { ascending: false }); // newest first
  if (designsErr) return dbFail(req, identity.clientId, "load quotes", designsErr);

  const quotes = (rows ?? [])
    .filter((d) => {
      // The verified phone is the identity — only this customer's designs.
      const phone = String(d?.contact?.phone ?? "").replace(/\D/g, "");
      if (!phone || phone !== identity.phoneDigits) return false;
      // 'inventory' is the tenant's own spec-build master designs — internal stock, never
      // something this customer asked for. 'draft' is a silent capture the visitor never
      // knowingly created (saveDraftSilently fires when they open quote Details) — showing
      // one would present a "quote" they never requested.
      if (d?.status === "inventory" || d?.status === "draft") return false;
      return true;
    })
    // NARROW projection — the migration-048 lesson (a phone number once bridged to full
    // contact PII, and 048's fix was to stop returning it). Never echo `contact` back:
    // the caller already knows their own phone, and a leaked/stolen session token must
    // not yield address or email on top of the quote list. Only what the list screen
    // renders leaves this function.
    .map((d) => ({
      estimateNumber: d.ghl_estimate_number != null && d.ghl_estimate_number !== ""
        ? `EST-${d.ghl_estimate_number}` : null,
      style: d?.selections?.style ?? null,
      size: d?.selections?.size ?? null,
      status: CUSTOMER_STATUSES.has(String(d?.status)) ? String(d.status) : "sent",
      createdAt: d.created_at,
      total: totalFromSnapshot(d?.estimate_lines),
      pdfUrl: d.image_url || null,
      // GHL's hosted estimate page (Accept/Reject live there); null-safe when no estimate.
      acceptUrl: estimateUrl(d.ghl_estimate_id),
    }));

  return json({ ok: true, businessName, name: identity.name, quotes });
}));
