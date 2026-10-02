// The Commissions tab's MONEY GUARD, driven for real on the COMPILED portal (2026-10-02).
//
// Since 2026-10-02 the tab paints the ledger BESIDE compute instead of before it, and compute
// returns the post-compute ledger itself (withEntries), so an open is two calls side by side
// instead of three in a row. That is only safe while one rule holds — read the long note above
// `load` in portal/08-integrations.jsx (CommissionsReport) first:
//
//   Every control that COMMITS to a figure (Approve period, Mark paid, Split, Adjust…) stays
//   disabled until a ledger read that STARTED AFTER compute's writes is on screen. A paint must
//   never clear it, and an older read may never repaint over the reconciled ledger.
//
// The stubs answer list_entries with the PRE-compute ledger ($1.00 on one pending line) and
// compute with the POST-compute ledger ($2.00), with delays chosen per scenario, and the page
// samples its own DOM every 25 ms. The checks are "never", not "not at the end":
//   A  normal owner open: two calls, started together; never armed on $1.00; ends armed on $2.00
//   B  the paint arrives LATE (after compute's ledger): it must not repaint $1.00 over $2.00
//   C  compute fails: today's fallback — a list_entries that starts after compute — settles it
//   D  an older server ignores withEntries (no ledger in the answer): same fallback
//   E  a rep (no rate access): compute answers with the ledger and NO 403, so no refusal row
//   F  a cached revisit where compute AND the fallback fail: cached figures are never armed;
//      the tab falls back to the empty scaffold, as a failed first read always did
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/commissionsReconcile.mjs
//
// SS_PORTAL_ARTIFACT=<an older portal.app.compiled.js> serves that file instead, which is how to
// watch the old three-calls-in-a-row behaviour fail A's "two calls" check.
//
// ⚠️ NOTHING LEAVES THE MACHINE: every Supabase host is answered here, every other request is aborted.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, reporter, BASE, REF } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTAL_HTML = readFileSync(join(ROOT, "portal.html"), "utf8");
const ARTIFACT = process.env.SS_PORTAL_ARTIFACT ? readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8") : null;

const CLIENT = "harness-builder";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-0000000000c1", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};

const entry = (amountCents) => ({
  id: "e1", orderId: "o1", orderNo: 1001, customer: "Harness Customer", building: "Lofted Barn 12x24",
  earnerUserId: USER.id, earnerName: "Owner", baseCents: 10000, ratePercent: 1, amountCents,
  earnedOn: "2026-09-20", periodKey: "2026-09-15", periodLabel: "Sep 15 – Sep 28", status: "pending",
  kind: "commission", isOverride: false, splitShare: null,
});
const ledger = (amountCents, owner = true) => ({
  ok: true, isOwner: owner, seesAll: owner, canSeeRates: owner, enabled: true,
  entries: [entry(amountCents)], team: owner ? [{ userId: USER.id, name: "Owner", email: USER.email }] : undefined,
});
const PRE = 100, POST = 200;   // $1.00 before compute, $2.00 after

const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { ok, failed, results } = reporter();
const { browser } = await launch({ width: 1400, height: 1000 });

// S: { owner, listDelay, computeDelay, compute: "ledger" | "fail" | "old", revisit?: {...same keys} }
async function run(label, S) {
  const calls = [];   // { action, withEntries, at, phase }
  const logged = [];  // log_error rpc bodies
  let phase = "first";
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
    // Sample what a person could act on, from the first render on.
    window.__samples = [];
    setInterval(() => {
      const body = document.body ? document.body.innerText : "";
      const approve = [...document.querySelectorAll("button")].find((b) => /Approve period/.test(b.textContent || ""));
      window.__samples.push({
        at: Date.now(),
        pre: body.includes("$1.00"), post: body.includes("$2.00"),
        armed: !!(approve && !approve.disabled),
        banner: body.includes("Checking for new orders"),
        // The empty scaffold's text depends on the scope it no longer knows: either line counts.
        empty: /No commissions yet|You have no commissions/.test(body),
        errShown: body.includes("stubbed"),
        path: location.pathname,
      });
    }, 25);
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc) {
      if (rpc[1] === "log_error") { logged.push(body); return json(route, null); }
      return json(route, false);
    }
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: S.owner ? "owner" : "user" }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (/[?&]warm=1/.test(url)) return json(route, { ok: true });
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: true, plans: [], subscriptions: [], entitlement: { granted: [], features: {}, status: "active" }, wallet: null });
    }
    if (url.includes("/portal-settings")) {
      if (body.action === "status") {
        return json(route, { ok: true, clientId: CLIENT, role: S.owner ? "owner" : "user", access: S.owner ? null : { commissions: "view" }, prefs: null, configured: true, branding: {} });
      }
      return json(route, { ok: true });
    }
    if (url.includes("/portal-commissions")) {
      const cfg = phase === "revisit" && S.revisit ? S.revisit : S;
      calls.push({ action: body.action, withEntries: body.withEntries === true, at: Date.now() - t0, phase });
      if (body.action === "list_entries") {
        await wait(cfg.listDelay ?? 200);
        if (cfg.listFails) return json(route, { error: "stubbed list failure" }, 500);
        // The paint sees the PRE-compute ledger until compute has run once in this phase; the
        // fallback read (after a compute) sees the POST-compute one.
        const computedThisPhase = calls.some((c) => c.phase === phase && c.action === "compute");
        const afterCompute = computedThisPhase && calls.filter((c) => c.phase === phase && c.action === "list_entries").length > 1;
        return json(route, ledger(afterCompute || cfg.listIsPost ? POST : PRE, S.owner));
      }
      if (body.action === "compute") {
        await wait(cfg.computeDelay ?? 600);
        if (cfg.compute === "fail") return json(route, { error: "stubbed compute failure" }, 500);
        if (!S.owner) {
          // The server's no-rate answer: the ledger, and no 403 (when the caller asked withEntries).
          return body.withEntries ? json(route, { ok: true, skipped: "no_rate_access", ledger: ledger(POST, false) })
            : json(route, { error: "Only the owner or a full-access admin can run commissions." }, 403);
        }
        const base = { ok: true, orders: 1, computed: 0, updated: 1, removed: 0 };
        if (cfg.compute === "old" || !body.withEntries) return json(route, base);
        return json(route, { ...base, ledger: ledger(POST, true) });
      }
      return json(route, { ok: true });
    }
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.route(/\/portal\/[a-z]/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PORTAL_HTML }));
  if (ARTIFACT) await page.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: ARTIFACT }));

  await page.goto(`${BASE}/portal/commissions`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(S.settleMs ?? 4500);
  let firstEnd = Date.now();
  if (S.revisit) {
    // Leave and come back within the tab cache's ten minutes: the second open starts from the
    // cached ledger (no paint leg) and must still reconcile before anything is armed.
    await page.click('a[href="/portal/designs"]');
    await page.waitForTimeout(800);
    phase = "revisit";
    firstEnd = Date.now();
    await page.click('a[href="/portal/commissions"]');
    await page.waitForTimeout(S.revisit.settleMs ?? 4500);
  }
  const samples = await page.evaluate(() => window.__samples);
  await ctx.close();
  return { label, calls, logged, pageErrors, samples, firstEnd };
}

const onTab = (s) => s.path === "/portal/commissions";
const never = (r, pred, since = 0) => r.samples.filter((s) => s.at >= since && onTab(s)).filter(pred);
const last = (r) => [...r.samples].reverse().find(onTab) || {};
const callsOf = (r, phase = "first") => r.calls.filter((c) => c.phase === phase);

try {
  // ── A: the normal owner open ──
  const A = await run("A", { owner: true, listDelay: 250, computeDelay: 1200, compute: "ledger" });
  const a = callsOf(A);
  ok("A: exactly two calls — the paint and compute(withEntries) — no third read", a.length === 2 && a.some((c) => c.action === "list_entries") && a.some((c) => c.action === "compute" && c.withEntries),
    JSON.stringify(a.map((c) => `${c.action}${c.withEntries ? "+entries" : ""}@${c.at}`)));
  ok("A: they start together, not one after the other", a.length === 2 && Math.abs(a[0].at - a[1].at) < 150, JSON.stringify(a.map((c) => c.at)));
  ok("A: the pre-compute $1.00 is painted while compute runs (with the banner up)", never(A, (s) => s.pre && s.banner).length > 0);
  ok("A: NEVER armed while the pre-compute figure is on screen", never(A, (s) => s.armed && s.pre).length === 0, JSON.stringify(never(A, (s) => s.armed && s.pre)[0] || null));
  ok("A: NEVER armed while the banner is up", never(A, (s) => s.armed && s.banner).length === 0);
  ok("A: ends on the reconciled $2.00, armed, banner gone", last(A).post && !last(A).pre && last(A).armed && !last(A).banner, JSON.stringify(last(A)));
  ok("A: no uncaught page errors", A.pageErrors.length === 0, A.pageErrors.join(" | "));

  // ── B: the paint is slower than compute ──
  const B = await run("B", { owner: true, listDelay: 2600, computeDelay: 500, compute: "ledger", settleMs: 5000 });
  const postSeenAt = (B.samples.find((s) => onTab(s) && s.post) || {}).at;
  ok("B: the reconciled $2.00 lands first", !!postSeenAt);
  ok("B: the late paint never puts $1.00 back after $2.00 landed", never(B, (s) => s.pre, postSeenAt || Infinity).length === 0,
    JSON.stringify(never(B, (s) => s.pre, postSeenAt || Infinity)[0] || null));
  ok("B: NEVER armed on $1.00", never(B, (s) => s.armed && s.pre).length === 0);
  ok("B: ends on $2.00, armed", last(B).post && last(B).armed, JSON.stringify(last(B)));
  ok("B: no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.join(" | "));

  // ── C: compute fails → the fallback read after it settles the tab ──
  const C = await run("C", { owner: true, listDelay: 200, computeDelay: 600, compute: "fail" });
  const c = callsOf(C);
  ok("C: paint, compute, then a list_entries that starts AFTER compute answered", c.length === 3 && c[2].action === "list_entries" && c[2].at >= (c.find((x) => x.action === "compute") || {}).at + 600 - 50,
    JSON.stringify(c.map((x) => `${x.action}@${x.at}`)));
  ok("C: NEVER armed until that read is applied (never armed on $1.00)", never(C, (s) => s.armed && s.pre).length === 0);
  ok("C: ends on $2.00, armed", last(C).post && last(C).armed && !last(C).banner, JSON.stringify(last(C)));

  // ── D: an older server that ignores withEntries ──
  const D = await run("D", { owner: true, listDelay: 200, computeDelay: 600, compute: "old" });
  const d = callsOf(D);
  ok("D: no ledger in the answer → the fallback read after compute", d.length === 3 && d[2].action === "list_entries", JSON.stringify(d.map((x) => `${x.action}@${x.at}`)));
  ok("D: never armed on $1.00, ends armed on $2.00", never(D, (s) => s.armed && s.pre).length === 0 && last(D).post && last(D).armed, JSON.stringify(last(D)));

  // ── E: a rep (no rate access) ──
  const E = await run("E", { owner: false, listDelay: 200, computeDelay: 300, compute: "ledger" });
  const e = callsOf(E);
  const refusals = E.logged.filter((l) => JSON.stringify(l).includes("portal-commissions") && /403|Only the owner/.test(JSON.stringify(l)));
  ok("E: a rep's open files NO refusal row (compute answers with the ledger, not a 403)", refusals.length === 0, JSON.stringify(refusals));
  ok("E: two calls, no third read", e.length === 2, JSON.stringify(e.map((x) => `${x.action}${x.withEntries ? "+entries" : ""}`)));
  ok("E: the banner clears", !last(E).banner, JSON.stringify(last(E)));

  // ── F: cached revisit, compute AND the fallback fail ──
  const F = await run("F", { owner: true, listDelay: 200, computeDelay: 400, compute: "ledger",
    revisit: { computeDelay: 700, compute: "fail", listFails: true, listDelay: 200, settleMs: 4000 } });
  const f = callsOf(F, "revisit");
  ok("F: the cached revisit has no paint leg: compute first", f.length >= 1 && f[0].action === "compute", JSON.stringify(f.map((x) => `${x.action}@${x.at}`)));
  ok("F: cached figures are shown, but NEVER armed, while the reconcile is out", never(F, (s) => s.armed && s.banner, F.firstEnd).length === 0);
  ok("F: after both fail, nothing is armed on the cached figures", !last(F).armed, JSON.stringify(last(F)));
  ok("F: the tab falls back to the empty scaffold, as a failed first read always did", last(F).empty && !last(F).post, JSON.stringify(last(F)));
  ok("F: …and says why", last(F).errShown, JSON.stringify(last(F)));
  ok("F: no uncaught page errors", F.pageErrors.length === 0, F.pageErrors.join(" | "));
} finally {
  await browser.close();
}
const bad = failed();
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
