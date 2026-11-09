// portal-settings: Jack's two look-up reads (migration 376, plan sections 5.3 to 5.5). READ ONLY.
//
//   crm_customer_facts   contacts:view, and the crm_ prefix brings the Customer Hub subscription check.
//                        Every customer this caller may see, with what Jack needs to answer "who's gone
//                        quiet" and "who hasn't bought": their deals by status EVENT, the quote dates,
//                        STOP and Do Not Disturb, the last time each side spoke, the next appointment.
//   orders_overview      orders:view, the same gate as orders_designs. Every StructureStudio order with
//                        its money worked out the Orders tab's way, and its build and delivery facts.
//
// THE RULES (jackReads_test.ts pins each one)
//   - Narrowed exactly as crm_deals_list and orders_designs narrow: visibleContactIds for customers,
//     visibleDesignRows for orders. A failed scope check is a 500, never "everyone".
//   - No phone number, email address or street line leaves this file. hasPhone and hasEmail are
//     booleans; the town may go (Ahsan's default, 11-06). The order list carries the customer's name
//     from the design and nothing else of the contact blob.
//   - All or nothing. A list longer than this action reads in one call answers complete:false and no
//     rows, so Jack never counts from part of a list. A failed sub-read is a 500.
//   - A fact behind another area is there only when the caller can read that area, and the key is
//     ABSENT otherwise (seen.* says which): appointments with meetings (host-narrowed for 'own'),
//     calls with phone (team level only), build with build_schedule, delivery with delivery_schedule.
//     Jack then says "your access doesn't show the schedule", never "nothing scheduled".
//   - It writes nothing. withContacts heals a deal that points at a merged contact; this only follows
//     the merge.
//
// The tenant is resolveTenant's; nothing here reads a client id from the body.

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = any;

export interface JackReadCtx {
  admin: Db;
  req: Request;
  clientId: string;
  action: string;
  payload: Record<string, unknown>;
  json: (b: unknown, s?: number) => Response;
  dbFail: (req: Request, clientId: string | null, where: string, err: unknown, status?: number) => Response;
  canRead: (area: string) => boolean;
  /** ownMeetingsOnly(access): appointments narrowed to the ones this person hosts. */
  meetingsOwnOnly: boolean;
  /** ownPhoneOnly(access): calls are counted only for someone who sees the whole team's. */
  phoneOwnOnly: boolean;
  /** Whose data this is (resolveTenant's selfUserId). */
  selfUserId: string | null;
  visibleContactIds: (ids: (string | null | undefined)[]) => Promise<Set<string> | null>;
  visibleDesignRows: <T extends { contact_id?: string | null }>(rows: T[]) => Promise<T[] | null>;
  now?: () => number;
}

/** PostgREST answers at most this many rows a request. */
export const PAGE = 1000;
/** The most customers one crm_customer_facts call reads before it says complete:false. */
export const MAX_CONTACTS = 5000;
/** The most deals, and the most orders, one call reads. */
export const MAX_DEALS = 20000;
export const MAX_ORDERS = 5000;
/** Ids per `in (...)`: the filter rides in the URL. */
export const CHUNK = 200;
/** Ids per touch-facts call. */
export const TOUCH_CHUNK = 1000;
const POOL = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{1,40}$/;

class ReadError extends Error {
  constructor(public where: string, public dbError: unknown) { super(where); }
}
class TooMany extends Error {}

async function must(p: PromiseLike<{ data: unknown; error: unknown }>, where: string): Promise<Row[]> {
  const r = await p;
  if (r.error) throw new ReadError(where, r.error);
  return Array.isArray(r.data) ? r.data : [];
}

/** Every row a query has, a page at a time, up to `cap`. Past the cap: TooMany. */
async function pageAll(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, where: string, cap: number): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await must(q(from, from + PAGE - 1), where);
    out.push(...rows);
    if (out.length > cap) throw new TooMany();
    if (rows.length < PAGE) return out;
  }
}

/** A few at a time, so one look-up doesn't open dozens of requests at once. */
async function pool<T, R>(items: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Rows for a list of ids, in chunks, each chunk paged. */
async function pagedIn(ids: string[], q: (chunk: string[], from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, where: string, cap = MAX_DEALS): Promise<Row[]> {
  const parts = await pool(chunks([...new Set(ids)], CHUNK), (c) => pageAll((f, t) => q(c, f, t), where, cap));
  const all = parts.flat();
  if (all.length > cap) throw new TooMany();
  return all;
}

const iso = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const text = (v: unknown, max = 120): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : null;
};

// ── Money, the Orders tab's way ──────────────────────────────────────────────────────────────────
// portal/04-orders.jsx: `paid` counts money that is not voided, not still clearing and not returned;
// `pending` is clearing bank money, apart; balOf is null when the order has no total yet (never $0).
// A refund already lowered amount_cents (349), so it needs nothing here.

export interface PaymentRow { amount_cents?: number | null; funding_state?: string | null; voided_at?: string | null }

export function orderMoney(totalCents: number | null | undefined, pays: PaymentRow[]): { settledCents: number; pendingCents: number; balanceCents: number | null } {
  let settledCents = 0, pendingCents = 0;
  for (const p of pays) {
    if (p.voided_at) continue;
    const c = Number(p.amount_cents) || 0;
    if (p.funding_state === "pending") pendingCents += c;
    else if (p.funding_state !== "returned") settledCents += c;
  }
  const total = totalCents === null || totalCents === undefined ? null : Number(totalCents);
  return { settledCents, pendingCents, balanceCents: total === null || !Number.isFinite(total) ? null : total - settledCents };
}

// ── On the lot since ─────────────────────────────────────────────────────────────────────────────
// A unit rides a HAUL stop to a lot and, once sold, a SALE stop to the buyer (inventoryLifecycle.ts).
// It reached the lot it's on when its latest delivered haul stop was delivered. The sale stop never
// counts: it says where the building went, not that it arrived on a lot.

export function atLocationSince(soldDesignShortCode: string | null, stops: { design_short_code?: string | null; delivered_at?: string | null }[]): string | null {
  let best: string | null = null;
  for (const s of stops) {
    const isSale = !!soldDesignShortCode && s.design_short_code === soldDesignShortCode;
    if (isSale || !s.delivered_at) continue;
    if (best === null || Date.parse(s.delivered_at) > Date.parse(best)) best = s.delivered_at;
  }
  return best;
}

// ── The dispatcher ───────────────────────────────────────────────────────────────────────────────

export const JACK_READ_ACTIONS = new Set(["crm_customer_facts", "orders_overview"]);

export async function handleJackRead(x: JackReadCtx): Promise<Response> {
  try {
    if (x.action === "crm_customer_facts") return await customerFacts(x);
    if (x.action === "orders_overview") return await ordersOverview(x);
    return x.json({ error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof TooMany) return x.json({ ok: true, complete: false, ...(x.action === "orders_overview" ? { orders: [] } : { contacts: [] }) });
    if (e instanceof ReadError) return x.dbFail(x.req, x.clientId, e.where, e.dbError ?? { message: e.where });
    throw e;
  }
}

// ── crm_customer_facts ───────────────────────────────────────────────────────────────────────────

const CONTACT_COLS = "id, name, company, city, source, created_at, phone, phone_digits, email, sms_opt_out_at, dnd_all_at, dnd_email_at, dnd_email_source, dnd_calls_at";
const DEAL_COLS = "id, pipeline_id, status_id, contact_id, short_code, value_cents, lost_at, lost_reason, won_at, stage_entered_at, created_at";
const DESIGN_COLS = "short_code, status, total_cents, ss_quote_number, ghl_estimate_number, ss_quote_sent_at, accepted_at, ss_invoice_sent_at, ss_invoice_requested_at, delivered_at, inventory_unit_id, created_at, updated_at, sel_style:selections->>style, sel_size:selections->>size";

/** A name search term with nothing PostgREST would read as grammar, or null when too short. */
export function cleanTerm(v: unknown): string | null {
  const s = String(v ?? "").replace(/[^\p{L}\p{N} '-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s.length >= 2 ? s : null;
}

async function customerFacts(x: JackReadCtx): Promise<Response> {
  const { admin, clientId, payload: p, json } = x;
  const now = x.now ? x.now() : Date.now();
  const term = p.nameLike === undefined || p.nameLike === null ? null : cleanTerm(p.nameLike);
  if (p.nameLike !== undefined && p.nameLike !== null && !term) return json({ error: "Give at least two letters of the name." }, 400);
  const askedIds = Array.isArray(p.contactIds) ? [...new Set(p.contactIds.map((v) => String(v ?? "").toLowerCase()))] : null;
  if (askedIds && (askedIds.length > 500 || askedIds.some((v) => !UUID.test(v)))) return json({ error: "Up to 500 customer ids." }, 400);
  const whole = !term && !askedIds;

  // 1. The customers. Merged records are left out: their history moved to the record they were merged into.
  let contacts: Row[];
  if (term) {
    // Initials only ("J R") leave no word of two letters: the whole term is the pattern then. With no
    // pattern at all, the name read had no filter and answered the 50 latest customers as "matches".
    const long = term.split(" ").filter((w) => w.length >= 2).slice(0, 4);
    const words = long.length ? long : [term];
    let byName = admin.from("crm_contacts").select(CONTACT_COLS).eq("client_id", clientId).is("merged_into", null);
    for (const w of words) byName = byName.ilike("name", `%${w}%`);
    const [a, b] = await Promise.all([
      must(byName.order("updated_at", { ascending: false }).limit(50), "find that customer"),
      must(admin.from("crm_contacts").select(CONTACT_COLS).eq("client_id", clientId).is("merged_into", null)
        .ilike("company", `%${term}%`).order("updated_at", { ascending: false }).limit(50), "find that customer"),
    ]);
    const seen = new Set<string>();
    contacts = [...a, ...b].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  } else if (askedIds) {
    contacts = askedIds.length
      ? await pagedIn(askedIds, (c, f, t) => admin.from("crm_contacts").select(CONTACT_COLS).eq("client_id", clientId).is("merged_into", null).in("id", c).order("id").range(f, t), "load these customers", MAX_CONTACTS)
      : [];
  } else {
    contacts = await pageAll((f, t) => admin.from("crm_contacts").select(CONTACT_COLS).eq("client_id", clientId).is("merged_into", null).order("id").range(f, t), "load your customers", MAX_CONTACTS);
  }

  // 2. Only the ones this caller may see. Never "everyone" on a failed check.
  const seen = await x.visibleContactIds(contacts.map((c) => c.id));
  if (!seen) return x.dbFail(x.req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
  contacts = contacts.filter((c) => seen.has(c.id));
  if (term) contacts = contacts.slice(0, 10);
  const meetingsSeen = x.canRead("meetings");
  const callsSeen = x.canRead("phone") && !x.phoneOwnOnly;
  if (!contacts.length) return json({ ok: true, complete: true, contacts: [], seen: { meetings: meetingsSeen, calls: callsSeen } });
  const ids = contacts.map((c) => c.id as string);
  const idSet = new Set(ids);

  // 3. Merged records whose deals belong to these customers now (followed, bounded, never written).
  const tombs = whole
    ? await pageAll((f, t) => admin.from("crm_contacts").select("id, merged_into").eq("client_id", clientId).not("merged_into", "is", null).order("id").range(f, t), "load merged customers", MAX_CONTACTS * 4)
    : await (async () => {
      const out: Row[] = [];
      let frontier = ids;
      for (let hop = 0; hop < 5 && frontier.length; hop++) {
        const rows = await pagedIn(frontier, (c, f, t) => admin.from("crm_contacts").select("id, merged_into").eq("client_id", clientId).in("merged_into", c).order("id").range(f, t), "load merged customers");
        out.push(...rows);
        frontier = rows.map((r) => r.id as string);
      }
      return out;
    })();
  const mergedInto = new Map<string, string>(tombs.map((t) => [t.id as string, t.merged_into as string]));
  const survivor = (id: string | null): string | null => {
    let cur = id;
    for (let hop = 0; cur && mergedInto.has(cur) && hop < 5; hop++) cur = mergedInto.get(cur) ?? null;
    return cur;
  };

  const digits = [...new Set(contacts.map((c) => c.phone_digits).filter((d) => typeof d === "string" && d))] as string[];
  const [statuses, pipelines, dealRows, optOuts, consents, meetings, touches] = await Promise.all([
    must(admin.from("crm_statuses").select("id, pipeline_id, name, position, trigger_event, archived_at").eq("client_id", clientId), "load your statuses"),
    must(admin.from("crm_pipelines").select("id, name, archived_at").eq("client_id", clientId), "load your pipelines"),
    whole
      ? pageAll((f, t) => admin.from("crm_deals").select(DEAL_COLS).eq("client_id", clientId).is("archived_at", null).order("id").range(f, t), "load the deals", MAX_DEALS)
      : pagedIn([...ids, ...tombs.map((t) => t.id as string)], (c, f, t) => admin.from("crm_deals").select(DEAL_COLS).eq("client_id", clientId).is("archived_at", null).in("contact_id", c).order("id").range(f, t), "load the deals"),
    digits.length ? pagedIn(digits, (c, f, t) => admin.from("sms_opt_outs").select("phone_digits, reason, effective_at").eq("client_id", clientId).in("phone_digits", c).order("phone_digits").range(f, t), "check who opted out of texts") : Promise.resolve([] as Row[]),
    digits.length ? pagedIn(digits, (c, f, t) => admin.from("sms_consent_log").select("phone_digits").eq("client_id", clientId).eq("action", "granted").in("phone_digits", c).order("phone_digits").range(f, t), "check who agreed to texts", MAX_CONTACTS * 20) : Promise.resolve([] as Row[]),
    meetingsSeen ? nextMeetings(x, ids, now) : Promise.resolve(null),
    (async () => {
      const parts = await pool(chunks(ids, TOUCH_CHUNK), async (c) => {
        const { data, error } = await admin.rpc("crm_contact_touch_facts", { p_client: clientId, p_ids: c, p_calls: callsSeen });
        if (error) throw new ReadError("check when you last spoke", error);
        return Array.isArray(data) ? data as Row[] : [];
      });
      return parts.flat();
    })(),
  ]);

  // Statuses by id, with the first live one of each pipeline (New Lead is the first by POSITION).
  const statusById = new Map<string, Row>(statuses.map((s) => [s.id as string, s]));
  const firstOf = new Map<string, string>();
  for (const s of [...statuses].filter((s) => !s.archived_at).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))) {
    const key = String(s.pipeline_id ?? "");
    if (!firstOf.has(key)) firstOf.set(key, s.id);
  }
  const pipeName = new Map<string, string>(pipelines.map((pp) => [pp.id as string, pp.name as string]));

  // Deals onto their (surviving) customer, and the designs they carry.
  const deals = dealRows.map((d) => ({ ...d, contact_id: survivor(d.contact_id ?? null) })).filter((d) => d.contact_id && idSet.has(d.contact_id));
  const codes = [...new Set(deals.map((d) => d.short_code).filter((c) => typeof c === "string" && CODE.test(c)))] as string[];
  const designRows = codes.length
    ? await pagedIn(codes, (c, f, t) => admin.from("designs").select(DESIGN_COLS).eq("client_id", clientId).in("short_code", c).order("short_code").range(f, t), "load the deals' estimates")
    : [];
  const designs = new Map<string, Row>(designRows.map((d) => [d.short_code as string, d]));

  const optOut = new Map<string, Row>(optOuts.map((o) => [o.phone_digits as string, o]));
  const consented = new Set<string>(consents.map((c) => c.phone_digits as string));
  const touch = new Map<string, Row>(touches.map((t) => [String(t.contact_id), t]));
  const dealsOf = new Map<string, Row[]>();
  for (const d of deals) {
    if (d.short_code && !designs.has(d.short_code)) continue; // a card whose design is gone, as crm_deals_list
    const list = dealsOf.get(d.contact_id) ?? [];
    list.push(d);
    dealsOf.set(d.contact_id, list);
  }

  const out = contacts.map((c) => {
    const opt = c.phone_digits ? optOut.get(c.phone_digits) : undefined;
    const optedOut = !!opt || !!c.sms_opt_out_at;
    const t = touch.get(c.id);
    const row: Record<string, unknown> = {
      id: c.id,
      name: text(c.name),
      company: text(c.company),
      // The town only: never the street (Ahsan's default, 11-06).
      town: text(c.city, 60),
      source: text(c.source, 30),
      createdAt: iso(c.created_at),
      hasPhone: !!(c.phone_digits || text(c.phone)),
      hasEmail: !!text(c.email),
      textsOff: optedOut,
      textsOffReason: opt ? (opt.reason === "sms_stop" ? "stop" : opt.reason === "operator" ? "team" : "other") : optedOut ? "other" : null,
      textsConsented: !!c.phone_digits && consented.has(c.phone_digits),
      dndAll: !!c.dnd_all_at,
      emailOff: !!c.dnd_email_at,
      emailOffBy: c.dnd_email_at ? (c.dnd_email_source === "customer" ? "customer" : "builder") : null,
      callsOff: !!c.dnd_calls_at,
      lastInAt: iso(t?.last_in_at),
      lastInChannel: text(t?.last_in_channel, 10),
      lastOutAt: iso(t?.last_out_at),
      lastOutChannel: text(t?.last_out_channel, 10),
      deals: (dealsOf.get(c.id) ?? []).map((d) => {
        const st = d.status_id ? statusById.get(d.status_id) : undefined;
        const g = d.short_code ? designs.get(d.short_code) : null;
        return {
          id: d.id,
          pipelineName: text(pipeName.get(d.pipeline_id), 80),
          statusName: st ? text(st.name, 60) : null,
          statusEvent: st?.trigger_event ?? null,
          firstStatus: !!st && !st.archived_at && firstOf.get(String(st.pipeline_id ?? "")) === st.id,
          lostAt: iso(d.lost_at),
          lostReason: text(d.lost_reason, 80),
          wonAt: iso(d.won_at),
          createdAt: iso(d.created_at),
          stageEnteredAt: iso(d.stage_entered_at),
          shortCode: d.short_code ?? null,
          // A design card's value is the design's live total, as on the board.
          valueCents: g ? (g.total_cents ?? null) : (d.value_cents ?? null),
          design: g ? {
            status: g.status ?? null,
            quoteNumber: g.ss_quote_number || (g.ghl_estimate_number != null ? String(g.ghl_estimate_number) : null),
            quoteSentAt: iso(g.ss_quote_sent_at),
            acceptedAt: iso(g.accepted_at),
            invoiceSentAt: iso(g.ss_invoice_sent_at),
            invoiceRequestedAt: iso(g.ss_invoice_requested_at),
            deliveredAt: iso(g.delivered_at),
            style: text(g.sel_style, 60),
            size: text(g.sel_size, 30),
            lotBuilding: !!g.inventory_unit_id,
            createdAt: iso(g.created_at),
            updatedAt: iso(g.updated_at),
          } : null,
        };
      }),
    };
    // Absent, not null, when the caller can't see the calendar.
    if (meetings) row.nextMeetingAt = meetings.get(c.id) ?? null;
    return row;
  });
  return json({ ok: true, complete: true, contacts: out, seen: { meetings: meetingsSeen, calls: callsSeen } });
}

/** The next booked appointment per customer, crm_deals_list's way: soonest first, and only the ones this
 *  person hosts when their meetings access is 'own'. */
async function nextMeetings(x: JackReadCtx, ids: string[], now: number): Promise<Map<string, string>> {
  const me = UUID.test(String(x.selfUserId ?? "")) ? String(x.selfUserId).toLowerCase() : null;
  const out = new Map<string, string>();
  if (x.meetingsOwnOnly && !me) return out;
  const rows = await pagedIn(ids, (c, f, t) => {
    let q = x.admin.from("meetings").select("contact_id, starts_at").eq("client_id", x.clientId).eq("status", "booked")
      .gte("starts_at", new Date(now).toISOString()).in("contact_id", c);
    if (x.meetingsOwnOnly) q = q.eq("host_user_id", me);
    return q.order("starts_at", { ascending: true }).range(f, t);
  }, "load the appointments");
  for (const m of rows) {
    const at = iso(m.starts_at);
    if (!at) continue;
    const cur = out.get(m.contact_id);
    if (!cur || Date.parse(at) < Date.parse(cur)) out.set(m.contact_id, at);
  }
  return out;
}

// ── orders_overview ──────────────────────────────────────────────────────────────────────────────

const ORDER_COLS = "id, order_no, short_code, total_cents, ordered_at";
// The customer's NAME only, out of the design's contact blob: its phone and email never load here.
const ORDER_DESIGN_COLS = "short_code, contact_id, cname:contact->>name, status, ss_quote_number, ss_invoice_sent_at, ss_invoice_requested_at, inventory_unit_id, delivered_at, sel_style:selections->>style, sel_size:selections->>size";

async function ordersOverview(x: JackReadCtx): Promise<Response> {
  const { admin, clientId, payload: p, json } = x;
  const askedCodes = Array.isArray(p.shortCodes) ? [...new Set(p.shortCodes.map((v) => String(v ?? "").trim()))] : null;
  if (askedCodes && (askedCodes.length > CHUNK || askedCodes.some((c) => !CODE.test(c)))) return json({ error: `Up to ${CHUNK} order codes.` }, 400);
  const buildSeen = x.canRead("build_schedule");
  const deliverySeen = x.canRead("delivery_schedule");
  const seenKeys = { build: buildSeen, delivery: deliverySeen };

  const orders = askedCodes
    ? (askedCodes.length ? await pagedIn(askedCodes, (c, f, t) => admin.from("orders").select(ORDER_COLS).eq("client_id", clientId).in("short_code", c).order("id").range(f, t), "load these orders", MAX_ORDERS) : [])
    : await pageAll((f, t) => admin.from("orders").select(ORDER_COLS).eq("client_id", clientId).order("ordered_at", { ascending: false }).order("id", { ascending: false }).range(f, t), "load your orders", MAX_ORDERS);
  if (!orders.length) return json({ ok: true, complete: true, orders: [], seen: seenKeys });

  const codes = [...new Set(orders.map((o) => o.short_code).filter((c) => typeof c === "string" && CODE.test(c)))] as string[];
  const designRows = codes.length
    ? await pagedIn(codes, (c, f, t) => admin.from("designs").select(ORDER_DESIGN_COLS).eq("client_id", clientId).in("short_code", c).order("short_code").range(f, t), "read the designs for these orders")
    : [];
  const visible = await x.visibleDesignRows(designRows as { contact_id?: string | null }[]);
  if (!visible) return x.dbFail(x.req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
  const byCode = new Map<string, Row>((visible as Row[]).map((d) => [d.short_code as string, d]));
  // StructureStudio orders only, as the Orders tab: the design carries an SS quote number, or the order
  // has no design at all. An order whose design this caller may not see is not theirs to list.
  const ss = orders.filter((o) => !o.short_code || (byCode.has(o.short_code) && byCode.get(o.short_code).ss_quote_number));
  if (!ss.length) return json({ ok: true, complete: true, orders: [], seen: seenKeys });
  const ssCodes = [...new Set(ss.map((o) => o.short_code).filter(Boolean))] as string[];
  const orderIds = ss.map((o) => o.id as string);

  const [pays, invoices, jobs, stops] = await Promise.all([
    pagedIn(orderIds, (c, f, t) => admin.from("payments").select("id, order_id, amount_cents, funding_state, voided_at").eq("client_id", clientId).in("order_id", c).order("id").range(f, t), "read the payments", MAX_ORDERS * 20),
    ssCodes.length ? pagedIn(ssCodes, (c, f, t) => admin.from("invoice_sends").select("short_code, signed_at").eq("client_id", clientId).in("short_code", c).order("short_code").range(f, t), "read the invoices") : Promise.resolve([] as Row[]),
    buildSeen && ssCodes.length ? pagedIn(ssCodes, (c, f, t) => admin.from("build_jobs").select("id, design_short_code, stage_id, due_date, completed_at").eq("client_id", clientId).in("design_short_code", c).order("id").range(f, t), "read the build schedule") : Promise.resolve([] as Row[]),
    deliverySeen && ssCodes.length ? pagedIn(ssCodes, (c, f, t) => admin.from("delivery_stops").select("id, design_short_code, delivered_at, load_id").eq("client_id", clientId).in("design_short_code", c).order("id").range(f, t), "read the delivery schedule") : Promise.resolve([] as Row[]),
  ]);
  const stageIds = [...new Set(jobs.map((j) => j.stage_id).filter(Boolean))] as string[];
  const loadIds = [...new Set(stops.map((s) => s.load_id).filter(Boolean))] as string[];
  const [stages, loads] = await Promise.all([
    stageIds.length ? pagedIn(stageIds, (c, f, t) => admin.from("schedule_stages").select("id, name, kind").eq("client_id", clientId).in("id", c).order("id").range(f, t), "read the build stages") : Promise.resolve([] as Row[]),
    loadIds.length ? pagedIn(loadIds, (c, f, t) => admin.from("delivery_loads").select("id, status, load_date").eq("client_id", clientId).in("id", c).order("id").range(f, t), "read the delivery loads") : Promise.resolve([] as Row[]),
  ]);

  const paysOf = new Map<string, Row[]>();
  for (const pay of pays) {
    const list = paysOf.get(pay.order_id) ?? [];
    list.push(pay);
    paysOf.set(pay.order_id, list);
  }
  const signedAt = new Map<string, string | null>(invoices.map((i) => [i.short_code as string, iso(i.signed_at)]));
  const stageById = new Map<string, Row>(stages.map((s) => [s.id as string, s]));
  const loadById = new Map<string, Row>(loads.map((l) => [l.id as string, l]));
  const jobOf = new Map<string, Row>();
  for (const j of jobs) if (!jobOf.has(j.design_short_code)) jobOf.set(j.design_short_code, j);
  const stopsOf = new Map<string, Row[]>();
  for (const s of stops) {
    const list = stopsOf.get(s.design_short_code) ?? [];
    list.push(s);
    stopsOf.set(s.design_short_code, list);
  }

  const out = ss.map((o) => {
    const d = o.short_code ? byCode.get(o.short_code) : null;
    const money = orderMoney(o.total_cents, paysOf.get(o.id) ?? []);
    const status = d ? (d.status ?? null) : null;
    const signed = o.short_code ? signedAt.get(o.short_code) ?? null : null;
    // SOLD = INVOICED (Carolyn 2026-08-08). An order with no design is StructureStudio's own paperwork.
    const sold = !d || status === "invoiced" || status === "delivered";
    const row: Record<string, unknown> = {
      id: o.id,
      orderNo: o.order_no ?? null,
      shortCode: o.short_code ?? null,
      name: d ? text(d.cname, 80) : null,
      building: d ? [text(d.sel_style, 60), text(d.sel_size, 30)].filter(Boolean).join(" ") || null : null,
      totalCents: o.total_cents ?? null,
      ...money,
      orderedAt: iso(o.ordered_at),
      // When it was sold: the customer's signature on the invoice, else (an older order) when it was
      // ordered, and soldAtFrom says which. Null while it isn't sold.
      soldAt: sold ? (signed ?? iso(o.ordered_at)) : null,
      soldAtFrom: sold ? (signed ? "signed" : o.ordered_at ? "ordered" : null) : null,
      designStatus: status,
      sold,
      // An SS invoice that is out and not signed leaves the design 'accepted' (portal-settings send_invoice).
      invoiceOut: status === "accepted" && !!d?.ss_invoice_sent_at,
      invoiceRequested: status === "accepted" && !d?.ss_invoice_sent_at && !!d?.ss_invoice_requested_at,
      // Quoted from a building already on a lot: no new build (the build board's tray rule).
      lotSale: !!d?.inventory_unit_id,
    };
    if (buildSeen) {
      const j = o.short_code ? jobOf.get(o.short_code) : null;
      const st = j?.stage_id ? stageById.get(j.stage_id) : null;
      row.build = j ? { stageName: text(st?.name, 60), stageKind: st?.kind ?? null, dueDate: iso(j.due_date), completedAt: iso(j.completed_at) } : null;
    }
    if (deliverySeen) {
      const list = o.short_code ? stopsOf.get(o.short_code) ?? [] : [];
      const done = list.find((s) => s.delivered_at);
      const pending = list.find((s) => !s.delivered_at && s.load_id);
      const load = pending ? loadById.get(pending.load_id) : null;
      const deliveredAt = iso(done?.delivered_at) ?? iso(d?.delivered_at);
      row.delivery = deliveredAt || pending
        ? { deliveredAt, loadStatus: load ? text(load.status, 30) : null, loadDate: load ? iso(load.load_date) : null }
        : null;
    }
    return row;
  });
  return json({ ok: true, complete: true, orders: out, seen: seenKeys });
}
