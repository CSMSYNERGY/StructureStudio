// A fake CRM (GoHighLevel) for the two reads sync-design-status makes: the location's estimate
// list (offset pages) and the opportunity search (cursor pages through meta.nextPageUrl, with or
// without a pipeline_stage_id filter). Used by _shared/designStatusSync.test.ts and
// _test_stubs/syncDesignStatusWiring_test.ts.
//
// Dependency-free, so the self-contained _shared suite can use it too. It answers only the URLs
// those reads build and throws on anything else, so a new CRM call fails a test instead of being
// answered by accident. Ids are made up.

export type FakeEstimate = { _id: string; estimateStatus: string; total?: number };
export type FakeOpportunity = { id: string; pipelineId: string; pipelineStageId: string };

export type GhlWorld = {
  estimates: FakeEstimate[];
  opportunities: FakeOpportunity[];
  /** The CRM ignores pipeline_stage_id and answers the whole location. */
  ignoreStageFilter?: boolean;
  /** meta.nextPageUrl drops the stage filter, so page 2 onward is the whole location. */
  dropFilterOnNextPage?: boolean;
  /** The CRM "honours" pipeline_stage_id by answering nothing at all: the failure the off-stage
   *  check cannot see. */
  emptyStageFilter?: boolean;
  /** Answer this HTTP status for the estimate page at this offset. */
  failEstimatesAt?: { offset: number; status: number };
  /** Answer this HTTP status for an opportunity search whose stage filter is this id ("" = unfiltered). */
  failOppsAt?: { stage: string; status: number };
  /** Delay before each answer, to make serial pages cost wall time (the bench). */
  latencyMs?: number;
};

export type GhlTrace = { calls: string[]; inFlight: number; maxInFlight: number };

const BASE = "https://services.leadconnectorhq.com";
const PAGE = 100;

export function ghlFake(world: GhlWorld): { fetch: typeof fetch; trace: GhlTrace } {
  const trace: GhlTrace = { calls: [], inFlight: 0, maxInFlight: 0 };
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const route = (u: URL): Response => {
    if (u.pathname === "/invoices/estimate/list") {
      const limit = Number(u.searchParams.get("limit") ?? PAGE);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      if (world.failEstimatesAt && world.failEstimatesAt.offset === offset) {
        return answer({ message: "rate limited" }, world.failEstimatesAt.status);
      }
      return answer({ estimates: world.estimates.slice(offset, offset + limit), total: world.estimates.length });
    }
    if (u.pathname === "/opportunities/search") {
      const stage = u.searchParams.get("pipeline_stage_id") ?? "";
      if (world.failOppsAt && world.failOppsAt.stage === stage) return answer({ message: "rate limited" }, world.failOppsAt.status);
      const limit = Number(u.searchParams.get("limit") ?? PAGE);
      const after = u.searchParams.get("startAfterId");
      const pool = !stage || world.ignoreStageFilter
        ? world.opportunities
        : world.emptyStageFilter ? [] : world.opportunities.filter((o) => o.pipelineStageId === stage);
      const start = after ? pool.findIndex((o) => o.id === after) + 1 : 0;
      const page = pool.slice(start, start + limit);
      let nextPageUrl: string | null = null;
      if (start + limit < pool.length && page.length) {
        const next = new URL(`${BASE}/opportunities/search`);
        next.searchParams.set("location_id", u.searchParams.get("location_id") ?? "");
        if (stage && !world.dropFilterOnNextPage) next.searchParams.set("pipeline_stage_id", stage);
        next.searchParams.set("limit", String(limit));
        next.searchParams.set("startAfterId", page[page.length - 1].id);
        nextPageUrl = next.href;
      }
      return answer({ opportunities: page, meta: { total: pool.length, nextPageUrl } });
    }
    throw new Error(`the fake CRM has no answer for ${u.href}`);
  };

  const f = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    if (u.origin !== BASE) throw new Error(`unexpected fetch: ${href}`);
    trace.calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    trace.inFlight++;
    trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight);
    try {
      if (world.latencyMs) await new Promise((r) => setTimeout(r, world.latencyMs));
      return route(u);
    } finally {
      trace.inFlight--;
    }
  }) as typeof fetch;
  return { fetch: f, trace };
}
