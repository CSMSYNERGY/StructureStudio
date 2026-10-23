// meetingIcs.ts — the calendar invite a booking confirmation carries. Migration 327, phase 2
// of MEETINGS_SCOPE.md.
//
// WHY AN ATTACHMENT AT ALL: this is the only sync that works for the CUSTOMER, who will never
// connect anything to us. The host's own Google/Outlook sync is phases 3-4; the person booking
// a lot walkthrough gets one email and expects it to land in whatever calendar they already
// use. A link to "add to calendar" is a second click most people never make.
//
// PURE and no I/O, like meetingAvailability.ts, for the same reason: iCalendar is a format
// with a handful of rules that are each silently fatal, and the only way to hold them is a
// test that reads the bytes. See meetingIcs.test.ts.
//
// ── THE RULES THAT BITE (RFC 5545) ───────────────────────────────────────────────────────
//   * CRLF line endings, everywhere. A bare \n is not a line break to a strict parser.
//   * Lines fold at 75 OCTETS — not characters. A continuation starts with one space. Fold in
//     the wrong place and the content is corrupted rather than rejected, which is worse.
//   * TEXT values escape backslash, semicolon, comma and newline. An unescaped comma in a
//     LOCATION silently splits the value into two.
//   * SEQUENCE must INCREASE for an update to be honoured. A client that sees the same
//     sequence ignores the new time entirely, so a rescheduled meeting keeps the old one.
//   * UID must be STABLE across the invite, the update and the cancellation, or the
//     cancellation creates a second event instead of removing the first.
//   * METHOD:CANCEL plus STATUS:CANCELLED is what removes an event. Sending REQUEST with
//     STATUS:CANCELLED leaves it sitting there.

export type IcsMeeting = {
  /** The meeting's row id. The UID is derived from it, so it is stable for the life of the
   *  booking — including across reschedules, which must UPDATE the event, not add one. */
  id: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** What the event is called in the customer's calendar. */
  title: string;
  description?: string | null;
  location?: string | null;
  /** The host, as the ORGANIZER. The address is the business's, never a personal one. */
  organizerName: string;
  organizerEmail: string;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  /** Where the customer manages the booking; becomes URL on the event. */
  manageUrl?: string | null;
  /** meetings.ics_sequence. MUST have increased since the last invite for this UID. */
  sequence: number;
  /** "request" for a booking or a move, "cancel" to take it out of their calendar. */
  method: "request" | "cancel";
  /** Injectable for the tests; defaults to now. */
  now?: Date;
};

/** The domain the UID is namespaced to. Not read from a request — a UID that varied by host
 *  would break the update/cancel chain for anyone who booked through a different address. */
const UID_DOMAIN = "structurestudiosuite.com";

/** RFC 5545 TEXT escaping. Order matters: the backslash must be escaped FIRST, or the
 *  backslashes this function itself introduces get escaped a second time. */
export function icsEscape(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** An instant as iCalendar UTC: 20261023T150000Z. */
export function icsStamp(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new Error("meetingIcs: not a date");
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Fold one content line to 75 OCTETS per line, continuations prefixed with a space.
 *
 * ⚠️ Octets, not characters, and that distinction is the whole reason this is not a
 * `slice(0, 75)`: a description with an em-dash or an accented name is multi-byte in UTF-8,
 * and splitting it by character count can both overrun the limit AND cut a code point in
 * half. This walks code points and counts their encoded length, so a multi-byte character is
 * never split.
 */
export function icsFold(line: string): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  // The first line may use 75 octets; a continuation spends one on its leading space.
  let limit = 75;
  for (const ch of String(line)) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : " " + l));
}

/** The stable UID for a meeting. Same value for the invite, every update and the cancel. */
export function icsUid(meetingId: string): string {
  return `meeting-${meetingId}@${UID_DOMAIN}`;
}

/**
 * The whole VCALENDAR, CRLF-terminated and folded, ready to attach.
 *
 * The caller base64s it; this returns text so the tests can read it.
 */
export function buildMeetingIcs(m: IcsMeeting): string {
  const cancel = m.method === "cancel";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CSM Synergy//Structure Studio//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancel ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${icsUid(m.id)}`,
    `DTSTAMP:${icsStamp(m.now ?? new Date())}`,
    `DTSTART:${icsStamp(m.startsAt)}`,
    `DTEND:${icsStamp(m.endsAt)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(m.sequence) || 0)}`,
    `SUMMARY:${icsEscape(m.title)}`,
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    // A cancelled event must not keep asking the customer to reply.
    cancel ? "TRANSP:TRANSPARENT" : "TRANSP:OPAQUE",
    `ORGANIZER;CN=${icsEscape(m.organizerName)}:mailto:${m.organizerEmail}`,
  ];

  if (m.location) lines.push(`LOCATION:${icsEscape(m.location)}`);
  if (m.description) lines.push(`DESCRIPTION:${icsEscape(m.description)}`);
  if (m.manageUrl) lines.push(`URL:${m.manageUrl}`);
  if (m.attendeeEmail) {
    // RSVP=TRUE on a cancellation would ask someone to accept a meeting that is off.
    const rsvp = cancel ? "" : ";RSVP=TRUE";
    const cn = m.attendeeName ? `;CN=${icsEscape(m.attendeeName)}` : "";
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION${rsvp}:mailto:${m.attendeeEmail}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  // Fold every line, then join with CRLF and end with one.
  return lines.flatMap((l) => icsFold(l)).join("\r\n") + "\r\n";
}

/** Base64 of the UTF-8 bytes, which is what an email attachment carries. */
export function icsBase64(ics: string): string {
  const bytes = new TextEncoder().encode(ics);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
