import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  generateEmailOtp,
  hashEmailOtp,
  constantTimeEqual,
  normalizeEmail,
  isPlausibleEmail,
  issueEmailOtp,
  verifyEmailOtp,
  emailOtpBody,
  EMAIL_OTP_MAX_ATTEMPTS,
} from "./emailOtp.ts";

// These cover an AUTHENTICATION secret. The failures they guard against are the silent kind:
// a code that validates for the wrong tenant, a dead code burning the live code's attempt
// budget, a biased generator. None of those show up in manual testing.

Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key-for-hmac-only");

Deno.test("codes are six digits, zero-padded", () => {
  for (let i = 0; i < 200; i++) {
    const c = generateEmailOtp();
    assert(/^\d{6}$/.test(c), `bad code shape: ${c}`);
  }
});

Deno.test("codes are not obviously biased or repeating", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(generateEmailOtp());
  // 500 draws from a million-wide space should essentially never collide more than a little.
  assert(seen.size > 490, `too many duplicate codes: ${seen.size}/500 unique`);
});

Deno.test("the hash is bound to the TENANT — a code cannot cross tenants", async () => {
  const a = await hashEmailOtp("junior-barns", "pat@example.com", "123456");
  const b = await hashEmailOtp("yoder-barns", "pat@example.com", "123456");
  assertNotEquals(a, b, "same code on two tenants must not produce the same hash");
});

Deno.test("the hash is bound to the ADDRESS — a code cannot cross recipients", async () => {
  const a = await hashEmailOtp("junior-barns", "pat@example.com", "123456");
  const b = await hashEmailOtp("junior-barns", "chris@example.com", "123456");
  assertNotEquals(a, b, "same code for two people must not produce the same hash");
});

Deno.test("the hash is stable for the same inputs", async () => {
  const a = await hashEmailOtp("junior-barns", "pat@example.com", "123456");
  const b = await hashEmailOtp("junior-barns", "pat@example.com", "123456");
  assertEquals(a, b);
});

Deno.test("the stored hash is not the code, and not a bare digest of it", async () => {
  const h = await hashEmailOtp("junior-barns", "pat@example.com", "123456");
  assert(!h.includes("123456"), "the code must not survive into the hash");
  assertEquals(h.length, 64, "expected a hex SHA-256 HMAC");
});

Deno.test("constantTimeEqual matches only identical strings", () => {
  assert(constantTimeEqual("abc", "abc"));
  assert(!constantTimeEqual("abc", "abd"));
  assert(!constantTimeEqual("abc", "ab"));
  assert(!constantTimeEqual("", "a"));
  assert(constantTimeEqual("", ""));
});

Deno.test("email normalisation lower-cases and trims — and does NOTHING else", () => {
  assertEquals(normalizeEmail("  Pat@Example.COM "), "pat@example.com");
  // ⚠️ Dots and +tags are deliberately preserved: collapsing them is a Gmail convention,
  // wrong elsewhere, and would let one person's code be consumed by another.
  assertEquals(normalizeEmail("p.a.t+quotes@example.com"), "p.a.t+quotes@example.com");
});

Deno.test("plausible addresses pass and header-injection shapes do not", () => {
  for (const good of ["pat@example.com", "p.a.t+x@mail.example.co.uk", "a@b.co"]) {
    assert(isPlausibleEmail(good), `${good} should pass`);
  }
  for (const bad of [
    "", "pat", "pat@", "@example.com", "pat@example",
    "pat@example.com, evil@x.com",          // comma — a second recipient
    "pat@example.com\nBcc: evil@x.com",     // newline — header injection
    '"pat"@example.com',                    // quotes
    "pat <pat@example.com>",                // angle brackets
  ]) {
    assert(!isPlausibleEmail(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

Deno.test("a correct code verifies", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: 0, consumed_at: null,
  };
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", issued.code, row), { ok: true });
});

Deno.test("a wrong code is a mismatch, not an error", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: 0, consumed_at: null,
  };
  const wrong = issued.code === "000000" ? "111111" : "000000";
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", wrong, row), { ok: false, reason: "mismatch" });
});

Deno.test("a code issued for one tenant does NOT verify on another", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: 0, consumed_at: null,
  };
  const v = await verifyEmailOtp("yoder-barns", "pat@example.com", issued.code, row);
  assertEquals(v, { ok: false, reason: "mismatch" }, "cross-tenant replay must fail");
});

Deno.test("a code issued for one address does NOT verify for another", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: 0, consumed_at: null,
  };
  const v = await verifyEmailOtp("junior-barns", "chris@example.com", issued.code, row);
  assertEquals(v, { ok: false, reason: "mismatch" }, "cross-recipient replay must fail");
});

Deno.test("no stored code reports no_code, never a mismatch", async () => {
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", "123456", null),
    { ok: false, reason: "no_code" });
});

Deno.test("an EXPIRED code is refused before the comparison happens", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash,
    expires_at: new Date(Date.now() - 1000).toISOString(),
    attempts: 0, consumed_at: null,
  };
  // Even the RIGHT code must be refused, and specifically as expired — the caller uses that
  // to avoid charging a dead code against the fresh one's attempt budget.
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", issued.code, row),
    { ok: false, reason: "expired" });
});

Deno.test("a CONSUMED code cannot be replayed", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: 0, consumed_at: new Date().toISOString(),
  };
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", issued.code, row),
    { ok: false, reason: "consumed" });
});

Deno.test("attempts are capped, and the cap is checked before the comparison", async () => {
  const issued = await issueEmailOtp("junior-barns", "pat@example.com");
  const row = {
    code_hash: issued.codeHash, expires_at: issued.expiresAt.toISOString(),
    attempts: EMAIL_OTP_MAX_ATTEMPTS, consumed_at: null,
  };
  assertEquals(await verifyEmailOtp("junior-barns", "pat@example.com", issued.code, row),
    { ok: false, reason: "too_many_attempts" }, "a burnt-out code must not accept even the right value");
});

Deno.test("the email names the builder and carries the code, and survives a hostile brand", () => {
  const b = emailOtpBody("Junior Barns", "123456");
  assert(b.subject.includes("123456"));
  assert(b.text.includes("123456") && b.html.includes("123456"));
  assert(b.text.includes("Junior Barns"));
  // A tenant-controlled string lands in HTML — it must not be able to open a tag.
  const evil = emailOtpBody('<script>alert(1)</script>', "123456");
  assert(!evil.html.includes("<script"), "brand must not inject markup");
  // An empty brand degrades to something readable rather than a blank gap.
  assert(emailOtpBody("", "123456").text.includes("your builder"));
});
