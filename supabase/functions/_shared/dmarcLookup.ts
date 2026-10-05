/**
 * Whether a builder's sending domain ALREADY has a DMARC record, read from public DNS
 * (DNS-over-HTTPS), for Settings → Email Settings (portal-settings email_status).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────
 * Resend hands out SPF + DKIM and never a DMARC record, and a new domain with only those two
 * lands in Gmail's spam (proven live 2026-08-21). So the DNS table always added a fourth,
 * advisory row: publish `v=DMARC1; p=none; rua=…` at _dmarc.<domain>. It never looked first.
 * Every builder domain waiting to move on 2026-10-05 already had one, one of them p=reject.
 * Following the row there does one of two kinds of damage:
 *   • it ADDS a second record. With two v=DMARC1 records at one name, receivers ignore both
 *     (RFC 7489 §6.6.3), so the domain silently has no DMARC at all;
 *   • it REPLACES theirs with p=none, quietly turning off the protection the builder chose.
 * So the screen asks first. A record there: hide the row and say leave it alone. Two or more:
 * warn, because that is already broken. None: the row, exactly as before. The lookup failed:
 * show nothing. Advising p=none blind is the mistake this file exists to stop.
 *
 * ── WHICH NAME ───────────────────────────────────────────────────────────────────────
 * The domain comes from the record hostnames Resend RETURNED (resend._domainkey.<domain>),
 * never our stored string: Resend normalises what it is handed ("www.example.com" registers
 * as "example.com"), and the advisory row once pointed at _dmarc.www.csmsynergy.com because
 * the two disagreed (2026-08-26). The portal derives its row from the same host, and the
 * answer carries the name it looked at, so the portal can check the two agree.
 *
 * A sending SUBDOMAIN (mail.example.com) with no record of its own is covered by its parent's
 * (the parent's sp=, else its p=). The parents are asked too, closest first, so a builder
 * whose company domain says p=reject is not told to publish p=none for the subdomain. The
 * single-label TLD is never asked.
 *
 * ── DEGRADATION ──────────────────────────────────────────────────────────────────────
 * lookupExistingDmarc never throws and answers null for anything it cannot be sure of: a
 * timeout, a network error, a non-200, a body that isn't the JSON answer, a DNS failure
 * (SERVFAIL, REFUSED…), or a parent's record when a closer name's lookup failed. Null means
 * "say nothing". Only NOERROR and NXDOMAIN are answers.
 *
 * The domain is public DNS data; nothing about the builder goes with it. Cloudflare's resolver
 * is used because it answers the JSON form and caches by the record's TTL.
 */

/** What email_status hands the Email Settings screen as `existingDmarc` (null: unknown). */
export type ExistingDmarc = {
  /** At least one v=DMARC1 record covers the sending domain. */
  present: boolean;
  /** The policy that applies to this domain (p=, or the parent's sp= when inherited), with
   *  exactly one record. Null with none, with two or more (none applies), or without a valid
   *  p= (none, quarantine or reject). */
  policy: string | null;
  /** How many v=DMARC1 records sit at `host`. More than one cancels them all. */
  count: number;
  /** Where they are, or, with none, the name that was looked at (_dmarc.<sending domain>). */
  host: string;
};

const DOH_URL = "https://cloudflare-dns.com/dns-query";
/** Short on purpose: Email Settings waits on this, and an unknown answer only hides advice. */
export const DMARC_LOOKUP_TIMEOUT_MS = 2_500;
/** The sending domain and up to this many parents in all. Deeper names are not real senders. */
const MAX_NAMES = 5;
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/;

/**
 * The sending domain as the provider registered it, from the stored snapshot of the records
 * Resend returned: the DKIM host first, then the SPF host (send.<domain>). Null when neither is
 * there, so no lookup runs on a guess.
 */
export function dmarcDomainOf(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const hosts = rows
    .map((r) => (r && typeof r === "object" ? String((r as { host?: unknown }).host ?? "") : ""))
    .map((h) => h.trim().toLowerCase().replace(/\.+$/, ""));
  for (const prefix of ["resend._domainkey.", "send."]) {
    const h = hosts.find((x) => x.startsWith(prefix));
    if (!h) continue;
    const d = h.slice(prefix.length);
    if (d.length <= 253 && HOSTNAME.test(d)) return d;
  }
  return null;
}

/** The names a receiver would ask, closest first: the domain, then each parent above the TLD. */
export function dmarcNamesFor(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2 && out.length < MAX_NAMES; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * One TXT answer's text. A TXT record is a list of strings of at most 255 bytes, and a long one
 * is split across several; the record's text is them JOINED WITH NOTHING between. Cloudflare's
 * JSON gives the presentation form (`"v=DMARC1; p=" "reject"`, with \" \\ and \DDD escapes);
 * Google's gives the joined text with no quotes. Both are read.
 */
export function txtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') { i++; continue; } // the spaces between strings
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\" && i + 1 < s.length) {
        const ddd = /^\d{3}/.exec(s.slice(i + 1, i + 4));
        if (ddd) { out += String.fromCharCode(Number(ddd[0])); i += 4; continue; }
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += s[i];
      i++;
    }
    i++; // the closing quote
  }
  return out;
}

/** A DMARC record is a TXT record whose text starts with the v=DMARC1 tag; any other TXT at the
 *  name (a stray verification string, an SPF pasted in the wrong place) is not one. */
export function isDmarcRecord(text: string): boolean {
  return /^v\s*=\s*DMARC1\s*(;|$)/i.test(text.trim());
}

/** A policy the screen may print: one of the three DMARC defines. Anything else in the record
 *  (a typo, junk) is not echoed back to the builder as if it were a policy. */
export function dmarcPolicy(v: string | null): string | null {
  return v && /^(none|quarantine|reject)$/.test(v) ? v : null;
}

/** One tag's value from a DMARC record (`p`, `sp`), lower-cased, or null without it. */
export function dmarcTag(text: string, tag: string): string | null {
  for (const part of text.split(";")) {
    const m = /^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(part);
    if (m && m[1].toLowerCase() === tag) return m[2].toLowerCase() || null;
  }
  return null;
}

/**
 * The v=DMARC1 records in a DoH JSON answer ({ Status, Answer: [{ type, data }] }), or null when
 * the answer is not a usable one. NXDOMAIN, or NOERROR with no TXT, is an empty list. A CNAME at
 * _dmarc (a hosted DMARC service) comes back as the CNAME and then the target's TXT; only type 16
 * (TXT) rows are read, whatever their name.
 */
export function dmarcRecordsOf(answer: unknown): string[] | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as { Status?: unknown; Answer?: unknown };
  if (a.Status === 3) return [];
  if (a.Status !== 0) return null;
  if (a.Answer == null) return [];
  if (!Array.isArray(a.Answer)) return null;
  const out: string[] = [];
  for (const row of a.Answer) {
    if (!row || typeof row !== "object") continue;
    const r = row as { type?: unknown; data?: unknown };
    if (r.type !== 16 || typeof r.data !== "string") continue;
    const text = txtData(r.data);
    if (isDmarcRecord(text)) out.push(text);
  }
  return out;
}

async function askName(name: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string[] | null> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(`_dmarc.${name}`)}&type=TXT`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return dmarcRecordsOf(await res.json());
  } catch {
    // Timeout, network, or a body that isn't JSON. Unknown, so nothing is shown.
    return null;
  }
}

/**
 * The DMARC record(s) covering `domain`, as the screen needs them, or null when that cannot be
 * known. Every name is asked at once (one round trip of wall time), then read closest first: the
 * first name with any v=DMARC1 record is the answer, and a name whose lookup failed before that
 * makes the whole answer unknown.
 */
export async function lookupExistingDmarc(
  domain: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ExistingDmarc | null> {
  try {
    const d = String(domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (d.length > 253 || !HOSTNAME.test(d)) return null;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DMARC_LOOKUP_TIMEOUT_MS;
    const names = dmarcNamesFor(d);
    const answers = await Promise.all(names.map((n) => askName(n, fetchImpl, timeoutMs)));
    for (let i = 0; i < names.length; i++) {
      const recs = answers[i];
      if (recs === null) return null;
      if (recs.length === 0) continue;
      const one = recs.length === 1 ? recs[0] : null;
      // A record on a PARENT covers this subdomain with its sp= policy when it has one.
      const p = one ? dmarcPolicy(dmarcTag(one, "p")) : null;
      const policy = one && i > 0 ? dmarcPolicy(dmarcTag(one, "sp")) ?? p : p;
      return { present: true, policy, count: recs.length, host: `_dmarc.${names[i]}` };
    }
    return { present: false, policy: null, count: 0, host: `_dmarc.${d}` };
  } catch {
    return null;
  }
}
