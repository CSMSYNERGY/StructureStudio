// "Sent by Mike with Jack" on the record timeline (crmFeed.ts, migration 378's sent_with), against a
// stand-in database that honours SELECT and refuses a column the table does not have (PostgREST's 42703),
// the way the real one does. Two worlds: after 378 (sent_with exists) and before it (the deploy window,
// when crmFeed may already be live and the column is not there yet).
//
//   1. after 378: an outbound text and an email whose row says sent_with = 'jack' carry via: "jack" and
//      the name of whoever pressed Approve on the Jack card; every other event is exactly what it was before 378
//   2. the name is this builder's team only: a teammate with no name set is "a team member"; a
//      StructureStudio operator (app_operators says so, whatever other team they are on) is byOperator;
//      anyone else not on this team (a removed rep) is "a former team member", never the platform; a send
//      with nobody recorded, or a people read that failed, names nobody
//   3. before 378: the read naming sent_with is refused, asked again with the columns it always had, and
//      every text and email is still on the page
//
// Dependency-free (no jsr:/npm: imports), like crmFeedDocuments.test.ts. People, numbers and addresses are
// made up. Run: deno test --node-modules-dir=none supabase/functions/_shared/crmFeedSentWith.test.ts

import { buildCrmFeed, type FeedEvent } from "./crmFeed.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const same = (a: unknown, b: unknown, msg: string) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}\n  got:  ${x}\n  want: ${y}`);
};

const TENANT = "demo-builder";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const MIKE = "00000000-0000-4000-8000-00000000a001";
const NONAME = "00000000-0000-4000-8000-00000000a002";
const OPERATOR_ELSEWHERE = "00000000-0000-4000-8000-00000000a003";
const OPERATOR_NOWHERE = "00000000-0000-4000-8000-00000000a004";
// A rep removed from this team (client_users row deleted), and one removed who works for another builder too.
const REMOVED = "00000000-0000-4000-8000-00000000a005";
const REMOVED_ELSEWHERE = "00000000-0000-4000-8000-00000000a006";

// The tables' columns, from their migrations (150, 254, 107, 113, 134, 261, 262; client_users 001 and
// later). sent_with is added only in the world after 378.
const SMS_COLUMNS = ["id", "client_id", "contact_id", "short_code", "direction", "from_number", "to_number", "body", "status", "error_code",
  "provider", "provider_sid", "num_segments", "sent_by", "delivered_at", "created_at", "updated_at", "client_temp_id", "sent_via", "num_media"];
const EMAIL_COLUMNS = ["id", "client_id", "short_code", "kind", "to_email", "intended_email", "from_email", "subject", "status", "error",
  "postmark_message_id", "delivered_at", "bounced_at", "bounce_reason", "created_at", "updated_at", "provider_message_id", "contact_id",
  "body_text", "sent_by", "client_temp_id", "opened_at", "open_count", "complained_at"];
const USER_COLUMNS = ["user_id", "client_id", "role", "title", "access", "full_name", "created_at"];
const OPERATOR_COLUMNS = ["user_id", "email", "added_at", "display_name"];

type Row = Record<string, unknown>;

/** A PostgREST stand-in: projects the selected columns, applies eq and in, refuses an unknown column
 *  with 42703, and records every select per table. Tables it has no column list for answer as empty. */
function fakeAdmin(tables: Record<string, Row[]>, after378: boolean, failing: string[] = []) {
  const columns: Record<string, string[]> = {
    sms_messages: after378 ? [...SMS_COLUMNS, "sent_with"] : SMS_COLUMNS,
    email_sends: after378 ? [...EMAIL_COLUMNS, "sent_with"] : EMAIL_COLUMNS,
    client_users: USER_COLUMNS,
    app_operators: OPERATOR_COLUMNS,
  };
  const asked: Record<string, string[]> = {};
  const builder = (table: string) => {
    let cols: string[] = [];
    const filters: ((r: Row) => boolean)[] = [];
    const b: Record<string, unknown> = {};
    b.select = (s: string) => {
      cols = String(s).replace(/\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
      (asked[table] ||= []).push(String(s));
      return b;
    };
    b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
    b.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; };
    for (const m of ["or", "is", "order", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const known = columns[table];
      if (failing.includes(table)) return Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }).then(res, rej);
      if (!known) return Promise.resolve({ data: [], error: null }).then(res, rej);
      const bad = cols.find((c) => !known.includes(c));
      if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }).then(res, rej);
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        .map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { admin: { from: builder, storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) } }, asked };
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 15, 0) + minute * 60_000).toISOString();
const sms = (id: string, minute: number, extra: Row): Row => ({
  id, client_id: TENANT, contact_id: CONTACT, direction: "out", from_number: "+18165550100", to_number: "+18165550199",
  body: `text ${id}`, status: "delivered", num_media: 0, created_at: at(minute), ...extra,
});
const email = (id: string, minute: number, extra: Row): Row => ({
  id, client_id: TENANT, contact_id: CONTACT, kind: "conversation", to_email: "a@example.com", subject: `email ${id}`, status: "delivered",
  body_text: `words ${id}`, open_count: 0, created_at: at(minute), ...extra,
});

/** The world after 378. Rows from before 378 (and every send that wasn't Jack's) have sent_with null. */
function world(): Record<string, Row[]> {
  return {
    sms_messages: [
      sms("s-jack", 1, { sent_by: MIKE, sent_with: "jack" }),
      sms("s-own", 2, { sent_by: MIKE, sent_with: null }),
      sms("s-auto", 3, { sent_by: null, sent_with: null }),
      // The check lets any row hold 'jack', but only our own texts are ever "sent": an inbound one is not marked.
      sms("s-in", 4, { direction: "in", from_number: "+18165550199", to_number: "+18165550100", status: "received", sent_by: null, sent_with: "jack" }),
      sms("s-op", 5, { sent_by: OPERATOR_ELSEWHERE, sent_with: "jack" }),
    ],
    email_sends: [
      email("e-jack", 6, { sent_by: MIKE, sent_with: "jack" }),
      email("e-own", 7, { sent_by: MIKE, sent_with: null }),
      // An estimate resent with Jack: the route leaves sent_by null, and jack-agent fills it with the person.
      email("e-resend", 8, { kind: "estimate", short_code: "SS-DEMO2345", subject: "Your estimate", body_text: null, sent_by: MIKE, sent_with: "jack" }),
      email("e-quote", 9, { kind: "estimate", short_code: "SS-DEMO2345", subject: "Your estimate", body_text: null, sent_by: null, sent_with: null }),
      email("e-noname", 10, { sent_by: NONAME, sent_with: "jack" }),
      email("e-nowhere", 11, { sent_by: OPERATOR_NOWHERE, sent_with: "jack" }),
      email("e-nobody", 12, { sent_by: null, sent_with: "jack" }),
      email("e-removed", 13, { sent_by: REMOVED, sent_with: "jack" }),
      email("e-removed-elsewhere", 14, { sent_by: REMOVED_ELSEWHERE, sent_with: "jack" }),
    ],
    client_users: [
      { user_id: MIKE, client_id: TENANT, role: "owner", full_name: "Mike Example" },
      { user_id: NONAME, client_id: TENANT, role: "member", full_name: null },
      // An operator who is also a member of another account: their name must not reach this builder's page.
      { user_id: OPERATOR_ELSEWHERE, client_id: "another-builder", role: "owner", full_name: "Olive Operator" },
      { user_id: REMOVED_ELSEWHERE, client_id: "another-builder", role: "member", full_name: "Rita Elsewhere" },
    ],
    app_operators: [
      { user_id: OPERATOR_ELSEWHERE, email: "olive@example.com" },
      { user_id: OPERATOR_NOWHERE, email: "oscar@example.com" },
    ],
  };
}

/** The same rows as the database held them before 378: no sent_with anywhere. */
function before378(w: Record<string, Row[]>): Record<string, Row[]> {
  const strip = (rows: Row[]) => rows.map(({ sent_with: _s, ...r }) => r);
  return { ...w, sms_messages: strip(w.sms_messages), email_sends: strip(w.email_sends) };
}

const opts = { codes: ["SS-DEMO2345"], contactId: CONTACT };
const byId = (feed: FeedEvent[]) => new Map(feed.map((e) => [e.id, e]));

Deno.test("after 378: a text and an email sent with Jack say who approved them, and nothing else changes", async () => {
  const w = world();
  const { admin, asked } = fakeAdmin(w, true);
  const feed = byId(await buildCrmFeed(admin, TENANT, opts));
  const { admin: oldAdmin } = fakeAdmin(before378(w), false);
  const old = byId(await buildCrmFeed(oldAdmin, TENANT, opts));

  assert(/\bsent_with\b/.test(asked.sms_messages?.[0] ?? "") && /\bsent_by\b/.test(asked.sms_messages?.[0] ?? ""), `texts are read with sent_by and sent_with: ${asked.sms_messages}`);
  assert(/\bsent_with\b/.test(asked.email_sends?.[0] ?? "") && /\bsent_by\b/.test(asked.email_sends?.[0] ?? ""), `emails are read with sent_by and sent_with: ${asked.email_sends}`);
  same(asked.sms_messages?.length, 1, "after 378 the texts are read once");
  same(asked.email_sends?.length, 1, "after 378 the emails are read once");

  for (const id of ["sm:s-jack", "e:e-jack", "e:e-resend"]) {
    const e = feed.get(id)!;
    assert(e, `${id} is on the page`);
    same([e.via, e.byName], ["jack", "Mike Example"], `${id} says it went with Jack, pressed by Mike`);
    // Everything else about the line is what it was before 378.
    const { via: _v, byName: _b, ...rest } = e;
    same(rest, old.get(id), `${id} is otherwise unchanged`);
  }
  // A person's own send, an automatic one, an inbound text, a document email: not marked, and identical.
  for (const id of ["sm:s-own", "sm:s-auto", "sm:s-in", "e:e-own", "e:e-quote"]) {
    const e = feed.get(id)!;
    assert(e, `${id} is on the page`);
    assert(!("via" in e) && !("byName" in e) && !("byOperator" in e), `${id} carries no Jack fields: ${JSON.stringify(e)}`);
    same(e, old.get(id), `${id} is unchanged`);
  }
  // Every other event on the page, too.
  same([...feed.keys()].sort(), [...old.keys()].sort(), "the same events are on the page");
  for (const [id, e] of feed) if (!e.via) same(e, old.get(id), `${id} is unchanged`);
});

Deno.test("the name is this builder's team only; the platform only when app_operators says so; a removed rep is a former team member", async () => {
  const { admin, asked } = fakeAdmin(world(), true);
  const feed = byId(await buildCrmFeed(admin, TENANT, opts));
  const who = (id: string) => [feed.get(id)?.via, feed.get(id)?.byName, feed.get(id)?.byOperator ?? null];
  same(who("sm:s-op"), ["jack", null, true], "an operator who is on another account's team is the StructureStudio team, not named");
  same(who("e:e-nowhere"), ["jack", null, true], "an operator on no team is the StructureStudio team");
  same(who("e:e-nobody"), ["jack", null, null], "a Jack send with nobody recorded names nobody, and not the platform");
  same(who("e:e-noname"), ["jack", "a team member", null], "a teammate with no name set is a team member");
  same(who("e:e-removed"), ["jack", "a former team member", null], "a rep removed from this team is a former team member, never the platform");
  same(who("e:e-removed-elsewhere"), ["jack", "a former team member", null], "a removed rep who is on another builder's team is still a former team member here");
  same(who("sm:s-jack"), ["jack", "Mike Example", null], "a teammate is named");
  for (const e of feed.values()) assert(e.byName !== "Olive Operator" && e.byName !== "Rita Elsewhere", "another account's name reached this page");
  same(asked.client_users?.length, 1, "still ONE client_users read for the whole feed");
  same(asked.app_operators?.length, 1, "ONE app_operators read, of the ids not on this team");
});

Deno.test("a people read that fails names nobody on a Jack line: never the platform for a rep, nor a rep for the platform", async () => {
  // client_users failed: nobody can be told apart, so every Jack line names nobody.
  const a = fakeAdmin(world(), true, ["client_users"]);
  const feed = byId(await buildCrmFeed(a.admin, TENANT, opts));
  for (const id of ["sm:s-jack", "sm:s-op", "e:e-removed", "e:e-noname"]) {
    same([feed.get(id)?.via, feed.get(id)?.byName, feed.get(id)?.byOperator ?? null], ["jack", null, null], `${id} with the people unread`);
  }
  same(a.asked.app_operators, undefined, "no operator read without the team");
  // app_operators failed: teammates are still named, and nobody off the team is called either.
  const b = fakeAdmin(world(), true, ["app_operators"]);
  const f2 = byId(await buildCrmFeed(b.admin, TENANT, opts));
  same([f2.get("sm:s-jack")?.byName, f2.get("sm:s-jack")?.byOperator ?? null], ["Mike Example", null], "a teammate is named");
  for (const id of ["sm:s-op", "e:e-removed"]) same([f2.get(id)?.byName, f2.get(id)?.byOperator ?? null], [null, null], `${id} with the operators unread`);
  // A record with no Jack sends off the team makes no operator read at all.
  const c = fakeAdmin({ ...world(), sms_messages: [], email_sends: [email("e-jack", 6, { sent_by: MIKE, sent_with: "jack" })] }, true);
  await buildCrmFeed(c.admin, TENANT, opts);
  same(c.asked.app_operators, undefined, "no operator read when everyone is on the team");
});

Deno.test("before 378: the read naming sent_with is refused, asked again as before, and every text and email is still there", async () => {
  const w = before378(world());
  const { admin, asked } = fakeAdmin(w, false);
  const feed = byId(await buildCrmFeed(admin, TENANT, opts));

  same(asked.sms_messages?.length, 2, "texts: asked with sent_with, then without it");
  assert(/\bsent_with\b/.test(asked.sms_messages[0]), `the first ask names sent_with: ${asked.sms_messages[0]}`);
  same(asked.sms_messages[1], "id, direction, short_code, contact_id, from_number, to_number, body, status, error_code, created_at",
    "the retry is exactly the read the texts always had");
  same(asked.email_sends?.length, 2, "emails: asked with sent_with, then without it");
  same(asked.email_sends[1], "id, short_code, contact_id, kind, to_email, subject, status, created_at, delivered_at, bounced_at, body_text, opened_at, open_count, complained_at",
    "the retry is exactly the read the emails had before 378, words and opens included");

  for (const t of w.sms_messages) assert(feed.has(`sm:${t.id}`), `text ${t.id} vanished from the page ahead of 378`);
  for (const e of w.email_sends) assert(feed.has(`e:${e.id}`), `email ${e.id} vanished from the page ahead of 378`);
  same(feed.get("e:e-jack")?.body, "words e-jack", "the words are still read ahead of 378");
  same(feed.get("sm:s-jack")?.body, "text s-jack", "the text's words are still there");
  for (const e of feed.values()) assert(!("via" in e) && !("byName" in e), `nothing is marked ahead of 378: ${e.id}`);
});
