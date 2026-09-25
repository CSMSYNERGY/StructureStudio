// The streamed draft's two clocks, bounded by the WORKER's life as well as the request's (fix,
// 2026-09-26): streamedDraftBudgetMs (the reads' abort) and streamedDraftDeadlineMs (the answer's
// watchdog), the pure halves in styleD3.ts. That portal-settings hands them its own clocks, and the
// sweep over every worker age a request can land on, are in
// _test_stubs/aiDraftStreamWiring_test.ts, driven through the shipped handler.
//
// WHY. The platform's 400 s wall clock belongs to a WORKER, and one worker serves many requests: it is
// routed no new one once it is 200 s old and is ended at 400 s whether or not a request is in flight
// (edge-runtime's per_worker supervisor). A request that lands on a worker A seconds old is ended
// 400 - A seconds after it arrived, and every streamed clock used to count from the request alone.
//
// What is pinned here:
//   1. On a fresh worker after an ordinary set-up the budget is the 300 s it was, and the watchdog
//      the 360 s it was.
//   2. On a warm worker the reads end 75 s, and the watchdog fires 40 s, before the worker's end.
//   3. The request's own terms still apply (300 s, 330 s - set-up, 360 s from the request), and the
//      budget's 60 s floor decides only after a set-up no routed worker leaves room for.
//   4. The watchdog never goes under its small floor, whatever the clocks say.
//
// Dependency-free (no jsr:/npm: imports), like every test in the _shared group.

import {
  DRAFT_STREAM_DEADLINE_MS, EDGE_WALL_CLOCK_MS, STREAMED_DEADLINE_FLOOR_MS, STREAMED_DEADLINE_WORKER_MARGIN_MS,
  STREAMED_READS_WORKER_MARGIN_MS, streamedDraftBudgetMs, streamedDraftDeadlineMs,
} from "./styleD3.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// A request arriving at REQ on a worker `age` ms old, with `setup` ms spent before the model's clock.
const REQ = Date.parse("2026-09-26T12:00:00.000Z");
const budgetAt = (age: number, setup: number) =>
  streamedDraftBudgetMs({ t0: REQ + setup, requestStartMs: REQ, workerBornMs: REQ - age });
const deadlineAt = (age: number, armedAfter = 0) =>
  streamedDraftDeadlineMs({ now: REQ + armedAfter, requestStartMs: REQ, workerBornMs: REQ - age });

Deno.test("the numbers: a worker lives 400 s; the reads end 75 s and the watchdog 40 s before it does", () => {
  assertEquals(EDGE_WALL_CLOCK_MS, 400_000);
  assertEquals(DRAFT_STREAM_DEADLINE_MS, 360_000);
  assertEquals([STREAMED_READS_WORKER_MARGIN_MS, STREAMED_DEADLINE_WORKER_MARGIN_MS, STREAMED_DEADLINE_FLOOR_MS], [75_000, 40_000, 1_000]);
  // The watchdog's worker margin is the request's own: on a fresh worker the two terms are one 360 s.
  assertEquals(EDGE_WALL_CLOCK_MS - STREAMED_DEADLINE_WORKER_MARGIN_MS, DRAFT_STREAM_DEADLINE_MS);
});

Deno.test("streamedDraftBudgetMs: a fresh worker after an ordinary set-up keeps the 300 s it had", () => {
  assertEquals(budgetAt(0, 3_000), 300_000, "the fast path");
  // The rule of 2026-09-25, max(60 s, min(300 s, 330 s - set-up)), unchanged while the set-up is
  // under 25 s: the worker term, 325 s less the set-up, is over 300 s.
  for (let setup = 0; setup <= 25_000; setup += 500) {
    assertEquals(budgetAt(0, setup), Math.max(60_000, Math.min(300_000, 330_000 - setup)), `set-up ${setup}`);
  }
  // Past that the worker's end decides, 5 s before the request's 330 s: the worker was born first.
  assertEquals(budgetAt(0, 50_000), 275_000);
  assertEquals(budgetAt(0, 100_000), 225_000);
});

Deno.test("streamedDraftBudgetMs: on a warm worker the reads end 75 s before the worker does", () => {
  assertEquals(budgetAt(30_000, 3_000), 292_000);
  assertEquals(budgetAt(150_000, 3_000), 172_000);
  assertEquals(budgetAt(199_000, 30_000), 96_000);
  for (let age = 0; age < 200_000; age += 1_000) {
    for (let setup = 0; setup <= 60_000; setup += 1_000) {
      const b = budgetAt(age, setup);
      // Exactly the rule: the request's two terms, the worker's, and the floor.
      assertEquals(b, Math.max(60_000, Math.min(300_000, 330_000 - setup, 400_000 - 75_000 - age - setup)), `worker ${age}, set-up ${setup}`);
      assert(b <= 300_000, `worker ${age}, set-up ${setup}: ${b}`);
      // Whenever the floor does not decide, the reads end 75 s before the worker's end.
      if (b > 60_000) assert(setup + b <= EDGE_WALL_CLOCK_MS - age - STREAMED_READS_WORKER_MARGIN_MS, `worker ${age}, set-up ${setup}: reads end at ${setup + b}`);
    }
  }
});

Deno.test("streamedDraftBudgetMs: the 60 s floor never beats the worker term for a set-up under 65 s", () => {
  // A routed worker is under 200 s old when the request arrives, so at t0 the worker term is over
  // 125 s less the set-up: over 60 s for any set-up up to 65 s (the auto top-up stops at 30 s).
  for (let age = 0; age < 200_000; age += 1_000) {
    for (let setup = 0; setup <= 65_000; setup += 1_000) {
      const unfloored = Math.min(300_000, 330_000 - setup, EDGE_WALL_CLOCK_MS - STREAMED_READS_WORKER_MARGIN_MS - age - setup);
      assert(unfloored > 60_000, `worker ${age}, set-up ${setup}: ${unfloored}`);
      assertEquals(budgetAt(age, setup), unfloored, `worker ${age}, set-up ${setup}`);
    }
  }
  // Only a set-up past that on the oldest routable worker reaches it, and then it is the floor.
  assertEquals(budgetAt(199_000, 70_000), 60_000);
  assertEquals(budgetAt(0, 300_000), 60_000);
});

Deno.test("streamedDraftDeadlineMs: 360 s on a fresh worker, and 40 s before the worker's end on a warm one", () => {
  assertEquals(deadlineAt(0), 360_000, "a fresh worker: the 360 s it was");
  assertEquals(deadlineAt(0, 2_000), 358_000, "armed 2 s in: still 360 s from the request");
  for (let age = 0; age < 200_000; age += 1_000) {
    for (const armedAfter of [0, 500, 5_000]) {
      const fires = armedAfter + deadlineAt(age, armedAfter);
      assertEquals(fires, DRAFT_STREAM_DEADLINE_MS - age, `worker ${age}, armed ${armedAfter} ms in`);
      assertEquals(fires, EDGE_WALL_CLOCK_MS - STREAMED_DEADLINE_WORKER_MARGIN_MS - age, "40 s before the worker's end");
    }
  }
});

Deno.test("streamedDraftDeadlineMs: never later than 360 s from the request, and never under its floor", () => {
  // A clock that puts the worker's birth AFTER the request (it cannot be): the request's own term.
  assertEquals(streamedDraftDeadlineMs({ now: REQ + 1_000, requestStartMs: REQ, workerBornMs: REQ + 30_000 }), 359_000);
  // A worker already past 360 s: the floor, so the answer is still closed with a whole body.
  assertEquals(deadlineAt(360_000), STREAMED_DEADLINE_FLOOR_MS);
  assertEquals(deadlineAt(399_000), STREAMED_DEADLINE_FLOOR_MS);
  assertEquals(deadlineAt(10_000_000), STREAMED_DEADLINE_FLOOR_MS);
  // And a request already past its own 360 s.
  assertEquals(deadlineAt(0, 400_000), STREAMED_DEADLINE_FLOOR_MS);
  assertEquals(deadlineAt(359_500), 1_000, "half a second left is still the floor");
  assertEquals(deadlineAt(355_000), 5_000);
});
