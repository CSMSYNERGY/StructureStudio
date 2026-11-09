// jack-agent: what of a customer may reach Claude (redact_test.ts).
//
// Plan section 6: phone numbers and email addresses stay out of what the AI sees, and so do street lines
// (Ahsan's default 11-06: the town is enough to tell "the 12x24 in Sedalia" apart). Two layers, and every
// piece uses both:
//   pick()   a whitelist. Only named fields are copied out of a route's answer, so a field a route adds
//            later can't slip through.
//   scrub()  for free text (a customer's message, a note, a name that fell back to an address): emails
//            (spelled-out ones too), runs of seven or more digits (with the usual separators) and
//            street-looking lines (with a street word, or a house number in the shapes below) are blanked.
// Neither is a promise on its own. pick() is the one that matters; scrub() catches what people type.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7+ digits, allowing spaces, dots, dashes, slashes and brackets between them: (816) 555-0100, 816.555.0100,
// +1 816 555 0100, 8165550100. A price like $12,450 has 5 digits; a 2026-11-06 date has 8, so dates go
// through `keepDates` first.
const PHONEISH = /(?:\+?\d[\s().\-/]{0,3}){7,}\d?/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const SLASH_DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
// Ids aren't contact details, and a uuid's digit runs would otherwise read as a phone number.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// "1234 N Main St", "88 County Road 12", "PO Box 445". Only the number-plus-street-word shape, so prose
// survives.
// The part of a street line after its number: shared, so a line whose number a phone run swallowed
// ("816 555 0199 1234 Main St") still goes.
const STREET_TAIL = "(?:[NSEW]\\.?\\s+)?(?:[A-Za-z0-9.']+\\s+){0,4}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|hwy|highway|ct|court|cir|circle|pkwy|parkway|pl|place|ter|terrace|way|trl|trail|route|rte)\\b\\.?";
const STREET = new RegExp("\\b\\d{1,6}\\s+" + STREET_TAIL, "gi");
const PHONE_THEN_STREET = new RegExp("\\[phone\\][\\s.,-]*" + STREET_TAIL, "gi");
const PO_BOX = /\bP\.?\s?O\.?\s*Box\s+\d+\b/gi;

// An email spelled out to get past a filter: "dale at gmail dot com", "dale (at) gmail (dot) com",
// "dale @ gmail . com", "dale at gmail.com". The "at" is a word, a bracketed (at) or a spaced @. When the
// last dot is a real one, the ending must be a common one (com, net, org...), so "I'm at home. Me and
// Dale" stays; when it's a spelled "dot", any ending goes.
const SP_AT = String.raw`(?:\s*@\s*|\s*[(\[{<]\s*at\s*[)\]}>]\s*|\s+at\s+)`;
const SP_DOTW = String.raw`(?:\s*[(\[{<]\s*dot\s*[)\]}>]\s*|\s+dot\s+)`;
const SP_DOT = String.raw`(?:\.|\s+\.\s+|${SP_DOTW})`;
const SP_LABEL = "[A-Za-z0-9-]+";
const SP_ENDS = "com|net|org|edu|gov|mil|us|co|io|info|biz|me|uk|ca";
const SPELLED_EMAIL = new RegExp(String.raw`[A-Za-z0-9._%+-]+${SP_AT}${SP_LABEL}(?:${SP_DOT}${SP_LABEL})*(?:${SP_DOTW}[A-Za-z]{2,6}|${SP_DOT}(?:${SP_ENDS}))\b`, "gi");
// "dale at gmail", with no ending at all: only the big mail providers, whose names mean nothing else.
const PROVIDER_EMAIL = new RegExp(String.raw`[A-Za-z0-9._%+-]+${SP_AT}(?:gmail|googlemail|yahoo|ymail|hotmail|aol|icloud|protonmail)\b`, "gi");

// A house number with no street word ("1234 Main", "at 1234 Oak"). Sizes, years, money and order
// numbers are shed talk and stay ("12x24 barn", "2024 models", "2 windows", "$1234", "#1234"), so only
// two shapes go:
//   after "at", "to", "from" or "address": a number and a capitalized word, unless that word is a day,
//     a month or a time ("at 9 Friday", "to 10 Am");
//   anywhere else: a number of 2 to 6 digits (not a year, and not after $, #, a digit or a dash) and
//     one of the most common street names, capitalized.
// One or two more capitalized words after it go too ("1234 Oak Ridge"); a comma ends it, so the town stays.
const NOT_STREET = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Noon|Midnight|Central|Eastern|Mountain|Pacific|Am|Pm";
// Shed talk after "to" or "from" (11-09): units, parts and spans, as people write them in Title Case or
// copy them from an option label ("switch from 29 Gauge to 26 Gauge", "to 12 Foot walls", "to 2 Windows",
// "to 40 Year shingles"). None is a street name; High and Spring are, so they aren't here.
const NOT_HOUSE = "Gauge|Ga|Foot|Feet|Ft|Inch|Inches|In|Pitch|Pitched|Wide|Long|Tall|Deep|Sq|Square|Year|Years|Yr|Yrs|Week|Weeks|Day|Days|Month|Months|Percent|Dollars|Window|Windows|Door|Doors|Loft|Lofts|Shelf|Shelves|Post|Posts|Panel|Panels|Single|Double|Lofted|Coat|Coats";
// A street name used for wood ("30 Cedar posts", "16 Cedar shutters"): what comes after it says so.
const WOOD_AFTER = String.raw`(?!\s+(?:[Pp]osts?|[Bb]oards?|[Ss]hutters?|[Ss]iding|[Tt]rim|[Ll]umber|[Ff]loor(?:ing|s)?|[Pp]lanks?|[Bb]eams?|[Ss]tain|[Ll]ap|[Ss]hakes?|[Ss]hingles?)\b)`;
const STREET_NAMES = "Main|Oak|Pine|Maple|Cedar|Elm|Walnut|Chestnut|Hickory|Spruce|Willow|Birch|Poplar|Sycamore|Cherry|Locust|Dogwood|Magnolia|Laurel|Park|Lake|Hill|Ridge|River|Spring|Mill|Church|School|Market|Water|Front|High|Center|Union|Liberty|Prospect|Pleasant|Highland|Sunset|Meadow|Forest|Valley|Railroad|Broadway|Washington|Lincoln|Jefferson|Jackson|Madison|Franklin|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth";
const HOUSE_DIR = String.raw`(?:(?:[NSEW]\.?|North|South|East|West)\s+)?`;
const HOUSE_MORE = String.raw`(?:\s+(?!(?:${NOT_STREET})\b)[A-Z][a-z']+\b){0,2}`;
// "Set the status to 2 Contacted": a pipeline stage's name after status, stage or column is never a street.
const NOT_AFTER_STAGE = String.raw`(?<!\b(?:[Ss]tatus|[Ss]tage|[Cc]olumn|[Ss]tep)\s+)`;
const HOUSE_AFTER_WORD = new RegExp(String.raw`${NOT_AFTER_STAGE}\b([Aa]t|[Tt]o|[Ff]rom|[Aa]ddress(?:\s+is)?:?)\s+\d{1,6}[A-Za-z]?\s+${HOUSE_DIR}(?!(?:${NOT_STREET}|${NOT_HOUSE})\b)[A-Z][a-z']+\b${WOOD_AFTER}${HOUSE_MORE}`, "g");
const HOUSE_BARE = new RegExp(String.raw`(?<![$#\d.,:/×\u0001-])\b(?!(?:19|20)\d\d\b)\d{2,6}[A-Za-z]?\s+${HOUSE_DIR}(?:${STREET_NAMES})\b${WOOD_AFTER}${HOUSE_MORE}`, "g");

const has = (re: RegExp, s: string) => { re.lastIndex = 0; const hit = re.test(s); re.lastIndex = 0; return hit; };

/** Blanks emails, phone numbers and street lines in free text. Dates and money survive. */
export function scrub(text: unknown, max = 2000): string {
  let s = String(text ?? "");
  const kept: string[] = [];
  const hold = (m: string) => { kept.push(m); return `\u0001${kept.length - 1}\u0001`; };
  s = s.replace(UUID, hold).replace(ISO_DATE, hold).replace(SLASH_DATE, hold);
  // Phones before street lines: STREET's leading number can start inside a phone ("816-555-0199 at 1234 N
  // Main St" would keep "816-555-" when the street went first).
  s = s.replace(EMAIL, "[email]").replace(SPELLED_EMAIL, "[email]").replace(PROVIDER_EMAIL, "[email]");
  s = s.replace(PHONEISH, (m) => (m.replace(/\D/g, "").length >= 7 ? "[phone]" : m));
  s = s.replace(PHONE_THEN_STREET, "[phone] [address]").replace(PO_BOX, "[address]").replace(STREET, "[address]");
  s = s.replace(HOUSE_AFTER_WORD, (_m, word: string) => `${word} [address]`).replace(HOUSE_BARE, "[address]");
  // deno-lint-ignore no-control-regex
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i) => kept[Number(i)] ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** True when a name is really an address or a number (an inbox falls back to those when a contact has
 *  no name). Such a name is dropped, never scrubbed into "[email]". */
export function nameIsContactDetail(name: unknown): boolean {
  const s = String(name ?? "").trim();
  if (!s) return true;
  if (has(EMAIL, s) || has(SPELLED_EMAIL, s) || has(PROVIDER_EMAIL, s)) return true;
  return s.replace(/\D/g, "").length >= 7 && !/[a-z]{2,}/i.test(s);
}

/** A display name for Claude: the name if it's a name, else null. Scrubbed anyway. */
export function safeName(name: unknown): string | null {
  return nameIsContactDetail(name) ? null : scrub(name, 80);
}

/** Copies only the listed keys. Values are scrubbed when they are strings. */
// deno-lint-ignore no-explicit-any
export function pick<T extends Record<string, any>>(row: T | null | undefined, keys: (keyof T & string)[]): Partial<T> {
  const out: Partial<T> = {};
  if (!row || typeof row !== "object") return out;
  for (const k of keys) {
    if (!(k in row)) continue;
    const v = row[k];
    // deno-lint-ignore no-explicit-any
    (out as any)[k] = typeof v === "string" ? scrub(v, 300) : v;
  }
  return out;
}

/** The last check before anything goes into Claude's messages: true when it still holds what looks like
 *  an email or a phone number. Pieces assert this in tests; agent.ts uses it as a guard on tool output. */
export function leaksContactDetails(text: string): boolean {
  if (has(EMAIL, text) || has(SPELLED_EMAIL, text) || has(PROVIDER_EMAIL, text)) return true;
  const withoutDates = text.replace(UUID, "").replace(ISO_DATE, "").replace(SLASH_DATE, "");
  const runs = withoutDates.match(PHONEISH) ?? [];
  return runs.some((m) => m.replace(/\D/g, "").length >= 7);
}
