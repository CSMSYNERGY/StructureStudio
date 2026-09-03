/**
 * safeFetchText — the ONE place this codebase is allowed to fetch a URL a stranger typed.
 *
 * Every other `fetch` in these functions points at a host we chose: Twilio, Resend, QuickBooks,
 * our own storage. This file is different in kind. A builder types their privacy-policy and
 * terms URLs into the portal, and the SMS compliance check has to open those pages and look at
 * the words on them. That makes the URL attacker-controlled input, executed from inside our
 * edge runtime, which sits behind our service-role credentials. The guard IS the feature; the
 * fetching is the easy part.
 *
 * A leaf module: it imports nothing at all, so scripts/preflight.mjs can unit-test it offline
 * with no network and no import map. Same rule as twilioSms.ts and resend.ts.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS GUARD DOES NOT DO: IT DOES NOT RESOLVE DNS.
 * Deno's fetch gives us no pre-connect hook, so we cannot see the IP a hostname resolves to,
 * and we cannot pin it between the check and the connect. A hostname like `policy.evil.com`
 * that resolves to 169.254.169.254 (classic DNS rebinding) WILL be connected to. Do not read
 * the rules below as more protection than they are.
 *
 * What bounds the residual risk, and why we shipped anyway:
 *   • Supabase edge functions run on Deno Deploy. There is no cloud instance-metadata endpoint
 *     at 169.254.169.254 to steal credentials from, and no private VPC of ours to pivot into —
 *     the classic SSRF payoff is simply absent on this platform.
 *   • Our own secrets live in the isolate's environment, not behind an HTTP endpoint, so no
 *     amount of outbound fetching reaches them. (The `file:` refusal below is the one that
 *     matters for secrets — see rule 1.)
 *   • The exfiltration invariant below means a successful rebind still returns nothing to the
 *     attacker: the fetched bytes never leave this process.
 * If we ever move this code somewhere with a metadata service or an internal network, this
 * file needs a resolve-then-pin rewrite BEFORE that move, not after.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE EXFILTRATION INVARIANT — the reason a rebind is survivable, so do not break it:
 *
 *   `PageFetch.text` is for the rules module and NOTHING else. No caller may put fetched bytes
 *   into anything that reaches a browser, a database row, a log line or an email. The
 *   compliance action returns AUTHORED CONSTANTS selected by rule key, never a substring of a
 *   fetched page.
 *
 * Concretely: a `Check.reason` may interpolate values WE hold (a URL the builder typed, a
 * business name out of our own tables). It may never interpolate anything that came back over
 * the wire. Break that and this file turns into a read-anything-print-anywhere proxy, which is
 * exactly the thing an SSRF is worth having.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** The result of one guarded page fetch. See the exfiltration invariant above before you use
 *  `text` for anything. */
export type PageFetch = {
  /** The URL as given. Echoed for the caller's own bookkeeping only. */
  requested: string;
  /** true only for a 2xx that produced a body we could read. */
  ok: boolean;
  /** HTTP status, or 0 when the request never got an answer at all. */
  status: number;
  /** Final URL after redirects, or null if we never got that far. */
  finalUrl: string | null;
  /** Did the response claim to be HTML (or plain text)? A PDF policy is not readable prose. */
  html: boolean;
  /** Bytes actually read (capped). */
  bytes: number;
  /** true when the cap stopped us early. */
  truncated: boolean;
  /**
   * Visible page text, lowercased and whitespace-collapsed, with script/style/tag content
   * stripped. EMPTY when the fetch failed.
   * ⚠️ NEVER CROSSES THE MODULE BOUNDARY — see the exfiltration invariant.
   */
  text: string;
  /** Why we refused to fetch, or why the fetch failed. A short authored constant, never a
   *  server-supplied string. null on success. */
  refusal: string | null;
};

/** guardUrl's answer. Deliberately not an exception: refusing is the normal case here, not an
 *  error, and a caller that has to try/catch a URL check will eventually forget to. */
export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

// ── Authored refusal text ────────────────────────────────────────────────────────────────────
// Every one of these is a constant written by us. Nothing here is ever built from a response
// body, a header, a hostname or an error message — that is the exfiltration invariant applied
// to the failure path, where leaks normally happen.
//
// Register: the reader is a shed builder fixing their own website link, not a network engineer.
// No "SSRF", no "loopback", no "RFC 1918".
const REFUSE = {
  EMPTY: "No web address was given.",
  TOO_LONG: "That web address is too long to be a real page.",
  UNPARSEABLE: "We could not read that as a web address.",
  SCHEME: "Use a full address starting with https:// — that is the only kind we can open.",
  CREDENTIALS: "Take the username and password out of the web address.",
  PORT: "Take the port number off the end of the address — a normal web page does not need one.",
  HOST_SHAPE: "That does not look like a public website address.",
  IP_LITERAL: "Use your website's name, not a numeric network address.",
  RESERVED: "That address only works inside a private network, so we cannot open it.",
  REDIRECT_NO_TARGET: "That address forwarded us on, but did not say where to.",
  REDIRECT_BLOCKED: "That address forwards to somewhere we are not allowed to open.",
  REDIRECT_TOO_MANY: "That address keeps forwarding somewhere else, so we stopped following it.",
  TOO_BIG: "That page is far too big for us to read.",
  NOT_A_PAGE: "That address is a file to download, not a web page we can read.",
  HTTP_ERROR: "That page did not open — the website returned an error.",
  EMPTY_BODY: "That page opened but had nothing in it.",
  TIMEOUT: "That page took too long to answer.",
  UNREACHABLE: "We could not reach that page.",
} as const;

// ── Constants, and where the numbers came from ───────────────────────────────────────────────

/** 2048 characters. The practical ceiling every browser and proxy has agreed on for a URL for
 *  twenty years; anything longer is a payload, not an address. Checked FIRST — deliberately
 *  above the scheme check — because it is the only test that costs nothing and it bounds the
 *  work every rule below it does. */
const MAX_URL_LENGTH = 2048;

/** 8 seconds for the WHOLE chain including redirects, not per hop. Per-hop timeouts multiply:
 *  three hops at 8s each is 24s of wall clock, and the caller is a portal request a human is
 *  watching. A real policy page answers in under two. */
const DEFAULT_TIMEOUT_MS = 8000;

/** 256 KiB of body. The cost that actually bites here is bytes we decode and regex over, not
 *  seconds we wait: the platform's 2-second budget is CPU and EXCLUDES async I/O, so a slow
 *  server is cheap and a fat one is not. 256 KiB comfortably contains the readable prose of
 *  every policy page we sampled, including the ones that inline their whole stylesheet. */
const DEFAULT_MAX_BYTES = 262144;

/** 2 MiB. If the server DECLARES more than this in content-length we hang up without
 *  transferring it — that is not a page, and no amount of it will be prose.
 *
 *  ⚠️ Note this is 8× the read cap, NOT equal to it, and that is on purpose. Refusing at the
 *  read cap would report a builder's live, correct policy page as unreachable simply because
 *  their site builder inlined 400 KB of CSS — a false failure in the tenant's face, over a
 *  page whose first 256 KB we could have read perfectly well. Below the ceiling we stream and
 *  truncate; above it we refuse. */
const ABSURD_CONTENT_LENGTH = DEFAULT_MAX_BYTES * 8;

/** At most 2 redirects followed (so at most 3 requests). Enough for the two hops the real
 *  world actually uses — http→https and apex→www are usually collapsed into one 301, and a
 *  CMS adds one more — and short enough that a redirect maze cannot burn the timeout. */
const MAX_HOPS = 2;

/** Honest identification, on purpose. This is our own tenant's website; a spoofed Chrome
 *  user-agent is how a compliance crawler ends up on a WAF blocklist, and then EVERY builder's
 *  check starts failing at once with no signal as to why. The URL lets a webmaster look us up. */
const USER_AGENT =
  "StructureStudio-ComplianceCheck/1.0 (+https://app.structurestudiosuite.com)";
const ACCEPT = "text/html,application/xhtml+xml";

/**
 * Hostname shape: lowercase letters/digits/hyphens per label, no leading or trailing hyphen,
 * at least one dot.
 *
 * ⚠️ This is a NAME-SHAPE ALLOWLIST and it is the load-bearing rule in this file. The IP rules
 * below it are belt and braces. An allowlist is what makes the guard hold up against an
 * encoding nobody has invented yet: `0x7f.1`, `[::ffff:a9fe:a9fe]`, a decimal dword, whatever
 * comes next — they all fail because they do not LOOK like a domain name, not because we
 * remembered to blocklist them. Blocklists here are how every SSRF write-up starts.
 */
const HOSTNAME_SHAPE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The final label must be 2+ letters — a real public suffix. Kills `127.0.0.1`, `host.5`, and
 *  a bare `localhost` (no dot at all is already killed by HOSTNAME_SHAPE).
 *
 *  KNOWN, ACCEPTED LIMITATION: this also refuses punycode TLDs (`xn--p1ai`, `xn--90ae`), so a
 *  fully-internationalised domain is turned away. Our builders are US/UK/AU shed makers; when
 *  that stops being true, widen this rule deliberately rather than discovering it as a bug. */
const FINAL_LABEL_ALPHA = /\.[a-z]{2,}$/;

/** ⚠️ AND A NAME WHOSE JOB IS TO BE A LITERAL. The shape allowlist above is genuinely strong
 *  against IP *encodings* — and completely blind to `169.254.169.254.nip.io`, which is a
 *  perfectly well-formed domain name that a free, public, third-party wildcard resolver points
 *  at the metadata address. `127.0.0.1.nip.io`, `10.0.0.1.sslip.io`, `localtest.me`, `lvh.me`:
 *  no nameserver of their own to run, no race to win, no rebinding involved. The header used to
 *  describe the residual risk as "DNS rebinding", which made it sound like an attack needing
 *  infrastructure; it needs a URL.
 *
 *  This rule is a blocklist and is therefore NOT the real fix — it catches the dotted-quad
 *  family and nothing else. The real fix is resolve-then-pin, which needs a custom
 *  `Deno.HttpClient`; do that before this code goes anywhere with a metadata service. Until
 *  then: no legitimate privacy policy lives on a hostname containing four dot-separated
 *  numbers, so refusing them costs a real builder nothing. */
const HOST_EMBEDS_IPV4 = /(^|\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\.|$)/;

/** Names that only mean anything inside somebody's private network. `.local` is mDNS, `.test`
 *  and `.invalid` are reserved by the RFCs, `.onion` is Tor, `.internal` and `.home.arpa` are
 *  the private-network conventions cloud providers and routers use. */
const RESERVED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".onion",
  ".test",
  ".invalid",
];

/** Named one by one so the next reader sees the intent rather than a pattern.
 *  `metadata.google.internal` and `instance-data` are the credential-vending hostnames on GCP
 *  and AWS. Both are already refused by the rules above (one ends in `.internal`, the other has
 *  no dot) — they are listed anyway because the day somebody relaxes a rule "just for a
 *  moment", these are the names that must still be impossible. */
const RESERVED_EXACT = [
  "localhost",
  "metadata.google.internal",
  "instance-data",
];

function refuse(reason: string): UrlVerdict {
  return { ok: false, reason };
}

/**
 * Belt and braces on top of the name-shape allowlist: an IP literal in any notation.
 *
 * ⚠️ Most of these are unreachable in practice and that is FINE. The WHATWG URL parser
 * normalises `2130706433`, `0x7f000001` and `0177.0.0.1` all to `127.0.0.1` before we ever see
 * the hostname, and `127.0.0.1` then fails FINAL_LABEL_ALPHA. Keep this function anyway: it
 * costs one regex, and it is what still stands if a future parser change (or a move off Deno)
 * hands us a raw form instead.
 */
function isIpLiteral(host: string): boolean {
  // WHATWG keeps the brackets on an IPv6 host: "[::1]", "[::ffff:a9fe:a9fe]".
  if (host.startsWith("[") || host.includes(":")) return true;
  // Dotted quad, bare decimal dword, or anything else made only of digits and dots.
  if (/^[0-9.]+$/.test(host)) return true;
  // Hex and octal forms, in case they ever survive parsing intact.
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^0[0-7]+(\.[0-7]+)*$/.test(host)) return true;
  return false;
}

function isReservedHost(host: string): boolean {
  if (RESERVED_EXACT.includes(host)) return true;
  return RESERVED_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Decide whether we are willing to open this URL AT ALL. Pure: no DNS, no sockets, no clock.
 * Run on the URL the builder typed AND on every redirect target — see fetchPage.
 *
 * Rules are ordered cheapest-and-most-dangerous first.
 */
export function guardUrl(raw: string): UrlVerdict {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return refuse(REFUSE.EMPTY);
  if (trimmed.length > MAX_URL_LENGTH) return refuse(REFUSE.TOO_LONG);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return refuse(REFUSE.UNPARSEABLE);
  }

  // 1. Scheme ALLOWLIST — https only. Never a blocklist, for two specific reasons:
  //
  //    ⚠️ `file:` — Deno's fetch has supported file: URLs since 1.16. `file:///proc/self/environ`
  //    reads this isolate's environment block, which is where SUPABASE_SERVICE_ROLE_KEY lives.
  //    That is a full database compromise from a text box on a settings page. A blocklist that
  //    forgot one scheme is a blocklist that leaked the key.
  //
  //    ⚠️ `data:` — a URL that simply CONTAINS the compliance wording. Every content rule below
  //    would pass by self-assertion: the tenant writes "we honour opt-out requests" into the
  //    address bar and we solemnly report that their policy says so.
  if (url.protocol !== "https:") return refuse(REFUSE.SCHEME);

  // 2. Credentials in the URL. `https://user:pass@internal-host/` is how a fetcher gets talked
  //    into authenticating to something on the other side.
  if (url.username || url.password) return refuse(REFUSE.CREDENTIALS);

  // 3. An explicit port. Supabase does NOT restrict outbound ports, so a port here is a port
  //    scanner with a timing side channel: fast refusal vs slow timeout tells the caller what
  //    is listening. A real policy page is on 443, and note the URL parser has already dropped
  //    a redundant ":443" for us — so `https://example.com:443/` passes, as it should.
  if (url.port) return refuse(REFUSE.PORT);

  const host = url.hostname; // already lowercased and IDNA-normalised by the parser

  // 4. Must LOOK like a public DNS name. The load-bearing rule — see HOSTNAME_SHAPE.
  if (!HOSTNAME_SHAPE.test(host)) return refuse(REFUSE.HOST_SHAPE);
  if (!FINAL_LABEL_ALPHA.test(host)) return refuse(REFUSE.HOST_SHAPE);
  // A well-formed name that carries an IP address inside it — see HOST_EMBEDS_IPV4.
  if (HOST_EMBEDS_IPV4.test(host)) return refuse(REFUSE.HOST_SHAPE);

  // 5. Never an IP literal, in any notation. Redundant after rule 4, kept anyway.
  if (isIpLiteral(host)) return refuse(REFUSE.IP_LITERAL);

  // 6. Reserved names that only resolve inside somebody's network.
  if (isReservedHost(host)) return refuse(REFUSE.RESERVED);

  return { ok: true, url };
}

// ── Visible text ─────────────────────────────────────────────────────────────────────────────

/** Only the entities that actually turn up in prose. A full entity table is not worth carrying
 *  in a leaf module, and a missed entity costs us one odd character, not a wrong verdict.
 *  `&amp;` is decoded LAST — see decodeEntities. */
const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#0*39;/g, "'"],
  [/&apos;/g, "'"],
];

function decodeEntities(s: string): string {
  let out = s;
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch);
  // ⚠️ &amp; goes last, on purpose. Decode it first and "&amp;lt;" becomes "&lt;" becomes "<" —
  // we would be manufacturing angle brackets AFTER tag-stripping has already run.
  return out.replace(/&amp;/g, "&");
}

/**
 * Visible prose from an HTML document: lowercased, tags and their script/style contents gone,
 * common entities decoded, whitespace collapsed. Pure — no DOM, no parser, no dependency.
 *
 * ⚠️ SCRIPT AND STYLE ARE REMOVED WITH THEIR CONTENTS, and that is the whole point of doing
 * this properly rather than with a single tag-strip. Every analytics snippet and consent
 * banner ships strings like "privacy policy" and "opt out" inside JavaScript. If those counted,
 * a site with no policy text at all would sail through the check. A false PASS here tells a
 * builder they are compliant when they are not, which is far worse than a false fail — a false
 * fail annoys them, a false pass is the one that reaches a carrier audit.
 *
 * Regex, not a parser, and knowingly so: we are looking for the presence of phrases, not
 * building a DOM. The failure mode of a regex here is dropping a bit of text (→ a fail we can
 * explain), never inventing text that was not there.
 */
export function visibleText(html: string): string {
  if (typeof html !== "string" || !html) return "";
  let s = html.toLowerCase();

  // Elements whose CONTENT is not prose. The second pattern in each pair handles an unclosed
  // tag — a truncated body (see the read cap) very often ends in the middle of a <script>.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g, " ");
  s = s.replace(/<script\b[^>]*>[\s\S]*$/g, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/g, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*$/g, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/g, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*$/g, " ");
  s = s.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/g, " ");
  // ⚠️ THE UNCLOSED COMPANION IS NOT OPTIONAL FOR <template> EITHER. Its content is never
  // rendered to a visitor, and consent-banner tools ship exactly this kind of sentence inside
  // one — so a body truncated mid-template would let unrendered boilerplate satisfy a content
  // rule. That also breaks the promise the rules module leans on when `truncated` is true:
  // "anything we found in the part we read is really on the page".
  s = s.replace(/<template\b[^>]*>[\s\S]*$/g, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Everything else: drop the tag, keep the words between tags.
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/<[^>]*$/g, " "); // a tag cut in half by truncation

  s = decodeEntities(s);
  s = s.replace(/[\s ]+/g, " ");
  return s.trim();
}

// ── The fetch ────────────────────────────────────────────────────────────────────────────────

function failed(requested: string, refusal: string, extra?: Partial<PageFetch>): PageFetch {
  return {
    requested,
    ok: false,
    status: 0,
    finalUrl: null,
    html: false,
    bytes: 0,
    truncated: false,
    text: "",
    refusal,
    ...extra,
  };
}

/** Content types we will read as prose. text/plain is here because a surprising number of
 *  small builders serve their terms as a bare .txt file, and that is genuinely readable. */
function isReadableType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "text/html" || base === "application/xhtml+xml" || base === "text/plain";
}

/**
 * Read at most `maxBytes` from a response body, then hang up.
 *
 * ⚠️ NEVER `await res.text()` HERE. text() reads to completion with no ceiling: one hostile
 * (or merely badly-configured) URL streaming an endless body is a free out-of-memory in an
 * isolate that is also serving other requests. Streaming with a cap is the only safe read.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: number; truncated: boolean; text: string }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    const room = maxBytes - received;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      received += room;
      truncated = true;
      await reader.cancel(); // tell the far end to stop sending; do not drain politely
      break;
    }
    chunks.push(value);
    received += value.length;
  }

  const joined = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  // fatal:false on purpose: cutting at a byte cap lands mid-character often enough, and one
  // replacement character at the very end is not worth failing a compliance check over.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(joined);
  return { bytes: received, truncated, text: decoded };
}

/**
 * Fetch a tenant-supplied page and hand back its visible text, or an authored reason why not.
 *
 * ⚠️ THIS FUNCTION MUST NEVER REJECT. Its caller is a compliance check that renders a row per
 * URL; a throw from here takes out the whole check and the builder sees a blank screen instead
 * of "we could not open your terms page". Everything is inside the try.
 */
/** A finite integer inside [lo, hi], or the default. Anything else — NaN, negative, Infinity,
 *  a string, undefined — becomes the default rather than an exception. */
function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

export async function fetchPage(
  raw: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<PageFetch> {
  // ⚠️ CLAMPED, BECAUSE "THIS FUNCTION NEVER REJECTS" HAS TO BE TRUE OF THE ARGUMENTS TOO.
  // `AbortSignal.timeout()` is constructed before the try block below and THROWS on a negative,
  // NaN or absurd value — so a caller computing "time left in this request" and getting a
  // negative number would blow up a check that promises never to. `new Uint8Array(-1)` in the
  // read loop is the same bug with a worse disguise: it is caught, and reported to the builder
  // as "we could not reach that page", which sends them to inspect a web server that is fine.
  const timeoutMs = clampInt(opts?.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  const maxBytes = clampInt(opts?.maxBytes, DEFAULT_MAX_BYTES, 1_024, 4 * 1024 * 1024);

  const verdict = guardUrl(raw);
  if (!verdict.ok) return failed(raw, verdict.reason); // no socket is opened at all

  // ONE deadline for the whole chain, including every redirect hop. A per-hop timeout would
  // multiply: three hops of 8s is 24 seconds with a human waiting on the other end.
  const signal = AbortSignal.timeout(timeoutMs);

  let current = verdict.url;
  let hops = 0;

  try {
    while (true) {
      const res = await fetch(current.href, {
        method: "GET", // never HEAD: plenty of sites 405 a HEAD, and the rules need the body
        // ⚠️ redirect:"manual" is NOT a style choice — it is the second half of the guard.
        // With redirect:"follow", Deno chases the Location header itself and guardUrl never
        // sees the second URL: `https://policy.example.com` → 302 → `http://169.254.169.254/`
        // would be followed for us, and the only URL we ever checked was the harmless one.
        // Every hop below is re-guarded by hand.
        redirect: "manual",
        signal,
        headers: {
          "Accept": ACCEPT,
          "User-Agent": USER_AGENT,
        },
      });

      const status = res.status;
      const finalUrl = current.href;

      if (status >= 300 && status < 400) {
        await res.body?.cancel();
        if (hops >= MAX_HOPS) {
          return failed(raw, REFUSE.REDIRECT_TOO_MANY, { status, finalUrl });
        }
        const location = res.headers.get("location");
        if (!location) return failed(raw, REFUSE.REDIRECT_NO_TARGET, { status, finalUrl });

        // Location is allowed to be relative, so resolve it against the URL we just asked.
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return failed(raw, REFUSE.REDIRECT_BLOCKED, { status, finalUrl });
        }
        const hop = guardUrl(next.href);
        if (!hop.ok) {
          // Deliberately our own constant, not hop.reason: the builder did not type this
          // address and telling them what their CDN forwards to is noise, not help.
          return failed(raw, REFUSE.REDIRECT_BLOCKED, { status, finalUrl });
        }
        current = hop.url;
        hops++;
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const html = isReadableType(contentType);

      if (!res.ok) {
        await res.body?.cancel();
        return failed(raw, REFUSE.HTTP_ERROR, { status, finalUrl, html });
      }

      // A 200 that is a PDF or a Word file. The page exists — `status` says so — but there is
      // no prose here for the rules to read, so `html:false` plus a status of 200 is how the
      // caller tells "your policy is a PDF" apart from "your policy 404s".
      if (!html) {
        await res.body?.cancel();
        return failed(raw, REFUSE.NOT_A_PAGE, { status, finalUrl, html: false });
      }

      // The cheap refusal: if the server tells us up front that it is far too big, hang up
      // before transferring it. See ABSURD_CONTENT_LENGTH for why this is not the read cap.
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > ABSURD_CONTENT_LENGTH) {
        await res.body?.cancel();
        return failed(raw, REFUSE.TOO_BIG, { status, finalUrl, html });
      }

      if (!res.body) {
        return failed(raw, REFUSE.EMPTY_BODY, { status, finalUrl, html });
      }

      const { bytes, truncated, text } = await readCapped(res.body, maxBytes);
      if (bytes === 0) {
        return failed(raw, REFUSE.EMPTY_BODY, { status, finalUrl, html });
      }

      return {
        requested: raw,
        ok: true,
        status,
        finalUrl,
        html,
        bytes,
        truncated,
        text: visibleText(text),
        refusal: null,
      };
    }
  } catch (e) {
    // ⚠️ The thrown value is INSPECTED, never propagated. A fetch error message can carry the
    // resolved address and the TLS chain — see the exfiltration invariant. Only our own
    // sentences travel outward; the raw error belongs in app_errors, logged by the caller.
    const name = (e as Error)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") return failed(raw, REFUSE.TIMEOUT);
    return failed(raw, REFUSE.UNREACHABLE);
  }
}
