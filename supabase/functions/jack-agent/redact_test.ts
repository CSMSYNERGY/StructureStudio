import { assert, assertEquals } from "./test_assert.ts";
import { leaksContactDetails, nameIsContactDetail, pick, safeName, scrub } from "./redact.ts";

Deno.test("phone numbers in the usual shapes are blanked", () => {
  for (const n of ["(816) 555-0100", "816-555-0100", "816.555.0100", "+1 816 555 0100", "8165550100", "555-0100 x"]) {
    const out = scrub(`call me at ${n} today`);
    assert(!/\d{3}.?\d{4}/.test(out.replace("[phone]", "")), `${n} -> ${out}`);
    assert(out.includes("[phone]"), `${n} -> ${out}`);
  }
});

Deno.test("emails and street lines are blanked; the town stays", () => {
  const out = scrub("Email dale.r+barns@example.com or come to 1234 N Main St, Sedalia MO. PO Box 445 works too.");
  assert(!out.includes("@"), out);
  assert(out.includes("[email]"));
  assert(out.includes("[address]"));
  assert(!out.includes("1234 N Main"), out);
  assert(!out.includes("Box 445"), out);
  assert(out.includes("Sedalia"));
});

Deno.test("dates, money, sizes and ids survive", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const out = scrub(`Quote Q-1043 for $12,450 on 2026-11-06 and 11/20/2026, a 12x24 barn, card ${id}`);
  assert(out.includes("$12,450"));
  assert(out.includes("2026-11-06"));
  assert(out.includes("11/20/2026"));
  assert(out.includes("12x24"));
  assert(out.includes(id));
  assert(!out.includes("[phone]"), out);
});

Deno.test("a name that is really an address or a number is dropped", () => {
  assert(nameIsContactDetail("dale@example.com"));
  assert(nameIsContactDetail("(816) 555-0100"));
  assert(nameIsContactDetail(""));
  assert(!nameIsContactDetail("Dale Rhodes"));
  assertEquals(safeName("dale@example.com"), null);
  assertEquals(safeName("Dale Rhodes"), "Dale Rhodes");
});

Deno.test("pick copies only the named fields, scrubbed", () => {
  const row = { first_name: "Dale", phone: "816-555-0100", email: "d@x.com", notes: "call 816 555 0100" };
  const out = pick(row, ["first_name", "notes"]);
  assertEquals(Object.keys(out), ["first_name", "notes"]);
  assertEquals(out.notes, "call [phone]");
});

Deno.test("the last net sees what slipped through, and nothing else", () => {
  assert(leaksContactDetails(JSON.stringify({ name: "Dale", phone: "8165550100" })));
  assert(leaksContactDetails("write to dale@example.com"));
  assert(!leaksContactDetails(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", at: "2026-11-06T10:00:00Z", total: "$12,450", days: 14 })));
});

Deno.test("a phone right before a street line is blanked whole, not cut at the street's number", () => {
  const out = scrub("Call 816-555-0199 at 1234 N Main St");
  assert(!/816|555/.test(out), out);
  assert(out.includes("[phone]") && out.includes("[address]"), out);
  assert(!leaksContactDetails(out), out);
});

Deno.test("a street line whose house number ran into a phone still goes", () => {
  for (const s of ["Call 816 555 0199 1234 Main St", "816-555-0199. 1234 N Main St, Sedalia", "ph 555 0100 12 Elm St", "816-555-0199 - 22 County Road 12"]) {
    const out = scrub(s);
    assert(!/Main St|Elm St|County Road|555/.test(out), `${s} -> ${out}`);
    assert(!leaksContactDetails(out), out);
  }
  assert(scrub("Call 816 555 0199 1234 Main St").includes("[address]"));
  // Prose and money still survive.
  assertEquals(scrub("The 12x24 barn is $8,450, ready Friday."), "The 12x24 barn is $8,450, ready Friday.");
});

Deno.test("an email spelled out to get past a filter is blanked, and so is a name that is one", () => {
  for (const said of [
    "dale at gmail dot com", "Dale AT Gmail DOT com", "dale (at) gmail (dot) com", "dale[at]gmail[dot]com", "dale {at} gmail {dot} com",
    "dale @ gmail . com", "dale @ gmail.com", "dale@gmail dot com", "dale at gmail.com", "dale.r+barns at example dot co dot uk", "dale at gmail",
  ]) {
    const out = scrub(`Write me: ${said} thanks`);
    assertEquals(out, "Write me: [email] thanks", said);
    assert(leaksContactDetails(`{"words":"${said}"}`), `the last net misses ${said}`);
    assert(nameIsContactDetail(said), said);
    assertEquals(safeName(said), null, said);
  }
  // Prose with "at" and a full stop stays as it is.
  for (const prose of ["I'm at home. Me and Dale can meet Friday.", "Drop it at the lot. Thanks", "Priced at 4.50 a foot", "2 @ $500 each", "12x24 @ 8450.00 delivered", "We're at Sedalia, MO"]) {
    assertEquals(scrub(prose), prose, prose);
    assert(!leaksContactDetails(prose), prose);
  }
});

Deno.test("a house number with no street word is blanked; sizes, years, money and order numbers stay", () => {
  for (const [said, want] of [
    ["1234 Main", "[address]"],
    ["Come out to 1234 Main, Sedalia", "Come out to [address], Sedalia"],
    ["I'm at 1234 Oak", "I'm at [address]"],
    ["we live at 1234 Oak Ridge, Warsaw", "we live at [address], Warsaw"],
    ["deliver to 88 N Cedar, Sedalia", "deliver to [address], Sedalia"],
    ["Address: 2210 Hollister, Sedalia", "Address: [address], Sedalia"],
    ["it's 4410 W Maple by the church", "it's [address] by the church"],
    ["my address is 5 Persimmon", "my address is [address]"],
  ]) assertEquals(scrub(said), want, said);
  for (const talk of [
    "12x24 barn", "2024 models", "a 10x12 with 2 windows", "$1234", "#1234", "order #1234 Main Barn", "$1234 Lofted Barn", "$1234 Main",
    "The 2024 Lofted Barn is $8,450.", "2 Lofted Barns on the lot", "12 x 24 Lofted Barn", "SW 7005 Pure White", "Q-1043 Main",
    "Call at 9 Friday", "ready at 10 Am", "set up at 3 Central", "back to 12 Noon", "We have 120 Garden Sheds sold.", "Sold 2026 Spring specials",
  ]) assertEquals(scrub(talk), talk, talk);
});

Deno.test("shed specs after to or from stay as typed; a street after them still goes", () => {
  // The audit's cases (11-09): units, parts and wood in Title Case read as house numbers before.
  for (const talk of [
    "Can you switch from 29 Gauge to 26 Gauge metal?", "I want to go from 10 Foot walls to 12 Foot walls", "Upgrade to 12 Pitch roof",
    "We need 30 Cedar posts", "Comes with 16 Cedar shutters", "Set the status to 2 Contacted", "Can I upgrade to 29 Gauge metal?",
    "Switch it to 6 Panel doors", "Go to 12 Foot", "Add to 3 Windows", "Make it to 14 Wide", "Upgrade to 40 Year shingles", "From 10 Ft to 12 Ft",
    "Siding: LP Smart Siding to 29 Gauge Metal", "Upgraded to 29 Gauge Metal roof", "to 36 Inch doors", "to 2 Lofted Barns", "from 30 Cedar posts",
  ]) assertEquals(scrub(talk), talk, talk);
  // Streets, with or without a street word, are still blanked; years after "to" are house numbers too.
  for (const [said, want] of [
    ["Deliver to 1234 Oak Ridge, Sedalia", "Deliver to [address], Sedalia"],
    ["Deliver to 2010 Oak, Sedalia", "Deliver to [address], Sedalia"],
    ["we're at 1985 Pine", "we're at [address]"],
    ["drop it at 12 High, Warsaw", "drop it at [address], Warsaw"],
    ["come to 5 Spring Valley", "come to [address]"],
    ["30 Cedar is the house", "[address] is the house"],
  ]) assertEquals(scrub(said), want, said);
});
