/**
 * designStatusSync.ts: what sync-design-status reads from the CRM and how it turns that into a
 * design's status (lifted out of sync-design-status/index.ts on 2026-10-05).
 *
 * WHY IT MOVED. On 10-02 one Pipeline load spent 6.1 s in sync-design-status. The function paid
 * for two location-wide walks on every Pipeline, Contacts and Inventory load: every estimate in
 * the CRM location (100 a page, up to 2000), and, whenever any pipeline stage was mapped, every
 * opportunity in the location across ALL its pipelines (up to 20 pages), even for a tenant with
 * six designs that have an opportunity. Making those walks smaller touches the one place that
 * decides designs.status, which drives Send invoice, the build board and the inventory auto-sale,
 * so the decisions now live here where every fence can be tested against fixtures
 * (designStatusSync.test.ts) instead of only against live data.
 *
 * WHAT CHANGED, AND WHY EACH IS THE SAME ANSWER:
 *   1. A read nobody will look at is skipped (planGhlReads). The estimate list is read only when
 *      some design in the call has a CRM estimate id, and the opportunity search only when some
 *      design whose status this function decides has an opportunity id and a stage is mapped.
 *   2. The estimate walk stops at the page where every estimate id the call looks up has been
 *      seen (listEstimates). Rows past that page are never consulted.
 *   3. BEHIND A SWITCH, OFF BY DEFAULT (SDS_STAGE_SEARCH=1, sync-design-status/index.ts says what
 *      has to be seen live before it goes on): opportunities are searched per mapped stage
 *      (listOpportunitiesAtStages, at most three requests, in parallel) instead of walking the
 *      whole location. Off, the function walks every opportunity exactly as before, and only
 *      1 and 2 apply. A design is promoted from
 *      its opportunity only when that opportunity sits at a mapped stage, so "absent from every
 *      mapped stage's list" and "present at some other stage" give the same answer: no
 *      promotion. The stage filter is never trusted on its own: a row back at another stage
 *      (filter ignored) or a 400/422 (filter refused) falls back to the full walk, and so does
 *      any DOWNGRADE that rests on an opportunity being absent from every stage list
 *      (settleStatuses), so a filter that wrongly answered "nothing here" cannot take a design's
 *      status down. It CAN hold back a promotion indefinitely, silently, which is why the switch
 *      stays off until one live GET shows the filter answering rows for a stage that has deals.
 *
 * WHAT DID NOT CHANGE: the fences, the floors and the promote-only rule (computeStatuses). That
 * function is the old per-design loop moved verbatim, and the test runs it beside a copy of the
 * old loop on random fixtures.
 *
 * `complete` is the load-bearing half of every read. A caller that only sees rows cannot tell
 * "this location has no estimates" from "the CRM refused to tell us", and treating the second as
 * the first is what once let a single 401/429/5xx rewrite every design's status down to 'sent'.
 * With the reads above it means "nothing this call looks up can be missing": a skipped read is
 * complete (never read == nothing missing, as before), and an early stop is complete because every
 * id that will be looked up was found. The one deliberate difference from before: the old function
 * also went promote-only when a read it did not need failed (an opportunity walk refused while no
 * design in the call had an opportunity, or more than 2000 estimates when every id it needed was on
 * page one). The floor exists to protect what a call depends on, and a read it never makes, or rows
 * it never looks at, cannot be missing anything it depends on.
 *
 * Dependency-free on purpose: fetch is a parameter, so the test drives every walk offline.
 */

export type Stage = "sent" | "accepted" | "invoiced" | "delivered";
export type MappedStage = "accepted" | "invoiced" | "delivered";

export const STAGE_RANK: Record<string, number> = { sent: 0, accepted: 1, invoiced: 2, delivered: 3 };

// The columns this module reads off a designs row. The function selects more (contact,
// inventory_unit_id); they pass through untouched.
export type DesignRow = {
  short_code: string;
  status?: string | null;
  ghl_estimate_id?: string | null;
  ghl_opportunity_id?: string | null;
  delivered_at?: string | null;
  ss_quote_number?: string | number | null;
  accepted_at?: string | null;
};

export type StageSettings = {
  ghl_stage_accepted_id?: string | null;
  ghl_stage_invoiced_id?: string | null;
  ghl_stage_delivered_id?: string | null;
} | null | undefined;

// deno-lint-ignore no-explicit-any
type Row = any;

/** One CRM read: the rows, whether anything this call looks up can be missing, and the number of
 *  requests it took (for Server-Timing). */
export type GhlRead = { rows: Row[]; complete: boolean; pages: number };
export type OppRead = GhlRead & { mode: "by stage" | "full walk" };

const GHL = "https://services.leadconnectorhq.com";
const enc = encodeURIComponent;

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return "<no body>"; }
}

// Map a GHL estimate status → our stage (sent/accepted/invoiced). Delivered is decided
// separately from the opportunity pipeline stage. Unknown/pre-accept states stay "sent".
export function mapEstimateStatus(raw: unknown): "sent" | "accepted" | "invoiced" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "invoiced" || s === "paid") return "invoiced";
  if (s === "accepted") return "accepted";
  return "sent"; // draft, sent, viewed, declined, or unknown
}

/** The id a list row answers to: GHL's estimate list uses `_id`, the opportunity search `id`. */
export const estimateIdOf = (e: Row): string => String(e?._id ?? e?.id ?? "");
const opportunityIdOf = (o: Row): string => String(o?.id ?? o?._id ?? "");
const opportunityStageOf = (o: Row): string => String(o?.pipelineStageId ?? o?.pipeline_stage_id ?? "");

/**
 * Each configured pipeline-stage id → our fulfillment stage, so a design's status advances from
 * wherever the tenant has moved its opportunity in GHL. Pipeline-agnostic: stage ids are globally
 * unique in GHL. Set in this order on purpose, so two settings naming the same stage resolve to
 * the later (higher) one, exactly as before.
 */
export function stageMapOf(settings: StageSettings): Map<string, MappedStage> {
  const m = new Map<string, MappedStage>();
  if (settings?.ghl_stage_accepted_id) m.set(settings.ghl_stage_accepted_id, "accepted");
  if (settings?.ghl_stage_invoiced_id) m.set(settings.ghl_stage_invoiced_id, "invoiced");
  if (settings?.ghl_stage_delivered_id) m.set(settings.ghl_stage_delivered_id, "delivered");
  return m;
}

/**
 * The status a design keeps WITHOUT any CRM read, or null when this function decides it.
 * One function so the read plan and the status loop can never disagree about who is fenced.
 */
export function fencedStatus(d: DesignRow): string | null {
  // Drafts (migration 063: a browsing lead's silently-saved design) have no estimate and
  // no opportunity — there is nothing in GHL to derive from, and the 'sent' baseline
  // below would otherwise promote every draft the moment the portal loads it. Their
  // status is not this function's to move: submit-estimate turns draft into sent at the moment
  // the estimate or quote is issued (migration 241, _shared/designPromotion.ts), and since 241
  // no save_design call moves status at all.
  // Inventory masters (migration 075: the design behind a physical unit on a sales lot)
  // are the same shape of exception — no GHL estimate exists, the status is owned by
  // portal-settings' save_inventory, and 'sent' here would surface a lot building as a
  // customer estimate on the Designs tab.
  if (d.status === "draft" || d.status === "inventory") return d.status;
  // THE DELIVERED FENCE (migration 091 / SCHEDULING_SCOPE.md): a delivery marked done in
  // the portal sets designs.delivered_at + status='delivered' — a state GHL never reports
  // (no tenant maps ghl_stage_delivered_id), so recomputing here would DOWNGRADE it back
  // to invoiced on the very next sync. Locally-delivered is terminal: skip the recompute.
  if (d.delivered_at) return "delivered";
  // THE SS FENCE (migrations 121/122/124): a StructureStudio-issued quote has NO GHL
  // estimate, and its status is written locally — customer-accept sets 'accepted', the
  // SS invoice path sets 'invoiced'. The 'sent' baseline below would downgrade both on
  // the very next portal load. Keyed on BOTH conditions so a design quoted through GHL
  // before the tenant flipped the switch (it has a ghl_estimate_id) keeps GHL-derived
  // sync. Trade-off, deliberate: SS designs give up opportunity-stage promotion —
  // acceptance lives on our quote page, not in the CRM pipeline.
  if (!d.ghl_estimate_id && d.ss_quote_number) return d.status || "sent";
  return null;
}

export type GhlReadPlan = {
  /** Every estimate id this call will look up. Empty: skip the estimate list. */
  estimateIds: Set<string>;
  /** The mapped stage ids to search, one walk each. Empty: skip the opportunity search. */
  oppStageIds: string[];
};

/**
 * Which CRM reads this call needs.
 *
 * ESTIMATES key on EVERY design with an estimate id, fenced or not. The status loop only looks
 * up unfenced designs, but the order-total step reads the estimate total for every design in the
 * call, a delivered one included, so a plan keyed on unfenced designs alone would quietly stop a
 * delivered order's total from following the CRM.
 *
 * OPPORTUNITIES key on unfenced designs only: the opportunity is consulted by the status loop and
 * nothing else, and only when a stage is mapped.
 */
export function planGhlReads(designs: DesignRow[], stageMap: Map<string, MappedStage>): GhlReadPlan {
  const estimateIds = new Set<string>();
  let needOpps = false;
  for (const d of designs) {
    if (d.ghl_estimate_id) estimateIds.add(String(d.ghl_estimate_id));
    if (stageMap.size > 0 && d.ghl_opportunity_id && fencedStatus(d) === null) needOpps = true;
  }
  return { estimateIds, oppStageIds: needOpps ? [...stageMap.keys()] : [] };
}

// GET the location's estimates (offset paginated, capped at 2000), stopping early at the page
// where every id in `wanted` has been seen.
//
// `complete` is false when any page failed at the HTTP level, and also when the pagination cap is
// hit while pages are still coming back full, because the tail we never fetched is
// indistinguishable from data that does not exist. An early stop is complete: nothing this call
// looks up is in the tail.
//
// ⛔ Do NOT parallelise the PAGES: the walk stops on a short page (or when the last wanted id
// turns up), and guessing offsets ahead of that both hammers the API and breaks `complete`.
export async function listEstimates(
  locationId: string,
  headers: HeadersInit,
  wanted: Set<string> | null,
  fetchFn: typeof fetch = fetch,
): Promise<GhlRead> {
  const out: Row[] = [];
  const limit = 100;
  const missing = wanted ? new Set(wanted) : null;
  let complete = false;
  let pages = 0;
  for (let offset = 0; offset < 2000; offset += limit) {
    const url = `${GHL}/invoices/estimate/list?altId=${enc(locationId)}&altType=location&limit=${limit}&offset=${offset}`;
    const r = await fetchFn(url, { headers });
    pages++;
    if (!r.ok) { console.warn("estimate list failed:", r.status, await safeText(r)); return { rows: out, complete: false, pages }; }
    const d = await r.json();
    const arr: Row[] = Array.isArray(d?.estimates) ? d.estimates : (Array.isArray(d?.data) ? d.data : []);
    out.push(...arr);
    if (arr.length < limit) { complete = true; break; }   // short page == the real end
    if (missing) {
      for (const e of arr) missing.delete(estimateIdOf(e));
      if (missing.size === 0) { complete = true; break; }  // every id we look up is in hand
    }
  }
  return { rows: out, complete, pages };
}

// Follow one opportunity search through GHL's meta.nextPageUrl (capped at 20 pages). Same
// `complete` contract as listEstimates. With `stageId`, every row must sit at that stage: the
// first one that does not means the CRM ignored the filter, and the walk stops right there
// (`offStage`), so the caller can fall back instead of trusting a list it did not ask for.
async function walkOpportunities(
  firstUrl: string,
  headers: HeadersInit,
  fetchFn: typeof fetch,
  stageId: string | null,
): Promise<GhlRead & { offStage: boolean; refused: boolean }> {
  const out: Row[] = [];
  let complete = false;
  let pages = 0;
  let url: string | null = firstUrl;
  for (let i = 0; i < 20 && url; i++) {
    // r / d / next are annotated deliberately. `url` is both an input to the fetch and reassigned
    // from that fetch's own response, so without these TypeScript hits a circular inference
    // (TS7022) and silently degrades this whole function to `any` — which is precisely the state
    // that lets a typo ship. Keep the annotations if you touch this loop.
    const r: Response = await fetchFn(url, { headers });
    pages++;
    if (!r.ok) {
      console.warn("opportunity search failed:", r.status, await safeText(r));
      // 400/422 on a FILTERED search reads as "this filter is not accepted", which the full walk
      // does not depend on. A 401, 403, 429 or 5xx would refuse the full walk just the same, so
      // those stay plain failures (incomplete) rather than a second, doomed walk.
      return { rows: out, complete: false, pages, offStage: false, refused: stageId !== null && (r.status === 400 || r.status === 422) };
    }
    const d: Row = await r.json();
    const arr: Row[] = Array.isArray(d?.opportunities) ? d.opportunities : [];
    if (stageId !== null && arr.some((o) => opportunityStageOf(o) !== stageId)) {
      return { rows: out, complete: false, pages, offStage: true, refused: false };
    }
    out.push(...arr);
    const next: string | null = d?.meta?.nextPageUrl ? String(d.meta.nextPageUrl) : null;
    url = next && arr.length > 0 ? next : null;
    if (!url) complete = true;   // GHL stopped offering pages == the real end
  }
  return { rows: out, complete, pages, offStage: false, refused: false };
}

/** Every opportunity in the location, across all pipelines: the pre-2026-10-05 read. Still the
 *  default (the stage search is switched off), and the fallback for a CRM that ignores the stage
 *  filter. */
export async function listOpportunities(locationId: string, headers: HeadersInit, fetchFn: typeof fetch = fetch): Promise<GhlRead> {
  const w = await walkOpportunities(`${GHL}/opportunities/search?location_id=${enc(locationId)}&limit=100`, headers, fetchFn, null);
  return { rows: w.rows, complete: w.complete, pages: w.pages };
}

/**
 * The opportunities at the mapped stages: one search per stage (at most three), in parallel,
 * each with listOpportunities' `complete` contract. Their union holds every opportunity that can
 * promote a design; one missing from all of them is not at a mapped stage, which is the same
 * answer the full walk gave for one sitting at any other stage.
 *
 * pipeline_stage_id is a documented filter on GET /opportunities/search, but the answer is never
 * trusted on that alone: a row at another stage proves the filter was dropped, a 400/422 says it
 * was refused, and either way the location is walked in full, exactly as before (Server-Timing
 * says "full walk"). The one failure this cannot see is an EMPTY answer for a stage that has
 * deals. settleStatuses keeps it from writing a downgrade, but a promotion it hides stays hidden,
 * which is why sync-design-status only calls this with SDS_STAGE_SEARCH=1.
 */
export async function listOpportunitiesAtStages(
  locationId: string,
  headers: HeadersInit,
  stageIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<OppRead> {
  const walks = await Promise.all(stageIds.map((id) =>
    walkOpportunities(
      `${GHL}/opportunities/search?location_id=${enc(locationId)}&pipeline_stage_id=${enc(id)}&limit=100`,
      headers, fetchFn, id,
    )
  ));
  const pages = walks.reduce((n, w) => n + w.pages, 0);
  if (walks.some((w) => w.offStage || w.refused)) {
    console.warn("sync-design-status: the CRM ignored or refused pipeline_stage_id — walking every opportunity instead");
    const full = await listOpportunities(locationId, headers, fetchFn);
    return { rows: full.rows, complete: full.complete, pages: pages + full.pages, mode: "full walk" };
  }
  return { rows: walks.flatMap((w) => w.rows), complete: walks.every((w) => w.complete), pages, mode: "by stage" };
}

export type StatusResult = {
  statuses: Record<string, string>;
  updates: { short_code: string; status: string }[];
  /** False when a read this call made was incomplete: promotions only, no downgrades. */
  dataComplete: boolean;
};

/**
 * The highest stage per design, and the rows whose cached status moved. Precedence:
 * delivered > invoiced > accepted > sent. `est` / `opp` are null when the read was skipped.
 */
export function computeStatuses(
  designs: DesignRow[],
  est: { rows: Row[]; complete: boolean } | null,
  opp: { rows: Row[]; complete: boolean } | null,
  stageMap: Map<string, MappedStage>,
): StatusResult {
  const estStatusById = new Map<string, string>();
  for (const e of est?.rows ?? []) {
    const id = estimateIdOf(e);
    // GHL returns the status as `estimateStatus` (verified live 2026-07-25); the
    // `status` fallback is kept in case older/newer API versions differ.
    if (id) estStatusById.set(id, String(e?.estimateStatus ?? e?.status ?? "").toLowerCase());
  }
  const oppStageById = new Map<string, string>();
  for (const o of opp?.rows ?? []) {
    const id = opportunityIdOf(o);
    if (id) oppStageById.set(id, opportunityStageOf(o));
  }

  // Whether absence of a row is allowed to mean "gone". When any read was incomplete we only ever
  // promote: the cached status becomes a floor, so a 401 from a rotated api key, a 429, or a
  // location with more rows than the pagination cap can no longer rewrite a tenant's fulfilled
  // work back down to 'sent'. A read that was never made is complete (never read == nothing
  // missing).
  const dataComplete = (est ? est.complete : true) && (opp ? opp.complete : true);

  const statuses: Record<string, string> = {};
  const updates: { short_code: string; status: string }[] = [];
  for (const d of designs) {
    const fenced = fencedStatus(d);
    if (fenced !== null) { statuses[d.short_code] = fenced; continue; }
    // THE HYBRID FLOOR (mirror of the SS fence, for the case it deliberately lets past).
    // A design quoted through GHL BEFORE the tenant switched to StructureStudio quotes keeps its
    // ghl_estimate_id forever, so the two-condition SS fence does not fire — but
    // its paperwork is now LOCAL: the number came from allocate_ss_quote_number, the signature
    // from customer-accept, the invoice from the SS invoice path. The old GHL estimate is frozen
    // at whatever it said back then, so recomputing from the 'sent' baseline would DOWNGRADE a
    // signed-and-invoiced design to that stale value. Cached status becomes a floor for anything
    // carrying a local quote number; the hybrid still gets GHL-derived PROMOTION from both the
    // estimate and the opportunity stage below, which is the whole point of letting it through.
    // Keyed on ss_quote_number and deliberately NOT on ss_invoice_sent_at: that is stamped when
    // the invoice is SENT, before the customer signs (migration 136 stopped send_invoice moving
    // status), so flooring there would promote an unsigned invoice and hand it the build board.
    const ssLocal = !!d.ss_quote_number;
    // The baseline is 'sent' only when the GHL data is trustworthy enough to justify a downgrade.
    // Otherwise start from what we already believe, so the computation below can raise the status
    // but never lower it (see dataComplete above).
    const cachedStage = (d.status && STAGE_RANK[d.status] !== undefined)
      ? (d.status as Stage)
      : "sent";
    let stage: Stage = (dataComplete && !ssLocal) ? "sent" : cachedStage;

    const estStatus = d.ghl_estimate_id ? estStatusById.get(String(d.ghl_estimate_id)) : undefined;
    if (estStatus !== undefined) {
      const mapped = mapEstimateStatus(estStatus);
      if (STAGE_RANK[mapped] > STAGE_RANK[stage]) stage = mapped;
    }

    if (stageMap.size > 0 && d.ghl_opportunity_id) {
      const oppStage = oppStageById.get(String(d.ghl_opportunity_id));
      const mappedFromStage = oppStage ? stageMap.get(oppStage) : undefined;
      if (mappedFromStage && STAGE_RANK[mappedFromStage] > STAGE_RANK[stage]) stage = mappedFromStage;
    }

    // THE ACCEPTED FLOOR (migration 124, mirror of the delivered fence): an in-app
    // signature stamps designs.accepted_at — a state GHL may never report. Belt-and-braces
    // under the SS fence (which already skips pure-SS designs): this one also holds
    // for a design that has BOTH a GHL estimate and a local signature. Floor, not pin —
    // invoiced/delivered promotions still pass.
    if (d.accepted_at && STAGE_RANK[stage] < STAGE_RANK.accepted) stage = "accepted";

    statuses[d.short_code] = stage;
    if (stage !== (d.status || "sent")) updates.push({ short_code: d.short_code, status: stage });
  }
  return { statuses, updates, dataComplete };
}

/**
 * Whether a by-stage answer has to be confirmed before it is written: some design would move
 * DOWN while its opportunity is missing from every stage list. With the full walk that absence
 * meant "the deal sits at an unmapped stage"; from a stage search it means the same thing only if
 * the filter worked, and a filter that wrongly answered empty would look identical. Promotions
 * and unchanged rows never rest on absence, so only a downgrade is ever re-checked, and those are
 * rare (a deal dragged backwards).
 */
export function downgradeRestsOnAbsence(
  designs: DesignRow[],
  updates: { short_code: string; status: string }[],
  oppRows: Row[],
): boolean {
  if (!updates.length) return false;
  const present = new Set(oppRows.map(opportunityIdOf));
  const byCode = new Map(designs.map((d) => [d.short_code, d]));
  return updates.some((u) => {
    const d = byCode.get(u.short_code);
    if (!d?.ghl_opportunity_id || present.has(String(d.ghl_opportunity_id))) return false;
    const before = (d.status && STAGE_RANK[d.status] !== undefined) ? STAGE_RANK[d.status] : STAGE_RANK.sent;
    return STAGE_RANK[u.status] < before;
  });
}

/**
 * computeStatuses, plus the one confirmation a by-stage read needs (downgradeRestsOnAbsence):
 * when it fires, the location is walked in full (`walkAll`, the old read) and the statuses are
 * computed again from that, so the answer written is the one the old function would have written.
 */
export async function settleStatuses(
  designs: DesignRow[],
  est: GhlRead | null,
  opp: OppRead | null,
  stageMap: Map<string, MappedStage>,
  walkAll: () => Promise<GhlRead>,
): Promise<StatusResult & { opp: OppRead | null }> {
  let result = computeStatuses(designs, est, opp, stageMap);
  if (opp && opp.mode === "by stage" && downgradeRestsOnAbsence(designs, result.updates, opp.rows)) {
    const full = await walkAll();
    opp = { rows: full.rows, complete: full.complete, pages: opp.pages + full.pages, mode: "full walk" };
    result = computeStatuses(designs, est, opp, stageMap);
  }
  return { ...result, opp };
}

/** Each estimate's total in dollars, by id (the Orders feature's total_cents source). */
export function estimateTotalsById(rows: Row[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of rows) {
    const id = estimateIdOf(e);
    const t = Number(e?.total ?? e?.totalamountInUSD);
    if (id && Number.isFinite(t)) m.set(id, t);
  }
  return m;
}

/**
 * Run `fn` over `items`, at most `limit` at a time, in order of start. For the status and
 * order-total UPDATEs: each one is scoped to its own row, so their order never mattered, and
 * running them one after another made a burst of changes cost one database round trip each.
 * Bounded rather than all at once because this project runs on the smallest database tier.
 * `fn` must not throw (both callers turn a failed write into a logged no-op).
 */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
}
