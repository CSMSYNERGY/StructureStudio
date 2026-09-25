// ONE PRESS IS ONE HOLD IS ONE CHARGE — measured on the wire.
//
// `calibrate_style_ai` has always read `idempotencyKey` off the body and handed it to
// `wallet_hold`, whose `wallet_tx_idem` unique index is what stops a second $20 hold for one
// builder intent. Until 2026-09-18 the panel never sent one, so the index had nothing to work
// with: a double-press was still caught by the one-hold index (409 hold_in_flight), but a press
// AFTER the 110 s model timeout was not — that path releases the hold, so the next press took a
// fresh one. One intent, two holds.
//
// This drives the REAL calibration panel in the SHIPPED compiled portal and reads what left the
// browser, which is the only place the claim can be checked: the key lives in a ref, renders
// nothing, and shows up in no DOM.
//
//   1. a press sends a key at all, and it is a UUID
//   2. a RETRY of that press sends the SAME key — the failure is what makes it a retry
//   3. the retry that finally succeeds still carries it: one intent, one charge, however many
//      attempts it took
//   4. the NEXT press, after a draft has landed, sends a DIFFERENT key — it is a new generation
//   5. two different styles never share a key. Carrying one building's key to the next would
//      REFUSE that generation outright once the meter is armed, which is the opposite failure
//      and costs the builder just as much
//   6. no press ever leaves the key out, and zero page errors
//   7. ⚠️ A `retryable` REPLY IS RESENT ONCE, BY ITSELF, IN THE SAME PRESS (2026-09-24). A draft
//      cut off at max_tokens comes back `retryable: true` with the hold already released, and the
//      panel sends it again with `lean: true` under the SAME key -- two calls on the wire, one
//      press, no second press asked of the builder. Never a third call, never on any other
//      failure (1-6 above are all non-retryable, and every one of them is exactly one call), and
//      a press that fails lean as well leaves the key pending for the builder's own retry.
//   8. ⚠️ THE STREAMED ANSWER (2026-09-25). A press asks for `stream: true`, and the server answers
//      200, a heartbeat of spaces, then the JSON, with a failure riding in that body beside the
//      status it would have had. A `retryable` failure there must still earn exactly ONE lean retry
//      under the SAME key, the lean retry must not ask for a stream, and a failure that is not
//      retryable is shown in the server's own words and never resent.
//   9. ⚠️ THE STREAMED ANSWER DROPS (2026-09-25; by the press's key since 253). The route serves the
//      heartbeat's spaces and then the body breaks off mid-JSON (what the page's parser sees when a
//      connection dies mid-body), or the server's own deadline body (`stream_deadline`). The builder
//      must NOT be told to try again: the progress card says the draft is being picked up, and
//      calibrate_style_ai_recover is asked AT ONCE and then every poll interval, with THE PRESS'S OWN
//      idempotency key and no clock at all. The draft it hands back is applied exactly as an answer
//      would have been -- the success line, the key cleared (a row that kept no frame map skips the
//      check with a note; calSelfCheck.mjs runs the check on one that did). A server that says the
//      draft will never come is shown in its own words, and the key is kept. A `no_row` on a young
//      press is waited on, not shown. A drop noticed AFTER the press's budget (the page's clock moved
//      on eight minutes) still asks once and applies the draft it finds. The drop's own client log
//      row is draft_stream_dropped, an info row: the server's pickup rows carry the outcome.
//
// Stubbed at the NETWORK layer, like dev/verify-cal3d.mjs: no account, no login, no writes, and
// the artifacts under test are the compiled bundles the browser really loads. A change that was
// never `npm run compile`d is invisible here, which is the point.
//
//   python -m http.server 8125 --bind 127.0.0.1 --directory <repo root>
//   node tests/harness/calIdempotency.mjs            (SS_BASE=http://127.0.0.1:<port> to move it)
//
// Exit 0 = every assertion held.
import { launch, reporter, collectErrors, REF, BASE, PASS_THROUGH_GET } from "./lib.mjs";

const CLIENT = "pw-demo-barns";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A session in the exact shape supabase-js keeps in localStorage. Nothing verifies the JWT here —
// every call that would carry it is answered locally — but it has to PARSE, because the client
// decodes `exp` to decide whether to refresh mid-run.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(p)}.c3R1Yg`;
const EXP = 4102444800; // 2100-01-01
const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  access_token: jwt({ sub: USER_ID, role: "authenticated", email: "s@e.com", exp: EXP }),
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r",
  user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "s@e.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
};

// Two styles, each with a SAVED walk-around and no photos. Saved frames unlock Generate on
// reopen exactly as a fresh upload does, so the whole run needs no video file and no ffmpeg —
// and the second style is the only way to see a key carried across buildings.
const styleRow = (key, label) => ({
  id: key, key, label, code: key.slice(0, 3).toUpperCase(), image_url: null, active: true,
  updated_at: "2026-09-14T10:00:00.000+00:00", show_image_on_estimate: true, d3: null,
  d3_photos: [], d3_video_frames: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${BASE}/__stub/img-${key}${i}.png`),
  model_url: null, model_status: "none", model_uploaded_at: null, model_locked_at: null,
  model_meta: null, taxable: true,
});
const STYLES = [styleRow("barn", "Barn"), styleRow("shed", "Shed")];

const CONFIG = {
  branding: { companyName: "PW Demo Barns", accentColor: "#8B4513", headerBg: "#FFFFFF" },
  contactFields: [{ key: "name", label: "Name", required: true }],
  buildingStyles: [
    { value: "barn", label: "Barn", sizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }] },
    { value: "shed", label: "Shed", sizes: [{ label: "10x12", w: 10, h: 12, price: 3000 }] },
  ],
  defaultSizes: [{ label: "12x16", w: 12, h: 16, price: 5000 }],
  options: [],
  layoutItems: { door: { label: "Door", icon: "D", color: "#8B4513", width: 40, height: 12, shortLabel: "D" } },
  wallHeightFt: 7,
};

// Every calibrate_style_ai body the page sent, and the switch that decides what it gets back.
//   fail       a 503 with no `retryable`: the old timeout shape, which the builder retries
//   retryable  every call answers 502 { retryable: true }: cut off, hold released
//   retryOnce  the first call of a press is retryable, the lean one succeeds
//   streamed   a request that asks for `stream: true` is answered the way the server streams it:
//              200, spaces, then the JSON, a failure's status inside it (off: the answer an older
//              function gives, which never heard of the key)
//   refuse402  every call answers insufficient funds: a refusal, never retryable
//   drop       a streamed press's answer never arrives whole: "cut" serves spaces and then half the
//              JSON (the body broke off); "deadline" serves spaces and the server's stream_deadline
//   recover    what calibrate_style_ai_recover answers, one entry per ask (the last one repeats)
//   skewMs     moves the page's clock on this far just before a dropped body is served: a drop the
//              shell only notices after the press's budget
const generateCalls = [];
const recoverCalls = [];
const logRows = [];
const stub = { fail: false, retryable: false, retryOnce: false, streamed: false, refuse402: false, drop: null, recover: [], skewMs: 0 };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main() {
  const r = reporter();
  const { browser, ctx } = await launch({ width: 1500, height: 1100 });
  await ctx.addInitScript(([ref, s]) => {
    try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) {}
    // The pickup polls every ten seconds live; a third of a second here.
    window.__ssRecoverPollMs = 300;
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

    // The portal's own error log (01-core's ssLogError): kept, so the drop's row can be read.
    if (url.includes("/rest/v1/rpc/log_error")) { logRows.push(body); return json(route, null); }
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
      if (a === "calibrate_style_ai_recover") {
        recoverCalls.push({ at: Date.now(), body });
        const next = stub.recover.length > 1 ? stub.recover.shift() : (stub.recover[0] || { ok: true, pending: true });
        return json(route, next);
      }
      if (a === "calibrate_style_ai") {
        generateCalls.push({ ...body, __at: Date.now() });
        // THE ANSWER THAT NEVER ARRIVES WHOLE. "cut": the heartbeat's spaces and then the body breaks
        // off mid-JSON, which is what the page's parser is left holding when a connection dies
        // mid-body. "deadline": the server closed the answer itself (heartbeatJson's watchdog).
        if (stub.drop && body.stream === true) {
          if (stub.skewMs) {
            await page.evaluate((ms) => {
              if (!window.__ssRealNow) window.__ssRealNow = Date.now.bind(Date);
              window.__ssSkewMs = ms;
              Date.now = () => window.__ssRealNow() + (window.__ssSkewMs || 0);
            }, stub.skewMs);
          }
          const tail = stub.drop === "deadline"
            ? JSON.stringify({ error: "The draft is taking longer than this connection can wait. It is still being finished on our side.", code: "stream_deadline", status: 504 })
            : '{"ok":true,"d3":{"roof":{"type":"gamb';
          return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "          " + tail });
        }
        // THE SERVER'S STREAMED SHAPE (heartbeatJson.ts): a 200 whatever happened, a heartbeat, then
        // the object -- a failure's own object plus the status it would have had.
        const answer = (obj, status = 200) => (stub.streamed && body.stream === true)
          ? route.fulfill({
            status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
            body: "     " + JSON.stringify(status === 200 ? obj : { ...obj, status }),
          })
          : json(route, obj, status);
        if (stub.refuse402) {
          return answer({ error: "This 3D generation costs $20.00 and your wallet has $5.00. Add funds in Settings → Billing.", code: "insufficient_funds", priceCents: 2000, balanceCents: 500 }, 402);
        }
        // 503, not a dropped connection: this is the shape of the timeout path the key exists
        // for — the server answered, the hold was released, and the builder has every reason to
        // press again.
        if (stub.fail) return json(route, { error: "The model took too long - try again." }, 503);
        // THE SERVER'S OWN SHAPE for a reply it could not finish (contract §3): the hold is
        // released, the sentence is for a person, and `retryable` is for this panel.
        const cutOff = { error: "The AI ran out of room before finishing - please try again.", code: "ai_spec_truncated", retryable: true };
        if (stub.retryable) return answer(cutOff, 502);
        if (stub.retryOnce && !body.lean) return answer(cutOff, 502);
        // Slow enough that the progress card's "reading it again" line can be caught in flight.
        if (stub.retryOnce && body.lean) await new Promise((res) => setTimeout(res, 1500));
        return answer({
          ok: true,
          d3: { roof: { type: "gambrel", pitch: 0.5, overhang: 0.8 }, wallHeightFt: 7.5, siding: null, colors: { body: "#00ff00" } },
          frames: (body.photoUrls || []).length, dropped: 0,
          observed: { roofNote: "Gambrel, read from the ground.", confidence: "medium" },
          balanceCents: 18000,
        });
      }
      return json(route, { ok: true });
    }
    return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
  };
  await page.route(`**/${REF}.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.functions.supabase.co/**`, apiHandler);
  await page.route(`**/${REF}.storage.supabase.co/**`, apiHandler);
  // A real 1x1 PNG for every saved frame, so the thumbnail strip renders something and the
  // static server never 404s under it.
  await page.route("**/__stub/img-*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

  // CLICKED, not deep-linked: python -m http.server serves files, not the Workers routes, so
  // /portal/settings/designer 404s here even though it is a real URL live.
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading your business"), { timeout: 40000 });
  await page.getByText("Settings", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  // Two elements say "Designer": the workspace nav item and the Settings sub-page. The last in
  // document order is the sub-page; the first opens the designer tab and looks like breakage.
  await page.getByText("Designer", { exact: true }).last().click();
  await page.waitForFunction(() => document.body.innerText.includes("3D Style Calibration"), { timeout: 40000 });

  const gen = page.getByRole("button", { name: /Generate the 3D model/ });
  const genUnlocks = (ms = 20000) => page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
    return Boolean(b) && !b.disabled;
  }, null, { timeout: ms }).then(() => true, () => false);

  // Open a style and wait for ITS saved frames to be the ones on screen — by URL, not by count,
  // because both styles' laps are eight views long.
  //
  // THEN CONFIRM ALL THREE MEASUREMENTS, because since 2026-09-19 Generate is also gated on the
  // dimensions card (tests/harness/calDims.mjs is what tests that gate). Both styles here have
  // sizes of their own, so all three boxes arrive pre-filled — the width and length off the
  // price list, the wall height off the style's saved spec — and every pre-filled number has to
  // be looked at before the money button unlocks. Three clicks, and this harness is back to
  // measuring the one thing it is about: which key goes out with which press.
  const openStyle = async (label, key) => {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForFunction((want) => {
      const got = Array.from(document.querySelectorAll('img[alt^="View "]')).map((i) => i.getAttribute("src"));
      return got.length === want.length && got.every((u, i) => u === want[i]);
    }, STYLES.find((s) => s.key === key).d3_video_frames, { timeout: 20000 });
    for (const i of [0, 1, 2]) await page.locator("input.ssc-dim-in").nth(i).click();
    await page.waitForTimeout(150);
    return genUnlocks();
  };

  // One press, and the body it put on the wire. Waits for the CALL rather than for a message, so
  // a press that fails and a press that succeeds are measured the same way.
  const press = async (label) => {
    const n = generateCalls.length;
    await gen.first().click();
    for (let i = 0; i < 120 && generateCalls.length === n; i++) await page.waitForTimeout(100);
    // Let calGenerate's finally run, or the next press lands while adminCalBusy is still true
    // and is swallowed — which would read as "the key was reused" for the wrong reason.
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model/.test(x.textContent || ""));
      return Boolean(b) && !b.disabled;
    }, null, { timeout: 20000 }).catch(() => {});
    const body = generateCalls[n] || null;
    r.ok(`${label}: one press sent exactly one call`, generateCalls.length === n + 1, `${generateCalls.length - n} calls`);
    return body;
  };

  const barnUnlocked = await openStyle("Barn", "barn");
  r.ok("a style with a saved walk-around unlocks Generate", barnUnlocked);

  // ── 1 + 2: the first press, and the retry that proves it is one intent ───────────────────
  stub.fail = true;
  const a1 = await press("press 1 (fails)");
  r.ok("the press sends an idempotencyKey", Boolean(a1 && a1.idempotencyKey), a1 ? String(a1.idempotencyKey) : "no call");
  r.ok("and it is a UUID", UUID_RE.test((a1 && a1.idempotencyKey) || ""), (a1 && a1.idempotencyKey) || "-");
  // THE ROLLOUT GATE (2026-09-24): the new portal says its dims are in the FRONT-wall frame, which
  // is the only thing that earns the v2 prompt server-side. Production's older bundle never sends it.
  r.ok("⚠️ the draft request says frame \"front\" beside its dims (the v2 prompt's gate)",
    Boolean(a1) && a1.frame === "front" && Boolean(a1.dims), JSON.stringify(a1 && { frame: a1.frame, dims: a1.dims }));

  const a2 = await press("press 2 (retry, fails)");
  r.ok("A RETRY OF THAT PRESS REUSES ITS KEY", Boolean(a2) && a2.idempotencyKey === (a1 && a1.idempotencyKey),
    `${(a1 && a1.idempotencyKey) || "-"} then ${(a2 && a2.idempotencyKey) || "-"}`);

  // ── 3: the attempt that works is still the same charge ───────────────────────────────────
  stub.fail = false;
  const a3 = await press("press 3 (retry, succeeds)");
  r.ok("the retry that finally succeeds carries the SAME key", Boolean(a3) && a3.idempotencyKey === (a1 && a1.idempotencyKey),
    (a3 && a3.idempotencyKey) || "-");
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});

  // ── 4: a draft landed, so the next press is a different generation ───────────────────────
  const a4 = await press("press 4 (new generation)");
  r.ok("TWO PRESSES SEND TWO DIFFERENT KEYS", Boolean(a4) && UUID_RE.test(a4.idempotencyKey || "") && a4.idempotencyKey !== (a1 && a1.idempotencyKey),
    `${(a1 && a1.idempotencyKey) || "-"} then ${(a4 && a4.idempotencyKey) || "-"}`);

  // ── 5: a pending key never crosses to another building ───────────────────────────────────
  stub.fail = true;
  const a5 = await press("press 5 (barn, fails, key left pending)");
  r.ok("a fresh intent after a landed draft mints again", Boolean(a5) && a5.idempotencyKey !== (a4 && a4.idempotencyKey));
  const shedUnlocked = await openStyle("Shed", "shed");
  r.ok("the second style unlocks Generate too", shedUnlocked);
  const a6 = await press("press 6 (shed, fails)");
  r.ok("A PENDING KEY DOES NOT CROSS TO ANOTHER STYLE",
    Boolean(a6) && UUID_RE.test(a6.idempotencyKey || "") && a6.idempotencyKey !== (a5 && a5.idempotencyKey),
    `barn ${(a5 && a5.idempotencyKey) || "-"} vs shed ${(a6 && a6.idempotencyKey) || "-"}`);

  // ── 7: a `retryable` reply is resent once, lean, by itself ────────────────────────────
  // One press, and the calls it put on the wire -- waited out to the button coming back, so a
  // press that retried and one that did not are measured the same way. `saw` is whatever the
  // progress card said about reading it again while the press was running.
  const pressRetry = async (label, want) => {
    const n = generateCalls.length;
    await gen.first().click();
    let saw = "";
    for (let i = 0; i < 400; i++) {
      const st = await page.evaluate(() => {
        const card = document.querySelector('[data-ssc-card="progress"]');
        const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model|Working/.test(x.textContent || ""));
        return { card: card ? card.textContent : "", idle: Boolean(b) && !b.disabled && /Generate the 3D model/.test(b.textContent || "") };
      });
      if (/ran out of room before it finished/.test(st.card)) saw = st.card;
      if (st.idle && generateCalls.length > n) break;
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);
    const calls = generateCalls.slice(n);
    r.ok(`${label}: one press sent exactly ${want} call${want === 1 ? "" : "s"}`, calls.length === want, `${calls.length} calls`);
    return { calls, saw };
  };
  stub.fail = false; stub.retryOnce = true;
  const pending = a6 && a6.idempotencyKey;
  const t1 = await pressRetry("press 7 (cut off, then the lean retry lands)", 2);
  r.ok("⚠️ THE FIRST CALL WAS AN ORDINARY ONE", Boolean(t1.calls[0]) && !("lean" in t1.calls[0]), JSON.stringify(t1.calls[0] && { lean: t1.calls[0].lean }));
  r.ok("⚠️ AND THE AUTOMATIC SECOND ONE ASKED FOR A LEAN ANSWER", Boolean(t1.calls[1]) && t1.calls[1].lean === true, JSON.stringify(t1.calls[1] && { lean: t1.calls[1].lean }));
  // The press asks for the streamed draft; the lean retry, a short read on the old budget, does not.
  // (This stub answers plainly, as a function that never heard of the key would.)
  r.ok("the press asked for a stream, and the lean retry did not",
    t1.calls.length === 2 && t1.calls[0].stream === true && !("stream" in t1.calls[1]),
    JSON.stringify(t1.calls.map((c) => c.stream)));
  r.ok("⚠️ UNDER THE SAME KEY — one intent, one charge",
    t1.calls.length === 2 && t1.calls[0].idempotencyKey === t1.calls[1].idempotencyKey,
    t1.calls.map((c) => c.idempotencyKey).join(" then "));
  r.ok("and that key is the one this style's failed press left pending", Boolean(pending) && t1.calls[0] && t1.calls[0].idempotencyKey === pending, `${pending} vs ${t1.calls[0] && t1.calls[0].idempotencyKey}`);
  r.ok("the same views and the same measurements went both times",
    t1.calls.length === 2 && JSON.stringify(t1.calls[0].photoUrls) === JSON.stringify(t1.calls[1].photoUrls) && JSON.stringify(t1.calls[0].dims) === JSON.stringify(t1.calls[1].dims));
  r.ok("...and the lean retry still says frame \"front\"", t1.calls.length === 2 && t1.calls.every((c) => c.frame === "front"), t1.calls.map((c) => c.frame).join(","));
  r.ok("the progress card said it was reading again, and that it is one generation",
    /ran out of room before it finished/.test(t1.saw) && /still one generation/.test(t1.saw), t1.saw.slice(0, 120));
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  r.ok("⚠️ AND THE DRAFT LANDED, with no second press from the builder", /Read \d+ view/.test(await page.evaluate(() => document.body.innerText)));

  // A reply that is cut off TWICE: one automatic retry, never a third call, and the key stays
  // pending for the builder's own retry of the same intent.
  stub.retryOnce = false; stub.retryable = true;
  const t2 = await pressRetry("press 8 (cut off, and cut off again)", 2);
  r.ok("⚠️ NEVER A SECOND AUTOMATIC RETRY", t2.calls.length === 2 && !("lean" in t2.calls[0]) && t2.calls[1].lean === true,
    t2.calls.map((c) => String(c.lean)).join(", "));
  r.ok("a fresh intent after the landed draft minted its own key, used for both calls",
    t2.calls.length === 2 && UUID_RE.test(t2.calls[0].idempotencyKey || "") && t2.calls[0].idempotencyKey === t2.calls[1].idempotencyKey && t2.calls[0].idempotencyKey !== pending);
  const failText = await page.evaluate(() => document.body.innerText);
  r.ok("the builder is told in the server's own words", /ran out of room before finishing/.test(failText));
  const t3 = await pressRetry("press 9 (the builder's own retry)", 2);
  r.ok("⚠️ THE BUILDER'S OWN RETRY IS STILL THE SAME INTENT — same key",
    t3.calls.length === 2 && t2.calls[0] && t3.calls[0].idempotencyKey === t2.calls[0].idempotencyKey,
    `${t2.calls[0] && t2.calls[0].idempotencyKey} then ${t3.calls[0] && t3.calls[0].idempotencyKey}`);
  stub.retryable = false;

  // ── 8: the STREAMED answer ────────────────────────────────────────────────────────────────
  // Cut off, but in a 200's body: the failure arrives after a heartbeat, carrying status 502 and
  // retryable. The designer must not be able to tell it from the 502 above.
  stub.streamed = true; stub.retryOnce = true;
  const s1 = await pressRetry("press 10 (streamed: cut off in the body, then the lean retry lands)", 2);
  r.ok("⚠️ THE PRESS ASKED FOR THE STREAMED DRAFT", Boolean(s1.calls[0]) && s1.calls[0].stream === true && !("lean" in s1.calls[0]),
    JSON.stringify(s1.calls[0] && { stream: s1.calls[0].stream, lean: s1.calls[0].lean }));
  r.ok("⚠️ A RETRYABLE FAILURE IN A 200's BODY EARNED THE ONE LEAN RETRY, NOT STREAMED",
    Boolean(s1.calls[1]) && s1.calls[1].lean === true && !("stream" in s1.calls[1]),
    JSON.stringify(s1.calls[1] && { stream: s1.calls[1].stream, lean: s1.calls[1].lean }));
  r.ok("⚠️ UNDER THE SAME KEY — one intent, one charge",
    s1.calls.length === 2 && s1.calls[0].idempotencyKey === s1.calls[1].idempotencyKey && s1.calls[0].idempotencyKey === (t2.calls[0] && t2.calls[0].idempotencyKey),
    s1.calls.map((c) => c.idempotencyKey).join(" then "));
  r.ok("the progress card said it was reading again", /ran out of room before it finished/.test(s1.saw), s1.saw.slice(0, 120));
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  r.ok("⚠️ AND THE DRAFT LANDED, read out of the lean retry", /Read \d+ view/.test(await page.evaluate(() => document.body.innerText)));
  // A streamed refusal that is NOT retryable: one call, the server's own words, and the key kept
  // for the builder's own retry of the same intent.
  stub.retryOnce = false; stub.refuse402 = true;
  const s2 = await pressRetry("press 11 (streamed: insufficient funds in the body)", 1);
  r.ok("⚠️ A STREAMED REFUSAL IS NEVER RETRIED", s2.calls.length === 1 && s2.calls[0].stream === true, String(s2.calls.length));
  r.ok("and the builder reads the server's own sentence", /Add funds in Settings/.test(await page.evaluate(() => document.body.innerText)));
  const s3 = await pressRetry("press 12 (the builder's own retry of the refused press)", 1);
  r.ok("the builder's own retry of a refused press keeps its key",
    Boolean(s3.calls[0]) && Boolean(s2.calls[0]) && s3.calls[0].idempotencyKey === s2.calls[0].idempotencyKey && s3.calls[0].idempotencyKey !== s1.calls[0].idempotencyKey,
    `${s2.calls[0] && s2.calls[0].idempotencyKey} then ${s3.calls[0] && s3.calls[0].idempotencyKey}`);
  stub.refuse402 = false; stub.streamed = false;

  // ── 9: the streamed answer DROPS, and the draft is picked up from the server BY THE PRESS'S KEY ──
  // The draft a normal answer carries in this stub, and the same draft as the recover action hands
  // it back off the ledger row: `dropped` and `balanceCents` are not on the row, and this row kept no
  // frame map (one written before 253), so the check is skipped with its note. calSelfCheck.mjs
  // drives a recovered draft WITH a map through the whole check.
  const DRAFT_D3 = { roof: { type: "gambrel", pitch: 0.5, overhang: 0.8 }, wallHeightFt: 7.5, siding: null, colors: { body: "#00ff00" } };
  const recovered = (frames) => ({
    ok: true, d3: DRAFT_D3, frames, dropped: null,
    observed: { roofNote: "Gambrel, read from the ground.", confidence: "medium" },
    balanceCents: null, dims: null, frameMap: null, checkId: "11111111-2222-4333-8444-555555555555", recovered: true,
  });
  const NEVER = "We could not pick the draft up from the server: that generation did not finish, so you are not charged for it. Press Generate to try again.";
  const NO_ROW = { ok: true, pending: false, reason: "no_row", message: NEVER };
  const successLine = () => page.evaluate(() => (document.body.innerText.match(/Read \d+ view[^\n]*/) || [""])[0]);
  // A normal streamed press first, for the success line a recovered one must match.
  stub.streamed = true;
  await pressRetry("press 13 (streamed, answered whole)", 1);
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const normalLine = await successLine();
  r.ok("a whole streamed answer lands as it always has", /Read 8 views/.test(normalLine), normalLine.slice(0, 80));

  // One dropped press: the call it made, what the card said while it waited, what it asked.
  const pressDrop = async (label) => {
    const n = generateCalls.length;
    const p = recoverCalls.length;
    const logs = logRows.length;
    await gen.first().click();
    let saw = "";
    let sawTryAgain = false;
    for (let i = 0; i < 400; i++) {
      const st = await page.evaluate(() => {
        const card = document.querySelector('[data-ssc-card="progress"]');
        const b = Array.from(document.querySelectorAll("button")).find((x) => /Generate the 3D model|Working/.test(x.textContent || ""));
        return { card: card ? card.textContent : "", body: document.body.innerText, idle: Boolean(b) && !b.disabled && /Generate the 3D model/.test(b.textContent || "") };
      });
      if (/picking the draft up from the server/.test(st.card)) saw = st.card;
      if (/try again/i.test(st.card)) sawTryAgain = true;
      if (st.idle && generateCalls.length > n) break;
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);
    const calls = generateCalls.slice(n);
    r.ok(`${label}: one press sent exactly one generation call — no retry, no lean`, calls.length === 1 && !("lean" in calls[0]), `${calls.length} calls`);
    return { calls, saw, sawTryAgain, polls: recoverCalls.slice(p), logs: logRows.slice(logs) };
  };
  // Every ask names the style and THIS press's own key, and nothing else: no clock of any kind.
  const askedByKey = (d) => d.polls.length > 0 && d.polls.every((q) =>
    JSON.stringify(Object.keys(q.body).sort()) === JSON.stringify(["action", "idempotencyKey", "styleValue"])
      && q.body.idempotencyKey === d.calls[0].idempotencyKey && UUID_RE.test(q.body.idempotencyKey)
      && q.body.styleValue === d.calls[0].styleValue);
  const dropRowOf = (d) => d.logs.find((l) => l.p_context && l.p_context.action === "calibrate_style_ai");

  // 9a: the body breaks off mid-JSON; the server has the draft on the third ask.
  stub.drop = "cut";
  stub.recover = [{ ok: true, pending: true }, { ok: true, pending: true }, recovered(8)];
  const d1 = await pressDrop("press 14 (the body breaks off, the draft is picked up)");
  r.ok("⚠️ THE CARD SAID THE DRAFT IS BEING PICKED UP", /Your connection dropped — picking the draft up from the server/.test(d1.saw), d1.saw.slice(0, 160));
  r.ok("⚠️ AND NEVER TOLD THE BUILDER TO TRY AGAIN while it waited", !d1.sawTryAgain);
  r.ok("⚠️ THE RECOVER ACTION WAS ASKED until the draft came back, and not once more", d1.polls.length === 3, String(d1.polls.length));
  r.ok("⚠️ EVERY ASK NAMES THE PRESS'S OWN KEY and the style, and no clock (no since, no clientNow)", askedByKey(d1),
    JSON.stringify(d1.polls[0] && d1.polls[0].body));
  r.ok("⚠️ THE FIRST ASK WENT AT ONCE, not a poll interval after the drop",
    d1.polls.length > 0 && d1.polls[0].at - d1.calls[0].__at < 250, d1.polls[0] ? `${d1.polls[0].at - d1.calls[0].__at} ms` : "no ask");
  r.ok("and the rest ten seconds apart live (a third of a second here), not in a burst",
    d1.polls.length === 3 && d1.polls[1].at - d1.polls[0].at >= 250 && d1.polls[2].at - d1.polls[1].at >= 250,
    d1.polls.map((p) => p.at - d1.polls[0].at).join(", "));
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const recoveredLine = await successLine();
  r.ok("⚠️ THE RECOVERED DRAFT IS APPLIED EXACTLY AS AN ANSWER: the same success line", recoveredLine === normalLine && recoveredLine.length > 0, recoveredLine.slice(0, 80));
  const afterText = await page.evaluate(() => document.body.innerText);
  r.ok("a row that kept no frame map: the check says why it did not run",
    /picked the draft up from the server/.test(afterText) && /did not run this time/.test(afterText));
  r.ok("no error on screen", !/connection dropped before|could not pick the draft up/i.test(afterText.replace(/Your connection dropped while we were drafting[^\n]*/, "")));
  const dropRow = dropRowOf(d1);
  r.ok("⚠️ THE DROP'S CLIENT LOG ROW: draft_stream_dropped, INFO (the page was staying; the server's pickup rows carry the outcome)",
    Boolean(dropRow) && dropRow.p_code === "draft_stream_dropped" && dropRow.p_severity === "info" && dropRow.p_context.status === null,
    JSON.stringify(dropRow && { code: dropRow.p_code, severity: dropRow.p_severity, status: dropRow.p_context.status }));
  r.ok("and the asks filed nothing", !d1.logs.some((l) => l.p_context && l.p_context.action === "calibrate_style_ai_recover"),
    d1.logs.map((l) => l.p_code).join(","));
  // The key: a recovered draft is a landed draft, so the next press is a new generation.
  stub.drop = null;
  const n1 = await pressRetry("press 15 (after a recovered draft)", 1);
  r.ok("⚠️ A RECOVERED DRAFT CLEARS THE KEY, as an answer does: the next press mints its own",
    Boolean(n1.calls[0]) && UUID_RE.test(n1.calls[0].idempotencyKey || "") && n1.calls[0].idempotencyKey !== d1.calls[0].idempotencyKey,
    `${d1.calls[0] && d1.calls[0].idempotencyKey} then ${n1.calls[0] && n1.calls[0].idempotencyKey}`);

  // 9b: the server's own deadline, and then it says the draft will never come.
  stub.drop = "deadline";
  stub.recover = [{ ok: true, pending: true }, { ok: true, pending: false, reason: "failed", message: NEVER }];
  const d2 = await pressDrop("press 16 (stream_deadline, and the draft never comes)");
  r.ok("the deadline is picked up the same way: the card, then the asks by key",
    /picking the draft up from the server/.test(d2.saw) && d2.polls.length === 2 && askedByKey(d2), `${d2.polls.length} asks`);
  const neverText = await page.evaluate(() => document.body.innerText);
  r.ok("⚠️ THE SERVER'S OWN SENTENCE, once it says the draft will never come", neverText.includes(NEVER));
  const deadlineRow = dropRowOf(d2);
  r.ok("the deadline's client log row is draft_stream_dropped too, info, carrying the 504 it would have had",
    Boolean(deadlineRow) && deadlineRow.p_code === "draft_stream_dropped" && deadlineRow.p_context.status === 504 && deadlineRow.p_severity === "info",
    JSON.stringify(deadlineRow && { code: deadlineRow.p_code, severity: deadlineRow.p_severity, status: deadlineRow.p_context.status }));
  stub.drop = null; stub.recover = [];
  const n2 = await pressRetry("press 17 (the builder's own press after a draft that never came)", 1);
  r.ok("⚠️ AND THE KEY IS KEPT for the builder's own press of the same intent",
    Boolean(n2.calls[0]) && n2.calls[0].idempotencyKey === d2.calls[0].idempotencyKey,
    `${d2.calls[0] && d2.calls[0].idempotencyKey} then ${n2.calls[0] && n2.calls[0].idempotencyKey}`);

  // 9c: the press's own row is not there yet (no_row) -- a young press keeps asking, and gets it.
  stub.drop = "cut";
  stub.recover = [NO_ROW, NO_ROW, recovered(8)];
  const d3 = await pressDrop("press 18 (no_row twice, then the row lands)");
  r.ok("⚠️ A no_row ON A YOUNG PRESS IS WAITED ON, not shown: the draft arrives on the third ask",
    d3.polls.length === 3 && askedByKey(d3), `${d3.polls.length} asks`);
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  r.ok("and it is applied with the same success line", (await successLine()) === normalLine);
  r.ok("and no lost-draft sentence on screen", !(await page.evaluate(() => document.body.innerText)).includes(NEVER));

  // 9d: ⚠️ A PHONE THAT SLEPT THROUGH THE WHOLE PRESS. The drop surfaces after the press's seven
  // minutes: the page's clock is moved eight minutes on just before the broken body is served, so
  // `until` is long past when the shell sees the drop. It must still ask ONCE, and apply the draft.
  stub.drop = "cut";
  stub.skewMs = 8 * 60 * 1000;
  stub.recover = [recovered(8)];
  const d4 = await pressDrop("press 19 (the drop is noticed after the press's budget)");
  await page.evaluate(() => { window.__ssSkewMs = 0; });
  stub.skewMs = 0;
  r.ok("⚠️ A DROP NOTICED AFTER THE BUDGET STILL ASKS — exactly once, by the press's key",
    d4.polls.length === 1 && askedByKey(d4), `${d4.polls.length} asks`);
  await page.waitForFunction(() => /Read \d+ view/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  r.ok("⚠️ AND THE PAID DRAFT IT FOUND IS APPLIED, with the same success line", (await successLine()) === normalLine, (await successLine()).slice(0, 80));
  r.ok("no timeout sentence for a draft that was there", !/did not reach us in time/.test(await page.evaluate(() => document.body.innerText)));
  stub.drop = null; stub.recover = [];

  r.ok("a press that is not dropped never asks",
    recoverCalls.length === d1.polls.length + d2.polls.length + d3.polls.length + d4.polls.length, String(recoverCalls.length));
  stub.streamed = false;

  // ── 6: nothing slipped through without one ───────────────────────────────────────────────
  const missing = generateCalls.filter((c) => !c.idempotencyKey).length;
  r.ok("every generation on the wire carried a key", missing === 0, `${missing} of ${generateCalls.length} without`);
  r.ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = r.failed();
  console.log(`\n${r.results.length - failed.length}/${r.results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
