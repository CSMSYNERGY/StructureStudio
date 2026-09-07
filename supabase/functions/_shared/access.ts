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
//
// ── ONE LEVEL IS ABOUT ROWS, NOT TABS (2026-09-05) ──────────────────────────────────────
// `contacts: 'own'` narrows WHICH ROWS a person sees, not which pages. Everything above
// still applies to it, and it needs a third enforcement point the rest of this module does
// not: the level says "narrow", and the narrowing itself lives in
//   1. RLS       — migration 193's restrictive policies, for the lists the browser reads
//                  straight from PostgREST (designs / crm_contacts / captured_leads);
//   2. the edge  — every function runs service-role and therefore BYPASSRLS, so RLS
//                  contributes NOTHING there and the filter is added by hand at the read;
//   3. the browser — portal/01-core.jsx's row-scope registry, a courtesy like the nav.
// Change the meaning of 'own' and all three move together. See ownContactsOnly() below.

export type Level = "none" | "view" | "edit" | "own";
export type Title =
  | "owner" | "admin" | "office_staff" | "sales_manager" | "sales_rep"
  | "dealer" | "scheduler" | "crew_leader" | "crew_member" | "driver";

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
  /**
   * Belongs to CSM Synergy's OWN tenants and must never appear on a builder's Team screen.
   *
   * The Projects board is one global internal system — no `pm_*` table has a `client_id` —
   * so the switch is meaningless to a builder and, rendered on their screen, is worse than
   * meaningless: it advertises an internal tool they can never reach and invites a support
   * question about a permission that does nothing. accessMetadata() ships AREAS to every
   * tenant's browser, so the filter has to live there rather than in the UI, and it defaults
   * to EXCLUDING these — the safe direction for a caller that does not know whose screen it
   * is building.
   *
   * It is NOT a security boundary on its own and must not be treated as one. The real gate
   * is portal-projects checking `client_settings.internal_account` before it consults the
   * area at all; this flag only decides who is offered the switch. Omission from every
   * preset is what makes the area itself deny by default.
   */
  internalOnly?: boolean;
}

const RVE: Level[] = ["none", "view", "edit"];

export const AREAS: Area[] = [
  // ── Workspace ────────────────────────────────────────────────────────────
  { key: "designer",          label: "Designer",           group: "workspace", hint: "Build designs and quotes",            levels: RVE },
  { key: "designs",           label: "Designs",            group: "workspace", hint: "Customer designs and quotes",         levels: RVE },
  // 'own' = see only the customers you are ASSIGNED TO or FOLLOWING — and, because a quote
  // belongs to a customer and not to a rep, only those customers' designs and browsing leads.
  //
  // WHY (Carolyn, 2026-09-04, 1:02:16–1:04:27, describing a builder she is onboarding whose
  // salespeople are independent dealers): "he also doesn't want them to see each other's
  // quotes either … they would only see the list, the pipelines or the quotes that they have
  // created themselves. Only the owner would see 'okay, this customer went through employee
  // B and C' … Now, if the owner wants the employees to see, then they just toggle the
  // button in the settings and they will be able to see." THIS SWITCH IS THAT BUTTON.
  //
  // ⚠️ THE CONTACTS LEVEL SCOPES THE DESIGNS LIST, NOT THE `designs` LEVEL — and that is her
  // model rather than a shortcut (same call, 1:09:30): "we do not ever assign deals. We only
  // assign contacts and followers … if they are not assigned to or following that customer,
  // they can't see anything of it." A design has no assignee and is not getting one; it is
  // visible because its CUSTOMER is. So `designs` keeps none/view/edit and answers "may you
  // open the Pipeline at all", while this row answers "whose rows are in it".
  //
  // ⚠️ 'own' IS A READ SCOPE, EXACTLY AS IT IS ON COMMISSIONS. RANK puts it level with
  // 'view', so canEdit() is false for it and every contacts:'edit' action — the contact
  // editor, notes, activities, SMS, email, customer files — is REFUSED for someone set to
  // 'own'. That is a consequence, not an oversight, and it is written down here so the next
  // reader does not "fix" it by hand: Carolyn asked about SEEING, four times in three
  // sentences, and making 'own' a write scope would mean per-row ownership checks on eleven
  // write actions plus a level that outranks 'view' — neither of which she has been asked
  // for. A builder who needs dealers that can WORK their own records but see nobody else's
  // is a second decision, and it is hers.
  //
  // ADDED to the vocabulary rather than replacing 'view'. effectiveAccess DISCARDS a stored
  // override whose level is not in the area's list, so dropping 'view' would silently drop
  // every stored {"contacts":"view"} back to the title preset — 'none' for a crew leader —
  // on the next page load, with nothing anywhere to notice.
  { key: "contacts",          label: "Contacts",           group: "workspace", hint: "Everyone who has enquired — 'Own only' hides other reps' customers",
    levels: ["none", "own", "view", "edit"] },
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
  // UNLOCKING a signed order so it can be amended. A SEPARATE AREA, not a third level on
  // change_orders, and that is Carolyn's decision (2026-09-07): "there should be both the
  // option to give approval for a change order, but they can also make the change order if
  // they are given permission" — approving must not imply raising, and one person may hold
  // either, both or neither.
  //
  // A level ABOVE `edit` on change_orders was the obvious alternative and is a trap. Two of
  // them: effectiveAccess short-circuits an owner to the literal "edit" for every area, so an
  // owner could not approve an unlock in their own business; and migration 188's restrictive
  // policies test `current_area_level('change_orders') = 'edit'` literally, so an approver
  // would be refused every change-order write at PostgREST — with no gate table, lint or
  // preflight check standing behind either. Two areas keeps `edit` the top level of both and
  // neither trap exists.
  //
  // Two levels, like commissions proves is supported. There is nothing to "view" here: the
  // unlock request and its history render off the order screen under change_orders/orders.
  //
  // Omitted from sales_rep, crew_leader and driver, so it is DENIED by default and nobody —
  // including every existing crew leader — gains it on the day it ships. Admins hold it by
  // preset, which is the answer Carolyn picked ("everyone starts at None except owners and
  // admins; you tick Approve for the specific crew leaders you trust").
  { key: "change_order_approve", label: "Approve Changes",  group: "workspace",
    hint: "Unlock a signed order so it can be changed", levels: ["none", "edit"] },
  { key: "build_schedule",    label: "Build Schedule",     group: "workspace", hint: "Crews, build dates, the board",       levels: RVE },
  { key: "delivery_schedule", label: "Delivery Schedule",  group: "workspace", hint: "Loads, routes, drivers",              levels: RVE },
  { key: "repairs",           label: "Repairs",            group: "workspace", hint: "Service jobs and history",            levels: RVE },
  // 'own' = see your own payout and nothing else. This is the setting most reps should
  // have, and it is the shape the commissions confidentiality rule already assumes.
  { key: "commissions",       label: "Commissions",        group: "workspace", hint: "Payouts — 'Own only' hides everyone else's",
    levels: ["none", "own", "edit"] },
  { key: "reports",           label: "Reports",            group: "workspace", hint: "Sales, leads, revenue",               levels: RVE },
  // CSM SYNERGY'S OWN BOARDS — bugs, feature requests, roadmap, client setup. Internal only.
  //
  // Carolyn, 2026-09-02, with Settings → Team open beside the Projects people list: "I feel
  // like THIS should be where we add them. And here we say ... we give them access to
  // projects." Until now the two lists were not connected in any way — no trigger, no shared
  // column, nothing — and the only way onto the board was the Projects-side roster, which
  // also happens to be where operator access to every builder's account is handed out.
  //
  // An AREA rather than a per-person boolean, and the reason is that there is nowhere honest
  // to put a boolean: sanitizeAccess drops unknown keys, so it cannot ride in
  // client_users.access; a new client_users column is tenancy-backbone surgery for a value
  // meaningful to one tenant; and storing it on pm_people puts the grant back in Projects,
  // which is exactly what she is asking us to stop. An area also gives view/edit for free,
  // and that split maps ONTO the one portal-projects already has (READ_ACTIONS vs
  // can_write), so nothing new has to be invented to express "can look, cannot change".
  //
  // Omitted from every preset below, so it resolves to 'none' for every non-owner on every
  // tenant. internalOnly keeps it off builders' Team screens entirely.
  { key: "projects",          label: "Projects",           group: "workspace", hint: "CSM Synergy's internal boards — bugs, features, roadmap", levels: RVE, internalOnly: true },

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

/**
 * The job titles a builder picks from, in DESCENDING order of authority — the Team screen
 * renders the pills in this order, so it is the reading order of the whole model.
 *
 * Ten of them since 2026-09-07 (Carolyn: "Owner, Office Staff, Sales Manager, Sales Rep,
 * Dealer, Crew Leader, Crew Member, Scheduler, Driver"). Her nine did not include ADMIN, and
 * her decision was to KEEP it rather than fold it into Office Staff: admin is not just a
 * label here — it is the only title that may hold a granted Billing switch (see ownerGranted)
 * and roleForTitle maps it to the coarse role='admin' that older RLS policies read. Retitling
 * every existing admin would have moved real people's access on a rename.
 *
 * ⚠️ ADDING A TITLE IS A THREE-PLACE CHANGE and two of them fail SILENTLY:
 *   1. here + PRESETS below;
 *   2. `k_presets` inside area_level_for() — the SQL twin the RESTRICTIVE RLS policies read.
 *      A title missing there resolves to 'none' for EVERY area, so the person passes every
 *      edge-function gate and then reads empty lists with error === null;
 *   3. client_users_title_check — a hardcoded CHECK constraint (100_user_access.sql:53,
 *      re-issued by 207). A title missing there cannot be SAVED at all.
 * scripts/preflight.mjs now compares this list against k_presets in both directions, which
 * covers (2); (3) has no guard, so read 207's header before adding the eleventh.
 */
export const TITLES: { key: Title; label: string; blurb: string }[] = [
  { key: "owner",         label: "Owner",         blurb: "Everything, always — cannot be reduced" },
  { key: "admin",         label: "Admin",         blurb: "Runs the business day to day; an owner can grant Billing" },
  { key: "office_staff",  label: "Office Staff",  blurb: "Quotes, orders and paperwork; keeps business details current" },
  { key: "sales_manager", label: "Sales Manager", blurb: "Runs the sales team and sees everyone's numbers" },
  { key: "sales_rep",     label: "Sales Rep",     blurb: "Sells: designs, quotes, contacts, own commission" },
  { key: "dealer",        label: "Dealer",        blurb: "Sells their own customers only — sees nobody else's" },
  { key: "scheduler",     label: "Scheduler",     blurb: "Plans builds, deliveries and repairs" },
  { key: "crew_leader",   label: "Crew Leader",   blurb: "Runs builds and repairs" },
  { key: "crew_member",   label: "Crew Member",   blurb: "Sees their build board and repairs, changes nothing" },
  { key: "driver",        label: "Driver",        blurb: "Runs deliveries" },
];

/** A title's default switches. Anything a preset omits is "none" — new areas are therefore
 *  DENIED by default to every non-owner, which is the only safe direction for a list that
 *  people will keep extending. */
export const PRESETS: Record<Title, Record<string, Level>> = {
  owner: Object.fromEntries(AREA_KEYS.map((k) => [k, k === "commissions" ? "edit" : "edit"])),
  admin: {
    designer: "edit", designs: "edit", contacts: "edit", inventory: "edit", orders: "edit",
    change_orders: "edit", change_order_approve: "edit",
    build_schedule: "edit", delivery_schedule: "edit", repairs: "edit", commissions: "edit", reports: "edit",
    settings_structures: "edit", settings_options: "edit", settings_branding: "edit",
    settings_crm: "edit", settings_quickbooks: "edit", settings_email: "edit",
    settings_team: "edit",
    settings_billing: "none",
  },
  // The five titles below arrived together on 2026-09-07. Each one's shape is Carolyn's
  // answer to "what should this person get the moment you pick the title", and the switches
  // stay editable per person afterwards — a preset is a starting point, never a ceiling.
  //
  // Office staff run the paperwork: they process quotes, orders and change orders, keep the
  // inventory list straight, and can SEE what is scheduled without moving anything. The two
  // settings cards are the ones a business's paperwork actually depends on — the details that
  // print on an estimate, and the accounting mappings. Team, Billing, Structures, Options,
  // CRM and Email are all omitted, so they cannot reshape the product or the money.
  //
  // ⚠️ `designer` is deliberately absent: this title manages quote RECORDS, it does not build
  // them. An office staffer who takes phone orders needs designer:'edit' switched on per
  // person — one click on the Team screen — rather than every office staffer getting it.
  office_staff: {
    designs: "edit", contacts: "edit", inventory: "edit", orders: "edit",
    change_orders: "edit",
    build_schedule: "view", delivery_schedule: "view", repairs: "view", reports: "view",
    settings_branding: "edit", settings_quickbooks: "edit",
  },
  // A sales rep plus the two things that make someone a MANAGER of reps: everyone's payout
  // figures (commissions:'edit' is what seesAllPayouts() reads) and change orders, because
  // re-opening a signed agreement is the call a manager gets pulled into. Reports:'edit'
  // rather than 'view' — running the numbers is the job.
  //
  // NOTE this is the ONE new preset that hands out pay information by default, and it was
  // asked for explicitly (Carolyn, 2026-09-07: "Everyone's payouts"). It runs against the
  // grain of the commissions confidentiality rule, which otherwise assumes nothing about pay
  // is visible unless an owner grants it per person — so if that rule ever tightens, this
  // line is the one to revisit.
  sales_manager: {
    designer: "edit", designs: "edit", contacts: "edit", inventory: "view",
    orders: "edit", change_orders: "edit", commissions: "edit", reports: "edit",
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
  // The independent salesperson the contacts:'own' scope was built for (see the AREAS comment
  // on `contacts`, quoting Carolyn on a builder whose reps are dealers: "he also doesn't want
  // them to see each other's quotes either"). Identical to a sales rep except that the
  // customer list — and therefore the designs and leads hanging off it — is narrowed to the
  // customers they are assigned to or following.
  //
  // ⚠️ CONSEQUENCE, NOT AN OVERSIGHT: 'own' is a READ scope. RANK scores it level with 'view',
  // so canEdit(contacts) is FALSE and a dealer cannot edit a contact, add a note, log an
  // activity, or send SMS/email — on their own customers included. That is the documented
  // behaviour of the level (see ownContactsOnly), and making it a write scope is a separate
  // decision that belongs to Carolyn, not a bug to patch here. An owner who wants a
  // particular dealer to work their records switches that one person to contacts:'edit'.
  dealer: {
    designer: "edit", designs: "edit", contacts: "own",
    inventory: "view", orders: "edit", commissions: "own",
  },
  // Owns all three boards. Everything else is 'view' because a scheduler has to see WHAT they
  // are scheduling and WHO it is for — the building on the order, the customer to call about
  // a delivery window — without being able to change the sale.
  scheduler: {
    build_schedule: "edit", delivery_schedule: "edit", repairs: "edit",
    designs: "view", contacts: "view", inventory: "view", orders: "view",
  },
  crew_leader: {
    build_schedule: "edit", repairs: "edit",
    designs: "view", inventory: "view", orders: "view",
  },
  // Read-only on the two boards their leader runs: they see their jobs and what is coming,
  // and cannot move a date, reassign a crew or close a job. Nothing else — the build card
  // already carries the building spec (build_jobs snapshots style, size, roof and colours),
  // so seeing the board does not require the design or the order behind it.
  crew_member: {
    build_schedule: "view", repairs: "view",
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
 * Contacts only: is this caller limited to the customers they OWN or FOLLOW?
 *
 * The one place the literal 'own' is compared for this area, so the three enforcement points
 * (RLS, the edge filters, the browser registry) cannot come to mean different things. It
 * answers a narrower question than canRead/canEdit and deliberately does not overlap them:
 * 'own' still READS (canRead is true — RANK puts it level with 'view') and still cannot
 * WRITE (canEdit is false). All this adds is "…but only some of the rows".
 *
 * OWNERS CANNOT REACH IT and that is structural, not a check here: effectiveAccess()
 * short-circuits `role === "owner"` to 'edit' on every area before a stored map is ever
 * consulted, so an owner's contacts level is never the string 'own' no matter what is in
 * client_users.access. The SQL twin (area_level_for) short-circuits the same way, and both
 * the RLS resolver and the edge filters are built on top of that rather than re-testing the
 * role — a filter that forgets owners are absolute empties the owner's own dashboard.
 */
export function ownContactsOnly(access: Record<string, Level>): boolean {
  return access.contacts === "own";
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
 *   3. AN 'own' HOLDER PASSES ON 'own', NEVER 'view'. Rule 2 alone does not cover this:
 *      RANK deliberately scores 'own' and 'view' the SAME (both are "may read"), so
 *      `RANK[view] <= RANK[own]` is true and an admin an owner had deliberately narrowed to
 *      contacts:'own' could hand a rep the whole customer list — widening past their own
 *      scope, which is exactly what rule 2 exists to forbid. It never surfaced before
 *      because commissions is the only other 'own' area and its vocabulary has no 'view' to
 *      pass on. Row scope is not a rank, so it needs its own line.
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
  const held = granterAccess[area] ?? "none";
  if (held === "own" && level !== "own" && level !== "none") return false;
  return RANK[level] <= RANK[held];
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
/**
 * The grid the Team screen renders itself from — areas, titles and presets, so the browser
 * never hard-codes an area.
 *
 * ⚠️ DEFAULTS TO HIDING internalOnly AREAS, and the default is the point: this reaches every
 * tenant's browser, and a caller that has not thought about whose screen it is building
 * should get the answer that cannot leak. Pass `{ internal: true }` only once you have
 * established that the tenant IS ours — `isInternalTenant`, not a slug comparison.
 */
export function accessMetadata(opts?: { internal?: boolean }) {
  const areas = opts && opts.internal ? AREAS : AREAS.filter((a) => !a.internalOnly);
  return { areas, titles: TITLES, presets: PRESETS };
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
