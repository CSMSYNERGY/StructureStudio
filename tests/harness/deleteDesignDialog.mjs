// The Delete design dialog (Designs → ⋯ → Delete design), driven for real on the COMPILED portal
// (2026-10-05, "Deleting a design is not deleting the estimate").
//
//   A. a StructureStudio quote nobody invoiced: the dialog names the quote, says it and its PDF are
//      also deleted and that the customer's emailed link stops working, and no longer says "No
//      estimate has been created in your CRM"
//   B. a StructureStudio quote with an invoice sent, the design still 'accepted' (migration 136):
//      the dialog says the quote and its PDF are KEPT and the invoice stays, and does not promise
//      "the saved PDFs"; the typed confirmation is unchanged
//   C. an invoiced quote: kept, the same way
//   D. a CRM estimate: the CRM sentence exactly as before, and no quote sentence
//   E. a design with neither: one plain sentence
//   F. the dialog and the server agree: for every design above, what the dialog promised is what
//      the server's REAL rule (invoiceExists + removeDesignObjects from _shared/designStorageKeys.ts,
//      run here against an in-memory bucket) does to the quote PDF, and the invoice PDF survives
//   G. Delete sends the same body as before (deleteEstimate:true; confirmToken only past Sent, and
//      it is the short code when there is no CRM estimate number)
//   H. after the delete, the message names what happened to the quote; against a server older than
//      this page (no `quote` in the answer) it reads exactly as before
//   I. at a phone's width the dialog adds no sideways scroll
//   K. a design with BOTH an old CRM estimate and an invoiced StructureStudio quote: the dialog says
//      the estimate is still deleted from the CRM (a StructureStudio invoice was not made from it)
//      and the quote is kept; the server does exactly that (crmInvoiceExists / invoiceExists), and
//      the message after the delete names both
//   L. a storage remove that fails: the message says the quote's PDF could not be removed, as an
//      error, instead of a plain "Deleted design"
//
// Supabase is stubbed at the network layer; nothing leaves the machine, nothing is deleted anywhere
// but the stub's own in-memory bucket, and NO CRM IS CALLED.
//
//   python -m http.server 8125 --bind 127.0.0.1   (repo root)
//   node tests/harness/deleteDesignDialog.mjs       (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/delete-design-dialog (SS_SHOTS overrides). SS_PORTAL_ARTIFACT=<an
// older portal.app.compiled.js> serves that file instead, which is how to prove the checks can fail:
// against the artifact before this change (4dc78fc) 15 fail, A1-A5, B1, B2, C1, E1, E2, H1, H2, K2, K3
// and L1. K1 holds there (that dialog keyed the CRM sentence on status alone, which is right); it
// fails against a dialog that keys it on the wider StructureStudio-invoice rule.
// The F checks run the server's rule, which that variable does not swap.
//
// Fixtures are made up (example.test, a made-up tenant), per the public-repo rule.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launch, reporter, BASE, REF, shotsDir } from "./lib.mjs";
import { crmInvoiceExists, invoiceExists, removeDesignObjects } from "../../supabase/functions/_shared/designStorageKeys.ts";

const CLIENT = "acme-sheds";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
const USER = { id: "00000000-0000-4000-8000-000000000004", aud: "authenticated", role: "authenticated", email: "owner@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
const STORAGE = "https://stub.supabase.co/storage/v1/object/public/floor-plans/";

const row = (code, name, over = {}) => ({
  short_code: code, created_at: "2026-09-20T15:00:00Z", updated_at: "2026-09-20T15:00:00Z", status: "sent",
  contact: { name, email: `${name.split(" ")[0].toLowerCase()}@example.test` }, contact_id: null,
  sel_style: "Utility", sel_size: "10x12", ghl_estimate_number: null, inventory_unit_id: null,
  image_url: `${STORAGE}${CLIENT}/${code}-1790000000000.pdf`, ss_quote_number: null, ss_quote_pdf_url: null,
  ss_invoice_sent_at: null, total_cents: 900000, expected_close_date: null, ...over,
});
const ssQuote = (code, n) => ({ ss_quote_number: n, ss_quote_pdf_url: `${STORAGE}${CLIENT}/${code}-quote.pdf` });

// Each case: the row, the invoice ledger the server holds for it, and what the dialog must say.
const CASES = {
  A: { row: row("SS-QTEAAA22", "Avery Quote", ssQuote("SS-QTEAAA22", "SST-1001")), ledger: null },
  B: { row: row("SS-QTEBBB22", "Blake Invoiced", { status: "accepted", ss_invoice_sent_at: "2026-10-01T12:00:00Z", ...ssQuote("SS-QTEBBB22", "SST-1002") }),
       ledger: { invoice_id: null, invoice_number: "SSI-2001", invoice_pdf_url: `${STORAGE}${CLIENT}/SS-QTEBBB22-invoice.pdf`, status: "sent" } },
  C: { row: row("SS-QTECCC22", "Casey Delivered", { status: "invoiced", ...ssQuote("SS-QTECCC22", "SST-1003") }),
       ledger: { invoice_id: null, invoice_number: "SSI-2002", invoice_pdf_url: `${STORAGE}${CLIENT}/SS-QTECCC22-invoice.pdf`, status: "sent" } },
  D: { row: row("SS-GHLDDD22", "Dana Crm", { ghl_estimate_number: 5012 }), ledger: null },
  E: { row: row("SS-NONEEE22", "Emery Draft", { status: "draft", image_url: null }), ledger: null },
  K: { row: row("SS-BOTHKK22", "Kit Both", { status: "accepted", ghl_estimate_number: 5013, ss_invoice_sent_at: "2026-10-01T12:00:00Z", ...ssQuote("SS-BOTHKK22", "SST-1004") }),
       ledger: { invoice_id: null, invoice_number: "SSI-2004", invoice_pdf_url: `${STORAGE}${CLIENT}/SS-BOTHKK22-invoice.pdf`, status: "sent" } },
  L: { row: row("SS-FAILLL22", "Lou Leftover", ssQuote("SS-FAILLL22", "SST-1005")), ledger: null, removeFails: true },
};

// The in-memory bucket the stub's delete_design acts on: every shape a design writes, per design.
const bucket = new Set();
for (const { row: r } of Object.values(CASES)) {
  for (const tail of ["-1790000000000.pdf", "-plan-1790000000000.jpg", "-3d-1790000000000.jpg", "-quote.pdf", "-invoice.pdf"]) {
    bucket.add(`${CLIENT}/${r.short_code}${tail}`);
  }
}
const storage = {
  from: () => ({
    list: (path, o = {}) => {
      const want = `${path}/${o.search || ""}`.toLowerCase();
      const names = [...bucket].filter((k) => k.toLowerCase().startsWith(want)).map((k) => k.slice(path.length + 1));
      return Promise.resolve({ data: names.map((name) => ({ name })), error: null });
    },
    remove: (keys) => Promise.resolve({ data: keys.filter((k) => bucket.delete(k)).map((name) => ({ name })), error: null }),
  }),
};

/** delete_design as portal-settings answers it: the token rule, then the REAL storage rules. */
async function deleteDesign(body, server) {
  const c = Object.values(CASES).find((x) => x.row.short_code === body.shortCode);
  if (!c) return { status: 404, body: { error: "Design not found (or not yours)." } };
  const r = c.row;
  const st = ["sent", "accepted", "invoiced", "delivered"].includes(r.status) ? r.status : "sent";
  const expected = r.ghl_estimate_number ? String(r.ghl_estimate_number) : r.short_code;
  if (st !== "sent" && String(body.confirmToken || "").trim() !== expected) {
    return { status: 409, body: { error: `This design is ${st} — a billing record. Type "${expected}" to confirm deletion.`, needsConfirm: true, expected, status: st } };
  }
  const invoiced = invoiceExists(st, c.ledger, r.ss_invoice_sent_at);
  // A bucket whose remove fails, for case L; listing still works.
  const store = !c.removeFails ? storage : { from: (b) => ({ ...storage.from(b), remove: () => Promise.resolve({ data: null, error: { message: "remove failed" } }) }) };
  const files = await removeDesignObjects(store, {
    clientId: CLIENT, shortCode: r.short_code, legacyOk: false, invoiced,
    storedUrls: [r.image_url], hasQuoteDoc: Boolean(r.ss_quote_pdf_url),
  });
  c.outcome = files.quote;
  // The CRM half, by the server's own rule. NO CRM IS CALLED: "deleted" is what the server would
  // report, and c.crm records that the stub would have sent the DELETE.
  const estimate = !(r.ghl_estimate_number && body.deleteEstimate === true) ? "none" : crmInvoiceExists(st, c.ledger) ? "skipped_invoiced" : "deleted";
  c.crm = estimate;
  const base = { ok: true, shortCode: r.short_code, versionsDeleted: 1, filesRemoved: files.filesRemoved, filesKept: 0, estimate, estimateNumber: r.ghl_estimate_number, estimateError: null };
  if (server === "old") return { status: 200, body: base };
  return { status: 200, body: { ...base, estimateAlreadyGone: false, quote: files.quote, quotePdfKept: files.quote === "kept", quoteNumber: r.ss_quote_number } };
}

const { ok, failed } = reporter();
const shots = shotsDir("delete-design-dialog");
const pageErrors = [];
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const SENDS = ["email_send_test", "resend_quote_email", "send_invoice", "reissue_invoice", "crm_send_email"];

async function scenario(browser, { name, server = "new", viewport = { width: 1400, height: 1000 } }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const calls = [];
  const outside = [];
  await ctx.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => { outside.push(route.request().url()); return route.abort(); });
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/is_operator")) return json(route, false);
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "owner", user_id: USER.id }]);
    if (url.includes("/rest/v1/designs")) return json(route, Object.values(CASES).filter((c) => !c.deleted).map((c) => c.row));
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (url.includes("leadconnectorhq")) { outside.push(url); return route.abort(); }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    calls.push(body);
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "owner", operatorMode: false, access: null, prefs: { designsView: "list" },
          phoneStatus: "off", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: "Acme Sheds" }, emailReady: true });
      case "delete_design": {
        const out = await deleteDesign(body, server);
        if (out.status === 200) Object.values(CASES).find((c) => c.row.short_code === body.shortCode).deleted = true;
        return json(route, out.body, out.status);
      }
      default: return json(route, { ok: true });
    }
  };
  await ctx.route(`**/${REF}.supabase.co/**`, handler);
  await ctx.route(`**/${REF}.functions.supabase.co/**`, handler);
  if (process.env.SS_PORTAL_ARTIFACT) {
    const src = readFileSync(process.env.SS_PORTAL_ARTIFACT, "utf8");
    await ctx.route(/portal\.app\.compiled\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: src }));
  }
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => { history.pushState({}, "", "/portal/designs"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForFunction(() => document.body.innerText.includes("Avery Quote"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { ctx, page, calls, outside };
}

const dialog = (page) => page.locator('[role="dialog"]').filter({ has: page.locator("#del-design-ttl") });
const dialogText = (page) => dialog(page).innerText({ timeout: 3000 }).catch(() => "");
async function openDelete(page, name) {
  // Scroll FIRST and let the scroll events land: RowMenu closes itself on any scroll (capture
  // phase), so a click that scrolls the row into view can open the menu and shut it again on the
  // same frame. A person scrolls, then taps; this does the same.
  const more = page.getByRole("button", { name: `More actions for ${name}` }).first();
  await more.scrollIntoViewIfNeeded({ timeout: 5000 });
  await page.waitForTimeout(250);
  await more.click({ timeout: 5000 });
  await page.getByRole("menuitem", { name: "Delete design" }).click({ timeout: 5000 });
  await dialog(page).waitFor({ timeout: 5000 });
  return dialogText(page);
}
const closeDialog = async (page) => { await dialog(page).getByRole("button", { name: "Cancel" }).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(150); };
const pressDelete = (page) => dialog(page).getByRole("button", { name: "Delete design" }).click({ timeout: 3000 });
const waitText = (page, s, timeout = 8000) => page.waitForFunction((x) => document.body.innerText.includes(x), s, { timeout }).then(() => true, () => false);
const OLD_CRM_NONE = "No estimate has been created in your CRM for this design.";

const { browser } = await launch({ width: 1400, height: 1000 });
try {
  {
    const s = await scenario(browser, { name: "main" });
    const listed = ok("A0 the Designs list rendered all seven designs",
      await waitText(s.page, "Emery Draft", 15000) && (await s.page.getByRole("button", { name: /More actions for / }).count()) >= 7);
    if (!listed) throw new Error("the Designs list never rendered; refusing to report the rest as passes");

    // ── A. An uninvoiced StructureStudio quote ──
    let t = await openDelete(s.page, "Avery Quote");
    ok("A1 the dialog names the quote beside the customer", /Avery Quote\s*·\s*SST-1001\s*·\s*Sent/.test(t), t.slice(0, 200));
    ok("A2 it says the quote and its PDF are also deleted", t.includes("Estimate SST-1001 and its PDF are also deleted."), t);
    ok("A3 and that the customer's emailed link stops working", /The link in the customer's\s+estimate email will stop working\./.test(t), t);
    ok("A4 it no longer says no estimate exists", !t.includes(OLD_CRM_NONE), t);
    ok("A5 the general line promises the PDFs and pictures", t.includes("and the saved PDFs and pictures. This cannot be undone."), t);
    await dialog(s.page).screenshot({ path: join(shots, "A-uninvoiced-quote.png") }).catch(() => {});
    await closeDialog(s.page);

    // ── B. A StructureStudio invoice sent, the design still 'accepted' ──
    t = await openDelete(s.page, "Blake Invoiced");
    ok("B1 the quote and its PDF are kept, and the invoice stays",
      /Estimate SST-1002 and its PDF are kept, because an invoice was made from it\.\s*The invoice stays too\./.test(t), t);
    ok("B2 it does not promise the saved PDFs go", !t.includes("the saved PDFs") && t.includes("its floor plans and pictures. This cannot be undone."), t);
    ok("B3 the typed confirmation is unchanged (the short code, no CRM number)", /Type SS-QTEBBB22 to confirm/i.test(t), t);
    await dialog(s.page).screenshot({ path: join(shots, "B-ss-invoice-sent.png") }).catch(() => {});
    await closeDialog(s.page);

    // ── C. Invoiced ──
    t = await openDelete(s.page, "Casey Delivered");
    ok("C1 an invoiced quote is kept the same way", t.includes("Estimate SST-1003 and its PDF are kept, because an invoice was made from it."), t);
    await closeDialog(s.page);

    // ── D. A CRM estimate, as before ──
    t = await openDelete(s.page, "Dana Crm");
    ok("D1 the CRM sentence is exactly as before",
      /EST-5012 is also deleted from your CRM\. The customer and their\s+opportunity stay — only the estimate goes\./.test(t), t);
    ok("D2 and no quote sentence", !/Estimate .* and its PDF/.test(t), t);
    await closeDialog(s.page);

    // ── E. Neither ──
    t = await openDelete(s.page, "Emery Draft");
    ok("E1 a design with neither says so plainly", t.includes("No estimate has been made for this design yet."), t);
    ok("E2 and not the old CRM-only wording", !t.includes(OLD_CRM_NONE), t);
    await closeDialog(s.page);

    // ── G + H + F. Delete A (single confirm), then B (typed) ──
    s.calls.length = 0;
    await openDelete(s.page, "Avery Quote");
    await pressDelete(s.page);
    const saidA = await waitText(s.page, "Deleted design SS-QTEAAA22. Estimate SST-1001 and its PDF were deleted too.");
    const delA = s.calls.filter((c) => c.action === "delete_design");
    ok("G1 Delete sends the same body as before for a Sent design",
      delA.length === 1 && delA[0].shortCode === "SS-QTEAAA22" && delA[0].deleteEstimate === true && !("confirmToken" in delA[0]), JSON.stringify(delA));
    ok("H1 the message says the quote and its PDF went", saidA);
    ok("F1 the server removed the quote PDF the dialog said would go", CASES.A.outcome === "removed" && !bucket.has(`${CLIENT}/SS-QTEAAA22-quote.pdf`));
    ok("F2 and kept that design's invoice PDF and every other design's files",
      bucket.has(`${CLIENT}/SS-QTEAAA22-invoice.pdf`) && bucket.has(`${CLIENT}/SS-QTEBBB22-quote.pdf`) && bucket.has(`${CLIENT}/SS-QTEBBB22-plan-1790000000000.jpg`));
    ok("F3 and every picture of the deleted design is gone",
      !bucket.has(`${CLIENT}/SS-QTEAAA22-plan-1790000000000.jpg`) && !bucket.has(`${CLIENT}/SS-QTEAAA22-3d-1790000000000.jpg`));
    await s.page.screenshot({ path: join(shots, "H-deleted-message.png") }).catch(() => {});

    s.calls.length = 0;
    await openDelete(s.page, "Blake Invoiced");
    await dialog(s.page).locator("input").fill("SS-QTEBBB22");
    await pressDelete(s.page);
    const saidB = await waitText(s.page, "Deleted design SS-QTEBBB22. Estimate SST-1002 and its PDF were kept, because an invoice was made from it.");
    const delB = s.calls.filter((c) => c.action === "delete_design");
    ok("G2 a typed confirmation sends the short code as the token", delB.length === 1 && delB[0].confirmToken === "SS-QTEBBB22" && delB[0].deleteEstimate === true, JSON.stringify(delB));
    ok("H2 the message says the quote was kept", saidB);
    ok("F4 the server kept the quote PDF the dialog said would stay", CASES.B.outcome === "kept" && bucket.has(`${CLIENT}/SS-QTEBBB22-quote.pdf`) && bucket.has(`${CLIENT}/SS-QTEBBB22-invoice.pdf`));

    // F5: the remaining promises against the server's rule, without deleting through the page.
    for (const k of ["C", "D", "E"]) {
      const c = CASES[k];
      const st = ["sent", "accepted", "invoiced", "delivered"].includes(c.row.status) ? c.row.status : "sent";
      const keeps = invoiceExists(st, c.ledger, c.row.ss_invoice_sent_at);
      const said = k === "C" ? "kept" : k === "D" ? "crm" : "none";
      ok(`F5${k} the dialog's promise matches the server's gate`, (said === "kept") === (keeps && !!c.row.ss_quote_number), `${said} vs invoiceExists=${keeps}`);
    }
    // ── K. An old CRM estimate AND an invoiced StructureStudio quote ──
    t = await openDelete(s.page, "Kit Both");
    ok("K1 the CRM estimate is still deleted (a StructureStudio invoice was not made from it)",
      /EST-5013 is also deleted from your CRM\./.test(t) && !t.includes("EST-5013 is kept"), t);
    ok("K2 and the quote is kept", t.includes("Estimate SST-1004 and its PDF are kept, because an invoice was made from it."), t);
    await dialog(s.page).screenshot({ path: join(shots, "K-crm-estimate-and-ss-invoice.png") }).catch(() => {});
    await dialog(s.page).locator("input").fill("5013");
    await pressDelete(s.page);
    const saidK = await waitText(s.page, "Deleted design SS-BOTHKK22, along with EST-5013 in your CRM. Estimate SST-1004 and its PDF were kept, because an invoice was made from it.");
    ok("K3 the message names both halves", saidK);
    ok("K4 the server did what the dialog said: the estimate went, the quote PDF stayed",
      CASES.K.crm === "deleted" && CASES.K.outcome === "kept" && bucket.has(`${CLIENT}/SS-BOTHKK22-quote.pdf`), `${CASES.K.crm} / ${CASES.K.outcome}`);

    // ── L. A storage remove that fails ──
    s.calls.length = 0;
    await openDelete(s.page, "Lou Leftover");
    await pressDelete(s.page);
    const saidL = await waitText(s.page, "Deleted design SS-FAILLL22. The PDF for Estimate SST-1005 could not be removed. Support has a record of it.");
    ok("L1 a failed remove says the quote's PDF is still there", saidL && CASES.L.outcome === "failed", String(CASES.L.outcome));
    await s.page.screenshot({ path: join(shots, "L-remove-failed.png") }).catch(() => {});

    ok("H0 nothing on this screen sends anything or reaches a CRM",
      !s.calls.some((c) => SENDS.includes(c.action)) && !s.outside.some((u) => /leadconnectorhq/.test(u)), JSON.stringify(s.outside.slice(0, 5)));
    await s.ctx.close();
  }

  // ── H3. A server older than this page: no `quote` in the answer, the message as before ──
  {
    for (const c of Object.values(CASES)) delete c.deleted;
    bucket.add(`${CLIENT}/SS-QTEAAA22-quote.pdf`);
    const s = await scenario(browser, { name: "old-server", server: "old" });
    await waitText(s.page, "Avery Quote", 15000);
    await openDelete(s.page, "Avery Quote");
    await pressDelete(s.page);
    const said = await waitText(s.page, "Deleted design SS-QTEAAA22.");
    const body = await s.page.evaluate(() => document.body.innerText);
    ok("H3 an older server's answer reads exactly as before", said && !body.includes("Estimate SST-1001 and its PDF were"), body.slice(0, 300));
    await s.ctx.close();
  }

  // ── I. Phone width ──
  {
    for (const c of Object.values(CASES)) delete c.deleted;
    const s = await scenario(browser, { name: "phone", viewport: { width: 390, height: 844 } });
    await waitText(s.page, "Blake Invoiced", 15000);
    const opened = await openDelete(s.page, "Blake Invoiced").catch((e) => { console.log("phone open failed:", String(e).slice(0, 1500)); return ""; });
    const m = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    const box = await dialog(s.page).boundingBox().catch(() => null);
    ok("I1 the dialog fits a phone with no sideways scroll", !!opened && m.sw <= m.cw && box && box.x >= 0 && box.x + box.width <= m.cw + 1, JSON.stringify({ ...m, box }));
    await s.page.screenshot({ path: join(shots, "I-phone.png") }).catch(() => {});
    await s.ctx.close();
  }

  ok("Z no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(`\nshots: ${shots}`);
const bad = failed();
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : "\nall checks held");
process.exit(bad.length ? 1 : 0);
