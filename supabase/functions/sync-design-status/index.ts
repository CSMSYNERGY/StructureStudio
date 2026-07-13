import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// sync-design-status — refresh each design's fulfillment status FROM GoHighLevel.
//
// Status is a read-only, GHL-derived projection cached on `designs.status`. The portal
// calls this on load with the short_codes it is showing; we recompute the highest reached
// stage per design and persist it. Precedence: delivered > invoiced > accepted > sent.
//
//   Sent      — an estimate exists (StructureStudio sent it). Baseline.
//   Accepted  — the GHL estimate's status is "accepted".
//   Invoiced  — the GHL estimate's status is "invoiced" or "paid" (an invoice was created
//               from the estimate and sent — per the owner's flow, this happens after accept).
//   Delivered — the design's GHL opportunity is at the tenant's configured "delivered"
//               pipeline stage (client_settings.ghl_stage_delivered_id).
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
// NOTE (verify against a live sub-account before prod): the exact estimate `status` values
// (draft/sent/viewed/accepted/declined/invoiced/paid) and the list pagination shapes are
// per GHL's LeadConnector API. The mapping lives in mapEstimateStatus() so it is trivial to
// adjust after inspecting one real response. GHL failures never throw — the design keeps
// its cached status.

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
async function listEstimates(locationId: string, headers: HeadersInit): Promise<any[]> {
  const out: any[] = [];
  const limit = 100;
  for (let offset = 0; offset < 2000; offset += limit) {
    const url = `https://services.leadconnectorhq.com/invoices/estimate/list?altId=${enc(locationId)}&altType=location&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) { console.warn("estimate list failed:", r.status, await safeText(r)); break; }
    const d = await r.json();
    const arr = Array.isArray(d?.estimates) ? d.estimates : (Array.isArray(d?.data) ? d.data : []);
    out.push(...arr);
    if (arr.length < limit) break;
  }
  return out;
}

// GET opportunities for a location (follows GHL's meta.nextPageUrl, capped).
async function listOpportunities(locationId: string, headers: HeadersInit): Promise<any[]> {
  const out: any[] = [];
  let url: string | null =
    `https://services.leadconnectorhq.com/opportunities/search?location_id=${enc(locationId)}&limit=100`;
  for (let i = 0; i < 20 && url; i++) {
    const r = await fetch(url, { headers });
    if (!r.ok) { console.warn("opportunity search failed:", r.status, await safeText(r)); break; }
    const d = await r.json();
    const arr: any[] = Array.isArray(d?.opportunities) ? d.opportunities : [];
    out.push(...arr);
    const next = d?.meta?.nextPageUrl || null;
    url = next && arr.length > 0 ? String(next) : null;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Real user check (the bare anon key passes the gateway but has no user).
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // 2. Resolve the caller's tenant (service role; client_id never from the body).
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: mapping, error: mapErr } = await admin
    .from("client_users")
    .select("client_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!mapping) return json({ error: "No business is linked to this account." }, 403);
  const clientId: string = mapping.client_id;

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const shortCodes: string[] = Array.isArray(payload?.shortCodes)
    ? payload.shortCodes.map((c: unknown) => String(c)).filter(Boolean).slice(0, 500)
    : [];
  if (shortCodes.length === 0) return json({ ok: true, statuses: {}, synced: false });

  // 3. Load the tenant's designs for these codes (service role, tenant-scoped).
  const { data: designs, error: dErr } = await admin
    .from("designs")
    .select("short_code, status, ghl_estimate_id, ghl_opportunity_id")
    .eq("client_id", clientId)
    .in("short_code", shortCodes);
  if (dErr) return json({ error: dErr.message }, 500);

  // Cached statuses to return if we can't reach GHL (portal falls back to these anyway).
  const cached: Record<string, string> = {};
  for (const d of designs ?? []) cached[d.short_code] = d.status || "sent";

  // 4. Tenant GHL creds.
  const { data: settings } = await admin
    .from("client_settings")
    .select("ghl_location_id, ghl_api_key, ghl_stage_delivered_id")
    .eq("client_id", clientId)
    .maybeSingle();
  const locationId = settings?.ghl_location_id || null;
  const apiKey = settings?.ghl_api_key || null;
  const deliveredStageId = settings?.ghl_stage_delivered_id || null;
  if (!locationId || !apiKey) {
    return json({ ok: true, statuses: cached, synced: false, reason: "GHL not configured" });
  }

  const ghlHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 5. Bounded GHL reads. Opportunities only matter if a delivered stage is configured.
  const estimates = await listEstimates(locationId, ghlHeaders);
  const estStatusById = new Map<string, string>();
  for (const e of estimates) {
    const id = String(e?._id ?? e?.id ?? "");
    if (id) estStatusById.set(id, String(e?.status ?? "").toLowerCase());
  }

  const oppStageById = new Map<string, string>();
  if (deliveredStageId) {
    const opps = await listOpportunities(locationId, ghlHeaders);
    for (const o of opps) {
      const id = String(o?.id ?? o?._id ?? "");
      if (id) oppStageById.set(id, String(o?.pipelineStageId ?? o?.pipeline_stage_id ?? ""));
    }
  }

  // 6. Compute the highest stage per design and collect changes.
  const statuses: Record<string, string> = {};
  const updates: { short_code: string; status: string }[] = [];
  for (const d of designs ?? []) {
    let stage: "sent" | "accepted" | "invoiced" | "delivered" = "sent";

    const estStatus = d.ghl_estimate_id ? estStatusById.get(String(d.ghl_estimate_id)) : undefined;
    if (estStatus !== undefined) {
      const mapped = mapEstimateStatus(estStatus);
      if (STAGE_RANK[mapped] > STAGE_RANK[stage]) stage = mapped;
    }

    if (deliveredStageId && d.ghl_opportunity_id) {
      const oppStage = oppStageById.get(String(d.ghl_opportunity_id));
      if (oppStage && oppStage === deliveredStageId) stage = "delivered";
    }

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

  return json({ ok: true, statuses, synced: true, changed: updates.length });
});
