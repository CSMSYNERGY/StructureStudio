// THE BUILDER'S THREE NUMBERS — measured on the wire, not asserted about.
//
// Wall height came back 7 in 74 % of every recorded generation and never once above 8, on
// buildings whose walls measure 9; the overhang came back exactly 1.0 ft in 53 % of them, on a
// building whose eave measures 0.15 ft. Zero variance at a wrong value is the signature of a
// default, not of a measurement — a phone at chest height has no datum in frame, so the model
// answers the middle of whatever range it was given.
//
// So the builder types the size in, and it becomes the ruler. The only place that claim can be
// checked is the REQUEST BODY: the numbers live in component state, the prompt is built on the
// server, and a card that renders perfectly while sending nothing would look exactly like a card
// that works. This drives the real calibration panel in the shipped compiled portal and reads
// what left the browser.
//
//   1. the fields pre-fill from THE STYLE'S OWN sizes, and from nothing else
//   2. a style with no sizes of its own starts BLANK — never from C.defaultSizes (brief S2-D),
//      because a tenant-wide default set says nothing about the building in front of this builder
//   3. Generate is GATED on all three, and the line underneath names the one still missing
//   4. a PRE-FILLED wall height has to be touched before the button unlocks. No tick box: the
//      touch is the confirmation
//   5. the request body carries the dims that were typed, every time
//   6. the overhang chips are optional and "read it from the video" is NOT zero — 0 is a flush
//      eave somebody measured, and the two must not arrive as the same thing
//   7. the warnings warn and do not refuse: a builder may well have filmed a size their catalog
//      does not sell yet
//   8. the wall height is ONE slice with two views — this card and the field further down
//   9. clearing the wall height NEVER erases the style's stored wall — the sanitiser DROPS a
//      wall outside 3..20 instead of clamping it, so a 0 on the wire is an erasure, not a clamp
//  10. zero page errors, and no generation ever leaves without dims
//  11. THE NEW FRAME OF REFERENCE, IN WORDS (2026-09-24): width is the FRONT wall (the side with
//      the porch or main door), length runs front to back, and the wall height is the outside
//      walls at the eave -- the LOW side on a single slope. A front longer than the building is
//      deep is a real building now (Farmstand), so the width/length note explains rather than
//      telling a builder to swap two correct numbers. And the wall band tops out at 20, not 14
//
// Stubbed at the NETWORK layer, like calIdempotency.mjs: no account, no login, no writes, and the
// artifacts under test are the compiled bundles the browser really loads. A change that was never
// `npm run compile`d is invisible here, which is the point.
//
//   python -m http.server 8303 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/calDims.mjs                  (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { join } from "node:path";
import { launch, reporter, collectErrors, shotsDir, REF, BASE, PASS_THROUGH_GET } from "./lib.mjs";

const CLIENT = "pw-demo-barns";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800; // 2100-01-01
const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: USER_ID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// Two styles, both with a SAVED walk-around so Generate is one field away on reopen and the run
// needs no video file and no ffmpeg. They differ in exactly one thing, which is the thing under
// test: "barn" has sizes of its own, "shed" has none at all.
const styleRow = (key, label) => ({
  id: key, key, label, code: key.slice(0, 3).toUpperCase(), image_url: null, active: true,
  updated_at: "2026-09-14T10:00:00.000+00:00", show_image_on_estimate: true, d3: null,
  d3_photos: [], d3_video_frames: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-${key}${i}.png`),
  model_url: null, model_status: "none", model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
});
const STYLES = [styleRow("barn", "Barn"), styleRow("shed", "Shed")];

// ⚠️ `defaultSizes` IS DELIBERATELY EMPTY, and that is not laziness. The blocking case brief S2-D
// names is a style with no sizes: `calSizeOpts` falls back to the tenant default set, so with one
// present there would still be a "Preview on" picker and the test would never see the surface a
// real no-sizes tenant sees. Empty here means the Shed has no picker at all, which is exactly why
// the card has to name the previewed size in words.
//
// wallHeightFt 7 is the tenant default, and 7 is the number the model itself kept answering. It
// is here so the wall height arrives PRE-FILLED and has to be confirmed.
const CONFIG = {
  branding: { companyName: "PW Demo Barns", accentColor: "#8B4513", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [
    { value: "barn", label: "Barn", sizes: [{ label: "16x24", w: 16, h: 24, price: 5000 }] },
    { value: "shed", label: "Shed", sizes: [] },
  ],
  defaultSizes: [],
  options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 7,
};

const generateCalls = [];
// Every save_style_d3 body, so the one assertion that cannot be made anywhere else — what this
// card writes into building_styles.d3 — is made against the wire rather than against the screen.
const saveCalls = [];
// ⚠️ THE DEPLOY WINDOW, AS A SWITCH. The browser bundle reaches beta on a push (Workers Builds,
// about two minutes) and portal-settings is deployed by hand, so there is a real window in which
// the new bundle talks to a function that has never heard of `dims`. Flipped to false below,
// this stub IS that function: it ignores the field, answers with the model's own wall height and
// echoes nothing back.
let edgeEchoesDims = true;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main() {
  const r = reporter();
  const { browser, ctx } = await launch({ width: 1500, height: 1100 });
  await ctx.addInitScript(([ref, s]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);

  const json = (route, body, status = 200) => route.fulfill({
    status, contentType: "application/json",
    headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body),
  });

  // ⚠️ ROUTE ORDER: Playwright runs matching routes in REVERSE registration order, so the
  // catch-all abort goes FIRST and everything real overrides it.
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => {
    const req = route.request();
    if (req.method() === "GET" && PASS_THROUGH_GET.test(req.url())) return route.continue();
    return route.abort();
  });

  const apiHandler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) {}

    if (url.includes("/rest/v1/rpc/get_config")) return json(route, CONFIG);
    if (url.includes("/rest/v1/rpc/get_fixtures")) return json(route, []);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, SESSION.user);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { ok: true, entitlement: { granted: ["view_3d"], features: { view_3d: true }, status: "active" } });
    }
    if (url.includes("/portal-settings")) {
      const a = body.action;
      if (a === "status") {
        return json(route, {
          ok: true, clientId: CLIENT, role: "owner",
          settings: { business_name: "PW Demo Barns" },
          config: { company_name: "PW Demo Barns", accent_color: "#8B4513" },
          access: null, prefs: null,
        });
      }
      if (a === "catalog") return json(route, { ok: true, aiReady: true, styles: STYLES, sizes: [], layoutItems: [], fixtures: [], colors: [] });
      if (a === "calibrate_style_ai") {
        generateCalls.push(body);
        // The server's own shape: the builder's wall height is written into the spec before the
        // sanitiser, and `dims` is echoed back AS USED. Echoing a model-invented 7.5 here instead
        // would be a stub that disagrees with the function it stands in for, and the "one slice,
        // two views" assertion below would be measuring the stub.
        const dims = edgeEchoesDims ? (body.dims || null) : null;
        return json(route, {
          ok: true,
          d3: {
            roof: { type: "gambrel", pitch: 0.5, overhang: dims && dims.overhangIn != null ? dims.overhangIn / 12 : 0.8 },
            // 7 is not a random stand-in: it is what the model answered in 74 % of every
            // recorded generation, on buildings measuring 9.
            wallHeightFt: dims ? dims.wallHeightFt : 7,
            siding: null, colors: { body: "#00ff00" },
          },
          frames: (body.photoUrls || []).length, dropped: 0,
          observed: { roofNote: "Gambrel, read from the ground.", confidence: "medium" },
          balanceCents: 18000, dims,
        });
      }
      if (a === "save_style_d3") { saveCalls.push(body); return json(route, { ok: true }); }
      return json(route, { ok: true });
    }
    return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
  };
  await page.route(`**/${REF}.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.functions.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.storage.supabase.co/**`, apiHandler);
  await page.route("**/__stub/img-*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

  // CLICKED, not deep-linked: python -m http.server serves files, not the Workers routes.
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), { timeout: 40000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  await page.getByText("Designer", { exact: true }).last().click();
  await page.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), { timeout: 40000 });

  // A PICTURE OF THE CARD, in each of its states. The assertions prove what the code does; a shot
  // is the only thing that shows a builder could read it. Written to SS_SHOTS or the OS temp dir,
  // never into the checkout — see shotsDir.
  const shots = shotsDir("calDims");
  const shotCard = async (name) => {
    await page.locator('[data-ssc-card="dims"]').first().screenshot({ path: join(shots, name + ".png") });
  };

  // The three dimension inputs are the only `.ssc-dim-in` elements on the page, in the order the
  // card asks for them. Located by class rather than by label text so an em dash or a reworded
  // hint cannot break the harness without breaking the card.
  const dimIn = page.locator("input.ssc-dim-in");
  const widthIn = dimIn.nth(0), lengthIn = dimIn.nth(1), wallIn = dimIn.nth(2);
  const gen = page.getByRole("button", { name: /Generate the 3D model/ });
  // Amber is the card's one visual claim: "this number is not a measurement yet". Read off the
  // computed style rather than the source, so a border set somewhere else still counts.
  const AMBER = "rgb(245, 158, 11)";
  const borderOf = (loc) => loc.evaluate((el) => getComputedStyle(el).borderTopColor);

  const genEnabled = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
    return Boolean(b) && !b.disabled;
  });
  const whyLine = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
    const line = b && b.parentElement ? b.parentElement.querySelector("div") : null;
    return line ? (line.textContent || "") : "";
  });
  // fill() then blur, because clearing a required field only commits on blur — that is what lets a
  // builder say "I do not know this yet" instead of watching the old value snap back.
  //
  // blur(), deliberately NOT Tab. The three fields are adjacent, so tabbing out of the length
  // lands IN the wall height and confirms it — which is correct behaviour and is asserted on its
  // own below, but it would silently confirm the wall in every step that used it and hide the
  // lock this harness exists to measure. (It did, on the first run.)
  const setDim = async (loc, v) => { await loc.click(); await loc.fill(String(v)); await loc.blur(); await page.waitForTimeout(120); };

  const openStyle = async (label, key) => {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForFunction((want) => {
      const got = Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute("src"));
      return got.length === want.length && got.every((u, i) => u === want[i]);
    }, STYLES.find((s) => s.key === key).d3_video_frames, { timeout: 20000 });
    await page.waitForTimeout(250);
  };

  const press = async (label) => {
    const n = generateCalls.length;
    await gen.first().click();
    for (let i = 0; i < 120 && generateCalls.length === n; i++) await page.waitForTimeout(100);
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
      return Boolean(b) && !b.disabled;
    }, null, { timeout: 20000 }).catch(() => {});
    const body = generateCalls[n] || null;
    r.ok(`${label}: one press sent exactly one call`, generateCalls.length === n + 1, `${generateCalls.length - n} calls`);
    return body;
  };

  // ── 1 + 4: the card, pre-filled from the style's own sizes, gated on a confirmed wall ─────
  await openStyle("Barn", "barn");
  r.ok("the card renders exactly three dimension fields", (await dimIn.count()) === 3, String(await dimIn.count()));
  r.ok("width pre-fills from THIS STYLE'S own sizes", (await widthIn.inputValue()) === "16", await widthIn.inputValue());
  r.ok("and so does length", (await lengthIn.inputValue()) === "24", await lengthIn.inputValue());
  r.ok("the wall height pre-fills from the style's saved spec", (await wallIn.inputValue()) === "7", await wallIn.inputValue());

  // ── 11: what each number IS, in the frame the generator now reads them in ─────────────────
  // The server tells the model "the FRONT wall is W ft long, L ft deep front to back, and the
  // outside walls are H ft tall at the eave (on a one-slope roof, the LOW side)". A card that
  // still said "width is the gable end" would be asking for a different number from the one the
  // prompt states as fact.
  const dimLabels = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ssc-card="dims"] label'))
    .map((l) => (l.firstChild && l.firstChild.textContent ? l.firstChild.textContent : l.textContent || "").trim()));
  r.ok("⚠️ WIDTH IS THE FRONT WALL, the side with the porch or main door",
    /^Width \(ft\) — the FRONT wall \(the side with the porch or main door\)/.test(dimLabels[0] || ""), dimLabels[0]);
  r.ok("length runs front to back", /^Length \(ft\) — front to back/.test(dimLabels[1] || ""), dimLabels[1]);
  r.ok("the wall height is the outside walls at the eave, the LOW side on a single slope",
    /^Wall height at the eave \(ft\) — the outside walls \(single-slope roof: the LOW side\)/.test(dimLabels[2] || ""), dimLabels[2]);
  const cardText = await page.evaluate(() => (document.querySelector('[data-ssc-card="dims"]') || {}).innerText || "");
  r.ok("and the card no longer calls the width the gable end", !/gable end/i.test(cardText), (cardText.match(/[^\n]*gable end[^\n]*/i) || ["-"])[0].slice(0, 100));
  r.ok("it says what to do with wings: measure the whole thing", /wings included/.test(cardText));
  // ⚠️ AND THE LABEL NEVER STARTS "Wall height (ft)". tests/harness/porchPanel.mjs reaches the
  // field further down by /^Wall height \(ft\)/, and this harness reaches it by has-text.
  r.ok("the card's wall label cannot be mistaken for the field further down", !/^Wall height \(ft\)/.test(dimLabels[2] || ""));

  await shotCard("01-required-wall-unconfirmed");
  r.ok("PRE-FILLED NUMBERS KEEP GENERATE LOCKED", (await genEnabled()) === false);
  // ⚠️ ALL THREE, NOT JUST THE WALL. Width and length are seeded from the median row of this
  // style's PRICE LIST, and the server states all three to the model as measurements the
  // builder took. Until 2026-09-19 they were grey, unmarked and outside the gate, so one tap on
  // the wall height turned the badge green over two numbers nobody had looked at.
  r.ok("and the line names all three, not just the wall height",
    /Check the width, length and wall height/.test(await whyLine()), (await whyLine()).slice(0, 140));
  r.ok("the width is amber while it is still the price list's number", (await borderOf(widthIn)) === AMBER, await borderOf(widthIn));
  r.ok("and so is the length", (await borderOf(lengthIn)) === AMBER, await borderOf(lengthIn));
  r.ok("and the card says where those two came from",
    (await page.evaluate(() => document.body.innerText)).includes("From your price list"));

  // TOUCHING IS THE CONFIRMATION. No tick box in front of the money button — a checkbox gets
  // ticked, not read, and this is an act the builder would perform anyway if the number were wrong.
  await wallIn.click();
  await page.waitForTimeout(150);
  r.ok("⚠️ ONE TAP ON THE WALL DOES NOT CONFIRM THE SIZE", (await genEnabled()) === false, await whyLine());
  r.ok("and the line drops to the two that are left", /Check the width and length/.test(await whyLine()), (await whyLine()).slice(0, 140));
  await widthIn.click();
  await lengthIn.click();
  await page.waitForTimeout(150);
  r.ok("touching all three unlocks the button", (await genEnabled()) === true, await whyLine());
  r.ok("and the width stops being amber once it has been looked at", (await borderOf(widthIn)) !== AMBER, await borderOf(widthIn));
  await shotCard("02-confirmed-and-ready");
  r.ok("and the ready line names the size it will measure against",
    /measured against your 16 × 24 ft/.test(await whyLine()), (await whyLine()).slice(0, 120));

  // ── 5: the numbers reach the wire ─────────────────────────────────────────────────────────
  const a1 = await press("press 1 (as pre-filled)");
  r.ok("⚠️ THE REQUEST BODY CARRIES THE DIMS", Boolean(a1 && a1.dims), a1 ? JSON.stringify(a1.dims) : "no call");
  r.ok("and they are the numbers on screen",
    Boolean(a1) && a1.dims.widthFt === 16 && a1.dims.lengthFt === 24 && a1.dims.wallHeightFt === 7,
    JSON.stringify(a1 && a1.dims));
  r.ok("with NO overhang, because no chip was pressed", Boolean(a1) && !("overhangIn" in a1.dims), JSON.stringify(a1 && a1.dims));
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  r.ok("the success line names the ruler the SERVER echoed back",
    (await page.evaluate(() => document.body.innerText)).includes("Measured against your 16 × 24 ft with 7 ft walls"));

  // ── 8: one slice, two views ───────────────────────────────────────────────────────────────
  await setDim(widthIn, 12);
  await setDim(lengthIn, 32);
  await setDim(wallIn, 9);
  const lowerWall = page.locator('label:has-text("Wall height (ft)") input:not(.ssc-dim-in)').first();
  r.ok("the wall height is ONE slice: the field further down moved with it",
    (await lowerWall.inputValue()) === "9", await lowerWall.inputValue());

  const a2 = await press("press 2 (retyped)");
  r.ok("the retyped numbers are what go out",
    Boolean(a2) && a2.dims.widthFt === 12 && a2.dims.lengthFt === 32 && a2.dims.wallHeightFt === 9,
    JSON.stringify(a2 && a2.dims));

  // ── 6: the overhang chips, and the one distinction that matters ───────────────────────────
  await page.getByRole("button", { name: "Flush", exact: true }).click();
  await page.waitForTimeout(150);
  const a3 = await press("press 3 (flush)");
  r.ok("⚠️ FLUSH IS 0, AND 0 REACHES THE SERVER", Boolean(a3) && a3.dims.overhangIn === 0, JSON.stringify(a3 && a3.dims));

  await page.getByRole("button", { name: "16 in", exact: true }).click();
  await page.waitForTimeout(150);
  const a4 = await press("press 4 (16 in)");
  r.ok("a measured eave rides along in inches", Boolean(a4) && a4.dims.overhangIn === 16, JSON.stringify(a4 && a4.dims));

  await page.getByRole("button", { name: "Read it from the video", exact: true }).click();
  await page.waitForTimeout(150);
  const a5 = await press("press 5 (read it from the video)");
  r.ok("⚠️ 'READ IT FROM THE VIDEO' IS NOT ZERO — the key is absent, not 0",
    Boolean(a5) && !("overhangIn" in a5.dims), JSON.stringify(a5 && a5.dims));

  // ── 7: warnings warn, they do not refuse ──────────────────────────────────────────────────
  await setDim(lengthIn, 10);
  await page.waitForTimeout(200);
  const warned = await page.evaluate(() => document.body.innerText);
  await shotCard("03-warned-not-refused");
  r.ok("a length shorter than the width is called out", /length is shorter than the width/i.test(warned));
  // ⚠️ AND IT NO LONGER SAYS THEY ARE WRONG. Width is the FRONT wall now, so a 12 wide, 10 deep
  // building is a real building whose door is on a long side. The note says what the numbers
  // mean and names the one real mistake; it does not tell the builder to swap them.
  r.ok("⚠️ the note explains the front, it does not call the numbers backwards",
    /so the front is the long side/.test(warned) && /if the door is on a short end/.test(warned) && !/GABLE END/.test(warned),
    (warned.match(/[^\n]*length is shorter than the width[^\n]*/i) || ["-"])[0].slice(0, 160));
  r.ok("AND IT DOES NOT REFUSE — the button is still live", (await genEnabled()) === true, await whyLine());
  const a6 = await press("press 6 (warned but allowed)");
  r.ok("the warned set still reaches the server", Boolean(a6) && a6.dims.widthFt === 12 && a6.dims.lengthFt === 10, JSON.stringify(a6 && a6.dims));
  await setDim(lengthIn, 32);

  // ── 3: clearing a required field locks the button and the line names it ───────────────────
  await setDim(widthIn, "");
  r.ok("a cleared required field CLEARS — it does not snap back", (await widthIn.inputValue()) === "", await widthIn.inputValue());
  r.ok("and it locks the button", (await genEnabled()) === false);
  r.ok("the line names the missing field, in the builder's words", /width/.test(await whyLine()), (await whyLine()).slice(0, 110));

  // ── 2: a style with no sizes of its own starts BLANK ──────────────────────────────────────
  await openStyle("Shed", "shed");
  r.ok("⚠️ NEVER PRE-FILLED FROM THE TENANT FALLBACK: width starts blank", (await widthIn.inputValue()) === "", await widthIn.inputValue());
  r.ok("and so does length", (await lengthIn.inputValue()) === "", await lengthIn.inputValue());
  await shotCard("04-no-sizes-blank");
  r.ok("the card says why in words", (await page.evaluate(() => document.body.innerText)).includes("This style has no sizes set up yet"));
  r.ok("Generate is locked", (await genEnabled()) === false);
  r.ok("and the line asks for both numbers", /width and length/.test(await whyLine()), (await whyLine()).slice(0, 120));
  // S2-D's other half: with no sizes there is no "Preview on" picker at all, so the previewed
  // size has to be named in words or the builder compares against a 3D of unknown size.
  r.ok("with no picker, the previewed size is still named on screen",
    /The 3D preview (is showing a|has no size set yet)/.test(await page.evaluate(() => document.body.innerText)));

  await setDim(widthIn, 10);
  await setDim(lengthIn, 20);
  r.ok("filled in, it still waits on the pre-filled wall height", (await genEnabled()) === false, await whyLine());
  // TABBING IN COUNTS AS LOOKING. The three fields are adjacent, so a builder typing the width,
  // tabbing, typing the length and tabbing again lands in the wall height with its amber "tap to
  // confirm" hint right under the cursor. That is the interaction the card is shaped for, and a
  // confirmation only a mouse could give would be a worse one.
  await lengthIn.click();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
  r.ok("and tabbing into it out of the length confirms it", (await genEnabled()) === true, await whyLine());
  r.ok("the focused field really is the wall height",
    (await page.evaluate(() => (document.activeElement && document.activeElement.className) || "")).includes("ssc-dim-in"));

  // The button that exists because this style has no picker.
  const showIt = page.getByRole("button", { name: /Show it on 10 × 20/ });
  r.ok("the previewed size can be set from the numbers that were typed", (await showIt.count()) > 0);
  await showIt.first().click();
  await page.waitForTimeout(400);
  r.ok("and the card then says the preview is on that size",
    (await page.evaluate(() => document.body.innerText)).includes("The 3D preview is showing a 10x20"));

  const a7 = await press("press 7 (shed)");
  r.ok("the second style's own numbers go out",
    Boolean(a7) && a7.dims.widthFt === 10 && a7.dims.lengthFt === 20 && a7.styleValue === "shed",
    JSON.stringify(a7 && a7.dims));

  // ── 9: A BLANK WALL HEIGHT MUST NOT ERASE THE STYLE'S STORED WALL ────────────────────────
  // The regression this pins, end to end: clear the box, press Save, and the measured wall is
  // gone from building_styles.d3 for every customer of that style. It is silent in both
  // directions — Save is not gated on this card, and the older "Wall height (ft)" field renders
  // `|| 8`, so the panel positively displays 8 as if that were the value.
  //
  // WHY IT IS AN ERASURE AND NOT A CLAMP: sanitizeD3Spec ACCEPTS 3..20 and DROPS anything else,
  // so a 0 does not come back as a 3 — the key is simply not emitted, and d3ResolveStyleSpec
  // then falls through to the renderer's 8 ft.
  await openStyle("Barn", "barn");
  await setDim(widthIn, 16);
  await setDim(lengthIn, 24);
  await setDim(wallIn, 9);
  const nSaves = saveCalls.length;
  await setDim(wallIn, "");
  r.ok("the wall height box clears, like the other two", (await wallIn.inputValue()) === "", await wallIn.inputValue());
  r.ok("and a cleared wall locks Generate", (await genEnabled()) === false, await whyLine());
  r.ok("the line names the wall height as the missing one", /wall height/.test(await whyLine()), (await whyLine()).slice(0, 110));
  await page.getByRole("button", { name: /^Save 3D look$/ }).first().click();
  for (let i = 0; i < 100 && saveCalls.length === nSaves; i++) await page.waitForTimeout(100);
  const sv = saveCalls[nSaves] || null;
  r.ok("pressing Save with a blank wall height reached the wire", Boolean(sv), String(saveCalls.length - nSaves));
  r.ok("⚠️ THE MEASURED WALL SURVIVED THE BLANK — no 0, no dropped key",
    Boolean(sv) && sv.d3 && sv.d3.wallHeightFt === 9, JSON.stringify(sv && sv.d3 && sv.d3.wallHeightFt));
  // A half-typed number is out of the sanitiser's band too, and would be dropped just the same.
  await wallIn.click();
  await wallIn.fill("1");
  await wallIn.blur();
  await page.waitForTimeout(150);
  const nSaves2 = saveCalls.length;
  await page.getByRole("button", { name: /^Save 3D look$/ }).first().click();
  for (let i = 0; i < 100 && saveCalls.length === nSaves2; i++) await page.waitForTimeout(100);
  const sv2 = saveCalls[nSaves2] || null;
  r.ok("a 1 ft wall the sanitiser would drop never reaches the spec either",
    Boolean(sv2) && sv2.d3 && sv2.d3.wallHeightFt === 9, JSON.stringify(sv2 && sv2.d3 && sv2.d3.wallHeightFt));
  await setDim(wallIn, 9);
  r.ok("and typing a storable number puts the card back in business", (await genEnabled()) === true, await whyLine());

  // ── 10: AN OUT-OF-BAND WALL HEIGHT IS REFUSED ON SCREEN, NOT IN SILENCE ─────────────────
  // The regression, end to end: calSetDim refused an out-of-band number by RETURNING. With a
  // stored wall underneath it the spec never moved, calDimH kept reading the old value, the box
  // repainted it on blur -- and the gate OPENED, because focusing the field is the
  // confirmation, so the keystrokes that were thrown away were the ones that marked the old
  // number as checked. A generation then went out measured against the number the builder was
  // trying to replace, under a green "✓ 16 × 24 ft, 7 ft walls", with nothing on screen saying
  // anything had been refused. The width has always behaved correctly here; this is the wall
  // height catching up with it.
  const nGen = generateCalls.length;
  await setDim(wallIn, 25);
  r.ok("the number the builder typed stays on screen", (await wallIn.inputValue()) === "25", await wallIn.inputValue());
  r.ok("⚠️ AND IT LOCKS GENERATE — a refused keystroke cannot confirm the old value",
    (await genEnabled()) === false, await whyLine());
  r.ok("the line names the band, in the words the server would have used",
    /between 3 and 20/.test(await whyLine()), (await whyLine()).slice(0, 140));
  r.ok("the wall box is amber", (await borderOf(wallIn)) === AMBER, await borderOf(wallIn));
  r.ok("and the card is NOT showing a green tick over it",
    !(await page.evaluate(() => document.body.innerText)).includes("ft walls"),
    (await page.evaluate(() => (document.querySelector('[data-ssc-card="dims"]') || {}).innerText || "")).slice(0, 80));
  await shotCard("05-wall-out-of-band");
  r.ok("nothing was generated while it was refused", generateCalls.length === nGen, `${generateCalls.length - nGen} calls`);
  // THE TOP OF THE BAND IS 20 (contract §1: every 14-clamp moved to 20 in lock-step). A two-storey
  // middle section with 16 ft walls is an ordinary building now, and the card must not refuse it.
  await setDim(wallIn, 20);
  r.ok("⚠️ a 20 ft wall is inside the band — no refusal, Generate live",
    (await genEnabled()) === true && !/does not look right/.test(await whyLine()), (await whyLine()).slice(0, 120));
  await setDim(wallIn, 20.5);
  r.ok("and 20.5 is outside it, named in the server's own words", /between 3 and 20/.test(await whyLine()), (await whyLine()).slice(0, 120));
  await setDim(wallIn, 9);
  r.ok("a storable number clears the refusal", (await genEnabled()) === true, await whyLine());
  const a8 = await press("press 8 (after an out-of-band wall)");
  r.ok("and the wire carries the corrected number, never the refused one",
    Boolean(a8) && a8.dims.wallHeightFt === 9, JSON.stringify(a8 && a8.dims));

  // ── 11: AN OLDER SERVER IGNORES THE MEASUREMENTS; IT MUST NOT DESTROY THEM ─────────────
  // In the deploy window the prompt still asks for a wall height, the reply still carries the
  // model's guess, and calShapeMerged's `(d3 && d3.wallHeightFt) || spec.wallHeightFt` put that
  // guess over the number the builder had just been required to type and confirm. The step-2
  // box reads the same slice, so it flipped to the model's number too; wallSeen was already
  // true, so nothing turned amber, and Save wrote the guess into building_styles.d3 -- the
  // table production renders from. A two-minute window left a permanently wrong wall behind it.
  edgeEchoesDims = false;
  await openStyle("Barn", "barn");
  await setDim(widthIn, 16);
  await setDim(lengthIn, 24);
  await setDim(wallIn, 9);
  const a9 = await press("press 9 (a server that has not been updated)");
  r.ok("the browser sends the measurements anyway", Boolean(a9) && a9.dims && a9.dims.wallHeightFt === 9, JSON.stringify(a9 && a9.dims));
  r.ok("⚠️ AND THE TYPED WALL HEIGHT SURVIVES THE MODEL'S GUESS", (await wallIn.inputValue()) === "9", await wallIn.inputValue());
  r.ok("the field further down agrees with it", (await lowerWall.inputValue()) === "9", await lowerWall.inputValue());
  const oldServerText = await page.evaluate(() => document.body.innerText);
  r.ok("and the panel says the measurements did not reach the server",
    /measurements did not reach this server/.test(oldServerText));
  r.ok("without claiming a ruler it never had", !/Measured against your 16 × 24 ft with/.test(oldServerText));
  const nSaves3 = saveCalls.length;
  await page.getByRole("button", { name: /^Save 3D look$/ }).first().click();
  for (let i = 0; i < 100 && saveCalls.length === nSaves3; i++) await page.waitForTimeout(100);
  const sv3 = saveCalls[nSaves3] || null;
  r.ok("⚠️ AND SAVE WRITES THE MEASUREMENT, NOT THE GUESS", Boolean(sv3) && sv3.d3 && sv3.d3.wallHeightFt === 9,
    JSON.stringify(sv3 && sv3.d3 && sv3.d3.wallHeightFt));
  edgeEchoesDims = true;

  // ── 12: nothing slipped through ───────────────────────────────────────────────────────────
  const missing = generateCalls.filter((c) => !c.dims || !(c.dims.widthFt > 0) || !(c.dims.lengthFt > 0) || !(c.dims.wallHeightFt > 0)).length;
  r.ok("EVERY generation on the wire carried a complete set of dims", missing === 0, `${missing} of ${generateCalls.length} without`);
  r.ok("every generation still carried its idempotency key", generateCalls.filter((c) => !c.idempotencyKey).length === 0);
  r.ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\nshots: ${shots}`);
  await browser.close();
  const failed = r.failed();
  console.log(`\n${r.results.length - failed.length}/${r.results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
