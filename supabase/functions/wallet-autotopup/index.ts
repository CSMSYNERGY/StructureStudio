import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog } from "../_shared/logError.ts";
import { autoTopupCallerAllowed, runAutoTopup } from "../_shared/walletAutoTopup.ts";

// The automatic wallet top-up, as a door other runtimes can knock on (migration 259).
//
// Phone usage is charged after the fact by the Worker's usage cron, and texts and calls are
// refused below the wallet floor. Both moments can leave a tenant under their auto top-up
// threshold, and neither runs where the card gateway lives: the Worker has no NMI secrets, and
// the SMS refusal is in shared code the Worker also bundles. So both POST here, and this runs
// _shared/walletAutoTopup.ts — the very code portal-settings runs after a 3D hold. Threshold,
// cooldown, card on file and the decline switch-off are decided there, once, for everyone.
//
// ══ WHO MAY CALL ══
// Server-to-server only, never a browser. The bearer must equal the edge runtime's own
// SUPABASE_SERVICE_ROLE_KEY (what an edge function sends via usageGate.requestAutoTopup) or
// WALLET_AUTOTOPUP_SECRET when that secret is set — see autoTopupCallerAllowed for why there are
// two. ⚠️ FOR THE WORKER'S CALLS, set WALLET_AUTOTOPUP_SECRET on the Supabase project to the
// exact value of the Worker's SUPABASE_SERVICE_ROLE_KEY: the Worker holds its own key, and it is
// not safe to assume it is byte-identical to the one this runtime is given.
//
// verify_jwt = true (supabase/config.toml), so the gateway refuses a bare request before this
// runs, and a service-role JWT passes it. ⚠️ A NEW-FORMAT `sb_secret_…` KEY IS NOT A JWT and the
// gateway 401s it before any code here runs — nothing logged on this side. If the Worker's key
// is that format, its calls fail at the gateway (the Worker logs the 401); the fix is
// verify_jwt = false for this function, which is safe because the check below is the real gate.
//
// Body: { client_id }. Answer: { fired, ok, reason } — fixed strings only. The gateway's decline
// text and anything about the card stay in app_errors, never in this response.
//
// Always 200 once authenticated and well-formed, including a decline: the function did its job,
// and runAutoTopup has already filed anything worth a human's attention under this function's
// name. A caller logs only a non-200.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(withErrorLog("wallet-autotopup", async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const allowed = autoTopupCallerAllowed(req.headers.get("authorization"), {
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    secret: Deno.env.get("WALLET_AUTOTOPUP_SECRET") ?? "",
  });
  if (!allowed) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  const clientId = typeof body?.client_id === "string" ? body.client_id.trim() : "";
  // Tenant ids are short slugs. Anything longer is not one, and is not worth a database read.
  if (!clientId || clientId.length > 100) return json({ error: "client_id is required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Awaited, not backgrounded: this request IS the background task for whoever called it, and a
  // sale dropped mid-flight leaves a closed_unknown that blocks every later top-up.
  const out = await runAutoTopup(admin, clientId, req, { fn: "wallet-autotopup" });
  return json({ fired: out.fired, ok: out.ok, reason: out.reason });
}));
