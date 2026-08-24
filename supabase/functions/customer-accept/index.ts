import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { totalFromSnapshot } from "../_shared/estimateLines.ts";
import { appendAcceptancePage } from "../_shared/acceptancePdf.ts";
import { acceptanceEmail } from "../_shared/emailTemplates.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";

// customer-accept: the CUSTOMER's electronic signature on their quote (migration 124).
//
// customer-quotes is documented read-only and stays that way — signing is the one write a
// customer can perform, so it gets its own function with its own narrow contract. Identity
// comes entirely from the customer_sessions token (phone OTP, migration 108); the signature
// only ever attaches to a design whose contact phone matches the verified session phone.
//
// SS-MODE ONLY. Tenants with invoice_in_ghl != false accept on GHL's hosted estimate page;
// this endpoint refuses them so there is exactly one accept path per tenant.
//
// ORDER OF WRITES (each step's failure story):
//   1. insert design_acceptances — THE record, and the concurrency claim (unique index:
//      one 'quote' acceptance per design). Everything after is presentation.
//   2. upload the drawn signature PNG — failure logs; the typed-name/consent/IP row stands.
//   3. promote the design (status 'sent' -> 'accepted', accepted_at once) + ensure the
//      orders row — failure logs loudly; sync-design-status cannot repair this in SS mode,
//      so the error is surfaced in the response for support.
//   4. countersign the quote PDF (append the acceptance certificate page, upsert same
//      path) — best-effort, quotePdf's cosmetics-never-break-the-money-path contract.
//   5. email the confirmation — sendTenantEmail never throws; dark tenants just skip.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
function dbFail(req: Request, clientId: string | null, where: string, err: any) {
  logEdgeError({
    fn: "customer-accept",
    req,
    clientId,
    code: err?.code ?? 500,
    message: `${where}: ${err?.message ?? "unknown database error"}`,
    context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
  }).catch(() => {});
  return json({ error: "Something went wrong on our side. Please try again in a moment." }, 500);
}

/** The exact sentence the customer agrees to — composed HERE, not trusted from the browser,
 *  so the stored consent_text is always the sentence this build showed (approved wording,
 *  Carolyn 2026-08-23). my-quotes.html renders the same composition client-side. */
export function consentSentence(quoteNumber: string, totalDisplay: string | null): string {
  return `I agree that my electronic signature is as binding as a handwritten one, and I accept quote ${quoteNumber}${totalDisplay ? ` for ${totalDisplay}` : ""}.`;
}

const fmtMoney = (n: number): string => {
  const v = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

const MAX_SIGNATURE_BYTES = 300 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Decode and validate a data:image/png;base64 payload. Null on anything off-shape. */
function decodeSignaturePng(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  // Base64 length bound BEFORE decoding: 300KB of bytes is ~400KB of base64.
  if (m[1].length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 8) return null;
  let bin: string;
  try { bin = atob(m[1]); } catch { return null; }
  if (bin.length === 0 || bin.length > MAX_SIGNATURE_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  for (let i = 0; i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) return null;
  return bytes;
}

Deno.serve(withErrorLog("customer-accept", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = typeof body?.action === "string" ? body.action : "";
  if (action !== "accept_quote") return json({ error: "Unknown action" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const identity = await checkSession(admin, body?.token);
  if (!identity) return json({ error: "Session expired — sign in again." }, 401);

  // ── Input shape ──────────────────────────────────────────────────────────────────────
  const quoteRef = typeof body?.quoteRef === "string" ? body.quoteRef.trim() : "";
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(quoteRef)) return json({ error: "Invalid quote reference." }, 400);

  if (body?.consent !== true) {
    return json({ error: "Please tick the agreement box to sign." }, 400);
  }
  const signerName = typeof body?.signerName === "string" ? body.signerName.trim().slice(0, 120) : "";
  if (!signerName) return json({ error: "Please enter your full name." }, 400);

  const method = body?.method === "drawn" ? "drawn" : body?.method === "typed" ? "typed" : null;
  if (!method) return json({ error: "Choose a signature style — draw or type." }, 400);

  let signaturePng: Uint8Array | null = null;
  let typedSignature: string | null = null;
  if (method === "drawn") {
    signaturePng = decodeSignaturePng(body?.signatureDataUrl);
    if (!signaturePng) return json({ error: "The drawn signature didn't come through — please try again." }, 400);
  } else {
    typedSignature = typeof body?.typedName === "string" ? body.typedName.trim().slice(0, 120) : "";
    if (!typedSignature) return json({ error: "Type your name to sign." }, 400);
  }

  // ── The design, owned by this verified phone ────────────────────────────────────────
  const { data: design, error: designErr } = await admin
    .from("designs")
    .select("short_code, status, contact, ss_quote_number, ss_quote_pdf_url, estimate_lines, accepted_at, inventory_unit_id")
    .eq("client_id", identity.clientId)
    .eq("short_code", quoteRef)
    .maybeSingle();
  if (designErr) return dbFail(req, identity.clientId, "load the quote", designErr);
  // Same sentence for "not found" and "not yours": a verified customer probing other codes
  // learns nothing about which short codes exist.
  const notYours = json({ error: "That quote wasn't found on your account." }, 404);
  if (!design) return notYours;
  const designPhone = String(design?.contact?.phone ?? "").replace(/\D/g, "");
  if (!designPhone || designPhone !== identity.phoneDigits) return notYours;

  // ── SS mode only ─────────────────────────────────────────────────────────────────────
  const { data: settings, error: settingsErr } = await admin
    .from("client_settings")
    .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, quote_terms")
    .eq("client_id", identity.clientId)
    .maybeSingle();
  if (settingsErr) return dbFail(req, identity.clientId, "load settings", settingsErr);
  if (!settings || settings.invoice_in_ghl !== false) {
    return json({ error: "This builder handles acceptance through their estimate page — use the link in your email." }, 409);
  }
  if (!design.ss_quote_number) {
    return json({ error: "This quote isn't ready to sign yet — ask your builder to resend it." }, 409);
  }
  const status = String(design.status || "");
  if (status === "invoiced" || status === "delivered") {
    return json({ error: "This order has already been invoiced — no signature needed." }, 409);
  }
  if (design.accepted_at) {
    return json({ ok: true, already: true, acceptedAt: design.accepted_at });
  }

  // ── Evidence snapshot inputs ─────────────────────────────────────────────────────────
  const total = totalFromSnapshot(design.estimate_lines);
  const consentText = consentSentence(String(design.ss_quote_number), total == null ? null : fmtMoney(total));
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const userAgent = (req.headers.get("user-agent") || "").slice(0, 300) || null;
  let designVersion: number | null = null;
  {
    const { data: v } = await admin
      .from("design_versions")
      .select("version")
      .eq("short_code", quoteRef)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    designVersion = v?.version ?? null;
  }

  // ── 1. The record (and the claim) ────────────────────────────────────────────────────
  const acceptanceId = crypto.randomUUID();
  const acceptedAtIso = new Date().toISOString();
  const { error: insErr } = await admin.from("design_acceptances").insert({
    id: acceptanceId,
    client_id: identity.clientId,
    short_code: quoteRef,
    subject: "quote",
    quote_number: design.ss_quote_number,
    design_version: designVersion,
    total,
    method,
    signer_name: signerName,
    typed_signature: typedSignature,
    consent_text: consentText,
    phone_digits: identity.phoneDigits,
    session_seen_name: identity.name,
    ip,
    user_agent: userAgent,
    accepted_at: acceptedAtIso,
  });
  if (insErr) {
    // 23505 on the partial unique index = someone (a second tap, a second device) already
    // signed this quote. The first signature is THE signature; report it as done.
    if (String(insErr.code) === "23505") return json({ ok: true, already: true });
    return dbFail(req, identity.clientId, "record the signature", insErr);
  }

  // ── 2. The drawn image (best-effort; the row's typed fields are already evidence) ────
  let signaturePath: string | null = null;
  if (signaturePng) {
    const path = `${identity.clientId}/${quoteRef}/${acceptanceId}.png`;
    const up = await admin.storage.from("signatures").upload(path, signaturePng, { contentType: "image/png" });
    if (up.error) {
      logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `signature upload failed: ${up.error.message}`, context: { path } }).catch(() => {});
    } else {
      signaturePath = path;
      await admin.from("design_acceptances").update({ signature_image_path: path }).eq("id", acceptanceId);
    }
  }

  // ── 3. Promote the design + ensure the order row ─────────────────────────────────────
  // status only ever climbs 'sent' -> 'accepted' here; anything else keeps its status and
  // just gains the timestamp. sync-design-status's SS fence (deployed with this slice)
  // preserves whatever is written here.
  let promoteWarning: string | null = null;
  {
    const patch: Record<string, unknown> = { accepted_at: acceptedAtIso, updated_at: acceptedAtIso };
    if (status === "sent" || status === "") patch.status = "accepted";
    const { error: updErr } = await admin.from("designs").update(patch)
      .eq("client_id", identity.clientId).eq("short_code", quoteRef);
    if (updErr) {
      promoteWarning = "recorded, but the status update needs attention";
      logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `design promote failed: ${updErr.message}`, context: { quoteRef } }).catch(() => {});
    }
    // The designs_ensure_order trigger fires on the status change where it exists, but the
    // flow must not depend on an out-of-band trigger (its CREATE lives on wip/orders) —
    // insert idempotently, same shape the trigger uses.
    const { error: ordErr } = await admin.from("orders")
      .upsert(
        { client_id: identity.clientId, short_code: quoteRef, ordered_at: acceptedAtIso },
        { onConflict: "client_id,short_code", ignoreDuplicates: true },
      );
    if (ordErr) {
      logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `order ensure failed: ${ordErr.message}`, context: { quoteRef } }).catch(() => {});
    }
  }

  // ── 4. Countersign the PDF (best-effort) ─────────────────────────────────────────────
  // Only a URL in OUR storage under THIS tenant's prefix is ever fetched server-side.
  let signedPdf = false;
  const expectedPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${identity.clientId}/`;
  const quotePdfUrl = String(design.ss_quote_pdf_url || "");
  if (quotePdfUrl.startsWith(expectedPrefix)) {
    try {
      const res = await fetch(quotePdfUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const countersigned = await appendAcceptancePage(bytes, {
          businessName: settings.business_name || null,
          quoteNumber: String(design.ss_quote_number),
          total,
          signerName,
          method,
          signaturePng,
          typedSignature,
          acceptedAtIso,
          ip,
          consentText,
        });
        const storagePath = quotePdfUrl.slice(`${supabaseUrl}/storage/v1/object/public/floor-plans/`.length);
        const up = await admin.storage.from("floor-plans")
          .upload(storagePath, countersigned, { contentType: "application/pdf", upsert: true });
        signedPdf = !up.error;
        if (up.error) console.warn("countersigned PDF upload failed:", up.error.message);
      }
    } catch (e) {
      console.warn("countersign failed:", (e as Error).message);
    }
  }

  // ── 5. Confirmation email (never throws; dark tenants skip inside) ──────────────────
  const to = String(design?.contact?.email || "").trim();
  if (to) {
    const content = acceptanceEmail({
      businessName: settings.business_name || identity.clientId,
      phone: settings.business_phone || null,
      website: settings.business_website || null,
      logoUrl: settings.business_logo_url || null,
      quoteNumber: String(design.ss_quote_number),
      total,
      signerName,
      acceptedAtIso,
      pdfUrl: signedPdf ? quotePdfUrl : (quotePdfUrl || null),
      quoteTerms: settings.quote_terms || null,
    });
    await sendTenantEmail(admin, identity.clientId, {
      kind: "acceptance",
      shortCode: quoteRef,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  }

  return json({
    ok: true,
    acceptedAt: acceptedAtIso,
    quoteNumber: design.ss_quote_number,
    signedPdf,
    signaturePath: signaturePath ? true : method === "typed",
    ...(promoteWarning ? { warning: promoteWarning } : {}),
  });
}));
