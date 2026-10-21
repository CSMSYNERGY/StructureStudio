// Quote to a business entity (2026-10-21), driven through the COMPILED designer.
//
// Junior Barns: "We need a field for a business or organization name in addition to the main point
// of contact ... Bear River Band communications all say "Hi Bear"". The designer gained an optional
// "Company / organization" box above Name. What this proves:
//
//   A. the rep's form (embedded, the portal Designer tab) shows the box ABOVE Name, filled from the
//      quote's own snapshot when a quote is opened;
//   B. submitting sends contact.company to submit-estimate beside the person's name;
//   C. a cleared box sends NO company key at all, so the payload is the one it always was;
//   D. the public shopper page hides the box unless the builder's contactFields has "company"
//      (off for every builder until Carolyn says), and shows it when it does.
//
// No login and no Supabase: every call is answered locally by lib.mjs's stub, so NOTHING LEAVES THE
// MACHINE (submit-estimate, save_design and log_error would otherwise write into the one database
// beta and production share).
//
//   python -m http.server 8125 --bind 127.0.0.1        (repo root)
//   node tests/harness/businessContact.mjs             (exit 0 = every check held)
import { readFileSync } from "node:fs";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const CLIENT = "harness-business";
const CODE = "SS-HARNESSBZ1";
const SIZE = "12x32";
const base = GABLE_CONFIG.buildingStyles[1];
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: CLIENT,
  // The three a quote files under; no address, so Details opens on what the design carries.
  contactFields: ["name", "email", "phone"],
  buildingStyles: [{ ...base, value: "plain", label: "Gable Cabin" }],
  sizePricing: { plain: { [SIZE]: { widthFt: 12, lengthFt: 32, basePrice: 9000 } } },
};
const ROW = {
  short_code: CODE, client_id: CLIENT, status: "sent", version: 1,
  selections: { style: "plain", size: SIZE, roofType: "", roofColor: "", cladding: "" },
  items: [], paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: {},
  // Made up: the repo is public.
  contact: { name: "Thomas Example", company: "Bear River Band", email: "thomas@example.test", phone: "5550100142", street: "", city: "", state: "", zip: "" },
  bldg_w: 12, bldg_h: 32,
};

const settle = (page, ms = 400) => page.waitForTimeout(ms);
const submitButton = (page) => page.getByRole("button", { name: /^(Get Estimate|Resubmit Quote|Resubmit)$/ }).last();
const companyBox = (page) => page.locator(".ssd-cf-f", { has: page.locator(".ssd-cf-l", { hasText: /^Company \/ organization$/ }) }).locator("input");
const nameBox = (page) => page.locator(".ssd-cf-f", { has: page.locator(".ssd-cf-l", { hasText: /^Name \*/ }) }).locator("input");

function embeddedPage() {
  const idx = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const buster = (/structure-studio\.component\.compiled\.js\?v=([a-f0-9]+)/.exec(idx) || [])[1] || "x";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><div id="root"></div>
<script src="/vendor/react-18.2.0.production.min.js"></script>
<script src="/vendor/react-dom-18.2.0.production.min.js"></script>
<script src="/vendor/supabase-js-2.112.1.umd.min.js"></script>
<script src="/structure-studio.component.compiled.js?v=${buster}"></script>
<script>
  window.__ssAppBooted = true;
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.StructureStudio, {
    clientId: ${JSON.stringify(CLIENT)}, embedded: true,
    openDesign: { code: ${JSON.stringify(CODE)}, clientId: ${JSON.stringify(CLIENT)} },
  }));
</script></body></html>`;
}

async function submitAndCapture(page, calls) {
  const before = calls.length;
  const submit = submitButton(page);
  if (!(await submit.count())) return null;
  await submit.click().catch(() => {});
  for (let i = 0; i < 40; i++) {
    await settle(page, 250);
    const hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate"));
    if (hit) return hit.body;
  }
  return null;
}

const run = async () => {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1400, height: 1000 });
  const shots = shotsDir("businessContact");
  const allErrors = [];
  try {
    // ── A–B. The rep's form in the portal ───────────────────────────────────────────────────
    {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [ROW] } });
      await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
        const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
        return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
      });
      const url = `${BASE}/__harness_business.html`;
      await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage() }));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".ssd-frame") != null, null, { timeout: 60000 });
      await settle(page, 2000);

      ok("A1 the rep's form has a Company / organization box", (await companyBox(page).count()) === 1);
      ok("A2 ...filled from the opened quote's snapshot", (await companyBox(page).inputValue().catch(() => "")) === "Bear River Band",
        await companyBox(page).inputValue().catch(() => "missing"));
      const cb = await companyBox(page).boundingBox();
      const nb = await nameBox(page).boundingBox();
      ok("A3 ...above Name", !!cb && !!nb && cb.y < nb.y, `company y ${cb && cb.y}, name y ${nb && nb.y}`);
      ok("A4 Name is still the person", (await nameBox(page).inputValue().catch(() => "")) === "Thomas Example");
      await companyBox(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/A-rep-form.png`, fullPage: false });

      const p1 = await submitAndCapture(page, calls);
      ok("B1 the submit reached submit-estimate", !!p1, p1 ? "" : "no submit-estimate call captured");
      if (p1) {
        ok("B2 ...with the company beside the person", p1.contact && p1.contact.company === "Bear River Band" && p1.contact.name === "Thomas Example",
          JSON.stringify(p1.contact));
      }
      const saved = calls.filter((c) => c.path && c.path.endsWith("/rest/v1/rpc/save_design")).pop();
      ok("B3 save_design keeps the company in the quote's snapshot", !!saved && saved.body && saved.body.p_contact && saved.body.p_contact.company === "Bear River Band",
        saved ? JSON.stringify(saved.body && saved.body.p_contact) : "no save_design call");
      allErrors.push(...errors.map((e) => "A: " + e));
      await page.close();
    }
    {
      // C. Cleared: no company key at all.
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [ROW] } });
      await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
        const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
        return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
      });
      const url = `${BASE}/__harness_business_c.html`;
      await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage() }));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".ssd-frame") != null, null, { timeout: 60000 });
      await settle(page, 2000);
      await companyBox(page).fill("   ");
      await settle(page, 300);
      const p2 = await submitAndCapture(page, calls);
      ok("C1 a blank box sends no company key: the payload is the one it always was",
        !!p2 && p2.contact && !("company" in p2.contact), p2 ? JSON.stringify(p2.contact) : "no submit captured");
      allErrors.push(...errors.map((e) => "C: " + e));
      await page.close();
    }

    // ── D. The public shopper page ──────────────────────────────────────────────────────────
    for (const [label, fields, shown] of [["off (every builder today)", ["name", "email", "phone"], false], ["with \"company\" in contactFields", ["company", "name", "email", "phone"], true]]) {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      await stubSupabase(page, { config: { ...CONFIG, contactFields: fields }, fixtures: FIXTURES, rpc: { load_design: [ROW] } });
      await openDesigner(page, CLIENT);
      await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await settle(page, 2000);
      const n = await companyBox(page).count();
      ok(`D ${label}: the public page ${shown ? "shows" : "hides"} the box`, n === (shown ? 1 : 0), `count ${n}`);
      if (shown) {
        ok("D2 ...filled from the quote it opened", (await companyBox(page).inputValue().catch(() => "")) === "Bear River Band");
        await companyBox(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/D-public-on.png`, fullPage: false });
      }
      allErrors.push(...errors.map((e) => `D ${label}: ` + e));
      await page.close();
    }

    const real = allErrors.filter((e) => !/favicon|ERR_ABORTED|net::ERR/.test(e));
    ok("no page errors", real.length === 0, real.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
  }
  console.log(`\nscreenshots: ${shots}`);
  process.exit(failed().length ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(1); });
