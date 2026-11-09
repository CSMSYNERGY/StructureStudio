import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { keepAlive, requestAutoTopup } from "../_shared/usageGate.ts";
import type { Wallet } from "./types.ts";
import { FN, makeHandler } from "./handler.ts";

// Jack, the AI agent behind the portal's Jack tab (migration 375). Deno.serve runs when this file is
// imported, so it holds only the serving and Jack's money (makeWallet, kept here on purpose: billing_test
// checks that the debit and the grant are written from this one file). The door itself (who may call,
// the routes, the role read, the store) is handler.ts, which handler_test.ts imports; what Jack decides
// is in agent.ts and the files beside it.

/** Jack's money, for billing.ts. The only service-role writes it makes: its own usage, at cost x the
 *  meter's markup, through the same idempotent debit the phone meters use, and the $50 welcome grant under
 *  one fixed key. Nothing here can reach a card. */
// deno-lint-ignore no-explicit-any
function makeWallet(admin: any, tenant: string): Wallet {
  return {
    async meter() {
      const { data, error } = await admin.from("usage_prices").select("active, markup").eq("kind", "jack_ai").maybeSingle();
      if (error) return null;
      return { active: data?.active === true, markup: data?.markup === null || data?.markup === undefined ? null : Number(data.markup) };
    },
    async exempt(clientId) {
      const a = await admin.from("wallet_accounts").select("metered_exempt").eq("client_id", clientId).maybeSingle();
      if (a.error) return null;
      if (a.data?.metered_exempt === true) return true;
      const c = await admin.from("client_settings").select("billing_exempt").eq("client_id", clientId).maybeSingle();
      if (c.error) return null;
      return c.data?.billing_exempt === true;
    },
    async account(clientId) {
      const { data, error } = await admin.from("wallet_accounts")
        .select("balance_cents, held_cents, usage_remainder_micros, auto_topup_enabled, auto_topup_threshold_cents").eq("client_id", clientId).maybeSingle();
      if (error) return null;
      return {
        balanceCents: Number(data?.balance_cents ?? 0), heldCents: Number(data?.held_cents ?? 0), remainderMicros: Number(data?.usage_remainder_micros ?? 0),
        autoTopup: data?.auto_topup_enabled === true, thresholdCents: data?.auto_topup_threshold_cents === null || data?.auto_topup_threshold_cents === undefined ? null : Number(data.auto_topup_threshold_cents),
      };
    },
    async debit(a) {
      const { data, error } = await admin.rpc("wallet_usage_debit", {
        p_client_id: a.clientId, p_meter_kind: "jack_ai", p_charge_micros: a.chargeMicros, p_cost_micros: a.costMicros,
        p_ref_type: a.refType, p_ref_id: a.refId, p_memo: a.memo.slice(0, 120), p_usage: a.usage, p_idem: a.key,
      });
      if (error) return { ok: false, txId: null };
      const row = Array.isArray(data) ? data[0] : data;
      return { ok: true, txId: row && row.tx_id !== undefined && row.tx_id !== null ? Number(row.tx_id) : null };
    },
    async grantOnce(clientId, cents, key, memo) {
      const { error } = await admin.rpc("wallet_credit", {
        p_client_id: clientId, p_amount_cents: cents, p_kind: "grant", p_ref_type: key, p_ref_id: null, p_memo: memo, p_idem: key, p_actor: null, p_meter_kind: null,
      });
      // A replay is a no-op answer, and a racing first grant is a unique-key refusal: both mean granted.
      return !error || String(error.code) === "23505";
    },
    requestTopup(clientId) {
      keepAlive(requestAutoTopup(clientId));
    },
    async mark(table, id, patch) {
      // A lost write must be heard: billing.ts logs jack_charge_mark, and the key stops a double charge.
      const { error } = await admin.from(table).update(patch).eq("id", id).eq("client_id", tenant);
      if (error) throw new Error("charge mark failed");
    },
    async pending(clientId, olderThanIso, limit) {
      const read = (table: "jack_messages" | "jack_proposals") => admin.from(table)
        .select("id, charge_micros, cost_micros, model, created_at").eq("client_id", clientId).eq("charge_state", "pending").lt("created_at", olderThanIso)
        .order("created_at", { ascending: true }).limit(limit);
      const [m, p] = await Promise.all([read("jack_messages"), read("jack_proposals")]);
      if (m.error || p.error) return [];
      // deno-lint-ignore no-explicit-any
      const rows = (t: "jack_messages" | "jack_proposals", d: any[]) => d.map((r) => ({ table: t, id: r.id, charge_micros: Number(r.charge_micros ?? 0), cost_micros: Number(r.cost_micros ?? 0), model: r.model ?? null, at: String(r.created_at ?? "") }));
      // Oldest first across both tables, so stuck answers can't hold back every price list read.
      return [...rows("jack_messages", m.data ?? []), ...rows("jack_proposals", p.data ?? [])]
        .sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit).map(({ at: _at, ...r }) => r);
    },
  };
}

Deno.serve(withErrorLog(FN, makeHandler({
  env: (k) => Deno.env.get(k),
  admin: (url, serviceKey) => createClient(url, serviceKey, { auth: { persistSession: false } }),
  resolveTenant,
  wallet: makeWallet,
  logEdgeError,
  fetch: (input, init) => fetch(input, init),
})));
