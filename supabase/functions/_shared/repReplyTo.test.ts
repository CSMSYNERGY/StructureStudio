// Unit tests for _shared/repReplyTo.ts: whose inbox a customer's reply is copied to.
//
// WHY THESE EXIST. Until 2026-10-05 only the conversation composer passed a reply address, so a
// customer answering a quote or an invoice reached the record and never a person, while My Profile
// told every rep otherwise. The fix is one rule for every sender, and the rule's edges are where
// it can go wrong without anyone noticing: a CSM Synergy address on a builder's quote, a colleague
// getting someone else's replies, an address that breaks the mail header and with it the whole
// email. Each edge is pinned here against a stub database: no network, no real database, and
// nothing is sent (the one send below goes to a stubbed fetch).
//
// Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/repReplyTo.test.ts
// (the pre-push gate runs it with those flags; see scripts/preflight.mjs)
//
// Fixtures are made up (Acme Sheds, example.test), per the public-repo rule.

import { cleanReplyAddress, ownerReplyAddress, personReplyAddress, REPLY_ADDRESS_MAX, REPLY_ADDRESS_RE, repReplyTo } from "./repReplyTo.ts";
import { sendTenantEmail } from "./emailSend.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${msg ? ` — ${msg}` : ""}`);
  }
}

// ── A table-backed stub of the service-role client ───────────────────────────────────────────
// The read shapes repReplyTo.ts (and internalTenant.ts, which it calls) actually use:
//   from(t).select(c).eq(…)….limit(n)        → { data: Row[], error }
//   from(t).select(c).eq(…)….maybeSingle()   → { data: Row | null, error }
//   auth.admin.getUserById(id)               → { data: { user }, error }
// plus the email_sends insert/update sendTenantEmail makes, for the one end-to-end test. Every
// read is recorded with its filters, so a test can say WHAT was asked, not only what came back.
type Row = Record<string, unknown>;
type Read = { table: string; filters: Record<string, unknown> };
type StubOpts = {
  /** Tables whose reads answer an error. */
  failOn?: string[];
  /** Tables whose reads throw outright. */
  throwOn?: string[];
  /** auth.admin.getUserById answers an error. */
  authFails?: boolean;
};

function stubDb(tables: Record<string, Row[]>, users: Record<string, string | null>, opts: StubOpts = {}) {
  const reads: Read[] = [];
  const authReads: string[] = [];
  const admin = {
    from(table: string) {
      const rows = tables[table] || [];
      const read: Read = { table, filters: {} };
      const run = () => {
        if (opts.throwOn?.includes(table)) throw new Error(`${table} exploded`);
        if (opts.failOn?.includes(table)) return { data: null, error: { message: `${table} read failed`, code: "XX000" } };
        return { data: rows.filter((r) => Object.entries(read.filters).every(([c, v]) => r[c] === v)), error: null };
      };
      const api = {
        select(_cols: string) { reads.push(read); return api; },
        eq(col: string, val: unknown) { read.filters[col] = val; return api; },
        limit(n: number) {
          const res = run();
          return Promise.resolve(res.error ? res : { data: (res.data as Row[]).slice(0, n), error: null });
        },
        maybeSingle() {
          const res = run();
          return Promise.resolve(res.error ? res : { data: (res.data as Row[])[0] ?? null, error: null });
        },
        insert(_row: Row) {
          return { select: (_c: string) => ({ single: () => Promise.resolve({ data: { id: "es-row-1" }, error: null }) }) };
        },
        update(_patch: Row) {
          return { eq: (_c: string, _v: unknown) => Promise.resolve({ error: null }) };
        },
      };
      return api;
    },
    auth: {
      admin: {
        getUserById(id: string) {
          authReads.push(id);
          if (opts.authFails) return Promise.resolve({ data: { user: null }, error: { message: "auth down" } });
          if (!(id in users)) return Promise.resolve({ data: { user: null }, error: { message: "User not found" } });
          return Promise.resolve({ data: { user: { id, email: users[id] } }, error: null });
        },
      },
    },
  };
  return { admin, reads, authReads };
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
const ACME = "acme-sheds";
const OTHER = "other-sheds";
const OURS = "house-account";
const REP = "11111111-1111-4111-8111-111111111111";      // a rep at Acme with a saved reply address
const REP2 = "22222222-2222-4222-8222-222222222222";     // a rep at Acme with none saved
const GONE = "33333333-3333-4333-8333-333333333333";     // assigned to a customer, has left Acme
const OP = "44444444-4444-4444-8444-444444444444";       // a CSM Synergy operator, a member of OUR account only
const OPX = "55555555-5555-4555-8555-555555555555";      // an operator who somehow holds a membership at Acme
const TEXTER = "66666666-6666-4666-8666-666666666666";   // a member who signs in by text: no email at all
const ELSE = "77777777-7777-4777-8777-777777777777";     // a member of the OTHER tenant
const C_REP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";    // contacts and who they are assigned to
const C_GONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C_NONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const C_OP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
// Each contact's own email: the rep is named only for an email going to THIS address.
const ALEX = "alex@example.test";
const NOONE = "nobody.assigned@example.test";
const FORMER = "former.customer@example.test";
const HOUSE = "house.customer@example.test";

const TABLES: Record<string, Row[]> = {
  client_users: [
    { user_id: REP, client_id: ACME, prefs: { replyToEmail: "jamie.quotes@acme-sheds.example.test", designsView: "list" } },
    { user_id: REP2, client_id: ACME, prefs: { designsView: "pipeline" } },
    { user_id: OP, client_id: OURS, prefs: null },
    { user_id: OPX, client_id: ACME, prefs: null },
    { user_id: TEXTER, client_id: ACME, prefs: {} },
    { user_id: ELSE, client_id: OTHER, prefs: { replyToEmail: "pat@other-sheds.example.test" } },
  ],
  app_operators: [{ user_id: OP }, { user_id: OPX }],
  client_settings: [
    { client_id: ACME, internal_account: false },
    { client_id: OTHER, internal_account: null },
    { client_id: OURS, internal_account: true },
  ],
  crm_contacts: [
    { client_id: ACME, id: C_REP, owner_user_id: REP2, email: ALEX },
    { client_id: ACME, id: C_GONE, owner_user_id: GONE, email: FORMER },
    { client_id: ACME, id: C_NONE, owner_user_id: null, email: NOONE },
    { client_id: OURS, id: C_OP, owner_user_id: OP, email: HOUSE },
  ],
  // A second address filed on Alex's record: what crm_ensure_contact does with a NEW email typed
  // beside Alex's phone number on an anonymous design. It must never count as Alex's.
  crm_contact_people: [
    { client_id: ACME, contact_id: C_REP, email: "stranger@example.test" },
  ],
  designs: [
    { client_id: ACME, short_code: "SS-AAAA1111", contact_id: C_REP },
    { client_id: ACME, short_code: "SS-GONE2222", contact_id: C_GONE },
    { client_id: ACME, short_code: "SS-NONE3333", contact_id: C_NONE },
    { client_id: ACME, short_code: "SS-LEAD4444", contact_id: null },
    // The same code on another tenant must never be the one read.
    { client_id: OTHER, short_code: "SS-OTHR5555", contact_id: C_REP },
    { client_id: OURS, short_code: "SS-HOUSE666", contact_id: C_OP },
  ],
};
const USERS: Record<string, string | null> = {
  [REP]: "jamie@login.example.test",
  [REP2]: "sam@acme-sheds.example.test",
  [GONE]: "former@acme-sheds.example.test",
  [OP]: "staff@csm.example.test",
  [OPX]: "staff2@csm.example.test",
  [TEXTER]: null,
  [ELSE]: "pat.login@other-sheds.example.test",
};
const db = (opts: StubOpts = {}) => stubDb(TABLES, USERS, opts);

// ── The address check ───────────────────────────────────────────────────────────────────────

Deno.test("cleanReplyAddress keeps ordinary addresses as typed, trimmed", () => {
  for (const ok of [
    "sam@acme-sheds.example.test",
    "Jamie.Quotes+shed@Acme-Sheds.example.test",
    "o'brien@example.test",
    "a_b-c@sub.domain.example.test",
    "x@y.co",
  ]) assertEquals(cleanReplyAddress(ok), ok, ok);
  assertEquals(cleanReplyAddress("  sam@acme-sheds.example.test \n"), "sam@acme-sheds.example.test", "outer whitespace is trimmed");
});

Deno.test("cleanReplyAddress drops anything that could break or add to the header", () => {
  const bad: unknown[] = [
    // Header injection: a line break inside starts a new header.
    "sam@acme.example.test\r\nBcc: everyone@example.test",
    "sam@acme.example.test\nBcc: everyone@example.test",
    "sam@acme.example.test\rX: y",
    // A second address, by comma or semicolon.
    "sam@acme.example.test, boss@acme.example.test",
    "sam@acme.example.test;boss@acme.example.test",
    // Display names, quotes, comments, groups.
    "Sam <sam@acme.example.test>",
    "<sam@acme.example.test>",
    '"sam"@acme.example.test',
    "sam(at work)@acme.example.test",
    "undisclosed:sam@acme.example.test;",
    "sam@[127.0.0.1]",
    "sam\\@acme.example.test",
    // Spaces and control characters inside.
    "sam smith@acme.example.test",
    "sam@acme.example.test\u0000",
    "sam\t@acme.example.test",
    // Not an address.
    "", "   ", "sam", "sam@", "@acme.example.test", "sam@acme", "sam@@acme.example.test",
    "sam@acme..example.test", ".sam@acme.example.test", "sam.@acme.example.test", "sa..m@acme.example.test",
    "sam@-acme.example.test", "sam@acme-.example.test", "sam@acme.example.test.",
    // Non-ASCII (needs SMTPUTF8, unconfirmed with the provider).
    "josé@acme.example.test", "sam@acmé.example.test",
    // Too long.
    `${"a".repeat(REPLY_ADDRESS_MAX - "@x.example.test".length + 1)}@x.example.test`,
    // Not a string at all.
    null, undefined, 42, { email: "sam@acme.example.test" }, ["sam@acme.example.test"],
  ];
  for (const b of bad) assertEquals(cleanReplyAddress(b), null, JSON.stringify(b));
  const atMax = `${"a".repeat(REPLY_ADDRESS_MAX - "@x.example.test".length)}@x.example.test`;
  assertEquals(atMax.length, REPLY_ADDRESS_MAX);
  assertEquals(cleanReplyAddress(atMax), atMax, "exactly 320 characters is kept");
});

Deno.test("REPLY_ADDRESS_RE refuses every character with a meaning in an address header", () => {
  for (const ch of [" ", "\t", "\r", "\n", ",", ";", ":", "<", ">", "\"", "(", ")", "[", "]", "\\", "@"]) {
    assert(!REPLY_ADDRESS_RE.test(`sa${ch}m@acme.example.test`), `local part with ${JSON.stringify(ch)}`);
    assert(!REPLY_ADDRESS_RE.test(`sam@ac${ch}me.example.test`), `domain with ${JSON.stringify(ch)}`);
  }
});

// ── A person's address ──────────────────────────────────────────────────────────────────────

Deno.test("prefs beat the sign-in email, and the sign-in email is the fallback", async () => {
  let d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, REP), "jamie.quotes@acme-sheds.example.test");
  assertEquals(d.authReads.length, 0, "no auth read when the saved address is usable");
  d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, REP2), "sam@acme-sheds.example.test", "nothing saved: the sign-in email");
});

Deno.test("prefs are read on THIS tenant: a member of another tenant is nobody here", async () => {
  const d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, ELSE), null);
  const cu = d.reads.find((r) => r.table === "client_users");
  assert(cu, "client_users was read");
  assertEquals(cu.filters, { user_id: ELSE, client_id: ACME }, "keyed on the person AND the tenant");
  assertEquals(d.authReads.length, 0, "no fallback to the sign-in email for a non-member");
  // And on their own tenant, their own choice.
  assertEquals(await personReplyAddress(db().admin, OTHER, ELSE), "pat@other-sheds.example.test");
});

Deno.test("an injection-shaped saved address is dropped, and the sign-in email stands in", async () => {
  for (const saved of [
    "jamie@acme.example.test\r\nBcc: list@example.test",
    "jamie@acme.example.test, boss@acme.example.test",
    "Jamie <jamie@acme.example.test>",
    42,
  ]) {
    const t = structuredClone(TABLES);
    (t.client_users.find((r) => r.user_id === REP) as Row).prefs = { replyToEmail: saved };
    const d = stubDb(t, USERS);
    assertEquals(await personReplyAddress(d.admin, ACME, REP), "jamie@login.example.test", JSON.stringify(saved));
  }
  // And a sign-in email that is no good is nobody, never a repaired version of it.
  const d = stubDb(TABLES, { ...USERS, [REP2]: "sam@acme.example.test\r\nBcc: x@example.test" });
  assertEquals(await personReplyAddress(d.admin, ACME, REP2), null);
});

Deno.test("a text-message login with no email is nobody, not a fault", async () => {
  const seen: string[] = [];
  assertEquals(await personReplyAddress(db().admin, ACME, TEXTER, { onError: (w) => seen.push(w) }), null);
  assertEquals(seen, [], "no error reported");
});

Deno.test("an operator gives null: view-as, no membership, or a CSM Synergy login on a customer's account", async () => {
  // View-as: refused before any read at all.
  let d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, REP, { operator: true }), null, "view-as");
  assertEquals(d.reads.length + d.authReads.length, 0, "view-as reads nothing");
  // An operator viewing Acme: their one membership is our own account, so they are nobody here.
  d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, OP), null, "no membership on the viewed tenant");
  assertEquals(d.authReads.length, 0);
  // An operator who DOES hold a row at Acme is still never put on Acme's email.
  d = db();
  assertEquals(await personReplyAddress(d.admin, ACME, OPX), null, "operator on a customer tenant");
  assertEquals(d.authReads.length, 0, "refused before their address is even looked up");
  // On OUR own account they are the builder, and keep the address they've had since 09-06.
  assertEquals(await personReplyAddress(db().admin, OURS, OP), "staff@csm.example.test", "our own account");
});

Deno.test("a failed read gives null and says why, never throws", async () => {
  for (const [opts, want] of [
    [{ failOn: ["client_users"] }, /client_users read failed/],
    [{ failOn: ["app_operators"] }, /app_operators read failed/],
    [{ throwOn: ["client_users"] }, /exploded/],
    [{ authFails: true }, /auth user read failed: auth down/],
  ] as [StubOpts, RegExp][]) {
    const seen: string[] = [];
    const out = await personReplyAddress(db(opts).admin, ACME, REP2, { onError: (w) => seen.push(w) });
    assertEquals(out, null, JSON.stringify(opts));
    assert(seen.length === 1 && want.test(seen[0]), `${JSON.stringify(opts)} → ${JSON.stringify(seen)}`);
    assert(!/@/.test(seen[0]), "no address in the error");
  }
  // The internal-account check failing for an operator: we could not tell, so nobody.
  const seen: string[] = [];
  assertEquals(await personReplyAddress(db({ failOn: ["client_settings"] }).admin, OURS, OP, { onError: (w) => seen.push(w) }), null);
  assert(seen.length === 1, "reported");
  // A logger that throws must not cost anything either.
  assertEquals(await personReplyAddress(db({ failOn: ["client_users"] }).admin, ACME, REP, { onError: () => { throw new Error("log down"); } }), null);
  // Junk ids never reach the database.
  const d = db();
  for (const id of [null, undefined, "", "not-a-uuid", "1 or 1=1"]) assertEquals(await personReplyAddress(d.admin, ACME, id as string), null);
  assertEquals(d.reads.length, 0, "a malformed id is refused before any read");
});

// ── The customer's assigned rep ─────────────────────────────────────────────────────────────

Deno.test("the owner is the design's contact's owner_user_id, read on this tenant", async () => {
  let d = db();
  assertEquals(await ownerReplyAddress(d.admin, ACME, { shortCode: "SS-AAAA1111", recipient: ALEX }), "sam@acme-sheds.example.test");
  assertEquals(d.reads.find((r) => r.table === "designs")?.filters, { client_id: ACME, short_code: "SS-AAAA1111" });
  assertEquals(d.reads.find((r) => r.table === "crm_contacts")?.filters, { client_id: ACME, id: C_REP });
  // By contact id directly, no design read.
  d = db();
  assertEquals(await ownerReplyAddress(d.admin, ACME, { contactId: C_REP, recipient: ALEX }), "sam@acme-sheds.example.test");
  assertEquals(d.reads.filter((r) => r.table === "designs").length, 0);
  // Another tenant's design code is not this tenant's.
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-OTHR5555", recipient: ALEX }), null);
  // Another tenant's contact id is not this tenant's either.
  assertEquals(await ownerReplyAddress(db().admin, OTHER, { contactId: C_REP, recipient: ALEX }), null);
});

Deno.test("a departed owner, no owner, no contact: null", async () => {
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-GONE2222", recipient: FORMER }), null, "left the company");
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-NONE3333", recipient: NOONE }), null, "nobody assigned");
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-LEAD4444", recipient: ALEX }), null, "no contact on the design");
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-NOPE0000", recipient: ALEX }), null, "no such design");
  assertEquals(await ownerReplyAddress(db().admin, ACME, { recipient: ALEX }), null, "nothing to go on");
});

Deno.test("an operator assigned to a customer is named only on our own account", async () => {
  assertEquals(await ownerReplyAddress(db().admin, OURS, { shortCode: "SS-HOUSE666", recipient: HOUSE }), "staff@csm.example.test");
});

Deno.test("a DB error on the owner path gives null and says why", async () => {
  for (const table of ["designs", "crm_contacts"]) {
    const seen: string[] = [];
    assertEquals(await ownerReplyAddress(db({ failOn: [table] }).admin, ACME, { shortCode: "SS-AAAA1111", recipient: ALEX }, { onError: (w) => seen.push(w) }), null, table);
    assert(seen.length === 1 && seen[0].includes(table), JSON.stringify(seen));
  }
  assertEquals(await ownerReplyAddress(db({ throwOn: ["designs"] }).admin, ACME, { shortCode: "SS-AAAA1111", recipient: ALEX }), null);
});

Deno.test("the rep is named only when the email goes to their customer's own address", async () => {
  // The same address, however it was typed.
  assertEquals(await ownerReplyAddress(db().admin, ACME, { shortCode: "SS-AAAA1111", recipient: "  Alex@Example.TEST " }), "sam@acme-sheds.example.test");
  // Somebody else's address on Alex's design: nobody. This is the anonymous submit that typed
  // Alex's phone number (so the design links to Alex) beside the stranger's own email.
  let d = db();
  assertEquals(await ownerReplyAddress(d.admin, ACME, { shortCode: "SS-AAAA1111", recipient: "stranger@example.test" }), null, "a different recipient");
  assertEquals(d.authReads.length, 0, "the rep's address is never even looked up");
  // A second address filed on Alex's record is still not Alex's: crm_ensure_contact puts a new
  // email typed beside a known phone number there, so matching it would undo the check.
  assertEquals(d.reads.filter((r) => r.table === "crm_contact_people").length, 0, "the second-person table is never consulted");
  // No recipient at all: nothing to compare, so nobody, and nothing is read.
  for (const recipient of [undefined, null, "", "   "]) {
    d = db();
    assertEquals(await ownerReplyAddress(d.admin, ACME, { shortCode: "SS-AAAA1111", recipient }), null, JSON.stringify(recipient));
    assertEquals(d.reads.length + d.authReads.length, 0, "no reads without a recipient");
  }
  // A contact with no email of their own can't be matched either.
  const t = structuredClone(TABLES);
  (t.crm_contacts.find((r) => r.id === C_REP) as Row).email = null;
  assertEquals(await ownerReplyAddress(stubDb(t, USERS).admin, ACME, { shortCode: "SS-AAAA1111", recipient: ALEX }), null, "contact has no email");
});

// ── The one call every sender makes ─────────────────────────────────────────────────────────

Deno.test("repReplyTo: the staff sender first, else the customer's rep, else nobody", async () => {
  // A rep sends a quote for a customer assigned to a colleague: the reply copy is the SENDER's.
  assertEquals(await repReplyTo(db().admin, ACME, { senderUserId: REP, shortCode: "SS-AAAA1111", recipient: ALEX }), "jamie.quotes@acme-sheds.example.test");
  // View-as: the operator is never named; the customer's rep is.
  assertEquals(await repReplyTo(db().admin, ACME, { senderUserId: OP, operator: true, shortCode: "SS-AAAA1111", recipient: ALEX }), "sam@acme-sheds.example.test");
  // An operator in the designer (no view-as flag there, and no membership at Acme): the rep.
  assertEquals(await repReplyTo(db().admin, ACME, { senderUserId: OP, shortCode: "SS-AAAA1111", recipient: ALEX }), "sam@acme-sheds.example.test");
  // The customer set it off (no sender): the rep.
  assertEquals(await repReplyTo(db().admin, ACME, { shortCode: "SS-AAAA1111", recipient: ALEX }), "sam@acme-sheds.example.test");
  // Nobody to name anywhere: null, which the senders turn into "add nothing".
  assertEquals(await repReplyTo(db().admin, ACME, { shortCode: "SS-NONE3333", recipient: NOONE }), null);
  assertEquals(await repReplyTo(db().admin, ACME, { senderUserId: OP, operator: true, shortCode: "SS-GONE2222", recipient: FORMER }), null);
});

Deno.test("repReplyTo: a member who sent it with no usable address gets no copy, never their colleague's", async () => {
  // A text-message login (no email at all) sends from the record for Alex, who is assigned to REP2.
  let d = db();
  assertEquals(await repReplyTo(d.admin, ACME, { senderUserId: TEXTER, shortCode: "SS-AAAA1111", recipient: ALEX }), null, "text-message login");
  assertEquals(d.reads.filter((r) => r.table === "designs" || r.table === "crm_contacts").length, 0, "the owner path was never tried");
  // A member whose sign-in email the header check refuses (a non-ASCII domain), nothing saved.
  d = stubDb(TABLES, { ...USERS, [TEXTER]: "pat@acmé-sheds.example.test" });
  assertEquals(await repReplyTo(d.admin, ACME, { senderUserId: TEXTER, shortCode: "SS-AAAA1111", recipient: ALEX }), null, "unusable sign-in email");
  // And the same customer, sent by nobody we name here, still reaches their rep.
  assertEquals(await repReplyTo(db().admin, ACME, { senderUserId: ELSE, shortCode: "SS-AAAA1111", recipient: ALEX }), "sam@acme-sheds.example.test", "a login from another tenant");
});

Deno.test("repReplyTo: a stranger's submit on a known customer's phone number learns nothing", async () => {
  // No session (the public designer), the design linked to Alex by phone, the quote going to the
  // address the stranger typed: no rep, no address, the routing address alone.
  const d = db();
  assertEquals(await repReplyTo(d.admin, ACME, { shortCode: "SS-AAAA1111", recipient: "stranger@example.test" }), null);
  assertEquals(d.authReads.length, 0, "no address of anybody's was read");
});

Deno.test("repReplyTo: a sender we could not READ is no copy, never a colleague's", async () => {
  const seen: string[] = [];
  // REP2 has nothing saved, so their address needs the auth read, which fails. SS-AAAA1111's
  // customer is assigned to REP2 as well, so re-assign it to REP to make the point.
  const t = structuredClone(TABLES);
  (t.crm_contacts.find((r) => r.id === C_REP) as Row).owner_user_id = REP;
  const d2 = stubDb(t, USERS, { authFails: true });
  assertEquals(await repReplyTo(d2.admin, ACME, { senderUserId: REP2, shortCode: "SS-AAAA1111", recipient: ALEX, onError: (w) => seen.push(w) }), null);
  assert(seen.length === 1 && /auth user read failed/.test(seen[0]), JSON.stringify(seen));
  assertEquals(d2.reads.filter((r) => r.table === "designs").length, 0, "the owner path was never tried");
});

// ── End to end: what goes on the wire ───────────────────────────────────────────────────────

Deno.test("the answer rides in Reply-To after the routing address: two addresses, token first", async () => {
  const realFetch = globalThis.fetch;
  Deno.env.set("RESEND_API_KEY", "test-resend-key");
  Deno.env.delete("SUPABASE_URL");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("PLATFORM_EMAIL_DOMAIN_READY");
  const bodies: string[] = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(new Response(JSON.stringify({ id: "rs-msg-1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    const t = structuredClone(TABLES);
    Object.assign(t.client_settings.find((r) => r.client_id === ACME) as Row, {
      email_provider: "resend", email_domain_status: "verified", email_domain: "acme-sheds.example.test",
      email_from_local: "quotes", email_from_name: "Acme Sheds", business_name: "Acme Sheds",
      beta_mode: false, beta_email: null, inbound_domain: "reply.acme-sheds.example.test", inbound_status: "active",
      invoice_in_ghl: false,
    });
    const d = stubDb(t, USERS);
    // A quote re-sent by REP2 (nothing saved, so their sign-in email).
    const replyTo = await repReplyTo(d.admin, ACME, { senderUserId: REP2, shortCode: "SS-AAAA1111", recipient: ALEX });
    const out = await sendTenantEmail(d.admin, ACME, {
      kind: "estimate", shortCode: "SS-AAAA1111", to: ALEX,
      subject: "Your quote", html: "<p>Hi</p>", text: "Hi", ...(replyTo ? { replyTo } : {}),
    });
    assert(out.sent, "sent (to the stub)");
    assertEquals(JSON.parse(bodies[0]).reply_to, ["d.ss-aaaa1111@reply.acme-sheds.example.test", "sam@acme-sheds.example.test"],
      "the routing address first, so a reply always reaches the record; the rep second");
    // And the customer-set-off case with nobody assigned: the routing address alone, as before.
    const none = await repReplyTo(d.admin, ACME, { shortCode: "SS-NONE3333", recipient: NOONE });
    await sendTenantEmail(d.admin, ACME, {
      kind: "acceptance", shortCode: "SS-NONE3333", to: NOONE,
      subject: "Accepted", html: "<p>Thanks</p>", text: "Thanks", ...(none ? { replyTo: none } : {}),
    });
    assertEquals(JSON.parse(bodies[1]).reply_to, "d.ss-none3333@reply.acme-sheds.example.test");
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("RESEND_API_KEY");
  }
});
