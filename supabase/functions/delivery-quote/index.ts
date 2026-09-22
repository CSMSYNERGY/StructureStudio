// delivery-quote — "how far, and what would delivery cost" for ONE address, for the designer.
//
// Carolyn 2026-09-14: when a builder automates delivery, the customer should see the fee in
// the designer "once they enter their address". The designer posts the address here as the
// form fills in; the answer is what submit-estimate will charge, because both call the same
// _shared/deliveryQuote.ts against the same whole-mile cache (235). Nothing is priced twice.
//
// PUBLIC IN PRACTICE — the anon key passes the gateway (config.toml keeps verify_jwt = true so a
// bare request is still refused early), so the real guards are body validation, a tenant
// existence check, and two rate caps (per tenant, per IP) counted in rate_buckets (204), the
// capture-lead / submit-estimate shape. An answer is a number, never a secret: the rules are the
// builder's own, and the miles are the miles.
//
// WHO IS ASKING matters only for origin_mode = rep: the embedded (portal) designer sends the
// signed-in rep's JWT with the request, and that rep's home lot (234) becomes the origin. The
// public designer sends the bare anon key, which has no subject, and reads as "no rep".

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { clientIp } from "../_shared/adminGate.ts";
import { hasSubject } from "../_shared/jwtSubject.ts";
import { quoteDelivery } from "../_shared/deliveryQuote.ts";

// Caps. The designer debounces to one call per settled address, so a real customer produces
// single digits per minute; a rep testing addresses in the portal a few dozen. Per-IP is the
// tighter one because an anonymous flood comes from few addresses and the per-tenant cap alone
// would let it exhaust a builder's Google budget.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_TENANT = 60;
const RATE_MAX_PER_IP = 20;
const RATE_LOG_CEILING = 2;   // log the first two breaches per window, then stay quiet

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Count first, then decide (the submit-estimate lesson: refusing before incrementing freezes
// the counter at the cap and turns the breach log into the flood's amplifier). Fails OPEN on any
// storage error — a bad read must not blank every delivery figure on every designer.
// deno-lint-ignore no-explicit-any
async function overCap(admin: any, bucket: string, max: number): Promise<{ over: boolean; hits: number }> {
  const nowMs = Date.now();
  const { data: rl, error } = await admin.from("rate_buckets").select("window_started_at, hits").eq("bucket", bucket).maybeSingle();
  if (error) return { over: false, hits: 0 };
  const startedAt = rl?.window_started_at ? Date.parse(String(rl.window_started_at)) : NaN;
  const inWindow = Number.isFinite(startedAt) && (nowMs - startedAt) < RATE_WINDOW_MS;
  const hits = (inWindow ? (Number(rl?.hits) || 0) : 0) + 1;
  await admin.from("rate_buckets").upsert({
    bucket,
    window_started_at: inWindow ? rl!.window_started_at : new Date(nowMs).toISOString(),
    hits,
    updated_at: new Date(nowMs).toISOString(),
  }, { onConflict: "bucket" });
  return { over: hits > max, hits };
}

Deno.serve(withErrorLog("delivery-quote", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const clientId = typeof body?.clientId === "string" ? body.clientId.trim().slice(0, 120) : "";
  if (!clientId) return json({ error: "Missing clientId" }, 400);
  const a = (body?.address && typeof body.address === "object") ? body.address : {};
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const address = { street: str(a.street, 200), city: str(a.city, 100), state: str(a.state, 60), zip: str(a.zip, 12) };

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // The tenant must exist (the public RPCs' guard). An unknown slug is a 404, not a quote.
  const { data: cfg } = await admin.from("client_configs").select("client_id").eq("client_id", clientId).maybeSingle();
  if (!cfg) return json({ error: "Unknown builder." }, 404);

  // Not ready is not an error: the designer asks as the form fills, and a half-typed address
  // simply has no answer yet. City/state/zip are the floor Google can route to; street sharpens it.
  if (!address.city || !address.state || !address.zip) return json({ ok: true, ready: false });

  const ip = clientIp(req);
  const [byTenant, byIp] = await Promise.all([
    overCap(admin, `delivery-quote:${clientId}`, RATE_MAX_PER_TENANT),
    overCap(admin, `delivery-quote:ip:${ip}`, RATE_MAX_PER_IP),
  ]);
  if (byTenant.over || byIp.over) {
    const which = byIp.over ? byIp : byTenant;
    const max = byIp.over ? RATE_MAX_PER_IP : RATE_MAX_PER_TENANT;
    if (which.hits <= max + RATE_LOG_CEILING) {
      await logEdgeError({
        fn: "delivery-quote", req, clientId, code: "rate_limited",
        message: `delivery-quote rate cap hit — ${which.hits} lookups in ${RATE_WINDOW_MS / 1000}s (${byIp.over ? "per IP" : "per tenant"}); refused`,
        context: { hits: which.hits, limit: max, windowMs: RATE_WINDOW_MS, perIp: byIp.over },
      }).catch(() => {});
    }
    return json({ error: "Too many delivery lookups right now. Wait a minute and try again.", retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000) }, 429);
  }

  // The rep, if any — one auth round trip, and only when the token actually carries a subject.
  let repUserId: string | null = null;
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token && hasSubject(token)) {
      const { data: userData } = await admin.auth.getUser(token);
      repUserId = userData?.user?.id ?? null;
    }
  } catch { repUserId = null; }

  const [q, cs] = await Promise.all([
    quoteDelivery(admin, { clientId, address, repUserId }),
    admin.from("client_settings").select("show_pricing").eq("client_id", clientId).maybeSingle(),
  ]);
  // show_pricing off nulls the money and keeps the miles — get_config's own rule for rates.
  const showPricing = cs.data?.show_pricing === true;
  return json({
    ok: true,
    ready: true,
    configured: q.configured,
    automate: q.automate,
    miles: q.miles,
    originName: q.originName,
    fee: showPricing ? q.amount : null,
    autoPriced: q.autoPriced,
    reason: q.reason,
    desc: q.desc,
    taxable: q.taxable,
  });
}));
