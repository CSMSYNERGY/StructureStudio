// Settings → Email Settings: the DMARC advisory row only where DNS says there is no record
// (2026-10-05), driven for real on the COMPILED portal.
//
// The DNS table used to add "TXT _dmarc.<domain>  v=DMARC1; p=none; rua=…" for every domain, and the
// "Email this to my webmaster" button put the same row in the email. Every builder domain waiting to
// connect already had a record, one of them p=reject; following the row there adds a second record
// (receivers then ignore both) or swaps the builder's policy for none. email_status now carries
// existingDmarc (portal-settings, _shared/dmarcLookup.ts), and this asserts what the screen does with it:
//
//   A. one record (p=quarantine): no _dmarc row in the table, no ★ "recommended" note, the line "You
//      already have a DMARC record (p=quarantine). Leave it as it is", and the webmaster email carries
//      no _dmarc row and no DMARC note, while it still carries every record Resend returned
//   B. two records: no row, and a warning that two records cancel each other out; nothing in the email
//   C. no record (DNS said so, about this domain): the row, the ★ note and the email's row and note,
//      exactly as before
//   D. the lookup failed (null): no row, no note, no line, no warning, nothing in the email
//   E. a server from before the check (no existingDmarc at all): the same as D
//   F. "no record" about some OTHER name than the DKIM host's domain: treated as unknown, no row
//   G. a sending subdomain covered by its parent's record (p=reject): the line, no row
//   H. verified: two records warn on the sending card too; one record says nothing extra there, and
//      the webmaster email leaves the row out; no record keeps the row in that email
//
// Supabase is stubbed at the network layer: no login, nothing leaves the machine, nothing is sent.
// A picture of each scenario's card lands in %TEMP%/ss-harness/dmarc-advisory (SS_SHOTS overrides).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/dmarcAdvisory.mjs           (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to prove
// the checks can fire: against the artifact from before this change, A, B, D, E, F and G fail (the row
// is always there).
//
// Domains are made up (.test). The repo is public.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));

// Resend's records, the shape portal-settings snapshots (a short DKIM value keeps the email in budget).
const recordsFor = (dom, verified) => [
  { type: "TXT", host: `resend._domainkey.${dom}`, value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDz4kQx7", verified },
  { type: "MX", host: `send.${dom}`, value: "feedback-smtp.example.test", verified, priority: 10 },
  { type: "TXT", host: `send.${dom}`, value: "v=spf1 include:example.test ~all", verified },
];
const DOM = "acmesheds.test";
const NAME = `_dmarc.${DOM}`;

const { ok, failed } = reporter();
const shots = shotsDir("dmarc-advisory");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** One fresh context per scenario. `dmarc` is existingDmarc as the server sends it; `undefined`
 *  leaves the key out (a server from before the check). */
async function scenario(browser, { name, dom = DOM, st = "pending", dmarc }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    if (body.action === "status") {
      return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
        phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: st === "verified" });
    }
    if (body.action === "email_status") {
      return json(route, {
        clientId: CLIENT, platformReady: true, templateCopy: null, domainStatus: st, domain: dom,
        fromName: "Acme Sheds", fromLocal: "info", fromAddress: `info@${dom}`, verifiedAt: st === "verified" ? "2026-09-01T12:00:00Z" : null,
        lastError: null, active: st === "verified",
        dnsRecords: recordsFor(dom, st === "verified"),
        ...(dmarc === undefined ? {} : { existingDmarc: dmarc }),
        inbound: { status: "off", domain: null, dnsRecords: [], verifiedAt: null, lastError: null, replyExample: null },
        recentSends: [],
      });
    }
    return json(route, { ok: true });
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await ctx.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/email"); window.dispatchEvent(new PopStateEvent("popstate")); });
  const ready = st === "verified" ? "Send a test email" : "Add these records at your DNS host";
  const shown = await page.waitForFunction((x) => document.body.innerText.includes(x), ready, { timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => document.body.innerText);
  const cells = await page.$$eval("table td", (tds) => tds.map((t) => t.innerText));
  // The webmaster button's email, decoded: subject + body.
  const href = await page.locator('a[href^="mailto:?subject="]').first().getAttribute("href", { timeout: 3000 }).catch(() => null);
  const mail = href ? decodeURIComponent(href.replace(/^mailto:\?/, "").replace(/&body=/, "\n")) : "";
  // A picture of the card, for a person to look at (not asserted on).
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("div")].find((d) => /^(Add these records at your DNS host|Email sending)$/.test(d.innerText.trim()));
    if (h) h.scrollIntoView({ block: "start" });
  });
  await page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
  await ctx.close();
  return { shown, text, cells, mail };
}

const LEAVE = "You already have a DMARC record";
const STAR = "record is strongly recommended";
const CANCEL = "cancel each other out";
const rowShown = (s, host = NAME) => s.cells.some((c) => c.includes(host));
const mailHasDmarc = (s) => /_dmarc\./.test(s.mail) || /DMARC record/.test(s.mail);
/** Every record Resend returned is still in the webmaster email. */
const mailHasResend = (s, dom = DOM) => recordsFor(dom, false).every((r) => s.mail.includes(`Name/Host: ${r.host}`));

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // A — one record
  {
    const s = await scenario(browser, { name: "A", dmarc: { present: true, policy: "quarantine", count: 1, host: NAME } });
    if (!ok("A0 the records card rendered", s.shown)) throw new Error("Email Settings never rendered; refusing to report the rest as passes");
    ok("A1 one record: no _dmarc row in the table", !rowShown(s), s.cells.filter((c) => c.includes("_dmarc")).join(" | "));
    ok("A2 one record: no ★ recommended note", !s.text.includes(STAR));
    ok("A3 one record: \"You already have a DMARC record (p=quarantine). Leave it as it is\"",
      s.text.includes(`${LEAVE} (p=quarantine). Leave it as it is`), (s.text.match(/You already[^\n]*/) || [""])[0]);
    ok("A4 one record: no duplicate warning", !s.text.includes(CANCEL));
    ok("A5 one record: the webmaster email has no _dmarc row and no DMARC note", s.mail && !mailHasDmarc(s), s.mail.slice(0, 200));
    ok("A6 one record: the webmaster email still has every record Resend returned", mailHasResend(s));
  }
  // B — two records
  {
    const s = await scenario(browser, { name: "B", dmarc: { present: true, policy: null, count: 2, host: NAME } });
    ok("B1 two records: no _dmarc row", s.shown && !rowShown(s));
    ok("B2 two records: the warning says they cancel each other out", s.text.includes(`Your domain has 2 DMARC records (at ${NAME})`) && s.text.includes(`Two records ${CANCEL}`),
      (s.text.match(/Your domain has[^\n]*/) || [""])[0]);
    ok("B3 two records: and says what to do", s.text.includes("Ask whoever manages your DNS to delete the extra one."));
    ok("B4 two records: no \"leave it\" line, no ★ note", !s.text.includes(LEAVE) && !s.text.includes(STAR));
    ok("B5 two records: nothing about DMARC in the webmaster email", s.mail && !mailHasDmarc(s) && mailHasResend(s));
  }
  {
    const s = await scenario(browser, { name: "B3x", dmarc: { present: true, policy: null, count: 3, host: NAME } });
    ok("B6 three records: the warning says keep one and delete the rest", s.text.includes("Your domain has 3 DMARC records") && s.text.includes("keep one and delete the rest"));
  }
  // C — no record: as before
  {
    const s = await scenario(browser, { name: "C", dmarc: { present: false, policy: null, count: 0, host: NAME } });
    ok("C1 no record: the _dmarc row is in the table", rowShown(s) && s.cells.some((c) => c.includes(`v=DMARC1; p=none; rua=mailto:info@${DOM}`)),
      s.cells.filter((c) => c.includes("DMARC")).join(" | "));
    ok("C2 no record: the ★ recommended note", s.text.includes(STAR));
    ok("C3 no record: no \"leave it\" line, no warning", !s.text.includes(LEAVE) && !s.text.includes(CANCEL));
    ok("C4 no record: the webmaster email carries the row and its note", s.mail.includes(`Name/Host: ${NAME}`) && s.mail.includes("Note on the DMARC record"), s.mail.slice(-400));
  }
  // D, E — unknown
  for (const [id, label, dmarc] of [["D", "lookup failed", null], ["E", "older server", undefined]]) {
    const s = await scenario(browser, { name: id, dmarc });
    ok(`${id}1 ${label}: no _dmarc row`, s.shown && !rowShown(s));
    ok(`${id}2 ${label}: no ★ note, no "leave it" line, no warning`, !s.text.includes(STAR) && !s.text.includes(LEAVE) && !s.text.includes(CANCEL));
    ok(`${id}3 ${label}: nothing about DMARC in the webmaster email`, s.mail && !mailHasDmarc(s) && mailHasResend(s));
  }
  // F — "none" about some other name
  {
    const s = await scenario(browser, { name: "F", dmarc: { present: false, policy: null, count: 0, host: "_dmarc.www.acmesheds.test" } });
    ok("F1 \"no record\" about another name: no row", s.shown && !rowShown(s) && !s.cells.some((c) => c.includes("_dmarc")));
    ok("F2 and nothing in the email", !mailHasDmarc(s));
  }
  // G — a subdomain covered by its parent
  {
    const s = await scenario(browser, { name: "G", dom: `mail.${DOM}`, dmarc: { present: true, policy: "reject", count: 1, host: NAME } });
    ok("G1 subdomain under a p=reject parent: no row (p=none would weaken it)", s.shown && !rowShown(s, `_dmarc.mail.${DOM}`) && !rowShown(s));
    ok("G2 and the \"leave it\" line names the policy", s.text.includes(`${LEAVE} (p=reject). Leave it as it is`));
    ok("G3 nothing about DMARC in the email", !mailHasDmarc(s) && mailHasResend(s, `mail.${DOM}`));
  }
  // H — verified
  {
    const s = await scenario(browser, { name: "H2", st: "verified", dmarc: { present: true, policy: null, count: 2, host: NAME } });
    ok("H1 verified, two records: the sending card warns", s.shown && s.text.includes(`Your domain has 2 DMARC records (at ${NAME})`));
  }
  {
    const s = await scenario(browser, { name: "H1", st: "verified", dmarc: { present: true, policy: "none", count: 1, host: NAME } });
    ok("H2 verified, one record: no warning and no extra line", s.shown && !s.text.includes(CANCEL) && !s.text.includes(LEAVE));
    ok("H3 verified, one record: the webmaster email leaves the row out", s.mail && !mailHasDmarc(s) && mailHasResend(s));
  }
  {
    const s = await scenario(browser, { name: "H0", st: "verified", dmarc: { present: false, policy: null, count: 0, host: NAME } });
    ok("H4 verified, no record: the webmaster email keeps the row", s.mail.includes(`Name/Host: ${NAME}`));
  }
  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${bad.length ? "FAILED" : "all passed"}: ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
