// Tests for the inbound-email parsing helpers.
//
// Dependency-free (no jsr:/npm: imports) so the suite still runs on a machine with no
// registry access — the same rule the other _shared tests follow.
//
// These four functions decide whether a customer's reply reaches the right record, reaches
// the WRONG record, or is silently mangled. None of that surfaces as an error: a bad
// address parse just means the message quietly fails to match, and an over-eager quote
// stripper just means the customer's sentence disappears. That is exactly the class of
// failure worth pinning.

import { timingSafeEqual, parseAddress, messageIds, stripQuoted, parseReplyToken } from "./emailInbound.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

Deno.test("timingSafeEqual matches only on equal strings", () => {
  assert(timingSafeEqual("abc123", "abc123"), "identical must match");
  assert(!timingSafeEqual("abc123", "abc124"), "one char differs");
  assert(!timingSafeEqual("abc", "abcd"), "different lengths");
  assert(!timingSafeEqual("", "x"), "empty vs non-empty");
  // The unset-secret case is guarded by the caller (`!secret` refuses first), but an empty
  // match here would make that guard the only thing standing between the world and an open
  // write path, so pin it.
  assert(timingSafeEqual("", ""), "two empties are equal — the CALLER must refuse, not this");
});

Deno.test("parseAddress handles every shape a provider sends", () => {
  assertEquals(parseAddress('"Jane Yoder" <Jane@Example.com>'), { email: "jane@example.com", name: "Jane Yoder" });
  assertEquals(parseAddress("Jane Yoder <jane@example.com>"), { email: "jane@example.com", name: "Jane Yoder" });
  assertEquals(parseAddress("jane@example.com"), { email: "jane@example.com", name: null });
  assertEquals(parseAddress("  JANE@EXAMPLE.COM  "), { email: "jane@example.com", name: null });
  // Object form — Resend and others send this rather than a header string.
  assertEquals(parseAddress({ email: "Jane@Example.com", name: "Jane" }), { email: "jane@example.com", name: "Jane" });
  assertEquals(parseAddress({ address: "jane@example.com" }), { email: "jane@example.com", name: null });
  // Lowercasing is not cosmetic: crm_contacts matches on email_lower, so a capitalised
  // sender would silently fail to thread.
  assertEquals(parseAddress("<Bob@Barns.COM>").email, "bob@barns.com");
});

Deno.test("messageIds pulls every id out of a References chain, angle brackets stripped", () => {
  assertEquals(messageIds("<a@x.com>"), ["a@x.com"]);
  assertEquals(messageIds("<a@x.com> <b@x.com>\n <c@x.com>"), ["a@x.com", "b@x.com", "c@x.com"]);
  assertEquals(messageIds(""), []);
  assertEquals(messageIds(null), []);
  assertEquals(messageIds(undefined), []);
  // Capped, so a pathological References header cannot build a giant IN () clause.
  assert(messageIds(Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(" ")).length === 10, "capped at 10");
});

Deno.test("stripQuoted removes the reply history but never the reply", () => {
  const gmail = "Yes please, the 12x24.\n\nOn Mon, 25 Aug 2026 at 09:14, Jane <j@x.com> wrote:\n> Here is your quote\n> Thanks";
  assertEquals(stripQuoted(gmail), "Yes please, the 12x24.");

  const outlook = "Sounds good.\n\n-----Original Message-----\nFrom: Jane\nSent: Monday";
  assertEquals(stripQuoted(outlook), "Sounds good.");

  const plainQuote = "Confirmed.\n\n> your quote is attached";
  assertEquals(stripQuoted(plainQuote), "Confirmed.");

  // CRLF is what actually arrives over the wire; a stripper that only knows \n silently
  // does nothing on real mail.
  assertEquals(stripQuoted("Great.\r\n\r\n> quoted"), "Great.");
});

Deno.test("stripQuoted keeps the whole body when it cannot find a boundary", () => {
  // THE IMPORTANT ONE. Losing a customer's sentence to an over-eager regex is worse than
  // showing them some quoted text, so anything unrecognised must survive intact.
  const plain = "Can you do it in barn red instead? Also what is the lead time?";
  assertEquals(stripQuoted(plain), plain);
  assertEquals(stripQuoted(""), "");
  // A reply that is ONLY quoted text still returns something rather than an empty string —
  // an empty body in the feed reads as a bug, not as an empty message.
  assert(stripQuoted("> only quoted text").length > 0, "never returns empty when there was content");
});

Deno.test("parseReplyToken routes a reply from the address it was sent to", () => {
  // THE PRIMARY ROUTING SIGNAL. Stronger than In-Reply-To because the address is the one
  // thing that always survives a round trip — it is what the customer's client puts in To.
  assertEquals(parseReplyToken("d.ss-9r8uhjgtdj@reply.jrbarns.com"),
    { kind: "design", id: "SS-9R8UHJGTDJ" });
  assertEquals(parseReplyToken("c.847ff3f8-2004-4d81-b87e-01140887cefe@reply.jrbarns.com"),
    { kind: "contact", id: "847ff3f8-2004-4d81-b87e-01140887cefe" });
  // Case-insensitive: a client may echo the address in any case.
  assertEquals(parseReplyToken("D.SS-9R8UHJGTDJ@Reply.JrBarns.com")!.id, "SS-9R8UHJGTDJ");
});

Deno.test("parseReplyToken refuses anything that is not our token", () => {
  // A stranger mailing the inbound domain must NOT be routed onto someone's record. Every
  // one of these has to return null so the webhook falls through to header/sender matching
  // and, failing that, stores the row unmatched rather than filing it wrongly.
  for (const bad of [
    "info@jrbarns.com",            // a normal address on the same domain
    "d.@reply.jrbarns.com",        // empty id
    "x.SS-123@reply.jrbarns.com",  // unknown prefix
    "dSS-123@reply.jrbarns.com",   // missing separator
    "d.SS 123@reply.jrbarns.com",  // space in the id
    "", null, undefined,
  ]) {
    assertEquals(parseReplyToken(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});
