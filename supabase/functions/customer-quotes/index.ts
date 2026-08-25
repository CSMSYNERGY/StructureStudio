import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { estimateUrl } from "../_shared/ghlLinks.ts";
import { totalFromSnapshot } from "../_shared/estimateLines.ts";

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

/** The customer-facing status ladder. Anything else (null, a future internal state)
 *  renders as "sent" — the safe floor — rather than leaking internal vocabulary. */
const CUSTOMER_STATUSES = new Set(["sent", "accepted", "invoiced", "delivered"]);

// totalFromSnapshot moved to _shared/estimateLines.ts (2026-08-23): the acceptance record
// and the SS invoice snapshot the same number, and four copies of money math is how the
// customer's screen and the books learn to disagree.

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
    admin.from("client_settings").select("business_name, invoice_in_ghl").eq("client_id", identity.clientId).maybeSingle(),
    admin.from("client_configs").select("company_name").eq("client_id", identity.clientId).maybeSingle(),
  ]);
  if (settingsRes.error) return dbFail(req, identity.clientId, "read business settings", settingsRes.error);
  if (cfgRes.error) return dbFail(req, identity.clientId, "read tenant config", cfgRes.error);
  const businessName = settingsRes.data?.business_name || cfgRes.data?.company_name || null;
  // SS mode (migration 121): this tenant's paperwork is StructureStudio-issued, so the
  // customer accepts (and SIGNS, migration 124) HERE instead of on GHL's hosted page.
  const ssMode = settingsRes.data?.invoice_in_ghl === false;

  // Tenant-wide select, phone match applied IN CODE below. PostgREST cannot filter on the
  // regexp_replace expression the phone comparison needs (contact->>'phone' is a formatted
  // display string, so both sides must normalize to digits), and a tenant-wide read matches
  // existing practice — portal.html loads all tenant designs the same way. Migration 108's
  // expression index (designs_client_phone_digits_idx) serves future SQL paths that can
  // state the expression; this path pays one tenant scan instead.
  const { data: rows, error: designsErr } = await admin
    .from("designs")
    .select("short_code, created_at, status, contact, selections, ghl_estimate_number, ghl_estimate_id, image_url, estimate_lines, ss_quote_number, ss_quote_pdf_url, accepted_at, view3d_image_url")
    .eq("client_id", identity.clientId)
    .order("created_at", { ascending: false }); // newest first
  if (designsErr) return dbFail(req, identity.clientId, "load quotes", designsErr);

  const mine = (rows ?? [])
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
    ;

  // Pending change orders (migration 126, SS mode only): one query over this customer's
  // OWN codes — a change to an agreed order needs their signature, and the card renders
  // right under the quote it amends. Cents → dollars at the edge, like `total`.
  // deno-lint-ignore no-explicit-any
  const cosByCode = new Map<string, any[]>();
  // The most recent ACKNOWLEDGED change per code. Not shown to anyone — it is only used to
  // work out whether a sent invoice predates an approved change, in which case the amount
  // printed on it is no longer the amount owed and it must not be signed (migration 136).
  const lastAckByCode = new Map<string, number>();
  if (ssMode && mine.length > 0) {
    const { data: cos } = await admin.from("change_orders")
      .select("id, short_code, co_no, description, total_before_cents, total_after_cents, created_at, status, acknowledged_at")
      .eq("client_id", identity.clientId)
      .in("status", ["pending_ack", "acknowledged"])
      .in("short_code", mine.map((d) => d.short_code));
    for (const co of cos ?? []) {
      if (co.status === "acknowledged") {
        const t = Date.parse(String(co.acknowledged_at || "")) || 0;
        if (t > (lastAckByCode.get(co.short_code) ?? 0)) lastAckByCode.set(co.short_code, t);
        continue;
      }
      const list = cosByCode.get(co.short_code) ?? [];
      list.push({
        id: co.id,
        coNo: co.co_no,
        description: co.description,
        totalBefore: co.total_before_cents == null ? null : co.total_before_cents / 100,
        totalAfter: co.total_after_cents == null ? null : co.total_after_cents / 100,
        createdAt: co.created_at,
      });
      cosByCode.set(co.short_code, list);
    }
  }

  // The invoice, when one is out (migration 136). invoice_sends has RLS with zero policies,
  // so this service-role read is the ONLY way the customer's own page can learn that a
  // document is waiting for their signature. The projection stays as narrow as the quote's:
  // a number, a PDF link, and the two timestamps the card renders.
  // deno-lint-ignore no-explicit-any
  const invByCode = new Map<string, any>();
  if (ssMode && mine.length > 0) {
    const { data: invs } = await admin.from("invoice_sends")
      .select("short_code, invoice_number, invoice_pdf_url, status, signed_at, updated_at")
      .eq("client_id", identity.clientId)
      .eq("issued_by", "structurestudio")
      .in("short_code", mine.map((d) => d.short_code));
    for (const iv of invs ?? []) {
      if (!["created", "sent"].includes(String(iv.status))) continue;
      const sentAt = Date.parse(String(iv.updated_at || "")) || 0;
      invByCode.set(iv.short_code, {
        number: iv.invoice_number ?? null,
        pdfUrl: iv.invoice_pdf_url ?? null,
        sentAt: iv.updated_at ?? null,
        signedAt: iv.signed_at ?? null,
        stale: (lastAckByCode.get(iv.short_code) ?? 0) > sentAt,
      });
    }
  }

  const quotes = mine
    // NARROW projection — the migration-048 lesson (a phone number once bridged to full
    // contact PII, and 048's fix was to stop returning it). Never echo `contact` back:
    // the caller already knows their own phone, and a leaked/stolen session token must
    // not yield address or email on top of the quote list. Only what the list screen
    // renders leaves this function.
    .map((d) => ({
      estimateNumber: d.ghl_estimate_number != null && d.ghl_estimate_number !== ""
        ? `EST-${d.ghl_estimate_number}`
        // SS-mode quotes carry the builder's own number, prefix included, verbatim —
        // "JB-1041" must render exactly as it reads on the PDF (migration 122).
        : (ssMode && d.ss_quote_number ? String(d.ss_quote_number) : null),
      style: d?.selections?.style ?? null,
      size: d?.selections?.size ?? null,
      status: CUSTOMER_STATUSES.has(String(d?.status)) ? String(d.status) : "sent",
      createdAt: d.created_at,
      total: totalFromSnapshot(d?.estimate_lines),
      // SS mode: the 3-sheet quote document beats the bare floor plan when it exists.
      pdfUrl: (ssMode && d.ss_quote_pdf_url) ? d.ss_quote_pdf_url : (d.image_url || null),
      // GHL's hosted estimate page (Accept/Reject live there); null-safe when no estimate.
      acceptUrl: estimateUrl(d.ghl_estimate_id),
      // SS-mode accept happens HERE (customer-accept, migration 124). These four fields
      // are omitted entirely for CRM tenants so their payload stays byte-identical.
      ...(ssMode
        ? {
          // The accept call's key. Revealing the short code to its OWN verified customer
          // is fine — it is the same capability their floor-plan URL already carries.
          quoteRef: d.short_code,
          canAccept: String(d?.status) === "sent" && !!d.ss_quote_number && !d.accepted_at,
          // The 3D snapshot of their own building — the card's thumbnail.
          view3dImageUrl: d.view3d_image_url || null,
          // The invoice, once one is out (migration 136). Null until the builder sends it.
          invoice: invByCode.get(d.short_code) ?? null,
          // Whether the SIGN button may appear. Every condition the server enforces in
          // customer-accept's sign_invoice is mirrored here, so the button is absent
          // rather than present-and-then-rejected: an invoice exists, it is unsigned, it
          // is not stale, and no change order is waiting on them.
          canSignInvoice: (() => {
            const iv = invByCode.get(d.short_code);
            if (!iv || iv.signedAt || iv.stale) return false;
            if ((cosByCode.get(d.short_code) ?? []).length > 0) return false;
            return true;
          })(),
          acceptedAt: d.accepted_at || null,
          ssQuote: !!d.ss_quote_number,
          changeOrders: cosByCode.get(d.short_code) ?? [],
        }
        : {}),
    }));

  return json({ ok: true, businessName, name: identity.name, ssMode, quotes });
}));
