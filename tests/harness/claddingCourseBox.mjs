// The lap "Course (in)" box (Settings → Options → Cladding, migration 275), driven for real on the
// COMPILED portal. A builder asked for "an option for 4.5" vinyl siding": they type 4.5 on the Lap
// Siding row and the 3D draws the boards at that size (tests/harness/lapCourses.mjs).
//
//   A. a current server (catalog says claddingCourses: true): a "Course (in)" column, ONE box in it,
//      on the Lap Siding row only, placeholder 6, holding what is stored; the card's intro says what
//      it is in plain words
//   B. typing 4.5 and pressing Save sends exposureIn "4.5" on the lap row and on no other row; the
//      re-read shows 4.5; clearing it sends "" (the 3D's 6 in); 2 or 13 is refused on screen with a
//      sentence and NOTHING is sent
//   C. a database without 275 (claddingCourses: false) or a server older than this page (no key):
//      no column, no box, and Save sends no exposureIn on any row, so it can never write a size
//   D. zero page errors
//
// The stub answers save_cladding with portal-settings' rule. Supabase is stubbed at the network
// layer; nothing leaves the machine and NOTHING IS SAVED anywhere.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/claddingCourseBox.mjs        (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/cladding-course-box (SS_SHOTS overrides). Against the portal before
// this change (git archive 135699d, served as SS_BASE) A1 and A2 fail and the run stops at A3, which
// has no box to read: an older page has no Course column at all.
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "acme-sheds";
const STYLE = "11111111-1111-4111-8111-111111111111";
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
const REFUSED_ON_SCREEN = "Nothing was saved — the lap course has to be between 3 and 12 inches (leave it blank for 6).";

const { ok, failed } = reporter();
const shots = shotsDir("cladding-course-box");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

/** `server`: "new" answers claddingCourses true; "no275" false (a database without the column);
 *  "old" predates the key. `exposure` is the lap row's stored size. */
async function scenario(browser, { name, server = "new", exposure = null }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const state = { exposure };
  const rows = () => [
    { id: "r1", style_id: STYLE, cladding_id: "panel", label_override: null, rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 0 },
    { id: "r2", style_id: STYLE, cladding_id: "lap", label_override: "Vinyl Siding", rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 1 },
  ].map((r) => (server === "new" ? { ...r, exposure_in: r.cladding_id === "lap" ? state.exposure : null } : r));
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
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
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, clientId: CLIENT,
        entitlement: { granted: ["view_3d"], paid: [], features: { crm: true }, status: "active" } });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: OWNER_ACCESS, prefs: null,
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false,
          businessName: "Acme Sheds", businessPhone: "(555) 010-0100", businessAddress: {}, quoteTerms: "Deposit due at signing.",
          quoteValidDays: 30, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "catalog": {
        const cat = { ok: true, clientId: CLIENT, styles: [{ id: STYLE, key: "deluxe", label: "Deluxe Gable", active: true }], sizes: [], items: [],
          inclusions: [], layoutPricing: [], colors: [], fixtures: [], windowColors: [], wallHeights: [], cladding: rows(), insulation: [],
          electrical: null, electricalItems: [], foundation: [], insulationEnabled: false, rampSettings: {}, aiReady: false, wallet: null };
        if (server === "new") cat.claddingCourses = true;
        if (server === "no275") cat.claddingCourses = false;
        return json(route, cat);
      }
      case "save_cladding": {
        // portal-settings' rule (claddingExposureWiring_test): a size on lap only, 3..12, blank = NULL.
        const skipped = [];
        for (const r of body.rows || []) {
          if (!("exposureIn" in r)) continue;
          const t = String(r.exposureIn == null ? "" : r.exposureIn).trim();
          if (t !== "" && r.claddingId !== "lap") { skipped.push(`${r.claddingId}: only lap siding takes a course size`); continue; }
          if (t !== "" && !(Number(t) >= 3 && Number(t) <= 12)) { skipped.push(`lap: "${t}" is not a course size from 3 to 12 inches`); continue; }
          if (r.claddingId === "lap") state.exposure = t === "" ? null : Number(t);
        }
        return json(route, { ok: true, saved: (body.rows || []).length - skipped.length, skipped });
      }
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { history.pushState({}, "", "/portal/settings/cladding"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction(() => document.body.innerText.includes("Deluxe Gable") && document.body.innerText.includes("Shown as"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page, calls, state };
}

const courseHeader = (page) => page.locator("th", { hasText: /^Course \(in\)$/ });
const courseBoxes = (page) => page.locator('input[aria-label$="lap siding course, inches"]');
const saveBtn = (page) => page.getByRole("button", { name: /^Save$/ });
const saves = (s) => s.calls.filter((c) => c.action === "save_cladding");
const bodyText = (page) => page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
const waitText = (page, t, timeout = 6000) => page.waitForFunction((x) => document.body.innerText.includes(x), t, { timeout }).then(() => true, () => false);
async function save(s) {
  const before = saves(s).length;
  await saveBtn(s.page).first().click({ timeout: 3000 });
  await s.page.waitForTimeout(900);
  return saves(s).slice(before);
}
const rowOf = (sent, id) => (sent[0] && sent[0].rows || []).find((r) => r.claddingId === id) || null;

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  // ── A + B on a current server ──
  {
    const s = await scenario(browser, { name: "new" });
    const loaded = ok("A0 the Cladding card rendered", (await bodyText(s.page)).includes("Deluxe Gable"));
    if (!loaded) throw new Error("the Cladding card never rendered; refusing to report the rest as passes");
    ok("A1 a 'Course (in)' column, with ONE box in it", (await courseHeader(s.page).count()) === 1 && (await courseBoxes(s.page).count()) === 1);
    const lapRowText = await courseBoxes(s.page).first().locator("xpath=ancestor::tr").innerText({ timeout: 3000 }).catch(() => "");
    ok("A2 the box is on the Lap Siding row", /^Lap Siding/.test(lapRowText.trim()), lapRowText.replace(/\s+/g, " "));
    ok("A3 empty, its placeholder 6 (the 3D's standard)", (await courseBoxes(s.page).inputValue()) === "" && (await courseBoxes(s.page).getAttribute("placeholder")) === "6");
    ok("A4 the intro says what it is, in plain words", (await bodyText(s.page)).includes("you can also set the course: how much of each board shows, in inches"));
    // The designer reads the size on the customer's Lap Siding pick only (d3CladdingExposureIn), not
    // on a style whose own standard siding is lap, so the copy says when it applies.
    ok("A4b and when the 3D uses it: when a customer picks Lap Siding",
      (await bodyText(s.page)).includes("When a customer picks Lap Siding, the 3D draws the boards at that size")
        && /When a customer picks Lap Siding/.test(await courseHeader(s.page).getAttribute("title").catch(() => "") || ""));

    await courseBoxes(s.page).fill("4.5");
    let sent = await save(s);
    ok("B1 Save sends exposureIn \"4.5\" on the lap row", sent.length === 1 && rowOf(sent, "lap") && rowOf(sent, "lap").exposureIn === "4.5", JSON.stringify(sent));
    ok("B2 and on no other row", sent.length === 1 && sent[0].rows.filter((r) => r.claddingId !== "lap").every((r) => !("exposureIn" in r)), JSON.stringify(sent[0] && sent[0].rows));
    ok("B3 the screen says it saved", await waitText(s.page, "Deluxe Gable: saved."));
    ok("B4 the re-read shows 4.5", (await courseBoxes(s.page).inputValue()) === "4.5" && s.state.exposure === 4.5, await courseBoxes(s.page).inputValue());
    await s.page.screenshot({ path: join(shots, "B-course-4.5.png") }).catch(() => {});

    for (const bad of ["2", "13"]) {
      await courseBoxes(s.page).fill(bad);
      sent = await save(s);
      ok(`B5 ${bad} in is refused on screen, and nothing is sent`, sent.length === 0 && await waitText(s.page, REFUSED_ON_SCREEN), JSON.stringify(sent));
    }
    await courseBoxes(s.page).fill("");
    sent = await save(s);
    ok("B6 cleared, Save sends exposureIn \"\" (back to 6 in)", sent.length === 1 && rowOf(sent, "lap").exposureIn === "" && s.state.exposure === null, JSON.stringify(rowOf(sent, "lap")));
    await s.ctx.close();
  }

  // ── A builder who already set it: it loads ──
  {
    const s = await scenario(browser, { name: "set", exposure: 4.5 });
    ok("A5 a stored 4.5 loads in the box", (await courseBoxes(s.page).count()) === 1 && (await courseBoxes(s.page).inputValue()) === "4.5");
    await s.ctx.close();
  }

  // ── C. a database without 275, and a server older than this page ──
  for (const server of ["no275", "old"]) {
    const s = await scenario(browser, { name: server, server });
    ok(`C ${server}: the Cladding card rendered`, (await bodyText(s.page)).includes("Deluxe Gable"));
    ok(`C ${server}: no Course column and no box`, (await courseHeader(s.page).count()) === 0 && (await courseBoxes(s.page).count()) === 0);
    ok(`C ${server}: the intro does not mention it`, !(await bodyText(s.page)).includes("you can also set the course"));
    const sent = await save(s);
    ok(`C ${server}: Save still saves, and sends no exposureIn on any row`, sent.length === 1 && sent[0].rows.every((r) => !("exposureIn" in r)), JSON.stringify(sent));
    if (server === "no275") await s.page.screenshot({ path: join(shots, "C-no275.png") }).catch(() => {});
    await s.ctx.close();
  }
} catch (e) {
  ok("ran", false, e && e.message ? e.message.split("\n")[0] : String(e));
} finally {
  await browser.close();
}

ok("D zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
console.log(`\nSHOTS ${shots}`);
const bad = failed();
console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL CHECKS PASSED");
process.exit(bad.length ? 1 : 0);
