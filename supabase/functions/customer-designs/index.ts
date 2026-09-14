import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { handle } from "./handler.ts";

// customer-designs: a signed-in customer's saved designs (migration 231). Everything — the three
// actions, the auth, and why a stranger cannot put a design into your account — is in handler.ts,
// which is kept free of jsr:/npm: imports so handler.test.ts runs with no network. This file only
// wires the real service-role client and error log into it.
//
// ⚠️ Apply migrations 230 AND 231 before deploying: handler.ts imports _shared/customerSession.ts
// (selects customer_sessions.email_lower, 230) and reads/writes customer_design_links (231).

Deno.serve(withErrorLog("customer-designs", (req: Request) =>
  handle(req, {
    admin: () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    log: logEdgeError,
    storageOrigin: Deno.env.get("SUPABASE_URL") ?? "",
  })
));
