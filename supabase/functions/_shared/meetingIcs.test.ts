// meetingIcs.test.ts — the calendar invite, pinned. Migration 327.
//
// Every case here is a rule that fails SILENTLY if broken: the customer gets an email with an
// attachment their calendar quietly ignores, or adds twice, or adds at the old time. None of
// it throws, and none of it is visible from our side, which is why it is tested at the byte
// level rather than by eye.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMeetingIcs,
  icsEscape,
  icsFold,
  icsStamp,
  icsUid,
  icsBase64,
} from "./meetingIcs.ts";

const BASE = {
  id: "11111111-2222-3333-4444-555555555555",
  startsAt: "2026-10-23T15:00:00.000Z",
  endsAt: "2026-10-23T15:30:00.000Z",
  title: "Lot walkthrough",
  organizerName: "Cedar Ridge Barns",
  organizerEmail: "no-reply@mail.structurestudiosuite.com",
  attendeeName: "Dana Whitfield",
  attendeeEmail: "dana@example.com",
  sequence: 0,
  method: "request" as const,
  now: new Date("2026-10-22T18:00:00.000Z"),
};

function lines(ics: string): string[] {
  // Unfold first: a continuation is CRLF + one space, and a test that reads folded lines
  // would assert on where the folding happened rather than on the content.
  return ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}
function value(ics: string, key: string): string | undefined {
  const l = lines(ics).find((x) => x === key || x.startsWith(key + ":") || x.startsWith(key + ";"));
  if (!l) return undefined;
  const i = l.indexOf(":");
  return i === -1 ? "" : l.slice(i + 1);
}

// ── Structure ────────────────────────────────────────────────────────────────────────────

Deno.test("every line ends CRLF, and the file ends with one", () => {
  const ics = buildMeetingIcs(BASE);
  assert(ics.endsWith("\r\n"), "must end with CRLF");
  // A bare \n is not a line break to a strict parser: there must be none that is not part
  // of a CRLF pair.
  assertEquals(ics.replace(/\r\n/g, "").indexOf("\n"), -1, "no bare \\n anywhere");
  assertEquals(ics.indexOf("\r\r"), -1, "no doubled CR");
});

Deno.test("the envelope is a VCALENDAR holding one VEVENT", () => {
  const l = lines(buildMeetingIcs(BASE));
  assertEquals(l[0], "BEGIN:VCALENDAR");
  assertEquals(l[l.length - 1], "END:VCALENDAR");
  assertEquals(l.filter((x) => x === "BEGIN:VEVENT").length, 1);
  assertEquals(l.filter((x) => x === "END:VEVENT").length, 1);
  assert(l.includes("VERSION:2.0"));
});

Deno.test("times are UTC with a Z, and carry no punctuation", () => {
  const ics = buildMeetingIcs(BASE);
  assertEquals(value(ics, "DTSTART"), "20261023T150000Z");
  assertEquals(value(ics, "DTEND"), "20261023T153000Z");
  assertEquals(value(ics, "DTSTAMP"), "20261022T180000Z");
  // Milliseconds are not valid in an iCalendar stamp.
  assert(!/\.\d/.test(value(ics, "DTSTART")!), "no milliseconds");
});

Deno.test("icsStamp refuses a value that is not a date rather than emitting nonsense", () => {
  let threw = false;
  try { icsStamp("not a date"); } catch { threw = true; }
  assert(threw, "an unparseable date must throw, not produce 'NaN'");
});

// ── The UID / SEQUENCE contract ──────────────────────────────────────────────────────────

Deno.test("the UID is stable across the invite, the update and the cancellation", () => {
  // If this ever varies, a cancellation adds a SECOND event instead of removing the first,
  // and a reschedule leaves the customer holding both times.
  const invite = buildMeetingIcs(BASE);
  const moved = buildMeetingIcs({ ...BASE, startsAt: "2026-10-24T15:00:00.000Z", endsAt: "2026-10-24T15:30:00.000Z", sequence: 1 });
  const gone = buildMeetingIcs({ ...BASE, sequence: 2, method: "cancel" });
  const uid = icsUid(BASE.id);
  assertEquals(value(invite, "UID"), uid);
  assertEquals(value(moved, "UID"), uid);
  assertEquals(value(gone, "UID"), uid);
});

Deno.test("SEQUENCE is carried through, so an update can be honoured", () => {
  assertEquals(value(buildMeetingIcs(BASE), "SEQUENCE"), "0");
  assertEquals(value(buildMeetingIcs({ ...BASE, sequence: 3 }), "SEQUENCE"), "3");
  // Junk must not become "NaN", which a client reads as 0 — making a real update invisible.
  assertEquals(value(buildMeetingIcs({ ...BASE, sequence: Number.NaN }), "SEQUENCE"), "0");
  assertEquals(value(buildMeetingIcs({ ...BASE, sequence: -5 }), "SEQUENCE"), "0");
});

// ── Cancellation ─────────────────────────────────────────────────────────────────────────

Deno.test("a cancellation is METHOD:CANCEL *and* STATUS:CANCELLED", () => {
  // REQUEST + CANCELLED leaves the event sitting in the calendar; both are needed.
  const ics = buildMeetingIcs({ ...BASE, sequence: 1, method: "cancel" });
  assertEquals(value(ics, "METHOD"), "CANCEL");
  assertEquals(value(ics, "STATUS"), "CANCELLED");
  assertEquals(value(ics, "TRANSP"), "TRANSPARENT");
  // And it must not still be asking them to reply to a meeting that is off.
  const attendee = lines(ics).find((l) => l.startsWith("ATTENDEE"))!;
  assert(!attendee.includes("RSVP=TRUE"), attendee);
});

Deno.test("a booking is METHOD:REQUEST, CONFIRMED, and does ask for a reply", () => {
  const ics = buildMeetingIcs(BASE);
  assertEquals(value(ics, "METHOD"), "REQUEST");
  assertEquals(value(ics, "STATUS"), "CONFIRMED");
  assertEquals(value(ics, "TRANSP"), "OPAQUE");
  assert(lines(ics).find((l) => l.startsWith("ATTENDEE"))!.includes("RSVP=TRUE"));
});

// ── Escaping ─────────────────────────────────────────────────────────────────────────────

Deno.test("TEXT escaping handles the four characters that matter, backslash first", () => {
  assertEquals(icsEscape("a;b"), "a\\;b");
  assertEquals(icsEscape("a,b"), "a\\,b");
  assertEquals(icsEscape("a\nb"), "a\\nb");
  assertEquals(icsEscape("a\r\nb"), "a\\nb");
  // The backslash is escaped FIRST, so the escapes this function adds are not escaped again.
  assertEquals(icsEscape("a\\b"), "a\\\\b");
  assertEquals(icsEscape("a\\;b"), "a\\\\\\;b");
});

Deno.test("an address with a comma stays ONE location", () => {
  // Unescaped, "4120 State Road 9, Albion" becomes two values and the second is dropped.
  const ics = buildMeetingIcs({ ...BASE, location: "4120 State Road 9, Albion, IN" });
  assertEquals(value(ics, "LOCATION"), "4120 State Road 9\\, Albion\\, IN");
});

Deno.test("a multi-line description survives as one value", () => {
  const ics = buildMeetingIcs({ ...BASE, description: "Line one.\nLine two." });
  assertEquals(value(ics, "DESCRIPTION"), "Line one.\\nLine two.");
});

// ── Folding ──────────────────────────────────────────────────────────────────────────────

Deno.test("no emitted line exceeds 75 octets", () => {
  const ics = buildMeetingIcs({
    ...BASE,
    description: "A very long description ".repeat(20),
    location: "A rather long address that will certainly need folding, several times over, in fact",
  });
  const enc = new TextEncoder();
  for (const l of ics.split("\r\n")) {
    assert(enc.encode(l).length <= 75, `line is ${enc.encode(l).length} octets: ${l}`);
  }
});

Deno.test("folding counts OCTETS and never splits a character in half", () => {
  // Em-dashes are 3 bytes each in UTF-8. A character-counting fold would both overrun 75
  // octets and, worse, could cut one apart — which corrupts the value rather than erroring.
  const long = "—".repeat(60);
  const folded = icsFold("DESCRIPTION:" + long);
  const enc = new TextEncoder();
  for (const l of folded) assert(enc.encode(l).length <= 75, `${enc.encode(l).length} octets`);
  // Rejoining unfolded must give back exactly what went in, dashes intact.
  const back = folded.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
  assertEquals(back, "DESCRIPTION:" + long);
  assertEquals((back.match(/—/g) || []).length, 60, "no em-dash was broken");
});

Deno.test("a folded continuation starts with exactly one space", () => {
  const folded = icsFold("DESCRIPTION:" + "x".repeat(200));
  assert(folded.length > 1, "should have folded");
  for (const l of folded.slice(1)) {
    assertEquals(l[0], " ");
    assert(l[1] !== " ", "one space, not two — the second would be content");
  }
});

Deno.test("a long value round-trips through unfolding unchanged", () => {
  const description = "Walk the lot and see what is ready now. Bring your measurements if you have them, and we can price a custom build on the spot.";
  const ics = buildMeetingIcs({ ...BASE, description });
  assertEquals(value(ics, "DESCRIPTION"), icsEscape(description));
});

// ── Optional parts ───────────────────────────────────────────────────────────────────────

Deno.test("absent optional fields emit no empty properties", () => {
  const ics = buildMeetingIcs({
    ...BASE, location: null, description: null, manageUrl: null, attendeeEmail: null, attendeeName: null,
  });
  for (const key of ["LOCATION", "DESCRIPTION", "URL", "ATTENDEE"]) {
    assertEquals(value(ics, key), undefined, `${key} should be absent, not empty`);
  }
  // The required parts are still all there.
  for (const key of ["UID", "DTSTART", "DTEND", "SUMMARY", "ORGANIZER", "SEQUENCE"]) {
    assert(value(ics, key) !== undefined, `${key} must always be present`);
  }
});

Deno.test("the manage link rides on the event as URL", () => {
  const ics = buildMeetingIcs({ ...BASE, manageUrl: "https://app.structurestudiosuite.com/book?manage=abc123" });
  assertEquals(value(ics, "URL"), "https://app.structurestudiosuite.com/book?manage=abc123");
});

// ── Attachment encoding ──────────────────────────────────────────────────────────────────

Deno.test("base64 round-trips the bytes, multi-byte characters included", () => {
  const ics = buildMeetingIcs({ ...BASE, title: "Lot walkthrough — 30 min" });
  const back = new TextDecoder().decode(
    Uint8Array.from(atob(icsBase64(ics)), (c) => c.charCodeAt(0)),
  );
  assertEquals(back, ics);
  assert(back.includes("—"), "the em-dash survived the encode");
});
