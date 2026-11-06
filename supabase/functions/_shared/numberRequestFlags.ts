// Workstream 2, phase 8: what the operator console flags on an open "Bring your number" request
// (admin-catalog number_requests_list; migration 298).
//
// Review 2026-10-09: portal-settings phone_port_request no longer refuses a builder's request over
// ANOTHER builder's number or request. Refusing told any builder with phone:edit whether a number
// was some other business's, and let one builder block another's request. Those requests are stored
// like any other, and the operator sees the overlap here instead:
//   liveElsewhere   the request's numbers that are live on another builder's account (sms_numbers,
//                   released_at null);
//   askedElsewhere  the request's numbers that another builder's OPEN request also names.
// Operators see every builder, so naming the other client id here leaks nothing.
//
// Pure (no I/O, no jsr:/npm: imports): numberRequestFlags.test.ts runs in preflight's
// dependency-free `_shared` group.

export type RequestFlagRow = { id: string; client_id: string; numbers: string[] };
export type LiveNumberRow = { phone_number: string; client_id: string };
export type RequestFlags = {
  liveElsewhere: Array<{ number: string; clientId: string }>;
  askedElsewhere: Array<{ number: string; clientId: string }>;
};

/** The flags for one open request, given the live numbers its numbers match and every open request. */
export function requestFlags(r: RequestFlagRow, o: { live: LiveNumberRow[]; open: RequestFlagRow[] }): RequestFlags {
  const mine = new Set(r.numbers ?? []);
  const liveElsewhere = o.live
    .filter((n) => mine.has(n.phone_number) && n.client_id !== r.client_id)
    .map((n) => ({ number: n.phone_number, clientId: n.client_id }));
  const askedElsewhere: RequestFlags["askedElsewhere"] = [];
  for (const other of o.open) {
    if (other.id === r.id || other.client_id === r.client_id) continue;
    for (const n of other.numbers ?? []) {
      if (mine.has(n) && !askedElsewhere.some((a) => a.number === n && a.clientId === other.client_id)) {
        askedElsewhere.push({ number: n, clientId: other.client_id });
      }
    }
  }
  return { liveElsewhere, askedElsewhere };
}
