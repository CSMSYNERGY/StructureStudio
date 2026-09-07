import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { timingSafeEqual } from "../_shared/emailInbound.ts";

// Bug / feature intake from our OTHER products — FramedUp, BuildBridge, CSM Studio.
//
// Carolyn 2026-09-07. Those apps embedded a Monday.com WorkForm in an iframe (CSM Studio
// had nothing); retiring Monday would have killed the button in two live apps, and an
// iframe leaves no record here and cannot attribute a submission to a person. They now
// file onto the same Projects boards the builder submissions land on, tagged by App.
//
// ══ THE ONE INVARIANT ══
// THE APP IS THE CREDENTIAL. Each product holds its own shared secret; the secret that
// opens the door decides which app the submission is filed as. A body field naming the
// app is IGNORED — not validated, not preferred, ignored — so a caller with FramedUp's
// secret cannot file as Structure Studio however it shapes its request. Carolyn's
// requirement was "I don't want any clients to choose the app; we should automatically
// know", and a value the caller supplies is a value the caller chooses. Same doctrine as
// portal-feedback, where the tenant comes from the verified session and never the body.
//
// verify_jwt = false: the three callers are SEPARATE Supabase projects and cannot mint a
// JWT this project would accept. The shared secret IS the authentication — same shape as
// email-inbound / sms-inbound / feedback-monday-webhook. ⚠️ Flip verify_jwt to true and
// the gateway 401s every call BEFORE this code runs: nothing stored, nothing logged,
// invisible from inside the database. That is how billing-webhook broke for months.
//
// Never called from a browser. Each app posts from its own server (a Supabase function of
// its own, or its Express worker), so the secret never reaches a bundle.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/** slug -> { env var holding that app's secret, label on the boards' App dropdown }.
 *  Labels must match the pm_columns "App" options (migration 161) and the APP_LABELS map
 *  in portal-feedback — matched BY LABEL so option ids stay editable in the UI. */
const APPS: Record<string, { env: string; label: string }> = {
  "framedup": { env: "APP_FEEDBACK_SECRET_FRAMEDUP", label: "Framed UP" },
  "buildbridge": { env: "APP_FEEDBACK_SECRET_BUILDBRIDGE", label: "BuildBridge" },
  "csm-studio": { env: "APP_FEEDBACK_SECRET_CSMSTUDIO", label: "CSM Studio" },
};

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_APP = 20;
const RATE_LOG_CEILING = RATE_MAX_PER_APP + 2;
const MAX_FILE_BYTES = 5_000_000;
const EXT_BY_CT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

Deno.serve(withErrorLog("app-feedback", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Who is calling: resolved from the secret, never from the body ─────────
  const key = new URL(req.url).searchParams.get("key") ?? "";
  let app: string | null = null;
  for (const [slug, cfg] of Object.entries(APPS)) {
    const secret = Deno.env.get(cfg.env) ?? "";
    // An unset secret must never match — timingSafeEqual("","") is TRUE, so the emptiness
    // check is the real gate (_shared/emailInbound.test.ts asserts exactly that). Every
    // app is compared even after a hit, so the work does not vary with which secret won.
    if (secret && timingSafeEqual(key, secret)) app = slug;
  }
  if (!app) return json({ error: "unauthorized" }, 401);
  const appCfg = APPS[app];

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // ── Rate cap, per app ────────────────────────────────────────────────────
  // Increment FIRST, then decide: refusing before the write freezes hits at exactly the
  // cap, which makes the [MAX+1, MAX+2] log window true on every refused request and turns
  // the breach log into the flood's amplifier (submit-estimate:376-420). Fails OPEN — one
  // bad read must not silence a whole product's bug reporting.
  const nowMs = Date.now();
  const bucket = `app-feedback:${app}`;
  const { data: rl, error: rlErr } = await admin.from("rate_buckets")
    .select("window_started_at, hits").eq("bucket", bucket).maybeSingle();
  if (!rlErr) {
    const startedAt = rl?.window_started_at ? Date.parse(String(rl.window_started_at)) : NaN;
    const inWindow = Number.isFinite(startedAt) && (nowMs - startedAt) < RATE_WINDOW_MS;
    const nextHits = (inWindow ? (Number(rl?.hits) || 0) : 0) + 1;
    await admin.from("rate_buckets").upsert({
      bucket,
      window_started_at: inWindow ? rl!.window_started_at : new Date(nowMs).toISOString(),
      hits: nextHits,
      updated_at: new Date(nowMs).toISOString(),
    }, { onConflict: "bucket" });
    if (nextHits > RATE_MAX_PER_APP) {
      if (nextHits <= RATE_LOG_CEILING) {
        console.error(`app-feedback rate cap hit for ${app} — ${nextHits} in ${RATE_WINDOW_MS / 1000}s`);
      }
      return json({ error: "Too many reports at once. Please wait a minute and send it again." }, 429);
    }
  }

  // ── Validate. Everything capped and coerced; nothing trusted ─────────────
  const kind = payload.kind === "feature" ? "feature" : payload.kind === "bug" ? "bug" : null;
  if (!kind) return json({ error: "kind must be 'bug' or 'feature'." }, 400);
  const title = str(payload.title, 250);
  if (!title) return json({ error: "A title is required." }, 400);
  const detail = str(payload.detail, 8000);
  const severity = str(payload.severity, 40);
  // Who reported it, as resolved by the CALLING APP from its own verified session. This
  // side cannot check it — that is the calling function's job, and each one derives it
  // from its own auth rather than from its own request body.
  const submitterName = str(payload.submitterName, 120) || "Unknown";
  const submitterEmail = str(payload.submitterEmail, 200) || null;
  // Which customer OF THAT APP (BuildBridge's GHL location, CSM Studio's user id).
  const sourceRef = str(payload.sourceRef, 120) || null;

  // ── Optional screenshot ──────────────────────────────────────────────────
  // Base64 through the function, unlike the builder widget's direct browser upload: these
  // callers are servers with no session this project's storage RLS would recognise, so the
  // write is service-role. Hence the smaller cap. NON-FATAL by design — the report is worth
  // more than the screenshot, the same rule the Monday attachment leg follows.
  let attachmentPath: string | null = null;
  if (typeof payload.fileBase64 === "string" && payload.fileBase64.trim()) {
    try {
      const ct = String(payload.fileContentType || "image/png");
      const ext = EXT_BY_CT[ct];
      if (!ext) throw new Error(`unsupported type ${ct}`);
      const bytes = Uint8Array.from(
        atob(payload.fileBase64.replace(/^data:[^;]+;base64,/, "")),
        (c) => c.charCodeAt(0),
      );
      if (bytes.length > MAX_FILE_BYTES) throw new Error("larger than 5MB");
      // The path is minted HERE, never accepted from the caller. The `app/` prefix cannot
      // collide with a tenant slug folder, and no browser role can read it (054's storage
      // policies key on the first segment being the reader's own client_id) — these are
      // internal reports, so a service-role read via the Projects drawer is the only path.
      const safe = str(payload.fileName, 80).replace(/[^\w.\-]+/g, "_") || `screenshot.${ext}`;
      const path = `app/${app}/${crypto.randomUUID()}-${safe}`;
      const up = await admin.storage.from("feedback-attachments")
        .upload(path, bytes, { contentType: ct, upsert: false });
      if (up.error) throw up.error;
      attachmentPath = path;
    } catch (e) {
      console.error("app-feedback attachment failed for", app, e instanceof Error ? e.message : String(e));
    }
  }

  // ── File it ──────────────────────────────────────────────────────────────
  // client_id stays NULL: a FramedUp user is not a tenant here, and NULL never satisfies
  // the RLS predicate, so no builder can ever see another product's reports (161).
  const ins = await admin.from("feedback_submissions").insert({
    client_id: null,
    source_app: app,
    source_ref: sourceRef,
    submitter_name: submitterName,
    submitter_email: submitterEmail,
    kind,
    title,
    detail: detail || null,
    severity: severity || null,
    attachment_path: attachmentPath,
    status: "submitted",
  }).select().single();
  if (ins.error) return json({ error: ins.error.message }, 500);

  // Onto the board. No Monday push, deliberately: these are born in Projects, which is the
  // whole point of moving them off the WorkForms.
  await mirrorToProjects(admin, ins.data, appCfg.label);

  return json({ ok: true, id: ins.data.id, app });
}));

// Same shape as portal-feedback's mirror — board by slug, group by `intake`, columns by
// TYPE + NAME never uuid (seed ids are per-environment) — with the App label passed in
// rather than derived from a tenant. Best-effort: a mirror failure must not lose a report
// that is already safely stored above.
// deno-lint-ignore no-explicit-any
async function mirrorToProjects(admin: any, row: any, appLabel: string): Promise<void> {
  try {
    const { data: board } = await admin.from("pm_boards").select("id")
      .eq("slug", row.kind === "feature" ? "features" : "bugs").maybeSingle();
    if (!board) return;
    const { data: groups } = await admin.from("pm_groups")
      .select("id, intake, position").eq("board_id", board.id).order("position");
    const group = (groups || []).find((g: { intake: boolean }) => g.intake) || (groups || [])[0];
    if (!group) return;
    const { data: cols } = await admin.from("pm_columns").select("*").eq("board_id", board.id);
    const values: Record<string, unknown> = {};
    for (const c of cols || []) {
      if (c.type === "status") {
        const labels = c.settings?.labels || [];
        // deno-lint-ignore no-explicit-any
        const intake = labels.find((l: any) => l.intake === true) || labels[0];
        if (intake) values[c.id] = intake.id;
      } else if (c.type === "dropdown" && c.name === "App") {
        // deno-lint-ignore no-explicit-any
        const opt = (c.settings?.options || []).find((o: any) => o.label === appLabel);
        if (opt) values[c.id] = [opt.id];
      } else if (c.type === "date" && c.name === "Date") {
        values[c.id] = new Date().toISOString().slice(0, 10);
      } else if (c.type === "dropdown" && c.name === "Priority" && row.severity) {
        // deno-lint-ignore no-explicit-any
        const opt = (c.settings?.options || []).find((o: any) => o.label === row.severity);
        if (opt) values[c.id] = [opt.id];
      }
      // No "Client" branch on purpose: these carry no tenant.
    }
    const { data: maxRow } = await admin.from("pm_items").select("position")
      .eq("group_id", group.id).order("position", { ascending: false }).limit(1).maybeSingle();
    await admin.from("pm_items").insert({
      board_id: board.id,
      group_id: group.id,
      name: String(row.title || "").slice(0, 200),
      values,
      position: (maxRow?.position || 0) + 1024,
      feedback_submission_id: row.id,
      created_by_email: row.submitter_email || null,
    });
  } catch (e) {
    console.error("Projects mirror failed for app submission", row.id, e instanceof Error ? e.message : String(e));
  }
}
