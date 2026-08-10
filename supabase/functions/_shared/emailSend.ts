/**
 * Send one tenant email through Postmark, with the outcome recorded on an email_sends row.
 *
 * CONTRACT WITH THE CALLER (submit-estimate / portal-settings): this function NEVER throws
 * and NEVER changes the caller's response. Its result is a plain verdict to branch on —
 * `{sent:true,…}` or `{sent:false, reason:'not_active'|'failed'}` — and both false shapes
 * mean the same thing to a send path: fall back to today's GHL sender. Nothing here may
 * abort an estimate submit; an email problem is never allowed to become a design-save
 * problem (the qboInvoice.ts contract, applied to email).
 *
 * DARK BY CONSTRUCTION: three independent switches gate the live path, and every one
 * defaults to off — the tenant's `email_provider` flag (migration 107, default 'ghl'), the
 * global Postmark secrets (unset until the account exists), and, for tenants without a
 * verified domain, the PLATFORM_EMAIL_DOMAIN_READY env flag (unset until the platform
 * domain's DNS is live and verified). When any guard fires this returns 'not_active'
 * WITHOUT touching the network or writing a ledger row — so deploying it changes nothing
 * for anyone until a human flips a switch.
 *
 * LEDGER FIRST: the email_sends row is written with status 'claimed' BEFORE the provider
 * call, so a crash mid-send leaves a visible 'claimed' row instead of silence. And if that
 * claim row cannot be written, the email is NOT sent: an email whose fate has no durable
 * trace is the exact gap this table exists to close (the twice-observed GHL
 * 200-but-nothing-arrived failure), and refusing to send is the cheaper mistake because
 * the caller still holds its GHL fallback. The one asymmetry: when the SEND succeeded but
 * the 'sent' update failed, the result is still `{sent:true}` — reporting failure there
 * would push the caller onto its fallback and DOUBLE-email the customer, so the truth
 * goes to app_errors (with the MessageID a human needs to reconcile) and the verdict
 * stays honest about what the recipient experienced.
 *
 * BETA REDIRECT lives HERE, before the ledger row is composed, so `to_email` always
 * records where the email actually went and `intended_email` who it was meant for. Only
 * the tenant's own `beta_mode` + `beta_email` redirect — the submit-estimate rule: a
 * deploy hostname is never an opt-in.
 *
 * Error strings never carry a recipient address: a PostmarkApiError is recorded as
 * `postmark <status>/<errorCode>` (Postmark's Message field echoes recipient addresses —
 * see postmark.ts), and app_errors context sticks to shapes, codes and the short code.
 */

// deno-lint-ignore-file no-explicit-any
import { pmSendEmail, postmarkConfigured, PostmarkApiError } from "./postmark.ts";
import { logEdgeError } from "./logError.ts";

/** The platform-owned fallback sender for tenants whose own domain is not yet verified.
 *  Usable only while PLATFORM_EMAIL_DOMAIN_READY === 'true' (read at request time, so
 *  flipping the flag needs no redeploy) — code must never outrun the domain's DNS. */
const PLATFORM_FROM = "no-reply@mail.structurestudiosuite.com";

export type TenantMail = {
  kind: "estimate" | "invoice" | "test";
  /** Design short code; null/absent for kind 'test'. */
  shortCode?: string | null;
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type SendOutcome =
  | { sent: true; messageId: string; to: string; redirected: boolean }
  | { sent: false; reason: "not_active" | "failed"; error?: string };

/**
 * RFC 5322 display-name formatting: `"Name" <addr>`. Control characters are stripped (a
 * newline in a From header is an injection primitive; nothing legitimate in a business
 * name contains one), then backslashes are escaped BEFORE quotes — swapping the two
 * re-escapes the backslashes just added (the qboInvoice q() lesson). An empty name
 * degrades to the bare address.
 */
function formatFrom(name: string | null | undefined, addr: string): string {
  const clean = String(name ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!clean) return addr;
  const escaped = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${addr}>`;
}

/** Ledger-safe error text, capped ~300 chars. A PostmarkApiError becomes the enum-ish
 *  `postmark <status>/<errorCode>` — never the provider message, which can echo the
 *  recipient's address (see postmark.ts's header). */
function errText(e: unknown): string {
  const msg = e instanceof PostmarkApiError
    ? `postmark ${e.status}/${e.errorCode}`
    : String((e as Error)?.message || e || "email send failed");
  return msg.slice(0, 300);
}

/**
 * Send one email for a tenant. Resolves — never rejects — with the verdict above.
 * `admin` is a service-role supabase client (client_settings and email_sends are both
 * service-role only).
 */
export async function sendTenantEmail(
  admin: any,
  clientId: string,
  mail: TenantMail,
): Promise<SendOutcome> {
  try {
    // ── Dark guards (zero network, zero ledger) ─────────────────────────────────────
    // Secrets first: an unconfigured deployment skips even the settings read.
    if (!postmarkConfigured()) return { sent: false, reason: "not_active" };

    // The one settings read. A missing row or a read error both land on `!s` and go
    // dark — without settings we cannot know the tenant opted in, and dark degrades to
    // the caller's GHL fallback rather than to a dropped email.
    const { data: s } = await admin.from("client_settings")
      .select(
        "email_provider, email_domain_status, email_domain, email_from_local, " +
          "email_from_name, business_name, beta_mode, beta_email",
      )
      .eq("client_id", clientId).maybeSingle();
    if (!s || s.email_provider !== "postmark") return { sent: false, reason: "not_active" };

    // ── From resolution ─────────────────────────────────────────────────────────────
    const businessName = typeof s.business_name === "string" ? s.business_name : "";
    let fromEmail: string;
    let fromName: string;
    if (s.email_domain_status === "verified" && s.email_domain) {
      const local =
        (typeof s.email_from_local === "string" && s.email_from_local.trim()) || "info";
      fromEmail = `${local}@${String(s.email_domain).trim()}`;
      fromName =
        (typeof s.email_from_name === "string" && s.email_from_name.trim()) || businessName;
    } else {
      // Not verified → platform domain, and ONLY while the readiness flag says its DNS
      // is live. Request-time read: flipping the flag needs no redeploy (the Deposyt
      // module-top-read lesson).
      if (Deno.env.get("PLATFORM_EMAIL_DOMAIN_READY") !== "true") {
        return { sent: false, reason: "not_active" };
      }
      fromEmail = PLATFORM_FROM;
      fromName = businessName;
    }
    const from = formatFrom(fromName, fromEmail);

    // ── Beta redirect (before the ledger row, so to_email is where it really went) ──
    const betaTo =
      s.beta_mode === true && typeof s.beta_email === "string" && s.beta_email.trim()
        ? s.beta_email.trim()
        : null;
    const redirected = betaTo !== null;
    const to = betaTo ?? mail.to;

    // ── Ledger first: claim the send before touching the provider ───────────────────
    const { data: row, error: insErr } = await admin.from("email_sends").insert({
      client_id: clientId,
      short_code: mail.shortCode ?? null,
      kind: mail.kind,
      to_email: to,
      ...(redirected ? { intended_email: mail.to } : {}),
      from_email: fromEmail,
      subject: mail.subject,
      status: "claimed",
    }).select("id").single();

    if (insErr || !row?.id) {
      // No claim row → no send. The raw Postgres message can echo row values (which
      // include addresses), so it goes to app_errors — service-role triage — and the
      // caller gets an authored sentence.
      await logEdgeError({
        fn: "email-send",
        clientId,
        code: "email_ledger_insert_failed",
        message: `email_sends claim row could not be written: ${
          insErr?.message ?? "insert returned no id"
        }`,
        context: { kind: mail.kind, shortCode: mail.shortCode ?? null, redirected },
      });
      return { sent: false, reason: "failed", error: "email ledger write failed" };
    }
    const rowId = row.id;

    // ── Send, then record the outcome on the claimed row ────────────────────────────
    let messageId: string;
    try {
      const out = await pmSendEmail({
        From: from,
        To: to,
        Subject: mail.subject,
        HtmlBody: mail.html,
        ...(mail.text ? { TextBody: mail.text } : {}),
        Tag: clientId,
        Metadata: { client_id: clientId, short_code: mail.shortCode || "", kind: mail.kind },
      });
      messageId = out.MessageID;
    } catch (e) {
      const err = errText(e);
      const { error: updErr } = await admin.from("email_sends").update({
        status: "failed",
        error: err,
        updated_at: new Date().toISOString(),
      }).eq("id", rowId);
      if (updErr) {
        // The row is stuck at 'claimed' and cannot say why — app_errors is the only
        // remaining channel (the qboInvoice fail-write posture).
        await logEdgeError({
          fn: "email-send",
          clientId,
          code: "email_ledger_update_failed",
          message:
            `email send failed (${err}) and the email_sends row could not record it: ` +
            `${updErr.message}`,
          context: { kind: mail.kind, shortCode: mail.shortCode ?? null, rowId },
        });
      }
      return { sent: false, reason: "failed", error: err };
    }

    const { error: updErr } = await admin.from("email_sends").update({
      status: "sent",
      postmark_message_id: messageId || null,
      updated_at: new Date().toISOString(),
    }).eq("id", rowId);
    if (updErr) {
      // The email is REAL: Postmark accepted it and handed back a MessageID we now
      // cannot persist — which also orphans the delivery/bounce webhook for this send.
      // Log the id a human needs to reconcile, and keep the verdict sent:true — a
      // 'failed' here would push the caller onto its GHL fallback and double-email
      // the customer.
      await logEdgeError({
        fn: "email-send",
        clientId,
        code: "email_ledger_update_failed",
        message:
          `email sent but the email_sends row could not record it: ${updErr.message}`,
        context: { kind: mail.kind, shortCode: mail.shortCode ?? null, rowId, messageId },
      });
    }
    return { sent: true, messageId, to, redirected };
  } catch (e) {
    // Includes anything the supabase client throws. Best-effort log, then the same
    // verdict shape as every other failure — the promise never rejects.
    const err = errText(e);
    await logEdgeError({
      fn: "email-send",
      clientId,
      code: "email_send_unhandled",
      message: `sendTenantEmail failed unexpectedly: ${err}`,
      context: { kind: mail?.kind, shortCode: mail?.shortCode ?? null },
    });
    return { sent: false, reason: "failed", error: err };
  }
}
