// Page 2 of the quote from all four corners (migration 276), driven through a real submit on the
// COMPILED designer, and checked on what actually left the browser: the pages inside the uploaded
// PDF, the 3D image uploaded beside it, and the payload sent to submit-estimate.
//
// Carolyn, 2026-08-20: a 3D page that is "optional for them" and "gets 4 sides. So 4 quadrants";
// 2026-09-08, in writing: "we want to see 4 images... one from each corner". A builder switches it
// on in Settings → Company; get_config then carries `quoteCornerViews: true`.
//
//   A. switch absent (every builder today): 2 pages, page 2 the 1200 x 900 single view, exactly as
//      before; the 3D image beside it is that view
//   B. switch on: 2 pages, page 2 ONE letter-sized sheet (1632 x 2112) with a real building in each
//      quadrant, four different views; the 3D image beside the PDF is still the 1200 x 900 single
//      view (the order screen's card and the quote thumbnail do not change); submit-estimate is told
//      about it as before. A door on the south wall makes that the FRONT, as the plan sheet says.
//   C. 3D off, switch on: the plan alone, no 3D image (the 2026-09-21 fix, quoteNo3dWhenOff, holds)
//   D. switch on, but the sheet cannot be encoded: page 2 falls back to the single view and the
//      quote still goes
//   E. switch on, and the customer frames a view in the full-screen 3D and presses its button: the
//      button offers "Use this view as my quote's picture" and then says "Picture saved", never
//      "in my quote" or "Added to quote", because page 2 is still the four-corner sheet; the framed
//      view is the 3D image beside the PDF (the viewer's own frame, not the 1200 x 900 default)
//   F. switch absent, the same framed view: the button keeps "Use this view in my quote" and "Added
//      to quote", and that view IS page 2
//
// B's PDF and its page 2 are written to the shots folder (sample-quote.pdf, corner-sheet.jpg): the
// picture to show Carolyn. Supabase is stubbed at the network layer; nothing leaves the machine and
// nothing is saved anywhere.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root, after npm run compile)
//   node tests/harness/quoteCornerViews.mjs          (exit 0 = every check held)
//
// SS_SHOTS=<dir> puts the shots and the sample there. To prove the checks can fail, serve the tree
// before this change (git archive 135699d) and point SS_BASE at it: 6 of B's checks fail (page 2 is
// the 1200 x 900 view, no quadrants, no door to find) and A, C and D hold, as they should. E's two
// button checks fail against the tree before the viewer was told about the switch (it said "Added
// to quote" over a view the PDF left out); F holds on both.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, buildingRect, svgPoint, revealTool, readItems, REF } from "./lib.mjs";

const CLIENT = "harness-corners";
const SIZE = "12x16";
const STYLE = "Harness Gable";
const COLORS = { body: "#7A2E2A", trim: "#F4F1EA", roof: "#3B3F45" };
const D3 = { roof: { type: "gable", pitch: 0.5, overhang: 0.75 }, siding: "lap", colors: COLORS, wallHeightFt: 8, roofMaterial: "shingle" };
const FIXTURES = {
  ramp: { mode: "simple", price: 0, method: "each", enabled: false, imageUrl: null, showImage: false },
  items: [{ id: "d-walk", name: "Harness Walk Door", price: 300, widthIn: 36, heightIn: 80, category: "door", colorMode: "fixed", planLabel: "WD", sortOrder: 0, imageUrl: null,
    sillIn: null, sillMode: "fixed", opLeft: false, opRight: true, opDouble: false, opSlideUp: false, opDefault: "right", swingIn: false, swingOut: true, swingDefault: null, hasTrimColor: false }],
  windowColors: [],
};

const config = ({ view3d = true, corners } = {}) => {
  const [w, l] = SIZE.split("x").map(Number);
  const cfg = {
    clientId: CLIENT,
    branding: { companyName: "Acme Sheds", accentColor: "#1D4ED8", headerBg: "#FFFFFF", tagline: null, logo: null },
    contactFields: ["name", "email", "phone"],
    buildingStyles: [{ value: "gab", label: STYLE, img: null, sizes: [SIZE], sizeInclusions: {}, sizeInclusionQty: {}, d3: D3 }],
    defaultSizes: [SIZE],
    sizePricing: { gab: { [SIZE]: { widthFt: w, lengthFt: l, basePrice: 9000 } } },
    options: [], colors: [], claddingOptions: {}, wallHeightOptions: {},
    showPricing: true, view3d, layoutItems: {}, layoutPricing: {}, layoutPrices: {},
    electrical: null, electricalItems: [], insulation: [],
  };
  // SPARSE, as get_config emits it (migration 276): the key is there only when the switch is on.
  if (corners !== undefined) cfg.quoteCornerViews = corners;
  return cfg;
};

// ── What is inside a PDF buildPdfFromJpegPages wrote ──
const countPdfPages = (buf) => (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
function pdfImages(buf) {
  const b = Buffer.from(buf);
  const s = b.toString("latin1");   // one char per byte, so string offsets are byte offsets
  const re = /\/Subtype \/Image \/Width (\d+) \/Height (\d+) [^>]*\/Length (\d+) >>\nstream\n/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const at = m.index + m[0].length;
    out.push({ w: Number(m[1]), h: Number(m[2]), bytes: b.subarray(at, at + Number(m[3])) });
  }
  return out;
}
// A JPEG's own width and height, from its start-of-frame marker.
function jpegSize(buf) {
  const b = Buffer.from(buf);
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) return null;
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

// The sheet's four picture cells, from the layout renderQuoteCornerSheet draws (D3_QUOTE_SHEET:
// 1632 x 2112, half-inch margins, 700 x 525 cells, the block centred on the page).
function sheetCells() {
  const M = 96, GAP = 40, cellW = 700, cellH = 525, LABEL = 30, LABEL_GAP = 14;
  const rowH = LABEL + LABEL_GAP + cellH;
  const blockH = 46 + 18 + 26 + 56 + rowH * 2 + GAP;
  const top = Math.max(M, Math.round((2112 - blockH) / 2));
  const gridTop = top + 46 + 18 + 26 + 56;
  return [0, 1, 2, 3].map((i) => ({ x: M + (i % 2) * (cellW + GAP), y: gridTop + Math.floor(i / 2) * (rowH + GAP) + LABEL + LABEL_GAP, w: cellW, h: cellH }));
}

// Per cell: how much of it is building rather than the backdrop (sky and grass), and where the walk
// door is. The door is on the FRONT wall, so it must show in the two front quadrants and not in the
// two back ones; and it must sit right of centre from the front-left corner and left of centre from
// the front-right one, or the labels are mirrored. Read in the browser, which decodes the JPEG. The
// colour bands were measured off this harness's own sheet (sky #E7EEF5, the grass, the olive slab a
// fixture door with no photo is painted).
async function readSheet(page, bytes, cells) {
  return page.evaluate(async ({ b64, cells }) => {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = "data:image/jpeg;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = im.width; cv.height = im.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(im, 0, 0);
    const sky = (r, g, b) => Math.abs(r - 0xE7) + Math.abs(g - 0xEE) + Math.abs(b - 0xF5) < 40;
    const grass = (r, g, b) => g > r + 12 && g > b + 12;
    const door = (r, g, b) => r >= 80 && r <= 140 && g >= 60 && g <= 120 && b >= 30 && b <= 85 && r > g && g > b && g - b >= 15 && r - g <= 40;
    const stats = cells.map((c) => {
      const W = c.w - 8, H = c.h - 8;
      const d = ctx.getImageData(c.x + 4, c.y + 4, W, H).data;
      let built = 0, doors = 0, doorX = 0, n = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const k = (y * W + x) * 4;
          const r = d[k], g = d[k + 1], b = d[k + 2];
          n++;
          if (sky(r, g, b) || grass(r, g, b)) continue;
          built++;
          if (door(r, g, b)) { doors++; doorX += x; }
        }
      }
      return { built: built / n, door: doors / n, doorAt: doors ? doorX / doors / W : null };
    });
    // The margin outside the block is plain white paper.
    const corner = ctx.getImageData(10, 10, 60, 60).data;
    let white = true;
    for (let k = 0; k < corner.length; k += 4) if (corner[k] < 245 || corner[k + 1] < 245 || corner[k + 2] < 245) { white = false; break; }
    return { w: im.width, h: im.height, built: stats.map((s) => s.built), door: stats.map((s) => s.door), doorAt: stats.map((s) => s.doorAt), white };
  }, { b64: Buffer.from(bytes).toString("base64"), cells });
}

const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function placeFrontDoor(page) {
  const r = await buildingRect(page);
  const l = Number(SIZE.split("x")[1]);
  const pt = await svgPoint(page, r.x + r.w / 2, r.y + r.h - 0.4 * (r.h / l));
  await (await revealTool(page, /^Door wall$/)).click();
  await settle(page, 300);
  await page.mouse.click(pt.x, pt.y);
  await settle(page, 600);
  await page.getByText("Harness Walk Door", { exact: true }).first().click({ timeout: 10000 });
  await settle(page, 300);
  await page.getByRole("button", { name: "Place door" }).click();
  await settle(page, 600);
  return ((await readItems(page)) || []).find((i) => /door/i.test(String(i.type)));
}

// The full-screen viewer, as a customer reaches it: the docked 3D first, then "Edit in 3D".
// __SS3D_DEBUG publishes the viewer's engine as window.__ss3dEngine, which is how the model is known
// to be built before the buttons are read.
async function openViewer(page) {
  const show = page.getByRole("button", { name: /Show 3D|3D View/ });
  if (!(await page.evaluate(() => !!(window.__ss3dPanel && window.__ss3dPanel.model))) && await show.count()) await show.first().click();
  await page.waitForFunction(() => !!(window.__ss3dPanel && window.__ss3dPanel.model), null, { timeout: 60000 });
  await settle(page, 800);
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  await edit.first().waitFor({ state: "visible", timeout: 60000 });
  await page.evaluate(() => { window.__ss3dEngine = null; });
  await edit.first().click();
  await page.waitForFunction(() => { const E = window.__ss3dEngine; return !!(E && E.model && E.model.roofGroup && E.model.roofGroup.children.length > 0); }, null, { timeout: 90000 });
  await settle(page, 1200);
}
// The viewer's quote button: what it says, then what it says once pressed. Read off the viewer's
// own overlay (found from its canvas), so nothing else on the page can answer for it.
async function armViewerShot(page, shots, name) {
  await openViewer(page);
  const read = () => page.evaluate(() => {
    let el = window.__ss3dEngine.renderer.domElement;
    while (el && el !== document.body && getComputedStyle(el).position !== "fixed") el = el.parentElement;
    const root = el || document.body;
    const b = [...root.querySelectorAll("button")].find((x) => /📸|✓ /u.test(x.textContent) && /estimate|Picture/.test(x.textContent));
    return { button: b ? b.textContent.trim() : "", text: root.innerText };
  });
  const before = await read();
  await page.locator("button").filter({ hasText: /^📸 Use this view/u }).first().click({ timeout: 10000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((x) => /^✓ /u.test(x.textContent.trim())), null, { timeout: 20000 }).catch(() => {});
  await settle(page, 400);
  const after = await read();
  await page.screenshot({ path: join(shots, `${name}-viewer.png`) }).catch(() => {});
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await page.waitForFunction(() => !(window.__ss3dEngine && window.__ss3dEngine.renderer.domElement.isConnected), null, { timeout: 30000 }).catch(() => {});
  await settle(page, 800);
  return { before, after };
}

async function run(tag, { view3d = true, corners, door = false, breakSheet = false, armShot = false }, ok, shots) {
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  if (armShot) await page.addInitScript(() => { window.__SS3D_DEBUG = true; });
  if (breakSheet) {
    // The sheet's own encode answers "data:," (a lost context), and nothing else's does.
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...a) {
        if (this.width === 1632 && this.height === 2112) return "data:,";
        return orig.apply(this, a);
      };
    });
  }
  const uploads = [];
  const submits = [];
  const storage = async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    const path = new URL(req.url()).pathname;
    let bytes = null;
    try { bytes = req.postDataBuffer(); } catch (_e) { bytes = null; }
    uploads.push({ path, bytes });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ Key: path }) });
  };
  await stubSupabase(page, { config: config({ view3d, corners }), fixtures: FIXTURES });
  // stubSupabase's routes are registered first, and Playwright runs the LAST registered match first.
  await page.route(`**/${REF}.supabase.co/storage/v1/object/**`, storage);
  await page.route(`**/functions/v1/submit-estimate**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    try { submits.push(JSON.parse(req.postData() || "{}")); } catch (_e) { submits.push({}); }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, shortCode: "SS-TEST" }) });
  });

  const out = { pdf: null, page2: null };
  try {
    await openDesigner(page, CLIENT);
    await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
    await page.locator("[data-ss-style]").first().click();
    await settle(page, 600);
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
    if (await sel.count()) await sel.first().selectOption({ label: SIZE });
    await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), 16, { timeout: 20000 });
    await settle(page, 1000);
    if (door) {
      const d = await placeFrontDoor(page);
      ok(`${tag} a walk door is on the south wall, so the south wall is the FRONT`, d && d.wall === "south", JSON.stringify(d && { type: d.type, wall: d.wall }));
    }
    if (armShot) {
      const v = await armViewerShot(page, shots, tag.trim().replace(/\W+/g, "-"));
      if (corners === true) {
        ok(`${tag} the 3D viewer offers the framed view as the estimate's picture, not "in my estimate"`,
          v.before.button === "📸 Use this view as my estimate's picture" && !/in my estimate/.test(v.before.text), v.before.button);
        ok(`${tag} and once pressed says the picture is saved, never "Added to estimate"`,
          v.after.button === "✓ Picture saved — retake?" && !/Added to estimate/.test(v.after.text), v.after.button);
      } else {
        ok(`${tag} the 3D viewer still offers "Use this view in my estimate"`, v.before.button === "📸 Use this view in my estimate", v.before.button);
        ok(`${tag} and once pressed says "Added to estimate", because that view is page 2`, v.after.button === "✓ Added to estimate — retake?", v.after.button);
      }
    }
    // 555-01xx is reserved for fiction, the same number the e2e suite uses.
    await page.getByPlaceholder("Full Name").fill("Pat Tester");
    await page.getByPlaceholder("email@example.com").fill("pat@example.com");
    await page.getByPlaceholder("(555) 555-5555").fill("5550104477");
    await settle(page, 600);
    // The footer CTA, not the stepper's own "Get quote" step (see quoteNo3dWhenOff.mjs).
    const quote = page.locator("button.ssd-ft-cta.is-quote").first();
    await quote.scrollIntoViewIfNeeded();
    await quote.click();
    // Five off-screen WebGL passes on SwiftShader with the switch on; wait for the submit itself.
    const t0 = Date.now();
    while (submits.length === 0 && Date.now() - t0 < 120000) await page.waitForTimeout(500);
    await settle(page, 500);

    const pdfs = uploads.filter((u) => u.path.endsWith(".pdf") && u.bytes);
    const shots3d = uploads.filter((u) => /-3d-\d+\.jpg$/.test(u.path) && u.bytes);
    const pdf = pdfs.length ? pdfs[pdfs.length - 1].bytes : null;
    const pages = pdf ? countPdfPages(pdf) : 0;
    const imgs = pdf ? pdfImages(pdf) : [];
    const payload = submits[submits.length - 1] || {};
    ok(`${tag} the quote was actually submitted`, submits.length === 1 && pdfs.length === 1, `submits ${submits.length}, pdfs ${pdfs.length}`);
    ok(`${tag} every page of the PDF is one picture, as buildPdfFromJpegPages writes it`, imgs.length === pages, `${imgs.length} image(s), ${pages} page(s)`);
    const p2 = imgs[1] || null;
    const p2dims = p2 ? `${p2.w} x ${p2.h}` : "none";
    const shot = shots3d.length ? jpegSize(shots3d[0].bytes) : null;
    if (!view3d) {
      ok(`${tag} the PDF is the plan ONLY`, pages === 1, `${pages} page(s)`);
      ok(`${tag} no 3D image is uploaded`, shots3d.length === 0, `${shots3d.length}`);
      ok(`${tag} submit-estimate carries no 3D image`, !payload.view3dImageUrl, `${payload.view3dImageUrl}`);
    } else {
      ok(`${tag} the PDF is the plan and one 3D page`, pages === 2, `${pages} page(s)`);
      const wantSheet = corners === true && !breakSheet;
      if (wantSheet) {
        ok(`${tag} page 2 is the four-corner sheet, letter-shaped (1632 x 2112)`, p2 && p2.w === 1632 && p2.h === 2112, p2dims);
        ok(`${tag} and the JPEG inside agrees`, p2 && JSON.stringify(jpegSize(p2.bytes)) === JSON.stringify({ w: 1632, h: 2112 }), JSON.stringify(p2 && jpegSize(p2.bytes)));
        if (p2) {
          const st = await readSheet(page, p2.bytes, sheetCells());
          const pct = (a) => a.map((f) => (f * 100).toFixed(2) + "%").join(" / ");
          ok(`${tag} every quadrant has a building in it (not an empty backdrop)`, st.built.every((f) => f > 0.04), pct(st.built));
          ok(`${tag} and none is all building (the building is framed, not cropped)`, st.built.every((f) => f < 0.6), pct(st.built));
          // Front left, front right, back left, back right (D3_QUOTE_CORNERS' order).
          const [fl, fr, bl, br] = st.door;
          ok(`${tag} the door (on the FRONT wall) shows in both front quadrants and in neither back one`,
            fl > 0.002 && fr > 0.002 && Math.max(bl, br) < Math.min(fl, fr) / 5, pct(st.door));
          ok(`${tag} 'Front left' sees the door right of centre and 'Front right' left of it (the labels are not mirrored)`,
            st.doorAt[0] != null && st.doorAt[1] != null && st.doorAt[0] > 0.53 && st.doorAt[1] < 0.47,
            st.doorAt.map((x) => (x == null ? "-" : x.toFixed(2))).join(" / "));
          ok(`${tag} the margins are white paper`, st.white);
        }
      } else if (armShot) {
        // The framed view is the viewer canvas's own size; renderDefault3DShot's is pinned at 1200 x 900.
        ok(`${tag} page 2 is the framed view itself (the 3D image's size, not the 1200 x 900 default)`,
          p2 && shot && p2.w === shot.w && p2.h === shot.h && !(p2.w === 1200 && p2.h === 900), `${p2dims}, 3D image ${JSON.stringify(shot)}`);
      } else {
        ok(`${tag} page 2 is the single 1200 x 900 view, as it has always been`, p2 && p2.w === 1200 && p2.h === 900, p2dims);
      }
      if (armShot) {
        ok(`${tag} the 3D image beside the PDF is the framed view (the viewer's frame, not the 1200 x 900 default)`,
          shots3d.length === 1 && shot && !(shot.w === 1200 && shot.h === 900), `${shots3d.length} upload(s), ${JSON.stringify(shot)}`);
      } else {
        ok(`${tag} the 3D image beside the PDF is the single 1200 x 900 view`, shots3d.length === 1 && shot && shot.w === 1200 && shot.h === 900, `${shots3d.length} upload(s), ${JSON.stringify(shot)}`);
      }
      ok(`${tag} submit-estimate is told about the 3D image`, Boolean(payload.view3dImageUrl), `${payload.view3dImageUrl}`);
    }
    ok(`${tag} no page or console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    out.pdf = pdf;
    out.page2 = p2 ? p2.bytes : null;
    await page.screenshot({ path: join(shots, `${tag.trim().replace(/\W+/g, "-")}.png`) });
  } catch (e) {
    ok(`${tag} drove the designer`, false, String((e && e.message) || e));
    await page.screenshot({ path: join(shots, `${tag.trim().replace(/\W+/g, "-")}-FAIL.png`) }).catch(() => {});
  }
  await browser.close();
  return out;
}

async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("quoteCornerViews");
  await run("A switch absent:", {}, ok, shots);
  const b = await run("B switch on:", { corners: true, door: true }, ok, shots);
  await run("C 3D off, switch on:", { view3d: false, corners: true }, ok, shots);
  await run("D switch on, sheet fails:", { corners: true, breakSheet: true }, ok, shots);
  await run("E switch on, a framed view:", { corners: true, door: true, armShot: true }, ok, shots);
  await run("F switch absent, a framed view:", { armShot: true }, ok, shots);
  if (b.pdf) writeFileSync(join(shots, "sample-quote.pdf"), Buffer.from(b.pdf));
  if (b.page2) writeFileSync(join(shots, "corner-sheet.jpg"), Buffer.from(b.page2));
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
