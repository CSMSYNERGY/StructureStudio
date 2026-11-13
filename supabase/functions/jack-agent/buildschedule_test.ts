// buildschedule.ts: Jack on the build schedule. No network: a fake portal-schedule stands in for
// build_board, create_job, update_job, complete_job and move_job, with the real routes' bodies, columns,
// refusals and side effects (index.ts 773-957, 1330-1343, 1448-1727); a fake portal-billing answers the
// entitlement the portal shell reads; a fake portal-settings answers crm_rules_list and list_inventory.

import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, runTool, SENTENCES, type Store, strictCost, toolsFor, type TurnState, type Who, withinStrictLimits } from "./agent.ts";
import { PIECE_TOOLS, register } from "./pieces.ts";
import { leaksContactDetails } from "./redact.ts";
import { SAID } from "./common.ts";
import { MODULE_REFUSAL } from "../_shared/accessEnforce.ts";
import { _test, BS_SAID, BUILD_SCHEDULE_KINDS, buildSchedulePiece, dayWords, realDay, RECORDS_SWITCH } from "./buildschedule.ts";

register([buildSchedulePiece]);

// deno-lint-ignore no-explicit-any
type Any = any;

const who: Who = { clientId: "builder-a", userId: "u1", operatorEmail: null };
const NOW = Date.parse("2026-11-06T15:00:00Z");

const ST_OLDQ = "a0000000-0000-4000-8000-000000000000";
const ST_QUEUE = "a0000000-0000-4000-8000-000000000001";
const ST_BUILD = "a0000000-0000-4000-8000-000000000002";
const ST_DONE = "a0000000-0000-4000-8000-000000000003";
const CR_AMOS = "c0000000-0000-4000-8000-000000000001";
const CR_ELI = "c0000000-0000-4000-8000-000000000002";
const CR_OLD = "c0000000-0000-4000-8000-000000000003";
const J_DALE = "b0000000-0000-4000-8000-000000000001";
const J_LOT = "b0000000-0000-4000-8000-000000000002";
const J_REP = "b0000000-0000-4000-8000-000000000003";
const J_BUILT = "b0000000-0000-4000-8000-000000000004";
const J_DALE2 = "b0000000-0000-4000-8000-000000000005";
const U_JOB = "d0000000-0000-4000-8000-000000000001";
const U_CABIN = "d0000000-0000-4000-8000-000000000002";
const U_DONE = "d0000000-0000-4000-8000-000000000003";
const RP_JOB = "e0000000-0000-4000-8000-000000000001";
const RP_PORCH = "e0000000-0000-4000-8000-000000000002";
const RP_CLOSED = "e0000000-0000-4000-8000-000000000003";
const L_SEVEN = "f0000000-0000-4000-8000-000000000001";
const L_OUT = "f0000000-0000-4000-8000-000000000002";

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────

// jsonb keeps no key order: Postgres stores an object's keys shorter first, then by bytes, and answers
// them that way. A card's payload and undo come back as {"due", "start"}, never as they were written.
const jsonbOrder = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])]));
  }
  return v;
};
const asJsonb = <T>(v: T): T => jsonbOrder(JSON.parse(JSON.stringify(v))) as T;

function makeStore(clock: () => number, init: { on?: boolean; off?: string[] } = {}) {
  const proposals = new Map<string, ProposalRow>();
  let seq = 0;
  const state = { on: init.on ?? true, off: init.off ?? [], proposals };
  const store: Store = {
    settings: () => Promise.resolve({ on: state.on, off: state.off }),
    setOff: (_c, off) => { state.off = off; return Promise.resolve(); },
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: () => Promise.resolve(),
    closeChats: () => Promise.resolve(),
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      // Through JSON both ways and in jsonb's key order, the way jack_proposals stores and answers it.
      const row = asJsonb({ id, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(clock() + 86_400_000).toISOString(), created_at: new Date(clock()).toISOString(), ...p }) as ProposalRow;
      proposals.set(id, row);
      return Promise.resolve(asJsonb(row));
    },
    getProposal: (c, id) => { const r = proposals.get(id); return Promise.resolve(r && r.client_id === c ? asJsonb(r) : null); },
    updateProposal: (c, id, patch, when, at) => {
      const r = proposals.get(id);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, asJsonb(patch));
      return Promise.resolve(asJsonb(r));
    },
    addProposalCost: () => Promise.resolve(),
    proposals: () => Promise.resolve([...proposals.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => proposals.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve(null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(true),
    forgetMemory: () => Promise.resolve(true),
  };
  return { store, state };
}

const wallet: Deps["wallet"] = {
  meter: () => Promise.resolve({ active: false, markup: 1.5 }),
  exempt: () => Promise.resolve(false),
  account: () => Promise.resolve({ balanceCents: 5000, heldCents: 0, remainderMicros: 0, autoTopup: false, thresholdCents: null }),
  debit: () => Promise.resolve({ ok: true, txId: 1 }),
  grantOnce: () => Promise.resolve(true),
  requestTopup: () => {},
  mark: () => Promise.resolve(),
  pending: () => Promise.resolve([]),
};

// lost: it lands and the answer never comes. dropped: it never lands. fault: a 500, nothing lands.
// garbled: it lands, and the 200 comes back with a body that can't be read (call() answers data null).
type Mode = "ok" | "lost" | "dropped" | "fault" | "garbled";

const job = (o: Record<string, unknown>): Any => ({
  client_id: "builder-a", stage_id: ST_QUEUE, position: 1000, source: "order", design_short_code: null, order_id: null, inventory_unit_id: null, repair_id: null,
  serial: null, title: null, customer_name: null, building_label: null, width_ft: null, length_ft: null, scheduled_start: null, due_date: null,
  completed_at: null, assignee_user_id: null, notes: null, created_by: "u9", created_at: "2026-10-01T12:00:00.000000+00:00",
  updated_at: "2026-10-01T12:00:00.000000+00:00", crew_id: null, changed_at: null, changed_co_no: null, changed_summary: null,
  roof_type: null, roof_color: null, body_color: null, trim_color: null, ...o,
});

function makeWorld(clock: () => number) {
  let tick = 0;
  const stamp = () => new Date(clock() + (++tick)).toISOString();
  const w = {
    addOn: true as boolean | null,
    billingStatus: 200,
    boardStatus: 200,
    rulesStatus: 200,
    loadsStatus: 200,
    // The archived Queue sorts first: create_job's own fallback would skip it, and Jack never relies on that.
    stages: [
      { id: ST_OLDQ, client_id: "builder-a", name: "Old queue", color: "#999", kind: "queue", sort_order: -1, archived: true },
      { id: ST_QUEUE, client_id: "builder-a", name: "Queue", color: "#94A3B8", kind: "queue", sort_order: 0, archived: false },
      { id: ST_BUILD, client_id: "builder-a", name: "In Build", color: "#F59E0B", kind: "active", sort_order: 1, archived: false },
      { id: ST_DONE, client_id: "builder-a", name: "Built", color: "#22C55E", kind: "done", sort_order: 2, archived: false },
    ] as Any[],
    crews: [
      { id: CR_AMOS, client_id: "builder-a", name: "Amos crew", color: "#3D3672", member_user_ids: [], sort_order: 0, active: true },
      { id: CR_ELI, client_id: "builder-a", name: "Eli crew", color: "#3D3672", member_user_ids: [], sort_order: 1, active: true },
      { id: CR_OLD, client_id: "builder-a", name: "Old crew", color: "#3D3672", member_user_ids: [], sort_order: 2, active: false },
    ] as Any[],
    jobs: [
      job({ id: J_DALE, design_short_code: "DALE01", serial: 1042, customer_name: "Dale Smith", building_label: "Lofted Barn 12x24", scheduled_start: "2026-11-09", due_date: "2026-11-10", crew_id: CR_AMOS, notes: "Loft ladder on the left. Call 816-555-0199. Site is 1234 N Main St.", position: 1000 }),
      job({ id: J_DALE2, design_short_code: "DALE02", serial: 1043, customer_name: "Dale Jones", building_label: "Garden Shed 8x10", stage_id: ST_BUILD, position: 2000 }),
      job({ id: J_LOT, source: "inventory", inventory_unit_id: U_JOB, serial: 1050, building_label: "Utility Shed 10x16", position: 3000 }),
      job({ id: J_REP, source: "repair", repair_id: RP_JOB, serial: 977, customer_name: "Ruth Miller", title: "Replace door, ruthm@example.com", stage_id: ST_BUILD, position: 4000 }),
      job({ id: J_BUILT, design_short_code: "OLD09", serial: 1001, customer_name: "Sam Byler", building_label: "Cabin 14x28", stage_id: ST_DONE, completed_at: "2026-10-20T18:00:00.000000+00:00", due_date: "2026-10-20", scheduled_start: "2026-10-20" }),
    ] as Any[],
    designs: {
      DALE01: { short_code: "DALE01", status: "invoiced", inventory_unit_id: null, contact: { name: "Dale Smith", phone: "8165550199", email: "dale@example.com" }, label: "Lofted Barn 12x24" },
      DALE02: { short_code: "DALE02", status: "invoiced", inventory_unit_id: null, contact: { name: "Dale Jones" }, label: "Garden Shed 8x10" },
      OLD09: { short_code: "OLD09", status: "delivered", inventory_unit_id: null, contact: { name: "Sam Byler" }, label: "Cabin 14x28" },
      ANN02: { short_code: "ANN02", status: "invoiced", inventory_unit_id: null, contact: { name: "Ann Lee", phone: "8165550100", email: "ann@example.com" }, label: "Garden Shed 10x12" },
      PAT03: { short_code: "PAT03", status: "invoiced", inventory_unit_id: null, contact: { name: "pat@example.com" }, label: "Mini Barn 10x14" },
      SALE05: { short_code: "SALE05", status: "invoiced", inventory_unit_id: U_CABIN, contact: { name: "Lot Buyer" }, label: "Cabin 12x20" },
      SENT04: { short_code: "SENT04", status: "sent", inventory_unit_id: null, contact: { name: "Not Yet" }, label: "Garage 24x30" },
    } as Record<string, Any>,
    orders: { DALE01: { shop_serial: 1042 }, ANN02: { shop_serial: null } } as Record<string, Any>,
    units: [
      { id: U_JOB, serial: 1050, design_short_code: "UT10", sale_state: "available", label: "Utility Shed 10x16" },
      { id: U_CABIN, serial: 1060, design_short_code: "CAB12", sale_state: "available", label: "Cabin 12x20" },
      { id: U_DONE, serial: 1061, design_short_code: "CAB12", sale_state: "available", label: "Cabin 12x20" },
    ] as Any[],
    lifecycle: { [U_CABIN]: "requested", [U_DONE]: "at_location", [U_JOB]: "in_queue" } as Record<string, string>,
    repairs: [
      { id: RP_JOB, repair_no: 11, customer_name: "Ruth Miller", description: "Replace door", serial: 977, status: "approved" },
      { id: RP_PORCH, repair_no: 12, customer_name: "Mary Yoder", description: "Porch roof leak, call 816-555-0142 or mary@example.com", serial: 880, status: "requested" },
      { id: RP_CLOSED, repair_no: 13, customer_name: "Done Already", description: "Fixed", serial: 881, status: "completed" },
    ] as Any[],
    stops: [
      { id: "s0000000-0000-4000-8000-000000000001", build_job_id: J_DALE, load_id: L_SEVEN, delivered_at: null, inventory_unit_id: null, design_short_code: "DALE01", customer_phone: "8165550199", dest_street: "1234 N Main St" },
      { id: "s0000000-0000-4000-8000-000000000002", build_job_id: J_BUILT, load_id: L_OUT, delivered_at: null, inventory_unit_id: null, design_short_code: "OLD09", customer_phone: null, dest_street: null },
    ] as Any[],
    loads: [
      { id: L_SEVEN, load_no: 7, load_date: "2026-11-11", status: "planned" },
      { id: L_OUT, load_no: 6, load_date: "2026-10-30", status: "out" },
    ] as Any[],
    rules: [] as Any[],
    mode: { create_job: "ok", update_job: "ok", complete_job: "ok", move_job: "ok" } as Record<string, Mode>,
    operatorReadOnly: false,
    nextSerial: 2000,
    calls: [] as { fn: string; action: string; body: Any }[],
    stamp,
  };
  const out = (status: number, data: Record<string, unknown> | null) => Promise.resolve({ status, data });
  const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const dateStr = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const strv = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  class Refusal { status: number; error: string; constructor(error: string, status = 400) { this.error = error; this.status = status; } }
  const requireRow = (rows: Any[], id: unknown, label: string) => {
    if (!isUuid(id)) throw new Refusal(`Invalid ${label} id.`);
    const r = rows.find((x) => x.id === id);
    if (!r) throw new Refusal(`${label} not found.`);
    return r;
  };
  // Postgres refuses a day that doesn't exist, and portal-schedule answers that fault as a 500.
  const realOrFault = (d: string | null) => { if (d && Number.isNaN(Date.parse(d + "T00:00:00Z"))) throw new Error("date/time field value out of range"); if (d) { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, dd)); if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== dd) throw new Error("date/time field value out of range"); } };

  const WRITES = new Set(["create_job", "update_job", "complete_job", "move_job"]);
  function schedule(action: string, b: Any): Promise<{ status: number; data: Record<string, unknown> | null }> {
    w.calls.push({ fn: "portal-schedule", action, body: JSON.parse(JSON.stringify(b)) });
    if (WRITES.has(action) && w.operatorReadOnly) return out(403, { error: "This operator account is read-only." });
    if (action === "build_board") {
      if (w.boardStatus !== 200) return out(w.boardStatus, w.boardStatus === 403 ? { error: "You don't have access to that." } : { error: "Something went wrong." });
      const haveDesign = new Set(w.jobs.map((j) => j.design_short_code).filter(Boolean));
      const haveUnit = new Set(w.jobs.map((j) => j.inventory_unit_id).filter(Boolean));
      const haveRepair = new Set(w.jobs.map((j) => j.repair_id).filter(Boolean));
      const stopByJob: Record<string, unknown> = {};
      // Only the stops linked to a job (index.ts: `.in("build_job_id", jobIds)`), one per job.
      for (const s of w.stops.filter((x) => x.build_job_id)) stopByJob[s.build_job_id] = { loadId: s.load_id, deliveredAt: s.delivered_at, load: w.loads.find((l) => l.id === s.load_id) ?? null };
      return out(200, JSON.parse(JSON.stringify({
        stages: [...w.stages].sort((x, y) => x.sort_order - y.sort_order),
        jobs: [...w.jobs].sort((x, y) => x.position - y.position).map((j) => ({ ...j, valueCents: null })),
        stopByJob,
        tray: {
          orders: Object.values(w.designs).filter((d) => d.status === "invoiced" && !d.inventory_unit_id && !haveDesign.has(d.short_code))
            .map((d) => ({ designShortCode: d.short_code, customerName: d.contact?.name ?? "", buildingLabel: d.label, status: d.status })),
          inventory: w.units.filter((u) => !haveUnit.has(u.id))
            .map((u) => ({ inventoryUnitId: u.id, serial: u.serial, designShortCode: u.design_short_code, buildingLabel: u.label, sold: u.sale_state === "sold", soldFirstName: null })),
          repairs: w.repairs.filter((r) => ["requested", "approved", "in_progress"].includes(r.status) && !haveRepair.has(r.id))
            .map((r) => ({ repairId: r.id, repairNo: r.repair_no, customerName: r.customer_name, description: r.description, serial: r.serial, status: r.status })),
        },
        team: [{ userId: "u1", role: "owner", name: "Mike" }],
        crews: w.crews,
      })));
    }
    // The Delivery Schedule's read: every load, and every stop with all its columns (select *).
    if (action === "loads") {
      if (w.loadsStatus !== 200) return out(w.loadsStatus, { error: "Something went wrong." });
      return out(200, JSON.parse(JSON.stringify({ loads: w.loads, stops: w.stops, buildByJob: {}, unitLifecycle: {}, drivers: [], territories: [], team: [] })));
    }
    const mode = w.mode[action] ?? "ok";
    if (mode === "fault") return out(500, { error: "Something went wrong." });
    if (mode === "dropped") return out(0, null);
    let res: { status: number; data: Record<string, unknown> | null };
    try {
      res = write(action, b);
    } catch (e) {
      if (e instanceof Refusal) return out(e.status, { error: e.error });
      return out(500, { error: (e as Error).message });
    }
    if (mode === "garbled" && res.status === 200) return out(200, null);
    return mode === "lost" ? out(0, null) : Promise.resolve(res);
  }

  function write(action: string, b: Any): { status: number; data: Record<string, unknown> | null } {
    if (action === "create_job") {
      const source = String(b.source ?? "");
      if (!["order", "inventory", "repair", "manual"].includes(source)) return { status: 400, data: { error: "Invalid source." } };
      const live = [...w.stages].sort((x, y) => x.sort_order - y.sort_order);
      const stage = b.stageId ? requireRow(w.stages, b.stageId, "Stage") : (live.find((s) => s.kind === "queue" && !s.archived) ?? live.find((s) => !s.archived) ?? live[0]);
      const at = new Date(clock()).toISOString();
      const row: Any = job({
        id: `b0000000-0000-4000-8000-${String(100 + w.jobs.length).padStart(12, "0")}`, stage_id: stage.id, completed_at: stage.kind === "done" ? at : null,
        position: clock(), source, title: strv(b.title), customer_name: strv(b.customerName), building_label: strv(b.buildingLabel),
        scheduled_start: dateStr(b.scheduledStart), due_date: dateStr(b.dueDate), notes: strv(b.notes), created_by: "u1", created_at: at, updated_at: stamp(),
      });
      if (b.crewId) row.crew_id = requireRow(w.crews, b.crewId, "Crew").id;
      if (source === "order") {
        const code = strv(b.designShortCode);
        if (!code) return { status: 400, data: { error: "designShortCode is required for an order job." } };
        const d = w.designs[code];
        if (!d) return { status: 404, data: { error: "That design isn't in your account." } };
        if (d.status !== "invoiced" && d.status !== "delivered") return { status: 409, data: { error: "That building isn't invoiced yet — the customer has to sign their invoice first, then schedule the build from Orders." } };
        if (d.inventory_unit_id) return { status: 409, data: { error: `That estimate is for building #${w.units.find((u) => u.id === d.inventory_unit_id)?.serial ?? "?"}, which is already on your lot or in the build queue. Schedule its delivery instead.` } };
        if (w.jobs.some((j) => j.design_short_code === code)) return { status: 409, data: { error: "That building is already on the build schedule." } };
        const o = w.orders[code];
        row.serial = o?.shop_serial ?? w.nextSerial++;
        if (o && o.shop_serial == null) o.shop_serial = row.serial;
        row.design_short_code = code;
        row.customer_name = row.customer_name ?? d.contact?.name ?? null;
        row.building_label = row.building_label ?? d.label;
      } else if (source === "inventory") {
        const u = requireRow(w.units, b.inventoryUnitId, "Inventory unit");
        row.inventory_unit_id = u.id; row.serial = u.serial; row.building_label = u.label;
        if (w.jobs.some((j) => j.inventory_unit_id === u.id)) return { status: 409, data: { error: "That building is already on the build schedule." } };
      } else if (source === "repair") {
        const rp = requireRow(w.repairs, b.repairId, "Repair");
        row.repair_id = rp.id; row.serial = rp.serial; row.customer_name = row.customer_name ?? rp.customer_name; row.title = row.title ?? rp.description;
        if (w.jobs.some((j) => j.repair_id === rp.id)) return { status: 409, data: { error: "That building is already on the build schedule." } };
      } else if (!row.title && !row.customer_name) return { status: 400, data: { error: "A manual job needs a title." } };
      realOrFault(row.due_date); realOrFault(row.scheduled_start);
      w.jobs.push(row);
      return { status: 200, data: { job: JSON.parse(JSON.stringify(row)) } };
    }
    if (action === "update_job") {
      const j = requireRow(w.jobs, b.jobId, "Job");
      const patch: Any = { updated_at: stamp() };
      if ("title" in b) patch.title = strv(b.title);
      if ("customerName" in b) patch.customer_name = strv(b.customerName);
      if ("scheduledStart" in b) patch.scheduled_start = dateStr(b.scheduledStart);
      if ("dueDate" in b) patch.due_date = dateStr(b.dueDate);
      if ("crewId" in b) patch.crew_id = b.crewId === null || b.crewId === "" ? null : requireRow(w.crews, b.crewId, "Crew").id;
      if ("notes" in b) patch.notes = strv(b.notes);
      realOrFault(patch.due_date ?? null); realOrFault(patch.scheduled_start ?? null);
      Object.assign(j, patch);
      return { status: 200, data: { ok: true } };
    }
    if (action === "complete_job") {
      const j = requireRow(w.jobs, b.jobId, "Job");
      const done = [...w.stages].sort((x, y) => x.sort_order - y.sort_order).find((s) => s.kind === "done" && !s.archived);
      if (!done) return { status: 400, data: { error: "No finished stage exists." } };
      Object.assign(j, { stage_id: done.id, completed_at: j.completed_at ?? new Date(clock()).toISOString(), updated_at: stamp() });
      if (j.repair_id) {
        const rp = w.repairs.find((r) => r.id === j.repair_id);
        const anyOpen = w.jobs.some((o) => o.repair_id === j.repair_id && o.id !== j.id && !o.completed_at);
        if (rp && rp.status !== "completed" && rp.status !== "declined" && !anyOpen) return { status: 200, data: { ok: true, repairPrompt: { repairId: rp.id, repairNo: rp.repair_no } } };
      }
      return { status: 200, data: { ok: true } };
    }
    if (action === "move_job") {
      const j = requireRow(w.jobs, b.jobId, "Job");
      const st = requireRow(w.stages, b.stageId, "Stage");
      const position = typeof b.position === "number" ? b.position : clock();
      Object.assign(j, { stage_id: st.id, position, completed_at: st.kind === "done" ? (j.completed_at ?? new Date(clock()).toISOString()) : null, updated_at: stamp() });
      return { status: 200, data: { ok: true } };
    }
    throw new Refusal(`Unrecognised action "${action}".`, 403);
  }

  function billing(action: string, b: Any) {
    w.calls.push({ fn: "portal-billing", action, body: b });
    if (action !== "status") return out(403, { error: "Not for Jack." });
    if (w.billingStatus !== 200) return out(w.billingStatus, null);
    return out(200, { configured: true, entitlement: { features: { schedule_builds: w.addOn === true, crm: true }, plans: [] } });
  }

  const settingsPortal: Deps["portal"] = (action, b) => {
    w.calls.push({ fn: "portal-settings", action, body: b });
    if (action === "crm_rules_list") {
      if (w.rulesStatus !== 200) return out(w.rulesStatus, null);
      return out(200, { ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: JSON.parse(JSON.stringify(w.rules)), labels: [], timeZone: "America/Chicago", timeZoneSet: true });
    }
    if (action === "list_inventory") return out(200, { units: w.units.map((u) => ({ id: u.id, serial: u.serial, lifecycle: w.lifecycle[u.id] ?? "requested", soldFirstName: "Pat" })) });
    return out(404, null);
  };
  return { w, schedule, billing, settingsPortal };
}

function djb2(t: string) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function setup(opts: { on?: boolean; off?: string[]; deps?: Partial<Deps>; tz?: string } = {}) {
  let t = NOW;
  const clock = () => t;
  const { store, state } = makeStore(clock, { on: opts.on, off: opts.off });
  const { w, schedule, billing, settingsPortal } = makeWorld(clock);
  const make = (over: Partial<Deps> = {}): Deps => ({
    env: () => undefined,
    store,
    portal: settingsPortal,
    call(fn, action, body) {
      const f = fn as string;
      if (f === "portal-schedule") return schedule(action, body);
      if (f === "portal-billing") return billing(action, body);
      if (f === "portal-settings") return settingsPortal(action, body);
      return Promise.resolve({ status: 404, data: null });
    },
    wallet,
    fetch: () => { throw new Error("no Claude in these tests"); },
    canRead: () => true,
    canEdit: () => true,
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (x) => Promise.resolve("h" + djb2(x)),
    log: () => Promise.resolve(),
    audit: () => Promise.resolve(),
    now: clock,
    markSentWithJack: () => Promise.resolve(true),
    ...opts.deps,
    ...over,
  });
  const deps = make();
  const turn = (): TurnState => ({ who, chatId: "chat1", off: opts.off ?? [], proposalIds: [], ...(opts.tz ? { tz: opts.tz } : {}) } as TurnState);
  const writes = () => w.calls.filter((c) => c.fn === "portal-schedule" && c.action !== "build_board" && c.action !== "loads");
  const advance = (ms: number) => { t += ms; };
  return { store, state, w, deps, make, turn, writes, advance };
}

const input = (action: string, jobQ: string, o: Partial<Record<"buildDate" | "crew" | "note", string>> = {}) => ({ action, job: jobQ, buildDate: "", crew: "", note: "", ...o });
const json = (s: string) => JSON.parse(s);
type X = ReturnType<typeof setup>;

async function propose(x: X, inp: unknown, s = x.turn()) {
  const out = await runTool(x.deps, s, "propose_build_schedule", inp);
  return { out, s, card: s.proposalIds.length ? x.state.proposals.get(s.proposalIds[0])! : null };
}
const approve = (x: X, card: ProposalRow, by: Who = who, deps = x.deps) => handleProposalApprove(deps, by, { id: card.id, hash: card.shown_hash });
const row = (x: X, card: ProposalRow) => x.state.proposals.get(card.id)!;
const jobRow = (x: X, id: string) => x.w.jobs.find((j: Any) => j.id === id);
const buildRule = (name: string, event: string, kind = "send_sms"): Any => ({
  id: crypto.randomUUID(), name, scopeKind: "pipeline", pipelineId: null, triggerKind: "event", triggerEvent: event, elapsedAnchor: null, elapsedDays: null,
  schedule: null, conditions: [], oncePerCard: true, enabled: true, appliesFrom: null, actions: [{ kind, params: {} }], nextRunAt: null, armedCount: null, lastRun: null, stale: [],
});

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("look: unbuilt jobs, what's waiting, live columns and crews, with refs and no contact details", async () => {
  const x = setup();
  const s = x.turn();
  const out = await runTool(x.deps, s, "look_at_build_schedule", {});
  assert(!out.isError, out.content);
  assert(!leaksContactDetails(out.content), out.content);
  for (const id of [J_DALE, U_CABIN, RP_PORCH, ST_QUEUE, CR_AMOS]) assert(!out.content.includes(id), `no id ${id}`);
  for (const code of ["DALE01", "ANN02", "PAT03"]) assert(!out.content.includes(code), `no design code ${code}`);
  assert(!/Main St/.test(out.content), "no street line");
  const a = json(out.content);
  assertEquals(a.columns.map((c: Any) => c.name), ["Queue", "In Build", "Built"]);
  assertEquals(a.crews, ["Amos crew", "Eli crew"]);
  assertEquals(a.builtCount, 1);
  const dale = a.jobs.find((j: Any) => j.customer === "Dale Smith");
  assert(/^job-[bcdfghjkmnpqrstv]{5,}$/.test(dale.ref), dale.ref);
  assertEquals([dale.building, dale.serial, dale.column, dale.buildDate, dale.crew, dale.load], ["Lofted Barn 12x24", "#1042", "Queue", "2026-11-10", "Amos crew", { load: "#7", date: "2026-11-11", status: "planned" }]);
  assert(dale.note.includes("[phone]") && dale.note.includes("[address]"), dale.note);
  assert(!a.jobs.some((j: Any) => j.customer === "Sam Byler"), "a built job isn't in the open list");
  assertEquals(a.waiting.sold.map((o: Any) => o.customer), ["Ann Lee", null]);
  assertEquals(a.waiting.lot.map((u: Any) => u.serial), ["#1060", "#1061"]);
  assertEquals(a.waiting.repairs.map((r: Any) => r.repair), ["R-12"]);
  assert(a.waiting.repairs[0].what.includes("[phone]") && a.waiting.repairs[0].what.includes("[email]"));
  assertEquals(s.customerWordsRead, true);
  assertEquals(x.writes().length, 0);
  assertEquals(x.state.proposals.size, 0);
});

Deno.test("look: find narrows to a customer, a serial or a building, and shows built jobs that match", async () => {
  const x = setup();
  const byName = json((await runTool(x.deps, x.turn(), "look_at_build_schedule", { find: "Dale" })).content);
  assertEquals(byName.jobs.map((j: Any) => j.customer).sort(), ["Dale Jones", "Dale Smith"]);
  assertEquals(byName.waiting.sold.length, 0);
  const bySerial = json((await runTool(x.deps, x.turn(), "look_at_build_schedule", { find: "#1001" })).content);
  assertEquals(bySerial.jobs.length, 0);
  assertEquals(bySerial.builtMatching.map((j: Any) => [j.customer, j.builtOn]), [["Sam Byler", "2026-10-20"]]);
  const bySize = json((await runTool(x.deps, x.turn(), "look_at_build_schedule", { find: "12 x 20" })).content);
  assertEquals(bySize.waiting.lot.length, 2);
});

Deno.test("the Shed Scheduler add-on: no add-on, or no answer about it, means no read and no card", async () => {
  for (const [addOn, status, said] of [[false, 200, BS_SAID.noAddOn], [null, 500, BS_SAID.addOnUnread]] as const) {
    const x = setup();
    x.w.addOn = addOn; x.w.billingStatus = status;
    assertEquals(await runTool(x.deps, x.turn(), "look_at_build_schedule", {}), { content: said, isError: true });
    const { out, card } = await propose(x, input("change", "Dale Smith", { buildDate: "2026-11-12" }));
    assertEquals([out.content, card], [said, null]);
    assert(!x.w.calls.some((c) => c.fn === "portal-schedule"), "the board isn't read");
  }
});

Deno.test("a board that can't be read, or that this person can't open, is said and makes no card", async () => {
  const x = setup();
  x.w.boardStatus = 500;
  assertEquals((await propose(x, input("mark_built", "Dale Smith"))).out.content, SAID.readFailed);
  x.w.boardStatus = 403;
  assertEquals((await runTool(x.deps, x.turn(), "look_at_build_schedule", {})).content, "You don't have access to that.");
  assertEquals(x.state.proposals.size, 0);
});

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────

Deno.test("add: a sold building becomes one card holding exactly the create_job body, and nothing is sent", async () => {
  const x = setup();
  x.w.rules = [buildRule("Text them the build date", "build_scheduled"), buildRule("Thank them", "build_completed")];
  const { out, card } = await propose(x, input("add_to_schedule", "Ann", { buildDate: "2026-11-12", crew: "amos" }));
  assert(!out.isError, out.content);
  assertEquals(card!.kind, "build_job_add");
  // An explicit live Queue column, never the archived one that sorts first.
  assertEquals(card!.payload.body, { source: "order", designShortCode: "ANN02", stageId: ST_QUEUE, dueDate: "2026-11-12", scheduledStart: "2026-11-12", crewId: CR_AMOS });
  assertEquals(card!.title, "Add to the build schedule: Garden Shed 10x12");
  assert(!card!.title.includes("Ann"), "no customer in the title");
  assertEquals(card!.preview.job.customer, "Ann Lee");
  assertEquals(card!.preview.lines.map((l: Any) => l.to), ["Queue", "Thu, Nov 12, 2026", "Amos crew"]);
  const sentence = 'This sets off your rule "Text them the build date", which texts or emails the customer by itself.';
  assert(card!.preview.notes.includes(sentence), JSON.stringify(card!.preview.notes));
  assert(card!.preview.keeps.includes(BS_SAID.noUndoAdd));
  const a = json(out.content);
  assert(a.warnings.includes(sentence));
  assert(!out.content.includes("Ann Lee") && !leaksContactDetails(out.content), out.content);
  assertEquals(x.writes().length, 0);
});

Deno.test("add: a lot building already built says so; a repair says it doesn't change the repair; neither fires a rule", async () => {
  const x = setup();
  x.w.rules = [buildRule("Text them the build date", "build_scheduled")];
  const lot = await propose(x, input("add_to_schedule", "#1061"));
  assertEquals(lot.card!.payload.body, { source: "inventory", inventoryUnitId: U_DONE, stageId: ST_QUEUE });
  assert(lot.card!.preview.notes.some((n: string) => n.startsWith("This building already reads as built on your Inventory page")), JSON.stringify(lot.card!.preview.notes));
  assert(!lot.card!.preview.notes.some((n: string) => n.includes("Text them")), "a lot building fires no rule");
  const fresh = await propose(x, input("add_to_schedule", "#1060"));
  assertEquals(fresh.card!.preview.notes, []);
  const rep = await propose(x, input("add_to_schedule", "R-12", { buildDate: "2026-11-13" }));
  assertEquals(rep.card!.payload.body, { source: "repair", repairId: RP_PORCH, stageId: ST_QUEUE, dueDate: "2026-11-13", scheduledStart: "2026-11-13" });
  assertEquals(rep.card!.title, "Add repair R-12 to the build schedule");
  assert(rep.card!.preview.keeps.some((k: string) => k.includes("doesn't change the repair itself")));
  assert(!rep.out.content.includes("Mary") && !leaksContactDetails(rep.out.content), rep.out.content);
});

Deno.test("add: what can't be added is refused before any card", async () => {
  const x = setup();
  const cases: [Any, RegExp][] = [
    [input("add_to_schedule", "Ann", { note: "Bring the ladder" }), /Add it to the schedule first/],
    [input("add_to_schedule", "Ann", { buildDate: "2026-02-30" }), /real date, written YYYY-MM-DD/],
    [input("add_to_schedule", "Ann", { buildDate: "Thursday" }), /real date/],
    [input("add_to_schedule", "Ann", { buildDate: "2031-11-12" }), /too far off/],
    [input("add_to_schedule", "Ann", { crew: "Old crew" }), /switched off/],
    [input("add_to_schedule", "Ann", { crew: "Zed" }), /couldn't find a crew called "Zed". Your crews: "Amos crew", "Eli crew"/],
    [input("add_to_schedule", "Garage"), /Only sold buildings that are invoiced/],
    [input("add_to_schedule", "Done Already"), /couldn't find that/],
  ];
  for (const [inp, re] of cases) {
    const { out, card } = await propose(x, inp);
    assert(out.isError && re.test(out.content), `${JSON.stringify(inp)} -> ${out.content}`);
    assertEquals(card, null);
  }
  const already = await propose(x, input("add_to_schedule", "Dale Smith"));
  assertEquals(json(already.out.content).alreadyScheduled.serial, "#1042");
  assertEquals(already.card, null);
  x.w.stages = x.w.stages.map((st: Any) => (st.kind === "queue" ? { ...st, archived: true } : st));
  assertEquals((await propose(x, input("add_to_schedule", "Ann"))).out.content, BS_SAID.noQueue);
  assertEquals(x.state.proposals.size, 0);
});

Deno.test("two jobs that match are listed by building, serial and date, never by name, and make no card", async () => {
  const x = setup();
  const { out, card } = await propose(x, input("change", "Dale", { buildDate: "2026-11-12" }));
  assertEquals(card, null);
  assert(!out.isError);
  assert(!out.content.includes("Smith") && !out.content.includes("Jones"), out.content);
  const a = json(out.content);
  assertEquals(a.matches.map((m: Any) => [m.building, m.serial]), [["Lofted Barn 12x24", "#1042"], ["Garden Shed 8x10", "#1043"]]);
  // Its ref picks one.
  const again = await propose(x, input("change", a.matches[1].ref, { buildDate: "2026-11-12" }));
  assertEquals(again.card!.payload.jobId, J_DALE2);
});

Deno.test("change: a date move sends only the two date keys, shows the weekday, and warns about the load it rides", async () => {
  const x = setup();
  x.w.rules = [buildRule("Text them the build date", "build_scheduled")];
  const { out, card } = await propose(x, input("change", "Dale Smith", { buildDate: "2026-11-12" }));
  assertEquals(card!.kind, "build_job_change");
  assertEquals(card!.payload.body, { jobId: J_DALE, scheduledStart: "2026-11-12", dueDate: "2026-11-12" });
  assertEquals(card!.title, "Build date: Lofted Barn 12x24 #1042");
  assertEquals(card!.preview.lines, [{ label: "Build date", from: "Tue, Nov 10, 2026", to: "Thu, Nov 12, 2026" }]);
  assertEquals(card!.preview.notes, ["It rides load #7 on Wed, Nov 11, 2026, before this build date. The Delivery board will flag it as not built in time."]);
  // Moving a date starts no rule (build_jobs_pipeline_sync fires on insert only).
  assert(!JSON.stringify(card!.preview).includes("Text them"));
  assert(!out.content.includes("Dale") && !leaksContactDetails(out.content), out.content);
  assertEquals(x.writes().length, 0);
});

Deno.test("change: crew and note each send only their own key; none takes it off; the same value makes no card", async () => {
  const x = setup();
  assertEquals((await propose(x, input("change", "#1042", { crew: "Eli" }))).card!.payload.body, { jobId: J_DALE, crewId: CR_ELI });
  assertEquals((await propose(x, input("change", "#1042", { crew: "none" }))).card!.payload.body, { jobId: J_DALE, crewId: null });
  const n = await propose(x, input("change", "#1042", { note: "Customer wants the loft on the right" }));
  assertEquals(n.card!.payload.body, { jobId: J_DALE, notes: "Customer wants the loft on the right" });
  assertEquals(n.card!.title, "Note on the card: Lofted Barn 12x24 #1042");
  assertEquals((await propose(x, input("change", "#1042", { note: "none" }))).card!.payload.body, { jobId: J_DALE, notes: null });
  const both = await propose(x, input("change", "#1050", { buildDate: "2026-11-20", crew: "Amos" }));
  assertEquals(both.card!.payload.body, { jobId: J_LOT, scheduledStart: "2026-11-20", dueDate: "2026-11-20", crewId: CR_AMOS });
  assert(both.card!.preview.notes.includes("On the Inventory page this lot building will read Scheduled to build."));
  const same = await propose(x, input("change", "#1042", { crew: "Amos crew" }));
  assertEquals([same.card, json(same.out.content).alreadyMatching], [null, ["Crew"]]);
  assert((await propose(x, input("change", "#1042"))).out.isError, "nothing to change is refused");
  const built = await propose(x, input("change", "Sam Byler", { buildDate: "2026-11-12" }));
  assertEquals(built.out.content, "That one is already built, so I won't move its date or crew.");
  assert((await propose(x, input("change", "Ann", { buildDate: "2026-11-12" }))).out.content.includes("add_to_schedule"), "not on the schedule yet");
});

Deno.test("mark built: one card with the shop's zone, the rule it sets off, and the customer's change flagged", async () => {
  const x = setup({ tz: "America/Denver" });
  x.w.rules = [buildRule("Thank them", "build_completed", "send_email"), buildRule("Text them the build date", "build_scheduled")];
  Object.assign(jobRow(x, J_DALE), { changed_at: "2026-11-05T10:00:00Z", changed_co_no: 3, changed_summary: "Roof: Shingle to Metal" });
  const { out, card } = await propose(x, input("mark_built", "Dale Smith"));
  assertEquals(card!.kind, "build_job_built");
  assertEquals(card!.payload.body, { jobId: J_DALE, tz: "America/Denver" });
  assertEquals(card!.title, "Mark built: Lofted Barn 12x24 #1042");
  assertEquals(card!.preview.lines, [{ label: "Column", from: "Queue", to: "Built" }]);
  assertEquals(card!.payload.back, { stageId: ST_QUEUE, position: 1000 });
  const notes: string[] = card!.preview.notes;
  assert(notes[0].includes("(CO-3)") && notes[0].includes("Roof: Shingle to Metal"), notes[0]);
  assert(notes.includes('This sets off your rule "Thank them", which texts or emails the customer by itself.'), JSON.stringify(notes));
  assert(!notes.some((n) => n.includes("Text them")), "only build_completed rules");
  // complete_job can answer ok with no tag code (no orders row, or a mint that failed and was
  // swallowed), so the card says it can set one, never that it will.
  const serialLine: string = card!.preview.keeps.find((k: string) => k.includes("building serial"));
  assert(/\bcan give it one\b/.test(serialLine) && !/\bthis sets it\b/.test(serialLine), serialLine);
  const a = json(out.content);
  assert(a.warnings[0].includes("CO-3") && !a.warnings[0].includes("Shingle"), "Claude hears the flag, not the change order's words");
  assert(!out.content.includes("Dale"));
});

Deno.test("mark built: without the browser's zone the account's own is used; lot and repair jobs fire no rule", async () => {
  const x = setup();
  x.w.rules = [buildRule("Thank them", "build_completed")];
  assertEquals((await propose(x, input("mark_built", "#1042"))).card!.payload.body, { jobId: J_DALE, tz: "America/Chicago" });
  const lot = await propose(x, input("mark_built", "#1050"));
  assertEquals(lot.card!.preview.notes, []);
  const rep = await propose(x, input("mark_built", "#977"));
  assertEquals(rep.card!.preview.notes, ["This doesn't close the repair. Close it on the Repairs tab when the work is done."]);
  const none = setup({ deps: { canRead: (a: string) => a !== "settings_crm" } });
  assertEquals((await propose(none, input("mark_built", "#1042"))).card!.payload.body, { jobId: J_DALE });
});

Deno.test("mark built: an already built job, a board with no finished column, or extra values make no card", async () => {
  const x = setup();
  const done = await propose(x, input("mark_built", "Sam Byler"));
  assertEquals([done.card, json(done.out.content).note.startsWith("That one is already marked built")], [null, true]);
  assert((await propose(x, input("mark_built", "#1042", { buildDate: "2026-11-12" }))).out.content.startsWith("Marking it built is a card of its own"));
  x.w.stages = x.w.stages.map((st: Any) => (st.kind === "done" ? { ...st, archived: true } : st));
  assertEquals((await propose(x, input("mark_built", "#1042"))).out.content, BS_SAID.noDone);
  assertEquals(x.state.proposals.size, 0);
});

// ── Approve ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("approve add: one create_job with exactly the card's body; no Undo; a second press runs nothing", async () => {
  const x = setup();
  const { card } = await propose(x, input("add_to_schedule", "Ann", { buildDate: "2026-11-12", crew: "Amos" }));
  assertEquals((await handleProposalApprove(x.deps, who, { id: card!.id, hash: "wrong" })).status, 409);
  assertEquals(x.writes().length, 0);
  assertEquals((await approve(x, card!)).status, 200);
  assertEquals(x.writes().map((c) => [c.action, c.body]), [["create_job", card!.payload.body]]);
  const r = row(x, card!);
  assertEquals([r.status, r.undo, r.result.created], ["applied", null, 1]);
  const made = x.w.jobs.find((j: Any) => j.design_short_code === "ANN02");
  assertEquals([made.stage_id, made.due_date, made.scheduled_start, made.crew_id, made.serial], [ST_QUEUE, "2026-11-12", "2026-11-12", CR_AMOS, 2000]);
  // deno-lint-ignore no-explicit-any
  assertEquals(((await handleProposalGet(x.deps, who, { id: card!.id })).body.proposal as any).canUndo, false);
  assertEquals((await handleProposalUndo(x.deps, who, { id: card!.id })).status, 409);
  assertEquals((await approve(x, card!)).status, 409);
  assertEquals(x.writes().length, 1);
});

Deno.test("approve change and mark built: one call each, with exactly the card's body", async () => {
  const x = setup({ tz: "America/Denver" });
  const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12", note: "Loft right" }))).card!;
  await approve(x, c);
  assertEquals(x.writes().map((w) => [w.action, w.body]), [["update_job", { jobId: J_DALE, scheduledStart: "2026-11-12", dueDate: "2026-11-12", notes: "Loft right" }]]);
  assertEquals([jobRow(x, J_DALE).due_date, jobRow(x, J_DALE).scheduled_start, jobRow(x, J_DALE).notes, jobRow(x, J_DALE).crew_id], ["2026-11-12", "2026-11-12", "Loft right", CR_AMOS]);
  assertEquals(row(x, c).status, "applied");
  const b = (await propose(x, input("mark_built", "#1050"))).card!;
  await approve(x, b);
  assertEquals(x.writes().at(-1), { fn: "portal-schedule", action: "complete_job", body: { jobId: J_LOT, tz: "America/Denver" } });
  assertEquals([jobRow(x, J_LOT).stage_id, typeof jobRow(x, J_LOT).completed_at], [ST_DONE, "string"]);
  assertEquals(row(x, b).status, "applied");
  assertEquals(x.writes().length, 2);
});

Deno.test("approve: a repair's last shop job says to close the repair, and Jack never closes it", async () => {
  const x = setup();
  const b = (await propose(x, input("mark_built", "#977"))).card!;
  await approve(x, b);
  assertEquals(row(x, b).result.notes, ["That was the repair's last shop job. Close the repair on the Repairs tab when the work is done."]);
  assert(!x.w.calls.some((c) => c.action === "update_repair"));
  assertEquals(x.w.repairs[0].status, "approved");
});

Deno.test("approve re-reads first: anything the card showed that moved refuses, and nothing is sent", async () => {
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12" }))).card!;
    Object.assign(jobRow(x, J_DALE), { due_date: "2026-11-11", updated_at: x.w.stamp() });
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).failure], ["failed", `Its build date ${BS_SAID.moved}`]);
    assertEquals(x.writes().length, 0);
  }
  {
    // A write the card didn't show still moves updated_at (the customer's change order, a stage move).
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { note: "Loft right" }))).card!;
    jobRow(x, J_DALE).updated_at = x.w.stamp();
    await approve(x, c);
    assertEquals(row(x, c).failure, `This job ${BS_SAID.moved}`);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.jobs.push(job({ id: "b0000000-0000-4000-8000-000000000099", design_short_code: "ANN02" }));
    await approve(x, c);
    assertEquals(row(x, c).failure, "Someone put it on the build schedule since I showed you this, so I didn't add it again.");
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.designs.ANN02.contact.name = "Ann Leeds";
    await approve(x, c);
    assertEquals(row(x, c).failure, `It ${BS_SAID.moved}`);
  }
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann", { crew: "Eli" }))).card!;
    x.w.crews[1].active = false;
    await approve(x, c);
    assertEquals(row(x, c).failure, `That crew ${BS_SAID.moved}`);
    assertEquals(x.writes().length, 0);
  }
  {
    const x = setup();
    const c = (await propose(x, input("mark_built", "#1042"))).card!;
    Object.assign(jobRow(x, J_DALE), { stage_id: ST_DONE, completed_at: new Date(NOW).toISOString(), updated_at: x.w.stamp() });
    await approve(x, c);
    assertEquals(row(x, c).status, "failed");
    assertEquals(x.writes().length, 0);
  }
});

Deno.test("approve: the add-on gone or unreadable, or the board unreadable, refuses and sends nothing", async () => {
  for (const [set, said] of [
    [(x: X) => { x.w.addOn = false; }, BS_SAID.addOnGone],
    [(x: X) => { x.w.billingStatus = 503; }, BS_SAID.addOnUnreadAtApprove],
    [(x: X) => { x.w.boardStatus = 500; }, BS_SAID.boardUnread],
  ] as const) {
    const x = setup();
    const c = (await propose(x, input("mark_built", "#1042"))).card!;
    set(x);
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).failure], ["failed", said]);
    assertEquals(x.writes().length, 0);
  }
});

Deno.test("approve: the route's refusal goes on the card in its words, and nothing is sent again", async () => {
  const x = setup();
  const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
  x.w.operatorReadOnly = true;
  await approve(x, c, { ...who, operatorEmail: "ops@example.test" });
  assertEquals([row(x, c).status, row(x, c).failure], ["failed", "This operator account is read-only. Nothing was added."]);
  assertEquals(x.writes().length, 1);
});

Deno.test("approve: a lost answer is never sent again; the board decides whether it landed", async () => {
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.mode.create_job = "lost";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).undo, x.writes().length], ["applied", null, 1]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.mode.create_job = "dropped";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).failure, x.writes().length], ["failed", BS_SAID.didntGo, 1]);
  }
  {
    // A fault, and then the board can't be read: unsure, with where to look.
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.mode.create_job = "fault";
    const realSchedule = x.deps.call;
    let n = 0;
    const deps = x.make({
      call(fn, action, body) {
        if ((fn as string) === "portal-schedule" && action === "build_board" && ++n > 1) return Promise.resolve({ status: 503, data: null });
        return realSchedule.call(this, fn, action, body);
      },
    });
    await approve(x, c, who, deps);
    assertEquals([row(x, c).status, row(x, c).result.reports[0].reason, x.writes().length], ["partly_applied", BS_SAID.unsure, 1]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12" }))).card!;
    x.w.mode.update_job = "lost";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).undo.jobId, x.writes().length], ["applied", J_DALE, 1]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12" }))).card!;
    x.w.mode.update_job = "dropped";
    await approve(x, c);
    assertEquals([row(x, c).status, x.writes().length], ["failed", 1]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("mark_built", "#1042"))).card!;
    x.w.mode.complete_job = "lost";
    await approve(x, c);
    assertEquals([row(x, c).status, x.writes().length], ["applied", 1]);
    assertEquals((await handleProposalUndo(x.deps, who, { id: c.id })).status, 200);
    assertEquals([jobRow(x, J_DALE).stage_id, jobRow(x, J_DALE).completed_at], [ST_QUEUE, null]);
  }
});

Deno.test("approve: a 200 whose body didn't arrive landed, so it is never 'nothing was saved'; the board decides", async () => {
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12", crew: "Eli" }))).card!;
    x.w.mode.update_job = "garbled";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).failure, row(x, c).undo?.jobId, x.writes().length], ["applied", null, J_DALE, 1]);
    // Its Undo is there, and works.
    x.w.mode.update_job = "ok";
    assertEquals((await handleProposalUndo(x.deps, who, { id: c.id })).status, 200);
    assertEquals([row(x, c).status, jobRow(x, J_DALE).due_date, jobRow(x, J_DALE).crew_id], ["undone", "2026-11-10", CR_AMOS]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("mark_built", "#1042"))).card!;
    x.w.mode.complete_job = "garbled";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).failure, typeof row(x, c).undo?.completedFrom, x.writes().length], ["applied", null, "string", 1]);
  }
  {
    const x = setup();
    const c = (await propose(x, input("add_to_schedule", "Ann"))).card!;
    x.w.mode.create_job = "garbled";
    await approve(x, c);
    assertEquals([row(x, c).status, row(x, c).result.created, x.writes().length], ["applied", 1, 1]);
  }
  {
    // An Undo whose 200 didn't arrive whole stays undoable, and the next press reads first.
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { crew: "Eli" }))).card!;
    await approve(x, c);
    x.w.mode.update_job = "garbled";
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals([row(x, c).status, row(x, c).result.undo.failed, jobRow(x, J_DALE).crew_id], ["applied", 1, CR_AMOS]);
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals([row(x, c).status, row(x, c).result.undo.restored, x.writes().length], ["undone", 1, 2]);
  }
});

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────

Deno.test("undo change: each column goes back separately, and a field changed since is named and left", async () => {
  const x = setup();
  const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12", note: "Loft right" }))).card!;
  await approve(x, c);
  // The undo plan comes back from jsonb with its date line's keys reordered, as the database answers it.
  assertEquals(Object.keys(row(x, c).undo.lines[0].to).join(), "due,start");
  // Someone edits the note by hand afterwards.
  Object.assign(jobRow(x, J_DALE), { notes: "Loft right, and a vent", updated_at: x.w.stamp() });
  assertEquals((await handleProposalUndo(x.deps, who, { id: c.id })).status, 200);
  assertEquals(x.writes().at(-1)!.body, { jobId: J_DALE, scheduledStart: "2026-11-09", dueDate: "2026-11-10" });
  assertEquals([jobRow(x, J_DALE).scheduled_start, jobRow(x, J_DALE).due_date, jobRow(x, J_DALE).notes], ["2026-11-09", "2026-11-10", "Loft right, and a vent"]);
  const r = row(x, c);
  assertEquals(r.status, "undone");
  assertEquals(r.result.undo.restored, 1);
  assertEquals(r.result.undo.reports, [{ label: "Note on the card", status: "changed", reason: "Note on the card was changed since, so I left it." }]);
  assertEquals((await handleProposalUndo(x.deps, who, { id: c.id })).status, 409);
});

Deno.test("undo change: a job marked built since keeps its date; a failed read or a lost answer keeps Undo there", async () => {
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { buildDate: "2026-11-12" }))).card!;
    await approve(x, c);
    Object.assign(jobRow(x, J_DALE), { stage_id: ST_DONE, completed_at: new Date(NOW).toISOString(), updated_at: x.w.stamp() });
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals(row(x, c).result.undo.reports[0].reason, "It's been marked built since, so I left its build date.");
    assertEquals(jobRow(x, J_DALE).due_date, "2026-11-12");
    assertEquals(x.writes().length, 1);
  }
  {
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { crew: "Eli" }))).card!;
    await approve(x, c);
    x.w.boardStatus = 500;
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals([row(x, c).status, row(x, c).result.undo.failed], ["applied", 1]);
    x.w.boardStatus = 200;
    x.w.mode.update_job = "dropped";
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals(row(x, c).status, "applied");
    x.w.mode.update_job = "ok";
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals([row(x, c).status, jobRow(x, J_DALE).crew_id], ["undone", CR_AMOS]);
  }
  {
    // Already put back by hand counts as back, and nothing is sent.
    const x = setup();
    const c = (await propose(x, input("change", "#1042", { crew: "Eli" }))).card!;
    await approve(x, c);
    jobRow(x, J_DALE).crew_id = CR_AMOS;
    await handleProposalUndo(x.deps, who, { id: c.id });
    assertEquals([row(x, c).status, row(x, c).result.undo.restored, x.writes().length], ["undone", 1, 1]);
  }
});

Deno.test("undo mark built: move_job back to its column and position, with the zone", async () => {
  const x = setup({ tz: "America/Denver" });
  Object.assign(jobRow(x, J_DALE), { stage_id: ST_BUILD, position: 1234.5 });
  const c = (await propose(x, input("mark_built", "#1042"))).card!;
  await approve(x, c);
  assertEquals(jobRow(x, J_DALE).stage_id, ST_DONE);
  await handleProposalUndo(x.deps, who, { id: c.id });
  assertEquals(x.writes().at(-1), { fn: "portal-schedule", action: "move_job", body: { jobId: J_DALE, stageId: ST_BUILD, position: 1234.5, tz: "America/Denver" } });
  assertEquals([jobRow(x, J_DALE).stage_id, jobRow(x, J_DALE).completed_at, jobRow(x, J_DALE).position], [ST_BUILD, null, 1234.5]);
  assertEquals(row(x, c).status, "undone");
});

Deno.test("undo mark built: refused once its delivery went out; left when moved or re-marked since", async () => {
  const run = async (after: (x: X) => void) => {
    const x = setup();
    const c = (await propose(x, input("mark_built", "#1042"))).card!;
    await approve(x, c);
    after(x);
    await handleProposalUndo(x.deps, who, { id: c.id });
    return { r: row(x, c), moves: x.writes().filter((w) => w.action === "move_job").length, job: jobRow(x, J_DALE) };
  };
  const out = await run((x) => { x.w.loads[0].status = "out"; });
  assertEquals([out.r.status, out.r.result.undo.reports[0].status, out.moves, out.job.stage_id], ["undone", "kept", 0, ST_DONE]);
  assert(out.r.result.undo.reports[0].reason.startsWith("Its delivery has gone out since"));
  const delivered = await run((x) => { x.w.stops[0].delivered_at = new Date(NOW).toISOString(); });
  assertEquals([delivered.r.result.undo.reports[0].status, delivered.moves], ["kept", 0]);
  const moved = await run((x) => { Object.assign(jobRow(x, J_DALE), { stage_id: ST_BUILD, completed_at: null }); });
  assertEquals([moved.r.result.undo.reports[0].reason, moved.moves], ["It was moved since, so I left it where it is.", 0]);
  const redone = await run((x) => { jobRow(x, J_DALE).completed_at = "2026-12-01T12:00:00Z"; });
  assertEquals([redone.r.result.undo.reports[0].reason, redone.moves], ["It was marked built again since, so I left it built.", 0]);
  const gone = await run((x) => { x.w.jobs = x.w.jobs.filter((j: Any) => j.id !== J_DALE); });
  assertEquals(gone.r.result.undo.reports[0].reason, BS_SAID.gone);
  const archived = await run((x) => { x.w.stages[1].archived = true; });
  assert(archived.r.result.undo.reports[0].reason.startsWith("The column it was in isn't on your board any more"));
});

Deno.test("undo mark built: a delivery on a stop build_board doesn't link to the job still keeps it built", async () => {
  const run = async (opts: Parameters<typeof setup>[0], jobQ: string, after: (x: X) => void) => {
    const x = setup(opts);
    const c = (await propose(x, input("mark_built", jobQ))).card!;
    await approve(x, c);
    after(x);
    await handleProposalUndo(x.deps, who, { id: c.id });
    return { r: row(x, c), moves: x.writes().filter((w) => w.action === "move_job").length, reads: x.w.calls.filter((w) => w.action === "loads").length };
  };
  // A lot building sold before it was hauled: the pool's "deliver to the buyer" row makes a stop
  // with only its unit (and the buyer's design code), never the build job.
  const saleStop = (x: X, load: string, delivered: string | null) =>
    x.w.stops.push({ id: "s0000000-0000-4000-8000-000000000009", build_job_id: null, load_id: load, delivered_at: delivered, inventory_unit_id: U_JOB, design_short_code: "BUYER7", customer_phone: null, dest_street: null });
  const out = await run({}, "#1050", (x) => saleStop(x, L_OUT, null));
  assertEquals([out.r.status, out.r.result.undo.reports[0].reason, out.moves], ["undone", BS_SAID.deliveryOut, 0]);
  const delivered = await run({}, "#1050", (x) => saleStop(x, L_SEVEN, new Date(NOW).toISOString()));
  assertEquals([delivered.r.result.undo.reports[0].reason, delivered.moves], [BS_SAID.deliveryOut, 0]);
  const planned = await run({}, "#1050", (x) => saleStop(x, L_SEVEN, null));
  assertEquals([planned.r.status, planned.r.result.undo.reports, planned.moves], ["undone", [], 1]);
  // An order whose job was removed and added back: its stop keeps only the design code.
  const codeOnly = await run({}, "#1042", (x) => {
    x.w.stops[0].build_job_id = null;
    x.w.stops[0].delivered_at = new Date(NOW).toISOString();
  });
  assertEquals([codeOnly.r.result.undo.reports[0].reason, codeOnly.moves], [BS_SAID.deliveryOut, 0]);
  // Someone who can't open the Delivery Schedule can't have it checked, so it stays built.
  const unseen = await run({ deps: { canRead: (a: string) => a !== "delivery_schedule" } }, "#1050", () => {});
  assertEquals([unseen.r.status, unseen.r.result.undo.reports[0].reason, unseen.moves, unseen.reads], ["undone", BS_SAID.deliveryUnseen, 0, 0]);
  // A read that fails keeps Undo there.
  const unread = await run({}, "#1050", (x) => { x.w.loadsStatus = 500; });
  assertEquals([unread.r.status, unread.r.result.undo.failed, unread.moves], ["applied", 1, 0]);
  // A repair's shop job and a job added by hand ride no building delivery: no read.
  const rep = await run({ deps: { canRead: (a: string) => a !== "delivery_schedule" } }, "#977", () => {});
  assertEquals([rep.r.status, rep.r.result.undo.reports, rep.moves, rep.reads], ["undone", [], 1, 0]);
});

Deno.test("undo mark built: a Delivery Schedule the plan leaves out says so and keeps the Undo; any other 403 is still 'couldn't check'", async () => {
  // A company the server blocks by its map, with the Build Schedule and without the Delivery
  // Schedule. The card and its put-back are the Build Schedule's, but the check that the building
  // has not gone out reads portal-schedule `loads`, which is the Delivery Schedule's: that door
  // answers 403 module_off, on every press. It used to be told as a read that failed ("I couldn't
  // check its delivery just now. Press Undo to try again."), which pressing again never cures.
  const x = setup();
  const c = (await propose(x, input("mark_built", "#1050"))).card!;
  await approve(x, c);
  const had = row(x, c).undo;
  const real = x.deps.call;
  let loads: { status: number; data: Record<string, unknown> | null } | null = { status: 403, data: { error: MODULE_REFUSAL, code: "module_off" } };
  x.deps.call = (fn, action, body) => ((fn as string) === "portal-schedule" && action === "loads" && loads ? Promise.resolve(loads) : real(fn, action, body));
  const press = async () => {
    await handleProposalUndo(x.deps, who, { id: c.id });
    return { r: row(x, c), moves: x.writes().filter((w) => w.action === "move_job").length };
  };

  const refused = await press();
  assertEquals(refused.r.result.undo.reports, [{ label: c.title, status: "refused", reason: BS_SAID.deliveryNoPlan }]);
  assert(/isn't part of this account's plan/.test(BS_SAID.deliveryNoPlan) && !/try again/i.test(BS_SAID.deliveryNoPlan), BS_SAID.deliveryNoPlan);
  // It stays built, and the Undo is NOT spent: the card is still applied with its put-back on it.
  assertEquals([refused.r.status, refused.r.result.undo.failed, refused.r.result.undo.restored, refused.moves], ["applied", 1, 0, 0]);
  assertEquals(refused.r.undo, had);
  assertEquals(jobRow(x, J_LOT).stage_id, ST_DONE);

  // Any other 403 on that read (a person's access changed since, a read-only operator) is not the
  // plan's and is told as it always was. A company that is not named can only ever get these.
  loads = { status: 403, data: { error: "You don't have access to that." } };
  const other = await press();
  assertEquals(other.r.result.undo.reports, [{ label: c.title, status: "error", reason: BS_SAID.deliveryUnread }]);
  assertEquals([other.r.status, other.r.result.undo.failed, other.moves], ["applied", 1, 0]);

  // The tab comes back: the same press now puts it back.
  loads = null;
  const back = await press();
  assertEquals([back.r.status, back.r.result.undo.reports, back.moves], ["undone", [], 1]);
  assert(jobRow(x, J_LOT).stage_id !== ST_DONE, "the job went back to its column");
});

// ── Access, switches, operators, the strict budget ───────────────────────────────────────────────

Deno.test("tools are offered by build_schedule access and the records switch; the propose is withheld after customer words", async () => {
  const names = (deps: Deps, s: TurnState) => toolsFor(deps, s).map((t) => t.name);
  const x = setup();
  const all = names(x.deps, x.turn());
  assert(all.includes("look_at_build_schedule") && all.includes("propose_build_schedule"));
  const viewer = x.make({ canEdit: (a: string) => a !== "build_schedule" });
  assert(names(viewer, x.turn()).includes("look_at_build_schedule") && !names(viewer, x.turn()).includes("propose_build_schedule"));
  assertEquals((await runTool(viewer, x.turn(), "propose_build_schedule", input("mark_built", "#1042"))).content, "That isn't available here right now.");
  const none = x.make({ canRead: (a: string) => a !== "build_schedule", canEdit: (a: string) => a !== "build_schedule" });
  assert(!names(none, x.turn()).some((t) => t.includes("build_schedule")));
  assert(!names(x.deps, { ...x.turn(), off: [RECORDS_SWITCH] }).some((t) => t.includes("build_schedule")));
  const read = { ...x.turn(), customerWordsRead: true };
  // Marking built and adding a sold building set off rules that text or email the customer, so after a
  // customer's words the propose is withheld, like a change order (11-09). The look stays.
  assertEquals(PIECE_TOOLS.get("propose_build_schedule")!.proposesChange, true);
  assert(names(x.deps, read).includes("look_at_build_schedule") && !names(x.deps, read).includes("propose_build_schedule"));
  assertEquals(x.state.proposals.size, 0);
});

Deno.test("after look_at_build_schedule the card can't go up in that turn; the next message makes it without a look", async () => {
  const x = setup();
  x.w.rules = [buildRule("Thank them", "build_completed", "send_email")];
  const s = x.turn();
  const look = await runTool(x.deps, s, "look_at_build_schedule", {});
  assert(!look.isError, look.content);
  assertEquals(s.customerWordsRead, true);
  assert(json(look.content).note.includes(BS_SAID.cardNextMessage), "Claude is told the card waits for the next message");
  // Claude asks for the card anyway, in the same turn: nothing is made and nothing is sent.
  const tried = await runTool(x.deps, s, "propose_build_schedule", input("mark_built", "Dale Smith"));
  assertEquals([tried.isError, tried.content], [true, "That isn't available here right now."]);
  assertEquals([s.proposalIds.length, x.state.proposals.size, x.writes().length], [0, 0, 0]);
  // The person's reply is a new turn: the propose finds the job by name, with no look first.
  const next = await propose(x, input("mark_built", "Dale Smith"));
  assertEquals(next.card!.kind, "build_job_built");
  assertEquals(next.s.customerWordsRead, undefined);
  assert(!next.out.content.includes("Dale"), "its answer carries no customer name, so the lock doesn't follow it");
  assertEquals(x.writes().length, 0);
});

Deno.test("approve is refused without edit access, with the records switch off, with Jack off, and once expired", async () => {
  // Each kind: a date change, and marking built (which sets off rules and moves the building's status).
  for (const ask of [input("change", "#1042", { buildDate: "2026-11-12" }), input("mark_built", "#1042")]) {
    const run = async (opts: Parameters<typeof setup>[0], expire = false) => {
      const x = setup(opts);
      const s = { ...x.turn(), off: [] };
      await runTool(x.make({ canEdit: () => true }), s, "propose_build_schedule", ask);
      const card = x.state.proposals.get(s.proposalIds[0])!;
      if (expire) card.expires_at = new Date(NOW - 1000).toISOString();
      const r = await approve(x, card);
      return { status: r.status, error: r.body.error, writes: x.writes().length, left: row(x, card).status };
    };
    const kind = ask.action;
    assertEquals([kind, await run({ deps: { canEdit: () => false } })], [kind, { status: 403, error: SENTENCES.noAccess, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({ off: [RECORDS_SWITCH] })], [kind, { status: 403, error: SENTENCES.switchedOff, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({ on: false })], [kind, { status: 403, error: SENTENCES.off, writes: 0, left: "ready" }]);
    assertEquals([kind, await run({}, true)], [kind, { status: 409, error: SENTENCES.expired, writes: 0, left: "expired" }]);
  }
});

Deno.test("approve mark built: a job taken off the board since is refused, and nothing is sent", async () => {
  const x = setup();
  const c = (await propose(x, input("mark_built", "#1042"))).card!;
  x.w.jobs = x.w.jobs.filter((j: Any) => j.id !== J_DALE);
  await approve(x, c);
  assertEquals([row(x, c).status, row(x, c).failure], ["failed", "That job isn't on the build schedule any more, so nothing was saved."]);
  assertEquals(x.writes().length, 0);
  assertEquals(row(x, c).undo, null);
});

Deno.test("an operator in view-as may approve, and the record names them", async () => {
  const x = setup();
  const c = (await propose(x, input("change", "#1042", { crew: "Eli" }))).card!;
  assertEquals((await approve(x, c, { ...who, operatorEmail: "ops@example.test" })).status, 200);
  assertEquals([row(x, c).status, row(x, c).approved_by_operator], ["applied", "ops@example.test"]);
});

Deno.test("strict budget: one strict tool, every property required, no union or nullable; the reader isn't strict", () => {
  const defs = buildSchedulePiece.tools.map((t) => t.def);
  assertEquals(strictCost(defs), { tools: 1, optional: 0, unions: 0 });
  const p = defs.find((d) => d.strict === true)!;
  assertEquals(p.name, "propose_build_schedule");
  assertEquals(p.input_schema.additionalProperties, false);
  assertEquals([...p.input_schema.required].sort(), Object.keys(p.input_schema.properties).sort());
  const text = JSON.stringify(p.input_schema);
  assert(!/anyOf|"nullable"|"type":\[/.test(text), text);
  for (const d of defs.filter((d) => d.strict !== true)) assert(/^(look_|find_)/.test(d.name), d.name);
  assertEquals(withinStrictLimits(defs).filter((d) => d.strict === true).map((d) => d.name), ["propose_build_schedule"]);
  assert(BUILD_SCHEDULE_KINDS.every((k) => k.startsWith("build_job_")), BUILD_SCHEDULE_KINDS.join());
  assertEquals(BUILD_SCHEDULE_KINDS, ["build_job_add", "build_job_change", "build_job_built"]);
});

Deno.test("no tool answer carries a contact detail, an id or a design code; propose answers carry no customer names", async () => {
  const x = setup();
  x.w.designs.ANN02.contact.name = "Ann Lee (816) 555-0100";
  x.w.jobs.push(job({ id: "b0000000-0000-4000-8000-000000000077", source: "manual", title: "Call Bob at 816-555-0111", customer_name: "bob@example.com", position: 9000 }));
  const outs = [
    (await runTool(x.deps, x.turn(), "look_at_build_schedule", {})).content,
    (await runTool(x.deps, x.turn(), "look_at_build_schedule", { find: "Bob" })).content,
    (await propose(x, input("change", "Dale", { crew: "Eli" }))).out.content,
    (await propose(x, input("add_to_schedule", "Dale"))).out.content,
    (await propose(x, input("add_to_schedule", "Ann"))).out.content,
    (await propose(x, input("mark_built", "Mary"))).out.content,
  ];
  for (const o of outs) {
    assert(!leaksContactDetails(o), o);
    for (const bad of ["DALE01", "ANN02", J_DALE, RP_PORCH, "example.com"]) assert(!o.includes(bad), `${bad} in ${o}`);
  }
  for (const o of outs.slice(2)) for (const name of ["Smith", "Jones", "Ann Lee", "Mary"]) assert(!o.includes(name), `${name} in ${o}`);
});

Deno.test("refs: the shortest start no other key shares, the same as every key against every key, and quick on a big board", () => {
  // deno-lint-ignore no-explicit-any
  const board = (jobs: string[], orders: string[] = []): any => ({ stages: [], crews: [], jobs: jobs.map((id) => ({ id })), stops: {}, orders: orders.map((code) => ({ code })), units: [], repairs: [] });
  const slow = (kind: string, keys: string[]) => {
    const spelled = keys.map(_test.lettersOf);
    return new Map(keys.map((k, i) => {
      let n = 5;
      while (n < spelled[i].length && spelled.some((x, j) => j !== i && x.startsWith(spelled[i].slice(0, n)))) n++;
      return [k, `${kind}-${spelled[i].slice(0, n)}`];
    }));
  };
  // Ids that share long starts (like the ones above), random ones, and design codes, which are hashed.
  const ids = [...Array.from({ length: 40 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`), ...Array.from({ length: 300 }, () => crypto.randomUUID())];
  const codes = Array.from({ length: 200 }, (_, i) => `C${(i * 7919).toString(36).toUpperCase()}`);
  const fast = _test.refsFor(board(ids, codes));
  assertEquals(Object.fromEntries(fast.job), Object.fromEntries(slow("job", ids)));
  assertEquals(Object.fromEntries(fast.order), Object.fromEntries(slow("order", codes)));
  assertEquals(new Set(fast.job.values()).size, ids.length);
  // build_board pages up to 40k jobs; every look and every card works out the refs of all of them.
  const many = Array.from({ length: 20_000 }, () => crypto.randomUUID());
  const t = performance.now();
  _test.refsFor(board(many));
  const ms = performance.now() - t;
  assert(ms < 1500, `20,000 refs took ${Math.round(ms)} ms`);
});

Deno.test("dates: only days that exist, shown with the weekday", () => {
  assert(realDay("2026-11-12") && !realDay("2026-02-30") && !realDay("2026-13-01") && !realDay("11/12/2026"));
  assertEquals(dayWords("2026-11-12"), "Thu, Nov 12, 2026");
  assertEquals(dayWords(null), "");
});
