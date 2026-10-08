// The Pipeline tab's DEFAULT VIEW follows the CRM (Carolyn Q12, 2026-10-06), driven for real on
// the COMPILED portal.
//
// Someone who never picked a view in My Profile opens the Pipeline tab on the board when the
// business has the built-in CRM, and on the list when it does not. A saved choice still wins, and
// a URL that names a view outranks both. On your own portal the CRM answer (portal-billing) can
// land after the designs do, so the table waits on its loading blocks with neither toggle lit
// rather than painting the list and snapping to the board; a failed billing call must end the
// wait on the list, never hang it.
//
//   A. CRM, nothing saved: the board, with Pipeline pressed.
//   B. No CRM: the list, and the Pipeline button keeps its padlock and its title.
//   C. CRM, "list" saved in My Profile: the list.
//   D. CRM, nothing saved, /portal/designs/list: the list (the URL wins).
//   E. CRM, the entitlement held ~1.5 s while the designs arrive first: a MutationObserver
//      watching from the first render records that the LIST WAS NEVER DRAWN before the board,
//      and that no toggle was lit (and the Pipeline one wore no padlock) while the answer was out.
//   F. The entitlement call fails: the list appears (no hang).
//   I. The entitlement call never answers at all: the wait still ends, on the list, within a few
//      seconds (the shell stops waiting on a timer; the call itself has no timeout).
//   G. An operator viewing a builder without the CRM: the list, padlocked.
//   H. My Profile says which default applies: the board with the CRM; the list and a padlocked,
//      explaining "Pipeline board" button without it.
//   J. My Profile while the CRM answer is still out (held ~3 s): no padlock, nothing refused, no
//      "without the built-in CRM" line, just "Checking your plan…"; then the board default.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/pipelineDefaultView.mjs      (exit 0 = every check held)
//
// Supabase is stubbed at the network layer (no login, nothing leaves the machine). Fixtures are
// made up (example.test, a made-up tenant), per the public-repo rule. SS_PORTAL_ARTIFACT=<an older
// portal.app.compiled.js> serves that file instead: before this change A, E and H fail (the
// default was always the list, and My Profile knew nothing about the CRM).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF, shotsDir, collectErrors } from "./lib.mjs";

const OWN = "acme-sheds";
const OTHER = "harness-builder";
const OPS = "harness-ops";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000011", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const row = (code, name, status) => ({
  short_code: code, created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z", status,
  contact: { name, email: `${name.split(" ")[0].toLowerCase()}@example.test` }, contact_id: null,
  sel_style: "Utility", sel_size: "10x12", ghl_estimate_number: null, inventory_unit_id: null, image_url: null,
  ss_quote_number: status === "draft" ? null : `AS-${code.slice(-4)}`, ss_quote_pdf_url: null, ss_invoice_sent_at: null,
  total_cents: 900000, expected_close_date: null,
});
const ROWS = [row("SS-PIPEAAA001", "Avery Stone", "sent"), row("SS-PIPEBBB002", "Blake Rivers", "accepted"), row("SS-PIPECCC003", "Casey Dale", "draft")];
const ent = (crm) => ({ granted: [], paid: [], features: crm ? { crm: true } : {}, status: "active", locked: false });

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const { ok, failed } = reporter();
const shots = shotsDir("pipeline-default-view");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;
const { browser, ctx: unused } = await launch({ width: 1400, height: 1000 });
await unused.close();

/**
 * S: { crm, saved, billingDelayMs, billingFail, operator, viewedCrm }. Opens `path`, returns the
 * page plus a timeline: every [data-ss-designs-view] value as it first appeared, the toggle state
 * seen while the table was still loading, and when the designs and the entitlement were answered.
 */
async function open(S, path) {
  const t0 = Date.now();
  const served = { designs: null, billing: null };
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // From the very first render: every view the table drew, in order, and whether a toggle was
    // lit while it was still on its loading blocks.
    window.__views = [];
    window.__litWhileLoading = [];
    const scan = () => {
      const v = document.querySelector("[data-ss-designs-view]");
      const val = v ? v.getAttribute("data-ss-designs-view") : null;
      if (val && window.__views[window.__views.length - 1] !== val) window.__views.push(val);
      if (val === "loading") {
        const lit = [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim()).filter((t) => /List|Pipeline/.test(t));
        if (lit.length) window.__litWhileLoading.push(lit.join(","));
      }
    };
    const attach = () => {
      if (!document.documentElement) { setTimeout(attach, 5); return; }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    };
    attach();
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const own = S.operator ? OPS : OWN;
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "log_error") return json(route, null);
      if (rpc[1] === "is_operator") return json(route, !!S.operator);
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: own, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) { served.designs = served.designs ?? Date.now() - t0; return json(route, ROWS); }
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      const viewed = !!body.targetClientId;
      if (!viewed && S.billingHang) await new Promise(() => {});   // never answers (I)
      if (!viewed && S.billingDelayMs) await new Promise((r) => setTimeout(r, S.billingDelayMs));
      if (!viewed) served.billing = Date.now() - t0;
      if (!viewed && S.billingFail) return json(route, { error: "billing is down" }, 500);
      return json(route, { ok: true, configured: true, hasCard: false, plans: [], subscriptions: [], wallet: null, entitlement: ent(viewed ? S.viewedCrm : S.crm) });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        const cid = body.targetClientId || own;
        return json(route, { ok: true, clientId: cid, role: "owner", operatorMode: false, access: null,
          prefs: body.targetClientId ? null : (S.saved ? { designsView: S.saved } : null),
          phoneStatus: "off", configured: false, invoiceInGhl: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      }
      if (body.action === "get_profile") return json(route, { ok: true, fullName: "Pat Owner", phone: null, needsDetails: false });
      return json(route, { ok: true });
    }
    if (url.includes("/operator-portal")) {
      if (body.action === "get_portal") return json(route, { ok: true, clientId: body.clientId, companyName: "Harness Builder", designs: ROWS, versions: [], capturedLeads: [] });
      return json(route, { ok: true, clients: [{ clientId: OTHER, companyName: "Harness Builder" }] });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const booted = await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 })
    .then(() => true, () => false);
  if (!booted) {
    const seen = await page.evaluate(() => `${location.pathname}: ${document.body.innerText.slice(0, 300)}`).catch(() => "");
    throw new Error(`the portal never booted on ${path}; refusing to report the rest as passes. ${seen} ${errors.join(" | ")}`);
  }
  return { ctx, page, errors, served, t0 };
}
// Waits for the table to settle on a view other than "loading" (or times out), then reads it.
async function settled(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const v = document.querySelector("[data-ss-designs-view]");
    return v && v.getAttribute("data-ss-designs-view") !== "loading";
  }, null, { timeout }).catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const v = document.querySelector("[data-ss-designs-view]");
    const btn = (name) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().replace(/^🔒\s*/, "") === name && b.hasAttribute("aria-pressed"));
    const pipe = btn("Pipeline");
    return {
      view: v ? v.getAttribute("data-ss-designs-view") : null,
      listPressed: btn("List") ? btn("List").getAttribute("aria-pressed") : null,
      pipePressed: pipe ? pipe.getAttribute("aria-pressed") : null,
      pipeText: pipe ? pipe.textContent.trim() : null,
      pipeTitle: pipe ? pipe.getAttribute("title") : null,
      views: window.__views.slice(),
      litWhileLoading: window.__litWhileLoading.slice(),
      path: location.pathname,
    };
  });
}

try {
  // ── A ──
  {
    const { ctx, page, errors } = await open({ crm: true }, "/portal/designs");
    const r = await settled(page);
    ok("A1 CRM, nothing saved: the Pipeline tab opens on the board", r.view === "pipeline", JSON.stringify(r));
    ok("A2 with Pipeline pressed and List not", r.pipePressed === "true" && r.listPressed === "false", `${r.pipePressed}/${r.listPressed}`);
    ok("A3 the list was never drawn first", !r.views.includes("list"), r.views.join(" → "));
    ok("A4 no page errors", errors.length === 0, errors.join(" | "));
    await page.screenshot({ path: join(shots, "A-crm-default-board.png") });
    await ctx.close();
  }
  // ── B ──
  {
    const { ctx, page, errors } = await open({ crm: false }, "/portal/designs");
    const r = await settled(page);
    ok("B1 no CRM: the Pipeline tab opens on the list", r.view === "list" && r.listPressed === "true", JSON.stringify(r));
    ok("B2 the Pipeline button keeps its padlock and says why", r.pipeText === "🔒 Pipeline" && r.pipeTitle === "The pipeline board is part of the built-in CRM", `${r.pipeText} / ${r.pipeTitle}`);
    ok("B3 the board was never drawn", !r.views.includes("pipeline"), r.views.join(" → "));
    ok("B4 no page errors", errors.length === 0, errors.join(" | "));
    await page.screenshot({ path: join(shots, "B-no-crm-default-list.png") });
    await ctx.close();
  }
  // ── C ──
  {
    const { ctx, page } = await open({ crm: true, saved: "list" }, "/portal/designs");
    const r = await settled(page);
    ok("C1 CRM, \"list\" saved in My Profile: the list (a saved choice is kept)", r.view === "list" && r.listPressed === "true", JSON.stringify(r));
    ok("C2 and the board was never drawn", !r.views.includes("pipeline"), r.views.join(" → "));
    await ctx.close();
  }
  // ── D ──
  {
    const { ctx, page } = await open({ crm: true }, "/portal/designs/list");
    const r = await settled(page);
    ok("D1 /portal/designs/list opens the list even with the CRM and nothing saved", r.view === "list" && r.path === "/portal/designs/list", JSON.stringify(r));
    await ctx.close();
  }
  // ── E ──
  {
    const { ctx, page, served } = await open({ crm: true, billingDelayMs: 1500 }, "/portal/designs");
    // While the entitlement is out, with the designs already here: the loading blocks, no toggle lit.
    await page.waitForFunction(() => document.querySelector('[data-ss-designs-view="loading"]'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const mid = await page.evaluate(() => ({
      view: (document.querySelector("[data-ss-designs-view]") || {}).getAttribute?.("data-ss-designs-view") ?? null,
      lit: [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim()).filter((t) => /List|Pipeline/.test(t)),
      pipe: ([...document.querySelectorAll("button[aria-pressed]")].find((b) => /^(🔒s*)?Pipeline$/.test(b.textContent.trim())) || {}).textContent ?? null,
    }));
    const r = await settled(page);
    ok("E1 the designs were answered before the entitlement", served.designs != null && served.billing != null && served.designs + 800 < served.billing, `designs ${served.designs} ms, billing ${served.billing} ms`);
    ok("E2 while the CRM answer was out the table showed its loading blocks, no toggle lit", mid.view === "loading" && mid.lit.length === 0, JSON.stringify(mid));
    ok("E3 then the board", r.view === "pipeline", JSON.stringify(r));
    ok("E4 the MutationObserver never saw the list drawn before the board", !r.views.includes("list") && r.views[r.views.length - 1] === "pipeline", r.views.join(" → "));
    ok("E5 and never saw a toggle lit while loading", r.litWhileLoading.length === 0, r.litWhileLoading.join(" | "));
    ok("E6 while the CRM answer was out the Pipeline toggle wore no padlock (it is not known to be locked)", mid.pipe === "Pipeline", JSON.stringify(mid));
    await ctx.close();
  }
  // ── F ──
  {
    const { ctx, page, errors } = await open({ crm: true, billingFail: true }, "/portal/designs");
    const r = await settled(page, 10000);
    ok("F1 a failed entitlement call ends the wait on the list (no hang)", r.view === "list" && r.listPressed === "true", JSON.stringify(r));
    ok("F2 no page errors", errors.filter((e) => !/500|Failed to load/.test(e)).length === 0, errors.join(" | "));
    await ctx.close();
  }
  // ── I ──
  {
    const { ctx, page, errors, t0 } = await open({ crm: true, billingHang: true }, "/portal/designs");
    const r = await settled(page, 12000);
    const took = Date.now() - t0;
    ok("I1 an entitlement call that never answers still ends the wait, on the list", r.view === "list" && r.listPressed === "true", JSON.stringify(r));
    ok("I2 within a few seconds, not for as long as the call hangs", took < 12000, `${took} ms`);
    ok("I3 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // ── G ──
  {
    const { ctx, page } = await open({ crm: true, operator: true, viewedCrm: false }, `/portal/designs?view=${OTHER}`);
    await page.waitForFunction(() => document.body.innerText.includes("Avery Stone"), null, { timeout: 20000 }).catch(() => {});
    const r = await settled(page);
    ok("G1 an operator viewing a builder without the CRM sees the list", r.view === "list", JSON.stringify(r));
    ok("G2 with the padlocked Pipeline button", r.pipeText === "🔒 Pipeline", r.pipeText);
    await ctx.close();
  }
  // ── H ──
  for (const crm of [true, false]) {
    const { ctx, page, errors } = await open({ crm }, "/portal/settings/myprofile");
    await page.waitForFunction(() => document.body.innerText.includes("How the Pipeline tab opens"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector("[data-ss-view-default]"), null, { timeout: 5000 }).catch(() => {});
    // The CRM answer lands a moment after the card on your own portal; let it.
    await page.waitForTimeout(1200);
    const card = page.locator("[data-ss-view-default]").locator("xpath=..");   // the card the note sits in
    const read = () => page.evaluate(() => {
      const note = document.querySelector("[data-ss-view-default]");
      const b = (n) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim().replace(/^🔒\s*/, "") === n);
      const pipe = b("Pipeline board"), list = b("List");
      return { note: note ? note.textContent.trim() : null, pipe: pipe ? pipe.textContent.trim() : null, pipeTitle: pipe ? pipe.getAttribute("title") : null,
        pipePressed: pipe ? pipe.getAttribute("aria-pressed") : null, listPressed: list ? list.getAttribute("aria-pressed") : null };
    });
    const h = await read();
    if (crm) {
      ok("H1 with the CRM and nothing saved, My Profile says the board applies", /pipeline board, the default with the built-in CRM/.test(h.note || "") && h.pipePressed === "true", JSON.stringify(h));
      await card.screenshot({ path: join(shots, "H-myprofile-crm.png") }).catch(() => {});
    } else {
      ok("H2 without the CRM it says the list applies", /opens on the list, the default without the built-in CRM/.test(h.note || "") && h.listPressed === "true", JSON.stringify(h));
      ok("H3 the board button keeps a padlock and the toggle's own title", h.pipe === "🔒 Pipeline board" && h.pipeTitle === "The pipeline board is part of the built-in CRM", JSON.stringify(h));
      const saves = [];
      page.on("request", (q) => { if (/portal-settings/.test(q.url()) && /save_prefs/.test(q.postData() || "")) saves.push(q.postData()); });
      await page.getByRole("button", { name: "🔒 Pipeline board" }).click();
      await page.waitForTimeout(600);
      const said = await page.evaluate(() => document.body.innerText.includes("The pipeline board is part of the built-in CRM, so the Pipeline tab opens on the list."));
      ok("H4 pressing it explains itself and saves nothing (never a silent disabled button)", said && saves.length === 0, `said ${said}, saves ${saves.length}`);
      await card.screenshot({ path: join(shots, "H-myprofile-no-crm.png") }).catch(() => {});
    }
    ok(`H${crm ? 5 : 6} no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // ── J ──
  {
    const { ctx, page, errors, served } = await open({ crm: true, billingDelayMs: 3000 }, "/portal/settings/myprofile");
    await page.waitForFunction(() => document.querySelector("[data-ss-view-default]"), null, { timeout: 20000 }).catch(() => {});
    const read = () => page.evaluate(() => {
      const note = document.querySelector("[data-ss-view-default]");
      const b = (n) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim().replace(/^🔒s*/, "") === n);
      const pipe = b("Pipeline board"), list = b("List");
      return { note: note ? note.textContent.trim() : null, pipe: pipe ? pipe.textContent.trim() : null, pipeTitle: pipe ? pipe.getAttribute("title") : null,
        pipePressed: pipe ? pipe.getAttribute("aria-pressed") : null, listPressed: list ? list.getAttribute("aria-pressed") : null,
        refused: document.body.innerText.includes("The pipeline board is part of the built-in CRM, so the Pipeline tab opens on the list.") };
    });
    const early = await read();
    const answered = served.billing;
    ok("J1 the card was read while the CRM answer was still out", early.note != null && answered == null, `${JSON.stringify(early)} billing ${answered}`);
    ok("J2 meanwhile it says it is checking, and nothing about the board being locked", early.note === "Checking your plan…" && !/built-in CRM/.test(early.note || ""), JSON.stringify(early));
    ok("J3 the board button wears no padlock and no title, and neither button is lit", early.pipe === "Pipeline board" && !early.pipeTitle && early.pipePressed === "false" && early.listPressed === "false", JSON.stringify(early));
    await page.waitForFunction(() => /the default with the built-in CRM/.test((document.querySelector("[data-ss-view-default]") || {}).textContent || ""), null, { timeout: 10000 }).catch(() => {});
    const late = await read();
    ok("J4 once the answer is in, the board default applies", /pipeline board, the default with the built-in CRM/.test(late.note || "") && late.pipePressed === "true" && !late.refused, JSON.stringify(late));
    ok("J5 no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const f = failed();
console.log(`\n${f.length ? "FAILED" : "OK"} — ${f.length} failed; shots in ${shots}`);
process.exit(f.length ? 1 : 0);
