// Rigid foam insulation under the floor only, driven for real on the COMPILED designer and the
// COMPILED portal (migration 272).
//
// Feature request 2026-10-02: "We use Rigid Foam insulation only under the floor sheeting." Rigid
// foam is a third insulation type; "floor only" is the builder's configuration, a Floor rate with
// Walls and Roof left blank, so get_config sends exactly one row.
//
//   A. the public designer, a builder who offers ONLY rigid foam, ONLY on the floor:
//        A1 the Insulation tab shows one button, "Rigid Foam — Floor": no type picker, no "Entire
//           building", and never a bare "Floor" that does not say what goes in it
//        A2 ticking it prices "Rigid Foam Insulation — Floor" at $1.25 / sq ft x 12 x 24 = $360.00
//        A3 the quote sends { type: "rigid_foam", area: "floor" } to submit-estimate, nothing more
//   B. a builder selling batt and spray foam (the live shape): the type picker and the short
//      Floor / Walls / Roof / Entire building buttons are exactly as before
//   C. batt and rigid foam together: the picker offers Rigid Foam, which shows only Floor
//   D. the portal's Settings → Insulation card:
//        D1 the matrix has a Rigid Foam row beside Batt and Spray Foam
//        D2 the help text says how to offer the floor only
//        D3 switching insulation on and filling only Rigid Foam's Floor rate sends that one rate,
//           with Walls and Roof blank, and the card reports one rate saved
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/rigidFoamFloor.mjs         (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/rigid-foam-floor (SS_SHOTS overrides). Served from the tree
// before this change (86afa7a), 8 checks fail: the one button is a bare "Floor", the line reads
// "rigid_foam Insulation — Floor", the picker shows "rigid_foam", and the portal has no Rigid Foam
// row to type into. B holds on both trees, which is its job: the live two-type tenant is unchanged.
//
// Fixtures are made up (a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, openDesigner, showOptTab } from "./lib.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("rigid-foam-floor");
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const W = 12, L = 24, SIZE = `${W}x${L}`;
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const CORS = { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

// ── A-C. The public designer ──────────────────────────────────────────────────────────────────
const designerConfig = (insulation) => ({
  clientId: "harness-rigid-foam",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  contactFields: ["name", "email", "phone"],
  buildingStyles: [{ value: "utility", label: "Utility", img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {} }],
  defaultSizes: [SIZE],
  sizePricing: { utility: { [SIZE]: { widthFt: W, lengthFt: L, basePrice: 9000 } } },
  options: [],
  colors: [],
  claddingOptions: [],
  wallHeightOptions: {},
  showPricing: true,
  view3d: false,
  layoutItems: {},
  layoutPricing: {},
  layoutPrices: {},
  insulation,
});

async function openWithSize(page, insulation, submits) {
  await stubSupabase(page, { config: designerConfig(insulation) });
  // Registered after stubSupabase, so they answer first. The quote PDF upload is accepted (and
  // dropped) so the submit goes through; the quote's payload is the check.
  await page.route(`**/${REF}.supabase.co/storage/v1/object/**`, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: H, body: JSON.stringify({ Key: new URL(route.request().url()).pathname }) });
  });
  await page.route(`**/functions/v1/submit-estimate**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "" });
    try { submits.push(JSON.parse(req.postData() || "{}")); } catch (_e) { submits.push({}); }
    return route.fulfill({ status: 200, contentType: "application/json", headers: H, body: JSON.stringify({ ok: true, shortCode: "SS-TEST" }) });
  });
  await openDesigner(page, "harness-rigid-foam");
  await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
  await page.locator("[data-ss-style]").first().click();
  await settle(page, 600);
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
  if (await sel.count()) await sel.first().selectOption({ label: SIZE });
  await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), L, { timeout: 20000 });
  await settle(page, 600);
}

// The Insulation tab's controls: the type picker's segments and the area buttons, as [text, pressed].
async function insControls(page) {
  await showOptTab(page, "insulation");
  const panel = page.locator('[data-ss-opt-panel]').filter({ has: page.locator(".ssd-cov") }).first();
  const read = (sel) => panel.locator(sel).evaluateAll((els) =>
    els.map((b) => [b.textContent.replace(/\s+/g, " ").trim(), b.getAttribute("aria-pressed") === "true"]));
  return { seg: await read(".ssd-seg button"), cov: await read("button.ssd-cov"), panel };
}
async function details(page) {
  const cta = page.locator(".ssd-dt-cta").first();
  if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); }
  return (await page.locator(".ssd-dt").first().innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ");
}
async function fillContact(page) {
  // 555-01xx is reserved for fiction, the number the e2e suite uses.
  await page.getByPlaceholder("Full Name").fill("Pat Tester");
  await page.getByPlaceholder("email@example.com").fill("pat@example.com");
  await page.getByPlaceholder("(555) 555-5555").fill("5550104477");
  await settle(page, 600);
}

async function runFoamOnly(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const submits = [];
  try {
    await openWithSize(page, [{ type: "rigid_foam", area: "floor", ratePerSqft: 1.25 }], submits);
    const tabs = await page.locator("[data-ss-opt-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-opt-tab")));
    ok("A1 the Insulation tab is offered", tabs.includes("insulation"), JSON.stringify(tabs));
    let c = await insControls(page);
    ok("A1 one button, \"Rigid Foam — Floor\", not a bare \"Floor\"",
      c.cov.length === 1 && c.cov[0][0] === "Rigid Foam — Floor" && !c.cov[0][1], JSON.stringify(c.cov));
    ok("A1 no type picker and no Entire building", c.seg.length === 0 && !c.cov.some(([t]) => /Entire building/.test(t)), JSON.stringify({ seg: c.seg, cov: c.cov }));
    await c.panel.screenshot({ path: join(shots, "A1-foam-only-panel.png") });

    // By position, not by name: on a tree without the label the run goes on and reports the rest.
    await c.panel.locator("button.ssd-cov").first().click();
    await settle(page);
    c = await insControls(page);
    ok("A2 ticking it presses it", c.cov.length === 1 && c.cov[0][1], JSON.stringify(c.cov));
    await fillContact(page);
    const dt = await details(page);
    // 12 x 24 = 288 sq ft of floor at $1.25 = $360.00
    ok("A2 Details prices Rigid Foam Insulation — Floor at $1.25 / sq ft = $360.00",
      dt.includes("Rigid Foam Insulation — Floor") && dt.includes("$1.25 / sq ft") && dt.includes("288") && dt.includes("$360.00"),
      dt.slice(Math.max(0, dt.indexOf("Insulation") - 40), dt.indexOf("Insulation") + 160));
    ok("A2 and no raw type name anywhere", !/rigid_foam/.test(dt));
    await page.screenshot({ path: join(shots, "A2-foam-only-details.png"), fullPage: true });

    const quote = page.locator("button.ssd-ft-cta.is-quote").first();
    await quote.scrollIntoViewIfNeeded();
    await quote.click();
    for (let i = 0; i < 60 && !submits.length; i++) await settle(page, 250);
    const ins = submits.length ? submits[submits.length - 1].selections?.insulation : undefined;
    ok("A3 the quote sends exactly { type: rigid_foam, area: floor }",
      submits.length === 1 && JSON.stringify(ins) === JSON.stringify([{ type: "rigid_foam", area: "floor" }]),
      `submits ${submits.length} ${JSON.stringify(ins)}`);
    ok("A no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

async function runTwoTypes(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    // The live shape: batt on all three, spray foam on floor and walls (its roof left blank).
    await openWithSize(page, [
      { type: "batt", area: "floor", ratePerSqft: 1.1 }, { type: "batt", area: "roof", ratePerSqft: 1.1 },
      { type: "batt", area: "walls", ratePerSqft: 0.9 }, { type: "spray_foam", area: "floor", ratePerSqft: 2.5 },
      { type: "spray_foam", area: "walls", ratePerSqft: 2.2 },
    ], []);
    const c = await insControls(page);
    ok("B the type picker is Batt | Spray Foam", JSON.stringify(c.seg.map(([t]) => t)) === JSON.stringify(["Batt", "Spray Foam"]), JSON.stringify(c.seg));
    ok("B the area buttons keep their short names: Floor, Walls, Roof, Entire building",
      JSON.stringify(c.cov.map(([t]) => t)) === JSON.stringify(["Floor", "Walls", "Roof", "Entire building"]), JSON.stringify(c.cov));
    await c.panel.screenshot({ path: join(shots, "B-two-types-panel.png") });
    ok("B no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

async function runBattAndFoam(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  try {
    await openWithSize(page, [
      { type: "batt", area: "floor", ratePerSqft: 1.1 }, { type: "batt", area: "walls", ratePerSqft: 0.9 },
      { type: "rigid_foam", area: "floor", ratePerSqft: 1.25 },
    ], []);
    let c = await insControls(page);
    ok("C the type picker offers Rigid Foam beside Batt", JSON.stringify(c.seg.map(([t]) => t)) === JSON.stringify(["Batt", "Rigid Foam"]), JSON.stringify(c.seg));
    await c.panel.locator(".ssd-seg button").nth(1).click();
    await settle(page);
    c = await insControls(page);
    ok("C Rigid Foam shows only Floor, under the picker that names it", JSON.stringify(c.cov.map(([t]) => t)) === JSON.stringify(["Floor"]), JSON.stringify(c.cov));
    await c.panel.locator("button.ssd-cov").first().click();
    await settle(page);
    await fillContact(page);
    const dt = await details(page);
    ok("C and it prices as Rigid Foam Insulation — Floor, $360.00", dt.includes("Rigid Foam Insulation — Floor") && dt.includes("$360.00") && !dt.includes("Batt Insulation"),
      dt.slice(Math.max(0, dt.indexOf("Insulation") - 40), dt.indexOf("Insulation") + 120));
    await c.panel.screenshot({ path: join(shots, "C-batt-and-foam-panel.png") });
    ok("C no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

// ── D. The portal's Insulation card ───────────────────────────────────────────────────────────
const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const OWNER_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "change_order_approve", "build_schedule", "delivery_schedule", "repairs", "commissions", "reports", "phone",
  "settings_structures", "settings_options", "settings_branding", "settings_crm", "settings_quickbooks",
  "settings_email", "settings_team", "settings_billing"].map((k) => [k, "edit"]));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

async function portalRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const saves = [];
  const outside = [];
  // A builder with insulation off and no rates yet, as the one who asked is today.
  let stored = [];
  let enabled = false;
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { outside.push(route.request().url()); return route.abort(); });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: CORS, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "catalog":
        return json(route, { ok: true, clientId: CLIENT, styles: [], sizes: [], items: [], inclusions: [], layoutPricing: [],
          colors: [], fixtures: [], wallHeights: [], insulation: stored, insulationEnabled: enabled });
      case "save_insulation": {
        saves.push(body);
        // save_insulation's answer for these rows: a rate is saved, a blank deletes what was there
        // (counted only when something was), and the switch is written when it is sent.
        const TYPES = new Set(["batt", "spray_foam", "rigid_foam"]);
        let saved = 0, cleared = 0; const skipped = [];
        const next = [];
        for (const r of body.rows) {
          if (!TYPES.has(r.type)) { skipped.push(`${r.type}/${r.area}: not a known type or area`); continue; }
          const had = stored.find((s) => s.ins_type === r.type && s.area === r.area);
          if (String(r.ratePerSqft ?? "").trim() === "") { if (had) cleared++; continue; }
          next.push({ id: `io-${next.length}`, ins_type: r.type, area: r.area, rate_per_sqft: Number(r.ratePerSqft), taxable: r.taxable !== false, active: r.active !== false, internal_only: !!r.internalOnly });
          saved++;
        }
        stored = next;
        if (Object.prototype.hasOwnProperty.call(body, "enabled")) enabled = body.enabled === true;
        return json(route, { ok: true, saved, cleared, skipped });
      }
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  try {
    await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
    await settle(page, 600);
    await page.evaluate(() => { history.pushState({}, "", "/portal/settings/insulation"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForFunction(() => document.body.innerText.includes("Offer insulation to customers"), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    const text = async () => (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).replace(/\s+/g, " ");
    const card = page.locator("div").filter({ has: page.getByText("Offer insulation to customers") }).filter({ has: page.locator("table") }).last();
    const loaded = ok("D0 the Insulation card rendered", await card.count() > 0 && (await text()).includes("Offer insulation to customers"));
    if (!loaded) throw new Error("the card never rendered; refusing to report the rest as passes");

    const rowsLoc = card.locator("table tbody tr");
    const names = await rowsLoc.evaluateAll((trs) => trs.map((tr) => tr.querySelector("td").textContent.trim()));
    ok("D1 the matrix rows are Batt, Spray Foam, Rigid Foam", JSON.stringify(names) === JSON.stringify(["Batt", "Spray Foam", "Rigid Foam"]), JSON.stringify(names));
    ok("D2 the help text says how to offer the floor only",
      (await text()).includes("Only insulate under the floor? Fill in just the Floor rate for that type and leave Walls and Roof blank."));

    await card.getByText("Offer insulation to customers").click();
    // Columns: name, Offer, Floor, Walls, Roof, Internal only, Taxable.
    await rowsLoc.nth(2).locator("td").nth(2).locator("input").fill("1.25");
    await card.screenshot({ path: join(shots, "D3-before-save.png") });
    const n = saves.length;
    await page.getByRole("button", { name: "Save insulation" }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 600);
    const sent = saves.slice(n);
    const rows = sent.length ? sent[0].rows : [];
    const foam = rows.filter((r) => r.type === "rigid_foam");
    const priced = rows.filter((r) => r.ratePerSqft !== "");
    ok("D3 the save switches insulation on and sends the nine cells",
      sent.length === 1 && sent[0].enabled === true && rows.length === 9, `saves=${sent.length} rows=${rows.length} enabled=${sent[0] && sent[0].enabled}`);
    ok("D3 one rate is filled in: Rigid Foam, Floor, 1.25; its Walls and Roof are blank",
      priced.length === 1 && priced[0].type === "rigid_foam" && priced[0].area === "floor" && priced[0].ratePerSqft === "1.25"
        && foam.length === 3 && foam.filter((r) => r.ratePerSqft === "").map((r) => r.area).join(",") === "walls,roof",
      JSON.stringify(priced) + " " + JSON.stringify(foam));
    const t = await text();
    ok("D3 the card says one rate was saved, and nothing \"no longer offered\"",
      t.includes("Saved 1 rate(s).") && !t.includes("no longer offered") && !t.includes("skipped"),
      t.slice(Math.max(0, t.indexOf("Saved") - 10), t.indexOf("Saved") + 80));
    const after = await rowsLoc.nth(2).locator("td").nth(2).locator("input").inputValue();
    ok("D3 the reload shows the Rigid Foam floor rate", after === "1.25", after);
    await card.screenshot({ path: join(shots, "D3-saved.png") });

    ok("D nothing but the web-font stylesheet tried to leave (and it was aborted)",
      outside.every((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), outside.slice(0, 3).join(" "));
    ok("D no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

const { browser } = await launch({ width: 1400, height: 1100 });
try {
  // Each run reports on its own, so one that stops early does not hide the others.
  for (const [name, run] of [["A", runFoamOnly], ["B", runTwoTypes], ["C", runBattAndFoam], ["D", portalRun]]) {
    try { await run(browser); } catch (e) { ok(`${name} ran to the end`, false, String(e.message).split("\n")[0]); }
  }
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
console.log(`shots: ${shots}`);
process.exit(bad.length ? 1 : 0);
