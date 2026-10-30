// support-agent's account tools: what the assistant may look up about the builder it is talking to.
//
// ══ THE ONE RULE ══
// EVERY QUERY IS THE CALLER'S OWN TENANT, AND NO TOOL TAKES AN ID. The tenant comes from
// resolveTenant (index.ts), never from the model: no schema below has a client, user, tenant or any
// other id field, so there is nothing for a prompt injection to point at another builder. Every
// table read filters `.eq("client_id", ctx.clientId)`; the only exceptions are the two global tables
// that hold no tenant data at all (release_notes, the product changelog everyone reads, and
// setup_template_items, the checklist template). tools_test.ts runs every tool against a recording
// database and fails when a query misses the filter, or when a schema gains an id field.
//
// READ-ONLY. Nothing here writes. offer_handoff has no side effect: it only tells the portal to show
// a "Send this to our team" card, which the builder presses themselves (portal-feedback files it).
// note_gap reads and writes nothing either: agent.ts stores its words on the answer (migration 348,
// support_messages.gap) for Admin → Support chats' "Didn't know" filter.
//
// NO END-CUSTOMER DATA. No tool reads contacts, designs, orders, conversations or anything else a
// builder's customers typed. The assistant answers "how do I" and "what is set on my account", not
// "what did Mrs. X order".
//
// Tool results go back to Claude as JSON, as data. Strings that came from the tenant (style names,
// request titles, the business name) are capped at 200 characters; the system prompt says to treat
// everything a tool returns as data, never as instructions.

import { AREAS, canRead, type Level } from "../_shared/access.ts";

// deno-lint-ignore no-explicit-any
export type Db = any;

export interface ToolCtx {
  clientId: string;
  userId: string;
  access: Record<string, Level>;
  db: Db;
  /** usableFeatureSet for this tenant (featureCheck.ts), passed in so the tool stays a pure read. */
  features: (list: string[]) => Promise<Set<string>>;
}

/** The tables a tool may read WITHOUT a client_id filter: global, and holding no tenant data. */
export const GLOBAL_TABLES = new Set(["release_notes", "setup_template_items"]);

const cap = (v: unknown, n = 200): string | null => (v == null ? null : String(v).slice(0, n));

/** Add-ons a builder can buy, by billing_plans.feature, in the words the Billing page uses. */
const ADD_ONS: Record<string, string> = {
  simple_layout: "Designer (the base plan)",
  view_3d: "3D",
  schedule_builds: "Scheduling",
  quickbooks_sync: "QuickBooks",
  on_demand_pricing: "RealTime Pricing",
  crm: "CRM",
};

/** feedback_submissions.status, in the words My Requests shows (FB_STATUS in 04-orders.jsx). */
const REQUEST_STATUS: Record<string, string> = {
  submitted: "Submitted",
  in_review: "In review",
  planned: "Planned",
  in_progress: "In progress",
  needs_info: "Needs your info",
  shipped: "Completed",
  declined: "Not planned",
  duplicate: "Already tracked",
};

const empty = { type: "object", properties: {}, required: [], additionalProperties: false } as const;

/** What Claude is offered. Strict: the arguments always match the schema exactly. */
export const TOOL_DEFS = [
  {
    name: "get_account_overview",
    description:
      "This builder's own account: business name; the signed-in person's first name, job title and which areas they can view; " +
      "the setup checklist steps still open (and which are padlocked add-ons); which add-ons are active; whether GoHighLevel, " +
      "QuickBooks, their own email domain, texting and the phone are set up; testing (beta) mode; whether customers see prices; " +
      "how quotes and invoices go out; and which per-account betas they have (the Library, making a door from a photo). " +
      "Use it for any question about what is set, missing or switched on in THEIR account, and before telling them about a beta.",
    strict: true,
    input_schema: empty,
  },
  {
    name: "get_catalog_summary",
    description:
      "This builder's own catalog: each building style with how many sizes are offered and how many have no price yet, whether " +
      "its 3D look is set, and counts of active doors, windows and colors. Needs the person's access to include Sheds.",
    strict: true,
    input_schema: empty,
  },
  {
    name: "get_my_requests",
    description:
      "The problem reports, feature requests and tickets this builder's team has sent us, newest first, with their status " +
      "and when the team last replied. The same list as Support > My Requests.",
    strict: true,
    input_schema: empty,
  },
  {
    name: "search_whats_new",
    description:
      "Search Structure Studio's release notes (new features, fixes, roadmap) for a word or phrase. Use it before saying " +
      "whether something exists, has shipped, or is planned. Entries on beta are being tested and not yet live for everyone.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "A word or short phrase, e.g. \"door\" or \"QuickBooks\"." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "offer_handoff",
    description:
      "Offer to send this conversation to a person on the Structure Studio team as a ticket. Use it when the builder reports " +
      "something broken, asks for something the product does not do, asks for a person, or you cannot answer. It changes " +
      "nothing by itself: the builder sees a \"Send this to our team\" button with your title and summary, and decides. " +
      "Call it AFTER any account lookups you need, never alongside them, so the summary says what you found.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A one-line title for the ticket, under 100 characters." },
        summary: { type: "string", description: "What the builder needs, in two to five plain sentences, for the person who picks it up." },
      },
      required: ["title", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "note_gap",
    description:
      "Record a question you could not answer from the knowledge or the account tools, so the team can add the answer to " +
      "what you know. Use it whenever you say you're not sure, or offer a hand-off because you lacked the information " +
      "(not for a bug report or a feature request). The builder never sees it. Call it once per question, alongside your answer.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in a few plain words, with no names, emails, phone numbers or customer details, e.g. \"How to export a price list\"." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

export interface ToolOutcome {
  /** JSON text handed back to Claude as the tool_result. */
  content: string;
  isError: boolean;
  /** offer_handoff only: what the portal's card shows. */
  handoff?: { title: string; summary: string };
  /** note_gap only: the question it could not answer, stored on the answer (migration 348). */
  gap?: string;
}

const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data), isError: false });
const err = (message: string): ToolOutcome => ({ content: JSON.stringify({ error: message }), isError: true });

/** Run one tool. Never throws: a database fault becomes an error result Claude can explain. */
export async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "get_account_overview": return await accountOverview(ctx);
      case "get_catalog_summary": return await catalogSummary(ctx);
      case "get_my_requests": return await myRequests(ctx);
      case "search_whats_new": return await whatsNew(ctx, input);
      case "offer_handoff": return handoff(input);
      case "note_gap": return noteGap(input);
      default:
        // Sonnet occasionally calls a declared tool by a near-miss name; say the exact names.
        return err(`Unknown tool "${String(name).slice(0, 60)}". The tools are: ${TOOL_DEFS.map((t) => t.name).join(", ")}.`);
    }
  } catch {
    // Never the raw database message: it can quote row values.
    return err("That lookup failed. Tell the builder you could not check right now, and offer to send it to the team.");
  }
}

async function accountOverview(ctx: ToolCtx): Promise<ToolOutcome> {
  const { db, clientId, userId } = ctx;
  const [settingsRes, meRes, stepsRes] = await Promise.all([
    db.from("client_settings")
      .select("business_name, ghl_location_id, ghl_api_key, qbo_realm_id, qbo_connected_at, email_domain_status, email_provider, sms_status, phone_status, beta_mode, show_pricing, invoice_in_ghl, rtp_enabled, payments_online_enabled, library_beta, door_looks_beta")
      .eq("client_id", clientId).maybeSingle(),
    db.from("client_users").select("full_name, title, role")
      .eq("client_id", clientId).eq("user_id", userId).maybeSingle(),
    db.from("tenant_setup_items").select("title, section, link_page, completed_at, template_item_id, position")
      .eq("client_id", clientId).order("position"),
  ]);
  if (settingsRes.error || meRes.error || stepsRes.error) throw new Error("read failed");
  const s = settingsRes.data ?? {};
  const me = meRes.data ?? {};

  // The checklist exactly as Support > Getting set up shows it (portal-setup's list): a step we have
  // not finished building is hidden, a step needing an add-on they lack is padlocked unless done.
  // deno-lint-ignore no-explicit-any
  const rows: any[] = stepsRes.data ?? [];
  const tplIds = [...new Set(rows.map((r) => r.template_item_id).filter(Boolean))];
  const gate = new Map<string, { requires: string | null; visible: boolean }>();
  if (tplIds.length) {
    const tpl = await db.from("setup_template_items").select("id, requires_feature, builder_visible").in("id", tplIds);
    if (tpl.error) throw new Error("read failed");
    // deno-lint-ignore no-explicit-any
    for (const t of (tpl.data ?? []) as any[]) gate.set(t.id, { requires: t.requires_feature || null, visible: t.builder_visible !== false });
  }
  const wanted = Object.keys(ADD_ONS);
  const needed = [...new Set([...gate.values()].map((g) => g.requires).filter(Boolean))] as string[];
  let usable: Set<string>;
  try {
    usable = await ctx.features([...new Set([...wanted, ...needed])]);
  } catch {
    usable = new Set();
  }
  const steps = rows
    .filter((r) => { const g = r.template_item_id ? gate.get(r.template_item_id) : null; return !(g && !g.visible); })
    .map((r) => {
      const g = r.template_item_id ? gate.get(r.template_item_id) : null;
      const locked = !!(g && g.requires) && !usable.has(g.requires!) && !r.completed_at;
      return { title: cap(r.title), section: cap(r.section), page: r.link_page ? `/${String(r.link_page).slice(0, 60)}` : null, done: !!r.completed_at, locked };
    });

  const areas = AREAS.filter((a) => !a.internalOnly && canRead(ctx.access, a.key)).map((a) => a.label);
  const firstName = String(me.full_name || "").trim().split(/\s+/)[0] || null;
  // email_domain_status is NOT NULL DEFAULT 'not_configured'; sending from the domain is a separate
  // tick after verifying (portal-settings email_activate sets email_provider to "resend").
  const domain = s.email_domain_status === "verified"
    ? (s.email_provider === "resend" ? "verified, and estimates send from it" : "verified, but \"Send estimate & invoice emails from my domain\" is not ticked yet")
    : s.email_domain_status === "pending" ? "set up, not verified yet"
    : s.email_domain_status === "failed" ? "set up, but verification failed"
    : "not set up";

  return ok({
    businessName: cap(s.business_name),
    you: { firstName: cap(firstName, 60), jobTitle: cap(me.title || me.role, 40), canView: areas },
    setup: {
      open: steps.filter((x) => !x.done && !x.locked).map(({ title, section, page }) => ({ title, section, page })),
      padlocked: steps.filter((x) => x.locked).map(({ title }) => title),
      done: steps.filter((x) => x.done).length,
      total: steps.filter((x) => !x.locked).length,
    },
    addOnsActive: wanted.filter((f) => usable.has(f)).map((f) => ADD_ONS[f]),
    connections: {
      goHighLevel: !!(s.ghl_location_id && s.ghl_api_key),
      quickBooks: !!(s.qbo_realm_id && s.qbo_connected_at),
      ownEmailDomain: domain,
      texting: cap(s.sms_status, 40) || "not set up",
      phone: cap(s.phone_status, 40) || "not set up",
      onlinePayments: !!s.payments_online_enabled,
    },
    testingBetaModeOn: !!s.beta_mode,
    customersSeePrices: !!s.show_pricing,
    quotesAndInvoicesGoOutThrough: s.invoice_in_ghl === false ? "Structure Studio" : "their CRM (GoHighLevel)",
    realTimePricingLive: !!s.rtp_enabled,
    // Per-account betas (339 library_beta, 343 door_looks_beta), off by default. Making a door from a
    // photo also needs the Library: its card sits inside the Library card (03-catalog.jsx).
    betaFeatures: { library: s.library_beta === true, doorFromPhoto: s.library_beta === true && s.door_looks_beta === true },
  });
}

async function catalogSummary(ctx: ToolCtx): Promise<ToolOutcome> {
  if (!canRead(ctx.access, "settings_structures")) {
    return ok({ noAccess: "This person's access does not include Sheds, so you cannot look at the catalog for them. An owner or admin can, or can change their access in Settings > Company > Team." });
  }
  const { db, clientId } = ctx;
  const [styles, sizes, fixtures, colors] = await Promise.all([
    db.from("building_styles").select("id, label, active, d3, model_status").eq("client_id", clientId).order("sort_order"),
    db.from("building_sizes").select("style_id, base_price, active").eq("client_id", clientId),
    db.from("fixture_items").select("category, active, archived").eq("client_id", clientId),
    db.from("colors").select("siding, trim, door, shingle, metal, active").eq("client_id", clientId),
  ]);
  if (styles.error || sizes.error || fixtures.error || colors.error) throw new Error("read failed");
  // deno-lint-ignore no-explicit-any
  const sz: any[] = sizes.data ?? [];
  // deno-lint-ignore no-explicit-any
  const fx: any[] = (fixtures.data ?? []).filter((f: any) => f.active !== false && !f.archived);
  // deno-lint-ignore no-explicit-any
  const cl: any[] = (colors.data ?? []).filter((c: any) => c.active !== false);
  return ok({
    // deno-lint-ignore no-explicit-any
    styles: (styles.data ?? []).slice(0, 60).map((st: any) => {
      const mine = sz.filter((x) => x.style_id === st.id);
      return {
        name: cap(st.label, 80),
        active: st.active !== false,
        // A blank base price hides the size from the designer; 0 is "included". See the FAQ.
        sizesOffered: mine.filter((x) => x.active !== false && x.base_price != null).length,
        sizesWithNoPrice: mine.filter((x) => x.base_price == null).length,
        look3dSet: st.d3 != null && typeof st.d3 === "object" && Object.keys(st.d3).length > 0,
        uploaded3dModel: cap(st.model_status, 30),
      };
    }),
    doors: fx.filter((f) => f.category === "door").length,
    windows: fx.filter((f) => f.category === "window").length,
    otherItems: fx.filter((f) => f.category !== "door" && f.category !== "window").length,
    colors: {
      paint: cl.filter((c) => c.siding || c.trim || c.door).length,
      shingle: cl.filter((c) => c.shingle).length,
      metal: cl.filter((c) => c.metal).length,
    },
  });
}

async function myRequests(ctx: ToolCtx): Promise<ToolOutcome> {
  const { db, clientId } = ctx;
  const rows = await db.from("feedback_submissions")
    .select("id, kind, title, status, created_at, status_changed_at")
    .eq("client_id", clientId).order("created_at", { ascending: false }).limit(20);
  if (rows.error) throw new Error("read failed");
  // deno-lint-ignore no-explicit-any
  const list: any[] = rows.data ?? [];
  const ids = list.map((r) => r.id);
  const lastReply = new Map<string, string>();
  if (ids.length) {
    // feedback_comments has no client_id; it hangs off submissions already scoped to this tenant.
    // Re-scoped through the join so the filter is on the query itself, not only on the id list.
    const cs = await db.from("feedback_comments").select("submission_id, created_at, author_kind, feedback_submissions!inner(client_id)")
      .in("submission_id", ids).eq("feedback_submissions.client_id", clientId).order("created_at", { ascending: true });
    if (cs.error) throw new Error("read failed");
    // deno-lint-ignore no-explicit-any
    for (const c of (cs.data ?? []) as any[]) if (c.author_kind !== "client") lastReply.set(c.submission_id, c.created_at);
  }
  return ok({
    requests: list.map((r) => ({
      kind: r.kind === "bug" ? "problem report" : r.kind === "feature" ? "feature request" : "ticket",
      title: cap(r.title),
      status: REQUEST_STATUS[r.status] || "Submitted",
      sent: String(r.created_at || "").slice(0, 10),
      teamLastReplied: lastReply.has(r.id) ? String(lastReply.get(r.id)).slice(0, 10) : null,
    })),
  });
}

async function whatsNew(ctx: ToolCtx, input: unknown): Promise<ToolOutcome> {
  const raw = String((input as { query?: unknown } | null)?.query ?? "").trim().slice(0, 60);
  // ilike's own wildcards and PostgREST's or() separators are stripped: the words are a search, never syntax.
  const words = raw.replace(/[%_,().*\\"]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 4);
  if (!words.length) return err("Give a word or short phrase to search for.");
  const or = words.flatMap((w) => [`title.ilike.%${w}%`, `detail.ilike.%${w}%`]).join(",");
  const res = await ctx.db.from("release_notes")
    .select("title, detail, kind, status, section, released_at")
    .or(or).order("released_at", { ascending: false }).limit(8);
  if (res.error) throw new Error("read failed");
  const STATUS: Record<string, string> = { beta: "on beta for testing", roadmap: "on the roadmap", planned: "planned", requested: "requested", shipped: "live" };
  return ok({
    // deno-lint-ignore no-explicit-any
    results: (res.data ?? []).map((r: any) => ({
      title: cap(r.title),
      detail: cap(r.detail, 500),
      kind: r.kind === "fix" ? "bug fix" : r.kind === "requested" ? "roadmap" : "feature",
      status: STATUS[r.status] || "live",
      area: cap(r.section, 40),
      date: String(r.released_at || "").slice(0, 10),
    })),
  });
}

function handoff(input: unknown): ToolOutcome {
  const i = (input ?? {}) as { title?: unknown; summary?: unknown };
  const title = String(i.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const summary = String(i.summary ?? "").trim().slice(0, 1500);
  if (!title || !summary) return err("offer_handoff needs a title and a summary.");
  return {
    content: JSON.stringify({ ok: true, note: "The builder now sees a \"Send this to our team\" button with this title and summary. Tell them they can press it; a person replies within 24 hours." }),
    isError: false,
    handoff: { title, summary },
  };
}

/** The gap column holds 300 characters (348); several notes in one answer share it. */
export const GAP_CHARS = 300;

function noteGap(input: unknown): ToolOutcome {
  const q = String((input as { question?: unknown } | null)?.question ?? "").replace(/\s+/g, " ").trim().slice(0, GAP_CHARS);
  if (!q) return err("note_gap needs the question.");
  return { content: JSON.stringify({ ok: true, note: "Noted for the team. Now answer the builder." }), isError: false, gap: q };
}
