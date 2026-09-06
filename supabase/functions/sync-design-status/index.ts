import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import type { GateTable } from "../_shared/access.ts";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";

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
// header Version: 2021-07-28, Bearer <ghl_api_key>. Two bounded LIST calls per tenant
// (estimates, and opportunities only if a delivered stage is configured) — not per design.
//
// VERIFIED against a live accepted estimate (EST-29, 2026-07-25): the list endpoint
// returns the status in `estimateStatus` (top-level `status` does not exist / is null),
// ids in `_id`, rows under `estimates`, and an `estimateActionHistory` array of
// { estimateStatus, updatedAt } events. Values observed: "accepted". The mapping lives
// in mapEstimateStatus(); GHL failures never throw — the design keeps its cached status.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const STAGE_RANK: Record<string, number> = { sent: 0, accepted: 1, invoiced: 2, delivered: 3 };
const enc = encodeURIComponent;

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return "<no body>"; }
}

// Map a GHL estimate status → our stage (sent/accepted/invoiced). Delivered is decided
// separately from the opportunity pipeline stage. Unknown/pre-accept states stay "sent".
function mapEstimateStatus(raw: unknown): "sent" | "accepted" | "invoiced" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "invoiced" || s === "paid") return "invoiced";
  if (s === "accepted") return "accepted";
  return "sent"; // draft, sent, viewed, declined, or unknown
}

// GET all estimates for a location (offset paginated, capped).
//
// `complete` is the load-bearing half of the return value. A caller that only sees rows cannot
// tell "this location has no estimates" from "GHL refused to tell us" — and treating the second
// as the first is what let a single 401/429/5xx rewrite every design's status down to 'sent'.
// It is false when any page failed at the HTTP level, and also when the pagination cap is hit
// while pages are still coming back full, because the tail we never fetched is indistinguishable
// from data that does not exist.
async function listEstimates(locationId: string, headers: HeadersInit): Promise<{ rows: any[]; complete: boolean }> {
  const out: any[] = [];
  const limit = 100;
  let complete = false;
  for (let offset = 0; offset < 2000; offset += limit) {
    const url = `https://services.leadconnectorhq.com/invoices/estimate/list?altId=${enc(locationId)}&altType=location&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) { console.warn("estimate list failed:", r.status, await safeText(r)); return { rows: out, complete: false }; }
    const d = await r.json();
    const arr = Array.isArray(d?.estimates) ? d.estimates : (Array.isArray(d?.data) ? d.data : []);
    out.push(...arr);
    if (arr.length < limit) { complete = true; break; }   // short page == the real end
  }
  return { rows: out, complete };
}

// GET opportunities for a location (follows GHL's meta.nextPageUrl, capped).
// Same contract as listEstimates: `complete` false means "do not read absence as deletion".
async function listOpportunities(locationId: string, headers: HeadersInit): Promise<{ rows: any[]; complete: boolean }> {
  const out: any[] = [];
  let complete = false;
  let url: string | null =
    `https://services.leadconnectorhq.com/opportunities/search?location_id=${enc(locationId)}&limit=100`;
  for (let i = 0; i < 20 && url; i++) {
    // r / d / next are annotated deliberately. `url` is both an input to the fetch and reassigned
    // from that fetch's own response, so without these TypeScript hits a circular inference
    // (TS7022) and silently degrades this whole function to `any` — which is precisely the state
    // that lets a typo ship. Keep the annotations if you touch this loop.
    const r: Response = await fetch(url, { headers });
    if (!r.ok) { console.warn("opportunity search failed:", r.status, await safeText(r)); return { rows: out, complete: false }; }
    const d: any = await r.json();
    const arr: any[] = Array.isArray(d?.opportunities) ? d.opportunities : [];
    out.push(...arr);
    const next: string | null = d?.meta?.nextPageUrl ? String(d.meta.nextPageUrl) : null;
    url = next && arr.length > 0 ? next : null;
    if (!url) complete = true;   // GHL stopped offering pages == the real end
  }
  return { rows: out, complete };
}

Deno.serve(withErrorLog("sync-design-status", async (req: Request) => {
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
  const admin = createClient(supabaseUrl, serviceKey);
  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "sync" });
  if (!r.ok) return json(r.body, r.status);
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

  // Cached statuses to return if we can't reach GHL (portal falls back to these anyway).
  const cached: Record<string, string> = {};
  for (const d of designs ?? []) cached[d.short_code] = d.status || "sent";

  const settings = settingsRes.data;
  const locationId = settings?.ghl_location_id || null;
  const apiKey = settings?.ghl_api_key || null;
  const acceptedStageId = settings?.ghl_stage_accepted_id || null;
  const invoicedStageId = settings?.ghl_stage_invoiced_id || null;
  const deliveredStageId = settings?.ghl_stage_delivered_id || null;
  // Map each configured pipeline-stage id → our fulfillment stage, so a design's status
  // advances from wherever the tenant has moved its opportunity in GHL.
  const stageIdToStatus = new Map<string, "accepted" | "invoiced" | "delivered">();
  if (acceptedStageId)  stageIdToStatus.set(acceptedStageId, "accepted");
  if (invoicedStageId)  stageIdToStatus.set(invoicedStageId, "invoiced");
  if (deliveredStageId) stageIdToStatus.set(deliveredStageId, "delivered");
  if (!locationId || !apiKey) {
    return json({ ok: true, statuses: cached, synced: false, reason: "GHL not configured" });
  }

  const ghlHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 5. Bounded GHL reads. Opportunities only matter if any pipeline-stage is mapped.
  //
  // The two walks are independent, so they run together — this is the single biggest cost in
  // the function and it used to pay for both in series. Two concurrent requests is well
  // inside GHL's limits. ⛔ Do NOT parallelise the PAGES inside either walk: each one stops
  // when it sees a short page, and guessing offsets ahead of that both hammers the API and
  // breaks the `complete` flag that the promote-only fence below depends on.
  const [estRes, oppRes] = await Promise.all([
    listEstimates(locationId, ghlHeaders),
    stageIdToStatus.size > 0 ? listOpportunities(locationId, ghlHeaders) : null,
  ]);
  const estimates = estRes.rows;
  const estStatusById = new Map<string, string>();
  for (const e of estimates) {
    const id = String(e?._id ?? e?.id ?? "");
    // GHL returns the status as `estimateStatus` (verified live 2026-07-25); the
    // `status` fallback is kept in case older/newer API versions differ.
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

  // Whether absence of a row is allowed to mean "gone". When either GHL read was incomplete we
  // only ever promote: the cached status becomes a floor, so a 401 from a rotated api key, a 429,
  // or a location with more estimates than the pagination cap can no longer rewrite a tenant's
  // fulfilled work back down to 'sent'. This is what the header comment already promised
  // ("GHL failures never throw — the design keeps its cached status"), which previously held only
  // for thrown network errors and not for HTTP-level refusals.
  const dataComplete = estRes.complete && oppsComplete;
  if (!dataComplete) console.warn("sync-design-status: incomplete GHL read — promotions only, no downgrades");

  // 6. Compute the highest stage per design and collect changes.
  const statuses: Record<string, string> = {};
  const updates: { short_code: string; status: string }[] = [];
  for (const d of designs ?? []) {
    // Drafts (migration 063: a browsing lead's silently-saved design) have no estimate and
    // no opportunity — there is nothing in GHL to derive from, and the 'sent' baseline
    // below would otherwise promote every draft the moment the portal loads it. Their
    // status belongs to save_design alone: a real submit is what turns draft into sent.
    // Inventory masters (migration 075: the design behind a physical unit on a sales lot)
    // are the same shape of exception — no GHL estimate exists, the status is owned by
    // portal-settings' save_inventory, and 'sent' here would surface a lot building as a
    // customer estimate on the Designs tab.
    if (d.status === "draft" || d.status === "inventory") { statuses[d.short_code] = d.status; continue; }
    // THE DELIVERED FENCE (migration 091 / SCHEDULING_SCOPE.md): a delivery marked done in
    // the portal sets designs.delivered_at + status='delivered' — a state GHL never reports
    // (no tenant maps ghl_stage_delivered_id), so recomputing here would DOWNGRADE it back
    // to invoiced on the very next sync. Locally-delivered is terminal: skip the recompute.
    if (d.delivered_at) { statuses[d.short_code] = "delivered"; continue; }
    // THE SS FENCE (migrations 121/122/124): a StructureStudio-issued quote has NO GHL
    // estimate, and its status is written locally — customer-accept sets 'accepted', the
    // SS invoice path sets 'invoiced'. The 'sent' baseline below would downgrade both on
    // the very next portal load. Keyed on BOTH conditions so a design quoted through GHL
    // before the tenant flipped the switch (it has a ghl_estimate_id) keeps GHL-derived
    // sync. Trade-off, deliberate: SS designs give up opportunity-stage promotion —
    // acceptance lives on our quote page, not in the CRM pipeline.
    if (!d.ghl_estimate_id && d.ss_quote_number) { statuses[d.short_code] = d.status || "sent"; continue; }
    // The baseline is 'sent' only when the GHL data is trustworthy enough to justify a downgrade.
    // Otherwise start from what we already believe, so the computation below can raise the status
    // but never lower it (see dataComplete above).
    const cachedStage = (d.status && STAGE_RANK[d.status as keyof typeof STAGE_RANK] !== undefined)
      ? (d.status as "sent" | "accepted" | "invoiced" | "delivered")
      : "sent";
    let stage: "sent" | "accepted" | "invoiced" | "delivered" = dataComplete ? "sent" : cachedStage;

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

    // THE ACCEPTED FLOOR (migration 124, mirror of the delivered fence): an in-app
    // signature stamps designs.accepted_at — a state GHL may never report. Belt-and-braces
    // under the SS fence above (which already skips pure-SS designs): this one also holds
    // for a design that has BOTH a GHL estimate and a local signature. Floor, not pin —
    // invoiced/delivered promotions still pass.
    if (d.accepted_at && STAGE_RANK[stage] < STAGE_RANK.accepted) stage = "accepted";

    statuses[d.short_code] = stage;
    if (stage !== (d.status || "sent")) updates.push({ short_code: d.short_code, status: stage });
  }

  // 7. Persist only changed rows (tenant + code scoped; service role bypasses the
  //    missing owner-UPDATE RLS policy on designs).
  for (const u of updates) {
    const { error: upErr } = await admin
      .from("designs")
      .update({ status: u.status, updated_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("short_code", u.short_code);
    if (upErr) { console.warn(`status update failed for ${u.short_code}:`, upErr.message); statuses[u.short_code] = cached[u.short_code] ?? u.status; }
  }

  // 8. Sync order totals from the GHL estimate total (the Orders feature's `orders.total_cents`).
  //    This lived on the wip/orders branch and was clobbered off beta by an unrelated redeploy,
  //    so new orders stopped getting a total. GHL money is in dollars → cents. Never overwrite an
  //    owner-entered total (total_source='manual'); a missing estimate leaves the order untouched
  //    (never zeroed). Best-effort: a total failure must never fail the status sync.
  try {
    const codes = (designs ?? []).map((d) => d.short_code);
    if (codes.length) {
      const { data: orders } = await admin
        .from("orders").select("id, short_code, total_source, total_cents").eq("client_id", clientId).in("short_code", codes);
      if (orders && orders.length) {
        const estTotalById = new Map<string, number>();
        for (const e of estimates) {
          const id = String(e?._id ?? e?.id ?? "");
          const t = Number(e?.total ?? e?.totalamountInUSD);
          if (id && Number.isFinite(t)) estTotalById.set(id, t);
        }
        const estIdByCode = new Map((designs ?? []).map((d) => [d.short_code, d.ghl_estimate_id]));
        for (const o of orders) {
          if (o.total_source === "manual") continue;
          const t = estTotalById.get(String(estIdByCode.get(o.short_code) ?? ""));
          if (t == null) continue;
          // Only write when the number actually moved. This function runs on every Designs,
          // Contacts and Inventory load, and it used to re-stamp an unchanged total for
          // every order on every one of them — one serial UPDATE each, all of them no-ops.
          const cents = Math.round(t * 100);
          if (o.total_cents === cents && o.total_source === "ghl") continue;
          const { error: tErr } = await admin
            .from("orders").update({ total_cents: cents, total_source: "ghl", updated_at: new Date().toISOString() })
            .eq("id", o.id).eq("client_id", clientId);
          if (tErr) console.warn(`order total update failed for ${o.short_code}:`, tErr.message);
        }
      }
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
  try {
    const claimable = (designs ?? []).filter((d) =>
      d.inventory_unit_id &&
      STAGE_RANK[(statuses[d.short_code] ?? "") as keyof typeof STAGE_RANK] >= STAGE_RANK.invoiced
    );
    for (const d of claimable) {
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

  return json({ ok: true, statuses, synced: true, changed: updates.length });
}));
