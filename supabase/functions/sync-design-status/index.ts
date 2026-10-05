import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { addPhase, timedFetch, withServerTiming, type ServerTiming } from "../_shared/serverTiming.ts";
import {
  eachLimited, estimateTotalsById, listEstimates, listOpportunities, listOpportunitiesAtStages, type OppRead, planGhlReads,
  settleStatuses, STAGE_RANK, stageMapOf,
} from "../_shared/designStatusSync.ts";

// This function exposes a single implicit action; everything it does is a read.
// WHAT THIS FUNCTION REQUIRES (migration 100) — see _shared/access.ts.
//
// designs:'view', not 'edit'. This endpoint writes designs rows, but it is a REFRESH the
// portal fires on load, not a user editing anything: it recomputes status from GHL. Gating
// it on edit would break the Designs tab for exactly the read-only roles (crew leader,
// driver) whose presets are designs:'view'.
//
// It also closes a hole the old shape had: `payload.action` was never validated, so any
// value other than "sync" fell out of SYNC_READS and was treated as a write. Unknown
// actions are now refused by the table.
const GATES: GateTable = { sync: { area: "designs", level: "view" } };

// sync-design-status — refresh each design's fulfillment status FROM GoHighLevel.
//
// Status is a read-only, GHL-derived projection cached on `designs.status`. The portal
// calls this on load with the short_codes it is showing; we recompute the highest reached
// stage per design and persist it. Precedence: delivered > invoiced > accepted > sent.
//
//   Sent      — an estimate exists (StructureStudio sent it). Baseline.
//   Accepted  — the GHL estimate's status is "accepted", OR the design's opportunity is at
//               the tenant's configured "Quote Accepted" pipeline stage.
//   Invoiced  — the GHL estimate's status is "invoiced"/"paid", OR the opportunity is at the
//               tenant's configured "Invoiced" pipeline stage.
//   Delivered — the design's opportunity is at the tenant's configured "Delivered" stage.
//
// Accepted/Invoiced/Delivered each map to a client_settings.ghl_stage_*_id; the design's
// opportunity's current pipelineStageId is matched against them (pipeline-agnostic — stage
// ids are globally unique in GHL). This pipeline-stage path means status advances purely
// from where the tenant moves the deal in their pipeline, independent of the estimate API.
//
// Auth mirrors portal-settings: verify_jwt alone is not auth (the anon key passes the
// gateway), so we resolve a real user via auth.getUser() and map user → client via
// client_users (service role). client_id is NEVER taken from the body. Any linked account
// may call this (it only reads/derives their own tenant's statuses).
//
// GHL access mirrors submit-estimate: base https://services.leadconnectorhq.com,
// header Version: 2021-07-28, Bearer <ghl_api_key>. Bounded LIST calls per tenant, never per
// design, and since 2026-10-05 only the ones this call will look at (_shared/designStatusSync.ts):
// the estimate list when a design in the call has an estimate id, stopping at the page where
// the last of those ids turns up; and, when a pipeline stage is mapped and a design whose status
// this function decides has an opportunity, the location's opportunities: walked in full, as
// before, unless SDS_STAGE_SEARCH=1, which asks for one search PER MAPPED STAGE instead (see
// stageSearchOn below for why that waits). Server-Timing on the response says which read took
// the time (est / opp, with page counts and which opportunity read ran) and what the database
// and the writes cost (db / writes), so the next slow call answers "CRM or database?" from the
// portal's own tab.
//
// VERIFIED against a live accepted estimate (EST-29, 2026-07-25): the list endpoint
// returns the status in `estimateStatus` (top-level `status` does not exist / is null),
// ids in `_id`, rows under `estimates`, and an `estimateActionHistory` array of
// { estimateStatus, updatedAt } events. Values observed: "accepted". The mapping lives
// in mapEstimateStatus() (_shared/designStatusSync.ts); GHL failures never throw — the design
// keeps its cached status.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // The browser keeps this preflight for 2 h (Chrome's cap) instead of 5 s — see portal-settings.
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// How many UPDATEs run at once (status and order-total writes). Each is scoped to its own row, so
// their order never mattered; running them one after another made a burst of changes cost one
// database round trip each. Small, because this project runs on the smallest database tier.
const WRITE_LANES = 4;

// THE PER-STAGE OPPORTUNITY SEARCH IS OFF UNTIL IT HAS BEEN SEEN TO WORK (2026-10-05 review).
// listOpportunitiesAtStages catches a CRM that ignores pipeline_stage_id (rows at other stages)
// or refuses it (400/422), and settleStatuses re-checks any downgrade. What neither can see is a
// filter that answers EMPTY for a stage that has deals: a design whose deal was dragged to a
// mapped stage would then never be promoted, with nothing logged, and that is where Send invoice,
// the build board and the inventory auto-sale wait. So the default is the old full walk, and the
// switch is a secret, flipped only after two things: one read-only GET of
// /opportunities/search?location_id=…&pipeline_stage_id=<a stage that has deals> comes back
// non-empty with every row at that stage, and a Server-Timing read that blames `opp`. Read per
// request so a test can set it (and an isolate started after a secrets change sees the new value).
const stageSearchOn = () => Deno.env.get("SDS_STAGE_SEARCH") === "1";

// The CRM reads, the status rules and every fence live in _shared/designStatusSync.ts (moved there
// on 2026-10-05 so each one is tested against fixtures). This file is the request around them:
// who is asking, which rows, the reads, and the writes.
Deno.serve(withErrorLog("sync-design-status", withServerTiming(async (req: Request, st: ServerTiming) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth + tenant resolution (shared with portal-settings / portal-billing).
  // An operator viewing another tenant sends targetClientId; everyone else resolves to
  // their own client_users row exactly as before.
  //
  // Classified as a READ. This function has never had an owner/admin role gate — that is
  // precisely what lets a role-"user" team member refresh the Designs list — so do NOT
  // reclassify it as a write just because it caches `designs.status`. Doing so would
  // silently break every non-admin login.
  //
  // `admin` is the timed client: every query through it lands in Server-Timing's `db`.
  const admin = createClient(supabaseUrl, serviceKey, { global: { fetch: timedFetch(st) } });
  const authStart = performance.now();
  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "sync" });
  st.auth = performance.now() - authStart;
  if (!r.ok) return json(r.body, r.status);
  st.authPath = r.ctx.authPath; // "local" = the fast path in _shared/resolveTenant.ts held
  const { clientId, payload } = r.ctx;

  const shortCodes: string[] = Array.isArray(payload?.shortCodes)
    ? payload.shortCodes.map((c: unknown) => String(c)).filter(Boolean).slice(0, 500)
    : [];
  if (shortCodes.length === 0) return json({ ok: true, statuses: {}, synced: false });

  // 3+4. The tenant's designs for these codes, and the tenant's GHL creds. Neither needs the
  // other, and this function sits on the critical path of three tabs, so they go together.
  const [designsRes, settingsRes] = await Promise.all([
    admin.from("designs")
      .select("short_code, status, ghl_estimate_id, ghl_opportunity_id, delivered_at, inventory_unit_id, contact, ss_quote_number, accepted_at")
      .eq("client_id", clientId)
      .in("short_code", shortCodes),
    admin.from("client_settings")
      .select("ghl_location_id, ghl_api_key, ghl_stage_accepted_id, ghl_stage_invoiced_id, ghl_stage_delivered_id")
      .eq("client_id", clientId)
      .maybeSingle(),
  ]);
  const { data: designs, error: dErr } = designsRes;
  if (dErr) return json({ error: dErr.message }, 500);
  const rows = designs ?? [];

  // Cached statuses to return if we can't reach GHL (portal falls back to these anyway).
  const cached: Record<string, string> = {};
  for (const d of rows) cached[d.short_code] = d.status || "sent";

  const settings = settingsRes.data;
  const locationId = settings?.ghl_location_id || null;
  const apiKey = settings?.ghl_api_key || null;
  // Each configured pipeline-stage id → our fulfillment stage, so a design's status
  // advances from wherever the tenant has moved its opportunity in GHL.
  const stageIdToStatus = stageMapOf(settings);
  if (!locationId || !apiKey) {
    return json({ ok: true, statuses: cached, synced: false, reason: "GHL not configured" });
  }

  const ghlHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 5. Bounded GHL reads, only the ones this call will look at (planGhlReads), plus the orders
  //    snapshot step 8 needs.
  //
  // All three are independent, so they run together. The orders read used to wait until the
  // status writes were done, one more database round trip in series for nothing it depended on;
  // it is only worth making when there are estimate totals to compare it against. At most four
  // CRM requests are in flight (the estimate walk, and the opportunity walk or, with the stage
  // search on, one search per mapped stage), which is well inside GHL's burst limit. ⛔ Do NOT
  // parallelise the PAGES inside any one walk: each stops when it sees a short page (the estimate
  // walk also when the last id it needs turns up), and guessing ahead of that both hammers the
  // API and breaks the `complete` flag that the promote-only fence depends on.
  const plan = planGhlReads(rows, stageIdToStatus);
  const codes = rows.map((d) => d.short_code);
  // The full walk reports itself as one, so settleStatuses never walks the location a second time.
  const readOpportunities = (): Promise<OppRead> => stageSearchOn()
    ? listOpportunitiesAtStages(locationId, ghlHeaders, plan.oppStageIds)
    : listOpportunities(locationId, ghlHeaders).then((r) => ({ ...r, mode: "full walk" as const }));
  const readsStart = performance.now();
  let estMs = 0;
  let oppMs = 0;
  const [estRes, oppRes, ordersRes] = await Promise.all([
    plan.estimateIds.size > 0
      ? listEstimates(locationId, ghlHeaders, plan.estimateIds).finally(() => { estMs = performance.now() - readsStart; })
      : null,
    plan.oppStageIds.length > 0
      ? readOpportunities().finally(() => { oppMs = performance.now() - readsStart; })
      : null,
    plan.estimateIds.size > 0 && codes.length
      ? admin.from("orders").select("id, short_code, total_source, total_cents").eq("client_id", clientId).in("short_code", codes)
        // Best-effort, like the whole of step 8: a failed read means no totals this time.
        .then((res) => res, () => ({ data: null }))
      : null,
  ]);

  // 6. Compute the highest stage per design and collect changes (every fence and floor is in
  //    computeStatuses). When a read this call made was incomplete, promotions only. With the
  //    stage search on, a downgrade that rests on an opportunity missing from every stage list is
  //    confirmed against the full walk first (settleStatuses); that walk's time is counted in `opp`.
  const settled = await settleStatuses(rows, estRes, oppRes, stageIdToStatus, async () => {
    const t0 = performance.now();
    try { return await listOpportunities(locationId, ghlHeaders); } finally { oppMs += performance.now() - t0; }
  });
  const { statuses, updates, dataComplete } = settled;
  if (!dataComplete) console.warn("sync-design-status: incomplete GHL read — promotions only, no downgrades");
  addPhase(st, "est", estMs, estRes ? `${estRes.pages} pages` : "skipped");
  addPhase(st, "opp", oppMs, settled.opp ? `${settled.opp.pages} pages, ${settled.opp.mode}` : "skipped");

  const writesStart = performance.now();
  let writes = 0;

  // 7. Persist only changed rows (tenant + code scoped; service role bypasses the
  //    missing owner-UPDATE RLS policy on designs). A few at a time (WRITE_LANES).
  await eachLimited(updates, WRITE_LANES, async (u) => {
    writes++;
    const { error: upErr } = await admin
      .from("designs")
      .update({ status: u.status, updated_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("short_code", u.short_code);
    if (upErr) { console.warn(`status update failed for ${u.short_code}:`, upErr.message); statuses[u.short_code] = cached[u.short_code] ?? u.status; }
  });

  // 8. Sync order totals from the GHL estimate total (the Orders feature's `orders.total_cents`).
  //    This lived on the wip/orders branch and was clobbered off beta by an unrelated redeploy,
  //    so new orders stopped getting a total. GHL money is in dollars → cents. Never overwrite an
  //    owner-entered total (total_source='manual'); a missing estimate leaves the order untouched
  //    (never zeroed). Best-effort: a total failure must never fail the status sync.
  try {
    const orders = ordersRes?.data;
    if (estRes && orders && orders.length) {
      const estTotalById = estimateTotalsById(estRes.rows);
      const estIdByCode = new Map(rows.map((d) => [d.short_code, d.ghl_estimate_id]));
      const due: { id: string; short_code: string; cents: number }[] = [];
      for (const o of orders) {
        if (o.total_source === "manual") continue;
        const t = estTotalById.get(String(estIdByCode.get(o.short_code) ?? ""));
        if (t == null) continue;
        // Only write when the number actually moved. This function runs on every Designs,
        // Contacts and Inventory load, and it used to re-stamp an unchanged total for
        // every order on every one of them — one serial UPDATE each, all of them no-ops.
        const cents = Math.round(t * 100);
        if (o.total_cents === cents && o.total_source === "ghl") continue;
        due.push({ id: o.id, short_code: o.short_code, cents });
      }
      await eachLimited(due, WRITE_LANES, async (o) => {
        writes++;
        // The manual check above read a snapshot; someone can set a manual total between that
        // read and this write. Re-check it in the UPDATE itself so a manual total is never
        // overwritten. `.or` and not `.neq`: total_source is nullable, and neq skips NULLs.
        const { error: tErr } = await admin
          .from("orders").update({ total_cents: o.cents, total_source: "ghl", updated_at: new Date().toISOString() })
          .eq("id", o.id).eq("client_id", clientId)
          .or("total_source.is.null,total_source.neq.manual");
        if (tErr) console.warn(`order total update failed for ${o.short_code}:`, tErr.message);
      });
    }
  } catch (e) { console.warn("order total sync failed:", (e as Error)?.message); }

  // 9. A lot building whose estimate has been INVOICED is sold.
  //
  //    This is the safety net, not the main path. `send_invoice` claims the unit the moment it
  //    raises the invoice, so a portal-driven sale is already recorded before anyone gets here.
  //    What this catches is an invoice raised SOMEWHERE ELSE: the tenant billed the customer
  //    directly in GoHighLevel, or GHL reports the estimate as paid (mapEstimateStatus maps
  //    both `invoiced` and `paid` to invoiced), or they dragged the opportunity into their
  //    configured invoiced pipeline stage. This function is the only place that learns any of
  //    that, and the Inventory tab already calls it — so this finishes a round trip that
  //    existed rather than adding one.
  //
  //    INVOICED, NOT ACCEPTED. Carolyn 2026-08-08: "we should never be able to mark it sold.
  //    Always needs an invoice." Claiming at `accepted` — which is what this did until
  //    migration 105 — took a building off the market on a handshake, before anything had been
  //    billed, and before the customer had committed to anything we could hold them to.
  //
  //    CLAIM ONLY, NEVER RELEASE: this promotes unsold → sold and does nothing else. A unit
  //    already sold to a DIFFERENT design is left alone — first-committed-wins. And a unit
  //    deliberately RELEASED from this design is skipped, because otherwise unsell_inventory
  //    would be theatre: the design is still `invoiced`, so this would re-sell it seconds later.
  //
  //    Deliberately OUTSIDE the per-design loop above: the delivered fence `continue`s, so a
  //    buyer whose estimate is already delivered would never be reached from inside it.
  //
  //    Still one claim at a time, unlike steps 7 and 8: two designs can name the same unit, and
  //    first-committed-wins means the first design in the list, not whichever request lands first.
  try {
    const claimable = rows.filter((d) =>
      d.inventory_unit_id &&
      STAGE_RANK[statuses[d.short_code] ?? ""] >= STAGE_RANK.invoiced
    );
    for (const d of claimable) {
      writes++;
      const now = new Date().toISOString();
      // The buyer's first name for the "SOLD — Dave" label. contact.name is one flat field in
      // this product; this is the same split submit-estimate uses to title an estimate.
      const full = String((d.contact as Record<string, unknown>)?.name ?? "").trim();
      const firstName = full ? full.split(/\s+/)[0] || null : null;
      // The same compare-and-swap the other two claim paths use: the `sale_state` predicate is
      // re-evaluated against the committed row, so of two concurrent claims exactly one matches
      // a row. `won === null` means somebody else already owns this sale, or it was released —
      // a no-op, not an error.
      const { data: won, error: cErr } = await admin.from("inventory_units").update({
        sale_state: "sold",
        sold_design_short_code: d.short_code,
        sold_first_name: firstName,
        sold_at: now,
        updated_at: now,
        // sold_by stays null on purpose: nobody clicked anything, the CRM did.
      })
        .eq("id", d.inventory_unit_id).eq("client_id", clientId)
        .eq("sale_state", "unsold")
        .or(`sale_released_from.is.null,sale_released_from.neq.${d.short_code}`)
        .select("id, serial").maybeSingle();
      if (cErr) {
        // 23505 = inventory_units_one_sale_per_design: this estimate is already recorded as
        // the buyer of another building. Real data confusion and worth a durable trace —
        // app_errors, not the console, because this project's runtime log stream is not
        // reliably queryable. Shapes only, never customer data.
        await logEdgeError({
          fn: "sync-design-status", req, clientId, code: "inventory_sale_conflict",
          message: `auto-sale claim failed for unit ${d.inventory_unit_id}: ${(cErr as { code?: string }).code ?? ""}`,
        });
        continue;
      }
      if (won) console.log(`inventory #${won.serial} auto-sold from ${d.short_code}`);
    }
  } catch (e) { console.warn("inventory auto-sale failed:", (e as Error)?.message); }
  addPhase(st, "writes", performance.now() - writesStart, `${writes} rows`);

  return json({ ok: true, statuses, synced: true, changed: updates.length });
})));
