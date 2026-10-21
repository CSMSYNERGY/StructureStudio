// Who a quote is FOR, read one way everywhere (quote to a business entity, 2026-10-21).
//
// Junior Barns' request (portal feedback, 2026-10-14): "if we enter a business name, CRM
// communication automatically thinks that the first part of the business name is the contact's
// name and so emails and texts use that word as the person's name (example: Bear River Band
// communications all say "Hi Bear" ... I am working with a guy named Thomas)". Carolyn, 10-19:
// "quote to a business entity. Yes, we need to add this."
//
// THE MODEL. A quote's contact (designs.contact, the designer's form) holds the PERSON in `name`
// and, optionally, the BUSINESS in `company` (the designer's "Company / organization" box). The
// CRM has had both columns since migration 301 (crm_contacts.name / .company). Everything that
// greets, titles or bills the customer reads them through here:
//   companyOf      the business, or "".
//   personName     the person's whole name; "" when blank or when it only repeats the company.
//   greetingFirst  the person's first name, for "Hi Thomas"; "" when there is no person.
//   displayName    the company when there is one, else the name.
//   billTo         { company, attn } for a document's customer block.
//
// ⛔ NEVER GUESS business vs person from the shape of a name. "Bear River Band" and "Rivers Bear"
// look the same to code. With no company on the contact every function here answers exactly what
// the code answered before this file existed (the first word of the name), so a quote without a
// company is unchanged byte for byte. That is what keeps production safe: its designer sends no
// company, and the edge functions it calls are the same deploy as beta's.
//
// Self-contained (no imports), so it runs in the _shared/*.test.ts group. The portal carries a copy
// of the first five functions (portal/01-core.jsx, "Customer naming"); _test_stubs/
// customerNamingParity_test.ts runs the two against the same cases.

/**
 * CAROLYN'S CALLS, still open (drafts file, question 2). Each is the one line to change; these are
 * the plan's defaults until she answers.
 */
export const NAMING = {
  /** Documents' customer block: true = the company in bold, then "Attn: <person>"; false = the
   *  person in bold, then the company under it. */
  companyFirstOnDocuments: true,
  /** The greeting when only a company is known: false = "Hi there"; true = "Hi Bear River Band". */
  greetCompanyWhenNoPerson: false,
  /** The QuickBooks customer's display name when there is a company: "company" or "person". */
  qboDisplayName: "company" as "company" | "person",
} as const;

// deno-lint-ignore no-explicit-any
type ContactLike = any;

/** One line, the way the email module's oneLine reads a value: breaks and tabs become a space,
 *  runs of spaces become one, ends trimmed. Not a string -> String() of it, nullish -> "". */
function line(v: unknown): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** The business on the contact, or "". Only a string counts: a number or an object is not a name. */
export function companyOf(c: ContactLike): string {
  const v = c && typeof c === "object" ? c.company : undefined;
  return typeof v === "string" ? line(v) : "";
}

/** The person's whole name. "" when there is none, and "" when the name is the company typed twice
 *  (a rep who put "Bear River Band" in both boxes has told us there is no person yet). */
export function personName(c: ContactLike): string {
  const name = line(c && typeof c === "object" ? c.name : undefined);
  const company = companyOf(c);
  if (company && name.toLowerCase() === company.toLowerCase()) return "";
  return name;
}

/** The first word of the person's name, for {first} and "Hi …". With no company this is exactly
 *  the old rule (the first word of the name). With only a company it is "" (so "Hi there"), or the
 *  company when Carolyn chooses that. */
export function greetingFirst(c: ContactLike): string {
  const first = personName(c).split(" ")[0] || "";
  if (!first && NAMING.greetCompanyWhenNoPerson) return companyOf(c);
  return first;
}

/** What to call the customer in one phrase (a title, a label): the company, else the name. */
export function displayName(c: ContactLike): string {
  return companyOf(c) || line(c && typeof c === "object" ? c.name : undefined);
}

/** A document's customer block: the business and who it is for the attention of. With no company,
 *  `attn` is the name and `company` is "", which is the block every document printed before. */
export function billTo(c: ContactLike): { company: string; attn: string } {
  const company = companyOf(c);
  return { company, attn: company ? personName(c) : line(c && typeof c === "object" ? c.name : undefined) };
}

// ── The CRM's contact fields (GoHighLevel) ────────────────────────────────────────────────────

/**
 * The name fields of a GoHighLevel contact upsert (submit-estimate). WITHOUT a company this is
 * `{ name }`, exactly the body it always sent. WITH one, GoHighLevel is told the person and the
 * business apart, because left to itself it takes the first word of `name` as the first name
 * ("Bear"): firstName/lastName from the person (each only when there is one, so a quote with no
 * person never blanks a name GoHighLevel already holds) and companyName. `name` is left out then,
 * since GoHighLevel does not say which wins when both arrive.
 */
export function ghlContactNameFields(c: ContactLike): Record<string, string> {
  const company = companyOf(c);
  if (!company) return { name: (c && typeof c === "object" && c.name) || "" };
  const words = personName(c).split(" ").filter(Boolean);
  const out: Record<string, string> = {};
  if (words.length) out.firstName = words[0];
  if (words.length > 1) out.lastName = words.slice(1).join(" ");
  out.companyName = company;
  return out;
}

// ── QuickBooks ────────────────────────────────────────────────────────────────────────────────

/** QuickBooks' field limits (Customer entity): DisplayName 500, CompanyName 100, GivenName and
 *  FamilyName 100 each. */
const QBO_DISPLAY_MAX = 500;
const QBO_NAME_MAX = 100;
const cap = (s: string, n: number) => Array.from(s).slice(0, n).join("").trim();

export interface QboCustomerNames {
  /** What the customer is looked up by and created as. */
  displayName: string;
  /** Tried when QuickBooks refuses displayName as a duplicate (it must be unique across customers,
   *  vendors and employees, inactive ones included): "Company (Person)". null = no second try. */
  fallbackDisplayName: string | null;
  /** Extra fields for a NEW customer. Empty without a company, so that body is what it always was. */
  extra: Record<string, string>;
}

/**
 * The QuickBooks customer's names. `legacyName` is what qboInvoice has always used (first/last
 * keys, else name, else email, else a StructureStudio label); without a company it is the display
 * name untouched and nothing else changes. With one: DisplayName is the company (or the person, per
 * NAMING.qboDisplayName), CompanyName the company, GivenName/FamilyName the person.
 */
export function qboCustomerNames(c: ContactLike, legacyName: string): QboCustomerNames {
  const company = cap(companyOf(c), QBO_NAME_MAX);
  if (!company) return { displayName: legacyName, fallbackDisplayName: null, extra: {} };
  const person = personName(c);
  const words = person.split(" ").filter(Boolean);
  const extra: Record<string, string> = { CompanyName: company };
  if (words.length) extra.GivenName = cap(words[0], QBO_NAME_MAX);
  if (words.length > 1) extra.FamilyName = cap(words.slice(1).join(" "), QBO_NAME_MAX);
  const byPerson = NAMING.qboDisplayName === "person" && person;
  const displayName = cap(byPerson ? person : company, QBO_DISPLAY_MAX);
  const fallback = person
    ? cap(byPerson ? `${person} (${company})` : `${company} (${person})`, QBO_DISPLAY_MAX)
    : null;
  return { displayName, fallbackDisplayName: fallback && fallback !== displayName ? fallback : null, extra };
}
