// My Synergy Phone — email in one conversation per contact (plan 2026-10-03, migration 261), the
// StructureStudio half:
//   * crmFeed shows a conversation email's WORDS (email_sends.body_text) and still says when one
//     failed; emails from before 261 keep their old line;
//   * senderVerifiedFrom, the reply verdict the phone-api Worker now imports, keeps its three states;
//   * portal-settings' crm_send_email and email_send_test hand the contact, the words, the writer
//     and the app's bubble id to sendTenantEmail's claim, and no longer stamp the row afterwards.
// The wiring half reads the SHIPPED source (slice between stable anchors, fail loudly if they move),
// the way portalPhoneGaps_test.ts does.
//
// Run: deno test --node-modules-dir=none --allow-read tests/phone/

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildCrmFeed, senderVerifiedFrom } from "../../supabase/functions/_shared/crmFeed.ts";

const read = async (p: string) => (await Deno.readTextFile(new URL(p, import.meta.url))).replace(/\r\n/g, "\n");
/** Whole-line `//` comments removed, so a comment that NAMES the old stamp cannot trip a check. */
const code = (src: string) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const SETTINGS = code(await read("../../supabase/functions/portal-settings/index.ts"));
const FEED = await read("../../supabase/functions/_shared/crmFeed.ts");

const slice = (src: string, a: string, b: string, what: string) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`emailConversation_test: ${what} anchors moved (start=${i}, end=${j}) — re-point them.`);
  return src.slice(i, j);
};

// A tiny PostgREST stand-in (crmFeedCalls_test's), which also records what each table was asked for.
function stubAdmin(tables: Record<string, unknown[]>, selects: Record<string, string>) {
  const builder = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
    b.select = (cols: string) => { selects[table] = cols; return b; };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return b;
  };
  return { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } };
}

const CONTACT = "11111111-1111-4111-8111-111111111111";

Deno.test("crmFeed: a conversation email reads as its words; a failed one still says so; an old one keeps its line", async () => {
  const selects: Record<string, string> = {};
  const admin = stubAdmin({
    email_sends: [
      { id: "e1", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Your shed", status: "sent",
        body_text: "Hi Cam,\nthe 12x24 is ready.", created_at: "2026-10-03T15:00:00Z" },
      { id: "e2", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Delivery", status: "failed",
        body_text: "Tuesday works.", created_at: "2026-10-03T14:00:00Z" },
      { id: "e3", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Before 261", status: "failed",
        body_text: null, created_at: "2026-10-01T14:00:00Z" },
      { id: "e4", kind: "estimate", short_code: "SS-DEMO2345", to_email: "cam@example.test", subject: "Your quote", status: "sent",
        body_text: null, created_at: "2026-09-30T14:00:00Z" },
    ],
  }, selects);
  const feed = await buildCrmFeed(admin, "demo-tenant", { codes: [], contactId: CONTACT });
  assert(/\bbody_text\b/.test(selects.email_sends ?? ""), `email_sends must be read with body_text: ${selects.email_sends}`);
  const byId = (id: string) => feed.find((e) => e.id === `e:${id}`)!;
  assertEquals([byId("e1").title, byId("e1").body], ["Your shed", "Hi Cam,\nthe 12x24 is ready."]);
  assertEquals([byId("e2").title, byId("e2").body], ["Delivery (failed)", "Tuesday works."],
    "with the words in the body, the failure moves to the title rather than vanishing");
  assertEquals([byId("e3").title, byId("e3").body], ["Before 261", "Emailed to cam@example.test (failed)"]);
  assertEquals([byId("e4").title, byId("e4").body], ["Quote emailed to cam@example.test", "Your quote"], "document mail is unchanged");
});

Deno.test("crmFeed before migration 261: no body_text column still shows every sent email", async () => {
  // The database refuses a read that names body_text (42703) until 261 is applied. q() would turn
  // that into [] and blank every record page's sent-email history, so the read is tried again
  // without it.
  const ROWS = [
    { id: "e1", kind: "conversation", contact_id: CONTACT, to_email: "cam@example.test", subject: "Your shed", status: "sent", created_at: "2026-10-03T15:00:00Z" },
    { id: "e2", kind: "estimate", short_code: "SS-DEMO2345", to_email: "cam@example.test", subject: "Your quote", status: "sent", created_at: "2026-09-30T14:00:00Z" },
  ];
  const asked: string[] = [];
  const admin = {
    from: (table: string) => {
      let cols = "";
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "in", "or", "is", "order", "limit"]) b[m] = () => b;
      b.select = (c: string) => { cols = c; if (table === "email_sends") asked.push(c); return b; };
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(
        table !== "email_sends" ? { data: [], error: null }
          : /\bbody_text\b/.test(cols) ? { data: null, error: { code: "42703", message: "column email_sends.body_text does not exist" } }
          : { data: ROWS, error: null },
      ).then(res, rej);
      return b;
    },
    storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) },
  };
  const feed = await buildCrmFeed(admin, "demo-tenant", { codes: ["SS-DEMO2345"], contactId: CONTACT });
  assertEquals(asked.length, 2, "asked with body_text, then once more without it");
  assert(!/\bbody_text\b/.test(asked[1]), `the retry leaves body_text out: ${asked[1]}`);
  const byId = (id: string) => feed.find((e) => e.id === `e:${id}`);
  assertEquals([byId("e1")?.title, byId("e1")?.body], ["Your shed", "Emailed to cam@example.test"], "an email with no words keeps its old line");
  assertEquals(byId("e2")?.title, "Quote emailed to cam@example.test", "document mail is still there");
});

Deno.test("senderVerifiedFrom: pass on every reported check, a failure, or nothing we can read", () => {
  assertEquals(senderVerifiedFrom("spf=pass dkim=pass dmarc=pass"), true);
  assertEquals(senderVerifiedFrom("SPF=PASS; DKIM=pass"), true, "case does not matter");
  assertEquals(senderVerifiedFrom("spf=pass dkim=fail dmarc=pass"), false);
  assertEquals(senderVerifiedFrom("spam=flagged"), false);
  assertEquals(senderVerifiedFrom(null), null);
  assertEquals(senderVerifiedFrom(undefined), null);
  assertEquals(senderVerifiedFrom("looks fine to me"), null, "a verdict we cannot read is not one we may vouch for");
  assertEquals(senderVerifiedFrom(""), null);
});

Deno.test("crmFeed: a reply's senderVerified comes from senderVerifiedFrom, and crmFeed still imports nothing", async () => {
  const admin = stubAdmin({
    email_inbound: [
      { id: "i1", contact_id: CONTACT, from_email: "cam@example.test", subject: "Re: Your shed", body_text: "Thanks", received_at: "2026-10-03T16:00:00Z", spam_verdict: "spf=pass dkim=fail" },
      { id: "i2", contact_id: CONTACT, from_email: "cam@example.test", subject: "Re: Delivery", body_text: "Ok", received_at: "2026-10-03T16:05:00Z", spam_verdict: null },
    ],
  }, {});
  const feed = await buildCrmFeed(admin, "demo-tenant", { codes: [], contactId: CONTACT });
  assertEquals(feed.find((e) => e.id === "in:i1")?.meta?.senderVerified, false);
  assertEquals(feed.find((e) => e.id === "in:i2")?.meta?.senderVerified, null);
  // The phone-api Worker bundles crmFeed.ts for this one function; an import here would drag
  // the edge runtime's modules into the Worker.
  assert(!/^\s*import\s/m.test(FEED), "crmFeed.ts must stay import-free (the Worker imports senderVerifiedFrom)");
});

Deno.test("crm_send_email hands the conversation to the claim and no longer stamps the row afterwards", () => {
  const send = slice(SETTINGS, `if (action === "crm_send_email") {`, `if (action === "crm_save_note") {`, "crm_send_email");
  // The app's bubble id, by shape, and ignored rather than refused.
  assert(send.includes(`/^[A-Za-z0-9_-]{1,64}$/.test(rawTempId) ? rawTempId : null`), "clientTempId is validated against the app's shape");
  // contactId only once the lookup found the row in this tenant.
  assert(/contactFound = !!c;/.test(send), "the contact lookup records whether it found the row");
  assert(send.includes("...(contactFound ? { contactId } : {})"), "contactId goes to sendTenantEmail only when the lookup found it");
  assert(!send.includes("...(contactId ? { contactId } : {})"), "the unconditional contactId is gone");
  const call = slice(send, "const out = await sendTenantEmail(admin, clientId, {", "} as any);", "the sendTenantEmail call");
  assert(call.includes("bodyText: body,"), "the words go on the claim");
  assert(call.includes("...(userId ? { sentBy: String(userId) } : {})"), "sentBy is the session's user, never the body's");
  assert(call.includes("...(clientTempId ? { clientTempId } : {})"), "the bubble id goes on the claim");
  assert(!/payload\.(sentBy|sent_by)/.test(send), "nothing in the request body names the writer");
  // The old stamp: matching the newest row to the same address, after the send.
  assert(!/from\("email_sends"\)\s*\.update\(/.test(send), "crm_send_email must not update email_sends after the send");
  assert(send.includes("return json({ ok: true, messageId: out.messageId, id: out.id });"), "the ledger row id is returned");
});

Deno.test("email_send_test files the test on the contact at the claim, with no stamp afterwards", () => {
  const test = slice(SETTINGS, `if (action === "email_send_test") {`, `if (action === "email_disconnect") {`, "email_send_test");
  assert(test.includes("...(contactId ? { contactId } : {})"), "the contact found by address still goes to sendTenantEmail");
  assert(test.includes("...(userId ? { sentBy: String(userId) } : {})"), "and who sent the test");
  assert(!/from\("email_sends"\)\s*\.update\(/.test(test), "email_send_test must not update email_sends after the send");
  // Nowhere else in portal-settings stamps a contact onto a sent email either.
  assert(!/from\("email_sends"\)\.update\(\{\s*contact_id/.test(SETTINGS), "no after-the-send contact stamp anywhere in portal-settings");
});
