// my-quotes.html prints the SERVER'S consent sentences (2026-10-06), driven for real.
//
// customer-accept stores the sentence a customer agrees to verbatim as the evidence
// (design_acceptances.consent_text, composed in _shared/consentSentences.ts), and customer-quotes
// sends that exact sentence down with each estimate: acceptConsentText for Review & Accept and
// signConsentText for the invoice signature. The designer's account panel always printed those;
// my-quotes composed its own copies, so the sentence on screen and the stored one could come from
// different builds — which the "quote" → "estimate" rewording would have made real for every
// customer on an old link. Now my-quotes prints what it is given and composes only as a fallback.
//
//   A. Review & Accept prints acceptConsentText byte for byte — a sentence the page could not
//      have composed itself (its figure differs from the card's total).
//   B. The invoice signature prints signConsentText byte for byte, the same way.
//   C. With no sentence from the server, the fallbacks say "estimate" (never "quote").
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/myQuotesConsentText.mjs      (exit 0 = every check held)
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
// SS_MYQUOTES_HTML=<an older my-quotes.html> serves that page instead: before this change A and B fail.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
// The server's words, deliberately NOT what the page would compose: the figures differ from the
// cards' totals, so only printing the field verbatim can put them on screen.
const ACCEPT_SENTENCE = "I accept estimate AS-2041 for $1,234.50 and understand that my builder will send me an invoice to sign.";
const SIGN_SENTENCE = "I agree that my electronic signature is as binding as a handwritten one, and I accept invoice INV-77 for $555.55.";
const BASE_Q = { pdfUrl: null, acceptUrl: null, ssQuote: true, view3dImageUrl: null, changeOrders: [], invoiceRequest: null, style: "Utility", size: "10x12", createdAt: "2026-09-20T15:00:00Z" };
const QUOTES = [
  { ...BASE_Q, quoteRef: "SS-CONSENTA01", estimateNumber: "AS-2041", status: "sent", total: 999, canAccept: true, invoice: null, acceptConsentText: ACCEPT_SENTENCE, signConsentText: null },
  { ...BASE_Q, quoteRef: "SS-CONSENTB02", estimateNumber: "AS-2042", status: "accepted", total: 500, canAccept: false, canSignInvoice: true,
    invoice: { number: "INV-77", amountDue: 500, signedAt: null, stale: false, pdfUrl: null }, acceptConsentText: null, signConsentText: SIGN_SENTENCE },
  { ...BASE_Q, quoteRef: "SS-CONSENTC03", estimateNumber: "AS-2043", status: "sent", total: 3000, canAccept: true, invoice: null },
  { ...BASE_Q, quoteRef: "SS-CONSENTD04", estimateNumber: "AS-2044", status: "accepted", total: 700, canAccept: false, canSignInvoice: true,
    invoice: { number: "INV-78", amountDue: 700, signedAt: null, stale: false, pdfUrl: null } },
];

const { ok, failed } = reporter();
const shots = shotsDir("my-quotes-consent-text");
const HTML_OVERRIDE = process.env.SS_MYQUOTES_HTML ? readFileSync(process.env.SS_MYQUOTES_HTML, "utf8") : null;
const { browser, ctx } = await launch({ width: 1200, height: 1000 });
await ctx.addInitScript((client) => {
  try {
    localStorage.setItem("ssq_token_" + client, "harness-customer-token-0123456789abcdef");
    localStorage.setItem("ssq_name_" + client, "Pat Tester");
  } catch (_e) { /* storage blocked */ }
}, CLIENT);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/customer-auth")) return json(route, { ok: true, channels: ["sms"], defaultChannel: "sms" });
  if (url.includes("/customer-quotes")) return json(route, { ok: true, businessName: "Acme Sheds", name: "Pat Tester", ssMode: true, quotes: QUOTES });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (HTML_OVERRIDE) await page.route(/my-quotes\.html/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: HTML_OVERRIDE }));

const card = (ref) => page.locator(".quote-card").filter({ hasText: QUOTES.find((q) => q.quoteRef === ref).estimateNumber });
const consentIn = async (loc) => (await loc.locator(".consent-row span").first().textContent({ timeout: 5000 }).catch(() => null));

try {
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  const listed = await page.waitForFunction(() => document.body.innerText.includes("AS-2041"), null, { timeout: 20000 }).then(() => true, () => false);
  if (!ok("0 the estimates list renders", listed)) throw new Error("my-quotes never listed the fixtures; refusing to report the rest as passes");

  // A
  await card("SS-CONSENTA01").getByRole("button", { name: "Review & Accept" }).click();
  const a = await consentIn(card("SS-CONSENTA01"));
  ok("A1 Review & Accept prints the server's acceptConsentText byte for byte", a === ACCEPT_SENTENCE, JSON.stringify(a));
  await card("SS-CONSENTA01").screenshot({ path: join(shots, "A-accept-server-sentence.png") }).catch(() => {});

  // B
  await card("SS-CONSENTB02").getByRole("button", { name: "Review & Sign Invoice" }).click();
  const b = await consentIn(card("SS-CONSENTB02"));
  ok("B1 the invoice signature prints the server's signConsentText byte for byte", b === SIGN_SENTENCE, JSON.stringify(b));

  // C
  await card("SS-CONSENTC03").getByRole("button", { name: "Review & Accept" }).click();
  const c = await consentIn(card("SS-CONSENTC03"));
  ok("C1 with no sentence from the server, the accept fallback says estimate",
    c === "I accept estimate AS-2043 for $3,000.00 and understand that my builder will send me an invoice to sign.", JSON.stringify(c));
  await card("SS-CONSENTD04").getByRole("button", { name: "Review & Sign Invoice" }).click();
  const d = await consentIn(card("SS-CONSENTD04"));
  ok("C2 and the invoice fallback is unchanged",
    d === "I agree that my electronic signature is as binding as a handwritten one, and I accept invoice INV-78 for $700.00.", JSON.stringify(d));
  const body = await page.evaluate(() => document.body.innerText);
  ok("C3 nothing on the page says quote", !/\bquot(e|es|ed|ing)\b/i.test(body), (body.match(/.{0,40}\bquot\w*.{0,40}/i) || [""])[0]);
  ok("C4 no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await page.screenshot({ path: join(shots, "my-quotes-estimates.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed; shots in ${shots}`);
process.exit(f.length ? 1 : 0);
