// ── EVERY FIELD ON A CONTACT AND ON A DESIGN/DEAL ────────────────────────────────────────
// Carolyn 2026-10-22: "We need to show all the current fields for contacts and designs/deals in
// the customer hub tab under its own tab called fields. We need to allow to add as many custom
// fields as desired."
//
// This file is the CATALOGUE of the fields that already exist — the ones backed by a real column.
// It is in code and not in a table on purpose (migration 330's header says why at length): the
// columns are in code, so a list of them that lived in each tenant's data would be a second copy
// that drifts, and adding a column would mean a backfill across every builder.
//
// A builder's OWN fields, and their overrides on these, live in `crm_field_defs`. The Fields tab
// renders this catalogue with any override folded in; `crm_fields_list` does the folding, once,
// server-side, so the browser never has to know the rule.
//
// ⚠️ A FIELD LISTED HERE IS A PROMISE THAT IT EXISTS. The id of a `col` field IS its column name
// on that table, and the portal looks values up by it. Adding an entry for a column that is not
// there shows a builder a field that is permanently empty, with nothing raising anywhere — so add
// the column in the same commit, or do not add the entry.
//
// ⛔ DELIBERATELY NOT LISTED: `id`, `client_id`, `phone_digits`, `email_lower`, `merged_into`,
// `contact_id`, `pipeline_id`, `stage_id`, `status_id`, `created_by`. They are plumbing — a
// primary key, a derived search copy, a foreign key the UI shows as something else (Stage, Status
// and Pipeline are listed below under those names instead). Showing them would answer "what can I
// put on a customer?" with a schema dump.

/** What a field's value is, and so how it is typed in and shown. */
export type CrmFieldType = "text" | "textarea" | "number" | "date" | "select" | "checkbox"
  | "phone" | "url";

export const CRM_FIELD_TYPES: { id: CrmFieldType; label: string; hint: string }[] = [
  { id: "text", label: "Text", hint: "One line — a name, a number plate, anything" },
  { id: "textarea", label: "Long text", hint: "A paragraph" },
  { id: "number", label: "Number", hint: "Digits, with the money and comma settings below" },
  { id: "date", label: "Date", hint: "A day, from a calendar" },
  { id: "select", label: "Drop-down", hint: "One of a list you write" },
  { id: "checkbox", label: "Yes / no", hint: "A tick box" },
  // Carolyn 2026-10-23: "I want to add a few other types of fields. Phone and hyperlink."
  { id: "phone", label: "Phone", hint: "A number your team can tap to call" },
  { id: "url", label: "Hyperlink", hint: "A web address, shown as a link you can click" },
];
export const CRM_FIELD_TYPE_IDS = CRM_FIELD_TYPES.map((t) => t.id);

// ── NUMBERS: MONEY, AND THE COMMA (Carolyn 2026-10-23) ───────────────────────────────────
// "with number one I want the option of currency or no. (Only USD and Canada dollar) and the
// option to add a comma (100,000) or no comma (100000)".
//
// Both are about how the number is SHOWN, never what is stored: the jsonb always holds a plain
// number. A builder who switches a field from US$ to no currency, or turns the comma off, must not
// change what the last person typed — and a field somebody later does arithmetic on (an export, a
// report) must not have to strip a currency symbol back off first.
//
// ⚠️ USD and CAD BOTH print "$", which is the whole reason the code is shown as well ("US$ 1,200",
// "CA$ 1,200"). A bare "$1,200" on a Canadian builder's screen beside a US price is the kind of
// ambiguity that ends in somebody quoting the wrong number. Carolyn asked for exactly these two.
export const CRM_CURRENCIES: { id: string; label: string; prefix: string }[] = [
  { id: "USD", label: "US dollars (US$)", prefix: "US$" },
  { id: "CAD", label: "Canadian dollars (CA$)", prefix: "CA$" },
];
export const CRM_CURRENCY_IDS = CRM_CURRENCIES.map((c) => c.id);
export const currencyPrefix = (id: unknown): string =>
  CRM_CURRENCIES.find((c) => c.id === String(id ?? ""))?.prefix ?? "";

export type CrmEntity = "contact" | "deal";

export type CrmBuiltinField = {
  /** The column (or, for `derived`, the thing it is read out of). Stable — the override key. */
  id: string;
  label: string;
  type: CrmFieldType | "address" | "owner" | "stage" | "status" | "money" | "labels" | "link";
  /** The section heading it sits under in the Fields tab, and the order inside it. */
  group: string;
  /** Can a person type into it anywhere in the portal? false = the system sets it. */
  editable: boolean;
  /** Where the value comes from, when it is not a plain column on the entity's own table. */
  derived?: string;
  /** One line under the name in the Fields tab. */
  note?: string;
  /** false = the label is ours and stays (nothing good comes of renaming "Status"). */
  relabel?: boolean;
  /** false = it cannot be hidden from the card. A contact with no name is not a contact. */
  hideable?: boolean;
  /** Overrides the "who fills it in" chip where neither "you", "the design" nor "the system" is
   *  the honest answer — the Google Maps links, which are BUILT from other fields on the card. */
  who?: string;
};

// ── CONTACT ──────────────────────────────────────────────────────────────────────────────
// The order is the contact editor's own, so the Fields tab reads down the screen the editor
// builds. Group names are the editor's headings where it has one.
export const CRM_CONTACT_BUILTINS: CrmBuiltinField[] = [
  { id: "company", label: "Company", type: "text", group: "Who they are", editable: true },
  { id: "name", label: "Name", type: "text", group: "Who they are", editable: true, hideable: false },
  { id: "email", label: "Email", type: "text", group: "Who they are", editable: true },
  { id: "phone", label: "Phone", type: "text", group: "Who they are", editable: true },
  {
    id: "owner_user_id", label: "Assigned to", type: "owner", group: "Who they are", editable: true,
    note: "The team member who owns this customer — picked from your team, not typed",
  },
  {
    id: "labels", label: "Labels", type: "labels", group: "Who they are", editable: true,
    note: "Tags on the contact",
  },

  {
    id: "street", label: "Street", type: "text", group: "Delivery address", editable: true,
    note: "Where the building goes — the delivery scheduler builds its destination from these four",
  },
  { id: "city", label: "City", type: "text", group: "Delivery address", editable: true },
  { id: "state", label: "State", type: "text", group: "Delivery address", editable: true },
  { id: "zip", label: "ZIP", type: "text", group: "Delivery address", editable: true },
  // THE MAP LINK (Carolyn 2026-10-23): "a baked in google maps field that automatically creates a
  // hyperlink to google maps using the address fields created." Nothing is stored and nothing is
  // typed — it is BUILT from the four fields above it every time the card draws, so it can never
  // disagree with the address and an edited address needs no second save. Absent when there is no
  // address to look up, and hideable like anything else.
  {
    id: "maps_delivery", label: "Map it", type: "link", group: "Delivery address", editable: false,
    derived: "address", who: "Built from the address",
    note: "Opens the delivery address in Google Maps. Nothing to fill in — it follows the four fields above",
    relabel: true,
  },

  { id: "billing_street", label: "Street", type: "text", group: "Mailing / billing address", editable: true },
  { id: "billing_city", label: "City", type: "text", group: "Mailing / billing address", editable: true },
  { id: "billing_state", label: "State", type: "text", group: "Mailing / billing address", editable: true },
  { id: "billing_zip", label: "ZIP", type: "text", group: "Mailing / billing address", editable: true },
  {
    id: "maps_billing", label: "Map it", type: "link", group: "Mailing / billing address", editable: false,
    derived: "address", who: "Built from the address",
    note: "Opens the mailing / billing address in Google Maps",
    relabel: true,
  },

  {
    id: "source", label: "Came from", type: "text", group: "Set by the system", editable: false,
    note: "design, form, phone, manual or import — how this contact first reached you",
    relabel: false,
  },
  { id: "first_seen_at", label: "First seen", type: "date", group: "Set by the system", editable: false },
  { id: "created_at", label: "Created", type: "date", group: "Set by the system", editable: false, relabel: false },
  { id: "updated_at", label: "Last changed", type: "date", group: "Set by the system", editable: false, relabel: false },
  {
    id: "sms_opt_out_at", label: "Texts stopped", type: "date", group: "Set by the system", editable: false,
    note: "When they replied STOP. Set by the carrier's reply, never by hand",
    relabel: false,
  },
];

// ── DESIGN / DEAL ────────────────────────────────────────────────────────────────────────
// One field set, because since migration 303 every design has a card and a card can exist
// without a design. The `derived` entries are the design's — read-only here, because the designer
// and the estimate are what set them.
export const CRM_DEAL_BUILTINS: CrmBuiltinField[] = [
  {
    id: "title", label: "Title", type: "text", group: "The deal", editable: true,
    note: "A card with no design shows this; a design's card shows its style and size instead",
  },
  { id: "value_cents", label: "Deal value", type: "money", group: "The deal", editable: true },
  { id: "expected_close_date", label: "Expected close", type: "date", group: "The deal", editable: true },
  { id: "next_follow_up_at", label: "Next follow-up", type: "date", group: "The deal", editable: true },

  {
    id: "pipeline", label: "Pipeline", type: "link", group: "Where it stands", editable: true,
    derived: "crm_pipelines", note: "Which board the card is on. A deal is in exactly one",
    relabel: false,
  },
  {
    id: "stage", label: "Stage", type: "stage", group: "Where it stands", editable: true,
    derived: "crm_pipeline_stages", note: "Moved by dragging the card, or from the deal panel",
    relabel: false,
  },
  {
    id: "status", label: "Status", type: "status", group: "Where it stands", editable: false,
    derived: "crm_statuses",
    note: "System-driven: an estimate going out, an acceptance, an invoice or a delivery sets it. Nobody sets it by hand",
    relabel: false,
  },
  { id: "lost_reason", label: "Lost reason", type: "text", group: "Where it stands", editable: true },

  {
    id: "short_code", label: "Design", type: "link", group: "The design", editable: false,
    derived: "designs.short_code", note: "The design this card is for, if it has one", relabel: false,
  },
  {
    id: "design_style", label: "Style", type: "text", group: "The design", editable: false,
    derived: "designs.selections.style", note: "From the design — change it in the designer",
  },
  {
    id: "design_size", label: "Size", type: "text", group: "The design", editable: false,
    derived: "designs.selections.size", note: "From the design — change it in the designer",
  },
  {
    id: "design_colour", label: "Colour", type: "text", group: "The design", editable: false,
    derived: "designs.paint_colors", note: "Body and trim, from the design",
  },
  {
    id: "design_total", label: "Total", type: "money", group: "The design", editable: false,
    derived: "designs.total_cents", note: "The estimate's total",
  },

  {
    id: "source", label: "Came from", type: "text", group: "Set by the system", editable: false,
    note: "design, form or manual", relabel: false,
  },
  { id: "stage_entered_at", label: "In this stage since", type: "date", group: "Set by the system", editable: false, relabel: false },
  { id: "won_at", label: "Won", type: "date", group: "Set by the system", editable: false, relabel: false },
  { id: "lost_at", label: "Lost", type: "date", group: "Set by the system", editable: false, relabel: false },
  { id: "created_at", label: "Created", type: "date", group: "Set by the system", editable: false, relabel: false },
  { id: "updated_at", label: "Last changed", type: "date", group: "Set by the system", editable: false, relabel: false },
];

export const CRM_BUILTINS: Record<CrmEntity, CrmBuiltinField[]> = {
  contact: CRM_CONTACT_BUILTINS,
  deal: CRM_DEAL_BUILTINS,
};

/** The entity labels, so the tab and the server cannot disagree on what to call them. */
export const CRM_ENTITY_LABEL: Record<CrmEntity, string> = {
  contact: "Contact",
  deal: "Design / deal",
};

export const isCrmEntity = (v: unknown): v is CrmEntity => v === "contact" || v === "deal";

// ── THE GOOGLE MAPS LINK (Carolyn 2026-10-23) ────────────────────────────────────────────
// Built from the address parts, never stored. `api=1` is Google's documented, versioned search
// URL — the one form they promise not to break — and it is a plain https link, so there is no key
// to leak and nothing to bill. (The designer's `googleMapsApiKey` is for the embedded map; this
// needs none.)
//
// ⚠️ EMPTY MEANS NO LINK, and the test is the STREET, not "any part filled in". A contact with a
// state and nothing else would otherwise get a link to the middle of Missouri, which reads as an
// address we hold and is worse than no link at all. Returns "" and the card draws nothing.
export function mapsUrlFor(
  parts: { street?: unknown; city?: unknown; state?: unknown; zip?: unknown },
): string {
  const street = String(parts.street ?? "").trim();
  if (!street) return "";
  const q = [street, String(parts.city ?? "").trim(), String(parts.state ?? "").trim(), String(parts.zip ?? "").trim()]
    .filter(Boolean).join(", ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}

/** Which address each maps built-in is built from, so the catalogue and the card cannot disagree
 *  about which four columns feed which link. */
export const CRM_MAPS_SOURCES: Record<string, { street: string; city: string; state: string; zip: string }> = {
  maps_delivery: { street: "street", city: "city", state: "state", zip: "zip" },
  maps_billing: { street: "billing_street", city: "billing_city", state: "billing_state", zip: "billing_zip" },
};

export const builtinField = (entity: CrmEntity, id: string): CrmBuiltinField | null =>
  CRM_BUILTINS[entity].find((f) => f.id === id) ?? null;

// ── A CUSTOM FIELD'S KEY ─────────────────────────────────────────────────────────────────
// Minted ONCE from the label, then immutable (330's header: renaming a key orphans every value
// already stored under it, silently, on live data). A label the slug cannot carry at all — all
// punctuation, or another alphabet — falls back to `field`, and the caller's de-duplication puts a
// number on the end. Must match 330's crm_field_defs_key_chk.
export const CRM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,38}$/;

export function crmFieldKey(label: string): string {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 39);
  // A key must START with a letter: "3rd visit" slugs to "3rd_visit", which the CHECK refuses.
  const safe = /^[a-z]/.test(slug) ? slug : ("f_" + slug).slice(0, 39);
  return CRM_FIELD_KEY_RE.test(safe) ? safe : "field";
}

/** `base`, else base_2, base_3 … against the keys already taken. Caps at 39 characters. */
export function crmFieldKeyUnique(base: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (k) => String(k)));
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const suffix = "_" + n;
    const next = base.slice(0, 39 - suffix.length) + suffix;
    if (!used.has(next)) return next;
  }
  return base.slice(0, 32) + "_" + Date.now().toString(36).slice(-6);
}

export const CRM_FIELD_LABEL_MAX = 80;
export const CRM_FIELD_HELP_MAX = 200;
export const CRM_FIELD_CHOICES_MAX = 50;
export const CRM_FIELD_CHOICE_MAX = 80;
/** Per tenant, per entity. Carolyn asked for "as many as desired"; this is the guard rail, not a
 *  product limit — every one of them renders on the contact card and rides in every record read,
 *  and a tenant with a thousand would be reporting a slow portal, not using a feature. */
export const CRM_FIELD_MAX_PER_ENTITY = 100;

// ── A HYPERLINK IS AN ATTACK SURFACE, SO THE SCHEME IS AN ALLOWLIST ──────────────────────
// A `url` field's value lands in an `<a href>` in every team member's browser. `javascript:`,
// `data:` and `vbscript:` hrefs all execute, so "is it a URL?" is the wrong question and
// "is it http or https?" is the right one. Checked HERE, on the way in, AND again in the renderer
// (02-sales.jsx ssCrmHref) — a value stored before a later change, or written by an import, must
// not be trusted by whatever draws it. A bare "example.com" gets https:// put in front, because
// that is what a person means when they type it.
export const CRM_URL_MAX = 500;
export function cleanUrl(raw: unknown): { url: string } | { error: string } {
  const s = String(raw ?? "").trim().slice(0, CRM_URL_MAX);
  if (!s) return { url: "" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s;
  let u: URL;
  try { u = new URL(withScheme); } catch { return { error: "That doesn't look like a web address." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "A link has to start with http:// or https://." };
  }
  if (!u.hostname || u.hostname.indexOf(".") === -1) {
    return { error: "That doesn't look like a web address." };
  }
  return { url: u.toString().slice(0, CRM_URL_MAX) };
}

// ── A PHONE FIELD HOLDS WHAT WAS TYPED ───────────────────────────────────────────────────
// Stored as typed, not normalised to E.164. This is a field a builder invented — "site contact",
// "inspector", "the neighbour with the gate key" — and some of those are extensions, two numbers in
// one box, or a note beside the digits. ⚠️ It is NOT `crm_contacts.phone`: that one IS normalised,
// is the texting and calling identity, and carries a tenant-wide unique index. Nothing here feeds
// the dialler, so there is nothing to gain by refusing what somebody wrote down.
export const CRM_PHONE_MAX = 40;

/** Clean one choice list: trimmed, de-duplicated case-insensitively, blanks dropped, capped. */
export function cleanChoices(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const s = String(c ?? "").trim().slice(0, CRM_FIELD_CHOICE_MAX);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= CRM_FIELD_CHOICES_MAX) break;
  }
  return out;
}

/**
 * Coerce one typed-in value to what its field stores. Returns `undefined` for "no value" — the
 * caller sends JSON null for that, which crm_set_custom stores and every reader treats as empty.
 * Refusals come back as { error }, so the sentence is written once and both halves agree.
 */
export function coerceFieldValue(
  field: { field_type: string; choices?: string[] | null; label: string },
  raw: unknown,
): { value: string | number | boolean | null } | { error: string } {
  const type = String(field.field_type);
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw === "object") return { error: `${field.label} takes a single value.` };

  if (type === "checkbox") return { value: raw === true || raw === "true" || raw === 1 || raw === "1" };
  if (type === "number") {
    const n = Number(String(raw).replace(/,/g, "").trim());
    if (!Number.isFinite(n)) return { error: `${field.label} should be a number.` };
    return { value: n };
  }
  if (type === "date") {
    const s = String(raw).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T12:00:00Z"))) {
      return { error: `${field.label} should be a date.` };
    }
    return { value: s };
  }
  if (type === "select") {
    const s = String(raw).trim();
    const choices = Array.isArray(field.choices) ? field.choices : [];
    // Matched case-insensitively and stored in the CHOICE's own spelling, so a value saved before
    // the builder re-cased a choice still reads back as that choice.
    const hit = choices.find((c) => c.toLowerCase() === s.toLowerCase());
    if (!hit) return { error: `Pick one of the choices for ${field.label}.` };
    return { value: hit };
  }
  if (type === "url") {
    const out = cleanUrl(raw);
    if ("error" in out) return { error: `${field.label}: ${out.error}` };
    return { value: out.url || null };
  }
  // A phone is stored AS TYPED, capped. See CRM_PHONE_MAX for why it is not normalised.
  if (type === "phone") return { value: String(raw).trim().slice(0, CRM_PHONE_MAX) || null };
  // text and textarea. Long text gets room for a paragraph; one line does not need it.
  const cap = type === "textarea" ? 4000 : 500;
  return { value: String(raw).slice(0, cap) };
}
