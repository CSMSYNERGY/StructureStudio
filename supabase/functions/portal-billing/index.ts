import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Platform billing endpoint for the portal's Billing tab — CSM Synergy charging
// tenants for StructureStudio features via the Deposyt/NMI gateway.
//
// v2 model (2026-07-24): per-FEATURE subscriptions. Each feature (Simple Layout,
// On Demand Pricing, 3D View, …) is its own recurring subscription, chosen monthly
// or annual independently. Simple Layout is the required base. Checkout flow:
// Collect.js tokenizes the card once in the browser → we create an NMI Customer
// Vault record (billing_customers) → charge one one-time sale for any setup fees →
// start one recurring subscription per selected feature off the vault. The vault
// also lets a returning tenant add features without re-entering their card.
//
// Grandfathering: each subscription row snapshots price_cents at subscribe time,
// and NMI subscriptions keep their created terms — future price changes never
// touch existing (founding) subscriptions.
//
// Auth mirrors portal-settings (real user via auth.getUser() → client_users);
// owner/admin only, client_id never from the body.
//
// Actions:
//   { action: "status" } → { configured, hasCard, plans[], subscriptions[], checkout? }
//   { action: "subscribe", planIds: string[], paymentToken? }
//       paymentToken required unless a vault card is on file.
//   { action: "cancel", subscriptionId }
//
// Secrets: NMI_SECURITY_KEY, NMI_TOKENIZATION_KEY, optional NMI_GATEWAY_URL.

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

// POST to the gateway's Payment API. Form-urlencoded in/out; response=1 approved.
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

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: mapping, error: mapErr } = await admin
    .from("client_users")
    .select("client_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!mapping) return json({ error: "No business is linked to this account." }, 403);
  const clientId: string = mapping.client_id;

  if (mapping.role !== "owner" && mapping.role !== "admin") {
    return json({ error: "Billing is only available to the account owner or an admin." }, 403);
  }

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const action = payload?.action || "status";
  const configured = Boolean(SECURITY_KEY && TOKENIZATION_KEY);

  // All active plan rows — needed by every action (feature lookup for subs too).
  const { data: planRows, error: plansErr } = await admin
    .from("billing_plans")
    .select("id, feature, name, price_cents, billing_interval, gateway_plan_id, setup_fee_cents, availability, required, sort_order, price_visible")
    .eq("active", true)
    .order("sort_order", { ascending: false });
  if (plansErr) return json({ error: plansErr.message }, 500);
  const plans = planRows ?? [];
  const planById = new Map(plans.map((p) => [p.id, p]));

  // All subscription rows for this tenant, newest first (cancelled kept for history).
  const { data: subRows, error: subsErr } = await admin
    .from("billing_subscriptions")
    .select("id, plan_id, status, price_cents, current_period_start, current_period_end, canceled_at, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (subsErr) return json({ error: subsErr.message }, 500);
  const subs = subRows ?? [];
  const liveFeatures = new Set(
    subs.filter((s) => s.status !== "cancelled")
      .map((s) => planById.get(s.plan_id)?.feature)
      .filter(Boolean),
  );

  // Card on file? (NMI Customer Vault id — never sent to the browser.)
  const { data: vaultRow } = await admin
    .from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle();
  const vaultId: string | null = vaultRow?.vault_id ?? null;

  if (action === "status") {
    // gateway_plan_id stays server-side; everything else drives the UI — including
    // `price_visible`, which is a DISPLAY flag the Billing tab reads to decide whether
    // to print the amount. Prices themselves are untouched here and in the gateway;
    // hiding is deliberately presentation-only, so publishing a price later is a
    // one-field flip with no billing-path involvement.
    const publicPlans = plans.map(({ gateway_plan_id: _g, ...p }) => p);
    return json({
      configured,
      hasCard: Boolean(vaultId),
      plans: publicPlans,
      subscriptions: subs,
      checkout: configured
        ? { tokenizationKey: TOKENIZATION_KEY, collectJsUrl: `${GATEWAY}/token/Collect.js` }
        : null,
    });
  }

  if (!configured) {
    return json({ error: "Billing is not configured yet. Contact CSM Synergy." }, 503);
  }

  if (action === "subscribe") {
    const planIds: string[] = Array.isArray(payload?.planIds)
      ? payload.planIds.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [];
    const paymentToken = String(payload?.paymentToken || "").trim();
    if (planIds.length === 0) return json({ error: "Select at least one feature." }, 400);

    const chosen = planIds.map((id) => planById.get(id));
    if (chosen.some((p) => !p)) return json({ error: "Unknown plan in selection." }, 400);
    if (chosen.some((p) => p!.availability !== "available")) {
      return json({ error: "One of the selected features isn't available yet." }, 400);
    }
    const features = chosen.map((p) => p!.feature);
    if (new Set(features).size !== features.length) {
      return json({ error: "Pick either monthly or annual for each feature, not both." }, 400);
    }
    for (const f of features) {
      if (liveFeatures.has(f)) return json({ error: `You already have an active subscription for ${f}.` }, 409);
    }
    // Simple Layout is the required base — in the cart or already live.
    if (!features.includes("simple_layout") && !liveFeatures.has("simple_layout")) {
      return json({ error: "Simple Layout is the required base plan — add it to your selection." }, 400);
    }

    // Card: reuse the vault, or create it from a fresh Collect.js token.
    let vault = vaultId;
    if (!vault) {
      if (!paymentToken) return json({ error: "paymentToken is required (no card on file)." }, 400);
      let cust: Record<string, string>;
      try {
        cust = await nmiPost({
          customer_vault: "add_customer",
          payment_token: paymentToken,
          first_name: String(payload?.firstName || ""),
          last_name: String(payload?.lastName || ""),
          email: String(payload?.email || user.email || ""),
          merchant_defined_field_1: clientId,
        });
      } catch (e) {
        return json({ error: `Payment gateway error: ${(e as Error).message}` }, 402);
      }
      vault = cust.customer_vault_id;
      if (!vault) return json({ error: "Gateway did not return a customer vault id." }, 502);
      const { error: vErr } = await admin.from("billing_customers")
        .upsert({ client_id: clientId, vault_id: vault, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
      if (vErr) return json({ error: vErr.message }, 500);
    }

    // One-time setup fees (NULL = TBD = not charged yet, per the founding pricing).
    const setupTotal = chosen.reduce((s, p) => s + (p!.setup_fee_cents || 0), 0);
    if (setupTotal > 0) {
      try {
        await nmiPost({
          type: "sale",
          amount: (setupTotal / 100).toFixed(2),
          customer_vault_id: vault,
          orderid: `ss_setup_${clientId}`,
          order_description: `StructureStudio setup: ${features.join(", ")}`,
        });
      } catch (e) {
        return json({ error: `Setup fee charge failed: ${(e as Error).message}` }, 402);
      }
    }

    // One recurring subscription per feature, sequentially; report partial failures.
    const created: any[] = [];
    const failed: { planId: string; error: string }[] = [];
    for (const p of chosen) {
      try {
        const r = await nmiPost({
          recurring: "add_subscription",
          plan_id: p!.gateway_plan_id,
          customer_vault_id: vault,
          merchant_defined_field_1: clientId,
          orderid: `ss_${clientId}_${p!.id}`,
        });
        const subId = r.subscription_id || r.transactionid;
        const { data: row, error: insErr } = await admin
          .from("billing_subscriptions")
          .upsert({
            id: subId,
            client_id: clientId,
            plan_id: p!.id,
            price_cents: p!.price_cents,
            status: "active",
            current_period_start: new Date().toISOString(),
          }, { onConflict: "id" })
          .select("id, plan_id, status, price_cents, current_period_start, current_period_end, canceled_at, created_at")
          .maybeSingle();
        if (insErr) throw new Error(insErr.message);
        created.push(row);
      } catch (e) {
        failed.push({ planId: p!.id, error: (e as Error).message });
      }
    }
    if (created.length === 0) {
      return json({ error: `Subscription failed: ${failed.map((f) => f.error).join("; ")}` }, 402);
    }
    return json({ ok: true, created, failed });
  }

  if (action === "cancel") {
    const subscriptionId = String(payload?.subscriptionId || "").trim();
    if (!subscriptionId) return json({ error: "subscriptionId is required." }, 400);

    const owned = subs.find((s) => s.id === subscriptionId);
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
      .select("id, plan_id, status, price_cents, current_period_start, current_period_end, canceled_at, created_at")
      .maybeSingle();
    if (upErr) return json({ error: upErr.message }, 500);
    return json({ ok: true, subscription: row });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
});
