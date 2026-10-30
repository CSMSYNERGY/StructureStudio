// THE SIZES & PRICES TABLE (/settings/sheds-table, build plan Phase 2: the shell and the read-only
// grid), driven for real on the COMPILED portal. Phase 5 extends this file with the editing cases.
//
//   A  THE SHEDS CARD: retitled "Sizes, prices & included options"; "Open sizes & prices table ↗" is a
//      real anchor to /settings/sheds-table (target=_blank, rel=noopener); a "Prefer Excel?" row holds
//      Download and Upload; the warning sentence is in the instructions. An upload's answer draws
//      UNDER the buttons. Download reads catalog + size_table fresh (targetClientId on both bodies)
//      and the sheet is built from size_table; when the counts never add up it is refused. Add style's
//      answer links to the table with ?style=<new id>.
//   B  THE NEW TAB: the link opens a tab whose cold load renders the table with no page error (no
//      React #310): its title, Back link, legend, three style bands, every size row; ?style= jumps to
//      that style and leaves the address.
//   C  HEADERS AT 1280 AND 1440: no option name is cut (each standing name fits its box in two lines
//      at most, and no header cell overflows), and a two-line name reads in order when the head is
//      tilted (its first line is the RIGHT one); "480" and "1200" fit a 44 px box; the header and the
//      frozen Size/Price/Offered stay pinned on both scroll axes; the page itself never scrolls. Run on
//      the 25-column fixture and again on the plan's 210 sizes x 38 columns. A header screenshot is
//      kept at each width (SS_PG_HEADER_SHOTS names a folder for them).
//   D  THE GRID: the active-column readout follows a click and the arrows; aria-selected moves;
//      "Show hidden sizes" folds hidden rows and is remembered; Jump to style scrolls the band under
//      the header; ARIA roles and counts.
//   E  STATES: a slow size_table shows the skeleton and "Loading…"; a failed one says "Couldn't load
//      your sizes." and Retry recovers; no styles says so; no option columns shows the Options box;
//      a count that never adds up reads twice and opens view-only "too big".
//   F  VIEW-AS: an operator's cold ?view=<builder> load says "Opening <builder>…" and reads nothing
//      while the operator check is out, then makes every table read for that builder (targetClientId
//      on every body) and draws the red operator strip with the builder's name; ?as= opens view-only; a
//      non-operator holding ?view= is told after 10 s that the account could not be opened, and no
//      table read ever goes out; a view-only access map opens view-only; a billing lock shows the lock.
//   G  NARROW (390 px): the page does not scroll sideways, the header is at most 90 px, at least 8 rows
//      show.
//   T  TIMING (always printed, never a failure): first render and arrow-key time at 1x (210 sizes x 38
//      columns, about 8,000 cells) and 3x (630 x 38, about 24,000).
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Every style, size,
// option and account here is made up; this repo is public.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/pricingTable.mjs            (exit 0 = every check held)
//
// SS_BASE=http://127.0.0.1:<port> points it at another port. SKIP_TIMING=1 skips T; PG_ONLY=C,F runs
// only those sections. SHOTS go to %TEMP%/ss-harness/pricing-table unless SS_SHOTS says otherwise;
// the header pictures for Carolyn (C, at 1280 and 1440) go to SS_PG_HEADER_SHOTS when it is set.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { ok, failed } = reporter();
const shots = shotsDir("pricing-table");
const headerShots = process.env.SS_PG_HEADER_SHOTS || shots;
mkdirSync(headerShots, { recursive: true });
// PG_ONLY=C,T runs those sections alone (the server check always runs).
const ONLY = (process.env.PG_ONLY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);

// ── The server at BASE is this checkout (the Windows double-bind trap) ─────────────────────────
{
  const vOf = (html) => (/portal\.app\.compiled\.js\?v=([a-f0-9]+)/.exec(html) || [])[1] || null;
  const localV = vOf(readFileSync(join(ROOT, "portal.html"), "utf8"));
  let servedV = null, servedHash = null;
  try { servedV = vOf(await (await fetch(`${BASE}/portal.html`, { cache: "no-store" })).text()); } catch (_e) { /* not up */ }
  try { servedHash = createHash("sha256").update(Buffer.from(await (await fetch(`${BASE}/portal.app.compiled.js`, { cache: "no-store" })).arrayBuffer())).digest("hex").slice(0, 8); } catch (_e) { /* not up */ }
  ok(`Server: ${BASE} serves this checkout's portal (?v=${localV})`, !!localV && servedV === localV && servedHash === localV, `served ?v=${servedV}, sha ${servedHash}`);
}

// ── Made-up fixtures ─────────────────────────────────────────────────────────────────────────
const OWN = "harness-barns";
const OPS = "harness-ops";
const VIEWED = "harness-viewed";
const COMPANY = { [OWN]: "Harness Barns Co", [OPS]: "Harness Operators", [VIEWED]: "Harness Viewed Sheds" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000a1", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: { full_name: "Pat Example" }, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const WEAR = "00000000-0000-4000-8000-0000000000b2";   // a made-up team member an operator wears
const LONG = "Double Door with Transom and Kickplate (6'x7')";   // 46 characters with its size

const hex = (n, w = 12) => n.toString(16).padStart(w, "0");
const uid = (kind, n) => `${kind}0000000-0000-4000-8000-${hex(n)}`;

// The option columns: built-ins (catalog items) and catalog fixtures. `extra` adds generated doors
// for the timing fixture (38 columns).
function catalogFor(clientId, { cols = "full", extra = 0, items = null } = {}) {
  const ITEMS = [
    { key: "loft", label: "Loft (sq ft)" }, { key: "workbench", label: "Workbench" }, { key: "shelving", label: "Shelving" },
    { key: "electricalPackage", label: "Electrical Package" }, { key: "floorInsulation", label: "Floor Insulation" },
    { key: "upgradedFlooring", label: "Upgraded Flooring (sq ft)" },
    { key: "ramp", label: "Ramp" }, { key: "partitionWall", label: "Partition wall" }, { key: "oldThing", label: "Old Thing", archived: true },
  ];
  let id = 100;
  const fx = (name, category, w, h) => ({ id: ++id, name, category, width_in: w, height_in: h, active: true, archived: false });
  const FIX = [
    fx("Single Door", "door", 36, 76), fx("Double Door", "door", 72, 76), fx("Double Door with Transom and Kickplate", "door", 72, 84),
    fx("Roll-Up Door", "door", 96, 84), fx("Roll-Up Door", "door", 108, 96), fx("Steel Entry Door with Half Glass", "door", 36, 80),
    fx("Barn Style Double Door", "door", 60, 72), fx("Garage Door Heavy Duty Insulated", "door", 120, 96),
    fx("Window", "window", 24, 36), fx("Window", "window", 36, 48), fx("Transom Window", "window", 48, 12),
    fx("Insulated Window with Grids", "window", 36, 36), fx("Horizontal Slider Window", "window", 48, 24), fx("Shutter Window", "window", 24, 36),
    fx("Gable Vent", "vent", 12, 12), fx("Ridge Vent Kit", "vent", null, null), fx("Soffit Vent", "vent", 12, 12),
    fx("Ramp Kit", "ramp", 48, 6), fx("Wide Ramp Kit", "ramp", 72, 12),
    { id: 999, name: "Retired Door", category: "door", active: false, archived: false },
  ];
  for (let i = 0; i < extra; i++) FIX.push(fx(`Extra Door Option ${i + 1} with Trim`, "door", 36 + i, 80));
  const it = items || (cols === "none" ? [] : ITEMS);
  const fixtures = cols === "none" ? [] : FIX;
  return { ok: true, clientId, items: it, fixtures, styles: [], sizes: [], inclusions: [], layoutPricing: [], colors: [], windowColors: [], wallHeights: [], cladding: [], insulation: [] };
}
// Option keys in column order, as ssPricingColumns builds them (built-ins, then doors, windows, vents, ramps).
const OPTION_KEYS = (cat) => {
  const layout = cat.items.filter((x) => !x.archived && x.key !== "ramp" && x.key !== "partitionWall").map((x) => x.key);
  const fx = cat.fixtures.filter((f) => f.active !== false && !f.archived);
  const by = (c) => fx.filter((f) => (f.category || "door") === c).map((f) => String(f.id));
  return [...layout, ...by("door"), ...by("window"), ...by("vent"), ...by("ramp")];
};

// Styles and sizes. `scale` multiplies the sizes per style (the timing fixtures).
function tableFor(clientId, cat, { styles = 3, perStyle = null, hiddenStyle = false, noStyles = false } = {}) {
  if (noStyles) return { ok: true, clientId, rtpOn: false, styles: [], sizes: [], inclusions: [], counts: { sizes: 0, inclusions: 0 } };
  const NAMES = ["Test Barn", "Test Lofted Barn", "Test Utility Shed"];
  const st = [];
  for (let i = 0; i < styles; i++) st.push({ id: uid("5", i + 1), key: `test-${i + 1}`, label: NAMES[i] || `Test Style ${i + 1}`, code: `T${i + 1}`, active: true, sort_order: i });
  if (hiddenStyle) st.push({ id: uid("5", 90), key: "test-hidden", label: "Test Retired Style", code: "TR", active: false, sort_order: 9 });
  const GRIDS = [[[8, 10, 12], [12, 16, 20, 24]], [[10, 12, 14], [16, 20, 24, 28, 32]], [[6, 8, 10], [8, 10, 12, 14, 16]]];
  const keys = OPTION_KEYS(cat);
  const sizes = [], incs = [];
  let n = 0;
  st.forEach((s, si) => {
    const [ws, ls] = GRIDS[si % 3];
    const want = perStyle || ws.length * ls.length;
    for (let k = 0; k < want; k++) {
      const w = ws[k % ws.length], l = ls[Math.floor(k / ws.length) % ls.length] + 4 * Math.floor(k / (ws.length * ls.length));
      n++;
      const unpriced = n % 11 === 0, untick = n % 13 === 0;
      const price = unpriced ? null : 1200 + w * l * 9 + (n % 3 === 0 ? 0.5 : 0);
      const id = uid("7", n);
      sizes.push({ id, style_id: s.id, label: `${w}x${l}`, width_ft: w, length_ft: l, base_price: price, active: !unpriced && !untick,
        sort_order: k, created_at: "2026-10-01T00:00:00.000001+00:00", updated_at: `2026-10-20T00:00:00.${String(100000 + n)}+00:00` });
      // A few included options per size; Loft carries 480 and Upgraded Flooring 1200 (the widest numbers).
      if (n % 2 === 0) incs.push({ size_id: id, item_key: "loft", included: true, qty: 480 });
      if (n % 5 === 0) incs.push({ size_id: id, item_key: "upgradedFlooring", included: true, qty: 1200 });
      if (n % 3 === 0) incs.push({ size_id: id, item_key: keys[6 + (n % Math.max(1, keys.length - 6))] || "workbench", included: true, qty: 1 });
      if (n % 7 === 0) incs.push({ size_id: id, item_key: "workbench", included: false, qty: 2 });
    }
  });
  return { ok: true, clientId, rtpOn: false, styles: st, sizes, inclusions: incs, counts: { sizes: sizes.length, inclusions: incs.length } };
}

// ── The fake backend ─────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome", headless: !process.env.HEADED });
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// S: { own, operator, operatorDelayMs (is_operator answers late), role, access, locked, cat(clientId),
//      table(clientId), sizeTableDelayMs, sizeTableFailures, countSkew (size_table answers with counts
//      that never add up), createdStyleId }
async function open(path, S0 = {}, { width = 1440, height = 900 } = {}) {
  const S = { own: OWN, operator: false, operatorDelayMs: 0, role: "owner", access: null, locked: false, sizeTableDelayMs: 0, sizeTableFailures: 0, countSkew: false, ...S0 };
  S.cat = S.cat || ((cid) => catalogFor(cid));
  S.table = S.table || ((cid) => tableFor(cid, S.cat(cid)));
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: true });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const calls = [];
  const errors = [];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "is_operator") {
        if (S.operatorDelayMs) await sleep(S.operatorDelayMs);
        return json(route, !!S.operator);
      }
      if (rpc[1] === "is_support_operator") return json(route, false);
      if (rpc[1] === "can_open_projects") return json(route, false);
      return json(route, null);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: S.own, role: S.role, user_id: USER.id }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    const fn = /\/(?:functions\/v1\/)?(portal-[a-z]+|operator-portal|support-agent)(?:[/?]|$)/.exec(new URL(url).pathname);
    const name = fn ? fn[1] : null;
    const host = new URL(url).host.includes(".functions.") ? "side" : "main";
    calls.push({ fn: name, action: body.action, body, host, at: Date.now() });
    if (name === "portal-billing") {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], paid: [], features: { crm: true }, status: S.locked ? "past_due" : "active", locked: !!S.locked, reason: S.locked ? "unpaid" : null }, wallet: null });
    }
    if (name === "operator-portal") return json(route, { ok: true, clientId: VIEWED, companyName: COMPANY[VIEWED], designs: [], versions: [], capturedLeads: [], crmContacts: [], crmContactsTotal: 0, clients: [] });
    if (name === "support-agent") return json(route, { ok: true, on: false });
    if (name === "portal-settings") {
      const tenant = body.targetClientId || S.own;
      const a = body.action;
      if (a === "status") return json(route, { ok: true, clientId: tenant, role: S.role, access: S.access, prefs: null, configured: true, branding: { companyName: COMPANY[tenant] || tenant }, businessAddress: {} });
      if (a === "catalog") {
        const c = S.cat(tenant);
        // PricingCsv reads styles off the catalog: hand it size_table's styles.
        const t = S.table(tenant);
        return json(route, { ...c, styles: t.styles.map((s) => ({ ...s, image_url: null, taxable: true, show_image_on_estimate: true })), sizes: t.sizes, inclusions: t.inclusions });
      }
      if (a === "size_table") {
        if (S.sizeTableDelayMs) await sleep(S.sizeTableDelayMs);
        if (S.sizeTableFailures > 0) { S.sizeTableFailures--; return json(route, { error: "Couldn't load your sizes (test)." }, 500); }
        const t = S.table(tenant);
        return json(route, S.countSkew ? { ...t, counts: { sizes: t.sizes.length + 1, inclusions: t.inclusions.length } } : t);
      }
      if (a === "create_style") return json(route, { ok: true, clientId: tenant, styleId: S.createdStyleId || uid("5", 77) });
      if (a === "import_pricing_csv") return json(route, { ok: true, clientId: tenant, imported: 2, created: 1, updated: 1, skipped: [] });
      return json(route, { ok: true, clientId: tenant });
    }
    return json(route, { ok: true });
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Minified React error|#310|Rendered more hooks/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.dismiss());
  if (path) await page.goto(`${BASE}${path}`);
  return { ctx, page, calls, errors, S };
}
const tableCalls = (calls) => calls.filter((c) => c.fn === "portal-settings" && (c.action === "size_table" || (c.action === "catalog" && "targetClientId" in c.body)));
const waitGrid = (page, timeout = 20000) => page.waitForSelector(".ss-pg-grid tbody tr", { timeout });

// ── A: the Sheds card ────────────────────────────────────────────────────────────────────────
if (want("A") || want("B")) {
  const { ctx, page, calls, errors, S } = await open("/settings/sheds");
  await page.waitForSelector("text=Sizes, prices & included options", { timeout: 20000 });
  await page.waitForSelector("text=Open sizes & prices table", { timeout: 20000 });
  const link = page.locator("a", { hasText: "Open sizes & prices table" });
  const attrs = await link.evaluate((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent }));
  ok("A: one 'Open sizes & prices table ↗' anchor", (await link.count()) === 1 && /↗/.test(attrs.text), attrs.text);
  ok("A: it points at /settings/sheds-table, in a new tab, noopener", attrs.href === "/settings/sheds-table" && attrs.target === "_blank" && /noopener/.test(attrs.rel || ""), JSON.stringify(attrs));
  ok("A: the old '(Excel)' title is gone", !(await page.getByText("Pricing & included options (Excel)").count()));
  const row = await page.evaluate(() => {
    const lab = [...document.querySelectorAll("span")].find((s) => s.textContent === "Prefer Excel?");
    const box = lab && lab.parentElement;
    return box ? { text: box.textContent, afterLink: !!(document.querySelector('a[href="/settings/sheds-table"]').compareDocumentPosition(lab) & Node.DOCUMENT_POSITION_FOLLOWING) } : null;
  });
  ok("A: a 'Prefer Excel?' row holds Download and Upload, below the link", !!row && /Download Excel template/.test(row.text) && /Upload filled sheet/.test(row.text) && row.afterLink, JSON.stringify(row));
  ok("A: the warning sentence is in the instructions", await page.getByText("Changed numbers in the table? Download a fresh template before you use Excel again.").count() === 1);

  // Upload: the answer draws under the buttons, in the same card.
  await page.locator('input[type="file"][accept*=".xlsx"]').setInputFiles({ name: "sheet.csv", mimeType: "text/csv", buffer: Buffer.from("style,width,length,price,active\nTest Barn,10,12,1500,yes\nTest Barn,10,16,1700,yes\n") });
  await page.waitForSelector('[data-ss-xl-msg="ok"]', { timeout: 10000 }).catch(() => {});
  const banner = await page.evaluate(() => {
    const b = document.querySelector('[data-ss-xl-msg="ok"]');
    const lab = [...document.querySelectorAll("span")].find((s) => s.textContent === "Prefer Excel?");
    if (!b || !lab) return null;
    const card = lab.closest("div[style*='border-radius: 12px']") || lab.parentElement.parentElement;
    return { text: b.textContent, below: !!(lab.parentElement.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), sameCard: card.contains(b),
      topBanner: [...document.querySelectorAll("div")].some((d) => d !== b && /^Imported/.test(d.textContent || "") && !card.contains(d)) };
  });
  ok("A: the upload's answer draws under the Excel buttons, inside the card", !!banner && /Imported 2 size\(s\)/.test(banner.text) && banner.below && banner.sameCard && !banner.topBanner, JSON.stringify(banner));

  // Download: fresh catalog + size_table, the sheet built from size_table (exceljs is unreachable here,
  // so the card's own fallback hands back a CSV, which is easy to read).
  const before = calls.length;
  const dlP = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await page.getByRole("button", { name: /Download Excel template/ }).click();
  const dl = await dlP;
  const fresh = calls.slice(before).filter((c) => c.fn === "portal-settings");
  ok("A: Download reads catalog and size_table afresh, targetClientId on both bodies",
    fresh.some((c) => c.action === "size_table" && "targetClientId" in c.body) && fresh.some((c) => c.action === "catalog" && "targetClientId" in c.body && c.body.withUnpriced === true),
    fresh.map((c) => `${c.action}:${JSON.stringify(c.body.targetClientId)}`).join(" "));
  let csv = "";
  if (dl) { try { csv = readFileSync(await dl.path(), "utf8"); } catch (_e) { /* no file */ } }
  const lines = csv.trim().split(/\r?\n/);
  const t = S.table(OWN);
  ok("A: the sheet has a row per size, from size_table", lines.length === 1 + t.sizes.length && /^style,width,length,price,Loft \(sq ft\),/.test(lines[0]), `${lines.length} lines; ${lines[0] && lines[0].slice(0, 80)}`);
  ok("A: the sheet's option header carries the long door name whole", lines[0] && lines[0].includes(LONG.replace(/"/g, '""')), lines[0] && lines[0].slice(0, 400));
  ok("A: a size's included 480 and 1200 reach the sheet", lines.some((l) => /,480,/.test(l)) && lines.some((l) => /,1200,/.test(l)));

  // The guard: counts that never add up refuse the download.
  S.countSkew = true;
  const before2 = calls.length;
  const dl2P = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await page.getByRole("button", { name: /Download Excel template/ }).click();
  await page.waitForSelector('[data-ss-xl-msg="err"]', { timeout: 10000 }).catch(() => {});
  const refused = await page.locator('[data-ss-xl-msg="err"]').textContent().catch(() => "");
  ok("A: a read that never adds up is refused, after one more try", /Couldn't read your whole catalog just now/.test(refused || "") && calls.slice(before2).filter((c) => c.action === "size_table").length === 2, refused);
  ok("A: …and nothing was downloaded", !(await dl2P));
  S.countSkew = false;

  // Add style: the answer links to the table, jumped to the new style.
  S.createdStyleId = uid("5", 42);
  await page.getByPlaceholder("Building style name (e.g. Lofted Barn)").fill("Test Garden Shed");
  await page.getByPlaceholder("Serial code *").fill("TGS");
  await page.getByRole("button", { name: "Add style" }).click();
  await page.waitForSelector("text=Open the sizes & prices table", { timeout: 10000 }).catch(() => {});
  const added = await page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent === "Open the sizes & prices table");
    return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), text: a.parentElement.textContent } : null;
  });
  ok("A: Add style's answer links to the table with ?style=<new id>", !!added && added.href === `/settings/sheds-table?style=${uid("5", 42)}` && added.target === "_blank" && /Building style “Test Garden Shed” added\./.test(added.text), JSON.stringify(added));
  await page.screenshot({ path: join(shots, "A-sheds-card.png"), fullPage: true });
  ok("A: no page errors", errors.length === 0, errors.join(" | "));

  // ── B: the new tab ──
  const popupP = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
  await page.getByText("Open sizes & prices table").click();
  const tab = await popupP;
  ok("B: the link opens a new tab", !!tab);
  if (tab) {
    const tabErrors = [];
    tab.on("pageerror", (e) => tabErrors.push(e.message));
    tab.on("console", (m) => { if (m.type() === "error" && /Minified React error|#310/.test(m.text())) tabErrors.push(m.text()); });
    await tab.waitForURL(/sheds-table/, { timeout: 10000 }).catch(() => {});
    const url = new URL(tab.url() || "about:blank");
    ok("B: the new tab's address is /settings/sheds-table", url.pathname === "/settings/sheds-table", tab.url());
    // A tab Chrome opens sends its first request before context routes attach: load it again.
    await tab.goto(`${BASE}/settings/sheds-table`);
    await waitGrid(tab).catch(() => {});
    const t2 = await tab.evaluate(() => ({
      path: location.pathname,
      title: document.title,
      back: (() => { const a = document.querySelector(".ss-pg-back"); return a ? { text: a.textContent, href: a.getAttribute("href") } : null; })(),
      legend: (document.querySelector(".ss-pg-legend") || {}).textContent || "",
      bands: [...document.querySelectorAll(".ss-pg-band b")].map((b) => b.textContent),
      rows: document.querySelectorAll(".ss-pg-grid tbody tr[data-s]").length,
      shell: !!document.querySelector(".ss-shell"),
      badge: (document.querySelector(".ss-pg-badge") || {}).textContent || "",
    }));
    ok("B: the address stays /settings/sheds-table once the shell has settled", t2.path === "/settings/sheds-table", t2.path);
    ok("B: the tab's title names the account", t2.title === `Sizes & prices · ${COMPANY[OWN]} · Structure Studio`, t2.title);
    ok("B: chromeless (no rail, no top bar), with Back to Sheds", !t2.shell && t2.back && /Back to Sheds/.test(t2.back.text) && t2.back.href === "/settings/sheds", JSON.stringify(t2.back));
    ok("B: the legend reads as the plan says", t2.legend === "Empty = not included. A number = how many come included (loft = sq ft). Blank price = size not offered. $0 = free.", t2.legend);
    ok("B: three style bands, in order", JSON.stringify(t2.bands) === JSON.stringify(["Test Barn", "Test Lofted Barn", "Test Utility Shed"]), JSON.stringify(t2.bands));
    ok("B: every size is a row (hidden ones shown by default)", t2.rows === t.sizes.length, `${t2.rows} of ${t.sizes.length}`);
    ok("B: the badge says all changes saved", /^All changes saved · /.test(t2.badge), t2.badge);
    ok("B: no page errors, no React #310", tabErrors.length === 0, tabErrors.join(" | "));
    await tab.close();
  }
  await ctx.close();
}

// ── B2: ?style= jumps and leaves the address ──
if (want("B")) {
  const { ctx, page, errors, S } = await open(`/settings/sheds-table?style=${uid("5", 3)}`, {}, { width: 1440, height: 700 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(300);
  const r = await page.evaluate((id) => {
    const box = document.querySelector(".ss-pg-box");
    const band = document.querySelector(`tr[data-band="${id}"]`);
    const head = document.querySelector(".ss-pg-names th.ss-pg-f0");   // sticky: <thead>'s own box scrolls away
    const bb = band && band.getBoundingClientRect(), hb = head && head.getBoundingClientRect();
    return { search: location.search, scrollTop: box.scrollTop, bandTop: bb && Math.round(bb.top), headBottom: hb && Math.round(hb.bottom),
      readout: (document.querySelector(".ss-pg-readout") || {}).textContent || "" };
  }, uid("5", 3));
  ok("B: ?style= jumps that style's band to just under the header", r.scrollTop > 0 && Math.abs(r.bandTop - r.headBottom) <= 2, JSON.stringify(r));
  ok("B: …lands on its first price", /^Price · Test Utility Shed /.test(r.readout), r.readout);
  ok("B: …and ?style= leaves the address", r.search === "", r.search);
  ok("B: no page errors", errors.length === 0, errors.join(" | "));
  void S;
  await ctx.close();
}

// ── C: headers at 1280 and 1440, pinned panes, fitting numbers. 25 option columns fit across 1280,
// so the sideways pin is proved at 1000 px, where the grid has to scroll; the plan's 210 x 38 fixture
// scrolls sideways at both widths. ──
const C_RUNS = [
  { width: 1280, shot: "pricing-table-headers-1280.png" },
  { width: 1440, shot: "pricing-table-headers-1440.png" },
  { width: 1000 },
  { width: 1280, big: true, shot: "pricing-table-headers-38-columns-1280.png" },
  { width: 1440, big: true, shot: "pricing-table-headers-38-columns-1440.png" },
];
for (const run of want("C") ? C_RUNS : []) {
  const { width } = run;
  const tag = (run.big ? "C38@" : "C@") + width;
  const bigCat = run.big ? catalogFor(OWN, { extra: 13 }) : null;
  const S0 = run.big ? { cat: () => bigCat, table: (() => { const t = tableFor(OWN, bigCat, { perStyle: 70 }); return () => t; })() } : {};
  const nCols = OPTION_KEYS(run.big ? bigCat : catalogFor(OWN)).length;
  const { ctx, page, errors } = await open("/settings/sheds-table", S0, { width, height: 900 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(400);
  const h = await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".ss-pg-grid thead .ss-pg-vh")];
    const cut = spans.filter((sp) => {
      const th = sp.closest("th"), r = sp.getBoundingClientRect(), tr = th.getBoundingClientRect();
      const lines = Math.round(r.width / 15);
      // The cell must not overflow at all (the plan's test); the name may not run past its own box or
      // onto a third line. A bold glyph's ink can stand 1 px proud of its 15 px line: that clips nothing.
      return lines > 2 || sp.scrollHeight > sp.clientHeight + 1 || sp.scrollWidth > sp.clientWidth + 1
        || th.scrollHeight > th.clientHeight || th.scrollWidth > th.clientWidth || r.bottom > tr.bottom + 0.5 || r.right > tr.right + 0.5;
    }).map((sp) => sp.textContent);
    const names = document.querySelector(".ss-pg-names th.ss-pg-oh");
    const longest = spans.reduce((a, sp) => (sp.textContent.length > a.length ? sp.textContent : a), "");
    const two = spans.filter((sp) => Math.round(sp.getBoundingClientRect().width / 15) === 2);
    // Read with the head tilted right, line one must be the upper line, i.e. the RIGHT one on screen:
    // the name's first letter stands right of its last.
    const charX = (t, i) => { const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 1); const b = rg.getBoundingClientRect(); return b.left + b.width / 2; };
    const backwards = two.filter((sp) => { const t = sp.firstChild; return !(charX(t, 0) > charX(t, t.length - 1)); }).map((sp) => sp.textContent);
    return { n: spans.length, cut, headH: names ? Math.round(names.getBoundingClientRect().height) : 0, longest, twoLine: two.length, backwards,
      ellipsis: spans.some((sp) => getComputedStyle(sp).textOverflow === "ellipsis") };
  });
  ok(`${tag}: ${nCols} option headers plus Offered, none cut`, h.n === nCols + 1 && h.cut.length === 0, `cut: ${JSON.stringify(h.cut)}; header ${h.headH}px; ${h.twoLine} on two lines`);
  ok(`${tag}: a two-line name reads in order (first line on the right, top to bottom)`, h.twoLine > 0 && h.backwards.length === 0, JSON.stringify(h.backwards));
  ok(`${tag}: the longest name is the 46-character door, drawn whole`, h.longest === LONG, h.longest);
  ok(`${tag}: no ellipsis on the headers at this width`, !h.ellipsis);
  const fit = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".ss-pg-grid tbody td[data-c]")].filter((td) => td.textContent === "480" || td.textContent === "1200");
    return { n: cells.length, over: cells.filter((td) => td.scrollWidth > td.clientWidth).map((td) => td.textContent), w: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0 };
  });
  ok(`${tag}: "480" and "1200" fit their 44 px boxes`, fit.n > 0 && fit.over.length === 0 && fit.w === 44, JSON.stringify(fit));
  // Pinned on both axes: scroll the box right and down; Size/Price/Offered and the header stay put.
  const pin = await page.evaluate(async () => {
    const box = document.querySelector(".ss-pg-box");
    const bb = box.getBoundingClientRect();
    const first = document.querySelector(".ss-pg-grid tbody tr[data-s]");
    const at = () => ({ size: first.children[0].getBoundingClientRect(), price: first.children[1].getBoundingClientRect(), off: first.children[2].getBoundingClientRect(),
      opt: document.querySelector(".ss-pg-names th.ss-pg-oh").getBoundingClientRect() });
    const a = at();
    box.scrollLeft = 400; box.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = at();
    box.scrollTop = 300;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const headRow = document.querySelector(".ss-pg-names th.ss-pg-f0").getBoundingClientRect();
    const res = { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop, sizeX: [Math.round(a.size.left), Math.round(b.size.left)], priceX: [Math.round(a.price.left), Math.round(b.price.left)],
      offX: [Math.round(a.off.left), Math.round(b.off.left)], optX: [Math.round(a.opt.left), Math.round(b.opt.left)], headTop: Math.round(headRow.top), boxTop: Math.round(bb.top), boxLeft: Math.round(bb.left),
      pageX: document.documentElement.scrollWidth <= window.innerWidth, pageY: document.documentElement.scrollHeight <= window.innerHeight };
    box.scrollLeft = 0; box.scrollTop = 0;
    return res;
  });
  const sideways = pin.scrollLeft > 0 && pin.sizeX[0] === pin.sizeX[1] && pin.priceX[0] === pin.priceX[1] && pin.offX[0] === pin.offX[1] && pin.optX[1] < pin.optX[0];
  if (width === 1000) ok(`${tag}: Size, Price and Offered stay pinned while the grid scrolls sideways`, sideways, JSON.stringify(pin));
  else ok(`${tag}: the grid fits across without a sideways scroll, or stays pinned in one`, pin.scrollLeft === 0 || sideways, JSON.stringify(pin));
  ok(`${tag}: the header stays pinned while it scrolls down`, pin.scrollTop > 0 && pin.headTop === pin.boxTop + 22, JSON.stringify({ headTop: pin.headTop, boxTop: pin.boxTop }));
  ok(`${tag}: the page itself never scrolls, either way`, pin.pageX && pin.pageY);
  const thead = await page.locator(".ss-pg-grid thead").boundingBox();
  if (run.shot) await page.screenshot({ path: join(headerShots, run.shot), clip: { x: 0, y: 0, width, height: Math.min(900, Math.round(thead.y + thead.height + 28 * 6)) } });
  await page.screenshot({ path: join(shots, `${tag.replace("@", "-")}-full.png`) });
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── D: the grid's moves, readout, folding, jump, ARIA ──
if (want("D")) {
  const { ctx, page, errors, S } = await open("/settings/sheds-table", {}, { width: 1440, height: 800 });
  await waitGrid(page).catch(() => {});
  const t = S.table(OWN);
  const firstId = t.sizes.filter((z) => z.style_id === t.styles[0].id)[0].id;
  await page.locator(`tr[data-s="${firstId}"] td[data-c="1"]`).click();
  const read = () => page.evaluate(() => ({ readout: document.querySelector(".ss-pg-readout").textContent,
    sel: [...document.querySelectorAll('[aria-selected="true"]')].map((td) => `${td.parentElement.getAttribute("data-s")}:${td.getAttribute("data-c")}`),
    focus: document.activeElement && document.activeElement.className }));
  const r1 = await read();
  ok("D: a click makes that cell active: the readout names the column and size", r1.readout === "Price · Test Barn 8x12" && r1.sel.length === 1 && r1.sel[0] === `${firstId}:1` && /ss-pg-grid/.test(r1.focus), JSON.stringify(r1));
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const r2 = await read();
  ok("D: arrows move it; one cell is selected at a time", r2.readout === "Shelving · Test Barn 10x12" && r2.sel.length === 1 && r2.sel[0].endsWith(":5"), JSON.stringify(r2));
  await page.keyboard.press("Home");
  const r3 = await read();
  ok("D: Home goes to the row's Size", /^Size · Test Barn /.test(r3.readout), r3.readout);
  await page.hover(".ss-pg-names th.ss-pg-oh >> nth=2");
  const peek = await page.locator(".ss-pg-readout").textContent();
  ok("D: pointing at a header shows its full name in the readout", peek === "Shelving", peek);
  const aria = await page.evaluate(() => {
    const g = document.querySelector(".ss-pg-grid");
    const row = g.querySelector("tbody tr[data-s]");
    return { role: g.getAttribute("role"), rows: Number(g.getAttribute("aria-rowcount")), cols: Number(g.getAttribute("aria-colcount")),
      rowRole: row.getAttribute("role"), rowIdx: row.getAttribute("aria-rowindex"), cellRole: row.children[3].getAttribute("role"), cellIdx: row.children[3].getAttribute("aria-colindex"),
      th: document.querySelector(".ss-pg-names th.ss-pg-oh").getAttribute("aria-label"), live: document.querySelector(".ss-pg-badge").getAttribute("aria-live"),
      trs: g.querySelectorAll("tr").length };
  });
  ok("D: ARIA: grid with row and column counts, rows and gridcells indexed, named headers, a polite badge",
    aria.role === "grid" && aria.rows === aria.trs && aria.cols === 28 && aria.rowRole === "row" && aria.rowIdx === "4" && aria.cellRole === "gridcell" && aria.cellIdx === "4" && aria.th === "Loft (sq ft)" && aria.live === "polite", JSON.stringify(aria));
  // Show hidden sizes: off folds them away, and is remembered.
  const hiddenN = t.sizes.filter((z) => z.base_price == null || !z.active).length;
  await page.getByLabel("Show hidden sizes").uncheck();
  const folded = await page.locator(".ss-pg-grid tbody tr[data-s]").count();
  ok("D: 'Show hidden sizes' off folds the hidden sizes away", folded === t.sizes.length - hiddenN && hiddenN > 0, `${folded} rows, ${hiddenN} hidden`);
  await page.reload();
  await waitGrid(page).catch(() => {});
  const remembered = await page.locator(".ss-pg-grid tbody tr[data-s]").count();
  ok("D: …and it is remembered on the next load", remembered === t.sizes.length - hiddenN && !(await page.getByLabel("Show hidden sizes").isChecked()), String(remembered));
  await page.getByLabel("Show hidden sizes").check();
  // Hidden rows are drawn at 55% text.
  const dim = await page.evaluate(() => { const tr = document.querySelector("tr.ss-pg-hid"); return tr ? getComputedStyle(tr.children[0]).color : null; });
  ok("D: a hidden size is drawn at 55%", dim === "rgba(30, 41, 59, 0.55)", dim);
  // Jump to style. The middle style's band lands just under the header. The last style has too few
  // rows under it to reach the top, so the box goes to its end and the band shows below the header.
  const jumpTo = async (label, id) => {
    await page.locator(".ss-pg-jump").selectOption({ label });
    await page.waitForTimeout(250);
    return page.evaluate((sid) => {
      const box = document.querySelector(".ss-pg-box");
      const band = document.querySelector(`tr[data-band="${sid}"]`).getBoundingClientRect();
      const head = document.querySelector(".ss-pg-names th.ss-pg-f0").getBoundingClientRect();
      return { band: Math.round(band.top), head: Math.round(head.bottom), atEnd: Math.abs(box.scrollTop + box.clientHeight - box.scrollHeight) <= 1,
        boxBottom: Math.round(box.getBoundingClientRect().bottom), readout: document.querySelector(".ss-pg-readout").textContent, val: document.querySelector(".ss-pg-jump").value };
    }, id);
  };
  const j = await jumpTo("Test Lofted Barn", t.styles[1].id);
  ok("D: Jump to style puts the band just under the header and lands on its first price", Math.abs(j.band - j.head) <= 2 && /^Price · Test Lofted Barn /.test(j.readout) && j.val === "", JSON.stringify(j));
  const jl = await jumpTo("Test Utility Shed", t.styles[2].id);
  ok("D: …the last style scrolls as far as the grid goes, its band in view under the header", (Math.abs(jl.band - jl.head) <= 2 || (jl.atEnd && jl.band >= jl.head - 2 && jl.band < jl.boxBottom))
    && /^Price · Test Utility Shed /.test(jl.readout), JSON.stringify(jl));
  // The legend folds.
  await page.locator(".ss-pg-q").click();
  ok("D: '?' folds the legend", !(await page.locator(".ss-pg-legend").count()));
  await page.screenshot({ path: join(shots, "D-grid.png") });
  ok("D: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── D2: hidden styles fold into their own section ──
if (want("D")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { table: (cid) => tableFor(cid, catalogFor(cid), { hiddenStyle: true }) });
  await waitGrid(page).catch(() => {});
  const before = await page.locator(".ss-pg-band b").allTextContents();
  const hs = page.locator(".ss-pg-hs button");
  ok("D: a hidden style is folded into 'Hidden styles (not in your designer)'", (await hs.count()) === 1 && !before.includes("Test Retired Style") && /Hidden styles \(not in your designer\) · 1/.test(await hs.textContent()), JSON.stringify(before));
  await hs.click();
  ok("D: …which opens to show it", (await page.locator(".ss-pg-band b").allTextContents()).includes("Test Retired Style"));
  ok("D: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── E: loading, failure, empty, no columns, too big ──
if (want("E")) {
  const { ctx, page, errors, S } = await open(null, { sizeTableDelayMs: 1500 });
  await page.goto(`${BASE}/settings/sheds-table`);
  await page.waitForSelector(".ss-pg-skel", { timeout: 15000 }).catch(() => {});
  ok("E: while it loads: a skeleton grid and 'Loading…'", (await page.locator(".ss-pg-skel").count()) === 1 && (await page.locator(".ss-pg-badge").textContent()) === "Loading…");
  await page.screenshot({ path: join(shots, "E-loading.png") });
  await waitGrid(page).catch(() => {});
  ok("E: …then the grid", (await page.locator(".ss-pg-grid tbody tr[data-s]").count()) > 0);
  S.sizeTableDelayMs = 0; S.sizeTableFailures = 2;   // the first read and its retry by the user both fail once each
  await page.reload();
  await page.waitForSelector(".ss-pg-fail", { timeout: 15000 }).catch(() => {});
  const fail = await page.locator(".ss-pg-fail").textContent().catch(() => "");
  ok("E: a failed read says so, with Retry", /Couldn't load your sizes\./.test(fail) && /Retry/.test(fail) && (await page.locator(".ss-pg-badge").textContent()) === "Couldn't load", fail);
  await page.screenshot({ path: join(shots, "E-failed.png") });
  await page.getByRole("button", { name: "Retry" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Retry" }).click().catch(() => {});
  await waitGrid(page).catch(() => {});
  ok("E: Retry recovers", (await page.locator(".ss-pg-grid tbody tr[data-s]").count()) > 0);
  ok("E: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { table: (cid) => tableFor(cid, catalogFor(cid), { noStyles: true }) });
  await page.waitForSelector("text=No building styles yet.", { timeout: 15000 }).catch(() => {});
  const t = await page.locator(".ss-pg-msg-inline").textContent().catch(() => "");
  ok("E: no styles: 'No building styles yet. Add one on Sheds.' with the link", /No building styles yet\. Add one on Sheds\./.test(t) && (await page.locator('.ss-pg-msg-inline a[href="/settings/sheds"]').count()) === 1, t);
  ok("E: no page errors (no styles)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { cat: (cid) => catalogFor(cid, { cols: "none" }) });
  await waitGrid(page).catch(() => {});
  const box = await page.locator(".ss-pg-optbox").textContent().catch(() => "");
  const heads = await page.locator(".ss-pg-names th").count();
  ok("E: no option columns: Size, Price and Offered still show, under the Options box", /Set up your Options first\./.test(box) && heads === 3 && (await page.locator('.ss-pg-optbox a[href="/settings/options"]').count()) === 1, `${heads} headers; ${box}`);
  ok("E: no page errors (no columns)", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: join(shots, "E-no-columns.png") });
  await ctx.close();
}
if (want("E")) {
  const { ctx, page, calls, errors } = await open(null, { countSkew: true });
  await page.goto(`${BASE}/settings/sheds-table`);
  await waitGrid(page).catch(() => {});
  await page.waitForSelector(".ss-pg-status-amber", { timeout: 10000 }).catch(() => {});
  const st = await page.locator(".ss-pg-status-amber").textContent().catch(() => "");
  const reads = calls.filter((c) => c.action === "size_table").length;
  ok("E: counts that never add up: read twice, then 'too big' and view-only", reads === 2 && /This catalog is too big for the table right now\. Use the Excel sheet, and let us know\./.test(st) && /Reload/.test(st)
    && (await page.locator(".ss-pg").getAttribute("data-ss-pg-editable")) === "0" && /^View only/.test(await page.locator(".ss-pg-badge").textContent()), `${reads} reads; ${st}`);
  ok("E: no page errors (too big)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── F: view-as and permissions ──
if (want("F")) {
  // is_operator answers 2.5 s late, so the hold is long enough to see: the tab is the operator's OWN
  // account until it answers, and nothing may be read for it.
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}`, { own: OPS, operator: true, operatorDelayMs: 2500 });
  await page.waitForSelector(".ss-pg-msg", { timeout: 15000 }).catch(() => {});
  const holding = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  const readsWhileHeld = tableCalls(calls).length + calls.filter((c) => c.action === "size_table").length;
  ok("F: while the operator check is out, the tab says 'Opening <builder>…' and reads no table", holding === `Opening ${VIEWED}…` && readsWhileHeld === 0, `${holding}; ${readsWhileHeld} reads`);
  await waitGrid(page).catch(() => {});
  await page.waitForFunction((name) => (document.querySelector(".ss-pg-op") || {}).textContent === `Editing ${name} as operator. Changes are live.`, COMPANY[VIEWED], { timeout: 10000 }).catch(() => {});
  const tc = tableCalls(calls);
  ok("F: an operator's cold ?view= load reads the table for the viewed builder only",
    tc.length >= 2 && tc.every((c) => c.body.targetClientId === VIEWED), tc.map((c) => `${c.action}->${c.body.targetClientId}`).join(" "));
  const f = await page.evaluate(() => ({ strip: (document.querySelector(".ss-pg-op") || {}).textContent || "", co: (document.querySelector(".ss-pg-co") || {}).textContent || "",
    title: document.title, editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"), back: document.querySelector(".ss-pg-back").getAttribute("href") }));
  ok("F: the red operator strip names the builder (their company name, not the address's slug)", f.strip === `Editing ${COMPANY[VIEWED]} as operator. Changes are live.` && f.co === COMPANY[VIEWED], JSON.stringify(f));
  ok("F: …and so does the tab's title", f.title === `Sizes & prices · ${COMPANY[VIEWED]} · Structure Studio`, f.title);
  ok("F: Back to Sheds keeps ?view=", f.back === `/settings/sheds?view=${VIEWED}`, f.back);
  ok("F: an operator in view-as may edit", f.editable === "1");
  await page.screenshot({ path: join(shots, "F-view-as.png") });
  ok("F: no page errors (view-as)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}&as=${WEAR}`, { own: OPS, operator: true });
  await waitGrid(page).catch(() => {});
  const f = await page.evaluate(() => ({ strip: (document.querySelector(".ss-pg-op") || {}).textContent || "", badge: document.querySelector(".ss-pg-badge").textContent,
    status: (document.querySelector(".ss-pg-status") || {}).textContent || "", editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"),
    ro: document.querySelector(".ss-pg-grid").getAttribute("aria-readonly") }));
  ok("F: ?as= opens view-only, and says why", f.editable === "0" && f.ro === "true" && f.badge === "View only: viewing as a team member" && /You're viewing as a team member\. The table is view-only here/.test(f.status) && /view-only/.test(f.strip), JSON.stringify(f));
  ok("F: …and its reads still go to the viewed builder", tableCalls(calls).every((c) => c.body.targetClientId === VIEWED));
  ok("F: no page errors (as)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const t0 = Date.now();
  const { ctx, page, calls, errors } = await open(`/settings/sheds-table?view=${VIEWED}`, { own: OWN, operator: false });
  await page.waitForSelector(".ss-pg-msg", { timeout: 15000 }).catch(() => {});
  const early = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  await page.waitForSelector("text=Couldn't open that account here.", { timeout: 14000 }).catch(() => {});
  const late = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  const took = Date.now() - t0;
  ok("F: a non-operator holding ?view= sees 'Opening…'", early === `Opening ${VIEWED}…`, early);
  ok("F: …and after 10 s 'Couldn't open that account here.'", late === "Couldn't open that account here. Close this tab and use the button on Sheds again." && took >= 9500, `${late} after ${took} ms`);
  ok("F: …and no table read ever went out (never the user's own account)", tableCalls(calls).length === 0 && !calls.some((c) => c.action === "size_table"), tableCalls(calls).map((c) => c.action).join(","));
  ok("F: no page errors (hold)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", { role: "user", access: { settings_structures: "view", designs: "view" } });
  await waitGrid(page).catch(() => {});
  const f = await page.evaluate(() => ({ badge: document.querySelector(".ss-pg-badge").textContent, editable: document.querySelector(".ss-pg").getAttribute("data-ss-pg-editable"),
    inputs: document.querySelectorAll(".ss-pg-grid input, .ss-pg-grid textarea, .ss-pg-grid [contenteditable]").length }));
  ok("F: a view-only access map opens view-only, with no editor", f.badge === "View only: no edit access" && f.editable === "0" && f.inputs === 0, JSON.stringify(f));
  ok("F: no page errors (view access)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { role: "user", access: { designs: "view" } });
  await page.waitForTimeout(2500);
  const here = await page.evaluate(() => location.pathname);
  ok("F: no Sheds access: the table is not shown and no table read goes out", (await page.locator(".ss-pg-grid").count()) === 0 && !calls.some((c) => c.action === "size_table"), here);
  ok("F: no page errors (no access)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
if (want("F")) {
  const { ctx, page, calls, errors } = await open("/settings/sheds-table", { locked: true });
  await page.waitForSelector("text=This account's subscription needs attention.", { timeout: 15000 }).catch(() => {});
  const m = await page.locator(".ss-pg-msg").textContent().catch(() => "");
  ok("F: a billing lock shows the lock with a Billing link, not the table", /This account's subscription needs attention\./.test(m) && (await page.locator('.ss-pg-msg a[href="/settings/billing"]').count()) === 1 && !calls.some((c) => c.action === "size_table"), m);
  ok("F: no page errors (locked)", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── G: narrow ──
if (want("G")) {
  const { ctx, page, errors } = await open("/settings/sheds-table", {}, { width: 390, height: 844 });
  await waitGrid(page).catch(() => {});
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const box = document.querySelector(".ss-pg-box").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".ss-pg-grid tbody tr[data-s]")].filter((tr) => { const r = tr.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; });
    const head = document.querySelector(".ss-pg-names th.ss-pg-oh").getBoundingClientRect().height;
    return { pageW: document.documentElement.scrollWidth, vw: window.innerWidth, head: Math.round(head), visibleRows: rows.length,
      note: (document.querySelector(".ss-pg-narrow") || {}).textContent || "", legend: !!document.querySelector(".ss-pg-legend"),
      priceSticky: getComputedStyle(document.querySelector(".ss-pg-grid tbody td.ss-pg-f1")).position };
  });
  ok("G: 390 px: the page does not scroll sideways", g.pageW <= g.vw, `${g.pageW} vs ${g.vw}`);
  ok("G: the header is at most 90 px", g.head <= 90, String(g.head));
  ok("G: at least 8 rows show", g.visibleRows >= 8, String(g.visibleRows));
  ok("G: only Size stays frozen, the legend starts folded, and the computer note shows", g.priceSticky === "static" && !g.legend && /Easiest on a computer\./.test(g.note), JSON.stringify(g));
  await page.screenshot({ path: join(shots, "G-390.png") });
  ok("G: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// ── T: timing ──
if (!process.env.SKIP_TIMING && want("T")) {
  for (const [tag, perStyle] of [["1x", 70], ["3x", 210]]) {
    const cat = catalogFor(OWN, { extra: 13 });                    // 25 + 13 = 38 option columns
    const table = tableFor(OWN, cat, { perStyle });                 // 3 styles x perStyle sizes
    const cells = table.sizes.length * (3 + OPTION_KEYS(cat).length);
    const { ctx, page, errors } = await open(null, { cat: () => cat, table: () => table }, { width: 1440, height: 900 });
    await page.goto(`${BASE}/settings/sheds-table`);
    await waitGrid(page, 60000).catch(() => {});
    await page.waitForTimeout(800);
    const first = await page.evaluate(() => {
      const m = (n) => performance.getEntriesByName(n);
      const data = m("ss-pg-data")[0], grids = m("ss-pg-grid"), painted = m("ss-pg-painted");
      return { grid: grids.length ? Math.round(grids[grids.length - 1].startTime - data.startTime) : null,
        painted: painted.length ? Math.round(painted[painted.length - 1].startTime - data.startTime) : null, passes: grids.length,
        nav: Math.round((painted.length ? painted[painted.length - 1].startTime : 0)) };
    });
    // Arrow keys: dispatched on the grid in the page, timed from the keydown to the update laid out
    // (React's microtask flush, then a forced layout), and to the next frame.
    await page.locator(".ss-pg-grid tbody tr[data-s] td[data-c='1']").first().click();
    const keys = await page.evaluate(async () => {
      const g = document.querySelector(".ss-pg-grid");
      const sync = [], frame = [];
      const press = async (key) => {
        const t0 = performance.now();
        g.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await new Promise((r) => queueMicrotask(r));
        const act = g.querySelector("td.ss-pg-act");
        if (act) act.getBoundingClientRect();
        sync.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(() => r()));
        frame.push(performance.now() - t0);
      };
      for (let i = 0; i < 30; i++) await press("ArrowRight");
      for (let i = 0; i < 40; i++) await press("ArrowDown");
      for (let i = 0; i < 30; i++) await press("ArrowLeft");
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
      return { n: sync.length, syncMed: q(sync, 0.5), syncP95: q(sync, 0.95), syncMax: q(sync, 1), frameMed: q(frame, 0.5), frameP95: q(frame, 0.95),
        readout: document.querySelector(".ss-pg-readout").textContent };
    });
    console.log(`TIMING ${tag}: ${table.sizes.length} sizes x ${3 + OPTION_KEYS(cat).length} columns = ${cells} cells; first render (data in -> grid committed and measured) ${first.grid} ms over ${first.passes} commit(s), -> next frame ${first.painted} ms (page load -> table painted ${first.nav} ms, shell boot and stubbed reads included); ` +
      `arrow key (keydown -> laid out) median ${keys.syncMed} ms, p95 ${keys.syncP95} ms, max ${keys.syncMax} ms; keydown -> next frame median ${keys.frameMed} ms, p95 ${keys.frameP95} ms (${keys.n} keys)`);
    ok(`T${tag}: the grid rendered and the arrows moved (${cells} cells)`, first.grid != null && keys.n === 100 && /· Test /.test(keys.readout), keys.readout);
    ok(`T${tag}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}

await browser.close();
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = bad.length ? 1 : 0;
