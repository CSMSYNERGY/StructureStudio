// meetingEmails.test.ts — what the customer actually reads. Migration 327.
//
// The case that matters most is the first one: a confirmation that prints a time without
// naming the zone is the most expensive ambiguity in this feature, because the failure is
// somebody driving to a lot an hour early and nobody finding out why.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  meetingBookedEmail,
  meetingRescheduledEmail,
  meetingCancelledEmail,
  meetingReminderEmail,
  formatWhen,
  formatLength,
  formatWhere,
  reminderLead,
  type MeetingMailFacts,
} from "./meetingEmails.ts";

const F: MeetingMailFacts = {
  businessName: "Cedar Ridge Barns",
  businessPhone: "(816) 555-0100",
  businessWebsite: "cedarridgebarns.com",
  hostName: "Jamie Fulton",
  typeName: "Lot walkthrough",
  startsAt: "2026-10-23T15:00:00.000Z",
  endsAt: "2026-10-23T15:30:00.000Z",
  timeZone: "America/Chicago",
  customerName: "Dana Whitfield",
  locationKind: "in_person",
  locationDetail: "At our lot, 4120 State Road 9",
  customerNotes: "Looking at a 12x24 with a loft.",
  manageUrl: "https://app.structurestudiosuite.com/book?manage=abc123",
};

const ALL = [
  ["booked", meetingBookedEmail],
  ["rescheduled", meetingRescheduledEmail],
  ["cancelled", meetingCancelledEmail],
  ["reminder", meetingReminderEmail],
] as const;

// ── The zone, which is the whole point ───────────────────────────────────────────────────

Deno.test("wherever a clock time appears, the zone appears beside it", () => {
  // The rule is about CLOCK TIMES, not about every line: a reminder's subject says
  // "tomorrow", which needs no zone and reads better without one. What must never happen is
  // a bare "9:00 AM" with nothing saying whose 9am — that is the ambiguity that puts somebody
  // at a lot an hour early. So: any part that prints a time must also print a zone.
  const CLOCK = /\d{1,2}:\d{2}\s?(AM|PM)/i;
  const ZONE = /\b(CDT|CST|MDT|MST|EDT|EST|PDT|PST|UTC|GMT[+-]\d+)\b/;
  for (const [name, build] of ALL) {
    const m = build({ ...F, reminderHours: 24, previousStartsAt: F.startsAt });
    for (const [part, label] of [[m.subject, "subject"], [m.html, "html"], [m.text, "text"]] as const) {
      if (CLOCK.test(part)) {
        assert(ZONE.test(part), `${name} ${label} prints a time with no zone: ${part.slice(0, 160)}`);
      }
    }
    // And the body must always carry the time somewhere, zone included — a confirmation with
    // no time in it at all would pass the rule above by saying nothing.
    assert(CLOCK.test(m.html) && ZONE.test(m.html), `${name} html must state the time and zone`);
    assert(CLOCK.test(m.text) && ZONE.test(m.text), `${name} text must state the time and zone`);
  }
});

Deno.test("the time is rendered in the CUSTOMER's zone, not the host's or UTC", () => {
  // 15:00Z is 10:00 in Chicago and 09:00 in Denver. A customer who booked while looking at
  // Denver time must read 9, or they arrive an hour early.
  assertEquals(formatWhen(F.startsAt, "America/Chicago"), "Friday, October 23, 10:00 AM CDT");
  assertEquals(formatWhen(F.startsAt, "America/Denver"), "Friday, October 23, 9:00 AM MDT");
  const denver = meetingBookedEmail({ ...F, timeZone: "America/Denver" });
  assert(denver.subject.includes("9:00 AM MDT"), denver.subject);
  assert(!denver.subject.includes("10:00"), "must not leak the host's time");
});

Deno.test("an unknown zone falls back to UTC and SAYS so rather than losing the time", () => {
  const out = formatWhen(F.startsAt, "Mars/Olympus_Mons");
  assert(out.includes("UTC"), out);
  assert(out.includes("3:00 PM"), out);
});

Deno.test("a time that cannot be parsed is returned as-is, not as 'Invalid Date'", () => {
  assertEquals(formatWhen("not a time", "America/Chicago"), "not a time");
});

// ── Each email says the right thing ──────────────────────────────────────────────────────

Deno.test("the confirmation names the host, the type and what they wrote", () => {
  const m = meetingBookedEmail(F);
  assert(m.subject.startsWith("You're booked: Lot walkthrough"), m.subject);
  assert(m.html.includes("Jamie Fulton"));
  assert(m.html.includes("12x24 with a loft"), "their own words come back to them");
  assert(m.html.includes("calendar invite"), "it should say the invite is attached");
  assert(m.text.includes("Dana") || m.text.includes("you're booked") || m.text.includes("You're booked"));
});

Deno.test("the confirmation greets them by first name only", () => {
  assert(meetingBookedEmail(F).html.includes("Hi Dana,"));
  // One-word names must not produce "Hi ,".
  assert(meetingBookedEmail({ ...F, customerName: "Cher" }).html.includes("Hi Cher,"));
});

Deno.test("the reschedule email names the OLD time as well as the new one", () => {
  // Without the old time, "your meeting moved" leaves the reader unsure what they
  // misremembered.
  const m = meetingRescheduledEmail({
    ...F,
    startsAt: "2026-10-24T16:00:00.000Z",
    endsAt: "2026-10-24T16:30:00.000Z",
    previousStartsAt: F.startsAt,
  });
  assert(m.html.includes("11:00 AM CDT"), "the new time");
  assert(m.html.includes("10:00 AM CDT"), "the old time");
  assert(m.subject.startsWith("Moved:"), m.subject);
  assert(m.html.includes("shouldn't end up with two"), "reassure them about the invite");
});

Deno.test("a reschedule with no recorded previous time still reads properly", () => {
  const m = meetingRescheduledEmail({ ...F, previousStartsAt: null });
  assert(m.html.includes("has moved"));
  assert(!m.html.includes("It was ,"), "no dangling 'it was'");
  assert(!m.html.includes("undefined") && !m.html.includes("null"));
});

Deno.test("the cancellation does not offer to reschedule a meeting that is off", () => {
  const m = meetingCancelledEmail(F);
  assert(m.subject.startsWith("Cancelled:"), m.subject);
  assert(m.html.includes("taken it out of your calendar"));
  // The manage link is offered as "book another time", never "reschedule or cancel".
  assert(!/Reschedule or cancel/i.test(m.html), "must not offer to cancel a cancellation");
  assert(!/Reschedule or cancel/i.test(m.text));
  assert(m.html.includes("Book another time"));
  // And its text part must not print a When for something that is not happening as a fact.
  assert(!/^When:/m.test(m.text), m.text);
});

Deno.test("the reminder's wording follows how far out it is", () => {
  assertEquals(reminderLead(1), "in an hour");
  assertEquals(reminderLead(2), "in 2 hours");
  assertEquals(reminderLead(24), "tomorrow");
  assertEquals(reminderLead(48), "in 2 days");
  assertEquals(reminderLead(72), "in 3 days");
  // Junk must read as something, never "in NaN hours".
  assertEquals(reminderLead(0), "coming up");
  assertEquals(reminderLead(null), "coming up");
  assertEquals(reminderLead(undefined), "coming up");
  const m = meetingReminderEmail({ ...F, reminderHours: 24 });
  assertEquals(m.subject, "Reminder: Lot walkthrough tomorrow");
});

Deno.test("an in-person reminder repeats the address; a video one does not invent a place", () => {
  const here = meetingReminderEmail({ ...F, reminderHours: 2 });
  assert(here.html.includes("We're at At our lot, 4120 State Road 9") || here.html.includes("4120 State Road 9"));
  const video = meetingReminderEmail({
    ...F, reminderHours: 2, locationKind: "video", locationDetail: null,
  });
  assert(video.html.includes("Video call"));
  assert(!video.html.includes("We're at"), "nowhere to be, so do not say where");
});

// ── Formatting helpers ───────────────────────────────────────────────────────────────────

Deno.test("length reads in words", () => {
  assertEquals(formatLength("2026-10-23T15:00:00Z", "2026-10-23T15:30:00Z"), "30 minutes");
  assertEquals(formatLength("2026-10-23T15:00:00Z", "2026-10-23T16:00:00Z"), "1 hour");
  assertEquals(formatLength("2026-10-23T15:00:00Z", "2026-10-23T17:00:00Z"), "2 hours");
  assertEquals(formatLength("2026-10-23T15:00:00Z", "2026-10-23T16:30:00Z"), "1h 30m");
  // Nonsense yields nothing rather than "-5 minutes", and the row is then omitted.
  assertEquals(formatLength("2026-10-23T16:00:00Z", "2026-10-23T15:00:00Z"), "");
  assertEquals(formatLength("x", "y"), "");
});

Deno.test("the builder's own words win over the generic place", () => {
  assertEquals(formatWhere({ locationKind: "video", locationDetail: "We'll send a Zoom link" }), "We'll send a Zoom link");
  assertEquals(formatWhere({ locationKind: "video", locationDetail: null }), "Video call");
  assertEquals(formatWhere({ locationKind: "phone", locationDetail: "   " }), "Phone call");
  assertEquals(formatWhere({ locationKind: "in_person", locationDetail: null }), "In person");
  assertEquals(formatWhere({ locationKind: "custom", locationDetail: null }), "");
});

// ── House rules ──────────────────────────────────────────────────────────────────────────

Deno.test("no email says 'quote' where a person reads it", () => {
  // Carolyn 2026-10-06, Q12 — and preflight's checkEstimateWording fails a push that
  // reintroduces it. Asserted here too so it is caught in the unit run, not at the gate.
  for (const [name, build] of ALL) {
    const m = build({ ...F, reminderHours: 24, previousStartsAt: F.startsAt });
    for (const part of [m.subject, m.html, m.text]) {
      assert(!/\bquote/i.test(part), `${name} says "quote": ${part.slice(0, 120)}`);
    }
  }
});

Deno.test("every email has a real text part, not an empty one", () => {
  for (const [name, build] of ALL) {
    const m = build({ ...F, reminderHours: 24 });
    assert(m.text.trim().length > 60, `${name} needs a usable text part`);
    assert(m.text.includes("Cedar Ridge Barns"), `${name} text should name the business`);
    assert(!m.text.includes("<"), `${name} text must not contain markup`);
  }
});

Deno.test("a customer's words are escaped, never injected into the HTML", () => {
  const nasty = meetingBookedEmail({
    ...F,
    customerName: 'Dana "><script>alert(1)</script>',
    customerNotes: "<img src=x onerror=alert(1)>",
  });
  assert(!nasty.html.includes("<script>"), "no script tag survives");
  assert(!nasty.html.includes("<img src=x"), "no raw img survives");
  assert(nasty.html.includes("&lt;"), "it was escaped rather than stripped");
});

Deno.test("no email leaks 'undefined' or 'null' when the optional facts are missing", () => {
  const bare: MeetingMailFacts = {
    businessName: "Cedar Ridge Barns",
    hostName: "Jamie Fulton",
    typeName: "Quick call",
    startsAt: F.startsAt,
    endsAt: F.endsAt,
    timeZone: "America/Chicago",
    customerName: "Dana",
    locationKind: "phone",
  };
  for (const [name, build] of ALL) {
    const m = build(bare);
    for (const part of [m.subject, m.html, m.text]) {
      assert(!/undefined|null|NaN/.test(part), `${name} leaked a placeholder: ${part.slice(0, 160)}`);
    }
  }
});

Deno.test("with no manage link, nothing offers a link that does not exist", () => {
  const m = meetingBookedEmail({ ...F, manageUrl: null });
  assert(!m.html.includes("href=\"\""), "no empty hrefs");
  assert(!/Reschedule or cancel/i.test(m.html));
  assert(!m.text.includes("Reschedule or cancel:"));
});
