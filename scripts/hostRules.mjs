// The web host's routing rules — `_redirects` and `_headers` at the repo root — read the way
// Cloudflare Workers static assets reads them, so code can ask "what does the host answer for
// this address?" without a deploy. Two callers:
//   * scripts/redirects.test.mjs, which holds the rules to the app's router (portal/01-core.jsx)
//     and to every address the product hands out;
//   * tests/harness/lib.mjs serveAppRoutes(), which lets a harness on a plain static server
//     (python -m http.server ignores both files) open the app at its real addresses.
//
// THE SEMANTICS MODELLED (Cloudflare's own parser and matcher, workers-shared):
//   * A line is `from to [status]` (status defaults to 302); blank lines and `#` lines are skipped.
//   * A rule is STATIC when `from` has no `*` and no `:name` — but only until the first dynamic
//     rule: every rule after that counts as dynamic, whatever it looks like. Limits: 2,000 static,
//     100 dynamic, 1,000 characters a line. A repeated `from` is ignored.
//   * Matching: static rules by exact path first, then the dynamic ones in file order, first match.
//     `*` matches anything (slashes too) as :splat; `:name` matches one path segment.
//   * 200 serves the target asset under the requested address. 3xx answers with a Location that
//     keeps the REQUEST's query string when the target names none.
// What it does not model: Netlify (legacy; the file's own header keeps the two equivalent),
// host-qualified rules (this repo has none), and the asset lookup itself (no rule = "asset").
//
// Pure functions over text; no file access here, so a caller decides what it reads.

export const MAX_STATIC_REDIRECTS = 2000;
export const MAX_DYNAMIC_REDIRECTS = 100;
export const MAX_REDIRECT_LINE = 1000;
export const MAX_HEADER_RULES = 100;
const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308]);

const isDynamic = (from) => from.includes("*") || /:[A-Za-z]\w*/.test(from);

/** `_redirects` text → { rules: [{ from, to, status, line, dynamic }], errors: [string] }. */
export function parseRedirects(text) {
  const rules = [];
  const errors = [];
  const seen = new Set();
  let staticCount = 0;
  let dynamicCount = 0;
  let staticAllowed = true;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line || line.startsWith("#")) return;
    if (line.length > MAX_REDIRECT_LINE) { errors.push(`line ${n}: longer than ${MAX_REDIRECT_LINE} characters`); return; }
    const tokens = line.split(/\s+/);
    if (tokens.length < 2 || tokens.length > 3) { errors.push(`line ${n}: expected "from to [status]", got ${tokens.length} fields`); return; }
    const [from, to, s = "302"] = tokens;
    const status = Number(s);
    if (!from.startsWith("/")) { errors.push(`line ${n}: "${from}" does not start with /`); return; }
    if (!REDIRECT_STATUSES.has(status)) { errors.push(`line ${n}: status ${s} is not one the host accepts`); return; }
    let dynamic;
    if (staticAllowed && !isDynamic(from)) {
      dynamic = false;
      staticCount += 1;
      if (staticCount > MAX_STATIC_REDIRECTS) { errors.push(`line ${n}: more than ${MAX_STATIC_REDIRECTS} static rules`); return; }
    } else {
      dynamic = true;
      staticAllowed = false;
      dynamicCount += 1;
      if (dynamicCount > MAX_DYNAMIC_REDIRECTS) { errors.push(`line ${n}: more than ${MAX_DYNAMIC_REDIRECTS} dynamic rules`); return; }
    }
    if (seen.has(from)) { errors.push(`line ${n}: a second rule for ${from} (the host ignores it)`); return; }
    seen.add(from);
    rules.push({ from, to, status, line: n, dynamic, written: isDynamic(from) });
  });
  return { rules, errors, staticCount, dynamicCount };
}

// `from` → a RegExp with named groups, the way the host builds it.
function patternOf(from) {
  const escaped = from.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  const src = escaped.replace(/\*/g, "(?<splat>.*)").replace(/:([A-Za-z]\w*)/g, "(?<$1>[^/]+)");
  return new RegExp(`^${src}$`);
}
function fill(to, groups) {
  return to.replace(/:([A-Za-z]\w*)/g, (m, name) => (groups && groups[name] !== undefined ? groups[name] : m));
}

/** The rule the host applies to `pathname`, with its target filled in, or null. */
export function matchRedirect(parsed, pathname) {
  const exact = parsed.rules.find((r) => !r.dynamic && r.from === pathname);
  if (exact) return { rule: exact, to: exact.to, status: exact.status };
  for (const r of parsed.rules) {
    if (!r.dynamic) continue;
    const m = patternOf(r.from).exec(pathname);
    if (m) return { rule: r, to: fill(r.to, m.groups || {}), status: r.status };
  }
  return null;
}

/**
 * What the host answers for one request (`pathWithQuery` like "/portal/orders?view=x").
 *   { kind: "rewrite", asset, rule }            200: `asset` is served under the asked address
 *   { kind: "redirect", status, location, rule } 3xx
 *   { kind: "asset", asset }                     no rule: the file at that path, or the 404 page
 */
export function resolveRequest(parsed, pathWithQuery) {
  const u = new URL(pathWithQuery, "https://host.invalid");
  const hit = matchRedirect(parsed, u.pathname);
  if (!hit) return { kind: "asset", asset: u.pathname };
  if (hit.status === 200) return { kind: "rewrite", asset: hit.to, rule: hit.rule };
  const dest = new URL(hit.to, "https://host.invalid");
  const location = dest.origin === u.origin
    ? `${dest.pathname}${dest.search || u.search}${dest.hash}`
    : `${dest.origin}${dest.pathname}${dest.search || u.search}${dest.hash}`;
  return { kind: "redirect", status: hit.status, location, rule: hit.rule };
}

/** Follows redirects (at most `max`) and returns { final, hops: [locations] }. */
export function followRequest(parsed, pathWithQuery, max = 5) {
  const hops = [];
  let at = pathWithQuery;
  for (let i = 0; i <= max; i++) {
    const r = resolveRequest(parsed, at);
    if (r.kind !== "redirect") return { final: r, at, hops };
    hops.push(r.location);
    at = r.location;
  }
  throw new Error(`more than ${max} redirects starting at ${pathWithQuery}: ${hops.join(" -> ")}`);
}

/** `_headers` text → { rules: [{ path, headers: [[name, value]], line }], errors }. */
export function parseHeaders(text) {
  const rules = [];
  const errors = [];
  let cur = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    if (!/^\s/.test(raw)) {
      const path = raw.trim();
      if (!path.startsWith("/") && !path.startsWith("https://")) { errors.push(`line ${n}: "${path}" is not a path`); cur = null; return; }
      cur = { path, headers: [], line: n };
      rules.push(cur);
      return;
    }
    const m = /^\s+(!?\s*[A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m || !cur) { errors.push(`line ${n}: a header line outside a rule, or not "Name: value"`); return; }
    cur.headers.push([m[1].trim(), m[2].trim()]);
  });
  if (rules.length > MAX_HEADER_RULES) errors.push(`${rules.length} header rules, more than the host's ${MAX_HEADER_RULES}`);
  return { rules, errors };
}

/** Every header the host sends for `pathname`, values of a repeated name joined with ", ". */
export function headersFor(parsed, pathname) {
  const out = {};
  const matched = [];
  for (const r of parsed.rules) {
    if (!patternOf(r.path).test(pathname)) continue;
    matched.push(r);
    for (const [name, value] of r.headers) {
      const k = name.toLowerCase();
      out[k] = out[k] === undefined ? value : `${out[k]}, ${value}`;
    }
  }
  return { headers: out, matched };
}
