/**
 * Unit tests for the inventory build ladder (_shared/inventoryLifecycle.ts).
 *
 * WHY THESE EXIST. The whole reason the ladder is derived rather than stamped is that a
 * projection reverses for free — delete the build job and the unit walks back down on its
 * own. That claim is only worth making if something checks it, and checking it by hand means
 * driving a real tenant's board forwards and then backwards through seven states after every
 * future edit, which nobody will do twice. So the forward AND reverse behaviour is pinned
 * here, where it runs on every push.
 *
 * The properties worth losing sleep over:
 *   1. Every rung is reachable, and each one is reached by the SCHEDULE FACT it names.
 *   2. Removing a schedule fact walks the unit back down — no separate reverse logic exists,
 *      so if this breaks the whole design choice was wrong.
 *   3. The SALE stop is never read as arrival. A building delivered to its buyer must never
 *      report "Available to sell at Location" — that is the one wrong answer that would put
 *      a sold building back on the market.
 *   4. Nothing keys on a stage NAME. Tenants rename stages; ids and kinds survive.
 *   5. Nothing here is hand-set. There is no override and no approval flag: if a fact is not
 *      on the Build or Delivery schedule, it is not a status.
 *
 * Run: deno test supabase/functions/_shared/inventoryLifecycle.test.ts
 * (the pre-push gate runs this for you — see scripts/preflight.mjs)
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  deriveLifecycle,
  isLifecycle,
  LIFECYCLE,
  LIFECYCLE_LABEL,
  LIFECYCLE_RANK,
  type Lifecycle,
  lifecycleRank,
  SELLABLE_LIFECYCLE,
  type StageKind,
  type UnitFacts,
} from "./inventoryLifecycle.ts";

const BUYER = "SS-BUYER12345";

/** A unit with nothing on the schedule. Spread over it to add one fact at a time. */
function unit(over: Partial<UnitFacts> = {}): UnitFacts {
  return { soldDesignShortCode: null, job: null, stops: [], ...over };
}
function job(stageKind: StageKind | null, dueDate: string | null = null, completedAt: string | null = null) {
  return { stageKind, dueDate, completedAt };
}
const haulStop = (deliveredAt: string | null = null) => ({ designShortCode: null, deliveredAt });
const saleStop = (deliveredAt: string | null = null) => ({ designShortCode: BUYER, deliveredAt });

// ── 1. Every rung, reached by the fact it names ────────────────────────────────────────

Deno.test("requested — designed, but nobody has decided to build it", () => {
  // There is no `accepted` rung and no approval flag: putting the building on the Build
  // Schedule IS the approval, and that decision is made over there. A unit with no job is
  // simply still a request.
  assertEquals(deriveLifecycle(unit()), "requested");
});

Deno.test("in_queue — a build job sitting in a queue stage with no date", () => {
  assertEquals(deriveLifecycle(unit({ job: job("queue") })), "in_queue");
});

Deno.test("scheduled_build — a build date, or work already started", () => {
  // Two different facts, one rung: the shop has committed either by putting a date on it or
  // by moving it into an active stage.
  assertEquals(deriveLifecycle(unit({ job: job("queue", "2026-08-20") })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ job: job("active") })), "scheduled_build");
});

Deno.test("built — a done stage, or a completed_at from the load path", () => {
  assertEquals(deriveLifecycle(unit({ job: job("done") })), "built");
  // mark_load_delivered's alsoCompleteBuilds writes completed_at directly, bypassing both
  // move_job and complete_job. A stamped design forgets this call site; a projection cannot.
  assertEquals(deriveLifecycle(unit({ job: job("active", null, "2026-08-20") })), "built");
});

Deno.test("scheduled_delivery — an open haul stop", () => {
  assertEquals(deriveLifecycle(unit({ job: job("done"), stops: [haulStop()] })), "scheduled_delivery");
});

Deno.test("at_location — the haul stop was delivered", () => {
  assertEquals(
    deriveLifecycle(unit({ job: job("done"), stops: [haulStop("2026-08-21")] })),
    "at_location",
  );
  assertEquals(SELLABLE_LIFECYCLE, "at_location");
});

Deno.test("delivered — the sale stop was delivered", () => {
  assertEquals(
    deriveLifecycle(unit({
      soldDesignShortCode: BUYER,
      job: job("done"),
      stops: [haulStop("2026-08-21"), saleStop("2026-09-02")],
    })),
    "delivered",
  );
});

// ── 2. Reverse: remove the fact, the unit walks back down ──────────────────────────────

Deno.test("reverse — every schedule fact reverses with no reverse logic anywhere", () => {
  // This is the test that justifies the whole projection design. Each pair is (state with the
  // fact, state without it). If any of these stops holding, a stamped column would have been
  // the better choice and this module is wrong.
  const built = unit({ job: job("done") });

  // remove_stop / delete_load's cascade: scheduled_delivery → built
  assertEquals(deriveLifecycle({ ...built, stops: [haulStop()] }), "scheduled_delivery");
  assertEquals(deriveLifecycle({ ...built, stops: [] }), "built");

  // un-deliver a stop: at_location → scheduled_delivery
  assertEquals(deriveLifecycle({ ...built, stops: [haulStop("2026-08-21")] }), "at_location");
  assertEquals(deriveLifecycle({ ...built, stops: [haulStop(null)] }), "scheduled_delivery");

  // move_job out of the done stage: built → scheduled_build
  assertEquals(deriveLifecycle(unit({ job: job("active") })), "scheduled_build");

  // clear the due_date: scheduled_build → in_queue
  assertEquals(deriveLifecycle(unit({ job: job("queue", "2026-08-20") })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ job: job("queue", null) })), "in_queue");

  // delete_job: anything → requested. Taking a building off the Build Schedule un-approves it,
  // which is the whole point of not having a separate approval flag to fall out of step.
  assertEquals(deriveLifecycle(unit({ job: null })), "requested");
});

// ── 3. The sale stop is never arrival ──────────────────────────────────────────────────

Deno.test("a sold unit's SALE stop must never read as arrival at a lot", () => {
  // The wrong answer here is the expensive one: at_location is the ONE rung that means
  // sellable stock, so mistaking a delivery-to-the-buyer for an arrival would put a building
  // standing in someone's yard back on the market.
  const sold = { soldDesignShortCode: BUYER, job: job("done") };

  // Sale stop scheduled but not delivered — the building is still on the lot, and the only
  // haul stop is the delivered one that put it there.
  assertEquals(
    deriveLifecycle(unit({ ...sold, stops: [haulStop("2026-08-21"), saleStop(null)] })),
    "at_location",
  );

  // Sale stop delivered — gone.
  assertEquals(
    deriveLifecycle(unit({ ...sold, stops: [haulStop("2026-08-21"), saleStop("2026-09-02")] })),
    "delivered",
  );

  // Sold BEFORE it was built (the pre-selling case): the sale stop exists, no haul ever
  // happened. It must NOT claim the building reached a lot.
  assertEquals(deriveLifecycle(unit({ ...sold, stops: [saleStop(null)] })), "built");
});

Deno.test("an unfinished build caps the ladder — a stop cannot claim a building exists", () => {
  // Staff schedule the haul before the shop finishes, and a spec build can be sold before it
  // is made, so a stop on an unbuilt building is a normal state rather than a corruption.
  // Everything downstream reads `rank >= built` as "really built" — the delivery board's ready
  // chip, the pool's draggability, the built-before-delivered guard — so a stop must never
  // promote a building past `built` while its job says otherwise.
  const queued = { job: job("queue", "2026-08-20") };            // scheduled_build, not done
  assertEquals(deriveLifecycle(unit({ ...queued, stops: [] })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ ...queued, stops: [haulStop(null)] })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ ...queued, stops: [haulStop("2026-08-21")] })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ job: job("queue"), stops: [haulStop(null)] })), "in_queue");

  // Once the job IS done, the stops decide again.
  assertEquals(deriveLifecycle(unit({ job: job("done"), stops: [haulStop(null)] })), "scheduled_delivery");

  // …but a building physically delivered to its buyer is terminal regardless: that is a fact
  // about the world, not a board state, and it must never read as sellable stock.
  assertEquals(
    deriveLifecycle(unit({ ...queued, soldDesignShortCode: BUYER, stops: [saleStop("2026-09-02")] })),
    "delivered",
  );
});

Deno.test("a tenant who never uses the build board still climbs to at_location", () => {
  // No build job at all — plenty of shops just haul a finished building to a lot. The cap
  // above must not strand them at `requested` forever.
  assertEquals(deriveLifecycle(unit({ job: null, stops: [] })), "requested");
  assertEquals(deriveLifecycle(unit({ job: null, stops: [haulStop(null)] })), "scheduled_delivery");
  assertEquals(deriveLifecycle(unit({ job: null, stops: [haulStop("2026-08-21")] })), "at_location");
});

Deno.test("with no buyer recorded, every stop is a haul", () => {
  // sold_design_short_code null means we cannot tell which stop is the sale, so nothing is
  // special-cased. The CHECK from migration 102 makes this state unreachable for a SOLD unit;
  // an unsold unit legitimately has only haul stops anyway.
  assertEquals(
    deriveLifecycle(unit({ soldDesignShortCode: null, stops: [{ designShortCode: BUYER, deliveredAt: "2026-09-02" }] })),
    "at_location",
  );
});

Deno.test("a unit sold before it is built still climbs the build rungs", () => {
  // Sale and lifecycle are independent axes: selling a spec build does not build it, and the
  // shop still has to. If this collapsed, a sold-but-unbuilt building would fall out of
  // production and never get made.
  const sold = { soldDesignShortCode: BUYER, stops: [] };
  assertEquals(deriveLifecycle(unit({ ...sold, job: null })), "requested");
  assertEquals(deriveLifecycle(unit({ ...sold, job: job("queue") })), "in_queue");
  assertEquals(deriveLifecycle(unit({ ...sold, job: job("queue", "2026-08-20") })), "scheduled_build");
  assertEquals(deriveLifecycle(unit({ ...sold, job: job("done") })), "built");
});

// ── 4. Nothing keys on a stage name, and nothing is hand-set ───────────────────────────

Deno.test("stage NAME is irrelevant — only kind decides", () => {
  // The facts carry no name at all: UnitFacts has no field for one, so a tenant renaming
  // "Built" to "Finished" (or to "Queue") cannot reach this module. That is the structural
  // version of scheduling rule 1, and this test is here so a future refactor that adds a name
  // to UnitFacts has to delete an assertion that says why not.
  assertEquals(Object.keys(job("done")).sort(), ["completedAt", "dueDate", "stageKind"]);
  // An unrecognised kind still counts as "there is a job" rather than falling back to
  // requested — losing a building out of production is worse than showing it one rung low.
  assertEquals(deriveLifecycle(unit({ job: job(null) })), "in_queue");
});

Deno.test("the status is a pure function of schedule facts — there is nothing to hand-set", () => {
  // Carolyn 2026-08-08: "It should only state the status." UnitFacts carries the buyer link
  // (to tell a sale stop from a haul) and the schedule rows, and nothing else — no approval
  // flag, no override, no stored rung. A future change that adds one has to delete this.
  assertEquals(Object.keys(unit()).sort(), ["job", "soldDesignShortCode", "stops"]);
});

// ── Vocabulary integrity ───────────────────────────────────────────────────────────────

Deno.test("the ladder is ordered, complete, and every rung has a label", () => {
  // Rank drives "is it built yet" comparisons across three functions and the portal, so an
  // out-of-order entry would silently change what counts as sellable or deliverable.
  LIFECYCLE.forEach((k, i) => assertEquals(LIFECYCLE_RANK[k], i));
  LIFECYCLE.forEach((k) => assertEquals(typeof LIFECYCLE_LABEL[k], "string"));
  assertEquals(Object.keys(LIFECYCLE_LABEL).length, LIFECYCLE.length);
  assertEquals(LIFECYCLE.length, 7);
  assertEquals((LIFECYCLE as readonly string[]).includes("accepted"), false);
  assertEquals(LIFECYCLE_RANK.built < LIFECYCLE_RANK[SELLABLE_LIFECYCLE], true);
  assertEquals(LIFECYCLE_RANK[SELLABLE_LIFECYCLE] < LIFECYCLE_RANK.delivered, true);
});

Deno.test("isLifecycle / lifecycleRank reject unknown values instead of guessing", () => {
  assertEquals(isLifecycle("built"), true);
  assertEquals(isLifecycle("Built"), false);
  assertEquals(isLifecycle("accepted"), false);   // retired in 105
  assertEquals(isLifecycle(null), false);
  assertEquals(lifecycleRank("requested"), 0);
  // Unknown sorts BELOW requested, so a `rank >= built` gate can never be passed by a value
  // nobody recognises.
  assertEquals(lifecycleRank(undefined), -1);
  assertEquals(lifecycleRank("sold"), -1);
});

Deno.test("every rung is reachable from some combination of facts", () => {
  // Guards against a rung being added to the vocabulary that the derivation can never return
  // — a status the UI can show but the schedule can never justify.
  const reachable = new Set<Lifecycle>([
    deriveLifecycle(unit()),
    deriveLifecycle(unit({ job: job("queue") })),
    deriveLifecycle(unit({ job: job("queue", "2026-08-20") })),
    deriveLifecycle(unit({ job: job("done") })),
    deriveLifecycle(unit({ job: job("done"), stops: [haulStop()] })),
    deriveLifecycle(unit({ job: job("done"), stops: [haulStop("2026-08-21")] })),
    deriveLifecycle(unit({
      soldDesignShortCode: BUYER,
      job: job("done"),
      stops: [haulStop("2026-08-21"), saleStop("2026-09-02")],
    })),
  ]);
  assertEquals([...reachable].sort(), [...LIFECYCLE].sort());
});
