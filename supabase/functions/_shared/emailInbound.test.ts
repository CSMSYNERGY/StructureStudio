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

import {
  timingSafeEqual, parseAddress, messageIds, stripQuoted, parseReplyToken,
  envelopeRecipients, buildThreadMessageId, parseThreadMessageId, buildReplyAddress,
} from "./emailInbound.ts";

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

  // ⚠️ THE INLINE REPLY. Gmail and Apple Mail both encourage answering inside the quote, so
  // the customer's own words sit BELOW quoted lines. Cutting at the first `>` kept only the
  // preamble: the builder read "Yes, let's go ahead." and never saw the door change or the
  // deadline, with nothing in the feed to say anything had been removed.
  const inline = "Yes, let's go ahead.\n\nOn Mon, 25 Aug 2026 at 09:14, Jane <j@x.com> wrote:\n" +
    "> Here is your quote\n> Door: 4ft\n\nBut change the door to the 6ft, and I need it by the 12th.";
  assertEquals(stripQuoted(inline),
    "Yes, let's go ahead.\n\nBut change the door to the 6ft, and I need it by the 12th.");

  // Point-by-point is the same shape one level finer — every answer is a line between two
  // quoted ones, so a stripper that truncates keeps nothing but the greeting.
  assertEquals(stripQuoted("Answers inline:\n\n> What colour?\nBarn red.\n> What date?\nThe 12th."),
    "Answers inline:\n\nBarn red.\nThe 12th.");
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

Deno.test("buildReplyAddress round-trips with parseReplyToken", () => {
  // The two must agree exactly, or a reply we asked for cannot be read back.
  const a = buildReplyAddress("reply.jrbarns.com", "active", { shortCode: "SS-9R8UHJGTDJ" });
  assertEquals(a, "d.ss-9r8uhjgtdj@reply.jrbarns.com");
  assertEquals(parseReplyToken(a), { kind: "design", id: "SS-9R8UHJGTDJ" });

  const cid = "847ff3f8-2004-4d81-b87e-01140887cefe";
  const c = buildReplyAddress("reply.jrbarns.com", "active", { contactId: cid });
  assertEquals(c, `c.${cid}@reply.jrbarns.com`);
  assertEquals(parseReplyToken(c), { kind: "contact", id: cid });

  // A design wins: it is the more specific fact, and it is what the customer is replying about.
  assertEquals(buildReplyAddress("reply.x.com", "active", { shortCode: "SS-1", contactId: cid }),
    "d.ss-1@reply.x.com");
});

Deno.test("buildReplyAddress refuses anything but a genuinely active domain", () => {
  // ⚠️ THE ONE THAT MATTERS. 'pending' means the tenant typed a domain but never proved MX
  // control. Returning an address here points Reply-To at dead MX, so the customer's reply
  // bounces back to the CUSTOMER and the builder never learns they tried — strictly worse
  // than the staff-inbox fallback that null selects.
  assertEquals(buildReplyAddress("reply.x.com", "pending", { shortCode: "SS-1" }), null);
  assertEquals(buildReplyAddress("reply.x.com", "off", { shortCode: "SS-1" }), null);
  assertEquals(buildReplyAddress("reply.x.com", null, { shortCode: "SS-1" }), null);
  assertEquals(buildReplyAddress("reply.x.com", undefined, { shortCode: "SS-1" }), null);
  // No domain configured at all — every tenant is in this state today.
  assertEquals(buildReplyAddress(null, "active", { shortCode: "SS-1" }), null);
  assertEquals(buildReplyAddress("", "active", { shortCode: "SS-1" }), null);
  assertEquals(buildReplyAddress("notadomain", "active", { shortCode: "SS-1" }), null);
  // Nothing to reference: a `test` send has neither. Guarded rather than templated, or this
  // renders the literal address `c.null@reply.x.com` and mail bounces off a real domain.
  assertEquals(buildReplyAddress("reply.x.com", "active", {}), null);
  assertEquals(buildReplyAddress("reply.x.com", "active", { shortCode: null, contactId: null }), null);
});

Deno.test("envelopeRecipients reads the envelope for every provider shape", () => {
  // Resend: received_for, the address the message was received FOR (the caller passes the
  // unwrapped `data` as `m`). Its `to` is NOT read — see the header test below.
  assertEquals(envelopeRecipients({}, { received_for: ["D.SS-9R8UHJGTDJ@Reply.JrBarns.com"] }),
    ["d.ss-9r8uhjgtdj@reply.jrbarns.com"]);
  // Mailgun: `recipient`.
  assertEquals(envelopeRecipients({}, { recipient: "c.abc@reply.jrbarns.com" }),
    ["c.abc@reply.jrbarns.com"]);
  // SendGrid: `envelope` is a JSON STRING, not an object. Parsing it as an object silently
  // yields nothing, which would drop every SendGrid message on the floor.
  assertEquals(envelopeRecipients({}, { envelope: '{"to":["a@reply.x.com"],"from":"b@y.com"}' }),
    ["a@reply.x.com"]);
  // SES: the envelope rides the SNS receipt, OUTSIDE the mail object.
  assertEquals(envelopeRecipients({ receipt: { recipients: ["a@reply.x.com"] } }, {}),
    ["a@reply.x.com"]);
  // CloudMailin: envelope as an object.
  assertEquals(envelopeRecipients({}, { envelope: { to: "a@reply.x.com" } }), ["a@reply.x.com"]);
  // Forwarded mail: received_for holds the address it was originally for while `to` holds the
  // forwarding mailbox — one more reason `to` is evidence of nothing. Only the envelope side
  // comes back.
  assertEquals(
    envelopeRecipients({}, { received_for: ["d.ss-1@reply.x.com"], to: ["fwd@elsewhere.com"] }),
    ["d.ss-1@reply.x.com"],
  );
});

Deno.test("envelopeRecipients NEVER reads the To: header", () => {
  // THE SECURITY TEST. The header is written by whoever composed the message; the short code
  // is in every quote URL and those links get forwarded. If a forged `To:` could pick the
  // tenant, anyone who has seen a quote could post onto that builder's conversation feed.
  assertEquals(envelopeRecipients({}, { To: "d.ss-9r8uhjgtdj@reply.jrbarns.com" }), []);
  assertEquals(envelopeRecipients({ To: "d.ss-1@reply.x.com" }, {}), []);
  // ⛔ AND THE LOWERCASE SPELLING, which is the one that actually shipped. The boundary
  // cannot be a case distinction in a JSON key — no provider guarantees that, and SendGrid
  // documents its `to` as taken from the headers — so a payload carrying only `to` must
  // select NO tenant rather than the one the sender typed.
  assertEquals(envelopeRecipients({}, { to: "d.ss-9r8uhjgtdj@reply.jrbarns.com" }), []);
  assertEquals(envelopeRecipients({}, { to: ["d.ss-victim@reply.yoderbarns.com"] }), []);
  assertEquals(envelopeRecipients({ to: ["d.ss-1@reply.x.com"] }, {}), []);
  // A forged header alongside a real envelope must not even add a candidate: the attack is
  // one message with RCPT TO the sender's own builder and `To:` naming another builder's
  // reply domain, and only the envelope may come back.
  assertEquals(
    envelopeRecipients({}, {
      recipient: "d.ss-mine@reply.jrbarns.com",
      to: ["d.ss-victim@reply.yoderbarns.com"],
    }),
    ["d.ss-mine@reply.jrbarns.com"],
  );
  // Present-but-useless envelopes must yield nothing rather than falling back to a header.
  assertEquals(envelopeRecipients({}, { envelope: "not json at all", To: "a@b.com" }), []);
  assertEquals(envelopeRecipients({}, {}), []);
  // A value with no @ is not an address.
  assertEquals(envelopeRecipients({}, { recipient: "not-an-address" }), []);
});

Deno.test("thread Message-ID round-trips, and encodes what a reply belongs to", () => {
  const id = buildThreadMessageId("junior-barns", "jrbarns.com",
    { shortCode: "SS-9R8UHJGTDJ" }, "k3f9x2");
  assertEquals(id, "<ss.junior-barns.d.ss-9r8uhjgtdj.k3f9x2@jrbarns.com>");
  assertEquals(parseThreadMessageId(id),
    { clientId: "junior-barns", kind: "design", id: "SS-9R8UHJGTDJ" });

  // A contact id is a uuid and is ALREADY lowercase — upper-casing it the way a short code
  // is upper-cased would produce an id that matches no row.
  const cid = "847ff3f8-2004-4d81-b87e-01140887cefe";
  const c = buildThreadMessageId("junior-barns", "jrbarns.com", { contactId: cid }, "aa11");
  assertEquals(parseThreadMessageId(c), { clientId: "junior-barns", kind: "contact", id: cid });

  // A design wins when both are present: it is the more specific fact.
  assertEquals(
    parseThreadMessageId(buildThreadMessageId("t", "x.com",
      { shortCode: "SS-1", contactId: cid }, "b2")!)!.kind, "design");

  // messageIds() strips the angle brackets before we ever see the value, so parsing must
  // work on the bare form too — this is the shape the webhook actually passes in.
  assertEquals(parseThreadMessageId("ss.junior-barns.d.ss-9r8uhjgtdj.k3f9x2@jrbarns.com")!.id,
    "SS-9R8UHJGTDJ");
});

Deno.test("thread Message-ID refuses to emit or trust a malformed id", () => {
  // Dots are the field separator, so a dot in any field would silently re-slice the id into
  // the wrong fields. Refusing to build one is safer than emitting an ambiguous header.
  assertEquals(buildThreadMessageId("has.dot", "x.com", { shortCode: "SS-1" }), null);
  assertEquals(buildThreadMessageId("t", "x.com", { shortCode: "has.dot" }), null);
  // Nothing to reference, nothing to build — a send with no design and no contact is fine,
  // it just gets no threading id.
  assertEquals(buildThreadMessageId("t", "x.com", {}), null);
  assertEquals(buildThreadMessageId("", "x.com", { shortCode: "SS-1" }), null);
  assertEquals(buildThreadMessageId("t", "", { shortCode: "SS-1" }), null);

  for (const bad of [
    "<a@x.com>",                                  // an ordinary Message-ID
    "rs-msg-1",                                   // the provider API id — the old dead join
    "<ss.tenant.x.ss-1.k3@x.com>",                // unknown kind
    "<ss.tenant.d.ss-1@x.com>",                   // missing the random part
    "<ss.tenant.d..k3@x.com>",                    // empty id
    "", null, undefined,
  ]) {
    assertEquals(parseThreadMessageId(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});
