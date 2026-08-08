// Where an inventory building is in its life, and how a hand-set correction behaves.
//
// An inventory unit has TWO INDEPENDENT AXES (migration 102):
//
//   BUILD LIFECYCLE — requested → accepted → in_queue → scheduled_build → built →
//     scheduled_delivery → at_location → delivered. This module.
//   SALE — unsold | sold. A stored column, because a sale is an event with an exclusivity
//     invariant and nothing upstream to project from. Not this module's business.
//
// They are independent because a customer can legitimately buy a spec build that is still
// in the queue (Carolyn 2026-08-07). A single column would need one value per
// (lifecycle × sale) pair and every consumer would be string-matching prefixes to ask
// "is it sold?".
//
// WHY THE LADDER IS DERIVED AND NOT STORED. Every rung past "accepted" is already a fact in
// build_jobs / delivery_stops. A stamped column would be the same duplicate bookkeeping that
// SCHEDULING_SCOPE's "the to-be-loaded pool is a QUERY, not a table" decision forbids one
// table over — and, worse, it would need a REVERSE transition at every call site that can
// undo a schedule fact: delete_job, remove_stop, delete_load's cascade, move_job out of a
// done stage, clearing a due_date, and alsoCompleteBuilds (which writes build_jobs directly
// and bypasses both move_job and complete_job). Miss one and the unit is pinned to a stale
// status with no error anywhere. A projection has no forward transitions, so it cannot have
// a missing reverse one: every one of those events reverses for free because the fact it
// was derived from is gone.
//
// The only lifecycle facts STORED on the row are the two no schedule event can produce:
// accepted_at (the one explicit approval) and lifecycle_manual + _basis (the correction).

export const LIFECYCLE = [
  "requested",
  "accepted",
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
  accepted: "Accepted",
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
  /** inventory_units.accepted_at — null until somebody approves the request. */
  acceptedAt: string | null;
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
  // Saving to Inventory IS the request. One explicit approval is the only way out of it —
  // nothing implicit, or "approved to build" stops meaning anything.
  if (!f.acceptedAt) return "requested";

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

  return jobDone ? "built" : "accepted";
}

export interface ManualOverride {
  lifecycle_manual: string | null;
  lifecycle_manual_basis: string | null;
}

export interface EffectiveLifecycle {
  /** What to show. */
  lifecycle: Lifecycle;
  /** What the schedule says, always — the UI shows this when the two disagree. */
  derived: Lifecycle;
  source: "auto" | "manual";
}

/**
 * Fold the owner's correction into the derivation.
 *
 * THE RULE: a manual value holds while the schedule says nothing new, and yields the moment
 * the schedule says something different.
 *
 * That is what `_basis` — the derived value AT THE MOMENT OF THE OVERRIDE — buys, and why
 * this is not a boolean. A boolean `lifecycle_manual` pins the unit forever: the wrong auto
 * state is replaced by a wrong manual state that no future truth can correct, which is
 * strictly worse than the bug it fixes. With a basis, reordering stops / editing a note /
 * renaming a stage leaves `derived` unchanged so the override survives; the crew marking the
 * card done changes `derived`, the basis goes stale, and the newer physical truth wins.
 *
 * Callers should treat a yielded override as spent and null the columns out.
 */
export function effectiveLifecycle(u: ManualOverride, derived: Lifecycle): EffectiveLifecycle {
  const manual = u.lifecycle_manual;
  if (manual && isLifecycle(manual) && u.lifecycle_manual_basis === derived) {
    return { lifecycle: manual, derived, source: "manual" };
  }
  return { lifecycle: derived, derived, source: "auto" };
}

export function isLifecycle(v: unknown): v is Lifecycle {
  return typeof v === "string" && (LIFECYCLE as readonly string[]).includes(v);
}

/** Rank comparison that tolerates an unknown value by treating it as the bottom rung. */
export function lifecycleRank(v: unknown): number {
  return isLifecycle(v) ? LIFECYCLE_RANK[v] : -1;
}
