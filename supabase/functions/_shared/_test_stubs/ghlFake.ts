// A fake CRM (GoHighLevel) for the two reads sync-design-status makes: the location's estimate
// list (offset pages) and the opportunity search (cursor pages through meta.nextPageUrl, with or
// without a pipeline_stage_id filter). Used by _shared/designStatusSync.test.ts and
// _test_stubs/syncDesignStatusWiring_test.ts.
//
// And the one read the contact import makes (2026-10-06, migration 282): POST /contacts/search,
// paged by `page` or by the last contact's `searchAfter`, with rate limits and refusals on demand.
// Used by _shared/ghlContactImport.test.ts and _test_stubs/ghlContactImportWiring_test.ts.
//
// And the three reads the quote email check makes (2026-11-04, migration 357): conversation search,
// a conversation's email rows, one email. These answer the way a tenant's stored key does, NOT the
// way a browser session does: no `events`, no channel, no attachments unless a test plants them, and
// `pending` for the silent failure. Every row and email also carries the planted CUSTOMER values, so
// a test can prove none of them reach a report. The email route answers only to
// meta.email.messageIds[0]; the row's own id gets the same 400 GHL gives. Used by
// _shared/ghlEmailCheck.test.ts and _test_stubs/ghlEmailCheckWiring_test.ts.
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

/** Customer values planted in every conversation answer, for tests that prove they go no further. */
export const CUSTOMER = {
  name: "Planted Customer Name",
  email: "planted.customer@example.test",
  phone: "+15555550142",
  subject: "Planted quote subject",
  body: "Planted email body",
  fileUrl: "https://planted.example.test/floor-plan.pdf",
};

/** One outbound email as the two routes answer it through a stored key. */
export type FakeEmail = {
  /** The message row's own id. The email route refuses it. */
  rowId: string;
  /** meta.email.messageIds[0]. Leave undefined for a row with no ids. */
  emailId?: string;
  dateAdded: string;
  direction?: string;
  /** The row's status, which the key often leaves null. */
  rowStatus?: string | null;
  rowError?: string;
  /** The email route's status and error. */
  status?: string | null;
  error?: string;
  /** Only when a test plants it: the key does not show one. */
  channel?: string;
};
export type FakeConversation = { id: string; contactId: string; emails: FakeEmail[] };
export type ConversationRead = { path: string; auth: string | null; version: string | null };

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
  /** The location's conversations, for the three quote email check reads. */
  conversations?: FakeConversation[];
  /** Answer this status on this route, as GHL does for a missing scope (401) or a rate limit (429). */
  failConversationRoute?: { route: "search" | "messages" | "email"; status: number };
  /** The email route's answer with no `emailMessage` wrapper. Earlier reads handled both shapes. */
  bareEmailAnswer?: boolean;
};

export type ContactSearch = { method: string; body: Record<string, unknown>; auth: string | null; version: string | null };
export type GhlTrace = {
  calls: string[];
  inFlight: number;
  maxInFlight: number;
  contactSearches: ContactSearch[];
  conversationReads: ConversationRead[];
};

const BASE = "https://services.leadconnectorhq.com";
const PAGE = 100;

export function ghlFake(world: GhlWorld): { fetch: typeof fetch; trace: GhlTrace } {
  const trace: GhlTrace = { calls: [], inFlight: 0, maxInFlight: 0, contactSearches: [], conversationReads: [] };
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

  // The answers below keep the customer's values in, as GHL's do: a check that copied a whole
  // answer into a report would carry them, and the test looks for exactly that.
  const conversationRoute = (u: URL): Response | null => {
    const pool = world.conversations ?? [];
    const fail = (route: "search" | "messages" | "email") =>
      world.failConversationRoute?.route === route
        ? answer({ statusCode: world.failConversationRoute.status, message: "The token is not authorized for this scope." }, world.failConversationRoute.status)
        : null;

    if (u.pathname === "/conversations/search") {
      const failed = fail("search");
      if (failed) return failed;
      if (!u.searchParams.get("locationId")) return answer({ message: "locationId is required" }, 422);
      const contactId = u.searchParams.get("contactId") ?? "";
      const found = pool.filter((c) => c.contactId === contactId);
      if (!found.length) return answer({ canonicalCode: "CONVERSATIONS_CONTACT_NOT_FOUND", message: `Contact not found for id:${contactId}` }, 400);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      return answer({
        conversations: found.slice(0, limit).map((c) => ({
          id: c.id, contactId: c.contactId, fullName: CUSTOMER.name, contactName: CUSTOMER.name, email: CUSTOMER.email, phone: CUSTOMER.phone,
        })),
        total: found.length,
      });
    }

    const email = /^\/conversations\/messages\/email\/([^/]+)$/.exec(u.pathname);
    if (email) {
      const failed = fail("email");
      if (failed) return failed;
      const id = decodeURIComponent(email[1]);
      const e = pool.flatMap((c) => c.emails).find((x) => x.emailId === id);
      if (!e) return answer({ canonicalCode: "CONVERSATIONS_EMAIL_NOT_FOUND", message: `Email message does not exist with id ${id}`, statusCode: 400 }, 400);
      const detail = {
        id,
        dateAdded: e.dateAdded,
        direction: e.direction ?? "outbound",
        to: [CUSTOMER.email],
        from: `${CUSTOMER.name} <${CUSTOMER.email}>`,
        subject: CUSTOMER.subject,
        body: CUSTOMER.body,
        snippet: CUSTOMER.body,
        files: [CUSTOMER.fileUrl],
        attachmentsMetadata: [],
        ...(e.status ? { status: e.status } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.channel ? { meta: { email: { channel: e.channel } } } : {}),
      };
      return answer(world.bareEmailAnswer ? detail : { emailMessage: detail });
    }

    const messages = /^\/conversations\/([^/]+)\/messages$/.exec(u.pathname);
    if (messages) {
      const failed = fail("messages");
      if (failed) return failed;
      if (u.searchParams.get("type") !== "TYPE_EMAIL") throw new Error(`the fake CRM only knows TYPE_EMAIL rows, got ${u.href}`);
      const conv = pool.find((c) => c.id === decodeURIComponent(messages[1]));
      if (!conv) return answer({ canonicalCode: "CONVERSATIONS_CONVERSATION_NOT_FOUND", message: "No conversation found" }, 400);
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const rows = [...conv.emails]
        .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
        .slice(0, limit)
        .map((e) => ({
          id: e.rowId,
          conversationId: conv.id,
          contactId: conv.contactId,
          dateAdded: e.dateAdded,
          direction: e.direction ?? "outbound",
          additionalToEmail: CUSTOMER.email,
          body: CUSTOMER.body,
          ...(e.rowStatus ? { status: e.rowStatus } : {}),
          ...(e.rowError ? { error: e.rowError } : {}),
          meta: {
            email: {
              name: CUSTOMER.name,
              email: CUSTOMER.email,
              subject: CUSTOMER.subject,
              messageIds: e.emailId ? [e.emailId] : [],
              ...(e.channel ? { channel: e.channel } : {}),
            },
          },
        }));
      return answer({ messages: { lastMessageId: rows[rows.length - 1]?.id ?? null, nextPage: false, messages: rows } });
    }
    return null;
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
      if (u.pathname.startsWith("/conversations/")) {
        const h = new Headers(init?.headers);
        trace.conversationReads.push({ path: u.pathname + u.search, auth: h.get("authorization"), version: h.get("version") });
        const answered = conversationRoute(u);
        if (answered) return answered;
      }
      return route(u);
    } finally {
      trace.inFlight--;
    }
  }) as typeof fetch;
  return { fetch: f, trace };
}
