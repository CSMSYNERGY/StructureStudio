/**
 * SMS registration self-check — the rule engine behind the "check my details" button on the
 * portal's texting page. It grades a builder's carrier registration BEFORE they submit it,
 * so a rejection costs them a five-minute edit instead of a fortnight of waiting.
 *
 * A leaf module: the only import is a `import type` from another leaf, so there is no jsr,
 * no npm, no Supabase client, and the pre-push gate can unit-test the whole thing offline.
 *
 * ⚠️ EVERY FUNCTION HERE IS PURE. It performs NO I/O of any kind — no fetch, no Deno.env, no
 * clock. `portal-sms` does the fetching (through `safeFetchText.ts`) and hands the already
 * fetched pages in. That split is what makes the judgements testable without a network and
 * what stops a slow or hostile web server from ever being able to stall a portal request
 * inside a rule.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE RULE THAT OVERRIDES EVERY OTHER RULE IN THIS FILE
 *
 * NOTHING DERIVED FROM FETCHING SOMEBODY'S WEB PAGE MAY EVER RETURN "fail".
 *
 * Roughly a quarter of the web sits behind Cloudflare, and a large share of small-business
 * sites challenge any client that is not a real browser. Policies are also served as PDFs,
 * rendered by JavaScript after load, or hidden behind a cookie wall that returns the wall
 * itself at HTTP 200. From the edge we cannot tell a non-compliant policy from an unreadable
 * one, and we never will be able to.
 *
 * A "fail" greys out the submit button. A compliant builder who cannot buy a registration is
 * a far worse outcome than a non-compliant one who gets a free resubmit. So: unreachable,
 * unreadable, not-HTML, wording-not-found → "warn", always.
 *
 * The ONLY "fail"s allowed anywhere in this module are deterministic judgements about values
 * WE already hold, with no network involved at all:
 *   1. a policy URL that is empty or is not an https:// address       (policyPageChecks)
 *   2. a consent box that would render with no business name in it    (optInPageChecks)
 * Both are facts about our own database rows. Neither can be wrong because a web server was
 * having a bad day. If you add a third, it must clear the same bar.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ EXFILTRATION INVARIANT. `PageFetch.text` is somebody else's web page. It NEVER crosses
 * this module's boundary: no `reason` and no `hint` in this file interpolates it, or any
 * other server-supplied string (`finalUrl` included). Every sentence a builder reads from
 * here is an authored constant; the only values interpolated are ones WE hold — a URL the
 * builder typed into our form, a business name out of our own tables. A rule that quoted the
 * fetched page back into the UI would turn any web page on the internet into a way of
 * putting arbitrary text on our portal.
 *
 * ⚠️ PLAIN ENGLISH ONLY in `label`, `reason` and `hint`. The reader is a shed builder, not a
 * telecoms engineer. The words "A2P", "10DLC", "campaign", "vetting", "TCR" and "brand" must
 * never appear in a user-facing string in this file.
 */

import type { PageFetch } from "./safeFetchText.ts";

export type Verdict = "pass" | "warn" | "fail";

export type Check = {
  key: string;        // stable, namespaced: "page.privacy.reachable", "match.website" ...
  group: "policy" | "optin" | "consistency";
  label: string;      // what this checks, in a shed builder's words
  verdict: Verdict;
  reason: string;     // why it landed that way — an AUTHORED CONSTANT, never interpolated
                      // from fetched bytes. May interpolate values WE hold (a URL the
                      // builder typed, a business name from our own database).
  hint: string;       // what to change. Empty string when the verdict is "pass".
};

/** Everything the consistency rules compare, all of it out of our own database. Two of these
 *  fields are second copies of the same fact kept in different tables and never synced —
 *  `websiteUrl` vs `settingsWebsite`, `legalBusinessName` vs `consentCompanyName` — which is
 *  exactly why the "does it all match?" half of this engine exists. */
export type Declared = {
  websiteUrl: string;            // sms_registrations.website_url
  privacyPolicyUrl: string;      // sms_registrations.privacy_policy_url
  termsUrl: string;              // sms_registrations.terms_url
  settingsWebsite: string;       // client_settings.business_website — a SECOND copy, unsynced
  legalBusinessName: string;     // sms_registrations.legal_business_name
  consentCompanyName: string;    // client_configs.company_name — the name in the consent box
  messageSamples: string[];
  hasEmbeddedLinks: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row builders
// ─────────────────────────────────────────────────────────────────────────────

function row(
  key: string,
  group: Check["group"],
  label: string,
  verdict: Verdict,
  reason: string,
  hint: string,
): Check {
  // A passing row with a hint reads as "you fixed it, now change it" in the UI, so the
  // invariant is enforced here rather than trusted at ~30 call sites.
  return { key, group, label, verdict, reason, hint: verdict === "pass" ? "" : hint };
}

// ─────────────────────────────────────────────────────────────────────────────
// Text matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far apart two words may sit and still count as "in the same statement", in characters
 * of collapsed text.
 *
 * 200 is not arbitrary: the longest of the three non-sharing wordings in circulation (the
 * "all of the above categories exclude text messaging originator opt-in data..." one, which
 * is the wording Twilio's own template produces) puts ~75 characters between its subject and
 * its verb, and the sentence itself is ~140 characters end to end. 200 clears the real
 * wordings with room for an inserted clause, while staying short enough that a match cannot
 * be assembled out of two unrelated paragraphs a page apart.
 */
const NEAR_WINDOW = 200;

/** Bounded scan for every start offset of `re`. Capped because `page.text` is a stranger's
 *  web page: a page that repeats one word ten thousand times must not turn a portal request
 *  into a long loop. 500 offsets is far more than any real policy contains. */
function findAll(text: string, re: RegExp): number[] {
  const out: number[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out.push(m.index);
    if (m.index === g.lastIndex) g.lastIndex++; // zero-width match guard: otherwise infinite
    if (out.length >= 500) break;
  }
  return out;
}

/** `text` arrives from `visibleText` already lowercased and whitespace-collapsed, so every
 *  needle here is lowercase and single-spaced and none of these regexes carry /i. */
function hasAny(text: string, needles: RegExp[]): boolean {
  return needles.some((n) => n.test(text));
}

/**
 * The non-sharing statement — the single most-cited reason a registration is refused, and the
 * rule most easily got wrong.
 *
 * ⚠️ DO NOT SUBSTRING-MATCH A SENTENCE. The canonical wordings in circulation are all
 * different from each other:
 *   - "No mobile information will be shared with third parties or affiliates for marketing
 *      or promotional purposes."
 *   - "We do not share, sell, or provide your mobile phone number or messaging consent data
 *      to third parties or affiliates for marketing or promotional purposes."
 *   - "All of the above categories exclude text messaging originator opt-in data and
 *      consent; this information will not be shared with any third parties."
 * Matching any one of them verbatim would warn at precisely the builders most likely to be
 * compliant: the ones who pasted the recommended text. So we match the SHAPE — a sharing
 * verb, near a subject that is a phone number or a consent record, near a counterparty —
 * inside a bounded window.
 *
 * ⚠️ KNOWN AND DELIBERATE FALSE PASS: this tests for the TOPIC, not its polarity. A page that
 * says it DOES sell mobile numbers to affiliates matches too. That is the right way round to
 * be wrong here — reliable negation detection over collapsed page text would warn at
 * compliant pages phrased affirmatively ("mobile opt-in data is excluded from all sharing
 * with third parties"), and a false warn at a compliant builder is the failure this whole
 * module is built to avoid. A reviewer reads the page; we only check the page has the
 * paragraph at all.
 */
const SHARING_VERB = /\b(?:shar(?:e|es|ed|ing)|sell|sells|sold|selling|rent|rents|rented|renting|disclos(?:e|es|ed|ing)|provid(?:e|es|ed|ing)|transfer(?:s|red)?)\b/;
const SHARING_SUBJECT = /(?:\bmobile|\bsms\b|\btext messag|\bphone number|\bopt-?in\b|\bconsent\b|\boriginator\b)/;
const SHARING_COUNTERPARTY = /(?:\bthird[- ]part|\b3rd[- ]part|\baffiliate)/;

/** ⚠️ ANCHOR ON THE RAREST TERM, NOT THE COMMONEST — the 500-offset cap in `findAll` makes this
 *  a correctness rule, not a performance one. Anchoring on the VERB looked natural and was
 *  wrong: "provide", "disclose" and "transfer" are the highest-frequency words in legalese, so
 *  a thorough CCPA-style policy burns all 500 offsets on its "categories disclosed" tables
 *  before the scan ever reaches the SMS paragraph — which is conventionally placed after them.
 *  Measured: a page with 520 uses of "provide" followed by Twilio's own recommended non-sharing
 *  sentence came back WARN, and the same page with the sentence moved to the top came back
 *  PASS. A rule whose answer depends on where in the document the sentence sits, with no signal
 *  to anybody, is worse than no rule. "third party" and "affiliate" are rare, so anchoring
 *  there finds two offsets where the verb found five hundred. */
function hasNonSharingStatement(text: string): boolean {
  for (const i of findAll(text, SHARING_COUNTERPARTY)) {
    const window = text.slice(
      Math.max(0, i - NEAR_WINDOW),
      Math.min(text.length, i + NEAR_WINDOW),
    );
    if (SHARING_SUBJECT.test(window) && SHARING_VERB.test(window)) return true;
  }
  return false;
}

/** Does the page talk about texting at all? A policy that never mentions messaging cannot be
 *  the messaging policy, however well written it is. */
const MENTIONS_TEXTING = [/\bsms\b/, /\btext messag/, /\btexting\b/, /\bmobile messag/];

/** True when any needle appears within `NEAR_WINDOW` of somewhere the page talks about texting.
 *
 *  The difference between "this page contains the word help" and "this page tells people how to
 *  get help with the messages" — see the STOP/HELP rows for what that cost. Anchored on the
 *  texting mentions because they are the rarer term, the same reasoning as
 *  `hasNonSharingStatement`: anchoring on the common word is how the 500-offset cap turns a
 *  content rule into a lottery on document length. */
function hasNear(text: string, needles: RegExp[]): boolean {
  for (const anchor of MENTIONS_TEXTING) {
    for (const i of findAll(text, anchor)) {
      const window = text.slice(
        Math.max(0, i - NEAR_WINDOW),
        Math.min(text.length, i + NEAR_WINDOW),
      );
      if (needles.some((n) => n.test(window))) return true;
    }
  }
  return false;
}

/** The stop instruction. Matched as a whole word so "nonstop" and "stopped" do not count. */
const STOP_WORDS = [/\bstop\b/, /\bunsubscribe\b/, /\bopt[- ]?out\b/];

/** The help instruction. */
const HELP_WORDS = [/\bhelp\b/];

/** How often messages go out. All the real wordings collapse to one of these once lowercased
 *  ("Message frequency varies", "MSG FREQUENCY MAY VARY", "4 msgs per month"). */
const FREQUENCY_WORDS = [
  /\b(?:message|msg|messaging)\s*frequency\b/,
  /\bfrequency\s*(?:varies|may vary|of messages)\b/,
  /\b(?:messages?|msgs?)\s*per\s*(?:month|week|day)\b/,
];

/** That the recipient's own network may charge them. "&" and "and" are both in wide use and
 *  both appear in the CTIA sample text; the all-caps forms arrive here already lowercased by
 *  `visibleText`, which is the whole reason this list is short. */
const RATES_WORDS = [
  /\b(?:message|msg|msg\.)\s*(?:and|&)\s*data\s*rates\b/,
  /\bdata\s*rates\s*may\s*apply\b/,
  /\bstandard\s*(?:message|messaging|carrier|text)\s*(?:and|&)?\s*data\s*rates\b/,
  /\bcarrier\s*(?:message\s*and\s*data\s*)?rates\s*may\s*apply\b/,
];

// ─────────────────────────────────────────────────────────────────────────────
// URLs
// ─────────────────────────────────────────────────────────────────────────────

/** Why a URL we hold is unusable, or null if it is fine. Entirely deterministic — this looks
 *  at a string in our own database and never at a network. */
function urlProblem(url: string): "empty" | "scheme" | "malformed" | null {
  const raw = String(url ?? "").trim();
  if (!raw) return "empty";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "malformed";
  }
  // Plain http is refused because the reviewer's own browser will flag it, and because a
  // policy served without https cannot be shown to have arrived unaltered.
  if (u.protocol !== "https:") return "scheme";
  if (!u.hostname.includes(".")) return "malformed";
  return null;
}

/**
 * Multi-part public suffixes, for `registrableDomain`.
 *
 * ⚠️ THIS IS A HEURISTIC, NOT THE PUBLIC SUFFIX LIST. There is no PSL in this repo, and a
 * leaf module may not fetch one — so this is a hand-kept list of the suffixes our builders
 * and their web hosts actually use. Anything not on it falls back to "the last two labels",
 * which is right for .com/.net/.org/.co/.io and wrong for, say, a country suffix we have not
 * met yet.
 *
 * Getting it wrong is designed to be cheap: the ONLY thing `registrableDomain` feeds is the
 * "is your policy on your own website?" comparison, whose worst verdict is a warn. Never wire
 * it into anything that can fail.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "id.au",
  "co.nz", "net.nz", "org.nz",
  "com.br", "com.mx", "com.ar", "com.co",
  "co.za", "org.za",
  "co.jp", "or.jp", "ne.jp",
  "co.in", "net.in", "org.in",
  "co.kr", "com.sg", "com.hk", "com.tw", "com.my", "com.ph", "com.vn", "co.th", "co.id",
  "com.tr", "com.ua", "com.pl", "co.il", "com.cn", "net.cn", "org.cn",
]);

/**
 * The part of a hostname that somebody actually registered: `a.b.example.co.uk` →
 * `example.co.uk`, `www.example.com` → `example.com`.
 *
 * Exported for the tests. See MULTI_PART_SUFFIXES above for the limits of the heuristic.
 */
export function registrableDomain(host: string): string {
  let h = String(host ?? "").trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^\[|\]$/g, "");            // bare IPv6 literal, if one ever turns up
  h = h.replace(/:\d+$/, "");               // port
  h = h.replace(/\.+$/, "");                // the root's trailing dot
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  // A bare IPv4 address has no registrable domain; hand it back whole rather than inventing
  // "1.1" out of the last two octets.
  if (/^\d+(?:\.\d+)*$/.test(h)) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

function hostOf(url: string): string {
  try {
    return new URL(String(url ?? "").trim()).hostname;
  } catch {
    return "";
  }
}

/** Compare two website addresses the way a human would: same site or not. Lowercased, scheme
 *  dropped, `www.` dropped, trailing slash dropped. */
function normaliseWebsite(url: string): string {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Business names
// ─────────────────────────────────────────────────────────────────────────────

/** Company-form words that carry no identity. Stripped before comparing two names, so that
 *  "Structure Studio" and "Structure Studio LLC" are the same business. */
const COMPANY_FORM_WORDS = new Set([
  "llc", "l.l.c", "inc", "incorporated", "corp", "corporation", "ltd", "limited", "co",
  "company", "plc", "llp", "lp", "pty", "gmbh", "sa", "srl", "bv",
]);

/** Words too common to prove two names refer to the same business on their own. */
const NAME_STOPWORDS = new Set([
  "the", "and", "of", "for", "a", "an", "at", "by", "in", "on", "to", "your", "our",
  "group", "holdings", "enterprises", "services", "solutions", "systems", "international",
]);

/**
 * Reduce a business name to the words that identify it.
 *
 * ⚠️ "dba" IS A SEPARATOR, NOT A WORD. "CSM Capital LLC DBA Structure Studio Suite" is one
 * legitimate business with a trading name, and the trading name — the half AFTER the dba — is
 * the half that appears on the consent box and in the messages. Splitting on it is what makes
 * that real, live pairing pass instead of warning at our own only tenant.
 */
function nameTokens(name: string): string[] {
  let s = String(name ?? "").trim().toLowerCase();
  // "d/b/a", "dba", "d.b.a." and "trading as" all mean the same thing; keep what follows.
  const dba = s.split(/\b(?:d\s*[\/.]?\s*b\s*[\/.]?\s*a|dba|trading as|t\/a)\b/);
  if (dba.length > 1) s = dba[dba.length - 1];
  return s
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !COMPANY_FORM_WORDS.has(w));
}

/** Words from a name that are worth matching on. 3 characters, not 4, so initialisms like
 *  "csm" and "abc" still count — they are usually the most identifying part of a name. */
function significantTokens(name: string): string[] {
  return nameTokens(name).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
}

/** Does a message sample look like it has a link in it? Deliberately generous: the question
 *  behind the rule is "did you forget to tick the box", so a near-miss should still ask. */
const LOOKS_LIKE_A_LINK = /(?:https?:\/\/|\bwww\.[a-z0-9-]|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|us|app|uk|info|link|site|shop|biz)\b|\{\{\s*[a-z_.]*(?:link|url)[a-z_.]*\s*\}\})/i;

// ─────────────────────────────────────────────────────────────────────────────
// Policy pages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade a privacy policy or a terms page.
 *
 * `page` is null when the caller did not fetch it (no time budget left, or the URL was one we
 * refused to visit). That is a warn, never a fail — see the header.
 *
 * ⚠️ RATES AND FREQUENCY ARE CHECKED ON TERMS, NEVER ON PRIVACY. The industry guidance puts
 * that language beside the sign-up control and in the programme terms, and Twilio's own 30924
 * refusal explicitly wants it NEXT TO the consent tick box rather than buried in a linked
 * policy. Our own privacy page does not carry it and is right not to. Checking for it on the
 * privacy page would warn at builders who have done it correctly — which is the exact mistake
 * this module exists to avoid. (The builder-facing checklist that says otherwise is wrong and
 * is being corrected separately.)
 */
export function policyPageChecks(
  kind: "privacy" | "terms",
  url: string,
  page: PageFetch | null,
): Check[] {
  const k = kind;
  const noun = kind === "privacy" ? "privacy policy" : "terms and conditions";
  const Noun = kind === "privacy" ? "Privacy policy" : "Terms and conditions";
  const rows: Check[] = [];

  // ── 1. The link itself. Ours, deterministic, no network — so this may fail.
  //
  // Checked BEFORE the "did we fetch it?" row on purpose: when the link is blank, telling the
  // builder "we could not read your policy" instead of "you have not given us one" sends them
  // to look at a web server that is working perfectly.
  const problem = urlProblem(url);
  if (problem) {
    const reason = problem === "empty"
      ? `We do not have a link to your ${noun}.`
      : problem === "scheme"
      ? `The ${noun} link we hold is not a secure (https) address: ${String(url).trim()}`
      : `The ${noun} link we hold is not a working web address: ${String(url).trim()}`;
    rows.push(row(
      `page.${k}.url`,
      "policy",
      `${Noun} link`,
      "fail",
      reason,
      `Add the full address of your ${noun}, starting with https:// — for example ` +
        `https://your-website.com/${kind === "privacy" ? "privacy" : "terms"}.`,
    ));
    return rows;
  }
  rows.push(row(
    `page.${k}.url`,
    "policy",
    `${Noun} link`,
    "pass",
    `We have a secure link to your ${noun}: ${String(url).trim()}`,
    "",
  ));

  // ── 2. Did anyone answer? Everything from here down is about somebody else's web server,
  // so everything from here down is warn at worst.
  const openHint =
    "Open it in a private browser window, signed out, to check a stranger can read it. " +
    "Some websites block visitors that are not a person clicking, and we cannot tell that " +
    "apart from a page that is missing.";

  if (!page) {
    rows.push(row(
      `page.${k}.reachable`,
      "policy",
      `${Noun} opens for anyone`,
      "warn",
      `We did not manage to open your ${noun} this time.`,
      openHint,
    ));
    return rows;
  }

  if (!page.ok || page.status < 200 || page.status >= 300 || !page.text) {
    const reason = page.status === 0
      ? `Your ${noun} did not answer us at all.`
      : `Your ${noun} answered with an error (code ${page.status}).`;
    rows.push(row(
      `page.${k}.reachable`,
      "policy",
      `${Noun} opens for anyone`,
      "warn",
      reason,
      openHint,
    ));
    return rows;
  }
  rows.push(row(
    `page.${k}.reachable`,
    "policy",
    `${Noun} opens for anyone`,
    "pass",
    `Your ${noun} opened when we visited it.`,
    "",
  ));

  // ── 3. Was it readable prose? A PDF or an image of a policy is a real policy and a
  // perfectly legal one — we simply cannot read it from here, and neither, in practice, can
  // the reviewer's automated pass.
  if (!page.html) {
    rows.push(row(
      `page.${k}.readable`,
      "policy",
      `${Noun} is readable text`,
      "warn",
      `Your ${noun} opened, but not as a normal web page — it may be a PDF or a download.`,
      `Put the wording on an ordinary web page as well, so it can be read without ` +
        `downloading anything. Keep the PDF too if you want it.`,
    ));
    return rows;
  }
  if (page.truncated) {
    // We still run the wording rules below: anything found in the part we read is really
    // there. Only an ABSENCE is untrustworthy, and an absence is a warn either way.
    rows.push(row(
      `page.${k}.readable`,
      "policy",
      `${Noun} is readable text`,
      "warn",
      `Your ${noun} is very long, so we only read the beginning of it.`,
      "Anything we say below about missing wording may be wrong — check the rest by eye.",
    ));
  } else {
    rows.push(row(
      `page.${k}.readable`,
      "policy",
      `${Noun} is readable text`,
      "pass",
      `We could read your ${noun} as ordinary text.`,
      "",
    ));
  }

  // ── 4. Wording. Absent → warn, always. `page.text` is already lowercased and
  // whitespace-collapsed by `visibleText`, and is never quoted back to the builder.
  const t = page.text;

  rows.push(
    hasAny(t, MENTIONS_TEXTING)
      ? row(`page.${k}.texting`, "policy", `${Noun} mentions text messages`, "pass",
        `Your ${noun} talks about text messaging.`, "")
      : row(`page.${k}.texting`, "policy", `${Noun} mentions text messages`, "warn",
        `We could not find anything about text messaging in your ${noun}.`,
        `Add a short section about text messages — that you send them, what about, and how ` +
          `someone stops them.`),
  );

  if (kind === "privacy") {
    // The one that gets registrations refused more than any other.
    rows.push(
      hasNonSharingStatement(t)
        ? row("page.privacy.no_sharing", "policy",
          "Privacy policy says phone numbers are not passed on", "pass",
          "Your privacy policy says mobile numbers and text message permissions are not " +
            "passed to anyone else.", "")
        : row("page.privacy.no_sharing", "policy",
          "Privacy policy says phone numbers are not passed on", "warn",
          "We could not find a sentence in your privacy policy saying that mobile numbers " +
            "and text message permissions are not shared with anyone else.",
          "Add a line such as: \"No mobile information will be shared with third parties " +
            "or affiliates for marketing or promotional purposes.\" This is the single most " +
            "common reason a texting application is turned down."),
    );
    return rows;
  }

  // ⚠️ NEAR A MENTION OF TEXTING, NOT ANYWHERE ON THE PAGE. `\bhelp\b` on its own passes on
  // essentially every small-business website, because almost all of them have a "Help" link in
  // the footer — measured: a terms page with the STOP/HELP sentence removed but a
  // `<nav><a href="/help">Help Centre</a></nav>` still scored a green tick. A false PASS here
  // is the worst outcome this module can produce: it is the one that reaches a carrier audit,
  // having told the builder they were fine. `stop` has the same weakness in milder form
  // ("stop by our showroom"). Same proximity machinery the non-sharing rule uses.
  rows.push(
    hasNear(t, STOP_WORDS)
      ? row("page.terms.stop", "policy", "Terms tell people how to stop the messages", "pass",
        "Your terms explain how to stop receiving messages.", "")
      : row("page.terms.stop", "policy", "Terms tell people how to stop the messages", "warn",
        "We could not find a STOP instruction in the texting part of your terms.",
        "Add: \"Reply STOP to any message to stop receiving them.\""),
  );
  rows.push(
    hasNear(t, HELP_WORDS)
      ? row("page.terms.help", "policy", "Terms tell people how to get help", "pass",
        "Your terms explain how to get help.", "")
      : row("page.terms.help", "policy", "Terms tell people how to get help", "warn",
        "We could not find a HELP instruction in the texting part of your terms.",
        "Add: \"Reply HELP for help, or contact us on <your phone number>.\""),
  );
  rows.push(
    hasAny(t, FREQUENCY_WORDS)
      ? row("page.terms.frequency", "policy", "Terms say how often messages are sent", "pass",
        "Your terms say how often messages go out.", "")
      : row("page.terms.frequency", "policy", "Terms say how often messages are sent", "warn",
        "We could not find anything in your terms about how often you send messages.",
        "Add: \"Message frequency varies.\""),
  );
  rows.push(
    hasAny(t, RATES_WORDS)
      ? row("page.terms.rates", "policy",
        "Terms say that message and data rates may apply", "pass",
        "Your terms warn that the customer's own network may charge them.", "")
      : row("page.terms.rates", "policy",
        "Terms say that message and data rates may apply", "warn",
        "We could not find a line in your terms saying the customer's own network may " +
          "charge them for messages.",
        "Add: \"Message and data rates may apply.\""),
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// The opt-in page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade the page that carries our own consent tick box.
 *
 * ⚠️ BE HONEST ABOUT WHAT THIS CAN ASSERT — AND IT IS LESS THAN YOU THINK.
 *
 * The tick box is ours, but it is drawn by React from a compiled bundle, it only mounts once
 * a visitor has worked the design canvas, and once someone has ticked it, it is suppressed
 * for that browser by localStorage. Fetching the page gets `<title>Loading…</title>` and ZERO
 * occurrences of the consent sentence. That was measured, not assumed.
 *
 * So this function does NOT grep our own page for consent wording. A "pass" next to
 * "consent wording found" would be a green tick beside a statement we know to be untrue —
 * and the builder would carry that false comfort into a submission. The wording itself is
 * pinned where it can actually be pinned: in `smsConsentText.ts` and its unit tests.
 *
 * What is left is honest: did the page answer, and does the sentence it will render name a
 * business.
 */
export function optInPageChecks(page: PageFetch | null, consentCompanyName: string): Check[] {
  const rows: Check[] = [];

  const reachHint =
    "Open your website in a private browser window and check the page loads, then work " +
    "through to the point where the tick box appears and read it.";

  if (!page) {
    rows.push(row(
      "optin.page.reachable", "optin", "Your sign-up page opens", "warn",
      "We did not manage to open the page that shows your sign-up tick box.",
      reachHint,
    ));
  } else if (!page.ok || page.status < 200 || page.status >= 300) {
    const reason = page.status === 0
      ? "The page that shows your sign-up tick box did not answer us at all."
      : `The page that shows your sign-up tick box answered with an error (code ${page.status}).`;
    rows.push(row(
      "optin.page.reachable", "optin", "Your sign-up page opens", "warn", reason, reachHint,
    ));
  } else {
    rows.push(row(
      "optin.page.reachable", "optin", "Your sign-up page opens", "pass",
      "The page that shows your sign-up tick box opened when we visited it. We cannot read " +
        "the tick box itself from outside — it only appears once a visitor has designed " +
        "their building — so please read it on screen yourself before you submit.",
      "",
    ));
  }

  // ── The one fail this group may emit. Deterministic, entirely about our own database row,
  // and no web page is involved.
  //
  // "this builder" is the literal fallback `smsConsentSentence()` substitutes when the name is
  // missing, so an empty name is not a blank in the sentence — it renders, live, as "this
  // builder may send you text messages about your quote and your building". A reviewer reads
  // that as an unidentified sender, which is an automatic refusal.
  const co = String(consentCompanyName ?? "").trim();
  if (!co || co.toLowerCase() === "this builder") {
    rows.push(row(
      "optin.company_name", "optin", "Your business name appears in the tick box", "fail",
      "The tick box on your website does not name your business. It currently reads " +
        "\"this builder may send you text messages about your quote and your building\".",
      "Set your business name in Settings. Customers must be able to see who is going to " +
        "text them, and an unnamed sender is turned down every time.",
    ));
  } else {
    rows.push(row(
      "optin.company_name", "optin", "Your business name appears in the tick box", "pass",
      `The tick box on your website names your business: ${co}`,
      "",
    ));
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consistency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Does it all match?" — the half a builder actually asks about, and the only group that
 * needs no network at all. Every row here compares two values we already hold, and every row
 * here is warn at worst: a mismatch between two of our own fields is a thing worth mentioning,
 * never a thing worth blocking a submission over.
 */
export function consistencyChecks(d: Declared): Check[] {
  const rows: Check[] = [];

  const siteHost = hostOf(d.websiteUrl);
  const siteDomain = registrableDomain(siteHost);

  // ── Policy links on the builder's own domain.
  for (const [key, label, noun, url] of [
    ["match.privacy_domain", "Privacy policy sits on your own website", "privacy policy", d.privacyPolicyUrl],
    ["match.terms_domain", "Terms sit on your own website", "terms", d.termsUrl],
  ] as const) {
    const host = hostOf(url);
    const domain = registrableDomain(host);
    if (!siteDomain || !domain) {
      rows.push(row(
        key, "consistency", label, "warn",
        `We could not compare your ${noun} link with your website address, because one of ` +
          `the two is missing or is not a working web address.`,
        `Check both your website address and your ${noun} link are full addresses starting ` +
          `with https://.`,
      ));
      continue;
    }
    if (domain === siteDomain) {
      rows.push(row(
        key, "consistency", label, "pass",
        `Your ${noun} is on the same website as your business: ${domain}`,
        "",
      ));
    } else {
      rows.push(row(
        key, "consistency", label, "warn",
        `Your ${noun} is on ${domain}, but your website is ${siteDomain}.`,
        `This is often perfectly fine — plenty of businesses host their policies on a ` +
          `separate page-builder or booking site. Just be ready for it to be queried, and ` +
          `make sure the page clearly names your business so the link is obviously yours.`,
      ));
    }
  }

  // ── Two copies of the website address, in two tables, never synced.
  //
  // ⚠️ THIS FIRES TODAY on the only real tenant: one field still holds the pre-rebrand domain
  // and the other holds the current one. It is a genuine finding, not a bug in this rule.
  const a = normaliseWebsite(d.websiteUrl);
  const b = normaliseWebsite(d.settingsWebsite);
  if (!a || !b) {
    rows.push(row(
      "match.website", "consistency", "Website address is the same in both places", "warn",
      "We are missing your website address in one of the two places we keep it.",
      "Fill in your website address in Settings and on the texting form, and make sure both " +
        "say the same thing.",
    ));
  } else if (a === b) {
    rows.push(row(
      "match.website", "consistency", "Website address is the same in both places", "pass",
      `Your website address matches everywhere we hold it: ${a}`,
      "",
    ));
  } else {
    rows.push(row(
      "match.website", "consistency", "Website address is the same in both places", "warn",
      `Your texting details say ${String(d.websiteUrl).trim()}, but your settings say ` +
        `${String(d.settingsWebsite).trim()}.`,
      "Make both say the same address — usually the newer one. A reviewer who opens the " +
        "wrong one may not find the business they are checking.",
    ));
  }

  // ── The legal name vs the name customers see on the tick box.
  //
  // ⚠️ A TRADING NAME IS NOT A MISMATCH. "Structure Studio" against "CSM Capital LLC DBA
  // Structure Studio Suite" is one business, correctly registered, and MUST pass — warning at
  // it would send a builder off to "fix" something that is already right. `nameTokens` splits
  // on dba for exactly this pair.
  const consentToks = significantTokens(d.consentCompanyName);
  const legalToks = new Set(significantTokens(d.legalBusinessName));
  const sharedWord = consentToks.find((w) => legalToks.has(w)) ?? null;
  if (!consentToks.length || !legalToks.size) {
    rows.push(row(
      "match.business_name", "consistency", "Business name matches the name on the tick box",
      "warn",
      "We are missing either your registered business name or the name shown to customers, " +
        "so we could not compare them.",
      "Fill in both your registered business name and the business name customers see.",
    ));
  } else if (sharedWord) {
    rows.push(row(
      "match.business_name", "consistency", "Business name matches the name on the tick box",
      "pass",
      `The name customers see (${String(d.consentCompanyName).trim()}) and your registered ` +
        `name (${String(d.legalBusinessName).trim()}) clearly belong to the same business.`,
      "",
    ));
  } else {
    rows.push(row(
      "match.business_name", "consistency", "Business name matches the name on the tick box",
      "warn",
      `Customers see ${String(d.consentCompanyName).trim()}, but your registered business ` +
        `name is ${String(d.legalBusinessName).trim()}, and the two have no word in common.`,
      "If you trade under a different name that is fine — write it as \"Registered Name DBA " +
        "Trading Name\" so the connection is obvious. Otherwise make the two names match.",
    ));
  }

  // ── The messages themselves must say who they are from.
  const samples = (d.messageSamples ?? []).map((s) => String(s ?? "")).filter((s) => s.trim());
  const wanted = consentToks.length ? consentToks : significantTokens(d.legalBusinessName);
  if (!samples.length) {
    rows.push(row(
      "match.samples.name", "consistency", "Example messages say who they are from", "warn",
      "You have not given any example messages yet.",
      "Add at least one example of a message you would send, with your business name in it.",
    ));
  } else if (!wanted.length) {
    rows.push(row(
      "match.samples.name", "consistency", "Example messages say who they are from", "warn",
      "We could not check your example messages, because we do not have your business name.",
      "Fill in your business name, then check each example message starts by saying who it " +
        "is from.",
    ));
  } else {
    // ⚠️ SOME, NOT EVERY — and the row two above already knew that. Requiring every token of a
    // trading name means "Northfield Sheds and Garages" is only named by a message carrying all
    // four words, which no 160-character text does; "Northfield Sheds: your quote is ready"
    // scored a warn whose reason told the builder, untruthfully, that none of their messages
    // mentioned their business. Two rules in one file disagreeing about what "names the
    // business" means is how a builder learns to distrust the whole card.
    const named = samples.some((s) => {
      const low = s.toLowerCase();
      return wanted.some((w) => low.includes(w));
    });
    rows.push(named
      ? row("match.samples.name", "consistency", "Example messages say who they are from",
        "pass", "Your example messages name your business.", "")
      : row("match.samples.name", "consistency", "Example messages say who they are from",
        "warn",
        `None of your example messages mention ${String(d.consentCompanyName || d.legalBusinessName).trim()}.`,
        "Start each example with your business name, for example \"Hi, it's " +
          `${String(d.consentCompanyName || d.legalBusinessName).trim()} — your quote is ready.\" ` +
          "Someone reading the message must know instantly who sent it."),
    );
  }

  // ── Links in the messages have to be declared.
  const sampleWithLink = samples.some((s) => LOOKS_LIKE_A_LINK.test(s));
  if (sampleWithLink && !d.hasEmbeddedLinks) {
    rows.push(row(
      "match.samples.links", "consistency", "Links in example messages are declared", "warn",
      "One of your example messages contains a web link, but you have told us your messages " +
        "do not contain links.",
      "Tick the box that says your messages include links. The two answers have to agree.",
    ));
  } else {
    rows.push(row(
      "match.samples.links", "consistency", "Links in example messages are declared", "pass",
      "What you told us about links in your messages matches your example messages.",
      "",
    ));
  }

  return rows;
}
