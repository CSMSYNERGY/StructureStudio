// Public designer smoke on a TEST tenant: boot, one placement of each wall item, the
// collision refusals, and the window-overlap rule. Real mouse clicks (the app snaps by the
// click's client coordinates, so a synthetic click with the wrong CTM lands elsewhere).
import { test, expect } from "@playwright/test";
import { CLIENT, bypassGate, watchConsole, designerItems, planPoint } from "./helpers.mjs";

async function arm(page, label) {
  await page.getByRole("button", { name: label }).first().click();
  await page.waitForTimeout(250); // React commit; a click in the same tick places the previous tool
}
async function clickPlan(page, fx, fy) {
  const p = await planPoint(page, fx, fy);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(300);
}
const toast = (page) => page.locator("text=Can't place here");

test("public designer boots and places every wall item", async ({ page }) => {
  const errors = watchConsole(page);
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();

  await arm(page, /Single Door/); await clickPlan(page, 5, 0);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "singleDoor", wall: "north" })]));

  // A workbench dropped across the door span is refused with a toast.
  await arm(page, /Workbench/); await clickPlan(page, 2, 0.5);
  await expect(toast(page)).toBeVisible();
  await page.getByRole("button", { name: "✕" }).first().click().catch(() => {});

  await arm(page, /Window/); await clickPlan(page, 10, 6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "window", wall: "east" })]));

  await arm(page, /Loft Area/); await clickPlan(page, 5, 9);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "loft" })]));

  await arm(page, /Ramp/); await clickPlan(page, 5, -0.6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ramp", wall: "north" })]));

  expect(errors, "console errors").toEqual([]);
});

// ── KNOWN FAILING, ON PURPOSE ────────────────────────────────────────────────────────────
// test.fail() asserts this test currently DOES fail. When somebody fixes the product, this
// goes red and whoever did it deletes the marker — which is the point. A silently inverted
// assertion would have buried a real finding.
//
// THE FINDING (audit 2026-09-06, reproduced live on beta): the overlap guard only works in
// ONE direction, so the order the user happens to click in decides whether the app protects
// them.
//
//     window THEN door -> east wall holds 2: ["window", "singleDoor"]   <-- overlapping
//     door THEN window -> east wall holds 1: ["singleDoor"]             <-- refused
//
// checkDoorCollision (StructureStudio.jsx:192) skips existing windows:
//     if (!c || !c.wallOnly || it.type === "window") continue;
// Windows ARE wallOnly:true (line 82), so that type check is a DELIBERATE carve-out, not an
// oversight of the wallOnly test. Removing it is therefore a product decision, not a bug fix:
// it would also make windows block each other, and it would change AUTO-PLACEMENT — there are
// ten call sites, including the auto-layout loops that `continue` past a collision, so
// auto-placed doors could start failing to place where they currently succeed.
//
// Needs Carolyn's answer to one question: may a door and a window share a wall span? If no,
// drop the `it.type === "window"` clause and re-run the whole designer suite for auto-layout
// regressions.
test("a door dropped onto an existing window is refused", async ({ page }) => {
  // INSIDE the body, not at file scope. A bare `test.fail()` between tests marks EVERY
  // subsequent test in the file expected-to-fail, which silently flipped the phone-viewport
  // test to "failed" for passing.
  test.fail();
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();

  await arm(page, /Window/); await clickPlan(page, 10, 6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "window", wall: "east" })]));

  await arm(page, /Single Door/); await clickPlan(page, 10, 6);
  const east = (await designerItems(page)).filter((i) => i.wall === "east");
  expect(east.length, "no second opening on the window's spot").toBe(1);
});

test("designer on a phone viewport has no horizontal scroll", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true);
  const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(dims.sw, `scrollWidth ${dims.sw} vs clientWidth ${dims.cw}`).toBeLessThanOrEqual(dims.cw + 1);
  await ctx.close();
});
