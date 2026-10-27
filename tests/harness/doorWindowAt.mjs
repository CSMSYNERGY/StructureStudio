// "Use in doors": the window catalog's select for where a window goes in a door, driven for real on
// the COMPILED portal (fixture_items.door_window_at, 2026-10-21: the TRANSOM, Yoder Barns' request).
//
// Until now a window had one tick, "Can be used inside a door" (in_door, 289), which put it in the
// upper panel of the four built doors. It is now one select: No / In the door's upper panel / As a
// transom at the top of the door (door_window_at 'top').
//
//   A. the Windows list says how each window goes in doors: "can go in a door" (the upper panel),
//      "transom in doors" (a transom), nothing for a window only on walls
//   B. the edit panel's select reads each row's stored answer, with the hint that matches it
//   C. a wall window set "As a transom" saves inDoor true + doorWindowAt "top"
//   D. a transom set to "No" saves inDoor false + doorWindowAt "panel" (portal-settings and the
//      column's check both refuse 'top' on a window that is not in doors)
//   E. a price-only edit of a panel window still sends inDoor true + doorWindowAt "panel", so the
//      position rides every save as the tick always did
//   F. THE GRID (335, in place of 324's Panes): the window editor's Grid (lites), set there ONLY since
//      Carolyn's 10-27 call ("The customer can't select the grid"), with the picker the designer had: No
//      grid, rows and lites across (1 to 8) with a drawing and its name, and Standard; a save sends
//      liteRows / liteCols, the list line says "6-lite" or "no grid", Standard sends null and says
//      nothing, and a new window starts at 1 x 1
//
// Supabase is stubbed at the network layer; nothing leaves the machine and NOTHING IS SAVED. The
// tenant and its windows are made up, per the public-repo rule.
//
//   python -m http.server 8412 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8412 node tests/harness/doorWindowAt.mjs   (exit 0 = every check held)
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const { ok, failed } = reporter();
const shots = shotsDir("door-window-at");
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const CORS = { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
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
const WALL = "00000000-0000-4000-8000-0000000000c1", LITE = "00000000-0000-4000-8000-0000000000c2", TOP = "00000000-0000-4000-8000-0000000000c3";
const winRow = (id, name, w, h, price, inDoor, at, sort) => ({ id, category: "window", name, plan_label: null, width_in: w, height_in: h, price,
  swing_in: false, swing_out: false, swing_default: null, op_right: false, op_left: false, op_double: false, op_slideup: false, op_default: null,
  color_mode: "fixed", has_trim_color: false, fixed_color_id: null, window_color_ids: null, in_door: inDoor, door_window_at: at, in_partition: true,
  style_ids: null, sill_in: null, sill_mode: "fixed", door_style: "auto", image_url: null, show_image_on_estimate: true, sort_order: sort,
  active: true, archived: false, internal_only: false, taxable: true });

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const saves = [];
  const stored = [
    winRow(WALL, "Wall window", 24, 36, 120, false, "panel", 0),
    winRow(LITE, "Door lite", 18, 24, 95, true, "panel", 1),
    winRow(TOP, "Transom Windows", 29, 10, 81, true, "top", 2),
  ];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
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
        return json(route, { ok: true, clientId: CLIENT, sizes: [], items: [], inclusions: [], layoutPricing: [], colors: [], windowColors: [], wallHeights: [], insulation: [],
          styles: [{ id: "00000000-0000-4000-8000-0000000000a1", key: "utility", label: "Utility", active: true }], fixtures: stored });
      case "save_fixture": {
        saves.push(body);
        // The row as portal-settings would now read it back.
        const at = stored.findIndex((r) => r.id === body.id);
        if (at >= 0) stored[at] = { ...stored[at], in_door: body.inDoor === true, door_window_at: body.inDoor === true && body.doorWindowAt === "top" ? "top" : "panel", price: Number(body.price), lite_rows: body.liteRows ?? null, lite_cols: body.liteCols ?? null };
        return json(route, { ok: true, id: body.id });
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
    await page.evaluate(() => { history.pushState({}, "", "/settings/windows"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await page.waitForFunction(() => document.body.innerText.includes("Transom Windows"), null, { timeout: 20000 }).catch(() => {});
    await settle(page, 600);
    const rowOf = (name) => page.locator("[draggable]").filter({ has: page.getByText(name, { exact: true }) }).first();
    const loaded = ok("A the Windows list rendered", await rowOf("Transom Windows").count() > 0);
    if (!loaded) throw new Error("the list never rendered; refusing to report the rest as passes");
    const sum = async (name) => (await rowOf(name).innerText()).replace(/\s+/g, " ");
    ok("A the panel window's line says \"can go in a door\"", (await sum("Door lite")).includes("can go in a door"), await sum("Door lite"));
    ok("A the transom's line says \"transom in doors\"", (await sum("Transom Windows")).includes("transom in doors") && !(await sum("Transom Windows")).includes("can go in a door"), await sum("Transom Windows"));
    ok("A a wall window's line says nothing of doors", !/door/.test(await sum("Wall window")), await sum("Wall window"));

    const sel = page.locator("select[data-ss-door-window-at]");
    const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
    // B + C: the wall window, set as a transom.
    await rowOf("Wall window").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("B the select is there, reading No for a window only on walls", (await sel.count()) === 1 && (await sel.inputValue()) === "no", await sel.inputValue().catch(() => "missing"));
    ok("B ...with the three choices", JSON.stringify(await sel.locator("option").allInnerTexts()) === JSON.stringify(["No", "In the door's upper panel", "As a transom at the top of the door"]),
      JSON.stringify(await sel.locator("option").allInnerTexts()));
    ok("B ...and the walls-only hint", (await bodyText()).includes("Only on the walls. Choose a door option to offer it inside doors as well."));
    await sel.selectOption("top");
    await settle(page, 200);
    ok("C choosing As a transom names the doors it goes in", (await bodyText()).includes("as a transom across the top of the doors it fits"));
    await page.screenshot({ path: join(shots, "C-transom-chosen.png") });
    let n = saves.length;
    await page.getByRole("button", { name: "Save window", exact: true }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("C the save sends inDoor true and doorWindowAt \"top\"", saves.length === n + 1 && saves[n].inDoor === true && saves[n].doorWindowAt === "top",
      JSON.stringify(saves[n] && { inDoor: saves[n].inDoor, doorWindowAt: saves[n].doorWindowAt }));
    ok("C ...and the line now says \"transom in doors\"", (await sum("Wall window")).includes("transom in doors"), await sum("Wall window"));

    // D: the transom, set to No.
    await rowOf("Transom Windows").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("D the transom's select reads As a transom", (await sel.inputValue()) === "top");
    await sel.selectOption("no");
    n = saves.length;
    await page.getByRole("button", { name: "Save window", exact: true }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("D No sends inDoor false and doorWindowAt \"panel\"", saves.length === n + 1 && saves[n].inDoor === false && saves[n].doorWindowAt === "panel",
      JSON.stringify(saves[n] && { inDoor: saves[n].inDoor, doorWindowAt: saves[n].doorWindowAt }));

    // E: the panel window, price only.
    await rowOf("Door lite").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("E the panel window's select reads In the door's upper panel, with its hint", (await sel.inputValue()) === "panel"
      && (await bodyText()).includes("Offered in the door picker for the American, Basic, Classic and Dutch doors it fits."));
    await page.screenshot({ path: join(shots, "E-panel.png") });
    await page.locator('input[type="number"][placeholder="0"]').first().fill("99");
    n = saves.length;
    await page.getByRole("button", { name: "Save window", exact: true }).click();
    for (let i = 0; i < 20 && saves.length === n; i++) await settle(page, 200);
    await settle(page, 400);
    ok("E a price-only save still sends inDoor true and doorWindowAt \"panel\"", saves.length === n + 1 && String(saves[n].price) === "99"
      && saves[n].inDoor === true && saves[n].doorWindowAt === "panel", JSON.stringify(saves[n] && { price: saves[n].price, inDoor: saves[n].inDoor, doorWindowAt: saves[n].doorWindowAt }));
    // F: the grid of lites (335, in place of 324's Panes), set HERE only since Carolyn's 10-27 call: the
    // designer's picker (No grid, rows and lites across, a drawing, its name) and Standard; a save that
    // sends both, and the line that names it.
    const grid = page.locator("[data-ss-window-grid]");
    const pic = () => grid.locator("[data-ss-window-lite-pic]").getAttribute("data-ss-window-lite-pic").catch(() => null);
    const chipOn = async (k) => ((await grid.locator(`[data-ss-lites-chip="${k}"]`).getAttribute("style").catch(() => "")) || "").includes("224, 242, 254");
    const saveWindow = async () => {
      const k = saves.length;
      await page.getByRole("button", { name: "Save window", exact: true }).click();
      for (let i = 0; i < 20 && saves.length === k; i++) await settle(page, 200);
      await settle(page, 400);
      return k;
    };
    await rowOf("Door lite").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("F the Grid reads Standard for a window that never set one, drawn dashed", (await grid.count()) === 1 && (await pic()) === "auto" && (await chipOn("standard")), `${await pic()}`);
    ok("F ...with the designer's picker, not dropdowns: No grid, rows, across, Standard",
      (await grid.locator("select").count()) === 0 && /No grid/.test(await grid.innerText()) && /across/.test(await grid.innerText()) && /Standard/.test(await grid.innerText())
      && (await grid.getByRole("button", { name: "More rows" }).count()) === 1 && (await grid.getByRole("button", { name: "More across" }).count()) === 1,
      (await grid.innerText().catch(() => "")).replace(/\s+/g, " "));
    ok("F ...says what Standard is, and that customers can't change the grid", (await bodyText()).includes("Standard is the look windows had before")
      && (await bodyText()).includes("they can't change it in the designer"));
    await grid.getByRole("button", { name: "More rows" }).click();
    await settle(page, 150);
    await grid.getByRole("button", { name: "More rows" }).click();
    await settle(page, 150);
    await grid.getByRole("button", { name: "More across" }).click();
    await settle(page, 200);
    ok("F two more rows and one more across: a 3 x 2 grid that says 6-lite", (await pic()) === "3x2"
      && (await bodyText()).includes("6-lite: 3 rows of 2, all the same size.") && /6-lite \(3 rows of 2\)/.test(await grid.innerText()), `${await pic()}`);
    await page.screenshot({ path: join(shots, "F-lites.png") });
    n = await saveWindow();
    ok("F the save sends liteRows 3 and liteCols 2, and no panes", saves.length === n + 1 && saves[n].liteRows === 3 && saves[n].liteCols === 2 && !("panes" in saves[n]),
      JSON.stringify(saves[n] && { liteRows: saves[n].liteRows, liteCols: saves[n].liteCols, panes: saves[n].panes }));
    ok("F ...and the line says \"6-lite\"", (await sum("Door lite")).includes("6-lite"), await sum("Door lite"));
    await rowOf("Door lite").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    ok("F the editor reads the saved grid back", (await pic()) === "3x2", `${await pic()}`);
    await grid.locator('[data-ss-lites-chip="plain"]').click();
    await settle(page, 200);
    ok("F No grid draws one lite and says no grid", (await pic()) === "1x1" && (await chipOn("plain")) && (await bodyText()).includes("No grid: one clear lite."));
    n = await saveWindow();
    ok("F ...saves 1 and 1, and the line says \"no grid\"", saves.length === n + 1 && saves[n].liteRows === 1 && saves[n].liteCols === 1 && (await sum("Door lite")).includes("no grid"),
      JSON.stringify(saves[n] && { liteRows: saves[n].liteRows, liteCols: saves[n].liteCols }) + " " + (await sum("Door lite")));
    await rowOf("Door lite").getByRole("button", { name: "Edit" }).click();
    await settle(page, 300);
    await grid.locator('[data-ss-lites-chip="standard"]').click();
    await settle(page, 200);
    n = await saveWindow();
    ok("F Standard sends null and null, and the line says nothing of a grid", saves.length === n + 1 && saves[n].liteRows === null && saves[n].liteCols === null
      && !/lite|grid/.test((await sum("Door lite")).replace(/Door lite/g, "")),
      JSON.stringify(saves[n] && { liteRows: saves[n].liteRows, liteCols: saves[n].liteCols }) + " " + (await sum("Door lite")));
    // A NEW window starts at no grid.
    await page.getByRole("button", { name: /^\+ Add window/ }).first().click().catch(() => {});
    await settle(page, 300);
    ok("F a new window starts at 1 row x 1 across (no grid)", (await grid.count()) === 1 && (await pic()) === "1x1" && (await chipOn("plain")), `${await pic()}`);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
  }
}

const { browser } = await launch({ width: 1400, height: 1000 });
try { await run(browser); } catch (e) { ok("ran to the end", false, String(e.message).split("\n")[0]); }
await browser.close();
const fl = failed();
console.log(fl.length ? `${fl.length} FAILED` : "ALL CHECKS PASSED");
process.exit(fl.length ? 1 : 0);
