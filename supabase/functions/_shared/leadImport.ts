// Importing leads from a spreadsheet (migration 381, crm_import_leads): everything between "here is a
// sheet" and "here are the rows the database takes", with no network and no database, so every rule
// runs in leadImport.test.ts.
//
// WHY. Carolyn, 2026-11-06: "We need to have a way to import leads into Structure Studio." Two shapes of
// list, both on day one: her reps' cold-call lists of shed manufacturers (company first, often no person)
// and a builder's customer list exported from GoHighLevel or another CRM (person first). October's
// Sales Pipelines plan (301) already named "CSV import" as a lead source and reserved IMPORT_PAGE_MAX;
// this is that import.
//
// WHO USES THIS FILE.
//   - portal-settings' crm_import_leads uses parseLeadImportRequest: the server half, which never
//     trusts the browser's rows.
//   - The portal's Import dialog (portal/02-sales.jsx, between the ⟦lead-import:start⟧ and
//     ⟦lead-import:end⟧ markers) carries a plain-JS COPY of the browser half: autoMap, planLeadImport,
//     pageRows, sumCounts, importSummary and the reason sentences. The portal has no bundler, so it
//     cannot import this file. _test_stubs/leadImportParity_test.ts runs both copies over the same
//     sheets and fails when one moves alone.
//   - Jack (jack-agent), later: a lead-import card would map a sheet with autoMap/planLeadImport and
//     call the same action. Nothing here needs reshaping for that.
//
// WHAT NEVER LEAVES. A refusal or a warning is a ROW NUMBER and a CODE, never a cell. The sentences in
// LEAD_IMPORT_REASONS name no value, so a refusal list can be shown, logged or audited without carrying
// a name, a number or an address (the GoHighLevel import's rule, 282).
//
// Self-contained on purpose (relative imports only, no jsr:/npm:): preflight runs `_shared/*.test.ts`
// offline.

import { IMPORT_PAGE_MAX, isUuidLike, parseMoneyCents } from "./crmPipelines.ts";
import { phoneKey } from "./phoneKey.ts";

export { IMPORT_PAGE_MAX };

/** The caps 381 applies, so a value is the same whichever side cuts it. */
export const LEAD_CAPS = {
  name: 200, company: 200, phone: 40, email: 320, street: 200, city: 100, state: 100, zip: 20,
  note: 8000, title: 200, label: 60, labels: 25,
} as const;
/** The most rows one file may hold. The server takes IMPORT_PAGE_MAX per call; the dialog pages. */
export const LEAD_IMPORT_MAX_ROWS = 5000;
/** A custom field's key, as crm_field_defs stores it (330). */
const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,38}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** A phone needs this many digits to be worth dialling (parseLead's rule). */
const MIN_PHONE_DIGITS = 7;

export type FieldId =
  | "name" | "first_name" | "last_name" | "company" | "phone" | "email"
  | "street" | "city" | "state" | "zip" | "labels" | "owner" | "note" | "added_at" | "do_not_text"
  | "stage" | "title" | "value" | "expected_close";

/** Where one sheet column goes: a field, a custom field ("custom:contact:<key>"), or nowhere. */
export type Target = FieldId | "skip" | string;

export type CustomDef = { entity: "contact" | "deal"; key: string; label: string };

/** The fields a column can fill, in the order the dialog lists them. */
export const LEAD_IMPORT_FIELDS: { id: FieldId; label: string; group: "Contact" | "Deal" }[] = [
  { id: "name", label: "Full name", group: "Contact" },
  { id: "first_name", label: "First name", group: "Contact" },
  { id: "last_name", label: "Last name", group: "Contact" },
  { id: "company", label: "Company", group: "Contact" },
  { id: "phone", label: "Phone", group: "Contact" },
  { id: "email", label: "Email", group: "Contact" },
  { id: "street", label: "Street address", group: "Contact" },
  { id: "city", label: "City", group: "Contact" },
  { id: "state", label: "State", group: "Contact" },
  { id: "zip", label: "ZIP code", group: "Contact" },
  { id: "labels", label: "Tags", group: "Contact" },
  { id: "owner", label: "Owner (a team member's name)", group: "Contact" },
  { id: "note", label: "Note", group: "Contact" },
  { id: "added_at", label: "Date added", group: "Contact" },
  { id: "do_not_text", label: "Do not text (opted out)", group: "Contact" },
  { id: "stage", label: "Stage", group: "Deal" },
  { id: "title", label: "Deal name", group: "Deal" },
  { id: "value", label: "Deal value", group: "Deal" },
  { id: "expected_close", label: "Expected close date", group: "Deal" },
];

/**
 * Header → field, keyed on normaliseHeader. GoHighLevel's contact and opportunity exports, and the
 * usual CRM exports, land without a touch. "status" is deliberately absent: a card's status is set by
 * the system (crmPipelines.ts STATUS_IS_SYSTEM_SET), so a Status column is skipped, not imported.
 * "skip" entries are columns we know and deliberately leave behind, so the dialog can say so.
 */
export const LEAD_IMPORT_ALIASES: Record<string, FieldId | "skip"> = (() => {
  const t: Record<string, FieldId | "skip"> = {};
  const add = (field: FieldId | "skip", names: string[]) => { for (const n of names) t[n] = field; };
  add("name", ["name", "full name", "fullname", "contact name", "contact", "customer", "customer name", "lead name", "person", "client", "client name"]);
  add("first_name", ["first name", "firstname", "first", "given name", "fname"]);
  add("last_name", ["last name", "lastname", "last", "surname", "family name", "lname"]);
  add("company", ["company", "company name", "business", "business name", "organization", "organisation", "organization name", "account", "account name", "manufacturer", "dealer", "dealership"]);
  add("phone", ["phone", "phone number", "phone no", "mobile", "mobile phone", "mobile number", "cell", "cell phone", "telephone", "tel", "primary phone", "phone 1", "phone1", "work phone", "contact phone", "business phone"]);
  add("email", ["email", "e mail", "email address", "e mail address", "primary email", "contact email", "work email", "business email", "email 1", "email1"]);
  add("street", ["street", "address", "address 1", "address1", "address line 1", "street address", "mailing address", "street 1"]);
  add("city", ["city", "town"]);
  add("state", ["state", "province", "state province", "region", "state region"]);
  add("zip", ["zip", "zip code", "zipcode", "postal code", "postalcode", "postcode", "post code", "postal"]);
  add("labels", ["tags", "tag", "labels", "label", "categories", "category", "segments", "segment"]);
  add("owner", ["owner", "assigned to", "assigned", "assigned user", "assignee", "sales rep", "rep", "salesperson", "account owner", "contact owner", "lead owner"]);
  add("note", ["notes", "note", "comments", "comment", "description", "remarks"]);
  add("added_at", ["created", "created at", "created on", "date added", "date created", "added", "added on", "created date"]);
  add("do_not_text", ["dnd", "do not disturb", "sms opt out", "opted out", "do not text", "sms dnd", "unsubscribed"]);
  add("stage", ["stage", "pipeline stage", "stage name", "deal stage", "opportunity stage"]);
  add("title", ["deal", "deal name", "deal title", "opportunity", "opportunity name", "opportunity title"]);
  add("value", ["value", "deal value", "amount", "opportunity value", "monetary value", "lead value", "estimated value", "deal amount"]);
  add("expected_close", ["expected close", "expected close date", "close date", "closing date", "expected closing date", "est close date"]);
  add("skip", [
    "contact id", "id", "record id", "opportunity id", "country", "website", "url", "source", "lead source", "type",
    "status", "opportunity status", "pipeline", "pipeline name", "last activity", "last activity date", "updated",
    "updated at", "date updated", "additional emails", "additional phones", "date of birth", "dob", "birthday",
    "timezone", "time zone",
  ]);
  return t;
})();

/** "Phone Number:" and "phone_number" are the same header. */
export function normaliseHeader(h: unknown): string {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Where one header goes. Our own fields first; then a custom field whose label or key the header is
 * (a contact field wins a tie with a deal one); then a known column we leave behind; then nothing.
 * A custom field labelled like a skipped column ("Source") takes that column: the builder made it.
 */
export function detectHeaderField(header: unknown, customDefs: CustomDef[] = []): Target {
  const n = normaliseHeader(header);
  if (!n) return "skip";
  const ours = LEAD_IMPORT_ALIASES[n];
  if (ours && ours !== "skip") return ours;
  for (const entity of ["contact", "deal"] as const) {
    const hit = customDefs.find((d) => d.entity === entity &&
      (normaliseHeader(d.label) === n || normaliseHeader(d.key) === n));
    if (hit) return `custom:${entity}:${hit.key}`;
  }
  return "skip";
}

/** One target per sheet column. A field claimed by an earlier column leaves the later one skipped. */
export function autoMap(headers: unknown[], customDefs: CustomDef[] = []): Target[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const t = detectHeaderField(h, customDefs);
    if (t === "skip" || used.has(t)) return "skip";
    used.add(t);
    return t;
  });
}

/** Why a mapping cannot be imported, or null when it can. */
export function mappingRefusal(mapping: Target[]): string | null {
  const has = (f: string) => mapping.includes(f);
  const named = has("name") || has("first_name") || has("last_name") || has("company");
  const reachable = has("phone") || has("email");
  if (!named && !reachable) return "Pick which column holds the name or the company, and which holds the phone or the email.";
  if (!named) return "Pick which column holds the name or the company.";
  if (!reachable) return "Pick which column holds the phone or the email, so the people you import can be reached.";
  const dup = mapping.filter((t) => t !== "skip").find((t, i, a) => a.indexOf(t) !== i);
  if (dup) return "Two columns are going to the same field. Pick a different field for one of them, or Skip it.";
  return null;
}

// ── A sheet → the rows the database takes ───────────────────────────────────────────────────────

/** One row as crm_import_leads (381) takes it. Every key but `row` is optional. */
export type LeadRow = {
  row: number;
  name?: string; company?: string; phone?: string; email?: string;
  street?: string; city?: string; state?: string; zip?: string;
  labels?: string[]; owner?: string; note?: string; added_at?: string; do_not_text?: boolean;
  stage?: string; title?: string; value_cents?: number; expected_close_date?: string;
  contact_custom?: Record<string, string>; deal_custom?: Record<string, string>;
};

/** A row the import leaves out (refused) or changes (warning): a line number and a code, never a cell. */
export type LeadIssue = { row: number; code: string; into?: number };

export type PlanContext = {
  /** The chosen pipeline's live stages, or null for a contacts-only import (no deals at all). */
  stages: { id: string; name: string }[] | null;
  team: { userId: string; name: string | null }[];
  /** Someone limited to their own customers owns everything they import; an owner column is ignored. */
  ownOnly: boolean;
  customDefs?: CustomDef[];
};

export type LeadPlan = {
  rows: LeadRow[];
  refused: LeadIssue[];
  warnings: LeadIssue[];
  /** The sheet line the headers were read from (1-based). */
  headerRow: number;
  /** Lines below the header that held anything. */
  dataRows: number;
};

const cut = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cutKeepLines = (v: unknown, max: number): string => String(v ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const nameKey = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Tags from one cell: split on , or ;, trimmed, case-insensitively unique, capped like 282. */
export function splitLabels(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(v ?? "").split(/[,;]/)) {
    const s = cut(part, LEAD_CAPS.label);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= LEAD_CAPS.labels) break;
  }
  return out;
}

const pad2 = (n: number) => (n < 10 ? "0" : "") + n;
function realDay(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * A spreadsheet date as yyyy-mm-dd, or null. Takes 2026-11-10, 2026-11-10T…, 11/10/2026 and 11/10/26
 * (month first: these are US lists). Excel date cells reach here as yyyy-mm-dd already (the dialog
 * reads them as the calendar day, not a local time that could fall on the day before).
 */
export function parseSheetDay(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) return realDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:$|\s)/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return realDay(y, Number(m[1]), Number(m[2]));
  }
  return null;
}

/** "yes", "true", "x", "1", "dnd", "opted out" … tick a do-not-text box; anything else leaves it alone. */
export function truthyCell(v: unknown): boolean {
  return /^(y|yes|true|t|x|1|on|dnd|opted out|opt out|opted-out|unsubscribed)$/i.test(String(v ?? "").trim());
}

/** The line a sheet's headers are on: its first line that holds anything (0-based), or -1. */
export function headerIndex(matrix: unknown[][]): number {
  return matrix.findIndex((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
}

const FILL_KEYS = [
  "name", "company", "phone", "email", "street", "city", "state", "zip", "owner", "note",
  "added_at", "stage", "title", "value_cents", "expected_close_date",
] as const;

/**
 * Turn a sheet into rows, refusals and warnings. `matrix` keeps its blank lines (parseCSVRows,
 * readXlsxWorkbook), so a row's number is its line in the file.
 *
 * Rules, in the order they apply to a line:
 *   - A blank line is no row at all.
 *   - Name: the Full name column, else First + Last. A company with no person is a fine lead.
 *   - A phone with fewer than 7 digits, or an email that isn't one, is left off with a warning when the
 *     row has the other one, and refuses the row when it was its only way to reach them.
 *   - No name and no company: refused (no_name), unless the line repeats an earlier row's phone or
 *     email (then it joins that row, below). No phone and no email: refused (no_identity).
 *   - A value that isn't an amount, or a date we can't read, is left off with a warning.
 *   - A stage or owner name that isn't exactly one of yours is treated as blank, with a warning: the
 *     row still comes in, on the default stage and owner the dialog picked.
 *   - The same person twice (a phone key, then an email, seen on an earlier row) is ONE row: the later
 *     one fills the earlier one's blanks and adds its tags (repeat_in_file). Unless it also carries a
 *     DIFFERENT phone or email: then it stays its own row, and the database adds that second number or
 *     address to the same contact (repeat_other_channel). Merging here keeps a dry run exact across
 *     pages, because page 2 can never match a contact page 1 would have created.
 */
export function planLeadImport(matrix: unknown[][], mapping: Target[], ctx: PlanContext): LeadPlan {
  const rows: LeadRow[] = [];
  const refused: LeadIssue[] = [];
  const warnings: LeadIssue[] = [];
  const h = headerIndex(matrix);
  if (h < 0) return { rows, refused, warnings, headerRow: 0, dataRows: 0 };

  const col = (f: string) => mapping.indexOf(f);
  const C: Record<string, number> = {};
  for (const f of LEAD_IMPORT_FIELDS) C[f.id] = col(f.id);
  const customCols: { i: number; entity: "contact" | "deal"; key: string }[] = [];
  mapping.forEach((t, i) => {
    const m = /^custom:(contact|deal):(.+)$/.exec(String(t));
    if (m && CUSTOM_KEY.test(m[2])) customCols.push({ i, entity: m[1] as "contact" | "deal", key: m[2] });
  });

  const withDeals = Array.isArray(ctx.stages);
  const stageByName = new Map<string, string | null>();
  for (const s of ctx.stages ?? []) {
    const k = nameKey(s.name);
    stageByName.set(k, stageByName.has(k) ? null : String(s.id).toLowerCase());
  }
  const ownerByName = new Map<string, string | null>();
  for (const m of ctx.team ?? []) {
    const k = nameKey(m.name);
    if (!k) continue;
    ownerByName.set(k, ownerByName.has(k) ? null : String(m.userId).toLowerCase());
  }

  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();
  let dataRows = 0;

  for (let li = h + 1; li < matrix.length; li++) {
    const line = Array.isArray(matrix[li]) ? matrix[li] : [];
    if (!line.some((c) => String(c ?? "").trim() !== "")) continue;
    dataRows++;
    const rowNo = li + 1;
    const cell = (f: string) => (C[f] >= 0 ? line[C[f]] : undefined);
    const r: LeadRow = { row: rowNo };
    const warn = (code: string) => warnings.push({ row: rowNo, code });

    const full = cut(cell("name"), LEAD_CAPS.name);
    const joined = cut([cut(cell("first_name"), 100), cut(cell("last_name"), 100)].filter(Boolean).join(" "), LEAD_CAPS.name);
    const name = full || joined;
    if (name) r.name = name;
    const company = cut(cell("company"), LEAD_CAPS.company);
    if (company) r.company = company;

    const rawPhone = cut(cell("phone"), LEAD_CAPS.phone);
    const rawEmail = cut(cell("email"), LEAD_CAPS.email);
    const phoneOk = !!rawPhone && rawPhone.replace(/\D/g, "").length >= MIN_PHONE_DIGITS;
    const emailOk = !!rawEmail && EMAIL.test(rawEmail);
    // A nameless line that shares a phone or email with an earlier row is more about that person,
    // not a lead of its own, so it is only refused for having no name when it matches nobody above.
    const seenAbove = (phoneOk && byPhone.has(phoneKey(rawPhone))) || (emailOk && byEmail.has(rawEmail.toLowerCase()));
    if (!r.name && !r.company && !seenAbove) { refused.push({ row: rowNo, code: "no_name" }); continue; }
    if (!phoneOk && !emailOk) {
      refused.push({ row: rowNo, code: rawPhone && rawEmail ? "bad_both" : rawPhone ? "bad_phone" : rawEmail ? "bad_email" : "no_identity" });
      continue;
    }
    if (phoneOk) r.phone = rawPhone; else if (rawPhone) warn("phone_dropped");
    if (emailOk) r.email = rawEmail; else if (rawEmail) warn("email_dropped");

    for (const f of ["street", "city", "state", "zip"] as const) {
      const v = cut(cell(f), LEAD_CAPS[f]);
      if (v) r[f] = v;
    }
    const labels = splitLabels(cell("labels"));
    if (labels.length) r.labels = labels;
    const note = cutKeepLines(cell("note"), LEAD_CAPS.note);
    if (note) r.note = note;
    if (C.added_at >= 0 && cut(cell("added_at"), 60)) {
      const d = parseSheetDay(cell("added_at"));
      if (d) r.added_at = d; else warn("date_dropped");
    }
    if (truthyCell(cell("do_not_text"))) r.do_not_text = true;

    if (!ctx.ownOnly && C.owner >= 0) {
      const o = nameKey(cell("owner"));
      if (o) {
        const id = ownerByName.get(o);
        if (id) r.owner = id; else warn("owner_unknown");
      }
    }

    if (withDeals) {
      const st = nameKey(cell("stage"));
      if (st) {
        const id = stageByName.get(st);
        if (id) r.stage = id; else warn("stage_unknown");
      }
      const title = cut(cell("title"), LEAD_CAPS.title);
      if (title) r.title = title;
      const rawValue = cut(cell("value"), 40);
      if (rawValue) {
        const cents = parseMoneyCents(rawValue);
        if (typeof cents === "number") r.value_cents = cents; else warn("value_dropped");
      }
      if (C.expected_close >= 0 && cut(cell("expected_close"), 60)) {
        const d = parseSheetDay(cell("expected_close"));
        if (d) r.expected_close_date = d; else warn("date_dropped");
      }
    }

    for (const cc of customCols) {
      if (cc.entity === "deal" && !withDeals) continue;
      const v = cutKeepLines(line[cc.i], 4000);
      if (!v) continue;
      const bag = cc.entity === "contact" ? (r.contact_custom ??= {}) : (r.deal_custom ??= {});
      bag[cc.key] = v;
    }

    // The same person, earlier in the file?
    const pk = r.phone ? phoneKey(r.phone) : "";
    const ek = r.email ? r.email.toLowerCase() : "";
    const at = (pk && byPhone.has(pk)) ? byPhone.get(pk)! : (ek && byEmail.has(ek)) ? byEmail.get(ek)! : -1;
    if (at >= 0) {
      const first = rows[at];
      const fpk = first.phone ? phoneKey(first.phone) : "";
      const fek = first.email ? first.email.toLowerCase() : "";
      const differs = (pk && fpk && pk !== fpk) || (ek && fek && ek !== fek);
      if (differs) {
        warnings.push({ row: rowNo, code: "repeat_other_channel", into: first.row });
        rows.push(r);
        if (pk && !byPhone.has(pk)) byPhone.set(pk, rows.length - 1);
        if (ek && !byEmail.has(ek)) byEmail.set(ek, rows.length - 1);
        continue;
      }
      mergeInto(first, r);
      warnings.push({ row: rowNo, code: "repeat_in_file", into: first.row });
      if (pk) byPhone.set(pk, at);
      if (ek) byEmail.set(ek, at);
      continue;
    }
    rows.push(r);
    if (pk) byPhone.set(pk, rows.length - 1);
    if (ek) byEmail.set(ek, rows.length - 1);
  }
  return { rows, refused, warnings, headerRow: h + 1, dataRows };
}

/** A later row of the same person fills the first row's blanks; tags add up; a tick stays ticked. */
function mergeInto(first: LeadRow, later: LeadRow): void {
  const f = first as Record<string, unknown>;
  const l = later as Record<string, unknown>;
  for (const k of FILL_KEYS) if ((f[k] === undefined || f[k] === "") && l[k] !== undefined) f[k] = l[k];
  if (later.labels?.length) {
    const have = new Set((first.labels ?? []).map((x) => x.toLowerCase()));
    const out = [...(first.labels ?? [])];
    for (const x of later.labels) {
      if (out.length >= LEAD_CAPS.labels) break;
      if (!have.has(x.toLowerCase())) { have.add(x.toLowerCase()); out.push(x); }
    }
    first.labels = out;
  }
  if (later.do_not_text) first.do_not_text = true;
  for (const bag of ["contact_custom", "deal_custom"] as const) {
    const lb = later[bag];
    if (!lb) continue;
    const fb = (first[bag] ??= {});
    for (const [k, v] of Object.entries(lb)) if (fb[k] === undefined) fb[k] = v;
  }
}

/** Rows in pages the server takes, in file order. */
export function pageRows<T>(rows: T[], size: number = IMPORT_PAGE_MAX): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

// ── What an import did ──────────────────────────────────────────────────────────────────────────

/** The numbers crm_import_leads answers (381), one page or summed. */
export const LEAD_COUNT_KEYS = [
  "rows", "contacts_created", "contacts_matched", "matched_skipped", "deals_created", "already_in_pipeline",
  "not_yours", "no_identity", "no_name", "conflicts", "notes_added", "labelled", "people_added", "opted_out",
] as const;
export type LeadCounts = Record<typeof LEAD_COUNT_KEYS[number], number> & { refused: LeadIssue[]; warnings: LeadIssue[] };

export function zeroCounts(): LeadCounts {
  const c = { refused: [], warnings: [] } as unknown as LeadCounts;
  for (const k of LEAD_COUNT_KEYS) c[k] = 0;
  return c;
}

/** Pages' answers added up. A missing or non-numeric count is 0; refusals and warnings are kept in order. */
export function sumCounts(pages: unknown[]): LeadCounts {
  const out = zeroCounts();
  for (const p of pages) {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    for (const k of LEAD_COUNT_KEYS) {
      const n = Number(o[k]);
      if (Number.isFinite(n)) out[k] += n;
    }
    for (const list of ["refused", "warnings"] as const) {
      const arr = Array.isArray(o[list]) ? o[list] as unknown[] : [];
      for (const it of arr) {
        const i = (it ?? {}) as Record<string, unknown>;
        const row = Number(i.row);
        if (Number.isInteger(row) && typeof i.code === "string") out[list].push({ row, code: i.code });
      }
    }
  }
  return out;
}

/** What each code means, in words a builder reads. No sentence names a value from the sheet. */
export const LEAD_IMPORT_REASONS: Record<string, string> = {
  no_name: "It has no name and no company.",
  no_identity: "It has no phone number or email, so nobody could reach them.",
  bad_phone: "Its phone number is too short to dial, and it has no email.",
  bad_email: "Its email isn't an email address, and it has no phone number.",
  bad_both: "Its phone number is too short to dial and its email isn't an email address.",
  phone_dropped: "Its phone number is too short to dial, so it was left off.",
  email_dropped: "Its email isn't an email address, so it was left off.",
  value_dropped: "Its deal value isn't an amount, so it was left off.",
  date_dropped: "A date on it isn't one we can read, so it was left off.",
  stage_unknown: "Its stage isn't one of this pipeline's stages, so it gets the default stage.",
  owner_unknown: "Its owner isn't exactly one person on your team, so it gets the default owner.",
  repeat_in_file: "It's the same person as an earlier row, so the two were combined.",
  repeat_other_channel: "It shares a phone or email with an earlier row but has another one too, so that one is added to the same contact.",
  custom_dropped: "One of its custom field values doesn't fit that field, so it was left off.",
  stage_missing: "Its stage was removed after the preview. Run the file again.",
  not_yours: "They're already a contact you aren't assigned to, so they were left alone.",
  conflict: "Another contact took that phone number or email at the same moment. Run the file again.",
};

export function reasonFor(code: string): string {
  return LEAD_IMPORT_REASONS[code] ?? "It couldn't be imported.";
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * One paragraph about an import, numbers only. `refusedInFile` is the rows the dialog left out before
 * anything was sent; the server's own refusals ride in `c.refused`.
 */
export function importSummary(
  c: LeadCounts,
  o: { dryRun: boolean; withDeals: boolean; onMatch: "attach" | "skip"; refusedInFile?: number },
): string {
  const out: string[] = [];
  const created = c.contacts_created;
  const matched = c.contacts_matched + c.matched_skipped;
  const left = (o.refusedInFile ?? 0) + c.refused.length;
  if (o.dryRun) {
    out.push("Nothing has been saved yet.");
    out.push(`This file would add ${plural(created, "new contact", "new contacts")}.`);
    if (matched) {
      out.push(`${plural(matched, "person is", "people are")} already in Contacts${o.onMatch === "skip" ? " and would be left as they are" : ", and their blank details would be filled in"}.`);
    }
    if (o.withDeals) {
      out.push(`${plural(c.deals_created, "deal", "deals")} would go on the pipeline${c.already_in_pipeline ? `; ${plural(c.already_in_pipeline, "person is", "people are")} already on it` : ""}.`);
    }
    if (left) out.push(`${plural(left, "row", "rows")} can't be imported.`);
  } else {
    out.push(`Done. ${plural(created, "new contact was", "new contacts were")} added.`);
    if (matched) {
      out.push(`${plural(matched, "person was", "people were")} already in Contacts${o.onMatch === "skip" ? " and left as they were" : ", and their blank details were filled in"}.`);
    }
    if (o.withDeals) {
      out.push(`${plural(c.deals_created, "deal was", "deals were")} added to the pipeline${c.already_in_pipeline ? `; ${plural(c.already_in_pipeline, "person was", "people were")} already on it` : ""}.`);
    }
    if (left) out.push(`${plural(left, "row wasn't", "rows weren't")} imported.`);
  }
  return out.join(" ");
}

// ── The server half: the request portal-settings takes ──────────────────────────────────────────

export type LeadImportRequest = {
  ok: true;
  dryRun: boolean;
  pipelineId: string | null;
  defaultStageId: string | null;
  onMatch: "attach" | "skip";
  defaultOwnerUserId: string | null;
  rows: LeadRow[];
  page: number | null;
  pages: number | null;
};

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim().slice(0, max);
  return s || undefined;
};
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const day = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const d = parseSheetDay(v);
  return d && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? d : undefined;
};

function cleanCustom(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (!CUSTOM_KEY.test(k)) continue;
    if (typeof x === "string") out[k] = x.slice(0, 4000);
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
    else if (typeof x === "boolean") out[k] = x;
    else continue;
    if (++n >= 100) break;
  }
  return n ? out : undefined;
}

/** One row from the browser (or a future Jack card), cleaned. Unknown keys and bad shapes are dropped. */
export function cleanLeadRow(v: Record<string, unknown>): LeadRow {
  const r: LeadRow = { row: Number(v.row) };
  const s = (k: keyof typeof LEAD_CAPS, from: string = k) => { const x = str(v[from], LEAD_CAPS[k]); if (x) (r as Record<string, unknown>)[from] = x; };
  s("name"); s("company"); s("phone"); s("email"); s("street"); s("city"); s("state"); s("zip"); s("title");
  if (typeof v.note === "string") { const x = cutKeepLines(v.note, LEAD_CAPS.note); if (x) r.note = x; }
  if (Array.isArray(v.labels)) { const l = splitLabels(v.labels.filter((x) => typeof x === "string").join(",")); if (l.length) r.labels = l; }
  if (isUuidLike(v.owner)) r.owner = String(v.owner).toLowerCase();
  if (isUuidLike(v.stage)) r.stage = String(v.stage).toLowerCase();
  if (typeof v.value_cents === "number" && Number.isSafeInteger(v.value_cents) && v.value_cents >= 0) r.value_cents = v.value_cents;
  const close = day(v.expected_close_date); if (close) r.expected_close_date = close;
  const added = day(v.added_at); if (added) r.added_at = added;
  if (v.do_not_text === true) r.do_not_text = true;
  const cc = cleanCustom(v.contact_custom); if (cc) r.contact_custom = cc as Record<string, string>;
  const dc = cleanCustom(v.deal_custom); if (dc) r.deal_custom = dc as Record<string, string>;
  return r;
}

/** The crm_import_leads request. A dry run unless the request says `dryRun: false`. */
export function parseLeadImportRequest(p: Record<string, unknown>): LeadImportRequest | { ok: false; error: string } {
  const pipelineRaw = p.pipelineId ?? null;
  if (pipelineRaw !== null && pipelineRaw !== "" && !isUuidLike(pipelineRaw)) return { ok: false, error: "Pick the pipeline from the list." };
  const pipelineId = isUuidLike(pipelineRaw) ? pipelineRaw.toLowerCase() : null;
  const stageRaw = p.defaultStageId ?? null;
  if (stageRaw !== null && stageRaw !== "" && !isUuidLike(stageRaw)) return { ok: false, error: "Pick the stage from the list." };
  const defaultStageId = isUuidLike(stageRaw) ? stageRaw.toLowerCase() : null;
  if (defaultStageId && !pipelineId) return { ok: false, error: "Pick the pipeline that stage belongs to." };
  const ownerRaw = p.defaultOwnerUserId ?? null;
  if (ownerRaw !== null && ownerRaw !== "" && !isUuidLike(ownerRaw)) return { ok: false, error: "Pick the owner from the list — that isn't a team member." };
  const defaultOwnerUserId = isUuidLike(ownerRaw) ? ownerRaw.toLowerCase() : null;
  const onMatchRaw = p.onMatch ?? "attach";
  if (onMatchRaw !== "attach" && onMatchRaw !== "skip") return { ok: false, error: "Choose what happens when someone is already in Contacts." };

  if (!Array.isArray(p.rows) || !p.rows.length) return { ok: false, error: "There are no rows to import." };
  if (p.rows.length > IMPORT_PAGE_MAX) return { ok: false, error: `Send at most ${IMPORT_PAGE_MAX} rows at a time.` };
  const rows: LeadRow[] = [];
  for (const raw of p.rows) {
    if (!isPlainObject(raw)) return { ok: false, error: "Each row has to be a set of fields." };
    const n = Number(raw.row);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return { ok: false, error: "Each row needs the line number it came from." };
    rows.push(cleanLeadRow(raw));
  }
  const int = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 10_000 ? Number(v) : null);
  return {
    ok: true,
    dryRun: p.dryRun !== false,
    pipelineId, defaultStageId, defaultOwnerUserId,
    onMatch: onMatchRaw,
    rows,
    page: int(p.page),
    pages: int(p.pages),
  };
}
