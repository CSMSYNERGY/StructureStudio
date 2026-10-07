// Email read tracking (Carolyn 2026-10-01: "One of the potential clients to sign up asked to be
// able to see if an email is read or not"), migration 262. The StructureStudio half:
//   * crmFeed labels our emails Opened / Delivered / Bounced / Marked as spam (emailDelivery), reads 262's columns
//     and still shows every email, words included, on a database 262 has not reached;
//   * email_verify_domain switches Resend's open tracking on once a domain verifies, and takes its
//     verdict from the read BEFORE it (a pending tracking record must never become "pending"
//     sending, which is what every email is gated on);
//   * email_tracking_check (the Email Settings opens card) never writes the sending status;
//   * email-inbound drops Resend's delivery events if they ever reach it;
//   * postmark-events writes through record_email_event only;
//   * the portal draws the label, the opens card and the caveat sentence;
//   * the webmaster email keeps every required record inside its 1,900-character budget, dropping
//     the optional opens record first (webmasterMailto, lifted from the component and run).
// The events handler and record_email_event are tested on their own in
// supabase/functions/_shared/_test_stubs/postmarkEvents_test.ts and tests/sql/migration262.test.cjs,
// and the Worker's mapping in workers/phone-api/test. This file reads the SHIPPED source (slice
// between stable anchors, fail loudly if they move), the way emailConversation_test.ts does.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrmFeed, emailDelivery } from "../../supabase/functions/_shared/crmFeed.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
/** Whole-line `//` comments removed, so a comment that NAMES a field cannot satisfy a check. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const SETTINGS = code(await read("../../supabase/functions/portal-settings/index.ts"));
const INBOUND = code(await read("../../supabase/functions/email-inbound/index.ts"));
const EVENTS = code(await read("../../supabase/functions/postmark-events/index.ts"));
const SALES = await read("../../portal/02-sales.jsx");
const INTEG = await read("../../portal/08-integrations.jsx");
const COMPILED = await read("../../portal.app.compiled.js");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`emailOpens_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

const CAVEAT = "Opens are approximate: some mail apps block the tracking image, and some open emails automatically.";

// ── crmFeed ─────────────────────────────────────────────────────────────────────────────

Deno.test("emailDelivery: Bounced over Opened over Delivered; nothing while it is only sent, sending or failed", () => {
  const at = "2026-10-04T14:00:00Z";
  assertEquals(emailDelivery({ status: "delivered", delivered_at: at, opened_at: at, open_count: 3 }), { label: "Opened", openedAt: at, openCount: 3 });
  assertEquals(emailDelivery({ status: "sent", opened_at: at, open_count: 1 })?.label, "Opened", "an open stands even when the delivery receipt never came");
  assertEquals(emailDelivery({ status: "bounced", bounced_at: at, opened_at: at, open_count: 1 })?.label, "Bounced", "a bounce is the news to act on");
  assertEquals(emailDelivery({ status: "delivered", delivered_at: at, open_count: 0 }), { label: "Delivered", openedAt: null, openCount: 0 });
  assertEquals(emailDelivery({ status: "sent", delivered_at: at })?.label, "Delivered");
  assertEquals(emailDelivery({ status: "sent" }), null);
  assertEquals(emailDelivery({ status: "claimed", delivered_at: at }), null);
  assertEquals(emailDelivery({ status: "failed", delivered_at: at }), null);
  assertEquals(emailDelivery({ status: "sent", opened_at: at, open_count: 0 })?.openCount, 1, "an open time means at least one open");
  assertEquals(emailDelivery(null), null);
});

Deno.test("emailDelivery: a complaint (complained_at) reads Marked as spam, never Bounced", () => {
  // 262 keeps email.complained in complained_at and leaves the status alone: the email ARRIVED, so
  // "Bounced, check the address and send again" would be false, and the worst advice there is.
  const at = "2026-10-04T14:00:00Z";
  assertEquals(emailDelivery({ status: "delivered", delivered_at: at, complained_at: at }), { label: "Marked as spam", openedAt: null, openCount: 0 });
  assertEquals(emailDelivery({ status: "delivered", opened_at: at, open_count: 2, complained_at: at }), { label: "Marked as spam", openedAt: at, openCount: 2 },
    "opened, then reported: still Marked as spam, never Opened");
  assertEquals(emailDelivery({ status: "bounced", bounced_at: at })?.label, "Bounced", "a bounce is a bounce");
  assertEquals(emailDelivery({ status: "bounced", bounced_at: null })?.label, "Bounced", "a bounced status alone is never read as a complaint");
  assertEquals(emailDelivery({ status: "delivered", complained_at: null })?.label, "Delivered");
});

function stubAdmin(rows: unknown[], asked: string[], refuse: RegExp | null = null) {
  return {
    from: (table: string) => {
      let cols = "";
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
      b.select = (c: string) => { cols = c; if (table === "email_sends") asked.push(c); return b; };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(
        table !== "email_sends" ? { data: [], error: null }
          : refuse && refuse.test(cols) ? { data: null, error: { code: "42703", message: "column does not exist" } }
          : { data: rows, error: null },
      ).then(res, rej);
      return b;
    },
    storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) },
  };
}

const CONTACT = "11111111-1111-4111-8111-111111111111";
const ROWS = [
  { id: "e1", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Your shed", status: "delivered",
    body_text: "Hi Cam", delivered_at: "2026-10-04T12:00:05Z", opened_at: "2026-10-04T13:00:00Z", open_count: 2, created_at: "2026-10-04T12:00:00Z" },
  { id: "e2", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Delivery", status: "bounced",
    body_text: "Tuesday?", bounced_at: "2026-10-04T11:00:05Z", created_at: "2026-10-04T11:00:00Z" },
  // A complaint: 262 keeps it in complained_at, and the status stays delivered.
  { id: "e5", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Offer", status: "delivered",
    body_text: "Ten percent off", delivered_at: "2026-10-04T08:00:05Z", opened_at: "2026-10-04T08:30:00Z", open_count: 1,
    complained_at: "2026-10-04T08:31:00Z", created_at: "2026-10-04T08:00:00Z" },
  { id: "e3", kind: "estimate", short_code: "SS-DEMO2345", to_email: "cam@example.test", subject: "Your quote", status: "delivered",
    delivered_at: "2026-10-04T10:00:05Z", created_at: "2026-10-04T10:00:00Z" },
  { id: "e4", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Oops", status: "failed",
    body_text: "Never went", created_at: "2026-10-04T09:00:00Z" },
];

Deno.test("buildCrmFeed: email rows carry the label in meta, and Delivered/Bounced leave the text; failed still says so", async () => {
  const asked: string[] = [];
  const feed = await buildCrmFeed(stubAdmin(ROWS, asked), "demo-tenant", { codes: ["SS-DEMO2345"], contactId: CONTACT });
  assertEquals(asked.length, 1);
  for (const col of ["opened_at", "open_count", "complained_at", "delivered_at", "bounced_at", "body_text"]) {
    assert(asked[0].includes(col), `email_sends is read with ${col}: ${asked[0]}`);
  }
  const byId = (id: string) => feed.find((e) => e.id === `e:${id}`)!;
  assertEquals(byId("e1").meta, { delivery: "Opened", openedAt: "2026-10-04T13:00:00Z", openCount: 2 });
  assertEquals(byId("e1").title, "Your shed");
  assertEquals([byId("e2").title, byId("e2").meta?.delivery], ["Delivery", "Bounced"], "no '(bounced)' in the title any more: the label says it");
  assertEquals([byId("e3").title, byId("e3").meta?.delivery], ["Estimate emailed to cam@example.test", "Delivered"]);
  assertEquals([byId("e4").title, byId("e4").meta ?? null], ["Oops (failed)", null], "a failed send keeps its words in the title");
  assertEquals([byId("e5").title, byId("e5").meta?.delivery], ["Offer", "Marked as spam"], "a complaint is not a bounce, and no '(bounced)' either");
});

Deno.test("buildCrmFeed ahead of migration 262: asked again without the open columns, and the words stay", async () => {
  const asked: string[] = [];
  const rows = ROWS.map(({ opened_at: _o, open_count: _c, complained_at: _p, ...r }) => r);
  const feed = await buildCrmFeed(stubAdmin(rows, asked, /\bopened_at\b/), "demo-tenant", { codes: [], contactId: CONTACT });
  assertEquals(asked.length, 2, "with 262's columns, then without them");
  assert(asked[1].includes("body_text") && !asked[1].includes("opened_at") && !asked[1].includes("complained_at"), `the retry keeps body_text: ${asked[1]}`);
  const e1 = feed.find((e) => e.id === "e:e1")!;
  assertEquals([e1.body, e1.meta?.delivery], ["Hi Cam", "Delivered"]);
});

// ── portal-settings ───────────────────────────────────────────────────────────────────

Deno.test("email_verify_domain switches open tracking on, with the verdict taken from the read before it", () => {
  const verify = slice(SETTINGS, `if (action === "email_verify_domain") {`, `if (action === "email_tracking_check") {`, "email_verify_domain");
  const verdict = verify.indexOf("const verified = rsDomainVerified(d);");
  const enable = verify.indexOf("shown = await rsEnableOpenTracking(String(cur.resend_domain_id), d);");
  assert(verdict > 0 && enable > verdict, "the sending verdict is read BEFORE tracking is switched on");
  assert(verify.includes("if (verified && !rsOpenTrackingConfigured(d)) {"), "only a verified domain without tracking is switched on");
  assert(verify.includes("const dnsRecords = dnsRecordsOf(shown);"), "the records shown include the new tracking CNAME");
  assert(!/rsDomainVerified\(shown\)/.test(verify) && !/shown\.status/.test(verify), "nothing read after the switch-on decides the sending status");
  // A refusal costs the opens, never the verification.
  const tryBlock = slice(verify, "if (verified && !rsOpenTrackingConfigured(d)) {", "const dnsRecords = dnsRecordsOf(shown);", "the switch-on");
  assert(tryBlock.includes("} catch (e) {") && !tryBlock.includes("return "), "a failed switch-on is logged and the verify still answers");
  assert(verify.includes("openTracking: openTrackingState(shown)"), "the answer says where tracking stands");
});

Deno.test("email_tracking_check is gated like the other email actions and never writes the sending status", () => {
  assert(SETTINGS.includes(`email_tracking_check:     { area: "settings_email", level: "edit" },`), "GATES entry");
  const check = slice(SETTINGS, `if (action === "email_tracking_check") {`, `if (action === "email_activate") {`, "email_tracking_check");
  assert(check.includes(`if (cur.email_domain_status !== "verified") {`), "only for a verified sending domain");
  const update = slice(check, `.update({`, `}).eq("client_id", clientId);`, "the snapshot write");
  assert(!/email_domain_status|email_verified_at|email_provider|email_last_error/.test(update), `only the records are written: ${update}`);
  assert(update.includes("email_dns_records: dnsRecords,"));
});

Deno.test("email_tracking_check asks Resend to look at most once per window, and keeps the time on the snapshot", () => {
  // The verify POST re-parks the whole domain while Resend re-checks; every press used to POST
  // again and restart it, so the card never reached "On". rsCheckOpenTracking (resend.ts, unit
  // tested in resend.test.ts) owns the rule; this checks the handler feeds it and keeps its answer.
  const check = slice(SETTINGS, `if (action === "email_tracking_check") {`, `if (action === "email_activate") {`, "email_tracking_check");
  assert(check.includes(`.select("resend_domain_id, email_domain_status, email_dns_records")`), "the stored snapshot is read for the last ask");
  assert(check.includes("const askedAt = trackingAskedAt(cur.email_dns_records);"));
  assert(check.includes("({ domain: d, checking, asked, notFound } = await rsCheckOpenTracking(String(cur.resend_domain_id), askedAt));"),
    "the one helper decides whether to POST, given when we last asked");
  assert(!/rsVerifyDomain\(/.test(check), "no verify POST of its own outside that rule");
  assert(check.includes("const stamp = asked ? new Date().toISOString() : checking && askedAt != null ? new Date(askedAt).toISOString() : null;"),
    "a new ask is stamped now; inside the window the old stamp is carried forward");
  assert(check.includes("dnsRecordsOf(d).map((r) => (r.tracking && stamp ? { ...r, askedAt: stamp } : r))"), "only the tracking rows carry it");
  assert(check.includes(`openTracking: notFound ? "not_found" : checking ? "checking" : openTrackingState(d)`),
    "the card is told a check is running, or that the last one is over and found nothing");
  const asked = slice(SETTINGS, "function trackingAskedAt(rows: unknown): number | null {", "\n}\n", "trackingAskedAt");
  assert(asked.includes("row.tracking === true && typeof row.askedAt === \"string\""), "only a tracking row's stamp counts");
  assert(asked.includes("Number.isFinite(t)"), "an unreadable stamp is no stamp");
});

Deno.test("dnsRecordsOf marks the tracking record; email_status lists opens and survives a database without them", () => {
  const rows = slice(SETTINGS, "function dnsRecordsOf(d: RsDomain): DnsRow[] {", "function openTrackingState(", "dnsRecordsOf");
  assert(rows.includes("const tracking = new Set(rsTrackingRecords(d));") && rows.includes("...(tracking.has(r) ? { tracking: true as const } : {}),"));
  const status = slice(SETTINGS, `if (action === "email_status") {`, `if (action === "email_save_template") {`, "email_status");
  assert(status.includes(`created_at, opened_at, complained_at");`), "recent sends are read with opened_at and complained_at");
  assert(status.includes(`["42703", "PGRST204"].includes(String(sendsErr.code))`), "and again without them on a missing column");
  assert(status.includes("openedAt: r.opened_at ?? null,"));
  assert(status.includes("complainedAt: r.complained_at ?? null,"));
  // Email Settings' recent sends name a complaint too, rather than showing it as delivered or opened.
  assert(INTEG.includes(`const shown = sd.complainedAt ? "marked as spam"`), "recent sends show a complaint first");
  assert(INTEG.includes(`s === "marked as spam"`), "in the red, like a bounce");
});

// ── the two webhooks ──────────────────────────────────────────────────────────────────

Deno.test("email-inbound drops any typed event that is not email.received, before anything else runs", () => {
  const guard = INBOUND.indexOf(`if (eventType && eventType !== "email.received") return json({ ok: true, ignored: "not an inbound email" });`);
  assert(guard > 0, "the type guard is there");
  assert(guard < INBOUND.indexOf("rsGetReceivedEmail(receivedId)"), "before the received-email fetch");
  assert(guard < INBOUND.indexOf(`from("email_inbound").insert(`), "and before the insert");
});

Deno.test("postmark-events writes through record_email_event alone", () => {
  assert(EVENTS.includes(`admin.rpc("record_email_event", {`));
  assert(EVENTS.includes(`p_event_id: eventKey(req.headers.get("svix-id"), body, mapped),`), "the svix-id is the idempotency key");
  assert(!/from\("email_sends"\)/.test(EVENTS), "no direct table write: the function is what makes it idempotent");
});

// ── the portal ────────────────────────────────────────────────────────────────────────

Deno.test("the record page labels our emails, with the caveat in the Opened tooltip", () => {
  assert(SALES.includes(`{e.type === "email" && <SsEmailDeliveryChip meta={e.meta} />}`), "the History draws the label on email rows");
  assert(SALES.includes(`"Opens are approximate: some mail apps block the tracking image, and some open emails automatically."`));
  for (const label of ["Opened", "Delivered", "Bounced"]) assert(new RegExp(`\\b${label}: \\{ bg:`).test(SALES), `${label} has a tone`);
  assert(SALES.includes(`"Marked as spam": { bg:`), "Marked as spam has a tone");
  assert(SALES.includes(`"They marked this email as spam. Don't email them again."`), "and its own tooltip");
  assert(SALES.includes(`"The customer's mail server refused it, or it wasn't sent because an earlier email to this address bounced or was marked as spam. Check the address before sending again."`),
    "the Bounced tooltip covers a suppressed send (never sent), not a complaint on this email (that one arrived)");
});

Deno.test("Email Settings has the opens card, its button, the caveat, and labels the record optional everywhere", () => {
  assert(INTEG.includes(`act({ action: "email_tracking_check" }`), "the card's button calls the tracking check");
  assert(INTEG.includes(">See when emails are opened<"));
  assert(INTEG.includes(CAVEAT), "the caveat sentence is on the screen");
  assert(INTEG.includes(`const trackRows = dns.filter((r) => r.tracking);`));
  assert(INTEG.includes(`r.tracking ? "  (optional, email opens; DNS only on Cloudflare)"`),
    "the webmaster email marks it optional, and DNS only on Cloudflare, in a label short enough for the mailto budget");
  assert(INTEG.includes("optional · email opens"), "the DNS table marks it optional");
  assert(INTEG.includes("Checking now. This takes a few minutes, so press Check it again in about 5 minutes."),
    "a running check says when to come back, not \"not seen yet\"");
  assert(INTEG.includes(`else if (d.openTracking === "not_found") setTrackNote("Our last look didn't find this record. Check it's added exactly as shown, and on Cloudflare set it to DNS only (the grey cloud). We've asked again, so press Check it in about 5 minutes.");`),
    "a finished look that found nothing says so, and sends the builder back to the record");
  assert(INTEG.indexOf(`d.openTracking === "not_found"`) < INTEG.indexOf(`d.openTracking === "checking"`), "and is told apart before \"checking\"");
});

Deno.test("the tracking CNAME says DNS only (grey cloud) wherever it is handed out", () => {
  // Cloudflare proxies a new CNAME by default; a proxied CNAME is flattened, Resend never sees it,
  // and the card waits forever. The other records are TXT and MX, which Cloudflare cannot proxy.
  assert(INTEG.includes("DNS only (grey cloud) on Cloudflare"), "the pending DNS table");
  assert(INTEG.includes("it to <strong>DNS only</strong> (the grey cloud), not Proxied."), "the opens card's one record to add");
  assert(INTEG.includes("DNS only on Cloudflare)"), "the webmaster email's row label");
  assert(INTEG.includes('set ${oneOpt ? "it" : "them"} to "DNS only" (the grey cloud), not "Proxied"'), "and the full email's note");
});

// ── the webmaster email's 1,900-character budget ──────────────────────────────────────
// webmasterMailto is lifted out of the SHIPPED component (slice between stable anchors) and run on
// record shapes like Resend's: a 1024-bit DKIM TXT, the SPF MX and TXT, the links CNAME, the reply
// MX and the DMARC advisory row. It reads dnsRows, dnsAdvisory, dnsApex and status, nothing else.
const MAILTO_SRC = slice(INTEG, "const webmasterMailto = (() => {", "\n  })();\n", "webmasterMailto")
  .slice("const webmasterMailto = ".length) + "\n  })()";
const runMailto = new Function("dnsRows", "dnsAdvisory", "dnsApex", "status", `return ${MAILTO_SRC};`) as (
  dnsRows: unknown[], dnsAdvisory: unknown[], dnsApex: string, status: { domain: string },
) => string;

// 216 characters with a few slashes, the shape of the live 1024-bit key (not its value).
const DKIM = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ" + "Dz4kQx7Lm2Ns9Vb3Rt8Yp1Wc6Hj5Kd0Fg/AeZu4Xy7Bn2Mq8".repeat(4).slice(0, 170) + "IDAQAB";
type Row = { type: string; host: string; value: string; priority?: number; tracking?: true; advisory?: true };
function mailtoFor(dom: string, opts: { tracking: boolean; inbound: boolean }) {
  const dns: Row[] = [
    { type: "TXT", host: `resend._domainkey.${dom}`, value: DKIM },
    { type: "MX", host: `send.${dom}`, value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
    { type: "TXT", host: `send.${dom}`, value: "v=spf1 include:amazonses.com ~all" },
    ...(opts.tracking ? [{ type: "CNAME", host: `links.${dom}`, value: "links1.resend-dns.com", tracking: true as const }] : []),
  ];
  const inbound: Row[] = opts.inbound ? [{ type: "MX", host: "reply", value: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 }] : [];
  const advisory: Row[] = [{ type: "TXT", host: `_dmarc.${dom}`, value: `v=DMARC1; p=none; rua=mailto:info@${dom}`, advisory: true }];
  const rows = dns.concat(inbound, advisory);
  const url = runMailto(rows, advisory, dom, { domain: dom });
  const body = decodeURIComponent(url.split("&body=")[1] ?? "");
  return { url, body, required: rows.filter((r) => !r.tracking), tracked: rows.filter((r) => r.tracking) };
}
const hasRow = (body: string, r: Row) => body.includes(`Name/Host: ${r.host}\n   Value:     ${r.value}`);
const domainOf = (n: number) => `${"x".repeat(n - 4)}.com`;
/** The shortest domain (replies on) whose email has no room left for the opens record. */
const firstWithoutOpens = (() => {
  for (let n = 8; n <= 100; n++) {
    const m = mailtoFor(domainOf(n), { tracking: true, inbound: true });
    if (!m.tracked.every((r) => hasRow(m.body, r))) return n;
  }
  throw new Error("emailOpens_test: the opens record never drops out — the budget test has nothing to test");
})();

Deno.test("webmasterMailto: a 35-character domain with replies and opens on still carries every required record", () => {
  const m = mailtoFor(domainOf(35), { tracking: true, inbound: true });
  assert(m.url.length <= 1900, `inside the budget: ${m.url.length}`);
  for (const r of m.required) assert(hasRow(m.body, r), `${r.type} ${r.host} is in the email:\n${m.body}`);
  assert(!m.body.includes("that I am sending separately"), "not the no-records fallback");
});

Deno.test("webmasterMailto: the optional opens record rides along while it fits, labelled DNS only on Cloudflare", () => {
  const m = mailtoFor("examplesheds.test", { tracking: true, inbound: true });
  assert(m.url.length <= 1900, `inside the budget: ${m.url.length}`);
  for (const r of [...m.required, ...m.tracked]) assert(hasRow(m.body, r), `${r.type} ${r.host} is in the email`);
  assert(m.body.includes("CNAME record  (optional, email opens; DNS only on Cloudflare)"), m.body);
});

Deno.test("webmasterMailto: the opens record goes before any required one, and switching opens on never costs a required record", () => {
  // Past some length (replies on, about 38 characters with a live-sized key) not every record fits:
  // the optional one goes, and the email says one more is coming.
  assert(firstWithoutOpens > 35, `a 35-character domain still gets the opens record too (it drops from ${firstWithoutOpens})`);
  const m = mailtoFor(domainOf(firstWithoutOpens), { tracking: true, inbound: true });
  assert(m.url.length <= 1900, `inside the budget: ${m.url.length}`);
  for (const r of m.required) assert(hasRow(m.body, r), `${r.type} ${r.host} is in the email`);
  assert(!m.body.includes(`links.${domainOf(firstWithoutOpens)}`), "the optional record is the one left out");
  assert(m.body.includes("One more record is optional: it lets us see when emails are opened. I will send it separately."), m.body);
  // Every domain length, replies on or off: wherever the email WITHOUT an opens record carries the
  // required records, the one WITH it carries them too.
  for (const inbound of [true, false]) {
    for (let n = 8; n <= 100; n++) {
      const without = mailtoFor(domainOf(n), { tracking: false, inbound });
      const withIt = mailtoFor(domainOf(n), { tracking: true, inbound });
      assert(withIt.url.length <= 1900, `${n} chars: over the budget (${withIt.url.length})`);
      if (without.required.every((r) => hasRow(without.body, r))) {
        for (const r of withIt.required) assert(hasRow(withIt.body, r), `${n} chars, inbound ${inbound}: ${r.type} ${r.host} dropped for the optional record`);
      }
    }
  }
});

Deno.test("the opens card promises the webmaster email carries its record only when it does", () => {
  assert(INTEG.includes("const webmasterHasTracking = trackRows.length > 0 && trackRows.every((r) => webmasterMailto.includes(encodeURIComponent(`Name/Host: ${r.host}`)));"));
  assert(INTEG.includes("{webmasterHasTracking\n"), "the card's note depends on it");
  const long = mailtoFor(domainOf(firstWithoutOpens), { tracking: true, inbound: true });
  assert(!long.url.includes(encodeURIComponent(`Name/Host: links.${domainOf(firstWithoutOpens)}`)), "a long domain's email leaves it out, and the check sees that");
  const short = mailtoFor("examplesheds.test", { tracking: true, inbound: true });
  assert(short.url.includes(encodeURIComponent("Name/Host: links.examplesheds.test")), "a short one's carries it, and the check sees that");
});

Deno.test("the compiled portal carries the opens card and the label (npm run compile was run)", () => {
  assert(COMPILED.includes("See when emails are opened"), "portal.app.compiled.js is stale: run npm run compile");
  assert(COMPILED.includes("email_tracking_check"));
  assert(COMPILED.includes("some mail apps block the tracking image"));
  assert(COMPILED.includes("Marked as spam"), "the complaint chip is in the artifact");
  assert(COMPILED.includes("DNS only (grey cloud) on Cloudflare"), "the Cloudflare note is in the artifact");
  assert(COMPILED.includes("press Check it again in about 5 minutes"), "the checking note is in the artifact");
  assert(COMPILED.includes("Our last look didn't find this record"), "the not-found note is in the artifact");
  assert(COMPILED.includes("(optional, email opens; DNS only on Cloudflare)"), "the webmaster email's short label is in the artifact");
});
