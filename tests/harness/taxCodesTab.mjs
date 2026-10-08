// Settings → Company → Tax: the tax code mapping a builder saves, driven for real (2026-09-17).
//
// Drives the COMPILED portal with Supabase stubbed at the network layer (no login, nothing leaves
// the machine, no call reaches Avalara) and asserts what shows, what gets called, and with which
// body:
//
//   A. the Tax tab shows for an owner, and an empty tenant starts on three suggested rows —
//      Products, Services, Delivery — ticked, with NO code, marked "Pick a code", nothing to save
//   B. picking a code in the type-ahead and saving posts exactly the Products row (the codeless
//      rows are not sent); typing is debounced; the answer rebuilds the rows and keeps the
//      still-codeless ones; Enter picks only from the answer to what is in the box — pressed while
//      that search is still out it picks nothing, and once the answer lands it picks the top match
//   C. a target ticked in a second row says which code it is under, moves out of the first row,
//      and the save posts it under the new code only
//   D. a settings_crm READER (no Branding, no Team) reaches Company → Tax through the widened hub
//      gate and sees the stored mapping with no Save, no Add, no picker and no checklist
//   E. without settings_crm the Tax tab is absent and tax_codes_get is never called
//   F. a refusal shows the server's sentence: a stored code Avalara stopped listing is flagged on
//      its row, and the save that still carries it is refused with unknown_code's own words
//   G. a portal-settings older than this page (403 "Unrecognised action") reads "not available
//      yet", not a refusal
//   H. the operator's Admin → Master Catalog row: the catalog count and last sync, a Sync button
//      that asks first (dismissing calls nothing), a complete sync's counts, a partial sync shown as
//      the warning it is, and a refused sync's sentence
//
// "Your sales tax rate" and the "Use tax codes" switch (2026-10-09, migration 290). A to H run
// against a tax_codes_get WITHOUT the new fields, which is a portal-settings older than this page:
// A checks the block and the switch are absent there and the editor is today's.
//   I. paperwork mode: the block sits above the codes card with the paperwork copy, the stored rate
//      in the boxes, nothing to save, and the switch on with the editor open
//   J. the save posts ONLY what changed (rate and delivery, not the untouched label), says what is
//      stored, and has nothing left to save
//   K. a blank rate in paperwork mode: the server's own sentence, nothing claims it saved; a
//      paperwork-mode builder with no rate on file sees the amber warning
//   L. CRM mode with a CRM connected: "Your CRM works out the tax on your estimates…"
//   M. CRM mode with NO CRM: the paperwork sentence and a link that opens CRM Connection in the same
//      document, keeping ?view=
//   N. switching codes off posts the switch alone, folds the editor to one line and keeps every
//      code; a reload stays folded; switching back on brings the saved rows back
//   O. a refused switch flips back and shows the server's sentence (a builder with no settings row,
//      told to save the rate first)
//   P. a settings_crm READER sees the stored rate as text, who can change it, no Save, and a
//      switch they cannot flip; in CRM mode with no CRM they are not told to save a rate or make
//      the switch themselves
//   Q. a database without 290 (taxCodesEnabled null): the block shows, the switch does not, and the
//      editor is today's
//
// The stub answers tax_codes_get / _search / _save with the SERVER'S OWN pure module
// (supabase/functions/_shared/taxCodes.ts, imported directly — Node strips the types): its
// headings, groups, starter codes and hints, payload parsing, and the refusal sentences
// portal-settings writes. H's sync sentences come from _shared/taxCodeSync.ts the same way, and
// save_company_tax's parsing, refusals and answer from _shared/companyTax.ts. A stub that said
// something the server never says would pass a check the real page fails.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/taxCodesTab.mjs              (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead, which is
// how to prove the checks can fire. Against the artifact committed before the Tax tab (19c95c6) A
// fails and the run stops there, with no card to drive. Against artifacts compiled from single
// mutations of this build: the hub gate without settings_crm fails D's rail check and the four D
// checks after it; a save that also sends codeless rows fails B's payload and success checks; a
// tick that does not take the target out of its old row fails C's move and payload checks. The
// picker as it was at 8907d3d, which kept the last answer pickable while a new search was out,
// fails B's three Enter checks: Enter there puts the empty box's P0000000 on the row. Against the
// artifact committed just before the company rate block (2c203e02's portal.app.compiled.js) A to H
// all pass, I's first two checks fail, and the run stops there with no block to drive. Against
// 3c4cffdc's artifact, which told a reader to save a rate and make the switch, everything passes
// but P's two no-CRM reader checks.
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF } from "./lib.mjs";
import {
  COMMON_CODES, TAX_HEADING_GROUPS, headingsView, mergeCodeLists, orderCodes, parseAssignmentsPayload, taxCodeView, visibleAssignments,
} from "../../supabase/functions/_shared/taxCodes.ts";
import { partialSyncText, syncFailureText } from "../../supabase/functions/_shared/taxCodeSync.ts";
import {
  companyTaxRefusal, companyTaxView, parseCodesSwitch, parseCompanyTax, RATE_FIRST, RATE_REQUIRED,
} from "../../supabase/functions/_shared/companyTax.ts";

const CLIENT = "harness-tax-codes";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const UTILITY = "11111111-1111-4111-8111-111111111111";
const LOFTED = "22222222-2222-4222-8222-222222222222";
const STUDIO = "33333333-3333-4333-8333-333333333333";
const STYLES = [
  { id: UTILITY, label: "Utility", active: true },
  { id: LOFTED, label: "Lofted Barn", active: true },
  { id: STUDIO, label: "Studio", active: false },
];
const HEADINGS = headingsView();
const heading = (key) => ({ type: "heading", key });
const style = (key) => ({ type: "style", key });

// Migration 246's twelve seeds, word for word, plus two synced codes: one only a search finds, and
// one that is not applicable to North America (the search must leave it out).
const SEED = {
  P0000000: "Tangible personal property (tpp)",
  NT: "Non-taxable product",
  ON030000: "Non-taxable transaction",
  SI020100: "Installation-associated with the sale of tpp (equipment/parts and labor) - separately stated",
  SI020200: "Installation-not associated with the sale of tpp (labor only)",
  SC150100: "Construction services relating to real property (original construction)",
  FR010000: "Delivery by company vehicle",
  FR010100: "Delivery by company vehicle before passage of title",
  FR010200: "Delivery by company vehicle after passage of title",
  FR020100: "Shipping / common carrier / fob destination",
  FR030000: "Shipping / shipping and handling combined",
  OH010000: "Handling only charges (separately identified from shipping)",
};
const baseCatalog = () => [
  ...Object.entries(SEED).map(([code, description]) => ({ code, description, type_id: null, is_active: true, north_america: true })),
  { code: "PH101300", description: "Doors, garage doors, and windows labeled impact-resistant or has impact-resistant rating", type_id: "P", is_active: true, north_america: true },
  { code: "PF050100", description: "Food and beverage - not applicable to north america", type_id: "P", is_active: true, north_america: false },
];

// Mutable per scenario.
const S = { role: "owner", access: null, ssMode: true, lookupEnabled: false, stored: [], catalog: baseCatalog(), old: false, searchDelayMs: 0,
  operator: false, adminStatus: null, syncReplies: [], company: null };
// S.company is the company rate half of client_settings, or null for a portal-settings older than
// this page (its tax_codes_get has none of the fields): { rate (a FRACTION, as stored), label,
// delivery, crm (a CRM is connected), allowed (ghl_invoicing_allowed), codes (tax_codes_enabled:
// true/false, null on a database without 290), noRow (the builder has no settings row) }.
const company = (over = {}) => ({ rate: 0.065, label: "Sales tax", delivery: false, crm: false, allowed: false, codes: true, noRow: false, ...over });
const calls = [];   // { action, body } for every portal-settings and admin-catalog call
const pageErrors = [];
const dialogs = [];         // every confirm the page raised
let dialogAnswers = [];     // true = accept, false = dismiss; empty = accept

const { ok, failed, results } = reporter();
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", async (dlg) => {
  const answer = dialogAnswers.length ? dialogAnswers.shift() : true;
  dialogs.push(dlg.message());
  if (answer) await dlg.accept(); else await dlg.dismiss();
});

// taxCodesResponse in portal-settings, over the stub's tables.
const getAnswer = () => {
  const styleIds = new Set(STYLES.map((s) => s.id));
  const assignments = visibleAssignments(S.stored, styleIds);
  const wanted = new Set([...COMMON_CODES.map((c) => c.code), ...assignments.map((a) => a.code)]);
  const c = S.company;
  return {
    ok: true, ssMode: S.ssMode, lookupEnabled: S.lookupEnabled,
    // The 2026-10-09 fields, read the way portal-settings reads them (companyTaxView).
    ...(c ? {
      ...companyTaxView(c.noRow ? null : { ss_tax_rate: c.rate, ss_tax_label: c.label, ss_tax_delivery: c.delivery }),
      ghlInvoicingAllowed: c.allowed, crmConfigured: c.crm, taxCodesEnabled: c.noRow ? false : c.codes,
    } : {}),
    headings: HEADINGS, headingGroups: TAX_HEADING_GROUPS, styles: STYLES, assignments,
    codes: orderCodes(S.catalog.filter((c) => wanted.has(c.code)).map(taxCodeView)),
    catalog: { count: S.catalog.length, syncedAt: "2026-09-17T12:00:00Z" },
  };
};
// save_company_tax, in the server's order with the server's sentences: parse, the switch, the
// refusals (companyTaxRefusal), then only the sent keys. A builder with no row gets one, in
// paperwork mode (migration 280's default). It never touches the codes (S.stored).
const companyAnswer = (body) => {
  const c = S.company;
  const parsed = parseCompanyTax(body);
  if (!parsed.ok) return [{ error: parsed.error, reason: "bad_rate" }, 400];
  const sw = parseCodesSwitch(body);
  if (!sw.ok) return [{ error: sw.error, reason: sw.reason }, sw.status];
  const updates = { ...parsed.updates };
  if (sw.value !== undefined) updates.tax_codes_enabled = sw.value;
  const refusal = companyTaxRefusal(updates, c.noRow ? null : { invoice_in_ghl: !S.ssMode });
  if (refusal) return [{ error: refusal.error, reason: refusal.reason }, refusal.status];
  if (c.noRow) {
    Object.assign(c, { noRow: false, rate: null, label: "Sales tax", delivery: false, codes: false });
    S.ssMode = true;
  }
  if ("ss_tax_rate" in updates) c.rate = updates.ss_tax_rate;
  if ("ss_tax_label" in updates) c.label = updates.ss_tax_label;
  if ("ss_tax_delivery" in updates) c.delivery = updates.ss_tax_delivery;
  if ("tax_codes_enabled" in updates) c.codes = updates.tax_codes_enabled;
  return [{
    ok: true, ssMode: S.ssMode, ...companyTaxView({ ss_tax_rate: c.rate, ss_tax_label: c.label, ss_tax_delivery: c.delivery }),
    ...("tax_codes_enabled" in updates ? { taxCodesEnabled: c.codes } : {}),
  }, 200];
};
// tax_codes_search: active, North America, code prefix first then description; an empty box leads
// with the common codes.
const searchAnswer = (q) => {
  const text = String(q || "").trim().toUpperCase();
  const active = S.catalog.filter((c) => c.is_active && c.north_america);
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const codes = text
    ? mergeCodeLists(
      active.filter((c) => c.code.startsWith(text)).sort(byCode).map(taxCodeView),
      active.filter((c) => c.description.toUpperCase().includes(text)).sort(byCode).map(taxCodeView),
    )
    : mergeCodeLists(orderCodes(active.filter((c) => COMMON_CODES.some((x) => x.code === c.code)).map(taxCodeView)), active.sort(byCode).map(taxCodeView));
  return { ok: true, codes };
};
// tax_codes_save: parse, then codes — the server's order and its sentences. (Every style here is this
// tenant's, so the style check has nothing to refuse.)
const saveAnswer = (body) => {
  const parsed = parseAssignmentsPayload(body);
  if (!parsed.ok) return [{ error: parsed.error, reason: parsed.reason }, parsed.status];
  for (const code of [...new Set(parsed.rows.map((r) => r.code))]) {
    const row = S.catalog.find((c) => c.code === code);
    if (row && row.is_active) continue;
    return [{
      error: row
        ? `Tax code ${code} is no longer active in Avalara's list — pick another code for that row.`
        : `Tax code ${code} isn't in the Avalara tax code list — pick a code from the list.`,
      reason: "unknown_code",
    }, 400];
  }
  S.stored = parsed.rows.flatMap((r) => r.targets.map((t) => ({ target_type: t.type, target_key: t.key, tax_code: r.code })));
  return [getAnswer(), 200];
};

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
  if (url.includes("/rest/v1/rpc/is_operator")) return json(route, S.operator);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: S.role }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/portal-billing")) {
    return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  }
  if (url.includes("/admin-catalog")) {
    calls.push({ action: body.action, body });
    if (body.action === "list_clients") return json(route, { ok: true, clients: [], features: [] });
    if (body.action === "get_master") return json(route, { ok: true, layoutItemTypes: [] });
    if (body.action === "avalara_tax_codes_status") return json(route, { ok: true, ...S.adminStatus });
    if (body.action === "avalara_sync_tax_codes") {
      const r = S.syncReplies.shift() || { status: 500, body: { error: "unexpected avalara_sync_tax_codes call" } };
      if (r.after) r.after();
      return json(route, r.body, r.status || 200);
    }
    return json(route, { ok: true });
  }
  if (!url.includes("/portal-settings")) return json(route, { ok: true });
  const a = body.action;
  calls.push({ action: a, body });
  if (a === "status") {
    const c = S.company;
    return json(route, {
      ok: true, clientId: CLIENT, role: S.role, access: S.access, prefs: null, configured: !!(c && c.crm),
      invoiceInGhl: !S.ssMode, ghlInvoicingAllowed: !!(c && c.allowed), ssQuoteNext: 1041, ssInvoiceNext: 2001,
      ssTaxRate: c ? (c.rate == null ? null : Math.round(c.rate * 1000000) / 10000) : 6.5, ssTaxLabel: c ? c.label : "Sales tax",
      ssTaxDelivery: !!(c && c.delivery), businessAddress: {}, branding: {}, emailReady: true,
    });
  }
  if (a && a.startsWith("tax_codes_") && S.old) return json(route, { error: `Unrecognised action "${a}".` }, 403);
  if (a === "tax_codes_get") return json(route, getAnswer());
  if (a === "tax_codes_search") {
    if (S.searchDelayMs) await new Promise((r) => setTimeout(r, S.searchDelayMs));
    return json(route, searchAnswer(body.q));
  }
  if (a === "tax_codes_save") {
    const [reply, status] = saveAnswer(body);
    return json(route, reply, status);
  }
  if (a === "save_company_tax") {
    if (!S.company) return json(route, { error: `Unrecognised action "${a}".` }, 403);
    const [reply, status] = companyAnswer(body);
    return json(route, reply, status);
  }
  if (a === "list_locations") return json(route, { ok: true, nextSerial: 100, locations: [] });
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
if (process.env.SS_PORTAL_ARTIFACT) {
  const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
  await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
}

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (s, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const callsOf = (action) => calls.filter((c) => c.action === action);
const tabButton = () => page.getByRole("button", { name: "Tax", exact: true });
const row = (i) => page.locator(`[data-tax-row="${i}"]`);
const boot = async (shape) => {
  Object.assign(S, { role: "owner", access: null, ssMode: true, lookupEnabled: false, stored: [], catalog: baseCatalog(), old: false, searchDelayMs: 0,
    operator: false, adminStatus: null, syncReplies: [], company: null }, shape);
  calls.length = 0;
  await page.goto(`${BASE}/portal.html${shape.query || ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(700);
  // Whether the Settings rail offers Company at all: for a settings_crm-only reader that is the
  // widened hub gate, and a missing item is a finding, not a harness crash.
  const company = page.getByText("Company", { exact: true });
  if (!(await company.last().waitFor({ timeout: 8000 }).then(() => true, () => false))) return false;
  await company.last().click();
  await page.waitForTimeout(700);
  return true;
};
const openTax = async () => {
  if (await tabButton().count()) await tabButton().click();
  return waitText("Every building, option and service you sell falls under a tax code");
};
// A row's checkbox, by its label's leading text.
const checkbox = (r, label) => r.locator("label").filter({ hasText: new RegExp(`^${label}`) }).locator('input[type="checkbox"]');
const lastSave = () => { const s = callsOf("tax_codes_save"); return s.length ? s[s.length - 1].body : null; };
const allHeadings = (groups) => HEADINGS.filter((h) => groups.includes(h.group)).map((h) => heading(h.key));

try {
  // ── A ──
  await boot({});
  ok("A: owner sees the Tax tab in Company", (await tabButton().count()) === 1);
  ok("A: the card opens", await openTax());
  await page.waitForTimeout(400);
  const titles = await page.locator("[data-tax-row]").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  ok("A: three suggested rows: Products, Services, Delivery", JSON.stringify(titles) === JSON.stringify(["PRODUCTS", "SERVICES", "DELIVERY"]), JSON.stringify(titles));
  ok("A: every suggested row is marked Pick a code", (await page.locator("[data-tax-row]").filter({ hasText: "Pick a code" }).count()) === 3);
  ok("A: no suggested row has a code chosen (each shows the search box)", (await page.locator('[data-tax-row] input[aria-label="Search tax codes"]').count()) === 3);
  const productsText = await row(0).innerText();
  ok("A: Products covers all buildings and the product groups", /All buildings \(3\)/.test(productsText) && /Exterior \(all 5\)/.test(productsText) && /Interior \(all 3\)/.test(productsText), productsText.replace(/\n/g, " | "));
  ok("A: Services covers the services group", /Services \(all 3\)/.test(await row(1).innerText()));
  ok("A: nothing to save yet, and it says so", await page.getByRole("button", { name: "Save tax codes" }).isDisabled() && (await text()).includes("No changes to save"));
  const unassignedA = await page.locator("[data-tax-unassigned]").innerText();
  ok("A: Not assigned lists everything while no row has a code", ["Utility", "Studio", "Doors", "Delivery", "Change order fee"].every((x) => unassignedA.includes(x)), unassignedA.replace(/\n/g, " | "));
  ok("A: the note says the codes do not change today's tax", (await page.locator("[data-tax-note]").innerText()).includes("Until then they don't change the tax on any estimate"));
  ok("A: the note is the amber warning while lookups are off", /255, 251, 235/.test(await page.locator("[data-tax-note]").evaluate((el) => getComputedStyle(el).backgroundColor)));
  ok("A: an answer without companyRatePct (an older function) shows no rate block", (await page.locator("[data-company-tax]").count()) === 0);
  ok("A: …and no codes switch, with today's editor", (await page.locator("[data-tax-codes-switch]").count()) === 0 && (await page.locator("[data-tax-codes-off]").count()) === 0);

  // ── B ──
  const search = row(0).locator('input[aria-label="Search tax codes"]');
  await search.click();
  ok("B: an empty box lists the common codes first, with their hints", await waitText("COMMON CODES") && await waitText("General goods — the usual choice for a building sold as a finished product"));
  const firstOption = await page.locator('[role="option"]').first().innerText();
  ok("B: P0000000 leads the empty-box list", firstOption.startsWith("P0000000 — Tangible personal property (tpp)"), firstOption.replace(/\n/g, " | "));
  const searchesBefore = callsOf("tax_codes_search").length;
  await search.pressSequentially("P00", { delay: 60 });
  await page.waitForTimeout(900);
  const typed = callsOf("tax_codes_search").slice(searchesBefore);
  ok("B: typing is debounced into one search", typed.length === 1 && typed[0].body.q === "P00", JSON.stringify(typed.map((c) => c.body.q)));
  await page.locator('[role="option"]').filter({ hasText: "P0000000" }).first().click();
  await page.waitForTimeout(300);
  ok("B: the row shows the chosen code", (await row(0).innerText()).includes("P0000000 — Tangible personal property (tpp)"));
  ok("B: Products is no longer marked Pick a code", !(await row(0).innerText()).includes("Pick a code"));
  ok("B: Save is enabled with unsaved changes", !(await page.getByRole("button", { name: "Save tax codes" }).isDisabled()) && (await text()).includes("Unsaved changes"));
  await page.getByRole("button", { name: "Save tax codes" }).click();
  await waitText("Tax codes saved");
  const expectedB = { rows: [{ code: "P0000000", targets: [style(UTILITY), style(LOFTED), style(STUDIO), ...allHeadings(["building", "exterior", "interior", "other"])] }] };
  const bodyB = lastSave();
  ok("B: the save posts only the Products row, with every target it covers", bodyB && JSON.stringify({ rows: bodyB.rows }) === JSON.stringify(expectedB), JSON.stringify(bodyB && bodyB.rows));
  ok("B: the success sentence counts what now has a code", (await text()).includes("Tax codes saved — 14 of your 18 building styles and option headings have a code."));
  const titlesB = await page.locator("[data-tax-row]").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  ok("B: the rebuilt rows keep Products' title and the two codeless rows", JSON.stringify(titlesB) === JSON.stringify(["PRODUCTS", "SERVICES", "DELIVERY"]), JSON.stringify(titlesB));
  const unassignedB = await page.locator("[data-tax-unassigned]").innerText();
  ok("B: Not assigned is now the services and delivery headings only", !unassignedB.includes("Utility") && unassignedB.includes("Foundation & site work") && unassignedB.includes("Delivery"), unassignedB.replace(/\n/g, " | "));
  // The empty box answers at once with P0000000 highlighted. Typing a code and pressing Enter
  // before that code's answer lands must not pick P0000000. The stub holds the search back so the
  // window is wider than the keystrokes, whatever the machine's speed.
  const services = row(1).locator('input[aria-label="Search tax codes"]');
  await services.click();
  await waitText("COMMON CODES");
  S.searchDelayMs = 1500;
  await services.pressSequentially("SI020200");
  await services.press("Enter");
  await page.waitForTimeout(200);
  const servicesStale = await row(1).innerText();
  ok("B: Enter while the search is still out picks nothing", servicesStale.includes("Pick a code") && (await row(1).locator('input[aria-label="Search tax codes"]').count()) === 1, servicesStale.replace(/\n/g, " | "));
  ok("B: …and the list says Searching… instead of offering the last answer", (await page.locator('[role="option"]').count()) === 0 && (await row(1).innerText()).includes("Searching…"));
  // A stale pick has already closed the box; checking the row is enough then, and the run goes on.
  if (await services.count()) {
    await page.locator('[role="option"]').filter({ hasText: "SI020200" }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await services.press("Enter");
    await page.waitForTimeout(300);
  }
  ok("B: once the answer lands, Enter picks its top match", (await row(1).innerText()).includes("SI020200 — Installation-not associated with the sale of tpp (labor only)"));
  S.searchDelayMs = 0;

  // ── C ──
  await boot({
    lookupEnabled: true,
    stored: [
      { target_type: "style", target_key: UTILITY, tax_code: "P0000000" },
      { target_type: "style", target_key: LOFTED, tax_code: "P0000000" },
      { target_type: "heading", target_key: "doors", tax_code: "P0000000" },
      { target_type: "heading", target_key: "windows", tax_code: "P0000000" },
      { target_type: "heading", target_key: "delivery", tax_code: "FR010000" },
    ],
  });
  await openTax();
  await page.waitForTimeout(400);
  ok("C: stored codes come back as two rows, common-code order", (await row(0).innerText()).includes("P0000000") && (await row(1).innerText()).includes("FR010000"));
  ok("C: the note is the plain note when SS mode and lookups are on", !/255, 251, 235/.test(await page.locator("[data-tax-note]").evaluate((el) => getComputedStyle(el).backgroundColor)));
  await row(1).getByRole("button", { name: "Change what it covers" }).click();
  const doorsRow = row(1).locator("label").filter({ hasText: /^Doors/ });
  const doorsLabel = await doorsRow.innerText();
  ok("C: Doors in the delivery row names the code it is under", doorsLabel.includes("under P0000000"), doorsLabel);
  // Carolyn 2026-09-17 asked for taken items to grey out. DIMMED, NOT DISABLED: ticking one is
  // the only one-click way to move it, and the move is asserted three lines below.
  const doorsColor = await doorsRow.evaluate((el) => getComputedStyle(el).color);
  ok("C: a taken item is greyed", /148, 163, 184/.test(doorsColor), doorsColor);
  const doorsTitle = await doorsRow.getAttribute("title");
  ok("C: …and its title says it moves rather than refuses", doorsTitle === "Currently under P0000000. Ticking this moves it here.", String(doorsTitle));
  const freeColor = await row(1).locator("label").filter({ hasText: /^Foundation/ }).evaluate((el) => getComputedStyle(el).color);
  ok("C: an item nothing else covers is NOT greyed", !/148, 163, 184/.test(freeColor), freeColor);
  ok("C: the greyed checkbox is still enabled", await checkbox(row(1), "Doors").isEnabled());
  await checkbox(row(1), "Doors").check();
  await page.waitForTimeout(200);
  ok("C: Doors left the P0000000 row", !(await row(0).innerText()).includes("Doors"));
  ok("C: Doors is now covered by the FR010000 row", (await row(1).innerText()).includes("Doors"));
  await page.getByRole("button", { name: "Save tax codes" }).click();
  await waitText("Tax codes saved");
  const bodyC = lastSave();
  const expectedC = { rows: [
    { code: "P0000000", targets: [style(UTILITY), style(LOFTED), heading("windows")] },
    { code: "FR010000", targets: [heading("doors"), heading("delivery")] },
  ] };
  ok("C: the save posts Doors under FR010000 only", bodyC && JSON.stringify({ rows: bodyC.rows }) === JSON.stringify(expectedC), JSON.stringify(bodyC && bodyC.rows));

  // ── C2: an item with a saved code moved into a row with NO code must not be deleted silently.
  // The save replaces the whole set and leaves codeless rows out, so it is refused instead.
  await boot({
    lookupEnabled: true,
    stored: [
      { target_type: "style", target_key: UTILITY, tax_code: "P0000000" },
      { target_type: "heading", target_key: "doors", tax_code: "P0000000" },
    ],
  });
  await openTax();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "+ Add tax code" }).click();
  await page.waitForTimeout(200);
  const savesBeforeC2 = callsOf("tax_codes_save").length;
  await checkbox(row(1), "Doors").check();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Save tax codes" }).click();
  ok("C2: a coded item moved into a codeless row refuses the save", await waitText("Some items that already have a tax code are now in a row with no code"));
  ok("C2: …and nothing is posted", callsOf("tax_codes_save").length === savesBeforeC2);

  // ── D ──
  ok("D: a settings_crm-only reader has Company in the Settings rail", await boot({
    role: "user", access: { settings_crm: "view" },
    stored: [
      { target_type: "style", target_key: UTILITY, tax_code: "P0000000" },
      { target_type: "heading", target_key: "delivery", tax_code: "FR010000" },
    ],
  }));
  ok("D: a settings_crm reader reaches Company → Tax", await openTax());
  await page.waitForTimeout(500);
  const tD = await text();
  ok("D: the reader sees the stored mapping", tD.includes("P0000000 — Tangible personal property (tpp)") && tD.includes("FR010000 — Delivery by company vehicle"));
  ok("D: no Save button", (await page.getByRole("button", { name: "Save tax codes" }).count()) === 0);
  ok("D: no Add, no picker, no checklist", (await page.getByRole("button", { name: "+ Add tax code" }).count()) === 0
    && (await page.locator('input[aria-label="Search tax codes"]').count()) === 0
    && (await page.getByRole("button", { name: "Change what it covers" }).count()) === 0);
  ok("D: the reader is told who can change the codes", tD.includes("Only someone who can edit CRM Connection settings can change these codes."));
  // Scoped to the rows: the explainer above them says "Pick a code, then tick…" to everyone.
  const rowsD = await page.locator("[data-tax-row]").evaluateAll((els) => els.map((e) => e.innerText).join("\n"));
  ok("D: no suggested rows are shown to a reader", (await page.locator("[data-tax-row]").count()) === 2 && !/Pick a code|PRODUCTS|SERVICES/.test(rowsD), rowsD.replace(/\n/g, " | "));

  // ── E ──
  await boot({ role: "user", access: { settings_team: "view", settings_crm: "none" } });
  await waitText("Locations", 8000);
  ok("E: without settings_crm the Company tabs render (Team, Locations)", (await page.getByRole("button", { name: "Locations", exact: true }).count()) === 1);
  ok("E: …and there is no Tax tab", (await tabButton().count()) === 0);
  ok("E: tax_codes_get is never called", callsOf("tax_codes_get").length === 0);

  // ── F ──
  await boot({
    stored: [
      { target_type: "heading", target_key: "doors", tax_code: "P0000000" },
      { target_type: "heading", target_key: "delivery", tax_code: "OH010000" },
    ],
    catalog: baseCatalog().map((c) => (c.code === "OH010000" ? { ...c, is_active: false } : c)),
  });
  await openTax();
  await page.waitForTimeout(400);
  ok("F: a stored code Avalara stopped listing is flagged on its row", (await row(1).innerText()).includes("Avalara no longer lists OH010000 as active"));
  await row(0).getByRole("button", { name: "Change what it covers" }).click();
  await checkbox(row(0), "Windows").check();
  await page.getByRole("button", { name: "Save tax codes" }).click();
  const refusal = "Tax code OH010000 is no longer active in Avalara's list — pick another code for that row.";
  ok("F: the refusal shows the server's sentence", await waitText(refusal));
  ok("F: the edit is kept (Windows still in the P0000000 row), nothing claims it saved", (await row(0).innerText()).includes("Windows") && !(await text()).includes("Tax codes saved"));

  // ── G ──
  await boot({ old: true });
  await openTax();
  ok("G: an older function reads as not available yet", await waitText("Tax codes aren't available on your account yet"));
  ok("G: …with no refusal sentence on screen", !/Unrecognised action/.test(await text()));

  // ── H ──
  await boot({ operator: true, adminStatus: { count: 12, activeCount: 12, syncedAt: null } });
  await page.getByText("Admin", { exact: true }).last().click();
  await page.getByRole("button", { name: "Master Catalog", exact: true }).click();
  ok("H: the operator row shows the stored catalog", await waitText("12 codes (12 active) · never synced, so builders can pick only the starter codes"));
  const syncBtn = page.getByRole("button", { name: "Sync from Avalara" });
  dialogAnswers = [false];
  await syncBtn.click();
  await page.waitForTimeout(600);
  ok("H: Sync asks first, naming the Avalara requests", dialogs.length > 0 && /up to 10 requests to Avalara/.test(dialogs[dialogs.length - 1]), dialogs[dialogs.length - 1]);
  ok("H: dismissing the confirm calls nothing", callsOf("avalara_sync_tax_codes").length === 0);
  S.syncReplies.push({ body: { ok: true, fetched: 3180, upserted: 3180, skipped: 0, deactivated: 2, pages: 4, complete: true, syncedAt: "2026-09-17T15:00:00Z" },
    after: () => { S.adminStatus = { count: 3180, activeCount: 3178, syncedAt: "2026-09-17T15:00:00Z" }; } });
  await syncBtn.click();
  ok("H: a complete sync reports its counts", await waitText("Synced — 3,180 codes saved from 4 requests, 2 marked inactive."));
  ok("H: the row re-reads the catalog after the sync", await waitText("3,180 codes (3,178 active) · last synced"));
  const partial = partialSyncText("rate_limited", 429, 1000);
  S.syncReplies.push({ body: { ok: true, fetched: 1000, upserted: 1000, skipped: 0, deactivated: 0, pages: 2, complete: false, syncedAt: "2026-09-17T15:05:00Z", stoppedBy: "rate_limited", warning: partial } });
  await syncBtn.click();
  ok("H: a partial sync shows its warning sentence", await waitText(partial));
  ok("H: …and does not claim it synced", !(await text()).includes("Synced —"));
  const refused = syncFailureText("credentials_rejected", 401);
  S.syncReplies.push({ status: 502, body: { error: refused, reason: "credentials_rejected", pages: 1 } });
  await syncBtn.click();
  ok("H: a refused sync shows the server's sentence", await waitText(refused));

  // ── I: paperwork mode, the stored rate, the switch on ──
  const block = () => page.locator("[data-company-tax]");
  const rateBox = () => block().locator('input[aria-label="Sales tax rate (%)"]');
  const labelBox = () => block().locator('input[aria-label="Tax label on documents"]');
  const deliveryTick = () => block().locator('input[type="checkbox"]');
  const switchBox = () => page.locator('[data-tax-codes-switch] input[type="checkbox"]');
  const saveRateBtn = () => page.getByRole("button", { name: "Save tax rate" });
  const lastCompany = () => { const s = callsOf("save_company_tax"); return s.length ? s[s.length - 1].body : null; };
  const PAPER = "Charged on every taxable item. Items marked not taxable in your catalog are never taxed. A sales location's own rate, or a rate verified for the delivery address, is used instead. Enter 0 if you don't collect sales tax.";
  await boot({ company: company(), stored: [{ target_type: "heading", target_key: "doors", tax_code: "P0000000" }] });
  await openTax();
  await page.waitForTimeout(400);
  ok("I: the rate block shows", (await block().count()) === 1 && (await block().innerText()).includes("Your sales tax rate"));
  ok("I: it sits above the tax codes card", await page.evaluate(() => {
    const b = document.querySelector("[data-company-tax]");
    const n = document.querySelector("[data-tax-note]");
    return !!(b && n && (b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
  }));
  ok("I: paperwork-mode copy", (await page.locator("[data-company-tax-copy]").innerText()).trim() === PAPER, await page.locator("[data-company-tax-copy]").innerText().catch(() => ""));
  ok("I: the boxes hold what is stored", (await rateBox().inputValue()) === "6.5" && (await labelBox().inputValue()) === "Sales tax" && !(await deliveryTick().isChecked()));
  ok("I: nothing to save yet", await saveRateBtn().isDisabled() && (await block().innerText()).includes("No changes to save"));
  ok("I: no warning while a rate is on file", (await page.locator("[data-company-tax-warning]").count()) === 0);
  ok("I: the switch is on and the editor is open", (await switchBox().isChecked()) && (await row(0).count()) === 1 && (await page.locator("[data-tax-codes-off]").count()) === 0);
  ok("I: the codes note keeps its words", (await page.locator("[data-tax-note]").innerText()).includes("These codes are saved now and will be used when per-line tax with Avalara is switched on for your account."));

  // ── J: the save posts only what changed ──
  await rateBox().fill("7.25");
  await deliveryTick().check();
  ok("J: unsaved changes, and Save is on", !(await saveRateBtn().isDisabled()) && (await block().innerText()).includes("Unsaved changes"));
  await saveRateBtn().click();
  ok("J: it says what is stored", await waitText("Saved — your sales tax rate is 7.25%."));
  const bodyJ = lastCompany();
  ok("J: the save posts the rate and delivery only (the untouched label is not sent)",
    !!bodyJ && JSON.stringify(Object.keys(bodyJ).sort()) === JSON.stringify(["action", "ssTaxDelivery", "ssTaxRate"]) && bodyJ.ssTaxRate === "7.25" && bodyJ.ssTaxDelivery === true,
    JSON.stringify(bodyJ));
  ok("J: the stub stored it as the server would (a five-place fraction)", S.company.rate === 0.0725 && S.company.delivery === true);
  ok("J: nothing left to save, and the boxes show the stored values", await saveRateBtn().isDisabled() && (await rateBox().inputValue()) === "7.25" && await deliveryTick().isChecked());
  ok("J: the codes were not touched", S.stored.length === 1 && callsOf("tax_codes_save").length === 0);

  // ── K: a blank rate in paperwork mode, and no rate on file ──
  await rateBox().fill("");
  await saveRateBtn().click();
  ok("K: a blank rate shows the server's own sentence", await waitText(RATE_REQUIRED));
  ok("K: …and nothing claims it saved; the stored rate stands", !(await block().innerText()).includes("Saved —") && S.company.rate === 0.0725);
  await boot({ company: company({ rate: null }) });
  await openTax();
  await page.waitForTimeout(300);
  ok("K: no rate on file in paperwork mode: the amber warning", (await page.locator("[data-company-tax-warning]").count()) === 1
    && (await page.locator("[data-company-tax-warning]").innerText()).includes("can't go out until you save one (0 counts)"));
  await rateBox().fill("0");
  await saveRateBtn().click();
  ok("K: 0 is an answer: saved, and the warning goes", await waitText("Saved — your sales tax rate is 0%.") && (await page.locator("[data-company-tax-warning]").count()) === 0);

  // ── L: CRM mode with a CRM ──
  await boot({ ssMode: false, company: company({ crm: true, rate: 0.07 }) });
  await openTax();
  await page.waitForTimeout(300);
  const copyL = (await page.locator("[data-company-tax-copy]").innerText()).trim();
  ok("L: CRM connected: the CRM works the tax out", copyL === "Your CRM works out the tax on your estimates, so this rate isn't used.", copyL);
  ok("L: …no paperwork link and no warning", (await block().locator("a").count()) === 0 && (await page.locator("[data-company-tax-warning]").count()) === 0);

  // ── M: CRM mode with no CRM: the paperwork sentence and the link ──
  await boot({ ssMode: false, company: company({ crm: false, rate: null }), query: "?harness=keep" });
  await openTax();
  await page.waitForTimeout(300);
  const copyM = (await page.locator("[data-company-tax-copy]").innerText()).trim();
  ok("M: no CRM: estimates can't go out until the paperwork switch",
    copyM === "Your estimates can't go out until you switch to StructureStudio paperwork. Save your rate here first (0 counts), then make the switch on CRM Connection.", copyM);
  const link = block().getByRole("link", { name: "make the switch on CRM Connection" });
  const href = await link.getAttribute("href").catch(() => null);
  ok("M: the link is CRM Connection's address and keeps the query string", href === "/portal/settings/connection?harness=keep", String(href));
  await page.evaluate(() => { window.__ssSameDoc = true; });
  await link.click().catch(() => {});
  ok("M: it opens CRM Connection", await waitText("Save Estimate & Invoice Settings"));
  ok("M: …in the same document (no reload) at the real address",
    (await page.evaluate(() => window.__ssSameDoc === true)) && new URL(page.url()).pathname === "/portal/settings/connection", page.url());

  // ── N: codes off, kept, and back on ──
  const storedN = [
    { target_type: "heading", target_key: "doors", tax_code: "P0000000" },
    { target_type: "heading", target_key: "delivery", tax_code: "FR010000" },
  ];
  await boot({ lookupEnabled: true, company: company(), stored: storedN.map((x) => ({ ...x })) });
  await openTax();
  await page.waitForTimeout(400);
  await switchBox().uncheck();
  ok("N: off says the codes are kept", await waitText("Tax codes are off. The codes you saved are kept."));
  const bodyN = lastCompany();
  ok("N: the switch posts alone", JSON.stringify(bodyN) === JSON.stringify({ action: "save_company_tax", taxCodesEnabled: false }), JSON.stringify(bodyN));
  const offLine = await page.locator("[data-tax-codes-off]").innerText().catch(() => "");
  ok("N: the editor folds to one line", offLine.trim() === "Tax codes are off. Every taxable item is charged the rate above. Any codes you saved are kept.", offLine);
  ok("N: …with no rows, no note, no explainer and no Save", (await page.locator("[data-tax-row]").count()) === 0 && (await page.locator("[data-tax-note]").count()) === 0
    && !(await text()).includes("Every building, option and service you sell falls under a tax code") && (await page.getByRole("button", { name: "Save tax codes" }).count()) === 0);
  ok("N: no code was deleted", JSON.stringify(S.stored) === JSON.stringify(storedN) && callsOf("tax_codes_save").length === 0);
  ok("N: the rate block is still there", (await block().count()) === 1);
  await boot({ lookupEnabled: true, company: company({ codes: false }), stored: storedN.map((x) => ({ ...x })) });
  await tabButton().click();
  ok("N: a reload stays folded, switch off", await page.locator("[data-tax-codes-off]").waitFor({ timeout: 8000 }).then(() => true, () => false) && !(await switchBox().isChecked()));
  await switchBox().check();
  ok("N: on again brings the saved rows back", await waitText("Tax codes are on.") && (await row(0).innerText()).includes("P0000000") && (await row(1).innerText()).includes("FR010000"));
  ok("N: …and posts the switch alone", JSON.stringify(lastCompany()) === JSON.stringify({ action: "save_company_tax", taxCodesEnabled: true }));

  // ── O: a refused switch flips back ──
  await boot({ ssMode: false, company: company({ noRow: true }) });
  await tabButton().click();
  await page.locator("[data-tax-codes-switch]").waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  ok("O: a builder with no settings row starts with codes off", (await switchBox().count()) === 1 && !(await switchBox().isChecked()));
  await switchBox().click();
  ok("O: the refusal shows the server's sentence: save the rate first", await waitText(RATE_FIRST));
  await page.waitForTimeout(200);
  ok("O: …and the switch is back off, the editor still folded", !(await switchBox().isChecked()) && (await page.locator("[data-tax-codes-off]").count()) === 1);
  ok("O: nothing was stored", S.company.noRow === true && S.company.codes === true);

  // ── P: a settings_crm reader ──
  await boot({ role: "user", access: { settings_crm: "view" }, company: company({ delivery: true }) });
  await openTax();
  await page.waitForTimeout(400);
  const ro = await page.locator("[data-company-tax-readonly]").innerText().catch(() => "");
  ok("P: the reader sees the stored rate as text", /Rate:\s*6\.5%/.test(ro) && /Label on documents:\s*Sales tax/.test(ro) && /Tax on delivery:\s*yes/.test(ro), ro.replace(/\n/g, " | "));
  ok("P: …is told who can change it", (await page.locator("[data-company-tax-copy]").innerText()).includes("Only someone who can edit CRM Connection settings can change this."));
  ok("P: …and has no boxes and no Save", (await rateBox().count()) === 0 && (await saveRateBtn().count()) === 0);
  ok("P: the switch shows the setting but cannot be flipped", (await switchBox().isChecked()) && await switchBox().isDisabled());
  // CRM mode with no CRM: the two steps out (save a rate, make the switch) are for an editor.
  await boot({ role: "user", access: { settings_crm: "view" }, ssMode: false, company: company({ crm: false, rate: null }) });
  await openTax();
  await page.waitForTimeout(400);
  const copyP = (await page.locator("[data-company-tax-copy]").innerText().catch(() => "")).trim();
  ok("P: no CRM, a reader: the situation and who can change it, no steps they cannot take",
    copyP === "Your estimates can't go out until you switch to StructureStudio paperwork. Only someone who can edit CRM Connection settings can change this.", copyP);
  ok("P: …and no link to make the switch", (await block().locator("a").count()) === 0);

  // ── Q: a database without 290 ──
  await boot({ company: company({ codes: null }) });
  await openTax();
  await page.waitForTimeout(400);
  ok("Q: taxCodesEnabled null: the rate block shows", (await block().count()) === 1);
  ok("Q: …no switch, and today's editor", (await page.locator("[data-tax-codes-switch]").count()) === 0 && (await page.locator("[data-tax-row]").count()) === 3);

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
