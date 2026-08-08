// Where an inventory building is in its life.
//
// An inventory unit has TWO INDEPENDENT AXES:
//
//   BUILD LIFECYCLE — requested → in_queue → scheduled_build → built → scheduled_delivery →
//     at_location → delivered. This module.
//   SALE — unsold | sold. A stored column, driven by an invoice or a recorded payment and
//     nothing else. Not this module's business.
//
// They are independent because a customer can legitimately buy a spec build that is still in
// the queue (Carolyn 2026-08-07). A single column would need one value per (lifecycle × sale)
// pair and every consumer would be string-matching prefixes to ask "is it sold?".
//
// EVERY RUNG IS DERIVED. Nothing here is stored, and nothing is hand-set — Carolyn
// 2026-08-08: "NO SCHEDULING EVER HAPPENS FROM THE INVENTORY PAGE. It should only state the
// status." The Inventory page reports; the Build and Delivery schedules decide.
//
// A stamped column would be the same duplicate bookkeeping that SCHEDULING_SCOPE's "the
// to-be-loaded pool is a QUERY, not a table" decision forbids one table over — and, worse, it
// would need a REVERSE transition at every call site that can undo a schedule fact:
// delete_job, remove_stop, delete_load's cascade, move_job out of a done stage, clearing a
// due_date, and alsoCompleteBuilds (which writes build_jobs directly and bypasses both
// move_job and complete_job). Miss one and the unit is pinned to a stale status with no error
// anywhere. A projection has no forward transitions, so it cannot have a missing reverse one:
// every one of those events reverses for free because the fact it was derived from is gone.
//
// WHY THERE IS NO "accepted" RUNG (dropped in migration 105). It was the one state nothing
// could derive, so it needed a button — and the button was on the Inventory page, which is
// exactly what should not be there. PUTTING A BUILDING ON THE BUILD SCHEDULE IS THE APPROVAL:
// a unit reads `requested` until it has a build job, and `in_queue` the moment it does. The
// decision still gets made by a person, on the page where production decisions belong.

export const LIFECYCLE = [
  "requested",
  "in_queue",
  "scheduled_build",
  "built",
  "scheduled_delivery",
  "at_location",
  "delivered",
] as const;

export type Lifecycle = typeof LIFECYCLE[number];

export const LIFECYCLE_RANK = Object.fromEntries(
  LIFECYCLE.map((k, i) => [k, i]),
) as Record<Lifecycle, number>;

/** Carolyn's words, verbatim where she gave them. The portal renders these. */
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  requested: "Requested",
  in_queue: "In Queue",
  scheduled_build: "Scheduled to build",
  built: "Built",
  scheduled_delivery: "Scheduled to be brought to location",
  at_location: "Available to sell at Location",
  delivered: "Delivered to the buyer",
};

/** A unit is sellable stock at exactly one rung. Everything else is production or gone. */
export const SELLABLE_LIFECYCLE: Lifecycle = "at_location";

export type StageKind = "queue" | "active" | "done";

export interface UnitFacts {
  /** inventory_units.sold_design_short_code — identifies which stop is the SALE stop. */
  soldDesignShortCode: string | null;
  /** At most one, guaranteed by the build_jobs_one_per_unit index (migration 087). */
  job: { stageKind: StageKind | null; dueDate: string | null; completedAt: string | null } | null;
  /** Every delivery_stops row for this unit, in any state. */
  stops: { designShortCode: string | null; deliveredAt: string | null }[];
}

/**
 * What the schedule says about this building right now.
 *
 * HAUL STOP vs SALE STOP (migration 092): a unit rides two loads over its life — shop → sales
 * lot while it is unsold, then lot → buyer once it sells. The SALE stop is the one carrying
 * the buyer's design code; every other stop is a haul. A sale delivery says where the
 * building WENT, never that it reached a lot, so it must never be read as arrival.
 */
export function deriveLifecycle(f: UnitFacts): Lifecycle {
  const isSale = (s: { designShortCode: string | null }) =>
    !!f.soldDesignShortCode && s.designShortCode === f.soldDesignShortCode;

  // Terminal, and checked before everything else: the building is standing in the customer's
  // yard. Physical fact beats any board state — and without this a sold-and-delivered unit
  // still reads "Available to sell at Location", which is the one wrong answer that would put
  // it back on the market.
  if (f.stops.some((s) => isSale(s) && s.deliveredAt)) return "delivered";

  // KIND, NEVER NAME. portal-schedule's DEFAULT_STAGES happens to ship a stage called
  // "Built" and this ladder has a rung called `built` — matching on that string would be the
  // Monday "Shipped"→"Completed" rename all over again, because save_stages lets every
  // tenant rename their stages freely.
  const jobDone = !!f.job && (!!f.job.completedAt || f.job.stageKind === "done");

  // AN UNFINISHED BUILD CAPS THE LADDER. A stop can exist on a building the shop has not
  // finished (staff schedule the haul in advance, and a spec build can be sold before it is
  // made), so letting stops decide unconditionally would report an unbuilt building as
  // "Scheduled to be brought to location" — a rung that is past `built` and therefore claims
  // it exists. Everything downstream reads `rank >= built` as "really built": the delivery
  // board's ready chip, the pool's draggability, and the built-before-delivered guard. So
  // while there is a job that is not done, the job's own rung wins.
  if (f.job && !jobDone) {
    if (f.job.stageKind === "active") return "scheduled_build";   // work started ⇒ past the queue
    if (f.job.stageKind === "queue") return f.job.dueDate ? "scheduled_build" : "in_queue";
    // A job in a stage we could not resolve is still a job: it is at least queued.
    return "in_queue";
  }

  // No job at all, or the job is done — now the delivery legs decide. The no-job case matters:
  // plenty of tenants never touch the build board and simply haul a finished building to a lot.
  const haul = f.stops.filter((s) => !isSale(s));
  if (haul.some((s) => s.deliveredAt)) return "at_location";
  if (haul.length) return "scheduled_delivery";

  // No job, no stops: nobody has decided to build it yet. Putting it on the Build Schedule is
  // what moves it on, and that is a decision made over there.
  return jobDone ? "built" : "requested";
}

export function isLifecycle(v: unknown): v is Lifecycle {
  return typeof v === "string" && (LIFECYCLE as readonly string[]).includes(v);
}

/** Rank comparison that tolerates an unknown value by treating it as the bottom rung. */
export function lifecycleRank(v: unknown): number {
  return isLifecycle(v) ? LIFECYCLE_RANK[v] : -1;
}
