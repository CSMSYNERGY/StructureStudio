// THE FREE SECOND PASS, DRIVEN — the renders on the wire, the pairs on the screen, the merge
// in the spec, and the four questions in front of Save.
//
// One press now does four things: draft, render the draft from the angles the first pass
// labelled, ask a free second call where it does not match, and merge whatever comes back.
// Only two of those are visible from the outside, and the two that are not are the ones that
// can be silently wrong — so this drives the real calibration panel in the shipped compiled
// portal, fakes the second call's REPLY, and reads what the browser actually sent and drew.
//
//    1. the renders leave the browser at all: four JPEGs, one per labelled viewpoint, each
//       naming its frame by INDEX INTO THE ARRAY THE GENERATION WAS SENT
//    2. a viewpoint the first pass did not label gets NO render. Nothing invents an angle
//    3. ⚠️ THE EAVE CAMERA EARNS ITS PLACE. The overhang is moved 0.15 -> 1.0 ft with nothing
//       else changed and the pixels are counted at each camera. It is the only field the
//       model has never got right in 19 generations, and it is checkable from exactly one of
//       the four views — if that stops being true, this fails
//    4. the pairs pair the frame the model named with the render of that view
//    5. ⚠️ THE CORRECTION IS MERGED ONTO THE PRE-GENERATION SPEC, ONCE. A correction that says
//       nothing about the porch must not resurrect the porch kind the draft replaced
//    6. the four questions gate Save, "not sure" counts as answered, "No" opens the controls
//       in the same row, and ⚠️ A HAND FIX REACHES THE PICTURES the builder is judging
//    7. the roof numbers reach the builder in FEET and never as a ratio, measured against the
//       building the RENDERS were drawn at rather than against whatever the preview is showing
//    8. 375 px: no horizontal overflow, and no image squeezed into half a phone
//    9. zero page errors throughout
//
// Stubbed at the NETWORK layer, like calDims.mjs: no account, no login, no writes, and the
// artifacts under test are the compiled bundles the browser really loads. A change that was
// never `npm run compile`d is invisible here, which is the point.
//
//   python -m http.server 8306 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/calSelfCheck.mjs            (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { join } from "node:path";
import { launch, reporter, collectErrors, shotsDir, REF, BASE, PASS_THROUGH_GET } from "./lib.mjs";

const CLIENT = "pw-demo-barns";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800; // 2100-01-01
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CHECK_ID = "11111111-2222-3333-4444-555555555555";
const SESSION = {
  access_token: jwt({ sub: USER_ID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// ⚠️ THE STORED SPEC HAS A RECESSED PORCH AND THE DRAFT WILL HAVE A PROJECTING ONE. That is
// the setup for assertion 5: `calDraftRoof` only clears the opposite porch key when the
// INCOMING draft declares one, so a correction that says nothing about the porch, applied on
// top of an already-merged draft, would leave porchDepthFt standing beside porchOutFt. The
// renderer draws one of them and Save writes both.
const STORED = {
  roof: { type: "gambrel", pitch: 0.5, overhang: 0.6, kneeU: 0.55, kneeRise: 0.55, ridgeRise: 0.8, porchDepthFt: 5, porchEnd: "front" },
  siding: "panel", colors: { body: "#8B7355", trim: "#D8CBB5", roof: "#3A3A3A" }, wallHeightFt: 7, roofMaterial: "metal",
};
const FRAMES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-b${i}.png`);
const STYLES = [{
  id: "barn", key: "barn", label: "Barn", code: "BAR", image_url: null, active: true,
  updated_at: "2026-09-14T10:00:00.000+00:00", show_image_on_estimate: true, d3: STORED,
  d3_photos: [], d3_video_frames: FRAMES,
  model_url: null, model_status: "none", model_uploaded_at: null, model_locked_at: null, model_meta: null, taxable: true,
}];
const CONFIG = {
  branding: { companyName: "PW Demo Barns", accentColor: "#8B4513", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [{ value: "barn", label: "Barn", sizes: [{ label: "16x24", w: 16, h: 24, price: 5000 }] }],
  defaultSizes: [], options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 7,
};
// The first pass's own labels. `corner` is deliberately ABSENT: a viewpoint the model did not
// name must produce no render and no pair, because the only alternative is guessing an angle.
const FRAME_MAP = {
  front: { frame: 1, azimuthDeg: 0 },
  side: { frame: 3, azimuthDeg: 90 },
  eaveCorner: { frame: 5, azimuthDeg: 270 },
};
// What the paid call drafts: a PROJECTING porch over the stored recessed one, the model's
// usual wrong 1.0 ft eave, and the builder's own wall height written in by the server.
const draftSpec = (dims, overhang) => ({
  roof: { type: "gambrel", pitch: 0.5, overhang, kneeU: 0.72, kneeRise: 0.72, ridgeRise: 1.0, porchOutFt: 6.5, porchEnd: "front" },
  wallHeightFt: dims ? dims.wallHeightFt : 7, siding: null, colors: { body: "#7A6A55" }, roofMaterial: "metal",
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Long enough for the browser's own SS_RESHOOT_MS debounce plus one off-screen render pass.
const SS_RESHOOT_SETTLE = 2500;

const genCalls = [];
const checkCalls = [];
// Flipped by the script to steer what the stubbed second call answers.
let checkReply = null;
let checkStatus = 200;
// The sibling of the 409: no reply at all. A network failure and the browser's own 60 s abort
// both raise FunctionsFetchError, whose `.context` is an Error rather than a Response — so the
// body-reading path throws and the vendor's fixed string is all that is left.
let checkAbort = false;
let draftOverhang = 1.0;
// Steered by the script for the no-pairs case: a first pass that produced no usable labels,
// which is the state the warning banner exists for and the one where it had no way out.
let draftFrameMap = FRAME_MAP;
let draftObserved = { roofNote: "Gambrel, read from the ground.", porch: "projecting", confidence: "medium" };

// How many pixels differ between two JPEG data URLs, as a fraction. Decoded with the same
// browser that drew them — there is no image decoder in node here, and shipping one to count
// pixels would be a second decoder to disagree with the first.
async function pixelDelta(page, a, b) {
  return page.evaluate(async ([ua, ub]) => {
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(ia, 0, 0); const A = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(ib, 0, 0); const B = ctx.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 12) n++;
    }
    return n / (w * h);
  }, [a, b]);
}

async function main() {
  const r = reporter();
  const { browser, ctx } = await launch({ width: 1500, height: 1100 });
  await ctx.addInitScript(([ref, s]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
    // COUNT THE RENDERS. Every off-screen shot ends in exactly one toDataURL, and each shot
    // opens its own WebGL context, so this is the cheapest true measure of how many contexts
    // a burst of presses asks for. Nothing else on this surface reads a canvas back.
    window.__ssShots = 0;
    const orig = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) { window.__ssShots += 1; return orig.apply(this, a); };
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
        genCalls.push(body);
        // The server's own shape since commit 6: `frameMap` says which image shows which view
        // and at what angle, `checkId` is the ledger row the free check claims against.
        return json(route, {
          ok: true, d3: draftSpec(body.dims, draftOverhang),
          frames: (body.photoUrls || []).length, dropped: 0,
          observed: draftObserved,
          balanceCents: 18000, dims: body.dims || null,
          frameMap: draftFrameMap, checkId: CHECK_ID,
        });
      }
      if (a === "calibrate_style_check") {
        checkCalls.push(body);
        if (checkAbort) return route.abort();
        return json(route, checkReply, checkStatus);
      }
      if (a === "save_style_d3") return json(route, { ok: true });
      return json(route, { ok: true });
    }
    return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
  };
  await page.route(`**/${REF}.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.functions.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.storage.supabase.co/**`, apiHandler);
  await page.route("**/__stub/img-*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), { timeout: 40000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  await page.getByText("Designer", { exact: true }).last().click();
  await page.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), { timeout: 40000 });

  const shots = shotsDir("calSelfCheck");
  const dimIn = page.locator("input.ssc-dim-in");
  const gen = page.getByRole("button", { name: /Generate the 3D model/ });
  const text = () => page.evaluate(() => document.body.innerText);

  const openStyle = async () => {
    await page.getByRole("button", { name: "Barn", exact: true }).first().click();
    await page.waitForFunction((want) => {
      const got = Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute("src"));
      return got.length === want.length && got.every((u, i) => u === want[i]);
    }, FRAMES, { timeout: 20000 });
    await page.waitForTimeout(250);
  };
  // The three dimension fields are the only .ssc-dim-in inputs until a fix panel opens, and
  // the card is above every one of those, so nth(0..2) is stable through the whole run.
  const setDims = async (w, l, h) => {
    const set = async (loc, v) => { await loc.click(); await loc.fill(String(v)); await loc.blur(); await page.waitForTimeout(120); };
    await set(dimIn.nth(0), w); await set(dimIn.nth(1), l); await set(dimIn.nth(2), h);
  };
  // One press, waited out to the end of the whole flow. The compare card only exists once the
  // check has settled, so waiting for it is waiting for all four steps — including the second
  // render a correction triggers, which is why it also waits for the button to come back.
  const press = async () => {
    const n = checkCalls.length, g = genCalls.length;
    await page.evaluate(() => { const el = document.querySelector('[data-ssc-card="compare"]'); if (el) el.setAttribute("data-ssc-stale", "1"); });
    await gen.first().click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-ssc-card="compare"]');
      const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
      return Boolean(el) && !el.getAttribute("data-ssc-stale") && Boolean(b) && !b.disabled;
    }, null, { timeout: 120000 });
    await page.waitForTimeout(400);
    return { gen: genCalls[g] || null, check: checkCalls[n] || null };
  };

  await openStyle();
  await setDims(16, 24, 9);

  // ── THE PROGRESS CARD, caught in flight ───────────────────────────────────────────────
  // ⚠️ THE MONEY LINE IS THE ASSERTION HERE. A builder who watches a four-step bar with no
  // explanation assumes four charges, and that sentence is what makes "the check always runs"
  // safe to ship. It has to be on screen WHILE the flow runs, not in a note afterwards.
  checkReply = { ok: true, verdict: "matches", d3: null, changed: [], checked: {}, note: "", renders: 3, ms: 900 };
  await gen.first().click();
  // Both readings in ONE evaluate. Taken in two, the flow can finish in the round trip
  // between them and the second one measures a panel that is already done — which is a
  // harness racing the app, not a finding about the app.
  let snap = { card: "", locked: false };
  for (let i = 0; i < 400 && !snap.card; i++) {
    snap = await page.evaluate(() => {
      const el = document.querySelector('[data-ssc-card="progress"]');
      // ⚠️ "Working…", NOT "Generate the 3D model". The button relabels itself for the whole
      // flow, so a locator keyed on the idle label finds nothing while it is busy and reads
      // that as "not disabled" — which is the exact opposite of what it is.
      const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model|Working/.test(x.textContent || ""));
      return { card: el ? el.textContent : "", locked: Boolean(b) && b.disabled, label: b ? b.textContent.trim() : "" };
    });
    if (!snap.card) await page.waitForTimeout(20);
  }
  const card = snap.card;
  r.ok("the progress card is on screen while the flow runs", Boolean(card), card.slice(0, 60));
  r.ok("⚠️ AND IT SAYS THE PRICE, ONCE, UNDER A RULE",
    card.includes("you are charged $20 once, however much we have to fix"), card.slice(-90));
  r.ok("with all four steps named, including the two that are new",
    card.includes("Checking our 3D against your video") && card.includes("Correcting anything that doesn't line up"));
  r.ok("and an honest wait, not a spinner", card.includes("Usually about a minute"));
  // A SECOND PRESS CANNOT HAPPEN WHILE THIS IS RUNNING, and it is the DOM that says so rather
  // than a guard inside the handler. Asserted by reading `disabled` rather than by clicking:
  // Playwright's click waits for a disabled button to come back and then presses it, which
  // would spend a second generation to prove the opposite of what it was measuring. (The
  // handler carries a swallow-and-answer branch as well, for any path that is not this
  // button; that one is unreachable from here by construction.)
  r.ok("⚠️ AND THE BUTTON IS LOCKED WHILE IT IS UP — a second press cannot spend twice",
    snap.locked, `button reads "${snap.label}"`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-ssc-card="compare"]');
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
    return Boolean(el) && Boolean(b) && !b.disabled;
  }, null, { timeout: 120000 });
  await page.waitForTimeout(300);

  // ── 1 + 2: what actually leaves the browser ───────────────────────────────────────────
  const a1 = { gen: genCalls[0], check: checkCalls[0] };
  r.ok("the paid call went out exactly once for that press", genCalls.length === 1, String(genCalls.length));
  r.ok("⚠️ THE FREE CHECK IS CALLED, with the ledger row the generation named",
    Boolean(a1.check) && a1.check.checkId === CHECK_ID, a1.check ? a1.check.checkId : "no call");
  r.ok("and it re-sends THE EXACT ARRAY the generation was given, uncompacted",
    Boolean(a1.check) && JSON.stringify(a1.check.photoUrls) === JSON.stringify(a1.gen.photoUrls),
    a1.check ? String((a1.check.photoUrls || []).length) : "-");

  const renders = (a1.check && a1.check.renders) || [];
  r.ok("⚠️ ONE RENDER PER LABELLED VIEWPOINT, AND NO OTHERS",
    renders.map((x) => x.viewpoint).join(",") === "front,side,eaveCorner",
    renders.map((x) => x.viewpoint).join(",") || "none");
  r.ok("⚠️ A VIEWPOINT THE MODEL DID NOT LABEL GETS NO RENDER — nothing invents an angle",
    !renders.some((x) => x.viewpoint === "corner"));
  r.ok("every render names its frame by index into that same array",
    renders.length > 0 && renders.every((x) => x.frame === FRAME_MAP[x.viewpoint].frame),
    JSON.stringify(renders.map((x) => [x.viewpoint, x.frame])));
  r.ok("and every one is a JPEG data URL the server's own sniff would accept",
    renders.length > 0 && renders.every((x) => /^data:image\/jpeg;base64,/.test(x.base64 || "")),
    renders.map((x) => (x.base64 || "").slice(0, 24)).join(" | "));
  const bytes = renders.map((x) => Math.round(((x.base64 || "").length * 3) / 4 / 1000));
  r.ok("each render is inside the server's 400 KB cap", bytes.every((b) => b < 400), bytes.join(", ") + " KB");
  r.ok("and the set is inside the 1.2 MB total", bytes.reduce((s, b) => s + b, 0) < 1200, bytes.reduce((s, b) => s + b, 0) + " KB");

  // ── 4: the pairs on the screen ────────────────────────────────────────────────────────
  const pairs = await page.evaluate(() => Array.from(document.querySelectorAll("[data-ssc-pair]")).map((el) => ({
    viewpoint: el.getAttribute("data-ssc-pair"),
    imgs: Array.from(el.querySelectorAll("img")).map((i) => ({ src: i.getAttribute("src") || "", alt: i.getAttribute("alt") })),
    head: (el.textContent || "").slice(0, 120),
  })));
  r.ok("one pair per render, in the order the viewpoints are asked about",
    pairs.map((p) => p.viewpoint).join(",") === "front,side,eaveCorner", pairs.map((p) => p.viewpoint).join(","));
  r.ok("⚠️ EACH PAIR SHOWS THE FRAME THE MODEL NAMED, not the k-th frame of the lap",
    pairs.length === 3 && pairs.every((p) => p.imgs[0].src === FRAMES[FRAME_MAP[p.viewpoint].frame - 1]),
    pairs.map((p) => p.imgs[0].src.slice(-10)).join(" "));
  r.ok("beside a render of that same view", pairs.every((p) => /^data:image\/jpeg/.test(p.imgs[1].src)));
  r.ok("and it says which view of theirs it came from", pairs.every((p) => /matched from your view \d/.test(p.head)), pairs[0] && pairs[0].head.slice(0, 80));
  r.ok("the builder's half is described, never labelled \"image 1\"",
    pairs.every((p) => /^Your video, /.test(p.imgs[0].alt || "")), pairs[0] && pairs[0].imgs[0].alt);
  r.ok("the 3D half is keyboard-reachable and says what the keys do",
    await page.evaluate(() => {
      const el = document.querySelector("[data-ssc-spin]");
      return Boolean(el) && el.tabIndex === 0 && /arrow keys turn it/i.test(el.getAttribute("aria-label") || "");
    }));

  // ── DRAG TO ROTATE, which is the escape hatch for a pairing the labels got wrong ──────
  // The frame map is a machine's reading of where a camera stood. When it is wrong the
  // builder can see it instantly and can do nothing about it without this control, so it is
  // the difference between "your 3D is wrong" and "your 3D is facing the other way".
  const shotSrc = (vp) => page.evaluate((v) => {
    const el = document.querySelector(`[data-ssc-pair="${v}"]`);
    const img = el ? el.querySelectorAll("img")[1] : null;
    return img ? img.getAttribute("src") : "";
  }, vp);
  const spun0 = await shotSrc("side");
  await page.locator('[data-ssc-pair="side"]').getByRole("button", { name: /Right/ }).click();
  await page.waitForFunction((b) => {
    const el = document.querySelector('[data-ssc-pair="side"]');
    const img = el ? el.querySelectorAll("img")[1] : null;
    return Boolean(img) && img.getAttribute("src") !== b;
  }, spun0, { timeout: 60000 }).catch(() => {});
  r.ok("⚠️ TURNING A PAIR RE-RENDERS ITS 3D HALF", (await shotSrc("side")) !== spun0);
  r.ok("and it says how far, out loud", /Turned 15 degrees/.test(await text()));
  // A HELD ARROW KEY. Auto-repeat fires keydown every few tens of milliseconds, and each
  // render opens its own off-screen WebGL context — browsers cap those hard. The renders
  // have to coalesce onto the last angle asked for rather than queue up one per press.
  const spinEl = page.locator('[data-ssc-spin="side"]');
  await spinEl.focus();
  const shotsBefore = await page.evaluate(() => window.__ssShots);
  // ⚠️ DISPATCHED IN ONE EVALUATE, NOT TWELVE press() CALLS. Each Playwright press is a round
  // trip, which spaces them further apart than a render takes — so they never overlap and the
  // pile-up this is measuring cannot happen. Real auto-repeat fires every few tens of
  // milliseconds with nothing between; this is that.
  await page.evaluate(() => {
    const el = document.querySelector('[data-ssc-spin="side"]');
    el.focus();
    for (let i = 0; i < 12; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await page.waitForFunction(() => /Turned 195 degrees/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  r.ok("⚠️ A BURST OF PRESSES LANDS ON THE LAST ANGLE, NOT THE FIRST",
    /Turned 195 degrees/.test(await text()), (await text()).match(/Turned \d+ degrees/g) || []);
  // ⚠️ THE ASSERTION THAT MAKES THE GUARD LOAD-BEARING. Without it each keydown opens its
  // own off-screen WebGL context, and twelve presses is twelve live contexts against a
  // browser limit near sixteen — with the docked panel and the page's own already in use.
  // "It landed on the right angle" passes either way; this is what does not.
  const burst = (await page.evaluate(() => window.__ssShots)) - shotsBefore;
  r.ok("⚠️ AND IT TOOK A HANDFUL OF RENDERS, NOT TWELVE — the contexts coalesce",
    burst > 0 && burst <= 4, `${burst} renders for 12 presses`);
  r.ok("and the page survived it — nothing thrown", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.locator('[data-ssc-pair="side"]').getByRole("button", { name: /Reset/ }).click();
  await page.waitForFunction(() => !/Turned \d+ degrees/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  r.ok("Reset puts it back to where the model said the camera was", !/Turned \d+ degrees/.test(await text()));

  // ── 3: the eave camera earns its place ────────────────────────────────────────────────
  // Re-generate with the ONE field moved and nothing else, then count the pixels that moved
  // at each camera. This is the measurement the whole eave viewpoint exists for, taken on the
  // real renderer rather than quoted from a design document.
  const flushRenders = renders.slice();
  draftOverhang = 0.15;
  const a2 = await press();
  const deepRenders = (a2.check && a2.check.renders) || [];
  const deltas = {};
  for (const v of ["front", "side", "eaveCorner"]) {
    const A = flushRenders.find((x) => x.viewpoint === v), B = deepRenders.find((x) => x.viewpoint === v);
    deltas[v] = (A && B) ? await pixelDelta(page, A.base64, B.base64) : 0;
  }
  const pct = (v) => (100 * deltas[v]).toFixed(2) + " %";
  // THE MARGIN IS 1.25, NOT THE 2.4 THE DESIGN MEASURED, and the difference is a finding
  // rather than a slackened assertion. The design's probe put the eave at 9.07 % against
  // 3.75 % at the wide head-on; on this building the head-on view sees the overhang far
  // better than that, because a 0.85 ft change in the RAKE runs the whole width of a 16 ft
  // gable end and there is a projecting porch under it catching the same change twice. The
  // eave camera is still the best of the four, which is the property that matters: it is the
  // one that has to keep working when the roof is shallow and the end is plain.
  r.ok("⚠️ THE EAVE CAMERA IS STILL THE BEST PLACE TO SEE THE OVERHANG",
    deltas.eaveCorner > 1.25 * Math.max(deltas.front, deltas.side),
    `eave ${pct("eaveCorner")} vs front ${pct("front")} / side ${pct("side")}`);
  r.ok("and it is a real signal, not rounding", deltas.eaveCorner > 0.02, pct("eaveCorner"));

  // ── 5: the merge ──────────────────────────────────────────────────────────────────────
  // The correction says nothing about the porch. Applied on top of the already-merged draft
  // it would leave the STORED recessed depth standing beside the DRAFT's projecting one.
  draftOverhang = 1.0;
  checkReply = {
    ok: true, verdict: "corrections",
    d3: { ...draftSpec({ wallHeightFt: 9 }, 0.15), roof: { ...draftSpec({ wallHeightFt: 9 }, 0.15).roof, overhang: 0.15 } },
    changed: [{ field: "roof.overhang", from: 1, to: 0.15, why: "The roof edge sits flush with the wall in your close-up." }],
    checked: { overhang: "changed", porch: "ok" }, note: "", renders: 3, ms: 2400,
  };
  const a3 = await press();
  r.ok("the check ran again on the new generation", checkCalls.length === 3, String(checkCalls.length));
  const merged = await page.evaluate(() => {
    const box = Array.from(document.querySelectorAll("input")).find((i) => /Overhang/.test((i.closest("label") || {}).textContent || ""));
    return box ? box.value : null;
  });
  r.ok("⚠️ THE CORRECTION REACHED THE SPEC — the overhang field shows what the check said",
    merged !== null && Math.abs(parseFloat(merged) - 0.15) < 0.001, String(merged));
  const porch = await page.evaluate(() => {
    const sel = Array.from(document.querySelectorAll("select")).find((s) => /porch/i.test((s.closest("label") || {}).textContent || ""));
    return sel ? sel.value : null;
  });
  r.ok("⚠️ AND IT DID NOT RESURRECT THE PORCH THE DRAFT REPLACED",
    porch === "projecting", `porch select reads ${porch}`);
  const body = await text();
  r.ok("the change is listed in words a builder owns, in inches",
    body.includes("How far the roof sticks out past the wall") && /12 in\s*→\s*2 in/.test(body),
    (body.match(/How far the roof sticks out past the wall[^\n]*/) || [""])[0]);
  r.ok("with the model's own sentence beside it", body.includes("sits flush with the wall in your close-up"));

  // ── 7: the roof in feet ───────────────────────────────────────────────────────────────
  r.ok("⚠️ THE ROOF IS READ BACK IN FEET, not as a ratio",
    /The bend sits \d+ ft/.test(body) && /the peak is \d+ ft/.test(body),
    (body.match(/The bend sits[^\n]*/) || [""])[0]);
  r.ok("and no ratio reaches the compare card at all",
    !/0\.\d\d/.test((body.match(/What we drew:[^\n]*/) || [""])[0]),
    (body.match(/What we drew:[^\n]*/) || [""])[0]);

  // ── 7b: MEASURED AGAINST THE BUILDING THE PICTURES ARE OF ─────────────────────────────
  // ssRoofInFeet turns kneeU, kneeRise and ridgeRise — all three RATIOS OF THE HALF-SPAN —
  // into feet, so the sentence is only true of the width it is handed. The card used to hand
  // it `bldgW`, the PREVIEW's width: seeded from the style's median catalog size and moved by
  // the "Preview on" picker, with nothing to do with the building that was filmed. The
  // pictures beside the sentence are rendered at the width the builder TYPED.
  //
  // This draft is ridgeRise 1.0, so the peak IS the half-span and the two answers are far
  // apart: 8 ft against the catalog 16, 12 ft against the typed 24. A builder holding a tape
  // to a 24 ft building was being told its peak stood 8 ft above the wall.
  await setDims(24, 30, 9);
  const a3b = await press();
  r.ok("the renders are taken at the size that was typed",
    Boolean(a3b.gen) && a3b.gen.dims && a3b.gen.dims.widthFt === 24, JSON.stringify(a3b.gen && a3b.gen.dims));
  const spanLine = async () => ((await text()).match(/What we drew:[^\n]*/) || [""])[0];
  r.ok("⚠️ AND THE ROOF READOUT IS MEASURED AGAINST THAT SAME SIZE, not the preview's",
    /the peak is 12 ft above the wall/.test(await spanLine()), await spanLine());
  // The preview is still parked on the catalog 16x24. Moving it must not rewrite one number in
  // a sentence about a building that has already been rendered and is already on screen.
  const spanBefore = await spanLine();
  const showIt = page.getByRole("button", { name: /Show it on 24 × 30/ });
  r.ok("the preview really is still on the catalog size", (await showIt.count()) > 0, String(await showIt.count()));
  await showIt.first().click();
  await page.waitForTimeout(600);
  r.ok("⚠️ AND MOVING THE PREVIEW DOES NOT REWRITE THE ROOF NUMBERS",
    (await spanLine()) === spanBefore, await spanLine());

  // ── 6: the four questions gate Save ───────────────────────────────────────────────────
  const saveEnabled = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /^Save 3D look$/.test((x.textContent || "").trim()));
    return Boolean(b) && !b.disabled;
  });
  const saveWhy = () => page.evaluate(() => {
    const el = document.querySelector("[data-ssc-save-why]");
    return el ? el.textContent.trim() : "";
  });
  // Amber or green is half of what this line says. A builder reads the colour before the
  // sentence, and four "No"s used to get the same green as four "Yes"es.
  const saveWhyColour = () => page.evaluate(() => {
    const el = document.querySelector("[data-ssc-save-why]");
    return el ? getComputedStyle(el).color : "";
  });
  const AMBER_TEXT = "rgb(180, 83, 9)", GREEN_TEXT = "rgb(22, 101, 52)";
  await page.locator('[data-ssc-card="compare"]').screenshot({ path: join(shots, "01-compare.png") });
  r.ok("⚠️ SAVE IS LOCKED UNTIL ALL FOUR ARE ANSWERED", (await saveEnabled()) === false);
  r.ok("and the reason is beside it, not only in a tooltip", /0 of 4 answered/.test(await saveWhy()), await saveWhy());

  const answer = async (key, which) => {
    // `exact` matters: "No" is a substring of "Not sure", and without it Playwright refuses
    // the click as ambiguous — which is the right refusal and the wrong locator.
    await page.locator(`[data-ssc-question="${key}"]`).getByRole("radio", { name: which, exact: true }).click();
    await page.waitForTimeout(150);
  };
  await answer("roof", "Yes");
  r.ok("the counter moves as they answer", /1 of 4 answered/.test(await saveWhy()), await saveWhy());
  await answer("porch", "Not sure");
  r.ok("\"Not sure\" COUNTS AS ANSWERED — nobody is made to click Yes to get past the gate",
    /2 of 4 answered/.test(await saveWhy()), await saveWhy());
  r.ok("and it leaves a mark on the row", (await text()).includes("Marked \"not sure\""));
  await answer("walls", "Yes");
  r.ok("three answers is still not four", (await saveEnabled()) === false, await saveWhy());

  // "No" opens the controls in the SAME row, never a link away.
  await answer("colours", "No");
  r.ok("all four answered unlocks Save", (await saveEnabled()) === true, await saveWhy());
  // ⚠️ ANSWERED IS NOT AGREED. calChecksAnswered counts any non-empty answer, so "No" -- the
  // signal that the draft is WRONG -- satisfied the gate exactly as "Yes" does. Four "No"s
  // with nothing changed unlocked Save under the same green "This replaces what your customers
  // see in 3D", and pressing it wrote the untouched draft. Save is still never blocked (a
  // builder must always be able to save); the line stops congratulating them.
  r.ok("⚠️ A 'No' NOBODY HAS ACTED ON IS NAMED, NOT CONGRATULATED",
    /You marked the colour as wrong/.test(await saveWhy()), await saveWhy());
  r.ok("in amber, not the green four Yeses get", (await saveWhyColour()) === AMBER_TEXT, await saveWhyColour());
  r.ok("and Save is still live — it is a warning, not a block", (await saveEnabled()) === true);
  r.ok("the row says it too, the way \"not sure\" already did",
    (await text()).includes("Marked wrong, and nothing here has changed yet"));
  const fixOpen = await page.evaluate(() => {
    const row = document.querySelector('[data-ssc-question="colours"]');
    return Boolean(row) && /Customers pick their own paint/.test(row.textContent || "");
  });
  r.ok("⚠️ \"No\" OPENS THE CONTROLS IN THE SAME ROW — never a dead end", fixOpen);
  // AND ACTING ON IT CLEARS IT. The test is "has this field moved since the answer", not "did
  // they open the panel", so typing a colour is what counts.
  await page.locator('[data-ssc-question="colours"] input[type="text"]').first().fill("#123456");
  await page.waitForTimeout(300);
  r.ok("⚠️ AND CHANGING IT PUTS THE LINE BACK", /replaces what your customers see in 3D/.test(await saveWhy()), await saveWhy());
  r.ok("in green", (await saveWhyColour()) === GREEN_TEXT, await saveWhyColour());
  r.ok("and the row's warning goes with it", !(await text()).includes("Marked wrong, and nothing here has changed yet"));

  // The roof fix panel is the one that matters: it must never show kneeU as a number.
  await answer("roof", "No");
  await page.waitForTimeout(200);
  const roofFix = await page.evaluate(() => {
    const row = document.querySelector('[data-ssc-question="roof"]');
    return {
      text: row ? row.textContent : "",
      ranges: row ? row.querySelectorAll('input[type="range"]').length : 0,
      tiles: row ? Array.from(row.querySelectorAll("button")).map((b) => b.textContent.trim()).filter((t) => /Barn roof|Two slopes|One slant/.test(t)).length : 0,
    };
  });
  r.ok("the roof panel offers the three shapes as tiles", roofFix.tiles === 3, String(roofFix.tiles));
  r.ok("and a barn roof gets TWO sliders, not three numeric boxes", roofFix.ranges === 2, String(roofFix.ranges));
  r.ok("⚠️ kneeU IS NEVER SHOWN AS A NUMBER", !/kneeU|knee u/i.test(roofFix.text));
  r.ok("the sliders are named after the building, not the field",
    /Where the bend sits/.test(roofFix.text) && /How steep the bottom part is/.test(roofFix.text));
  r.ok("and the roof edge is asked for in INCHES on this panel too",
    /How far the roof sticks out past the wall \(in\)/.test(roofFix.text));
  await page.locator('[data-ssc-question="roof"]').screenshot({ path: join(shots, "02-roof-fix.png") });

  // ⚠️ A HAND FIX HAS TO REACH THE PICTURES. calShotParams captures `style3d` BY VALUE, so
  // the pairs used to be frozen at the drafted shape for the whole confirm step: the sentence,
  // the elevation and the docked 3D all followed an edit and the three comparisons did not.
  // Every "No" opens a fix panel, so every hand correction hit this — and turning a pair
  // afterwards re-rendered the OLD building at a new angle, which reads as "I changed it, it
  // took a picture, and nothing happened".
  //
  // Measured on the PIXELS, not just on the src: a re-encode of the same building would change
  // the data URL and prove nothing. One slant against a barn roof is a different silhouette.
  const pairBeforeFix = await shotSrc("front");
  await page.locator('[data-ssc-question="roof"]').getByRole("button", { name: /One slant/ }).click();
  await page.waitForFunction((b) => {
    const el = document.querySelector('[data-ssc-pair="front"]');
    const img = el ? el.querySelectorAll("img")[1] : null;
    return Boolean(img) && img.getAttribute("src") !== b;
  }, pairBeforeFix, { timeout: 60000 }).catch(() => {});
  const pairAfterFix = await shotSrc("front");
  r.ok("⚠️ CHANGING THE ROOF BY HAND RE-SHOOTS THE COMPARE PAIRS", pairAfterFix !== pairBeforeFix);
  r.ok("and the new picture is a DIFFERENT BUILDING, not a re-encode of the same one",
    (await pixelDelta(page, pairBeforeFix, pairAfterFix)) > 0.01,
    ((await pixelDelta(page, pairBeforeFix, pairAfterFix)) * 100).toFixed(2) + "% of pixels");
  // ⚠️ AND SO DOES THE ROTATE CONTROL, which reads calShotRef's captured params rather than
  // the spec. Turning any picture changes it, so "the src moved" proves nothing here — the
  // question is WHICH BUILDING came back. Turn it, put it back with Reset, and the render at
  // the original angle has to be the SHED again. Drawn from the stale params it would be the
  // gambrel, and would land back on pairBeforeFix instead.
  const spunAfterFix = await shotSrc("front");
  await page.locator('[data-ssc-pair="front"]').getByRole("button", { name: /Right/ }).click();
  await page.waitForFunction((b) => {
    const el = document.querySelector('[data-ssc-pair="front"]');
    const img = el ? el.querySelectorAll("img")[1] : null;
    return Boolean(img) && img.getAttribute("src") !== b;
  }, spunAfterFix, { timeout: 60000 }).catch(() => {});
  await page.locator('[data-ssc-pair="front"]').getByRole("button", { name: /Reset/ }).click();
  await page.waitForTimeout(1500);
  const pairReset = await shotSrc("front");
  const dShed = await pixelDelta(page, pairReset, pairAfterFix);
  const dBarn = await pixelDelta(page, pairReset, pairBeforeFix);
  r.ok("⚠️ AND THE ROTATE CONTROL DRAWS THE CORRECTED BUILDING, not the replaced one",
    dShed < 0.01 && dBarn > 0.01, `${(dShed * 100).toFixed(2)}% from the shed, ${(dBarn * 100).toFixed(2)}% from the barn roof`);
  // Back to the barn roof, so the slider assertions below are about the panel they were written
  // for. The re-shoot rides along with it.
  await page.locator('[data-ssc-question="roof"]').getByRole("button", { name: /Barn roof/ }).click();
  await page.waitForTimeout(SS_RESHOOT_SETTLE);

  // Dragging the sliders must not be able to build the roof the warning refuses. The unit
  // test proves that over the whole grid; this proves the slider is wired to the function.
  const before = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("input")).find((i) => /Ridge rise/.test((i.closest("label") || {}).textContent || ""));
    return el ? el.value : null;
  });
  await page.locator('[data-ssc-question="roof"] input[type="range"]').first().fill("90");
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("input")).find((i) => /Ridge rise/.test((i.closest("label") || {}).textContent || ""));
    return el ? el.value : null;
  });
  r.ok("a slider drag writes all three gambrel numbers, including the derived one",
    before !== null && after !== null && before !== after, `${before} -> ${after}`);
  await answer("roof", "Yes");

  // ⚠️ THE WHOLE GATE, ON THE WORST ANSWER A BUILDER CAN GIVE. Four "No"s and nothing
  // touched: the draft is wrong in all four measured failure classes and the panel used to
  // say "This replaces what your customers see in 3D ... You can change it again any time"
  // in green, exactly as if they had agreed with every one of them.
  await press();
  for (const k of ["roof", "porch", "walls", "colours"]) await answer(k, "No");
  r.ok("four \"No\"s still count as four answers", /4 of 4 answered/.test(await text()));
  r.ok("⚠️ AND ALL FOUR ARE NAMED UNDER SAVE",
    /You marked the roof, porch, wall height and colour as wrong/.test(await saveWhy()), await saveWhy());
  r.ok("in amber", (await saveWhyColour()) === AMBER_TEXT, await saveWhyColour());
  r.ok("with Save still live, because a builder must always be able to save", (await saveEnabled()) === true);
  await page.locator('[data-ssc-card="compare"]').screenshot({ path: join(shots, "05-four-nos.png") });

  // ── THE WARNING BANNER HAS TO REACH A CONTROL, INCLUDING WHERE THERE ARE NO PAIRS ─────
  // The banner is a machine warning promoted out of "What the model saw", and its whole
  // point is that a builder should not have to work out which of the four questions it was
  // about. Its button sets adminCalFix — and the only place a fix panel renders is inside
  // SS_CHECKS.map, which is behind `calPairs.length > 0`. So in exactly the state the banner
  // is loudest for (no labels, or a device that could not render) the button changed nothing
  // at all: no scroll, no message, not one node.
  //
  // THE WALL-HEIGHT WARNING IS THE THIRD ONE, and it was the one the banner's regex never
  // recognised. knownDimsNote fires when a wall the builder MEASURED could not be drawn, so
  // the preview they are about to confirm against their own frames is of another building.
  draftFrameMap = null;
  draftObserved = {
    roofNote: "Check the wall height before saving: you gave 16 ft, and the 3D can only draw a wall between 5 and 14 ft, so it has been drawn at 14 ft.",
    confidence: "low",
  };
  await press();
  const noPairs = await page.evaluate(() => ({
    pairs: document.querySelectorAll("[data-ssc-pair]").length,
    questions: document.querySelectorAll("[data-ssc-question]").length,
  }));
  r.ok("a first pass with no labels shows no pairs — and so no questions to hang a fix panel on",
    noPairs.pairs === 0 && noPairs.questions === 0, JSON.stringify(noPairs));
  // ⚠️ AND IT MUST NOT SEND THEM TO THE 3D PREVIEW. The same line is shown when the DEVICE
  // could not render at all (no WebGL, a lost context), and on that device the docked preview
  // beside this card has already failed and the full-screen one will too — so the only remedy
  // the card offered was the one thing that could not work there.
  const compareText = await page.evaluate(() => {
    const el = document.querySelector('[data-ssc-card="compare"]');
    return el ? el.innerText : "";
  });
  const noPairLine = (compareText.match(/We couldn't put[^\n]*/) || [""])[0];
  r.ok("⚠️ NOTHING ON THE CARD SENDS A DEVICE THAT CANNOT RENDER TO THE 3D PREVIEW",
    Boolean(compareText) && !/3D preview/i.test(compareText), (compareText.match(/[^\n]*3D preview[^\n]*/) || ["none"])[0]);
  r.ok("and the no-pairs line points at what works on any device instead",
    /What we drew/.test(noPairLine) && /dimension drawing/.test(noPairLine), noPairLine);
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[data-ssc-card="compare"] [role="alert"]');
    return el ? el.textContent : "";
  });
  r.ok("⚠️ THE WALL-HEIGHT WARNING GETS A BANNER, like the other two",
    /Check the wall height before saving/.test(banner), banner.slice(0, 80));
  r.ok("and its button names the control it opens", /Open the wall height controls/.test(banner), banner.slice(-60));
  const cardBefore = await page.evaluate(() => {
    const el = document.querySelector('[data-ssc-card="compare"]');
    return { text: el ? el.innerText : "", nodes: el ? el.querySelectorAll("*").length : 0 };
  });
  await page.locator('[data-ssc-card="compare"] [role="alert"]').getByRole("button", { name: /Open the wall height controls/ }).click();
  await page.waitForTimeout(300);
  const cardAfter = await page.evaluate(() => {
    const el = document.querySelector('[data-ssc-card="compare"]');
    const alert = document.querySelector('[data-ssc-card="compare"] [role="alert"]');
    return {
      text: el ? el.innerText : "", nodes: el ? el.querySelectorAll("*").length : 0,
      inputs: alert ? alert.querySelectorAll("input").length : 0,
      alertText: alert ? alert.innerText : "",
    };
  });
  r.ok("⚠️ AND PRESSING IT OPENS THAT CONTROL RATHER THAN DOING NOTHING",
    cardAfter.nodes > cardBefore.nodes && cardAfter.inputs > 0,
    `${cardBefore.nodes} -> ${cardAfter.nodes} nodes, ${cardAfter.inputs} input(s) in the banner`);
  r.ok("and the control it opened is the wall height, in the builder's words",
    /Floor to the top of the side wall/.test(cardAfter.alertText), cardAfter.alertText.slice(-90));
  await page.locator('[data-ssc-card="compare"] [role="alert"]').getByRole("button", { name: /Hide the wall height controls/ }).click();
  await page.waitForTimeout(200);
  r.ok("and it closes again", (await page.evaluate(() => {
    const a = document.querySelector('[data-ssc-card="compare"] [role="alert"]');
    return a ? a.querySelectorAll("input").length : -1;
  })) === 0);
  draftFrameMap = FRAME_MAP;
  draftObserved = { roofNote: "Gambrel, read from the ground.", porch: "projecting", confidence: "medium" };

  // ── THE SAME BANNER WITH PAIRS ON SCREEN, which is the normal outcome ─────────────────
  // The no-pairs case above renders the panel inside the banner. With pairs it opens in its
  // own QUESTION'S row instead — the right place, next to the pictures the answer is about,
  // and about a thousand pixels below the button that opened it. Nothing scrolled, nothing
  // near the button changed, and the label was gated on `!calPairs.length` so it could never
  // read "Hide": pressing it again, the one thing a builder would try next, shut what the
  // first press had opened.
  await page.setViewportSize({ width: 1400, height: 800 });
  draftObserved = {
    roofNote: "Check this roof before saving: the bend sits so close to the peak that this will draw like a plain gable. Raise Knee rise, or move the bend nearer the wall.",
    porch: "projecting", confidence: "low",
  };
  await press();
  const bannerBtn = page.locator('[data-ssc-card="compare"] [role="alert"] button').first();
  r.ok("the roof warning gets its banner with pairs on screen too",
    /Open the roof controls/.test(await bannerBtn.innerText()), await bannerBtn.innerText());
  // Put the banner at the top of the window, so "is the control it opens on screen?" is a
  // question about the distance between them and not about where the page happened to sit.
  await page.evaluate(() => {
    const a = document.querySelector('[data-ssc-card="compare"] [role="alert"]');
    if (a) a.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(300);
  const rowState = () => page.evaluate(() => {
    const row = document.querySelector('[data-ssc-question="roof"]');
    const b = row ? row.getBoundingClientRect() : null;
    const btn = document.querySelector('[data-ssc-card="compare"] [role="alert"] button');
    return {
      inputs: row ? row.querySelectorAll("input").length : -1,
      top: b ? Math.round(b.top) : null,
      inView: Boolean(b) && b.top < window.innerHeight && b.bottom > 0,
      label: btn ? btn.innerText.trim() : "",
      expanded: btn ? btn.getAttribute("aria-expanded") : null,
      controls: btn ? btn.getAttribute("aria-controls") : null,
      scrollY: Math.round(window.scrollY),
      winH: window.innerHeight,
    };
  });
  const bBefore = await rowState();
  r.ok("the controls it names are off the bottom of the window before it is pressed",
    bBefore.inView === false, `roof row at ${bBefore.top}, window ${bBefore.winH} tall`);
  r.ok("and the button says so to a screen reader",
    bBefore.expanded === "false" && bBefore.controls === "ssc-fix-roof", `${bBefore.expanded} / ${bBefore.controls}`);
  await bannerBtn.click();
  await page.waitForTimeout(900);
  const bAfter = await rowState();
  r.ok("⚠️ PRESSING IT PUTS THE CONTROL IN FRONT OF THE BUILDER", bAfter.inView === true && bAfter.inputs > 0,
    `${bBefore.inputs} -> ${bAfter.inputs} inputs, row ${bBefore.top} -> ${bAfter.top}, scrollY ${bBefore.scrollY} -> ${bAfter.scrollY}`);
  r.ok("⚠️ AND THE LABEL SAYS WHICH WAY THE TOGGLE IS POINTING", /Hide the roof controls/.test(bAfter.label), bAfter.label);
  r.ok("with aria-expanded to match", bAfter.expanded === "true", String(bAfter.expanded));
  await bannerBtn.click();
  await page.waitForTimeout(300);
  const bClosed = await rowState();
  r.ok("and pressing it again closes what it opened, saying so",
    bClosed.inputs === 0 && /Open the roof controls/.test(bClosed.label), `${bClosed.inputs} inputs, "${bClosed.label}"`);
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.waitForTimeout(300);

  // ── A CORRECTION TO A KEY THE DRAFT NEVER CARRIED ─────────────────────────────────────
  // applySelfCheck reports `from: before ?? null` off the two sanitised specs, and an absent
  // key is exactly what the shape-first prompt asks the model to leave out — while the
  // check's own prompt then asks specifically about the eave. Straight through a per-field
  // formatter, Math.round(Number(null)) is 0 and String(null) is "null", so the list a builder
  // is told to read line by line said "The roof edge — null → open" and "How far apart the
  // rafter tails are — 0 in → 24 in" for a measurement nobody made.
  const eaveSpec = draftSpec({ wallHeightFt: 9 }, 1.0);
  checkReply = {
    ok: true, verdict: "corrections",
    d3: { ...eaveSpec, roof: { ...eaveSpec.roof, eave: "open", tailSpacingIn: 24 } },
    changed: [
      { field: "roof.eave", from: null, to: "open", why: "rafter tails visible at the corner" },
      { field: "roof.tailSpacingIn", from: null, to: 24, why: "counted against the wall" },
      { field: "roof.porchDepthFt", from: 6, to: null, why: "the recess the projection replaced" },
    ],
    checked: { eave: "changed" }, note: "", renders: 3, ms: 1800,
  };
  await press();
  const changeList = await page.evaluate(() => {
    const ul = document.querySelector('[data-ssc-card="compare"] ul');
    return ul ? ul.innerText : "";
  });
  const listLine = (re) => (changeList.split("\n").find((l) => re.test(l)) || "");
  r.ok("⚠️ NO 'null' REACHES THE BUILDER", !/null/i.test(changeList), changeList.split("\n").join(" | ").slice(0, 160));
  r.ok("⚠️ AND NO FABRICATED ZERO EITHER", !/(^|\s)0 in →/.test(changeList), listLine(/rafter tails are/));
  r.ok("a value the draft never had reads 'not set'", /not set →/.test(changeList), listLine(/roof edge/));
  r.ok("the eave is in words a builder owns, not our enum",
    /rafter tails showing/.test(changeList) && !/→ open/.test(changeList), listLine(/roof edge/));
  r.ok("and a key the correction removed reads 'gone', not 0 ft", /→ gone/.test(changeList), listLine(/porch goes into/));

  // ⚠️ AND THE BUILDER CAN PUT IT BACK. roof.eave is on the self-check's allow-list and the
  // renderer draws rafter tails from it, but nothing in this panel could set it — so a check
  // that turned the tails on could only be undone by paying for another generation.
  // "No" opens the controls in the same row — the route a builder who can see the tails takes.
  await answer("roof", "No");
  const eaveTiles = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-ssc-question="roof"] button'))
    .filter((b) => /Rafter tails showing|Boxed in/.test(b.innerText))
    .map((b) => ({ label: b.innerText.split("\n")[0].trim(), on: b.getAttribute("aria-pressed") === "true" })));
  const tiles0 = await eaveTiles();
  r.ok("the roof controls carry a roof-edge control at all", tiles0.length === 2, JSON.stringify(tiles0));
  r.ok("and it shows what the check turned on", tiles0.some((t) => /Rafter tails/.test(t.label) && t.on), JSON.stringify(tiles0));
  await page.locator('[data-ssc-question="roof"]').getByRole("button", { name: /Boxed in/ }).first().click();
  await page.waitForTimeout(300);
  const tiles1 = await eaveTiles();
  r.ok("⚠️ AND ONE TAP PUTS THE ROOF EDGE BACK, with no second $20",
    tiles1.some((t) => /Boxed in/.test(t.label) && t.on) && tiles1.every((t) => !/Rafter tails/.test(t.label) || !t.on),
    JSON.stringify(tiles1));

  // ── The money line and the honest failure, on the same surface ────────────────────────
  checkReply = { ok: true, verdict: "skipped", reason: "off", d3: null, changed: [], checked: {}, note: "", renders: 0, ms: 5 };
  const a4 = await press();
  r.ok("a check that does not run still leaves the builder their draft and their pairs",
    (await page.evaluate(() => document.querySelectorAll("[data-ssc-pair]").length)) === 3,
    String(await page.evaluate(() => document.querySelectorAll("[data-ssc-pair]").length)));
  r.ok("⚠️ AND IT SAYS THE *CHECK* FAILED, NEVER THE GENERATION",
    (await text()).includes("We couldn't run our own check this time") && (await text()).includes("You were charged once, as usual"));
  void a4;

  // ── A 409 IS THE CHECK REFUSING, NOT THE GENERATION FAILING ───────────────────────────
  // `calibrate_style_check` answers 409 when the row has already been checked or is too old,
  // and supabase-js turns that into a FunctionsHttpError whose message is "Edge Function
  // returned a non-2xx status code". Reporting THAT to a builder — on a screen where they
  // have just spent $20 — is the failure this covers: the body carries the real sentence and
  // the host has to read it.
  checkStatus = 409;
  checkReply = { error: "That generation has already been checked, or it is too old to check now.", code: "check_unavailable" };
  await press();
  checkStatus = 200;
  const after409 = await text();
  r.ok("⚠️ A 409 ON THE CHECK STILL LEAVES THE BUILDER THEIR DRAFT AND THEIR PAIRS",
    (await page.evaluate(() => document.querySelectorAll("[data-ssc-pair]").length)) === 3);
  r.ok("and it is reported as the CHECK not running, never as a failed generation",
    after409.includes("We couldn't run our own check this time") && after409.includes("You were charged once, as usual"));
  r.ok("the raw supabase-js wording never reaches the builder",
    !/non-2xx status code/i.test(after409));

  // ── AND NEITHER DOES THE SIBLING CASE, WHICH HAS NO BODY TO READ ──────────────────────
  // A dropped connection, or the 60 s client abort, raises FunctionsFetchError: `.context` is
  // the underlying Error and not a Response, so reading the body throws and `error.message` is
  // the vendor's own fixed string. The panel renders `note` verbatim under its friendly line,
  // so "Failed to send a request to the Edge Function" was landing on the screen a builder
  // reaches after spending $20. Same rule as the 409 above, applied to the case with nothing
  // to read.
  checkAbort = true;
  await press();
  checkAbort = false;
  const afterAbort = await text();
  r.ok("⚠️ AN UNREACHABLE CHECK STILL LEAVES THE BUILDER THEIR DRAFT AND THEIR PAIRS",
    (await page.evaluate(() => document.querySelectorAll("[data-ssc-pair]").length)) === 3);
  r.ok("and it says the CHECK could not run",
    afterAbort.includes("We couldn't run our own check this time") && afterAbort.includes("You were charged once, as usual"));
  r.ok("⚠️ AND THE VENDOR'S OWN SENTENCE NEVER REACHES THE SCREEN",
    !/Failed to send a request to the Edge Function/i.test(afterAbort),
    (afterAbort.match(/[^\n]*Edge Function[^\n]*/) || ["none"])[0]);

  // ── 8: 375 px ─────────────────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 900 });
  await page.waitForTimeout(600);
  const phone = await page.evaluate(() => {
    const card = document.querySelector('[data-ssc-card="compare"]');
    const pair = document.querySelector("[data-ssc-pair]");
    const imgs = pair ? Array.from(pair.querySelectorAll("img")).map((i) => {
      const b = i.getBoundingClientRect();
      return { w: Math.round(b.width), left: Math.round(b.left) };
    }) : [];
    const inner = pair ? Math.round(pair.getBoundingClientRect().width) - 18 : 0;
    return {
      doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
      card: card ? [card.scrollWidth, card.clientWidth] : null,
      imgs, inner,
      // What is actually sticking out, named. A bare "381 vs 375" sends whoever sees it
      // hunting through the whole panel.
      wide: Array.from(document.querySelectorAll("*")).filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width > 0 && (b.right > document.documentElement.clientWidth + 1 || b.left < -1);
      }).slice(0, 6).map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("data-ssc-card") ? "[" + e.getAttribute("data-ssc-card") + "]" : ""} ${Math.round(e.getBoundingClientRect().width)}w @${Math.round(e.getBoundingClientRect().left)}`),
      dock: document.querySelectorAll("canvas").length,
    };
  });
  r.ok("no horizontal page scroll at 375", phone.doc[0] === phone.doc[1], `${phone.doc.join(" vs ")} — ${phone.wide.join(" | ") || "nothing crosses the edge"}`);
  r.ok("and the compare card does not overflow its own box", phone.card && phone.card[0] === phone.card[1], String(phone.card));
  // ⚠️ MEASURED AS "THEY STACK", NOT AS A PIXEL COUNT. The calibration panel is about 203 px
  // wide inside a 375 px portal — the portal's own chrome takes the rest, and that is true of
  // every card on this surface (the dimensions card measured 218 at 390 px when it shipped).
  // So "no half is squeezed" cannot be an absolute number here; what it means is that the two
  // halves are in ONE column, each the full width of the card, rather than side by side.
  r.ok("⚠️ THE TWO HALVES STACK RATHER THAN HALVING — same left edge, one column",
    phone.imgs.length === 2 && phone.imgs[0].left === phone.imgs[1].left,
    phone.imgs.map((i) => `${i.w}w @${i.left}`).join(" | "));
  r.ok("and each one fills the card it is in", phone.imgs.every((i) => i.w >= phone.inner - 6),
    `${phone.imgs.map((i) => i.w).join(", ")} in ${phone.inner}`);
  await page.locator('[data-ssc-card="compare"]').screenshot({ path: join(shots, "03-phone-375.png") });

  // ⚠️ AND A WAY OUT OF THE COLUMN, because stacking is not the same as being legible. The
  // panel has about 205 px inside a 375 px portal — a 68 px icon rail plus four levels of
  // gutter — so each half above is 161 px wide, and a 16:9 frame letterboxed into a 4:3 box
  // paints about 161 x 91 of actual picture. The Your photo / Your 3D control cannot help:
  // the grid is already one column below ~700 px, so "full width" is that same 161 px. Our
  // own "Preview in 3D" opens a 375-wide canvas on this very screen, so the render got the
  // window and the builder's evidence got a stamp — and the four questions are answered
  // against the stamp.
  const inPanelW = phone.imgs[0] ? phone.imgs[0].w : 0;
  await page.locator('[data-ssc-pair="front"] [data-ssc-zoom-open]').first().click();
  await page.waitForTimeout(350);
  const zoomed = await page.evaluate(() => {
    const ov = document.querySelector("[data-ssc-zoom]");
    const b = ov ? ov.getBoundingClientRect() : null;
    return {
      open: Boolean(ov),
      imgs: ov ? Array.from(ov.querySelectorAll("img")).map((i) => Math.round(i.getBoundingClientRect().width)) : [],
      width: b ? Math.round(b.width) : 0,
      turn: ov ? Array.from(ov.querySelectorAll("button")).some((x) => /Left|Right/.test(x.innerText)) : false,
      doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    };
  });
  r.ok("a pair can be opened out of the panel's column", zoomed.open && zoomed.imgs.length === 2, JSON.stringify(zoomed.imgs));
  r.ok("⚠️ AT THE WIDTH OF THE WINDOW, not the width of the column",
    zoomed.imgs.every((w) => w >= 330) && zoomed.imgs[0] > inPanelW * 1.8, `${zoomed.imgs.join(", ")} against ${inPanelW} in the panel`);
  r.ok("with the turn controls still there, so a bad pairing can be straightened from here", zoomed.turn);
  r.ok("and it does not put the page into horizontal scroll", zoomed.doc[0] === zoomed.doc[1], zoomed.doc.join(" vs "));
  await page.locator("[data-ssc-zoom]").screenshot({ path: join(shots, "04-phone-enlarged.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  r.ok("Escape closes it", (await page.evaluate(() => document.querySelectorAll("[data-ssc-zoom]").length)) === 0);

  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.waitForTimeout(400);

  // ── THE CAPTION'S NUMBER IS STEP 1'S NUMBERING, EVEN WHEN THE LAP IS STRIDED ─────────
  // `pair.frame` is a 1-based index into the array THIS REQUEST WAS SENT, and calGenerateSet
  // strides the lap whenever photos crowd it: with 8 frames and 8 photos it keeps
  // max(CAL_VIDEO_MIN, CAL_PHOTO_MAX - photos) = 4 of them — walk 1, 3, 5, 7. Step 1 numbers
  // the builder's thumbnails 1..8 by their position in the lap. So "matched from your view 2"
  // pointed at the thumbnail step 1 calls View 3, on the one cross-reference a builder has for
  // "that pairing looks wrong, let me go and look at that frame". The pictures were always
  // right; only the number lied, and this panel already deleted four numbered photo slots on
  // the rule that a label that is wrong is worse than no label.
  STYLES[0].d3_photos = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-p${i}.png`);
  draftFrameMap = { front: { frame: 1, azimuthDeg: 0 }, side: { frame: 2, azimuthDeg: 90 }, eaveCorner: { frame: 4, azimuthDeg: 270 } };
  checkReply = { ok: true, verdict: "matches", d3: null, changed: [], checked: {}, note: "", renders: 3, ms: 900 };
  await openStyle();
  await setDims(16, 24, 9);
  const strided = await press();
  r.ok("with eight photos beside it the lap is strided, not sent whole",
    Boolean(strided.gen) && strided.gen.videoCount === 4 && strided.gen.photoUrls.length === 12,
    `${strided.gen && strided.gen.videoCount} walk of ${strided.gen && strided.gen.photoUrls.length}`);
  const captions = await page.evaluate(() => {
    const lap = {};
    for (const img of Array.from(document.querySelectorAll('img[alt^="View "]'))) {
      lap[img.getAttribute("src")] = Number((img.getAttribute("alt") || "").replace(/\D+/g, ""));
    }
    return Array.from(document.querySelectorAll("[data-ssc-pair]")).map((el) => {
      const img = el.querySelector("img");
      const src = img ? img.getAttribute("src") : "";
      const said = (el.textContent.match(/matched from your view (\d+)/) || [])[1];
      return { viewpoint: el.getAttribute("data-ssc-pair"), said: said ? Number(said) : null, step1: lap[src] || null };
    });
  });
  r.ok("every pair still names a view of theirs", captions.length === 3 && captions.every((c) => c.said),
    JSON.stringify(captions));
  r.ok("⚠️ AND THE NUMBER IT NAMES IS THE THUMBNAIL STEP 1 LABELS",
    captions.every((c) => c.said === c.step1), captions.map((c) => `${c.viewpoint}: said ${c.said}, step 1 calls it ${c.step1}`).join(" | "));
  // The assertion above passes trivially on an unstrided lap, where the two numberings agree.
  // This is what proves the run actually exercised the case.
  r.ok("and the stride really did move them apart from the request's own indices",
    captions.some((c) => c.said !== ({ front: 1, side: 2, eaveCorner: 4 })[c.viewpoint]),
    captions.map((c) => `${c.viewpoint}: request ${({ front: 1, side: 2, eaveCorner: 4 })[c.viewpoint]} -> lap ${c.said}`).join(" | "));
  STYLES[0].d3_photos = [];

  // ── 9: no page errors ─────────────────────────────────────────────────────────────────
  r.ok("zero page errors across the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n  pixels moved by the overhang: eave ${pct("eaveCorner")} · front ${pct("front")} · side ${pct("side")}`);
  console.log(`  render bytes: ${bytes.join(", ")} KB`);
  console.log(`  shots: ${shots}`);
  await browser.close();
  const bad = r.failed();
  console.log(`\n${bad.length ? `${bad.length} FAILED` : "all checks passed"} (${r.results.length} checks)`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
