import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Platform billing endpoint for the portal's Billing tab — CSM Synergy charging
// tenants for StructureStudio via the Deposyt/NMI gateway (the BuildBridge stack:
// Collect.js tokenizes the card in the browser, we start/stop recurring plans that
// are preset in the gateway; card data never touches this server).
//
// Auth model mirrors portal-settings: verify_jwt only proves the caller holds *a*
// valid JWT (the anon key passes too), so we resolve a real user via auth.getUser()
// and map user → client through client_users (service role). client_id is NEVER
// taken from the body. ALL billing actions — including status — require the
// owner/admin role: plan/renewal data is the tenant's financial business.
//
// Actions:
//   { action: "status" }    → { configured, plans[], subscription|null, checkout? }
//     checkout = { tokenizationKey, collectJsUrl } — public Collect.js config,
//     present only when the gateway secrets are set.
//   { action: "subscribe", planId, paymentToken, firstName?, lastName?, email? }
//     → starts the recurring subscription in the gateway, records it locally.
//   { action: "cancel", subscriptionId } → cancels in the gateway, marks the row.
//
// Secrets (Supabase edge function secrets — absent = billing not configured):
//   NMI_SECURITY_KEY      private server-side gateway key (never sent to browser)
//   NMI_TOKENIZATION_KEY  public Collect.js key (safe to send to browser)
//   NMI_GATEWAY_URL       optional; defaults to https://deposyt.transactiongateway.com

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

const GATEWAY = (Deno.env.get("NMI_GATEWAY_URL") || "https://deposyt.transactiongateway.com").replace(/\/+$/, "");
const SECURITY_KEY = Deno.env.get("NMI_SECURITY_KEY") || "";
const TOKENIZATION_KEY = Deno.env.get("NMI_TOKENIZATION_KEY") || "";

// POST to the gateway's Payment API. NMI takes form-urlencoded input and returns a
// form-urlencoded body (response=1 approved | 2 declined | 3 error).
async function nmiPost(params: Record<string, string>) {
  const body = new URLSearchParams({ security_key: SECURITY_KEY, ...params });
  const res = await fetch(`${GATEWAY}/api/transact.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  const parsed = Object.fromEntries(new URLSearchParams(text));
  if (parsed.response !== "1") {
    throw new Error(parsed.responsetext || "transaction declined");
  }
  return parsed as Record<string, string>;
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

  // 2. Resolve the caller's tenant (service role; caller claims are not trusted).
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: mapping, error: mapErr } = await admin
    .from("client_users")
    .select("client_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!mapping) return json({ error: "No business is linked to this account." }, 403);
  const clientId: string = mapping.client_id;

  // 3. Billing is owner/admin only — every action, reads included.
  if (mapping.role !== "owner" && mapping.role !== "admin") {
    return json({ error: "Billing is only available to the account owner or an admin." }, 403);
  }

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = payload?.action || "status";
  const configured = Boolean(SECURITY_KEY && TOKENIZATION_KEY);

  // Latest subscription row for this tenant (newest first — cancelled rows stay for history).
  async function currentSubscription() {
    const { data, error } = await admin
      .from("billing_subscriptions")
      .select("id, plan_id, status, current_period_start, current_period_end, canceled_at, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  }

  if (action === "status") {
    const { data: plans, error: plansErr } = await admin
      .from("billing_plans")
      .select("id, name, price_cents, billing_interval, active, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: false });
    if (plansErr) return json({ error: plansErr.message }, 500);
    let subscription = null;
    try { subscription = await currentSubscription(); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
    return json({
      configured,
      plans: plans ?? [],
      subscription,
      // Public checkout config for Collect.js — only meaningful when configured.
      checkout: configured
        ? { tokenizationKey: TOKENIZATION_KEY, collectJsUrl: `${GATEWAY}/token/Collect.js` }
        : null,
    });
  }

  if (!configured) {
    return json({ error: "Billing is not configured yet. Contact CSM Synergy." }, 503);
  }

  if (action === "subscribe") {
    const planId = String(payload?.planId || "").trim();
    const paymentToken = String(payload?.paymentToken || "").trim();
    if (!planId) return json({ error: "planId is required." }, 400);
    if (!paymentToken) return json({ error: "paymentToken is required." }, 400);

    const { data: plan, error: planErr } = await admin
      .from("billing_plans")
      .select("id, gateway_plan_id, active")
      .eq("id", planId)
      .maybeSingle();
    if (planErr) return json({ error: planErr.message }, 500);
    if (!plan || !plan.active) return json({ error: "Unknown or inactive plan." }, 400);

    // One live subscription per tenant — cancel the old one before starting another.
    let existing = null;
    try { existing = await currentSubscription(); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
    if (existing && existing.status !== "cancelled") {
      return json({ error: "This account already has a subscription. Cancel it before starting a new one." }, 409);
    }

    let nmi: Record<string, string>;
    try {
      nmi = await nmiPost({
        recurring: "add_subscription",
        plan_id: plan.gateway_plan_id,
        payment_token: paymentToken,
        first_name: String(payload?.firstName || ""),
        last_name: String(payload?.lastName || ""),
        email: String(payload?.email || user.email || ""),
        // Tie the gateway subscription back to the tenant for webhooks/reporting.
        merchant_defined_field_1: clientId,
        orderid: `ss_${clientId}_${planId}`,
      });
    } catch (e) {
      return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
    }

    const subId = nmi.subscription_id || nmi.transactionid;
    const { data: row, error: insErr } = await admin
      .from("billing_subscriptions")
      .upsert({
        id: subId,
        client_id: clientId,
        plan_id: planId,
        status: "active",
        current_period_start: new Date().toISOString(),
      }, { onConflict: "id" })
      .select("id, plan_id, status, current_period_start, current_period_end, canceled_at, created_at")
      .maybeSingle();
    if (insErr) return json({ error: insErr.message }, 500);
    return json({ ok: true, subscription: row });
  }

  if (action === "cancel") {
    const subscriptionId = String(payload?.subscriptionId || "").trim();
    if (!subscriptionId) return json({ error: "subscriptionId is required." }, 400);

    // Verify the subscription belongs to this tenant before touching the gateway.
    const { data: owned, error: ownErr } = await admin
      .from("billing_subscriptions")
      .select("id, status")
      .eq("id", subscriptionId)
      .eq("client_id", clientId)
      .maybeSingle();
    if (ownErr) return json({ error: ownErr.message }, 500);
    if (!owned) return json({ error: "Subscription not found." }, 404);
    if (owned.status === "cancelled") return json({ error: "Already cancelled." }, 409);

    try {
      await nmiPost({ recurring: "delete_subscription", subscription_id: subscriptionId });
    } catch (e) {
      return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
    }

    const { data: row, error: upErr } = await admin
      .from("billing_subscriptions")
      .update({ status: "cancelled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", subscriptionId)
      .select("id, plan_id, status, current_period_start, current_period_end, canceled_at, created_at")
      .maybeSingle();
    if (upErr) return json({ error: upErr.message }, 500);
    return json({ ok: true, subscription: row });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
});
