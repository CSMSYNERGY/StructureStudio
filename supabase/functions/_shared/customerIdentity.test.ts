/**
 * Unit tests for customerIdentity — the ownership rule behind every customer read and write.
 *
 * WHY THESE EXIST. ownsDesign decides whether a verified customer can list, accept, sign or pay
 * a design. The failure that matters is silent and one-directional: a rule that resolves an email
 * to a phone (the 2026-08-30 email channel, switched off 2026-09-06) hands a stranger someone
 * else's quotes while every happy-path click still works. So the negative cases are the point.
 * The same goes for the shared-address rule (review, 2026-09-15): an address filed beside two
 * customers' phones must own neither of their designs by email.
 *
 * Run (from supabase/functions/_shared/):
 *   deno test --allow-env --node-modules-dir=none customerIdentity.test.ts
 * (preflight runs every _shared/*.test.ts with those flags)
 */

import {
  acceptanceIdentityColumns,
  ADDRESS_SCAN_PAGE,
  addressIsShared,
  addressStandingFrom,
  loadAddressStanding,
  matchedIdentities,
  ownsDesign,
  provenIdentityColumns,
} from "./customerIdentity.ts";

function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` + (msg ? ` — ${msg}` : ""));
  }
}

const PHONE_SESSION = { phoneDigits: "8163003600", emailLower: null };
const EMAIL_SESSION = { phoneDigits: null, emailLower: "pat@example.com" };
const BOTH_SESSION = { phoneDigits: "8163003600", emailLower: "pat@example.com" };
/** An address this tenant files beside at most one phone: the like-with-like cases below. */
const UNSHARED = addressStandingFrom(EMAIL_SESSION, []);

// ── phone ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("phone session owns a design with the same phone, however it is formatted", () => {
  for (const phone of ["8163003600", "(816) 300-3600", "+1 (816) 300-3600", "18163003600", "816.300.3600"]) {
    assertEquals(ownsDesign(PHONE_SESSION, { phone }, UNSHARED), true, phone);
  }
});

Deno.test("phone session does NOT own a design with a different phone", () => {
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "(816) 300-3601" }, UNSHARED), false);
  // An international number is never truncated into somebody else's.
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "448163003600" }, UNSHARED), false);
});

Deno.test("phone session does NOT own a design that matches only by email — it proved no email", () => {
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "5551234567", email: "pat@example.com" }, UNSHARED), false);
});

// ── email ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("email session owns a design with the same email, ignoring case and surrounding space", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "Pat@Example.COM" }, UNSHARED), true);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "  pat@example.com " }, UNSHARED), true);
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "5551234567", email: "pat@example.com" }, UNSHARED), true);
});

Deno.test("email session does NOT own a design with a different email — no +tag or dot folding", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "pat+quotes@example.com" }, UNSHARED), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "p.at@example.com" }, UNSHARED), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: "pat@example.co" }, UNSHARED), false);
});

Deno.test("NEVER email → phone: same phone, different email is NOT the email session's design", () => {
  // The attack the 09-06 shutdown closed. The customer's own design D1 pairs their verified
  // address with phone P. A stranger's (or victim's) design D2 carries the same phone P and a
  // different address. Resolving the email to P through D1 would hand D2 over.
  const d1 = { phone: "(816) 300-3600", email: "pat@example.com" };
  const d2 = { phone: "(816) 300-3600", email: "someone.else@example.com" };
  assertEquals(ownsDesign(EMAIL_SESSION, d1, UNSHARED), true);
  assertEquals(ownsDesign(EMAIL_SESSION, d2, UNSHARED), false, "a phone read off another design is not an identity");
  // …and the same with no address on D2 at all (a phone-only tenant — the case the old
  // contradiction rule could never catch).
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "(816) 300-3600" }, UNSHARED), false);
});

Deno.test("a non-string contact email never matches, even one that stringifies to the address", () => {
  assertEquals(ownsDesign(EMAIL_SESSION, { email: ["pat@example.com"] }, UNSHARED), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { email: { toString: () => "pat@example.com" } }, UNSHARED), false);
});

// ── the shared-address rule (review, 2026-09-15) ──────────────────────────────────────────────

const P = "(816) 300-3600";
const Q = "(913) 555-0142";

Deno.test("SHARED ADDRESS: an address filed beside two phones owns neither design by email", () => {
  // The office inbox typed onto two walk-in customers' designs. Whoever reads it must not see,
  // accept, sign or pay either order.
  const mine = { phone: P, email: "pat@example.com" };
  const theirs = { phone: Q, email: "Pat@Example.com " };
  const tenant = [{ status: "sent", contact: mine }, { status: "accepted", contact: theirs }];
  const standing = addressStandingFrom(EMAIL_SESSION, tenant);
  assertEquals(standing, { emailShared: true });
  assertEquals(ownsDesign(EMAIL_SESSION, mine, standing), false, "not even the design beside your own number");
  assertEquals(ownsDesign(EMAIL_SESSION, theirs, standing), false);
  // The phone half is untouched: a phone OTP proves the number the design names.
  assertEquals(ownsDesign(PHONE_SESSION, mine, standing), true, "phone login still works");
  // A session holding both keeps what its PHONE proves and nothing its shared address would add.
  const both = addressStandingFrom(BOTH_SESSION, tenant);
  assertEquals(ownsDesign(BOTH_SESSION, mine, both), true, "by phone");
  assertEquals(ownsDesign(BOTH_SESSION, theirs, both), false, "the other customer's design, by the shared address");
});

Deno.test("SHARED ADDRESS: one phone however formatted, blank or scrap phones, and phone-less designs are NOT sharing", () => {
  const rows = [
    { status: "sent", contact: { phone: "8163003600", email: "pat@example.com" } },
    { status: "sent", contact: { phone: "+1 (816) 300-3600", email: "PAT@example.com" } },
    { status: "sent", contact: { phone: "18163003600", email: " pat@example.com" } },
    { status: "draft", contact: { phone: "", email: "pat@example.com" } },
    { status: "draft", contact: { email: "pat@example.com" } },
    { status: "draft", contact: { phone: "555-0142", email: "pat@example.com" } }, // 7 digits: no counterpart
  ];
  assertEquals(addressIsShared("pat@example.com", rows), false);
  assertEquals(ownsDesign(EMAIL_SESSION, rows[3].contact, addressStandingFrom(EMAIL_SESSION, rows)), true);
});

Deno.test("SHARED ADDRESS: every status counts (drafts, the builder's stock); other addresses and non-string emails do not", () => {
  const base = { status: "sent", contact: { phone: P, email: "pat@example.com" } };
  assertEquals(addressIsShared("pat@example.com", [base, { status: "inventory", contact: { phone: Q, email: "pat@example.com" } }]), true, "stock");
  assertEquals(addressIsShared("pat@example.com", [base, { status: "draft", contact: { phone: Q, email: "pat@example.com" } }]), true, "draft");
  assertEquals(addressIsShared("pat@example.com", [base, { status: "sent", contact: { phone: Q, email: "pat+2@example.com" } }]), false, "another address");
  assertEquals(addressIsShared("pat@example.com", [base, { status: "sent", contact: { phone: Q, email: ["pat@example.com"] } }]), false, "array email");
  for (const junk of [null, undefined, "x", 1, [], {}, { contact: null }, { contact: [] }, { contact: "pat@example.com" }]) {
    assertEquals(addressIsShared("pat@example.com", [base, junk]), false, JSON.stringify(junk));
  }
  assertEquals(addressStandingFrom(PHONE_SESSION, [base, { status: "sent", contact: { phone: Q, email: "pat@example.com" } }]),
    { emailShared: false }, "a session with no address has no email half to withhold");
});

// ── loadAddressStanding: the read behind every production call ───────────────────────────────

type Row = { client_id: string; status: string; contact: unknown };

/** Just the chain loadAddressStanding makes: from().select().eq().order().range(). */
function fakeAdmin(rows: Row[], failOnRead = 0) {
  const reads: { table: string; clientId: unknown; from: number; to: number }[] = [];
  return {
    reads,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let orderCol = "";
      const q = {
        select: (_cols: string) => q,
        eq: (col: string, val: unknown) => { filters[col] = val; return q; },
        order: (col: string) => { orderCol = col; return q; },
        range: (from: number, to: number) => {
          reads.push({ table, clientId: filters.client_id, from, to });
          if (reads.length === failOnRead) return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
          if (orderCol !== "short_code") throw new Error("paging must be on a unique, stable order");
          const tenant = rows.filter((r) => r.client_id === filters.client_id);
          return Promise.resolve({ data: tenant.slice(from, to + 1), error: null });
        },
      };
      return q;
    },
  };
}

function tenantRows(n: number, clientId = "t1"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    client_id: clientId,
    status: "sent",
    contact: { phone: `816555${String(i).padStart(4, "0")}`, email: `buyer${i}@example.com` },
  }));
}

Deno.test("loadAddressStanding: a phone-only session reads nothing", async () => {
  const admin = fakeAdmin(tenantRows(3));
  assertEquals(await loadAddressStanding(admin, "t1", PHONE_SESSION), { standing: { emailShared: false }, error: null });
  assertEquals(await loadAddressStanding(admin, "t1", null), { standing: { emailShared: false }, error: null });
  assertEquals(admin.reads.length, 0);
});

Deno.test("loadAddressStanding: finds the sharing design on a LATER page — an unpaged read would have stopped short", async () => {
  const rows = tenantRows(ADDRESS_SCAN_PAGE + 20);
  rows[3].contact = { phone: P, email: "pat@example.com" };
  rows[ADDRESS_SCAN_PAGE + 10].contact = { phone: Q, email: "pat@example.com" };
  const admin = fakeAdmin(rows);
  const res = await loadAddressStanding(admin, "t1", EMAIL_SESSION);
  assertEquals(res, { standing: { emailShared: true }, error: null });
  assertEquals(admin.reads.map((r) => [r.table, r.clientId, r.from, r.to]),
    [["designs", "t1", 0, ADDRESS_SCAN_PAGE - 1], ["designs", "t1", ADDRESS_SCAN_PAGE, 2 * ADDRESS_SCAN_PAGE - 1]]);
});

Deno.test("loadAddressStanding: stops at a short page, reads one empty page after an exact multiple, and never counts another builder's designs", async () => {
  const rows = tenantRows(ADDRESS_SCAN_PAGE);
  rows[0].contact = { phone: P, email: "pat@example.com" };
  // The same address beside another number, at ANOTHER builder: not this tenant's evidence.
  rows.push({ client_id: "t2", status: "sent", contact: { phone: Q, email: "pat@example.com" } });
  const admin = fakeAdmin(rows);
  assertEquals(await loadAddressStanding(admin, "t1", EMAIL_SESSION), { standing: { emailShared: false }, error: null });
  assertEquals(admin.reads.length, 2, "a full page, then the empty page that proves the end");

  const small = fakeAdmin(tenantRows(7));
  await loadAddressStanding(small, "t1", BOTH_SESSION);
  assertEquals(small.reads.length, 1);
});

Deno.test("loadAddressStanding: a failed read is an error, NEVER an unshared standing", async () => {
  const rows = tenantRows(ADDRESS_SCAN_PAGE + 5);
  const first = await loadAddressStanding(fakeAdmin(rows, 1), "t1", EMAIL_SESSION);
  assertEquals(first.standing, null);
  assertEquals((first.error as { code?: string })?.code, "57014");
  const second = await loadAddressStanding(fakeAdmin(rows, 2), "t1", EMAIL_SESSION);
  assertEquals(second.standing, null, "a failure on page two after a clean page one");
});

// ── both ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("a session holding both identities owns a design matching either", () => {
  assertEquals(ownsDesign(BOTH_SESSION, { phone: "8163003600" }, UNSHARED), true, "by phone");
  assertEquals(ownsDesign(BOTH_SESSION, { email: "pat@example.com" }, UNSHARED), true, "by email");
  assertEquals(ownsDesign(BOTH_SESSION, { phone: "5551234567", email: "other@example.com" }, UNSHARED), false, "neither");
});

// ── garbage ───────────────────────────────────────────────────────────────────────────────────

Deno.test("null / missing / malformed contacts are never owned", () => {
  for (const contact of [null, undefined, "", "8163003600", 8163003600, [], ["8163003600"], {}]) {
    assertEquals(ownsDesign(BOTH_SESSION, contact, UNSHARED), false, JSON.stringify(contact));
  }
});

Deno.test("blank never matches blank: an identity with nothing proven owns nothing", () => {
  const nobody = { phoneDigits: null, emailLower: null };
  assertEquals(ownsDesign(nobody, { phone: "", email: "" }, UNSHARED), false);
  assertEquals(ownsDesign(nobody, {}, UNSHARED), false);
  assertEquals(ownsDesign({ phoneDigits: "", emailLower: "" }, { phone: "", email: "" }, UNSHARED), false);
  assertEquals(ownsDesign(PHONE_SESSION, { phone: "", email: "" }, UNSHARED), false);
  assertEquals(ownsDesign(EMAIL_SESSION, { phone: "", email: "" }, UNSHARED), false);
  assertEquals(ownsDesign(null, { phone: "8163003600" }, UNSHARED), false);
});

// ── acceptance evidence ───────────────────────────────────────────────────────────────────────

Deno.test("acceptance rows record both identity columns, null where not proven", () => {
  assertEquals(acceptanceIdentityColumns(PHONE_SESSION), { phone_digits: "8163003600", email_lower: null });
  assertEquals(acceptanceIdentityColumns(EMAIL_SESSION), { phone_digits: null, email_lower: "pat@example.com" });
  assertEquals(acceptanceIdentityColumns(BOTH_SESSION), { phone_digits: "8163003600", email_lower: "pat@example.com" });
  assertEquals(acceptanceIdentityColumns({ phoneDigits: "", emailLower: "" }), { phone_digits: null, email_lower: null });
});

// ── saved-design links (migration 231) ────────────────────────────────────────────────────────

Deno.test("provenIdentityColumns: each proven identity, normalised as ownsDesign compares it; blanks absent", () => {
  assertEquals(provenIdentityColumns(BOTH_SESSION), [
    { column: "phone_digits", value: "8163003600" },
    { column: "email_lower", value: "pat@example.com" },
  ]);
  assertEquals(provenIdentityColumns({ phoneDigits: "18163003600", emailLower: "  Pat@Example.com " }), [
    { column: "phone_digits", value: "8163003600" },
    { column: "email_lower", value: "pat@example.com" },
  ]);
  assertEquals(provenIdentityColumns(EMAIL_SESSION), [{ column: "email_lower", value: "pat@example.com" }]);
  assertEquals(provenIdentityColumns({ phoneDigits: "", emailLower: "" }), []);
  assertEquals(provenIdentityColumns(null), []);
});

Deno.test("matchedIdentities: only the halves the contact NAMES — a two-identity session saving a phone-only design is not saving it under the email", () => {
  assertEquals(matchedIdentities(BOTH_SESSION, { phone: "(816) 300-3600", email: "other@example.com" }),
    [{ column: "phone_digits", value: "8163003600" }]);
  assertEquals(matchedIdentities(BOTH_SESSION, { phone: "5551234567", email: "PAT@example.com" }),
    [{ column: "email_lower", value: "pat@example.com" }]);
  assertEquals(matchedIdentities(BOTH_SESSION, { phone: "8163003600", email: "pat@example.com" }).length, 2);
  // The same negatives as ownsDesign, because ownsDesign IS this, non-empty.
  assertEquals(matchedIdentities(EMAIL_SESSION, { phone: "(816) 300-3600" }), [], "never email → phone");
  assertEquals(matchedIdentities(EMAIL_SESSION, { email: ["pat@example.com"] }), [], "non-string email");
  for (const contact of [null, undefined, "8163003600", [], {}]) {
    assertEquals(matchedIdentities(BOTH_SESSION, contact), [], JSON.stringify(contact));
  }
});
