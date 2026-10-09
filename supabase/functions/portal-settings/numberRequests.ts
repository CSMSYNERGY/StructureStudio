// Workstream 2, phase 8: "Bring your number". A builder asks to move numbers they already have into
// Structure Studio (phone_port_request), and an operator lands a moved number on their account once
// it has arrived in their Twilio account (phone_adopt_number). The move itself is an operator's job
// done outside our code for now (workers/phone-api/PORTING.md): a GoHighLevel LC Phone number is a
// HighLevel support ticket, a carrier number a Twilio Port In request made in Twilio's Console.
//
// ⚠️ NO SECRETS. A port needs the line's account number (and a mobile's PIN), a recent bill and a signed LOA. None
// of it is asked for, accepted or stored here: a request carrying any key that names one is refused
// outright, and a free-text box is refused when it carries five or more digits in a row, even
// spaced, dotted or dashed ("1234-5678-9012"), or any digit after a word like PIN, passcode,
// password, acct or account ("PIN 4829"); dates and times in the timing note are allowed
// (looksSecret). Migration 297 refuses the same again, so a PIN or an account number typed into the
// wrong box is never kept. The operator types the PIN into Twilio's Console, the bill is uploaded
// there, and Twilio emails the LOA to the contact named here.
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

/** Five or more digits joined only by spaces, dots, slashes or dashes ("1234-5678-9012",
 *  "48 29 13 7"): an account number or a PIN, never a carrier or a name. Review 2026-10-09: a bare
 *  `\d{5,}` let "acct 287-123-456" through. Migration 297's checks are the same pattern. */
const DIGIT_RUN = /\d(?:[\s./-]*\d){4,}/;
/** Any digit soon after a word that names a secret ("PIN 4829", "acct #12", "account no. 4"),
 *  however short. */
const SECRET_WORD = /\b(?:pin|passcode|pass\s*code|password|acct|account|ssn|security\s*code)\b(?:\s*(?:no|num|number)\b)?[^a-z0-9]{0,6}\d/i;

/**
 * The timing note with its dates and times taken out, so "after 10/20/2026, 9am-5pm" is not read as
 * a run of digits: ISO dates, 10/20 and 10/20/2026 (also with dots or dashes), 9am, 9:30 pm, 17:00
 * and years 1900-2099. Migration 297 strips the same before its check.
 */
export function withoutDatesAndTimes(s: string): string {
  return s
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
}

/** Does this free text look like it carries a PIN or an account number? `dates`: the timing note,
 *  whose dates and times are allowed. */
export function looksSecret(v: string, opts: { dates?: boolean } = {}): boolean {
  if (SECRET_WORD.test(v)) return true;
  return DIGIT_RUN.test(opts.dates ? withoutDatesAndTimes(v) : v);
}

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

  if (looksSecret(currentCarrier) || looksSecret(contactName) || looksSecret(window, { dates: true })) {
    return { ok: false, error: PORT_SECRET_SENTENCE };
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

/**
 * Why a new request is refused, given THIS BUILDER'S OWN numbers and open requests, or null. A
 * number already live on their account is not moved again; one they already asked for is not asked
 * twice. Other builders' numbers and requests are never read here (review 2026-10-09: refusing on
 * them told any builder whether a number was another business's, and let one builder block
 * another's request). A number that is another builder's, or that another builder also asked for,
 * is stored like any other and FLAGGED to the operator (admin-catalog number_requests_list, with
 * _shared/numberRequestFlags.ts).
 */
export function portRequestConflict(
  v: PortRequest,
  o: { openForTenant: number; ownOpenNumbers: string[]; ownLiveNumbers: string[] },
): string | null {
  if (o.openForTenant >= MAX_OPEN_REQUESTS) {
    return `You already have ${o.openForTenant} requests open. Structure Studio will be in touch about those first.`;
  }
  const live = v.numbers.find((n) => o.ownLiveNumbers.includes(n));
  if (live) return `${live} is already on your account.`;
  const asked = v.numbers.find((n) => o.ownOpenNumbers.includes(n));
  if (asked) return `${asked} is already in one of your open requests. Structure Studio will be in touch about it.`;
  return null;
}

// ── phone_adopt_number: land a moved number on the builder's account ─────────────────────────

/**
 * The environment as phone_adopt_number hands it to ensureTwilioAccount: TWILIO_SUBACCOUNTS "on"
 * read as "manual", so the account is LOOKED UP, never made or finished (review 2026-10-09: a moved
 * number can only be in an account that already exists, and an adoption must not provision a
 * sub-account as a side effect). "off" and "manual" pass through unchanged, as does everything else.
 */
export function lookupOnlyEnv(get: (k: string) => string | undefined): (k: string) => string | undefined {
  return (k) => {
    const v = get(k);
    return k === "TWILIO_SUBACCOUNTS" && v === "on" ? "manual" : v;
  };
}

/** The number an operator typed → E.164 (US local and mobile), or null. */
export function parseAdoptNumber(raw: unknown): string | null {
  const e = portNumberE164(raw);
  return e && !TOLL_FREE.has(e.slice(2, 5)) ? e : null;
}

type Find = (e164: string) => Promise<{ ok: true; sid: string | null; friendlyName?: string | null } | { ok: false; status: number; code: number }>;

/** A FriendlyName shaped like a client id (purchaseNumber names every number it buys after its
 *  builder). Twilio's own default is the formatted number, "(816) 555-0123", which never is. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

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
 *   4. Found, but its Twilio FriendlyName is ANOTHER builder's client id (the name purchaseNumber
 *      gives what it buys: a number bought for them whose row was never written, or one released
 *      here but not at Twilio): refused (review 2026-10-09).
 *   5. Found on the PARENT (the account every builder without a sub-account shares): adopted only
 *      for an OPEN request of this builder's that names it (review 2026-10-09: otherwise a typo
 *      could re-point any other number on the shared account at this builder). A sub-account is
 *      the builder's own, so any number in it is theirs.
 *   6. The calling-only row (phoneNumber.ts callingOnlyNumberRow), with the sub's SID.
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
    /** Is this name another builder's client id? Asked only for a slug-shaped FriendlyName. */
    isOtherTenant: (name: string) => Promise<{ ok: true; other: boolean } | { ok: false; error: unknown }>;
    /** Does this builder have an open request naming the number? Asked only on the parent. */
    openRequestNames: (e164: string) => Promise<{ ok: true; open: boolean } | { ok: false; error: unknown }>;
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
  const name = String(here.friendlyName ?? "").trim();
  if (SLUG.test(name) && name !== deps.tenantId) {
    const other = await deps.isOtherTenant(name);
    if (!other.ok) return { ok: false, kind: "db", error: other.error };
    if (other.other) {
      return {
        ok: false, kind: "refused", status: 409, code: "number_named_for_other",
        error: `That number is named for another builder at Twilio (${name}): it was bought for them. Sort out whose it is before adopting it.`,
      };
    }
  }
  if (!o.subAccountSid) {
    const asked = await deps.openRequestNames(o.e164);
    if (!asked.ok) return { ok: false, kind: "db", error: asked.error };
    if (!asked.open) {
      return {
        ok: false, kind: "refused", status: 409, code: "no_open_request",
        error: "On Structure Studio's shared Twilio account a moved number is adopted only for an open request of this builder's that names it. Add it on their Bring your number card first, then adopt it.",
      };
    }
  }
  const rec = await deps.record(here.sid);
  if (!rec.ok) return { ok: false, kind: "db", error: rec.error };
  return { ok: true, already: false, sid: here.sid, row: rec.row };
}
