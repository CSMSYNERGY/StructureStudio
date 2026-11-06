/**
 * zoom-webhook — Zoom's event notifications for the Structure Studio Zoom app (migration 333).
 *
 * ⛔ verify_jwt MUST STAY FALSE: Zoom posts server-to-server and cannot send a Supabase JWT.
 * Auth is Zoom's own signature (`x-zm-signature`, HMAC-SHA256 with the app's Secret Token,
 * ZOOM_WEBHOOK_SECRET_TOKEN), checked before anything is read.
 *
 * Two events matter:
 *   endpoint.url_validation — Zoom proving the URL is ours when Carolyn saves it in the app.
 *   app_deauthorized        — somebody removed our app from their Zoom account. Zoom requires
 *                             a published app to act on this: we drop their tokens at once, and
 *                             their Settings page says "Reconnect" from then on.
 * Everything else is acknowledged and ignored.
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError } from "../_shared/logError.ts";
import { zoomUrlValidation, zoomVerifyWebhook } from "../_shared/zoomApi.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = (Deno.env.get("ZOOM_WEBHOOK_SECRET_TOKEN") || "").trim();
  if (!secret) return json({ error: "not configured" }, 503);

  const raw = await req.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad body" }, 400);
  }

  // Zoom signs the validation request too, so it gets the same check as every other event.
  const ok = await zoomVerifyWebhook(
    secret, req.headers.get("x-zm-request-timestamp"), req.headers.get("x-zm-signature"), raw,
  );
  if (!ok) return json({ error: "bad signature" }, 401);

  if (body?.event === "endpoint.url_validation") {
    const plain = String(body?.payload?.plainToken ?? "");
    if (!plain) return json({ error: "no token" }, 400);
    return json(await zoomUrlValidation(secret, plain));
  }

  if (body?.event === "app_deauthorized") {
    const zoomUserId = String(body?.payload?.user_id ?? "").slice(0, 120);
    if (zoomUserId) {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await admin.from("meeting_connections").update({
        status: "revoked",
        access_token: null,
        refresh_token: null,
        token_expires: null,
        last_error: "removed_at_zoom",
        updated_at: new Date().toISOString(),
      }).eq("provider", "zoom").eq("external_account_id", zoomUserId);
      if (error) {
        await logEdgeError({ fn: "zoom-webhook", req, code: "deauth", message: `Could not drop a deauthorised Zoom connection: ${error.message}` });
        // 5xx so Zoom retries: their tokens must not outlive the person's decision.
        return json({ error: "retry" }, 500);
      }
    }
  }
  return json({ ok: true });
});
