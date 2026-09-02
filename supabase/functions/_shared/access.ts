// Per-person access: the ONE definition of what areas exist, what each job title grants,
// and how an effective permission is resolved. Migration 100 stores the two inputs
// (client_users.title + client_users.access); everything else lives here.
//
// WHY ONE MODULE: this answers "may this person do this" for every edge function AND
// supplies the switch grid the Team screen renders. A second copy of the preset table in
// portal.html would drift the day someone adds an area — and a permission table that
// drifts is a permission table that lies. The server therefore SHIPS the metadata below
// to the browser (see portal-settings' team actions); the UI renders what it is told and
// never hard-codes an area.
//
// THE RULE THAT MATTERS: the UI hiding a tab is a courtesy, not a control. Every action
// in every function must call requireAccess() before it reads or writes, because anyone
// can call these endpoints directly with a valid session.

export type Level = "none" | "view" | "edit" | "own";
export type Title = "owner" | "admin" | "sales_rep" | "crew_leader" | "driver";

/** One switch on the Team screen. `levels` is the vocabulary for THAT row — commissions
 *  is deliberately different from the rest, so the grid is data-driven rather than
 *  assuming a universal none/view/edit triplet. */
export interface Area {
  key: string;
  label: string;
  group: "workspace" | "settings";
  hint: string;
  levels: Level[];
  /**
   * Only an OWNER may set this switch, and only an ADMIN may hold it. Distinct from
   * byTitleOnly in both directions: the area does not come with any title (the admin
   * preset is 'none'), and holding it never lets you pass it on — mayGrant refuses
   * ownerGranted areas for every non-owner, INCLUDING a holder.
   *
   * History (2026-08-08, Carolyn): Billing was `ownerOnly` — unholdable by anyone but an
   * owner, full stop — while her audit decision said "admin should be able to as well."
   * The reconciliation is this flag: Billing stays off for every admin by default, and an
   * owner flips it on for the one admin they trust with the card. Two rules keep that
   * from widening: only owners grant it (a granted admin editing a sales_rep cannot pass
   * Billing along), and only admins hold it (a stored grant on any other title resolves
   * to 'none' in effectiveAccess, so a title downgrade also revokes it structurally).
   */
  ownerGranted?: boolean;
  /**
   * Comes with the JOB TITLE and can never be handed out one switch at a time. Team is the
   * area that hands out every other area, so a per-person override on it would let an owner
   * give a driver the keys in two clicks, and would give admins a route to minting peers
   * that bypasses "only an owner may set the Admin title". You get Team by being an Admin.
   * Overrides on these areas are DROPPED rather than honoured — the switch renders locked,
   * and the server agrees instead of trusting the screen.
   */
  byTitleOnly?: boolean;
}

const RVE: Level[] = ["none", "view", "edit"];

export const AREAS: Area[] = [
  // ── Workspace ────────────────────────────────────────────────────────────
  { key: "designer",          label: "Designer",           group: "workspace", hint: "Build designs and quotes",            levels: RVE },
  { key: "designs",           label: "Designs",            group: "workspace", hint: "Customer designs and quotes",         levels: RVE },
  { key: "contacts",          label: "Contacts",           group: "workspace", hint: "Everyone who has enquired",           levels: RVE },
  { key: "inventory",         label: "Inventory",          group: "workspace", hint: "Buildings on your lots",              levels: RVE },
  { key: "orders",            label: "Orders",             group: "workspace", hint: "Accepted quotes through delivery",    levels: RVE },
  // Amending a SIGNED order. Split out of `orders` (Carolyn, 2026-09-01: "Change Orders is
  // the only feature they shouldn't have unless given permission in the team settings") when
  // reps gained orders:edit so they could finalize an order, take payment and collect the
  // signature. A change order re-opens an agreement the customer already committed to and
  // asks them to commit again — a different kind of act from completing the order in front
  // of you, and the one where a mistake costs the builder the customer's confidence.
  //
  // Omitted from every non-owner preset, so it is DENIED by default (see PRESETS' header) and
  // an owner or admin hands it out per person. Deliberately NOT ownerGranted: an admin runs
  // the business day to day and may legitimately grant this, unlike Billing.
  { key: "change_orders",     label: "Change Orders",      group: "workspace", hint: "Amend a signed order — the customer signs off again", levels: RVE },
  { key: "build_schedule",    label: "Build Schedule",     group: "workspace", hint: "Crews, build dates, the board",       levels: RVE },
  { key: "delivery_schedule", label: "Delivery Schedule",  group: "workspace", hint: "Loads, routes, drivers",              levels: RVE },
  { key: "repairs",           label: "Repairs",            group: "workspace", hint: "Service jobs and history",            levels: RVE },
  // 'own' = see your own payout and nothing else. This is the setting most reps should
  // have, and it is the shape the commissions confidentiality rule already assumes.
  { key: "commissions",       label: "Commissions",        group: "workspace", hint: "Payouts — 'Own only' hides everyone else's",
    levels: ["none", "own", "edit"] },
  { key: "reports",           label: "Reports",            group: "workspace", hint: "Sales, leads, revenue",               levels: RVE },

  // ── Settings ─────────────────────────────────────────────────────────────
  { key: "settings_structures", label: "Structures",           group: "settings", hint: "Styles, sizes, base prices",          levels: RVE },
  { key: "settings_options",    label: "Options & Colors",     group: "settings", hint: "Doors, windows, ramps, palettes",     levels: RVE },
  { key: "settings_branding",   label: "Branding & Estimates", group: "settings", hint: "Your look, business details, lots",   levels: RVE },
  { key: "settings_crm",        label: "CRM Connection",       group: "settings", hint: "Synergy/GHL keys and pipelines",      levels: RVE },
  { key: "settings_quickbooks", label: "QuickBooks",           group: "settings", hint: "Accounting connection + mappings",    levels: RVE },
  { key: "settings_email",      label: "Email Sending",        group: "settings", hint: "Send estimates and invoices from your own domain", levels: RVE },
  { key: "settings_team",       label: "Team",                 group: "settings", hint: "Add people and set their access",     levels: RVE, byTitleOnly: true },
  // The card that pays for the product: off for every admin by default, granted per person
  // by an owner, never grantable by anyone else. See the ownerGranted doc above.
  { key: "settings_billing",    label: "Billing",              group: "settings", hint: "Your StructureStudio subscription",   levels: RVE, ownerGranted: true },
];

export const AREA_KEYS: string[] = AREAS.map((a) => a.key);
const AREA_BY_KEY = new Map(AREAS.map((a) => [a.key, a]));

export const TITLES: { key: Title; label: string; blurb: string }[] = [
  { key: "owner",       label: "Owner",       blurb: "Everything, always — cannot be reduced" },
  { key: "admin",       label: "Admin",       blurb: "Runs the business day to day; an owner can grant Billing" },
  { key: "sales_rep",   label: "Sales Rep",   blurb: "Sells: designs, quotes, contacts, own commission" },
  { key: "crew_leader", label: "Crew Leader", blurb: "Runs builds and repairs" },
  { key: "driver",      label: "Driver",      blurb: "Runs deliveries" },
];

/** A title's default switches. Anything a preset omits is "none" — new areas are therefore
 *  DENIED by default to every non-owner, which is the only safe direction for a list that
 *  people will keep extending. */
export const PRESETS: Record<Title, Record<string, Level>> = {
  owner: Object.fromEntries(AREA_KEYS.map((k) => [k, k === "commissions" ? "edit" : "edit"])),
  admin: {
    designer: "edit", designs: "edit", contacts: "edit", inventory: "edit", orders: "edit",
    change_orders: "edit",
    build_schedule: "edit", delivery_schedule: "edit", repairs: "edit", commissions: "edit", reports: "edit",
    settings_structures: "edit", settings_options: "edit", settings_branding: "edit",
    settings_crm: "edit", settings_quickbooks: "edit", settings_email: "edit",
    settings_team: "edit",
    settings_billing: "none",
  },
  sales_rep: {
    designer: "edit", designs: "edit", contacts: "edit",
    // orders:'edit' since 2026-09-01 (Carolyn): a rep should be able to edit, complete and
    // finalize an order, take the payment and get the signature — the whole sale, from the
    // designer's Push to Invoice through to money in. change_orders is deliberately ABSENT
    // rather than 'none': omission is how a preset denies, and spelling it out would suggest
    // the list is exhaustive when new areas must keep defaulting closed.
    inventory: "view", orders: "edit", commissions: "own",
  },
  crew_leader: {
    build_schedule: "edit", repairs: "edit",
    designs: "view", inventory: "view", orders: "view",
  },
  driver: {
    delivery_schedule: "edit",
    inventory: "view", orders: "view",
  },
};

const RANK: Record<Level, number> = { none: 0, own: 1, view: 1, edit: 2 };

function normTitle(t: unknown): Title {
  return (TITLES.some((x) => x.key === t) ? t : "sales_rep") as Title;
}

/** The full, resolved map for one person: preset(title) with their stored overrides on top.
 *  Owners short-circuit to full access — an owner's stored map is never consulted, so an
 *  owner can never lock themselves (or be locked) out of their own account. */
export function effectiveAccess(
  role: string | null | undefined,
  title: unknown,
  overrides: Record<string, unknown> | null | undefined,
): Record<string, Level> {
  if (role === "owner") return Object.fromEntries(AREA_KEYS.map((k) => [k, "edit" as Level]));
  const base = { ...PRESETS[normTitle(title)] };
  const out: Record<string, Level> = {};
  for (const k of AREA_KEYS) out[k] = (base[k] as Level) ?? "none";
  for (const [k, v] of Object.entries(overrides ?? {})) {
    const area = AREA_BY_KEY.get(k);
    if (!area) continue;                       // unknown area: ignore, never trust the blob
    // owner-granted areas resolve ONLY on an admin. Checked at resolution and not just at
    // the set_access door so the property survives data that arrives some other way — and
    // so demoting an admin to a staff title structurally revokes their Billing grant
    // without anyone remembering to also clear the switch.
    if (area.ownerGranted && normTitle(title) !== "admin") continue;
    if (area.byTitleOnly) continue;            // Team comes with the title, never a switch
    if (area.levels.includes(v as Level)) out[k] = v as Level;
  }
  return out;
}

export function canRead(access: Record<string, Level>, area: string): boolean {
  return RANK[access[area] ?? "none"] >= 1;
}
export function canEdit(access: Record<string, Level>, area: string): boolean {
  return (access[area] ?? "none") === "edit";
}
/** Commissions only: may they see OTHER people's payouts, or just their own? */
export function seesAllPayouts(access: Record<string, Level>): boolean {
  return access.commissions === "edit";
}

/**
 * May `granter` hand `level` on `area` to someone else?
 *
 * Two rules, both load-bearing:
 *   1. owner-granted areas (Billing) are granted by owners, full stop — HOLDING one does
 *      not let you pass it on, or the "one trusted admin" an owner picked could quietly
 *      become several.
 *   2. NOBODY GRANTS ABOVE THEMSELVES — an admin without QuickBooks cannot give QuickBooks
 *      to anyone, including themselves. Without this the whole model is decorative: any
 *      admin could self-promote to everything in two clicks and nothing would record it.
 */
export function mayGrant(
  granterRole: string | null | undefined,
  granterAccess: Record<string, Level>,
  area: string,
  level: Level,
): boolean {
  const a = AREA_BY_KEY.get(area);
  if (!a) return false;
  if (!a.levels.includes(level)) return false;
  if (granterRole === "owner") return true;
  if (a.ownerGranted) return false;
  return RANK[level] <= RANK[granterAccess[area] ?? "none"];
}

/**
 * The coarse `role` a title implies. Migration 100 kept `role` (owner|admin|user) as the
 * column RLS policies and older gates read, so the two must never disagree: a person whose
 * title says Admin but whose role still says user would pass this module's checks and then
 * be refused by an RLS policy, which reads as "the app is broken" and is impossible to
 * diagnose from the screen. Every write of `title` writes `role` alongside it.
 *
 * The three staff titles all map to 'user' — their real powers come from the access map,
 * not from role. That keeps the coarse column meaning exactly what it always meant.
 */
export function roleForTitle(title: unknown): "owner" | "admin" | "user" {
  const t = normTitle(title);
  return t === "owner" ? "owner" : t === "admin" ? "admin" : "user";
}

/**
 * Keep only what is safe to store in client_users.access: known areas, valid levels for
 * THAT area, no by-title area, and an owner-granted area only when the row's title is
 * admin. Mirrors what effectiveAccess would ignore anyway — but dropping it at the door
 * means the stored row never contains a claim the resolver silently disregards, so what
 * an owner sees on the Team screen is what is saved.
 *
 * `title` is the title the row is being saved WITH. Omitting it drops owner-granted keys
 * entirely — the safe direction for a caller that doesn't know who this map is for.
 */
export function sanitizeAccess(raw: unknown, title?: unknown): Record<string, Level> {
  const out: Record<string, Level> = {};
  if (!raw || typeof raw !== "object") return out;
  const isAdmin = title !== undefined && normTitle(title) === "admin";
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const area = AREA_BY_KEY.get(k);
    if (!area || area.byTitleOnly) continue;
    if (area.ownerGranted && !isAdmin) continue;
    if (area.levels.includes(v as Level)) out[k] = v as Level;
  }
  return out;
}

/**
 * May `granter` produce this ENTIRE resulting access map for someone else? Returns the
 * label of the first area they may not grant, or null when the whole map is allowed.
 *
 * Checking the RESULT rather than the submitted overrides is the load-bearing part. Access
 * is stored as deviations from a title's preset, so an admin could hand out everything the
 * OWNER preset contains while submitting an empty overrides object — simply by setting the
 * title to Owner. Validating only the overrides would wave that through. Resolve first,
 * then check every area, and both doors are covered by one rule.
 */
export function mayGrantMap(
  granterRole: string | null | undefined,
  granterAccess: Record<string, Level>,
  resulting: Record<string, Level>,
): string | null {
  for (const key of AREA_KEYS) {
    const level = resulting[key] ?? "none";
    if (level === "none") continue;              // taking access away is always allowed
    if (!mayGrant(granterRole, granterAccess, key, level)) {
      return AREA_BY_KEY.get(key)?.label ?? key;
    }
  }
  return null;
}

/** Metadata the Team screen renders from, so the browser never hard-codes an area list. */
export function accessMetadata() {
  return { areas: AREAS, titles: TITLES, presets: PRESETS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action gates — the table IS the permission check
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A TABLE AND NOT A CHECK PER BRANCH. Every one of these functions is a long
// `if (action === "x") { ...; return }` chain — portal-settings alone is 51 of them. In
// that shape a branch with a forgotten check does not fail, it RUNS: only an *unmatched*
// action reaches the closing 400. So "add requireAccess() to each branch" would make the
// security of this feature equal to how reliably a person remembers, forever, across four
// files. It would hold today and rot on the first busy afternoon.
//
// Instead each function declares one table and resolveTenant checks it BEFORE dispatch.
// An action that is not in the table is REFUSED (see resolveTenant's "Unrecognised
// action"), so the failure mode of forgetting flips from "silently public" to "my new
// endpoint 403s the moment I test it". That is the only direction this can safely fail,
// and scripts/preflight.mjs pins it: every `action === "…"` literal in a gated function
// must appear in that function's table, or the push is blocked.
//
// This table also REPLACES the old readActions/selfActions/staffActions role sets. Keeping
// both would mean two permission models disagreeing: a crew leader granted
// build_schedule:'edit' would pass canEdit() and then still be 403'd by the role gate,
// which is exactly the per-person control Carolyn asked for failing to work. The read/write
// split those sets also encoded (used for read-only OPERATORS) is derived from the gate's
// own level instead — one fact, one place.

/** One requirement: `level` is the MINIMUM. 'view' is satisfied by view/edit/own. */
export type GateNeed = { area: string; level: "view" | "edit" };

export type Gate =
  /** Any signed-in member of the tenant. ONLY for bootstrap calls the portal shell cannot
   *  render without — gating those locks everyone out of the app, not out of an area. */
  | "open"
  /** A write, but only ever to the caller's OWN row. The handler must key off ctx.userId
   *  and never a body-supplied id — this gate cannot enforce that for you. */
  | "self"
  | GateNeed
  /** Satisfied by ANY one of these — for payloads two areas legitimately share. */
  | { any: GateNeed[] }
  /** Requires EVERY one — for actions whose side effects cross areas (deleting an
   *  inventory unit also deletes its design), so holding one area is not enough. */
  | { all: GateNeed[] };

export type GateTable = Record<string, Gate>;

function needs(g: Gate): GateNeed[] {
  if (g === "open" || g === "self") return [];
  if ("any" in g || "all" in g) return (g as { any?: GateNeed[]; all?: GateNeed[] }).any ?? (g as { all: GateNeed[] }).all;
  return [g as GateNeed];
}

/**
 * Is this action a READ? Derived from the gate rather than a second hand-kept list.
 * Used for the read-only-operator capability check, so a gate that requires 'edit'
 * anywhere is a write.
 */
export function gateIsRead(g: Gate | undefined): boolean {
  if (!g) return false;
  if (g === "open") return true;
  if (g === "self") return false;          // a self-service write is still a write
  return needs(g).every((n) => n.level === "view");
}

/**
 * Does this caller satisfy the gate? Returns null when allowed, or a message when not.
 *
 * The message deliberately names the AREA and not the action: "you do not have access to
 * Billing" is something an owner can act on, whereas "cancel denied" is not.
 */
export function checkGate(
  g: Gate | undefined,
  access: Record<string, Level>,
): string | null {
  if (!g) return "Unrecognised action.";
  if (g === "open" || g === "self") return null;
  const list = needs(g);
  const ok = (n: GateNeed) => (n.level === "edit" ? canEdit(access, n.area) : canRead(access, n.area));
  const label = (n: GateNeed) => AREA_BY_KEY.get(n.area)?.label ?? n.area;
  if (typeof g === "object" && "any" in g) {
    if (list.some(ok)) return null;
    return `Your access does not include ${list.map(label).join(" or ")}. Ask an owner or admin.`;
  }
  const missing = list.filter((n) => !ok(n));
  if (!missing.length) return null;
  const verb = missing.some((n) => n.level === "edit") ? "change" : "view";
  return `Your access does not let you ${verb} ${missing.map(label).join(" and ")}. Ask an owner or admin.`;
}
