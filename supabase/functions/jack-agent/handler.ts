import { type GateTable, TITLES } from "../_shared/access.ts";
import type { PortalCall } from "./apply.ts";
import type { Totals } from "./claude.ts";
import type { FnCall, MemoryRow, Wallet } from "./types.ts";
import { handleMemoryForget, handleMemoryPick, handleMemorySet } from "./memory.ts";
// "Sent by Mike with Jack" (378): the stamp lives in sends.ts so its tests drive it; it gets the
// service-role client here.
import { makeSentWithJack } from "./sends.ts";
import {
  forViewer,
  type Deps, handleActivity, handleEnabled, handleNew, handleOpenChat, handleProposalAnswer, handleProposalApprove, handleProposalCancel, handleProposalGet,
  handleProposalUndo, handleSend, handleSetSwitches, handleSheetStart, handleStatus, jsonSafe, MAX_STORED_CHARS, type ProposalRow, type Reply, type Store, type StoredMessage, type Who,
} from "./agent.ts";

// Jack's HTTP door, without the serving (11-09). index.ts is Deno.serve(withErrorLog(...)) around
// makeHandler, plus Jack's money (makeWallet, handed in), so this file can be imported by a test
// (handler_test.ts): the gate table, the routes, the role read and the store's queries all run there
// against fakes. Everything that decides anything else
// is in agent.ts and the files beside it; this file only wires them to the caller, the database, the
// environment and the error log.
//
// ══ WHO MAY CALL ══
// A signed-in person holding the `jack` area (owners and admins by preset), about the account resolveTenant
// says. verify_jwt = true (config.toml), and resolveTenant is the real gate. An operator viewing a builder
// comes through as that builder (Ahsan, 11-03): the approval names the builder and the record names the
// operator. Every read and save of the builder's catalog goes through portal-settings with the caller's
// own token, so that function's gates decide it again.
//
// Secrets: JACK_ANTHROPIC_API_KEY (its own console workspace with its own spend limit, Ahsan 11-05; unset,
// Jack says it isn't available and never falls back to another key), JACK_AI_MODEL (optional, default
// claude-sonnet-5-5 for chat; price lists always read on Opus, sheetAi.ts), JACK_AI_MONTHLY_CAP_USD
// (optional, default 500, keep it at or under the console limit).

export const FN = "jack-agent";
/** A worker dies at 400 s whatever it's doing, and this request may not be its first (the runtime's
 *  per-worker wall clock). A long read is budgeted from here: the module loads when the worker starts. */
const WORKER_BORN_MS = Date.now();

/** Actions that change something. Everything else is a read, and gives up sooner. resend_quote_email
 *  emails the customer (sends.ts): at the read's 20 s it would give up on an email still going out. */
export const WRITE_ACTION = /^(save|delete|create|update|set|toggle|upload|crm_rule_save|crm_send|reorder|import|complete|move|add_stop|remove_stop|mark_|stage_order_attribute_change|send_change_order|void_change_order|request_order_unlock|resend_quote_email)/;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const JACK = { area: "jack", level: "edit" } as const;
// A read-only operator can open the tab and read what happened; every write still answers 403 there.
// `jack` has only none and edit, so for anyone else these are the same check.
const JACK_READ = { area: "jack", level: "view" } as const;
export const GATES: GateTable = {
  enabled: "open",
  status: JACK_READ,
  chat: JACK,
  send: JACK,
  new: JACK,
  sheet_start: JACK,
  proposal_get: JACK_READ,
  proposal_answer: JACK,
  proposal_cancel: JACK,
  proposal_approve: JACK,
  proposal_undo: JACK,
  activity: JACK_READ,
  set_switches: JACK,
  memory_pick: JACK,
  memory_set: JACK,
  memory_forget: JACK,
};

/** The actions that need to know whether this person decides for the whole builder. */
export const ASKS_ROLE = new Set(["status", "set_switches", "memory_pick", "memory_set", "memory_forget"]);

// deno-lint-ignore no-explicit-any
type Route = (deps: Deps, who: Who, role: string | null, p: any) => Promise<Reply>;
/** Every action Jack answers, and the handler it goes to. GATES has the same keys (handler_test.ts). */
export const ROUTES: Record<string, Route> = {
  enabled: (d, w) => handleEnabled(d, w),
  status: (d, w, role) => handleStatus(d, w, role),
  chat: (d, w, _r, p) => handleOpenChat(d, w, p),
  send: (d, w, _r, p) => handleSend(d, w, p),
  new: (d, w) => handleNew(d, w),
  sheet_start: (d, w, _r, p) => handleSheetStart(d, w, p),
  proposal_get: (d, w, _r, p) => handleProposalGet(d, w, p),
  proposal_answer: (d, w, _r, p) => handleProposalAnswer(d, w, p),
  proposal_cancel: (d, w, _r, p) => handleProposalCancel(d, w, p),
  proposal_approve: (d, w, _r, p) => handleProposalApprove(d, w, p),
  proposal_undo: (d, w, _r, p) => handleProposalUndo(d, w, p),
  activity: (d, w) => handleActivity(d, w),
  set_switches: (d, w, role, p) => handleSetSwitches(d, w, role, p),
  memory_pick: (d, w, role, p) => handleMemoryPick(d, w, role, p),
  memory_set: (d, w, role, p) => handleMemorySet(d, w, role, p),
  memory_forget: (d, w, role, p) => handleMemoryForget(d, w, role, p),
};

/** Who decides for the whole builder, for the actions that ask (ASKS_ROLE). Every other action is null
 *  and reads nothing: `enabled` runs on every portal load and stays one read. An operator viewing the
 *  builder counts as its owner. One wearing a person is that person, so the screen and the refusal are
 *  what that person gets: the read is keyed by selfUserId. A failed read gives no role, which refuses. */
export async function roleFor(action: string, operator: { asUserId: string | null } | null, read: () => Promise<{ role: string | null }>): Promise<string | null> {
  if (!ASKS_ROLE.has(action)) return null;
  if (operator && !operator.asUserId) return "owner";
  return (await read().catch(() => ({ role: null }))).role;
}

const TITLE_LABEL = new Map(TITLES.map((t) => [t.key as string, t.label]));

// deno-lint-ignore no-explicit-any
export function makeStore(admin: any): Store {
  const msg = (r: { id: string; role: "user" | "assistant"; body: string; created_at: string; proposal_ids: string[] | null }): StoredMessage =>
    ({ id: r.id, role: r.role, body: r.body, created_at: r.created_at, proposal_ids: r.proposal_ids ?? [] });
  const MSG = "id, role, body, created_at, proposal_ids";
  // The history read also brings each answer's tool names and stop reason: an answer that repeated a
  // customer's words is marked in its tools, and the next turn starts locked (agent.ts lockedByLastReply).
  // agent.ts takes both off again before a message reaches the page.
  const HISTORY = `${MSG}, tools, stop_reason`;
  return {
    async settings(clientId) {
      const { data, error } = await admin.from("client_settings").select("jack_on, jack_off").eq("client_id", clientId).maybeSingle();
      if (error) throw new Error("switch read failed");
      return { on: data?.jack_on === true, off: Array.isArray(data?.jack_off) ? data.jack_off.map(String) : [] };
    },
    async setOff(clientId, off) {
      const { error } = await admin.from("client_settings").update({ jack_off: off }).eq("client_id", clientId);
      if (error) throw new Error("switch write failed");
    },
    async usage(who) {
      // A failed read throws, and the caps refuse on it (agent.ts usageOf): it's never "no usage". The
      // function always answers an object, with zeros for a builder who hasn't used Jack yet.
      const { data, error } = await admin.rpc("jack_usage", { p_client_id: who.clientId, p_user_id: who.userId });
      if (error || !data || typeof data !== "object") throw new Error("usage read failed");
      return { monthCostMicros: Number(data.month_cost_micros) || 0, tenant24h: Number(data.tenant_24h) || 0, user10m: Number(data.user_10m) || 0, sheets24h: Number(data.sheets_24h) || 0 };
    },
    async openChat(who, preferId) {
      let q = admin.from("jack_conversations").select("id").eq("client_id", who.clientId).eq("user_id", who.userId).eq("status", "open");
      if (preferId) q = q.eq("id", preferId);
      const { data, error } = await q.order("last_message_at", { ascending: false }).limit(1);
      if (error) throw new Error("chat read failed");
      if (data && data[0]) return { id: data[0].id };
      return preferId ? this.openChat(who, null) : null;
    },
    async createChat(who, title) {
      const { data, error } = await admin.from("jack_conversations").insert({ client_id: who.clientId, user_id: who.userId, title: jsonSafe(title.slice(0, 120)) }).select("id").single();
      if (error || !data) throw new Error("chat insert failed");
      return data.id;
    },
    async chats(who, limit) {
      const { data, error } = await admin.from("jack_conversations").select("id, title, status, last_message_at")
        .eq("client_id", who.clientId).eq("user_id", who.userId).order("last_message_at", { ascending: false }).limit(limit);
      if (error) throw new Error("chats read failed");
      return data ?? [];
    },
    async messages(who, chatId, limit) {
      // Matched on the person as well as the chat: someone else's id reads as not there.
      const { data: chat, error: e1 } = await admin.from("jack_conversations").select("id").eq("id", chatId).eq("client_id", who.clientId).eq("user_id", who.userId).maybeSingle();
      if (e1) throw new Error("chat read failed");
      if (!chat) return null;
      const { data, error } = await admin.from("jack_messages").select(HISTORY).eq("conversation_id", chatId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error("history read failed");
      // deno-lint-ignore no-explicit-any
      return (data ?? []).reverse().map((r: any) => ({ ...msg(r), tools: Array.isArray(r.tools) ? r.tools.map(String) : [], stop_reason: r.stop_reason ?? null }));
    },
    async addMessage(m) {
      const t: Totals | undefined = m.totals;
      const { data, error } = await admin.from("jack_messages").insert({
        conversation_id: m.chatId, client_id: m.who.clientId, user_id: m.who.userId,
        role: m.role, body: jsonSafe(String(m.body).slice(0, MAX_STORED_CHARS)),
        tools: m.tools ?? [], proposal_ids: m.proposalIds ?? [],
        input_tokens: t ? t.input : null, output_tokens: t ? t.output : null,
        cache_read_tokens: t ? t.cacheRead : null, cache_write_tokens: t ? t.cacheWrite : null,
        cost_micros: t ? t.costMicros : 0, stop_reason: m.stopReason ?? null, model: m.model ?? null,
        ...(m.charge ? { charge_state: m.charge.state, charge_micros: m.charge.micros } : {}),
      }).select(MSG).single();
      if (error || !data) throw new Error("message insert failed");
      return msg(data);
    },
    async bumpChat(id, d) {
      const { data } = await admin.from("jack_conversations").select("message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros").eq("id", id).maybeSingle();
      if (!data) return;
      const now = new Date().toISOString();
      await admin.from("jack_conversations").update({
        message_count: (data.message_count || 0) + d.messages,
        input_tokens: Number(data.input_tokens || 0) + d.totals.input,
        output_tokens: Number(data.output_tokens || 0) + d.totals.output,
        cache_read_tokens: Number(data.cache_read_tokens || 0) + d.totals.cacheRead,
        cache_write_tokens: Number(data.cache_write_tokens || 0) + d.totals.cacheWrite,
        cost_micros: Number(data.cost_micros || 0) + d.totals.costMicros,
        ...(d.model ? { model: d.model } : {}), updated_at: now, last_message_at: now,
      }).eq("id", id);
    },
    async closeChats(who) {
      const { error } = await admin.from("jack_conversations").update({ status: "closed", updated_at: new Date().toISOString() })
        .eq("client_id", who.clientId).eq("user_id", who.userId).eq("status", "open");
      if (error) throw new Error("close failed");
    },
    async reopenChat(who, chatId) {
      await this.closeChats(who);
      const { data, error } = await admin.from("jack_conversations").update({ status: "open", updated_at: new Date().toISOString() })
        .eq("id", chatId).eq("client_id", who.clientId).eq("user_id", who.userId).select("id");
      if (error) throw new Error("reopen failed");
      return (data ?? []).length > 0;
    },
    async accountLine(who) {
      const [me, cs] = await Promise.all([
        admin.from("client_users").select("full_name, title, role").eq("client_id", who.clientId).eq("user_id", who.userId).maybeSingle(),
        admin.from("client_settings").select("business_name").eq("client_id", who.clientId).maybeSingle(),
      ]);
      if (me.error || cs.error) throw new Error("account read failed");
      const first = String(me.data?.full_name || "").trim().split(/\s+/)[0] || null;
      const title = me.data?.title ? (TITLE_LABEL.get(me.data.title) ?? null) : (me.data?.role === "owner" ? "Owner" : null);
      return { firstName: first, title, business: cs.data?.business_name ?? null, role: me.data?.role ?? null };
    },
    async insertProposal(p) {
      const { data, error } = await admin.from("jack_proposals").insert(jsonSafe(p)).select("*").single();
      if (error || !data) throw new Error("proposal insert failed");
      return data as ProposalRow;
    },
    async getProposal(clientId, id) {
      const { data, error } = await admin.from("jack_proposals").select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
      if (error) throw new Error("proposal read failed");
      return data as ProposalRow | null;
    },
    // ⚠️ THE DOUBLE-PRESS GUARD. Approve and Undo claim a card with this: one UPDATE that lands only while
    // the row still stands at one of whenStatus (and, for Approve, at the updated_at it was read with), so
    // of two presses only one gets the row back
    // (tests/sql/jackProposalClaim.test.cjs runs the same statement on Postgres).
    async updateProposal(clientId, id, patch, whenStatus, whenUpdatedAt) {
      let q = admin.from("jack_proposals").update({ ...jsonSafe(patch), updated_at: new Date().toISOString() }).eq("id", id).eq("client_id", clientId);
      if (whenStatus) q = q.in("status", whenStatus);
      if (whenUpdatedAt) q = q.eq("updated_at", whenUpdatedAt);
      const { data, error } = await q.select("*");
      if (error) throw new Error("proposal write failed");
      return (data && data[0]) ? data[0] as ProposalRow : null;
    },
    async clearOldPrivate(clientId, beforeIso) {
      const { data, error } = await admin.rpc("jack_clear_old_private", { p_client: clientId, p_before: beforeIso });
      if (error) throw new Error("clear old private cards failed");
      return Number(data ?? 0);
    },
    async addProposalCost(clientId, id, totals, model) {
      await admin.from("jack_proposals").update({ input_tokens: totals.input, output_tokens: totals.output, cost_micros: totals.costMicros, model }).eq("id", id).eq("client_id", clientId);
    },
    async proposals(clientId, limit) {
      // Three parts of the preview rather than all of it: the activity page lists 100 of these and never
      // draws a table. Its "See what changed" asks for that one card. And the parts of the payload a
      // card's areas are worked out from (lookups.ts lookupArea: area, also, cleared; setup.ts
      // setup_company: calls.save), so the page lists a card only to someone who may read it. They stay
      // on the server: proposalView never answers with a payload.
      const { data, error } = await admin.from("jack_proposals")
        .select("id, client_id, user_id, conversation_id, kind, status, title, file_name, counts:preview->counts, fixture:preview->fixture, skipped:preview->skipped, p_area:payload->area, p_also:payload->also, p_cleared:payload->cleared, p_save:payload->calls->save, result, shown_hash, failure, approved_by, approved_by_operator, undone_by, approved_at, applied_at, undone_at, expires_at, created_at, updated_at")
        .eq("client_id", clientId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error("activity read failed");
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map(({ counts, fixture, skipped, p_area, p_also, p_cleared, p_save, ...r }: any) => ({
        ...r, preview: { counts, fixture, skipped }, undo: null,
        payload: { area: p_area ?? null, also: p_also ?? null, cleared: p_cleared ?? null, calls: { save: p_save ?? null } },
      })) as ProposalRow[];
    },
    async proposalsById(clientId, ids) {
      const { data, error } = await admin.from("jack_proposals").select("*").eq("client_id", clientId).in("id", ids);
      if (error) throw new Error("proposal read failed");
      return (data ?? []) as ProposalRow[];
    },
    async names(clientId, userIds) {
      if (!userIds.length) return {};
      const { data, error } = await admin.from("client_users").select("user_id, full_name").eq("client_id", clientId).in("user_id", userIds);
      if (error) throw new Error("names read failed");
      // deno-lint-ignore no-explicit-any
      const out: Record<string, string> = Object.fromEntries((data ?? []).map((r: any) => [r.user_id, r.full_name || "Someone on your team"]));
      // An operator has no row on the builder's team, and the record still names them.
      const missing = userIds.filter((id) => !out[id]);
      if (missing.length) {
        const ops = await admin.from("app_operators").select("user_id, email").in("user_id", missing);
        // deno-lint-ignore no-explicit-any
        for (const o of (ops.data ?? []) as any[]) out[o.user_id] = `${o.email} (Structure Studio team)`;
      }
      return out;
    },
    async fixtureStamp(clientId, id) {
      const { data, error } = await admin.from("fixture_items").select("updated_at").eq("id", id).eq("client_id", clientId).maybeSingle();
      if (error) throw new Error("door read failed");
      return data?.updated_at ?? null;
    },
    async memory(clientId) {
      const { data, error } = await admin.from("jack_memory").select("key, value, set_by, set_by_operator, updated_at").eq("client_id", clientId);
      if (error) throw new Error("memory read failed");
      return (data ?? []) as MemoryRow[];
    },
    async putMemory(clientId, key, value, by, basedOn) {
      const row = { value: jsonSafe(value), set_by: by.userId, set_by_operator: by.operatorEmail, updated_at: new Date().toISOString() };
      if (basedOn === null) {
        // Unset when the question was asked: insert, and a row someone else wrote first wins.
        const { data, error } = await admin.from("jack_memory").upsert({ client_id: clientId, key, ...row }, { onConflict: "client_id,key", ignoreDuplicates: true }).select("key");
        if (error) throw new Error("memory write failed");
        return (data ?? []).length > 0;
      }
      const { data, error } = await admin.from("jack_memory").update(row).eq("client_id", clientId).eq("key", key).eq("updated_at", basedOn).select("key");
      if (error) throw new Error("memory write failed");
      return (data ?? []).length > 0;
    },
    async forgetMemory(clientId, key, basedOn) {
      const { data, error } = await admin.from("jack_memory").delete().eq("client_id", clientId).eq("key", key).eq("updated_at", basedOn).select("key");
      if (error) throw new Error("memory write failed");
      return (data ?? []).length > 0;
    },
    // ⚠️ SERVICE ROLE, AND ONE BOOLEAN. Whether Structure Studio issues this builder's estimates
    // (sends.ts, the estimate resend card). A rep with designs access can't read it through any route
    // (status shows invoiceInGhl to CRM-settings readers only), and resend_quote_email refuses CRM mode
    // itself at the press, so this only stops a card that could never be sent. The same reading the route
    // makes: no row, or anything but false, is CRM mode.
    async paperworkInSS(clientId) {
      const { data, error } = await admin.from("client_settings").select("invoice_in_ghl").eq("client_id", clientId).maybeSingle();
      if (error) return null;
      return !!data && data.invoice_in_ghl === false;
    },
    // ⚠️ SERVICE ROLE, AND ONE BOOLEAN. Whether this estimate was accepted, for the estimate resend card
    // (sends.ts): the caller's crm_record feed turns a failed acceptance read into no events, so an
    // accepted estimate could look open. The design's accepted_at and any design_acceptances row (124),
    // this builder's only. Null when either read fails, which refuses.
    async estimateTaken(clientId, shortCode) {
      const [d, a] = await Promise.all([
        admin.from("designs").select("accepted_at").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
        admin.from("design_acceptances").select("id").eq("client_id", clientId).eq("short_code", shortCode).limit(1),
      ]);
      if (d.error || a.error) return null;
      return !!d.data?.accepted_at || (a.data ?? []).length > 0;
    },
  };
}

/** As much of resolveTenant's answer (../_shared/resolveTenant.ts TenantCtx) as this file reads. Written
 *  out here rather than imported, so a test of this file loads no jsr: module (test_assert.ts says why);
 *  index.ts hands in the real resolveTenant, and its type check proves the two still fit. */
export interface CallerCtx {
  clientId: string;
  userId: string;
  selfUserId: string;
  operator: { email: string; asUserId: string | null } | null;
  // deno-lint-ignore no-explicit-any
  payload: any;
  action: string;
  canRead(area: string): boolean;
  canEdit(area: string): boolean;
  audit(action: string, rowCount?: number | null, note?: string | null): Promise<void>;
}
export type Resolve = (
  req: Request,
  // deno-lint-ignore no-explicit-any
  admin: any,
  opts: { gates: GateTable; readActions: Set<string>; defaultAction: string },
) => Promise<{ ok: true; ctx: CallerCtx } | { ok: false; status: number; body: Record<string, unknown> }>;
/** What this file passes logEdgeError (../_shared/logError.ts EdgeErrorInput), the same way. */
export interface EdgeLog { fn: string; req: Request; code: string; message: string; severity?: "error" | "warn" | "info"; clientId?: string | null; context?: Record<string, unknown> | null }

/** What the handler reaches outside itself. index.ts hands in the real ones; handler_test.ts fakes. */
export interface HandlerIO {
  env(name: string): string | undefined;
  /** A service-role client (createClient in index.ts). */
  // deno-lint-ignore no-explicit-any
  admin(url: string, serviceKey: string): any;
  resolveTenant: Resolve;
  /** Jack's money for this builder (index.ts makeWallet: the only money writes, billing_test.ts). */
  // deno-lint-ignore no-explicit-any
  wallet(admin: any, clientId: string): Wallet;
  logEdgeError(input: EdgeLog): Promise<void>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** The request handler index.ts serves, wrapped in withErrorLog there. */
export function makeHandler(io: HandlerIO): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

    const url = io.env("SUPABASE_URL") ?? "";
    const admin = io.admin(url, io.env("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const r = await io.resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "status" });
    if (!r.ok) return json(r.body, r.status);
    const { clientId, userId, selfUserId, operator, payload, action, canRead, canEdit, audit } = r.ctx;
    // deno-lint-ignore no-explicit-any
    const p: any = payload || {};
    const who: Who = { clientId, userId, operatorEmail: operator ? operator.email : null };

    // The same route a person's screen uses, as this person. A view-as call says whose account, the same
    // way the portal's own calls do.
    const asTenant = operator ? { targetClientId: clientId, ...(p.targetUserId ? { targetUserId: p.targetUserId } : {}) } : {};
    const call: FnCall = async (fn, a, body) => {
      try {
        // No call waits as long as the gateway would, so one stall can't use up a worker. A read gives up at
        // 20 s, so a chat turn stays inside the gateway's limit. A write gets 60 s: a timed-out save that
        // landed answers `duplicate` on its retry, and that counts as saved (apply.ts).
        const res = await io.fetch(`${url}/functions/v1/${fn}`, {
          method: "POST",
          headers: {
            authorization: req.headers.get("authorization") ?? "",
            apikey: req.headers.get("apikey") ?? io.env("SUPABASE_ANON_KEY") ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: a, ...body, ...asTenant }),
          // A dry run prices a change and writes nothing: a read, so a chat turn stays inside its limit.
          signal: AbortSignal.timeout(WRITE_ACTION.test(a) && body.dryRun !== true ? 60_000 : 20_000),
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
      } catch {
        return { status: 0, data: null };
      }
    };
    const portal: PortalCall = (a, body) => call("portal-settings", a, body);

    const deps: Deps = {
      env: (k) => io.env(k),
      store: makeStore(admin),
      portal,
      call,
      wallet: io.wallet(admin, clientId),
      fetch: (input, init) => io.fetch(input, init),
      canRead,
      canEdit,
      // deno-lint-ignore no-explicit-any
      background: (work) => { try { (globalThis as any).EdgeRuntime?.waitUntil?.(work); } catch { /* it still runs */ } },
      budgetMs: () => WORKER_BORN_MS + 400_000 - Date.now(),
      makeId: () => crypto.randomUUID(),
      hash: async (text) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      },
      log: (e) => io.logEdgeError({ fn: FN, req, code: e.code, message: e.message, severity: e.severity, clientId: e.clientId ?? null, context: e.context ?? null }),
      audit: (a, rows, note) => audit(a, rows, note),
      now: () => Date.now(),
      // ⚠️ SERVICE ROLE, by the row id the send route answered with, on this builder only (sends.ts).
      markSentWithJack: makeSentWithJack(admin, clientId, (e) => io.logEdgeError({ fn: FN, req, code: e.code, message: e.message, severity: e.severity, clientId, context: e.context })),
    };

    const role = await roleFor(action, operator, () => deps.store.accountLine({ ...who, userId: selfUserId }));

    const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : null;
    if (!route) return json({ error: "Unknown action." }, 400);
    const shown = forViewer(who, await route(deps, who, role, p));
    return json(shown.body, shown.status);
  };
}
