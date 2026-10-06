// A fake CRM (GoHighLevel) for the two reads sync-design-status makes: the location's estimate
// list (offset pages) and the opportunity search (cursor pages through meta.nextPageUrl, with or
// without a pipeline_stage_id filter). Used by _shared/designStatusSync.test.ts and
// _test_stubs/syncDesignStatusWiring_test.ts.
//
// And the one read the contact import makes (2026-10-06, migration 282): POST /contacts/search,
// paged by `page` or by the last contact's `searchAfter`, with rate limits and refusals on demand.
// Used by _shared/ghlContactImport.test.ts and _test_stubs/ghlContactImportWiring_test.ts.
//
// Dependency-free, so the self-contained _shared suite can use it too. It answers only the URLs
// those reads build and throws on anything else, so a new CRM call fails a test instead of being
// answered by accident. Ids are made up.

export type FakeEstimate = { _id: string; estimateStatus: string; total?: number };
export type FakeOpportunity = { id: string; pipelineId: string; pipelineStageId: string };
/** A contact as POST /contacts/search answers it (the fields the import reads; all optional but id). */
export type FakeContact = {
  id: string;
  firstName?: string; lastName?: string; contactName?: string; companyName?: string;
  phone?: string; email?: string; tags?: unknown; dateAdded?: string;
  dnd?: boolean; dndSettings?: Record<string, { status?: string }>;
  [k: string]: unknown;
};

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
  /** The location's contacts, for POST /contacts/search. */
  contacts?: FakeContact[];
  /** "after" (the default): every contact carries searchAfter. "page": none does, so the walk pages. */
  contactPaging?: "after" | "page";
  /** Answer `status` (with Retry-After when given) for contact searches number `from` (0-based)
   *  through `from + count - 1`. */
  failContacts?: { from: number; count: number; status: number; retryAfter?: string };
  /** Every contact carries the searchAfter of the FIRST page's last contact: a CRM whose paging
   *  stops moving after one page. */
  stuckSearchAfter?: boolean;
  /** Leave `total` out of the answer. */
  noContactTotal?: boolean;
};

export type ContactSearch = { method: string; body: Record<string, unknown>; auth: string | null; version: string | null };
export type GhlTrace = { calls: string[]; inFlight: number; maxInFlight: number; contactSearches: ContactSearch[] };

const BASE = "https://services.leadconnectorhq.com";
const PAGE = 100;

export function ghlFake(world: GhlWorld): { fetch: typeof fetch; trace: GhlTrace } {
  const trace: GhlTrace = { calls: [], inFlight: 0, maxInFlight: 0, contactSearches: [] };
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // POST /contacts/search: `page` (1-based) or `searchAfter` (the last contact's), `pageLimit` per page.
  const searchContacts = (body: Record<string, unknown>): Response => {
    const n = trace.contactSearches.length - 1;
    const fail = world.failContacts;
    if (fail && n >= fail.from && n < fail.from + fail.count) {
      return new Response(JSON.stringify({ message: "Too many requests" }), {
        status: fail.status,
        headers: { "content-type": "application/json", ...(fail.retryAfter ? { "retry-after": fail.retryAfter } : {}) },
      });
    }
    const pool = world.contacts ?? [];
    const limit = Number(body.pageLimit ?? 20);
    let start = 0;
    if (Array.isArray(body.searchAfter)) {
      if (body.page !== undefined) return answer({ message: "page cannot be used with searchAfter" }, 422);
      start = pool.findIndex((c) => c.id === (body.searchAfter as unknown[])[1]) + 1;
      if (start === 0) return answer({ message: "bad searchAfter" }, 422);
    } else {
      start = (Number(body.page ?? 1) - 1) * limit;
    }
    const page = pool.slice(start, start + limit).map((c, i) =>
      (world.contactPaging ?? "after") === "after"
        ? {
          ...c,
          searchAfter: world.stuckSearchAfter
            ? [1700000000000 + Math.min(limit, pool.length) - 1, pool[Math.min(limit, pool.length) - 1]?.id]
            : [1700000000000 + start + i, c.id],
        }
        : { ...c }
    );
    return answer(world.noContactTotal ? { contacts: page } : { contacts: page, total: pool.length });
  };

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

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    if (u.origin !== BASE) throw new Error(`unexpected fetch: ${href}`);
    const method = String(init?.method ?? "GET").toUpperCase();
    trace.calls.push(method === "GET" ? `${u.pathname}?${u.searchParams.toString()}` : `${method} ${u.pathname}`);
    trace.inFlight++;
    trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight);
    try {
      if (world.latencyMs) await new Promise((r) => setTimeout(r, world.latencyMs));
      if (u.pathname === "/contacts/search") {
        if (method !== "POST") throw new Error(`the fake CRM's contact search is a POST, got ${method}`);
        const h = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body ?? "{}"));
        trace.contactSearches.push({ method, body, auth: h.get("authorization"), version: h.get("version") });
        return searchContacts(body);
      }
      if (method !== "GET") throw new Error(`the fake CRM has no ${method} ${u.pathname}`);
      return route(u);
    } finally {
      trace.inFlight--;
    }
  }) as typeof fetch;
  return { fetch: f, trace };
}
