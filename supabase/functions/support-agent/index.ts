import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { usableFeatureSet } from "../_shared/featureCheck.ts";
import { TITLES, type GateTable } from "../_shared/access.ts";
import { type AgentDeps, type AgentStore, handleEnabled, handleNew, handleSend, handleStatus, MAX_STORED_CHARS, type Totals } from "./agent.ts";

// The support assistant behind the portal's top-bar Support button (migration 340). Everything that
// decides anything is in agent.ts (agent_test.ts) and tools.ts (tools_test.ts); this file only wires
// them to the caller, the database, the environment and the error log.
//
// ══ WHO MAY CALL ══
// Any signed-in member of a builder's team, about their OWN account. verify_jwt = true
// (config.toml), and resolveTenant is the real gate: the bare anon key has no user and 401s there.
//   • The tenant comes from resolveTenant, never the body, and agent.ts hands only that tenant and
//     that user to the tools.
//   • An operator VIEWING another builder is refused with a plain sentence. support-agent is in the
//     portal's SS_TENANT_SCOPED_FNS, so a view-as call carries targetClientId and reaches the
//     operator branch here; answering it would mean the assistant reading a builder's account for
//     somebody else, and a chat filed under the operator. The button is hidden in view-as too.
//
// ══ ACTIONS ══
//   { action: "enabled" }                          { on }: client_settings.support_ai_beta (346)
//   { action: "status" }                           name, availability, the open chat
//   { action: "send", text, conversationId? }      one question, one answer
//   { action: "new" }                              close the open chat; the next send starts fresh
//
// Secrets: SUPPORT_ANTHROPIC_API_KEY (its own key, in a console workspace with a monthly spend
// limit; unset, ANTHROPIC_API_KEY, the one shared with phone-call-summary, answers instead),
// SUPPORT_AI_MODEL (optional, default claude-sonnet-5-5), SUPPORT_AI_MONTHLY_CAP_USD (optional,
// default 200). Changing any of them needs no redeploy beyond the secret itself.

const FN = "support-agent";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Every person on a team may ask for help. `send` and `new` write only the caller's own chat rows,
// keyed on the resolved user, never on a body-supplied id.
const GATES: GateTable = {
  enabled: "open",
  status: "open",
  send: "self",
  new: "self",
};

const TITLE_LABEL = new Map(TITLES.map((t) => [t.key as string, t.label]));

// deno-lint-ignore no-explicit-any
function makeStore(admin: any): AgentStore {
  const row = (r: { id: string; role: "user" | "assistant"; body: string; created_at: string }) =>
    ({ id: r.id, role: r.role, body: r.body, created_at: r.created_at });
  return {
    async enabled(clientId) {
      // A database without 346, or any read fault, is OFF (agent.ts: the switch fails closed).
      const { data, error } = await admin.from("client_settings").select("support_ai_beta").eq("client_id", clientId).maybeSingle();
      if (error) throw new Error("switch read failed");
      return data?.support_ai_beta === true;
    },
    async usage(who) {
      const { data, error } = await admin.rpc("support_usage", { p_client_id: who.clientId, p_user_id: who.userId });
      if (error || !data) return null;
      return { monthCostMicros: Number(data.month_cost_micros) || 0, tenant24h: Number(data.tenant_24h) || 0, user10m: Number(data.user_10m) || 0 };
    },
    async dailyCap(clientId) {
      const { data, error } = await admin.from("client_settings").select("support_ai_daily_cap").eq("client_id", clientId).maybeSingle();
      if (error) throw new Error("cap read failed");
      return data?.support_ai_daily_cap ?? null;
    },
    async openConversation(who, preferId) {
      let q = admin.from("support_conversations").select("id")
        .eq("client_id", who.clientId).eq("user_id", who.userId).eq("status", "open");
      if (preferId) q = q.eq("id", preferId);
      const { data, error } = await q.order("last_message_at", { ascending: false }).limit(1);
      if (error) throw new Error("conversation read failed");
      if (data && data[0]) return { id: data[0].id };
      // The named chat was not this person's open one: their newest open chat, if any.
      return preferId ? this.openConversation(who, null) : null;
    },
    async createConversation(who) {
      const { data, error } = await admin.from("support_conversations")
        .insert({ client_id: who.clientId, user_id: who.userId }).select("id").single();
      if (error || !data) throw new Error("conversation insert failed");
      return data.id;
    },
    async history(conversationId, limit) {
      const { data, error } = await admin.from("support_messages").select("id, role, body, created_at")
        .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error("history read failed");
      return (data ?? []).reverse().map(row);
    },
    async addMessage(m) {
      const t: Totals | undefined = m.totals;
      const { data, error } = await admin.from("support_messages").insert({
        conversation_id: m.conversationId, client_id: m.who.clientId, user_id: m.who.userId,
        role: m.role, body: String(m.body).slice(0, MAX_STORED_CHARS),
        tools: m.tools ?? [],
        input_tokens: t ? t.input : null, output_tokens: t ? t.output : null,
        cache_read_tokens: t ? t.cacheRead : null, cache_write_tokens: t ? t.cacheWrite : null,
        cost_micros: t ? t.costMicros : 0,
        stop_reason: m.stopReason ?? null, model: m.model ?? null,
      }).select("id, role, body, created_at").single();
      if (error || !data) throw new Error("message insert failed");
      return row(data);
    },
    async bumpConversation(id, d) {
      // Read-then-write: two answers landing in the same instant can undercount a total by one
      // turn. These are reporting totals; the caps read support_messages, never these.
      const { data } = await admin.from("support_conversations")
        .select("message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros").eq("id", id).maybeSingle();
      if (!data) return;
      const now = new Date().toISOString();
      await admin.from("support_conversations").update({
        message_count: (data.message_count || 0) + d.messages,
        input_tokens: Number(data.input_tokens || 0) + d.totals.input,
        output_tokens: Number(data.output_tokens || 0) + d.totals.output,
        cache_read_tokens: Number(data.cache_read_tokens || 0) + d.totals.cacheRead,
        cache_write_tokens: Number(data.cache_write_tokens || 0) + d.totals.cacheWrite,
        cost_micros: Number(data.cost_micros || 0) + d.totals.costMicros,
        model: d.model, updated_at: now, last_message_at: now,
      }).eq("id", id);
    },
    async closeConversations(who) {
      const { error } = await admin.from("support_conversations").update({ status: "closed", updated_at: new Date().toISOString() })
        .eq("client_id", who.clientId).eq("user_id", who.userId).eq("status", "open");
      if (error) throw new Error("close failed");
    },
    async sweep(days) {
      const before = new Date(Date.now() - days * 86_400_000).toISOString();
      await admin.from("support_conversations").delete().lt("last_message_at", before);
    },
    async accountLine(who) {
      const [me, cs] = await Promise.all([
        admin.from("client_users").select("full_name, title, role").eq("client_id", who.clientId).eq("user_id", who.userId).maybeSingle(),
        admin.from("client_settings").select("business_name").eq("client_id", who.clientId).maybeSingle(),
      ]);
      if (me.error || cs.error) throw new Error("account read failed");
      const first = String(me.data?.full_name || "").trim().split(/\s+/)[0] || null;
      const title = me.data?.title ? (TITLE_LABEL.get(me.data.title) ?? null) : (me.data?.role === "owner" ? "Owner" : null);
      return { firstName: first, title, business: cs.data?.business_name ?? null };
    },
  };
}

Deno.serve(withErrorLog(FN, async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Warm-up, the same shape as portal-feedback's: answers before auth, never reads the body.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "status" });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, userId, operator, payload, action, access } = r.ctx;

  if (operator) {
    return json({ error: "The assistant answers for your own account only. Exit the account you are viewing to use it." }, 403);
  }

  const who = { clientId, userId };
  const deps: AgentDeps = {
    env: (k) => Deno.env.get(k),
    store: makeStore(admin),
    toolCtx: { access, db: admin, features: (list) => usableFeatureSet(admin, clientId, list) },
    fetch: (input, init) => fetch(input, init),
    log: (e) => logEdgeError({ fn: FN, req, code: e.code, message: e.message, severity: e.severity, clientId: e.clientId ?? null, context: e.context ?? null }),
    now: () => Date.now(),
  };

  // deno-lint-ignore no-explicit-any
  const p: any = payload || {};
  if (action === "enabled") {
    const out = await handleEnabled(deps, who);
    return json(out.body, out.status);
  }
  if (action === "status") {
    const out = await handleStatus(deps, who);
    return json(out.body, out.status);
  }
  if (action === "send") {
    const out = await handleSend(deps, who, { text: p.text, conversationId: p.conversationId });
    return json(out.body, out.status);
  }
  if (action === "new") {
    const out = await handleNew(deps, who);
    return json(out.body, out.status);
  }
  return json({ error: "Unknown action." }, 400);
}));
