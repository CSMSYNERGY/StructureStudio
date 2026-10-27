// THE SUPPORT BUTTON (Carolyn, 10-26 call; migrations 340 and 346): for a builder with the switch on
// the floating Feedback pill is gone, a Support button sits in the top bar, and its menu opens the AI
// assistant, the three forms, My Requests and What's New. Driven for real on the COMPILED portal at
// 1440 px and at 375 px.
//
//   A  NO PILL: once support-agent's `enabled` answers on, nothing fixed in a bottom corner says
//      "Feedback", and the answer is remembered for the next load.
//   B  THE BUTTON: in .ss-topbar, before the tenant badge; "Support" with its icon at 1440, the icon
//      alone at 375, inside the viewport either way.
//   C  THE MENU: exactly Ask the assistant, Report a problem, Request a feature, Submit a ticket, My
//      requests, What's new, in that order. No "Live support" (stage 2 is a hidden flag).
//   D  THE FORMS: each opens the right form; a ticket has no severity question, says the 24-hour
//      promise, and posts kind "ticket" with no severity; a bug still posts its severity exactly as
//      the old widget did (main's portal keeps working).
//   E  THE ASSISTANT: the panel says it is an AI and that chats are saved; a question shows
//      "Thinking…", then the answer; a portal address in the answer is a link that navigates INSIDE
//      the portal (a foreign link stays plain text).
//   F  THE HAND-OFF: "Send this to our team" opens the ticket form already written, and submitting
//      it posts the chat's id.
//   G  MY REQUESTS and WHAT'S NEW land on /support/mine and /support/features; My Requests has a
//      Tickets filter and shows a ticket with its 🎫.
//   H  AT 375 the chat is a full-screen sheet.
//   I  SWITCH OFF (346, every builder by default): the old pill, exactly as before, and no Support
//      button; its menu is Report an Issue and Request a Feature only, and a bug posts the same
//      fields it always did. An `enabled` that errors (the live 340.2 knows no such action) leaves
//      the pill too.
//   J  SWITCHED OFF AFTER ON: a remembered "on" paints the button first; the server's "off" puts the
//      pill back and is remembered.
//
// Supabase is stubbed at the network layer: no login, nothing leaves the machine. support-agent's
// answers are canned here; the real agent is proved separately (agent_test.ts, the 20-question run).
//
//   python -m http.server 8867 --bind 127.0.0.1   (repo root, after npm run compile)
//   SS_BASE=http://127.0.0.1:8867 node tests/harness/supportMenu.mjs   (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/support-menu (SS_SHOTS overrides).
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { reporter, BASE, REF, shotsDir, serveAppRoutes } from "./lib.mjs";

const CLIENT = "harness-support";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: { full_name: "Pat Example" }, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const CONV = "00000000-0000-4000-8000-00000000c0c1";
const ANSWER = "You can change that on Settings > Company > Branding: /settings/branding. Not https://example.com/settings.";

const { ok, failed } = reporter();
const shots = shotsDir("support-menu");
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === "bundled" ? undefined : "chrome", headless: !process.env.HEADED });

// `on`: what support-agent's `enabled` answers (true, false, or "error" for a 400 like the live
// 340.2's). `remembered`: a "1"/"0" already in localStorage from an earlier load, or null.
async function openPortal(width, height, { on = true, remembered = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  await ctx.addInitScript(([ref, s, client, rem]) => {
    try {
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s));
      // Once per context: a reload must see what the page itself stored.
      if (rem !== null && !sessionStorage.getItem("seeded")) { localStorage.setItem(`ss:supportOn:${client}`, rem); sessionStorage.setItem("seeded", "1"); }
    } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION, CLIENT, remembered]);
  const page = await ctx.newPage();
  const state = { errors: [], feedback: [], agent: [] };
  page.on("pageerror", (e) => state.errors.push(e.message));
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/log_error")) return json(route, null);
    if (url.includes("/rest/v1/rpc/")) return json(route, false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/feedback_submissions")) {
      if (req.method() === "HEAD") return route.fulfill({ status: 200, headers: { ...H, "content-range": "0-1/2" }, body: "" });
      return json(route, [
        { id: "f1", kind: "ticket", title: "Help with my link", detail: "x", severity: null, status: "submitted", submitter_name: "Pat Example", attachment_path: null, monday_item_id: null, created_at: "2026-10-27T10:00:00Z", status_changed_at: null },
        { id: "f2", kind: "bug", title: "Door looks wrong", detail: "y", severity: "Medium", status: "in_review", submitter_name: "Pat Example", attachment_path: null, monday_item_id: "1", created_at: "2026-10-26T10:00:00Z", status_changed_at: null },
      ]);
    }
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null });
    if (url.includes("/support-agent")) {
      state.agent.push(body);
      if (body.action === "enabled") return on === "error" ? json(route, { error: "Unknown action." }, 400) : json(route, { ok: true, on });
      if (body.action === "status") return json(route, { ok: true, name: "Studio Assistant", replyPromise: "A person on our team replies within 24 hours.", available: true, unavailable: null, liveSupport: { available: false }, conversation: null });
      if (body.action === "send") {
        await new Promise((r) => setTimeout(r, 900));   // long enough to see "Thinking…"
        return json(route, {
          ok: true, conversationId: CONV,
          messages: [
            { id: "m1", role: "user", body: body.text, created_at: "2026-10-27T12:00:00Z" },
            { id: "m2", role: "assistant", body: ANSWER, created_at: "2026-10-27T12:00:05Z" },
          ],
          handoff: /broken/.test(body.text) ? { title: "Estimates not reaching customers", summary: "Estimates stopped arriving since Monday." } : null,
        });
      }
      return json(route, { ok: true });
    }
    if (url.includes("/portal-feedback")) {
      state.feedback.push(body);
      return json(route, { ok: true, submission: { id: "new1", kind: body.kind, title: body.title, status: "submitted" }, pushed: true });
    }
    if (url.includes("/portal-settings")) return json(route, { ok: true, clientId: CLIENT, role: "owner", access: null, prefs: null, configured: false, branding: {}, businessAddress: {} });
    return json(route, { ok: true });
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await serveAppRoutes(page);
  await page.goto(`${BASE}/orders`);
  await page.waitForSelector(".ss-topbar", { timeout: 20000 });
  await page.waitForTimeout(800);
  return { ctx, page, state };
}

const menuLabels = (page) => page.locator(".ss-sup-menu button .lb").allTextContents();

for (const [width, height, tag] of [[1440, 900, "1440"], [375, 812, "375"]]) {
  const { ctx, page, state } = await openPortal(width, height);

  // A — no floating pill, once the switch answers on (a first visit: nothing remembered yet).
  await page.waitForSelector(".ss-topbar .ss-sup-btn", { timeout: 10000 }).catch(() => {});
  const pill = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /Feedback/.test(b.textContent || "") && getComputedStyle(b).position === "fixed"));
  ok(`${tag} A: the floating Feedback pill is gone`, !pill);
  ok(`${tag} A: the portal asked support-agent's switch once`, state.agent.filter((b) => b.action === "enabled").length === 1, JSON.stringify(state.agent));
  ok(`${tag} A: the answer is remembered for the next load`, await page.evaluate((c) => localStorage.getItem(`ss:supportOn:${c}`), CLIENT) === "1");

  // B — the button.
  const btn = page.locator(".ss-topbar .ss-sup-btn");
  ok(`${tag} B: one Support button in the top bar`, (await btn.count()) === 1);
  const box = await btn.boundingBox();
  ok(`${tag} B: the button is inside the viewport`, box && box.x >= 0 && box.x + box.width <= width && box.y >= 0, JSON.stringify(box));
  const labelShown = await page.locator(".ss-sup-btn-t").isVisible();
  ok(`${tag} B: ${tag === "375" ? "icon only" : "icon and the word Support"}`, tag === "375" ? !labelShown : labelShown);
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector(".ss-topbar").children].map((n) => n.className || "");
    return { sup: kids.findIndex((c) => /ss-support/.test(c)), badge: kids.findIndex((c) => /tenant|ss-switch-wrap/.test(c)) };
  });
  ok(`${tag} B: before the tenant badge`, order.sup >= 0 && order.badge > order.sup, JSON.stringify(order));
  await page.screenshot({ path: join(shots, `${tag}-1-topbar.png`) });

  // C — the menu.
  await btn.click();
  await page.waitForSelector(".ss-sup-menu");
  const labels = await menuLabels(page);
  ok(`${tag} C: the six entries in order`, JSON.stringify(labels) === JSON.stringify(["Ask the assistant", "Report a problem", "Request a feature", "Submit a ticket", "My requests", "What's new"]), labels.join(" | "));
  ok(`${tag} C: no Live support entry (stage 2 hidden)`, !labels.includes("Live support"));
  const mbox = await page.locator(".ss-sup-menu").boundingBox();
  ok(`${tag} C: the menu fits the viewport`, mbox && mbox.x >= 0 && mbox.x + mbox.width <= width + 0.5, JSON.stringify(mbox));
  await page.screenshot({ path: join(shots, `${tag}-2-menu.png`) });

  // D — the forms.
  const openForm = async (label) => {
    if (!(await page.locator(".ss-sup-menu").count())) await btn.click();
    await page.locator(".ss-sup-menu button", { hasText: label }).click();
    await page.waitForSelector("[role=dialog] form");
  };
  const closeDialog = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(150); };

  await openForm("Report a problem");
  ok(`${tag} D: Report a problem opens the issue form`, await page.locator("[role=dialog]", { hasText: "Report an Issue" }).count() > 0);
  await page.locator("[role=dialog] input").first().fill("Door looks wrong");
  await page.locator("[role=dialog] button[type=submit]").click();
  await page.waitForSelector("text=we've got it");
  const bug = state.feedback.at(-1);
  ok(`${tag} D: a bug posts exactly as before (kind bug, its severity, no chat)`, bug && bug.kind === "bug" && bug.severity === "Medium" && !("supportConversationId" in bug), JSON.stringify(bug));
  ok(`${tag} D: the thank-you says a person replies within 24 hours`, await page.locator("[role=dialog]", { hasText: "within 24 hours" }).count() > 0);
  await page.screenshot({ path: join(shots, `${tag}-3-bug-done.png`) });
  await closeDialog();

  await openForm("Request a feature");
  ok(`${tag} D: Request a feature opens the feature form`, await page.locator("[role=dialog]", { hasText: "Request a Feature" }).count() > 0);
  await closeDialog();

  await openForm("Submit a ticket");
  const tdlg = page.locator("[role=dialog]", { hasText: "Submit a Ticket" });
  ok(`${tag} D: Submit a ticket opens the ticket form`, await tdlg.count() > 0);
  ok(`${tag} D: a ticket asks no severity`, (await tdlg.locator("select").count()) === 0);
  ok(`${tag} D: the ticket form states the 24-hour promise`, await tdlg.locator("text=A person on our team replies within 24 hours.").count() > 0);
  await page.screenshot({ path: join(shots, `${tag}-4-ticket-form.png`) });
  await tdlg.locator("input").first().fill("How do I share my link?");
  await tdlg.locator("button[type=submit]").click();
  await page.waitForSelector("text=we've got it");
  const tk = state.feedback.at(-1);
  ok(`${tag} D: a ticket posts kind ticket with no severity`, tk && tk.kind === "ticket" && !("severity" in tk), JSON.stringify(tk));
  await closeDialog();

  // E — the assistant.
  await btn.click();
  await page.locator(".ss-sup-menu button", { hasText: "Ask the assistant" }).click();
  await page.waitForSelector(".ss-sup-chat");
  ok(`${tag} E: the panel says it is an AI and that chats are saved`, await page.locator(".ss-sup-note", { hasText: "You are chatting with an AI assistant. Chats are saved so our team can follow up." }).count() === 1);
  ok(`${tag} E: titled Studio Assistant`, await page.locator(".ss-sup-title", { hasText: "Studio Assistant" }).count() === 1);
  const chatBox = await page.locator(".ss-sup-chat").boundingBox();
  if (tag === "375") {
    ok(`${tag} H: the chat is a full-screen sheet`, chatBox && Math.round(chatBox.x) === 0 && Math.round(chatBox.y) === 0 && Math.round(chatBox.width) === width && Math.round(chatBox.height) === height, JSON.stringify(chatBox));
  } else {
    ok(`${tag} E: about 400 x 620, under the button`, chatBox && Math.round(chatBox.width) === 400 && chatBox.height >= 600 && chatBox.height <= 620 && chatBox.y >= 60, JSON.stringify(chatBox));
  }
  await page.screenshot({ path: join(shots, `${tag}-5-chat-empty.png`) });
  await page.locator(".ss-sup-form textarea").fill("Where do I change my logo?");
  await page.locator(".ss-sup-form button[type=submit]").click();
  ok(`${tag} E: "Thinking…" while it answers`, await page.locator(".ss-sup-muted", { hasText: "Thinking…" }).waitFor({ timeout: 2000 }).then(() => true, () => false));
  await page.screenshot({ path: join(shots, `${tag}-6-thinking.png`) });
  await page.locator(".ss-sup-bot", { hasText: "Settings > Company > Branding" }).waitFor({ timeout: 5000 });
  const links = await page.locator(".ss-sup-bot a.ss-sup-link").evaluateAll((as) => as.map((a) => ({ text: a.textContent, href: a.getAttribute("href") })));
  ok(`${tag} E: the portal address is a link`, links.length === 1 && links[0].text === "/settings/branding", JSON.stringify(links));
  ok(`${tag} E: the foreign URL stays plain text`, !links.some((l) => /example\.com/.test(l.text)));
  await page.screenshot({ path: join(shots, `${tag}-7-answer.png`) });
  const sent = state.agent.find((b) => b.action === "send");
  ok(`${tag} E: the question went to support-agent as text only`, sent && sent.text === "Where do I change my logo?" && !sent.targetClientId, JSON.stringify(sent));

  // F — the hand-off.
  await page.locator(".ss-sup-form textarea").fill("my estimates are broken");
  await page.locator(".ss-sup-form button[type=submit]").click();
  await page.locator(".ss-sup-card", { hasText: "Send this to our team?" }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(shots, `${tag}-8-handoff-card.png`) });
  await page.locator(".ss-sup-card button").click();
  const hdlg = page.locator("[role=dialog]", { hasText: "Submit a Ticket" });
  await hdlg.waitFor();
  ok(`${tag} F: the ticket opens already written`, (await hdlg.locator("input").first().inputValue()) === "Estimates not reaching customers"
    && /stopped arriving/.test(await hdlg.locator("textarea").first().inputValue()));
  ok(`${tag} F: and says the chat is attached`, await hdlg.locator("text=Your chat with the assistant is attached").count() > 0);
  await page.screenshot({ path: join(shots, `${tag}-9-handoff-ticket.png`) });
  await hdlg.locator("button[type=submit]").click();
  await page.waitForSelector("text=we've got it");
  const ht = state.feedback.at(-1);
  ok(`${tag} F: the hand-off ticket carries the chat id`, ht && ht.kind === "ticket" && ht.supportConversationId === CONV, JSON.stringify(ht));
  await closeDialog();
  if (await page.locator(".ss-sup-chat").count()) await page.locator(".ss-sup-x").click();

  // The link navigates inside the portal (fresh chat with the answer, then click it).
  await btn.click();
  await page.locator(".ss-sup-menu button", { hasText: "Ask the assistant" }).click();
  await page.locator(".ss-sup-form textarea").fill("logo?");
  await page.locator(".ss-sup-form button[type=submit]").click();
  await page.locator(".ss-sup-bot a.ss-sup-link").first().waitFor({ timeout: 5000 });
  await page.locator(".ss-sup-bot a.ss-sup-link").first().click();
  await page.waitForTimeout(600);
  ok(`${tag} E: clicking it navigates inside the portal`, new URL(page.url()).pathname === "/settings/branding", page.url());
  if (await page.locator(".ss-sup-chat").count()) await page.locator(".ss-sup-x").click();

  // G — My requests and What's new.
  await btn.click();
  await page.locator(".ss-sup-menu button", { hasText: "My requests" }).click();
  await page.waitForTimeout(800);
  ok(`${tag} G: My requests lands on /support/mine`, new URL(page.url()).pathname === "/support/mine", page.url());
  ok(`${tag} G: My Requests has a Tickets filter`, await page.locator("button", { hasText: "🎫 Tickets" }).count() === 1);
  ok(`${tag} G: a ticket shows its 🎫`, await page.locator("td", { hasText: "Help with my link" }).filter({ hasText: "🎫" }).count() === 1);
  await page.screenshot({ path: join(shots, `${tag}-10-my-requests.png`) });
  await btn.click();
  await page.locator(".ss-sup-menu button", { hasText: "What's new" }).click();
  await page.waitForTimeout(600);
  ok(`${tag} G: What's new lands on /support/features`, new URL(page.url()).pathname === "/support/features", page.url());

  ok(`${tag}: no page errors`, state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// I and J — the switch off.
const pillState = (page) => page.evaluate(() => {
  const p = [...document.querySelectorAll("button")].find((b) => /Feedback/.test(b.textContent || "") && getComputedStyle(b).position === "fixed");
  return { pill: p ? p.textContent.trim() : null, support: document.querySelectorAll(".ss-topbar .ss-sup-btn").length };
});
for (const [width, height, tag] of [[1440, 900, "1440"], [375, 812, "375"]]) {
  const { ctx, page, state } = await openPortal(width, height, { on: false });
  await page.waitForTimeout(4500);   // past the 3.5 s ask and its answer
  const s = await pillState(page);
  ok(`${tag} I: switched off, the old pill shows and no Support button`, s.pill === "💬 Feedback" && s.support === 0, JSON.stringify(s));
  ok(`${tag} I: the switch was asked once`, state.agent.filter((b) => b.action === "enabled").length === 1 && state.agent.length === 1, JSON.stringify(state.agent));
  await page.screenshot({ path: join(shots, `${tag}-11-switch-off-pill.png`) });
  await page.getByRole("button", { name: "Send feedback" }).click();
  const kinds = await page.locator("[role=dialog] button span span:first-child").allTextContents();
  ok(`${tag} I: the pill's menu is Report an Issue and Request a Feature, as before`, JSON.stringify(kinds) === JSON.stringify(["Report an Issue", "Request a Feature"]), kinds.join(" | "));
  await page.screenshot({ path: join(shots, `${tag}-12-switch-off-pill-menu.png`) });
  await page.locator("[role=dialog] button", { hasText: "Report an Issue" }).click();
  await page.locator("[role=dialog] input").first().fill("Door looks wrong");
  await page.locator("[role=dialog] button[type=submit]").click();
  await page.waitForSelector("text=we've got it");
  const bug = state.feedback.at(-1);
  ok(`${tag} I: a bug from the pill posts the fields it always did`,
    bug && JSON.stringify(Object.keys(bug).sort()) === JSON.stringify(["action", "attachmentPath", "detail", "kind", "severity", "title"]) && bug.kind === "bug" && bug.severity === "Medium",
    JSON.stringify(bug));
  ok(`${tag} I: the pill's thank-you is the old one`, await page.locator("[role=dialog]", { hasText: "Your request is logged and on our board. You can follow it under" }).count() === 1);
  ok(`${tag} I: no page errors`, state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
  await ctx.close();
}
{
  const { ctx, page, state } = await openPortal(1440, 900, { on: "error" });
  await page.waitForTimeout(4500);
  const s = await pillState(page);
  ok("1440 I: an `enabled` that errors (the live 340.2) leaves the pill", s.pill === "💬 Feedback" && s.support === 0 && state.errors.length === 0, JSON.stringify(s));
  await ctx.close();
}
{
  const { ctx, page, state } = await openPortal(1440, 900, { on: false, remembered: "1" });
  const first = await pillState(page);
  ok("1440 J: a remembered on paints the Support button first", first.support === 1 && first.pill === null, JSON.stringify(first));
  await page.waitForTimeout(4500);
  const after = await pillState(page);
  ok("1440 J: the server's off puts the pill back", after.pill === "💬 Feedback" && after.support === 0, JSON.stringify(after));
  ok("1440 J: …and remembers it", await page.evaluate((c) => localStorage.getItem(`ss:supportOn:${c}`), CLIENT) === "0");
  ok("1440 J: no page errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
const f = failed();
console.log(f.length ? `\n${f.length} CHECK(S) FAILED — shots in ${shots}` : `\nALL CHECKS PASSED — shots in ${shots}`);
process.exit(f.length ? 1 : 0);
