// Tax codes: which Avalara tax code each thing a builder sells falls under (migration 246,
// 2026-09-17). The pure half — the headings a builder maps, the starter codes, payload parsing,
// the search pattern, the save plan and the mapping of Avalara's ListTaxCodes rows. The database
// stays in portal-settings (tax_codes_get / tax_codes_search / tax_codes_save) and the network in
// taxCodeSync.ts.
//
// WHAT THIS BUILD IS, AND IS NOT. The owner's ask (2026-09-14): every product, installation and
// delivery gets a code, and "letting every company code their own" so nobody comes back saying
// the code is wrong. This stores that mapping and nothing else. NO QUOTE'S TAX READS IT: the
// rate is still one rate over one taxable base (salesTax.ts, taxChain.ts), and per-line tax by
// code is a later stage. Anything a builder reads says the codes are saved for that stage, never
// that they change today's tax.
//
// ONE CODE PER THING. A target is a building style (by id) or an option heading (by key), and
// tax_code_assignments' primary key is (client_id, target_type, target_key), so a second code
// for the same target cannot be stored. The save refuses a payload that names a target twice
// rather than picking one, because picking would silently drop what the builder chose.
//
// THE HEADING KEYS LIVE HERE ONLY. The table stores them as text with a shape CHECK, not a list:
// qbo_item_map keeps its line kinds in three places (SQL CHECK, server set, portal array) and one
// of the three drifted, so every save for seven kinds was skipped. The portal gets the list from
// tax_codes_get, the server validates against TAX_HEADINGS, and the database only checks shape.
//
// Deliberately import-free, so its tests run offline with no import map.
//
// ⚠️ Bundled per function like every _shared module: a change here means redeploying every
// importer. Derive them, do not trust a list (CLAUDE.md, importer audits):
//     find supabase/functions -name '*.ts' ! -name '*.test.ts' ! -path '*_test_stubs*' -print0 \
//       | xargs -0 -I{} perl -0777 -ne 'print "$ARGV\n" if m{import[^;]*?from\s+"[^"]*taxCodes\.ts"}s' {}

/** Settings → Options groups its tabs this way (portal/01-core.jsx ssOptionTabs), so a builder
 *  finds each heading under the name they already know it by. `building` is "Building options":
 *  the buildings themselves are mapped per style, not as a heading. */
export type TaxHeadingGroup = "building" | "exterior" | "interior" | "other" | "services" | "delivery";

export const TAX_HEADING_GROUPS: { key: TaxHeadingGroup; label: string }[] = [
  { key: "building", label: "Building options" },
  { key: "exterior", label: "Exterior" },
  { key: "interior", label: "Interior" },
  { key: "other", label: "Other" },
  { key: "services", label: "Services" },
  { key: "delivery", label: "Delivery" },
];

/**
 * Which estimate lines a heading WILL cover once per-line tax exists. Documentation for that
 * stage, kept beside the headings so the two cannot be written apart: NOTHING READS THIS AT
 * RUNTIME IN THIS BUILD. Kinds and itemKeys are the ones submit-estimate's tagLine emits today
 * (estimateLines.ts adds the invoice-only kinds). Headings do not map 1:1 to kinds, which is why
 * this is more than a kind list.
 */
export interface LineMatch {
  /** Line kinds the heading covers. */
  kinds: string[];
  /** layout_item lines, by itemKey. */
  layoutItems?: string[];
  /** Only lines whose fixture is of this category (fixture_items.category). */
  fixtureCategory?: string;
  /** What the calculation stage still has to do before the match is exact. */
  note?: string;
}

export interface TaxHeading {
  key: string;
  label: string;
  group: TaxHeadingGroup;
  lineMatch: LineMatch;
}

export const TAX_HEADINGS: readonly TaxHeading[] = [
  // ── Building options ──
  { key: "wall_heights", label: "Wall heights", group: "building", lineMatch: { kinds: ["wall_height"] } },
  { key: "colors", label: "Paint & roof colours", group: "building", lineMatch: { kinds: ["paint", "roof"] } },
  // ── Exterior ──
  {
    key: "doors", label: "Doors", group: "exterior",
    lineMatch: { kinds: ["door"], layoutItems: ["singleDoor", "doubleDoor", "roughOpeningDoor"] },
  },
  {
    key: "windows", label: "Windows", group: "exterior",
    lineMatch: {
      kinds: ["window"], layoutItems: ["window", "shutters", "flowerBox", "roughOpeningWindow"], fixtureCategory: "window",
      note: "kind window also carries vents today; only lines whose fixture is a window belong here",
    },
  },
  {
    key: "vents", label: "Vents", group: "exterior",
    lineMatch: {
      kinds: ["window"], fixtureCategory: "vent",
      note: "a placed vent is a window item carrying isVent and prices as kind window; the calculation stage must tag vent lines before this heading can match them",
    },
  },
  { key: "ramps", label: "Ramps", group: "exterior", lineMatch: { kinds: ["ramp"], layoutItems: ["ramp"] } },
  { key: "cladding", label: "Cladding", group: "exterior", lineMatch: { kinds: ["cladding"] } },
  // ── Interior ──
  {
    key: "interior_items", label: "Interior items (lofts, shelves, workbenches)", group: "interior",
    lineMatch: { kinds: [], layoutItems: ["loft", "shelf", "doubleShelf", "workbench"] },
  },
  { key: "electrical", label: "Electrical", group: "interior", lineMatch: { kinds: ["electrical", "electrical_item"] } },
  { key: "insulation", label: "Insulation", group: "interior", lineMatch: { kinds: ["insulation"] } },
  // ── Other ──
  { key: "custom_options", label: "Custom options", group: "other", lineMatch: { kinds: ["custom_option"] } },
  // ── Services ──
  { key: "build_on_site", label: "Built-on-site fee", group: "services", lineMatch: { kinds: ["build_on_site"] } },
  { key: "foundation", label: "Foundation & site work", group: "services", lineMatch: { kinds: ["foundation"] } },
  {
    key: "change_order_fee", label: "Change order fee", group: "services",
    lineMatch: { kinds: ["change_order_fee"], note: "exists only on the amended invoice document, never in estimate_lines" },
  },
  // ── Delivery ──
  { key: "delivery", label: "Delivery", group: "delivery", lineMatch: { kinds: ["delivery"] } },
];

/** Lines no heading covers, and why — so the calculation stage starts from a complete list
 *  rather than discovering the gaps on a quote. Documentation, like lineMatch. */
export const UNMATCHED_LINES: readonly { kind: string; itemKey?: string; why: string }[] = [
  { kind: "building", why: "mapped per building style (target_type 'style'), not by heading" },
  { kind: "discount", why: "skipped from estimate_lines; it reduces a pool rather than being a sale" },
  { kind: "change_order", why: "an amended-invoice line whose parts are already coded under their own headings" },
  { kind: "adjustment", why: "an amended-invoice correction, not a thing sold" },
  { kind: "fallback", why: "a line no site tagged; it has no heading by definition" },
  { kind: "layout_item", itemKey: "roughOpening", why: "a generic rough opening is neither a door nor a window; decide with the calculation stage" },
];

const HEADING_KEYS = new Set(TAX_HEADINGS.map((h) => h.key));

/** The headings as tax_codes_get sends them: lineMatch stays on the server. */
export function headingsView(): { key: string; label: string; group: TaxHeadingGroup }[] {
  return TAX_HEADINGS.map(({ key, label, group }) => ({ key, label, group }));
}

/**
 * The starter codes, in the order migration 246 seeds them and the picker lists them. Each hint
 * is a plain-English SUGGESTION of where the code is commonly used — never advice. Which code is
 * right depends on how and where the builder files (a delivered building is personal property in
 * one state and a real-property improvement in another; whether title passes before or after
 * delivery depends on the sales contract), so the builder or their accountant chooses.
 */
export const COMMON_CODES: readonly { code: string; hint: string }[] = [
  { code: "P0000000", hint: "General goods — the usual choice for a building sold as a finished product" },
  { code: "NT", hint: "Not taxed (goods)" },
  { code: "ON030000", hint: "Not taxed (fees and services)" },
  { code: "SI020100", hint: "Installation that comes with the item you sold, shown separately on the bill" },
  { code: "SI020200", hint: "Installation labor only, for an item you did not sell" },
  { code: "SC150100", hint: "Construction work on real property (new construction)" },
  { code: "FR010000", hint: "Delivery on your own truck" },
  { code: "FR010100", hint: "Delivery on your own truck, when the building becomes the customer's at delivery" },
  { code: "FR010200", hint: "Delivery on your own truck, when the building is already the customer's before it leaves" },
  { code: "FR020100", hint: "Shipping by a freight carrier, when the goods become the customer's at delivery" },
  { code: "FR030000", hint: "Shipping and handling charged together" },
  { code: "OH010000", hint: "Handling charged separately from shipping" },
];

const HINTS = new Map(COMMON_CODES.map((c) => [c.code, c.hint]));

/** Avalara's taxCode is a string of up to 25 characters; the system codes are uppercase letters
 *  and digits. The same pattern is migration 246's CHECK on avalara_tax_codes.code. */
const CODE_SHAPE = /^[A-Z0-9]{1,25}$/;

/** A typed or stored code in its one comparable form, or null when it cannot be a code. */
export function normalizeTaxCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return CODE_SHAPE.test(s) ? s : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TargetType = "style" | "heading";
export interface Target { type: TargetType; key: string }
export interface AssignmentRow { code: string; targets: Target[] }

export type AssignmentsRefusal = { ok: false; status: number; reason: string; error: string };
export type ParsedAssignments = { ok: true; rows: AssignmentRow[] } | AssignmentsRefusal;

/** Bounds on one save. A builder has a handful of codes and a few dozen targets (every style
 *  plus fifteen headings); these stop a runaway payload, not a real mapping. */
export const MAX_ASSIGNMENT_ROWS = 50;
export const MAX_ASSIGNMENT_TARGETS = 200;

const refuse = (reason: string, error: string): AssignmentsRefusal => ({ ok: false, status: 400, reason, error });

/**
 * tax_codes_save's payload: `{ rows: [{ code, targets: [{ type, key }] }] }`, the WHOLE mapping.
 *
 * A row covering nothing is dropped whatever its code says: the portal starts a builder with
 * suggested rows that have no code yet, and a row that covers nothing writes nothing. A row that
 * covers something must carry a real code — a blank there is refused rather than read as "clear
 * these", because the way to clear a target is to leave it out.
 *
 * Refused: a body with no rows array, more than MAX_ASSIGNMENT_ROWS rows or
 * MAX_ASSIGNMENT_TARGETS targets (counted as sent, before anything is dropped), a malformed code,
 * a target that is neither a style id nor a known heading key, and the same target in two rows.
 * A target repeated inside one row is the same choice twice and is kept once.
 */
export function parseAssignmentsPayload(body: unknown): ParsedAssignments {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!Array.isArray(b.rows)) return refuse("bad_payload", "Send the tax code rows to save.");
  if (b.rows.length > MAX_ASSIGNMENT_ROWS) {
    return refuse("too_many_rows", `That is more than ${MAX_ASSIGNMENT_ROWS} tax code rows — combine rows that use the same code.`);
  }
  let targetCount = 0;
  for (const r of b.rows) {
    const t = (r && typeof r === "object" ? (r as Record<string, unknown>).targets : null);
    if (Array.isArray(t)) targetCount += t.length;
  }
  if (targetCount > MAX_ASSIGNMENT_TARGETS) {
    return refuse("too_many_targets", `That covers more than ${MAX_ASSIGNMENT_TARGETS} items — something is repeated.`);
  }

  const owner = new Map<string, number>(); // "type:key" → the row index that claimed it
  const rows: AssignmentRow[] = [];
  for (let i = 0; i < b.rows.length; i++) {
    const raw = b.rows[i];
    if (!raw || typeof raw !== "object") return refuse("bad_payload", "A tax code row was not readable.");
    const r = raw as Record<string, unknown>;
    const rawTargets = r.targets == null ? [] : r.targets;
    if (!Array.isArray(rawTargets)) return refuse("bad_payload", "A tax code row's list of what it covers was not readable.");
    if (!rawTargets.length) continue;

    const code = normalizeTaxCode(r.code);
    if (!code) {
      return refuse("bad_code", typeof r.code === "string" && r.code.trim()
        ? `"${r.code.trim().slice(0, 30)}" is not a tax code — pick one from the list.`
        : "Pick a tax code for every row that covers something.");
    }

    const targets: Target[] = [];
    for (const t of rawTargets) {
      const tt = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      const key = typeof tt.key === "string" ? tt.key.trim() : "";
      let target: Target;
      if (tt.type === "style") {
        if (!UUID.test(key)) return refuse("bad_style", "One of the buildings in that list isn't one of your building styles.");
        target = { type: "style", key: key.toLowerCase() };
      } else if (tt.type === "heading") {
        if (!HEADING_KEYS.has(key)) return refuse("unknown_heading", "One of the options in that list isn't a heading tax codes can cover.");
        target = { type: "heading", key };
      } else {
        return refuse("bad_payload", "A tax code row covers something that is neither a building nor an option heading.");
      }
      const id = `${target.type}:${target.key}`;
      const claimed = owner.get(id);
      if (claimed === i) continue;
      if (claimed !== undefined) {
        return refuse("duplicate_target", "The same building or option is in two tax code rows — each one takes a single code.");
      }
      owner.set(id, i);
      targets.push(target);
    }
    rows.push({ code, targets });
  }
  return { ok: true, rows };
}

/** Longest search a type-ahead sends. Longer text finds nothing a shorter prefix would not. */
export const SEARCH_MAX = 60;

/**
 * The text of a type-ahead search, ready to sit inside an ILIKE pattern: trimmed, capped at
 * SEARCH_MAX, and with ILIKE's own metacharacters escaped (`\` first, then `%` and `_`) so a
 * builder typing "10%" searches for "10%" rather than "10 followed by anything". `*` is dropped
 * outright: PostgREST turns it into `%` inside like/ilike filters before Postgres sees the
 * pattern, so no escape survives the trip, and no tax code or description needs one.
 * The caller adds the wildcards. Empty for a blank or non-string query.
 */
export function searchQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  const s = q.replace(/\*/g, "").trim().slice(0, SEARCH_MAX).trim();
  return s.replace(/\\/g, "\\\\").replace(/[%_]/g, (c) => `\\${c}`);
}

export interface TaxCodeView {
  code: string;
  description: string;
  typeId: string | null;
  isActive: boolean;
  /** The COMMON_CODES hint, or null for any other code. */
  hint: string | null;
}

/** An avalara_tax_codes row as the portal reads it. */
export function taxCodeView(row: unknown): TaxCodeView {
  const r = (row ?? {}) as Record<string, unknown>;
  const code = String(r.code ?? "");
  return {
    code,
    description: typeof r.description === "string" ? r.description : "",
    typeId: typeof r.type_id === "string" && r.type_id ? r.type_id : null,
    isActive: r.is_active === true,
    hint: HINTS.get(code) ?? null,
  };
}

/** Common codes first, in COMMON_CODES order, then the rest by code. The order the picker shows
 *  when the box is empty, and the order tax_codes_get lists the codes it sends. */
export function orderCodes<T extends { code: string }>(codes: T[]): T[] {
  const rank = new Map(COMMON_CODES.map((c, i) => [c.code, i]));
  return [...codes].sort((a, b) => {
    const ra = rank.get(a.code) ?? Infinity, rb = rank.get(b.code) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/** Most codes one search returns. A picker list, not a browser for the whole catalog. */
export const TAX_CODE_SEARCH_LIMIT = 50;

/**
 * One result list from two queries: every code of `first`, then the codes of `second` not
 * already listed, capped at `limit`. For a typed search `first` is the code-prefix matches —
 * someone typing "FR01" is naming a code, so those lead — and `second` the description matches.
 * For an empty box `first` is the common codes.
 */
export function mergeCodeLists<T extends { code: string }>(first: T[], second: T[], limit = TAX_CODE_SEARCH_LIMIT): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of [...(first ?? []), ...(second ?? [])]) {
    if (out.length >= limit) break;
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
  }
  return out;
}

/** A tax_code_assignments row as stored. */
export interface StoredAssignment { target_type: string; target_key: string; tax_code: string }

/**
 * The stored assignments a builder should SEE: a style that has since been deleted, or a heading
 * this build no longer offers, is left out rather than shown as a ghost the builder cannot
 * untick. The row stays in the table until the next save replaces the set, which drops it.
 */
export function visibleAssignments(
  stored: StoredAssignment[],
  styleIds: Set<string>,
): { targetType: TargetType; targetKey: string; code: string }[] {
  const out: { targetType: TargetType; targetKey: string; code: string }[] = [];
  for (const a of stored ?? []) {
    const key = String(a?.target_key ?? "");
    if (a?.target_type === "style" && styleIds.has(key.toLowerCase())) {
      out.push({ targetType: "style", targetKey: key.toLowerCase(), code: String(a.tax_code) });
    } else if (a?.target_type === "heading" && HEADING_KEYS.has(key)) {
      out.push({ targetType: "heading", targetKey: key, code: String(a.tax_code) });
    }
  }
  return out;
}

export interface PlannedAssignment { target_type: TargetType; target_key: string; tax_code: string }

export interface AssignmentPlan {
  /** New targets, and targets whose code changed. Unchanged ones are not rewritten, so
   *  updated_at / updated_by keep saying who last CHANGED that target. */
  upserts: PlannedAssignment[];
  /** Targets the stored read already holds with this code. Not rewritten, but inserted if they
   *  have gone missing by the time the save writes (DO NOTHING on conflict): another save may
   *  have removed one after the read. */
  kept: PlannedAssignment[];
  /** Every key the payload covers, per type. The save deletes this tenant's rows of that type
   *  whose key is NOT listed — by exclusion, not from the read, which may already be stale. */
  keepStyles: string[];
  keepHeadings: string[];
}

/** What a save has to write to turn the stored set into exactly the payload's. */
export function planAssignments(stored: StoredAssignment[], rows: AssignmentRow[]): AssignmentPlan {
  const current = new Map<string, string>();
  for (const a of stored ?? []) current.set(`${a.target_type}:${a.target_key}`, String(a.tax_code));
  const plan: AssignmentPlan = { upserts: [], kept: [], keepStyles: [], keepHeadings: [] };
  for (const row of rows) {
    for (const t of row.targets) {
      const planned = { target_type: t.type, target_key: t.key, tax_code: row.code };
      if (current.get(`${t.type}:${t.key}`) === row.code) plan.kept.push(planned);
      else plan.upserts.push(planned);
      (t.type === "style" ? plan.keepStyles : plan.keepHeadings).push(t.key);
    }
  }
  return plan;
}

// ── Avalara ListTaxCodes rows (the operator sync) ─────────────────────────────────────────

/** avalara_tax_codes.description's CHECK. Avalara's longest public description is ~250
 *  characters; a longer one is clipped here rather than failing a 500-row chunk. */
export const DESCRIPTION_MAX = 1000;

const NOT_NORTH_AMERICA = /not applicable to north america/i;

export interface TaxCodeRow {
  code: string;
  description: string;
  type_id: string | null;
  parent_code: string | null;
  is_active: boolean;
  north_america: boolean;
}

/**
 * One ListTaxCodes `value[]` entry (TaxCodeModel) as an avalara_tax_codes row, or null when its
 * taxCode cannot be a code. Only the five fields the catalog keeps are read; the model also names
 * company and user ids, which have no business in a platform table.
 *   - taxCodeTypeId is one or two letters (P, S, F, O, D, U); anything else is stored as unknown;
 *   - parentTaxCode goes through the same shape test as the code, else null;
 *   - isActive: only an explicit false deactivates. A model missing the flag is a code Avalara
 *     listed, and hiding it on a guess would take it out of every builder's picker;
 *   - north_america is false for the VAT codes whose description says they do not apply here,
 *     so the builder's search does not wade through them.
 */
export function mapAvalaraTaxCode(raw: unknown): TaxCodeRow | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const code = normalizeTaxCode(r.taxCode);
  if (!code) return null;
  const description = typeof r.description === "string" ? r.description.trim().slice(0, DESCRIPTION_MAX) : "";
  const type = typeof r.taxCodeTypeId === "string" ? r.taxCodeTypeId.trim().toUpperCase() : "";
  return {
    code,
    description,
    type_id: /^[A-Z]{1,2}$/.test(type) ? type : null,
    parent_code: normalizeTaxCode(r.parentTaxCode),
    is_active: r.isActive !== false,
    north_america: !NOT_NORTH_AMERICA.test(description),
  };
}
