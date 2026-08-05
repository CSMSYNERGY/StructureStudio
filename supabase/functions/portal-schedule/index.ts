import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";

// Build Schedule + Delivery Schedule (Load Planner) + Repairs backend.
// Spec: SCHEDULING_SCOPE.md (mockup approved by Carolyn 2026-08-04).
//
// Auth: resolveTenant — JWT → auth.getUser() → client_users; clientId is NEVER read from
// the body (operators use targetClientId + app_operators, with can_write gating).
//
// Action gating (three tiers, enforced by resolveTenant):
//   READ  (any linked role): build_board, loads, pool, list_repairs, list_drivers, repair_photos
//   STAFF (any linked role — the shop floor keeps the board live, every move logged):
//         move_job, add_note, mark_stop_delivered
//   ADMIN (owner/admin; operator needs can_write): everything else.
//
// Invariants owned here (not the browser):
//   * A load cannot go out/delivered while any stop's build job stage isn't kind='done' —
//     unless an admin overrides with a required reason (audit-logged, stamped on the load,
//     rendered as a permanent chip). Staff single-stop delivery has NO override path.
//   * A building physically wider than the load's max_width_ft is REJECTED — no override;
//     the remedy is a different truck or fixed specs.
//   * Order build jobs mint their shop serial via take_next_serial() LAST, after all
//     validation — a rejected payload must not burn a number (075's rule).
//   * Marking an order's stop delivered sets designs.status='delivered' + delivered_at
//     (the fence in sync-design-status ships with the Delivery tab UI — Phase 4).

const READ_ACTIONS = new Set(["build_board", "loads", "pool", "list_repairs", "list_drivers", "repair_photos"]);
const STAFF_ACTIONS = new Set(["move_job", "add_note", "mark_stop_delivered"]);

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
function buildingLabelFrom(selections: Record<string, unknown> | null | undefined): string {
  const style = titleCase((selections as Record<string, unknown>)?.buildingStyle ?? "");
  const size = String((selections as Record<string, unknown>)?.buildingSize ?? "");
  return [style, size].filter(Boolean).join(" ").trim();
}

Deno.serve(withErrorLog("portal-schedule", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const r = await resolveTenant(req, admin, {
    readActions: READ_ACTIONS,
    staffActions: STAFF_ACTIONS,
    defaultAction: "build_board",
  });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, payload, action, userId, audit } = r.ctx;
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

  // Team names for rendering (assignees, drivers, activity) — one query each.
  const getTeam = async () => {
    const { data: members, error } = await admin
      .from("client_users").select("user_id, role").eq("client_id", clientId);
    if (error) throw error;
    const ids = (members ?? []).map((m) => m.user_id);
    let names: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await admin.from("user_profiles").select("user_id, full_name").in("user_id", ids);
      names = Object.fromEntries((profs ?? []).map((p) => [p.user_id, p.full_name || ""]));
    }
    return (members ?? []).map((m) => ({ userId: m.user_id, role: m.role || "user", name: names[m.user_id] || "" }));
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

  // Stops whose linked build job is not in a kind='done' stage (the built check).
  // deno-lint-ignore no-explicit-any
  const unbuiltStops = async (loadId: string): Promise<any[]> => {
    const { data: stops, error } = await admin
      .from("delivery_stops").select("id, stop_order, serial, customer_name, build_job_id")
      .eq("client_id", clientId).eq("load_id", loadId).not("build_job_id", "is", null);
    if (error) throw error;
    if (!stops?.length) return [];
    const jobIds = stops.map((s) => s.build_job_id);
    const { data: jobs, error: jErr } = await admin
      .from("build_jobs").select("id, stage_id, due_date").in("id", jobIds);
    if (jErr) throw jErr;
    const stageIds = [...new Set((jobs ?? []).map((j) => j.stage_id))];
    const { data: stages, error: sErr } = await admin
      .from("schedule_stages").select("id, kind, name").in("id", stageIds);
    if (sErr) throw sErr;
    const kindOf = Object.fromEntries((stages ?? []).map((s) => [s.id, s]));
    const jobById = Object.fromEntries((jobs ?? []).map((j) => [j.id, j]));
    return stops.filter((s) => {
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
  };

  const recomputeWide = async (loadId: string) => {
    const { data: stops } = await admin
      .from("delivery_stops").select("width_ft").eq("client_id", clientId).eq("load_id", loadId);
    const isWide = (stops ?? []).some((s) => Number(s.width_ft) > WIDE_FT);
    await admin.from("delivery_loads").update({ is_wide: isWide, updated_at: new Date().toISOString() })
      .eq("id", loadId).eq("client_id", clientId);
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

      // Unscheduled tray: sold orders / available units / open repairs with no job yet.
      const haveDesign = new Set((jobs ?? []).map((j) => j.design_short_code).filter(Boolean));
      const haveUnit = new Set((jobs ?? []).map((j) => j.inventory_unit_id).filter(Boolean));
      const haveRepair = new Set((jobs ?? []).map((j) => j.repair_id).filter(Boolean));
      const { data: soldDesigns } = await admin
        .from("designs").select("short_code, contact, selections, status")
        .eq("client_id", clientId).in("status", ["accepted", "invoiced"]).is("inventory_unit_id", null)
        .limit(500);
      const { data: units } = await admin
        .from("inventory_units").select("id, serial, design_short_code, status")
        .eq("client_id", clientId).eq("status", "available").limit(500);
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
        })),
        repairs: (openRepairs ?? []).filter((rp) => !haveRepair.has(rp.id)).map((rp) => ({
          repairId: rp.id, repairNo: rp.repair_no, customerName: rp.customer_name,
          description: rp.description, serial: rp.serial, status: rp.status,
        })),
      };
      return json({ stages, jobs: jobs ?? [], stopByJob, tray, team: await getTeam() });
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
      return json({
        loads: loads ?? [],
        stops: stops ?? [],
        buildByJob,
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
        .from("delivery_stops").select("build_job_id, inventory_unit_id, repair_id, design_short_code, delivered_at")
        .eq("client_id", clientId);
      const stopJob = new Set((stops ?? []).map((s) => s.build_job_id).filter(Boolean));
      const stopRepair = new Set((stops ?? []).map((s) => s.repair_id).filter(Boolean));

      const stagesAll = await getStages();
      const stageById = Object.fromEntries(stagesAll.map((s) => [s.id, s]));
      const { data: jobsAll } = await admin
        .from("build_jobs").select("*").eq("client_id", clientId).neq("source", "repair").limit(500);
      const jobs = (jobsAll ?? []).filter((j) => !stopJob.has(j.id)).map((j) => ({
        buildJobId: j.id, source: j.source, serial: j.serial, customerName: j.customer_name,
        title: j.title, buildingLabel: j.building_label, widthFt: j.width_ft, lengthFt: j.length_ft,
        designShortCode: j.design_short_code, inventoryUnitId: j.inventory_unit_id,
        buildStage: stageById[j.stage_id]?.name ?? null,
        buildKind: stageById[j.stage_id]?.kind ?? null,
        dueDate: j.due_date, completedAt: j.completed_at,
        wide: Number(j.width_ft) > WIDE_FT,
      }));

      const { data: sold } = await admin
        .from("inventory_units").select("id, serial, design_short_code, sold_design_short_code, location_id, status")
        .eq("client_id", clientId).eq("status", "sold").limit(500);
      const { data: locs } = await admin
        .from("builder_locations").select("id, name, city").eq("client_id", clientId);
      const locById = Object.fromEntries((locs ?? []).map((l) => [l.id, l]));
      // A sold unit needs its SALE delivery unless one already exists (the stop carrying
      // the buyer's design code) or the unit is actively on a load right now.
      const inventory = (sold ?? []).filter((u) => !(stops ?? []).some((s) =>
        s.inventory_unit_id === u.id &&
        (!s.delivered_at || (u.sold_design_short_code && s.design_short_code === u.sold_design_short_code))
      )).map((u) => ({
        inventoryUnitId: u.id, serial: u.serial, designShortCode: u.design_short_code,
        location: locById[u.location_id ?? ""] ?? null,
      }));

      const { data: openRepairs } = await admin
        .from("repairs").select("id, repair_no, customer_name, description, serial, status")
        .eq("client_id", clientId).in("status", ["requested", "approved", "in_progress"]).limit(500);
      const repairs = (openRepairs ?? []).filter((rp) => !stopRepair.has(rp.id));

      // `orders` kept as an alias of `jobs` for one deploy cycle (the page may be older
      // than this function); remove after the next beta→main promotion.
      return json({ jobs, orders: jobs, inventory, repairs, territories: await getTerritories(), drivers: await getDrivers() });
    }

    if (action === "list_drivers") {
      return json({ team: await getTeam(), drivers: await getDrivers(), territories: await getTerritories() });
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
      if (stop.build_job_id) {
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

      let mintSerial = false;
      if (source === "order") {
        const code = str(payload?.designShortCode);
        if (!code) return json({ error: "designShortCode is required for an order job." }, 400);
        const { data: design, error } = await admin
          .from("designs").select("short_code, contact, selections, status")
          .eq("client_id", clientId).eq("short_code", code).maybeSingle();
        if (error) throw error;
        if (!design) return json({ error: "That design isn't in your account." }, 404);
        row.design_short_code = design.short_code;
        row.customer_name = row.customer_name ?? str((design.contact as Record<string, unknown>)?.name);
        row.building_label = row.building_label ?? str(buildingLabelFrom(design.selections as Record<string, unknown>));
        const dims = parseSize((design.selections as Record<string, unknown>)?.buildingSize);
        row.width_ft = row.width_ft ?? dims.widthFt;
        row.length_ft = row.length_ft ?? dims.lengthFt;
        mintSerial = true;
      } else if (source === "inventory") {
        const unit = await requireRow("inventory_units", payload?.inventoryUnitId, "Inventory unit");
        row.inventory_unit_id = unit.id;
        row.serial = unit.serial;
        row.design_short_code = null; // the unit's master design is reachable via the unit
        if (!row.building_label && unit.design_short_code) {
          const { data: master } = await admin.from("designs").select("selections")
            .eq("client_id", clientId).eq("short_code", unit.design_short_code).maybeSingle();
          row.building_label = str(buildingLabelFrom(master?.selections as Record<string, unknown>));
          const dims = parseSize((master?.selections as Record<string, unknown>)?.buildingSize);
          row.width_ft = row.width_ft ?? dims.widthFt;
          row.length_ft = row.length_ft ?? dims.lengthFt;
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

    if (action === "save_driver") {
      const targetUserId = payload?.userId;
      if (!isUuid(targetUserId)) return json({ error: "Invalid user id." }, 400);
      const { data: member } = await admin.from("client_users").select("user_id")
        .eq("client_id", clientId).eq("user_id", targetUserId).maybeSingle();
      if (!member) return json({ error: "That person isn't on your team." }, 404);
      const territoryIds = Array.isArray(payload?.territoryIds) ? payload.territoryIds.filter(isUuid) : [];
      if (territoryIds.length) {
        const { data: owned } = await admin.from("delivery_territories").select("id")
          .eq("client_id", clientId).in("id", territoryIds);
        if ((owned ?? []).length !== territoryIds.length) return json({ error: "Unknown territory." }, 400);
      }
      const row = {
        client_id: clientId,
        user_id: targetUserId,
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
      const { data, error } = await admin.from("driver_profiles")
        .upsert(row, { onConflict: "client_id,user_id" }).select("*").single();
      if (error) throw error;
      return json({ driver: data });
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
      if (payload?.driverUserId) {
        if (!isUuid(payload.driverUserId)) return json({ error: "Invalid driver id." }, 400);
        const { data: prof } = await admin.from("driver_profiles").select("*")
          .eq("client_id", clientId).eq("user_id", payload.driverUserId).maybeSingle();
        if (!prof?.is_driver || !prof.active) return json({ error: "That person isn't set up as a driver — add their truck in Settings → Team." }, 400);
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
      if ("driverUserId" in payload) {
        if (payload.driverUserId === null) {
          patch.driver_user_id = null; patch.deck_length_ft = null; patch.max_width_ft = null;
        } else {
          if (!isUuid(payload.driverUserId)) return json({ error: "Invalid driver id." }, 400);
          const { data: prof } = await admin.from("driver_profiles").select("*")
            .eq("client_id", clientId).eq("user_id", payload.driverUserId).maybeSingle();
          if (!prof?.is_driver || !prof.active) return json({ error: "That person isn't set up as a driver." }, 400);
          // No override for physics: every existing stop must fit the new truck.
          if (prof.max_width_ft != null) {
            const { data: stops } = await admin.from("delivery_stops").select("width_ft, serial")
              .eq("client_id", clientId).eq("load_id", load.id);
            const tooWide = (stops ?? []).find((s) => Number(s.width_ft) > Number(prof.max_width_ft));
            if (tooWide) return json({ error: `Building #${tooWide.serial ?? "?"} is ${tooWide.width_ft}' wide — too wide for that truck (max ${prof.max_width_ft}').` }, 400);
          }
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
        const dims = parseSize((design.selections as Record<string, unknown>)?.buildingSize);
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
        if (unit.status === "sold" && unit.sold_design_short_code) {
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
          const dims = parseSize((master?.selections as Record<string, unknown>)?.buildingSize);
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
        quote_cents: num(payload?.quoteCents),
        notes: str(payload?.notes),
        created_by: userId,
      };
      if (payload?.inventoryUnitId) {
        const unit = await requireRow("inventory_units", payload.inventoryUnitId, "Inventory unit");
        row.inventory_unit_id = unit.id;
        row.serial = row.serial ?? unit.serial;
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
