/**
 * Send one tenant email through Resend, with the outcome recorded on an email_sends row.
 *
 * PROVIDER SWAPPED 2026-08-21 (Postmark -> Resend). Postmark's approval review declined the
 * CSM Synergy account on 2026-08-13; the swap is deliberately confined to the transport
 * import and the three gates below, which is the whole reason resend.ts was written to
 * mirror postmark.ts leaf-for-leaf.
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
 * global RESEND_API_KEY (unset until the account exists), and, for tenants without a
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
 * goes to app_errors (with the message id a human needs to reconcile) and the verdict
 * stays honest about what the recipient experienced.
 *
 * BETA REDIRECT lives HERE, before the ledger row is composed, so `to_email` always
 * records where the email actually went and `intended_email` who it was meant for. Only
 * the tenant's own `beta_mode` + `beta_email` redirect — the submit-estimate rule: a
 * deploy hostname is never an opt-in.
 *
 * Error strings never carry a recipient address: a ResendApiError is recorded as
 * `resend <status>/<name>` (Resend's message field echoes recipient addresses — its
 * testing-mode 403 names the address you may send to; see resend.ts), and app_errors
 * context sticks to shapes, codes and the short code.
 */

// deno-lint-ignore-file no-explicit-any
import { rsSendEmail, resendConfigured, ResendApiError } from "./resend.ts";
import { logEdgeError } from "./logError.ts";
import { buildThreadMessageId, buildReplyAddress } from "./emailInbound.ts";

/** The platform-owned fallback sender for tenants whose own domain is not yet verified.
 *  Usable only while PLATFORM_EMAIL_DOMAIN_READY === 'true' (read at request time, so
 *  flipping the flag needs no redeploy) — code must never outrun the domain's DNS. */
const PLATFORM_FROM = "no-reply@mail.structurestudiosuite.com";

export type TenantMail = {
  // ⚠️ MIRRORS THE email_sends.kind CHECK CONSTRAINT — keep the two in step, in the same
  // commit. A kind the constraint rejects fails at the ledger insert, which is AFTER the
  // decision to send, so the drift shows up as a send that half-happened.
  // 'acceptance' + 'change_order' came with migration 124; 'conversation' was live in the
  // constraint but missing from this union until 167 (a silent drift, found by the compiler
  // only because 'login_code' was added next to it); 'login_code' is migration 167.
  kind: "estimate" | "invoice" | "test" | "acceptance" | "change_order" | "conversation" | "login_code";
  /**
   * FALLBACK reply address — used only when the tenant has no ACTIVE inbound domain.
   *
   * ⚠️ Its meaning changed: this is no longer "where a reply goes". sendTenantEmail now
   * derives a routable address on the tenant's own inbound subdomain
   * (`d.<short_code>@reply.<domain>`) and that WINS when it exists, so a reply lands in the
   * portal instead of a personal inbox. Pass a real human's address here for the — currently
   * universal — case where inbound is not configured; there is still no business_email
   * column to default one from (checked 2026-08-21), so the caller has to say who.
   *
   * It matters most on the platform-fallback path, whose From is no-reply@ on a domain with
   * no MX — under RFC 5321 an A record with no MX becomes an implicit MX, so a customer who
   * replies gets a multi-day queue and then a bounce, and the builder never learns they
   * tried.
   */
  replyTo?: string;
  /** Design short code; null/absent for kind 'test'. */
  shortCode?: string | null;
  /** Who this is about, when there is no design — the CRM composer's case. Used only to
   *  build the threading Message-ID, so a reply to a plain conversation email lands on the
   *  right person. A send with neither this nor shortCode simply gets no threading id. */
  contactId?: string | null;
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

/** Ledger-safe error text, capped ~300 chars. A ResendApiError becomes the enum-ish
 *  `resend <status>/<name>` — never the provider message, which can echo the recipient's
 *  address (see resend.ts's header; its testing-mode 403 names the address you may send to).
 *  `name_` is "" when the body carried no name we trust, which is why the slash form is kept
 *  rather than interpolating a bare empty string. */
function errText(e: unknown): string {
  const msg = e instanceof ResendApiError
    ? `resend ${e.status}/${e.name_ || "unknown"}`
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
    if (!resendConfigured()) return { sent: false, reason: "not_active" };

    // The one settings read. A missing row or a read error both land on `!s` and go
    // dark — without settings we cannot know the tenant opted in, and dark degrades to
    // the caller's GHL fallback rather than to a dropped email.
    const { data: s } = await admin.from("client_settings")
      .select(
        "email_provider, email_domain_status, email_domain, email_from_local, " +
          "email_from_name, business_name, beta_mode, beta_email, " +
          // For the routing Reply-To below. Read here rather than by the caller so all ten
          // send paths get it from one place instead of one of them getting it by hand.
          "inbound_domain, inbound_status, " +
          // Who issues the paperwork — see the guard below.
          "invoice_in_ghl",
      )
      .eq("client_id", clientId).maybeSingle();
    if (!s) return { sent: false, reason: "not_active" };
    // THE PROVIDER GUARD, with one deliberate opening (Carolyn 2026-09-02). `email_provider`
    // flips to 'resend' only through email_activate, which refuses until the tenant's own
    // domain is verified — so the platform-domain fallback below was unreachable for EVERY
    // tenant, and a paperwork-mode tenant (invoice_in_ghl = false) sent no customer email at
    // all: that mode never falls back to the CRM's sender the way the GHL path does. Verified
    // live on abc-builder: "Quote Created!" and "Not emailed — not_active", a quote nobody
    // received. So a paperwork-mode tenant is treated as opted in — there is no other sender
    // for their documents — and sends from the platform address until their domain verifies.
    // CRM-mode tenants are unchanged: still dark until they activate their own domain.
    const paperworkMode = s.invoice_in_ghl === false;
    if (s.email_provider !== "resend" && !paperworkMode) return { sent: false, reason: "not_active" };

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

    // ── Threading id ────────────────────────────────────────────────────────────────
    // An RFC 5322 Message-ID we generate ourselves, encoding the tenant and what the mail
    // is about, so a reply's In-Reply-To routes straight back to this design or contact.
    //
    // It exists because the obvious alternative CANNOT work: `provider_message_id` below
    // stores Resend's API id, a bare uuid with no `@`, while In-Reply-To always carries an
    // id ending `@domain`. The webhook's join against that column has therefore matched
    // nothing on every send since it was written (migration 135's table comment still
    // claims otherwise). Generating the id makes it comparable AND self-describing.
    //
    // Built on the SENDING domain so it aligns with From, and omitted entirely when the
    // pieces are missing — a send with no threading id behaves exactly as it did before.
    const threadId = buildThreadMessageId(
      clientId,
      fromEmail.split("@")[1] ?? "",
      { shortCode: mail.shortCode, contactId: mail.contactId },
    );

    // ── Reply-To ────────────────────────────────────────────────────────────────────
    // A routable address on the TENANT'S OWN inbound subdomain, so a reply comes back into
    // the portal and the customer only ever sees the builder's domain.
    //
    // THIS LIVES HERE, NOT AT THE CALL SITES, and that is the fix. It used to be computed by
    // hand inside portal-settings' crm_send_email — one of TEN sendTenantEmail call sites —
    // so a customer replying to their QUOTE, by far the likeliest reply in the product, was
    // never routed anywhere. Every document send already passes shortCode, so deriving it
    // here lights up all ten paths with no caller plumbing and no way to forget the next one.
    //
    // The caller's explicit replyTo is the FALLBACK, not an override: it is the staff
    // member's own address, which reaches a human immediately but never appears in the
    // portal. A verified inbound domain beats it; anything less loses to it (buildReplyAddress
    // returns null unless the domain is genuinely 'active').
    const replyTo = buildReplyAddress(
      (s as Record<string, unknown>).inbound_domain,
      (s as Record<string, unknown>).inbound_status,
      { shortCode: mail.shortCode, contactId: mail.contactId },
    ) ?? mail.replyTo;

    // ── Send, then record the outcome on the claimed row ────────────────────────────
    let messageId: string;
    try {
      const out = await rsSendEmail({
        from,
        to,
        subject: mail.subject,
        html: mail.html,
        ...(mail.text ? { text: mail.text } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(threadId ? { headers: { "Message-ID": threadId } } : {}),
        // Resend has no Tag/Metadata split — tags carry both, and rsSendEmail sanitizes
        // them to Resend's charset so a dotted tenant slug degrades the TAG rather than
        // failing the whole send.
        tags: [
          { name: "client_id", value: clientId },
          { name: "kind", value: mail.kind },
          ...(mail.shortCode ? [{ name: "short_code", value: mail.shortCode }] : []),
        ],
      });
      messageId = out.id;
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
      provider_message_id: messageId || null,
      updated_at: new Date().toISOString(),
    }).eq("id", rowId);
    if (updErr) {
      // The email is REAL: Resend accepted it and handed back an id we now
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
