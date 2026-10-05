// Unit tests for _shared/designStatusSync.ts, the reads and rules behind sync-design-status
// (2026-10-05, "sync-design-status 6.1 s on Pipeline").
//
// Deliberately dependency-free (no jsr:/npm: imports) so this suite still runs on a machine
// with no registry access, the same rule the other _shared tests follow. The CRM is the fake in
// _test_stubs/ghlFake.ts; nothing reaches the network.
//
// designs.status drives Send invoice, the build board and the inventory auto-sale, and every way
// this can go wrong is silent: a fence that stops holding downgrades signed work on the next
// Pipeline load, a skipped read that was needed leaves a status stuck, a stage search that misses
// an opportunity stops a promotion. So most of the effort here is one comparison, made many
// ways: the new reads and rules give EXACTLY the statuses and writes the old function gave. The
// old per-design loop is copied below, verbatim from sync-design-status/index.ts at 86afa7a, and
// is the oracle.
//
// Run: deno test --allow-env --allow-read supabase/functions/_shared/designStatusSync.test.ts
// (the pre-push gate runs this for you, see scripts/preflight.mjs)

import {
  computeStatuses, downgradeRestsOnAbsence, eachLimited, estimateTotalsById, fencedStatus, listEstimates,
  listOpportunities, listOpportunitiesAtStages, mapEstimateStatus, planGhlReads, settleStatuses, stageMapOf,
  type DesignRow,
} from "./designStatusSync.ts";
import { type FakeEstimate, type FakeOpportunity, ghlFake, type GhlWorld } from "./_test_stubs/ghlFake.ts";

const assert = (cond: unknown, msg = "assertion failed") => {
  if (!cond) throw new Error(msg);
};
const assertEquals = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg ? `${msg}: ${sa} !== ${sb}` : `${sa} !== ${sb}`);
};

// Quiet the walkers' console.warn lines (a refused page, a dropped filter) while a test expects them.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

const LOC = "loc-test";
const HEADERS = { Authorization: "Bearer test", Version: "2021-07-28" };

// ─── The oracle: the old loop, verbatim (comments dropped) ────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Any = any;
const OLD_STAGE_RANK: Record<string, number> = { sent: 0, accepted: 1, invoiced: 2, delivered: 3 };
function oldMapEstimateStatus(raw: unknown): "sent" | "accepted" | "invoiced" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "invoiced" || s === "paid") return "invoiced";
  if (s === "accepted") return "accepted";
  return "sent";
}
function legacy(
  designs: Any[],
  estRes: { rows: Any[]; complete: boolean },
  oppRes: { rows: Any[]; complete: boolean } | null,
  stageIdToStatus: Map<string, "accepted" | "invoiced" | "delivered">,
) {
  const STAGE_RANK = OLD_STAGE_RANK;
  const mapEstimateStatus = oldMapEstimateStatus;
  const estimates = estRes.rows;
  const estStatusById = new Map<string, string>();
  for (const e of estimates) {
    const id = String(e?._id ?? e?.id ?? "");
    if (id) estStatusById.set(id, String(e?.estimateStatus ?? e?.status ?? "").toLowerCase());
  }

  const oppStageById = new Map<string, string>();
  let oppsComplete = true;   // never read == nothing missing
  if (oppRes) {
    oppsComplete = oppRes.complete;
    for (const o of oppRes.rows) {
      const id = String(o?.id ?? o?._id ?? "");
      if (id) oppStageById.set(id, String(o?.pipelineStageId ?? o?.pipeline_stage_id ?? ""));
    }
  }

  const dataComplete = estRes.complete && oppsComplete;

  const statuses: Record<string, string> = {};
  const updates: { short_code: string; status: string }[] = [];
  for (const d of designs ?? []) {
    if (d.status === "draft" || d.status === "inventory") { statuses[d.short_code] = d.status; continue; }
    if (d.delivered_at) { statuses[d.short_code] = "delivered"; continue; }
    if (!d.ghl_estimate_id && d.ss_quote_number) { statuses[d.short_code] = d.status || "sent"; continue; }
    const ssLocal = !!d.ss_quote_number;
    const cachedStage = (d.status && STAGE_RANK[d.status as keyof typeof STAGE_RANK] !== undefined)
      ? (d.status as "sent" | "accepted" | "invoiced" | "delivered")
      : "sent";
    let stage: "sent" | "accepted" | "invoiced" | "delivered" = (dataComplete && !ssLocal) ? "sent" : cachedStage;

    const estStatus = d.ghl_estimate_id ? estStatusById.get(String(d.ghl_estimate_id)) : undefined;
    if (estStatus !== undefined) {
      const mapped = mapEstimateStatus(estStatus);
      if (STAGE_RANK[mapped] > STAGE_RANK[stage]) stage = mapped;
    }

    if (stageIdToStatus.size > 0 && d.ghl_opportunity_id) {
      const oppStage = oppStageById.get(String(d.ghl_opportunity_id));
      const mappedFromStage = oppStage ? stageIdToStatus.get(oppStage) : undefined;
      if (mappedFromStage && STAGE_RANK[mappedFromStage] > STAGE_RANK[stage]) stage = mappedFromStage;
    }

    if (d.accepted_at && STAGE_RANK[stage] < STAGE_RANK.accepted) stage = "accepted";

    statuses[d.short_code] = stage;
    if (stage !== (d.status || "sent")) updates.push({ short_code: d.short_code, status: stage });
  }
  return { statuses, updates, dataComplete };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────
// Stage ids: three a tenant can map, three it never does, in two pipelines of the location plus
// two more pipelines that belong to nobody's mapping (the "whole location" the old walk paid for).
const ACC = "stage-accepted", INV = "stage-invoiced", DEL = "stage-delivered";
const OTHER = ["stage-new", "stage-quoted", "stage-lost"];
const STAGES = { ghl_stage_accepted_id: ACC, ghl_stage_invoiced_id: INV, ghl_stage_delivered_id: DEL };
const MAP3 = stageMapOf(STAGES);

const design = (code: string, over: Partial<DesignRow> = {}): DesignRow => ({
  short_code: code, status: "sent", ghl_estimate_id: null, ghl_opportunity_id: null,
  delivered_at: null, ss_quote_number: null, accepted_at: null, ...over,
});
const est = (id: string, estimateStatus: string, total?: number): FakeEstimate => ({ _id: id, estimateStatus, total });
const opp = (id: string, stage: string, pipelineId = "pipe-sales"): FakeOpportunity => ({ id, pipelineId, pipelineStageId: stage });
const read = (rows: unknown[], complete = true) => ({ rows, complete });

// A seeded generator, so a failure names a seed that reproduces it.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

/** A random tenant: designs over a location with many more estimates and opportunities than
 *  the tenant's own, and a random stage mapping (sometimes none, sometimes two settings naming
 *  the same stage). */
function randomWorld(seed: number) {
  const r = rng(seed);
  const nEst = Math.floor(r() * 260);
  const nOpp = Math.floor(r() * 420);
  const estimates: FakeEstimate[] = [];
  for (let i = 0; i < nEst; i++) {
    estimates.push(est(`est-${seed}-${i}`, pick(r, ["draft", "sent", "viewed", "accepted", "invoiced", "paid", "declined", "ACCEPTED", ""])));
  }
  const opportunities: FakeOpportunity[] = [];
  for (let i = 0; i < nOpp; i++) {
    opportunities.push(opp(`opp-${seed}-${String(i).padStart(4, "0")}`, pick(r, [ACC, INV, DEL, ...OTHER]), pick(r, ["pipe-sales", "pipe-service", "pipe-other"])));
  }
  const mapping = pick(r, [
    {}, { ghl_stage_accepted_id: ACC }, STAGES, { ghl_stage_accepted_id: ACC, ghl_stage_invoiced_id: INV },
    { ghl_stage_invoiced_id: DEL, ghl_stage_delivered_id: DEL }, { ghl_stage_delivered_id: DEL },
  ]);
  const designs: DesignRow[] = [];
  const nDesigns = 1 + Math.floor(r() * 40);
  for (let i = 0; i < nDesigns; i++) {
    const hasEst = r() < 0.6;
    designs.push(design(`SS-${seed}-${i}`, {
      status: pick(r, ["draft", "inventory", "sent", "accepted", "invoiced", "delivered", null, "sent", "sent"]),
      // An estimate id that the location has, or one it lost (deleted in the CRM).
      ghl_estimate_id: hasEst ? (r() < 0.85 && nEst ? estimates[Math.floor(r() * nEst)]._id : `est-gone-${i}`) : null,
      ghl_opportunity_id: r() < 0.6 ? (r() < 0.85 && nOpp ? opportunities[Math.floor(r() * nOpp)].id : `opp-gone-${i}`) : null,
      delivered_at: r() < 0.08 ? "2026-09-30T12:00:00Z" : null,
      ss_quote_number: r() < 0.25 ? `SST-${1000 + i}` : null,
      accepted_at: r() < 0.15 ? "2026-09-29T12:00:00Z" : null,
    }));
  }
  return { estimates, opportunities, mapping, designs };
}

// ─── The rules: every fence and floor, explicitly ─────────────────────────────────────────────
Deno.test("fences: draft, inventory, delivered and StructureStudio-only designs keep their status whatever the CRM says", () => {
  const designs = [
    design("D1", { status: "draft", ghl_estimate_id: "e1", ghl_opportunity_id: "o1" }),
    design("D2", { status: "inventory", ghl_estimate_id: "e1", ghl_opportunity_id: "o1" }),
    design("D3", { status: "invoiced", delivered_at: "2026-09-30T12:00:00Z", ghl_estimate_id: "e2" }),
    design("D4", { status: "accepted", ss_quote_number: "SST-1001", ghl_opportunity_id: "o1" }),
    design("D5", { status: null, ss_quote_number: "SST-1002" }),
  ];
  const estimates = read([est("e1", "invoiced"), est("e2", "sent")]);
  const opps = read([opp("o1", DEL)]);
  for (const complete of [true, false]) {
    const out = computeStatuses(designs, { ...estimates, complete }, opps, MAP3);
    assertEquals(out.statuses, { D1: "draft", D2: "inventory", D3: "delivered", D4: "accepted", D5: "sent" }, `complete=${complete}`);
    assertEquals(out.updates, [], "a fenced design is never written");
  }
  assertEquals([fencedStatus(designs[0]), fencedStatus(designs[3]), fencedStatus(design("X"))], ["draft", "accepted", null]);
});

Deno.test("the hybrid floor: a design with a CRM estimate AND a local quote number never drops, but still climbs", () => {
  const signed = design("H1", { status: "invoiced", ghl_estimate_id: "e1", ss_quote_number: "SST-1001", ghl_opportunity_id: "o1" });
  const fresh = design("H2", { status: "sent", ghl_estimate_id: "e2", ss_quote_number: "SST-1002", ghl_opportunity_id: "o2" });
  const out = computeStatuses([signed, fresh], read([est("e1", "sent"), est("e2", "sent")]), read([opp("o1", OTHER[0]), opp("o2", INV)]), MAP3);
  assertEquals(out.statuses, { H1: "invoiced", H2: "invoiced" });
  assertEquals(out.updates, [{ short_code: "H2", status: "invoiced" }]);
});

Deno.test("the accepted floor: a local signature holds 'accepted' against a CRM estimate that says sent, and invoiced still passes", () => {
  const out = computeStatuses(
    [design("A1", { status: "accepted", ghl_estimate_id: "e1", accepted_at: "2026-09-29T12:00:00Z" }),
     design("A2", { status: "accepted", ghl_estimate_id: "e2", accepted_at: "2026-09-29T12:00:00Z" })],
    read([est("e1", "sent"), est("e2", "paid")]), null, MAP3,
  );
  assertEquals(out.statuses, { A1: "accepted", A2: "invoiced" });
  assertEquals(out.updates, [{ short_code: "A2", status: "invoiced" }]);
});

Deno.test("complete reads may downgrade; an incomplete one only promotes", () => {
  const designs = [
    design("C1", { status: "invoiced", ghl_estimate_id: "e1" }),       // CRM now says sent
    design("C2", { status: "accepted", ghl_estimate_id: "e-missing" }), // not in the list
    design("C3", { status: "sent", ghl_estimate_id: "e3" }),            // CRM says accepted
    design("C4", { status: "invoiced", ghl_opportunity_id: "o4" }),     // opp moved off the stage
  ];
  const rows = [est("e1", "sent"), est("e3", "accepted")];
  const opps = [opp("o4", OTHER[1])];

  const full = computeStatuses(designs, read(rows), read(opps), MAP3);
  assertEquals(full.dataComplete, true);
  assertEquals(full.statuses, { C1: "sent", C2: "sent", C3: "accepted", C4: "sent" });

  for (const [estOk, oppOk] of [[false, true], [true, false], [false, false]]) {
    const part = computeStatuses(designs, read(rows, estOk), read(opps, oppOk), MAP3);
    assertEquals(part.dataComplete, false);
    assertEquals(part.statuses, { C1: "invoiced", C2: "accepted", C3: "accepted", C4: "invoiced" }, `est=${estOk} opp=${oppOk}`);
    assertEquals(part.updates, [{ short_code: "C3", status: "accepted" }], "the promotion still lands");
  }
  // A read that was never made is complete: never read == nothing missing (as before).
  assertEquals(computeStatuses(designs, read(rows), null, MAP3).dataComplete, true);
});

Deno.test("an opportunity promotes only from a MAPPED stage, to the stage that setting names", () => {
  const designs = ["accepted", "invoiced", "delivered", "other"].map((s, i) => design(`O${i}`, { ghl_opportunity_id: `o${i}` }));
  const opps = [opp("o0", ACC), opp("o1", INV), opp("o2", DEL), opp("o3", OTHER[0])];
  assertEquals(computeStatuses(designs, null, read(opps), MAP3).statuses, { O0: "accepted", O1: "invoiced", O2: "delivered", O3: "sent" });
  // No stage mapped: the opportunity is not consulted at all.
  assertEquals(computeStatuses(designs, null, read(opps), stageMapOf(null)).statuses, { O0: "sent", O1: "sent", O2: "sent", O3: "sent" });
  // Two settings naming one stage: the later (higher) one wins, as before.
  const dup = stageMapOf({ ghl_stage_invoiced_id: DEL, ghl_stage_delivered_id: DEL });
  assertEquals([...dup.entries()], [[DEL, "delivered"]]);
});

Deno.test("estimate statuses map as before; paid is invoiced", () => {
  assertEquals(["accepted", "ACCEPTED", "invoiced", "paid", "sent", "viewed", "declined", "", null].map(mapEstimateStatus),
    ["accepted", "accepted", "invoiced", "invoiced", "sent", "sent", "sent", "sent", "sent"]);
});

// ─── The oracle comparison ────────────────────────────────────────────────────────────────
Deno.test("computeStatuses answers exactly what the old loop answered, on 600 random tenants, complete or not", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const w = randomWorld(seed);
    const map = stageMapOf(w.mapping);
    for (const [estOk, oppOk] of [[true, true], [false, true], [true, false], [false, false]]) {
      const e = read(w.estimates, estOk);
      const o = map.size > 0 ? read(w.opportunities, oppOk) : null;
      assertEquals(computeStatuses(w.designs, e, o, map), legacy(w.designs, e, o, map), `seed ${seed} est=${estOk} opp=${oppOk}`);
    }
  }
});

// ─── The read plan ────────────────────────────────────────────────────────────────────────
Deno.test("skip rules: no estimate id, no estimate list; no unfenced opportunity or no mapped stage, no search", () => {
  const plain = [design("P1"), design("P2", { status: "accepted" })];
  assertEquals(planGhlReads(plain, MAP3), { estimateIds: new Set(), oppStageIds: [] });

  // Opportunities on fenced designs only: the status loop never looks at them.
  const fencedOpps = [
    design("F1", { status: "draft", ghl_opportunity_id: "o1" }),
    design("F2", { status: "inventory", ghl_opportunity_id: "o2" }),
    design("F3", { delivered_at: "2026-09-30T12:00:00Z", ghl_opportunity_id: "o3" }),
    design("F4", { ss_quote_number: "SST-1001", ghl_opportunity_id: "o4" }),
  ];
  assertEquals(planGhlReads(fencedOpps, MAP3).oppStageIds, []);
  // An unfenced one with no stage mapped: nothing to promote to.
  assertEquals(planGhlReads([design("U1", { ghl_opportunity_id: "o1" })], stageMapOf(null)).oppStageIds, []);
  // An unfenced one with stages mapped: one search per distinct stage.
  assertEquals(planGhlReads([design("U1", { ghl_opportunity_id: "o1" })], MAP3).oppStageIds, [ACC, INV, DEL]);
  // A hybrid (estimate id + local quote number) is unfenced: it still climbs from its opportunity.
  assertEquals(planGhlReads([design("U2", { ghl_estimate_id: "e1", ss_quote_number: "SST-1", ghl_opportunity_id: "o1" })], MAP3).oppStageIds.length, 3);
});

Deno.test("skip rules: a DELIVERED design's estimate is still read, because its order total follows the CRM", () => {
  const plan = planGhlReads([design("DL", { delivered_at: "2026-09-30T12:00:00Z", ghl_estimate_id: "e9", ghl_opportunity_id: "o9" })], MAP3);
  assertEquals([...plan.estimateIds], ["e9"]);
  assertEquals(plan.oppStageIds, [], "but its opportunity is never consulted");
});

// ─── The estimate walk ────────────────────────────────────────────────────────────────────
const estimatesWorld = (n: number): FakeEstimate[] => Array.from({ length: n }, (_, i) => est(`e${i}`, "sent", i));

Deno.test("estimates: the walk stops at the page holding the last id it needs, and that is complete", async () => {
  const g = ghlFake({ estimates: estimatesWorld(450), opportunities: [] });
  const res = await listEstimates(LOC, HEADERS, new Set(["e5", "e150"]), g.fetch);
  assertEquals([res.pages, res.complete, res.rows.length], [2, true, 200]);
  assertEquals(g.trace.calls.map((c) => new URLSearchParams(c.split("?")[1]).get("offset")), ["0", "100"]);
});

Deno.test("estimates: an id the CRM no longer has means the whole walk, to the short page, exactly as before", async () => {
  const g = ghlFake({ estimates: estimatesWorld(450), opportunities: [] });
  const res = await listEstimates(LOC, HEADERS, new Set(["e5", "e-deleted"]), g.fetch);
  assertEquals([res.pages, res.complete, res.rows.length], [5, true, 450]);
  const all = await listEstimates(LOC, HEADERS, null, ghlFake({ estimates: estimatesWorld(450), opportunities: [] }).fetch);
  assertEquals([all.pages, all.complete, all.rows.length], [5, true, 450]);
});

Deno.test("estimates: a refused page or the 2000 cap is incomplete, never read as 'gone'", async () => {
  const refused = await quietly(() => listEstimates(LOC, HEADERS, new Set(["e350"]),
    ghlFake({ estimates: estimatesWorld(450), opportunities: [], failEstimatesAt: { offset: 100, status: 429 } }).fetch));
  assertEquals([refused.pages, refused.complete, refused.rows.length], [2, false, 100]);
  const capped = await listEstimates(LOC, HEADERS, new Set(["e-deleted"]), ghlFake({ estimates: estimatesWorld(2100), opportunities: [] }).fetch);
  assertEquals([capped.pages, capped.complete, capped.rows.length], [20, false, 2000]);
  // The cap does not bite when the last id turns up before it.
  const found = await listEstimates(LOC, HEADERS, new Set(["e1999"]), ghlFake({ estimates: estimatesWorld(2100), opportunities: [] }).fetch);
  assertEquals([found.pages, found.complete], [20, true]);
});

// ─── The opportunity search ───────────────────────────────────────────────────────────────
/** A large shared CRM location: thousands of opportunities across pipelines, few at the tenant's
 *  mapped stages. */
function bigLocation(): FakeOpportunity[] {
  const out: FakeOpportunity[] = [];
  for (let i = 0; i < 1500; i++) {
    const stage = i % 50 === 0 ? ACC : i % 75 === 0 ? INV : i % 300 === 7 ? DEL : OTHER[i % 3];
    out.push(opp(`o${String(i).padStart(4, "0")}`, stage, ["pipe-sales", "pipe-service", "pipe-builds", "pipe-old"][i % 4]));
  }
  return out;
}

Deno.test("opportunities: one filtered search per mapped stage, in parallel, never the whole location", async () => {
  const g = ghlFake({ estimates: [], opportunities: bigLocation(), latencyMs: 5 });
  const res = await listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch);
  assertEquals(res.mode, "by stage");
  assertEquals(res.complete, true);
  const stagesAsked = g.trace.calls.map((c) => new URLSearchParams(c.split("?")[1]).get("pipeline_stage_id"));
  assert(stagesAsked.every((s) => s !== null), `every search is filtered: ${JSON.stringify(g.trace.calls)}`);
  assertEquals([...new Set(stagesAsked)].sort(), [ACC, DEL, INV].sort());
  assertEquals(g.trace.maxInFlight, 3, "the three stages are asked together");
  assertEquals(res.rows.length, bigLocation().filter((o) => [ACC, INV, DEL].includes(o.pipelineStageId)).length);
  // The old read, for scale: 15 pages, one after another.
  const old = ghlFake({ estimates: [], opportunities: bigLocation() });
  const full = await listOpportunities(LOC, HEADERS, old.fetch);
  assertEquals([full.pages, full.complete, old.trace.maxInFlight], [15, true, 1]);
  assert(res.pages < full.pages, `${res.pages} pages instead of ${full.pages}`);
});

Deno.test("opportunities: a stage with more than a page follows nextPageUrl to the end", async () => {
  const many = Array.from({ length: 250 }, (_, i) => opp(`a${String(i).padStart(3, "0")}`, ACC));
  const g = ghlFake({ estimates: [], opportunities: [...many, ...bigLocation()] });
  const res = await listOpportunitiesAtStages(LOC, HEADERS, [ACC], g.fetch);
  assertEquals([res.mode, res.complete], ["by stage", true]);
  assertEquals(res.rows.length, 250 + bigLocation().filter((o) => o.pipelineStageId === ACC).length);
  assertEquals(res.pages, 3);
  // The 20-page cap still means incomplete.
  const huge = Array.from({ length: 2100 }, (_, i) => opp(`h${String(i).padStart(4, "0")}`, ACC));
  const capped = await listOpportunitiesAtStages(LOC, HEADERS, [ACC], ghlFake({ estimates: [], opportunities: huge }).fetch);
  assertEquals([capped.pages, capped.complete], [20, false]);
});

Deno.test("opportunities: a CRM that ignores the stage filter is caught and the location is walked in full", async () => {
  for (const flavour of [{ ignoreStageFilter: true }, { dropFilterOnNextPage: true }]) {
    const opportunities = [...Array.from({ length: 120 }, (_, i) => opp(`a${String(i).padStart(3, "0")}`, ACC)), ...bigLocation()];
    const g = ghlFake({ estimates: [], opportunities, ...flavour });
    const res = await quietly(() => listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV], g.fetch));
    assertEquals(res.mode, "full walk", JSON.stringify(flavour));
    assertEquals([res.complete, res.rows.length], [true, opportunities.length]);
    assert(g.trace.calls.some((c) => !c.includes("pipeline_stage_id")), "the fallback is the unfiltered walk");
  }
});

Deno.test("opportunities: one stage refused means incomplete, so promotions only", async () => {
  const g = ghlFake({ estimates: [], opportunities: bigLocation(), failOppsAt: { stage: INV, status: 429 } });
  const res = await quietly(() => listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch));
  assertEquals([res.mode, res.complete], ["by stage", false]);
  const out = computeStatuses([design("R1", { status: "invoiced", ghl_opportunity_id: "o0001" })], null, res, MAP3);
  assertEquals(out.statuses, { R1: "invoiced" }, "an opportunity that may be at the refused stage is not read as moved");
});

Deno.test("opportunities: a filter the CRM refuses (400/422) means the full walk; a 401 or 429 does not", async () => {
  for (const status of [400, 422]) {
    const g = ghlFake({ estimates: [], opportunities: bigLocation(), failOppsAt: { stage: DEL, status } });
    const res = await quietly(() => listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch));
    assertEquals([res.mode, res.complete, res.rows.length], ["full walk", true, 1500], `HTTP ${status}`);
  }
  for (const status of [401, 429, 503]) {
    const g = ghlFake({ estimates: [], opportunities: bigLocation(), failOppsAt: { stage: DEL, status } });
    const res = await quietly(() => listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch));
    assertEquals([res.mode, res.complete], ["by stage", false], `HTTP ${status}`);
    assert(g.trace.calls.every((c) => c.includes("pipeline_stage_id")), "no second, doomed walk");
  }
});

// ─── A downgrade that rests on absence is confirmed ────────────────────────────────────────
Deno.test("downgradeRestsOnAbsence: only a DOWNGRADE of a design whose opportunity is missing from the stage lists", () => {
  const ds = [
    design("G1", { status: "invoiced", ghl_opportunity_id: "o1" }), // absent, going down
    design("G2", { status: "invoiced", ghl_opportunity_id: "o2" }), // present, going down (its stage moved)
    design("G3", { status: "sent", ghl_opportunity_id: "o3" }),     // absent, going up (estimate)
    design("G4", { status: "invoiced", ghl_estimate_id: "e4" }),    // no opportunity at all
  ];
  const present = [opp("o2", ACC)];
  assertEquals(downgradeRestsOnAbsence(ds, [{ short_code: "G1", status: "sent" }], present), true);
  assertEquals(downgradeRestsOnAbsence(ds, [{ short_code: "G2", status: "accepted" }], present), false);
  assertEquals(downgradeRestsOnAbsence(ds, [{ short_code: "G3", status: "accepted" }], present), false);
  assertEquals(downgradeRestsOnAbsence(ds, [{ short_code: "G4", status: "sent" }], present), false);
  assertEquals(downgradeRestsOnAbsence(ds, [], present), false);
});

Deno.test("a stage filter that wrongly answers EMPTY can never take a status down: the full walk is asked first", async () => {
  // Invoiced from its opportunity's stage; the estimate itself still says sent.
  const designs = [design("W1", { status: "invoiced", ghl_estimate_id: "e1", ghl_opportunity_id: "o0700" })];
  const opportunities = [...bigLocation(), opp("o0700x", INV)].map((o) => o.id === "o0700" ? opp("o0700", INV) : o);
  const g = ghlFake({ estimates: [est("e1", "sent")], opportunities, emptyStageFilter: true });
  const byStage = await listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch);
  assertEquals([byStage.mode, byStage.rows.length], ["by stage", 0], "the empty answer looks perfectly healthy");
  const out = await settleStatuses(designs, read([est("e1", "sent")]) as Any, byStage, MAP3, () => listOpportunities(LOC, HEADERS, g.fetch));
  assertEquals(out.statuses, { W1: "invoiced" });
  assertEquals(out.updates, []);
  assertEquals(out.opp?.mode, "full walk");
  assertEquals(out.opp?.pages, 3 + 16, "three empty stage answers, then the whole location");
});

Deno.test("a real move backwards is still written, after the full walk agrees", async () => {
  const designs = [design("B1", { status: "invoiced", ghl_estimate_id: "e1", ghl_opportunity_id: "o0001" })]; // o0001 sits at an unmapped stage
  const g = ghlFake({ estimates: [est("e1", "sent")], opportunities: bigLocation() });
  const byStage = await listOpportunitiesAtStages(LOC, HEADERS, [ACC, INV, DEL], g.fetch);
  const out = await settleStatuses(designs, read([est("e1", "sent")]) as Any, byStage, MAP3, () => listOpportunities(LOC, HEADERS, g.fetch));
  assertEquals([out.statuses, out.updates, out.opp?.mode], [{ B1: "sent" }, [{ short_code: "B1", status: "sent" }], "full walk"]);
  // No downgrade, no confirmation: promotions and unchanged rows never pay for the full walk.
  const calm = await settleStatuses([design("B2", { status: "sent", ghl_opportunity_id: "o0050" })], null, byStage, MAP3,
    () => { throw new Error("the full walk was not needed"); });
  assertEquals([calm.statuses, calm.opp?.mode], [{ B2: "accepted" }, "by stage"]);
});

// ─── The whole read, old against new ───────────────────────────────────────────────────────
// Each random tenant is read twice from the same fake location: the old way (every estimate,
// every opportunity) into the old loop, and the new way (planGhlReads, early stop, per-stage
// search, settleStatuses) into the new rules. Same statuses, same writes, every time.
async function newWay(w: ReturnType<typeof randomWorld>, world: GhlWorld) {
  const map = stageMapOf(w.mapping);
  const plan = planGhlReads(w.designs, map);
  const g = ghlFake(world);
  const [e, o] = await Promise.all([
    plan.estimateIds.size > 0 ? listEstimates(LOC, HEADERS, plan.estimateIds, g.fetch) : null,
    plan.oppStageIds.length > 0 ? listOpportunitiesAtStages(LOC, HEADERS, plan.oppStageIds, g.fetch) : null,
  ]);
  const out = await settleStatuses(w.designs, e, o, map, () => listOpportunities(LOC, HEADERS, g.fetch));
  return { out: { statuses: out.statuses, updates: out.updates }, calls: g.trace.calls.length };
}
async function oldWay(w: ReturnType<typeof randomWorld>, world: GhlWorld) {
  const map = stageMapOf(w.mapping);
  const g = ghlFake(world);
  const e = await listEstimates(LOC, HEADERS, null, g.fetch);
  const o = map.size > 0 ? await listOpportunities(LOC, HEADERS, g.fetch) : null;
  return { out: legacy(w.designs, e, o, map), calls: g.trace.calls.length };
}

Deno.test("old reads + old loop == new reads + new rules, on 300 random tenants (filter honoured, ignored, or dropped on page 2)", async () => {
  let oldCalls = 0, newCalls = 0;
  await quietly(async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const w = randomWorld(seed);
      for (const flavour of [{}, { ignoreStageFilter: true }, { dropFilterOnNextPage: true }]) {
        const world: GhlWorld = { estimates: w.estimates, opportunities: w.opportunities, ...flavour };
        const a = await oldWay(w, world);
        const b = await newWay(w, world);
        assertEquals(b.out.statuses, a.out.statuses, `seed ${seed} ${JSON.stringify(flavour)} statuses`);
        assertEquals(b.out.updates, a.out.updates, `seed ${seed} ${JSON.stringify(flavour)} writes`);
        if (Object.keys(flavour).length) continue;
        // The NEXT load, with those writes in place: the everyday case, where nothing moved since
        // the last one. Random cached statuses make the first load full of downgrades (each one
        // confirmed against the full walk); a settled tenant has none, and that is where the
        // saving has to show.
        const settled = { ...w, designs: w.designs.map((d) => ({ ...d, status: a.out.statuses[d.short_code] })) };
        const a2 = await oldWay(settled, world);
        const b2 = await newWay(settled, world);
        assertEquals(b2.out.statuses, a2.out.statuses, `seed ${seed} settled`);
        assertEquals(b2.out.updates, [], `seed ${seed}: a settled tenant writes nothing`);
        oldCalls += a2.calls;
        newCalls += b2.calls;
      }
    }
  });
  // Fewer requests even on these small locations (at most a few pages each, where three stage
  // searches can outnumber a two-page walk). On a large shared location the gap is
  // what the opportunity tests above show: 3 pages in parallel instead of 15 in a row.
  assert(newCalls < oldCalls, `fewer CRM requests on a settled load: ${newCalls} vs ${oldCalls}`);
});

Deno.test("a stage filter that answers EMPTY, on 300 random tenants: never a downgrade the old function would not make", async () => {
  // The one CRM failure the new reads cannot recognise by looking at the answer. What it may cost
  // is a promotion that waits (a status left where it was, or climbing only as far as its estimate
  // takes it); what it must never cost is a status written lower than the one it had, unless the
  // old function wrote exactly that too.
  const rank = (s: string | null | undefined) => ({ sent: 0, accepted: 1, invoiced: 2, delivered: 3 } as Record<string, number>)[s || "sent"];
  let waited = 0;
  await quietly(async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const w = randomWorld(seed);
      const world: GhlWorld = { estimates: w.estimates, opportunities: w.opportunities, emptyStageFilter: true };
      const a = (await oldWay(w, world)).out;
      const b = (await newWay(w, world)).out;
      const oldWrites = new Set(a.updates.map((u) => `${u.short_code}=${u.status}`));
      for (const d of w.designs) {
        const was = d.status || "sent", now = b.statuses[d.short_code], old = a.statuses[d.short_code];
        if (now === old) continue;
        waited++;
        // Fenced statuses (draft, inventory) never differ, so every one here has a rank.
        assert(rank(now) !== undefined && rank(old) !== undefined, `seed ${seed} ${d.short_code}: ${now} / ${old}`);
        assert(rank(now) < rank(old), `seed ${seed} ${d.short_code}: never ABOVE the old answer (${now} vs ${old})`);
        assert(rank(now) >= (rank(was) ?? 0), `seed ${seed} ${d.short_code}: never below where it was (${was} → ${now}, old ${old})`);
      }
      for (const u of b.updates) {
        const d = w.designs.find((x) => x.short_code === u.short_code)!;
        if (rank(u.status) < (rank(d.status) ?? 0)) {
          assert(oldWrites.has(`${u.short_code}=${u.status}`), `seed ${seed}: downgrade ${u.short_code}=${u.status} is not one the old function made`);
        }
      }
    }
  });
  assert(waited > 0, "the fixture really does hit missed promotions (else this test proves nothing)");
});

// ─── Writes ───────────────────────────────────────────────────────────────────────────────
Deno.test("eachLimited runs every item, never more than `limit` at once", async () => {
  let inFlight = 0, peak = 0;
  const seen: number[] = [];
  await eachLimited(Array.from({ length: 11 }, (_, i) => i), 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    seen.push(i);
    inFlight--;
  });
  assertEquals([...seen].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i));
  assertEquals(peak, 4);
  await eachLimited([], 4, () => Promise.reject(new Error("never called")));
  let one = 0;
  await eachLimited([1], 0, async () => { one++; });
  assertEquals(one, 1, "a zero limit still runs (one lane)");
});

Deno.test("estimate totals read total, then totalamountInUSD, and skip what is not a number", () => {
  const m = estimateTotalsById([{ _id: "a", total: 1234.5 }, { id: "b", totalamountInUSD: "99" }, { _id: "c", total: "n/a" }, { total: 5 }]);
  assertEquals([...m.entries()], [["a", 1234.5], ["b", 99]]);
});

// A guard on the guard: the oracle is only worth something while it still reads like the
// function it was copied from. If someone "tidies" the old loop into the new one, the comparison
// above becomes a tautology.
Deno.test("the oracle is not the code under test", async () => {
  const src = await Deno.readTextFile(new URL("./designStatusSync.ts", import.meta.url));
  assert(src.includes("export function fencedStatus("), "the new rules factor the fences out");
  assert(!src.includes("oppsComplete"), "the old loop's own variables live only in this test");
});
