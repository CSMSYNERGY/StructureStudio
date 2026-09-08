// Shared helpers for the smoke suite. Test tenants only - never point these at a paying
// builder's account: the public designer writes captured_leads / draft designs the moment
// the gate is passed or Details opens.
import { expect } from "@playwright/test";

export const SUPABASE_URL = "https://jzeamjbhdrsbygdnphbm.supabase.co";
// The public anon key is deliberately baked into every page (RLS makes it browser-safe); the
// suite reads it off the served index.html so it never has to be duplicated here.
export async function anonKey(page) {
  const html = await page.evaluate(async () => (await fetch("/index.html")).text());
  const m = html.match(/eyJ[A-Za-z0-9._-]{80,}/);
  if (!m) throw new Error("anon key not found in index.html");
  return m[0];
}

export const CLIENT = process.env.PW_CLIENT || "pw-demo-barns";

// Sign the portal in without a password: a one-time magic-link hashed_token minted outside
// the suite. verifyOtp writes the same sb-<ref>-auth-token localStorage key the portal reads.
export async function loginWithMagicToken(page) {
  const token = process.env.PW_MAGIC_TOKEN;
  if (!token) throw new Error("PW_MAGIC_TOKEN is not set (mint one with the Auth admin generate_link API for a test owner)");
  await page.goto("/portal");
  await page.waitForFunction(() => window.supabase && window.__ssAppBooted === true);
  const key = await anonKey(page);
  const result = await page.evaluate(async ({ url, key, token }) => {
    const c = window.supabase.createClient(url, key);
    const r = await c.auth.verifyOtp({ token_hash: token, type: "magiclink" });
    return { error: r.error ? r.error.message : null, email: r.data && r.data.user ? r.data.user.email : null };
  }, { url: SUPABASE_URL, key, token });
  expect(result.error, "magic link accepted").toBeNull();
  await page.reload();
  await page.waitForFunction(() => window.__ssAppBooted === true);
  // .first(): the portal renders THREE `.ss-nav` elements (main tabs, the sub-nav, and
  // the settings nav), so a bare locator is a strict-mode violation and every portal test
  // fails in this shared helper with an error that names the designer route it happened to
  // be running - reading exactly like a product bug. The assertion only means "the portal
  // chrome painted", and any one of the three proves that.
  await expect(page.locator(".ss-nav").first()).toBeVisible({ timeout: 30_000 });
  return result.email;
}

// The lead gate stores its pass in localStorage; setting it lets the designer be driven
// without writing a captured_leads row for the tenant.
export async function bypassGate(page, clientId) {
  await page.addInitScript((id) => {
    try { localStorage.setItem("ss_gate_" + id, "1"); localStorage.setItem("ss_gate_name_" + id, "Smoke Test"); } catch (_e) {}
  }, clientId);
}

// Collect console errors for the lifetime of a page; ignore third-party noise we do not own.
export function watchConsole(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/googleapis|gstatic|cdn-cgi\/rum|beacon\.min\.js/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  return errors;
}

// Read the designer's live items[] state through the React fiber (no debug hook exists).
export async function designerItems(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const k = Object.keys(root).find((k) => k.startsWith("__reactContainer"));
    const q = [root[k]]; let n = 0;
    while (q.length && n < 60000) {
      const f = q.shift(); n++; if (!f) continue;
      const nm = f.type && (f.type.name || f.type.displayName);
      if (nm === "StructureStudioInner") {
        let h = f.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "type" in v[0] && ("x" in v[0] || "wall" in v[0])) {
            return v.map((i) => ({ type: i.type, wall: i.wall, x: Math.round(i.x), y: Math.round(i.y) }));
          }
          h = h.next;
        }
        return [];
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  });
}

// Client-space point for a plan coordinate in feet (building rect is the #1E293B-stroked rect).
// SCROLLS THE PLAN INTO VIEW FIRST, and that is not a nicety. Callers click these coordinates
// with page.mouse.click(), which fires at raw viewport coordinates and — unlike a locator click —
// does NOT scroll the target into view. At the default 1280x800 the lower half of the plan sits
// below the fold, so every click there landed outside the document: elementFromPoint returned
// null, nothing was placed, and NO refusal toast appeared. That reads in the report as "a window
// cannot be placed on the east wall", and it cost a long diagnosis to prove the product was fine
// (north y=0 and east y=3 placed; east y=6 and south y=12 were simply off-screen at y=867/1129).
export async function planPoint(page, fx, fy) {
  return page.evaluate(({ fx, fy }) => {
    const svg = [...document.querySelectorAll("svg")].find((s) => [...s.querySelectorAll("text")].some((t) => / ft$/.test(t.textContent)));
    // Instant, not smooth: the CTM is read on the next line and must reflect the final scroll.
    svg.scrollIntoView({ block: "center", behavior: "instant" });
    const r = [...svg.querySelectorAll("rect")].find((r) => r.getAttribute("stroke") === "#1E293B");
    const ft = [...svg.querySelectorAll("text")].map((t) => t.textContent.trim()).filter((t) => /^\d+ ft$/.test(t));
    const W = parseInt(ft[0] || "10", 10), H = parseInt(ft[2] || "12", 10);
    const px = +r.getAttribute("x") + fx / W * +r.getAttribute("width");
    const py = +r.getAttribute("y") + fy / H * +r.getAttribute("height");
    const pt = svg.createSVGPoint(); pt.x = px; pt.y = py;
    const c = pt.matrixTransform(svg.getScreenCTM());
    return { x: c.x, y: c.y };
  }, { fx, fy });
}
