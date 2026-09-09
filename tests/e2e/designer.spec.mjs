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

// Doors and windows come from the FIXTURES catalog now. The built-in singleDoor/doubleDoor/
// window layout items were deleted from the master catalog on 2026-09-08, so there is no
// longer a palette button that places one on click: the "Door" and "Window" tools arm, and
// the wall click opens a picker modal (DOOR_PICKER_CFG / WINDOW_PICKER_CFG,
// StructureStudio.jsx:598 and :616). Choosing a style there is what places the item.
//
// The style cards are divs, not buttons (StructureStudio.jsx:1281), so they are reached by
// text. A style with exactly one size auto-selects it (pickStyle), which is why these two
// fixtures are chosen — anything multi-size would need a second click on the size chip.
async function placeFixture(page, tool, styleName, confirmLabel, fx, fy) {
  await arm(page, tool);
  await clickPlan(page, fx, fy);
  await page.getByText(styleName, { exact: true }).first().click();
  await page.getByRole("button", { name: confirmLabel }).click();
  await page.waitForTimeout(300);
}
// ⚠️ These matchers are ANCHORED, and they have to be. `arm` matches the accessible name by
// case-insensitive SUBSTRING and takes .first(), so a plain "Door" also matches
// "⬜ Rough Opening (Door) wall" — which sorts FIRST in the DOORS group, so from the day the
// rough opening split shipped (2026-09-08) a bare "Door" armed a rough opening, the wall click
// placed one instead of opening the picker, and the failure surfaced as "the style card never
// appeared". The door picker's name is exactly "Door wall" (its icon is an inline SVG with no
// text); the window picker's is "🪟 Window wall", so anchoring the END excludes the rough
// opening, whose name ends ") wall".
const placeDoor = (page, fx, fy) => placeFixture(page, /^Door wall$/, "Single Barn Door", "Place door", fx, fy);
const placeWindow = (page, fx, fy) => placeFixture(page, /Window wall$/, "Double Hung Window", "Place window", fx, fy);

test("public designer boots and places every wall item", async ({ page }) => {
  const errors = watchConsole(page);
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();

  await placeDoor(page, 5, 0);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "fixtureDoor", wall: "north" })]));

  // A workbench dropped across the door span is refused with a toast.
  await arm(page, /Workbench/); await clickPlan(page, 2, 0.5);
  await expect(toast(page)).toBeVisible();
  await page.getByRole("button", { name: "✕" }).first().click().catch(() => {});

  // A catalog window is a plain type:"window" item — fixtureItemId is what proves the
  // catalog path ran rather than the deleted built-in one.
  await placeWindow(page, 10, 6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "window", wall: "east", fixtureItemId: expect.anything() })]));

  await arm(page, /Loft Area/); await clickPlan(page, 5, 9);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "loft" })]));

  await arm(page, /Ramp/); await clickPlan(page, 5, -0.6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ramp", wall: "north" })]));

  expect(errors, "console errors").toEqual([]);
});

// The rough opening split into a DOOR ro and a WINDOW ro on 2026-09-08 (migration 224). The two
// differ only in geometry — the door runs to the floor, the window sits on a sill — and the whole
// of that difference is the field pair stamped onto the item at placement, which openingSpan,
// openSpanOf and ssItemVBand all read. So this asserts the stamp: it is the one fact those three
// readers agree about, and a pixel test could not tell a 3 ft opening at 3'6" from a 6'6" one at
// the floor without rendering WebGL.
test("door and window rough openings place with their own geometry and labels", async ({ page }) => {
  const errors = watchConsole(page);
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();

  await arm(page, "Rough Opening (Door)"); await clickPlan(page, 5, 0);
  await arm(page, "Rough Opening (Window)"); await clickPlan(page, 10, 6);

  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "roughOpeningDoor", wall: "north", sillFt: 0 }),
    expect.objectContaining({ type: "roughOpeningWindow", wall: "east" }),
  ]));
  const placed = await designerItems(page);
  const win = placed.find((i) => i.type === "roughOpeningWindow");
  expect(win.sillFt, "a window rough opening sits off the floor").toBeGreaterThan(0);
  expect(win.openingHeightFt, "and is shorter than a door opening").toBeLessThan(6.5);

  // Numbered per kind and prefixed, so the two families can never collide on one drawing.
  const plan = page.locator("svg").filter({ hasText: /ft/ }).first();
  await expect(plan).toContainText("RO-D1");
  await expect(plan).toContainText("RO-W1");

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
//     window THEN door -> east wall holds 2: ["window", "fixtureDoor"]  <-- overlapping
//     door THEN window -> east wall holds 1: ["fixtureDoor"]            <-- refused
//
// (The types changed on 2026-09-08 when the built-in doors/windows were retired in favour of
// the fixtures catalog. The finding did not: a catalog window is still a type:"window" item,
// so it hits the same carve-out.)
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

  await placeWindow(page, 10, 6);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "window", wall: "east" })]));

  await placeDoor(page, 10, 6);
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

// ── SELECTION MUST SURVIVE THE CLICK THAT MAKES IT ───────────────────────────────────────
// The regression this exists for (Carolyn, 2026-09-06: "the workbench and shelves can't be
// resized at all"): the wall-elevation panel was a flex-ROW sibling of the plan, so selecting
// a wall item made the plan jump 131px sideways mid-gesture. getSvgPt reads
// getBoundingClientRect() LIVE, so the trailing click hit-tested 131px away, missed, and
// deselected. The stretch grips rendered on mousedown and were gone before anyone could grab
// one -- which also silently killed Rotate, Delete, Swap and Center for every wall item.
//
// It went unnoticed because NOTHING IN THIS SUITE EVER SELECTED AN ITEM. Placement alone
// passes straight through the bug. Two assertions matter and neither is optional: the plan's
// own x must not move across the selection, and the grips must still be on screen AFTER the
// click, not merely during it.
//
// The threshold scaled with item width -- a 6ft double door survived, a 4ft workbench did not
// -- so a wide item is not evidence the bug is gone. Keep this on the workbench.
// designerItems() projects only type/wall/x/y, so a width assertion has to read the state
// itself. Same fiber walk, one more field.
async function workbenchWidthFt(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const k = Object.keys(root).find((x) => x.startsWith("__reactContainer"));
    const q = [root[k]]; let n = 0;
    while (q.length && n < 60000) {
      const f = q.shift(); n++; if (!f) continue;
      const nm = f.type && (f.type.name || f.type.displayName);
      if (nm === "StructureStudioInner") {
        let h = f.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "type" in v[0] && ("x" in v[0] || "wall" in v[0])) {
            const wb = v.filter((i) => i.type === "workbench")[0];
            return wb ? wb.widthFt : null;
          }
          h = h.next;
        }
        return null;
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  });
}

test("selecting a wall item keeps it selected, and the workbench can be stretched", async ({ page }) => {
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();

  const chrome = () => page.evaluate(() => {
    const svg = [...document.querySelectorAll("svg")].find((s) => /ft/.test(s.textContent || ""));
    const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent.trim());
    return {
      grips: texts.filter((t) => t === "◄" || t === "►").length,
      selected: [...svg.querySelectorAll('rect[stroke-dasharray="4 2"]')].length,
      planX: Math.round(svg.getBoundingClientRect().x * 10) / 10,
    };
  });

  await arm(page, /Workbench/);
  await clickPlan(page, 5, 0);
  await expect.poll(() => designerItems(page)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "workbench" })]));
  const planXBefore = (await chrome()).planX;

  await clickPlan(page, 5, 0);                       // select it
  const sel = await chrome();
  expect(sel.selected, "the workbench is still selected after the click that selected it").toBe(1);
  expect(sel.grips, "both stretch grips are on screen AFTER the click, not just during it").toBe(2);
  expect(sel.planX, "the plan must not move when an item is selected").toBe(planXBefore);

  // Stretch it by dragging the right-hand grip, and prove widthFt actually changed.
  const beforeW = await workbenchWidthFt(page);
  const grip = await page.evaluate(() => {
    const svg = [...document.querySelectorAll("svg")].find((s) => /ft/.test(s.textContent || ""));
    const a = [...svg.querySelectorAll("text")].filter((t) => t.textContent.trim() === "►")[0];
    const b = a.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 70, grip.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => workbenchWidthFt(page), { timeout: 10_000 }).not.toBe(beforeW);
});

// The plan is the SIMPLE layout: the grid carries the measuring, and per Carolyn 2026-09-06
// the along-wall dimension chips do not belong on it (3b899bb put them there; the 3D has them
// instead now).
//
// The assertion is "selecting must not ADD dimensions", NOT "the plan has no feet-inches text
// anywhere". An item carries its own size label - a workbench reads 4' 0" - which long predates
// this complaint and is not what she objected to. An absolute check trips on that label and
// would push the next person into deleting the wrong thing.
test("selecting a wall item draws no dimension chips on the plan", async ({ page }) => {
  await bypassGate(page, CLIENT);
  await page.goto(`/?client=${CLIENT}`);
  await page.waitForFunction(() => window.__ssAppBooted === true && typeof window.StructureStudio === "function");
  await expect(page.locator("svg").filter({ hasText: /ft/ }).first()).toBeVisible();
  const ftIn = () => page.evaluate(() => {
    const svg = [...document.querySelectorAll("svg")].find((s) => /ft/.test(s.textContent || ""));
    return [...svg.querySelectorAll("text")].map((t) => t.textContent.trim())
      .filter((t) => t.indexOf("'") > 0).sort();
  });
  await arm(page, /Workbench/);
  await clickPlan(page, 5, 0);
  const unselected = await ftIn();
  await clickPlan(page, 5, 0);
  const selected = await ftIn();
  expect(selected, "selecting an item must not paint new dimensions on the plan").toEqual(unselected);
});
