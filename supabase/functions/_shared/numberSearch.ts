// _shared/numberSearch.ts — what a "find a number to buy" search accepts: an area code, or the
// area code and up to three more digits (816 → any 816 number; 816300 → numbers that start
// (816) 300-). Asked for on the 2026-10-12 call: the old phone system let a builder type "more
// than just the area code ... up to six digits". Matching anywhere in the number was not asked
// for, so it is not offered.
//
// The two searches that end in a purchase both read it:
//   portal-settings phone_search_numbers   Settings → Phone ("Get a number", "Add another number")
//   portal-sms      search_numbers         Text Messaging ("Choose your number")
//
// HOW TWILIO IS ASKED. AvailablePhoneNumbers/US/Local takes AreaCode (the first three digits) and
// Contains, a pattern. Twilio documents a pattern that STARTS with "+" as anchored to the start of
// the number, and its "numbers that start with a pattern" example is Contains=+1510555, so a prefix
// search sends AreaCode=816 and Contains=+1816300 (URLSearchParams sends the "+" as %2B; a raw "+"
// in a query string would arrive as a space). This was checked against Twilio's documentation, not
// a live search. The results are filtered here too (startsWithPrefix), so if Twilio ever read the
// pattern more loosely the list could only get SHORTER, never show a number that doesn't start
// with what was typed.
//
// Pure (no I/O, no jsr:/npm: imports): numberSearch.test.ts runs in preflight's dependency-free
// `_shared` group.
//
// ⚠️ Importers, redeployed together when this changes (_shared bundles PER function):
//      portal-settings/index.ts
//      portal-sms/index.ts

/** The most digits a search takes: the area code and the next three (the old system's limit). */
export const NUMBER_SEARCH_MAX_DIGITS = 6;

export const NUMBER_SEARCH_LENGTH_SENTENCE =
  "Enter an area code (3 digits), or the area code and up to 3 more digits, like 816 or 816300.";
export const NUMBER_SEARCH_AREA_SENTENCE = "A US area code starts with a digit from 2 to 9.";
export const NUMBER_SEARCH_EXCHANGE_SENTENCE =
  "A US number never has 0 or 1 right after the area code. Try fewer digits.";

export type NumberSearch =
  | {
    ok: true;
    /** What is searched for, digits only, no country code ("" = anywhere in the US). */
    digits: string;
    /** Twilio's AreaCode, or null for a search anywhere. */
    areaCode: string | null;
    /** Twilio's Contains, only when more than the area code was typed ("+1816300"). */
    contains: string | null;
    /** Every result must start with this ("+1816", "+1816300"); null = no filter. */
    prefix: string | null;
  }
  | { ok: false; error: string };

/**
 * The search box, as typed or pasted: "816", "816300", "816-300", "(816) 300", "+1 816 300".
 * Empty is a search anywhere (the screen offers "leave it empty"). Anything else is refused with
 * a sentence the screen shows, rather than quietly searching somewhere the builder didn't ask.
 */
export function numberSearchOf(raw: unknown): NumberSearch {
  let d = String(raw ?? "").replace(/\D/g, "");
  // "+1 816 300": no US area code starts with 1, so a leading 1 on anything longer than an area
  // code is the country code, not part of the search.
  if (d.length > 3 && d[0] === "1") d = d.slice(1);
  if (!d) return { ok: true, digits: "", areaCode: null, contains: null, prefix: null };
  if (d.length < 3 || d.length > NUMBER_SEARCH_MAX_DIGITS) return { ok: false, error: NUMBER_SEARCH_LENGTH_SENTENCE };
  if (!/^[2-9]/.test(d)) return { ok: false, error: NUMBER_SEARCH_AREA_SENTENCE };
  // The digit after the area code starts the exchange, which is never 0 or 1 (pickedNumber in
  // portal-settings/phoneNumber.ts refuses such a number too), so nothing could ever match.
  if (d.length > 3 && !/^[2-9]/.test(d[3])) return { ok: false, error: NUMBER_SEARCH_EXCHANGE_SENTENCE };
  return { ok: true, digits: d, areaCode: d.slice(0, 3), contains: d.length > 3 ? `+1${d}` : null, prefix: `+1${d}` };
}

/** Only the results that really start with what was searched for (all of them when prefix is null). */
export function startsWithPrefix<T extends { phoneNumber: string }>(list: T[], prefix: string | null): T[] {
  return prefix ? list.filter((n) => String(n.phoneNumber ?? "").startsWith(prefix)) : list;
}
