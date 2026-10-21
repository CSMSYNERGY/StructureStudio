// my-quotes.html says whom the customer signs for (quote to a business entity, 2026-10-21).
//
// customer-quotes sends `signingFor` (designs.contact.company) with an estimate that is for a
// business. The person still types their OWN name; under the name box the page says "Signing for
// <company>", and the certificate prints it as "On behalf of".
//
//   A. Review & Accept on a business's estimate: "Signing for Bear River Band" under the name box.
//   B. The invoice signature on a business's estimate: the same line.
//   C. An estimate with no company: no such line, the panel as it always was.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/myQuotesSigningFor.mjs       (exit 0 = every check held)
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const BASE_Q = { pdfUrl: null, acceptUrl: null, ssQuote: true, view3dImageUrl: null, changeOrders: [], invoiceRequest: null, style: "Utility", size: "10x12", createdAt: "2026-09-20T15:00:00Z" };
const QUOTES = [
  { ...BASE_Q, quoteRef: "SS-SIGNFOR001", estimateNumber: "AS-3101", status: "sent", total: 999, canAccept: true, invoice: null, signingFor: "Bear River Band" },
  { ...BASE_Q, quoteRef: "SS-SIGNFOR002", estimateNumber: "AS-3102", status: "accepted", total: 500, canAccept: false, canSignInvoice: true,
    invoice: { number: "INV-91", amountDue: 500, signedAt: null, stale: false, pdfUrl: null }, signingFor: "Bear River Band" },
  { ...BASE_Q, quoteRef: "SS-SIGNFOR003", estimateNumber: "AS-3103", status: "sent", total: 3000, canAccept: true, invoice: null },
];

const { ok, failed } = reporter();
const shots = shotsDir("my-quotes-signing-for");
const { browser, ctx } = await launch({ width: 1200, height: 1000 });
await ctx.addInitScript((client) => {
  try {
    localStorage.setItem("ssq_token_" + client, "harness-customer-token-0123456789abcdef");
    localStorage.setItem("ssq_name_" + client, "Thomas Example");
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
  if (url.includes("/customer-quotes")) return json(route, { ok: true, businessName: "Acme Sheds", name: "Thomas Example", ssMode: true, quotes: QUOTES });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);

const card = (ref) => page.locator(".quote-card").filter({ hasText: QUOTES.find((q) => q.quoteRef === ref).estimateNumber });
const signingFor = async (loc) => (await loc.locator(".signing-for").first().textContent({ timeout: 3000 }).catch(() => null));

try {
  await page.goto(`${BASE}/my-quotes.html?client=${CLIENT}`, { waitUntil: "domcontentloaded" });
  const listed = await page.waitForFunction(() => document.body.innerText.includes("AS-3101"), null, { timeout: 20000 }).then(() => true, () => false);
  if (!ok("0 the estimates list renders", listed)) throw new Error("my-quotes never listed the fixtures; refusing to report the rest as passes");

  await card("SS-SIGNFOR001").getByRole("button", { name: "Review & Accept" }).click();
  ok("A1 Review & Accept: Signing for the business, under the name box", (await signingFor(card("SS-SIGNFOR001"))) === "Signing for Bear River Band",
    String(await signingFor(card("SS-SIGNFOR001"))));
  const nameVal = await card("SS-SIGNFOR001").locator(".sign-panel input[type=text]").first().inputValue().catch(() => null);
  ok("A2 the name box is still the person's own name", nameVal === "Thomas Example", String(nameVal));
  await card("SS-SIGNFOR001").screenshot({ path: join(shots, "A-accept-signing-for.png") }).catch(() => {});

  await card("SS-SIGNFOR002").getByRole("button", { name: "Review & Sign Invoice" }).click();
  ok("B1 the invoice signature: the same line", (await signingFor(card("SS-SIGNFOR002"))) === "Signing for Bear River Band",
    String(await signingFor(card("SS-SIGNFOR002"))));

  await card("SS-SIGNFOR003").getByRole("button", { name: "Review & Accept" }).click();
  ok("C1 no company: no Signing for line", (await card("SS-SIGNFOR003").locator(".signing-for").count()) === 0);
  ok("C2 no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed; shots in ${shots}`);
process.exit(f.length ? 1 : 0);
