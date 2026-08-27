// Pure parsing helpers for the inbound-email webhook.
//
// They live here rather than in email-inbound/index.ts for one concrete reason: that file
// calls Deno.serve() at the top level, so importing it from a test starts a server and the
// runner dies before a single case runs. _shared is also where every other testable helper
// in this codebase lives.
//
// These four decide whether a customer's reply reaches the right record, reaches the WRONG
// record, or is silently mangled -- and none of those failures raises. A bad address parse
// just fails to match; an over-eager quote stripper just makes the customer's sentence
// disappear. Hence emailInbound.test.ts.

/** Constant-time compare, same as postmark-events. Exported for tests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** `"Jane Yoder" <jane@x.com>` → { email, name }. Providers are inconsistent about which
 *  shape they send, and some send an object, so every caller goes through this. */
export function parseAddress(v: unknown): { email: string; name: string | null } {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const e = typeof o.email === "string" ? o.email : (typeof o.address === "string" ? o.address : "");
    const n = typeof o.name === "string" ? o.name : null;
    if (e) return { email: e.trim().toLowerCase(), name: n };
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim().toLowerCase(), name: (m[1] || "").trim() || null };
  return { email: s.toLowerCase(), name: null };
}

/** Pull the FIRST Message-ID out of a References/In-Reply-To header. Both may carry several
 *  space-separated ids; the one we care about is whichever matches a row we sent, so the
 *  caller tries them in order rather than guessing. */
export function messageIds(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^<|>$/g, ""))
    .filter((s) => s.length > 0 && s.length < 400)
    .slice(0, 10);
}

/** Strip the quoted history off a reply so the feed shows what the person actually wrote.
 *  Conservative on purpose: if none of the markers hit, the whole body is kept. Losing a
 *  customer's sentence to an over-eager regex is worse than showing some quoted text. */
export function stripQuoted(body: string): string {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const cuts = [
    text.search(/\n>\s*[^\n]/),                                  // quoted block
    text.search(/\nOn .{5,120}\bwrote:\s*\n/),                   // Gmail / Apple Mail
    text.search(/\n-{2,}\s*Original Message\s*-{2,}/i),          // Outlook
    text.search(/\n_{10,}\n/),                                   // Outlook rule
    text.search(/\nFrom:\s.+\nSent:\s/i),                        // Outlook headers
  ].filter((i) => i > 0);
  const at = cuts.length ? Math.min(...cuts) : -1;
  const kept = (at > 0 ? text.slice(0, at) : text).trim();
  return kept || text.trim();
}

/** Decode the routing token we put in the Reply-To local part.
 *
 *   d.ss-9r8uhjgtdj@reply.jrbarns.com  -> { kind: "design",  id: "SS-9R8UHJGTDJ" }
 *   c.<uuid>@reply.jrbarns.com         -> { kind: "contact", id: "<uuid>" }
 *
 * This is the PRIMARY routing signal, ahead of In-Reply-To, because the address is the one
 * thing that always survives a round trip: it is what the customer's mail client puts in
 * the To field. References and In-Reply-To headers get stripped and rewritten by real
 * clients all the time — Outlook especially — which is why header matching alone left
 * replies unfiled.
 *
 * Short codes are uppercase on the row but lowercase in an address, so the design id is
 * re-uppercased. A uuid is already lowercase.
 */
export function parseReplyToken(addr: unknown): { kind: "design" | "contact"; id: string } | null {
  const local = String(addr ?? "").trim().toLowerCase().split("@")[0];
  const m = /^([dc])\.([a-z0-9-]{4,64})$/.exec(local);
  if (!m) return null;
  return m[1] === "d"
    ? { kind: "design", id: m[2].toUpperCase() }
    : { kind: "contact", id: m[2] };
}

/** The SMTP envelope recipients (RCPT TO), which is the only recipient a sender cannot forge.
 *
 * ⚠️ THIS IS A SECURITY BOUNDARY, not a convenience. The `To:` header is written by whoever
 * composed the message; the envelope is written by the sending MTA and is what actually
 * routed the mail to us. Choosing a tenant from `To:` lets anyone who has seen a quote link
 * — and those get forwarded to spouses, lenders and Facebook groups — mail us with
 * `To: d.SS-XXXX@reply.someoneelse.com` and post whatever they like onto that builder's
 * conversation feed. The short code is a capability for READING a design, never a
 * capability for writing to a tenant's record.
 *
 * Every provider spells the envelope differently, so this returns ALL candidates in
 * confidence order and the caller takes the first that resolves to a tenant:
 *   Resend      data.to[] (+ received_for[] when the mail was forwarded)
 *   Mailgun     recipient
 *   SendGrid    envelope (a JSON *string*) -> { to: [...] }
 *   SES via SNS receipt.recipients[]
 *   CloudMailin envelope.to
 * Header `to`/`To` is deliberately EXCLUDED. It is fine for display; it is never evidence.
 */
export function envelopeRecipients(payload: unknown, m: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (v && typeof v === "object") { push((v as Record<string, unknown>).email ?? (v as Record<string, unknown>).address); return; }
    const s = String(v ?? "").trim().toLowerCase();
    // Tolerate a display-name wrapper; some MTAs put one on the envelope copy.
    const bare = /<([^>]+)>/.exec(s)?.[1]?.trim() ?? s;
    if (bare.includes("@") && bare.length < 320 && !out.includes(bare)) out.push(bare);
  };

  const p = (payload ?? {}) as Record<string, unknown>;
  const msg = (m ?? {}) as Record<string, unknown>;

  // SES delivers the envelope on the SNS receipt, OUTSIDE the mail object.
  const receipt = (p.receipt ?? msg.receipt) as Record<string, unknown> | undefined;
  if (receipt && typeof receipt === "object") push(receipt.recipients);

  // SendGrid ships `envelope` as a JSON string; CloudMailin ships an object.
  const env = msg.envelope ?? p.envelope;
  if (typeof env === "string") {
    try { push((JSON.parse(env) as Record<string, unknown>)?.to); } catch { /* not JSON: ignore */ }
  } else if (env && typeof env === "object") {
    push((env as Record<string, unknown>).to);
  }

  push(msg.recipient ?? p.recipient);   // Mailgun
  push(msg.received_for);               // Resend, forwarded mail
  push(msg.to);                         // Resend `data.to[]` — an envelope-derived array
  return out;
}

/** Build the RFC 5322 Message-ID we put on outbound mail, encoding what the reply belongs to.
 *
 *   <ss.junior-barns.d.ss-9r8uhjgtdj.k3f9x2@jrbarns.com>
 *
 * WHY THIS EXISTS. The obvious design — store the provider's send id and match a reply's
 * In-Reply-To against it — CANNOT WORK, and shipped broken: `email_sends.provider_message_id`
 * holds Resend's API id (a bare uuid, no `@`), while In-Reply-To always carries an RFC 5322
 * id ending `@domain`. A string with no `@` can never equal one that has it, so that join has
 * matched zero rows on every send since it was written. Generating the id ourselves makes it
 * comparable AND self-describing, so a reply routes with no database round trip at all.
 *
 * `clientId` is carried so a reply can be checked against the tenant the envelope already
 * chose: a Message-ID is echoed back by the customer's mail client and is therefore
 * ATTACKER-VISIBLE, exactly like the short code. It narrows WITHIN a tenant; it must never
 * select one. Callers enforce that.
 *
 * Dots separate the fields, so no field may contain one: client ids are DNS-safe slugs and
 * short codes / uuids are alphanumeric-plus-dash. Returns null rather than a malformed id if
 * that ever stops being true.
 */
export function buildThreadMessageId(
  clientId: string,
  domain: string,
  ref: { shortCode?: string | null; contactId?: string | null },
  rand = Math.random().toString(36).slice(2, 10),
): string | null {
  const cid = String(clientId ?? "").trim().toLowerCase();
  const dom = String(domain ?? "").trim().toLowerCase().replace(/^@/, "");
  const kind = ref.shortCode ? "d" : (ref.contactId ? "c" : "");
  const id = String((ref.shortCode ?? ref.contactId) ?? "").trim().toLowerCase();
  if (!cid || !dom || !kind || !id) return null;
  if (!/^[a-z0-9-]+$/.test(cid) || !/^[a-z0-9-]+$/.test(id) || !/^[a-z0-9.-]+$/.test(dom)) return null;
  return `<ss.${cid}.${kind}.${id}.${rand}@${dom}>`;
}

/** Inverse of buildThreadMessageId. Accepts the id with or without angle brackets. */
export function parseThreadMessageId(
  raw: unknown,
): { clientId: string; kind: "design" | "contact"; id: string } | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  const local = s.split("@")[0];
  const m = /^ss\.([a-z0-9-]+)\.([dc])\.([a-z0-9-]+)\.[a-z0-9]+$/.exec(local);
  if (!m) return null;
  return {
    clientId: m[1],
    kind: m[2] === "d" ? "design" : "contact",
    // Short codes are uppercase on the row but lowercase in a Message-ID, same as the
    // reply-token address. A uuid is already lowercase, so upper-casing would break it.
    id: m[2] === "d" ? m[3].toUpperCase() : m[3],
  };
}
