import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { checkSession } from "../_shared/customerSession.ts";
import { phoneKey } from "../_shared/phoneKey.ts";
import { amountOwed, orderCentsFromSnapshot, totalFromSnapshot } from "../_shared/estimateLines.ts";
import { appendAcceptancePage } from "../_shared/acceptancePdf.ts";
import { acceptanceEmail } from "../_shared/emailTemplates.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";

// customer-accept: every write a CUSTOMER can perform on their own paperwork (migration 124).
//
// customer-quotes is documented read-only and stays that way — accepting and signing are the
// only writes a customer can perform, so they get their own function with their own narrow
// contract. Identity comes entirely from the customer_sessions token (phone OTP, migration
// 108); a write only ever attaches to a design whose contact phone matches the session phone.
//
// THE LADDER (Carolyn 2026-08-25 — "I want them to accept the quote to let us know, then I
// will [invoice]... I honestly want them to sign the invoice"):
//
//   accept_quote      the QUOTE is accepted with a click. Recorded, not signed.
//   ack_change_order  a change to an accepted order is signed off (migration 126).
//   sign_invoice      the INVOICE is SIGNED. This is the commitment, and the only thing
//                     that moves a design to 'invoiced' — which is why the build board,
//                     the delivery pool and the inventory claim all still read correctly
//                     off designs.status without knowing this flow changed (migration 136).
//
// A click-accept still writes a design_acceptances row. It carries no signature image, but
// it carries the evidence that decides a dispute: the OTP-verified phone, the ip, the user
// agent, and the consent sentence stored verbatim. "Did they accept?" keeps ONE answer table.
//
// SS-MODE ONLY. Tenants with invoice_in_ghl != false accept on GHL's hosted estimate page;
// this endpoint refuses them so there is exactly one accept path per tenant.
//
// ORDER OF WRITES — accept_quote (each step's failure story):
//   1. insert design_acceptances — THE record, and the concurrency claim (unique index:
//      one 'quote' acceptance per design). Everything after is presentation.
//   2. upload the drawn signature PNG — failure logs; the typed-name/consent/IP row stands.
//      Skipped entirely for a click, which has no image to store.
//   3. promote the design (status 'sent' -> 'accepted', accepted_at once) + ensure the
//      orders row — failure logs loudly; sync-design-status cannot repair this in SS mode,
//      so the error is surfaced in the response for support.
//   4. countersign the quote PDF — ONLY for a real signature. A clicked acceptance gets no
//      certificate page, because the certificate now belongs to the invoice.
//   5. email the confirmation — sendTenantEmail never throws; dark tenants just skip.
//
// ORDER OF WRITES — sign_invoice:
//   1. insert design_acceptances (subject 'invoice') — the record AND the claim, exactly as
//      above but against design_acceptances_invoice_once.
//   2. upload the drawn signature PNG — best-effort, same story.
//   3. stamp invoice_sends.signed_at + acceptance_id, then promote designs.status to
//      'invoiced'. THIS ORDER MATTERS: the status flip is what unlocks scheduling, so it
//      must never happen while the invoice row still reads unsigned.
//   4. countersign the INVOICE PDF — best-effort.
//   5. email the confirmation.

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

/** Accepting a quote is not signing for it. The sentence says what the customer is actually
 *  agreeing to — that they want to go ahead, and that the binding document arrives next —
 *  so nobody can later claim a click was presented to them as a signature. */
export function consentSentenceClick(quoteNumber: string, totalDisplay: string | null): string {
  return `I accept quote ${quoteNumber}${totalDisplay ? ` for ${totalDisplay}` : ""} and understand that my builder will send me an invoice to sign.`;
}

/** The invoice is the binding document now, so this is the sentence that carries the weight
 *  the quote's used to. Same "as binding as handwritten" language, pointed at the invoice. */
export function consentSentenceInvoice(invoiceNumber: string, totalDisplay: string | null): string {
  return `I agree that my electronic signature is as binding as a handwritten one, and I accept invoice ${invoiceNumber}${totalDisplay ? ` for ${totalDisplay}` : ""}.`;
}

/**
 * The tax columns for a design_acceptances row, read off the snapshot the customer was looking
 * at (migration 148). Returns {} when the snapshot carries no tax — every GHL-mode design, and
 * every SS design issued before tax shipped — so the columns stay NULL rather than 0, keeping
 * "was not taxed" distinguishable from "was taxed at nothing".
 */
// deno-lint-ignore no-explicit-any
function taxFreeze(snap: any): Record<string, unknown> {
  const t = snap?.tax;
  if (!t || t.amount == null) return {};
  return {
    tax_rate: Number(t.rate) || 0,
    tax_amount: Number(t.amount) || 0,
    tax_jurisdiction: t.jurisdiction ?? null,
    tax_source: t.source === "avalara" || t.source === "fallback" ? t.source : null,
  };
}

/** The three money columns an SS order carries, written TOGETHER so pretax + tax = total by
 *  construction. Falls back to the plain total for a snapshot with no tax, which is every
 *  GHL-mode order and every SS order issued before tax shipped. */
// deno-lint-ignore no-explicit-any
function orderMoney(snap: any): Record<string, unknown> {
  const m = orderCentsFromSnapshot(snap);
  if (!m) return {};
  return { total_cents: m.totalCents, pretax_subtotal_cents: m.pretaxCents, tax_cents: m.taxCents };
}

const fmtMoney = (n: number): string => {
  const v = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

// phoneKey moved to _shared/phoneKey.ts (174) — customer-pay needs the same comparison, and
// three private copies of the check that decides whether a stranger can read, sign or PAY
// someone else's invoice is how one of them drifts. Behaviour is unchanged.

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
  if (action !== "accept_quote" && action !== "ack_change_order" && action !== "sign_invoice") {
    return json({ error: "Unknown action" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const identity = await checkSession(admin, body?.token);
  if (!identity) return json({ error: "Session expired — sign in again." }, 401);

  // 'click' is a quote acceptance with no signature, and it is allowed on accept_quote ONLY.
  // Signing off a change order or an invoice always takes a real signature — reading the
  // method from the action rather than from the body is what stops a crafted payload from
  // "signing" an invoice with a tick box.
  const isClick = action === "accept_quote" && body?.method === "click";

  if (body?.consent !== true) {
    return json({ error: `Please tick the agreement box to ${isClick ? "accept" : "sign"}.` }, 400);
  }
  const signerName = typeof body?.signerName === "string" ? body.signerName.trim().slice(0, 120) : "";
  if (!signerName) return json({ error: "Please enter your full name." }, 400);

  const method = isClick
    ? "click"
    : body?.method === "drawn"
    ? "drawn"
    : body?.method === "typed"
    ? "typed"
    : null;
  if (!method) return json({ error: "Choose a signature style — draw or type." }, 400);

  let signaturePng: Uint8Array | null = null;
  let typedSignature: string | null = null;
  if (method === "drawn") {
    signaturePng = decodeSignaturePng(body?.signatureDataUrl);
    if (!signaturePng) return json({ error: "The drawn signature didn't come through — please try again." }, 400);
  } else if (method === "typed") {
    typedSignature = typeof body?.typedName === "string" ? body.typedName.trim().slice(0, 120) : "";
    if (!typedSignature) return json({ error: "Type your name to sign." }, 400);
  }

  // ═══ ack_change_order: sign off on a change to an already-accepted order (migration 126) ═══
  if (action === "ack_change_order") {
    const coId = typeof body?.changeOrderId === "string" ? body.changeOrderId.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coId)) {
      return json({ error: "Invalid change order reference." }, 400);
    }
    const { data: co, error: coErr } = await admin.from("change_orders")
      .select("id, short_code, co_no, status, description, total_before_cents, total_after_cents")
      .eq("client_id", identity.clientId).eq("id", coId).maybeSingle();
    if (coErr) return dbFail(req, identity.clientId, "load the change order", coErr);
    const notYoursCo = json({ error: "That change order wasn't found on your account." }, 404);
    if (!co) return notYoursCo;

    // The signature only attaches to a change on a design this verified phone owns.
    const { data: coDesign, error: coDesignErr } = await admin.from("designs")
      .select("short_code, contact, ss_quote_number")
      .eq("client_id", identity.clientId).eq("short_code", co.short_code).maybeSingle();
    if (coDesignErr) return dbFail(req, identity.clientId, "load the quote", coDesignErr);
    if (!coDesign) return notYoursCo;
    const coPhone = phoneKey(coDesign?.contact?.phone);
    if (!coPhone || coPhone !== phoneKey(identity.phoneDigits)) return notYoursCo;

    if (co.status === "acknowledged") return json({ ok: true, already: true });
    if (co.status === "void") return json({ error: "This change was withdrawn by your builder — nothing to sign." }, 409);

    const coLabel = `CO-${co.co_no}`;
    const quoteNo = String(coDesign.ss_quote_number || co.short_code);
    const newTotal = co.total_after_cents == null ? null : co.total_after_cents / 100;
    const coConsent = `I agree that my electronic signature is as binding as a handwritten one, and I approve change order ${coLabel} to quote ${quoteNo}${newTotal == null ? "" : ` for a new total of ${fmtMoney(newTotal)}`}.`;
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
    const userAgent = (req.headers.get("user-agent") || "").slice(0, 300) || null;
    const acceptanceId = crypto.randomUUID();
    const ackAtIso = new Date().toISOString();

    // The record + the claim (partial unique: one acknowledgment per change order).
    const { error: insErr } = await admin.from("design_acceptances").insert({
      id: acceptanceId,
      client_id: identity.clientId,
      short_code: co.short_code,
      subject: "change_order",
      change_order_id: co.id,
      quote_number: quoteNo,
      total: newTotal,
      method,
      signer_name: signerName,
      typed_signature: typedSignature,
      consent_text: coConsent,
      phone_digits: identity.phoneDigits,
      session_seen_name: identity.name,
      ip,
      user_agent: userAgent,
      accepted_at: ackAtIso,
    });
    if (insErr) {
      if (String(insErr.code) === "23505") return json({ ok: true, already: true });
      return dbFail(req, identity.clientId, "record the signature", insErr);
    }

    if (signaturePng) {
      const path = `${identity.clientId}/${co.short_code}/${acceptanceId}.png`;
      const up = await admin.storage.from("signatures").upload(path, signaturePng, { contentType: "image/png" });
      if (!up.error) await admin.from("design_acceptances").update({ signature_image_path: path }).eq("id", acceptanceId);
    }

    // Flip the CO — service role, so the guard trigger admits the signature ack.
    const { error: ackErr } = await admin.from("change_orders")
      .update({ status: "acknowledged", ack_method: "signature", acceptance_id: acceptanceId, acknowledged_at: ackAtIso })
      .eq("id", co.id).eq("status", "pending_ack");
    if (ackErr) {
      logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `CO ack update failed: ${ackErr.message}`, context: { coId } }).catch(() => {});
      return json({ error: "Your signature was recorded but the change didn't finalize — your builder can see it and will finish up." }, 500);
    }

    // The acknowledged total becomes the order's total. total_source='manual' also shields
    // it from sync-design-status' GHL repricer (its step 8 skips manual rows).
    if (co.total_after_cents != null) {
      const { error: totErr } = await admin.from("orders")
        .update({ total_cents: co.total_after_cents, total_source: "manual", updated_at: ackAtIso })
        .eq("client_id", identity.clientId).eq("short_code", co.short_code);
      if (totErr) {
        logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `CO order-total update failed: ${totErr.message}`, context: { coId } }).catch(() => {});
      }
      // NOTE (deliberate): commission_entries computed from the old total are now stale —
      // the clawback kind (078) exists for exactly this; wiring it is a known follow-up.
    }

    // Confirmation email, best-effort.
    const to = String(coDesign?.contact?.email || "").trim();
    if (to) {
      const { data: cs } = await admin.from("client_settings")
        .select("business_name, business_phone, business_website, business_logo_url, quote_terms")
        .eq("client_id", identity.clientId).maybeSingle();
      const content = acceptanceEmail({
        businessName: cs?.business_name || identity.clientId,
        phone: cs?.business_phone || null,
        website: cs?.business_website || null,
        logoUrl: cs?.business_logo_url || null,
        quoteNumber: `${quoteNo} — ${coLabel}`,
        total: newTotal,
        signerName,
        acceptedAtIso: ackAtIso,
        pdfUrl: null,
        quoteTerms: cs?.quote_terms || null,
      });
      await sendTenantEmail(admin, identity.clientId, {
        kind: "acceptance", shortCode: co.short_code, to,
        subject: content.subject, html: content.html, text: content.text,
      });
    }

    return json({ ok: true, acknowledgedAt: ackAtIso, coNo: co.co_no });
  }

  // ═══ sign_invoice: the customer signs the INVOICE — the commitment (migration 136) ═══
  //
  // This is the step that moves a design to 'invoiced'. send_invoice deliberately no longer
  // does, so until this runs the building cannot reach the build board or the delivery pool.
  if (action === "sign_invoice") {
    const code = typeof body?.quoteRef === "string" ? body.quoteRef.trim() : "";
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return json({ error: "Invalid quote reference." }, 400);

    const { data: d, error: dErr } = await admin
      .from("designs")
      .select("short_code, status, contact, ss_quote_number, estimate_lines, accepted_at")
      .eq("client_id", identity.clientId)
      .eq("short_code", code)
      .maybeSingle();
    if (dErr) return dbFail(req, identity.clientId, "load the invoice", dErr);
    const notYours = json({ error: "That invoice wasn't found on your account." }, 404);
    if (!d) return notYours;
    const dPhone = phoneKey(d?.contact?.phone);
    if (!dPhone || dPhone !== phoneKey(identity.phoneDigits)) return notYours;

    const { data: settings, error: sErr } = await admin
      .from("client_settings")
      .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", identity.clientId)
      .maybeSingle();
    if (sErr) return dbFail(req, identity.clientId, "load settings", sErr);
    if (!settings || settings.invoice_in_ghl !== false) {
      return json({ error: "This builder handles invoicing through their own system — use the link in your email." }, 409);
    }

    // The invoice must exist and be OURS. invoice_sends is service-role only, which is why
    // this read happens here rather than being trusted from the request.
    const { data: inv, error: iErr } = await admin
      .from("invoice_sends")
      .select("invoice_number, invoice_pdf_url, status, issued_by, signed_at, updated_at")
      .eq("client_id", identity.clientId)
      .eq("short_code", code)
      .maybeSingle();
    if (iErr) return dbFail(req, identity.clientId, "load the invoice", iErr);
    if (!inv || inv.issued_by !== "structurestudio" || !["created", "sent"].includes(String(inv.status))) {
      return json({ error: "Your invoice isn't ready yet — your builder still has to send it." }, 409);
    }
    // Idempotent, and the mirror image of the quote path's refusal: there, being invoiced
    // means "no signature needed"; here it means "already signed".
    if (inv.signed_at || d.status === "invoiced" || d.status === "delivered") {
      return json({ ok: true, already: true, signedAt: inv.signed_at ?? null });
    }

    // A change the customer hasn't approved must not be swept into a signature, and a
    // change they HAVE approved makes the sent invoice out of date — the amount on the PDF
    // is no longer the amount owed. Both are the builder's to clear, so both say so.
    const { data: cos } = await admin
      .from("change_orders")
      .select("status, acknowledged_at, co_no, description, total_before_cents, total_after_cents")
      .eq("client_id", identity.clientId)
      .eq("short_code", code);
    for (const c of cos ?? []) {
      if (c.status === "pending_ack") {
        return json({ error: "There's a change to approve before you can sign this invoice — check the change order above." }, 409);
      }
    }
    const invoiceAt = Date.parse(String(inv.updated_at || "")) || 0;
    const staleCo = (cos ?? []).some(
      (c) => c.status === "acknowledged" && (Date.parse(String(c.acknowledged_at || "")) || 0) > invoiceAt,
    );
    if (staleCo) {
      return json({ error: "This invoice was issued before your latest approved change — ask your builder to resend it." }, 409);
    }

    const invNumber = String(inv.invoice_number || "");
    // The amount they are committing to is the ORDER's, not the quote snapshot's: an
    // acknowledged change order moves the total without touching estimate_lines, and the
    // sentence they sign has to name the same number the invoice prints. (2026-08-27 —
    // see amendedInvoiceDocument for the case where those two disagreed by $250.)
    const { data: ordRow } = await admin
      .from("orders").select("total_cents")
      .eq("client_id", identity.clientId).eq("short_code", code).maybeSingle();
    const total = amountOwed(
      d.estimate_lines,
      (cos ?? []).filter((c) => c.status === "acknowledged"),
      ordRow?.total_cents == null ? null : Number(ordRow.total_cents),
    );
    const totalDisplay = total == null ? null : fmtMoney(total);
    const consentText = consentSentenceInvoice(invNumber, totalDisplay);
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
    const userAgent = (req.headers.get("user-agent") || "").slice(0, 300) || null;
    let designVersion: number | null = null;
    {
      const { data: v } = await admin
        .from("design_versions").select("version").eq("short_code", code)
        .order("version", { ascending: false }).limit(1).maybeSingle();
      designVersion = v?.version ?? null;
    }

    // ── 1. The record (and the claim, via design_acceptances_invoice_once) ──────────────
    const acceptanceId = crypto.randomUUID();
    const signedAtIso = new Date().toISOString();
    const { error: insErr } = await admin.from("design_acceptances").insert({
      id: acceptanceId,
      client_id: identity.clientId,
      short_code: code,
      subject: "invoice",
      quote_number: invNumber,
      design_version: designVersion,
      total,
      // The tax evidence (migration 148). Copied out of the snapshot rather than referenced,
      // because a resubmit OVERWRITES designs.estimate_lines — without its own copy the rate
      // and jurisdiction the customer committed under are destroyed by the next revision.
      // Same reason `total` above is a column and not a join.
      ...taxFreeze(d.estimate_lines),
      method,
      signer_name: signerName,
      typed_signature: typedSignature,
      consent_text: consentText,
      phone_digits: identity.phoneDigits,
      session_seen_name: identity.name,
      ip,
      user_agent: userAgent,
      accepted_at: signedAtIso,
    });
    if (insErr) {
      if (String(insErr.code) === "23505") return json({ ok: true, already: true });
      return dbFail(req, identity.clientId, "record the signature", insErr);
    }

    // ── 2. The drawn image (best-effort) ───────────────────────────────────────────────
    if (signaturePng) {
      const path = `${identity.clientId}/${code}/${acceptanceId}.png`;
      const up = await admin.storage.from("signatures").upload(path, signaturePng, { contentType: "image/png" });
      if (up.error) {
        logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `signature upload failed: ${up.error.message}`, context: { path } }).catch(() => {});
      } else {
        await admin.from("design_acceptances").update({ signature_image_path: path }).eq("id", acceptanceId);
      }
    }

    // ── 3. Stamp the invoice, THEN promote the design ──────────────────────────────────
    // Order matters: the status flip is what unlocks scheduling, so it must never land
    // while invoice_sends still reads unsigned. If the stamp fails we stop — an unsigned
    // invoice with a scheduled building is the one state worth refusing outright.
    let promoteWarning: string | null = null;
    const { error: stampErr } = await admin.from("invoice_sends")
      .update({ signed_at: signedAtIso, acceptance_id: acceptanceId, updated_at: signedAtIso })
      .eq("client_id", identity.clientId).eq("short_code", code);
    if (stampErr) {
      logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `invoice stamp failed: ${stampErr.message}`, context: { code } }).catch(() => {});
      return json({ error: "Your signature was recorded but the invoice didn't finalize — your builder can see it and will finish up." }, 500);
    }
    {
      const { error: updErr } = await admin.from("designs")
        .update({ status: "invoiced", updated_at: signedAtIso })
        .eq("client_id", identity.clientId).eq("short_code", code);
      if (updErr) {
        promoteWarning = "signed, but the status update needs attention";
        logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `invoice promote failed: ${updErr.message}`, context: { code } }).catch(() => {});
      }
      // Same NULL-only fill as the quote path: a rep-set total is never clobbered.
      if (total != null) {
        await admin.from("orders")
          .update({ ...orderMoney(d.estimate_lines), total_source: "manual", updated_at: signedAtIso })
          .eq("client_id", identity.clientId).eq("short_code", code).is("total_cents", null);
      }
    }

    // ── 4. Countersign the INVOICE PDF (best-effort) ───────────────────────────────────
    let signedPdf = false;
    const prefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${identity.clientId}/`;
    const invPdfUrl = String(inv.invoice_pdf_url || "");
    if (invPdfUrl.startsWith(prefix)) {
      try {
        const res = await fetch(invPdfUrl, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const countersigned = await appendAcceptancePage(bytes, {
            businessName: settings.business_name || null,
            quoteNumber: invNumber,
            total,
            signerName,
            method: method as "drawn" | "typed",
            signaturePng,
            typedSignature,
            acceptedAtIso: signedAtIso,
            ip,
            consentText,
            docLabel: "Invoice",
          });
          const storagePath = invPdfUrl.slice(`${supabaseUrl}/storage/v1/object/public/floor-plans/`.length);
          const up = await admin.storage.from("floor-plans")
            .upload(storagePath, countersigned, { contentType: "application/pdf", upsert: true });
          signedPdf = !up.error;
          if (up.error) console.warn("countersigned invoice upload failed:", up.error.message);
        }
      } catch (e) {
        console.warn("invoice countersign failed:", (e as Error).message);
      }
    }

    // ── 5. Confirmation email ──────────────────────────────────────────────────────────
    const to = String(d?.contact?.email || "").trim();
    if (to) {
      const content = acceptanceEmail({
        businessName: settings.business_name || identity.clientId,
        phone: settings.business_phone || null,
        website: settings.business_website || null,
        logoUrl: settings.business_logo_url || null,
        quoteNumber: invNumber,
        total,
        signerName,
        acceptedAtIso: signedAtIso,
        pdfUrl: invPdfUrl || null,
        quoteTerms: settings.quote_terms || null,
        docWord: "invoice",
        method: method as "drawn" | "typed",
      });
      await sendTenantEmail(admin, identity.clientId, {
        kind: "acceptance",
        shortCode: code,
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }

    return json({
      ok: true,
      signedAt: signedAtIso,
      invoiceNumber: invNumber,
      signedPdf,
      ...(promoteWarning ? { warning: promoteWarning } : {}),
    });
  }

  // ═══ accept_quote ═══
  const quoteRef = typeof body?.quoteRef === "string" ? body.quoteRef.trim() : "";
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(quoteRef)) return json({ error: "Invalid quote reference." }, 400);

  // ── The design, owned by this verified phone ────────────────────────────────────────
  const { data: design, error: designErr } = await admin
    .from("designs")
    // selections + paint_colors ride along only for the accepted_snapshot stamp below (153).
    .select("short_code, status, contact, ss_quote_number, ss_quote_pdf_url, estimate_lines, selections, paint_colors, accepted_at, inventory_unit_id")
    .eq("client_id", identity.clientId)
    .eq("short_code", quoteRef)
    .maybeSingle();
  if (designErr) return dbFail(req, identity.clientId, "load the quote", designErr);
  // Same sentence for "not found" and "not yours": a verified customer probing other codes
  // learns nothing about which short codes exist.
  const notYours = json({ error: "That quote wasn't found on your account." }, 404);
  if (!design) return notYours;
  const designPhone = phoneKey(design?.contact?.phone);
  if (!designPhone || designPhone !== phoneKey(identity.phoneDigits)) return notYours;

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
  const totalDisplay = total == null ? null : fmtMoney(total);
  // A click and a signature agree to DIFFERENT sentences, and the stored text is the
  // evidence — so it is chosen by what the customer actually did, never by a request field.
  const consentText = method === "click"
    ? consentSentenceClick(String(design.ss_quote_number), totalDisplay)
    : consentSentence(String(design.ss_quote_number), totalDisplay);
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
    // What the customer was SHOWN when they accepted. Not the commitment — the invoice
    // signature is (migration 136) — but it is the answer to "what did they say yes to",
    // which is the question a disputed change order actually turns on.
    ...taxFreeze(design.estimate_lines),
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
    // accepted_snapshot (153) is THE agreement, frozen here: the priced lines and the
    // selections/paint they were priced from, as of this signature. Every later change order
    // is a diff against this, never against designs.estimate_lines — which the two
    // design_edit CO writers overwrite in the same handler that raises the CO, so reading it
    // back as "what the customer signed" is how a customer came to sign against a previous
    // total they never approved (audit finding 16). Stamped exactly once: accept_quote
    // early-returns above when accepted_at is already set. From here on the trigger
    // change_orders_stamp_agreed() moves it, on each acknowledged design_edit CO.
    const patch: Record<string, unknown> = {
      accepted_at: acceptedAtIso,
      updated_at: acceptedAtIso,
      accepted_snapshot: {
        estimateLines: design.estimate_lines,
        selections: design.selections,
        paintColors: design.paint_colors,
      },
    };
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
    // The signed total becomes the order's total (SS mode has no GHL total sync — its
    // step 8 skips designs with no estimate — so without this the order reads "Needs
    // total" forever). 'manual' is the source that both the repricer and this write
    // respect: only a NULL total is filled, a rep-set number is never clobbered.
    if (total != null) {
      const { error: totErr } = await admin.from("orders")
        .update({ ...orderMoney(design.estimate_lines), total_source: "manual", updated_at: acceptedAtIso })
        .eq("client_id", identity.clientId).eq("short_code", quoteRef).is("total_cents", null);
      if (totErr) {
        logEdgeError({ fn: "customer-accept", req, clientId: identity.clientId, code: 500, message: `order total fill failed: ${totErr.message}`, context: { quoteRef } }).catch(() => {});
      }
    }
  }

  // ── 4. Countersign the PDF (best-effort) ─────────────────────────────────────────────
  // Only a URL in OUR storage under THIS tenant's prefix is ever fetched server-side.
  //
  // A CLICK GETS NO CERTIFICATE PAGE. The acceptance certificate asserts a signature, and
  // stamping one onto a quote the customer only clicked would misrepresent what they did.
  // The certificate now rides the invoice, which is the document they actually sign.
  let signedPdf = false;
  const expectedPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${identity.clientId}/`;
  const quotePdfUrl = String(design.ss_quote_pdf_url || "");
  if (method !== "click" && quotePdfUrl.startsWith(expectedPrefix)) {
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
      method,
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
    mode: method === "click" ? "click" : "signature",
    ...(promoteWarning ? { warning: promoteWarning } : {}),
  });
}));
