// Settings → Email, for a builder whose email goes out through Amazon SES (2026-11-10).
//
// WHY A FILE OF ITS OWN. index.ts holds the nine email_* actions as they were written for Resend,
// and tests pin several of their lines. Email is moving to SES one builder at a time
// (_shared/mailTransport.ts), so for a while BOTH providers' domain setup has to work. Rather than
// thread a second provider through nine Resend-shaped branches, index.ts asks this file first:
// handleEmailSesAction answers for a builder who is on SES and returns NULL for everyone else, and
// on null the Resend code below it runs exactly as it always has. The day Resend is cancelled, the
// Resend branches go and this file stays.
//
// WHAT A BUILDER SEES IS UNCHANGED: the same screen, the same buttons, the same response fields
// (the EmailSendingView contract). What differs is underneath, and it is simpler than Resend:
//
//   • ONE PASTE. Connecting hands back the DKIM record AND the reply record together, so sending
//     and replies are set up in one visit to the DNS panel. (On Resend the reply address was a
//     second provider domain, made by a second button after the first verified.)
//   • The reply address needs nothing created at the provider. reply.<domain> is a subdomain of
//     the verified identity, which SES already accepts mail for; it only needs its MX in DNS, and
//     we check that record ourselves by asking public DNS.
//   • "Check verification" is a READ. AWS re-checks DNS by itself every few minutes; there is no
//     verify call, so there is no way for a button press to park a domain at "pending" the way
//     Resend's verify POST did.
//
// DKIM: "bring your own" by default, ONE TXT record. We make the key pair here, hand AWS the
// private half once and never keep it, and show the builder the public half. The SES_DKIM_MODE
// setting set to `easy` switches new connects to AWS's own keys (three CNAMEs) with no code
// change; it exists as the fallback, not as a preference.
//
// ⚠️ THE PRIVATE KEY NEVER TOUCHES THE DATABASE OR A LOG. It lives in one variable for one
// request. If the row write after the create fails, the identity is deleted again, because its
// public half would otherwise be lost and nobody could ever publish the matching record.
//
// OPERATOR-ONLY, FOR A BUILDER WHO IS ALREADY ON RESEND (email_ses_prepare, email_ses_cutover):
// their email must keep flowing through Resend until SES says their domain is verified. Prepare
// creates the SES identity beside the Resend one and returns the records to publish; cut over
// refuses until AWS reports the domain verified (and, when they receive replies, until the reply
// MX points at SES), then flips the builder's pin in one write. The Resend domain is kept so
// `back: true` is an instant way home; `finish: true` deletes it once the builder has settled.

// deno-lint-ignore-file no-explicit-any
import {
  sesConfigured, sesCreateIdentity, sesDeleteIdentity, sesDisableFeedbackForwarding, sesDkimRecords,
  sesGenerateDkimKey, sesGetIdentity, sesIdentityGivenUp, sesIdentityVerified, sesInboundMxHost,
  sesInboundRecord, SesApiError, SesNotConfigured, type SesIdentity,
} from "../_shared/ses.ts";
import { rsDeleteDomain } from "../_shared/resend.ts";
import { defaultTransport, mailErrCode } from "../_shared/mailTransport.ts";
import { logEdgeError } from "../_shared/logError.ts";

/** The DKIM selector for bring-your-own DKIM: the builder's record lives at
 *  ss1._domainkey.<domain>. A number in the name so a future key can be ss2 beside it. */
export const SES_DKIM_SELECTOR = "ss1";

/** One row of the Email screen's DNS table (index.ts's DnsRow, minus Resend's tracking fields). */
export type SesDnsRow = { type: string; host: string; value: string; verified: boolean; priority?: number };

export type EmailSesCtx = {
  admin: any;
  req: Request;
  clientId: string;
  action: string;
  payload: Record<string, unknown>;
  /** True when the caller is CSM Synergy staff. For the two operator-only actions index.ts
   *  answers this with callerIsOperator(): an operator in view-as, or a staff member with write
   *  rights on their own (the internal) account. Nothing else here reads it. */
  operator: boolean;
  json: (body: unknown, status?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
  /** The MX hosts public DNS reports for a name, or null when DNS could not say. Injected by
   *  tests; lookupMxHosts in production. */
  lookupMx?: (host: string) => Promise<string[] | null>;
};

const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

const STATE_COLS =
  "email_domain, email_domain_status, email_dns_records, email_verified_at, resend_domain_id, " +
  "resend_inbound_domain_id, inbound_domain, inbound_status, inbound_dns_records, " +
  "email_transport, ses_identity, ses_dns_records";

type State = {
  email_domain: string | null;
  email_domain_status: string | null;
  email_dns_records: unknown;
  email_verified_at: string | null;
  resend_domain_id: string | null;
  resend_inbound_domain_id: string | null;
  inbound_domain: string | null;
  inbound_status: string | null;
  inbound_dns_records: unknown;
  email_transport: string | null;
  ses_identity: string | null;
  ses_dns_records: unknown;
};

/**
 * This builder's email state, including the SES columns (migration 383).
 * "pre_migration": the database has no SES columns yet, so nobody can be on SES: the caller
 * returns null and the Resend code runs. A Response: the read failed for another reason.
 */
async function readState(ctx: EmailSesCtx, where: string): Promise<State | "pre_migration" | Response> {
  const { data, error } = await ctx.admin.from("client_settings")
    .select(STATE_COLS).eq("client_id", ctx.clientId).maybeSingle();
  if (error) {
    if (MISSING_COLUMN.has(String(error.code ?? ""))) return "pre_migration";
    return ctx.dbFail(ctx.req, ctx.clientId, where, error);
  }
  return (data ?? {}) as State;
}

const onSes = (s: State): boolean => s.email_transport === "ses" && !!s.ses_identity;

/**
 * Is this builder's sending domain at SES? For email_status, which tells the screen whether the
 * "see when emails are opened" card has anything to offer (not on SES yet). A question that must
 * never cost the screen: any failure, including a database with no SES columns, answers false,
 * which shows the screen exactly as it always was.
 */
export async function emailOnSes(admin: any, clientId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.from("client_settings")
      .select("email_transport, ses_identity").eq("client_id", clientId).maybeSingle();
    return !error && !!data && data.email_transport === "ses" && !!data.ses_identity;
  } catch {
    return false;
  }
}
const nowIso = () => new Date().toISOString();
const rowsOf = (v: unknown): SesDnsRow[] => (Array.isArray(v) ? (v as SesDnsRow[]) : []);
const isDkimRow = (r: SesDnsRow) => String(r?.host ?? "").includes("._domainkey.");

/** New connects use bring-your-own DKIM (one TXT) unless the setting says `easy`. */
function easyDkim(): boolean {
  return (Deno.env.get("SES_DKIM_MODE") ?? "").trim().toLowerCase() === "easy";
}

function toRow(r: { type: string; host: string; value: string; verified: boolean; priority?: number }): SesDnsRow {
  return { type: r.type, host: r.host, value: r.value, verified: r.verified, ...(r.priority != null ? { priority: r.priority } : {}) };
}

/**
 * An SES call failed. Two authored outcomes, never a 500 and never AWS's words (index.ts's
 * rsFail, for the other provider): "not set up yet" for a deployment without the key, and for
 * anything else the status and exception name to app_errors under the label the builder is shown.
 */
function sesFail(ctx: EmailSesCtx, where: string, e: unknown): Response {
  if (e instanceof SesNotConfigured) {
    return ctx.json({ error: "Email sending isn't available yet — it's still being set up. Please try again later." }, 503);
  }
  const detail = mailErrCode(e) ?? String((e as Error)?.message ?? e ?? "unknown error").slice(0, 300);
  logEdgeError({
    fn: "portal-settings",
    req: ctx.req,
    clientId: ctx.clientId,
    code: e instanceof SesApiError ? e.status || 502 : 502,
    message: `${where}: ${detail}`,
    context: { where, sesErrorName: e instanceof SesApiError ? e.name_ : null },
  }).catch(() => {});
  return ctx.json({
    error: `Couldn't ${where}. Please try again — if it keeps happening, tell CSM Synergy and mention "${where}".`,
    ref: where,
  }, 502);
}

// ── Public DNS: is the reply record there? ────────────────────────────────────────────────────

const DOH = [
  (name: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
  (name: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=MX`,
];
const MX_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The MX hosts public DNS reports for `host`, lower-cased with no trailing dot. [] when the name
 * has none (including a name that does not exist). NULL when DNS could not say: a timeout, a
 * resolver error, a SERVFAIL. Two public resolvers are asked in turn, so one of them being
 * unreachable from the edge runtime does not read as "the builder's record is missing".
 * Never throws. Only the domain name goes out; it is public DNS data.
 */
export async function lookupMxHosts(host: string): Promise<string[] | null> {
  for (const url of DOH) {
    try {
      const res = await fetch(url(host), {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(MX_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = await res.json() as { Status?: unknown; Answer?: unknown };
      // 0 = NOERROR, 3 = NXDOMAIN. Anything else (SERVFAIL, REFUSED) is not an answer.
      if (body?.Status !== 0 && body?.Status !== 3) continue;
      const answers = Array.isArray(body.Answer) ? body.Answer : [];
      return answers
        .filter((a: any) => a && a.type === 15 && typeof a.data === "string")
        // "10 inbound-smtp.us-east-2.amazonaws.com." -> the host after the priority
        .map((a: any) => String(a.data).trim().split(/\s+/).pop()!.toLowerCase().replace(/\.+$/, ""))
        .filter(Boolean);
    } catch {
      // try the next resolver
    }
  }
  return null;
}

/** true: the reply MX points at SES. false: DNS answered and it does not. null: DNS could not say. */
async function inboundMxSeen(ctx: EmailSesCtx, inboundDomain: string): Promise<boolean | null> {
  const hosts = await (ctx.lookupMx ?? lookupMxHosts)(inboundDomain);
  if (hosts === null) return null;
  return hosts.includes(sesInboundMxHost());
}

// ── Creating the identity ─────────────────────────────────────────────────────────────────────

/**
 * Create the builder's identity at SES and return it with its DKIM rows. An identity that already
 * exists under this name is an orphan of ours (an earlier connect whose row write failed, so its
 * public key was lost): it is deleted and made again. The caller has already checked, in the
 * database, that no other builder holds this domain.
 */
async function createIdentity(domain: string): Promise<{ identity: SesIdentity; dkim: SesDnsRow[] }> {
  const make = async () => {
    if (easyDkim()) {
      const identity = await sesCreateIdentity(domain);
      return { identity, dkim: sesDkimRecords(identity).map(toRow) };
    }
    const key = await sesGenerateDkimKey();
    const identity = await sesCreateIdentity(domain, { selector: SES_DKIM_SELECTOR, privateKey: key.privateKey });
    return { identity, dkim: sesDkimRecords(identity, { selector: SES_DKIM_SELECTOR, publicKey: key.publicKey }).map(toRow) };
  };
  try {
    return await make();
  } catch (e) {
    if (!(e instanceof SesApiError) || e.status !== 409 || e.name_ !== "AlreadyExistsException") throw e;
    await sesDeleteIdentity(domain);
    return await make();
  }
}

/** Stop AWS's own bounce emails to the builder's From address (ses.ts says why). Best-effort:
 *  a refusal costs the builder an Amazon-branded email on a bounce, never the connect. */
async function quietFeedback(ctx: EmailSesCtx, domain: string): Promise<void> {
  try {
    await sesDisableFeedbackForwarding(domain);
  } catch (e) {
    await logEdgeError({
      fn: "portal-settings", req: ctx.req, clientId: ctx.clientId, code: "ses_feedback_forwarding", severity: "warn",
      message: `bounce-email forwarding could not be switched off for a new identity: ${mailErrCode(e) ?? "error"}`,
    }).catch(() => {});
  }
}

/** Best-effort removal of an identity whose row could not be written. */
async function discardIdentity(ctx: EmailSesCtx, domain: string): Promise<void> {
  try {
    await sesDeleteIdentity(domain);
  } catch (e) {
    await logEdgeError({
      fn: "portal-settings", req: ctx.req, clientId: ctx.clientId, code: "ses_orphan_identity",
      message: `an SES identity was created but its row could not be saved, and deleting it failed: ${mailErrCode(e) ?? "error"}`,
    }).catch(() => {});
  }
}

// ── email_connect_domain ──────────────────────────────────────────────────────────────────────

/**
 * Connect a sending domain at SES. Called from INSIDE index.ts's email_connect_domain, after its
 * checks (the pasted text is normalised, it is not one of our own domains, no other builder holds
 * it), so those rules are written once for both providers.
 *
 * Returns null when this connect belongs to Resend, and index.ts carries on: SES has no key on
 * this deployment, the database has no SES columns yet, the builder holds a Resend domain (their
 * move is the operator's cutover, not a reconnect), or the platform default is still Resend.
 */
export async function emailSesConnect(
  ctx: EmailSesCtx,
  input: { domain: string; fromLocal: string; fromName: string | null },
): Promise<Response | null> {
  if (!sesConfigured()) return null;
  const s = await readState(ctx, "read your email sending settings");
  if (s === "pre_migration") return null;
  if (s instanceof Response) return s;
  const holdsResend = !!s.resend_domain_id || !!s.resend_inbound_domain_id;
  if (!onSes(s) && (holdsResend || defaultTransport() !== "ses")) return null;

  const domain = input.domain;
  const inboundDomain = `reply.${domain}`;

  // Another builder already receiving on this exact reply address would get this builder's
  // replies. The partial unique index (migration 137) is the race-proof backstop.
  const { data: holder, error: holderErr } = await ctx.admin.from("client_settings")
    .select("client_id").eq("inbound_domain", inboundDomain).neq("client_id", ctx.clientId).maybeSingle();
  if (holderErr) return ctx.dbFail(ctx.req, ctx.clientId, "check that reply address", holderErr);
  if (holder) return ctx.json({ error: "That domain is already connected to another account." }, 409);

  let dkim: SesDnsRow[];
  let created = false;
  try {
    const stored = rowsOf(s.email_dns_records).filter(isDkimRow);
    if (s.ses_identity === domain && stored.length) {
      // Reconnect reuse: the same domain, and we still hold its records. Read, do not re-create:
      // a new key would silently invalidate the record the builder has already published.
      const identity = await sesGetIdentity(domain);
      dkim = stored.map((r) => ({ ...r, verified: identity.dkim.status === "SUCCESS" }));
    } else {
      // A different domain than before: the old identity is given up first, best-effort.
      if (s.ses_identity && s.ses_identity !== domain) {
        try { await sesDeleteIdentity(s.ses_identity); } catch (_) { /* inert once the row moves on */ }
      }
      ({ dkim } = await createIdentity(domain));
      created = true;
      await quietFeedback(ctx, domain);
    }
  } catch (e) {
    return sesFail(ctx, "connect that domain", e);
  }
  if (dkim.length === 0) {
    if (created) await discardIdentity(ctx, domain);
    return sesFail(ctx, "connect that domain", new Error("SES returned no DKIM record for a new identity"));
  }

  const inbound = [toRow(sesInboundRecord(inboundDomain, false))];
  const { error: upErr } = await ctx.admin.from("client_settings").upsert({
    client_id: ctx.clientId,
    email_domain: domain,
    ses_identity: domain,
    email_transport: "ses",
    email_domain_status: "pending",
    email_dns_records: dkim,
    email_from_local: input.fromLocal,
    email_from_name: input.fromName,
    email_verified_at: null,
    email_last_error: null,
    ses_dns_records: null,
    // The reply record goes out WITH the sending record, so one visit to the DNS panel sets up
    // both. 'pending' until the record is seen AND the domain is verified: only 'active' makes
    // sendTenantEmail advertise the address, and a reply to an address with no MX bounces back
    // at the customer.
    inbound_domain: inboundDomain,
    inbound_status: "pending",
    inbound_dns_records: inbound,
    inbound_verified_at: null,
    inbound_last_error: null,
    updated_at: nowIso(),
  }, { onConflict: "client_id" });
  if (upErr) {
    // Without the row, the public key (and so the one record that matches it) is lost.
    if (created) await discardIdentity(ctx, domain);
    if ((upErr as { code?: string }).code === "23505") {
      return ctx.json({ error: "That domain is already connected to another account." }, 409);
    }
    return ctx.dbFail(ctx.req, ctx.clientId, "save your email domain", upErr);
  }
  return ctx.json({ ok: true, dnsRecords: dkim });
}

// ── The other actions ─────────────────────────────────────────────────────────────────────────

const GIVEN_UP_NOTE = {
  temporary_failure: "Your domain passed before but failed a re-check. Confirm the DNS records below are still published, then check again.",
  failed: "Your provider stopped checking this domain. Confirm every DNS record below is published exactly as shown, then check again — or disconnect and reconnect the domain to start over.",
};

/**
 * Answer one Settings → Email action for a builder on SES, or return null for a builder who is
 * not (index.ts then runs its Resend branch). The two operator actions are always answered here.
 */
export async function handleEmailSesAction(ctx: EmailSesCtx): Promise<Response | null> {
  const { action } = ctx;
  if (action === "email_ses_prepare" || action === "email_ses_cutover") {
    if (!ctx.operator) return ctx.json({ error: "Only CSM Synergy can do that." }, 403);
    const s = await readState(ctx, "read this builder's email settings");
    if (s === "pre_migration") return ctx.json({ error: "The database is not ready for this yet (migration 383)." }, 409);
    if (s instanceof Response) return s;
    return action === "email_ses_prepare" ? await prepare(ctx, s) : await cutover(ctx, s);
  }

  const s = await readState(ctx, "read your email sending settings");
  if (s === "pre_migration") return null;
  if (s instanceof Response) return s;
  if (!onSes(s)) return null;
  const domain = String(s.ses_identity);

  if (action === "email_verify_domain") {
    let identity: SesIdentity;
    try {
      identity = await sesGetIdentity(domain);
    } catch (e) {
      await ctx.admin.from("client_settings").update({
        email_last_error: "The verification check couldn't run — try again in a few minutes.",
        updated_at: nowIso(),
      }).eq("client_id", ctx.clientId);
      return sesFail(ctx, "check your domain's DNS records", e);
    }
    const verified = sesIdentityVerified(identity);
    const givenUp = sesIdentityGivenUp(identity);
    const domainStatus = verified ? "verified" : givenUp ? "failed" : "pending";
    const dnsRecords = rowsOf(s.email_dns_records).map((r) => (isDkimRow(r) ? { ...r, verified: identity.dkim.status === "SUCCESS" } : r));

    // The reply record rides the same button: once the domain is verified and its MX is seen,
    // replies switch on with no second step. It only ever switches ON here; turning a working
    // reply address off over one DNS answer is email_inbound_verify's decision, not this one's.
    let inboundPatch: Record<string, unknown> = {};
    if (verified && s.inbound_domain && s.inbound_status !== "active") {
      const seen = await inboundMxSeen(ctx, s.inbound_domain);
      if (seen === true) {
        inboundPatch = {
          inbound_status: "active",
          inbound_dns_records: [toRow(sesInboundRecord(s.inbound_domain, true))],
          inbound_verified_at: nowIso(),
          inbound_last_error: null,
        };
      }
    }

    const { error: upErr } = await ctx.admin.from("client_settings").update({
      email_domain_status: domainStatus,
      email_dns_records: dnsRecords,
      // Kept when already set: a domain that later fails a re-check still PROVED control once,
      // which is what index.ts's "who holds this domain" rule reads.
      email_verified_at: verified ? (s.email_verified_at ?? nowIso()) : (s.email_verified_at ?? null),
      email_last_error: givenUp ? GIVEN_UP_NOTE[givenUp] : null,
      ...inboundPatch,
      updated_at: nowIso(),
    }).eq("client_id", ctx.clientId);
    if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "save your domain's verification state", upErr);
    return ctx.json({
      ok: true, verified, domainStatus, providerStatus: identity.dkim.status, dnsRecords, openTracking: "off",
      ...(inboundPatch.inbound_status ? { inboundStatus: "active" } : {}),
    });
  }

  if (action === "email_tracking_check") {
    // Out of the first SES version (2026-11-10). It returns through one tracking address on our
    // own domain, so a builder will have nothing to add to their DNS for it.
    return ctx.json({ error: "Seeing when emails are opened isn't available on your email setup yet. It's coming back soon, and you won't need to add anything to your DNS for it." }, 409);
  }

  if (action === "email_disconnect") {
    // Best-effort on the provider side, like the Resend branch: a stuck provider must not trap a
    // builder on a domain they are trying to leave.
    try {
      await sesDeleteIdentity(domain);
    } catch (e) {
      logEdgeError({
        fn: "portal-settings", req: ctx.req, clientId: ctx.clientId, code: "email_disconnect_provider",
        message: `provider identity delete failed: ${mailErrCode(e) ?? String((e as Error)?.message ?? e)}`,
      }).catch(() => {});
    }
    const { error: upErr } = await ctx.admin.from("client_settings").update({
      email_domain: null,
      email_from_local: "info",
      email_from_name: null,
      email_provider: "ghl",
      email_domain_status: "not_configured",
      email_dns_records: null,
      email_verified_at: null,
      email_last_error: null,
      ses_identity: null,
      ses_dns_records: null,
      // No domain at any provider any more, so no pin: the builder follows the platform default.
      email_transport: null,
      // Replies live on a subdomain of the sending domain, so they go in the same write.
      inbound_domain: null,
      inbound_status: "off",
      inbound_dns_records: null,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: nowIso(),
    }).eq("client_id", ctx.clientId);
    if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "disconnect your email domain", upErr);
    return ctx.json({ ok: true });
  }

  if (action === "email_inbound_connect") {
    if (s.email_domain_status !== "verified") {
      return ctx.json({ error: "Verify your sending domain first — replies use a subdomain of it." }, 400);
    }
    const inboundDomain = `reply.${domain}`;
    const { data: holder, error: holderErr } = await ctx.admin.from("client_settings")
      .select("client_id").eq("inbound_domain", inboundDomain).neq("client_id", ctx.clientId).maybeSingle();
    if (holderErr) return ctx.dbFail(ctx.req, ctx.clientId, "check that reply address", holderErr);
    if (holder) return ctx.json({ error: "That reply address is already in use by another account." }, 409);
    const mx = [toRow(sesInboundRecord(inboundDomain, false))];
    const { error: upErr } = await ctx.admin.from("client_settings").update({
      inbound_domain: inboundDomain,
      inbound_status: "pending",
      inbound_dns_records: mx,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: nowIso(),
    }).eq("client_id", ctx.clientId);
    if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "save your reply address", upErr);
    return ctx.json({ ok: true, inboundDomain, dnsRecords: mx });
  }

  if (action === "email_inbound_verify") {
    if (!s.inbound_domain) return ctx.json({ error: "Set up your reply address first." }, 400);
    // SES accepts mail only for a verified identity, so a perfect MX on an unverified domain
    // would still bounce every reply. Both, or it is not working.
    const seen = s.email_domain_status === "verified" ? await inboundMxSeen(ctx, s.inbound_domain) : false;
    // DNS could not say: leave things exactly as they are. An address that is working is not
    // switched off, and one that is waiting is not switched on, over a resolver hiccup.
    if (seen === null) {
      const active = s.inbound_status === "active";
      return ctx.json({ ok: true, verified: active, inboundStatus: active ? "active" : "pending", dnsRecords: rowsOf(s.inbound_dns_records) });
    }
    const mx = [toRow(sesInboundRecord(s.inbound_domain, seen))];
    const { error: upErr } = await ctx.admin.from("client_settings").update({
      inbound_status: seen ? "active" : "pending",
      inbound_dns_records: mx,
      inbound_verified_at: seen ? nowIso() : null,
      inbound_last_error: seen || s.email_domain_status === "verified" ? null : "Verify your sending domain first; replies switch on once it is verified.",
      updated_at: nowIso(),
    }).eq("client_id", ctx.clientId);
    if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "save your reply address", upErr);
    return ctx.json({ ok: true, verified: seen, inboundStatus: seen ? "active" : "pending", dnsRecords: mx });
  }

  if (action === "email_inbound_disconnect") {
    // Nothing to remove at the provider: the reply address was never an object there.
    const { error: upErr } = await ctx.admin.from("client_settings").update({
      inbound_domain: null,
      inbound_status: "off",
      inbound_dns_records: null,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: nowIso(),
    }).eq("client_id", ctx.clientId);
    if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "turn off your reply address", upErr);
    return ctx.json({ ok: true });
  }

  return null;
}

// ── Operator: move a builder who is on Resend ─────────────────────────────────────────────────

/** The records a Resend builder publishes for SES, with what AWS and public DNS say of them now. */
async function stagedRows(ctx: EmailSesCtx, s: State, identity: SesIdentity, dkim: SesDnsRow[]): Promise<{ rows: SesDnsRow[]; mxSeen: boolean | null }> {
  const rows = dkim.map((r) => ({ ...r, verified: identity.dkim.status === "SUCCESS" }));
  let mxSeen: boolean | null = true;
  if (s.inbound_domain) {
    mxSeen = await inboundMxSeen(ctx, s.inbound_domain);
    rows.push(toRow(sesInboundRecord(s.inbound_domain, mxSeen === true)));
  }
  return { rows, mxSeen };
}

async function prepare(ctx: EmailSesCtx, s: State): Promise<Response> {
  if (onSes(s)) return ctx.json({ error: "This builder is already on Amazon SES." }, 409);
  const domain = String(s.email_domain ?? "").trim().toLowerCase();
  if (!domain) return ctx.json({ error: "This builder has no sending domain to move. A new connect goes to the platform default by itself." }, 409);

  let identity: SesIdentity;
  let dkim: SesDnsRow[];
  let created = false;
  try {
    const stored = rowsOf(s.ses_dns_records).filter(isDkimRow);
    if (s.ses_identity === domain && stored.length) {
      // Pressed again: read what AWS says now. Never a new key (the builder may have published).
      identity = await sesGetIdentity(domain);
      dkim = stored;
    } else {
      ({ identity, dkim } = await createIdentity(domain));
      created = true;
      await quietFeedback(ctx, domain);
    }
  } catch (e) {
    return sesFail(ctx, "prepare this domain at Amazon SES", e);
  }
  const { rows, mxSeen } = await stagedRows(ctx, s, identity, dkim);
  const { error: upErr } = await ctx.admin.from("client_settings").update({
    ses_identity: domain,
    ses_dns_records: rows,
    updated_at: nowIso(),
  }).eq("client_id", ctx.clientId);
  if (upErr) {
    if (created) await discardIdentity(ctx, domain);
    return ctx.dbFail(ctx.req, ctx.clientId, "save the Amazon SES records", upErr);
  }
  return ctx.json({
    ok: true,
    // Still sending through Resend: nothing about the builder's live email has changed.
    transport: "resend",
    domainVerified: sesIdentityVerified(identity),
    providerStatus: identity.dkim.status,
    replyRecordSeen: s.inbound_domain ? mxSeen : null,
    dnsRecords: rows,
  });
}

async function cutover(ctx: EmailSesCtx, s: State): Promise<Response> {
  const back = ctx.payload?.back === true;
  const finish = ctx.payload?.finish === true;

  if (back) {
    // The way home: Resend still holds the domain, so one write puts the builder back on it.
    if (!s.resend_domain_id) return ctx.json({ error: "This builder's Resend domain is gone, so there is nothing to go back to." }, 409);
    const { error } = await ctx.admin.from("client_settings")
      .update({ email_transport: "resend", updated_at: nowIso() }).eq("client_id", ctx.clientId);
    if (error) return ctx.dbFail(ctx.req, ctx.clientId, "move this builder back to Resend", error);
    return ctx.json({ ok: true, transport: "resend" });
  }

  if (finish) {
    // The builder has settled on SES: give up the Resend domains. Each delete is best-effort and
    // logged with its id, because the write below nulls the only handle to it.
    if (!onSes(s)) return ctx.json({ error: "Cut this builder over first." }, 409);
    for (const [what, id] of [["domain", s.resend_domain_id], ["reply domain", s.resend_inbound_domain_id]] as const) {
      if (!id) continue;
      try {
        await rsDeleteDomain(String(id));
      } catch (e) {
        await logEdgeError({
          fn: "portal-settings", req: ctx.req, clientId: ctx.clientId, code: "ses_cutover_resend_delete", severity: "warn",
          message: `Resend ${what} delete failed after a cutover (id ${id}): ${mailErrCode(e) ?? String((e as Error)?.message ?? e)}`,
        }).catch(() => {});
      }
    }
    const { error } = await ctx.admin.from("client_settings")
      .update({ resend_domain_id: null, resend_inbound_domain_id: null, updated_at: nowIso() }).eq("client_id", ctx.clientId);
    if (error) return ctx.dbFail(ctx.req, ctx.clientId, "finish this builder's move", error);
    return ctx.json({ ok: true, transport: "ses", finished: true });
  }

  if (onSes(s)) return ctx.json({ ok: true, transport: "ses", already: true });
  const domain = String(s.ses_identity ?? "");
  const dkim = rowsOf(s.ses_dns_records).filter(isDkimRow);
  if (!domain || domain !== String(s.email_domain ?? "").trim().toLowerCase() || !dkim.length) {
    return ctx.json({ error: "Prepare this builder's domain at Amazon SES first." }, 409);
  }
  let identity: SesIdentity;
  try {
    identity = await sesGetIdentity(domain);
  } catch (e) {
    return sesFail(ctx, "read this domain at Amazon SES", e);
  }
  // ⚠️ THE WHOLE POINT OF THE TWO STEPS: nothing moves until AWS says the domain can send.
  if (!sesIdentityVerified(identity)) {
    return ctx.json({ error: "Amazon SES has not verified this domain yet, so it stays on Resend.", providerStatus: identity.dkim.status }, 409);
  }
  const { rows, mxSeen } = await stagedRows(ctx, s, identity, dkim);
  // A builder who receives replies must not lose them: their reply MX has to name SES first.
  // (Both providers' MX records can be live together; each feeds the same email-inbound.)
  const repliesOn = s.inbound_status === "active" && !!s.inbound_domain;
  if (repliesOn && mxSeen !== true) {
    return ctx.json({
      error: mxSeen === null
        ? "Public DNS could not be read just now, so the reply record could not be checked. Try again in a minute."
        : "The reply record does not point at Amazon SES yet, so this builder stays on Resend.",
      replyRecordSeen: mxSeen,
    }, 409);
  }
  const { error: upErr } = await ctx.admin.from("client_settings").update({
    email_transport: "ses",
    email_domain_status: "verified",
    email_dns_records: rows.filter(isDkimRow),
    email_verified_at: s.email_verified_at ?? nowIso(),
    email_last_error: null,
    ...(s.inbound_domain ? { inbound_dns_records: rows.filter((r) => !isDkimRow(r)) } : {}),
    ses_dns_records: null,
    // resend_domain_id and resend_inbound_domain_id stay: they are the way back (`back: true`)
    // until `finish: true` deletes them.
    updated_at: nowIso(),
  }).eq("client_id", ctx.clientId);
  if (upErr) return ctx.dbFail(ctx.req, ctx.clientId, "move this builder to Amazon SES", upErr);
  return ctx.json({ ok: true, transport: "ses" });
}
