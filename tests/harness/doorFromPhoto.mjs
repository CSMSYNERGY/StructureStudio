// "Don't see your door? Make it from a photo" (door looks from a photo, P6; Ahsan 2026-10-27), driven
// end to end on the COMPILED portal, with Supabase and the model stubbed (nothing leaves the machine):
//
//   A  door_looks_beta OFF: the Doors page's Library card is exactly as before (no photo box, no
//      "Make one from a photo…" in a door's look picker).
//   B  ON: the box sits to the right of the search and the Browse button; a door drafted from a photo
//      that is not in the library yet is listed under it with Review.
//   C  the photo step: name, single, 36 x 80 in, one photo of the closed door (a made-up door drawn on a
//      canvas, photographed at an angle), the money line ("Free right now.").
//   D  the corners: typed the wrong way round (80 x 36) the shape check refuses before anything is
//      uploaded; with the dots dragged onto the door's own corners it straightens, and the photo that
//      goes up has exactly the shape the server checks: (36 + 2 x 2) / 80, inside 1568 px and 1.15 MP, a
//      JPEG (re-encoded: no EXIF).
//   E  the press: generate_door_look with stream: true and the photo's server-picked path; the stream
//      drops, the draft is picked up by the SAME key (generate_door_look_recover: pending, then a
//      retryable failure), and the one lean retry goes out under that key with lean: true.
//   F  the review: our 3D door drawn by the designer's own renderer (front, 35° left and right) beside
//      the straightened photo, with the draft's warning.
//   G  save: our front render uploaded as the tile (a PNG at the path the server handed out), the look
//      saved Ready under its version, then added to the library by its doorLookId.
//   H  the library shows it ("Made from your photo, drawn over ...", with its tile), and a door's "How it
//      looks in 3D" lists it beside "Make one from a photo…"; picking it saves its clientLibraryId and
//      the look's base as doorStyle.
//   I  no page errors.
//
// The tenant, doors and the photo are made up (public repo).
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/doorFromPhoto.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/door-from-photo (SS_SHOTS overrides).
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir, PASS_THROUGH_GET } from "./lib.mjs";

const CLIENT = "harness-door-photo";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The draft the stubbed model "drew" from the made-up photo below: a board door with a mid rail and a Z
// in each half rising from the hinge side, three T-straps on the rails, hinged left, a barn latch.
const SPEC = {
  v: 1, base: "zbrace", src: { leaves: 1, hinge: "left" }, field: { dir: "v" }, frame: { rails: [0.5] }, brace: { t: "none" },
  panels: [{ fill: "z", zFrom: "hinge" }, { fill: "z", zFrom: "hinge" }],
  hinges: { type: "tstrap", count: 3, at: [0.08, 0.5, 0.92], lenIn: 16 }, handle: { type: "barn" },
};
const WARNING = "We weren't sure if this is a Z brace or an X brace. Check the braces before you save.";
const LOOK_NEW = U(801), LOOK_OLD = U(802);

const T = (id, slug, name, look) => ({ id: U(id), category: "door", slug, name, look, searchTerms: [], description: null, status: "active", version: 1, sortOrder: id, recolourable: true, leaves: null, thumbUrl: null });
const W = {
  doorLooksBeta: false,
  templates: [T(201, "photo", "Use the door's photo", { doorStyle: "auto" }), T(203, "zbrace", "Board-and-batten with a Z brace", { doorStyle: "zbrace" }), T(208, "classic", "Classic (built in 3D)", { doorStyle: "classic" })],
  entries: [{ id: U(601), category: "door", name: "Use the door's photo", look: { doorStyle: "auto" }, templateId: U(201), templateVersion: 1, active: true, sortOrder: 0, usedOn: [] }],
  fixtures: [{ id: U(31), category: "door", name: "Single barn door", plan_label: "SD", width_in: 36, height_in: 80, price: 300, op_right: true, op_left: true, swing_out: true, door_style: "auto", color_mode: "fixed", active: true, archived: false, sort_order: 0 }],
  fixtureLinks: { [U(31)]: U(601) },
  looks: [{ id: LOOK_OLD, name: "Yesterday's draft", base: "plank", spec: { v: 1, base: "plank", src: { leaves: 1, hinge: "right" } }, v: 1, status: "draft", thumbUrl: null, version: 1, fromPhoto: true, createdAt: "2026-10-26T10:00:00Z", updatedAt: "2026-10-26T10:00:00Z", usedOn: { rows: 0, doors: 0 } }],
  recoverAsks: 0,
};
const sent = [];
const uploads = [];
let seq = 700;
const doorLookInfo = (id) => { const l = W.looks.find((x) => x.id === id); return l ? { thumbUrl: l.thumbUrl, status: l.status, name: l.name } : null; };
const entryOut = (e) => ({ ...e, usedOn: W.fixtures.filter((r) => W.fixtureLinks[r.id] === e.id).map((r) => r.name), ...(e.look.doorLookId ? { doorLook: doorLookInfo(e.look.doorLookId) } : {}) });
function settings(body) {
  switch (body.action) {
    case "status":
      return { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, ssQuoteNext: 1, ssInvoiceNext: 1, businessAddress: {}, branding: {}, emailReady: true };
    case "catalog":
      return { ok: true, clientId: CLIENT, styles: [], sizes: [], items: [], inclusions: [], layoutPricing: [], colors: [], fixtures: W.fixtures, windowColors: [], wallHeights: [],
        cladding: [], insulation: [], electrical: null, electricalItems: [], foundation: [], interiorWalls: null, interiorWallCoverings: [], claddingCourses: true,
        insulationEnabled: false, rampSettings: { mode: "simple", enabled: false }, aiReady: true, wallet: null,
        libraryBeta: true, library: { entries: W.entries, claddingLinks: {}, fixtureLinks: W.fixtureLinks },
        doorLooksBeta: W.doorLooksBeta, doorWallet: { priceCents: 500, meterActive: false, exempt: false }, doorLookAiOn: W.doorLooksBeta };
    case "library":
      return { ok: true, templates: W.templates, entries: W.entries.map(entryOut), requests: [], requestPrice: { priceCents: 200, active: false, exempt: false } };
    case "list_door_looks":
      if (!W.doorLooksBeta) return [{ error: "Door looks aren't turned on for your account.", code: "door_looks_off" }, 403];
      return { ok: true, looks: W.looks };
    case "door_ref_upload_url":
      return { ok: true, bucket: "door-refs", uploads: (body.contentTypes || []).map(() => ({ path: `${CLIENT}/door-ref-${U(seq++)}.jpg`, token: "tok-" + seq })) };
    case "generate_door_look_recover":
      W.recoverAsks++;
      return W.recoverAsks === 1 ? { ok: true, pending: true }
        : { ok: true, pending: false, reason: "failed", message: "This took too long. Please try again. You haven't been charged.", code: "ai_door_timeout", retryable: true };
    case "door_look_thumb_upload_url":
      return { ok: true, bucket: "fixtures", path: `${CLIENT}/door-look-${U(seq++)}.png`, token: "tok-thumb", url: null };
    case "save_door_look": {
      const l = W.looks.find((x) => x.id === body.id);
      if (!l) return [{ error: "That 3D look isn't in your catalog any more.", code: "door_look_not_found" }, 404];
      if (l.version !== body.version) return [{ error: "This look was changed somewhere else.", code: "door_look_conflict" }, 409];
      Object.assign(l, { name: body.name, status: "ready", version: l.version + 1, thumbUrl: body.thumbPath ? `https://${REF}.supabase.co/storage/v1/object/public/fixtures/${body.thumbPath}` : l.thumbUrl });
      return { ok: true, look: l };
    }
    case "library_add": {
      if (!body.doorLookId) return [{ error: "Not in this harness." }, 400];
      const l = W.looks.find((x) => x.id === body.doorLookId);
      if (!l || l.status !== "ready") return [{ error: "Save that 3D door first, then add it to your library.", code: "library_door_look_not_ready" }, 409];
      const e = { id: U(seq++), category: "door", name: body.name, look: { doorStyle: l.base, doorLookId: l.id }, templateId: null, templateVersion: null, active: true, sortOrder: 0, usedOn: [] };
      W.entries.push(e);
      return { ok: true, entry: entryOut(e) };
    }
    case "save_fixture": {
      const r = W.fixtures.find((x) => x.id === body.id);
      if (r) {
        if (body.doorStyle) r.door_style = body.doorStyle;
        if (body.clientLibraryId !== undefined) { if (body.clientLibraryId) W.fixtureLinks[r.id] = body.clientLibraryId; else delete W.fixtureLinks[r.id]; }
      }
      return { ok: true, id: body.id };
    }
    default:
      return { ok: true };
  }
}
// The press: the first one's stream breaks off mid-answer (a cut connection); the lean retry draws.
function generate(route, body, json) {
  if (body.lean !== true) return route.fulfill({ status: 200, contentType: "application/json", headers: H, body: "          {\"ok\": tr" });
  const look = { id: LOOK_NEW, name: body.name, base: SPEC.base, spec: SPEC, v: 1, status: "draft", thumbUrl: null, version: 1, fromPhoto: true, createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z" };
  W.looks.unshift({ ...look, usedOn: { rows: 0, doors: 0 } });
  return json(route, { ok: true, lookId: LOOK_NEW, look, spec: SPEC, warnings: [WARNING], checkId: U(901), pressStartedAt: "2026-10-27T12:00:00Z", lean: true, balanceCents: null });
}

// supabase-js sends a Blob as multipart form data: the file part's own bytes and Content-Type.
function fileOf(raw, type) {
  const m = /boundary=(.+)$/.exec(type);
  if (!m) return { bytes: raw, type };
  for (const p of raw.toString("latin1").split("--" + m[1])) {
    const i = p.indexOf("\r\n\r\n");
    if (i < 0) continue;
    const head = p.slice(0, i), ct = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (!/filename=/i.test(head) && !ct) continue;
    return { bytes: Buffer.from(p.slice(i + 4, p.length - 2), "latin1"), type: ct ? ct[1].trim() : "" };
  }
  return { bytes: raw, type };
}
// A JPEG's size from its first SOF marker (what the server's imageHeadOf reads).
function jpegSize(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
    i += 2 + len;
  }
  return null;
}
const hasExif = (b) => { for (let i = 2; i + 3 < Math.min(b.length, 4096); i++) if (b[i] === 0xff && b[i + 1] === 0xe1) return true; return false; };

// ── The page ─────────────────────────────────────────────────────────────────────────────────
const { ok, failed } = reporter();
const shots = shotsDir("door-from-photo");
const { browser, ctx } = await launch({ width: 1400, height: 1000 });
await ctx.addInitScript(([ref, s]) => { try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* blocked */ } }, [REF, SESSION]);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
// Nothing leaves the machine but the 3D's own three.js module GETs (lib.mjs's PASS_THROUGH_GET).
await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href),
  (route) => (route.request().method() === "GET" && PASS_THROUGH_GET.test(route.request().url()) ? route.continue() : route.abort()));
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
  if (url.includes("/storage/v1/")) {
    const m = /\/object\/upload\/sign\/([^/]+)\/(.+?)\?/.exec(url);
    uploads.push({ bucket: m ? m[1] : null, path: m ? decodeURIComponent(m[2]) : null, ...fileOf(req.postDataBuffer() || Buffer.alloc(0), req.headers()["content-type"] || "") });
    return json(route, { Key: m ? `${m[1]}/${m[2]}` : "x" });
  }
  if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
  if (url.includes("/portal-settings")) {
    sent.push({ fn: "portal-settings", ...body });
    if (body.action === "generate_door_look") return generate(route, body, json);
    const out = settings(body);
    return Array.isArray(out) ? json(route, out[0], out[1]) : json(route, out);
  }
  return json(route, { ok: true });
};
await page.route(`**/${REF}.supabase.co/**`, handler);
await page.route(`**/${REF}.functions.supabase.co/**`, handler);
const go = async (path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForTimeout(1400);
};
const actions = (name) => sent.filter((x) => x.action === name);
const boot = async () => {
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(800);
};
// Open the door line's own editor (the card's buttons come first in the page).
const openDoorEditor = async () => {
  const doorEdit = page.locator("button", { hasText: /^Edit$/ });
  for (let i = 0; i < (await doorEdit.count()) && (await page.locator("[data-ss-door-look-library]").count()) === 0; i++) { await doorEdit.nth(i).click().catch(() => {}); await page.waitForTimeout(300); }
};

// The photo: a made-up board door with a Z brace, three T-straps and a latch, on a grey wall, seen from
// a little to the left and below (a quad, not a rectangle). Its leaf corners are known, so the dots can
// be dragged onto them.
const PHOTO = { w: 1500, h: 2000, quad: [[430, 300], [1110, 360], [1120, 1690], [420, 1760]] };
async function makePhoto() {
  return page.evaluate(async ({ w, h, quad }) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#b9bfc4"; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 24) { g.fillStyle = x % 48 ? "#b2b8bd" : "#c0c6ca"; g.fillRect(x, 0, 12, h); }
    g.fillStyle = "#8d9296"; g.fillRect(0, 1760, w, h - 1760);
    // The door as a projective map of a unit square onto the quad (bilinear is close enough at this skew).
    const P = (u, v) => {
      const top = [quad[0][0] + (quad[1][0] - quad[0][0]) * u, quad[0][1] + (quad[1][1] - quad[0][1]) * u];
      const bot = [quad[3][0] + (quad[2][0] - quad[3][0]) * u, quad[3][1] + (quad[2][1] - quad[3][1]) * u];
      return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
    };
    const poly = (pts, fill, stroke, lw = 3) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p))); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
    // Casing, then the leaf, then 8 boards.
    poly([P(-0.07, -0.04), P(1.07, -0.04), P(1.07, 1), P(-0.07, 1)], "#f1ece0");
    poly([P(0, 0), P(1, 0), P(1, 1), P(0, 1)], "#7a5534");
    for (let k = 1; k < 8; k++) { g.beginPath(); g.moveTo(...P(k / 8, 0)); g.lineTo(...P(k / 8, 1)); g.strokeStyle = "#4f3520"; g.lineWidth = 3; g.stroke(); }
    // Rails and the Z.
    for (const [v0, v1] of [[0.04, 0.12], [0.46, 0.54], [0.88, 0.96]]) poly([P(0, v0), P(1, v0), P(1, v1), P(0, v1)], "#6b4a2d", "#4f3520", 2);
    poly([P(0.02, 0.88), P(0.14, 0.88), P(0.98, 0.54), P(0.86, 0.54)], "#6b4a2d", "#4f3520", 2);
    poly([P(0.02, 0.46), P(0.14, 0.46), P(0.98, 0.12), P(0.86, 0.12)], "#6b4a2d", "#4f3520", 2);
    // Three black T-straps on the left, and a latch on the right.
    for (const v of [0.08, 0.5, 0.92]) { poly([P(0, v - 0.012), P(0.42, v - 0.006), P(0.42, v + 0.006), P(0, v + 0.012)], "#202326"); poly([P(-0.05, v - 0.03), P(0.01, v - 0.03), P(0.01, v + 0.03), P(-0.05, v + 0.03)], "#202326"); }
    poly([P(0.86, 0.5), P(0.95, 0.5), P(0.95, 0.53), P(0.86, 0.53)], "#202326");
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, PHOTO);
}
// Drag dot i to a point in the photo's own pixels.
async function dragDot(i, pt) {
  const dot = page.locator(`[data-ss-door-corner='${i}']`);
  await dot.scrollIntoViewIfNeeded();
  const box = await page.locator("[data-ss-door-corners] img").boundingBox();
  const db = await dot.boundingBox();
  const sx = box.width / PHOTO.w, sy = box.height / PHOTO.h;
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + pt[0] * sx, box.y + pt[1] * sy, { steps: 8 });
  await page.mouse.up();
}

try {
  await boot();

  // ── A: door looks off ──
  await go("/settings/doors");
  await page.waitForSelector("[data-ss-library='door']", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  ok("A door looks off: the Library card has no photo box", (await page.locator("[data-ss-library='door']").count()) === 1 && (await page.locator("[data-ss-door-from-photo]").count()) === 0);
  await openDoorEditor();
  const offOpts = await page.locator("[data-ss-door-look-library] option").evaluateAll((els) => els.map((e) => e.textContent));
  ok("A ...and a door's look picker offers no photo option", offOpts.length > 0 && !offOpts.some((t) => /from a photo/.test(t)), JSON.stringify(offOpts));
  ok("A list_door_looks is never asked", actions("list_door_looks").length === 0);

  // ── B: on ──
  W.doorLooksBeta = true;
  await boot();
  await go("/settings/doors");
  await page.waitForSelector("[data-ss-door-from-photo]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const boxB = await page.locator("[data-ss-door-from-photo]").boundingBox();
  const searchB = await page.locator("[data-ss-library='door'] input[type='search']").boundingBox();
  const browseB = await page.locator("[data-ss-library='door']").getByRole("button", { name: /Browse the StructureStudio library/ }).boundingBox();
  ok("B the photo box sits to the right of the search and Browse, on the same band", !!boxB && !!searchB && !!browseB && boxB.x > browseB.x + browseB.width && boxB.y < searchB.y + searchB.height && boxB.y + boxB.height > searchB.y,
    JSON.stringify({ boxB, searchB, browseB }));
  ok("B it says what it does", /Don.t see your door\?/.test(await page.locator("[data-ss-door-from-photo]").innerText()));
  ok("B a door drafted from a photo and not in the library is listed with Review", (await page.locator("[data-ss-door-waiting=\"Yesterday's draft\"]").count()) === 1);
  await page.locator("[data-ss-library='door']").screenshot({ path: join(shots, "01-library-card-with-photo-box.png") });

  // ── C: the photo step ──
  await page.locator("[data-ss-door-open]").click();
  await page.waitForSelector("[data-ss-door-studio='photo']");
  ok("C the money line: free while the meter is off", /Free right now\./.test(await page.locator("[data-ss-door-price]").innerText()));
  await page.getByPlaceholder("e.g. Ranch barn door").fill("Ranch barn door");
  await page.getByRole("spinbutton", { name: "Width in inches" }).fill("80");
  await page.getByRole("spinbutton", { name: "Height in inches" }).fill("36");
  const photo = Buffer.from(await makePhoto(), "base64");
  writeFileSync(join(shots, "00-made-up-door-photo.jpg"), photo);
  await page.locator("[data-ss-door-front]").setInputFiles({ name: "barn-door.jpg", mimeType: "image/jpeg", buffer: photo });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "02-photo-step.png") });
  await page.getByRole("button", { name: "Next: mark the corners" }).click();
  await page.waitForSelector("[data-ss-door-corners]");
  await page.waitForTimeout(300);

  // ── D: the corners ──
  for (let i = 0; i < 4; i++) await dragDot(i, PHOTO.quad[i]);
  await page.screenshot({ path: join(shots, "03-corners.png") });
  await page.locator("[data-ss-door-studio]").getByRole("button", { name: "Straighten", exact: true }).click();
  await page.waitForTimeout(400);
  ok("D the size typed the wrong way round is refused, before anything is uploaded", /doesn't match the door's size/.test(await page.locator("[data-ss-door-error]").innerText().catch(() => "")) && actions("door_ref_upload_url").length === 0);
  await page.locator("[data-ss-door-studio]").getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Width in inches" }).fill("36");
  await page.getByRole("spinbutton", { name: "Height in inches" }).fill("80");
  await page.getByRole("button", { name: "Next: mark the corners" }).click();
  await page.waitForSelector("[data-ss-door-corners]");
  for (let i = 0; i < 4; i++) await dragDot(i, PHOTO.quad[i]);
  await page.locator("[data-ss-door-studio]").getByRole("button", { name: "Straighten", exact: true }).click();
  await page.waitForSelector("[data-ss-door-straight]", { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "04-straightened.png") });

  // ── E: the press ──
  await page.locator("[data-ss-door-generate]").click();
  await page.waitForSelector("[data-ss-door-studio='press']");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, "05-drawing.png") });
  await page.waitForSelector("[data-ss-door-studio='review']", { timeout: 90000 });
  const gens = actions("generate_door_look"), recs = actions("generate_door_look_recover");
  const front = uploads.find((u) => u.bucket === "door-refs");
  const size = front ? jpegSize(front.bytes) : null;
  const want = (36 + 2 * 2) / 80;
  ok("D the photo that went up is the straightened one: (36 + 4) / 80 within 3%", !!size && Math.abs(size.w / size.h / want - 1) <= 0.03, JSON.stringify(size));
  ok("D ...inside 1568 px and 1.15 MP, a JPEG with no EXIF", !!size && Math.max(size.w, size.h) <= 1568 && size.w * size.h <= Math.floor(1.15 * 1024 * 1024) && front.type.includes("image/jpeg") && !hasExif(front.bytes), JSON.stringify({ size, type: front && front.type }));
  ok("D it went to the private bucket at the path the server picked", !!front && new RegExp(`^${CLIENT}/door-ref-${UUID_RE}\\.jpg$`).test(front.path) && gens[0] && gens[0].photos && gens[0].photos.front === front.path, JSON.stringify({ path: front && front.path, sent: gens[0] && gens[0].photos }));
  ok("E the press streams, with its size, name and one key", gens.length === 2 && gens[0].stream === true && gens[0].widthIn === 36 && gens[0].heightIn === 80 && gens[0].leaves === 1 && gens[0].name === "Ranch barn door" && /^dl/.test(gens[0].idempotencyKey || ""),
    JSON.stringify(gens.map((g) => ({ stream: g.stream, lean: g.lean, key: g.idempotencyKey }))));
  ok("E the dropped stream is picked up by the SAME key (pending, then a retryable failure)", recs.length === 2 && recs.every((r) => r.idempotencyKey === gens[0].idempotencyKey), JSON.stringify(recs.map((r) => r.idempotencyKey)));
  ok("E then ONE lean retry, same key, streamed", gens[1] && gens[1].lean === true && gens[1].stream === true && gens[1].idempotencyKey === gens[0].idempotencyKey && JSON.stringify(gens[1].photos) === JSON.stringify(gens[0].photos));

  // ── F: the review ──
  await page.waitForSelector("[data-ss-door-shot='front']", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);
  const shotsDrawn = await page.locator("[data-ss-door-shot]").evaluateAll((els) => els.map((e) => ({ view: e.getAttribute("data-ss-door-shot"), w: e.naturalWidth, h: e.naturalHeight, png: e.src.startsWith("data:image/png") })));
  ok("F our 3D door is drawn three ways by the designer's renderer", shotsDrawn.length === 3 && shotsDrawn.every((s) => s.w > 100 && s.h > 100 && s.png) && shotsDrawn.map((s) => s.view).join() === "front,left35,right35", JSON.stringify(shotsDrawn));
  ok("F beside the straightened photo, with the draft's warning", (await page.locator("[data-ss-door-studio='review'] img[alt='Your photo']").count()) === 1 && (await page.locator("[data-ss-door-warnings]").innerText()).includes(WARNING));
  // The drawn door is the door (not the wall): its front shot's middle column is mostly the board colour.
  const look = await page.locator("[data-ss-door-shot='front']").evaluate(async (img) => {
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.floor(c.width / 2), 0, 1, c.height).data;
    let warm = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 2] + 18) warm++;
    return { warm: warm / c.height };
  });
  ok("F ...and the front shot is the door itself, framed (a board-door brown down its middle)", look.warm > 0.4, JSON.stringify(look));
  await page.screenshot({ path: join(shots, "06-review.png") });

  // ── G: save ──
  await page.locator("[data-ss-door-name]").fill("Ranch barn door");
  await page.locator("[data-ss-door-save]").click();
  await page.waitForSelector("[data-ss-door-saved]", { timeout: 20000 });
  const tile = uploads.find((u) => u.bucket === "fixtures");
  const sv = actions("save_door_look").pop(), add = actions("library_add").pop();
  ok("G the tile is our front render, a PNG at the path the server handed out", !!tile && tile.bytes[0] === 0x89 && tile.bytes[1] === 0x50 && new RegExp(`^${CLIENT}/door-look-${UUID_RE}\\.png$`).test(tile.path) && sv && sv.thumbPath === tile.path, JSON.stringify({ path: tile && tile.path, thumbPath: sv && sv.thumbPath }));
  ok("G the draft is saved Ready under its own version", !!sv && sv.id === LOOK_NEW && sv.version === 1 && sv.name === "Ranch barn door" && sv.spec === undefined, JSON.stringify(sv));
  ok("G then added to the library by its doorLookId", !!add && add.doorLookId === LOOK_NEW && add.name === "Ranch barn door" && add.templateId === undefined, JSON.stringify(add));
  await page.screenshot({ path: join(shots, "07-saved.png") });
  await page.locator("[data-ss-door-studio]").getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(1200);

  // ── H: in the library and in a door's look ──
  ok("H the box no longer lists it as waiting", (await page.locator("[data-ss-door-waiting='Ranch barn door']").count()) === 0);
  await page.locator("[data-ss-library='door']").getByRole("button", { name: /Browse the StructureStudio library/ }).click();
  await page.waitForTimeout(400);
  const ent = page.locator("[data-ss-library-entry='Ranch barn door']");
  ok("H the library lists it, made from the photo, with its tile", (await ent.count()) === 1 && /Made from your photo, drawn over Board-and-batten with a Z brace/.test(await ent.innerText())
    && (await page.locator("[data-ss-library='door'] img[src*='door-look-']").count()) >= 1);
  await ent.getByRole("button", { name: "Rename" }).click();
  ok("H ...rename only: no look picker on it", (await page.locator("[data-ss-library-entry='Ranch barn door'] select").count()) === 0);
  await page.locator("[data-ss-library-entry='Ranch barn door']").getByRole("button", { name: "Cancel" }).click();
  await page.locator("[data-ss-library='door']").screenshot({ path: join(shots, "08-in-the-library.png") });
  await openDoorEditor();
  const opts = await page.locator("[data-ss-door-look-library] option").evaluateAll((els) => els.map((e) => e.textContent));
  ok("H a door's How it looks in 3D lists it, and Make one from a photo…", opts.includes("Ranch barn door") && opts.includes("Make one from a photo…"), JSON.stringify(opts));
  await page.locator("[data-ss-door-look-library]").selectOption({ label: "Ranch barn door" });
  await page.screenshot({ path: join(shots, "09-door-look-picker.png") });
  await page.getByRole("button", { name: /^Save( door)?$/ }).last().click();
  await page.waitForTimeout(1200);
  const sf = actions("save_fixture").pop();
  const entry = W.entries.find((e) => e.name === "Ranch barn door");
  ok("H picking it saves its clientLibraryId, drawn over the look's base", !!sf && !!entry && sf.clientLibraryId === entry.id && sf.doorStyle === "zbrace" && sf.doorLookId === undefined, JSON.stringify(sf && { clientLibraryId: sf.clientLibraryId, doorStyle: sf.doorStyle, doorLookId: sf.doorLookId }));

  ok("I no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("the run finished", false, e.message);
  await page.screenshot({ path: join(shots, "zz-failure.png") }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed().length ? 1 : 0);
