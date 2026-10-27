// The library of claddings, doors and windows (migration 339; Carolyn's 10-26 call, plan §1 steps 6
// to 8), driven for real on the COMPILED portal.
//
//   A  library OFF: Cladding, Doors and Windows are exactly as before (no Library card, the five-row
//      cladding table, the nine-look door select, the rows x lites grid) and `library` is never asked.
//   B  library ON, first open: the builder's library is filled from what they use today (one
//      library_seed_mine), named as they already show it.
//   C  the StructureStudio library: search "LP" finds 7" LP Lap Siding and "metal" finds AG Panel; Use
//      AG Panel under the builder's own name; edit the lap entry's board size; removing an entry still
//      in use is refused with the rows named.
//   D  the per-style cladding table lists only what each style offers, its Cladding column a dropdown
//      of the builder's entries; one added from the library refuses to save without a rate, then saves
//      with clientLibraryId on every library row.
//   E  a cladding request: name, link and a photo, sent with its price line, then listed as Sent.
//   F  Doors: "How it looks in 3D" offers the builder's door entries, the row's current look and "Find
//      more in the library…" (which opens the Library card); picking an entry saves its look and
//      clientLibraryId.
//   G  Windows: a grid from the library sets rows and lites across, and saves them with clientLibraryId.
//   H  Admin: Master Catalog lists the StructureStudio templates and adds one; Builders shows the
//      request queue and marks a request done with a template and a copy in the builder's library.
//   I  no page errors.
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine); portal-settings
// and admin-catalog are small in-memory stand-ins that answer the way the real ones do. The tenant,
// styles and rows are made up (public repo).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/libraryOptions.mjs         (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/library-options (SS_SHOTS overrides).
import { join } from "node:path";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";

const CLIENT = "harness-library";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// ── The world the stand-ins serve ────────────────────────────────────────────────────────────
const STYLE_U = U(11), STYLE_D = U(12);
const T = (id, category, slug, name, look, searchTerms = [], description = null) => ({ id, category, slug, name, look, searchTerms, description, status: "active", version: 1, sortOrder: id, recolourable: true, leaves: null, thumbUrl: null, copies: 0 });
const TEMPLATES = [
  T(101, "cladding", "lap", '7" LP Lap Siding', { profile: "lap" }, ["lap", "LP", "clapboard"]),
  T(102, "cladding", "vinyl", '4.5" Vinyl Siding', { profile: "vinyl" }, ["vinyl"]),
  T(103, "cladding", "panel", "Panel Siding", { profile: "panel" }, ["panel", "T1-11"]),
  T(104, "cladding", "batten", "Board & Batten", { profile: "batten" }, ["batten"]),
  T(105, "cladding", "agpanel", "AG Panel", { profile: "agpanel" }, ["metal", "steel", "ribbed"]),
  T(201, "door", "photo", "Use the door's photo", { doorStyle: "auto" }),
  T(202, "door", "plank", "Board-and-batten (built in 3D)", { doorStyle: "plank" }),
  T(206, "door", "american", "American (built in 3D)", { doorStyle: "american" }, ["pickets"]),
  T(208, "door", "classic", "Classic (built in 3D)", { doorStyle: "classic" }),
  T(301, "window", "automatic", "Standard window", {}),
  T(302, "window", "no-grid", "No grid", { liteRows: 1, liteCols: 1 }),
  T(304, "window", "six-lite", "6-lite (3 rows of 2)", { liteRows: 3, liteCols: 2 }, ["colonial"]),
  T(306, "window", "transom-four", "4-lite transom (1 row of 4)", { liteRows: 1, liteCols: 4 }, ["transom"]),
].map((t) => ({ ...t, id: U(t.id) }));
const W = {
  flag: false,
  catalogDelayMs: 0,   // A: the catalog answers late, so a card shown while it is asked would be seen
  styles: [
    { id: STYLE_U, key: "utility", label: "Utility", active: true },
    { id: STYLE_D, key: "deluxe", label: "Deluxe", active: true },
  ],
  cladding: [
    { id: U(21), style_id: STYLE_U, cladding_id: "lap", label_override: null, rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 1, exposure_in: null },
    { id: U(22), style_id: STYLE_U, cladding_id: "panel", label_override: "Smooth panel", rate: 1.5, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 0, exposure_in: null },
    { id: U(23), style_id: STYLE_D, cladding_id: "lap", label_override: null, rate: 0, basis: "sqft_option", taxable: true, internal_only: false, active: true, sort_order: 1, exposure_in: null },
  ],
  fixtures: [
    { id: U(31), category: "door", name: "Double barn door", plan_label: "DD", width_in: 60, height_in: 72, price: 300, op_double: true, swing_out: true, door_style: "auto", color_mode: "fixed", active: true, archived: false, sort_order: 0 },
    { id: U(32), category: "window", name: "Wall window", plan_label: "W", width_in: 24, height_in: 36, price: 120, door_style: "auto", lite_rows: 3, lite_cols: 2, color_mode: "fixed", active: true, archived: false, sort_order: 0 },
  ],
  entries: [], claddingLinks: {}, fixtureLinks: {}, requests: [], templates: TEMPLATES.map((t) => ({ ...t })),
};
const sent = [];
let seq = 600;
const usedOn = (id) => [
  ...W.cladding.filter((r) => W.claddingLinks[r.id] === id).map((r) => (W.styles.find((s) => s.id === r.style_id) || {}).label),
  ...W.fixtures.filter((r) => W.fixtureLinks[r.id] === id).map((r) => r.name),
];
const addEntry = (category, name, look, templateId = null) => { const e = { id: U(seq++), category, name, look, templateId, templateVersion: 1, active: true, sortOrder: 0, usedOn: [] }; W.entries.push(e); return e; };
function settings(body) {
  switch (body.action) {
    case "status":
      return { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, ssQuoteNext: 1, ssInvoiceNext: 1, businessAddress: {}, branding: {}, emailReady: true };
    case "catalog":
      return { ok: true, clientId: CLIENT, styles: W.styles, sizes: [], items: [], inclusions: [], layoutPricing: [], colors: [], fixtures: W.fixtures, windowColors: [], wallHeights: [],
        cladding: W.cladding, insulation: [], electrical: null, electricalItems: [], foundation: [], interiorWalls: null, interiorWallCoverings: [], claddingCourses: true,
        insulationEnabled: false, rampSettings: { mode: "simple", enabled: false }, aiReady: false, wallet: null,
        libraryBeta: W.flag, library: W.flag ? { entries: W.entries, claddingLinks: W.claddingLinks, fixtureLinks: W.fixtureLinks } : null };
    case "library":
      if (!W.flag) return [{ error: "The library isn't turned on for your account.", code: "library_off" }, 403];
      return { ok: true, templates: W.templates.filter((t) => t.status === "active"), entries: W.entries.map((e) => ({ ...e, usedOn: usedOn(e.id) })), requests: W.requests, requestPrice: { priceCents: 200, active: true, exempt: false } };
    case "library_seed_mine": {
      for (const r of W.cladding.filter((x) => x.rate != null)) {
        const t = W.templates.find((x) => x.category === "cladding" && x.look.profile === r.cladding_id);
        const name = r.label_override || t.name;
        const e = W.entries.find((x) => x.name === name) || addEntry("cladding", name, { profile: r.cladding_id }, t.id);
        W.claddingLinks[r.id] = e.id;
      }
      for (const r of W.fixtures) {
        const look = r.category === "door" ? { doorStyle: r.door_style } : (r.lite_rows == null ? {} : { liteRows: r.lite_rows, liteCols: r.lite_cols });
        const t = W.templates.find((x) => x.category === r.category && JSON.stringify(x.look) === JSON.stringify(look));
        const e = W.entries.find((x) => x.category === r.category && JSON.stringify(x.look) === JSON.stringify(look)) || addEntry(r.category, t ? t.name : "Custom", look, t && t.id);
        W.fixtureLinks[r.id] = e.id;
      }
      return { ok: true, created: W.entries.length, linked: Object.keys(W.claddingLinks).length + Object.keys(W.fixtureLinks).length };
    }
    case "library_add": {
      const t = W.templates.find((x) => x.id === body.templateId);
      if (W.entries.some((x) => x.category === t.category && x.name.toLowerCase() === String(body.name).toLowerCase())) return [{ error: `You already have "${body.name}". Pick another name.` }, 409];
      return { ok: true, entry: addEntry(t.category, body.name, body.look || t.look, t.id) };
    }
    case "library_edit": {
      const e = W.entries.find((x) => x.id === body.id);
      if (body.name) e.name = body.name;
      if (body.look) e.look = body.look;
      return { ok: true, entry: e };
    }
    case "library_remove": {
      const used = usedOn(body.id);
      const e = W.entries.find((x) => x.id === body.id);
      if (used.length) return [{ error: `"${e.name}" is still used on ${used.join(", ")}. Pick something else there first.`, code: "library_in_use", usedOn: used }, 409];
      W.entries = W.entries.filter((x) => x.id !== body.id);
      return { ok: true };
    }
    case "library_request_upload_url":
      return { ok: true, path: `${CLIENT}/requests/${U(seq++)}.png`, token: "tok" };
    case "library_request": {
      const r = { id: U(seq++), category: body.category, status: "submitted", name: body.name, photos: (body.photos || []).length, supplierUrl: body.supplierUrl || null, chargedCents: 200, refundedCents: 0, createdAt: "2026-10-27T12:00:00Z" };
      W.requests.unshift(r);
      return { ok: true, request: r };
    }
    case "save_cladding": {
      for (const row of body.rows || []) {
        const r = W.cladding.find((x) => x.style_id === body.styleId && x.cladding_id === row.claddingId);
        const rate = String(row.rate).trim() === "" ? null : Number(row.rate);
        const tgt = r || (rate != null ? (W.cladding.push({ id: U(seq++), style_id: body.styleId, cladding_id: row.claddingId, basis: row.basis, taxable: true, internal_only: false, active: true, sort_order: 9 }), W.cladding[W.cladding.length - 1]) : null);
        if (!tgt) continue;
        tgt.rate = rate;
        tgt.label_override = row.labelOverride || null;
        if (row.clientLibraryId !== undefined) { if (row.clientLibraryId) W.claddingLinks[tgt.id] = row.clientLibraryId; else delete W.claddingLinks[tgt.id]; }
      }
      return { ok: true, saved: (body.rows || []).length, skipped: [] };
    }
    case "save_fixture": {
      const r = W.fixtures.find((x) => x.id === body.id);
      if (r) {
        if (body.doorStyle) r.door_style = body.doorStyle;
        if (body.liteRows !== undefined) { r.lite_rows = body.liteRows; r.lite_cols = body.liteCols; }
        if (body.clientLibraryId !== undefined) { if (body.clientLibraryId) W.fixtureLinks[r.id] = body.clientLibraryId; else delete W.fixtureLinks[r.id]; }
      }
      return { ok: true, id: body.id };
    }
    default:
      return { ok: true };
  }
}
function adminCatalog(body) {
  switch (body.action) {
    case "list_clients": return { ok: true, clients: [{ client_id: CLIENT, company_name: "Harness Sheds" }], tenants: [] };
    case "get_master": return { ok: true, layoutItemTypes: [] };
    case "number_requests_list": return { ok: true, installed: true, requests: [] };
    case "avalara_tax_codes_status": return { ok: true, count: 0, activeCount: 0, syncedAt: null };
    case "library_items_list": return { ok: true, installed: true, items: W.templates.map((t) => ({ ...t, copies: W.entries.filter((e) => e.templateId === t.id).length })) };
    case "library_item_save": {
      if (body.id) { const t = W.templates.find((x) => x.id === body.id); Object.assign(t, body.name ? { name: body.name } : {}, body.status ? { status: body.status } : {}); t.version++; return { ok: true, item: t }; }
      const t = T(seq++, body.category, String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"), body.name, body.look, String(body.searchTerms || "").split(",").map((s) => s.trim()).filter(Boolean), body.description);
      t.id = U(seq++); W.templates.push(t);
      return { ok: true, item: t };
    }
    case "library_requests_list":
      return { ok: true, installed: true, requests: W.requests.map((r) => ({ ...r, clientId: CLIENT, companyName: "Harness Sheds", photos: [], notes: null, updatedAt: r.createdAt })) };
    case "library_request_set": {
      const r = W.requests.find((x) => x.id === body.id);
      r.status = body.status;
      if (body.resultNote) r.resultNote = body.resultNote;
      if (body.addToBuilder && body.resultItemId) { const t = W.templates.find((x) => x.id === body.resultItemId); addEntry(t.category, r.name, t.look, t.id); }
      return { ok: true, request: { id: r.id, status: r.status } };
    }
    default: return { ok: true };
  }
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────
const { ok, failed } = reporter();
const shots = shotsDir("library-options");
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* blocked */ } }, [REF, SESSION]);
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
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
  if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
  if (url.includes("/rest/v1/rpc/is_operator")) return json(route, true);
  if (url.includes("/rest/v1/rpc/")) return json(route, false);
  if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
  if (url.includes("/rest/v1/")) return json(route, []);
  if (url.includes("/auth/v1/user")) return json(route, USER);
  if (url.includes("/auth/v1/")) return json(route, SESSION);
  if (url.includes("/storage/v1/")) { sent.push({ fn: "storage", url }); return json(route, { Key: "library-refs/x" }); }
  if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  if (url.includes("/portal-settings")) {
    sent.push({ fn: "portal-settings", ...body });
    if (body.action === "catalog" && W.catalogDelayMs) await new Promise((r) => setTimeout(r, W.catalogDelayMs));
    const out = settings(body);
    return Array.isArray(out) ? json(route, out[0], out[1]) : json(route, out);
  }
  if (url.includes("/admin-catalog")) { sent.push({ fn: "admin-catalog", ...body }); return json(route, adminCatalog(body)); }
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
const go = async (path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForTimeout(1400);
};
const actions = (name) => sent.filter((x) => x.action === name);
const text = () => page.innerText("body");

try {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(800);

  // ── A: library off ──
  // Any "Library" heading that appears at all, even for the moment the catalog is being asked (the
  // release review, 2026-10-27: a loading card showed for every builder, then went).
  W.catalogDelayMs = 1500;
  await page.evaluate(() => {
    window.__libFlash = 0;
    const look = () => { for (const el of document.querySelectorAll("div")) if (el.childElementCount === 0 && el.textContent === "Library") { window.__libFlash++; return; } };
    window.__libObs = new MutationObserver(look);
    window.__libObs.observe(document.body, { childList: true, subtree: true });
  });
  await go("/settings/cladding");
  await page.waitForFunction(() => /Cladding/.test(document.body.innerText) && document.querySelectorAll("table").length > 0, null, { timeout: 20000 }).catch(() => {});
  const offRows = await page.locator("table tbody tr").count();
  ok("A cladding with the library off: the five-row table per style, no Library card", offRows === 10 && (await page.locator("[data-ss-library]").count()) === 0, `${offRows} rows`);
  await go("/settings/doors");
  await page.waitForTimeout(600);
  ok("A doors with the library off: no Library card", (await page.locator("[data-ss-library]").count()) === 0);
  await go("/settings/windows");
  await page.waitForTimeout(600);
  ok("A windows with the library off: no Library card", (await page.locator("[data-ss-library]").count()) === 0);
  await page.waitForTimeout(1600);
  const flash = await page.evaluate(() => { window.__libObs.disconnect(); return window.__libFlash; });
  W.catalogDelayMs = 0;
  ok("A ...not even while the catalog is still being asked", flash === 0, `${flash} sightings`);
  ok("A `library` is never asked with the flag off", actions("library").length === 0 && actions("library_seed_mine").length === 0, JSON.stringify(sent.filter((x) => String(x.action || "").startsWith("library")).map((x) => x.action)));
  await page.screenshot({ path: join(shots, "a-windows-library-off.png"), fullPage: true });

  // ── B: on; first open seeds ──
  W.flag = true;
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await go("/settings/cladding");
  await page.waitForSelector("[data-ss-library='cladding'] input[type=search]", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => /Browse the StructureStudio library/.test((document.querySelector("[data-ss-library='cladding']") || {}).innerText || ""), null, { timeout: 20000 }).catch(() => {});
  // Ahsan 2026-10-27: the card is a search and a Browse button, nothing else.
  const closed = page.locator("[data-ss-library='cladding']");
  ok("B the card shows only a search and the Browse button", (await closed.locator("input[type=search]").count()) === 1
    && (await closed.locator("[data-ss-library-entry]").count()) === 0 && (await closed.locator("[data-ss-library-template]").count()) === 0
    && (await closed.getByRole("button").count()) === 1);
  await page.screenshot({ path: join(shots, "b0-library-card-search-and-browse.png"), fullPage: true });
  await page.getByRole("button", { name: /Browse the StructureStudio library/ }).first().click();
  await page.waitForSelector("[data-ss-library='cladding'] [data-ss-library-entry]", { timeout: 20000 }).catch(() => {});
  const mine = await page.locator("[data-ss-library='cladding'] [data-ss-library-entry]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-library-entry")));
  ok("B first open fills the library once from what the builder uses", actions("library_seed_mine").length === 1 && mine.includes('7" LP Lap Siding') && mine.includes("Smooth panel"), JSON.stringify(mine));
  ok("B each import says where it is used, under its template (Imported as)", /Imported as/.test(await page.locator("[data-ss-library-template='7\" LP Lap Siding']").innerText())
    && /used on 2: Utility, Deluxe/.test(await page.locator("[data-ss-library='cladding']").innerText()));
  await page.screenshot({ path: join(shots, "b-cladding-library-seeded.png"), fullPage: true });

  // ── C: search, import, rename, remove ──
  const search = page.getByRole("searchbox", { name: "Search the StructureStudio library" });
  await search.fill("LP");
  const lp = await page.locator("[data-ss-library-template]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-library-template")));
  ok('C search "LP" finds 7" LP Lap Siding', lp.length === 1 && lp[0] === '7" LP Lap Siding', JSON.stringify(lp));
  await search.fill("metal");
  const metal = await page.locator("[data-ss-library-template]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-library-template")));
  ok('C search "metal" finds AG Panel', metal.length === 1 && metal[0] === "AG Panel", JSON.stringify(metal));
  await page.screenshot({ path: join(shots, "c-search-metal.png"), fullPage: true });
  await page.locator("[data-ss-library-template='AG Panel']").getByRole("button", { name: "Import" }).click();
  await page.getByRole("textbox", { name: "Your name for it" }).fill("Metal ribbed panel");
  await page.locator("[data-ss-library-template='AG Panel']").getByRole("button", { name: "Import" }).click();
  await page.waitForTimeout(900);
  const added = actions("library_add").pop();
  await search.fill("");
  ok("C Import AG Panel adds it under the builder's own name", !!added && added.name === "Metal ribbed panel" && added.look && added.look.profile === "agpanel" && (await page.locator("[data-ss-library-entry='Metal ribbed panel']").count()) === 1, JSON.stringify(added));
  await page.getByRole("button", { name: /Browse the StructureStudio library/ }).first().click().catch(() => {});
  await page.locator("[data-ss-library-entry='7\" LP Lap Siding']").getByRole("button", { name: "Rename" }).click();
  await page.locator("[data-ss-library-entry='7\" LP Lap Siding'] input[type=number]").fill("8");
  await page.locator("[data-ss-library-entry='7\" LP Lap Siding']").getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(900);
  const edited = actions("library_edit").pop();
  ok("C editing the lap entry's board size saves the copy only", !!edited && edited.look && edited.look.exposureIn === 8 && /8 in boards/.test(await page.locator("[data-ss-library='cladding']").innerText()), JSON.stringify(edited));
  await page.locator("[data-ss-library-entry='Smooth panel']").getByRole("button", { name: "Remove" }).click();
  await page.waitForTimeout(800);
  ok("C removing an entry still in use is refused and names the style", /still used on Utility/.test(await text()));
  await page.screenshot({ path: join(shots, "c-library-edit-and-refusal.png"), fullPage: true });

  // ── D: the per-style table ──
  const utility = page.locator("[data-ss-cladding-style='Utility']");
  const rowsU = await utility.locator("[data-ss-cladding-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ss-cladding-row")));
  ok("D Utility lists only what it offers, from the library", JSON.stringify(rowsU.sort()) === JSON.stringify(['7" LP Lap Siding', "Smooth panel"].sort()), JSON.stringify(rowsU));
  ok("D the Cladding column is a dropdown of the builder's entries", (await utility.locator("select[aria-label='Utility cladding']").count()) === 2);
  await utility.locator("select[aria-label='Add a cladding to Utility']").selectOption({ label: "Metal ribbed panel" });
  await utility.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(600);
  ok("D an entry added without a rate is refused before anything is sent", /give these a rate/.test(await text()) && actions("save_cladding").length === 0);
  await utility.locator("input[aria-label='Utility Metal ribbed panel rate']").fill("2.5");
  await utility.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(1200);
  const sc = actions("save_cladding").pop();
  const ag = sc && sc.rows.find((r) => r.claddingId === "agpanel");
  ok("D Save sends clientLibraryId on the library rows, with the entry's name", !!ag && ag.rate === "2.5" && ag.labelOverride === "Metal ribbed panel" && !!ag.clientLibraryId && sc.rows.every((r) => "clientLibraryId" in r), JSON.stringify(ag));
  await utility.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "d-cladding-dropdown-from-library.png"), fullPage: true });

  // ── E: a request ──
  if (!(await page.locator("[data-ss-library='cladding'] [data-ss-library-browse]").count())) await page.locator("[data-ss-library='cladding']").getByRole("button", { name: /Browse the StructureStudio library/ }).click();
  await page.locator("[data-ss-library='cladding']").getByRole("button", { name: /Request it/ }).click();
  await page.getByRole("textbox", { name: "Product name" }).fill("Stone veneer panel");
  await page.getByRole("textbox", { name: "Supplier link" }).fill("https://example.test/stone-veneer");
  await page.locator("[data-ss-library-request-form] input[type=file]").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: PNG });
  await page.waitForTimeout(1200);
  ok("E the request shows its price before it is sent", /A request costs \$2\.00/.test(await page.locator("[data-ss-library-request-form]").innerText()));
  await page.screenshot({ path: join(shots, "e-request-form.png"), fullPage: true });
  await page.getByRole("button", { name: "Send request" }).click();
  await page.waitForTimeout(1200);
  const rq = actions("library_request").pop();
  ok("E the request is sent with its photo and link", !!rq && rq.category === "cladding" && rq.photos.length === 1 && /^harness-library\/requests\//.test(rq.photos[0].path) && rq.supplierUrl === "https://example.test/stone-veneer", JSON.stringify(rq));
  ok("E and listed as Sent", (await page.locator("[data-ss-library-request='Stone veneer panel']").count()) === 1 && /Sent/.test(await page.locator("[data-ss-library-request='Stone veneer panel']").innerText()));
  await page.screenshot({ path: join(shots, "e-request-sent.png"), fullPage: true });

  // ── F: doors ──
  await go("/settings/doors");
  await page.waitForSelector("[data-ss-library='door']", { timeout: 20000 }).catch(() => {});
  await page.getByRole("button", { name: "Edit" }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  // The door line's own Edit (the library card's Edit buttons come first in the page).
  const doorEdit = page.locator("button", { hasText: /^Edit$/ });
  const n = await doorEdit.count();
  for (let i = 0; i < n && (await page.locator("[data-ss-door-look-library]").count()) === 0; i++) { await doorEdit.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
  const sel = page.locator("[data-ss-door-look-library]");
  const opts = await sel.locator("option").evaluateAll((els) => els.map((e) => e.textContent));
  ok("F the door's 3D look lists the builder's door entries and Find more", opts.includes("Use the door's photo") && opts.includes("Find more in the library…"), JSON.stringify(opts));
  // Add American to the library first, through the card.
  await page.locator("[data-ss-library='door']").getByRole("button", { name: /Browse the StructureStudio library/ }).click();
  await page.locator("[data-ss-library='door'] [data-ss-library-template='American (built in 3D)']").getByRole("button", { name: /^Import/ }).click();
  await page.locator("[data-ss-library='door']").getByRole("textbox", { name: "Your name for it" }).fill("Our American");
  await page.locator("[data-ss-library='door'] [data-ss-library-template='American (built in 3D)']").getByRole("button", { name: "Import" }).click();
  await page.waitForTimeout(1500);
  for (let i = 0; i < (await doorEdit.count()) && (await page.locator("[data-ss-door-look-library]").count()) === 0; i++) { await doorEdit.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
  await page.locator("[data-ss-door-look-library]").selectOption({ label: "Our American" });
  await page.screenshot({ path: join(shots, "f-door-look-from-library.png"), fullPage: true });
  await page.getByRole("button", { name: /^Save( door)?$/ }).last().click();
  await page.waitForTimeout(1200);
  const sf = actions("save_fixture").pop();
  const ourAm = W.entries.find((e) => e.name === "Our American");
  ok("F picking an entry saves its look and clientLibraryId", !!sf && sf.doorStyle === "american" && ourAm && sf.clientLibraryId === ourAm.id, JSON.stringify(sf && { doorStyle: sf.doorStyle, clientLibraryId: sf.clientLibraryId }));

  // ── G: windows ──
  await go("/settings/windows");
  await page.waitForSelector("[data-ss-library='window']", { timeout: 20000 }).catch(() => {});
  await page.locator("[data-ss-library='window']").getByRole("button", { name: /Browse the StructureStudio library/ }).click();
  await page.locator("[data-ss-library='window'] [data-ss-library-template='4-lite transom (1 row of 4)']").getByRole("button", { name: /^Import/ }).click();
  await page.locator("[data-ss-library='window']").getByRole("textbox", { name: "Your name for it" }).fill("Transom 4");
  await page.locator("[data-ss-library='window'] [data-ss-library-template='4-lite transom (1 row of 4)']").getByRole("button", { name: "Import" }).click();
  await page.waitForTimeout(1500);
  const wEdit = page.locator("button", { hasText: /^Edit$/ });
  for (let i = 0; i < (await wEdit.count()) && (await page.locator("[data-ss-window-grid-library]").count()) === 0; i++) { await wEdit.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
  // The window's grid is the designer's old picker now (Carolyn, 10-27), with the builder's library grids
  // as chips above it.
  await page.locator("[data-ss-window-grid-library] [data-ss-window-grid-library-entry='Transom 4']").click();
  await page.waitForTimeout(200);
  const pic = await page.locator("[data-ss-window-grid] [data-ss-window-lite-pic]").getAttribute("data-ss-window-lite-pic").catch(() => null);
  const t4On = ((await page.locator("[data-ss-window-grid-library-entry='Transom 4']").getAttribute("style")) || "").includes("224, 242, 254");
  ok("G a grid from the library (a chip) sets rows and lites across, and shows as picked", pic === "1x4" && t4On, `${pic} ${t4On}`);
  ok("G ...no dropdowns left in the window's grid", (await page.locator("[data-ss-window-grid] select").count()) === 0);
  await page.locator("[data-ss-window-grid]").screenshot({ path: join(shots, "g-window-grid-chips.png") }).catch(() => {});
  await page.screenshot({ path: join(shots, "g-window-grid-from-library.png"), fullPage: true });
  await page.getByRole("button", { name: /^Save( window)?$/ }).last().click();
  await page.waitForTimeout(1200);
  const sw = actions("save_fixture").pop();
  const t4 = W.entries.find((e) => e.name === "Transom 4");
  ok("G it saves rows, lites and clientLibraryId", !!sw && sw.liteRows === 1 && sw.liteCols === 4 && t4 && sw.clientLibraryId === t4.id, JSON.stringify(sw && { liteRows: sw.liteRows, liteCols: sw.liteCols, clientLibraryId: sw.clientLibraryId }));
  // A change by hand takes the window off the entry: one more row, saved as 2 x 4 with no library link.
  for (let i = 0; i < (await wEdit.count()) && (await page.locator("[data-ss-window-grid]").count()) === 0; i++) { await wEdit.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
  await page.locator("[data-ss-window-grid]").getByRole("button", { name: "More rows" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: /^Save( window)?$/ }).last().click();
  await page.waitForTimeout(1200);
  const sw2 = actions("save_fixture").pop();
  ok("G a change by hand saves 2 x 4 and unlinks the entry", !!sw2 && sw2 !== sw && sw2.liteRows === 2 && sw2.liteCols === 4 && sw2.clientLibraryId === null,
    JSON.stringify(sw2 && { liteRows: sw2.liteRows, liteCols: sw2.liteCols, clientLibraryId: sw2.clientLibraryId }));

  // ── H: admin ──
  await go("/console/master");
  await page.waitForSelector("[data-adm-library] [data-adm-library-item]", { timeout: 20000 }).catch(() => {});
  ok("H Master Catalog lists the StructureStudio templates", (await page.locator("[data-adm-library] [data-adm-library-item]").count()) === 5);
  await page.getByRole("button", { name: /\+ Add a cladding template/ }).click();
  await page.getByRole("textbox", { name: "Template name" }).fill("Cedar shake look");
  await page.getByRole("combobox", { name: "Drawn as" }).selectOption("batten");
  await page.getByRole("button", { name: "Add template" }).click();
  await page.waitForTimeout(1000);
  const ts = sent.filter((x) => x.action === "library_item_save").pop();
  ok("H an operator adds a template", !!ts && ts.category === "cladding" && ts.name === "Cedar shake look" && ts.look && ts.look.profile === "batten", JSON.stringify(ts));
  await page.screenshot({ path: join(shots, "h-admin-library.png"), fullPage: true });
  await go("/console/clients");
  await page.waitForSelector("[data-adm-library-request]", { timeout: 20000 }).catch(() => {});
  const req = page.locator("[data-adm-library-request]").first();
  await req.getByRole("button", { name: "Done…" }).click();
  await req.getByRole("combobox", { name: "The template it became" }).selectOption({ label: "Cedar shake look" });
  await page.screenshot({ path: join(shots, "h-admin-request-queue.png"), fullPage: true });
  await req.getByRole("button", { name: "Mark done" }).click();
  await page.waitForTimeout(1000);
  const done = sent.filter((x) => x.action === "library_request_set").pop();
  ok("H a request is marked done with its template and a copy for the builder", !!done && done.status === "done" && done.addToBuilder === true && !!done.resultItemId, JSON.stringify(done));

  ok("I no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("the run finished", false, e.message);
} finally {
  await browser.close();
}
process.exit(failed().length ? 1 : 0);
