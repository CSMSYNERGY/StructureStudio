// Settings → QuickBooks item mappings for the newer line kinds, delivery and the shelves, driven
// for real.
//
// Carolyn, 2026-09-10: "I've added a lot of options in here that are not going into QuickBooks".
// The code side landed 09-17 (b0314d8: every kind has a row and saves); what is left is a mapping
// chore on the live tenant: the seven newer kinds and four layout items (Single Shelf, Double Shelf,
// Rough Opening (Door), Rough Opening (Window)) to the catch-all Options item, with Delivery left
// on the Fallback on purpose. This harness rehearses that chore on a grid shaped like the live one,
// with Supabase stubbed at the network layer (no login, nothing leaves the machine, nothing
// reaches Intuit), and checks what the owner reads:
//
//   E. every row the chore needs is on the page, under the words the owner will look for
//   F. an unmapped row says where its lines go: "— use Fallback (Options) —", not "— not
//      mapped —" (the words that made Delivery read as "not going into QuickBooks"). Fallback
//      itself and Discount keep "— not mapped —"; a style override keeps "— use default —"
//   G. the chore: Options picked on the eleven rows, Save posts EXACTLY those eleven (Delivery is
//      not among them) with the company tag the grid was loaded with, the banner says "Mappings
//      updated (11 saved).", and the reloaded grid shows the eleven picked while Delivery still
//      reads "— use Fallback (Options) —"
//   H. the empty choice follows the Fallback row as it is edited, before saving: another item
//      renames it, clearing the Fallback turns every row back to "— not mapped —"
//   I. with no Fallback saved at all, an unmapped row reads "— not mapped —" (it would stop the push)
//
// The server half (save_item_map takes the eleven rows and stamps them, and the push bills each
// kind from its own row) is driven in supabase/functions/_shared/_test_stubs/qboRealmWiring_test.ts.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/qboItemGrid.mjs               (exit 0 = every check held)
//
// SS_PORTAL_ARTIFACT=<path to an older portal.app.compiled.js> serves that file instead. Against
// the artifact before this change 16 checks fail: 15 of them wording (F's twelve unmapped rows,
// G's Delivery-after-save and H's two renames) and G's company tag, which an old page never sends
// (save_item_map lets a tagless save through, as before). E, the rest of G and I pass (an old page
// says "— not mapped —" everywhere): the chore itself already works on the live page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, reporter, shotsDir, BASE, REF } from "./lib.mjs";

const CLIENT = "harness-qbo-grid";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000005", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const PORTAL_HTML = readFileSync(new URL("../../portal.html", import.meta.url), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

// ─── A grid shaped like the live tenant's, with made-up ids and names ─────────────────────────
const OPTIONS = "29";
const ITEMS = [
  { id: "21", name: "Buildings", type: "Service", fullName: "Buildings" },
  { id: "22", name: "Doors", type: "Service", fullName: "Doors" },
  { id: OPTIONS, name: "Options", type: "Service", fullName: "Options" },
  { id: "30", name: "Misc", type: "Service", fullName: "Other:Misc" },
];
const STYLE = "00000000-0000-4000-8000-0000000000b1";
// The opaque company tag list_item_map hands the page (qboRealm.ts companyTagOf); made up.
const TAG = "c0ffee000001";
const LAYOUT = [
  { item_key: "loft", label: "Loft Area", active: true },
  { item_key: "roughOpening", label: "Rough Opening", active: true },
  { item_key: "workbench", label: "Workbench", active: true },
  { item_key: "shelf", label: "Single Shelf", active: true },
  { item_key: "doubleShelf", label: "Double Shelf", active: true },
  { item_key: "roughOpeningDoor", label: "Rough Opening (Door)", active: true },
  { item_key: "roughOpeningWindow", label: "Rough Opening (Window)", active: true },
];
const row = (id, line_kind, qbo_item_id, qbo_item_name, item_key = "", style_id = null) =>
  ({ id, line_kind, item_key, style_id, qbo_item_id, qbo_item_name });
// Mapped before the chore: what the live tenant had on 2026-10-04, by shape.
const BEFORE = [
  row("m-building", "building", "21", "Buildings"),
  row("m-door", "door", "22", "Doors"),
  row("m-custom", "custom_option", OPTIONS, "Options"),
  row("m-loft", "layout_item", OPTIONS, "Options", "loft"),
  row("m-ro", "layout_item", OPTIONS, "Options", "roughOpening"),
  row("m-bench", "layout_item", OPTIONS, "Options", "workbench"),
  row("m-fallback", "fallback", OPTIONS, "Options"),
];

// The chore, as the grid's own words name it.
const CHORE_KINDS = [
  ["wall_height", "Taller walls"],
  ["build_on_site", "Built on site"],
  ["cladding", "Cladding"],
  ["insulation", "Insulation"],
  ["electrical", "Electrical package"],
  ["electrical_item", "Electrical items"],
  ["foundation", "Foundation & site work"],
];
const CHORE_LAYOUT = [
  ["shelf", "Single Shelf"],
  ["doubleShelf", "Double Shelf"],
  ["roughOpeningDoor", "Rough Opening (Door)"],
  ["roughOpeningWindow", "Rough Opening (Window)"],
];
const USE_OPTIONS = "— use Fallback (Options) —";
const NOT_MAPPED = "— not mapped —";

const SHOTS = shotsDir("qbo-item-grid");
const { ok, failed } = reporter();
const { browser } = await launch({ width: 1400, height: 1000 });
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

// One fresh context per scenario. `mappings` is what list_item_map answers first; a save adds the
// posted rows to it, as save_item_map does.
async function open(mappings) {
  const calls = [];
  const logged = [];
  const pageErrors = [];
  let saved = mappings.map((m) => ({ ...m }));
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ } }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // Catch-all abort FIRST: Playwright runs matching routes in reverse registration order.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/log_error")) { logged.push(body); return json(route, null); }
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null,
        entitlement: { granted: ["quickbooks_sync"], features: { quickbooks_sync: true }, status: "active" } });
    }
    if (url.includes("/admin-catalog")) return json(route, { ok: true, clients: [], features: [], layoutItemTypes: [] });
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status": return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {} });
      case "qbo_status": return json(route, {
        clientId: CLIENT, oauthReady: true, connected: true, companyName: "Harness Books", realmIdMasked: "••••0001",
        connectedAt: "2026-10-04T12:00:00Z", broken: false, brokenReason: null, refreshTokenExpiresAt: null, disconnectReason: null, mappedCount: saved.length,
      });
      case "list_item_map": return json(route, {
        clientId: CLIENT, styles: [{ id: STYLE, label: "Barn", active: true }], layoutItems: LAYOUT, mappings: saved, companyTag: TAG,
      });
      case "list_qbo_items": return json(route, { clientId: CLIENT, items: ITEMS });
      case "qbo_pending": return json(route, { ok: true, clientId: CLIENT, pending: [] });
      case "save_item_map": {
        // save_item_map's contract: a picked id upserts the slot, a blank one deletes it.
        let n = 0, d = 0;
        for (const r of body.rows || []) {
          const same = (m) => m.line_kind === r.lineKind && (m.item_key || "") === (r.itemKey || "") && (m.style_id || null) === (r.styleId || null);
          const had = saved.some(same);
          saved = saved.filter((m) => !same(m));
          if (r.qboItemId) { saved.push(row(`new-${saved.length}`, r.lineKind, r.qboItemId, r.qboItemName, r.itemKey || "", r.styleId || null)); n++; }
          else if (had) d++;
        }
        return json(route, { ok: true, saved: n, deleted: d, skipped: [], clientId: CLIENT });
      }
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  // What _redirects does in production: every /portal/<page> is portal.html.
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}/portal/settings/quickbooks`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  // The grid is drawn once list_item_map is in; its dropdowns are filled once list_qbo_items is.
  await page.waitForFunction(() => [...document.querySelectorAll("select option")].some((o) => o.textContent === "Options"), null, { timeout: 20000 }).catch(() => {});
  return { page, ctx, calls, logged, pageErrors };
}

// A kind's dropdown sits beside its bold label; a layout item's and a style's beside a span.
const kindSel = (page, label) => page.locator(`xpath=//div[div[normalize-space(.)=${JSON.stringify(label)}]]/select`);
const subSel = (page, label) => page.locator(`xpath=//div[span[normalize-space(.)=${JSON.stringify(label)}]]/select`);
const shown = (sel) => sel.evaluate((s) => s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null).catch(() => null);
const emptyText = (sel) => sel.evaluate((s) => (s.options[0] && s.options[0].value === "" ? s.options[0].text : null)).catch(() => null);
const waitText = (page, s, timeout = 15000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const clean = (S, label) => {
  ok(`${label}: no page errors`, S.pageErrors.length === 0, S.pageErrors.join(" | "));
  ok(`${label}: nothing filed in app_errors`, S.logged.length === 0, JSON.stringify(S.logged).slice(0, 200));
};

try {
  // ── E, F, G: the live shape, then the chore ──
  {
    const S = await open(BEFORE);
    const { page } = S;
    ok("E: the mapping grid renders", await waitText(page, "Invoice item mappings"));
    for (const [, label] of [...CHORE_KINDS, ["delivery", "Delivery"]]) {
      ok(`E: "${label}" has a row with a dropdown`, (await kindSel(page, label).count()) === 1);
    }
    for (const [, label] of CHORE_LAYOUT) {
      ok(`E: layout item "${label}" has a row with a dropdown`, (await subSel(page, label).count()) === 1);
    }

    // F
    for (const [, label] of [...CHORE_KINDS, ["delivery", "Delivery"]]) {
      const got = await shown(kindSel(page, label));
      ok(`F: unmapped "${label}" reads "${USE_OPTIONS}"`, got === USE_OPTIONS, String(got));
    }
    for (const [, label] of CHORE_LAYOUT) {
      const got = await shown(subSel(page, label));
      ok(`F: unmapped layout item "${label}" reads "${USE_OPTIONS}"`, got === USE_OPTIONS, String(got));
    }
    ok("F: the Fallback row shows its own pick", (await shown(kindSel(page, "Fallback"))) === "Options");
    ok(`F: the Fallback row's empty choice still reads "${NOT_MAPPED}"`, (await emptyText(kindSel(page, "Fallback"))) === NOT_MAPPED, String(await emptyText(kindSel(page, "Fallback"))));
    ok(`F: Discount still reads "${NOT_MAPPED}" (the push never bills it as an item)`, (await shown(kindSel(page, "Discount"))) === NOT_MAPPED, String(await shown(kindSel(page, "Discount"))));
    ok("F: a style override still reads \"— use default —\"", (await shown(subSel(page, "Barn"))) === "— use default —", String(await shown(subSel(page, "Barn"))));
    ok("F: a mapped row still shows its item", (await shown(subSel(page, "Loft Area"))) === "Options" && (await shown(kindSel(page, "Doors"))) === "Doors");
    await page.locator("xpath=//div[div[normalize-space(.)='Taller walls']]").scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: join(SHOTS, "before-chore.png") }).catch(() => {});

    // G: the chore. The banner is caught by an observer rather than polled: it can clear quickly.
    await page.evaluate(() => {
      window.__qboSeen = [];
      new MutationObserver(() => window.__qboSeen.push(document.body.innerText.match(/Mappings updated[^\n]*/)?.[0] ?? ""))
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    for (const [, label] of CHORE_KINDS) await kindSel(page, label).selectOption({ label: "Options" });
    for (const [, label] of CHORE_LAYOUT) await subSel(page, label).selectOption({ label: "Options" });
    ok("G: the grid says there are unsaved changes", await waitText(page, "Unsaved changes"));
    await page.getByRole("button", { name: "Save mappings", exact: true }).click();
    const sawBanner = await page.waitForFunction(() => window.__qboSeen.includes("Mappings updated (11 saved)."), null, { timeout: 15000 }).then(() => true, () => false);
    ok("G: the banner says \"Mappings updated (11 saved).\"", sawBanner, JSON.stringify(await page.evaluate(() => [...new Set(window.__qboSeen)].filter(Boolean))));
    const save = S.calls.filter((c) => c.action === "save_item_map");
    ok("G: one save was posted", save.length === 1, String(save.length));
    const rows = save[0] ? save[0].rows : [];
    const got = rows.map((r) => `${r.lineKind}|${r.itemKey}|${r.styleId}|${r.qboItemId}|${r.qboItemName}`).sort();
    const want = [
      ...CHORE_KINDS.map(([k]) => `${k}||null|${OPTIONS}|Options`),
      ...CHORE_LAYOUT.map(([k]) => `layout_item|${k}|null|${OPTIONS}|Options`),
    ].sort();
    ok("G: it posted exactly the eleven rows, each as Options", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    ok("G: Delivery was not posted", !rows.some((r) => r.lineKind === "delivery"));
    // What lets save_item_map refuse a page left open across a company switch.
    ok("G: the save carries the company tag the grid was loaded with", save[0] && save[0].companyTag === TAG, JSON.stringify(save[0] && save[0].companyTag));
    ok("G: nothing already mapped was re-posted", !rows.some((r) => ["building", "door", "custom_option", "fallback"].includes(r.lineKind) || ["loft", "roughOpening", "workbench"].includes(r.itemKey)));
    // The grid reloads from list_item_map after a save.
    await page.waitForFunction(() => !document.body.innerText.includes("Unsaved changes"), null, { timeout: 10000 }).catch(() => {});
    let after = true;
    for (const [, label] of CHORE_KINDS) after = after && (await shown(kindSel(page, label))) === "Options";
    for (const [, label] of CHORE_LAYOUT) after = after && (await shown(subSel(page, label))) === "Options";
    ok("G: after the reload the eleven rows show Options", after);
    ok(`G: Delivery still reads "${USE_OPTIONS}"`, (await shown(kindSel(page, "Delivery"))) === USE_OPTIONS, String(await shown(kindSel(page, "Delivery"))));
    await page.locator("xpath=//div[div[normalize-space(.)='Delivery']]").scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: join(SHOTS, "after-chore.png") }).catch(() => {});
    clean(S, "E-G");
    await S.ctx.close();
  }

  // ── H: the empty choice follows the Fallback row while it is edited ──
  {
    const S = await open(BEFORE);
    const { page } = S;
    await kindSel(page, "Fallback").selectOption({ label: "Misc" });
    const renamed = await shown(kindSel(page, "Delivery"));
    ok("H: another Fallback item renames it by its own name (leaf, not the category path)", renamed === "— use Fallback (Misc) —", String(renamed));
    ok("H: layout items follow too", (await shown(subSel(page, "Single Shelf"))) === "— use Fallback (Misc) —");
    await kindSel(page, "Fallback").selectOption({ value: "" });
    const cleared = await shown(kindSel(page, "Delivery"));
    ok(`H: clearing the Fallback turns Delivery back to "${NOT_MAPPED}"`, cleared === NOT_MAPPED, String(cleared));
    ok(`H: and the layout items`, (await shown(subSel(page, "Double Shelf"))) === NOT_MAPPED);
    ok("H: nothing was saved by editing", !S.calls.some((c) => c.action === "save_item_map"));
    clean(S, "H");
    await S.ctx.close();
  }

  // ── I: no Fallback saved ──
  {
    const S = await open(BEFORE.filter((m) => m.line_kind !== "fallback"));
    const { page } = S;
    const got = await shown(kindSel(page, "Delivery"));
    ok(`I: with no Fallback, unmapped Delivery reads "${NOT_MAPPED}"`, got === NOT_MAPPED, String(got));
    ok(`I: and so does an unmapped layout item`, (await shown(subSel(page, "Rough Opening (Window)"))) === NOT_MAPPED);
    clean(S, "I");
    await S.ctx.close();
  }
} finally {
  await browser.close();
}

const bad = failed();
console.log(`screenshots: ${SHOTS}`);
console.log(bad.length ? `\n${bad.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(bad.length ? 1 : 0);
