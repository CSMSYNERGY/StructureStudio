import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
// The delivery address the customer already typed into the designer, plus the v1 territory
// rule. Shared + unit-tested because a miss here is silent: it yields a stop with no
// destination, which is the state every stop was in before add_stop started reading it.
import { addressFrom, territoryFor } from "../_shared/contactAddress.ts";
import {
  deriveLifecycle,
  effectiveLifecycle,
  type Lifecycle,
  LIFECYCLE_LABEL,
  LIFECYCLE_RANK,
  type StageKind,
} from "../_shared/inventoryLifecycle.ts";
import type { GateTable } from "../_shared/access.ts";

// Build Schedule + Delivery Schedule (Load Planner) + Repairs backend.
// Spec: SCHEDULING_SCOPE.md (mockup approved by Carolyn 2026-08-04).
//
// Auth: resolveTenant — JWT → auth.getUser() → client_users; clientId is NEVER read from
// the body (operators use targetClientId + app_operators, with can_write gating).
//
// Action gating: the GATES table below, enforced by resolveTenant BEFORE dispatch. (This
// used to be three role tiers — READ/STAFF/ADMIN — which migration 100 replaced; see the
// table's own comment for why a table beats a check per branch.)
//
// Invariants owned here (not the browser):
//   * A load cannot go out/delivered while any stop's build job stage isn't kind='done' —
//     unless an OWNER/ADMIN overrides with a required reason (audit-logged, stamped on the
//     load, rendered as a permanent chip). Staff single-stop delivery has NO override path.
//     ⚠️ That admin check is made HERE, explicitly (see mark_load_out), and must stay: the
//     gate only requires delivery_schedule:'edit', which the DRIVER preset grants. Before
//     migration 100 the ADMIN tier made this true for free; it no longer does, and decision
//     11 of SCHEDULING_SCOPE.md is that crew cannot override the built-before-delivered rule.
//   * A building physically wider than the load's max_width_ft is REJECTED — no override;
//     the remedy is a different truck or fixed specs.
//   * Order build jobs mint their shop serial via take_next_serial() LAST, after all
//     validation — a rejected payload must not burn a number (075's rule).
//   * Marking an order's stop delivered sets designs.status='delivered' + delivered_at
//     (the fence in sync-design-status ships with the Delivery tab UI — Phase 4).

// WHAT EACH ACTION REQUIRES (migration 100) — see _shared/access.ts. resolveTenant checks
// this before dispatch and refuses any action missing from it, so the three schedule areas
// are enforced by a table rather than by 32 remembered checks.
//
// This replaces READ_ACTIONS/STAFF_ACTIONS. Those said "any linked role may move a job or
// mark a stop delivered", which was the only thing available before per-person access
// existed; now a crew leader gets build_schedule:'edit' from their preset and a sales rep
// does not, which is what Carolyn actually asked for.
const GATES: GateTable = {
  // ── Build schedule ───────────────────────────────────────────────────────
  build_board:  { area: "build_schedule", level: "view" },
  // The history line on an expanded card. A read of who did what to one job — no wider
  // than the board itself, which already names assignees and crews.
  job_activity: { area: "build_schedule", level: "view" },
  // "Is this building already scheduled?" — what the Designs and Inventory rows need to
  // decide between offering "Add to build schedule" and showing the stage it's already in.
  // Deliberately its own tiny action rather than making those tabs fetch the whole board.
  schedule_links: { area: "build_schedule", level: "view" },
  move_job:     { area: "build_schedule", level: "edit" },
  add_note:     { area: "build_schedule", level: "edit" },
  save_stages:  { area: "build_schedule", level: "edit" },
  // create_job burns a number from the shared take_next_serial() sequence, so this level
  // also spends an Inventory-visible resource. Deliberately still build_schedule alone:
  // it is the board's own "add to schedule" button, and requiring inventory:edit would stop
  // a crew leader scheduling a build.
  create_job:   { area: "build_schedule", level: "edit" },
  update_job:   { area: "build_schedule", level: "edit" },
  complete_job: { area: "build_schedule", level: "edit" },
  delete_job:   { area: "build_schedule", level: "edit" },

  // ── Delivery schedule ────────────────────────────────────────────────────
  loads:        { area: "delivery_schedule", level: "view" },
  // The "to be loaded" pool is a cross-area QUERY (build jobs + sold units + open repairs),
  // but it exists to fill the delivery board and is gated as that board's read.
  pool:         { area: "delivery_schedule", level: "view" },
  // Returns the driver roster (names + ids) — team-shaped data, but a dispatcher cannot
  // assign a load without it, and it is this tenant's own staff list.
  list_drivers: { area: "delivery_schedule", level: "view" },
  create_load:  { area: "delivery_schedule", level: "edit" },
  update_load:  { area: "delivery_schedule", level: "edit" },
  delete_load:  { area: "delivery_schedule", level: "edit" },
  add_stop:     { area: "delivery_schedule", level: "edit" },
  update_stop:  { area: "delivery_schedule", level: "edit" },
  remove_stop:  { area: "delivery_schedule", level: "edit" },
  reorder_stops: { area: "delivery_schedule", level: "edit" },
  // These three write designs.status/delivered_at, and the sync-design-status fence makes
  // 'delivered' effectively permanent — a delivery right is a designs right in practice.
  mark_load_out:       { area: "delivery_schedule", level: "edit" },
  mark_load_delivered: { area: "delivery_schedule", level: "edit" },
  mark_stop_delivered: { area: "delivery_schedule", level: "edit" },

  // ── Repairs ──────────────────────────────────────────────────────────────
  list_repairs:  { area: "repairs", level: "view" },
  repair_photos: { area: "repairs", level: "view" },
  create_repair: { area: "repairs", level: "edit" },
  update_repair: { area: "repairs", level: "edit" },
  // Cascades into build_jobs and delivery_stops via FK, so this deletes rows owned by two
  // other areas. Left on repairs:edit because the repair IS the parent record and the
  // cascade is the point; noted here so the blast radius is not a surprise later.
  delete_repair: { area: "repairs", level: "edit" },
  upload_repair_photo: { area: "repairs", level: "edit" },
  delete_repair_photo: { area: "repairs", level: "edit" },

  // ── Team (Settings → Team cards) ─────────────────────────────────────────
  save_territory: { area: "settings_team", level: "edit" },
  save_crew:      { area: "settings_team", level: "edit" },
  save_driver:    { area: "settings_team", level: "edit" },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const dateStr = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Over 8'6" is a wide load on the highway; computed from real dimensions, never typed.
const WIDE_FT = 8.5;

const DEFAULT_STAGES = [
  { name: "Queue", color: "#94A3B8", kind: "queue", sort_order: 0 },
  { name: "In Build", color: "#F59E0B", kind: "active", sort_order: 1 },
  { name: "Built", color: "#22C55E", kind: "done", sort_order: 2 },
];

// "10×16" / "10x16" / "10 X 16" → { widthFt, lengthFt }. Sheds are quoted width-first.
function parseSize(label: unknown): { widthFt: number | null; lengthFt: number | null } {
  const m = String(label ?? "").match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return { widthFt: null, lengthFt: null };
  return { widthFt: Number(m[1]), lengthFt: Number(m[2]) };
}
const titleCase = (s: unknown) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
// Live designs store selections as { style, size, roofType, roofColor, ... } — verified
// against production data 2026-08-04. (buildingStyle/buildingSize appear only in the
// submit-estimate webhook payload, never in the stored row — reading those keys here is
// why early build cards had no building label or dimensions.) Keep them as fallbacks.
// deno-lint-ignore no-explicit-any
const selStyle = (sel: any) => sel?.style ?? sel?.buildingStyle ?? "";
// deno-lint-ignore no-explicit-any
const selSize = (sel: any) => sel?.size ?? sel?.buildingSize ?? "";
function buildingLabelFrom(selections: Record<string, unknown> | null | undefined): string {
  const style = titleCase(selStyle(selections));
  const size = String(selSize(selections));
  return [style, size].filter(Boolean).join(" ").trim();
}
// Roof + colors snapshot for the building-first card, hexes resolved from the tenant's
// colors catalog (label match, case-insensitive) so the card renders true swatches.
// deno-lint-ignore no-explicit-any
async function appearanceFrom(admin: any, clientId: string, selections: any, paintColors: any) {
  const sel = selections ?? {};
  const paint = paintColors ?? {};
  const out: Record<string, string | null> = {
    roof_type: sel.roofType ? String(sel.roofType) : null,
    roof_color: sel.roofColor ? String(sel.roofColor) : null,
    body_color: paint.body ? String(paint.body) : null,
    trim_color: paint.trim ? String(paint.trim) : null,
    roof_color_hex: null,
    body_color_hex: null,
    trim_color_hex: null,
  };
  const wanted = [out.roof_color, out.body_color, out.trim_color].filter(Boolean) as string[];
  if (wanted.length) {
    const { data: colors } = await admin.from("colors").select("label, hex").eq("client_id", clientId).limit(500);
    const hexOf: Record<string, string> = {};
    for (const c of colors ?? []) if (c.label && c.hex) hexOf[String(c.label).trim().toLowerCase()] = c.hex;
    const lookup = (name: string | null) => name ? (hexOf[name.trim().toLowerCase()] ?? null) : null;
    out.roof_color_hex = lookup(out.roof_color);
    out.body_color_hex = lookup(out.body_color);
    out.trim_color_hex = lookup(out.trim_color);
  }
  return out;
}

Deno.serve(withErrorLog("portal-schedule", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const r = await resolveTenant(req, admin, {
    gates: GATES,
    readActions: new Set(),
    defaultAction: "build_board",
  });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, audit, role } = r.ctx;
  // Owner/admin — or an operator, whose write capability resolveTenant already checked
  // against app_operators.can_write. The ONE thing this is used for is the
  // built-before-delivered override (decision 11): the per-area gate cannot express it,
  // because delivery_schedule:'edit' is exactly what a Driver is meant to have.
  const isAdminRole = role === "owner" || role === "admin" || role === "operator";
  if (r.ctx.operator) audit(`operator_schedule_${action}`).catch(() => {});

  // ── Shared helpers (all scoped to the resolved tenant) ─────────────────────

  const act = async (
    subject: "build_job" | "load" | "stop" | "repair",
    subjectId: string,
    actionName: string,
    extra: { from?: string | null; to?: string | null; detail?: string | null } = {},
  ) => {
    await admin.from("schedule_activity").insert({
      client_id: clientId,
      subject,
      subject_id: subjectId,
      user_id: userId,
      action: actionName,
      from_stage_id: extra.from ?? null,
      to_stage_id: extra.to ?? null,
      detail: extra.detail ?? null,
    });
  };

  // deno-lint-ignore no-explicit-any
  const requireRow = async (table: string, id: unknown, label: string): Promise<any> => {
    if (!isUuid(id)) throw new Error(`Invalid ${label} id.`);
    const { data, error } = await admin.from(table).select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`${label} not found.`);
    return data;
  };

  // Where a set of inventory units are on the build ladder. The ladder is a PROJECTION, not a
  // stored column (see _shared/inventoryLifecycle.ts for why), so anything that wants to show
  // it gathers the same facts: the unit's approval, its one build job, that job's stage KIND —
  // never the tenant-editable stage NAME — and its delivery stops.
  const lifecycleByUnit = async (unitIds: string[]) => {
    if (!unitIds.length) return {} as Record<string, { lifecycle: Lifecycle; source: "auto" | "manual" }>;
    const [uRes, jRes, sRes] = await Promise.all([
      admin.from("inventory_units")
        .select("id, accepted_at, sold_design_short_code, lifecycle_manual, lifecycle_manual_basis")
        .eq("client_id", clientId).in("id", unitIds),
      admin.from("build_jobs").select("inventory_unit_id, stage_id, due_date, completed_at")
        .eq("client_id", clientId).in("inventory_unit_id", unitIds),
      admin.from("delivery_stops").select("inventory_unit_id, design_short_code, delivered_at")
        .eq("client_id", clientId).in("inventory_unit_id", unitIds),
    ]);
    const stageIds = [...new Set((jRes.data ?? []).map((j) => j.stage_id).filter(Boolean))];
    const { data: stageRows } = stageIds.length
      ? await admin.from("schedule_stages").select("id, kind").eq("client_id", clientId).in("id", stageIds)
      : { data: [] };
    const kindById = Object.fromEntries((stageRows ?? []).map((s) => [s.id, s.kind]));
    const jobByUnit = Object.fromEntries((jRes.data ?? []).map((j) => [j.inventory_unit_id, j]));
    const stopsByUnit: Record<string, { designShortCode: string | null; deliveredAt: string | null }[]> = {};
    for (const s of sRes.data ?? []) {
      (stopsByUnit[s.inventory_unit_id] ??= []).push({
        designShortCode: s.design_short_code ?? null,
        deliveredAt: s.delivered_at ?? null,
      });
    }
    const out: Record<string, { lifecycle: Lifecycle; source: "auto" | "manual" }> = {};
    for (const u of uRes.data ?? []) {
      const j = jobByUnit[u.id];
      const derived = deriveLifecycle({
        acceptedAt: u.accepted_at ?? null,
        soldDesignShortCode: u.sold_design_short_code ?? null,
        job: j
          ? {
            stageKind: (kindById[j.stage_id] ?? null) as StageKind | null,
            dueDate: j.due_date ?? null,
            completedAt: j.completed_at ?? null,
          }
          : null,
        stops: stopsByUnit[u.id] ?? [],
      });
      const eff = effectiveLifecycle(u, derived);
      out[u.id] = { lifecycle: eff.lifecycle, source: eff.source };
    }
    return out;
  };

  const getStages = async () => {
    const { data, error } = await admin
      .from("schedule_stages").select("*").eq("client_id", clientId).order("sort_order");
    if (error) throw error;
    if (data && data.length) return data;
    const { data: seeded, error: seedErr } = await admin
      .from("schedule_stages")
      .insert(DEFAULT_STAGES.map((s) => ({ ...s, client_id: clientId })))
      .select("*");
    if (seedErr) throw seedErr;
    return (seeded ?? []).sort((a, b) => a.sort_order - b.sort_order);
  };

  // Team names for rendering (assignees, drivers, activity). Names live on
  // client_users.full_name — there is NO user_profiles table (migration 060 put the
  // columns on client_users); the old lookup here silently returned nothing, which is
  // why drivers and team pickers showed blank names.
  const getTeam = async () => {
    const { data: members, error } = await admin
      .from("client_users").select("user_id, role, full_name").eq("client_id", clientId);
    if (error) throw error;
    return (members ?? []).map((m) => ({ userId: m.user_id, role: m.role || "user", name: m.full_name || "" }));
  };

  const getDrivers = async () => {
    const { data, error } = await admin
      .from("driver_profiles").select("*").eq("client_id", clientId).eq("active", true);
    if (error) throw error;
    return data ?? [];
  };

  const getTerritories = async () => {
    const { data, error } = await admin
      .from("delivery_territories").select("*").eq("client_id", clientId).order("sort_order");
    if (error) throw error;
    return data ?? [];
  };

  // Build crews (094) — the scheduling unit on the build calendar.
  const getCrews = async () => {
    const { data, error } = await admin
      .from("build_crews").select("*").eq("client_id", clientId).order("sort_order");
    if (error) throw error;
    return data ?? [];
  };

  // Stops whose building is not built yet (the built-before-delivered check).
  //
  // TWO ways a stop can be unbuilt, and it used to catch only the first:
  //   * its linked build job is not in a kind='done' stage;
  //   * it has NO build job but its inventory unit is below `built` on the ladder. That case
  //     sailed straight through, because the query filtered to stops with a build_job_id. It
  //     matters more now than it did: a unit can be sold before it is finished, and the
  //     buyer's delivery can be scheduled the same day — so "not built yet" is a live state
  //     for a stop with no job, not a theoretical one.
  // deno-lint-ignore no-explicit-any
  const unbuiltStops = async (loadId: string): Promise<any[]> => {
    const { data: allStops, error } = await admin
      .from("delivery_stops").select("id, stop_order, serial, customer_name, build_job_id, inventory_unit_id")
      .eq("client_id", clientId).eq("load_id", loadId);
    if (error) throw error;
    if (!allStops?.length) return [];
    const stops = allStops.filter((s) => s.build_job_id);
    const jobIds = stops.map((s) => s.build_job_id);
    const { data: jobs, error: jErr } = jobIds.length
      ? await admin.from("build_jobs").select("id, stage_id, due_date").in("id", jobIds)
      : { data: [], error: null };
    if (jErr) throw jErr;
    const stageIds = [...new Set((jobs ?? []).map((j) => j.stage_id))];
    const { data: stages, error: sErr } = stageIds.length
      ? await admin.from("schedule_stages").select("id, kind, name").in("id", stageIds)
      : { data: [], error: null };
    if (sErr) throw sErr;
    const kindOf = Object.fromEntries((stages ?? []).map((s) => [s.id, s]));
    const jobById = Object.fromEntries((jobs ?? []).map((j) => [j.id, j]));
    const out = stops.filter((s) => {
      const j = jobById[s.build_job_id];
      return !j || kindOf[j.stage_id]?.kind !== "done";
    }).map((s) => ({
      stopId: s.id,
      stopOrder: s.stop_order,
      serial: s.serial,
      customerName: s.customer_name,
      buildJobId: s.build_job_id,
      buildStage: kindOf[jobById[s.build_job_id]?.stage_id]?.name ?? null,
      buildDue: jobById[s.build_job_id]?.due_date ?? null,
    }));

    const jobless = allStops.filter((s) => !s.build_job_id && s.inventory_unit_id);
    if (jobless.length) {
      const byUnit = await lifecycleByUnit([...new Set(jobless.map((s) => s.inventory_unit_id))] as string[]);
      for (const s of jobless) {
        const lc = byUnit[s.inventory_unit_id]?.lifecycle;
        if (lc && LIFECYCLE_RANK[lc] < LIFECYCLE_RANK.built) {
          out.push({
            stopId: s.id, stopOrder: s.stop_order, serial: s.serial,
            customerName: s.customer_name, buildJobId: null,
            buildStage: LIFECYCLE_LABEL[lc], buildDue: null,
          });
        }
      }
    }
    return out;
  };

  const recomputeWide = async (loadId: string) => {
    const { data: stops } = await admin
      .from("delivery_stops").select("width_ft").eq("client_id", clientId).eq("load_id", loadId);
    const isWide = (stops ?? []).some((s) => Number(s.width_ft) > WIDE_FT);
    const patch: Record<string, unknown> = { is_wide: isWide, updated_at: new Date().toISOString() };
    // The permit follows the load. Decision 7: wide-load state is COMPUTED from real
    // dimensions, never hand-entered — so the permit requirement it implies shouldn't be
    // hand-entered either. Only ever nudges the default: a permit already on file is never
    // downgraded, and an operator who set it deliberately keeps their value.
    const { data: cur } = await admin.from("delivery_loads").select("permit_status")
      .eq("id", loadId).eq("client_id", clientId).maybeSingle();
    if (isWide && cur?.permit_status === "not_needed") patch.permit_status = "needed";
    if (!isWide && cur?.permit_status === "needed") patch.permit_status = "not_needed";
    await admin.from("delivery_loads").update(patch).eq("id", loadId).eq("client_id", clientId);
    return isWide;
  };

  // Delivered write-back: the customer's design becomes delivered — for ORDER stops and
  // for a sold unit's SALE stop (which carries the buyer's design code). Never touches
  // draft/inventory master rows (the status filter below); the sync-design-status
  // delivered_at fence keeps GHL from downgrading it.
  // deno-lint-ignore no-explicit-any
  const writeBackDelivered = async (stop: any) => {
    if ((stop.source !== "order" && stop.source !== "inventory") || !stop.design_short_code) return;
    await admin.from("designs")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("short_code", stop.design_short_code)
      .in("status", ["sent", "accepted", "invoiced", "delivered"]);
  };

  try {
    // ═══════════════ READS ═══════════════

    if (action === "build_board") {
      const stages = await getStages();
      const { data: jobs, error } = await admin
        .from("build_jobs").select("*").eq("client_id", clientId).order("position");
      if (error) throw error;
      const jobIds = (jobs ?? []).map((j) => j.id);
      // Which load each building rides (the cross-link chip on build cards).
      let stopByJob: Record<string, unknown> = {};
      if (jobIds.length) {
        const { data: stops } = await admin
          .from("delivery_stops").select("build_job_id, load_id, delivered_at")
          .eq("client_id", clientId).in("build_job_id", jobIds);
        const loadIds = [...new Set((stops ?? []).map((s) => s.load_id))];
        const { data: loads } = loadIds.length
          ? await admin.from("delivery_loads").select("id, load_no, load_date, status").in("id", loadIds)
          : { data: [] };
        const loadById = Object.fromEntries((loads ?? []).map((l) => [l.id, l]));
        stopByJob = Object.fromEntries((stops ?? []).map((s) => [s.build_job_id, {
          loadId: s.load_id, deliveredAt: s.delivered_at, load: loadById[s.load_id] ?? null,
        }]));
      }

      // Unscheduled tray: sold orders / APPROVED units / open repairs with no job yet.
      const haveDesign = new Set((jobs ?? []).map((j) => j.design_short_code).filter(Boolean));
      const haveUnit = new Set((jobs ?? []).map((j) => j.inventory_unit_id).filter(Boolean));
      const haveRepair = new Set((jobs ?? []).map((j) => j.repair_id).filter(Boolean));
      // `.is("inventory_unit_id", null)` is the ROUTING RULE, not a tidy-up: an estimate
      // quoted from a lot building must never appear here as a new build to schedule. The
      // building already exists (or is already being built as a spec unit), so a second job
      // would have the shop make it twice. create_job enforces the same rule server-side.
      const { data: soldDesigns } = await admin
        .from("designs").select("short_code, contact, selections, status")
        .eq("client_id", clientId).in("status", ["accepted", "invoiced"]).is("inventory_unit_id", null)
        .limit(500);
      // APPROVED, not "available" (migration 102). Two changes in one line:
      //   * a unit only becomes queue-eligible when somebody accepts the request — a building
      //     nobody has said yes to should not be sitting in the shop's tray.
      //   * sale state is deliberately NOT filtered. A building can be sold before it is
      //     built, and selling it does not build it: dropping sold units out of the tray
      //     (which the old status='available' test did) would quietly stop them being made.
      const { data: units } = await admin
        .from("inventory_units").select("id, serial, design_short_code, sale_state, sold_first_name")
        .eq("client_id", clientId).not("accepted_at", "is", null).limit(500);
      // Tray items read building-first like the cards, so inventory units need their
      // master design's style+size label.
      const masterCodes = [...new Set((units ?? []).map((u) => u.design_short_code).filter(Boolean))];
      const { data: masters } = masterCodes.length
        ? await admin.from("designs").select("short_code, selections").eq("client_id", clientId).in("short_code", masterCodes)
        : { data: [] };
      const masterLabel = Object.fromEntries((masters ?? []).map((m) => [m.short_code, buildingLabelFrom(m.selections as Record<string, unknown>)]));
      const { data: openRepairs } = await admin
        .from("repairs").select("id, repair_no, customer_name, description, serial, status")
        .eq("client_id", clientId).in("status", ["requested", "approved", "in_progress"]).limit(500);
      const tray = {
        orders: (soldDesigns ?? []).filter((d) => !haveDesign.has(d.short_code)).map((d) => ({
          designShortCode: d.short_code,
          customerName: (d.contact as Record<string, unknown>)?.name ?? "",
          buildingLabel: buildingLabelFrom(d.selections as Record<string, unknown>),
          status: d.status,
        })),
        inventory: (units ?? []).filter((u) => !haveUnit.has(u.id)).map((u) => ({
          inventoryUnitId: u.id, serial: u.serial, designShortCode: u.design_short_code,
          buildingLabel: masterLabel[u.design_short_code ?? ""] ?? "",
          // The shop needs to know a spec build is already spoken for — it is still theirs to
          // build, but it is not stock any more.
          sold: u.sale_state === "sold", soldFirstName: u.sold_first_name ?? null,
        })),
        repairs: (openRepairs ?? []).filter((rp) => !haveRepair.has(rp.id)).map((rp) => ({
          repairId: rp.id, repairNo: rp.repair_no, customerName: rp.customer_name,
          description: rp.description, serial: rp.serial, status: rp.status,
        })),
      };
      return json({ stages, jobs: jobs ?? [], stopByJob, tray, team: await getTeam(), crews: await getCrews() });
    }

    if (action === "loads") {
      const { data: loads, error } = await admin
        .from("delivery_loads").select("*").eq("client_id", clientId)
        .order("load_date", { ascending: true, nullsFirst: false }).limit(500);
      if (error) throw error;
      const loadIds = (loads ?? []).map((l) => l.id);
      const { data: stops } = loadIds.length
        ? await admin.from("delivery_stops").select("*").eq("client_id", clientId)
          .in("load_id", loadIds).order("stop_order")
        : { data: [] };
      // Build status per stop (for the cross-link chips), one round trip.
      const jobIds = [...new Set((stops ?? []).map((s) => s.build_job_id).filter(Boolean))];
      const { data: jobs } = jobIds.length
        ? await admin.from("build_jobs").select("id, stage_id, due_date, completed_at").in("id", jobIds)
        : { data: [] };
      const stageIds = [...new Set((jobs ?? []).map((j) => j.stage_id))];
      const { data: stages } = stageIds.length
        ? await admin.from("schedule_stages").select("id, name, kind").in("id", stageIds)
        : { data: [] };
      const stageById = Object.fromEntries((stages ?? []).map((s) => [s.id, s]));
      const buildByJob = Object.fromEntries((jobs ?? []).map((j) => [j.id, {
        stage: stageById[j.stage_id]?.name ?? null,
        kind: stageById[j.stage_id]?.kind ?? null,
        dueDate: j.due_date,
        completedAt: j.completed_at,
      }]));
      // Where each inventory unit on these loads actually IS. The board used to hard-code
      // "On lot — ready" for every inventory stop, which was a guess: it is true for a sold
      // building being collected from the lot and false for one that has not been built yet.
      // A stop whose unit is below `built` must not look ready to load.
      const unitIds = [...new Set((stops ?? []).map((s) => s.inventory_unit_id).filter(Boolean))];
      const unitLifecycle = unitIds.length
        ? await lifecycleByUnit(unitIds as string[])
        : {};
      return json({
        loads: loads ?? [],
        stops: stops ?? [],
        buildByJob,
        unitLifecycle,
        drivers: await getDrivers(),
        territories: await getTerritories(),
        team: await getTeam(),
      });
    }

    if (action === "pool") {
      // To-be-loaded — a QUERY, never a table (no double bookkeeping). Carolyn 2026-08-04:
      // "every building that is in the build schedule should also show in the delivery
      // schedule" — so EVERY non-repair build job without a stop is here (an inventory
      // spec build gets hauled shop → sales lot like any other building; repairs appear
      // once, via the repairs section, whether or not they have shop work).
      // Plus: sold units without their SALE delivery (a unit legitimately rides twice —
      // shop → lot while available, lot → customer once sold; the sale stop is the one
      // carrying the buyer's design code), and open repairs without a stop.
      const { data: stops } = await admin
        .from("delivery_stops").select("build_job_id, inventory_unit_id, repair_id, design_short_code, delivered_at, territory_id, dest_city, dest_zip")
        .eq("client_id", clientId);
      const stopJob = new Set((stops ?? []).map((s) => s.build_job_id).filter(Boolean));
      const stopRepair = new Set((stops ?? []).map((s) => s.repair_id).filter(Boolean));
      // ALSO exclude by design code. `delivery_stops_one_per_design` is a unique index, so
      // a design that already has a stop can never get a second one — but a stop created
      // from a bare design code (the path for tenants who skip the build board) carries no
      // build_job_id, so filtering on that alone left the building sitting in the pool with
      // an "Add to load…" control that 409'd every single time it was used.
      const stopDesign = new Set((stops ?? []).map((s) => s.design_short_code).filter(Boolean));

      // Where this tenant has delivered before, so a pool row can be grouped by corridor
      // BEFORE it becomes a stop. Same rule add_stop applies on insert — kept in step by
      // being the same two lookups, so the group a building sits in is the territory it
      // will actually get.
      const terrByZip: Record<string, string> = {};
      const terrByCity: Record<string, string> = {};
      for (const s of stops ?? []) {
        if (!s.territory_id) continue;
        if (s.dest_zip && !terrByZip[s.dest_zip]) terrByZip[s.dest_zip] = s.territory_id;
        const c = s.dest_city ? String(s.dest_city).trim().toLowerCase() : "";
        if (c && !terrByCity[c]) terrByCity[c] = s.territory_id;
      }

      const stagesAll = await getStages();
      const stageById = Object.fromEntries(stagesAll.map((s) => [s.id, s]));
      const { data: jobsAll } = await admin
        .from("build_jobs").select("*").eq("client_id", clientId).neq("source", "repair").limit(500);
      const poolJobRows = (jobsAll ?? []).filter((j) =>
        !stopJob.has(j.id) && !(j.design_short_code && stopDesign.has(j.design_short_code)));
      // One query for every destination, not one per row.
      const poolCodes = [...new Set(poolJobRows.map((j) => j.design_short_code).filter(Boolean))];
      const { data: poolDesigns } = poolCodes.length
        ? await admin.from("designs").select("short_code, contact").eq("client_id", clientId).in("short_code", poolCodes)
        : { data: [] };
      const contactByCode = Object.fromEntries((poolDesigns ?? []).map((d) => [d.short_code, d.contact]));
      const jobs = poolJobRows.map((j) => {
        const addr = addressFrom(contactByCode[j.design_short_code ?? ""]);
        const territoryId = territoryFor(addr, terrByZip, terrByCity);
        return {
          buildJobId: j.id, source: j.source, serial: j.serial, customerName: j.customer_name,
          title: j.title, buildingLabel: j.building_label, widthFt: j.width_ft, lengthFt: j.length_ft,
          designShortCode: j.design_short_code, inventoryUnitId: j.inventory_unit_id,
          buildStage: stageById[j.stage_id]?.name ?? null,
          buildKind: stageById[j.stage_id]?.kind ?? null,
          dueDate: j.due_date, completedAt: j.completed_at,
          wide: Number(j.width_ft) > WIDE_FT,
          destCity: addr.city, destState: addr.state, destZip: addr.zip,
          territoryId,
          // What the pool is SORTED by, and what the "Ready" column shows: a finished
          // building is ready now, an unfinished one is ready on its build date.
          readyDate: j.completed_at ? String(j.completed_at).slice(0, 10) : (j.due_date ?? null),
        };
      });
      // The header has always claimed "sorted by when each building is ready" and nothing
      // sorted it. Undated rows last — they cannot be planned around.
      jobs.sort((a, b) => String(a.readyDate ?? "9999-12-31").localeCompare(String(b.readyDate ?? "9999-12-31")));

      const { data: sold } = await admin
        .from("inventory_units")
        .select("id, serial, design_short_code, sold_design_short_code, sold_first_name, location_id, sale_state")
        .eq("client_id", clientId).eq("sale_state", "sold").limit(500);
      const { data: locs } = await admin
        .from("builder_locations").select("id, name, city").eq("client_id", clientId);
      const locById = Object.fromEntries((locs ?? []).map((l) => [l.id, l]));
      // The pool row used to label every sold unit "Sold lot building" — the same generic
      // string for every building on the list. Read the real style+size off the unit's master
      // design, the way the build tray already does.
      const soldMasterCodes = [...new Set((sold ?? []).map((u) => u.design_short_code).filter(Boolean))];
      const { data: soldMasters } = soldMasterCodes.length
        ? await admin.from("designs").select("short_code, selections")
          .eq("client_id", clientId).in("short_code", soldMasterCodes)
        : { data: [] };
      const masterLabel = Object.fromEntries(
        (soldMasters ?? []).map((m) => [m.short_code, buildingLabelFrom(m.selections as Record<string, unknown>)]),
      );
      // A sold unit needs its SALE delivery unless one already exists (the stop carrying
      // the buyer's design code) or the unit is actively on a load right now.
      //
      // The second disjunct was DEAD until migration 102: sold_design_short_code was declared
      // but nothing ever wrote it a value, so it was always null and the test collapsed to
      // "any undelivered stop excludes the unit". The visible symptom was that once a sold
      // building's sale stop was marked delivered it had no undelivered stop left, matched
      // nothing, and reappeared in "To be loaded" FOREVER. It works now because
      // inventory_units_sold_needs_buyer makes a sold row without a buyer unrepresentable.
      const inventory = (sold ?? []).filter((u) => !(stops ?? []).some((s) =>
        s.inventory_unit_id === u.id &&
        (!s.delivered_at || (u.sold_design_short_code && s.design_short_code === u.sold_design_short_code))
      )).map((u) => ({
        inventoryUnitId: u.id, serial: u.serial, designShortCode: u.design_short_code,
        soldFirstName: u.sold_first_name ?? null,
        buildingLabel: masterLabel[u.design_short_code ?? ""] ?? "",
        location: locById[u.location_id ?? ""] ?? null,
      }));

      const { data: openRepairs } = await admin
        .from("repairs").select("id, repair_no, customer_name, description, serial, status")
        .eq("client_id", clientId).in("status", ["requested", "approved", "in_progress"]).limit(500);
      const repairs = (openRepairs ?? []).filter((rp) => !stopRepair.has(rp.id));

      // Whether each pooled building is actually ready to haul. A sold unit's row used to
      // claim "On lot — ready" unconditionally, which is a guess: a unit sold before it was
      // built is not on any lot yet.
      const poolUnitIds = [
        ...new Set([
          ...inventory.map((i) => i.inventoryUnitId),
          ...jobs.map((j) => j.inventoryUnitId).filter(Boolean),
        ]),
      ] as string[];

      // `orders` kept as an alias of `jobs` for one deploy cycle (the page may be older
      // than this function); remove after the next beta→main promotion.
      return json({
        jobs, orders: jobs, inventory, repairs,
        unitLifecycle: await lifecycleByUnit(poolUnitIds),
        territories: await getTerritories(), drivers: await getDrivers(),
      });
    }

    if (action === "job_activity") {
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      const { data: rows, error } = await admin
        .from("schedule_activity").select("*")
        .eq("client_id", clientId).eq("subject", "build_job").eq("subject_id", job.id)
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      // Stage names for the "moved to X" line, and people's names — both resolved here so
      // the browser never has to hold a second copy of either lookup.
      const stageIds = [...new Set((rows ?? []).flatMap((a) => [a.from_stage_id, a.to_stage_id]).filter(Boolean))];
      const { data: stages } = stageIds.length
        ? await admin.from("schedule_stages").select("id, name").in("id", stageIds)
        : { data: [] };
      const stageName = Object.fromEntries((stages ?? []).map((s) => [s.id, s.name]));
      const team = await getTeam();
      const nameOf = Object.fromEntries(team.map((m) => [m.userId, m.name]));
      return json({
        activity: (rows ?? []).map((a) => ({
          id: a.id,
          action: a.action,
          detail: a.detail,
          userName: a.user_id ? (nameOf[a.user_id] || "") : "",
          fromStage: a.from_stage_id ? (stageName[a.from_stage_id] ?? null) : null,
          toStage: a.to_stage_id ? (stageName[a.to_stage_id] ?? null) : null,
          createdAt: a.created_at,
        })),
      });
    }

    if (action === "schedule_links") {
      const { data: jobs, error } = await admin
        .from("build_jobs").select("id, design_short_code, inventory_unit_id, stage_id")
        .eq("client_id", clientId).limit(2000);
      if (error) throw error;
      const stages = await getStages();
      const stageById = Object.fromEntries(stages.map((s) => [s.id, s]));
      const byDesign: Record<string, unknown> = {};
      const byUnit: Record<string, unknown> = {};
      for (const j of jobs ?? []) {
        const chip = {
          jobId: j.id,
          stage: stageById[j.stage_id]?.name ?? null,
          kind: stageById[j.stage_id]?.kind ?? null,
          color: stageById[j.stage_id]?.color ?? null,
        };
        if (j.design_short_code) byDesign[j.design_short_code] = chip;
        if (j.inventory_unit_id) byUnit[j.inventory_unit_id] = chip;
      }
      // Which units already ride a load, so Inventory can offer "Add to a load" only when
      // there isn't one open already (add_stop would 409).
      const { data: stops } = await admin
        .from("delivery_stops").select("inventory_unit_id").eq("client_id", clientId).is("delivered_at", null);
      const onLoad = [...new Set((stops ?? []).map((s) => s.inventory_unit_id).filter(Boolean))];
      return json({ byDesign, byUnit, unitsOnLoad: onLoad });
    }

    if (action === "list_drivers") {
      return json({ team: await getTeam(), drivers: await getDrivers(), territories: await getTerritories(), crews: await getCrews() });
    }

    if (action === "list_repairs") {
      const { data: repairs, error } = await admin
        .from("repairs").select("*").eq("client_id", clientId).order("requested_at", { ascending: false }).limit(1000);
      if (error) throw error;
      const ids = (repairs ?? []).map((rp) => rp.id);
      const { data: jobs } = ids.length
        ? await admin.from("build_jobs").select("id, repair_id, stage_id").eq("client_id", clientId).in("repair_id", ids)
        : { data: [] };
      const { data: stops } = ids.length
        ? await admin.from("delivery_stops").select("id, repair_id, load_id, delivered_at").eq("client_id", clientId).in("repair_id", ids)
        : { data: [] };
      return json({ repairs: repairs ?? [], jobs: jobs ?? [], stops: stops ?? [] });
    }

    if (action === "repair_photos") {
      const repair = await requireRow("repairs", payload?.repairId, "Repair");
      const prefix = `${clientId}/${repair.id}`;
      const { data: files, error } = await admin.storage.from("repair-photos").list(prefix, { limit: 100 });
      if (error) throw error;
      const paths = (files ?? []).filter((f) => f.name).map((f) => `${prefix}/${f.name}`);
      const { data: signed } = paths.length
        ? await admin.storage.from("repair-photos").createSignedUrls(paths, 3600)
        : { data: [] };
      return json({ photos: (signed ?? []).map((s, i) => ({ path: paths[i], url: s.signedUrl })) });
    }

    // ═══════════════ STAFF WRITES ═══════════════

    if (action === "move_job") {
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      const stage = await requireRow("schedule_stages", payload?.stageId, "Stage");
      const position = num(payload?.position) ?? Date.now();
      // Entering a done stage IS completing; leaving one un-completes.
      const completedAt = stage.kind === "done" ? (job.completed_at ?? new Date().toISOString()) : null;
      const { error } = await admin.from("build_jobs")
        .update({ stage_id: stage.id, position, completed_at: completedAt, updated_at: new Date().toISOString() })
        .eq("id", job.id).eq("client_id", clientId);
      if (error) throw error;
      await act("build_job", job.id, "moved", { from: job.stage_id, to: stage.id });
      return json({ ok: true });
    }

    if (action === "add_note") {
      const note = str(payload?.note);
      if (!note) return json({ error: "Note text is required." }, 400);
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      await act("build_job", job.id, "noted", { detail: note.slice(0, 2000) });
      return json({ ok: true });
    }

    if (action === "mark_stop_delivered") {
      const stop = await requireRow("delivery_stops", payload?.stopId, "Stop");
      if (stop.delivered_at) return json({ ok: true, already: true });
      // No longer gated on build_job_id: unbuiltStops now also catches a jobless stop whose
      // inventory unit is below `built`, which is reachable the moment a spec build is sold
      // before it is finished. An unbuilt building must not be markable as delivered whether
      // or not somebody made a build card for it.
      if (stop.build_job_id || stop.inventory_unit_id) {
        const unbuilt = await unbuiltStops(stop.load_id);
        if (unbuilt.some((u) => u.stopId === stop.id)) {
          // Staff has no override path — that's an admin call (decision 11).
          return json({ blocked: true, error: "This building isn't marked Built yet. An owner or admin can override." }, 409);
        }
      }
      const now = new Date().toISOString();
      await admin.from("delivery_stops").update({ delivered_at: now, updated_at: now })
        .eq("id", stop.id).eq("client_id", clientId);
      await writeBackDelivered(stop);
      await act("stop", stop.id, "delivered");
      // Last stop delivered → the load is delivered.
      const { data: remaining } = await admin
        .from("delivery_stops").select("id").eq("client_id", clientId)
        .eq("load_id", stop.load_id).is("delivered_at", null);
      if (!remaining?.length) {
        await admin.from("delivery_loads").update({ status: "delivered", completed_at: now, updated_at: now })
          .eq("id", stop.load_id).eq("client_id", clientId);
        await act("load", stop.load_id, "delivered", { detail: "all stops delivered" });
      }
      return json({ ok: true });
    }

    // ═══════════════ ADMIN WRITES — build board ═══════════════

    if (action === "save_stages") {
      const incoming = Array.isArray(payload?.stages) ? payload.stages : [];
      if (!incoming.length) return json({ error: "No stages supplied." }, 400);
      for (const s of incoming) {
        if (!str(s?.name)) return json({ error: "Every stage needs a name." }, 400);
        if (!["queue", "active", "done"].includes(s?.kind)) return json({ error: `Stage "${s.name}" needs a kind.` }, 400);
      }
      if (!incoming.some((s: Record<string, unknown>) => s.kind === "done" && !s.archived)) {
        return json({ error: "At least one stage must be marked as finished (done)." }, 400);
      }
      const existing = await getStages();
      const existingIds = new Set(existing.map((s) => s.id));
      const out = [];
      for (let i = 0; i < incoming.length; i++) {
        const s = incoming[i];
        const row = {
          name: str(s.name), color: str(s.color) ?? "#94A3B8", kind: s.kind,
          sort_order: i, archived: !!s.archived, updated_at: new Date().toISOString(),
        };
        if (s.id && existingIds.has(s.id)) {
          const { data, error } = await admin.from("schedule_stages").update(row)
            .eq("id", s.id).eq("client_id", clientId).select("*").single();
          if (error) throw error;
          out.push(data);
        } else {
          const { data, error } = await admin.from("schedule_stages")
            .insert({ ...row, client_id: clientId }).select("*").single();
          if (error) throw error;
          out.push(data);
        }
      }
      return json({ stages: out });
    }

    if (action === "create_job") {
      const source = String(payload?.source ?? "");
      if (!["order", "inventory", "repair", "manual"].includes(source)) return json({ error: "Invalid source." }, 400);
      const stages = await getStages();
      const stage = payload?.stageId
        ? await requireRow("schedule_stages", payload.stageId, "Stage")
        : (stages.find((s) => s.kind === "queue" && !s.archived) ?? stages[0]);

      const row: Record<string, unknown> = {
        client_id: clientId,
        stage_id: stage.id,
        position: Date.now(),
        source,
        title: str(payload?.title),
        customer_name: str(payload?.customerName),
        building_label: str(payload?.buildingLabel),
        width_ft: num(payload?.widthFt),
        length_ft: num(payload?.lengthFt),
        scheduled_start: dateStr(payload?.scheduledStart),
        due_date: dateStr(payload?.dueDate),
        assignee_user_id: isUuid(payload?.assigneeUserId) ? payload.assigneeUserId : null,
        notes: str(payload?.notes),
        created_by: userId,
      };
      if (payload?.crewId) {
        const crew = await requireRow("build_crews", payload.crewId, "Crew");
        row.crew_id = crew.id;
      }

      let mintSerial = false;
      if (source === "order") {
        const code = str(payload?.designShortCode);
        if (!code) return json({ error: "designShortCode is required for an order job." }, 400);
        const { data: design, error } = await admin
          .from("designs").select("short_code, contact, selections, paint_colors, status, inventory_unit_id")
          .eq("client_id", clientId).eq("short_code", code).maybeSingle();
        if (error) throw error;
        if (!design) return json({ error: "That design isn't in your account." }, 404);
        // THE ROUTING RULE (Carolyn 2026-08-07): an INVENTORY sale skips the build schedule.
        // The building is already on a lot, or already being built as a spec unit under its
        // OWN source='inventory' job — either way the buyer's order must not create a second
        // one, or the shop builds the same building twice. The Unscheduled tray already
        // filters these out; this is the rule the tray was standing in for.
        if (design.inventory_unit_id) {
          const { data: u } = await admin.from("inventory_units").select("serial")
            .eq("id", design.inventory_unit_id).eq("client_id", clientId).maybeSingle();
          return json({
            error: `That estimate is for building #${u?.serial ?? "?"}, which is already on your lot or in the `
              + `build queue. Schedule its delivery instead.`,
          }, 409);
        }
        row.design_short_code = design.short_code;
        row.customer_name = row.customer_name ?? str((design.contact as Record<string, unknown>)?.name);
        row.building_label = row.building_label ?? str(buildingLabelFrom(design.selections as Record<string, unknown>));
        const dims = parseSize(selSize(design.selections));
        row.width_ft = row.width_ft ?? dims.widthFt;
        row.length_ft = row.length_ft ?? dims.lengthFt;
        Object.assign(row, await appearanceFrom(admin, clientId, design.selections, design.paint_colors));
        mintSerial = true;
      } else if (source === "inventory") {
        const unit = await requireRow("inventory_units", payload?.inventoryUnitId, "Inventory unit");
        // Approval is what makes a building queue-eligible (migration 102). The tray only
        // offers approved units, but a tray is a UI — this is the rule. Deliberately NO sale
        // check beside it: a unit sold before it was finished still has to be finished.
        if (!unit.accepted_at) {
          return json({
            error: `Building #${unit.serial} hasn't been approved for the build queue yet. `
              + `Approve it on the Inventory tab first.`,
          }, 409);
        }
        row.inventory_unit_id = unit.id;
        row.serial = unit.serial;
        row.design_short_code = null; // the unit's master design is reachable via the unit
        if (unit.design_short_code) {
          const { data: master } = await admin.from("designs").select("selections, paint_colors")
            .eq("client_id", clientId).eq("short_code", unit.design_short_code).maybeSingle();
          row.building_label = row.building_label ?? str(buildingLabelFrom(master?.selections as Record<string, unknown>));
          const dims = parseSize(selSize(master?.selections));
          row.width_ft = row.width_ft ?? dims.widthFt;
          row.length_ft = row.length_ft ?? dims.lengthFt;
          Object.assign(row, await appearanceFrom(admin, clientId, master?.selections, master?.paint_colors));
        }
      } else if (source === "repair") {
        const repair = await requireRow("repairs", payload?.repairId, "Repair");
        row.repair_id = repair.id;
        row.serial = repair.serial;
        row.customer_name = row.customer_name ?? repair.customer_name;
        row.title = row.title ?? str(repair.description)?.slice(0, 120);
      } else if (!row.title && !row.customer_name) {
        return json({ error: "A manual job needs a title." }, 400);
      }

      // Serial LAST — after every validation — so a rejected payload never burns a number.
      if (mintSerial) {
        const { data: serial, error } = await admin.rpc("take_next_serial", { p_client_id: clientId });
        if (error) throw error;
        row.serial = serial;
      }

      const { data: job, error: insErr } = await admin.from("build_jobs").insert(row).select("*").single();
      if (insErr) {
        if ((insErr as { code?: string }).code === "23505") {
          return json({ error: "That building is already on the build schedule." }, 409);
        }
        throw insErr;
      }
      await act("build_job", job.id, "created", { detail: `${source}${job.serial ? ` · serial #${job.serial}` : ""}` });
      return json({ job });
    }

    if (action === "update_job") {
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("title" in payload) patch.title = str(payload.title);
      if ("customerName" in payload) patch.customer_name = str(payload.customerName);
      if ("buildingLabel" in payload) patch.building_label = str(payload.buildingLabel);
      if ("widthFt" in payload) patch.width_ft = num(payload.widthFt);
      if ("lengthFt" in payload) patch.length_ft = num(payload.lengthFt);
      if ("scheduledStart" in payload) patch.scheduled_start = dateStr(payload.scheduledStart);
      if ("dueDate" in payload) patch.due_date = dateStr(payload.dueDate);
      if ("assigneeUserId" in payload) patch.assignee_user_id = isUuid(payload.assigneeUserId) ? payload.assigneeUserId : null;
      if ("crewId" in payload) {
        if (payload.crewId === null || payload.crewId === "") patch.crew_id = null;
        else {
          const crew = await requireRow("build_crews", payload.crewId, "Crew");
          patch.crew_id = crew.id;
        }
      }
      if ("notes" in payload) patch.notes = str(payload.notes);
      const { error } = await admin.from("build_jobs").update(patch).eq("id", job.id).eq("client_id", clientId);
      if (error) throw error;
      await act("build_job", job.id, "updated");
      return json({ ok: true });
    }

    if (action === "complete_job") {
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      const stages = await getStages();
      const done = stages.find((s) => s.kind === "done" && !s.archived);
      if (!done) return json({ error: "No finished stage exists." }, 400);
      const now = new Date().toISOString();
      const { error } = await admin.from("build_jobs")
        .update({ stage_id: done.id, completed_at: now, updated_at: now })
        .eq("id", job.id).eq("client_id", clientId);
      if (error) throw error;
      await act("build_job", job.id, "completed", { from: job.stage_id, to: done.id });
      // Finishing the last shop job for a repair PROMPTS closing the repair — it does not
      // close it (SCHEDULING_SCOPE.md: "prompts, not forces"). The repair's own status is
      // the customer-facing truth and may still be waiting on a part or a payment.
      if (job.repair_id) {
        const repair = await admin.from("repairs").select("id, repair_no, status")
          .eq("client_id", clientId).eq("id", job.repair_id).maybeSingle();
        const rp = repair.data;
        if (rp && rp.status !== "completed" && rp.status !== "declined") {
          const { data: others } = await admin.from("build_jobs").select("id, completed_at")
            .eq("client_id", clientId).eq("repair_id", job.repair_id).neq("id", job.id);
          const anyOpen = (others ?? []).some((o) => !o.completed_at);
          if (!anyOpen) return json({ ok: true, repairPrompt: { repairId: rp.id, repairNo: rp.repair_no } });
        }
      }
      return json({ ok: true });
    }

    if (action === "delete_job") {
      const job = await requireRow("build_jobs", payload?.jobId, "Job");
      const { error } = await admin.from("build_jobs").delete().eq("id", job.id).eq("client_id", clientId);
      if (error) throw error;
      await act("build_job", job.id, "deleted", { detail: job.customer_name ?? job.title ?? null });
      return json({ ok: true });
    }

    // ═══════════════ ADMIN WRITES — team / territories ═══════════════

    if (action === "save_territory") {
      const name = str(payload?.name);
      if (!name) return json({ error: "Territory name is required." }, 400);
      const row = {
        name,
        description: str(payload?.description),
        sort_order: num(payload?.sortOrder) ?? 0,
        active: payload?.active !== false,
        updated_at: new Date().toISOString(),
      };
      if (payload?.id) {
        const t = await requireRow("delivery_territories", payload.id, "Territory");
        const { data, error } = await admin.from("delivery_territories").update(row)
          .eq("id", t.id).eq("client_id", clientId).select("*").single();
        if (error) throw error;
        return json({ territory: data });
      }
      const { data, error } = await admin.from("delivery_territories")
        .insert({ ...row, client_id: clientId }).select("*").single();
      if (error) {
        if ((error as { code?: string }).code === "23505") return json({ error: "A territory with that name already exists." }, 409);
        throw error;
      }
      return json({ territory: data });
    }

    if (action === "save_crew") {
      const name = str(payload?.name);
      if (!name) return json({ error: "Give the crew a name." }, 400);
      const memberIds = Array.isArray(payload?.memberUserIds) ? payload.memberUserIds.filter(isUuid) : [];
      // Crew members are TEAM MEMBERS — people with a login (Carolyn, 2026-08-06). isUuid
      // alone only proved the string was shaped like an id, so any uuid at all could be
      // stored here, including one belonging to another tenant's user.
      if (memberIds.length) {
        const { data: mem } = await admin.from("client_users").select("user_id")
          .eq("client_id", clientId).in("user_id", memberIds);
        if ((mem ?? []).length !== memberIds.length) {
          return json({ error: "Everyone on a crew has to be on your team. Add them under Settings → Team first." }, 400);
        }
      }
      const row = {
        name,
        color: str(payload?.color) ?? "#3D3672",
        member_user_ids: memberIds,
        sort_order: num(payload?.sortOrder) ?? 0,
        active: payload?.active !== false,
        updated_at: new Date().toISOString(),
      };
      if (payload?.id) {
        const c = await requireRow("build_crews", payload.id, "Crew");
        const { data, error } = await admin.from("build_crews").update(row)
          .eq("id", c.id).eq("client_id", clientId).select("*").single();
        if (error) throw error;
        return json({ crew: data });
      }
      const { data, error } = await admin.from("build_crews")
        .insert({ ...row, client_id: clientId }).select("*").single();
      if (error) {
        if ((error as { code?: string }).code === "23505") return json({ error: "A crew with that name already exists." }, 409);
        throw error;
      }
      return json({ crew: data });
    }

    if (action === "save_driver") {
      // EVERY DRIVER HAS A LOGIN (Carolyn, 2026-08-06 — correcting 095's optional-login
      // model). A driver is a person on the team with the Driver title, not a free-floating
      // name: they need to sign in to see their loads and mark a delivery done, and per-person
      // access (migration 100) can only attach to something you can sign in as. display_name
      // stays as an optional label (a nickname, or "Dad's truck") layered on their real name.
      //
      // Safe to tighten: at the time of this change every driver_profiles row already had a
      // login (0 without), so nothing needed converting.
      const driverId = isUuid(payload?.driverId) ? payload.driverId : null;
      const targetUserId = isUuid(payload?.userId) ? payload.userId : null;
      const displayName = str(payload?.displayName);
      if (targetUserId) {
        const { data: member } = await admin.from("client_users").select("user_id")
          .eq("client_id", clientId).eq("user_id", targetUserId).maybeSingle();
        if (!member) return json({ error: "That person isn't on your team." }, 404);
      }
      // Creating a driver requires naming the person. Editing one (driverId) does not have to
      // resend it, but must never be used to strip the link off an existing profile.
      if (!driverId && !targetUserId) {
        return json({ error: "Pick the person this driver is. Add them under Settings → Team first if they aren't there yet." }, 400);
      }
      if (driverId && "userId" in (payload ?? {}) && !targetUserId) {
        return json({ error: "A driver must stay linked to a team member." }, 400);
      }
      const territoryIds = Array.isArray(payload?.territoryIds) ? payload.territoryIds.filter(isUuid) : [];
      if (territoryIds.length) {
        const { data: owned } = await admin.from("delivery_territories").select("id")
          .eq("client_id", clientId).in("id", territoryIds);
        if ((owned ?? []).length !== territoryIds.length) return json({ error: "Unknown territory." }, 400);
      }
      const row: Record<string, unknown> = {
        display_name: displayName,
        is_driver: payload?.isDriver !== false,
        truck_name: str(payload?.truckName),
        deck_length_ft: num(payload?.deckLengthFt),
        max_width_ft: num(payload?.maxWidthFt),
        wide_load_capable: payload?.wideLoadCapable !== false,
        territory_ids: territoryIds,
        active: payload?.active !== false,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      };
      if ("userId" in (payload ?? {})) row.user_id = targetUserId; // explicit link/unlink
      if (driverId) {
        const existing = await requireRow("driver_profiles", driverId, "Driver");
        const { data, error } = await admin.from("driver_profiles").update(row)
          .eq("id", existing.id).eq("client_id", clientId).select("*").single();
        if (error) throw error;
        return json({ driver: data });
      }
      if (targetUserId) {
        // One profile per login: update it if it exists, create it otherwise (the partial
        // unique index can't drive an upsert, so do it by hand).
        const { data: byUser } = await admin.from("driver_profiles").select("id")
          .eq("client_id", clientId).eq("user_id", targetUserId).maybeSingle();
        if (byUser) {
          const { data, error } = await admin.from("driver_profiles").update(row)
            .eq("id", byUser.id).eq("client_id", clientId).select("*").single();
          if (error) throw error;
          return json({ driver: data });
        }
        const { data, error } = await admin.from("driver_profiles")
          .insert({ ...row, client_id: clientId, user_id: targetUserId }).select("*").single();
        if (error) throw error;
        return json({ driver: data });
      }
      // No login-less fallback: the guard at the top of this action is the only entry, and a
      // second insert path here would quietly outlive it the first time someone edits that guard.
      return json({ error: "Pick the person this driver is." }, 400);
    }

    // ═══════════════ ADMIN WRITES — loads & stops ═══════════════

    if (action === "create_load") {
      const row: Record<string, unknown> = {
        client_id: clientId,
        load_date: dateStr(payload?.loadDate),
        route_label: str(payload?.routeLabel),
        miles_out: num(payload?.milesOut),
        miles_back: num(payload?.milesBack),
        permit_status: ["not_needed", "needed", "on_file"].includes(payload?.permitStatus) ? payload.permitStatus : "not_needed",
        notes: str(payload?.notes),
        created_by: userId,
      };
      if (payload?.driverId || payload?.driverUserId) {
        // driverId = the profile (095, name-first); driverUserId kept for older pages.
        const prof = payload?.driverId
          ? await requireRow("driver_profiles", payload.driverId, "Driver")
          : (await admin.from("driver_profiles").select("*")
              .eq("client_id", clientId).eq("user_id", payload.driverUserId).maybeSingle()).data;
        if (!prof?.is_driver || !prof.active) return json({ error: "That person isn't set up as a driver — add their truck in Settings → Team." }, 400);
        row.driver_id = prof.id;
        row.driver_user_id = prof.user_id;
        // Snapshot the truck: past loads keep their math when a driver upgrades trucks.
        row.deck_length_ft = prof.deck_length_ft;
        row.max_width_ft = prof.max_width_ft;
      }
      const { data: load, error } = await admin.from("delivery_loads").insert(row).select("*").single();
      if (error) throw error;
      await act("load", load.id, "created", { detail: `Load ${load.load_no}` });
      return json({ load });
    }

    if (action === "update_load") {
      const load = await requireRow("delivery_loads", payload?.loadId, "Load");
      // Once a load has gone out, only notes may change — the run sheet is history.
      if (load.status !== "planned") {
        const allowed = new Set(["action", "loadId", "notes", "targetClientId"]);
        if (!Object.keys(payload).every((k) => allowed.has(k))) {
          return json({ error: "Only notes can change after a load has gone out." }, 400);
        }
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("loadDate" in payload) patch.load_date = dateStr(payload.loadDate);
      if ("routeLabel" in payload) patch.route_label = str(payload.routeLabel);
      if ("milesOut" in payload) patch.miles_out = num(payload.milesOut);
      if ("milesBack" in payload) patch.miles_back = num(payload.milesBack);
      if ("permitStatus" in payload && ["not_needed", "needed", "on_file"].includes(payload.permitStatus)) patch.permit_status = payload.permitStatus;
      if ("notes" in payload) patch.notes = str(payload.notes);
      if ("driverId" in payload || "driverUserId" in payload) {
        const cleared = ("driverId" in payload ? payload.driverId : payload.driverUserId) === null;
        if (cleared) {
          patch.driver_id = null; patch.driver_user_id = null; patch.deck_length_ft = null; patch.max_width_ft = null;
        } else {
          const prof = payload?.driverId
            ? await requireRow("driver_profiles", payload.driverId, "Driver")
            : (await admin.from("driver_profiles").select("*")
                .eq("client_id", clientId).eq("user_id", payload.driverUserId).maybeSingle()).data;
          if (!prof?.is_driver || !prof.active) return json({ error: "That person isn't set up as a driver." }, 400);
          // No override for physics: every existing stop must fit the new truck.
          if (prof.max_width_ft != null) {
            const { data: stops } = await admin.from("delivery_stops").select("width_ft, serial")
              .eq("client_id", clientId).eq("load_id", load.id);
            const tooWide = (stops ?? []).find((s) => Number(s.width_ft) > Number(prof.max_width_ft));
            if (tooWide) return json({ error: `Building #${tooWide.serial ?? "?"} is ${tooWide.width_ft}' wide — too wide for that truck (max ${prof.max_width_ft}').` }, 400);
          }
          // ...and they must be able to run wide at all if anything on the load is wide.
          if (prof.wide_load_capable === false) {
            const { data: stops } = await admin.from("delivery_stops").select("width_ft, serial")
              .eq("client_id", clientId).eq("load_id", load.id);
            const wide = (stops ?? []).find((s) => Number(s.width_ft) > WIDE_FT);
            if (wide) return json({ error: `Building #${wide.serial ?? "?"} is a wide load and ${prof.display_name || "that driver"} isn't set up to run wide.` }, 400);
          }
          patch.driver_id = prof.id;
          patch.driver_user_id = prof.user_id;
          patch.deck_length_ft = prof.deck_length_ft;
          patch.max_width_ft = prof.max_width_ft;
        }
      }
      const { error } = await admin.from("delivery_loads").update(patch).eq("id", load.id).eq("client_id", clientId);
      if (error) throw error;
      await act("load", load.id, "updated");
      return json({ ok: true });
    }

    if (action === "add_stop") {
      const load = await requireRow("delivery_loads", payload?.loadId, "Load");
      if (load.status !== "planned") return json({ error: "This load has already gone out." }, 400);
      const source = String(payload?.source ?? "");
      if (!["order", "inventory", "repair", "manual"].includes(source)) return json({ error: "Invalid source." }, 400);

      const row: Record<string, unknown> = {
        client_id: clientId,
        load_id: load.id,
        source,
        customer_name: str(payload?.customerName),
        customer_phone: str(payload?.customerPhone),
        building_label: str(payload?.buildingLabel),
        width_ft: num(payload?.widthFt),
        length_ft: num(payload?.lengthFt),
        pickup: str(payload?.pickup) ?? "shop",
        dest_street: str(payload?.destStreet),
        dest_city: str(payload?.destCity),
        dest_state: str(payload?.destState),
        dest_zip: str(payload?.destZip),
        leg_miles: num(payload?.legMiles),
        time_window: str(payload?.timeWindow),
        site_notes: str(payload?.siteNotes),
      };
      if (payload?.territoryId) {
        const t = await requireRow("delivery_territories", payload.territoryId, "Territory");
        row.territory_id = t.id;
      }

      // A build job link works for ANY source (Carolyn 2026-08-04: every building on the
      // build schedule shows in delivery) — the stop inherits the job's snapshots and the
      // built-before-delivered check applies. An inventory SPEC build hauled shop → lot
      // rides exactly like an order.
      if (payload?.buildJobId) {
        const job = await requireRow("build_jobs", payload.buildJobId, "Job");
        row.build_job_id = job.id;
        row.design_short_code = job.design_short_code;
        row.inventory_unit_id = job.inventory_unit_id;
        row.repair_id = job.repair_id;
        row.serial = job.serial;
        row.customer_name = row.customer_name ?? job.customer_name;
        row.building_label = row.building_label ?? job.building_label ?? job.title;
        row.width_ft = row.width_ft ?? job.width_ft;
        row.length_ft = row.length_ft ?? job.length_ft;
      } else if (source === "order") {
        // Bare design code is allowed for tenants who skip the build board.
        const code = str(payload?.designShortCode);
        if (!code) return json({ error: "buildJobId or designShortCode is required for an order stop." }, 400);
        const { data: design } = await admin.from("designs").select("short_code, contact, selections")
          .eq("client_id", clientId).eq("short_code", code).maybeSingle();
        if (!design) return json({ error: "That design isn't in your account." }, 404);
        row.design_short_code = design.short_code;
        row.customer_name = row.customer_name ?? str((design.contact as Record<string, unknown>)?.name);
        row.customer_phone = row.customer_phone ?? str((design.contact as Record<string, unknown>)?.phone);
        row.building_label = row.building_label ?? str(buildingLabelFrom(design.selections as Record<string, unknown>));
        const dims = parseSize(selSize(design.selections));
        row.width_ft = row.width_ft ?? dims.widthFt;
        row.length_ft = row.length_ft ?? dims.lengthFt;
      } else if (source === "inventory") {
        const unit = await requireRow("inventory_units", payload?.inventoryUnitId, "Inventory unit");
        row.inventory_unit_id = unit.id;
        row.serial = unit.serial;
        row.pickup = str(payload?.pickup) ?? (unit.location_id ? String(unit.location_id) : "shop");
        // The SALE delivery of a sold unit carries the buyer's design code — that's how
        // the pool knows the sale is scheduled, and how delivered writes back to the
        // buyer's estimate.
        if (unit.sale_state === "sold" && unit.sold_design_short_code) {
          row.design_short_code = unit.sold_design_short_code;
          if (!row.customer_name) {
            const { data: buyer } = await admin.from("designs").select("contact")
              .eq("client_id", clientId).eq("short_code", unit.sold_design_short_code).maybeSingle();
            row.customer_name = str((buyer?.contact as Record<string, unknown>)?.name);
            row.customer_phone = row.customer_phone ?? str((buyer?.contact as Record<string, unknown>)?.phone);
          }
        }
        if (!row.building_label && unit.design_short_code) {
          const { data: master } = await admin.from("designs").select("selections")
            .eq("client_id", clientId).eq("short_code", unit.design_short_code).maybeSingle();
          row.building_label = str(buildingLabelFrom(master?.selections as Record<string, unknown>));
          const dims = parseSize(selSize(master?.selections));
          row.width_ft = row.width_ft ?? dims.widthFt;
          row.length_ft = row.length_ft ?? dims.lengthFt;
        }
      } else if (source === "repair") {
        const repair = await requireRow("repairs", payload?.repairId, "Repair");
        row.repair_id = repair.id;
        row.serial = repair.serial;
        row.customer_name = row.customer_name ?? repair.customer_name;
        row.customer_phone = row.customer_phone ?? repair.phone;
        row.building_label = row.building_label ?? `Repair R-${repair.repair_no}`;
      } else if (!row.customer_name && !row.building_label) {
        return json({ error: "A manual stop needs a customer or description." }, 400);
      }

      // A sold unit's delivery IS the sale delivery, HOWEVER the stop was created. The
      // build-job path above copies job.design_short_code, which is hard-coded null for an
      // inventory job — so without this the sale stop is indistinguishable from the shop → lot
      // haul, and two things break silently: writeBackDelivered returns early on
      // `!stop.design_short_code` so the buyer's estimate is never marked delivered, and the
      // lifecycle derivation counts the sale stop as a haul and reports a building standing in
      // the customer's yard as "Available to sell at Location".
      //
      // MUST run before the destination defaulting below, which keys on design_short_code to
      // find the address the customer typed: without the buyer's code here, a sold building's
      // delivery would be created with no destination at all.
      if (row.inventory_unit_id && !row.design_short_code) {
        const { data: u } = await admin.from("inventory_units")
          .select("sale_state, sold_design_short_code")
          .eq("id", row.inventory_unit_id).eq("client_id", clientId).maybeSingle();
        if (u?.sale_state === "sold" && u.sold_design_short_code) {
          row.design_short_code = u.sold_design_short_code;
          if (!row.customer_name) {
            const { data: buyer } = await admin.from("designs").select("contact")
              .eq("client_id", clientId).eq("short_code", u.sold_design_short_code).maybeSingle();
            row.customer_name = str((buyer?.contact as Record<string, unknown>)?.name);
            row.customer_phone = row.customer_phone ?? str((buyer?.contact as Record<string, unknown>)?.phone);
          }
        }
      }

      // ── Destination + territory, defaulted rather than demanded ────────────────
      // Done once here rather than in each source branch, so the build-job path (which is
      // how nearly every stop is actually created) gets it too. Anything the caller sent
      // wins; this only fills blanks.
      if (!row.dest_street && !row.dest_city && row.design_short_code) {
        const { data: d } = await admin.from("designs").select("contact")
          .eq("client_id", clientId).eq("short_code", row.design_short_code).maybeSingle();
        const addr = addressFrom(d?.contact);
        row.dest_street = addr.street;
        row.dest_city = addr.city;
        row.dest_state = addr.state;
        row.dest_zip = addr.zip;
      }
      // Territory defaults from where this tenant has already delivered — "same city or zip
      // as a previous stop" is the v1 rule in SCHEDULING_SCOPE.md (geocoding comes later).
      // Without this nobody ever sets one by hand and the pool cannot group by corridor.
      // Uses territoryFor() so the group the pool SHOWED a building in is the territory the
      // stop actually gets — two copies of this rule would drift into a lie.
      if (!row.territory_id && (row.dest_city || row.dest_zip)) {
        const { data: prior } = await admin.from("delivery_stops")
          .select("territory_id, dest_city, dest_zip")
          .eq("client_id", clientId).not("territory_id", "is", null)
          .order("created_at", { ascending: false }).limit(200);
        const byZip: Record<string, string> = {};
        const byCity: Record<string, string> = {};
        for (const p of prior ?? []) {
          if (p.dest_zip && !byZip[p.dest_zip]) byZip[p.dest_zip] = p.territory_id;
          const c = p.dest_city ? String(p.dest_city).trim().toLowerCase() : "";
          if (c && !byCity[c]) byCity[c] = p.territory_id;
        }
        const guess = territoryFor(
          { street: null, city: (row.dest_city as string) ?? null, state: null, zip: (row.dest_zip as string) ?? null },
          byZip, byCity,
        );
        if (guess) row.territory_id = guess;
      }

      // A unit rides at most one load AT A TIME (migration 092 dropped the per-unit unique
      // index so a unit can be hauled shop → lot and later delivered to its buyer — but
      // never be on two open loads at once).
      if (row.inventory_unit_id) {
        const { data: activeStops } = await admin.from("delivery_stops").select("id")
          .eq("client_id", clientId).eq("inventory_unit_id", row.inventory_unit_id)
          .is("delivered_at", null).limit(1);
        if (activeStops?.length) return json({ error: "That building is already on a load." }, 409);
      }

      // The one rule with NO override: it physically doesn't fit on the truck.
      if (row.width_ft != null && load.max_width_ft != null && Number(row.width_ft) > Number(load.max_width_ft)) {
        return json({ error: `That building is ${row.width_ft}' wide — too wide for this truck (max ${load.max_width_ft}'). Assign a different driver or fix the truck specs in Settings → Team.` }, 400);
      }
      // Same family of rule, and the reason wide_load_capable exists: a driver who can't
      // run wide can't take a wide building, whatever their deck says.
      if (row.width_ft != null && Number(row.width_ft) > WIDE_FT && (load.driver_id || load.driver_user_id)) {
        const { data: prof } = load.driver_id
          ? await admin.from("driver_profiles").select("display_name, wide_load_capable").eq("id", load.driver_id).eq("client_id", clientId).maybeSingle()
          : await admin.from("driver_profiles").select("display_name, wide_load_capable").eq("user_id", load.driver_user_id).eq("client_id", clientId).maybeSingle();
        if (prof && prof.wide_load_capable === false) {
          return json({ error: `That building is ${row.width_ft}' wide, and ${prof.display_name || "this driver"} isn't set up to run wide loads. Assign a different driver, or update their truck in Settings → Team.` }, 400);
        }
      }

      const { count } = await admin.from("delivery_stops")
        .select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("load_id", load.id);
      row.stop_order = (count ?? 0) + 1;

      const { data: stop, error } = await admin.from("delivery_stops").insert(row).select("*").single();
      if (error) {
        if ((error as { code?: string }).code === "23505") return json({ error: "That building is already on a load." }, 409);
        throw error;
      }
      await recomputeWide(load.id);
      await act("load", load.id, "loaded", { detail: `stop ${row.stop_order}: ${row.customer_name ?? row.building_label ?? ""}` });
      return json({ stop });
    }

    if (action === "update_stop") {
      const stop = await requireRow("delivery_stops", payload?.stopId, "Stop");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("destStreet" in payload) patch.dest_street = str(payload.destStreet);
      if ("destCity" in payload) patch.dest_city = str(payload.destCity);
      if ("destState" in payload) patch.dest_state = str(payload.destState);
      if ("destZip" in payload) patch.dest_zip = str(payload.destZip);
      if ("legMiles" in payload) patch.leg_miles = num(payload.legMiles);
      if ("timeWindow" in payload) patch.time_window = str(payload.timeWindow);
      if ("siteNotes" in payload) patch.site_notes = str(payload.siteNotes);
      if ("pickup" in payload) patch.pickup = str(payload.pickup) ?? "shop";
      if ("customerPhone" in payload) patch.customer_phone = str(payload.customerPhone);
      if ("territoryId" in payload) {
        if (payload.territoryId === null) patch.territory_id = null;
        else {
          const t = await requireRow("delivery_territories", payload.territoryId, "Territory");
          patch.territory_id = t.id;
        }
      }
      const { error } = await admin.from("delivery_stops").update(patch).eq("id", stop.id).eq("client_id", clientId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "remove_stop") {
      const stop = await requireRow("delivery_stops", payload?.stopId, "Stop");
      const { error } = await admin.from("delivery_stops").delete().eq("id", stop.id).eq("client_id", clientId);
      if (error) throw error;
      // Close the gap in stop_order.
      const { data: rest } = await admin.from("delivery_stops").select("id")
        .eq("client_id", clientId).eq("load_id", stop.load_id).order("stop_order");
      for (let i = 0; i < (rest ?? []).length; i++) {
        await admin.from("delivery_stops").update({ stop_order: i + 1 }).eq("id", rest![i].id).eq("client_id", clientId);
      }
      await recomputeWide(stop.load_id);
      await act("load", stop.load_id, "unloaded", { detail: stop.customer_name ?? stop.building_label ?? null });
      return json({ ok: true });
    }

    if (action === "reorder_stops") {
      const load = await requireRow("delivery_loads", payload?.loadId, "Load");
      const ids = Array.isArray(payload?.stopIds) ? payload.stopIds : [];
      const { data: stops } = await admin.from("delivery_stops").select("id")
        .eq("client_id", clientId).eq("load_id", load.id);
      const owned = new Set((stops ?? []).map((s) => s.id));
      if (ids.length !== owned.size || !ids.every((id: string) => owned.has(id))) {
        return json({ error: "Stop list doesn't match this load." }, 400);
      }
      for (let i = 0; i < ids.length; i++) {
        await admin.from("delivery_stops").update({ stop_order: i + 1 }).eq("id", ids[i]).eq("client_id", clientId);
      }
      return json({ ok: true });
    }

    if (action === "mark_load_out" || action === "mark_load_delivered") {
      const load = await requireRow("delivery_loads", payload?.loadId, "Load");
      const toDelivered = action === "mark_load_delivered";
      if (load.status === "delivered") return json({ ok: true, already: true });

      const unbuilt = await unbuiltStops(load.id);
      const now = new Date().toISOString();
      if (unbuilt.length) {
        if (!payload?.override) {
          return json({
            blocked: true,
            error: "Some buildings on this load aren't marked Built.",
            unbuilt,
          }, 409);
        }
        // Decision 11: crew cannot override. Checked here rather than in GATES because the
        // gate for this action is delivery_schedule:'edit' — precisely what the Driver
        // preset grants, so the table cannot separate "may dispatch" from "may overrule the
        // built check". mark_stop_delivered refuses staff the same way (see above).
        if (!isAdminRole) {
          return json({ error: "Only an owner or admin can send out a load that isn't built." }, 403);
        }
        const reason = str(payload?.overrideReason);
        if (!reason) return json({ error: "An override needs a reason." }, 400);
        // Attributability before the irreversible-ish act: the activity row must land.
        await act("load", load.id, "override", { detail: reason.slice(0, 500) });
        await admin.from("delivery_loads").update({
          override_reason: reason.slice(0, 500), overridden_by: userId, overridden_at: now,
        }).eq("id", load.id).eq("client_id", clientId);
        if (payload?.alsoCompleteBuilds) {
          const stages = await getStages();
          const done = stages.find((s) => s.kind === "done" && !s.archived);
          if (done) {
            for (const u of unbuilt) {
              if (!u.buildJobId) continue;
              await admin.from("build_jobs")
                .update({ stage_id: done.id, completed_at: now, updated_at: now })
                .eq("id", u.buildJobId).eq("client_id", clientId);
              await act("build_job", u.buildJobId, "completed", { to: done.id, detail: "completed via delivery override" });
            }
          }
        }
      }

      if (toDelivered) {
        const { data: stops } = await admin.from("delivery_stops").select("*")
          .eq("client_id", clientId).eq("load_id", load.id);
        for (const stop of stops ?? []) {
          if (!stop.delivered_at) {
            await admin.from("delivery_stops").update({ delivered_at: now, updated_at: now })
              .eq("id", stop.id).eq("client_id", clientId);
          }
          await writeBackDelivered(stop);
        }
        await admin.from("delivery_loads").update({
          status: "delivered", completed_at: now,
          departed_at: load.departed_at ?? now, updated_at: now,
        }).eq("id", load.id).eq("client_id", clientId);
        await act("load", load.id, "delivered");
      } else {
        await admin.from("delivery_loads").update({ status: "out", departed_at: now, updated_at: now })
          .eq("id", load.id).eq("client_id", clientId);
        await act("load", load.id, "out");
      }
      return json({ ok: true });
    }

    if (action === "delete_load") {
      const load = await requireRow("delivery_loads", payload?.loadId, "Load");
      if (load.status === "delivered") return json({ error: "A delivered load is history — it can't be deleted." }, 400);
      const { error } = await admin.from("delivery_loads").delete().eq("id", load.id).eq("client_id", clientId);
      if (error) throw error; // stops cascade
      await act("load", load.id, "deleted", { detail: `Load ${load.load_no}` });
      return json({ ok: true });
    }

    // ═══════════════ ADMIN WRITES — repairs ═══════════════

    if (action === "create_repair") {
      const customerName = str(payload?.customerName);
      const description = str(payload?.description);
      if (!customerName || !description) return json({ error: "Customer name and a description are required." }, 400);
      const row: Record<string, unknown> = {
        client_id: clientId,
        customer_name: customerName,
        phone: str(payload?.phone),
        email: str(payload?.email),
        description,
        serial: num(payload?.serial),
        design_short_code: str(payload?.designShortCode),
        // `buildingRef` is what intake actually sends: one field the shop can type either a
        // serial or a design code into. Resolved below — a repair logged against a code used
        // to store nothing linkable, so service history (which matches on serial) missed it.
        quote_cents: num(payload?.quoteCents),
        notes: str(payload?.notes),
        created_by: userId,
      };
      if (payload?.inventoryUnitId) {
        const unit = await requireRow("inventory_units", payload.inventoryUnitId, "Inventory unit");
        row.inventory_unit_id = unit.id;
        row.serial = row.serial ?? unit.serial;
      }
      // One field, either kind of reference — "not one of ours" stays legal, so an
      // unresolvable value is kept as typed rather than rejected: builders repair
      // competitors' sheds and must still be able to log the job.
      const ref = str(payload?.buildingRef);
      if (ref) {
        if (/^SS-/i.test(ref)) {
          const code = ref.toUpperCase();
          const { data: design } = await admin.from("designs").select("short_code")
            .eq("client_id", clientId).eq("short_code", code).maybeSingle();
          if (design) row.design_short_code = design.short_code;
        } else {
          const n = Number(ref.replace(/[^0-9]/g, ""));
          if (Number.isFinite(n) && n > 0) {
            row.serial = n;
            // A serial belongs to an inventory unit; the unit knows its design, which is
            // what ties the repair to the actual building.
            const { data: unit } = await admin.from("inventory_units")
              .select("id, design_short_code").eq("client_id", clientId).eq("serial", n).maybeSingle();
            if (unit) {
              row.inventory_unit_id = row.inventory_unit_id ?? unit.id;
              row.design_short_code = row.design_short_code ?? unit.design_short_code;
            }
          }
        }
      }
      const { data: repair, error } = await admin.from("repairs").insert(row).select("*").single();
      if (error) throw error;
      await act("repair", repair.id, "created", { detail: `R-${repair.repair_no}` });
      return json({ repair });
    }

    if (action === "update_repair") {
      const repair = await requireRow("repairs", payload?.repairId, "Repair");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("customerName" in payload) patch.customer_name = str(payload.customerName) ?? repair.customer_name;
      if ("phone" in payload) patch.phone = str(payload.phone);
      if ("email" in payload) patch.email = str(payload.email);
      if ("description" in payload) patch.description = str(payload.description) ?? repair.description;
      if ("serial" in payload) patch.serial = num(payload.serial);
      if ("designShortCode" in payload) patch.design_short_code = str(payload.designShortCode);
      if ("quoteCents" in payload) patch.quote_cents = num(payload.quoteCents);
      if ("notes" in payload) patch.notes = str(payload.notes);
      if ("status" in payload) {
        if (!["requested", "approved", "in_progress", "completed", "declined"].includes(payload.status)) {
          return json({ error: "Invalid repair status." }, 400);
        }
        patch.status = payload.status;
        patch.completed_at = payload.status === "completed" ? new Date().toISOString() : null;
      }
      const { error } = await admin.from("repairs").update(patch).eq("id", repair.id).eq("client_id", clientId);
      if (error) throw error;
      await act("repair", repair.id, "updated", { detail: "status" in payload ? `status → ${payload.status}` : null });
      return json({ ok: true });
    }

    if (action === "delete_repair") {
      const repair = await requireRow("repairs", payload?.repairId, "Repair");
      // Photos first (storage has no cascade), then the row (jobs/stops cascade via FK).
      const prefix = `${clientId}/${repair.id}`;
      const { data: files } = await admin.storage.from("repair-photos").list(prefix, { limit: 100 });
      const paths = (files ?? []).filter((f) => f.name).map((f) => `${prefix}/${f.name}`);
      if (paths.length) await admin.storage.from("repair-photos").remove(paths);
      const { error } = await admin.from("repairs").delete().eq("id", repair.id).eq("client_id", clientId);
      if (error) throw error;
      await act("repair", repair.id, "deleted", { detail: `R-${repair.repair_no}` });
      return json({ ok: true });
    }

    if (action === "upload_repair_photo") {
      const repair = await requireRow("repairs", payload?.repairId, "Repair");
      const b64 = String(payload?.dataBase64 ?? "");
      const contentType = String(payload?.contentType ?? "");
      if (!/^image\/(png|jpeg|gif|webp)$/.test(contentType)) return json({ error: "Only PNG, JPEG, GIF, or WebP images." }, 400);
      if (!b64 || b64.length > 14_000_000) return json({ error: "Image is missing or too large (10 MB max)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
      catch { return json({ error: "Invalid image data." }, 400); }
      const safeName = String(payload?.fileName ?? "photo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const path = `${clientId}/${repair.id}/${crypto.randomUUID()}-${safeName}`;
      const { error } = await admin.storage.from("repair-photos").upload(path, bytes.buffer as ArrayBuffer, { contentType });
      if (error) throw error;
      const { data: signed } = await admin.storage.from("repair-photos").createSignedUrl(path, 3600);
      return json({ path, url: signed?.signedUrl ?? null });
    }

    if (action === "delete_repair_photo") {
      const path = String(payload?.path ?? "");
      // Tenant prefix is the authorization: never delete outside this tenant's folder.
      if (!path.startsWith(`${clientId}/`) || path.includes("..")) return json({ error: "Invalid photo path." }, 400);
      const { error } = await admin.storage.from("repair-photos").remove([path]);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `Unknown action "${action}".` }, 400);
  } catch (e) {
    return json({ error: (e as Error).message ?? "Unexpected error." }, 400);
  }
}));
