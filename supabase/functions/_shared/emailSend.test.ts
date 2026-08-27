/**
 * Unit tests for sendTenantEmail — the business action over the Restmark transport.
 *
 * WHY THESE EXIST. The function's whole value is its guarantees: dark until three human
 * switches flip, ledger row before the provider call, beta redirect recorded rather than
 * silent, and a promise that never rejects no matter what the provider or the database
 * does. None of that is observable from a happy-path manual send, so each guarantee is
 * pinned here with BOTH dependencies stubbed: `globalThis.fetch` (the Resend side) and
 * a recording fake of the supabase client (the ledger side). No network, no database.
 *
 * Run: deno test --allow-env --node-modules-dir=none supabase/functions/_shared/emailSend.test.ts
 * (the pre-push gate runs this for you with exactly those flags — see scripts/preflight.mjs)
 */

import { sendTenantEmail, type TenantMail } from "./emailSend.ts";

// Local assertions rather than jsr:@std/assert, deliberately. The pre-push gate runs this
// file, and a gate that needs a registry fetch fails closed on an offline machine — which
// is the one thing scripts/preflight.mjs promises never to do.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      + (msg ? ` — ${msg}` : ""));
  }
}

// ── Fetch stub (the Resend side) ─────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

type FetchCall = { url: string; method: string; body: string | null };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: FetchCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_SEND = { id: "rs-msg-1" };

// ── Admin stub (the ledger side) ───────────────────────────────────────────────────────────
// Records every .from() chain so a test can assert WHAT was written and in what order.
// Shapes mirror the four supabase-js call patterns emailSend.ts uses:
//   from("client_settings").select(…).eq(…).maybeSingle()
//   from("email_sends").insert(row).select("id").single()
//   from("email_sends").update(patch).eq("id", id)   ← awaited directly (builders are thenables)

type DbCall = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
};

type StubOpts = {
  /** The client_settings row maybeSingle() hands back (null = no row). */
  settings?: Record<string, unknown> | null;
  /** Force the email_sends insert to fail / return no id. */
  insertError?: { message: string } | null;
  insertThrows?: boolean;
  /** Force every email_sends update to fail. */
  updateError?: { message: string } | null;
};

function stubAdmin(opts: StubOpts = {}) {
  const calls: DbCall[] = [];
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) {
          const call: DbCall = { table, op: "select", filters: {} };
          calls.push(call);
          const builder = {
            eq(col: string, val: unknown) {
              call.filters[col] = val;
              return builder;
            },
            maybeSingle() {
              return Promise.resolve({
                data: table === "client_settings" ? (opts.settings ?? null) : null,
                error: null,
              });
            },
          };
          return builder;
        },
        insert(row: Record<string, unknown>) {
          const call: DbCall = { table, op: "insert", payload: row, filters: {} };
          calls.push(call);
          return {
            select(_cols: string) {
              return {
                single() {
                  if (opts.insertThrows) throw new Error("connection reset mid-insert");
                  return Promise.resolve(
                    opts.insertError
                      ? { data: null, error: opts.insertError }
                      : { data: { id: "es-row-1" }, error: null },
                  );
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const call: DbCall = { table, op: "update", payload: patch, filters: {} };
          calls.push(call);
          return {
            eq(col: string, val: unknown) {
              call.filters[col] = val;
              return Promise.resolve({ error: opts.updateError ?? null });
            },
          };
        },
      };
    },
  };
  return { admin, calls };
}

const inserts = (calls: DbCall[]) =>
  calls.filter((c) => c.table === "email_sends" && c.op === "insert");
const updates = (calls: DbCall[]) =>
  calls.filter((c) => c.table === "email_sends" && c.op === "update");

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = "tenant-1";

const MAIL: TenantMail = {
  kind: "estimate",
  shortCode: "SS-TEST123456",
  to: "lead@example.net",
  subject: "Your estimate",
  html: "<p>Hi</p>",
  text: "Hi",
};

const VERIFIED = {
  email_provider: "resend",
  email_domain_status: "verified",
  email_domain: "mail.example.com",
  email_from_local: "quotes",
  email_from_name: "Example Barns",
  business_name: "Example Barns LLC",
  beta_mode: false,
  beta_email: null,
};
const PENDING = { ...VERIFIED, email_domain_status: "pending" };
/** A tenant whose inbound subdomain is connected AND verified. */
const INBOUND_ON = { ...VERIFIED, inbound_domain: "reply.example.com", inbound_status: "active" };

function setup() {
  Deno.env.set("RESEND_API_KEY", "test-resend-key");
  // logEdgeError only writes when these are set; deleting them keeps the fallback a
  // deterministic no-op (zero fetches) on every machine, not just ones without a local
  // supabase env.
  Deno.env.delete("SUPABASE_URL");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("PLATFORM_EMAIL_DOMAIN_READY");
}
function teardown() {
  globalThis.fetch = realFetch;
  Deno.env.delete("RESEND_API_KEY");
  Deno.env.delete("PLATFORM_EMAIL_DOMAIN_READY");
}

// ── Dark-guard matrix: not_active with ZERO network calls and ZERO ledger rows ─────────────

Deno.test("provider 'ghl' (the default) → not_active, zero fetches, no ledger row", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: { ...VERIFIED, email_provider: "ghl" } });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assertEquals(res.sent, false);
    assert(!res.sent && res.reason === "not_active", "a ghl tenant must be not_active");
    assertEquals(fetches.length, 0, "the dark guard must make zero network calls");
    assertEquals(inserts(db.calls).length, 0, "a dark send must leave no ledger row");
  } finally {
    teardown();
  }
});

Deno.test("secrets absent → not_active before even the settings read", async () => {
  setup();
  Deno.env.delete("RESEND_API_KEY");
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "not_active", "missing secrets must be not_active");
    assertEquals(fetches.length, 0);
    assertEquals(db.calls.length, 0, "an unconfigured deployment must not touch the database");
  } finally {
    teardown();
  }
});

Deno.test("no client_settings row → not_active", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: null });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "not_active", "a missing row must be not_active");
    assertEquals(fetches.length, 0);
    assertEquals(inserts(db.calls).length, 0);
  } finally {
    teardown();
  }
});

Deno.test("domain pending + platform flag OFF → not_active, zero fetches", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: PENDING });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "not_active",
      "the platform fallback must not fire until PLATFORM_EMAIL_DOMAIN_READY says its DNS is live");
    assertEquals(fetches.length, 0);
    assertEquals(inserts(db.calls).length, 0);
  } finally {
    teardown();
  }
});

// ── From resolution ────────────────────────────────────────────────────────────────────────

Deno.test("pending + PLATFORM_EMAIL_DOMAIN_READY=true → platform From with the business name", async () => {
  setup();
  Deno.env.set("PLATFORM_EMAIL_DOMAIN_READY", "true");
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: PENDING });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "the platform-domain path must send");
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.from, '"Example Barns LLC" <no-reply@mail.structurestudiosuite.com>',
      "unverified tenants send from the platform domain, named as the business");
    const row = inserts(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(row.from_email, "no-reply@mail.structurestudiosuite.com");
  } finally {
    teardown();
  }
});

Deno.test("verified → tenant From: {email_from_local}@{email_domain}, named email_from_name", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "a verified tenant must send");
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.from, '"Example Barns" <quotes@mail.example.com>',
      "email_from_name wins over business_name; email_from_local over 'info'");
    const row = inserts(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(row.from_email, "quotes@mail.example.com");
    assert(!("intended_email" in row), "no redirect → no intended_email on the row");
  } finally {
    teardown();
  }
});

Deno.test("verified with no from-name/local set → info@domain, named business_name", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({
      settings: { ...VERIFIED, email_from_local: null, email_from_name: null },
    });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "must send");
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.from, '"Example Barns LLC" <info@mail.example.com>');
  } finally {
    teardown();
  }
});

Deno.test("an estimate send routes replies back into the portal", async () => {
  setup();
  try {
    // THE BUG THIS PINS. MAIL is kind:"estimate" and passes NO replyTo, exactly as
    // submit-estimate does. The routing address used to be computed inside portal-settings'
    // crm_send_email — one of ten call sites — so a customer replying to their quote, by far
    // the likeliest reply in the product, reached nobody. Deriving it in sendTenantEmail is
    // what lights up all ten paths.
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: INBOUND_ON });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "must send");
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.reply_to, "d.ss-test123456@reply.example.com",
      "a quote reply must come back to the design, with no caller plumbing");
    // And the threading Message-ID rides along on the same send.
    assert(String(body.headers?.["Message-ID"] ?? "").startsWith("<ss.tenant-1.d.ss-test123456."),
      `Message-ID must encode tenant and design, got ${JSON.stringify(body.headers)}`);
  } finally {
    teardown();
  }
});

Deno.test("the routing address BEATS a caller's replyTo, and only when inbound is active", async () => {
  setup();
  try {
    // Caller passes a staff address; a verified inbound domain outranks it, because a reply
    // in the portal beats a reply in one person's inbox.
    let fetches = stubFetch(() => jsonResponse(OK_SEND));
    let db = stubAdmin({ settings: INBOUND_ON });
    await sendTenantEmail(db.admin, CLIENT_ID, { ...MAIL, replyTo: "staff@example.com" });
    assertEquals(JSON.parse(fetches[0].body ?? "{}").reply_to, "d.ss-test123456@reply.example.com");

    // 'pending' must LOSE to the staff address. A domain whose MX is unproven sends the
    // customer's reply into a bounce, and the builder never learns they tried — strictly
    // worse than the inbox that was working before.
    fetches = stubFetch(() => jsonResponse(OK_SEND));
    db = stubAdmin({ settings: { ...INBOUND_ON, inbound_status: "pending" } });
    await sendTenantEmail(db.admin, CLIENT_ID, { ...MAIL, replyTo: "staff@example.com" });
    assertEquals(JSON.parse(fetches[0].body ?? "{}").reply_to, "staff@example.com");

    // No inbound domain at all — every tenant today — and no caller address either: the key
    // must be absent from the wire rather than present and null.
    fetches = stubFetch(() => jsonResponse(OK_SEND));
    db = stubAdmin({ settings: VERIFIED });
    await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!("reply_to" in JSON.parse(fetches[0].body ?? "{}")), "omitted, not null");
  } finally {
    teardown();
  }
});

Deno.test("the From display name is double-quote-escaped", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({
      settings: { ...VERIFIED, email_from_name: 'Bob "The Builder" & Sons' },
    });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "must send");
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.from, '"Bob \\"The Builder\\" & Sons" <quotes@mail.example.com>');
  } finally {
    teardown();
  }
});

// ── Beta redirect ──────────────────────────────────────────────────────────────────────────

Deno.test("beta_mode + beta_email → sends to beta_email, records intended_email", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({
      settings: { ...VERIFIED, beta_mode: true, beta_email: "owner@example.com" },
    });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "the redirected send must still send");
    assertEquals(res.sent && res.to, "owner@example.com", "the result reports the ACTUAL recipient");
    assertEquals(res.sent && res.redirected, true);
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.to, "owner@example.com", "the provider call must go to the test inbox");
    const row = inserts(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(row.to_email, "owner@example.com", "to_email records where it really went");
    assertEquals(row.intended_email, "lead@example.net", "intended_email records who it was for");
  } finally {
    teardown();
  }
});

Deno.test("beta_mode with NO beta_email does not redirect", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: { ...VERIFIED, beta_mode: true, beta_email: "  " } });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "must send");
    assertEquals(res.sent && res.redirected, false);
    const body = JSON.parse(fetches[0].body ?? "{}");
    assertEquals(body.to, "lead@example.net");
    assert(!("intended_email" in (inserts(db.calls)[0].payload as Record<string, unknown>)),
      "no redirect → no intended_email");
  } finally {
    teardown();
  }
});

// ── Ledger transitions ─────────────────────────────────────────────────────────────────────

Deno.test("claimed BEFORE the provider call, then flipped to sent with the provider id", async () => {
  setup();
  try {
    const db = stubAdmin({ settings: VERIFIED });
    let claimedWhenSendFired = -1;
    const fetches = stubFetch(() => {
      claimedWhenSendFired = inserts(db.calls).length;
      return jsonResponse(OK_SEND);
    });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "must send");
    assertEquals(res.sent && res.messageId, "rs-msg-1");
    assertEquals(claimedWhenSendFired, 1, "the claim row must exist before Postmark is called");

    const row = inserts(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(row.client_id, CLIENT_ID);
    assertEquals(row.short_code, "SS-TEST123456");
    assertEquals(row.kind, "estimate");
    assertEquals(row.subject, "Your estimate");
    assertEquals(row.status, "claimed", "the row is claimed first, never born 'sent'");

    const upd = updates(db.calls);
    assertEquals(upd.length, 1);
    assertEquals((upd[0].payload as Record<string, unknown>).status, "sent");
    assertEquals((upd[0].payload as Record<string, unknown>).provider_message_id, "rs-msg-1",
      "the provider message id is the webhook's only match key — it must be persisted");
    assertEquals(upd[0].filters.id, "es-row-1", "the update must target the claimed row");

    const body = JSON.parse(fetches[0].body ?? "{}");
    // Resend has no Tag/Metadata split — one tags array carries both. Read it as a map so
    // the assertion does not depend on array order.
    const tags = Object.fromEntries(
      (body.tags as { name: string; value: string }[]).map((x) => [x.name, x.value]),
    );
    assertEquals(tags.client_id, CLIENT_ID);
    assertEquals(tags.short_code, "SS-TEST123456");
    assertEquals(tags.kind, "estimate");
    assertEquals(body.text, "Hi");
  } finally {
    teardown();
  }
});

Deno.test("kind 'test' with no shortCode → null on the row, tag omitted entirely", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, {
      kind: "test", to: "owner@example.com", subject: "Test email", html: "<p>t</p>",
    });
    assert(res.sent, "must send");
    const row = inserts(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(row.short_code, null);
    assertEquals(row.kind, "test");
    const body = JSON.parse(fetches[0].body ?? "{}");
    const tags2 = Object.fromEntries(
      (body.tags as { name: string; value: string }[]).map((x) => [x.name, x.value]),
    );
    assert(!("short_code" in tags2), "no shortCode → the tag is OMITTED, not sent empty");
    assertEquals(tags2.kind, "test");
    assert(!("text" in body), "no text → no text key");
  } finally {
    teardown();
  }
});

Deno.test("provider 500 → claimed flips to failed with the capped enum-ish error", async () => {
  setup();
  try {
    stubFetch(() => new Response(
      // A realistic Resend error body echoing the recipient — it must never surface.
      // No usable `name` here, so errText renders "unknown" rather than inventing one.
      JSON.stringify({ statusCode: 500, message: "server error for lead@example.net" }),
      { status: 500 },
    ));
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "failed", "a provider failure is 'failed', not a throw");
    assertEquals(!res.sent ? res.error : "", "resend 500/unknown");

    const upd = updates(db.calls);
    assertEquals(upd.length, 1);
    const patch = upd[0].payload as Record<string, unknown>;
    assertEquals(patch.status, "failed");
    assertEquals(patch.error, "resend 500/unknown",
      "the ledger records status/name only — Resend's message echoes recipient addresses");
    assert(!String(patch.error).includes("lead@example.net"), "a recipient address leaked");
    assertEquals(upd[0].filters.id, "es-row-1");
  } finally {
    teardown();
  }
});

Deno.test("a permanent refusal (422 validation_error) records 'resend 422/validation_error'", async () => {
  setup();
  try {
    stubFetch(() => jsonResponse({
      statusCode: 422,
      name: "validation_error",
      message: "Invalid recipient: lead@example.net",
    }, 422));
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "failed", "must be failed");
    assertEquals(!res.sent ? res.error : "", "resend 422/validation_error");
    const patch = updates(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(patch.error, "resend 422/validation_error");
    assert(!String(patch.error).includes("lead@example.net"), "a recipient address leaked");
  } finally {
    teardown();
  }
});

// ── Never throws ───────────────────────────────────────────────────────────────────────────

Deno.test("never throws: fetch rejects outright → failed, row flipped, promise resolves", async () => {
  setup();
  try {
    stubFetch(() => {
      throw new TypeError("network unreachable");
    });
    const db = stubAdmin({ settings: VERIFIED });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "failed", "a network failure resolves, never rejects");
    assertEquals(!res.sent ? res.error : "", "resend 0/unknown");
    const patch = updates(db.calls)[0].payload as Record<string, unknown>;
    assertEquals(patch.status, "failed");
  } finally {
    teardown();
  }
});

Deno.test("never throws: the claim insert fails → failed, and the email is NOT sent", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED, insertError: { message: "permission denied" } });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "failed", "an unclaimable send must fail, not throw");
    assertEquals(fetches.length, 0,
      "ledger-first: no claim row means NO send — an untraceable email is the exact gap this closes");
    assertEquals(updates(db.calls).length, 0, "there is no row to update");
    assert(!res.sent && !String(res.error).includes("permission denied"),
      "the caller gets an authored sentence; the raw database message goes to app_errors");
  } finally {
    teardown();
  }
});

Deno.test("never throws: the insert THROWS mid-flight → failed, promise resolves", async () => {
  setup();
  try {
    const fetches = stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED, insertThrows: true });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(!res.sent && res.reason === "failed", "a throwing client resolves to failed");
    assertEquals(fetches.length, 0, "no claim row → no send");
  } finally {
    teardown();
  }
});

Deno.test("sent but the 'sent' update fails → STILL sent:true (a 'failed' would double-email)", async () => {
  setup();
  try {
    stubFetch(() => jsonResponse(OK_SEND));
    const db = stubAdmin({ settings: VERIFIED, updateError: { message: "connection reset" } });
    const res = await sendTenantEmail(db.admin, CLIENT_ID, MAIL);
    assert(res.sent, "the email really went out — reporting failure would push the caller onto "
      + "its GHL fallback and the customer would get the email twice");
    assertEquals(res.sent && res.messageId, "rs-msg-1");
  } finally {
    teardown();
  }
});
