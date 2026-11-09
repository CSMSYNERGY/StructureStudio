// jack-agent: the delivery schedule, its loads and stops (delivery_test.ts). Plan section 5.9, and
// Ahsan's cautious defaults of 11-06 (item 3 and "Delivery Undo").
//
// Jack reads the delivery board and what's waiting to be loaded, and puts ONE change on a card: a new
// load on a day, a building, lot building or repair added to a load, a load's stops in a new order, a
// load marked out, or a stop or a whole load marked delivered.
//
// THE RULES
//   - A tool reads, or writes ONE card. Only a person's Approve sends anything, through portal-schedule
//     with that person's own token (deps.call), so the board's own gates and refusals still apply. The
//     body is cut to an allow-list per action, so the built-before-delivered override (override,
//     overrideReason, alsoCompleteBuilds, tz) can never ride along.
//   - Not in this version (Ahsan, 11-06): moving a building from one load to another, assigning or
//     changing a driver, editing a load or a stop (update_load, update_stop), deleting a load, and the
//     override. A building already on a load is refused, with where it is.
//   - No delivery route takes a version, so Approve reads the board again first and refuses, sending
//     nothing, when anything the card showed has moved (setup.ts's pattern).
//   - create_load, add_stop and the marks aren't safe to send twice. A lost answer (status 0 or 5xx) is
//     never sent again: Jack reads the board and decides, or says to check the Delivery Schedule.
//   - Stricter than the buttons: a load goes out only with a driver, every building built and nothing
//     wider than the truck, and a wide load only with a driver cleared for wide loads and its permit on
//     file (mark_load_out itself checks none of that). A stop is marked delivered only on a load that is
//     out, as the button allows (the route doesn't check). An empty load is never marked out or
//     delivered: a delivered load can't be deleted, so an empty one would stay for good.
//   - Undo: a stop Jack added comes off again (remove_stop) only while it's on the same load, that load
//     is still planned, it isn't delivered and nobody changed it since (its updated_at). A reorder goes
//     back only while the order is still Jack's. A new load has no Undo (Jack deletes nothing); the card
//     says a person can delete an empty load. Out and delivered have no way back for anyone, and the
//     cards say so before Approve.
//   - Rule events (ruleWarn.ts): adding a stop fires delivery_scheduled (never for a repair, nor a haul
//     with no customer behind it); marking delivered fires delivered and starts the days-after-delivery
//     clocks. The card and the tool answer both carry the sentence.
//   - Claude gets names and towns, never a phone number, an email or a street line: the board's answer
//     carries them for every stop (and add_stop's answer too), so only listed fields are copied out at
//     the source. Not even the card keeps them.
//   - propose_delivery_change is a change tool (proposesChange, the cautious side of the 11-09 audit):
//     marking delivered moves customers' estimates to Delivered and sets off rules that text or email
//     them, and none of it can be undone. So once a customer's words are in the turn (both reads carry
//     names) it isn't offered, like a change order. It reads the board itself and takes a load number,
//     a stop's number on its load or a serial as well as a ref, so the person's next message makes the
//     card without a look. Its own answers carry no customer names.
//   - Strict budget: one strict tool (propose_delivery_change, an action enum, every field required,
//     sentinels, no unions). The two reads start with look_ and find_, so agent.ts sends them unstrict.

import type { ApplyOutcome, Deps, KindSpec, Piece, PortalFn, ProposalRow, ToolOut, ToolSpec, TurnState, UndoOutcome } from "./types.ts";
import { err, ok, putCard, SAID, saidBy } from "./common.ts";
import { safeName, scrub } from "./redact.ts";
import { ruleWarning } from "./ruleWarn.ts";
import { LIFECYCLE_RANK, type Lifecycle } from "../_shared/inventoryLifecycle.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Res = { status: number; data: Record<string, unknown> | null };
type Report = { label: string; status: string; reason: string };

export const DELIVERY_SWITCH = "records";
export const WHERE = "the Delivery Schedule";
const AREA = "delivery_schedule";
const ROUTE = { page: "delivery-schedule", sub: null };
// Widened through string: types.ts's PortalFn names portal-schedule once integration adds it there.
const SCHEDULE_FN = "portal-schedule" as string as PortalFn;
/** Over 8'6" is a wide load on the highway (portal-schedule WIDE_FT). */
const WIDE_FT = 8.5;

export const DELIVERY_KINDS = {
  create_load: "delivery_load_create",
  add_stop: "delivery_stop_add",
  reorder_stops: "delivery_stop_reorder",
  mark_load_out: "delivery_load_out",
  mark_stop_delivered: "delivery_stop_delivered",
  mark_load_delivered: "delivery_load_delivered",
} as const;
type Action = keyof typeof DELIVERY_KINDS;
const ACTIONS = Object.keys(DELIVERY_KINDS) as Action[];

/** What each route may be sent. Anything else on a card's body is dropped. */
const ALLOWED: Record<Action, string[]> = {
  create_load: ["loadDate"],
  add_stop: ["loadId", "source", "buildJobId", "inventoryUnitId", "repairId"],
  reorder_stops: ["loadId", "stopIds"],
  mark_load_out: ["loadId"],
  mark_stop_delivered: ["stopId"],
  mark_load_delivered: ["loadId"],
};
const allowed = (action: Action, body: unknown): Record<string, unknown> => {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(ALLOWED[action].filter((k) => k in b).map((k) => [k, b[k]]));
};

export const DELIVERY_SAID = {
  checkAgain: `I couldn't tell if that went through. Check ${WHERE} before trying again.`,
  readAtApprove: `I couldn't check ${WHERE} just now, so nothing changed. Ask me again in a moment.`,
  moved: "That changed since I showed you this, so nothing changed. Ask me again and I'll start from what's there now.",
  tryUndo: "That didn't go through. Press Undo to try again.",
  noMove: `I don't move a building from one load to another. A person can take it off that load on ${WHERE} first, and then I can add it.`,
  noRef: "I can't find that one. Use its serial, its stop number with the load's number, or its ref from look_at_delivery_loads or find_to_be_loaded.",
  // For a stop already on a load (mark_stop_delivered): waiting refs aren't on a load, so it doesn't offer them.
  noStop: "I can't find that stop. Use its serial, its stop number with the load's number, or its ref from look_at_delivery_loads.",
  serialOnTwo: "More than one stop has that serial. Say which load it's on and its stop number.",
  createUndo: `Undo can't remove a load. If it isn't needed, a person can delete it on ${WHERE} while it has no stops.`,
  addUndo: "Undo takes the stop off again while nobody has changed it. It can't unsend a message a rule already sent.",
  reorderUndo: "Undo puts the old order back while nobody has changed it since.",
  outUndo: "Undo can't set a load back to planned. Nobody can, from here or by hand.",
  deliveredUndo: "Undo can't take a delivery back. Nobody can, from here or by hand.",
  /** For Claude, in each read's answer: the card can't go up after customer words in the same turn. */
  cardNextMessage: "Customer names are in this answer, so a delivery card can't go up in this same answer. Say what you'd put on the screen, by load number, stop number and serial, and make the card with propose_delivery_change when they reply. Don't look again first: propose_delivery_change reads the board itself.",
  stopNeedsLoad: "Say which load the stop is on, by its number, as well as the stop's number.",
  noStopNo: (load: number, n: number) => `Load ${load} has no stop ${n}.`,
  serialTwice: (shown: string) => `More than one thing waiting to be loaded has ${shown}. Ask which one they mean, by its building or its lot.`,
};

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOr = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v ?? null;
};
/** Key order doesn't count: a card's payload comes back from jsonb. */
export const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const landed = (r: Res) => r.status === 200 && !!r.data && r.data.ok !== false && !r.data.error;
/** A lost answer may mean it landed, so it's never reported as "didn't go through". */
const lost = (r: Res) => r.status === 0 || r.status >= 500 || (r.status === 200 && !r.data);
/** The route's sentences use a dash as a pause and an arrow for a menu. */
const plainWords = (s: string) => s.replace(/\s*—\s*/g, ": ").replace(/\s*→\s*/g, " > ").replace(/\s+/g, " ").trim();
const said = (r: Res, fallback: string) => plainWords(saidBy(r, fallback));
const readError = (r: Res) => (r.status >= 400 && r.status < 500 ? said(r, SAID.readFailed) : SAID.readFailed);
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const feet = (n: number) => `${Number(n.toFixed(2))}'`;

/** A serial for Claude: a long one gets commas, so it never reads as a phone number (redact.ts). */
const serialForClaude = (n: number | null) => (n === null ? null : "#" + (Math.abs(n) >= 1_000_000 ? n.toLocaleString("en-US") : String(n)));
const serialShown = (n: number | null) => (n === null ? null : "#" + String(n));

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export function validDay(s: string): boolean {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "Fri, Nov 14", read as a calendar day (never shifted by a time zone). */
export function dayLabel(iso: string | null): string {
  if (!iso || !validDay(iso)) return "no day set";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// ── Refs: a short code per row, stable across turns, never the uuid ─────────────────────────────────

// Hex spelled in letters, so a ref is never a run of digits (redact.ts would read seven as a phone).
const LETTERS = "bcdfghjkmnpqrstv";
const spell = (id: string) => id.replace(/[^0-9a-f]/gi, "").toLowerCase().split("").map((c) => LETTERS[parseInt(c, 16)]).join("");
export const PREFIX = { stop: "stop-", build: "build-", lot: "lot-", repair: "repair-" } as const;

/** Each id's ref: the prefix and the shortest spelling of the id (5 letters or more) no other id shares.
 *  Sorted, the longest start an id shares with any other is with a neighbour, so this is one sort and
 *  not every id against every other: the board's stops are its whole history, thousands of them. */
export function refsFor(prefix: string, ids: string[]): Map<string, string> {
  const spelled = ids.map(spell);
  const order = spelled.map((_, i) => i).sort((a, b) => (spelled[a] < spelled[b] ? -1 : spelled[a] > spelled[b] ? 1 : 0));
  const shared = (a: string, b: string) => {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  };
  const out = new Map<string, string>();
  order.forEach((i, at) => {
    const s = spelled[i];
    const near = Math.max(at > 0 ? shared(s, spelled[order[at - 1]]) : 0, at < order.length - 1 ? shared(s, spelled[order[at + 1]]) : 0);
    out.set(ids[i], prefix + s.slice(0, Math.min(s.length, Math.max(5, near + 1))));
  });
  return out;
}
/** The rows a ref could name. One means found; none or two means ask again. */
function byRef<T>(items: T[], idOf: (t: T) => string | null, prefix: string, ref: string): T[] {
  const r = ref.trim().toLowerCase();
  if (!r.startsWith(prefix)) return [];
  const want = r.slice(prefix.length);
  if (want.length < 5 || !/^[bcdfghjkmnpqrstv]+$/.test(want)) return [];
  return items.filter((t) => { const id = idOf(t); return !!id && spell(id).startsWith(want); });
}

// ── The board (portal-schedule `loads`) ─────────────────────────────────────────────────────────────

export interface Load {
  id: string; no: number; status: string; date: string | null; driverId: string | null; driverUserId: string | null;
  deck: number | null; maxWidth: number | null; isWide: boolean; permit: string; route: string | null; createdAt: string | null;
  completedAt: string | null;
}
export interface Stop {
  id: string; loadId: string; order: number; source: string; jobId: string | null; unitId: string | null; repairId: string | null;
  code: string | null; serial: number | null; customer: string | null; building: string | null; width: number | null; length: number | null;
  city: string | null; state: string | null; deliveredAt: string | null; updatedAt: string | null;
}
export interface Driver { id: string; userId: string | null; name: string | null; isDriver: boolean; wide: boolean | null; maxWidth: number | null; deck: number | null }
export interface Board {
  loads: Load[]; stops: Stop[]; drivers: Driver[]; team: { userId: string; name: string | null }[];
  buildByJob: Record<string, { stage: string | null; kind: string | null; dueDate: string | null }>;
  unitLifecycle: Record<string, string>;
}

// Only these fields are ever copied out of the board. Phones and street lines stay behind (redact.ts).
const loadOf = (x: Any): Load => ({
  id: String(x.id), no: Number(x.load_no) || 0, status: String(x.status ?? "planned"),
  date: txt(x.load_date) ? String(x.load_date).slice(0, 10) : null,
  driverId: txt(x.driver_id), driverUserId: txt(x.driver_user_id), deck: numOr(x.deck_length_ft), maxWidth: numOr(x.max_width_ft),
  isWide: x.is_wide === true, permit: String(x.permit_status ?? "not_needed"), route: txt(x.route_label), createdAt: txt(x.created_at),
  completedAt: txt(x.completed_at),
});
const stopOf = (x: Any): Stop => ({
  id: String(x.id), loadId: String(x.load_id), order: Number(x.stop_order) || 0, source: String(x.source ?? ""),
  jobId: txt(x.build_job_id), unitId: txt(x.inventory_unit_id), repairId: txt(x.repair_id), code: txt(x.design_short_code),
  serial: numOr(x.serial), customer: txt(x.customer_name), building: txt(x.building_label), width: numOr(x.width_ft), length: numOr(x.length_ft),
  city: txt(x.dest_city), state: txt(x.dest_state), deliveredAt: txt(x.delivered_at), updatedAt: txt(x.updated_at),
});
const driverOf = (x: Any): Driver => ({
  id: String(x.id), userId: txt(x.user_id), name: txt(x.display_name), isDriver: x.is_driver === true,
  wide: typeof x.wide_load_capable === "boolean" ? x.wide_load_capable : null, maxWidth: numOr(x.max_width_ft), deck: numOr(x.deck_length_ft),
});

export async function readBoard(deps: Deps): Promise<{ board: Board } | { error: string }> {
  const r = await deps.call(SCHEDULE_FN, "loads", {});
  const d = r.data as Any;
  if (r.status !== 200 || !d || !Array.isArray(d.loads) || !Array.isArray(d.stops)) return { error: readError(r) };
  const buildByJob: Board["buildByJob"] = {};
  for (const [k, v] of Object.entries((d.buildByJob ?? {}) as Record<string, Any>)) buildByJob[k] = { stage: txt(v?.stage), kind: txt(v?.kind), dueDate: txt(v?.dueDate) };
  const unitLifecycle: Record<string, string> = {};
  for (const [k, v] of Object.entries((d.unitLifecycle ?? {}) as Record<string, Any>)) if (typeof v?.lifecycle === "string") unitLifecycle[k] = v.lifecycle;
  return {
    board: {
      loads: d.loads.filter((x: Any) => x && x.id).map(loadOf),
      stops: d.stops.filter((x: Any) => x && x.id && x.load_id).map(stopOf),
      drivers: (Array.isArray(d.drivers) ? d.drivers : []).filter((x: Any) => x && x.id).map(driverOf),
      team: (Array.isArray(d.team) ? d.team : []).filter((x: Any) => x && x.userId).map((x: Any) => ({ userId: String(x.userId), name: txt(x.name) })),
      buildByJob, unitLifecycle,
    },
  };
}

const stopsOn = (b: Board, loadId: string) => b.stops.filter((s) => s.loadId === loadId).sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));
const driverFor = (b: Board, l: Load): Driver | null =>
  (l.driverId ? b.drivers.find((d) => d.id === l.driverId) : null) ?? (l.driverUserId ? b.drivers.find((d) => d.userId === l.driverUserId) : null) ?? null;
const hasDriver = (l: Load) => !!(l.driverId || l.driverUserId);
function driverName(b: Board, l: Load): string | null {
  if (!hasDriver(l)) return null;
  const d = driverFor(b, l);
  const name = d?.name ?? (d?.userId ? b.team.find((m) => m.userId === d.userId)?.name : null) ?? (l.driverUserId ? b.team.find((m) => m.userId === l.driverUserId)?.name : null);
  return name ?? "a driver with no name set";
}
const isWideStop = (s: { width: number | null }) => s.width !== null && s.width > WIDE_FT;
const wideLoad = (b: Board, l: Load) => l.isWide || stopsOn(b, l.id).some(isWideStop);
const lowestMax = (...xs: (number | null)[]) => {
  const ok = xs.filter((x): x is number => x !== null && x > 0);
  return ok.length ? Math.min(...ok) : null;
};
const RANK = LIFECYCLE_RANK as Record<string, number>;
/** The route's own built check (unbuiltStops), as far as the board shows it. A stop with only a design
 *  code is left to the route, which reads that building's jobs itself. */
export function unbuilt(b: Board, s: Stop): boolean {
  if (s.jobId) return b.buildByJob[s.jobId]?.kind !== "done";
  if (s.unitId) {
    const lc = b.unitLifecycle[s.unitId];
    return !!lc && lc in RANK && RANK[lc] < RANK["built" satisfies Lifecycle];
  }
  return false;
}
/** A stop whose delivery moves a customer's estimate (writeBackDelivered): an order, or a sold lot
 *  building's sale stop, carrying a design code. */
const movesEstimate = (s: Stop) => !!s.code && (s.source === "order" || s.source === "inventory");
const town = (s: { city: string | null; state: string | null }) => [s.city, s.state].filter(Boolean).join(", ") || null;
const size = (w: number | null, l: number | null) => (w !== null && l !== null ? `${Number(w)}x${Number(l)}` : null);
const PERMIT_WORDS: Record<string, string> = { not_needed: "Not needed", needed: "Needed", on_file: "On file" };
const STATUS_WORDS: Record<string, string> = { planned: "Planned", out: "Out", delivered: "Delivered" };

/** A stop as the person sees it on a card: they see the whole board anyway. */
function stopShown(s: Stop): string {
  return [serialShown(s.serial), s.customer ?? (s.repairId ? "Repair visit" : null), s.building, size(s.width, s.length), town(s)].filter(Boolean).join(" · ") || "A stop";
}
/** A stop as an activity line names it: no customer. */
const stopLabel = (s: Stop) => [serialShown(s.serial), s.building].filter(Boolean).join(" ") || `Stop ${s.order}`;

// ── What's waiting to be loaded (portal-schedule `pool`) ────────────────────────────────────────────

export interface PoolJob {
  id: string; source: string; serial: number | null; customer: string | null; label: string | null; width: number | null; length: number | null;
  code: string | null; unitId: string | null; stage: string | null; kind: string | null; ready: string | null; city: string | null; state: string | null;
}
export interface PoolUnit { id: string; serial: number | null; buyer: string | null; label: string | null; lot: string | null }
export interface PoolRepair { id: string; no: number | null; customer: string | null; about: string | null; serial: number | null; status: string | null }
export interface Pool { jobs: PoolJob[]; units: PoolUnit[]; repairs: PoolRepair[]; unitLifecycle: Record<string, string> }
type PoolItem = { kind: "build"; job: PoolJob } | { kind: "lot"; unit: PoolUnit } | { kind: "repair"; repair: PoolRepair };

export async function readPool(deps: Deps): Promise<{ pool: Pool } | { error: string }> {
  const r = await deps.call(SCHEDULE_FN, "pool", {});
  const d = r.data as Any;
  if (r.status !== 200 || !d || !Array.isArray(d.jobs) || !Array.isArray(d.inventory) || !Array.isArray(d.repairs)) return { error: readError(r) };
  const unitLifecycle: Record<string, string> = {};
  for (const [k, v] of Object.entries((d.unitLifecycle ?? {}) as Record<string, Any>)) if (typeof v?.lifecycle === "string") unitLifecycle[k] = v.lifecycle;
  return {
    pool: {
      jobs: d.jobs.filter((j: Any) => j && j.buildJobId).map((j: Any): PoolJob => ({
        id: String(j.buildJobId), source: String(j.source ?? ""), serial: numOr(j.serial), customer: txt(j.customerName),
        label: txt(j.buildingLabel) ?? txt(j.title), width: numOr(j.widthFt), length: numOr(j.lengthFt), code: txt(j.designShortCode),
        unitId: txt(j.inventoryUnitId), stage: txt(j.buildStage), kind: txt(j.buildKind), ready: txt(j.readyDate) ? String(j.readyDate).slice(0, 10) : null,
        city: txt(j.destCity), state: txt(j.destState),
      })),
      units: d.inventory.filter((u: Any) => u && u.inventoryUnitId).map((u: Any): PoolUnit => ({
        id: String(u.inventoryUnitId), serial: numOr(u.serial), buyer: txt(u.soldFirstName), label: txt(u.buildingLabel), lot: txt(u.location?.name),
      })),
      repairs: d.repairs.filter((x: Any) => x && x.id).map((x: Any): PoolRepair => ({
        id: String(x.id), no: numOr(x.repair_no), customer: txt(x.customer_name), about: txt(x.description), serial: numOr(x.serial), status: txt(x.status),
      })),
      unitLifecycle,
    },
  };
}

/** "10x16" out of "Garden Shed 10x16", the way add_stop reads a lot building's size. */
function sizeIn(label: string | null): { width: number | null; length: number | null } {
  const m = String(label ?? "").match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  return m ? { width: Number(m[1]), length: Number(m[2]) } : { width: null, length: null };
}
const itemId = (it: PoolItem) => (it.kind === "build" ? it.job.id : it.kind === "lot" ? it.unit.id : it.repair.id);
const itemWidth = (it: PoolItem) => (it.kind === "build" ? it.job.width : it.kind === "lot" ? sizeIn(it.unit.label).width : null);
const unitBuilt = (pool: Pool, unitId: string) => {
  const lc = pool.unitLifecycle[unitId];
  return !lc || !(lc in RANK) || RANK[lc] >= RANK["built" satisfies Lifecycle];
};
const itemBuilt = (pool: Pool, it: PoolItem) => (it.kind === "build" ? it.job.kind === "done" : it.kind === "lot" ? unitBuilt(pool, it.unit.id) : true);
/** Whether its stop raises delivery_scheduled (367): it carries a customer's design code, or is a sold lot
 *  building (its stop takes the buyer's code). A repair never does, nor a haul with no customer. */
const firesScheduled = (pool: Pool, it: PoolItem) =>
  it.kind === "lot" || (it.kind === "build" && (!!it.job.code || (!!it.job.unitId && pool.units.some((u) => u.id === it.job.unitId))));
/** The body add_stop takes for it: the pool row's own source (a wrong one skips the delivered write-back). */
function addBody(loadId: string, it: PoolItem): Record<string, unknown> {
  if (it.kind === "build") return { loadId, source: it.job.source, buildJobId: it.job.id };
  if (it.kind === "lot") return { loadId, source: "inventory", inventoryUnitId: it.unit.id };
  return { loadId, source: "repair", repairId: it.repair.id };
}
function itemShown(it: PoolItem): string {
  if (it.kind === "build") return [serialShown(it.job.serial), it.job.customer, it.job.label, size(it.job.width, it.job.length), town(it.job)].filter(Boolean).join(" · ") || "A building";
  if (it.kind === "lot") return [serialShown(it.unit.serial), it.unit.buyer ? `sold to ${it.unit.buyer}` : null, it.unit.label, it.unit.lot ? `from ${it.unit.lot}` : null].filter(Boolean).join(" · ") || "A lot building";
  return [it.repair.no !== null ? `Repair R-${it.repair.no}` : "A repair", it.repair.customer, serialShown(it.repair.serial)].filter(Boolean).join(" · ");
}
/** Its name in an activity line: no customer. */
function itemLabel(it: PoolItem): string {
  if (it.kind === "build") return [serialShown(it.job.serial), it.job.label].filter(Boolean).join(" ") || "A building";
  if (it.kind === "lot") return [serialShown(it.unit.serial), it.unit.label].filter(Boolean).join(" ") || "A lot building";
  return it.repair.no !== null ? `Repair R-${it.repair.no}` : "A repair";
}
/** What the card showed of it, for Approve's "has it moved?". */
function itemFacts(pool: Pool, it: PoolItem): Record<string, unknown> {
  if (it.kind === "build") return { item: "build", ...it.job, built: itemBuilt(pool, it) };
  if (it.kind === "lot") return { item: "lot", ...it.unit, built: itemBuilt(pool, it) };
  return { item: "repair", id: it.repair.id, no: it.repair.no, customer: it.repair.customer, serial: it.repair.serial };
}
/** A serial as a person or Claude writes it: "#1042", "1042", or a long one with commas, "#2,026,001". */
const SERIAL_WORD = /^#?\s*(\d{1,3}(?:,\d{3})+|\d+)$/;
/** A repair by its number: "R-12". */
const REPAIR_WORD = /^r-?\s*(\d+)$/i;
/** A stop by its number on its load: "stop 2", or just "2". */
const STOP_WORD = /^(?:stop\s*#?\s*)?(\d{1,3})$/i;
export function serialIn(word: string): number | null {
  const m = SERIAL_WORD.exec(word.trim());
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** What waiting to be loaded a word names: a ref, a repair's number, or a serial. A serial can name a
 *  lot building's job and the lot building both, and then it names two: the caller asks which. */
function findItem(pool: Pool, ref: string): PoolItem[] {
  const r = ref.trim().toLowerCase();
  if (r.startsWith(PREFIX.build)) return byRef(pool.jobs, (j) => j.id, PREFIX.build, r).map((job) => ({ kind: "build" as const, job }));
  if (r.startsWith(PREFIX.lot)) return byRef(pool.units, (u) => u.id, PREFIX.lot, r).map((unit) => ({ kind: "lot" as const, unit }));
  if (r.startsWith(PREFIX.repair)) return byRef(pool.repairs, (x) => x.id, PREFIX.repair, r).map((repair) => ({ kind: "repair" as const, repair }));
  const rep = REPAIR_WORD.exec(r);
  if (rep) return pool.repairs.filter((x) => x.no === Number(rep[1])).map((repair) => ({ kind: "repair" as const, repair }));
  const serial = serialIn(r);
  if (serial === null) return [];
  // A repair's serial is the building's being repaired, so a serial never names a repair: R-12 does.
  return [
    ...pool.jobs.filter((j) => j.serial === serial).map((job) => ({ kind: "build" as const, job })),
    ...pool.units.filter((u) => u.serial === serial).map((unit) => ({ kind: "lot" as const, unit })),
  ];
}
/** The stop a ref names when it isn't waiting: a stop's own ref, or a building's, lot building's or
 *  repair's that is already on a load, or a serial already on one. An open stop first. */
function stopForRef(b: Board, ref: string): Stop | null {
  const r = ref.trim().toLowerCase();
  const serial = serialIn(r);
  const hits = r.startsWith(PREFIX.stop) ? byRef(b.stops, (s) => s.id, PREFIX.stop, r)
    : r.startsWith(PREFIX.build) ? byRef(b.stops, (s) => s.jobId, PREFIX.build, r)
    : r.startsWith(PREFIX.lot) ? byRef(b.stops, (s) => s.unitId, PREFIX.lot, r)
    : r.startsWith(PREFIX.repair) ? byRef(b.stops, (s) => s.repairId, PREFIX.repair, r)
    : serial !== null ? b.stops.filter((s) => s.serial === serial) : [];
  return hits.find((s) => !s.deliveredAt) ?? hits[0] ?? null;
}
/** The one stop a word names: its ref, its number on a load ("stop 2" with the load's number), or its
 *  serial ("#1042", 11-09). Two stops can share a number (reorder_stops lets that through), and then it
 *  names none. A serial names its open stop first, on the load they said if they said one; two open stops
 *  with it name none. */
function stopNamed(b: Board, loadNumber: number, word: string): { stop: Stop } | { error: string } {
  const m = STOP_WORD.exec(word.trim());
  if (m) {
    if (!(loadNumber > 0)) return { error: DELIVERY_SAID.stopNeedsLoad };
    const l = b.loads.find((x) => x.no === loadNumber);
    if (!l) return { error: `There's no Load ${loadNumber}.` };
    const hits = stopsOn(b, l.id).filter((x) => x.order === Number(m[1]));
    return hits.length === 1 ? { stop: hits[0] } : { error: DELIVERY_SAID.noStopNo(l.no, Number(m[1])) };
  }
  const serial = serialIn(word);
  if (serial !== null) {
    let hits = b.stops.filter((x) => x.serial === serial);
    const onLoad = loadNumber > 0 ? hits.filter((x) => b.loads.find((l) => l.id === x.loadId)?.no === loadNumber) : [];
    if (onLoad.length) hits = onLoad;
    const open = hits.filter((x) => !x.deliveredAt);
    const pick = open.length ? open : hits;
    if (pick.length === 1) return { stop: pick[0] };
    if (pick.length > 1) return { error: DELIVERY_SAID.serialOnTwo };
    return { error: DELIVERY_SAID.noStop };
  }
  const hits = byRef(b.stops, (x) => x.id, PREFIX.stop, word);
  return hits.length === 1 ? { stop: hits[0] } : { error: DELIVERY_SAID.noStop };
}

// ── The reads Claude gets ───────────────────────────────────────────────────────────────────────────

const SOURCE_WORDS = (s: Stop) =>
  s.repairId && s.source === "repair" ? "repair visit" : s.source === "order" ? "sold building" : s.source === "inventory" ? (s.code ? "lot building, sold" : "haul to the lot") : "other";

function stopForClaude(b: Board, s: Stop, ref: string) {
  return {
    ref, stop: s.order, serial: serialForClaude(s.serial), customer: safeName(s.customer), building: s.building ? scrub(s.building, 80) : null,
    size: size(s.width, s.length), wide: isWideStop(s), town: town(s) ? scrub(town(s), 80) : null, kind: SOURCE_WORDS(s),
    built: s.repairId && !s.jobId ? null : !unbuilt(b, s), delivered: !!s.deliveredAt,
  };
}

function loadForClaude(b: Board, l: Load, refs: Map<string, string>) {
  const d = driverFor(b, l);
  const name = driverName(b, l);
  const stops = stopsOn(b, l.id);
  return {
    load: l.no, status: STATUS_WORDS[l.status] ?? l.status, day: l.date, dayName: l.date ? dayLabel(l.date) : null,
    driver: name ? scrub(name, 60) : null,
    ...(hasDriver(l) ? { driverClearedForWide: d ? d.wide === true : null, truckMaxWidthFt: lowestMax(l.maxWidth, d?.maxWidth ?? null) } : {}),
    route: l.route ? scrub(l.route, 80) : null,
    wide: wideLoad(b, l), permit: PERMIT_WORDS[l.permit] ?? l.permit,
    stops: stops.map((s) => stopForClaude(b, s, refs.get(s.id)!)),
  };
}

const loadsTool: ToolSpec = {
  def: {
    name: "look_at_delivery_loads",
    description: "Read the delivery board (the Delivery Schedule): each load's number, status, day, driver, whether it's a wide load and its permit, and its stops in order, each with a ref, serial, customer, building, size, town and whether it's built or delivered. Planned and out loads, and with includeDelivered, loads delivered in the last 14 days. Use it before proposing a delivery change. Stop refs go into propose_delivery_change.",
    input_schema: { type: "object", additionalProperties: false, required: [], properties: { includeDelivered: { type: "boolean", description: "Also loads delivered in the last 14 days." } } },
  },
  needs: [{ area: AREA, level: "view" }],
  switchKey: DELIVERY_SWITCH,
  customerWords: true,
  async run(deps, _s, input) {
    const read = await readBoard(deps);
    if ("error" in read) return err(read.error);
    const b = read.board;
    const withDelivered = (input as Any)?.includeDelivered === true;
    const since = dayOf(deps.now() - 14 * 86_400_000);
    const open = b.loads.filter((l) => l.status !== "delivered")
      .sort((x, y) => (x.date ?? "9999-12-31").localeCompare(y.date ?? "9999-12-31") || x.no - y.no);
    // Delivered in the last 14 days is when it was delivered (completed_at), not the day it was planned
    // for: a load is often marked delivered days late. A row with no completed_at falls back to its day.
    const deliveredOn = (l: Load) => (l.completedAt ? l.completedAt.slice(0, 10) : l.date) ?? "";
    const done = withDelivered ? b.loads.filter((l) => l.status === "delivered" && deliveredOn(l) >= since).sort((x, y) => deliveredOn(y).localeCompare(deliveredOn(x)) || y.no - x.no) : [];
    const refs = refsFor(PREFIX.stop, b.stops.map((s) => s.id));
    const shown = [...open.slice(0, 40), ...done.slice(0, 20)];
    return ok({
      loads: shown.map((l) => loadForClaude(b, l, refs)),
      ...(open.length > 40 ? { moreOpenLoads: open.length - 40 } : {}),
      canChange: deps.canEdit(AREA),
      notes: [
        "A building already on a load stays on it: I don't move stops between loads, change drivers, edit a load or a stop, or delete a load.",
        "I mark a load out only with a driver and every building built, and a wide load (over 8'6\") only with a driver cleared for wide loads and its permit on file. That's my rule, stricter than the Mark out button.",
        "I mark a stop delivered only on a load that is out. Marking delivered can't be undone.",
        DELIVERY_SAID.cardNextMessage,
      ],
    });
  },
};

const poolTool: ToolSpec = {
  def: {
    name: "find_to_be_loaded",
    description: "What's waiting to be put on a delivery load (the To be loaded list): buildings from the build schedule, sold lot buildings, and open repairs, each with a ref, serial, customer, building, size, whether it's wide or built, its ready day and town. Refs go into propose_delivery_change to add one to a load.",
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  needs: [{ area: AREA, level: "view" }],
  switchKey: DELIVERY_SWITCH,
  customerWords: true,
  async run(deps) {
    const read = await readPool(deps);
    if ("error" in read) return err(read.error);
    const p = read.pool;
    const jr = refsFor(PREFIX.build, p.jobs.map((j) => j.id));
    const ur = refsFor(PREFIX.lot, p.units.map((u) => u.id));
    const rr = refsFor(PREFIX.repair, p.repairs.map((x) => x.id));
    const CAP = 60;
    return ok({
      buildings: p.jobs.slice(0, CAP).map((j) => ({
        ref: jr.get(j.id), serial: serialForClaude(j.serial), customer: safeName(j.customer), building: j.label ? scrub(j.label, 80) : null,
        size: size(j.width, j.length), wide: j.width !== null && j.width > WIDE_FT, built: j.kind === "done", stage: j.stage ? scrub(j.stage, 40) : null,
        ready: j.ready, town: town(j) ? scrub(town(j), 80) : null, kind: j.source === "inventory" ? "lot building" : j.source === "order" ? "sold building" : "other",
      })),
      lotBuildings: p.units.slice(0, CAP).map((u) => {
        const s = sizeIn(u.label);
        return {
          ref: ur.get(u.id), serial: serialForClaude(u.serial), buyer: safeName(u.buyer), building: u.label ? scrub(u.label, 80) : null,
          size: size(s.width, s.length), wide: s.width !== null && s.width > WIDE_FT, built: unitBuilt(p, u.id), lot: u.lot ? scrub(u.lot, 60) : null,
        };
      }),
      repairs: p.repairs.slice(0, CAP).map((x) => ({
        ref: rr.get(x.id), repair: x.no !== null ? `R-${x.no}` : null, customer: safeName(x.customer), about: x.about ? scrub(x.about, 200) : null,
        serial: serialForClaude(x.serial), status: x.status,
      })),
      ...(p.jobs.length > CAP || p.units.length > CAP || p.repairs.length > CAP ? { more: { buildings: Math.max(0, p.jobs.length - CAP), lotBuildings: Math.max(0, p.units.length - CAP), repairs: Math.max(0, p.repairs.length - CAP) } } : {}),
      canChange: deps.canEdit(AREA),
      note: DELIVERY_SAID.cardNextMessage,
    });
  },
};

// ── propose_delivery_change ─────────────────────────────────────────────────────────────────────────

interface ChangeIn { action: string; loadNumber: number; loadDate: string; item: string; stopOrder: string[] }
const inputOf = (input: unknown): ChangeIn => {
  const i = (input ?? {}) as Any;
  return {
    action: String(i.action ?? ""), loadNumber: Number.isInteger(Number(i.loadNumber)) ? Number(i.loadNumber) : 0,
    loadDate: String(i.loadDate ?? "").trim(), item: String(i.item ?? "").trim(),
    stopOrder: Array.isArray(i.stopOrder) ? i.stopOrder.slice(0, 200).map((x: unknown) => String(x ?? "").trim()) : [],
  };
};

const ONSCREEN = SAID.onScreenApprove;
type Warn = { sentence: string | null; named: string[]; messages: boolean };
const NO_WARN: Warn = { sentence: null, named: [], messages: false };

function loadLine(b: Board, l: Load): string {
  return [`Load ${l.no}`, dayLabel(l.date), driverName(b, l) ?? "no driver yet"].join(" · ");
}
const cardPreview = (action: Action, extra: Record<string, unknown>) => ({ action, where: "Delivery Schedule", route: ROUTE, ...extra });

async function proposeCreate(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  const day = i.loadDate;
  if (!day || !validDay(day)) return err("Tell me the day for the new load, as a date like 2026-11-14.");
  const today = dayOf(deps.now());
  if (day < dayOf(deps.now() - 86_400_000)) return err("That day has already gone. Pick today or a later day.");
  if (day > dayOf(deps.now() + 366 * 86_400_000)) return err("Pick a day within the next year.");
  const read = await readBoard(deps);
  if ("error" in read) return err(read.error);
  const b = read.board;
  const sameDay = b.loads.filter((l) => l.date === day && l.status !== "delivered").sort((x, y) => x.no - y.no);
  const notes: string[] = [];
  if (sameDay.length) notes.push(`You already have ${listOf(sameDay.map((l) => `Load ${l.no}`))} on that day.`);
  notes.push(`It starts with no driver and no stops. A person picks the driver on ${WHERE}.`);
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.create_load,
    title: `New delivery load for ${dayLabel(day)}`,
    preview: cardPreview("create_load", { lines: [{ label: "Day", from: "", to: dayLabel(day) }], notes, undo: DELIVERY_SAID.createUndo }),
    payload: { action: "create_load", body: { loadDate: day }, day, shown: { sameDay: sameDay.map((l) => l.id).sort() } },
  });
  return ok({
    shown: true, day, dayName: dayLabel(day), isToday: day === today, alreadyThatDay: sameDay.map((l) => l.no),
    note: `${ONSCREEN} Also say a load I make can't be undone, but a person can delete an empty load.`,
  });
}

/** Why a stop on another load stays there. Only a planned load's stops can be taken off on the board
 *  (its × is offered only then), so an out load's stop isn't sent there. */
const staysOn = (on: Load | undefined) => (on && on.status !== "planned" ? `Load ${on.no} has gone out, so it stays on it.` : DELIVERY_SAID.noMove);

/** Why Jack won't add this item to this load, or null. The route's own refusals, said first. */
function addBlock(b: Board, l: Load, it: PoolItem): string | null {
  if (l.status !== "planned") return `Load ${l.no} has already gone out, so I can't add to it.`;
  const w = itemWidth(it);
  if (w !== null && l.maxWidth !== null && w > l.maxWidth) return `That building is ${feet(w)} wide, too wide for Load ${l.no}'s truck (${feet(l.maxWidth)} at most). A person can pick a different driver on ${WHERE}.`;
  const d = hasDriver(l) ? driverFor(b, l) : null;
  if (w !== null && w > WIDE_FT && d && d.wide === false) return `That building is ${feet(w)} wide, and ${driverName(b, l)} isn't set up to run wide loads. A person can pick a different driver on ${WHERE}, or change that in Settings > Drivers.`;
  return null;
}

function addFacts(b: Board, pool: Pool, l: Load, it: PoolItem) {
  const d = hasDriver(l) ? driverFor(b, l) : null;
  return {
    load: { id: l.id, no: l.no, status: l.status, date: l.date, driverId: l.driverId, driverUserId: l.driverUserId, maxWidth: l.maxWidth, permit: l.permit, stops: stopsOn(b, l.id).map((s) => s.id) },
    driver: d ? { wide: d.wide, name: driverName(b, l) } : null,
    item: itemFacts(pool, it),
  };
}

async function proposeAdd(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  if (!(i.loadNumber > 0)) return err("Say which load, by its number.");
  if (!i.item) return err("Say what to add: its serial, a repair's number like R-12, or its ref from find_to_be_loaded.");
  const [rb, rp] = await Promise.all([readBoard(deps), readPool(deps)]);
  if ("error" in rb) return err(rb.error);
  if ("error" in rp) return err(rp.error);
  const b = rb.board, pool = rp.pool;
  const l = b.loads.find((x) => x.no === i.loadNumber);
  if (!l) return err(`There's no Load ${i.loadNumber}.`);
  const hits = findItem(pool, i.item);
  const asked = serialIn(i.item);
  if (hits.length > 1 && asked !== null) return err(DELIVERY_SAID.serialTwice(serialForClaude(asked)!));
  if (hits.length !== 1) {
    const st = stopForRef(b, i.item);
    if (st) {
      const on = b.loads.find((x) => x.id === st.loadId);
      if (st.deliveredAt) return err(`That one was already delivered${on ? ` on Load ${on.no}` : ""}.`);
      return err(`That's already on Load ${on?.no ?? "another load"} as stop ${st.order}. ${staysOn(on)}`);
    }
    return err(DELIVERY_SAID.noRef);
  }
  const it = hits[0];
  const block = addBlock(b, l, it);
  if (block) return err(block);
  const stops = stopsOn(b, l.id);
  const w = itemWidth(it);
  const wideAfter = stops.some(isWideStop) || (w !== null && w > WIDE_FT);
  const permitAfter = wideAfter && l.permit === "not_needed" ? "needed" : !wideAfter && l.permit === "needed" ? "not_needed" : l.permit;
  const warn = firesScheduled(pool, it) ? await ruleWarning(deps, ["delivery_scheduled"]) : NO_WARN;
  const notes: string[] = [];
  if (warn.sentence) notes.push(warn.sentence);
  // The Mark out button doesn't check the permit: only Jack refuses, so the card says it's Jack's rule.
  if (permitAfter === "needed" && l.permit === "not_needed") notes.push(`This makes Load ${l.no} a wide load, so its permit goes to Needed. I won't mark it out until the permit is on file.`);
  if (permitAfter === "not_needed" && l.permit === "needed") notes.push(`Load ${l.no}'s permit is set to Needed, and nothing on it would be wide, so adding this sets it to Not needed. Undo won't set it back.`);
  if (!itemBuilt(pool, it)) {
    const stage = it.kind === "build" && it.job.stage ? ` (${it.job.stage})` : "";
    notes.push(`It isn't marked Built yet${stage}. Load ${l.no} can't go out until it is.`);
    if (it.kind === "build" && it.job.ready && l.date && it.job.ready > l.date) notes.push(`Its build date, ${dayLabel(it.job.ready)}, is after the load's day.`);
  }
  if (it.kind === "repair") notes.push("A repair visit goes to the customer's address on the repair.");
  const stopNumber = stops.length + 1;
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.add_stop,
    title: `Add a stop to Load ${l.no}`,
    preview: cardPreview("add_stop", {
      load: { no: l.no, line: loadLine(b, l), status: l.status },
      lines: [{ label: `Stop ${stopNumber}`, from: "", to: itemShown(it) }],
      notes, undo: DELIVERY_SAID.addUndo, ruleNames: warn.named,
    }),
    payload: {
      action: "add_stop", body: addBody(l.id, it), loadId: l.id, loadNo: l.no, itemKind: it.kind, itemId: itemId(it), label: itemLabel(it),
      stopNumber, permitDrops: permitAfter === "not_needed" && l.permit === "needed", shown: addFacts(b, pool, l, it),
    },
  });
  // No label here: a job's title is typed by hand and can hold a customer's name. Claude has the look.
  const serial = it.kind === "build" ? it.job.serial : it.kind === "lot" ? it.unit.serial : it.repair.serial;
  return ok({
    shown: true, load: l.no, stopNumber, adding: { kind: it.kind === "build" ? "building" : it.kind === "lot" ? "lot building" : "repair", serial: serialForClaude(serial) },
    ...(warn.sentence ? { rules: warn.sentence } : {}),
    note: `${ONSCREEN}${warn.sentence ? " Tell them what the card says about their rules." : ""}`,
  });
}

async function proposeReorder(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  if (!(i.loadNumber > 0)) return err("Say which load, by its number.");
  const read = await readBoard(deps);
  if ("error" in read) return err(read.error);
  const b = read.board;
  const l = b.loads.find((x) => x.no === i.loadNumber);
  if (!l) return err(`There's no Load ${i.loadNumber}.`);
  if (l.status !== "planned") return err(`Load ${l.no} has gone out, so its stops stay in the order they went out in.`);
  const stops = stopsOn(b, l.id);
  if (stops.length < 2) return err(`Load ${l.no} has ${plural(stops.length, "stop", "stops")}, so there's nothing to put in order.`);
  const refs = refsFor(PREFIX.stop, b.stops.map((x) => x.id));
  const theirs = stops.map((x) => `${x.order} (${refs.get(x.id)!})`);
  const every = `List every stop on Load ${l.no} once, in the new order, by its stop number or its ref. Its stops now are ${theirs.join(", ")}.`;
  const to: Stop[] = [];
  for (const ref of i.stopOrder) {
    // A stop's number on this load ("2" or "stop 2"), or its ref.
    const m = STOP_WORD.exec(ref);
    const hits = m ? stops.filter((x) => x.order === Number(m[1])) : byRef(b.stops, (x) => x.id, PREFIX.stop, ref);
    if (m && hits.length !== 1) return err(hits.length ? every : `${DELIVERY_SAID.noStopNo(l.no, Number(m[1]))} ${every}`);
    if (hits.length !== 1) return err(`${DELIVERY_SAID.noRef} ${every}`);
    if (hits[0].loadId !== l.id) {
      const on = b.loads.find((x) => x.id === hits[0].loadId);
      return err(`${scrub(ref, 40)} is on Load ${on?.no ?? "another load"}, not Load ${l.no}. ${staysOn(on)}`);
    }
    if (to.some((x) => x.id === hits[0].id)) return err(`Each stop goes in the list once. ${every}`);
    to.push(hits[0]);
  }
  if (to.length !== stops.length) return err(every);
  if (to.every((x, k) => x.id === stops[k].id)) return ok({ shown: false, note: "Those stops are already in that order. Say so, and don't make a card." });
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.reorder_stops,
    title: `New stop order for Load ${l.no}`,
    preview: cardPreview("reorder_stops", {
      load: { no: l.no, line: loadLine(b, l), status: l.status },
      order: { from: stops.map(stopShown), to: to.map((x) => ({ text: stopShown(x), was: x.order })) },
      notes: [], undo: DELIVERY_SAID.reorderUndo,
    }),
    payload: {
      action: "reorder_stops", body: { loadId: l.id, stopIds: to.map((x) => x.id) }, loadId: l.id, loadNo: l.no,
      from: stops.map((x) => x.id), to: to.map((x) => x.id), shown: reorderFacts(b, l),
    },
  });
  return ok({ shown: true, load: l.no, stops: to.length, note: ONSCREEN });
}
const reorderFacts = (b: Board, l: Load) => ({ status: l.status, stops: stopsOn(b, l.id).map((x) => ({ id: x.id, order: x.order, shown: stopShown(x) })) });

/** Why this load can't go out from here, or null. Stricter than the button (11-06). */
export function outBlock(b: Board, l: Load): string | null {
  if (l.status === "out") return `Load ${l.no} is already out.`;
  if (l.status !== "planned") return `Load ${l.no} was already delivered.`;
  const stops = stopsOn(b, l.id);
  if (!stops.length) return `Load ${l.no} has no stops, so there's nothing to send out.`;
  if (!hasDriver(l)) return `Load ${l.no} has no driver yet. A person picks one on ${WHERE}; I don't assign drivers.`;
  const d = driverFor(b, l);
  if (!d || !d.isDriver) return `Load ${l.no}'s driver isn't set up as an active driver any more. A person can pick a driver on ${WHERE}.`;
  const notBuilt = stops.filter((x) => unbuilt(b, x));
  if (notBuilt.length) {
    return `${notBuilt.length === 1 ? "One building" : `${notBuilt.length} buildings`} on Load ${l.no} ${notBuilt.length === 1 ? "isn't" : "aren't"} marked Built yet (${listOf(notBuilt.map((x) => `stop ${x.order}`))}). Mark ${notBuilt.length === 1 ? "it" : "them"} built on the Build Schedule first. I don't use the override.`;
  }
  const max = lowestMax(l.maxWidth, d.maxWidth);
  const tooWide = max === null ? [] : stops.filter((x) => x.width !== null && x.width > max);
  if (tooWide.length) return `Stop ${tooWide[0].order} is ${feet(tooWide[0].width!)} wide, wider than ${driverName(b, l)}'s truck takes (${feet(max!)}). A person can change the driver or the truck first.`;
  if (wideLoad(b, l)) {
    if (d.wide !== true) return `Load ${l.no} is a wide load, and ${driverName(b, l)} isn't cleared to run wide loads. A person can pick a different driver on ${WHERE}, or change that in Settings > Drivers.`;
    if (l.permit !== "on_file") return `Load ${l.no} is a wide load, and its permit isn't on file yet. Put the permit on file on ${WHERE} first.`;
  }
  return null;
}
function outFacts(b: Board, l: Load) {
  const d = hasDriver(l) ? driverFor(b, l) : null;
  return {
    status: l.status, date: l.date, driverId: l.driverId, driverUserId: l.driverUserId, maxWidth: l.maxWidth, permit: l.permit, isWide: l.isWide,
    driver: d ? { isDriver: d.isDriver, wide: d.wide, maxWidth: d.maxWidth, name: driverName(b, l) } : null,
    stops: stopsOn(b, l.id).map((x) => ({ id: x.id, order: x.order, width: x.width, built: !unbuilt(b, x), delivered: !!x.deliveredAt, shown: stopShown(x) })),
  };
}

async function proposeOut(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  if (!(i.loadNumber > 0)) return err("Say which load, by its number.");
  const read = await readBoard(deps);
  if ("error" in read) return err(read.error);
  const b = read.board;
  const l = b.loads.find((x) => x.no === i.loadNumber);
  if (!l) return err(`There's no Load ${i.loadNumber}.`);
  const block = outBlock(b, l);
  if (block) return err(block);
  const stops = stopsOn(b, l.id);
  const wide = wideLoad(b, l);
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.mark_load_out,
    title: `Mark Load ${l.no} out`,
    preview: cardPreview("mark_load_out", {
      load: { no: l.no, line: loadLine(b, l), status: l.status },
      lines: [{ label: "Status", from: "Planned", to: "Out" }, ...(wide ? [{ label: "Wide load", from: "", to: "Driver cleared, permit on file" }] : [])],
      stops: stops.map((x) => ({ n: x.order, text: stopShown(x) })),
      notes: [], undo: DELIVERY_SAID.outUndo,
    }),
    payload: { action: "mark_load_out", body: { loadId: l.id }, loadId: l.id, loadNo: l.no, shown: outFacts(b, l) },
  });
  return ok({ shown: true, load: l.no, stops: stops.length, wide, note: `${ONSCREEN} Also say marking out can't be undone.` });
}

function deliveredFacts(b: Board, l: Load) {
  return { status: l.status, stops: stopsOn(b, l.id).map((x) => ({ id: x.id, order: x.order, built: !unbuilt(b, x), delivered: !!x.deliveredAt, shown: stopShown(x) })) };
}

async function proposeLoadDelivered(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  if (!(i.loadNumber > 0)) return err("Say which load, by its number.");
  const read = await readBoard(deps);
  if ("error" in read) return err(read.error);
  const b = read.board;
  const l = b.loads.find((x) => x.no === i.loadNumber);
  if (!l) return err(`There's no Load ${i.loadNumber}.`);
  if (l.status === "delivered") return err(`Load ${l.no} was already delivered.`);
  const stops = stopsOn(b, l.id);
  if (!stops.length) return err(`Load ${l.no} has no stops. I don't mark an empty load delivered, because a delivered load can't be removed after.`);
  const notBuilt = stops.filter((x) => unbuilt(b, x));
  if (notBuilt.length) return err(`${notBuilt.length === 1 ? "One building" : `${notBuilt.length} buildings`} on Load ${l.no} ${notBuilt.length === 1 ? "isn't" : "aren't"} marked Built yet (${listOf(notBuilt.map((x) => `stop ${x.order}`))}). Mark ${notBuilt.length === 1 ? "it" : "them"} built on the Build Schedule first. I don't use the override.`);
  const open = stops.filter((x) => !x.deliveredAt);
  const moving = open.filter(movesEstimate);
  const warn = moving.length ? await ruleWarning(deps, ["delivered"]) : NO_WARN;
  const notes: string[] = [];
  if (warn.sentence) notes.push(warn.sentence);
  if (moving.length) notes.push(`${moving.length === 1 ? "The customer's estimate" : `${moving.length} customers' estimates`} on it move${moving.length === 1 ? "s" : ""} to Delivered.`);
  if (l.status === "planned") notes.push(`Load ${l.no} was never marked out, so it goes straight to delivered.`);
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.mark_load_delivered,
    title: `Mark Load ${l.no} delivered`,
    preview: cardPreview("mark_load_delivered", {
      load: { no: l.no, line: loadLine(b, l), status: l.status },
      lines: [{ label: "Status", from: STATUS_WORDS[l.status] ?? l.status, to: "Delivered" }],
      stops: stops.map((x) => ({ n: x.order, text: stopShown(x), done: !!x.deliveredAt })),
      notes, undo: DELIVERY_SAID.deliveredUndo, ruleNames: warn.named,
    }),
    payload: { action: "mark_load_delivered", body: { loadId: l.id }, loadId: l.id, loadNo: l.no, shown: deliveredFacts(b, l) },
  });
  return ok({
    shown: true, load: l.no, stops: stops.length, estimatesMoving: moving.length, ...(warn.sentence ? { rules: warn.sentence } : {}),
    note: `${ONSCREEN} Also say marking delivered can't be undone${warn.sentence ? ", and what the card says about their rules" : ""}.`,
  });
}

function stopFacts(b: Board, st: Stop, l: Load) {
  return {
    stop: { id: st.id, loadId: st.loadId, delivered: !!st.deliveredAt, built: !unbuilt(b, st), shown: stopShown(st) },
    load: { id: l.id, status: l.status, othersOpen: stopsOn(b, l.id).filter((x) => x.id !== st.id && !x.deliveredAt).map((x) => x.id) },
  };
}

async function proposeStopDelivered(deps: Deps, s: TurnState, i: ChangeIn): Promise<ToolOut> {
  if (!i.item) return err("Say which stop: its serial, its number on the load with the load's number, or its ref from look_at_delivery_loads.");
  const read = await readBoard(deps);
  if ("error" in read) return err(read.error);
  const b = read.board;
  const named = stopNamed(b, i.loadNumber, i.item);
  if ("error" in named) return err(named.error);
  const st = named.stop;
  const l = b.loads.find((x) => x.id === st.loadId);
  if (!l) return err(DELIVERY_SAID.noStop);
  if (i.loadNumber > 0 && i.loadNumber !== l.no) return err(`That stop is on Load ${l.no}, not Load ${i.loadNumber}.`);
  if (st.deliveredAt) return err("That stop was already delivered.");
  if (l.status === "planned") return err(`Load ${l.no} hasn't gone out yet. Mark it out first, or mark the whole load delivered.`);
  if (l.status !== "out") return err(`Load ${l.no} was already delivered.`);
  if (unbuilt(b, st)) return err("That building isn't marked Built yet. Mark it built on the Build Schedule first. I don't use the override.");
  const last = !stopsOn(b, l.id).some((x) => x.id !== st.id && !x.deliveredAt);
  const warn = movesEstimate(st) ? await ruleWarning(deps, ["delivered"]) : NO_WARN;
  const notes: string[] = [];
  if (warn.sentence) notes.push(warn.sentence);
  if (movesEstimate(st)) notes.push("The customer's estimate moves to Delivered.");
  if (last) notes.push(`It's the last stop on Load ${l.no}, so the load becomes delivered too.`);
  await putCard(deps, s, {
    kind: DELIVERY_KINDS.mark_stop_delivered,
    title: `Mark stop ${st.order} on Load ${l.no} delivered`,
    preview: cardPreview("mark_stop_delivered", {
      load: { no: l.no, line: loadLine(b, l), status: l.status },
      lines: [{ label: `Stop ${st.order}`, from: "Out", to: "Delivered" }],
      stops: [{ n: st.order, text: stopShown(st) }],
      notes, undo: DELIVERY_SAID.deliveredUndo, ruleNames: warn.named,
    }),
    payload: { action: "mark_stop_delivered", body: { stopId: st.id }, stopId: st.id, loadId: l.id, loadNo: l.no, stopNumber: st.order, last, label: stopLabel(st), shown: stopFacts(b, st, l) },
  });
  return ok({
    shown: true, load: l.no, stop: st.order, loadBecomesDelivered: last, ...(warn.sentence ? { rules: warn.sentence } : {}),
    note: `${ONSCREEN} Also say marking delivered can't be undone${warn.sentence ? ", and what the card says about their rules" : ""}.`,
  });
}

const proposeTool: ToolSpec = {
  def: {
    name: "propose_delivery_change",
    description: "Put ONE delivery change on the person's screen for the Delivery Schedule. It changes nothing: the person presses Approve. create_load: a new load on a day (loadDate), with no driver. add_stop: put a building, lot building or repair from find_to_be_loaded (item) on a planned load (loadNumber); it goes on last. reorder_stops: every stop on a planned load (loadNumber), in the new order (stopOrder, refs from look_at_delivery_loads). mark_load_out: a planned load has left the yard. mark_stop_delivered: one stop (item, its stop ref) on a load that is out. mark_load_delivered: every stop on a load. It never moves a building between loads, changes a driver, edits or deletes a load, or uses the built-before-delivered override.",
    strict: true,
    input_schema: {
      type: "object", additionalProperties: false, required: ["action", "loadNumber", "loadDate", "item", "stopOrder"],
      properties: {
        action: { type: "string", enum: ACTIONS },
        loadNumber: { type: "integer", description: "The load's number, as in Load 12. 0 for create_load." },
        loadDate: { type: "string", description: "create_load only: the day, YYYY-MM-DD. Empty otherwise." },
        item: { type: "string", description: "add_stop: what to add, by its ref (build-, lot- or repair-), its serial like #1042, or a repair's number like R-12. mark_stop_delivered: the stop's number on its load like stop 2 (with loadNumber), its serial like #1042, or its ref (stop-). Empty otherwise." },
        stopOrder: { type: "array", items: { type: "string" }, description: "reorder_stops: every stop on the load, once each, in the new order, by its stop number now (like 2) or its ref. Empty otherwise." },
      },
    },
  },
  needs: [{ area: AREA, level: "edit" }],
  switchKey: DELIVERY_SWITCH,
  // A change tool: marking delivered moves customers' estimates and sets off rules that text or email
  // them, and can't be undone. Not offered once a customer's words are in the turn (both reads carry
  // names); it reads the board itself, so the person's next message makes the card.
  proposesChange: true,
  async run(deps, s, input) {
    if (!deps.canEdit(AREA)) return err(SAID.noAccess);
    const i = inputOf(input);
    switch (i.action as Action) {
      case "create_load": return await proposeCreate(deps, s, i);
      case "add_stop": return await proposeAdd(deps, s, i);
      case "reorder_stops": return await proposeReorder(deps, s, i);
      case "mark_load_out": return await proposeOut(deps, s, i);
      case "mark_stop_delivered": return await proposeStopDelivered(deps, s, i);
      case "mark_load_delivered": return await proposeLoadDelivered(deps, s, i);
    }
    return err("Pick what to change from the list.");
  },
};

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────

const failedPatch = (failure: string): ApplyOutcome => ({ patch: { status: "failed", failure, result: { saved: 0, reports: [] }, undo: null } });
const unsurePatch = (p: ProposalRow, undo: unknown = null): ApplyOutcome => ({
  patch: { status: "partly_applied", result: { saved: 0, reports: [{ label: p.title, status: "error", reason: DELIVERY_SAID.checkAgain }] }, undo },
});
const appliedPatch = (result: Record<string, unknown>, undo: unknown): ApplyOutcome => ({ patch: { status: "applied", result: { saved: 1, reports: [], ...result }, undo } });
const refusedPatch = (r: Res, nothing: string) => failedPatch(`${said(r, "That didn't go through.")} ${nothing}`);
const send = (deps: Deps, action: Action, body: unknown) => deps.call(SCHEDULE_FN, action, allowed(action, body));

async function applyCreate(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const day = String(p.payload?.day ?? "");
  if (!validDay(day)) return failedPatch("That load can't be made as it is. Ask me again.");
  if (day < dayOf(deps.now() - 86_400_000)) return failedPatch("That day has already gone, so I didn't make the load. Ask me again with a new day.");
  const read = await readBoard(deps);
  if ("error" in read) return failedPatch(DELIVERY_SAID.readAtApprove);
  const sameDay = read.board.loads.filter((l) => l.date === day && l.status !== "delivered").map((l) => l.id).sort();
  if (!same(sameDay, p.payload?.shown?.sameDay ?? [])) return failedPatch("The loads on that day changed since I showed you this, so I didn't make another. Ask me again if you still want one.");
  const known = new Set(read.board.loads.map((l) => l.id));
  const started = deps.now();
  const r = await send(deps, "create_load", p.payload?.body);
  const made = (load: Any): ApplyOutcome => {
    const dated = load?.load_date && String(load.load_date).slice(0, 10) === day;
    const loadNo = Number(load?.load_no) || null;
    if (dated) return appliedPatch({ loadNo }, null);
    // The route makes an undated load from a day it can't read, rather than refusing.
    const which = loadNo ? `Load ${loadNo}` : "The load";
    return { patch: { status: "partly_applied", result: { saved: 1, loadNo, reports: [{ label: p.title, status: "error", reason: `${which} was made without its day. Set the day on ${WHERE}.` }] }, undo: null } };
  };
  if (r.status === 200 && r.data && (r.data.load as Any)?.id) return made(r.data.load);
  if (!lost(r)) return refusedPatch(r, "Nothing was made.");
  // Lost: never sent again. A new planned load on that day, made in these minutes, is this press's.
  const again = await readBoard(deps);
  if ("error" in again) return unsurePatch(p);
  const fresh = again.board.loads.filter((l) => !known.has(l.id) && l.date === day && l.status === "planned" && (!l.createdAt || Date.parse(l.createdAt) >= started - 5 * 60_000));
  if (fresh.length === 1) return appliedPatch({ loadNo: fresh[0].no }, null);
  return unsurePatch(p);
}

async function applyAdd(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const pl = p.payload ?? {};
  const [rb, rp] = await Promise.all([readBoard(deps), readPool(deps)]);
  if ("error" in rb || "error" in rp) return failedPatch(DELIVERY_SAID.readAtApprove);
  const b = rb.board, pool = rp.pool;
  const l = b.loads.find((x) => x.id === pl.loadId);
  if (!l) return failedPatch(`Load ${pl.loadNo} isn't on ${WHERE} any more, so nothing was added.`);
  if (l.status !== "planned") return failedPatch(`Load ${l.no} has gone out since I showed you this, so nothing was added.`);
  const it = pl.itemKind === "build" ? pool.jobs.filter((j) => j.id === pl.itemId).map((job) => ({ kind: "build" as const, job }))[0]
    : pl.itemKind === "lot" ? pool.units.filter((u) => u.id === pl.itemId).map((unit) => ({ kind: "lot" as const, unit }))[0]
    : pool.repairs.filter((x) => x.id === pl.itemId).map((repair) => ({ kind: "repair" as const, repair }))[0];
  if (!it) return failedPatch("That was put on a load since I showed you this, so nothing was added.");
  if (!same(addFacts(b, pool, l, it), pl.shown)) return failedPatch(DELIVERY_SAID.moved);
  const block = addBlock(b, l, it);
  if (block) return failedPatch(`${block} Nothing was added.`);
  const r = await send(deps, "add_stop", pl.body);
  const stop = (r.data?.stop ?? null) as Any;
  const undoOf = (id: string, updatedAt: string | null, order: number | null) => ({ stopId: id, loadId: l.id, loadNo: l.no, updatedAt, order, permitDrops: pl.permitDrops === true });
  if (r.status === 200 && stop && typeof stop.id === "string") {
    // Only these three of the row it returns (which carries the phone and street) are kept.
    return appliedPatch({ loadNo: l.no, stopNumber: numOr(stop.stop_order) }, undoOf(stop.id, txt(stop.updated_at), numOr(stop.stop_order)));
  }
  if (r.status === 409) return failedPatch(`That building is already on a load, or it was delivered once before, so nothing was added. Look at it on ${WHERE}.`);
  if (!lost(r)) return refusedPatch(r, "Nothing was added.");
  // Lost: never sent again. A new stop on this load for the same building is this press's.
  const again = await readBoard(deps);
  if ("error" in again) return unsurePatch(p);
  const key = pl.itemKind === "build" ? "jobId" : pl.itemKind === "lot" ? "unitId" : "repairId";
  const was = new Set<string>((pl.shown?.load?.stops ?? []) as string[]);
  const fresh = again.board.stops.filter((x) => x.loadId === l.id && !was.has(x.id) && x[key] === pl.itemId);
  if (fresh.length === 1) return appliedPatch({ loadNo: l.no, stopNumber: fresh[0].order }, undoOf(fresh[0].id, fresh[0].updatedAt, fresh[0].order));
  return unsurePatch(p);
}

async function applyReorder(deps: Deps, p: ProposalRow): Promise<ApplyOutcome> {
  const pl = p.payload ?? {};
  const read = await readBoard(deps);
  if ("error" in read) return failedPatch(DELIVERY_SAID.readAtApprove);
  const b = read.board;
  const l = b.loads.find((x) => x.id === pl.loadId);
  if (!l) return failedPatch(`Load ${pl.loadNo} isn't on ${WHERE} any more, so nothing changed.`);
  if (l.status !== "planned") return failedPatch(`Load ${l.no} has gone out since I showed you this, so its stops stay as they are.`);
  if (!same(reorderFacts(b, l), pl.shown)) return failedPatch(DELIVERY_SAID.moved);
  const to = (pl.to ?? []) as string[];
  if (new Set(to).size !== to.length || !same([...to].sort(), stopsOn(b, l.id).map((x) => x.id).sort())) return failedPatch(DELIVERY_SAID.moved);
  const r = await send(deps, "reorder_stops", pl.body);
  const undo = { loadId: l.id, loadNo: l.no, from: pl.from, to };
  if (landed(r)) return appliedPatch({ loadNo: l.no }, undo);
  if (!lost(r)) return refusedPatch(r, "Nothing changed.");
  const again = await readBoard(deps);
  if ("error" in again) return unsurePatch(p, undo);
  if (same(stopsOn(again.board, l.id).map((x) => x.id), to)) return appliedPatch({ loadNo: l.no }, undo);
  // Part of it may have landed: Undo stays, and puts the old order back only from Jack's.
  return unsurePatch(p, undo);
}

/** The mark-out and the two delivered presses: one call, and the board decides a lost answer. */
async function applyMark(deps: Deps, p: ProposalRow, action: "mark_load_out" | "mark_load_delivered" | "mark_stop_delivered"): Promise<ApplyOutcome> {
  const pl = p.payload ?? {};
  const read = await readBoard(deps);
  if ("error" in read) return failedPatch(DELIVERY_SAID.readAtApprove);
  const b = read.board;
  const l = b.loads.find((x) => x.id === pl.loadId);
  if (!l) return failedPatch(`Load ${pl.loadNo} isn't on ${WHERE} any more, so nothing changed.`);
  let st: Stop | null = null;
  if (action === "mark_load_out") {
    if (l.status !== "planned") return failedPatch(`Load ${l.no} isn't planned any more, so nothing changed.`);
    if (!same(outFacts(b, l), pl.shown)) return failedPatch(DELIVERY_SAID.moved);
    const block = outBlock(b, l);
    if (block) return failedPatch(`${block} Nothing changed.`);
  } else if (action === "mark_load_delivered") {
    if (l.status === "delivered") return failedPatch(`Someone marked Load ${l.no} delivered since, so nothing changed.`);
    if (!same(deliveredFacts(b, l), pl.shown)) return failedPatch(DELIVERY_SAID.moved);
  } else {
    st = b.stops.find((x) => x.id === pl.stopId) ?? null;
    if (!st) return failedPatch(`That stop isn't on ${WHERE} any more, so nothing changed.`);
    if (st.deliveredAt) return failedPatch("Someone marked that stop delivered since, so nothing changed.");
    if (st.loadId !== l.id || l.status !== "out") return failedPatch(DELIVERY_SAID.moved);
    if (!same(stopFacts(b, st, l), pl.shown)) return failedPatch(DELIVERY_SAID.moved);
  }
  const r = await send(deps, action, pl.body);
  const done = () => appliedPatch({ loadNo: l.no, ...(action === "mark_stop_delivered" ? { stopNumber: st?.order ?? null, loadDone: pl.last === true } : {}) }, null);
  if (landed(r) && r.data?.already === true) return failedPatch(action === "mark_stop_delivered" ? "Someone marked that stop delivered since, so nothing changed." : `Someone marked Load ${l.no} delivered since, so nothing changed.`);
  if (landed(r)) return done();
  if (r.status === 409) {
    // The built check, read live. Jack never offers the override: the builds get marked built instead.
    // Not the route's sentence: it says "An owner or admin can override", and a stop has no override.
    if (action === "mark_stop_delivered") return failedPatch("That building isn't marked Built yet. Mark it built on the Build Schedule first. Nothing changed.");
    const stops = Array.isArray(r.data?.unbuilt) ? (r.data!.unbuilt as Any[]).map((u) => (u?.stopOrder ? `stop ${u.stopOrder}` : null)).filter(Boolean) as string[] : [];
    const head = said(r, "Some buildings on this load aren't marked Built.").replace(/\.$/, "");
    return failedPatch(`${head}${stops.length ? `: ${listOf(stops)}` : ""}. Mark ${stops.length === 1 ? "it" : "them"} built on the Build Schedule first. Nothing changed.`);
  }
  if (!lost(r)) return refusedPatch(r, "Nothing changed.");
  // Lost: never sent again. The board says whether it landed.
  const again = await readBoard(deps);
  if ("error" in again) return unsurePatch(p);
  const now = again.board.loads.find((x) => x.id === l.id);
  if (action === "mark_load_out" && now?.status === "out") return done();
  if (action === "mark_load_delivered" && now?.status === "delivered") return done();
  if (action === "mark_stop_delivered" && again.board.stops.find((x) => x.id === pl.stopId)?.deliveredAt) return done();
  return unsurePatch(p);
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────────

const undoErr = (label: string): UndoOutcome => ({ restored: 0, removed: 0, failed: 1, reports: [{ label, status: "error", reason: DELIVERY_SAID.tryUndo }] });
const left = (label: string, reason: string, status = "changed"): UndoOutcome => ({ restored: 0, removed: 0, failed: 0, reports: [{ label, status, reason }] });

/** Takes Jack's stop off again, only while nobody has touched it. */
async function undoAdd(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { stopId?: string; loadId?: string; loadNo?: number; updatedAt?: string | null; permitDrops?: boolean };
  const label = String(p.payload?.label ?? p.title);
  const read = await readBoard(deps);
  if ("error" in read) return undoErr(label);
  const b = read.board;
  const st = b.stops.find((x) => x.id === plan.stopId);
  if (!st) return { restored: 0, removed: 1, failed: 0, reports: [] };
  const l = b.loads.find((x) => x.id === st.loadId);
  if (st.loadId !== plan.loadId) return left(label, `It's on another load now, so I left it. A person can take it off on ${WHERE}.`);
  if (!l || l.status !== "planned") return left(label, `Load ${plan.loadNo} has gone out since, so the stop stays on it.`);
  if (st.deliveredAt) return left(label, "It was delivered since, so I left it.");
  if (!plan.updatedAt || st.updatedAt !== plan.updatedAt) return left(label, `Someone changed this stop since I added it, so I left it. A person can take it off on ${WHERE}.`);
  const r = await deps.call(SCHEDULE_FN, "remove_stop", { stopId: st.id });
  const out: UndoOutcome = { restored: 0, removed: 0, failed: 0, reports: [] };
  if (landed(r) || (r.status === 400 && /not found/i.test(String(r.data?.error ?? "")))) out.removed = 1;
  else if (lost(r)) return undoErr(label);
  else return left(label, said(r, "That didn't come off."), "refused");
  if (plan.permitDrops) out.reports.push({ label: `Load ${plan.loadNo}`, status: "kept", reason: `Its permit stays at Not needed. Set it back to Needed on ${WHERE} if it needs one.` });
  return out;
}

/** Puts the old order back, only while the order is still Jack's. */
async function undoReorder(deps: Deps, p: ProposalRow): Promise<UndoOutcome> {
  const plan = (p.undo ?? {}) as { loadId?: string; loadNo?: number; from?: string[]; to?: string[] };
  const label = `Load ${plan.loadNo}`;
  const read = await readBoard(deps);
  if ("error" in read) return undoErr(label);
  const b = read.board;
  const l = b.loads.find((x) => x.id === plan.loadId);
  if (!l) return left(label, `That load isn't on ${WHERE} any more.`);
  if (l.status !== "planned") return left(label, "It has gone out since, so its stops stay as they are.");
  const now = stopsOn(b, l.id).map((x) => x.id);
  const from = plan.from ?? [], to = plan.to ?? [];
  if (!same([...now].sort(), [...from].sort())) return left(label, "Stops were added or taken off since, so I left the order as it is.");
  if (same(now, from)) return { restored: 1, removed: 0, failed: 0, reports: [] };
  if (!same(now, to)) return left(label, "Someone changed the order since, so I left it.");
  const r = await deps.call(SCHEDULE_FN, "reorder_stops", { loadId: l.id, stopIds: from });
  if (landed(r)) return { restored: 1, removed: 0, failed: 0, reports: [] };
  if (lost(r)) return undoErr(label);
  return left(label, said(r, "The old order didn't go back."), "refused");
}

// ── Cards ───────────────────────────────────────────────────────────────────────────────────────────

const kindOf = (action: Action, apply: (deps: Deps, p: ProposalRow) => Promise<ApplyOutcome>, undo?: (deps: Deps, p: ProposalRow) => Promise<UndoOutcome>): KindSpec => ({
  kind: DELIVERY_KINDS[action],
  areas: () => [AREA],
  switches: () => [DELIVERY_SWITCH],
  where: WHERE,
  nothingToDo: (p) => (p.payload?.action === action && Object.keys(allowed(action, p.payload?.body)).length ? null : "There's nothing to change on that one."),
  apply: (deps, _who, p) => apply(deps, p),
  ...(undo ? { undo: (deps: Deps, _who: unknown, p: ProposalRow) => undo(deps, p) } : {}),
});

export const DELIVERY_KIND_SPECS: KindSpec[] = [
  kindOf("create_load", applyCreate),
  kindOf("add_stop", applyAdd, undoAdd),
  kindOf("reorder_stops", applyReorder, undoReorder),
  kindOf("mark_load_out", (d, p) => applyMark(d, p, "mark_load_out")),
  kindOf("mark_stop_delivered", (d, p) => applyMark(d, p, "mark_stop_delivered")),
  kindOf("mark_load_delivered", (d, p) => applyMark(d, p, "mark_load_delivered")),
];

export const deliveryPiece: Piece = {
  name: "delivery",
  tools: [loadsTool, poolTool, proposeTool],
  kinds: DELIVERY_KIND_SPECS,
  can: [
    "Read the delivery board (loads, their stops, drivers, wide loads and permits) with look_at_delivery_loads, and what's waiting to be loaded with find_to_be_loaded.",
    "Put one delivery change on the person's screen with propose_delivery_change: a new load on a day, a building, lot building or repair added to a load, a load's stops in a new order, a load marked out, or a stop or a whole load marked delivered.",
  ],
  rules: [
    "Delivery: you don't move a building from one load to another, assign or change a driver, edit a load or a stop, delete a load, or use the built-before-delivered override. A person does those on the Delivery Schedule.",
    "You mark a load out only with a driver and every building on it built, and a wide load only with a driver cleared for wide loads and its permit on file. That's your rule, stricter than the Mark out button: don't say the board itself refuses.",
    "Marking out or delivered can't be undone, and delivering moves each customer's estimate to Delivered. Adding a stop and marking delivered can set off the builder's rules, which may text or email the customer: say what the card says.",
    "After look_at_delivery_loads or find_to_be_loaded, the delivery card can't go up in the same answer, because they hold customer names. To change a load, go straight to propose_delivery_change with the load number, stop numbers or serials the person gave. If you did look first, say what you'd put on the screen and make the card when they reply, without looking again.",
  ],
};
