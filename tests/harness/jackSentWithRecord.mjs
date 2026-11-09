// "SENT BY ... WITH JACK" ON THE CUSTOMER'S RECORD (Jack v2 round 2, migration 378's sent_with), driven
// for real on the COMPILED portal. The record page's timeline is built by the REAL buildCrmFeed
// (supabase/functions/_shared/crmFeed.ts), run here in Node at the moment the page asks for it, against
// a stand-in database that honours SELECT the way PostgREST does: it projects the columns asked for,
// applies eq / in / or / is / order / limit, and REFUSES a column the table does not have with 42703.
// The page then draws that feed (portal/02-sales.jsx), and every check below reads the words on the
// page, not just the feed.
//
//   1  A text and an email Pat sent with Jack say "Sent by Pat Owner with Jack" under them, as her
//      teammate Riley (the one signed in) sees them. A text and an email Riley sent by hand on the same
//      record say nothing about Jack.
//   2  An email a StructureStudio operator sent in view-as (in app_operators, not on this team, and a
//      member of another builder's team under another name): "Sent by the Structure Studio team with
//      Jack", and the operator's name is nowhere on the page.
//   3  Someone no longer on the team: "Sent by a former team member with Jack" (and a removed rep who
//      now works for another builder is still that, never their other name). A teammate with no name
//      set: "Sent by a team member with Jack".
//   4  A row stamped with Jack but no sender (sent_by null): "Sent with Jack". The people read failing
//      (client_users times out): "Sent with Jack" on every Jack line, naming nobody, not even the
//      teammate, and never the Structure Studio team.
//   5  BEFORE MIGRATION 378 (the database refuses a select naming sent_with, 42703): the record still
//      shows every text and email, words included, with no Jack lines and no error.
//   6  An estimate resent with Jack: the feed's "Quote emailed to ..." line (crmFeed.ts's older wording,
//      not this round's) with the estimate's subject, and "Sent by Pat Owner with Jack" under it; the
//      first send of the same estimate and the estimate's own "sent" line carry no Jack line.
//
// What is stood in: the database (the in-memory tables below: sms_messages, email_sends, client_users and
// app_operators with the columns crmFeedSentWith.test.ts takes from their migrations, sent_with only after
// 378, plus designs) and portal-settings around it (the crm_record answer is the shape its handler returns, with
// the feed built by the real function). Supabase is stubbed at the network layer: no login, and nothing
// leaves the machine (every other non-local request is aborted). Nothing is sent anywhere.
//
//   node tests/harness/jackSentWithRecord.mjs          (exit 0 = every check held)
//
// Shots land in %TEMP%/ss-harness/jack-sent-with-record (SS_SHOTS overrides), with manifest.json beside
// them: one { file, group, title, shows } per shot, in order, written by this file as it takes them.
//
// Tenants, people, numbers and addresses here are made up (example.test, 555 numbers). The repo is public.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { BASE, REF, collectErrors, launch, reporter, shotsDir } from "./lib.mjs";
import { buildCrmFeed } from "../../supabase/functions/_shared/crmFeed.ts";

const CLIENT = "acme-sheds";
const COMPANY = "Acme Sheds";
const SHOTS = shotsDir("jack-sent-with-record");
const MANIFEST = [];

// ── People ────────────────────────────────────────────────────────────────────────────────────────
const PAT = "00000000-0000-4000-8000-00000000b001";        // owner, on this team: sends with Jack
const RILEY = "00000000-0000-4000-8000-00000000b002";      // rep on this team, sends by hand: the one signed in
const NONAME = "00000000-0000-4000-8000-00000000b003";     // on this team, never set a name
const OLIVE = "00000000-0000-4000-8000-00000000b004";      // StructureStudio operator, also on another builder's team
const GONE = "00000000-0000-4000-8000-00000000b005";       // removed from this team, on no team now
const GONE_ELSE = "00000000-0000-4000-8000-00000000b006";  // removed from this team, now on another builder's team
const OTHER_BUILDER = "another-builder";

// ── Customers, one record per scenario ────────────────────────────────────────────────────────────
const cid = (n) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0")}`;
const CUSTOMERS = {
  s1: { id: cid(1), name: "Alex Tester", phone: "+15555550101", email: "alex@example.test" },
  s2: { id: cid(2), name: "Blair Sample", phone: "+15555550102", email: "blair@example.test" },
  s3: { id: cid(3), name: "Casey Example", phone: "+15555550103", email: "casey@example.test" },
  s4a: { id: cid(4), name: "Drew Placeholder", phone: "+15555550104", email: "drew@example.test" },
  s4b: { id: cid(5), name: "Emery Fixture", phone: "+15555550105", email: "emery@example.test" },
  s5: { id: cid(6), name: "Finley Mock", phone: "+15555550106", email: "finley@example.test" },
  s6: { id: cid(7), name: "Gray Demo", phone: "+15555550107", email: "gray@example.test" },
};
const OUR_NUMBER = "+15555550100";
const ESTIMATE_CODE = "SS-GRAYDM01";
const ESTIMATE_NO = "SSQ-1042";

// ── The tables' columns, from their migrations. sent_with is migration 378's ──────────────────────
const SMS_COLUMNS = ["id", "client_id", "contact_id", "short_code", "direction", "from_number", "to_number", "body", "status", "error_code",
  "provider", "provider_sid", "num_segments", "sent_by", "delivered_at", "created_at", "updated_at", "client_temp_id", "sent_via", "num_media"];
const EMAIL_COLUMNS = ["id", "client_id", "short_code", "kind", "to_email", "intended_email", "from_email", "subject", "status", "error",
  "postmark_message_id", "delivered_at", "bounced_at", "bounce_reason", "created_at", "updated_at", "provider_message_id", "contact_id",
  "body_text", "sent_by", "client_temp_id", "opened_at", "open_count", "complained_at"];
const USER_COLUMNS = ["user_id", "client_id", "role", "title", "access", "full_name", "created_at"];
const OPERATOR_COLUMNS = ["user_id", "email", "added_at", "display_name"];
const DESIGN_COLUMNS = ["short_code", "client_id", "contact_id", "created_at", "updated_at", "status", "selections", "contact", "total_cents",
  "expected_close_date", "image_url", "ghl_estimate_number", "ss_quote_number", "ss_quote_pdf_url", "ss_quote_sent_at", "accepted_at",
  "ss_invoice_sent_at", "ss_invoice_requested_at"];

const at = (day, hh, mm) => new Date(Date.UTC(2026, 10, day, hh, mm)).toISOString();
let seq = 0;
const rowId = () => `22222222-2222-4222-8222-${String(++seq).padStart(12, "0")}`;
const textOut = (c, when, body, extra = {}) => ({
  id: rowId(), client_id: CLIENT, contact_id: c.id, short_code: null, direction: "out", from_number: OUR_NUMBER, to_number: c.phone,
  body, status: "delivered", error_code: null, num_media: 0, created_at: when, sent_by: null, sent_with: null, ...extra,
});
const textIn = (c, when, body) => ({
  id: rowId(), client_id: CLIENT, contact_id: c.id, short_code: null, direction: "in", from_number: c.phone, to_number: OUR_NUMBER,
  body, status: "received", error_code: null, num_media: 0, created_at: when, sent_by: null, sent_with: null,
});
const emailOut = (c, when, subject, body, extra = {}) => ({
  id: rowId(), client_id: CLIENT, contact_id: c.id, short_code: null, kind: "conversation", to_email: c.email, subject, body_text: body,
  status: "delivered", delivered_at: when, bounced_at: null, opened_at: null, open_count: 0, complained_at: null, created_at: when,
  sent_by: null, sent_with: null, ...extra,
});

// What each record should read like, keyed by a phrase only that line has. `by` is the Jack line the
// page must draw under it, or null for none.
const C = CUSTOMERS;
const T = {
  // 1. a teammate's Jack sends, and the rep's own sends on the same record
  s1RileyText: textOut(C.s1, at(5, 15, 12), "Hi Alex, it's Riley from Acme Sheds. Your estimate for the 10x12 Garden Shed is in your email.", { sent_by: RILEY }),
  s1RileyEmail: emailOut(C.s1, at(5, 15, 15), "Your shed estimate", "Hi Alex,\n\nYour estimate for the 10x12 Garden Shed is attached. Call me with any questions.\n\nRiley", { sent_by: RILEY }),
  s1In: textIn(C.s1, at(6, 14, 2), "Thanks! Can you deliver this Thursday?"),
  s1JackText: textOut(C.s1, at(6, 14, 20), "Hi Alex, yes, Thursday works. Our driver will call you an hour before. Pat, Acme Sheds", { sent_by: PAT, sent_with: "jack" }),
  s1JackEmail: emailOut(C.s1, at(6, 14, 22), "Your delivery on Thursday", "Hi Alex,\n\nThursday is booked for your 10x12 Garden Shed. Our driver will call an hour before arriving.\n\nPat", { sent_by: PAT, sent_with: "jack" }),
  // 2. an operator in view-as
  s2RileyEmail: emailOut(C.s2, at(4, 16, 0), "Your shed estimate", "Hi Blair,\n\nYour estimate is attached.\n\nRiley", { sent_by: RILEY }),
  s2OpEmail: emailOut(C.s2, at(6, 15, 30), "Following up on your estimate", "Hi Blair,\n\nJust checking you had a chance to look at your estimate. Happy to answer any questions.\n\nAcme Sheds", { sent_by: OLIVE, sent_with: "jack" }),
  // 3. someone no longer on the team, and a teammate with no name
  s3GoneText: textOut(C.s3, at(3, 17, 5), "Hi Casey, just checking you got the estimate we emailed.", { sent_by: GONE, sent_with: "jack" }),
  s3GoneElseEmail: emailOut(C.s3, at(4, 17, 40), "Your estimate, one more time", "Hi Casey,\n\nHere is your estimate again in case the first one went missing.", { sent_by: GONE_ELSE, sent_with: "jack" }),
  s3NoNameEmail: emailOut(C.s3, at(6, 13, 10), "Your delivery window", "Hi Casey,\n\nWe can deliver any morning next week. Which day suits you?", { sent_by: NONAME, sent_with: "jack" }),
  // 4a. stamped with Jack, nobody recorded
  s4aText: textOut(C.s4a, at(6, 12, 0), "Hi Drew, your shed is ready to schedule. Reply with a good day.", { sent_by: null, sent_with: "jack" }),
  s4aEmail: emailOut(C.s4a, at(6, 12, 5), "Ready to schedule", "Hi Drew,\n\nYour shed is ready. Which day works for delivery?", { sent_by: null, sent_with: "jack" }),
  // 4b. the people read fails
  s4bRileyText: textOut(C.s4b, at(5, 10, 0), "Hi Emery, this is Riley. Your estimate is on its way.", { sent_by: RILEY }),
  s4bPatText: textOut(C.s4b, at(6, 11, 0), "Hi Emery, the 12x16 Lofted Barn is in stock. Want us to hold it for you?", { sent_by: PAT, sent_with: "jack" }),
  s4bOpEmail: emailOut(C.s4b, at(6, 11, 30), "Holding your barn", "Hi Emery,\n\nWe can hold the 12x16 Lofted Barn until Friday.", { sent_by: OLIVE, sent_with: "jack" }),
  // 5. before 378: ordinary history, and the database has no sent_with column at all
  s5Text1: textOut(C.s5, at(2, 15, 0), "Hi Finley, this is Riley from Acme Sheds. Thanks for designing your shed with us.", { sent_by: RILEY }),
  s5In: textIn(C.s5, at(2, 15, 30), "Thanks Riley. What is the lead time?"),
  s5Text2: textOut(C.s5, at(2, 16, 0), "About three weeks from your order. Pat, Acme Sheds", { sent_by: PAT }),
  s5Email1: emailOut(C.s5, at(3, 14, 0), "Lead time and next steps", "Hi Finley,\n\nLead time is about three weeks. Your estimate is attached.\n\nPat", { sent_by: PAT }),
  s5Email2: emailOut(C.s5, at(4, 9, 30), "Colour samples", "Hi Finley,\n\nHere are the colour samples you asked about.\n\nRiley", { sent_by: RILEY, opened_at: at(4, 10, 2), open_count: 2 }),
  // 6. an estimate resent with Jack
  s6First: emailOut(C.s6, at(1, 15, 30), `Your estimate ${ESTIMATE_NO} from ${COMPANY}`, null, { kind: "estimate", short_code: ESTIMATE_CODE }),
  s6Resend: emailOut(C.s6, at(6, 16, 5), `Your estimate ${ESTIMATE_NO} from ${COMPANY}`, null, { kind: "estimate", short_code: ESTIMATE_CODE, sent_by: PAT, sent_with: "jack" }),
};
const ESTIMATE = {
  short_code: ESTIMATE_CODE, client_id: CLIENT, contact_id: C.s6.id, created_at: at(1, 15, 0), updated_at: at(6, 16, 5), status: "sent",
  selections: { style: "Garden Shed", size: "10x12" }, contact: { name: C.s6.name, phone: C.s6.phone, email: C.s6.email }, total_cents: 512300,
  expected_close_date: null, image_url: null, ghl_estimate_number: null, ss_quote_number: ESTIMATE_NO, ss_quote_pdf_url: null,
  // The resend moves the estimate's sent date to the moment it went (sendQuoteEmail stamps it).
  ss_quote_sent_at: at(6, 16, 5), accepted_at: null, ss_invoice_sent_at: null, ss_invoice_requested_at: null,
};

// ONE database, every record's rows in it, filtered by contact the way the real reads are.
const TABLES = {
  sms_messages: Object.values(T).filter((r) => "direction" in r),
  email_sends: Object.values(T).filter((r) => "kind" in r),
  client_users: [
    { user_id: PAT, client_id: CLIENT, role: "owner", full_name: "Pat Owner" },
    { user_id: RILEY, client_id: CLIENT, role: "member", full_name: "Riley Rep" },
    { user_id: NONAME, client_id: CLIENT, role: "member", full_name: null },
    // An operator who is also on another builder's team: that name must never reach this builder's page.
    { user_id: OLIVE, client_id: OTHER_BUILDER, role: "owner", full_name: "Olive Operator" },
    { user_id: GONE_ELSE, client_id: OTHER_BUILDER, role: "member", full_name: "Rita Elsewhere" },
  ],
  app_operators: [{ user_id: OLIVE, email: "olive@example.test" }],
  designs: [ESTIMATE],
};
// The same rows as a database before 378 holds them: no sent_with anywhere.
const before378 = (t) => ({
  ...t,
  sms_messages: t.sms_messages.map(({ sent_with: _s, ...r }) => r),
  email_sends: t.email_sends.map(({ sent_with: _s, ...r }) => r),
});

/** A PostgREST stand-in (crmFeedSentWith.test.ts's, with or / is / order / limit applied too): projects
 *  the selected columns, refuses an unknown one with 42703, records every select per table, and answers
 *  57014 for a table named in `failing`. A table it has no column list for answers as empty. */
function fakeAdmin(tables, { after378 = true, failing = [] } = {}) {
  const columns = {
    sms_messages: after378 ? [...SMS_COLUMNS, "sent_with"] : SMS_COLUMNS,
    email_sends: after378 ? [...EMAIL_COLUMNS, "sent_with"] : EMAIL_COLUMNS,
    client_users: USER_COLUMNS,
    app_operators: OPERATOR_COLUMNS,
    designs: DESIGN_COLUMNS,
  };
  const asked = {};
  const splitTop = (s) => {
    const out = []; let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const orPart = (p) => {
    let m = /^([a-z_]+)\.in\.\((.*)\)$/.exec(p);
    if (m) { const vs = m[2].split(","); return (r) => vs.includes(String(r[m[1]])); }
    m = /^([a-z_]+)\.eq\.(.*)$/.exec(p);
    if (m) return (r) => String(r[m[1]]) === m[2];
    throw new Error(`fakeAdmin: an or() part it does not know: ${p}`);
  };
  const builder = (table) => {
    let cols = [];
    const filters = [];
    let order = null, limit = Infinity;
    const b = {};
    b.select = (s) => {
      cols = String(s).replace(/\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
      (asked[table] ||= []).push(String(s));
      return b;
    };
    b.eq = (c, v) => { filters.push((r) => r[c] === v); return b; };
    b.in = (c, vs) => { filters.push((r) => vs.includes(r[c])); return b; };
    b.is = (c, v) => { filters.push((r) => (r[c] ?? null) === v); return b; };
    b.or = (expr) => { const parts = splitTop(String(expr)).map(orPart); filters.push((r) => parts.some((f) => f(r))); return b; };
    b.order = (c, o = {}) => { order = { c, asc: o.ascending !== false }; return b; };
    b.limit = (n) => { limit = n; return b; };
    b.then = (res, rej) => {
      const known = columns[table];
      if (failing.includes(table)) return Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }).then(res, rej);
      if (!known) return Promise.resolve({ data: [], error: null }).then(res, rej);
      const bad = cols.find((c) => !known.includes(c));
      if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }).then(res, rej);
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((x, y) => (String(x[order.c]) < String(y[order.c]) ? -1 : 1) * (order.asc ? 1 : -1));
      rows = rows.slice(0, limit).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { admin: { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } }, asked };
}

// Which database each record is read from: after 378 unless the scenario says otherwise.
const DB_STATE = {
  [C.s4b.id]: { failing: ["client_users"] },
  [C.s5.id]: { after378: false },
};
const FEEDS = {};   // contact id → { feed, asked } from the last crm_record answer
// crm_record's feed options (portal-settings index.ts always passes isAdmin: true), for the viewer.
const FEED_FOR_VIEWER = { isAdmin: true, phone: { level: "team", userId: RILEY, contactOwner: null } };
async function crmRecord(contactId) {
  const contact = Object.values(C).find((c) => c.id === contactId);
  if (!contact) return null;
  const state = DB_STATE[contactId] || {};
  const tables = state.after378 === false ? before378(TABLES) : TABLES;
  const { admin, asked } = fakeAdmin(tables, state);
  const designs = TABLES.designs.filter((d) => d.contact_id === contactId);
  const codes = designs.map((d) => d.short_code);
  // The same call crm_record makes (portal-settings index.ts), for the one signed in: Riley, with the
  // team's phone history.
  const feed = await buildCrmFeed(admin, CLIENT, { codes, contactId, ...FEED_FOR_VIEWER });
  FEEDS[contactId] = { feed, asked };
  const crmContact = {
    id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, phone_digits: contact.phone.replace(/\D/g, ""),
    owner_user_id: null, sms_opt_out_at: null, first_seen_at: at(1, 12, 0),
  };
  return {
    ok: true, kind: "contact", clientId: CLIENT, contact: crmContact, designs, orders: [], feed, focus: [], team: [], people: [], followers: [],
    sms: { ready: true, from: OUR_NUMBER, optedOut: false, consented: true }, build: [], stages: [], delivery: [], repairs: [],
  };
}

// ── The browser ───────────────────────────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = 4102444800;
// Signed in: Riley Rep, a teammate of Pat's, so "Sent by Pat Owner with Jack" is a teammate's send as
// the rest of the team sees it. The foot of the menu shows her name and address.
const USER = { id: RILEY, aud: "authenticated", role: "authenticated", email: "riley@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const VIEWER_NAME = "Riley Rep";
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", email: USER.email, exp: EXP })}.c3R1Yg`,
  token_type: "bearer", expires_in: 999999999, expires_at: EXP, refresh_token: "r", user: USER,
};
// A rep's access as an owner can grant it: the selling side, the record and the phone.
const REP_ACCESS = Object.fromEntries(["designer", "designs", "contacts", "inventory", "orders", "change_orders",
  "build_schedule", "delivery_schedule", "repairs", "phone"].map((k) => [k, "edit"]));


const { ok, failed } = reporter();
const H = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: H, body: JSON.stringify(body) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const crmAsked = [];
const crmMissing = [];

// What the server said about one row: [via, byName, byOperator], or "missing".
const feedId = (r) => ("direction" in r ? `sm:${r.id}` : `e:${r.id}`);
const who = (c, r) => {
  const e = FEEDS[c.id]?.feed.find((x) => x.id === feedId(r));
  return e ? [e.via ?? null, e.byName ?? null, e.byOperator ?? null] : "missing";
};
// A History line on the page, found by words only it has.
const rowOf = (h, ...words) => (h || []).find((r) => words.every((w) => r.text.includes(w))) || null;
const allText = (h) => (h || []).map((r) => r.text).join("\n");
const brief = (r) => (r ? JSON.stringify({ byline: r.byline, bylines: r.bylines, under: r.under, shown: r.shown, text: r.text.slice(0, 90) }) : "line not on the page");
const jackLine = (r, words) => !!r && r.byline === words && r.bylines === 1 && r.under === true && r.shown === true;
const noJackLine = (r) => !!r && r.bylines === 0 && !/with Jack/.test(r.text);

const writeManifest = () => writeFileSync(join(SHOTS, "manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n");

const { browser, ctx: unused } = await launch({ width: 1280, height: 900 });
await unused.close();
let errors = [];
try {
  // Device scale 2 so the close-ups of the timeline are sharp; the whole-page shots are taken at CSS
  // scale, so they are 1280x900.
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, serviceWorkers: "block", timezoneId: "America/Chicago", locale: "en-US",
  });
  await ctx.addInitScript(([ref, s]) => {
    try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(s)); } catch (_e) { /* storage blocked */ }
  }, [REF, SESSION]);
  // The History list as drawn: the heading, the filter chips under it, then one line per event. For each
  // line, its words and its Jack line (data-ss-crm-sent-with): the words, how many, whether it is drawn
  // below the line's words, and whether it is actually visible.
  await ctx.addInitScript(() => {
    window.__ssHistoryEls = () => {
      const head = [...document.querySelectorAll("div")].find((d) => d.childElementCount === 0 && d.textContent.trim() === "History"
        && d.nextElementSibling && d.nextElementSibling.querySelector("[data-ss-crm-chip]"));
      if (!head) return null;
      const kids = [...head.parentElement.children];
      return { head, rows: kids.slice(kids.indexOf(head) + 2).filter((el) => /solid/.test(el.style.borderTop || "")) };
    };
    window.__ssHistory = () => {
      const els = window.__ssHistoryEls();
      if (!els) return null;
      return els.rows.map((r) => {
        const by = r.querySelector("[data-ss-crm-sent-with]");
        const above = by && by.previousElementSibling;
        const br = by && by.getBoundingClientRect();
        return {
          text: r.innerText.replace(/ /g, " "),
          byline: by ? by.innerText.trim() : null,
          bylines: r.querySelectorAll("[data-ss-crm-sent-with]").length,
          under: by && above ? br.top >= above.getBoundingClientRect().bottom - 0.5 : null,
          shown: by ? br.width > 0 && br.height > 0 && getComputedStyle(by).visibility !== "hidden" && getComputedStyle(by).display !== "none" : null,
        };
      });
    };
  });
  const page = await ctx.newPage();
  errors = collectErrors(page);
  await page.route((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u.href), (route) => route.abort());
  const handler = async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...H, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (_e) { /* not JSON */ }
    if (url.includes("/rest/v1/rpc/")) return json(route, url.includes("log_error") ? null : false);
    if (url.includes("/rest/v1/client_users")) return json(route, [{ client_id: CLIENT, role: "member", user_id: USER.id, full_name: VIEWER_NAME }]);
    if (url.includes("/rest/v1/")) return json(route, []);
    if (url.includes("/auth/v1/user")) return json(route, USER);
    if (url.includes("/auth/v1/")) return json(route, SESSION);
    if (url.includes("/portal-billing")) {
      return json(route, { configured: true, hasCard: false, plans: [], subscriptions: [], entitlement: { granted: [], features: { crm: true }, status: "active" }, wallet: null, clientId: CLIENT });
    }
    if (!url.includes("/portal-settings")) return json(route, { ok: true });
    switch (body.action) {
      case "status":
        return json(route, { ok: true, clientId: CLIENT, role: "member", operatorMode: false, access: REP_ACCESS, prefs: null,
          phoneStatus: "on", configured: false, invoiceInGhl: false, ghlInvoicingAllowed: false, businessAddress: {}, branding: { companyName: COMPANY }, emailReady: true });
      case "get_profile":
        return json(route, { fullName: VIEWER_NAME, phone: "", role: "member", email: USER.email, needsDetails: false, emailSignature: "", emailSignatureHtml: "" });
      case "crm_record": {
        const id = String(body.id || "").replace(/^c-/, "");
        const out = await crmRecord(id);
        crmAsked.push(id);
        if (!out) { crmMissing.push(id); return json(route, { error: "That contact no longer exists." }, 404); }
        return json(route, out);
      }
      default: return json(route, { ok: true });
    }
  };
  await page.route(`**/${REF}.supabase.co/**`, handler);
  await page.route(`**/${REF}.functions.supabase.co/**`, handler);
  await page.goto(`${BASE}/portal.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ssAppBooted === true && !document.body.innerText.includes("Loading your business"), null, { timeout: 60000 });
  await page.waitForTimeout(600);

  const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 }).then(() => true, () => false);
  const history = () => page.evaluate(() => window.__ssHistory());
  const bodyText = () => page.evaluate(() => document.body.innerText);
  // Open a customer's record the way the app does (a route change), and wait until THEIR timeline is on
  // screen: their name, every line the server sent, and words only their record has.
  const openRecord = async (c, words) => {
    const before = crmAsked.length;
    await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, `/contacts/c-${c.id}`);
    for (let i = 0; i < 300 && !crmAsked.slice(before).includes(c.id); i++) await page.waitForTimeout(50);
    const n = FEEDS[c.id]?.feed.length ?? -1;
    const shown = await until(([name, n, words]) => {
      const h = window.__ssHistory && window.__ssHistory();
      return !!h && h.length === n && document.body.innerText.includes(name) && h.some((r) => r.text.includes(words));
    }, [c.name, n, words]);
    await page.waitForTimeout(250);
    ok(`${c.name}'s record is on screen with all ${n} lines the server sent`, shown && crmAsked.slice(before).includes(c.id), `asked: ${crmAsked.slice(before).join(",")}`);
    return history();
  };
  // A whole-page shot (1280x900, the History heading and its last line in view), and a sharp close-up of
  // just the History list, each with its manifest entry.
  const proof = async (file, group, title, shows) => {
    // The page as a person sees it: the record's name at the top, the History heading and its last line
    // in view.
    await page.evaluate(() => {
      const els = window.__ssHistoryEls();
      if (!els) return;
      // From the top (the last close-up left the page scrolled), then only as far as the list needs.
      for (let el = els.head.parentElement; el; el = el.parentElement) if (el.scrollTop) el.scrollTop = 0;
      window.scrollTo(0, 0);
      (els.rows[els.rows.length - 1] || els.head).scrollIntoView({ block: "nearest" });
      els.head.scrollIntoView({ block: "nearest" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${file}.png`), scale: "css" });
    MANIFEST.push({ file: `${file}.png`, group, title, shows });
    // The close-up: History scrolled up to just under the page's fixed top bar, so the floating Feedback
    // button in the bottom corner can't sit over its last line.
    const clip = await page.evaluate(() => {
      const els = window.__ssHistoryEls();
      if (!els) return null;
      const last = els.rows[els.rows.length - 1] || els.head;
      const bar = Math.max(0, ...[...document.querySelectorAll("body *")].filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (cs.position === "fixed" || cs.position === "sticky") && r.top <= 0 && r.bottom > 0 && r.width > innerWidth / 2;
      }).map((el) => el.getBoundingClientRect().bottom));
      const want = els.head.getBoundingClientRect().top - (bar + 20);
      if (want > 0) {
        let scroller = null;
        for (let el = els.head.parentElement; el && !scroller; el = el.parentElement) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) scroller = el;
        }
        if (scroller) scroller.scrollTop += want; else window.scrollBy(0, want);
      }
      const p = els.head.parentElement.getBoundingClientRect();
      const top = Math.max(0, els.head.getBoundingClientRect().top - 12);
      const bottom = Math.min(innerHeight, last.getBoundingClientRect().bottom + 8);
      const left = Math.max(0, p.left - 4);
      return { x: left, y: top, width: Math.min(innerWidth, p.right + 4) - left, height: bottom - top };
    });
    await page.waitForTimeout(200);
    if (clip && clip.width > 0 && clip.height > 0) {
      await page.screenshot({ path: join(SHOTS, `${file}.card.png`), clip, scale: "device" });
      MANIFEST.push({ file: `${file}.card.png`, group, title: `${title} (close-up of History)`, shows });
    }
    writeManifest();
  };

  // ── 1. A teammate's sends with Jack, and the rep's own sends on the same record ────────────────────
  const G1 = "1. Sent with Jack by a teammate";
  let h = await openRecord(C.s1, "Thursday is booked");
  const signedIn = await page.evaluate(() => ({ name: (document.querySelector(".ss-user .uname")?.innerText || "").trim(), mail: (document.querySelector(".ss-user .umail")?.innerText || "").trim() }));
  ok("1 the one signed in is Riley Rep, Pat's teammate, as the foot of the menu shows", signedIn.name === VIEWER_NAME && signedIn.mail === USER.email, JSON.stringify(signedIn));
  ok("1a the server's feed: the text and email Jack sent for Pat carry via jack and Pat's name; Riley's own text and email and Alex's reply carry nothing",
    same(who(C.s1, T.s1JackText), ["jack", "Pat Owner", null]) && same(who(C.s1, T.s1JackEmail), ["jack", "Pat Owner", null])
      && [T.s1RileyText, T.s1RileyEmail, T.s1In].every((r) => same(who(C.s1, r), [null, null, null])),
    JSON.stringify([T.s1JackText, T.s1JackEmail, T.s1RileyText, T.s1RileyEmail, T.s1In].map((r) => who(C.s1, r))));
  ok("1b under the text Jack sent for Pat, right below its words: \"Sent by Pat Owner with Jack\"",
    jackLine(rowOf(h, "Hi Alex, yes, Thursday works"), "Sent by Pat Owner with Jack"), brief(rowOf(h, "Hi Alex, yes, Thursday works")));
  ok("1c under the email Jack sent for Pat, right below its words: \"Sent by Pat Owner with Jack\"",
    jackLine(rowOf(h, "Your delivery on Thursday"), "Sent by Pat Owner with Jack"), brief(rowOf(h, "Your delivery on Thursday")));
  ok("1d Riley's own text and email (sent by hand) have no Jack line", noJackLine(rowOf(h, "it's Riley from Acme Sheds")) && noJackLine(rowOf(h, "Your shed estimate")),
    `${brief(rowOf(h, "it's Riley from Acme Sheds"))} ${brief(rowOf(h, "Your shed estimate"))}`);
  ok("1e Alex's own reply has no Jack line", noJackLine(rowOf(h, "Can you deliver this Thursday?")), brief(rowOf(h, "Can you deliver this Thursday?")));
  ok("1f exactly two Jack lines on the record, and nobody but Pat is named with Jack",
    h.filter((r) => r.bylines).length === 2 && (allText(h).match(/Sent by [^\n]* with Jack/g) || []).every((s) => s === "Sent by Pat Owner with Jack"),
    JSON.stringify(allText(h).match(/Sent[^\n]*Jack/g)));
  ok("1g the words of every text and email are on the page",
    [T.s1RileyText.body, "Your estimate for the 10x12 Garden Shed is attached", T.s1In.body, T.s1JackText.body, "Thursday is booked for your 10x12 Garden Shed"].every((w) => allText(h).includes(w)));
  await proof("p01-teammate-sent-with-jack", G1, "A teammate's text and email sent with Jack, beside the rep's own",
    "Signed in as Riley Rep (riley@example.test, at the foot of the menu), Riley opens Alex Tester's record, History (All). The email \"Your delivery on Thursday\" and the text \"Hi Alex, yes, Thursday works...\" that her teammate Pat sent with Jack each have the grey line \"Sent by Pat Owner with Jack\" under their words; Riley's own text and email from Nov 5 and Alex's reply have no Jack line.");

  // The filter chips keep the line: Emails only, then SMS only.
  await page.locator("[data-ss-crm-chip=\"emails\"]").click();
  await until(() => (window.__ssHistory() || []).length === 2);
  h = await history();
  ok("1h the Emails filter: just the two emails, the Jack one still says \"Sent by Pat Owner with Jack\", Riley's still says nothing",
    h.length === 2 && jackLine(rowOf(h, "Your delivery on Thursday"), "Sent by Pat Owner with Jack") && noJackLine(rowOf(h, "Your shed estimate")),
    h.map(brief).join(" "));
  await proof("p02-emails-filter", G1, "The Emails filter on the same record",
    "Still signed in as Riley Rep, the same record with the Emails filter pressed: only the two emails. Pat's \"Your delivery on Thursday\" still says \"Sent by Pat Owner with Jack\"; Riley's own \"Your shed estimate\" has no Jack line.");
  await page.locator("[data-ss-crm-chip=\"messages\"]").click();
  await until(() => (window.__ssHistory() || []).length === 3);
  h = await history();
  ok("1i the SMS filter: the three texts, only the one Jack sent says \"Sent by Pat Owner with Jack\"",
    h.length === 3 && jackLine(rowOf(h, "Hi Alex, yes, Thursday works"), "Sent by Pat Owner with Jack")
      && noJackLine(rowOf(h, "it's Riley from Acme Sheds")) && noJackLine(rowOf(h, "Can you deliver this Thursday?")),
    h.map(brief).join(" "));
  await page.locator("[data-ss-crm-chip=\"all\"]").click();

  // ── 2. An operator in view-as ─────────────────────────────────────────────────────────────────────
  const G2 = "2. Sent with Jack by the Structure Studio team";
  h = await openRecord(C.s2, "Just checking you had a chance");
  ok("2a the server's feed: the operator's email is byOperator with no name (app_operators says so; their other team's name is not this builder's)",
    same(who(C.s2, T.s2OpEmail), ["jack", null, true]), JSON.stringify(who(C.s2, T.s2OpEmail)));
  ok("2b under the email: \"Sent by the Structure Studio team with Jack\" (two words, like every other team line)",
    jackLine(rowOf(h, "Following up on your estimate"), "Sent by the Structure Studio team with Jack"), brief(rowOf(h, "Following up on your estimate")));
  ok("2c Riley's own email on the same record has no Jack line", noJackLine(rowOf(h, "Your shed estimate")), brief(rowOf(h, "Your shed estimate")));
  ok("2d the operator's name (Olive Operator, on another builder's team) is nowhere on the page", !/Olive/.test(await bodyText()));
  await proof("p03-structurestudio-team", G2, "An email a Structure Studio operator sent with Jack in view-as",
    "Blair Sample's record, as Riley sees it. The email \"Following up on your estimate\", which an operator sent with Jack while viewing this builder's account, says \"Sent by the Structure Studio team with Jack\" under it; Riley's own \"Your shed estimate\" has no Jack line, and the operator's own name appears nowhere.");

  // ── 3. Someone no longer on the team, and a teammate with no name set ──────────────────────────────
  const G3 = "3. Sent with Jack by someone no longer on the team";
  h = await openRecord(C.s3, "just checking you got the estimate");
  ok("3a the server's feed: both removed reps are \"a former team member\" (never their name on another team, never the platform); the nameless teammate is \"a team member\"",
    same(who(C.s3, T.s3GoneText), ["jack", "a former team member", null]) && same(who(C.s3, T.s3GoneElseEmail), ["jack", "a former team member", null])
      && same(who(C.s3, T.s3NoNameEmail), ["jack", "a team member", null]),
    JSON.stringify([T.s3GoneText, T.s3GoneElseEmail, T.s3NoNameEmail].map((r) => who(C.s3, r))));
  ok("3b under the text from a rep who has left: \"Sent by a former team member with Jack\"",
    jackLine(rowOf(h, "just checking you got the estimate"), "Sent by a former team member with Jack"), brief(rowOf(h, "just checking you got the estimate")));
  ok("3c under the email from a rep who left for another builder: \"Sent by a former team member with Jack\"",
    jackLine(rowOf(h, "Your estimate, one more time"), "Sent by a former team member with Jack"), brief(rowOf(h, "Your estimate, one more time")));
  ok("3d under the email from a teammate with no name set: \"Sent by a team member with Jack\"",
    jackLine(rowOf(h, "Your delivery window"), "Sent by a team member with Jack"), brief(rowOf(h, "Your delivery window")));
  const t3 = await bodyText();
  ok("3e neither the other builder's name for that rep (Rita Elsewhere) nor the Structure Studio team is on the page", !/Rita/.test(t3) && !/Structure ?Studio team/.test(t3));
  await proof("p04-former-team-member", G3, "Messages sent with Jack by people no longer on the team",
    "Casey Example's record. The text \"Hi Casey, just checking you got the estimate...\" and the email \"Your estimate, one more time\" each say \"Sent by a former team member with Jack\"; \"Your delivery window\", from a teammate who never set a name, says \"Sent by a team member with Jack\".");

  // ── 4. Nobody can be named ───────────────────────────────────────────────────────────────────────
  const G4 = "4. Sent with Jack, nobody named";
  h = await openRecord(C.s4a, "ready to schedule");
  ok("4a the server's feed: stamped with Jack, no sender recorded, so no name and not the platform",
    same(who(C.s4a, T.s4aText), ["jack", null, null]) && same(who(C.s4a, T.s4aEmail), ["jack", null, null]),
    JSON.stringify([who(C.s4a, T.s4aText), who(C.s4a, T.s4aEmail)]));
  ok("4b under the text and the email: \"Sent with Jack\", naming nobody",
    jackLine(rowOf(h, "Hi Drew, your shed is ready"), "Sent with Jack") && jackLine(rowOf(h, "Ready to schedule"), "Sent with Jack") && !/Sent by/.test(allText(h)),
    `${brief(rowOf(h, "Hi Drew, your shed is ready"))} ${brief(rowOf(h, "Ready to schedule"))}`);
  await proof("p05-no-sender-recorded", G4, "Sent with Jack, no sender recorded",
    "Drew Placeholder's record. The text \"Hi Drew, your shed is ready to schedule...\" and the email \"Ready to schedule\" were stamped as sent with Jack with no sender recorded, so each says only \"Sent with Jack\".");

  h = await openRecord(C.s4b, "Lofted Barn is in stock");
  const a4 = FEEDS[C.s4b.id]?.asked || {};
  ok("4c the team list read failed (client_users timed out), and no operator read was made without it",
    (a4.client_users || []).length === 1 && a4.app_operators === undefined, JSON.stringify({ client_users: a4.client_users, app_operators: a4.app_operators }));
  ok("4d the server's feed: Pat's text and the operator's email both name nobody; Riley's own text carries nothing",
    same(who(C.s4b, T.s4bPatText), ["jack", null, null]) && same(who(C.s4b, T.s4bOpEmail), ["jack", null, null]) && same(who(C.s4b, T.s4bRileyText), [null, null, null]),
    JSON.stringify([T.s4bPatText, T.s4bOpEmail, T.s4bRileyText].map((r) => who(C.s4b, r))));
  ok("4e under Pat's text and under the operator's email: \"Sent with Jack\", naming nobody",
    jackLine(rowOf(h, "Lofted Barn is in stock"), "Sent with Jack") && jackLine(rowOf(h, "Holding your barn"), "Sent with Jack"),
    `${brief(rowOf(h, "Lofted Barn is in stock"))} ${brief(rowOf(h, "Holding your barn"))}`);
  const t4 = allText(h);
  ok("4f with the team unread, the timeline credits nobody: not Pat, not the Structure Studio team; Riley's own text has no Jack line",
    !/Pat Owner/.test(t4) && !/Structure ?Studio team/.test(await bodyText()) && noJackLine(rowOf(h, "this is Riley")), brief(rowOf(h, "this is Riley")));
  await proof("p06-team-list-unreadable", G4, "Sent with Jack while the team list couldn't be read",
    "Emery Fixture's record, read while the team list timed out. Pat's text \"Hi Emery, the 12x16 Lofted Barn is in stock...\" and the operator's email \"Holding your barn\" each say only \"Sent with Jack\", naming nobody; Riley's own text has no Jack line.");

  // ── 5. Before migration 378 ──────────────────────────────────────────────────────────────────────
  const G5 = "5. Before migration 378";
  h = await openRecord(C.s5, "What is the lead time?");
  const a5 = FEEDS[C.s5.id]?.asked || {};
  ok("5a the database refused the reads naming sent_with (42703), and each was asked again without it",
    (a5.sms_messages || []).length === 2 && /\bsent_with\b/.test(a5.sms_messages[0]) && !/\bsent_with\b/.test(a5.sms_messages[1])
      && (a5.email_sends || []).length === 2 && /\bsent_with\b/.test(a5.email_sends[0]) && !/\bsent_with\b/.test(a5.email_sends[1])
      && /\bbody_text\b/.test(a5.email_sends[1]) && /\bopened_at\b/.test(a5.email_sends[1]),
    JSON.stringify({ sms: a5.sms_messages, email: a5.email_sends }));
  const after = await buildCrmFeed(fakeAdmin(TABLES).admin, CLIENT, { codes: [], contactId: C.s5.id, ...FEED_FOR_VIEWER });
  ok("5b the record before 378 lists exactly what the same record lists after it (these were never Jack sends)",
    same(FEEDS[C.s5.id]?.feed, after), `${FEEDS[C.s5.id]?.feed.length} vs ${after.length}`);
  const words5 = [T.s5Text1.body, T.s5In.body, T.s5Text2.body, "Lead time and next steps", "Lead time is about three weeks", "Colour samples", "Here are the colour samples you asked about"];
  ok("5c every text and email is on the page with its words", h.length === 5 && words5.every((w) => allText(h).includes(w)), words5.filter((w) => !allText(h).includes(w)).join(" | "));
  const chips5 = await page.evaluate(() => ["emails", "messages"].map((k) => document.querySelector(`[data-ss-crm-chip="${k}"]`)?.innerText));
  ok("5d the filter counts say so: Emails (2), SMS (3)", same(chips5, ["Emails (2)", "SMS (3)"]), JSON.stringify(chips5));
  ok("5e the email that was opened still says Opened (262's columns are still read)", /Opened/.test(rowOf(h, "Colour samples")?.text || ""), brief(rowOf(h, "Colour samples")));
  const t5 = await bodyText();
  ok("5f no Jack line anywhere, and no error", h.every((r) => r.bylines === 0) && !/with Jack/.test(t5) && !/Not found/.test(t5)
    && (await page.locator("[data-ss-crm-sent-with]").count()) === 0);
  await proof("p07-before-migration-378", G5, "The record before migration 378",
    "Finley Mock's record against a database without migration 378 (it refuses any read naming sent_with). All three texts and both emails are listed with their words, \"Colour samples\" still shows Opened, there is no Jack line anywhere, and no error.");

  // ── 6. An estimate resent with Jack ──────────────────────────────────────────────────────────────
  const G6 = "6. An estimate resent with Jack";
  h = await openRecord(C.s6, "Quote emailed to");
  const qs = FEEDS[C.s6.id]?.feed.find((e) => e.id === `qs:${ESTIMATE_CODE}`);
  ok("6a the server's feed: the resend carries via jack and Pat's name; the first send and the estimate's own sent line carry nothing",
    same(who(C.s6, T.s6Resend), ["jack", "Pat Owner", null]) && same(who(C.s6, T.s6First), [null, null, null]) && !!qs && !("via" in qs),
    JSON.stringify([who(C.s6, T.s6Resend), who(C.s6, T.s6First), qs]));
  const resend = rowOf(h, `Quote emailed to ${C.s6.email}`, "Nov 6, 2026");
  ok("6b the resend's line: \"Quote emailed to gray@example.test\", the estimate's subject, and \"Sent by Pat Owner with Jack\" under it",
    jackLine(resend, "Sent by Pat Owner with Jack") && resend.text.includes(`Your estimate ${ESTIMATE_NO} from ${COMPANY}`), brief(resend));
  ok("6c the first send of the same estimate (Nov 1) has no Jack line", noJackLine(rowOf(h, `Quote emailed to ${C.s6.email}`, "Nov 1, 2026")), brief(rowOf(h, `Quote emailed to ${C.s6.email}`, "Nov 1, 2026")));
  ok("6d the estimate's own \"sent\" line (the feed words it \"Quote SSQ-1042 sent\") has no Jack line", noJackLine(rowOf(h, `Quote ${ESTIMATE_NO} sent`)), brief(rowOf(h, `Quote ${ESTIMATE_NO} sent`)));
  ok("6e exactly one Jack line on the record", h.filter((r) => r.bylines).length === 1, String(h.filter((r) => r.bylines).length));
  ok("6f the order the shot describes: the estimate's own sent line on top, the resend (the newest email) right under it",
    (h[0]?.text || "").includes(`Quote ${ESTIMATE_NO} sent`) && h[1] === resend, h.slice(0, 2).map(brief).join(" "));
  await proof("p08-estimate-resent", G6, "An estimate resent with Jack",
    "Gray Demo's record, newest first. The top line, \"Quote SSQ-1042 sent\" (Nov 6), is the estimate's own sent line and has no Jack line. Right under it is the newest email, the resend: \"Quote emailed to gray@example.test\" (Nov 6) with the subject \"Your estimate SSQ-1042 from Acme Sheds\" and \"Sent by Pat Owner with Jack\" under it. The first send of the same estimate (Nov 1) has no Jack line. (These timeline lines still say \"Quote\": that is the record page's older wording, not this round's.)");

  ok("Z1 every record asked for was a known customer", crmMissing.length === 0, crmMissing.join(","));
  ok("Z2 no uncaught page errors or console errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  await ctx.close();
} finally {
  await browser.close();
}

writeManifest();
console.log(`\nshots: ${SHOTS} (${MANIFEST.length}, manifest.json beside them)`);
const bad = failed();
if (bad.length) { console.error(`\n${bad.length} check(s) failed`); process.exit(1); }
console.log("\nALL HELD");
