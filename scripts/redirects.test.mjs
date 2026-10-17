// The host's routing (_redirects, _headers) held to the app's router and to every address the
// product hands out. Runs in the gate (preflight runs scripts/*.test.mjs with `node --test`).
//
// WHY (2026-10-13). The app's addresses lost their /portal segment (Carolyn 2026-10-12: "It's
// app.structurestudiosuite.com forward slash advance. Like, so let's remove portal from
// anywhere."). That moved the app to the ROOT of a host whose root already belongs to others: the
// public designer at / and /?client=…, the customer page /my-quotes, the standalone console
// /admin, and every asset. So the app is served by one explicit rule pair per page instead of a
// catch-all, and three things now have to agree that nothing used to check:
//   1. every page the router knows has its rules, and no rule serves the app for anything else;
//   2. every old /portal address the smoke suite knows 301s to the root form the app itself
//      computes (ssRootPath), and lands on the app reading the same page;
//   3. the designer, /my-quotes, /admin and the assets are untouched.
// None of this can be seen locally any other way: a static server ignores both files.
//
// The host is modelled by scripts/hostRules.mjs (Cloudflare's parser and matcher semantics); the
// router is the SHIPPED source, sliced out of portal/01-core.jsx and run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRedirects, parseHeaders, resolveRequest, followRequest, headersFor, MAX_DYNAMIC_REDIRECTS } from "./hostRules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const REDIRECTS = parseRedirects(read("_redirects"));
const HEADERS = parseHeaders(read("_headers"));
const CORE = read("portal/01-core.jsx");
const SPEC = read("tests/e2e/portal-routes.spec.mjs");

function slice(src, a, b, what) {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`redirects.test: could not find ${what} (start=${i}, end=${j}) — re-point the anchors rather than deleting this test`);
  return src.slice(i, j);
}

// ── The shipped router ────────────────────────────────────────────────────────────────────
const TAB_META = new Function(`${slice(CORE, "const TAB_META = {", "\n};", "TAB_META")}\n}; return TAB_META;`)();
const ROUTER_SRC = slice(CORE, "const SS_TAB_ALIASES =", "// Is this deployment a beta/preview surface?", "the router");
const win = { location: { pathname: "/", search: "" } };
const R = new Function("window", `${ROUTER_SRC}
  return { ssParsePath, ssRootPath, ssPageBase, SS_TAB_ALIASES, SS_PAGE_SLUGS, SS_LOGIN_SLUG };`)(win);
const parse = (pathname) => { win.location.pathname = pathname; win.location.search = ""; return R.ssParsePath(); };

// Every first segment the app answers at: each page's slug, the old names the router still reads
// (aliases, and the two pages ssCanonRoute folds into the Contacts hub), and the bare /login.
const PAGE_IDS = Object.keys(TAB_META);
const LEGACY_PAGES = [...Object.keys(R.SS_TAB_ALIASES), "designs", "pipelines"];
const slugOf = (id) => R.ssPageBase(id, null).slice(1);
const APP_SLUGS = new Set([...PAGE_IDS.map(slugOf), ...LEGACY_PAGES, R.SS_LOGIN_SLUG]);

// The smoke suite's routes: the canonical address of every page and sub-page it renders.
const ROUTES = [...slice(SPEC, "const ROUTES = [", "\n];", "ROUTES in the route spec").matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
// A route's old address: /portal in front, and the Admin page under its old name.
const legacyOf = (route) => {
  const [first, ...rest] = route.slice(1).split("/");
  const oldFirst = Object.keys(R.SS_PAGE_SLUGS).find((id) => R.SS_PAGE_SLUGS[id] === first) || first;
  return "/portal/" + [oldFirst, ...rest].join("/");
};

const isApp = (r) => r.kind === "rewrite" && r.asset === "/portal.html";

// ── 1. The rule file itself ──────────────────────────────────────────────────────────────
test("_redirects parses cleanly, inside the host's limits, statics above every dynamic rule", () => {
  assert.deepEqual(REDIRECTS.errors, []);
  assert.ok(REDIRECTS.dynamicCount <= MAX_DYNAMIC_REDIRECTS, `${REDIRECTS.dynamicCount} dynamic rules`);
  // A rule written without * or : that sits below a dynamic one silently becomes dynamic (and
  // spends the 100). Keep them above.
  const late = REDIRECTS.rules.filter((r) => r.dynamic && !r.written).map((r) => `line ${r.line}: ${r.from}`);
  assert.deepEqual(late, [], "static rules below the first dynamic one");
});

test("_headers parses cleanly and stays inside the host's 100 rules", () => {
  assert.deepEqual(HEADERS.errors, []);
});

// ── 2. Every page has its rules, and nothing else is the app ─────────────────────────────
test("every page the router knows is served the app at /<slug> and /<slug>/…", () => {
  assert.ok(PAGE_IDS.length >= 20, `only ${PAGE_IDS.length} pages read out of TAB_META — the slice went blind`);
  for (const slug of APP_SLUGS) {
    const paths = slug === R.SS_LOGIN_SLUG ? [`/${slug}`] : [`/${slug}`, `/${slug}/`, `/${slug}/x`, `/${slug}/x/y`];
    for (const p of paths) assert.ok(isApp(resolveRequest(REDIRECTS, p)), `${p} is not served the app`);
  }
  // /login has no sub-pages and so no /login/* rule; its trailing-slash spelling (typed, or pasted
  // from somewhere that added one) 301s to it in one hop, query kept, instead of a 404.
  assert.equal(resolveRequest(REDIRECTS, "/login/").status, 301, "/login/ must be a 301");
  const slash = followRequest(REDIRECTS, "/login/?view=acme-sheds");
  assert.deepEqual(slash.hops, ["/login?view=acme-sheds"], "/login/ must 301 to /login");
  assert.ok(isApp(slash.final), "/login/ does not end on the app");
});

test("no rule serves the app for a slug the router does not know, and there is no catch-all", () => {
  for (const r of REDIRECTS.rules) {
    if (r.to !== "/portal.html") continue;
    assert.equal(r.status, 200, `${r.from} → /portal.html must be a 200 rewrite`);
    const first = r.from.slice(1).split("/")[0];
    assert.ok(APP_SLUGS.has(first), `${r.from} serves the app, but "${first}" is no page the router knows`);
    assert.ok(/^\/[a-z][a-z0-9-]*(\/\*)?$/.test(r.from), `${r.from} is not of the form /<slug> or /<slug>/*`);
  }
  for (const p of ["/a-page-that-does-not-exist", "/x/y", "/index.htm", "/vendor", "/admin/clients"]) {
    assert.ok(!isApp(resolveRequest(REDIRECTS, p)), `${p} is served the app`);
  }
});

test("/admin is admin.html, never the app; the app's Admin page lives at /console", () => {
  assert.deepEqual(parse("/admin"), { page: null, sub: null });
  assert.deepEqual(parse("/console/clients"), { page: "admin", sub: "clients" });
  assert.equal(R.ssPageBase("admin", "clients"), "/console/clients");
  assert.equal(resolveRequest(REDIRECTS, "/admin").asset, "/admin.html");
  assert.ok(isApp(resolveRequest(REDIRECTS, "/console/clients")));
});

// ── 3. The designer, the customer page, the console and the assets are untouched ────────
test("/ and /?client=… stay the public designer; /my-quotes and /admin stay theirs", () => {
  const cases = [["/", "/index.html"], ["/?client=acme-sheds", "/index.html"], ["/?client=acme-sheds&account=quotes", "/index.html"],
    ["/my-quotes", "/my-quotes.html"], ["/my-quotes?client=acme-sheds", "/my-quotes.html"], ["/admin", "/admin.html"],
    ["/shop", "/shop.html"], ["/shop?client=acme-sheds&unit=x", "/shop.html"]];
  for (const [path, asset] of cases) {
    const r = resolveRequest(REDIRECTS, path);
    assert.deepEqual([r.kind, r.asset], ["rewrite", asset], path);
  }
  assert.equal(resolveRequest(REDIRECTS, "/my-quotes/").location, "/my-quotes");
  assert.equal(resolveRequest(REDIRECTS, "/admin/").location, "/admin");
});

// Every file and directory the host uploads, read off the repo root minus .assetsignore.
function servedRootEntries() {
  const ignore = read(".assetsignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const toRe = (pat) => new RegExp("^" + pat.replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
  const topLevel = ignore.filter((p) => !p.replace(/\/$/, "").includes("/")).map(toRe);
  return readdirSync(ROOT)
    .filter((name) => !name.startsWith(".") && name !== "_redirects" && name !== "_headers")
    .filter((name) => !topLevel.some((re) => re.test(name)))
    .map((name) => ({ name, dir: statSync(join(ROOT, name)).isDirectory() }));
}

test("every served file and directory is answered as itself, and none shares a page's name", () => {
  const entries = servedRootEntries();
  const names = entries.map((e) => e.name);
  for (const must of ["index.html", "portal.html", "admin.html", "my-quotes.html", "sw.js", "manifest.json", "vendor", "icons", "assets", "portal.app.compiled.js"]) {
    assert.ok(names.includes(must), `${must} not found among the served files — the listing went blind`);
  }
  for (const { name, dir } of entries) {
    const probe = dir ? `/${name}/probe.js` : `/${name}`;
    const r = resolveRequest(REDIRECTS, probe);
    // The four .html files have their own pretty-route rules but are themselves served as files.
    assert.equal(r.kind, "asset", `${probe} is caught by the rule for ${r.rule && r.rule.from}`);
    const bare = name.replace(/\.html$/, "");
    assert.ok(!APP_SLUGS.has(name) && !(dir && APP_SLUGS.has(bare)), `${name} is served AND is the name of an app page`);
  }
});

// ── 4. Every old /portal address the smoke suite knows → its root form → the app ─────────
test("the route spec lists canonical root addresses only", () => {
  assert.ok(ROUTES.length >= 60, `only ${ROUTES.length} routes read out of the spec — the slice went blind`);
  for (const route of ROUTES) assert.ok(!/^\/portal(\/|\.html|$)/.test(route), `${route} is an old /portal address`);
});

test("every route's old /portal address 301s to it, the query kept, and the app reads the same page", () => {
  for (const route of ROUTES) {
    const legacy = legacyOf(route);
    for (const q of ["", "?view=acme-sheds", "?view=acme-sheds&popout=1"]) {
      const r = resolveRequest(REDIRECTS, legacy + q);
      assert.deepEqual([r.kind, r.status, r.location], ["redirect", 301, route + q], `${legacy + q}`);
      // The browser computes the same root form when no host redirected it (ssHealAddress).
      assert.equal(R.ssRootPath(legacy), route, `ssRootPath(${legacy})`);
      // One hop, then the app, reading the page the old address meant.
      const end = followRequest(REDIRECTS, legacy + q);
      assert.equal(end.hops.length, 1, `${legacy + q}: ${end.hops.join(" -> ")}`);
      assert.ok(isApp(end.final), `${legacy + q} does not end on the app`);
    }
    assert.deepEqual(parse(route), parse(legacy), `${route} and ${legacy} read as different pages`);
    assert.ok(isApp(resolveRequest(REDIRECTS, route)), `${route} is not served the app`);
  }
});

test("the bare and special old addresses", () => {
  const cases = [
    ["/portal", "/login"], ["/portal/", "/login"], ["/portal?view=acme-sheds", "/login?view=acme-sheds"],
    // A PKCE password-reset landing: the code must arrive whole.
    ["/portal?code=0123abcd", "/login?code=0123abcd"],
    ["/portal/admin", "/console"], ["/portal/admin/clients?view=acme-sheds", "/console/clients?view=acme-sheds"],
    ["/portal/contacts/c-4512ed87-fb75-4645-81d6-9268eb73e3a1", "/contacts/c-4512ed87-fb75-4645-81d6-9268eb73e3a1"],
    ["/portal/orders/o-11111111-2222-4333-8444-555555555555", "/orders/o-11111111-2222-4333-8444-555555555555"],
    ["/portal/projects/setup?popout=1", "/projects/setup?popout=1"],
  ];
  for (const [from, to] of cases) {
    const r = resolveRequest(REDIRECTS, from);
    assert.deepEqual([r.kind, r.status, r.location], ["redirect", 301, to], from);
    assert.ok(isApp(followRequest(REDIRECTS, from).final), `${from} does not end on the app`);
    assert.equal(R.ssRootPath(new URL(from, "https://x.invalid").pathname), new URL(to, "https://x.invalid").pathname, `ssRootPath(${from})`);
  }
  // /portal.html is the file every rule rewrites to, so the host serves it as itself; the app heals
  // its address to /login in the browser.
  assert.equal(resolveRequest(REDIRECTS, "/portal.html").kind, "asset");
  assert.equal(R.ssRootPath("/portal.html"), "/login");
  // A root address is never "healed".
  for (const p of ["/", "/login", "/contacts", "/settings/colors", "/console", "/my-quotes"]) assert.equal(R.ssRootPath(p), null, p);
});

test("both address shapes read the same, and every page's own address reads back as that page", () => {
  assert.deepEqual(parse("/login"), { page: null, sub: null });
  assert.deepEqual(parse("/portal"), { page: null, sub: null });
  assert.deepEqual(parse("/portal.html"), { page: null, sub: null });
  assert.deepEqual(parse("/"), { page: null, sub: null });
  for (const id of PAGE_IDS) {
    const sub = id === "settings" ? "colors" : "x-1";
    assert.deepEqual(parse(R.ssPageBase(id, null)), { page: id, sub: null }, id);
    assert.deepEqual(parse(R.ssPageBase(id, sub)), { page: id, sub }, `${id}/${sub}`);
    assert.ok(isApp(resolveRequest(REDIRECTS, R.ssPageBase(id, sub))), `${R.ssPageBase(id, sub)} is not served the app`);
  }
});

// ── 5. Framing: every app address carries X-Frame-Options, the designer never does ───────
test("_headers gives every app address X-Frame-Options: DENY exactly once; the designer gets none", () => {
  const appRules = REDIRECTS.rules.filter((r) => r.to === "/portal.html");
  for (const r of appRules) {
    const own = HEADERS.rules.find((h) => h.path === r.from);
    assert.ok(own && own.headers.some(([n, v]) => n === "X-Frame-Options" && v === "DENY"), `_headers has no X-Frame-Options rule for ${r.from}`);
    const probe = r.from.endsWith("/*") ? r.from.slice(0, -1) + "x" : r.from;
    // Two matching rules would JOIN their values ("DENY, DENY"), which is no value at all.
    assert.equal(headersFor(HEADERS, probe).headers["x-frame-options"], "DENY", probe);
  }
  for (const p of ["/", "/index.html"]) assert.equal(headersFor(HEADERS, p).headers["x-frame-options"], undefined, `${p} must stay frameable (tenant embeds)`);
});

// ── 5b. The old /portal 301s are never cached by a browser ───────────────────────────────
// A 301 with no Cache-Control is kept by the browser, which then jumps to the root address from
// its own cache. If the redirects were ever rolled back (or one mapping were wrong), those
// browsers would keep landing on an address that no longer exists. no-store keeps every /portal
// request going to the host. See the note above the /portal rules in _headers.
test("every old /portal address is answered Cache-Control: no-store, and only those", () => {
  const legacy = ["/portal", "/portal/", "/portal/admin", "/portal/admin/clients", "/portal/orders/o-1", ...ROUTES.map(legacyOf)];
  for (const p of legacy) {
    assert.equal(resolveRequest(REDIRECTS, p).kind, "redirect", `${p} is no longer a redirect: re-think the no-store below`);
    assert.equal(headersFor(HEADERS, p).headers["cache-control"], "no-store", `${p}: the 301 must carry Cache-Control: no-store`);
  }
  // The app's own addresses, the file they all serve, and the designer keep the host's default.
  for (const p of ["/portal.html", "/login", "/login/", "/contacts", "/settings/colors", "/console", "/", "/index.html", "/admin"]) {
    assert.equal(headersFor(HEADERS, p).headers["cache-control"], undefined, `${p} must not be no-store`);
  }
});

// ── 6. Every address the product hands out lands on the app ──────────────────────────────
// Two kinds, because they reach people on two different schedules.
//
// SHIPPED WITH THESE RULES: the page or bundle that hands the address out deploys in the same push
// as _redirects, so it only ever meets these rules. Those are root addresses, answered directly.
//
// SHIPPED AHEAD OF THESE RULES: an edge function goes live for PRODUCTION the moment it deploys,
// and Forgot password names the production host even from beta, while production keeps the old
// _redirects until main is promoted. Those addresses must work on BOTH hosts. The old one serves
// the app only at /portal[/…]; these rules 301 that to the root form in one hop. So they stay
// /portal until production serves these rules (and, for the two auth landings, /login is on the
// Supabase Auth redirect allow-list). The flip then moves them into the first list.
//
// Production's _redirects before the promotion (main, 2026-10-13), rules only:
const OLD_HOST = parseRedirects([
  "/            /index.html    200",
  "/portal      /portal.html   200",
  "/portal/     /portal        301",
  "/admin       /admin.html    200",
  "/admin/      /admin         301",
  "/my-quotes   /my-quotes.html  200",
  "/my-quotes/  /my-quotes       301",
  "/portal/*    /portal.html   200",
].join("\n"));
const ORDER_ID = "11111111-2222-4333-8444-555555555555";

test("addresses handed out ahead of these rules work on production's old host AND on these rules", () => {
  const sources = [
    // [file, regex whose group 1 is the full URL or path the product sends people to, what it is, extra paths]
    ["supabase/functions/_shared/authPortalUrl.ts", /AUTH_PORTAL_URL = "(https:\/\/[^"]+)"/, "auth email landing (invites, resets)"],
    ["portal/01-core.jsx", /redirectTo: "(https:\/\/[^"]+)"/, "Forgot password landing"],
    ["supabase/functions/_shared/customerPortalUrl.ts", /const base = `https:\/\/\$\{hostFor\(req\)\}(\/[^`]*)`/, "Invoice to approve email", [`/o-${ORDER_ID}`]],
    ["supabase/functions/qbo-oauth-callback/index.ts", /Location: `https:\/\/\$\{safeHost\}(\/[^?`]*)\?/, "QuickBooks connect landing"],
  ];
  const found = {};
  for (const [file, re, what, extra = []] of sources) {
    const m = re.exec(read(file));
    assert.ok(m, `${file}: the ${what} was not found — re-point this test`);
    found[what] = m[1];
    const base = new URL(m[1], "https://app.structurestudiosuite.com").pathname;
    for (const path of [base, ...extra.map((x) => base + x)]) {
      const old = resolveRequest(OLD_HOST, path);
      assert.ok(isApp(old), `${file}: the ${what} sends people to ${path}, which production answers with ${old.kind} ${old.location || old.asset} until main is promoted — keep it on /portal until then`);
      const q = "?connected=1&view=acme-sheds";
      const end = followRequest(REDIRECTS, path + q);
      assert.ok(isApp(end.final), `${file}: the ${what} (${path}) does not end on the app under these rules`);
      assert.ok(end.hops.length <= 1, `${file}: the ${what} (${path}) takes ${end.hops.length} hops: ${end.hops.join(" -> ")}`);
      const landed = new URL(end.hops[0] || path + q, "https://x.invalid");
      assert.equal(landed.search, q, `${file}: the ${what} loses its query on the way`);
      assert.deepEqual(parse(landed.pathname), parse(path), `${file}: the ${what} lands on a different page than ${path} means`);
    }
  }
  // The two auth landings are one destination (one allow-list entry): the server's emails and the
  // login form's Forgot password must name the same URL.
  assert.equal(found["Forgot password landing"], found["auth email landing (invites, resets)"], "AUTH_PORTAL_URL and Forgot password's redirectTo name different addresses");
});

test("addresses shipped with these rules are root addresses the app answers directly", () => {
  const sources = [
    // [file, regex whose group 1 is the path the product sends people to, what it is]
    ["StructureStudio.jsx", /window\.location\.replace\("(\/[^"]*)" \+ window\.location\.search/, "designer's bare-root redirect"],
    ["structure-studio.component.js", /window\.location\.replace\("(\/[^"]*)" \+ window\.location\.search/, "designer's bare-root redirect"],
    ["404.html", /<a class="btn" href="([^"]*)"/, "404 page button"],
    ["admin.app.jsx", /<a href=\{`(\/[^?`]*)\?view=/, "console's Open portal"],
  ];
  for (const [file, re, what] of sources) {
    const m = re.exec(read(file));
    assert.ok(m, `${file}: the ${what} was not found — re-point this test`);
    const r = resolveRequest(REDIRECTS, m[1]);
    assert.ok(isApp(r), `${file}: the ${what} sends people to ${m[1]}, which the host answers with ${r.kind} ${r.location || r.asset}`);
  }
  const manifest = JSON.parse(read("manifest.json"));
  // The install identity: changing it orphans every installed copy of the app.
  assert.equal(manifest.id, "/portal.html");
  assert.ok(isApp(resolveRequest(REDIRECTS, manifest.start_url)), `manifest start_url ${manifest.start_url} does not open the app`);
});

test("the redirect test's own fixtures exist", () => {
  for (const f of ["_redirects", "_headers", ".assetsignore", "portal/01-core.jsx", "tests/e2e/portal-routes.spec.mjs"]) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
});
