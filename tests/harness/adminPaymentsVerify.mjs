// Operator Admin → Card payments: the Verify button's three answers, and the warning for a builder
// whose customers can't pay because they are billable on the test system (workstream 1 phase 3),
// driven for real.
//
// Drives the COMPILED admin console (admin.app.compiled.js) with admin-catalog stubbed at the network
// layer (no login, nothing leaves the machine) and asserts what the operator is told:
//
//   A. verify_payments answers the gateway's "not found" (expected): GREEN, "Reachable.", the
//      gateway's own words, and that this does not prove the id is the right builder's
//   B. it answers anything else in a 200 (reachable, NOT expected): AMBER, never green, with the
//      gateway's own words and what a check should get
//   C. no usable answer (a config error): RED, "Not reachable." and the reason
//   D. the server's 10-second limit (429): RED, "Couldn't verify:" and the server's sentence
//   E. a builder switched on in TEST while billable (a row changed by hand): the panel says their
//      customers can't pay right now; the same builder non-billable, or on live, says nothing
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/adminPaymentsVerify.mjs     (exit 0 = every check held)
//
// SS_ADMIN_ARTIFACT=<path to an older admin.app.compiled.js> serves that file instead, which is how to
// prove the checks can fire: against the console committed before the amber state, B fails (it shows
// green for any answer) and E fails (no warning).
//
// The password typed here is a placeholder: every admin-catalog call is answered by this script.
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-builder";
const MID = "100200300400";
// Mutable per scenario.
const S = { payments: null, verify: null };
const calls = [];
const pageErrors = [];

const PAY = (over = {}) => ({
  ok: true, clientId: CLIENT, paymentsEnabled: true, merchid: MID, env: "uat", envColumn: true, billingExempt: true,
  configured: { uat: true, prod: false }, ...over,
});
const VERIFY_BASE = { ok: true, clientId: CLIENT, paymentsEnabled: true, env: "uat", midLast4: "0400" };

const { ok, failed, results } = reporter();
const { browser } = await launch({ width: 1400, height: 1000 });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(e.message));

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
// Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
const handler = async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/")) return json(route, null);
  if (!url.includes("/admin-catalog")) return json(route, { ok: true });
  const a = body.action;
  calls.push(a);
  if (a === "list_clients") return json(route, { clients: [{ client_id: CLIENT, company_name: "Harness Builder", billingExempt: true }], features: [] });
  if (a === "get_master") return json(route, { layoutItemTypes: [] });
  if (a === "get_client_catalog") return json(route, { clientLayoutItems: [], buildingStyles: [], buildingSizes: [], inclusions: [] });
  if (a === "get_email_sender") return json(route, { configured: false });
  if (a === "get_payments") return json(route, S.payments);
  if (a === "verify_payments") return json(route, S.verify.body, S.verify.status ?? 200);
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_ADMIN_ARTIFACT) {
  const src = readFileSync(process.env.SS_ADMIN_ARTIFACT, "utf8");
  await page.route(/admin\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const panelText = () => page.locator("body").innerText();
const verifyBox = () => page.locator("[data-pay-verify]");
const verifyText = async () => {
  const box = verifyBox();
  if (await box.count()) return box.innerText();
  // An older console has no data attribute: read the line under the Verify button by its words.
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].reverse().find((d) => /^(Reachable\.|Not reachable\.|Couldn't verify:|Answered, but)/.test(d.innerText || ""));
    return el ? el.innerText : "";
  });
};
const toneOf = async () => {
  if (await verifyBox().count()) return verifyBox().getAttribute("data-pay-verify");
  // Older console: infer the tone from its background colour.
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].reverse().find((d) => /^(Reachable\.|Not reachable\.|Couldn't verify:)/.test(d.innerText || ""));
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    return bg === "rgb(240, 253, 244)" ? "ok" : bg === "rgb(254, 242, 242)" ? "bad" : bg;
  });
};

const open = async (payments) => {
  S.payments = payments;
  await page.goto(`${BASE}/admin.html`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("ADMIN_PASSWORD").fill("harness-placeholder");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.locator("select").first().waitFor({ timeout: 20000 });
  await page.locator("select").first().selectOption(CLIENT);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Card payments" }).click();
  return page.getByText("Right now:").waitFor({ timeout: 10000 }).then(() => true, () => false);
};
const verify = async (answer) => {
  S.verify = answer;
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForFunction(() => !/Verifying…/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
  return { tone: await toneOf(), text: await verifyText() };
};

try {
  ok("the Card payments panel opens", await open(PAY()));

  // ── A ──
  const a = await verify({ body: { ...VERIFY_BASE, reachable: true, expected: true, gateway: { respstat: "C", respcode: "29", resptext: "Txn not found" } } });
  ok("A: the not-found answer is GREEN", a.tone === "ok", `${a.tone} | ${a.text}`);
  ok("A: …says Reachable, with the gateway's own words", /^Reachable\./.test(a.text) && /“Txn not found” \(29\)/.test(a.text), a.text);
  ok("A: …and that it doesn't prove the id is the right builder's", /does not prove the id is the right builder's/.test(a.text), a.text);
  ok("A: the last four only", /ending 0400/.test(a.text) && !(await panelText()).includes(`ending ${MID}`), a.text);

  // ── B ──
  const b = await verify({ body: { ...VERIFY_BASE, reachable: true, expected: false, gateway: { respstat: "C", respcode: "8", resptext: "Invalid merchant" } } });
  ok("B: any other 200 is AMBER, never green", b.tone === "warn", `${b.tone} | ${b.text}`);
  ok("B: …says it answered but not as expected, with the gateway's words", /^Answered, but not as expected\./.test(b.text) && /“Invalid merchant” \(8\)/.test(b.text), b.text);
  ok("B: …and what a check should get", /“Txn not found” \(29\)/.test(b.text), b.text);
  const b2 = await verify({ body: { ...VERIFY_BASE, reachable: true, expected: false, gateway: {} } });
  ok("B: an answer with no words is amber too, and says so", b2.tone === "warn" && /It gave no message\./.test(b2.text), `${b2.tone} | ${b2.text}`);

  // ── C ──
  const c = await verify({ body: { ...VERIFY_BASE, reachable: false, configError: "The gateway refused our request: HTTP 401 — check the API credentials" } });
  ok("C: no usable answer is RED", c.tone === "bad", `${c.tone} | ${c.text}`);
  ok("C: …Not reachable, and the reason", /^Not reachable\./.test(c.text) && /HTTP 401/.test(c.text), c.text);

  // ── D ──
  const d = await verify({ status: 429, body: { error: "This builder's account was checked a few seconds ago. Wait 10 seconds and try again.", retryAfterSeconds: 10 } });
  ok("D: the 10-second limit is RED", d.tone === "bad", `${d.tone} | ${d.text}`);
  ok("D: …with the server's sentence", /^Couldn't verify:/.test(d.text) && /checked a few seconds ago/.test(d.text), d.text);
  ok("verify_payments posted once per click", calls.filter((x) => x === "verify_payments").length === 5, JSON.stringify(calls));

  // ── E ──
  const WARN = "Their customers can't pay right now:";
  ok("E: a non-billable builder in test: no warning", !(await panelText()).includes(WARN));
  await open(PAY({ billingExempt: false }));
  ok("E: a BILLABLE builder switched on in test: the warning", (await panelText()).includes(WARN), (await panelText()).slice(0, 400));
  ok("E: …which says what to do", /Switch them to Live, or switch payments off\./.test(await panelText()));
  await open(PAY({ billingExempt: false, env: "prod" }));
  ok("E: the same builder on live: no warning", !(await panelText()).includes(WARN));
  await open(PAY({ billingExempt: false, paymentsEnabled: false }));
  ok("E: the same builder switched off: no warning", !(await panelText()).includes(WARN));

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
