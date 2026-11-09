// jackReads.ts against an in-memory PostgREST that knows each table's real columns (a select naming a
// column the table doesn't have answers 42703, as live does) and answers at most 1000 rows a request.
// No network, no registry imports.

import { atLocationSince, handleJackRead, type JackReadCtx, MAX_CONTACTS, orderMoney, cleanTerm } from "./jackReads.ts";

function assert(ok: unknown, message = "expected a true value"): asserts ok {
  if (!ok) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message ? message + ": " : ""}expected ${e}, got ${a}`);
}

// ── The fake database ───────────────────────────────────────────────────────────────────────────

const SCHEMA: Record<string, string[]> = {
  crm_contacts: ["id", "client_id", "name", "company", "street", "city", "state", "zip", "source", "created_at", "updated_at", "phone", "phone_digits", "email", "sms_opt_out_at", "dnd_all_at", "dnd_email_at", "dnd_email_source", "dnd_calls_at", "dnd_inbound_at", "merged_into", "owner_user_id"],
  crm_statuses: ["id", "client_id", "pipeline_id", "name", "color", "position", "trigger_event", "archived_at"],
  crm_pipelines: ["id", "client_id", "name", "position", "archived_at"],
  crm_deals: ["id", "client_id", "pipeline_id", "stage_id", "status_id", "contact_id", "short_code", "title", "value_cents", "lost_at", "lost_reason", "won_at", "stage_entered_at", "created_at", "updated_at", "archived_at"],
  designs: ["short_code", "client_id", "contact_id", "contact", "status", "total_cents", "ss_quote_number", "ghl_estimate_number", "ss_quote_sent_at", "accepted_at", "ss_invoice_sent_at", "ss_invoice_requested_at", "delivered_at", "inventory_unit_id", "selections", "created_at", "updated_at"],
  sms_opt_outs: ["client_id", "phone_digits", "reason", "effective_at", "requested_at"],
  sms_consent_log: ["id", "client_id", "phone_digits", "contact_id", "action"],
  meetings: ["id", "client_id", "contact_id", "short_code", "starts_at", "ends_at", "status", "host_user_id", "type_id"],
  orders: ["id", "client_id", "order_no", "short_code", "total_cents", "ordered_at", "created_at"],
  payments: ["id", "client_id", "order_id", "amount_cents", "funding_state", "voided_at", "received_at"],
  invoice_sends: ["client_id", "short_code", "status", "signed_at", "created_at"],
  build_jobs: ["id", "client_id", "design_short_code", "inventory_unit_id", "stage_id", "due_date", "completed_at"],
  schedule_stages: ["id", "client_id", "name", "kind"],
  delivery_stops: ["id", "client_id", "design_short_code", "inventory_unit_id", "delivered_at", "load_id"],
  delivery_loads: ["id", "client_id", "status", "load_date"],
};

type R = Record<string, unknown>;
interface Db { tables: Record<string, R[]>; touch: R[]; fail: Set<string>; rpcFail?: boolean; requests: { table: string; select: string; filters: string[] }[]; rpcArgs: R[] }

function makeDb(tables: Partial<Record<string, R[]>>, touch: R[] = []): Db {
  const all: Record<string, R[]> = {};
  for (const t of Object.keys(SCHEMA)) all[t] = (tables[t] ?? []).map((r) => ({ client_id: "builder-a", ...r }));
  return { tables: all, touch, fail: new Set(), requests: [], rpcArgs: [] };
}

function adminOf(db: Db) {
  return {
    from(table: string) {
      const cols = SCHEMA[table];
      if (!cols) throw new Error(`no table ${table}`);
      let picks: { out: string; col: string; key: string | null }[] = [];
      let bad: string | null = null;
      const preds: ((r: R) => boolean)[] = [];
      const filters: string[] = [];
      const orders: { col: string; asc: boolean }[] = [];
      let from = 0, to = Number.POSITIVE_INFINITY;
      const q = {
        select(s: string) {
          picks = s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
            const [alias, rest] = x.includes(":") ? x.split(":") : [null, x];
            const [col, key] = rest.split("->>");
            if (!cols.includes(col)) bad = col;
            return { out: alias ?? col, col, key: key ?? null };
          });
          db.requests.push({ table, select: s, filters });
          return q;
        },
        eq(c: string, v: unknown) { filters.push(`${c}=${v}`); preds.push((r) => r[c] === v); return q; },
        is(c: string, v: null) { filters.push(`${c} is ${v}`); preds.push((r) => (r[c] ?? null) === v); return q; },
        not(c: string, op: string, v: null) { filters.push(`${c} not ${op} ${v}`); preds.push((r) => (r[c] ?? null) !== v); return q; },
        in(c: string, vs: unknown[]) { filters.push(`${c} in ${vs.length}`); const s = new Set(vs); preds.push((r) => s.has(r[c])); return q; },
        ilike(c: string, pat: string) {
          filters.push(`${c} ilike ${pat}`);
          const re = new RegExp("^" + pat.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
          preds.push((r) => re.test(String(r[c] ?? "")));
          return q;
        },
        gte(c: string, v: string) { preds.push((r) => String(r[c] ?? "") >= v); return q; },
        order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return q; },
        range(f: number, t: number) { from = f; to = t; return q; },
        limit(n: number) { to = from + n - 1; return q; },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }).then(resolve);
          if (db.fail.has(table)) return Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement" } }).then(resolve);
          let rows = db.tables[table].filter((r) => preds.every((p) => p(r)));
          rows = [...rows].sort((a, b) => {
            for (const o of orders) {
              const x = String(a[o.col] ?? ""), y = String(b[o.col] ?? "");
              if (x !== y) return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
            }
            return 0;
          });
          // PostgREST's max-rows: never more than 1000 in one answer.
          rows = rows.slice(from, Math.min(to + 1, from + 1000));
          const data = rows.map((r) => Object.fromEntries(picks.map((pk) => {
            const v = r[pk.col];
            return [pk.out, pk.key ? (v && typeof v === "object" ? ((v as R)[pk.key] ?? null) : null) : (v ?? null)];
          })));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
    rpc(name: string, args: R) {
      if (name !== "crm_contact_touch_facts") throw new Error(`no function ${name}`);
      db.rpcArgs.push(args);
      if (db.rpcFail) return Promise.resolve({ data: null, error: { code: "PGRST202", message: "function not found" } });
      const ids = new Set(args.p_ids as string[]);
      return Promise.resolve({ data: db.touch.filter((t) => ids.has(t.contact_id as string)), error: null });
    },
  };
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const fails: string[] = [];
const dbFail = (_r: Request, _c: string | null, where: string) => { fails.push(where); return json({ error: `Couldn't ${where}.` }, 500); };

function ctx(db: Db, action: string, payload: R = {}, over: Partial<JackReadCtx> = {}): JackReadCtx {
  return {
    admin: adminOf(db), req: new Request("http://x"), clientId: "builder-a", action, payload, json, dbFail,
    canRead: () => true, meetingsOwnOnly: false, phoneOwnOnly: false, selfUserId: "00000000-0000-4000-8000-0000000000aa",
    visibleContactIds: (ids) => Promise.resolve(new Set(ids.filter(Boolean) as string[])),
    visibleDesignRows: <T extends { contact_id?: string | null }>(rows: T[]) => Promise.resolve(rows),
    now: () => Date.parse("2026-11-06T12:00:00Z"),
    ...over,
  };
}
const run = async (c: JackReadCtx) => { const res = await handleJackRead(c); return { status: res.status, body: await res.json() }; };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = id(900), S_NEW = id(901), S_SENT = id(902), S_ACC = id(903), S_INV = id(904), S_HAND = id(905);

function crmWorld() {
  return makeDb({
    crm_pipelines: [{ id: P1, name: "Shed Deals", position: 1 }],
    // Renamed on purpose: nothing may key on a name.
    crm_statuses: [
      { id: S_NEW, pipeline_id: P1, name: "Fresh", position: 1, trigger_event: "design_submitted" },
      { id: S_SENT, pipeline_id: P1, name: "Quoted", position: 3, trigger_event: "estimate_sent" },
      { id: S_ACC, pipeline_id: P1, name: "Yes!", position: 4, trigger_event: "estimate_accepted" },
      { id: S_INV, pipeline_id: P1, name: "Sold", position: 5, trigger_event: "invoiced" },
      { id: S_HAND, pipeline_id: P1, name: "Called", position: 2, trigger_event: null },
    ],
    crm_contacts: [
      { id: id(1), name: "Dale Harper", company: null, street: "1234 N Main St", city: "Sedalia", source: "design", created_at: "2026-10-01T00:00:00Z", phone: "(816) 555-0100", phone_digits: "8165550100", email: "dale@example.com" },
      { id: id(2), name: "Rita Moss", city: "Warsaw", source: "captured_lead", created_at: "2026-10-20T00:00:00Z", phone: null, phone_digits: null, email: "rita@example.com", dnd_email_at: "2026-10-30T00:00:00Z", dnd_email_source: "customer" },
      { id: id(3), name: "Old Record", city: "Sedalia", created_at: "2026-01-01T00:00:00Z", phone_digits: "8165550199", merged_into: id(1) },
      { id: id(4), name: "Dana Other", city: "Clinton", created_at: "2026-09-01T00:00:00Z", phone_digits: "6605550142", sms_opt_out_at: null, dnd_all_at: "2026-10-01T00:00:00Z" },
    ],
    crm_deals: [
      { id: id(11), pipeline_id: P1, status_id: S_SENT, contact_id: id(1), short_code: "ABC123", value_cents: 1, created_at: "2026-10-01T00:00:00Z" },
      // On the merged record: it belongs to Dale now.
      { id: id(12), pipeline_id: P1, status_id: S_NEW, contact_id: id(3), short_code: null, value_cents: 250000, created_at: "2026-10-02T00:00:00Z" },
      { id: id(13), pipeline_id: P1, status_id: S_NEW, contact_id: id(2), short_code: null, value_cents: null, created_at: "2026-10-20T00:00:00Z" },
      { id: id(14), pipeline_id: P1, status_id: S_INV, contact_id: id(4), short_code: "GONE99", created_at: "2026-09-01T00:00:00Z" },
      { id: id(15), pipeline_id: P1, status_id: S_HAND, contact_id: id(4), short_code: null, archived_at: "2026-10-01T00:00:00Z" },
    ],
    designs: [
      { short_code: "ABC123", contact_id: id(1), contact: { name: "Dale Harper", phone: "(816) 555-0100", email: "dale@example.com" }, status: "sent", total_cents: 845000, ss_quote_number: "Q-1001", ss_quote_sent_at: "2026-10-25T00:00:00Z", selections: { style: "Lofted Barn", size: "12x24" }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" },
    ],
    sms_opt_outs: [{ phone_digits: "6605550142", reason: "sms_stop", effective_at: "2026-10-02T00:00:00Z" }],
    sms_consent_log: [{ phone_digits: "8165550100", action: "granted" }, { phone_digits: "8165550100", action: "granted" }],
    meetings: [
      { contact_id: id(1), starts_at: "2026-11-09T15:00:00Z", status: "booked", host_user_id: id(77) },
      { contact_id: id(1), starts_at: "2026-11-08T15:00:00Z", status: "booked", host_user_id: id(78) },
      { contact_id: id(2), starts_at: "2026-11-01T15:00:00Z", status: "booked", host_user_id: id(77) },
    ],
  }, [
    { contact_id: id(1), last_in_at: "2026-10-26T00:00:00Z", last_in_channel: "email", last_out_at: "2026-10-25T00:00:00Z", last_out_channel: "email" },
  ]);
}

// ── crm_customer_facts ──────────────────────────────────────────────────────────────────────────

Deno.test("facts: every visible customer, with booleans where the numbers, emails and street would be", async () => {
  const db = crmWorld();
  const { status, body } = await run(ctx(db, "crm_customer_facts"));
  assertEquals(status, 200);
  assertEquals(body.complete, true);
  const text = JSON.stringify(body);
  assert(!/555|@|Main St|8165550100/.test(text), "no phone, email or street may leave the action");
  const dale = body.contacts.find((c: R) => c.id === id(1));
  assertEquals([dale.hasPhone, dale.hasEmail, dale.town, dale.textsConsented, dale.textsOff], [true, true, "Sedalia", true, false]);
  assertEquals([dale.lastInChannel, dale.lastInAt], ["email", "2026-10-26T00:00:00Z"]);
  // The merged record isn't a customer of its own.
  assert(!body.contacts.some((c: R) => c.id === id(3)));
  const rita = body.contacts.find((c: R) => c.id === id(2));
  assertEquals([rita.hasPhone, rita.emailOff, rita.emailOffBy], [false, true, "customer"]);
  const dana = body.contacts.find((c: R) => c.id === id(4));
  assertEquals([dana.textsOff, dana.textsOffReason, dana.dndAll], [true, "stop", true]);
});

Deno.test("facts: a status is its EVENT and its place in the pipeline's order, whatever it's called", async () => {
  const { body } = await run(ctx(crmWorld(), "crm_customer_facts"));
  const dale = body.contacts.find((c: R) => c.id === id(1));
  const sent = dale.deals.find((d: R) => d.id === id(11));
  assertEquals([sent.statusName, sent.statusEvent, sent.firstStatus], ["Quoted", "estimate_sent", false]);
  assertEquals([sent.valueCents, sent.design.status, sent.design.quoteSentAt, sent.design.style, sent.design.size], [845000, "sent", "2026-10-25T00:00:00Z", "Lofted Barn", "12x24"]);
  // The merged record's deal follows it to Dale, and is New Lead by position although it's called Fresh.
  const moved = dale.deals.find((d: R) => d.id === id(12));
  assertEquals([moved.statusName, moved.statusEvent, moved.firstStatus, moved.valueCents], ["Fresh", "design_submitted", true, 250000]);
  const dana = body.contacts.find((c: R) => c.id === id(4));
  // A card whose design is gone is left out, as on the board, and so is an archived card.
  assertEquals(dana.deals.length, 0);
});

Deno.test("facts: narrowed to the caller's own customers, and a failed check refuses instead of widening", async () => {
  const db = crmWorld();
  const mine = await run(ctx(db, "crm_customer_facts", {}, { visibleContactIds: (ids) => Promise.resolve(new Set(ids.filter((i) => i === id(2)) as string[])) }));
  assertEquals(mine.body.contacts.map((c: R) => c.id), [id(2)]);
  const broken = await run(ctx(db, "crm_customer_facts", {}, { visibleContactIds: () => Promise.resolve(null) }));
  assertEquals(broken.status, 500);
  assert(!("contacts" in broken.body));
});

Deno.test("facts: appointments only with meetings access, and only your own for 'own'", async () => {
  const db = crmWorld();
  const none = await run(ctx(db, "crm_customer_facts", {}, { canRead: (a) => a !== "meetings" }));
  assert(none.body.contacts.every((c: R) => !("nextMeetingAt" in c)), "the key is absent, not null");
  assertEquals(none.body.seen.meetings, false);
  const all = await run(ctx(db, "crm_customer_facts"));
  const dale = all.body.contacts.find((c: R) => c.id === id(1));
  assertEquals(dale.nextMeetingAt, "2026-11-08T15:00:00Z");
  // A meeting in the past isn't the next one.
  assertEquals(all.body.contacts.find((c: R) => c.id === id(2)).nextMeetingAt, null);
  const own = await run(ctx(db, "crm_customer_facts", {}, { meetingsOwnOnly: true, selfUserId: id(77) }));
  assertEquals(own.body.contacts.find((c: R) => c.id === id(1)).nextMeetingAt, "2026-11-09T15:00:00Z");
});

Deno.test("facts: calls count toward last contact only for someone who sees the team's calls", async () => {
  const db = crmWorld();
  await run(ctx(db, "crm_customer_facts", {}, { phoneOwnOnly: true }));
  await run(ctx(db, "crm_customer_facts", {}, { canRead: (a) => a !== "phone" }));
  const team = await run(ctx(db, "crm_customer_facts"));
  assertEquals(db.rpcArgs.map((a) => a.p_calls), [false, false, true]);
  assertEquals(team.body.seen.calls, true);
});

Deno.test("facts: a read that fails, or a missing touch function, is a 500 and never part of a list", async () => {
  const db = crmWorld();
  db.fail.add("crm_deals");
  assertEquals((await run(ctx(db, "crm_customer_facts"))).status, 500);
  const db2 = crmWorld();
  db2.rpcFail = true;
  const r = await run(ctx(db2, "crm_customer_facts"));
  assertEquals(r.status, 500);
  assert(fails.includes("check when you last spoke"));
});

Deno.test("facts: past the cap it says complete:false with no rows, and pages past 1000 below it", async () => {
  const many = Array.from({ length: MAX_CONTACTS + 1 }, (_, i) => ({ id: id(10_000 + i), name: `Lead ${i}`, created_at: "2026-10-01T00:00:00Z" }));
  const big = await run(ctx(makeDb({ crm_contacts: many }), "crm_customer_facts"));
  assertEquals([big.status, big.body.complete, big.body.contacts.length], [200, false, 0]);
  const some = await run(ctx(makeDb({ crm_contacts: many.slice(0, 2500) }), "crm_customer_facts"));
  assertEquals([some.body.complete, some.body.contacts.length], [true, 2500]);
});

Deno.test("facts: a name search looks for every word, takes no grammar, and refuses a single letter", async () => {
  const db = crmWorld();
  const r = await run(ctx(db, "crm_customer_facts", { nameLike: "harper, dale)" }));
  assertEquals(r.body.contacts.map((c: R) => c.name), ["Dale Harper"]);
  const q = db.requests.find((x) => x.table === "crm_contacts" && x.filters.some((f) => f.startsWith("name ilike")));
  assert(q && q.filters.includes("name ilike %harper%") && q.filters.includes("name ilike %dale%"), JSON.stringify(q));
  // Initials only: no word of two letters, so the whole term is the pattern. It used to search with no
  // name filter at all and answer the latest customers as matches.
  const db2 = crmWorld();
  const initials = await run(ctx(db2, "crm_customer_facts", { nameLike: "D H" }));
  assertEquals(initials.body.contacts.map((c: R) => c.name), []);
  const q2 = db2.requests.find((x) => x.table === "crm_contacts" && x.filters.some((f) => f.startsWith("name ilike")));
  assert(q2 && q2.filters.includes("name ilike %D H%"), JSON.stringify(db2.requests.filter((x) => x.table === "crm_contacts").map((x) => x.filters)));
  assertEquals((await run(ctx(crmWorld(), "crm_customer_facts", { nameLike: "Dale H" }))).body.contacts.map((c: R) => c.name), ["Dale Harper"]);
  assertEquals(cleanTerm("a"), null);
  assertEquals(cleanTerm("O'Neil (x),"), "O'Neil x");
  assertEquals((await run(ctx(db, "crm_customer_facts", { nameLike: "x" }))).status, 400);
  assertEquals((await run(ctx(db, "crm_customer_facts", { contactIds: ["not-an-id"] }))).status, 400);
  const byId = await run(ctx(db, "crm_customer_facts", { contactIds: [id(2)] }));
  assertEquals(byId.body.contacts.map((c: R) => c.id), [id(2)]);
});

// ── orders_overview ─────────────────────────────────────────────────────────────────────────────

const O = (n: number) => id(500 + n);
function orderWorld() {
  return makeDb({
    orders: [
      { id: O(1), order_no: 101, short_code: "SOLD01", total_cents: 1_000_000, ordered_at: "2026-10-01T00:00:00Z" },
      { id: O(2), order_no: 102, short_code: "ACC002", total_cents: 500_000, ordered_at: "2026-10-10T00:00:00Z" },
      { id: O(3), order_no: 103, short_code: "GHL003", total_cents: 700_000, ordered_at: "2026-10-11T00:00:00Z" },
      { id: O(4), order_no: 104, short_code: "NOTOT4", total_cents: null, ordered_at: "2026-10-12T00:00:00Z" },
      { id: O(5), order_no: 105, short_code: "LOT005", total_cents: 300_000, ordered_at: "2026-10-13T00:00:00Z" },
      { id: O(6), order_no: 106, short_code: null, total_cents: 90_000, ordered_at: "2026-10-14T00:00:00Z" },
      { id: O(7), order_no: 107, short_code: "THEIRS", total_cents: 100_000, ordered_at: "2026-10-15T00:00:00Z" },
    ],
    designs: [
      { short_code: "SOLD01", contact_id: id(1), contact: { name: "Dale Harper", phone: "8165550100", email: "dale@example.com" }, status: "invoiced", ss_quote_number: "Q-1", selections: { style: "Lofted Barn", size: "12x24" } },
      { short_code: "ACC002", contact_id: id(2), contact: { name: "Rita Moss" }, status: "accepted", ss_quote_number: "Q-2", ss_invoice_sent_at: "2026-10-20T00:00:00Z" },
      // Quoted in GoHighLevel: not on the Orders tab, so not here.
      { short_code: "GHL003", contact_id: id(1), contact: { name: "Dale Harper" }, status: "invoiced", ss_quote_number: null, ghl_estimate_number: 55 },
      { short_code: "NOTOT4", contact_id: id(1), contact: { name: "Dale Harper" }, status: "invoiced", ss_quote_number: "Q-4" },
      { short_code: "LOT005", contact_id: id(1), contact: { name: "Dale Harper" }, status: "invoiced", ss_quote_number: "Q-5", inventory_unit_id: id(600) },
      { short_code: "THEIRS", contact_id: id(9), contact: { name: "Another Dealer's" }, status: "invoiced", ss_quote_number: "Q-7" },
    ],
    payments: [
      { id: id(701), order_id: O(1), amount_cents: 300_000, funding_state: "settled" },
      { id: id(702), order_id: O(1), amount_cents: 200_000, funding_state: "pending" },
      { id: id(703), order_id: O(1), amount_cents: 100_000, funding_state: "settled", voided_at: "2026-10-03T00:00:00Z" },
      { id: id(704), order_id: O(1), amount_cents: 50_000, funding_state: "returned" },
      // A partial refund already lowered amount_cents.
      { id: id(705), order_id: O(5), amount_cents: 350_000, funding_state: "settled" },
    ],
    invoice_sends: [{ short_code: "SOLD01", signed_at: "2026-10-05T00:00:00Z" }],
    build_jobs: [{ id: id(801), design_short_code: "SOLD01", stage_id: id(810), due_date: null, completed_at: null }],
    schedule_stages: [{ id: id(810), name: "Queue", kind: "queue" }],
    delivery_stops: [{ id: id(820), design_short_code: "SOLD01", delivered_at: null, load_id: id(830) }],
    delivery_loads: [{ id: id(830), status: "planned", load_date: "2026-11-12" }],
  });
}

Deno.test("orders: StructureStudio orders only, narrowed to the caller's customers, money the Orders tab's way", async () => {
  const db = orderWorld();
  const { status, body } = await run(ctx(db, "orders_overview", {}, {
    visibleDesignRows: <T extends { contact_id?: string | null }>(rows: T[]) => Promise.resolve(rows.filter((r) => r.contact_id !== id(9))),
  }));
  assertEquals(status, 200);
  const by = Object.fromEntries(body.orders.map((o: R) => [o.orderNo, o]));
  assertEquals(Object.keys(by).sort(), ["101", "102", "104", "105", "106"]);
  assert(!/555|@/.test(JSON.stringify(body)), "the order list holds the name and nothing else of the contact");
  assertEquals([by[101].settledCents, by[101].pendingCents, by[101].balanceCents], [300_000, 200_000, 700_000]);
  assertEquals([by[101].name, by[101].building, by[101].sold, by[101].soldAt, by[101].soldAtFrom], ["Dale Harper", "Lofted Barn 12x24", true, "2026-10-05T00:00:00Z", "signed"]);
  // No total yet is null, never $0 owed.
  assertEquals([by[104].balanceCents, by[104].totalCents], [null, null]);
  // An invoice out and unsigned isn't sold.
  assertEquals([by[102].sold, by[102].invoiceOut, by[102].soldAt], [false, true, null]);
  assertEquals([by[105].lotSale, by[105].balanceCents], [true, -50_000]);
  // An order with no design is StructureStudio's own, and sold.
  assertEquals([by[106].sold, by[106].name, by[106].soldAtFrom], [true, null, "ordered"]);
  assertEquals(by[101].build, { stageName: "Queue", stageKind: "queue", dueDate: null, completedAt: null });
  assertEquals(by[101].delivery, { deliveredAt: null, loadStatus: "planned", loadDate: "2026-11-12" });
  assertEquals(by[102].build, null);
});

Deno.test("orders: build and delivery facts are absent without those areas", async () => {
  const { body } = await run(ctx(orderWorld(), "orders_overview", {}, { canRead: (a) => a !== "build_schedule" && a !== "delivery_schedule" }));
  assertEquals(body.seen, { build: false, delivery: false });
  assert(body.orders.every((o: R) => !("build" in o) && !("delivery" in o)));
});

Deno.test("orders: a failed scope check or read is a 500, and codes are checked", async () => {
  const db = orderWorld();
  assertEquals((await run(ctx(db, "orders_overview", {}, { visibleDesignRows: () => Promise.resolve(null) }))).status, 500);
  db.fail.add("payments");
  assertEquals((await run(ctx(db, "orders_overview"))).status, 500);
  assertEquals((await run(ctx(orderWorld(), "orders_overview", { shortCodes: ["a,b"] }))).status, 400);
  const one = await run(ctx(orderWorld(), "orders_overview", { shortCodes: ["ACC002"] }));
  assertEquals(one.body.orders.map((o: R) => o.orderNo), [102]);
});

Deno.test("orderMoney: settled only, clearing apart, voided and returned count for nothing, no total is null", () => {
  assertEquals(orderMoney(1000, [{ amount_cents: 300 }, { amount_cents: 200, funding_state: "pending" }, { amount_cents: 999, voided_at: "x" }, { amount_cents: 50, funding_state: "returned" }]), { settledCents: 300, pendingCents: 200, balanceCents: 700 });
  assertEquals(orderMoney(null, [{ amount_cents: 300 }]), { settledCents: 300, pendingCents: 0, balanceCents: null });
  assertEquals(orderMoney(100, []), { settledCents: 0, pendingCents: 0, balanceCents: 100 });
});

Deno.test("atLocationSince: the latest delivered haul stop, never the sale stop", () => {
  const stops = [
    { design_short_code: null, delivered_at: "2026-05-01T00:00:00Z" },
    { design_short_code: null, delivered_at: "2026-06-01T00:00:00Z" },
    { design_short_code: "BUYER1", delivered_at: "2026-10-01T00:00:00Z" },
    { design_short_code: null, delivered_at: null },
  ];
  assertEquals(atLocationSince("BUYER1", stops), "2026-06-01T00:00:00Z");
  assertEquals(atLocationSince(null, [{ design_short_code: null, delivered_at: null }]), null);
  assertEquals(atLocationSince("X", [{ design_short_code: "X", delivered_at: "2026-01-01T00:00:00Z" }]), null);
});

Deno.test("an action this module doesn't own is refused", async () => {
  assertEquals((await run(ctx(crmWorld(), "crm_deals_list"))).status, 400);
});
