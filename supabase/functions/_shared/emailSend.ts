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
   * The HUMAN reply address(es) for this send — the staff member who is writing, or whoever
   * the tenant wants a customer to reach. One address or several.
   *
   * ⚠️ ITS MEANING CHANGED TWICE. It began as "where a reply goes"; it then became a
   * FALLBACK, used only when the tenant had no active inbound domain, because sendTenantEmail
   * derives a routable address on the tenant's own inbound subdomain
   * (`d.<short_code>@reply.<domain>`) and that WON outright. Since 2026-09-06 it is neither:
   * both addresses are put in Reply-To together (see the combine below), so a customer's
   * reply reaches the portal AND the person. It is no longer only reachable when inbound is
   * off, so a caller that passes a staff address is now advertising it on every send.
   *
   * There is still no `business_email` column to default one from (checked 2026-08-21), so
   * the caller has to say who.
   *
   * It matters most on the platform-fallback path, whose From is no-reply@ on a domain with
   * no MX — under RFC 5321 an A record with no MX becomes an implicit MX, so a customer who
   * replies gets a multi-day queue and then a bounce, and the builder never learns they
   * tried.
   */
  replyTo?: string | string[];
  /** Design short code; null/absent for kind 'test'. */
  shortCode?: string | null;
  /** Who this is about — the CRM composer's case, and a test sent to someone who is a contact.
   *  It builds the threading Message-ID, so a reply to a plain conversation email lands on the
   *  right person (a send with neither this nor shortCode simply gets no threading id), and
   *  since migration 261 it is written to the ledger row's contact_id at the claim — which is
   *  what puts the email in that person's conversation, in the portal and in the phone app.
   *  Pass it only for a contact the caller has actually found in this tenant. A value that is
   *  not a uuid is left off the row (and still threads as before), so it can never fail the
   *  claim insert. */
  contactId?: string | null;
  /** The words as the person typed them, plain text — a conversation email's body (migration
   *  261: email_sends.body_text), so the conversation can show what was said and not only the
   *  subject. Leave it off for document mail; its words are a template. Over 20,000 characters
   *  is cut to 20,000 on the row (never in the email itself). */
  bodyText?: string | null;
  /** The signed-in person sending it (auth user id), from the caller's session — never from a
   *  request body (migration 261: email_sends.sent_by). Left off the row unless it is a uuid. */
  sentBy?: string | null;
  /** The id the phone app gave its pending bubble, so the ledger row replaces it instead of
   *  showing twice (migration 261: email_sends.client_temp_id). Left off the row unless it is
   *  1–64 of A–Z a–z 0–9 _ -. */
  clientTempId?: string | null;
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/**
 * `id` is the email_sends row (the ledger row) for this send: on a sent outcome always, on a
 * failed one whenever the claim row was written — a send the provider refused is a row the
 * conversation shows as not sent. It is absent only when there is no row: a dark guard, or a
 * claim insert that failed.
 */
export type SendOutcome =
  | { sent: true; messageId: string; to: string; redirected: boolean; id: string }
  | { sent: false; reason: "not_active" | "failed"; error?: string; id?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shape portal-settings accepts for a client temp id, and the most email_sends'
 *  client_temp_id check allows (64). */
const CLIENT_TEMP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** email_sends_body_text_chk's limit, counted the way Postgres counts it: code points. */
const BODY_TEXT_MAX = 20000;
/** The claim-row keys that exist only once migration 261 is applied (contact_id is older). */
const LEDGER_261_KEYS = ["body_text", "sent_by", "client_temp_id"];
/** The PostgREST / Postgres codes for "that column does not exist (yet)" (sms-inbound's set). */
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

/**
 * The contact and the migration-261 columns for the claim row. NOTHING HERE MAY FAIL THE
 * INSERT: the claim is written before the provider call, and a claim that cannot be written
 * means the email is not sent (see the header). So each value goes on the row only when it is
 * sure to be accepted — a uuid where the column is a uuid, a client temp id of the right
 * shape, a body cut to the check's limit — and otherwise stays off it (the column is NULL),
 * which costs that one detail and not the email.
 *
 * A key is left OUT rather than written as null, so a send that carries none of these — every
 * quote, invoice, change order and receipt — writes exactly the row it wrote before 261. That
 * keeps document mail working even if these functions ever reach the database ahead of the
 * migration. A send that does carry them is claimed again without them when the columns are
 * not there yet (see the claim in sendTenantEmail), so it is sent too.
 */
function ledgerExtras(mail: TenantMail): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const contactId = str(mail.contactId);
  const sentBy = str(mail.sentBy);
  const tempId = str(mail.clientTempId);
  let body = typeof mail.bodyText === "string" ? mail.bodyText : "";
  // Postgres text cannot hold U+0000, and PostgREST refuses a lone surrogate (crm_send_email's
  // 20,000-unit slice can leave half an emoji at the end). Either would fail the claim insert,
  // and a failed claim means the email is not sent, so the STORED copy drops NULs and swaps a
  // lone surrogate for U+FFFD. The email itself goes out exactly as it was given. The swap is
  // one unit for one unit and the drop only shortens, so the cut below still holds.
  body = body.replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  // .length counts UTF-16 units, which is never fewer than code points, so only a body that
  // could be over the limit pays for the split.
  if (body.length > BODY_TEXT_MAX) body = Array.from(body).slice(0, BODY_TEXT_MAX).join("");
  return {
    ...(UUID_RE.test(contactId) ? { contact_id: contactId } : {}),
    ...(body.trim() ? { body_text: body } : {}),
    ...(UUID_RE.test(sentBy) ? { sent_by: sentBy } : {}),
    ...(CLIENT_TEMP_ID_RE.test(tempId) ? { client_temp_id: tempId } : {}),
  };
}

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

/**
 * Every reply address one email should carry, in the order a mail client meets them —
 * de-duplicated, empties dropped, and each argument allowed to be one address or several.
 *
 * ORDER IS THE WHOLE DESIGN DECISION HERE, because Reply-To is not reliably a list to every
 * reader. RFC 5322 defines it as an address-list and a conformant client offers all of them,
 * but real clients disagree, and some honour only the FIRST entry. So the first slot is not
 * a preference — it is what the least capable reader will do, and the caller must order for
 * that reader rather than for the standard.
 *
 * ⚠️ THE CRM ROUTING ADDRESS GOES FIRST, and it is worth knowing why, because the
 * request that produced this feature argues for the opposite. Carolyn, 2026-09-04 @35:06,
 * comparing us to GoHighLevel: "the company has to set up their domain to work. And then
 * every user should be able to go in and say, when somebody replies to an email, send it
 * here. But that should be in their profile." That is an ask for the PERSON's address, so
 * putting the machine address first looks like ignoring her. It is not, and the tie is broken
 * on which failure is recoverable:
 *
 *   Degraded client honours only the routing address → the reply lands on the customer's
 *     record in the portal. The rep does not get it in their own inbox, but nothing is lost:
 *     the conversation feed shows it, and that is exactly the behaviour that shipped before
 *     this change, so nobody is worse off than they were.
 *   Degraded client honours only the person's address → the reply lands in one rep's
 *     personal mailbox and the portal never sees it. The customer's record has a hole in it
 *     that no one can find, the builder cannot answer "what did we tell them?", and a rep who
 *     leaves takes the thread with them.
 *
 * The second is unrecoverable and silent, so the durable record takes the first slot. Both
 * addresses are still advertised, which is the thing that was actually being asked for.
 *
 * Case-insensitive de-duplication, first spelling wins: a tenant whose staff address IS their
 * routing address must not be listed twice (the customer would see the same address twice in
 * their reply line and think we are broken). The comparison is lowercased because no mail
 * system anyone uses treats a local part case-sensitively, but the address is EMITTED as it
 * was given — `Jane.Doe@example.com` reaches the customer's screen the way Jane writes it.
 *
 * NO CAP, deliberately. The inputs are structurally bounded — one derived routing address plus
 * whatever a single one of our own call sites passes — and a silent truncation here would be
 * the exact failure this whole feature exists to remove: an address that was configured, did
 * not error, and never arrived.
 */
export function combineReplyTo(
  ...parts: (string | string[] | null | undefined)[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const raw of Array.isArray(part) ? part : [part]) {
      if (typeof raw !== "string") continue;
      const addr = raw.trim();
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
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
  // Out here so the last-resort catch below can still name the row it claimed.
  let rowId: string | undefined;
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
          // For the routing Reply-To below. Read here rather than by the caller so all twelve
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
    // The contact, the words, the writer and the app's bubble id ride on the CLAIM (migration
    // 261), not on a later update: the row is right from its first moment, whether the send
    // then succeeds or fails, and whichever address it went to. They used to be stamped on
    // afterwards by matching the newest row to the same address, which missed every failed
    // send and every send the beta redirect re-addressed. ledgerExtras keeps any of them from
    // failing the insert.
    const extras = ledgerExtras(mail);
    const claim = (more: Record<string, unknown>) => admin.from("email_sends").insert({
      client_id: clientId,
      short_code: mail.shortCode ?? null,
      kind: mail.kind,
      to_email: to,
      ...(redirected ? { intended_email: mail.to } : {}),
      from_email: fromEmail,
      subject: mail.subject,
      status: "claimed",
      ...more,
    }).select("id").single();
    let { data: row, error: insErr } = await claim(extras);

    // ⚠️ A DEPLOY AHEAD OF MIGRATION 261 MUST NOT STOP THE EMAIL. PostgREST refuses the WHOLE
    // insert when one key names a column it cannot find (PGRST204), so without this every
    // conversation and test email would be refused at the claim, and not sent, until a human
    // applied the migration. On that error the claim is tried once more without the 261 keys
    // (contact_id is older and stays, so the email still lands on the contact), and one info row
    // names the migration. That costs only the stored words, the writer and the bubble id. A
    // second failure is the ledger really being down, and refuses exactly as before.
    const later = Object.keys(extras).filter((k) => LEDGER_261_KEYS.includes(k));
    if (insErr && MISSING_COLUMN.has(String(insErr.code ?? "")) && later.length) {
      await logEdgeError({
        fn: "email-send",
        clientId,
        code: "email_ledger_261_columns_missing",
        severity: "info",
        message: `email_sends claim row refused ${later.join(", ")} - retrying without them; `
          + `migration 261 may not be applied: ${insErr.message ?? insErr.code}`,
        context: { kind: mail.kind, shortCode: mail.shortCode ?? null, redirected },
      });
      ({ data: row, error: insErr } = await claim(
        Object.fromEntries(Object.entries(extras).filter(([k]) => !LEDGER_261_KEYS.includes(k))),
      ));
    }

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
    rowId = String(row.id);

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

    // ── Reply-To ─────────────────────────────────────────────────────────
    // BOTH addresses, not one: the routable address on the TENANT'S OWN inbound subdomain
    // (so the reply comes back into the portal, and the customer only ever sees the builder's
    // domain) AND whatever human address the caller passed.
    //
    // THE DERIVATION LIVES HERE, NOT AT THE CALL SITES, and that is the older fix this must
    // not undo. The routing address used to be computed by hand inside portal-settings'
    // crm_send_email — one of TWELVE sendTenantEmail call sites (this comment said "ten"
    // until 2026-09-06; the real count is three in customer-accept, seven in portal-settings,
    // two in submit-estimate) — so a customer replying to their QUOTE, by far the likeliest
    // reply in the product, was never routed anywhere. Every document send already passes
    // shortCode, so deriving it here lights up all twelve paths with no caller plumbing and
    // no way to forget the next one.
    //
    // ⚠️ WHAT CHANGED 2026-09-06, AND WHAT THE CUSTOMER WILL ACTUALLY SEE. This was a `??`:
    // the routing address won outright and the caller's human address was reachable ONLY on
    // tenants with no active inbound domain. Carolyn, 2026-09-04 @35:06: "the company has to
    // set up their domain to work. And then every user should be able to go in and say, when
    // somebody replies to an email, send it here. But that should be in their profile." An
    // either/or cannot express that — the moment the company's domain works, the person's
    // choice stops mattering — so the two are combined instead.
    //
    // THIS IS A REAL BEHAVIOUR CHANGE, VISIBLE TO THE CUSTOMER, not an internal refactor. On a
    // tenant with inbound active AND a caller-supplied address, a customer who hits Reply now
    // gets TWO recipients on their reply — the token address `d.ss-xxxx@reply.builder.com`
    // beside the rep's own — and the message is delivered to both. Three consequences someone
    // will eventually ask about: the machine-looking token address is now DISPLAYED to
    // customers rather than merely being replied to; a rep who hits Reply-All is mailing the
    // CRM as well as the customer; and a customer who deletes one of the two before sending
    // silently opts out of whichever it was. All are inherent to what was asked for. If the
    // visible token address turns out to be unacceptable, the fix is a prettier local part,
    // not a return to the either/or.
    //
    // combineReplyTo (read its comment — the ORDER is the load-bearing part) owns the ordering
    // rule, the de-duplication and the empty-drop. buildReplyAddress still returns null unless
    // the inbound domain is genuinely 'active', so a pending domain contributes nothing and the
    // human address stands alone — exactly as before, which is what keeps a customer's reply
    // out of a bounce queue.
    const replyTo = combineReplyTo(
      buildReplyAddress(
        (s as Record<string, unknown>).inbound_domain,
        (s as Record<string, unknown>).inbound_status,
        { shortCode: mail.shortCode, contactId: mail.contactId },
      ),
      mail.replyTo,
    );

    // ── Send, then record the outcome on the claimed row ────────────────────────────
    let messageId: string;
    try {
      const out = await rsSendEmail({
        from,
        to,
        subject: mail.subject,
        html: mail.html,
        ...(mail.text ? { text: mail.text } : {}),
        ...(replyTo.length ? { replyTo } : {}),
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
      return { sent: false, reason: "failed", error: err, id: rowId };
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
    return { sent: true, messageId, to, redirected, id: rowId };
  } catch (e) {
    // Includes anything the supabase client throws. Best-effort log, then the same
    // verdict shape as every other failure — the promise never rejects.
    const err = errText(e);
    await logEdgeError({
      fn: "email-send",
      clientId,
      code: "email_send_unhandled",
      message: `sendTenantEmail failed unexpectedly: ${err}`,
      context: { kind: mail?.kind, shortCode: mail?.shortCode ?? null, ...(rowId ? { rowId } : {}) },
    });
    return { sent: false, reason: "failed", error: err, ...(rowId ? { id: rowId } : {}) };
  }
}
