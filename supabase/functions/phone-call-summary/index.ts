import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { handleSummaryRequest } from "./summary.ts";

// A recorded call's summary (My Synergy Phone, migration 263). The phone-api Worker transcribes
// the call and POSTs {recording_id} here, because ANTHROPIC_API_KEY lives in Supabase secrets
// only. Everything that decides anything is in summary.ts (tested in tests/phone); this file
// only wires it to the database, the environment, the network and the error log.
//
// ══ WHO MAY CALL ══
// Server-to-server only, never a browser: the bearer must be this runtime's
// SUPABASE_SERVICE_ROLE_KEY, or PHONE_SUMMARY_SECRET when that is set (set it to the exact value
// of the Worker's SUPABASE_SERVICE_ROLE_KEY: the Worker holds its own key, and it is not safe to
// assume it is byte-identical to this runtime's), or a service_role JWT the gateway has verified.
// verify_jwt = true (supabase/config.toml) is what makes that last one proof: with it off, the
// role claim is forgeable by anyone. A new-format `sb_secret_…` key is not a JWT and the gateway
// 401s it before this runs; then set PHONE_SUMMARY_SECRET to the Worker's key, change summary.ts
// to gatewayVerified: false, and only then turn verify_jwt off (the config.toml note).
//
// ⚠️ NO TRANSCRIPT AND NO SUMMARY IN ANY LOG OR ANSWER. The answers are fixed strings, and every
// fault is a code, a status and the recording's id (summary.ts).

const FN = "phone-call-summary";

Deno.serve(withErrorLog(FN, (req: Request) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  return handleSummaryRequest(req, {
    env: (k) => Deno.env.get(k),
    rpc: async (name, args) => {
      const { data, error } = await admin.rpc(name, args);
      return { data, error };
    },
    update: async (id, patch, onlyIf) => {
      const { error } = await admin.from("phone_call_recordings").update(patch).eq("id", id).eq("summary_status", onlyIf);
      return { error };
    },
    fetch: (input, init) => fetch(input, init),
    log: (e) => logEdgeError({ fn: FN, req, code: e.code, message: e.message, severity: e.severity, clientId: e.clientId ?? null, context: e.context ?? null }),
    now: () => new Date(),
  });
}));
