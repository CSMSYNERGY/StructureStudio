// Moving a builder off GoHighLevel invoicing: the Quotes & Invoices card, driven for real (migration
// 280; Carolyn 2026-09-07, "All other builders will only have the option to invoice through SS").
//
// 280 changes the column default and nothing on this page. Each existing builder moves when the owner,
// or an operator viewing as them, saves Settings → CRM Connection → Quotes & Invoices with the
// builder's own next quote number, next invoice number and tax rate. This drives the COMPILED portal
// with Supabase stubbed at the network layer (no login, nothing leaves the machine) through the tenant
// shapes that move, and asserts what shows, what gets posted and what the page says back:
//
//   A. a grandfathered tenant (CRM mode on its row, no capability, no numbering): no "through my CRM"
//      checkbox, the numbering and tax boxes are in front of them with the "Before saving, set …"
//      banner, and the save posts invoiceInGhl false with exactly what was typed; the success line
//      says StructureStudio issues the paperwork now, and the card re-reads status
//   B. a tenant with NO settings row (status answers as portal-settings does for a missing row): the
//      same card and the same save
//   C. a blank tax rate: the server's own sentence is shown (not a generic failure), and no success
//   D. 0% tax: posted as "0" and saved
//   E. the one tenant WITH the capability: the checkbox is there and on, no numbering is asked for, and
//      the save posts invoiceInGhl true and says the CRM keeps the paperwork
//
// The stub answers `save` with portal-settings' own refusal sentences (the three Quotes & Invoices
// guards, copied from the handler), so a page that only passes against a stub that says something the
// server never says would fail here.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/paperworkMove.mjs            (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is how to
// prove the checks can fire. Against the artifact from just before 217's capability (95e8351b~1, which
// shows every tenant the checkbox, on, with the numbering hidden behind it) A's first four checks fail,
// and the run then stops at A's fill with no numbering box to type into.
//
// Tenants and numbers are made up. The repo is public.
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-move-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

// The SAVED row, as status reports it. `noRow` answers the way status does for a tenant with no
// client_settings row: CRM mode (anything but an explicit false), not allowed, nothing configured.
const S = { invoiceInGhl: true, allowed: false, crm: true, noRow: false, quoteNext: null, invoiceNext: null, taxPct: null };
const saves = [];
let statusReads = 0;

// portal-settings' three Quotes & Invoices refusals, word for word (supabase/functions/portal-settings
// /index.ts, the `save` action's numbering guard).
const NEED_QUOTE = "StructureStudio needs a starting quote number before it can issue your quotes — set one so your numbering continues where your CRM left off.";
const NEED_INVOICE = "StructureStudio needs a starting invoice number too — invoices number separately from quotes, so set where they should begin.";
const NEED_TAX = "StructureStudio needs a sales tax rate before it can issue your invoices — set one so quotes can still be taxed if the delivery address can't be looked up. Enter 0% if you don't collect sales tax.";

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
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
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  if (a === "status") {
    statusReads += 1;
    return json(route, {
      ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null,
      configured: S.crm && !S.noRow, hasApiKey: S.crm && !S.noRow, ghlLocationIdMasked: S.crm && !S.noRow ? "loc-••••1234" : null,
      invoiceInGhl: S.noRow ? true : S.invoiceInGhl, ghlInvoicingAllowed: S.noRow ? false : S.allowed,
      ssQuoteNext: S.quoteNext, ssQuotePrefix: "", ssInvoiceNext: S.invoiceNext, ssInvoicePrefix: "",
      ssTaxRate: S.taxPct, ssTaxLabel: "Sales tax", ssTaxDelivery: false,
      businessAddress: {}, branding: {}, emailReady: false,
    });
  }
  if (a === "save" && "invoiceInGhl" in body) {
    saves.push(body);
    // The server's rule (217): a tenant without the capability can only be written false.
    const nextInGhl = S.allowed && !S.noRow && Boolean(body.invoiceInGhl);
    const blank = (v) => String(v ?? "").trim() === "";
    if (!nextInGhl && blank(body.ssQuoteNext)) return json(route, { error: NEED_QUOTE }, 400);
    if (!nextInGhl && blank(body.ssInvoiceNext)) return json(route, { error: NEED_INVOICE }, 400);
    if (!nextInGhl && blank(body.ssTaxRate)) return json(route, { error: NEED_TAX }, 400);
    Object.assign(S, {
      noRow: false, invoiceInGhl: nextInGhl,
      quoteNext: blank(body.ssQuoteNext) ? null : Number(body.ssQuoteNext),
      invoiceNext: blank(body.ssInvoiceNext) ? null : Number(body.ssInvoiceNext),
      taxPct: blank(body.ssTaxRate) ? null : Number(body.ssTaxRate),
    });
    return json(route, { ok: true });
  }
  if (a === "tax_settings") {
    return json(route, { ok: true, ssMode: !S.invoiceInGhl, lookupEnabled: false, configured: true, companyRatePct: S.taxPct, companyLabel: "Sales tax", dailyCap: 100, usage24h: 0, locations: [] });
  }
  if (a === "list_ghl_pipelines") return json(route, { ok: true, pipelines: [] });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (s, timeout = 20000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const CHECKBOX = "Quote and invoice through my CRM";
const SAVE = "Save Quote & Invoice Settings";
const boot = async (shape) => {
  Object.assign(S, { invoiceInGhl: true, allowed: false, crm: true, noRow: false, quoteNext: null, invoiceNext: null, taxPct: null }, shape);
  saves.length = 0;
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(900);
  await page.getByText("CRM Connection", { exact: true }).last().click();
  await waitText(SAVE);
  await page.waitForTimeout(400);
};
// The card's inputs, found by their placeholders (labels are siblings, not <label for>).
const box = (placeholder) => page.locator(`input[placeholder="${placeholder}"]`).first();
const fill = async ({ quote, invoice, tax }) => {
  if (quote != null) await box("e.g. 1041").fill(quote);
  if (invoice != null) await box("e.g. 2001").fill(invoice);
  if (tax != null) await box("e.g. 7.25").fill(tax);
};
const press = async () => {
  const before = statusReads;
  await page.getByRole("button", { name: SAVE }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Saving…"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  return statusReads - before;
};
const SAVED_SS = "Saved — StructureStudio now issues your quotes and invoices.";
const SAVED_CRM = "Saved — your quotes and invoices are created in your CRM, exactly as before.";

try {
  // A — grandfathered, CRM-connected, no capability, no numbering
  await boot({ invoiceInGhl: true, allowed: false, crm: true });
  let t = await text();
  ok("A: no \"through my CRM\" checkbox for a tenant without the capability", !t.includes(CHECKBOX));
  ok("A: the card says StructureStudio issues the paperwork", t.includes("StructureStudio issues your quotes and invoices."));
  ok("A: the numbering boxes and the tax rate are in front of them", (await box("e.g. 1041").count()) === 1 && (await box("e.g. 2001").count()) === 1 && (await box("e.g. 7.25").count()) === 1);
  ok("A: the banner names all three things still missing", /Before saving, set a starting quote number, a starting invoice number and your sales tax rate \(0 counts\)\./.test(t), (t.match(/Before saving[^\n]*/) || [""])[0]);
  await fill({ quote: "3101", invoice: "7001", tax: "6.5" });
  ok("A: with all three typed, the banner is gone", !(await text()).includes("Before saving, set"));
  let reread = await press();
  ok("A: one save was posted", saves.length === 1, `saves ${saves.length}`);
  const sa = saves[0] || {};
  ok("A: it asks for paperwork mode (invoiceInGhl false)", sa.invoiceInGhl === false, JSON.stringify(sa));
  ok("A: it carries exactly what was typed", sa.ssQuoteNext === "3101" && sa.ssInvoiceNext === "7001" && sa.ssTaxRate === "6.5", JSON.stringify(sa));
  ok("A: and names no CRM field (the connection is left alone)", !Object.keys(sa).some((k) => /^ghl/i.test(k)), Object.keys(sa).join(","));
  ok("A: the page says StructureStudio issues the paperwork now", await waitText(SAVED_SS, 5000));
  ok("A: the card re-reads status after the save", reread >= 1, `status reads ${reread}`);

  // B — no settings row at all
  await boot({ noRow: true, crm: false });
  t = await text();
  ok("B: no-row tenant: no checkbox", !t.includes(CHECKBOX));
  ok("B: no-row tenant: the numbering boxes are there", (await box("e.g. 1041").count()) === 1 && (await box("e.g. 7.25").count()) === 1);
  await fill({ quote: "1", invoice: "1", tax: "7.25" });
  await press();
  const sb = saves[0] || {};
  ok("B: no-row tenant: the save posts paperwork mode with what was typed", sb.invoiceInGhl === false && sb.ssQuoteNext === "1" && sb.ssInvoiceNext === "1" && sb.ssTaxRate === "7.25", JSON.stringify(sb));
  ok("B: no-row tenant: saved", await waitText(SAVED_SS, 5000));

  // C — a blank tax rate: the server's sentence, no success
  await boot({ invoiceInGhl: true, allowed: false, crm: false });
  await fill({ quote: "5001", invoice: "9001" });
  await press();
  ok("C: blank tax: the save was still posted (the server is the guard)", saves.length === 1 && String(saves[0].ssTaxRate ?? "") === "", JSON.stringify(saves[0] || {}));
  ok("C: blank tax: the server's own sentence is shown", await waitText(NEED_TAX, 5000));
  t = await text();
  ok("C: blank tax: no success line, no generic failure text", !t.includes(SAVED_SS) && !/non-2xx/i.test(t));

  // D — 0% is an answer
  await boot({ invoiceInGhl: true, allowed: false, crm: false });
  await fill({ quote: "5001", invoice: "9001", tax: "0" });
  ok("D: 0% satisfies the banner", !(await text()).includes("Before saving, set"));
  await press();
  ok("D: 0% is posted as \"0\" and saved", saves.length === 1 && saves[0].ssTaxRate === "0" && saves[0].invoiceInGhl === false && await waitText(SAVED_SS, 5000), JSON.stringify(saves[0] || {}));

  // E — the tenant with the capability keeps its choice
  await boot({ invoiceInGhl: true, allowed: true, crm: true });
  t = await text();
  ok("E: capable tenant: the checkbox is there", t.includes(CHECKBOX));
  ok("E: capable tenant: it is on", await page.getByRole("checkbox", { name: CHECKBOX }).isChecked());
  ok("E: capable tenant: no numbering asked for", (await box("e.g. 1041").count()) === 0 && !t.includes("Before saving, set"));
  await press();
  ok("E: capable tenant: the save posts invoiceInGhl true", saves.length === 1 && saves[0].invoiceInGhl === true, JSON.stringify(saves[0] || {}));
  ok("E: capable tenant: the page says the CRM keeps the paperwork", await waitText(SAVED_CRM, 5000));

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
