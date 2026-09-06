import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { phoneKey } from "../_shared/phoneKey.ts";
import { estimateUrl } from "../_shared/ghlLinks.ts";
import { amountOwed, subtotalsFromSnapshot, taxFromSnapshot, totalFromSnapshot } from "../_shared/estimateLines.ts";

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

// phoneKey moved to _shared/phoneKey.ts (174) — see the note in customer-accept.

/**
 * A document link leaves this function only when it names an object in THIS project's own
 * public storage.
 *
 * `designs.image_url` is written by the anon-callable save_design RPC (migration 104). That
 * sanitiser pins the object PATH and deliberately NOT the host, which is the right trade
 * where the value is only ever used to name one of this design's own objects server-side —
 * but it means a stored value can read as a floor-plan URL and still point at any origin.
 * The customer page hands whatever comes back straight to an anchor, and its own check is
 * scheme-only, so the host has to be settled HERE, on the way out: the builder-branded
 * "PDF" button must not be able to open somewhere that isn't ours.
 *
 * Fail-closed — with no SUPABASE_URL in the environment nothing matches, so a link is
 * missing rather than unchecked.
 */
const STORAGE_ORIGIN = Deno.env.get("SUPABASE_URL") ?? "";
const OWN_STORAGE_PREFIX = STORAGE_ORIGIN ? `${STORAGE_ORIGIN}/storage/v1/object/public/` : "";
function ownStorageUrl(u: unknown): string | null {
  const s = typeof u === "string" ? u.trim() : "";
  return OWN_STORAGE_PREFIX && s.startsWith(OWN_STORAGE_PREFIX) ? s : null;
}

/**
 * The tax breakdown a customer sees on their own card (migration 148) — the same pools the
 * PDF prints, so the screen and the document they were emailed cannot disagree.
 *
 * NULL when the snapshot carries no tax: every CRM-mode quote, and every SS quote issued
 * before tax shipped. The caller spreads the result, so null means the key is ABSENT and
 * those payloads stay exactly as they were.
 *
 * `taxable` / `nonTaxable` are the NETS — after each pool's own discounts — because that is
 * what the tax was charged on and what the customer can check the arithmetic against.
 */
// deno-lint-ignore no-explicit-any
function taxBreakdownOf(snap: any): Record<string, unknown> | null {
  const tax = taxFromSnapshot(snap);
  if (tax == null) return null;
  const pools = subtotalsFromSnapshot(snap);
  if (!pools) return null;
  const discount = round2c(pools.taxableDiscount + pools.nonTaxableDiscount);
  return {
    taxable: pools.taxableBase,
    nonTaxable: pools.nonTaxableNet,
    tax,
    // For the "(7.25%)" parenthetical only — never to recompute the amount above.
    taxRate: Number(snap?.tax?.rate) || 0,
    taxLabel: String(snap?.tax?.label || "Sales tax"),
    ...(discount > 0 ? { discount } : {}),
  };
}
const round2c = (n: number) => Math.round(n * 100) / 100;

// totalFromSnapshot moved to _shared/estimateLines.ts (2026-08-23): the acceptance record
// and the SS invoice snapshot the same number, and four copies of money math is how the
// customer's screen and the books learn to disagree.

Deno.serve(withErrorLog("customer-quotes", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

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

  const identityPhone = phoneKey(identity.phoneDigits);
  const mine = (rows ?? [])
    .filter((d) => {
      // The verified phone is the identity — only this customer's designs. Both sides
      // through phoneKey: an 11-digit stored "1816…" must match the 10-digit session.
      const phone = phoneKey(d?.contact?.phone);
      if (!phone || phone !== identityPhone) return false;
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
  // The acknowledged changes themselves, which DO move the amount due (2026-08-27). Kept
  // per code so the invoice card can name the same number the invoice prints — a manual
  // change order amends the total without touching estimate_lines, so the snapshot alone
  // would show the customer a stale figure and have them sign for it.
  // deno-lint-ignore no-explicit-any
  const ackedByCode = new Map<string, any[]>();
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
        const acked = ackedByCode.get(co.short_code) ?? [];
        acked.push(co);
        ackedByCode.set(co.short_code, acked);
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
  // The order's own total — the book of record for what is owed once changes are approved.
  const orderTotalByCode = new Map<string, number>();
  if (ssMode && mine.length > 0) {
    const { data: ords } = await admin.from("orders")
      .select("short_code, total_cents")
      .eq("client_id", identity.clientId)
      .in("short_code", mine.map((d) => d.short_code));
    for (const o of ords ?? []) {
      if (o?.total_cents != null) orderTotalByCode.set(String(o.short_code), Number(o.total_cents));
    }
  }
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
      // SS-mode quotes carry the builder's own number, prefix included, verbatim —
      // "JB-1041" must render exactly as it reads on the PDF (migration 122). It WINS
      // over a leftover ghl_estimate_number (a tenant who flipped GHL→SS and resubmitted
      // carries both): customer-accept composes and STORES the consent sentence from
      // ss_quote_number under the same ssMode + ss_quote_number rule, and the number the
      // customer reads must be the number the consent evidence names.
      estimateNumber: ssMode && d.ss_quote_number
        ? String(d.ss_quote_number)
        : (d.ghl_estimate_number != null && d.ghl_estimate_number !== ""
          ? `EST-${d.ghl_estimate_number}`
          : null),
      style: d?.selections?.style ?? null,
      size: d?.selections?.size ?? null,
      status: CUSTOMER_STATUSES.has(String(d?.status)) ? String(d.status) : "sent",
      createdAt: d.created_at,
      total: totalFromSnapshot(d?.estimate_lines),
      // SS mode: the 3-sheet quote document beats the bare floor plan when it exists.
      // Both go through ownStorageUrl — a value that isn't one of our own stored objects
      // yields no link at all, and the SS document losing the gate still falls back to the
      // floor plan rather than silently dropping the button.
      pdfUrl: (ssMode ? ownStorageUrl(d.ss_quote_pdf_url) : null) ?? ownStorageUrl(d.image_url),
      // GHL's hosted estimate page (Accept/Reject live there); null-safe when no estimate.
      acceptUrl: estimateUrl(d.ghl_estimate_id),
      // SS-mode accept happens HERE (customer-accept, migration 124). These four fields
      // are omitted entirely for CRM tenants so their payload stays byte-identical.
      ...(ssMode
        ? {
          // The accept call's key. Revealing the short code to its OWN verified customer
          // is fine — it is the same capability their floor-plan URL already carries.
          quoteRef: d.short_code,
          // Sales tax (migration 148). Spread, so a pre-tax quote carries no such key at all.
          ...(taxBreakdownOf(d?.estimate_lines) ?? {}),
          canAccept: String(d?.status) === "sent" && !!d.ss_quote_number && !d.accepted_at,
          // The 3D snapshot of their own building — the card's thumbnail.
          view3dImageUrl: d.view3d_image_url || null,
          // The invoice, once one is out (migration 136). Null until the builder sends it.
          // `amountDue` is what the invoice actually bills — the quote total plus every
          // acknowledged change — so the card, the PDF and the sentence they sign agree.
          invoice: invByCode.has(d.short_code)
            ? {
              ...invByCode.get(d.short_code),
              amountDue: amountOwed(
                d.estimate_lines,
                ackedByCode.get(d.short_code) ?? [],
                orderTotalByCode.get(d.short_code) ?? null,
              ),
            }
            : null,
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
