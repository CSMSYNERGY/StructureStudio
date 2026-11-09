// delivery.ts: the delivery schedule, through agent.ts's own routing: the tools as Claude reaches them
// (runTool, toolsFor) and the cards as a person presses them (handleProposalApprove / handleProposalUndo).
// No network. A fake portal-schedule keeps the real routes' bodies, columns and refusals (loads, pool,
// create_load, add_stop, remove_stop, reorder_stops, mark_load_out, mark_load_delivered,
// mark_stop_delivered, from portal-schedule/index.ts), including their gaps: loads hands back every
// stop's phone and street line, add_stop answers with the whole row, mark_load_out re-stamps a load that
// is already out, reorder_stops lets a duplicate through. The unit ladder is _shared's own derivation.
// A fake portal-settings answers crm_rules_list for ruleWarn.ts.

import { assert, assertEquals } from "./test_assert.ts";
import { type Deps, handleProposalApprove, handleProposalGet, handleProposalUndo, type ProposalRow, runTool, SENTENCES, type Store, strictCost, toolsFor, type TurnState, type Who } from "./agent.ts";
import { PIECE_TOOLS, register } from "./pieces.ts";
import { leaksContactDetails } from "./redact.ts";
import { SAID } from "./common.ts";
import { RULE_WARN_SAID } from "./ruleWarn.ts";
import { DELIVERY_KINDS, DELIVERY_SAID, deliveryPiece, PREFIX, refsFor } from "./delivery.ts";
import { deriveLifecycle, type StageKind } from "../_shared/inventoryLifecycle.ts";

register([deliveryPiece]);

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };

const OWNER: Who = { clientId: "builder-a", userId: "u-owner", operatorEmail: null };
const OPERATOR: Who = { clientId: "builder-a", userId: "u-op", operatorEmail: "ahsan@example.test" };
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const id = () => crypto.randomUUID();

const STG_Q = id(), STG_B = id(), STG_DONE = id();
const D_SAM = id(), D_LEE = id(), U_SAM = id(), U_LEE = id();
const L7 = id(), L8 = id(), L9 = id(), L10 = id(), L12 = id(), L13 = id(), L14 = id();
const J_DALE = id(), J_ANN = id(), J_BIG = id(), J_NED = id(), J_EVE = id(), J_FRAN = id(), J_ED = id(), J_GUS = id(), J_HAL = id(), J_IVY = id(), J_WIDE = id(), J_KIM = id(), J_ROB = id();
const S_A = id(), S_B = id(), S_E = id(), S_C = id(), S_D = id(), S_IVY = id(), S_WIDE = id(), S_KIM = id(), S_ROB = id();
const UNIT1 = id(), REP1 = id();

// Every customer has a phone, an email and a street line, so any leak shows.
const contact = (name: string, n: number) => ({ name, phone: `(816) 555-01${String(n).padStart(2, "0")}`, email: `${name.split(" ")[0].toLowerCase()}@example.com`, street: `${1200 + n} N Main St`, city: "Sedalia", state: "MO", zip: "65301" });

// ── portal-schedule, as the code has it ──────────────────────────────────────────────────────────────

type Mode = "lost" | "lost_landed" | "down" | undefined;

class World {
  calls: { fn: string; action: string; body: Any }[] = [];
  mode: Record<string, Mode> = {};
  access: Record<string, "edit" | "view" | "none"> = { delivery_schedule: "edit", settings_crm: "view" };
  stages: Any[] = [{ id: STG_Q, name: "Queue", kind: "queue" }, { id: STG_B, name: "In Build", kind: "active" }, { id: STG_DONE, name: "Built", kind: "done" }];
  team: Any[] = [{ userId: U_SAM, role: "user", name: "Sam Driver" }, { userId: U_LEE, role: "user", name: "Lee Hauler" }];
  drivers: Any[] = [
    { id: D_SAM, client_id: "builder-a", user_id: U_SAM, display_name: "Sam", is_driver: true, active: true, wide_load_capable: true, max_width_ft: 12, deck_length_ft: 40, truck_name: "Big Ford", territory_ids: [] },
    { id: D_LEE, client_id: "builder-a", user_id: U_LEE, display_name: "Lee", is_driver: true, active: true, wide_load_capable: false, max_width_ft: 14, deck_length_ft: 30, truck_name: "Dodge", territory_ids: [] },
  ];
  designs: Record<string, Any> = {};
  jobs: Any[] = [];
  units: Any[] = [];
  repairs: Any[] = [];
  loads: Any[] = [];
  stops: Any[] = [];
  rules: Any[] = [
    rule("Delivery heads-up", "delivery_scheduled", "send_sms"),
    rule("Thank you", "delivered", "send_email"),
  ];

  constructor() {
    const d = (code: string, name: string, n: number, status = "accepted", selections: Any = null) => { this.designs[code] = { short_code: code, status, delivered_at: null, contact: contact(name, n), selections }; };
    d("DALE01", "Dale Smith", 1); d("ANN002", "Ann Jones", 2); d("BIG003", "Bea Big", 3); d("NED011", "Ned New", 11);
    d("EVE005", "Eve Stone", 5); d("FRAN06", "Fran Field", 6); d("ED0012", "Ed Early", 12); d("GUS007", "Gus Gray", 7); d("HAL008", "Hal Hill", 8);
    d("IVY009", "Ivy Ives", 9); d("WIDE13", "Wes Wide", 13); d("KIM004", "Kim Kerr", 4); d("BUYER3", "Bo Buyer", 14);
    d("ROB015", "Rob Rowe", 15);
    d("MASTER1", "Lot stock", 0, "inventory", { style: "utility", size: "8x12" });
    const job = (jid: string, code: string | null, serial: number, label: string, w: number, l: number, stage: string, o: Any = {}) => this.jobs.push({
      id: jid, client_id: "builder-a", source: "order", serial, customer_name: code ? this.designs[code].contact.name : null, title: label, building_label: label,
      width_ft: w, length_ft: l, design_short_code: code, inventory_unit_id: null, repair_id: null, stage_id: stage, due_date: day(3),
      completed_at: stage === STG_DONE ? new Date(Date.now() - DAY).toISOString() : null, ...o,
    });
    job(J_DALE, "DALE01", 1041, "Garden Shed 8x16", 8, 16, STG_DONE);
    job(J_ANN, "ANN002", 1042, "Lofted Barn 12x24", 12, 24, STG_DONE);
    job(J_BIG, "BIG003", 1043, "Big Barn 14x30", 14, 30, STG_DONE);
    job(J_NED, "NED011", 1044, "Garden Shed 8x12", 8, 12, STG_B, { due_date: day(30) });
    job(J_EVE, "EVE005", 1001, "Utility 8x12", 8, 12, STG_DONE);
    job(J_FRAN, "FRAN06", 1002, "Utility 8x12", 8, 12, STG_DONE);
    job(J_ED, "ED0012", 1003, "Utility 8x14", 8, 14, STG_DONE);
    job(J_GUS, "GUS007", 1004, "Garden Shed 8x16", 8, 16, STG_DONE);
    job(J_HAL, "HAL008", 1005, "Garden Shed 8x16", 8, 16, STG_DONE);
    job(J_IVY, "IVY009", 1006, "Lofted Barn 12x24", 12, 24, STG_DONE);
    job(J_WIDE, "WIDE13", 1007, "Lofted Barn 12x24", 12, 24, STG_DONE);
    job(J_KIM, "KIM004", 1008, "Garden Shed 8x12", 8, 12, STG_B);
    job(J_ROB, "ROB015", 1009, "Garden Shed 8x12", 8, 12, STG_DONE);
    this.units.push({ id: UNIT1, client_id: "builder-a", serial: 2026001, design_short_code: "MASTER1", sold_design_short_code: "BUYER3", sold_first_name: "Bo", location_id: "lot-1", sale_state: "sold" });
    this.repairs.push({ id: REP1, client_id: "builder-a", repair_no: 12, customer_name: "Pat Fixit", phone: "816-555-0199", street: "88 County Road 12", city: "Warsaw", state: "MO", zip: "65355", description: "Door sticks. Call 816-555-0199 or pat@example.com", serial: 998, status: "approved" });
    const load = (lid: string, no: number, status: string, date: string | null, driver: string | null, o: Any = {}) => {
      const dr = this.drivers.find((x) => x.id === driver);
      this.loads.push({
        id: lid, client_id: "builder-a", load_no: no, status, load_date: date, driver_id: driver, driver_user_id: dr?.user_id ?? null,
        deck_length_ft: dr?.deck_length_ft ?? null, max_width_ft: dr?.max_width_ft ?? null, is_wide: false, permit_status: "not_needed",
        route_label: "West run", miles_out: null, miles_back: null, notes: null, departed_at: status === "planned" ? null : new Date(Date.now() - 3_600_000).toISOString(),
        completed_at: null, override_reason: null, overridden_by: null, overridden_at: null, created_by: "u-owner",
        created_at: new Date(Date.now() - 2 * DAY).toISOString(), updated_at: new Date(Date.now() - DAY).toISOString(), ...o,
      });
    };
    load(L7, 7, "planned", day(8), D_SAM);
    load(L8, 8, "planned", day(9), null);
    load(L9, 9, "out", day(0), D_SAM);
    load(L10, 10, "planned", day(10), D_LEE, { is_wide: true, permit_status: "on_file" });
    load(L12, 12, "planned", day(11), D_SAM, { is_wide: true, permit_status: "needed" });
    load(L13, 13, "planned", day(12), D_SAM);
    load(L14, 14, "planned", day(13), D_SAM);
    this.stopFromJob(S_A, L7, 1, J_EVE); this.stopFromJob(S_B, L7, 2, J_FRAN); this.stopFromJob(S_E, L7, 3, J_ED);
    this.stopFromJob(S_C, L9, 1, J_GUS); this.stopFromJob(S_D, L9, 2, J_HAL);
    this.stopFromJob(S_IVY, L10, 1, J_IVY); this.stopFromJob(S_WIDE, L12, 1, J_WIDE); this.stopFromJob(S_KIM, L13, 1, J_KIM);
    this.stopFromJob(S_ROB, L14, 1, J_ROB);
    // L14 starts empty in most tests: its stop is taken off below, and put back where a test needs it.
    this.stops = this.stops.filter((s) => s.id !== S_ROB);
  }

  stopFromJob(sid: string, loadId: string, order: number, jobId: string) {
    const j = this.jobs.find((x) => x.id === jobId);
    const c = j.design_short_code ? this.designs[j.design_short_code].contact : {};
    const stamp = new Date(Date.now() - DAY).toISOString();
    this.stops.push({
      id: sid, client_id: "builder-a", load_id: loadId, stop_order: order, source: j.source, build_job_id: j.id, design_short_code: j.design_short_code,
      inventory_unit_id: null, repair_id: null, serial: j.serial, customer_name: j.customer_name, customer_phone: c.phone ?? null, building_label: j.building_label,
      width_ft: j.width_ft, length_ft: j.length_ft, pickup: "shop", dest_street: c.street ?? null, dest_city: c.city ?? null, dest_state: c.state ?? null,
      dest_zip: c.zip ?? null, territory_id: null, lat: null, lng: null, leg_miles: null, time_window: null, site_notes: "Gate code 4411, call 816-555-0177 first", delivered_at: null,
      created_at: stamp, updated_at: stamp,
    });
  }

  load(lid: string) { return this.loads.find((l) => l.id === lid); }
  stop(sid: string) { return this.stops.find((s) => s.id === sid); }
  stopsOn(lid: string) { return this.stops.filter((s) => s.load_id === lid).sort((a, b) => a.stop_order - b.stop_order); }
  of(action: string) { return this.calls.filter((c) => c.action === action); }
  stageKind(j: Any): StageKind | null { return (this.stages.find((s) => s.id === j?.stage_id)?.kind ?? null) as StageKind | null; }

  lifecycle(unitIds: string[]) {
    const out: Record<string, { lifecycle: string }> = {};
    for (const uid of unitIds) {
      const u = this.units.find((x) => x.id === uid);
      if (!u) continue;
      const j = this.jobs.find((x) => x.inventory_unit_id === uid);
      out[uid] = {
        lifecycle: deriveLifecycle({
          soldDesignShortCode: u.sold_design_short_code ?? null,
          job: j ? { stageKind: this.stageKind(j), dueDate: j.due_date ?? null, completedAt: j.completed_at ?? null } : null,
          stops: this.stops.filter((s) => s.inventory_unit_id === uid).map((s) => ({ designShortCode: s.design_short_code ?? null, deliveredAt: s.delivered_at ?? null })),
        }),
      };
    }
    return out;
  }

  // portal-schedule index.ts:732-747
  recomputeWide(lid: string) {
    const l = this.load(lid);
    const isWide = this.stopsOn(lid).some((s) => Number(s.width_ft) > 8.5);
    l.is_wide = isWide;
    l.updated_at = new Date().toISOString();
    if (isWide && l.permit_status === "not_needed") l.permit_status = "needed";
    if (!isWide && l.permit_status === "needed") l.permit_status = "not_needed";
  }

  // portal-schedule index.ts:633-730
  unbuiltStops(lid: string) {
    const all = this.stopsOn(lid);
    const out: Any[] = [];
    for (const s of all) {
      if (s.build_job_id) {
        const j = this.jobs.find((x) => x.id === s.build_job_id);
        if (!j || this.stageKind(j) !== "done") out.push({ stopId: s.id, stopOrder: s.stop_order, serial: s.serial, customerName: s.customer_name, buildJobId: s.build_job_id, buildStage: "In Build", buildDue: j?.due_date ?? null });
      } else if (s.inventory_unit_id) {
        const lc = this.lifecycle([s.inventory_unit_id])[s.inventory_unit_id]?.lifecycle;
        if (lc && ["requested", "in_queue", "scheduled_build"].includes(lc)) out.push({ stopId: s.id, stopOrder: s.stop_order, serial: s.serial, customerName: s.customer_name, buildJobId: null, buildStage: lc, buildDue: null });
      } else if (s.design_short_code) {
        const jobs = this.jobs.filter((x) => x.design_short_code === s.design_short_code);
        if (jobs.length && !jobs.some((x) => this.stageKind(x) === "done")) out.push({ stopId: s.id, stopOrder: s.stop_order, serial: s.serial, customerName: s.customer_name, buildJobId: null, buildStage: "In Build", buildDue: null });
      }
    }
    return out;
  }

  writeBack(s: Any, when: string) {
    if ((s.source !== "order" && s.source !== "inventory") || !s.design_short_code) return;
    const d = this.designs[s.design_short_code];
    if (d && ["sent", "accepted", "invoiced", "delivered"].includes(d.status)) { d.status = "delivered"; d.delivered_at = when; }
  }

  route(action: string, b: Any): Res {
    const out = (status: number, data: Record<string, unknown> | null): Res => ({ status, data: data ? clone(data) : null });
    const no = (status: number, error: string) => out(status, { error });
    if (action === "loads") {
      const stops = this.stops.slice().sort((x, y) => String(x.load_id).localeCompare(String(y.load_id)) || x.stop_order - y.stop_order);
      const jobIds = [...new Set(stops.map((s) => s.build_job_id).filter(Boolean))];
      const buildByJob = Object.fromEntries(jobIds.map((jid) => {
        const j = this.jobs.find((x) => x.id === jid);
        const st = this.stages.find((x) => x.id === j?.stage_id);
        return [jid, { stage: st?.name ?? null, kind: st?.kind ?? null, dueDate: j?.due_date ?? null, completedAt: j?.completed_at ?? null }];
      }));
      const unitIds = [...new Set(stops.map((s) => s.inventory_unit_id).filter(Boolean))] as string[];
      return out(200, { loads: this.loads, stops, buildByJob, unitLifecycle: this.lifecycle(unitIds), drivers: this.drivers.filter((d) => d.active), territories: [], team: this.team });
    }
    if (action === "pool") {
      const stopJob = new Set(this.stops.map((s) => s.build_job_id).filter(Boolean));
      const stopRepair = new Set(this.stops.map((s) => s.repair_id).filter(Boolean));
      const stopDesign = new Set(this.stops.map((s) => s.design_short_code).filter(Boolean));
      const soldCode: Record<string, string> = {};
      for (const u of this.units) if (u.sale_state === "sold" && u.sold_design_short_code) soldCode[u.id] = u.sold_design_short_code;
      const stopUnit = new Set(this.stops.filter((s) => s.inventory_unit_id && (!s.delivered_at || s.design_short_code === soldCode[s.inventory_unit_id])).map((s) => s.inventory_unit_id));
      const jobs = this.jobs.filter((j) => j.source !== "repair" && !stopJob.has(j.id) && !(j.design_short_code && stopDesign.has(j.design_short_code)) && !(j.inventory_unit_id && stopUnit.has(j.inventory_unit_id))).map((j) => {
        const c = j.design_short_code ? this.designs[j.design_short_code]?.contact ?? {} : {};
        const st = this.stages.find((x) => x.id === j.stage_id);
        return {
          buildJobId: j.id, source: j.source, serial: j.serial, customerName: j.customer_name, title: j.title, buildingLabel: j.building_label,
          widthFt: j.width_ft, lengthFt: j.length_ft, designShortCode: j.design_short_code, inventoryUnitId: j.inventory_unit_id,
          buildStage: st?.name ?? null, buildKind: st?.kind ?? null, dueDate: j.due_date, completedAt: j.completed_at, wide: Number(j.width_ft) > 8.5,
          destCity: c.city ?? null, destState: c.state ?? null, destZip: c.zip ?? null, territoryId: null,
          readyDate: j.completed_at ? String(j.completed_at).slice(0, 10) : (j.due_date ?? null),
        };
      });
      const inventory = this.units.filter((u) => u.sale_state === "sold" && !this.stops.some((s) => s.inventory_unit_id === u.id && (!s.delivered_at || s.design_short_code === u.sold_design_short_code)))
        .map((u) => ({ inventoryUnitId: u.id, serial: u.serial, designShortCode: u.design_short_code, soldFirstName: u.sold_first_name, buildingLabel: "Utility 8x12", location: { id: "lot-1", name: "Main Lot", city: "Sedalia" } }));
      const repairs = this.repairs.filter((r) => ["requested", "approved", "in_progress"].includes(r.status) && !stopRepair.has(r.id))
        .map((r) => ({ id: r.id, repair_no: r.repair_no, customer_name: r.customer_name, description: r.description, serial: r.serial, status: r.status }));
      const ids = [...new Set([...inventory.map((i) => i.inventoryUnitId), ...jobs.map((j) => j.inventoryUnitId).filter(Boolean)])] as string[];
      return out(200, { jobs, orders: jobs, inventory, repairs, unitLifecycle: this.lifecycle(ids), territories: [], drivers: this.drivers });
    }
    if (action === "create_load") {
      // index.ts:1877-1905. dateStr turns a bad day into null, silently.
      const loadDate = typeof b.loadDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.loadDate) ? b.loadDate : null;
      const row = {
        id: id(), client_id: "builder-a", load_no: Math.max(0, ...this.loads.map((l) => l.load_no)) + 1, status: "planned", load_date: loadDate,
        driver_id: null, driver_user_id: null, deck_length_ft: null, max_width_ft: null, is_wide: false,
        permit_status: ["not_needed", "needed", "on_file"].includes(b.permitStatus) ? b.permitStatus : "not_needed",
        route_label: b.routeLabel ?? null, miles_out: null, miles_back: null, notes: b.notes ?? null, departed_at: null, completed_at: null,
        override_reason: null, overridden_by: null, overridden_at: null, created_by: "u-owner", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      this.loads.push(row);
      return out(200, { load: row });
    }
    if (action === "add_stop") {
      // index.ts:1959-2165
      if (!isUuid(b.loadId)) return no(400, "Invalid Load id.");
      const load = this.load(b.loadId);
      if (!load) return no(400, "Load not found.");
      if (load.status !== "planned") return no(400, "This load has already gone out.");
      const source = String(b.source ?? "");
      if (!["order", "inventory", "repair", "manual"].includes(source)) return no(400, "Invalid source.");
      const row: Any = {
        id: id(), client_id: "builder-a", load_id: load.id, source, customer_name: b.customerName ?? null, customer_phone: b.customerPhone ?? null,
        building_label: b.buildingLabel ?? null, width_ft: b.widthFt ?? null, length_ft: b.lengthFt ?? null, pickup: "shop", dest_street: b.destStreet ?? null,
        dest_city: b.destCity ?? null, dest_state: null, dest_zip: null, territory_id: null, lat: null, lng: null, leg_miles: null, time_window: null,
        site_notes: null, delivered_at: null, build_job_id: null, design_short_code: null, inventory_unit_id: null, repair_id: null, serial: null,
      };
      if (b.buildJobId) {
        const j = this.jobs.find((x) => x.id === b.buildJobId);
        if (!j) return no(400, "Job not found.");
        Object.assign(row, { build_job_id: j.id, design_short_code: j.design_short_code, inventory_unit_id: j.inventory_unit_id, repair_id: j.repair_id, serial: j.serial });
        row.customer_name ??= j.customer_name; row.building_label ??= j.building_label ?? j.title; row.width_ft ??= j.width_ft; row.length_ft ??= j.length_ft;
      } else if (source === "order") {
        return no(400, "buildJobId or designShortCode is required for an order stop.");
      } else if (source === "inventory") {
        const u = this.units.find((x) => x.id === b.inventoryUnitId);
        if (!u) return no(400, "Inventory unit not found.");
        Object.assign(row, { inventory_unit_id: u.id, serial: u.serial });
        if (u.sale_state === "sold" && u.sold_design_short_code) {
          row.design_short_code = u.sold_design_short_code;
          row.customer_name ??= this.designs[u.sold_design_short_code].contact.name;
          row.customer_phone ??= this.designs[u.sold_design_short_code].contact.phone;
        }
        row.building_label ??= "Utility 8x12"; row.width_ft ??= 8; row.length_ft ??= 12;
      } else if (source === "repair") {
        const r = this.repairs.find((x) => x.id === b.repairId);
        if (!r) return no(400, "Repair not found.");
        Object.assign(row, { repair_id: r.id, serial: r.serial });
        row.customer_name ??= r.customer_name; row.customer_phone ??= r.phone; row.building_label ??= `Repair R-${r.repair_no}`;
        row.dest_street ??= r.street; row.dest_city ??= r.city; row.dest_state ??= r.state; row.dest_zip ??= r.zip;
      }
      if (!row.dest_street && !row.dest_city && row.design_short_code) {
        const c = this.designs[row.design_short_code]?.contact ?? {};
        Object.assign(row, { dest_street: c.street ?? null, dest_city: c.city ?? null, dest_state: c.state ?? null, dest_zip: c.zip ?? null });
      }
      if (row.inventory_unit_id && this.stops.some((s) => s.inventory_unit_id === row.inventory_unit_id && !s.delivered_at)) return no(409, "That building is already on a load.");
      if (row.width_ft != null && load.max_width_ft != null && Number(row.width_ft) > Number(load.max_width_ft)) return no(400, `That building is ${row.width_ft}' wide — too wide for this truck (max ${load.max_width_ft}'). Assign a different driver or fix the truck specs in Settings → Team.`);
      if (row.width_ft != null && Number(row.width_ft) > 8.5 && load.driver_id) {
        const p = this.drivers.find((x) => x.id === load.driver_id);
        if (p && p.wide_load_capable === false) return no(400, `That building is ${row.width_ft}' wide, and ${p.display_name} isn't set up to run wide loads. Assign a different driver, or update their truck in Settings → Team.`);
      }
      row.stop_order = this.stopsOn(load.id).length + 1;
      // delivery_stops_one_per_design (090), mapped to 409 at :2158-2159.
      if (row.design_short_code && this.stops.some((s) => s.design_short_code === row.design_short_code)) return no(409, "That building is already on a load.");
      const stamp = new Date(Date.now() + this.stops.length).toISOString();
      row.created_at = stamp; row.updated_at = stamp;
      this.stops.push(row);
      this.recomputeWide(load.id);
      return out(200, { stop: row });
    }
    if (action === "remove_stop") {
      const s = isUuid(b.stopId) ? this.stop(b.stopId) : null;
      if (!s) return no(400, isUuid(b.stopId) ? "Stop not found." : "Invalid Stop id.");
      this.stops = this.stops.filter((x) => x.id !== s.id);
      this.stopsOn(s.load_id).forEach((x, i) => { x.stop_order = i + 1; });
      this.recomputeWide(s.load_id);
      return out(200, { ok: true });
    }
    if (action === "reorder_stops") {
      // index.ts:2206-2219: a size-and-membership check only, and no status check.
      const load = isUuid(b.loadId) ? this.load(b.loadId) : null;
      if (!load) return no(400, "Load not found.");
      const ids: string[] = Array.isArray(b.stopIds) ? b.stopIds : [];
      const owned = new Set(this.stopsOn(load.id).map((s) => s.id));
      if (ids.length !== owned.size || !ids.every((x) => owned.has(x))) return no(400, "Stop list doesn't match this load.");
      ids.forEach((x, i) => { this.stop(x).stop_order = i + 1; });
      return out(200, { ok: true });
    }
    if (action === "mark_load_out" || action === "mark_load_delivered") {
      const load = isUuid(b.loadId) ? this.load(b.loadId) : null;
      if (!load) return no(400, "Load not found.");
      if (load.status === "delivered") return out(200, { ok: true, already: true });
      const unbuilt = this.unbuiltStops(load.id);
      if (unbuilt.length && !b.override) return out(409, { blocked: true, error: "Some buildings on this load aren't marked Built.", unbuilt });
      const now = new Date().toISOString();
      if (action === "mark_load_delivered") {
        for (const s of this.stopsOn(load.id)) {
          if (!s.delivered_at) { s.delivered_at = now; s.updated_at = now; }
          this.writeBack(s, s.delivered_at);
        }
        Object.assign(load, { status: "delivered", completed_at: now, departed_at: load.departed_at ?? now, updated_at: now });
      } else {
        // An out load is not refused: departed_at is stamped again (:2283).
        Object.assign(load, { status: "out", departed_at: now, updated_at: now });
      }
      return out(200, { ok: true });
    }
    if (action === "mark_stop_delivered") {
      const s = isUuid(b.stopId) ? this.stop(b.stopId) : null;
      if (!s) return no(400, "Stop not found.");
      if (s.delivered_at) return out(200, { ok: true, already: true });
      if (this.unbuiltStops(s.load_id).some((u) => u.stopId === s.id)) return out(409, { blocked: true, error: "This building isn't marked Built yet. An owner or admin can override." });
      const now = new Date().toISOString();
      s.delivered_at = now; s.updated_at = now;
      this.writeBack(s, now);
      if (!this.stopsOn(s.load_id).some((x) => !x.delivered_at)) Object.assign(this.load(s.load_id), { status: "delivered", completed_at: now, updated_at: now });
      return out(200, { ok: true });
    }
    return no(400, "Unknown action");
  }

  settings(action: string): Res {
    if (action !== "crm_rules_list") return { status: 404, data: null };
    if (this.access.settings_crm === "none") return { status: 403, data: { error: "That isn't part of your access." } };
    return { status: 200, data: clone({ ok: true, rulesVersion: 2, pipelines: [], team: [], canManage: true, rules: this.rules, labels: [], timeZone: "America/Chicago" }) };
  }

  call(fn: string, action: string, body: Record<string, unknown>): Promise<Res> {
    this.calls.push({ fn, action, body: clone(body) });
    if (fn === "portal-settings") return Promise.resolve(this.settings(action));
    if (fn !== "portal-schedule") return Promise.resolve({ status: 404, data: null });
    const read = action === "loads" || action === "pool";
    const level = this.access.delivery_schedule;
    if (level === "none" || (!read && level !== "edit")) return Promise.resolve({ status: 403, data: { error: "That isn't part of your access." } });
    const m = this.mode[action];
    if (m === "down") return Promise.resolve({ status: 503, data: null });
    if (m === "lost") return Promise.resolve({ status: 0, data: null });
    const r = this.route(action, body);
    return Promise.resolve(m === "lost_landed" ? { status: 0, data: null } : r);
  }
}

function rule(name: string, event: string, kind: string): Any {
  return {
    id: id(), name, scopeKind: "pipeline", pipelineId: id(), triggerKind: "event", triggerEvent: event, elapsedAnchor: null, elapsedDays: null, schedule: null,
    conditions: [], oncePerCard: true, enabled: true, appliesFrom: "2026-10-01T00:00:00Z", actions: [{ kind, params: { body: "Hi {{first_name}}" } }],
    nextRunAt: null, armedCount: null, lastRun: null, stale: [],
  };
}

// ── The store, with jsonb's key order ────────────────────────────────────────────────────────────────

function jsonb<T>(v: T): T {
  if (Array.isArray(v)) return v.map(jsonb) as T;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonb((v as Record<string, unknown>)[k])])) as T;
  }
  return v;
}

function makeStore(cards: Map<string, ProposalRow>, settings: { on: boolean; off: string[] }): Store {
  let seq = 0;
  const none = () => Promise.resolve();
  return {
    settings: () => Promise.resolve(settings),
    setOff: none,
    usage: () => Promise.resolve({ monthCostMicros: 0, tenant24h: 0, user10m: 0, sheets24h: 0 }),
    openChat: () => Promise.resolve(null),
    createChat: () => Promise.resolve("chat1"),
    chats: () => Promise.resolve([]),
    messages: () => Promise.resolve([]),
    addMessage: (m) => Promise.resolve({ id: `m${++seq}`, role: m.role, body: m.body, created_at: "now", proposal_ids: m.proposalIds ?? [] }),
    bumpChat: none,
    closeChats: none,
    reopenChat: () => Promise.resolve(true),
    accountLine: () => Promise.resolve({ firstName: "Mike", title: "Owner", business: "Ridgeline", role: "owner" }),
    insertProposal: (p) => {
      const pid = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      const now = new Date().toISOString();
      const row = { id: pid, conversation_id: null, file_name: null, source: {}, preview: {}, payload: {}, answers: {}, result: null, undo: null, shown_hash: null, failure: null, approved_by: null, approved_by_operator: null, approved_at: null, applied_at: null, undone_at: null, expires_at: new Date(Date.now() + DAY).toISOString(), created_at: now, updated_at: now, ...jsonb(structuredClone(p)) } as ProposalRow;
      cards.set(pid, row);
      return Promise.resolve(row);
    },
    getProposal: (c, pid) => { const r = cards.get(pid); return Promise.resolve(r && r.client_id === c ? r : null); },
    updateProposal: (c, pid, patch, when, at) => {
      const r = cards.get(pid);
      if (!r || r.client_id !== c || (when && !when.includes(r.status)) || (at && r.updated_at !== at)) return Promise.resolve(null);
      Object.assign(r, jsonb(structuredClone(patch)));
      return Promise.resolve(r);
    },
    addProposalCost: none,
    proposals: () => Promise.resolve([...cards.values()]),
    proposalsById: (_c, ids) => Promise.resolve(ids.map((i) => cards.get(i)!).filter(Boolean)),
    names: () => Promise.resolve({}),
    fixtureStamp: () => Promise.resolve(null),
    memory: () => Promise.resolve([]),
    putMemory: () => Promise.resolve(false),
    forgetMemory: () => Promise.resolve(false),
  };
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

function djb2(t: string) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

interface X { w: World; deps: Deps; cards: Map<string, ProposalRow>; settings: { on: boolean; off: string[] }; logs: { code: string }[]; turn: (who?: Who) => TurnState }

function setup(o: { access?: Record<string, "edit" | "view" | "none">; off?: string[] } = {}): X {
  const w = new World();
  if (o.access) Object.assign(w.access, o.access);
  const cards = new Map<string, ProposalRow>();
  const settings = { on: true, off: o.off ?? [] };
  const level = (a: string) => w.access[a] ?? "none";
  const logs: { code: string }[] = [];
  const deps: Deps = {
    env: () => undefined,
    store: makeStore(cards, settings),
    portal: (a, b) => w.call("portal-settings", a, b),
    call: (fn, a, b) => w.call(fn, a, b),
    wallet,
    fetch: () => { throw new Error("no Claude in these tests"); },
    canRead: (a) => level(a) === "view" || level(a) === "edit",
    canEdit: (a) => level(a) === "edit",
    background: () => {},
    budgetMs: () => 300_000,
    makeId: () => crypto.randomUUID(),
    hash: (t) => Promise.resolve("h" + djb2(t)),
    log: (e) => { logs.push({ code: e.code }); return Promise.resolve(); },
    audit: () => Promise.resolve(),
    now: () => Date.now(),
    markSentWithJack: () => Promise.resolve(true),
  };
  return { w, deps, cards, settings, logs, turn: (who = OWNER) => ({ who, chatId: "chat1", off: settings.off, proposalIds: [] }) };
}

const json = (s: string) => JSON.parse(s);
const STREETS = /\d{3,5} N Main St|County Road/;
/** What Claude reads: no phone, email or street, ever. And kept out by the piece itself: agent.ts's last
 *  net (it scrubs a leaking answer and logs jack_redact_net) never has to catch anything. */
function clean(content: string, x?: X) {
  assert(!leaksContactDetails(content), `a contact detail reached Claude: ${content.slice(0, 400)}`);
  assert(!STREETS.test(content), `a street line reached Claude: ${content.slice(0, 400)}`);
  if (x) assert(!x.logs.some((l) => l.code === "jack_redact_net"), "agent.ts's net had to scrub this answer: the piece let a contact detail through");
}

async function look(x: X, who = OWNER, input: Record<string, unknown> = {}) {
  const s = x.turn(who);
  const out = await runTool(x.deps, s, "look_at_delivery_loads", input);
  assert(!out.isError, out.content);
  clean(out.content, x);
  return { a: json(out.content), s };
}
async function pool(x: X) {
  const out = await runTool(x.deps, x.turn(), "find_to_be_loaded", {});
  assert(!out.isError, out.content);
  clean(out.content, x);
  return json(out.content);
}
const stopRef = (x: X, sid: string) => refsFor(PREFIX.stop, x.w.stops.map((s) => s.id)).get(sid)!;

async function propose(x: X, input: Record<string, unknown>, who = OWNER) {
  const s = x.turn(who);
  const out = await runTool(x.deps, s, "propose_delivery_change", { action: "", loadNumber: 0, loadDate: "", item: "", stopOrder: [], ...input });
  clean(out.content, x);
  return { out, card: s.proposalIds.length ? x.cards.get(s.proposalIds[0])! : null, s };
}
async function approve(x: X, card: ProposalRow, who = OWNER) {
  const r = await handleProposalApprove(x.deps, who, { id: card.id, hash: card.shown_hash });
  return { r, row: x.cards.get(card.id)! };
}
async function undo(x: X, card: ProposalRow, who = OWNER) {
  const r = await handleProposalUndo(x.deps, who, { id: card.id });
  return { r, row: x.cards.get(card.id)! };
}
async function canUndo(x: X, card: ProposalRow) {
  const g = await handleProposalGet(x.deps, OWNER, { id: card.id });
  return (g.body.proposal as Any).canUndo as boolean;
}
const writes = (x: X) => x.w.calls.filter((c) => c.fn === "portal-schedule" && c.action !== "loads" && c.action !== "pool");
/** Nothing a card stores holds a phone, an email or a street line either. */
const cardClean = (row: ProposalRow) => {
  const t = JSON.stringify({ preview: row.preview, payload: row.payload, result: row.result, undo: row.undo, failure: row.failure, title: row.title });
  assert(!leaksContactDetails(t.replace(/"[0-9a-f-]{36}"/g, '""')), `a contact detail was stored on the card: ${t.slice(0, 300)}`);
  assert(!STREETS.test(t) && !/Gate code/.test(t), "a street line or site note was stored on the card");
};

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────

Deno.test("look_at_delivery_loads: loads, stops, names and towns, refs not ids, and never a phone, email or street", async () => {
  const x = setup();
  const { a, s } = await look(x);
  assert(s.customerWordsRead === true, "the answer carries customer names, so the turn knows");
  const l7 = a.loads.find((l: Any) => l.load === 7);
  assertEquals([l7.status, l7.day, l7.driver, l7.wide, l7.permit, l7.driverClearedForWide, l7.truckMaxWidthFt], ["Planned", day(8), "Sam", false, "Not needed", true, 12]);
  assertEquals(l7.stops.map((x: Any) => [x.stop, x.customer, x.building, x.town, x.built]), [[1, "Eve Stone", "Utility 8x12", "Sedalia, MO", true], [2, "Fran Field", "Utility 8x12", "Sedalia, MO", true], [3, "Ed Early", "Utility 8x14", "Sedalia, MO", true]]);
  assert(l7.stops.every((x: Any) => /^stop-[bcdfghjkmnpqrstv]{5,}$/.test(x.ref)), "letter refs");
  const text = JSON.stringify(a);
  for (const uuid of [L7, S_A, J_EVE, D_SAM]) assert(!text.includes(uuid), `no uuid ${uuid}`);
  assert(!text.includes("Gate code"), "site notes stay out");
  assert(!a.loads.some((l: Any) => l.status === "Delivered"), "delivered loads only when asked");
  assertEquals(a.canChange, true);
});

Deno.test("find_to_be_loaded: buildings, a sold lot building and a repair, with the repair's own words scrubbed", async () => {
  const x = setup();
  const a = await pool(x);
  const dale = a.buildings.find((b: Any) => b.customer === "Dale Smith");
  assertEquals([dale.serial, dale.size, dale.built, dale.wide, dale.town, dale.kind], ["#1041", "8x16", true, false, "Sedalia, MO", "sold building"]);
  assert(/^build-[bcdfghjkmnpqrstv]{5,}$/.test(dale.ref), dale.ref);
  assertEquals(a.buildings.find((b: Any) => b.customer === "Ned New").built, false);
  assert(!a.buildings.some((b: Any) => b.customer === "Eve Stone"), "a building already on a load isn't waiting");
  assertEquals(a.lotBuildings[0].serial, "#2,026,001", "a long serial gets commas, so it never reads as a phone number");
  assertEquals([a.lotBuildings[0].buyer, a.lotBuildings[0].lot, a.lotBuildings[0].size], ["Bo", "Main Lot", "8x12"]);
  assertEquals(a.repairs[0].repair, "R-12");
  const about: string = a.repairs[0].about;
  assert(about.startsWith("Door sticks. Call [phone]") && about.endsWith("[email]") && !/\d{3}/.test(about), about);
});

Deno.test("look_at_delivery_loads: with includeDelivered, the loads delivered in the last 14 days, by the day they were delivered", async () => {
  const x = setup();
  // Planned for three weeks ago and marked delivered yesterday: the paperwork is often days late.
  Object.assign(x.w.load(L9), { status: "delivered", load_date: day(-21), completed_at: new Date(Date.now() - DAY).toISOString() });
  Object.assign(x.w.load(L13), { status: "delivered", load_date: day(-30), completed_at: new Date(Date.now() - 30 * DAY).toISOString() });
  assert(!(await look(x)).a.loads.some((l: Any) => l.status === "Delivered"), "only when asked");
  const { a } = await look(x, OWNER, { includeDelivered: true });
  assertEquals(a.loads.filter((l: Any) => l.status === "Delivered").map((l: Any) => l.load), [9]);
});

Deno.test("refsFor: the shortest start of each id (5 letters or more) no other id shares, and quick over a board's whole history", () => {
  const spellOf = (v: string) => v.replace(/[^0-9a-f]/gi, "").toLowerCase().split("").map((c) => "bcdfghjkmnpqrstv"[parseInt(c, 16)]).join("");
  const oneByOne = (ids: string[]) => {
    const spelled = ids.map(spellOf);
    return ids.map((_, i) => {
      let n = 5;
      while (n < spelled[i].length && spelled.some((s, j) => j !== i && s.startsWith(spelled[i].slice(0, n)))) n++;
      return PREFIX.stop + spelled[i].slice(0, n);
    });
  };
  // Ids sharing long starts, so many refs need more than 5 letters, among ordinary ones.
  const base = id();
  const close = Array.from({ length: 60 }, (_, k) => base.slice(0, 9 + (k % 25)) + id().slice(9 + (k % 25)));
  const ids = [...close, ...Array.from({ length: 400 }, () => id())];
  const refs = refsFor(PREFIX.stop, ids);
  assertEquals(ids.map((v) => refs.get(v)), oneByOne(ids));
  assert(ids.some((v) => refs.get(v)!.length > PREFIX.stop.length + 5), "some refs need more than 5 letters");
  assertEquals(new Set(refs.values()).size, ids.length);
  // Every stop the builder ever delivered is on the board. One against every other took seconds of CPU
  // at this size, inside a chat turn; a sort takes a few milliseconds.
  const many = Array.from({ length: 30_000 }, () => id());
  const t = performance.now();
  assertEquals(refsFor(PREFIX.stop, many).size, many.length);
  const ms = performance.now() - t;
  assert(ms < 3000, `refs for 30,000 stops took ${Math.round(ms)} ms`);
});

Deno.test("who is offered what: the propose tool is the one strict tool, and needs Delivery at edit; the reads need view", async () => {
  const full = setup();
  const names = (x: X) => toolsFor(x.deps, x.turn()).map((t) => t.name).filter((n) => /delivery|to_be_loaded/.test(n));
  assertEquals(names(full).sort(), ["find_to_be_loaded", "look_at_delivery_loads", "propose_delivery_change"]);
  const defs = toolsFor(full.deps, full.turn()).filter((t) => /delivery|to_be_loaded/.test(t.name));
  assertEquals(defs.filter((t) => t.strict).map((t) => t.name), ["propose_delivery_change"]);
  assertEquals(strictCost(defs), { tools: 1, optional: 0, unions: 0 });
  const viewer = setup({ access: { delivery_schedule: "view" } });
  assertEquals(names(viewer).sort(), ["find_to_be_loaded", "look_at_delivery_loads"]);
  const tried = await runTool(viewer.deps, viewer.turn(), "propose_delivery_change", { action: "create_load", loadNumber: 0, loadDate: day(5), item: "", stopOrder: [] });
  assert(tried.isError === true, "not offered, not run");
  assertEquals(viewer.cards.size, 0);
  assertEquals(names(setup({ access: { delivery_schedule: "none" } })), []);
  assertEquals(names(setup({ off: ["records"] })), [], "the records switch takes them all away");
  // Marking delivered moves estimates and sets off rules, and can't be undone: after a customer's words
  // the propose is withheld, like a change order (11-09). The reads stay.
  assertEquals(PIECE_TOOLS.get("propose_delivery_change")!.proposesChange, true);
  const afterWords = toolsFor(full.deps, { ...full.turn(), customerWordsRead: true }).map((t) => t.name).filter((n) => /delivery|to_be_loaded/.test(n));
  assertEquals(afterWords.sort(), ["find_to_be_loaded", "look_at_delivery_loads"]);
});

Deno.test("after either read the card can't go up in that turn, for any action; the next message makes it by number", async () => {
  for (const read of ["look_at_delivery_loads", "find_to_be_loaded"]) {
    const x = setup();
    const s = x.turn();
    const out = await runTool(x.deps, s, read, {});
    assert(!out.isError, out.content);
    assertEquals(s.customerWordsRead, true, read);
    assert(out.content.includes(DELIVERY_SAID.cardNextMessage), `${read} tells Claude the card waits for the next message`);
    // A customer's words could ask for any of these. None is made in the same turn, and nothing is sent.
    for (const input of [
      { action: "mark_load_delivered", loadNumber: 9 }, { action: "mark_load_out", loadNumber: 7 },
      { action: "mark_stop_delivered", loadNumber: 9, item: "stop 1" }, { action: "create_load", loadDate: day(20) },
      { action: "add_stop", loadNumber: 7, item: "#1041" }, { action: "reorder_stops", loadNumber: 7, stopOrder: ["2", "1", "3"] },
    ]) {
      const tried = await runTool(x.deps, s, "propose_delivery_change", { loadNumber: 0, loadDate: "", item: "", stopOrder: [], ...input });
      assertEquals([read, input.action, tried.isError, tried.content], [read, input.action, true, "That isn't available here right now."]);
    }
    assertEquals([s.proposalIds.length, x.cards.size, writes(x).length], [0, 0, 0]);
  }
  // The person's reply is a new turn: the load number alone makes the card, with no look first, and its
  // answer carries no customer name, so the turn stays open for it.
  const y = setup();
  const { out, card, s } = await propose(y, { action: "mark_load_delivered", loadNumber: 9 });
  assert(!out.isError, out.content);
  assertEquals([card!.kind, s.customerWordsRead], [DELIVERY_KINDS.mark_load_delivered, undefined]);
  for (const name of ["Gus", "Hal"]) assert(!out.content.includes(name), `the propose answer names no customer (${name})`);
});

Deno.test("a stop by its number on its load, a building by its serial, a repair by R-number: the same cards a ref makes", async () => {
  const x = setup();
  // mark_stop_delivered: "stop 1" with the load's number is the stop the ref names.
  const byNo = (await propose(x, { action: "mark_stop_delivered", loadNumber: 9, item: "stop 1" })).card!;
  const byRef = (await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_C) })).card!;
  assertEquals([byNo.payload.body, byNo.title], [byRef.payload.body, byRef.title]);
  assertEquals((await propose(x, { action: "mark_stop_delivered", loadNumber: 9, item: "2" })).card!.payload.body, { stopId: S_D });
  const noLoad = await propose(x, { action: "mark_stop_delivered", item: "stop 1" });
  assertEquals([noLoad.out.isError, noLoad.out.content, noLoad.card], [true, DELIVERY_SAID.stopNeedsLoad, null]);
  const noStop = await propose(x, { action: "mark_stop_delivered", loadNumber: 9, item: "stop 7" });
  assertEquals([noStop.out.content, noStop.card], [DELIVERY_SAID.noStopNo(9, 7), null]);
  // Its serial, with or without # and the load's number, is the same stop (11-09): the refusal said to use it.
  assertEquals(x.w.stops.find((s: Any) => s.id === S_C).serial, 1004);
  for (const [item, loadNumber] of [["#1004", 0], ["1004", 0], ["#1004", 9], [" #1004 ", 9]] as [string, number][]) {
    const bySerial = await propose(x, { action: "mark_stop_delivered", loadNumber, item });
    assert(!bySerial.out.isError, `${item} ${loadNumber}: ${bySerial.out.content}`);
    assertEquals([bySerial.card!.payload.body, bySerial.card!.title], [byNo.payload.body, byNo.title], `${item} ${loadNumber}`);
  }
  assertEquals((await propose(x, { action: "mark_stop_delivered", loadNumber: 7, item: "#1004" })).out.content, "That stop is on Load 9, not Load 7.");
  const noSerial = await propose(x, { action: "mark_stop_delivered", item: "#4444" });
  assertEquals([noSerial.out.content, noSerial.card], [DELIVERY_SAID.noStop, null]);
  assert(!DELIVERY_SAID.noStop.includes("find_to_be_loaded"), "a waiting ref can't name a stop on a load");
  // reorder_stops: stop numbers, refs, or both.
  const re = (await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: ["2", "stop 1", stopRef(x, S_E)] })).card!;
  assertEquals(re.payload.body, { loadId: L7, stopIds: [S_B, S_A, S_E] });
  const reBad = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: ["2", "1", "4"] });
  assert(reBad.out.isError && reBad.out.content.startsWith(DELIVERY_SAID.noStopNo(7, 4)) && /List every stop on Load 7 once/.test(reBad.out.content), reBad.out.content);
  // add_stop: a serial, with or without its #, and a repair by its number.
  const serial = (await propose(x, { action: "add_stop", loadNumber: 7, item: "#1041" })).card!;
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const viaRef = (await propose(x, { action: "add_stop", loadNumber: 7, item: ref })).card!;
  assertEquals(serial.payload.body, viaRef.payload.body);
  assertEquals((await propose(x, { action: "add_stop", loadNumber: 7, item: "1041" })).card!.payload.body, { loadId: L7, source: "order", buildJobId: J_DALE });
  assertEquals((await propose(x, { action: "add_stop", loadNumber: 8, item: "R-12" })).card!.payload.body, { loadId: L8, source: "repair", repairId: REP1 });
  assertEquals((await propose(x, { action: "add_stop", loadNumber: 8, item: "#2,026,001" })).card!.payload.body, { loadId: L8, source: "inventory", inventoryUnitId: UNIT1 });
  // A serial already on a load says where, as a ref does; a repair's serial never names the repair.
  const onLoad = await propose(x, { action: "add_stop", loadNumber: 8, item: "#1001" });
  assert(onLoad.out.isError && /already on Load 7 as stop 1/.test(onLoad.out.content), onLoad.out.content);
  const repairSerial = await propose(x, { action: "add_stop", loadNumber: 8, item: "#998" });
  assertEquals([repairSerial.out.content, repairSerial.card], [DELIVERY_SAID.noRef, null]);
  assertEquals(writes(x).length, 0, "only cards: nothing sent");
});

Deno.test("a serial that names two things waiting asks which, and makes no card", async () => {
  const x = setup();
  // The lot building's own build job waits beside the lot building, under the same serial.
  x.w.jobs.push({ id: id(), client_id: "builder-a", source: "inventory", serial: 2026001, customer_name: null, title: "Utility 8x12", building_label: "Utility 8x12", width_ft: 8, length_ft: 12, design_short_code: null, inventory_unit_id: UNIT1, repair_id: null, stage_id: STG_DONE, due_date: day(1), completed_at: new Date().toISOString() });
  const { out, card } = await propose(x, { action: "add_stop", loadNumber: 8, item: "2026001" });
  assertEquals([out.isError, out.content, card], [true, DELIVERY_SAID.serialTwice("#2,026,001"), null]);
  assertEquals(writes(x).length, 0);
});

Deno.test("only the six actions: a driver change, a load edit, a move or a delete gets no card and sends nothing", async () => {
  const x = setup();
  const def = deliveryPiece.tools.find((t) => t.def.name === "propose_delivery_change")!.def;
  assertEquals(def.input_schema.properties.action.enum, ["create_load", "add_stop", "reorder_stops", "mark_load_out", "mark_stop_delivered", "mark_load_delivered"]);
  for (const action of ["update_load", "assign_driver", "move_stop", "remove_stop", "delete_load", "update_stop", "override"]) {
    const { out, card } = await propose(x, { action, loadNumber: 7, item: stopRef(x, S_A) });
    assert(out.isError === true && !card, action);
  }
  assertEquals(writes(x).length, 0);
});

// ── create_load ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("create_load: a card with the day and nothing else; Approve sends just the day; there's no Undo", async () => {
  const x = setup();
  const { out, card } = await propose(x, { action: "create_load", loadDate: day(20) });
  assert(!out.isError, out.content);
  assert(card, "a card");
  assertEquals(card!.kind, DELIVERY_KINDS.create_load);
  assert(card!.title.startsWith("New delivery load for "), card!.title);
  assertEquals(card!.preview.undo, DELIVERY_SAID.createUndo);
  assert(/can't be undone/.test(json(out.content).note), "Claude is told to say so");
  assertEquals(writes(x).length, 0, "the tool changes nothing");
  const { r, row } = await approve(x, card!);
  assertEquals(r.status, 200);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["create_load", { loadDate: day(20) }]]);
  const made = x.w.loads.find((l) => l.load_date === day(20));
  assertEquals([made.load_no, made.driver_id, made.status], [15, null, "planned"]);
  assertEquals(row.result.loadNo, 15);
  assertEquals(await canUndo(x, card!), false);
});

Deno.test("create_load: refuses a day that isn't real or has gone, and names a load already on that day", async () => {
  const x = setup();
  // A day that isn't on the calendar, in the coming weeks: refused as not a day, not as gone (the route
  // would make it an undated load).
  const notADay = `${day(20).slice(0, 8)}32`;
  const cases: [string, RegExp][] = [[notADay, /Tell me the day/], ["", /Tell me the day/], ["next friday", /Tell me the day/], [day(-3), /already gone/], [day(400), /within the next year/]];
  for (const [d, re] of cases) {
    const { out, card } = await propose(x, { action: "create_load", loadDate: d });
    assert(out.isError === true && !card && re.test(out.content), `refused ${d}: ${out.content}`);
  }
  assertEquals(writes(x).length, 0);
  const { card } = await propose(x, { action: "create_load", loadDate: day(8) });
  assert(card!.preview.notes.includes("You already have Load 7 on that day."), JSON.stringify(card!.preview.notes));
});

Deno.test("create_load: a load added for that day after the card is refused at Approve, and nothing is sent", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "create_load", loadDate: day(20) });
  x.w.route("create_load", { loadDate: day(20) });
  const { row } = await approve(x, card!);
  assertEquals(row.status, "failed");
  assert(/changed since I showed you this/.test(row.failure ?? ""), row.failure ?? "");
  assertEquals(writes(x).length, 0);
});

Deno.test("create_load: a lost answer is never sent again; the board says whether it landed", async () => {
  const x = setup();
  x.w.mode.create_load = "lost_landed";
  const { card } = await propose(x, { action: "create_load", loadDate: day(21) });
  const { row } = await approve(x, card!);
  assertEquals([row.status, row.result.loadNo], ["applied", 15]);
  assertEquals(x.w.of("create_load").length, 1);

  const y = setup();
  y.w.mode.create_load = "lost";
  const c2 = (await propose(y, { action: "create_load", loadDate: day(22) })).card!;
  const r2 = (await approve(y, c2)).row;
  assertEquals(r2.status, "partly_applied");
  assertEquals(r2.result.reports[0].reason, DELIVERY_SAID.checkAgain);
  assertEquals(y.w.of("create_load").length, 1, "never sent twice");
  assertEquals(y.w.loads.some((l) => l.load_date === day(22)), false);
});

// ── add_stop ────────────────────────────────────────────────────────────────────────────────────────

async function poolRef(x: X, pick: (a: Any) => Any) {
  return pick(await pool(x)).ref as string;
}

Deno.test("add_stop: a card for a building waiting to be loaded, with the rule it sets off; Approve sends exactly the card; Undo takes it off", async () => {
  const x = setup();
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const { out, card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
  assert(!out.isError, out.content);
  assertEquals(card!.kind, DELIVERY_KINDS.add_stop);
  assertEquals(card!.title, "Add a stop to Load 7", "no customer in the title");
  assertEquals(card!.preview.lines[0].label, "Stop 4");
  assert(card!.preview.lines[0].to.includes("Dale Smith") && card!.preview.lines[0].to.includes("Sedalia"), card!.preview.lines[0].to);
  assert(card!.preview.notes[0].includes('"Delivery heads-up"') && /texts or emails the customer/.test(card!.preview.notes[0]), card!.preview.notes[0]);
  const said = json(out.content);
  assert(said.rules.includes("Delivery heads-up"), "the rule sentence is in the tool answer too");
  assert(!out.content.includes("Dale"), "the propose answer names no customer");
  cardClean(card!);

  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["add_stop", { loadId: L7, source: "order", buildJobId: J_DALE }]]);
  const added = x.w.stopsOn(L7)[3];
  assertEquals([added.build_job_id, added.stop_order, row.result.stopNumber], [J_DALE, 4, 4]);
  assertEquals(row.undo.stopId, added.id);
  cardClean(row);
  assertEquals(await canUndo(x, card!), true);

  const u = await undo(x, card!);
  assertEquals(u.row.status, "undone");
  assertEquals(u.row.result.undo.removed, 1);
  assertEquals(x.w.of("remove_stop").map((c) => c.body), [{ stopId: added.id }]);
  assertEquals(x.w.stopsOn(L7).length, 3);
});

Deno.test("add_stop: someone who can't open Automations hears a general rule sentence, with no names", async () => {
  const x = setup({ access: { settings_crm: "none" } });
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const { card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
  assertEquals(card!.preview.notes[0], RULE_WARN_SAID.general);
  assertEquals(card!.preview.ruleNames, []);
  assertEquals(x.w.of("crm_rules_list").length, 0, "it doesn't read rules it may not see");
});

Deno.test("add_stop: refuses a building already on a load, a load that's gone out, and what the truck can't take; nothing is sent", async () => {
  const x = setup();
  const onLoad = await propose(x, { action: "add_stop", loadNumber: 8, item: stopRef(x, S_A) });
  assert(onLoad.out.isError && /already on Load 7 as stop 1/.test(onLoad.out.content) && /don't move a building from one load to another/.test(onLoad.out.content), onLoad.out.content);
  // The board offers × only on a planned load, so a stop on a load that's out isn't "taken off first".
  const onOut = await propose(x, { action: "add_stop", loadNumber: 8, item: stopRef(x, S_C) });
  assert(onOut.out.isError && /already on Load 9 as stop 1\. Load 9 has gone out, so it stays on it\./.test(onOut.out.content) && !/take it off/.test(onOut.out.content), onOut.out.content);
  const jobRef = refsFor(PREFIX.build, [J_EVE, ...x.w.jobs.map((j) => j.id)]).get(J_EVE)!;
  const byJob = await propose(x, { action: "add_stop", loadNumber: 8, item: jobRef });
  assert(byJob.out.isError && /already on Load 7/.test(byJob.out.content), byJob.out.content);
  const dale = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const out9 = await propose(x, { action: "add_stop", loadNumber: 9, item: dale });
  assert(out9.out.isError && /already gone out/.test(out9.out.content), out9.out.content);
  const big = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Bea Big"));
  const tooWide = await propose(x, { action: "add_stop", loadNumber: 7, item: big });
  assert(tooWide.out.isError && /14' wide, too wide for Load 7's truck \(12' at most\)/.test(tooWide.out.content), tooWide.out.content);
  const ann = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Ann Jones"));
  const lee = await propose(x, { action: "add_stop", loadNumber: 10, item: ann });
  assert(lee.out.isError && /Lee isn't set up to run wide loads/.test(lee.out.content), lee.out.content);
  const none = await propose(x, { action: "add_stop", loadNumber: 99, item: dale });
  assert(none.out.isError && /no Load 99/.test(none.out.content), none.out.content);
  assertEquals(x.cards.size, 0);
  assertEquals(writes(x).length, 0);
});

Deno.test("add_stop: anything the card showed that moved is refused at Approve, and nothing is sent", async () => {
  for (const change of ["another stop", "the driver", "the building went on a load"] as const) {
    const x = setup();
    const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
    const { card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
    if (change === "another stop") x.w.route("add_stop", { loadId: L7, source: "order", buildJobId: J_ROB });
    if (change === "the driver") Object.assign(x.w.load(L7), { driver_id: D_LEE, driver_user_id: U_LEE, max_width_ft: 14 });
    if (change === "the building went on a load") x.w.route("add_stop", { loadId: L8, source: "order", buildJobId: J_DALE });
    const before = writes(x).length;
    const { row } = await approve(x, card!);
    assertEquals(row.status, "failed", change);
    assert(/since I showed you this/.test(row.failure ?? ""), `${change}: ${row.failure}`);
    assertEquals(writes(x).length, before, `${change}: nothing sent`);
  }
});

Deno.test("add_stop: a lost answer is never sent again; one that landed is found and keeps its Undo", async () => {
  const x = setup();
  x.w.mode.add_stop = "lost_landed";
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const { card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(x.w.of("add_stop").length, 1);
  assertEquals(await canUndo(x, card!), true);
  x.w.mode = {};
  assertEquals((await undo(x, card!)).row.status, "undone");
  assertEquals(x.w.stopsOn(L7).length, 3);

  const y = setup();
  y.w.mode.add_stop = "down";
  const r2 = await poolRef(y, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const c2 = (await propose(y, { action: "add_stop", loadNumber: 7, item: r2 })).card!;
  const row2 = (await approve(y, c2)).row;
  assertEquals(row2.status, "partly_applied");
  assertEquals(row2.result.reports[0].reason, DELIVERY_SAID.checkAgain);
  assertEquals(y.w.of("add_stop").length, 1, "never sent twice");
  assertEquals(await canUndo(y, c2), false);
});

Deno.test("add_stop: Undo leaves a stop someone changed, a load that went out, and a delivered stop", async () => {
  for (const change of ["edited", "out", "delivered"] as const) {
    const x = setup();
    const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
    const { card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
    await approve(x, card!);
    const added = x.w.stopsOn(L7)[3];
    if (change === "edited") added.updated_at = new Date(Date.now() + 60_000).toISOString();
    if (change === "out") x.w.load(L7).status = "out";
    // mark_stop_delivered doesn't check the load, so a stop on a load still planned can be delivered.
    // Only delivered_at moves here, so this is the delivered check and not the planned or edited one.
    if (change === "delivered") added.delivered_at = new Date().toISOString();
    const { row } = await undo(x, card!);
    assertEquals(row.status, "undone", change);
    assertEquals(row.result.undo.removed, 0, change);
    assert(row.result.undo.reports.length === 1, change);
    const why = { edited: /changed this stop since/, out: /has gone out since/, delivered: /delivered since/ }[change];
    assert(why.test(row.result.undo.reports[0].reason), `${change}: ${row.result.undo.reports[0].reason}`);
    assertEquals(x.w.of("remove_stop").length, 0, `${change}: nothing taken off`);
    assert(x.w.stop(added.id), `${change}: the stop stays`);
  }
});

Deno.test("add_stop: a permit set to Needed by hand drops to Not needed, and the card and Undo both say so", async () => {
  const x = setup();
  x.w.load(L8).permit_status = "needed";
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Dale Smith"));
  const { card } = await propose(x, { action: "add_stop", loadNumber: 8, item: ref });
  assert(card!.preview.notes.some((n: string) => /sets it to Not needed\. Undo won't set it back\./.test(n)), JSON.stringify(card!.preview.notes));
  await approve(x, card!);
  assertEquals(x.w.load(L8).permit_status, "not_needed");
  const { row } = await undo(x, card!);
  assertEquals(row.result.undo.removed, 1);
  assert(/permit stays at Not needed/.test(row.result.undo.reports[0].reason), JSON.stringify(row.result.undo));
});

Deno.test("add_stop: a wide building makes the load wide, and the card says the permit goes to Needed", async () => {
  const x = setup();
  const ref = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Ann Jones"));
  const { card } = await propose(x, { action: "add_stop", loadNumber: 7, item: ref });
  const permit = card!.preview.notes.find((n: string) => /a wide load, so its permit goes to Needed/.test(n)) ?? "";
  // mark_load_out never checks the permit, so the card says it's Jack who waits for it, not the board.
  assert(/I won't mark it out until the permit is on file\./.test(permit) && !/can't go out/.test(permit), permit);
  await approve(x, card!);
  assertEquals([x.w.load(L7).is_wide, x.w.load(L7).permit_status], [true, "needed"]);
  // ...and it's true: the route marks that wide load out with the permit still Needed.
  x.w.route("mark_load_out", { loadId: L7 });
  assertEquals(x.w.load(L7).status, "out");
});

Deno.test("add_stop: a lot building and a repair go on with their own source; a repair sets off no rule; an unbuilt building says so", async () => {
  const x = setup();
  const lot = await poolRef(x, (a) => a.lotBuildings[0]);
  const c1 = (await propose(x, { action: "add_stop", loadNumber: 8, item: lot })).card!;
  assert(c1.preview.notes[0].includes("Delivery heads-up"), "a sold lot building's stop raises delivery_scheduled");
  await approve(x, c1);
  const rep = await poolRef(x, (a) => a.repairs[0]);
  const rulesRead = x.w.of("crm_rules_list").length;
  const c2 = (await propose(x, { action: "add_stop", loadNumber: 8, item: rep })).card!;
  assert(!c2.preview.notes.some((n: string) => /rule/.test(n)), JSON.stringify(c2.preview.notes));
  assertEquals(x.w.of("crm_rules_list").length, rulesRead, "no rule read for a repair");
  cardClean(c2);
  await approve(x, c2);
  assertEquals(writes(x).map((c) => c.body), [
    { loadId: L8, source: "inventory", inventoryUnitId: UNIT1 },
    { loadId: L8, source: "repair", repairId: REP1 },
  ]);
  const ned = await poolRef(x, (a) => a.buildings.find((b: Any) => b.customer === "Ned New"));
  const c3 = (await propose(x, { action: "add_stop", loadNumber: 7, item: ned })).card!;
  assert(c3.preview.notes.some((n: string) => /isn't marked Built yet \(In Build\)\. Load 7 can't go out until it is\./.test(n)), JSON.stringify(c3.preview.notes));
  assert(c3.preview.notes.some((n: string) => /Its build date, .*, is after the load's day\./.test(n)), JSON.stringify(c3.preview.notes));
});

// ── reorder_stops ───────────────────────────────────────────────────────────────────────────────────

Deno.test("reorder_stops: every stop once, in the new order; Approve sends the whole list; Undo puts the old one back", async () => {
  const x = setup();
  const [a, b, e] = [stopRef(x, S_A), stopRef(x, S_B), stopRef(x, S_E)];
  const { card } = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [b, a, e] });
  assertEquals(card!.kind, DELIVERY_KINDS.reorder_stops);
  assertEquals(card!.title, "New stop order for Load 7");
  assertEquals(card!.preview.order.to.map((t: Any) => t.was), [2, 1, 3]);
  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["reorder_stops", { loadId: L7, stopIds: [S_B, S_A, S_E] }]]);
  assertEquals(x.w.stopsOn(L7).map((s) => s.id), [S_B, S_A, S_E]);
  const u = await undo(x, card!);
  assertEquals([u.row.status, u.row.result.undo.restored], ["undone", 1]);
  assertEquals(x.w.of("reorder_stops")[1].body, { loadId: L7, stopIds: [S_A, S_B, S_E] });
  assertEquals(x.w.stopsOn(L7).map((s) => s.id), [S_A, S_B, S_E]);
});

Deno.test("reorder_stops: refuses a short list, a stop twice, a stop from another load, and a load that's gone out", async () => {
  const x = setup();
  const [a, b, e, c] = [stopRef(x, S_A), stopRef(x, S_B), stopRef(x, S_E), stopRef(x, S_C)];
  const short = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [b, a] });
  assert(short.out.isError && /List every stop on Load 7 once/.test(short.out.content), short.out.content);
  // reorder_stops itself lets [b, b, e] through and leaves two stops numbered 2: Jack refuses it first.
  const twice = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [b, b, e] });
  assert(twice.out.isError && /once/.test(twice.out.content), twice.out.content);
  const other = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [b, a, c] });
  assert(other.out.isError && /is on Load 9, not Load 7/.test(other.out.content), other.out.content);
  const gone = await propose(x, { action: "reorder_stops", loadNumber: 9, stopOrder: [stopRef(x, S_D), c] });
  assert(gone.out.isError && /has gone out/.test(gone.out.content), gone.out.content);
  const sameOrder = await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [a, b, e] });
  assertEquals([sameOrder.out.isError, sameOrder.card], [undefined, null]);
  assertEquals(writes(x).length, 0);
});

Deno.test("reorder_stops: an order that moved is refused at Approve; Undo leaves an order someone changed since", async () => {
  const x = setup();
  const [a, b, e] = [stopRef(x, S_A), stopRef(x, S_B), stopRef(x, S_E)];
  const first = (await propose(x, { action: "reorder_stops", loadNumber: 7, stopOrder: [b, a, e] })).card!;
  x.w.route("reorder_stops", { loadId: L7, stopIds: [S_E, S_A, S_B] });
  const before = writes(x).length;
  const r1 = (await approve(x, first)).row;
  assertEquals(r1.status, "failed");
  assertEquals(writes(x).length, before);

  const y = setup();
  const card = (await propose(y, { action: "reorder_stops", loadNumber: 7, stopOrder: [stopRef(y, S_B), stopRef(y, S_A), stopRef(y, S_E)] })).card!;
  await approve(y, card);
  y.w.route("reorder_stops", { loadId: L7, stopIds: [S_E, S_B, S_A] });
  const u = (await undo(y, card)).row;
  assertEquals([u.status, u.result.undo.restored], ["undone", 0]);
  assert(/changed the order since/.test(u.result.undo.reports[0].reason), JSON.stringify(u.result.undo));
  assertEquals(y.w.of("reorder_stops").length, 1, "only the approve: Undo sent nothing");

  // reorder_stops has no status check, so Undo never sends it to a load that has gone out, even one
  // still in Jack's order.
  const z = setup();
  const c3 = (await propose(z, { action: "reorder_stops", loadNumber: 7, stopOrder: [stopRef(z, S_B), stopRef(z, S_A), stopRef(z, S_E)] })).card!;
  await approve(z, c3);
  z.w.load(L7).status = "out";
  const u3 = (await undo(z, c3)).row;
  assertEquals([u3.status, u3.result.undo.restored], ["undone", 0]);
  assert(/gone out since/.test(u3.result.undo.reports[0].reason), JSON.stringify(u3.result.undo));
  assertEquals(z.w.of("reorder_stops").length, 1, "only the approve");
  assertEquals(z.w.stopsOn(L7).map((s) => s.id), [S_B, S_A, S_E]);
});

// ── mark_load_out ───────────────────────────────────────────────────────────────────────────────────

Deno.test("mark_load_out: refused with no driver, an unbuilt building, no stops, a wide load whose driver isn't cleared, or no permit on file", async () => {
  const x = setup();
  x.w.stopFromJob(id(), L8, 1, J_ROB);
  const cases: [number, RegExp][] = [
    [8, /has no driver yet/],
    [13, /isn't marked Built yet \(stop 1\).*I don't use the override/],
    [14, /has no stops/],
    [10, /is a wide load, and Lee isn't cleared to run wide loads/],
    [12, /is a wide load, and its permit isn't on file yet/],
    [9, /is already out/],
  ];
  for (const [n, re] of cases) {
    const { out, card } = await propose(x, { action: "mark_load_out", loadNumber: n });
    assert(out.isError === true && !card && re.test(out.content), `Load ${n}: ${out.content}`);
  }
  // A truck changed since the stop went on is checked again here (add_stop checked only then).
  x.w.drivers.find((d) => d.id === D_SAM).max_width_ft = 7;
  const narrow = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  assert(narrow.out.isError && /wider than Sam's truck takes \(7'\)/.test(narrow.out.content), narrow.out.content);
  assertEquals(writes(x).length, 0);
});

Deno.test("mark_load_out: Approve sends just the load, never the override; it has no Undo, and the card says so", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  assertEquals([card!.kind, card!.title, card!.preview.undo], [DELIVERY_KINDS.mark_load_out, "Mark Load 7 out", DELIVERY_SAID.outUndo]);
  cardClean(card!);
  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["mark_load_out", { loadId: L7 }]]);
  assertEquals(x.w.load(L7).status, "out");
  assertEquals(await canUndo(x, card!), false);
  assertEquals(row.undo, null);
});

Deno.test("mark_load_out: a wide load with a cleared driver and its permit on file can go", async () => {
  const x = setup();
  Object.assign(x.w.load(L12), { permit_status: "on_file" });
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 12 });
  assert(card, "a card");
  assertEquals(card!.preview.lines[1], { label: "Wide load", from: "", to: "Driver cleared, permit on file" });
});

Deno.test("mark_load_out: a load someone marked out since is refused, and isn't stamped out again", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  x.w.route("mark_load_out", { loadId: L7 });
  const stamped = x.w.load(L7).departed_at;
  const before = writes(x).length;
  const { row } = await approve(x, card!);
  assertEquals(row.status, "failed");
  assertEquals(writes(x).length, before);
  assertEquals(x.w.load(L7).departed_at, stamped);
});

Deno.test("mark_load_out: a stop added since the card is refused at Approve; a profile not set up as a driver is refused", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  // Built, narrow, and the driver can take it: only the card's own list says it wasn't shown.
  x.w.route("add_stop", { loadId: L7, source: "order", buildJobId: J_DALE });
  const before = writes(x).length;
  const { row } = await approve(x, card!);
  assertEquals([row.status, row.failure], ["failed", DELIVERY_SAID.moved]);
  assertEquals(writes(x).length, before);
  assertEquals(x.w.load(L7).status, "planned");

  const y = setup();
  y.w.drivers.find((d) => d.id === D_SAM).is_driver = false;
  const { out, card: none } = await propose(y, { action: "mark_load_out", loadNumber: 7 });
  assert(out.isError === true && !none && /isn't set up as an active driver/.test(out.content), out.content);
});

Deno.test("mark_load_out: the route's own built check still has the last word, and the override is never sent", async () => {
  const x = setup();
  // A stop with only a design code: the board can't show its build, the route reads it by the code.
  x.w.designs.JOE010 = { short_code: "JOE010", status: "accepted", contact: contact("Joe Code", 20) };
  x.w.jobs.push({ id: id(), source: "order", serial: 1050, customer_name: "Joe Code", design_short_code: "JOE010", stage_id: STG_B, width_ft: 8, length_ft: 12, building_label: "Utility 8x12" });
  x.w.stops.push({ id: id(), load_id: L7, stop_order: 4, source: "order", build_job_id: null, inventory_unit_id: null, repair_id: null, design_short_code: "JOE010", serial: 1050, customer_name: "Joe Code", customer_phone: "816-555-0120", building_label: "Utility 8x12", width_ft: 8, length_ft: 12, dest_street: "1220 N Main St", dest_city: "Sedalia", dest_state: "MO", delivered_at: null, updated_at: new Date().toISOString() });
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  const { row } = await approve(x, card!);
  assertEquals(row.status, "failed");
  assertEquals(row.failure, "Some buildings on this load aren't marked Built: stop 4. Mark it built on the Build Schedule first. Nothing changed.");
  assertEquals(x.w.of("mark_load_out").map((c) => c.body), [{ loadId: L7 }]);
  assertEquals(x.w.load(L7).status, "planned");
});

Deno.test("mark_load_out: a lost answer is never sent again", async () => {
  const x = setup();
  x.w.mode.mark_load_out = "lost_landed";
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  assertEquals((await approve(x, card!)).row.status, "applied");
  const y = setup();
  y.w.mode.mark_load_out = "lost";
  const c2 = (await propose(y, { action: "mark_load_out", loadNumber: 7 })).card!;
  assertEquals((await approve(y, c2)).row.status, "partly_applied");
  assertEquals([x.w.of("mark_load_out").length, y.w.of("mark_load_out").length], [1, 1]);
});

// ── Delivered ───────────────────────────────────────────────────────────────────────────────────────

Deno.test("mark_stop_delivered: only on a load that's out; the rule and the estimate are on the card; the last stop says the load goes too", async () => {
  const x = setup();
  const planned = await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_A) });
  assert(planned.out.isError && /hasn't gone out yet/.test(planned.out.content), planned.out.content);
  const { out, card } = await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_C) });
  assert(!out.isError, out.content);
  assertEquals(card!.title, "Mark stop 1 on Load 9 delivered");
  assert(card!.preview.notes[0].includes('"Thank you"'), JSON.stringify(card!.preview.notes));
  assert(card!.preview.notes.includes("The customer's estimate moves to Delivered."), "the status write-back is said");
  assert(!card!.preview.notes.some((n: string) => /last stop/.test(n)), "not the last");
  assertEquals(card!.preview.undo, DELIVERY_SAID.deliveredUndo);
  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["mark_stop_delivered", { stopId: S_C }]]);
  assertEquals(x.w.designs.GUS007.status, "delivered");
  assertEquals(await canUndo(x, card!), false);

  const last = (await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_D) })).card!;
  assert(last.preview.notes.includes("It's the last stop on Load 9, so the load becomes delivered too."), JSON.stringify(last.preview.notes));
  await approve(x, last);
  assertEquals(x.w.load(L9).status, "delivered");
  const again = await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_D) });
  assert(again.out.isError && /already delivered/.test(again.out.content), again.out.content);
});

Deno.test("mark_stop_delivered: a card that said it wasn't the last stop is refused once it is, and nothing is sent", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_stop_delivered", item: stopRef(x, S_C) });
  x.w.route("mark_stop_delivered", { stopId: S_D });
  const before = writes(x).length;
  const { row } = await approve(x, card!);
  assertEquals(row.status, "failed", "the card said it wasn't the last stop, and now it is");
  assertEquals(writes(x).length, before);
});

Deno.test("mark_load_delivered: lists the stops and the rule, never an empty load; Approve sends just the load; no Undo", async () => {
  const x = setup();
  const empty = await propose(x, { action: "mark_load_delivered", loadNumber: 14 });
  assert(empty.out.isError && /has no stops/.test(empty.out.content), empty.out.content);
  const unbuilt = await propose(x, { action: "mark_load_delivered", loadNumber: 13 });
  assert(unbuilt.out.isError && /isn't marked Built yet/.test(unbuilt.out.content), unbuilt.out.content);
  // A repair visit rides along: delivered with the rest, but it has no estimate to move.
  x.w.stops.push({
    id: id(), client_id: "builder-a", load_id: L9, stop_order: 3, source: "repair", build_job_id: null, inventory_unit_id: null, repair_id: REP1, design_short_code: null,
    serial: 998, customer_name: "Pat Fixit", customer_phone: "816-555-0199", building_label: "Repair R-12", width_ft: null, length_ft: null, dest_street: "88 County Road 12",
    dest_city: "Warsaw", dest_state: "MO", dest_zip: "65355", site_notes: null, delivered_at: null, updated_at: new Date(Date.now() - DAY).toISOString(),
  });
  const { out, card } = await propose(x, { action: "mark_load_delivered", loadNumber: 9 });
  assert(!out.isError, out.content);
  assertEquals(json(out.content).estimatesMoving, 2);
  assertEquals(card!.preview.stops.map((s: Any) => s.n), [1, 2, 3]);
  assert(card!.preview.notes.includes("2 customers' estimates on it move to Delivered."), JSON.stringify(card!.preview.notes));
  assert(card!.preview.notes[0].includes('"Thank you"'), card!.preview.notes[0]);
  cardClean(card!);
  const { row } = await approve(x, card!);
  assertEquals(row.status, "applied");
  assertEquals(writes(x).map((c) => [c.action, c.body]), [["mark_load_delivered", { loadId: L9 }]]);
  assertEquals([x.w.load(L9).status, x.w.designs.GUS007.status, x.w.designs.HAL008.status], ["delivered", "delivered", "delivered"]);
  assertEquals(await canUndo(x, card!), false);
});

Deno.test("mark_load_delivered: a planned load goes straight to delivered and the card says so; a lost answer is never sent again", async () => {
  const x = setup();
  x.w.mode.mark_load_delivered = "lost_landed";
  const { card } = await propose(x, { action: "mark_load_delivered", loadNumber: 7 });
  assert(card!.preview.notes.includes("Load 7 was never marked out, so it goes straight to delivered."), JSON.stringify(card!.preview.notes));
  assertEquals((await approve(x, card!)).row.status, "applied");
  assertEquals(x.w.of("mark_load_delivered").length, 1);
});

Deno.test("mark_load_delivered: a stop added since the card is refused at Approve, so no estimate the card didn't list moves", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_delivered", loadNumber: 7 });
  x.w.route("add_stop", { loadId: L7, source: "order", buildJobId: J_DALE });
  const before = writes(x).length;
  const { row } = await approve(x, card!);
  assertEquals([row.status, row.failure], ["failed", DELIVERY_SAID.moved]);
  assertEquals(writes(x).length, before);
  assertEquals([x.w.load(L7).status, x.w.designs.DALE01.status, x.w.designs.EVE005.status], ["planned", "accepted", "accepted"]);
});

Deno.test("mark_stop_delivered: the route's live built check still has the last word", async () => {
  const x = setup();
  x.w.designs.JOE010 = { short_code: "JOE010", status: "accepted", contact: contact("Joe Code", 20) };
  x.w.jobs.push({ id: id(), source: "order", serial: 1050, customer_name: "Joe Code", design_short_code: "JOE010", stage_id: STG_B, width_ft: 8, length_ft: 12, building_label: "Utility 8x12" });
  const sid = id();
  x.w.stops.push({ id: sid, load_id: L9, stop_order: 3, source: "order", build_job_id: null, inventory_unit_id: null, repair_id: null, design_short_code: "JOE010", serial: 1050, customer_name: "Joe Code", customer_phone: "816-555-0120", building_label: "Utility 8x12", width_ft: 8, length_ft: 12, dest_street: "1220 N Main St", dest_city: "Sedalia", dest_state: "MO", delivered_at: null, updated_at: new Date().toISOString() });
  const { card } = await propose(x, { action: "mark_stop_delivered", item: stopRef(x, sid) });
  const { row } = await approve(x, card!);
  // The route answers "An owner or admin can override", but a stop has no override (only a whole load
  // does, from the admin box), so the card says what to do instead.
  assertEquals([row.status, row.failure], ["failed", "That building isn't marked Built yet. Mark it built on the Build Schedule first. Nothing changed."]);
  assert(!/override/i.test(row.failure ?? ""), row.failure ?? "");
  assertEquals(x.w.designs.JOE010.status, "accepted");
});

Deno.test("Approve sends only what the route's allow-list takes, even if a card's body held more", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  // Nothing in Jack writes these, and if a row ever held them they still wouldn't ride along.
  Object.assign(x.cards.get(card!.id)!.payload.body, { override: true, overrideReason: "built", alsoCompleteBuilds: true, tz: "America/Chicago" });
  await approve(x, card!);
  assertEquals(x.w.of("mark_load_out").map((c) => c.body), [{ loadId: L7 }]);
});

// ── Who may press ───────────────────────────────────────────────────────────────────────────────────

Deno.test("an operator in view-as may approve, and the record names them", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 }, OPERATOR);
  const { row } = await approve(x, card!, OPERATOR);
  assertEquals([row.status, row.approved_by, row.approved_by_operator], ["applied", "u-op", "ahsan@example.test"]);
});

Deno.test("Approve needs Delivery at edit and the records switch on; nothing is sent otherwise", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  x.w.access.delivery_schedule = "view";
  const { r } = await approve(x, card!);
  assertEquals([r.status, r.body.error], [403, SENTENCES.noAccess]);
  x.w.access.delivery_schedule = "edit";
  x.settings.off = ["records"];
  const off = await approve(x, card!);
  assertEquals([off.r.status, off.r.body.error], [403, SENTENCES.switchedOff]);
  assertEquals(writes(x).length, 0);
  assertEquals(x.cards.get(card!.id)!.status, "ready");
});

Deno.test("every delivery card: Approve refuses without Delivery edit, switched off, Jack off, expired, and for a load or stop gone since", async () => {
  const dropLoad = (lid: string) => (x: X) => { x.w.loads = x.w.loads.filter((l) => l.id !== lid); x.w.stops = x.w.stops.filter((s) => s.load_id !== lid); };
  const kinds: [string, Record<string, unknown>, ((x: X) => void) | null, string | null][] = [
    ["create_load", { action: "create_load", loadDate: day(20) }, null, null],
    ["add_stop", { action: "add_stop", loadNumber: 7, item: "#1041" }, dropLoad(L7), "Load 7 isn't on the Delivery Schedule any more, so nothing was added."],
    ["reorder_stops", { action: "reorder_stops", loadNumber: 7, stopOrder: ["2", "1", "3"] }, dropLoad(L7), "Load 7 isn't on the Delivery Schedule any more, so nothing changed."],
    ["mark_load_out", { action: "mark_load_out", loadNumber: 7 }, dropLoad(L7), "Load 7 isn't on the Delivery Schedule any more, so nothing changed."],
    ["mark_stop_delivered", { action: "mark_stop_delivered", loadNumber: 9, item: "stop 1" }, (x) => { x.w.stops = x.w.stops.filter((s) => s.id !== S_C); }, "That stop isn't on the Delivery Schedule any more, so nothing changed."],
    ["mark_load_delivered", { action: "mark_load_delivered", loadNumber: 9 }, dropLoad(L9), "Load 9 isn't on the Delivery Schedule any more, so nothing changed."],
  ];
  for (const [kind, input, gone, said] of kinds) {
    const refused: [string, (x: X, card: ProposalRow) => void, number, string][] = [
      ["no edit", (x) => { x.w.access.delivery_schedule = "view"; }, 403, SENTENCES.noAccess],
      ["switched off", (x) => { x.settings.off = ["records"]; }, 403, SENTENCES.switchedOff],
      ["Jack off", (x) => { x.settings.on = false; }, 403, SENTENCES.off],
      ["expired", (_x, card) => { card.expires_at = new Date(Date.now() - 1000).toISOString(); }, 409, SENTENCES.expired],
    ];
    for (const [what, arrange, status, error] of refused) {
      const x = setup();
      const { card } = await propose(x, input);
      assert(card, `${kind}: a card`);
      arrange(x, card!);
      const before = writes(x).length;
      const { r, row } = await approve(x, card!);
      assertEquals([kind, what, r.status, r.body.error], [kind, what, status, error]);
      assertEquals([kind, what, writes(x).length], [kind, what, before]);
      assertEquals([kind, what, row.status], [kind, what, what === "expired" ? "expired" : "ready"]);
    }
    if (!gone) continue;
    const x = setup();
    const { card } = await propose(x, input);
    gone(x);
    const { row } = await approve(x, card!);
    assertEquals([kind, row.status, row.failure], [kind, "failed", said]);
    assertEquals([kind, writes(x).length], [kind, 0]);
    assertEquals([kind, row.undo], [kind, null]);
  }
});

Deno.test("a stale hash isn't approved", async () => {
  const x = setup();
  const { card } = await propose(x, { action: "mark_load_out", loadNumber: 7 });
  const r = await handleProposalApprove(x.deps, OWNER, { id: card!.id, hash: "not-it" });
  assertEquals(r.status, 409);
  assertEquals(writes(x).length, 0);
});

Deno.test("the propose tool says why without Delivery edit even if it were reached directly", async () => {
  const x = setup({ access: { delivery_schedule: "view" } });
  const spec = deliveryPiece.tools.find((t) => t.def.name === "propose_delivery_change")!;
  const out = await spec.run(x.deps, x.turn(), { action: "create_load", loadNumber: 0, loadDate: day(5), item: "", stopOrder: [] });
  assertEquals([out.isError, out.content], [true, SAID.noAccess]);
});

Deno.test("every card kind is the delivery piece's, and each names the delivery area and the records switch", () => {
  const kinds = deliveryPiece.kinds.map((k) => k.kind).sort();
  assertEquals(kinds, Object.values(DELIVERY_KINDS).sort());
  for (const k of deliveryPiece.kinds) {
    assert(k.kind.startsWith("delivery_"), k.kind);
    const p = { payload: {} } as unknown as ProposalRow;
    assertEquals([k.areas(p), k.switches(p), !!k.private], [["delivery_schedule"], ["records"], false]);
  }
  assertEquals(deliveryPiece.kinds.filter((k) => k.undo).map((k) => k.kind).sort(), [DELIVERY_KINDS.add_stop, DELIVERY_KINDS.reorder_stops].sort());
});
