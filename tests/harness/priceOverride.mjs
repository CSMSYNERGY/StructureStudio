// A rep's own price for a line (a builder's request; migration 277), driven in the real
// designer against the COMPILED bundle, with every Supabase call answered locally.
//
// What is proved, on screen and on the wire:
//
//   A. THE CUSTOMER'S SHARE LINK (the public page, a design a rep re-priced): Details shows the new
//      prices as plain numbers — no price field, no "List" hint, the list figure nowhere on the page.
//   B. THE PORTAL, FOR SOMEONE WITHOUT "Override prices" (embedded, canOverridePrice false): no
//      field, and the LIST prices — what submit-estimate will charge them — with a staff-only note on
//      each row whose stored price their submit drops. The submit still carries the stored prices,
//      so the server strips them and logs that it did. The grant, not the portal, makes a field.
//   C. THE PORTAL, FOR SOMEONE HOLDING IT (embedded, canOverridePrice true):
//      1. each priced row's amount is a field pre-filled with the list price, with a staff-only
//         "List $X" line under the row's name; an "included" row and a rough opening are handled
//         (the opening gets its own field);
//      2. typing a price moves that row and the subtotal, and a rough opening's field moves only
//         that opening;
//      3. "Use list price" puts the row back and the design stores nothing for it;
//      4. leaving a field that holds the list price stores nothing;
//      5. the submit payload carries exactly the applied prices — [{rowKey, amount}] — and each
//         rough opening's id; with no price set the payload has no priceOverrides key at all;
//      6. a row charged for more than one shows its line total beside the unit-price field.
//   D. zero page errors.
//
// The embedded designer is mounted on a page this harness serves itself (the vendored libraries and
// the compiled component, exactly as portal.html loads them), so no portal login is involved.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/priceOverride.mjs        (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held. NOTHING LEAVES THE MACHINE (lib.mjs stubSupabase).
import { readFileSync } from "node:fs";
import { launch, stubSupabase, collectErrors, openDesigner, reporter, shotsDir, BASE, REF } from "./lib.mjs";
import { CONFIG as GABLE_CONFIG, FIXTURES } from "./gableProbe.mjs";

const CLIENT = "harness-price";
const CODE = "SS-HARNESSPR1";
const SIZE = "12x32";
const base = GABLE_CONFIG.buildingStyles[1];   // the plain gable
const CONFIG = {
  ...GABLE_CONFIG,
  clientId: CLIENT,
  // [] unlocks Details with no typing (contactComplete short-circuits on an empty list).
  contactFields: [],
  buildingStyles: [{ ...base, value: "plain", label: "Gable Cabin", sizeInclusionQty: { [SIZE]: { singleDoor: 1 } } }],
  sizePricing: { plain: { [SIZE]: { widthFt: 12, lengthFt: 32, basePrice: 9000 } } },
  layoutPricing: {
    singleDoor: { rate: 400, method: "each" },
    roughOpening: { rate: 150, method: "each" },
  },
};
const ITEMS = [
  { id: 101, type: "singleDoor", x: 200, y: 100, wall: "north", rotation: 0, widthFt: 3, heightFt: 0.5 },
  { id: 102, type: "singleDoor", x: 300, y: 100, wall: "north", rotation: 0, widthFt: 3, heightFt: 0.5 },
  { id: 103, type: "roughOpening", x: 400, y: 100, wall: "north", rotation: 0, widthFt: 3, heightFt: 0.5 },
  { id: 104, type: "roughOpening", x: 500, y: 100, wall: "north", rotation: 0, widthFt: 3, heightFt: 0.5 },
];
const designRow = (selections, items = ITEMS) => ({
  short_code: CODE, client_id: CLIENT, status: "sent", version: 1,
  selections: { style: "plain", size: SIZE, roofType: "", roofColor: "", cladding: "", ...selections },
  items, paint_colors: { body: "", trim: "" }, custom_options: [], ro_dimensions: { 103: "3 x 7", 104: "4 x 7" },
  contact: { name: "Pat Example", email: "pat@example.test", phone: "5550100100", street: "", city: "", state: "", zip: "" },
  bldg_w: 12, bldg_h: 32,
});
// A design a rep re-priced: the building down to $8,500 and the second opening up to $275.
const PRICED = designRow({ priceOverrides: { building: { amount: "8500", was: 9000 }, "ro:104": { amount: "275", was: 150 } } });

const settle = (page, ms = 400) => page.waitForTimeout(ms);
// The footer's submit — "Get Quote" for a design with no estimate yet. Exact, because the step rail
// beside the plan has an item reading "6 Get quote" that is a link, not the submit.
const submitButton = (page) => page.getByRole("button", { name: /^(Get Estimate|Resubmit Quote|Resubmit)$/ }).last();

/** Open Details if it is closed (the public page shows a call-to-action bar; the portal a toggle). */
async function openDetails(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator(".ssd-dt").count()) return;
    const cta = page.locator(".ssd-dt-cta").first();
    if (await cta.count() && await cta.isVisible().catch(() => false)) { await cta.click(); await settle(page); continue; }
    const tog = page.locator(".ssd-dt-tog").first();
    if (await tog.count() && await tog.isVisible().catch(() => false)) { await tog.click(); await settle(page); continue; }
    await settle(page, 800);
  }
}
const detailsText = (page) => page.locator(".ssd-dt").first().innerText();
const subtotal = async (page) => (await page.locator(".ssd-dt-sub-amt").first().innerText()).trim();
const fieldFor = (page, key) => page.locator(`input[data-ss-price-key="${key}"]`).first();
const hintFor = (page, key) => page.locator(`[data-ss-price-hint="${key}"]`).first();

/** The portal's mount, minus the portal: the vendored libraries and the compiled component, the way
 *  portal.html loads them, and one <StructureStudio embedded …/>. */
function embeddedPage(canOverridePrice) {
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
    clientId: ${JSON.stringify(CLIENT)}, embedded: true, canOverridePrice: ${canOverridePrice ? "true" : "false"},
    openDesign: { code: ${JSON.stringify(CODE)}, clientId: ${JSON.stringify(CLIENT)} },
  }));
</script></body></html>`;
}

async function openEmbedded(ctx, canOverridePrice, row) {
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const calls = await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [row] } });
  // The submit uploads the plan PDF and its pictures first; answer storage the way it answers a
  // successful upload. Registered AFTER stubSupabase, so it wins (Playwright runs routes in reverse).
  await page.route(`**/${REF}.supabase.co/storage/v1/**`, (route) => {
    const hdr = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: hdr, body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", headers: hdr, body: JSON.stringify({ Key: "floor-plans/harness.pdf", Id: "1" }) });
  });
  const url = `${BASE}/__harness_price_${canOverridePrice ? "on" : "off"}.html`;
  await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: embeddedPage(canOverridePrice) }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.StructureStudio === "function", null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector(".ssd-frame") != null, null, { timeout: 60000 });
  await settle(page, 1500);
  await openDetails(page);
  await page.locator(".ssd-dt").first().waitFor({ state: "visible", timeout: 30000 });
  return { page, errors, calls };
}

const run = async () => {
  const { ok, failed } = reporter();
  const { browser, ctx } = await launch({ width: 1400, height: 1000 });
  const shots = shotsDir("priceOverride");
  const allErrors = [];
  try {
    // ── A. The customer's share link ───────────────────────────────────────────────────────
    {
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      await stubSupabase(page, { config: CONFIG, fixtures: FIXTURES, rpc: { load_design: [PRICED] } });
      await openDesigner(page, CLIENT);
      await page.goto(`${BASE}/?client=${CLIENT}&id=${CODE}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ssAppBooted === true, null, { timeout: 60000 });
      await settle(page, 1500);
      await openDetails(page);
      await page.locator(".ssd-dt").first().waitFor({ state: "visible", timeout: 30000 });
      const text = await detailsText(page);
      ok("A1 share link: the re-priced building reads $8,500.00", text.includes("$8,500.00"), text.replace(/\s+/g, " ").slice(0, 300));
      ok("A2 share link: the re-priced opening reads $275.00, the other its list $150.00", text.includes("$275.00") && text.includes("$150.00"));
      ok("A3 share link: no price field anywhere", (await page.locator("input[data-ss-price-key]").count()) === 0);
      ok("A4 share link: no staff hint, and the replaced list price is nowhere on the page",
        (await page.locator("[data-ss-price-hint]").count()) === 0 && !(await page.locator("body").innerText()).includes("9,000"));
      // 9000 + 400 (one door beyond the included one) + 150 + 275, re-priced to 8500.
      ok("A5 share link: the subtotal is the re-priced one", (await subtotal(page)) === "$9,325.00", await subtotal(page));
      await page.screenshot({ path: `${shots}/A-share-link.png`, fullPage: false });
      allErrors.push(...errors.map((e) => "A: " + e));
      await page.close();
    }

    // ── B. The portal, without the grant ───────────────────────────────────────────────────
    {
      const { page, errors, calls } = await openEmbedded(ctx, false, PRICED);
      const text = await detailsText(page);
      ok("B1 portal without the grant: the LIST prices their submit will charge, not the stored ones",
        (await page.locator(".ssd-dt-row.is-main .ssd-dt-amt").first().innerText()).trim() === "$9,000.00"
          && (await subtotal(page)) === "$9,700.00", `${await subtotal(page)} :: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
      const notes = await page.locator("[data-ss-price-dropped]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-ss-price-dropped"), e.textContent]));
      ok("B1b ...with a staff note on exactly the two rows whose stored price is dropped, naming it",
        JSON.stringify(notes.map((n) => n[0])) === JSON.stringify(["building", "ro:104"])
          && notes[0][1].includes("$8,500.00") && notes[1][1].includes("$275.00") && /list price/.test(notes[0][1]), JSON.stringify(notes));
      ok("B2 portal without the grant: no price field and no hint",
        (await page.locator("input[data-ss-price-key]").count()) === 0 && (await page.locator("[data-ss-price-hint]").count()) === 0);
      const before = calls.length;
      const submit = submitButton(page);
      let payload = null;
      if (await submit.count()) {
        await submit.click().catch(() => {});
        for (let i = 0; i < 40 && !payload; i++) {
          await settle(page, 250);
          const hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate"));
          if (hit) payload = hit.body;
        }
      }
      ok("B3 their submit reached submit-estimate", !!payload, payload ? "" : "no submit-estimate call captured");
      if (payload) {
        ok("B3b ...carrying the stored prices for the server to strip and log (the list total is what they saw)",
          JSON.stringify(payload.priceOverrides) === JSON.stringify([{ rowKey: "building", amount: 8500 }, { rowKey: "ro:104", amount: 275 }]),
          JSON.stringify(payload.priceOverrides));
      }
      allErrors.push(...errors.map((e) => "B: " + e));
      await page.close();
    }

    // ── C. The portal, holding "Override prices" ───────────────────────────────────────────
    {
      const { page, errors, calls } = await openEmbedded(ctx, true, designRow({}));
      const bField = fieldFor(page, "building");
      ok("C1 a priced row's amount is a field, pre-filled with the list price",
        (await bField.count()) === 1 && (await bField.inputValue()) === "9000.00", await bField.inputValue().catch(() => "missing"));
      ok("C1b the staff hint names the list price", ((await hintFor(page, "building").innerText().catch(() => "")) || "").includes("List $9,000.00"));
      ok("C1c the door row is a field at its list unit", (await fieldFor(page, "singleDoor").inputValue().catch(() => "missing")) === "400.00");
      ok("C1d each rough opening has its own field", (await fieldFor(page, "ro:103").count()) === 1 && (await fieldFor(page, "ro:104").count()) === 1);
      const sub0 = await subtotal(page);
      ok("C1e the list subtotal", sub0 === "$9,700.00", sub0);

      await bField.fill("8750");
      await settle(page, 300);
      ok("C2 typing a price moves the subtotal by exactly that row's change", (await subtotal(page)) === "$9,450.00", await subtotal(page));
      ok("C2b ...and the hint offers the list price back", ((await hintFor(page, "building").innerText()) || "").includes("Use list price"));
      await fieldFor(page, "ro:104").fill("300");
      await settle(page, 300);
      ok("C2c one opening re-priced, the other untouched", (await subtotal(page)) === "$9,600.00", await subtotal(page));
      await page.screenshot({ path: `${shots}/C-priced.png`, fullPage: false });

      // The payload. Submit in the portal posts to submit-estimate, which the stub answers.
      const before = calls.length;
      const submit = submitButton(page);
      let payload = null;
      if (await submit.count()) {
        await submit.click().catch(() => {});
        for (let i = 0; i < 40 && !payload; i++) {
          await settle(page, 250);
          const hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate"));
          if (hit) payload = hit.body;
        }
      }
      ok("C5 the submit reached submit-estimate", !!payload, payload ? "" : "no submit-estimate call captured");
      if (payload) {
        const po = payload.priceOverrides;
        ok("C5b priceOverrides carries exactly the applied prices",
          JSON.stringify(po) === JSON.stringify([{ rowKey: "building", amount: 8750 }, { rowKey: "ro:104", amount: 300 }]), JSON.stringify(po));
        ok("C5c every rough opening carries its id", Array.isArray(payload.roughOpenings)
          && JSON.stringify(payload.roughOpenings.map((r) => r.id)) === JSON.stringify([103, 104]), JSON.stringify(payload.roughOpenings));
        ok("C5d no list price rides in the payload", !JSON.stringify(payload).includes("\"was\""));
      }
      allErrors.push(...errors.map((e) => "C: " + e));
      await page.close();
    }
    {
      // A fresh portal mount: reset, settle-on-blur, and a submit with nothing re-priced.
      const { page, errors, calls } = await openEmbedded(ctx, true, designRow({}));
      const bField = fieldFor(page, "building");
      await bField.fill("8000");
      await settle(page, 300);
      await page.locator('[data-ss-price-hint="building"] button').click();
      await settle(page, 300);
      ok("C3 'Use list price' puts the row back", (await bField.inputValue()) === "9000.00" && (await subtotal(page)) === "$9,700.00");
      // Type the list price itself and leave the field: no price is stored for it.
      await fieldFor(page, "singleDoor").fill("400");
      await fieldFor(page, "singleDoor").blur();
      await settle(page, 300);
      const hint = await hintFor(page, "singleDoor").innerText();
      ok("C4 leaving a field at its list price stores nothing", !hint.includes("Use list price"), hint);
      const before = calls.length;
      const submit = submitButton(page);
      let payload = null;
      if (await submit.count()) {
        await submit.click().catch(() => {});
        for (let i = 0; i < 40 && !payload; i++) {
          await settle(page, 250);
          const hit = calls.slice(before).find((c) => c.path && c.path.endsWith("/functions/v1/submit-estimate"));
          if (hit) payload = hit.body;
        }
      }
      ok("C5e with nothing re-priced the payload has no priceOverrides key at all", !!payload && !("priceOverrides" in payload),
        payload ? Object.keys(payload).join(",") : "no submit-estimate call captured");
      allErrors.push(...errors.map((e) => "C': " + e));
      await page.close();
    }
    {
      // Three doors, one included by the size: the door row charges two, so its field holds the
      // $400.00 UNIT price and the line's $800.00 has to show somewhere.
      const three = [...ITEMS, { id: 105, type: "singleDoor", x: 250, y: 100, wall: "north", rotation: 0, widthFt: 3, heightFt: 0.5 }];
      const { page, errors } = await openEmbedded(ctx, true, designRow({}, three));
      const hint = await hintFor(page, "singleDoor").innerText().catch(() => "missing");
      ok("C6 a row charged for two shows its line total beside the unit-price field",
        (await fieldFor(page, "singleDoor").inputValue().catch(() => "missing")) === "400.00" && hint.includes("this line $800.00"), hint);
      allErrors.push(...errors.map((e) => "C6: " + e));
      await page.close();
    }

    ok("D zero page errors", allErrors.length === 0, allErrors.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
  }
  const f = failed();
  console.log(f.length ? `\n${f.length} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(f.length ? 1 : 0);
};
run().catch((e) => { console.error(e); process.exit(1); });
