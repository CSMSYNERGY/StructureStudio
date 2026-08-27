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
