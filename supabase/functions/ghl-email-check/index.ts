import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { runGhlEmailChecks } from "../_shared/ghlEmailCheck.ts";

// GHL-EMAIL-CHECK: reads what became of a quote email after GHL accepted it, and files a row in
// app_errors when the email did not go (migration 357). _shared/ghlEmailCheck.ts holds the rules
// and says why they read status and error only.
//
// ⚠️ WHY IT IS CALLED BY THE PHONE WORKER: **pg_cron is not installed on this Supabase project.**
// The phone-api Worker's one-minute tick is the only real scheduler in the product;
// meeting-reminders and crm-rules-tick borrow it and so does this. If you move this off that tick,
// say where it runs in this comment.
//
// ── AUTH ─────────────────────────────────────────────────────────────────────────────────────
// Door 1: Authorization: Bearer <service role key> verbatim. Door 2: a gateway-verified JWT whose
// role is service_role. `verify_jwt = true` in config.toml is what makes door 2 safe: the gateway
// checked the signature before this function was entered. The same doors as crm-rules-tick, for
// the same reason: the only caller is the Worker, which holds the service key.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function jwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const pad = part.replace(/-/g, "+").replace(/_/g, "/");
    const body = JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
    return typeof body?.role === "string" ? body.role : null;
  } catch {
    return null;
  }
}

function callerAllowed(authorization: string | null): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  const presented = m ? m[1].trim() : "";
  if (!presented) return false;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && timingSafeEqual(presented, serviceKey)) return true;
  return jwtRole(presented) === "service_role";
}

Deno.serve(withErrorLog("ghl-email-check", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!callerAllowed(req.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const summary = await runGhlEmailChecks({
    db: admin,
    fetch: (input, init) => fetch(input, init),
    file: (row) => logEdgeError({ fn: "ghl-email-check", req, ...row }),
  });
  return json(summary, summary.ok ? 200 : 500);
}));
