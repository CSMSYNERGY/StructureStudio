// The SENDERS of customer email, checked against the shipped source for the reply copy (2026-10-05).
//
// repReplyTo.test.ts proves the rule answers the right person. That was never the gap: until
// 2026-10-05 eleven of the twelve senders never asked it, so a customer's reply to a quote, an
// invoice, a change order or a confirmation reached the record and nobody's inbox. These checks
// read portal-settings, submit-estimate and customer-accept as text and hold every sendTenantEmail
// call to the rule:
//   • it passes a replyTo, and that value comes from the function's one repReplyTo wrapper
//     (replyCopy / quoteReplyTo / assignedRepReplyTo) a few lines above, never from the request;
//   • the sender it names is the verified session (portal-settings' signedIn, submit-estimate's
//     callerUserId), and customer-accept, whose emails the customer sets off, names no sender;
//   • it says who the email is going to (`recipient`), so the customer's assigned rep is only
//     ever named on an email to that customer's own address;
//   • the only send without one is the Settings test email (kind "test").
// The call COUNT is pinned too, so a sender added later fails here until it is held to the same
// rule. Also pinned: crm_send_email reads no address of its own any more, save_prefs and the My
// Profile box check addresses with the same rule as the senders, and the card says what it does.
//
// Needs read access to the repo (preflight grants --allow-read=<repo>); no network.
import { cleanReplyAddress, REPLY_ADDRESS_RE } from "./repReplyTo.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");

const SOURCES: Record<string, string> = {
  "portal-settings": read("../portal-settings/index.ts"),
  "submit-estimate": read("../submit-estimate/index.ts"),
  "customer-accept": read("../customer-accept/index.ts"),
};
const PROFILE = read("../../../portal/08-integrations.jsx");
const WRAPPER: Record<string, string> = {
  "portal-settings": "replyCopy",
  "submit-estimate": "quoteReplyTo",
  "customer-accept": "assignedRepReplyTo",
};

/** The source of a call's argument list, from its "(" to the matching ")", skipping comments,
 *  strings and template literals (the same walker as emailTemplateSenders.test.ts). */
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

function calls(src: string, name: string): { at: number; args: string; line: number }[] {
  const out: { at: number; args: string; line: number }[] = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${name}\\(`, "g"))) {
    const at = m.index!;
    if (/function\s$/.test(src.slice(Math.max(0, at - 9), at))) continue;
    // A name on a comment line (`//`, or a ` * ` line of a block comment) is prose, not a call:
    // `sendTenantEmail()` in a file header is not a send.
    const lineStart = src.lastIndexOf("\n", at) + 1;
    if (/\/\/|^\s*\*/.test(src.slice(lineStart, at))) continue;
    out.push({ at, args: callArgs(src, at + name.length), line: src.slice(0, at).split("\n").length });
  }
  return out;
}

/** What is wrong with one send's reply copy, or null when it follows the rule. */
function senderProblem(src: string, wrapper: string, c: { at: number; args: string }): string | null {
  if (/\bkind:\s*"test"/.test(c.args)) return null;
  const m = /\.\.\.\(\s*([A-Za-z_$][\w$]*)\s*\?\s*\{\s*replyTo(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*:\s*\{\s*\}\s*\)/.exec(c.args);
  if (!m) return "passes no replyTo, so a customer's reply reaches the record and nobody's inbox";
  if (m[2] && m[2] !== m[1]) return `replyTo is ${m[2]} but the guard tests ${m[1]}`;
  // The NEAREST declaration of that name above the send (same block, same request) must be the
  // wrapper's answer, and nothing may reassign it in between.
  const before = src.slice(Math.max(0, c.at - 5000), c.at);
  const decls = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*([^;]*)`, "g"))];
  const last = decls[decls.length - 1];
  if (!last || !new RegExp(`^await\\s+${wrapper}\\(`).test(last[1])) {
    return `replyTo ${m[1]} is not the answer of ${wrapper}(…) just above the send`;
  }
  if (new RegExp(`(?<![\\w$.])${m[1]}\\s*=(?!=)`).test(before.slice(last.index! + last[0].length))) {
    return `replyTo ${m[1]} is reassigned between ${wrapper}(…) and the send`;
  }
  return null;
}

Deno.test("every customer email carries the reply copy, from the one rule, except the Settings test", () => {
  // 7 sends in portal-settings (conversation, quote re-send, change order, invoice re-issue, the
  // invoice email retry, the first SS invoice, the CRM path's own-domain invoice) plus the test;
  // 2 in submit-estimate (SS quote or change order, CRM estimate); 3 confirmations in
  // customer-accept. A different count means a sender was added or removed: hold it to the rule,
  // then update this.
  const want: Record<string, number> = { "portal-settings": 8, "submit-estimate": 2, "customer-accept": 3 };
  for (const [file, src] of Object.entries(SOURCES)) {
    const sends = calls(src, "sendTenantEmail");
    assert(sends.length === want[file], `${file}: expected ${want[file]} sendTenantEmail calls, found ${sends.length}`);
    const tests = sends.filter((c) => /\bkind:\s*"test"/.test(c.args));
    assert(tests.length === (file === "portal-settings" ? 1 : 0), `${file}: unexpected test sends: ${tests.length}`);
    for (const c of sends) {
      const bad = senderProblem(src, WRAPPER[file], c);
      assert(!bad, `${file}:${c.line}: ${bad}`);
    }
    // Never an address from the request.
    assert(!/replyTo\s*:\s*(?:payload|body|req)\b|(?:payload|body)\??\.reply_?[Tt]o\b/.test(src), `${file}: a reply address read from the request`);
  }
});

Deno.test("the checks above bite: no replyTo, or one from somewhere else, is reported", () => {
  const src = `const a = await replyCopy(signedIn, { shortCode });\n` +
    `await sendTenantEmail(admin, clientId, { kind: "invoice", to, ...(a ? { replyTo: a } : {}) });\n` +
    `await sendTenantEmail(admin, clientId, { kind: "invoice", to });\n` +
    `const b = payload.reply;\n` +
    `await sendTenantEmail(admin, clientId, { kind: "invoice", to, ...(b ? { replyTo: b } : {}) });\n` +
    `await sendTenantEmail(admin, clientId, { kind: "test", to });\n` +
    `let c = await replyCopy(signedIn, { shortCode });\n` +
    `c = payload.reply;\n` +
    `await sendTenantEmail(admin, clientId, { kind: "invoice", to, ...(c ? { replyTo: c } : {}) });\n`;
  const [ok, none, other, test, moved] = calls(src, "sendTenantEmail");
  assert(senderProblem(src, "replyCopy", ok) === null, "the good one passes");
  assert(/passes no replyTo/.test(senderProblem(src, "replyCopy", none) ?? ""), "a send with none is reported");
  assert(/not the answer of replyCopy/.test(senderProblem(src, "replyCopy", other) ?? ""), "one from elsewhere is reported");
  assert(senderProblem(src, "replyCopy", test) === null, "the test send is exempt");
  assert(/reassigned/.test(senderProblem(src, "replyCopy", moved) ?? ""), "a reassignment in between is reported");
});

Deno.test("portal-settings names the signed-in person, and view-as is passed through", () => {
  const ps = SOURCES["portal-settings"];
  assert(/const signedIn: ReplySender = \{ userId: userId \? String\(userId\) : null, operator: Boolean\(operator\) \};/.test(ps),
    "signedIn must be the verified session's user and its view-as flag");
  const def = ps.slice(ps.indexOf("const replyCopy = "), ps.indexOf("const replyCopy = ") + 700);
  assert(/senderUserId: sender\.userId,\s*operator: sender\.operator,/.test(def), "replyCopy must hand both to repReplyTo");
  assert(/recipient: ref\.recipient,/.test(def), "replyCopy must hand the recipient to repReplyTo");
  assert(/ref: \{ shortCode\?: string \| null; contactId\?: string \| null; recipient: string \}/.test(def), "replyCopy's recipient must be required");
  for (const c of calls(ps, "replyCopy")) {
    assert(/^\(\s*(signedIn|sender)\s*,/.test(c.args), `portal-settings: replyCopy${c.args.slice(0, 60)} must name signedIn (or sendQuoteEmail's sender)`);
    assert(/\brecipient: to2?\s*\}\)$/.test(c.args), `portal-settings: replyCopy${c.args.slice(0, 80)} must pass the address the email goes to`);
  }
  for (const c of calls(ps, "sendQuoteEmail")) {
    assert(/^\(\s*shortCode\s*,\s*(signedIn|opts\.sender)\s*\)$/.test(c.args), `sendQuoteEmail${c.args} must say whose send it is`);
  }
  const restamps = calls(ps, "restampQuoteTax");
  assert(restamps.length === 2, `expected 2 restampQuoteTax calls, found ${restamps.length}`);
  for (const c of restamps) assert(/\bsender: signedIn\b/.test(c.args), `restampQuoteTax${c.args.slice(0, 80)} must pass sender: signedIn`);
});

Deno.test("crm_send_email asks the rule and reads no address of its own; save_prefs checks with the same rule", () => {
  const ps = SOURCES["portal-settings"];
  const at = ps.indexOf('if (action === "crm_send_email")');
  const branch = ps.slice(at, ps.indexOf("\n  }\n", at));
  assert(branch.length > 1000, "couldn't find crm_send_email");
  assert(/const replyTo = await replyCopy\(signedIn, \{ shortCode, contactId: contactFound \? contactId : null, recipient: to \}\);/.test(branch),
    "crm_send_email must take its reply copy from replyCopy, for the contact it found");
  // View-as with no reply copy and no routing address would send an email no reply can reach.
  assert(/if \(operator && !replyTo\) \{[\s\S]{0,400}buildReplyAddress\(rs\?\.inbound_domain, rs\?\.inbound_status,[\s\S]{0,300}A reply to this email would reach nobody\./.test(branch),
    "crm_send_email must refuse a view-as email whose reply would reach nobody");
  assert(!/getUserById|replyToEmail/.test(branch), "crm_send_email must not read an address itself any more");
  const sig = /\.from\("client_users"\)\s*\.select\("prefs"\)([^;]*);/.exec(branch);
  assert(sig && /\.eq\("client_id", clientId\)/.test(sig[1]), "the signature read must be keyed on this tenant too");
  const save = ps.slice(ps.indexOf('if (action === "save_prefs")'), ps.indexOf('if (action === "save_prefs")') + 4000);
  assert(/const addr = cleanReplyAddress\(raw\.replyToEmail\);\s*if \(addr\) clean\.replyToEmail = addr;/.test(save),
    "save_prefs must check the address with cleanReplyAddress");
});

Deno.test("submit-estimate names the verified caller; customer-accept names nobody but the assigned rep", () => {
  const se = SOURCES["submit-estimate"];
  const q = se.slice(se.indexOf("const quoteReplyTo = "), se.indexOf("const quoteReplyTo = ") + 500);
  assert(/repReplyTo\(supabase, clientId, \{\s*senderUserId: callerUserId,\s*shortCode: String\(designId\),\s*recipient,/.test(q),
    "quoteReplyTo must name callerUserId, the verified session, for this design, and the recipient");
  for (const c of calls(se, "quoteReplyTo")) assert(c.args === "(intendedTo)", `submit-estimate: quoteReplyTo${c.args} must be told the address the quote goes to`);
  const ca = SOURCES["customer-accept"];
  const fnAt = ca.indexOf("function assignedRepReplyTo(");
  const fn = ca.slice(fnAt, ca.indexOf("\n}\n", fnAt));
  assert(fnAt > 0 && /repReplyTo\(admin, clientId, \{\s*shortCode,\s*recipient,/.test(fn), "customer-accept must ask for the design's assigned rep, for this recipient");
  for (const c of calls(ca, "assignedRepReplyTo")) assert(/,\s*to\)$/.test(c.args), `customer-accept: assignedRepReplyTo${c.args} must be told the address the confirmation goes to`);
  assert(!/senderUserId|operator/.test(fn), "a confirmation the customer set off names no staff sender");
});

Deno.test("the My Profile box checks addresses with the senders' own rule, and says what the copy covers", () => {
  const m = /const REPLY_ADDRESS_RE = (\/.+\/);\n/.exec(PROFILE);
  assert(m, "portal/08-integrations.jsx must carry REPLY_ADDRESS_RE");
  assert(m[1] === String(REPLY_ADDRESS_RE), `the portal's rule ${m[1]} must be the server's ${String(REPLY_ADDRESS_RE)}`);
  // And it behaves the same on a corpus, as compiled by this runtime.
  const lit = /^\/(.*)\/([a-z]*)$/.exec(m[1]);
  assert(lit, `couldn't read the portal's regex literal ${m[1]}`);
  const portalRe = new RegExp(lit[1], lit[2]);
  for (const v of ["sam@acme.example.test", "Sam <sam@acme.example.test>", "a,b@acme.example.test", "sam@acme..example.test", "josé@acme.example.test", "o'brien@example.test"]) {
    assert(portalRe.test(v) === (cleanReplyAddress(v) !== null), `portal and server disagree on ${v}`);
  }
  assert(/const looksLikeEmail = \(v\) => v\.length <= 320 && REPLY_ADDRESS_RE\.test\(v\);/.test(PROFILE), "the reply-to box must use it");
  assert(!/DOES NOT WORK YET|HANDOFF-reply-to-prefs/.test(PROFILE), "the stale 'does not work yet' notes must be gone");
  const card = PROFILE.slice(PROFILE.indexOf("Where replies to your emails go"), PROFILE.indexOf("Where replies to your emails go") + 900);
  assert(/quote/.test(card) && /invoice/.test(card), "the card must say it covers quotes and invoices");
});
