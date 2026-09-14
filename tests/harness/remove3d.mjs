// The 3D editor's footer names what it removes, and never runs off the screen.
//
// Carolyn, 2026-09-14: the full-screen 3D footer read "Remove WIN" for a vent (a catalog vent is
// a type:"window" item, and the label came from the TYPE's short label) and "Remove WB" for a
// workbench. It now reads the item's real name, ellipsises a long one, and carries the full name
// in its title. This places items from the 3D palette with real clicks on the canvas — which is
// what sets the footer's selection — at a desktop and a tablet width, and measures the button.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/remove3d.mjs                (exit 0 = every check held)
//
// WebGL runs on SwiftShader (lib.mjs launch). Never the in-app browser pane: it starves
// requestAnimationFrame, so the viewer never reaches "ready" and every check fails for nothing.
import { pathToFileURL } from "node:url";
import { launch, stubSupabase, collectErrors, openDesigner, readItems, reporter, shotsDir } from "./lib.mjs";
import { CONFIG, LONG_SHELF, chooseSize } from "./electrical.mjs";

const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function openEditor(page) {
  // Wide screens dock a view-only panel whose footer is "⛶ Edit in 3D"; narrow ones open the
  // full editor straight from "🧊 Show 3D". Either way, end in the editor.
  const edit = page.getByRole("button", { name: /Edit in 3D/ });
  if (!(await edit.count()) || !(await edit.first().isVisible())) {
    const show = page.getByRole("button", { name: /Show 3D/ });
    if (await show.count()) { await show.first().click(); await settle(page, 800); }
  }
  if ((await edit.count()) && (await edit.first().isVisible())) { await edit.first().click(); await settle(page, 800); }
}

// Arm a 3D palette tool (disabled until the scene is "ready") and click the canvas until the
// item lands. A click on the sky keeps the tool armed, so walk a few points rather than trusting
// one — the camera framing differs by viewport.
async function place3(page, buttonName, type) {
  const btn = page.getByRole("button", { name: buttonName, exact: true });
  await btn.first().waitFor({ state: "visible", timeout: 60000 });
  await page.waitForFunction((n) => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === n && !b.disabled), buttonName, { timeout: 90000 });
  const before = ((await readItems(page)) || []).filter((i) => i.type === type).length;
  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0 && o.r.height > 0).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    return c ? { x: c.r.x, y: c.r.y, w: c.r.width, h: c.r.height } : null;
  });
  if (!box) return false;
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.62], [0.42, 0.5], [0.58, 0.5], [0.5, 0.4], [0.35, 0.6], [0.65, 0.6]]) {
    if (!(await btn.first().evaluate((b) => b.style.background && !/1E293B|rgb\(30, 41, 59\)/i.test(b.style.background)))) {
      await btn.first().click();
      await settle(page, 300);
    }
    await page.mouse.click(box.x + fx * box.w, box.y + fy * box.h);
    await settle(page, 700);
    const now = ((await readItems(page)) || []).filter((i) => i.type === type).length;
    if (now > before) return true;
  }
  return false;
}

async function footerButton(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.innerText || "").trim().startsWith("🗑 Remove ") && el.offsetParent);
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      text: b.innerText.trim(), title: b.title, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, overflow: cs.overflow,
      width: Math.round(r.width), right: Math.round(r.right), vw: window.innerWidth,
      truncated: b.scrollWidth > b.clientWidth + 1,
    };
  });
}

async function run(viewport, ok, shots) {
  const tag = `${viewport.width}`;
  const { browser, ctx } = await launch(viewport);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await stubSupabase(page, { config: CONFIG });
  try {
    await openDesigner(page, CONFIG.clientId);
    await page.waitForFunction(() => [...document.querySelectorAll("svg rect")].some((r) => r.getAttribute("stroke") === "#1E293B"), null, { timeout: 30000 });
    await chooseSize(page);
    await settle(page, 600);
    await openEditor(page);

    const shelfPlaced = await place3(page, "📚 SHELF", "shelf");
    ok(`[${tag}] a shelf placed from the 3D palette`, shelfPlaced);
    const f1 = await footerButton(page);
    ok(`[${tag}] footer names the shelf by its catalog name`, f1 && f1.text === `🗑 Remove ${LONG_SHELF}`, f1 && f1.text);
    ok(`[${tag}] footer title carries the full name`, f1 && f1.title === `Remove ${LONG_SHELF}`, f1 && f1.title);
    ok(`[${tag}] long name ellipsises instead of stretching the footer`,
      f1 && f1.textOverflow === "ellipsis" && f1.whiteSpace === "nowrap" && f1.width <= 262 && f1.right <= f1.vw,
      f1 && JSON.stringify({ width: f1.width, right: f1.right, vw: f1.vw, truncated: f1.truncated }));
    await page.screenshot({ path: `${shots}/remove3d-${tag}-shelf.png` });

    const benchPlaced = await place3(page, "🔧 WB", "workbench");
    ok(`[${tag}] a workbench placed from the 3D palette`, benchPlaced);
    const f2 = await footerButton(page);
    ok(`[${tag}] footer reads "Remove Workbench", not the short label "WB"`, f2 && f2.text === "🗑 Remove Workbench" && f2.title === "Remove Workbench" && !f2.truncated,
      f2 && JSON.stringify({ text: f2.text, truncated: f2.truncated }));
    await page.screenshot({ path: `${shots}/remove3d-${tag}-bench.png` });
    ok(`[${tag}] no uncaught page errors`, errors.filter((e) => /^pageerror/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok(`[${tag}] harness ran to the end`, false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" / ") : String(e));
    await page.screenshot({ path: `${shots}/remove3d-${tag}-error.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

export async function main() {
  const { ok, failed } = reporter();
  const shots = shotsDir("remove3d");
  await run({ width: 1280, height: 900 }, ok, shots);
  await run({ width: 768, height: 1024 }, ok, shots);
  const bad = failed();
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks passed");
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((n) => process.exit(n ? 1 : 0));
}
