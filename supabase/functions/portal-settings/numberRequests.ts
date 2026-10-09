// Workstream 2, phase 8: "Bring your number". A builder asks to move numbers they already have into
// Structure Studio (phone_port_request), and an operator lands a moved number on their account once
// it has arrived in their Twilio account (phone_adopt_number). The move itself is an operator's job
// done outside our code for now (workers/phone-api/PORTING.md): a GoHighLevel LC Phone number is a
// HighLevel support ticket, a carrier number a Twilio Port In request made in Twilio's Console.
//
// ⚠️ NO SECRETS. A port needs the line's PIN or account number, a recent bill and a signed LOA. None
// of it is asked for, accepted or stored here: a request carrying any key that names one is refused
// outright, and a run of five or more digits in a free-text box is refused (migration 297 refuses it
// again), so a PIN or an account number typed into the wrong box is never kept. The operator types
// the PIN into Twilio's Console, the bill is uploaded there, and Twilio emails the LOA to the
// contact named here.
//
// This file is the part that runs without a network or a database: parsing the request, what the
// builder is shown, and the ORDER of an adoption. index.ts does the reads, the writes and the gates;
// tests/phone/numberRequests_test.ts drives every path here against stubs.

/** At most this many numbers in one request (Twilio's Port In takes up to 1,000; ten is plenty for a builder). */
export const MAX_REQUEST_NUMBERS = 10;
/** At most this many requests open at once per builder. */
export const MAX_OPEN_REQUESTS = 5;

/** Toll-free area codes: Twilio's Port In takes US local and mobile numbers only. */
const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/** What a builder is told when something that looks like a secret reaches us. */
export const PORT_SECRET_SENTENCE =
  "Don't put a PIN, password or account number here. Structure Studio asks for those by phone when the move is booked, and never stores them.";

/** Keys a request may NEVER carry. Their presence alone refuses it (nothing is read from them). */
const SECRET_KEYS = /pin|passcode|password|account_?number|accountnumber|acct|ssn|tax_?id|bill|loa|ssn|card/i;

/** A run of five or more digits: an account number or a PIN, never a carrier, a name or a date. */
const DIGIT_RUN = /\d{5,}/;

export type PortRequest = {
  numbers: string[];
  currentCarrier: string;
  /** true = a GoHighLevel LC Phone number; false = another carrier; null = not sure. */
  isLcPhone: boolean | null;
  contactName: string;
  contactEmail: string;
  cutoverWindow: string | null;
};

/** One typed number → E.164 (+1NXXNXXXXXX), or null. Takes "(816) 555-0123", "816-555-0123",
 *  "18165550123" and "+18165550123". */
export function portNumberE164(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** The builder's request → what is stored, or the sentence to refuse it with. */
export function parsePortRequest(raw: unknown): { ok: true; value: PortRequest } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (Object.keys(r).some((k) => SECRET_KEYS.test(k))) return { ok: false, error: PORT_SECRET_SENTENCE };

  const list = Array.isArray(r.numbers) ? r.numbers : String(r.numbers ?? "").split(/[,;\n]+/);
  const typed = list.map((n) => String(n ?? "").trim()).filter(Boolean);
  if (!typed.length) return { ok: false, error: "Enter the number you want to bring, like (816) 555-0123." };
  const numbers: string[] = [];
  for (const t of typed) {
    const e = portNumberE164(t);
    if (!e) return { ok: false, error: `"${t.slice(0, 20)}" isn't a US phone number. Enter it like (816) 555-0123.` };
    if (TOLL_FREE.has(e.slice(2, 5))) {
      return { ok: false, error: "Toll-free numbers can't be moved this way yet. Contact Structure Studio about a toll-free number." };
    }
    if (!numbers.includes(e)) numbers.push(e);
  }
  if (numbers.length > MAX_REQUEST_NUMBERS) {
    return { ok: false, error: `Ask for at most ${MAX_REQUEST_NUMBERS} numbers at a time.` };
  }

  const currentCarrier = clean(r.currentCarrier);
  if (!currentCarrier) return { ok: false, error: "Say which company the number is with now (for example Verizon, or GoHighLevel)." };
  if (currentCarrier.length > 80) return { ok: false, error: "Keep the company's name under 80 characters." };

  const lc = r.isLcPhone;
  const isLcPhone = lc === true || lc === "yes" ? true : lc === false || lc === "no" ? false : null;

  const contactName = clean(r.contactName);
  if (contactName.length < 2 || contactName.length > 120) {
    return { ok: false, error: "Enter the name of the person who can approve the move (the account holder)." };
  }
  const contactEmail = clean(r.contactEmail).toLowerCase();
  if (contactEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return { ok: false, error: "Enter that person's email address. The paperwork to approve the move is sent there." };
  }
  const window = clean(r.cutoverWindow);
  if (window.length > 200) return { ok: false, error: "Keep the timing note under 200 characters." };

  for (const v of [currentCarrier, contactName, window]) {
    if (DIGIT_RUN.test(v)) return { ok: false, error: PORT_SECRET_SENTENCE };
  }
  return { ok: true, value: { numbers, currentCarrier, isLcPhone, contactName, contactEmail, cutoverWindow: window || null } };
}

/** The phone_number_requests row (migration 297) for a parsed request. */
export function portRequestRow(clientId: string, userId: string | null, v: PortRequest) {
  return {
    client_id: clientId,
    numbers: v.numbers,
    current_carrier: v.currentCarrier,
    is_lc_phone: v.isLcPhone,
    contact_name: v.contactName,
    contact_email: v.contactEmail,
    cutover_window: v.cutoverWindow,
    status: "new",
    requested_by: userId,
  };
}

export type PortRequestRow = {
  id?: string; numbers?: string[] | null; current_carrier?: string | null; is_lc_phone?: boolean | null;
  contact_name?: string | null; contact_email?: string | null; cutover_window?: string | null;
  status?: string | null; created_at?: string | null; handled_at?: string | null;
};

/** What the builder's Phone tab is shown about one of their requests. */
export function portRequestView(r: PortRequestRow) {
  return {
    id: r.id ?? null,
    numbers: Array.isArray(r.numbers) ? r.numbers : [],
    currentCarrier: r.current_carrier ?? "",
    isLcPhone: r.is_lc_phone ?? null,
    contactName: r.contact_name ?? "",
    contactEmail: r.contact_email ?? "",
    cutoverWindow: r.cutover_window ?? null,
    status: r.status ?? "new",
    createdAt: r.created_at ?? null,
    handledAt: r.handled_at ?? null,
  };
}

/** Why a new request is refused given what is already open (any builder's), or null. A number
 *  already live on Structure Studio is not moved again; one already asked for is not asked twice. */
export function portRequestConflict(
  v: PortRequest,
  o: { openForTenant: number; openNumbers: string[]; liveNumbers: string[] },
): string | null {
  if (o.openForTenant >= MAX_OPEN_REQUESTS) {
    return `You already have ${o.openForTenant} requests open. Structure Studio will be in touch about those first.`;
  }
  const live = v.numbers.find((n) => o.liveNumbers.includes(n));
  if (live) return `${live} is already on Structure Studio.`;
  const asked = v.numbers.find((n) => o.openNumbers.includes(n));
  if (asked) return `${asked} has already been asked for. Structure Studio will be in touch about it.`;
  return null;
}

// ── phone_adopt_number: land a moved number on the builder's account ─────────────────────────

/** The number an operator typed → E.164 (US local and mobile), or null. */
export function parseAdoptNumber(raw: unknown): string | null {
  const e = portNumberE164(raw);
  return e && !TOLL_FREE.has(e.slice(2, 5)) ? e : null;
}

type Find = (e164: string) => Promise<{ ok: true; sid: string | null } | { ok: false; status: number; code: number }>;

export type AdoptOutcome =
  | { ok: true; already: true; rowId: string }
  | { ok: true; already: false; sid: string; row: { id: string; phone_number: string; twilio_sid: string | null } }
  | { ok: false; kind: "refused"; status: number; error: string; code?: string }
  | { ok: false; kind: "twilio"; status: 502; error: string; code: number }
  | { ok: false; kind: "db"; error: unknown };

/**
 * Find the moved number IN THE BUILDER'S OWN ACCOUNT and record it, in this order:
 *   1. A live sms_numbers row with this number: this builder's → nothing to do ("already");
 *      another builder's → refused (sms-inbound resolves a tenant by the number alone).
 *   2. The builder's account (their sub-account, or the parent for a builder who lives there).
 *   3. Not there: if the builder is on a sub-account, the parent is asked too, ONLY to say where it
 *      is. A number in a different account than the builder's is REFUSED, never recorded: its texts
 *      and calls would run with the wrong account's credentials, and 292/295 forbid the split.
 *      (Moving it between our accounts is a runbook step: PORTING.md.)
 *   4. Found: the calling-only row (phoneNumber.ts callingOnlyNumberRow), with the sub's SID.
 * Nothing here changes the number at Twilio; the handler then points its calls and texts (the
 * purchase's own steps) once the row exists.
 */
export async function adoptNumber(
  o: { e164: string; subAccountSid: string | null },
  deps: {
    liveRow: (e164: string) => Promise<{ ok: true; row: { id: string; client_id: string } | null } | { ok: false; error: unknown }>;
    tenantId: string;
    findInTenant: Find;
    /** The parent's own lookup, asked only for a builder on a sub-account. */
    findInParent: Find | null;
    record: (sid: string) => Promise<{ ok: true; row: { id: string; phone_number: string; twilio_sid: string | null } } | { ok: false; error: unknown }>;
  },
): Promise<AdoptOutcome> {
  const live = await deps.liveRow(o.e164);
  if (!live.ok) return { ok: false, kind: "db", error: live.error };
  if (live.row) {
    return live.row.client_id === deps.tenantId
      ? { ok: true, already: true, rowId: live.row.id }
      : { ok: false, kind: "refused", status: 409, error: "That number is already on another Structure Studio account.", code: "number_elsewhere" };
  }
  const here = await deps.findInTenant(o.e164);
  if (!here.ok) return { ok: false, kind: "twilio", status: 502, code: here.code, error: "Couldn't reach the phone company just now. Try again in a minute." };
  if (!here.sid) {
    if (o.subAccountSid && deps.findInParent) {
      const there = await deps.findInParent(o.e164);
      if (there.ok && there.sid) {
        return {
          ok: false, kind: "refused", status: 409, code: "number_on_parent",
          error: "That number landed on Structure Studio's main Twilio account, not this builder's own. Move it into their account first (PORTING.md), then adopt it.",
        };
      }
    }
    return {
      ok: false, kind: "refused", status: 404, code: "number_not_in_account",
      error: "That number isn't in this builder's Twilio account yet. A move finishes on its date: check the port or the HighLevel ticket, then try again.",
    };
  }
  if (!/^PN[0-9a-f]{32}$/i.test(here.sid)) return { ok: false, kind: "twilio", status: 502, code: 0, error: "Twilio returned a number without a usable SID." };
  const rec = await deps.record(here.sid);
  if (!rec.ok) return { ok: false, kind: "db", error: rec.error };
  return { ok: true, already: false, sid: here.sid, row: rec.row };
}
