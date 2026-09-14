/**
 * Unit tests for customerIdentity — the ownership rule behind every customer read and write.
 *
 * WHY THESE EXIST. ownsDesign decides whether a verified customer can list, accept, sign or pay
 * a design. The failure that matters is silent and one-directional: a rule that resolves an email
 * to a phone (the 2026-08-30 email channel, switched off 2026-09-06) hands a stranger someone
 * else's quotes while every happy-path click still works. So the negative cases are the point.
 *
 * Run (from supabase/functions/_shared/):
 *   deno test --allow-env --node-modules-dir=none customerIdentity.test.ts
 * (preflight runs every _shared/*.test.ts with those flags)
 */

import { acceptanceIdentityColumns, ownsDesign } from "./customerIdentity.ts";

function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` + (msg ? ` — ${msg}` : ""));
  }
}

const PHONE_SESSION = { phoneDigits: "8163003600", emailLower: null };
const EMAIL_SESSION = { phoneDigits: null, emailLower: "pat@example.com" };
const BOTH_SESSION = { phoneDigits: "8163003600", emailLower: "pat@example.com" };

// ── phone ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("phone session owns a design with the same phone, however it is formatted", () => {
  for (const phone of ["8163003600", "(816) 300-3600", "+1 (816) 300-3600", "18163003600", "816.300.3600"]) {
    assertEquals(ownsDesign(PHONE_SESSION, { phone }), true, phone);
  }
});

Deno.test("phone session does NOT own a design with a different phone", () => {
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "(816) 300-3601" }), false);
  // An international number is never truncated into somebody else's.
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "448163003600" }), false);
});

Deno.test("phone session does NOT own a design that matches only by email — it proved no email", () => {
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "5551234567", email: "pat@example.com" }), false);
});

// ── email ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("email session owns a design with the same email, ignoring case and surrounding space", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "Pat@Example.COM" }), true);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "  pat@example.com " }), true);
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "5551234567", email: "pat@example.com" }), true);
});

Deno.test("email session does NOT own a design with a different email — no +tag or dot folding", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "pat+quotes@example.com" }), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "p.at@example.com" }), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "pat@example.co" }), false);
});

Deno.test("NEVER email → phone: same phone, different email is NOT the email session's design", () => {
  // The attack the 09-06 shutdown closed. The customer's own design D1 pairs their verified
  // address with phone P. A stranger's (or victim's) design D2 carries the same phone P and a
  // different address. Resolving the email to P through D1 would hand D2 over.
  const d1 = { phone: "(816) 300-3600", email: "pat@example.com" };
  const d2 = { phone: "(816) 300-3600", email: "someone.else@example.com" };
  assertEquals(ownsDesign(EMAIL_SESSION, d1), true);
  assertEquals(ownsDesign(EMAIL_SESSION, d2), false, "a phone read off another design is not an identity");
  // …and the same with no address on D2 at all (a phone-only tenant — the case the old
  // contradiction rule could never catch).
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "(816) 300-3600" }), false);
});

Deno.test("a non-string contact email never matches, even one that stringifies to the address", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: ["pat@example.com"] }), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: { toString: () => "pat@example.com" } }), false);
});

// ── both ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("a session holding both identities owns a design matching either", () => {
  assertEquals(ownsDesign(BOTH_SESSION, { phone: "8163003600" }), true, "by phone");
  assertEquals(ownsDesign(BOTH_SESSION, { email: "pat@example.com" }), true, "by email");
  assertEquals(ownsDesign(BOTH_SESSION, { phone: "5551234567", email: "other@example.com" }), false, "neither");
});

// ── garbage ───────────────────────────────────────────────────────────────────────────────────

Deno.test("null / missing / malformed contacts are never owned", () => {
  for (const contact of [null, undefined, "", "8163003600", 8163003600, [], ["8163003600"], {}]) {
    assertEquals(ownsDesign(BOTH_SESSION, contact), false, JSON.stringify(contact));
  }
});

Deno.test("blank never matches blank: an identity with nothing proven owns nothing", () => {
  const nobody = { phoneDigits: null, emailLower: null };
  assertEquals(ownsDesign(nobody, { phone: "", email: "" }), false);
  assertEquals(ownsDesign(nobody, {}), false);
  assertEquals(ownsDesign({ phoneDigits: "", emailLower: "" }, { phone: "", email: "" }), false);
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "", email: "" }), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "", email: "" }), false);
  assertEquals(ownsDesign(null, { phone: "8163003600" }), false);
});

// ── acceptance evidence ───────────────────────────────────────────────────────────────────────

Deno.test("acceptance rows record both identity columns, null where not proven", () => {
  assertEquals(acceptanceIdentityColumns(PHONE_SESSION), { phone_digits: "8163003600", email_lower: null });
  assertEquals(acceptanceIdentityColumns(EMAIL_SESSION), { phone_digits: null, email_lower: "pat@example.com" });
  assertEquals(acceptanceIdentityColumns(BOTH_SESSION), { phone_digits: "8163003600", email_lower: "pat@example.com" });
  assertEquals(acceptanceIdentityColumns({ phoneDigits: "", emailLower: "" }), { phone_digits: null, email_lower: null });
});
