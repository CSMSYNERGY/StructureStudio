import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Monday → Supabase sync for portal feedback (the return leg of portal-feedback).
//
// Subscribed to the Bugs Queue + Feature Requests boards for two events:
//   change_column_value  → the Status column moved; map it to the client-facing
//                          ladder and update the tenant's row.
//   create_update        → someone commented. It is mirrored to the tenant ONLY if
//                          the update starts with the /client marker. Unmarked
//                          updates are internal chatter and are DISCARDED here —
//                          they are never written to our database at all, so no
//                          later RLS or UI mistake can expose them. Do not "improve"
//                          this by storing everything with a visibility flag.
//
// Auth: Monday does not sign board-level webhooks created via the API, so the
// webhook URL carries a shared secret (?key=…) compared in constant time. That is
// why this function is deployed with verify_jwt=false — Monday cannot send a
// Supabase JWT. Rotate by updating the secret AND re-creating the webhooks.
//
// Required secrets: FEEDBACK_SYNC_SECRET, MONDAY_API_TOKEN (for author-name lookup).

// MIRROR: board ids / status column ids / STATUS_TO_CLIENT are duplicated in
// supabase/functions/portal-feedback/index.ts. Change both.
const BUG_BOARD = "18419456589";
const FEATURE_BOARD = "18420525473";
const BUG_STATUS_COL = "bug_status";
const FEATURE_STATUS_COL = "color_mm502bcj";

const STATUS_TO_CLIENT: Record<string, string> = {
  "Awaiting Review": "in_review",
  "Ready for Dev": "planned",
  "Move to 'Sprints'": "planned",
  "Known Bug": "in_review",
  "Fixing": "in_progress",
  "Pending Deploy": "in_progress",
  "Fixed": "shipped",
  "Missing Info": "needs_info",
  "Duplicated": "duplicate",
  "New": "submitted",
  "Under Review": "in_review",
  "Planned": "planned",
  "Shipped": "shipped",
  "Declined": "declined",
};

const CLIENT_MARKER = /^\s*\/client\b[:\s-]*/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Monday update bodies are HTML. Reduce to plain text before matching the marker,
// so a body that renders as "/client we shipped this" still matches when Monday
// wraps it in <p>…</p>, and so we never store markup in a tenant-visible field.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(s: string): string {
  return s
    // Numeric refs first (&#8212; / &#x2014;) — Monday's editor emits these freely.
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; is decoded LAST via the named pass so "&amp;lt;" doesn't become "<".
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED_ENTITIES[String(name).toLowerCase()];
      return v === undefined ? m : v;
    });
}

function htmlToText(html: string): string {
  return decodeEntities(
    String(html ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function mondayUserName(token: string | undefined, userId: unknown): Promise<string> {
  if (!token || !userId) return "Structure Studio";
  try {
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
      body: JSON.stringify({
        query: `query ($ids: [ID!]) { users (ids: $ids) { name } }`,
        variables: { ids: [String(userId)] },
      }),
    });
    const body = await res.json();
    return body?.data?.users?.[0]?.name || "Structure Studio";
  } catch {
    return "Structure Studio";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json({ ok: true, service: "feedback-monday-webhook" });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("FEEDBACK_SYNC_SECRET");
  const token = Deno.env.get("MONDAY_API_TOKEN");
  if (!secret) {
    console.error("FEEDBACK_SYNC_SECRET not configured");
    return new Response("Server not configured", { status: 500 });
  }

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  // ── Scheduled reconcile ───────────────────────────────────────────────────
  // {"action":"sync_all"} — pulls status + /client updates for every open
  // submission across all tenants. Run by pg_cron every 10 minutes.
  //
  // WHY this exists rather than trusting the webhooks alone: on 2026-07-26 a live
  // status change made through the Monday API produced NO webhook delivery (Monday
  // appears to suppress events caused by the same token that owns the webhook).
  // UI-driven changes are expected to fire normally, but "expected to" is not a
  // guarantee worth putting a client-facing promise on. The webhook gives near-instant
  // updates when it fires; this poll guarantees convergence within ~10 minutes either
  // way. Keep both.
  if (payload?.action === "sync_all") {
    const key2 = new URL(req.url).searchParams.get("key") || "";
    if (!timingSafeEqual(key2, secret)) return new Response("Unauthorized", { status: 401 });
    if (!token) return json({ ok: false, error: "MONDAY_API_TOKEN not configured" }, 500);
    const admin2 = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: rows } = await admin2.from("feedback_submissions")
      .select("id, monday_item_id, status")
      .not("monday_item_id", "is", null)
      .not("status", "in", "(shipped,declined)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (!rows || !rows.length) return json({ ok: true, checked: 0, statusChanges: 0, newComments: 0 });

    const byItem = new Map(rows.map((r: any) => [String(r.monday_item_id), r]));
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
      body: JSON.stringify({
        query: `query ($ids: [ID!]) { items (ids: $ids) {
          id column_values { id text } updates (limit: 50) { id text_body created_at creator { name } } } }`,
        variables: { ids: rows.map((r: any) => r.monday_item_id) },
      }),
    });
    const body2 = await res.json();
    if (body2.errors) return json({ ok: false, error: JSON.stringify(body2.errors) }, 502);

    let statusChanges = 0, newComments = 0;
    for (const it of body2?.data?.items ?? []) {
      const row2 = byItem.get(String(it.id));
      if (!row2) continue;
      const cell = (it.column_values ?? []).find(
        (c: any) => c.id === BUG_STATUS_COL || c.id === FEATURE_STATUS_COL,
      );
      const mapped = cell?.text ? STATUS_TO_CLIENT[cell.text] : undefined;
      if (mapped && mapped !== row2.status) {
        const now2 = new Date().toISOString();
        await admin2.from("feedback_submissions")
          .update({ status: mapped, status_changed_at: now2, updated_at: now2 }).eq("id", row2.id);
        statusChanges++;
      }
      for (const u of it.updates ?? []) {
        const t = u.text_body ?? "";
        if (!CLIENT_MARKER.test(t)) continue;      // internal chatter — never stored
        const ins = await admin2.from("feedback_comments").upsert({
          submission_id: row2.id,
          monday_update_id: String(u.id),
          author_name: u.creator?.name ?? "Structure Studio",
          body: t.replace(CLIENT_MARKER, "").trim(),
          created_at: u.created_at ?? new Date().toISOString(),
        }, { onConflict: "monday_update_id", ignoreDuplicates: true }).select();
        if (ins.data && ins.data.length) newComments++;
      }
    }
    console.log(`sync_all: checked ${rows.length}, ${statusChanges} status changes, ${newComments} new comments`);
    return json({ ok: true, checked: rows.length, statusChanges, newComments });
  }

  // Monday's webhook handshake: it POSTs {challenge} once when the webhook is created
  // and expects it echoed back. This happens BEFORE any key check would be meaningful
  // to Monday, but our URL already carries the key, so verify first either way.
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!timingSafeEqual(key, secret)) {
    console.warn("feedback-monday-webhook: bad key");
    return new Response("Unauthorized", { status: 401 });
  }
  if (payload?.challenge) return json({ challenge: payload.challenge });

  const ev = payload?.event;
  if (!ev) return json({ ok: true, ignored: "no event" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  if (!itemId) return json({ ok: true, ignored: "no item id" });

  // Only items this portal created are mirrored; anything else on those boards
  // (a bug the team filed itself, a GitHub-funnelled issue) has no row and is skipped.
  const { data: row } = await admin
    .from("feedback_submissions").select("id, status").eq("monday_item_id", itemId).maybeSingle();
  if (!row) return json({ ok: true, ignored: "item not portal-sourced" });

  const type = ev.type;

  // ── Status change ─────────────────────────────────────────────────────────
  if (type === "change_column_value" || type === "change_status_column_value") {
    const boardId = String(ev.boardId ?? "");
    const expectedCol = boardId === FEATURE_BOARD ? FEATURE_STATUS_COL
      : boardId === BUG_BOARD ? BUG_STATUS_COL : null;
    if (!expectedCol || ev.columnId !== expectedCol) {
      return json({ ok: true, ignored: "not the status column" });
    }
    const label = ev.value?.label?.text ?? ev.value?.label ?? null;
    const mapped = typeof label === "string" ? STATUS_TO_CLIENT[label] : undefined;
    if (!mapped) {
      // Unknown/cleared label: leave the tenant's status as-is rather than inventing one.
      console.log("Unmapped Monday status label:", label);
      return json({ ok: true, ignored: "unmapped label" });
    }
    if (mapped === row.status) return json({ ok: true, unchanged: true });
    const now = new Date().toISOString();
    const upd = await admin.from("feedback_submissions")
      .update({ status: mapped, status_changed_at: now, updated_at: now }).eq("id", row.id);
    if (upd.error) return json({ ok: false, error: upd.error.message }, 500);
    return json({ ok: true, status: mapped });
  }

  // ── Comment ───────────────────────────────────────────────────────────────
  if (type === "create_update" || type === "edit_update") {
    const text = htmlToText(ev.textBody ?? ev.body ?? "");
    if (!CLIENT_MARKER.test(text)) {
      return json({ ok: true, ignored: "internal update (no /client marker)" });
    }
    const updateId = String(ev.updateId ?? ev.replyId ?? "");
    if (!updateId) return json({ ok: true, ignored: "no update id" });
    const authorName = await mondayUserName(token, ev.userId);
    const res = await admin.from("feedback_comments").upsert({
      submission_id: row.id,
      monday_update_id: updateId,
      author_name: authorName,
      body: text.replace(CLIENT_MARKER, "").trim(),
    }, { onConflict: "monday_update_id" });
    if (res.error) return json({ ok: false, error: res.error.message }, 500);
    await admin.from("feedback_submissions")
      .update({ updated_at: new Date().toISOString() }).eq("id", row.id);
    return json({ ok: true, comment: updateId });
  }

  return json({ ok: true, ignored: "event:" + type });
});
