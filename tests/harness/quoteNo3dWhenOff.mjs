// A tenant with 3D switched off must not send a 3D view on anything.
//
// Nevin Friesen, reported by Carolyn on the 2026-09-21 call: "when he emails a quote, it is still
// sending the 3D view." He has 3D off.
//
// The cause was one missing condition in submitQuote. An armed snapshot was used when there was one,
// and when there was NOT one a default four-sided 3D sheet was rendered instead, so "a quote is never
// sent without a picture of the building". For a tenant with 3D off the viewer can never be opened, so
// there is never an armed snapshot — every quote they sent took the default-render branch and carried
// a 3D sheet.
//
// It reaches BOTH documents from that one place: the estimate and the invoice are built server-side by
// supabase/functions/_shared/quotePdf.ts, which appends `designs.image_url` — the PDF this harness
// inspects — as "page 1 the floor plan, page 2 the four-sided 3D sheet when one was captured".
//
// This drives a real submit twice against the same fixture, changing ONLY config.view3d, and asserts
// on what actually left the browser: the pages inside the uploaded PDF, the images uploaded beside it,
// and the payload sent to submit-estimate.
//
//   python -m http.server 8171 --bind 127.0.0.1   (repo root)
//   SS_BASE=http://127.0.0.1:8171 node tests/harness/quoteNo3dWhenOff.mjs
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, REF } from "./lib.mjs";
import { CONFIG as BASE_CONFIG } from "./electrical.mjs";

const CLIENT = "harness-3dgate";
const SIZE = "12x24";

const cfg = (view3d) => ({ ...BASE_CONFIG, clientId: CLIENT, view3d, showPricing: true });

// One page per JPEG is what buildPdfFromJpegPages emits, so counting page objects counts pictures.
// `/Type /Page` also matches inside `/Type /Pages`, hence the negative lookahead.
const countPdfPages = (buf) => (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;

async function run(view3d, ok, shots) {
  const { browser, ctx } = await launch({ width: 1440, height: 1000 });
  const page = await ctx.newPage();
  const errors = collectErrors(page);

  const uploads = [];          // every storage object this submit wrote
  const submits = [];          // every submit-estimate payload
  await page.route(`**/${REF}.supabase.co/storage/v1/object/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    const path = new URL(req.url()).pathname;
    let bytes = null;
    try { bytes = req.postDataBuffer(); } catch (_e) { bytes = null; }
    uploads.push({ path, bytes });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ Key: path }) });
  });
  await stubSupabase(page, { config: cfg(view3d) });
  // stubSupabase registers AFTER us and Playwright runs routes in reverse registration order, so the
  // storage route above would be shadowed. Re-register it on top.
  await page.route(`**/${REF}.supabase.co/storage/v1/object/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    const path = new URL(req.url()).pathname;
    let bytes = null;
    try { bytes = req.postDataBuffer(); } catch (_e) { bytes = null; }
    uploads.push({ path, bytes });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ Key: path }) });
  });
  await page.route(`**/functions/v1/submit-estimate**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    try { submits.push(JSON.parse(req.postData() || "{}")); } catch (_e) { submits.push({}); }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, shortCode: "SS-TEST" }) });
  });

  const tag = view3d ? "3D ON " : "3D OFF";
  try {
    await openDesigner(page, CLIENT);
    await page.waitForFunction(() => document.querySelector(".ssd-frame") !== null, null, { timeout: 40000 });
    // The style tile has to be CLICKED. It does not auto-select just because the tenant has one, and
    // submitQuote refuses with "Please select a Building Style and Size" if it is unset — which reads
    // exactly like the submit silently doing nothing.
    await page.locator("[data-ss-style]").first().click();
    await page.waitForTimeout(600);
    const sel = page.locator("select").filter({ has: page.locator("option", { hasText: SIZE }) });
    if (await sel.count()) await sel.first().selectOption({ label: SIZE });
    // Wait for the drawing to prove the size took, rather than for a fixed time.
    await page.waitForFunction((l) => [...document.querySelectorAll("svg text")].some((t) => t.textContent.trim() === `${l} ft`), 24, { timeout: 20000 });
    await page.waitForTimeout(1200);

    // 555-01xx is reserved for fiction, the same number the e2e suite uses, so nothing a stub
    // leaked could ever reach a person.
    await page.getByPlaceholder("Full Name").fill("Pat Tester");
    await page.getByPlaceholder("email@example.com").fill("pat@example.com");
    await page.getByPlaceholder("(555) 555-5555").fill("5550104477");
    await page.waitForTimeout(800);

    // ⚠️ NOT getByRole(/Get Quote/) — the stepper rail's own step 6 button is also called
    // "Get quote" and only scrolls, so a name match silently clicks the wrong thing and the
    // harness then "proves" that nothing was submitted. The footer CTA is .ssd-ft-cta.is-quote.
    const quote = page.locator("button.ssd-ft-cta.is-quote").first();
    await quote.scrollIntoViewIfNeeded();
    await quote.click();
    await page.waitForTimeout(9000);   // the default 3D render is a real WebGL pass; give it room

    const pdf = uploads.filter((u) => u.path.endsWith(".pdf") && u.bytes);
    const shots3d = uploads.filter((u) => /-3d-\d+\.jpg$/.test(u.path));
    const pages = pdf.length ? countPdfPages(pdf[pdf.length - 1].bytes) : 0;
    const payload = submits[submits.length - 1] || {};

    ok(`${tag} the quote was actually submitted`, submits.length === 1 && pdf.length === 1,
      `submits ${submits.length}, pdfs ${pdf.length}`);
    if (view3d) {
      ok(`${tag} the PDF carries the plan AND the 3D sheet`, pages === 2, `${pages} page(s)`);
      ok(`${tag} a 3D image is uploaded beside it`, shots3d.length === 1, `${shots3d.length}`);
      ok(`${tag} submit-estimate is told about the 3D image`, Boolean(payload.view3dImageUrl), `${payload.view3dImageUrl}`);
    } else {
      ok(`${tag} the PDF is the plan ONLY — no 3D sheet`, pages === 1, `${pages} page(s)`);
      ok(`${tag} no 3D image is uploaded at all`, shots3d.length === 0, `${shots3d.length}: ${shots3d.map((u) => u.path).join(",")}`);
      ok(`${tag} submit-estimate carries no 3D image`, !payload.view3dImageUrl, `${payload.view3dImageUrl}`);
    }
    ok(`${tag} no page or console errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: `${shots}/${view3d ? "on" : "off"}.png` });
  } catch (e) {
    ok(`${tag} drove the designer`, false, String((e && e.message) || e));
    await page.screenshot({ path: `${shots}/${view3d ? "on" : "off"}-FAIL.png` }).catch(() => {});
  }
  await browser.close();
}

async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("quoteNo3dWhenOff");
  await run(false, ok, shots);   // the tenant Nevin is
  await run(true, ok, shots);    // and the one who should still get 3D, so the fix is a gate not a delete
  console.log(`\nSHOTS ${shots}`);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} FAILED` : "\nALL GREEN");
  process.exit(bad.length ? 1 : 0);
}
main();
