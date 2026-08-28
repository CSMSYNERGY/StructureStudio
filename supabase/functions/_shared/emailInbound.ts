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
 *  customer's sentence to an over-eager regex is worse than showing some quoted text.
 *
 * ⚠️ THE `>` HISTORY IS FILTERED OUT, NOT CUT AT. Cutting at the first quoted line read an
 * INLINE reply — the shape Gmail and Apple Mail both encourage — as if it ended where the
 * quote began: "Yes, let's go ahead." was stored and "But change the door to the 6ft, and I
 * need it by the 12th" underneath it was dropped, with nothing in the feed to say so and no
 * second surface to recover it from (crmFeed never selects body_html, and a plain-text
 * sender has none at all). Quoted lines carry their own `>` tag, so they can be removed
 * wherever they sit and the writer's own lines survive on either side of them.
 *
 * The Outlook trailers below still CUT, because they introduce the original message with no
 * per-line prefix: nothing tells its lines apart from the writer's, so everything under one
 * of them is history.
 */
export function stripQuoted(body: string): string {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const cuts = [
    text.search(/\n-{2,}\s*Original Message\s*-{2,}/i),          // Outlook
    text.search(/\n_{10,}\n/),                                   // Outlook rule
    text.search(/\nFrom:\s.+\nSent:\s/i),                        // Outlook headers
  ].filter((i) => i > 0);
  const head = cuts.length ? text.slice(0, Math.min(...cuts)) : text;
  const lines = head.split("\n");
  const own = lines.filter((ln) =>
    !/^\s*>/.test(ln) &&                            // a quoted line
    !/^\s*On .{5,120}\bwrote:\s*$/.test(ln)         // Gmail / Apple Mail attribution
  );
  // Re-flow only when something was actually removed: a quote lifted out of the middle leaves
  // a run of blank lines where it stood and the feed renders pre-wrap, but a body we did not
  // touch must reach the builder exactly as the customer typed it.
  const kept = (own.length === lines.length ? head : own.join("\n").replace(/\n{3,}/g, "\n\n")).trim();
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

/** Build the routable reply address — the exact inverse of parseReplyToken, and its neighbour
 *  so the two spellings can never drift apart.
 *
 *   d.ss-9r8uhjgtdj@reply.jrbarns.com   → that design
 *   c.<contact-uuid>@reply.jrbarns.com  → that person
 *
 * Returns null unless the tenant's inbound domain is genuinely ACTIVE and there is something
 * to reference. Null is the signal to fall back to a real human's inbox, which is a good
 * outcome — the reply reaches someone immediately, it just does not appear in the portal.
 *
 * ⚠️ 'pending' MUST NOT PRODUCE AN ADDRESS. A tenant who has typed the domain but not proved
 * MX control has no working mailbox there, and a Reply-To pointing at dead MX means the
 * customer's reply bounces back to the CUSTOMER while the builder learns nothing. The old
 * behaviour — a staff member's own address — is strictly better than that, so the bar for
 * replacing it is a domain that has actually been verified.
 *
 * Lowercased throughout: a local part is compared case-insensitively in practice, short codes
 * are uppercase on the row, and the webhook lowercases before matching.
 */
export function buildReplyAddress(
  inboundDomain: unknown,
  inboundStatus: unknown,
  ref: { shortCode?: string | null; contactId?: string | null },
): string | null {
  const dom = String(inboundDomain ?? "").trim().toLowerCase();
  if (!dom || !dom.includes(".") || String(inboundStatus ?? "") !== "active") return null;
  const local = ref.shortCode
    ? `d.${String(ref.shortCode).trim()}`
    : (ref.contactId ? `c.${String(ref.contactId).trim()}` : "");
  // A send with neither a design nor a contact has nothing to route back to. Guarded rather
  // than templated, or a null id renders the literal address `c.null@reply.<domain>`.
  if (local === "d." || local === "c." || !local) return null;
  return `${local.toLowerCase()}@${dom}`;
}

/** The client_id an inbound message is filed under when no tenant can be proved.
 *
 * Lives here, not inline in the webhook, because the recovery story depends on this exact
 * string: the operator's `where client_id = …` query has to match what the insert wrote, and
 * a re-typed literal that drifts by one character strands the rows silently. An underscore
 * cannot occur in a real client id (they are DNS-safe slugs, `[a-z0-9-]+`), so this can never
 * collide with a tenant. See envelopeRecipients' closing paragraphs for what reaching this
 * state means and for why the row is written at all.
 */
export const UNATTRIBUTED_CLIENT_ID = "__unattributed__";

/** Every recipient address the RECEIVING side reported, for choosing a tenant from.
 *
 * ⚠️ THIS IS A SECURITY BOUNDARY, not a convenience. The `To:` header is written by whoever
 * composed the message; the SMTP envelope (RCPT TO) is written by the sending MTA and is what
 * actually routed the mail to us. Choosing a tenant from `To:` lets anyone who has seen a
 * quote link — and those get forwarded to spouses, lenders and Facebook groups — mail us with
 * `To: d.SS-XXXX@reply.someoneelse.com` and post whatever they like onto that builder's
 * conversation feed. The short code is a capability for READING a design, never a
 * capability for writing to a tenant's record.
 *
 * Every provider spells its recipient field differently, so this returns every candidate it
 * can find and the caller takes whichever resolves to a tenant. ⚠️ THE ENTRIES ARE NOT ALL
 * THE SAME GRADE OF EVIDENCE, and this function does not mark which is which — read the list
 * before you trust one, and do NOT read the order as a ranking:
 *
 *   TRUE SMTP-ENVELOPE FIELDS — the address the accepting MTA was handed at RCPT TO, which
 *   the sender does not get to choose the text of:
 *     SES via SNS  receipt.recipients[]
 *     SendGrid     envelope (a JSON *string*) -> { to: [...] }
 *     Mailgun      recipient
 *     CloudMailin  envelope.to
 *
 *   NOT AN ENVELOPE FIELD — PARSED OUT OF MESSAGE HEADERS, forgeability UNPROVEN:
 *     Resend       received_for — see the ⚠️ below. It stays in the list because without it
 *                  Resend, the provider we actually ship on, resolves nothing at all.
 *
 * ⛔ NO PROVIDER'S `to` IS READ, IN EITHER SPELLING. It is fine for display; it is never
 * evidence. This used to push Resend's `data.to[]` on the strength of a comment calling it
 * "an envelope-derived array" — an assumption nobody had checked against a live payload, and
 * a false one for SendGrid, listed right above, whose `to` is documented as taken from the
 * message HEADERS with `envelope` as the separate SMTP field. One crafted reply — envelope
 * to a domain the sender legitimately holds a design on, `To:` naming another builder's
 * reply domain — was enough to file a stranger's words onto that builder's conversation.
 *
 * ⚠️ RESEND'S `received_for` IS HEADER-PARSED, SO THE UNFORGEABILITY THIS COMMENT OPENS WITH
 * IS NOT ESTABLISHED FOR IT. Resend documents the field as "the recipient addresses the email
 * was FORWARDED for, taken from the `for` clause of the message's Received headers". Only the
 * TOPMOST Received header is written by the MTA that accepted the mail; every header below it
 * arrived inside the message the sender composed, so a sender can put
 * `Received: … for <d.SS-XXXX@reply.someoneelse.com>` into their own message and hope it is
 * read back out. Whether Resend reads only its own header or walks the stack is undocumented
 * and untested here. Nor is it documented whether the field is populated at all on a DIRECT
 * (non-forwarded) reply, and no Resend webhook has ever round-tripped here — so if it is
 * absent this returns [] for every ordinary reply, not for an edge case.
 *
 * ⚠️ THE LIVE ROUND TRIP BEFORE RECEIVING GOES LIVE MUST BE A FORGERY TEST, NOT A PRESENCE
 * TEST. Sending one clean message and watching an address appear proves only that the field
 * is populated; it says nothing about WHO chose the value, which is the whole question. Send
 * a message to a tenant's reply address carrying its own
 * `Received: … for <address at ANOTHER tenant's domain>` header and read what the webhook
 * posted (`GET /emails/receiving/{id}` shows the same object, and the parsed `headers` carry
 * the delivered recipient). If the forged address surfaces in `received_for`, this field
 * chooses a tenant from sender-supplied text and must stop feeding the tenant decision. If
 * only the genuinely delivered address appears, record that test here and the field can be
 * moved up into the envelope list. If it is simply missing, add whichever field DOES carry
 * the delivered recipient — never fall back to `to`, whose forgeability is the whole point of
 * the ⛔ above.
 *
 * A PAYLOAD CARRYING NO USABLE RECIPIENT THEREFORE RESOLVES NOTHING, and the caller does not
 * discard it: email-inbound/index.ts logs `inbound_no_tenant` (shapes only, no addresses) and
 * STILL INSERTS the row, with contact_id and short_code null and client_id set to the
 * UNATTRIBUTED_CLIENT_ID sentinel above — email_inbound.client_id is NOT NULL, so an unfilable
 * row cannot carry a null tenant.
 *
 * ⚠️ THOSE ROWS ARE REACHABLE ONLY BY RAW SQL TODAY. There is no screen, and no product
 * surface can show them: RLS (`client_id = current_client_id()`) resolves through client_users
 * and the sentinel is nobody's tenant; crmFeed filters on client_id AND requires a short_code
 * or a contact_id, both null on these rows; and operator view-as cannot even name the
 * sentinel, because assertClient's slug test (`^[a-z0-9][a-z0-9-]*$`) rejects the underscore.
 * So re-linking one means an operator running SQL against the database by hand. A RUN of them
 * is therefore not a backlog to work through later — it means the provider field above is
 * wrong and must be chased immediately. The trade is stated plainly: refusing to guess a
 * tenant costs an unfiled row here, never a deleted one.
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

  push(msg.recipient ?? p.recipient);   // Mailgun — envelope
  push(msg.received_for);               // Resend — HEADER-parsed, not envelope; see the docstring
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
