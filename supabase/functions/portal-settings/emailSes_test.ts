// Settings → Email for a builder on Amazon SES (./emailSes.ts), driven with a recording fake of
// the database and `fetch` stubbed at the two hosts it may reach (SES, and Resend for a finished
// cutover). No network, no AWS, no database.
//
// WHY THESE EXIST. This file decides which provider a builder's domain lives at, and the costly
// mistakes are all quiet: a Resend builder silently re-created at SES (their email stops until
// DNS they never changed is fixed), a private DKIM key written to a row, a reply address switched
// on before its record exists (the customer's reply bounces at the customer), a cutover that
// moves a builder before AWS has verified them. Each is pinned below.
//
// Self-contained (no jsr:/npm: imports of its own), like every test the gate discovers beside a
// function. Run from supabase/functions:
//   deno test --allow-env --allow-read --node-modules-dir=none portal-settings/emailSes_test.ts

import { emailOnSes, emailSesConnect, handleEmailSesAction, lookupMxHosts, SES_DKIM_SELECTOR, type EmailSesCtx } from "./emailSes.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, got ${a}` + (msg ? ` (${msg})` : ""));
}

// ── The database fake ────────────────────────────────────────────────────────────────────────

type Write = { op: "upsert" | "update"; row: Record<string, unknown> };
type DbOpts = {
  state?: Record<string, unknown> | null;
  /** The client_settings read fails like a database from before migration 383. */
  preMigration?: boolean;
  /** Another builder already receiving on the reply address. */
  holder?: boolean;
  writeError?: { message: string; code?: string } | null;
};

function fakeDb(opts: DbOpts = {}) {
  const writes: Write[] = [];
  const admin = {
    from(_table: string) {
      return {
        select(cols: string) {
          const filters: Record<string, unknown> = {};
          const b = {
            eq(c: string, v: unknown) { filters[c] = v; return b; },
            neq(c: string, v: unknown) { filters[`!${c}`] = v; return b; },
            maybeSingle() {
              if ("inbound_domain" in filters) return Promise.resolve({ data: opts.holder ? { client_id: "someone-else" } : null, error: null });
              if (opts.preMigration && /email_transport|ses_identity/.test(cols)) {
                return Promise.resolve({ data: null, error: { code: "42703", message: "column client_settings.email_transport does not exist" } });
              }
              return Promise.resolve({ data: opts.state ?? null, error: null });
            },
          };
          return b;
        },
        upsert(row: Record<string, unknown>, _o?: unknown) {
          writes.push({ op: "upsert", row });
          return Promise.resolve({ error: opts.writeError ?? null });
        },
        update(row: Record<string, unknown>) {
          writes.push({ op: "update", row });
          return { eq(_c: string, _v: unknown) { return Promise.resolve({ error: opts.writeError ?? null }); } };
        },
      };
    },
  };
  return { admin, writes };
}

// ── The fetch stub ───────────────────────────────────────────────────────────────────────────

type Call = { method: string; url: string; body: string };
const realFetch = globalThis.fetch;

function stubFetch(handler: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const c = { method: String(init?.method ?? "GET"), url: String(input), body: String(init?.body ?? "") };
    calls.push(c);
    return Promise.resolve(handler(c));
  }) as typeof fetch;
  return calls;
}
const j = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** GetEmailIdentity as AWS answers it, for a bring-your-own-DKIM identity in a given state. */
const identity = (dkim: string, verified = dkim === "SUCCESS") => ({
  IdentityType: "DOMAIN", VerifiedForSendingStatus: verified, VerificationStatus: dkim, FeedbackForwardingStatus: false,
  DkimAttributes: { Status: dkim, Tokens: [SES_DKIM_SELECTOR], SigningAttributesOrigin: "EXTERNAL" },
});

const SES = "https://email.us-east-2.amazonaws.com/v2/email/identities";
const MX = "inbound-smtp.us-east-2.amazonaws.com";
const ENV = ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "SES_DKIM_MODE", "EMAIL_DEFAULT_TRANSPORT", "RESEND_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

function setup(defaultSes = true) {
  for (const k of ENV) Deno.env.delete(k);
  Deno.env.set("SES_ACCESS_KEY_ID", "AKIDEXAMPLE");
  Deno.env.set("SES_SECRET_ACCESS_KEY", "test-secret");
  if (defaultSes) Deno.env.set("EMAIL_DEFAULT_TRANSPORT", "ses");
}
function teardown() {
  for (const k of ENV) Deno.env.delete(k);
  globalThis.fetch = realFetch;
}

function ctx(db: ReturnType<typeof fakeDb>, action: string, over: Partial<EmailSesCtx> = {}): EmailSesCtx {
  return {
    admin: db.admin,
    req: new Request("https://stub.example/functions/v1/portal-settings", { method: "POST" }),
    clientId: "acme-sheds",
    action,
    payload: {},
    operator: false,
    json: (body, status = 200) => j(body, status),
    dbFail: (_req, _cid, where) => j({ error: `Couldn't ${where}.`, ref: where }, 500),
    lookupMx: () => Promise.resolve([MX]),
    ...over,
  };
}
const body = async (r: Response | null) => (r ? await r.json() : null);

const DKIM_ROW = { type: "TXT", host: "ss1._domainkey.acmesheds.test", value: "p=MIGfMA0G", verified: false };
const MX_ROW = { type: "MX", host: "reply.acmesheds.test", value: MX, verified: false, priority: 10 };
/** Connected at SES, waiting on DNS. */
const ON_SES = {
  email_domain: "acmesheds.test", email_domain_status: "pending", email_dns_records: [DKIM_ROW], email_verified_at: null,
  resend_domain_id: null, resend_inbound_domain_id: null,
  inbound_domain: "reply.acmesheds.test", inbound_status: "pending", inbound_dns_records: [MX_ROW],
  email_transport: "ses", ses_identity: "acmesheds.test", ses_dns_records: null,
};
/** Verified and sending through Resend, replies on. */
const ON_RESEND = {
  email_domain: "acmesheds.test", email_domain_status: "verified", email_dns_records: [{ type: "TXT", host: "resend._domainkey.acmesheds.test", value: "p=old", verified: true }],
  email_verified_at: "2026-10-02T00:00:00Z", resend_domain_id: "rs-dom-1", resend_inbound_domain_id: "rs-dom-2",
  inbound_domain: "reply.acmesheds.test", inbound_status: "active", inbound_dns_records: [{ type: "MX", host: "reply.acmesheds.test", value: "inbound-smtp.us-east-1.amazonaws.com", verified: true, priority: 10 }],
  email_transport: "resend", ses_identity: null, ses_dns_records: null,
};
const NOTHING = { ...ON_SES, email_domain: null, email_domain_status: "not_configured", email_dns_records: null, inbound_domain: null, inbound_status: "off", inbound_dns_records: null, email_transport: null, ses_identity: null };
const CONNECT = { domain: "acmesheds.test", fromLocal: "info", fromName: "Acme Sheds" };

// ── email_connect_domain ─────────────────────────────────────────────────────────────────────

Deno.test("connect at SES: ONE DKIM TXT and the reply MX together, the builder pinned to ses, bounce emails switched off", async () => {
  setup();
  const calls = stubFetch((c) => (c.method === "POST" ? j(identity("NOT_STARTED", false)) : j({})));
  try {
    const db = fakeDb({ state: NOTHING });
    const res = await emailSesConnect(ctx(db, "email_connect_domain"), CONNECT);
    const out = await body(res);
    assertEquals(res?.status, 200);

    // What AWS was asked: a bring-your-own-DKIM identity, then no more bounce emails to the builder.
    assertEquals(calls.map((c) => `${c.method} ${c.url}`), [`POST ${SES}`, `PUT ${SES}/acmesheds.test/feedback`]);
    const create = JSON.parse(calls[0].body);
    assertEquals([create.EmailIdentity, create.DkimSigningAttributes.DomainSigningSelector], ["acmesheds.test", "ss1"]);
    const privateKey = String(create.DkimSigningAttributes.DomainSigningPrivateKey);
    assert(/^[A-Za-z0-9+/]{600,}={0,2}$/.test(privateKey), "a base64 private key went to AWS");
    assertEquals(JSON.parse(calls[1].body), { EmailForwardingEnabled: false });

    // What the builder is shown: one TXT, whose value is the PUBLIC half.
    assertEquals(out.dnsRecords.length, 1);
    const row = out.dnsRecords[0];
    assertEquals([row.type, row.host, row.verified], ["TXT", "ss1._domainkey.acmesheds.test", false]);
    assert(/^p=[A-Za-z0-9+/]+={0,2}$/.test(row.value) && row.value.length <= 255, `one DNS string, got ${row.value.length} characters`);

    // What was saved.
    assertEquals(db.writes.length, 1);
    const w = db.writes[0].row;
    assertEquals([w.email_domain, w.ses_identity, w.email_transport, w.email_domain_status], ["acmesheds.test", "acmesheds.test", "ses", "pending"]);
    assertEquals(w.email_dns_records, [row]);
    assertEquals([w.inbound_domain, w.inbound_status], ["reply.acmesheds.test", "pending"], "the reply record is handed out now, and NOT switched on");
    assertEquals(w.inbound_dns_records, [MX_ROW]);
    assertEquals([w.email_from_local, w.email_from_name], ["info", "Acme Sheds"]);
    // ⚠️ The private key is in AWS's hands only.
    assert(!JSON.stringify(db.writes).includes(privateKey), "the private key must never reach the database");
    assert(!JSON.stringify(out).includes(privateKey), "or the response");
  } finally { teardown(); }
});

Deno.test("connect returns null (Resend's turn) when the builder holds a Resend domain, the default is Resend, SES has no key, or the database is not migrated", async () => {
  try {
    setup();
    let calls = stubFetch(() => j({}));
    assertEquals(await emailSesConnect(ctx(fakeDb({ state: { ...NOTHING, resend_domain_id: "rs-dom-1" } }), "email_connect_domain"), CONNECT), null, "holds a Resend domain: their move is the operator's cutover");
    assertEquals(await emailSesConnect(ctx(fakeDb({ state: NOTHING, preMigration: true }), "email_connect_domain"), CONNECT), null, "no SES columns yet");
    assertEquals(calls.length, 0);

    setup(false);
    calls = stubFetch(() => j({}));
    assertEquals(await emailSesConnect(ctx(fakeDb({ state: NOTHING }), "email_connect_domain"), CONNECT), null, "the platform default is still Resend");

    setup();
    Deno.env.delete("SES_SECRET_ACCESS_KEY");
    assertEquals(await emailSesConnect(ctx(fakeDb({ state: NOTHING }), "email_connect_domain"), CONNECT), null, "no SES key on this deployment");
    assertEquals(calls.length, 0, "and AWS is never called in any of these");
  } finally { teardown(); }
});

Deno.test("a builder already on SES reconnects at SES even after the default went back to Resend, and the same domain keeps its key", async () => {
  setup(false);
  const calls = stubFetch(() => j(identity("SUCCESS")));
  try {
    const db = fakeDb({ state: ON_SES });
    const out = await body(await emailSesConnect(ctx(db, "email_connect_domain"), CONNECT));
    assertEquals(calls.map((c) => c.method), ["GET"], "read, never re-created: a new key would orphan the record they already published");
    assertEquals(out.dnsRecords, [{ ...DKIM_ROW, verified: true }]);
    assertEquals(db.writes[0].row.email_dns_records, [{ ...DKIM_ROW, verified: true }]);
  } finally { teardown(); }
});

Deno.test("an identity left over from a failed earlier connect is deleted and made again", async () => {
  setup();
  let posts = 0;
  const calls = stubFetch((c) => {
    if (c.method === "POST" && ++posts === 1) return j({ message: "exists" }, 409, { "x-amzn-errortype": "AlreadyExistsException" });
    return j(identity("NOT_STARTED", false));
  });
  try {
    const res = await emailSesConnect(ctx(fakeDb({ state: NOTHING }), "email_connect_domain"), CONNECT);
    assertEquals(res?.status, 200);
    assertEquals(calls.map((c) => c.method), ["POST", "DELETE", "POST", "PUT"]);
  } finally { teardown(); }
});

Deno.test("when the row cannot be saved, the new identity is deleted again: its public key would be lost", async () => {
  setup();
  const calls = stubFetch((c) => (c.method === "POST" ? j(identity("NOT_STARTED", false)) : j({})));
  try {
    const taken = await emailSesConnect(ctx(fakeDb({ state: NOTHING, writeError: { message: "duplicate", code: "23505" } }), "email_connect_domain"), CONNECT);
    assertEquals([taken?.status, (await body(taken)).error], [409, "That domain is already connected to another account."]);
    assertEquals(calls.map((c) => c.method), ["POST", "PUT", "DELETE"]);
  } finally { teardown(); }
});

Deno.test("another builder already receiving on the reply address refuses the connect before AWS is touched", async () => {
  setup();
  const calls = stubFetch(() => j({}));
  try {
    const res = await emailSesConnect(ctx(fakeDb({ state: NOTHING, holder: true }), "email_connect_domain"), CONNECT);
    assertEquals(res?.status, 409);
    assertEquals(calls.length, 0);
  } finally { teardown(); }
});

Deno.test("SES_DKIM_MODE=easy hands out AWS's three CNAMEs instead (the fallback)", async () => {
  setup();
  Deno.env.set("SES_DKIM_MODE", "easy");
  const calls = stubFetch((c) => (c.method === "POST"
    ? j({ VerifiedForSendingStatus: false, DkimAttributes: { Status: "NOT_STARTED", Tokens: ["aaa", "bbb", "ccc"], SigningAttributesOrigin: "AWS_SES" } })
    : j({})));
  try {
    const out = await body(await emailSesConnect(ctx(fakeDb({ state: NOTHING }), "email_connect_domain"), CONNECT));
    assertEquals(JSON.parse(calls[0].body).DkimSigningAttributes, { NextSigningKeyLength: "RSA_2048_BIT" });
    assertEquals(out.dnsRecords.map((r: { type: string; host: string; value: string }) => `${r.type} ${r.host} ${r.value}`), [
      "CNAME aaa._domainkey.acmesheds.test aaa.dkim.amazonses.com",
      "CNAME bbb._domainkey.acmesheds.test bbb.dkim.amazonses.com",
      "CNAME ccc._domainkey.acmesheds.test ccc.dkim.amazonses.com",
    ]);
  } finally { teardown(); }
});

// ── Who is answered here at all ──────────────────────────────────────────────────────────────

Deno.test("every action returns null for a builder on Resend, a builder with no domain, and an unmigrated database", async () => {
  setup();
  const calls = stubFetch(() => j({}));
  try {
    for (const action of ["email_verify_domain", "email_tracking_check", "email_disconnect", "email_inbound_connect", "email_inbound_verify", "email_inbound_disconnect"]) {
      assertEquals(await handleEmailSesAction(ctx(fakeDb({ state: ON_RESEND }), action)), null, `${action} / Resend`);
      assertEquals(await handleEmailSesAction(ctx(fakeDb({ state: NOTHING }), action)), null, `${action} / no domain`);
      assertEquals(await handleEmailSesAction(ctx(fakeDb({ state: ON_SES, preMigration: true }), action)), null, `${action} / unmigrated`);
    }
    assertEquals(calls.length, 0, "and nothing was asked of AWS");
  } finally { teardown(); }
});

Deno.test("emailOnSes never throws and is false for anything but a builder pinned to SES with an identity", async () => {
  assertEquals(await emailOnSes(fakeDb({ state: ON_SES }).admin, "acme-sheds"), true);
  assertEquals(await emailOnSes(fakeDb({ state: ON_RESEND }).admin, "acme-sheds"), false);
  assertEquals(await emailOnSes(fakeDb({ state: null }).admin, "acme-sheds"), false);
  assertEquals(await emailOnSes(fakeDb({ state: ON_SES, preMigration: true }).admin, "acme-sheds"), false);
  assertEquals(await emailOnSes({ from() { throw new Error("down"); } }, "acme-sheds"), false);
});

// ── email_verify_domain ──────────────────────────────────────────────────────────────────────

Deno.test("verify is a READ: verified at AWS with the reply record seen switches sending AND replies on", async () => {
  setup();
  const calls = stubFetch(() => j(identity("SUCCESS")));
  try {
    const db = fakeDb({ state: ON_SES });
    const out = await body(await handleEmailSesAction(ctx(db, "email_verify_domain")));
    assertEquals(calls.map((c) => `${c.method} ${c.url}`), [`GET ${SES}/acmesheds.test`], "one read; there is no verify call to park the domain");
    assertEquals([out.verified, out.domainStatus, out.providerStatus, out.inboundStatus], [true, "verified", "SUCCESS", "active"]);
    assertEquals(out.dnsRecords, [{ ...DKIM_ROW, verified: true }]);
    const w = db.writes[0].row;
    assertEquals([w.email_domain_status, w.inbound_status, w.email_last_error], ["verified", "active", null]);
    assert(typeof w.email_verified_at === "string" && typeof w.inbound_verified_at === "string", "both stamped");
    assertEquals(w.inbound_dns_records, [{ ...MX_ROW, verified: true }]);
  } finally { teardown(); }
});

Deno.test("verified at AWS but the reply record missing, or DNS unreadable: sending is verified and replies stay pending", async () => {
  setup();
  stubFetch(() => j(identity("SUCCESS")));
  try {
    for (const mx of [[], ["mx.elsewhere.test"], null] as (string[] | null)[]) {
      const db = fakeDb({ state: ON_SES });
      const out = await body(await handleEmailSesAction(ctx(db, "email_verify_domain", { lookupMx: () => Promise.resolve(mx) })));
      assertEquals([out.verified, out.inboundStatus], [true, undefined], JSON.stringify(mx));
      assert(!("inbound_status" in db.writes[0].row), "the reply columns are left exactly as they were");
    }
  } finally { teardown(); }
});

Deno.test("not verified yet: pending, replies untouched even though their record is there", async () => {
  setup();
  stubFetch(() => j(identity("PENDING", false)));
  try {
    let looked = 0;
    const db = fakeDb({ state: ON_SES });
    const out = await body(await handleEmailSesAction(ctx(db, "email_verify_domain", { lookupMx: () => { looked++; return Promise.resolve([MX]); } })));
    assertEquals([out.verified, out.domainStatus], [false, "pending"]);
    assertEquals(looked, 0, "an unverified identity receives nothing, so the reply record is not even looked for");
    assert(!("inbound_status" in db.writes[0].row), "replies cannot switch on before the domain is verified");
  } finally { teardown(); }
});

Deno.test("AWS has given up, or a verified domain failed a re-check: `failed`, with the sentence that says what to do", async () => {
  setup();
  try {
    stubFetch(() => j(identity("FAILED", false)));
    let db = fakeDb({ state: ON_SES });
    let out = await body(await handleEmailSesAction(ctx(db, "email_verify_domain")));
    assertEquals(out.domainStatus, "failed");
    assert(String(db.writes[0].row.email_last_error).includes("disconnect and reconnect"), "AWS stopped checking");

    stubFetch(() => j(identity("TEMPORARY_FAILURE", false)));
    db = fakeDb({ state: { ...ON_SES, email_verified_at: "2026-11-01T00:00:00Z" } });
    out = await body(await handleEmailSesAction(ctx(db, "email_verify_domain")));
    assertEquals(out.domainStatus, "failed");
    assert(String(db.writes[0].row.email_last_error).includes("passed before"), "a re-check failed");
    assertEquals(db.writes[0].row.email_verified_at, "2026-11-01T00:00:00Z", "it still proved control once");
  } finally { teardown(); }
});

Deno.test("an AWS failure is an authored 502 with no AWS text, and parks a note on the card", async () => {
  setup();
  stubFetch(() => j({ message: "Identity acmesheds.test is not verified for jane@example.org" }, 500, { "x-amzn-errortype": "InternalFailure" }));
  try {
    const db = fakeDb({ state: ON_SES });
    const res = await handleEmailSesAction(ctx(db, "email_verify_domain"));
    const out = await body(res);
    assertEquals(res?.status, 502);
    assert(!JSON.stringify(out).includes("jane@") && !JSON.stringify(out).toLowerCase().includes("amazon"), "no provider text and no provider name reaches the builder");
    assertEquals(db.writes[0].row.email_last_error, "The verification check couldn't run — try again in a few minutes.");
  } finally { teardown(); }
});

// ── The rest of the screen ───────────────────────────────────────────────────────────────────

Deno.test("opens are refused with a plain sentence on SES; nothing is written and AWS is not called", async () => {
  setup();
  const calls = stubFetch(() => j({}));
  try {
    const db = fakeDb({ state: { ...ON_SES, email_domain_status: "verified" } });
    const res = await handleEmailSesAction(ctx(db, "email_tracking_check"));
    assertEquals(res?.status, 409);
    assert(String((await body(res)).error).includes("isn't available"), "says so");
    assertEquals([db.writes.length, calls.length], [0, 0]);
  } finally { teardown(); }
});

Deno.test("disconnect deletes the identity and resets everything, pin included; a stuck provider does not trap the builder", async () => {
  setup();
  try {
    for (const status of [200, 500]) {
      const calls = stubFetch(() => j({}, status));
      const db = fakeDb({ state: { ...ON_SES, email_domain_status: "verified", inbound_status: "active" } });
      const res = await handleEmailSesAction(ctx(db, "email_disconnect"));
      assertEquals(res?.status, 200, `provider answered ${status}`);
      assertEquals(calls.map((c) => `${c.method} ${c.url}`), [`DELETE ${SES}/acmesheds.test`]);
      const w = db.writes[0].row;
      assertEquals([w.email_domain, w.ses_identity, w.email_transport, w.email_provider, w.email_domain_status, w.inbound_domain, w.inbound_status],
        [null, null, null, "ghl", "not_configured", null, "off"]);
    }
  } finally { teardown(); }
});

Deno.test("the reply address: off and on again without the provider, and Check it never flips on a DNS hiccup", async () => {
  setup();
  const calls = stubFetch(() => j({}));
  try {
    const verified = { ...ON_SES, email_domain_status: "verified" };
    // Turned off.
    let db = fakeDb({ state: { ...verified, inbound_status: "active" } });
    assertEquals((await handleEmailSesAction(ctx(db, "email_inbound_disconnect")))?.status, 200);
    assertEquals([db.writes[0].row.inbound_domain, db.writes[0].row.inbound_status], [null, "off"]);
    // Set up again: pending, with the record.
    db = fakeDb({ state: { ...verified, inbound_domain: null, inbound_status: "off" } });
    let out = await body(await handleEmailSesAction(ctx(db, "email_inbound_connect")));
    assertEquals([out.inboundDomain, out.dnsRecords, db.writes[0].row.inbound_status], ["reply.acmesheds.test", [MX_ROW], "pending"]);
    // Not before sending is verified.
    assertEquals((await handleEmailSesAction(ctx(fakeDb({ state: ON_SES }), "email_inbound_connect")))?.status, 400);
    // Check it: seen.
    db = fakeDb({ state: verified });
    out = await body(await handleEmailSesAction(ctx(db, "email_inbound_verify")));
    assertEquals([out.verified, out.inboundStatus, db.writes[0].row.inbound_status], [true, "active", "active"]);
    // Check it: DNS says the record is not there.
    db = fakeDb({ state: { ...verified, inbound_status: "active" } });
    out = await body(await handleEmailSesAction(ctx(db, "email_inbound_verify", { lookupMx: () => Promise.resolve([]) })));
    assertEquals([out.verified, db.writes[0].row.inbound_status], [false, "pending"], "a definite no switches it off: replies would bounce");
    // Check it: DNS could not say. A working address stays on, a waiting one stays waiting.
    db = fakeDb({ state: { ...verified, inbound_status: "active" } });
    out = await body(await handleEmailSesAction(ctx(db, "email_inbound_verify", { lookupMx: () => Promise.resolve(null) })));
    assertEquals([out.verified, out.inboundStatus, db.writes.length], [true, "active", 0]);
    // Check it on an unverified domain: SES would accept nothing, whatever the MX says.
    db = fakeDb({ state: ON_SES });
    out = await body(await handleEmailSesAction(ctx(db, "email_inbound_verify")));
    assertEquals([out.verified, db.writes[0].row.inbound_status], [false, "pending"]);
    assertEquals(calls.length, 0, "the reply address is never an object at the provider");
  } finally { teardown(); }
});

// ── Operator: move a builder who is on Resend ────────────────────────────────────────────────

Deno.test("prepare and cut over refuse anyone who is not CSM Synergy staff", async () => {
  setup();
  const calls = stubFetch(() => j({}));
  try {
    for (const action of ["email_ses_prepare", "email_ses_cutover"]) {
      const db = fakeDb({ state: ON_RESEND });
      const res = await handleEmailSesAction(ctx(db, action, { operator: false }));
      assertEquals(res?.status, 403, action);
      assertEquals([db.writes.length, calls.length], [0, 0]);
    }
  } finally { teardown(); }
});

Deno.test("prepare creates the SES identity BESIDE Resend: staged records only, the builder's live email untouched", async () => {
  setup();
  const calls = stubFetch((c) => (c.method === "POST" ? j(identity("NOT_STARTED", false)) : j({})));
  try {
    const db = fakeDb({ state: ON_RESEND });
    // The reply MX still points at Resend's region.
    const out = await body(await handleEmailSesAction(ctx(db, "email_ses_prepare", { operator: true, lookupMx: () => Promise.resolve(["inbound-smtp.us-east-1.amazonaws.com"]) })));
    assertEquals(calls.map((c) => c.method), ["POST", "PUT"]);
    assertEquals([out.transport, out.domainVerified, out.replyRecordSeen], ["resend", false, false]);
    assertEquals(out.dnsRecords.map((r: { type: string; host: string; verified: boolean }) => `${r.type} ${r.host} ${r.verified}`),
      ["TXT ss1._domainkey.acmesheds.test false", "MX reply.acmesheds.test false"]);
    assertEquals(db.writes.length, 1);
    assertEquals(Object.keys(db.writes[0].row).sort(), ["ses_dns_records", "ses_identity", "updated_at"], "nothing the live Resend setup reads is written");
  } finally { teardown(); }
});

Deno.test("prepare pressed again reads AWS and DNS and keeps the key it already handed out", async () => {
  setup();
  const calls = stubFetch(() => j(identity("SUCCESS")));
  try {
    const staged = { ...ON_RESEND, ses_identity: "acmesheds.test", ses_dns_records: [DKIM_ROW, MX_ROW] };
    const db = fakeDb({ state: staged });
    const out = await body(await handleEmailSesAction(ctx(db, "email_ses_prepare", { operator: true, lookupMx: () => Promise.resolve(["inbound-smtp.us-east-1.amazonaws.com", MX]) })));
    assertEquals(calls.map((c) => c.method), ["GET"]);
    assertEquals([out.domainVerified, out.replyRecordSeen], [true, true], "both providers' reply records can be live together");
    assertEquals(out.dnsRecords, [{ ...DKIM_ROW, verified: true }, { ...MX_ROW, verified: true }]);
  } finally { teardown(); }
});

Deno.test("cut over REFUSES until AWS has verified the domain, and until a replying builder's MX names SES", async () => {
  setup();
  try {
    const staged = { ...ON_RESEND, ses_identity: "acmesheds.test", ses_dns_records: [DKIM_ROW, MX_ROW] };
    stubFetch(() => j(identity("PENDING", false)));
    let db = fakeDb({ state: staged });
    let res = await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true }));
    assertEquals([res?.status, db.writes.length], [409, 0], "not verified: stays on Resend");

    stubFetch(() => j(identity("SUCCESS")));
    for (const mx of [["inbound-smtp.us-east-1.amazonaws.com"], null] as (string[] | null)[]) {
      db = fakeDb({ state: staged });
      res = await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true, lookupMx: () => Promise.resolve(mx) }));
      assertEquals([res?.status, db.writes.length], [409, 0], `reply MX ${JSON.stringify(mx)}: their replies would be lost`);
    }
    // Never prepared.
    db = fakeDb({ state: ON_RESEND });
    assertEquals((await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true })))?.status, 409);
  } finally { teardown(); }
});

Deno.test("cut over flips the pin in ONE write, swaps the DNS table, and keeps the Resend domain as the way back", async () => {
  setup();
  stubFetch(() => j(identity("SUCCESS")));
  try {
    const staged = { ...ON_RESEND, ses_identity: "acmesheds.test", ses_dns_records: [DKIM_ROW, MX_ROW] };
    const db = fakeDb({ state: staged });
    const out = await body(await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true })));
    assertEquals(out, { ok: true, transport: "ses" });
    assertEquals(db.writes.length, 1);
    const w = db.writes[0].row;
    assertEquals([w.email_transport, w.email_domain_status, w.ses_dns_records], ["ses", "verified", null]);
    assertEquals(w.email_dns_records, [{ ...DKIM_ROW, verified: true }]);
    assertEquals(w.inbound_dns_records, [{ ...MX_ROW, verified: true }]);
    assertEquals(w.email_verified_at, "2026-10-02T00:00:00Z", "the day they first proved the domain is kept");
    assert(!("resend_domain_id" in w) && !("resend_inbound_domain_id" in w), "the Resend ids are not touched");
    assert(!("inbound_status" in w), "replies stay exactly as they were: on");
  } finally { teardown(); }
});

Deno.test("back: one write returns the builder to Resend. finish: the Resend domains are deleted and their ids cleared", async () => {
  setup();
  Deno.env.set("RESEND_API_KEY", "re_test");
  try {
    const cut = { ...ON_RESEND, email_transport: "ses", ses_identity: "acmesheds.test" };
    let calls = stubFetch(() => j({}));
    let db = fakeDb({ state: cut });
    let out = await body(await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true, payload: { back: true } })));
    assertEquals([out.transport, db.writes[0].row.email_transport, calls.length], ["resend", "resend", 0]);

    // No way back once the Resend domain is gone.
    db = fakeDb({ state: { ...cut, resend_domain_id: null } });
    assertEquals((await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true, payload: { back: true } })))?.status, 409);

    calls = stubFetch(() => j({}));
    db = fakeDb({ state: cut });
    out = await body(await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true, payload: { finish: true } })));
    assertEquals(calls.map((c) => `${c.method} ${c.url}`), ["DELETE https://api.resend.com/domains/rs-dom-1", "DELETE https://api.resend.com/domains/rs-dom-2"]);
    assertEquals([out.finished, db.writes[0].row.resend_domain_id, db.writes[0].row.resend_inbound_domain_id], [true, null, null]);

    // finish is refused for a builder who was never cut over.
    db = fakeDb({ state: ON_RESEND });
    assertEquals((await handleEmailSesAction(ctx(db, "email_ses_cutover", { operator: true, payload: { finish: true } })))?.status, 409);
  } finally { teardown(); }
});

// ── Public DNS ───────────────────────────────────────────────────────────────────────────────

Deno.test("lookupMxHosts reads the hosts out of a DoH answer, falls to the second resolver, and is null when neither can say", async () => {
  try {
    let calls = stubFetch(() => j({ Status: 0, Answer: [{ type: 15, data: "10 Inbound-SMTP.us-east-2.amazonaws.com." }, { type: 16, data: '"v=spf1"' }] }));
    assertEquals(await lookupMxHosts("reply.acmesheds.test"), [MX]);
    assert(calls[0].url.startsWith("https://cloudflare-dns.com/dns-query?name=reply.acmesheds.test&type=MX"), calls[0].url);

    stubFetch(() => j({ Status: 3 }));
    assertEquals(await lookupMxHosts("nope.acmesheds.test"), [], "a name that does not exist has no MX: a definite answer");

    calls = stubFetch((c) => (c.url.includes("cloudflare") ? j({ Status: 2 }) : j({ Status: 0, Answer: [{ type: 15, data: `10 ${MX}.` }] })));
    assertEquals(await lookupMxHosts("reply.acmesheds.test"), [MX], "SERVFAIL at the first resolver is not an answer");
    assertEquals(calls.length, 2);

    globalThis.fetch = (() => Promise.reject(new TypeError("no route"))) as typeof fetch;
    assertEquals(await lookupMxHosts("reply.acmesheds.test"), null);
  } finally { teardown(); }
});

// ── The wiring in index.ts ───────────────────────────────────────────────────────────────────

Deno.test("index.ts asks this file first for every email action, names each one, and hooks connect before Resend's create", async () => {
  const src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const dispatch = src.indexOf("const sesAnswer = await handleEmailSesAction({");
  assert(dispatch > 0, "the dispatcher is there");
  const head = src.slice(src.lastIndexOf("  if (action ===", dispatch), dispatch);
  for (const a of ["email_verify_domain", "email_tracking_check", "email_disconnect", "email_inbound_connect", "email_inbound_verify", "email_inbound_disconnect", "email_ses_prepare", "email_ses_cutover"]) {
    assert(head.includes(`action === "${a}"`), `${a} is named in the dispatcher`);
    assert(src.includes(`  ${a}:`), `${a} has a GATES entry`);
  }
  assert(src.includes("if (sesAnswer) return sesAnswer;"), "null falls through to the Resend branch");
  // The staff check for the two operator-only actions is callerIsOperator(), which also knows a
  // staff member on their OWN tenant. `operator` alone is null there, and the internal account
  // (the first builder to move) is exactly that case.
  assert(src.includes(`const staffOnly = action === "email_ses_prepare" || action === "email_ses_cutover";`), "the two staff-only actions are named");
  assert(src.includes("operator: staffOnly ? await callerIsOperator() : Boolean(operator),"), "and are judged by callerIsOperator()");
  assert(src.indexOf("const callerIsOperator = (): Promise<boolean> => {") > 0 && src.indexOf("const callerIsOperator = (): Promise<boolean> => {") < dispatch, "which is defined before the dispatcher runs");
  for (const a of ["email_verify_domain", "email_tracking_check", "email_disconnect", "email_inbound_connect", "email_inbound_verify", "email_inbound_disconnect"]) {
    assert(dispatch < src.indexOf(`if (action === "${a}") {`), `the dispatcher runs before ${a}'s Resend branch`);
  }
  const connect = src.indexOf(`if (action === "email_connect_domain") {`);
  const hook = src.indexOf("const sesConnect = await emailSesConnect(", connect);
  const create = src.indexOf("await rsCreateDomain(domain)", connect);
  const holder = src.indexOf("That domain is already connected to another account.", connect);
  assert(connect > 0 && hook > connect && create > hook, "the SES hook sits inside the connect branch, before Resend's create");
  assert(holder > connect && holder < hook, "and after the checks both providers share (who holds the domain)");
});
