// The SENDERS of the document emails, checked against the shipped source (2026-10-04).
//
// emailTemplates.test.ts proves the templates use the builder's wording when they are handed it.
// That was never the problem: until 2026-10-04 the invoice senders and the quote re-send handed
// over nothing, so saved invoice wording never reached a customer, a re-sent quote said other
// words than the first send, and {customer} filled blank everywhere ("Hi , ..."). These checks
// read portal-settings and submit-estimate as text and hold every estimateEmail / invoiceEmail
// call to the rule:
//   • it passes templateCopy, taken from email_template_copy, and the client_settings read that
//     value comes from actually selects that column (a select without it hands over undefined,
//     which looks exactly like "no wording saved");
//   • it passes customerName, from the design's contact;
//   • a quote/estimate send passes pictureUrl as well.
// The call COUNT is pinned too: a new sender added later fails here until it is held to the
// same rule, which is the point. Also pinned: the Preview action's gate, and the editor's limits
// and sandboxed preview frame in the portal.
//
// Needs read access to the repo (preflight grants --allow-read=<repo>); no network.
import { TEMPLATE_LIMITS } from "./emailTemplates.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");
const PORTAL_SETTINGS = read("../portal-settings/index.ts");
const SUBMIT_ESTIMATE = read("../submit-estimate/index.ts");
const EDITOR = read("../../../portal/08-integrations.jsx");

/** The source of a call's argument list, from its "(" to the matching ")", skipping comments,
 *  strings and template literals so an apostrophe in a comment or a "(PDF)" in a string can't
 *  confuse the count. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return src.slice(openParen, i + 1);
  }
  throw new Error(`unbalanced call at ${openParen}`);
}

/** Every call `name(` that is not the import or the definition, with its arguments. */
function calls(src: string, name: string): { at: number; args: string; line: number }[] {
  const out: { at: number; args: string; line: number }[] = [];
  const re = new RegExp(`(?<![\\w$])${name}\\(`, "g");
  for (const m of src.matchAll(re)) {
    const at = m.index!;
    const before = src.slice(Math.max(0, at - 9), at);
    if (/function\s$/.test(before)) continue;
    // obj.name( is somebody else's method; ...name( is a spread of this one's result.
    if (before.endsWith(".") && !before.endsWith("...")) continue;
    out.push({ at, args: callArgs(src, at + name.length), line: src.slice(0, at).split("\n").length });
  }
  return out;
}

/** The `.select("…")` of the client_settings read that declares `root`, searching back from `at`. */
function settingsSelectFor(src: string, root: string, at: number): string | null {
  const decl = new RegExp(`(?:data:\\s*${root}\\b|const\\s+${root}\\b|\\b${root}\\s*\\]\\s*=)`, "g");
  let declAt = -1;
  for (const m of src.matchAll(decl)) if (m.index! < at) declAt = m.index!;
  if (declAt < 0) return null;
  const from = src.indexOf('.from("client_settings")', declAt);
  if (from < 0 || from > at) return null;
  const sel = /\.select\("([^"]*)"\)/.exec(src.slice(from, at));
  return sel ? sel[1] : null;
}

function checkSender(file: string, src: string, c: { at: number; args: string; line: number }, needsPicture: boolean) {
  const where = `${file}:${c.line}`;
  const tc = /templateCopy:\s*([A-Za-z_$][\w$]*)[^,\n]*email_template_copy\s*,/.exec(c.args);
  assert(tc, `${where}: this send passes no templateCopy taken from email_template_copy, so the builder's saved wording never reaches the customer`);
  const sel = settingsSelectFor(src, tc[1], c.at);
  assert(sel !== null, `${where}: couldn't find the client_settings read that declares ${tc[1]} — re-anchor this test`);
  assert(/\bemail_template_copy\b/.test(sel), `${where}: ${tc[1]} comes from a client_settings select without email_template_copy: "${sel}"`);
  assert(/customerName:\s*[^\n]*contact[^\n]*name/.test(c.args), `${where}: this send passes no customerName from the contact, so {customer} fills blank`);
  if (needsPicture) assert(/pictureUrl:/.test(c.args), `${where}: this quote/estimate send passes no pictureUrl, so it can't show the building photo`);
}

Deno.test("every document-email sender passes the builder's wording, the customer's name and (quotes) the photo", () => {
  const ps = { est: calls(PORTAL_SETTINGS, "estimateEmail"), inv: calls(PORTAL_SETTINGS, "invoiceEmail") };
  const se = { est: calls(SUBMIT_ESTIMATE, "estimateEmail"), inv: calls(SUBMIT_ESTIMATE, "invoiceEmail") };
  // 1 quote re-send (sendQuoteEmail) + 4 invoice sends (reissue, the email retry, the first SS
  // send, the CRM path's own-domain send); 2 first sends in the designer (SS quote, CRM estimate).
  // A different count means a sender was added or removed: hold it to the rule, then update this.
  assert(ps.est.length === 1, `portal-settings: expected 1 estimateEmail call, found ${ps.est.length}`);
  assert(ps.inv.length === 4, `portal-settings: expected 4 invoiceEmail calls, found ${ps.inv.length}`);
  assert(se.est.length === 2, `submit-estimate: expected 2 estimateEmail calls, found ${se.est.length}`);
  assert(se.inv.length === 0, `submit-estimate: expected no invoiceEmail call, found ${se.inv.length}`);
  for (const c of ps.est) checkSender("portal-settings", PORTAL_SETTINGS, c, true);
  for (const c of ps.inv) checkSender("portal-settings", PORTAL_SETTINGS, c, false);
  for (const c of se.est) checkSender("submit-estimate", SUBMIT_ESTIMATE, c, true);
});

Deno.test("the checks above bite: a send without the wording, the name or the column is reported", () => {
  const src = `const { data: cs } = await admin.from("client_settings").select("business_name").eq("x", 1);\n` +
    `const a = invoiceEmail({ templateCopy: cs.email_template_copy, customerName: String(c.contact.name), total: 1 });\n` +
    `const b = invoiceEmail({ total: 1 });\n`;
  const [a, b] = calls(src, "invoiceEmail");
  let msg = "";
  try { checkSender("fixture", src, a, false); } catch (e) { msg = (e as Error).message; }
  assert(/without email_template_copy/.test(msg), `a select missing the column must be reported, got: ${msg}`);
  msg = "";
  try { checkSender("fixture", src, b, false); } catch (e) { msg = (e as Error).message; }
  assert(/passes no templateCopy/.test(msg), `a send with no wording must be reported, got: ${msg}`);
  const ok = src.replace('select("business_name")', 'select("business_name, email_template_copy")');
  checkSender("fixture", ok, calls(ok, "invoiceEmail")[0], false);
  msg = "";
  try { checkSender("fixture", ok, calls(ok, "invoiceEmail")[0], true); } catch (e) { msg = (e as Error).message; }
  assert(/no pictureUrl/.test(msg), `a quote send with no photo must be reported, got: ${msg}`);
});

Deno.test("the Preview action is a settings_email READ, and the save goes through the shared cleaner", () => {
  assert(/\n\s*email_preview_template:\s*\{\s*area:\s*"settings_email",\s*level:\s*"view"\s*\}/.test(PORTAL_SETTINGS),
    "email_preview_template must be gated settings_email:view");
  assert(/\n\s*email_save_template:\s*\{\s*area:\s*"settings_email",\s*level:\s*"edit"\s*\}/.test(PORTAL_SETTINGS),
    "email_save_template must stay settings_email:edit");
  const save = PORTAL_SETTINGS.slice(PORTAL_SETTINGS.indexOf('if (action === "email_save_template")'));
  assert(/^[\s\S]{0,400}cleanTemplateCopy\(payload\?\.copy\)/.test(save), "email_save_template must clean with cleanTemplateCopy");
  const pv = PORTAL_SETTINGS.slice(PORTAL_SETTINGS.indexOf('if (action === "email_preview_template")'));
  const pvBody = pv.slice(0, pv.indexOf("\n  }\n") + 4);
  assert(pvBody.length > 200, "couldn't find the preview branch");
  assert(/cleanTemplateCopy\(/.test(pvBody), "the preview must hold the wording to the save's rules");
  for (const bad of ["sendTenantEmail", ".update(", ".insert(", ".upsert(", ".delete("]) {
    assert(!pvBody.includes(bad), `the preview must not ${bad} — it is a read`);
  }
});

Deno.test("the wording editor: {customer} in the hint, the server's limits on its boxes, a sandboxed preview", () => {
  const at = EDITOR.indexOf("data-ss-email-wording");
  assert(at > 0, "couldn't find the wording editor in portal/08-integrations.jsx");
  const ed = EDITOR.slice(at, EDITOR.indexOf("data-ss-email-preview", at) + 2000);
  assert(ed.includes('{"{customer}"}'), "the hint must list {customer}");
  for (const [field, max] of Object.entries(TEMPLATE_LIMITS)) {
    const re = new RegExp(`data-ss-wording="${field}"[^>]*?maxLength=\\{(\\d+)\\}`);
    const m = re.exec(ed);
    assert(m, `no ${field} box with a maxLength`);
    assert(Number(m[1]) === max, `the ${field} box stops at ${m[1]}, the server at ${max}`);
  }
  const frame = /<iframe[^>]*>/.exec(ed.replace(/\n\s*/g, " "));
  assert(frame, "no preview frame");
  assert(/\bsandbox=""/.test(frame[0]), `the preview frame must be sandbox="" (no scripts): ${frame[0]}`);
  assert(/\bsrcDoc=\{pv\.html\}/.test(frame[0]), "the preview frame must draw the server's html from srcdoc");
  assert(!/allow-scripts|allow-same-origin|dangerouslySetInnerHTML/.test(ed), "the preview must never run or inline the email's html");
});
