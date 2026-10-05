// The same wall-height increase, hauled on narrow buildings and BUILT ON SITE on a wide one,
// driven for real on the COMPILED designer and the COMPILED portal (migration 272).
//
// Bug report 2026-10-02: a builder needed 12" of extra wall height on a 14' wide building that is
// built on site. +12" stays a normal hauled upgrade on the 8, 10 and 12 wide; the same +12" is
// sold on the 14 wide only as a building assembled on site, with its own $/lf and on-site fee.
//
//   A. the public designer, on a Deluxe with both +12 rows (and again with get_config's two
//      rows the other way round, since it orders them by increase only):
//        A1 at 12 wide the +12 button is hauled, and Details prices the hauled row (no Built On Site)
//        A2 widening to 14 keeps the pick, SAYS the building is now built on site, the button reads
//           "on site", and Details prices the on-site row's rate plus its $750 Built On Site line
//        A3 back to 12 keeps the pick and says it can be hauled again; the Built On Site line goes
//        A4 at 16 (neither row lists it) the pick drops to standard with the existing message
//   B. the portal's Settings → Options → Wall Height Upgrades card:
//        B1 the help text says to add the increase twice
//        B2 a second +12 row, ticked Built on site on the 14 only: while the server's switch
//           (WALL_HEIGHT_SITE_PAIRS) is off it is refused with the server's sentence and nothing is
//           stored; switched on, it saves (the stub answers with the REAL rules,
//           _shared/wallHeightRows.ts, imported, switched the way portal-settings switches them)
//        B3 the two rows sharing a width is refused at the card with one plain sentence naming the
//           width, and nothing is sent
//        B4 two hauled +12 rows are refused at the card too
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/wallHeightOnSite.mjs       (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/wall-height-on-site (SS_SHOTS overrides). Served from the tree
// before this change (86afa7a), 19 checks fail: at 14 wide the old designer dropped the +12 pick to
// standard ("isn't available on a 14 ft wide building"), and with get_config's rows the other way
// round it priced nothing even at 12 wide; B1, B3 and B4 fail there too. B2 holds on the old portal
// only because this stub answers with the new rule; the old server skipped the row as "listed twice".
//
// Fixtures are made up (a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir, stubSupabase, collectErrors, openDesigner, showOptTab } from "./lib.mjs";
import { wallHeightClash, wallHeightListedTwice } from "../../supabase/functions/_shared/wallHeightRows.ts";

const { ok, failed } = reporter();
const shots = shotsDir("wall-height-on-site");
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// ── A. The public designer ────────────────────────────────────────────────────────────────────
const HAULED = { deltaIn: 12, ratePerLf: 4.75, widthsFt: [8, 10, 12] };
const ON_SITE = { deltaIn: 12, ratePerLf: 6.5, widthsFt: [14], buildOnSite: true, bosFeeBasis: "each", bosFeeRate: 750 };
const SIZES = ["12x16", "14x16", "16x16"];
const designerConfig = (rows) => ({
  clientId: "harness-wall-heights",
  branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
  // No contact fields: the public Details section opens without typing (contactComplete short-circuits).
  contactFields: [],
  buildingStyles: [{ value: "deluxe", label: "Deluxe", img: null, sizes: SIZES, sizeInclusions: {}, sizeInclusionQty: {} }],
  defaultSizes: SIZES,
  sizePricing: { deluxe: Object.fromEntries(SIZES.map((s) => {
    const [w, l] = s.split("x").map(Number);
    return [s, { widthFt: w, lengthFt: l, basePrice: 6000 + 500 * w }];
  })) },
  options: [],
  colors: [],
  claddingOptions: {},
  wallHeightOptions: { deluxe: rows },
  showPricing: true,
  view3d: false,
  layoutItems: {},
  layoutPricing: {},
  layoutPrices: {},
  insulation: [],
});

// Every message the designer shows about the wall height, recorded as it appears, so a check
// cannot miss a 6-second toast by looking a moment too late.
const TOAST_RE = /too tall to haul on a|can be hauled on a|wall-height increase isn't available on a/;
async function recordToasts(page) {
  await page.addInitScript((src) => {
    const re = new RegExp(src);
    window.__whToasts = [];
    const scan = (n) => {
      const t = (n && (n.nodeType === 3 ? n.nodeValue : n.textContent)) || "";
      if (re.test(t)) window.__whToasts.push(t.trim().slice(0, 240));
    };
    const mo = new MutationObserver((ms) => { for (const m of ms) { m.addedNodes.forEach(scan); if (m.type === "characterData") scan(m.target); } });
    const attach = () => { if (document.documentElement) { mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); return; } setTimeout(attach, 5); };
    attach();
  }, TOAST_RE.source);
}
const toasts = (page) => page.evaluate(() => [...new Set(window.__whToasts || [])]);
const clearToasts = (page) => page.evaluate(() => { window.__whToasts = []; });

async function chooseSize(page, label) {
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: label }) }).first();
  await sel.selectOption({ label });
  await settle(page, 700);
}
// The wall-height buttons on Building's "Wall height" tab, as [text, pressed].
async function whButtons(page) {
  await showOptTab(page, "wallHeight");
  return page.locator('[data-ss-opt-panel] .ssd-seg button').evaluateAll((els) =>
    els.map((b) => [b.textContent.replace(/\s+/g, " ").trim(), b.getAttribute("aria-pressed") === "true"]));
}
async function pickPlus12(page) {
  await showOptTab(page, "wallHeight");
  await page.locator('[data-ss-opt-panel] .ssd-seg button').filter({ hasText: /^\+12/ }).first().click();
  await settle(page);
}
async function details(page) {
  const cta = page.locator(".ssd-dt-cta").first();
  if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); }
  return (await page.locator(".ssd-dt").first().innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ");
}

async function designerRun(browser, label, rows) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await recordToasts(page);
  await stubSupabase(page, { config: designerConfig(rows) });
  try {
    await openDesigner(page, "harness-wall-heights");
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    // The plan draws before a style is chosen; the wall-height choice belongs to a style, so pick it.
    await page.locator(".ssd-tile").filter({ hasText: "Deluxe" }).first().click();
    await settle(page, 600);

    // A1. 12 wide: the hauled row
    await chooseSize(page, "12x16");
    await pickPlus12(page);
    let btns = await whButtons(page);
    ok(`${label} A1 at 12 wide the +12 button is hauled, and picked`, btns.some(([t, on]) => t === "+12″" && on), JSON.stringify(btns));
    let dt = await details(page);
    // 12x16: 56 ft of perimeter x $4.75 = $266.00
    ok(`${label} A1 Details prices the hauled row: Taller Walls (+12 in) at $4.75 / ft = $266.00`,
      dt.includes("Taller Walls (+12 in)") && dt.includes("$4.75 / ft") && dt.includes("$266.00"), dt.slice(0, 400));
    ok(`${label} A1 and no Built On Site line`, !dt.includes("Built On Site"));
    await page.screenshot({ path: join(shots, `${label}-A1-12-wide.png`), fullPage: true });

    // A2. 14 wide: the same pick, now built on site
    await clearToasts(page);
    await chooseSize(page, "14x16");
    let said = await toasts(page);
    ok(`${label} A2 widening to 14 says the building will be built on site`,
      said.some((t) => t.includes('Walls 12" taller are too tall to haul on a 14 ft wide building, so this building will be built on your site.')), JSON.stringify(said));
    // Headed "Built on site", not the placement refusal's "Can't place here": nothing was refused.
    const head = await page.locator("[data-ss-toast]").first().innerText({ timeout: 3000 }).catch(() => "");
    ok(`${label} A2 the message is headed "Built on site", not "Can't place here"`,
      head.includes("Built on site") && !head.includes("Can't place here"), head.replace(/\s+/g, " "));
    btns = await whButtons(page);
    ok(`${label} A2 the pick is kept, and the button reads "+12″ · on site"`, btns.some(([t, on]) => t === "+12″ · on site" && on), JSON.stringify(btns));
    dt = await details(page);
    // 14x16: 60 ft of perimeter x $6.50 = $390.00, plus the $750 flat on-site fee
    ok(`${label} A2 Details prices the ON-SITE row: $6.50 / ft = $390.00`, dt.includes("Taller Walls (+12 in)") && dt.includes("$6.50 / ft") && dt.includes("$390.00"), dt.slice(0, 500));
    ok(`${label} A2 and its Built On Site line at $750.00`, dt.includes("Built On Site") && dt.includes("$750.00"), dt.slice(0, 500));
    await page.screenshot({ path: join(shots, `${label}-A2-14-wide-on-site.png`), fullPage: true });

    // A3. back to 12: hauled again
    await clearToasts(page);
    await chooseSize(page, "12x16");
    said = await toasts(page);
    ok(`${label} A3 back to 12 says it can be hauled again`,
      said.some((t) => t.includes('Walls 12" taller can be hauled on a 12 ft wide building, so this building is no longer built on site.')), JSON.stringify(said));
    const head3 = await page.locator("[data-ss-toast]").first().innerText({ timeout: 3000 }).catch(() => "");
    ok(`${label} A3 headed "Hauled", in the info colours`,
      head3.includes("Hauled") && (await page.locator('[data-ss-toast="info"]').count()) === 1, head3.replace(/\s+/g, " "));
    dt = await details(page);
    btns = await whButtons(page);
    ok(`${label} A3 the pick is kept and priced hauled; the Built On Site line is gone`,
      btns.some(([t, on]) => t === "+12″" && on) && dt.includes("$266.00") && !dt.includes("Built On Site"), JSON.stringify(btns) + " " + dt.slice(0, 300));

    // A4. 16 wide: neither row lists it
    await clearToasts(page);
    await chooseSize(page, "16x16");
    said = await toasts(page);
    ok(`${label} A4 at 16 wide the pick drops to standard, with the existing message`,
      said.some((t) => t.includes(`A 12" wall-height increase isn't available on a 16 ft wide building — set back to standard height.`)), JSON.stringify(said));
    dt = await details(page);
    ok(`${label} A4 and nothing prices`, !dt.includes("Taller Walls") && !dt.includes("Built On Site"), dt.slice(0, 300));

    ok(`${label} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

// ── B. The portal's Wall Height Upgrades card ─────────────────────────────────────────────────
const CLIENT = "acme-sheds";
const STYLE = "00000000-0000-4000-8000-0000000000d1";
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
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const WIDTHS = [8, 10, 12, 14];

async function portalRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const saves = [];
  const outside = [];
  // The stored rows, as the catalog read returns them.
  let stored = [{ id: "wh-1", style_id: STYLE, delta_in: 12, rate_per_lf: 4.75, taxable: true, active: true, sort_order: 0,
    widths_ft: [8, 10, 12], internal_only: false, build_on_site: false, bos_fee_basis: null, bos_fee_rate: null }];
  let nextId = 2;
  // portal-settings' WALL_HEIGHT_SITE_PAIRS: off until production runs the new resolveWallHeight.
  let sitePairs = false;
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { outside.push(route.request().url()); return route.abort(); });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
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
        return json(route, { ok: true, clientId: CLIENT,
          styles: [{ id: STYLE, key: "deluxe", label: "Deluxe", active: true, d3: { wallHeightFt: 8 } }],
          sizes: WIDTHS.map((w) => ({ id: `sz-${w}`, style_id: STYLE, width_ft: w, length_ft: 16, active: true })),
          items: [], inclusions: [], layoutPricing: [], colors: [], fixtures: [], wallHeights: stored });
      case "save_wall_heights": {
        saves.push(body);
        // portal-settings' rule, imported: refuse with its sentence, or store what it would store.
        const rows = body.rows.map((r) => ({ ...r, widthsFt: Array.isArray(r.widthsFt) ? r.widthsFt : WIDTHS }));
        const clash = (sitePairs ? null : wallHeightListedTwice(rows)) ?? wallHeightClash(rows, WIDTHS);
        if (clash) return json(route, { error: `Nothing was saved. ${clash}` }, 400);
        stored = rows.map((r, i) => ({ id: r.id || `wh-${nextId++}`, style_id: STYLE, delta_in: r.deltaIn,
          rate_per_lf: r.ratePerLf === "" ? null : Number(r.ratePerLf), taxable: r.taxable !== false, active: r.active !== false, sort_order: i,
          widths_ft: r.widthsFt, internal_only: !!r.internalOnly, build_on_site: !!r.buildOnSite,
          bos_fee_basis: r.buildOnSite ? (r.bosFeeBasis || "each") : null, bos_fee_rate: r.buildOnSite && r.bosFeeRate !== "" ? Number(r.bosFeeRate) : null }));
        return json(route, { ok: true, saved: rows.length, deleted: 0, skipped: [] });
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
    await page.evaluate(() => { history.pushState({}, "", "/portal/settings/options"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForFunction(() => document.body.innerText.includes("Wall Height Upgrades") && document.body.innerText.includes("Deluxe"), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    const text = () => page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const first = await text();
    const loaded = ok("B0 the Wall Height Upgrades card rendered with the Deluxe", first.includes("Wall Height Upgrades") && first.includes("Deluxe"), first.slice(0, 300).replace(/\s+/g, " "));
    if (!loaded) throw new Error("the card never rendered; refusing to report the rest as passes");
    ok("B1 the help text says to add the increase twice", first.replace(/\s+/g, " ").includes("add it twice: once with the hauled widths ticked, and once ticked Built on site with the wider widths."));

    const rowsLoc = page.locator("table tbody tr");
    const cell = (r, n) => rowsLoc.nth(r).locator("td").nth(n);
    const widthBox = (r, w) => cell(r, 2).locator("label").filter({ hasText: new RegExp(`^\\s*${w}\\s*$`) }).locator("input");
    const save = async () => {
      const n = saves.length;
      await page.getByRole("button", { name: /^Save$/ }).first().click();
      await settle(page, 600);
      return saves.slice(n);
    };

    // B2. the second +12 row, built on site on the 14 only
    await page.getByRole("button", { name: "+ Add increase" }).click();
    await settle(page, 300);
    ok("B2 the new row is there", (await rowsLoc.count()) === 2, String(await rowsLoc.count()));
    await cell(1, 0).locator("input").fill("12");
    await cell(1, 1).locator("input").fill("6.50");
    for (const w of [8, 10, 12]) await widthBox(1, w).uncheck();
    await cell(1, 4).locator("input").check();
    await settle(page, 200);
    await cell(1, 7).locator('input[type="number"]').fill("750");
    await page.screenshot({ path: join(shots, "B2-before-save.png"), fullPage: true });
    // Switched off (the default): the server refuses the second row, and the card shows its words.
    let sent = await save();
    const off = await text();
    ok("B2 with the switch off, the pair is refused with the server's sentence and nothing is stored",
      sent.length === 1 && stored.length === 1 && off.includes("Nothing was saved. +12 in is listed twice. For now, list each increase once."),
      `saves=${sent.length} stored=${stored.length} ${off.slice(off.indexOf("Nothing was saved"), off.indexOf("Nothing was saved") + 120)}`);
    await page.screenshot({ path: join(shots, "B2-switched-off.png"), fullPage: true });
    sitePairs = true;
    sent = await save();
    const after = await text();
    ok("B2 the pair saves: two +12 rows, the second built on site on 14 only",
      sent.length === 1 && sent[0].rows.length === 2
        && sent[0].rows[0].deltaIn === 12 && !sent[0].rows[0].buildOnSite
        && sent[0].rows[1].deltaIn === 12 && sent[0].rows[1].buildOnSite === true && JSON.stringify(sent[0].rows[1].widthsFt) === "[14]"
        && sent[0].rows[1].bosFeeRate === "750",
      JSON.stringify(sent.map((s) => s.rows)));
    ok("B2 the card says it saved both", after.includes("Deluxe: saved 2 height(s)."), after.slice(after.indexOf("Deluxe:"), after.indexOf("Deluxe:") + 80));
    ok("B2 and the reload shows both rows", (await rowsLoc.count()) === 2 && stored.length === 2);
    await page.screenshot({ path: join(shots, "B2-saved.png"), fullPage: true });

    // B3. the on-site row ticks 12 too: the two would share the 12 wide
    await widthBox(1, 12).check();
    sent = await save();
    let t = await text();
    ok("B3 sharing the 12 wide is refused at the card, naming the width, and nothing is sent",
      sent.length === 0 && t.includes("Nothing was saved — +12 in is offered both hauled and built on site at 12 ft wide. Untick that width on one of the two rows."),
      `saves=${sent.length} ${t.slice(t.indexOf("Nothing was saved"), t.indexOf("Nothing was saved") + 160)}`);
    await page.screenshot({ path: join(shots, "B3-shared-width.png"), fullPage: true });

    // B4. two hauled +12 rows
    await widthBox(1, 12).uncheck();
    await cell(1, 4).locator("input").uncheck();
    sent = await save();
    t = await text();
    ok("B4 two hauled +12 rows are refused at the card, and nothing is sent",
      sent.length === 0 && t.includes("Nothing was saved — +12 in is listed twice. An increase can be listed once for hauled buildings and once ticked Built on site."),
      `saves=${sent.length} ${t.slice(t.indexOf("Nothing was saved"), t.indexOf("Nothing was saved") + 160)}`);

    // Every non-local request is aborted by construction; the page's web-font stylesheet is the only
    // one it should even try.
    ok("B nothing but the web-font stylesheet tried to leave (and it was aborted)",
      outside.every((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), outside.slice(0, 3).join(" "));
    ok("B no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

const { browser } = await launch({ width: 1400, height: 1100 });
try {
  await designerRun(browser, "hauled-first", [HAULED, ON_SITE]);
  await designerRun(browser, "on-site-first", [ON_SITE, HAULED]);
  await portalRun(browser);
} catch (e) {
  ok("harness ran to the end", false, e.message);
} finally {
  await browser.close();
}
const bad = failed();
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
console.log(`shots: ${shots}`);
process.exit(bad.length ? 1 : 0);
