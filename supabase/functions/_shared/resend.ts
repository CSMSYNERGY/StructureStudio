/**
 * Resend transport: sender-domain provisioning and email sending, one API.
 *
 * DARK FILE — nothing imports this yet. Postmark rejected the account on 2026-08-13 (appeal
 * pending); Resend is the runner-up, and this module exists so that if the appeal fails the
 * platform switches providers by swapping the transport underneath `emailSend.ts` instead of
 * rewriting the email path under pressure. It deliberately mirrors postmark.ts — same leaf
 * shape, same error contract, same test posture — so the swap is a rename, not a redesign.
 *
 * Like postmark.ts, this file is TRANSPORT ONLY: typed errors, request-time secrets, safe
 * error surfaces. It holds no supabase client, writes no ledger, and never decides whether
 * an email SHOULD be sent; `emailSend.ts` owns outcomes and the `email_sends` rows. Keeping
 * the transport a leaf module with zero imports is also what lets the preflight gate
 * unit-test it offline with a stubbed fetch (see resend.test.ts).
 *
 * THE RULE THIS FILE ENFORCES (inherited from postmark.ts): every failure carries a verdict —
 * is a retry pointless? `permanent` is claimed only on positive evidence: a 400 whose error
 * name is `validation_error`, any 403 (Resend uses it for "this request may not do that",
 * e.g. testing-mode recipient restrictions), a 404 `not_found`, or a 422 (invalid/missing
 * fields). A 429 (`rate_limit_exceeded`), any 5xx, a network failure, an unreadable body, or
 * anything unrecognized stays retryable — a wrongly-permanent verdict strands an email that
 * would have gone through on the next attempt, and that is the more expensive mistake.
 *
 * Resend facts callers must not have to re-learn:
 *   - ONE key does everything. `RESEND_API_KEY` authorizes both domain provisioning and
 *     sending (`Authorization: Bearer`), unlike Postmark's account/server token split — so
 *     configured-ness is a single check and there is no per-API token to mix up.
 *   - Domain-level `status` values: "not_started" | "pending" | "verified" | "failed" |
 *     "temporary_failure". Only `rsDomainVerified` (status === "verified") means usable;
 *     "temporary_failure" is a previously-passing domain that failed a periodic re-check.
 *   - Resend returns DNS record hosts as RELATIVE names ("send", "resend._domainkey").
 *     A UI rendering those verbatim hands the tenant a record that lands at the wrong node.
 *     Normalization happens HERE: every record carries both `host` (Resend's relative name,
 *     what a DNS panel's "Name" field usually wants) and `fqdn` (host + domain, built from
 *     the response's own `name`), so no caller ever appends the domain itself.
 *   - The verify endpoint acknowledges with only `{object, id}` — no records, no status —
 *     so rsVerifyDomain follows the POST with a GET. That GET is not just the consolidated
 *     read postmark.ts does for freshness; it is the only full-shape read available.
 *
 * Error bodies are never surfaced raw. Resend's `message` field can echo RECIPIENT
 * ADDRESSES (e.g. its testing-mode 403 names the address you may send to), and a lead's
 * email must not land in app_errors or a tenant-facing string — the postmark.ts posture.
 * Only the HTTP status and the enum-ish error `name` survive, and the name is kept ONLY
 * when it matches the lowercase-snake shape Resend's error names use — a body field that
 * fails that gate could carry anything, so it is dropped rather than trusted.
 */

const API_BASE = "https://api.resend.com";

/** Read at REQUEST time, never at module top: a module-top read needs a redeploy to pick
 *  up a rotated secret, which cost us a debugging session on Deposyt. */
function apiKey(): string | null {
  return Deno.env.get("RESEND_API_KEY") || null;
}

/** The ONE test for "may the Resend path run at all" — a single key covers domains and
 *  sending, so unlike postmarkConfigured there are no halves to check. */
export function resendConfigured(): boolean {
  return apiKey() !== null;
}

export class ResendNotConfigured extends Error {
  constructor(msg = "Resend is not configured on this deployment.") {
    super(msg);
    this.name = "ResendNotConfigured";
  }
}

/**
 * A Resend API call that answered non-OK, or could not be reached at all.
 *
 * `permanent` answers "is a Retry pointless?" — claimed only on the positive evidence in
 * `verdictOf` below. `status` is 0 when no HTTP answer arrived. `name_` holds Resend's
 * enum-ish error name ("validation_error", "not_found", …) or "" when the body carried
 * none we trust; the trailing underscore exists because `Error.name` is already taken by
 * the class name ("ResendApiError").
 */
export class ResendApiError extends Error {
  readonly status: number;
  readonly name_: string;
  readonly permanent: boolean;
  constructor(init: { message: string; status: number; name_: string; permanent: boolean }) {
    super(init.message);
    this.name = "ResendApiError";
    this.status = init.status;
    this.name_ = init.name_;
    this.permanent = init.permanent;
  }
}

/**
 * Positive evidence that an identical retry fails identically:
 *   400 validation_error  the request itself is malformed (bad from/to/body)
 *   403                   the key may not do this — domain not yours, testing-mode
 *                         recipient restriction, plan restriction; a human unblocks
 *                         these, not a retry loop
 *   404 not_found         the domain/email id does not exist on this account
 *   422                   invalid or missing fields — the request must change to succeed
 * Everything else — 429, 5xx, network, an unrecognized shape, a 401 a key rotation would
 * fix without a code change — stays retryable.
 */
function verdictOf(status: number, name_: string): boolean {
  if (status === 400 && name_ === "validation_error") return true;
  if (status === 403) return true;
  if (status === 404 && name_ === "not_found") return true;
  if (status === 422) return true;
  return false;
}

/** Pull ONLY the enum-ish `name` out of a Resend error body. `message` is never read — see
 *  the header: it echoes recipient addresses. The charset gate is what makes `name` safe to
 *  surface at all: Resend's error names are lowercase snake_case, which cannot spell an
 *  email address, so anything else is dropped rather than trusted. */
function errorNameOf(body: string): string {
  try {
    const name = (JSON.parse(body) as { name?: unknown })?.name;
    return typeof name === "string" && /^[a-z0-9_]{1,64}$/.test(name) ? name : "";
  } catch {
    return "";
  }
}

function requireKey(): string {
  const key = apiKey();
  if (!key) throw new ResendNotConfigured("RESEND_API_KEY is not set.");
  return key;
}

/** One authenticated round trip. Failures throw ResendApiError with the verdict attached;
 *  successes return the parsed JSON (null when the body is empty or unparsable). */
async function rsFetch(key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (e) {
    // Could not reach Resend at all — nothing about the REQUEST has been judged, so
    // permanence cannot be claimed. The message carries only our own URL and the runtime's
    // network error text, never provider or customer data.
    throw new ResendApiError({
      message: `Could not reach Resend: ${(e as Error).message}`,
      status: 0,
      name_: "",
      permanent: false,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const name_ = errorNameOf(text);
    throw new ResendApiError({
      message: `Resend API ${res.status} on ${path.split("?")[0]}`
        + (name_ ? ` — ${name_}` : ""),
      status: res.status,
      name_,
      permanent: verdictOf(res.status, name_),
    });
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * One DNS record the tenant must hold, normalized. `purpose` is Resend's `record` field
 * ("SPF" | "DKIM" today); `type` is "TXT" | "CNAME" | "MX" today — both kept as string so a
 * value Resend adds later passes through instead of being coerced into a lie. `host` is the
 * relative name exactly as Resend gave it; `fqdn` is the absolute name built here (see the
 * header). `priority` is present only on MX records — dropping it would hand the tenant an
 * MX they cannot actually create.
 */
export type RsDnsRecord = {
  purpose: string;
  host: string;
  fqdn: string;
  type: string;
  value: string;
  verified: boolean;
  priority?: number;
};

/** One sender domain, normalized. `status` is Resend's domain-level enum (see the header);
 *  gate usability on `rsDomainVerified`, never on records alone. */
export type RsDomain = {
  id: string;
  status: string;
  records: RsDnsRecord[];
  /** Resend's per-capability switches, e.g. `{ sending: "enabled", receiving: "disabled" }`.
   *  Receiving is OFF unless asked for at create time, and a domain object carries both —
   *  which is why an inbound subdomain is a separate domain, not a flag on the sending one. */
  capabilities?: { sending?: string; receiving?: string };
};

/** The ONE meaning of "usable": Resend has checked the records and says verified. Every
 *  other status — including "pending" and "temporary_failure" — is not-yet/no-longer. */
export function rsDomainVerified(d: RsDomain): boolean {
  return d.status === "verified";
}

/**
 * Build the absolute record name from Resend's relative one.
 *
 * ⚠️ Resend's `name` is relative to the ZONE APEX, not to the sending domain. For the
 * sending domain mail.example.com the DKIM row comes back as "resend._domainkey.mail" and
 * the SPF rows as "send.mail" — because that is what a DNS panel's Name field wants, and
 * that panel is scoped to the zone example.com. Appending the whole sending domain would
 * DOUBLE the "mail" label and hand the tenant a record that lands at the wrong node.
 * (Observed live 2026-08-21 against a real create-domain response, not inferred.)
 *
 * It matters twice: our own platform domain is a subdomain, and Resend explicitly
 * recommends builders send from a subdomain rather than their root domain.
 *
 * So: strip the overlap. Find the longest label-aligned suffix of `host` that is also a
 * label-aligned PREFIX of `domain`, and append only the remainder. Longest-first, because
 * a shorter accidental match would leave a duplicated label behind. Root domains have no
 * overlap and fall through to plain concatenation, which is why this was invisible until a
 * subdomain was tried.
 */
function toFqdn(host: string, domain: string): string {
  if (!domain) return host;
  if (!host || host === "@") return domain;
  if (host === domain || host.endsWith(`.${domain}`)) return host;

  const hostLabels = host.split(".");
  const domainLabels = domain.split(".");
  for (let n = Math.min(hostLabels.length, domainLabels.length); n > 0; n--) {
    const hostTail = hostLabels.slice(hostLabels.length - n).join(".");
    const domainHead = domainLabels.slice(0, n).join(".");
    if (hostTail === domainHead) {
      const rest = domainLabels.slice(n).join(".");
      return rest ? `${host}.${rest}` : host;
    }
  }
  return `${host}.${domain}`;
}

function toRsRecord(raw: unknown, domain: string): RsDnsRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const host = str(r.name);
  const rec: RsDnsRecord = {
    purpose: str(r.record),
    host,
    fqdn: toFqdn(host, domain),
    type: str(r.type),
    value: str(r.value),
    verified: r.status === "verified",
  };
  if (typeof r.priority === "number" && Number.isFinite(r.priority)) rec.priority = r.priority;
  return rec;
}

/** Normalize one Resend domain response. The `fqdn` on each record is built from the
 *  response's own `name`, so every read path (create, get, verify) yields the same shape
 *  without the caller ever supplying the domain twice. */
function toRsDomain(raw: unknown): RsDomain {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const domainName = str(d.name);
  const rawRecords = Array.isArray(d.records) ? d.records : [];
  const caps = (d.capabilities ?? null) as Record<string, unknown> | null;
  const out: RsDomain = {
    id: str(d.id),
    status: str(d.status),
    records: rawRecords.map((r) => toRsRecord(r, domainName)),
  };
  if (caps && typeof caps === "object") {
    out.capabilities = { sending: str(caps.sending), receiving: str(caps.receiving) };
  }
  return out;
}

/**
 * The record(s) a tenant must publish to RECEIVE mail on this domain.
 *
 * ⚠️ FILTERED ON `purpose === "Receiving"`, NOT ON type === "MX". A domain with BOTH
 * capabilities on returns TWO MX rows, and they mean opposite things — confirmed against a
 * live response 2026-08-28:
 *
 *   { record: "SPF",       name: "send.reply", type: "MX", value: "feedback-smtp.…amazonses.com" }
 *   { record: "Receiving", name: "reply",      type: "MX", value: "inbound-smtp.…amazonaws.com"  }
 *
 * The first is the bounce return-path for mail SENT from the subdomain; only the second
 * receives. A type-based filter hands the builder both and lets them publish the wrong one
 * as their inbound MX — mail silently bouncing, with the DNS table insisting it is correct.
 * An earlier version of this function did exactly that, on the reasoning that a receiving
 * domain has no return-path row. It does.
 *
 * ⚠️ RETURNS AN EMPTY ARRAY RATHER THAN INVENTING A HOSTNAME. The caller must fail loudly:
 * hardcoding `inbound-smtp.us-east-1.amazonaws.com` would be a guess that rots the day
 * Resend changes region or host, and a wrong MX bounces mail with no error anywhere.
 */
export function rsInboundRecords(d: RsDomain): RsDnsRecord[] {
  return (d.records ?? []).filter((r) => String(r.purpose ?? "") === "Receiving");
}

/** Whether Resend says this domain can accept mail at all. A capability switch, not a DNS
 *  verdict — pair it with rsInboundReady, which checks whether the record actually resolves. */
export function rsReceivingEnabled(d: RsDomain): boolean {
  return d.capabilities?.receiving === "enabled";
}

/**
 * The ONE meaning of "replies are actually working".
 *
 * ⚠️ DELIBERATELY NOT rsDomainVerified. That reports the DOMAIN-level status, which only
 * turns "verified" once EVERY record passes — including the DKIM and SPF rows a
 * receiving-only subdomain has no reason to publish. Gating on it would leave a tenant whose
 * inbound MX resolves perfectly stuck on "pending" forever, with a correct DNS table in
 * front of them and no way to proceed.
 *
 * So ask the narrower question the feature actually depends on: is receiving switched on,
 * and has the receiving record itself been seen in DNS? Requires at least one record, so an
 * empty set can never read as ready.
 */
export function rsInboundReady(d: RsDomain): boolean {
  if (!rsReceivingEnabled(d)) return false;
  const inbound = rsInboundRecords(d);
  return inbound.length > 0 && inbound.every((r) => r.verified);
}

/**
 * Create a sender domain on the Resend account. The region is pinned to us-east-1: the
 * region is baked into the SPF record's value (feedback-smtp.<region>.amazonses.com), so a
 * per-tenant choice would make otherwise-identical tenants hold different DNS for no
 * requirement anyone has stated.
 */
export async function rsCreateDomain(
  name: string,
  opts?: { receiving?: boolean },
): Promise<RsDomain> {
  const key = requireKey();
  const raw = await rsFetch(key, "/domains", {
    method: "POST",
    body: JSON.stringify({
      name,
      region: "us-east-1",
      // Receiving defaults to disabled, so this key is sent only when asked for — a domain
      // created for SENDING must never quietly start accepting mail, and omitting the key
      // keeps the request byte-identical to what it was before receiving existed.
      //
      // ⚠️ A RECEIVING DOMAIN ASKS FOR RECEIVING ONLY. With sending also enabled, Resend
      // returns DKIM + SPF rows for the subdomain as well, so the builder must publish FOUR
      // records instead of ONE to reach a verified domain — on a subdomain we never send
      // from. Every extra record is another chance for the hand-off to their web guy to
      // fail, which is where this flow already dies.
      ...(opts?.receiving ? { capabilities: { sending: "disabled", receiving: "enabled" } } : {}),
    }),
  });
  return toRsDomain(raw);
}

/** Read one domain's current records + verification state. */
export async function rsGetDomain(id: string): Promise<RsDomain> {
  const key = requireKey();
  return toRsDomain(await rsFetch(key, `/domains/${id}`));
}

/**
 * Ask Resend to check the DNS records, then report one fresh full read. The verify POST
 * acknowledges with only `{object, id}` — the follow-up GET is the only way to get records
 * and status at all, and it also means a caller can never see a half-updated shape. A check
 * that simply finds the records absent is NOT an error — the domain comes back with its
 * status still unverified; a thrown ResendApiError here means the API call itself failed.
 */
export async function rsVerifyDomain(id: string): Promise<RsDomain> {
  const key = requireKey();
  await rsFetch(key, `/domains/${id}/verify`, { method: "POST" });
  return toRsDomain(await rsFetch(key, `/domains/${id}`));
}

/** Remove a domain from the Resend account (the disconnect path). */
export async function rsDeleteDomain(id: string): Promise<void> {
  const key = requireKey();
  await rsFetch(key, `/domains/${id}`, { method: "DELETE" });
}

/**
 * One outgoing email. Unlike PmSendInput (Postmark's PascalCase names, passed through),
 * these are our names: only `replyTo` differs from the wire (`reply_to`), and rsSendEmail
 * owns that mapping. `tags` carry `{client_id, short_code, kind}`-style telemetry — how one
 * shared account stays filterable per tenant in Resend's dashboard.
 */
export type RsSendInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  /** Custom RFC 5322 headers. Used for `Message-ID`, so a reply's In-Reply-To is matchable —
   *  the provider's own send id never is (see _shared/emailInbound.ts buildThreadMessageId).
   *  Omitted from the wire entirely when absent, so a caller that passes nothing sends
   *  exactly the bytes it sent before this field existed. */
  headers?: Record<string, string>;
};

/** Resend rejects the WHOLE send with a 422 when a tag name or value carries anything
 *  outside ASCII letters/numbers/underscores/dashes — so a tenant slug or short code with a
 *  dot would fail the email over telemetry. Degrading the tag is the right trade: the send
 *  survives, and the sanitized value stays recognizable in the dashboard. */
function sanitizeTag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Send one email. Returns Resend's email `id` — persist it on the `email_sends` row
 * IMMEDIATELY: it is the only key delivery/bounce webhooks can match on, so a lost id is a
 * send whose fate is unknowable (the pmSendEmail rule, unchanged).
 */
export async function rsSendEmail(input: RsSendInput): Promise<{ id: string }> {
  const key = requireKey();
  const raw = await rsFetch(key, "/emails", {
    method: "POST",
    // JSON.stringify drops undefined-valued keys, so optional fields the caller omitted
    // never appear on the wire.
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.replyTo,
      // Undefined when the caller passed none, and JSON.stringify then drops the key.
      headers: input.headers && Object.keys(input.headers).length ? input.headers : undefined,
      tags: input.tags?.map((t) => ({ name: sanitizeTag(t.name), value: sanitizeTag(t.value) })),
    }),
  });
  const msg = (raw ?? {}) as Record<string, unknown>;
  return { id: typeof msg.id === "string" ? msg.id : "" };
}
